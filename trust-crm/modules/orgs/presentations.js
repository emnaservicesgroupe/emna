// Staff review of employer requests, draft site-job creation, and candidate presentations to employers.
// A presentation freezes an ALLOWLISTED summary (SUMMARY_KEYS, exactly) at presentation time; it never carries
// candidate identity, contact, passport, documents or CV. Employers can read it only while an ACTIVE share
// consent for (candidate, employer) exists (the employer queries join the consent, so withdrawal hides it at once).
const { HttpError } = require("../jobsearch/httpError");
const { assertCandidateAccess, candidateScopeSql } = require("../jobsearch/scope");
const { logAudit } = require("../../utils/audit");
const timeline = require("../crm/timeline");
const siteJobs = require("../crm/siteJobsAdmin");
const { inTransaction, parseId, hasPerm } = require("../crm/leadsAdmin");

const db = () => require("../../db");

const SUMMARY_KEYS = ["profession", "years_experience", "languages", "country_of_residence", "availability", "staff_note_for_employer"];
const REQUEST_STATUSES = ["submitted", "in_review", "accepted", "declined", "filled", "cancelled"];
const TRANSITIONS = {
  submitted: ["in_review", "declined", "cancelled"],
  in_review: ["accepted", "declined", "cancelled"],
  accepted: ["filled", "declined", "cancelled"],
  declined: [],
  filled: [],
  cancelled: [],
};
const PRESENT_STATUSES = ["in_review", "accepted"];
const NOTE_MAX = 2000;
const EMPLOYER_NOTE_MAX = 1000;
const likeEscape = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function oneParam(v, label) {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${label} must be a single value`);
  return v;
}
function pageParam(raw, name, { min, max, dflt }) {
  const v = oneParam(raw, name);
  if (v === undefined) return dflt;
  if (!/^\d{1,6}$/.test(v) || Number(v) < min || Number(v) > max) throw new HttpError(400, `${name} is invalid`);
  return Number(v);
}
function cleanText(v, label, max) {
  if (v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${label} must be a string or null`);
  if (v.includes("\u0000")) throw new HttpError(400, `${label} contains invalid characters`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  return t === "" ? null : t;
}
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// ---------- staff: employer requests ----------

const REQ_COLS = `r.id, r.employer_id, e.name AS employer_name, r.title, r.positions, r.country, r.city, r.category,
  r.description, r.requirements, r.salary_text, to_char(r.start_date, 'YYYY-MM-DD') AS start_date, r.status,
  r.staff_note, r.employer_visible_note, r.site_job_id, r.created_at, r.updated_at`;

