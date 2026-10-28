// Attendance clocking (hr_attendance): clock-in / clock-out and the employee's own attendance view.
//
// Rules
//  - Every statement for one user is serialised by a per-user transaction advisory lock (clock-in, clock-out and correction
//    approval share it), so ten concurrent clock-ins leave exactly one record. The partial unique index
//    (hr_attendance_one_open_uq) and the overlap trigger remain the database-level backstop.
//  - work_date = (instant AT TIME ZONE tz)::date in SQL; tz = the employee's schedule timezone, else HR_TIMEZONE. A session that
//    spans midnight belongs to the day it was clocked in on.
//  - Repeating a clock-in (while that record is open) or a clock-out (right after closing) within 60 seconds is the same click
//    twice: it answers the existing record with replayed:true and changes nothing.
//  - An open session older than HR_MAX_OPEN_HOURS (default 16) is never closed or capped silently: clock-out is refused with 409,
//    the refusal is audited and the reports flag the record as needs_correction (the employee requests a correction).
//  - worked_minutes = floor(clock_out - clock_in); the schedule's break is reported next to it, never deducted.
//  - Every function takes an optional { now } (Date or ISO string with offset) as the clock; routes pass it only when NODE_ENV is "test".
const { logAudit } = require("../../utils/audit");
const { STAFF_ROLES } = require("../../middleware/staff");
const c = require("./common");

const { HttpError } = c;
const db = () => require("../../db");

const REPLAY_SECONDS = 60;
const DEFAULT_MAX_OPEN_HOURS = 16;
const MAX_RANGE_DAYS = 366;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?([Zz]|[+-]\d{2}:\d{2})$/;

// work_date, worked minutes and the weekday key into hr_schedules.weekly, shared by the queries below.
const REC = `a.id, a.user_id, a.work_date::text AS work_date, a.clock_in, a.clock_out, a.source, a.correction_id, a.note, a.created_at,
  CASE WHEN a.clock_out IS NULL THEN NULL ELSE floor(extract(epoch FROM (a.clock_out - a.clock_in)) / 60)::int END AS worked_minutes`;
const DAY_KEY = (dateExpr) => `(ARRAY['sun','mon','tue','wed','thu','fri','sat'])[extract(dow FROM ${dateExpr})::int + 1]`;

/** HR_MAX_OPEN_HOURS, read at call time: an integer 1..168, anything else is the default 16. */
function maxOpenHours() {
  const raw = String(process.env.HR_MAX_OPEN_HOURS || "").trim();
  if (/^\d{1,3}$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= 168) return n;
  }
  return DEFAULT_MAX_OPEN_HOURS;
}

/** The injected clock as a SQL parameter: null = the database clock. */
function nowParam(opts) {
  const v = opts && opts.now;
  if (v === undefined || v === null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new HttpError(400, "now is not a valid instant");
    return v.toISOString();
  }
  if (typeof v === "string" && ISO_WITH_OFFSET.test(v) && Number.isFinite(Date.parse(v))) return v;
  throw new HttpError(400, "now must be an ISO timestamp with an offset");
}

function requireStaffUser(user) {
  if (!user || !Number.isSafeInteger(user.id) || !STAFF_ROLES.has(user.role)) throw new HttpError(403, "Access denied");
}

/** Serialises everything that writes attendance for one user (clock-in, clock-out, correction approval). */
const clockLock = (client, userId) => client.query("SELECT pg_advisory_xact_lock(hashtext('hr_clock'), $1)", [userId]);

/** Timezone of a user's day: the schedule's, else the company's. Users without an HR profile get the company timezone. */
async function userTz(runner, userId) {
  const r = await runner.query(
    `SELECT s.timezone FROM hr_employees e JOIN hr_schedules s ON s.id = e.schedule_id WHERE e.user_id = $1`,
    [userId]
  );
  return (r.rows[0] && r.rows[0].timezone) || c.companyTimezone();
}

const clockNow = async (client, now) => (await client.query("SELECT COALESCE($1::timestamptz, clock_timestamp()) AS ts", [now])).rows[0].ts;

function withExtra(err, extra) {
  err.extra = extra;
  return err;
}

