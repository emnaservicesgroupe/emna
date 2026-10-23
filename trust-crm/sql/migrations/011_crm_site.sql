-- Migration 011: public website + CRM core (leads, timeline, employers, site jobs, public rate limit).
-- Additive and idempotent: new tables/indexes only, plus one defaulted column on candidates.
-- Does not touch any js_* table or existing candidate data.

CREATE TABLE IF NOT EXISTS crm_leads (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  name text NOT NULL,
  email text,
  phone text,
  country text,
  profession text,
  company text,
  message text,
  lang text,
  consent_at timestamptz,
  consent_text_version text,
  source text,
  ip_hash text,
  dedupe_key text,
  assigned_to int REFERENCES users(id) ON DELETE SET NULL,
  candidate_id int REFERENCES candidates(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_leads_kind_check' AND conrelid = 'crm_leads'::regclass) THEN
    ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_kind_check CHECK (kind IN ('candidate','employer','contact'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_leads_status_check' AND conrelid = 'crm_leads'::regclass) THEN
    ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_status_check
      CHECK (status IN ('new','contacted','qualified','converted','rejected','spam'));
  END IF;
END $$;

-- One live lead per service-computed dedupe key; spam rows are kept for audit and never collide.
CREATE UNIQUE INDEX IF NOT EXISTS crm_leads_dedupe_uniq ON crm_leads (dedupe_key) WHERE status <> 'spam';
CREATE INDEX IF NOT EXISTS crm_leads_status_created_idx ON crm_leads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_leads_assigned_idx ON crm_leads (assigned_to);
CREATE INDEX IF NOT EXISTS crm_leads_candidate_idx ON crm_leads (candidate_id);
CREATE INDEX IF NOT EXISTS crm_leads_email_idx ON crm_leads (lower(email));

-- Insert-only notes/stage history for leads, candidates and employers (polymorphic entity, so no FK:
-- rows must survive deletes of the parent and the insert-only trigger forbids cascades).
CREATE TABLE IF NOT EXISTS crm_timeline (
  id bigserial PRIMARY KEY,
  entity text NOT NULL,
  entity_id bigint NOT NULL,
  actor_id int REFERENCES users(id) ON DELETE SET NULL,
  event text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_timeline_entity_check' AND conrelid = 'crm_timeline'::regclass) THEN
    ALTER TABLE crm_timeline ADD CONSTRAINT crm_timeline_entity_check CHECK (entity IN ('lead','candidate','employer'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS crm_timeline_entity_idx ON crm_timeline (entity, entity_id, created_at);
CREATE INDEX IF NOT EXISTS crm_timeline_actor_idx ON crm_timeline (actor_id);

CREATE OR REPLACE FUNCTION crm_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is insert-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS crm_timeline_insert_only ON crm_timeline;
CREATE TRIGGER crm_timeline_insert_only BEFORE UPDATE OR DELETE ON crm_timeline
  FOR EACH ROW EXECUTE FUNCTION crm_reject_mutation();

-- Employer-side CRM records (separate from js_employers, which are job-source employers).
CREATE TABLE IF NOT EXISTS crm_employers (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  contact_name text,
  email text,
  phone text,
  country text,
  sector text,
  status text NOT NULL DEFAULT 'new',
  notes text,
  created_from_lead bigint REFERENCES crm_leads(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_employers_lead_idx ON crm_employers (created_from_lead);

-- Staff-authored public job offers. evidence_note (where the offer came from) is required to publish
-- (enforced by the service layer).
CREATE TABLE IF NOT EXISTS site_jobs (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  employer_name text,
  country text,
  city text,
  category text,
  description text,
  requirements text,
  language_requirements text,
  employment_type text,
  salary_text text,
  apply_mode text,
  evidence_note text,
  status text NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  closes_at timestamptz,
  created_by int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_jobs_status_check' AND conrelid = 'site_jobs'::regclass) THEN
    ALTER TABLE site_jobs ADD CONSTRAINT site_jobs_status_check CHECK (status IN ('draft','published','closed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS site_jobs_status_published_idx ON site_jobs (status, published_at DESC);
CREATE INDEX IF NOT EXISTS site_jobs_created_by_idx ON site_jobs (created_by);

-- DB-backed rate limiting for public endpoints (survives restarts).
CREATE TABLE IF NOT EXISTS public_rate_limit (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count int NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX IF NOT EXISTS public_rate_limit_window_idx ON public_rate_limit (window_start);

-- Candidate pipeline stage (history lives in crm_timeline). Constant default: no table rewrite, existing rows read 'lead'.
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS crm_stage text NOT NULL DEFAULT 'lead';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'candidates_crm_stage_check' AND conrelid = 'candidates'::regclass) THEN
    ALTER TABLE candidates ADD CONSTRAINT candidates_crm_stage_check
      CHECK (crm_stage IN ('lead','documents','submitted','interview','visa','travel','closed'));
  END IF;
END $$;
