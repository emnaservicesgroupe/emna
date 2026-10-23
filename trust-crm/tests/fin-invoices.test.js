// Stage 4, Task 2: money parsing, service catalogue, numbered invoices with line items, void, print.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");
const { parseMoney, parseQuantity, formatMoney } = require("../modules/finance/money");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "fin-invoices-test-secret";
delete process.env.FIN_TAX_RATE_PERCENT;
delete process.env.FIN_COMPANY_NAME;
delete process.env.FIN_COMPANY_ADDRESS;
delete process.env.FIN_COMPANY_TAX_ID;
delete process.env.FIN_CURRENCIES;

// ------------------------------------------------------------------------------------------------ money.js (pure)
test("parseMoney normalises plain decimals to 2dp strings", () => {
  const ok = [["10", "10.00"], ["10.5", "10.50"], ["0.1", "0.10"], ["007.50", "7.50"], [" 12.34 ", "12.34"], [0.1, "0.10"], [12.5, "12.50"], [0, "0.00"], ["0", "0.00"], ["999999999999.99", "999999999999.99"], [1234567, "1234567.00"]];
  for (const [i, o] of ok) assert.equal(parseMoney(i), o, String(i));
});

test("parseMoney rejects NaN, exponent, comma, negative, 3+ decimals, huge numbers, non-numbers", () => {
  const bad = [NaN, Infinity, -Infinity, "NaN", "Infinity", "1e3", "1E3", "1e+21", 1e21, 1e-7, 0.001, 1.005, "0.001", "1.234", "-1", -1, "-0", "+1", "1,5", "1 000", "1.", ".5", "", " ", "abc", "0x10", "12.50.1", "1_000", "9999999999999", "9999999999999.00", 1e13, null, undefined, {}, [], true, "٣"];
  for (const i of bad) assert.throws(() => parseMoney(i), (e) => e.status === 400, `rejects ${String(i)}`);
  assert.throws(() => parseMoney("0", { positive: true }), /greater than zero/);
  assert.throws(() => parseMoney("12345678901", { maxIntDigits: 10 }), /too large/);
  assert.equal(parseMoney("1234567890.12", { maxIntDigits: 10 }), "1234567890.12");
});

test("parseQuantity: > 0, at most 2 decimals", () => {
  assert.equal(parseQuantity(3), "3.00");
  assert.equal(parseQuantity("3.33"), "3.33");
  assert.equal(parseQuantity(0.01), "0.01");
  for (const bad of [0, "0", "0.00", -1, "3.333", "1e2", NaN, "1,5", "123456789", ""]) assert.throws(() => parseQuantity(bad), (e) => e.status === 400, String(bad));
});

test("formatMoney groups digits without floats", () => {
  assert.equal(formatMoney("1234567.5"), "1,234,567.50");
  assert.equal(formatMoney("0.1", "TND"), "0.10 TND");
  assert.equal(formatMoney("999999999999.99"), "999,999,999,999.99");
  assert.equal(formatMoney("12", "EUR", { sep: " " }), "12.00 EUR");
  assert.equal(formatMoney("abc"), "abc");
});

