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

## Payments, receipts, refunds (Task 3)

- [x] `POST /finance/payments/v2`: one transaction, invoice row locked `FOR UPDATE`, overpayment refused (400, remaining shown),
      Void / Paid / Refunded / Draft invoices refused (409), remaining and status (Partial / Paid) computed in SQL NUMERIC.
- [x] Receipt numbers `REC-YYYY-NNNNNN` from `fin_counters` (`receipt-YYYY`), unique and gap-free; a rejected payment burns no number.
- [x] Idempotency: same `(invoice_id, idempotency_key)` returns the original payment (200, `replayed: true`); a different
      amount or method with the same key is 409.
- [x] `POST /finance/payments/:id/void` (finance:void): restores invoice remaining/status, reversing ledger debit; refused
      (409) when the payment has refunds or is already void.
- [x] Legacy `POST /finance/invoices` and `POST /finance/payments` validate currency (3 letters, upper-cased), payment method
      (case-insensitive map to cash|bank_transfer|card|mobile|cheque|other) and amounts (400 instead of a database 500), compare
      money in SQL, and also assign the invoice / receipt number and write the ledger row. Response shapes are unchanged.
- [x] Legacy `/finance/dashboard` ignores voided invoices and voided payments.

### Refund rule (decision)

A refund **returns money to the candidate and does not reopen the debt**, unless `reopen: true` is sent.

| Case | `invoices.remaining_amount` | invoice status |
|---|---|---|
| refund, `reopen` false (default) | unchanged | `Refunded` only when every live payment on the invoice is fully refunded **and** nothing is owed (remaining = 0); otherwise unchanged |
| refund, `reopen: true` | `+ amount` (never above the invoice total) | `Pending` when remaining = total, `Partial` otherwise |

- Refund amount <= payment net of earlier refunds (checked under the payment row lock and again by the `fin_refunds` trigger).
- A voided payment cannot be refunded; a payment with refunds cannot be voided (refund first, nothing to void).
- Ledger: invoice = debit, payment = credit, void of a payment = debit, refund = debit.
  Per invoice: `ledger balance = total - live paid + refunded = remaining_amount + refunds made without reopen`.

## Expenses, reports, CSV export, candidate self-view (Task 4)

- [x] Expenses: `POST /finance/expenses` (amount decimal string > 0, currency in `FIN_CURRENCIES`, `spent_on` not after today+1 UTC) writes a
      ledger debit (`kind 'expense'`); `POST /finance/expenses/:id/void` (finance:void) keeps the row and posts a ledger credit (`kind 'void'`).
      Legacy `/finance/dashboard` `total_out` now ignores voided expenses; its totals tie to `/finance/reports/summary` (same rows, summed over currencies).
- [x] Reports (finance:read), SQL NUMERIC, per currency, no conversion: `summary` (invoiced = non-void invoices by issue date, collected = non-voided
      payments by `payment_date`, refunded by refund day, expenses non-voided by `spent_on`, net = collected - refunded - expenses),
      `receivables` (open `remaining_amount`; `current` = due on/after `asOf`, `0-30` = 1-30 days overdue, `31-60`, `61-90`, `90+`, `no_due_date`;
      `asOf` defaults to today UTC and is injectable), `by-service`, `by-staff`, `candidate/:id` statement.
- [x] Statement running balance is the ledger balance (invoiced - paid + refunded) per currency; `open` is the invoices' remaining amount. They differ
      by refunds made without `reopen` (money returned, debt not reopened). Voided invoices and payments are left out of the statement.
- [x] CSV export (finance:export): BOM, every cell quoted, CRLF, `= + - @ TAB CR` first-character guard, amounts as plain decimals, cap
      `FIN_EXPORT_MAX_ROWS` (default and maximum 50000) with `X-Row-Limit-Hit: true`; voided rows are exported with their void columns; exports are audited (`EXPORT`).
- [x] `GET /finance/me` and `GET /finance/me/invoices/:id/print` are Candidate-only (own candidate via `js_candidate_accounts`); the router refuses Candidate
      everywhere else and refuses every other role on `/me*`. Foreign, draft, deleted and missing invoices answer the same 404; no staff notes, `created_by`,
      void reasons or payment references are returned or printed.
