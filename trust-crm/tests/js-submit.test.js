// Submission queue, channels, evidence, handoffs (Task 11). Real Postgres + sandbox mail only.
// The job re-check is injected (no network) except where the HTTP routes use the default one.
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
process.env.JWT_SECRET = "js-submit-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "js-submit-"));
process.env.MAIL_PROVIDER = "sandbox";
process.env.MAIL_SANDBOX_ALLOWLIST = "*@northwind*.example";
process.env.MAIL_FROM = "applications@vita.test.invalid";
delete process.env.CLAMAV_HOST;
delete process.env.MAIL_REAL_SEND;

const applicationService = require("../modules/jobsearch/applicationService");
const consentService = require("../modules/jobsearch/consentService");
const jobStore = require("../modules/jobsearch/jobStore");
const storage = require("../modules/jobsearch/storage");
const queue = require("../modules/jobsearch/queue");
const submitter = require("../modules/jobsearch/submitter");
const workers = require("../modules/jobsearch/workers");
const mail = require("../modules/jobsearch/mail");
const emailChannel = require("../modules/jobsearch/channels/email");
const unsupported = require("../modules/jobsearch/channels/unsupported");

const PROFILE = {
  name: "Karim Benali",
  email: "karim@example.com",
  profession: "Electrician",
  skills: ["Industrial wiring"],
  experience: [{ title: "Maintenance Electrician", employer: "Sfax Power Co", start: "2016", end: "2023" }],
  languages: [{ lang: "English", level: "fluent" }],
};
const OPEN = async () => ({ status: "open", verified: true });
const CLOSED = async () => ({ status: "closed", verified: true });
const DEPS = { recheck: OPEN };

let pool;
let cleanup;
let adminId;
let n = 0;
let server;
let base;

test.before(async () => {
  ({ pool, cleanup } = await createTestDb());
  const app = loadApp(pool);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminId = (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('Adm','adm-submit@test.invalid','x','Admin') RETURNING id")).rows[0].id;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await cleanup();
});

const q = (sql, params) => pool.query(sql, params);
const status = async (id) => (await q("SELECT status FROM js_applications WHERE id=$1", [id])).rows[0].status;
const subsOf = async (appId) => (await q("SELECT * FROM js_submissions WHERE application_id=$1 ORDER BY id", [appId])).rows;
const tasksOf = async (appId) => (await q("SELECT * FROM js_tasks WHERE application_id=$1 ORDER BY id", [appId])).rows;
const outbound = async (to) => mail.sandbox.listOutbound({ to });
const timelineOf = async (appId) => (await q("SELECT * FROM js_timeline WHERE application_id=$1 ORDER BY id", [appId])).rows;
const queueItem = async (submissionId) => (await q("SELECT * FROM js_queue WHERE kind='submit' AND payload->>'submissionId'=$1", [String(submissionId)])).rows[0];
const token = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });

