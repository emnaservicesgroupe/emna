// Submission of approved applications (spec §7). The ONLY code that sends applications.
//
//   queueSubmission(applicationId, actor, opts?)      approved -> queued + js_submissions 'queued' + js_queue 'submit'
//   handleSubmit(job, deps?)                           queue handler: pre-send guard, intent, provider call, result
//   recordEvidence({submissionId, kind, detail, actor}) the ONLY path to confirmed_submitted
//   recordManualCompletion({applicationId, actor, detail}) needs_staff -> sent (staff finished it by hand)
//   listSubmissions({user, applicationId})             scoped; redacted for Candidate
//   sweepStuckSending()                                 interrupted sends -> outcome_unknown (never re-sent)
//
// Safety model (correctness beats everything):
//  - At most ONE provider call per js_submissions row, ever. Before calling the provider the intent is
//    committed (evidence.phase = 'sending'); a row found in that phase again is never re-sent: it
//    becomes outcome_unknown + a 'verify_delivery' staff task.
//  - "In progress" vs "crashed" is decided by a session-level advisory lock on the submission id held
//    by the sending connection for the whole send (released automatically when a process dies). A
//    concurrent handler that cannot take the lock does nothing; one that takes it and finds phase
//    'sending' knows the previous sender is gone.
//  - The provider is called outside any DB transaction. Every state change happens inside a
//    transaction that first locks the candidate row, then the application row (binding lock order),
//    so withdrawal/suspension serialise with queueing and with the pre-send re-check.
//  - The pre-send guard (guard.check) runs again in the same transaction that records the intent.
//  - Statuses are honest: 'sent' means the provider accepted it; 'confirmed_submitted' needs stored
//    evidence; anything uncertain is 'outcome_unknown' and is never retried automatically.
const crypto = require("crypto");
const { HttpError } = require("./httpError");
const applicationService = require("./applicationService");
const consentService = require("./consentService");
const guard = require("./guard");
const queue = require("./queue");
const emailChannel = require("./channels/email");
const unsupported = require("./channels/unsupported");
const { candidateScopeSql } = require("./scope");
const { PERMISSIONS } = require("../../middleware/role");
const { logAudit } = require("../../utils/audit");

const db = () => require("../../db");
const { SYSTEM_GRANT, MANUAL_COMPLETION } = applicationService._internal;
const { TRANSITIONS } = applicationService;

const SYSTEM_ACTOR = "system:submitter";
const LOCK_CLASS = 0x4a53; // advisory-lock namespace ("JS") for submission ids
const MAX_TEXT = 1000;

// Guard code -> what happens to the application at send time.
const CANCEL_CODES = new Set(["consent_missing", "consent_withdrawn", "candidate_paused", "module_paused", "source_paused", "user_suspended", "candidate_deleted"]);
const DUP_CODES = new Set(["duplicate", "duplicate_submission"]);
const HANDOFF_REASONS = new Set(guard.HANDOFF_REASONS);
// Refusals at queue time that leave a note on the application timeline.
const NOTE_CODES = new Set([...CANCEL_CODES, "job_closed", ...DUP_CODES]);
const EVIDENCE_KINDS = ["delivery_receipt", "employer_acknowledgement", "manual_confirmation"];
const DELIVERED_ACTIONS = new Set(["delivered", "relayed", "expanded"]);
const STORAGE_KEY_RE = /^[0-9]+-[a-f0-9]{64}\.(pdf|docx|png|jpg)$/;

// ---------------------------------------------------------------- helpers

const posInt = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);
const isUser = (a) => Boolean(a && typeof a === "object" && Number.isSafeInteger(a.id));

function hasPerm(user, perm) {
  const perms = (user && PERMISSIONS[user.role]) || [];
  return perms.includes("*") || perms.includes(perm);
}

function actorLabel(actor) {
  if (isUser(actor)) return actor.role === "Candidate" ? `candidate:${actor.id}` : `staff:${actor.id}`;
  return typeof actor === "string" && actor ? actor : SYSTEM_ACTOR;
}

function cleanText(v, max = MAX_TEXT) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const headerSafe = (v, max = 200) => String(v || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

async function inTx(fn, conn) {
  const client = conn || (await db().connect());
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (!conn) client.release();
  }
}

async function timeline(client, applicationId, actor, ev, detail) {
  await client.query("INSERT INTO js_timeline (application_id, actor, event, detail) VALUES ($1,$2,$3,$4::jsonb)", [applicationId, actorLabel(actor), ev, JSON.stringify(detail || {})]);
}

async function audit(client, actor, action, candidateId, applicationId, detail) {
  await client.query("INSERT INTO js_audit_events (actor, action, candidate_id, application_id, detail) VALUES ($1,$2,$3,$4,$5::jsonb)", [
    isUser(actor) ? `user:${actor.id}` : actorLabel(actor),
    action,
    candidateId,
    applicationId,
    JSON.stringify(detail || {}),
  ]);
}

async function event(client, candidateId, kind, payload) {
  await client.query("INSERT INTO js_events (candidate_id, kind, payload) VALUES ($1,$2,$3::jsonb)", [candidateId, kind, JSON.stringify(payload || {})]);
}

/** audit_logs row (user_id null for system actors). Never throws into the caller's result path. */
async function auditLog(actor, action, recordId, newData) {
  try {
    await logAudit({ userId: isUser(actor) ? actor.id : null, action, tableName: "js_submissions", recordId: recordId === null || recordId === undefined ? null : String(recordId), newData });
  } catch (err) {
    console.error("jobsearch submitter: audit_logs write failed:", err && err.code, err && err.message);
  }
}

