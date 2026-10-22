CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Replace the users.role check so it also allows 'Candidate'.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.contype = 'c'
      AND con.conrelid = to_regclass('users')
      AND pg_get_constraintdef(con.oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('SuperAdmin','Admin','Manager','Receptionist','Accountant','HR','Agent','Candidate'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version int NOT NULL DEFAULT 0;

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS phone text;
