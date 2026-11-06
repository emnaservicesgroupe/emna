// Stage 4, Task 4: expenses, reports, CSV export and the candidate self-view (/finance/me).
//
// Report numbers are checked against hand-computed sums (integer cents, see each dataset) of raw rows seeded with SQL,
// with mixed currencies and voided / deleted / out-of-range rows that must NOT count.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "fin-reports-test-secret";
for (const k of ["FIN_TAX_RATE_PERCENT", "FIN_COMPANY_NAME", "FIN_COMPANY_ADDRESS", "FIN_COMPANY_TAX_ID", "FIN_CURRENCIES", "FIN_EXPORT_MAX_ROWS"]) delete process.env[k];

async function withWorld(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = (sql, p) => pool.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  const http = async (method, url, token, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
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
  const roles = { sa: "SuperAdmin", admin: "Admin", acct: "Accountant", mgr: "Manager", agent: "Agent", rec: "Receptionist", hr: "HR" };
  const ids = {};
  const T = {};
  for (const [k, role] of Object.entries(roles)) {
    ids[k] = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`${role} ${k}`, `${k}@finrep.test.invalid`, role])).id;
    T[k] = jwt.sign({ id: ids[k], role }, process.env.JWT_SECRET, { expiresIn: "1h" });
  }
  T.emp = (await createEmployerUser(pool)).token;
  T.agy = (await createAgencyUser(pool)).token;
  let n = 0;
  const candidate = async (name = "Amine Trabelsi") => {
    n += 1;
    return (await one("INSERT INTO candidates (full_name, passport_number) VALUES ($1,$2) RETURNING id", [name, `REP${process.pid}-${n}`])).id;
  };
  /** A Candidate login linked to a candidate row (js_candidate_accounts), as the OTP flow leaves it. */
  const candidateLogin = async (candidateId, { link = true } = {}) => {
    n += 1;
    const uid = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x','Candidate') RETURNING id", [`Cand login ${n}`, `cl${n}-${process.pid}@finrep.test.invalid`])).id;
    if (link) await q("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [uid, candidateId]);
    return { userId: uid, token: jwt.sign({ id: uid, role: "Candidate", tv: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
  };
  let inum = 0;
  /** Raw invoice row. issued is a timestamp literal; open amount defaults to the total. */
  const seedInvoice = async (o) => {
    inum += 1;
    return (
      await one(
        `INSERT INTO invoices (candidate_id, total_amount, remaining_amount, currency, due_date, status, created_by, number, issued_at, voided_at, void_reason, is_deleted, subtotal)
         VALUES ($1,$2::numeric,$3::numeric,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11,$12,$2::numeric) RETURNING id`,
        [o.cand, o.total, o.remaining === undefined ? o.total : o.remaining, o.cur || "TND", o.due || null, o.status || "Pending", o.by || ids.acct, o.number === undefined ? `T-${inum}` : o.number, o.issued || "2026-03-10T10:00:00Z", o.voided ? o.issued || "2026-03-10T10:00:00Z" : null, o.voided ? "seed void" : null, Boolean(o.deleted)]
      )
    ).id;
  };
  let pnum = 0;
  const seedPayment = async (o) => {
    pnum += 1;
    return (
      await one(
        `INSERT INTO payments (invoice_id, candidate_id, amount_paid, payment_method, payment_date, created_by, receipt_number, voided_at, void_reason, is_deleted)
         VALUES ($1,(SELECT candidate_id FROM invoices WHERE id=$1),$2::numeric,'cash',$3::date,$4,$5,$6::timestamptz,$7,$8) RETURNING id`,
        [o.inv, o.amount, o.date, o.by || ids.acct, o.receipt === undefined ? `R-${pnum}` : o.receipt, o.voided ? "2026-04-01T00:00:00Z" : null, o.voided ? "seed void" : null, Boolean(o.deleted)]
      )
    ).id;
  };
  const seedRefund = async (payId, amount, at) =>
    (
      await one(
        `INSERT INTO fin_refunds (payment_id, invoice_id, amount, reason, created_by, created_at)
         VALUES ($1,(SELECT invoice_id FROM payments WHERE id=$1),$2::numeric,'seed refund',$3,$4::timestamptz) RETURNING id`,
        [payId, amount, ids.acct, at]
      )
    ).id;
  const seedExpense = async (o) =>
    (
      await one(
        `INSERT INTO expenses (title, amount, currency, spent_on, created_by, voided_at, void_reason, is_deleted)
         VALUES ($1,$2::numeric,$3,$4::date,$5,$6::timestamptz,$7,$8) RETURNING id`,
        [o.title || "seed", o.amount, o.cur || "TND", o.on, o.by || ids.acct, o.voided ? "2026-04-01T00:00:00Z" : null, o.voided ? "seed void" : null, Boolean(o.deleted)]
      )
    ).id;
  const seedItem = (invId, o) =>
    q("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, position) VALUES ($1,$2,$3,$4::numeric,$5::numeric,$6)", [invId, o.service || null, o.desc, o.qty, o.price, o.pos || 0]);
  try {
    await fn({ pool, http, q, one, T, ids, candidate, candidateLogin, seedInvoice, seedPayment, seedRefund, seedExpense, seedItem, base });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

const dayOffset = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const expense = (over = {}) => ({ title: "Office rent", amount: "120.50", currency: "TND", spent_on: dayOffset(0), ...over });

/** Minimal RFC 4180 reader for the all-quoted CSV the export produces. Throws on any unquoted cell. */
function parseCsv(text) {
  assert.equal(text.charCodeAt(0), 0xfeff, "UTF-8 BOM first");
  const s = text.slice(1);
  const rows = [];
  let i = 0;
  while (i < s.length) {
    const row = [];
    for (;;) {
      assert.equal(s[i], '"', `cell must be quoted at offset ${i}: ${JSON.stringify(s.slice(i, i + 30))}`);
      i += 1;
      let cell = "";
      for (;;) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        assert.ok(i < s.length, "unterminated quoted cell");
        cell += s[i];
        i += 1;
      }
      row.push(cell);
      if (s[i] === ",") {
        i += 1;
        continue;
      }
      assert.equal(s.slice(i, i + 2), "\r\n", "rows end with CRLF");
      i += 2;
      break;
    }
    rows.push(row);
  }
  return rows;
}

// ================================================================================================ expenses
test("expenses: create (decimal string, ledger debit, audit), read back, list filters and paging", () =>
  withWorld(async ({ http, T, q, ids }) => {
    const cat = await http("POST", "/finance/expense-categories", T.acct, { name: "Rent" });
    assert.equal(cat.status, 201, cat.text);
    const r = await http("POST", "/finance/expenses", T.acct, expense({ amount: 120.5, category_id: cat.body.id, payee: "Landlord SARL", notes: "March" }));
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.amount, "120.50");
    assert.equal(r.body.currency, "TND");
    assert.equal(r.body.title, "Office rent");
    assert.equal(r.body.payee, "Landlord SARL");
    assert.equal(r.body.category_id, cat.body.id);
    assert.equal(r.body.category_name, "Rent");
    assert.equal(r.body.created_by, ids.acct);
    assert.equal(r.body.voided_at, null);
    const led = (await q("SELECT kind, ref_table, ref_id, candidate_id, currency, debit::text d, credit::text c, actor_id FROM fin_ledger WHERE ref_table='expenses'")).rows;
    assert.equal(led.length, 1);
    assert.deepEqual([led[0].kind, led[0].d, led[0].c, led[0].currency, led[0].candidate_id], ["expense", "120.50", "0.00", "TND", null]);
    assert.equal(Number(led[0].ref_id), r.body.id);
    assert.equal(Number(led[0].actor_id), ids.acct);
    assert.equal(Number((await q("SELECT count(*) n FROM audit_logs WHERE table_name='expenses' AND action='CREATE'")).rows[0].n), 1);

    // more rows for filters
    await http("POST", "/finance/expenses", T.acct, expense({ title: "Flights", amount: "300", currency: "EUR", spent_on: "2026-02-10" }));
    await http("POST", "/finance/expenses", T.acct, expense({ title: "Ads", amount: "10.10", spent_on: "2026-02-20" }));
    await http("POST", "/finance/expenses", T.acct, expense({ title: "Ads 2", amount: "0.20", spent_on: "2026-03-05" }));
    const all = await http("GET", "/finance/expenses", T.acct);
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 4);
    assert.equal(all.body.rows[0].title, "Ads 2", "newest first");
    const byCat = await http("GET", `/finance/expenses?category_id=${cat.body.id}`, T.acct);
    assert.deepEqual(byCat.body.rows.map((x) => x.title), ["Office rent"]);
    const cur = await http("GET", "/finance/expenses?currency=EUR", T.acct);
    assert.deepEqual(cur.body.rows.map((x) => x.title), ["Flights"]);
    const range = await http("GET", "/finance/expenses?from=2026-02-15&to=2026-03-05", T.acct);
    assert.deepEqual(range.body.rows.map((x) => x.title).sort(), ["Ads", "Ads 2"]);
    const page = await http("GET", "/finance/expenses?limit=2&offset=1", T.acct);
    assert.equal(page.body.rows.length, 2);
    assert.equal(page.body.total, 4);
    for (const bad of ["from=2026-13-01", "to=nope", "currency=eur", "include_voided=maybe", "limit=abc", "category_id=x", "from=2026-03-02&to=2026-03-01"]) {
      assert.equal((await http("GET", `/finance/expenses?${bad}`, T.acct)).status, 400, bad);
    }
  }));

test("expenses: validation (title, amount, currency, date, category, lengths, unknown fields)", () =>
  withWorld(async ({ http, T, q }) => {
    const post = (body) => http("POST", "/finance/expenses", T.acct, body);
    const cases = [
      ["missing title", expense({ title: undefined })],
      ["blank title", expense({ title: "   " })],
      ["title too long", expense({ title: "x".repeat(161) })],
      ["title not a string", expense({ title: 5 })],
      ["amount zero", expense({ amount: "0" })],
      ["amount negative", expense({ amount: "-5" })],
      ["amount exponent", expense({ amount: "1e3" })],
      ["amount 1e21", expense({ amount: 1e21 })],
      ["amount 3 decimals", expense({ amount: "1.234" })],
      ["amount comma", expense({ amount: "1,5" })],
      ["amount NaN", expense({ amount: "NaN" })],
      ["amount float noise", expense({ amount: 0.1 + 0.2 })],
      ["amount huge", expense({ amount: "99999999999.00" })],
      ["amount missing", expense({ amount: undefined })],
      ["currency not allowed", expense({ currency: "XXX" })],
      ["currency lower-case", expense({ currency: "tnd" })],
      ["currency missing", expense({ currency: undefined })],
      ["date missing", expense({ spent_on: undefined })],
      ["date impossible", expense({ spent_on: "2026-02-30" })],
      ["date format", expense({ spent_on: "23/10/2026" })],
      ["date in the future", expense({ spent_on: dayOffset(2) })],
      ["category missing", expense({ category_id: 987654 })],
      ["category junk", expense({ category_id: "abc" })],
      ["payee too long", expense({ payee: "p".repeat(161) })],
      ["notes too long", expense({ notes: "n".repeat(501) })],
      ["unknown field", expense({ is_deleted: true })],
    ];
    for (const [label, body] of cases) {
      const r = await post(body);
      assert.equal(r.status, 400, `${label}: ${r.status} ${r.text}`);
    }
    assert.equal((await post(expense({ spent_on: dayOffset(1) }))).status, 201, "tomorrow (UTC) is allowed");
    assert.equal((await post(expense({ title: "x".repeat(160), notes: "n".repeat(500), payee: "p".repeat(160), amount: "9999999999.99" }))).status, 201, "limits are inclusive");
    const inactive = (await http("POST", "/finance/expense-categories", T.acct, { name: "Old" })).body;
    assert.equal((await http("PATCH", `/finance/expense-categories/${inactive.id}`, T.acct, { active: false })).status, 200);
    assert.equal((await post(expense({ category_id: inactive.id }))).status, 409, "inactive category");
    // Nothing was written by the rejected requests.
    assert.equal(Number((await q("SELECT count(*) n FROM expenses")).rows[0].n), 2);
    assert.equal(Number((await q("SELECT count(*) n FROM fin_ledger WHERE kind='expense'")).rows[0].n), 2);
  }));

test("expenses: void (reason required, once only, ledger reversal, audit) and visibility in lists", () =>
  withWorld(async ({ http, T, q }) => {
    const e = (await http("POST", "/finance/expenses", T.acct, expense({ amount: "45.00" }))).body;
    assert.equal((await http("POST", `/finance/expenses/${e.id}/void`, T.acct, {})).status, 400);
    assert.equal((await http("POST", `/finance/expenses/${e.id}/void`, T.acct, { reason: "  " })).status, 400);
    assert.equal((await http("POST", `/finance/expenses/${e.id}/void`, T.acct, { reason: "dup", extra: 1 })).status, 400);
    assert.equal((await http("POST", `/finance/expenses/${e.id}/void`, T.mgr, { reason: "dup" })).status, 403);
    const v = await http("POST", `/finance/expenses/${e.id}/void`, T.acct, { reason: "entered twice" });
    assert.equal(v.status, 200, v.text);
    assert.ok(v.body.voided_at);
    assert.equal(v.body.void_reason, "entered twice");
    assert.equal((await http("POST", `/finance/expenses/${e.id}/void`, T.acct, { reason: "again" })).status, 409);
    const led = (await q("SELECT kind, debit::text d, credit::text c FROM fin_ledger WHERE ref_table='expenses' ORDER BY id")).rows;
    assert.deepEqual(led.map((r) => [r.kind, r.d, r.c]), [["expense", "45.00", "0.00"], ["void", "0.00", "45.00"]]);
    assert.equal(Number((await q("SELECT count(*) n FROM audit_logs WHERE table_name='expenses' AND action='VOID'")).rows[0].n), 1);
    assert.equal((await http("GET", "/finance/expenses", T.acct)).body.total, 0);
    const incl = await http("GET", "/finance/expenses?include_voided=true", T.acct);
    assert.equal(incl.body.total, 1);
    assert.ok(incl.body.rows[0].voided_at);
    for (const id of ["999999", "99999999999", "0", "abc"]) {
      const r = await http("POST", `/finance/expenses/${id}/void`, T.acct, { reason: "x" });
      assert.ok(r.status === 404 || r.status === 400, `${id} -> ${r.status}`);
    }
    assert.equal((await http("POST", "/finance/expenses/999999/void", T.acct, { reason: "x" })).status, 404);
  }));

test("expense categories: unique case-insensitively, trimmed, <= 80, active flag via PATCH", () =>
  withWorld(async ({ http, T, q }) => {
    const a = await http("POST", "/finance/expense-categories", T.acct, { name: "  Travel " });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.body.name, "Travel");
    assert.equal(a.body.active, true);
    assert.equal((await http("POST", "/finance/expense-categories", T.acct, { name: "TRAVEL" })).status, 409);
    assert.equal((await http("POST", "/finance/expense-categories", T.acct, { name: "travel" })).status, 409);
    assert.equal((await http("POST", "/finance/expense-categories", T.acct, { name: "" })).status, 400);
    assert.equal((await http("POST", "/finance/expense-categories", T.acct, {})).status, 400);
    assert.equal((await http("POST", "/finance/expense-categories", T.acct, { name: "x".repeat(81) })).status, 400);
    assert.equal((await http("POST", "/finance/expense-categories", T.acct, { name: "x".repeat(80) })).status, 201);
    assert.equal((await http("POST", "/finance/expense-categories", T.acct, { name: "Z", color: "red" })).status, 400);
    const p = await http("PATCH", `/finance/expense-categories/${a.body.id}`, T.acct, { active: false });
    assert.equal(p.status, 200);
    assert.equal(p.body.active, false);
    assert.equal((await http("PATCH", `/finance/expense-categories/${a.body.id}`, T.acct, { active: "no" })).status, 400);
    assert.equal((await http("PATCH", `/finance/expense-categories/${a.body.id}`, T.acct, {})).status, 400);
    assert.equal((await http("PATCH", "/finance/expense-categories/99999", T.acct, { active: true })).status, 404);
    assert.equal((await http("PATCH", `/finance/expense-categories/${a.body.id}`, T.mgr, { active: true })).status, 403);
    const list = await http("GET", "/finance/expense-categories", T.mgr);
    assert.equal(list.status, 200);
    assert.equal(list.body.rows.length, 2);
    assert.deepEqual((await http("GET", "/finance/expense-categories?active=true", T.mgr)).body.rows.map((r) => r.name), ["x".repeat(80)]);
    assert.ok(Number((await q("SELECT count(*) n FROM audit_logs WHERE table_name='expense_categories'")).rows[0].n) >= 3);
  }));

// ================================================================================================ summary
/**
 * Dataset (range 2026-03-01 .. 2026-03-31), integer cents:
 *  TND invoiced : 100.10 (03-05) + 200.20 (03-31 23:59:59, inclusive end) = 300.30;  excluded: void 70.00, 02-28 10.00, 04-01 50.00, deleted
 *  TND collected: 60.07 (03-06) + 100.10 (03-31) + 5.55 (03-02, invoice outside the range) = 165.72;  excluded: voided 0.03, deleted 9.00, 04-02 20.00
 *  TND refunded : 10.01 (03-20);  excluded: 04-02
 *  TND expenses : 33.33 + 0.67 = 34.00;  excluded: voided 9.99, deleted, 04-01 1.00
 *  TND net      : 165.72 - 10.01 - 34.00 = 121.71
 *  EUR invoiced 300.05, collected 100.00, refunded 0, expenses 12.34, net 87.66
 */
async function seedSummary(w) {
  const c1 = await w.candidate("Sum A");
  const c2 = await w.candidate("Sum B");
  const iA = await w.seedInvoice({ cand: c1, total: "100.10", issued: "2026-03-05T09:00:00Z" });
  const iB = await w.seedInvoice({ cand: c1, total: "200.20", issued: "2026-03-31T23:59:59Z", status: "Partial" });
  const iC = await w.seedInvoice({ cand: c2, total: "50.00", issued: "2026-04-01T00:00:00Z" });
  await w.seedInvoice({ cand: c2, total: "70.00", issued: "2026-03-10T10:00:00Z", status: "Void", voided: true });
  const iF = await w.seedInvoice({ cand: c2, total: "10.00", issued: "2026-02-28T23:59:59Z" });
  const iE = await w.seedInvoice({ cand: c2, total: "300.05", cur: "EUR", issued: "2026-03-15T10:00:00Z" });
  await w.seedInvoice({ cand: c2, total: "40.00", cur: "EUR", issued: "2026-03-20T10:00:00Z", deleted: true });
  const pA1 = await w.seedPayment({ inv: iA, amount: "60.07", date: "2026-03-06" });
  await w.seedPayment({ inv: iA, amount: "0.03", date: "2026-03-07", voided: true });
  await w.seedPayment({ inv: iB, amount: "100.10", date: "2026-03-31" });
  const pE = await w.seedPayment({ inv: iE, amount: "100.00", date: "2026-03-16" });
  await w.seedPayment({ inv: iC, amount: "20.00", date: "2026-04-02" });
  await w.seedPayment({ inv: iF, amount: "5.55", date: "2026-03-02" });
  await w.seedPayment({ inv: iA, amount: "9.00", date: "2026-03-08", deleted: true });
  await w.seedRefund(pA1, "10.01", "2026-03-20T10:00:00Z");
  await w.seedRefund(pE, "5.00", "2026-04-02T10:00:00Z");
  await w.seedExpense({ amount: "33.33", on: "2026-03-03" });
  await w.seedExpense({ amount: "0.67", on: "2026-03-31" });
  await w.seedExpense({ amount: "9.99", on: "2026-03-10", voided: true });
  await w.seedExpense({ amount: "8.00", on: "2026-03-11", deleted: true });
  await w.seedExpense({ amount: "1.00", on: "2026-04-01" });
  await w.seedExpense({ amount: "12.34", cur: "EUR", on: "2026-03-12" });
  return { c1, c2 };
}

test("reports/summary: per-currency totals equal the raw rows; voided, deleted and out-of-range rows excluded", () =>
  withWorld(async (w) => {
    await seedSummary(w);
    const r = await w.http("GET", "/finance/reports/summary?from=2026-03-01&to=2026-03-31", w.T.acct);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.from, "2026-03-01");
    assert.equal(r.body.to, "2026-03-31");
    assert.deepEqual(r.body.rows, [
      { currency: "EUR", invoiced: "300.05", collected: "100.00", refunded: "0.00", expenses: "12.34", net: "87.66" },
      { currency: "TND", invoiced: "300.30", collected: "165.72", refunded: "10.01", expenses: "34.00", net: "121.71" },
    ]);
    // A different window: the April rows only.
    const apr = await w.http("GET", "/finance/reports/summary?from=2026-04-01&to=2026-04-30", w.T.acct);
    assert.deepEqual(apr.body.rows, [
      { currency: "EUR", invoiced: "0.00", collected: "0.00", refunded: "5.00", expenses: "0.00", net: "-5.00" },
      { currency: "TND", invoiced: "50.00", collected: "20.00", refunded: "0.00", expenses: "1.00", net: "19.00" },
    ]);
    // No window = everything (non-voided): TND invoiced 300.30 + 50.00 + 10.00
    const everything = await w.http("GET", "/finance/reports/summary", w.T.acct);
    const tnd = everything.body.rows.find((x) => x.currency === "TND");
    assert.equal(tnd.invoiced, "360.30");
    assert.equal(tnd.collected, "185.72");
    // Empty window: no rows, not zeros for invented currencies.
    assert.deepEqual((await w.http("GET", "/finance/reports/summary?from=2030-01-01&to=2030-01-31", w.T.acct)).body.rows, []);
    for (const bad of ["from=2026-03-31&to=2026-03-01", "from=2026-02-30", "to=yesterday", "from=2026-03-01&from=2026-03-02"]) {
      assert.equal((await w.http("GET", `/finance/reports/summary?${bad}`, w.T.acct)).status, 400, bad);
    }
  }));