/** Candidate lock first, then the application row (binding order). */
async function lockApplication(client, applicationId) {
  const pre = (await client.query("SELECT candidate_id FROM js_applications WHERE id = $1", [applicationId])).rows[0];
  if (!pre) return null;
  const cand = (await client.query("SELECT id, assigned_to, is_deleted FROM candidates WHERE id = $1 FOR UPDATE", [pre.candidate_id])).rows[0];
  const app = (await client.query("SELECT * FROM js_applications WHERE id = $1 FOR UPDATE", [applicationId])).rows[0];
  if (!app || app.candidate_id !== pre.candidate_id) throw new HttpError(409, "Application changed concurrently");
  return { app, cand };
}

const responsibleOf = (app, cand) => app.responsible_user_id || (cand && cand.assigned_to) || null;

/** Moves the application if the state machine allows it from its current status; returns the new status or null. */
async function moveIfAllowed(client, app, to, actor, opts) {
  if (app.status === to || !(TRANSITIONS[app.status] || []).includes(to)) return null;
  const row = await applicationService.transition(app.id, to, actor, { client, ...opts });
  app.status = row.status;
  return row.status;
}

// ---------------------------------------------------------------- reply token (Task 13 matching)

function tokenSecret() {
  const s = process.env.JOBSEARCH_REPLY_SECRET || process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "test") return "test-only-reply-secret";
  throw new Error("JOBSEARCH_REPLY_SECRET (or JWT_SECRET) must be set to send applications");
}

/** Opaque token put in the subject / Reply-To / X-VITA-Ref; stored in js_submissions.evidence.replyToken. */
function replyToken(applicationId, submissionId) {
  const mac = crypto.createHmac("sha256", tokenSecret()).update(`vita-reply:${applicationId}:${submissionId}`).digest("hex").slice(0, 20);
  return `VITA-${mac}`;
}

/** The submission a reply token belongs to (or null). */
async function findByReplyToken(token, client) {
  if (typeof token !== "string" || !/^VITA-[a-f0-9]{20}$/.test(token)) return null;
  const r = await (client || db()).query("SELECT * FROM js_submissions WHERE evidence->>'replyToken' = $1 ORDER BY id DESC LIMIT 1", [token]);
  const row = r.rows[0];
  if (!row || replyToken(row.application_id, row.id) !== token) return null;
  return row;
}

function fromAddress() {
  return guard.normalizeEmail(process.env.MAIL_FROM || "") || "vita@test.invalid";
}

function replyToAddress(token) {
  const base = guard.normalizeEmail(process.env.MAIL_REPLY_TO || "") || fromAddress();
  const [local, domain] = base.split("@");
  return `${local}+${token.toLowerCase()}@${domain}`;
}

function messageIdFor(applicationId, submissionId) {
  const domain = fromAddress().split("@")[1];
  return `<vita-${applicationId}-${submissionId}-${crypto.randomBytes(8).toString("hex")}@${domain}>`;
}

const SUBJECT = {
  en: (t, n) => `Application: ${t} - ${n}`,
  fr: (t, n) => `Candidature : ${t} - ${n}`,
  ar: (t, n) => `طلب توظيف: ${t} - ${n}`,
};
const REF_LINE = { en: "Reference", fr: "Référence", ar: "المرجع" };

function buildEmail({ app, job, candidateName, token, messageId, attachments }) {
  const lang = ["en", "fr", "ar"].includes(app.cover_letter_lang) ? app.cover_letter_lang : "en";
  const subject = `${headerSafe(SUBJECT[lang](headerSafe(job.title, 120) || "Position", headerSafe(candidateName, 80) || "Candidate"), 220)} [${token}]`;
  const text = `${String(app.cover_letter_text || "").trim()}\n\n--\n${REF_LINE[lang]}: ${token}\n`;
  const headers = { "Message-ID": messageId, "Reply-To": replyToAddress(token), "X-VITA-Ref": token };
  return { subject, text, headers, attachments };
}

// ---------------------------------------------------------------- queueSubmission

/**
 * One transaction: candidate lock -> guard.check({client}) -> on ok insert the js_submissions 'queued'
 * row, persist guard notes + the resolved recipient on the timeline, approved -> queued, enqueue
 * 'submit'. Idempotent: a second call returns the existing queued submission.
 * @param {number} applicationId
 * @param {object|string} [actor] a user ({id, role}) with jobsearch:approve, or omitted for the system (SYSTEM_GRANT)
 * @param {{recheck?: Function, now?: Date}} [opts] guard options (tests inject the job re-check)
 * @returns {Promise<{queued: true, submissionId, queueId, attempt, recipient, existing?: true} | {queued: false, reason, detail, handoff?}>}
 */