// ------------------------------------------------------------------------------------------------ world
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
    ids[k] = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`${role} ${k}`, `${k}@fin.test.invalid`, role])).id;
    T[k] = jwt.sign({ id: ids[k], role, ...(k === "cand" ? { tv: 0 } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" });
  }
  T.emp = (await createEmployerUser(pool)).token;
  T.agy = (await createAgencyUser(pool)).token;
  let n = 0;
  const candidate = async (name = "Amine Trabelsi") => {
    n += 1;
    return (await one("INSERT INTO candidates (full_name, passport_number) VALUES ($1,$2) RETURNING id", [name, `FIN${process.pid}-${n}`])).id;
  };
  const service = async (over = {}) => {
    n += 1;
    const r = await http("POST", "/finance/services", T.acct, { code: `SVC${n}`, name_en: `Service ${n}`, default_price: "100.00", currency: "TND", ...over });
    assert.equal(r.status, 201, r.text);
    return r.body;
  };
  const user = (k) => ({ id: ids[k], role: roles[k] });
  try {
    await fn({ pool, http, q, one, T, ids, candidate, service, user, base });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}
const inv = (candidate_id, items, over = {}) => ({ candidate_id, currency: "TND", items, ...over });

// ------------------------------------------------------------------------------------------------ catalogue
test("catalogue: create / list / patch / deactivate, validation and uniqueness", () =>
  withWorld(async ({ http, T, q }) => {
    const mk = (b, t = T.acct) => http("POST", "/finance/services", t, b);
    const a = await mk({ code: "VISA-D", name_ar: "تأشيرة", name_en: "Visa file", name_fr: "Dossier visa", default_price: 1500.5, currency: "TND" });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.body.default_price, "1500.50");
    assert.equal(a.body.active, true);
    assert.equal((await mk({ code: "VISA-D", name_en: "dup" })).status, 409);
    // validation
    for (const bad of [
      { code: "visa", name_en: "x" }, { code: "A", name_en: "x" }, { code: "A".repeat(31), name_en: "x" }, { code: "OK1", name_en: "x", default_price: "1e3" },
      { code: "OK2" }, { code: "OK3", name_en: "x".repeat(161) }, { code: "OK4", name_ar: "x".repeat(161) }, { code: "OK5", name_fr: " " }, { code: "OK6", name_en: "x", default_price: "-1" },
      { code: "OK7", name_en: "x", default_price: "1.234" }, { code: "OK8", name_en: "x", currency: "GBP" }, { code: "OK9", name_en: "x", extra: 1 }, { code: "OKA", name_en: "x", active: "yes" },
    ]) assert.equal((await mk(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await mk(null)).status, 400);
    assert.equal((await mk({ code: "MAXLEN", name_en: "x".repeat(160), name_ar: "ع".repeat(160) })).status, 201);
    // list + filter
    const list = await http("GET", "/finance/services", T.mgr);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.rows.map((r) => r.code).sort(), ["MAXLEN", "VISA-D"]);
    // patch
    const p = await http("PATCH", `/finance/services/${a.body.id}`, T.acct, { default_price: "1600", name_en: "Visa file v2" });
    assert.equal(p.status, 200);
    assert.equal(p.body.default_price, "1600.00");
    assert.equal(p.body.code, "VISA-D");
    assert.equal((await http("PATCH", `/finance/services/${a.body.id}`, T.acct, { code: "NEW-CODE" })).status, 400);
    assert.equal((await http("PATCH", `/finance/services/${a.body.id}`, T.acct, {})).status, 400);
    assert.equal((await http("PATCH", `/finance/services/${a.body.id}`, T.acct, { name_ar: null, name_en: null, name_fr: null })).status, 400);
    assert.equal((await http("PATCH", "/finance/services/999999", T.acct, { active: false })).status, 404);
    assert.equal((await http("PATCH", "/finance/services/abc", T.acct, { active: false })).status, 400);
    const off = await http("PATCH", `/finance/services/${a.body.id}`, T.acct, { active: false });
    assert.equal(off.body.active, false);
    assert.equal((await http("GET", "/finance/services?active=true", T.acct)).body.rows.length, 1);
    assert.equal((await http("GET", "/finance/services?active=false", T.acct)).body.rows.length, 1);
    assert.equal((await http("GET", "/finance/services?active=maybe", T.acct)).status, 400);
    assert.equal((await http("GET", "/finance/services?q=%25", T.acct)).body.rows.length, 0, "q wildcards are escaped");
    assert.equal((await http("DELETE", `/finance/services/${a.body.id}`, T.acct)).status, 404, "no delete route");
    assert.equal(Number((await q("SELECT count(*) AS n FROM audit_logs WHERE table_name='fin_services'")).rows[0].n), 4, "create x2 + patch x2 audited");
  }));

// ------------------------------------------------------------------------------------------------ invoice maths
test("invoice maths is exact: 0.1+0.2, qty 3.33*3, rounding half-up, big numbers", () =>
  withWorld(async ({ http, T, candidate, q }) => {
    const c = await candidate();
    const r1 = await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "a", quantity: 1, unit_price: "0.1" }, { description: "b", quantity: 1, unit_price: 0.2 }]));
    assert.equal(r1.status, 201, r1.text);
    assert.deepEqual([r1.body.subtotal, r1.body.tax_amount, r1.body.total_amount, r1.body.remaining_amount], ["0.30", "0.00", "0.30", "0.30"]);
    assert.deepEqual(r1.body.items.map((i) => i.line_total), ["0.10", "0.20"]);
    const r2 = await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "frac", quantity: "3.33", unit_price: "3" }]));
    assert.equal(r2.body.items[0].line_total, "9.99");
    const r3 = await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "half", quantity: "0.50", unit_price: "0.01" }, { description: "half2", quantity: "1.50", unit_price: "0.01" }, { description: "x", quantity: "33.33", unit_price: "0.15" }]));
    assert.deepEqual(r3.body.items.map((i) => i.line_total), ["0.01", "0.02", "5.00"], "0.005->0.01, 0.015->0.02, 4.9995->5.00");
    assert.equal(r3.body.total_amount, "5.03");
    const r4 = await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "big", quantity: "99999999", unit_price: "99.99" }]));
    assert.equal(r4.status, 201, r4.text);
    assert.equal(r4.body.total_amount, "9998999900.01");
    const many = await http("POST", "/finance/invoices/v2", T.acct, inv(c, Array.from({ length: 50 }, (_, i) => ({ description: `l${i}`, quantity: 1, unit_price: "0.1" }))));
    assert.equal(many.body.total_amount, "5.00", "50 x 0.1 has no float drift");
    // does not fit numeric(12,2): a clean 400, not a database error
    for (const items of [[{ description: "x", quantity: "99999999", unit_price: "9999999999.99" }], [{ description: "x", quantity: 2, unit_price: "9999999999.99" }]]) {
      assert.equal((await http("POST", "/finance/invoices/v2", T.acct, inv(c, items))).status, 400);
    }
    assert.equal((await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "free", quantity: 1, unit_price: "0" }]))).status, 400, "zero total refused");
    assert.equal(Number((await q("SELECT count(*) AS n FROM invoices")).rows[0].n), 5, "failed creates left nothing behind");
    // stored values match the response (exact decimals in the DB)
    const row = (await q("SELECT total_amount::text t, subtotal::text s FROM invoices WHERE id=$1", [r3.body.id])).rows[0];
    assert.deepEqual([row.t, row.s], ["5.03", "5.03"]);
  }));

