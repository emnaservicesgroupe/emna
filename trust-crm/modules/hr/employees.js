// HR employee profiles (hr_employees) and the self-service profile (GET /hr/me).
// A staff user without a row has "no profile yet": self-service keeps working with defaults and HR sees has_profile:false.
// The HR-only `notes` are returned only to callers holding hr:read and NEVER by /hr/me.
const { logAudit } = require("../../utils/audit");
const { STAFF_ROLES } = require("../../middleware/staff");
const c = require("./common");
const { balancesFor } = require("./balances");

const { HttpError } = c;
const db = () => require("../../db");
const STAFF_LIST = [...STAFF_ROLES];
const FIELDS = ["employee_no", "position", "department", "hire_date", "end_date", "employment_type", "phone", "emergency_contact_name", "emergency_contact_phone", "manager_user_id", "schedule_id", "status", "notes"];
const TEXT_MAX = { employee_no: 40, position: 120, department: 120, employment_type: 40, phone: 40, emergency_contact_name: 120, emergency_contact_phone: 40, notes: 4000 };

const PROFILE = `e.employee_no, e.position, e.department, e.hire_date::text AS hire_date, e.end_date::text AS end_date, e.employment_type, e.phone,
  e.emergency_contact_name, e.emergency_contact_phone, e.manager_user_id, mu.full_name AS manager_name, e.schedule_id, s.name AS schedule_name,
  e.status, e.notes, e.created_at, e.updated_at`;
const JOINS = `LEFT JOIN users mu ON mu.id = e.manager_user_id LEFT JOIN hr_schedules s ON s.id = e.schedule_id`;

function present(row, user, { withNotes = true } = {}) {
  if (!row) return row;
  const out = { ...row };
  if (!withNotes || !c.hasPerm(user, "hr:read")) delete out.notes;
  return out;
}

// Notes are HR-only: the audit trail (readable by audit:read holders) records only whether they are set.
const auditView = (row) => {
  if (!row) return null;
  const { notes, ...rest } = row;
  return { ...rest, notes: notes ? "[hr-only]" : null };
};

async function validate(client, input, { creating, userId }) {
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  c.onlyKeys(input, creating ? ["user_id", ...FIELDS] : FIELDS);
  const out = {};
  for (const f of Object.keys(TEXT_MAX)) {
    if (input[f] === undefined) continue;
    out[f] = c.cleanText(input[f], f, TEXT_MAX[f]);
  }
  for (const f of ["hire_date", "end_date"]) {
    if (input[f] === undefined) continue;
    out[f] = input[f] === null ? null : c.parseHrDate(input[f], f);
  }
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "inactive") throw new HttpError(400, "status must be active or inactive");
    out.status = input.status;
  }
  if (input.manager_user_id !== undefined) {
    if (input.manager_user_id === null) out.manager_user_id = null;
    else {
      const mid = c.parseId(input.manager_user_id, { label: "manager_user_id" });
      if (mid === userId) throw new HttpError(400, "An employee cannot be their own manager");
      if (!(await c.activeStaffUser(client, mid))) throw new HttpError(400, "manager_user_id must be an active staff user");
      out.manager_user_id = mid;
    }
  }
  if (input.schedule_id !== undefined) {
    if (input.schedule_id === null) out.schedule_id = null;
    else {
      const sid = c.parseId(input.schedule_id, { label: "schedule_id" });
      if (!(await client.query("SELECT 1 FROM hr_schedules WHERE id = $1", [sid])).rowCount) throw new HttpError(400, "schedule_id does not exist");
      out.schedule_id = sid;
    }
  }
  return out;
}

/** Refuses a manager chain that leads back to the employee (A manages B manages A). Callers hold the chain advisory lock. */
async function assertNoCycle(client, userId, managerId) {
  const r = await client.query(
    `WITH RECURSIVE chain(uid, depth) AS (
       SELECT $1::int, 0
       UNION ALL
       SELECT e.manager_user_id, ch.depth + 1 FROM chain ch JOIN hr_employees e ON e.user_id = ch.uid
        WHERE e.manager_user_id IS NOT NULL AND ch.depth < 100
     ) SELECT 1 FROM chain WHERE uid = $2 LIMIT 1`,
    [managerId, userId]
  );
  if (r.rowCount) throw new HttpError(400, "This manager assignment would create a reporting cycle");
}

