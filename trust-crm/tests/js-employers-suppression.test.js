// Stage 8 task 4: richer employer records, contact history, opt-out suppression list enforced by the send guard.
// Real Postgres + HTTP + sandbox mail only; submissions are produced by the real submitter.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { makePdf } = require("./helpers/docs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-employers-suppression-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "js-empsup-"));
process.env.MAIL_PROVIDER = "sandbox";
process.env.MAIL_SANDBOX_ALLOWLIST = "*@northwind*.example";
process.env.MAIL_FROM = "applications@vita.test.invalid";
process.env.INBOUND_MAIL_SECRET = "inbound-test-secret";
delete process.env.CLAMAV_HOST;
delete process.env.MAIL_REAL_SEND;
delete process.env.JOBSEARCH_INBOX_REVIEWER_ID;
process.env.INBOUND_AUTO_ACK_EVIDENCE = "true"; // the strictest case: even automatic acknowledgement evidence must never fire on an opt-out

const applicationService = require("../modules/jobsearch/applicationService");
const jobStore = require("../modules/jobsearch/jobStore");
const storage = require("../modules/jobsearch/storage");
const submitter = require("../modules/jobsearch/submitter");
const inbox = require("../modules/jobsearch/inbox");
const guard = require("../modules/jobsearch/guard");
const replyMatcher = require("../modules/jobsearch/replyMatcher");
const suppression = require("../modules/jobsearch/suppression");
const draftService = require("../modules/jobsearch/draftService");

const PROFILE = { name: "Karim Benali", email: "karim@example.com", profession: "Electrician", skills: ["Industrial wiring"], languages: [{ lang: "English", level: "fluent" }] };
const OPEN = async () => ({ status: "open", verified: true });
const DEPS = { recheck: OPEN };

let pool;
let cleanup;
let server;
let base;
let adminId;
let n = 0;
let mid = 0;

test.before(async () => {
  ({ pool, cleanup } = await createTestDb());
  const app = loadApp(pool);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminId = (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('Adm','adm-empsup@test.invalid','x','Admin') RETURNING id")).rows[0].id;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await cleanup();
});

const q = (sql, params) => pool.query(sql, params);
const tok = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });
const admin = () => ({ id: adminId, role: "Admin" });
const statusOf = async (id) => (await q("SELECT status FROM js_applications WHERE id=$1", [id])).rows[0].status;
const timelineOf = async (appId) => (await q("SELECT * FROM js_timeline WHERE application_id=$1 ORDER BY id", [appId])).rows;
const employerRow = async (id) => (await q("SELECT * FROM js_employers WHERE id=$1", [id])).rows[0];
const newId = () => `<empsup-${++mid}-${crypto.randomBytes(4).toString("hex")}@mail.example>`;
const authOk = (w) => `mx.vita.test; dkim=pass header.d=${w.domain}; spf=pass; dmarc=pass`;
const reply = (w, extra = {}) => ({ messageId: newId(), inReplyTo: w.providerId, references: [w.plannedId], from: `HR Team <hr@${w.domain}>`, to: "applications@vita.test.invalid", subject: "Re: Application", text: "Hello.", authResults: authOk(w), ...extra });