test("invalid money / quantity inputs are rejected with 400 and create nothing", () =>
  withWorld(async ({ http, T, candidate, q }) => {
    const c = await candidate();
    const badPrices = ["NaN", "1e3", "-1", "1,5", 0.001, 1e21, "1234567890123", "12345678901.00", "", null, true, {}, "Infinity", 1e-7, "1.005"];
    for (const unit_price of badPrices) {
      const items = [{ description: "x", quantity: 1, unit_price }];
      const r = await http("POST", "/finance/invoices/v2", T.acct, inv(c, items));
      // null means "not given" -> no service -> required: still 400
      assert.equal(r.status, 400, `unit_price ${JSON.stringify(unit_price)} -> ${r.status}`);
    }
    for (const quantity of [0, "0", -1, "NaN", "1e2", "1.234", "1,5", 1e21, "999999999", undefined, null, "abc"]) {
      const r = await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "x", quantity, unit_price: "1" }]));
      assert.equal(r.status, 400, `quantity ${JSON.stringify(quantity)} -> ${r.status}`);
    }
    // raw JSON with exponent number literals and a malformed body
    const raw = (s) => http("POST", "/finance/invoices/v2", T.acct, undefined, s);
    assert.equal((await raw(`{"candidate_id":${c},"currency":"TND","items":[{"description":"x","quantity":1,"unit_price":1e21}]}`)).status, 400);
    assert.equal((await raw(`{"candidate_id":${c},"currency":"TND","items":[{"description":"x","quantity":1,"unit_price":1e2}]}`)).status, 201, "1e2 JSON number is 100, whose string form is plain");
    assert.equal((await raw("{not json")).status, 400);
    assert.equal((await raw(JSON.stringify({ pad: "x".repeat(40000) }))).status, 413, "own 32kb parser");
    assert.equal(Number((await q("SELECT count(*) AS n FROM invoices")).rows[0].n), 1);
    // other input validation
    const bad = [
      { candidate_id: "abc" }, { candidate_id: 0 }, { candidate_id: null }, { currency: "GBP" }, { currency: "tnd" }, { currency: undefined }, { due_date: "2026-02-30" }, { due_date: "tomorrow" }, { due_date: 20260101 },
      { notes: "x".repeat(2001) }, { notes: 5 }, { items: [] }, { items: "x" }, { items: [null] }, { items: [5] }, { items: [{ quantity: 1, unit_price: 1 }] }, { items: [{ description: "x".repeat(301), quantity: 1, unit_price: 1 }] },
      { items: [{ description: "x", quantity: 1, unit_price: 1, extra: 1 }] }, { items: [{ service_id: 999999, quantity: 1, unit_price: 1 }] }, { items: [{ service_id: "abc", quantity: 1, unit_price: 1 }] }, { extra: 1 },
    ];
    for (const o of bad) {
      const body = { ...inv(c, [{ description: "x", quantity: 1, unit_price: 1 }]), ...o };
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      const r = await http("POST", "/finance/invoices/v2", T.acct, body);
      assert.equal(r.status, 400, `${JSON.stringify(o)} -> ${r.status} ${r.text}`);
    }
    assert.equal((await http("POST", "/finance/invoices/v2", T.acct, inv(999999, [{ description: "x", quantity: 1, unit_price: 1 }]))).status, 404);
    const gone = await candidate("Gone");
    await q("UPDATE candidates SET is_deleted=true WHERE id=$1", [gone]);
    assert.equal((await http("POST", "/finance/invoices/v2", T.acct, inv(gone, [{ description: "x", quantity: 1, unit_price: 1 }]))).status, 404, "soft-deleted candidate");
    // caps: description 300 and 50 items accepted, 51 refused
    assert.equal((await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "x".repeat(300), quantity: 1, unit_price: 1 }]))).status, 201);
    assert.equal((await http("POST", "/finance/invoices/v2", T.acct, inv(c, Array.from({ length: 51 }, () => ({ description: "x", quantity: 1, unit_price: 1 }))))).status, 400);
  }));

test("tax: none unless FIN_TAX_RATE_PERCENT is set and > 0", () =>
  withWorld(async ({ http, T, candidate }) => {
    const c = await candidate();
    const mk = () => http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "x", quantity: 3, unit_price: "33.33" }]));
    try {
      assert.deepEqual([(await mk()).body.tax_amount, (await mk()).body.total_amount], ["0.00", "99.99"]);
      for (const v of ["0", "abc", "-5", "101", "7%", "1e1", ""]) {
        process.env.FIN_TAX_RATE_PERCENT = v;
        assert.equal((await mk()).body.tax_amount, "0.00", `FIN_TAX_RATE_PERCENT=${v} is ignored`);
      }
      process.env.FIN_TAX_RATE_PERCENT = "19";
      const t = (await mk()).body;
      assert.deepEqual([t.subtotal, t.tax_amount, t.total_amount, t.remaining_amount], ["99.99", "19.00", "118.99", "118.99"], "99.99*0.19 = 18.9981 -> 19.00");
      process.env.FIN_TAX_RATE_PERCENT = "7.5";
      const t2 = (await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "x", quantity: 1, unit_price: "0.10" }]))).body;
      assert.deepEqual([t2.tax_amount, t2.total_amount], ["0.01", "0.11"], "0.0075 -> 0.01 half-up");
    } finally {
      delete process.env.FIN_TAX_RATE_PERCENT;
    }
  }));