async function queueSubmission(applicationId, actor, opts = {}) {
  const id = posInt(applicationId);
  if (!id) throw new HttpError(404, "Not found");
  if (isUser(actor) && !hasPerm(actor, "jobsearch:approve")) throw new HttpError(403, "Queueing a submission requires a manager or administrator");
  const who = isUser(actor) ? actor : SYSTEM_ACTOR;
  const out = await inTx(async (client) => {
    const locked = await lockApplication(client, id);
    if (!locked) throw new HttpError(404, "Not found");
    const { app } = locked;
    const open = (await client.query("SELECT * FROM js_submissions WHERE application_id = $1 AND status = 'queued' ORDER BY id DESC", [id])).rows;
    if (open.length && app.status === "queued") {
      const qi = (await client.query("SELECT id FROM js_queue WHERE kind = 'submit' AND payload->>'submissionId' = $1 ORDER BY id DESC LIMIT 1", [String(open[0].id)])).rows[0];
      return { queued: true, existing: true, submissionId: open[0].id, queueId: qi ? Number(qi.id) : null, attempt: open[0].attempt_no, recipient: open[0].recipient };
    }
    const result = await guard.check(id, { client, recheck: opts.recheck, now: opts.now });
    if (!result.ok) {
      const detail = { code: result.code, detail: result.detail, handoff: result.handoff || null, notes: result.notes || [] };
      if (NOTE_CODES.has(result.code) || result.handoff) await timeline(client, id, who, "queue_refused", detail);
      await audit(client, who, "submission.queue_refused", app.candidate_id, id, detail);
      return { queued: false, reason: result.code, detail: result.detail, ...(result.handoff ? { handoff: result.handoff } : {}), candidateId: app.candidate_id };
    }
    // A leftover 'queued' row of an earlier, interrupted cycle (e.g. queued -> preparing -> approved).
    for (const s of open) {
      if (s.evidence && s.evidence.phase === "sending") {
        const detail = { code: "duplicate_submission", detail: `Submission ${s.id} was interrupted while sending; its outcome is unknown`, handoff: "staff_review" };
        await timeline(client, id, who, "queue_refused", detail);
        return { queued: false, reason: "duplicate_submission", detail: detail.detail, handoff: "staff_review", candidateId: app.candidate_id };
      }
      await client.query("UPDATE js_submissions SET status = 'failed', evidence = COALESCE(evidence, '{}'::jsonb) || $2::jsonb WHERE id = $1", [s.id, JSON.stringify({ phase: "superseded", reason: "superseded_by_new_attempt" })]);
      await client.query("UPDATE js_queue SET status = 'cancelled', last_error = 'superseded' WHERE kind = 'submit' AND status = 'pending' AND payload->>'submissionId' = $1", [String(s.id)]);
    }
    const attempt = Number((await client.query("SELECT COALESCE(max(attempt_no), 0) AS n FROM js_submissions WHERE application_id = $1", [id])).rows[0].n) + 1;
    const sub = (await client.query(
      `INSERT INTO js_submissions (application_id, attempt_no, idempotency_key, channel, recipient, status)
       VALUES ($1,$2,$3,'email',$4,'queued') RETURNING *`,
      [id, attempt, `app:${id}:a${attempt}`, result.recipient]
    )).rows[0];
    for (const note of result.notes || []) await timeline(client, id, who, "guard_note", { note, submissionId: sub.id });
    const recipientInfo = { submissionId: sub.id, recipient: result.recipient, recipientSource: result.recipientSource, domainMatchesEmployer: result.domainMatchesEmployer, approval: result.approval };
    await timeline(client, id, who, "recipient_resolved", recipientInfo);
    if (app.status !== "queued") {
      await applicationService.transition(id, "queued", who, { client, reason: "queued_for_submission", detail: recipientInfo, expectFrom: ["approved"], ...(isUser(who) ? {} : { [SYSTEM_GRANT]: true }) });
    }
    const item = await queue.enqueue({ kind: "submit", payload: { applicationId: id, candidateId: app.candidate_id, submissionId: sub.id }, idempotencyKey: `submit:${id}:${attempt}`, client });
    await audit(client, who, "submission.queued", app.candidate_id, id, { submissionId: sub.id, attempt, recipient: result.recipient, queueId: Number(item.id) });
    await event(client, app.candidate_id, "submission.queued", { applicationId: id, submissionId: sub.id });
    return { queued: true, submissionId: sub.id, queueId: Number(item.id), attempt, recipient: result.recipient, recipientSource: result.recipientSource };
  });
  await auditLog(who, out.queued ? (out.existing ? "jobsearch.submission.queue_repeat" : "jobsearch.submission.queue") : "jobsearch.submission.queue_refused", out.submissionId || null, { applicationId: id, ...(out.queued ? { attempt: out.attempt } : { reason: out.reason }) });
  delete out.candidateId;
  return out;
}

// ---------------------------------------------------------------- handleSubmit

async function openTask(client, app, cand, reason, detail) {
  return unsupported.createHandoffTask(client, { applicationId: app.id, reason, detail, assignedTo: responsibleOf(app, cand) });
}

/** Pre-send guard refused: mark the attempt failed, move the application, open a task where a human is needed. Never sends. */
async function blockSubmission(client, { app, cand, sub }, g) {
  const code = g.code;
  const cancelledAlready = code === "application_not_sendable" && app.status === "cancelled";
  const reason = cancelledAlready ? "cancelled" : `guard:${code}`;
  await client.query("UPDATE js_submissions SET status = 'failed', evidence = COALESCE(evidence, '{}'::jsonb) || $2::jsonb WHERE id = $1", [
    sub.id,
    JSON.stringify({ phase: "blocked", blockedAt: new Date().toISOString(), reason, guard: { code, detail: g.detail || null, handoff: g.handoff || null } }),
  ]);
  for (const note of g.notes || []) await timeline(client, app.id, SYSTEM_ACTOR, "guard_note", { note, submissionId: sub.id });
  const tdetail = { submissionId: sub.id, code, detail: g.detail || null, handoff: g.handoff || null };
  let task = null;
  let moved = null;
  if (CANCEL_CODES.has(code)) moved = await moveIfAllowed(client, app, "cancelled", SYSTEM_ACTOR, { reason, detail: tdetail, event: "cancelled" });
  else if (code === "job_closed") moved = await moveIfAllowed(client, app, "closed", SYSTEM_ACTOR, { reason, detail: tdetail });
  else if (code === "application_not_sendable") moved = null; // already moved elsewhere (cancelled, re-preparation...)
  else if (DUP_CODES.has(code)) task = await openTask(client, app, cand, "duplicate", `${code}: ${g.detail || ""}`);
  else {
    const taskReason = HANDOFF_REASONS.has(g.handoff) ? g.handoff : "staff_review";
    task = await openTask(client, app, cand, taskReason, `${code}: ${g.detail || ""}`);
    moved = await moveIfAllowed(client, app, "needs_staff", SYSTEM_ACTOR, { reason, detail: { ...tdetail, taskId: task.id } });
  }
  await timeline(client, app.id, SYSTEM_ACTOR, "submission_blocked", { ...tdetail, reason, taskId: task ? task.id : null, status: app.status });
  await audit(client, SYSTEM_ACTOR, "submission.blocked", app.candidate_id, app.id, { ...tdetail, reason, moved, taskId: task ? task.id : null });
  await event(client, app.candidate_id, "submission.blocked", { applicationId: app.id, submissionId: sub.id, code });
  return { status: "blocked", code, reason, applicationStatus: app.status, taskId: task ? task.id : null, submissionId: sub.id };
}

