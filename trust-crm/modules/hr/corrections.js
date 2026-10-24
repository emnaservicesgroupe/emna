// Attendance corrections (hr_attendance_corrections): the only way to change what the clock recorded.
//  - Request: the employee gives the day, the real in (and out) as ISO timestamps WITH an offset, and a reason (1..500).
//    work_date must be today or up to 60 days back (company/schedule timezone, computed in SQL); at most 3 pending per user;
//    requested_in must fall on work_date, nothing may lie in the future, the span is at most 24 h, and the out may be left
//    open only for today (a past day needs both ends).
//  - Decide: one transaction locks the correction FOR UPDATE, then (a) refuses the requester deciding their own request,
//    (b) answers 404 when the correction is outside the approver's scope (a Manager sees direct reports only; HR/Admin/SuperAdmin
//    everyone), (c) requires it to still be pending, and on approval (d) inserts ONE hr_attendance row (source 'correction',
//    correction_id) under the same per-user lock as clock-in/out. If that row overlaps existing attendance (or collides with an
//    open session) the whole decision fails with 409 and nothing is written: HR resolves it manually. The overlap trigger is the guard.
const { logAudit } = require("../../utils/audit");
const c = require("./common");
const { nowParam, requireStaffUser, userTz, clockLock, ISO_WITH_OFFSET } = require("./attendance");

const { HttpError } = c;
const db = () => require("../../db");

const STATUSES = ["pending", "approved", "rejected", "cancelled"];
const MAX_PENDING = 3;
const MAX_BACK_DAYS = 60;
const REASON_MAX = 500;
const COR = `k.id, k.user_id, k.work_date::text AS work_date, k.requested_in, k.requested_out, k.reason, k.status, k.decided_by, k.decided_at, k.decision_note, k.created_at`;
const OVERLAP_MSG = "overlaps existing attendance; ask HR to resolve";

function parseInstant(v, label, { optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return null;
    throw new HttpError(400, `${label} is required`);
  }
  if (typeof v !== "string" || !ISO_WITH_OFFSET.test(v) || !Number.isFinite(Date.parse(v))) {
    throw new HttpError(400, `${label} must be an ISO timestamp with an offset, e.g. 2026-03-10T09:00:00+01:00`);
  }
  const year = Number(v.slice(0, 4));
  if (year < 2000 || year > 2200) throw new HttpError(400, `${label} is outside the allowed range`);
  return v;
}

