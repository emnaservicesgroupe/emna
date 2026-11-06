-- Stage 8 task 5: vacancy classification with quoted evidence, match bands, match accept/reject, job detail fields. Additive and idempotent.
--
--  * js_jobs.classification is one of six values or NULL (not yet classified). It is derived in code from real signals (status, closing
--    date, the employer-support label with its quote, the ad text, the source) and stored; a staff classification sets classified_by and is
--    then never overwritten by a recompute (classified_by has no foreign key on purpose: deleting a user must not silently hand the job
--    back to the automatic rules). foreign_applicants_stated can never exist without a non-empty evidence string (CHECK): the label is
--    informational and the quote is never proof of an LMIA or of sponsorship.
--  * js_jobs gains salary_text, employment_type, required_experience_text and closing_date (plain facts from the source, all nullable).
--  * js_matches.band is strong | good | manual_review | not_recommended (85 / 70 / 50 boundaries and the essential vetoes are applied in code).
--    Existing rows get a conservative band from their score; a row that already lists missing requirements is never backfilled above
--    manual_review. The next match run rewrites every band.
--  * js_matches.decision is the staff accept/reject of a match (pending by default); decision_note is staff-only.
ALTER TABLE js_jobs ADD COLUMN IF NOT EXISTS classification text;
ALTER TABLE js_jobs ADD COLUMN IF NOT EXISTS classification_evidence text;
ALTER TABLE js_jobs ADD COLUMN IF NOT EXISTS classified_by int;
ALTER TABLE js_jobs ADD COLUMN IF NOT EXISTS classified_at timestamptz;
ALTER TABLE js_jobs ADD COLUMN IF NOT EXISTS salary_text text;
ALTER TABLE js_jobs ADD COLUMN IF NOT EXISTS employment_type text;
ALTER TABLE js_jobs ADD COLUMN IF NOT EXISTS required_experience_text text;
ALTER TABLE js_jobs ADD COLUMN IF NOT EXISTS closing_date date;

ALTER TABLE js_matches ADD COLUMN IF NOT EXISTS band text;
ALTER TABLE js_matches ADD COLUMN IF NOT EXISTS decision text NOT NULL DEFAULT 'pending';
ALTER TABLE js_matches ADD COLUMN IF NOT EXISTS decision_by int;
ALTER TABLE js_matches ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE js_matches ADD COLUMN IF NOT EXISTS decision_note text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_jobs'::regclass AND conname = 'js_jobs_classification_check') THEN
    ALTER TABLE js_jobs ADD CONSTRAINT js_jobs_classification_check
      CHECK (classification IS NULL OR classification IN ('verified_active','foreign_applicants_stated','eligibility_unclear','work_authorization_required','prospective_no_vacancy','closed_unsuitable'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_jobs'::regclass AND conname = 'js_jobs_classification_evidence_len') THEN
    ALTER TABLE js_jobs ADD CONSTRAINT js_jobs_classification_evidence_len
      CHECK (classification_evidence IS NULL OR char_length(classification_evidence) <= 500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_jobs'::regclass AND conname = 'js_jobs_foreign_needs_evidence') THEN
    ALTER TABLE js_jobs ADD CONSTRAINT js_jobs_foreign_needs_evidence
      CHECK (classification IS DISTINCT FROM 'foreign_applicants_stated' OR btrim(coalesce(classification_evidence, '')) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_matches'::regclass AND conname = 'js_matches_band_check') THEN
    ALTER TABLE js_matches ADD CONSTRAINT js_matches_band_check
      CHECK (band IS NULL OR band IN ('strong','good','manual_review','not_recommended'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_matches'::regclass AND conname = 'js_matches_decision_check') THEN
    ALTER TABLE js_matches ADD CONSTRAINT js_matches_decision_check
      CHECK (decision IN ('pending','accepted','rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_matches'::regclass AND conname = 'js_matches_decision_note_len') THEN
    ALTER TABLE js_matches ADD CONSTRAINT js_matches_decision_note_len
      CHECK (decision_note IS NULL OR char_length(decision_note) <= 500);
  END IF;
END $$;

-- Conservative backfill (idempotent: only rows without a band). A requirement listed under `missing` caps the band at manual_review.
UPDATE js_matches SET band = CASE
    WHEN score < 50 THEN 'not_recommended'
    WHEN jsonb_array_length(COALESCE(missing, '[]'::jsonb)) > 0 THEN 'manual_review'
    WHEN score >= 85 THEN 'strong'
    WHEN score >= 70 THEN 'good'
    ELSE 'manual_review'
  END
 WHERE band IS NULL;

CREATE INDEX IF NOT EXISTS js_jobs_classification_idx ON js_jobs (classification) WHERE classification IS NOT NULL;
