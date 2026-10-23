// What may go into an application package. Deny by default:
//  - CVs: only APPROVED js_cv_files versions of this candidate whose stored bytes still match the
//    recorded sha256 (originals are read, never written).
//  - Sensitive CRM documents (passport, national_id, police_certificate, medical) only with a
//    non-revoked js_sharing_authorizations row for THIS application and THIS document, with a
//    non-empty legitimate_need, granted by the candidate's own user account.
//  - Other CRM documents of this candidate (not deleted) are included as requested.
const crypto = require("crypto");
const storage = require("./storage");
const { HttpError } = require("./httpError");

const db = () => require("../../db");

const SENSITIVE_TYPES = ["passport", "national_id", "police_certificate", "medical"];
const MAX_REQUESTED = 20;
const LANG_ALIASES = { en: "en", eng: "en", english: "en", anglais: "en", fr: "fr", fra: "fr", french: "fr", francais: "fr", "français": "fr", ar: "ar", ara: "ar", arabic: "ar", arabe: "ar" };

/** Canonical sensitive type for a free-text doc_type, or null when not sensitive. Errs on the side of sensitive. */
function sensitiveType(docType) {
  const t = String(docType || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (/passport|passeport|جواز/.test(t)) return "passport";
  if (/national.?id|id.?card|identity|identite|\bcin\b|carte.?d.?identit|بطاقة/.test(t)) return "national_id";
  if (/police|criminal|casier|judiciaire|background.?check|سوابق/.test(t)) return "police_certificate";
  if (/medic|health|sante|hospital|vaccin|طبي/.test(t)) return "medical";
  return null;
}

function normLang(v) {
  const k = String(v || "").trim().toLowerCase();
  return LANG_ALIASES[k] || (/^[a-z]{2}$/.test(k) ? k : null);
}

const posInt = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);

