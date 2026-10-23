// Stage 4, Task 3: payments with receipts, idempotency, refunds, payment void, receipts (HTML) and hardened legacy routes.
//
// Ledger logic used by the tests (fin_ledger is insert-only, debit/credit per posting):
//   invoice   -> debit  = total                      (ref invoices)
//   payment   -> credit = amount                     (ref payments)
//   void pay  -> debit  = amount  (reversal)         (ref payments)
//   refund    -> debit  = amount                     (ref fin_refunds)
//   void inv  -> credit = total   (reversal)         (ref invoices)
// so for one invoice  ledger_balance = SUM(debit) - SUM(credit) = total - live_paid + refunded.
// invoices.remaining_amount does NOT move on a refund unless reopen:true was passed (money went back to the
// candidate, the debt is not reopened), hence   ledger_balance = remaining_amount + refunds_without_reopen.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");
const { validatePaymentAmount } = require("../utils/finance");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "fin-payments-test-secret";
delete process.env.FIN_TAX_RATE_PERCENT;
delete process.env.FIN_COMPANY_NAME;
delete process.env.FIN_COMPANY_ADDRESS;
delete process.env.FIN_COMPANY_TAX_ID;
delete process.env.FIN_CURRENCIES;

async function withWorld(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = (sql, p) => pool.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  const http = async (method, url, token, body, raw) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined && raw === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const roles = { sa: "SuperAdmin", admin: "Admin", acct: "Accountant", mgr: "Manager", agent: "Agent", rec: "Receptionist", hr: "HR", cand: "Candidate" };
  const ids = {};
  const T = {};
  for (const [k, role] of Object.entries(roles)) {
    ids[k] = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`${role} ${k}`, `${k}@finpay.test.invalid`, role])).id;
    T[k] = jwt.sign({ id: ids[k], role, ...(k === "cand" ? { tv: 0 } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" });
  }
  T.emp = (await createEmployerUser(pool)).token;
  T.agy = (await createAgencyUser(pool)).token;
  let n = 0;
  const candidate = async (name = "Amine Trabelsi") => {
    n += 1;
    return (await one("INSERT INTO candidates (full_name, passport_number) VALUES ($1,$2) RETURNING id", [name, `PAY${process.pid}-${n}`])).id;
  };
  /** Creates a Pending invoice (one line) through the v2 API and returns it. */
  const invoice = async (total = "100.00", over = {}) => {
    const c = over.candidate_id || (await candidate());
    const r = await http("POST", "/finance/invoices/v2", T.acct, { candidate_id: c, currency: "TND", items: [{ description: "Service", quantity: 1, unit_price: total }], ...over });
    assert.equal(r.status, 201, r.text);
    return r.body;
  };
  const pay = (invoice_id, amount, extra = {}, token = T.acct) => http("POST", "/finance/payments/v2", token, { invoice_id, amount, method: "cash", ...extra });
  const refund = (paymentId, amount, extra = {}, token = T.acct) => http("POST", `/finance/payments/${paymentId}/refund`, token, { amount, reason: "customer request", ...extra });
  const voidPay = (paymentId, reason = "entered twice", token = T.acct) => http("POST", `/finance/payments/${paymentId}/void`, token, { reason });
  const inv = async (id) => (await http("GET", `/finance/invoices/${id}`, T.acct)).body;
  /** SUM(debit) - SUM(credit) over every ledger row that belongs to the invoice (itself, its payments, its refunds). */
  const ledgerBalance = async (invoiceId) =>
    (
      await one(
        `SELECT (COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0))::text AS bal FROM fin_ledger
          WHERE (ref_table='invoices' AND ref_id=$1)
             OR (ref_table='payments' AND ref_id IN (SELECT id FROM payments WHERE invoice_id=$1))
             OR (ref_table='fin_refunds' AND ref_id IN (SELECT id FROM fin_refunds WHERE invoice_id=$1))`,
        [invoiceId]
      )
    ).bal;
  try {
    await fn({ pool, http, q, one, T, ids, candidate, invoice, pay, refund, voidPay, inv, ledgerBalance, base });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

const dayOffset = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------------------ happy path
test("payment: partial then full, receipt number, ledger credit, audit, invoice status derived in SQL", () =>
  withWorld(async ({ http, T, invoice, pay, inv, q, ledgerBalance, ids }) => {
    const i = await invoice("100.00");
    const year = new Date().getUTCFullYear();
    const a = await pay(i.id, "40", { reference: "BNK-77", notes: "first part", method: "bank_transfer" });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.body.replayed, false);
    assert.equal(a.body.payment.amount_paid, "40.00");
    assert.equal(a.body.payment.receipt_number, `REC-${year}-000001`);
    assert.equal(a.body.payment.payment_method, "bank_transfer");
    assert.equal(a.body.payment.reference, "BNK-77");
    assert.equal(a.body.payment.invoice_id, i.id);
    assert.equal(a.body.invoice.remaining_amount, "60.00");
    assert.equal(a.body.invoice.status, "Partial");
    assert.equal(a.body.payment.created_by, ids.acct);
    const b = await pay(i.id, 60);
    assert.equal(b.status, 201);
    assert.equal(b.body.payment.receipt_number, `REC-${year}-000002`);
    assert.equal(b.body.invoice.remaining_amount, "0.00");
    assert.equal(b.body.invoice.status, "Paid");
    const d = await inv(i.id);
    assert.equal(d.payments.length, 2);
    assert.deepEqual([d.balance.paid, d.balance.net_paid, d.balance.remaining], ["100.00", "100.00", "0.00"]);
    // ledger: invoice debit 100, two payment credits, balance 0
    const led = (await q("SELECT kind, debit::text d, credit::text c, candidate_id, currency, actor_id FROM fin_ledger WHERE ref_table='payments' ORDER BY id")).rows;
    assert.deepEqual(led.map((r) => [r.kind, r.d, r.c, r.currency]), [["payment", "0.00", "40.00", "TND"], ["payment", "0.00", "60.00", "TND"]]);
    assert.equal(Number(led[0].candidate_id), i.candidate_id);
    assert.equal(Number(led[0].actor_id), ids.acct);
    assert.equal(await ledgerBalance(i.id), "0.00");
    // audit rows written with the transaction
    assert.equal(Number((await q("SELECT count(*) n FROM audit_logs WHERE table_name='payments' AND action='CREATE'")).rows[0].n), 2);
    assert.ok(Number((await q("SELECT count(*) n FROM audit_logs WHERE table_name='invoices' AND record_id=$1 AND action='UPDATE'", [String(i.id)])).rows[0].n) >= 2);
    // today's payment_date by default
    assert.match(a.body.payment.payment_date, /^\d{4}-\d{2}-\d{2}$/);
    void http; void T;
  }));

test("exact decimals: 3 x 33.33 on 100.00 leaves 0.01; 0.10 + 0.20 settles 0.30 exactly", () =>
  withWorld(async ({ invoice, pay, inv }) => {
    const i = await invoice("100.00");
    for (let k = 0; k < 3; k++) assert.equal((await pay(i.id, "33.33")).status, 201);
    const d = await inv(i.id);
    assert.equal(d.remaining_amount, "0.01");
    assert.equal(d.status, "Partial");
    const last = await pay(i.id, "0.01");
    assert.equal(last.body.invoice.remaining_amount, "0.00");
    assert.equal(last.body.invoice.status, "Paid");
    const j = await invoice("0.30");
    assert.equal((await pay(j.id, 0.1)).body.invoice.remaining_amount, "0.20");
    const z = await pay(j.id, 0.2);
    assert.deepEqual([z.body.invoice.remaining_amount, z.body.invoice.status], ["0.00", "Paid"]);
  }));

// ------------------------------------------------------------------------------------------------ validation
test("payment validation: amount, method, dates, lengths, unknown fields, ids", () =>
  withWorld(async ({ http, T, invoice, pay, inv, q }) => {
    const i = await invoice("500.00");
    const post = (b, t = T.acct) => http("POST", "/finance/payments/v2", t, b);
    for (const amount of [0, "0", "0.00", -1, "-5", "1e3", 1e21, "NaN", "Infinity", "1.234", "1,5", "", " ", null, undefined, {}, [], true, "9999999999999.00", "0x10"]) {
      const r = await post({ invoice_id: i.id, method: "cash", amount });
      assert.equal(r.status, 400, `amount ${JSON.stringify(amount)}`);
    }
    for (const method of ["Cash", "CASH", "crypto", "", null, undefined, 5, "bank transfer"]) assert.equal((await post({ invoice_id: i.id, amount: "1", method })).status, 400, `method ${method}`);
    for (const m of ["cash", "bank_transfer", "card", "mobile", "cheque", "other"]) assert.equal((await post({ invoice_id: i.id, amount: "1", method: m })).status, 201, m);
    for (const bad of [{ extra: 1 }, { reference: "r".repeat(121) }, { notes: "n".repeat(501) }, { idempotency_key: "k".repeat(101) }, { reference: 5 }, { notes: {} }, { idempotency_key: 7 }, { idempotency_key: "bad\u0000key" }]) {
      assert.equal((await post({ invoice_id: i.id, amount: "1", method: "cash", ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await post({ invoice_id: i.id, amount: "1", method: "cash", reference: "r".repeat(120), notes: "n".repeat(500), idempotency_key: "k".repeat(100) })).status, 201);
    // dates
    const withDate = (payment_date) => post({ invoice_id: i.id, amount: "1", method: "cash", payment_date });
    for (const d of ["2026-02-30", "26-01-01", "yesterday", 20260101, "2026-13-01", dayOffset(2), dayOffset(400), dayOffset(-400), "2001-01-01"]) assert.equal((await withDate(d)).status, 400, String(d));
    assert.equal((await withDate(dayOffset(1))).status, 201, "one day ahead tolerated (time zones)");
    const ok = await withDate(dayOffset(-300));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.payment.payment_date, dayOffset(-300));
    // an old invoice: dates before issue date - 1 year refused, within a year accepted
    await q("UPDATE invoices SET issued_at = now() - interval '3 years', created_at = now() - interval '3 years' WHERE id=$1", [i.id]);
    assert.equal((await withDate(dayOffset(-365 * 4 - 30))).status, 400, "more than a year before issue");
    assert.equal((await withDate(dayOffset(-365 * 3 - 100))).status, 201, "within a year before issue");
    // ids
    for (const invoice_id of [undefined, null, "abc", -1, 0, 1.5, "1; DROP TABLE x", [1]]) assert.equal((await post({ invoice_id, amount: "1", method: "cash" })).status, 400, JSON.stringify(invoice_id));
    assert.equal((await post({ invoice_id: 99999999, amount: "1", method: "cash" })).status, 404);
    assert.equal((await post(null)).status, 400);
    assert.equal((await post(undefined)).status, 400);
    assert.equal((await http("POST", "/finance/payments/v2", T.acct, undefined, "{bad json")).status, 400);
    // a soft-deleted invoice is not found
    const gone = await invoice("10.00");
    await q("UPDATE invoices SET is_deleted=true WHERE id=$1", [gone.id]);
    assert.equal((await pay(gone.id, "1")).status, 404);
    assert.ok((await inv(i.id)).payments.length > 0);
  }));

// ------------------------------------------------------------------------------------------------ overpay, void, paid
test("overpayment is refused with the remaining shown; paid, void and refunded invoices refuse payments", () =>
  withWorld(async ({ http, T, invoice, pay, refund, inv, q }) => {
    const i = await invoice("100.00");
    assert.equal((await pay(i.id, "60")).status, 201);
    const over = await pay(i.id, "40.01");
    assert.equal(over.status, 400);
    assert.match(over.body.error, /remaining/i);
    assert.match(over.body.error, /40\.00/);
    assert.equal((await inv(i.id)).remaining_amount, "40.00", "nothing changed");
    const full = await pay(i.id, "40.00");
    assert.equal(full.status, 201);
    assert.equal(full.body.invoice.status, "Paid");
    const again = await pay(i.id, "0.01");
    assert.equal(again.status, 409, "paid");
    // void invoice
    const v = await invoice("50.00");
    assert.equal((await http("POST", `/finance/invoices/${v.id}/void`, T.acct, { reason: "mistake" })).status, 200);
    const pv = await pay(v.id, "10");
    assert.equal(pv.status, 409);
    assert.match(pv.body.error, /void/i);
    // refunded invoice (full refund without reopen) stays closed
    const r = await invoice("30.00");
    const p = await pay(r.id, "30");
    assert.equal((await refund(p.body.payment.id, "30")).status, 201);
    assert.equal((await inv(r.id)).status, "Refunded");
    assert.equal((await pay(r.id, "1")).status, 409);
    // draft invoices are not payable
    const dr = await invoice("20.00");
    await q("UPDATE invoices SET status='Draft' WHERE id=$1", [dr.id]);
    assert.equal((await pay(dr.id, "1")).status, 409);
    // legacy invoice rows (no number, no items) are payable
    const c = (await q("SELECT candidate_id FROM invoices LIMIT 1")).rows[0].candidate_id;
    const legacy = (await q("INSERT INTO invoices (candidate_id,total_amount,remaining_amount) VALUES ($1,25,25) RETURNING id", [c])).rows[0].id;
    const lp = await pay(legacy, "25");
    assert.equal(lp.status, 201);
    assert.equal(lp.body.invoice.status, "Paid");
    assert.match(lp.body.payment.receipt_number, /^REC-\d{4}-\d{6}$/);
  }));

// ------------------------------------------------------------------------------------------------ concurrency
test("concurrency: 10 parallel payments above the balance - accepted total never exceeds it", () =>
  withWorld(async ({ invoice, pay, inv, q, ledgerBalance }) => {
    const i = await invoice("100.00");
    const rs = await Promise.all(Array.from({ length: 10 }, () => pay(i.id, "30.00")));
    const ok = rs.filter((r) => r.status === 201);
    const bad = rs.filter((r) => r.status !== 201);
    assert.equal(ok.length, 3, "exactly 3 x 30.00 fit into 100.00");
    assert.ok(bad.every((r) => r.status === 400 && /remaining/i.test(r.body.error)), JSON.stringify(bad.map((r) => r.text)));
    const d = await inv(i.id);
    assert.equal(d.remaining_amount, "10.00");
    assert.equal(d.status, "Partial");
    assert.equal(d.payments.length, 3);
    assert.equal((await q("SELECT sum(amount_paid)::text s FROM payments WHERE invoice_id=$1", [i.id])).rows[0].s, "90.00");
    assert.equal(await ledgerBalance(i.id), "10.00");
    // exact fit: 10 x 10.00 on 100.00 all succeed, an 11th is refused
    const j = await invoice("100.00");
    const all = await Promise.all(Array.from({ length: 11 }, () => pay(j.id, "10.00")));
    assert.deepEqual(all.map((r) => r.status).sort(), [201, 201, 201, 201, 201, 201, 201, 201, 201, 201, 409]);
    assert.deepEqual([(await inv(j.id)).remaining_amount, (await inv(j.id)).status], ["0.00", "Paid"]);
  }));

test("receipt numbers are unique and gap-free under parallel creation on different invoices", () =>
  withWorld(async ({ invoice, pay, q }) => {
    const invs = [];
    for (let k = 0; k < 10; k++) invs.push(await invoice("50.00"));
    const rs = await Promise.all([...invs, ...invs].map((i) => pay(i.id, "10.00")));
    assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status)));
    const nums = rs.map((r) => r.body.payment.receipt_number);
    assert.equal(new Set(nums).size, 20);
    const year = new Date().getUTCFullYear();
    assert.deepEqual([...nums].sort(), Array.from({ length: 20 }, (_, k) => `REC-${year}-${String(k + 1).padStart(6, "0")}`));
    assert.equal(Number((await q("SELECT value FROM fin_counters WHERE key=$1", [`receipt-${year}`])).rows[0].value), 20);
    // a rejected payment does not burn a number
    const i = invs[0];
    await pay(i.id, "30.00"); // 50 paid now (3x10 +... 10+10+30)
    assert.equal((await pay(i.id, "1.00")).status, 409);
    assert.equal(Number((await q("SELECT value FROM fin_counters WHERE key=$1", [`receipt-${year}`])).rows[0].value), 21);
  }));

// ------------------------------------------------------------------------------------------------ idempotency
test("idempotency: same key returns the original (200, replayed), conflicting body is 409, per-invoice scope", () =>
  withWorld(async ({ invoice, pay, inv, q }) => {
    const i = await invoice("100.00");
    const a = await pay(i.id, "25", { idempotency_key: "k-1", reference: "R1" });
    assert.equal(a.status, 201);
    const b = await pay(i.id, "25.00", { idempotency_key: "k-1", reference: "other reference ignored" });
    assert.equal(b.status, 200, b.text);
    assert.equal(b.body.replayed, true);
    assert.equal(b.body.payment.id, a.body.payment.id);
    assert.equal(b.body.payment.receipt_number, a.body.payment.receipt_number);
    assert.equal(b.body.payment.reference, "R1");
    assert.equal(b.body.invoice.remaining_amount, "75.00");
    assert.equal((await pay(i.id, "26", { idempotency_key: "k-1" })).status, 409, "different amount");
    assert.equal((await pay(i.id, "25", { idempotency_key: "k-1", method: "card" })).status, 409, "different method");
    assert.equal((await inv(i.id)).payments.length, 1);
    assert.equal(Number((await q("SELECT count(*) n FROM fin_ledger WHERE ref_table='payments'")).rows[0].n), 1);
    // same key on another invoice is a different payment
    const j = await invoice("100.00");
    const c = await pay(j.id, "25", { idempotency_key: "k-1" });
    assert.equal(c.status, 201);
    assert.notEqual(c.body.payment.id, a.body.payment.id);
    // without a key two identical payments are two payments
    assert.equal((await pay(i.id, "5")).status, 201);
    assert.equal((await pay(i.id, "5")).status, 201);
    // replay still works after the invoice became Paid
    const rest = await pay(i.id, "65", { idempotency_key: "k-last" });
    assert.equal(rest.status, 201);
    assert.equal(rest.body.invoice.status, "Paid");
    const rep = await pay(i.id, "65", { idempotency_key: "k-last" });
    assert.equal(rep.status, 200);
    assert.equal(rep.body.replayed, true);
    assert.equal(rep.body.invoice.status, "Paid");
    // a different key on the paid invoice is refused
    assert.equal((await pay(i.id, "1", { idempotency_key: "k-new" })).status, 409);
  }));

test("idempotency under parallel duplicates: one 201, the rest 200 replayed, one row", () =>
  withWorld(async ({ invoice, pay, inv }) => {
    const i = await invoice("100.00");
    const rs = await Promise.all(Array.from({ length: 6 }, () => pay(i.id, "40", { idempotency_key: "dup" })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 201]);
    assert.equal(new Set(rs.map((r) => r.body.payment.id)).size, 1);
    assert.equal(rs.filter((r) => r.body.replayed).length, 5);
    const d = await inv(i.id);
    assert.equal(d.payments.length, 1);
    assert.equal(d.remaining_amount, "60.00");
  }));

// ------------------------------------------------------------------------------------------------ void payment
test("void payment: restores balance and status, ledger reversal, audit; double void and refunded payments refused", () =>
  withWorld(async ({ http, T, invoice, pay, refund, voidPay, inv, q, ledgerBalance }) => {
    const i = await invoice("100.00");
    const a = (await pay(i.id, "100")).body.payment;
    assert.equal((await inv(i.id)).status, "Paid");
    assert.equal((await http("POST", `/finance/payments/${a.id}/void`, T.acct, {})).status, 400, "reason required");
    assert.equal((await http("POST", `/finance/payments/${a.id}/void`, T.acct, { reason: "  " })).status, 400);
    assert.equal((await http("POST", `/finance/payments/${a.id}/void`, T.acct, { reason: "x".repeat(501) })).status, 400);
    assert.equal((await http("POST", `/finance/payments/${a.id}/void`, T.acct, { reason: "x", extra: 1 })).status, 400);
    const v = await voidPay(a.id, "wrong candidate");
    assert.equal(v.status, 200, v.text);
    assert.equal(v.body.payment.voided_at !== null, true);
    assert.equal(v.body.payment.void_reason, "wrong candidate");
    assert.equal(v.body.invoice.remaining_amount, "100.00");
    assert.equal(v.body.invoice.status, "Pending");
    assert.equal((await voidPay(a.id)).status, 409, "already void");
    const led = (await q("SELECT kind, debit::text d, credit::text c FROM fin_ledger WHERE ref_table='payments' AND ref_id=$1 ORDER BY id", [a.id])).rows;
    assert.deepEqual(led.map((r) => [r.kind, r.d, r.c]), [["payment", "0.00", "100.00"], ["void", "100.00", "0.00"]]);
    assert.equal(await ledgerBalance(i.id), "100.00");
    assert.equal(Number((await q("SELECT count(*) n FROM audit_logs WHERE table_name='payments' AND action='VOID' AND record_id=$1", [String(a.id)])).rows[0].n), 1);
    // can be paid again; partial payment voided -> Partial/Pending by remaining
    const b = (await pay(i.id, "30")).body.payment;
    const c = (await pay(i.id, "20")).body.payment;
    assert.equal((await voidPay(c.id)).body.invoice.status, "Partial");
    assert.equal((await inv(i.id)).remaining_amount, "70.00");
    assert.equal((await voidPay(b.id)).body.invoice.status, "Pending");
    assert.equal((await inv(i.id)).remaining_amount, "100.00");
    // voided payments are not counted in the balance and do not block voiding the invoice
    const d = await inv(i.id);
    assert.equal(d.balance.paid, "0.00");
    assert.equal(d.payments.length, 3);
    // a payment with refunds cannot be voided
    const j = await invoice("60.00");
    const p = (await pay(j.id, "60")).body.payment;
    assert.equal((await refund(p.id, "10")).status, 201);
    const bad = await voidPay(p.id);
    assert.equal(bad.status, 409);
    assert.match(bad.body.error, /refund/i);
    assert.equal((await inv(j.id)).remaining_amount, "0.00");
    // unknown / bad ids
    assert.equal((await voidPay(99999999)).status, 404);
    assert.equal((await voidPay("abc")).status, 400);
    // concurrent voids: exactly one wins and the balance is restored once
    const k = await invoice("100.00");
    const pk = (await pay(k.id, "100")).body.payment;
    const rs = await Promise.all([1, 2, 3, 4].map(() => voidPay(pk.id, "race")));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409, 409]);
    assert.equal((await inv(k.id)).remaining_amount, "100.00");
    assert.equal(await ledgerBalance(k.id), "100.00");
    // void invoice after its payment was voided works; its payment can no longer be refunded/voided
    assert.equal((await http("POST", `/finance/invoices/${k.id}/void`, T.acct, { reason: "cancelled" })).status, 200);
  }));

