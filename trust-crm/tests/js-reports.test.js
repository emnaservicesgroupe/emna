// Dashboard, reports, health, CSV exports and audit (Task 14). Real Postgres + HTTP. Every report and
// dashboard number is compared with an INDEPENDENT SQL count over the same rows and filters.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createTestDb, loadApp } = require("./helpers/db");
const { seed, tokens, T } = require("./helpers/jsReportsSeed");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-reports-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "js-reports-"));
process.env.MAIL_PROVIDER = "sandbox";
process.env.MAIL_SANDBOX_ALLOWLIST = "*@northwind*.example";
process.env.MAIL_FROM = "applications@vita.test.invalid";
process.env.JOBSEARCH_EXPORT_RATE_PER_HOUR = "1000";
delete process.env.JOBSEARCH_EXPORT_MAX_ROWS;
delete process.env.CLAMAV_HOST;
delete process.env.MAIL_REAL_SEND;

const exportService = require("../modules/jobsearch/exportService");

let pool;
let cleanup;
let server;
let base;
let s;
let tk;

test.before(async () => {
  ({ pool, cleanup } = await createTestDb());
  const app = loadApp(pool);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  s = await seed(pool);
  tk = tokens(s, process.env.JWT_SECRET);
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await cleanup();
});

const q = (sql, params) => pool.query(sql, params);
const num = async (sql, params) => Number((await q(sql, params)).rows[0].n);

async function get(url, token, headers = {}) {
  const res = await fetch(`${base}${url}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  // keep a BOM visible (res.text() would strip it)
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* csv */
  }
  return { status: res.status, body, text, headers: res.headers };
}

// ---------------------------------------------------------------- independent counts

// Scope predicates over candidates c (test-side, written independently of candidateScopeSql).
const scopeOf = (who) =>
  ({
    admin: "TRUE",
    X: `c.assigned_to = ${s.users.X}`,
    Y: `c.assigned_to = ${s.users.Y}`,
    A: `c.id = ${s.cand.A}`,
  })[who];

// Each metric: FROM clause exposing c (candidate) and j (job), and the event-time expression.
const METRIC_SQL = {
  found: { from: "js_matches m JOIN js_jobs j ON j.id = m.job_id JOIN candidates c ON c.id = m.candidate_id", at: "j.created_at" },
  matched: { from: "js_matches m JOIN js_jobs j ON j.id = m.job_id JOIN candidates c ON c.id = m.candidate_id", at: "m.created_at" },
  prepared: { from: "js_applications a JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id", at: "(SELECT min(t.created_at) FROM js_timeline t WHERE t.application_id = a.id AND t.event = 'package_built')" },
  submitted: { from: "js_submissions s JOIN js_applications a ON a.id = s.application_id JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id", at: "s.sent_at" },
  confirmed: { from: "js_submissions s JOIN js_applications a ON a.id = s.application_id JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id", at: "s.confirmed_at", where: "s.status = 'confirmed_submitted'" },
  failed: { from: "js_submissions s JOIN js_applications a ON a.id = s.application_id JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id", at: "s.created_at", where: "s.status = 'failed'" },
  outcome_unknown: { from: "js_submissions s JOIN js_applications a ON a.id = s.application_id JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id", at: "s.created_at", where: "s.status = 'outcome_unknown'" },
  replies: { from: "js_messages mg JOIN js_applications a ON a.id = mg.application_id JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id", at: "COALESCE(mg.received_at, mg.created_at)", where: "mg.direction = 'in' AND mg.review_state IN ('matched','resolved')" },
  interviews: { from: "js_appointments ap JOIN js_applications a ON a.id = ap.application_id JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id", at: "ap.created_at", where: "ap.status <> 'cancelled'" },
  offers: { from: "js_applications a JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id", at: "(SELECT min(t.created_at) FROM js_timeline t WHERE t.application_id = a.id AND t.detail->>'to' = 'offer')" },
  rejections: { from: "js_applications a JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id", at: "(SELECT min(t.created_at) FROM js_timeline t WHERE t.application_id = a.id AND t.detail->>'to' = 'rejected')" },
};

async function indep(metric, who, from, to, extra = "", params = []) {
  const m = METRIC_SQL[metric];
  const p = [from, to, ...params];
  return num(
    `SELECT count(*) AS n FROM ${m.from} WHERE c.is_deleted = false AND ${scopeOf(who)} AND ${m.at} >= $1 AND ${m.at} < $2 ${m.where ? `AND ${m.where}` : ""} ${extra}`,
    p
  );
}

async function indepAll(who, from, to, extra, params) {
  const out = {};
  for (const m of Object.keys(METRIC_SQL)) out[m] = await indep(m, who, from, to, extra, params);
  return out;
}

const qs = (o) => new URLSearchParams(o).toString();
const MARCH = { from: "2026-03-01", to: "2026-03-31" };
const MARCH_RANGE = [new Date("2026-03-01T00:00:00Z"), new Date("2026-04-01T00:00:00Z")];

// ---------------------------------------------------------------- reports

test("reports: totals equal independent COUNT(*)s for admin, staff X, staff Y and several filter combinations", async () => {
  const combos = [
    { who: "admin", token: "admin", params: {}, extra: "" },
    { who: "X", token: "X", params: {}, extra: "" },
    { who: "Y", token: "Y", params: {}, extra: "" },
    { who: "admin", token: "admin", params: { country: "canada" }, extra: "AND lower(j.country) = 'canada'" },
    { who: "X", token: "X", params: { sourceKey: "src_beta" }, extra: "AND (j.source_primary = 'src_beta' OR EXISTS (SELECT 1 FROM js_job_sightings g JOIN js_sources so ON so.id = g.source_id WHERE g.job_id = j.id AND so.key = 'src_beta'))" },
    { who: "admin", token: "admin", params: { status: "offer" }, extra: "AND EXISTS (SELECT 1 FROM js_applications a2 WHERE a2.candidate_id = c.id AND a2.job_id = j.id AND a2.status = 'offer')" },
    { who: "admin", token: "admin", params: { candidateId: () => String(s.cand.A) }, extra: () => `AND c.id = ${s.cand.A}` },
    { who: "X", token: "X", params: { staffId: () => String(s.users.X), employerId: () => String(s.employers[0]) }, extra: () => `AND c.assigned_to = ${s.users.X} AND j.employer_id = ${s.employers[0]}` },
  ];
  for (const combo of combos) {
    const params = Object.fromEntries(Object.entries(combo.params).map(([k, v]) => [k, typeof v === "function" ? v() : v]));
    const extra = typeof combo.extra === "function" ? combo.extra() : combo.extra;
    const r = await get(`/jobsearch/reports?${qs({ ...MARCH, groupBy: "candidate", ...params })}`, tk[combo.token]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const want = await indepAll(combo.who, ...MARCH_RANGE, extra);
    assert.deepEqual(r.body.totals, want, `${combo.who} ${JSON.stringify(params)}`);
    const sum = Object.fromEntries(Object.keys(want).map((k) => [k, r.body.rows.reduce((a, row) => a + row[k], 0)]));
    assert.deepEqual(sum, want, "rows add up to totals");
  }
  // sanity: the dataset is not trivially empty
  const all = await indepAll("admin", ...MARCH_RANGE, "");
  for (const [k, v] of Object.entries(all)) assert.ok(v > 0, `metric ${k} has data`);
});

test("reports: every groupBy variant adds up to the same totals; per-group rows equal filtered independent counts", async () => {
  const want = await indepAll("admin", ...MARCH_RANGE, "");
  for (const groupBy of ["candidate", "country", "staff", "profession", "employer", "source", "status", "period"]) {
    for (const period of groupBy === "period" ? ["day", "week", "month"] : [undefined]) {
      const r = await get(`/jobsearch/reports?${qs({ ...MARCH, groupBy, ...(period ? { period } : {}) })}`, tk.admin);
      assert.equal(r.status, 200, `${groupBy} ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.totals, want, `${groupBy}/${period}`);
    }
  }
  // per candidate row (candidate A) and per country row (Germany)
  const byCand = (await get(`/jobsearch/reports?${qs({ ...MARCH, groupBy: "candidate" })}`, tk.admin)).body;
  const rowA = byCand.rows.find((r) => r.key === String(s.cand.A));
  const { key: _k, label, ...countsA } = rowA; // eslint-disable-line no-unused-vars
  assert.equal(label, "Candidate A");
  assert.deepEqual(countsA, await indepAll("admin", ...MARCH_RANGE, `AND c.id = ${s.cand.A}`));
  assert.ok(!byCand.rows.some((r) => r.key === String(s.cand.D)), "soft-deleted candidate D never reported");
  const byCountry = (await get(`/jobsearch/reports?${qs({ ...MARCH, groupBy: "country" })}`, tk.admin)).body;
  const { key: _c, label: _l, ...de } = byCountry.rows.find((r) => r.key === "Germany"); // eslint-disable-line no-unused-vars
  assert.deepEqual(de, await indepAll("admin", ...MARCH_RANGE, "AND j.country = 'Germany'"));
  // per day: the 2026-03-08 bucket equals the counts of that day
  const byDay = (await get(`/jobsearch/reports?${qs({ ...MARCH, groupBy: "period", period: "day" })}`, tk.admin)).body;
  const { key: _d, label: _dl, ...d8 } = byDay.rows.find((r) => r.key === "2026-03-08"); // eslint-disable-line no-unused-vars
  assert.deepEqual(d8, await indepAll("admin", new Date("2026-03-08T00:00:00Z"), new Date("2026-03-09T00:00:00Z"), ""));
  // profession comes from the confirmed profile
  const byProf = (await get(`/jobsearch/reports?${qs({ ...MARCH, groupBy: "profession" })}`, tk.admin)).body;
  assert.deepEqual(byProf.rows.map((r) => r.key).sort(), ["Electrician", "Welder"]);
});

