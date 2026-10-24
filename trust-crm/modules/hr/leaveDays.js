// Working-day arithmetic for leave, kept in SQL so schedules and holidays are applied by the database, never by JS Date maths.
//  - A day is a working day when the employee's schedule (hr_employees.schedule_id -> hr_schedules.weekly) has a non-null entry
//    for its weekday AND it is not in hr_holidays. Without a profile, without a schedule, or with a schedule that has no working
//    day at all (nothing configured yet) the default Mon-Fri applies ("default schedule").
//  - A request's `days` are stored once. When a range crosses a year boundary the days are attributed to the two years: the start
//    year gets the working days up to 31 Dec (minus the half-day on the first day), the end year gets the remainder, so the two
//    parts always add up to the stored total.
const DOW_KEYS = "ARRAY['sun','mon','tue','wed','thu','fri','sat']";

/**
 * SQL scalar subquery: number of working days of `userExpr` from `fromExpr` to `toExpr` (inclusive dates, SQL expressions).
 * `weekly`/`has_days` are resolved once per call; the series is plain date arithmetic (no timezone involved).
 */
function wdCount(userExpr, fromExpr, toExpr) {
  return `(SELECT count(*)::int
     FROM (SELECT COALESCE((SELECT s.weekly FROM hr_employees e JOIN hr_schedules s ON s.id = e.schedule_id WHERE e.user_id = ${userExpr}), '{}'::jsonb) AS weekly) w
     CROSS JOIN LATERAL (SELECT COALESCE((SELECT bool_or(jsonb_typeof(x.v) = 'object') FROM jsonb_each(w.weekly) x(k, v)), false) AS has_days) h
     CROSS JOIN LATERAL generate_series(0, GREATEST((${toExpr})::date - (${fromExpr})::date, -1)) g(n)
     CROSS JOIN LATERAL (SELECT ((${fromExpr})::date + g.n) AS day) d
    WHERE (CASE WHEN h.has_days THEN jsonb_typeof(w.weekly -> (${DOW_KEYS})[extract(dow FROM d.day)::int + 1]) = 'object'
                ELSE extract(isodow FROM d.day) BETWEEN 1 AND 5 END)
      AND NOT EXISTS (SELECT 1 FROM hr_holidays hh WHERE hh.day = d.day))`;
}

/** True when the user has a schedule with at least one working day (otherwise the default Mon-Fri was used). */
async function hasConfiguredSchedule(runner, userId) {
  const r = await runner.query(
    `SELECT COALESCE((SELECT bool_or(jsonb_typeof(x.v) = 'object') FROM jsonb_each(s.weekly) x(k, v)), false) AS ok
       FROM hr_employees e JOIN hr_schedules s ON s.id = e.schedule_id WHERE e.user_id = $1`,
    [userId]
  );
  return !!(r.rows[0] && r.rows[0].ok);
}

/**
 * SQL numeric: the days of request alias `r` that belong to calendar year `yearExpr` (0 when it does not touch that year).
 * Single-year requests: r.days. Two-year requests: start-year share computed, end-year share = r.days - start-year share.
 */
function yearShare(r, yearExpr) {
  const startShare = `LEAST(${r}.days, GREATEST(0, ${wdCount(`${r}.user_id`, `${r}.start_date`, `make_date(extract(year FROM ${r}.start_date)::int, 12, 31)`)}::numeric - CASE WHEN ${r}.half_day_start THEN 0.5 ELSE 0 END))`;
  return `(CASE
      WHEN extract(year FROM ${r}.start_date) = extract(year FROM ${r}.end_date) THEN (CASE WHEN extract(year FROM ${r}.start_date) = ${yearExpr} THEN ${r}.days ELSE 0 END)
      WHEN extract(year FROM ${r}.start_date) = ${yearExpr} THEN ${startShare}
      WHEN extract(year FROM ${r}.end_date) = ${yearExpr} THEN ${r}.days - ${startShare}
      ELSE 0 END)`;
}

/**
 * Days of a candidate range, split per year: [{year, days}] (days are decimal strings, one entry per year with days > 0) plus the
 * plain working-day counts. `flagsOnNonWorking` names a half-day flag placed on a day that is not a working day.
 */
async function computeRange(runner, userId, start, end, halfStart, halfEnd) {
  const r = (
    await runner.query(
      `SELECT extract(year FROM $2::date)::int AS y1, extract(year FROM $3::date)::int AS y2,
              ${wdCount("$1", "$2::date", "LEAST($3::date, make_date(extract(year FROM $2::date)::int, 12, 31))")} AS wd1,
              ${wdCount("$1", "GREATEST($2::date, make_date(extract(year FROM $3::date)::int, 1, 1))", "$3::date")} AS wd2,
              ${wdCount("$1", "$2::date", "$2::date")} AS start_working,
              ${wdCount("$1", "$3::date", "$3::date")} AS end_working,
              ${wdCount("$1", "$2::date", "$3::date")} AS wd_total`,
      [userId, start, end]
    )
  ).rows[0];
  return r;
}

module.exports = { wdCount, yearShare, computeRange, hasConfiguredSchedule };