// ------------------------------------------------------------------------------------------------ refunds
test("refund: bounds, parallel refunds cannot exceed, ledger debit, remaining unchanged by default", () =>
  withWorld(async ({ http, T, invoice, pay, refund, inv, q, ledgerBalance }) => {
    const i = await invoice("100.00");
    const p = (await pay(i.id, "100")).body.payment;
    assert.equal((await http("POST", `/finance/payments/${p.id}/refund`, T.acct, { amount: "10" })).status, 400, "reason required");
    for (const bad of [0, "0.00", -5, "1e2", "NaN", "1.234", null, undefined, "abc"]) assert.equal((await refund(p.id, bad)).status, 400, String(bad));
    assert.equal((await http("POST", `/finance/payments/${p.id}/refund`, T.acct, { amount: "5", reason: "x", reopen: "yes" })).status, 400);
    assert.equal((await http("POST", `/finance/payments/${p.id}/refund`, T.acct, { amount: "5", reason: "x", other: 1 })).status, 400);
    assert.equal((await http("POST", `/finance/payments/${p.id}/refund`, T.acct, { amount: "5", reason: "x".repeat(501) })).status, 400);
    const over = await refund(p.id, "100.01");
    assert.equal(over.status, 400);
    assert.match(over.body.error, /100\.00/);
    const r1 = await refund(p.id, "30.50");
    assert.equal(r1.status, 201, r1.text);
    assert.equal(r1.body.refund.amount, "30.50");
    assert.equal(r1.body.refund.payment_id, p.id);
    assert.equal(r1.body.refund.reopen, false);
    assert.equal(r1.body.invoice.remaining_amount, "0.00", "debt not reopened");
    assert.equal(r1.body.invoice.status, "Paid", "not fully refunded yet");
    const over2 = await refund(p.id, "69.51");
    assert.equal(over2.status, 400);
    assert.match(over2.body.error, /69\.50/);
    assert.equal((await refund(p.id, "69.50")).status, 201);
    assert.equal((await refund(p.id, "0.01")).status, 400, "nothing left to refund");
    assert.equal((await inv(i.id)).status, "Refunded", "total refunded equals total paid");
    const d = await inv(i.id);
    assert.equal(d.refunds.length, 2);
    assert.deepEqual([d.balance.paid, d.balance.refunded, d.balance.net_paid, d.balance.remaining], ["100.00", "100.00", "0.00", "0.00"]);
    const led = (await q("SELECT kind, debit::text d, credit::text c FROM fin_ledger WHERE ref_table='fin_refunds' ORDER BY id")).rows;
    assert.deepEqual(led.map((r) => [r.kind, r.d, r.c]), [["refund", "30.50", "0.00"], ["refund", "69.50", "0.00"]]);
    assert.equal(await ledgerBalance(i.id), "100.00");
    assert.equal(Number((await q("SELECT count(*) n FROM audit_logs WHERE table_name='fin_refunds' AND action='CREATE'")).rows[0].n), 2);

    // parallel refunds can never exceed the payment
    const j = await invoice("100.00");
    const pj = (await pay(j.id, "100")).body.payment;
    const rs = await Promise.all(Array.from({ length: 10 }, () => refund(pj.id, "30.00")));
    assert.equal(rs.filter((r) => r.status === 201).length, 3);
    assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 400), JSON.stringify(rs.map((r) => r.status)));
    assert.equal((await q("SELECT sum(amount)::text s FROM fin_refunds WHERE payment_id=$1", [pj.id])).rows[0].s, "90.00");
    assert.equal((await inv(j.id)).status, "Paid", "90 of 100 refunded: not Refunded");
    // a mix of two payments: refunds are per payment
    const k = await invoice("100.00");
    const pa = (await pay(k.id, "60")).body.payment;
    const pb = (await pay(k.id, "40")).body.payment;
    assert.equal((await refund(pa.id, "60.01")).status, 400);
    assert.equal((await refund(pa.id, "60")).status, 201);
    assert.equal((await inv(k.id)).status, "Paid", "only one payment refunded");
    assert.equal((await refund(pb.id, "40")).status, 201);
    assert.equal((await inv(k.id)).status, "Refunded");
    assert.equal((await refund(99999999, "1")).status, 404);
    assert.equal((await refund("abc", "1")).status, 400);
  }));

