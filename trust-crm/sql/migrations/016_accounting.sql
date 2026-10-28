-- Stage 4: accounting (services catalogue, numbered invoices with line items, payments/receipts, refunds, voids,
-- expense categories, insert-only ledger). Additive and idempotent: legacy invoices/payments/expenses rows are
-- never rewritten, new columns on them are nullable, no ledger backfill (see docs/vita-accounting/CHECKLIST.md,
-- "fin_opening"). Money is NUMERIC; amounts are never converted between currencies.

-- 1. Services catalogue ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fin_services (
  id bigserial PRIMARY KEY,
  code text NOT NULL CHECK (char_length(btrim(code)) BETWEEN 1 AND 40),
  name_ar text,
  name_en text,
  name_fr text,
  default_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (default_price >= 0),
  currency text NOT NULL DEFAULT 'TND' CHECK (currency ~ '^[A-Z]{3}$'),
  active boolean NOT NULL DEFAULT true,
  created_by int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_services_name_check CHECK (
    char_length(btrim(coalesce(name_ar,''))) > 0 OR char_length(btrim(coalesce(name_en,''))) > 0 OR char_length(btrim(coalesce(name_fr,''))) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_services_code_uq ON fin_services (code);

-- 2. Counters (one row per key, e.g. 'invoice-2026', locked by the service while numbering) ----------------------------
CREATE TABLE IF NOT EXISTS fin_counters (
  key text PRIMARY KEY,
  value bigint NOT NULL DEFAULT 0 CHECK (value >= 0)
);

-- 3. Expense categories ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expense_categories (
  id bigserial PRIMARY KEY,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_name_uq ON expense_categories (lower(name));

-- 4. New nullable columns on the legacy tables -------------------------------------------------------------------------
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS number text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issued_at timestamptz;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS void_reason text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal numeric(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_amount numeric(12,2) DEFAULT 0;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_number text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category_id bigint REFERENCES expense_categories(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payee text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS void_reason text;

-- 5. Invoice line items ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_items (
  id bigserial PRIMARY KEY,
  invoice_id int NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  service_id bigint REFERENCES fin_services(id) ON DELETE SET NULL,
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 300),
  quantity numeric(10,2) NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  -- computed in SQL, round half up to 2dp (numeric rounds half away from zero; values here are never negative)
  line_total numeric(12,2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  position int NOT NULL DEFAULT 0
);

-- 6. Refunds -----------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fin_refunds (
  id bigserial PRIMARY KEY,
  payment_id int NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id int NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) > 0),
  created_by int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A refund can never exceed what is left of the payment (amount_paid minus earlier refunds). The payment row is
-- locked so two parallel refunds cannot both pass the check.
CREATE OR REPLACE FUNCTION fin_refund_bound() RETURNS trigger AS $$
DECLARE
  paid numeric;
  refunded numeric;
BEGIN
  SELECT amount_paid INTO paid FROM payments WHERE id = NEW.payment_id FOR UPDATE;
  IF paid IS NULL THEN
    RAISE EXCEPTION 'refund payment % not found', NEW.payment_id;
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO refunded FROM fin_refunds WHERE payment_id = NEW.payment_id;
  IF refunded + NEW.amount > paid THEN
    RAISE EXCEPTION 'refund exceeds payment net (paid %, already refunded %, requested %)', paid, refunded, NEW.amount;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fin_refunds_bound ON fin_refunds;
CREATE TRIGGER fin_refunds_bound BEFORE INSERT ON fin_refunds
  FOR EACH ROW EXECUTE FUNCTION fin_refund_bound();

-- 7. Ledger (insert-only). No foreign keys on purpose: a SET NULL / CASCADE action would UPDATE/DELETE ledger rows
-- and be rejected by the trigger, which would make deleting a user or candidate impossible.
CREATE TABLE IF NOT EXISTS fin_ledger (
  id bigserial PRIMARY KEY,
  entry_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('invoice','payment','refund','void','expense')),
  ref_table text NOT NULL,
  ref_id bigint NOT NULL,
  candidate_id bigint,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  debit numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  actor_id bigint
);

CREATE OR REPLACE FUNCTION fin_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is insert-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fin_ledger_insert_only ON fin_ledger;
CREATE TRIGGER fin_ledger_insert_only BEFORE UPDATE OR DELETE ON fin_ledger
  FOR EACH ROW EXECUTE FUNCTION fin_reject_mutation();
DROP TRIGGER IF EXISTS fin_ledger_no_truncate ON fin_ledger;
CREATE TRIGGER fin_ledger_no_truncate BEFORE TRUNCATE ON fin_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION fin_reject_mutation();

-- 8. CHECK constraints on the legacy tables. Added NOT VALID (enforced for every new/changed row, existing rows are
-- not scanned or rejected) and VALIDATEd only when all existing rows already conform; otherwise they stay NOT VALID
-- and a later re-run validates them once the data has been corrected. Nothing is rewritten here.
DO $$
DECLARE
  c record;
  bad boolean;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('invoices', 'invoices_status_check',      $d$status IN ('Draft','Pending','Partial','Paid','Void','Refunded')$d$),
    ('invoices', 'invoices_currency_check',    $d$currency ~ '^[A-Z]{3}$'$d$),
    ('invoices', 'invoices_tax_check',         $d$tax_amount >= 0$d$),
    ('invoices', 'invoices_subtotal_check',    $d$subtotal >= 0$d$),
    ('invoices', 'invoices_void_reason_check', $d$voided_at IS NULL OR char_length(btrim(coalesce(void_reason,''))) > 0$d$),
    ('payments', 'payments_method_check',      $d$payment_method IN ('cash','bank_transfer','card','mobile','cheque','other')$d$),
    ('payments', 'payments_void_reason_check',$d$voided_at IS NULL OR char_length(btrim(coalesce(void_reason,''))) > 0$d$),
    ('expenses', 'expenses_currency_check',    $d$currency ~ '^[A-Z]{3}$'$d$),
    ('expenses', 'expenses_void_reason_check', $d$voided_at IS NULL OR char_length(btrim(coalesce(void_reason,''))) > 0$d$)
  ) AS t(tbl, cname, def)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.cname AND conrelid = to_regclass(c.tbl)) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', c.tbl, c.cname, c.def);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.cname AND conrelid = to_regclass(c.tbl) AND NOT convalidated) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE NOT COALESCE((%s), true))', c.tbl, c.def) INTO bad;
      IF NOT bad THEN
        EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c.tbl, c.cname);
      END IF;
    END IF;
  END LOOP;
