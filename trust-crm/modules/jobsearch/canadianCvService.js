// Canadian-format CV versions: generation (staff), staff approval, candidate authorisation / withdrawal, listing and download.
//
// Lifecycle of a version (all rows of the version - the PDF and the DOCX - move together):
//   draft  --staff-approve (jobsearch:approve)-->  staff_approved  --authorise (the candidate, own record only)-->  authorised
//   authorised --withdraw-authorisation (candidate)--> withdrawn (blocks use immediately, cancels queued applications using it)
// Only an authorised version can be attached to an application (documentPolicy). Generating again always creates a NEW version;
// nothing is overwritten (the database refuses UPDATEs of a generated file's identity / content columns). Versions are numbered
// per candidate and language: CAN-2026-0001-CV-V1.pdf, ...-V2.pdf, and French ...-V1-FR.pdf.
// Audit rows never contain CV text, only codes, versions and hashes.
const { HttpError } = require("./httpError");
const { authorize } = require("./profileService");
const storage = require("./storage");
const consentService = require("./consentService");
const gen = require("./cvGenerator");
const { PERMISSIONS } = require("../../middleware/role");
const { auditJs } = require("../../utils/audit");

const db = () => require("../../db");

const MIME = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

const hasPerm = (user, perm) => {
  const perms = (user && PERMISSIONS[user.role]) || [];
  return perms.includes("*") || perms.includes(perm);
};

