// Applications: creation from matches, the status state machine, preparation (cover letter +
// document package), human approval, rejection/cancellation and candidate sharing authorizations.
//
// Locking rule (binding): every transition locks the CANDIDATE row first
// (SELECT ... FROM candidates WHERE id=$1 FOR UPDATE), then the application row. Transitions INTO
// approved/queued re-check submit consent + not paused/suspended in that same transaction, so they
// serialise with consent withdrawal (which takes the same candidate lock).
const { HttpError } = require("./httpError");
const { candidateScopeSql, isAdmin } = require("./scope");
const consentService = require("./consentService");
const coverLetter = require("./coverLetter");
const documentPolicy = require("./documentPolicy");
const { country, NOTICE } = require("./matching");
const { normalize } = require("./jobStore");
const { PERMISSIONS } = require("../../middleware/role");
const { logAudit } = require("../../utils/audit");

const db = () => require("../../db");

const STATUSES = ["matched", "preparing", "ready_for_review", "approved", "queued", "sent", "confirmed_submitted", "failed", "outcome_unknown", "needs_staff", "cancelled", "closed", "interview", "offer", "rejected"];

// Spec §7. Main line: matched -> preparing -> ready_for_review -> approved -> queued -> sent -> confirmed_submitted.
// Backward moves to 'preparing' mean "needs re-preparation / re-review" (e.g. a revoked authorization).
const TRANSITIONS = Object.freeze({
  matched: ["preparing", "needs_staff", "cancelled", "closed"],
  preparing: ["ready_for_review", "needs_staff", "failed", "cancelled", "closed"],
  ready_for_review: ["approved", "preparing", "needs_staff", "cancelled", "closed"],
  approved: ["queued", "preparing", "needs_staff", "cancelled", "closed"],
  // queued -> approved: SYSTEM-only operational hold (pause found at send time; submitter, Task 11).
  queued: ["sent", "failed", "outcome_unknown", "needs_staff", "preparing", "approved", "cancelled", "closed"],
  sent: ["confirmed_submitted", "outcome_unknown", "failed", "interview", "offer", "rejected", "closed"],
  outcome_unknown: ["sent", "confirmed_submitted", "failed", "needs_staff", "interview", "offer", "rejected", "cancelled", "closed"],
  confirmed_submitted: ["interview", "offer", "rejected", "closed"],
  failed: ["preparing", "needs_staff", "cancelled", "closed"],
  // sent: ONLY via submitter.recordManualCompletion (staff finished it by hand, evidence required);
  // confirmed_submitted: ONLY via submitter.recordEvidence (stored evidence record).
  needs_staff: ["preparing", "sent", "confirmed_submitted", "failed", "cancelled", "closed"],
  interview: ["offer", "rejected", "closed"],
  offer: ["rejected", "closed"],
  rejected: ["closed"],
  cancelled: [],
  closed: [],
});
const PRE_SEND = ["matched", "preparing", "ready_for_review", "approved", "queued"];
const PREPARABLE = ["matched", "preparing", "ready_for_review", "failed", "needs_staff"];
const CANCELLABLE_QUEUE_KINDS = consentService.CANCELLABLE_QUEUE_KINDS;

// Internal capability for non-human approve/queue transitions (autoApprove here; the submitter in
// Task 11). Exported only as `_internal`; routes never pass it.
const SYSTEM_GRANT = Symbol("jobsearch.systemSendGrant");
// Internal capability for needs_staff -> sent (staff-recorded manual completion, Task 11).
const MANUAL_COMPLETION = Symbol("jobsearch.manualCompletion");
// Internal capability for the scheduler (Task 12): create/prepare as a system actor ('system:scheduler')
// without a user scope. Never reachable from a route (a Symbol key cannot come from JSON). It does NOT
// allow approve/queue: those still need SYSTEM_GRANT via autoApprove / the submitter.
const SCHEDULER_GRANT = Symbol("jobsearch.schedulerGrant");
const isSystemActor = (actor) => typeof actor === "string" && /^system:[a-z_]{1,40}$/.test(actor);

const LABEL_NOTICE = "Employer-support labels are read from the job ad and are informational only. Always verify with the employer before relying on them.";
const MAX_REASON = 500;

// ---------------------------------------------------------------- helpers

function hasPerm(user, perm) {
  const perms = (user && PERMISSIONS[user.role]) || [];
  return perms.includes("*") || perms.includes(perm);
}

function actorOf(actor) {
  if (!actor || typeof actor === "string") return actor || "system";
  return actor.role === "Candidate" ? `candidate:${actor.id}` : `staff:${actor.id}`;
}

const posInt = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);

function cleanReason(reason, { required = true } = {}) {
  if (reason === undefined || reason === null || (typeof reason === "string" && !reason.trim())) {
    if (required) throw new HttpError(400, "reason is required");
    return null;
  }
  if (typeof reason !== "string") throw new HttpError(400, "reason must be a string");
  return reason.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
}

async function inTx(fn) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function audit(client, actor, action, candidateId, applicationId, detail) {
  await client.query("INSERT INTO js_audit_events (actor, action, candidate_id, application_id, detail) VALUES ($1,$2,$3,$4,$5::jsonb)", [
    typeof actor === "object" && actor ? `user:${actor.id}` : actorOf(actor),
    action,
    candidateId,
    applicationId,
    JSON.stringify(detail || {}),
  ]);
}

async function event(client, candidateId, kind, payload) {
  await client.query("INSERT INTO js_events (candidate_id, kind, payload) VALUES ($1,$2,$3::jsonb)", [candidateId, kind, JSON.stringify(payload || {})]);
}

async function timeline(client, applicationId, actor, ev, detail) {
  await client.query("INSERT INTO js_timeline (application_id, actor, event, detail) VALUES ($1,$2,$3,$4::jsonb)", [applicationId, actorOf(actor), ev, JSON.stringify(detail)]);
}

async function logAfter(actor, action, recordId, newData) {
  if (!actor || typeof actor !== "object" || !Number.isSafeInteger(actor.id)) return;
  await logAudit({ userId: actor.id, action, tableName: "js_applications", recordId, newData });
}