test("catalogue prices: default used, override wins, currency mismatch needs explicit price, inactive refused", () =>
  withWorld(async ({ http, T, candidate, service }) => {
    const c = await candidate();
    const s = await service({ default_price: "250.50", currency: "TND", name_en: "Medical", name_fr: "Médical" });
    const post = (items, over) => http("POST", "/finance/invoices/v2", T.acct, inv(c, items, over));
    const a = await post([{ service_id: s.id, quantity: 2 }]);
    assert.equal(a.status, 201, a.text);
    assert.deepEqual([a.body.items[0].unit_price, a.body.items[0].line_total, a.body.items[0].description, a.body.items[0].service_id], ["250.50", "501.00", "Medical", String(s.id)]);
    const b = await post([{ service_id: s.id, quantity: 1, unit_price: "200", description: "Custom text" }]);
    assert.deepEqual([b.body.items[0].unit_price, b.body.items[0].description], ["200.00", "Custom text"]);
    assert.equal((await post([{ service_id: s.id, quantity: 1 }], { currency: "EUR" })).status, 400, "TND service in an EUR invoice needs an explicit price");
    const e = await post([{ service_id: s.id, quantity: 1, unit_price: "80" }], { currency: "EUR" });
    assert.equal(e.status, 201);
    assert.equal(e.body.currency, "EUR");
    // price change later does not touch issued invoices
    await http("PATCH", `/finance/services/${s.id}`, T.acct, { default_price: "999" });
    assert.equal((await http("GET", `/finance/invoices/${a.body.id}`, T.acct)).body.items[0].unit_price, "250.50");
    await http("PATCH", `/finance/services/${s.id}`, T.acct, { active: false });
    assert.equal((await post([{ service_id: s.id, quantity: 1 }])).status, 409);
    process.env.FIN_CURRENCIES = "TND,EUR";
    try {
      assert.equal((await post([{ description: "x", quantity: 1, unit_price: 1 }], { currency: "USD" })).status, 400, "currency list comes from FIN_CURRENCIES");
    } finally {
      delete process.env.FIN_CURRENCIES;
    }
  }));

