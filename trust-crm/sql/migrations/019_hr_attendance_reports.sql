-- Stage 5, attendance reports: the single place that answers "is this person on approved leave on this day?".
-- Attendance reports (absent flag) call it, and the leave module extends it by redefining this function (CREATE OR REPLACE) if
-- its rules grow. Additive and idempotent.
--
-- Rule: an APPROVED request whose inclusive date range covers the day. A half-day boundary (half_day_start on the first day,
-- half_day_end on the last) is NOT full-day leave: the employee is still expected for the other half, so it returns false there.
CREATE OR REPLACE FUNCTION hr_is_on_approved_leave(p_user int, p_day date) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM hr_leave_requests r
     WHERE r.user_id = p_user
       AND r.status = 'approved'
       AND p_day BETWEEN r.start_date AND r.end_date
       AND NOT (p_day = r.start_date AND r.half_day_start)
       AND NOT (p_day = r.end_date AND r.half_day_end)
  );
$$ LANGUAGE sql STABLE;
