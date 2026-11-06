-- Stage 8 task 2: Canadian-format CV versions stored as js_cv_files rows. Additive and idempotent.
--
-- Existing columns are REUSED, not duplicated:
--   approved (boolean)  canadian rows: true only once STAFF approved the version
--   version             canadian rows: counted per (candidate, language), independent of the numbering of uploaded originals
--   language            canadian rows: 'en' | 'fr' (headings only; facts are never translated)
--   sha256 / storage_key / scan_status  as for uploads (generated files are recorded 'clean' / system_generated)
-- New columns describe the generated artefact and the two human gates (staff approval, then candidate authorisation).
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'upload';
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS format text;
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS canonical_name text;
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS source_profile_hash text;
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS source_profile_confirmed_at timestamptz;
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS generated_by int REFERENCES users(id);
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS generated_at timestamptz;
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS staff_approved_by int REFERENCES users(id);
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS staff_approved_at timestamptz;
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS candidate_authorised_by int REFERENCES users(id);
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS candidate_authorised_at timestamptz;
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS candidate_withdrawn_at timestamptz;
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS missing jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_cv_files'::regclass AND conname = 'js_cv_files_kind_check') THEN
    ALTER TABLE js_cv_files ADD CONSTRAINT js_cv_files_kind_check CHECK (kind IN ('upload','canadian'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_cv_files'::regclass AND conname = 'js_cv_files_format_check') THEN
    ALTER TABLE js_cv_files ADD CONSTRAINT js_cv_files_format_check CHECK (format IS NULL OR format IN ('pdf','docx'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_cv_files'::regclass AND conname = 'js_cv_files_canadian_shape') THEN
    ALTER TABLE js_cv_files ADD CONSTRAINT js_cv_files_canadian_shape CHECK (
      kind = 'upload'
      OR (format IS NOT NULL AND canonical_name IS NOT NULL AND language IN ('en','fr') AND source_profile_hash IS NOT NULL AND sha256 IS NOT NULL
          AND canonical_name ~ '^CAN-[0-9]{4}-[0-9]{4,}-CV-V[0-9]{1,4}(-FR)?\.(pdf|docx)$')
    );
  END IF;
  -- authorisation is only possible on a staff-approved row
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_cv_files'::regclass AND conname = 'js_cv_files_authorised_after_approval') THEN
    ALTER TABLE js_cv_files ADD CONSTRAINT js_cv_files_authorised_after_approval CHECK (candidate_authorised_at IS NULL OR staff_approved_at IS NOT NULL);
  END IF;
END $$;

-- One row per (candidate, language, version, format) for generated CVs.
CREATE UNIQUE INDEX IF NOT EXISTS js_cv_files_canadian_version_uniq ON js_cv_files (candidate_id, language, version, format) WHERE kind = 'canadian';

-- A generated file is never overwritten: its identity and content columns are immutable (approval / authorisation columns are not).
CREATE OR REPLACE FUNCTION js_cv_files_canadian_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.kind = 'canadian' AND (
       NEW.kind IS DISTINCT FROM OLD.kind OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.version IS DISTINCT FROM OLD.version OR NEW.language IS DISTINCT FROM OLD.language
    OR NEW.format IS DISTINCT FROM OLD.format OR NEW.canonical_name IS DISTINCT FROM OLD.canonical_name
    OR NEW.source_profile_hash IS DISTINCT FROM OLD.source_profile_hash OR NEW.missing IS DISTINCT FROM OLD.missing
    OR NEW.generated_by IS DISTINCT FROM OLD.generated_by OR NEW.generated_at IS DISTINCT FROM OLD.generated_at) THEN
    RAISE EXCEPTION 'generated Canadian CV files are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS js_cv_files_canadian_immutable_trg ON js_cv_files;
CREATE TRIGGER js_cv_files_canadian_immutable_trg BEFORE UPDATE ON js_cv_files FOR EACH ROW EXECUTE FUNCTION js_cv_files_canadian_immutable();