async function loadRecord(runner, id) {
  return (await runner.query(`SELECT ${REC} FROM hr_attendance a WHERE a.id = $1`, [id])).rows[0];
}

/** @returns {{replayed:boolean, record:object}} */
async function clockIn(user, opts = {}) {
  requireStaffUser(user);
  const now = nowParam(opts);
  const limitS = maxOpenHours() * 3600;
  return c.inTransaction(
    async (client) => {
      await clockLock(client, user.id);
      const ts = await clockNow(client, now);
      const open = (
        await client.query(
          `SELECT ${REC}, extract(epoch FROM ($2::timestamptz - a.clock_in)) AS age_s FROM hr_attendance a WHERE a.user_id = $1 AND a.clock_out IS NULL FOR UPDATE`,
          [user.id, ts]
        )
      ).rows[0];
      if (open) {
        const { age_s: age, ...record } = open;
        if (age <= REPLAY_SECONDS) return { replayed: true, record };
        throw withExtra(new HttpError(409, "already clocked in"), { since: record.clock_in, needs_correction: age > limitS });
      }
      const tz = await userTz(client, user.id);
      const ins = await client.query(
        `INSERT INTO hr_attendance (user_id, work_date, clock_in, source) VALUES ($1, ($2::timestamptz AT TIME ZONE $3)::date, $2::timestamptz, 'clock') RETURNING id`,
        [user.id, ts, tz]
      );
      const record = await loadRecord(client, ins.rows[0].id);
      await logAudit({ client, userId: user.id, action: "CLOCK_IN", tableName: "hr_attendance", recordId: record.id, newData: record });
      return { replayed: false, record };
    },
    { unique: { hr_attendance_one_open_uq: "already clocked in" } }
  );
}

/** @returns {{replayed:boolean, record:object}} */
async function clockOut(user, opts = {}) {
  requireStaffUser(user);
  const now = nowParam(opts);
  const limitS = maxOpenHours() * 3600;
  const out = await c.inTransaction(async (client) => {
    await clockLock(client, user.id);
    const ts = await clockNow(client, now);
    const open = (
      await client.query(
        `SELECT ${REC}, extract(epoch FROM ($2::timestamptz - a.clock_in)) AS age_s FROM hr_attendance a WHERE a.user_id = $1 AND a.clock_out IS NULL FOR UPDATE`,
        [user.id, ts]
      )
    ).rows[0];
    if (!open) {
      const last = (
        await client.query(
          `SELECT ${REC}, extract(epoch FROM ($2::timestamptz - a.clock_out)) AS since_s FROM hr_attendance a
            WHERE a.user_id = $1 AND a.clock_out IS NOT NULL AND a.source = 'clock' ORDER BY a.clock_out DESC, a.id DESC LIMIT 1`,
          [user.id, ts]
        )
      ).rows[0];
      if (last && last.since_s >= 0 && last.since_s <= REPLAY_SECONDS) {
        const { since_s: _s, ...record } = last;
        return { replayed: true, record };
      }
      throw new HttpError(409, "not clocked in");
    }
    const { age_s: age, ...record } = open;
    if (age > limitS) {
      // Refuse, do not cap: the audit row is the flag (reports show needs_correction for the still-open record).
      await logAudit({ client, userId: user.id, action: "CLOCK_OUT_REFUSED", tableName: "hr_attendance", recordId: record.id, newData: { reason: "session too old", clock_in: record.clock_in, open_hours: Math.floor(age / 3600), limit_hours: maxOpenHours() } });
      return { refused: true };
    }
    if (age <= 0) throw new HttpError(409, "clock-out must be after clock-in");
    await client.query("UPDATE hr_attendance SET clock_out = $2::timestamptz WHERE id = $1", [record.id, ts]);
    const closed = await loadRecord(client, record.id);
    await logAudit({ client, userId: user.id, action: "CLOCK_OUT", tableName: "hr_attendance", recordId: closed.id, oldData: record, newData: closed });
    return { replayed: false, record: closed };
  });
  if (out.refused) throw withExtra(new HttpError(409, "session too old; request a correction"), { needs_correction: true });
  return out;
}

