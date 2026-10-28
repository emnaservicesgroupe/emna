# VITA Accounting — checklist

Status of Stage 4 (accounting). Items are ticked only when a test or a manual check proves them.

## Migration 016

- [x] Additive and idempotent; legacy `invoices` / `payments` / `expenses` rows are not rewritten, new columns are nullable.
- [x] CHECK constraints on legacy tables are added `NOT VALID` and validated only if every existing row conforms
      (otherwise they stay `NOT VALID` and guard new rows; re-running the migration validates them after the data is fixed).
- [x] `fin_ledger` is insert-only (UPDATE, DELETE and TRUNCATE are rejected by trigger).

## Legacy rows: normalisation and opening ledger entries (migration 017)

Migration 017 (`sql/migrations/017_accounting_fixes.sql`; idempotent, 016 is untouched) does three things for rows that existed before accounting went live:

1. **Normalises** the values the 016 CHECK constraints reject: `payments.payment_method` is lower-cased, trimmed, spaces/hyphens become `_`, mapped to
   `cash | bank_transfer | card | mobile | cheque | other` (unknown -> `other`); `invoices.currency` / `expenses.currency` are trimmed and upper-cased when that gives
   three letters A-Z. Nothing else changes (no `updated_at`, no ids, no amounts). Anything still non-conforming (for example currency `TN`, status `Unpaid`) is left alone.
2. **Validates** the `NOT VALID` constraints that now conform (the others keep guarding new rows and are validated by a later run after the data is corrected).
3. **Backfills opening ledger entries** (`kind` invoice = debit `total_amount`, payment = credit `amount_paid`, expense = debit `amount`; `entry_at` = the row's `created_at`,
   actor = its `created_by`) for non-deleted legacy rows that have no ledger row, keyed by `NOT EXISTS (ref_table, ref_id, kind)`, so a re-run adds nothing. A legacy payment/expense
   voided after 016 also gets its opening entry (its reversing `void` entry already exists). Rows with a currency the ledger cannot store wait until it is corrected.

Legacy invoices and receipts stay **unnumbered** (`number` / `receipt_number` NULL). The per-invoice ledger identity now holds for legacy invoices too
(`tests/fin-schema.test.js`). Recording the opening balance by hand is no longer needed.

## Payments, receipts, refunds (Task 3)

- [x] `POST /finance/payments/v2`: one transaction, invoice row locked `FOR UPDATE`, overpayment refused (400, remaining shown),
      Void / Paid / Refunded / Draft invoices refused (409), remaining and status (Partial / Paid) computed in SQL NUMERIC.
- [x] Receipt numbers `REC-YYYY-NNNNNN` from `fin_counters` (`receipt-YYYY`), unique and gap-free; a rejected payment burns no number.
- [x] Idempotency: same `(invoice_id, idempotency_key)` returns the original payment (200, `replayed: true`); a different
      amount, method, payment date (when sent), reference or notes with the same key is 409 "idempotency key reused with different parameters".
- [x] `POST /finance/payments/:id/void` (finance:void): restores invoice remaining/status, reversing ledger debit; refused
      (409) when the payment has refunds or is already void.
- [x] Legacy `POST /finance/invoices` and `POST /finance/payments` validate currency (3 letters, upper-cased), payment method
      (case-insensitive map to cash|bank_transfer|card|mobile|cheque|other) and amounts (400 instead of a database 500), compare
      money in SQL, and also assign the invoice / receipt number and write the ledger row. Response shapes are unchanged.
- [x] Legacy `/finance/dashboard` ignores voided invoices and voided payments; `total_in` is net of refunds (collected - refunded, same rows as `/finance/reports/summary`).

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

## Console tab and candidate "My payments" (Task 5)

- [x] "Accounting" tab in the staff console (invoices, receivables, expenses, reports/export, services) and a read-only "My payments" step in the
      candidate portal; ar/en/fr with identical placeholders, RTL for Arabic, strict CSP (no inline code, DOM text helpers only, only literal
      same-origin `/finance/...` paths). Tested in `tests/fin-ui.test.js` (static checks, helper unit tests, permission mirror equals
      `middleware/role.js`, contract test against the real API).
- [x] Money in the browser is handled as decimal strings (`formatMoney`, `parseMoneyInput`, `cmpDecimal` never go through a float). `tests/fin-ui.test.js`.
- [ ] **Blocked / not repeatable:** rendering in a real browser (layout, RTL, 375 px width, the print window) has no committed test. An earlier
      agent recorded a manual browser smoke in its task report only. Do a first click-through yourself (SETUP.md, section "First check").

## End-to-end (Task 6)

- [x] `tests/fin-e2e.test.js` (real HTTP server, real Postgres schema, real `/auth/login`, candidate OTP login via the sandbox mailbox, no network,
      env injected, deterministic; run twice in a row green): Accountant creates a service and an expense category, an invoice with two items
      (half-up rounding in SQL), a partial payment, the same payment again with the same idempotency key (200, `replayed: true`, one row, one ledger
      credit), the settling payment (Paid), a partial refund with the default rule, voids a different invoice, records and voids an expense, uses
      a second currency (EUR, with a refund that reopens the debt).
