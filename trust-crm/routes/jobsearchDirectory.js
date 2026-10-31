// Employer directory, automation rules and the employer-confirmation list (Task 18), mounted at /jobsearch:
//   GET    /employers                    ?q&province&status&page&pageSize  staff (jobsearch:read): admins see all; other staff see
//                                        employers of jobs their (non-deleted) candidates have applications for
//   PUT    /employers/:id                {domain?, verifiedContactEmail?, name?}  jobsearch:admin ONLY (Task 19: domain
//                                        and verifiedContactEmail decide where automatic sends go; Task 20: a rename
//                                        re-keys matching by normalized name and can redirect where verified contacts
//                                        apply, so Managers may not rename either). Domain normalised (URL/www/trailing dot, IDN ->
//                                        punycode); free-mail domains, e-mail addresses, ports and IPs refused;
//                                        normalized names stay unique; audited (before/after)
//   GET    /employers/:id                detail (province, city, industry, phone, recruiter, sourceUrls, eligibilityNote, status,
//                                        lastVerifiedAt); `notes` (staff-only) only for jobsearch:admin; same scope as the list (404 outside it)
//   PATCH  /employers/:id                {province?, city?, industry?, phone?, recruiterContactName?, sourceUrls?, eligibilityNote?,
//                                        status?, lastVerifiedAt?, notes?}  jobsearch:admin ONLY (DECISIONS #10), strict validation, audited
//   GET    /employers/:id/history        contact history (applications, submissions, messages), scoped by candidateScopeSql; other
//                                        candidates' contacts are a single number (contactedByOtherCandidates)
//   GET    /suppressions                 ?kind&source&q&page&pageSize  staff (jobsearch:read)
//   POST   /suppressions                 {kind: email|domain, value, reason?, employerId?}  staff (jobsearch:write); 201 new / 200 existing
//   DELETE /suppressions/:id             {reason}  jobsearch:admin ONLY; audited (the do-not-contact list is never shortened silently)
//   GET    /automation-rules             ?candidateId  jobsearch:admin
//   POST   /automation-rules             {candidateId, type: auto_submit|ack_reply, countries?, professions?,
//                                        sources?, employerIds?, note?}  jobsearch:admin; approved_by = caller
//   DELETE /automation-rules/:id         jobsearch:admin; disables the rule (active=false, history kept)
//   GET    /employer-confirmations       ?active=true  admin (same audience as POST/DELETE /employer-confirmations)
const express = require("express");
const url = require("url");
const { verifyToken } = require("../middleware/auth");
const { PERMISSIONS } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const { HttpError } = require("../modules/jobsearch/httpError");
const { candidateScopeSql, isAdmin } = require("../modules/jobsearch/scope");
const guard = require("../modules/jobsearch/guard");
const { normalizeEmployer } = require("../modules/jobsearch/jobStore");
const { sanitizeUntrusted } = require("../modules/jobsearch/matching/sanitize");
const { auditJs } = require("../utils/audit");
const suppression = require("../modules/jobsearch/suppression");
const employerHistory = require("../modules/jobsearch/employerHistory");

