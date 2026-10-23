// Scheduler + automatic-mode orchestration (Task 12). Real Postgres (a fresh schema per test), the
// test_fixture source with a seeded feed, sandbox mail only, and a fake clock passed to tick().
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { makePdf } = require("./helpers/docs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-scheduler-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "js-sched-"));
process.env.MAIL_PROVIDER = "sandbox";
process.env.MAIL_SANDBOX_ALLOWLIST = "*@acme*.example";
process.env.MAIL_FROM = "applications@vita.test.invalid";
delete process.env.CLAMAV_HOST;
delete process.env.MAIL_REAL_SEND;
delete process.env.APPLICATIONS_PER_TICK;
delete process.env.MATCH_AUTO_PREPARE_MIN;

const scheduler = require("../modules/jobsearch/scheduler");
const fixture = require("../modules/jobsearch/sources/testFixture");
const storage = require("../modules/jobsearch/storage");
const jobStore = require("../modules/jobsearch/jobStore");
const consentService = require("../modules/jobsearch/consentService");
const settingsService = require("../modules/jobsearch/settingsService");
const workers = require("../modules/jobsearch/workers");

const PROFILE = {
  name: "Karim Benali",
  email: "karim@example.com",
  profession: "Electrician",
  skills: ["wiring", "conduit bending", "plc"],
  experience: [{ title: "Electrician", employer: "Sfax Power Co", start: "2012-01", end: null }],
  certificates: [],
  languages: [{ lang: "English", level: "fluent" }],
};
const HOUR = 3600 * 1000;
const NO_SLEEP = async () => {};

let pool;
let cleanupDb;
let app;
let n = 0;

async function fresh() {
  if (cleanupDb) await cleanupDb();
  ({ pool, cleanup: cleanupDb } = await createTestDb());
  app = loadApp(pool);
  fixture._reset();
}
test.after(async () => {
  if (cleanupDb) await cleanupDb();
});

const q = (sql, params) => pool.query(sql, params);
const count = async (sql, params) => Number((await q(sql, params)).rows[0].n);
const mails = () => count("SELECT count(*) AS n FROM js_sandbox_mail");
const appsOf = async (cid) => (await q("SELECT * FROM js_applications WHERE candidate_id=$1 ORDER BY id", [cid])).rows;
const tasksOf = async (appId) => (await q("SELECT * FROM js_tasks WHERE application_id=$1 ORDER BY id", [appId])).rows;
// Fake clock: always ahead of the wall clock so items enqueued with DB now() are due for this tick.
const T0 = () => new Date(Math.ceil((Date.now() + 2 * 60000) / 60000) * 60000);
const tick = (now, deps = {}) => scheduler.tick(now, { deps: { sleep: NO_SLEEP, ...deps } });

async function mkUser(role) {
  n += 1;
  return (await q("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`U${n}`, `u${n}-sched@test.invalid`, role])).rows[0].id;
}

/** Employer pre-created (normalized name = what the feed upserts), optionally with a verified contact + support confirmation. */
async function employer(w, { contact = true, domain = true, confirmed = false } = {}) {
  n += 1;
  const name = `Acme Power ${n}`;
  const dom = `acme${n}.example`;
  const id = (await q("INSERT INTO js_employers (name, normalized_name, domain, verified_contact_email) VALUES ($1,$2,$3,$4) RETURNING id", [name, jobStore.normalizeEmployer(name), domain ? dom : null, contact ? `jobs@${dom}` : null])).rows[0].id;
  if (confirmed) await q("INSERT INTO js_employer_confirmations (employer_id, kind, evidence_text, confirmed_by) VALUES ($1,'work_auth_support','Employer HR confirmed support by phone',$2)", [id, w.adminId]);
  return { id, name, domain: dom };
}

function feedJob(emp, { text, title = "Electrician", id } = {}) {
  n += 1;
  return {
    sourceJobId: id || `fx-${n}`,
    url: `https://jobs.acme.example/fx-${n}`,
    title,
    employerName: emp.name,
    location: "Toronto, ON",
    country: "Canada",
    description: text || `Wiring and conduit bending for commercial sites. Open to international applicants. Send your CV to jobs@${emp.domain}.`,
  };
}

/** A candidate with account, confirmed profile, preferences, consent, settings and an approved CV. */
async function candidate(w, { mode = "search_only", consent = { search: true, prepare: true, submit: true }, needsSupport = true, cap = [5, 20], automaticRules = mode === "automatic" } = {}) {
  n += 1;
  const c = {};
  c.id = (await q("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`Cand ${n}`, `PP-SCH-${n}`, w.managerId])).rows[0].id;
  c.userId = await mkUser("Candidate");
  await q("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [c.userId, c.id]);
  await q("INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1,$2::jsonb,'confirmed',now())", [c.id, JSON.stringify(PROFILE)]);
  await q("INSERT INTO js_preferences (candidate_id, countries, categories, residence_country, needs_work_auth_support) VALUES ($1,'{Canada}','{Electrician}','Tunisia',$2)", [c.id, needsSupport]);
  await q("INSERT INTO js_consents (candidate_id, scope, version) VALUES ($1,$2::jsonb,'v1')", [c.id, JSON.stringify({ ...consent, countries: [] })]);
  await q("INSERT INTO js_candidate_settings (candidate_id, mode, cap_per_day, cap_per_week) VALUES ($1,$2,$3,$4)", [c.id, mode, cap[0], cap[1]]);
  const put = await storage.put(makePdf(`Karim Benali\nElectrician ${n}`), { candidateId: c.id });
  c.cvFileId = (await q("INSERT INTO js_cv_files (candidate_id, storage_key, sha256, version, language, approved, scan_status) VALUES ($1,$2,$3,1,'en',true,'clean') RETURNING id", [c.id, put.key, put.sha256])).rows[0].id;
  if (automaticRules) {
    await q("UPDATE js_candidate_settings SET admin_approved_by=$2, allowed_countries='{Canada}', approved_doc_versions=$3::jsonb WHERE candidate_id=$1", [c.id, w.adminId, JSON.stringify([{ cvFileId: c.cvFileId }])]);
    await q("INSERT INTO js_automation_rules (candidate_id, rule, approved_by, approved_at, active) VALUES ($1,'{}'::jsonb,$2,now(),true)", [c.id, w.adminId]);
  }
  return c;
}

async function world() {
  await fresh();
  const w = {};
  w.adminId = await mkUser("Admin");
  w.admin = { id: w.adminId, role: "Admin" };
  w.managerId = await mkUser("Manager");
  return w;
}

// ---------------------------------------------------------------- cron evaluator (pure)

test("cron: parse/validate 5 fields; invalid expressions throw", () => {
  for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-1 * * * *", "a * * * *", "1-2-3 * * * *"]) {
    assert.throws(() => scheduler.parseCron(bad), Error, bad);
  }
  assert.doesNotThrow(() => scheduler.parseCron("0 */6 * * *"));
});

test("cron: every 6 hours, lists, ranges, steps", () => {
  const at = (iso) => new Date(iso);
  const six = "0 */6 * * *";
  assert.equal(scheduler.cronMatches(six, at("2026-10-23T06:00:00Z")), true);
  assert.equal(scheduler.cronMatches(six, at("2026-10-23T07:00:00Z")), false);
  assert.equal(scheduler.cronMatches(six, at("2026-10-23T06:01:00Z")), false);
  assert.equal(scheduler.previousFire(six, at("2026-10-23T11:59:00Z")).toISOString(), "2026-10-23T06:00:00.000Z");
  assert.equal(scheduler.previousFire(six, at("2026-10-23T12:00:30Z")).toISOString(), "2026-10-23T12:00:00.000Z");
  assert.equal(scheduler.previousFire(six, at("2026-10-23T03:00:00Z")).toISOString(), "2026-10-23T00:00:00.000Z");
  // lists + ranges + range steps
  assert.equal(scheduler.previousFire("15,45 9-17 * * *", at("2026-10-23T08:30:00Z")).toISOString(), "2026-10-22T17:45:00.000Z");
  assert.equal(scheduler.previousFire("15,45 9-17 * * *", at("2026-10-23T09:50:00Z")).toISOString(), "2026-10-23T09:45:00.000Z");
  assert.equal(scheduler.previousFire("0 8-20/4 * * *", at("2026-10-23T19:00:00Z")).toISOString(), "2026-10-23T16:00:00.000Z");
  assert.equal(scheduler.previousFire("5/20 * * * *", at("2026-10-23T10:44:00Z")).toISOString(), "2026-10-23T10:25:00.000Z");
  // due: never ran -> due; ran after the last fire -> not due; a fire passed since -> due
  assert.equal(scheduler.isDue(six, null, at("2026-10-23T07:00:00Z")), true);
  assert.equal(scheduler.isDue(six, at("2026-10-23T06:30:00Z"), at("2026-10-23T11:59:00Z")), false);
  assert.equal(scheduler.isDue(six, at("2026-10-23T06:30:00Z"), at("2026-10-23T12:00:00Z")), true);
  assert.equal(scheduler.isDue(null, at("2026-10-23T05:59:00Z"), at("2026-10-23T06:00:00Z")), true, "null schedule = default every 6 h");
});

test("cron: month / day-of-month / day-of-week edges (OR when both restricted, 7 = Sunday, month boundaries)", () => {
  const at = (iso) => new Date(iso);
  // 2026-10-25 is a Sunday
  assert.equal(scheduler.cronMatches("0 9 * * 0", at("2026-10-25T09:00:00Z")), true);
  assert.equal(scheduler.cronMatches("0 9 * * 7", at("2026-10-25T09:00:00Z")), true);
  assert.equal(scheduler.cronMatches("0 9 * * 1-5", at("2026-10-25T09:00:00Z")), false);
  assert.equal(scheduler.previousFire("0 9 * * 1-5", at("2026-10-25T12:00:00Z")).toISOString(), "2026-10-23T09:00:00.000Z", "weekend skipped back to Friday");
  // dom AND dow restricted: either matches (1st of month OR Monday)
  assert.equal(scheduler.cronMatches("0 0 1 * 1", at("2026-10-26T00:00:00Z")), true, "Monday");
  assert.equal(scheduler.cronMatches("0 0 1 * 1", at("2026-10-01T00:00:00Z")), true, "1st (a Thursday)");
  assert.equal(scheduler.cronMatches("0 0 1 * 1", at("2026-10-02T00:00:00Z")), false);
  // dom restricted, dow '*': only the dom
  assert.equal(scheduler.cronMatches("0 0 31 * *", at("2026-10-31T00:00:00Z")), true);
  assert.equal(scheduler.previousFire("0 0 31 * *", at("2026-12-15T00:00:00Z")).toISOString(), "2026-10-31T00:00:00.000Z", "November has no 31st");
  // month list + crossing a year boundary
  assert.equal(scheduler.previousFire("30 6 1 1,7 *", at("2026-03-10T00:00:00Z")).toISOString(), "2026-01-01T06:30:00.000Z");
  assert.equal(scheduler.previousFire("30 6 1 7 *", at("2026-03-10T00:00:00Z")).toISOString(), "2025-07-01T06:30:00.000Z");
  assert.equal(scheduler.previousFire("0 0 29 2 *", at("2026-10-23T00:00:00Z")).toISOString(), "2024-02-29T00:00:00.000Z", "leap day");
});

// ---------------------------------------------------------------- modes

test("search_only: tick searches + matches, ZERO applications, ZERO mails", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp), feedJob(emp, { title: "Electrician Apprentice" })] });
  const c = await candidate(w, { mode: "search_only" });
  const s = await tick(T0());
  assert.deepEqual(s.errors, []);
  assert.equal(s.searchesQueued, 1);
  assert.ok(s.queueProcessed >= 1);
  assert.ok(s.matched >= 1, JSON.stringify(s));
  assert.ok((await count("SELECT count(*) AS n FROM js_matches WHERE candidate_id=$1", [c.id])) >= 1);
  assert.equal((await appsOf(c.id)).length, 0);
  assert.equal(s.applicationsCreated, 0);
  assert.equal(await mails(), 0);
  // scheduled search ran with the candidate's query and recorded a run at the tick clock
  assert.equal(fixture._state.searchCalls.length >= 1, true);
  assert.deepEqual(fixture._state.searchCalls[0].keywords, ["Electrician"]);
});

