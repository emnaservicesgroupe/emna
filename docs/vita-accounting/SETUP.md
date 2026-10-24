# VITA Accounting — setup and daily use

Accounting is part of the same VITA app: no extra service, container or database. It is switched on by migrations 016 and 017, which run with the
normal update (`./update.sh` / app start). Real payments are **recorded by hand** by staff; nothing is charged automatically.
What was and was not verified: [CHECKLIST.md](CHECKLIST.md).

## 1. Settings (all optional)

Put them in `.env` (on the VPS: `deploy/hostinger/.env`), then `docker compose up -d`. Defaults apply when a line is absent.

| Variable | Default | Meaning |
|---|---|---|
| `FIN_CURRENCIES` | `TND,EUR,CAD,USD` | Comma list of 3-letter currencies staff may use on invoices, services and expenses. Totals are always per currency, never converted. The console dropdown always shows the four defaults (known limit); the API enforces your list. |
| `FIN_TAX_RATE_PERCENT` | empty = no tax | One flat tax rate in percent (for example `19`), plain decimal above 0 up to 100. Applied to the subtotal of **new** invoices, rounded half-up to 2 decimals. Leave empty unless your accountant told you to charge it. |
| `FIN_COMPANY_NAME` | empty | Legal name printed in the invoice / receipt header. Hidden when empty. |
| `FIN_COMPANY_ADDRESS` | empty | Postal address in the header. Hidden when empty. |
| `FIN_COMPANY_TAX_ID` | empty | Tax / registration number in the header (your accountant gives you the exact wording). Hidden when empty. |
| `FIN_EXPORT_MAX_ROWS` | `50000` (also the maximum) | Row cap per CSV export. When more rows match, the file is cut and the response carries `X-Row-Limit-Hit: true`; narrow the dates and export again. |

The company facts are **your** inputs: the platform cannot know them. Ask your accountant to confirm the invoice number format
(`VITA-2026-000001`, one counter per year) and the mandatory mentions for Tunisian invoices before you give invoices to customers.

## 2. Who can do what

| Role | Look at invoices, payments, reports | Create invoices / payments / expenses, edit the price list | Void, refund | CSV export | Own invoices (portal) |
|---|---|---|---|---|---|
| SuperAdmin, Admin | yes | yes | yes | yes | n/a |
| Accountant | yes | yes | yes | yes | n/a |
| Manager | yes | no | no | yes | n/a |
| Agent, Receptionist, HR | no | no | no | no | n/a |
| Employer, Agency (portals) | no | no | no | no | n/a |
| Candidate (portal) | no | no | no | no | yes, read-only: "My payments" |

A candidate only ever sees their own invoices and payments (number, status, lines, amounts, receipts). Staff notes, who created a record,
void reasons and payment references are never shown to candidates.

## 3. Day to day (Accountant)

Sign in to the console and open the **Accounting** tab.

1. **Price list (once, then when prices change).** *Services* -> new service: a short upper-case code (`VISA-FILE`), a name in Arabic / English / French,
   the default price and its currency. To retire a service, deactivate it; never delete (old invoices keep it). Changing a price does not change old invoices.
2. **Invoice.** *Invoices* -> new: pick the candidate, the currency, an optional due date and note, then add lines from the price list (the price fills in
   when the service currency equals the invoice currency) or free text with quantity and unit price. The system computes the total, gives the number
   `VITA-YYYY-NNNNNN` and posts it. Print it from the invoice page. An invoice cannot be edited after it is created: if it is wrong, void it and issue a new one.
3. **Payment.** On the invoice choose *Record payment*: amount, method (cash, bank transfer, card, mobile, cheque, other), the date the money arrived,
   an optional bank reference. A part payment makes the invoice *Partial*; the last one makes it *Paid*. The system refuses more than the remaining
   balance. Pressing the button twice (or a bad connection) is safe: the same request is recognised and does not create a second payment.
