-- Task 14: lookup indexes for dashboard/report/export/SSE queries and scheduler back-off lookups.
-- Idempotent (CREATE INDEX IF NOT EXISTS). Where an earlier migration already created the same index
-- the same name is reused, so these lines are no-ops there (js_applications(job_id) and
-- js_application_documents(application_id) from 007, js_events(candidate_id, id) from 002).
CREATE INDEX IF NOT EXISTS js_applications_job_idx ON js_applications (job_id);
CREATE INDEX IF NOT EXISTS js_applications_candidate_status_idx ON js_applications (candidate_id, status);
CREATE INDEX IF NOT EXISTS js_matches_job_idx ON js_matches (job_id);
CREATE INDEX IF NOT EXISTS js_matches_created_idx ON js_matches (created_at);
CREATE INDEX IF NOT EXISTS js_job_sightings_job_idx ON js_job_sightings (job_id);
CREATE INDEX IF NOT EXISTS js_submissions_application_idx ON js_submissions (application_id);
CREATE INDEX IF NOT EXISTS js_timeline_app_created_idx ON js_timeline (application_id, created_at);
CREATE INDEX IF NOT EXISTS js_tasks_application_idx ON js_tasks (application_id);
CREATE INDEX IF NOT EXISTS js_tasks_status_reason_idx ON js_tasks (status, reason);
CREATE INDEX IF NOT EXISTS js_application_documents_app_idx ON js_application_documents (application_id);
CREATE INDEX IF NOT EXISTS js_appointments_candidate_idx ON js_appointments (candidate_id);
CREATE INDEX IF NOT EXISTS js_appointments_application_idx ON js_appointments (application_id);
-- js_messages: provider id of sent follow-ups (inbound Message-ID / thread_ref already indexed in 008)
CREATE INDEX IF NOT EXISTS js_messages_provider_msgid_idx ON js_messages (provider_message_id);
CREATE INDEX IF NOT EXISTS js_audit_events_app_action_idx ON js_audit_events (application_id, action, created_at);
CREATE INDEX IF NOT EXISTS js_events_candidate_idx ON js_events (candidate_id, id);
CREATE INDEX IF NOT EXISTS js_events_audience_idx ON js_events (audience, id);
CREATE INDEX IF NOT EXISTS js_queue_status_kind_run_idx ON js_queue (status, kind, run_at);
CREATE INDEX IF NOT EXISTS js_runs_source_started_idx ON js_runs (source_id, started_at);
