// Vacancy classification (stage 8 task 5). Six classes, derived in code from real signals and stored on js_jobs:
//   closed_unsuitable | work_authorization_required | foreign_applicants_stated | verified_active | eligibility_unclear
//   (prospective_no_vacancy is assigned by staff only and is never derived).
// Rules that never bend:
//  * The ad text is UNTRUSTED data read through bounded, allowlist-style patterns; nothing in it is executed or obeyed.
//  * foreign_applicants_stated never exists without a quoted evidence string (the DB also enforces it). The label it comes from is
//    informational: a quote from an advertisement is NOT proof of an LMIA, of sponsorship or of eligibility (DECISIONS #1).
//  * When unsure the answer is eligibility_unclear. verified_active needs an open, real-looking vacancy that a live (non-manual)
//    connected source returned recently, and no contradiction.
//  * A staff classification (classified_by set) is sticky: no automatic recompute overrides it. Staff clear it with classification null.
const { HttpError } = require("./httpError");
const { PERMISSIONS } = require("../../middleware/role");
const { logAudit } = require("../../utils/audit");
const { detectEmployerSupport, detectOverseas, normalizeAd } = require("./matching/employerSupport");

const db = () => require("../../db");

const CLASSES = Object.freeze(["verified_active", "foreign_applicants_stated", "eligibility_unclear", "work_authorization_required", "prospective_no_vacancy", "closed_unsuitable"]);
const MAX_EVIDENCE = 500;
const MAX_NOTE = 500;
const MIN_EVIDENCE = 8; // a fragment shorter than this is not a quote
const MIN_STAFF_EVIDENCE = 20; // staff evidence for foreign_applicants_stated: at least this many characters ...
const MIN_STAFF_EVIDENCE_WORDS = 4; // ... and this many words, verbatim in the advertisement
const MIN_DESCRIPTION = 60; // an ad shorter than this is not treated as a real, verifiable vacancy
const VERIFIED_WINDOW_DAYS = 14; // a live source must have returned the vacancy within this window
const UNIT_CAP = 800; // characters of one sentence examined (bounds the regex work)
const MAX_UNITS = 400;
const NOTICE = "The classification is informational. A statement in an advertisement about overseas applicants or support is not proof of an LMIA, of sponsorship or of eligibility; verify with the employer.";
const CLASS_LABELS = Object.freeze({
  verified_active: "Verified active vacancy",
  foreign_applicants_stated: "Foreign applicants stated",
  eligibility_unclear: "Eligibility unclear",
  work_authorization_required: "Work authorization required",
  prospective_no_vacancy: "Prospective, no vacancy",
  closed_unsuitable: "Closed or unsuitable",
});