function parseStatusFilter(query, { def, allowAll = false }) {
  const raw = c.oneValue(query.status, "status");
  if (raw === undefined || raw === "") return def;
  if (allowAll && raw === "all") return null;
  if (!STATUSES.includes(raw)) throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}${allowAll ? ", all" : ""}`);
  return raw;
}

async function loadCorrection(runner, id) {
  return (await runner.query(`SELECT ${COR} FROM hr_attendance_corrections k WHERE k.id = $1`, [id])).rows[0];
}

async function requestCorrection(user, input, opts = {}) {
  requireStaffUser(user);
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  c.onlyKeys(input, ["work_date", "requested_in", "requested_out", "reason"]);
  const workDate = c.parseHrDate(input.work_date, "work_date");
  const reqIn = parseInstant(input.requested_in, "requested_in");
  const reqOut = parseInstant(input.requested_out, "requested_out", { optional: true });
  const reason = c.requiredText(input.reason, "reason", REASON_MAX);
  const now = nowParam(opts);
  return c.inTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('hr_correction'), $1)", [user.id]);
    const tz = await userTz(client, user.id);
    const f = (
      await client.query(
        `SELECT ($1::date <= t.today) AS not_future, ($1::date >= t.today - ${MAX_BACK_DAYS}) AS recent, ($1::date = t.today) AS is_today,
                (($2::timestamptz AT TIME ZONE $5)::date = $1::date) AS in_on_day,
                ($2::timestamptz <= t.ts) AS in_past,
                ($3::timestamptz IS NULL OR $3::timestamptz <= t.ts) AS out_past,
                ($3::timestamptz IS NULL OR $3::timestamptz > $2::timestamptz) AS ordered,
                ($3::timestamptz IS NULL OR $3::timestamptz - $2::timestamptz <= interval '24 hours') AS span_ok
           FROM (SELECT COALESCE($4::timestamptz, clock_timestamp()) AS ts, (COALESCE($4::timestamptz, clock_timestamp()) AT TIME ZONE $5)::date AS today) t`,
        [workDate, reqIn, reqOut, now, tz]
      )
    ).rows[0];
    if (!f.not_future) throw new HttpError(400, "work_date must not be in the future");
    if (!f.recent) throw new HttpError(400, `work_date must be within the last ${MAX_BACK_DAYS} days`);
    if (!f.in_on_day) throw new HttpError(400, "requested_in must fall on work_date");
    if (!f.in_past || !f.out_past) throw new HttpError(400, "requested times must not be in the future");
    if (!f.ordered) throw new HttpError(400, "requested_in must be before requested_out");
    if (!f.span_ok) throw new HttpError(400, "The corrected session must not exceed 24 hours");
    if (reqOut === null && !f.is_today) throw new HttpError(400, "requested_out is required unless work_date is today");
    const pending = (await client.query("SELECT count(*)::int AS n FROM hr_attendance_corrections WHERE user_id = $1 AND status = 'pending'", [user.id])).rows[0].n;
    if (pending >= MAX_PENDING) throw new HttpError(409, `You already have ${MAX_PENDING} pending corrections; wait for a decision or cancel one`);
    const ins = await client.query(
      `INSERT INTO hr_attendance_corrections (user_id, work_date, requested_in, requested_out, reason) VALUES ($1,$2::date,$3::timestamptz,$4::timestamptz,$5) RETURNING id`,
      [user.id, workDate, reqIn, reqOut, reason]
    );
    const row = await loadCorrection(client, ins.rows[0].id);
    await logAudit({ client, userId: user.id, action: "CREATE", tableName: "hr_attendance_corrections", recordId: row.id, newData: row });
    return row;
  });
}

/** Own pending correction only; anyone else's (or an unknown id) is a 404. */
async function cancelCorrection(user, rawId) {
  requireStaffUser(user);
  const id = c.parseId(rawId, { notFound: "Correction not found" });
  return c.inTransaction(async (client) => {
    const cur = (await client.query(`SELECT ${COR} FROM hr_attendance_corrections k WHERE k.id = $1 AND k.user_id = $2 FOR UPDATE`, [id, user.id])).rows[0];
    if (!cur) throw new HttpError(404, "Correction not found");
    if (cur.status !== "pending") throw new HttpError(409, `Only a pending correction can be cancelled (it is ${cur.status})`);
    await client.query("UPDATE hr_attendance_corrections SET status = 'cancelled' WHERE id = $1", [id]);
    const row = await loadCorrection(client, id);
    await logAudit({ client, userId: user.id, action: "UPDATE", tableName: "hr_attendance_corrections", recordId: id, oldData: cur, newData: row });
    return row;
  });
}

async function myCorrections(user, query = {}) {
  requireStaffUser(user);
  const status = parseStatusFilter(query, { def: null, allowAll: true });
  const { limit, offset } = c.pageParams(query);
  const params = [user.id];
  let where = "k.user_id = $1";
  if (status) {
    params.push(status);
    where += ` AND k.status = $${params.length}`;
  }
  const total = (await db().query(`SELECT count(*)::int AS n FROM hr_attendance_corrections k WHERE ${where}`, params)).rows[0].n;
  const rows = (
    await db().query(`SELECT ${COR} FROM hr_attendance_corrections k WHERE ${where} ORDER BY k.created_at DESC, k.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset])
  ).rows;
  return { rows, total };
}

