// What may go into an application package. Deny by default:
//  - CVs: only APPROVED js_cv_files versions of this candidate whose stored bytes still match the
//    recorded sha256 (originals are read, never written).
//  - CRM documents are SENSITIVE unless their type is on a small safe allowlist (CV, cover letter,
//    diploma, transcript, training certificate, language test, portfolio, trade licence). Sensitive
//    ones (passport, national_id, police_certificate, medical, ... and anything unknown) need a
//    non-revoked js_sharing_authorizations row for THIS application and THIS document, with a
//    non-empty legitimate_need, granted by the candidate's own user account.
const crypto = require("crypto");
const storage = require("./storage");
const { HttpError } = require("./httpError");

const db = () => require("../../db");

const SENSITIVE_TYPES = ["passport", "national_id", "police_certificate", "medical"];
const MAX_REQUESTED = 20;
const LANG_ALIASES = { en: "en", eng: "en", english: "en", anglais: "en", fr: "fr", fra: "fr", french: "fr", francais: "fr", "français": "fr", ar: "ar", ara: "ar", arabic: "ar", arabe: "ar" };

// Common Cyrillic/Greek look-alikes folded to Latin (after lower-casing) so "pаssport" (Cyrillic а) matches.
const CONFUSABLES = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
  "і": "i", "ї": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "һ": "h", "ԛ": "q", "ԝ": "w", "ь": "b",
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "μ": "u", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ϲ": "c",
};

/**
 * Normalisation for document-type matching: NFKC, invisible characters removed (zero-width, soft
 * hyphen, word joiner, BOM, bidi marks), lower-case, confusables folded, accents and Arabic
 * diacritics/tatweel removed, punctuation -> space, spaces collapsed.
 */
