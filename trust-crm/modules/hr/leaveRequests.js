// Leave requests (hr_leave_requests): request, list, cancel, team list and decision.
//
// Request (POST /hr/me/leave-requests)
//  - active leave type; dates end >= start, start at most 366 days in the past (company timezone), span at most 366 days.
//  - days = working days per the employee's schedule (default Mon-Fri when none is configured) minus public holidays, minus 0.5 for
//    each half-day flag; the per-year split of a range crossing New Year is stored on the request (days_year_start / days_year_end); a flag on a day that is not a working day is a 400; no working day at all is a 400. Computed in SQL.
//  - counts_against_balance types need available days (entitled + adjusted - approved - pending) >= the request, checked per
//    calendar year when the range crosses New Year. The check and the insert run under one advisory lock per (user, leave type).
//  - status pending, or approved straight away (decided_by NULL) when the type does not require approval.
//  - an overlap with another pending/approved request of the same user is a 409 (the database trigger is the guard).
// Cancel: own pending -> cancelled; own approved -> cancelled only while start_date is still in the future (company timezone).
// Decide: one transaction locks the request FOR UPDATE, refuses the owner (403), answers 404 outside the approver's scope, needs it
//  still pending (409 otherwise) and, when approving a balance-counted type, re-checks the balance under the same advisory lock as
//  creation so two approvals can never overdraw it.
// Privacy: `reason` and `decision_note` are returned only to the owner, to approvers inside their scope and to hr:read callers.
const { logAudit } = require("../../utils/audit");
const c = require("./common");
const approvals = require("./approvals");
const { yearShare, computeRange, hasConfiguredSchedule } = require("./leaveDays");
const { nowParam, requireStaffUser } = require("./attendance");

const { HttpError } = c;
const db = () => require("../../db");

const STATUSES = ["pending", "approved", "rejected", "cancelled"];
const REASON_MAX = 500;
const MAX_PAST_DAYS = 366;
const MAX_SPAN_DAYS = 366;
const OVERLAP_MSG = "These dates overlap another pending or approved leave request";

const REQ = `r.id, r.user_id, r.leave_type_id, t.code AS leave_type_code, t.name_ar, t.name_en, t.name_fr, r.start_date::text AS start_date, r.end_date::text AS end_date,
  r.half_day_start, r.half_day_end, r.days::text AS days, r.reason, r.status, r.decided_by, r.decided_at, r.decision_note, r.created_at`;
const FROM = "FROM hr_leave_requests r JOIN hr_leave_types t ON t.id = r.leave_type_id";

async function loadRequest(runner, id, { lock = false } = {}) {
  return (await runner.query(`SELECT ${REQ} ${FROM} WHERE r.id = $1 ${lock ? "FOR UPDATE OF r" : ""}`, [id])).rows[0];
}

/** Serialises balance-affecting writes for one (user, leave type): creation, auto-approval and approval share it. */
const balanceLock = (client, userId, typeId) => client.query("SELECT pg_advisory_xact_lock(hashtext('hr_leave_balance'), hashtext($1::text))", [`${userId}:${typeId}`]);

const todayIn = async (client, now, tz) => (await client.query("SELECT (COALESCE($1::timestamptz, clock_timestamp()) AT TIME ZONE $2)::date::text AS d", [now, tz])).rows[0].d;

/** Entitled + adjusted for the year (0 without a balance row) and the days already approved / pending in that year. */
async function yearFigures(client, userId, typeId, year, excludeId = null) {
  const r = await client.query(
    `SELECT COALESCE((SELECT b.entitled_days + b.adjusted_days FROM hr_leave_balances b WHERE b.user_id = $1 AND b.leave_type_id = $2 AND b.year = $3), 0)::numeric AS granted,
            COALESCE(sum(${yearShare("r", "$3::int")}) FILTER (WHERE r.status = 'approved'), 0)::numeric AS approved,
            COALESCE(sum(${yearShare("r", "$3::int")}) FILTER (WHERE r.status = 'pending'), 0)::numeric AS pending
       FROM hr_leave_requests r
      WHERE r.user_id = $1 AND r.leave_type_id = $2 AND r.status IN ('approved', 'pending') AND ($4::bigint IS NULL OR r.id <> $4)
        AND r.start_date <= make_date($3::int, 12, 31) AND r.end_date >= make_date($3::int, 1, 1)`,
    [userId, typeId, year, excludeId]
  );
  return r.rows[0];
}

/** Year parts of a request: [{year, days}] for the (user, range) as stored (days_total) or freshly computed. */
async function requestParts(client, row) {
  const r = (
    await client.query(
      `SELECT DISTINCT y.year, ${yearShare("q", "y.year")} AS days
         FROM hr_leave_requests q
         CROSS JOIN LATERAL (VALUES (extract(year FROM q.start_date)::int), (extract(year FROM q.end_date)::int)) y(year)
        WHERE q.id = $1`,
      [row.id]
    )
  ).rows;
  return r.filter((p) => Number(p.days) > 0);
}