test("refund rules: reopen restores the debt and status; refund then re-pay; voided payment not refundable", () =>
  withWorld(async ({ invoice, pay, refund, voidPay, inv }) => {
    const i = await invoice("100.00");
    const p = (await pay(i.id, "100")).body.payment;
    // full refund without reopen: status Refunded, remaining 0, cannot be paid again
    const r = await refund(p.id, "100");
    assert.deepEqual([r.body.invoice.status, r.body.invoice.remaining_amount], ["Refunded", "0.00"]);
    assert.equal((await pay(i.id, "10")).status, 409);

    // reopen: partial refund of a paid invoice -> Partial with the debt back
    const j = await invoice("100.00");
    const pj = (await pay(j.id, "100")).body.payment;
    const rj = await refund(pj.id, "40", { reopen: true });
    assert.equal(rj.status, 201);
    assert.equal(rj.body.refund.reopen, true);
    assert.deepEqual([rj.body.invoice.status, rj.body.invoice.remaining_amount], ["Partial", "40.00"]);
    // refund then re-pay
    const again = await pay(j.id, "40");
    assert.equal(again.status, 201);
    assert.deepEqual([again.body.invoice.status, again.body.invoice.remaining_amount], ["Paid", "0.00"]);
    assert.equal((await pay(j.id, "0.01")).status, 409);
    // reopening the rest brings the invoice back to Pending (remaining == total), never "Refunded"
    const rj2 = await refund(pj.id, "60", { reopen: true });
    assert.deepEqual([rj2.body.invoice.status, rj2.body.invoice.remaining_amount], ["Partial", "60.00"]);
    const pj2 = again.body.payment;
    const rj3 = await refund(pj2.id, "40", { reopen: true });
    assert.deepEqual([rj3.body.invoice.status, rj3.body.invoice.remaining_amount], ["Pending", "100.00"]);
    assert.equal((await pay(j.id, "100")).status, 201);

    // voided payments cannot be refunded
    const k = await invoice("10.00");
    const pk = (await pay(k.id, "10")).body.payment;
    assert.equal((await voidPay(pk.id)).status, 200);
    assert.equal((await refund(pk.id, "1")).status, 409);
    assert.equal((await inv(k.id)).remaining_amount, "10.00");
  }));

