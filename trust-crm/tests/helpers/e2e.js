// Shared setup for the end-to-end journey suite (tests/js-e2e.test.js): a real HTTP server on a fresh
// Postgres schema, real logins (bootstrap SuperAdmin -> /auth/login; staff via /auth/register; candidates
// via admin-created account + e-mail OTP read from the sandbox mailbox), real CV uploads, the test_fixture
// job source, sandbox mail, signed inbound webhooks and the scheduler with an injected clock.
// The process environment must be set by the test file BEFORE this helper is required.
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createTestDb, loadApp } = require("./db");
const { makePdf, makeDocx } = require("./docs");

// ---------------------------------------------------------------- no network, ever
// Only the local test server may be fetched. Anything else is recorded and refused (sources, mail and
// re-checks all run through sandbox/fixture adapters; a real outbound call would be a defect).
const realFetch = globalThis.fetch;
const blockedNetwork = [];
globalThis.fetch = (input, init) => {
  const url = String(input && typeof input === "object" && "url" in input ? input.url : input);
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
    blockedNetwork.push(url);
    return Promise.reject(new Error(`network disabled in the e2e suite: ${url}`));
  }
  return realFetch(input, init);
};

const HOUR = 3600 * 1000;
const NO_SLEEP = async () => {};
const OTP_SUBJECT = "Your VITA sign-in code";
const PASSWORD = "e2e-Passw0rd!";

/** A minute-aligned clock ahead of the wall clock: queue items enqueued with the DB clock are due at T0. */
function startClock() {
  let t = Math.ceil((Date.now() + 2 * 60000) / 60000) * 60000;
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
      return new Date(t);
    },
  };
}

async function parse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Starts a world: fresh schema + migrations, the app on an ephemeral port, the owner bootstrapped as
 * SuperAdmin through /auth/bootstrap-super-admin and logged in through /auth/login.
 */
