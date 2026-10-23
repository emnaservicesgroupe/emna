// Employer-side recruitment requests. Every function takes the org id resolved by requirePortalRole.
const { HttpError } = require("../jobsearch/httpError");
const { logAudit } = require("../../utils/audit");
const timeline = require("../crm/timeline");

const db = () => require("../../db");

const PUBLIC_COLS = `id, title, positions, country, city, category, description, requirements, salary_text,
  to_char(start_date, 'YYYY-MM-DD') AS start_date, status, employer_visible_note, created_at, updated_at`;

const FIELDS = ["title", "positions", "country", "city", "category", "description", "requirements", "salary_text", "start_date"];
const LIMITS = { title: 160, country: 160, city: 160, category: 160, description: 8000, requirements: 4000, salary_text: 160 };
const REQUIRED = ["title", "country", "description"];

function dailyCap() {
  const n = Number(process.env.EMPLOYER_REQUESTS_PER_DAY);
  return Number.isInteger(n) && n > 0 ? n : 20;
}

function parseId(raw) {
  if (typeof raw !== "string" || !/^[1-9]\d{0,14}$/.test(raw)) throw new HttpError(400, "invalid id");
  return raw;
}

function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 1900;
}

/** Validates the allowed fields. `partial` = PATCH (only present fields). Returns a column->value map. */
function validate(input, { partial }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "JSON object body required");
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) throw new HttpError(400, `unknown field: ${k.slice(0, 40)}`);
  const out = {};
  for (const f of FIELDS) {
    const present = Object.prototype.hasOwnProperty.call(input, f);
    if (!present) {
      if (!partial && REQUIRED.includes(f)) throw new HttpError(400, `${f} is required`);
      if (!partial && f === "positions") out.positions = 1;
      continue;
    }
    const v = input[f];
    if (f === "positions") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1000) throw new HttpError(400, "positions must be an integer 1..1000");
      out.positions = v;
    } else if (f === "start_date") {
      if (v === null) out.start_date = null;
      else if (typeof v === "string" && validDate(v)) out.start_date = v;
      else throw new HttpError(400, "start_date must be a valid YYYY-MM-DD date or null");
    } else {
      if (v === null && !REQUIRED.includes(f)) {
        out[f] = null;
        continue;
      }
      if (typeof v !== "string") throw new HttpError(400, `${f} must be a string`);
      if (v.includes("\u0000")) throw new HttpError(400, `${f} contains invalid characters`);
      const t = REQUIRED.includes(f) || v.trim() ? v : null;
      if (REQUIRED.includes(f) && !v.trim()) throw new HttpError(400, `${f} is required`);
      if (t !== null && t.length > LIMITS[f]) throw new HttpError(400, `${f} must be at most ${LIMITS[f]} characters`);
      out[f] = f === "title" ? v.trim() : t;
    }
  }
  if (partial && Object.keys(out).length === 0) throw new HttpError(400, "no fields to update");
  return out;
}

async function inTransaction(fn) {
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

function pageParam(raw, name, { min, max, dflt }) {
  if (raw === undefined) return dflt;
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) throw new HttpError(400, `${name} is invalid`);
  const n = Number(raw);
  if (n < min || n > max) throw new HttpError(400, `${name} is invalid`);
  return n;
}

async function getOrg(orgId) {
  const r = await db().query("SELECT id, name, contact_name, email, phone, country, sector FROM crm_employers WHERE id = $1", [orgId]);
  if (r.rowCount === 0) throw new HttpError(403, "Forbidden");
  return r.rows[0];
}