test("prepare_for_approval: application ready_for_review (linked candidate/job/employer/staff, audited system:scheduler), ZERO mails; second tick no duplicates", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp)] });
  const c = await candidate(w, { mode: "prepare_for_approval" });
  const t0 = T0();
  const s = await tick(t0);
  assert.deepEqual(s.errors, []);
  assert.equal(s.applicationsCreated, 1);
  assert.equal(s.prepared, 1);
  assert.equal(s.autoApproved, 0);
  assert.equal(s.queuedForSend, 0);
  const [a] = await appsOf(c.id);
  assert.equal(a.status, "ready_for_review");
  assert.equal(a.mode_at_creation, "prepare_for_approval");
  assert.equal(a.responsible_user_id, w.managerId, "responsible staff = candidate's assigned staff");
  const job = (await q("SELECT * FROM js_jobs WHERE id=$1", [a.job_id])).rows[0];
  assert.equal(job.employer_id, emp.id, "canonical employer");
  assert.equal((await q("SELECT count(*)::int AS n FROM js_jobs")).rows[0].n, 1, "one canonical job");
  assert.ok((await q("SELECT 1 FROM js_matches WHERE candidate_id=$1 AND job_id=$2", [c.id, a.job_id])).rowCount);
  const tl = (await q("SELECT actor, event FROM js_timeline WHERE application_id=$1 ORDER BY id", [a.id])).rows;
  assert.ok(tl.length && tl.every((e) => e.actor === "system:scheduler"), JSON.stringify(tl));
  const audits = (await q("SELECT DISTINCT action FROM js_audit_events WHERE application_id=$1 AND actor='system:scheduler'", [a.id])).rows.map((r) => r.action);
  for (const x of ["scheduler.application_created", "scheduler.prepared", "application.create", "application.prepare"]) assert.ok(audits.includes(x), x);
  assert.equal(await mails(), 0);
  assert.equal(await count("SELECT count(*) AS n FROM js_submissions"), 0);

  const s2 = await tick(new Date(t0.getTime() + HOUR));
  assert.deepEqual(s2.errors, []);
  assert.equal(s2.applicationsCreated, 0);
  assert.equal((await appsOf(c.id)).length, 1);
  assert.equal((await appsOf(c.id))[0].status, "ready_for_review");
  assert.equal(await mails(), 0);
  assert.equal(await count("SELECT count(*) AS n FROM js_tasks"), 0);
});