- [x] summary / receivables / by-service / by-staff / candidate statement equal values computed independently from raw table rows (BigInt cents
      in the test, not the report SQL), per currency, EUR and TND never merged; also for a date window and with an injected `asOf`.
- [x] CSV exports (invoices, payments, expenses) parse back with a small RFC 4180 reader to the same rows; BOM, quoting, embedded comma/quote/newline
      survive; every formula-looking cell (`=...`) is stored with a leading quote; the row cap sets `X-Row-Limit-Hit: true`; each export writes an `EXPORT` audit row.
- [x] Ledger identity per invoice: `ledger balance = total - live paid + refunded = remaining + refunds made without reopen`; a voided invoice nets to 0;
      the ledger rejects UPDATE, DELETE and TRUNCATE.
- [x] Candidate (OTP login): `GET /finance/me` returns exactly the own non-draft invoices, no staff note / `created_by` / void reason / payment reference;
      printing another candidate's invoice returns the same 404 as a missing one; every other finance route is 403.
- [x] Roles: Manager reads and exports (all GETs and the three CSVs 200) but write, void and refund are 403 and leave no row; Agent, Receptionist,
      HR, Employer, Agency are 403 on read, write, export and legacy routes, anonymous is 401.
- [x] Legacy `POST /finance/invoices` and `POST /finance/payments` still work (response shapes unchanged), also assign the invoice / receipt number,
      write the ledger, and appear in lists and reports.
- [x] 10 parallel payments on one invoice: exactly the ones that fit succeed, the balance never goes negative, receipt numbers unique.
- [x] The all-routes sweep file (`tests/orgs-route-sweep.test.js`) passes, started from `fin-e2e` as a child process.

## Spec requirements

| Spec | Status | Where tested |
|---|---|---|
| §1 NUMERIC money in the database, decimal strings, no floats | completed | `fin-invoices`, `fin-payments`, `fin-reports`, `fin-ui` (helpers), `fin-e2e` |
| §1 totals per currency, no conversion | completed | `fin-reports`, `fin-e2e` (EUR and TND) |
| §1 no tax unless `FIN_TAX_RATE_PERCENT` | completed (default none, `tax_amount` 0) | `fin-invoices` (rate set), `fin-e2e` (unset) |
| §1 posted records never edited or deleted; voids, refunds, reversing ledger rows | completed | `fin-payments`, `fin-schema` (trigger), `fin-e2e` |
| §1 every mutation transactional and audited | completed | `fin-invoices`, `fin-payments`, `fin-reports` |
| §1 platform records, does not move money | by design (no gateway) | n/a |
| §2 roles and `finance:void` / `refund` / `export` | completed | `fin-schema`, `fin-e2e`, `fin-ui` |
| §3 migration 016, additive, idempotent, insert-only ledger | completed | `fin-schema`, `migrate`, `verify-migrations` |
| §3 backfill of legacy rows into the ledger | completed in migration 017 (opening entries; legacy numbers stay unnumbered) | `fin-schema` |
| §4 services, invoices (create, list, get, void, print) | completed | `fin-invoices`, `fin-e2e` |
| §4 payments (idempotency, overpayment, void, refund, receipt) | completed | `fin-payments`, `fin-e2e` |
| §4 expenses, categories, void | completed | `fin-reports`, `fin-e2e` |
| §4 reports and CSV export | completed | `fin-reports`, `fin-e2e` |
| §4 candidate `GET /finance/me` and own-invoice print | completed | `fin-reports`, `fin-e2e` |
| §4 legacy routes kept, dashboard ignores voided rows | completed | `finance`, `fin-payments`, `fin-e2e` |
| §5 console tab, candidate "My payments", ar/en/fr, CSP | completed (static + contract tests); real-browser run **blocked**, see above | `fin-ui` |
| §6 concurrency, precision, role matrix, candidate isolation, CSV injection, tie-out, sweep, idempotent migration | completed | `fin-payments`, `fin-invoices`, `fin-reports`, `fin-schema`, `fin-e2e`, `orgs-route-sweep` |
| §7 payment gateway, bank reconciliation, FX, payroll, commissions, tax filing, e-invoicing | out of scope | n/a |

## Opening balances of pre-existing legacy invoices (how reports treat them)

Invoices and payments created before migration 016 keep their values, have no `number` / `receipt_number` (unnumbered) and no items. Since migration 017 they
also have one opening **ledger** row each (see above), so ledger and tables agree. Reports and the candidate view read the `invoices`, `payments`, `fin_refunds`
and `expenses` tables, so a legacy row is counted: as an invoice (dated by `created_at`, because `issued_at` is empty), as an open receivable (its
`remaining_amount`, ageing by `due_date`), and as a payment (by `payment_date`). Legacy rows without a currency are `TND` (the old column default).

## Honest limits and known gaps