/** Uncertain delivery: outcome_unknown + verify_delivery task + application needs_staff. Never retried. */
async function markUnknown(client, { app, cand, sub }, why, extra = {}) {
  const evidence = { ...(sub.evidence || {}), ...extra, phase: "outcome_unknown", reason: why, recordedAt: new Date().toISOString() };
  await client.query("UPDATE js_submissions SET status = 'outcome_unknown', evidence = $2::jsonb WHERE id = $1", [sub.id, JSON.stringify(evidence)]);
  const task = await openTask(client, app, cand, "verify_delivery", `Submission ${sub.id}: ${why}. It may have been delivered; verify with the employer or the mail provider before any new attempt.`);
  const moved = await moveIfAllowed(client, app, "needs_staff", SYSTEM_ACTOR, { reason: `outcome_unknown:${why}`.slice(0, 200), detail: { submissionId: sub.id, taskId: task.id } });
  await timeline(client, app.id, SYSTEM_ACTOR, "submission_outcome_unknown", { submissionId: sub.id, reason: why, taskId: task.id });
  await audit(client, SYSTEM_ACTOR, "submission.outcome_unknown", app.candidate_id, app.id, { submissionId: sub.id, reason: why, moved, taskId: task.id });
  await event(client, app.candidate_id, "submission.outcome_unknown", { applicationId: app.id, submissionId: sub.id });
  return { status: "outcome_unknown", reason: why, submissionId: sub.id, taskId: task.id };
}

async function lockSubmission(client, applicationId, submissionId) {
  const locked = await lockApplication(client, applicationId);
  if (!locked) return null;
  const sub = (await client.query("SELECT * FROM js_submissions WHERE id = $1 AND application_id = $2 FOR UPDATE", [submissionId, applicationId])).rows[0];
  return sub ? { ...locked, sub } : null;
}

/** Phase 1 (one transaction): re-check everything and durably record the intent, or block. */
async function prepareSend(client, job, applicationId, submissionId, deps) {
  const st = await lockSubmission(client, applicationId, submissionId);
  if (!st) return { done: { status: "noop", reason: "no_submission" } };
  const { app, cand, sub } = st;
  if (sub.status !== "queued") return { done: { status: "noop", reason: `submission_${sub.status}`, submissionId: sub.id } };
  if (sub.evidence && sub.evidence.phase === "sending") {
    // We hold the advisory lock, so the earlier sender is gone (crash between intent and result).
    return { done: await markUnknown(client, st, "interrupted_after_intent") };
  }
  if (deps.sweepOnly) return { done: { status: "noop", reason: "not_interrupted", submissionId: sub.id } };
  const g = await guard.check(applicationId, { client, recheck: deps.recheck, now: deps.now });
  if (!g.ok) return { done: await blockSubmission(client, st, g) };
  if (sub.recipient && g.recipient !== sub.recipient) {
    return { done: await blockSubmission(client, st, { code: "recipient_changed", detail: `The recipient changed since the application was queued (${sub.recipient} -> ${g.recipient}); a human must confirm`, handoff: "staff_review", notes: g.notes }) };
  }
  const jobRow = (await client.query("SELECT * FROM js_jobs WHERE id = $1", [app.job_id])).rows[0] || {};
  const prefs = (await client.query("SELECT salary_min, availability, residence_country FROM js_preferences WHERE candidate_id = $1", [app.candidate_id])).rows[0] || {};
  const channel = unsupported.detectChannel(app, jobRow, prefs);
  if (channel !== "email") return { done: await blockSubmission(client, st, { code: "handoff_required", detail: `Channel check: ${channel}`, handoff: channel, notes: g.notes }) };

  // The exact package the guard just re-validated (approved rows), loaded by storage key and re-hashed.
  const rows = (await client.query(
    `SELECT d.*, f.storage_key AS cv_key, doc.file_path AS doc_path FROM js_application_documents d
       LEFT JOIN js_cv_files f ON f.id = d.cv_file_id LEFT JOIN documents doc ON doc.id = d.document_id
      WHERE d.application_id = $1 AND d.removed_at IS NULL AND d.approved_at IS NOT NULL ORDER BY d.id`,
    [app.id]
  )).rows;
  const refs = rows.map((r) => ({
    kind: r.cv_file_id ? "cv" : "document",
    cvFileId: r.cv_file_id || null,
    documentId: r.document_id || null,
    version: r.version,
    sha256: r.sha256,
    docType: r.doc_type,
    sensitive: r.sensitive,
    storageKey: r.cv_file_id ? r.cv_key : STORAGE_KEY_RE.test(String(r.doc_path || "")) ? r.doc_path : null,
  }));
  const profile = (await client.query("SELECT confirmed FROM js_profiles WHERE candidate_id = $1", [app.candidate_id])).rows[0];
  const candidateName = (profile && profile.confirmed && profile.confirmed.name) || "";
  const loaded = await emailChannel.loadAttachments(refs, { candidateName });
  if (loaded.problems.length || !loaded.attachments.some((a) => a.ref.cvFileId)) {
    return { done: await blockSubmission(client, st, { code: "attachment_unavailable", detail: `Package files could not be loaded intact: ${loaded.problems.join(", ") || "no CV"}`, handoff: "staff_review", notes: g.notes }) };
  }

  const token = replyToken(app.id, sub.id);
  const messageId = messageIdFor(app.id, sub.id);
  const mail = buildEmail({ app, job: jobRow, candidateName, token, messageId, attachments: loaded.attachments });
  const docs = refs.map((r) => ({ kind: r.kind, cvFileId: r.cvFileId, documentId: r.documentId, version: r.version, sha256: r.sha256, sensitive: Boolean(r.sensitive) }));
  const intent = {
    phase: "sending",
    startedAt: new Date().toISOString(),
    recipient: g.recipient,
    recipientSource: g.recipientSource || null,
    channel: "email",
    messageIdPlanned: messageId,
    replyToken: token,
    docs,
    attempt: sub.attempt_no,
    queueJobId: job && job.id ? Number(job.id) : null,
    approval: g.approval || null,
  };
  await client.query("UPDATE js_submissions SET evidence = $2::jsonb, recipient = $3, channel = 'email' WHERE id = $1", [sub.id, JSON.stringify(intent), g.recipient]);
  for (const note of g.notes || []) await timeline(client, app.id, SYSTEM_ACTOR, "guard_note", { note, submissionId: sub.id });
  await timeline(client, app.id, SYSTEM_ACTOR, "submission_sending", { submissionId: sub.id, recipient: g.recipient, docs, messageId });
  await audit(client, SYSTEM_ACTOR, "submission.sending", app.candidate_id, app.id, { submissionId: sub.id, recipient: g.recipient, docs });
  return { send: { app, sub, mail, recipient: g.recipient, intent } };
}