// ---- required work authorization (EN/FR). Matched on accent-folded, lower-cased sentences from employerSupport's own pipeline. ----
const WA_PHRASES = [
  /\b(?:must|need to|needs to|required to|have to|should|doit|doivent|devez)\s+(?:be\s+)?(?:legally\s+)?(?:entitled|eligible|authori[sz]ed|permitted|allowed|autorise\w*)\s+(?:to\s+)?work\s+in\s+canada\b/,
  /\bmust\s+(?:already\s+)?(?:have|hold|possess)\s+(?:a\s+|an\s+)?(?:valid\s+|current\s+|open\s+)?(?:canadian\s+)?work\s+(?:permit|authori[sz]ation)\b/,
  /\b(?:valid|current)\s+(?:canadian\s+)?work\s+(?:permit|authori[sz]ation)\s+(?:is\s+)?(?:required|mandatory|needed|essential)\b/,
  /\b(?:legal\s+)?(?:authori[sz]ation|eligibility|right)\s+to\s+work\s+in\s+canada\s+(?:is\s+)?(?:required|mandatory|essential)\b/,
  /\bonly\s+(?:candidates|applicants)\s+(?:who\s+are\s+)?(?:already\s+)?(?:legally\s+)?(?:authori[sz]ed|eligible|entitled|permitted)\b/,
  /\b(?:canadian\s+citizens?|permanent\s+residents?)(?:\s+(?:or|and)\s+(?:canadian\s+citizens?|permanent\s+residents?))?\s+(?:only|need\s+apply)\b/,
  /\bautorisation\s+de\s+travail\s+(?:valide\s+)?(?:est\s+)?(?:requise|exigee|obligatoire)\b/,
  /\bpermis\s+de\s+travail\s+(?:valide\s+)?(?:est\s+)?(?:requis|exige|obligatoire)\b/,
  /\b(?:citoyens?\s+canadiens?|residents?\s+permanents?)(?:\s+(?:ou|et)\s+(?:citoyens?\s+canadiens?|residents?\s+permanents?))?\s+(?:seulement|uniquement)\b/,
  /\bdoi(?:t|vent)\s+(?:deja\s+)?(?:etre\s+)?(?:legalement\s+)?autorise\w*\s+a\s+travailler\s+au\s+canada\b/,
  /\bseuls?\s+les\s+candidats\s+(?:deja\s+)?(?:legalement\s+)?autorise\w*\b/,
];
// A sentence that negates, hedges or offers help is not a requirement.
const WA_VETO = /\b(?:no|not|never|without|nor|sans|pas|aucun\w*|ni|asset|atout|preferred|prefer\w*|nice\s+to\s+have|souhaite\w*|if|unless|si|sponsor\w*|assist\w*|help\w*|parrain\w*|aide\w*|fournir|provide\w*|may)\b|n'/;
// Pages that collect CVs or describe future hiring are not an open vacancy.
const PROSPECTIVE = /\b(?:talent\s+(?:pool|community|network)|future\s+(?:opportunit\w+|openings?|positions?|vacanc\w+|roles?)|no\s+(?:current|immediate)\s+(?:openings?|vacanc\w+|positions?)|constantly\s+hiring|always\s+hiring|pipeline\s+of\s+candidates|general\s+application|expression\s+of\s+interest|banque\s+de\s+(?:candidat\w+|cv)|aucun\s+poste\s+(?:vacant|disponible)|postes?\s+futurs?|opportunites?\s+futures?|candidature\s+spontanee)\b/;

/**
 * First sentence of the ad that states required work authorization, or null. Bounded work per call.
 * @returns {{quote: string}|null}
 */
function detectWorkAuthRequired(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const units = normalizeAd(text);
  const n = Math.min(units.length, MAX_UNITS);
  for (let i = 0; i < n; i += 1) {
    const u = units[i];
    if (u.tag) continue;
    const f = u.f.length > UNIT_CAP ? u.f.slice(0, UNIT_CAP) : u.f;
    if (WA_PHRASES.some((re) => re.test(f)) && !WA_VETO.test(f)) return { quote: u.q.length > MAX_EVIDENCE ? u.q.slice(0, MAX_EVIDENCE) : u.q };
  }
  return null;
}

function prospectiveText(text) {
  if (typeof text !== "string") return false;
  const units = normalizeAd(text);
  const n = Math.min(units.length, MAX_UNITS);
  for (let i = 0; i < n; i += 1) if (PROSPECTIVE.test(units[i].f.length > UNIT_CAP ? units[i].f.slice(0, UNIT_CAP) : units[i].f)) return true;
  return false;
}

// ---- evidence ----
const squash = (s) => String(s).replace(/\s+/g, " ").trim();
const clean = (s) => squash(s).slice(0, MAX_EVIDENCE * 4);

/** True when `evidence` (>= MIN_EVIDENCE chars) occurs verbatim in `text`, ignoring case and white-space differences. */
function evidenceOccursIn(evidence, text) {
  if (typeof evidence !== "string" || typeof text !== "string") return false;
  const e = squash(evidence).toLowerCase();
  if (e.length < MIN_EVIDENCE) return false;
  return squash(text).toLowerCase().includes(e);
}

const cap = (s) => (s.length > MAX_EVIDENCE ? s.slice(0, MAX_EVIDENCE) : s);

