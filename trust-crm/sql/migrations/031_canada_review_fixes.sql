-- Canada service layer, review round 1. Additive and idempotent.
--
--  1. fin_legal_reviews_latest now orders by RECORDING order (id DESC): the review recorded last decides, whatever date it carries.
--     reviewed_at stays informational (the date of the lawyer's opinion). Before, a later-recorded but back-dated 'prohibited' review was
--     masked by an older 'approved' one.
--  2. fin_service_contracts.jurisdiction: the jurisdiction (e.g. CA-QC) whose legal review covers THIS contract, set by staff at signing.
--     NULL only for contracts that were signed before this migration (the gate then falls back to the candidate's province).
--  3. js_report_snapshots: still insert-only (UPDATE is always rejected), but DELETE is accepted inside a transaction that set
--     `SET LOCAL vita.snapshot_erasure = 'on'`. Only the erasure service and the retention purge do that; they also remove the stored files.
CREATE OR REPLACE VIEW fin_legal_reviews_latest AS
  SELECT DISTINCT ON (jurisdiction, service_kind) *
    FROM fin_legal_reviews
   ORDER BY jurisdiction, service_kind, id DESC;
CREATE INDEX IF NOT EXISTS fin_legal_reviews_recorded_idx ON fin_legal_reviews (jurisdiction, service_kind, id DESC);

ALTER TABLE fin_service_contracts ADD COLUMN IF NOT EXISTS jurisdiction text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'fin_service_contracts'::regclass AND conname = 'fin_service_contracts_jurisdiction_check') THEN
    ALTER TABLE fin_service_contracts ADD CONSTRAINT fin_service_contracts_jurisdiction_check CHECK (jurisdiction IS NULL OR jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION js_report_snapshots_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND COALESCE(current_setting('vita.snapshot_erasure', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is insert-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS js_report_snapshots_insert_only ON js_report_snapshots;
CREATE TRIGGER js_report_snapshots_insert_only BEFORE UPDATE OR DELETE ON js_report_snapshots
  FOR EACH ROW EXECUTE FUNCTION js_report_snapshots_guard();