/** Phase 2 (one transaction): record what the provider said. */
async function recordResult(client, applicationId, submissionId, plan, res) {
  const st = await lockSubmission(client, applicationId, submissionId);
  if (!st) return { status: "lost", reason: "submission_vanished" };
  const { app, cand, sub } = st;
  const intent = plan.intent;
  if (sub.status !== "queued" || !sub.evidence || sub.evidence.messageIdPlanned !== intent.messageIdPlanned) {
    // Should be impossible (we held the advisory lock): keep the provider answer, change nothing else.
    await client.query("UPDATE js_submissions SET evidence = COALESCE(evidence, '{}'::jsonb) || $2::jsonb WHERE id = $1", [sub.id, JSON.stringify({ lateResult: { outcome: res.outcome, providerMessageId: res.providerMessageId || null, at: new Date().toISOString() } })]);
    await openTask(client, app, cand, "verify_delivery", `Submission ${sub.id} changed while sending; provider said ${res.outcome}`);
    return { status: "conflict", submissionId: sub.id };
  }
  const base = { ...intent, provider: res.evidence && res.evidence.provider, providerResponse: res.evidence ? res.evidence.providerResponse : null, attachments: res.evidence ? res.evidence.attachments : [], finishedAt: new Date().toISOString() };
  if (res.accepted) {
    const evidence = { ...base, phase: "sent", providerMessageId: res.providerMessageId };
    await client.query("UPDATE js_submissions SET status = 'sent', sent_at = now(), provider_message_id = $2, evidence = $3::jsonb WHERE id = $1", [sub.id, res.providerMessageId, JSON.stringify(evidence)]);
    let moved = await moveIfAllowed(client, app, "sent", SYSTEM_ACTOR, { reason: "provider_accepted", detail: { submissionId: sub.id, recipient: plan.recipient } });
    let taskId = null;
    if (!moved && app.status !== "sent") {
      // e.g. consent withdrawn while the provider call was in flight: the mail went; say so honestly.
      taskId = (await openTask(client, app, cand, "review", `Submission ${sub.id} was accepted by the provider after the application became ${app.status}`)).id;
    }
    await timeline(client, app.id, SYSTEM_ACTOR, "submission_sent", { submissionId: sub.id, recipient: plan.recipient, providerMessageId: res.providerMessageId, docs: intent.docs, awaiting: "confirmation evidence", taskId });
    await audit(client, SYSTEM_ACTOR, "submission.sent", app.candidate_id, app.id, { submissionId: sub.id, recipient: plan.recipient, docs: intent.docs });
    await event(client, app.candidate_id, "submission.sent", { applicationId: app.id, submissionId: sub.id });
    moved = moved || app.status;
    return { status: "sent", submissionId: sub.id, providerMessageId: res.providerMessageId, applicationStatus: moved };
  }
  if (res.outcome === "refused") {
    const evidence = { ...base, phase: "failed", reason: res.reason };
    await client.query("UPDATE js_submissions SET status = 'failed', evidence = $2::jsonb WHERE id = $1", [sub.id, JSON.stringify(evidence)]);
    const task = await openTask(client, app, cand, "delivery_failed", `Submission ${sub.id} was refused by the provider: ${res.reason}`);
    await moveIfAllowed(client, app, "failed", SYSTEM_ACTOR, { reason: `provider_refused`, detail: { submissionId: sub.id, reason: res.reason, taskId: task.id } });
    await timeline(client, app.id, SYSTEM_ACTOR, "submission_failed", { submissionId: sub.id, reason: res.reason, taskId: task.id });
    await audit(client, SYSTEM_ACTOR, "submission.failed", app.candidate_id, app.id, { submissionId: sub.id, reason: res.reason });
    await event(client, app.candidate_id, "submission.failed", { applicationId: app.id, submissionId: sub.id });
    return { status: "failed", submissionId: sub.id, reason: res.reason, taskId: task.id };
  }
  return markUnknown(client, st, res.reason ? "provider_error" : "provider_outcome_unknown", { ...base, providerError: res.reason || null });
}