function parseFlags(input) {
  const flag = (k) => (input[k] === undefined || input[k] === null ? false : c.parseBool(input[k], k));
  return { hs: flag("half_day_start"), he: flag("half_day_end") };
}

async function createRequest(user, input, opts = {}) {
  requireStaffUser(user);
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  c.onlyKeys(input, ["leave_type_id", "start_date", "end_date", "half_day_start", "half_day_end", "reason"]);
  const typeId = c.parseId(input.leave_type_id, { label: "leave_type_id" });
  const start = c.parseHrDate(input.start_date, "start_date");
  const end = c.parseHrDate(input.end_date, "end_date");
  const { hs, he } = parseFlags(input);
  const reason = c.cleanText(input.reason, "reason", REASON_MAX);
  if (end < start) throw new HttpError(400, "end_date must not be before start_date");
  const now = nowParam(opts);
  const tz = c.companyTimezone();
  return c.inTransaction(async (client) => {
    await balanceLock(client, user.id, typeId);
    const type = (await client.query("SELECT id, active, counts_against_balance, requires_approval FROM hr_leave_types WHERE id = $1 FOR SHARE", [typeId])).rows[0];
    if (!type || !type.active) throw new HttpError(400, "leave_type_id must be an active leave type");
    const f = (
      await client.query(
        `SELECT ($1::date >= t.today - ${MAX_PAST_DAYS}) AS recent, ($2::date - $1::date + 1 <= ${MAX_SPAN_DAYS}) AS span_ok
           FROM (SELECT (COALESCE($3::timestamptz, clock_timestamp()) AT TIME ZONE $4)::date AS today) t`,
        [start, end, now, tz]
      )
    ).rows[0];
    if (!f.recent) throw new HttpError(400, `start_date must not be more than ${MAX_PAST_DAYS} days in the past`);
    if (!f.span_ok) throw new HttpError(400, `The range must not exceed ${MAX_SPAN_DAYS} days`);

    const cr = await computeRange(client, user.id, start, end);
    if (cr.wd_total === 0) throw new HttpError(400, "no working days in range");
    if (start === end && hs && he) throw new HttpError(400, "Use a single half-day flag for a one-day request");
    if (hs && cr.start_working === 0) throw new HttpError(400, "half_day_start is only allowed when start_date is a working day");
    if (he && cr.end_working === 0) throw new HttpError(400, "half_day_end is only allowed when end_date is a working day");
    // Per-year parts (a range inside one year has a single part); half-day flags sit on the first / last day.
    const parts = [];
    if (cr.y1 === cr.y2) parts.push({ year: cr.y1, days: cr.wd_total - (hs ? 0.5 : 0) - (he ? 0.5 : 0) });
    else {
      parts.push({ year: cr.y1, days: cr.wd1 - (hs ? 0.5 : 0) });
      parts.push({ year: cr.y2, days: cr.wd2 - (he ? 0.5 : 0) });
    }
    const days = parts.reduce((a, p) => a + p.days, 0);
    if (!(days > 0)) throw new HttpError(400, "no working days in range");

    if (type.counts_against_balance) {
      for (const p of parts) {
        if (!(p.days > 0)) continue;
        const fig = await yearFigures(client, user.id, typeId, p.year);
        if (Number(fig.granted) - Number(fig.approved) - Number(fig.pending) < p.days) {
          throw new HttpError(409, `Insufficient leave balance for ${p.year}`);
        }
      }
    }

    const auto = !type.requires_approval;
    let id;
    try {
      const ins = await client.query(
        `INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, half_day_start, half_day_end, days, days_year_start, days_year_end, reason, status, decided_at)
         VALUES ($1,$2,$3::date,$4::date,$5,$6,$7::numeric,$8::numeric,$9::numeric,$10,$11, CASE WHEN $11 = 'approved' THEN now() ELSE NULL END) RETURNING id`,
        [user.id, typeId, start, end, hs, he, days, parts[0].days, parts.length > 1 ? parts[1].days : 0, reason, auto ? "approved" : "pending"]
      );
      id = ins.rows[0].id;
    } catch (err) {
      if (err && err.code === "23P01") throw new HttpError(409, OVERLAP_MSG);
      throw err;
    }
    const row = await loadRequest(client, id);
    await logAudit({ client, userId: user.id, action: "CREATE", tableName: "hr_leave_requests", recordId: row.id, newData: { ...row, reason: row.reason ? "[private]" : null } });
    const usedDefault = !(await hasConfiguredSchedule(client, user.id));
    return usedDefault ? { ...row, days_note: "default schedule" } : row;
  });
}