async function listRequests(query = {}) {
  const status = oneParam(query.status, "status");
  const employerId = oneParam(query.employer_id, "employer_id");
  const q = oneParam(query.q, "q");
  const limit = pageParam(query.limit, "limit", { min: 1, max: 100, dflt: 20 });
  const offset = pageParam(query.offset, "offset", { min: 0, max: 100000, dflt: 0 });
  const where = [];
  const params = [];
  if (status !== undefined) {
    if (!REQUEST_STATUSES.includes(status)) throw new HttpError(400, "status is invalid");
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  if (employerId !== undefined) {
    params.push(String(parseId(employerId)));
    where.push(`r.employer_id = $${params.length}`);
  }
  if (q !== undefined && q.trim()) {
    if (q.length > 100) throw new HttpError(400, "q must be at most 100 characters");
    params.push(`%${likeEscape(q.trim())}%`);
    where.push(`(r.title ILIKE $${params.length} OR e.name ILIKE $${params.length})`);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await db().query(`SELECT count(*)::int AS n FROM employer_requests r JOIN crm_employers e ON e.id = r.employer_id ${w}`, params);
  const rows = await db().query(
    `SELECT ${REQ_COLS}, (SELECT count(*)::int FROM employer_presentations p WHERE p.request_id = r.id) AS presentations_count
       FROM employer_requests r JOIN crm_employers e ON e.id = r.employer_id ${w}
      ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { rows: rows.rows, total: total.rows[0].n, limit, offset };
}

async function loadRequest(client, id, { lock = false } = {}) {
  const r = await client.query(`SELECT ${REQ_COLS} FROM employer_requests r JOIN crm_employers e ON e.id = r.employer_id WHERE r.id = $1${lock ? " FOR UPDATE OF r" : ""}`, [String(id)]);
  if (r.rowCount === 0) throw new HttpError(404, "Not found");
  return r.rows[0];
}

const PRES_COLS = `p.id, p.request_id, p.candidate_id, c.full_name AS candidate_name, p.presented_by, p.summary,
  p.staff_note_for_employer, p.status, p.employer_note, p.responded_at, p.created_at,
  EXISTS (SELECT 1 FROM candidate_share_consents sc WHERE sc.candidate_id = p.candidate_id AND sc.employer_id = r.employer_id AND sc.withdrawn_at IS NULL) AS consent_active`;

async function presentationsFor(user, requestId) {
  const scope = candidateScopeSql(user, "c", 1);
  const r = await db().query(
    `SELECT ${PRES_COLS} FROM employer_presentations p JOIN employer_requests r ON r.id = p.request_id JOIN candidates c ON c.id = p.candidate_id
      WHERE p.request_id = $1 AND c.is_deleted = false AND ${scope.clause} ORDER BY p.created_at, p.id`,
    [String(requestId), ...scope.params]
  );
  return r.rows;
}

async function getRequest(user, rawId) {
  const id = parseId(rawId);
  const req = await loadRequest(db(), id);
  const presentations = await presentationsFor(user, id);
  const tl = await timeline.list("employer_request", id, db());
  return { ...req, presentations, timeline: tl };
}

async function patchRequest(user, rawId, input) {
  const id = parseId(rawId);
  if (!isObj(input)) throw new HttpError(400, "JSON object body required");
  const allowed = ["status", "staff_note", "employer_visible_note"];
  for (const k of Object.keys(input)) if (!allowed.includes(k)) throw new HttpError(400, `Unknown field: ${k.slice(0, 40)}`);
  const sets = {};
  if (input.staff_note !== undefined) sets.staff_note = cleanText(input.staff_note, "staff_note", NOTE_MAX);
  if (input.employer_visible_note !== undefined) sets.employer_visible_note = cleanText(input.employer_visible_note, "employer_visible_note", EMPLOYER_NOTE_MAX);
  let target;
  if (input.status !== undefined) {
    if (typeof input.status !== "string" || !["in_review", "accepted", "declined", "filled", "cancelled"].includes(input.status)) throw new HttpError(400, "status is invalid");
    target = input.status;
  }
  if (target === undefined && Object.keys(sets).length === 0) throw new HttpError(400, "no fields to update");
  return inTransaction(async (client) => {
    const cur = await loadRequest(client, id, { lock: true });
    if (target !== undefined && target !== cur.status) {
      if (!TRANSITIONS[cur.status].includes(target)) throw new HttpError(409, `Cannot change status from ${cur.status} to ${target}`);
      sets.status = target;
    }
    const keys = Object.keys(sets);
    if (keys.length === 0) return cur;
    await client.query(`UPDATE employer_requests SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [String(id), ...keys.map((k) => sets[k])]);
    if (sets.status) {
      await timeline.add(client, { entity: "employer_request", entityId: id, actorId: user.id, event: "status_changed", detail: { from: cur.status, to: sets.status } });
    }
    const noteKeys = keys.filter((k) => k !== "status");
    if (noteKeys.length) await timeline.add(client, { entity: "employer_request", entityId: id, actorId: user.id, event: "notes_updated", detail: { fields: noteKeys } });
    await logAudit({
      client,
      userId: user.id,
      action: "crm.employer_request.update",
      tableName: "employer_requests",
      recordId: String(id),
      oldData: { status: cur.status },
      newData: { ...(sets.status ? { status: sets.status } : {}), ...(noteKeys.length ? { fields: noteKeys } : {}) },
    });
    return loadRequest(client, id);
  });
}