/**
 * Queue handler for kind 'submit'. payload {applicationId, candidateId, submissionId}.
 * Returns a result object (the queue completes the item); throws only for infrastructure errors
 * BEFORE the intent is recorded (safe to retry) or while recording the result (the retry then finds
 * phase 'sending' and records outcome_unknown - never a second send).
 * @param {object} job js_queue row
 * @param {{recheck?: Function, now?: Date, mailSend?: Function, onIntentPersisted?: Function}} [deps]
 *   onIntentPersisted: called after the intent commit, before the provider call (observability /
 *   crash simulation in tests: a throw there leaves the row in phase 'sending' like a dead process).
 */
async function handleSubmit(job, deps = {}) {
  const p = (job && job.payload) || {};
  const applicationId = posInt(p.applicationId);
  if (!applicationId) return { status: "noop", reason: "bad_payload" };
  let submissionId = posInt(p.submissionId);
  if (!submissionId) {
    const r = (await db().query("SELECT id FROM js_submissions WHERE application_id = $1 AND status = 'queued' ORDER BY id DESC LIMIT 1", [applicationId])).rows[0];
    if (!r) return { status: "noop", reason: "no_submission" };
    submissionId = r.id;
  }
  const conn = await db().connect();
  let locked = false;
  let destroy = false;
  try {
    locked = (await conn.query("SELECT pg_try_advisory_lock($1, $2) AS ok", [LOCK_CLASS, submissionId])).rows[0].ok === true;
    if (!locked) return { status: "in_progress", submissionId };
    const plan = await inTx((c) => prepareSend(c, job, applicationId, submissionId, deps), conn);
    if (plan.done) {
      await auditLog(SYSTEM_ACTOR, `jobsearch.submission.${plan.done.status}`, submissionId, { applicationId, ...plan.done });
      return plan.done;
    }
    if (typeof deps.onIntentPersisted === "function") await deps.onIntentPersisted({ applicationId, submissionId });
    // Provider call: outside any transaction; at most once for this submission row.
    const res = await emailChannel.send(plan.send.app, plan.send.mail, plan.send.recipient, { mailSend: deps.mailSend });
    const out = await inTx((c) => recordResult(c, applicationId, submissionId, plan.send, res), conn);
    await auditLog(SYSTEM_ACTOR, `jobsearch.submission.${out.status}`, submissionId, { applicationId, status: out.status, reason: out.reason || null });
    return out;
  } finally {
    if (locked) {
      try {
        await conn.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_CLASS, submissionId]);
      } catch {
        destroy = true; // dropping the session releases the lock
      }
    }
    conn.release(destroy);
  }
}

/**
 * Submissions left 'queued' in phase 'sending' whose sender is gone (no advisory lock held) become
 * outcome_unknown (+ task). Run by the worker tick and POST /jobsearch/queue/run. Never sends.
 */
async function sweepStuckSending({ limit = 50 } = {}) {
  const rows = (await db().query("SELECT id, application_id FROM js_submissions WHERE status = 'queued' AND evidence->>'phase' = 'sending' ORDER BY id LIMIT $1", [limit])).rows;
  const out = [];
  for (const r of rows) out.push(await handleSubmit({ id: null, payload: { applicationId: r.application_id, submissionId: r.id } }, { sweepOnly: true }));
  return out.filter((x) => x.status === "outcome_unknown").length;
}

// ---------------------------------------------------------------- evidence

async function scopedSubmission(user, submissionId) {
  const id = posInt(submissionId);
  if (!id || !user) throw new HttpError(404, "Not found");
  const { clause, params } = candidateScopeSql(user, "c", 1);
  const r = await db().query(
    `SELECT s.id, s.application_id, a.candidate_id FROM js_submissions s JOIN js_applications a ON a.id = s.application_id JOIN candidates c ON c.id = a.candidate_id
      WHERE s.id = $1 AND c.is_deleted = false AND ${clause}`,
    [id, ...params]
  );
  if (!r.rowCount) throw new HttpError(404, "Not found");
  return r.rows[0];
}

function senderAddress(fromAddr) {
  const s = String(fromAddr || "");
  const m = /<([^<>]+)>\s*$/.exec(s);
  return guard.normalizeEmail(m ? m[1] : s);
}

function validFileRef(ref) {
  if (ref === undefined || ref === null) return null;
  if (typeof ref !== "object" || Array.isArray(ref)) throw new HttpError(400, "fileRef must be {storageKey} or {documentId}");
  if (ref.storageKey !== undefined) {
    if (typeof ref.storageKey !== "string" || !STORAGE_KEY_RE.test(ref.storageKey)) throw new HttpError(400, "fileRef.storageKey is not a valid storage key");
    return { storageKey: ref.storageKey };
  }
  const docId = posInt(ref.documentId);
  if (!docId) throw new HttpError(400, "fileRef must be {storageKey} or {documentId}");
  return { documentId: docId };
}

