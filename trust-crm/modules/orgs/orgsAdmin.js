// Staff management of employer and agency organisations: list/create/update, portal-user invite, suspend/reactivate.
// Every mutation writes crm_timeline + audit_logs in the same transaction. Org status is managed ONLY by suspend/reactivate.
// Invite creates (or adopts an unlinked same-role) users row + crm_org_accounts link; the OTP code mail is requested
// after commit through the same helper conversion uses (convert.sendInvite).
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { HttpError } = require("../jobsearch/httpError");
const otp = require("../jobsearch/otp");
const { logAudit } = require("../../utils/audit");
const timeline = require("../crm/timeline");
const { inTransaction, parseId } = require("../crm/leadsAdmin");
const { sendInvite } = require("../crm/convert");

const db = () => require("../../db");

const TYPES = {
  employer: {
    table: "crm_employers",
    role: "Employer",
    statuses: ["new", "active", "suspended", "inactive"],
    fields: { name: 200, contact_name: 200, email: 320, phone: 40, country: 100, sector: 100, notes: 4000 },
  },
  agency: {
    table: "crm_agencies",
    role: "Agency",
    statuses: ["active", "suspended"],
    fields: { name: 200, contact_name: 200, email: 320, phone: 40, country: 100, notes: 4000 },
  },
};
const cfg = (type) => TYPES[type];
const likeEscape = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function clean(v, label, max) {
  if (v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${label} must be a string`);
  const t = v.trim();
  if (t.includes("\u0000")) throw new HttpError(400, `${label} contains invalid characters`);
  if (t.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  return t === "" ? null : t;
}

/** Validates the provided keys only. Unknown keys (incl. status) are a 400. */
function validate(type, input, { requireName }) {
  const c = cfg(type);
  const body = isObj(input) ? input : {};
  for (const k of Object.keys(body)) {
    if (k === "status") throw new HttpError(400, "status is managed by suspend/reactivate");
    if (!(k in c.fields)) throw new HttpError(400, `Unknown field: ${k}`);
  }
  const out = {};
  for (const [k, max] of Object.entries(c.fields)) {
    if (body[k] === undefined) continue;
    let v = clean(body[k], k, max);
    if (k === "name" && v === null) throw new HttpError(400, "name is required");
    if (k === "email" && v !== null) {
      v = otp.normalizeEmail(v);
      if (!v) throw new HttpError(400, "email is invalid");
    }
    out[k] = v;
  }
  if (requireName && !out.name) throw new HttpError(400, "name is required");
  return out;
}

const columns = (type) => ["id", ...Object.keys(cfg(type).fields), "status", "created_at", "updated_at"].join(", ");

async function list(type, query = {}) {
  const c = cfg(type);
  const one = (v, label) => {
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new HttpError(400, `${label} must be a single value`);
    return v;
  };
  const status = one(query.status, "status");
  const q = one(query.q, "q");
  const limitRaw = one(query.limit, "limit");
  const offsetRaw = one(query.offset, "offset");
  const where = [];
  const params = [];
  const add = (v) => (params.push(v), `$${params.length}`);
  if (status !== undefined && status !== "") {
    if (!c.statuses.includes(status)) throw new HttpError(400, "invalid status");
    where.push(`o.status = ${add(status)}`);
  }
  if (q !== undefined && q.trim() !== "") {
    const needle = q.trim();
    if (needle.length > 100 || needle.includes("\u0000")) throw new HttpError(400, "q is invalid");
    const p = add(`%${likeEscape(needle)}%`);
    where.push(`(o.name ILIKE ${p} OR o.contact_name ILIKE ${p} OR o.email ILIKE ${p} OR o.phone ILIKE ${p})`);
  }
  let limit = 25;
  if (limitRaw !== undefined && limitRaw !== "") {
    if (!/^\d{1,9}$/.test(limitRaw) || Number(limitRaw) < 1) throw new HttpError(400, "limit must be a positive integer");
    limit = Math.min(Number(limitRaw), 100);
  }
  let offset = 0;
  if (offsetRaw !== undefined && offsetRaw !== "") {
    if (!/^\d{1,7}$/.test(offsetRaw)) throw new HttpError(400, "offset must be a non-negative integer");
    offset = Number(offsetRaw);
  }
  const clause = where.length ? where.join(" AND ") : "true";
  const total = await db().query(`SELECT count(*)::int AS n FROM ${c.table} o WHERE ${clause}`, params);
  const cols = columns(type).split(", ").map((x) => `o.${x}`).join(", ");
  const rows = await db().query(
    `SELECT ${cols}, (SELECT count(*)::int FROM crm_org_accounts oa WHERE oa.org_type = '${type}' AND oa.org_id = o.id) AS portal_users
       FROM ${c.table} o WHERE ${clause} ORDER BY o.created_at DESC, o.id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`,
    params
  );
  return { rows: rows.rows, total: total.rows[0].n };
}

async function get(type, rawId) {
  const id = parseId(rawId);
  const c = cfg(type);
  const r = await db().query(`SELECT ${columns(type)} FROM ${c.table} WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw new HttpError(404, "Not found");
  const users = await db().query(
    `SELECT u.id, u.full_name, u.email, u.is_active, oa.created_at AS linked_at
       FROM crm_org_accounts oa JOIN users u ON u.id = oa.user_id
      WHERE oa.org_type = $1 AND oa.org_id = $2 ORDER BY u.id`,
    [type, id]
  );
  return { ...r.rows[0], portal_users: users.rows, timeline: await timeline.list(type, id, db()) };
}

async function create(user, type, input) {
  const c = cfg(type);
  const data = validate(type, input, { requireName: true });
  const keys = Object.keys(data);
  return inTransaction(async (client) => {
    const extra = type === "agency" ? ["created_by"] : [];
    const names = [...keys, ...extra];
    const vals = [...keys.map((k) => data[k]), ...(type === "agency" ? [user.id] : [])];
    const r = await client.query(
      `INSERT INTO ${c.table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${columns(type)}`,
      vals
    );
    const row = r.rows[0];
    await timeline.add(client, { entity: type, entityId: row.id, actorId: user.id, event: "created", detail: { name: row.name } });
    await logAudit({ client, userId: user.id, action: `crm.${type}.create`, tableName: c.table, recordId: String(row.id), newData: { name: row.name, status: row.status } });
    return row;
  });
}

async function update(user, type, rawId, input) {
  const id = parseId(rawId);
  const c = cfg(type);
  const data = validate(type, input, { requireName: false });
  const keys = Object.keys(data);
  if (keys.length === 0) throw new HttpError(400, "No fields to update");
  return inTransaction(async (client) => {
    const cur = await client.query(`SELECT ${columns(type)} FROM ${c.table} WHERE id = $1 FOR UPDATE`, [id]);
    if (cur.rowCount === 0) throw new HttpError(404, "Not found");
    const before = cur.rows[0];
    const changed = keys.filter((k) => (before[k] ?? null) !== data[k]);
    if (changed.length === 0) return before;
    const sets = changed.map((k, i) => `${k} = $${i + 2}`);
    const r = await client.query(`UPDATE ${c.table} SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${columns(type)}`, [id, ...changed.map((k) => data[k])]);
    const oldData = Object.fromEntries(changed.map((k) => [k, before[k] ?? null]));
    const newData = Object.fromEntries(changed.map((k) => [k, data[k]]));
    await timeline.add(client, { entity: type, entityId: id, actorId: user.id, event: "updated", detail: { fields: changed } });
    await logAudit({ client, userId: user.id, action: `crm.${type}.update`, tableName: c.table, recordId: String(id), oldData, newData });
    return r.rows[0];
  });
}

async function invite(user, type, rawId, input) {
  const id = parseId(rawId);
  const c = cfg(type);
  const body = isObj(input) ? input : {};
  const email = otp.normalizeEmail(body.email);
  if (!email) throw new HttpError(400, "A valid email is required");
  const fullName = clean(body.full_name, "full_name", 200);
  if (!fullName) throw new HttpError(400, "full_name is required");
  // Unusable password: bcrypt of random bytes that are never stored or shown; hashed before the transaction.
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);

  const out = await inTransaction(async (client) => {
    const org = await client.query(`SELECT id, status FROM ${c.table} WHERE id = $1 FOR UPDATE`, [id]);
    if (org.rowCount === 0) throw new HttpError(404, "Not found");
    if (org.rows[0].status === "suspended") throw new HttpError(409, "The organisation is suspended");

    let userId;
    const ex = await client.query("SELECT id, role, is_active FROM users WHERE lower(email) = $1 FOR UPDATE", [email]);
    if (ex.rowCount > 0) {
      const row = ex.rows[0];
      if (row.role !== c.role) throw new HttpError(409, "A user with this email already exists");
      const linked = await client.query("SELECT 1 FROM crm_org_accounts WHERE user_id = $1", [row.id]);
      if (linked.rowCount > 0) throw new HttpError(409, "This email already belongs to a portal user");
      if (!row.is_active) throw new HttpError(409, "A deactivated user with this email already exists");
      userId = row.id;
    } else {
      try {
        const nu = await client.query("INSERT INTO users (full_name, email, password, role, is_active) VALUES ($1,$2,$3,$4,true) RETURNING id", [fullName, email, unusable, c.role]);
        userId = nu.rows[0].id;
      } catch (err) {
        if (err && err.code === "23505") throw new HttpError(409, "A user with this email already exists");
        throw err;
      }
    }
    try {
      await client.query("INSERT INTO crm_org_accounts (user_id, org_type, org_id) VALUES ($1,$2,$3)", [userId, type, id]);
    } catch (err) {
      if (err && err.code === "23505") throw new HttpError(409, "This email already belongs to a portal user");
      throw err;
    }
    await timeline.add(client, { entity: type, entityId: id, actorId: user.id, event: "portal_user_invited", detail: { user_id: userId, email } });
    await logAudit({ client, userId: user.id, action: `crm.${type}.invite`, tableName: c.table, recordId: String(id), newData: { user_id: userId, email, role: c.role } });
    return { user: { id: userId, email, full_name: fullName, role: c.role }, org_id: id };
  });
  out.inviteSent = await sendInvite(email);
  return out;
}