// ------------------------------------------------------------------------------------------------ numbering
test("numbering: VITA-YYYY-NNNNNN, unique and gap-free under 20 parallel creates, per-year counters", () =>
  withWorld(async ({ http, T, candidate, q, user }) => {
    const c = await candidate();
    const year = (await q("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY') y")).rows[0].y;
    const first = await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "x", quantity: 1, unit_price: 1 }]));
    assert.equal(first.body.number, `VITA-${year}-000001`);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: `p${i}`, quantity: 1, unit_price: 1 + i }]))));
    assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join());
    const numbers = results.map((r) => r.body.number);
    assert.equal(new Set(numbers).size, 20);
    for (const n of numbers) assert.match(n, new RegExp(`^VITA-${year}-\\d{6}$`));
    assert.deepEqual(numbers.map((n) => Number(n.slice(-6))).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 2), "consecutive 2..21");
    assert.equal(Number((await q("SELECT value FROM fin_counters WHERE key=$1", [`invoice-${year}`])).rows[0].value), 21);

    // Year boundary, in parallel: each year has its own counter and no duplicates.
    const { createInvoice } = require("../modules/finance/invoices");
    const mk = (now) => createInvoice(user("acct"), inv(c, [{ description: "b", quantity: 1, unit_price: 1 }]), { now });
    const batch = await Promise.all([
      ...Array.from({ length: 6 }, () => mk("2031-12-31T23:59:59Z")),
      ...Array.from({ length: 6 }, () => mk("2032-01-01T00:00:01Z")),
    ]);
    const nums = batch.map((b) => b.number).sort();
    assert.deepEqual(nums, [...Array.from({ length: 6 }, (_, i) => `VITA-2031-00000${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `VITA-2032-00000${i + 1}`)]);
    assert.ok(batch.every((b) => /^20(31|32)/.test(String(b.issued_at.toISOString ? b.issued_at.toISOString() : b.issued_at))), "issued_at follows the clock");
    // numbers past 999999 keep growing (no truncation)
    await q("UPDATE fin_counters SET value = 999999 WHERE key = 'invoice-2031'");
    assert.equal((await mk("2031-06-01T00:00:00Z")).number, "VITA-2031-1000000");
    // a failed create does not burn a number
    const before = Number((await q("SELECT value FROM fin_counters WHERE key=$1", [`invoice-${year}`])).rows[0].value);
    await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "x", quantity: 1, unit_price: "NaN" }]));
    assert.equal(Number((await q("SELECT value FROM fin_counters WHERE key=$1", [`invoice-${year}`])).rows[0].value), before);
  }));

// ------------------------------------------------------------------------------------------------ ledger, audit, void
test("ledger + audit rows are written with the invoice; ledger is insert-only", () =>
  withWorld(async ({ http, T, ids, candidate, q }) => {
    const c = await candidate();
    const r = await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "x", quantity: 2, unit_price: "10.25" }], { currency: "EUR" }));
    const led = (await q("SELECT kind, ref_table, ref_id::int, candidate_id::int, currency, debit::text d, credit::text c, actor_id::int FROM fin_ledger")).rows;
    assert.deepEqual(led, [{ kind: "invoice", ref_table: "invoices", ref_id: r.body.id, candidate_id: c, currency: "EUR", d: "20.50", c: "0.00", actor_id: ids.acct }]);
    const au = (await q("SELECT user_id, action, new_data FROM audit_logs WHERE table_name='invoices' AND record_id=$1", [String(r.body.id)])).rows;
    assert.equal(au.length, 1);
    assert.equal(au[0].action, "CREATE");
    assert.equal(au[0].user_id, ids.acct);
    assert.equal(au[0].new_data.number, r.body.number);
    await assert.rejects(q("UPDATE fin_ledger SET debit = 1"), /insert-only/);
    await assert.rejects(q("DELETE FROM fin_ledger"), /insert-only/);
    // rollback: a failing create writes no ledger / audit / items
    await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "x", quantity: 99999999, unit_price: "9999999999.99" }]));
    assert.equal(Number((await q("SELECT count(*) n FROM fin_ledger")).rows[0].n), 1);
    assert.equal(Number((await q("SELECT count(*) n FROM audit_logs WHERE table_name='invoices'")).rows[0].n), 1);
  }));

test("void: only without live payments; ledger reversal, audit, second void is 409, validation", () =>
  withWorld(async ({ http, T, ids, candidate, q }) => {
    const c = await candidate();
    const mk = async () => (await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "x", quantity: 1, unit_price: "100" }]))).body;
    const a = await mk();
    for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: 5 }, { reason: "x".repeat(501) }, { reason: "ok", extra: 1 }]) {
      assert.equal((await http("POST", `/finance/invoices/${a.id}/void`, T.acct, body)).status, 400, JSON.stringify(body).slice(0, 40));
    }
    assert.equal((await http("POST", "/finance/invoices/999999/void", T.acct, { reason: "x" })).status, 404);
    assert.equal((await http("POST", "/finance/invoices/abc/void", T.acct, { reason: "x" })).status, 400);
    const v = await http("POST", `/finance/invoices/${a.id}/void`, T.acct, { reason: "Issued by mistake" });
    assert.equal(v.status, 200, v.text);
    assert.deepEqual([v.body.status, v.body.void_reason, v.body.remaining_amount, v.body.total_amount], ["Void", "Issued by mistake", "0.00", "100.00"]);
    assert.ok(v.body.voided_at);
    const led = (await q("SELECT kind, debit::text d, credit::text c, currency, actor_id::int a FROM fin_ledger WHERE ref_id=$1 ORDER BY id", [a.id])).rows;
    assert.deepEqual(led, [{ kind: "invoice", d: "100.00", c: "0.00", currency: "TND", a: ids.acct }, { kind: "void", d: "0.00", c: "100.00", currency: "TND", a: ids.acct }]);
    assert.equal(Number((await q("SELECT count(*) n FROM audit_logs WHERE table_name='invoices' AND action='VOID' AND record_id=$1", [String(a.id)])).rows[0].n), 1);
    const again = await http("POST", `/finance/invoices/${a.id}/void`, T.acct, { reason: "again" });
    assert.equal(again.status, 409);
    assert.equal(Number((await q("SELECT count(*) n FROM fin_ledger WHERE ref_id=$1", [a.id])).rows[0].n), 2, "no extra ledger row");
    assert.equal((await q("SELECT void_reason FROM invoices WHERE id=$1", [a.id])).rows[0].void_reason, "Issued by mistake");

    // with a live payment: 409 and nothing changes
    const b = await mk();
    const pay = await q("INSERT INTO payments (invoice_id,candidate_id,amount_paid,payment_method) VALUES ($1,$2,40,'cash') RETURNING id", [b.id, c]);
    const blocked = await http("POST", `/finance/invoices/${b.id}/void`, T.acct, { reason: "oops" });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /void or refund the payments first/);
    assert.equal((await q("SELECT status FROM invoices WHERE id=$1", [b.id])).rows[0].status, "Pending");
    assert.equal(Number((await q("SELECT count(*) n FROM fin_ledger WHERE ref_id=$1", [b.id])).rows[0].n), 1);
    // once the payment is voided the invoice can be voided
    await q("UPDATE payments SET voided_at=now(), void_reason='bounced' WHERE id=$1", [pay.rows[0].id]);
    assert.equal((await http("POST", `/finance/invoices/${b.id}/void`, T.acct, { reason: "now fine" })).status, 200);
    // concurrent voids: exactly one wins
    const d = await mk();
    const rs = await Promise.all([1, 2, 3, 4].map(() => http("POST", `/finance/invoices/${d.id}/void`, T.acct, { reason: "race" })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409, 409]);
    assert.equal(Number((await q("SELECT count(*) n FROM fin_ledger WHERE ref_id=$1 AND kind='void'", [d.id])).rows[0].n), 1);
    // a legacy invoice (no number/items) can be voided and read
    const legacy = (await q("INSERT INTO invoices (candidate_id,total_amount,remaining_amount) VALUES ($1,60,60) RETURNING id", [c])).rows[0].id;
    const g = await http("GET", `/finance/invoices/${legacy}`, T.acct);
    assert.equal(g.status, 200);
    assert.deepEqual([g.body.number, g.body.items.length], [null, 0]);
    assert.equal((await http("POST", `/finance/invoices/${legacy}/void`, T.acct, { reason: "legacy" })).status, 200);
  }));

// ------------------------------------------------------------------------------------------------ roles
test("role matrix: Accountant/Admin/SuperAdmin write, Manager reads, everyone else denied, anonymous 401", () =>
  withWorld(async ({ http, T, candidate, service }) => {
    const c = await candidate();
    const body = inv(c, [{ description: "x", quantity: 1, unit_price: "10" }]);
    const first = (await http("POST", "/finance/invoices/v2", T.acct, body)).body;
    const calls = (token) => ({
      listServices: http("GET", "/finance/services", token),
      createService: http("POST", "/finance/services", token, { code: `R${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name_en: "x" }),
      createInvoice: http("POST", "/finance/invoices/v2", token, body),
      list: http("GET", "/finance/invoices", token),
      get: http("GET", `/finance/invoices/${first.id}`, token),
      print: http("GET", `/finance/invoices/${first.id}/print`, token),
      void: http("POST", `/finance/invoices/${(first.id)}/void`, token, { reason: "x" }),
    });
    const expect = { write: { listServices: 200, createService: 201, createInvoice: 201, list: 200, get: 200, print: 200 }, read: { listServices: 200, createService: 403, createInvoice: 403, list: 200, get: 200, print: 200, void: 403 }, none: { listServices: 403, createService: 403, createInvoice: 403, list: 403, get: 403, print: 403, void: 403 } };
    // Manager first (read-only) and the denied roles: nothing may change.
    for (const [k, level] of [["mgr", "read"], ["agent", "none"], ["rec", "none"], ["hr", "none"], ["cand", "none"], ["emp", "none"], ["agy", "none"]]) {
      const res = await Promise.all(Object.entries(calls(T[k])).map(async ([n, p]) => [n, (await p).status]));
      for (const [n, s] of res) assert.equal(s, expect[level][n], `${k} ${n}`);
    }
    const anon = await Promise.all(Object.values(calls(null)));
    assert.ok(anon.every((r) => r.status === 401), anon.map((r) => r.status).join());
    const bad = await http("GET", "/finance/invoices", "garbage");
    assert.equal(bad.status, 400);
    // writers: the void is last because it consumes the invoice
    for (const k of ["acct", "admin", "sa"]) {
      const target = (await http("POST", "/finance/invoices/v2", T[k], body)).body;
      const c2 = calls(T[k]);
      c2.void = http("POST", `/finance/invoices/${target.id}/void`, T[k], { reason: "x" });
      const res = await Promise.all(Object.entries(c2).map(async ([n, p]) => [n, (await p).status]));
      for (const [n, s] of res) assert.equal(s, n === "void" ? 200 : expect.write[n], `${k} ${n}`);
    }
    assert.equal((await http("PATCH", "/finance/services/1", T.mgr, { active: false })).status, 403);
    const s = await service();
    assert.equal((await http("PATCH", `/finance/services/${s.id}`, T.agent, { active: false })).status, 403);
  }));