// ------------------------------------------------------------------------------------------------ ledger
test("ledger totals equal the postings: balance = total - live paid + refunded = remaining + refunds without reopen", () =>
  withWorld(async ({ invoice, pay, refund, voidPay, inv, q, ledgerBalance }) => {
    const i = await invoice("200.00");
    const p1 = (await pay(i.id, "100")).body.payment;
    const p2 = (await pay(i.id, "50")).body.payment;
    assert.equal(await ledgerBalance(i.id), "50.00"); // 200 - 150
    assert.equal((await refund(p1.id, "30")).status, 201); // no reopen
    assert.equal(await ledgerBalance(i.id), "80.00"); // 200 - 150 + 30
    assert.equal((await refund(p1.id, "20", { reopen: true })).status, 201);
    assert.equal(await ledgerBalance(i.id), "100.00"); // 200 - 150 + 50
    assert.equal((await voidPay(p2.id)).status, 200); // p2 has no refunds
    assert.equal(await ledgerBalance(i.id), "150.00"); // 200 - 100 + 50
    const d = await inv(i.id);
    assert.equal(d.remaining_amount, "120.00"); // 200 -100 -50 (+20 reopened) +50 (void)
    // ledger_balance = remaining + refunds that were not reopened (30)
    const nonReopened = "30.00";
    assert.equal((await q("SELECT ($1::numeric + $2::numeric)::text s", [d.remaining_amount, nonReopened])).rows[0].s, await ledgerBalance(i.id));
    // and = total - live paid + refunded, from the base tables
    const viaTables = (
      await q(
        `SELECT (i.total_amount - COALESCE((SELECT SUM(amount_paid) FROM payments WHERE invoice_id=i.id AND voided_at IS NULL),0)
                              + COALESCE((SELECT SUM(amount) FROM fin_refunds WHERE invoice_id=i.id),0))::text AS b FROM invoices i WHERE i.id=$1`,
        [i.id]
      )
    ).rows[0].b;
    assert.equal(viaTables, "150.00");
    // every posting row is in the ledger with the right candidate/currency, none updated or deleted
    const rows = (await q("SELECT kind, candidate_id, currency FROM fin_ledger WHERE ref_table IN ('invoices','payments','fin_refunds')")).rows;
    assert.equal(rows.length, 1 + 2 + 2 + 1);
    assert.ok(rows.every((r) => Number(r.candidate_id) === i.candidate_id && r.currency === "TND"));
    await assert.rejects(() => q("UPDATE fin_ledger SET debit = 0"), /insert-only/);
  }));

