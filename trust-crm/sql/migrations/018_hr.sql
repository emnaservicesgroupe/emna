-- Stage 5: attendance and HR. Additive and idempotent: only new objects, nothing existing is rewritten, so running it
-- again (or on a fresh database) changes nothing.
--
-- Not stored here on purpose: salary, payroll, ID numbers, medical details, performance data, GPS, photos, biometrics.
-- Timestamps are timestamptz; the company timezone (HR_TIMEZONE, default Africa/Tunis) is applied by the services in SQL.
-- Personal HR rows follow the user: deleting a user removes their rows; "who decided / created" columns are SET NULL.

-- 1. Schedules ---------------------------------------------------------------------------------------------------------
-- weekly = {"mon":{"start":"09:00","end":"17:30","break_minutes":60}, "sat":null, ...}; a missing or null day is a day off.
CREATE OR REPLACE FUNCTION hr_schedule_weekly_valid(w jsonb) RETURNS boolean AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF w IS NULL OR jsonb_typeof(w) <> 'object' THEN
    RETURN false;
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(w) LOOP
    IF k NOT IN ('mon','tue','wed','thu','fri','sat','sun') THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(v) = 'null' THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(v) <> 'object' THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(v->'start') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'end') IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    IF (v->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR (v->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RETURN false;
    END IF;
    IF (v->>'end') <= (v->>'start') THEN
      RETURN false;
    END IF;
    IF v ? 'break_minutes' THEN
      IF jsonb_typeof(v->'break_minutes') <> 'number' OR (v->>'break_minutes') !~ '^[0-9]{1,3}$' OR (v->>'break_minutes')::int > 720 THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE IF NOT EXISTS hr_schedules (
  id bigserial PRIMARY KEY,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  weekly jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (hr_schedule_weekly_valid(weekly)),
  grace_minutes int NOT NULL DEFAULT 10 CHECK (grace_minutes BETWEEN 0 AND 240),
  timezone text NOT NULL DEFAULT 'Africa/Tunis' CHECK (char_length(btrim(timezone)) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Employees (HR profile of a staff user; absence of a row means "no profile yet", self-service still works) -----------
CREATE TABLE IF NOT EXISTS hr_employees (
  user_id int PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  employee_no text CHECK (employee_no IS NULL OR char_length(btrim(employee_no)) BETWEEN 1 AND 40),
  position text CHECK (char_length(position) <= 120),
  department text CHECK (char_length(department) <= 120),
  hire_date date,
  end_date date,
  employment_type text CHECK (char_length(employment_type) <= 40),
  phone text CHECK (char_length(phone) <= 40),
  emergency_contact_name text CHECK (char_length(emergency_contact_name) <= 120),
  emergency_contact_phone text CHECK (char_length(emergency_contact_phone) <= 40),
  manager_user_id int REFERENCES users(id) ON DELETE SET NULL,
  schedule_id bigint REFERENCES hr_schedules(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes text CHECK (char_length(notes) <= 4000),            -- HR-only
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_employees_dates_check CHECK (end_date IS NULL OR hire_date IS NULL OR end_date >= hire_date),
  CONSTRAINT hr_employees_not_own_manager CHECK (manager_user_id IS NULL OR manager_user_id <> user_id)
);

-- 3. Public holidays (data entered by the owner / HR) --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_holidays (
  id bigserial PRIMARY KEY,
  day date NOT NULL UNIQUE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  created_by int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Attendance corrections (requests; an approved one creates a hr_attendance row with source 'correction') ------------
CREATE TABLE IF NOT EXISTS hr_attendance_corrections (
  id bigserial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  requested_in timestamptz NOT NULL,
  requested_out timestamptz,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by int REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text CHECK (char_length(decision_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_corrections_order_check CHECK (requested_out IS NULL OR requested_out > requested_in),
  CONSTRAINT hr_corrections_pending_check CHECK (status <> 'pending' OR decided_at IS NULL)
);

-- 5. Attendance (server-timestamped clock events; never edited silently, only corrected) ---------------------------------
CREATE TABLE IF NOT EXISTS hr_attendance (
  id bigserial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  clock_in timestamptz NOT NULL,
  clock_out timestamptz,
  source text NOT NULL DEFAULT 'clock' CHECK (source IN ('clock','correction')),
  correction_id bigint REFERENCES hr_attendance_corrections(id) ON DELETE SET NULL,
  note text CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_attendance_order_check CHECK (clock_out IS NULL OR clock_out > clock_in)
);

-- At most one open session per user.
CREATE UNIQUE INDEX IF NOT EXISTS hr_attendance_one_open_uq ON hr_attendance (user_id) WHERE clock_out IS NULL;

-- 6. Leave -------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_leave_types (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (char_length(btrim(code)) BETWEEN 1 AND 40),
  name_ar text NOT NULL CHECK (char_length(btrim(name_ar)) BETWEEN 1 AND 120),
  name_en text NOT NULL CHECK (char_length(btrim(name_en)) BETWEEN 1 AND 120),
  name_fr text NOT NULL CHECK (char_length(btrim(name_fr)) BETWEEN 1 AND 120),
  paid boolean NOT NULL DEFAULT true,
  counts_against_balance boolean NOT NULL DEFAULT true,
  requires_approval boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Used days are derived from approved requests, not stored.
CREATE TABLE IF NOT EXISTS hr_leave_balances (
  id bigserial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id bigint NOT NULL REFERENCES hr_leave_types(id),
  year int NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  entitled_days numeric(6,2) NOT NULL DEFAULT 0 CHECK (entitled_days >= 0),
  adjusted_days numeric(6,2) NOT NULL DEFAULT 0,
  CONSTRAINT hr_leave_balances_uq UNIQUE (user_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS hr_leave_requests (
  id bigserial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id bigint NOT NULL REFERENCES hr_leave_types(id),
  start_date date NOT NULL,
  end_date date NOT NULL,
  half_day_start boolean NOT NULL DEFAULT false,
  half_day_end boolean NOT NULL DEFAULT false,
  days numeric(6,2) NOT NULL CHECK (days >= 0),             -- working days, computed server-side
  reason text CHECK (char_length(reason) <= 1000),          -- private to the employee, approvers and HR
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by int REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text CHECK (char_length(decision_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_leave_dates_check CHECK (end_date >= start_date),
  CONSTRAINT hr_leave_pending_check CHECK (status <> 'pending' OR decided_at IS NULL)
);

-- 7. Overlap prevention ------------------------------------------------------------------------------------------------
-- The triggers are ALWAYS installed and are the guarantee: behaviour is identical with or without btree_gist. Each takes a
-- per-user transaction advisory lock so two concurrent transactions for one user cannot both pass the check. They raise
-- SQLSTATE 23P01 (exclusion_violation) with the same constraint name as the optional EXCLUDE constraint below, so callers
-- handle one error either way. Open attendance intervals end at infinity; intervals are half-open [in, out) so back-to-back
-- sessions are allowed; leave ranges are inclusive dates and only pending/approved requests take part.
CREATE OR REPLACE FUNCTION hr_attendance_no_overlap() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hr_attendance_overlap'), NEW.user_id);
  IF EXISTS (
    SELECT 1 FROM hr_attendance o
     WHERE o.user_id = NEW.user_id
       AND o.id <> NEW.id
       AND o.clock_in < COALESCE(NEW.clock_out, 'infinity'::timestamptz)
       AND COALESCE(o.clock_out, 'infinity'::timestamptz) > NEW.clock_in
  ) THEN
    RAISE EXCEPTION 'attendance interval overlaps an existing one for user %', NEW.user_id
      USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'hr_attendance_no_overlap';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hr_attendance_no_overlap_trg ON hr_attendance;
CREATE TRIGGER hr_attendance_no_overlap_trg BEFORE INSERT OR UPDATE OF user_id, clock_in, clock_out ON hr_attendance
  FOR EACH ROW EXECUTE FUNCTION hr_attendance_no_overlap();

CREATE OR REPLACE FUNCTION hr_leave_no_overlap() RETURNS trigger AS $$
BEGIN
  IF NEW.status NOT IN ('pending','approved') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hr_leave_overlap'), NEW.user_id);
  IF EXISTS (
    SELECT 1 FROM hr_leave_requests o
     WHERE o.user_id = NEW.user_id
       AND o.id <> NEW.id
       AND o.status IN ('pending','approved')
       AND o.start_date <= NEW.end_date
       AND o.end_date >= NEW.start_date
  ) THEN
    RAISE EXCEPTION 'leave request overlaps another pending or approved request for user %', NEW.user_id
      USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'hr_leave_no_overlap';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hr_leave_no_overlap_trg ON hr_leave_requests;
CREATE TRIGGER hr_leave_no_overlap_trg BEFORE INSERT OR UPDATE OF user_id, start_date, end_date, status ON hr_leave_requests
  FOR EACH ROW EXECUTE FUNCTION hr_leave_no_overlap();

-- Best effort: declarative exclusion constraints as well when btree_gist can be installed (it needs privileges some hosts
-- withhold). Any failure is swallowed; the triggers above stay in force either way.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA public;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'btree_gist unavailable (%), relying on the overlap triggers', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_attendance_no_overlap' AND conrelid = to_regclass('hr_attendance')) THEN
        ALTER TABLE hr_attendance ADD CONSTRAINT hr_attendance_no_overlap
          EXCLUDE USING gist (user_id WITH =, tstzrange(clock_in, COALESCE(clock_out, 'infinity'::timestamptz), '[)') WITH &&);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_leave_no_overlap' AND conrelid = to_regclass('hr_leave_requests')) THEN
        ALTER TABLE hr_leave_requests ADD CONSTRAINT hr_leave_no_overlap
          EXCLUDE USING gist (user_id WITH =, daterange(start_date, end_date, '[]') WITH &&) WHERE (status IN ('pending','approved'));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'exclusion constraints not added (%), relying on the overlap triggers', SQLERRM;
    END;
  END IF;
END $$;

-- 8. Indexes (foreign keys and filter columns) -------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS hr_employees_no_uq ON hr_employees (employee_no) WHERE employee_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_employees_manager_idx ON hr_employees (manager_user_id) WHERE manager_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_employees_schedule_idx ON hr_employees (schedule_id) WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_employees_status_idx ON hr_employees (status);
CREATE INDEX IF NOT EXISTS hr_holidays_created_by_idx ON hr_holidays (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_attendance_user_date_idx ON hr_attendance (user_id, work_date);
CREATE INDEX IF NOT EXISTS hr_attendance_work_date_idx ON hr_attendance (work_date);
CREATE INDEX IF NOT EXISTS hr_attendance_correction_idx ON hr_attendance (correction_id) WHERE correction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_corrections_user_idx ON hr_attendance_corrections (user_id, work_date);
CREATE INDEX IF NOT EXISTS hr_corrections_status_idx ON hr_attendance_corrections (status, work_date);
CREATE INDEX IF NOT EXISTS hr_corrections_decided_by_idx ON hr_attendance_corrections (decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_leave_balances_type_idx ON hr_leave_balances (leave_type_id);
CREATE INDEX IF NOT EXISTS hr_leave_requests_user_idx ON hr_leave_requests (user_id, start_date);
CREATE INDEX IF NOT EXISTS hr_leave_requests_status_idx ON hr_leave_requests (status, start_date);
CREATE INDEX IF NOT EXISTS hr_leave_requests_type_idx ON hr_leave_requests (leave_type_id);
CREATE INDEX IF NOT EXISTS hr_leave_requests_decided_by_idx ON hr_leave_requests (decided_by) WHERE decided_by IS NOT NULL;