async function checkEvidence(client, { app, sub }, kind, detail, actor) {
  if (kind === "delivery_receipt") {
    const mid = cleanText(detail.providerMessageId || detail.messageId, 300);
    if (!mid) throw new HttpError(400, "delivery_receipt needs providerMessageId");
    const known = [sub.provider_message_id, sub.evidence && sub.evidence.messageIdPlanned, sub.evidence && sub.evidence.providerMessageId].filter(Boolean);
    if (!known.includes(mid)) throw new HttpError(409, "The receipt does not match this submission's message id");
    const action = detail.action === undefined ? null : cleanText(String(detail.action), 40).toLowerCase();
    if (action && !DELIVERED_ACTIONS.has(action)) throw new HttpError(409, `A '${action}' receipt is not delivery evidence`);
    return { providerMessageId: mid, action, receivedAt: cleanText(detail.receivedAt, 40) || null, reportRef: cleanText(detail.reportRef, 200) || null };
  }
  if (kind === "employer_acknowledgement") {
    const msgId = posInt(detail.messageId);
    if (!msgId) throw new HttpError(400, "employer_acknowledgement needs messageId (a js_messages id)");
    const msg = (await client.query("SELECT id, application_id, direction, from_addr, created_at FROM js_messages WHERE id = $1", [msgId])).rows[0];
    if (!msg || msg.application_id !== app.id || msg.direction !== "in") throw new HttpError(409, "The message is not an inbound message linked to this application");
    const from = senderAddress(msg.from_addr);
    const employer = (await client.query("SELECT e.domain, e.verified_contact_email FROM js_jobs j JOIN js_employers e ON e.id = j.employer_id WHERE j.id = $1", [app.job_id])).rows[0] || null;
    const ok = Boolean(from && ((sub.recipient && from === guard.normalizeEmail(sub.recipient)) || guard.verifyRecipient(employer, from, null)));
    if (!ok) throw new HttpError(409, "The message does not come from the employer's verified domain or contact");
    return { messageId: msg.id, from, receivedAt: msg.created_at };
  }
  // manual_confirmation
  if (!isUser(actor) || actor.role === "Candidate" || !hasPerm(actor, "jobsearch:approve")) throw new HttpError(403, "Manual confirmation requires a manager or administrator");
  const note = cleanText(detail.note);
  if (!note) throw new HttpError(400, "manual_confirmation needs a note describing the evidence");
  const fileRef = validFileRef(detail.fileRef);
  if (fileRef && fileRef.documentId) {
    const d = await client.query("SELECT 1 FROM documents WHERE id = $1 AND candidate_id = $2 AND is_deleted = false", [fileRef.documentId, app.candidate_id]);
    if (!d.rowCount) throw new HttpError(400, "fileRef.documentId is not a document of this candidate");
  }
  return { note, fileRef };
}

/**
 * The ONLY path to confirmed_submitted. Appends a confirmation to js_submissions.evidence.confirmations[]
 * and moves the application sent|outcome_unknown|needs_staff -> confirmed_submitted.
 * @param {{submissionId, kind: 'delivery_receipt'|'employer_acknowledgement'|'manual_confirmation', detail: object, actor: object|string}} args
 *   actor: a user (route: jobsearch:approve + scope) or a system label (Task 13 ingestion; not for manual_confirmation)
 */