test("reports/summary: exact decimals (0.10 + 0.20 style sums stay exact in SQL NUMERIC)", () =>
  withWorld(async (w) => {
    const c = await w.candidate();
    const i = await w.seedInvoice({ cand: c, total: "0.10", issued: "2026-05-01T00:00:00Z" });
    await w.seedInvoice({ cand: c, total: "0.20", issued: "2026-05-02T00:00:00Z" });
    await w.seedPayment({ inv: i, amount: "0.10", date: "2026-05-03" });
    for (let k = 0; k < 3; k++) await w.seedExpense({ amount: "0.10", on: "2026-05-04" });
    const r = await w.http("GET", "/finance/reports/summary?from=2026-05-01&to=2026-05-31", w.T.acct);
    assert.deepEqual(r.body.rows, [{ currency: "TND", invoiced: "0.30", collected: "0.10", refunded: "0.00", expenses: "0.30", net: "-0.20" }]);
  }));

test("legacy /finance/dashboard totals tie to the new summary for the same data (voided rows ignored by both)", () =>
  withWorld(async (w) => {
    await seedSummary(w);
    const sum = (await w.http("GET", "/finance/reports/summary", w.T.acct)).body.rows;
    const cents = (s) => BigInt(s.replace(".", ""));
    const fmt = (c) => `${c / 100n}.${String(c % 100n).padStart(2, "0")}`;
    const total = (k) => sum.reduce((a, r) => a + cents(r[k]), 0n);
    const dash = (await w.http("GET", "/finance/dashboard", w.T.acct)).body;
    assert.equal(fmt(total("invoiced")), String(dash.total_invoiced));
    assert.equal(fmt(total("collected") - total("refunded")), String(dash.total_in), "money in = collected - refunded");
    assert.equal(fmt(total("expenses")), String(dash.total_out));
    // Voiding an expense through the API moves both identically.
    const e = (await w.http("POST", "/finance/expenses", w.T.acct, expense({ amount: "77.70", spent_on: dayOffset(0) }))).body;
    const before = (await w.http("GET", "/finance/dashboard", w.T.acct)).body.total_out;
    assert.equal((await w.http("POST", `/finance/expenses/${e.id}/void`, w.T.acct, { reason: "oops" })).status, 200);
    const after = (await w.http("GET", "/finance/dashboard", w.T.acct)).body.total_out;
    assert.equal(cents(String(before)) - cents(String(after)), 7770n);
    const sum2 = (await w.http("GET", "/finance/reports/summary", w.T.acct)).body.rows;
    assert.equal(fmt(sum2.reduce((a, r) => a + cents(r.expenses), 0n)), String(after));
  }));

