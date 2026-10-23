// crm-e2e-README
// End-to-end journey for the public website + CRM core (Task 8). REAL HTTP server (app.listen(0) + fetch),
// REAL Postgres schema (fresh per file), real staff logins through /auth/login, sandbox mailbox for the
// candidate OTP, and the shared helper tests/helpers/e2e.js (which also fences globalThis.fetch: no network).
// Limits are injected through env at run time (SITE_LEAD_IP_PER_HOUR / SITE_LEAD_EMAIL_PER_DAY), so the
// run is deterministic.
//
//   A  visitor candidate lead -> Receptionist lists it -> converts with portal login -> invite OTP read from
//      the sandbox mailbox -> candidate logs in -> sees only own job-search data (foreign id refused);
//      the pre-existing job-search endpoints answer for the converted candidate; re-convert is idempotent.
//   B  employer lead: stored, never a candidate, cannot be converted; contact lead likewise.
//   C  honeypot lead: stored as spam, hidden from the default list, unconvertible.
//   D  staff publishes an offer -> /public/jobs shows allowlisted keys only -> close -> gone.
//   E  Agent isolation across two leads; Agents cannot write or convert.
//   F  Accountant / HR / Candidate denied on /crm.
//   G  rate limits (per-IP and per-identity) -> 429 with Retry-After; dedupe within 24 h.
//
// NOT covered (by design): a real mail provider (staff notification e-mail was not built), a real domain /
// HTTPS, a browser (UI is covered by crm-ui and site-ui).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "crm-e2e-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "crm-e2e-"));
process.env.STORAGE_URL_SECRET = "crm-e2e-storage-secret";
process.env.MAIL_PROVIDER = "sandbox";
process.env.MAIL_SANDBOX_ALLOWLIST = "*@test.invalid,*@*.test.invalid";
process.env.MAIL_FROM = "applications@vita.test.invalid";
process.env.SITE_IP_SALT = "crm-e2e-salt";
// High defaults so ordinary journeys never trip the limits; section G lowers them explicitly.
process.env.SITE_LEAD_IP_PER_HOUR = "1000";
process.env.SITE_LEAD_EMAIL_PER_DAY = "1000";
for (const k of ["CLAMAV_HOST", "MAIL_REAL_SEND"]) delete process.env[k];

const E = require("./helpers/e2e");

const PUBLIC_JOB_KEYS = ["apply_mode", "category", "city", "closes_at", "country", "description", "employer_name", "employment_type", "id", "language_requirements", "published_at", "requirements", "salary_text", "title"];

let w;
test.before(async () => {
  w = await E.startWorld();
  await E.addStaff(w, "admin", "Admin");
  await E.addStaff(w, "rec", "Receptionist");
  await E.addStaff(w, "mgr", "Manager");
  await E.addStaff(w, "agentA", "Agent");
  await E.addStaff(w, "agentB", "Agent");
  await E.addStaff(w, "acct", "Accountant");
  await E.addStaff(w, "hr", "HR");
});
test.after(async () => {
  if (w) await w.close().catch(() => {});
  assert.deepEqual(E.blockedNetwork, [], "no network call left the test process");
});

const submit = (over = {}) =>
  w.http("POST", "/public/leads", null, { kind: "candidate", name: "Visitor", email: "visitor@test.invalid", consent: true, lang: "en", hp_url: "", ...over });
const leadsList = async (key, qs = "") => (await w.http("GET", `/crm/leads${qs}`, w.tokens[key])).body;
const findLead = async (key, email, qs = "") => (await leadsList(key, qs)).rows.find((l) => l.email === email);

/** Mail body of the newest sandbox mail for `to`; the OTP is the 6-digit code in it. */
async function lastCode(to) {
  await require("../modules/jobsearch/otp")._testing.flush();
  const rows = (await w.q("SELECT * FROM js_sandbox_mail WHERE to_addr = $1 ORDER BY id", [to])).rows;
  assert.ok(rows.length >= 1, "a sandbox mail was sent");
  const m = /\b(\d{6})\b/.exec(rows[rows.length - 1].body);
  assert.ok(m, "the mail carries a 6-digit code");
  return m[1];
}

