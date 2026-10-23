# VITA Accounting — checklist

Status of Stage 4 (accounting). Items are ticked only when a test or a manual check proves them.

## Migration 016

- [x] Additive and idempotent; legacy `invoices` / `payments` / `expenses` rows are not rewritten, new columns are nullable.
- [x] CHECK constraints on legacy tables are added `NOT VALID` and validated only if every existing row conforms
      (otherwise they stay `NOT VALID` and guard new rows; re-running the migration validates them after the data is fixed).
- [x] `fin_ledger` is insert-only (UPDATE, DELETE and TRUNCATE are rejected by trigger).

## fin_opening — opening balance (no backfill)

Migration 016 does **not** backfill `fin_ledger` from invoices/payments/expenses that existed before accounting went live.
The ledger therefore starts empty and only contains postings made after the migration. Legacy rows keep their original
values and no invoice/receipt number (`number` / `receipt_number` stay NULL).

Before relying on ledger totals, the accountant records the **opening balance** per currency as of the go-live date
(sum of legacy `invoices.remaining_amount` for non-deleted invoices, per currency) and keeps it with the month-end
records. Reports that read the ledger are "since go-live"; reports that read the invoice/payment tables include legacy rows.