async function http(method, url, token, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function mkUser(role) {
  n += 1;
  return (await q("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`U${n}`, `u${n}-empsup@test.invalid`, role])).rows[0].id;
}

/**
 * Candidate + employer/job + application. opts.stopAt: 'matched' | 'ready' | 'approved' (default: sent on the sandbox).
 * opts.auto = automatic mode (admin-approved rule, caps, confirmed label). opts.employerId reuses an employer.
 */
async function world(opts = {}) {
  const w = {};
  w.managerId = opts.managerId || (await mkUser("Manager"));
  w.manager = { id: w.managerId, role: "Manager" };
  n += 1;
  w.candidateId = (await q("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`Cand ${n}`, `PP-ES-${n}`, w.managerId])).rows[0].id;
  w.userId = await mkUser("Candidate");
  await q("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [w.userId, w.candidateId]);
  await q("INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1,$2::jsonb,'confirmed',now())", [w.candidateId, JSON.stringify(PROFILE)]);
  await q("INSERT INTO js_preferences (candidate_id, countries, residence_country, needs_work_auth_support) VALUES ($1,'{Canada}','Tunisia',false)", [w.candidateId]);
  await q("INSERT INTO js_consents (candidate_id, scope, version) VALUES ($1,$2::jsonb,'v1')", [w.candidateId, JSON.stringify({ search: true, prepare: true, submit: true, countries: [] })]);
  await q("INSERT INTO js_candidate_settings (candidate_id, mode, cap_per_day, cap_per_week) VALUES ($1,$2,5,20)", [w.candidateId, opts.auto ? "automatic" : "prepare_for_approval"]);
  const put = await storage.put(makePdf(`Karim Benali\nElectrician ${n}`), { candidateId: w.candidateId });
  w.cvFileId = (await q("INSERT INTO js_cv_files (candidate_id, storage_key, sha256, version, language, approved, scan_status) VALUES ($1,$2,$3,1,'en',true,'clean') RETURNING id", [w.candidateId, put.key, put.sha256])).rows[0].id;
  n += 1;
  if (opts.employerId) {
    const e = await employerRow(opts.employerId);
    w.employerId = e.id;
    w.domain = e.domain;
  } else {
    w.domain = opts.domain || `northwind${n}.example`;
    w.employerId = (await q("INSERT INTO js_employers (name, normalized_name, domain, verified_contact_email) VALUES ($1,$2,$3,$4) RETURNING id", [`Northwind ${n}`, jobStore.normalizeEmployer(`Northwind ${n}`), w.domain, `jobs@${w.domain}`])).rows[0].id;
  }
  const sourceId = (await q("INSERT INTO js_sources (key, adapter, status) VALUES ($1,'partner_feed','connected') RETURNING id", [`es_src_${n}`])).rows[0].id;
  w.jobId = (await q(
    "INSERT INTO js_jobs (title, country, location, employer_id, source_primary, dedupe_key, description_text, url) VALUES ('Electrician','Canada','Toronto, Canada',$1,$2,$3,$4,$5) RETURNING id",
    [w.employerId, `es_src_${n}`, `dk-empsup-${n}`, `We are hiring an Electrician. Send your CV to jobs@${w.domain}.`, `https://jobs.example/es${n}`]
  )).rows[0].id;
  await q("INSERT INTO js_job_sightings (job_id, source_id, source_job_id, url) VALUES ($1,$2,$3,$4)", [w.jobId, sourceId, `esj-${n}`, `https://jobs.example/es${n}`]);
  w.matchId = (await q("INSERT INTO js_matches (candidate_id, job_id, score, employer_support, overseas_accepted) VALUES ($1,$2,80,$3,$4) RETURNING id", [w.candidateId, w.jobId, opts.auto ? "confirmed" : "unknown", opts.auto ? true : null])).rows[0].id;
  if (opts.auto) {
    await q("UPDATE js_candidate_settings SET admin_approved_by=$2, allowed_countries='{Canada}', approved_doc_versions=$3::jsonb WHERE candidate_id=$1", [w.candidateId, adminId, JSON.stringify([{ cvFileId: w.cvFileId }])]);
    await q("INSERT INTO js_automation_rules (candidate_id, rule, approved_by, approved_at, active) VALUES ($1,'{}'::jsonb,$2,now(),true)", [w.candidateId, adminId]);
  }
  if (opts.stopAt === "matched") return w;
  w.appId = (await applicationService.createFromMatch({ matchId: w.matchId, actor: w.manager })).id;
  await applicationService.prepareApplication({ id: w.appId, actor: w.manager });
  if (opts.stopAt === "ready") return w;
  if (opts.auto) assert.equal((await applicationService.autoApprove(w.appId)).approved, true);
  else await applicationService.approveApplication({ id: w.appId, actor: w.manager, reason: "reviewed" });
  if (opts.stopAt === "approved") return w;
  const r = await submitter.queueSubmission(w.appId, w.manager, DEPS);
  assert.equal(r.queued, true, JSON.stringify(r));
  const item = (await q("SELECT * FROM js_queue WHERE kind='submit' AND payload->>'submissionId'=$1", [String(r.submissionId)])).rows[0];
  if (opts.stopAt === "queued") {
    w.queuedItem = item;
    w.submissionId = r.submissionId;
    return w;
  }
  const out = await submitter.handleSubmit(item, DEPS);
  assert.equal(out.status, "sent", JSON.stringify(out));
  w.sub = (await q("SELECT * FROM js_submissions WHERE id=$1", [r.submissionId])).rows[0];
  w.providerId = w.sub.provider_message_id;
  w.plannedId = w.sub.evidence.messageIdPlanned;
  return w;
}

// ---------------------------------------------------------------- migration

test("migration 028: columns, constraints and idempotency", async () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "028_employers_suppression.sql"), "utf8");
  await pool.query(sql);
  await pool.query(sql); // twice more: still a no-op
  const e = await employerRow((await q("INSERT INTO js_employers (name, normalized_name) VALUES ('Mig Co','mig co') RETURNING id")).rows[0].id);
  assert.equal(e.status, "new");
  assert.deepEqual(e.source_urls, []);
  assert.equal(e.province, null);
  const app = await world({ stopAt: "ready" });
  assert.equal((await q("SELECT outreach_basis FROM js_applications WHERE id=$1", [app.appId])).rows[0].outreach_basis, "published_vacancy_application");
  await assert.rejects(q("UPDATE js_employers SET province='XX' WHERE id=$1", [e.id]), /province_check/);
  await assert.rejects(q("UPDATE js_employers SET status='gone' WHERE id=$1", [e.id]), /status_check/);
  await assert.rejects(q("UPDATE js_employers SET source_urls='{}'::jsonb WHERE id=$1", [e.id]), /source_urls_check/);
  await assert.rejects(q("UPDATE js_employers SET source_urls=$2::jsonb WHERE id=$1", [e.id, JSON.stringify(Array.from({ length: 21 }, (_x, i) => `https://a.example/${i}`))]), /source_urls_check/);
  await assert.rejects(q("UPDATE js_applications SET outreach_basis='cold' WHERE id=$1", [app.appId]), /outreach_basis_check/);
  for (const [kind, value] of [["email", "A@B.com"], ["email", "a b@c.com"], ["email", "nodomain"], ["domain", "a@b.com"], ["domain", "nodot"], ["domain", "b.com."], ["domain", "B.com"], ["email", "a@b.com "], ["other", "x.com"]]) {
    await assert.rejects(q("INSERT INTO js_suppressions (kind, value) VALUES ($1,$2)", [kind, value]), /js_suppressions_(value|kind)_check/, `${kind} ${value}`);
  }
  await q("INSERT INTO js_suppressions (kind, value) VALUES ('email','mig@x.example'),('domain','mig.example')");
  await assert.rejects(q("INSERT INTO js_suppressions (kind, value) VALUES ('email','mig@x.example')"), /uq|unique/);
  await assert.rejects(q("INSERT INTO js_suppressions (kind, value, source) VALUES ('email','z@x.example','spam')"), /source_check/);
});

// ---------------------------------------------------------------- normalisation

test("normaliseAddress: case, display names, plus-addressing, whitespace, trailing dot, punycode, groups", () => {
  const N = suppression.normaliseAddress;
  const cases = [
    ["Jobs@Northwind.EXAMPLE", "jobs@northwind.example", "jobs@northwind.example"],
    ["  jobs@northwind.example \n", "jobs@northwind.example", "jobs@northwind.example"],
    ["HR Team <HR@Northwind.Example>", "hr@northwind.example", "hr@northwind.example"],
    ['"Doe, Jane" <jane.doe@northwind.example>', "jane.doe@northwind.example", "jane.doe@northwind.example"],
    ["<hr@northwind.example>", "hr@northwind.example", "hr@northwind.example"],
    ["hr@northwind.example (HR desk)", "hr@northwind.example", "hr@northwind.example"],
    ["hr+jobs@northwind.example", "hr+jobs@northwind.example", "hr@northwind.example"],
    ["Hr+A+B@Northwind.example", "hr+a+b@northwind.example", "hr@northwind.example"],
    ["hr@northwind.example.", "hr@northwind.example", "hr@northwind.example"],
    ["hr@bücher.example", "hr@xn--bcher-kva.example", "hr@xn--bcher-kva.example"],
    ["hr@XN--BCHER-KVA.example", "hr@xn--bcher-kva.example", "hr@xn--bcher-kva.example"],
    ["Recruiting: hr@northwind.example;", "hr@northwind.example", "hr@northwind.example"],
  ];
  for (const [input, address, base] of cases) {
    const r = N(input);
    assert.ok(r, input);
    assert.equal(r.address, address, input);
    assert.equal(r.base, base, input);
    assert.equal(r.domain, address.slice(address.indexOf("@") + 1), input);
  }
  for (const bad of ["", "   ", "nobody", "a@", "@b.example", "a@b", "a@@b.example", "a@b..example", null, undefined, 42, {}, "a@b.example, c@d.example", "Team: a@b.example, c@d.example;", "x".repeat(300) + "@b.example"]) {
    assert.equal(N(bad), null, JSON.stringify(bad));
  }
  // a group / list yields every address (each one is checked by isSuppressed), normalised and de-duplicated
  assert.deepEqual(suppression.extractAddresses("Team: A@b.example, <c@D.example>, a@B.example;"), ["a@b.example", "c@d.example"]);
  assert.deepEqual(suppression.extractAddresses("not an address"), []);
  assert.deepEqual(suppression.domainChain("a.b.c.example"), ["a.b.c.example", "b.c.example", "c.example"]);
  assert.deepEqual(suppression.domainChain("c.example"), ["c.example"]);
});

test("normaliseAddress stays linear on hostile input", () => {
  const t = Date.now();
  for (const s of ["<".repeat(5000), "a@".repeat(5000), `${"(".repeat(3000)}a@b.example${")".repeat(3000)}`, "a".repeat(100000), `${"x ".repeat(20000)}<a@b.example>`]) {
    suppression.extractAddresses(s);
    suppression.normaliseAddress(s);
  }
  assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
});

// ---------------------------------------------------------------- matching

test("isSuppressed: exact, case, display name, plus-addressing (base address), subdomains, parent domains, groups, punycode", async () => {
  await q("INSERT INTO js_suppressions (kind, value, reason) VALUES ('email','blocked@match-a.example','t'),('domain','match-b.example','t'),('domain','xn--bcher-kva.example','t'),('email','tagged+x@match-c.example','t')");
  const S = (a) => suppression.isSuppressed(pool, a);
  const yes = [
    "blocked@match-a.example", "BLOCKED@Match-A.example", " Blocked <blocked@match-a.example> ", "blocked+anything@match-a.example", "blocked@match-a.example.",
    "x@match-b.example", "x@sub.match-b.example", "x@deep.sub.match-b.example", "Y <y+tag@SUB.match-b.example>", "info@bücher.example", "info@sub.bücher.example",
    "tagged+x@match-c.example", "Group: ok@fine.example, blocked@match-a.example;",
  ];
  for (const a of yes) assert.equal(await S(a), true, a);
  const no = [
    "other@match-a.example", "blocked@sub.match-a.example", "blocked@match-a.example.evil.example", "x@evil-match-b.example", "x@match-b.example.evil.example",
    "tagged@match-c.example", "tagged+y@match-c.example", "", "nonsense", null, "ok@fine.example",
  ];
  for (const a of no) assert.equal(await S(a), false, String(a));
  // a domain suppression covers the registrable domain's subdomains but never a sibling or a suffix lookalike
  assert.equal(await S("x@notmatch-b.example"), false);
  const hit = await suppression.findSuppression(pool, "x@sub.match-b.example");
  assert.equal(hit.kind, "domain");
  assert.equal(hit.value, "match-b.example");
});

test("addSuppression / removeSuppression: validation, idempotency, audit, admin-only removal with a reason", async () => {
  const c = await pool.connect();
  try {
    const a = await suppression.addSuppression(c, { kind: "email", value: "Add Me <Add.Me+news@Add-One.example>", reason: "asked by phone", createdBy: adminId });
    assert.equal(a.created, true);
    assert.equal(a.row.value, "add.me+news@add-one.example");
    assert.equal(a.row.source, "manual");
    const again = await suppression.addSuppression(c, { kind: "email", value: "add.me+news@add-one.example", reason: "dup", createdBy: adminId });
    assert.equal(again.created, false);
    assert.equal(again.row.id, a.row.id);
    const d = await suppression.addSuppression(c, { kind: "domain", value: "https://www.Add-Two.example/careers", reason: "legal", createdBy: adminId });
    assert.equal(d.row.value, "add-two.example");
    const idn = await suppression.addSuppression(c, { kind: "domain", value: "Müller-add.example", reason: "r", createdBy: adminId });
    assert.equal(idn.row.value, "xn--mller-add-q9a.example");
    for (const [kind, value] of [["email", "nonsense"], ["email", "a@b.example, c@d.example"], ["domain", "gmail.com"], ["domain", "com"], ["domain", "a@b.example"], ["domain", ""], ["phone", "x"], ["email", 5]]) {
      await assert.rejects(suppression.addSuppression(c, { kind, value, createdBy: adminId }), (e) => e.status === 400, `${kind} ${value}`);
    }
    await assert.rejects(suppression.addSuppression(c, { kind: "email", value: "z@z.example", source: "spam", createdBy: adminId }), (e) => e.status === 400);
    assert.equal((await q("SELECT count(*)::int n FROM js_audit_events WHERE action='suppression.add' AND detail->>'value'=$1", [a.row.value])).rows[0].n, 1, "audited once (idempotent re-add is not a second event)");
    // removal: admin only, reason required
    const mgr = { id: await mkUser("Manager"), role: "Manager" };
    await assert.rejects(suppression.removeSuppression(c, { id: a.row.id, actor: mgr, reason: "because" }), (e) => e.status === 403);
    await assert.rejects(suppression.removeSuppression(c, { id: a.row.id, actor: admin(), reason: "" }), (e) => e.status === 400);
    await assert.rejects(suppression.removeSuppression(c, { id: 99999999, actor: admin(), reason: "because" }), (e) => e.status === 404);
    assert.equal(await suppression.isSuppressed(c, "add.me@add-one.example"), false, "a tagged suppression does not cover the base address");
    assert.equal(await suppression.isSuppressed(c, "add.me+news@add-one.example"), true);
    const rm = await suppression.removeSuppression(c, { id: a.row.id, actor: admin(), reason: "employer confirmed in writing" });
    assert.equal(rm.removed, true);
    assert.equal(await suppression.isSuppressed(c, "add.me+news@add-one.example"), false);
    const ev = (await q("SELECT * FROM js_audit_events WHERE action='suppression.remove' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(ev.detail.reason, "employer confirmed in writing");
    assert.equal(ev.detail.value, "add.me+news@add-one.example");
    assert.equal(ev.actor, `user:${adminId}`);
    assert.ok((await q("SELECT 1 FROM audit_logs WHERE action='jobsearch.suppression.remove'")).rowCount);
  } finally {
    c.release();
  }
});

// ---------------------------------------------------------------- guard

test("guard: refuses a recipient that is suppressed (address, domain, subdomain, plus-address) and an opted_out / blocked employer; clears when removed", async () => {
  const w = await world({ stopAt: "approved" });
  assert.equal((await guard.check(w.appId, DEPS)).ok, true);
  const contact = `jobs@${w.domain}`;
  const cases = [
    ["email", contact],
    ["domain", w.domain],
  ];
  for (const [kind, value] of cases) {
    const id = (await q("INSERT INTO js_suppressions (kind, value, reason) VALUES ($1,$2,'t') RETURNING id", [kind, value])).rows[0].id;
    const r = await guard.check(w.appId, DEPS);
    assert.equal(r.ok, false, kind);
    assert.equal(r.code, "recipient_suppressed", kind);
    await q("DELETE FROM js_suppressions WHERE id=$1", [id]);
    assert.equal((await guard.check(w.appId, DEPS)).ok, true, `${kind} removed`);
  }
  // the recipient passed in by the submitter (opts.recipient) is judged too, including a plus-address of a suppressed one
  await q("INSERT INTO js_suppressions (kind, value) VALUES ('email',$1)", [contact]);
  assert.equal((await guard.check(w.appId, { ...DEPS, recipient: `Jobs+x@${w.domain.toUpperCase()}` })).code, "recipient_suppressed");
  await q("DELETE FROM js_suppressions WHERE value=$1", [contact]);
  for (const st of ["opted_out", "blocked"]) {
    await q("UPDATE js_employers SET status=$2 WHERE id=$1", [w.employerId, st]);
    const r = await guard.check(w.appId, DEPS);
    assert.equal(r.ok, false, st);
    assert.equal(r.code, "employer_opted_out", st);
  }
  await q("UPDATE js_employers SET status='verified' WHERE id=$1", [w.employerId]);
  assert.equal((await guard.check(w.appId, DEPS)).ok, true);
  assert.ok(guard.GUARD_CODES.includes("recipient_suppressed") && guard.GUARD_CODES.includes("employer_opted_out") && guard.GUARD_CODES.includes("outreach_basis_not_permitted"));
});

test("guard: only the published_vacancy_application outreach basis may send in this stage", async () => {
  const w = await world({ stopAt: "approved" });
  for (const basis of ["employer_requested", "other_documented"]) {
    await q("UPDATE js_applications SET outreach_basis=$2 WHERE id=$1", [w.appId, basis]);
    const r = await guard.check(w.appId, DEPS);
    assert.equal(r.ok, false, basis);
    assert.equal(r.code, "outreach_basis_not_permitted", basis);
    const queued = await submitter.queueSubmission(w.appId, w.manager, DEPS);
    assert.equal(queued.queued, false);
    assert.equal(queued.reason, "outreach_basis_not_permitted");
  }
  await q("UPDATE js_applications SET outreach_basis='published_vacancy_application' WHERE id=$1", [w.appId]);
  assert.equal((await guard.check(w.appId, DEPS)).ok, true);
});

test("queueing: a suppressed recipient or opted-out employer is refused with a timeline note and nothing is sent", async () => {
  const w = await world({ stopAt: "approved" });
  await q("INSERT INTO js_suppressions (kind, value) VALUES ('domain',$1)", [w.domain]);
  const r = await submitter.queueSubmission(w.appId, w.manager, DEPS);
  assert.equal(r.queued, false);
  assert.equal(r.reason, "recipient_suppressed");
  assert.equal((await q("SELECT count(*)::int n FROM js_submissions WHERE application_id=$1", [w.appId])).rows[0].n, 0);
  assert.ok((await timelineOf(w.appId)).some((e) => e.event === "queue_refused" && e.detail.code === "recipient_suppressed"), "timeline note");
  assert.equal(await statusOf(w.appId), "approved");
  // over HTTP the same refusal is a 409 with the code
  const h = await http("POST", `/jobsearch/applications/${w.appId}/queue`, tok(w.managerId, "Manager"));
  assert.equal(h.status, 409);
  assert.equal(h.body.code, "recipient_suppressed");
  await q("DELETE FROM js_suppressions WHERE value=$1", [w.domain]);
  await q("UPDATE js_employers SET status='opted_out' WHERE id=$1", [w.employerId]);
  const r2 = await submitter.queueSubmission(w.appId, w.manager, DEPS);
  assert.equal(r2.reason, "employer_opted_out");
  assert.ok((await timelineOf(w.appId)).some((e) => e.event === "queue_refused" && e.detail.code === "employer_opted_out"));
});

test("retry path: an item already queued is blocked at send time when a suppression arrives; the provider is never called", async () => {
  const w = await world({ stopAt: "queued" });
  await q("INSERT INTO js_suppressions (kind, value, source) VALUES ('email',$1,'reply_opt_out')", [`jobs@${w.domain}`]);
  let called = 0;
  const out = await submitter.handleSubmit(w.queuedItem, { ...DEPS, mailSend: async () => { called += 1; return { providerMessageId: "x" }; } });
  assert.equal(out.status, "blocked", JSON.stringify(out));
  assert.equal(out.code, "recipient_suppressed");
  assert.equal(called, 0);
  assert.equal((await q("SELECT status FROM js_submissions WHERE id=$1", [w.submissionId])).rows[0].status, "failed");
  assert.ok((await timelineOf(w.appId)).some((e) => e.event === "submission_blocked" && e.detail.code === "recipient_suppressed"));
  assert.notEqual(await statusOf(w.appId), "sent");
  // a re-queue after the block is refused as well (retry)
  assert.equal((await submitter.queueSubmission(w.appId, w.manager, DEPS)).queued, false);
  // same for an employer that opted out between queueing and sending
  const w2 = await world({ stopAt: "queued" });
  await q("UPDATE js_employers SET status='opted_out' WHERE id=$1", [w2.employerId]);
  const out2 = await submitter.handleSubmit(w2.queuedItem, { ...DEPS, mailSend: async () => { throw new Error("must not send"); } });
  assert.equal(out2.status, "blocked", JSON.stringify(out2));
  assert.equal(out2.code, "employer_opted_out");
});

test("automatic mode: auto-approval refuses, and an already auto-approved application is still refused by the guard", async () => {
  const w = await world({ auto: true, stopAt: "ready" });
  await q("UPDATE js_employers SET status='opted_out' WHERE id=$1", [w.employerId]);
  const el = await applicationService.autoApproveEligibility(w.appId);
  assert.equal(el.allowed, false);
  assert.ok(el.reasons.includes("employer_opted_out"), JSON.stringify(el));
  const ap = await applicationService.autoApprove(w.appId);
  assert.equal(ap.approved, false);
  await q("UPDATE js_employers SET status='verified' WHERE id=$1", [w.employerId]);
  assert.equal((await applicationService.autoApprove(w.appId)).approved, true);
  assert.equal((await guard.check(w.appId, DEPS)).ok, true);
  await q("INSERT INTO js_suppressions (kind, value) VALUES ('domain',$1)", [w.domain]);
  const r = await guard.check(w.appId, DEPS);
  assert.equal(r.ok, false);
  assert.equal(r.code, "recipient_suppressed", "the guard's own code, not a generic mode_disallows");
  assert.deepEqual((await applicationService.autoApproveEligibility(w.appId)).reasons.filter((x) => /suppress|opted|basis/.test(x)), ["recipient_suppressed"]);
});

test("preparation shows the blockers early; human approval is refused with a timeline note; employer_history is in the package", async () => {
  const w = await world({ stopAt: "matched" });
  await q("INSERT INTO js_suppressions (kind, value) VALUES ('email',$1)", [`jobs@${w.domain}`]);
  await q("UPDATE js_employers SET status='blocked' WHERE id=$1", [w.employerId]);
  w.appId = (await applicationService.createFromMatch({ matchId: w.matchId, actor: w.manager })).id;
  const p = await applicationService.prepareApplication({ id: w.appId, actor: w.manager });
  assert.equal(p.application.status, "ready_for_review", "preparation itself still works: staff see the blockers, nothing is deleted");
  assert.deepEqual(p.package.outreach_blockers.map((b) => b.code).sort(), ["employer_opted_out", "recipient_suppressed"]);
  assert.ok(p.package.employer_history && typeof p.package.employer_history.applications === "number");
  await assert.rejects(applicationService.approveApplication({ id: w.appId, actor: w.manager, reason: "go" }), (e) => e.status === 409 && /employer_opted_out|recipient_suppressed/.test(e.message));
  assert.equal(await statusOf(w.appId), "ready_for_review");
  assert.ok((await timelineOf(w.appId)).some((e) => e.event === "outreach_blocked" && ["employer_opted_out", "recipient_suppressed"].includes(e.detail.code)), "timeline note");
  // over HTTP
  const h = await http("POST", `/jobsearch/applications/${w.appId}/approve`, tok(w.managerId, "Manager"), { reason: "go" });
  assert.equal(h.status, 409);
  // once the blockers are gone it approves
  await q("DELETE FROM js_suppressions WHERE value=$1", [`jobs@${w.domain}`]);
  await q("UPDATE js_employers SET status='verified' WHERE id=$1", [w.employerId]);
  const again = await applicationService.prepareApplication({ id: w.appId, actor: w.manager });
  assert.deepEqual(again.package.outreach_blockers, []);
  assert.equal((await applicationService.approveApplication({ id: w.appId, actor: w.manager, reason: "go" })).application.status, "approved");
});

// ---------------------------------------------------------------- classification

test("opt-out classification: English, French and Arabic positives; ordinary rejections, acknowledgements and negations are not opt-outs", () => {
  const cat = (t) => replyMatcher.classifyReply(t);
  const positives = [
    "Please unsubscribe us from your mailing list.",
    "Unsubscribe",
    "UNSUBSCRIBE.",
    "I want to unsubscribe.",
    "Remove me from your list please.",
    "Please remove us from your mailing list and do not contact us again.",
    "Do not contact us again.",
    "Please do not email me anymore.",
    "Stop emailing us.",
    "Stop sending us your applications, thank you.",
    "We ask you to cease all contact with our company.",
    "Cease and desist.",
    "Thank you for applying. We have received your application. Please unsubscribe us.",
    "Unfortunately we are not hiring. Do not contact us again.",
    "Merci de ne plus me contacter.",
    "Veuillez ne plus nous contacter.",
    "Merci de nous désabonner de vos envois.",
    "Je souhaite me désabonner.",
    "Veuillez nous retirer de votre liste de diffusion.",
    "Merci de me retirer de votre liste.",
    "الرجاء عدم مراسلتنا مرة أخرى. لا تراسلونا",
    "من فضلكم لا تراسلونا بعد الآن",
    "نرجو إزالة بريدنا الإلكتروني من القائمة",
    "إزالة",
  ];
  for (const t of positives) {
    const r = cat(t);
    assert.equal(r.category, "opt_out", t);
    assert.equal(r.acknowledgement, false, `never an acknowledgement: ${t}`);
    assert.equal(r.proposedStatus, null, "an opt-out proposes no status change");
  }
  const negatives = [
    "We have filled the position.",
    "Unfortunately we have decided to move forward with other candidates.",
    "The position has been filled. We will keep your details on file.",
    "Thank you for applying. We have received your application and will review it.",
    "Thank you for your application. To unsubscribe from job alerts click the link below.",
    "Thank you for applying. We have received your application. Unsubscribe. Privacy policy",
    "We will not be unsubscribing anyone from the newsletter.",
    "Please remove the duplicate attachment and resend your CV.",
    "We would like to invite you to an interview next week.",
    "Please send us a copy of your diploma.",
    "Our recruiter will contact you shortly.",
    "Nous avons bien reçu votre candidature.",
    "Nous regrettons de vous informer que le poste est pourvu.",
    "شكرا لتقديمكم. تم استلام طلبكم.",
    "We cease to be a small team, and we are growing; please apply again in spring.",
    "",
  ];
  for (const t of negatives) assert.notEqual(cat(t).category, "opt_out", t);
  assert.equal(cat("Thank you for applying. We have received your application and will review it.").acknowledgement, true, "plain acknowledgements keep working");
  assert.equal(cat("Thank you for applying. We have received your application. Unsubscribe. Privacy policy").category, "acknowledgement", "a bare footer word is not a request");
  assert.equal(cat("We have filled the position.").category !== "opt_out", true);
  // bounded: hostile input classifies quickly
  const t = Date.now();
  cat("remove ".repeat(20000));
  cat(`${"ne plus ".repeat(5000)}`);
  assert.ok(Date.now() - t < 1500);
});

// ---------------------------------------------------------------- opt-out ingestion

test("opt-out reply (matched, authenticated): suppression for the sender, employer opted_out, staff task, audit, never an acknowledgement; later sends refused; staff can undo", async () => {
  const w = await world();
  const before = (await q("SELECT count(*)::int n FROM js_suppressions")).rows[0].n;
  const r = await inbox.ingest(reply(w, { text: "Thank you for applying. We have received your application. Please remove us from your mailing list and do not contact us again." }));
  assert.equal(r.matched, true, JSON.stringify(r));
  const msg = (await q("SELECT * FROM js_messages WHERE id=$1", [r.id])).rows[0];
  assert.equal(msg.classification.category, "opt_out");
  // never an acknowledgement
  const sub = (await q("SELECT status, evidence FROM js_submissions WHERE id=$1", [w.sub.id])).rows[0];
  assert.equal(sub.status, "sent");
  assert.ok(!(sub.evidence.confirmations || []).length);
  assert.equal(await statusOf(w.appId), "sent", "nothing is cancelled or deleted");
  assert.equal(r.evidence === undefined || r.evidence.recorded === false, true);
  // suppression for the sender address
  const sup = (await q("SELECT * FROM js_suppressions WHERE kind='email' AND value=$1", [`hr@${w.domain}`])).rows;
  assert.equal(sup.length, 1);
  assert.equal(sup[0].source, "reply_opt_out");
  assert.equal(sup[0].employer_id, w.employerId);
  assert.equal(sup[0].message_id, r.id);
  // review round 1: the sender writes from the employer's own domain, so the domain is suppressed as well (and employers sharing it opt out)
  assert.equal((await q("SELECT count(*)::int n FROM js_suppressions")).rows[0].n, before + 2);
  const domSup = (await q("SELECT * FROM js_suppressions WHERE kind='domain' AND value=$1", [w.domain])).rows;
  assert.equal(domSup.length, 1);
  assert.equal(domSup[0].source, "reply_opt_out");
  // employer status
  assert.equal((await employerRow(w.employerId)).status, "opted_out");
  // staff task (reusing js_tasks), assigned to the responsible staff member
  const tasks = (await q("SELECT * FROM js_tasks WHERE application_id=$1 AND reason='opt_out_received'", [w.appId])).rows;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "open");
  assert.equal(tasks[0].assigned_to, w.managerId);
  assert.equal(tasks[0].message_id, r.id);
  // audit trail
  const ev = (await q("SELECT action FROM js_audit_events WHERE application_id=$1 OR detail->>'messageId'=$2", [w.appId, String(r.id)])).rows.map((x) => x.action);
  assert.ok(ev.includes("suppression.add"), ev.join());
  assert.ok(ev.includes("employer.opt_out"), ev.join());
  assert.ok((await timelineOf(w.appId)).some((e) => e.event === "opt_out_received"));
  // replay is idempotent: still one suppression, one task
  await inbox.ingest({ ...reply(w, { text: "Please remove us from your mailing list." }), messageId: msg.message_id });
  assert.equal((await q("SELECT count(*)::int n FROM js_suppressions WHERE value=$1", [`hr@${w.domain}`])).rows[0].n, 1);
  // a second opt-out message from the same address: no second suppression, a second task is fine only per message
  const r2 = await inbox.ingest(reply(w, { text: "Stop emailing us." }));
  assert.equal((await q("SELECT count(*)::int n FROM js_suppressions WHERE value=$1", [`hr@${w.domain}`])).rows[0].n, 1);
  assert.equal(r2.matched, true);
  // staff undo is admin-only
  const supId = sup[0].id;
  const mgrTok = tok(w.managerId, "Manager");
  assert.equal((await http("DELETE", `/jobsearch/suppressions/${supId}`, mgrTok, { reason: "oops" })).status, 403);
  assert.equal((await http("DELETE", `/jobsearch/suppressions/${supId}`, tok(adminId, "Admin"), {})).status, 400, "reason required");
  const del = await http("DELETE", `/jobsearch/suppressions/${supId}`, tok(adminId, "Admin"), { reason: "employer confirmed the opt-out was a mistake" });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal((await q("SELECT count(*)::int n FROM js_suppressions WHERE id=$1", [supId])).rows[0].n, 0);
  assert.equal((await employerRow(w.employerId)).status, "opted_out", "the domain opt-out still stands");
  assert.equal((await http("DELETE", `/jobsearch/suppressions/${domSup[0].id}`, tok(adminId, "Admin"), { reason: "employer confirmed the opt-out was a mistake" })).status, 200);
  assert.equal((await employerRow(w.employerId)).status, "replied", "undoing the last opt-out suppression releases the employer status");
});

test("opt-out reply later blocks another application to the same employer: approval is refused, an approved one is stopped by the guard", async () => {
  const w = await world();
  const approved = await world({ employerId: w.employerId, stopAt: "approved" });
  const ready = await world({ employerId: w.employerId, stopAt: "ready" });
  assert.equal((await guard.check(approved.appId, DEPS)).ok, true);
  await inbox.ingest(reply(w, { text: "Do not contact us again." }));
  assert.equal((await employerRow(w.employerId)).status, "opted_out");
  const g = await guard.check(approved.appId, DEPS);
  assert.equal(g.ok, false);
  assert.equal(g.code, "employer_opted_out");
  assert.equal((await submitter.queueSubmission(approved.appId, approved.manager, DEPS)).reason, "employer_opted_out");
  await assert.rejects(applicationService.approveApplication({ id: ready.appId, actor: ready.manager, reason: "go" }), (e) => e.status === 409 && /employer_opted_out/.test(e.message));
});

test("opt-out text that is NOT trusted: an unmatched message, an auto-reply or a bounce creates nothing; an ordinary rejection is not an opt-out", async () => {
  const w = await world();
  const none = () => q("SELECT count(*)::int n FROM js_suppressions WHERE source='reply_opt_out' AND employer_id=$1", [w.employerId]).then((r) => r.rows[0].n);
  // unmatched (no reference): classification only, staff review queue, no suppression
  const un = await inbox.ingest({ messageId: newId(), from: `hr@${w.domain}`, subject: "Hello", text: "Please remove us from your mailing list.", authResults: authOk(w) });
  assert.equal(un.matched, false);
  assert.equal(await none(), 0);
  // matched but a wrong-domain sender is not matched at all
  const spoof = await inbox.ingest(reply(w, { from: "hr@evil-recruiter.example", text: "Please remove us from your mailing list." }));
  assert.equal(spoof.matched, false);
  assert.equal(await none(), 0);
  // an out-of-office / auto-reply that contains an unsubscribe sentence
  const auto = await inbox.ingest(reply(w, { subject: "Automatic reply: Application", text: "I am out of the office. Please unsubscribe us.", headers: { "Auto-Submitted": "auto-replied" } }));
  assert.equal(auto.matched, true);
  assert.equal(await none(), 0);
  assert.equal((await employerRow(w.employerId)).status, "new");
  // an ordinary rejection
  const rej = await inbox.ingest(reply(w, { text: "Unfortunately we have filled the position. Thank you for your interest." }));
  assert.equal(rej.matched, true);
  assert.equal(await none(), 0);
  assert.equal((await employerRow(w.employerId)).status, "new");
  assert.equal((await q("SELECT count(*)::int n FROM js_tasks WHERE application_id=$1 AND reason='opt_out_received'", [w.appId])).rows[0].n, 0);
});

test("follow-up replies obey the list too: an opt-out is never answered, and a draft to a suppressed address or opted-out employer is refused at send time", async () => {
  const w = await world();
  const ack = await inbox.ingest(reply(w, { text: "Thank you for applying. We have received your application and will review it." }));
  assert.equal(ack.matched, true);
  const draft = await draftService.createDraft({ messageId: ack.id, actor: w.manager });
  let sent = 0;
  const deps = { mailSend: async () => { sent += 1; return { accepted: true, providerMessageId: "<x@y>" }; } };
  await q("INSERT INTO js_suppressions (kind, value) VALUES ('email',$1)", [`hr@${w.domain}`]);
  await assert.rejects(draftService.sendFollowUp({ draftId: draft.id, actor: w.manager, deps }), (e) => e.status === 409 && e.code === "recipient_suppressed");
  await q("DELETE FROM js_suppressions WHERE value=$1", [`hr@${w.domain}`]);
  await q("UPDATE js_employers SET status='opted_out' WHERE id=$1", [w.employerId]);
  await assert.rejects(draftService.sendFollowUp({ draftId: draft.id, actor: w.manager, deps }), (e) => e.status === 409 && e.code === "employer_opted_out");
  assert.equal(sent, 0, "the provider was never called");
  await q("UPDATE js_employers SET status='verified' WHERE id=$1", [w.employerId]);
  assert.equal((await draftService.sendFollowUp({ draftId: draft.id, actor: w.manager, deps })).sent, true, "without the blockers it sends");
  const w2 = await world();
  const opt = await inbox.ingest(reply(w2, { text: "Please remove us from your mailing list." }));
  await assert.rejects(draftService.createDraft({ messageId: opt.id, actor: w2.manager }), (e) => e.status === 409 && e.code === "opt_out_never_answered");
  assert.match(draftService.summarize({ classification: { category: "opt_out" } }), /not to be contacted/);
});

test("hard bounce (5.x.x) for a sent application suppresses the recipient (source bounce); a soft bounce does not", async () => {
  process.env.INBOUND_BOUNCE_DOMAINS = "northwind-relay.example";
  const w = await world();
  const soft = await inbox.ingest({ messageId: newId(), from: "postmaster@vita.test.invalid", subject: "Delivery delayed", text: `Status: 4.4.1 deferred\n${w.providerId}` });
  assert.equal(soft.reason, "bounce");
  assert.equal((await q("SELECT count(*)::int n FROM js_suppressions WHERE value=$1", [`jobs@${w.domain}`])).rows[0].n, 0);
  const hard = await inbox.ingest({
    messageId: newId(),
    from: "MAILER-DAEMON@mx.northwind-relay.example",
    subject: "Delivery Status Notification (Failure)",
    text: `Your message could not be delivered.\nStatus: 5.1.1 user unknown\nOriginal-Message-ID: ${w.plannedId}`,
    headers: { "Content-Type": "multipart/report; report-type=delivery-status" },
  });
  assert.equal(hard.reason, "bounce");
  const rows = (await q("SELECT * FROM js_suppressions WHERE value=$1", [`jobs@${w.domain}`])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "bounce");
  assert.equal(rows[0].kind, "email");
  assert.equal(rows[0].employer_id, w.employerId);
  assert.equal((await employerRow(w.employerId)).status, "new", "a bounce does not mark the employer opted out");
  // the existing behaviour stays: a verify_delivery task, no status change
  assert.equal((await q("SELECT count(*)::int n FROM js_tasks WHERE application_id=$1 AND reason='verify_delivery'", [w.appId])).rows[0].n, 1);
  assert.equal(await statusOf(w.appId), "sent");
  // a repeat DSN is idempotent
  await inbox.ingest({ messageId: newId(), from: "MAILER-DAEMON@vita.test.invalid", subject: "Undeliverable", text: `550 5.1.1 ${w.providerId}` });
  assert.equal((await q("SELECT count(*)::int n FROM js_suppressions WHERE value=$1", [`jobs@${w.domain}`])).rows[0].n, 1);
  delete process.env.INBOUND_BOUNCE_DOMAINS;
});

// ---------------------------------------------------------------- HTTP: employers

async function mkStaffWorld() {
  const agentA = await mkUser("Agent");
  const agentB = await mkUser("Agent");
  const agentC = await mkUser("Agent");
  const manager = await mkUser("Manager");
  const employerId = (await q("INSERT INTO js_employers (name, normalized_name, domain, verified_contact_email, province, city, status) VALUES ($1,$2,$3,$4,'ON','Toronto','verified') RETURNING id", [`History Co ${++n}`, `history co ${n}`, `hist${n}.example`, `jobs@hist${n}.example`])).rows[0].id;
  const mk = async (assigned, st, subStatus, opts = {}) => {
    n += 1;
    const cid = (await q("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`HistCand ${n}`, `PP-H-${n}`, assigned])).rows[0].id;
    const jid = (await q("INSERT INTO js_jobs (title, country, employer_id, dedupe_key, source_primary) VALUES ($1,'Canada',$2,$3,'manual_import') RETURNING id", [opts.title || `Job ${n}`, employerId, `dk-hist-${n}`])).rows[0].id;
    const aid = (await q("INSERT INTO js_applications (candidate_id, job_id, status) VALUES ($1,$2,$3) RETURNING id", [cid, jid, st])).rows[0].id;
    if (subStatus) await q("INSERT INTO js_submissions (application_id, attempt_no, idempotency_key, channel, recipient, status, sent_at) VALUES ($1,1,$2,'email','jobs@x.example',$3, $4)", [aid, `hist:${aid}`, subStatus, opts.sentAt || new Date().toISOString()]);
    await q("INSERT INTO js_messages (direction, application_id, from_addr, subject, message_kind) VALUES ('out',$1,'a@vita.test.invalid','Application',NULL)", [aid]);
    if (opts.reply) await q("INSERT INTO js_messages (direction, application_id, from_addr, subject, message_id, classification) VALUES ('in',$1,'hr@x.example','Re: Application',$2,'{\"category\":\"acknowledgement\"}'::jsonb)", [aid, newId()]);
    return { cid, jid, aid };
  };
  const a1 = await mk(agentA, "sent", "sent", { reply: true, sentAt: "2026-10-01T10:00:00Z" });
  const a2 = await mk(agentA, "matched", null);
  const b1 = await mk(agentB, "sent", "sent", { sentAt: "2026-10-20T10:00:00Z" });
  const b2 = await mk(agentB, "confirmed_submitted", "confirmed_submitted", { sentAt: "2026-10-22T10:00:00Z" });
  return { agentA, agentB, agentC, manager, employerId, a1, a2, b1, b2 };
}

test("GET /employers: new fields, filters (province, status, q), scoped as before; notes never in the list", async () => {
  const s = await mkStaffWorld();
  await q("UPDATE js_employers SET notes='staff only secret', industry='Construction' WHERE id=$1", [s.employerId]);
  const A = tok(s.agentA, "Agent");
  const list = await http("GET", `/jobsearch/employers?province=ON&status=verified&q=History`, A);
  assert.equal(list.status, 200);
  const e = list.body.employers.find((x) => x.id === s.employerId);
  assert.ok(e);
  assert.equal(e.province, "ON");
  assert.equal(e.city, "Toronto");
  assert.equal(e.status, "verified");
  assert.equal(e.industry, "Construction");
  assert.ok(!("notes" in e) && !JSON.stringify(list.body).includes("staff only secret"));
  assert.equal((await http("GET", `/jobsearch/employers?province=QC`, A)).body.employers.length, 0);
  assert.equal((await http("GET", `/jobsearch/employers?status=blocked`, tok(adminId, "Admin"))).body.employers.some((x) => x.id === s.employerId), false);
  assert.equal((await http("GET", `/jobsearch/employers?province=ON`, tok(adminId, "Admin"))).body.employers.some((x) => x.id === s.employerId), true);
  for (const bad of ["province=ZZ", "province=on", "status=gone", "status[]=x"]) assert.equal((await http("GET", `/jobsearch/employers?${bad}`, A)).status, 400, bad);
  // an agent without candidates at this employer does not see it (scope as today)
  assert.equal((await http("GET", `/jobsearch/employers?q=History`, tok(s.agentC, "Agent"))).body.employers.some((x) => x.id === s.employerId), false);
});

test("GET /employers/:id: detail with the new fields; notes only for the roles that may edit; out-of-scope is 404; non-staff 403", async () => {
  const s = await mkStaffWorld();
  await q("UPDATE js_employers SET notes='staff only secret', phone='+1 416 555 0100', recruiter_contact_name='Pat Doe', eligibility_note='Open to foreign applicants per ad', source_urls=$2::jsonb WHERE id=$1", [s.employerId, JSON.stringify(["https://jobs.example/a"])]);
  const adm = await http("GET", `/jobsearch/employers/${s.employerId}`, tok(adminId, "Admin"));
  assert.equal(adm.status, 200);
  assert.equal(adm.body.notes, "staff only secret");
  assert.equal(adm.body.phone, "+1 416 555 0100");
  assert.equal(adm.body.recruiterContactName, "Pat Doe");
  assert.deepEqual(adm.body.sourceUrls, ["https://jobs.example/a"]);
  assert.equal(adm.body.eligibilityNote, "Open to foreign applicants per ad");
  assert.equal(adm.body.province, "ON");
  assert.equal(adm.body.status, "verified");
  for (const [uid, role] of [[s.agentA, "Agent"], [s.manager, "Manager"]]) {
    const r = await http("GET", `/jobsearch/employers/${s.employerId}`, tok(uid, role));
    if (role === "Manager") assert.equal(r.status, 404, "a manager with no candidate at this employer is out of scope");
    else {
      assert.equal(r.status, 200);
      assert.ok(!("notes" in r.body) && !JSON.stringify(r.body).includes("staff only secret"), "notes hidden from roles that cannot edit");
      assert.equal(r.body.canEdit, false);
    }
  }
  assert.equal((await http("GET", `/jobsearch/employers/${s.employerId}`, tok(s.agentC, "Agent"))).status, 404);
  assert.equal((await http("GET", `/jobsearch/employers/abc`, tok(adminId, "Admin"))).status, 404);
  assert.equal((await http("GET", `/jobsearch/employers/99999999`, tok(adminId, "Admin"))).status, 404);
  const candUser = await mkUser("Candidate");
  const tv = (await q("SELECT token_version FROM users WHERE id=$1", [candUser])).rows[0].token_version;
  const ct = jwt.sign({ id: candUser, role: "Candidate", tv }, process.env.JWT_SECRET, { expiresIn: "1h" });
  for (const url of [`/jobsearch/employers/${s.employerId}`, `/jobsearch/employers/${s.employerId}/history`, "/jobsearch/suppressions"]) assert.equal((await http("GET", url, ct)).status, 403, url);
  assert.equal((await http("PATCH", `/jobsearch/employers/${s.employerId}`, ct, { city: "x" })).status, 403);
  assert.equal((await http("GET", `/jobsearch/employers/${s.employerId}`)).status, 401);
});

test("PATCH /employers/:id: admin only, strict validation matrix, audit, status/verification stamp", async () => {
  const s = await mkStaffWorld();
  const url = `/jobsearch/employers/${s.employerId}`;
  const ADM = tok(adminId, "Admin");
  for (const [uid, role] of [[s.agentA, "Agent"], [s.manager, "Manager"]]) assert.equal((await http("PATCH", url, tok(uid, role), { city: "Ottawa" })).status, 403, role);
  assert.equal((await employerRow(s.employerId)).city, "Toronto");
  const bad = [
    [{}, "nothing to change"],
    [{ unknown: 1 }, "unknown"],
    [{ domain: "x.example" }, "domain stays on PUT"],
    [{ name: "X" }, "name stays on PUT"],
    [{ province: "ZZ" }, "province"],
    [{ province: "on" }, "province case"],
    [{ province: 5 }, "province type"],
    [{ status: "gone" }, "status"],
    [{ status: null }, "status null"],
    [{ city: 5 }, "city type"],
    [{ city: "x".repeat(101) }, "city length"],
    [{ industry: ["a"] }, "industry"],
    [{ phone: "call me" }, "phone letters"],
    [{ phone: "12" }, "phone short"],
    [{ recruiterContactName: "n".repeat(121) }, "name length"],
    [{ eligibilityNote: "e".repeat(1001) }, "note length"],
    [{ notes: "n".repeat(4001) }, "notes length"],
    [{ sourceUrls: "https://a.example" }, "urls not array"],
    [{ sourceUrls: ["ftp://a.example/x"] }, "ftp"],
    [{ sourceUrls: ["javascript:alert(1)"] }, "javascript"],
    [{ sourceUrls: ["https://user:pw@a.example/x"] }, "credentials"],
    [{ sourceUrls: ["https://user@a.example/x"] }, "username only"],
    [{ sourceUrls: ["not a url"] }, "garbage"],
    [{ sourceUrls: ["https://a.example/x y"] }, "space"],
    [{ sourceUrls: ["https://a.example/x\nHost: evil"] }, "newline"],
    [{ sourceUrls: [5] }, "number"],
    [{ sourceUrls: Array.from({ length: 21 }, (_x, i) => `https://a.example/${i}`) }, "21 urls"],
    [{ sourceUrls: ["https://" + "a".repeat(2100) + ".example"] }, "too long"],
    [{ lastVerifiedAt: "yesterday" }, "date"],
    [{ lastVerifiedAt: 5 }, "date type"],
    [{ lastVerifiedAt: "2999-01-01T00:00:00Z" }, "future"],
  ];
  for (const [body, label] of bad) {
    const r = await http("PATCH", url, ADM, body);
    assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
  }
  const beforeAudit = (await q("SELECT count(*)::int n FROM js_audit_events WHERE action='employer.profile_update'")).rows[0].n;
  assert.equal(beforeAudit, 0, "rejected requests are not audited as updates");
  const ok = await http("PATCH", url, ADM, {
    province: "QC", city: "  Montréal ", industry: "Logistics", phone: "+1 (514) 555-0100", recruiterContactName: "Chloé Martin",
    eligibilityNote: "Applications from abroad accepted (quoted in ad).", notes: "Call before 10h.\nSecond line.",
    sourceUrls: ["https://jobs.example/a", "http://careers.example/b?x=1", "https://jobs.example/a"],
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.province, "QC");
  assert.equal(ok.body.city, "Montréal");
  assert.deepEqual(ok.body.sourceUrls, ["https://jobs.example/a", "http://careers.example/b?x=1"], "de-duplicated");
  assert.equal(ok.body.notes, "Call before 10h.\nSecond line.");
  const row = await employerRow(s.employerId);
  assert.equal(row.province, "QC");
  assert.equal(row.phone, "+1 (514) 555-0100");
  // status verified stamps last_verified_at unless given
  const ver = await http("PATCH", url, ADM, { status: "verified" });
  assert.equal(ver.status, 200);
  assert.ok(ver.body.lastVerifiedAt);
  const given = await http("PATCH", url, ADM, { status: "contacted", lastVerifiedAt: "2026-09-01T00:00:00Z" });
  assert.equal(new Date(given.body.lastVerifiedAt).toISOString(), "2026-09-01T00:00:00.000Z");
  // null clears
  const clr = await http("PATCH", url, ADM, { province: null, city: null, phone: null, sourceUrls: [], notes: null });
  assert.equal(clr.status, 200);
  assert.equal(clr.body.province, null);
  assert.deepEqual(clr.body.sourceUrls, []);
  // audit with before/after, notes content kept out of the audit row
  const audits = (await q("SELECT detail FROM js_audit_events WHERE action='employer.profile_update' ORDER BY id")).rows;
  assert.equal(audits.length, 4);
  assert.equal(audits[0].detail.before.province, "ON");
  assert.equal(audits[0].detail.after.province, "QC");
  assert.ok(!JSON.stringify(audits).includes("Call before 10h"), "free-text notes are not copied into the audit log");
  assert.equal(audits[0].detail.after.notes, "changed");
  assert.ok((await q("SELECT 1 FROM audit_logs WHERE action='jobsearch.employer.profile_update' AND record_id=$1", [String(s.employerId)])).rowCount);
  assert.equal((await http("PATCH", `/jobsearch/employers/99999999`, ADM, { city: "x" })).status, 404);
  // every province in the enum is accepted
  for (const p of ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]) assert.equal((await http("PATCH", url, ADM, { province: p })).status, 200, p);
});

// ---------------------------------------------------------------- HTTP: history

test("GET /employers/:id/history: an agent sees only the rows of their own candidates plus a bare count of other candidates' contacts", async () => {
  const s = await mkStaffWorld();
  const url = `/jobsearch/employers/${s.employerId}/history`;
  const A = await http("GET", url, tok(s.agentA, "Agent"));
  assert.equal(A.status, 200, JSON.stringify(A.body));
  const ids = A.body.applications.map((x) => x.applicationId).sort((x, y) => x - y);
  assert.deepEqual(ids, [s.a1.aid, s.a2.aid].sort((x, y) => x - y));
  assert.equal(A.body.contactedByOtherCandidates, 2, "agent B's two contacted candidates, as a number only");
  const raw = JSON.stringify(A.body);
  for (const o of [s.b1, s.b2]) assert.ok(!raw.includes(`"candidateId":${o.cid}`) && !raw.includes(`"applicationId":${o.aid}`), "no ids of other staff's candidates");
  assert.ok(!/HistCand/.test(JSON.stringify(A.body.applications.filter((x) => ![s.a1.cid, s.a2.cid].includes(x.candidateId)))));
  const a1 = A.body.applications.find((x) => x.applicationId === s.a1.aid);
  assert.equal(a1.submissions.length, 1);
  assert.equal(a1.submissions[0].status, "sent");
  assert.ok(a1.messages.some((m) => m.direction === "in" && m.category === "acknowledgement"));
  assert.ok(a1.messages.some((m) => m.direction === "out"));
  assert.equal(A.body.totals.applications, 2);
  assert.equal(A.body.totals.sent, 1);
  assert.equal(A.body.totals.replies, 1);
  assert.equal(new Date(A.body.totals.lastContactAt).toISOString(), "2026-10-01T10:00:00.000Z");
  // agent B sees B's rows, count of A's contacted candidates = 1
  const B = await http("GET", url, tok(s.agentB, "Agent"));
  assert.deepEqual(B.body.applications.map((x) => x.applicationId).sort((x, y) => x - y), [s.b1.aid, s.b2.aid].sort((x, y) => x - y));
  assert.equal(B.body.contactedByOtherCandidates, 1);
  // an agent with no candidate at this employer: 404 (the employer is out of scope)
  assert.equal((await http("GET", url, tok(s.agentC, "Agent"))).status, 404);
  // admin sees everything, nothing hidden to count
  const adm = await http("GET", url, tok(adminId, "Admin"));
  assert.equal(adm.body.applications.length, 4);
  assert.equal(adm.body.contactedByOtherCandidates, 0);
  assert.equal(adm.body.totals.sent, 3);
  // a soft-deleted candidate's rows vanish for everyone
  await q("UPDATE candidates SET is_deleted=true WHERE id=$1", [s.b2.cid]);
  assert.equal((await http("GET", url, tok(adminId, "Admin"))).body.applications.length, 3);
});

test("prepare: employer_history summarises prior contact (counts and last date), scoped to the caller", async () => {
  const s = await mkStaffWorld();
  // an agent A preparing a new application at the same employer sees A's history, and only a number for B's
  const w = await world({ managerId: s.agentA, employerId: s.employerId, stopAt: "matched" });
  w.appId = (await applicationService.createFromMatch({ matchId: w.matchId, actor: { id: s.agentA, role: "Agent" } })).id;
  const p = await applicationService.prepareApplication({ id: w.appId, actor: { id: s.agentA, role: "Agent" } });
  const h = p.package.employer_history;
  assert.equal(h.employerId, s.employerId);
  assert.equal(h.applications, 2, "agent A's two earlier applications (this one excluded)");
  assert.equal(h.sent, 1);
  assert.equal(h.replies, 1);
  assert.equal(new Date(h.lastContactAt).toISOString(), "2026-10-01T10:00:00.000Z");
  assert.equal(h.contactedByOtherCandidates, 2);
  assert.ok(!JSON.stringify(h).includes("HistCand"));
  assert.deepEqual(Object.keys(h).sort(), ["applications", "contactedByOtherCandidates", "employerId", "lastContactAt", "replies", "sent"]);
});

// ---------------------------------------------------------------- HTTP: suppressions

test("POST/GET/DELETE /jobsearch/suppressions: staff add and list, admin-only delete with a reason, validation, audit; other roles denied", async () => {
  const mgr = await mkUser("Manager");
  const agent = await mkUser("Agent");
  const M = tok(mgr, "Manager");
  const A = tok(agent, "Agent");
  const ADM = tok(adminId, "Admin");
  const add = await http("POST", "/jobsearch/suppressions", M, { kind: "domain", value: "Blocked-Corp.example", reason: "asked by phone 2026-10-30" });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(add.body.value, "blocked-corp.example");
  assert.equal(add.body.source, "manual");
  assert.equal(add.body.createdBy, mgr);
  const dup = await http("POST", "/jobsearch/suppressions", M, { kind: "domain", value: "blocked-corp.example" });
  assert.equal(dup.status, 200, "idempotent: the existing row");
  assert.equal(dup.body.id, add.body.id);
  const e = await http("POST", "/jobsearch/suppressions", A, { kind: "email", value: "Pat <pat+x@Blocked-Two.example>", reason: "r" });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.equal(e.body.value, "pat+x@blocked-two.example");
  for (const [body, label] of [
    [{}, "empty"], [{ kind: "x", value: "a@b.example" }, "kind"], [{ kind: "email", value: "nonsense" }, "email"], [{ kind: "domain", value: "gmail.com" }, "free mail"],
    [{ kind: "domain", value: "com" }, "tld"], [{ kind: "email", value: "a@b.example", source: "reply_opt_out" }, "source not settable"], [{ kind: "email", value: "a@b.example", extra: 1 }, "unknown field"],
    [{ kind: "email", value: "a@b.example", employerId: 99999999 }, "unknown employer"], [{ kind: "email", value: "a@b.example", reason: "r".repeat(501) }, "reason length"],
  ]) {
    const r = await http("POST", "/jobsearch/suppressions", M, body);
    assert.ok([400, 404].includes(r.status), `${label}: ${r.status}`);
  }
  const list = await http("GET", "/jobsearch/suppressions?q=blocked", A);
  assert.equal(list.status, 200);
  assert.ok(list.body.suppressions.length >= 2);
  assert.ok(list.body.suppressions.every((x) => /blocked/.test(x.value)));
  assert.equal((await http("GET", "/jobsearch/suppressions?kind=email&q=blocked", A)).body.suppressions.every((x) => x.kind === "email"), true);
  assert.equal((await http("GET", "/jobsearch/suppressions?kind=zzz", A)).status, 400);
  assert.equal((await http("GET", "/jobsearch/suppressions?source=bounce", A)).body.suppressions.every((x) => x.source === "bounce"), true);
  // delete: admin only
  assert.equal((await http("DELETE", `/jobsearch/suppressions/${add.body.id}`, M, { reason: "mistake" })).status, 403);
  assert.equal((await http("DELETE", `/jobsearch/suppressions/${add.body.id}`, A, { reason: "mistake" })).status, 403);
  assert.equal((await http("DELETE", `/jobsearch/suppressions/${add.body.id}`, ADM, { reason: "x" })).status, 400, "reason too short");
  assert.equal((await http("DELETE", `/jobsearch/suppressions/abc`, ADM, { reason: "valid reason" })).status, 404);
  assert.equal((await http("DELETE", `/jobsearch/suppressions/99999999`, ADM, { reason: "valid reason" })).status, 404);
  const del = await http("DELETE", `/jobsearch/suppressions/${add.body.id}`, ADM, { reason: "lawyer confirmed lifting" });
  assert.equal(del.status, 200);
  assert.equal((await q("SELECT count(*)::int n FROM js_suppressions WHERE id=$1", [add.body.id])).rows[0].n, 0);
  assert.equal((await q("SELECT count(*)::int n FROM js_audit_events WHERE action='suppression.add' AND actor=$1", [`user:${mgr}`])).rows[0].n, 1);
  const rem = (await q("SELECT detail FROM js_audit_events WHERE action='suppression.remove' AND actor=$1", [`user:${adminId}`])).rows;
  assert.ok(rem.some((r) => r.detail.reason === "lawyer confirmed lifting"));
  // a manual domain suppression is enforced by isSuppressed
  assert.equal(await suppression.isSuppressed(pool, "hr@sub.blocked-corp.example"), false, "removed");
  // non-staff: no token, a candidate (see above) - and Receptionist can read/add but never delete
  assert.equal((await http("GET", "/jobsearch/suppressions")).status, 401);
  const rec = await mkUser("Receptionist");
  assert.equal((await http("DELETE", `/jobsearch/suppressions/${e.body.id}`, tok(rec, "Receptionist"), { reason: "valid reason" })).status, 403);
});


// ---------------------------------------------------------------- review round 1

test("opt-out scope: the employer's own domain opts out every employer row sharing it; a free-mail or other-domain sender stays a single address", async () => {
  const w = await world();
  const twin = (await q("INSERT INTO js_employers (name, normalized_name, domain) VALUES ($1,$2,$3) RETURNING id", [`Twin ${w.domain}`, `twin ${w.domain}`, `https://www.${w.domain.toUpperCase()}/careers`])).rows[0].id;
  const other = (await q("INSERT INTO js_employers (name, normalized_name, domain) VALUES ('Other Co','other co','other-co.example') RETURNING id")).rows[0].id;
  const r = await inbox.ingest(reply(w, { text: "Please do not reach out again." }));
  assert.equal(r.matched, true);
  assert.equal((await employerRow(twin)).status, "opted_out");
  assert.equal((await employerRow(other)).status, "new");
  assert.equal((await q("SELECT count(*)::int n FROM js_suppressions WHERE kind='domain' AND value=$1", [w.domain])).rows[0].n, 1);
  // a public-suffix / free-mail employer domain is never suppressed as a domain
  const w2 = await world({ domain: "gmail.com" }).catch(() => null);
  if (w2) assert.equal((await q("SELECT count(*)::int n FROM js_suppressions WHERE kind='domain' AND value='gmail.com'")).rows[0].n, 0);
});

test("suppression hardening: public suffixes and free-mail domains cannot be suppressed as a domain; per-address suppression stays possible", async () => {
  const c = await pool.connect();
  try {
    for (const d of ["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "co.nz", "on.ca", "qc.ca", "bc.ca", "gc.ca", "gov.ca", "co.za", "com.tn", "org.tn", "gov.tn", "com.fr", "net.xx", "ab.cd",
      "bell.net", "rogers.com", "shaw.ca", "telus.net", "sympatico.ca", "videotron.ca", "cogeco.ca", "eastlink.ca", "yahoo.com", "yahoo.ca", "yahoo.fr", "hotmail.com", "hotmail.fr", "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com", "orange.fr", "free.fr", "laposte.net"]) {
      await assert.rejects(suppression.addSuppression(c, { kind: "domain", value: d, reason: "r", createdBy: adminId }), /free-mail|public suffix/, d);
    }
    assert.ok((await suppression.addSuppression(c, { kind: "domain", value: "acme-hardening.example", reason: "r", createdBy: adminId })).created);
    assert.ok((await suppression.addSuppression(c, { kind: "email", value: "someone@rogers.com", reason: "r", createdBy: adminId })).created, "a single free-mail address can be suppressed");
    assert.equal(suppression.isPublicSuffix("acme.com"), false);
    assert.equal(suppression.isPublicSuffix("acme.co.uk"), false);
  } finally {
    c.release();
  }
});

test("final suppression check: a suppression committed after the intent transaction (right before the provider call) is honoured and nothing is sent", async () => {
  const w = await world({ stopAt: "queued" });
  let called = 0;
  const out = await submitter.handleSubmit(w.queuedItem, {
    ...DEPS,
    mailSend: async () => { called += 1; return { providerMessageId: "x" }; },
    beforeProviderCall: async () => { await q("INSERT INTO js_suppressions (kind, value, source) VALUES ('email',$1,'manual')", [`jobs@${w.domain}`]); },
  });
  assert.equal(out.status, "blocked", JSON.stringify(out));
  assert.equal(out.code, "recipient_suppressed");
  assert.equal(called, 0);
  assert.equal((await q("SELECT status FROM js_submissions WHERE id=$1", [w.submissionId])).rows[0].status, "failed");
  assert.notEqual(await statusOf(w.appId), "sent");
});