function parseStatusFilter(query, def) {
  const raw = c.oneValue(query.status, "status");
  if (raw === undefined || raw === "") return def;
  if (raw === "all") return null;
  if (!STATUSES.includes(raw)) throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}, all`);
  return raw;
}

function yearFilter(query, params, where) {
  const yr = c.oneValue(query.year, "year");
  if (yr === undefined || yr === "") return;
  const y = c.parseYear(yr);
  params.push(y);
  where.push(`r.start_date <= make_date($${params.length}, 12, 31) AND r.end_date >= make_date($${params.length}, 1, 1)`);
}

async function myRequests(user, query = {}) {
  requireStaffUser(user);
  const status = parseStatusFilter(query, null);
  const { limit, offset } = c.pageParams(query);
  const params = [user.id];
  const where = ["r.user_id = $1"];
  if (status) {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  yearFilter(query, params, where);
  const filter = where.join(" AND ");
  const total = (await db().query(`SELECT count(*)::int AS n ${FROM} WHERE ${filter}`, params)).rows[0].n;
  const rows = (await db().query(`SELECT ${REQ} ${FROM} WHERE ${filter} ORDER BY r.start_date DESC, r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset])).rows;
  return { rows, total };
}

async function cancelRequest(user, rawId, opts = {}) {
  requireStaffUser(user);
  const id = c.parseId(rawId, { notFound: "Leave request not found" });
  const now = nowParam(opts);
  const tz = c.companyTimezone();
  return c.inTransaction(async (client) => {
    const cur = await loadRequest(client, id, { lock: true });
    if (!cur || cur.user_id !== user.id) throw new HttpError(404, "Leave request not found");
    if (cur.status === "approved") {
      const today = await todayIn(client, now, tz);
      if (!(cur.start_date > today)) throw new HttpError(409, "An approved leave that has already started cannot be cancelled; ask HR");
    } else if (cur.status !== "pending") {
      throw new HttpError(409, `Only a pending or future approved request can be cancelled (it is ${cur.status})`);
    }
    await client.query("UPDATE hr_leave_requests SET status = 'cancelled' WHERE id = $1", [id]);
    const row = await loadRequest(client, id);
    await logAudit({ client, userId: user.id, action: "UPDATE", tableName: "hr_leave_requests", recordId: id, oldData: { ...cur, reason: "[private]" }, newData: { ...row, reason: "[private]" } });
    return row;
  });
}

async function teamRequests(user, query = {}) {
  c.requirePerm(user, "hr:approve");
  const status = parseStatusFilter(query, "pending");
  const { limit, offset } = c.pageParams(query);
  const params = [];
  const where = [];
  if (status) {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  const scope = approvals.scopeSql(user, params, "r.user_id");
  if (scope) where.push(scope);
  yearFilter(query, params, where);
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const base = `${FROM} JOIN users u ON u.id = r.user_id LEFT JOIN hr_employees e ON e.user_id = r.user_id ${filter}`;
  const total = (await db().query(`SELECT count(*)::int AS n FROM hr_leave_requests r JOIN hr_leave_types t ON t.id = r.leave_type_id JOIN users u ON u.id = r.user_id LEFT JOIN hr_employees e ON e.user_id = r.user_id ${filter}`, params)).rows[0].n;
  const rows = (
    await db().query(`SELECT ${REQ}, u.full_name, u.role, e.employee_no, e.department ${base} ORDER BY r.start_date ASC, r.id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset])
  ).rows;
  return { rows, total };
}

async function decide(user, rawId, input) {
  c.requirePerm(user, "hr:approve");
  const id = c.parseId(rawId, { notFound: "Leave request not found" });
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  c.onlyKeys(input, ["decision", "note"]);
  if (input.decision !== "approved" && input.decision !== "rejected") throw new HttpError(400, "decision must be approved or rejected");
  const note = c.cleanText(input.note, "note", REASON_MAX);
  return c.inTransaction(async (client) => {
    // Lock order: request row, then the balance lock (creation takes only the balance lock).
    const cur = await loadRequest(client, id, { lock: true });
    if (!cur) throw new HttpError(404, "Leave request not found");
    await approvals.assertCanDecide(client, user, cur.user_id, { notFound: "Leave request not found", own: "You cannot decide your own leave request; another approver must" });
    if (cur.status !== "pending") throw new HttpError(409, `This leave request is already ${cur.status}`);
    if (input.decision === "approved") {
      await balanceLock(client, cur.user_id, cur.leave_type_id);
      const type = (await client.query("SELECT counts_against_balance FROM hr_leave_types WHERE id = $1", [cur.leave_type_id])).rows[0];
      if (type && type.counts_against_balance) {
        for (const p of await requestParts(client, cur)) {
          const fig = await yearFigures(client, cur.user_id, cur.leave_type_id, p.year, id);
          if (Number(fig.granted) - Number(fig.approved) < Number(p.days)) throw new HttpError(409, `Insufficient leave balance for ${p.year}`);
        }
      }
    }
    try {
      await client.query("UPDATE hr_leave_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1", [id, input.decision, user.id, note]);
    } catch (err) {
      if (err && err.code === "23P01") throw new HttpError(409, OVERLAP_MSG);
      throw err;
    }
    const row = await loadRequest(client, id);
    const priv = (r) => ({ ...r, reason: r.reason ? "[private]" : null, decision_note: r.decision_note ? "[private]" : null });
    await logAudit({ client, userId: user.id, action: "UPDATE", tableName: "hr_leave_requests", recordId: id, oldData: priv(cur), newData: priv(row) });
    return row;
  });
}

module.exports = { createRequest, myRequests, cancelRequest, teamRequests, decide, balanceLock, yearFigures };
