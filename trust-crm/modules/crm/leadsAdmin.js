// Staff lead inbox: listing, detail, status/assignment changes and notes, with role scoping.
// Admin/SuperAdmin/Manager/Receptionist see every lead; Agent only leads assigned to them (others: 404).
const { HttpError } = require("../jobsearch/httpError");
const { PERMISSIONS } = require("../../middleware/role");
const { logAudit } = require("../../utils/audit");
const timeline = require("./timeline");

const db = () => require("../../db");
const STATUSES = ["new", "contacted", "qualified", "converted", "rejected", "spam"];
const SETTABLE_STATUSES = ["new", "contacted", "qualified", "rejected", "spam"]; // 'converted' only via Task 4's convert
const KINDS = ["candidate", "employer", "contact"];
const NOTE_MAX = 4000;
const COLUMNS = `l.id, l.kind, l.status, l.name, l.email, l.phone, l.country, l.profession, l.company, l.message, l.lang,
  l.consent_at, l.consent_text_version, l.source, l.assigned_to, l.candidate_id, l.created_at, l.updated_at`;

function hasPerm(user, perm) {
  const perms = (user && PERMISSIONS[user.role]) || [];
  return perms.includes("*") || perms.includes(perm);
}

const isAgent = (user) => Boolean(user && user.role === "Agent");

function posInt(v, label) {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `${label} must be a positive integer`);
  return n;
}

