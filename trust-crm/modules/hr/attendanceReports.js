// HR attendance report (hr:read) and its CSV export. Everything day-related is computed in SQL:
//   day            the stored work_date (a session belongs to the day it was clocked in)
//   scheduled      the person is expected that day: active profile + schedule with a working entry for that weekday + inside
//                  hire_date..end_date + an active account. People without a profile or schedule are never expected.
//   holiday        a row in hr_holidays        on_leave   hr_is_on_approved_leave(user, day)  (migration 019)
//   late           scheduled, not a holiday / leave day, and the first clock-in is later than start + grace_minutes in the
//                  schedule's timezone (HR_TIMEZONE when there is no schedule timezone)
//   absent         scheduled, not holiday, not on leave, no attendance row, and the day is before today in that timezone
//   open_session   an unclosed record on that day;  needs_correction: open for longer than HR_MAX_OPEN_HOURS
// Only people-and-day rows that matter are returned: days with attendance, or days the person was expected.
// Leave and correction reasons are never part of the report.
const { logAudit } = require("../../utils/audit");
const { STAFF_ROLES } = require("../../middleware/staff");
const { toCsv } = require("../finance/exportCsv");
const c = require("./common");
const { resolveRange, nowParam, maxOpenHours } = require("./attendance");

const { HttpError } = c;
const db = () => require("../../db");