4. **Receipt.** Every payment gets a receipt number `REC-YYYY-NNNNNN`; open *Receipt* on the payment and print it for the candidate.
5. **Refund.** On the payment choose *Refund*: amount (up to what was paid minus earlier refunds) and a reason.
   By default a refund **returns money and does not reopen the debt** (the candidate owes nothing more, for example a goodwill return).
   Tick *Reopen* when the service was not delivered and the candidate should owe the amount again: the invoice balance goes back up (never above the invoice total).
6. **Void.** An invoice with no payments can be voided with a reason (use it for mistakes). An invoice that has payments must have those payments voided first;
   a payment that has refunds cannot be voided (refund it instead). A voided record stays visible, marked *Void*, and drops out of the totals.
7. **Expenses.** *Expenses* -> new: title, amount, currency, date, category, payee. A wrong expense is voided with a reason, not deleted.
   Add categories under *Expense categories* (for example Office, Courier, Translation).
8. **Reports.** *Reports*: *Summary* (per currency: invoiced, collected, refunded, expenses, net, for a date range), *Receivables* (who owes what, ageing
   current / 1-30 / 31-60 / 61-90 / 90+ days overdue by due date), *By service*, *By staff*, and a candidate *Statement* (running balance).
   Collected is counted by payment date, invoiced by issue date, expenses by expense date.
9. **CSV export.** *Export* -> invoices, payments or expenses, optional from/to dates. The file opens in Excel (UTF-8 with BOM, Arabic is fine).
   Text that starts with `= + - @` is saved with a leading quote so Excel shows it as text instead of running it as a formula. Exports are logged.

Month end: run *Receivables* and *Summary* for the month, export the three CSVs, and keep them with your records together with the opening balance
(section 5). Reconcile the cash drawer and the bank statement by hand against *Payments*.

## 4. First check after installing (10 minutes)

Nobody has run this on your server yet. As the Accountant: create one service, one invoice for a test candidate, record a part payment, print its
receipt, refund a small amount, run *Summary*, export the invoices CSV and open it in Excel. Then sign in to the candidate portal as that candidate and
check "My payments". Void the test invoice's payments/invoice afterwards (or use a test candidate you delete later). Open the Arabic interface once.

## 5. Opening balance and old invoices

Invoices, payments and expenses that existed before accounting was installed keep their values and stay **unnumbered** (no invoice or receipt number).
Migration 017 gives each of them one **opening ledger entry** (invoice = debit, payment = credit, expense = debit, dated by the row's creation time and
attributed to the user who created it), so the ledger identity (ledger balance = total - paid = remaining) also holds for old invoices. Deleted rows get no
entry. It also tidies old data so old records can be voided, refunded and paid: payment methods are mapped to the allowed list (`Cash` -> `cash`,
`Bank Transfer` -> `bank_transfer`, anything unknown -> `other`) and currencies are trimmed and upper-cased (`tnd` -> `TND`).

A record whose currency is still not three letters (for example `TN`) is left as it is: the console answers "this record has legacy data that must be
corrected: currency" (409) when you try to change it, and it gets no opening entry yet. Correct the currency in the database (with your developer), run the
update again (`npm run migrate` re-applies nothing, so re-run `sql/migrations/017_accounting_fixes.sql` by hand), and the entry is added and the
remaining checks are completed. Running 017 twice never duplicates anything.

## 6. Backup advice

- The **ledger is insert-only**: the database refuses UPDATE, DELETE and TRUNCATE on it. Corrections are new rows (void, refund, reversal). **Never edit
  or delete accounting rows by hand** (invoices, payments, refunds, expenses, ledger) with SQL: it breaks the identity between ledger, invoices and reports
  and cannot be audited. If something is wrong, void / refund through the console.
- Accounting lives in the same Postgres database as the CRM, so the normal `./backup.sh` already covers it. Keep several generations, copy them off the
  server, and run the restore test from [SETUP-HOSTINGER.md](../vita-job-search/SETUP-HOSTINGER.md) section 12 before you depend on them.
- Take a backup before every update and at every month end; keep the month-end CSV exports with it.
