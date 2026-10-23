-- Matching: job-scoped / revocable employer confirmations; stored overseas + conflict flags on matches. Idempotent.
-- A confirmation with job_id NULL is employer-wide (all jobs of that employer); with job_id it is that job only.
ALTER TABLE js_employer_confirmations ADD COLUMN IF NOT EXISTS job_id int REFERENCES js_jobs(id) ON DELETE CASCADE;
ALTER TABLE js_employer_confirmations ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE js_employer_confirmations ADD COLUMN IF NOT EXISTS revoked_by int;
CREATE INDEX IF NOT EXISTS js_employer_confirmations_job_idx ON js_employer_confirmations (job_id);
CREATE INDEX IF NOT EXISTS js_employer_confirmations_employer_idx ON js_employer_confirmations (employer_id);
ALTER TABLE js_matches ADD COLUMN IF NOT EXISTS overseas_accepted boolean;
ALTER TABLE js_matches ADD COLUMN IF NOT EXISTS employer_support_conflict boolean NOT NULL DEFAULT false;
