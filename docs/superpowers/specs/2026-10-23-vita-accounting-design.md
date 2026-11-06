# VITA — Accounting (Stage 4) — Design

Status: stage scope announced 2026-10-23; owner's standing instruction ("fix everything, don't come back") covers spec/plan approval.
Code: `trust-crm/`. Additive only. Existing `/finance/dashboard`, `/finance/invoices` (POST), `/finance/payments` (POST) and their tests keep working unchanged.

## 1. Goal and success criteria
Staff with finance rights can price services, issue numbered invoices with line items, record payments against them (partial or full), issue receipts, record refunds, void mistakes, track expenses, see each candidate's balance and ageing, and get period reports and CSV exports — with an immutable audit/ledger trail. Candidates can see (read-only) their own invoices, payments and balance in the portal. Done = tests on real Postgres including concurrency and money-precision cases, role isolation, and an honest checklist.

Hard rules: money arithmetic is done in the database on `NUMERIC` (never JavaScript floats) and compared as exact decimal strings; no currency conversion is invented — every total is reported **per currency** (TND, EUR, CAD, USD allowed; list in env `FIN_CURRENCIES`); no tax is applied unless the owner configures `FIN_TAX_RATE_PERCENT` (default none, shown as 0 and not printed); posted records are never edited or deleted — corrections are voids, refunds or reversing ledger entries; every mutation is audited and transactional; the platform records what staff say was paid — it does not move money or integrate a payment gateway.

## 2. Roles
`finance:read` / `finance:write` already exist (Admin, SuperAdmin all; Manager read; Accountant read+write). New: `finance:void` (Admin, SuperAdmin, Accountant), `finance:refund` (Admin, SuperAdmin, Accountant), `finance:export` (Admin, SuperAdmin, Accountant, Manager). Agent, Receptionist, HR, Employer, Agency: none. Candidate: read-only own via ownership (like job-search), never any staff route.

## 3. Data (migration 016, additive, idempotent)
- `fin_services(id, code unique, name_ar, name_en, name_fr, default_price numeric(12,2), currency, active, created_by, created_at)`.
- `invoices` gains: `number text unique` (nullable for legacy rows, assigned `VITA-YYYY-000001` style per year via a `fin_counters` row locked per year), `issued_at`, `voided_at`, `void_reason`, `subtotal numeric`, `tax_amount numeric default 0`, `status` extended to Draft|Pending|Partial|Paid|Void|Refunded (legacy 'Pending/Partial/Paid' preserved).
- `invoice_items(id, invoice_id, service_id null, description, quantity numeric(10,2) > 0, unit_price numeric(12,2) >= 0, line_total numeric(12,2) generated or stored, position)`.
- `payments` gains: `receipt_number text unique`, `reference text`, `idempotency_key text` (unique per invoice when set), `voided_at`, `void_reason`; payment_method limited to cash|bank_transfer|card|mobile|cheque|other.
- `fin_refunds(id, payment_id, invoice_id, amount, reason, created_by, created_at)` with `amount <= payment net`.
- `expense_categories(id, name, active)`; `expenses` gains `category_id`, `payee`, `voided_at`, `void_reason`.
- `fin_ledger(id, entry_at, kind invoice|payment|refund|void|expense, ref_table, ref_id, candidate_id null, currency, debit numeric, credit numeric, actor_id)` insert-only (trigger blocks UPDATE/DELETE), written in the same transaction as every posting.
- `fin_counters(key text pk, value bigint)`.

## 4. APIs (all under `/finance/*`, permission-checked in the service after scope)
- Services: `GET/POST/PATCH /finance/services` (write needs finance:write; deactivate rather than delete).
- Invoices: `POST /finance/invoices/v2 {candidate_id, currency, due_date?, notes?, items:[{service_id?|description, quantity, unit_price}]}` → computes totals in SQL, assigns number, writes ledger; `GET /finance/invoices` (filters: candidate_id, status, currency, from, to, q, overdue; paging), `GET /finance/invoices/:id` (items, payments, refunds, balance), `POST /finance/invoices/:id/void {reason}` (only if no non-voided payments; else 409 telling to refund/void payments first), `GET /finance/invoices/:id/print` (HTML, print.css-friendly).
- Payments: `POST /finance/payments/v2 {invoice_id, amount, method, payment_date?, reference?, notes?, idempotency_key?}` — row-locks the invoice, rejects overpayment and payments to Void/Paid invoices, derives status, assigns receipt number, ledger; same idempotency key returns the original result (200, `replayed:true`). `POST /finance/payments/:id/void {reason}`; `POST /finance/payments/:id/refund {amount, reason}`; `GET /finance/payments/:id/receipt` (HTML).
- Expenses: `GET/POST /finance/expenses`, `POST /finance/expenses/:id/void`, `GET/POST /finance/expense-categories`.
- Reports (finance:read): `GET /finance/reports/summary?from&to` (per currency: invoiced, collected, refunded, expenses, net), `/reports/receivables` (open balances + ageing buckets 0-30/31-60/61-90/90+ by due date), `/reports/by-service`, `/reports/by-staff` (created_by), `/reports/candidate/:id` (statement). `GET /finance/export/{invoices|payments|expenses}.csv?from&to` (finance:export; CSV-injection-safe: cells starting = + - @ are prefixed with a quote; UTF-8 BOM for Excel Arabic).
- Candidate portal: `GET /finance/me` (role Candidate only: own invoices with number, status, totals, items, payments, balance — no staff notes, no created_by) and `GET /finance/me/invoices/:id/print`.
- Legacy `/finance/dashboard` totals ignore voided rows from now on; legacy POST routes remain and also write ledger rows.

## 5. UI
Staff console tab "Accounting": Invoices (list/filter, create with line items from catalogue, detail with payments, record payment, void, print), Receivables (ageing), Expenses, Reports/Export, Services catalogue. Candidate portal: "My payments" read-only. ar/en/fr RTL, CSP-safe, same code style as `crm-*.js`.

## 6. Testing
Exact-decimal tests (0.1+0.2 style, 3-decimal quantities, rounding to 2dp half-up in SQL); concurrency (two simultaneous payments cannot overpay; duplicate idempotency key; numbering uniqueness under parallel invoice creation); void/refund rules; ledger balances equal sums; role matrix incl. Agent/HR/Receptionist/Employer/Agency/Candidate denied; candidate sees only own; CSV injection; report numbers equal underlying rows per currency; legacy endpoints unchanged; all-routes sweep updated (every new route classified); migration idempotent on a DB with legacy invoices/payments.

## 7. Out of scope
Payment gateways, bank reconciliation imports, multi-currency conversion, payroll (HR stage), employer/agency commissions, official tax filings, e-invoicing standards. Owner inputs: company legal name/address/tax id for invoice headers (`SITE_*` + `FIN_COMPANY_*` env, hidden when unset), the real service price list, currencies in use, tax rate if any, accountant review of numbering/format for Tunisian requirements.