test("reports: staff see only their own staff row; staffId of another staff -> 403 unless admin", async () => {
  const y = await get(`/jobsearch/reports?${qs({ ...MARCH, groupBy: "staff" })}`, tk.Y);
  assert.equal(y.status, 200);
  assert.deepEqual(y.body.rows.map((r) => r.key), [String(s.users.Y)]);
  assert.equal(y.body.rows[0].label, "Staff Y");
  const x = await get(`/jobsearch/reports?${qs({ ...MARCH, groupBy: "staff" })}`, tk.X);
  assert.deepEqual(x.body.rows.map((r) => r.key), [String(s.users.X)]);
  assert.equal((await get(`/jobsearch/reports?${qs({ ...MARCH, staffId: String(s.users.X) })}`, tk.Y)).status, 403);
  const own = await get(`/jobsearch/reports?${qs({ ...MARCH, staffId: String(s.users.Y) })}`, tk.Y);
  assert.equal(own.status, 200);
  const adm = await get(`/jobsearch/reports?${qs({ ...MARCH, groupBy: "staff" })}`, tk.admin);
  assert.deepEqual(adm.body.rows.map((r) => r.key).sort(), [String(s.users.X), String(s.users.Y)].sort());
  // staff X's totals never include candidate C
  const xc = await get(`/jobsearch/reports?${qs({ ...MARCH, candidateId: String(s.cand.C) })}`, tk.X);
  assert.equal(xc.status, 200);
  assert.ok(Object.values(xc.body.totals).every((v) => v === 0), "C's rows are outside X's scope");
});

test("reports: date edges (from inclusive, date-time to exclusive, date-only to covers the day) and default range", async () => {
  // candidate A's 'sent' submission: sent_at = 2026-03-08T14:00:00Z
  const at = (from, to) => get(`/jobsearch/reports?${qs({ from, to, groupBy: "status" })}`, tk.admin);
  assert.equal((await at("2026-03-08T14:00:00Z", "2026-03-08T14:00:01Z")).body.totals.submitted, 1);
  assert.equal((await at("2026-03-08T13:59:59Z", "2026-03-08T14:00:00Z")).body.totals.submitted, 0);
  assert.equal((await at("2026-03-08T14:00:00.001Z", "2026-03-08T15:00:00Z")).body.totals.submitted, 0);
  const day = await at("2026-03-08", "2026-03-08");
  assert.equal(day.status, 200);
  assert.equal(day.body.to, "2026-03-09T00:00:00.000Z");
  assert.equal(day.body.totals.submitted, await indep("submitted", "admin", new Date("2026-03-08T00:00:00Z"), new Date("2026-03-09T00:00:00Z")));
  // offsets are honoured
  assert.equal((await at("2026-03-08T15:00:00+01:00", "2026-03-08T15:00:01+01:00")).body.totals.submitted, 1);
  // default: last 30 days ending now (seed is in March 2026, i.e. outside)
  const def = await get("/jobsearch/reports?groupBy=status", tk.admin);
  assert.equal(def.status, 200);
  assert.ok(Math.abs(new Date(def.body.to) - Date.now()) < 60000);
  assert.equal(new Date(def.body.to) - new Date(def.body.from), 30 * 86400000);
  // maximum range: 366 days ok, 367 -> 400
  assert.equal((await at("2025-03-02", "2026-03-02")).status, 200);
  assert.equal((await at("2025-03-01", "2026-03-02")).status, 400);
});

