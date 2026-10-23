// Pre-send guard: the single gate in front of every outbound application (spec §7). Run it on every
// attempt, including retries, immediately before the provider call.
//
//   check(applicationId, {client?, now?, recheck?, recipient?})
//     -> {ok: true, recipient, notes, approval} | {ok: false, code, detail, handoff?, notes}
//
// Rules:
//  - READ-ONLY. The guard itself writes nothing (it returns notes instead of writing timeline rows).
//    Without a client it opens its own transaction and always ROLLs BACK. The one write on the path
//    is the default job re-check (jobStore.recheckJobDetailed refreshes js_jobs.status /
//    last_checked_at on its own pool connection); callers must therefore not hold a row lock on that
//    js_jobs row when calling the guard. Tests inject `recheck`.
//  - NEVER CACHES: every call re-reads everything. With `client` every read runs inside the caller's
//    transaction (it sees the caller's uncommitted writes).
//  - LOCK ORDER (binding, same as applicationService): candidate row FOR UPDATE first, then the
//    application row FOR UPDATE. Consent withdrawal / suspension take the same candidate lock, so a
//    caller that runs check() and then marks the item queued in the SAME transaction serialises with
//    them and with other sends of the same candidate (caps). Task 11: BEGIN -> check({client}) ->
//    insert js_submissions 'queued' + transition(...,'queued') -> COMMIT -> check() again right before
//    the provider call. Use result.recipient (normalised) as the address actually sent to.
//  - Checks run in a fixed order; the first failure is returned.
const { PERMISSIONS } = require("../../middleware/role");
const consentService = require("./consentService");
const documentPolicy = require("./documentPolicy");
const jobStore = require("./jobStore");
const { country } = require("./matching");
const { detectHandoff } = require("./handoffDetector");

const db = () => require("../../db");

const GUARD_CODES = Object.freeze([
  "application_not_sendable",
  "candidate_deleted",
  "consent_missing",
  "consent_withdrawn",
  "candidate_paused",
  "module_paused",
  "source_paused",
  "user_suspended",
  "mode_disallows",
  "label_requires_human",
  "job_closed",
  "duplicate_submission",
  "duplicate",
  "missing_fields",
  "document_unapproved",
  "sensitive_unauthorized",
  "package_changed",
  "attachment_unscanned",
  "cap_exceeded",
  "recipient_unverified",
  "handoff_required",
]);
const HANDOFF_REASONS = Object.freeze(["staff_review", "unsupported_channel", "captcha", "payment", "login", "legal_declaration", "custom_questions"]);

const SENDABLE = ["approved", "queued"];
// An OTHER application in one of these states (or with a counted submission) was already sent / is being sent.
// 'needs_staff' counts (staff may be finishing it by hand); an OTHER 'approved' one counts when it is older
// (lower id): of two approved duplicates exactly one - the older - may go.
const IN_FLIGHT_APP = ["queued", "sent", "confirmed_submitted", "outcome_unknown", "interview", "offer", "rejected", "needs_staff"];
const COUNTED_SUBMISSIONS = ["queued", "sent", "confirmed_submitted", "outcome_unknown"];
const PRIOR_SUBMISSIONS = ["sent", "confirmed_submitted", "outcome_unknown"];
const DUPLICATE_WINDOW_DAYS = 90;

// autoApproveEligibility reasons the guard handles itself (at send time the status is approved/queued,
// caps are counted excluding this application, documents/job are checked by their own steps).
const ELIGIBILITY_HANDLED_HERE = new Set(["status_not_ready_for_review", "cap_not_set", "cap_per_day_exceeded", "cap_per_week_exceeded", "job_not_open", "package_blocked"]);
const LABEL_REASONS = new Set(["employer_support_not_confirmed", "employer_support_unavailable", "employer_support_conflict", "overseas_acceptance_not_confirmed"]);

const posInt = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

// ---------------------------------------------------------------- recipient verification

