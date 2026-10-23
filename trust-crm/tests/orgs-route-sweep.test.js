// Security regression sweep for the Employer / Agency portals (plan Task 6).
//
// Enumerates EVERY route registered on the Express app (app._router.stack, nested routers and mount paths
// reconstructed) and calls each one over real HTTP as an Employer token, an Agency token, a Candidate token and
// with no token. Which actor may get past 401/403/404 on which route is decided ONLY by the explicit
// classification tables below:
//   - a route that matches no table entry fails the sweep ("unclassified"): new routes must be classified here;
//   - an entry that matches no route fails too (stale table);
//   - every other (route, actor) pair must answer 401, 403 or 404 with an error-only body, never 2xx/5xx and
//     never any seeded private data (sentinel strings) - for ALL actors, allowed or not.
// Staff are not swept (their permissions are covered by the per-module suites); a staff token is only used as a
// positive control so "denied" can never be vacuous (the routes work, the roles are what is refused).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "orgs-sweep-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orgs-sweep-"));
process.env.STORAGE_URL_SECRET = process.env.STORAGE_URL_SECRET || "orgs-sweep-storage-secret";
process.env.MAIL_PROVIDER = "sandbox";
process.env.MAIL_SANDBOX_ALLOWLIST = "*@test.invalid,*@*.test.invalid";
process.env.MAIL_FROM = "applications@vita.test.invalid";
process.env.INBOUND_MAIL_SECRET = "orgs-sweep-inbound-secret";
process.env.JOBSEARCH_EXPORT_RATE_PER_HOUR = "100000";
process.env.JS_UPLOADS_PER_HOUR = "1000";
process.env.ALLOW_UNSCANNED_ATTACHMENTS = "true";
for (const k of ["CLAMAV_HOST", "MAIL_REAL_SEND", "JOBBANK_CA_FEED_URL", "PARTNER_FEED_URLS"]) delete process.env[k];

const E = require("./helpers/e2e");
const { createEmployerUser, createAgencyUser, portalToken } = require("./helpers/orgs");

// ------------------------------------------------------------------ classification tables
// An entry lists the actors that MAY get past 401/403/404 on matching routes (they can still get 400/409 on the
// sweep's empty bodies). Every other actor MUST be refused. First match wins.
const ALL = ["anon", "employer", "agency", "candidate"];
const NONE = [];