async function setSuspended(user, type, rawId, suspend) {
  const id = parseId(rawId);
  const c = cfg(type);
  const target = suspend ? "suspended" : "active";
  return inTransaction(async (client) => {
    const cur = await client.query(`SELECT ${columns(type)} FROM ${c.table} WHERE id = $1 FOR UPDATE`, [id]);
    if (cur.rowCount === 0) throw new HttpError(404, "Not found");
    const before = cur.rows[0];
    if (suspend ? before.status === "suspended" : before.status !== "suspended") return before; // idempotent no-op
    const r = await client.query(`UPDATE ${c.table} SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${columns(type)}`, [id, target]);
    // Existing tokens die at once (tv mismatch) and a suspended org's users cannot log in (is_active=false).
    const u = await client.query(
      `UPDATE users SET is_active = $3, token_version = token_version + 1
        WHERE id IN (SELECT user_id FROM crm_org_accounts WHERE org_type = $1 AND org_id = $2) AND role = $4
        RETURNING id`,
      [type, id, !suspend, c.role]
    );
    await timeline.add(client, { entity: type, entityId: id, actorId: user.id, event: suspend ? "suspended" : "reactivated", detail: { from: before.status, to: target, users: u.rowCount } });
    await logAudit({
      client,
      userId: user.id,
      action: `crm.${type}.${suspend ? "suspend" : "reactivate"}`,
      tableName: c.table,
      recordId: String(id),
      oldData: { status: before.status },
      newData: { status: target, users_affected: u.rowCount },
    });
    return r.rows[0];
  });
}

module.exports = { list, get, create, update, invite, suspend: (u, t, id) => setSuspended(u, t, id, true), reactivate: (u, t, id) => setSuspended(u, t, id, false), TYPES };