test("reports: invalid parameters -> 400 (never 500); unauthenticated 401; Candidate / Accountant / HR 403", async () => {
  const bad = [
    "from=yesterday",
    "from=2026-02-30",
    "from=2026-03-10&to=2026-03-01",
    "from=2026-03-01T10:00:00",
    "groupBy=bogus",
    "groupBy=period&period=year",
    "candidateId=abc",
    "candidateId=-1",
    "candidateId=1e3",
    "staffId=0",
    "status=bogus",
    "country=%3Cscript%3E",
    "sourceKey=a%20b",
    "from=2026-03-01&from=2026-03-02",
    "groupBy[x]=1",
    `country=${"a".repeat(300)}`,
  ];
  for (const b of bad) {
    const r = await get(`/jobsearch/reports?${b}`, tk.admin);
    assert.equal(r.status, 400, `${b} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal((await get("/jobsearch/reports")).status, 401);
  for (const who of ["candA", "accountant", "hr"]) assert.equal((await get(`/jobsearch/reports?${qs(MARCH)}`, tk[who])).status, 403, who);
});

// ---------------------------------------------------------------- dashboard

async function dashIndep(who, { candidateRole = false } = {}) {
  const sc = scopeOf(who);
  const out = {};
  out.matches = await num(`SELECT count(*) AS n FROM js_matches m JOIN js_jobs j ON j.id = m.job_id JOIN candidates c ON c.id = m.candidate_id WHERE j.status = 'open' AND c.is_deleted = false AND ${sc}`);
  for (const st of ["matched", "preparing", "ready_for_review", "approved", "queued", "sent", "confirmed_submitted", "failed", "outcome_unknown", "needs_staff", "cancelled", "closed", "interview", "offer", "rejected"]) {
    out[st] = await num(`SELECT count(*) AS n FROM js_applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.status = $1 AND c.is_deleted = false AND ${sc}`, [st]);
  }
  out.replies = await num(`SELECT count(*) AS n FROM js_messages m JOIN js_applications a ON a.id = m.application_id JOIN candidates c ON c.id = a.candidate_id WHERE m.direction = 'in' AND m.review_state <> 'needs_review' ${candidateRole ? "AND m.shared_with_candidate" : ""} AND c.is_deleted = false AND ${sc}`);
  out.interviews = await num(`SELECT count(*) AS n FROM js_appointments ap JOIN candidates c ON c.id = ap.candidate_id WHERE ap.status <> 'cancelled' AND c.is_deleted = false AND ${sc}`);
  out.tasks =
    (await num(`SELECT count(*) AS n FROM js_tasks t JOIN js_applications a ON a.id = t.application_id JOIN candidates c ON c.id = a.candidate_id WHERE t.status = 'open' AND c.is_deleted = false AND ${sc}`)) +
    (await num(`SELECT count(*) AS n FROM js_tasks t JOIN candidates c ON t.detail LIKE 'candidate:' || c.id || ':%' WHERE t.application_id IS NULL AND t.status = 'open' AND c.is_deleted = false AND ${sc}`));
  return out;
}

function checkDash(tot, want, { candidateRole = false } = {}) {
  assert.equal(tot.matches, want.matches);
  for (const k of ["matched", "preparing", "ready_for_review", "approved", "queued", "failed", "outcome_unknown", "needs_staff", "cancelled", "closed", "rejected"]) assert.equal(tot[k], want[k], k);
  assert.equal(tot.offers, want.offer);
  assert.equal(tot.interview_stage, want.interview);
  assert.deepEqual(tot.submitted, { total: want.sent + want.confirmed_submitted, awaiting_confirmation: want.sent, confirmed: want.confirmed_submitted });
  assert.equal(tot.replies, want.replies);
  assert.equal(tot.interviews, want.interviews);
  if (candidateRole) assert.equal(tot.open_tasks, undefined, "candidates never see staff task counts");
  else assert.equal(tot.open_tasks, want.tasks);
}

test("dashboard: totals equal independent counts for admin, staff X (excludes C and deleted D), staff Y and candidate A", async () => {
  const adm = await get("/jobsearch/dashboard", tk.admin);
  assert.equal(adm.status, 200);
  assert.equal(adm.body.scope, "all");
  checkDash(adm.body.totals, await dashIndep("admin"));
  const x = await get("/jobsearch/dashboard", tk.X);
  checkDash(x.body.totals, await dashIndep("X"));
  assert.deepEqual(x.body.candidates.map((c) => c.candidateId).sort(), [s.cand.A, s.cand.B].sort());
  assert.ok(x.body.attention.length > 0);
  assert.ok(x.body.attention.every((i) => [s.cand.A, s.cand.B].includes(i.candidateId)), "X's attention items never include C");
  assert.ok(x.body.attention.some((i) => i.reason === "prepare_consent_missing" && i.candidateId === s.cand.B && i.applicationId === null));
  const vd = x.body.attention.find((i) => i.reason === "verify_delivery");
  assert.match(vd.link, /^\/vita\/#\/applications\/\d+$/);
  assert.ok(vd.ageHours > 0);
  const y = await get("/jobsearch/dashboard", tk.Y);
  checkDash(y.body.totals, await dashIndep("Y"));
  assert.deepEqual(y.body.candidates.map((c) => c.candidateId), [s.cand.C]);
  const a = await get("/jobsearch/dashboard", tk.candA);
  assert.equal(a.status, 200);
  assert.equal(a.body.scope, "own");
  checkDash(a.body.totals, await dashIndep("A", { candidateRole: true }), { candidateRole: true });
  assert.deepEqual(a.body.attention, []);
  assert.deepEqual(a.body.candidates.map((c) => c.candidateId), [s.cand.A]);
  // per-candidate filter
  const xa = await get(`/jobsearch/dashboard?candidateId=${s.cand.A}`, tk.X);
  checkDash(xa.body.totals, await dashIndep("A"));
});

test("dashboard: tasks bound to no candidate (unmatched reply) appear for approvers only; candidate-level tasks follow scope", async () => {
  const msg = (await q("SELECT id FROM js_messages WHERE application_id IS NULL LIMIT 1")).rows[0].id;
  const t = (await q("INSERT INTO js_tasks (message_id, reason, detail, assigned_to) VALUES ($1,'unmatched_reply','Reply could not be matched',$2) RETURNING id", [msg, s.users.admin])).rows[0].id;
  try {
    for (const who of ["admin", "X"]) {
      const d = (await get("/jobsearch/dashboard", tk[who])).body;
      const item = d.attention.find((i) => i.taskId === t);
      assert.ok(item, `${who} sees the unmatched_reply task`);
      assert.equal(item.candidateId, null);
      assert.equal(item.link, `/vita/#/messages/${msg}`);
      assert.equal(d.totals.unassigned_open_tasks, 1);
      const filtered = (await get(`/jobsearch/dashboard?candidateId=${s.cand.A}`, tk[who])).body;
      assert.ok(!filtered.attention.some((i) => i.taskId === t), "not on a per-candidate dashboard");
    }
    const y = (await get("/jobsearch/dashboard", tk.Y)).body;
    assert.ok(!y.attention.some((i) => i.taskId === t), "Agent does not see unmatched items");
    assert.equal(y.totals.unassigned_open_tasks, undefined);
    assert.ok(!y.attention.some((i) => i.reason === "prepare_consent_missing"), "B's candidate-level task is not Y's");
    const a = (await get("/jobsearch/dashboard", tk.candA)).body;
    assert.deepEqual(a.attention, []);
    assert.equal(a.totals.unassigned_open_tasks, undefined);
  } finally {
    await q("DELETE FROM js_tasks WHERE id = $1", [t]);
  }
});

