-- Application-scoped confirmations written before 005 carry only application_id. Give them the job
-- (and employer) of that application so job-scoped matching picks them up. Idempotent.
UPDATE js_employer_confirmations c
   SET job_id = a.job_id,
       employer_id = COALESCE(c.employer_id, j.employer_id)
  FROM js_applications a
  JOIN js_jobs j ON j.id = a.job_id
 WHERE c.application_id = a.id
   AND c.job_id IS NULL
   AND c.employer_id IS NULL;