test("prepare_for_approval: a human approval is NOT queued by the scheduler (staff queue it); still zero mails", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp)] });
  const c = await candidate(w, { mode: "prepare_for_approval" });
  const t0 = T0();
  await tick(t0);
  const [a] = await appsOf(c.id);
  await require("../modules/jobsearch/applicationService").approveApplication({ id: a.id, actor: { id: w.managerId, role: "Manager" }, reason: "looks good" });
  for (const h of [1, 7]) {
    const s = await tick(new Date(t0.getTime() + h * HOUR));
    assert.equal(s.queuedForSend + s.heldRequeued, 0);
  }
  assert.equal((await appsOf(c.id))[0].status, "approved");
  assert.equal(await mails(), 0);
  assert.equal(await count("SELECT count(*) AS n FROM js_submissions"), 0);
});

test("automatic + consent + admin rules + CONFIRMED employer support (needs-support candidate abroad): exactly one mail to the verified employer contact; second tick idempotent", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp)] });
  const c = await candidate(w, { mode: "automatic", needsSupport: true });
  const t0 = T0();
  const s = await tick(t0);
  assert.deepEqual(s.errors, []);
  assert.equal(s.applicationsCreated, 1);
  assert.equal(s.autoApproved, 1, JSON.stringify(s));
  assert.equal(s.queuedForSend, 1);
  const out = (await q("SELECT * FROM js_sandbox_mail")).rows;
  assert.equal(out.length, 1);
  assert.equal(out[0].to_addr, `jobs@${emp.domain}`);
  const [a] = await appsOf(c.id);
  assert.equal(a.status, "sent");
  const approval = (await q("SELECT actor FROM js_timeline WHERE application_id=$1 AND event='status_changed' AND detail->>'to'='approved'", [a.id])).rows[0];
  assert.equal(approval.actor, "system:auto");
  assert.ok((await q("SELECT 1 FROM js_audit_events WHERE application_id=$1 AND actor='system:scheduler' AND action='scheduler.queued_for_send'", [a.id])).rowCount);
  assert.equal((await tasksOf(a.id)).length, 0);

  for (const h of [1, 7]) {
    const sN = await tick(new Date(t0.getTime() + h * HOUR));
    assert.deepEqual(sN.errors, []);
    assert.equal(sN.applicationsCreated + sN.autoApproved + sN.queuedForSend + sN.tasksOpened, 0, JSON.stringify(sN));
  }
  assert.equal(await mails(), 1);
  assert.equal((await appsOf(c.id)).length, 1);
  assert.equal(await count("SELECT count(*) AS n FROM js_submissions"), 1);
  assert.equal(await count("SELECT count(*) AS n FROM js_tasks"), 0);
});

