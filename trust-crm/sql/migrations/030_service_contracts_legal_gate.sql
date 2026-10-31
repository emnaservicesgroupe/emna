-- Stage 8 task 6: service contracts and the legal-review gate for candidate fees. Additive and idempotent.
--
--  * fin_services.kind: 'standard' (default, nothing changes) or 'candidate_fee'. A candidate_fee service can only be invoiced when
--    the billing gate (modules/finance/billingGate.js) passes: an ACTIVE signed contract AND a current 'approved' legal review for the
--    candidate's jurisdiction. The platform RECORDS reviews; it gives no legal advice and preloads no package price.
--  * fin_legal_reviews: insert-only. A review is never edited; a newer row supersedes the older one (the latest row per
--    jurisdiction + service_kind, by reviewed_at then id, decides: view fin_legal_reviews_latest). UPDATE, DELETE and TRUNCATE are
--    rejected by trigger (reuses fin_reject_mutation from 016). recorded_by has NO foreign key on purpose: a SET NULL action
--    would UPDATE a review row.
--  * fin_service_contracts: one row per agreement between a candidate and a catalogue service. An 'active' contract must carry
--    agreement_signed_at; only one active contract per candidate + service.
ALTER TABLE fin_services ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'standard';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'fin_services'::regclass AND conname = 'fin_services_kind_check') THEN
    ALTER TABLE fin_services ADD CONSTRAINT fin_services_kind_check CHECK (kind IN ('standard','candidate_fee'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fin_legal_reviews (
  id bigserial PRIMARY KEY,
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  service_kind text NOT NULL DEFAULT 'candidate_fee' CHECK (service_kind ~ '^[a-z_]{1,40}$'),
  status text NOT NULL CHECK (status IN ('pending','approved','prohibited')),
  reviewer_name text NOT NULL CHECK (char_length(btrim(reviewer_name)) BETWEEN 1 AND 200),
  reviewer_role text CHECK (reviewer_role IS NULL OR char_length(reviewer_role) <= 200),
  reviewed_at date NOT NULL,
  valid_until date,
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  evidence_key text CHECK (evidence_key IS NULL OR char_length(evidence_key) <= 200),
  recorded_by int,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_legal_reviews_dates_check CHECK (valid_until IS NULL OR valid_until >= reviewed_at)
);
CREATE INDEX IF NOT EXISTS fin_legal_reviews_lookup_idx ON fin_legal_reviews (jurisdiction, service_kind, reviewed_at DESC, id DESC);

DROP TRIGGER IF EXISTS fin_legal_reviews_insert_only ON fin_legal_reviews;
CREATE TRIGGER fin_legal_reviews_insert_only BEFORE UPDATE OR DELETE ON fin_legal_reviews
  FOR EACH ROW EXECUTE FUNCTION fin_reject_mutation();
DROP TRIGGER IF EXISTS fin_legal_reviews_no_truncate ON fin_legal_reviews;
CREATE TRIGGER fin_legal_reviews_no_truncate BEFORE TRUNCATE ON fin_legal_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION fin_reject_mutation();

CREATE OR REPLACE VIEW fin_legal_reviews_latest AS
  SELECT DISTINCT ON (jurisdiction, service_kind) *
    FROM fin_legal_reviews
   ORDER BY jurisdiction, service_kind, reviewed_at DESC, id DESC;

CREATE TABLE IF NOT EXISTS fin_service_contracts (
  id bigserial PRIMARY KEY,
  candidate_id int NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  service_id bigint NOT NULL REFERENCES fin_services(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','ended','cancelled')),
  agreement_signed_at timestamptz,
  signed_document_key text CHECK (signed_document_key IS NULL OR char_length(signed_document_key) <= 200),
  signed_by_name text CHECK (signed_by_name IS NULL OR char_length(btrim(signed_by_name)) BETWEEN 1 AND 200),
  start_date date,
  end_date date,
  refund_terms text CHECK (refund_terms IS NULL OR char_length(refund_terms) <= 2000),
  created_by int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_service_contracts_dates_check CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  CONSTRAINT fin_service_contracts_active_signed_check CHECK (status <> 'active' OR agreement_signed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS fin_service_contracts_candidate_idx ON fin_service_contracts (candidate_id, status);
CREATE INDEX IF NOT EXISTS fin_service_contracts_service_idx ON fin_service_contracts (service_id);
CREATE UNIQUE INDEX IF NOT EXISTS fin_service_contracts_one_active_uq ON fin_service_contracts (candidate_id, service_id) WHERE status = 'active';