test("A: candidate lead -> staff list -> convert with portal login -> OTP from sandbox mailbox -> candidate sees only own data", async () => {
  const r = await submit({ name: "Amine Trabelsi", email: "amine@test.invalid", phone: "+216 55 500 001", country: "Tunisia", profession: "Electrician", message: "Interested in Canada" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true });

  // Receptionist sees it, with consent recorded and no raw IP / hash exposed.
  const lead = await findLead("rec", "amine@test.invalid");
  assert.ok(lead, "lead visible to the Receptionist");
  assert.equal(lead.kind, "candidate");
  assert.equal(lead.status, "new");
  assert.equal(lead.source, "website");
  assert.ok(lead.consent_at, "consent timestamp stored");
  assert.ok(lead.consent_text_version);
  assert.equal(lead.ip_hash, undefined, "ip hash is not exposed to staff");
  const detail = await w.http("GET", `/crm/leads/${lead.id}`, w.tokens.rec);
  assert.equal(detail.status, 200);
  assert.equal(JSON.stringify(detail.body).includes("127.0.0.1"), false);

  const before = await w.count("SELECT count(*) AS n FROM candidates");
  // Passport number is mandatory.
  assert.equal((await w.http("POST", `/crm/leads/${lead.id}/convert`, w.tokens.rec, { createPortalLogin: true })).status, 400);
  assert.equal(await w.count("SELECT count(*) AS n FROM candidates"), before, "failed convert creates nothing");

  const conv = await w.http("POST", `/crm/leads/${lead.id}/convert`, w.tokens.rec, { passport_number: "TN-E2E-0001", nationality: "Tunisian", createPortalLogin: true });
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  assert.equal(conv.body.created, true);
  assert.equal(conv.body.portal.inviteSent, true);
  const cid = conv.body.candidate.id;
  assert.equal(await w.count("SELECT count(*) AS n FROM candidates"), before + 1);
  assert.equal((await w.http("GET", `/crm/leads/${lead.id}`, w.tokens.rec)).body.status, "converted");

  // Idempotent: second convert returns the same candidate, creates nothing.
  const again = await w.http("POST", `/crm/leads/${lead.id}/convert`, w.tokens.rec, { passport_number: "TN-E2E-0001", createPortalLogin: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.candidate.id, cid);
  assert.equal(await w.count("SELECT count(*) AS n FROM candidates"), before + 1);

  // Timeline written, stage settable by staff.
  const stage = await w.http("PATCH", `/crm/candidates/${cid}/stage`, w.tokens.rec, { stage: "documents" });
  assert.equal(stage.status, 200, JSON.stringify(stage.body));
  const tl = await w.http("GET", `/crm/candidates/${cid}/timeline`, w.tokens.rec);
  assert.equal(tl.status, 200);
  assert.ok(tl.body.some((t) => t.event === "created_from_lead"));

  // OTP read from the sandbox mailbox, then the candidate logs in.
  const code = await lastCode("amine@test.invalid");
  const bad = await w.http("POST", "/jobsearch/auth/otp/verify", null, { email: "amine@test.invalid", code: code === "000000" ? "111111" : "000000" });
  assert.equal(bad.status, 401, "wrong code refused");
  const ver = await w.http("POST", "/jobsearch/auth/otp/verify", null, { email: "amine@test.invalid", code });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  const token = ver.body.token;
  assert.equal((await w.http("POST", "/jobsearch/auth/otp/verify", null, { email: "amine@test.invalid", code })).status, 401, "code is single use");
  const me = await w.http("GET", "/jobsearch/auth/me", token);
  assert.equal(me.status, 200);
  assert.equal(me.body.role, "Candidate");
  assert.equal(me.body.candidate_id, cid);

  // Own data: the existing job-search journey works for the converted candidate (CV upload, then profile).
  assert.equal((await w.http("GET", `/jobsearch/candidates/${cid}/profile`, token)).status, 404, "no CV yet, so no profile yet");
  const cv = (name) => E.makePdf(`${name}\nElectrician\nEmail: ${name.split(" ")[0].toLowerCase()}@test.invalid\n\nSKILLS\nIndustrial wiring\n\nWORK EXPERIENCE\nElectrician | Sfax Industries | 2014 - Present\n\nLANGUAGES\nEnglish (Fluent)`);
  const up = await E.uploadCv(w, { id: cid }, cv("Amine Trabelsi"), "cv.pdf", token);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const own = await w.http("GET", `/jobsearch/candidates/${cid}/profile`, token);
  assert.equal(own.status, 200, JSON.stringify(own.body));

  // Another candidate (created the existing way, with its own data) is invisible to this candidate.
  const other = await E.createCandidate(w, "Other", "mgr");
  assert.notEqual(other.id, cid);
  assert.equal((await E.uploadCv(w, other, cv("Other Person"), "cv.pdf")).status, 201);
  assert.equal((await w.http("GET", `/jobsearch/candidates/${other.id}/profile`, other.token)).status, 200, "the other candidate has data of their own");
  const foreign = await w.http("GET", `/jobsearch/candidates/${other.id}/profile`, token);
  assert.ok([403, 404].includes(foreign.status), `foreign profile refused: ${foreign.status}`);
  assert.equal(foreign.status, 404, "the module answers 404 for a candidate outside the scope");
  assert.equal((await w.http("GET", `/jobsearch/candidates/${other.id}/matches`, token)).status, 404);
  assert.equal((await w.http("GET", `/jobsearch/candidates/${cid}/profile`, other.token)).status, 404, "and symmetrically");
  // The portal token is not a staff token: /crm is closed to it.
  assert.equal((await w.http("GET", "/crm/leads", token)).status, 403);
  assert.equal((await w.http("GET", `/crm/candidates/${cid}/timeline`, token)).status, 403);
  // Applications list contains nothing of the other candidate.
  const apps = await w.http("GET", "/jobsearch/applications", token);
  assert.equal(apps.status, 200);
  assert.equal(JSON.stringify(apps.body).includes(`"candidate_id":${other.id}`), false);
});

test("B: employer and contact leads are stored, never create a candidate and cannot be converted", async () => {
  const cand0 = await w.count("SELECT count(*) AS n FROM candidates");
  const usr0 = await w.count("SELECT count(*) AS n FROM users");
  const emp = await submit({ kind: "employer", name: "Acme Hiring", email: "hr@acme.test.invalid", company: "Acme Ltd", message: "We need welders" });
  assert.equal(emp.status, 200);
  const con = await submit({ kind: "contact", name: "Just Asking", email: "ask@test.invalid", consent: undefined, message: "Opening hours?" });
  assert.equal(con.status, 200, JSON.stringify(con.body));
  assert.equal(await w.count("SELECT count(*) AS n FROM candidates"), cand0, "no candidate from a public lead");
  assert.equal(await w.count("SELECT count(*) AS n FROM users"), usr0);

  const employer = await findLead("mgr", "hr@acme.test.invalid");
  assert.equal(employer.kind, "employer");
  assert.equal(employer.company, "Acme Ltd");
  for (const lead of [employer, await findLead("mgr", "ask@test.invalid")]) {
    const c = await w.http("POST", `/crm/leads/${lead.id}/convert`, w.tokens.mgr, { passport_number: `NOPE-${lead.id}`, createPortalLogin: true });
    assert.equal(c.status, 400, `${lead.kind}: ${JSON.stringify(c.body)}`);
  }
  assert.equal(await w.count("SELECT count(*) AS n FROM candidates"), cand0);
  assert.equal(await w.count("SELECT count(*) AS n FROM users"), usr0);
  // Consent is mandatory for employer / candidate forms.
  assert.equal((await submit({ kind: "employer", name: "X", email: "x@test.invalid", consent: false })).status, 400);
  assert.equal((await submit({ kind: "candidate", name: "X", email: "x2@test.invalid", consent: undefined })).status, 400);
});

test("C: honeypot lead is acknowledged but stored as spam and hidden from the default list", async () => {
  const r = await submit({ name: "Bot", email: "bot@test.invalid", hp_url: "http://spam.invalid" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true }, "same answer as a real submission");
  const row = await w.one("SELECT * FROM crm_leads WHERE name = 'Bot'");
  assert.equal(row.status, "spam");
  assert.equal(row.email, null, "spam stores no contact details");
  assert.equal((await leadsList("admin")).rows.some((l) => l.name === "Bot"), false);
  assert.equal((await leadsList("admin", "?limit=100")).rows.some((l) => l.name === "Bot"), false);
  const spam = await leadsList("admin", "?status=spam");
  assert.ok(spam.rows.some((l) => l.name === "Bot"), "reviewable by explicit filter");
  const c = await w.http("POST", `/crm/leads/${row.id}/convert`, w.tokens.admin, { passport_number: "SPAM-1" });
  assert.ok([400, 409].includes(c.status), `spam is not convertible: ${c.status}`);
});

test("D: staff publishes an offer -> public list shows allowlisted keys only -> closing removes it", async () => {
  const pub0 = await w.http("GET", "/public/jobs");
  assert.equal(pub0.status, 200);
  assert.deepEqual(pub0.body.jobs, [], "nothing published yet, nothing invented");

  const mk = await w.http("POST", "/crm/site-jobs", w.tokens.rec, {
    title: "Welder", employer_name: "Acme Ltd", country: "Canada", city: "Toronto", category: "Welding",
    description: "MIG welding on site.", requirements: "3 years", salary_text: "CAD 30/h",
    evidence_note: "Employer e-mail 2026-10-20, ref ACME-77 (internal)",
  });
  assert.equal(mk.status, 201, JSON.stringify(mk.body));
  const id = mk.body.id;
  assert.deepEqual((await w.http("GET", "/public/jobs")).body.jobs, [], "a draft is not public");
  assert.equal((await w.http("GET", `/public/jobs/${id}`)).status, 404);

  const nope = await w.http("POST", "/crm/site-jobs", w.tokens.rec, { title: "No evidence", country: "Canada", description: "d" });
  assert.equal(nope.status, 201);
  assert.equal((await w.http("POST", `/crm/site-jobs/${nope.body.id}/publish`, w.tokens.rec, {})).status, 400, "publish requires evidence_note");

  const pub = await w.http("POST", `/crm/site-jobs/${id}/publish`, w.tokens.rec, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const list = await w.http("GET", "/public/jobs");
  assert.equal(list.body.jobs.length, 1);
  assert.deepEqual(Object.keys(list.body.jobs[0]).sort(), PUBLIC_JOB_KEYS);
  const one = await w.http("GET", `/public/jobs/${id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(Object.keys(one.body).sort(), PUBLIC_JOB_KEYS);
  assert.equal(JSON.stringify([list.body, one.body]).includes("ACME-77"), false, "the evidence note never reaches the public");
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.equal((await w.http("GET", "/public/jobs?country=Canada")).body.jobs.length, 1);
  assert.equal((await w.http("GET", "/public/jobs?country=Peru")).body.jobs.length, 0);

  const closed = await w.http("POST", `/crm/site-jobs/${id}/close`, w.tokens.rec, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.deepEqual((await w.http("GET", "/public/jobs")).body.jobs, []);
  assert.equal((await w.http("GET", `/public/jobs/${id}`)).status, 404);
  assert.ok((await w.count("SELECT count(*) AS n FROM audit_logs WHERE action LIKE 'crm.site_job.%'")) >= 3, "mutations are audited");
});

test("E: Agent isolation across two leads; Agents cannot write or convert", async () => {
  await submit({ name: "Lead One", email: "lead1@test.invalid" });
  await submit({ name: "Lead Two", email: "lead2@test.invalid" });
  const l1 = await findLead("admin", "lead1@test.invalid");
  const l2 = await findLead("admin", "lead2@test.invalid");
  // Assignment is an admin-only action.
  assert.equal((await w.http("PATCH", `/crm/leads/${l1.id}`, w.tokens.rec, { assigned_to: w.users.agentA })).status, 403);
  assert.equal((await w.http("PATCH", `/crm/leads/${l1.id}`, w.tokens.admin, { assigned_to: w.users.agentA })).status, 200);
  assert.equal((await w.http("PATCH", `/crm/leads/${l2.id}`, w.tokens.admin, { assigned_to: w.users.agentB })).status, 200);

  const a = await leadsList("agentA");
  assert.deepEqual(a.rows.map((l) => l.id), [l1.id]);
  assert.equal(a.total, 1);
  const b = await leadsList("agentB");
  assert.deepEqual(b.rows.map((l) => l.id), [l2.id]);
  assert.equal((await w.http("GET", `/crm/leads/${l1.id}`, w.tokens.agentA)).status, 200);
  for (const [m, url, body] of [
    ["GET", `/crm/leads/${l2.id}`],
    ["PATCH", `/crm/leads/${l2.id}`, { status: "contacted" }],
    ["POST", `/crm/leads/${l2.id}/notes`, { text: "x" }],
    ["POST", `/crm/leads/${l2.id}/convert`, { passport_number: "AG-FOREIGN" }],
  ]) {
    assert.equal((await w.http(m, url, w.tokens.agentA, body)).status, 404, `${m} ${url}`);
  }
  // Own lead: read-only for Agents.
  assert.equal((await w.http("PATCH", `/crm/leads/${l1.id}`, w.tokens.agentA, { status: "contacted" })).status, 403);
  assert.equal((await w.http("POST", `/crm/leads/${l1.id}/notes`, w.tokens.agentA, { text: "x" })).status, 403);
  assert.equal((await w.http("POST", `/crm/leads/${l1.id}/convert`, w.tokens.agentA, { passport_number: "AG-OWN" })).status, 403);
  assert.equal((await w.one("SELECT status FROM crm_leads WHERE id = $1", [l1.id])).status, "new");
  assert.equal(await w.count("SELECT count(*) AS n FROM candidates WHERE passport_number LIKE 'AG-%'"), 0);
  // Agents never reach the site-job console.
  assert.equal((await w.http("GET", "/crm/site-jobs", w.tokens.agentA)).status, 403);
});

test("F: Accountant, HR and Candidate are denied on /crm; anonymous is 401", async () => {
  const cand = w.candidates.Other;
  const lead = await findLead("admin", "lead1@test.invalid");
  for (const key of ["acct", "hr"]) {
    for (const [m, url, body] of [
      ["GET", "/crm/leads"],
      ["GET", `/crm/leads/${lead.id}`],
      ["PATCH", `/crm/leads/${lead.id}`, { status: "contacted" }],
      ["POST", `/crm/leads/${lead.id}/notes`, { text: "x" }],
      ["POST", `/crm/leads/${lead.id}/convert`, { passport_number: "DENY-1" }],
      ["GET", "/crm/site-jobs"],
      ["POST", "/crm/site-jobs", { title: "t" }],
    ]) {
      assert.equal((await w.http(m, url, w.tokens[key], body)).status, 403, `${key} ${m} ${url}`);
    }
  }
  for (const [m, url, body] of [["GET", "/crm/leads"], ["GET", "/crm/site-jobs"], ["POST", "/crm/site-jobs", { title: "t" }], ["GET", `/crm/candidates/${cand.id}/timeline`]]) {
    assert.equal((await w.http(m, url, cand.token, body)).status, 403, `candidate ${m} ${url}`);
    assert.equal((await w.http(m, url, null, body)).status, 401, `anonymous ${m} ${url}`);
  }
  assert.equal((await w.http("GET", "/crm/leads", w.tokens.acct)).status, 403);
  assert.equal(await w.count("SELECT count(*) AS n FROM candidates WHERE passport_number = 'DENY-1'"), 0);
});

/** Seconds left in the current fixed rate-limit windows; waits for a rollover when too close to the edge. */
async function stableWindow() {
  for (;;) {
    const r = await w.one("SELECT extract(epoch FROM now())::float8 AS s");
    const left = 3600 - (r.s % 3600);
    const leftDay = 86400 - (r.s % 86400);
    if (left > 20 && leftDay > 20) return;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

test("G: per-IP and per-identity rate limits answer 429 with Retry-After; duplicates update one lead", async () => {
  await stableWindow();
  await w.q("DELETE FROM public_rate_limit");

  // Per identity: 2 per day; the third is refused, and the stored lead is unchanged by the refused call.
  process.env.SITE_LEAD_EMAIL_PER_DAY = "2";
  try {
    const first = await submit({ name: "Dup One", email: "dup@test.invalid", message: "first" });
    const second = await submit({ name: "Dup One", email: "dup@test.invalid", message: "second" });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(await w.count("SELECT count(*) AS n FROM crm_leads WHERE email = 'dup@test.invalid'"), 1, "duplicate within 24h updates, not duplicates");
    assert.equal((await w.one("SELECT message FROM crm_leads WHERE email = 'dup@test.invalid'")).message, "first", "an existing message is kept");
    const third = await submit({ name: "Dup One", email: "dup@test.invalid", message: "third" });
    assert.equal(third.status, 429, JSON.stringify(third.body));
    assert.ok(Number(third.headers.get("retry-after")) >= 1);
    assert.equal((await w.one("SELECT message FROM crm_leads WHERE email = 'dup@test.invalid'")).message, "first");
    // another identity is unaffected
    assert.equal((await submit({ name: "Fresh", email: "fresh@test.invalid" })).status, 200);
  } finally {
    process.env.SITE_LEAD_EMAIL_PER_DAY = "1000";
  }

  // Per IP: 2 per hour (all test requests share 127.0.0.1).
  await w.q("DELETE FROM public_rate_limit");
  process.env.SITE_LEAD_IP_PER_HOUR = "2";
  try {
    assert.equal((await submit({ name: "Ip1", email: "ip1@test.invalid" })).status, 200);
    assert.equal((await submit({ name: "Ip2", email: "ip2@test.invalid" })).status, 200);
    const blocked = await submit({ name: "Ip3", email: "ip3@test.invalid" });
    assert.equal(blocked.status, 429, JSON.stringify(blocked.body));
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    assert.equal(await w.count("SELECT count(*) AS n FROM crm_leads WHERE email = 'ip3@test.invalid'"), 0);
    // honeypot hits count against the IP too, so a bot cannot flood the table
    assert.equal((await submit({ name: "Bot2", email: "bot2@test.invalid", hp_url: "x" })).status, 429);
  } finally {
    process.env.SITE_LEAD_IP_PER_HOUR = "1000";
  }
  // The limit is stored salted-hashed, never as a raw address or e-mail.
  const keys = (await w.q("SELECT key FROM public_rate_limit")).rows.map((r) => r.key).join(" ");
  assert.equal(/127\.0\.0\.1|@test\.invalid/.test(keys), false);
  assert.equal((await submit({ name: "After", email: "after@test.invalid" })).status, 200, "limits reset by the env injection");
});
