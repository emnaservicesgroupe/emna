// Pre-send guard (Task 10). Real Postgres; guard.check is called directly (no HTTP). The job
// re-check is injected (no network) except in the tests that exercise jobStore.recheckJobDetailed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createTestDb } = require("./helpers/db");
const { makePdf } = require("./helpers/docs");
const PHRASES = require("./fixtures/js-handoff-phrases");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-guard-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "js-guard-"));
delete process.env.CLAMAV_HOST;

const guard = require("../modules/jobsearch/guard");
const applicationService = require("../modules/jobsearch/applicationService");
const consentService = require("../modules/jobsearch/consentService");
const jobStore = require("../modules/jobsearch/jobStore");
const storage = require("../modules/jobsearch/storage");
const testFixture = require("../modules/jobsearch/sources/testFixture");

const PROFILE = {
  name: "Karim Benali",
  email: "karim@example.com",
  profession: "Electrician",
  skills: ["Industrial wiring"],
  experience: [{ title: "Maintenance Electrician", employer: "Sfax Power Co", start: "2016", end: "2023" }],
  languages: [{ lang: "English", level: "fluent" }],
};
const OPEN = async () => ({ status: "open", verified: true });

let pool;
let cleanup;
let adminId;
let n = 0;

test.before(async () => {
  ({ pool, cleanup } = await createTestDb());
  require("../db").setPool(pool);
  adminId = (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('Adm','adm-guard@test.invalid','x','Admin') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO js_sources (key, adapter, status) VALUES ('test_fixture','test_fixture','connected'),('manual_import','manual_import','manual') ON CONFLICT (key) DO NOTHING");
});
test.after(async () => {
  await cleanup();
});

const q = (sql, params) => pool.query(sql, params);
const status = async (id) => (await q("SELECT status FROM js_applications WHERE id=$1", [id])).rows[0].status;
const check = (id, opts = {}) => guard.check(id, { recheck: OPEN, ...opts });

async function mkUser(role, active = true) {
  n += 1;
  return (await q("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x',$3,$4) RETURNING id", [`U${n}`, `u${n}-guard@test.invalid`, role, active])).rows[0].id;
}

/**
 * A candidate with account, confirmed profile, consent, settings, approved CV, a job (own employer,
 * own source + sighting), a match, and an application prepared and approved through the real
 * applicationService paths (human Manager unless opts.auto).
 */
async function world(opts = {}) {
  const w = {};
  w.managerId = opts.managerId || (await mkUser("Manager"));
  w.manager = { id: w.managerId, role: "Manager" };
  if (opts.candidate) Object.assign(w, opts.candidate);
  else {
    n += 1;
    w.candidateId = (await q("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`Cand ${n}`, `PP-G-${n}`, w.managerId])).rows[0].id;
    w.userId = await mkUser("Candidate");
    await q("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [w.userId, w.candidateId]);
    await q("INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1,$2::jsonb,'confirmed',now())", [w.candidateId, JSON.stringify(opts.profile || PROFILE)]);
    await q("INSERT INTO js_preferences (candidate_id, countries, residence_country, needs_work_auth_support) VALUES ($1,'{Canada}',$2,$3)", [w.candidateId, opts.residence || "Tunisia", opts.needsSupport === undefined ? false : opts.needsSupport]);
    await q("INSERT INTO js_consents (candidate_id, scope, version) VALUES ($1,$2::jsonb,'v1')", [w.candidateId, JSON.stringify({ search: true, prepare: true, submit: true, countries: opts.consentCountries || [] })]);
    const s = opts.settings || {};
    await q("INSERT INTO js_candidate_settings (candidate_id, mode, cap_per_day, cap_per_week) VALUES ($1,$2,$3,$4)", [w.candidateId, opts.auto ? "automatic" : s.mode || "prepare_for_approval", s.cap_per_day === undefined ? 5 : s.cap_per_day, s.cap_per_week === undefined ? 20 : s.cap_per_week]);
    const pdf = makePdf(`Karim Benali\nElectrician ${n}`);
    const put = await storage.put(pdf, { candidateId: w.candidateId });
    w.cvKey = put.key;
    w.cvFileId = (await q("INSERT INTO js_cv_files (candidate_id, storage_key, sha256, version, language, approved, scan_status) VALUES ($1,$2,$3,1,'en',true,'clean') RETURNING id", [w.candidateId, put.key, put.sha256])).rows[0].id;
  }
  Object.assign(w, await addJob(w, opts));
  if (opts.auto) {
    await q(
      `UPDATE js_candidate_settings SET admin_approved_by=$2, allowed_countries='{Canada}', approved_doc_versions=$3::jsonb WHERE candidate_id=$1`,
      [w.candidateId, adminId, JSON.stringify([{ cvFileId: w.cvFileId }])]
    );
    if (!opts.candidate) await q("INSERT INTO js_automation_rules (candidate_id, rule, approved_by, approved_at, active) VALUES ($1,'{}'::jsonb,$2,now(),true)", [w.candidateId, adminId]);
  }
  if (opts.stopAt === "matched") return w;
  w.appId = (await applicationService.createFromMatch({ matchId: w.matchId, actor: w.manager })).id;
  const p = await applicationService.prepareApplication({ id: w.appId, actor: w.manager, documents: opts.documents });
  assert.equal(p.application.status, "ready_for_review", JSON.stringify(p.package));
  if (opts.stopAt === "ready") return w;
  if (opts.auto) {
    const r = await applicationService.autoApprove(w.appId);
    assert.equal(r.approved, true, JSON.stringify(r.reasons));
  } else {
    await applicationService.approveApplication({ id: w.appId, actor: w.manager, reason: "reviewed" });
  }
  assert.equal(await status(w.appId), "approved");
  return w;
}

/** Employer (domain + verified contact) + open job + sighting at a fresh source + match. */
async function addJob(w, opts = {}) {
  n += 1;
  const domain = opts.domain || `northwind${n}.example`;
  const employerName = opts.employer || `Northwind Energy ${n}`;
  const employerId = (await q("INSERT INTO js_employers (name, normalized_name, domain, verified_contact_email) VALUES ($1,$2,$3,$4) RETURNING id", [employerName, jobStore.normalizeEmployer(employerName), domain, opts.contact === undefined ? `jobs@${domain}` : opts.contact])).rows[0].id;
  const sourceKey = opts.sourceKey || `g_src_${n}`;
  const sourceId = (await q("INSERT INTO js_sources (key, adapter, status) VALUES ($1,'partner_feed','connected') ON CONFLICT (key) DO UPDATE SET key=EXCLUDED.key RETURNING id", [sourceKey])).rows[0].id;
  const jobId = (await q(
    "INSERT INTO js_jobs (title, country, location, employer_id, source_primary, dedupe_key, description_text, url, closing_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [opts.title || "Electrician", opts.country || "Canada", opts.location || "Toronto, Canada", employerId, sourceKey, `dk-guard-${n}`, opts.text || `We are hiring an Electrician for our plant. Send your CV to jobs@${domain}.`, opts.url || `https://jobs.example/${n}`, opts.closingAt || null]
  )).rows[0].id;
  await q("INSERT INTO js_job_sightings (job_id, source_id, source_job_id, url) VALUES ($1,$2,$3,$4)", [jobId, sourceId, `sj-${n}`, opts.url || `https://jobs.example/${n}`]);
  const support = opts.support || (opts.auto ? "confirmed" : "unknown");
  const overseas = opts.overseas === undefined ? (opts.auto ? true : null) : opts.overseas;
  const matchId = (await q(
    "INSERT INTO js_matches (candidate_id, job_id, score, employer_support, employer_support_evidence, overseas_accepted) VALUES ($1,$2,80,$3,$4,$5) RETURNING id",
    [w.candidateId, jobId, support, support === "unknown" ? null : "Staff confirmed with employer.", overseas]
  )).rows[0].id;
  return { employerId, jobId, matchId, sourceId, sourceKey, domain, employerName };
}

async function sub(appId, st, { ago = "0 seconds", recipient = "jobs@x.example" } = {}) {
  n += 1;
  await q(
    "INSERT INTO js_submissions (application_id, attempt_no, idempotency_key, channel, recipient, status, created_at, sent_at) VALUES ($1,1,$2,'email',$3,$4, now() - $5::interval, CASE WHEN $4 = 'queued' THEN NULL ELSE now() - $5::interval END)",
    [appId, `${appId}:g${n}`, recipient, st, ago]
  );
}

// ---------------------------------------------------------------- ok path

test("ok path: an approved, fully valid application passes and returns the normalized recipient", async () => {
  const w = await world();
  const r = await check(w.appId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.recipient, `jobs@${w.domain}`);
  assert.deepEqual(r.notes, []);
  assert.equal(r.approval.human, true);
  // queued is sendable too
  await applicationService.transition(w.appId, "queued", w.manager);
  assert.equal((await check(w.appId)).ok, true);
});

// ---------------------------------------------------------------- one test per code

test("application_not_sendable: ready_for_review (unapproved), cancelled and unknown ids", async () => {
  const w = await world({ stopAt: "ready" });
  let r = await check(w.appId);
  assert.equal(r.ok, false);
  assert.equal(r.code, "application_not_sendable");
  await applicationService.approveApplication({ id: w.appId, actor: w.manager, reason: "ok" });
  assert.equal((await check(w.appId)).ok, true);
  await applicationService.cancelApplication({ id: w.appId, actor: w.manager, reason: "candidate asked" });
  r = await check(w.appId);
  assert.equal(r.code, "application_not_sendable");
  assert.equal((await check(99999999)).code, "application_not_sendable");
  assert.equal((await check("1 OR 1=1")).code, "application_not_sendable");
});

test("candidate_deleted: a soft-deleted candidate never sends", async () => {
  const w = await world();
  await q("UPDATE candidates SET is_deleted = true WHERE id=$1", [w.candidateId]);
  const r = await check(w.appId);
  assert.equal(r.code, "candidate_deleted");
});

test("consent_missing: no consent ever recorded, and a job outside the consented countries", async () => {
  const w = await world();
  await q("DELETE FROM js_consents WHERE candidate_id=$1", [w.candidateId]);
  assert.equal((await check(w.appId)).code, "consent_missing");
  const w2 = await world({ consentCountries: ["Canada"] });
  assert.equal((await check(w2.appId)).ok, true);
  await q("UPDATE js_jobs SET country='Qatar' WHERE id=$1", [w2.jobId]);
  const r = await check(w2.appId);
  assert.equal(r.code, "consent_missing");
  assert.match(r.detail, /countr/i);
});

test("consent_withdrawn: in-flight item after submit consent was withdrawn (and the real withdrawal cancels the app)", async () => {
  const w = await world();
  // Simulates the item already claimed when the withdrawal landed: consent row withdrawn, app still approved.
  await q(`UPDATE js_consents SET scope = scope || '{"submit": false, "withdrawn": {"submit": "2026-10-23T00:00:00Z"}}'::jsonb WHERE candidate_id=$1`, [w.candidateId]);
  assert.equal((await check(w.appId)).code, "consent_withdrawn");
  // Fully closed consent (withdrawn_at set) is also 'withdrawn', not 'missing'.
  await q("UPDATE js_consents SET withdrawn_at = now() WHERE candidate_id=$1", [w.candidateId]);
  assert.equal((await check(w.appId)).code, "consent_withdrawn");

  const w2 = await world();
  await consentService.withdrawConsent({ user: { id: w2.userId, role: "Candidate" }, candidateId: w2.candidateId, scopeKey: "submit" });
  assert.equal(await status(w2.appId), "cancelled");
  const r = await check(w2.appId);
  assert.equal(r.ok, false);
  assert.equal(r.code, "application_not_sendable");
});

test("candidate_paused", async () => {
  const w = await world();
  await q("UPDATE js_candidate_settings SET paused = true WHERE candidate_id=$1", [w.candidateId]);
  assert.equal((await check(w.appId)).code, "candidate_paused");
});

test("module_paused", async () => {
  const w = await world();
  await q(`INSERT INTO js_module_state (key, value) VALUES ('module_paused','{"paused": true}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  try {
    assert.equal((await check(w.appId)).code, "module_paused");
  } finally {
    await q("DELETE FROM js_module_state WHERE key='module_paused'");
  }
  assert.equal((await check(w.appId)).ok, true);
});

test("source_paused: all sightings' sources paused blocks; one active source is enough", async () => {
  const w = await world();
  await q("UPDATE js_sources SET paused = true WHERE id=$1", [w.sourceId]);
  assert.equal((await check(w.appId)).code, "source_paused");
  n += 1;
  const other = (await q("INSERT INTO js_sources (key, adapter, status) VALUES ($1,'partner_feed','connected') RETURNING id", [`g_src_other_${n}`])).rows[0].id;
  await q("INSERT INTO js_job_sightings (job_id, source_id, source_job_id) VALUES ($1,$2,'other-1')", [w.jobId, other]);
  assert.equal((await check(w.appId)).ok, true);
  await q("UPDATE js_sources SET paused = true WHERE id=$1", [other]);
  assert.equal((await check(w.appId)).code, "source_paused");
});

test("user_suspended: the candidate's login account is inactive", async () => {
  const w = await world();
  await q("UPDATE users SET is_active = false WHERE id=$1", [w.userId]);
  assert.equal((await check(w.appId)).code, "user_suspended");
});

test("mode_disallows: search_only, missing approval row, system approval in prepare_for_approval, demoted approver", async () => {
  const w = await world();
  await q("UPDATE js_candidate_settings SET mode='search_only' WHERE candidate_id=$1", [w.candidateId]);
  assert.equal((await check(w.appId)).code, "mode_disallows");
  await q("UPDATE js_candidate_settings SET mode='prepare_for_approval' WHERE candidate_id=$1", [w.candidateId]);
  assert.equal((await check(w.appId)).ok, true);

  // Approver lost the approve permission / was deactivated.
  await q("UPDATE users SET role='Agent' WHERE id=$1", [w.managerId]);
  assert.equal((await check(w.appId)).code, "mode_disallows");
  await q("UPDATE users SET role='Manager', is_active=false WHERE id=$1", [w.managerId]);
  assert.equal((await check(w.appId)).code, "mode_disallows");
  await q("UPDATE users SET is_active=true WHERE id=$1", [w.managerId]);

  // No approval row at all (status forced by SQL).
  const w2 = await world({ stopAt: "ready" });
  await q("UPDATE js_applications SET status='approved' WHERE id=$1", [w2.appId]);
  let r = await check(w2.appId);
  assert.equal(r.code, "mode_disallows");
  assert.match(r.detail, /approv/i);

  // prepare_for_approval requires a HUMAN approval row: a system approval is not enough.
  await q(`INSERT INTO js_timeline (application_id, actor, event, detail) VALUES ($1,'system:auto','status_changed','{"from":"ready_for_review","to":"approved"}'::jsonb)`, [w2.appId]);
  r = await check(w2.appId);
  assert.equal(r.code, "mode_disallows");
  // A forged 'staff:' actor that does not exist is not a human approval.
  await q(`INSERT INTO js_timeline (application_id, actor, event, detail) VALUES ($1,'staff:987654','status_changed','{"from":"ready_for_review","to":"approved"}'::jsonb)`, [w2.appId]);
  assert.equal((await check(w2.appId)).code, "mode_disallows");
});

test("automatic mode honors admin-approved rules and allowed countries/professions/sources/salary floor", async () => {
  const w = await world({ auto: true });
  let r = await check(w.appId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.approval.human, false);

  const expectBlocked = async (sql, params, reason) => {
    await q(sql, params);
    const res = await check(w.appId);
    assert.equal(res.code, "mode_disallows", `${reason}: ${JSON.stringify(res)}`);
    assert.match(res.detail, new RegExp(reason));
  };
  await expectBlocked("UPDATE js_candidate_settings SET allowed_countries='{Qatar}' WHERE candidate_id=$1", [w.candidateId], "country_not_allowed");
  await q("UPDATE js_candidate_settings SET allowed_countries='{Canada}' WHERE candidate_id=$1", [w.candidateId]);
  await expectBlocked("UPDATE js_candidate_settings SET allowed_professions='{Plumber}' WHERE candidate_id=$1", [w.candidateId], "profession_not_allowed");
  await q("UPDATE js_candidate_settings SET allowed_professions='{Electrician}' WHERE candidate_id=$1", [w.candidateId]);
  assert.equal((await check(w.appId)).ok, true);
  await expectBlocked("UPDATE js_candidate_settings SET allowed_sources='{jobbank_ca}' WHERE candidate_id=$1", [w.candidateId], "source_not_allowed");
  await q("UPDATE js_candidate_settings SET allowed_sources=$2 WHERE candidate_id=$1", [w.candidateId, [w.sourceKey]]);
  assert.equal((await check(w.appId)).ok, true);
  await expectBlocked("UPDATE js_candidate_settings SET salary_limit=50000 WHERE candidate_id=$1", [w.candidateId], "salary_unverifiable");
  await q("UPDATE js_candidate_settings SET salary_limit=NULL WHERE candidate_id=$1", [w.candidateId]);
  await expectBlocked("UPDATE js_automation_rules SET active=false WHERE candidate_id=$1", [w.candidateId], "no_admin_approved_rule");
  await q("UPDATE js_automation_rules SET active=true WHERE candidate_id=$1", [w.candidateId]);
  await expectBlocked("UPDATE js_candidate_settings SET admin_approved_by=NULL WHERE candidate_id=$1", [w.candidateId], "automatic_mode_not_admin_approved");
  await q("UPDATE js_candidate_settings SET admin_approved_by=$2 WHERE candidate_id=$1", [w.candidateId, adminId]);
  await expectBlocked("UPDATE js_candidate_settings SET approved_doc_versions='[]'::jsonb WHERE candidate_id=$1", [w.candidateId], "no_admin_approved_documents");
  await q("UPDATE js_candidate_settings SET approved_doc_versions=$2::jsonb WHERE candidate_id=$1", [w.candidateId, JSON.stringify([{ cvFileId: w.cvFileId }])]);
  r = await check(w.appId);
  assert.equal(r.ok, true, JSON.stringify(r));
  // Switching an auto-approved application's candidate to prepare_for_approval needs a human approval.
  await q("UPDATE js_candidate_settings SET mode='prepare_for_approval' WHERE candidate_id=$1", [w.candidateId]);
  assert.equal((await check(w.appId)).code, "mode_disallows");
});

test("label ruling: needs-support candidate abroad, label 'unknown' -> ok only when a HUMAN approved; system:auto -> label_requires_human", async () => {
  const human = await world({ needsSupport: true, residence: "Tunisia", support: "unknown" });
  const r = await check(human.appId);
  assert.equal(r.ok, true, JSON.stringify(r));
  // 'unavailable' with a human approval: the human decided; allowed.
  await q("UPDATE js_matches SET employer_support='unavailable' WHERE id=$1", [human.matchId]);
  assert.equal((await check(human.appId)).ok, true);

  // System approval while the label was 'confirmed'; the confirmation is then revoked -> label 'unknown'.
  const auto = await world({ auto: true, needsSupport: true, residence: "Tunisia" });
  assert.equal((await check(auto.appId)).ok, true);
  await q("UPDATE js_matches SET employer_support='unknown', employer_support_evidence=NULL WHERE id=$1", [auto.matchId]);
  let res = await check(auto.appId);
  assert.equal(res.code, "label_requires_human", JSON.stringify(res));
  await q("UPDATE js_matches SET employer_support='stated_in_ad' WHERE id=$1", [auto.matchId]);
  assert.equal((await check(auto.appId)).code, "label_requires_human");
  await q("UPDATE js_matches SET employer_support='confirmed', overseas_accepted=NULL WHERE id=$1", [auto.matchId]);
  res = await check(auto.appId);
  assert.equal(res.code, "label_requires_human");
  assert.match(res.detail, /overseas/);
  await q("UPDATE js_matches SET overseas_accepted=true WHERE id=$1", [auto.matchId]);
  assert.equal((await check(auto.appId)).ok, true);
});

test("job_closed: re-check says closed/expired, stored status closed, closing date passed; unverifiable -> note only", async () => {
  const w = await world();
  assert.equal((await check(w.appId, { recheck: async () => ({ status: "closed", verified: true }) })).code, "job_closed");
  assert.equal((await check(w.appId, { recheck: async () => "expired" })).code, "job_closed");
  // Source cannot confirm (unavailable/requires_setup): stored status is used, a note is recorded.
  const r = await check(w.appId, { recheck: async () => ({ status: "open", verified: false }) });
  assert.equal(r.ok, true);
  assert.ok(r.notes.includes("job_status_unverified"));
  // A throwing re-check is also "could not verify".
  const r2 = await check(w.appId, { recheck: async () => { throw new Error("network down"); } });
  assert.equal(r2.ok, true);
  assert.ok(r2.notes.includes("job_status_unverified"));
  // ...UNLESS the closing date passed.
  await q("UPDATE js_jobs SET closing_at = now() - interval '1 hour' WHERE id=$1", [w.jobId]);
  assert.equal((await check(w.appId, { recheck: async () => ({ status: "open", verified: false }) })).code, "job_closed");
  await q("UPDATE js_jobs SET closing_at = NULL, status='closed' WHERE id=$1", [w.jobId]);
  assert.equal((await check(w.appId)).code, "job_closed", "stored closed status wins over a stale 'open' re-check");
  // `now` drives the closing-date comparison.
  await q("UPDATE js_jobs SET status='open', closing_at = '2030-01-01T00:00:00Z' WHERE id=$1", [w.jobId]);
  assert.equal((await check(w.appId)).ok, true);
  assert.equal((await check(w.appId, { now: new Date("2030-02-01T00:00:00Z") })).code, "job_closed");
});

test("job re-check (real jobStore.recheckJobDetailed via test_fixture adapter): gone -> closed; flaky -> unverified note; manual only -> unverified", async () => {
  testFixture._reset();
  const w = await world();
  const fx = (await q("SELECT id FROM js_sources WHERE key='test_fixture'")).rows[0].id;
  await q("DELETE FROM js_job_sightings WHERE job_id=$1", [w.jobId]);
  await q("INSERT INTO js_job_sightings (job_id, source_id, source_job_id) VALUES ($1,$2,'fx-guard-1')", [w.jobId, fx]);
  testFixture._detail("fx-guard-1", { sourceJobId: "fx-guard-1", title: "Electrician" });
  let r = await guard.check(w.appId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.notes, []);
  testFixture._detail("fx-guard-1", new Error("timeout"));
  r = await guard.check(w.appId);
  assert.equal(r.ok, true);
  assert.ok(r.notes.includes("job_status_unverified"));
  testFixture._detail("fx-guard-1", null);
  r = await guard.check(w.appId);
  assert.equal(r.code, "job_closed");
  assert.equal((await q("SELECT status FROM js_jobs WHERE id=$1", [w.jobId])).rows[0].status, "closed");

  const d = await jobStore.recheckJobDetailed(w.jobId);
  assert.deepEqual({ status: d.status, verified: d.verified }, { status: "closed", verified: true });
  const mi = (await q("SELECT id FROM js_sources WHERE key='manual_import'")).rows[0].id;
  await q("UPDATE js_jobs SET status='open' WHERE id=$1", [w.jobId]);
  await q("DELETE FROM js_job_sightings WHERE job_id=$1", [w.jobId]);
  await q("INSERT INTO js_job_sightings (job_id, source_id, source_job_id) VALUES ($1,$2,'manual-guard-x')", [w.jobId, mi]);
  const m = await jobStore.recheckJobDetailed(w.jobId);
  assert.equal(m.status, "open");
  assert.equal(m.verified, false, "manual import reads back our own row: not an independent confirmation");
  assert.equal(await jobStore.recheckJob(w.jobId), "open", "recheckJob keeps its string return");
  testFixture._reset();
});

test("duplicate: same vacancy stored twice (cross-source) -> first allowed, second blocked; same canonical URL; window and city", async () => {
  const a = await world({ employer: "Maple Hydro Inc.", title: "Industrial Electrician", location: "Toronto, ON", url: "https://careers.maple.example/jobs/77?utm_source=x" });
  // Same vacancy on another source, stored as its own js_jobs row (posting-week bucket differed).
  const bJob = await addJob(a, { employer: "Maple Hydro", title: "industrial electrician", location: "Toronto", sourceKey: `g_src_b_${n}`, url: "https://aggregator.example/x/1" });
  const bApp = (await applicationService.createFromMatch({ matchId: bJob.matchId, actor: a.manager })).id;
  await applicationService.prepareApplication({ id: bApp, actor: a.manager });
  await applicationService.approveApplication({ id: bApp, actor: a.manager, reason: "ok" });

  // Both merely approved: the OLDER one may go, the newer one is the duplicate.
  assert.equal((await check(a.appId)).ok, true, "older approved duplicate is allowed");
  let r0 = await check(bApp);
  assert.equal(r0.code, "duplicate", "newer approved duplicate is blocked");
  // A is queued for sending -> B is a duplicate.
  await applicationService.transition(a.appId, "queued", a.manager);
  await sub(a.appId, "queued");
  let r = await check(bApp);
  assert.equal(r.code, "duplicate", JSON.stringify(r));
  assert.match(r.detail, new RegExp(String(a.appId)));
  assert.equal((await check(a.appId)).ok, true, "its own queued attempt does not block A");

  // Same canonical URL (different title/employer text) -> duplicate regardless of the window.
  const c = await addJob(a, { employer: "Other Name Ltd", title: "Electrician II", url: "https://careers.maple.example/jobs/77/#apply" });
  const cApp = (await applicationService.createFromMatch({ matchId: c.matchId, actor: a.manager })).id;
  await applicationService.prepareApplication({ id: cApp, actor: a.manager });
  await applicationService.approveApplication({ id: cApp, actor: a.manager, reason: "ok" });
  await q("UPDATE js_submissions SET created_at = now() - interval '200 days', sent_at = now() - interval '200 days', status='sent' WHERE application_id=$1", [a.appId]);
  await q("UPDATE js_applications SET status='sent', updated_at = now() - interval '200 days' WHERE id=$1", [a.appId]);
  r = await check(cApp);
  assert.equal(r.code, "duplicate");
  assert.match(r.detail, /url/i);
  // ...while employer+title(+city) only counts inside 90 days.
  assert.equal((await check(bApp)).ok, true, "same employer+title sent 200 days ago is not a duplicate");
  await q("UPDATE js_submissions SET created_at = now() - interval '89 days', sent_at = now() - interval '89 days' WHERE application_id=$1", [a.appId]);
  assert.equal((await check(bApp)).code, "duplicate");
  // A different city is a different vacancy.
  await q("UPDATE js_jobs SET location='Vancouver, BC' WHERE id=$1", [bJob.jobId]);
  assert.equal((await check(bApp)).ok, true);
});

test("duplicate: two sightings of ONE job -> one application, which is sendable", async () => {
  const w = await world();
  n += 1;
  const other = (await q("INSERT INTO js_sources (key, adapter, status) VALUES ($1,'partner_feed','connected') RETURNING id", [`g_src_dup_${n}`])).rows[0].id;
  await q("INSERT INTO js_job_sightings (job_id, source_id, source_job_id, url) VALUES ($1,$2,'dup-1','https://other.example/1')", [w.jobId, other]);
  const again = await applicationService.createFromMatch({ matchId: w.matchId, actor: w.manager });
  assert.equal(again.created, false);
  assert.equal(again.id, w.appId);
  assert.equal((await check(w.appId)).ok, true);
});

test("duplicate_submission: an earlier sent/confirmed/outcome_unknown attempt for this application is never re-sent", async () => {
  const w = await world();
  await sub(w.appId, "failed");
  assert.equal((await check(w.appId)).ok, true, "a failed attempt (not delivered) may be retried");
  await sub(w.appId, "outcome_unknown");
  const r = await check(w.appId);
  assert.equal(r.code, "duplicate_submission");
  assert.equal(r.handoff, "staff_review");
  const w2 = await world();
  await sub(w2.appId, "sent");
  assert.equal((await check(w2.appId)).code, "duplicate_submission");
  const w3 = await world();
  await sub(w3.appId, "confirmed_submitted");
  assert.equal((await check(w3.appId)).code, "duplicate_submission");
});

test("missing_fields: confirmed profile needs name, email, profession, a language or experience; cover letter required", async () => {
  const w = await world();
  const set = (p) => q("UPDATE js_profiles SET confirmed=$2::jsonb WHERE candidate_id=$1", [w.candidateId, JSON.stringify(p)]);
  for (const [field, p] of [
    ["name", { ...PROFILE, name: "  " }],
    ["email", { ...PROFILE, email: undefined }],
    ["email", { ...PROFILE, email: "not-an-email" }],
    ["profession", { ...PROFILE, profession: "" }],
    ["languages", { ...PROFILE, languages: [], experience: [] }],
  ]) {
    await set(p);
    const r = await check(w.appId);
    assert.equal(r.code, "missing_fields", field);
    assert.match(r.detail, new RegExp(field === "languages" ? "language|experience" : field));
  }
  await set({ ...PROFILE, languages: [] });
  assert.equal((await check(w.appId)).ok, true, "experience alone is enough");
  await q("UPDATE js_profiles SET status='extracted' WHERE candidate_id=$1", [w.candidateId]);
  assert.equal((await check(w.appId)).code, "missing_fields");
  await q("UPDATE js_profiles SET status='confirmed' WHERE candidate_id=$1", [w.candidateId]);
  await q("UPDATE js_applications SET cover_letter_text = '  ' WHERE id=$1", [w.appId]);
  const r = await check(w.appId);
  assert.equal(r.code, "missing_fields");
  assert.match(r.detail, /cover/);
});

test("document_unapproved: CV un-approved after approval; package row never approved; no CV in package", async () => {
  const w = await world();
  await q("UPDATE js_cv_files SET approved=false WHERE id=$1", [w.cvFileId]);
  let r = await check(w.appId);
  assert.equal(r.code, "document_unapproved");
  assert.match(r.detail, /cv_not_approved/);
  await q("UPDATE js_cv_files SET approved=true WHERE id=$1", [w.cvFileId]);
  assert.equal((await check(w.appId)).ok, true);
  await q("UPDATE js_application_documents SET approved_at=NULL WHERE application_id=$1", [w.appId]);
  assert.equal((await check(w.appId)).code, "document_unapproved");
  await q("UPDATE js_application_documents SET approved_at=now(), removed_at=now() WHERE application_id=$1", [w.appId]);
  r = await check(w.appId);
  assert.equal(r.code, "document_unapproved");
  assert.match(r.detail, /no_cv_in_package/);
});

test("sensitive_unauthorized: the candidate's sharing authorization is revoked after approval", async () => {
  n += 1;
  const base = await world({ stopAt: "matched" });
  const docId = (await q("INSERT INTO documents (candidate_id, doc_type, file_path) VALUES ($1,'passport','/crm/passport.pdf') RETURNING id", [base.candidateId])).rows[0].id;
  const appId = (await applicationService.createFromMatch({ matchId: base.matchId, actor: base.manager })).id;
  const auth = await applicationService.grantSharing({ id: appId, actor: { id: base.userId, role: "Candidate" }, documentId: docId, legitimateNeed: "Employer requires passport copy for travel booking" });
  const p = await applicationService.prepareApplication({ id: appId, actor: base.manager, documents: [{ documentId: docId }] });
  assert.equal(p.application.status, "ready_for_review", JSON.stringify(p.package));
  await applicationService.approveApplication({ id: appId, actor: base.manager, reason: "ok" });
  assert.equal((await check(appId)).ok, true);
  await q("UPDATE js_sharing_authorizations SET revoked_at = now() WHERE id=$1", [auth.id]);
  const r = await check(appId);
  assert.equal(r.code, "sensitive_unauthorized");
});

test("package_changed: CV bytes replaced, CV infected, CRM document changed or deleted after approval", async () => {
  const w = await world();
  const file = path.join(process.env.STORAGE_DIR, w.cvKey);
  const orig = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([orig, Buffer.from("\n% tampered")]));
  let r = await check(w.appId);
  assert.equal(r.code, "package_changed");
  assert.match(r.detail, /cv_bytes_changed/);
  fs.writeFileSync(file, orig);
  assert.equal((await check(w.appId)).ok, true);
  await q("UPDATE js_cv_files SET scan_status='infected' WHERE id=$1", [w.cvFileId]);
  r = await check(w.appId);
  assert.equal(r.code, "package_changed");
  assert.match(r.detail, /cv_infected/);
  await q("UPDATE js_cv_files SET scan_status='clean' WHERE id=$1", [w.cvFileId]);

  const base = await world({ stopAt: "matched" });
  const docId = (await q("INSERT INTO documents (candidate_id, doc_type, file_path) VALUES ($1,'Diploma','/crm/diploma.pdf') RETURNING id", [base.candidateId])).rows[0].id;
  const appId = (await applicationService.createFromMatch({ matchId: base.matchId, actor: base.manager })).id;
  await applicationService.prepareApplication({ id: appId, actor: base.manager, documents: [{ documentId: docId }] });
  await applicationService.approveApplication({ id: appId, actor: base.manager, reason: "ok" });
  assert.equal((await check(appId)).ok, true);
  await q("UPDATE documents SET file_path='/crm/diploma-v2.pdf' WHERE id=$1", [docId]);
  r = await check(appId);
  assert.equal(r.code, "package_changed");
  assert.match(r.detail, /document_changed/);
  await q("UPDATE documents SET is_deleted=true WHERE id=$1", [docId]);
  r = await check(appId);
  assert.equal(r.code, "package_changed");
  assert.match(r.detail, /document_deleted/);
});

test("cap_exceeded: per-day boundary, rolling 7-day week, cap 0", async () => {
  const w = await world({ settings: { cap_per_day: 1, cap_per_week: 3 } });
  assert.equal((await check(w.appId)).ok, true, "first send of the day passes");
  const other = await addJob(w, {});
  const otherApp = (await applicationService.createFromMatch({ matchId: other.matchId, actor: w.manager })).id;
  await sub(otherApp, "sent", { ago: "2 hours" });
  let r = await check(w.appId);
  assert.equal(r.code, "cap_exceeded");
  assert.match(r.detail, /day/);
  await q("UPDATE js_submissions SET created_at = now() - interval '25 hours', sent_at = now() - interval '25 hours' WHERE application_id=$1", [otherApp]);
  assert.equal((await check(w.appId)).ok, true, "outside the 24h window");
  for (const st of ["outcome_unknown", "confirmed_submitted"]) await sub(otherApp, st, { ago: "3 days" });
  r = await check(w.appId);
  assert.equal(r.code, "cap_exceeded", "3 in the last 7 days reach the weekly cap");
  assert.match(r.detail, /week/);
  await q("UPDATE js_submissions SET created_at = now() - interval '8 days', sent_at = now() - interval '8 days' WHERE application_id=$1 AND status='outcome_unknown'", [otherApp]);
  assert.equal((await check(w.appId)).ok, true, "rolling window: 8 days ago no longer counts");
  await sub(otherApp, "failed", { ago: "1 hour" });
  assert.equal((await check(w.appId)).ok, true, "failed attempts do not count");
  await sub(otherApp, "queued", { ago: "1 minute" });
  assert.equal((await check(w.appId)).code, "cap_exceeded", "a queued submission of another application counts");

  const z = await world({ settings: { cap_per_day: 0, cap_per_week: 10 } });
  r = await check(z.appId);
  assert.equal(r.code, "cap_exceeded");
  assert.match(r.detail, /0/);
  await q("UPDATE js_candidate_settings SET cap_per_day=5, cap_per_week=0 WHERE candidate_id=$1", [z.candidateId]);
  assert.equal((await check(z.appId)).code, "cap_exceeded");
});

test("recipient_unverified: wrong address; no recipient at all; non-email channel", async () => {
  const w = await world();
  let r = await check(w.appId, { recipient: "jobs@evil.example" });
  assert.equal(r.code, "recipient_unverified");
  assert.equal(r.handoff, undefined);
  assert.equal((await check(w.appId, { recipient: ` JOBS@${w.domain.toUpperCase()} ` })).ok, true);
  // No explicit recipient, no verified contact: falls back to the address the posting itself names.
  await q("UPDATE js_employers SET verified_contact_email=NULL WHERE id=$1", [w.employerId]);
  r = await check(w.appId);
  assert.equal(r.ok, true);
  assert.equal(r.recipient, `jobs@${w.domain}`);
  // ...and nothing at all -> handoff.
  await q("UPDATE js_jobs SET description_text='We are hiring. Apply through our website.' WHERE id=$1", [w.jobId]);
  r = await check(w.appId);
  assert.equal(r.code, "recipient_unverified");
  assert.equal(r.handoff, "unsupported_channel");
  // Two different posted addresses: ambiguous -> staff.
  await q("UPDATE js_jobs SET description_text=$2 WHERE id=$1", [w.jobId, `Write to jobs@${w.domain} or hr@${w.domain}.`]);
  r = await check(w.appId);
  assert.equal(r.code, "recipient_unverified");
  assert.equal(r.handoff, "unsupported_channel");
  await q("UPDATE js_applications SET channel='portal' WHERE id=$1", [w.appId]);
  r = await check(w.appId, { recipient: `jobs@${w.domain}` });
  assert.equal(r.code, "recipient_unverified");
  assert.equal(r.handoff, "unsupported_channel");
});

test("handoff flags in the posting (captcha, payment, login, legal declaration, custom questions) stop the send", async () => {
  const w = await world();
  for (const [text, reason] of [
    ["Apply online: complete the CAPTCHA before submitting.", "captcha"],
    ["A processing fee of $200 is payable by the applicant.", "payment"],
    ["Please log in to our careers portal to apply.", "login"],
    ["Applicants must sign a sworn declaration of their history.", "legal_declaration"],
    ["Answer the following screening questions in your email.", "custom_questions"],
  ]) {
    await q("UPDATE js_jobs SET description_text=$2 WHERE id=$1", [w.jobId, text]);
    const r = await check(w.appId, { recipient: `jobs@${w.domain}` });
    assert.equal(r.code, "handoff_required", text);
    assert.equal(r.handoff, reason, text);
  }
  await q("UPDATE js_jobs SET description_text='We are hiring an Electrician. Visa sponsorship available. No fees are charged to applicants.' WHERE id=$1", [w.jobId]);
  assert.equal((await check(w.appId, { recipient: `jobs@${w.domain}` })).ok, true, "a no-fee statement is not a payment requirement");
});

// ---------------------------------------------------------------- recipient table (pure)

test("verifyRecipient: exact employer domain or exact posted/verified address; lookalikes, subdomains and free-mail rejected", () => {
  const emp = { domain: "Employer.com", verified_contact_email: null };
  const job = { description_text: "Send your CV to careers.employer@gmail.com or to recruit@hr.employer.com. Questions: info@employer.com" };
  const cases = [
    ["hr@employer.com", true, "exact domain"],
    ["HR@EMPLOYER.COM", true, "case-insensitive"],
    ["  hr@employer.com  ", true, "trimmed"],
    ["ｈｒ＠ｅｍｐｌｏｙｅｒ.ｃｏｍ", true, "NFKC fullwidth folds to ASCII"],
    ["first.last+jobs@employer.com", true, "plus/dots in local part"],
    ["recruit@hr.employer.com", true, "subdomain address named exactly in the posting"],
    ["other@hr.employer.com", false, "subdomain not named in the posting"],
    ["hr@careers.employer.com", false, "subdomain default reject"],
    ["careers.employer@gmail.com", true, "free-mail named exactly in the posting"],
    ["someone@gmail.com", false, "free-mail not named"],
    ["hr@outlook.com", false, "free-mail"],
    ["hr@hotmail.fr", false, "free-mail (country TLD)"],
    ["hr@yahoo.co.uk", false, "free-mail"],
    ["hr@proton.me", false, "free-mail"],
    ["hr@employer.com.evil.com", false, "suffix trick"],
    ["hr@evil-employer.com", false, "hyphen lookalike"],
    ["hr@employer.com@evil.com", false, "double @"],
    ["employer.com@evil.com", false, "domain in local part"],
    ["hr@employer.co", false, "different TLD"],
    ["hr@emp1oyer.com", false, "digit lookalike"],
    ["hr@еmployer.com", false, "Cyrillic е (IDN homograph)"],
    ["hr@xn--mployer-2fg.com", false, "punycode lookalike"],
    ["hr@employ​er.com", false, "zero-width inside domain"],
    ["hr@employer.com.", false, "trailing dot"],
    ["hr@employer..com", false, "empty label"],
    ["Recruiter <hr@employer.com>", false, "display-name form"],
    ["hr@employer.com, x@evil.com", false, "list"],
    ["hr@employer.com\nBcc: x@evil.com", false, "header injection"],
    ["hr%evil.com@employer.com", false, "percent routing in local part"],
    ['"hr@evil.com"@employer.com', false, "quoted local part"],
    ["hr@[203.0.113.5]", false, "IP literal"],
    ["", false, "empty"],
    [null, false, "null"],
    ["hr@sub.evil.com", false, "unrelated"],
  ];
  assert.ok(cases.length >= 25);
  for (const [addr, want, why] of cases) assert.equal(guard.verifyRecipient(emp, addr, job), want, `${why}: ${JSON.stringify(addr)}`);

  // Employer domain stored in odd shapes is normalised; a free-mail employer domain never authorises the whole domain.
  assert.equal(guard.verifyRecipient({ domain: "https://www.employer.com/careers" }, "hr@employer.com"), true);
  assert.equal(guard.verifyRecipient({ domain: "www.Employer.com." }, "hr@employer.com"), true);
  assert.equal(guard.verifyRecipient({ domain: "gmail.com" }, "anyone@gmail.com"), false);
  assert.equal(guard.verifyRecipient({ domain: "gmail.com", verified_contact_email: "Shop.Owner@gmail.com" }, "shop.owner@gmail.com"), true, "staff-verified exact address");
  assert.equal(guard.verifyRecipient({ domain: null }, "hr@employer.com"), false, "no domain, nothing posted");
  assert.equal(guard.verifyRecipient({ domain: "employer.com" }, "hr@employer.com", { description_text: "contact hr@evil.com" }), true);
  assert.equal(guard.verifyRecipient({ domain: "employer.com" }, "hr@evil.com", { description_text: "contact HR@Evil.com." }), true, "posting names that exact address");
  assert.equal(guard.verifyRecipient({ domain: "employer.com" }, "hr@evil.com", { description_text: "contact xhr@evil.com" }), false, "substring of a posted address is not a match");
  assert.equal(guard.verifyRecipient(null, "hr@employer.com"), false);
});

// ---------------------------------------------------------------- read-only, no caching, transactions, race

async function snapshot() {
  const r = await q(`SELECT
    (SELECT json_agg(json_build_object('id', id, 'status', status, 'updated_at', updated_at) ORDER BY id) FROM js_applications) AS apps,
    (SELECT count(*) FROM js_submissions) AS subs, (SELECT count(*) FROM js_queue) AS queue,
    (SELECT count(*) FROM js_timeline) AS tl, (SELECT count(*) FROM js_audit_events) AS audit,
    (SELECT count(*) FROM js_events) AS events, (SELECT count(*) FROM js_tasks) AS tasks,
    (SELECT count(*) FROM audit_logs) AS logs,
    (SELECT json_agg(json_build_object('id', id, 'status', status, 'checked', last_checked_at) ORDER BY id) FROM js_jobs) AS jobs`);
  return JSON.stringify(r.rows[0]);
}

test("the guard never mutates state (passing and failing checks, own transaction and caller's)", async () => {
  const w = await world();
  const before = await snapshot();
  assert.equal((await check(w.appId)).ok, true);
  await q("UPDATE js_candidate_settings SET paused=true WHERE candidate_id=$1", [w.candidateId]);
  const mid = await snapshot();
  assert.equal((await check(w.appId)).code, "candidate_paused");
  assert.equal(await snapshot(), mid);
  await q("UPDATE js_candidate_settings SET paused=false WHERE candidate_id=$1", [w.candidateId]);
  assert.equal(await snapshot(), before);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    assert.equal((await check(w.appId, { client })).ok, true);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  assert.equal(await snapshot(), before);
});

test("no caching: every call re-reads; with a client it sees the caller's uncommitted changes in the same transaction", async () => {
  const w = await world();
  assert.equal((await check(w.appId)).ok, true);
  await q("UPDATE js_candidate_settings SET paused=true WHERE candidate_id=$1", [w.candidateId]);
  assert.equal((await check(w.appId)).code, "candidate_paused");
  await q("UPDATE js_candidate_settings SET paused=false WHERE candidate_id=$1", [w.candidateId]);
  assert.equal((await check(w.appId)).ok, true);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE js_candidate_settings SET paused=true WHERE candidate_id=$1", [w.candidateId]);
    assert.equal((await check(w.appId, { client })).code, "candidate_paused", "reads inside the caller's transaction");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.equal((await check(w.appId)).ok, true);
});

test("the guard holds the candidate lock: a concurrent consent withdrawal waits for the caller's transaction", async () => {
  const w = await world();
  const client = await pool.connect();
  let withdrawn = false;
  try {
    await client.query("BEGIN");
    assert.equal((await check(w.appId, { client })).ok, true);
    const p = consentService.withdrawConsent({ user: { id: w.userId, role: "Candidate" }, candidateId: w.candidateId, scopeKey: "submit" }).then(() => {
      withdrawn = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(withdrawn, false, "withdrawal is blocked behind the guard's candidate lock");
    await client.query("COMMIT");
    await p;
  } finally {
    client.release();
  }
  assert.equal(withdrawn, true);
  assert.equal((await check(w.appId)).ok, false);
});

test("race: two concurrent guard+mark-queued flows for one candidate with cap 1/day -> exactly one passes", async () => {
  // How Task 11 must use the guard: ONE transaction per send attempt -> guard.check(appId, {client})
  // (takes the candidate row lock FIRST, then the application) -> on ok insert the js_submissions
  // 'queued' row and transition to 'queued' -> COMMIT -> only then call the provider (re-running
  // guard.check right before the provider call, again under the lock).
  const w = await world({ settings: { cap_per_day: 1, cap_per_week: 10 } });
  const second = await addJob(w, {});
  const app2 = (await applicationService.createFromMatch({ matchId: second.matchId, actor: w.manager })).id;
  await applicationService.prepareApplication({ id: app2, actor: w.manager });
  await applicationService.approveApplication({ id: app2, actor: w.manager, reason: "ok" });
  const flow = async (appId) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await check(appId, { client });
      if (r.ok) {
        await new Promise((res) => setTimeout(res, 100)); // widen the window
        await client.query("INSERT INTO js_submissions (application_id, idempotency_key, channel, recipient, status) VALUES ($1,$2,'email',$3,'queued')", [appId, `${appId}:1`, r.recipient]);
        await applicationService.transition(appId, "queued", "system:submitter", { client, [applicationService._internal.SYSTEM_GRANT]: true });
      }
      await client.query("COMMIT");
      return r;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  const results = await Promise.all([flow(w.appId), flow(app2)]);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => !r.ok)[0].code, "cap_exceeded");
  const queued = (await q("SELECT count(*)::int AS n FROM js_submissions s JOIN js_applications a ON a.id=s.application_id WHERE a.candidate_id=$1", [w.candidateId])).rows[0].n;
  assert.equal(queued, 1);
});

// ---------------------------------------------------------------- fix round 1

test("recipient under automatic approval: an address only the ad names -> recipient_unverified/staff_review; human approval may use it", async () => {
  const scamText = "Electrician wanted. Apply: hr@employer-careers-fast.com";
  // Auto-approved, employer has a staff-set domain but no verified contact; the ad names an unrelated address.
  const auto = await world({ auto: true, contact: null, text: scamText });
  let r = await check(auto.appId);
  assert.equal(r.code, "recipient_unverified", JSON.stringify(r));
  assert.equal(r.handoff, "staff_review");
  assert.match(r.detail, /posted_in_ad/);
  assert.deepEqual(await guard.resolveRecipient(auto.appId), { recipient: "hr@employer-careers-fast.com", source: "posted_in_ad", domainMatchesEmployer: false, verifiedContact: false });
  // Explicit recipient at an unrelated domain is refused for auto too.
  assert.equal((await check(auto.appId, { recipient: "hr@employer-careers-fast.com" })).handoff, "staff_review");

  // Same ad, human approval: allowed, and the source is visible.
  const human = await world({ contact: null, text: scamText });
  r = await check(human.appId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.recipient, "hr@employer-careers-fast.com");
  assert.equal(r.recipientSource, "posted_in_ad");
  assert.equal(r.domainMatchesEmployer, false);

  // The ad names an address AT the staff-set employer domain -> ok for auto.
  const atDomain = await world({ auto: true, contact: null, text: "Apply: Careers@DOMAIN_PLACEHOLDER" });
  await q("UPDATE js_jobs SET description_text = $2 WHERE id = $1", [atDomain.jobId, `Apply: Careers@${atDomain.domain}`]);
  r = await check(atDomain.appId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.recipientSource, "employer_domain");
  assert.equal(r.domainMatchesEmployer, true);
  // ...but not when the employer has no staff-set domain.
  await q("UPDATE js_employers SET domain = NULL WHERE id = $1", [atDomain.employerId]);
  r = await check(atDomain.appId);
  assert.equal(r.code, "recipient_unverified");
  assert.equal(r.handoff, "staff_review");

  // verified_contact_email matches -> ok for auto, even at a free-mail address.
  const verified = await world({ auto: true, contact: "Owner.Shop@gmail.com", text: scamText });
  r = await check(verified.appId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.recipient, "owner.shop@gmail.com");
  assert.equal(r.recipientSource, "verified_contact");
  assert.equal((await guard.resolveRecipient(verified.appId)).verifiedContact, true);
  assert.equal(await guard.resolveRecipient(99999999), null);
  // resolveRecipient runs inside a caller's transaction too.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE js_employers SET verified_contact_email = 'jobs@other.example' WHERE id = $1", [verified.employerId]);
    assert.equal((await guard.resolveRecipient(verified.appId, { client })).recipient, "jobs@other.example");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});

test("reviewer recipient attack table (attack.js): every case", () => {
  const emp = { domain: "employer.com", verified_contact_email: null };
  const jobNone = { description_text: "Apply now." };
  const jobNamed = { description_text: "Send CV to jobs.employer@gmail.com" };
  const cases = [
    ["hr@employer.com", true, jobNone], ["hr@sub.employer.com", false, jobNone], ["hr@employer.com.evil.com", false, jobNone],
    ["hr@evil-employer.com", false, jobNone], ["hr@employer-com.evil.com", false, jobNone], ["hr@employer.co", false, jobNone],
    ["employer.com@evil.com", false, jobNone], ["hr@employer.com@evil.com", false, jobNone], ["employer.com <x@evil.com>", false, jobNone],
    ["x@employer.com,y@evil.com", false, jobNone], ["x@employer.com;y@evil.com", false, jobNone], ["a@employer.com\r\nBcc: z@evil.com", false, jobNone],
    ["a@employer.com\nBcc:z@evil.com", false, jobNone], ["a@xn--employr-6ya.com", false, jobNone], ["a@xn--mployer-2fg.com", false, jobNone],
    ["a@еmployer.com", false, jobNone], ["a@employer.com.", false, jobNone], ["A@EMPLOYER.COM", true, jobNone],
    ["ａ@ｅｍｐｌｏｙｅｒ．ｃｏｍ", true, jobNone], [" a@employer.com\t", true, jobNone], ["a @employer.com", false, jobNone],
    ['"a@evil.com"@employer.com', false, jobNone], ["a+jobs@employer.com", true, jobNone], ["a%40evil.com@employer.com", false, jobNone],
    ["a@employer%2ecom", false, jobNone], ["a@employer.com%0d%0abcc:x@evil.com", false, jobNone], ["a@EMPLOYER.com.evil.com", false, jobNone],
    ["a@employer.com\u0000", false, jobNone], ["a@employer.com​", false, jobNone], ["a@[127.0.0.1]", false, jobNone],
    ["a@employer.c0m", false, jobNone], ["a@employer", false, jobNone], ["a@.employer.com", false, jobNone],
    ["a@employer.com/evil", false, jobNone], ["a(comment)@employer.com", false, jobNone], ["a@employer.com (x@evil.com)", false, jobNone],
    ["mailto:a@employer.com", false, jobNone], ["a@employer.com?bcc=x@evil.com", false, jobNone],
    ["jobs.employer@gmail.com", true, jobNamed], ["other@gmail.com", false, jobNamed], ["jobs.employer@googlemail.com", false, jobNamed],
    ...["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com", "aol.com", "gmx.com", "gmx.de", "yandex.ru", "live.com", "msn.com", "hotmail.fr", "yahoo.fr", "outlook.fr", "live.fr", "yahoo.co.uk", "hotmail.co.uk", "live.co.uk", "gmx.fr", "yandex.com", "aol.fr", "icloud.fr", "me.com", "mail.com", "orange.fr"].map((d) => [`x@${d}`, false, jobNone]),
  ];
  for (const [a, want, job] of cases) assert.equal(guard.verifyRecipient(emp, a, job), want, JSON.stringify(a));
  for (const d of ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me", "aol.com", "gmx.de", "yandex.ru", "live.com", "msn.com", "hotmail.fr", "yahoo.co.uk", "gmx.net", "gmx.at", "web.de", "yandex.com", "outlook.co.uk"]) {
    assert.equal(guard.verifyRecipient({ domain: d }, `x@${d}`, jobNone), false, `employer.domain=${d}`);
  }
  // Extraction quirks: whole token kept (never truncated to the employer domain), mailto query dropped.
  assert.deepEqual(guard.postedAddresses({ description_text: "mail a@employer.com.evil.com" }), ["a@employer.com.evil.com"]);
  assert.deepEqual(guard.postedAddresses({ description_text: "<a href='mailto:x@evil.com?subject=hi'>" }), ["x@evil.com"]);
});

test("handoff detector corpus: >=60 EN/FR phrasings flagged with the right reason, >=25 ordinary ads not flagged", () => {
  const ctx = { salary_min: 1000, availability: "now", residence_country: "Tunisia" };
  assert.ok(PHRASES.POS.length >= 60 && PHRASES.NEG.length >= 25);
  for (const [text, reason] of PHRASES.POS) {
    const r = guard.detectHandoff({ description_text: text }, ctx);
    assert.ok(r, `not flagged: ${text}`);
    assert.equal(r.reason, reason, `${text} -> ${r.source}`);
  }
  for (const text of PHRASES.NEG) {
    const r = guard.detectHandoff({ description_text: text }, ctx);
    assert.equal(r, null, `false positive: ${text} -> ${r && `${r.reason} ${r.source}`}`);
  }
  // Every reviewer (handoff.js) case, verbatim: positives flagged, the five negatives not.
  const reviewerNeg = ["Sign-on bonus available.", "No fees charged to applicants.", "We never ask candidates to pay any fee.", "Aucuns frais ne sont demandés aux candidats.", "Login credentials will be provided after hiring."];
  for (const t of reviewerNeg) assert.ok(PHRASES.NEG.includes(t));
  // "please state your X": a custom answer unless the confirmed preferences hold X.
  for (const t of ["Please indicate your availability.", "Please state your salary expectations.", "Indicate your country of residence."]) {
    assert.equal(guard.detectHandoff({ description_text: t }, {}).reason, "custom_questions", t);
    assert.equal(guard.detectHandoff({ description_text: t }, ctx), null, t);
  }
  // Multi-sentence ad: a harmless sentence does not mask a dangerous one; flags column wins when present.
  assert.equal(guard.detectHandoff({ description_text: "We pay $25/hour. Fees paid by employer. Candidates must pay a $300 deposit to secure your seat." }).reason, "payment");
  assert.equal(guard.detectHandoff({ description_text: "Normal ad.", flags: { requires_online_only: true } }).reason, "unsupported_channel");
});

test("handoff via the guard uses the candidate's preferences for 'please state your ...' requests", async () => {
  const w = await world();
  await q("UPDATE js_jobs SET description_text = $2 WHERE id = $1", [w.jobId, `Electrician wanted. Send your CV to jobs@${w.domain}. In your email please indicate your availability.`]);
  let r = await check(w.appId);
  assert.equal(r.code, "handoff_required");
  assert.equal(r.handoff, "custom_questions");
  await q("UPDATE js_preferences SET availability = 'immediately' WHERE candidate_id = $1", [w.candidateId]);
  r = await check(w.appId);
  assert.equal(r.ok, true, JSON.stringify(r));
  await q("UPDATE js_jobs SET description_text = $2 WHERE id = $1", [w.jobId, `Send your CV to jobs@${w.domain}. Email applications are not accepted - apply via our careers portal.`]);
  r = await check(w.appId);
  assert.equal(r.handoff, "unsupported_channel");
});

test("duplicate minors: other app in needs_staff blocks; employer missing on one side matches title+city; two own queued rows", async () => {
  const w = await world({ title: "Pipe Fitter", location: "Calgary, AB" });
  const other = await addJob(w, { title: "Pipe Fitter", location: "Calgary", employer: `Other Co ${n}` });
  const otherApp = (await applicationService.createFromMatch({ matchId: other.matchId, actor: w.manager })).id;
  assert.equal((await check(w.appId)).ok, true);
  await q("UPDATE js_applications SET status='needs_staff' WHERE id=$1", [otherApp]);
  assert.equal((await check(w.appId)).ok, true, "different employer, both known: not a duplicate");
  await q("UPDATE js_jobs SET employer_id = NULL WHERE id=$1", [other.jobId]);
  let r = await check(w.appId);
  assert.equal(r.code, "duplicate", JSON.stringify(r));
  assert.match(r.detail, /employer unknown/);
  await q("UPDATE js_jobs SET location = 'Edmonton' WHERE id=$1", [other.jobId]);
  assert.equal((await check(w.appId)).ok, true, "employer unknown + different city: not matched");
  // needs_staff for the same posting URL blocks.
  await q("UPDATE js_jobs SET url = (SELECT url FROM js_jobs WHERE id=$2) WHERE id=$1", [other.jobId, w.jobId]);
  assert.equal((await check(w.appId)).code, "duplicate");
  await q("UPDATE js_applications SET status='cancelled' WHERE id=$1", [otherApp]);
  assert.equal((await check(w.appId)).ok, true);
  // Two queued attempts of THIS application.
  await sub(w.appId, "queued");
  assert.equal((await check(w.appId)).ok, true, "one queued attempt (the current one) is fine");
  await sub(w.appId, "queued");
  r = await check(w.appId);
  assert.equal(r.code, "duplicate_submission");
  assert.equal(r.handoff, "staff_review");
});

// ---------------------------------------------------------------- fix round 2

test("handoff corpus round 2 (reviewer probes): positives flagged with the right reason, duty/wage/benefit text not flagged", () => {
  assert.ok(PHRASES.POS2.length >= 60 && PHRASES.NEG2.length >= 80);
  for (const [text, reason] of PHRASES.POS2) {
    const r = guard.detectHandoff({ description_text: text }, {});
    assert.ok(r, `not flagged: ${text}`);
    assert.equal(r.reason, reason, `${text} -> ${r.source}`);
  }
  for (const text of PHRASES.NEG2) {
    const r = guard.detectHandoff({ description_text: text }, {});
    assert.equal(r, null, `false positive: ${text} -> ${r && `${r.reason} ${r.source}`}`);
  }
  // Multi-item requests: every item must be held by the preferences.
  const t = "Applicants must state their expected salary and notice period.";
  assert.equal(guard.detectHandoff({ description_text: t }, { salary_min: 1000 }).reason, "custom_questions", "notice period not held");
  assert.equal(guard.detectHandoff({ description_text: t }, { salary_min: 1000, availability: "2 weeks" }), null);
  // A whole ordinary ad with duty text ("sign for deliveries", "fill out inventory forms", "process customer payments").
  const ad = "Cashier — Acme Market. We pay competitive wages: $19.50-$23/hour. Duties: process customer payments, handle cash, sign for deliveries, fill out inventory forms. Benefits: medical, dental, paid vacation, signing bonus. Fees paid by employer. No account needed — email your resume and cover letter to jobs@acme.com. Please include your availability.";
  assert.equal(guard.detectHandoff({ description_text: ad }, {}).reason, "custom_questions");
  assert.equal(guard.detectHandoff({ description_text: ad }, { availability: "now" }), null);
});

test("long ads: head + tail + keyword windows of the middle are scanned; 200k-char inputs stay linear", () => {
  const filler = (n) => "We are a friendly team in a busy warehouse. ".repeat(Math.ceil(n / 44)).slice(0, n);
  assert.equal(guard.detectHandoff({ description_text: `${filler(25000)}Pay $200 to secure your placement.` }).reason, "payment", "beyond the old 20k cut-off");
  assert.equal(guard.detectHandoff({ description_text: `${filler(60000)} Pay $200 to secure your placement. ${filler(60000)}` }).reason, "payment", "middle of a 120k ad");
  assert.equal(guard.detectHandoff({ description_text: `${filler(60000)} Please confirm you are not a robot. ${filler(60000)}` }).reason, "captcha");
  assert.equal(guard.detectHandoff({ description_text: `${filler(60000)} Je déclare sur l'honneur l'exactitude. ${filler(60000)}` }).reason, "legal_declaration");
  assert.equal(guard.detectHandoff({ description_text: `${filler(100000)} Apply via our website only.` }).reason, "unsupported_channel", "tail");
  assert.equal(guard.detectHandoff({ description_text: filler(150000) }), null);
  for (const unit of ["pay ", "a a a $1 ", "no ", "sign ", "we pay ", "x. ", "1,", "$ ", "fee ", "sign the ", "send $1 ", "-", "please state your ", "reglement de "]) {
    const text = unit.repeat(Math.ceil(200000 / unit.length));
    const t0 = Date.now();
    guard.detectHandoff({ description_text: text });
    assert.ok(Date.now() - t0 < 2000, `${JSON.stringify(unit)} took ${Date.now() - t0} ms`);
  }
});

// ---------------------------------------------------------------- Task 18: unscanned attachments

test("attachment_unscanned: a CV with scan_status 'scan_unavailable' blocks the send unless ALLOW_UNSCANNED_ATTACHMENTS=true", async () => {
  const saved = process.env.ALLOW_UNSCANNED_ATTACHMENTS;
  try {
    const w = await world();
    assert.equal((await check(w.appId)).ok, true, "clean CV: sendable");
    await q("UPDATE js_cv_files SET scan_status='scan_unavailable' WHERE id=$1", [w.cvFileId]);
    for (const v of [undefined, "", "false", "TRUE", "1", "yes"]) {
      if (v === undefined) delete process.env.ALLOW_UNSCANNED_ATTACHMENTS;
      else process.env.ALLOW_UNSCANNED_ATTACHMENTS = v;
      const r = await check(w.appId);
      assert.equal(r.ok, false, `ALLOW_UNSCANNED_ATTACHMENTS=${v}`);
      assert.equal(r.code, "attachment_unscanned", JSON.stringify(r));
      assert.match(r.detail, /attachment_unscanned/);
    }
    assert.ok(guard.GUARD_CODES.includes("attachment_unscanned"));
    process.env.ALLOW_UNSCANNED_ATTACHMENTS = "true";
    assert.equal((await check(w.appId)).ok, true, "explicitly allowed by the administrator");
    // infected always blocks, whatever the setting
    await q("UPDATE js_cv_files SET scan_status='infected' WHERE id=$1", [w.cvFileId]);
    assert.equal((await check(w.appId)).code, "package_changed");
  } finally {
    if (saved === undefined) delete process.env.ALLOW_UNSCANNED_ATTACHMENTS;
    else process.env.ALLOW_UNSCANNED_ATTACHMENTS = saved;
  }
});