test("automatic WITHOUT submit consent: ready_for_review + one needs_human_approval task, zero mails, never sent; no duplicate task", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp)] });
  const c = await candidate(w, { mode: "automatic", consent: { search: true, prepare: true } });
  const t0 = T0();
  const s = await tick(t0);
  assert.deepEqual(s.errors, []);
  assert.equal(s.autoApproved, 0);
  const [a] = await appsOf(c.id);
  assert.equal(a.status, "ready_for_review");
  const tasks = await tasksOf(a.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].reason, "needs_human_approval");
  assert.match(tasks[0].detail, /no_submit_consent/);
  assert.equal(tasks[0].assigned_to, w.managerId);
  for (const h of [1, 7, 14]) await tick(new Date(t0.getTime() + h * HOUR));
  assert.equal((await tasksOf(a.id)).length, 1, "never duplicated");
  assert.equal((await appsOf(c.id))[0].status, "ready_for_review");
  assert.equal(await mails(), 0);
  assert.equal(await count("SELECT count(*) AS n FROM js_submissions"), 0);
});

test("automatic + stated_in_ad (not confirmed) for a needs-support candidate abroad: stays ready_for_review + one task, zero mails", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: false });
  fixture._set({ jobs: [feedJob(emp, { text: `Wiring and conduit bending. LMIA approved position. Open to international applicants. Send your CV to jobs@${emp.domain}.` })] });
  const c = await candidate(w, { mode: "automatic", needsSupport: true });
  const t0 = T0();
  const s = await tick(t0);
  assert.deepEqual(s.errors, []);
  const m = (await q("SELECT employer_support FROM js_matches WHERE candidate_id=$1", [c.id])).rows[0];
  assert.equal(m.employer_support, "stated_in_ad");
  const [a] = await appsOf(c.id);
  assert.equal(a.status, "ready_for_review");
  const tasks = await tasksOf(a.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].reason, "needs_human_approval");
  assert.match(tasks[0].detail, /employer_support_not_confirmed/);
  await tick(new Date(t0.getTime() + HOUR));
  assert.equal((await tasksOf(a.id)).length, 1);
  assert.equal(await mails(), 0);
});