// ================================================================================================ receivables
test("reports/receivables: ageing buckets by due_date vs injectable asOf, per currency, per-candidate rows with paging", () =>
  withWorld(async (w) => {
    const X = await w.candidate("Cand X");
    const Y = await w.candidate("Cand Y");
    const Z = await w.candidate("Cand Z");
    const mk = (cand, rem, due, extra = {}) => w.seedInvoice({ cand, total: rem, remaining: rem, due, ...extra });
    await mk(X, "100.00", "2026-07-15"); // current (not yet due)
    await mk(Y, "50.00", "2026-06-30"); // due on asOf -> current
    await mk(Y, "25.50", "2026-06-29"); // 1 day -> 0-30
    await mk(Z, "10.00", "2026-05-31"); // 30 days -> 0-30
    await mk(X, "20.00", "2026-05-30"); // 31 -> 31-60
    await mk(Y, "7.00", "2026-05-01"); // 60 -> 31-60
    await mk(Z, "3.00", "2026-04-30"); // 61 -> 61-90
    await mk(Z, "4.00", "2026-04-01"); // 90 -> 61-90
    await mk(X, "5.00", "2026-03-31"); // 91 -> 90+
    await mk(Y, "6.00", null); // no due date
    await mk(Y, "80.00", "2026-01-01", { cur: "EUR" }); // EUR 90+
    // never counted: settled, void, deleted, draft
    await w.seedInvoice({ cand: X, total: "99.00", remaining: "0.00", due: "2026-01-01", status: "Paid" });
    await w.seedInvoice({ cand: X, total: "98.00", due: "2026-01-01", status: "Void", voided: true });
    await w.seedInvoice({ cand: X, total: "97.00", due: "2026-01-01", deleted: true });
    await w.seedInvoice({ cand: X, total: "96.00", due: "2026-01-01", status: "Draft" });

    const r = await w.http("GET", "/finance/reports/receivables?asOf=2026-06-30", w.T.acct);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.asOf, "2026-06-30");
    const zero = { current: "0.00", "0-30": "0.00", "31-60": "0.00", "61-90": "0.00", "90+": "0.00", no_due_date: "0.00" };
    assert.deepEqual(r.body.currencies, [
      { currency: "EUR", total: "80.00", count: 1, buckets: { ...zero, "90+": "80.00" } },
      { currency: "TND", total: "230.50", count: 10, buckets: { current: "150.00", "0-30": "35.50", "31-60": "27.00", "61-90": "7.00", "90+": "5.00", no_due_date: "6.00" } },
    ]);
    assert.equal(r.body.total, 4);
    assert.deepEqual(
      r.body.rows.map((x) => [x.candidate_name, x.currency, x.balance, x.invoices, x.oldest_due_date]),
      [
        ["Cand X", "TND", "125.00", 3, "2026-03-31"],
        ["Cand Y", "TND", "88.50", 4, "2026-05-01"],
        ["Cand Y", "EUR", "80.00", 1, "2026-01-01"],
        ["Cand Z", "TND", "17.00", 3, "2026-04-01"],
      ]
    );
    assert.equal(r.body.rows[0].candidate_id, X);
    const page = await w.http("GET", "/finance/reports/receivables?asOf=2026-06-30&limit=2&offset=2", w.T.acct);
    assert.deepEqual(page.body.rows.map((x) => [x.candidate_name, x.currency]), [["Cand Y", "EUR"], ["Cand Z", "TND"]]);
    assert.equal(page.body.total, 4);
    // The clock is injectable: one day later the 2026-06-30 invoice is 1 day overdue.
    const later = await w.http("GET", "/finance/reports/receivables?asOf=2026-07-01", w.T.acct);
    const t = later.body.currencies.find((c) => c.currency === "TND");
    assert.equal(t.buckets.current, "100.00");
    assert.equal(t.buckets["0-30"], "75.50", "25.50 + 50.00; the 10.00 invoice is now 31 days overdue");
    assert.equal(t.buckets["31-60"], "30.00");
    // Default asOf = today (UTC).
    const def = await w.http("GET", "/finance/reports/receivables", w.T.acct);
    assert.equal(def.body.asOf, dayOffset(0));
    for (const bad of ["asOf=2026-02-30", "asOf=today", "asOf=2026-06-30&asOf=2026-06-29", "limit=0x", "offset=-1"]) {
      assert.equal((await w.http("GET", `/finance/reports/receivables?${bad}`, w.T.acct)).status, 400, bad);
    }
  }));