async function createSiteJobFromRequest(user, rawId) {
  const id = parseId(rawId);
  const lockKey = String(7000000000 + id);
  const lockClient = await db().connect();
  try {
    // One draft per request even under concurrent calls: a session advisory lock around check + create + link.
    await lockClient.query("SELECT pg_advisory_lock($1::bigint)", [lockKey]);
    const req = await loadRequest(lockClient, id);
    if (req.site_job_id) throw new HttpError(409, "A site job was already created from this request");
    if (!PRESENT_STATUSES.includes(req.status)) throw new HttpError(409, "Request must be in_review or accepted");
    // The staff user needs sitejobs:write (enforced by the existing service). The employer is NOT named on the draft.
    const draft = await siteJobs.createSiteJob(user, {
      title: req.title,
      country: req.country,
      city: req.city,
      category: req.category,
      description: req.description,
      requirements: req.requirements,
      salary_text: req.salary_text,
    });
    await inTransaction(async (client) => {
      await client.query("UPDATE employer_requests SET site_job_id = $2, updated_at = now() WHERE id = $1", [String(id), draft.id]);
      await timeline.add(client, { entity: "employer_request", entityId: id, actorId: user.id, event: "site_job_created", detail: { site_job_id: Number(draft.id) } });
      await logAudit({ client, userId: user.id, action: "crm.employer_request.site_job", tableName: "employer_requests", recordId: String(id), newData: { site_job_id: Number(draft.id), status: "draft" } });
    });
    return { request_id: id, site_job: draft };
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]).catch(() => {});
    lockClient.release();
  }
}

// ---------- summary snapshot ----------

function validateStaffSummary(raw) {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) throw new HttpError(400, "summary must be an object");
  const allowed = ["profession", "years_experience", "languages", "country_of_residence", "availability"];
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw new HttpError(400, `Unknown summary field: ${k.slice(0, 40)}`);
  const out = {};
  for (const k of ["profession", "country_of_residence", "availability"]) {
    if (raw[k] !== undefined) out[k] = cleanText(raw[k], `summary.${k}`, k === "profession" ? 120 : 100);
  }
  if (raw.years_experience !== undefined && raw.years_experience !== null) {
    if (typeof raw.years_experience !== "number" || !Number.isInteger(raw.years_experience) || raw.years_experience < 0 || raw.years_experience > 70) {
      throw new HttpError(400, "summary.years_experience must be an integer 0..70");
    }
    out.years_experience = raw.years_experience;
  }
  if (raw.languages !== undefined && raw.languages !== null) {
    if (!Array.isArray(raw.languages) || raw.languages.length > 10) throw new HttpError(400, "summary.languages must be an array of at most 10 strings");
    out.languages = raw.languages.map((l) => {
      const t = cleanText(l, "summary.languages entry", 60);
      if (t === null || typeof l !== "string") throw new HttpError(400, "summary.languages must contain non-empty strings");
      return t;
    });
  }
  return out;
}

function yearsFromExperience(exp) {
  if (!Array.isArray(exp)) return null;
  const now = new Date().getUTCFullYear();
  let months = 0;
  let any = false;
  for (const e of exp) {
    if (!isObj(e) || typeof e.start !== "string") continue;
    const s = /(\d{4})/.exec(e.start);
    if (!s) continue;
    const end = typeof e.end === "string" && /(\d{4})/.test(e.end) ? Number(/(\d{4})/.exec(e.end)[1]) : now;
    const start = Number(s[1]);
    if (start < 1950 || end < start || end > now + 1) continue;
    months += (end - start) * 12;
    any = true;
  }
  return any ? Math.min(70, Math.round(months / 12)) : null;
}

const short = (v, max) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : null);