test("dashboard: other scopes' candidateId -> 404; deleted candidate -> 404; bad id -> 400; Accountant/HR 403; no token 401", async () => {
  assert.equal((await get(`/jobsearch/dashboard?candidateId=${s.cand.C}`, tk.X)).status, 404);
  assert.equal((await get(`/jobsearch/dashboard?candidateId=${s.cand.A}`, tk.Y)).status, 404);
  assert.equal((await get(`/jobsearch/dashboard?candidateId=${s.cand.C}`, tk.candA)).status, 404);
  assert.equal((await get(`/jobsearch/dashboard?candidateId=${s.cand.D}`, tk.admin)).status, 404);
  assert.equal((await get("/jobsearch/dashboard?candidateId=999999", tk.admin)).status, 404);
  assert.equal((await get("/jobsearch/dashboard?candidateId=x1", tk.admin)).status, 400);
  assert.equal((await get("/jobsearch/dashboard?candidateId=1&candidateId=2", tk.admin)).status, 400);
  assert.equal((await get("/jobsearch/dashboard", tk.accountant)).status, 403);
  assert.equal((await get("/jobsearch/dashboard", tk.hr)).status, 403);
  assert.equal((await get("/jobsearch/dashboard")).status, 401);
});

// ---------------------------------------------------------------- health

test("health: staff (Agent/Receptionist), Candidate, Accountant 403; Manager and Admin 200 with queue/stuck/tasks/sources and no secrets", async () => {
  for (const who of ["Y", "receptionist", "candA", "accountant", "hr"]) assert.equal((await get("/jobsearch/health", tk[who])).status, 403, who);
  assert.equal((await get("/jobsearch/health")).status, 401);
  for (const who of ["X", "admin"]) {
    const r = await get("/jobsearch/health", tk[who]);
    assert.equal(r.status, 200, who);
    const h = r.body;
    assert.equal(h.stuck.count, 1);
    assert.equal(h.stuck.items[0].kind, "submit");
    assert.equal(h.outcomeUnknown, await num("SELECT count(*) AS n FROM js_submissions WHERE status = 'outcome_unknown'"));
    assert.deepEqual(h.tasksAwaitingHuman.find((t) => t.reason === "verify_delivery"), { reason: "verify_delivery", count: await num("SELECT count(*) AS n FROM js_tasks WHERE status='open' AND reason='verify_delivery'") });
    assert.ok(h.queue.some((x) => x.kind === "search" && x.status === "pending" && x.count === 1));
    const beta = h.sources.find((x) => x.key === "src_beta");
    assert.equal(beta.lastRun.status, "failed");
    assert.equal(h.scheduler.lastTickAt, T(21).toISOString());
    assert.equal(h.scheduler.errors, 1);
    assert.equal(h.modulePaused, false);
    assert.equal(h.mail.status, "connected");
    assert.equal(h.storage.malwareScan, "scan_unavailable");
    assert.equal(h.storage.unscannedAttachments, process.env.ALLOW_UNSCANNED_ATTACHMENTS === "true" ? "allowed" : "blocked");
    for (const secret of ["S3cretPass", "abc123SECRET", "pw123", "KEY999", "ops@vita.example", "feeduser", "northwind*", "JWT", process.env.JWT_SECRET]) {
      assert.ok(!r.text.includes(secret), `health leaks ${secret}`);
    }
  }
});

test("Task 19 I-1/M-3 health mail: sandbox reports mode 'sandbox'; imap_smtp without MAIL_FROM shows outbound not_configured and names MAIL_FROM (no values)", async () => {
  const sb = (await get("/jobsearch/health", tk.admin)).body.mail;
  assert.equal(sb.mode, "sandbox");
  assert.equal(sb.realSend, false);
  const keys = ["MAIL_PROVIDER", "MAIL_SMTP_HOST", "MAIL_SMTP_USER", "MAIL_SMTP_PASS", "MAIL_FROM", "MAIL_REAL_SEND"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { MAIL_PROVIDER: "imap_smtp", MAIL_SMTP_HOST: "smtp.example.test", MAIL_SMTP_USER: "vita", MAIL_SMTP_PASS: "S3cretPass", MAIL_REAL_SEND: "true" });
  delete process.env.MAIL_FROM;
  try {
    const r = await get("/jobsearch/health", tk.admin);
    assert.equal(r.body.mail.mode, "smtp");
    assert.equal(r.body.mail.outbound, "not_configured");
    assert.equal(r.body.mail.status, "requires_setup");
    assert.deepEqual(r.body.mail.problems, ["MAIL_FROM"]);
    assert.ok(!r.text.includes("S3cretPass"));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ---------------------------------------------------------------- CSV

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') inQ = false;
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const records = (text) => {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const lines = rows[0][0].startsWith("# truncated") ? rows.slice(1) : rows;
  const [header, ...data] = lines;
  return { header, data: data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))), truncated: rows[0][0].startsWith("# truncated") };
};

