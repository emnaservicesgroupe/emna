-- Accounting review round 1. Idempotent: every statement below only touches rows that still need it, so re-running it
-- (or running it on a fresh database) changes nothing. Migration 016 is not edited.
--
-- 1. Legacy data normalisation. 016 added CHECK constraints NOT VALID, which Postgres still enforces on every UPDATE of
--    an existing row, so a legacy row with payment_method 'Cash' or currency 'tnd' could not be voided, refunded or paid.
--    Normalise what can be normalised without guessing:
--      payments.payment_method : lower(btrim()), runs of spaces/hyphens -> '_', mapped to the allowed list, else 'other'
--      invoices.currency / expenses.currency : upper(btrim()) when that gives exactly three letters A-Z
--    A currency that is still not three letters (for example 'TN') is left exactly as it is; the API answers 409 for such
--    a record until the owner corrects it. Only the single column is written: no updated_at, no other value changes.
--    A row that also violates another NOT VALID rule (for example the old status 'Unpaid') cannot be UPDATEd at all, so it
--    is skipped here (savepoint per row) and picked up by a later run once that value has been corrected.
DO $$
DECLARE
  r record;
  fixed text;
BEGIN
  FOR r IN
    SELECT id, payment_method,
           CASE WHEN norm IN ('cash','bank_transfer','card','mobile','cheque','other') THEN norm ELSE 'other' END AS fixed
      FROM (SELECT id, payment_method, regexp_replace(lower(btrim(payment_method)), '[[:space:]-]+', '_', 'g') AS norm FROM payments) x
     WHERE payment_method NOT IN ('cash','bank_transfer','card','mobile','cheque','other')
  LOOP
    BEGIN
      UPDATE payments SET payment_method = r.fixed WHERE id = r.id;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;

  FOR r IN SELECT id, upper(btrim(currency)) AS fixed FROM invoices WHERE currency !~ '^[A-Z]{3}$' AND upper(btrim(currency)) ~ '^[A-Z]{3}$' LOOP
    BEGIN
      UPDATE invoices SET currency = r.fixed WHERE id = r.id;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;

  FOR r IN SELECT id, upper(btrim(currency)) AS fixed FROM expenses WHERE currency !~ '^[A-Z]{3}$' AND upper(btrim(currency)) ~ '^[A-Z]{3}$' LOOP
    BEGIN
      UPDATE expenses SET currency = r.fixed WHERE id = r.id;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;
END $$;

-- 2. Validate the NOT VALID constraints of 016 that now conform (guarded exactly as 016 does; the ones that still have
--    a non-conforming row stay NOT VALID, keep guarding new and changed rows, and are validated by a later run).
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
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.cname AND conrelid = to_regclass(c.tbl) AND NOT convalidated) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE NOT COALESCE((%s), true))', c.tbl, c.def) INTO bad;
      IF NOT bad THEN
        EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c.tbl, c.cname);
      END IF;
    END IF;
  END LOOP;
END $$;

-- 3. Opening ledger entries for rows that existed before accounting went live (and therefore have no ledger row).
--    Legacy rows keep no invoice/receipt number (number / receipt_number stay NULL: "unnumbered").
--    Idempotent through NOT EXISTS on (ref_table, ref_id, kind). entry_at is the row's created_at, the actor its created_by.
--    A row whose currency is not three letters A-Z cannot be stored in the ledger (its CHECK), so it waits: correct the
--    currency and run this migration again. Deleted rows get no entry. A legacy payment/expense that was voided after 016 (so it already has its reversing
--    'void' entry) also gets its opening entry, otherwise the reversal would have nothing to reverse.
INSERT INTO fin_ledger (entry_at, kind, ref_table, ref_id, candidate_id, currency, debit, credit, actor_id)
SELECT i.created_at, 'invoice', 'invoices', i.id, i.candidate_id, i.currency, i.total_amount, 0, i.created_by
  FROM invoices i
 WHERE i.is_deleted = false AND i.currency ~ '^[A-Z]{3}$' AND i.total_amount >= 0
   AND NOT EXISTS (SELECT 1 FROM fin_ledger l WHERE l.ref_table = 'invoices' AND l.ref_id = i.id AND l.kind = 'invoice')
 ORDER BY i.id;

INSERT INTO fin_ledger (entry_at, kind, ref_table, ref_id, candidate_id, currency, debit, credit, actor_id)
SELECT p.created_at, 'payment', 'payments', p.id, p.candidate_id, i.currency, 0, p.amount_paid, p.created_by
  FROM payments p JOIN invoices i ON i.id = p.invoice_id
 WHERE p.is_deleted = false AND i.currency ~ '^[A-Z]{3}$' AND p.amount_paid >= 0
   AND (p.voided_at IS NULL OR EXISTS (SELECT 1 FROM fin_ledger v WHERE v.ref_table = 'payments' AND v.ref_id = p.id AND v.kind = 'void'))
   AND NOT EXISTS (SELECT 1 FROM fin_ledger l WHERE l.ref_table = 'payments' AND l.ref_id = p.id AND l.kind = 'payment')
 ORDER BY p.id;

INSERT INTO fin_ledger (entry_at, kind, ref_table, ref_id, candidate_id, currency, debit, credit, actor_id)
SELECT e.created_at, 'expense', 'expenses', e.id, NULL, e.currency, e.amount, 0, e.created_by
  FROM expenses e
 WHERE e.is_deleted = false AND e.currency ~ '^[A-Z]{3}$' AND e.amount >= 0
   AND (e.voided_at IS NULL OR EXISTS (SELECT 1 FROM fin_ledger v WHERE v.ref_table = 'expenses' AND v.ref_id = e.id AND v.kind = 'void'))
   AND NOT EXISTS (SELECT 1 FROM fin_ledger l WHERE l.ref_table = 'expenses' AND l.ref_id = e.id AND l.kind = 'expense')
 ORDER BY e.id;
