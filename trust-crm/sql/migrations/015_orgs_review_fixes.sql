-- Stage 3 review round 1. Additive and idempotent.

-- 1. Bind each presentation to the exact share consent it was made under. Employer reads join on this consent and
--    require it to be un-withdrawn, so a later NEW consent for the same (candidate, employer) never revives it.
ALTER TABLE employer_presentations ADD COLUMN IF NOT EXISTS consent_id bigint REFERENCES candidate_share_consents(id);
CREATE INDEX IF NOT EXISTS employer_presentations_consent_idx ON employer_presentations (consent_id) WHERE consent_id IS NOT NULL;

-- Backfill: the latest consent for (candidate, employer) recorded at or before the presentation.
UPDATE employer_presentations p
   SET consent_id = (
         SELECT sc.id
           FROM candidate_share_consents sc
           JOIN employer_requests r ON r.id = p.request_id
          WHERE sc.candidate_id = p.candidate_id
            AND sc.employer_id = r.employer_id
            AND sc.recorded_at <= p.created_at
          ORDER BY sc.recorded_at DESC, sc.id DESC
          LIMIT 1)
 WHERE p.consent_id IS NULL;

-- 2. crm_employers.status: normalise values outside the allowed set, then validate the NOT VALID constraint from 013.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_employers_status_check' AND conrelid = 'crm_employers'::regclass AND NOT convalidated) THEN
    UPDATE crm_employers SET status = 'new' WHERE status IS NULL OR status NOT IN ('new','active','suspended','inactive');
    ALTER TABLE crm_employers VALIDATE CONSTRAINT crm_employers_status_check;
  END IF;
END $$;

-- 3. 013 replaced every users CHECK whose definition mentions "role". Make sure the role check is present and
--    complete (recreated only if missing or stale); no other users constraint is touched here.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'users_role_check' AND conrelid = to_regclass('users')
       AND pg_get_constraintdef(oid) LIKE '%Employer%' AND pg_get_constraintdef(oid) LIKE '%Agency%'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('SuperAdmin','Admin','Manager','Receptionist','Accountant','HR','Agent','Candidate','Employer','Agency'));
  END IF;
END $$;
