-- Stage 5, review round 1: the per-year split of a leave request is STORED when the request is created, so a later change to a
-- holiday or to the employee's schedule can never move already-requested days from one calendar year to the other.
--   days_year_start  days that fall in the year of start_date      days_year_end  days that fall in the year of end_date
-- (a request inside one year has days_year_start = days and days_year_end = 0). Both are NULL on rows created before this
-- migration was applied by older code; readers then fall back to the live computation. Additive and idempotent.
ALTER TABLE hr_leave_requests ADD COLUMN IF NOT EXISTS days_year_start numeric(6,2);
ALTER TABLE hr_leave_requests ADD COLUMN IF NOT EXISTS days_year_end numeric(6,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_leave_year_split_check' AND conrelid = to_regclass('hr_leave_requests')) THEN
    ALTER TABLE hr_leave_requests ADD CONSTRAINT hr_leave_year_split_check CHECK (
      (days_year_start IS NULL AND days_year_end IS NULL)
      OR (days_year_start IS NOT NULL AND days_year_end IS NOT NULL AND days_year_start >= 0 AND days_year_end >= 0 AND days_year_start + days_year_end = days)
    );
  END IF;
END $$;

-- Working days of a user between two dates (inclusive) under the CURRENT schedule and holidays; the same rule the application
-- uses (a schedule with no working day, or no schedule, means Mon-Fri). Used here only to backfill existing rows.
CREATE OR REPLACE FUNCTION hr_working_days(p_user int, p_from date, p_to date) RETURNS int AS $$
  SELECT count(*)::int
    FROM (SELECT COALESCE((SELECT s.weekly FROM hr_employees e JOIN hr_schedules s ON s.id = e.schedule_id WHERE e.user_id = p_user), '{}'::jsonb) AS weekly) w
    CROSS JOIN LATERAL (SELECT COALESCE((SELECT bool_or(jsonb_typeof(x.v) = 'object') FROM jsonb_each(w.weekly) x(k, v)), false) AS has_days) h
    CROSS JOIN LATERAL generate_series(0, GREATEST(p_to - p_from, -1)) g(n)
    CROSS JOIN LATERAL (SELECT (p_from + g.n) AS day) d
   WHERE (CASE WHEN h.has_days THEN jsonb_typeof(w.weekly -> (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[extract(dow FROM d.day)::int + 1]) = 'object'
               ELSE extract(isodow FROM d.day) BETWEEN 1 AND 5 END)
     AND NOT EXISTS (SELECT 1 FROM hr_holidays hh WHERE hh.day = d.day);
$$ LANGUAGE sql STABLE;

-- Backfill with the formula the application used until now: start-year share = working days up to 31 Dec minus the first-day half,
-- capped at the total; end-year share = the rest, so the two parts always add up to `days`.
UPDATE hr_leave_requests r
   SET days_year_start = s.share, days_year_end = r.days - s.share
  FROM (
    SELECT q.id, LEAST(q.days, GREATEST(0, hr_working_days(q.user_id, q.start_date, make_date(extract(year FROM q.start_date)::int, 12, 31))::numeric
                                           - CASE WHEN q.half_day_start THEN 0.5 ELSE 0 END))::numeric(6,2) AS share
      FROM hr_leave_requests q
     WHERE q.days_year_start IS NULL AND extract(year FROM q.start_date) <> extract(year FROM q.end_date)
  ) s
 WHERE r.id = s.id AND r.days_year_start IS NULL;

UPDATE hr_leave_requests SET days_year_start = days, days_year_end = 0
 WHERE days_year_start IS NULL AND extract(year FROM start_date) = extract(year FROM end_date);