// ------------------------------------------------------------------------------------------------ list
test("GET /finance/payments: filters, include_voided, paging, validation", () =>
  withWorld(async ({ http, T, candidate, invoice, pay, voidPay }) => {
    const c1 = await candidate("Alpha One");
    const c2 = await candidate("Beta Two");
    const i1 = await invoice("100.00", { candidate_id: c1 });
    const i2 = await invoice("100.00", { candidate_id: c2 });
    const a = (await pay(i1.id, "10", { payment_date: dayOffset(-10) })).body.payment;
    const b = (await pay(i1.id, "20", { method: "card", payment_date: dayOffset(-5) })).body.payment;
    const c = (await pay(i2.id, "30", { method: "mobile" })).body.payment;
    await voidPay(b.id);
    const list = (qs = "", t = T.mgr) => http("GET", `/finance/payments${qs}`, t);
    let r = await list();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.rows.map((x) => x.id).sort((x, y) => x - y), [a.id, c.id], "voided hidden by default");
    assert.equal(r.body.total, 2);
    assert.equal(r.body.rows[0].invoice_number != null, true);
    assert.equal(r.body.rows[0].candidate_name != null, true);
    assert.equal(typeof r.body.rows[0].amount_paid, "string");
    r = await list("?include_voided=true");
    assert.equal(r.body.total, 3);
    assert.equal(r.body.rows.find((x) => x.id === b.id).voided_at !== null, true);
    assert.equal((await list(`?invoice_id=${i1.id}`)).body.total, 1);
    assert.equal((await list(`?invoice_id=${i1.id}&include_voided=1`)).body.total, 2);
    assert.equal((await list(`?candidate_id=${c2}`)).body.rows[0].id, c.id);
    assert.equal((await list("?method=mobile")).body.total, 1);
    assert.equal((await list(`?from=${dayOffset(-7)}`)).body.total, 1, "from date");
    assert.equal((await list(`?to=${dayOffset(-7)}&include_voided=true`)).body.total, 1, "to date");
    r = await list("?limit=1&offset=0");
    assert.equal(r.body.rows.length, 1);
    assert.equal(r.body.total, 2);
    assert.equal((await list("?limit=1&offset=1")).body.rows[0].id !== r.body.rows[0].id, true);
    for (const bad of ["?method=crypto", "?from=2026-02-30", "?to=x", "?invoice_id=abc", "?candidate_id=-1", "?include_voided=maybe", "?limit=abc", "?method=cash&method=card"]) assert.equal((await list(bad)).status, 400, bad);
  }));

