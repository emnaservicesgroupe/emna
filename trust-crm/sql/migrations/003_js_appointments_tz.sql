-- js_appointments: keep the candidate-facing timezone and a title. Idempotent.
ALTER TABLE js_appointments ADD COLUMN IF NOT EXISTS tz text NOT NULL DEFAULT 'UTC';
ALTER TABLE js_appointments ADD COLUMN IF NOT EXISTS title text;