// ================================================================================================ by-service / by-staff
test("reports/by-service: item line totals grouped by service or description per currency (voided and out-of-range excluded)", () =>
  withWorld(async (w) => {
    const c = await w.candidate();
    const svc = (await w.one("INSERT INTO fin_services (code, name_en, name_fr, default_price) VALUES ('CV1','CV writing','Rédaction CV',50) RETURNING id")).id;
    const i1 = await w.seedInvoice({ cand: c, total: "115.50", issued: "2026-03-05T10:00:00Z" });
    await w.seedItem(i1, { service: svc, desc: "CV writing", qty: "2.00", price: "50.00" });
    await w.seedItem(i1, { desc: "Courier", qty: "1.00", price: "15.50", pos: 1 });
    const i2 = await w.seedInvoice({ cand: c, total: "50.00", issued: "2026-03-20T10:00:00Z" });
    await w.seedItem(i2, { service: svc, desc: "CV writing (rush)", qty: "1.50", price: "33.33" }); // 49.995 -> 50.00 half up
    const i3 = await w.seedInvoice({ cand: c, total: "40.00", cur: "EUR", issued: "2026-03-21T10:00:00Z" });
    await w.seedItem(i3, { service: svc, desc: "CV writing", qty: "1.00", price: "40.00" });
    const iv = await w.seedInvoice({ cand: c, total: "999.00", issued: "2026-03-22T10:00:00Z", status: "Void", voided: true });
    await w.seedItem(iv, { service: svc, desc: "void", qty: "1.00", price: "999.00" });
    const io = await w.seedInvoice({ cand: c, total: "888.00", issued: "2026-05-22T10:00:00Z" });
    await w.seedItem(io, { desc: "Courier", qty: "1.00", price: "888.00" });
    const r = await w.http("GET", "/finance/reports/by-service?from=2026-03-01&to=2026-03-31", w.T.acct);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(
      r.body.rows.map((x) => [x.currency, x.service_id === null ? null : Number(x.service_id), x.code, x.label, x.lines, x.quantity, x.total]),
      [
        ["EUR", Number(svc), "CV1", "CV writing", 1, "1.00", "40.00"],
        ["TND", Number(svc), "CV1", "CV writing", 2, "3.50", "150.00"],
        ["TND", null, null, "Courier", 1, "1.00", "15.50"],
      ]
    );
    assert.equal((await w.http("GET", "/finance/reports/by-service?from=2026-03-31&to=2026-03-01", w.T.acct)).status, 400);
  }));