async function candidateToken(userId) {
  const tv = (await q("SELECT token_version FROM users WHERE id=$1", [userId])).rows[0].token_version;
  return jwt.sign({ id: userId, role: "Candidate", tv }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

async function http(method, url, tok, body) {
  const res = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function mkUser(role, active = true) {
  n += 1;
  return (await q("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x',$3,$4) RETURNING id", [`U${n}`, `u${n}-submit@test.invalid`, role, active])).rows[0].id;
}

/** Candidate (account, confirmed profile, consent, settings, approved CV) + employer/job/match + approved application. */
async function world(opts = {}) {
  const w = {};
  w.managerId = opts.managerId || (await mkUser("Manager"));
  w.manager = { id: w.managerId, role: "Manager" };
  if (opts.candidate) Object.assign(w, opts.candidate);
  else {
    n += 1;
    w.candidateId = (await q("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`Cand ${n}`, `PP-S-${n}`, w.managerId])).rows[0].id;
    w.userId = await mkUser("Candidate");
    await q("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [w.userId, w.candidateId]);
    await q("INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1,$2::jsonb,'confirmed',now())", [w.candidateId, JSON.stringify(PROFILE)]);
    await q("INSERT INTO js_preferences (candidate_id, countries, residence_country, needs_work_auth_support) VALUES ($1,'{Canada}','Tunisia',false)", [w.candidateId]);
    await q("INSERT INTO js_consents (candidate_id, scope, version) VALUES ($1,$2::jsonb,'v1')", [w.candidateId, JSON.stringify({ search: true, prepare: true, submit: true, countries: [] })]);
    await q("INSERT INTO js_candidate_settings (candidate_id, mode, cap_per_day, cap_per_week) VALUES ($1,$2,5,20)", [w.candidateId, opts.auto ? "automatic" : "prepare_for_approval"]);
    const pdf = makePdf(`Karim Benali\nElectrician ${n}`);
    const put = await storage.put(pdf, { candidateId: w.candidateId });
    w.cvKey = put.key;
    w.cvSha = put.sha256;
    w.cvFileId = (await q("INSERT INTO js_cv_files (candidate_id, storage_key, sha256, version, language, approved, scan_status) VALUES ($1,$2,$3,1,'en',true,'clean') RETURNING id", [w.candidateId, put.key, put.sha256])).rows[0].id;
  }
  Object.assign(w, await addJob(w, opts));
  if (opts.auto) {
    await q("UPDATE js_candidate_settings SET admin_approved_by=$2, allowed_countries='{Canada}', approved_doc_versions=$3::jsonb WHERE candidate_id=$1", [w.candidateId, adminId, JSON.stringify([{ cvFileId: w.cvFileId }])]);
    if (!opts.candidate) await q("INSERT INTO js_automation_rules (candidate_id, rule, approved_by, approved_at, active) VALUES ($1,'{}'::jsonb,$2,now(),true)", [w.candidateId, adminId]);
  }
  if (opts.beforePrepare) await opts.beforePrepare(w);
  w.appId = (await applicationService.createFromMatch({ matchId: w.matchId, actor: w.manager })).id;
  const p = await applicationService.prepareApplication({ id: w.appId, actor: w.manager, documents: opts.documents ? opts.documents(w) : undefined });
  assert.equal(p.application.status, "ready_for_review", JSON.stringify(p.package));
  if (opts.auto) {
    const r = await applicationService.autoApprove(w.appId);
    assert.equal(r.approved, true, JSON.stringify(r.reasons));
  } else {
    await applicationService.approveApplication({ id: w.appId, actor: w.manager, reason: "reviewed" });
  }
  w.recipient = `jobs@${w.domain}`;
  return w;
}

async function addJob(w, opts = {}) {
  n += 1;
  const domain = opts.domain || `northwind${n}.example`;
  const employerName = opts.employer || `Northwind Energy ${n}`;
  const employerId = (await q("INSERT INTO js_employers (name, normalized_name, domain, verified_contact_email) VALUES ($1,$2,$3,$4) RETURNING id", [employerName, jobStore.normalizeEmployer(employerName), domain, opts.contact === undefined ? `jobs@${domain}` : opts.contact])).rows[0].id;
  const sourceKey = `s_src_${n}`;
  const sourceId = (await q("INSERT INTO js_sources (key, adapter, status) VALUES ($1,'partner_feed','connected') RETURNING id", [sourceKey])).rows[0].id;
  const url = opts.url || `https://jobs.example/s${n}`;
  const jobId = (await q(
    "INSERT INTO js_jobs (title, country, location, employer_id, source_primary, dedupe_key, description_text, url) VALUES ($1,'Canada','Toronto, Canada',$2,$3,$4,$5,$6) RETURNING id",
    [opts.title || "Electrician", employerId, sourceKey, `dk-submit-${n}`, opts.text || `We are hiring an Electrician for our plant. Send your CV to jobs@${domain}.`, url]
  )).rows[0].id;
  await q("INSERT INTO js_job_sightings (job_id, source_id, source_job_id, url) VALUES ($1,$2,$3,$4)", [jobId, sourceId, `sj-${n}`, url]);
  const support = opts.auto ? "confirmed" : "unknown";
  const matchId = (await q(
    "INSERT INTO js_matches (candidate_id, job_id, score, employer_support, employer_support_evidence, overseas_accepted) VALUES ($1,$2,80,$3,$4,$5) RETURNING id",
    [w.candidateId, jobId, support, support === "unknown" ? null : "Staff confirmed with employer.", opts.auto ? true : null]
  )).rows[0].id;
  return { employerId, jobId, matchId, sourceId, domain, employerName };
}

/** queueSubmission (manager) + returns the queue item as the worker would claim it. */
async function queued(w, actor) {
  const r = await submitter.queueSubmission(w.appId, actor === undefined ? w.manager : actor, DEPS);
  assert.equal(r.queued, true, JSON.stringify(r));
  const item = await queueItem(r.submissionId);
  return { ...r, job: item };
}

// ---------------------------------------------------------------- happy path

test("happy path: exactly one mail, submission 'sent' with provider id + exact document versions/sha256, application 'sent' (never confirmed without evidence)", async () => {
  const w = await world();
  const r = await queued(w);
  assert.equal(await status(w.appId), "queued");
  assert.equal(r.recipient, w.recipient);
  assert.deepEqual(r.job.payload, { applicationId: w.appId, candidateId: w.candidateId, submissionId: r.submissionId });
  const tl = await timelineOf(w.appId);
  const resolved = tl.find((e) => e.event === "recipient_resolved");
  assert.equal(resolved.detail.recipientSource, "verified_contact");
  assert.equal(resolved.detail.recipient, undefined, "addresses stay out of the timeline");
  const resolvedAudit = (await q("SELECT detail FROM js_audit_events WHERE application_id=$1 AND action='submission.recipient_resolved'", [w.appId])).rows[0];
  assert.equal(resolvedAudit.detail.recipient, w.recipient, "staff history (audit) shows where the CV goes");
  let [sub] = await subsOf(w.appId);
  assert.equal(sub.status, "queued");
  assert.equal(sub.idempotency_key, `app:${w.appId}:a1`);
  assert.equal(r.job.idempotency_key, `submit:${w.appId}:1`);

  const out = await submitter.handleSubmit(r.job, DEPS);
  assert.equal(out.status, "sent", JSON.stringify(out));
  const mails = await outbound(w.recipient);
  assert.equal(mails.length, 1);
  [sub] = await subsOf(w.appId);
  assert.equal(sub.status, "sent");
  assert.ok(sub.sent_at);
  assert.equal(sub.confirmed_at, null);
  assert.equal(sub.provider_message_id, mails[0].message_id);
  assert.equal(sub.evidence.phase, "sent");
  assert.equal(sub.evidence.recipient, w.recipient);
  assert.equal(sub.evidence.channel, "email");
  assert.deepEqual(sub.evidence.docs, [{ kind: "cv", cvFileId: w.cvFileId, documentId: null, version: 1, sha256: w.cvSha, sensitive: false }]);
  assert.equal(sub.evidence.providerResponse.accepted, true);
  // attachment bytes came from storage and match the recorded hash
  assert.equal(mails[0].attachments.length, 1);
  assert.equal(mails[0].attachments[0].sha256, w.cvSha);
  assert.match(mails[0].attachments[0].filename, /^CV-Karim-Benali-v1\.pdf$/);
  assert.match(mails[0].subject, /^Application: Electrician - Karim Benali \[VITA-[a-f0-9]{20}\]$/);
  assert.equal(mails[0].headers["X-VITA-Ref"], sub.evidence.replyToken);
  assert.match(mails[0].headers["Reply-To"], /^applications\+vita-[a-f0-9]{20}@vita\.test\.invalid$/);
  assert.equal(mails[0].headers["Message-ID"], sub.evidence.messageIdPlanned);
  assert.ok(mails[0].body.includes("Dear"), "body is the cover letter");
  assert.equal((await submitter.findByReplyToken(sub.evidence.replyToken)).id, sub.id);
  assert.equal(await status(w.appId), "sent");
  const app = (await q("SELECT status FROM js_applications WHERE id=$1", [w.appId])).rows[0];
  assert.notEqual(app.status, "confirmed_submitted");
  // audited
  const acts = (await q("SELECT action FROM js_audit_events WHERE application_id=$1", [w.appId])).rows.map((x) => x.action);
  for (const a of ["submission.queued", "submission.sending", "submission.sent"]) assert.ok(acts.includes(a), a);
  assert.ok((await q("SELECT 1 FROM js_events WHERE kind='submission.sent' AND payload->>'submissionId'=$1", [String(sub.id)])).rowCount);
  assert.ok((await q("SELECT 1 FROM audit_logs WHERE action='jobsearch.submission.sent' AND record_id=$1", [String(sub.id)])).rowCount);
});

// ---------------------------------------------------------------- idempotency / concurrency

test("double queueSubmission + double handleSubmit -> one submission row, one queue item, exactly one mail", async () => {
  const w = await world();
  const [a, b] = await Promise.all([submitter.queueSubmission(w.appId, w.manager, DEPS), submitter.queueSubmission(w.appId, w.manager, DEPS)]);
  assert.equal(a.queued && b.queued, true);
  assert.equal(a.submissionId, b.submissionId);
  const again = await submitter.queueSubmission(w.appId, w.manager, DEPS);
  assert.equal(again.existing, true);
  assert.equal((await subsOf(w.appId)).length, 1);
  assert.equal((await q("SELECT count(*)::int AS n FROM js_queue WHERE kind='submit' AND payload->>'applicationId'=$1", [String(w.appId)])).rows[0].n, 1);
  const job = await queueItem(a.submissionId);
  assert.equal((await submitter.handleSubmit(job, DEPS)).status, "sent");
  const second = await submitter.handleSubmit(job, DEPS);
  assert.equal(second.status, "noop");
  assert.equal((await outbound(w.recipient)).length, 1);
  // queueing again after it was sent is refused by the guard (application is 'sent')
  const late = await submitter.queueSubmission(w.appId, w.manager, DEPS);
  assert.equal(late.queued, false);
});

test("concurrent handleSubmit x3 on the same item -> exactly one mail", async () => {
  const w = await world();
  const r = await queued(w);
  const results = await Promise.all([submitter.handleSubmit(r.job, DEPS), submitter.handleSubmit(r.job, DEPS), submitter.handleSubmit(r.job, DEPS)]);
  assert.equal(results.filter((x) => x.status === "sent").length, 1, JSON.stringify(results));
  assert.ok(results.every((x) => ["sent", "noop", "in_progress"].includes(x.status)), JSON.stringify(results));
  assert.equal((await outbound(w.recipient)).length, 1);
  assert.equal((await subsOf(w.appId))[0].status, "sent");
});

test("worker concurrency: two claim() calls never return the same item", async () => {
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push((await queue.enqueue({ kind: "claimtest", payload: { i }, idempotencyKey: `ct-${crypto.randomUUID()}` })).id);
  const [a, b] = await Promise.all([queue.claim(["claimtest"], 4), queue.claim(["claimtest"], 4)]);
  const got = [...a, ...b].map((x) => x.id);
  assert.equal(new Set(got).size, got.length, "no item claimed twice");
  assert.equal(got.length, 6);
  // work() with two concurrent loops runs each item exactly once
  for (let i = 0; i < 6; i += 1) await queue.enqueue({ kind: "worktest", payload: { i }, idempotencyKey: `wt-${crypto.randomUUID()}` });
  const seen = [];
  const handlers = { worktest: async (job) => { seen.push(job.id); await new Promise((r) => setTimeout(r, 5)); } };
  await Promise.all([queue.work(handlers, { batch: 2, loop: true }), queue.work(handlers, { batch: 2, loop: true })]);
  assert.equal(seen.length, 6);
  assert.equal(new Set(seen).size, 6);
});

// ---------------------------------------------------------------- crash safety

test("provider throws (timeout) after the intent was persisted -> outcome_unknown + verify_delivery task + needs_staff; never retried", async () => {
  const w = await world();
  const r = await queued(w);
  const mailSend = async () => {
    const e = new Error("Connection timeout");
    e.code = "ETIMEDOUT";
    throw e;
  };
  const out = await submitter.handleSubmit(r.job, { ...DEPS, mailSend });
  assert.equal(out.status, "outcome_unknown");
  const [sub] = await subsOf(w.appId);
  assert.equal(sub.status, "outcome_unknown");
  assert.equal(sub.evidence.phase, "outcome_unknown");
  assert.match(sub.evidence.providerError, /ETIMEDOUT/);
  const tasks = await tasksOf(w.appId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].reason, "verify_delivery");
  assert.equal(tasks[0].assigned_to, w.managerId);
  assert.equal(await status(w.appId), "needs_staff");
  // re-running the item, or queueing again, never sends
  assert.equal((await submitter.handleSubmit(r.job, DEPS)).status, "noop");
  const again = await submitter.queueSubmission(w.appId, w.manager, DEPS);
  assert.equal(again.queued, false);
  assert.equal((await outbound(w.recipient)).length, 0);
});

test("provider delivered and then threw -> one mail, recorded outcome_unknown (honest), no second mail", async () => {
  const w = await world();
  const r = await queued(w);
  const mailSend = async (m) => {
    await mail.send(m);
    throw new Error("socket hang up");
  };
  assert.equal((await submitter.handleSubmit(r.job, { ...DEPS, mailSend })).status, "outcome_unknown");
  assert.equal((await submitter.handleSubmit(r.job, DEPS)).status, "noop");
  assert.equal((await outbound(w.recipient)).length, 1);
});

test("process dies after the intent (before the provider call): re-run finds phase 'sending' -> outcome_unknown, no mail", async () => {
  const w = await world();
  const r = await queued(w);
  const die = async () => {
    throw new Error("simulated process death");
  };
  await assert.rejects(submitter.handleSubmit(r.job, { ...DEPS, onIntentPersisted: die }), /simulated process death/);
  let [sub] = await subsOf(w.appId);
  assert.equal(sub.status, "queued");
  assert.equal(sub.evidence.phase, "sending");
  assert.ok(sub.evidence.messageIdPlanned);
  assert.deepEqual(sub.evidence.docs.map((d) => d.sha256), [w.cvSha]);
  const out = await submitter.handleSubmit(r.job, DEPS);
  assert.equal(out.status, "outcome_unknown");
  assert.equal(out.reason, "interrupted_after_intent");
  [sub] = await subsOf(w.appId);
  assert.equal(sub.status, "outcome_unknown");
  assert.equal((await tasksOf(w.appId))[0].reason, "verify_delivery");
  assert.equal((await outbound(w.recipient)).length, 0);
});

test("reclaimStale: crashed 'running' items go back to pending (attempts kept) or failed at max; a reclaimed submit in phase 'sending' becomes outcome_unknown", async () => {
  const w = await world();
  const r = await queued(w);
  const now = new Date();
  // the worker claimed it, wrote the intent, and died
  const [claimed] = await queue.claim(["submit"], 50).then((rows) => rows.filter((x) => x.id === r.job.id));
  assert.ok(claimed);
  await assert.rejects(submitter.handleSubmit(claimed, { ...DEPS, onIntentPersisted: async () => { throw new Error("killed"); } }));
  assert.equal((await q("SELECT status FROM js_queue WHERE id=$1", [r.job.id])).rows[0].status, "running");
  // not stale yet
  assert.equal((await queue.reclaimStale({ now })).ids.includes(Number(r.job.id)), false);
  const later = new Date(now.getTime() + 16 * 60 * 1000);
  const swept = await queue.reclaimStale({ now: later });
  assert.ok(swept.ids.includes(Number(r.job.id)));
  const row = (await q("SELECT status, attempts, locked_at FROM js_queue WHERE id=$1", [r.job.id])).rows[0];
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  assert.equal(row.locked_at, null);
  // the worker picks it up again: no resend
  const processed = await queue.work({ submit: (job) => submitter.handleSubmit(job, DEPS) }, { kinds: ["submit"], loop: true });
  assert.ok(processed >= 1);
  assert.equal((await subsOf(w.appId))[0].status, "outcome_unknown");
  assert.equal((await outbound(w.recipient)).length, 0);
  // at max attempts a stale item becomes failed
  const x = await queue.enqueue({ kind: "staletest", payload: {}, idempotencyKey: `st-${crypto.randomUUID()}` });
  await q("UPDATE js_queue SET status='running', attempts=5, locked_at = now() - interval '1 hour' WHERE id=$1", [x.id]);
  await queue.reclaimStale();
  assert.equal((await q("SELECT status FROM js_queue WHERE id=$1", [x.id])).rows[0].status, "failed");
});

test("sweepStuckSending: an interrupted send whose queue item is gone is closed as outcome_unknown (never sent)", async () => {
  const w = await world();
  const r = await queued(w);
  await assert.rejects(submitter.handleSubmit(r.job, { ...DEPS, onIntentPersisted: async () => { throw new Error("killed"); } }));
  await q("UPDATE js_queue SET status='cancelled' WHERE id=$1", [r.job.id]);
  const res = await workers.tick({ kinds: ["submit"] });
  assert.ok(res.interrupted >= 1);
  assert.equal((await subsOf(w.appId))[0].status, "outcome_unknown");
  assert.equal((await outbound(w.recipient)).length, 0);
});

// ---------------------------------------------------------------- pre-send guard at send time

test("consent withdrawn after queueing (real withdrawal): the withdrawal cancels the application and fails the queued submission ('cancelled'); a claimed item then finds nothing to send (noop), zero mails", async () => {
  const w = await world();
  const r = await queued(w);
  await consentService.withdrawConsent({ user: { id: w.userId, role: "Candidate" }, candidateId: w.candidateId, scopeKey: "submit" });
  assert.equal(await status(w.appId), "cancelled");
  assert.equal((await q("SELECT status FROM js_queue WHERE id=$1", [r.job.id])).rows[0].status, "cancelled");
  // The withdrawal itself closes the not-yet-sent attempt (Task 16: a cancelled application never keeps a
  // 'queued' submission, even when its queue item is cancelled before any worker claims it) ...
  let [sub] = await subsOf(w.appId);
  assert.equal(sub.status, "failed");
  assert.equal(sub.evidence.reason, "cancelled");
  // ... so an item that was already claimed when the withdrawal landed finds nothing to send.
  const out = await submitter.handleSubmit(r.job, DEPS);
  assert.equal(out.status, "noop");
  assert.equal(out.reason, "submission_failed");
  [sub] = await subsOf(w.appId);
  assert.equal(sub.status, "failed");
  assert.equal(sub.evidence.reason, "cancelled");
  assert.equal(await status(w.appId), "cancelled");
  assert.equal((await outbound(w.recipient)).length, 0);
});

test("consent withdrawn in flight (consent row only): guard consent_withdrawn -> cancelled, submission failed guard:consent_withdrawn, zero mails", async () => {
  const w = await world();
  const r = await queued(w);
  await q(`UPDATE js_consents SET scope = scope || '{"submit": false, "withdrawn": {"submit": "2026-10-23T00:00:00Z"}}'::jsonb WHERE candidate_id=$1`, [w.candidateId]);
  const out = await submitter.handleSubmit(r.job, DEPS);
  assert.equal(out.code, "consent_withdrawn");
  assert.equal(await status(w.appId), "cancelled");
  const [sub] = await subsOf(w.appId);
  assert.equal(sub.status, "failed");
  assert.equal(sub.evidence.reason, "guard:consent_withdrawn");
  assert.equal((await outbound(w.recipient)).length, 0);
});

test("account suspended after queueing -> cancelled (terminal), zero mails", async () => {
  const w = { recipient: "none@nowhere.example" };
  const w2 = await world();
  const r2 = await queued(w2);
  await q("UPDATE users SET is_active=false WHERE id=$1", [w2.userId]);
  assert.equal((await submitter.handleSubmit(r2.job, DEPS)).code, "user_suspended");
  assert.equal(await status(w2.appId), "cancelled");
  assert.equal((await outbound(w.recipient)).length + (await outbound(w2.recipient)).length, 0);
});

for (const [label, pause, unpause] of [
  ["candidate", (w) => q("UPDATE js_candidate_settings SET paused=true WHERE candidate_id=$1", [w.candidateId]), (w) => q("UPDATE js_candidate_settings SET paused=false WHERE candidate_id=$1", [w.candidateId])],
  ["module", () => q(`INSERT INTO js_module_state (key, value) VALUES ('module_paused','{"paused":true}'::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`), () => q(`UPDATE js_module_state SET value='{"paused":false}'::jsonb WHERE key='module_paused'`)],
  ["source", (w) => q("UPDATE js_sources SET paused=true WHERE id=$1", [w.sourceId]), (w) => q("UPDATE js_sources SET paused=false WHERE id=$1", [w.sourceId])],
]) {
  test(`${label} pause after queueing is a HOLD: application back to approved, attempt failed held:*, no task, zero mails; resume + queueSubmission -> one mail, attempt 2`, async () => {
    const w = await world();
    const r = await queued(w);
    await pause(w);
    let out;
    try {
      out = await submitter.handleSubmit(r.job, DEPS);
    } finally {
      await unpause(w);
    }
    assert.equal(out.status, "held", JSON.stringify(out));
    assert.equal(out.code, `${label}_paused`);
    assert.equal(await status(w.appId), "approved");
    const [s1] = await subsOf(w.appId);
    assert.equal(s1.status, "failed");
    assert.equal(s1.evidence.reason, `held:${label}_paused`);
    assert.deepEqual(await tasksOf(w.appId), []);
    const tl = await timelineOf(w.appId);
    assert.ok(tl.some((e) => e.event === "held_paused" && e.detail.to === "approved" && e.actor === "system:submitter"));
    assert.equal((await outbound(w.recipient)).length, 0);
    // pause lifted: the scheduler (Task 12) re-queues approved applications via queueSubmission
    const again = await submitter.queueSubmission(w.appId, undefined, DEPS);
    assert.equal(again.queued, true, JSON.stringify(again));
    assert.equal(again.attempt, 2);
    const subs = await subsOf(w.appId);
    assert.equal(subs[1].idempotency_key, `app:${w.appId}:a2`);
    const job2 = await queueItem(again.submissionId);
    assert.equal(job2.idempotency_key, `submit:${w.appId}:2`);
    assert.equal((await submitter.handleSubmit(job2, DEPS)).status, "sent");
    assert.equal((await outbound(w.recipient)).length, 1);
    assert.equal(await status(w.appId), "sent");
  });
}

test("queued -> approved is a system-only transition (users 403, no grant 403)", async () => {
  const w = await world();
  await queued(w);
  await assert.rejects(applicationService.transition(w.appId, "approved", w.manager), (e) => e.status === 403);
  await assert.rejects(applicationService.transition(w.appId, "approved", "system:x"), (e) => e.status === 403);
  assert.equal(await status(w.appId), "queued");
});

test("pause AND consent withdrawn at send time -> still cancelled (consent wins over the hold)", async () => {
  const w = await world();
  const r = await queued(w);
  await q("UPDATE js_candidate_settings SET paused=true WHERE candidate_id=$1", [w.candidateId]);
  await q(`UPDATE js_consents SET scope = scope || '{"submit": false, "withdrawn": {"submit": "2026-10-23T00:00:00Z"}}'::jsonb WHERE candidate_id=$1`, [w.candidateId]);
  const out = await submitter.handleSubmit(r.job, DEPS);
  assert.equal(out.code, "consent_withdrawn");
  assert.equal(await status(w.appId), "cancelled");
  assert.equal((await outbound(w.recipient)).length, 0);
});

test("job closed meanwhile -> application closed, submission failed, zero mails", async () => {
  const w = await world();
  const r = await queued(w);
  const out = await submitter.handleSubmit(r.job, { recheck: CLOSED });
  assert.equal(out.code, "job_closed");
  assert.equal(await status(w.appId), "closed");
  assert.equal((await subsOf(w.appId))[0].status, "failed");
  assert.equal((await outbound(w.recipient)).length, 0);
  // and at queue time
  const w2 = await world();
  await q("UPDATE js_jobs SET status='closed' WHERE id=$1", [w2.jobId]);
  const refused = await submitter.queueSubmission(w2.appId, w2.manager, DEPS);
  assert.equal(refused.queued, false);
  assert.equal(refused.reason, "job_closed");
  assert.equal((await subsOf(w2.appId)).length, 0);
  assert.ok((await timelineOf(w2.appId)).some((e) => e.event === "queue_refused" && e.detail.code === "job_closed"));
});

test("same vacancy via two sightings/rows -> one submission; the second is refused as a duplicate", async () => {
  const w = await world();
  const url = (await q("SELECT url FROM js_jobs WHERE id=$1", [w.jobId])).rows[0].url;
  // A second js_jobs row for the same posting (another source, same URL) -> another application.
  const dup = await addJob(w, { url, domain: w.domain, contact: `jobs@${w.domain}`, employer: `${w.employerName} B` });
  const app2 = (await applicationService.createFromMatch({ matchId: dup.matchId, actor: w.manager })).id;
  await applicationService.prepareApplication({ id: app2, actor: w.manager });
  await applicationService.approveApplication({ id: app2, actor: w.manager, reason: "ok" });
  const r = await queued(w);
  const second = await submitter.queueSubmission(app2, w.manager, DEPS);
  assert.equal(second.queued, false);
  assert.equal(second.reason, "duplicate");
  // the duplicate appears only at send time (queued before the twin was): needs_staff + duplicate_review
  const w3 = await world();
  const url3 = (await q("SELECT url FROM js_jobs WHERE id=$1", [w3.jobId])).rows[0].url;
  const dup3 = await addJob(w3, { url: url3, domain: w3.domain, employer: `${w3.employerName} C` });
  const app3 = (await applicationService.createFromMatch({ matchId: dup3.matchId, actor: w3.manager })).id;
  await applicationService.prepareApplication({ id: app3, actor: w3.manager });
  await applicationService.approveApplication({ id: app3, actor: w3.manager, reason: "ok" });
  const ra = await submitter.queueSubmission(w3.appId, w3.manager, DEPS);
  const jobA = await queueItem(ra.submissionId);
  assert.equal((await submitter.handleSubmit(jobA, DEPS)).status, "sent");
  // app3 got queued earlier through a path that skipped the duplicate (simulated: direct rows)
  await applicationService.transition(app3, "queued", w3.manager);
  const sub3 = (await q("INSERT INTO js_submissions (application_id, attempt_no, idempotency_key, channel, recipient, status) VALUES ($1,1,$2,'email',$3,'queued') RETURNING id", [app3, `app:${app3}:a1`, w3.recipient])).rows[0].id;
  const out3 = await submitter.handleSubmit({ id: null, payload: { applicationId: app3, submissionId: sub3 } }, DEPS);
  assert.equal(out3.code, "duplicate");
  assert.equal(await status(app3), "needs_staff");
  assert.equal((await tasksOf(app3))[0].reason, "duplicate_review");
  const s3 = (await subsOf(app3))[0];
  assert.equal(s3.status, "failed");
  assert.equal(s3.evidence.reason, "guard:duplicate");
  assert.equal((await outbound(w3.recipient)).length, 1);
  assert.equal((await submitter.handleSubmit(r.job, DEPS)).status, "sent");
  assert.equal((await q("SELECT count(*)::int AS n FROM js_submissions s JOIN js_applications a ON a.id=s.application_id WHERE a.candidate_id=$1", [w.candidateId])).rows[0].n, 1);
  assert.equal((await outbound(w.recipient)).length, 1);
});

for (const [text, reason] of [
  ["Apply online: complete the CAPTCHA before submitting.", "captcha"],
  ["A processing fee of $200 is payable by the applicant.", "payment"],
  ["Please log in to our careers portal to apply.", "login"],
  ["Applicants must sign a sworn declaration of their history.", "legal_declaration"],
  ["Answer the following screening questions in your email.", "custom_questions"],
]) {
  test(`handoff '${reason}' detected after queueing -> js_tasks(${reason}) for the responsible staff, needs_staff, zero mails`, async () => {
    const w = await world();
    const r = await queued(w);
    await q("UPDATE js_jobs SET description_text=$2 WHERE id=$1", [w.jobId, `${text} Send your CV to jobs@${w.domain}.`]);
    const out = await submitter.handleSubmit(r.job, DEPS);
    assert.equal(out.status, "blocked");
    assert.equal(out.code, "handoff_required");
    const tasks = await tasksOf(w.appId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].reason, reason);
    assert.equal(tasks[0].assigned_to, w.managerId);
    assert.equal(await status(w.appId), "needs_staff");
    assert.equal((await subsOf(w.appId))[0].status, "failed");
    assert.equal((await outbound(w.recipient)).length, 0);
    // at queue time the same posting is refused with the handoff reason
    const w2 = await world({ text: `${text} Send your CV to jobs@DOMAIN.` });
    await q("UPDATE js_jobs SET description_text=$2 WHERE id=$1", [w2.jobId, `${text} Send your CV to jobs@${w2.domain}.`]);
    const refused = await submitter.queueSubmission(w2.appId, w2.manager, DEPS);
    assert.equal(refused.queued, false);
    assert.equal(refused.handoff, reason);
  });
}

test("channels/unsupported: detectChannel returns 'email' or the handoff reason; createHandoffTask is idempotent while open", async () => {
  assert.equal(unsupported.detectChannel({ channel: "email" }, { description_text: "Send your CV to jobs@x.example" }), "email");
  assert.equal(unsupported.detectChannel({ channel: "portal" }, { description_text: "" }), "unsupported_channel");
  assert.equal(unsupported.detectChannel({}, { flags: { requires_captcha: true } }), "captcha");
  const w = await world();
  const c = await pool.connect();
  try {
    const a = await unsupported.createHandoffTask(c, { applicationId: w.appId, reason: "captcha", detail: "x", assignedTo: w.managerId });
    const b = await unsupported.createHandoffTask(c, { applicationId: w.appId, reason: "captcha", detail: "y", assignedTo: w.managerId });
    assert.equal(a.id, b.id);
  } finally {
    c.release();
  }
});

test("non-allow-listed recipient (sandbox refuses) -> submission failed + delivery_failed task, application failed, never 'sent'", async () => {
  const w = await world({ domain: "acme-real.org" });
  const r = await queued(w);
  const out = await submitter.handleSubmit(r.job, DEPS);
  assert.equal(out.status, "failed");
  assert.match(out.reason, /ALLOWLIST/);
  const [sub] = await subsOf(w.appId);
  assert.equal(sub.status, "failed");
  assert.equal(sub.sent_at, null);
  assert.equal(sub.provider_message_id, null);
  assert.equal(await status(w.appId), "failed");
  assert.equal((await tasksOf(w.appId))[0].reason, "delivery_failed");
  assert.equal((await outbound(w.recipient)).length, 0);
});

test("system:auto approval to an ad-named unrelated recipient -> refused by the guard (staff_review), nothing queued", async () => {
  const w = await world({ auto: true, contact: null, text: "Electrician wanted. Apply: hr@employer-careers-fast.com" });
  const r = await submitter.queueSubmission(w.appId, undefined, DEPS);
  assert.equal(r.queued, false);
  assert.equal(r.reason, "recipient_unverified");
  assert.equal(r.handoff, "staff_review");
  assert.equal((await subsOf(w.appId)).length, 0);
  assert.equal(await status(w.appId), "approved");
  // the same system path works for a verified contact (SYSTEM_GRANT inside the submitter's transaction)
  const ok = await world({ auto: true });
  const r2 = await submitter.queueSubmission(ok.appId, undefined, DEPS);
  assert.equal(r2.queued, true, JSON.stringify(r2));
  const tl = await timelineOf(ok.appId);
  assert.ok(tl.some((e) => e.event === "status_changed" && e.detail.to === "queued" && e.actor === "system:submitter"));
});

test("recipient changed between queue and send -> blocked (staff_review), zero mails", async () => {
  const w = await world();
  const r = await queued(w);
  await q("UPDATE js_employers SET verified_contact_email=$2 WHERE id=$1", [w.employerId, `careers@${w.domain}`]);
  const out = await submitter.handleSubmit(r.job, DEPS);
  assert.equal(out.code, "recipient_changed");
  assert.equal(await status(w.appId), "needs_staff");
  assert.equal((await tasksOf(w.appId))[0].reason, "staff_review");
  assert.equal((await mail.sandbox.listOutbound()).filter((m) => m.to_addr.endsWith(w.domain)).length, 0);
});

// ---------------------------------------------------------------- documents

async function passportWorld() {
  return world({
    beforePrepare: async (w) => {
      const pdf = makePdf(`Passport scan ${w.candidateId}`);
      const put = await storage.put(pdf, { candidateId: w.candidateId });
      w.passportSha = put.sha256;
      w.passportDocId = (await q("INSERT INTO documents (candidate_id, doc_type, file_path) VALUES ($1,'passport',$2) RETURNING id", [w.candidateId, put.key])).rows[0].id;
      w.candidateUser = { id: w.userId, role: "Candidate" };
      // the application must exist to authorize: create it first, authorize, then prepare.
      const appId = (await applicationService.createFromMatch({ matchId: w.matchId, actor: w.manager })).id;
      w.authId = (await applicationService.grantSharing({ id: appId, actor: w.candidateUser, documentId: w.passportDocId, legitimateNeed: "Employer requires identity check for the work permit file" })).id;
    },
    documents: (w) => [{ documentId: w.passportDocId }],
  });
}

test("sensitive document: sent only when authorized (exact sha256 attached); authorization revoked after queueing -> blocked, zero mails", async () => {
  const ok = await passportWorld();
  const r = await queued(ok);
  assert.equal((await submitter.handleSubmit(r.job, DEPS)).status, "sent");
  const [m] = await outbound(ok.recipient);
  assert.deepEqual(m.attachments.map((a) => a.sha256).sort(), [ok.cvSha, ok.passportSha].sort());
  const sub = (await subsOf(ok.appId))[0];
  assert.ok(sub.evidence.docs.some((d) => d.documentId === ok.passportDocId && d.sensitive === true && d.sha256 === ok.passportSha));

  // revoked in flight (raw: the claimed item still runs) -> guard sensitive_unauthorized
  const w = await passportWorld();
  const r2 = await queued(w);
  await q("UPDATE js_sharing_authorizations SET revoked_at = now() WHERE id=$1", [w.authId]);
  const out = await submitter.handleSubmit(r2.job, DEPS);
  assert.equal(out.code, "sensitive_unauthorized");
  assert.equal(await status(w.appId), "needs_staff");
  assert.equal((await outbound(w.recipient)).length, 0);

  // revoked through the candidate API -> application back to preparing, queue item cancelled, nothing sent
  const w3 = await passportWorld();
  const r3 = await queued(w3);
  await applicationService.revokeSharing({ id: w3.appId, actor: w3.candidateUser, authorizationId: w3.authId });
  assert.equal(await status(w3.appId), "preparing");
  assert.equal((await subsOf(w3.appId))[0].status, "failed", "the revocation closes the queued attempt at once");
  assert.equal((await subsOf(w3.appId))[0].evidence.reason, "cancelled");
  const out3 = await submitter.handleSubmit(r3.job, DEPS); // a worker that had already claimed the item
  assert.equal(out3.status, "noop");
  assert.equal((await subsOf(w3.appId))[0].status, "failed");
  assert.equal((await outbound(w3.recipient)).length, 0);
});

test("stored CV bytes changed after queueing -> blocked (package_changed), zero mails", async () => {
  const w = await world();
  const r = await queued(w);
  fs.writeFileSync(path.join(process.env.STORAGE_DIR, w.cvKey), makePdf("tampered"));
  const out = await submitter.handleSubmit(r.job, DEPS);
  assert.equal(out.code, "package_changed");
  assert.equal((await outbound(w.recipient)).length, 0);
});

test("channels/email.loadAttachments: bytes from storage by key, hash-verified, generated filenames", async () => {
  const w = await world();
  const ok = await emailChannel.loadAttachments([{ kind: "cv", cvFileId: w.cvFileId, version: 1, sha256: w.cvSha, storageKey: w.cvKey }], { candidateName: "Zoë O'Neil/../x" });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.attachments[0].sha256, w.cvSha);
  assert.equal(ok.attachments[0].filename, "CV-Zoe-O-Neil-x-v1.pdf");
  const bad = await emailChannel.loadAttachments([{ kind: "cv", cvFileId: 1, version: 1, sha256: "0".repeat(64), storageKey: w.cvKey }, { kind: "document", documentId: 2, sha256: "x", storageKey: "../etc/passwd" }]);
  assert.deepEqual(bad.problems, ["attachment_hash_mismatch:cv1", "attachment_unavailable:doc2"]);
  // error classification: definite vs unknown
  const E = (props) => Object.assign(new Error("x"), props);
  for (const c of [550, 551, 552, 553, 554]) assert.equal(emailChannel.classifyError(E({ code: "EENVELOPE", responseCode: c })), "refused", String(c));
  assert.equal(emailChannel.classifyError(E({ response: "550 5.1.1 User unknown" })), "refused");
  assert.equal(emailChannel.classifyError(E({ code: "EAUTH", responseCode: 535 })), "config");
  assert.equal(emailChannel.classifyError(E({ response: "535 Authentication failed" })), "config");
  assert.equal(emailChannel.classifyError(E({ code: "REQUIRES_SETUP" })), "config");
  for (const props of [{ code: "ETIMEDOUT" }, { code: "ECONNRESET" }, { responseCode: 421 }, { responseCode: 451 }, { statusCode: 422 }, { statusCode: 503 }, {}]) {
    assert.equal(emailChannel.classifyError(E(props)), "unknown", JSON.stringify(props));
  }
  // unexpected storage keys never throw
  const odd = await emailChannel.loadAttachments([{ kind: "cv", cvFileId: 9, sha256: "a", storageKey: "1-abc.exe" }, { kind: "cv", cvFileId: 8, sha256: "a", storageKey: 42 }]);
  assert.deepEqual(odd.problems, ["attachment_unavailable:cv9", "attachment_unavailable:cv8"]);
  assert.equal(emailChannel.redact("auth failed password=hunter2 token: abc"), "auth failed password=[redacted] token=[redacted]");
});

// ---------------------------------------------------------------- evidence

async function sentWorld() {
  const w = await world();
  const r = await queued(w);
  assert.equal((await submitter.handleSubmit(r.job, DEPS)).status, "sent");
  w.sub = (await subsOf(w.appId))[0];
  return w;
}

const GRANT = submitter._internal.EVIDENCE_GRANT;

test("recordEvidence: staff delivery_receipt -> 400; system receipt needs the grant, exact provider id (not our planned id), action 'delivered', reportRef", async () => {
  const w = await sentWorld();
  const staff = (kind, detail) => submitter.recordEvidence({ submissionId: w.sub.id, kind, detail, actor: w.manager });
  const sys = (detail, grant = true) => submitter.recordEvidence({ submissionId: w.sub.id, kind: "delivery_receipt", detail, actor: "system:dsn", [GRANT]: grant });
  await assert.rejects(staff("delivery_receipt", { providerMessageId: w.sub.provider_message_id, action: "delivered", reportRef: "r" }), (e) => e.status === 400);
  await assert.rejects(staff("manual_confirmation", {}), (e) => e.status === 400);
  await assert.rejects(staff("manual_confirmation", undefined), (e) => e.status === 400);
  await assert.rejects(staff("bogus", { a: 1 }), (e) => e.status === 400);
  const ok = { providerMessageId: w.sub.provider_message_id, action: "delivered", reportRef: "dsn-1" };
  await assert.rejects(sys(ok, false), (e) => e.status === 403, "no grant -> 403");
  await assert.rejects(sys({ ...ok, providerMessageId: "<other@x>" }), (e) => e.status === 409);
  await assert.rejects(sys({ ...ok, providerMessageId: w.sub.evidence.messageIdPlanned }), (e) => e.status === 409, "our planned Message-ID is not provider evidence");
  await assert.rejects(sys({ providerMessageId: ok.providerMessageId, reportRef: "x" }), (e) => e.status === 400, "action missing");
  await assert.rejects(sys({ providerMessageId: ok.providerMessageId, action: "delivered" }), (e) => e.status === 400, "reportRef missing");
  await assert.rejects(sys({ ...ok, action: "failed" }), (e) => e.status === 409);
  await assert.rejects(sys({ ...ok, action: "relayed" }), (e) => e.status === 409);
  assert.equal(await status(w.appId), "sent", "still sent without evidence");
  const out = await sys(ok);
  assert.equal(out.status, "confirmed_submitted");
  assert.equal(await status(w.appId), "confirmed_submitted");
  const sub = (await subsOf(w.appId))[0];
  assert.equal(sub.status, "confirmed_submitted");
  assert.ok(sub.confirmed_at);
  assert.equal(sub.evidence.confirmations.length, 1);
  assert.equal(sub.evidence.confirmations[0].kind, "delivery_receipt");
  assert.equal(sub.evidence.confirmations[0].actor, "system:dsn");
  assert.equal(sub.evidence.phase, "sent", "the send record is kept");
  assert.ok((await timelineOf(w.appId)).some((e) => e.event === "submission_confirmed" && e.detail.to === "confirmed_submitted"));
});

test("recordEvidence employer_acknowledgement: message from another domain -> 409; from the employer domain and linked -> confirmed", async () => {
  const w = await sentWorld();
  const other = (await q("INSERT INTO js_messages (direction, application_id, from_addr, subject) VALUES ('in',$1,'hr@evil-northwind.example','Re: app') RETURNING id", [w.appId])).rows[0].id;
  const unlinked = (await q("INSERT INTO js_messages (direction, from_addr, subject) VALUES ('in',$1,'Re: app') RETURNING id", [`hr@${w.domain}`])).rows[0].id;
  const good = (await q("INSERT INTO js_messages (direction, application_id, from_addr, subject) VALUES ('in',$1,$2,'Re: app') RETURNING id", [w.appId, `"HR Team" <HR@${w.domain}>`])).rows[0].id;
  const call = (messageId) => submitter.recordEvidence({ submissionId: w.sub.id, kind: "employer_acknowledgement", detail: { messageId }, actor: w.manager });
  await assert.rejects(call(other), (e) => e.status === 409);
  await assert.rejects(call(unlinked), (e) => e.status === 409);
  // a message of ANOTHER application from the right domain is refused too
  const w2 = await sentWorld();
  const foreign = (await q("INSERT INTO js_messages (direction, application_id, from_addr, subject) VALUES ('in',$1,$2,'Re') RETURNING id", [w2.appId, `hr@${w.domain}`])).rows[0].id;
  await assert.rejects(call(foreign), (e) => e.status === 409);
  const out = await call(good);
  assert.equal(out.applicationStatus, "confirmed_submitted");
  // a system actor (even with the grant) can never use manual_confirmation; without the grant nothing
  await assert.rejects(submitter.recordEvidence({ submissionId: w.sub.id, kind: "manual_confirmation", detail: { note: "long enough note" }, actor: "system:inbound", [GRANT]: true }), (e) => e.status === 403);
  await assert.rejects(submitter.recordEvidence({ submissionId: w.sub.id, kind: "employer_acknowledgement", detail: { messageId: good }, actor: "system:inbound" }), (e) => e.status === 403);
});

test("recordEvidence on an outcome_unknown submission (needs_staff) with manual confirmation -> confirmed; queued/failed submissions cannot be confirmed", async () => {
  const w = await world();
  const r = await queued(w);
  await assert.rejects(submitter.recordEvidence({ submissionId: r.submissionId, kind: "manual_confirmation", detail: { note: "called" }, actor: w.manager }), (e) => e.status === 409);
  await submitter.handleSubmit(r.job, { ...DEPS, mailSend: async () => { throw new Error("timeout"); } });
  assert.equal(await status(w.appId), "needs_staff");
  await assert.rejects(submitter.recordEvidence({ submissionId: r.submissionId, kind: "manual_confirmation", detail: { note: "  " }, actor: w.manager }), (e) => e.status === 400);
  await assert.rejects(submitter.recordEvidence({ submissionId: r.submissionId, kind: "manual_confirmation", detail: { note: "called hr" }, actor: w.manager }), (e) => e.status === 400, "< 10 chars");
  await assert.rejects(submitter.recordEvidence({ submissionId: r.submissionId, kind: "manual_confirmation", detail: { note: "long enough note", fileRef: { storageKey: "../../x" } }, actor: w.manager }), (e) => e.status === 400);
  const out = await submitter.recordEvidence({ submissionId: r.submissionId, kind: "manual_confirmation", detail: { note: "Employer HR confirmed by phone they received the CV", fileRef: { storageKey: w.cvKey } }, actor: w.manager });
  assert.equal(out.applicationStatus, "confirmed_submitted");
  assert.equal((await tasksOf(w.appId)).find((t) => t.reason === "verify_delivery").status, "resolved");
});

test("manual completion: needs_staff -> sent only with evidence + approver; transition() refuses it otherwise", async () => {
  const w = await world();
  const r = await queued(w);
  await q("UPDATE js_jobs SET description_text=$2 WHERE id=$1", [w.jobId, `Apply online: complete the CAPTCHA before submitting. jobs@${w.domain}`]);
  await submitter.handleSubmit(r.job, DEPS);
  assert.equal(await status(w.appId), "needs_staff");
  await assert.rejects(applicationService.transition(w.appId, "sent", w.manager), (e) => e.status === 409);
  await assert.rejects(applicationService.transition(w.appId, "confirmed_submitted", w.manager), (e) => e.status === 409);
  await assert.rejects(submitter.recordManualCompletion({ applicationId: w.appId, actor: w.manager, detail: {} }), (e) => e.status === 400);
  const agent = { id: await mkUser("Agent"), role: "Agent" };
  await q("UPDATE candidates SET assigned_to=$2 WHERE id=$1", [w.candidateId, agent.id]);
  await assert.rejects(submitter.recordManualCompletion({ applicationId: w.appId, actor: agent, detail: { note: "done" } }), (e) => e.status === 403);
  await q("UPDATE candidates SET assigned_to=$2 WHERE id=$1", [w.candidateId, w.managerId]);
  const out = await submitter.recordManualCompletion({ applicationId: w.appId, actor: w.manager, detail: { note: "Completed the employer portal form with the candidate on a call", channel: "portal" } });
  assert.equal(out.applicationStatus, "sent");
  const subs = await subsOf(w.appId);
  const manual = subs.find((s) => s.id === out.submissionId);
  assert.equal(manual.status, "sent");
  assert.equal(manual.evidence.manualCompletion.recordedBy, `staff:${w.managerId}`);
  assert.ok((await timelineOf(w.appId)).some((e) => e.event === "manual_completion" && e.actor === `staff:${w.managerId}`));
  assert.equal(await status(w.appId), "sent");
  assert.equal((await outbound(w.recipient)).length, 0, "manual completion sends nothing");
});

// ---------------------------------------------------------------- HTTP

test("HTTP: queue (Manager 200 / Agent 403 / other staff 404 / refusal 409), evidence (Candidate 403, staff B 404), candidate view redacted, queue/run admin only", async () => {
  const w = await world();
  const mgrTok = token(w.managerId, "Manager");
  const otherMgr = await mkUser("Manager");
  const agent = await mkUser("Agent");
  // Agent assigned to another candidate sees nothing; an assigned Agent lacks jobsearch:approve
  assert.equal((await http("POST", `/jobsearch/applications/${w.appId}/queue`, token(otherMgr, "Manager"))).status, 404);
  const wa = await world();
  await q("UPDATE candidates SET assigned_to=$2 WHERE id=$1", [wa.candidateId, agent]);
  assert.equal((await http("POST", `/jobsearch/applications/${wa.appId}/queue`, token(agent, "Agent"))).status, 403);
  const candTok = await candidateToken(w.userId);
  assert.equal((await http("POST", `/jobsearch/applications/${w.appId}/queue`, candTok)).status, 403);

  const ok = await http("POST", `/jobsearch/applications/${w.appId}/queue`, mgrTok);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.queued, true);
  assert.equal(ok.body.recipient, w.recipient);

  // admin runs the queue (default re-check: the job's source is unknown -> stored status kept, noted)
  const adminTok = token(adminId, "Admin");
  assert.equal((await http("POST", "/jobsearch/queue/run", mgrTok, {})).status, 403);
  assert.equal((await http("POST", "/jobsearch/queue/run", adminTok, { kinds: ["nope"] })).status, 400);
  const run = await http("POST", "/jobsearch/queue/run", adminTok, { kinds: ["submit"], max: 50 });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.ok(run.body.processed >= 1);
  assert.equal(await status(w.appId), "sent");
  assert.equal((await outbound(w.recipient)).length, 1);
  assert.ok((await timelineOf(w.appId)).some((e) => e.event === "guard_note" && e.detail.note === "job_status_unverified"));

  // refusal -> 409 with the guard code
  const w2 = await world();
  await q("UPDATE js_jobs SET status='closed' WHERE id=$1", [w2.jobId]);
  const refused = await http("POST", `/jobsearch/applications/${w2.appId}/queue`, token(w2.managerId, "Manager"));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "job_closed");

  // candidate view: status + timestamps + wording, never provider internals
  const sub = (await subsOf(w.appId))[0];
  const cv = await http("GET", `/jobsearch/submissions?applicationId=${w.appId}`, candTok);
  assert.equal(cv.status, 200);
  assert.equal(cv.body.submissions.length, 1);
  const s = cv.body.submissions[0];
  assert.equal(s.status, "sent");
  assert.equal(s.awaitingConfirmation, true);
  assert.match(s.message, /awaiting confirmation/i);
  const raw = JSON.stringify(cv.body);
  for (const secret of [sub.provider_message_id, sub.recipient, sub.evidence.replyToken, "providerResponse", "evidence", "sha256"]) assert.equal(raw.includes(secret), false, secret);
  const staffView = await http("GET", `/jobsearch/submissions?applicationId=${w.appId}`, mgrTok);
  assert.equal(staffView.body.submissions[0].providerMessageId, sub.provider_message_id);
  assert.equal(staffView.body.submissions[0].evidence.replyToken, undefined);
  assert.equal((await http("GET", `/jobsearch/submissions?applicationId=${w.appId}`, token(otherMgr, "Manager"))).status, 404);
  assert.equal((await http("GET", "/jobsearch/submissions", mgrTok)).status, 400);

  // evidence over HTTP
  const ev = { kind: "manual_confirmation", detail: { note: "Employer HR confirmed receipt by phone on 23 Oct" } };
  const receipt = await http("POST", `/jobsearch/submissions/${sub.id}/evidence`, mgrTok, { kind: "delivery_receipt", detail: { providerMessageId: sub.provider_message_id, action: "delivered", reportRef: "x" } });
  assert.equal(receipt.status, 400);
  assert.match(receipt.body.error, /manual_confirmation or wait for the provider receipt/);
  assert.equal((await http("POST", `/jobsearch/submissions/${sub.id}/evidence`, candTok, ev)).status, 403);
  assert.equal((await http("POST", `/jobsearch/submissions/${sub.id}/evidence`, token(otherMgr, "Manager"), ev)).status, 404);
  assert.equal((await http("POST", `/jobsearch/submissions/${sub.id}/evidence`, mgrTok, { kind: "manual_confirmation" })).status, 400);
  assert.equal((await http("POST", `/jobsearch/submissions/${sub.id}/evidence`, mgrTok, { kind: "manual_confirmation", detail: { note: "short" } })).status, 400);
  const good = await http("POST", `/jobsearch/submissions/${sub.id}/evidence`, mgrTok, ev);
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(good.body.applicationStatus, "confirmed_submitted");
  const after = await http("GET", `/jobsearch/submissions?applicationId=${w.appId}`, candTok);
  assert.equal(after.body.submissions[0].message, "Submission confirmed");
  assert.ok((await q("SELECT 1 FROM audit_logs WHERE action='jobsearch.submission.evidence' AND user_id=$1", [w.managerId])).rowCount);
});

// ---------------------------------------------------------------- fix round 1

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test("candidate GET /jobsearch/applications/:id after sent / failed / outcome_unknown shows no recipient, message ids, provider text or sha256s", async () => {
  const leaks = [];
  // sent
  const a = await sentWorld();
  leaks.push([a, [a.sub.provider_message_id, a.sub.evidence.messageIdPlanned, a.sub.evidence.replyToken, a.recipient, a.domain, a.cvSha]]);
  // failed (sandbox refusal text)
  const b = await world({ domain: "acme-real.org" });
  const rb = await queued(b);
  await submitter.handleSubmit(rb.job, DEPS);
  const sb = (await subsOf(b.appId))[0];
  leaks.push([b, [b.recipient, "acme-real.org", "ALLOWLIST", sb.evidence.messageIdPlanned, b.cvSha]]);
  // outcome_unknown (provider error text)
  const c = await world();
  const rc = await queued(c);
  await submitter.handleSubmit(rc.job, { ...DEPS, mailSend: async () => { throw Object.assign(new Error("Greeting never received from smtp.internal.example"), { code: "ETIMEDOUT" }); } });
  const sc = (await subsOf(c.appId))[0];
  leaks.push([c, [c.recipient, "smtp.internal.example", "ETIMEDOUT", sc.evidence.messageIdPlanned, c.cvSha]]);
  for (const [w, secrets] of leaks) {
    const res = await http("GET", `/jobsearch/applications/${w.appId}`, await candidateToken(w.userId));
    assert.equal(res.status, 200);
    const tl = JSON.stringify(res.body.timeline);
    for (const x of secrets) assert.equal(tl.includes(x), false, `${x} leaked in ${tl}`);
    assert.ok(res.body.timeline.some((e) => e.detail.to), "status changes remain visible");
    // staff still see full timeline details (unchanged)
    const staff = await http("GET", `/jobsearch/applications/${w.appId}`, token(w.managerId, "Manager"));
    assert.ok(staff.body.timeline.some((e) => e.detail.submissionId));
  }
});

test("consent withdrawn WHILE the provider call runs -> the mail went: submission 'sent' + review task, application stays 'cancelled'", async () => {
  const w = await world();
  const r = await queued(w);
  const gate = deferred();
  const entered = deferred();
  const mailSend = async (m) => {
    entered.resolve();
    await gate.promise;
    return mail.send(m);
  };
  const run = submitter.handleSubmit(r.job, { ...DEPS, mailSend });
  await entered.promise;
  await consentService.withdrawConsent({ user: { id: w.userId, role: "Candidate" }, candidateId: w.candidateId, scopeKey: "submit" });
  assert.equal(await status(w.appId), "cancelled");
  gate.resolve();
  const out = await run;
  assert.equal(out.status, "sent");
  assert.equal((await subsOf(w.appId))[0].status, "sent");
  assert.equal(await status(w.appId), "cancelled");
  assert.equal((await tasksOf(w.appId)).find((t) => t.reason === "review").status, "open");
  assert.equal((await outbound(w.recipient)).length, 1);
});

test("slow provider + a second concurrent handleSubmit -> second returns in_progress; final state 'sent' (not outcome_unknown)", async () => {
  const w = await world();
  const r = await queued(w);
  const gate = deferred();
  const entered = deferred();
  const run = submitter.handleSubmit(r.job, { ...DEPS, mailSend: async (m) => { entered.resolve(); await gate.promise; return mail.send(m); } });
  await entered.promise;
  const second = await submitter.handleSubmit(r.job, DEPS);
  assert.equal(second.status, "in_progress");
  assert.equal((await workers.tick({ kinds: ["submit"] })).interrupted, 0, "the sweep leaves a live send alone");
  gate.resolve();
  assert.equal((await run).status, "sent");
  assert.equal((await subsOf(w.appId))[0].status, "sent");
  assert.equal((await outbound(w.recipient)).length, 1);
});

test("unexpected error in the first transaction: non-retryable -> attempt failed internal_error, needs_staff + task; retryable is rethrown until the last attempt", async () => {
  const orig = emailChannel.loadAttachments;
  try {
    const w = await world();
    const r = await queued(w);
    emailChannel.loadAttachments = async () => { throw new TypeError("Cannot read properties of undefined"); };
    const out = await submitter.handleSubmit(r.job, DEPS);
    assert.equal(out.code, "internal_error");
    const [s1] = await subsOf(w.appId);
    assert.equal(s1.status, "failed");
    assert.equal(s1.evidence.reason, "internal_error");
    assert.equal(await status(w.appId), "needs_staff");
    assert.equal((await tasksOf(w.appId))[0].reason, "internal_error");

    const w2 = await world();
    const r2 = await queued(w2);
    emailChannel.loadAttachments = async () => { throw Object.assign(new Error("could not serialize access"), { code: "40001" }); };
    await assert.rejects(submitter.handleSubmit({ ...r2.job, attempts: 1, max_attempts: 5 }, DEPS), /serialize/);
    assert.equal((await subsOf(w2.appId))[0].status, "queued");
    assert.equal(await status(w2.appId), "queued");
    const last = await submitter.handleSubmit({ ...r2.job, attempts: 5, max_attempts: 5 }, DEPS);
    assert.equal(last.code, "internal_error");
    assert.equal(await status(w2.appId), "needs_staff");
    assert.equal((await outbound(w.recipient)).length + (await outbound(w2.recipient)).length, 0);
  } finally {
    emailChannel.loadAttachments = orig;
  }
});

for (const [label, err, subStatus, taskReason, appStatus] of [
  ["SMTP 550 user unknown", { code: "EENVELOPE", responseCode: 550, response: "550 5.1.1 User unknown" }, "failed", "delivery_failed", "failed"],
  ["SMTP 554 policy", { response: "554 5.7.1 Rejected by policy" }, "failed", "delivery_failed", "failed"],
  ["EAUTH 535", { code: "EAUTH", responseCode: 535, response: "535 Authentication failed" }, "failed", "mail_config", "failed"],
  ["SMTP 421 transient", { responseCode: 421, response: "421 Try again later" }, "outcome_unknown", "verify_delivery", "needs_staff"],
  ["ECONNRESET", { code: "ECONNRESET" }, "outcome_unknown", "verify_delivery", "needs_staff"],
]) {
  test(`provider error ${label} -> submission ${subStatus}, task ${taskReason}`, async () => {
    const w = await world();
    const r = await queued(w);
    await submitter.handleSubmit(r.job, { ...DEPS, mailSend: async () => { throw Object.assign(new Error(label), err); } });
    assert.equal((await subsOf(w.appId))[0].status, subStatus);
    assert.equal((await tasksOf(w.appId))[0].reason, taskReason);
    assert.equal(await status(w.appId), appStatus);
  });
}

test("workers: handlers map submit/search; startWorkers is disabled under NODE_ENV=test", () => {
  assert.equal(typeof workers.handlers.submit, "function");
  assert.equal(typeof workers.handlers.search, "function");
  assert.equal(workers.startWorkers(), null);
  assert.equal(workers.enabled(), false);
});