/**
 * Resolves ?from&to (YYYY-MM-DD, inclusive) against "today" in `tz`: to defaults to today, from to 30 days before `to`.
 * Day arithmetic happens in SQL. The range may span at most 366 days.
 */
async function resolveRange(runner, query, { tz, now }) {
  const get = (k) => {
    const v = c.oneValue(query[k], k);
    return v === undefined || v === "" ? null : c.parseHrDate(v, k);
  };
  const r = (
    await runner.query(
      `WITH t AS (SELECT (COALESCE($3::timestamptz, clock_timestamp()) AT TIME ZONE $4)::date AS today),
            p AS (SELECT COALESCE($2::date, t.today) AS d_to, t.today FROM t)
       SELECT COALESCE($1::date, p.d_to - 30)::text AS from_day, p.d_to::text AS to_day, p.today::text AS today,
              (p.d_to - COALESCE($1::date, p.d_to - 30) + 1) AS span
         FROM p`,
      [get("from"), get("to"), now, tz]
    )
  ).rows[0];
  if (r.span < 1) throw new HttpError(400, "from must not be after to");
  if (r.span > MAX_RANGE_DAYS) throw new HttpError(400, `The range must not exceed ${MAX_RANGE_DAYS} days`);
  return { from: r.from_day, to: r.to_day, today: r.today, days: r.span };
}

/** GET /hr/me/attendance: the caller's own records, per-day totals in the work_date's day, and the schedule break next to them. */
async function myAttendance(user, query = {}, opts = {}) {
  requireStaffUser(user);
  const now = nowParam(opts);
  const tz = await userTz(db(), user.id);
  const range = await resolveRange(db(), query, { tz, now });
  const records = (
    await db().query(
      `SELECT ${REC}, to_char(a.clock_in AT TIME ZONE $4, 'HH24:MI') AS clock_in_local, to_char(a.clock_out AT TIME ZONE $4, 'HH24:MI') AS clock_out_local
         FROM hr_attendance a WHERE a.user_id = $1 AND a.work_date BETWEEN $2::date AND $3::date ORDER BY a.clock_in ASC, a.id ASC LIMIT 5000`,
      [user.id, range.from, range.to, tz]
    )
  ).rows;
  const days = (
    await db().query(
      `SELECT g.work_date::text AS work_date, g.sessions, g.worked_minutes, g.first_in, g.last_out, g.open,
              CASE WHEN jsonb_typeof(sch.weekly -> ${DAY_KEY("g.work_date")}) = 'object'
                   THEN COALESCE((sch.weekly -> ${DAY_KEY("g.work_date")} ->> 'break_minutes')::int, 0) END AS scheduled_break_minutes
         FROM (
           SELECT a.work_date, count(*)::int AS sessions,
                  floor(COALESCE(sum(extract(epoch FROM (a.clock_out - a.clock_in))) FILTER (WHERE a.clock_out IS NOT NULL), 0) / 60)::int AS worked_minutes,
                  min(a.clock_in) AS first_in, max(a.clock_out) AS last_out, bool_or(a.clock_out IS NULL) AS open
             FROM hr_attendance a WHERE a.user_id = $1 AND a.work_date BETWEEN $2::date AND $3::date GROUP BY a.work_date
         ) g
         LEFT JOIN LATERAL (SELECT s.weekly FROM hr_employees e JOIN hr_schedules s ON s.id = e.schedule_id WHERE e.user_id = $1) sch ON true
        ORDER BY g.work_date ASC`,
      [user.id, range.from, range.to]
    )
  ).rows;
  return { from: range.from, to: range.to, timezone: tz, records, days, worked_minutes: days.reduce((s, d) => s + d.worked_minutes, 0) };
}

/**
 * HR closes a stale open session (POST /hr/attendance/:id/close, hr:write): only an OPEN record, clock_out after clock_in, at most
 * 24 h after it and not in the future. Runs under the user's clock lock; audited; the optional note (<= 500) is stored on the record.
 */