test("csvCell: formula triggers (= + - @ TAB CR) neutralised; quotes, commas, CRLF and unicode round-trip", () => {
  assert.equal(exportService.csvCell("=1+1"), "'=1+1");
  assert.equal(exportService.csvCell("+33 1"), "'+33 1");
  assert.equal(exportService.csvCell("-2"), "'-2");
  assert.equal(exportService.csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(exportService.csvCell("\tcmd"), "'\tcmd");
  assert.equal(exportService.csvCell("\rcmd"), "\"'\rcmd\"");
  assert.equal(exportService.csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(exportService.csvCell("plain"), "plain");
  assert.equal(exportService.csvCell(null), "");
  // first VISIBLE character decides (spaces, tabs, NBSP, zero-width, BOM, line breaks skipped); full-width triggers too
  for (const v of [" =cmd", "\n=cmd", " =1", "\u200B=HYPERLINK(\"http://x\")", "\u00A0@SUM(1)", "\u2060-1", "\uFEFF=1", "\uFF1D1+1", "\uFF0B1", "\uFF0D1", "\uFF20x", "\t \r\n =1"]) {
    const cell = exportService.csvCell(v);
    assert.ok(cell.startsWith("'") || cell.startsWith(`"'`), `${JSON.stringify(v)} -> ${JSON.stringify(cell)}`);
    assert.equal(records(exportService.toCsv([{ key: "v", header: "v" }], [{ v }])).data[0].v, `'${v}`, "content preserved after the apostrophe");
  }
  for (const v of ["hello", "Re: offer", "a = b", "x@y.example", "10-2", "Zoë", "東京"]) assert.equal(exportService.csvCell(v), v, `normal text unchanged: ${v}`);
  // per-cell cap: 2000 characters, the cut marked with an ellipsis
  const long = exportService.csvCell("x".repeat(5000));
  assert.equal(long.length, 2000);
  assert.ok(long.endsWith("…"));
  assert.equal(exportService.csvCell("y".repeat(2000)), "y".repeat(2000));
  const values = ['a,b', 'say "hi"', "line1\r\nline2", "Zoë — 東京, ok", "x\ny", " lead"];
  const csv = exportService.toCsv([{ key: "v", header: "v" }], values.map((v) => ({ v })));
  assert.deepEqual(records(csv).data.map((r) => r.v), values);
  assert.ok(exportService.toCsv([{ key: "v", header: "v" }], [], { bom: true }).startsWith("﻿"));
});

test("export.csv: headers, scope-filtered rows equal SQL counts, per-role columns, injection-safe cells, audit row each", async () => {
  const before = await num("SELECT count(*) AS n FROM js_audit_events WHERE action = 'export'");
  const r = await get("/jobsearch/export.csv?type=applications", tk.admin);
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers.get("content-type"), /^text\/csv; charset=utf-8/);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="vita-applications-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const all = records(r.text);
  assert.equal(all.data.length, await num("SELECT count(*) AS n FROM js_applications a JOIN candidates c ON c.id = a.candidate_id WHERE c.is_deleted = false"));
  assert.ok(!all.header.includes("storage_key"));
  // staff X: only A and B
  const x = records((await get("/jobsearch/export.csv?type=applications", tk.X)).text);
  assert.equal(x.data.length, await num(`SELECT count(*) AS n FROM js_applications a JOIN candidates c ON c.id = a.candidate_id WHERE c.is_deleted = false AND c.assigned_to = ${s.users.X}`));
  assert.ok(x.data.every((row) => [String(s.cand.A), String(s.cand.B)].includes(row.candidate_id)));
  // filters: status + country + date range
  const f = records((await get(`/jobsearch/export.csv?${qs({ type: "applications", status: "sent", country: "Canada", from: "2026-03-01", to: "2026-03-31" })}`, tk.admin)).text);
  assert.equal(f.data.length, await num("SELECT count(*) AS n FROM js_applications a JOIN candidates c ON c.id = a.candidate_id JOIN js_jobs j ON j.id = a.job_id WHERE c.is_deleted = false AND a.status = 'sent' AND j.country = 'Canada' AND a.created_at >= '2026-03-01' AND a.created_at < '2026-04-01'"));
  // candidate A: own applications only, redacted columns
  const ca = await get("/jobsearch/export.csv?type=applications", tk.candA);
  assert.equal(ca.status, 200);
  const cad = records(ca.text);
  assert.deepEqual(cad.header, ["id", "job_title", "employer", "country", "status", "employer_support", "employer_support_evidence", "notice", "created_at", "updated_at"]);
  assert.ok(cad.data.every((d) => d.notice === exportService.SUPPORT_NOTICE && d.employer_support === "unknown"));
  assert.deepEqual(cad.data.map((d) => Number(d.id)).sort((a, b) => a - b), s.apps.A.map((a) => a.id).sort((a, b) => a - b));
  assert.equal(records((await get("/jobsearch/export.csv?type=matches", tk.candA)).text).data.length, await num(`SELECT count(*) AS n FROM js_matches WHERE candidate_id = ${s.cand.A}`));
  for (const t of ["submissions", "messages", "tasks"]) assert.equal((await get(`/jobsearch/export.csv?type=${t}`, tk.candA)).status, 403, t);
  // submissions: recipient cells start with '=' in the data -> neutralised; provider ids only for approvers
  const subsX = records((await get("/jobsearch/export.csv?type=submissions", tk.X)).text);
  assert.ok(subsX.header.includes("provider_message_id"), "Manager (jobsearch:approve) sees provider ids");
  assert.ok(subsX.data.length > 0 && subsX.data.every((d) => d.recipient.startsWith("'=HYPERLINK(")));
  assert.ok(subsX.data.every((d) => /@[ab]\.example$/.test(d.recipient)), "X never sees C's recipients");
  const subsY = records((await get("/jobsearch/export.csv?type=submissions", tk.Y)).text);
  assert.ok(!subsY.header.includes("provider_message_id"), "Agent has no jobsearch:approve");
  assert.ok(!subsY.header.includes("recipient"), "Agent: no recipient addresses");
  const msgsY = records((await get("/jobsearch/export.csv?type=messages", tk.Y)).text);
  assert.ok(!msgsY.header.includes("from_addr") && !msgsY.header.includes("message_id"), "Agent: no sender addresses / message ids");
  assert.ok(msgsY.data.length > 0);
  assert.ok(records((await get("/jobsearch/export.csv?type=messages", tk.X)).text).header.includes("from_addr"), "Manager keeps sender addresses");
  // matches export (staff): label + evidence + notice; a confirmed label gets the 'confirmed' notice
  const mid = (await q(`SELECT m.id FROM js_matches m WHERE m.candidate_id = ${s.cand.B} ORDER BY id LIMIT 1`)).rows[0].id;
  await q("UPDATE js_matches SET employer_support = 'confirmed', employer_support_evidence = 'HR confirmed by phone' WHERE id = $1", [mid]);
  try {
    const mx = records((await get("/jobsearch/export.csv?type=matches", tk.X)).text);
    for (const k of ["employer_support", "employer_support_evidence", "notice"]) assert.ok(mx.header.includes(k), k);
    const conf = mx.data.find((d) => Number(d.id) === mid);
    assert.equal(conf.employer_support_evidence, "HR confirmed by phone");
    assert.equal(conf.notice, exportService.SUPPORT_NOTICE_CONFIRMED);
    assert.ok(mx.data.filter((d) => Number(d.id) !== mid).every((d) => d.notice === exportService.SUPPORT_NOTICE));
  } finally {
    await q("UPDATE js_matches SET employer_support = 'unknown', employer_support_evidence = NULL WHERE id = $1", [mid]);
  }
  assert.equal(subsY.data.length, await num(`SELECT count(*) AS n FROM js_submissions s JOIN js_applications a ON a.id = s.application_id JOIN candidates c ON c.id = a.candidate_id WHERE c.assigned_to = ${s.users.Y} AND c.is_deleted = false`));
  // messages: '+Re: ...' subject neutralised, quotes/newline round-trip; unmatched review queue not exported
  const msgs = records((await get("/jobsearch/export.csv?type=messages", tk.admin)).text);
  assert.ok(msgs.data.length > 0);
  for (const m of msgs.data) assert.equal(m.subject, `'+Re: application, "quoted" line\nsecond`);
  assert.ok(!msgs.data.some((m) => m.application_id === ""), "unmatched messages are not exported");
  assert.ok(!msgs.header.includes("body_sanitized"));
  const tasks = records((await get("/jobsearch/export.csv?type=tasks&status=open", tk.X)).text);
  assert.ok(!tasks.header.includes("detail"), "task detail text (may contain addresses) is not exported");
  // BOM option
  assert.ok((await get("/jobsearch/export.csv?type=matches&bom=1", tk.admin)).text.startsWith("﻿"));
  // one audit row (js_audit_events + audit_logs) per successful export
  const after = await num("SELECT count(*) AS n FROM js_audit_events WHERE action = 'export'");
  assert.equal(after - before, 13, "13 successful exports; refused (403) exports are not audited as exports");
  const last = (await q("SELECT * FROM js_audit_events WHERE action = 'export' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(last.actor, `user:${s.users.admin}`);
  assert.equal(last.detail.type, "matches");
  assert.equal(typeof last.detail.rows, "number");
  const logs = await num("SELECT count(*) AS n FROM audit_logs WHERE action = 'jobsearch.export'");
  assert.equal(logs, after);
});

test("export.csv: invalid params 400, Accountant/HR 403, unauthenticated 401, staff exporting another staff's candidates 403", async () => {
  for (const b of ["", "type=bogus", "type=applications&status=bogus", "type=submissions&status=matched", "type=applications&from=nope", "type=applications&candidateId=x", "type=applications&bom=yes", "type=applications&type=matches"]) {
    assert.equal((await get(`/jobsearch/export.csv?${b}`, tk.admin)).status, 400, b);
  }
  assert.equal((await get("/jobsearch/export.csv?type=applications", tk.accountant)).status, 403);
  assert.equal((await get("/jobsearch/export.csv?type=applications", tk.hr)).status, 403);
  assert.equal((await get("/jobsearch/export.csv?type=applications")).status, 401);
  assert.equal((await get(`/jobsearch/export.csv?type=applications&staffId=${s.users.X}`, tk.Y)).status, 403);
  const other = records((await get(`/jobsearch/export.csv?type=applications&candidateId=${s.cand.C}`, tk.X)).text);
  assert.equal(other.data.length, 0, "another scope's candidate yields no rows");
});

test("export.csv: row cap writes a '# truncated' first line; per-user rate limit -> 429 with Retry-After", async () => {
  process.env.JOBSEARCH_EXPORT_MAX_ROWS = "3";
  try {
    const r = await get("/jobsearch/export.csv?type=applications", tk.admin);
    assert.equal(r.status, 200);
    assert.ok(r.text.startsWith("# truncated"));
    const parsed = records(r.text);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.data.length, 3);
    assert.equal(r.headers.get("x-export-truncated"), "true");
    const audit = (await q("SELECT detail FROM js_audit_events WHERE action = 'export' ORDER BY id DESC LIMIT 1")).rows[0].detail;
    assert.equal(audit.truncated, true);
    assert.equal(audit.rows, 3);
  } finally {
    delete process.env.JOBSEARCH_EXPORT_MAX_ROWS;
  }
  process.env.JOBSEARCH_EXPORT_RATE_PER_HOUR = "2";
  exportService._resetRateLimit();
  try {
    assert.equal((await get("/jobsearch/export.csv?type=matches", tk.Y)).status, 200);
    assert.equal((await get("/jobsearch/export.csv?type=matches", tk.Y)).status, 200);
    const limited = await get("/jobsearch/export.csv?type=matches", tk.Y);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal((await get("/jobsearch/export.csv?type=matches", tk.X)).status, 200, "the limit is per user");
  } finally {
    process.env.JOBSEARCH_EXPORT_RATE_PER_HOUR = "1000";
    exportService._resetRateLimit();
  }
});

test("migration 010: lookup indexes exist", async () => {
  const idx = (await q("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()")).rows.map((r) => r.indexname);
  for (const name of [
    "js_applications_job_idx",
    "js_matches_job_idx",
    "js_job_sightings_job_idx",
    "js_submissions_application_idx",
    "js_timeline_app_created_idx",
    "js_tasks_application_idx",
    "js_tasks_status_reason_idx",
    "js_application_documents_app_idx",
    "js_appointments_candidate_idx",
    "js_messages_provider_msgid_idx",
    "js_audit_events_app_action_idx",
    "js_events_candidate_idx",
    "js_events_audience_idx",
    "js_queue_status_kind_run_idx",
    "js_runs_source_started_idx",
  ]) {
    assert.ok(idx.includes(name), name);
  }
});

// ---------------------------------------------------------------- audit (Task 14 D)
// Each key action, driven through the real routes/services, emits exactly ONE js_audit_events row for
// its action and exactly ONE audit_logs row. Runs in a fresh schema (the seed above has a stuck queue
// item and sources that a scheduler tick would act on).

const { makePdf } = require("./helpers/docs");
const { auditJs } = require("../utils/audit");
const jwtLib = require("jsonwebtoken");

const AUD = {};
const PROFILE = { name: "Karim Benali", email: "karim@example.com", profession: "Electrician", skills: ["Industrial wiring"], languages: [{ lang: "English", level: "fluent" }] };
const DEPS = { recheck: async () => ({ status: "open", verified: true }) };
let an = 0;

const aq = (sql, params) => AUD.pool.query(sql, params);
const anum = async (sql, params) => Number((await aq(sql, params)).rows[0].n);
const atok = (id, role) => jwtLib.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function acandTok(userId) {
  const tv = (await aq("SELECT token_version FROM users WHERE id=$1", [userId])).rows[0].token_version;
  return jwtLib.sign({ id: userId, role: "Candidate", tv }, process.env.JWT_SECRET, { expiresIn: "1h" });
}
async function call(method, url, token, body) {
  const res = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body: json };
}
async function auser(role) {
  an += 1;
  return (await aq("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`AU${an}`, `au${an}-audit@test.invalid`, role])).rows[0].id;
}

/** Candidate (account, confirmed profile, consent, settings, approved CV) + employer/job/match; application at `stage`. */
async function aworld(stage = "approved") {
  const applicationService = require("../modules/jobsearch/applicationService");
  const storage = require("../modules/jobsearch/storage");
  const jobStore = require("../modules/jobsearch/jobStore");
  const w = {};
  w.managerId = await auser("Manager");
  w.manager = { id: w.managerId, role: "Manager" };
  an += 1;
  w.candidateId = (await aq("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`ACand ${an}`, `PP-AUD-${an}`, w.managerId])).rows[0].id;
  w.userId = await auser("Candidate");
  await aq("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [w.userId, w.candidateId]);
  await aq("INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1,$2::jsonb,'confirmed',now())", [w.candidateId, JSON.stringify(PROFILE)]);
  await aq("INSERT INTO js_preferences (candidate_id, countries, residence_country, needs_work_auth_support) VALUES ($1,'{Canada}','Tunisia',false)", [w.candidateId]);
  await aq("INSERT INTO js_consents (candidate_id, scope, version) VALUES ($1,$2::jsonb,'v1')", [w.candidateId, JSON.stringify({ search: true, prepare: true, submit: true, countries: [] })]);
  await aq("INSERT INTO js_candidate_settings (candidate_id, mode, cap_per_day, cap_per_week) VALUES ($1,'prepare_for_approval',5,20)", [w.candidateId]);
  const put = await storage.put(makePdf(`Karim Benali\nElectrician ${an}`), { candidateId: w.candidateId });
  await aq("INSERT INTO js_cv_files (candidate_id, storage_key, sha256, version, language, approved, scan_status) VALUES ($1,$2,$3,1,'en',true,'clean')", [w.candidateId, put.key, put.sha256]);
  an += 1;
  w.domain = `northwind${an}.example`;
  const employerId = (await aq("INSERT INTO js_employers (name, normalized_name, domain, verified_contact_email) VALUES ($1,$2,$3,$4) RETURNING id", [`Northwind ${an}`, jobStore.normalizeEmployer(`Northwind ${an}`), w.domain, `jobs@${w.domain}`])).rows[0].id;
  const sourceId = (await aq("INSERT INTO js_sources (key, adapter, status) VALUES ($1,'partner_feed','connected') RETURNING id", [`a_src_${an}`])).rows[0].id;
  w.jobId = (await aq(
    "INSERT INTO js_jobs (title, country, location, employer_id, source_primary, dedupe_key, description_text, url) VALUES ('Electrician','Canada','Toronto, Canada',$1,$2,$3,$4,$5) RETURNING id",
    [employerId, `a_src_${an}`, `dk-audit-${an}`, `We are hiring an Electrician. Send your CV to jobs@${w.domain}.`, `https://jobs.example/a${an}`]
  )).rows[0].id;
  await aq("INSERT INTO js_job_sightings (job_id, source_id, source_job_id, url) VALUES ($1,$2,$3,$4)", [w.jobId, sourceId, `aj-${an}`, `https://jobs.example/a${an}`]);
  w.matchId = (await aq("INSERT INTO js_matches (candidate_id, job_id, score, employer_support) VALUES ($1,$2,80,'unknown') RETURNING id", [w.candidateId, w.jobId])).rows[0].id;
  if (stage === "match") return w;
  w.appId = (await applicationService.createFromMatch({ matchId: w.matchId, actor: w.manager })).id;
  if (stage === "matched") return w;
  await applicationService.prepareApplication({ id: w.appId, actor: w.manager });
  if (stage === "ready") return w;
  await applicationService.approveApplication({ id: w.appId, actor: w.manager, reason: "reviewed" });
  return w;
}

/** Runs fn and returns how many js_audit_events rows (jsAction) and audit_logs rows (logAction) it added. */
async function rowsAdded(jsAction, logAction, fn) {
  const c = async () => [await anum("SELECT count(*) AS n FROM js_audit_events WHERE action = $1", [jsAction]), await anum("SELECT count(*) AS n FROM audit_logs WHERE action = $1", [logAction])];
  const [j0, l0] = await c();
  const out = await fn();
  const [j1, l1] = await c();
  return { js: j1 - j0, logs: l1 - l0, out };
}

async function expectOne(label, jsAction, logAction, fn) {
  const r = await rowsAdded(jsAction, logAction, fn);
  assert.equal(r.js, 1, `${label}: js_audit_events '${jsAction}' rows = ${r.js}`);
  if (logAction) assert.equal(r.logs, 1, `${label}: audit_logs '${logAction}' rows = ${r.logs}`);
  return r.out;
}

test("audit: switch to a fresh schema for the audit checks", async () => {
  ({ pool: AUD.pool, cleanup: AUD.cleanup } = await createTestDb());
  require("../db").setPool(AUD.pool);
  AUD.adminId = await auser("Admin");
  AUD.admin = atok(AUD.adminId, "Admin");
});
test.after(async () => {
  if (AUD.cleanup) await AUD.cleanup();
});

test("auditJs: exactly one audit_logs row and one js_audit_events row; inside a rolled-back transaction neither", async () => {
  const r = await rowsAdded("test.thing", "jobsearch.test.thing", () => auditJs({ userId: AUD.adminId, action: "test.thing", entity: "js_test", entityId: 7, detail: { a: 1 } }));
  assert.deepEqual([r.js, r.logs], [1, 1]);
  const row = (await aq("SELECT * FROM js_audit_events WHERE action='test.thing'")).rows[0];
  assert.equal(row.actor, `user:${AUD.adminId}`);
  const log = (await aq("SELECT * FROM audit_logs WHERE action='jobsearch.test.thing'")).rows[0];
  assert.equal(log.table_name, "js_test");
  assert.equal(log.record_id, "7");
  const sys = await rowsAdded("test.sys", "jobsearch.test.sys", () => auditJs({ actor: "system:scheduler", action: "test.sys", entity: "js_test" }));
  assert.deepEqual([sys.js, sys.logs], [1, 1]);
  assert.equal((await aq("SELECT actor FROM js_audit_events WHERE action='test.sys'")).rows[0].actor, "system:scheduler");
  const client = await AUD.pool.connect();
  try {
    await client.query("BEGIN");
    await auditJs({ userId: AUD.adminId, action: "test.rolled", entity: "js_test", client });
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.equal(await anum("SELECT count(*) AS n FROM js_audit_events WHERE action='test.rolled'"), 0);
  assert.equal(await anum("SELECT count(*) AS n FROM audit_logs WHERE action='jobsearch.test.rolled'"), 0);
  await assert.rejects(() => auditJs({ userId: 1, action: "Bad Action", entity: "x" }));
});

test("audit: consent grant / withdraw, candidate pause / resume, module pause / resume, source pause / resume", async () => {
  const w = await aworld("match");
  const mtok = atok(w.managerId, "Manager");
  await expectOne("consent.grant", "consent.grant", "jobsearch.consent.grant", async () => {
    const r = await call("POST", `/jobsearch/candidates/${w.candidateId}/consent`, mtok, { scope: { search: true, prepare: true, submit: true }, version: "v2", recordedBy: "Phone call with candidate", evidenceNote: "Signed consent form scanned" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
  await expectOne("consent.withdraw", "consent.withdraw", "jobsearch.consent.withdraw", async () => {
    const r = await call("POST", `/jobsearch/candidates/${w.candidateId}/consent/withdraw`, await acandTok(w.userId), { scopeKey: "submit" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  await expectOne("candidate pause", "candidate.pause", "jobsearch.candidate.pause", async () => assert.equal((await call("POST", `/jobsearch/candidates/${w.candidateId}/pause`, mtok, { paused: true })).status, 200));
  await expectOne("candidate resume", "candidate.unpause", "jobsearch.candidate.unpause", async () => assert.equal((await call("POST", `/jobsearch/candidates/${w.candidateId}/pause`, mtok, { paused: false })).status, 200));
  await expectOne("module pause", "module.pause", "jobsearch.module.pause", async () => assert.equal((await call("POST", "/jobsearch/module/pause", AUD.admin, { paused: true })).status, 200));
  await expectOne("module resume", "module.unpause", "jobsearch.module.unpause", async () => assert.equal((await call("POST", "/jobsearch/module/pause", AUD.admin, { paused: false })).status, 200));
  await require("../modules/jobsearch/searchRunner").ensureSources();
  const key = (await aq("SELECT key FROM js_sources ORDER BY id LIMIT 1")).rows[0].key;
  await expectOne("source pause", "source.pause", "jobsearch.source.pause", async () => assert.equal((await call("POST", `/jobsearch/sources/${key}/pause`, AUD.admin)).status, 200));
  await expectOne("source resume", "source.resume", "jobsearch.source.resume", async () => assert.equal((await call("POST", `/jobsearch/sources/${key}/resume`, AUD.admin)).status, 200));
});

test("audit: application approve / reject / cancel and sharing authorization grant / revoke", async () => {
  const w1 = await aworld("ready");
  const mtok = atok(w1.managerId, "Manager");
  await expectOne("approve", "application.approve", "jobsearch.application.approve", async () => assert.equal((await call("POST", `/jobsearch/applications/${w1.appId}/approve`, mtok, { reason: "looks good" })).status, 200));
  const w2 = await aworld("ready");
  await expectOne("reject", "application.reject", "jobsearch.application.reject", async () => assert.equal((await call("POST", `/jobsearch/applications/${w2.appId}/reject`, atok(w2.managerId, "Manager"), { reason: "not a fit" })).status, 200));
  const w3 = await aworld("matched");
  await expectOne("cancel", "application.cancel", "jobsearch.application.cancel", async () => assert.equal((await call("POST", `/jobsearch/applications/${w3.appId}/cancel`, await acandTok(w3.userId), { reason: "changed my mind" })).status, 200));
  const w4 = await aworld("ready");
  const docId = (await aq("INSERT INTO documents (candidate_id, doc_type, file_path) VALUES ($1,'passport','/crm/p.pdf') RETURNING id", [w4.candidateId])).rows[0].id;
  const ctok = await acandTok(w4.userId);
  const grant = await expectOne("sharing grant", "sharing.grant", "jobsearch.sharing.grant", async () => {
    const r = await call("POST", `/jobsearch/applications/${w4.appId}/sharing-authorizations`, ctok, { documentId: docId, legitimateNeed: "Employer requires passport copy for visa" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  });
  await expectOne("sharing revoke", "sharing.revoke", "jobsearch.sharing.revoke", async () => assert.equal((await call("DELETE", `/jobsearch/applications/${w4.appId}/sharing-authorizations/${grant.id}`, ctok)).status, 200));
});

test("audit: submission queue / send / outcome_unknown / evidence recorded", async () => {
  const submitter = require("../modules/jobsearch/submitter");
  const w = await aworld("approved");
  const mtok = atok(w.managerId, "Manager");
  const queued = await expectOne("queue", "submission.queued", "jobsearch.submission.queue", async () => {
    const r = await call("POST", `/jobsearch/applications/${w.appId}/queue`, mtok);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  });
  // the route's default re-check needs the network: re-run through the service with the injected re-check instead
  const item = (await aq("SELECT * FROM js_queue WHERE kind='submit' AND payload->>'submissionId'=$1", [String(queued.submissionId)])).rows[0];
  await expectOne("send", "submission.sent", "jobsearch.submission.sent", async () => assert.equal((await submitter.handleSubmit(item, DEPS)).status, "sent"));
  await expectOne("evidence", "submission.evidence", "jobsearch.submission.evidence", async () => {
    const r = await call("POST", `/jobsearch/submissions/${queued.submissionId}/evidence`, mtok, { kind: "manual_confirmation", detail: { note: "Employer confirmed receipt by phone today" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  const w2 = await aworld("approved");
  const q2 = await submitter.queueSubmission(w2.appId, w2.manager, DEPS);
  const item2 = (await aq("SELECT * FROM js_queue WHERE kind='submit' AND payload->>'submissionId'=$1", [String(q2.submissionId)])).rows[0];
  const mailSend = async () => {
    const e = new Error("Connection timeout");
    e.code = "ETIMEDOUT";
    throw e;
  };
  await expectOne("outcome_unknown", "submission.outcome_unknown", "jobsearch.submission.outcome_unknown", async () => assert.equal((await submitter.handleSubmit(item2, { ...DEPS, mailSend })).status, "outcome_unknown"));
});

test("audit: user suspend / reinstate, export, message assign / share", async () => {
  const w = await aworld("approved");
  await expectOne("suspend", "account.suspend", "jobsearch.account.suspend", async () => assert.equal((await call("POST", `/jobsearch/admin/users/${w.userId}/suspend`, AUD.admin)).status, 200));
  await expectOne("reinstate", "account.reinstate", "jobsearch.account.reinstate", async () => assert.equal((await call("POST", `/jobsearch/admin/users/${w.userId}/reinstate`, AUD.admin)).status, 200));
  await expectOne("export", "export", "jobsearch.export", async () => assert.equal((await call("GET", "/jobsearch/export.csv?type=applications", AUD.admin)).status, 200));
  // message assign + share: an inbound message in the review queue, assigned to the application, then released
  const msgId = (await aq("INSERT INTO js_messages (direction, message_id, from_addr, subject, review_state, received_at, body_sanitized, ai_summary) VALUES ('in',$1,$2,'Re: application','needs_review',now(),'Hello','Employer replied') RETURNING id", [`<aud-${w.appId}@mail.example>`, `hr@${w.domain}`])).rows[0].id;
  const mtok = atok(w.managerId, "Manager");
  await expectOne("message assign", "message.assigned", "jobsearch.message.assign", async () => {
    const r = await call("POST", `/jobsearch/messages/${msgId}/assign`, AUD.admin, { applicationId: w.appId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  await expectOne("message share", "message.shared_with_candidate", "jobsearch.message.share", async () => assert.equal((await call("POST", `/jobsearch/messages/${msgId}/share-with-candidate`, mtok)).status, 200));
});

test("audit: scheduler tick (system:scheduler) - manual tick audited once; each automatic action once per application", async () => {
  const w = await aworld("match");
  await expectOne("manual tick", "scheduler.manual_tick", "jobsearch.scheduler.tick", async () => {
    const r = await call("POST", "/jobsearch/scheduler/tick", AUD.admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  const rows = (await aq("SELECT actor, action, application_id FROM js_audit_events WHERE candidate_id = $1 AND action LIKE 'scheduler.%' ORDER BY id", [w.candidateId])).rows;
  const created = rows.filter((r) => r.action === "scheduler.application_created");
  assert.ok(created.length >= 1, JSON.stringify(rows));
  assert.ok(created.some((r) => r.application_id === null) === false);
  for (const action of ["scheduler.application_created", "scheduler.prepared"]) {
    const per = new Map();
    for (const r of rows.filter((x) => x.action === action)) {
      assert.equal(r.actor, "system:scheduler");
      per.set(r.application_id, (per.get(r.application_id) || 0) + 1);
    }
    assert.ok([...per.values()].every((v) => v === 1), `${action}: one row per application ${JSON.stringify([...per])}`);
    assert.deepEqual([...per.keys()].sort(), created.map((r) => r.application_id).sort(), action);
  }
  const before = created.length;
  // a second tick does not repeat them
  assert.equal((await call("POST", "/jobsearch/scheduler/tick", AUD.admin)).status, 200);
  const again = (await aq("SELECT application_id, count(*)::int AS n FROM js_audit_events WHERE candidate_id = $1 AND action = 'scheduler.application_created' GROUP BY application_id", [w.candidateId])).rows;
  assert.ok(again.every((r) => r.n === 1), "never repeated for the same application");
  assert.ok(again.length >= before);
});
