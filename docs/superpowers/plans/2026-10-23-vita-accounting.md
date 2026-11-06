# VITA Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Accounting per `docs/superpowers/specs/2026-10-23-vita-accounting-design.md`.
**Architecture:** Additive migration 016; `modules/finance/*` services (SQL-side NUMERIC math, transactional, ledger insert-only); routes in new `routes/financeV2.js` mounted next to legacy `routes/finance.js`; UI in `public/vita/fin-*.js`.
**Tech Stack:** Node 22, Express, pg, node:test.

## Global Constraints
- Existing finance routes/tests unchanged in behaviour (legacy rows without numbers stay valid).
- All money maths in SQL `NUMERIC`; amounts travel as decimal strings; never `Number()` on money for arithmetic or comparison; round half-up to 2dp in SQL; reports per currency, no conversion.
- Posted records immutable: voids/refunds/reversals only; every mutation = one transaction with `fin_ledger` row, `logAudit(client)`.
- Permissions per spec §2; services check permission after loading, 404 for out-of-scope candidates (Candidate sees own only).
- Strict CSP, ar/en/fr parity, textContent only, CSV injection protection.
- After adding routes update `tests/orgs-route-sweep.test.js` classification tables (Employer/Agency denied, Candidate only `/finance/me*`).
- Commits end with: Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com> and Claude-Session: https://claude.ai/code/session_01FJCJCrbEtXFCvjTVJwpqAi. Full `npm test` stays green.

## Review Focus
- Two parallel payments summing above the balance; same idempotency key twice; payment to a voided/paid invoice.
- Voiding an invoice that has payments; refund larger than payment net; refund then re-pay.
- Invoice number uniqueness under parallel creation across a year boundary.
- Amounts like 0.1+0.2, 1e21, "NaN", negative, 3+ decimals, huge strings, comma decimals.
- CSV cells starting with =,+,-,@ and Arabic text/BOM; report totals vs raw rows with mixed currencies.
- Candidate token reading another candidate's invoice/print; staff roles without finance rights.

### Task 1: Migration 016 + permissions
Files: `sql/migrations/016_accounting.sql`, `middleware/role.js`, tests `tests/fin-schema.test.js`.
Everything in spec §3 (idempotent, constraints, indexes, insert-only trigger on fin_ledger, legacy rows untouched, backfill ledger? no — do NOT backfill, document opening balance instead: add `fin_opening` note in CHECKLIST), permissions finance:void/refund/export per spec §2. Tests: idempotence, constraints reject bad values, trigger blocks UPDATE/DELETE, role matrix, legacy finance tests still pass.

### Task 2: Services catalogue, invoices, numbering, void
Files: `modules/finance/money.js` (parse/validate decimal string → normalised string, rejects floats/NaN/exp/too many decimals), `modules/finance/services.js`, `modules/finance/invoices.js`, `routes/financeV2.js` (+ `app.js` mount with own 32kb parser), tests `tests/fin-invoices.test.js`.
Produces: catalogue CRUD; `createInvoice(user, input)`; list/get/void/print per spec §4; totals via SQL; numbering via `fin_counters` row lock `invoice-YYYY`; ledger + audit + timeline? (audit only). Tests include precision, numbering under 20 parallel creates, validation caps (items ≤ 50, description ≤ 300), void rule, role matrix, print escapes HTML.

### Task 3: Payments, receipts, refunds, void payment
Files: `modules/finance/payments.js`, routes in `routes/financeV2.js`, tests `tests/fin-payments.test.js`.
Per spec §4; `FOR UPDATE` on invoice; idempotency; status derivation in SQL; overpay 409/400; concurrency test with Promise.all; refund bounds; voiding payment restores balance; ledger sums equal; legacy POST /finance/payments also writes ledger + receipt number (keep response shape).

### Task 4: Expenses, reports, CSV export, candidate self view
Files: `modules/finance/expenses.js`, `modules/finance/reports.js`, `modules/finance/exportCsv.js`, `modules/finance/candidateView.js`, routes, tests `tests/fin-reports.test.js`.
Per spec §4; report numbers equal raw rows per currency; ageing buckets by due_date vs today (injectable clock); CSV safety; `/finance/me` Candidate-only strict ownership; legacy dashboard excludes voided; update route sweep tables.

### Task 5: UI (staff tab + candidate "My payments")
Files: `public/vita/fin-util.js`, `fin-invoices.js`, `fin-reports.js`, `admin.html`, `portal.html|js`, `i18n.js`, `crm-util.js` perms mirror, tests `tests/fin-ui.test.js`.
Parity/CSP tests, helper unit tests (decimal string formatting without floats), browser smoke with Playwright (create service → invoice → partial payment → receipt print → refund → report; candidate portal shows own only; ar RTL, 375px).

### Task 6: End-to-end, docs, review fixes hook
Files: `tests/fin-e2e.test.js`, `docs/vita-accounting/{CHECKLIST,SETUP}.md`, env additions (`FIN_CURRENCIES`, `FIN_TAX_RATE_PERCENT`, `FIN_COMPANY_*`) in both env examples; HOSTINGER doc paragraph. Journey: accountant sets service → invoice → payments (idempotent replay) → refund → void → reports/CSV tie out → candidate view; role matrix; legacy endpoints.
