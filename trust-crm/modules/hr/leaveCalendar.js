// Team leave calendar (GET /hr/team/calendar?from&to, range <= 93 days) and the per-employee leave report (GET /hr/reports/leave).
//
// Calendar visibility (any active staff may call it; the result depends on who asks)
//  - hr:read (HR, Admin, SuperAdmin): everyone's approved AND pending leave.
//  - hr:approve-only (Manager): their direct reports' approved and pending leave, plus their own.
//  - everyone else: only their own leave (a colleague's leave is never visible; department membership grants nothing).
// Entries carry the person's name, the leave type NAME, the dates, half-day flags and the status. They NEVER carry the reason,
// the decision note, who decided, the day count or the request id. Holidays of the window are listed alongside.
const c = require("./common");
const approvals = require("./approvals");
const { yearShare } = require("./leaveDays");
const { requireStaffUser } = require("./attendance");

const { HttpError } = c;
const db = () => require("../../db");
const MAX_WINDOW_DAYS = 93;

async function teamCalendar(user, query = {}) {
  requireStaffUser(user);
  const fromRaw = c.oneValue(query.from, "from");
  const toRaw = c.oneValue(query.to, "to");
  if (!fromRaw || !toRaw) throw new HttpError(400, "from and to are required (YYYY-MM-DD)");
  const from = c.parseHrDate(fromRaw, "from");
  const to = c.parseHrDate(toRaw, "to");
  if (to < from) throw new HttpError(400, "from must not be after to");
  const span = (await db().query("SELECT ($2::date - $1::date + 1) AS n", [from, to])).rows[0].n;
  if (span > MAX_WINDOW_DAYS) throw new HttpError(400, `The range must not exceed ${MAX_WINDOW_DAYS} days`);

  const params = [from, to, user.id];
  const all = approvals.seesAll(user);
  const approver = c.hasPerm(user, "hr:approve");
  const rows = (
    await db().query(
      `SELECT r.user_id, u.full_name, t.name_ar, t.name_en, t.name_fr, t.code AS leave_type_code, t.name_en AS leave_type_name,
              r.start_date::text AS start_date, r.end_date::text AS end_date, r.half_day_start, r.half_day_end, r.status
         FROM hr_leave_requests r
         JOIN users u ON u.id = r.user_id AND u.is_active
         JOIN hr_leave_types t ON t.id = r.leave_type_id
         LEFT JOIN hr_employees e ON e.user_id = r.user_id
        WHERE r.start_date <= $2::date AND r.end_date >= $1::date AND r.status IN ('approved', 'pending')
          AND (
                r.user_id = $3::int
             OR (${all ? "true" : "false"})
             OR (${approver && !all ? "e.manager_user_id = $3::int" : "false"})
          )
        ORDER BY r.start_date ASC, u.full_name ASC, r.id ASC
        LIMIT 2000`,
      params
    )
  ).rows;
  const holidays = (await db().query("SELECT day::text AS day, name FROM hr_holidays WHERE day BETWEEN $1::date AND $2::date ORDER BY day ASC", [from, to])).rows;
  return {
    from,
    to,
    entries: rows.map((r) => ({
      user_id: r.user_id,
      full_name: r.full_name,
      leave_type_code: r.leave_type_code,
      leave_type_name: r.leave_type_name,
      name_ar: r.name_ar,
      name_en: r.name_en,
      name_fr: r.name_fr,
      start_date: r.start_date,
      end_date: r.end_date,
      half_day_start: r.half_day_start,
      half_day_end: r.half_day_end,
      status: r.status,
    })),
    holidays,
  };
}

/** Per employee and leave type for one year: entitled, adjusted, approved, pending, remaining (after approved) and available (after pending too). */
async function leaveReport(user, query = {}) {
  c.requirePerm(user, "hr:read");
  const yr = c.oneValue(query.year, "year");
  const year = yr === undefined || yr === "" ? (await db().query("SELECT extract(year FROM now() AT TIME ZONE $1)::int AS y", [c.companyTimezone()])).rows[0].y : c.parseYear(yr);
  const { limit, offset } = c.pageParams(query);
  const base = `
    WITH req AS (
      SELECT r.user_id, r.leave_type_id, r.status, ${yearShare("r", "$1::int")} AS d
        FROM hr_leave_requests r
       WHERE r.status IN ('approved', 'pending') AND r.start_date <= make_date($1::int, 12, 31) AND r.end_date >= make_date($1::int, 1, 1)
    ), agg AS (
      SELECT user_id, leave_type_id, COALESCE(sum(d) FILTER (WHERE status = 'approved'), 0) AS approved, COALESCE(sum(d) FILTER (WHERE status = 'pending'), 0) AS pending
        FROM req GROUP BY user_id, leave_type_id
    ), pairs AS (
      SELECT user_id, leave_type_id FROM hr_leave_balances WHERE year = $1::int
      UNION
      SELECT user_id, leave_type_id FROM agg
    ), rep AS (
      SELECT p.user_id, u.full_name, u.role, e.employee_no, e.department, p.leave_type_id, t.code AS leave_type_code, t.name_ar, t.name_en, t.name_fr, t.counts_against_balance,
             COALESCE(b.entitled_days, 0) AS entitled, COALESCE(b.adjusted_days, 0) AS adjusted, COALESCE(a.approved, 0) AS approved, COALESCE(a.pending, 0) AS pending
        FROM pairs p
        JOIN users u ON u.id = p.user_id
        JOIN hr_leave_types t ON t.id = p.leave_type_id
        LEFT JOIN hr_employees e ON e.user_id = p.user_id
        LEFT JOIN hr_leave_balances b ON b.user_id = p.user_id AND b.leave_type_id = p.leave_type_id AND b.year = $1::int
        LEFT JOIN agg a ON a.user_id = p.user_id AND a.leave_type_id = p.leave_type_id
    )`;
  const total = (await db().query(`${base} SELECT count(*)::int AS n FROM rep`, [year])).rows[0].n;
  const rows = (
    await db().query(
      `${base} SELECT user_id, full_name, role, employee_no, department, leave_type_id, leave_type_code, name_ar, name_en, name_fr, counts_against_balance,
              entitled::numeric(8,2)::text AS entitled_days, adjusted::numeric(8,2)::text AS adjusted_days, approved::numeric(8,2)::text AS approved_days, pending::numeric(8,2)::text AS pending_days,
              (entitled + adjusted - approved)::numeric(8,2)::text AS remaining_days, (entitled + adjusted - approved - pending)::numeric(8,2)::text AS available_days
         FROM rep ORDER BY full_name ASC, user_id ASC, leave_type_code ASC LIMIT $2 OFFSET $3`,
      [year, limit, offset]
    )
  ).rows;
  return { year, rows, total };
}

module.exports = { teamCalendar, leaveReport, MAX_WINDOW_DAYS };