async function recordEvidence({ submissionId, kind, detail, actor }) {
  if (isUser(actor)) {
    await scopedSubmission(actor, submissionId); // 404 outside scope
    if (actor.role === "Candidate" || !hasPerm(actor, "jobsearch:approve")) throw new HttpError(403, "Recording submission evidence requires a manager or administrator");
  } else if (!actor || typeof actor !== "string") throw new HttpError(403, "An actor is required");
  const id = posInt(submissionId);
  if (!id) throw new HttpError(404, "Not found");
  if (!EVIDENCE_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${EVIDENCE_KINDS.join(", ")}`);
  if (!detail || typeof detail !== "object" || Array.isArray(detail) || !Object.keys(detail).length) throw new HttpError(400, "evidence detail is required");
  const pre = (await db().query("SELECT application_id FROM js_submissions WHERE id = $1", [id])).rows[0];
  if (!pre) throw new HttpError(404, "Not found");
  const out = await inTx(async (client) => {
    const st = await lockSubmission(client, pre.application_id, id);
    if (!st) throw new HttpError(404, "Not found");
    const { app, sub } = st;
    if (!["sent", "outcome_unknown", "confirmed_submitted"].includes(sub.status)) throw new HttpError(409, `Submission is ${sub.status}; only a sent (or uncertain) submission can be confirmed`);
    const clean = await checkEvidence(client, st, kind, detail, actor);
    const confirmation = { kind, detail: clean, actor: actorLabel(actor), at: new Date().toISOString() };
    const evidence = { ...(sub.evidence || {}) };
    evidence.confirmations = [...(Array.isArray(evidence.confirmations) ? evidence.confirmations : []), confirmation];
    await client.query("UPDATE js_submissions SET status = 'confirmed_submitted', confirmed_at = COALESCE(confirmed_at, now()), evidence = $2::jsonb WHERE id = $1", [sub.id, JSON.stringify(evidence)]);
    let moved = null;
    if (["sent", "outcome_unknown", "needs_staff"].includes(app.status)) {
      moved = await moveIfAllowed(client, app, "confirmed_submitted", actor, { reason: `evidence:${kind}`, event: "submission_confirmed", detail: { submissionId: sub.id, kind } });
    } else {
      await timeline(client, app.id, actor, "evidence_recorded", { submissionId: sub.id, kind });
    }
    await client.query("UPDATE js_tasks SET status = 'resolved', resolved_at = now() WHERE application_id = $1 AND reason = 'verify_delivery' AND status = 'open'", [app.id]);
    await audit(client, actor, "submission.evidence", app.candidate_id, app.id, { submissionId: sub.id, kind, detail: clean });
    await event(client, app.candidate_id, "submission.confirmed", { applicationId: app.id, submissionId: sub.id, kind });
    return { submissionId: sub.id, status: "confirmed_submitted", applicationStatus: moved || app.status, confirmations: evidence.confirmations.length };
  });
  await auditLog(actor, "jobsearch.submission.evidence", id, { kind, applicationStatus: out.applicationStatus });
  return out;
}

/**
 * Staff finished the application by hand (e.g. after a CAPTCHA/portal handoff): needs_staff -> sent
 * (event 'manual_completion') with a new js_submissions row holding the evidence + actor. Still
 * requires active submit consent. Confirmation then needs recordEvidence like any other submission.
 */
async function recordManualCompletion({ applicationId, actor, detail }) {
  const scoped = await applicationService.loadScoped(actor, applicationId);
  if (actor.role === "Candidate" || !hasPerm(actor, "jobsearch:approve")) throw new HttpError(403, "Manual completion requires a manager or administrator");
  const d = detail && typeof detail === "object" && !Array.isArray(detail) ? detail : {};
  const note = cleanText(d.note);
  if (!note) throw new HttpError(400, "note is required (how and where the application was completed)");
  const channel = cleanText(d.channel, 40).toLowerCase() || "manual";
  const recipient = d.recipient === undefined || d.recipient === null || d.recipient === "" ? null : guard.normalizeEmail(d.recipient);
  if (d.recipient && !recipient) throw new HttpError(400, "recipient must be a plain email address");
  const fileRef = validFileRef(d.fileRef);
  const out = await inTx(async (client) => {
    const { app } = await lockApplication(client, scoped.id);
    if (app.status !== "needs_staff") throw new HttpError(409, `Application is ${app.status}; manual completion applies to needs_staff only`);
    const cand = (await client.query("SELECT is_deleted FROM candidates WHERE id = $1", [app.candidate_id])).rows[0];
    if (!cand || cand.is_deleted || !(await consentService.activeConsent(app.candidate_id, "submit", client))) throw new HttpError(409, "No active consent to submit applications for this candidate");
    if (fileRef && fileRef.documentId) {
      const ok = await client.query("SELECT 1 FROM documents WHERE id = $1 AND candidate_id = $2 AND is_deleted = false", [fileRef.documentId, app.candidate_id]);
      if (!ok.rowCount) throw new HttpError(400, "fileRef.documentId is not a document of this candidate");
    }
    const attempt = Number((await client.query("SELECT COALESCE(max(attempt_no), 0) AS n FROM js_submissions WHERE application_id = $1", [app.id])).rows[0].n) + 1;
    const evidence = { phase: "manual", manualCompletion: { note, channel, recipient, fileRef, recordedBy: actorLabel(actor), recordedAt: new Date().toISOString() } };
    const sub = (await client.query(
      `INSERT INTO js_submissions (application_id, attempt_no, idempotency_key, channel, recipient, status, evidence, sent_at)
       VALUES ($1,$2,$3,$4,$5,'sent',$6::jsonb,now()) RETURNING *`,
      [app.id, attempt, `app:${app.id}:manual:a${attempt}`, channel, recipient, JSON.stringify(evidence)]
    )).rows[0];
    await applicationService.transition(app.id, "sent", actor, { client, reason: "manual_completion", event: "manual_completion", detail: { submissionId: sub.id, channel }, [MANUAL_COMPLETION]: true });
    await audit(client, actor, "submission.manual_completion", app.candidate_id, app.id, { submissionId: sub.id, channel, note });
    await event(client, app.candidate_id, "submission.sent", { applicationId: app.id, submissionId: sub.id, manual: true });
    return { submissionId: sub.id, status: "sent", applicationStatus: "sent" };
  });
  await auditLog(actor, "jobsearch.submission.manual_completion", out.submissionId, { applicationId: scoped.id });
  return out;
}

// ---------------------------------------------------------------- listing

const CANDIDATE_WORDING = {
  queued: "Queued for sending",
  sent: "Sent - awaiting confirmation from the employer",
  confirmed_submitted: "Submission confirmed",
  failed: "Not sent",
  outcome_unknown: "Delivery could not be confirmed - our team is checking",
};

function redactEvidenceForStaff(ev) {
  if (!ev || typeof ev !== "object") return ev || null;
  const { replyToken: _t, ...rest } = ev; // eslint-disable-line no-unused-vars
  return rest;
}

/** GET /jobsearch/submissions?applicationId= (scoped). Candidates see status + timestamps only. */
async function listSubmissions({ user, applicationId }) {
  const appId = posInt(applicationId);
  if (!appId) throw new HttpError(400, "applicationId must be a positive integer");
  const app = await applicationService.loadScoped(user, appId);
  const rows = (await db().query("SELECT * FROM js_submissions WHERE application_id = $1 ORDER BY id", [app.id])).rows;
  if (user.role === "Candidate") {
    return {
      submissions: rows.map((s) => ({
        id: s.id,
        attempt: s.attempt_no,
        status: s.status,
        message: CANDIDATE_WORDING[s.status] || s.status,
        awaitingConfirmation: s.status === "sent",
        createdAt: s.created_at,
        sentAt: s.sent_at,
        confirmedAt: s.confirmed_at,
      })),
    };
  }
  return {
    submissions: rows.map((s) => ({
      id: s.id,
      applicationId: s.application_id,
      attempt: s.attempt_no,
      status: s.status,
      awaitingConfirmation: s.status === "sent",
      channel: s.channel,
      recipient: s.recipient,
      providerMessageId: s.provider_message_id,
      evidence: redactEvidenceForStaff(s.evidence),
      createdAt: s.created_at,
      sentAt: s.sent_at,
      confirmedAt: s.confirmed_at,
    })),
  };
}

module.exports = {
  queueSubmission,
  handleSubmit,
  recordEvidence,
  recordManualCompletion,
  listSubmissions,
  sweepStuckSending,
  replyToken,
  findByReplyToken,
  EVIDENCE_KINDS,
  CANDIDATE_WORDING,
  SYSTEM_ACTOR,
};
