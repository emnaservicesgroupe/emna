// Stage 4, Task 5: accounting console tab (public/vita/fin-*.js) and the candidate "My payments" view.
// Static checks (ar/en/fr parity, CSP safety, wiring), unit tests of the pure helpers in public/vita/fin-util.js
// (money handled as decimal STRINGS, no floats), the permission mirror against middleware/role.js, and a contract
// test that sends payloads built by the helpers to the real API. The rendered behaviour is covered by the browser
// smoke recorded in the task report.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "fin-ui-test-secret";
delete process.env.FIN_TAX_RATE_PERCENT;
delete process.env.FIN_CURRENCIES;

const VITA = path.join(__dirname, "..", "public", "vita");
const I18N = require("../public/vita/i18n.js");
const U = require("../public/vita/fin-util.js");
const { PERMISSIONS } = require("../middleware/role");
const invoicesSvc = require("../modules/finance/invoices");
const paymentsSvc = require("../modules/finance/payments");
const { formatMoney: serverFormatMoney } = require("../modules/finance/money");

const read = (f) => fs.readFileSync(path.join(VITA, f), "utf8");
const FIN_JS = ["fin-util.js", "fin-invoices.js", "fin-services.js", "fin-expenses.js", "fin-reports.js"];
const LANGS = ["ar", "en", "fr"];
const FIN_PERMS = ["finance:read", "finance:write", "finance:void", "finance:refund", "finance:export"];
const SINKS = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b|setTimeout\(\s*["'`]|setInterval\(\s*["'`]/;

// ---------------------------------------------------------------- wiring

test("admin.html: Accounting tab + panel, fin scripts load last and in order, no inline code, every data-i18n key resolves", () => {
  const html = read("admin.html");
  assert.match(html, /<button type="button" role="tab" id="tab-accounting" aria-controls="panel-accounting" data-tab="accounting" data-i18n="tab\.accounting">/);
  assert.match(html, /<section id="panel-accounting" role="tabpanel" aria-labelledby="tab-accounting"/);
  const order = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(order.slice(-FIN_JS.length), FIN_JS, "fin scripts are the last scripts, util first");
  assert.ok(order.indexOf("fin-util.js") > order.indexOf("admin.js") && order.indexOf("fin-util.js") > order.indexOf("crm-util.js"));
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /(?:href|src)="(?:https?:)?\/\//i);
  const missing = [];
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) for (const l of LANGS) if (!(m[1] in I18N.dictionaries[l])) missing.push(`${l}:${m[1]}`);
  assert.deepEqual(missing, []);
  for (const f of FIN_JS) assert.ok(fs.existsSync(path.join(VITA, f)), f);
});

test("portal.html: read-only 'My payments' step with the staff-contact note; no inline code; keys resolve", () => {
  const html = read("portal.html");
  assert.match(html, /<section id="step-payments"[^>]*aria-labelledby="payments-h"/);
  assert.match(html, /data-step="payments" data-i18n="fin\.me\.step"/);
  assert.match(html, /data-i18n="fin\.me\.note"/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/i);
  const missing = [];
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) for (const l of LANGS) if (!(m[1] in I18N.dictionaries[l])) missing.push(`${l}:${m[1]}`);
  assert.deepEqual(missing, []);
  const js = read("portal.js");
  assert.match(js, /var STEPS = \["upload", "review", "prefs", "consent", "status", "payments"\]/);
  assert.match(js, /V\.api\("GET", "\/finance\/me"\)/);
  assert.match(js, /V\.download\("\/finance\/me\/invoices\/" \+ [^,]+ \+ "\/print\?lang=" \+ V\.getLang\(\)/);
  assert.doesNotMatch(js, /"\/finance\/(?!me)/, "the portal only reaches /finance/me*");
});

test("the API client allows /finance/ and /candidates/all besides the existing prefixes (which are unchanged)", () => {
  const src = read("vita.js");
  assert.match(src, /\^\\\/\(jobsearch\|auth\|crm\)\\\//);
  assert.match(src, /\^\\\/\(employer\|agency\)\\\//);
  assert.match(src, /\^\\\/finance\\\//);
  assert.match(src, /\^\\\/candidates\\\/all\(\?:\\\?\|\$\)\//);
});

test("download(): can open an authenticated blob in a new tab (no token in a URL) and reports the CSV row cap", () => {
  const src = read("vita.js");
  assert.match(src, /function download\(path, fallbackName, opts\)/);
  assert.match(src, /X-Row-Limit-Hit/);
  assert.match(src, /noopener/);
  assert.doesNotMatch(src, /[?&](?:token|access_token)=/);
});

test("admin.js: Accountant may use the console but only sees accounting tabs; no live stream without jobsearch:read", () => {
  const js = read("admin.js");
  assert.match(js, /var STAFF_ROLES = \["SuperAdmin", "Admin", "Manager", "Receptionist", "Agent", "Accountant"\]/);
  assert.match(js, /function hasJobsearch\(\)/);
  assert.match(js, /if \(hasJobsearch\(\)\) S\.events = V\.connectEvents/);
  assert.match(js, /function applyRoleTabs\(\)/);
});

test("static scan: fin scripts render text via the DOM helpers only and call only literal same-origin finance paths", () => {
  for (const f of [...FIN_JS, "portal.js"]) {
    const src = read(f);
    src.split("\n").forEach((line, i) => assert.doesNotMatch(line, SINKS, `${f}:${i + 1}`));
    assert.doesNotMatch(src, /https?:\/\//, `${f}: absolute URL`);
    assert.doesNotMatch(src, /\b(?:href|src)\s*:|srcdoc|\.(?:href|src)\s*=|setAttribute\(\s*["'](?:on|href|src|style)|\.on[a-z]+\s*=/, `${f}: link/handler sink`);
    assert.doesNotMatch(src, /localStorage|sessionStorage|document\.cookie/, `${f}: storage access belongs in vita.js`);
    assert.doesNotMatch(src, /console\.(log|info|debug)/, `${f}: console output`);
    assert.doesNotMatch(src, /[?&](?:token|access_token)=/, `${f}: token in a URL`);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest/, `${f}: network access goes through V.api / V.download`);
    assert.doesNotMatch(src, /parseFloat|Number\.parseFloat|parseInt\([^)]*(?:amount|price|total|balance)/i, `${f}: money is never parsed as a number`);
    if (f === "portal.js") continue;
    for (const m of src.matchAll(/V\.(?:api|download)\(\s*(?:"[A-Z]+"\s*,\s*)?"([^"]*)"/g)) assert.match(m[1], /^\/(finance\/|candidates\/all)/, `${f}: ${m[1]}`);
    for (const m of src.matchAll(/V\.api\(\s*"[A-Z]+"\s*,\s*([^"\s][^,)]*)/g)) assert.fail(`${f}: API path must start with a string literal: ${m[1]}`);
    for (const m of src.matchAll(/h\("button",\s*\{([^}]*)\}/g)) assert.match(m[1], /type:/, `${f}: button without a type: ${m[0].slice(0, 60)}`);
    assert.doesNotMatch(src, /attrs\s*:\s*\{\s*\[/, `${f}: computed attribute names`);
  }
  // pure helpers never touch the DOM
  assert.doesNotMatch(read("fin-util.js"), /\bdocument\b|\bwindow\.VITA\b|\bV\./);
  assert.match(read("vita.js"), /function h\(tag, props\)/);
});

test("served under the strict /vita CSP like every other script", async () => {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const f of [...FIN_JS, "admin.html", "portal.html"]) {
      const res = await fetch(`${base}/vita/${f}`);
      assert.equal(res.status, 200, f);
      assert.match(res.headers.get("content-security-policy"), /script-src 'self'; style-src 'self'/, f);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      await res.arrayBuffer();
    }
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
});

// ---------------------------------------------------------------- i18n

test("i18n: tab.accounting and every fin.* key exist in ar/en/fr, non-empty, identical placeholders, actually translated", () => {
  const { en, ar, fr } = I18N.dictionaries;
  const keys = Object.keys(en).filter((k) => k.startsWith("fin.") || k === "tab.accounting");
  assert.ok(keys.length >= 150, `fin keys: ${keys.length}`);
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
  for (const k of keys) {
    for (const [name, d] of [["ar", ar], ["fr", fr]]) {
      assert.equal(typeof d[k], "string", `${name}.${k}`);
      assert.ok(d[k].trim().length > 0, `${name}.${k} empty`);
      assert.equal(ph(d[k]), ph(en[k]), `${name}.${k} placeholders`);
    }
  }
  for (const k of ["tab.accounting", "fin.invoices.title", "fin.pay.submit", "fin.me.note", "fin.refund.submit", "fin.svc.title"]) {
    assert.match(ar[k], /[؀-ۿ]/, `ar ${k}`);
    assert.notEqual(fr[k], en[k], `fr ${k} should be translated`);
  }
  assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
});

test("i18n: every t(\"...\") key and every complete \"fin.*\" key literal in the fin scripts and the portal exists in ar/en/fr", () => {
  const used = new Set();
  for (const f of [...FIN_JS, "portal.js"]) {
    const src = read(f);
    for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"\s*[,)]/g)) used.add(m[1]);
    for (const m of src.matchAll(/"(fin(?:\.[a-zA-Z0-9_]+)+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 100, `expected many keys, got ${used.size}`);
  const missing = [];
  for (const k of used) for (const l of LANGS) if (!(k in I18N.dictionaries[l])) missing.push(`${l}:${k}`);
  assert.deepEqual(missing, []);
});

test("i18n: runtime-built key families match the server enums and the helper constants", () => {
  const fam = {
    "fin.status": invoicesSvc.STATUSES,
    "fin.method": paymentsSvc.METHODS,
    "fin.kind": ["invoice", "payment", "refund"],
    "fin.bucket": ["current", "0-30", "31-60", "61-90", "90+", "no_due_date"],
    "fin.export": ["invoices", "payments", "expenses"],
    "fin.sec": ["invoices", "reports", "expenses", "services"],
    "fin.rep": ["summary", "receivables", "byService", "byStaff", "statement"],
  };
  const missing = [];
  for (const [p, codes] of Object.entries(fam)) for (const c of codes) for (const l of LANGS) if (!(`${p}.${c}` in I18N.dictionaries[l])) missing.push(`${l}:${p}.${c}`);
  assert.deepEqual(missing, []);
  assert.deepEqual(U.INVOICE_STATUSES, invoicesSvc.STATUSES);
  assert.deepEqual(U.METHODS, paymentsSvc.METHODS);
  assert.deepEqual(U.CURRENCIES, ["TND", "EUR", "CAD", "USD"]);
});

// ---------------------------------------------------------------- permission mirror

test("fin-util can(): equals middleware/role.js PERMISSIONS for every role and every finance:* key (and denies unknown roles)", () => {
  for (const [role, perms] of Object.entries(PERMISSIONS)) {
    for (const p of FIN_PERMS) assert.equal(U.can(role, p), perms.includes("*") || perms.includes(p), `${role} ${p}`);
  }
  for (const role of [undefined, null, "", "Nobody", "__proto__", "constructor"]) for (const p of FIN_PERMS) assert.equal(U.can(role, p), false, `${String(role)} ${p}`);
  assert.equal(U.can("Admin", "finance:bogus"), false);
  assert.equal(U.canRead("Manager"), true);
  assert.equal(U.canWrite("Manager"), false, "Manager is read-only");
  assert.equal(U.canExport("Manager"), true);
  assert.equal(U.canVoid("Manager"), false);
  assert.equal(U.canRefund("Accountant"), true);
  assert.equal(U.canRead("Agent"), false);
  assert.equal(U.canRead("Candidate"), false);
});

test("crm-util can() still mirrors the finance:* keys it knows (Accountant included) so one mirror cannot drift from the other", () => {
  const CU = require("../public/vita/crm-util.js");
  for (const [role, perms] of Object.entries(PERMISSIONS)) {
    for (const p of FIN_PERMS) assert.equal(CU.can(role, p), perms.includes("*") || perms.includes(p), `crm-util ${role} ${p}`);
  }
});

// ---------------------------------------------------------------- money helpers (decimal strings, no floats)

test("formatMoney: grouping by string operations only; never rounds through a float", () => {
  assert.equal(U.formatMoney("1234.5"), "1,234.50");
  assert.equal(U.formatMoney("1234.50", "TND"), "1,234.50 TND");
  assert.equal(U.formatMoney("0"), "0.00");
  assert.equal(U.formatMoney("0.1"), "0.10");
  assert.equal(U.formatMoney("999"), "999.00");
  assert.equal(U.formatMoney("1000000"), "1,000,000.00");
  assert.equal(U.formatMoney("9007199254740993.10"), "9,007,199,254,740,993.10", "beyond 2^53 stays exact");
  assert.equal(U.formatMoney("99999999999999999999.99", "EUR"), "99,999,999,999,999,999,999.99 EUR");
  assert.equal(U.formatMoney("-1234.5", "CAD"), "-1,234.50 CAD", "statement balances can be negative");
  assert.equal(U.formatMoney("00012.5"), "12.50");
  assert.equal(U.formatMoney("12.345"), "12.34", "extra decimals are cut, not rounded: the server only sends 2");
  assert.equal(U.formatMoney(null), "—");
  assert.equal(U.formatMoney(undefined, "TND"), "—");
  assert.equal(U.formatMoney("abc", "TND"), "—");
  assert.equal(U.formatMoney("1e3"), "—", "exponent notation is not a server amount");
  assert.equal(U.formatMoney(12.5), "—", "numbers are refused: money only travels as strings");
  // same grouping as the server's print pages
  for (const v of ["0.00", "5.00", "1234.50", "1234567.89", "999999999999.99"]) assert.equal(U.formatMoney(v), serverFormatMoney(v));
  // 0.1 + 0.2 style values are shown exactly as the server computed them
  assert.equal(U.formatMoney("0.30", "TND"), "0.30 TND");
});

test("parseMoneyInput: accepts 12, 12.5, 12.50; rejects 1e3, 12,5, -1 and friends before anything is sent", () => {
  assert.deepEqual(U.parseMoneyInput("12"), { ok: true, value: "12.00" });
  assert.deepEqual(U.parseMoneyInput("12.5"), { ok: true, value: "12.50" });
  assert.deepEqual(U.parseMoneyInput("12.50"), { ok: true, value: "12.50" });
  assert.deepEqual(U.parseMoneyInput("  7.05 "), { ok: true, value: "7.05" });
  assert.deepEqual(U.parseMoneyInput("007"), { ok: true, value: "7.00" });
  assert.deepEqual(U.parseMoneyInput("0"), { ok: true, value: "0.00" });
  assert.deepEqual(U.parseMoneyInput("0.1"), { ok: true, value: "0.10" });
  for (const bad of ["1e3", "1E3", "12,5", "12,50", "-1", "+1", "1.234", ".5", "5.", "1 000", "NaN", "Infinity", "0x10", "--1", "12.5.1", "١٢", "", "   ", null, undefined, 12.5, {}, [], "1_000"]) {
    const r = U.parseMoneyInput(bad);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
    assert.equal(typeof r.error, "string");
  }
  assert.equal(U.parseMoneyInput("1e3").error, "format");
  assert.equal(U.parseMoneyInput("12,5").error, "format");
  assert.equal(U.parseMoneyInput("-1").error, "format");
  assert.equal(U.parseMoneyInput("1.234").error, "decimals");
  assert.equal(U.parseMoneyInput("").error, "empty");
  assert.equal(U.parseMoneyInput("12345678901").error, "large", "more than 10 integer digits");
  assert.deepEqual(U.parseMoneyInput("9999999999.99"), { ok: true, value: "9999999999.99" });
  assert.equal(U.parseMoneyInput("0", { positive: true }).error, "zero");
  assert.equal(U.parseMoneyInput("0.00", { positive: true }).error, "zero");
  assert.deepEqual(U.parseMoneyInput("0.01", { positive: true }), { ok: true, value: "0.01" });
});

test("parseQuantityInput: > 0, at most 2 decimals, at most 8 integer digits", () => {
  assert.deepEqual(U.parseQuantityInput("1"), { ok: true, value: "1.00" });
  assert.deepEqual(U.parseQuantityInput("2.5"), { ok: true, value: "2.50" });
  assert.deepEqual(U.parseQuantityInput("0.25"), { ok: true, value: "0.25" });
  for (const bad of ["0", "0.00", "-1", "1e2", "1,5", "1.234", "123456789", "", "x"]) assert.equal(U.parseQuantityInput(bad).ok, false, bad);
});

test("cmpDecimal / isZero compare normalised decimal strings without Number()", () => {
  assert.equal(U.cmpDecimal("10.00", "9.99"), 1);
  assert.equal(U.cmpDecimal("9.99", "10.00"), -1);
  assert.equal(U.cmpDecimal("10.00", "10"), 0);
  assert.equal(U.cmpDecimal("0.10", "0.1"), 0);
  assert.equal(U.cmpDecimal("9007199254740993.01", "9007199254740993.00"), 1, "beyond float precision");
  assert.equal(U.cmpDecimal("-5.00", "3.00"), -1);
  assert.equal(U.cmpDecimal("-5.00", "-6.00"), 1);
  assert.equal(U.cmpDecimal("0.30", "0.30"), 0);
  assert.equal(U.isZero("0.00"), true);
  assert.equal(U.isZero("0"), true);
  assert.equal(U.isZero("0.01"), false);
  assert.equal(U.isZero(null), false);
});

test("newIdempotencyKey: URL-safe, unique per call and within the API's 100 character limit", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const k = U.newIdempotencyKey();
    assert.match(k, /^[A-Za-z0-9_-]{16,100}$/);
    seen.add(k);
  }
  assert.equal(seen.size, 200);
});

// ---------------------------------------------------------------- payload builders

test("invoicePayload: lines from the catalogue or free text; blanks and bad numbers are reported with the line and field", () => {
  const svc = [{ id: 7, currency: "TND", default_price: "250.00", active: true }, { id: 8, currency: "EUR", default_price: "80.00", active: true }];
  const ok = U.invoicePayload({ candidate_id: "12", currency: "TND", due_date: "2026-12-01", notes: "  hello  ", lines: [
    { service_id: "7", description: "", quantity: "2", unit_price: "" },
    { service_id: "", description: " Translation ", quantity: "1.5", unit_price: "10" },
  ] }, svc);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.payload, {
    candidate_id: 12, currency: "TND", due_date: "2026-12-01", notes: "hello",
    items: [{ service_id: 7, quantity: "2.00" }, { description: "Translation", quantity: "1.50", unit_price: "10.00" }],
  });
  const minimal = U.invoicePayload({ candidate_id: "3", currency: "EUR", lines: [{ service_id: "", description: "x", quantity: "1", unit_price: "0" }] }, svc);
  assert.deepEqual(minimal.payload, { candidate_id: 3, currency: "EUR", items: [{ description: "x", quantity: "1.00", unit_price: "0.00" }] });
  const cases = [
    [{ candidate_id: "", currency: "TND", lines: [{ description: "x", quantity: "1", unit_price: "1" }] }, "candidate"],
    [{ candidate_id: "0", currency: "TND", lines: [{ description: "x", quantity: "1", unit_price: "1" }] }, "candidate"],
    [{ candidate_id: "1e2", currency: "TND", lines: [{ description: "x", quantity: "1", unit_price: "1" }] }, "candidate"],
    [{ candidate_id: "5", currency: "XXX", lines: [{ description: "x", quantity: "1", unit_price: "1" }] }, "currency"],
    [{ candidate_id: "5", currency: "TND", lines: [] }, "lines"],
    [{ candidate_id: "5", currency: "TND", due_date: "2026-02-30", lines: [{ description: "x", quantity: "1", unit_price: "1" }] }, "due_date"],
    [{ candidate_id: "5", currency: "TND", lines: [{ description: "", service_id: "", quantity: "1", unit_price: "1" }] }, "description"],
    [{ candidate_id: "5", currency: "TND", lines: [{ description: "x".repeat(301), quantity: "1", unit_price: "1" }] }, "description"],
    [{ candidate_id: "5", currency: "TND", lines: [{ description: "x", quantity: "0", unit_price: "1" }] }, "quantity"],
    [{ candidate_id: "5", currency: "TND", lines: [{ description: "x", quantity: "1", unit_price: "-1" }] }, "unit_price"],
    [{ candidate_id: "5", currency: "TND", lines: [{ description: "x", quantity: "1", unit_price: "" }] }, "unit_price"],
    [{ candidate_id: "5", currency: "TND", lines: [{ description: "x", quantity: "1", unit_price: "12,5" }] }, "unit_price"],
    [{ candidate_id: "5", currency: "TND", notes: "n".repeat(2001), lines: [{ description: "x", quantity: "1", unit_price: "1" }] }, "notes"],
    // a service priced in another currency needs an explicit unit price
    [{ candidate_id: "5", currency: "TND", lines: [{ service_id: "8", description: "", quantity: "1", unit_price: "" }] }, "unit_price"],
    [{ candidate_id: "5", currency: "TND", lines: Array.from({ length: 51 }, () => ({ description: "x", quantity: "1", unit_price: "1" })) }, "lines"],
  ];
  for (const [form, field] of cases) {
    const r = U.invoicePayload(form, svc);
    assert.equal(r.ok, false, JSON.stringify(form).slice(0, 80));
    assert.equal(r.field, field, JSON.stringify(r));
  }
  assert.equal(U.invoicePayload({ candidate_id: "5", currency: "TND", lines: [{ description: "x", quantity: "1", unit_price: "" }] }, svc).line, 0);
  assert.equal(U.invoicePayload({ candidate_id: "5", currency: "TND", lines: [{ description: "x", quantity: "1", unit_price: "1" }, { description: "", quantity: "1", unit_price: "1" }] }, svc).line, 1);
});

test("paymentPayload: amount, method, optional date/reference/notes and the dialog's idempotency key", () => {
  const p = U.paymentPayload({ invoice_id: 9, amount: "40", method: "cash", payment_date: "2026-10-01", reference: " R-1 ", notes: "" }, "key-123456789012345");
  assert.deepEqual(p, { ok: true, payload: { invoice_id: 9, amount: "40.00", method: "cash", payment_date: "2026-10-01", reference: "R-1", idempotency_key: "key-123456789012345" } });
  assert.deepEqual(U.paymentPayload({ invoice_id: 9, amount: "1.5", method: "card" }, "k-0123456789012345").payload, { invoice_id: 9, amount: "1.50", method: "card", idempotency_key: "k-0123456789012345" });
  for (const [form, field] of [
    [{ invoice_id: 9, amount: "", method: "cash" }, "amount"],
    [{ invoice_id: 9, amount: "0", method: "cash" }, "amount"],
    [{ invoice_id: 9, amount: "1e3", method: "cash" }, "amount"],
    [{ invoice_id: 9, amount: "5", method: "bitcoin" }, "method"],
    [{ invoice_id: 9, amount: "5", method: "" }, "method"],
    [{ invoice_id: 9, amount: "5", method: "cash", payment_date: "01/10/2026" }, "payment_date"],
    [{ invoice_id: 9, amount: "5", method: "cash", reference: "r".repeat(121) }, "reference"],
    [{ invoice_id: 9, amount: "5", method: "cash", notes: "n".repeat(501) }, "notes"],
  ]) {
    const r = U.paymentPayload(form, "key-123456789012345");
    assert.equal(r.ok, false, JSON.stringify(form));
    assert.equal(r.field, field);
  }
});

test("reasonPayload / refundPayload / expensePayload / servicePayload / diffs", () => {
  assert.deepEqual(U.reasonPayload("  typo  "), { ok: true, payload: { reason: "typo" } });
  assert.equal(U.reasonPayload("   ").field, "reason");
  assert.equal(U.reasonPayload("x".repeat(501)).field, "reason");
  assert.deepEqual(U.refundPayload({ amount: "10", reason: "overpaid", reopen: false }), { ok: true, payload: { amount: "10.00", reason: "overpaid" } });
  assert.deepEqual(U.refundPayload({ amount: "10.5", reason: "overpaid", reopen: true }).payload, { amount: "10.50", reason: "overpaid", reopen: true });
  assert.equal(U.refundPayload({ amount: "0", reason: "x" }).field, "amount");
  assert.equal(U.refundPayload({ amount: "5", reason: "" }).field, "reason");
  assert.equal(U.refundPayload({ amount: "5,5", reason: "x" }).field, "amount");

  const e = U.expensePayload({ title: " Rent ", amount: "1200", currency: "TND", spent_on: "2026-10-01", category_id: "4", payee: " Landlord ", notes: "" });
  assert.deepEqual(e, { ok: true, payload: { title: "Rent", amount: "1200.00", currency: "TND", spent_on: "2026-10-01", category_id: 4, payee: "Landlord" } });
  assert.equal(U.expensePayload({ title: "", amount: "1", currency: "TND", spent_on: "2026-10-01" }).field, "title");
  assert.equal(U.expensePayload({ title: "a", amount: "-1", currency: "TND", spent_on: "2026-10-01" }).field, "amount");
  assert.equal(U.expensePayload({ title: "a", amount: "1", currency: "ZZZ", spent_on: "2026-10-01" }).field, "currency");
  assert.equal(U.expensePayload({ title: "a", amount: "1", currency: "TND", spent_on: "" }).field, "spent_on");

  const s = U.servicePayload({ code: "VISA-1", name_ar: "", name_en: " Visa file ", name_fr: "Dossier", default_price: "150", currency: "EUR" }, { creating: true });
  assert.deepEqual(s, { ok: true, payload: { code: "VISA-1", name_en: "Visa file", name_fr: "Dossier", default_price: "150.00", currency: "EUR" } });
  assert.equal(U.servicePayload({ code: "x", name_en: "a", default_price: "1", currency: "TND" }, { creating: true }).field, "code");
  assert.equal(U.servicePayload({ code: "OK1", name_en: "", name_fr: "", name_ar: "", default_price: "1", currency: "TND" }, { creating: true }).field, "name");
  assert.equal(U.servicePayload({ code: "OK1", name_en: "a", default_price: "1.234", currency: "TND" }, { creating: true }).field, "default_price");
  const upd = U.servicePayload({ name_en: "New", name_fr: "", name_ar: "", default_price: "9", currency: "TND" }, { creating: false, base: { name_en: "Old", name_fr: null, name_ar: null, default_price: "9.00", currency: "TND" } });
  assert.deepEqual(upd, { ok: true, payload: { name_en: "New" } }, "only changed fields are sent");
  assert.equal(U.servicePayload({ name_en: "Old", default_price: "9", currency: "TND" }, { creating: false, base: { name_en: "Old", default_price: "9.00", currency: "TND" } }).field, "nothing");
});

test("queries: encoded, blanks omitted, page -> offset, limits clamped", () => {
  assert.equal(U.invoiceQuery({}, 1, 25), "?limit=25&offset=0");
  assert.equal(U.invoiceQuery({ status: "Partial", currency: "TND", candidate_id: " 12 ", from: "2026-01-01", to: "2026-12-31", overdue: true, q: " Ben & Co " }, 3, 20),
    "?status=Partial&currency=TND&candidate_id=12&from=2026-01-01&to=2026-12-31&overdue=true&q=Ben%20%26%20Co&limit=20&offset=40");
  assert.equal(U.invoiceQuery({ overdue: false }, 1, 25), "?limit=25&offset=0");
  assert.equal(U.invoiceQuery({}, 0, 1000), "?limit=100&offset=0");
  assert.equal(U.invoiceQuery({ candidate_id: "abc" }, 1, 25), "?limit=25&offset=0", "a non-numeric candidate filter is dropped");
  assert.equal(U.expenseQuery({ category_id: "2", include_voided: true, currency: "EUR", from: "2026-01-01" }, 2, 25), "?category_id=2&currency=EUR&from=2026-01-01&include_voided=true&limit=25&offset=25");
  assert.equal(U.rangeQuery("2026-01-01", ""), "?from=2026-01-01");
  assert.equal(U.rangeQuery("", ""), "");
  assert.equal(U.rangeQuery("2026-02-30", "2026-03-01"), "?to=2026-03-01", "an impossible date is dropped");
});

test("action rules mirror the server (record payment only on open invoices, void/refund bounds)", () => {
  assert.equal(U.canRecordPayment({ status: "Pending", remaining_amount: "10.00" }), true);
  assert.equal(U.canRecordPayment({ status: "Partial", remaining_amount: "0.01" }), true);
  assert.equal(U.canRecordPayment({ status: "Paid", remaining_amount: "0.00" }), false);
  assert.equal(U.canRecordPayment({ status: "Void", remaining_amount: "0.00" }), false);
  assert.equal(U.canRecordPayment({ status: "Draft", remaining_amount: "10.00" }), false);
  assert.equal(U.canRecordPayment({ status: "Refunded", remaining_amount: "0.00" }), false);
  assert.equal(U.canVoidInvoice({ status: "Pending" }), true);
  assert.equal(U.canVoidInvoice({ status: "Void" }), false);
  assert.equal(U.canVoidPayment({ voided_at: null, refunded: "0.00" }), true);
  assert.equal(U.canVoidPayment({ voided_at: "2026-01-01T00:00:00Z", refunded: "0.00" }), false);
  assert.equal(U.canVoidPayment({ voided_at: null, refunded: "5.00" }), false, "a payment with refunds cannot be voided");
  // refundable() is the server's net amount: the console does no money arithmetic at all
  assert.equal(U.refundable({ voided_at: null, net_amount: "30.00" }), "30.00");
  assert.equal(U.refundable({ voided_at: null, net_amount: "0.00" }), "0.00");
  assert.equal(U.refundable({ voided_at: "2026-01-01T00:00:00Z", net_amount: "50.00" }), "0.00");
  assert.equal(U.refundable({ voided_at: null }), "0.00");
  assert.equal(U.refundable({ voided_at: null, net_amount: "9007199254740993.05" }), "9007199254740993.05");
});

test("status badge classes cover every server status", () => {
  for (const s of invoicesSvc.STATUSES) assert.match(U.statusClass(s), /^(ok|warn|bad|info|neutral|gold)$/, s);
  assert.equal(U.statusClass("Paid"), "ok");
  assert.equal(U.statusClass("Void"), "bad");
  assert.equal(U.statusClass("nonsense"), "neutral");
});

test("rewriteDoc: print pages opened from a blob load their stylesheet from the site origin; nothing else changes", () => {
  const html = '<!doctype html><html><head><link rel="stylesheet" href="/vita/fin-print.css"></head><body>x<a href="/vita/fin-print.css">y</a></body></html>';
  const out = U.rewriteDoc(html, "http://127.0.0.1:3000");
  assert.ok(out.includes('<link rel="stylesheet" href="http://127.0.0.1:3000/vita/fin-print.css">'));
  assert.ok(out.includes('<a href="/vita/fin-print.css">'), "only the stylesheet link is rewritten");
  assert.equal(U.rewriteDoc(html, "javascript:alert(1)"), html, "a non-http origin leaves the document alone");
  assert.equal(U.rewriteDoc(html, 'http://x"><script>'), html);
  assert.equal(U.rewriteDoc("<p>no link</p>", "http://h"), "<p>no link</p>");
});

// ---------------------------------------------------------------- contract with the real API

test("contract: payloads built by the helpers are accepted by the API, and the limits the helpers enforce are the API's", async () => {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  try {
    const acct = (await one("INSERT INTO users (full_name,email,password,role) VALUES ('Acct','acct@finui.test.invalid','x','Accountant') RETURNING id")).id;
    const tok = jwt.sign({ id: acct, role: "Accountant" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const cand = (await one("INSERT INTO candidates (full_name, passport_number) VALUES ('Ui Contract','UIC-1') RETURNING id")).id;
    const http = async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const sp = U.servicePayload({ code: "UI-1", name_ar: "خدمة", name_en: "UI service", name_fr: "Service", default_price: "100.1", currency: "TND" }, { creating: true });
    assert.equal(sp.ok, true);
    const svc = await http("POST", "/finance/services", sp.payload);
    assert.equal(svc.status, 201, JSON.stringify(svc.body));
    assert.equal(svc.body.default_price, "100.10");

    const ip = U.invoicePayload({ candidate_id: String(cand), currency: "TND", due_date: "2026-12-31", notes: "n", lines: [
      { service_id: String(svc.body.id), description: "", quantity: "3", unit_price: "" },
      { service_id: "", description: "Courier", quantity: "0.5", unit_price: "0.10" },
    ] }, [svc.body]);
    assert.equal(ip.ok, true, JSON.stringify(ip));
    const inv = await http("POST", "/finance/invoices/v2", ip.payload);
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal(inv.body.total_amount, "300.35", "3 x 100.10 + 0.5 x 0.10 computed by the server in SQL");
    assert.equal(U.formatMoney(inv.body.total_amount, inv.body.currency), "300.35 TND");

    const key = U.newIdempotencyKey();
    const pp = U.paymentPayload({ invoice_id: inv.body.id, amount: "100.1", method: "cash", payment_date: "", reference: "R1", notes: "" }, key);
    assert.equal(pp.ok, true);
    const p1 = await http("POST", "/finance/payments/v2", pp.payload);
    const p2 = await http("POST", "/finance/payments/v2", pp.payload);
    assert.equal(p1.status, 201, JSON.stringify(p1.body));
    assert.equal(p2.status, 200, "same dialog key replays instead of posting twice");
    assert.equal(p2.body.replayed, true);
    assert.equal(p2.body.payment.id, p1.body.payment.id);
    assert.equal(p1.body.invoice.remaining_amount, "200.25");
    assert.equal(p1.body.invoice.status, "Partial");
    assert.equal(U.canRecordPayment(p1.body.invoice), true);

    const pay = p1.body.payment;
    assert.equal(U.refundable(pay), "100.10", "refundable is the server's net amount");
    assert.equal(U.canVoidPayment(pay), true);
    const rp = U.refundPayload({ amount: "0.1", reason: "rounding", reopen: false });
    const rf = await http("POST", `/finance/payments/${pay.id}/refund`, rp.payload);
    assert.equal(rf.status, 201, JSON.stringify(rf.body));
    const plist = await http("GET", `/finance/payments?invoice_id=${inv.body.id}&include_voided=true`);
    assert.equal(plist.status, 200);
    assert.equal(U.refundable(plist.body.rows[0]), "100.00", "the payments list carries the server-computed refunded / net amounts");
    assert.equal(U.canVoidPayment(plist.body.rows[0]), false, "a refunded payment cannot be voided");
    const tooMuch = await http("POST", `/finance/payments/${pay.id}/refund`, U.refundPayload({ amount: "100.01", reason: "x" }).payload);
    assert.equal(tooMuch.status, 400);

    const vr = U.reasonPayload("entered twice");
    const second = await http("POST", "/finance/invoices/v2", U.invoicePayload({ candidate_id: String(cand), currency: "EUR", lines: [{ description: "Other", quantity: "1", unit_price: "5" }] }, []).payload);
    assert.equal(second.status, 201);
    const voided = await http("POST", `/finance/invoices/${second.body.id}/void`, vr.payload);
    assert.equal(voided.status, 200);
    assert.equal(voided.body.status, "Void");
    assert.equal(U.canRecordPayment(voided.body), false);

    const ep = U.expensePayload({ title: "Stamps", amount: "12.5", currency: "TND", spent_on: "2026-10-01", category_id: "", payee: "", notes: "" });
    assert.equal((await http("POST", "/finance/expenses", ep.payload)).status, 201);

    // the limits the helpers enforce are the API's
    for (const bad of ["1e3", "12,5", "-1", "1.234"]) {
      assert.equal(U.parseMoneyInput(bad).ok, false);
      assert.equal((await http("POST", "/finance/payments/v2", { invoice_id: inv.body.id, amount: bad, method: "cash" })).status, 400, bad);
    }
    assert.equal(U.parseMoneyInput("12345678901").ok, false);
    assert.equal((await http("POST", "/finance/payments/v2", { invoice_id: inv.body.id, amount: "12345678901.00", method: "cash" })).status, 400);
    assert.equal(U.invoicePayload({ candidate_id: String(cand), currency: "TND", lines: Array.from({ length: 51 }, () => ({ description: "x", quantity: "1", unit_price: "1" })) }, []).ok, false);
    assert.equal((await http("POST", "/finance/invoices/v2", { candidate_id: cand, currency: "TND", items: Array.from({ length: 51 }, () => ({ description: "x", quantity: "1", unit_price: "1" })) })).status, 400);
    assert.equal((await http("POST", "/finance/invoices/v2", { candidate_id: cand, currency: "TND", items: [{ description: "x".repeat(301), quantity: "1", unit_price: "1" }] })).status, 400);

    // queries are understood by the list endpoints
    const list = await http("GET", `/finance/invoices${U.invoiceQuery({ status: "Partial", currency: "TND", candidate_id: String(cand), overdue: false }, 1, 25)}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.equal((await http("GET", `/finance/expenses${U.expenseQuery({ currency: "TND" }, 1, 25)}`)).status, 200);
    assert.equal((await http("GET", `/finance/reports/summary${U.rangeQuery("2020-01-01", "2030-01-01")}`)).status, 200);
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
});