END $$;

-- 9. Indexes -----------------------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS invoices_number_uq ON invoices (number) WHERE number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payments_receipt_number_uq ON payments (receipt_number) WHERE receipt_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payments_invoice_idem_uq ON payments (invoice_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_candidate_idx ON invoices (candidate_id);
CREATE INDEX IF NOT EXISTS invoices_due_open_idx ON invoices (due_date) WHERE is_deleted = false AND voided_at IS NULL AND remaining_amount > 0;
CREATE INDEX IF NOT EXISTS payments_candidate_idx ON payments (candidate_id);
CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON invoice_items (invoice_id, position);
CREATE INDEX IF NOT EXISTS invoice_items_service_idx ON invoice_items (service_id) WHERE service_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_refunds_payment_idx ON fin_refunds (payment_id);
CREATE INDEX IF NOT EXISTS fin_refunds_invoice_idx ON fin_refunds (invoice_id);
CREATE INDEX IF NOT EXISTS expenses_category_idx ON expenses (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expenses_spent_on_idx ON expenses (spent_on);
CREATE INDEX IF NOT EXISTS fin_ledger_candidate_idx ON fin_ledger (candidate_id, entry_at) WHERE candidate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_ledger_ref_idx ON fin_ledger (ref_table, ref_id);
CREATE INDEX IF NOT EXISTS fin_ledger_entry_at_idx ON fin_ledger (entry_at);
