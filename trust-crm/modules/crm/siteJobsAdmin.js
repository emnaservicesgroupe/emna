// Staff-authored public job offers. Staff create drafts, publish them with a recorded evidence note
// (where the offer came from) and close them. Public visibility is decided by modules/site/siteJobs.js.
// Lifecycle: draft -> published -> closed. Closing is final (a closed offer is never re-published; create a new row).
// Text is stored verbatim (HTML is not interpreted or stripped; the website renders it via textContent).
const { HttpError } = require("../jobsearch/httpError");
const { logAudit } = require("../../utils/audit");
const timeline = require("./timeline");
const { inTransaction, hasPerm, parseId } = require("./leadsAdmin");

const db = () => require("../../db");
const STATUSES = ["draft", "published", "closed"];
// apply_mode is either one of these keywords or an absolute http(s) URL (there is no separate link column).
const APPLY_MODES = ["contact_staff", "register"];
const MAX = { title: 160, description: 8000, requirements: 4000 };
const TEXT_FIELDS = [
  "title",
  "employer_name",
  "country",
  "city",
  "category",
  "description",
  "requirements",
  "language_requirements",
  "employment_type",
  "salary_text",
  "apply_mode",
  "evidence_note",
];
const FIELDS = [...TEXT_FIELDS, "closes_at"];
const COLUMNS = `id, ${FIELDS.join(", ")}, status, published_at, created_by, created_at, updated_at`;
const PUBLISH_REQUIRED = ["title", "country", "description", "evidence_note"];

function requireWrite(user) {
  if (!hasPerm(user, "sitejobs:write")) throw new HttpError(403, "Permission denied: sitejobs:write");
}

function validApplyUrl(v) {
  if (v.length > 160 || /[\s\u0000-\u001f\u007f]/.test(v) || !/^https?:\/\//i.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/** Validates the fields present in `input`; returns {field: cleanValue} (empty string -> null). */
function clean(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "A JSON object body is required");
  const out = {};
  for (const key of Object.keys(input)) {
    if (!FIELDS.includes(key)) throw new HttpError(400, `Unknown field: ${key}`);
    const v = input[key];
    if (key === "closes_at") {
      if (v === null) out[key] = null;
      else if (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v))) out[key] = new Date(Date.parse(v)).toISOString();
      else throw new HttpError(400, "closes_at must be null or a valid date-time");
      continue;
    }
    if (v === null || v === undefined) {
      out[key] = null;
    } else {
      if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
      if (v.includes("\u0000")) throw new HttpError(400, `${key} contains invalid characters`);
      const t = v.trim();
      const max = MAX[key] || 160;
      if (t.length > max) throw new HttpError(400, `${key} must be at most ${max} characters`);
      out[key] = t === "" ? null : t;
    }
    if (key === "title" && out.title === null) throw new HttpError(400, "title is required");
    if (key === "apply_mode" && out.apply_mode !== null && !APPLY_MODES.includes(out.apply_mode) && !validApplyUrl(out.apply_mode)) {
      throw new HttpError(400, `apply_mode must be one of ${APPLY_MODES.join(", ")} or an http(s) URL`);
    }
  }
  return out;
}

/** Throws 400 listing what is missing when a row cannot be (or stay) published. */
function assertPublishable(row) {
  const missing = PUBLISH_REQUIRED.filter((f) => typeof row[f] !== "string" || row[f].trim() === "");
  if (missing.length) throw new HttpError(400, `Required to publish: ${missing.join(", ")}`);
  if (row.closes_at && new Date(row.closes_at).getTime() <= Date.now()) throw new HttpError(400, "closes_at must be in the future to publish");
}