// ---------------------------------------------------------------- pauses

test("module paused: tick does nothing (no search, no queue processing, no matches/applications/mails)", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp)] });
  const c = await candidate(w, { mode: "automatic" });
  await settingsService.pauseModule(true, w.admin);
  const s = await tick(T0());
  assert.equal(s.skipped, "module_paused");
  assert.equal(fixture._state.calls, 0);
  assert.equal(await count("SELECT count(*) AS n FROM js_queue"), 0);
  assert.equal(await count("SELECT count(*) AS n FROM js_matches WHERE candidate_id=$1", [c.id]), 0);
  assert.equal(await count("SELECT count(*) AS n FROM js_applications"), 0);
  assert.equal(await count("SELECT count(*) AS n FROM js_runs"), 0);
  assert.equal(await mails(), 0);
});

test("source paused: that source is skipped (no search item, no run, no adapter call)", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp)] });
  await candidate(w, { mode: "search_only" });
  await require("../modules/jobsearch/searchRunner").ensureSources();
  await q("UPDATE js_sources SET paused=true WHERE key='test_fixture'");
  const s = await tick(T0());
  assert.deepEqual(s.errors, []);
  assert.equal(s.searchesQueued, 0);
  assert.equal(fixture._state.calls, 0);
  assert.equal(await count("SELECT count(*) AS n FROM js_queue WHERE kind='search'"), 0);
  assert.equal(await count("SELECT count(*) AS n FROM js_runs r JOIN js_sources s ON s.id=r.source_id WHERE s.key='test_fixture'"), 0);
});