function normDocType(v) {
  return String(v || "")
    .normalize("NFKC")
    .replace(/[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯﻿]/g, "")
    .toLowerCase()
    .replace(/[Ͱ-ϿЀ-ԯ]/g, (ch) => CONFUSABLES[ch] || ch)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Layer 1 (always wins): identity, civil-status, immigration, police, medical, financial, reference,
// photo material. Canonical type = first matching rule.
const SENSITIVE_RULES = [
  ["passport", /\b(?:passports?|passeports?|pasaportes?|reisepass|pasaport|paspor|passaporto|passaporte|pasport)\b|جواز/],
  ["national_id", /\b(?:id|ids|cni|cnie|nid|cin|nic|dni|nie|iqama|tazkira|tazkera|aadhaar|aadhar|identity|identite|identidad|ausweis|personalausweis|national|carte d identite|carte consulaire|consulaire|id card|id copy|driver|drivers|driving|fuhrerschein|permis de conduire|licence de conduire|license de conduire|ssn|sin|nas|nir|social security|securite sociale|secu|numero secu|carte vitale|vitale)\b|بطاقة|هوية|اقامة|إقامة/],
  ["police_certificate", /\b(?:police|criminal|casier|judiciaire|bulletin|b3|b 3|good conduct|bonne conduite|anthropometrique|background|record check|antecedentes|fuhrungszeugnis)\b|سوابق|حسن السيرة/],
  ["medical", /\b(?:medic\w*|medical|medicale|health|sante|hospital\w*|vaccin\w*|covid|blood|sang|xray|x ray|radiographie|fitness to work|aptitude|hiv|vih|sida|aids|pregnan\w*|grossesse|handicap\w*|disabilit\w*|invalidite|drug|drugs|mutuelle|insurance|assurance)\b|طبي|صحي/],
  ["immigration", /\b(?:visas?|permits?|permis|sejour|residence|residency|resident|aufenthaltstitel|aufenthalt\w*|green card|lmia|eimt|caq|immigration|asylum|refugee)\b|تأشيرة|تصريح/],
  ["civil_status", /\b(?:birth|naissance|marriage|mariage|divorce|family book|livret de famille|fiche familiale|familiale|etat civil|extrait d acte|extrait|acte|death|deces|nationality|nationalite|citizenship)\b|ميلاد|زواج/],
  ["financial", /\b(?:bank|banque|bancaire|releve bancaire|bank statement|rib|iban|tax|impot|impots|salary slip|payslip|fiche de paie|bulletin de salaire)\b/],
  ["identity_other", /\b(?:carte grise|vehicle registration|registration)\b/],
  ["reference", /\b(?:references?|referees?|recommendation|recommandation|attestation de travail|employer letter)\b/],
  ["photo", /\b(?:photo|photos|picture|selfie)\b|صورة/],
];

// Layer 2: SAFE only if EVERY token is a safe term or a harmless tail, AND the name contains a
// recognised document-kind anchor. Anything else (including blank) is 'unclassified' (fail-closed).
const SAFE_TERMS = new Set(["cv", "resume", "curriculum", "vitae", "lebenslauf", "cover", "letter", "lettre", "motivation", "diploma", "diplome", "degree", "master", "masters", "bachelor", "transcript", "releve", "notes", "training", "professional", "certificate", "certificat", "formation", "portfolio", "red", "seal", "trade", "language", "test", "result", "results", "ielts", "toefl", "tcf", "tef", "celpip", "delf", "dalf", "goethe"]);
const TAIL_TERMS = new Set(["final", "draft", "version", "pdf", "docx", "doc", "copy", "scan", "scanned", "signed", "updated", "new", "old", "eng", "english", "fr", "french", "ar", "arabic", "en", "de", "es", "it", "ro", "sq", "albanian", "romanian", "italian", "spanish", "german", "and", "et", "of", "du", "la", "le", "the", "for", "pour"]);
const ANCHOR_RE = /\b(?:cv|resume|curriculum vitae|curriculum|lebenslauf|cover letter|lettre de motivation|motivation letter|diploma|diplome|degree|master|masters|bachelor|transcript|releve de notes|portfolio|ielts|toefl|tcf|tef|celpip|delf|dalf|goethe|language test|trade licen[cs]e|professional licen[cs]e|red seal|red seal licen[cs]e|training certificate|professional certificate|certificat de formation)\b/;
// Tiny Arabic allowlist (exact phrases), mapped to a Latin anchor before tokenising.
const ARABIC_SAFE = [["السيرة الذاتية", "cv"], ["سيرة ذاتية", "cv"], ["شهادة جامعية", "diploma"], ["دبلوم", "diploma"]];

function isSafe(t) {
  let x = ` ${t} `;
  for (const [ar, latin] of ARABIC_SAFE) x = x.split(` ${normDocType(ar)} `).join(` ${latin} `);
  const toks = x.trim().split(" ").filter(Boolean);
  if (!toks.length || !ANCHOR_RE.test(toks.join(" "))) return false;
  return toks.every((tok, i) => {
    if (SAFE_TERMS.has(tok) || TAIL_TERMS.has(tok) || /^v\d{1,3}$/.test(tok) || /^\d{1,4}$/.test(tok)) return true;
    // 'licence'/'license' is safe ONLY right after trade / professional / red seal.
    if (tok === "licence" || tok === "license") return ["trade", "professional", "seal"].includes(toks[i - 1]);
    return false;
  });
}

/**
 * DENY BY DEFAULT. Returns null only when the whole name is made of safe document-kind terms (plus
 * harmless tails like "final", "v2", "pdf", a language); otherwise a canonical sensitive type
 * (passport, national_id, police_certificate, medical, immigration, civil_status, financial,
 * identity_other, reference, photo) or 'unclassified'. Sensitive types need a candidate-granted
 * sharing authorization.
 */
function sensitiveType(docType) {
  const t = normDocType(docType);
  for (const [type, re] of SENSITIVE_RULES) if (re.test(t)) return type;
  return t && isSafe(t) ? null : "unclassified";
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
  if (!cv.sha256) {
    // Legacy row without a recorded hash: record it once from the stored bytes (metadata only).
    await client.query("UPDATE js_cv_files SET sha256 = $2 WHERE id = $1 AND sha256 IS NULL", [cv.id, sha]);
  }
  return { included: { kind: "cv", cvFileId: cv.id, docType: "cv", version: cv.version, sha256: cv.sha256 || sha, language: normLang(cv.language), sensitive: false, sharingAuthorizationId: null } };
}

/** Snapshot of a CRM document's identity + last modification; a change means re-review. */
function sourceRef(d) {
  const stamp = d.updated_at instanceof Date ? d.updated_at.toISOString() : String(d.updated_at);
  return `documents:${d.id}@${stamp}@${crypto.createHash("sha256").update(`${d.doc_type}\n${d.file_path}`).digest("hex").slice(0, 16)}`;
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
  return {
    included: { kind: "document", documentId: d.id, docType: sensitive || String(d.doc_type).slice(0, 100), version: 1, sha256: sha, sourceRef: sourceRef(d), sensitive: Boolean(sensitive), sharingAuthorizationId: auth ? auth.id : null },
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
 * Re-validates the stored (non-removed) package rows of an application inside `client`'s transaction:
 * CVs still approved, not infected, same version/sha256 and same stored bytes; CRM documents not
 * deleted and unchanged since packaging (source_ref + sha256 when present); sensitive documents still
 * covered by the exact, valid, candidate-granted authorization.
 * @returns {Promise<Array<{code: string, cvFileId?: number, documentId?: number}>>} empty when valid
 */
async function revalidateStoredPackage(client, application) {
  const rows = (await client.query("SELECT * FROM js_application_documents WHERE application_id = $1 AND removed_at IS NULL ORDER BY id", [application.id])).rows;
  const problems = [];
  if (!rows.some((r) => r.cv_file_id)) problems.push({ code: "no_cv_in_package" });
  for (const r of rows) {
    if (r.cv_file_id) {
      const ref = { cvFileId: r.cv_file_id };
      const cv = (await client.query("SELECT approved, sha256, version, scan_status, storage_key FROM js_cv_files WHERE id = $1 AND candidate_id = $2", [r.cv_file_id, application.candidate_id])).rows[0];
      if (!cv) problems.push({ code: "cv_missing", ...ref });
      else if (!cv.approved) problems.push({ code: "cv_not_approved", ...ref });
      else if (cv.scan_status === "infected") problems.push({ code: "cv_infected", ...ref });
      else if (cv.sha256 !== r.sha256 || cv.version !== r.version) problems.push({ code: "cv_changed", ...ref });
      else if ((await storedSha(cv.storage_key)) !== r.sha256) problems.push({ code: "cv_bytes_changed", ...ref });
      continue;
    }
    if (!r.document_id) continue;
    const ref = { documentId: r.document_id };
    const d = (await client.query("SELECT * FROM documents WHERE id = $1 AND candidate_id = $2", [r.document_id, application.candidate_id])).rows[0];
    if (!d || d.is_deleted) {
      problems.push({ code: "document_deleted", ...ref });
      continue;
    }
    if (r.source_ref !== sourceRef(d) || (r.sha256 && (await storedSha(d.file_path)) !== r.sha256)) problems.push({ code: "document_changed", ...ref });
    if (r.sensitive || sensitiveType(d.doc_type)) {
      // The exact authorization recorded in the package must still be valid (candidate-granted, need stated, not revoked).
      const ok = r.sharing_authorization_id && (await client.query(
        `SELECT 1 FROM js_sharing_authorizations s
           JOIN js_candidate_accounts ca ON ca.candidate_id = s.candidate_id AND ca.user_id = s.granted_by
          WHERE s.id = $1 AND s.application_id = $2 AND s.candidate_id = $3 AND s.document_id = $4
            AND s.revoked_at IS NULL AND btrim(coalesce(s.legitimate_need, '')) <> ''`,
        [r.sharing_authorization_id, application.id, application.candidate_id, r.document_id]
      )).rowCount;
      if (!ok) problems.push({ code: "sensitive_unauthorized", ...ref });
    }
  }
  return problems;
}

const formatProblems = (ps) => ps.map((p) => `${p.code}${p.cvFileId ? `:cv${p.cvFileId}` : p.documentId ? `:doc${p.documentId}` : ""}`).join(", ");

module.exports = { formatProblems, normDocType, buildPackage, pickCv, sensitiveType, validateRequested, revalidateStoredPackage, findAuthorization, normLang, SENSITIVE_TYPES };
