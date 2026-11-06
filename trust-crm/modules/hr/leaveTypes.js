// Leave types (hr_leave_types): data entered by the owner / HR. Deactivated, never deleted (requests keep their type).
const { logAudit } = require("../../utils/audit");
const c = require("./common");

const { HttpError } = c;
const db = () => require("../../db");
const CODE_RE = /^[A-Z0-9_-]{2,30}$/;
const NAME_MAX = 120; // the table's CHECK limit
const COLS = "id, code, name_ar, name_en, name_fr, paid, counts_against_balance, requires_approval, active, created_at";
const NAME_FIELDS = ["name_ar", "name_en", "name_fr"];
const FLAGS = ["paid", "counts_against_balance", "requires_approval", "active"];

function validate(input, { creating }) {
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  for (const k of Object.keys(input)) {
    if (k === "code" && !creating) throw new HttpError(400, "code cannot be changed");
  }
  c.onlyKeys(input, creating ? ["code", ...NAME_FIELDS, ...FLAGS] : [...NAME_FIELDS, ...FLAGS]);
  const out = {};
  if (creating) {
    if (typeof input.code !== "string" || !CODE_RE.test(input.code)) throw new HttpError(400, "code must be 2-30 characters of A-Z, 0-9, _ or - (upper-case)");
    out.code = input.code;
  }
  for (const f of NAME_FIELDS) {
    if (input[f] !== undefined || creating) out[f] = c.requiredText(input[f], f, NAME_MAX);
  }
  for (const f of FLAGS) if (input[f] !== undefined) out[f] = c.parseBool(input[f], f);
  return out;
}

async function listLeaveTypes(user, query = {}) {
  c.requirePerm(user, "hr:read");
  const where = [];
  const params = [];
  const active = c.oneValue(query.active, "active");
  if (active !== undefined && active !== "") {
    if (active !== "true" && active !== "false") throw new HttpError(400, "active must be true or false");
    params.push(active === "true");
    where.push(`active = $${params.length}`);
  }
  const q = c.oneValue(query.q, "q");
  if (q) {
    params.push(`%${c.likeEscape(q.slice(0, 100))}%`);
    where.push(`(code ILIKE $${params.length} OR name_ar ILIKE $${params.length} OR name_en ILIKE $${params.length} OR name_fr ILIKE $${params.length})`);
  }
  const rows = (await db().query(`SELECT ${COLS} FROM hr_leave_types ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY active DESC, code ASC`, params)).rows;
  return { rows, total: rows.length };
}

/** GET /hr/me/leave-types: the ACTIVE types any staff member may request (the leave-request dialog needs them without hr:read). */
async function listActiveForStaff(user) {
  const { requireStaffUser } = require("./attendance");
  requireStaffUser(user);
  const rows = (await db().query(`SELECT ${COLS} FROM hr_leave_types WHERE active ORDER BY code ASC`)).rows;
  return { rows, total: rows.length };
}

async function createLeaveType(user, input) {
  c.requirePerm(user, "hr:write");
  const v = validate(input, { creating: true });
  return c.inTransaction(
    async (client) => {
      const r = await client.query(
        `INSERT INTO hr_leave_types (code, name_ar, name_en, name_fr, paid, counts_against_balance, requires_approval, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
        [v.code, v.name_ar, v.name_en, v.name_fr, v.paid ?? true, v.counts_against_balance ?? true, v.requires_approval ?? true, v.active ?? true]
      );
      await logAudit({ client, userId: user.id, action: "CREATE", tableName: "hr_leave_types", recordId: r.rows[0].id, newData: r.rows[0] });
      return r.rows[0];
    },
    { unique: "A leave type with this code already exists" }
  );
}

async function updateLeaveType(user, rawId, input) {
  c.requirePerm(user, "hr:write");
  const id = c.parseId(rawId, { notFound: "Leave type not found" });
  const v = validate(input, { creating: false });
  if (!Object.keys(v).length) throw new HttpError(400, "No fields to update");
  return c.inTransaction(async (client) => {
    const cur = (await client.query(`SELECT ${COLS} FROM hr_leave_types WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!cur) throw new HttpError(404, "Leave type not found");
    const sets = [];
    const params = [id];
    for (const [k, val] of Object.entries(v)) {
      params.push(val);
      sets.push(`${k} = $${params.length}`);
    }
    const r = await client.query(`UPDATE hr_leave_types SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLS}`, params);
    await logAudit({ client, userId: user.id, action: "UPDATE", tableName: "hr_leave_types", recordId: id, oldData: cur, newData: r.rows[0] });
    return r.rows[0];
  });
}

module.exports = { listLeaveTypes, listActiveForStaff, createLeaveType, updateLeaveType };
