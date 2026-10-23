// CV upload, extraction and profile confirmation. Originals are never mutated: every
// upload stores a new immutable js_cv_files version. Uploading a CV creates no consent,
// no settings change and no application.
const { HttpError } = require("./httpError");
const { assertCandidateAccess } = require("./scope");
const storage = require("./storage");
const scanner = require("./scan");
const { extractFromFile } = require("./extract");
const { sanitizeText, MAX_ITEM, MAX_ITEMS } = require("./extract/deterministic");
const { PERMISSIONS } = require("../../middleware/role");

const PROFILE_FIELDS = ["name", "email", "phone", "profession", "skills", "experience", "education", "certificates", "languages"];
const SCALAR_FIELDS = ["name", "email", "phone", "profession"];
const STRING_LIST_FIELDS = ["skills", "education", "certificates"];

const db = () => require("../../db");

function can(user, permission) {
  if (!user) return false;
  if (user.role === "Candidate") return true; // ownership is enforced by the scope check
  const perms = PERMISSIONS[user.role] || [];
  return perms.includes("*") || perms.includes(permission);
}

/** Candidate: own record; staff: assigned + jobsearch permission; admin: all. Everything else 404. */
async function authorize(user, candidateId, level = "write") {
  if (!can(user, level === "write" ? "jobsearch:write" : "jobsearch:read")) throw new HttpError(404, "Not found");
  await assertCandidateAccess(user, candidateId);
  return typeof candidateId === "string" ? Number(candidateId) : candidateId;
}

function actorOf(user) {
  return user.role === "Candidate" ? "candidate" : `staff:${user.id}`;
}