function dayString(v) {
  if (!v) return null;
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Pure derivation. Never returns prospective_no_vacancy.
 * @param {{status?, closing_at?, closing_date?, description_text?}} job
 * @param {{now?: Date, verifiedSource?: boolean, employerSupport?: {label, evidence, conflict?}}} signals
 * @returns {{classification: string, evidence: string|null, reason: string}}
 */
function deriveClassification(job, signals) {
  job = job && typeof job === "object" ? job : {};
  signals = signals && typeof signals === "object" ? signals : {};
  const now = signals.now instanceof Date ? signals.now : new Date();
  const text = typeof job.description_text === "string" ? job.description_text : "";
  const support = signals.employerSupport && typeof signals.employerSupport === "object" ? signals.employerSupport : { label: "unknown", evidence: null };

  // 1. closed / expired / closing passed
  const closingAt = job.closing_at ? new Date(job.closing_at) : null;
  const closingDay = dayString(job.closing_date);
  const today = now.toISOString().slice(0, 10);
  if (job.status === "expired" || job.status === "closed" || (closingAt && !Number.isNaN(closingAt.getTime()) && closingAt < now) || (closingDay && closingDay < today)) {
    return { classification: "closed_unsuitable", evidence: null, reason: "closed_or_expired" };
  }

  // 2. work authorization required: the employer-support label says support is unavailable, or the ad states it as a requirement
  if (support.label === "unavailable") {
    const ev = typeof support.evidence === "string" ? clean(support.evidence) : "";
    return { classification: "work_authorization_required", evidence: ev ? cap(ev) : null, reason: "employer_support_unavailable" };
  }
  const wa = detectWorkAuthRequired(text);
  if (wa) return { classification: "work_authorization_required", evidence: cap(wa.quote), reason: "ad_requires_authorization" };

  // 2b. The ad excludes applicants from abroad ("we do not consider foreign applicants", "Canadian residents only", "only candidates
  // currently residing in Canada"): the vacancy needs someone already in Canada with the right to work, never verified_active.
  const ov = detectOverseas(text);
  if (ov && ov.accepted === false) return { classification: "work_authorization_required", evidence: ov.evidence ? cap(clean(ov.evidence)) : null, reason: "ad_excludes_foreign_applicants" };

  // 3. foreign applicants stated: only with a quote. 'stated_in_ad' must be verifiable in the ad; 'confirmed' carries the staff note.
  const ev = typeof support.evidence === "string" ? clean(support.evidence) : "";
  if (ev && !support.conflict) {
    if (support.label === "stated_in_ad" && evidenceOccursIn(ev, text)) return { classification: "foreign_applicants_stated", evidence: cap(ev), reason: "stated_in_ad_with_quote" };
    if (support.label === "confirmed") return { classification: "foreign_applicants_stated", evidence: cap(ev), reason: "staff_confirmation_with_note" };
  }
  if (support.conflict) return { classification: "eligibility_unclear", evidence: null, reason: "confirmation_conflicts_with_ad" };

  // 4. verified_active: open, real-looking vacancy, verified source, nothing contradicting it
  if (job.status === "open" && signals.verifiedSource === true && squash(text).length >= MIN_DESCRIPTION && !prospectiveText(text)) {
    return { classification: "verified_active", evidence: null, reason: "open_from_verified_source" };
  }
  return { classification: "eligibility_unclear", evidence: null, reason: "insufficient_signals" };
}

// ---- database ----
/** Signals read from the database inside `client`'s transaction. */
async function loadSignals(client, job, now) {
  const conf = (await client.query(
    `SELECT evidence_text FROM js_employer_confirmations
      WHERE revoked_at IS NULL AND btrim(coalesce(evidence_text,'')) <> ''
        AND (job_id = $1 OR (job_id IS NULL AND $2::int IS NOT NULL AND employer_id = $2::int))
      ORDER BY (job_id IS NOT NULL) DESC, id DESC LIMIT 1`,
    [job.id, job.employer_id || null]
  )).rows[0];
  const verified = (await client.query(
    `SELECT 1 FROM js_job_sightings s JOIN js_sources src ON src.id = s.source_id
      WHERE s.job_id = $1 AND src.key <> 'manual_import' AND src.status = 'connected'
        AND s.seen_at >= $2::timestamptz - make_interval(days => $3) LIMIT 1`,
    [job.id, now, VERIFIED_WINDOW_DAYS]
  )).rowCount > 0;
  return { now, verifiedSource: verified, employerSupport: detectEmployerSupport(job.description_text, { confirmation: conf || null }) };
}

const SELECT_JOB = "SELECT j.*, to_char(j.closing_date, 'YYYY-MM-DD') AS closing_date_s FROM js_jobs j WHERE j.id = $1 FOR UPDATE";

/**
 * Derives and stores the classification of one job inside `client`'s transaction (locks the job row).
 * A staff classification (classified_by set) is never touched. Returns the (possibly updated) job row.
 */
async function computeAndStore(client, jobId, opts = {}) {
  const now = opts.now || new Date();
  const job = (await client.query(SELECT_JOB, [jobId])).rows[0];
  if (!job) return { job: null, changed: false, skipped: "missing" };
  if (job.classified_by !== null && job.classified_by !== undefined) return { job, changed: false, skipped: "staff" };
  const r = deriveClassification({ ...job, closing_date: job.closing_date_s }, await loadSignals(client, job, now));
  if (r.classification === job.classification && (r.evidence || null) === (job.classification_evidence || null)) return { job, changed: false, derived: r };
  const row = (await client.query(
    "UPDATE js_jobs SET classification = $2, classification_evidence = $3, classified_at = $4 WHERE id = $1 RETURNING *",
    [jobId, r.classification, r.evidence, now]
  )).rows[0];
  return { job: row, changed: true, derived: r };
}

async function recomputeMany(client, jobIds, opts = {}) {
  const ids = [...new Set((jobIds || []).filter((x) => Number.isSafeInteger(x)))].sort((a, b) => a - b);
  let changed = 0;
  for (const id of ids) if ((await computeAndStore(client, id, opts)).changed) changed += 1;
  return changed;
}

/** computeAndStore in its own transaction (for callers that do not hold one). */
async function recomputeStandalone(jobId, opts = {}) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const out = await computeAndStore(client, jobId, opts);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- presentation ----
/** Job classification block. `staff` adds who classified it; candidates never see that. */
function presentClassification(row, { staff = false } = {}) {
  if (!row) return null;
  const out = {
    classification: row.classification || null,
    classificationLabel: row.classification ? CLASS_LABELS[row.classification] : null,
    classificationEvidence: row.classification_evidence || null,
    classifiedAt: row.classified_at || null,
    classificationNotice: NOTICE,
  };
  if (staff) out.classifiedBy = row.classified_by === undefined ? null : row.classified_by;
  return out;
}

// ---- staff override ----
const posInt = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);