/** Builds the allowlisted summary: confirmed job-search profile first, staff-supplied values fill only the gaps. */
async function buildSummary(client, candidateId, staffSummary, staffNote) {
  const prof = await client.query("SELECT confirmed FROM js_profiles WHERE candidate_id = $1 AND status = 'confirmed'", [candidateId]);
  const prefs = await client.query("SELECT availability, residence_country FROM js_preferences WHERE candidate_id = $1", [candidateId]);
  const conf = prof.rowCount && isObj(prof.rows[0].confirmed) ? prof.rows[0].confirmed : {};
  const pref = prefs.rowCount ? prefs.rows[0] : {};
  let langs = null;
  if (Array.isArray(conf.languages)) {
    langs = conf.languages
      .map((l) => (isObj(l) ? [short(l.lang, 40), short(l.level, 20)] : [short(l, 40), null]))
      .filter(([a]) => a)
      .slice(0, 10)
      .map(([a, b]) => (b ? `${a} (${b})` : a));
    if (langs.length === 0) langs = null;
  }
  let years = null;
  if (typeof conf.years_experience === "number" && Number.isInteger(conf.years_experience) && conf.years_experience >= 0 && conf.years_experience <= 70) years = conf.years_experience;
  else years = yearsFromExperience(conf.experience);
  const fromProfile = {
    profession: short(conf.profession, 120),
    years_experience: years,
    languages: langs,
    country_of_residence: short(pref.residence_country, 100),
    availability: short(pref.availability, 100),
  };
  const summary = {};
  for (const k of ["profession", "years_experience", "languages", "country_of_residence", "availability"]) {
    summary[k] = fromProfile[k] !== null ? fromProfile[k] : staffSummary[k] !== undefined ? staffSummary[k] : null;
  }
  if (Object.values(summary).every((v) => v === null)) {
    const e = new HttpError(400, "No confirmed profile data for this candidate; supply a summary object (profession, years_experience, languages, country_of_residence, availability)");
    e.code = "no_profile_data";
    throw e;
  }
  summary.staff_note_for_employer = staffNote;
  return summary;
}

// ---------- staff: presentations ----------

async function present(user, rawRequestId, input) {
  if (!hasPerm(user, "orgs:write") || !hasPerm(user, "candidates:read")) throw new HttpError(403, "Permission denied");
  const requestId = parseId(rawRequestId);
  if (!isObj(input)) throw new HttpError(400, "JSON object body required");
  for (const k of Object.keys(input)) if (!["candidate_id", "staff_note_for_employer", "summary"].includes(k)) throw new HttpError(400, `Unknown field: ${k.slice(0, 40)}`);
  const candidateId = parseId(input.candidate_id);
  const note = input.staff_note_for_employer === undefined ? null : cleanText(input.staff_note_for_employer, "staff_note_for_employer", EMPLOYER_NOTE_MAX);
  const staffSummary = validateStaffSummary(input.summary);
  await assertCandidateAccess(user, candidateId);
  return inTransaction(async (client) => {
    const req = await loadRequest(client, requestId, { lock: true });
    if (!PRESENT_STATUSES.includes(req.status)) throw new HttpError(409, "Request must be in_review or accepted to present candidates");
    const consent = await client.query(
      "SELECT 1 FROM candidate_share_consents WHERE candidate_id = $1 AND employer_id = $2 AND withdrawn_at IS NULL FOR SHARE",
      [candidateId, req.employer_id]
    );
    if (consent.rowCount === 0) throw new HttpError(409, "No active share consent from this candidate for this employer; record it first");
    const dup = await client.query("SELECT 1 FROM employer_presentations WHERE request_id = $1 AND candidate_id = $2", [String(requestId), candidateId]);
    if (dup.rowCount > 0) throw new HttpError(409, "This candidate was already presented for this request");
    const summary = await buildSummary(client, candidateId, staffSummary, note);
    const ins = await client.query(
      `INSERT INTO employer_presentations (request_id, candidate_id, presented_by, summary, staff_note_for_employer)
       VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id`,
      [String(requestId), candidateId, user.id, JSON.stringify(summary), note]
    );
    const pid = ins.rows[0].id;
    await timeline.add(client, { entity: "presentation", entityId: pid, actorId: user.id, event: "presented", detail: { request_id: requestId, candidate_id: candidateId } });
    await timeline.add(client, { entity: "employer_request", entityId: requestId, actorId: user.id, event: "candidate_presented", detail: { presentation_id: Number(pid), candidate_id: candidateId } });
    await logAudit({ client, userId: user.id, action: "crm.presentation.create", tableName: "employer_presentations", recordId: String(pid), newData: { request_id: requestId, candidate_id: candidateId, summary } });
    const row = await client.query(`SELECT ${PRES_COLS} FROM employer_presentations p JOIN employer_requests r ON r.id = p.request_id JOIN candidates c ON c.id = p.candidate_id WHERE p.id = $1`, [pid]);
    return row.rows[0];
  });
}

