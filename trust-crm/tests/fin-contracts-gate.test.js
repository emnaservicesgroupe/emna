// Stage 8 task 6: service contracts, recorded legal reviews (insert-only) and the candidate-fee billing gate.
// The platform records reviews; nothing here (or in the product) is legal advice. Real Postgres + HTTP.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "fin-contracts-gate-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fin-contracts-"));
delete process.env.FIN_TAX_RATE_PERCENT;
delete process.env.FIN_CURRENCIES;
delete process.env.FIN_DEFAULT_JURISDICTION;

const gate = require("../modules/finance/billingGate");

const NOW = "2030-06-15T12:00:00Z";
const TODAY = "2030-06-15";
gate.setClock(() => new Date(NOW));
test.after(() => gate.setClock());

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
    ids[k] = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`${role} ${k}`, `${k}@gate.test.invalid`, role])).id;
    T[k] = jwt.sign({ id: ids[k], role, ...(k === "cand" ? { tv: 0 } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" });
  }
  T.emp = (await createEmployerUser(pool)).token;
  T.agy = (await createAgencyUser(pool)).token;
  let n = 0;
  const candidate = async (province = "ON", name = "Amine Trabelsi") => {
    n += 1;
    return (await one("INSERT INTO candidates (full_name, passport_number, desired_province) VALUES ($1,$2,$3) RETURNING id", [name, `GATE${process.pid}-${n}`, province])).id;
  };
  const candidateLogin = async (candidateId) => {
    n += 1;
    const uid = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x','Candidate') RETURNING id", [`Cand login ${n}`, `cl${n}-${process.pid}@gate.test.invalid`])).id;
    if (candidateId) await q("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [uid, candidateId]);
    return jwt.sign({ id: uid, role: "Candidate", tv: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  };
  const service = async (over = {}, token = T.admin) => {
    n += 1;
    const r = await http("POST", "/finance/services", token, { code: `SVC${n}`, name_en: `Service ${n}`, default_price: "250.00", currency: "TND", ...over });
    assert.equal(r.status, 201, r.text);
    return r.body;
  };
  const feeService = (over = {}) => service({ kind: "candidate_fee", name_en: "Package A", ...over });
  let day = 0;
  /** Records a review with strictly increasing reviewed_at (the latest one decides). */
  const review = async (jurisdiction, status, over = {}) => {
    day += 1;
    const d = new Date(Date.UTC(2029, 0, 1) + day * 86400000).toISOString().slice(0, 10);
    const r = await http("POST", "/finance/legal-reviews", T.admin, { jurisdiction, status, reviewer_name: "Me. A. Reviewer", reviewer_role: "Counsel", reviewed_at: d, ...over });
    assert.equal(r.status, 201, r.text);
    return r.body;
  };
  /** A contract in the requested state: draft | active | ended | cancelled. */
  const contract = async (candidateId, serviceId, state = "active", over = {}) => {
    const { jurisdiction: jur, signed_at: signedAt, ...createOver } = over;
    const c = await http("POST", "/finance/contracts", T.acct, { candidate_id: candidateId, service_id: serviceId, refund_terms: "Refund terms text", ...createOver });
    assert.equal(c.status, 201, c.text);
    if (state === "draft") return c.body;
    if (state === "cancelled") {
      assert.equal((await http("POST", `/finance/contracts/${c.body.id}/cancel`, T.acct, { reason: "x" })).status, 200);
      return { ...c.body, status: "cancelled" };
    }
    // The jurisdiction of a candidate-fee contract is recorded by staff at signing (review round 1); default: the candidate's province.
    const fee = (await one("SELECT kind FROM fin_services WHERE id = $1", [serviceId])).kind === "candidate_fee";
    const prov = (await one("SELECT desired_province FROM candidates WHERE id = $1", [candidateId])).desired_province;
    const jurisdiction = jur !== undefined ? jur : fee && prov ? `CA-${prov}` : undefined;
    const s = await http("POST", `/finance/contracts/${c.body.id}/sign`, T.acct, { signed_by_name: "Amine Trabelsi", ...(jurisdiction ? { jurisdiction } : {}), ...(signedAt ? { signed_at: signedAt } : {}) });
    assert.equal(s.status, 200, s.text);
    if (state === "ended") assert.equal((await http("POST", `/finance/contracts/${c.body.id}/end`, T.acct, {})).status, 200);
    return s.body;
  };
  const invoice = (candidateId, items, over = {}, token = T.acct) => http("POST", "/finance/invoices/v2", token, { candidate_id: candidateId, currency: "TND", items, ...over });
  try {
    await fn({ pool, http, q, one, T, ids, candidate, candidateLogin, service, feeService, review, contract, invoice, base });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}
const line = (service_id, extra = {}) => ({ service_id, quantity: 1, ...extra });

// ------------------------------------------------------------------------------------------------ migration / schema
test("migration 030: idempotent, kind defaults to standard, constraints and immutability triggers exist", () =>
  withWorld(async ({ q, one, candidate, service }) => {
    const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "030_service_contracts_legal_gate.sql"), "utf8");
    await q(sql);
    await q(sql);
    await service();
    assert.equal((await one("SELECT kind FROM fin_services ORDER BY id LIMIT 1")).kind, "standard");
    await assert.rejects(q("INSERT INTO fin_services (code, name_en, kind) VALUES ('BADKIND','x','premium')"), /fin_services_kind_check/);
    const c = await candidate();
    const s = (await one("INSERT INTO fin_services (code, name_en, kind) VALUES ('K1','x','candidate_fee') RETURNING id")).id;
    await assert.rejects(q("INSERT INTO fin_service_contracts (candidate_id, service_id, status) VALUES ($1,$2,'active')", [c, s]), /active_signed_check/, "active needs agreement_signed_at");
    await assert.rejects(q("INSERT INTO fin_service_contracts (candidate_id, service_id, start_date, end_date) VALUES ($1,$2,'2030-02-01','2030-01-01')", [c, s]), /dates_check/);
    await assert.rejects(q("INSERT INTO fin_service_contracts (candidate_id, service_id, status) VALUES ($1,$2,'weird')", [c, s]));
    await assert.rejects(q("INSERT INTO fin_service_contracts (candidate_id, service_id, refund_terms) VALUES ($1,$2,$3)", [c, s, "x".repeat(2001)]));
    for (const j of ["ca-on", "CAN", "C", "CA-", "CA-ONTA", "CA_ON", "CA-ON "]) {
      await assert.rejects(q("INSERT INTO fin_legal_reviews (jurisdiction,status,reviewer_name,reviewed_at) VALUES ($1,'approved','R','2030-01-01')", [j]), j);
    }
    for (const j of ["CA-ON", "CA-QC", "TN", "CA"]) await q("INSERT INTO fin_legal_reviews (jurisdiction,status,reviewer_name,reviewed_at) VALUES ($1,'pending','R','2030-01-01')", [j]);
    await assert.rejects(q("INSERT INTO fin_legal_reviews (jurisdiction,status,reviewer_name,reviewed_at) VALUES ('TN','weird','R','2030-01-01')"));
    await assert.rejects(q("INSERT INTO fin_legal_reviews (jurisdiction,status,reviewer_name,reviewed_at) VALUES ('TN','approved','','2030-01-01')"));
    await assert.rejects(q("INSERT INTO fin_legal_reviews (jurisdiction,status,reviewer_name,reviewed_at,valid_until) VALUES ('TN','approved','R','2030-01-02','2030-01-01')"));
  }));

// ------------------------------------------------------------------------------------------------ review immutability
test("legal reviews are insert-only; the newest RECORDED row (id) supersedes", () =>
  withWorld(async ({ q, one, http, T, review }) => {
    const a = await review("CA-ON", "approved");
    await assert.rejects(q("UPDATE fin_legal_reviews SET status = 'prohibited' WHERE id = $1", [a.id]), /insert-only/);
    await assert.rejects(q("DELETE FROM fin_legal_reviews WHERE id = $1", [a.id]), /insert-only/);
    await assert.rejects(q("TRUNCATE fin_legal_reviews"), /insert-only/);
    assert.equal((await one("SELECT status FROM fin_legal_reviews WHERE id = $1", [a.id])).status, "approved");
    // no HTTP way to edit or delete one
    for (const m of ["PATCH", "PUT", "DELETE"]) assert.equal((await http(m, `/finance/legal-reviews/${a.id}`, T.admin, {})).status, 404);
    // a newer review supersedes
    const b = await review("CA-ON", "prohibited");
    let latest = await one("SELECT id, status FROM fin_legal_reviews_latest WHERE jurisdiction = 'CA-ON'");
    assert.deepEqual([String(latest.id), latest.status], [String(b.id), "prohibited"]);
    // review round 1: the review RECORDED last decides, whatever its (informational) reviewed_at says
    const late = await http("POST", "/finance/legal-reviews", T.admin, { jurisdiction: "CA-ON", status: "approved", reviewer_name: "Late entry", reviewed_at: "2020-01-01" });
    latest = await one("SELECT id, status FROM fin_legal_reviews_latest WHERE jurisdiction = 'CA-ON'");
    assert.deepEqual([String(latest.id), latest.status], [String(late.body.id), "approved"]);
    const d = b.reviewed_at;
    const c2 = await http("POST", "/finance/legal-reviews", T.admin, { jurisdiction: "CA-ON", status: "pending", reviewer_name: "Same day", reviewed_at: d });
    latest = await one("SELECT id, status FROM fin_legal_reviews_latest WHERE jurisdiction = 'CA-ON'");
    assert.deepEqual([String(latest.id), latest.status], [String(c2.body.id), "pending"]);
    // the listing marks exactly one current row per jurisdiction
    const list = await http("GET", "/finance/legal-reviews?jurisdiction=CA-ON", T.acct);
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 4);
    assert.deepEqual(list.body.rows.filter((r) => r.current).map((r) => String(r.id)), [String(c2.body.id)]);
  }));

test("recording a review: admin only, validated and audited; reading needs finance:read", () =>
  withWorld(async ({ http, T, q }) => {
    const ok = { jurisdiction: "ca-on", status: "approved", reviewer_name: "Me. A. Reviewer", reviewed_at: "2030-06-01", valid_until: "2031-06-01", note: "internal note", evidence_key: "memo-2030.pdf" };
    for (const k of ["acct", "mgr", "agent", "rec", "hr", "cand", "emp", "agy"]) assert.equal((await http("POST", "/finance/legal-reviews", T[k], ok)).status, 403, k);
    assert.equal((await http("POST", "/finance/legal-reviews", null, ok)).status, 401);
    const a = await http("POST", "/finance/legal-reviews", T.admin, ok);
    assert.equal(a.status, 201, a.text);
    assert.equal(a.body.jurisdiction, "CA-ON", "jurisdiction is normalised to upper case");
    assert.equal(a.body.service_kind, "candidate_fee");
    assert.equal(a.body.valid_until, "2031-06-01");
    assert.equal(a.body.recorded_by, (await q("SELECT id FROM users WHERE email='admin@gate.test.invalid'")).rows[0].id);
    assert.equal((await http("POST", "/finance/legal-reviews", T.sa, { ...ok, jurisdiction: "TN" })).status, 201);
    for (const bad of [
      { ...ok, jurisdiction: "Ontario" }, { ...ok, jurisdiction: "CA-" }, { ...ok, status: "maybe" }, { ...ok, status: undefined }, { ...ok, reviewer_name: " " }, { ...ok, reviewer_name: undefined },
      { ...ok, reviewed_at: undefined }, { ...ok, reviewed_at: "2030-02-31" }, { ...ok, reviewed_at: "2031-01-01" }, { ...ok, valid_until: "2030-05-31" }, { ...ok, service_kind: "other" },
      { ...ok, note: "x".repeat(2001) }, { ...ok, evidence_key: "../../etc/passwd" }, { ...ok, extra: 1 }, { ...ok, reviewer_name: "x".repeat(201) },
    ]) assert.equal((await http("POST", "/finance/legal-reviews", T.admin, bad)).status, 400, JSON.stringify(bad));
    assert.equal((await http("POST", "/finance/legal-reviews", T.admin, null)).status, 400);
    const audit = (await q("SELECT user_id, action FROM audit_logs WHERE table_name='fin_legal_reviews'")).rows;
    assert.equal(audit.length, 2);
    assert.ok(audit.every((r) => r.action === "CREATE"));
    for (const k of ["admin", "sa", "acct", "mgr"]) assert.equal((await http("GET", "/finance/legal-reviews", T[k])).status, 200, k);
    for (const k of ["agent", "rec", "hr", "cand", "emp", "agy"]) assert.equal((await http("GET", "/finance/legal-reviews", T[k])).status, 403, k);
    assert.equal((await http("GET", "/finance/legal-reviews?jurisdiction=nope", T.acct)).status, 400);
  }));

// ------------------------------------------------------------------------------------------------ service kind
test("service kind: candidate_fee can only be set, changed or cleared by an administrator; listings show kind", () =>
  withWorld(async ({ http, T, service }) => {
    const mk = (b, t) => http("POST", "/finance/services", t, { code: `K${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name_en: "x", ...b });
    assert.equal((await mk({ kind: "candidate_fee" }, T.acct)).status, 403, "Accountant cannot create a candidate_fee service");
    assert.equal((await mk({ kind: "premium" }, T.admin)).status, 400);
    const std = await mk({}, T.acct);
    assert.equal(std.status, 201);
    assert.equal(std.body.kind, "standard");
    assert.equal((await mk({ kind: "standard" }, T.acct)).status, 201, "explicit standard needs no admin");
    const fee = await mk({ kind: "candidate_fee" }, T.admin);
    assert.equal(fee.status, 201, fee.text);
    assert.equal(fee.body.kind, "candidate_fee");
    assert.equal((await mk({ kind: "candidate_fee" }, T.sa)).status, 201);
    // changing kind
    assert.equal((await http("PATCH", `/finance/services/${std.body.id}`, T.acct, { kind: "candidate_fee" })).status, 403);
    assert.equal((await http("PATCH", `/finance/services/${fee.body.id}`, T.acct, { kind: "standard" })).status, 403, "clearing it is admin-only too");
    assert.equal((await http("PATCH", `/finance/services/${fee.body.id}`, T.acct, { kind: "candidate_fee", default_price: "300" })).status, 200, "same value + price edit is fine");
    assert.equal((await http("PATCH", `/finance/services/${fee.body.id}`, T.acct, { default_price: "310", active: false })).status, 200);
    const flip = await http("PATCH", `/finance/services/${std.body.id}`, T.admin, { kind: "candidate_fee" });
    assert.equal(flip.status, 200);
    assert.equal(flip.body.kind, "candidate_fee");
    assert.equal((await http("PATCH", `/finance/services/${std.body.id}`, T.admin, { kind: "x" })).status, 400);
    const list = await http("GET", "/finance/services", T.mgr);
    assert.ok(list.body.rows.every((r) => ["standard", "candidate_fee"].includes(r.kind)));
    assert.ok(list.body.rows.some((r) => r.kind === "candidate_fee"));
    void service;
  }));

// ------------------------------------------------------------------------------------------------ contracts
test("contract lifecycle: draft -> sign (+ private document) -> end / cancel; permissions and audit", () =>
  withWorld(async ({ http, T, q, base, candidate, feeService }) => {
    const c = await candidate();
    const s = await feeService();
    const mk = (b, t = T.acct) => http("POST", "/finance/contracts", t, b);
    for (const k of ["mgr", "agent", "rec", "hr", "cand", "emp", "agy"]) assert.equal((await mk({ candidate_id: c, service_id: s.id }, T[k])).status, 403, k);
    for (const bad of [{}, { candidate_id: c }, { candidate_id: c, service_id: 999999 }, { candidate_id: 999999, service_id: s.id }, { candidate_id: c, service_id: s.id, start_date: "2030-02-01", end_date: "2030-01-01" },
      { candidate_id: c, service_id: s.id, refund_terms: "x".repeat(2001) }, { candidate_id: c, service_id: s.id, status: "active" }, { candidate_id: "abc", service_id: s.id }]) {
      assert.ok([400, 404].includes((await mk(bad)).status), JSON.stringify(bad));
    }
    const d = await mk({ candidate_id: c, service_id: s.id, start_date: "2030-06-01", end_date: "2031-06-01", refund_terms: "Refundable within 14 days" });
    assert.equal(d.status, 201, d.text);
    assert.equal(d.body.status, "draft");
    assert.equal(d.body.agreement_signed_at, null);
    assert.equal(d.body.has_signed_document, false);
    const id = d.body.id;
    // cannot end a draft; sign validation
    assert.equal((await http("POST", `/finance/contracts/${id}/end`, T.acct, {})).status, 409);
    assert.equal((await http("POST", `/finance/contracts/${id}/sign`, T.acct, {})).status, 400);
    assert.equal((await http("POST", `/finance/contracts/${id}/sign`, T.acct, { signed_by_name: "A", signed_at: "2999-01-01T00:00:00Z" })).status, 400);
    assert.equal((await http("POST", `/finance/contracts/${id}/sign`, T.acct, { signed_by_name: "A", signed_at: "garbage" })).status, 400);
    for (const k of ["mgr", "agent", "rec", "hr", "cand", "emp", "agy"]) assert.equal((await http("POST", `/finance/contracts/${id}/sign`, T[k], { signed_by_name: "A" })).status, 403, k);
    // a non-document upload is refused and the contract stays a draft
    const bad = new FormData();
    bad.append("signed_by_name", "Amine");
    bad.append("file", new Blob(["plain text, not a document"]), "x.pdf");
    assert.equal((await fetch(`${base}/finance/contracts/${id}/sign`, { method: "POST", headers: { authorization: `Bearer ${T.acct}` }, body: bad })).status, 400);
    assert.equal((await http("GET", `/finance/contracts/${id}`, T.acct)).body.status, "draft");
    // sign with a PDF
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("signed agreement body")]);
    const fd = new FormData();
    fd.append("signed_by_name", "Amine Trabelsi");
    fd.append("jurisdiction", "ca-on");
    fd.append("file", new Blob([pdf]), "../../evil.name.pdf");
    const sg = await fetch(`${base}/finance/contracts/${id}/sign`, { method: "POST", headers: { authorization: `Bearer ${T.acct}` }, body: fd });
    const sgBody = await sg.json();
    assert.equal(sg.status, 200, JSON.stringify(sgBody));
    assert.equal(sgBody.status, "active");
    assert.equal(sgBody.jurisdiction, "CA-ON", "the jurisdiction is normalised and stored on the contract");
    assert.ok(sgBody.agreement_signed_at);
    assert.equal(sgBody.has_signed_document, true);
    assert.equal(sgBody.signed_document_key, undefined, "the storage key is never returned");
    const row = (await q("SELECT signed_document_key AS k FROM fin_service_contracts WHERE id=$1", [id])).rows[0];
    assert.match(row.k, /^\d+-[a-f0-9]{64}\.pdf$/, "stored under a server-generated key");
    const docRes = await fetch(`${base}/finance/contracts/${id}/document`, { headers: { authorization: `Bearer ${T.mgr}` } });
    assert.equal(docRes.status, 200);
    assert.equal(docRes.headers.get("content-type"), "application/pdf");
    assert.deepEqual(Buffer.from(await docRes.arrayBuffer()), pdf);
    for (const k of ["agent", "rec", "hr", "cand", "emp", "agy"]) assert.equal((await http("GET", `/finance/contracts/${id}/document`, T[k])).status, 403, k);
    // signing again, a second active contract for the same pair
    assert.equal((await http("POST", `/finance/contracts/${id}/sign`, T.acct, { signed_by_name: "A" })).status, 409);
    const d2 = await mk({ candidate_id: c, service_id: s.id });
    assert.equal((await http("POST", `/finance/contracts/${d2.body.id}/sign`, T.acct, { signed_by_name: "A", jurisdiction: "CA-ON" })).status, 409, "one active contract per candidate + service");
    // end / cancel need finance:void
    assert.equal((await http("POST", `/finance/contracts/${id}/end`, T.mgr, {})).status, 403);
    assert.equal((await http("POST", `/finance/contracts/${id}/end`, T.acct, { reason: "x".repeat(501) })).status, 400);
    const ended = await http("POST", `/finance/contracts/${id}/end`, T.acct, { reason: "service completed" });
    assert.equal(ended.status, 200);
    assert.equal(ended.body.status, "ended");
    assert.equal((await http("POST", `/finance/contracts/${id}/end`, T.acct, {})).status, 409);
    assert.equal((await http("POST", `/finance/contracts/${id}/cancel`, T.acct, {})).status, 409, "an ended contract cannot be cancelled");
    assert.equal((await http("POST", `/finance/contracts/${d2.body.id}/cancel`, T.acct, { reason: "duplicate" })).body.status, "cancelled");
    assert.equal((await http("POST", `/finance/contracts/${d2.body.id}/sign`, T.acct, { signed_by_name: "A" })).status, 409, "a cancelled contract cannot be signed");
    assert.equal((await http("POST", "/finance/contracts/999999/sign", T.acct, { signed_by_name: "A" })).status, 404);
    assert.equal((await http("GET", "/finance/contracts/999999", T.acct)).status, 404);
    assert.equal((await http("GET", `/finance/contracts/${d2.body.id}/document`, T.acct)).status, 404, "no document stored");
    // audit rows: create x2, sign, end, cancel
    const audit = (await q("SELECT action, new_data FROM audit_logs WHERE table_name='fin_service_contracts' ORDER BY id")).rows;
    assert.deepEqual(audit.map((r) => r.action), ["CREATE", "UPDATE", "CREATE", "UPDATE", "UPDATE"]);
    const events = audit.filter((r) => r.action === "UPDATE").map((r) => (typeof r.new_data === "string" ? JSON.parse(r.new_data) : r.new_data).event);
    assert.deepEqual(events, ["sign", "end", "cancel"]);
    // listing: finance:read roles only
    for (const k of ["acct", "mgr", "admin", "sa"]) assert.equal((await http("GET", `/finance/contracts?candidate_id=${c}`, T[k])).body.total, 2, k);
    for (const k of ["agent", "rec", "hr", "cand", "emp", "agy"]) assert.equal((await http("GET", "/finance/contracts", T[k])).status, 403, k);
    assert.equal((await http("GET", "/finance/contracts?status=ended", T.acct)).body.rows.length, 1);
    assert.equal((await http("GET", "/finance/contracts?status=zzz", T.acct)).status, 400);
    assert.equal((await http("GET", `/finance/contracts?service_id=${s.id}`, T.acct)).body.total, 2);
  }));

// ------------------------------------------------------------------------------------------------ the gate (v2 route)
test("gate matrix: candidate_fee line needs an active signed contract AND a current approved review for the jurisdiction", () =>
  withWorld(async ({ http, q, candidate, feeService, review, contract, invoice }) => {
    const svc = await feeService();
    const refused = async (cand, code, items = [line(svc.id)], over = {}) => {
      const count = async () => (await q("SELECT count(*)::int n FROM invoices WHERE candidate_id=$1", [cand])).rows[0].n;
      const before = await count();
      const r = await invoice(cand, items, over);
      assert.equal(r.status, 409, `${code}: ${r.text}`);
      assert.equal(r.body.code, code, r.text);
      assert.ok(!/reviewer|Reviewer|Counsel/.test(r.text), "the message does not leak reviewer details");
      assert.ok(!/you (should|must) (not )?(charge|bill)|legal advice:/i.test(r.body.error), "the message states the missing record, it gives no advice");
      assert.equal(await count(), before, "nothing was created");
      return r;
    };
    // ----- review states (contract active in every case) on ON
    const on = await candidate("ON");
    await contract(on, svc.id, "active");
    await refused(on, "legal_review_required"); // no review at all for CA-ON
    await review("CA-ON", "pending");
    await refused(on, "legal_review_required"); // pending
    await review("CA-ON", "approved", { valid_until: "2030-06-14" });
    await refused(on, "legal_review_required"); // expired yesterday
    await review("CA-ON", "approved", { valid_until: "2030-06-15" });
    let r = await invoice(on, [line(svc.id)]);
    assert.equal(r.status, 201, `valid_until = today is still valid: ${r.text}`);
    await review("CA-ON", "approved", { valid_until: null });
    assert.equal((await invoice(on, [line(svc.id)])).status, 201, "no expiry");
    await review("CA-ON", "prohibited");
    await refused(on, "candidate_fee_prohibited");
    await review("CA-ON", "prohibited", { valid_until: "2029-12-31" }); // a lapsed prohibition is still a prohibition
    await refused(on, "candidate_fee_prohibited");
    await review("CA-ON", "approved"); // superseded again
    assert.equal((await invoice(on, [line(svc.id)])).status, 201);

    // ----- contract states with an approved review (QC)
    await review("CA-QC", "approved");
    for (const state of ["draft", "cancelled", "ended"]) {
      const c = await candidate("QC");
      await contract(c, svc.id, state);
      await refused(c, "service_contract_required");
    }
    const noContract = await candidate("QC");
    await refused(noContract, "service_contract_required");
    // contract for a DIFFERENT fee service does not help
    const other = await feeService({ name_en: "Package B" });
    const wrongSvc = await candidate("QC");
    await contract(wrongSvc, other.id, "active");
    await refused(wrongSvc, "service_contract_required");
    // an end_date in the past also ends the contract; a contract ending today still counts
    const lapsed = await candidate("QC");
    await contract(lapsed, svc.id, "active", { end_date: "2030-06-14" });
    await refused(lapsed, "service_contract_required");
    const lastDay = await candidate("QC");
    await contract(lastDay, svc.id, "active", { end_date: "2030-06-15" });
    assert.equal((await invoice(lastDay, [line(svc.id)])).status, 201);
    const okQc = await candidate("QC");
    await contract(okQc, svc.id, "active");
    assert.equal((await invoice(okQc, [line(svc.id)])).status, 201);

    // ----- wrong jurisdiction: the review is for BC, the candidate is in AB
    await review("CA-BC", "approved");
    const ab = await candidate("AB");
    await contract(ab, svc.id, "active");
    await refused(ab, "legal_review_required");
    const bc = await candidate("BC");
    await contract(bc, svc.id, "active");
    assert.equal((await invoice(bc, [line(svc.id)])).status, 201);
    // a review for another country code does not stand in for CA-xx
    await review("TN", "approved");
    await refused(ab, "legal_review_required");

    // ----- other currencies do not bypass the gate
    const eur = await candidate("NS");
    await contract(eur, svc.id, "active");
    await refused(eur, "legal_review_required", [line(svc.id, { unit_price: "100.00" })], { currency: "EUR" });
    await refused(eur, "legal_review_required", [line(svc.id, { unit_price: "100.00" })], { currency: "CAD" });
    await review("CA-NS", "approved");
    assert.equal((await invoice(eur, [line(svc.id, { unit_price: "100.00" })], { currency: "EUR" })).status, 201);
    // the gate holds even for an inactive-then-reactivated service id repeated twice in one invoice
    const dup = await candidate("NS");
    await refused(dup, "service_contract_required", [line(svc.id), line(svc.id)]);
    void http;
  }));

test("gate: mixed standard + candidate_fee lines, standard-only invoices, free-text lines", () =>
  withWorld(async ({ http, T, q, candidate, service, feeService, review, contract, invoice }) => {
    const fee = await feeService();
    const std = await service({ name_en: "Translation" });
    const c = await candidate("ON");
    // standard only: never gated (no contract, no review)
    assert.equal((await invoice(c, [line(std.id)])).status, 201);
    assert.equal((await invoice(c, [{ description: "Courier fee", quantity: 1, unit_price: "20.00" }])).status, 201, "free text without a fee contract is as before");
    // one fee line poisons the whole invoice
    const mixed = await invoice(c, [line(std.id), line(fee.id)]);
    assert.equal(mixed.status, 409);
    assert.equal(mixed.body.code, "legal_review_required");
    assert.equal((await q("SELECT count(*)::int n FROM invoices WHERE candidate_id=$1", [c])).rows[0].n, 2);
    await contract(c, fee.id, "active");
    await review("CA-ON", "approved");
    const ok = await invoice(c, [line(std.id), line(fee.id), { description: "Courier", quantity: 1, unit_price: "5.00" }]);
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.items.length, 3);
    // with an active fee contract a free-text line is refused (it could be a disguised package fee): bill through the catalogue
    const ft = await invoice(c, [{ description: "Package A (manual)", quantity: 1, unit_price: "250.00" }]);
    assert.equal(ft.status, 409);
    assert.equal(ft.body.code, "candidate_fee_use_catalogue");
    assert.equal((await invoice(c, [line(std.id)])).status, 201, "catalogue standard services still bill normally");
    // review round 1: while the jurisdiction is prohibited NO invoice can be created for the candidate, whatever the line kinds
    await review("CA-ON", "prohibited");
    for (const items of [[line(std.id)], [{ description: "Courier", quantity: 1, unit_price: "5.00" }], [line(std.id), line(fee.id)]]) {
      const r = await invoice(c, items);
      assert.deepEqual([r.status, r.body.code], [409, "candidate_fee_prohibited"], JSON.stringify(items));
    }
    // the gate does not depend on the caller: Admin gets the same answer
    assert.equal((await invoice(c, [line(fee.id)], {}, T.admin)).status, 409);
    // role rules of invoice creation are unchanged
    assert.equal((await invoice(c, [line(std.id)], {}, T.mgr)).status, 403);
    void http;
  }));

test("gate: jurisdiction from desired_province; null province uses FIN_DEFAULT_JURISDICTION, else jurisdiction_unknown", () =>
  withWorld(async ({ q, candidate, feeService, review, contract, invoice, http, T }) => {
    const svc = await feeService();
    const c = await candidate(null);
    await contract(c, svc.id, "active", { jurisdiction: "CA-ON" });
    await q("UPDATE fin_service_contracts SET jurisdiction = NULL WHERE candidate_id = $1", [c]); // a contract signed before migration 031
    delete process.env.FIN_DEFAULT_JURISDICTION;
    let r = await invoice(c, [line(svc.id)]);
    assert.deepEqual([r.status, r.body.code], [409, "jurisdiction_unknown"]);
    process.env.FIN_DEFAULT_JURISDICTION = "garbage!";
    r = await invoice(c, [line(svc.id)]);
    assert.equal(r.body.code, "jurisdiction_unknown", "an invalid default is ignored");
    try {
      process.env.FIN_DEFAULT_JURISDICTION = "ca-on";
      r = await invoice(c, [line(svc.id)]);
      assert.equal(r.body.code, "legal_review_required", "default CA-ON has no review yet");
      await review("CA-ON", "approved");
      assert.equal((await invoice(c, [line(svc.id)])).status, 201);
      // a candidate WITH a province ignores the default
      const qc = await candidate("QC");
      await contract(qc, svc.id, "active");
      assert.equal((await invoice(qc, [line(svc.id)])).body.code, "legal_review_required");
      // the default decides prohibition for the legacy route too
      await review("CA-ON", "prohibited");
      const legacy = await http("POST", "/finance/invoices", T.acct, { candidate_id: (await candidate(null)), total_amount: "50", currency: "TND" });
      assert.equal(legacy.status, 409);
      assert.equal(legacy.body.code, "candidate_fee_prohibited");
    } finally {
      delete process.env.FIN_DEFAULT_JURISDICTION;
    }
    // without a default, a null-province candidate has no jurisdiction: legacy behaves as today
    const plain = await candidate(null);
    assert.equal((await http("POST", "/finance/invoices", T.acct, { candidate_id: plain, total_amount: "50", currency: "TND" })).status, 201);
    void q;
  }));

// ------------------------------------------------------------------------------------------------ legacy route
test("legacy POST /finance/invoices: refused for an active fee contract or a prohibited jurisdiction, otherwise unchanged", () =>
  withWorld(async ({ http, T, q, candidate, feeService, review, contract }) => {
    const svc = await feeService();
    const post = (cand, token = T.acct) => http("POST", "/finance/invoices", token, { candidate_id: cand, total_amount: "100", currency: "TND" });
    // neither applies: as today
    const plain = await candidate("ON");
    const ok = await post(plain);
    assert.equal(ok.status, 201, ok.text);
    assert.match(ok.body.number, /^VITA-\d{4}-\d{6}$/);
    // approved review only: still fine
    await review("CA-ON", "approved");
    assert.equal((await post(plain)).status, 201);
    // draft / ended / cancelled fee contracts do not block the legacy route
    for (const state of ["draft", "ended", "cancelled"]) {
      const c = await candidate("ON");
      await contract(c, svc.id, state);
      assert.equal((await post(c)).status, 201, state);
    }
    // an ACTIVE fee contract blocks it, with an invoice-less outcome
    const withContract = await candidate("ON");
    await contract(withContract, svc.id, "active");
    const blocked = await post(withContract);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "candidate_fee_use_catalogue");
    assert.equal((await q("SELECT count(*)::int n FROM invoices WHERE candidate_id=$1", [withContract])).rows[0].n, 0);
    assert.equal((await q("SELECT count(*)::int n FROM fin_ledger WHERE candidate_id=$1", [withContract])).rows[0].n, 0);
    // prohibited jurisdiction blocks even a candidate with no contract at all
    await review("CA-ON", "prohibited");
    const pr = await post(plain);
    assert.equal(pr.status, 409);
    assert.equal(pr.body.code, "candidate_fee_prohibited");
    // another province is unaffected
    assert.equal((await post(await candidate("BC"))).status, 201);
    // and the legacy route's own validation / permission answers are unchanged
    assert.equal((await post(plain, T.mgr)).status, 403);
    assert.equal((await http("POST", "/finance/invoices", T.acct, {})).status, 400);
    assert.equal((await http("POST", "/finance/invoices", T.acct, { candidate_id: 999999, total_amount: "5" })).status, 404);
  }));

// ------------------------------------------------------------------------------------------------ payments
test("payments: a NEW payment on a candidate_fee invoice is refused once the jurisdiction is prohibited; refunds, voids and other invoices are not", () =>
  withWorld(async ({ http, T, q, candidate, service, feeService, review, contract, invoice }) => {
    const fee = await feeService();
    const std = await service({ name_en: "Translation" });
    const c = await candidate("ON");
    await review("CA-ON", "approved");
    await contract(c, fee.id, "active");
    const feeInv = (await invoice(c, [line(fee.id, { unit_price: "200.00" })])).body;
    const voidable = (await invoice(c, [line(fee.id, { unit_price: "80.00" })])).body;
    const stdInv = (await invoice(c, [line(std.id, { unit_price: "50.00" })])).body;
    const pay = (invoiceId, amount, token = T.acct) => http("POST", "/finance/payments/v2", token, { invoice_id: invoiceId, amount, method: "cash" });
    const first = await pay(feeInv.id, "50.00");
    assert.equal(first.status, 201, first.text);
    // the jurisdiction becomes prohibited
    await review("CA-ON", "prohibited");
    const refusedV2 = await pay(feeInv.id, "10.00");
    assert.equal(refusedV2.status, 409);
    assert.equal(refusedV2.body.code, "candidate_fee_prohibited");
    const refusedLegacy = await http("POST", "/finance/payments", T.acct, { invoice_id: feeInv.id, amount_paid: "10" });
    assert.equal(refusedLegacy.status, 409);
    assert.equal(refusedLegacy.body.code, "candidate_fee_prohibited");
    assert.equal((await q("SELECT count(*)::int n FROM payments WHERE invoice_id=$1", [feeInv.id])).rows[0].n, 1, "no new payment row");
    assert.equal((await q("SELECT remaining_amount::text r FROM invoices WHERE id=$1", [feeInv.id])).rows[0].r, "150.00");
    // a payment on a non-fee invoice is unaffected
    assert.equal((await pay(stdInv.id, "50.00")).status, 201);
    // refunds are always allowed
    const rf = await http("POST", `/finance/payments/${first.body.payment.id}/refund`, T.acct, { amount: "50.00", reason: "refund after prohibition" });
    assert.equal(rf.status, 201, rf.text);
    // voids are always allowed (invoice with no payments, then the payment void path)
    const vi = await http("POST", `/finance/invoices/${voidable.id}/void`, T.acct, { reason: "prohibited" });
    assert.equal(vi.status, 200, vi.text);
    // a second payment voided after prohibition: record one on a fresh invoice BEFORE, then void AFTER
    const c2 = await candidate("BC");
    await review("CA-BC", "approved");
    await contract(c2, fee.id, "active");
    const inv2 = (await invoice(c2, [line(fee.id, { unit_price: "90.00" })])).body;
    const p2 = await pay(inv2.id, "90.00");
    assert.equal(p2.status, 201);
    await review("CA-BC", "prohibited");
    assert.equal((await http("POST", `/finance/payments/${p2.body.payment.id}/void`, T.acct, { reason: "reverse" })).status, 200);
    // after the void the invoice reopens but a new payment is still refused
    assert.equal((await pay(inv2.id, "10.00")).body.code, "candidate_fee_prohibited");
    // approved again: collecting is possible again
    await review("CA-BC", "approved");
    assert.equal((await pay(inv2.id, "10.00")).status, 201);
  }));

// ------------------------------------------------------------------------------------------------ billing-status
test("GET /finance/billing-status: reasons, review summary and contract for staff", () =>
  withWorld(async ({ http, T, candidate, feeService, review, contract }) => {
    const svc = await feeService();
    const c = await candidate("ON");
    const url = `/finance/billing-status?candidate_id=${c}`;
    let s = await http("GET", url, T.acct);
    assert.equal(s.status, 200, s.text);
    assert.deepEqual([s.body.candidate_fee_billable, s.body.jurisdiction, s.body.review, s.body.contract], [false, "CA-ON", null, null]);
    assert.deepEqual(s.body.reasons.sort(), ["legal_review_required", "service_contract_required"]);
    await contract(c, svc.id, "draft");
    s = await http("GET", url, T.mgr);
    assert.equal(s.body.contract.status, "draft");
    await review("CA-ON", "approved", { valid_until: "2031-01-01" });
    const k = await contract(c, svc.id, "active");
    s = await http("GET", url, T.admin);
    assert.equal(s.body.candidate_fee_billable, true);
    assert.deepEqual(s.body.reasons, []);
    assert.deepEqual(s.body.review, { status: "approved", valid_until: "2031-01-01", reviewer_name: "Me. A. Reviewer" });
    assert.equal(String(s.body.contract.id), String(k.id));
    await review("CA-ON", "prohibited");
    s = await http("GET", url, T.acct);
    assert.deepEqual([s.body.candidate_fee_billable, s.body.reasons], [false, ["candidate_fee_prohibited"]]);
    const nop = await candidate(null);
    assert.deepEqual((await http("GET", `/finance/billing-status?candidate_id=${nop}`, T.acct)).body.reasons.sort(), ["jurisdiction_unknown", "service_contract_required"]);
    assert.equal((await http("GET", "/finance/billing-status?candidate_id=999999", T.acct)).status, 404);
    assert.equal((await http("GET", "/finance/billing-status", T.acct)).status, 400);
    assert.equal((await http("GET", "/finance/billing-status?candidate_id=abc", T.acct)).status, 400);
    for (const t of ["agent", "rec", "hr", "cand", "emp", "agy"]) assert.equal((await http("GET", url, T[t])).status, 403, t);
  }));

// ------------------------------------------------------------------------------------------------ candidate view
test("GET /finance/me/contracts: the candidate sees only their own non-draft contracts, no staff data", () =>
  withWorld(async ({ http, T, q, candidate, candidateLogin, feeService, contract }) => {
    const svc = await feeService();
    const mine = await candidate("ON");
    const theirs = await candidate("ON", "Other Person");
    const tok = await candidateLogin(mine);
    const draft = await contract(mine, svc.id, "draft");
    const ended = await contract(mine, svc.id, "ended");
    const active = await contract(mine, svc.id, "active", { refund_terms: "Terms for me" });
    await contract(theirs, svc.id, "active", { refund_terms: "SECRET-OTHER-TERMS" });
    const r = await http("GET", "/finance/me/contracts", tok);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.contracts.map((x) => String(x.id)).sort(), [String(ended.id), String(active.id)].sort());
    assert.ok(!r.body.contracts.some((x) => String(x.id) === String(draft.id)), "drafts are internal");
    for (const x of r.body.contracts) {
      for (const forbidden of ["created_by", "signed_document_key", "candidate_id", "signed_by_name", "service_id", "candidate_name"]) assert.equal(x[forbidden], undefined, forbidden);
      assert.ok(["active", "ended"].includes(x.status));
    }
    assert.equal(r.body.contracts.find((x) => String(x.id) === String(active.id)).refund_terms, "Terms for me");
    assert.ok(!r.text.includes("SECRET-OTHER-TERMS"));
    // staff, portals, anonymous and an unlinked login are refused or see nothing
    for (const t of ["admin", "sa", "acct", "mgr", "agent", "emp", "agy"]) assert.equal((await http("GET", "/finance/me/contracts", T[t])).status, 403, t);
    assert.equal((await http("GET", "/finance/me/contracts", null)).status, 401);
    assert.equal((await http("GET", "/finance/me/contracts", await candidateLogin(null))).status, 404);
    // a candidate cannot reach any contract / review / billing route or write anything
    for (const [m, u, b] of [["GET", "/finance/contracts", undefined], ["POST", "/finance/contracts", {}], ["POST", `/finance/contracts/${active.id}/cancel`, {}], ["GET", "/finance/legal-reviews", undefined], ["POST", "/finance/legal-reviews", {}], ["GET", `/finance/billing-status?candidate_id=${mine}`, undefined]]) {
      assert.equal((await http(m, u, tok, b)).status, 403, `${m} ${u}`);
    }
    assert.equal((await q("SELECT status FROM fin_service_contracts WHERE id=$1", [active.id])).rows[0].status, "active");
    // the invoices self-view is unchanged by the new tables
    assert.deepEqual((await http("GET", "/finance/me", tok)).body, { invoices: [], totals: [] });
  }));

// ------------------------------------------------------------------------------------------------ review round 1
test("review round 1: a later-recorded back-dated 'prohibited' review is not masked by an older 'approved' one", () =>
  withWorld(async ({ http, T, one, candidate, feeService, review, contract, invoice }) => {
    const svc = await feeService();
    const c = await candidate("ON");
    await contract(c, svc.id, "active");
    await http("POST", "/finance/legal-reviews", T.admin, { jurisdiction: "CA-ON", status: "approved", reviewer_name: "Counsel", reviewed_at: "2029-06-01" });
    assert.equal((await invoice(c, [line(svc.id)])).status, 201);
    // recorded later, but dated EARLIER than the approval: the newest recorded review decides
    const p = await http("POST", "/finance/legal-reviews", T.admin, { jurisdiction: "CA-ON", status: "prohibited", reviewer_name: "Counsel", reviewed_at: "2028-01-01" });
    assert.equal(p.status, 201, p.text);
    assert.equal((await one("SELECT status FROM fin_legal_reviews_latest WHERE jurisdiction = 'CA-ON'")).status, "prohibited");
    const r = await invoice(c, [line(svc.id)]);
    assert.deepEqual([r.status, r.body.code], [409, "candidate_fee_prohibited"]);
    void review;
  }));

test("review round 1: a prohibited jurisdiction refuses ALL invoice creation (v2 free text, v2 standard lines, legacy), contract or not", () =>
  withWorld(async ({ http, T, q, candidate, service, feeService, review, contract, invoice }) => {
    const fee = await feeService();
    const std = await service({ name_en: "Translation" });
    const c = await candidate("QC");
    await review("CA-QC", "prohibited");
    const count = async () => (await q("SELECT count(*)::int n FROM invoices WHERE candidate_id=$1", [c])).rows[0].n;
    for (const items of [[{ description: "Package A (manual)", quantity: 1, unit_price: "250.00" }], [line(std.id)], [line(fee.id)], [line(std.id), { description: "x", quantity: 1, unit_price: "1.00" }]]) {
      const r = await invoice(c, items);
      assert.deepEqual([r.status, r.body.code], [409, "candidate_fee_prohibited"], JSON.stringify(items));
    }
    const legacy = await http("POST", "/finance/invoices", T.acct, { candidate_id: c, total_amount: "50", currency: "TND" });
    assert.deepEqual([legacy.status, legacy.body.code], [409, "candidate_fee_prohibited"]);
    assert.equal(await count(), 0, "nothing was created");
    // another province is unaffected
    const on = await candidate("ON");
    assert.equal((await invoice(on, [line(std.id)])).status, 201);
    // with an active fee contract free text stays refused for the catalogue reason once the prohibition is lifted
    await review("CA-QC", "approved");
    await contract(c, fee.id, "active");
    assert.equal((await invoice(c, [{ description: "manual", quantity: 1, unit_price: "5.00" }])).body.code, "candidate_fee_use_catalogue");
  }));

test("review round 1: the jurisdiction comes from the contract (set by staff at signing), not from the candidate's province", () =>
  withWorld(async ({ http, T, q, one, candidate, service, feeService, review, contract, invoice }) => {
    const fee = await feeService();
    const std = await service({ name_en: "Translation" });
    const c = await candidate("QC");
    // signing a candidate-fee contract needs a valid jurisdiction
    const d = await http("POST", "/finance/contracts", T.acct, { candidate_id: c, service_id: fee.id });
    for (const bad of [{}, { jurisdiction: "" }, { jurisdiction: "Quebec" }, { jurisdiction: "CA-" }, { jurisdiction: 7 }]) {
      assert.equal((await http("POST", `/finance/contracts/${d.body.id}/sign`, T.acct, { signed_by_name: "A", ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await http("GET", `/finance/contracts/${d.body.id}`, T.acct)).body.status, "draft");
    // a standard service needs no jurisdiction
    const dStd = await http("POST", "/finance/contracts", T.acct, { candidate_id: c, service_id: std.id });
    assert.equal((await http("POST", `/finance/contracts/${dStd.body.id}/sign`, T.acct, { signed_by_name: "A" })).status, 200);
    const ok = await http("POST", `/finance/contracts/${d.body.id}/sign`, T.acct, { signed_by_name: "A", jurisdiction: "ca-qc" });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.jurisdiction, "CA-QC");

    await review("CA-ON", "approved");
    // the province says ON (approved) but the CONTRACT says QC (no review recorded): not billable
    await q("UPDATE candidates SET desired_province = 'ON' WHERE id = $1", [c]);
    let r = await invoice(c, [line(fee.id)]);
    assert.deepEqual([r.status, r.body.code], [409, "legal_review_required"], "an approving review must exist for the CONTRACT jurisdiction");
    await review("CA-QC", "approved");
    assert.equal((await invoice(c, [line(fee.id)])).status, 201);
    // QC becomes prohibited: flipping the province to ON (approved) must not help, in any direction
    await review("CA-QC", "prohibited");
    for (const province of ["ON", "QC", null]) {
      await q("UPDATE candidates SET desired_province = $2 WHERE id = $1", [c, province]);
      r = await invoice(c, [line(fee.id)]);
      assert.deepEqual([r.status, r.body.code], [409, "candidate_fee_prohibited"], `province ${province}`);
      assert.equal((await invoice(c, [line(std.id)])).body.code, "candidate_fee_prohibited");
    }
    // the payment gate looks at the same set
    await review("CA-QC", "approved");
    await q("UPDATE candidates SET desired_province = 'ON' WHERE id = $1", [c]);
    const inv = await invoice(c, [line(fee.id)]);
    assert.equal(inv.status, 201, inv.text);
    await review("CA-QC", "prohibited");
    const pay = await http("POST", "/finance/payments/v2", T.acct, { invoice_id: inv.body.id, amount: "10.00", method: "cash" });
    assert.deepEqual([pay.status, pay.body.code], [409, "candidate_fee_prohibited"]);
    // billing-status reports it
    const bs = await http("GET", `/finance/billing-status?candidate_id=${c}`, T.acct);
    assert.equal(bs.body.candidate_fee_billable, false);
    assert.ok(bs.body.reasons.includes("candidate_fee_prohibited"));
    assert.equal(bs.body.jurisdiction, "CA-QC");
    void one;
  }));

test("review round 1: a contract that has not started yet is not active; the signing date cannot be in the future and an old one needs the signed paper", () =>
  withWorld(async ({ http, T, base, candidate, feeService, review, contract, invoice }) => {
    const fee = await feeService();
    const c = await candidate("ON");
    await review("CA-ON", "approved");
    await contract(c, fee.id, "active", { start_date: "2031-01-01" }); // the gate clock says 2030-06-15
    const r = await invoice(c, [line(fee.id)]);
    assert.deepEqual([r.status, r.body.code], [409, "service_contract_required"], "a contract starting in the future is not active yet");
    const c2 = await candidate("ON");
    await contract(c2, fee.id, "active", { start_date: "2030-06-15" });
    assert.equal((await invoice(c2, [line(fee.id)])).status, 201, "starting today is active");

    const c3 = await candidate("ON");
    const mk = async () => (await http("POST", "/finance/contracts", T.acct, { candidate_id: c3, service_id: fee.id })).body.id;
    const id = await mk();
    const sign = (body) => http("POST", `/finance/contracts/${id}/sign`, T.acct, { signed_by_name: "A", jurisdiction: "CA-ON", ...body });
    assert.equal((await sign({ signed_at: new Date(Date.now() + 3600e3).toISOString() })).status, 400, "future");
    const old = await sign({ signed_at: "2020-01-01T00:00:00Z" });
    assert.equal(old.status, 400, old.text);
    assert.match(old.body.error, /signed document/i);
    assert.equal((await sign({ signed_at: new Date(Date.now() - 30 * 86400e3).toISOString() })).status, 200, "30 days old: no paper needed");
    const c4 = await candidate("ON");
    const id4 = (await http("POST", "/finance/contracts", T.acct, { candidate_id: c4, service_id: fee.id })).body.id;
    const fd = new FormData();
    fd.append("signed_by_name", "A");
    fd.append("jurisdiction", "CA-ON");
    fd.append("signed_at", "2020-01-01T00:00:00Z");
    fd.append("file", new Blob([Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("old signed agreement")])]), "a.pdf");
    const withFile = await fetch(`${base}/finance/contracts/${id4}/sign`, { method: "POST", headers: { authorization: `Bearer ${T.acct}` }, body: fd });
    assert.equal(withFile.status, 200, await withFile.text());
  }));

test("migration 031: idempotent; contract jurisdiction check; the view orders by recording order", () =>
  withWorld(async ({ q, one, candidate, feeService }) => {
    const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "031_canada_review_fixes.sql"), "utf8");
    await q(sql);
    await q(sql);
    const c = await candidate();
    const s = await feeService();
    await assert.rejects(q("INSERT INTO fin_service_contracts (candidate_id, service_id, jurisdiction) VALUES ($1,$2,'ca-on')", [c, s.id]), /jurisdiction_check/);
    await q("INSERT INTO fin_service_contracts (candidate_id, service_id, jurisdiction) VALUES ($1,$2,'CA-ON')", [c, s.id]);
    await q("INSERT INTO fin_service_contracts (candidate_id, service_id) VALUES ($1,$2)", [c, s.id]); // old rows: NULL stays valid
    await q("INSERT INTO fin_legal_reviews (jurisdiction,status,reviewer_name,reviewed_at) VALUES ('TN','approved','R','2030-01-01')");
    await q("INSERT INTO fin_legal_reviews (jurisdiction,status,reviewer_name,reviewed_at) VALUES ('TN','prohibited','R','2000-01-01')");
    assert.equal((await one("SELECT status FROM fin_legal_reviews_latest WHERE jurisdiction='TN'")).status, "prohibited");
  }));