const FREE_MAIL_LABELS = new Set(["gmail", "googlemail", "outlook", "hotmail", "live", "msn", "yahoo", "ymail", "rocketmail", "icloud", "proton", "protonmail", "aol", "gmx", "yandex"]);
const FREE_MAIL_DOMAINS = new Set([
  "mail.com", "mail.ru", "inbox.ru", "bk.ru", "list.ru", "rambler.ru", "pm.me", "me.com", "mac.com", "web.de", "t-online.de",
  "laposte.net", "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "libero.it", "qq.com", "163.com", "126.com", "yeah.net",
  "tutanota.com", "tuta.io", "fastmail.com", "hushmail.com", "zoho.com", "zohomail.com",
]);
const LOCAL_RE = /^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*$/; // no %, !, quotes, comments or routing
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const EMAIL_IN_TEXT_RE = /[a-z0-9._+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g;

function validDomain(d) {
  if (typeof d !== "string" || !d || d.length > 253) return false;
  const labels = d.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL_RE.test(l)) && TLD_RE.test(labels[labels.length - 1]);
}

/**
 * NFKC, trim, lower-case; then a strict plain-address shape (ASCII only, exactly one '@', dotted
 * local part without routing characters, LDH domain labels with an alphabetic or xn-- TLD).
 * Display names, lists, IP literals, IDN (non-ASCII) and anything with spaces/controls -> null.
 */
function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFKC").trim().toLowerCase();
  if (!s || s.length > 254 || !/^[\x21-\x7e]+$/.test(s)) return null;
  const parts = s.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !LOCAL_RE.test(local) || !validDomain(domain)) return null;
  return `${local}@${domain}`;
}

/** Employer domain as stored ("Employer.com", "https://www.employer.com/careers", "www.employer.com.") -> "employer.com". */
function normalizeDomain(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.normalize("NFKC").trim().toLowerCase();
  if (!s) return null;
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  s = s.split("/")[0].replace(/\.+$/, "");
  if (s.startsWith("www.")) s = s.slice(4);
  return validDomain(s) ? s : null;
}

function isFreeMail(domain) {
  if (FREE_MAIL_DOMAINS.has(domain)) return true;
  return domain.split(".").slice(0, -1).some((l) => FREE_MAIL_LABELS.has(l));
}

/** Addresses the posting itself names (job.application_email when present + addresses in the ad text). */
function postedAddresses(job) {
  if (!job) return [];
  const out = new Set();
  for (const v of [job.application_email, job.contact_email]) {
    const a = normalizeEmail(v);
    if (a) out.add(a);
  }
  const text = typeof job.description_text === "string" ? job.description_text.slice(0, 20000).normalize("NFKC").toLowerCase() : "";
  for (const m of text.match(EMAIL_IN_TEXT_RE) || []) {
    const a = normalizeEmail(m.replace(/^[.]+/, ""));
    if (a) out.add(a);
  }
  return [...out];
}

/**
 * True when `email` may receive this application:
 *  - it is EXACTLY an address the job posting names, or the employer's staff-verified contact
 *    address (this is the only way a free-mail or subdomain address is accepted); or
 *  - its domain EQUALS the employer's stored domain (subdomains, lookalikes, suffix tricks such as
 *    employer.com.evil.com / evil-employer.com / employer.com@evil.com are rejected), and neither the
 *    address domain nor the employer domain is a free-mail provider.
 * @param {{domain?: string, verified_contact_email?: string}|null} employer
 * @param {string} email
 * @param {{description_text?: string, application_email?: string}} [job]
 */
function verifyRecipient(employer, email, job) {
  const addr = normalizeEmail(email);
  if (!addr) return false;
  const exact = new Set(postedAddresses(job));
  const verified = employer ? normalizeEmail(employer.verified_contact_email) : null;
  if (verified) exact.add(verified);
  if (exact.has(addr)) return true;
  const domain = addr.slice(addr.indexOf("@") + 1);
  if (isFreeMail(domain)) return false;
  const employerDomain = employer ? normalizeDomain(employer.domain) : null;
  if (!employerDomain || isFreeMail(employerDomain)) return false;
  return domain === employerDomain;
}

// ---------------------------------------------------------------- handoff detection
// Lives in ./handoffDetector (conservative, biased toward false positives); re-exported here.

// ---------------------------------------------------------------- helpers

function hasPerm(role, perm) {
  const perms = PERMISSIONS[role] || [];
  return perms.includes("*") || perms.includes(perm);
}