test("reports/by-staff: invoices and payments created per user per currency", () =>
  withWorld(async (w) => {
    const c = await w.candidate();
    const a1 = await w.seedInvoice({ cand: c, total: "100.00", by: w.ids.acct, issued: "2026-03-05T10:00:00Z" });
    await w.seedInvoice({ cand: c, total: "50.25", by: w.ids.acct, issued: "2026-03-06T10:00:00Z" });
    await w.seedInvoice({ cand: c, total: "10.00", cur: "EUR", by: w.ids.acct, issued: "2026-03-07T10:00:00Z" });
    const b1 = await w.seedInvoice({ cand: c, total: "20.00", by: w.ids.admin, issued: "2026-03-08T10:00:00Z" });
    await w.seedInvoice({ cand: c, total: "500.00", by: w.ids.admin, issued: "2026-03-09T10:00:00Z", status: "Void", voided: true });
    await w.seedInvoice({ cand: c, total: "700.00", by: w.ids.admin, issued: "2026-06-09T10:00:00Z" });
    await w.seedPayment({ inv: a1, amount: "30.00", date: "2026-03-10", by: w.ids.acct });
    await w.seedPayment({ inv: a1, amount: "5.00", date: "2026-03-11", by: w.ids.acct });
    await w.seedPayment({ inv: b1, amount: "12.00", date: "2026-03-12", by: w.ids.admin });
    await w.seedPayment({ inv: b1, amount: "1.00", date: "2026-03-13", by: w.ids.admin, voided: true });
    await w.seedPayment({ inv: b1, amount: "2.00", date: "2026-07-13", by: w.ids.admin });
    const r = await w.http("GET", "/finance/reports/by-staff?from=2026-03-01&to=2026-03-31", w.T.acct);
    assert.equal(r.status, 200, r.text);
    const pick = (x) => [x.user_id, x.user_name, x.currency, x.invoices_count, x.invoices_total, x.payments_count, x.payments_total];
    assert.deepEqual(r.body.rows.map(pick), [
      [w.ids.admin, "Admin admin", "TND", 1, "20.00", 1, "12.00"],
      [w.ids.acct, "Accountant acct", "EUR", 1, "10.00", 0, "0.00"],
      [w.ids.acct, "Accountant acct", "TND", 2, "150.25", 2, "35.00"],
    ].sort((p, q) => (p[1] === q[1] ? p[2].localeCompare(q[2]) : p[1].localeCompare(q[1]))));
    for (const row of r.body.rows) assert.deepEqual(Object.keys(row).sort(), ["currency", "invoices_count", "invoices_total", "payments_count", "payments_total", "user_id", "user_name"]);
  }));

// ================================================================================================ candidate statement
test("reports/candidate/:id: chronological statement with running balance per currency; voided rows and other candidates excluded", () =>
  withWorld(async (w) => {
    const c = await w.candidate("Statement Person");
    const other = await w.candidate("Someone Else");
    const i1 = await w.seedInvoice({ cand: c, total: "100.00", remaining: "40.00", number: "S-1", issued: "2026-03-01T10:00:00Z" });
    const i2 = await w.seedInvoice({ cand: c, total: "40.00", remaining: "0.00", number: "S-2", issued: "2026-03-10T10:00:00Z" });
    const i3 = await w.seedInvoice({ cand: c, total: "50.00", remaining: "30.00", cur: "EUR", number: "S-3", issued: "2026-03-05T10:00:00Z" });
    await w.seedInvoice({ cand: c, total: "9.00", number: "S-V", status: "Void", voided: true, issued: "2026-03-02T10:00:00Z" });
    const p1 = await w.seedPayment({ inv: i1, amount: "60.00", date: "2026-03-02", receipt: "R-S1" });
    await w.seedPayment({ inv: i2, amount: "40.00", date: "2026-03-12", receipt: "R-S2" });
    await w.seedPayment({ inv: i1, amount: "10.00", date: "2026-03-03", receipt: "R-VOID", voided: true });
    await w.seedPayment({ inv: i3, amount: "20.00", date: "2026-03-06", receipt: "R-S3" });
    await w.seedRefund(p1, "15.00", "2026-03-15T09:00:00Z");
    const oi = await w.seedInvoice({ cand: other, total: "777.00", number: "O-1", issued: "2026-03-04T10:00:00Z" });
    await w.seedPayment({ inv: oi, amount: "1.00", date: "2026-03-04" });

    const r = await w.http("GET", `/finance/reports/candidate/${c}`, w.T.acct);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.candidate.id, c);
    assert.equal(r.body.candidate.full_name, "Statement Person");
    assert.deepEqual(
      r.body.entries.map((e) => [e.date, e.kind, e.ref, e.currency, e.debit, e.credit, e.balance]),
      [
        ["2026-03-01", "invoice", "S-1", "TND", "100.00", "0.00", "100.00"],
        ["2026-03-02", "payment", "R-S1", "TND", "0.00", "60.00", "40.00"],
        ["2026-03-05", "invoice", "S-3", "EUR", "50.00", "0.00", "50.00"],
        ["2026-03-06", "payment", "R-S3", "EUR", "0.00", "20.00", "30.00"],
        ["2026-03-10", "invoice", "S-2", "TND", "40.00", "0.00", "80.00"],
        ["2026-03-12", "payment", "R-S2", "TND", "0.00", "40.00", "40.00"],
        ["2026-03-15", "refund", "R-S1", "TND", "15.00", "0.00", "55.00"],
      ]
    );
    assert.deepEqual(r.body.balances, [
      { currency: "EUR", balance: "30.00", open: "30.00" },
      { currency: "TND", balance: "55.00", open: "40.00" },
    ]);
    assert.ok(!r.text.includes("O-1"));
    // Unknown, deleted and malformed candidates.
    assert.equal((await w.http("GET", "/finance/reports/candidate/999999", w.T.acct)).status, 404);
    assert.equal((await w.http("GET", "/finance/reports/candidate/99999999999", w.T.acct)).status, 404);
    assert.equal((await w.http("GET", "/finance/reports/candidate/abc", w.T.acct)).status, 400);
    await w.q("UPDATE candidates SET is_deleted = true WHERE id = $1", [other]);
    assert.equal((await w.http("GET", `/finance/reports/candidate/${other}`, w.T.acct)).status, 404);
    // A candidate with no activity is an empty statement, not an error.
    const empty = await w.candidate("Nobody");
    const e = await w.http("GET", `/finance/reports/candidate/${empty}`, w.T.acct);
    assert.equal(e.status, 200);
    assert.deepEqual([e.body.entries, e.body.balances], [[], []]);
  }));