for (const variant of ["candidate", "source", "module"]) {
  test(`pause -> resume (${variant}): held application re-queued exactly once and sent exactly once`, async () => {
    const w = await world();
    const emp = await employer(w, { confirmed: true });
    fixture._set({ jobs: [feedJob(emp)] });
    const c = await candidate(w, { mode: "automatic" });
    const pause = async (on) => {
      if (variant === "candidate") await settingsService.pauseCandidate(c.id, on);
      else if (variant === "source") await q("UPDATE js_sources SET paused=$1 WHERE key='test_fixture'", [on]);
      else await settingsService.pauseModule(on, w.admin);
    };
    const t0 = T0();
    // the pause lands after the application was queued, before this tick's send drain
    const s1 = await tick(t0, { onStep: async (name) => { if (name === "send") await pause(true); } });
    assert.deepEqual(s1.errors, []);
    assert.equal(s1.queuedForSend, 1);
    let [a] = await appsOf(c.id);
    assert.equal(a.status, "approved", "held, not cancelled");
    const last = (await q("SELECT event FROM js_timeline WHERE application_id=$1 AND event IN ('held_paused','status_changed') ORDER BY id DESC LIMIT 1", [a.id])).rows[0];
    assert.equal(last.event, "held_paused");
    assert.equal(await mails(), 0);

    if (variant === "module") {
      assert.equal((await tick(new Date(t0.getTime() + HOUR))).skipped, "module_paused");
    } else {
      const s2 = await tick(new Date(t0.getTime() + HOUR));
      assert.equal(s2.heldRequeued, 0, "still paused: not re-queued");
    }
    assert.equal(await mails(), 0);

    await pause(false);
    const s3 = await tick(new Date(t0.getTime() + 2 * HOUR));
    assert.deepEqual(s3.errors, []);
    assert.equal(s3.heldRequeued, 1);
    [a] = await appsOf(c.id);
    assert.equal(a.status, "sent");
    assert.equal(await mails(), 1);
    const s4 = await tick(new Date(t0.getTime() + 3 * HOUR));
    assert.equal(s4.heldRequeued, 0);
    assert.equal(await mails(), 1, "sent exactly once");
    const subs = (await q("SELECT attempt_no, status FROM js_submissions WHERE application_id=$1 ORDER BY id", [a.id])).rows;
    assert.deepEqual(subs.map((s) => s.status), ["failed", "sent"]);
    assert.equal(await count("SELECT count(*) AS n FROM js_tasks"), 0, "a hold opens no task");
  });
}

test("pause held by the background worker (module paused while the worker drains), then scheduler re-queues once", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp)] });
  const c = await candidate(w, { mode: "automatic" });
  const t0 = T0();
  await tick(t0, { onStep: async (name) => { if (name === "send") return "skip"; return undefined; } });
  assert.equal((await appsOf(c.id))[0].status, "queued");
  await settingsService.pauseModule(true, w.admin);
  await workers.tick({ now: new Date(t0.getTime() + 60000) });
  assert.equal((await appsOf(c.id))[0].status, "approved");
  await settingsService.pauseModule(false, w.admin);
  const s = await tick(new Date(t0.getTime() + HOUR));
  assert.equal(s.heldRequeued, 1);
  await tick(new Date(t0.getTime() + 2 * HOUR));
  assert.equal(await mails(), 1);
});

// ---------------------------------------------------------------- caps, consent, back-off

test("caps: cap_per_day=1 with two eligible matches -> one mail; the other stays ready_for_review with one task (cap)", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp), feedJob(emp, { title: "Electrician Maintenance" })] });
  const c = await candidate(w, { mode: "automatic", cap: [1, 10] });
  const t0 = T0();
  const s = await tick(t0);
  assert.deepEqual(s.errors, []);
  assert.equal(s.applicationsCreated, 2);
  assert.equal(s.autoApproved, 1);
  assert.equal(await mails(), 1);
  const apps = await appsOf(c.id);
  const other = apps.find((a) => a.status !== "sent");
  assert.equal(other.status, "ready_for_review");
  const tasks = await tasksOf(other.id);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].detail, /cap_per_day_exceeded/);
  await tick(new Date(t0.getTime() + 7 * HOUR)); // cap window (DB clock) still full
  assert.equal(await mails(), 1);
  assert.equal((await tasksOf(other.id)).length, 1);
});