/** The approval that put the application into 'approved' (latest status_changed -> approved). */
async function approvalOf(client, applicationId) {
  const row = (await client.query(
    "SELECT actor FROM js_timeline WHERE application_id = $1 AND event = 'status_changed' AND detail->>'to' = 'approved' ORDER BY id DESC LIMIT 1",
    [applicationId]
  )).rows[0];
  if (!row) return null;
  const actor = String(row.actor || "");
  const m = /^staff:(\d{1,9})$/.exec(actor);
  if (!m) return { actor, human: false, staff: false };
  const u = (await client.query("SELECT id, role, is_active FROM users WHERE id = $1", [Number(m[1])])).rows[0];
  const valid = Boolean(u && u.is_active && u.role !== "Candidate" && hasPerm(u.role, "jobsearch:approve"));
  return { actor, human: valid, staff: true, userId: Number(m[1]) };
}

async function runRecheck(fn, jobId, now) {
  try {
    const r = await fn(jobId, { now });
    if (typeof r === "string") return { status: r, verified: true };
    if (r && typeof r === "object" && typeof r.status === "string") return { status: r.status, verified: r.verified === true, reason: r.reason };
    return { status: null, verified: false, reason: "recheck_returned_nothing" };
  } catch (err) {
    return { status: null, verified: false, reason: `recheck_failed:${String((err && err.message) || err).slice(0, 100)}` };
  }
}

function employerOf(job) {
  return job && job.e_id ? { domain: job.e_domain, verified_contact_email: job.e_contact } : null;
}

/**
 * The address a send would use, and where it came from: opts.recipient ('opts'), the employer's
 * staff-verified contact ('verified_contact'), else the single address the posting names
 * ('employer_domain' when at the employer's staff-set domain, otherwise 'posted_in_ad'). When the
 * posting names several, the single one at the employer domain wins; otherwise ambiguous.
 */
function pickRecipient(job, optsRecipient) {
  const employer = employerOf(job);
  const empDomain = employer ? normalizeDomain(employer.domain) : null;
  const verified = employer ? normalizeEmail(employer.verified_contact_email) : null;
  const atEmployer = (a) => Boolean(a && empDomain && !isFreeMail(empDomain) && a.slice(a.indexOf("@") + 1) === empDomain);
  const out = (recipient, source, extra = {}) => ({ recipient, source, domainMatchesEmployer: atEmployer(recipient), verifiedContact: Boolean(recipient && verified && recipient === verified), ...extra });
  if (optsRecipient !== undefined && optsRecipient !== null) return out(normalizeEmail(optsRecipient), "opts");
  if (verified) return out(verified, "verified_contact");
  const posted = postedAddresses(job);
  if (posted.length === 1) return out(posted[0], atEmployer(posted[0]) ? "employer_domain" : "posted_in_ad");
  const mine = posted.filter(atEmployer);
  if (mine.length === 1) return out(mine[0], "employer_domain");
  return out(null, null, { ambiguous: posted.length > 1 });
}

const JOB_WITH_EMPLOYER_SQL = `SELECT j.*, e.id AS e_id, e.name AS e_name, e.domain AS e_domain, e.verified_contact_email AS e_contact
       FROM js_jobs j LEFT JOIN js_employers e ON e.id = j.employer_id WHERE j.id = $1`;

/**
 * Read-only: which address a send of this application would go to, so T9/T11/UI can show it to the
 * human approver. null for an unknown application.
 * @returns {Promise<{recipient: string|null, source: 'opts'|'verified_contact'|'employer_domain'|'posted_in_ad'|null, domainMatchesEmployer: boolean, verifiedContact: boolean, ambiguous?: boolean}|null>}
 */
async function resolveRecipient(applicationId, opts = {}) {
  const id = posInt(applicationId);
  if (!id) return null;
  const c = opts.client || db();
  const app = (await c.query("SELECT job_id FROM js_applications WHERE id = $1", [id])).rows[0];
  if (!app) return null;
  const job = (await c.query(JOB_WITH_EMPLOYER_SQL, [app.job_id])).rows[0];
  if (!job) return { recipient: null, source: null, domainMatchesEmployer: false, verifiedContact: false };
  return pickRecipient(job, opts.recipient);
}

const canonSet = (urls) => new Set(urls.map((u) => jobStore.canonicalUrl(u)).filter(Boolean));

// ---------------------------------------------------------------- the guard