function cleanStr(v, field) {
  if (v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string or null`);
  const s = sanitizeText(v).replace(/\s+/g, " ").trim().slice(0, MAX_ITEM);
  return s || null;
}

function validateEdits(edits) {
  if (edits === undefined || edits === null) return {};
  if (typeof edits !== "object" || Array.isArray(edits)) throw new HttpError(400, "edits must be an object");
  const out = {};
  for (const [field, value] of Object.entries(edits)) {
    if (!PROFILE_FIELDS.includes(field)) throw new HttpError(400, `Unknown profile field: ${field}`);
    if (SCALAR_FIELDS.includes(field)) {
      const v = cleanStr(value, field);
      if (field === "email" && v !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, "email is not valid");
      out[field] = v;
    } else if (STRING_LIST_FIELDS.includes(field)) {
      if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new HttpError(400, `${field} must be an array of at most ${MAX_ITEMS} strings`);
      out[field] = value.map((x) => {
        if (typeof x !== "string") throw new HttpError(400, `${field} must contain strings`);
        return cleanStr(x, field);
      }).filter(Boolean);
    } else if (field === "experience") {
      if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new HttpError(400, "experience must be an array");
      out[field] = value.map((x) => {
        if (!x || typeof x !== "object" || Array.isArray(x)) throw new HttpError(400, "experience entries must be objects");
        return { title: cleanStr(x.title ?? null, "title"), employer: cleanStr(x.employer ?? null, "employer"), start: cleanStr(x.start ?? null, "start"), end: cleanStr(x.end ?? null, "end") };
      });
    } else if (field === "languages") {
      if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new HttpError(400, "languages must be an array");
      out[field] = value.map((x) => {
        if (!x || typeof x !== "object" || Array.isArray(x)) throw new HttpError(400, "languages entries must be objects");
        const lang = cleanStr(x.lang ?? null, "lang");
        if (!lang) throw new HttpError(400, "language name is required");
        return { lang, level: cleanStr(x.level ?? null, "level") };
      });
    }
  }
  return out;
}

function strList(v, field, { required = true } = {}) {
  if (!Array.isArray(v) || v.length > MAX_ITEMS || v.some((x) => typeof x !== "string" || !x.trim())) {
    throw new HttpError(400, `preferences.${field} must be an array of non-empty strings`);
  }
  const out = [...new Set(v.map((x) => sanitizeText(x).replace(/\s+/g, " ").trim().slice(0, 100)))];
  if (required && out.length === 0) throw new HttpError(400, `preferences.${field} is required`);
  return out;
}

function requiredStr(v, field) {
  if (typeof v !== "string" || !sanitizeText(v).trim()) throw new HttpError(400, `preferences.${field} is required`);
  return sanitizeText(v).replace(/\s+/g, " ").trim().slice(0, 100);
}

function validatePreferences(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new HttpError(400, "preferences are required");
  const salary = p.salary_expectation !== undefined ? p.salary_expectation : p.salary_min;
  if (typeof salary !== "number" || !Number.isFinite(salary) || salary < 0) {
    throw new HttpError(400, "preferences.salary_expectation must be a non-negative number");
  }
  if (typeof p.salary_currency !== "string" || !/^[A-Za-z]{3}$/.test(p.salary_currency.trim())) {
    throw new HttpError(400, "preferences.salary_currency must be a 3-letter currency code");
  }
  if (typeof p.needs_work_auth_support !== "boolean") throw new HttpError(400, "preferences.needs_work_auth_support must be true or false");
  return {
    countries: strList(p.countries, "countries"),
    categories: strList(p.categories, "categories"),
    availability: requiredStr(p.availability, "availability"),
    salary_min: salary,
    salary_currency: p.salary_currency.trim().toUpperCase(),
    residence_country: requiredStr(p.residence_country, "residence_country"),
    needs_work_auth_support: p.needs_work_auth_support,
  };
}

function mapStorageError(err) {
  if (err && err.code === "UNSUPPORTED_TYPE") return new HttpError(415, "Unsupported file type: only PDF, DOCX, PNG and JPEG are allowed");
  if (err && err.code === "FILE_TOO_LARGE") return new HttpError(413, "File too large");
  if (err && err.code === "INVALID_UPLOAD") return new HttpError(400, "Invalid upload");
  return err;
}

async function audit(client, user, action, candidateId, detail) {
  await client.query("INSERT INTO js_audit_events (actor, action, candidate_id, detail) VALUES ($1,$2,$3,$4::jsonb)", [
    `user:${user.id}`,
    action,
    candidateId,
    JSON.stringify(detail),
  ]);
}

/**
 * Caller must already have authorized the user (see authorize); uploadCv re-checks anyway.
 * @returns {Promise<{cvFileId:number, version:number, scan:{status,detail}, profile:object}>}
 */
async function uploadCv({ user, candidateId, file }) {
  const id = await authorize(user, candidateId, "write");
  const buf = file && file.buffer;
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, "A non-empty file is required");
  const max = (Number(process.env.MAX_UPLOAD_MB) > 0 ? Number(process.env.MAX_UPLOAD_MB) : 10) * 1024 * 1024;
  if (buf.length > max) throw new HttpError(413, "File too large");

  let mime;
  try {
    mime = storage.sniffMime(buf); // content only; client MIME and filename are ignored
  } catch (err) {
    throw mapStorageError(err);
  }
  // Scanner policy: a clean/infected verdict is authoritative. If the scanner is not configured
  // or fails (down, timeout, bad reply) the upload is still accepted but stored and shown as
  // 'scan_unavailable' - never as 'clean'.
  const scan = await scanner.scan(buf);
  if (scan.status === "infected") {
    await db().query("INSERT INTO js_audit_events (actor, action, candidate_id, detail) VALUES ($1,'cv.upload_rejected_infected',$2,$3::jsonb)", [
      `user:${user.id}`,
      id,
      JSON.stringify({ detail: scan.detail, size: buf.length }),
    ]);
    throw new HttpError(422, "File rejected: malware detected");
  }

  let extraction;
  try {
    extraction = await extractFromFile(buf, mime);
  } catch (err) {
    const reason = err && err.reason;
    console.error("jobsearch cv extraction failed:", err && err.name, reason);
    if (reason === "timeout") throw new HttpError(422, "The document took too long to read and was rejected");
    if (reason === "too_large" || reason === "memory") throw new HttpError(422, "The document is too large or complex to read and was rejected");
    throw new HttpError(422, "The document could not be read");
  }
  const { provenance, ...extracted } = extraction;

  let stored;
  try {
    stored = await storage.put(buf, { candidateId: id });
  } catch (err) {
    throw mapStorageError(err);
  }

  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM candidates WHERE id = $1 FOR UPDATE", [id]);
    const v = await client.query("SELECT COALESCE(MAX(version), 0) + 1 AS next FROM js_cv_files WHERE candidate_id = $1", [id]);
    const version = v.rows[0].next;
    const cv = await client.query(
      `INSERT INTO js_cv_files (candidate_id, storage_key, sha256, version, original, scan_status, scan_detail)
       VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`,
      [id, stored.key, stored.sha256, version, scan.status, scan.detail]
    );
    // Re-upload replaces the *extraction* and asks for re-confirmation; confirmed data is kept.
    await client.query(
      `INSERT INTO js_profiles (candidate_id, extracted, provenance, status)
       VALUES ($1,$2::jsonb,$3::jsonb,'extracted')
       ON CONFLICT (candidate_id) DO UPDATE
         SET extracted = EXCLUDED.extracted, provenance = EXCLUDED.provenance, status = 'extracted', updated_at = now()`,
      [id, JSON.stringify(extracted), JSON.stringify(provenance)]
    );
    await audit(client, user, "cv.upload", id, { cv_file_id: cv.rows[0].id, version, sha256: stored.sha256, scan_status: scan.status });
    await client.query("COMMIT");
    return { cvFileId: cv.rows[0].id, version, scan, profile: await getProfile({ user, candidateId: id }) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getProfile({ user, candidateId, signTtlSec = 300 }) {
  const id = await authorize(user, candidateId, "read");
  const p = await db().query("SELECT * FROM js_profiles WHERE candidate_id = $1", [id]);
  if (p.rowCount === 0) throw new HttpError(404, "Not found");
  const prefs = await db().query("SELECT countries, categories, availability, salary_min, salary_currency, residence_country, needs_work_auth_support FROM js_preferences WHERE candidate_id = $1", [id]);
  const files = await db().query(
    "SELECT id, version, sha256, storage_key, language, approved, original, scan_status, scan_detail, created_at FROM js_cv_files WHERE candidate_id = $1 ORDER BY version",
    [id]
  );
  const row = p.rows[0];
  return {
    candidate_id: id,
    status: row.status,
    extracted: row.extracted,
    confirmed: row.confirmed,
    provenance: row.provenance,
    confirmed_by: row.confirmed_by,
    confirmed_at: row.confirmed_at,
    preferences: prefs.rows[0] || null,
    // Candidates get their files (signed links) but not the integrity hashes (staff-only, like provider ids).
    cv_files: files.rows.map(({ storage_key, sha256, ...f }) => ({ ...f, ...(user.role === "Candidate" ? {} : { sha256 }), download_url: storage.signUrl(storage_key, user.id, signTtlSec) })),
  };
}

async function confirmProfile({ user, candidateId, edits, preferences }) {
  const id = await authorize(user, candidateId, "write");
  const prefs = validatePreferences(preferences);
  const cleanEdits = validateEdits(edits);
  const actor = actorOf(user);

  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM candidates WHERE id = $1 FOR UPDATE", [id]);
    const cur = await client.query("SELECT extracted, confirmed, provenance FROM js_profiles WHERE candidate_id = $1 FOR UPDATE", [id]);
    const extracted = cur.rowCount ? cur.rows[0].extracted : {};
    const prevConfirmed = cur.rowCount ? cur.rows[0].confirmed : {};
    const prevProv = cur.rowCount ? cur.rows[0].provenance : {};

    const confirmed = {};
    const provenance = {};
    for (const f of PROFILE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(cleanEdits, f)) {
        confirmed[f] = cleanEdits[f];
        provenance[f] = actor;
      } else if (f in extracted) {
        // Earlier edits survive unless a newer extraction exists for a field nobody edited.
        const edited = prevProv[f] && prevProv[f] !== "cv" && f in prevConfirmed;
        confirmed[f] = edited ? prevConfirmed[f] : extracted[f];
        const v = confirmed[f];
        const hasValue = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined;
        if (edited) provenance[f] = prevProv[f];
        else if (hasValue) provenance[f] = "cv"; // only values actually found in the CV
      } else if (f in prevConfirmed) {
        confirmed[f] = prevConfirmed[f];
        provenance[f] = prevProv[f] || actor;
      }
    }

    await client.query(
      `INSERT INTO js_profiles (candidate_id, confirmed, provenance, status, confirmed_by, confirmed_at)
       VALUES ($1,$2::jsonb,$3::jsonb,'confirmed',$4,now())
       ON CONFLICT (candidate_id) DO UPDATE
         SET confirmed = EXCLUDED.confirmed, provenance = EXCLUDED.provenance, status = 'confirmed',
             confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now(), updated_at = now()`,
      [id, JSON.stringify(confirmed), JSON.stringify(provenance), user.id]
    );
    await client.query(
      `INSERT INTO js_preferences (candidate_id, countries, categories, availability, salary_min, salary_currency, residence_country, needs_work_auth_support)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (candidate_id) DO UPDATE
         SET countries = EXCLUDED.countries, categories = EXCLUDED.categories, availability = EXCLUDED.availability,
             salary_min = EXCLUDED.salary_min, salary_currency = EXCLUDED.salary_currency,
             residence_country = EXCLUDED.residence_country, needs_work_auth_support = EXCLUDED.needs_work_auth_support,
             updated_at = now()`,
      [id, prefs.countries, prefs.categories, prefs.availability, prefs.salary_min, prefs.salary_currency, prefs.residence_country, prefs.needs_work_auth_support]
    );
    await audit(client, user, "profile.confirm", id, { actor, edited_fields: Object.keys(cleanEdits) });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getProfile({ user, candidateId: id });
}

/** Re-authorizes a signed download on every request. Returns null for anything not allowed. */
async function openFile({ user, key, signedUrl }) {
  const v = storage.verifyUrl(signedUrl);
  if (!v || v.key !== key || v.userId !== user.id) return null;
  const r = await db().query("SELECT candidate_id FROM js_cv_files WHERE storage_key = $1 ORDER BY id LIMIT 1", [key]);
  if (r.rowCount === 0) return null;
  try {
    await authorize(user, r.rows[0].candidate_id, "read");
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
  const buf = await storage.get(key);
  return { buf, mime: storage.sniffMime(buf) };
}

module.exports = { uploadCv, confirmProfile, getProfile, openFile, authorize, validatePreferences };