/** hr:read holders (HR, Admin, SuperAdmin) see everyone; a hr:approve-only Manager sees direct reports (hr_employees.manager_user_id). */
const seesAll = (user) => c.hasPerm(user, "hr:read");

async function teamCorrections(user, query = {}) {
  c.requirePerm(user, "hr:approve");
  const status = parseStatusFilter(query, { def: "pending", allowAll: true });
  const { limit, offset } = c.pageParams(query);
  const params = [];
  const where = [];
  if (status) {
    params.push(status);
    where.push(`k.status = $${params.length}`);
  }
  if (!seesAll(user)) {
    params.push(user.id);
    where.push(`k.user_id IN (SELECT r.user_id FROM hr_employees r WHERE r.manager_user_id = $${params.length})`);
  }
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const base = `FROM hr_attendance_corrections k JOIN users u ON u.id = k.user_id LEFT JOIN hr_employees e ON e.user_id = k.user_id ${filter}`;
  const total = (await db().query(`SELECT count(*)::int AS n ${base}`, params)).rows[0].n;
  const rows = (
    await db().query(
      `SELECT ${COR}, u.full_name, u.role, e.employee_no, e.department ${base} ORDER BY k.work_date DESC, k.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )
  ).rows;
  return { rows, total };
}

async function decide(user, rawId, input) {
  c.requirePerm(user, "hr:approve");
  const id = c.parseId(rawId, { notFound: "Correction not found" });
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  c.onlyKeys(input, ["decision", "note"]);
  if (input.decision !== "approved" && input.decision !== "rejected") throw new HttpError(400, "decision must be approved or rejected");
  const note = c.cleanText(input.note, "note", REASON_MAX);
  const approve = input.decision === "approved";
  return c.inTransaction(async (client) => {
    const cur = (await client.query(`SELECT ${COR} FROM hr_attendance_corrections k WHERE k.id = $1 FOR UPDATE`, [id])).rows[0];
    if (!cur) throw new HttpError(404, "Correction not found");
    if (cur.user_id === user.id) throw new HttpError(403, "You cannot decide your own correction; another approver must");
    if (!seesAll(user)) {
      const inScope = await client.query("SELECT 1 FROM hr_employees WHERE user_id = $1 AND manager_user_id = $2", [cur.user_id, user.id]);
      if (!inScope.rowCount) throw new HttpError(404, "Correction not found");
    }
    if (cur.status !== "pending") throw new HttpError(409, `This correction is already ${cur.status}`);
    let attendance;
    if (approve) {
      await clockLock(client, cur.user_id);
      try {
        const ins = await client.query(
          `INSERT INTO hr_attendance (user_id, work_date, clock_in, clock_out, source, correction_id, note)
           VALUES ($1, $2::date, $3, $4, 'correction', $5, $6)
           RETURNING id, user_id, work_date::text AS work_date, clock_in, clock_out, source, correction_id, note, created_at`,
          [cur.user_id, cur.work_date, cur.requested_in, cur.requested_out, cur.id, `Correction #${cur.id}`]
        );
        attendance = ins.rows[0];
      } catch (err) {
        if (err && err.code === "23P01") throw new HttpError(409, OVERLAP_MSG);
        if (err && err.code === "23505" && err.constraint === "hr_attendance_one_open_uq") throw new HttpError(409, OVERLAP_MSG);
        throw err;
      }
    }
    await client.query("UPDATE hr_attendance_corrections SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1", [id, input.decision, user.id, note]);
    const row = await loadCorrection(client, id);
    await logAudit({ client, userId: user.id, action: "UPDATE", tableName: "hr_attendance_corrections", recordId: id, oldData: cur, newData: row });
    if (attendance) await logAudit({ client, userId: user.id, action: "CREATE", tableName: "hr_attendance", recordId: attendance.id, newData: attendance });
    return attendance ? { correction: row, attendance } : { correction: row };
  });
}

module.exports = { requestCorrection, cancelCorrection, myCorrections, teamCorrections, decide, MAX_PENDING };