async function load(client, id, { lock = false } = {}) {
  const r = await client.query(`SELECT ${COLUMNS} FROM site_jobs WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [String(id)]);
  if (r.rowCount === 0) throw new HttpError(404, "Not found");
  return r.rows[0];
}

const sameValue = (a, b) => (a instanceof Date || b instanceof Date ? new Date(a || 0).getTime() === new Date(b || 0).getTime() && Boolean(a) === Boolean(b) : a === b);

async function createSiteJob(user, input) {
  requireWrite(user);
  const data = clean(input);
  if (data.title === undefined) throw new HttpError(400, "title is required");
  return inTransaction(async (client) => {
    const cols = Object.keys(data);
    const r = await client.query(
      `INSERT INTO site_jobs (${cols.join(", ")}, status, created_by) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, 'draft', $${cols.length + 1}) RETURNING ${COLUMNS}`,
      [...cols.map((c) => data[c]), user.id]
    );
    const row = r.rows[0];
    await timeline.add(client, { entity: "site_job", entityId: row.id, actorId: user.id, event: "created", detail: { title: row.title } });
    await logAudit({ client, userId: user.id, action: "crm.site_job.create", tableName: "site_jobs", recordId: String(row.id), newData: { ...data, status: "draft" } });
    return row;
  });
}

async function updateSiteJob(user, rawId, patch) {
  requireWrite(user);
  const id = parseId(rawId);
  const data = clean(patch);
  const keys = Object.keys(data);
  if (keys.length === 0) throw new HttpError(400, "No fields to update");
  return inTransaction(async (client) => {
    const old = await load(client, id, { lock: true });
    if (old.status === "closed") throw new HttpError(409, "A closed offer cannot be edited");
    const merged = { ...old, ...data };
    if (old.status === "published") assertPublishable(merged); // a live offer must stay publishable
    const changed = keys.filter((k) => !sameValue(old[k], merged[k]));
    if (changed.length === 0) return old;
    const r = await client.query(
      `UPDATE site_jobs SET ${changed.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [String(id), ...changed.map((c) => data[c])]
    );
    await timeline.add(client, { entity: "site_job", entityId: id, actorId: user.id, event: "updated", detail: { fields: changed, status: old.status } });
    await logAudit({
      client,
      userId: user.id,
      action: "crm.site_job.update",
      tableName: "site_jobs",
      recordId: String(id),
      oldData: Object.fromEntries(changed.map((c) => [c, old[c]])),
      newData: Object.fromEntries(changed.map((c) => [c, data[c]])),
    });
    return r.rows[0];
  });
}

async function publishSiteJob(user, rawId) {
  requireWrite(user);
  const id = parseId(rawId);
  return inTransaction(async (client) => {
    const old = await load(client, id, { lock: true });
    if (old.status !== "draft") throw new HttpError(409, `Only a draft can be published (current status: ${old.status})`);
    assertPublishable(old);
    const r = await client.query(`UPDATE site_jobs SET status = 'published', published_at = now(), updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [String(id)]);
    await timeline.add(client, { entity: "site_job", entityId: id, actorId: user.id, event: "published", detail: { evidence_note: old.evidence_note } });
    await logAudit({
      client,
      userId: user.id,
      action: "crm.site_job.publish",
      tableName: "site_jobs",
      recordId: String(id),
      oldData: { status: "draft" },
      newData: { status: "published", evidence_note: old.evidence_note },
    });
    return r.rows[0];
  });
}

async function closeSiteJob(user, rawId) {
  requireWrite(user);
  const id = parseId(rawId);
  return inTransaction(async (client) => {
    const old = await load(client, id, { lock: true });
    if (old.status !== "published") throw new HttpError(409, `Only a published offer can be closed (current status: ${old.status})`);
    const r = await client.query(`UPDATE site_jobs SET status = 'closed', updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [String(id)]);
    await timeline.add(client, { entity: "site_job", entityId: id, actorId: user.id, event: "closed", detail: null });
    await logAudit({ client, userId: user.id, action: "crm.site_job.close", tableName: "site_jobs", recordId: String(id), oldData: { status: "published" }, newData: { status: "closed" } });
    return r.rows[0];
  });
}

async function listSiteJobs(user, query = {}) {
  requireWrite(user);
  const one = (v, label) => {
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new HttpError(400, `${label} must be a single value`);
    return v;
  };
  const status = one(query.status, "status");
  const limitRaw = one(query.limit, "limit");
  const offsetRaw = one(query.offset, "offset");
  const params = [];
  let where = "TRUE";
  if (status !== undefined && status !== "") {
    if (!STATUSES.includes(status)) throw new HttpError(400, "invalid status");
    params.push(status);
    where = "status = $1";
  }
  let limit = 25;
  if (limitRaw !== undefined && limitRaw !== "") {
    if (!/^\d{1,4}$/.test(limitRaw) || Number(limitRaw) < 1) throw new HttpError(400, "limit must be a positive integer");
    limit = Math.min(Number(limitRaw), 100);
  }
  let offset = 0;
  if (offsetRaw !== undefined && offsetRaw !== "") {
    if (!/^\d{1,7}$/.test(offsetRaw)) throw new HttpError(400, "offset must be a non-negative integer");
    offset = Number(offsetRaw);
  }
  const total = await db().query(`SELECT count(*)::int AS n FROM site_jobs WHERE ${where}`, params);
  const rows = await db().query(
    `SELECT ${COLUMNS} FROM site_jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { rows: rows.rows, total: total.rows[0].n };
}

async function getSiteJob(user, rawId) {
  requireWrite(user);
  const id = parseId(rawId);
  const row = await load(db(), id);
  return { ...row, timeline: await timeline.list("site_job", id, db()) };
}

module.exports = { createSiteJob, updateSiteJob, publishSiteJob, closeSiteJob, listSiteJobs, getSiteJob, APPLY_MODES, STATUSES, MAX };
