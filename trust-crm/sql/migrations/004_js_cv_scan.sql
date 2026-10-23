-- js_cv_files: record the malware-scan outcome of each stored original. Idempotent.
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS scan_status text NOT NULL DEFAULT 'scan_unavailable'
  CHECK (scan_status IN ('clean','infected','scan_unavailable'));
ALTER TABLE js_cv_files ADD COLUMN IF NOT EXISTS scan_detail text;