const lockChain = (client) => client.query("SELECT pg_advisory_xact_lock(hashtext('hr_manager_chain'))");

async function loadOne(runner, userId) {
  const r = await runner.query(
    `SELECT u.id AS user_id, u.full_name, u.email, u.role, u.is_active, (e.user_id IS NOT NULL) AS has_profile, ${PROFILE}
       FROM users u LEFT JOIN hr_employees e ON e.user_id = u.id ${JOINS}
      WHERE u.id = $1 AND u.role = ANY($2::text[])`,
    [userId, STAFF_LIST]
  );
  return r.rows[0] || null;
}

async function listEmployees(user, query = {}) {
  c.requirePerm(user, "hr:read");
  const where = [];
  const params = [];
  const add = (v) => (params.push(v), `$${params.length}`);
  const status = c.oneValue(query.status, "status");
  if (status !== undefined && status !== "") {
    if (status !== "active" && status !== "inactive") throw new HttpError(400, "status must be active or inactive");
    where.push(`e.status = ${add(status)}`);
  }
  const dept = c.oneValue(query.department, "department");
  if (dept) where.push(`e.department ILIKE ${add(`%${c.likeEscape(dept.slice(0, 100))}%`)}`);
  const q = c.oneValue(query.q, "q");
  if (q) {
    const p = add(`%${c.likeEscape(q.slice(0, 100))}%`);
    where.push(`(u.full_name ILIKE ${p} OR u.email ILIKE ${p} OR e.employee_no ILIKE ${p} OR e.position ILIKE ${p} OR e.department ILIKE ${p})`);
  }
  const { limit, offset } = c.pageParams(query);
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const base = `FROM hr_employees e JOIN users u ON u.id = e.user_id ${JOINS} ${filter}`;
  const total = (await db().query(`SELECT count(*)::int AS n ${base}`, params)).rows[0].n;
  const rows = (
    await db().query(
      `SELECT u.id AS user_id, u.full_name, u.email, u.role, u.is_active, true AS has_profile, ${PROFILE} ${base}
        ORDER BY u.full_name ASC, u.id ASC LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params
    )
  ).rows;
  return { rows: rows.map((r) => present(r, user, { withNotes: false })), total };
}

async function getEmployee(user, rawId) {
  c.requirePerm(user, "hr:read");
  const id = c.parseId(rawId, { notFound: "Employee not found" });
  const row = await loadOne(db(), id);
  if (!row) throw new HttpError(404, "Employee not found");
  return present(row, user);
}

async function createEmployee(user, input) {
  c.requirePerm(user, "hr:write");
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  const userId = c.parseId(input.user_id, { label: "user_id" });
  return c.inTransaction(
    async (client) => {
      const target = (await client.query("SELECT id, role, is_active FROM users WHERE id = $1 FOR SHARE", [userId])).rows[0];
      if (!target) throw new HttpError(404, "User not found");
      if (!target.is_active || !STAFF_ROLES.has(target.role)) throw new HttpError(400, "user_id must be an active staff user");
      await lockChain(client);
      const v = await validate(client, input, { creating: true, userId });
      if (v.manager_user_id) await assertNoCycle(client, userId, v.manager_user_id);
      const cols = ["user_id", ...Object.keys(v)];
      const vals = [userId, ...Object.values(v)];
      await client.query(`INSERT INTO hr_employees (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
      const row = await loadOne(client, userId);
      await logAudit({ client, userId: user.id, action: "CREATE", tableName: "hr_employees", recordId: userId, newData: auditView(row) });
      return present(row, user);
    },
    { unique: { hr_employees_pkey: "This user already has an HR profile", hr_employees_no_uq: "This employee_no is already in use" } }
  );
}

async function updateEmployee(user, rawId, input) {
  c.requirePerm(user, "hr:write");
  const userId = c.parseId(rawId, { notFound: "Employee not found" });
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  return c.inTransaction(
    async (client) => {
      await lockChain(client);
      const cur = (await client.query("SELECT 1 FROM hr_employees WHERE user_id = $1 FOR UPDATE", [userId])).rowCount;
      if (!cur) throw new HttpError(404, "Employee not found");
      const before = await loadOne(client, userId);
      const v = await validate(client, input, { creating: false, userId });
      if (!Object.keys(v).length) throw new HttpError(400, "No fields to update");
      const hire = v.hire_date !== undefined ? v.hire_date : before.hire_date;
      const end = v.end_date !== undefined ? v.end_date : before.end_date;
      if (hire && end && end < hire) throw new HttpError(400, "end_date must not be before hire_date");
      if (v.manager_user_id) await assertNoCycle(client, userId, v.manager_user_id);
      const sets = [];
      const params = [userId];
      for (const [k, val] of Object.entries(v)) {
        params.push(val);
        sets.push(`${k} = $${params.length}`);
      }
      await client.query(`UPDATE hr_employees SET ${sets.join(", ")}, updated_at = now() WHERE user_id = $1`, params);
      const row = await loadOne(client, userId);
      await logAudit({ client, userId: user.id, action: "UPDATE", tableName: "hr_employees", recordId: userId, oldData: auditView(before), newData: auditView(row) });
      return present(row, user);
    },
    { unique: { hr_employees_no_uq: "This employee_no is already in use" } }
  );
}

/**
 * GET /hr/staff (hr:read): every ACTIVE staff account with a has_profile flag, for the console's employee / manager / balance
 * pickers (name and role only, no e-mail). Optional ?without_profile=true narrows it to staff HR has not set up yet.
 */
async function listStaff(user, query = {}) {
  c.requirePerm(user, "hr:read");
  const w = c.oneValue(query.without_profile, "without_profile");
  if (w !== undefined && w !== "" && w !== "true" && w !== "false") throw new HttpError(400, "without_profile must be true or false");
  const r = await db().query(
    `SELECT u.id AS user_id, u.full_name, u.role, (e.user_id IS NOT NULL) AS has_profile
       FROM users u LEFT JOIN hr_employees e ON e.user_id = u.id
      WHERE u.is_active AND u.role = ANY($1::text[]) AND ($2::boolean IS NOT TRUE OR e.user_id IS NULL)
      ORDER BY u.full_name ASC, u.id ASC LIMIT 500`,
    [STAFF_LIST, w === "true"]
  );
  return { rows: r.rows, total: r.rows.length };
}

/**
 * GET /hr/me: the caller's own HR view. `profile` is null when HR has not created a row (self-service still works); the
 * balances are those of the current YEAR IN THE COMPANY TIMEZONE with used days derived from approved leave. No notes,
 * no phone / emergency contact: only position, department, hire date, employment type, manager name and the schedule.
 */
async function me(user) {
  const tz = c.companyTimezone();
  const who = (await db().query("SELECT id, full_name, email, role FROM users WHERE id = $1", [user.id])).rows[0];
  if (!who) throw new HttpError(401, "Session expired");
  const year = (await db().query("SELECT extract(year FROM now() AT TIME ZONE $1)::int AS y", [tz])).rows[0].y;
  const p = (
    await db().query(
      `SELECT e.employee_no, e.position, e.department, e.hire_date::text AS hire_date, e.employment_type, e.status, e.manager_user_id,
              mu.full_name AS manager_name, e.schedule_id
         FROM hr_employees e LEFT JOIN users mu ON mu.id = e.manager_user_id WHERE e.user_id = $1`,
      [user.id]
    )
  ).rows[0];
  let profile = null;
  let schedule = null;
  if (p) {
    const { schedule_id, manager_user_id, manager_name, ...rest } = p;
    profile = { ...rest, manager: manager_user_id ? { id: manager_user_id, full_name: manager_name } : null };
    if (schedule_id) {
      schedule = (await db().query("SELECT id, name, weekly, grace_minutes, timezone FROM hr_schedules WHERE id = $1", [schedule_id])).rows[0] || null;
    }
  }
  const balances = await balancesFor(db(), user.id, year);
  return { user: who, profile, schedule, timezone: tz, year, balances };
}

module.exports = { listEmployees, getEmployee, createEmployee, updateEmployee, listStaff, me };