/** Validates a requested DocRef[] ({cvFileId} | {documentId}); throws 400. */
function validateRequested(requested) {
  if (requested === undefined || requested === null) return [];
  if (!Array.isArray(requested) || requested.length > MAX_REQUESTED) throw new HttpError(400, `documents must be an array of at most ${MAX_REQUESTED} entries`);
  const out = [];
  const seen = new Set();
  for (const r of requested) {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new HttpError(400, "each document must be {cvFileId} or {documentId}");
    const cv = r.cvFileId !== undefined ? posInt(r.cvFileId) : null;
    const doc = r.documentId !== undefined ? posInt(r.documentId) : null;
    if ((cv === null) === (doc === null)) throw new HttpError(400, "each document must be {cvFileId} or {documentId}");
    const key = cv ? `cv:${cv}` : `doc:${doc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cv ? { cvFileId: cv } : { documentId: doc });
  }
  return out;
}

/**
 * Latest APPROVED CV version in `jobLanguage`; otherwise the latest approved CV in another language,
 * flagged with a `language_mismatch` note. Never mutates the files.
 * @returns {Promise<{cv: object, notes: string[]}|null>}
 */
async function pickCv(candidateId, jobLanguage, client) {
  const rows = (await (client || db()).query(
    "SELECT * FROM js_cv_files WHERE candidate_id = $1 AND approved = true AND scan_status <> 'infected' ORDER BY version DESC, id DESC",
    [candidateId]
  )).rows;
  if (!rows.length) return null;
  const want = normLang(jobLanguage);
  const same = want ? rows.find((r) => normLang(r.language) === want) : null;
  if (same) return { cv: same, notes: [] };
  return { cv: rows[0], notes: [`language_mismatch: approved CV is in ${normLang(rows[0].language) || "an unknown language"}, the job is in ${want || "an unknown language"}`] };
}

/** Candidate-granted, non-revoked authorization for this application+document with a stated need. */
async function findAuthorization(client, { applicationId, candidateId, documentId }) {
  const r = await client.query(
    `SELECT s.id, s.legitimate_need FROM js_sharing_authorizations s
       JOIN js_candidate_accounts ca ON ca.candidate_id = s.candidate_id AND ca.user_id = s.granted_by
      WHERE s.application_id = $1 AND s.candidate_id = $2 AND s.document_id = $3
        AND s.revoked_at IS NULL AND btrim(coalesce(s.legitimate_need, '')) <> ''
      ORDER BY s.id DESC LIMIT 1`,
    [applicationId, candidateId, documentId]
  );
  return r.rows[0] || null;
}

async function storedSha(key) {
  try {
    return crypto.createHash("sha256").update(await storage.get(key)).digest("hex");
  } catch {
    return null;
  }
}

async function cvEntry(client, application, cvFileId) {
  const doc = { cvFileId };
  const cv = (await client.query("SELECT * FROM js_cv_files WHERE id = $1 AND candidate_id = $2", [cvFileId, application.candidate_id])).rows[0];
  if (!cv) return { blocked: { doc, reason: "not_found" } };
  if (!cv.approved) return { blocked: { doc, reason: "cv_not_approved" } };
  if (cv.scan_status === "infected") return { blocked: { doc, reason: "cv_infected" } };
  const sha = await storedSha(cv.storage_key);
  if (!sha) return { blocked: { doc, reason: "cv_file_unavailable" } };
  if (cv.sha256 && sha !== cv.sha256) return { blocked: { doc, reason: "cv_integrity_mismatch" } };
  return { included: { kind: "cv", cvFileId: cv.id, docType: "cv", version: cv.version, sha256: cv.sha256 || sha, language: normLang(cv.language), sensitive: false, sharingAuthorizationId: null } };
}

async function documentEntry(client, application, documentId) {
  const doc = { documentId };
  const d = (await client.query("SELECT * FROM documents WHERE id = $1 AND candidate_id = $2 AND is_deleted = false", [documentId, application.candidate_id])).rows[0];
  if (!d) return { blocked: { doc, reason: "not_found" } };
  const sensitive = sensitiveType(d.doc_type);
  let auth = null;
  if (sensitive) {
    auth = await findAuthorization(client, { applicationId: application.id, candidateId: application.candidate_id, documentId });
    if (!auth) return { blocked: { doc: { ...doc, docType: sensitive }, reason: "sensitive_document_requires_candidate_authorization" } };
  }
  // CRM documents hold a path/reference; hash the bytes only when they live in our storage.
  const sha = await storedSha(d.file_path);
  const stamp = d.updated_at instanceof Date ? d.updated_at.toISOString() : String(d.updated_at);
  return {
    included: { kind: "document", documentId: d.id, docType: sensitive || String(d.doc_type).slice(0, 100), version: 1, sha256: sha, sourceRef: `documents:${d.id}@${stamp}`, sensitive: Boolean(sensitive), sharingAuthorizationId: auth ? auth.id : null },
  };
}

/**
 * @param {{application: object, requested?: Array<{cvFileId?:number, documentId?:number}>, jobLanguage?: string, client?: object}} args
 * @returns {Promise<{included: object[], blocked: {doc: object, reason: string}[], notes: string[]}>}
 */
async function buildPackage({ application, requested, jobLanguage, client }) {
  const c = client || db();
  const refs = validateRequested(requested);
  const included = [];
  const blocked = [];
  const notes = [];
  if (!refs.some((r) => r.cvFileId)) {
    const picked = await pickCv(application.candidate_id, jobLanguage || application.job_language, c);
    if (!picked) blocked.push({ doc: { kind: "cv" }, reason: "no_approved_cv" });
    else {
      notes.push(...picked.notes);
      refs.unshift({ cvFileId: picked.cv.id });
    }
  }
  for (const r of refs) {
    const e = r.cvFileId ? await cvEntry(c, application, r.cvFileId) : await documentEntry(c, application, r.documentId);
    if (e.blocked) blocked.push(e.blocked);
    else included.push(e.included);
  }
  if (!included.some((d) => d.kind === "cv") && !blocked.some((b) => b.doc.kind === "cv" || b.doc.cvFileId)) blocked.push({ doc: { kind: "cv" }, reason: "no_approved_cv" });
  return { included, blocked, notes };
}

/**
 * Re-validates the stored (non-removed) package rows of an application inside `client`'s transaction.
 * @returns {Promise<string[]>} problems (empty when the package is still valid)
 */
async function revalidateStoredPackage(client, application) {
  const rows = (await client.query("SELECT * FROM js_application_documents WHERE application_id = $1 AND removed_at IS NULL ORDER BY id", [application.id])).rows;
  const problems = [];
  if (!rows.some((r) => r.cv_file_id)) problems.push("no_cv_in_package");
  for (const r of rows) {
    if (r.cv_file_id) {
      const cv = (await client.query("SELECT approved, sha256, version FROM js_cv_files WHERE id = $1 AND candidate_id = $2", [r.cv_file_id, application.candidate_id])).rows[0];
      if (!cv || !cv.approved) problems.push(`cv_not_approved:${r.cv_file_id}`);
      else if (cv.sha256 !== r.sha256 || cv.version !== r.version) problems.push(`cv_changed:${r.cv_file_id}`);
    } else if (r.document_id) {
      const d = (await client.query("SELECT doc_type FROM documents WHERE id = $1 AND candidate_id = $2 AND is_deleted = false", [r.document_id, application.candidate_id])).rows[0];
      if (!d) problems.push(`document_missing:${r.document_id}`);
      else if (r.sensitive || sensitiveType(d.doc_type)) {
        // The exact authorization recorded in the package must still be valid (candidate-granted, need stated, not revoked).
        const ok = r.sharing_authorization_id && (await client.query(
          `SELECT 1 FROM js_sharing_authorizations s
             JOIN js_candidate_accounts ca ON ca.candidate_id = s.candidate_id AND ca.user_id = s.granted_by
            WHERE s.id = $1 AND s.application_id = $2 AND s.candidate_id = $3 AND s.document_id = $4
              AND s.revoked_at IS NULL AND btrim(coalesce(s.legitimate_need, '')) <> ''`,
          [r.sharing_authorization_id, application.id, application.candidate_id, r.document_id]
        )).rowCount;
        if (!ok) problems.push(`sensitive_unauthorized:${r.document_id}`);
      }
    }
  }
  return problems;
}

module.exports = { buildPackage, pickCv, sensitiveType, validateRequested, revalidateStoredPackage, findAuthorization, normLang, SENSITIVE_TYPES };