// ================================================================================================ CSV export
test("CSV export: BOM, headers, every cell quoted, formula guard, quotes, newlines, Arabic, decimal-string amounts", () =>
  withWorld(async (w) => {
    const names = ["=HYPERLINK(\"http://evil\")", "+1+1", "-2+3", "@SUM(1,1)", "\tTAB", "\rCR", 'He said "hi", twice', "line1\nline2", "أمينة بن علي", "Plain Name"];
    for (const [k, name] of names.entries()) {
      const c = await w.candidate(name);
      await w.seedInvoice({ cand: c, total: `${k + 1}.50`, remaining: `${k + 1}.50`, number: `CSV-${String(k).padStart(2, "0")}`, issued: "2026-03-10T10:00:00Z" });
    }
    const r = await fetch(`${w.base}/finance/export/invoices.csv?from=2026-03-01&to=2026-03-31`, { headers: { authorization: `Bearer ${w.T.acct}` } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.match(r.headers.get("content-disposition"), /^attachment; filename="[A-Za-z0-9._-]+\.csv"$/);
    assert.equal(r.headers.get("x-row-limit-hit"), null);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM bytes");
    const rows = parseCsv(bytes.toString("utf8"));
    const head = rows[0];
    assert.ok(head.includes("number") && head.includes("candidate_name") && head.includes("total_amount") && head.includes("currency"));
    const col = (name) => head.indexOf(name);
    assert.equal(rows.length, 1 + names.length);
    const byNumber = Object.fromEntries(rows.slice(1).map((x) => [x[col("number")], x]));
    const expected = ["'=HYPERLINK(\"http://evil\")", "'+1+1", "'-2+3", "'@SUM(1,1)", "'\tTAB", "'\rCR", 'He said "hi", twice', "line1\nline2", "أمينة بن علي", "Plain Name"];
    expected.forEach((want, k) => {
      const row = byNumber[`CSV-${String(k).padStart(2, "0")}`];
      assert.equal(row[col("candidate_name")], want, `row ${k}`);
      assert.match(row[col("total_amount")], /^\d+\.\d{2}$/);
      assert.equal(row[col("total_amount")], `${k + 1}.50`);
    });
    // Rows end with CRLF (the parser enforces it); the file ends with CRLF too.
    assert.ok(bytes.toString("utf8").endsWith('"\r\n'));
  }));

test("CSV export: payments and expenses (reference / title / notes are guarded), date window, voided rows labelled", () =>
  withWorld(async (w) => {
    const c = await w.candidate("Payer");
    const inv = (await w.http("POST", "/finance/invoices/v2", w.T.acct, { candidate_id: c, currency: "TND", items: [{ description: "Svc", quantity: 1, unit_price: "100" }] })).body;
    const p = await w.http("POST", "/finance/payments/v2", w.T.acct, { invoice_id: inv.id, amount: "25.50", method: "bank_transfer", reference: "=cmd|' /C calc'!A0", notes: "-note, \"q\"" });
    assert.equal(p.status, 201, p.text);
    await w.http("POST", "/finance/expenses", w.T.acct, expense({ title: "@evil", notes: "+x", amount: "9.99", spent_on: dayOffset(0) }));
    const old = (await w.http("POST", "/finance/expenses", w.T.acct, expense({ title: "Old one", spent_on: "2026-01-02" }))).body;
    await w.http("POST", `/finance/expenses/${old.id}/void`, w.T.acct, { reason: "-bad" });
    const get = async (path) => {
      const r = await fetch(w.base + path, { headers: { authorization: `Bearer ${w.T.acct}` } });
      assert.equal(r.status, 200, path);
      return parseCsv(Buffer.from(await r.arrayBuffer()).toString("utf8"));
    };
    const pay = await get("/finance/export/payments.csv");
    const ph = pay[0];
    assert.equal(pay.length, 2);
    assert.equal(pay[1][ph.indexOf("reference")], "'=cmd|' /C calc'!A0");
    assert.equal(pay[1][ph.indexOf("notes")], "'-note, \"q\"");
    assert.equal(pay[1][ph.indexOf("amount_paid")], "25.50");
    assert.equal(pay[1][ph.indexOf("payment_method")], "bank_transfer");
    assert.match(pay[1][ph.indexOf("receipt_number")], /^REC-\d{4}-\d{6}$/);
    const exp = await get("/finance/export/expenses.csv");
    const eh = exp[0];
    assert.equal(exp.length, 3, "voided rows are exported (labelled), nothing is silently hidden");
    const evil = exp.find((x) => x[eh.indexOf("title")] === "'@evil");
    assert.ok(evil);
    assert.equal(evil[eh.indexOf("notes")], "'+x");
    const voided = exp.find((x) => x[eh.indexOf("title")] === "Old one");
    assert.ok(voided[eh.indexOf("voided_at")]);
    assert.equal(voided[eh.indexOf("void_reason")], "'-bad");
    const win = await get("/finance/export/expenses.csv?from=2026-01-01&to=2026-01-31");
    assert.equal(win.length, 2);
    assert.equal(win[1][eh.indexOf("title")], "Old one");
    const aud = Number((await w.q("SELECT count(*) n FROM audit_logs WHERE action = 'EXPORT'")).rows[0].n);
    assert.ok(aud >= 3, "exports are audited");
  }));

test("CSV export: row cap (FIN_EXPORT_MAX_ROWS) sets X-Row-Limit-Hit and truncates; at the cap exactly there is no header", () =>
  withWorld(async (w) => {
    for (let k = 0; k < 5; k++) await w.seedExpense({ title: `E${k}`, amount: "1.00", on: "2026-03-01" });
    process.env.FIN_EXPORT_MAX_ROWS = "3";
    try {
      const r = await fetch(`${w.base}/finance/export/expenses.csv`, { headers: { authorization: `Bearer ${w.T.acct}` } });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-row-limit-hit"), "true");
      assert.equal(parseCsv(Buffer.from(await r.arrayBuffer()).toString("utf8")).length, 1 + 3);
      process.env.FIN_EXPORT_MAX_ROWS = "5";
      const exact = await fetch(`${w.base}/finance/export/expenses.csv`, { headers: { authorization: `Bearer ${w.T.acct}` } });
      assert.equal(exact.headers.get("x-row-limit-hit"), null);
      assert.equal(parseCsv(Buffer.from(await exact.arrayBuffer()).toString("utf8")).length, 1 + 5);
      process.env.FIN_EXPORT_MAX_ROWS = "banana";
      const dflt = await fetch(`${w.base}/finance/export/expenses.csv`, { headers: { authorization: `Bearer ${w.T.acct}` } });
      assert.equal(dflt.headers.get("x-row-limit-hit"), null, "garbage falls back to the 50000 default");
      assert.equal(parseCsv(Buffer.from(await dflt.arrayBuffer()).toString("utf8")).length, 1 + 5);
    } finally {
      delete process.env.FIN_EXPORT_MAX_ROWS;
    }
  }));

test("CSV export: validation (dates, unknown report) and permission (Manager yes, Agent/Receptionist/HR no)", () =>
  withWorld(async (w) => {
    const get = (path, token) => fetch(w.base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    for (const bad of ["from=2026-02-30", "to=x", "from=2026-03-02&to=2026-03-01"]) assert.equal((await get(`/finance/export/invoices.csv?${bad}`, w.T.acct)).status, 400, bad);
    assert.equal((await get("/finance/export/secrets.csv", w.T.acct)).status, 404);
    for (const f of ["invoices", "payments", "expenses"]) {
      for (const role of ["sa", "admin", "acct", "mgr"]) assert.equal((await get(`/finance/export/${f}.csv`, w.T[role])).status, 200, `${role} ${f}`);
      for (const role of ["agent", "rec", "hr", "emp", "agy"]) assert.equal((await get(`/finance/export/${f}.csv`, w.T[role])).status, 403, `${role} ${f}`);
      assert.equal((await get(`/finance/export/${f}.csv`, null)).status, 401);
    }
  }));

// ================================================================================================ candidate self-view
test("candidate self-view: sees only own invoices and payments; no notes, staff data, void reasons or foreign rows", () =>
  withWorld(async (w) => {
    const A = await w.candidate("Alice Own");
    const B = await w.candidate("Bob Foreign");
    const la = await w.candidateLogin(A);
    const mkInv = async (cand, desc, notes, price = "100") =>
      (await w.http("POST", "/finance/invoices/v2", w.T.acct, { candidate_id: cand, currency: "TND", notes, due_date: "2026-12-01", items: [{ description: desc, quantity: 2, unit_price: price }, { description: `${desc} extra`, quantity: 1, unit_price: "5.50" }] })).body;
    const a1 = await mkInv(A, "Alice service", "STAFF-NOTE-ALICE");
    const a2 = await mkInv(A, "Alice second", "STAFF-NOTE-ALICE-2", "10");
    const b1 = await mkInv(B, "Bob SECRET service", "STAFF-NOTE-BOB");
    const pay = async (inv, amount, extra = {}) => (await w.http("POST", "/finance/payments/v2", w.T.acct, { invoice_id: inv.id, amount, method: "cash", notes: "STAFF-PAY-NOTE", reference: "REF-INTERNAL", ...extra })).body.payment;
    const p1 = await pay(a1, "50");
    const pv = await pay(a1, "20");
    assert.equal((await w.http("POST", `/finance/payments/${pv.id}/void`, w.T.acct, { reason: "VOID-REASON-SECRET" })).status, 200);
    await pay(b1, "30");
    await w.http("POST", `/finance/invoices/${a2.id}/void`, w.T.acct, { reason: "INVOICE-VOID-SECRET" });
    // A draft and a deleted invoice are not shown.
    const draft = await w.seedInvoice({ cand: A, total: "11.00", status: "Draft", number: "DRAFT-1" });
    const gone = await w.seedInvoice({ cand: A, total: "12.00", number: "GONE-1", deleted: true });

    const r = await w.http("GET", "/finance/me", la.token);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.body).sort(), ["invoices", "totals"]);
    const mine = r.body.invoices;
    assert.equal(mine.length, 2, "own non-draft, non-deleted invoices only");
    for (const bad of ["STAFF-NOTE", "STAFF-PAY-NOTE", "REF-INTERNAL", "VOID-REASON-SECRET", "INVOICE-VOID-SECRET", "Bob", "SECRET", b1.number, "DRAFT-1", "GONE-1", "created_by", "candidate_id", "notes", "void_reason", "voided_at", "candidate_name"]) {
      assert.ok(!r.text.includes(bad), `response must not contain ${bad}`);
    }
    const inv1 = mine.find((x) => x.number === a1.number);
    assert.deepEqual(Object.keys(inv1).sort(), ["currency", "due_date", "id", "issued_at", "items", "number", "payments", "remaining", "status", "total"]);
    assert.equal(inv1.id, a1.id);
    assert.equal(inv1.total, "205.50");
    assert.equal(inv1.remaining, "155.50");
    assert.equal(inv1.status, "Partial");
    assert.equal(inv1.due_date, "2026-12-01");
    assert.match(inv1.issued_at, /^\d{4}-\d{2}-\d{2}/);
    assert.deepEqual(inv1.items, [
      { description: "Alice service", quantity: "2.00", unit_price: "100.00", line_total: "200.00" },
      { description: "Alice service extra", quantity: "1.00", unit_price: "5.50", line_total: "5.50" },
    ]);
    assert.equal(inv1.payments.length, 2);
    for (const p of inv1.payments) assert.deepEqual(Object.keys(p).sort(), ["amount", "method", "payment_date", "receipt_number", "voided"]);
    assert.deepEqual(inv1.payments.map((p) => [p.receipt_number, p.amount, p.method, p.voided]), [[p1.receipt_number, "50.00", "cash", false], [pv.receipt_number, "20.00", "cash", true]]);
    const inv2 = mine.find((x) => x.number === a2.number);
    assert.equal(inv2.status, "Void");
    // Totals: void invoice and voided payment excluded.
    assert.deepEqual(r.body.totals, [{ currency: "TND", invoiced: "205.50", paid: "50.00", refunded: "0.00", remaining: "155.50" }]);

    // Print: own invoice yes (without staff notes), foreign / missing / draft / deleted -> identical 404.
    const own = await fetch(`${w.base}/finance/me/invoices/${a1.id}/print`, { headers: { authorization: `Bearer ${la.token}` } });
    assert.equal(own.status, 200);
    assert.match(own.headers.get("content-type"), /^text\/html/);
    assert.match(own.headers.get("content-security-policy"), /default-src 'none'/);
    const html = await own.text();
    assert.ok(html.includes(a1.number));
    assert.ok(html.includes("Alice service"));
    assert.ok(!html.includes("STAFF-NOTE"), "staff notes are not printed for the candidate");
    const ar = await fetch(`${w.base}/finance/me/invoices/${a1.id}/print?lang=ar`, { headers: { authorization: `Bearer ${la.token}` } });
    assert.equal(ar.status, 200);
    assert.match(await ar.text(), /dir="rtl"/);
    const voidHtml = await (await fetch(`${w.base}/finance/me/invoices/${a2.id}/print`, { headers: { authorization: `Bearer ${la.token}` } })).text();
    assert.ok(!voidHtml.includes("INVOICE-VOID-SECRET"), "void reason is not printed for the candidate");
    const probe = async (id) => {
      const x = await fetch(`${w.base}/finance/me/invoices/${id}/print`, { headers: { authorization: `Bearer ${la.token}` } });
      return { status: x.status, text: await x.text(), ct: x.headers.get("content-type") };
    };
    const missing = await probe(987654);
    assert.equal(missing.status, 404);
    for (const id of [b1.id, draft, gone, 99999999999]) {
      const f = await probe(id);
      assert.deepEqual(f, missing, `foreign/draft/deleted/huge id ${id} answers exactly like a missing one`);
    }
    assert.equal((await fetch(`${w.base}/finance/me/invoices/${a1.id}/print?lang=zz`, { headers: { authorization: `Bearer ${la.token}` } })).status, 400);
    // Bob (own login) cannot see Alice's rows either.
    const lb = await w.candidateLogin(B);
    const rb = await w.http("GET", "/finance/me", lb.token);
    assert.equal(rb.body.invoices.length, 1);
    assert.ok(!rb.text.includes("Alice"));
    assert.equal((await fetch(`${w.base}/finance/me/invoices/${a1.id}/print`, { headers: { authorization: `Bearer ${lb.token}` } })).status, 404);
  }));

test("candidate self-view: refunds show in totals; a login without a linked candidate gets 404; nothing to show is an empty list", () =>
  withWorld(async (w) => {
    const A = await w.candidate("Alice Own");
    const la = await w.candidateLogin(A);
    const empty = await w.http("GET", "/finance/me", la.token);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { invoices: [], totals: [] });
    const inv = (await w.http("POST", "/finance/invoices/v2", w.T.acct, { candidate_id: A, currency: "EUR", items: [{ description: "X", quantity: 1, unit_price: "80" }] })).body;
    const p = (await w.http("POST", "/finance/payments/v2", w.T.acct, { invoice_id: inv.id, amount: "80", method: "card" })).body.payment;
    assert.equal((await w.http("POST", `/finance/payments/${p.id}/refund`, w.T.acct, { amount: "30", reason: "r" })).status, 201);
    const r = await w.http("GET", "/finance/me", la.token);
    assert.deepEqual(r.body.totals, [{ currency: "EUR", invoiced: "80.00", paid: "80.00", refunded: "30.00", remaining: "0.00" }]);
    const unlinked = await w.candidateLogin(A, { link: false });
    assert.equal((await w.http("GET", "/finance/me", unlinked.token)).status, 404);
    // Unlinked candidate / suspended session: token_version mismatch is a 401 from the shared session check.
    await w.q("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [la.userId]);
    assert.equal((await w.http("GET", "/finance/me", la.token)).status, 401);
  }));

// ================================================================================================ access matrix
const STAFF_ROUTES = [
  ["GET", "/finance/dashboard"], ["POST", "/finance/invoices"], ["POST", "/finance/payments"],
  ["GET", "/finance/services"], ["POST", "/finance/services"], ["PATCH", "/finance/services/1"],
  ["POST", "/finance/invoices/v2"], ["GET", "/finance/invoices"], ["GET", "/finance/invoices/1"], ["POST", "/finance/invoices/1/void"], ["GET", "/finance/invoices/1/print"],
  ["GET", "/finance/payments"], ["POST", "/finance/payments/v2"], ["POST", "/finance/payments/1/void"], ["POST", "/finance/payments/1/refund"], ["GET", "/finance/payments/1/receipt"],
  ["GET", "/finance/expenses"], ["POST", "/finance/expenses"], ["POST", "/finance/expenses/1/void"], ["GET", "/finance/expense-categories"], ["POST", "/finance/expense-categories"], ["PATCH", "/finance/expense-categories/1"],
  ["GET", "/finance/reports/summary"], ["GET", "/finance/reports/receivables"], ["GET", "/finance/reports/by-service"], ["GET", "/finance/reports/by-staff"], ["GET", "/finance/reports/candidate/1"],
  ["GET", "/finance/export/invoices.csv"], ["GET", "/finance/export/payments.csv"], ["GET", "/finance/export/expenses.csv"],
];

test("access: a Candidate token is refused on EVERY staff finance route; /finance/me is Candidate-only", () =>
  withWorld(async (w) => {
    const A = await w.candidate();
    const la = await w.candidateLogin(A);
    for (const [m, url] of STAFF_ROUTES) {
      const r = await w.http(m, url, la.token, m === "GET" ? undefined : {});
      assert.equal(r.status, 403, `Candidate ${m} ${url} -> ${r.status}`);
      assert.deepEqual(Object.keys(r.body || {}), ["error"]);
    }
    // Look-alike paths do not slip through the carve-out.
    for (const url of ["/finance/mean", "/finance/me-x", "/finance/meta/invoices"]) {
      const r = await w.http("GET", url, la.token);
      assert.ok([403, 404].includes(r.status), `${url} -> ${r.status}`);
      assert.notEqual(r.status, 200, url);
    }
    assert.equal((await w.http("POST", "/finance/me", la.token, {})).status, 404, "no write verbs on /me");
    assert.equal((await w.http("GET", "/finance/me/invoices/1", la.token)).status, 404);
    // Everyone but a Candidate is refused on /finance/me*.
    for (const [role, token] of [["sa", w.T.sa], ["admin", w.T.admin], ["acct", w.T.acct], ["mgr", w.T.mgr], ["agent", w.T.agent], ["rec", w.T.rec], ["hr", w.T.hr], ["emp", w.T.emp], ["agy", w.T.agy]]) {
      for (const url of ["/finance/me", "/finance/me/invoices/1/print"]) {
        const r = await w.http("GET", url, token);
        assert.equal(r.status, 403, `${role} ${url} -> ${r.status}`);
      }
    }
    assert.equal((await w.http("GET", "/finance/me", null)).status, 401);
    assert.equal((await w.http("GET", "/finance/me/invoices/1/print", null)).status, 401);
    // Employer / Agency stay denied on every staff route as well.
    for (const [m, url] of STAFF_ROUTES) {
      for (const token of [w.T.emp, w.T.agy]) assert.equal((await w.http(m, url, token, m === "GET" ? undefined : {})).status, 403, `${m} ${url}`);
    }
  }));

test("role matrix: Manager reads and exports but cannot write or void; Agent/Receptionist/HR have nothing; Accountant/Admin/SuperAdmin everything", () =>
  withWorld(async (w) => {
    const e = (await w.http("POST", "/finance/expenses", w.T.acct, expense())).body;
    const reads = ["/finance/expenses", "/finance/expense-categories", "/finance/reports/summary", "/finance/reports/receivables", "/finance/reports/by-service", "/finance/reports/by-staff"];
    for (const role of ["sa", "admin", "acct", "mgr"]) for (const url of reads) assert.equal((await w.http("GET", url, w.T[role])).status, 200, `${role} ${url}`);
    for (const role of ["agent", "rec", "hr"]) {
      for (const url of reads) assert.equal((await w.http("GET", url, w.T[role])).status, 403, `${role} ${url}`);
      assert.equal((await w.http("POST", "/finance/expenses", w.T[role], expense())).status, 403);
      assert.equal((await w.http("GET", "/finance/reports/candidate/1", w.T[role])).status, 403);
    }
    // Manager: no writes, no voids.
    assert.equal((await w.http("POST", "/finance/expenses", w.T.mgr, expense())).status, 403);
    assert.equal((await w.http("POST", "/finance/expense-categories", w.T.mgr, { name: "Nope" })).status, 403);
    assert.equal((await w.http("POST", `/finance/expenses/${e.id}/void`, w.T.mgr, { reason: "x" })).status, 403);
    // Admin / SuperAdmin / Accountant write and void.
    for (const [i, role] of ["sa", "admin", "acct"].entries()) {
      const c = await w.http("POST", "/finance/expense-categories", w.T[role], { name: `Cat ${role}` });
      assert.equal(c.status, 201, role);
      const x = await w.http("POST", "/finance/expenses", w.T[role], expense({ category_id: c.body.id, title: `by ${role}` }));
      assert.equal(x.status, 201, role);
      assert.equal((await w.http("POST", `/finance/expenses/${x.body.id}/void`, w.T[role], { reason: "t" })).status, 200, role);
      void i;
    }
    const cand = await w.candidate();
    for (const role of ["sa", "admin", "acct", "mgr"]) assert.equal((await w.http("GET", `/finance/reports/candidate/${cand}`, w.T[role])).status, 200, role);
    // Anonymous and invalid tokens.
    assert.equal((await w.http("GET", "/finance/reports/summary", null)).status, 401);
    assert.equal((await w.http("GET", "/finance/expenses", "garbage")).status, 400);
  }));

// ================================================================================================ review round 1
test("review 1: csvCell also guards a leading LF and the full-width lookalikes of = + - @", () => {
  const { csvCell } = require("../modules/finance/exportCsv");
  for (const lead of ["\n", "＝", "＋", "－", "＠", "=", "+", "-", "@", "\t", "\r"]) {
    const cell = csvCell(`${lead}cmd`);
    assert.equal(cell, `"'${`${lead}cmd`.replace(/"/g, '""')}"`, `leading ${JSON.stringify(lead)} is neutralised`);
  }
  for (const safe of ["Plain", "a\nb", "x=y", "1+1", "＝not first", "أمينة", "", null, 12]) {
    const cell = csvCell(safe === "＝not first" ? "ok ＝" : safe);
    assert.ok(!cell.startsWith(`"'`), `${JSON.stringify(safe)} is left alone`);
  }
});