function present(a) {
  return {
    id: a.id,
    candidateId: a.candidate_id,
    jobId: a.job_id,
    status: a.status,
    modeAtCreation: a.mode_at_creation,
    responsibleUserId: a.responsible_user_id,
    channel: a.channel,
    coverLetterLang: a.cover_letter_lang,
    jobLanguage: a.job_language,
    packageBlocked: a.package_blocked || [],
    packageNotes: a.package_notes || [],
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

/** The candidate's sendability inside `client`'s transaction (candidate row already locked). */
async function sendBlockers(client, candidateId, scopeKey) {
  const reasons = [];
  const cand = (await client.query("SELECT is_deleted FROM candidates WHERE id = $1", [candidateId])).rows[0];
  if (!cand || cand.is_deleted) reasons.push("candidate_deleted");
  if (!(await consentService.activeConsent(candidateId, scopeKey, client))) reasons.push(`no_${scopeKey}_consent`);
  const s = (await client.query("SELECT paused, mode FROM js_candidate_settings WHERE candidate_id = $1", [candidateId])).rows[0];
  if (s && s.paused) reasons.push("candidate_paused");
  // The mode can change after creation/preparation: search_only never prepares, approves or queues.
  if ((scopeKey === "submit" || scopeKey === "prepare") && (!s || s.mode === "search_only")) reasons.push("mode_search_only");
  const m = (await client.query("SELECT value FROM js_module_state WHERE key = 'module_paused'")).rows[0];
  if (m && m.value && m.value.paused === true) reasons.push("module_paused");
  const u = await client.query("SELECT u.is_active FROM js_candidate_accounts a JOIN users u ON u.id = a.user_id WHERE a.candidate_id = $1", [candidateId]);
  if (u.rows.some((r) => !r.is_active)) reasons.push("account_suspended");
  return reasons;
}

/** Locks candidate (first) then application; returns the locked application row. */
async function lockApplication(client, applicationId) {
  const pre = (await client.query("SELECT candidate_id FROM js_applications WHERE id = $1", [applicationId])).rows[0];
  if (!pre) throw new HttpError(404, "Not found");
  await client.query("SELECT id FROM candidates WHERE id = $1 FOR UPDATE", [pre.candidate_id]);
  const app = (await client.query("SELECT * FROM js_applications WHERE id = $1 FOR UPDATE", [applicationId])).rows[0];
  if (!app || app.candidate_id !== pre.candidate_id) throw new HttpError(409, "Application changed concurrently");
  return app;
}

// ---------------------------------------------------------------- state machine

/**
 * Moves an application to `to` if TRANSITIONS allows it. Writes js_timeline (actor + reason),
 * js_audit_events and js_events. Runs in opts.client's transaction or its own.
 * @param {number} applicationId
 * @param {string} to
 * @param {object|string} actor  user ({id, role}) or a system label
 * @param {{reason?: string, event?: string, detail?: object, client?: object, expectFrom?: string[]}} [opts]
 * @returns {Promise<object>} the updated js_applications row
 */
async function transition(applicationId, to, actor, opts = {}) {
  if (!STATUSES.includes(to)) throw new HttpError(400, `Unknown status: ${to}`);
  const id = posInt(applicationId);
  if (!id) throw new HttpError(404, "Not found");
  const reason = cleanReason(opts.reason, { required: false }) || `transition_to_${to}`;
  const run = async (client) => {
    const app = await lockApplication(client, id);
    const from = app.status;
    if (opts.expectFrom && !opts.expectFrom.includes(from)) throw new HttpError(409, `Application is ${from}`);
    if (!(TRANSITIONS[from] || []).includes(to)) throw new HttpError(409, `Illegal transition ${from} -> ${to}`);
    const hold = from === "queued" && to === "approved";
    if (hold && (actor && typeof actor === "object")) throw new HttpError(403, "queued -> approved is a system-only hold");
    if (to === "approved" || to === "queued") {
      // A non-human actor may only approve/queue through autoApprove (or the submitter) holding the
      // internal grant; a human needs jobsearch:approve. Never reachable from a route with 'system'.
      if (!actor || typeof actor !== "object") {
        if (opts[SYSTEM_GRANT] !== true) throw new HttpError(403, `A system actor cannot move an application to ${to} outside autoApprove`);
      } else if (!hasPerm(actor, "jobsearch:approve")) {
        throw new HttpError(403, `Moving an application to ${to} requires a manager or administrator`);
      }
      let blockers = await sendBlockers(client, app.candidate_id, "submit");
      // A pause hold returns the item to 'approved' BECAUSE of the pause; consent/suspension still block.
      if (hold) blockers = blockers.filter((b) => b !== "candidate_paused" && b !== "module_paused");
      if (blockers.length) throw new HttpError(409, `Cannot move to ${to}: ${blockers.join(", ")}`);
    }
    if (to === "ready_for_review" || (to === "preparing" && ["matched", "failed", "needs_staff"].includes(from))) {
      const blockers = await sendBlockers(client, app.candidate_id, "prepare");
      if (blockers.length) throw new HttpError(409, `Cannot prepare: ${blockers.join(", ")}`);
    }
    if (from === "needs_staff" && to === "sent") {
      // 'manual_completion': staff finished the submission by hand. Needs the internal grant, a user
      // with jobsearch:approve, and the stored manual-completion evidence row.
      if (opts[MANUAL_COMPLETION] !== true) throw new HttpError(409, "needs_staff -> sent is only possible as a recorded manual completion");
      if (!actor || typeof actor !== "object" || !hasPerm(actor, "jobsearch:approve")) throw new HttpError(403, "Manual completion requires a manager or administrator");
      const ev = await client.query("SELECT 1 FROM js_submissions WHERE application_id = $1 AND status = 'sent' AND evidence->>'phase' = 'manual' AND jsonb_typeof(evidence->'manualCompletion') = 'object'", [id]);
      if (!ev.rowCount) throw new HttpError(409, "Manual completion requires a stored evidence record");
    }
    if (to === "confirmed_submitted") {
      const ev = await client.query("SELECT 1 FROM js_submissions WHERE application_id = $1 AND status = 'confirmed_submitted' AND evidence IS NOT NULL", [id]);
      if (!ev.rowCount) throw new HttpError(409, "confirmed_submitted requires a stored evidence record");
    }
    const row = (await client.query("UPDATE js_applications SET status = $2, updated_at = now() WHERE id = $1 RETURNING *", [id, to])).rows[0];
    const detail = { ...(opts.detail || {}), from, to, reason };
    await timeline(client, id, actor, opts.event || "status_changed", detail);
    await audit(client, actor, "application.transition", app.candidate_id, id, detail);
    await event(client, app.candidate_id, "application.status_changed", { applicationId: id, from, to });
    return row;
  };
  if (opts.client) return run(opts.client);
  const row = await inTx(run);
  await logAfter(actor, "jobsearch.application.transition", id, { to, reason });
  return row;
}

// ---------------------------------------------------------------- scoped reads

function canUse(user, perm) {
  if (!user) return false;
  if (user.role === "Candidate") return true; // ownership enforced by scope SQL
  return hasPerm(user, perm);
}

/** Application row within the user's scope (candidate not deleted), else 404. */
async function loadScoped(user, applicationId, client) {
  const id = posInt(applicationId);
  if (!id || !canUse(user, "jobsearch:read")) throw new HttpError(404, "Not found");
  const { clause, params } = candidateScopeSql(user, "c", 1);
  const r = await (client || db()).query(
    `SELECT a.* FROM js_applications a JOIN candidates c ON c.id = a.candidate_id
      WHERE a.id = $1 AND c.is_deleted = false AND ${clause}`,
    [id, ...params]
  );
  if (!r.rowCount) throw new HttpError(404, "Not found");
  return r.rows[0];
}

/** System actors (scheduler): the application row when its candidate is not deleted, else 404. */
async function loadLive(applicationId) {
  const id = posInt(applicationId);
  if (!id) throw new HttpError(404, "Not found");
  const r = await db().query("SELECT a.* FROM js_applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.id = $1 AND c.is_deleted = false", [id]);
  if (!r.rowCount) throw new HttpError(404, "Not found");
  return r.rows[0];
}

// ---------------------------------------------------------------- creation

/**
 * Creates the application for a match (idempotent per candidate+job). Requires search consent and a
 * mode other than search_only. First status: 'matched'.
 * @returns {Promise<object>} presented application with `created` (false when it already existed)
 */
async function createFromMatch({ matchId, actor, [SCHEDULER_GRANT]: schedulerGrant }) {
  const mid = posInt(matchId);
  if (!mid) throw new HttpError(400, "matchId must be a positive integer");
  const system = schedulerGrant === true && isSystemActor(actor);
  if (!system && !canUse(actor, "jobsearch:write")) throw new HttpError(404, "Not found");
  let m;
  if (system) {
    m = (await db().query("SELECT m.candidate_id, m.job_id FROM js_matches m JOIN candidates c ON c.id = m.candidate_id WHERE m.id = $1 AND c.is_deleted = false", [mid])).rows[0];
  } else {
    const { clause, params } = candidateScopeSql(actor, "c", 1);
    m = (await db().query(
      `SELECT m.candidate_id, m.job_id FROM js_matches m JOIN candidates c ON c.id = m.candidate_id
        WHERE m.id = $1 AND c.is_deleted = false AND ${clause}`,
      [mid, ...params]
    )).rows[0];
  }
  if (!m) throw new HttpError(404, "Not found");
  const out = await inTx(async (client) => {
    const cand = (await client.query("SELECT id, assigned_to, is_deleted FROM candidates WHERE id = $1 FOR UPDATE", [m.candidate_id])).rows[0];
    if (!cand || cand.is_deleted) throw new HttpError(404, "Not found");
    const existing = (await client.query("SELECT * FROM js_applications WHERE candidate_id = $1 AND job_id = $2", [m.candidate_id, m.job_id])).rows[0];
    if (existing) return { row: existing, created: false };
    const settings = (await client.query("SELECT mode FROM js_candidate_settings WHERE candidate_id = $1", [m.candidate_id])).rows[0];
    const mode = (settings && settings.mode) || "search_only";
    if (mode === "search_only") throw new HttpError(409, "Mode search_only creates matches only; no applications");
    const elig = await sendBlockers(client, m.candidate_id, "search");
    if (elig.length) throw new HttpError(409, `Cannot create application: ${elig.join(", ")}`);
    const job = (await client.query("SELECT status FROM js_jobs WHERE id = $1", [m.job_id])).rows[0];
    if (!job || job.status !== "open") throw new HttpError(409, "The job is no longer open");
    const ins = await client.query(
      `INSERT INTO js_applications (candidate_id, job_id, status, mode_at_creation, responsible_user_id)
       VALUES ($1,$2,'matched',$3,$4) ON CONFLICT (candidate_id, job_id) DO NOTHING RETURNING *`,
      [m.candidate_id, m.job_id, mode, cand.assigned_to]
    );
    if (!ins.rowCount) return { row: (await client.query("SELECT * FROM js_applications WHERE candidate_id = $1 AND job_id = $2", [m.candidate_id, m.job_id])).rows[0], created: false };
    const row = ins.rows[0];
    const detail = { reason: "created_from_match", matchId: mid, mode, responsibleUserId: cand.assigned_to };
    await timeline(client, row.id, actor, "created", detail);
    await audit(client, actor, "application.create", m.candidate_id, row.id, detail);
    await event(client, m.candidate_id, "application.created", { applicationId: row.id, jobId: m.job_id });
    return { row, created: true };
  });
  if (out.created) await logAfter(actor, "jobsearch.application.create", out.row.id, { matchId: mid });
  return { ...present(out.row), created: out.created };
}

// ---------------------------------------------------------------- preparation

/**
 * matched/failed/needs_staff/ready_for_review -> preparing -> ready_for_review (only when nothing is
 * blocked). Builds the cover letter from the CONFIRMED profile and stores the exact package.
 * @param {{id, actor, documents?: Array, lang?: string}} args  documents undefined = reuse the last request
 */
async function prepareApplication({ id, actor, documents, lang, [SCHEDULER_GRANT]: schedulerGrant }) {
  const system = schedulerGrant === true && isSystemActor(actor);
  if (!system && !canUse(actor, "jobsearch:write")) throw new HttpError(404, "Not found");
  const scoped = system ? await loadLive(id) : await loadScoped(actor, id);
  const requested = documents === undefined ? undefined : documentPolicy.validateRequested(documents);
  if (lang !== undefined && lang !== null && !coverLetter.LANGS.includes(lang)) throw new HttpError(400, "lang must be en, fr or ar");
  const result = await inTx(async (client) => {
    let app = await lockApplication(client, scoped.id);
    if (!PREPARABLE.includes(app.status)) throw new HttpError(409, `Application is ${app.status}; it cannot be prepared`);
    const settings = (await client.query("SELECT mode FROM js_candidate_settings WHERE candidate_id = $1", [app.candidate_id])).rows[0];
    if (!settings || settings.mode === "search_only") throw new HttpError(409, "Mode search_only does not prepare applications");
    const profile = (await client.query("SELECT confirmed, status FROM js_profiles WHERE candidate_id = $1", [app.candidate_id])).rows[0];
    if (!profile || profile.status !== "confirmed") throw new HttpError(409, "The candidate profile must be confirmed before preparation");
    const job = (await client.query("SELECT j.*, e.name AS employer_name FROM js_jobs j LEFT JOIN js_employers e ON e.id = j.employer_id WHERE j.id = $1", [app.job_id])).rows[0];
    if (!job || job.status !== "open") throw new HttpError(409, "The job is no longer open");
    const prefs = (await client.query("SELECT needs_work_auth_support FROM js_preferences WHERE candidate_id = $1", [app.candidate_id])).rows[0];
    const blockers = await sendBlockers(client, app.candidate_id, "prepare");
    if (blockers.length) throw new HttpError(409, `Cannot prepare: ${blockers.join(", ")}`);

    if (app.status !== "preparing") app = await transition(app.id, "preparing", actor, { client, reason: app.status === "ready_for_review" ? "re_preparation_requested" : "preparation_started" });

    const jobLanguage = lang || coverLetter.detectLanguage(job);
    const letter = coverLetter.generateDetailed(profile.confirmed, { title: job.title, employer: job.employer_name }, jobLanguage, { needsWorkAuthSupport: Boolean(prefs && prefs.needs_work_auth_support === true) });
    const req = requested === undefined ? app.package_requested || [] : requested;
    const pkg = await documentPolicy.buildPackage({ application: app, requested: req, jobLanguage, client });
    const notes = [...pkg.notes, ...letter.omitted.map((f) => `omitted_sensitive_or_unverifiable:${f}`)];

    await client.query("UPDATE js_application_documents SET removed_at = now(), removed_reason = 'superseded' WHERE application_id = $1 AND removed_at IS NULL", [app.id]);
    for (const d of pkg.included) {
      await client.query(
        `INSERT INTO js_application_documents (application_id, cv_file_id, document_id, version, sensitive, sharing_authorization_id, doc_type, sha256, language, source_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [app.id, d.cvFileId || null, d.documentId || null, d.version, d.sensitive, d.sharingAuthorizationId, d.docType, d.sha256, d.language || null, d.sourceRef || null]
      );
      if (d.sensitive) {
        await audit(client, actor, "document.sensitive_included", app.candidate_id, app.id, { documentId: d.documentId, docType: d.docType, sharingAuthorizationId: d.sharingAuthorizationId });
      }
    }
    app = (await client.query(
      `UPDATE js_applications SET cover_letter_text = $2, cover_letter_lang = $3, job_language = $4, package_requested = $5::jsonb,
              package_blocked = $6::jsonb, package_notes = $7::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
      [app.id, letter.text, letter.lang, jobLanguage, JSON.stringify(req), JSON.stringify(pkg.blocked), JSON.stringify(notes)]
    )).rows[0];
    const summary = {
      reason: pkg.blocked.length ? "package_has_blocked_documents" : "package_built",
      included: pkg.included.map((d) => ({ kind: d.kind, cvFileId: d.cvFileId, documentId: d.documentId, version: d.version, sha256: d.sha256, sensitive: d.sensitive })),
      blocked: pkg.blocked,
      notes,
      letterLang: letter.lang,
    };
    await timeline(client, app.id, actor, "package_built", summary);
    await audit(client, actor, "application.prepare", app.candidate_id, app.id, summary);
    if (!pkg.blocked.length) app = await transition(app.id, "ready_for_review", actor, { client, reason: "package_complete" });
    await event(client, app.candidate_id, "application.prepared", { applicationId: app.id, status: app.status, blocked: pkg.blocked.length });
    return { app, pkg: { included: pkg.included, blocked: pkg.blocked, notes }, letter: letter.text };
  });
  await logAfter(actor, "jobsearch.application.prepare", result.app.id, { status: result.app.status, blocked: result.pkg.blocked.length });
  return { application: present(result.app), package: result.pkg, coverLetter: result.letter };
}

// ---------------------------------------------------------------- approval / rejection / cancel

/** Human approval: jobsearch:approve, status ready_for_review, nothing blocked, valid package, submit consent. */
async function approveApplication({ id, actor, reason }) {
  const scoped = await loadScoped(actor, id); // 404 outside scope (before any permission hint)
  if (!hasPerm(actor, "jobsearch:approve")) throw new HttpError(403, "Approval requires a manager or administrator");
  const why = cleanReason(reason, { required: false }) || "approved_by_reviewer";
  const app = await inTx(async (client) => {
    const locked = await lockApplication(client, scoped.id);
    if (locked.status !== "ready_for_review") throw new HttpError(409, `Application is ${locked.status}; only ready_for_review can be approved`);
    if ((locked.package_blocked || []).length) throw new HttpError(409, "The package has blocked documents");
    const problems = await documentPolicy.revalidateStoredPackage(client, locked);
    if (problems.length) throw new HttpError(409, `The package is no longer valid: ${documentPolicy.formatProblems(problems)}`);
    const job = (await client.query("SELECT status FROM js_jobs WHERE id = $1", [locked.job_id])).rows[0];
    if (!job || job.status !== "open") throw new HttpError(409, "The job is no longer open");
    const row = await transition(locked.id, "approved", actor, { client, reason: why, detail: { approvedBy: actor.id } });
    await client.query("UPDATE js_application_documents SET approved_by = $2, approved_at = now() WHERE application_id = $1 AND removed_at IS NULL", [locked.id, actor.id]);
    await audit(client, actor, "application.approve", locked.candidate_id, locked.id, { reason: why });
    await event(client, locked.candidate_id, "application.approved", { applicationId: locked.id });
    return row;
  });
  await logAfter(actor, "jobsearch.application.approve", app.id, { reason: why });
  return { application: present(app) };
}

/** Reviewer rejects a prepared application: ready_for_review -> cancelled (event review_rejected). */
async function rejectApplication({ id, actor, reason }) {
  const scoped = await loadScoped(actor, id);
  if (!hasPerm(actor, "jobsearch:approve")) throw new HttpError(403, "Rejecting a prepared application requires a manager or administrator");
  const why = cleanReason(reason);
  const app = await inTx(async (client) => {
    const row = await transition(scoped.id, "cancelled", actor, { client, reason: why, event: "review_rejected", expectFrom: ["ready_for_review"] });
    await cancelQueueItems(client, row.id, "review_rejected");
    await audit(client, actor, "application.reject", row.candidate_id, row.id, { reason: why });
    return row;
  });
  await logAfter(actor, "jobsearch.application.reject", app.id, { reason: why });
  return { application: present(app) };
}

async function cancelQueueItems(client, applicationId, reason) {
  await client.query(
    `UPDATE js_queue SET status = 'cancelled', last_error = $2
      WHERE kind = ANY($3::text[]) AND status = 'pending' AND locked_at IS NULL
        AND COALESCE(payload->>'applicationId', payload->>'application_id') = $1`,
    [String(applicationId), reason, CANCELLABLE_QUEUE_KINDS]
  );
  await consentService.closeQueuedSubmissions(client, [applicationId], reason);
}

/** Candidate (own) or in-scope staff cancels a not-yet-sent application; pending queue work is cancelled. */
async function cancelApplication({ id, actor, reason }) {
  if (!canUse(actor, "jobsearch:write")) throw new HttpError(404, "Not found");
  const scoped = await loadScoped(actor, id);
  const why = cleanReason(reason);
  const app = await inTx(async (client) => {
    const row = await transition(scoped.id, "cancelled", actor, { client, reason: why, event: "cancelled", expectFrom: [...PRE_SEND, "failed", "needs_staff", "outcome_unknown"] });
    await cancelQueueItems(client, row.id, `cancelled:${why}`.slice(0, 500));
    await audit(client, actor, "application.cancel", row.candidate_id, row.id, { reason: why });
    return row;
  });
  await logAfter(actor, "jobsearch.application.cancel", app.id, { reason: why });
  return { application: present(app) };
}

// ---------------------------------------------------------------- sharing authorizations (candidate only)

async function candidateOnly(actor, id) {
  const app = await loadScoped(actor, id); // 404 for anyone outside scope
  if (actor.role !== "Candidate") throw new HttpError(403, "Only the candidate can authorize sharing of their documents");
  return app;
}

async function grantSharing({ id, actor, documentId, legitimateNeed }) {
  const scoped = await candidateOnly(actor, id);
  const docId = posInt(documentId);
  if (!docId) throw new HttpError(400, "documentId must be a positive integer");
  const need = cleanReason(legitimateNeed, { required: false });
  if (!need) throw new HttpError(400, "legitimateNeed is required (why the employer needs this document)");
  const row = await inTx(async (client) => {
    const app = await lockApplication(client, scoped.id);
    if (!PRE_SEND.includes(app.status) && !["needs_staff", "failed"].includes(app.status)) throw new HttpError(409, `Application is ${app.status}`);
    const doc = (await client.query("SELECT id, doc_type FROM documents WHERE id = $1 AND candidate_id = $2 AND is_deleted = false", [docId, app.candidate_id])).rows[0];
    if (!doc) throw new HttpError(404, "Not found");
    const ins = (await client.query(
      "INSERT INTO js_sharing_authorizations (candidate_id, document_id, application_id, legitimate_need, granted_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [app.candidate_id, docId, app.id, need, actor.id]
    )).rows[0];
    const detail = { reason: "candidate_authorized_sharing", authorizationId: ins.id, documentId: docId, docType: documentPolicy.sensitiveType(doc.doc_type) || doc.doc_type, legitimateNeed: need };
    await timeline(client, app.id, actor, "sharing_authorized", detail);
    await audit(client, actor, "sharing.grant", app.candidate_id, app.id, detail);
    await event(client, app.candidate_id, "sharing.granted", { applicationId: app.id, documentId: docId, authorizationId: ins.id });
    return ins;
  });
  await logAudit({ userId: actor.id, action: "jobsearch.sharing.grant", tableName: "js_sharing_authorizations", recordId: row.id, newData: { applicationId: row.application_id, documentId: row.document_id } });
  return presentAuthorization(row);
}

/** Revokes; the document leaves any not-yet-sent package and the application returns to 'preparing'. */
async function revokeSharing({ id, actor, authorizationId }) {
  const scoped = await candidateOnly(actor, id);
  const authId = posInt(authorizationId);
  if (!authId) throw new HttpError(404, "Not found");
  const out = await inTx(async (client) => {
    let app = await lockApplication(client, scoped.id);
    const auth = (await client.query("UPDATE js_sharing_authorizations SET revoked_at = now() WHERE id = $1 AND application_id = $2 AND candidate_id = $3 AND revoked_at IS NULL RETURNING *", [authId, app.id, app.candidate_id])).rows[0];
    if (!auth) throw new HttpError(404, "Not found");
    let pulled = 0;
    if (PRE_SEND.includes(app.status) || ["needs_staff", "failed"].includes(app.status)) {
      pulled = (await client.query(
        "UPDATE js_application_documents SET removed_at = now(), removed_reason = 'authorization_revoked' WHERE application_id = $1 AND removed_at IS NULL AND (sharing_authorization_id = $2 OR (document_id = $3 AND sensitive))",
        [app.id, auth.id, auth.document_id]
      )).rowCount;
      if (["ready_for_review", "approved", "queued"].includes(app.status)) {
        await cancelQueueItems(client, app.id, "sharing_authorization_revoked");
        app = await transition(app.id, "preparing", actor, { client, reason: "sharing_authorization_revoked", detail: { authorizationId: auth.id, documentId: auth.document_id } });
      }
    }
    const detail = { reason: "candidate_revoked_sharing", authorizationId: auth.id, documentId: auth.document_id, removedFromPackage: pulled };
    await timeline(client, app.id, actor, "sharing_revoked", detail);
    await audit(client, actor, "sharing.revoke", app.candidate_id, app.id, detail);
    await event(client, app.candidate_id, "sharing.revoked", { applicationId: app.id, documentId: auth.document_id, authorizationId: auth.id });
    return { app, auth, pulled };
  });
  await logAudit({ userId: actor.id, action: "jobsearch.sharing.revoke", tableName: "js_sharing_authorizations", recordId: out.auth.id, newData: { applicationId: out.app.id, removedFromPackage: out.pulled } });
  return { revoked: true, authorizationId: out.auth.id, removedFromPackage: out.pulled, application: present(out.app) };
}

function presentAuthorization(r) {
  return { id: r.id, applicationId: r.application_id, documentId: r.document_id, legitimateNeed: r.legitimate_need, grantedBy: r.granted_by, grantedAt: r.granted_at, revokedAt: r.revoked_at };
}

// ---------------------------------------------------------------- automatic-approval eligibility (label-safety ruling)

const COUNTED_SUBMISSION_STATES = ["queued", "sent", "confirmed_submitted", "outcome_unknown"];

function listsOf(settingsList, rules, key) {
  const out = [];
  if (Array.isArray(settingsList) && settingsList.length) out.push(settingsList);
  for (const r of rules) if (r && Array.isArray(r[key]) && r[key].length) out.push(r[key]);
  return out;
}

function docVersionApproved(entries, row) {
  return entries.some((e) => {
    if (typeof e === "number") return row.cv_file_id === e;
    if (!e || typeof e !== "object") return false;
    const idOk = row.cv_file_id ? Number(e.cvFileId) === row.cv_file_id : row.document_id ? Number(e.documentId) === row.document_id : false;
    if (!idOk) return false;
    if (e.version !== undefined && Number(e.version) !== row.version) return false;
    if (e.sha256 !== undefined && e.sha256 !== row.sha256) return false;
    return true;
  });
}

/**
 * Sends counted against caps in the window: submissions in counted states + approved/queued apps not yet
 * submitted. Rows are stamped by the DB clock while the caller (the scheduler) may pass its own tick clock
 * `now`; the window therefore starts at LEAST(now, DB now()) - interval, the SAME rule as the pre-send
 * guard's cap check. With equal clocks (production) that is the plain rolling window; when the clocks
 * differ (an injected test clock, skew) the window only grows - a cap can count more, never fewer, sends.
 */
async function countRecentSends(c, candidateId, interval, now) {
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : null;
  const r = await c.query(
    `SELECT
       (SELECT count(*) FROM js_submissions s JOIN js_applications a ON a.id = s.application_id
         WHERE a.candidate_id = $1 AND s.status = ANY($2::text[]) AND s.created_at > LEAST(COALESCE($4::timestamptz, now()), now()) - $3::interval)
     + (SELECT count(*) FROM js_applications a
         WHERE a.candidate_id = $1 AND a.status IN ('approved','queued') AND a.updated_at > LEAST(COALESCE($4::timestamptz, now()), now()) - $3::interval
           AND NOT EXISTS (SELECT 1 FROM js_submissions s WHERE s.application_id = a.id)) AS n`,
    [candidateId, COUNTED_SUBMISSION_STATES, interval, at]
  );
  return Number(r.rows[0].n);
}

/**
 * Whether an application may be approved WITHOUT a human (autoApprove; scheduler in Task 12).
 * Deny by default. allowed only when ALL hold:
 *  - mode automatic, settings.admin_approved_by set, >=1 active admin-approved js_automation_rules row
 *    (rule.type absent or 'auto_submit'; typed rules such as 'ack_reply' never authorize submissions);
 *  - status ready_for_review, nothing blocked, stored package still valid, no sensitive document
 *    (never auto-shared), every package document version listed in settings.approved_doc_versions;
 *  - submit consent, not paused/suspended, mode not search_only; job open;
 *  - job inside the admin scope: country in allowed_countries (required) and in every rule's
 *    countries[], in the consent's countries[] when set, profession/source in their lists when set;
 *    no salary_limit (job salary is not stored structurally, so it cannot be verified);
 *  - caps per day/week (> 0) not reached (0 = no automatic sends);
 *  - label-safety ruling: for a candidate needing work-authorization support applying outside their
 *    country of residence, employer_support === 'confirmed' (no conflict); overseas acceptance === true
 *    whenever the candidate is abroad. Unknown residence/country/support need = the risky case.
 * @param {object|number} application js_applications row or id
 * @param {{client?: object, now?: Date}} [opts] run inside the caller's (locked) transaction; `now` = clock
 *   for the cap windows (the scheduler passes its tick clock; default: the DB clock)
 * @returns {Promise<{allowed: boolean, reasons: string[]}>}
 */
async function autoApproveEligibility(application, opts = {}) {
  const id = typeof application === "object" && application ? application.id : posInt(application);
  const c = opts.client || db();
  const reasons = [];
  const app = id ? (await c.query("SELECT * FROM js_applications WHERE id = $1", [id])).rows[0] : null;
  if (!app) return { allowed: false, reasons: ["application_not_found"] };
  const cid = app.candidate_id;
  const settings = (await c.query("SELECT * FROM js_candidate_settings WHERE candidate_id = $1", [cid])).rows[0] || {};
  const rules = (await c.query("SELECT rule FROM js_automation_rules WHERE candidate_id = $1 AND active = true AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND COALESCE(rule->>'type', 'auto_submit') = 'auto_submit'", [cid])).rows.map((r) => r.rule || {});
  if (settings.mode !== "automatic") reasons.push("mode_not_automatic");
  if (!settings.admin_approved_by) reasons.push("automatic_mode_not_admin_approved");
  if (!rules.length) reasons.push("no_admin_approved_rule");
  if (app.status !== "ready_for_review") reasons.push("status_not_ready_for_review");
  if ((app.package_blocked || []).length) reasons.push("package_blocked");
  reasons.push(...(await sendBlockers(c, cid, "submit")));

  const job = (await c.query("SELECT * FROM js_jobs WHERE id = $1", [app.job_id])).rows[0] || {};
  if (job.status !== "open") reasons.push("job_not_open");
  const jobCountry = job.country ? country(job.country) : null;

  // Admin-approved scope.
  const countryLists = listsOf(settings.allowed_countries, rules, "countries");
  if (!countryLists.length) reasons.push("country_scope_missing");
  else if (!jobCountry || !countryLists.every((l) => l.map(country).includes(jobCountry))) reasons.push("country_not_allowed");
  const consent = await consentService.activeConsent(cid, "submit", c);
  const consentCountries = (consent && consent.scope && consent.scope.countries) || [];
  if (consentCountries.length && (!jobCountry || !consentCountries.map(country).includes(jobCountry))) reasons.push("country_outside_consent");
  const profLists = listsOf(settings.allowed_professions, rules, "professions");
  if (profLists.length) {
    const title = ` ${normalize(job.title)} `;
    if (!profLists.every((l) => l.some((p) => normalize(p) && title.includes(` ${normalize(p)} `)))) reasons.push("profession_not_allowed");
  }
  const sourceLists = listsOf(settings.allowed_sources, rules, "sources");
  if (sourceLists.length) {
    const keys = new Set([job.source_primary, ...(await c.query("SELECT src.key FROM js_job_sightings s JOIN js_sources src ON src.id = s.source_id WHERE s.job_id = $1", [app.job_id])).rows.map((r) => r.key)].filter(Boolean));
    if (!sourceLists.every((l) => l.some((k) => keys.has(k)))) reasons.push("source_not_allowed");
  }
  // Employer scope of a rule (Task 18, POST /jobsearch/automation-rules employerIds): every rule that names
  // employers must name this job's employer.
  const empLists = rules.map((r) => (Array.isArray(r.employerIds) ? r.employerIds.map(Number).filter(Number.isSafeInteger) : [])).filter((l) => l.length);
  if (empLists.length && !(job.employer_id && empLists.every((l) => l.includes(Number(job.employer_id))))) reasons.push("employer_not_allowed");
  if (settings.salary_limit !== null && settings.salary_limit !== undefined) reasons.push("salary_unverifiable");

  // Package: still valid, nothing sensitive, every version admin-approved.
  const problems = await documentPolicy.revalidateStoredPackage(c, app);
  if (problems.length) reasons.push(...problems.map((p) => `package_invalid:${p.code}`));
  const rows = (await c.query("SELECT * FROM js_application_documents WHERE application_id = $1 AND removed_at IS NULL", [app.id])).rows;
  if (rows.some((r) => r.sensitive)) reasons.push("sensitive_document_never_auto_shared");
  const approvedDocs = Array.isArray(settings.approved_doc_versions) ? settings.approved_doc_versions : [];
  if (!approvedDocs.length) reasons.push("no_admin_approved_documents");
  else if (rows.some((r) => !docVersionApproved(approvedDocs, r))) reasons.push("document_version_not_admin_approved");

  // Caps (0 = no automatic sends).
  if (!(settings.cap_per_day > 0) || !(settings.cap_per_week > 0)) reasons.push("cap_not_set");
  else {
    if ((await countRecentSends(c, cid, "1 day", opts.now)) >= settings.cap_per_day) reasons.push("cap_per_day_exceeded");
    if ((await countRecentSends(c, cid, "7 days", opts.now)) >= settings.cap_per_week) reasons.push("cap_per_week_exceeded");
  }

  // Label-safety ruling.
  const prefs = (await c.query("SELECT residence_country, needs_work_auth_support FROM js_preferences WHERE candidate_id = $1", [cid])).rows[0] || {};
  const match = (await c.query("SELECT employer_support, employer_support_conflict, overseas_accepted FROM js_matches WHERE candidate_id = $1 AND job_id = $2", [cid, app.job_id])).rows[0];
  const residence = prefs.residence_country ? country(prefs.residence_country) : null;
  const abroad = !residence || !jobCountry || residence !== jobCountry;
  const needsSupport = prefs.needs_work_auth_support !== false;
  if (!match) reasons.push("no_match_record");
  else if (abroad) {
    if (needsSupport) {
      if (match.employer_support !== "confirmed") reasons.push("employer_support_not_confirmed");
      if (match.employer_support === "unavailable") reasons.push("employer_support_unavailable");
      if (match.employer_support_conflict) reasons.push("employer_support_conflict");
    }
    if (match.overseas_accepted !== true) reasons.push("overseas_acceptance_not_confirmed");
  }
  const uniq = [...new Set(reasons)];
  return { allowed: uniq.length === 0, reasons: uniq };
}

/**
 * The ONLY non-human path to 'approved'. One transaction: candidate lock, application lock,
 * autoApproveEligibility (incl. package re-validation and job-open check) on the locked state, then
 * ready_for_review -> approved with actor 'system:auto'. A refusal is audited and changes nothing else.
 * @returns {Promise<{approved: boolean, reasons: string[], application: object}>}
 */
async function autoApprove(applicationId, opts = {}) {
  const id = posInt(applicationId);
  if (!id) throw new HttpError(404, "Not found");
  const run = async (client) => {
    const app = await lockApplication(client, id);
    const elig = await autoApproveEligibility(app, { client, now: opts.now });
    if (!elig.allowed) {
      await audit(client, "system:auto", "application.auto_approve_refused", app.candidate_id, app.id, { reasons: elig.reasons });
      return { approved: false, reasons: elig.reasons, application: present(app) };
    }
    const row = await transition(app.id, "approved", "system:auto", { client, reason: "auto_approved_within_admin_rules", expectFrom: ["ready_for_review"], [SYSTEM_GRANT]: true });
    await client.query("UPDATE js_application_documents SET approved_at = now() WHERE application_id = $1 AND removed_at IS NULL", [app.id]);
    await audit(client, "system:auto", "application.auto_approve", app.candidate_id, app.id, { reason: "auto_approved_within_admin_rules" });
    await event(client, app.candidate_id, "application.approved", { applicationId: app.id, auto: true });
    return { approved: true, reasons: [], application: present(row) };
  };
  return opts.client ? run(opts.client) : inTx(run);
}

// ---------------------------------------------------------------- CV approval

/**
 * Marks one CV version approved for sending (metadata only; the stored bytes are never touched).
 * The candidate approves their own versions. Staff with jobsearch:approve (Manager/Admin/SuperAdmin) may
 * approve on the candidate's behalf ONLY with a recorded note (>= 10 characters: who asked, when, how),
 * which is stored in the audit trail.
 */
async function approveCvVersion({ user, cvFileId, language, note }) {
  const id = posInt(cvFileId);
  if (!id || !canUse(user, "jobsearch:read")) throw new HttpError(404, "Not found");
  const lang = documentPolicy.normLang(language);
  if (!lang) throw new HttpError(400, "language must be a 2-letter code such as en, fr or ar");
  const { clause, params } = candidateScopeSql(user, "c", 1);
  const cv = (await db().query(
    `SELECT f.id, f.candidate_id, f.scan_status FROM js_cv_files f JOIN candidates c ON c.id = f.candidate_id
      WHERE f.id = $1 AND c.is_deleted = false AND ${clause}`,
    [id, ...params]
  )).rows[0];
  if (!cv) throw new HttpError(404, "Not found");
  if (user.role !== "Candidate" && !hasPerm(user, "jobsearch:approve")) throw new HttpError(403, "Approving a CV version requires the candidate, a manager or an administrator");
  const onBehalf = user.role !== "Candidate";
  let why = null;
  if (onBehalf) {
    why = typeof note === "string" ? cleanReason(note, { required: false }) : null;
    if (!why || why.length < 10) throw new HttpError(400, "note is required (at least 10 characters) when staff approve a CV version on the candidate's behalf");
  }
  if (cv.scan_status === "infected") throw new HttpError(409, "Infected files cannot be approved");
  const row = await inTx(async (client) => {
    await client.query("SELECT id FROM candidates WHERE id = $1 FOR UPDATE", [cv.candidate_id]);
    const r = (await client.query("UPDATE js_cv_files SET approved = true, language = $2 WHERE id = $1 RETURNING id, candidate_id, version, language, approved, sha256", [id, lang])).rows[0];
    await audit(client, user, "cv.approve", cv.candidate_id, null, { cvFileId: id, version: r.version, language: lang, sha256: r.sha256, ...(onBehalf ? { onBehalf: true, note: why } : {}) });
    await event(client, cv.candidate_id, "cv.approved", { cvFileId: id, version: r.version, language: lang });
    return r;
  });
  await logAudit({ userId: user.id, action: "jobsearch.cv.approve", tableName: "js_cv_files", recordId: id, newData: { language: lang, ...(onBehalf ? { onBehalf: true } : {}) } });
  return { id: row.id, candidateId: row.candidate_id, version: row.version, language: row.language, approved: row.approved, ...(onBehalf ? { sha256: row.sha256, onBehalf: true } : {}) };
}

// ---------------------------------------------------------------- list / detail

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function parseFilters(q) {
  const f = {};
  const int = (k) => {
    if (q[k] === undefined || q[k] === "") return;
    const v = posInt(q[k]);
    if (!v) throw new HttpError(400, `${k} must be a positive integer`);
    f[k] = v;
  };
  ["candidateId", "staffId", "employerId"].forEach(int);
  for (const k of ["country", "profession", "sourceKey"]) {
    if (q[k] === undefined || q[k] === "") continue;
    if (typeof q[k] !== "string" || q[k].length > 100) throw new HttpError(400, `${k} must be a short string`);
    f[k] = q[k].trim();
  }
  if (q.status !== undefined && q.status !== "") {
    if (!STATUSES.includes(q.status)) throw new HttpError(400, "status is not valid");
    f.status = q.status;
  }
  for (const k of ["from", "to"]) {
    if (q[k] === undefined || q[k] === "") continue;
    if (typeof q[k] !== "string" || !DATE_RE.test(q[k]) || Number.isNaN(Date.parse(q[k]))) throw new HttpError(400, `${k} must be an ISO date`);
    f[k] = new Date(q[k]);
  }
  const page = q.page === undefined ? 1 : Number(q.page);
  const pageSize = q.pageSize === undefined ? 25 : Number(q.pageSize);
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new HttpError(400, "page must be between 1 and 10000");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new HttpError(400, "pageSize must be between 1 and 100");
  return { f, page, pageSize };
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

async function listApplications({ user, query = {} }) {
  if (!user || (user.role !== "Candidate" && !hasPerm(user, "jobsearch:read"))) throw new HttpError(403, "Access denied");
  const { f, page, pageSize } = parseFilters(query);
  const { clause, params } = candidateScopeSql(user, "c", 0);
  const where = ["c.is_deleted = false", clause];
  const p = [...params];
  const add = (sql, v) => {
    p.push(v);
    where.push(sql.replace("?", `$${p.length}`));
  };
  if (f.candidateId) add("a.candidate_id = ?", f.candidateId);
  if (f.staffId) add("a.responsible_user_id = ?", f.staffId);
  if (f.employerId) add("j.employer_id = ?", f.employerId);
  if (f.country) add("lower(btrim(j.country)) = lower(?)", f.country);
  if (f.profession) add("j.title ILIKE ?", `%${likeEscape(f.profession)}%`);
  if (f.sourceKey) {
    p.push(f.sourceKey);
    const k = `$${p.length}`;
    where.push(`(j.source_primary = ${k} OR EXISTS (SELECT 1 FROM js_job_sightings s JOIN js_sources src ON src.id = s.source_id WHERE s.job_id = j.id AND src.key = ${k}))`);
  }
  if (f.status) add("a.status = ?", f.status);
  if (f.from) add("a.created_at >= ?", f.from);
  if (f.to) add("a.created_at < ?", f.to);
  const from = `FROM js_applications a JOIN candidates c ON c.id = a.candidate_id JOIN js_jobs j ON j.id = a.job_id LEFT JOIN js_employers e ON e.id = j.employer_id WHERE ${where.join(" AND ")}`;
  const total = (await db().query(`SELECT count(*)::int AS n ${from}`, p)).rows[0].n;
  const rows = (await db().query(
    `SELECT a.*, c.full_name AS candidate_name, j.title, j.country, j.location, j.source_primary, j.employer_id, e.name AS employer_name ${from}
      ORDER BY a.created_at DESC, a.id DESC LIMIT $${p.length + 1} OFFSET $${p.length + 2}`,
    [...p, pageSize, (page - 1) * pageSize]
  )).rows;
  return {
    applications: rows.map((r) => ({
      ...present(r),
      candidateName: r.candidate_name,
      job: { title: r.title, country: r.country, location: r.location, source: r.source_primary },
      employer: { id: r.employer_id, name: r.employer_name },
    })),
    page,
    pageSize,
    total,
  };
}

// Candidates see only neutral timeline fields: never recipients, message ids, provider text, hashes or document lists.
const CANDIDATE_TIMELINE_KEYS = ["from", "to", "status", "reason", "code", "handoff", "kind", "note", "awaiting"];
const SAFE_VALUE = /^[\p{L}\p{N} _.,:;'()-]{0,200}$/u;
function candidateTimelineDetail(detail) {
  if (!detail || typeof detail !== "object") return {};
  const out = {};
  for (const k of CANDIDATE_TIMELINE_KEYS) {
    const v = detail[k];
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && SAFE_VALUE.test(v) && !/@|<|[a-f0-9]{32,}/i.test(v)) out[k] = v;
  }
  return out;
}

async function getApplication({ user, id }) {
  const app = await loadScoped(user, id);
  const c = db();
  const job = (await c.query("SELECT id, title, country, location, url, status, source_primary, employer_id, closing_at FROM js_jobs WHERE id = $1", [app.job_id])).rows[0];
  const employer = job && job.employer_id ? (await c.query("SELECT id, name, domain FROM js_employers WHERE id = $1", [job.employer_id])).rows[0] : null;
  const match = (await c.query("SELECT * FROM js_matches WHERE candidate_id = $1 AND job_id = $2", [app.candidate_id, app.job_id])).rows[0];
  const tl = (await c.query("SELECT id, actor, event, detail, created_at FROM js_timeline WHERE application_id = $1 ORDER BY id", [app.id])).rows;
  const docs = (await c.query(
    `SELECT id, cv_file_id, document_id, doc_type, version, sha256, language, sensitive, sharing_authorization_id, approved_by, approved_at, created_at, removed_at, removed_reason
       FROM js_application_documents WHERE application_id = $1 ORDER BY id`,
    [app.id]
  )).rows;
  const shares = (await c.query("SELECT * FROM js_sharing_authorizations WHERE application_id = $1 ORDER BY id", [app.id])).rows;
  const out = {
    application: { ...present(app), coverLetter: app.cover_letter_text },
    job: job ? { id: job.id, title: job.title, country: job.country, location: job.location, url: job.url, status: job.status, source: job.source_primary, closingAt: job.closing_at } : null,
    employer: employer ? { id: employer.id, name: employer.name, domain: employer.domain } : null,
    match: match
      ? {
          id: match.id,
          score: match.score,
          reasons: match.reasons,
          missing: match.missing,
          uncertain: match.uncertain,
          employerSupport: { label: match.employer_support, evidence: match.employer_support_evidence, ...(match.employer_support_conflict ? { conflict: true } : {}), notice: LABEL_NOTICE },
          overseas: { accepted: match.overseas_accepted, evidence: match.overseas_applicants_evidence },
        }
      : null,
    notice: NOTICE,
    timeline: tl.map((e) => ({ id: e.id, actor: e.actor, event: e.event, detail: user.role === "Candidate" ? candidateTimelineDetail(e.detail) : e.detail, at: e.created_at })),
    // Candidates see which documents/versions are in their package, not hashes or which staff member approved.
    documents: docs.map((d) => ({
      id: d.id,
      kind: d.cv_file_id ? "cv" : "document",
      cvFileId: d.cv_file_id,
      documentId: d.document_id,
      docType: d.doc_type,
      version: d.version,
      ...(user.role === "Candidate" ? {} : { sha256: d.sha256 }),
      language: d.language,
      sensitive: d.sensitive,
      sharingAuthorizationId: d.sharing_authorization_id,
      ...(user.role === "Candidate" ? {} : { approvedBy: d.approved_by }),
      approvedAt: d.approved_at,
      addedAt: d.created_at,
      removedAt: d.removed_at,
      removedReason: d.removed_reason,
    })),
    sharingAuthorizations: shares.map(presentAuthorization),
  };
  if (user.role !== "Candidate") out.autoApproval = await autoApproveEligibility(app);
  return out;
}

module.exports = {
  STATUSES,
  TRANSITIONS,
  LABEL_NOTICE,
  transition,
  createFromMatch,
  prepareApplication,
  approveApplication,
  rejectApplication,
  cancelApplication,
  grantSharing,
  revokeSharing,
  autoApproveEligibility,
  autoApprove,
  _internal: { SYSTEM_GRANT, MANUAL_COMPLETION, SCHEDULER_GRANT, sendBlockers },
  approveCvVersion,
  listApplications,
  getApplication,
  loadScoped,
  isAdmin,
};