test("consent withdrawn between ticks: nothing further is created or sent", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp)] });
  const c = await candidate(w, { mode: "automatic" });
  const t0 = T0();
  await tick(t0);
  assert.equal(await mails(), 1);
  await consentService.withdrawConsent({ user: w.admin, candidateId: c.id, scopeKey: "all" });
  fixture._set({ jobs: [...fixture._state.jobs, feedJob(emp, { title: "Electrician Lead" })] });
  const s = await tick(new Date(t0.getTime() + 7 * HOUR));
  assert.deepEqual(s.errors, []);
  assert.equal(s.searchesQueued, 0, "not search-eligible any more");
  assert.equal((await appsOf(c.id)).length, 1);
  assert.equal(await mails(), 1);
});

test("refused automatic queue (guard: recipient not verified) backs off: no retry within 6 h, one retry after, task never duplicated", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true, contact: false, domain: false });
  fixture._set({ jobs: [feedJob(emp, { text: "Wiring and conduit bending. Open to international applicants. Send your CV to hiring@acme-recruiters.example." })] });
  const c = await candidate(w, { mode: "automatic" });
  const refusals = () => count("SELECT count(*) AS n FROM js_audit_events WHERE action='submission.queue_refused'");
  const t0 = T0();
  const s1 = await tick(t0);
  assert.deepEqual(s1.errors, []);
  assert.equal(s1.autoApproved, 1);
  assert.equal(s1.queuedForSend, 0);
  const [a] = await appsOf(c.id);
  assert.equal(a.status, "approved");
  assert.equal(await refusals(), 1);
  let tasks = await tasksOf(a.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].reason, "recipient_unverified");

  await tick(new Date(t0.getTime() + HOUR));
  await tick(new Date(t0.getTime() + 5 * HOUR));
  assert.equal(await refusals(), 1, "no retry within the 6 h back-off");
  await tick(new Date(t0.getTime() + 6 * HOUR + 60000));
  assert.equal(await refusals(), 2, "retried once after the back-off");
  await tick(new Date(t0.getTime() + 7 * HOUR));
  assert.equal(await refusals(), 2);
  tasks = await tasksOf(a.id);
  assert.equal(tasks.length, 1, "task deduped");
  assert.equal(await mails(), 0);
});

// ---------------------------------------------------------------- isolation, bounds, re-entrancy

test("a failing step (search adapter throws; matching throws for one candidate) is recorded and does not stop the others", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp)] });
  const a = await candidate(w, { mode: "search_only" });
  const t0 = T0();
  await tick(t0); // jobs stored
  const b = await candidate(w, { mode: "prepare_for_approval" });
  await q("UPDATE js_candidate_settings SET mode='prepare_for_approval' WHERE candidate_id=$1", [a.id]);
  fixture._set({ failWith: "feed exploded" });
  const matchService = require("../modules/jobsearch/matchService");
  const s = await tick(new Date(t0.getTime() + 7 * HOUR), {
    matchCandidate: async (cid, opts) => {
      if (cid === a.id) throw new Error("match blew up");
      return matchService.matchCandidate(cid, opts);
    },
  });
  assert.ok(s.errors.some((e) => e.step === "search" && /feed exploded/.test(e.message)), JSON.stringify(s.errors));
  assert.ok(s.errors.some((e) => e.step === "match" && e.candidateId === a.id));
  assert.equal(s.applicationsCreated, 2, "orchestration still ran for both candidates' stored matches");
  assert.equal((await appsOf(b.id))[0].status, "ready_for_review");
});

test("per-tick caps: APPLICATIONS_PER_TICK bounds new applications per candidate per tick", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp), feedJob(emp, { title: "Electrician Maintenance" }), feedJob(emp, { title: "Electrician Lead" })] });
  const c = await candidate(w, { mode: "prepare_for_approval" });
  const t0 = T0();
  process.env.APPLICATIONS_PER_TICK = "1";
  try {
    assert.equal((await tick(t0)).applicationsCreated, 1);
    assert.equal((await appsOf(c.id)).length, 1);
    assert.equal((await tick(new Date(t0.getTime() + 60000))).applicationsCreated, 1);
    assert.equal((await appsOf(c.id)).length, 2);
  } finally {
    delete process.env.APPLICATIONS_PER_TICK;
  }
  const s = await tick(new Date(t0.getTime() + 120000), { limits: { queueBatch: 1, applicationsPerTick: 5 } });
  assert.equal(s.applicationsCreated, 1);
  assert.ok(s.queueProcessed <= 2, "queue drains are bounded by the batch cap");
});

