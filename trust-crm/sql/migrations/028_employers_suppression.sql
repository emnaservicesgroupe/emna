-- Stage 8 task 4: richer employer records, opt-out suppression list, outreach basis. Additive and idempotent.
--
--  * js_employers gains the Canadian directory fields (province, city, industry, phone, recruiter contact, source URLs,
--    eligibility note, status, last verification, staff-only notes). Existing rows get status 'new' and empty values.
--    status opted_out / blocked make the pre-send guard refuse every send to that employer.
--  * js_suppressions is the do-not-contact list. kind 'email' = one address (plus-addressing: a suppression of a@b.com also
--    covers a+tag@b.com, matched in code), kind 'domain' = the domain and every subdomain (matched in code). The value CHECKs
--    keep the table normalised so a lookup never has to guess: lower-case, no whitespace, no trailing dot, domains without '@',
--    addresses with exactly one '@'. Unique per (kind, value). employer_id / message_id / created_by are plain references that
--    become NULL when the row they point to is deleted (the suppression itself must survive that).
--  * js_applications.outreach_basis records why we contact the employer. The guard only allows 'published_vacancy_application'
--    in this stage; the other two values exist so a later, lawyer-approved basis needs no migration.
ALTER TABLE js_employers ADD COLUMN IF NOT EXISTS province text;
ALTER TABLE js_employers ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE js_employers ADD COLUMN IF NOT EXISTS industry text;
ALTER TABLE js_employers ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE js_employers ADD COLUMN IF NOT EXISTS recruiter_contact_name text;
ALTER TABLE js_employers ADD COLUMN IF NOT EXISTS source_urls jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE js_employers ADD COLUMN IF NOT EXISTS eligibility_note text;
ALTER TABLE js_employers ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new';
ALTER TABLE js_employers ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;
ALTER TABLE js_employers ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE js_applications ADD COLUMN IF NOT EXISTS outreach_basis text NOT NULL DEFAULT 'published_vacancy_application';

CREATE TABLE IF NOT EXISTS js_suppressions (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  value       text NOT NULL,
  reason      text,
  source      text NOT NULL DEFAULT 'manual',
  employer_id int REFERENCES js_employers(id) ON DELETE SET NULL,
  message_id  int REFERENCES js_messages(id) ON DELETE SET NULL,
  created_by  int REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_employers'::regclass AND conname = 'js_employers_province_check') THEN
    ALTER TABLE js_employers ADD CONSTRAINT js_employers_province_check CHECK (province IS NULL OR province IN ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_employers'::regclass AND conname = 'js_employers_status_check') THEN
    ALTER TABLE js_employers ADD CONSTRAINT js_employers_status_check CHECK (status IN ('new','verified','contacted','replied','opted_out','blocked'));
  END IF;
  -- an array of at most 20 http(s) URLs without credentials (the application validates the details; this is the backstop)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_employers'::regclass AND conname = 'js_employers_source_urls_check') THEN
    ALTER TABLE js_employers ADD CONSTRAINT js_employers_source_urls_check CHECK (jsonb_typeof(source_urls) = 'array' AND jsonb_array_length(source_urls) <= 20);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_applications'::regclass AND conname = 'js_applications_outreach_basis_check') THEN
    ALTER TABLE js_applications ADD CONSTRAINT js_applications_outreach_basis_check CHECK (outreach_basis IN ('published_vacancy_application','employer_requested','other_documented'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_suppressions'::regclass AND conname = 'js_suppressions_kind_check') THEN
    ALTER TABLE js_suppressions ADD CONSTRAINT js_suppressions_kind_check CHECK (kind IN ('email','domain'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_suppressions'::regclass AND conname = 'js_suppressions_source_check') THEN
    ALTER TABLE js_suppressions ADD CONSTRAINT js_suppressions_source_check CHECK (source IN ('manual','reply_opt_out','bounce'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_suppressions'::regclass AND conname = 'js_suppressions_value_check') THEN
    ALTER TABLE js_suppressions ADD CONSTRAINT js_suppressions_value_check CHECK (
      value = lower(value) AND value <> '' AND length(value) <= 254 AND value !~ '[[:space:][:cntrl:]<>,;"]' AND value !~ '\.$'
      AND ((kind = 'domain' AND value !~ '@' AND value ~ '\.') OR (kind = 'email' AND value ~ '^[^@]+@[^@]+$'))
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS js_suppressions_kind_value_uq ON js_suppressions (kind, value);
CREATE INDEX IF NOT EXISTS js_suppressions_employer_idx ON js_suppressions (employer_id) WHERE employer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS js_employers_status_idx ON js_employers (status);
CREATE INDEX IF NOT EXISTS js_employers_province_idx ON js_employers (province) WHERE province IS NOT NULL;