function optionalText(v, field, max) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const s = squash(v.replace(/[\u0000-\u001f\u007f]+/g, " "));
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s || null;
}

/**
 * POST /jobsearch/jobs/:id/classification. `classification: null` clears a staff classification (the automatic one is
 * recomputed straight away). foreign_applicants_stated needs an evidence quote that occurs verbatim in the ad; prospective_no_vacancy and
 * closed_unsuitable need a note (kept in the audit trail). Evidence, when given for any class, must be a verbatim quote.
 */
async function setStaffClassification({ jobId, user, classification, evidence, note }) {
  const perms = (user && PERMISSIONS[user.role]) || [];
  // Review round 1: a classification decides which applications may be sent, so setting or clearing one needs the approval permission.
  if (!user || user.role === "Candidate" || !(perms.includes("*") || perms.includes("jobsearch:approve"))) throw new HttpError(403, "Permission denied: jobsearch:approve");
  const id = posInt(jobId);
  if (!id) throw new HttpError(404, "Not found");
  if (classification === undefined) throw new HttpError(400, "classification is required (a class, or null to clear)");
  if (classification !== null && !CLASSES.includes(classification)) throw new HttpError(400, `classification must be one of ${CLASSES.join(", ")} or null`);
  const ev = optionalText(evidence, "evidence", MAX_EVIDENCE);
  const nt = optionalText(note, "note", MAX_NOTE);
  if (classification === "foreign_applicants_stated" && !ev) throw new HttpError(400, "foreign_applicants_stated requires an evidence quote from the advertisement");
  if (classification === "foreign_applicants_stated" && (ev.length < MIN_STAFF_EVIDENCE || ev.split(" ").filter(Boolean).length < MIN_STAFF_EVIDENCE_WORDS)) {
    throw new HttpError(400, `foreign_applicants_stated evidence must be a quote of at least ${MIN_STAFF_EVIDENCE} characters and ${MIN_STAFF_EVIDENCE_WORDS} words`);
  }
  if ((classification === "prospective_no_vacancy" || classification === "closed_unsuitable") && !nt) throw new HttpError(400, `${classification} requires a note`);
  if (classification === null && ev) throw new HttpError(400, "evidence cannot be given when clearing");

  const client = await db().connect();
  let before;
  let after;
  try {
    await client.query("BEGIN");
    before = (await client.query("SELECT * FROM js_jobs WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!before) throw new HttpError(404, "Not found");
    if (ev && !evidenceOccursIn(ev, before.description_text)) throw new HttpError(400, "evidence must be a verbatim quote from the job description");
    if (classification === null) {
      await client.query("UPDATE js_jobs SET classified_by = NULL WHERE id = $1", [id]);
      after = (await computeAndStore(client, id, {})).job;
    } else {
      after = (await client.query(
        "UPDATE js_jobs SET classification = $2, classification_evidence = $3, classified_by = $4, classified_at = now() WHERE id = $1 RETURNING *",
        [id, classification, ev, user.id]
      )).rows[0];
    }
    await client.query("INSERT INTO js_audit_events (actor, action, detail) VALUES ($1,'job.classification',$2::jsonb)", [
      `user:${user.id}`,
      JSON.stringify({ jobId: id, previous: before.classification || null, classification: after.classification || null, cleared: classification === null, evidenceProvided: Boolean(ev), note: nt }),
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await logAudit({ userId: user.id, action: "jobsearch.job.classification", tableName: "js_jobs", recordId: id, newData: { classification: after.classification || null, previous: before.classification || null } });
  // The job lock is released above on purpose (the guard's job re-check writes this row on its own connection while it holds a
  // candidate lock; taking candidate locks here while holding the job lock could deadlock with it). The follow-ups run afterwards:
  // matches of the job are re-scored (decisions untouched) and approved / queued applications the new class forbids are pulled back.
  await require("./matchService").rescoreMatchesStandalone([id]);
  const cancelled = await cancelBlockedApplications(id, user, after.classification || null);
  return cancelled ? { ...after, cancelledApplications: cancelled } : after;
}

const BLOCKING_WA = Object.freeze(["prospective_no_vacancy", "closed_unsuitable", "work_authorization_required"]);

/**
 * Approved / queued (never sent) applications of the job that the class `cls` forbids are cancelled through the consent mechanism
 * (cancelQueuedForCandidate with onlyApplicationIds), one candidate transaction each, with a timeline row per application and an audit
 * event with the count. work_authorization_required spares candidates whose recorded status shows a permit / PR / citizenship.
 * @returns {Promise<number>} cancelled applications
 */
async function cancelBlockedApplications(jobId, user, cls) {
  if (!BLOCKING_WA.includes(cls)) return 0;
  const rows = (await db().query(
    `SELECT a.id, a.candidate_id FROM js_applications a JOIN candidates c ON c.id = a.candidate_id
      WHERE a.job_id = $1 AND a.status IN ('approved','queued')
        AND ($2 <> 'work_authorization_required' OR COALESCE(c.work_authorization_status,'') <> ALL($3::text[]))
      ORDER BY a.candidate_id, a.id`,
    [jobId, cls, ["work_permit_open", "work_permit_employer_specific", "pr", "citizen"]]
  )).rows;
  const byCandidate = new Map();
  for (const r of rows) byCandidate.set(r.candidate_id, [...(byCandidate.get(r.candidate_id) || []), r.id]);
  const consentService = require("./consentService");
  let total = 0;
  for (const [cid, ids] of byCandidate) {
    const client = await db().connect();
    try {
      await client.query("BEGIN");
      const n = await consentService.cancelQueuedForCandidate(cid, `job_classified_${cls}`, client, { includeReady: false, actor: `staff:${user.id}`, onlyApplicationIds: ids });
      if (n) await client.query("INSERT INTO js_audit_events (actor, action, candidate_id, detail) VALUES ($1,'job.classification_cancel_applications',$2,$3::jsonb)", [`user:${user.id}`, cid, JSON.stringify({ jobId, classification: cls, cancelled: n })]);
      await client.query("COMMIT");
      total += n;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return total;
}

module.exports = {
  CLASSES,
  CLASS_LABELS,
  NOTICE,
  MAX_EVIDENCE,
  VERIFIED_WINDOW_DAYS,
  deriveClassification,
  detectWorkAuthRequired,
  evidenceOccursIn,
  loadSignals,
  computeAndStore,
  recomputeMany,
  recomputeStandalone,
  presentClassification,
  setStaffClassification,
};