// ------------------------------------------------------------------------------------------------ receipt
test("receipt: escaped HTML, strict CSP, languages, void watermark, refunds shown", () =>
  withWorld(async ({ http, T, invoice, pay, refund, voidPay, candidate }) => {
    const c = await candidate(`<img src=x onerror=alert(1)> "Q" & 'S'`);
    const i = await invoice("100.00", { candidate_id: c, notes: "<script>alert(9)</script>" });
    const p = (await pay(i.id, "40.50", { reference: `<script>alert('x')</script>`, notes: `"><svg onload=1>`, method: "bank_transfer" })).body.payment;
    const get = (id, qs = "", t = T.mgr) => http("GET", `/finance/payments/${id}/receipt${qs}`, t);
    const r = await get(p.id);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/html/);
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /style-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|script-src/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("cache-control"), "no-store");
    const html = r.text;
    assert.ok(html.includes(p.receipt_number));
    assert.ok(html.includes("40.50 TND"));
    assert.ok(html.includes(i.number));
    assert.ok(!html.includes("<script"), "no script element");
    assert.ok(!/\sstyle=/.test(html), "no inline style");
    assert.ok(!/\son\w+=/.test(html.replace(/&lt;[^]*?&gt;/g, "")), "no event handler attributes outside escaped text");
    assert.ok(html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt; &quot;Q&quot; &amp; &#39;S&#39;"));
    assert.ok(html.includes('<link rel="stylesheet" href="/vita/fin-print.css">'));
    assert.ok(html.includes('lang="en"') && html.includes('dir="ltr"'));
    assert.ok(!html.includes("VOID"));
    const ar = await get(p.id, "?lang=ar");
    assert.ok(ar.text.includes('lang="ar"') && ar.text.includes('dir="rtl"') && ar.text.includes("إيصال"));
    const fr = await get(p.id, "?lang=fr");
    assert.ok(fr.text.includes("Reçu"));
    assert.equal((await get(p.id, "?lang=de")).status, 400);
    assert.equal((await get(p.id, "?lang=en&lang=fr")).status, 400);
    assert.equal((await get(99999999)).status, 404);
    assert.equal((await get("abc")).status, 400);
    // refunds listed; void -> watermark and reason (refund first would block voiding, so void another payment)
    await refund(p.id, "10", { reason: "<b>part</b>" });
    const withRefund = (await get(p.id)).text;
    assert.ok(withRefund.includes("10.00 TND") && withRefund.includes("&lt;b&gt;part&lt;/b&gt;"));
    const q2 = (await pay(i.id, "5", { reference: "oops" })).body.payment;
    await voidPay(q2.id, `typed "wrong" <i>`);
    const v = (await get(q2.id)).text;
    assert.ok(v.includes('class="watermark"') && v.includes("VOID"));
    assert.ok(v.includes("typed &quot;wrong&quot; &lt;i&gt;"));
    assert.ok(!v.includes("<i>"));
    // legacy payment without receipt number still renders
    assert.equal((await get(p.id, "", T.acct)).status, 200);
  }));