test("denied tokens change nothing (no invoices, ledger or audit rows)", () =>
  withWorld(async ({ http, T, candidate, q }) => {
    const c = await candidate();
    for (const k of ["mgr", "agent", "rec", "hr", "cand", "emp", "agy"]) await http("POST", "/finance/invoices/v2", T[k], inv(c, [{ description: "x", quantity: 1, unit_price: 5 }]));
    for (const t of ["invoices", "invoice_items", "fin_ledger", "fin_counters", "fin_services"]) assert.equal(Number((await q(`SELECT count(*) n FROM ${t}`)).rows[0].n), 0, t);
  }));

// ------------------------------------------------------------------------------------------------ list
test("list: filters, paging, q escaping, overdue with an injectable clock", () =>
  withWorld(async ({ http, T, candidate, q, user }) => {
    const { listInvoices } = require("../modules/finance/invoices");
    const alice = await candidate("Alice 100%_Real");
    const bob = await candidate("Bob Stone");
    const mk = async (cid, over = {}, price = 10) => (await http("POST", "/finance/invoices/v2", T.acct, inv(cid, [{ description: "x", quantity: 1, unit_price: price }], over))).body;
    const i1 = await mk(alice, { due_date: "2030-01-10" }, 10);
    const i2 = await mk(alice, { currency: "EUR", due_date: "2030-03-01" }, 20);
    const i3 = await mk(bob, { due_date: "2030-01-20" }, 30);
    const i4 = await mk(bob, {}, 40); // no due date
    await q("UPDATE invoices SET status='Paid', remaining_amount=0 WHERE id=$1", [i3.id]);
    const ids = (r) => r.body.rows.map((x) => x.id);
    const get = (qs, t = T.mgr) => http("GET", `/finance/invoices${qs}`, t);
    let r = await get("");
    assert.deepEqual([ids(r), r.body.total], [[i4.id, i3.id, i2.id, i1.id], 4]);
    assert.equal(r.body.rows[0].candidate_name, "Bob Stone");
    assert.equal(typeof r.body.rows[0].total_amount, "string");
    assert.deepEqual(ids(await get(`?candidate_id=${alice}`)), [i2.id, i1.id]);
    assert.deepEqual(ids(await get("?currency=EUR")), [i2.id]);
    assert.deepEqual(ids(await get("?status=Paid")), [i3.id]);
    assert.deepEqual(ids(await get(`?q=${i1.number}`)), [i1.id]);
    assert.deepEqual(ids(await get("?q=stone")), [i4.id, i3.id], "candidate name, case-insensitive");
    assert.deepEqual(ids(await get("?q=%25")), [i2.id, i1.id], "a literal % only matches names containing it");
    assert.deepEqual(ids(await get("?q=_")), [i2.id, i1.id], "a literal _ only matches names containing it");
    assert.deepEqual(ids(await get("?q=100%25_R")), [i2.id, i1.id]);
    assert.deepEqual(ids(await get("?q=Al%25Re")), [], "wildcards inside q are not interpreted");
    assert.deepEqual(ids(await get("?q=%5C")), []);
    const today = (await q("SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') d")).rows[0].d;
    assert.deepEqual(ids(await get(`?from=${today}&to=${today}`)).length, 4);
    assert.deepEqual(ids(await get("?to=2000-01-01")), []);
    assert.deepEqual(ids(await get("?from=2999-01-01")), []);
    r = await get("?limit=2&offset=1");
    assert.deepEqual([ids(r), r.body.total], [[i3.id, i2.id], 4]);
    assert.equal((await get("?limit=1000")).body.rows.length, 4, "limit is capped, not an error");
    for (const bad of ["?status=Nope", "?currency=eur", "?from=x", "?to=2026-13-01", "?candidate_id=abc", "?limit=-1", "?limit=x", "?offset=-1", "?overdue=maybe", "?status=Paid&status=Void", "?q[]=a"]) {
      assert.equal((await get(bad)).status, 400, bad);
    }
    // overdue: due_date < today AND remaining > 0 AND status not Void/Paid. The clock is injected through the service.
    const od = async (today2, overdue) => (await listInvoices(user("mgr"), { overdue }, { today: today2 })).rows.map((x) => x.id).sort((a, b) => a - b);
    assert.deepEqual(await od("2029-12-31", "true"), []);
    assert.deepEqual(await od("2030-01-11", "true"), [i1.id]);
    assert.deepEqual(await od("2030-01-10", "true"), [], "due today is not overdue");
    assert.deepEqual(await od("2030-06-01", "true"), [i1.id, i2.id], "paid i3 and no-due-date i4 never overdue");
    assert.deepEqual(await od("2030-06-01", "false"), [i3.id, i4.id]);
    await q("UPDATE invoices SET status='Partial', remaining_amount=1 WHERE id=$1", [i2.id]);
    assert.deepEqual(await od("2030-06-01", "true"), [i1.id, i2.id]);
    await http("POST", `/finance/invoices/${i1.id}/void`, T.acct, { reason: "x" });
    assert.deepEqual(await od("2030-06-01", "true"), [i2.id], "void is never overdue");
    const rows = (await listInvoices(user("mgr"), {}, { today: "2030-06-01" })).rows;
    assert.deepEqual(rows.map((x) => [x.id, x.overdue]).sort((a, b) => a[0] - b[0]), [[i1.id, false], [i2.id, true], [i3.id, false], [i4.id, false]]);
    // soft-deleted invoices are hidden
    await q("UPDATE invoices SET is_deleted=true WHERE id=$1", [i4.id]);
    assert.equal((await get("")).body.total, 3);
    assert.equal((await http("GET", `/finance/invoices/${i4.id}`, T.mgr)).status, 404);
  }));

