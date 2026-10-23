// Employer directory, automation rules and the employer-confirmation list (Task 18), mounted at /jobsearch:
//   GET    /employers                    ?q&page&pageSize  staff (jobsearch:read): admins see all; other staff see
//                                        employers of jobs their (non-deleted) candidates have applications for
//   PUT    /employers/:id                {domain?, verifiedContactEmail?, name?}  jobsearch:admin; a Manager may change
//                                        only the name of an employer in their scope (Task 19: domain and
//                                        verifiedContactEmail decide where automatic sends go). Domain normalised (URL/www/trailing dot, IDN ->
//                                        punycode); free-mail domains, e-mail addresses, ports and IPs refused;
//                                        normalized names stay unique; audited (before/after)
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

function presentEmployer(e) {
  return {
    id: e.id,
    name: e.name,
    domain: e.domain || null,
    domainUnicode: e.domain ? url.domainToUnicode(e.domain) || e.domain : null,
    verifiedContactEmail: e.verified_contact_email || null,
    jobs: e.jobs === undefined ? undefined : Number(e.jobs),
    applications: e.applications === undefined ? undefined : Number(e.applications),
  };
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
  if (!hasPerm(user, "jobsearch:admin") && user.role !== "Manager") throw new HttpError(403, "Administrators or managers only");
  const id = posInt(req.params.id);
  if (!id) throw new HttpError(404, "Not found");
  const b = body(req);
  const allowed = ["domain", "verifiedContactEmail", "name"];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new HttpError(400, `Unknown field(s): ${unknown.join(", ")}`);
  if (!allowed.some((k) => k in b)) throw new HttpError(400, "Nothing to change: send domain, verifiedContactEmail and/or name");
  if (!hasPerm(user, "jobsearch:admin") && ("domain" in b || "verifiedContactEmail" in b)) {
    throw new HttpError(403, "Only an administrator (jobsearch:admin) can change an employer's domain and verifiedContactEmail; managers may change the name");
  }
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