test("receipt for a legacy payment row (no number) renders", () =>
  withWorld(async ({ http, T, candidate, q }) => {
    const c = await candidate();
    const legacyInv = (await q("INSERT INTO invoices (candidate_id,total_amount,remaining_amount) VALUES ($1,50,25) RETURNING id", [c])).rows[0].id;
    const lp = (await q("INSERT INTO payments (invoice_id,candidate_id,amount_paid,payment_method) VALUES ($1,$2,25,'cash') RETURNING id", [legacyInv, c])).rows[0].id;
    const r = await http("GET", `/finance/payments/${lp}/receipt`, T.mgr);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.text.includes("25.00 TND"));
    assert.ok(r.text.includes("(no number)"));
  }));

// ------------------------------------------------------------------------------------------------ roles
test("role matrix: Accountant/Admin/SuperAdmin write+void+refund, Manager read only, everyone else denied", () =>
  withWorld(async ({ http, T, invoice, pay }) => {
    const i = await invoice("1000.00");
    const seed = (await pay(i.id, "100")).body.payment;
    const calls = (token, tag) => ({
      list: http("GET", "/finance/payments", token),
      receipt: http("GET", `/finance/payments/${seed.id}/receipt`, token),
      create: http("POST", "/finance/payments/v2", token, { invoice_id: i.id, amount: "1.00", method: "cash", idempotency_key: `role-${tag}` }),
      refund: http("POST", `/finance/payments/${seed.id}/refund`, token, { amount: "1.00", reason: "role test" }),
      void: http("POST", `/finance/payments/${seed.id}/void`, token, { reason: "role test" }),
    });
    const denied = { list: 403, receipt: 403, create: 403, refund: 403, void: 403 };
    // read-only and denied roles first, nothing may change
    for (const k of ["mgr", "agent", "rec", "hr", "cand", "emp", "agy"]) {
      const res = Object.fromEntries(await Promise.all(Object.entries(calls(T[k], k)).map(async ([n, p]) => [n, (await p).status])));
      assert.deepEqual(res, k === "mgr" ? { list: 200, receipt: 200, create: 403, refund: 403, void: 403 } : denied, k);
    }
    const anon = await Promise.all(Object.values(calls(null, "anon")));
    assert.ok(anon.every((r) => r.status === 401));
    const d = (await http("GET", `/finance/invoices/${i.id}`, T.acct)).body;
    assert.equal(d.payments.length, 1);
    assert.equal(d.refunds.length, 0);
    assert.equal(d.payments[0].voided_at, null);
    // writers: create + refund succeed, void succeeds (sequential to avoid the refund/void conflict)
    for (const k of ["acct", "admin", "sa"]) {
      const c1 = await calls(T[k], k).create;
      assert.equal(c1.status, 201, k);
      const p = c1.body.payment;
      const rf = await http("POST", `/finance/payments/${seed.id}/refund`, T[k], { amount: "1.00", reason: "role test" });
      assert.equal(rf.status, 201, `${k} refund`);
      const vd = await http("POST", `/finance/payments/${p.id}/void`, T[k], { reason: "role test" });
      assert.equal(vd.status, 200, `${k} void`);
      assert.equal((await http("GET", "/finance/payments", T[k])).status, 200);
      assert.equal((await http("GET", `/finance/payments/${p.id}/receipt`, T[k])).status, 200);
    }
  }));

// ------------------------------------------------------------------------------------------------ legacy
test("legacy POST /finance/invoices: currency and amount validated (400 not 500), number + ledger debit written", () =>
  withWorld(async ({ http, T, candidate, q, ids }) => {
    const c = await candidate();
    const post = (b, t = T.acct) => http("POST", "/finance/invoices", t, b);
    for (const currency of ["TN", "TNDX", "12A", "T-D", 123, "", "  ", {}, [], "tnd1"]) {
      const r = await post({ candidate_id: c, total_amount: "100", currency });
      assert.equal(r.status, 400, `currency ${JSON.stringify(currency)} -> ${r.status} ${r.text}`);
    }
    for (const total_amount of ["abc", "-5", "1e3", "NaN", "1.234", [], {}]) assert.equal((await post({ candidate_id: c, total_amount })).status, 400, JSON.stringify(total_amount));
    assert.equal((await post({ candidate_id: c })).status, 400);
    assert.equal((await post({ total_amount: "5" })).status, 400);
    assert.equal((await post({ candidate_id: "abc", total_amount: "5" })).status, 400);
    assert.equal((await post({ candidate_id: 99999999, total_amount: "5" })).status, 404);
    assert.equal((await post({ candidate_id: c, total_amount: "5", due_date: "2026-02-30" })).status, 400);
    assert.equal((await q("SELECT count(*) n FROM invoices")).rows[0].n, "0");
    // defaults + shape
    const ok = await post({ candidate_id: c, total_amount: 100.5, due_date: "2030-01-31", notes: "legacy" });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.currency, "TND");
    assert.equal(ok.body.total_amount, "100.50");
    assert.equal(ok.body.remaining_amount, "100.50");
    assert.equal(ok.body.status, "Pending");
    assert.equal(ok.body.created_by, ids.acct);
    assert.match(ok.body.number, /^VITA-\d{4}-\d{6}$/);
    // lowercase currency is normalised
    const eur = await post({ candidate_id: c, total_amount: "10", currency: " eur " });
    assert.equal(eur.status, 201);
    assert.equal(eur.body.currency, "EUR");
    // ledger debit + audit in the same transaction; numbers continue the v2 sequence
    const led = (await q("SELECT kind, debit::text d, credit::text cr, currency FROM fin_ledger WHERE ref_table='invoices' AND ref_id=$1", [ok.body.id])).rows;
    assert.deepEqual(led, [{ kind: "invoice", d: "100.50", cr: "0.00", currency: "TND" }]);
    const v2 = await http("POST", "/finance/invoices/v2", T.acct, { candidate_id: c, currency: "TND", items: [{ description: "x", quantity: 1, unit_price: "1" }] });
    assert.equal(Number(v2.body.number.slice(-6)), Number(eur.body.number.slice(-6)) + 1);
    assert.equal(Number((await q("SELECT count(*) n FROM audit_logs WHERE table_name='invoices' AND action='CREATE' AND record_id=$1", [String(ok.body.id)])).rows[0].n), 1);
    // permissions unchanged
    assert.equal((await post({ candidate_id: c, total_amount: "5" }, T.mgr)).status, 403);
    assert.equal((await post({ candidate_id: c, total_amount: "5" }, T.agent)).status, 403);
    // the new invoice can be paid via v2 and printed
    assert.equal((await http("POST", "/finance/payments/v2", T.acct, { invoice_id: ok.body.id, amount: "100.50", method: "cash" })).status, 201);
    assert.equal((await http("GET", `/finance/invoices/${ok.body.id}/print`, T.mgr)).status, 200);
  }));

