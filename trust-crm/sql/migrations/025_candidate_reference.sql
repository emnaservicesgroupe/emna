-- Stage 8 task 1: candidate reference (CAN-YYYY-NNNN) and Canada profile fields. Additive and idempotent.
--
--  * candidate_ref_counters(year, value): one row per calendar year; value = last number issued for that year.
--  * next_candidate_reference(year): upserts the year's counter row (the row lock serialises concurrent issuers and is held until the
--    caller's transaction ends, so a rollback also rolls the number back: no gaps and no duplicates) and returns CAN-YYYY-NNNN
--    (zero-padded to 4 digits, growing beyond 9999).
--  * assign_candidate_reference(id): assigns the reference exactly once (row lock on the candidate; returns the existing one when set).
--    The year is the candidate's created_at year.
--  * BEFORE INSERT trigger: every new candidate (legacy POST /candidates/add, convertLead, agency flows, ...) gets a reference;
--    an explicitly supplied reference is kept. A BEFORE UPDATE trigger makes an assigned reference immutable.
--  * New nullable candidate columns: city, whatsapp, work_authorization_status, relocation_ready, desired_province, service_start_date.
--    (phone and email already exist since migration 001 and are reused.)
--  * Existing candidates are backfilled in id order with the function above (only rows still without a reference).
CREATE TABLE IF NOT EXISTS candidate_ref_counters (
  year  int PRIMARY KEY CHECK (year BETWEEN 1000 AND 9999),
  value int NOT NULL CHECK (value >= 0)
);

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS whatsapp text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS work_authorization_status text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS relocation_ready boolean;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS desired_province text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS service_start_date date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'candidates'::regclass AND conname = 'candidates_reference_format') THEN
    ALTER TABLE candidates ADD CONSTRAINT candidates_reference_format CHECK (reference IS NULL OR reference ~ '^CAN-[0-9]{4}-[0-9]{4,}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'candidates'::regclass AND conname = 'candidates_work_authorization_status_check') THEN
    ALTER TABLE candidates ADD CONSTRAINT candidates_work_authorization_status_check
      CHECK (work_authorization_status IS NULL OR work_authorization_status IN ('none','study_permit','work_permit_open','work_permit_employer_specific','pr','citizen','unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'candidates'::regclass AND conname = 'candidates_desired_province_check') THEN
    ALTER TABLE candidates ADD CONSTRAINT candidates_desired_province_check
      CHECK (desired_province IS NULL OR desired_province IN ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'candidates'::regclass AND conname = 'candidates_city_len') THEN
    ALTER TABLE candidates ADD CONSTRAINT candidates_city_len CHECK (city IS NULL OR char_length(city) <= 120);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS candidates_reference_uniq ON candidates (reference) WHERE reference IS NOT NULL;

CREATE OR REPLACE FUNCTION next_candidate_reference(p_year int) RETURNS text AS $$
DECLARE
  v_val int;
  v_ref text;
BEGIN
  LOOP
    INSERT INTO candidate_ref_counters (year, value) VALUES (p_year, 1)
      ON CONFLICT (year) DO UPDATE SET value = candidate_ref_counters.value + 1
      RETURNING value INTO v_val;
    -- lpad() truncates longer strings, so pad only below 4 digits
    v_ref := 'CAN-' || p_year::text || '-' || CASE WHEN v_val < 1000 THEN lpad(v_val::text, 4, '0') ELSE v_val::text END;
    -- skip a number that was supplied by hand (explicit INSERT) so the unique index can never fire for an issued number
    EXIT WHEN NOT EXISTS (SELECT 1 FROM candidates WHERE reference = v_ref);
  END LOOP;
  RETURN v_ref;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assign_candidate_reference(p_candidate_id int) RETURNS text AS $$
DECLARE
  v_ref text;
  v_year int;
BEGIN
  SELECT reference, EXTRACT(YEAR FROM created_at)::int INTO v_ref, v_year FROM candidates WHERE id = p_candidate_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_ref IS NOT NULL THEN RETURN v_ref; END IF;
  v_ref := next_candidate_reference(v_year);
  UPDATE candidates SET reference = v_ref WHERE id = p_candidate_id;
  RETURN v_ref;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION candidates_assign_reference() RETURNS trigger AS $$
BEGIN
  IF NEW.reference IS NULL THEN
    NEW.reference := next_candidate_reference(EXTRACT(YEAR FROM COALESCE(NEW.created_at, CURRENT_TIMESTAMP))::int);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS candidates_assign_reference ON candidates;
CREATE TRIGGER candidates_assign_reference
  BEFORE INSERT ON candidates
  FOR EACH ROW EXECUTE FUNCTION candidates_assign_reference();

CREATE OR REPLACE FUNCTION candidates_reference_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.reference IS NOT NULL AND NEW.reference IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION 'candidate reference is immutable once assigned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS candidates_reference_immutable ON candidates;
CREATE TRIGGER candidates_reference_immutable
  BEFORE UPDATE OF reference ON candidates
  FOR EACH ROW EXECUTE FUNCTION candidates_reference_immutable();

-- Backfill: existing candidates (deleted ones too) in id order; only rows without a reference, so a re-run changes nothing.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM candidates WHERE reference IS NULL ORDER BY id LOOP
    PERFORM assign_candidate_reference(r.id);
  END LOOP;
END $$;