function parseLang(v) {
  const l = v === undefined || v === null || v === "" ? "en" : v;
  if (!gen.LANGS.includes(l)) throw new HttpError(400, "lang must be en or fr");
  return l;
}
function parseVersion(v) {
  const n = typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, "Not found");
  return n;
}
function parseFormats(v) {
  const f = v === undefined || v === null ? ["pdf", "docx"] : v;
  if (!Array.isArray(f) || f.length === 0 || f.length > 2 || f.some((x) => !gen.FORMATS.includes(x))) throw new HttpError(400, "formats must be a non-empty subset of pdf, docx");
  return [...new Set(f)];
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

async function event(client, candidateId, kind, payload) {
  await client.query("INSERT INTO js_events (candidate_id, kind, payload) VALUES ($1,$2,$3::jsonb)", [candidateId, kind, JSON.stringify(payload || {})]);
}

/** Staff with jobsearch:write in scope. Candidates and everyone else are refused (a foreign / unknown candidate is a 404). */
async function authorizeStaff(user, candidateId, level) {
  if (!user || user.role === "Candidate") throw new HttpError(403, "Staff access required");
  return authorize(user, candidateId, level);
}

async function ownCandidateId(user) {
  if (!user || user.role !== "Candidate") throw new HttpError(403, "A candidate account is required");
  const r = await db().query("SELECT candidate_id FROM js_candidate_accounts WHERE user_id = $1", [user.id]);
  if (r.rowCount === 0) throw new HttpError(404, "Not found");
  return r.rows[0].candidate_id;
}

// ---------------------------------------------------------------- generation

/**
 * @param {object} user  staff (jobsearch:write)
 * @returns {Promise<{version:number, lang:string, files:{id:number, format:string, name:string, sha256:string}[], missing:string[]}>}
 */
async function generateCanadianCv(user, candidateId, { lang, formats } = {}) {
  const id = await authorizeStaff(user, candidateId, "write");
  const L = parseLang(lang);
  const fmts = parseFormats(formats);

  const prof = (await db().query("SELECT confirmed, status, confirmed_at FROM js_profiles WHERE candidate_id = $1", [id])).rows[0];
  if (!prof || prof.status !== "confirmed") throw new HttpError(409, "The candidate profile must be confirmed before a Canadian CV can be generated");
  const cand = (await db().query("SELECT city FROM candidates WHERE id = $1 AND is_deleted = false", [id])).rows[0];
  if (!cand) throw new HttpError(404, "Not found");
  const pref = (await db().query("SELECT residence_country FROM js_preferences WHERE candidate_id = $1", [id])).rows[0];

  const model = gen.buildCvModel(prof.confirmed, { city: cand.city, country: pref && pref.residence_country }, { lang: L });
  if (model.refusal) {
    const why = model.refusal.reasons.map((r) => (r === "name" ? "a name" : "at least one experience or education entry")).join(" and ");
    throw new HttpError(422, `A Canadian CV cannot be generated: the confirmed profile has no ${why}`);
  }
  const srcHash = gen.profileHash(prof.confirmed);

  const bytes = {};
  for (const f of fmts) {
    try {
      bytes[f] = f === "pdf" ? await gen.renderPdf(model) : await gen.renderDocx(model);
    } catch (err) {
      if (err && err.code === "LATIN_SPELLING_NEEDED") throw new HttpError(422, err.message);
      throw err;
    }
  }
  const stored = {};
  for (const f of fmts) {
    try {
      stored[f] = await storage.put(bytes[f], { candidateId: id });
    } catch (err) {
      if (err && err.code === "FILE_TOO_LARGE") throw new HttpError(413, "The generated file is too large");
      throw err;
    }
  }

  return inTx(async (client) => {
    await client.query("SELECT id FROM candidates WHERE id = $1 FOR UPDATE", [id]);
    const cur = (await client.query("SELECT confirmed, status FROM js_profiles WHERE candidate_id = $1", [id])).rows[0];
    if (!cur || cur.status !== "confirmed" || gen.profileHash(cur.confirmed) !== srcHash) {
      throw new HttpError(409, "The candidate profile changed while the CV was being generated; please try again");
    }
    let ref = (await client.query("SELECT reference FROM candidates WHERE id = $1", [id])).rows[0].reference;
    if (!ref) ref = (await client.query("SELECT assign_candidate_reference($1) AS ref", [id])).rows[0].ref;
    const version = (await client.query("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM js_cv_files WHERE candidate_id = $1 AND kind = 'canadian' AND language = $2", [id, L])).rows[0].n;
    const files = [];
    for (const f of fmts) {
      const name = gen.canonicalName(ref, version, L, f);
      const row = (await client.query(
        `INSERT INTO js_cv_files (candidate_id, storage_key, sha256, version, language, approved, original, scan_status, scan_detail, kind, format, canonical_name,
                                  source_profile_hash, source_profile_confirmed_at, generated_by, generated_at, missing)
         VALUES ($1,$2,$3,$4,$5,false,false,'clean','system_generated','canadian',$6,$7,$8,$9,$10,now(),$11::jsonb) RETURNING id`,
        [id, stored[f].key, stored[f].sha256, version, L, f, name, srcHash, prof.confirmed_at, user.id, JSON.stringify(model.missing)]
      )).rows[0];
      files.push({ id: row.id, format: f, name, sha256: stored[f].sha256 });
    }
    const detail = { version, lang: L, formats: fmts, files: files.map((x) => ({ id: x.id, format: x.format, sha256: x.sha256 })), missing: model.missing, source_profile_hash: srcHash };
    await auditJs({ client, userId: user.id, action: "canadian_cv.generate", entity: "js_cv_files", entityId: files[0].id, detail, candidateId: id });
    await event(client, id, "canadian_cv.generated", { version, lang: L, formats: fmts });
    return { version, lang: L, files, missing: model.missing };
  });
}

// ---------------------------------------------------------------- listing

function statusOf(r) {
  if (r.candidate_withdrawn_at) return "withdrawn";
  if (r.candidate_authorised_at) return "authorised";
  if (r.staff_approved_at) return "staff_approved";
  return "draft";
}

/** Rows grouped into versions. `forCandidate` hides drafts, hashes and staff identities. Never exposes storage keys. */
function present(rows, { forCandidate, profHash }) {
  const byKey = new Map();
  for (const r of rows) {
    if (forCandidate && !r.staff_approved_at) continue;
    const k = `${r.language}:${r.version}`;
    if (!byKey.has(k)) {
      byKey.set(k, {
        version: r.version,
        lang: r.language,
        status: statusOf(r),
        missing: r.missing,
        stale: profHash !== r.source_profile_hash,
        generated_at: r.generated_at,
        staff_approved_at: r.staff_approved_at,
        candidate_authorised_at: r.candidate_authorised_at,
        candidate_withdrawn_at: r.candidate_withdrawn_at,
        ...(forCandidate ? {} : { generated_by: r.generated_by, staff_approved_by: r.staff_approved_by }),
        files: [],
      });
    }
    byKey.get(k).files.push({ id: r.id, format: r.format, name: r.canonical_name, ...(forCandidate ? {} : { sha256: r.sha256 }) });
  }
  return [...byKey.values()].sort((a, b) => a.lang.localeCompare(b.lang) || b.version - a.version);
}

async function profileHashNow(client, candidateId) {
  const p = (await client.query("SELECT confirmed, status FROM js_profiles WHERE candidate_id = $1", [candidateId])).rows[0];
  return p && p.status === "confirmed" ? gen.profileHash(p.confirmed) : null;
}

async function listRows(candidateId) {
  return (await db().query("SELECT * FROM js_cv_files WHERE candidate_id = $1 AND kind = 'canadian' ORDER BY language, version DESC, format", [candidateId])).rows;
}

async function listCanadianCvs(user, candidateId) {
  const id = await authorizeStaff(user, candidateId, "read");
  return { candidate_id: id, versions: present(await listRows(id), { forCandidate: false, profHash: await profileHashNow(db(), id) }) };
}

async function listOwnCanadianCvs(user) {
  const id = await ownCandidateId(user);
  return { versions: present(await listRows(id), { forCandidate: true, profHash: await profileHashNow(db(), id) }) };
}

// ---------------------------------------------------------------- approval / authorisation

async function lockVersion(client, candidateId, lang, version) {
  await client.query("SELECT id FROM candidates WHERE id = $1 FOR UPDATE", [candidateId]);
  const rows = (await client.query("SELECT * FROM js_cv_files WHERE candidate_id = $1 AND kind = 'canadian' AND language = $2 AND version = $3 ORDER BY id FOR UPDATE", [candidateId, lang, version])).rows;
  if (!rows.length) throw new HttpError(404, "Not found");
  return rows;
}

const versionOut = (rows, extra = {}) => ({ version: rows[0].version, lang: rows[0].language, status: statusOf(rows[0]), files: rows.map((r) => ({ id: r.id, format: r.format, name: r.canonical_name })), ...extra });

/** Staff approval of a whole version (its PDF and DOCX together). jobsearch:approve (Manager / Admin / SuperAdmin) in scope; Agent cannot. */
async function staffApproveVersion(user, candidateId, version, lang) {
  const id = await authorizeStaff(user, candidateId, "read"); // 404 outside scope / without jobsearch access, before any permission hint
  if (!hasPerm(user, "jobsearch:approve")) throw new HttpError(403, "Approving a Canadian CV requires a manager or administrator");
  const L = parseLang(lang);
  const v = parseVersion(version);
  return inTx(async (client) => {
    const rows = await lockVersion(client, id, L, v);
    if (rows.every((r) => r.staff_approved_at)) return versionOut(rows, { changed: false });
    const hash = await profileHashNow(client, id);
    if (hash !== rows[0].source_profile_hash) throw new HttpError(409, "The profile changed after this version was generated; generate a new version");
    const upd = (await client.query(
      "UPDATE js_cv_files SET approved = true, staff_approved_by = $2, staff_approved_at = now() WHERE candidate_id = $1 AND kind = 'canadian' AND language = $3 AND version = $4 RETURNING *",
      [id, user.id, L, v]
    )).rows;
    await auditJs({ client, userId: user.id, action: "canadian_cv.staff_approve", entity: "js_cv_files", entityId: upd[0].id, detail: { version: v, lang: L, files: upd.map((r) => ({ id: r.id, format: r.format, sha256: r.sha256 })) }, candidateId: id });
    await event(client, id, "canadian_cv.staff_approved", { version: v, lang: L });
    return versionOut(upd, { changed: true });
  });
}

/** POST /cv-files/:fileId/staff-approve: approves the whole version the file belongs to. */
async function staffApproveByFile(user, fileId) {
  if (!user || user.role === "Candidate") throw new HttpError(403, "Staff access required");
  const n = typeof fileId === "string" && /^\d{1,9}$/.test(fileId) ? Number(fileId) : null;
  if (!n) throw new HttpError(404, "Not found");
  const r = (await db().query("SELECT candidate_id, language, version FROM js_cv_files WHERE id = $1 AND kind = 'canadian'", [n])).rows[0];
  if (!r) throw new HttpError(404, "Not found");
  return staffApproveVersion(user, r.candidate_id, r.version, r.language);
}

/** The candidate authorises the CONTENT and the DISTRIBUTION of one version, after staff approval. Own record only. */
async function authoriseOwn(user, version, lang) {
  const id = await ownCandidateId(user);
  const L = parseLang(lang);
  const v = parseVersion(version);
  return inTx(async (client) => {
    const rows = await lockVersion(client, id, L, v);
    if (rows.some((r) => !r.staff_approved_at)) throw new HttpError(409, "This version has not been approved by staff yet");
    if (rows.every((r) => r.candidate_authorised_at && !r.candidate_withdrawn_at)) return versionOut(rows, { changed: false });
    if ((await profileHashNow(client, id)) !== rows[0].source_profile_hash) throw new HttpError(409, "Your profile changed after this version was generated; ask staff for a new version");
    const upd = (await client.query(
      "UPDATE js_cv_files SET candidate_authorised_by = $2, candidate_authorised_at = now(), candidate_withdrawn_at = NULL WHERE candidate_id = $1 AND kind = 'canadian' AND language = $3 AND version = $4 RETURNING *",
      [id, user.id, L, v]
    )).rows;
    await auditJs({ client, userId: user.id, action: "canadian_cv.authorise", entity: "js_cv_files", entityId: upd[0].id, detail: { version: v, lang: L, scope: "content_and_distribution", files: upd.map((r) => ({ id: r.id, format: r.format, sha256: r.sha256 })) }, candidateId: id });
    await event(client, id, "canadian_cv.authorised", { version: v, lang: L });
    return versionOut(upd, { changed: true });
  });
}

/** Withdraws the authorisation: the version can no longer be attached, and queued / approved applications using it are cancelled. */
async function withdrawOwn(user, version, lang) {
  const id = await ownCandidateId(user);
  const L = parseLang(lang);
  const v = parseVersion(version);
  return inTx(async (client) => {
    const rows = await lockVersion(client, id, L, v);
    if (!rows.some((r) => r.candidate_authorised_at && !r.candidate_withdrawn_at)) return versionOut(rows, { changed: false, cancelledApplications: 0 });
    const upd = (await client.query(
      "UPDATE js_cv_files SET candidate_withdrawn_at = now() WHERE candidate_id = $1 AND kind = 'canadian' AND language = $2 AND version = $3 RETURNING *",
      [id, L, v]
    )).rows;
    const apps = (await client.query(
      `SELECT DISTINCT a.id FROM js_applications a JOIN js_application_documents d ON d.application_id = a.id AND d.removed_at IS NULL
        WHERE a.candidate_id = $1 AND d.cv_file_id = ANY($2::int[]) AND a.status IN ('queued','approved')`,
      [id, upd.map((r) => r.id)]
    )).rows.map((r) => r.id);
    const cancelled = apps.length
      ? await consentService.cancelQueuedForCandidate(id, "canadian_cv_authorisation_withdrawn", client, { includeReady: false, actor: "candidate", onlyApplicationIds: apps })
      : 0;
    await auditJs({ client, userId: user.id, action: "canadian_cv.withdraw_authorisation", entity: "js_cv_files", entityId: upd[0].id, detail: { version: v, lang: L, cancelled_applications: cancelled }, candidateId: id });
    await event(client, id, "canadian_cv.authorisation_withdrawn", { version: v, lang: L, cancelled_applications: cancelled });
    return versionOut(upd, { changed: true, cancelledApplications: cancelled });
  });
}

// ---------------------------------------------------------------- download

async function readVersionFile({ candidateId, version, lang, format, forCandidate }) {
  const L = parseLang(lang);
  const v = parseVersion(version);
  if (format !== "pdf" && format !== "docx") throw new HttpError(400, "format must be pdf or docx");
  const row = (await db().query(
    "SELECT * FROM js_cv_files WHERE candidate_id = $1 AND kind = 'canadian' AND language = $2 AND version = $3 AND format = $4",
    [candidateId, L, v, format]
  )).rows[0];
  if (!row || (forCandidate && !row.staff_approved_at)) throw new HttpError(404, "Not found");
  let buf;
  try {
    buf = await storage.get(row.storage_key);
  } catch {
    throw new HttpError(404, "Not found");
  }
  if (require("crypto").createHash("sha256").update(buf).digest("hex") !== row.sha256) throw new HttpError(409, "The stored file failed its integrity check");
  return { buf, mime: MIME[format], filename: gen.safeDownloadName(row.canonical_name, { version: row.version, format }), row };
}

async function downloadStaff(user, candidateId, { version, lang, format }) {
  const id = await authorizeStaff(user, candidateId, "read");
  const out = await readVersionFile({ candidateId: id, version, lang, format, forCandidate: false });
  await auditJs({ userId: user.id, action: "canadian_cv.download", entity: "js_cv_files", entityId: out.row.id, detail: { version: out.row.version, lang: out.row.language, format }, candidateId: id });
  return out;
}

async function downloadOwn(user, { version, lang, format }) {
  const id = await ownCandidateId(user);
  const out = await readVersionFile({ candidateId: id, version, lang, format, forCandidate: true });
  await auditJs({ userId: user.id, action: "canadian_cv.download", entity: "js_cv_files", entityId: out.row.id, detail: { version: out.row.version, lang: out.row.language, format, own: true }, candidateId: id });
  return out;
}

module.exports = {
  generateCanadianCv,
  listCanadianCvs,
  listOwnCanadianCvs,
  staffApproveVersion,
  staffApproveByFile,
  authoriseOwn,
  withdrawOwn,
  downloadStaff,
  downloadOwn,
};