/** Parses a lead id from a URL segment; malformed ids are a 400 for every role (no enumeration signal). */
function parseId(raw) {
  return posInt(raw, "id");
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function requireWrite(user) {
  if (!hasPerm(user, "leads:write")) throw new HttpError(403, "Permission denied: leads:write");
}

async function listLeads(user, query = {}) {
  const where = [];
  const params = [];
  const add = (v) => (params.push(v), `$${params.length}`);

  const one = (v, label) => {
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new HttpError(400, `${label} must be a single value`);
    return v;
  };
  const status = one(query.status, "status");
  const kind = one(query.kind, "kind");
  const q = one(query.q, "q");
  const assignedTo = one(query.assignedTo, "assignedTo");
  const limitRaw = one(query.limit, "limit");
  const offsetRaw = one(query.offset, "offset");

  if (status !== undefined && status !== "") {
    if (!STATUSES.includes(status)) throw new HttpError(400, "invalid status");
    where.push(`l.status = ${add(status)}`);
  } else {
    where.push("l.status <> 'spam'");
  }
  if (kind !== undefined && kind !== "") {
    if (!KINDS.includes(kind)) throw new HttpError(400, "invalid kind");
    where.push(`l.kind = ${add(kind)}`);
  }
  if (assignedTo !== undefined && assignedTo !== "") where.push(`l.assigned_to = ${add(posInt(assignedTo, "assignedTo"))}`);
  if (q !== undefined && q.trim() !== "") {
    const needle = q.trim();
    if (needle.length > 100 || needle.includes("\u0000")) throw new HttpError(400, "q is invalid");
    const p = add(`%${likeEscape(needle)}%`);
    where.push(`(l.name ILIKE ${p} OR l.email ILIKE ${p} OR l.phone ILIKE ${p} OR l.company ILIKE ${p})`);
  }
  if (isAgent(user)) where.push(`l.assigned_to = ${add(user.id)}`);

  let limit = 25;
  if (limitRaw !== undefined && limitRaw !== "") limit = Math.min(posInt(limitRaw, "limit"), 100);
  let offset = 0;
  if (offsetRaw !== undefined && offsetRaw !== "") {
    if (!/^\d{1,7}$/.test(offsetRaw)) throw new HttpError(400, "offset must be a non-negative integer");
    offset = Number(offsetRaw);
  }

  const clause = where.join(" AND ");
  const total = await db().query(`SELECT count(*)::int AS n FROM crm_leads l WHERE ${clause}`, params);
  const rows = await db().query(
    `SELECT ${COLUMNS} FROM crm_leads l WHERE ${clause} ORDER BY l.created_at DESC, l.id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`,
    params
  );
  return { rows: rows.rows, total: total.rows[0].n };
}

/** Loads a lead the user may see, or throws 404. `client` + lock for use inside a transaction. */
async function loadScoped(client, user, id, { lock = false } = {}) {
  const params = [id];
  let scope = "";
  if (isAgent(user)) {
    params.push(user.id);
    scope = " AND l.assigned_to = $2";
  }
  const r = await client.query(`SELECT ${COLUMNS} FROM crm_leads l WHERE l.id = $1${scope}${lock ? " FOR UPDATE OF l" : ""}`, params);
  if (r.rowCount === 0) throw new HttpError(404, "Not found");
  return r.rows[0];
}

async function getLead(user, rawId) {
  const id = parseId(rawId);
  const lead = await loadScoped(db(), user, id);
  const notes = await timeline.list("lead", id, db());
  return { ...lead, timeline: notes };
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

async function updateLead(user, rawId, input) {
  const id = parseId(rawId);
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const hasStatus = body.status !== undefined;
  const hasAssign = body.assigned_to !== undefined;

  return inTransaction(async (client) => {
    const lead = await loadScoped(client, user, id, { lock: true }); // 404 before any permission signal
    requireWrite(user);
    if (!hasStatus && !hasAssign) throw new HttpError(400, "status or assigned_to is required");

    const sets = [];
    const params = [id];
    const changes = [];
    if (hasStatus) {
      if (typeof body.status !== "string" || !SETTABLE_STATUSES.includes(body.status)) {
        throw new HttpError(400, `status must be one of ${SETTABLE_STATUSES.join(", ")}`);
      }
      if (lead.status === "converted") throw new HttpError(409, "A converted lead cannot change status");
      if (body.status !== lead.status) {
        params.push(body.status);
        sets.push(`status = $${params.length}`);
        changes.push({ event: "status_changed", detail: { from: lead.status, to: body.status } });
      }
    }
    if (hasAssign) {
      if (!hasPerm(user, "users:write")) throw new HttpError(403, "Permission denied: users:write");
      let target = null;
      if (body.assigned_to !== null) {
        target = posInt(body.assigned_to, "assigned_to");
        const u = await client.query("SELECT 1 FROM users WHERE id = $1 AND is_active = true AND role <> 'Candidate'", [target]);
        if (u.rowCount === 0) throw new HttpError(400, "assigned_to must be an active staff user");
      }
      if (target !== lead.assigned_to) {
        params.push(target);
        sets.push(`assigned_to = $${params.length}`);
        changes.push({ event: "assigned", detail: { from: lead.assigned_to, to: target } });
      }
    }

    let updated = lead;
    if (sets.length) {
      try {
        const r = await client.query(`UPDATE crm_leads SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING id`, params);
        if (r.rowCount === 0) throw new HttpError(404, "Not found");
      } catch (err) {
        if (err && err.code === "23505") throw new HttpError(409, "Another active lead already uses these contact details");
        throw err;
      }
      for (const c of changes) {
        await timeline.add(client, { entity: "lead", entityId: id, actorId: user.id, event: c.event, detail: c.detail });
      }
      const fresh = await client.query(`SELECT ${COLUMNS} FROM crm_leads l WHERE l.id = $1`, [id]);
      updated = fresh.rows[0];
      await logAudit({
        client,
        userId: user.id,
        action: "crm.lead.update",
        tableName: "crm_leads",
        recordId: String(id),
        oldData: { status: lead.status, assigned_to: lead.assigned_to },
        newData: { status: updated.status, assigned_to: updated.assigned_to },
      });
    }
    return updated;
  });
}

async function addNote(user, rawId, text) {
  const id = parseId(rawId);
  return inTransaction(async (client) => {
    await loadScoped(client, user, id);
    requireWrite(user);
    if (typeof text !== "string") throw new HttpError(400, "text is required");
    const t = text.trim();
    if (!t) throw new HttpError(400, "text is required");
    if (t.length > NOTE_MAX) throw new HttpError(400, `text must be at most ${NOTE_MAX} characters`);
    if (t.includes("\u0000")) throw new HttpError(400, "text contains invalid characters");
    const row = await timeline.add(client, { entity: "lead", entityId: id, actorId: user.id, event: "note", detail: { text: t } });
    await logAudit({
      client,
      userId: user.id,
      action: "crm.lead.note",
      tableName: "crm_leads",
      recordId: String(id),
      newData: { timeline_id: row.id, length: t.length },
    });
    return row;
  });
}

module.exports = { listLeads, getLead, updateLead, addNote, STATUSES, SETTABLE_STATUSES, NOTE_MAX };
