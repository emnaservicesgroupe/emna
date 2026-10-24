-- Stage 3: employer and agency portals. Additive and idempotent; existing rows are never rewritten.

-- users.role also allows 'Employer' and 'Agency' (same replace-the-check pattern as migration 001).
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT s.conname
    FROM (SELECT con.conname, con.oid FROM pg_constraint con
           WHERE con.contype = 'c' AND con.conrelid = to_regclass('users') OFFSET 0) s
    WHERE pg_get_constraintdef(s.oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('SuperAdmin','Admin','Manager','Receptionist','Accountant','HR','Agent','Candidate','Employer','Agency'));

-- Partner agencies.
CREATE TABLE IF NOT EXISTS crm_agencies (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  contact_name text,
  email text,
  phone text,
  country text,
  status text NOT NULL DEFAULT 'active',
  notes text,
  created_by int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_agencies_status_check' AND conrelid = 'crm_agencies'::regclass) THEN
    ALTER TABLE crm_agencies ADD CONSTRAINT crm_agencies_status_check CHECK (status IN ('active','suspended'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_agencies_name_check' AND conrelid = 'crm_agencies'::regclass) THEN
    ALTER TABLE crm_agencies ADD CONSTRAINT crm_agencies_name_check CHECK (btrim(name) <> '' AND length(name) <= 200);
  END IF;
  -- crm_employers.status already exists (stage 2, default 'new', unused). NOT VALID: new writes are checked,
  -- existing rows are not rewritten or rejected.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_employers_status_check' AND conrelid = 'crm_employers'::regclass) THEN
    ALTER TABLE crm_employers ADD CONSTRAINT crm_employers_status_check
      CHECK (status IN ('new','active','suspended','inactive')) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS crm_agencies_status_idx ON crm_agencies (status);

-- Link of a portal user to exactly one organisation (org_id is polymorphic on org_type, so no FK).
CREATE TABLE IF NOT EXISTS crm_org_accounts (
  user_id int PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  org_type text NOT NULL,
  org_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_org_accounts_type_check' AND conrelid = 'crm_org_accounts'::regclass) THEN
    ALTER TABLE crm_org_accounts ADD CONSTRAINT crm_org_accounts_type_check CHECK (org_type IN ('employer','agency'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS crm_org_accounts_org_idx ON crm_org_accounts (org_type, org_id);

-- Agency-registered candidates/leads.
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS agency_id bigint REFERENCES crm_agencies(id) ON DELETE SET NULL;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS agency_id bigint REFERENCES crm_agencies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS candidates_agency_idx ON candidates (agency_id) WHERE agency_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_leads_agency_idx ON crm_leads (agency_id) WHERE agency_id IS NOT NULL;

-- Employer recruitment requests.
CREATE TABLE IF NOT EXISTS employer_requests (
  id bigserial PRIMARY KEY,
  employer_id bigint NOT NULL REFERENCES crm_employers(id),
  title text NOT NULL,
  positions int NOT NULL DEFAULT 1,
  country text,
  city text,
  category text,
  description text,
  requirements text,
  salary_text text,
  start_date date,
  status text NOT NULL DEFAULT 'submitted',
  staff_note text,
  employer_visible_note text,
  site_job_id bigint REFERENCES site_jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employer_requests_status_check' AND conrelid = 'employer_requests'::regclass) THEN
    ALTER TABLE employer_requests ADD CONSTRAINT employer_requests_status_check
      CHECK (status IN ('submitted','in_review','accepted','declined','filled','cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employer_requests_positions_check' AND conrelid = 'employer_requests'::regclass) THEN
    ALTER TABLE employer_requests ADD CONSTRAINT employer_requests_positions_check CHECK (positions BETWEEN 1 AND 1000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employer_requests_title_check' AND conrelid = 'employer_requests'::regclass) THEN
    ALTER TABLE employer_requests ADD CONSTRAINT employer_requests_title_check CHECK (btrim(title) <> '' AND length(title) <= 160);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employer_requests_text_check' AND conrelid = 'employer_requests'::regclass) THEN
    ALTER TABLE employer_requests ADD CONSTRAINT employer_requests_text_check
      CHECK (length(coalesce(description, '')) <= 8000 AND length(coalesce(requirements, '')) <= 8000);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS employer_requests_employer_idx ON employer_requests (employer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS employer_requests_status_idx ON employer_requests (status, created_at DESC);

-- Candidates shown to an employer. summary is the frozen, allowlisted snapshot taken at presentation time.
CREATE TABLE IF NOT EXISTS employer_presentations (
  id bigserial PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES employer_requests(id),
  candidate_id int NOT NULL REFERENCES candidates(id),
  presented_by int REFERENCES users(id) ON DELETE SET NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  staff_note_for_employer text,
  status text NOT NULL DEFAULT 'presented',
  employer_note text,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employer_presentations_request_candidate_uniq UNIQUE (request_id, candidate_id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employer_presentations_status_check' AND conrelid = 'employer_presentations'::regclass) THEN
    ALTER TABLE employer_presentations ADD CONSTRAINT employer_presentations_status_check
      CHECK (status IN ('presented','interested','interview','not_suitable','withdrawn'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employer_presentations_summary_check' AND conrelid = 'employer_presentations'::regclass) THEN
    ALTER TABLE employer_presentations ADD CONSTRAINT employer_presentations_summary_check CHECK (jsonb_typeof(summary) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS employer_presentations_candidate_idx ON employer_presentations (candidate_id);

-- Staff-attested candidate consent to share a limited summary with one employer; withdrawable.
CREATE TABLE IF NOT EXISTS candidate_share_consents (
  id bigserial PRIMARY KEY,
  candidate_id int NOT NULL REFERENCES candidates(id),
  employer_id bigint NOT NULL REFERENCES crm_employers(id),
  basis text NOT NULL,
  recorded_by int REFERENCES users(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'candidate_share_consents_basis_check' AND conrelid = 'candidate_share_consents'::regclass) THEN
    ALTER TABLE candidate_share_consents ADD CONSTRAINT candidate_share_consents_basis_check CHECK (btrim(basis) <> '' AND length(basis) <= 1000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'candidate_share_consents_withdrawn_check' AND conrelid = 'candidate_share_consents'::regclass) THEN
    ALTER TABLE candidate_share_consents ADD CONSTRAINT candidate_share_consents_withdrawn_check
      CHECK (withdrawn_at IS NULL OR withdrawn_at >= recorded_at);
  END IF;
END $$;

-- At most one ACTIVE consent per (candidate, employer); withdrawn history may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS candidate_share_consents_active_uniq
  ON candidate_share_consents (candidate_id, employer_id) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS candidate_share_consents_employer_idx ON candidate_share_consents (employer_id);

-- Timeline entities (012 replaced the 011 check; same pattern).
ALTER TABLE crm_timeline DROP CONSTRAINT IF EXISTS crm_timeline_entity_check;
ALTER TABLE crm_timeline ADD CONSTRAINT crm_timeline_entity_check
  CHECK (entity IN ('lead','candidate','employer','site_job','employer_request','agency','presentation','share_consent'));