/**
 * @param {number|string} applicationId
 * @param {{client?: object, now?: Date, recheck?: Function, recipient?: string}} [opts]
 *   client    caller's transaction (recommended: the same one that marks the item queued)
 *   now       clock for closing dates, cap windows and the duplicate window (default: new Date())
 *   recheck   (jobId, {now}) -> 'open'|'closed'|'expired' | {status, verified}; default jobStore.recheckJobDetailed
 *   recipient the address the submitter intends to use; default employer's verified contact, else
 *             the single address named in the posting
 */
async function check(applicationId, opts = {}) {
  const id = posInt(applicationId);
  if (!id) return fail([], "application_not_sendable", "Unknown application");
  const now = opts.now instanceof Date && !Number.isNaN(opts.now.getTime()) ? opts.now : new Date();
  // Unlocked pre-read only to know which job to re-check; the locked re-read below is authoritative.
  const pre = (await (opts.client || db()).query("SELECT job_id FROM js_applications WHERE id = $1", [id])).rows[0];
  if (!pre) return fail([], "application_not_sendable", "Unknown application");
  // Network re-check happens before any lock is taken by the guard itself.
  const recheck = await runRecheck(opts.recheck || jobStore.recheckJobDetailed, pre.job_id, now);
  if (opts.client) return evaluate(opts.client, id, now, recheck, opts);
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    return await evaluate(client, id, now, recheck, opts);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

function fail(notes, code, detail, handoff) {
  const out = { ok: false, code, detail, notes };
  if (handoff) out.handoff = handoff;
  return out;
}

async function evaluate(client, id, now, recheck, opts) {
  const notes = [];
  const q = (sql, params) => client.query(sql, params);

  // 1. Locks (candidate first, then application) + sendable status.
  const head = (await q("SELECT candidate_id FROM js_applications WHERE id = $1", [id])).rows[0];
  if (!head) return fail(notes, "application_not_sendable", "Unknown application");
  const cid = head.candidate_id;
  const cand = (await q("SELECT id, is_deleted FROM candidates WHERE id = $1 FOR UPDATE", [cid])).rows[0];
  const app = (await q("SELECT * FROM js_applications WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!app || app.candidate_id !== cid) return fail(notes, "application_not_sendable", "Application changed concurrently");
  if (!SENDABLE.includes(app.status)) return fail(notes, "application_not_sendable", `Application is ${app.status}; only approved or queued applications may be sent`);

  // 2. Candidate.
  if (!cand || cand.is_deleted) return fail(notes, "candidate_deleted", "The candidate record is deleted");

  const job = (await q(JOB_WITH_EMPLOYER_SQL, [app.job_id])).rows[0];
  const jobCountry = job && job.country ? country(job.country) : null;

  // 3. Consent (active, submit scope, countries).
  const consent = await consentService.activeConsent(cid, "submit", client);
  if (!consent) {
    const hist = (await q(
      "SELECT 1 FROM js_consents WHERE candidate_id = $1 AND (scope->>'submit' = 'true' OR (scope->'withdrawn') ? 'submit') LIMIT 1",
      [cid]
    )).rowCount;
    return hist
      ? fail(notes, "consent_withdrawn", "The candidate withdrew consent to submit applications")
      : fail(notes, "consent_missing", "No active consent to submit applications");
  }
  const consentCountries = (consent.scope && Array.isArray(consent.scope.countries) ? consent.scope.countries : []).map(country);
  if (consentCountries.length && (!jobCountry || !consentCountries.includes(jobCountry))) {
    return fail(notes, "consent_missing", `The job country (${job && job.country ? job.country : "unknown"}) is outside the consented countries`);
  }

  // 4-7. Pauses and suspension.
  const settings = (await q("SELECT * FROM js_candidate_settings WHERE candidate_id = $1", [cid])).rows[0] || null;
  if (settings && settings.paused) return fail(notes, "candidate_paused", "The candidate is paused");
  const mod = (await q("SELECT value FROM js_module_state WHERE key = 'module_paused'")).rows[0];
  if (mod && mod.value && mod.value.paused === true) return fail(notes, "module_paused", "The job-search module is paused");
  const srcs = (await q(
    `SELECT src.key, src.paused FROM js_job_sightings s JOIN js_sources src ON src.id = s.source_id WHERE s.job_id = $1
     UNION ALL SELECT key, paused FROM js_sources WHERE key = $2`,
    [app.job_id, job ? job.source_primary : null]
  )).rows;
  if (srcs.length && srcs.every((s) => s.paused)) return fail(notes, "source_paused", `Every source of this job is paused (${[...new Set(srcs.map((s) => s.key))].join(", ")})`);
  const accounts = (await q("SELECT u.is_active FROM js_candidate_accounts a JOIN users u ON u.id = a.user_id WHERE a.candidate_id = $1", [cid])).rows;
  if (accounts.some((u) => !u.is_active)) return fail(notes, "user_suspended", "The candidate's account is suspended");

  // 8. Mode + approval (+ label-safety ruling for system approvals).
  const mode = (settings && settings.mode) || "search_only";
  if (mode === "search_only") return fail(notes, "mode_disallows", "Mode search_only never sends applications");
  const approval = await approvalOf(client, app.id);
  if (!approval) return fail(notes, "mode_disallows", "No approval record for this application");
  if (approval.staff && !approval.human) return fail(notes, "mode_disallows", `The approver (${approval.actor}) no longer exists or is no longer authorized to approve`);
  if (!approval.human) {
    if (mode !== "automatic") return fail(notes, "mode_disallows", `Mode ${mode} requires approval by an authorized person; this application was approved by ${approval.actor}`);
    if (approval.actor !== "system:auto") return fail(notes, "mode_disallows", `Unrecognised approval actor ${approval.actor}`);
    const { autoApproveEligibility } = require("./applicationService");
    const elig = await autoApproveEligibility(app, { client });
    const open = elig.reasons.filter((r) => !ELIGIBILITY_HANDLED_HERE.has(r) && !r.startsWith("package_invalid:"));
    const other = open.filter((r) => !LABEL_REASONS.has(r));
    if (other.length) return fail(notes, "mode_disallows", `Automatic sending is no longer within the admin-approved rules: ${other.join(", ")}`);
    if (open.length) return fail(notes, "label_requires_human", `Automatic sending needs a human approval: ${open.join(", ")} (employer-support labels are informational)`);
  }

  // 9. Job still open (re-fetched).
  if (!job) return fail(notes, "job_closed", "The job no longer exists");
  if (!recheck.verified) notes.push("job_status_unverified");
  if (job.closing_at && new Date(job.closing_at).getTime() <= now.getTime()) return fail(notes, "job_closed", "The closing date has passed");
  if (recheck.status && recheck.status !== "open") return fail(notes, "job_closed", `Re-check reports the job ${recheck.status}`);
  if (job.status !== "open") return fail(notes, "job_closed", `The job is ${job.status}`);

  // 10. Duplicates: earlier attempts of THIS application, then other applications for the same vacancy.
  const prior = (await q("SELECT id, status FROM js_submissions WHERE application_id = $1 AND status = ANY($2::text[]) ORDER BY id", [app.id, PRIOR_SUBMISSIONS])).rows;
  if (prior.length) {
    const unknown = prior.find((s) => s.status === "outcome_unknown");
    return fail(
      notes,
      "duplicate_submission",
      unknown
        ? `Submission ${unknown.id} has an unknown outcome; it may have been delivered and is never retried automatically`
        : `Submission ${prior[0].id} was already ${prior[0].status}`,
      "staff_review"
    );
  }
  const ownQueued = (await q("SELECT count(*)::int AS n FROM js_submissions WHERE application_id = $1 AND status = 'queued'", [app.id])).rows[0].n;
  if (ownQueued > 1) return fail(notes, "duplicate_submission", `This application has ${ownQueued} queued submission attempts; only one may exist`, "staff_review");
  const dup = await findDuplicate(client, app, job, now);
  if (dup) return fail(notes, "duplicate", dup);

  // 11. Required fields (confirmed profile + cover letter).
  const profile = (await q("SELECT confirmed, status FROM js_profiles WHERE candidate_id = $1", [cid])).rows[0];
  const missing = [];
  if (!profile || profile.status !== "confirmed") missing.push("confirmed_profile");
  else {
    const c = profile.confirmed || {};
    if (!nonEmpty(c.name)) missing.push("name");
    if (!nonEmpty(c.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email.trim())) missing.push("email");
    if (!nonEmpty(c.profession)) missing.push("profession");
    const count = (v) => (Array.isArray(v) ? v.filter((x) => (typeof x === "string" ? x.trim() : x && typeof x === "object")).length : 0);
    if (!count(c.languages) && !count(c.experience)) missing.push("language_or_experience");
  }
  if (!nonEmpty(app.cover_letter_text)) missing.push("cover_letter");
  if (missing.length) return fail(notes, "missing_fields", `Missing required fields: ${missing.join(", ")}`);

  // 12. Documents: the stored package must still be exactly what was approved.
  const docProblems = [];
  if ((app.package_blocked || []).length) docProblems.push({ code: "package_has_blocked_documents" });
  docProblems.push(...(await documentPolicy.revalidateStoredPackage(client, app)));
  const unapprovedRows = (await q("SELECT id FROM js_application_documents WHERE application_id = $1 AND removed_at IS NULL AND approved_at IS NULL", [app.id])).rowCount;
  if (unapprovedRows) docProblems.push({ code: "package_document_not_approved" });
  if (docProblems.length) {
    const detail = `Package problems: ${documentPolicy.formatProblems(docProblems)}`;
    const codes = new Set(docProblems.map((p) => p.code));
    if (codes.has("sensitive_unauthorized")) return fail(notes, "sensitive_unauthorized", detail);
    if (["cv_changed", "cv_bytes_changed", "document_changed", "document_deleted", "cv_infected"].some((c) => codes.has(c))) return fail(notes, "package_changed", detail);
    if (codes.has("attachment_unscanned")) return fail(notes, "attachment_unscanned", `${detail} (no malware scan; set ALLOW_UNSCANNED_ATTACHMENTS=true only if you accept unscanned files)`);
    return fail(notes, "document_unapproved", detail); // cv_not_approved, cv_missing, no_cv_in_package, unknown codes
  }

  // 13. Caps (other applications' submissions in the rolling windows; cap 0 = no sends). Rows carry DB-clock
  // stamps while `now` may be an injected clock: the window starts at LEAST(now, DB now()) - span, so clock
  // skew can only make a cap count MORE sends (same rule as applicationService.countRecentSends).
  const counts = (await q(
    `SELECT count(*) FILTER (WHERE COALESCE(s.sent_at, s.created_at) > LEAST($3::timestamptz, now()) - interval '1 day')::int AS day,
            count(*) FILTER (WHERE COALESCE(s.sent_at, s.created_at) > LEAST($3::timestamptz, now()) - interval '7 days')::int AS week
       FROM js_submissions s JOIN js_applications a ON a.id = s.application_id
      WHERE a.candidate_id = $1 AND s.application_id <> $2 AND s.status = ANY($4::text[])`,
    [cid, app.id, now, COUNTED_SUBMISSIONS]
  )).rows[0];
  for (const [label, cap, used, span] of [["day", settings.cap_per_day, counts.day, "24 hours"], ["week", settings.cap_per_week, counts.week, "7 days"]]) {
    if (cap === null || cap === undefined) {
      // DORMANT: cap_per_day / cap_per_week are NOT NULL DEFAULT 0 today; kept for a future nullable schema.
      if (!approval.human) return fail(notes, "cap_exceeded", `No cap_per_${label} set: automatic sends need explicit caps`);
      continue; // unlimited only for human-approved applications
    }
    if (!(cap > 0)) return fail(notes, "cap_exceeded", `cap_per_${label} is 0: no sends allowed`);
    if (used >= cap) return fail(notes, "cap_exceeded", `cap_per_${label} ${cap} reached (${used} in the last ${span})`);
  }

  // 14. Recipient. Human approval: the posting's own address is acceptable (the approver sees it via
  // resolveRecipient). System approval: ONLY the staff-verified contact or an address at the
  // staff-set employer domain - ad text is untrusted and must not choose where an automatic send goes.
  const channel = nonEmpty(app.channel) ? app.channel.trim().toLowerCase() : "email";
  if (channel !== "email") return fail(notes, "recipient_unverified", `Channel ${channel} is not supported for automatic sending`, "unsupported_channel");
  const employer = employerOf(job);
  const target = pickRecipient(job, opts.recipient);
  if (!target.recipient) {
    if (target.source === "opts") return fail(notes, "recipient_unverified", "The recipient is not a valid plain email address");
    return fail(notes, "recipient_unverified", target.ambiguous ? "The posting names several addresses; staff must choose" : "No recipient address for this application", "unsupported_channel");
  }
  if (!approval.human) {
    if (!target.verifiedContact && !target.domainMatchesEmployer) {
      return fail(notes, "recipient_unverified", `Automatic sending only goes to the employer's verified contact or an address at the employer's verified domain; ${target.recipient} (${target.source}) needs a human`, "staff_review");
    }
  } else if (!verifyRecipient(employer, target.recipient, job)) {
    return fail(notes, "recipient_unverified", "The recipient is not the employer's domain nor an address named in the posting");
  }
  const recipient = target.recipient;

  // 15. Handoff-only postings (captcha, payment, legal declaration, login, online-only, custom questions).
  const prefs = (await q("SELECT salary_min, availability, residence_country FROM js_preferences WHERE candidate_id = $1", [cid])).rows[0] || {};
  const handoff = detectHandoff(job, prefs);
  if (handoff) return fail(notes, "handoff_required", `The posting requires a human step (${handoff.reason}; ${handoff.source})`, handoff.reason);

  return { ok: true, recipient, recipientSource: target.source, domainMatchesEmployer: target.domainMatchesEmployer, notes, approval: { actor: approval.actor, human: approval.human } };
}

/** Another application of this candidate already sent / being sent for the same vacancy, or null. */
async function findDuplicate(client, app, job, now) {
  const others = (await client.query(
    `SELECT a.id, a.status, a.updated_at, j.id AS job_id, j.url, j.title, j.location, e.name AS employer_name,
            (SELECT max(COALESCE(s.sent_at, s.created_at)) FROM js_submissions s WHERE s.application_id = a.id AND s.status = ANY($3::text[])) AS last_sub
       FROM js_applications a JOIN js_jobs j ON j.id = a.job_id LEFT JOIN js_employers e ON e.id = j.employer_id
      WHERE a.candidate_id = $1 AND a.id <> $2
        AND (a.status = ANY($4::text[]) OR (a.status = 'approved' AND a.id < $2) OR EXISTS (SELECT 1 FROM js_submissions s WHERE s.application_id = a.id AND s.status = ANY($3::text[])))
      ORDER BY a.id`,
    [app.candidate_id, app.id, COUNTED_SUBMISSIONS, IN_FLIGHT_APP]
  )).rows;
  if (!others.length) return null;
  const sightings = (await client.query("SELECT job_id, url FROM js_job_sightings WHERE job_id = ANY($1::int[])", [[job.id, ...others.map((o) => o.job_id)]])).rows;
  const urlsOf = (jobId, url) => canonSet([url, ...sightings.filter((s) => s.job_id === jobId).map((s) => s.url)]);
  const mine = urlsOf(job.id, job.url);
  const emp = jobStore.normalizeEmployer(job.e_name || "");
  const title = jobStore.normalize(job.title);
  const city = jobStore.normalizeCity(job.location);
  // Same skew rule as the caps: the rows carry DB-clock stamps, so the window starts at
  // LEAST(injected now, DB now()) - span. A skewed app-server (Node) clock never shortens it.
  const since = new Date((await client.query("SELECT LEAST($1::timestamptz, now()) - make_interval(days => $2) AS since", [now, DUPLICATE_WINDOW_DAYS])).rows[0].since).getTime();
  for (const o of others) {
    if (o.job_id === job.id) return `Application ${o.id} (${o.status}) is for the same job`;
    const theirs = urlsOf(o.job_id, o.url);
    if ([...theirs].some((u) => mine.has(u))) return `Application ${o.id} (${o.status}) is for the same posting URL`;
    const oEmp = jobStore.normalizeEmployer(o.employer_name || "");
    const oCity = jobStore.normalizeCity(o.location);
    const at = new Date(o.last_sub || o.updated_at).getTime();
    if (!title || jobStore.normalize(o.title) !== title || at <= since) continue;
    if (emp && oEmp) {
      if (oEmp === emp && (!city || !oCity || city === oCity)) return `Application ${o.id} (${o.status}) went to the same employer for the same title${city && oCity ? " and city" : ""} within ${DUPLICATE_WINDOW_DAYS} days`;
    } else if (city && oCity && city === oCity) {
      // One side has no employer record: same title + same city within the window is treated as the same vacancy.
      return `Application ${o.id} (${o.status}) has the same title and city (employer unknown on one side) within ${DUPLICATE_WINDOW_DAYS} days`;
    }
  }
  return null;
}

module.exports = { check, resolveRecipient, verifyRecipient, normalizeEmail, normalizeDomain, isFreeMail, postedAddresses, detectHandoff, GUARD_CODES, HANDOFF_REASONS };