async function list(orgId, query) {
  const limit = pageParam(query.limit, "limit", { min: 1, max: 100, dflt: 20 });
  const offset = pageParam(query.offset, "offset", { min: 0, max: 100000, dflt: 0 });
  const rows = await db().query(`SELECT ${PUBLIC_COLS} FROM employer_requests WHERE employer_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, [orgId, limit, offset]);
  const total = await db().query("SELECT count(*)::int AS n FROM employer_requests WHERE employer_id = $1", [orgId]);
  return { requests: rows.rows, total: total.rows[0].n, limit, offset };
}

async function get(orgId, rawId) {
  const id = parseId(rawId);
  const r = await db().query(`SELECT ${PUBLIC_COLS} FROM employer_requests WHERE id = $1 AND employer_id = $2`, [id, orgId]);
  if (r.rowCount === 0) throw new HttpError(404, "Not found");
  return r.rows[0];
}

async function create(user, orgId, input) {
  const v = validate(input, { partial: false });
  return inTransaction(async (client) => {
    // Serialise per employer so concurrent submissions cannot slip past the cap.
    await client.query("SELECT 1 FROM crm_employers WHERE id = $1 FOR UPDATE", [orgId]);
    const used = await client.query("SELECT count(*)::int AS n FROM employer_requests WHERE employer_id = $1 AND created_at > now() - interval '24 hours'", [orgId]);
    if (used.rows[0].n >= dailyCap()) {
      const e = new HttpError(429, "Daily request limit reached");
      e.retryAfter = 3600;
      throw e;
    }
    const cols = ["employer_id", "status", ...Object.keys(v)];
    const vals = [orgId, "submitted", ...Object.values(v)];
    const r = await client.query(
      `INSERT INTO employer_requests (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      vals
    );
    const id = r.rows[0].id;
    await timeline.add(client, { entity: "employer_request", entityId: id, actorId: user.id, event: "created", detail: { employer_id: Number(orgId), title: v.title } });
    await logAudit({ client, userId: user.id, action: "employer.request.create", tableName: "employer_requests", recordId: String(id), newData: { employer_id: Number(orgId), status: "submitted", title: v.title } });
    return (await client.query(`SELECT ${PUBLIC_COLS} FROM employer_requests WHERE id = $1`, [id])).rows[0];
  });
}

async function lockOwn(client, orgId, id) {
  const r = await client.query("SELECT id, status, title FROM employer_requests WHERE id = $1 AND employer_id = $2 FOR UPDATE", [id, orgId]);
  if (r.rowCount === 0) throw new HttpError(404, "Not found");
  return r.rows[0];
}

async function update(user, orgId, rawId, input) {
  const id = parseId(rawId);
  const v = validate(input, { partial: true });
  return inTransaction(async (client) => {
    const cur = await lockOwn(client, orgId, id);
    if (cur.status !== "submitted") throw new HttpError(409, "Request can no longer be edited");
    const keys = Object.keys(v);
    const sets = keys.map((k, i) => `${k} = $${i + 3}`);
    await client.query(`UPDATE employer_requests SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND employer_id = $2`, [id, orgId, ...keys.map((k) => v[k])]);
    await timeline.add(client, { entity: "employer_request", entityId: id, actorId: user.id, event: "updated", detail: { fields: keys } });
    await logAudit({ client, userId: user.id, action: "employer.request.update", tableName: "employer_requests", recordId: String(id), newData: { fields: keys } });
    return (await client.query(`SELECT ${PUBLIC_COLS} FROM employer_requests WHERE id = $1`, [id])).rows[0];
  });
}

async function cancel(user, orgId, rawId) {
  const id = parseId(rawId);
  return inTransaction(async (client) => {
    const cur = await lockOwn(client, orgId, id);
    if (cur.status !== "submitted" && cur.status !== "in_review") throw new HttpError(409, "Request can no longer be cancelled");
    await client.query("UPDATE employer_requests SET status = 'cancelled', updated_at = now() WHERE id = $1 AND employer_id = $2", [id, orgId]);
    await timeline.add(client, { entity: "employer_request", entityId: id, actorId: user.id, event: "cancelled", detail: { from: cur.status, to: "cancelled" } });
    await logAudit({ client, userId: user.id, action: "employer.request.cancel", tableName: "employer_requests", recordId: String(id), oldData: { status: cur.status }, newData: { status: "cancelled" } });
    return (await client.query(`SELECT ${PUBLIC_COLS} FROM employer_requests WHERE id = $1`, [id])).rows[0];
  });
}

module.exports = { getOrg, list, get, create, update, cancel, dailyCap };