test("legacy POST /finance/payments: method mapped, unknown 400, receipt + ledger, SQL decimals, same response shape", () =>
  withWorld(async ({ http, T, candidate, q, ids, ledgerBalance, inv }) => {
    const c = await candidate();
    const mk = async (total = "100") => (await http("POST", "/finance/invoices", T.acct, { candidate_id: c, total_amount: total })).body;
    const post = (b, t = T.acct) => http("POST", "/finance/payments", t, b);
    const i = await mk();
    for (const payment_method of ["crypto", "", 5, {}, [], "cash;drop", "cheq"]) assert.equal((await post({ invoice_id: i.id, amount_paid: "10", payment_method })).status, 400, JSON.stringify(payment_method));
    for (const amount_paid of ["abc", "-5", "1e1", "NaN", "10.555", [], {}, 0, "0", "0.00"]) assert.equal((await post({ invoice_id: i.id, amount_paid })).status, 400, JSON.stringify(amount_paid));
    assert.equal((await post({ invoice_id: i.id })).status, 400);
    assert.equal((await post({ amount_paid: 5 })).status, 400);
    assert.equal((await post({ invoice_id: "abc", amount_paid: 5 })).status, 400);
    assert.equal((await post({ invoice_id: 99999999, amount_paid: 5 })).status, 404);
    assert.equal((await post({ invoice_id: i.id, amount_paid: "5", payment_date: "2026-02-30" })).status, 400);
    assert.equal((await q("SELECT count(*) n FROM payments")).rows[0].n, "0");
    const zero = await post({ invoice_id: i.id, amount_paid: "0.00" });
    assert.equal(zero.body.error, "amount_paid must be greater than zero");
    // success shapes: default method, case-insensitive mapping
    const a = await post({ invoice_id: i.id, amount_paid: "40", notes: "legacy" });
    assert.equal(a.status, 201, a.text);
    assert.deepEqual(Object.keys(a.body).sort(), ["invoice", "payment"]);
    assert.equal(a.body.payment.payment_method, "cash");
    assert.equal(a.body.payment.amount_paid, "40.00");
    assert.equal(a.body.payment.created_by, ids.acct);
    assert.match(a.body.payment.receipt_number, /^REC-\d{4}-\d{6}$/);
    assert.deepEqual([a.body.invoice.remaining_amount, a.body.invoice.status], ["60.00", "Partial"]);
    const m = await post({ invoice_id: i.id, amount_paid: 10, payment_method: "Bank Transfer" });
    assert.equal(m.body.payment.payment_method, "bank_transfer");
    assert.equal((await post({ invoice_id: i.id, amount_paid: 10, payment_method: "CARD" })).body.payment.payment_method, "card");
    assert.equal((await post({ invoice_id: i.id, amount_paid: 10, payment_method: "Cheque" })).body.payment.payment_method, "cheque");
    assert.equal((await inv(i.id)).remaining_amount, "30.00");
    // ledger credit + audit
    assert.equal((await q("SELECT credit::text c FROM fin_ledger WHERE ref_table='payments' AND ref_id=$1", [a.body.payment.id])).rows[0].c, "40.00");
    assert.equal(await ledgerBalance(i.id), "30.00");
    // overpayment keeps the legacy message; exact decimals
    const over = await post({ invoice_id: i.id, amount_paid: "30.01" });
    assert.equal(over.status, 400);
    assert.equal(over.body.error, "amount_paid cannot exceed remaining invoice balance");
    const j = await mk("100");
    for (let k = 0; k < 3; k++) assert.equal((await post({ invoice_id: j.id, amount_paid: 33.33 })).status, 201);
    assert.equal((await inv(j.id)).remaining_amount, "0.01");
    const fin = await post({ invoice_id: j.id, amount_paid: "0.01" });
    assert.deepEqual([fin.body.invoice.remaining_amount, fin.body.invoice.status], ["0.00", "Paid"]);
    // paid / void invoices
    assert.equal((await post({ invoice_id: j.id, amount_paid: "1" })).status, 400);
    const v = await mk("20");
    await http("POST", `/finance/invoices/${v.id}/void`, T.acct, { reason: "x" });
    assert.equal((await post({ invoice_id: v.id, amount_paid: "1" })).status, 409);
    // parallel legacy payments cannot overpay
    const k = await mk("100");
    const rs = await Promise.all(Array.from({ length: 10 }, () => post({ invoice_id: k.id, amount_paid: "30" })));
    assert.equal(rs.filter((r) => r.status === 201).length, 3);
    assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 400));
    assert.equal((await inv(k.id)).remaining_amount, "10.00");
    // receipt numbers shared with v2 and unique
    const nums = (await q("SELECT receipt_number FROM payments")).rows.map((r) => r.receipt_number);
    assert.equal(new Set(nums).size, nums.length);
    assert.ok(nums.every(Boolean));
    // permissions unchanged
    assert.equal((await post({ invoice_id: k.id, amount_paid: "1" }, T.mgr)).status, 403);
    assert.equal((await post({ invoice_id: k.id, amount_paid: "1" }, T.hr)).status, 403);
  }));

test("legacy dashboard ignores voided invoices and payments; validatePaymentAmount util still exported", () =>
  withWorld(async ({ http, T, invoice, pay, voidPay }) => {
    const i = await invoice("100.00");
    const p = (await pay(i.id, "40")).body.payment;
    const j = await invoice("50.00");
    let d = (await http("GET", "/finance/dashboard", T.acct)).body;
    assert.deepEqual([Number(d.total_in), Number(d.total_invoiced), Number(d.total_remaining)], [40, 150, 110]);
    await voidPay(p.id);
    await http("POST", `/finance/invoices/${j.id}/void`, T.acct, { reason: "x" });
    d = (await http("GET", "/finance/dashboard", T.acct)).body;
    assert.deepEqual([Number(d.total_in), Number(d.total_invoiced), Number(d.total_remaining)], [0, 100, 100]);
    assert.equal(typeof validatePaymentAmount, "function");
  }));
