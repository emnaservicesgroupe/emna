-- Application packages: exact document versions + hashes, removal (revocation) markers, and the
-- per-application package state (requested docs, blocked docs, notes, letter language). Idempotent.
ALTER TABLE js_application_documents ADD COLUMN IF NOT EXISTS doc_type text;
ALTER TABLE js_application_documents ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE js_application_documents ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE js_application_documents ADD COLUMN IF NOT EXISTS source_ref text;
ALTER TABLE js_application_documents ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE js_application_documents ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE js_application_documents ADD COLUMN IF NOT EXISTS removed_reason text;
CREATE INDEX IF NOT EXISTS js_application_documents_app_idx ON js_application_documents (application_id);

ALTER TABLE js_applications ADD COLUMN IF NOT EXISTS cover_letter_lang text;
ALTER TABLE js_applications ADD COLUMN IF NOT EXISTS job_language text;
ALTER TABLE js_applications ADD COLUMN IF NOT EXISTS package_requested jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE js_applications ADD COLUMN IF NOT EXISTS package_blocked jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE js_applications ADD COLUMN IF NOT EXISTS package_notes jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS js_applications_status_idx ON js_applications (status);
CREATE INDEX IF NOT EXISTS js_applications_created_idx ON js_applications (created_at);
CREATE INDEX IF NOT EXISTS js_applications_job_idx ON js_applications (job_id);

CREATE INDEX IF NOT EXISTS js_sharing_authorizations_app_idx ON js_sharing_authorizations (application_id, document_id);
CREATE INDEX IF NOT EXISTS js_timeline_app_idx ON js_timeline (application_id, id);
