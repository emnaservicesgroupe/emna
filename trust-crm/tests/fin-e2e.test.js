// fin-e2e-README
// End-to-end journey for accounting (stage 4, Task 6). REAL HTTP server (app.listen(0) + fetch), REAL Postgres schema
// (fresh per file), real logins through /auth/login (Accountant, Manager, Agent, Receptionist, HR, Admin), candidates by the
// REAL e-mail OTP flow (code read from the sandbox mailbox), and tests/helpers/e2e.js (which also fences globalThis.fetch:
// no network). Limits and finance settings come from injected env.
//
//   A  Accountant: service + expense category -> invoice with two items -> partial payment, idempotent replay (one row)
//      -> second payment settles to Paid -> partial refund (default rule) -> a different invoice voided
//      -> a second currency (EUR) with a reopening refund, ageing buckets, formula-looking text
//   B  expenses: recorded, one voided
//   C  legacy POST /finance/invoices and /finance/payments still work and show up in lists, reports and the ledger
//   D  parallel payments on one invoice never exceed the balance
//   E  reports (summary, receivables, by-service, by-staff, statement) equal values computed INDEPENDENTLY from raw SQL rows
//      (BigInt cents), per currency; CSV exports parse back to the same rows, formula cells neutralised, row cap header;
//      ledger sums per invoice match the documented identity; the ledger is insert-only
//   F  candidate (OTP login): /finance/me sees only its own invoices, cannot print another candidate's (identical 404)
//   G  role matrix: Manager read/export only; Agent/Receptionist/HR/Employer/Agency/anonymous denied
//   H  the all-routes sweep file still passes (child process)
//
// NOT covered (by design): a real server, a payment gateway or bank (none exists), currency conversion (none exists), a browser (see fin-ui).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "fin-e2e-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fin-e2e-"));
process.env.STORAGE_URL_SECRET = "fin-e2e-storage-secret";
process.env.MAIL_PROVIDER = "sandbox";
process.env.MAIL_SANDBOX_ALLOWLIST = "*@test.invalid,*@*.test.invalid";
process.env.MAIL_FROM = "applications@vita.test.invalid";
process.env.SITE_IP_SALT = "fin-e2e-salt";
// Deterministic finance settings injected through env (never host defaults).
process.env.FIN_CURRENCIES = "TND,EUR";
delete process.env.FIN_TAX_RATE_PERCENT;
process.env.FIN_EXPORT_MAX_ROWS = "1000";
process.env.FIN_COMPANY_NAME = "VITA Test Company";
for (const k of ["CLAMAV_HOST", "MAIL_REAL_SEND"]) delete process.env[k];

const E = require("./helpers/e2e");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");

const FORMULA = "=HYPERLINK(\"http://evil.invalid\",\"x\")";
const CMD = "=cmd|' /C calc'!A0";

// ---------------------------------------------------------------- independent money arithmetic (BigInt cents, no floats)
function cents(s) {
  assert.match(String(s), /^-?\d+(\.\d{1,2})?$/, `not a 2dp decimal string: ${s}`);
  const neg = String(s).startsWith("-");
  const [i, f = ""] = String(s).replace("-", "").split(".");
  const v = BigInt(i) * 100n + BigInt((f + "00").slice(0, 2));
  return neg ? -v : v;
}
function fmt(c) {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}
const sum = (rows, pick) => rows.reduce((t, r) => t + cents(pick(r)), 0n);