test("get: invoice with items, payments, refunds and exact balance strings", () =>
  withWorld(async ({ http, T, candidate, q }) => {
    const c = await candidate();
    const a = (await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "x", quantity: 1, unit_price: "100.10" }]))).body;
    const p1 = (await q("INSERT INTO payments (invoice_id,candidate_id,amount_paid,payment_method) VALUES ($1,$2,'30.05','cash') RETURNING id", [a.id, c])).rows[0].id;
    await q("INSERT INTO payments (invoice_id,candidate_id,amount_paid,payment_method,voided_at,void_reason) VALUES ($1,$2,'50','cash',now(),'bad')", [a.id, c]);
    await q("INSERT INTO fin_refunds (payment_id,invoice_id,amount,reason) VALUES ($1,$2,'0.05','rounding')", [p1, a.id]);
    await q("UPDATE invoices SET remaining_amount='70.10', status='Partial' WHERE id=$1", [a.id]);
    const r = await http("GET", `/finance/invoices/${a.id}`, T.mgr);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.balance, { total: "100.10", paid: "30.05", refunded: "0.05", net_paid: "30.00", remaining: "70.10" });
    assert.equal(r.body.payments.length, 2);
    assert.equal(r.body.refunds.length, 1);
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.due_date, null);
    assert.equal((await http("GET", "/finance/invoices/0", T.mgr)).status, 400);
    assert.equal((await http("GET", "/finance/invoices/v2", T.mgr)).status, 400);
    assert.equal((await http("GET", "/finance/invoices/99999999", T.mgr)).status, 404);
  }));