async function closeOpen(user, rawId, input, opts = {}) {
  c.requirePerm(user, "hr:write");
  const id = c.parseId(rawId, { notFound: "Attendance record not found" });
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  c.onlyKeys(input, ["clock_out", "note"]);
  const v = input.clock_out;
  if (typeof v !== "string" || !ISO_WITH_OFFSET.test(v) || !Number.isFinite(Date.parse(v)) || Number(v.slice(0, 4)) < 2000 || Number(v.slice(0, 4)) > 2200) {
    throw new HttpError(400, "clock_out must be an ISO timestamp with an offset, e.g. 2026-03-10T17:00:00+01:00");
  }
  const note = c.cleanText(input.note, "note", 500);
  const now = nowParam(opts);
  return c.inTransaction(async (client) => {
    const owner = (await client.query("SELECT user_id FROM hr_attendance WHERE id = $1", [id])).rows[0];
    if (!owner) throw new HttpError(404, "Attendance record not found");
    await clockLock(client, owner.user_id);
    const cur = (await client.query(`SELECT ${REC} FROM hr_attendance a WHERE a.id = $1 FOR UPDATE`, [id])).rows[0];
    if (!cur) throw new HttpError(404, "Attendance record not found");
    if (cur.clock_out !== null) throw new HttpError(409, "This record is already closed");
    const f = (
      await client.query(
        `SELECT ($1::timestamptz > $2::timestamptz) AS after_in, ($1::timestamptz - $2::timestamptz <= interval '24 hours') AS span_ok,
                ($1::timestamptz <= COALESCE($3::timestamptz, clock_timestamp())) AS past`,
        [v, cur.clock_in, now]
      )
    ).rows[0];
    if (!f.after_in) throw new HttpError(400, "clock_out must be after clock_in");
    if (!f.span_ok) throw new HttpError(400, "clock_out must be at most 24 hours after clock_in");
    if (!f.past) throw new HttpError(400, "clock_out must not be in the future");
    try {
      await client.query("UPDATE hr_attendance SET clock_out = $2::timestamptz, note = COALESCE($3, note) WHERE id = $1", [id, v, note]);
    } catch (err) {
      if (err && err.code === "23P01") throw new HttpError(409, "This overlaps an existing attendance record");
      throw err;
    }
    const closed = await loadRecord(client, id);
    await logAudit({ client, userId: user.id, action: "UPDATE", tableName: "hr_attendance", recordId: id, oldData: cur, newData: closed });
    return closed;
  });
}

/** GET /hr/attendance/open (hr:read): open sessions older than HR_MAX_OPEN_HOURS, oldest first, with the person's name. */
async function listStaleOpen(user, query = {}, opts = {}) {
  c.requirePerm(user, "hr:read");
  const now = nowParam(opts);
  const { limit, offset } = c.pageParams(query);
  const base = `FROM hr_attendance a JOIN users u ON u.id = a.user_id
     LEFT JOIN hr_employees e ON e.user_id = a.user_id LEFT JOIN hr_schedules s ON s.id = e.schedule_id
     WHERE a.clock_out IS NULL AND COALESCE($1::timestamptz, clock_timestamp()) - a.clock_in > make_interval(hours => $2::int)`;
  const total = (await db().query(`SELECT count(*)::int AS n ${base}`, [now, maxOpenHours()])).rows[0].n;
  const rows = (
    await db().query(
      `SELECT a.id, a.user_id, u.full_name, u.role, a.work_date::text AS work_date, a.clock_in,
              floor(extract(epoch FROM (COALESCE($1::timestamptz, clock_timestamp()) - a.clock_in)) / 3600)::int AS open_hours,
              COALESCE(s.timezone, $5::text) AS timezone, to_char(a.clock_in AT TIME ZONE COALESCE(s.timezone, $5::text), 'YYYY-MM-DD HH24:MI') AS clock_in_local
         ${base} ORDER BY a.clock_in ASC, a.id ASC LIMIT $3 OFFSET $4`,
      [now, maxOpenHours(), limit, offset, c.companyTimezone()]
    )
  ).rows;
  return { rows, total, max_open_hours: maxOpenHours() };
}

module.exports = { closeOpen, listStaleOpen, clockIn, clockOut, myAttendance, resolveRange, nowParam, maxOpenHours, clockLock, userTz, requireStaffUser, withExtra, DAY_KEY, REC, REPLAY_SECONDS, ISO_WITH_OFFSET, MAX_RANGE_DAYS };