// ---------------------------------------------------------------- a small CSV reader (RFC 4180, BOM, CRLF, quoted cells)
function parseCsv(text) {
  assert.equal(text.charCodeAt(0), 0xfeff, "UTF-8 BOM for Excel");
  const s = text.slice(1);
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && s[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  assert.equal(cell, "", "the file ends with CRLF");
  assert.equal(row.length, 0);
  const [head, ...body] = rows;
  for (const r of body) assert.equal(r.length, head.length, "every row has the header's width");
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

let w;
const S = {}; // shared journey state
const T = () => w.tokens;
const http = (m, u, tok, b, h) => w.http(m, u, tok, b, h);
const day = async (offset) => (await w.one("SELECT to_char((now() AT TIME ZONE 'UTC')::date + $1::int, 'YYYY-MM-DD') AS d", [offset])).d;

test.before(async () => {
  w = await E.startWorld();
  await E.addStaff(w, "admin", "Admin");
  await E.addStaff(w, "acct", "Accountant");
  await E.addStaff(w, "mgr", "Manager");
  await E.addStaff(w, "agent", "Agent");
  await E.addStaff(w, "rec", "Receptionist");
  await E.addStaff(w, "hr", "HR");
  S.today = await day(0);
});
test.after(async () => {
  if (w) await w.close().catch(() => {});
  assert.deepEqual(E.blockedNetwork, [], "no network call left the test process");
});

// ================================================================ A  accountant journey
test("A1: the accountant logs in through the real /auth/login and sees the finance dashboard", async () => {
  const r = await http("GET", "/finance/dashboard", T().acct);
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("A2: candidates (two by real OTP login, one seeded) and the price list", async () => {
  S.candA = await E.createCandidate(w, "A", "agent");
  S.candB = await E.createCandidate(w, "B", "agent");
  const add = await http("POST", "/candidates/add", T().admin, { full_name: "Candidate C", passport_number: "E2E-C-1", nationality: "Tunisian", assigned_to: w.users.agent });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  S.candC = { id: add.body.id };

  const s1 = await http("POST", "/finance/services", T().acct, { code: "VISA-FILE", name_en: "Visa file", name_fr: "Dossier visa", name_ar: "ملف التأشيرة", default_price: "150.00", currency: "TND" });
  assert.equal(s1.status, 201, JSON.stringify(s1.body));
  assert.equal(s1.body.default_price, "150.00");
  S.svc = s1.body;
  const dup = await http("POST", "/finance/services", T().acct, { code: "VISA-FILE", name_en: "Again", default_price: "1.00" });
  assert.equal(dup.status, 409, JSON.stringify(dup.body));
  const s2 = await http("POST", "/finance/services", T().acct, { code: "TRAINING-EUR", name_en: "Language course", default_price: "200.00", currency: "EUR" });
  assert.equal(s2.status, 201, JSON.stringify(s2.body));
  S.svcEur = s2.body;
  const cat = await http("POST", "/finance/expense-categories", T().acct, { name: "Office" });
  assert.equal(cat.status, 201, JSON.stringify(cat.body));
  S.cat = cat.body;
  const list = await http("GET", "/finance/services?active=true", T().acct);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.rows.map((r) => r.code).sort(), ["TRAINING-EUR", "VISA-FILE"]);
});

test("A3: invoice with two items (catalogue price + free text, half-up rounding in SQL), numbered, ledger debit written", async () => {
  const r = await http("POST", "/finance/invoices/v2", T().acct, {
    candidate_id: S.candA.id,
    currency: "TND",
    due_date: await day(-84),
    notes: "INTERNAL-STAFF-NOTE",
    items: [
      { service_id: S.svc.id, quantity: "2" },
      { description: "Translation of documents", quantity: "1.5", unit_price: "33.33" },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  S.inv1 = r.body;
  assert.match(r.body.number, /^VITA-\d{4}-\d{6}$/);
  assert.equal(r.body.items.length, 2);
  assert.deepEqual(r.body.items.map((i) => i.line_total), ["300.00", "50.00"], "1.5 x 33.33 = 49.995 -> 50.00 half-up");
  assert.equal(r.body.total_amount, "350.00");
  assert.equal(r.body.remaining_amount, "350.00");
  assert.equal(r.body.status, "Pending");
  assert.equal(r.body.tax_amount, "0.00", "no tax unless FIN_TAX_RATE_PERCENT is set");
  const led = await w.q("SELECT * FROM fin_ledger WHERE ref_table = 'invoices' AND ref_id = $1", [r.body.id]);
  assert.equal(led.rows.length, 1);
  assert.equal(led.rows[0].kind, "invoice");
  assert.equal(led.rows[0].debit, "350.00");
});

test("A4: partial payment, idempotent replay (one row), second payment settles to Paid, overpayment and paying a paid invoice refused", async () => {
  const body = { invoice_id: S.inv1.id, amount: "100.00", method: "cash", payment_date: await day(-5), reference: CMD, idempotency_key: "e2e-key-1" };
  const p1 = await http("POST", "/finance/payments/v2", T().acct, body);
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  assert.equal(p1.body.replayed, false);
  assert.match(p1.body.payment.receipt_number, /^REC-\d{4}-\d{6}$/);
  assert.equal(p1.body.invoice.remaining_amount, "250.00");
  assert.equal(p1.body.invoice.status, "Partial");
  S.pay1 = p1.body.payment;

  const again = await http("POST", "/finance/payments/v2", T().acct, body);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.payment.id, p1.body.payment.id);
  assert.equal(again.body.payment.receipt_number, p1.body.payment.receipt_number);
  assert.equal(await w.count("SELECT count(*) AS n FROM payments WHERE invoice_id = $1", [S.inv1.id]), 1, "exactly one payment row");
  assert.equal(await w.count("SELECT count(*) AS n FROM fin_ledger WHERE kind = 'payment' AND ref_id = $1", [S.pay1.id]), 1, "exactly one ledger credit");
  assert.equal((await http("POST", "/finance/payments/v2", T().acct, { ...body, amount: "99.00" })).status, 409, "same key, different amount");

  assert.equal((await http("POST", "/finance/payments/v2", T().acct, { invoice_id: S.inv1.id, amount: "250.01", method: "cash" })).status, 400, "overpayment");
  const p2 = await http("POST", "/finance/payments/v2", T().acct, { invoice_id: S.inv1.id, amount: "250.00", method: "bank_transfer", payment_date: await day(-2), reference: "WIRE-77" });
  assert.equal(p2.status, 201, JSON.stringify(p2.body));
  assert.equal(p2.body.invoice.remaining_amount, "0.00");
  assert.equal(p2.body.invoice.status, "Paid");
  S.pay2 = p2.body.payment;
  assert.equal((await http("POST", "/finance/payments/v2", T().acct, { invoice_id: S.inv1.id, amount: "1.00", method: "cash" })).status, 409, "paid invoice takes no more");

  const rc = await http("GET", `/finance/payments/${S.pay1.id}/receipt?lang=en`, T().acct);
  assert.equal(rc.status, 200);
  assert.match(String(rc.body), new RegExp(S.pay1.receipt_number));
});

test("A5: partial refund with the default rule returns money without reopening the debt", async () => {
  const r = await http("POST", `/finance/payments/${S.pay2.id}/refund`, T().acct, { amount: "50.00", reason: "Service partly not delivered" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.refund.reopen, false);
  assert.equal(r.body.invoice.remaining_amount, "0.00", "debt not reopened");
  assert.equal(r.body.invoice.status, "Paid", "only part of the money came back");
  assert.equal(r.body.invoice.balance.refunded, "50.00");
  S.refund1 = r.body.refund;
  assert.equal((await http("POST", `/finance/payments/${S.pay2.id}/refund`, T().acct, { amount: "200.01", reason: "too much" })).status, 400, "refund above the payment net");
  assert.equal((await http("POST", `/finance/payments/${S.pay2.id}/void`, T().acct, { reason: "x" })).status, 409, "a payment with refunds cannot be voided");
});

test("A6: a different invoice is voided (formula-looking reason kept as text); a void invoice takes no payment", async () => {
  const r = await http("POST", "/finance/invoices/v2", T().acct, { candidate_id: S.candB.id, currency: "TND", items: [{ description: "Mistaken invoice", quantity: "1", unit_price: "80.00" }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  S.invVoid = r.body;
  const v = await http("POST", `/finance/invoices/${r.body.id}/void`, T().acct, { reason: FORMULA });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.status, "Void");
  assert.equal((await http("POST", "/finance/payments/v2", T().acct, { invoice_id: r.body.id, amount: "10.00", method: "cash" })).status, 409);
  assert.equal((await http("POST", `/finance/invoices/${S.inv1.id}/void`, T().acct, { reason: "paid invoice" })).status, 409, "an invoice with live payments cannot be voided");
});

test("A7: second currency (EUR): payment, reopening refund, ageing, free-text and catalogue lines", async () => {
  const r = await http("POST", "/finance/invoices/v2", T().acct, { candidate_id: S.candA.id, currency: "EUR", due_date: await day(-20), items: [{ service_id: S.svcEur.id, quantity: "1" }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.total_amount, "200.00");
  S.invEur = r.body;
  const p = await http("POST", "/finance/payments/v2", T().acct, { invoice_id: r.body.id, amount: "75.50", method: "card", payment_date: await day(-1) });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.invoice.remaining_amount, "124.50");
  S.payEur = p.body.payment;
  const rf = await http("POST", `/finance/payments/${p.body.payment.id}/refund`, T().acct, { amount: "10.00", reason: "Card fee returned", reopen: true });
  assert.equal(rf.status, 201, JSON.stringify(rf.body));
  assert.equal(rf.body.refund.reopen, true);
  assert.equal(rf.body.invoice.remaining_amount, "134.50");
  assert.equal(rf.body.invoice.status, "Partial");
  S.refundEur = rf.body.refund;

  // candidate B: an open TND invoice (current, not yet due) and one without a due date, so every ageing bucket family is exercised
  const b1 = await http("POST", "/finance/invoices/v2", T().acct, { candidate_id: S.candB.id, currency: "TND", due_date: await day(30), items: [{ description: "Medical exam", quantity: "1", unit_price: "120.00" }] });
  assert.equal(b1.status, 201, JSON.stringify(b1.body));
  const b2 = await http("POST", "/finance/invoices/v2", T().acct, { candidate_id: S.candB.id, currency: "TND", due_date: await day(-100), items: [{ service_id: S.svc.id, quantity: "1" }, { description: "Courier", quantity: "3", unit_price: "0.10" }] });
  assert.equal(b2.status, 201, JSON.stringify(b2.body));
  assert.equal(b2.body.total_amount, "150.30");
  const b3 = await http("POST", "/finance/invoices/v2", T().acct, { candidate_id: S.candB.id, currency: "TND", items: [{ description: "Photos", quantity: "4", unit_price: "5.25" }] });
  assert.equal(b3.status, 201, JSON.stringify(b3.body));
  const pb = await http("POST", "/finance/payments/v2", T().acct, { invoice_id: b1.body.id, amount: "20.00", method: "mobile", payment_date: S.today });
  assert.equal(pb.status, 201, JSON.stringify(pb.body));
  const b4 = await http("POST", "/finance/invoices/v2", T().acct, { candidate_id: S.candB.id, currency: "TND", due_date: await day(-10), items: [{ description: "Apostille", quantity: "1", unit_price: "35.00" }] });
  assert.equal(b4.status, 201, JSON.stringify(b4.body));
  const b5 = await http("POST", "/finance/invoices/v2", T().acct, { candidate_id: S.candB.id, currency: "TND", due_date: await day(-70), items: [{ description: "Notary", quantity: "1", unit_price: "60.00" }] });
  assert.equal(b5.status, 201, JSON.stringify(b5.body));
  S.invB1 = b1.body;
  S.invB2 = b2.body;
  S.invB3 = b3.body;
});

// ================================================================ B  expenses
test("B1: expenses are recorded and one is voided", async () => {
  const mk = (o) => http("POST", "/finance/expenses", T().acct, { category_id: S.cat.id, payee: "Papeterie Centrale", ...o });
  const e1 = await mk({ title: "Printer paper", amount: "40.00", currency: "TND", spent_on: await day(-3) });
  assert.equal(e1.status, 201, JSON.stringify(e1.body));
  const e2 = await mk({ title: "Courier to Paris", amount: "15.25", currency: "EUR", spent_on: await day(-2) });
  assert.equal(e2.status, 201, JSON.stringify(e2.body));
  const e3 = await mk({ title: FORMULA, amount: "12.10", currency: "TND", spent_on: await day(-1), notes: "line one\nline, two \"quoted\"" });
  assert.equal(e3.status, 201, JSON.stringify(e3.body));
  const v = await http("POST", `/finance/expenses/${e2.body.id}/void`, T().acct, { reason: "Entered twice" });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal((await http("POST", `/finance/expenses/${e2.body.id}/void`, T().acct, { reason: "again" })).status, 409);
  assert.equal((await http("POST", "/finance/expenses", T().acct, { title: "x", amount: "1.00", currency: "USD", spent_on: S.today })).status, 400, "USD is not in FIN_CURRENCIES for this run");
  S.expVoided = e2.body.id;
  const list = await http("GET", "/finance/expenses?include_voided=true", T().acct);
  assert.equal(list.status, 200);
  assert.equal(list.body.rows.length, 3);
});

// ================================================================ C  legacy routes
test("C1: legacy POST /finance/invoices and /finance/payments still work and reach lists, reports and the ledger", async () => {
  const inv = await http("POST", "/finance/invoices", T().admin, { candidate_id: S.candC.id, total_amount: 90.5, currency: "tnd", due_date: await day(-45), notes: "legacy" });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.currency, "TND");
  S.legacyInv = inv.body;
  S.legacyInv.number = (await w.one("SELECT number FROM invoices WHERE id = $1", [inv.body.id])).number;
  assert.match(S.legacyInv.number, /^VITA-\d{4}-\d{6}$/, "the legacy route also numbers the invoice");
  const pay = await http("POST", "/finance/payments", T().acct, { invoice_id: inv.body.id, amount_paid: "30.25", payment_method: "Cash" });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  S.legacyPay = pay.body.payment;
  assert.equal(pay.body.invoice.remaining_amount, "60.25");
  assert.match((await w.one("SELECT receipt_number FROM payments WHERE id = $1", [pay.body.payment.id])).receipt_number, /^REC-\d{4}-\d{6}$/, "the legacy route also issues the receipt number");
  const got = await http("GET", `/finance/invoices/${inv.body.id}`, T().acct);
  assert.equal(got.body.remaining_amount, "60.25");
  assert.equal(got.body.status, "Partial");
  const list = await http("GET", `/finance/invoices?candidate_id=${S.candC.id}`, T().acct);
  assert.equal(list.body.total, 1);
  assert.equal(await w.count("SELECT count(*) AS n FROM fin_ledger WHERE (ref_table = 'invoices' AND ref_id = $1) OR (ref_table = 'payments' AND ref_id = $2)", [inv.body.id, pay.body.payment.id]), 2, "ledger rows for both");
  assert.equal((await http("POST", "/finance/payments", T().acct, { invoice_id: inv.body.id, amount_paid: "1000", payment_method: "cash" })).status, 400, "legacy overpayment refused");
  assert.equal((await http("POST", "/finance/invoices", T().acct, { candidate_id: S.candC.id, total_amount: "abc" })).status, 400, "400, not a database 500");
  // a pre-accounting style row (no number, no items, no ledger) is a legacy row: reports read the tables, so it counts
  const old = await w.one("INSERT INTO invoices (candidate_id, total_amount, remaining_amount, currency) VALUES ($1, 70, 70, 'TND') RETURNING id", [S.candC.id]);
  S.preexisting = old.id;
});

// ================================================================ D  parallel payments
test("D1: ten concurrent payments on one invoice never exceed the balance", async () => {
  const inv = await http("POST", "/finance/invoices/v2", T().acct, { candidate_id: S.candC.id, currency: "TND", items: [{ description: "Stress", quantity: "1", unit_price: "100.00" }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const res = await Promise.all(
    Array.from({ length: 10 }, (_, i) => http("POST", "/finance/payments/v2", T().acct, { invoice_id: inv.body.id, amount: "15.00", method: "cash", idempotency_key: `stress-${i}` }))
  );
  const ok = res.filter((r) => r.status === 201);
  const refused = res.filter((r) => r.status === 400 || r.status === 409);
  assert.equal(ok.length + refused.length, 10, `only 201/400/409: ${res.map((r) => r.status)}`);
  assert.equal(ok.length, 6, "6 x 15.00 = 90.00 fits in 100.00, a 7th would not");
  const after = await http("GET", `/finance/invoices/${inv.body.id}`, T().acct);
  assert.equal(after.body.remaining_amount, "10.00");
  assert.equal(after.body.status, "Partial");
  const paid = await w.one("SELECT SUM(amount_paid)::text AS s, count(*)::int AS n FROM payments WHERE invoice_id = $1", [inv.body.id]);
  assert.equal(paid.s, "90.00");
  assert.equal(paid.n, 6);
  assert.equal(new Set(ok.map((r) => r.body.payment.receipt_number)).size, 6, "receipt numbers are unique");
  S.stressInv = inv.body.id;
});

// ================================================================ E  reports, CSV, ledger: tie out against raw SQL
/** Raw rows, as text, straight from the tables (no report SQL reused). */
async function raw() {
  const invoices = (await w.q(`SELECT id, number, status, candidate_id, currency, total_amount::text AS total, remaining_amount::text AS remaining, created_by, subtotal::text AS subtotal, tax_amount::text AS tax,
      is_deleted, (voided_at IS NOT NULL) AS voided, to_char(COALESCE(issued_at AT TIME ZONE 'UTC', created_at), 'YYYY-MM-DD') AS d, to_char(due_date, 'YYYY-MM-DD') AS due, void_reason
      FROM invoices ORDER BY id`)).rows;
  const payments = (await w.q(`SELECT id, invoice_id, candidate_id, amount_paid::text AS amount, created_by, receipt_number, reference, payment_method, is_deleted, (voided_at IS NOT NULL) AS voided, to_char(payment_date, 'YYYY-MM-DD') AS d FROM payments ORDER BY id`)).rows;
  const refunds = (await w.q(`SELECT id, payment_id, invoice_id, amount::text AS amount, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM fin_refunds ORDER BY id`)).rows;
  const expenses = (await w.q(`SELECT id, title, currency, amount::text AS amount, is_deleted, (voided_at IS NOT NULL) AS voided, to_char(spent_on, 'YYYY-MM-DD') AS d FROM expenses ORDER BY id`)).rows;
  const items = (await w.q(`SELECT invoice_id, service_id, description, quantity::text AS quantity, line_total::text AS line_total FROM invoice_items ORDER BY id`)).rows;
  const ledger = (await w.q(`SELECT id, kind, ref_table, ref_id, candidate_id, currency, debit::text AS debit, credit::text AS credit FROM fin_ledger ORDER BY id`)).rows;
  const services = (await w.q(`SELECT id, code, name_en FROM fin_services`)).rows;
  const users = (await w.q(`SELECT id, full_name FROM users`)).rows;
  const cur = new Map(invoices.map((i) => [i.id, i.currency]));
  const liveInv = (i) => !i.is_deleted && !i.voided && i.status !== "Void";
  const livePay = (p) => !p.is_deleted && !p.voided;
  return { invoices, payments, refunds, expenses, items, ledger, services, users, cur, liveInv, livePay };
}
const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);
const currencies = (...lists) => [...new Set(lists.flat())].sort();

function expectSummary(R, from, to) {
  const out = new Map();
  const bucket = (c) => out.get(c) || out.set(c, { invoiced: 0n, collected: 0n, refunded: 0n, expenses: 0n }).get(c);
  for (const i of R.invoices) if (R.liveInv(i) && inRange(i.d, from, to)) bucket(i.currency).invoiced += cents(i.total);
  const payById = new Map(R.payments.map((p) => [p.id, p]));
  for (const p of R.payments) if (R.livePay(p) && inRange(p.d, from, to)) bucket(R.cur.get(p.invoice_id)).collected += cents(p.amount);
  for (const f of R.refunds) if (R.livePay(payById.get(f.payment_id)) && inRange(f.d, from, to)) bucket(R.cur.get(f.invoice_id)).refunded += cents(f.amount);
  for (const e of R.expenses) if (!e.is_deleted && !e.voided && inRange(e.d, from, to)) bucket(e.currency).expenses += cents(e.amount);
  return [...out.keys()].sort().map((c) => {
    const b = out.get(c);
    return { currency: c, invoiced: fmt(b.invoiced), collected: fmt(b.collected), refunded: fmt(b.refunded), expenses: fmt(b.expenses), net: fmt(b.collected - b.refunded - b.expenses) };
  });
}

test("E1: reports/summary equals raw rows per currency (all time and a date window), EUR separate from TND", async () => {
  const R = await raw();
  const all = await http("GET", "/finance/reports/summary", T().acct);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.rows, expectSummary(R, null, null));
  assert.deepEqual(all.body.rows.map((r) => r.currency), ["EUR", "TND"], "currencies are never merged");
  const eur = all.body.rows.find((r) => r.currency === "EUR");
  assert.deepEqual({ ...eur }, { currency: "EUR", invoiced: "200.00", collected: "75.50", refunded: "10.00", expenses: "0.00", net: "65.50" }, "voided EUR expense is out");
  const from = await day(-10);
  const to = await day(-2);
  const win = await http("GET", `/finance/reports/summary?from=${from}&to=${to}`, T().mgr);
  assert.equal(win.status, 200);
  assert.deepEqual(win.body.rows, expectSummary(R, from, to));
  assert.notDeepEqual(win.body.rows, all.body.rows, "the window really filters");
  // the legacy dashboard totals tie to the same rows (summed over currencies, as it always did)
  const dash = (await http("GET", "/finance/dashboard", T().acct)).body;
  assert.equal(cents(String(dash.total_in)), all.body.rows.reduce((t, r) => t + cents(r.collected) - cents(r.refunded), 0n), "money in = collected - refunded");
  assert.equal(cents(String(dash.total_out)), all.body.rows.reduce((t, r) => t + cents(r.expenses), 0n));
});

test("E2: reports/receivables ageing and balances equal raw rows (asOf injected)", async () => {
  const R = await raw();
  const asOf = S.today;
  const got = await http("GET", `/finance/reports/receivables?asOf=${asOf}&limit=100`, T().acct);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.body.asOf, asOf);
  const open = R.invoices.filter((i) => R.liveInv(i) && i.status !== "Draft" && cents(i.remaining) > 0n);
  const dayN = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;
  const expected = currencies(open.map((i) => i.currency)).map((c) => {
    const rows = open.filter((i) => i.currency === c);
    const b = { current: 0n, "0-30": 0n, "31-60": 0n, "61-90": 0n, "90+": 0n, no_due_date: 0n };
    for (const i of rows) {
      const k = i.due === null ? "no_due_date" : dayN(i.due) >= dayN(asOf) ? "current" : dayN(asOf) - dayN(i.due) <= 30 ? "0-30" : dayN(asOf) - dayN(i.due) <= 60 ? "31-60" : dayN(asOf) - dayN(i.due) <= 90 ? "61-90" : "90+";
      b[k] += cents(i.remaining);
    }
    return { currency: c, total: fmt(sum(rows, (i) => i.remaining)), count: rows.length, buckets: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, fmt(v)])) };
  });
  assert.deepEqual(got.body.currencies, expected);
  // every bucket family is non-trivially covered by the journey
  const tnd = got.body.currencies.find((c) => c.currency === "TND").buckets;
  for (const k of ["current", "0-30", "31-60", "90+", "no_due_date"]) assert.notEqual(tnd[k], "0.00", `TND ${k} bucket is exercised`);
  assert.equal(got.body.currencies.find((c) => c.currency === "EUR").buckets["0-30"], "134.50");
  const perCand = currencies(open.map((i) => `${i.candidate_id}|${i.currency}`)).map((k) => {
    const [cand, cur] = k.split("|");
    return { candidate_id: Number(cand), currency: cur, balance: fmt(sum(open.filter((i) => String(i.candidate_id) === cand && i.currency === cur), (i) => i.remaining)) };
  });
  assert.deepEqual(
    got.body.rows.map((r) => ({ candidate_id: Number(r.candidate_id), currency: r.currency, balance: r.balance })).sort((a, b) => `${a.candidate_id}${a.currency}`.localeCompare(`${b.candidate_id}${b.currency}`)),
    perCand.sort((a, b) => `${a.candidate_id}${a.currency}`.localeCompare(`${b.candidate_id}${b.currency}`))
  );
  assert.ok(open.some((i) => i.id === S.preexisting), "the legacy row (no number, no ledger) is a receivable too");
});

test("E3: reports/by-service and by-staff equal raw rows", async () => {
  const R = await raw();
  const svcName = new Map(R.services.map((s) => [String(s.id), s.name_en]));
  const invById = new Map(R.invoices.map((i) => [i.id, i]));
  const live = R.items.filter((it) => R.liveInv(invById.get(it.invoice_id)));
  const groups = new Map();
  for (const it of live) {
    const cur = invById.get(it.invoice_id).currency;
    const label = it.service_id === null ? it.description : svcName.get(String(it.service_id));
    const key = `${cur}|${it.service_id === null ? "" : it.service_id}|${label}`;
    const g = groups.get(key) || { currency: cur, label, lines: 0, total: 0n };
    g.lines += 1;
    g.total += cents(it.line_total);
    groups.set(key, g);
  }
  const bs = await http("GET", "/finance/reports/by-service", T().acct);
  assert.equal(bs.status, 200, JSON.stringify(bs.body));
  const norm = (rows) => rows.map((r) => `${r.currency}|${r.label}|${r.lines}|${r.total}`).sort();
  assert.deepEqual(norm(bs.body.rows), norm([...groups.values()].map((g) => ({ ...g, total: fmt(g.total) }))));
  assert.ok(bs.body.rows.some((r) => r.code === "VISA-FILE" && r.currency === "TND" && r.total === "450.00"), "VISA-FILE: 2 x 150 on the first invoice + 1 x 150 on candidate B's");

  const staff = await http("GET", "/finance/reports/by-staff", T().mgr);
  assert.equal(staff.status, 200, JSON.stringify(staff.body));
  const uname = new Map(R.users.map((u) => [u.id, u.full_name]));
  const keys = new Map();
  const get = (u, c) => keys.get(`${u}|${c}`) || keys.set(`${u}|${c}`, { user_id: u, currency: c, ic: 0, it: 0n, pc: 0, pt: 0n }).get(`${u}|${c}`);
  for (const i of R.invoices) if (R.liveInv(i)) { const g = get(i.created_by, i.currency); g.ic += 1; g.it += cents(i.total); }
  for (const p of R.payments) if (R.livePay(p)) { const g = get(p.created_by, R.cur.get(p.invoice_id)); g.pc += 1; g.pt += cents(p.amount); }
  const exp = [...keys.values()].map((g) => `${g.user_id}|${uname.get(g.user_id) ?? ""}|${g.currency}|${g.ic}|${fmt(g.it)}|${g.pc}|${fmt(g.pt)}`).sort();
  const got = staff.body.rows.map((r) => `${r.user_id}|${r.user_name ?? ""}|${r.currency}|${r.invoices_count}|${r.invoices_total}|${r.payments_count}|${r.payments_total}`).sort();
  assert.deepEqual(got, exp);
  assert.ok(new Set(staff.body.rows.map((r) => r.user_id)).size >= 2, "two staff members (Accountant and Admin) appear");
});

test("E4: candidate statement equals raw rows, running balance per currency", async () => {
  const R = await raw();
  const stmt = await http("GET", `/finance/reports/candidate/${S.candA.id}`, T().acct);
  assert.equal(stmt.status, 200, JSON.stringify(stmt.body));
  const inv = R.invoices.filter((i) => String(i.candidate_id) === String(S.candA.id) && R.liveInv(i));
  const pay = R.payments.filter((p) => String(p.candidate_id) === String(S.candA.id) && R.livePay(p));
  const payById = new Map(R.payments.map((p) => [p.id, p]));
  const ref = R.refunds.filter((f) => String(payById.get(f.payment_id).candidate_id) === String(S.candA.id) && R.livePay(payById.get(f.payment_id)));
  assert.equal(stmt.body.entries.length, inv.length + pay.length + ref.length);
  for (const c of currencies(inv.map((i) => i.currency))) {
    const debit = sum(inv.filter((i) => i.currency === c), (i) => i.total) + sum(ref.filter((f) => R.cur.get(f.invoice_id) === c), (f) => f.amount);
    const credit = sum(pay.filter((p) => R.cur.get(p.invoice_id) === c), (p) => p.amount);
    const b = stmt.body.balances.find((x) => x.currency === c);
    assert.equal(b.balance, fmt(debit - credit), `${c} statement balance = invoiced - paid + refunded`);
    assert.equal(b.open, fmt(sum(inv.filter((i) => i.currency === c), (i) => i.remaining)));
    const last = stmt.body.entries.filter((e) => e.currency === c).at(-1);
    assert.equal(last.balance, b.balance, "last running balance = balance");
  }
  assert.equal(stmt.body.balances.find((x) => x.currency === "TND").balance, fmt(35000n - 35000n + 5000n), "TND: 350 invoiced - 350 paid + 50 refunded");
  assert.equal((await http("GET", "/finance/reports/candidate/999999", T().acct)).status, 404);
});

test("E5: CSV exports parse back to the same rows; formula cells neutralised; audited", async () => {
  const R = await raw();
  const get = async (kind, q = "", tok = T().acct) => {
    const res = await fetch(`${w.base}/finance/export/${kind}.csv${q}`, { headers: { authorization: `Bearer ${tok}` } });
    return { status: res.status, headers: res.headers, text: Buffer.from(await res.arrayBuffer()).toString("utf8") }; // Buffer keeps the BOM that res.text() would strip
  };
  const inv = await get("invoices");
  assert.equal(inv.status, 200);
  assert.match(inv.headers.get("content-type"), /^text\/csv/);
  assert.equal(inv.headers.get("x-row-limit-hit"), null);
  const invRows = parseCsv(inv.text);
  const liveOrVoid = R.invoices.filter((i) => !i.is_deleted);
  assert.equal(invRows.length, liveOrVoid.length, "void invoices are exported too");
  for (const i of liveOrVoid) {
    const row = invRows.find((r) => r.number === (i.number ?? "") && (i.number !== null || r.candidate_id === String(i.candidate_id)));
    assert.ok(row, `invoice ${i.id} present`);
  }
  const byNumber = new Map(invRows.map((r) => [r.number, r]));
  for (const i of liveOrVoid.filter((x) => x.number)) {
    const r = byNumber.get(i.number);
    assert.deepEqual({ status: r.status, currency: r.currency, total: r.total_amount, remaining: r.remaining_amount, subtotal: r.subtotal, tax: r.tax_amount }, { status: i.status, currency: i.currency, total: i.total, remaining: i.remaining, subtotal: i.subtotal, tax: i.tax });
  }
  const voided = byNumber.get(S.invVoid.number);
  assert.equal(voided.void_reason, `'${FORMULA}`, "formula-looking void reason neutralised with a leading quote");
  assert.ok(voided.voided_at);

  const pay = await get("payments");
  const payRows = parseCsv(pay.text);
  assert.equal(payRows.length, R.payments.filter((p) => !p.is_deleted).length);
  for (const p of R.payments.filter((x) => !x.is_deleted && x.receipt_number)) {
    const r = payRows.find((x) => x.receipt_number === p.receipt_number);
    assert.ok(r, `payment ${p.receipt_number}`);
    assert.equal(r.amount_paid, p.amount);
    assert.equal(r.currency, R.cur.get(p.invoice_id));
    assert.equal(r.payment_date, p.d);
  }
  assert.equal(payRows.find((r) => r.receipt_number === S.pay1.receipt_number).reference, `'${CMD}`, "payment reference neutralised");
  assert.equal(payRows.find((r) => r.receipt_number === S.pay2.receipt_number).refunded, "50.00");

  const exp = await get("expenses");
  const expRows = parseCsv(exp.text);
  assert.equal(expRows.length, R.expenses.length);
  const formulaRow = expRows.find((r) => r.title === `'${FORMULA}`);
  assert.ok(formulaRow, "expense title neutralised");
  assert.equal(formulaRow.notes, "line one\nline, two \"quoted\"", "embedded newline, comma and quotes survive the round trip");
  assert.equal(sum(expRows.filter((r) => !r.voided_at && r.currency === "TND"), (r) => r.amount), sum(R.expenses.filter((e) => !e.voided && e.currency === "TND"), (e) => e.amount));
  assert.ok(expRows.find((r) => r.id === String(S.expVoided)).voided_at, "voided expense exported with its void columns");

  for (const text of [inv.text, pay.text, exp.text]) for (const row of parseCsv(text)) for (const v of Object.values(row)) assert.doesNotMatch(v, /^[=+\-@\t\r]/, `cell ${JSON.stringify(v)} is neutralised`);

  // date window
  const from = await day(-10);
  const to = await day(-2);
  const win = parseCsv((await get("payments", `?from=${from}&to=${to}`)).text);
  assert.deepEqual(win.map((r) => r.receipt_number).sort(), R.payments.filter((p) => !p.is_deleted && inRange(p.d, from, to)).map((p) => p.receipt_number ?? "").sort());

  // row cap: cut at the cap with the header
  process.env.FIN_EXPORT_MAX_ROWS = "2";
  try {
    const cut = await get("expenses");
    assert.equal(cut.headers.get("x-row-limit-hit"), "true");
    assert.equal(parseCsv(cut.text).length, 2);
  } finally {
    process.env.FIN_EXPORT_MAX_ROWS = "1000";
  }
  assert.equal(await w.count("SELECT count(*) AS n FROM audit_logs WHERE action = 'EXPORT' AND table_name IN ('invoices','payments','expenses')"), 5, "every export is audited (five accountant exports so far)");
});

test("E6: ledger sums per invoice match the documented identity; the ledger is insert-only", async () => {
  const R = await raw();
  const payById = new Map(R.payments.map((p) => [String(p.id), p]));
  const refundNoReopen = new Map([[String(S.pay2.invoice_id), cents(S.refund1.amount)]]); // the only refund without reopen
  const perInvoice = new Map();
  const add = (invId, c) => perInvoice.set(invId, (perInvoice.get(invId) || 0n) + c);
  const refById = new Map(R.refunds.map((f) => [String(f.id), f]));
  const invOf = (map, id) => String(map.get(String(id)).invoice_id);
  for (const l of R.ledger) {
    if (l.ref_table === "expenses") continue; // expense rows (kind expense, and the void credit that reverses one) are not invoice money
    const net = cents(l.debit) - cents(l.credit);
    if (l.ref_table === "invoices") add(String(l.ref_id), net);
    else if (l.ref_table === "payments") add(invOf(payById, l.ref_id), net);
    else if (l.ref_table === "fin_refunds") add(invOf(refById, l.ref_id), net);
    else assert.fail(`unexpected ledger ref_table ${l.ref_table}`);
  }
  let checked = 0;
  for (const i of R.invoices) {
    if (!i.number) continue; // this row is inserted by SQL after the migrations ran, so it has neither a number nor ledger rows (migration 017 backfills real pre-016 rows; see fin-schema)
    const ledger = perInvoice.get(String(i.id)) || 0n;
    if (i.status === "Void") {
      assert.equal(ledger, 0n, `void invoice ${i.number}: debit and reversal net to zero`);
      checked++;
      continue;
    }
    const paid = sum(R.payments.filter((p) => p.invoice_id === i.id && R.livePay(p)), (p) => p.amount);
    const refunded = sum(R.refunds.filter((f) => f.invoice_id === i.id && R.livePay(payById.get(String(f.payment_id)))), (f) => f.amount);
    assert.equal(ledger, cents(i.total) - paid + refunded, `${i.number}: ledger = total - live paid + refunded`);
    assert.equal(ledger, cents(i.remaining) + (refundNoReopen.get(String(i.id)) || 0n), `${i.number}: ledger = remaining + refunds made without reopen`);
    checked++;
  }
  assert.ok(checked >= 8, `identity checked on ${checked} invoices`);
  const wholly = await w.one("SELECT count(*)::int AS n FROM fin_ledger WHERE kind = 'expense'");
  assert.ok(wholly.n >= 3, "expenses and the expense void are in the ledger");
  await assert.rejects(w.q("UPDATE fin_ledger SET debit = 0 WHERE id = (SELECT min(id) FROM fin_ledger)"), /insert-only|not allowed|reject/i);
  await assert.rejects(w.q("DELETE FROM fin_ledger"), /insert-only|not allowed|reject/i);
  await assert.rejects(w.q("TRUNCATE fin_ledger"), /insert-only|not allowed|reject/i);
});

// ================================================================ F  candidate
test("F1: the candidate (real OTP login) sees only its own invoices and cannot print another candidate's", async () => {
  const mine = await http("GET", "/finance/me", S.candA.token);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const dbIds = (await w.q("SELECT id FROM invoices WHERE candidate_id = $1 AND is_deleted = false AND status <> 'Draft' ORDER BY id", [S.candA.id])).rows.map((r) => r.id);
  assert.deepEqual(mine.body.invoices.map((i) => i.id).sort((a, b) => a - b), dbIds);
  const raw = JSON.stringify(mine.body);
  for (const secret of ["INTERNAL-STAFF-NOTE", S.invB1.number, S.invB2.number, S.legacyInv.number, "created_by", "void_reason", "WIRE-77", CMD]) assert.ok(!raw.includes(secret), `leaks ${secret}`);
  assert.deepEqual(E.staffOnlyKeys(mine.body), []);
  const tnd = mine.body.totals.find((t) => t.currency === "TND");
  assert.deepEqual({ ...tnd }, { currency: "TND", invoiced: "350.00", paid: "350.00", refunded: "50.00", remaining: "0.00" });
  const eur = mine.body.totals.find((t) => t.currency === "EUR");
  assert.equal(eur.remaining, "134.50");

  const own = await fetch(`${w.base}/finance/me/invoices/${S.inv1.id}/print?lang=fr`, { headers: { authorization: `Bearer ${S.candA.token}` } });
  assert.equal(own.status, 200);
  const html = await own.text();
  assert.match(html, new RegExp(S.inv1.number));
  assert.ok(!html.includes("INTERNAL-STAFF-NOTE"));
  const foreign = await fetch(`${w.base}/finance/me/invoices/${S.invB1.id}/print`, { headers: { authorization: `Bearer ${S.candA.token}` } });
  const missing = await fetch(`${w.base}/finance/me/invoices/99999999/print`, { headers: { authorization: `Bearer ${S.candA.token}` } });
  const draftLike = await fetch(`${w.base}/finance/me/invoices/abc/print`, { headers: { authorization: `Bearer ${S.candA.token}` } });
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(await foreign.text(), await missing.text(), "a foreign invoice answers exactly like a missing one");
  assert.ok([400, 404].includes(draftLike.status));

  const b = await http("GET", "/finance/me", S.candB.token);
  assert.ok(b.body.invoices.every((i) => ![S.inv1.number, S.invEur.number].includes(i.number)), "B sees nothing of A");
  assert.ok(b.body.invoices.length >= 3);

  for (const u of ["/finance/invoices", "/finance/dashboard", "/finance/reports/summary", "/finance/export/invoices.csv", `/finance/invoices/${S.inv1.id}`, `/finance/payments/${S.pay1.id}/receipt`, "/finance/services"]) {
    assert.equal((await http("GET", u, S.candA.token)).status, 403, `candidate denied on ${u}`);
  }
  assert.equal((await http("POST", "/finance/payments/v2", S.candA.token, { invoice_id: S.inv1.id, amount: "1", method: "cash" })).status, 403);
  assert.equal((await http("GET", "/finance/me", T().acct)).status, 403, "staff do not use /me");
  assert.equal((await http("GET", "/finance/me", null)).status, 401);
});

// ================================================================ G  role matrix
test("G1: Manager reads and exports but cannot write, void or refund", async () => {
  for (const u of ["/finance/invoices", `/finance/invoices/${S.inv1.id}`, `/finance/invoices/${S.inv1.id}/print`, "/finance/services", "/finance/expenses", "/finance/expense-categories", "/finance/payments", `/finance/payments/${S.pay1.id}/receipt`, "/finance/reports/summary", "/finance/reports/receivables", "/finance/reports/by-service", "/finance/reports/by-staff", `/finance/reports/candidate/${S.candA.id}`, "/finance/dashboard"]) {
    assert.equal((await http("GET", u, T().mgr)).status, 200, `Manager reads ${u}`);
  }
  for (const k of ["invoices", "payments", "expenses"]) {
    const res = await fetch(`${w.base}/finance/export/${k}.csv`, { headers: { authorization: `Bearer ${T().mgr}` } });
    assert.equal(res.status, 200, `Manager exports ${k}`);
  }
  const before = {
    inv: await w.count("SELECT count(*) AS n FROM invoices"),
    pay: await w.count("SELECT count(*) AS n FROM payments"),
    led: await w.count("SELECT count(*) AS n FROM fin_ledger"),
  };
  const denied = [
    ["POST", "/finance/services", { code: "NOPE", default_price: "1.00" }],
    ["PATCH", `/finance/services/${S.svc.id}`, { default_price: "1.00" }],
    ["POST", "/finance/invoices/v2", { candidate_id: S.candA.id, currency: "TND", items: [{ description: "x", quantity: "1", unit_price: "1.00" }] }],
    ["POST", "/finance/invoices", { candidate_id: S.candA.id, total_amount: "5" }],
    ["POST", "/finance/payments/v2", { invoice_id: S.invB1.id, amount: "1.00", method: "cash" }],
    ["POST", "/finance/payments", { invoice_id: S.invB1.id, amount_paid: "1.00", payment_method: "cash" }],
    ["POST", `/finance/payments/${S.pay1.id}/refund`, { amount: "1.00", reason: "x" }],
    ["POST", `/finance/payments/${S.pay1.id}/void`, { reason: "x" }],
    ["POST", `/finance/invoices/${S.invB1.id}/void`, { reason: "x" }],
    ["POST", "/finance/expenses", { title: "x", amount: "1.00", currency: "TND", spent_on: S.today }],
    ["POST", `/finance/expenses/${S.expVoided}/void`, { reason: "x" }],
    ["POST", "/finance/expense-categories", { name: "Nope" }],
  ];
  for (const [m, u, b] of denied) assert.equal((await http(m, u, T().mgr, b)).status, 403, `Manager ${m} ${u}`);
  assert.equal(await w.count("SELECT count(*) AS n FROM invoices"), before.inv);
  assert.equal(await w.count("SELECT count(*) AS n FROM payments"), before.pay);
  assert.equal(await w.count("SELECT count(*) AS n FROM fin_ledger"), before.led, "refused writes leave no ledger row");
});

test("G2: Agent, Receptionist, HR, Employer, Agency and anonymous are denied on /finance/*", async () => {
  const emp = await createEmployerUser(w.pool, { orgName: "Fin Employer" });
  const ag = await createAgencyUser(w.pool, { orgName: "Fin Agency" });
  const actors = { Agent: T().agent, Receptionist: T().rec, HR: T().hr, Employer: emp.token, Agency: ag.token };
  const gets = ["/finance/dashboard", "/finance/invoices", `/finance/invoices/${S.inv1.id}`, "/finance/services", "/finance/expenses", "/finance/payments", "/finance/reports/summary", "/finance/reports/receivables", `/finance/reports/candidate/${S.candA.id}`, "/finance/export/invoices.csv", "/finance/export/payments.csv", "/finance/me"];
  const posts = [
    ["POST", "/finance/invoices/v2", { candidate_id: S.candA.id, currency: "TND", items: [{ description: "x", quantity: "1", unit_price: "1.00" }] }],
    ["POST", "/finance/payments/v2", { invoice_id: S.invB1.id, amount: "1.00", method: "cash" }],
    ["POST", "/finance/invoices", { candidate_id: S.candA.id, total_amount: "5" }],
    ["POST", "/finance/payments", { invoice_id: S.invB1.id, amount_paid: "1", payment_method: "cash" }],
    ["POST", `/finance/payments/${S.pay1.id}/refund`, { amount: "1.00", reason: "x" }],
    ["POST", `/finance/invoices/${S.invB1.id}/void`, { reason: "x" }],
    ["POST", "/finance/expenses", { title: "x", amount: "1.00", currency: "TND", spent_on: S.today }],
  ];
  const ledgerBefore = await w.count("SELECT count(*) AS n FROM fin_ledger");
  for (const [name, tok] of Object.entries(actors)) {
    for (const u of gets) assert.equal((await http("GET", u, tok)).status, 403, `${name} GET ${u}`);
    for (const [m, u, b] of posts) assert.equal((await http(m, u, tok, b)).status, 403, `${name} ${m} ${u}`);
  }
  for (const u of gets) assert.equal((await http("GET", u, null)).status, 401, `anonymous GET ${u}`);
  assert.equal((await http("POST", "/finance/payments/v2", null, posts[1][2])).status, 401);
  assert.equal(await w.count("SELECT count(*) AS n FROM fin_ledger"), ledgerBefore);
});

// ================================================================ H  sweep
test("H1: the all-routes authorization sweep file still passes", () => {
  const r = spawnSync(process.execPath, ["--test", path.join(__dirname, "orgs-route-sweep.test.js")], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", NODE_TEST_CONTEXT: undefined }, timeout: 240000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /# pass [1-9]/, "the sweep actually ran");
  assert.match(r.stdout, /# fail 0/);
});