const STAFF_LIST = [...STAFF_ROLES];
const MAX_PERSON_DAYS = 50000;
const HARD_MAX_EXPORT_ROWS = 50000;
const ISO = (expr) => `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/** HR_EXPORT_MAX_ROWS (default and maximum 50000), read at call time. */
function exportMaxRows() {
  const raw = String(process.env.HR_EXPORT_MAX_ROWS || "").trim();
  if (/^\d{1,9}$/.test(raw) && Number(raw) >= 1) return Math.min(Number(raw), HARD_MAX_EXPORT_ROWS);
  return HARD_MAX_EXPORT_ROWS;
}

const ROWS_SQL = `
WITH prm AS (
  SELECT $1::date AS d_from, $2::date AS d_to, COALESCE($3::timestamptz, clock_timestamp()) AS now_ts, $4::text AS company_tz,
         $5::int AS uid, $6::int AS max_open_h
),
people AS (
  SELECT u.id AS user_id, u.full_name, u.is_active, e.employee_no, e.status AS emp_status, e.hire_date, e.end_date, s.weekly,
         COALESCE(s.grace_minutes, 0) AS grace, COALESCE(s.timezone, prm.company_tz) AS tz
    FROM users u CROSS JOIN prm
    LEFT JOIN hr_employees e ON e.user_id = u.id
    LEFT JOIN hr_schedules s ON s.id = e.schedule_id
   WHERE u.role = ANY($7::text[]) AND (prm.uid IS NULL OR u.id = prm.uid)
     AND (u.is_active OR EXISTS (SELECT 1 FROM hr_attendance x WHERE x.user_id = u.id AND x.work_date BETWEEN prm.d_from AND prm.d_to))
),
pd AS (
  SELECT p.*, d.day, (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[extract(dow FROM d.day)::int + 1] AS dkey
    FROM people p CROSS JOIN prm
    CROSS JOIN LATERAL (SELECT (prm.d_from + g)::date AS day FROM generate_series(0, prm.d_to - prm.d_from) g) d
),
agg AS (
  SELECT a.user_id, a.work_date AS day, count(*)::int AS sessions,
         floor(COALESCE(sum(extract(epoch FROM (a.clock_out - a.clock_in))) FILTER (WHERE a.clock_out IS NOT NULL), 0) / 60)::int AS worked_minutes,
         min(a.clock_in) AS first_in, max(a.clock_out) AS last_out,
         bool_or(a.clock_out IS NULL) AS open_session, min(a.clock_in) FILTER (WHERE a.clock_out IS NULL) AS open_since
    FROM hr_attendance a CROSS JOIN prm WHERE a.work_date BETWEEN prm.d_from AND prm.d_to GROUP BY a.user_id, a.work_date
),
base AS (
  SELECT pd.user_id, pd.full_name, pd.employee_no, pd.day, pd.tz, pd.grace, ag.user_id IS NOT NULL AS has_att,
         COALESCE(ag.sessions, 0) AS sessions, COALESCE(ag.worked_minutes, 0) AS worked_minutes, ag.first_in, ag.last_out,
         COALESCE(ag.open_session, false) AS open_session, ag.open_since,
         (pd.weekly IS NOT NULL AND jsonb_typeof(pd.weekly -> pd.dkey) = 'object' AND pd.emp_status = 'active' AND pd.is_active
            AND (pd.hire_date IS NULL OR pd.day >= pd.hire_date) AND (pd.end_date IS NULL OR pd.day <= pd.end_date)) AS expected,
         CASE WHEN pd.weekly IS NOT NULL AND jsonb_typeof(pd.weekly -> pd.dkey) = 'object' THEN (pd.weekly -> pd.dkey ->> 'start')::time END AS start_t,
         CASE WHEN pd.weekly IS NOT NULL AND jsonb_typeof(pd.weekly -> pd.dkey) = 'object' THEN (pd.weekly -> pd.dkey ->> 'end')::time END AS end_t,
         (SELECT h.name FROM hr_holidays h WHERE h.day = pd.day) AS holiday_name,
         hr_is_on_approved_leave(pd.user_id, pd.day) AS on_leave,
         (prm.now_ts AT TIME ZONE pd.tz)::date AS today_local, prm.now_ts, prm.max_open_h
    FROM pd CROSS JOIN prm
    LEFT JOIN agg ag ON ag.user_id = pd.user_id AND ag.day = pd.day
),
calc AS (
  SELECT b.*, (b.holiday_name IS NOT NULL) AS holiday,
         (b.expected AND b.holiday_name IS NULL AND NOT b.on_leave AND b.first_in IS NOT NULL
            AND (b.first_in AT TIME ZONE b.tz) > (b.day + b.start_t + make_interval(mins => b.grace))) AS late
    FROM base b
   WHERE b.has_att OR b.expected
)
SELECT c.day::text AS day, c.user_id, c.full_name, c.employee_no, c.expected AS scheduled,
       to_char(c.start_t, 'HH24:MI') AS scheduled_start, to_char(c.end_t, 'HH24:MI') AS scheduled_end,
       c.holiday, c.holiday_name, c.on_leave, c.sessions, c.worked_minutes,
       ${ISO("c.first_in")} AS first_in, ${ISO("c.last_out")} AS last_out,
       to_char(c.first_in AT TIME ZONE c.tz, 'HH24:MI') AS first_in_local, to_char(c.last_out AT TIME ZONE c.tz, 'HH24:MI') AS last_out_local,
       c.late,
       CASE WHEN c.late THEN floor(extract(epoch FROM ((c.first_in AT TIME ZONE c.tz) - (c.day + c.start_t))) / 60)::int END AS late_minutes,
       (c.expected AND NOT c.holiday AND NOT c.on_leave AND NOT c.has_att AND c.day < c.today_local) AS absent,
       c.open_session,
       (c.open_session AND c.now_ts - c.open_since > interval '1 hour' * c.max_open_h) AS needs_correction
  FROM calc c
 ORDER BY c.day ASC, c.full_name ASC, c.user_id ASC`;

async function resolveScope(runner, user, query, opts) {
  const tz = c.companyTimezone();
  const now = nowParam(opts);
  const range = await resolveRange(runner, query, { tz, now });
  const rawUid = c.oneValue(query.user_id, "user_id");
  let uid = null;
  if (rawUid !== undefined && rawUid !== "") {
    uid = c.parseId(rawUid, { label: "user_id" });
    const ok = await runner.query("SELECT 1 FROM users WHERE id = $1 AND role = ANY($2::text[])", [uid, STAFF_LIST]);
    if (!ok.rowCount) throw new HttpError(404, "Employee not found");
  }
  const people = (await runner.query("SELECT count(*)::int AS n FROM users u WHERE u.role = ANY($1::text[]) AND ($2::int IS NULL OR u.id = $2)", [STAFF_LIST, uid])).rows[0].n;
  if (people * range.days > MAX_PERSON_DAYS) throw new HttpError(400, `Too many person-days (${people * range.days} > ${MAX_PERSON_DAYS}); narrow the date range or filter by user_id`);
  return { range, uid, tz, now };
}

const runRows = (runner, s, limit) =>
  runner.query(limit ? `${ROWS_SQL} LIMIT ${Number(limit)}` : ROWS_SQL, [s.range.from, s.range.to, s.now, s.tz, s.uid, maxOpenHours(), STAFF_LIST]);

function summarize(rows) {
  const s = { people: new Set(), scheduled_days: 0, worked_minutes: 0, late_days: 0, absent_days: 0, holiday_days: 0, leave_days: 0, open_sessions: 0, needs_correction: 0 };
  for (const r of rows) {
    s.people.add(r.user_id);
    s.worked_minutes += r.worked_minutes;
    if (r.scheduled && !r.holiday && !r.on_leave) s.scheduled_days += 1;
    if (r.late) s.late_days += 1;
    if (r.absent) s.absent_days += 1;
    if (r.scheduled && r.holiday) s.holiday_days += 1;
    if (r.scheduled && !r.holiday && r.on_leave) s.leave_days += 1;
    if (r.open_session) s.open_sessions += 1;
    if (r.needs_correction) s.needs_correction += 1;
  }
  return { ...s, people: s.people.size };
}

async function attendanceReport(user, query = {}, opts = {}) {
  c.requirePerm(user, "hr:read");
  const s = await resolveScope(db(), user, query, opts);
  const rows = (await runRows(db(), s)).rows;
  return { from: s.range.from, to: s.range.to, timezone: s.tz, user_id: s.uid, rows, summary: summarize(rows) };
}

const CSV_COLUMNS = ["day", "user_id", "employee_no", "employee_name", "scheduled", "scheduled_start", "first_in", "last_out", "worked_minutes", "late", "late_minutes", "absent", "holiday", "on_leave", "open_session", "needs_correction"];

/** @returns {{csv:string, filename:string, truncated:boolean, rows:number}} */
async function exportAttendanceCsv(user, query = {}, opts = {}) {
  c.requirePerm(user, "hr:read");
  const s = await resolveScope(db(), user, query, opts);
  const cap = exportMaxRows();
  const all = (await runRows(db(), s, cap + 1)).rows;
  const truncated = all.length > cap;
  const rows = (truncated ? all.slice(0, cap) : all).map((r) => ({ ...r, employee_name: r.full_name }));
  await logAudit({ userId: user.id, action: "EXPORT", tableName: "hr_attendance", newData: { format: "csv", from: s.range.from, to: s.range.to, user_id: s.uid, rows: rows.length, truncated } });
  return { csv: toCsv(CSV_COLUMNS, rows), filename: `attendance-${s.range.from}_${s.range.to}.csv`, truncated, rows: rows.length };
}

module.exports = { attendanceReport, exportAttendanceCsv, summarize, MAX_PERSON_DAYS };