const PREVIEW_PARAMS = ["candidate_id", "staff_note_for_employer", "profession", "years_experience", "languages", "country_of_residence", "availability"];

/** Query-string form of the staff-supplied fallback summary (languages comma separated); blanks are absent. */
function staffSummaryFromQuery(q) {
  const raw = {};
  for (const k of ["profession", "country_of_residence", "availability"]) {
    const v = oneParam(q[k], k);
    if (v !== undefined && v.trim() !== "") raw[k] = v;
  }
  const yrs = oneParam(q.years_experience, "years_experience");
  if (yrs !== undefined && yrs.trim() !== "") {
    if (!/^-?\d{1,6}$/.test(yrs.trim())) throw new HttpError(400, "summary.years_experience must be an integer 0..70");
    raw.years_experience = Number(yrs.trim());
  }
  const langs = oneParam(q.languages, "languages");
  if (langs !== undefined && langs.trim() !== "") raw.languages = langs.split(",").map((l) => l.trim()).filter((l) => l !== "");
  return validateStaffSummary(raw);
}

/**
 * Read-only: the exact summary present() would freeze for this request + candidate (same builder, same validation),
 * plus the facts that decide whether presenting is possible now. Writes nothing.
 */
async function previewPresentation(user, rawRequestId, query = {}) {
  if (!hasPerm(user, "orgs:write") || !hasPerm(user, "candidates:read")) throw new HttpError(403, "Permission denied");
  const requestId = parseId(rawRequestId);
  if (!isObj(query)) throw new HttpError(400, "invalid query");
  for (const k of Object.keys(query)) if (!PREVIEW_PARAMS.includes(k)) throw new HttpError(400, `Unknown parameter: ${k.slice(0, 40)}`);
  const rawCand = oneParam(query.candidate_id, "candidate_id");
  if (rawCand === undefined) throw new HttpError(400, "candidate_id is required");
  const candidateId = parseId(rawCand);
  const noteRaw = oneParam(query.staff_note_for_employer, "staff_note_for_employer");
  const note = noteRaw === undefined ? null : cleanText(noteRaw, "staff_note_for_employer", EMPLOYER_NOTE_MAX);
  const staffSummary = staffSummaryFromQuery(query);
  await assertCandidateAccess(user, candidateId);
  const req = await loadRequest(db(), requestId);
  const consent = await db().query("SELECT 1 FROM candidate_share_consents WHERE candidate_id = $1 AND employer_id = $2 AND withdrawn_at IS NULL", [candidateId, req.employer_id]);
  const dup = await db().query("SELECT 1 FROM employer_presentations WHERE request_id = $1 AND candidate_id = $2", [String(requestId), candidateId]);
  let summary = null;
  let needsSummary = false;
  try {
    summary = await buildSummary(db(), candidateId, staffSummary, note);
  } catch (err) {
    if (err && err.code === "no_profile_data") needsSummary = true;
    else throw err;
  }
  const statusOk = PRESENT_STATUSES.includes(req.status);
  return {
    request_id: req.id,
    employer_id: req.employer_id,
    employer_name: req.employer_name,
    candidate_id: candidateId,
    request_status: req.status,
    consent_active: consent.rowCount > 0,
    already_presented: dup.rowCount > 0,
    needs_summary: needsSummary,
    summary,
    presentable: statusOk && consent.rowCount > 0 && dup.rowCount === 0 && summary !== null,
  };
}