const ROUTE_RULES = [
  // ---- unauthenticated by design (serve no private data)
  { re: /^GET \/healthz$/, allow: ALL, why: "liveness probe, answers {ok}" },
  { re: /^GET \/$/, allow: ALL, why: "API banner / website home" },
  { re: /^GET \/(robots\.txt|sitemap\.xml)$/, allow: ALL, why: "static" },
  { re: /^GET \/(site|vita)\/$/, allow: ALL, why: "static website / VITA UI mounts" },
  { re: /^(GET|POST) \/public\//, allow: ALL, why: "/public/* unauthenticated website API" },
  { re: /^POST \/auth\/(login|bootstrap-super-admin)$/, allow: ALL, why: "login / one-shot bootstrap (403 once an owner exists)" },
  { re: /^POST \/jobsearch\/auth\/otp\/(request|verify)$/, allow: ALL, why: "OTP request / verify: every portal role signs in here" },
  // ---- webhook with its own HMAC: nobody gets past it unsigned (also asserted explicitly below)
  { re: /^POST \/jobsearch\/inbound\/mail$/, allow: NONE, why: "inbound mail webhook: HMAC only, unsigned is 401" },
  // ---- portals (role-specific middleware, organisation taken from crm_org_accounts)
  { re: /^\w+ \/employer\//, allow: ["employer"], why: "Employer portal" },
  { re: /^\w+ \/agency\//, allow: ["agency"], why: "Agency portal" },
  // ---- staff-only prefixes (permission checked): no portal role and no Candidate, ever
  { re: /^\w+ \/crm\//, allow: NONE, why: "staff CRM" },
  { re: /^POST \/auth\/register$/, allow: NONE, why: "users:write" },
  { re: /^\w+ \/candidates\//, allow: NONE, why: "staff candidate CRUD (/candidates/*)" },
  // finance: legacy (/dashboard, POST /invoices, POST /payments) and stage-4 routes (routes/financeV2.js: /services*, /invoices*, /payments*,
  // /expenses*, /expense-categories*, /reports/*, /export/*.csv) are staff permissions only: no portal role and no Candidate.
  // The ONE exception is the Candidate self-view, GET /finance/me and GET /finance/me/invoices/:id/print (role Candidate only,
  // ownership from js_candidate_accounts); Employer and Agency never reach it. First match wins, so it sits before the catch-all.
  { re: /^GET \/finance\/me(\/|$)/, allow: ["candidate"], why: "finance candidate self-view (/finance/me*)" },
  { re: /^\w+ \/finance\//, allow: NONE, why: "finance (staff permissions)" },
  { re: /^\w+ \/documents(\/|$)/, allow: NONE, why: "documents" },
  { re: /^\w+ \/audit-logs$/, allow: NONE, why: "audit log" },
  { re: /^\w+ \/notifications\//, allow: NONE, why: "notifications" },
  { re: /^\w+ \/alerts\//, allow: NONE, why: "alerts" },
];

// /jobsearch is classified route by route (this is where Candidate access legitimately varies). A /jobsearch route
// that is in neither list below fails the sweep as unclassified.
// Candidate-callable (ownership-scoped in the services; foreign ids answer 404). Employer and Agency NEVER, except
// GET /jobsearch/auth/me which only echoes {id, role} of the caller's own session.
const JOBSEARCH_CANDIDATE = [
  "GET /jobsearch/auth/me",
  "POST /jobsearch/candidates/:id/cv",
  "GET /jobsearch/candidates/:id/profile",
  "PUT /jobsearch/candidates/:id/profile/confirm",
  "GET /jobsearch/files/:key",
  "POST /jobsearch/candidates/:id/consent",
  "GET /jobsearch/candidates/:id/consent",
  "POST /jobsearch/candidates/:id/consent/withdraw",
  "GET /jobsearch/candidates/:id/settings",
  "PUT /jobsearch/candidates/:id/settings",
  "PUT /jobsearch/candidates/:id/preferences",
  "POST /jobsearch/candidates/:id/pause",
  "GET /jobsearch/candidates/:id/eligibility",
  "GET /jobsearch/candidates/:id/matches",
  "GET /jobsearch/applications",
  "GET /jobsearch/applications/:id",
  "POST /jobsearch/applications",
  "POST /jobsearch/applications/:id/prepare",
  "POST /jobsearch/applications/:id/cancel",
  "POST /jobsearch/applications/:id/sharing-authorizations",
  "DELETE /jobsearch/applications/:id/sharing-authorizations/:authId",
  "POST /jobsearch/cv-files/:id/approve",
  "GET /jobsearch/submissions",
  "GET /jobsearch/messages",
  "GET /jobsearch/messages/:id",
  "POST /jobsearch/interviews/:id/availability",
  "GET /jobsearch/interviews",
  "GET /jobsearch/dashboard",
  "GET /jobsearch/export.csv",
  "GET /jobsearch/events",
];
// Any portal role may ask who it is (the only /jobsearch route besides OTP that Employer / Agency reach).
const JOBSEARCH_PORTAL_ME = "GET /jobsearch/auth/me";
// Staff only (permission / role checks inside): Employer, Agency and Candidate are refused.
const JOBSEARCH_STAFF = [
  "POST /jobsearch/admin/candidate-accounts",
  "POST /jobsearch/admin/users/:id/suspend",
  "POST /jobsearch/admin/users/:id/reinstate",
  "POST /jobsearch/sources/:key/pause",
  "POST /jobsearch/sources/:key/resume",
  "GET /jobsearch/sources",
  "POST /jobsearch/search/run",
  "GET /jobsearch/jobs",
  "POST /jobsearch/jobs/manual",
  "POST /jobsearch/module/pause",
  "POST /jobsearch/employer-confirmations",
  "DELETE /jobsearch/employer-confirmations/:id",
  "GET /jobsearch/employer-confirmations",
  "POST /jobsearch/applications/:id/approve",
  "POST /jobsearch/applications/:id/reject",
  "POST /jobsearch/applications/:id/queue",
  "GET /jobsearch/applications/:id/recipient",
  "POST /jobsearch/applications/:id/manual-completion",
  "POST /jobsearch/submissions/:id/evidence",
  "POST /jobsearch/queue/run",
  "POST /jobsearch/scheduler/tick",
  "GET /jobsearch/scheduler/status",
  "POST /jobsearch/messages/:id/assign",
  "POST /jobsearch/messages/:id/confirm-acknowledgement",
  "POST /jobsearch/messages/:id/share-with-candidate",
  "POST /jobsearch/messages/:id/apply-classification",
  "POST /jobsearch/messages/:id/draft",
  "POST /jobsearch/drafts/:id/send",
  "POST /jobsearch/messages/:id/interview",
  "POST /jobsearch/interviews/:id/cancel",
  "POST /jobsearch/interviews/:id/reschedule",
  "GET /jobsearch/reports",
  "GET /jobsearch/health",
  "GET /jobsearch/employers",
  "PUT /jobsearch/employers/:id",
  "GET /jobsearch/automation-rules",
  "POST /jobsearch/automation-rules",
  "DELETE /jobsearch/automation-rules/:id",
];

function classify(key) {
  for (const r of ROUTE_RULES) if (r.re.test(key)) return r;
  if (key === JOBSEARCH_PORTAL_ME) return { allow: ["employer", "agency", "candidate"], why: "own session echo" };
  if (JOBSEARCH_CANDIDATE.includes(key)) return { allow: ["candidate"], why: "candidate /jobsearch route" };
  if (JOBSEARCH_STAFF.includes(key)) return { allow: NONE, why: "staff-only /jobsearch route" };
  return null;
}

// ------------------------------------------------------------------ route enumeration (express 4)
function mountPath(layer) {
  if (layer.regexp.fast_slash) return "";
  let s = layer.regexp.source.replace(/^\^/, "").replace("\\/?(?=\\/|$)", "");
  let i = 0;
  s = s.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${layer.keys[i++].name}`);
  s = s.replace(/\\\//g, "/");
  if (/[\\^$()?*+[\]|]/.test(s)) throw new Error(`cannot reconstruct the mount path of ${layer.regexp}: extend the sweep`);
  return s;
}
function walk(stack, prefix, out) {
  for (const l of stack) {
    if (l.route) {
      const rp = l.route.path;
      if (typeof rp !== "string") throw new Error(`non-string route path ${String(rp)} under "${prefix}": extend the sweep`);
      const methods = l.route.methods._all ? ["get", "post", "put", "patch", "delete"] : Object.keys(l.route.methods);
      for (const m of methods) out.push({ method: m.toUpperCase(), template: (prefix + (rp === "/" ? "" : rp)) || "/" });
    } else if (l.name === "router" && l.handle && Array.isArray(l.handle.stack)) {
      const mount = prefix + mountPath(l);
      const before = out.length;
      walk(l.handle.stack, mount, out);
      // A mounted router without a route of its own is a static mount (express.static): probe its root.
      if (out.length === before) out.push({ method: "GET", template: `${mount}/`, mount: true });
    }
  }
  return out;
}
const fill = (template, id) => template.replace(/:(\w+)/g, (_m, n) => (n === "id" || /Id$/.test(n) ? String(id) : "x"));

// ------------------------------------------------------------------ http
async function probe(base, method, url, token, { headers = {}, body } = {}) {
  const ac = new AbortController();
  const hasBody = method !== "GET" && method !== "HEAD";
  const res = await fetch(base + url, {
    method,
    redirect: "manual",
    signal: ac.signal,
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? body : hasBody ? "{}" : undefined,
  });
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    ac.abort(); // SSE: headers are the answer
    return { status: res.status, text: "", json: null, stream: true };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, stream: false };
}
const DENIED = new Set([401, 403, 404]);
const ERROR_KEYS = new Set(["error", "message", "code"]);
const isErrorOnly = (r) => r.json && typeof r.json === "object" && !Array.isArray(r.json) && typeof r.json.error === "string" && Object.keys(r.json).every((k) => ERROR_KEYS.has(k));

// ------------------------------------------------------------------ world
let worldPromise = null;
const world = () => (worldPromise ||= buildWorld());
test.after(async () => {
  if (worldPromise) await (await worldPromise).w.close().catch(() => {});
});

async function buildWorld() {
  const w = await E.startWorld();
  await E.addStaff(w, "admin", "Admin");
  await E.addStaff(w, "mgr", "Manager");
  // Candidates: the victim is id 1 (fully onboarded: CV, profile, consent), the attacker id 2 (just an account).
  const victim = await E.onboard(w, "victim", "mgr");
  const attacker = await E.createCandidate(w, "attacker", "mgr");
  assert.deepEqual([victim.id, attacker.id], [1, 2], "fixture assumption: ids 1 and 2");
  // Seed the first (id 1 = victim) and second (id 2 = attacker) row of every job-search table the routes address,
  // so the ids the sweep fills in hit REAL rows: a refusal is then an authorization decision, not "no such row".
  const sentinels = [];
  const mark = (value, owner) => sentinels.push({ value, owner });
  const staffId = w.users.mgr;
  for (const [n, c, owner] of [[1, victim, "victim"], [2, attacker, "candidate"]]) {
    const emp = (await w.one("INSERT INTO js_employers (name, normalized_name) VALUES ($1,$1) RETURNING id", [`SWEEP-EMPLOYER-${owner}-${n}`])).id;
    const job = (await w.one("INSERT INTO js_jobs (employer_id, title, country, status, dedupe_key, description_text) VALUES ($1,$2,'Canada','open',$3,$4) RETURNING id", [emp, `SWEEP-JOB-${owner}-${n}`, `sweep-job-${n}`, `SWEEP-JOBTEXT-${owner}-${n}`])).id;
    await w.q("INSERT INTO js_matches (candidate_id, job_id, score) VALUES ($1,$2,80)", [c.id, job]);
    const app = (await w.one("INSERT INTO js_applications (candidate_id, job_id, status, mode_at_creation, responsible_user_id, cover_letter_text) VALUES ($1,$2,'ready_for_review','prepare_for_approval',$3,$4) RETURNING id", [c.id, job, staffId, `SWEEP-COVER-${owner}-${n}`])).id;
    await w.q("INSERT INTO js_submissions (application_id, idempotency_key, recipient, status) VALUES ($1,$2,$3,'sent')", [app, `sweep-sub-${n}`, `sweep-recipient-${owner}-${n}@hr.test.invalid`]);
    await w.q("INSERT INTO js_messages (direction, application_id, from_addr, to_addr, subject, body_sanitized, message_id) VALUES ('in',$1,$2,$3,$4,$5,$6)", [app, `hr-${n}@employer.test.invalid`, "applications@vita.test.invalid", `SWEEP-SUBJECT-${owner}-${n}`, `SWEEP-BODY-${owner}-${n}`, `<sweep-${n}@m.test.invalid>`]);
    await w.q("INSERT INTO js_appointments (staff_user_id, candidate_id, application_id, starts_at, ends_at, location) VALUES ($1,$2,$3, now() + ($4 || ' days')::interval, now() + ($4 || ' days')::interval + interval '1 hour', $5)", [staffId, c.id, app, String(10 + n), `SWEEP-LOCATION-${owner}-${n}`]);
    for (const v of [`SWEEP-JOB-${owner}-${n}`, `SWEEP-JOBTEXT-${owner}-${n}`, `SWEEP-COVER-${owner}-${n}`, `SWEEP-SUBJECT-${owner}-${n}`, `SWEEP-BODY-${owner}-${n}`, `SWEEP-LOCATION-${owner}-${n}`, `sweep-recipient-${owner}-${n}@hr.test.invalid`]) mark(v, owner);
  }
  const cand = (await w.one("SELECT full_name, email, passport_number FROM candidates WHERE id = 1"));
  for (const v of [cand.full_name, cand.email, cand.passport_number]) mark(v, "victim");
  // Portal organisations: B (id 1 in their tables) belongs to someone else, A (id 2) is the actor under test.
  const empB = await createEmployerUser(w.pool, { orgName: "SWEEP-ORG-EMPLOYER-B" });
  const emp = await createEmployerUser(w.pool, { orgName: "SWEEP-ORG-EMPLOYER-A" });
  const agyB = await createAgencyUser(w.pool, { orgName: "SWEEP-ORG-AGENCY-B" });
  const agy = await createAgencyUser(w.pool, { orgName: "SWEEP-ORG-AGENCY-A" });
  const mkReq = async (u, title) => {
    const r = await w.http("POST", "/employer/requests", u.token, { title, positions: 2, country: "Germany", description: `DESC ${title}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id;
  };
  assert.equal(String(await mkReq(empB, "SWEEP-REQUEST-EMPLOYER-B")), "1");
  assert.equal(String(await mkReq(emp, "SWEEP-REQUEST-EMPLOYER-A")), "2");
  mark("SWEEP-REQUEST-EMPLOYER-B", "employerB");
  mark("SWEEP-ORG-EMPLOYER-B", "employerB");
  mark("SWEEP-REQUEST-EMPLOYER-A", "employer");
  mark("SWEEP-ORG-EMPLOYER-A", "employer");
  const mkLead = async (u, name) => {
    const r = await w.http("POST", "/agency/candidates", u.token, { full_name: name, email: `${name.toLowerCase()}@test.invalid`, profession: "Welder", country: "Tunisia", consent_attested: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id;
  };
  assert.equal(String(await mkLead(agyB, "SWEEP-LEAD-AGENCY-B")), "1");
  assert.equal(String(await mkLead(agy, "SWEEP-LEAD-AGENCY-A")), "2");
  mark("SWEEP-LEAD-AGENCY-B", "agencyB");
  mark("SWEEP-ORG-AGENCY-B", "agencyB");
  mark("SWEEP-LEAD-AGENCY-A", "agency");
  mark("SWEEP-ORG-AGENCY-A", "agency");
  const routes = walk(require("../app")._router.stack, "", []);
  return { w, victim, attacker, emp, empB, agy, agyB, sentinels, routes };
}

/** Sentinel strings (other people's data) found in a response body that the actor does not own. */
function leaked(sentinels, actor, text) {
  return sentinels.filter((s) => s.owner !== actor && text.includes(s.value)).map((s) => s.value);
}

// ------------------------------------------------------------------ the sweep
test("sweep: every route is classified and every disallowed (route, role) answers 401/403/404 with no data", async () => {
  const { w, attacker, emp, agy, sentinels, routes } = await world();

  // 1. Classification is total and the tables are not stale.
  const keyOf = (r) => `${r.method} ${r.template}`;
  const keys = routes.map(keyOf);
  assert.equal(new Set(keys).size, keys.length, "route keys are unique");
  const unclassified = keys.filter((k) => !classify(k));
  assert.deepEqual(unclassified, [], `UNCLASSIFIED routes - decide who may call them and add them to the tables in orgs-route-sweep.test.js:\n  ${unclassified.join("\n  ")}`);
  const unusedRules = ROUTE_RULES.filter((r) => !keys.some((k) => r.re.test(k))).map((r) => String(r.re));
  const unusedLists = [...JOBSEARCH_CANDIDATE, ...JOBSEARCH_STAFF, JOBSEARCH_PORTAL_ME].filter((k) => !keys.includes(k));
  assert.deepEqual([...unusedRules, ...unusedLists], [], "STALE classification entries that match no registered route");
  assert.equal(new Set([...JOBSEARCH_CANDIDATE, ...JOBSEARCH_STAFF]).size, JOBSEARCH_CANDIDATE.length + JOBSEARCH_STAFF.length, "no route listed twice");
  // Sanity: the enumeration really walked the nested routers (guards against a silent express-internals change).
  for (const must of ["GET /employer/requests/:id", "POST /agency/candidates", "GET /crm/leads", "POST /jobsearch/inbound/mail", "GET /jobsearch/events", "GET /candidates/all", "GET /healthz", "GET /vita/"]) assert.ok(keys.includes(must), `enumeration found ${must}`);
  assert.ok(routes.length > 120, `enumerated ${routes.length} routes`);

  // 2. Every (route, actor, id-set) call.
  const actors = { employer: emp.token, agency: agy.token, candidate: attacker.token, anon: null };
  const offenders = [];
  let calls = 0;
  for (const r of routes) {
    const allow = classify(keyOf(r)).allow;
    const ids = /:\w+/.test(r.template) ? [1, 2] : [1]; // 1 = the victim's rows, 2 = the attacker's / org A's own rows
    for (const [role, token] of Object.entries(actors)) {
      for (const id of ids) {
        const url = fill(r.template, id);
        const res = await probe(w.base, r.method, url, token);
        calls += 1;
        const tag = `${r.method} ${url} as ${role} -> ${res.status}`;
        const found = leaked(sentinels, role, res.text);
        if (found.length) offenders.push(`${tag}: LEAKS ${found.join(", ")}`);
        if (res.status >= 500) offenders.push(`${tag}: server error`);
        if (allow.includes(role)) continue;
        if (!DENIED.has(res.status)) offenders.push(`${tag}: expected 401/403/404`);
        else if (!res.stream && !isErrorOnly(res)) offenders.push(`${tag}: refusal body is not error-only: ${res.text.slice(0, 80)}`);
      }
    }
  }
  assert.ok(calls > 800, `made ${calls} calls`);
  assert.deepEqual(offenders, [], `\n${offenders.length} AUTHORIZATION SWEEP OFFENDER(S) (method path role -> status):\n  ${offenders.join("\n  ")}\n`);
});

test("sweep controls: the refused routes are alive for the roles that own them (denial is never vacuous)", async () => {
  const { w, victim, attacker, emp, agy } = await world();
  const ok = async (token, url, label) => {
    const r = await probe(w.base, "GET", url, token);
    assert.equal(r.status, 200, `${label}: GET ${url} -> ${r.status} ${r.text.slice(0, 100)}`);
    return r;
  };
  await ok(emp.token, "/employer/me", "employer");
  await ok(emp.token, "/employer/requests/2", "employer own request");
  await ok(agy.token, "/agency/me", "agency");
  await ok(agy.token, "/agency/candidates/2", "agency own lead");
  assert.equal((await ok(attacker.token, "/jobsearch/auth/me", "candidate")).json.candidate_id, attacker.id);
  await ok(attacker.token, "/jobsearch/applications/2", "candidate own application");
  await ok(attacker.token, "/jobsearch/messages", "candidate messages");
  // Finance self-view: the Candidate gets its own (empty) statement; staff, Employer, Agency and anonymous are refused on /finance/me*.
  const finMe = await ok(attacker.token, "/finance/me", "candidate finance self-view");
  assert.deepEqual(finMe.json, { invoices: [], totals: [] });
  for (const url of ["/finance/me", "/finance/me/invoices/1/print"]) {
    for (const [role, token] of [["employer", emp.token], ["agency", agy.token], ["admin", w.tokens.admin], ["mgr", w.tokens.mgr], ["anon", null]]) {
      const r = await probe(w.base, "GET", url, token);
      assert.ok(DENIED.has(r.status), `${role} GET ${url} -> ${r.status}`);
    }
  }
  // ...and the Candidate is refused on every staff finance route (the carve-out is /me* only).
  for (const url of ["/finance/dashboard", "/finance/services", "/finance/invoices", "/finance/expenses", "/finance/reports/summary", "/finance/export/invoices.csv"]) {
    assert.equal((await probe(w.base, "GET", url, attacker.token)).status, 403, `candidate GET ${url}`);
  }
  // Staff reach every staff-only prefix, and a staff token sees the victim's rows the portal tokens are refused.
  for (const url of ["/crm/leads", "/candidates/all", "/finance/dashboard", "/finance/services", "/finance/invoices", "/finance/expenses", "/finance/reports/summary", "/finance/export/expenses.csv", "/audit-logs", "/notifications/latest", "/alerts/expiring", "/jobsearch/employers", "/jobsearch/sources", "/jobsearch/candidates/1/profile", "/jobsearch/applications/1", "/jobsearch/messages/1", "/jobsearch/applications/1/recipient"]) {
    await ok(w.tokens.admin, url, "admin");
  }
  // The same victim rows through each portal token and the foreign Candidate: refused.
  for (const url of ["/jobsearch/candidates/1/profile", "/jobsearch/applications/1", "/jobsearch/messages/1", "/jobsearch/candidates/1/matches"]) {
    for (const [role, token] of [["employer", emp.token], ["agency", agy.token], ["candidate", attacker.token], ["anon", null]]) {
      const r = await probe(w.base, "GET", url, token);
      assert.ok(DENIED.has(r.status), `${role} GET ${url} -> ${r.status}`);
    }
  }
  assert.equal(victim.id, 1);
});

test("sweep: the inbound mail webhook rejects anything unsigned or wrongly signed, for every actor", async () => {
  const { w, emp, agy, attacker, sentinels } = await world();
  const raw = JSON.stringify({ messageId: "<sweep-unsigned@m.test.invalid>", to: "applications@vita.test.invalid", from: "hr@employer.test.invalid", subject: "x", text: "SWEEP-INBOUND-SPOOF" });
  const before = Number((await w.one("SELECT count(*) AS n FROM js_messages")).n);
  const badHeaders = [{}, { "x-vita-signature": "" }, { "x-vita-signature": "sha256=" + "0".repeat(64) }, { "x-vita-signature": "nonsense" }, { "x-vita-signature": "sha256=" + "f".repeat(63) }];
  for (const token of [null, emp.token, agy.token, attacker.token, w.tokens.admin]) {
    for (const headers of badHeaders) {
      const r = await probe(w.base, "POST", "/jobsearch/inbound/mail", token, { headers, body: raw });
      // Portal tokens are refused earlier still (403) by the /jobsearch guard; everybody else by the signature (401).
      const portal = token === emp.token || token === agy.token;
      assert.ok(r.status === 401 || (portal && r.status === 403), `unsigned/forged webhook as ${token === null ? "anon" : "token"} -> ${r.status}`);
      assert.deepEqual(Object.keys(r.json || {}), ["error"]);
    }
  }
  assert.equal(Number((await w.one("SELECT count(*) AS n FROM js_messages")).n), before, "nothing was stored");
  // A correctly signed push is what gets through (proves the signature, not the route, is the gate).
  const ok = await E.pushInbound(w, { from: "hr@employer.test.invalid", subject: "signed", text: "hello" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("sweep: the controls for the unauthenticated allowlist hold (bootstrap is single-use, login needs credentials)", async () => {
  const { w } = await world();
  const boot = await probe(w.base, "POST", "/auth/bootstrap-super-admin", null, { body: JSON.stringify({ full_name: "X", email: "x@test.invalid", password: "Passw0rd!Passw0rd!" }) });
  assert.equal(boot.status, 403, "an owner already exists");
  const login = await probe(w.base, "POST", "/auth/login", null, { body: JSON.stringify({ email: "owner@test.invalid", password: "wrong" }) });
  assert.ok(DENIED.has(login.status) || login.status === 400, `bad login -> ${login.status}`);
  assert.equal(login.json && login.json.token, undefined);
});

// ------------------------------------------------------------------ focused regressions for what the sweep found
// Found by the sweep: on four /jobsearch routes the body is validated BEFORE the caller is authorized, so an
// Employer / Agency token (and, for /module/pause, a Candidate) got a 400 that names the expected body instead of
// a refusal. No data was readable and nothing could change (the later checks refused), but the portals must be
// refused first. Fixed by rejectPortalTokens (app.js, mounted in front of every /jobsearch router) and by checking
// the permission before the body in settingsService.pauseModule.

async function snapshot(w) {
  return {
    settings: (await w.q("SELECT candidate_id, paused, mode FROM js_candidate_settings ORDER BY candidate_id")).rows,
    module: (await w.q("SELECT key, value FROM js_module_state ORDER BY key")).rows,
    apps: Number((await w.one("SELECT count(*) AS n FROM js_applications")).n),
    audit: Number((await w.one("SELECT count(*) AS n FROM js_audit_events")).n),
  };
}

test("regression: Employer and Agency tokens with VALID bodies on the formerly validate-first routes are refused and change nothing", async () => {
  const { w, emp, agy, attacker, sentinels } = await world();
  const before = await snapshot(w);
  const calls = [
    ["POST", "/jobsearch/candidates/1/pause", { paused: true }],
    ["POST", "/jobsearch/candidates/2/pause", { paused: true }],
    ["POST", "/jobsearch/module/pause", { paused: true }],
    ["POST", "/jobsearch/applications", { matchId: 1 }],
    ["POST", "/jobsearch/applications", { matchId: 2 }],
    ["GET", "/jobsearch/submissions?applicationId=1", null],
    ["GET", "/jobsearch/submissions?applicationId=2", null],
  ];
  for (const [role, token] of [["employer", emp.token], ["agency", agy.token]]) {
    for (const [method, url, body] of calls) {
      const r = await probe(w.base, method, url, token, body ? { body: JSON.stringify(body) } : {});
      assert.ok(DENIED.has(r.status), `${role} ${method} ${url} -> ${r.status}`);
      assert.ok(isErrorOnly(r), `${role} ${method} ${url}: error-only body, got ${r.text.slice(0, 80)}`);
      assert.equal(leaked(sentinels, role, r.text).length, 0);
    }
  }
  // The Candidate was reaching the admin-only module switch's body validation: now refused first, with or without a body.
  for (const body of ["{}", JSON.stringify({ paused: true }), JSON.stringify({ paused: "yes" })]) {
    const r = await probe(w.base, "POST", "/jobsearch/module/pause", attacker.token, { body });
    assert.equal(r.status, 403, `candidate module/pause ${body}`);
  }
  const noBody = await probe(w.base, "POST", "/jobsearch/module/pause", w.tokens.mgr, { body: "{}" });
  assert.equal(noBody.status, 403, "a Manager is not an administrator");
  assert.deepEqual(await snapshot(w), before, "no setting, module state, application or audit row changed");
  // Staff still validate AFTER authorization: an Admin sending a bad body gets the 400.
  assert.equal((await probe(w.base, "POST", "/jobsearch/module/pause", w.tokens.admin, { body: "{}" })).status, 400);
});

test("regression: the /jobsearch portal guard lets through only what portal users need and leaves everything else as before", async () => {
  const { w, emp, agy } = await world();
  for (const u of [emp, agy]) {
    const me = await probe(w.base, "GET", "/jobsearch/auth/me", u.token);
    assert.equal(me.status, 200);
    assert.deepEqual(Object.keys(me.json).sort(), ["id", "role"]);
    // A stale portal bearer sent to the public OTP routes does not block signing in again.
    for (const p of ["request", "verify"]) assert.equal((await probe(w.base, "POST", `/jobsearch/auth/otp/${p}`, u.token)).status, 400, `otp/${p} reaches its handler`);
  }
  // Non-portal tokens and bad tokens are untouched by the guard.
  assert.equal((await probe(w.base, "GET", "/jobsearch/auth/me", "not-a-jwt")).status, 400);
  assert.equal((await probe(w.base, "GET", "/jobsearch/auth/me", null)).status, 401);
  assert.equal((await probe(w.base, "GET", "/jobsearch/dashboard", w.tokens.admin)).status, 200);
  // A portal token for a user that was suspended / revoked is still refused (403 by the guard, never 2xx).
  const dead = await createEmployerUser(w.pool, { orgName: "SWEEP-ORG-REVOKED", status: "suspended" });
  const r = await probe(w.base, "GET", "/jobsearch/dashboard", dead.token);
  assert.ok(DENIED.has(r.status), `suspended employer -> ${r.status}`);
});

test("employer with a candidate-looking id gets no candidate data from /jobsearch (profile, matches, applications, files, SSE events)", async () => {
  const { w, victim, attacker, emp, sentinels } = await world();
  // 1. Plain Employer token, victim and attacker ids, every candidate-facing read and write.
  const reads = [
    "/jobsearch/candidates/1/profile", "/jobsearch/candidates/2/profile", "/jobsearch/candidates/1/matches", "/jobsearch/candidates/2/matches",
    "/jobsearch/candidates/1/consent", "/jobsearch/candidates/1/settings", "/jobsearch/candidates/1/eligibility", "/jobsearch/applications", "/jobsearch/applications?candidateId=1",
    "/jobsearch/applications/1", "/jobsearch/applications/2", "/jobsearch/messages", "/jobsearch/messages/1", "/jobsearch/interviews", "/jobsearch/dashboard", "/jobsearch/dashboard?candidateId=1",
    "/jobsearch/export.csv?type=applications", "/jobsearch/export.csv?type=matches", "/jobsearch/submissions?applicationId=1", "/jobsearch/reports", "/jobsearch/events",
  ];
  for (const url of reads) {
    for (const h of [{}, { "last-event-id": "0" }]) {
      const r = await probe(w.base, "GET", url, emp.token, { headers: h });
      assert.ok(DENIED.has(r.status) && !r.stream, `employer GET ${url} -> ${r.status}`);
      assert.ok(isErrorOnly(r), url);
      assert.deepEqual(leaked(sentinels, "employer", r.text), [], url);
    }
  }
  // 2. A real signed CV download URL of the victim is useless to anyone but the victim (and staff in scope).
  const prof = await probe(w.base, "GET", "/jobsearch/candidates/1/profile", victim.token);
  assert.equal(prof.status, 200);
  const url = prof.json.cv_files[0].download_url;
  assert.ok(url, "victim has a signed CV url");
  const own = await fetch(w.base + url, { headers: { authorization: `Bearer ${victim.token}` } });
  assert.equal(own.status, 200);
  assert.equal((await own.text()).slice(0, 4), "%PDF", "control: the owner downloads the CV");
  for (const [role, token] of [["employer", emp.token], ["attacker", attacker.token], ["anon", null]]) {
    const r = await fetch(w.base + url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const body = await r.text();
    assert.ok(DENIED.has(r.status), `${role} signed CV url -> ${r.status}`);
    assert.ok(!body.includes("%PDF"), `${role} got file bytes`);
  }
  // 3. An Employer user that is (wrongly) linked to a real candidate record still gets nothing: the guard refuses it
  //    first and, beneath the guard, the data-scope layer only ever grants a Candidate role.
  const cid = (await w.one("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ('SWEEP-LINKED-CAND','SWEEP-LINKED-PP',$1) RETURNING id", [w.users.mgr])).id;
  await w.q("INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1, '{\"name\":\"SWEEP-LINKED-PROFILE\"}'::jsonb, 'confirmed', now())", [cid]);
  await w.q("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [emp.userId, cid]);
  for (const sub of ["profile", "matches", "consent", "settings", "eligibility"]) {
    const r = await probe(w.base, "GET", `/jobsearch/candidates/${cid}/${sub}`, emp.token);
    assert.ok(DENIED.has(r.status), `linked employer GET ${sub} -> ${r.status}`);
    assert.ok(!r.text.includes("SWEEP-LINKED"), sub);
  }
  assert.ok(DENIED.has((await probe(w.base, "GET", "/jobsearch/events", emp.token)).status));
  assert.ok(DENIED.has((await probe(w.base, "GET", "/jobsearch/applications", emp.token)).status));
  const scope = require("../modules/jobsearch/scope");
  for (const role of ["Employer", "Agency"]) {
    assert.equal(scope.candidateScopeSql({ id: emp.userId, role }, "c").clause, "FALSE", `${role} has no candidate scope`);
    await assert.rejects(() => scope.assertCandidateAccess({ id: emp.userId, role }, cid), (e) => e.status === 404);
  }
  // 4. Forged / mismatched tokens: a portal role claimed on a candidate's user id (or the reverse) is a dead session.
  const candUserId = victim.userId;
  const tvOf = async (id) => (await w.one("SELECT token_version AS tv FROM users WHERE id = $1", [id])).tv;
  const forged = [
    ["Employer claim on the candidate's user id", jwt.sign({ id: candUserId, role: "Employer", tv: await tvOf(candUserId) }, process.env.JWT_SECRET)],
    ["Agency claim on the candidate's user id", jwt.sign({ id: candUserId, role: "Agency", tv: await tvOf(candUserId) }, process.env.JWT_SECRET)],
    ["Candidate claim on the employer's user id", jwt.sign({ id: emp.userId, role: "Candidate", tv: await tvOf(emp.userId) }, process.env.JWT_SECRET)],
    ["Employer token without tv", jwt.sign({ id: emp.userId, role: "Employer" }, process.env.JWT_SECRET)],
    ["Employer token signed with another secret", jwt.sign({ id: emp.userId, role: "Employer", tv: 0 }, "not-the-secret")],
  ];
  for (const [label, token] of forged) {
    for (const url of ["/jobsearch/candidates/1/profile", "/jobsearch/applications", "/jobsearch/events", "/employer/requests", "/agency/candidates"]) {
      const r = await probe(w.base, "GET", url, token);
      assert.ok([400, 401, 403, 404].includes(r.status) && !r.stream, `${label}: GET ${url} -> ${r.status}`);
      assert.deepEqual(leaked(sentinels, "none", r.text), [], `${label} ${url}`);
    }
  }
  assert.ok(portalToken, "helper imported");
});