- **Not run on a real server.** Everything above ran in the automated suite on a throwaway Postgres schema with a sandbox mailbox. Nobody has
  installed this on the Hostinger VPS and clicked through it; do that once (SETUP.md "First check") before relying on it.
- **No payment gateway and no bank integration.** Staff record what was paid (cash, transfer, card, mobile, cheque, other). Nothing is charged or reconciled automatically.
- **No currency conversion.** Every total is per currency; there is no combined "grand total".
- **Tax only if `FIN_TAX_RATE_PERCENT` is set** (one flat rate for the whole invoice, rounded half-up to 2 decimals, shown on the invoice only when above 0).
- **Invoice number format is not legal advice.** `VITA-YYYY-NNNNNN` (gap-free per year) is a sensible default. The owner's accountant must confirm it,
  the invoice layout and the mandatory mentions meet Tunisian requirements (and any other country's) before invoices are handed to customers.
- **Company header facts are owner inputs**: `FIN_COMPANY_NAME`, `FIN_COMPANY_ADDRESS`, `FIN_COMPANY_TAX_ID` (and the `SITE_*` contact settings). They are hidden when empty; the platform does not know them.
- **Refund rule** (see "Refund rule (decision)" above): a refund returns money and does not reopen the debt unless `reopen: true` is sent.
- Known limits found by the build agents:
  - The console's currency list is fixed to the default `FIN_CURRENCIES` (TND, EUR, CAD, USD). If you change `FIN_CURRENCIES` to something else,
    the API enforces your list but the UI dropdown still offers the four defaults (an unlisted currency is refused with a clear message).
  - A payment date cannot be in the future nor more than one year before the invoice was issued (400). Older receipts need an explanation in `notes` and today's date.
  - Ids (invoices, payments, expenses, candidates) come from global database sequences. Rolled-back attempts leave gaps in ids; the **printed numbers**
    (`VITA-...`, `REC-...`) are drawn inside the same transaction and stay gap-free.
  - Amounts are limited to 10 integer digits, quantities to 2 decimals, an invoice to 50 lines, text fields to their documented lengths.
  - Candidate list `GET /finance/me` returns the newest 200 invoices.
- Not covered by any test: the print/receipt pages in a real browser's print dialog, Arabic font rendering on paper, very large datasets (the CSV cap is the guard), a restore from backup of the ledger.

## Review round 1 (independent accounting review)

Fixed, each with a failing test first (`fin-schema`, `fin-payments`, `fin-invoices`, `fin-reports`):

- [x] **Legacy data vs the NOT VALID checks** (migration 017): normalisation and validation as described above. Records that still hold a non-conforming currency/status
      answer **409** "this record has legacy data that must be corrected: currency" (never 500, never the constraint name) from the invoice, payment, refund, void and
      legacy routes (a Postgres 23514 raised inside a finance transaction is translated in `modules/finance/common.js`).
- [x] **Oversized ids**: `parseId` in `modules/finance/common.js` refuses ids above 2147483647: 404 for path ids, 400 for body and query fields
      (candidate_id, invoice_id, payment_id, service_id, category_id, expense_id), on every route including the legacy ones (the legacy POSTs used to answer 404 for an oversized body id; they now answer 400).
- [x] **Legacy `POST /finance/payments`** applies the same `payment_date` rules as v2 (not after today + 1 day, not more than a year before the invoice was issued) through one shared checker.
- [x] **Idempotency replay** compares amount, method, payment date (when sent), reference and notes; any difference is 409 "idempotency key reused with different parameters".
- [x] **Fully refunded payments** (net zero) no longer block voiding the invoice and do not have to be voided; a payment that still holds money does (409). The void posts the usual
      reversal for the invoice only, the ledger nets to zero. The UI helper `canVoidInvoice` does not look at payments (the server decides), so it needed no change.
- [x] **Legacy `/finance/dashboard` `total_in`** subtracts refunds; it equals `summary` collected - refunded (response keys unchanged).
- [x] **Legacy rows and the ledger**: opening ledger entries backfilled (migration 017), documented here and in SETUP.md.
- [x] **CSV**: the spreadsheet-injection guard now also covers a leading LF and the full-width lookalikes `＝ ＋ － ＠`.

Remaining limits:

- A refund **without** `reopen` leaves `remaining_amount` unchanged (money returned, debt not reopened), so the candidate's `/finance/me` totals show `paid` and `refunded`
  while `remaining` stays 0: a display oddity, not a calculation error. Use `reopen: true` when the candidate owes the money again.
- The invoice/receipt print page opened from the console is a blob page and does not carry the server's strict CSP header (the server-rendered print routes do).
- The CSV guard covers a leading `= + - @ TAB CR LF` and the four full-width lookalikes; other Unicode characters that some spreadsheets might treat as formula starts are not guarded.
- A legacy record with a currency that is not three letters, or an old status such as `Unpaid`, is never auto-corrected (it would be a guess): it is read-only until the owner fixes it, and it gets no opening ledger entry until then.