test("re-entrancy: a concurrent tick is skipped in-process; guardedTick skips while another session holds the advisory lock", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  fixture._set({ jobs: [feedJob(emp)] });
  await candidate(w, { mode: "search_only" });
  const t0 = T0();
  const [x, y] = await Promise.all([tick(t0), tick(t0)]);
  assert.equal([x, y].filter((r) => r.skipped === "already_running").length, 1);
  assert.equal([x, y].filter((r) => !r.skipped).length, 1);
  const holder = await pool.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(19028, 1)");
    assert.equal((await scheduler.guardedTick(t0)).skipped, "locked_elsewhere");
    await holder.query("SELECT pg_advisory_unlock(19028, 1)");
  } finally {
    holder.release();
  }
  const g = await scheduler.guardedTick(new Date(t0.getTime() + 60000), { deps: { sleep: NO_SLEEP } });
  assert.equal(g.skipped, undefined, JSON.stringify(g));
});

test("expiry: a stale open job that is gone from its source closes its not-yet-approved applications", async () => {
  const w = await world();
  const emp = await employer(w, { confirmed: true });
  const fj = feedJob(emp);
  fixture._set({ jobs: [fj] });
  const c = await candidate(w, { mode: "prepare_for_approval" });
  const t0 = T0();
  await tick(t0);
  const [a] = await appsOf(c.id);
  assert.equal(a.status, "ready_for_review");
  fixture._set({ jobs: [] }); // vacancy removed at the source
  const s = await tick(new Date(t0.getTime() + 25 * HOUR));
  assert.deepEqual(s.errors, []);
  assert.ok(s.jobsRechecked >= 1);
  assert.equal(s.applicationsClosed, 1);
  assert.equal((await appsOf(c.id))[0].status, "closed");
  assert.equal((await q("SELECT status FROM js_jobs WHERE id=$1", [a.job_id])).rows[0].status, "closed");
  const tl = (await q("SELECT actor, detail FROM js_timeline WHERE application_id=$1 AND detail->>'to'='closed'", [a.id])).rows[0];
  assert.equal(tl.actor, "system:scheduler");
  assert.equal(tl.detail.reason, "job_closed");
});

// ---------------------------------------------------------------- admin endpoints + startup

test("admin endpoints: POST /jobsearch/scheduler/tick (admin only) and GET /jobsearch/scheduler/status", async () => {
  const w = await world();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tok = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, url, token) => {
    const res = await fetch(`${base}${url}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await call("POST", "/jobsearch/scheduler/tick", tok(w.managerId, "Manager"))).status, 403);
    assert.equal((await call("GET", "/jobsearch/scheduler/status", tok(w.managerId, "Manager"))).status, 403);
    const r = await call("POST", "/jobsearch/scheduler/tick", tok(w.adminId, "Admin"));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(typeof r.body.searchesQueued, "number");
    assert.ok(Array.isArray(r.body.errors));
    const st = await call("GET", "/jobsearch/scheduler/status", tok(w.adminId, "Admin"));
    assert.equal(st.status, 200);
    assert.equal(st.body.modulePaused, false);
    assert.equal(st.body.enabled, false, "disabled under NODE_ENV=test");
    assert.ok(st.body.lastTick && st.body.lastTick.summary);
    const fx = st.body.sources.find((s) => s.key === "test_fixture");
    assert.equal(fx.schedule, scheduler.DEFAULT_SCHEDULE);
    assert.ok("lastRun" in fx);
    assert.ok((await q("SELECT 1 FROM js_audit_events WHERE action='scheduler.manual_tick' AND actor=$1", [`user:${w.adminId}`])).rowCount);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("startJobSearchScheduler is disabled under NODE_ENV=test (and JOBSEARCH_SCHEDULER=off)", () => {
  assert.equal(scheduler.startJobSearchScheduler(), null);
  process.env.NODE_ENV = "production";
  process.env.JOBSEARCH_SCHEDULER = "off";
  process.env.JOBSEARCH_WORKERS = "off";
  try {
    assert.equal(scheduler.schedulerEnabled(), false);
    assert.equal(scheduler.startJobSearchScheduler(), null);
  } finally {
    process.env.NODE_ENV = "test";
    delete process.env.JOBSEARCH_SCHEDULER;
    delete process.env.JOBSEARCH_WORKERS;
  }
});