async function listPresentations(user, query = {}) {
  const status = oneParam(query.status, "status");
  const requestId = oneParam(query.request_id, "request_id");
  const employerId = oneParam(query.employer_id, "employer_id");
  const limit = pageParam(query.limit, "limit", { min: 1, max: 100, dflt: 20 });
  const offset = pageParam(query.offset, "offset", { min: 0, max: 100000, dflt: 0 });
  const scope = candidateScopeSql(user, "c", 0);
  const params = [...scope.params];
  const where = ["c.is_deleted = false", scope.clause];
  if (status !== undefined) {
    if (!["presented", "interested", "interview", "not_suitable", "withdrawn"].includes(status)) throw new HttpError(400, "status is invalid");
    params.push(status);
    where.push(`p.status = $${params.length}`);
  }
  if (requestId !== undefined) {
    params.push(String(parseId(requestId)));
    where.push(`p.request_id = $${params.length}`);
  }
  if (employerId !== undefined) {
    params.push(String(parseId(employerId)));
    where.push(`r.employer_id = $${params.length}`);
  }
  const from = "FROM employer_presentations p JOIN employer_requests r ON r.id = p.request_id JOIN candidates c ON c.id = p.candidate_id";
  const total = await db().query(`SELECT count(*)::int AS n ${from} WHERE ${where.join(" AND ")}`, params);
  const rows = await db().query(
    `SELECT ${PRES_COLS}, r.employer_id, r.title AS request_title ${from} WHERE ${where.join(" AND ")}
      ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { rows: rows.rows, total: total.rows[0].n, limit, offset };
}

async function withdrawPresentation(user, rawId) {
  const id = parseId(rawId);
  const pre = await db().query("SELECT candidate_id FROM employer_presentations WHERE id = $1", [String(id)]);
  if (pre.rowCount === 0) throw new HttpError(404, "Not found");
  await assertCandidateAccess(user, pre.rows[0].candidate_id);
  return inTransaction(async (client) => {
    const cur = await client.query("SELECT id, status FROM employer_presentations WHERE id = $1 FOR UPDATE", [String(id)]);
    if (cur.rowCount === 0) throw new HttpError(404, "Not found");
    if (cur.rows[0].status === "withdrawn") throw new HttpError(409, "Presentation is already withdrawn");
    await client.query("UPDATE employer_presentations SET status = 'withdrawn' WHERE id = $1", [String(id)]);
    await timeline.add(client, { entity: "presentation", entityId: id, actorId: user.id, event: "withdrawn", detail: { from: cur.rows[0].status } });
    await logAudit({ client, userId: user.id, action: "crm.presentation.withdraw", tableName: "employer_presentations", recordId: String(id), oldData: { status: cur.rows[0].status }, newData: { status: "withdrawn" } });
    const row = await client.query(`SELECT ${PRES_COLS} FROM employer_presentations p JOIN employer_requests r ON r.id = p.request_id JOIN candidates c ON c.id = p.candidate_id WHERE p.id = $1`, [String(id)]);
    return row.rows[0];
  });
}

// ---------- employer side ----------

/** Re-applies the allowlist at read time: exactly SUMMARY_KEYS, whatever the stored jsonb holds. */
function publicSummary(stored) {
  const s = isObj(stored) ? stored : {};
  const out = {};
  for (const k of SUMMARY_KEYS) out[k] = Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null;
  return out;
}

const EMP_SELECT = `SELECT p.id, p.request_id, r.title AS request_title, p.summary, p.status, p.employer_note, p.responded_at, p.created_at
  FROM employer_presentations p
  JOIN employer_requests r ON r.id = p.request_id
  JOIN candidate_share_consents sc ON sc.candidate_id = p.candidate_id AND sc.employer_id = r.employer_id AND sc.withdrawn_at IS NULL`;

function toEmployerItem(row) {
  return {
    id: row.id,
    request_id: row.request_id,
    request_title: row.request_title,
    summary: publicSummary(row.summary),
    status: row.status,
    employer_note: row.employer_note,
    responded_at: row.responded_at,
    created_at: row.created_at,
  };
}

async function employerList(orgId, query = {}) {
  const limit = pageParam(query.limit, "limit", { min: 1, max: 100, dflt: 20 });
  const offset = pageParam(query.offset, "offset", { min: 0, max: 100000, dflt: 0 });
  const where = "WHERE r.employer_id = $1 AND p.status <> 'withdrawn'";
  const rows = await db().query(`${EMP_SELECT} ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`, [orgId, limit, offset]);
  const total = await db().query(`SELECT count(*)::int AS n FROM employer_presentations p JOIN employer_requests r ON r.id = p.request_id
    JOIN candidate_share_consents sc ON sc.candidate_id = p.candidate_id AND sc.employer_id = r.employer_id AND sc.withdrawn_at IS NULL ${where}`, [orgId]);
  return { presentations: rows.rows.map(toEmployerItem), total: total.rows[0].n, limit, offset };
}

async function employerGet(orgId, rawId) {
  const id = parseId(rawId);
  const r = await db().query(`${EMP_SELECT} WHERE p.id = $1 AND r.employer_id = $2 AND p.status <> 'withdrawn'`, [String(id), orgId]);
  if (r.rowCount === 0) throw new HttpError(404, "Not found");
  return toEmployerItem(r.rows[0]);
}

async function employerRespond(user, orgId, rawId, input) {
  const id = parseId(rawId);
  if (!isObj(input)) throw new HttpError(400, "JSON object body required");
  for (const k of Object.keys(input)) if (k !== "status" && k !== "note") throw new HttpError(400, `Unknown field: ${k.slice(0, 40)}`);
  if (typeof input.status !== "string" || !["interested", "interview", "not_suitable"].includes(input.status)) throw new HttpError(400, "status must be interested, interview or not_suitable");
  const note = input.note === undefined ? null : cleanText(input.note, "note", EMPLOYER_NOTE_MAX);
  return inTransaction(async (client) => {
    const cur = await client.query(
      `SELECT p.id, p.status FROM employer_presentations p
         JOIN employer_requests r ON r.id = p.request_id
         JOIN candidate_share_consents sc ON sc.candidate_id = p.candidate_id AND sc.employer_id = r.employer_id AND sc.withdrawn_at IS NULL
        WHERE p.id = $1 AND r.employer_id = $2 FOR UPDATE OF p`,
      [String(id), orgId]
    );
    if (cur.rowCount === 0 || cur.rows[0].status === "withdrawn") throw new HttpError(404, "Not found");
    const from = cur.rows[0].status;
    await client.query("UPDATE employer_presentations SET status = $2, employer_note = $3, responded_at = now() WHERE id = $1", [String(id), input.status, note]);
    await timeline.add(client, { entity: "presentation", entityId: id, actorId: user.id, event: "employer_responded", detail: { from, to: input.status } });
    await logAudit({ client, userId: user.id, action: "employer.presentation.respond", tableName: "employer_presentations", recordId: String(id), oldData: { status: from }, newData: { status: input.status, has_note: note !== null } });
    const r = await client.query(`${EMP_SELECT} WHERE p.id = $1`, [String(id)]);
    return toEmployerItem(r.rows[0]);
  });
}

module.exports = {
  SUMMARY_KEYS,
  TRANSITIONS,
  listRequests,
  getRequest,
  patchRequest,
  createSiteJobFromRequest,
  present,
  previewPresentation,
  listPresentations,
  withdrawPresentation,
  employerList,
  employerGet,
  employerRespond,
  publicSummary,
};