async function startWorld() {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const w = {
    pool,
    base: `http://127.0.0.1:${server.address().port}`,
    seq: 0,
    users: {},
    tokens: {},
    candidates: {},
    clock: startClock(),
  };
  w.q = (sql, params) => pool.query(sql, params);
  w.one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  w.count = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);
  w.http = async (method, url, token, body, headers = {}) => {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const res = await fetch(`${w.base}${url}`, {
      method,
      headers: { ...(isForm || body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : isForm || typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await parse(res) };
  };
  // The app and the db proxy are process singletons: a world reused after another world was started must
  // point the proxy back at its own schema first.
  w.activate = () => require("../../db").setPool(pool);
  w.close = async () => {
    await new Promise((r) => server.close(r));
    await cleanup();
  };

  const boot = await w.http("POST", "/auth/bootstrap-super-admin", null, { full_name: "Owner", email: "owner@test.invalid", password: PASSWORD });
  assert.equal(boot.status, 201, JSON.stringify(boot.body));
  assert.equal(boot.body.role, "SuperAdmin");
  assert.equal(boot.body.password, undefined, "no password hash in the response");
  const again = await w.http("POST", "/auth/bootstrap-super-admin", null, { full_name: "X", email: "x@test.invalid", password: PASSWORD });
  assert.equal(again.status, 403, "bootstrap is single-use");
  w.users.super = boot.body.id;
  w.tokens.super = await login(w, "owner@test.invalid");
  return w;
}

async function login(w, email, password = PASSWORD) {
  const r = await w.http("POST", "/auth/login", null, { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token);
  return r.body.token;
}

/** Staff user created by the SuperAdmin through /auth/register, then logged in. */
async function addStaff(w, key, role) {
  const email = `${key.toLowerCase()}-${role.toLowerCase()}@test.invalid`;
  const r = await w.http("POST", "/auth/register", w.tokens.super, { full_name: `${role} ${key}`, email, password: PASSWORD, role });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  w.users[key] = r.body.id;
  w.tokens[key] = await login(w, email);
  return r.body.id;
}

/** Candidate e-mail OTP login: request -> code read from the sandbox mailbox -> verify -> token. */
async function otpLogin(w, email) {
  const otp = require("../../modules/jobsearch/otp");
  otp._testing.reset();
  const before = await w.count("SELECT count(*) AS n FROM js_sandbox_mail WHERE to_addr = $1", [email]);
  const req = await w.http("POST", "/jobsearch/auth/otp/request", null, { email });
  assert.equal(req.status, 200);
  assert.equal(req.body.ok, true);
  await otp._testing.flush();
  const mails = (await w.q("SELECT * FROM js_sandbox_mail WHERE to_addr = $1 ORDER BY id", [email])).rows;
  assert.equal(mails.length, before + 1, "exactly one OTP mail");
  const m = /\b(\d{6})\b/.exec(mails[mails.length - 1].body);
  assert.ok(m, "OTP mail carries a 6-digit code");
  const row = await w.one("SELECT code_hash FROM js_otps WHERE email = $1 ORDER BY id DESC LIMIT 1", [email]);
  assert.ok(!row.code_hash.includes(m[1]), "the code is stored hashed");
  const v = await w.http("POST", "/jobsearch/auth/otp/verify", null, { email, code: m[1] });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal((await w.http("POST", "/jobsearch/auth/otp/verify", null, { email, code: m[1] })).status, 401, "single use");
  return v.body.token;
}

/**
 * Admin creates the CRM candidate (assigned to `staffKey`) and its Candidate account; the candidate logs
 * in by OTP. Returns {id, userId, email, token}.
 */
async function createCandidate(w, key, staffKey, { adminKey = "admin" } = {}) {
  w.seq += 1;
  const email = `cand-${key.toLowerCase()}@test.invalid`;
  const add = await w.http("POST", "/candidates/add", w.tokens[adminKey], { full_name: `Candidate ${key}`, passport_number: `E2E-${key}-${w.seq}`, nationality: "Tunisian", assigned_to: w.users[staffKey] });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const id = add.body.id;
  const acc = await w.http("POST", "/jobsearch/admin/candidate-accounts", w.tokens[adminKey], { candidate_id: id, email });
  assert.equal(acc.status, 201, JSON.stringify(acc.body));
  const token = await otpLogin(w, email);
  const me = await w.http("GET", "/jobsearch/auth/me", token);
  assert.equal(me.body.role, "Candidate");
  assert.equal(me.body.candidate_id, id);
  const c = { key, id, userId: acc.body.user_id, email, token, staffKey };
  w.candidates[key] = c;
  return c;
}

async function uploadCv(w, c, buf, filename, token = c.token) {
  const fd = new FormData();
  fd.append("file", new Blob([buf]), filename);
  return w.http("POST", `/jobsearch/candidates/${c.id}/cv`, token, fd);
}

const NAMES = ["Amine Trabelsi", "Sonia Gharbi", "Youssef Hamdi", "Leila Ben Salah", "Mehdi Jaziri", "Ines Chaabane", "Walid Mansouri", "Rania Ferjani"];

const PREFS = (over = {}) => ({
  countries: ["Canada"],
  categories: ["Electrician"],
  availability: "Immediately",
  salary_expectation: 52000,
  salary_currency: "CAD",
  residence_country: "Tunisia",
  needs_work_auth_support: true,
  ...over,
});

const CONSENT = (over = {}) => ({ search: true, prepare: true, submit: true, countries: [], ...over });

/**
 * Full candidate onboarding over HTTP (J2-J7): account + OTP, PDF CV upload, profile confirmed with the
 * profession edited to 'Electrician', the CV version approved by the candidate, consent granted by the
 * candidate, settings set by the admin. Returns the candidate with cvFileId / cvSha.
 */
async function onboard(w, key, staffKey, { cvText, prefs = {}, consent = {}, settings = { mode: "prepare_for_approval", cap_per_day: 5, cap_per_week: 20 } } = {}) {
  const c = await createCandidate(w, key, staffKey);
  const person = NAMES[(w.seq + key.length) % NAMES.length];
  const pdf = makePdf(cvText || `${person}\nElectrician\nEmail: cand-${key.toLowerCase()}@test.invalid\n\nSKILLS\nIndustrial wiring, PLC programming\n\nWORK EXPERIENCE\nElectrician | Sfax Industries | 2014 - Present\n\nLANGUAGES\nEnglish (Fluent), French (Fluent)`);
  const up = await uploadCv(w, c, pdf, "cv.pdf");
  assert.equal(up.status, 201, JSON.stringify(up.body));
  c.cvFileId = up.body.cvFileId;
  c.cvSha = crypto.createHash("sha256").update(pdf).digest("hex");
  const conf = await w.http("PUT", `/jobsearch/candidates/${c.id}/profile/confirm`, c.token, { edits: { profession: "Electrician" }, preferences: PREFS(prefs) });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  const ap = await w.http("POST", `/jobsearch/cv-files/${c.cvFileId}/approve`, c.token, { language: "en" });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const g = await w.http("POST", `/jobsearch/candidates/${c.id}/consent`, c.token, { scope: CONSENT(consent), version: "2026-10-v1" });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  if (settings) {
    const s = await w.http("PUT", `/jobsearch/candidates/${c.id}/settings`, w.tokens.admin, settings);
    assert.equal(s.status, 200, JSON.stringify(s.body));
  }
  return c;
}

/** Automatic mode needs an admin-approved automation rule, created through POST /jobsearch/automation-rules (Task 18). */
async function approveAutomation(w, c, { countries = ["Canada"] } = {}) {
  const r = await w.http("POST", "/jobsearch/automation-rules", w.tokens.admin, { candidateId: c.id, type: "auto_submit", countries });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}

/**
 * Employer directory row. Employers are created by feeds/manual imports (no create API), so the row is
 * inserted; the staff-maintained domain + verified contact are set through PUT /jobsearch/employers/:id
 * (Task 18). The name matches what the feed upserts, so fixture jobs attach to it.
 */
async function employer(w, name, { domain, contact = true } = {}) {
  const { normalizeEmployer } = require("../../modules/jobsearch/jobStore");
  const row = await w.one("INSERT INTO js_employers (name, normalized_name) VALUES ($1,$2) RETURNING *", [name, normalizeEmployer(name)]);
  if (domain) {
    const put = await w.http("PUT", `/jobsearch/employers/${row.id}`, w.tokens.admin, { domain, verifiedContactEmail: contact ? `jobs@${domain}` : null });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    return { id: row.id, name, domain: put.body.domain, contact: put.body.verifiedContactEmail };
  }
  return { id: row.id, name, domain, contact: null };
}

function feedJob(w, emp, { id, title = "Electrician", text, closingAt, url, country = "Canada", location = "Toronto, ON" } = {}) {
  w.seq += 1;
  const sid = id || `fx-${w.seq}`;
  return {
    sourceJobId: sid,
    url: url || `https://careers.${emp.domain || "jobs.test.invalid"}/${sid}`,
    title,
    employerName: emp.name,
    location,
    country,
    publishedAt: new Date(w.clock.now().getTime() - 24 * HOUR).toISOString(),
    ...(closingAt ? { closingAt } : {}),
    description: text || `Commercial and industrial wiring, conduit bending and PLC troubleshooting. English required. Send your CV to ${emp.contact || `jobs@${emp.domain}`}.`,
  };
}

/** scheduler.tick at the injected clock (no sleeps); asserts the tick ran. */
async function tick(w, at, deps = {}) {
  const scheduler = require("../../modules/jobsearch/scheduler");
  const s = await scheduler.tick(at || w.clock.now(), { deps: { sleep: NO_SLEEP, ...deps } });
  return s;
}

/** Outbound application mail in the sandbox (OTP sign-in mails excluded). */
async function appMails(w, to) {
  return (await w.q(
    `SELECT * FROM js_sandbox_mail WHERE headers->>'_direction' = 'outbound' AND subject <> $1 AND ($2::text IS NULL OR to_addr = $2) ORDER BY id`,
    [OTP_SUBJECT, to || null]
  )).rows;
}

const sign = (raw) => `sha256=${crypto.createHmac("sha256", process.env.INBOUND_MAIL_SECRET).update(raw).digest("hex")}`;
let replySeq = 0;
/** Signed inbound webhook push (the provider bridge). */
async function pushInbound(w, msg, { signed = true } = {}) {
  replySeq += 1;
  const raw = JSON.stringify({ messageId: `<e2e-reply-${replySeq}-${crypto.randomBytes(3).toString("hex")}@mail.test.invalid>`, to: "applications@vita.test.invalid", ...msg });
  return w.http("POST", "/jobsearch/inbound/mail", null, raw, signed ? { "x-vita-signature": sign(raw) } : {});
}
const authPass = (domain) => `mx.vita.test.invalid; dkim=pass header.d=${domain}; spf=pass; dmarc=pass`;

/** SSE over fetch (Authorization header); collects {id, data} until close(). */
async function sse(w, token, { lastEventId } = {}) {
  const ac = new AbortController();
  const res = await fetch(`${w.base}/jobsearch/events`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(lastEventId !== undefined ? { "last-event-id": String(lastEventId) } : {}) },
    signal: ac.signal,
  });
  const st = { status: res.status, events: [], close: () => ac.abort() };
  if (res.status !== 200) {
    await res.text();
    return st;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  st.done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const lines = block.split("\n");
          const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          const idLine = lines.find((l) => l.startsWith("id: "));
          if (data) st.events.push({ id: idLine ? Number(idLine.slice(4)) : null, data: JSON.parse(data) });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return st;
}

/** Waits (polling the DB/stream, never a fixed sleep) until pred() holds. */
async function waitFor(pred, label, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`timed out waiting for ${label}`);
}

// Keys a candidate-facing response must never carry (provider ids, recipients, hashes, approvers, staff notes).
// (`message_id` = the RFC Message-ID column; a camelCase `messageId` in candidate events is the js_messages row id
// of a message released to that candidate.)
const STAFF_ONLY_KEY = /^(provider_?message_?id|message_id|message_?id_?planned|reply_?token|recipients?|recipient_?source|to_?addr|from_?addr|sha256|approved_?by|admin_?approved_?by|staff_?notes?|internal_?notes?|auto_?approval|evidence_?note|recorded_?by_?user)$/i;
function staffOnlyKeys(value, path = "$", out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => staffOnlyKeys(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (STAFF_ONLY_KEY.test(k)) out.push(`${path}.${k}`);
      staffOnlyKeys(v, `${path}.${k}`, out);
    }
  }
  return out;
}

module.exports = {
  HOUR,
  NO_SLEEP,
  OTP_SUBJECT,
  PREFS,
  CONSENT,
  blockedNetwork,
  makePdf,
  makeDocx,
  startWorld,
  addStaff,
  login,
  otpLogin,
  createCandidate,
  uploadCv,
  onboard,
  approveAutomation,
  employer,
  feedJob,
  tick,
  appMails,
  pushInbound,
  authPass,
  sse,
  waitFor,
  staffOnlyKeys,
};