const router = express.Router();
const db = () => require("../db");
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
const posInt = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);
const likeEscape = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function hasPerm(user, perm) {
  const perms = (user && PERMISSIONS[user.role]) || [];
  return perms.includes("*") || perms.includes(perm);
}
function needStaff(user, perm) {
  if (!user || user.role === "Candidate" || !hasPerm(user, perm)) throw new HttpError(403, "Staff access required");
}
function needAdmin(user) {
  if (!hasPerm(user, "jobsearch:admin")) throw new HttpError(403, "Administrator access required");
}
function paging(q) {
  const pageSize = Math.min(Math.max(parseInt(q.pageSize, 10) || 50, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  if (page > 10000) throw new HttpError(400, "page must be at most 10000");
  return { page, pageSize };
}

// ---------------------------------------------------------------- employers

/** WHERE fragment restricting js_employers e to the caller's scope (admins: everything). */
function employerScope(user, offset) {
  if (isAdmin(user)) return { clause: "TRUE", params: [] };
  const { clause, params } = candidateScopeSql(user, "c", offset);
  return {
    clause: `EXISTS (SELECT 1 FROM js_jobs j JOIN js_applications a ON a.job_id = j.id JOIN candidates c ON c.id = a.candidate_id
                     WHERE j.employer_id = e.id AND c.is_deleted = false AND ${clause})`,
    params,
  };
}

const PROVINCES = Object.freeze(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);
const EMPLOYER_STATUSES = Object.freeze(["new", "verified", "contacted", "replied", "opted_out", "blocked"]);
const MAX_SOURCE_URLS = 20;
const MAX_URL = 500;

function presentEmployer(e) {
  return {
    id: e.id,
    name: e.name,
    domain: e.domain || null,
    domainUnicode: e.domain ? url.domainToUnicode(e.domain) || e.domain : null,
    verifiedContactEmail: e.verified_contact_email || null,
    province: e.province || null,
    city: e.city || null,
    industry: e.industry || null,
    status: e.status || "new",
    lastVerifiedAt: e.last_verified_at || null,
    jobs: e.jobs === undefined ? undefined : Number(e.jobs),
    applications: e.applications === undefined ? undefined : Number(e.applications),
  };
}

/** Detail view. `notes` are staff-only: included only for the roles that may edit employers (jobsearch:admin). */
async function presentEmployerDetail(e, user) {
  const canEdit = hasPerm(user, "jobsearch:admin");
  const out = {
    ...presentEmployer(e),
    phone: e.phone || null,
    recruiterContactName: e.recruiter_contact_name || null,
    sourceUrls: Array.isArray(e.source_urls) ? e.source_urls : [],
    eligibilityNote: e.eligibility_note || null,
    createdAt: e.created_at,
    canEdit,
  };
  const probes = [e.verified_contact_email, e.domain ? `postmaster@${e.domain}` : null].filter(Boolean);
  let hit = null;
  for (const p of probes) hit = hit || (await suppression.findSuppression(db(), p));
  out.suppressed = Boolean(hit);
  if (canEdit) out.notes = e.notes || null;
  return out;
}

router.get("/employers", verifyToken, asyncHandler(async (req, res) => {
  needStaff(req.user, "jobsearch:read");
  const { page, pageSize } = paging(req.query);
  const scope = employerScope(req.user, 0);
  const where = [scope.clause];
  const params = [...scope.params];
  if (typeof req.query.q === "string" && req.query.q.trim()) {
    params.push(`%${likeEscape(req.query.q.trim().slice(0, 100))}%`);
    where.push(`(e.name ILIKE $${params.length} OR e.domain ILIKE $${params.length})`);
  }
  if (req.query.province !== undefined) {
    if (typeof req.query.province !== "string" || !PROVINCES.includes(req.query.province)) throw new HttpError(400, `province must be one of ${PROVINCES.join(", ")}`);
    params.push(req.query.province);
    where.push(`e.province = $${params.length}`);
  }
  if (req.query.status !== undefined) {
    if (typeof req.query.status !== "string" || !EMPLOYER_STATUSES.includes(req.query.status)) throw new HttpError(400, `status must be one of ${EMPLOYER_STATUSES.join(", ")}`);
    params.push(req.query.status);
    where.push(`e.status = $${params.length}`);
  }
  const w = `WHERE ${where.join(" AND ")}`;
  const total = (await db().query(`SELECT count(*)::int AS n FROM js_employers e ${w}`, params)).rows[0].n;
  const rows = (await db().query(
    `SELECT e.*, (SELECT count(*) FROM js_jobs j WHERE j.employer_id = e.id) AS jobs,
            (SELECT count(*) FROM js_applications a JOIN js_jobs j ON j.id = a.job_id WHERE j.employer_id = e.id) AS applications
       FROM js_employers e ${w} ORDER BY lower(e.name), e.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize]
  )).rows;
  res.json({ employers: rows.map(presentEmployer), page, pageSize, total });
}));

/** One employer the caller may see (same scope as the list), or a 404. */
async function loadEmployer(user, rawId, c = db(), { lock = false } = {}) {
  const id = posInt(rawId);
  if (!id) throw new HttpError(404, "Not found");
  const scope = employerScope(user, 1);
  const row = (await c.query(`SELECT e.* FROM js_employers e WHERE e.id = $1 AND ${scope.clause}${lock ? " FOR UPDATE OF e" : ""}`, [id, ...scope.params])).rows[0];
  if (!row) throw new HttpError(404, "Not found");
  return row;
}

router.get("/employers/:id", verifyToken, asyncHandler(async (req, res) => {
  needStaff(req.user, "jobsearch:read");
  const e = await loadEmployer(req.user, req.params.id);
  res.set("Cache-Control", "no-store").json(await presentEmployerDetail(e, req.user));
}));

router.get("/employers/:id/history", verifyToken, asyncHandler(async (req, res) => {
  needStaff(req.user, "jobsearch:read");
  const e = await loadEmployer(req.user, req.params.id);
  const h = await employerHistory.historyFor(db(), req.user, e.id, { detail: true });
  res.set("Cache-Control", "no-store").json({ employer: { id: e.id, name: e.name, status: e.status }, ...h });
}));

// ---- PATCH /employers/:id (administrator only; the profile fields, not the name / domain / contact that decide where mail goes)

const PATCH_FIELDS = ["province", "city", "industry", "phone", "recruiterContactName", "sourceUrls", "eligibilityNote", "status", "lastVerifiedAt", "notes"];
const PATCH_COLUMN = { province: "province", city: "city", industry: "industry", phone: "phone", recruiterContactName: "recruiter_contact_name", sourceUrls: "source_urls", eligibilityNote: "eligibility_note", status: "status", lastVerifiedAt: "last_verified_at", notes: "notes" };

function cleanText(v, key, max, { multiline = false } = {}) {
  if (v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${key} must be a string or null`);
  let s = v.normalize("NFC").replace(/\r\n?/g, "\n");
  s = multiline ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]+/g, " ") : s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ");
  s = s.trim();
  if (s.length > max) throw new HttpError(400, `${key} must be at most ${max} characters`);
  return s || null;
}

function cleanPhone(v) {
  if (v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, "phone must be a string or null");
  const s = v.trim();
  if (!s) return null;
  if (!/^[0-9+().\- ]{5,30}$/.test(s) || (s.match(/[0-9]/g) || []).length < 5) throw new HttpError(400, "phone must be a telephone number (digits, spaces, + ( ) . -)");
  return s;
}

/** Array of at most 20 http(s) URLs without credentials; returned canonical and de-duplicated. */
function cleanSourceUrls(v) {
  if (!Array.isArray(v)) throw new HttpError(400, `sourceUrls must be an array of at most ${MAX_SOURCE_URLS} http(s) URLs`);
  if (v.length > MAX_SOURCE_URLS) throw new HttpError(400, `sourceUrls must hold at most ${MAX_SOURCE_URLS} URLs`);
  const out = [];
  for (const raw of v) {
    if (typeof raw !== "string" || !raw || raw.length > MAX_URL) throw new HttpError(400, `each source URL must be a string of at most ${MAX_URL} characters`);
    if (/[\s\u0000-\u001f\u007f]/.test(raw)) throw new HttpError(400, "a source URL must not contain spaces or control characters");
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new HttpError(400, "a source URL is not a valid URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "a source URL must start with http:// or https://");
    if (u.username || u.password) throw new HttpError(400, "a source URL must not contain credentials");
    if (!u.hostname) throw new HttpError(400, "a source URL needs a host");
    if (!out.includes(u.href)) out.push(u.href);
  }
  return out;
}

function cleanVerifiedAt(v) {
  if (v === null) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(v.trim())) throw new HttpError(400, "lastVerifiedAt must be an ISO date or date-time, or null");
  const t = Date.parse(v.trim());
  if (!Number.isFinite(t)) throw new HttpError(400, "lastVerifiedAt is not a valid date");
  if (t > Date.now() + 24 * 3600 * 1000) throw new HttpError(400, "lastVerifiedAt must not be in the future");
  return new Date(t).toISOString();
}

function validateEmployerPatch(b) {
  const unknown = Object.keys(b).filter((k) => !PATCH_FIELDS.includes(k));
  if (unknown.length) throw new HttpError(400, `Unknown field(s): ${unknown.join(", ")} (name, domain and verifiedContactEmail are changed with PUT)`);
  if (!PATCH_FIELDS.some((k) => k in b)) throw new HttpError(400, `Nothing to change: send ${PATCH_FIELDS.join(", ")}`);
  const patch = {};
  if ("province" in b) {
    if (b.province !== null && !PROVINCES.includes(b.province)) throw new HttpError(400, `province must be one of ${PROVINCES.join(", ")} or null`);
    patch.province = b.province;
  }
  if ("city" in b) patch.city = cleanText(b.city, "city", 100);
  if ("industry" in b) patch.industry = cleanText(b.industry, "industry", 100);
  if ("phone" in b) patch.phone = cleanPhone(b.phone);
  if ("recruiterContactName" in b) patch.recruiterContactName = cleanText(b.recruiterContactName, "recruiterContactName", 120);
  if ("sourceUrls" in b) patch.sourceUrls = cleanSourceUrls(b.sourceUrls);
  if ("eligibilityNote" in b) patch.eligibilityNote = cleanText(b.eligibilityNote, "eligibilityNote", 1000, { multiline: true });
  if ("status" in b) {
    if (!EMPLOYER_STATUSES.includes(b.status)) throw new HttpError(400, `status must be one of ${EMPLOYER_STATUSES.join(", ")}`);
    patch.status = b.status;
  }
  if ("lastVerifiedAt" in b) patch.lastVerifiedAt = cleanVerifiedAt(b.lastVerifiedAt);
  if ("notes" in b) patch.notes = cleanText(b.notes, "notes", 4000, { multiline: true });
  // Marking an employer verified stamps the verification time unless the caller states one.
  if (patch.status === "verified" && !("lastVerifiedAt" in patch)) patch.lastVerifiedAt = new Date().toISOString();
  return patch;
}

router.patch("/employers/:id", verifyToken, asyncHandler(async (req, res) => {
  const user = req.user;
  if (!hasPerm(user, "jobsearch:admin")) throw new HttpError(403, "Only an administrator (jobsearch:admin) can edit an employer's record");
  const id = posInt(req.params.id);
  if (!id) throw new HttpError(404, "Not found");
  const patch = validateEmployerPatch(body(req));
  const client = await db().connect();
  let out;
  try {
    await client.query("BEGIN");
    const cur = await loadEmployer(user, id, client, { lock: true });
    const keys = Object.keys(patch);
    const row = (await client.query(
      `UPDATE js_employers SET ${keys.map((k, i) => `${PATCH_COLUMN[k]} = $${i + 2}${k === "sourceUrls" ? "::jsonb" : ""}`).join(", ")} WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => (k === "sourceUrls" ? JSON.stringify(patch[k]) : patch[k]))]
    )).rows[0];
    // Free-text notes are staff-only: the audit row records THAT they changed, never their content.
    const view = (r) => {
      const v = {};
      for (const k of keys) v[k] = k === "notes" ? (r.notes ? "set" : null) : k === "sourceUrls" ? r.source_urls : r[PATCH_COLUMN[k]] instanceof Date ? r[PATCH_COLUMN[k]].toISOString() : r[PATCH_COLUMN[k]];
      return v;
    };
    const after = view(row);
    if ("notes" in patch && (cur.notes || null) !== (row.notes || null)) after.notes = "changed";
    await auditJs({ userId: user.id, action: "employer.profile_update", entity: "js_employers", entityId: id, detail: { employerId: id, fields: keys, before: view(cur), after }, client });
    await client.query("COMMIT");
    out = row;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json(await presentEmployerDetail(out, user));
}));

// ---------------------------------------------------------------- suppressions (do-not-contact list)

function presentSuppression(r) {
  return { id: Number(r.id), kind: r.kind, value: r.value, reason: r.reason || null, source: r.source, employerId: r.employer_id || null, messageId: r.message_id || null, createdBy: r.created_by || null, createdAt: r.created_at };
}

router.get("/suppressions", verifyToken, asyncHandler(async (req, res) => {
  needStaff(req.user, "jobsearch:read");
  const { page, pageSize } = paging(req.query);
  const where = ["TRUE"];
  const params = [];
  if (req.query.kind !== undefined) {
    if (typeof req.query.kind !== "string" || !suppression.KINDS.includes(req.query.kind)) throw new HttpError(400, "kind must be email or domain");
    params.push(req.query.kind);
    where.push(`kind = $${params.length}`);
  }
  if (req.query.source !== undefined) {
    if (typeof req.query.source !== "string" || !suppression.SOURCES.includes(req.query.source)) throw new HttpError(400, "source must be manual, reply_opt_out or bounce");
    params.push(req.query.source);
    where.push(`source = $${params.length}`);
  }
  if (typeof req.query.q === "string" && req.query.q.trim()) {
    params.push(`%${likeEscape(req.query.q.trim().toLowerCase().slice(0, 100))}%`);
    where.push(`value LIKE $${params.length}`);
  }
  const w = `WHERE ${where.join(" AND ")}`;
  const total = (await db().query(`SELECT count(*)::int AS n FROM js_suppressions ${w}`, params)).rows[0].n;
  const rows = (await db().query(`SELECT * FROM js_suppressions ${w} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pageSize, (page - 1) * pageSize])).rows;
  res.set("Cache-Control", "no-store").json({ suppressions: rows.map(presentSuppression), page, pageSize, total });
}));

router.post("/suppressions", verifyToken, asyncHandler(async (req, res) => {
  needStaff(req.user, "jobsearch:write");
  const b = body(req);
  const unknown = Object.keys(b).filter((k) => !["kind", "value", "reason", "employerId"].includes(k));
  if (unknown.length) throw new HttpError(400, `Unknown field(s): ${unknown.join(", ")}`);
  const client = await db().connect();
  let result;
  try {
    await client.query("BEGIN");
    result = await suppression.addSuppression(client, { kind: b.kind, value: b.value, reason: b.reason, employerId: b.employerId, createdBy: req.user.id });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.status(result.created ? 201 : 200).json(presentSuppression(result.row));
}));

router.delete("/suppressions/:id", verifyToken, asyncHandler(async (req, res) => {
  needAdmin(req.user);
  const id = posInt(req.params.id);
  if (!id) throw new HttpError(404, "Not found");
  const client = await db().connect();
  let out;
  try {
    await client.query("BEGIN");
    out = await suppression.removeSuppression(client, { id, actor: req.user, reason: body(req).reason });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json(out);
}));

/**
 * Employer domain for recipient verification: "https://www.Bücher.de/jobs" -> "xn--bcher-gsa.de".
 * Refuses e-mail addresses, ports, IP addresses, malformed labels and free-mail providers.
 * @returns {string|null} ASCII (punycode) domain, null to clear
 */
function cleanDomain(raw) {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 255) throw new HttpError(400, "domain must be a domain name such as employer.com");
  let s = raw.normalize("NFKC").trim().toLowerCase();
  if (!s) return null;
  if (s.includes("@")) throw new HttpError(400, "domain must be a domain name, not an e-mail address (use verifiedContactEmail)");
  if (/\s/.test(s)) throw new HttpError(400, "domain must not contain spaces");
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      throw new HttpError(400, "domain is not a valid domain name");
    }
  }
  s = s.split("/")[0].replace(/\.+$/, "");
  if (s.includes(":") || s.includes("[")) throw new HttpError(400, "domain must not contain a port or an IP address");
  if (/[^\x00-\x7f]/.test(s)) {
    const ascii = url.domainToASCII(s);
    if (!ascii) throw new HttpError(400, "domain is not a valid internationalised domain name");
    s = ascii;
  }
  const d = guard.normalizeDomain(s);
  if (!d) throw new HttpError(400, "domain is not a valid domain name");
  if (guard.isFreeMail(d)) throw new HttpError(400, "A free-mail provider cannot be an employer's domain (set verifiedContactEmail for a free-mail recruiter instead)");
  return d;
}

function cleanContact(raw) {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new HttpError(400, "verifiedContactEmail must be a plain e-mail address");
  const e = guard.normalizeEmail(raw);
  if (!e) throw new HttpError(400, "verifiedContactEmail must be a plain e-mail address (no display name, list or non-ASCII characters)");
  return e;
}

router.put("/employers/:id", verifyToken, asyncHandler(async (req, res) => {
  const user = req.user;
  if (!hasPerm(user, "jobsearch:admin")) throw new HttpError(403, "Only an administrator (jobsearch:admin) can change an employer's name, domain and verifiedContactEmail");
  const id = posInt(req.params.id);
  if (!id) throw new HttpError(404, "Not found");
  const b = body(req);
  const allowed = ["domain", "verifiedContactEmail", "name"];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new HttpError(400, `Unknown field(s): ${unknown.join(", ")}`);
  if (!allowed.some((k) => k in b)) throw new HttpError(400, "Nothing to change: send domain, verifiedContactEmail and/or name");
  const patch = {};
  if ("domain" in b) patch.domain = cleanDomain(b.domain);
  if ("verifiedContactEmail" in b) patch.verified_contact_email = cleanContact(b.verifiedContactEmail);
  if ("name" in b) {
    const name = typeof b.name === "string" ? sanitizeUntrusted(b.name, 200).replace(/\s+/g, " ").trim() : "";
    if (!name) throw new HttpError(400, "name must be a non-empty string");
    const norm = normalizeEmployer(name);
    if (!norm) throw new HttpError(400, "name must contain letters or digits");
    patch.name = name;
    patch.normalized_name = norm;
  }
  const client = await db().connect();
  let out;
  try {
    await client.query("BEGIN");
    const scope = employerScope(user, 1);
    const cur = (await client.query(`SELECT e.* FROM js_employers e WHERE e.id = $1 AND ${scope.clause} FOR UPDATE`, [id, ...scope.params])).rows[0];
    if (!cur) throw new HttpError(404, "Not found");
    if (patch.normalized_name && patch.normalized_name !== cur.normalized_name) {
      // Jobs attach to employers by normalized name: two rows with the same one would split a company.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`js_employer_name:${patch.normalized_name}`]);
      const clash = (await client.query("SELECT id FROM js_employers WHERE normalized_name = $1 AND id <> $2 ORDER BY id LIMIT 1", [patch.normalized_name, id])).rows[0];
      if (clash) throw new HttpError(409, `Another employer already has this name (#${clash.id})`);
    }
    const cols = Object.keys(patch);
    const row = (await client.query(
      `UPDATE js_employers SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
      [id, ...cols.map((c) => patch[c])]
    )).rows[0];
    const view = (r) => {
      const v = {};
      if ("domain" in patch) v.domain = r.domain || null;
      if ("verified_contact_email" in patch) v.verifiedContactEmail = r.verified_contact_email || null;
      if ("name" in patch) v.name = r.name;
      return v;
    };
    await auditJs({ userId: user.id, action: "employer.update", entity: "js_employers", entityId: id, detail: { employerId: id, before: view(cur), after: view(row) }, client });
    await client.query("COMMIT");
    out = row;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json(presentEmployer(out));
}));

// ---------------------------------------------------------------- automation rules

const RULE_TYPES = ["auto_submit", "ack_reply"];
const LIST_MAX = 50;
function stringList(v, key, { pattern } = {}) {
  if (!Array.isArray(v) || !v.length || v.length > LIST_MAX) throw new HttpError(400, `${key} must be a non-empty array of at most ${LIST_MAX} strings`);
  const out = [];
  for (const x of v) {
    if (typeof x !== "string") throw new HttpError(400, `${key} must contain strings only`);
    const s = x.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!s || s.length > 100) throw new HttpError(400, `each ${key} entry must be 1-100 characters`);
    if (pattern && !pattern.test(s)) throw new HttpError(400, `${key} entry "${s.slice(0, 40)}" is not valid`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

async function validateRule(client, b) {
  const allowed = ["candidateId", "type", "countries", "professions", "sources", "employerIds", "note"];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new HttpError(400, `Unknown field(s): ${unknown.join(", ")}`);
  const candidateId = posInt(b.candidateId);
  if (!candidateId) throw new HttpError(400, "candidateId must be a positive integer");
  if (!RULE_TYPES.includes(b.type)) throw new HttpError(400, "type must be auto_submit or ack_reply");
  const rule = { type: b.type };
  let employerIds = null;
  if (b.employerIds !== undefined) {
    if (!Array.isArray(b.employerIds) || !b.employerIds.length || b.employerIds.length > LIST_MAX) throw new HttpError(400, `employerIds must be a non-empty array of at most ${LIST_MAX} ids`);
    employerIds = [...new Set(b.employerIds.map(posInt))];
    if (employerIds.some((x) => !x)) throw new HttpError(400, "employerIds must contain positive integers");
    const found = (await client.query("SELECT id FROM js_employers WHERE id = ANY($1::int[])", [employerIds])).rows.length;
    if (found !== employerIds.length) throw new HttpError(404, "Employer not found");
  }
  if (b.type === "auto_submit") {
    // Automatic sending is deny-by-default: an explicit country scope is required (autoApproveEligibility).
    if (b.countries === undefined) throw new HttpError(400, "countries is required for an auto_submit rule");
    rule.countries = stringList(b.countries, "countries");
    if (b.professions !== undefined) rule.professions = stringList(b.professions, "professions");
    if (b.sources !== undefined) rule.sources = stringList(b.sources, "sources", { pattern: /^[a-z0-9_]{1,50}$/ });
    if (employerIds) rule.employerIds = employerIds;
  } else {
    // ack_reply: automatic acknowledgement replies, only to the listed employers.
    for (const k of ["countries", "professions", "sources"]) if (b[k] !== undefined) throw new HttpError(400, `${k} does not apply to an ack_reply rule`);
    if (!employerIds) throw new HttpError(400, "employerIds is required for an ack_reply rule");
    rule.enabled = true;
    rule.employerIds = employerIds;
  }
  let note = null;
  if (b.note !== undefined && b.note !== null && b.note !== "") {
    if (typeof b.note !== "string") throw new HttpError(400, "note must be a string");
    note = b.note.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) || null;
  }
  return { candidateId, rule, note };
}

function presentRule(r) {
  const rule = r.rule || {};
  const type = rule.type || "auto_submit";
  const scope = {};
  for (const k of ["countries", "professions", "sources"]) if (Array.isArray(rule[k])) scope[k] = rule[k];
  const emp = [rule.employerId, ...(Array.isArray(rule.employerIds) ? rule.employerIds : [])].map(Number).filter((x) => Number.isSafeInteger(x) && x > 0);
  if (emp.length) scope.employerIds = [...new Set(emp)];
  return {
    id: r.id,
    candidateId: r.candidate_id,
    candidateName: r.candidate_name,
    type,
    scope,
    active: r.active,
    enabled: Boolean(r.active && r.approved_by && r.approved_at && (type !== "ack_reply" || rule.enabled === true)),
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    createdAt: r.created_at,
  };
}

router.get("/automation-rules", verifyToken, asyncHandler(async (req, res) => {
  needAdmin(req.user);
  const params = [];
  let where = "c.is_deleted = false";
  if (req.query.candidateId !== undefined && req.query.candidateId !== "") {
    const cid = posInt(req.query.candidateId);
    if (!cid) throw new HttpError(400, "candidateId must be a positive integer");
    params.push(cid);
    where += ` AND r.candidate_id = $${params.length}`;
  }
  const rows = (await db().query(
    `SELECT r.*, c.full_name AS candidate_name FROM js_automation_rules r JOIN candidates c ON c.id = r.candidate_id WHERE ${where} ORDER BY r.id LIMIT 500`,
    params
  )).rows;
  res.json({ rules: rows.map(presentRule) });
}));

router.post("/automation-rules", verifyToken, asyncHandler(async (req, res) => {
  needAdmin(req.user);
  const client = await db().connect();
  let row;
  try {
    await client.query("BEGIN");
    const { candidateId, rule, note } = await validateRule(client, body(req));
    // Same lock as approvals/consent changes: a new rule never races an auto-approval of this candidate.
    const cand = (await client.query("SELECT id, full_name FROM candidates WHERE id = $1 AND is_deleted = false FOR UPDATE", [candidateId])).rows[0];
    if (!cand) throw new HttpError(404, "Candidate not found");
    row = (await client.query(
      "INSERT INTO js_automation_rules (candidate_id, rule, approved_by, approved_at, active) VALUES ($1,$2::jsonb,$3,now(),true) RETURNING *",
      [candidateId, JSON.stringify(rule), req.user.id]
    )).rows[0];
    row.candidate_name = cand.full_name;
    await auditJs({ userId: req.user.id, action: "automation_rule.create", entity: "js_automation_rules", entityId: row.id, candidateId, detail: { ruleId: row.id, rule, ...(note ? { note } : {}) }, client });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.status(201).json(presentRule(row));
}));

router.delete("/automation-rules/:id", verifyToken, asyncHandler(async (req, res) => {
  needAdmin(req.user);
  const id = posInt(req.params.id);
  if (!id) throw new HttpError(404, "Not found");
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const pre = (await client.query("SELECT candidate_id FROM js_automation_rules WHERE id = $1 AND active = true", [id])).rows[0];
    if (!pre) throw new HttpError(404, "Not found");
    await client.query("SELECT id FROM candidates WHERE id = $1 FOR UPDATE", [pre.candidate_id]);
    const row = (await client.query("UPDATE js_automation_rules SET active = false WHERE id = $1 AND active = true RETURNING id, candidate_id, rule", [id])).rows[0];
    if (!row) throw new HttpError(404, "Not found");
    await auditJs({ userId: req.user.id, action: "automation_rule.disable", entity: "js_automation_rules", entityId: id, candidateId: row.candidate_id, detail: { ruleId: id, type: (row.rule && row.rule.type) || "auto_submit" }, client });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json({ id, active: false });
}));

// ---------------------------------------------------------------- employer confirmations (list)

router.get("/employer-confirmations", verifyToken, asyncHandler(async (req, res) => {
  if (!isAdmin(req.user) || !hasPerm(req.user, "jobsearch:write")) throw new HttpError(403, "Admin access required");
  const active = req.query.active === "true";
  const rows = (await db().query(
    `SELECT k.*, e.name AS employer_name, j.title AS job_title
       FROM js_employer_confirmations k LEFT JOIN js_employers e ON e.id = k.employer_id LEFT JOIN js_jobs j ON j.id = k.job_id
      ${active ? "WHERE k.revoked_at IS NULL" : ""} ORDER BY k.id DESC LIMIT 500`
  )).rows;
  res.json({
    confirmations: rows.map((k) => ({
      id: k.id,
      scope: k.job_id ? "job" : "employer",
      employerId: k.employer_id,
      employerName: k.employer_name,
      jobId: k.job_id,
      jobTitle: k.job_title,
      applicationId: k.application_id,
      kind: k.kind,
      evidence: k.evidence_text,
      confirmedBy: k.confirmed_by,
      createdAt: k.created_at,
      revoked: Boolean(k.revoked_at),
      revokedAt: k.revoked_at,
    })),
  });
}));

router.use(jobsearchErrorHandler);

module.exports = router;
