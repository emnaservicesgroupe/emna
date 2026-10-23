-- VITA AI Job Search: core schema (all tables prefixed js_). Idempotent.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS js_candidate_accounts (
  id serial PRIMARY KEY,
  user_id int NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  candidate_id int NOT NULL UNIQUE REFERENCES candidates(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS js_otps (
  id serial PRIMARY KEY,
  email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS js_otps_email_idx ON js_otps (email, created_at DESC);

CREATE TABLE IF NOT EXISTS js_module_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS js_profiles (
  id serial PRIMARY KEY,
  candidate_id int NOT NULL UNIQUE REFERENCES candidates(id) ON DELETE CASCADE,
  extracted jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'extracted' CHECK (status IN ('extracted','confirmed')),
  confirmed_by int REFERENCES users(id),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS js_cv_files (
  id serial PRIMARY KEY,
  candidate_id int NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  sha256 text,
  version int NOT NULL DEFAULT 1,
  language text,
  approved boolean NOT NULL DEFAULT false,
  original boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS js_cv_files_candidate_idx ON js_cv_files (candidate_id);

CREATE TABLE IF NOT EXISTS js_preferences (
  id serial PRIMARY KEY,
  candidate_id int NOT NULL UNIQUE REFERENCES candidates(id) ON DELETE CASCADE,
  countries text[] NOT NULL DEFAULT '{}',
  categories text[] NOT NULL DEFAULT '{}',
  availability text,
  salary_min numeric,
  salary_currency text,
  residence_country text,
  needs_work_auth_support boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS js_consents (
  id serial PRIMARY KEY,
  candidate_id int NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  version text,
  granted_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  granted_by int REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS js_consents_candidate_idx ON js_consents (candidate_id);

CREATE TABLE IF NOT EXISTS js_candidate_settings (
  id serial PRIMARY KEY,
  candidate_id int NOT NULL UNIQUE REFERENCES candidates(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'search_only' CHECK (mode IN ('search_only','prepare_for_approval','automatic')),
  paused boolean NOT NULL DEFAULT false,
  cap_per_day int NOT NULL DEFAULT 0,
  cap_per_week int NOT NULL DEFAULT 0,
  allowed_countries text[] NOT NULL DEFAULT '{}',
  allowed_professions text[] NOT NULL DEFAULT '{}',
  allowed_sources text[] NOT NULL DEFAULT '{}',
  approved_doc_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  salary_limit numeric,
  admin_approved_by int REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS js_sources (
  id serial PRIMARY KEY,
  key text NOT NULL UNIQUE,
  adapter text NOT NULL,
  status text NOT NULL DEFAULT 'requires_setup'
    CHECK (status IN ('connected','requires_setup','unavailable','manual')),
  schedule_cron text,
  rate_limit_per_min int,
  paused boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  last_run_at timestamptz
);

CREATE TABLE IF NOT EXISTS js_employers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  normalized_name text,
  domain text,
  verified_contact_email text,
  verified_endpoint text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS js_employers_norm_idx ON js_employers (normalized_name);

CREATE TABLE IF NOT EXISTS js_jobs (
  id serial PRIMARY KEY,
  url text,
  source_primary text,
  employer_id int REFERENCES js_employers(id),
  title text NOT NULL,
  location text,
  country text,
  published_at timestamptz,
  last_checked_at timestamptz,
  closing_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','expired','closed')),
  dedupe_key text NOT NULL UNIQUE,
  description_text text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS js_job_sightings (
  id serial PRIMARY KEY,
  job_id int NOT NULL REFERENCES js_jobs(id) ON DELETE CASCADE,
  source_id int NOT NULL REFERENCES js_sources(id) ON DELETE CASCADE,
  source_job_id text NOT NULL,
  url text,
  seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_job_id)
);

CREATE TABLE IF NOT EXISTS js_matches (
  id serial PRIMARY KEY,
  candidate_id int NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id int NOT NULL REFERENCES js_jobs(id) ON DELETE CASCADE,
  score int NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  uncertain jsonb NOT NULL DEFAULT '[]'::jsonb,
  employer_support text NOT NULL DEFAULT 'unknown'
    CHECK (employer_support IN ('confirmed','stated_in_ad','unknown','unavailable')),
  employer_support_evidence text,
  overseas_applicants_evidence text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, job_id)
);

CREATE TABLE IF NOT EXISTS js_applications (
  id serial PRIMARY KEY,
  candidate_id int NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id int NOT NULL REFERENCES js_jobs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'matched' CHECK (status IN (
    'matched','preparing','ready_for_review','approved','queued','sent','confirmed_submitted',
    'failed','outcome_unknown','needs_staff','cancelled','closed','interview','offer','rejected')),
  mode_at_creation text CHECK (mode_at_creation IN ('search_only','prepare_for_approval','automatic')),
  responsible_user_id int REFERENCES users(id),
  cover_letter_id int,
  cover_letter_text text,
  channel text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, job_id)
);

CREATE TABLE IF NOT EXISTS js_sharing_authorizations (
  id serial PRIMARY KEY,
  candidate_id int NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  document_id int,
  application_id int REFERENCES js_applications(id) ON DELETE CASCADE,
  legitimate_need text,
  granted_by int REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS js_application_documents (
  id serial PRIMARY KEY,
  application_id int NOT NULL REFERENCES js_applications(id) ON DELETE CASCADE,
  cv_file_id int REFERENCES js_cv_files(id),
  document_id int,
  version int NOT NULL DEFAULT 1,
  approved_by int REFERENCES users(id),
  approved_at timestamptz,
  sensitive boolean NOT NULL DEFAULT false,
  sharing_authorization_id int REFERENCES js_sharing_authorizations(id)
);

CREATE TABLE IF NOT EXISTS js_submissions (
  id serial PRIMARY KEY,
  application_id int NOT NULL REFERENCES js_applications(id) ON DELETE CASCADE,
  attempt_no int NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL UNIQUE,
  channel text,
  recipient text,
  provider_message_id text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','confirmed_submitted','failed','outcome_unknown')),
  evidence jsonb,
  sent_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS js_messages (
  id serial PRIMARY KEY,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  thread_ref text,
  message_id text,
  in_reply_to text,
  application_id int REFERENCES js_applications(id) ON DELETE SET NULL,
  from_addr text,
  to_addr text,
  subject text,
  match_confidence numeric,
  review_state text NOT NULL DEFAULT 'matched' CHECK (review_state IN ('matched','needs_review','resolved')),
  body_sanitized text,
  ai_summary text,
  draft_reply text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS js_messages_app_idx ON js_messages (application_id);

CREATE TABLE IF NOT EXISTS js_tasks (
  id serial PRIMARY KEY,
  application_id int REFERENCES js_applications(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT 'review',
  detail text,
  assigned_to int REFERENCES users(id),
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS js_timeline (
  id bigserial PRIMARY KEY,
  application_id int NOT NULL REFERENCES js_applications(id),
  actor text,
  event text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS js_audit_events (
  id bigserial PRIMARY KEY,
  actor text,
  action text NOT NULL,
  candidate_id int,
  application_id int,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION js_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is insert-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS js_timeline_insert_only ON js_timeline;
CREATE TRIGGER js_timeline_insert_only BEFORE UPDATE OR DELETE ON js_timeline
  FOR EACH ROW EXECUTE FUNCTION js_reject_mutation();
DROP TRIGGER IF EXISTS js_audit_events_insert_only ON js_audit_events;
CREATE TRIGGER js_audit_events_insert_only BEFORE UPDATE OR DELETE ON js_audit_events
  FOR EACH ROW EXECUTE FUNCTION js_reject_mutation();

CREATE TABLE IF NOT EXISTS js_runs (
  id serial PRIMARY KEY,
  source_id int REFERENCES js_sources(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  found int NOT NULL DEFAULT 0,
  new_count int NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS js_employer_confirmations (
  id serial PRIMARY KEY,
  employer_id int REFERENCES js_employers(id) ON DELETE CASCADE,
  application_id int REFERENCES js_applications(id) ON DELETE CASCADE,
  kind text,
  evidence_text text,
  confirmed_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS js_automation_rules (
  id serial PRIMARY KEY,
  candidate_id int REFERENCES candidates(id) ON DELETE CASCADE,
  rule jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by int REFERENCES users(id),
  approved_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS js_sandbox_mail (
  id serial PRIMARY KEY,
  to_addr text,
  from_addr text,
  subject text,
  body text,
  message_id text,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS js_events (
  id bigserial PRIMARY KEY,
  candidate_id int,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS js_events_candidate_idx ON js_events (candidate_id, id);

CREATE TABLE IF NOT EXISTS js_queue (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  idempotency_key text UNIQUE,
  last_error text
);
CREATE INDEX IF NOT EXISTS js_queue_due_idx ON js_queue (status, run_at);

CREATE TABLE IF NOT EXISTS js_appointments (
  id serial PRIMARY KEY,
  staff_user_id int NOT NULL REFERENCES users(id),
  candidate_id int NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  application_id int REFERENCES js_applications(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'tentative' CHECK (status IN ('tentative','confirmed','cancelled')),
  location text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'js_appointments_no_overlap'
                 AND conrelid = 'js_appointments'::regclass) THEN
    ALTER TABLE js_appointments ADD CONSTRAINT js_appointments_no_overlap
      EXCLUDE USING gist (staff_user_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
      WHERE (status <> 'cancelled');
  END IF;
END $$;