// ------------------------------------------------------------------------------------------------ print
test("print: escaped HTML, strict CSP, languages, company header only when set, Void watermark", () =>
  withWorld(async ({ http, T, candidate, q }) => {
    const evil = `<script>alert(1)</script> "quoted" 'single' & <img src=x onerror=alert(2)>`;
    const c = await candidate(evil);
    const a = (await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: evil, quantity: "2", unit_price: "1234.5" }], { notes: `<b>${evil}</b>`, due_date: "2030-05-06" }))).body;
    const get = (lang = "", t = T.mgr) => http("GET", `/finance/invoices/${a.id}/print${lang}`, t);
    const r = await get();
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /^text\/html; charset=utf-8/);
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /style-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|script-src/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("cache-control"), "no-store");
    const html = r.text;
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<img/i);
    assert.doesNotMatch(html, /\sstyle=/i, "no inline style attributes");
    assert.doesNotMatch(html, /<[^>]*\son\w+=/i, "no event handler attributes");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes("&quot;quoted&quot;") && html.includes("&#39;single&#39;") && html.includes("&amp;"));
    assert.ok(html.includes('<link rel="stylesheet" href="/vita/fin-print.css">'));
    assert.ok(html.includes(a.number) && html.includes("2,469.00 TND") && html.includes("1,234.50 TND") && html.includes("2030-05-06"));
    assert.ok(html.includes('lang="en"') && html.includes('dir="ltr"') && html.includes("Pending"));
    assert.ok(!html.includes("Tax") && !html.includes("Tax ID"), "no tax row and no company header when unset");
    assert.doesNotMatch(html, /VOID/);
    // languages
    const ar = await get("?lang=ar");
    assert.ok(ar.text.includes('dir="rtl"') && ar.text.includes("فاتورة") && ar.text.includes("قيد الانتظار"));
    const fr = await get("?lang=fr");
    assert.ok(fr.text.includes("Facture") && fr.text.includes("En attente"));
    for (const bad of ["?lang=de", "?lang=", "?lang=AR", "?lang=en&lang=fr", "?lang[]=en"]) assert.equal((await get(bad)).status, 400, bad);
    // company header from env, escaped; tax row only with tax
    process.env.FIN_COMPANY_NAME = `ACME <Visa> "Services"`;
    process.env.FIN_COMPANY_ADDRESS = "1 Rue <b>X</b>, Tunis";
    process.env.FIN_COMPANY_TAX_ID = "1234567/A/M/000";
    process.env.FIN_TAX_RATE_PERCENT = "19";
    try {
      const t = (await http("POST", "/finance/invoices/v2", T.acct, inv(c, [{ description: "taxed", quantity: 1, unit_price: "100" }]))).body;
      const h = (await http("GET", `/finance/invoices/${t.id}/print`, T.mgr)).text;
      assert.ok(h.includes("ACME &lt;Visa&gt; &quot;Services&quot;") && h.includes("1 Rue &lt;b&gt;X&lt;/b&gt;, Tunis") && h.includes("1234567/A/M/000"));
      assert.ok(h.includes("Tax") && h.includes("19.00 TND") && h.includes("119.00 TND"));
      assert.doesNotMatch(h, /<b>X/);
    } finally {
      for (const k of ["FIN_COMPANY_NAME", "FIN_COMPANY_ADDRESS", "FIN_COMPANY_TAX_ID", "FIN_TAX_RATE_PERCENT"]) delete process.env[k];
    }
    // Void: watermark text and reason (escaped)
    await http("POST", `/finance/invoices/${a.id}/void`, T.acct, { reason: `<i>wrong</i> ${evil}` });
    const v = (await get()).text;
    assert.ok(v.includes('class="watermark"') && v.includes("VOID") && v.includes("&lt;i&gt;wrong&lt;/i&gt;"));
    assert.doesNotMatch(v, /<script|<i>/);
    assert.ok((await get("?lang=ar")).text.includes("ملغاة"));
    assert.ok((await get("?lang=fr")).text.includes("ANNULÉE"));
    // access and ids
    assert.equal((await get("", T.agent)).status, 403);
    assert.equal((await get("", null)).status, 401);
    assert.equal((await get("", T.cand)).status, 403);
    assert.equal((await http("GET", "/finance/invoices/99999/print", T.mgr)).status, 404);
    assert.equal((await http("GET", "/finance/invoices/abc/print", T.mgr)).status, 400);
    // the stylesheet really exists and is served by the strict /vita mount
    const css = await fetch(`${(await http("GET", "/", null)).headers ? "" : ""}`).catch(() => null);
    void css;
  }));

test("print stylesheet exists, has no external references and is served by the /vita static mount", () =>
  withWorld(async ({ base }) => {
    const res = await fetch(`${base}/vita/fin-print.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /css/);
    const css = await res.text();
    assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/i);
  }));

// ------------------------------------------------------------------------------------------------ legacy
test("legacy finance endpoints keep working next to v2 (and only /finance/me style routes are absent for Candidates)", () =>
  withWorld(async ({ http, T, candidate, q }) => {
    const c = await candidate();
    const dash = await http("GET", "/finance/dashboard", T.acct);
    assert.equal(dash.status, 200);
    const li = await http("POST", "/finance/invoices", T.acct, { candidate_id: c, total_amount: 100, currency: "TND" });
    assert.equal(li.status, 201);
    assert.equal((await q("SELECT number FROM invoices WHERE id=$1", [li.body.id])).rows[0].number, li.body.number, "legacy POST /finance/invoices now assigns a number (Task 3); pre-existing rows stay unnumbered");
    assert.match(li.body.number, /^VITA-\d{4}-\d{6}$/);
    const lp = await http("POST", "/finance/payments", T.acct, { invoice_id: li.body.id, amount_paid: 40 });
    assert.equal(lp.status, 201);
    assert.equal(lp.body.invoice.remaining_amount, "60.00");
    const listed = await http("GET", "/finance/invoices", T.acct);
    assert.ok(listed.body.rows.some((r) => r.id === li.body.id && r.number === li.body.number), "legacy invoice shows in the v2 list");
    assert.equal((await http("GET", "/finance/dashboard", T.cand)).status, 403);
    assert.equal((await http("POST", "/finance/invoices", T.agent, { candidate_id: c, total_amount: 1 })).status, 403);
  }));
