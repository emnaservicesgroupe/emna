-- Stage 8 task 3: report snapshots (PDF / XLSX exports, Canada Job Search Activity Report, scheduled company reports). Additive and idempotent.
--
--  * js_report_snapshots is INSERT-ONLY: the numbers (payload) and the generated files are fixed at generation time and can be
--    neither updated nor deleted (same trigger as the other insert-only js_* tables). No foreign keys on purpose: a CASCADE / SET NULL
--    action would UPDATE or DELETE snapshot rows, which the trigger refuses. scope_candidate_id / generated_by are plain ids.
--  * generated_by NULL = created by the scheduler.
--  * payload_sha256 = SHA-256 of the canonical (sorted-key) JSON of payload, so a later reader can verify the stored numbers.
--  * pdf_key / xlsx_key are storage keys (private storage; never exposed to clients, downloads go through the authorised routes).
--  * The scheduler's daily / weekly / monthly company snapshots are unique per (kind, period_start): one per period, whatever
--    the number of processes or ticks.
--  * The module settings report_timezone / report_schedule_enabled live in js_module_state (key 'report_settings'); nothing to create here.
CREATE TABLE IF NOT EXISTS js_report_snapshots (
  id             bigserial PRIMARY KEY,
  kind           text NOT NULL,
  scope_candidate_id int,
  period_start   timestamptz NOT NULL,
  period_end     timestamptz NOT NULL,
  timezone       text NOT NULL,
  generated_by   int,
  generated_at   timestamptz NOT NULL DEFAULT now(),
  payload        jsonb NOT NULL,
  payload_sha256 text NOT NULL,
  pdf_key        text,
  xlsx_key       text
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_report_snapshots'::regclass AND conname = 'js_report_snapshots_kind_check') THEN
    ALTER TABLE js_report_snapshots ADD CONSTRAINT js_report_snapshots_kind_check CHECK (kind IN ('daily','weekly','monthly','custom','candidate_activity'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_report_snapshots'::regclass AND conname = 'js_report_snapshots_period_check') THEN
    ALTER TABLE js_report_snapshots ADD CONSTRAINT js_report_snapshots_period_check CHECK (period_end > period_start);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_report_snapshots'::regclass AND conname = 'js_report_snapshots_hash_check') THEN
    ALTER TABLE js_report_snapshots ADD CONSTRAINT js_report_snapshots_hash_check CHECK (payload_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
  -- a candidate activity report is about exactly one candidate; the scheduled company reports about none
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_report_snapshots'::regclass AND conname = 'js_report_snapshots_scope_check') THEN
    ALTER TABLE js_report_snapshots ADD CONSTRAINT js_report_snapshots_scope_check CHECK (
      (kind = 'candidate_activity' AND scope_candidate_id IS NOT NULL)
      OR (kind IN ('daily','weekly','monthly') AND scope_candidate_id IS NULL)
      OR kind = 'custom');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'js_report_snapshots'::regclass AND conname = 'js_report_snapshots_keys_check') THEN
    ALTER TABLE js_report_snapshots ADD CONSTRAINT js_report_snapshots_keys_check CHECK (
      (pdf_key IS NULL OR pdf_key ~ '^[0-9]+-[a-f0-9]{64}\.pdf$') AND (xlsx_key IS NULL OR xlsx_key ~ '^[0-9]+-[a-f0-9]{64}\.xlsx$'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS js_report_snapshots_period_uq ON js_report_snapshots (kind, period_start) WHERE kind IN ('daily','weekly','monthly');
CREATE INDEX IF NOT EXISTS js_report_snapshots_recent_idx ON js_report_snapshots (generated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS js_report_snapshots_candidate_idx ON js_report_snapshots (scope_candidate_id, generated_at DESC) WHERE scope_candidate_id IS NOT NULL;

DROP TRIGGER IF EXISTS js_report_snapshots_insert_only ON js_report_snapshots;
CREATE TRIGGER js_report_snapshots_insert_only BEFORE UPDATE OR DELETE ON js_report_snapshots
  FOR EACH ROW EXECUTE FUNCTION js_reject_mutation();
