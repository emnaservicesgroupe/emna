// Personal access tokens for the read-only MCP server (stage 7). The secret is shown once and never stored: only its sha256 (hex).
// Every mutation runs in a transaction together with its audit row; neither the secret nor the hash ever reaches an audit row, a log or an error.
const crypto = require("crypto");
const db = require("../../db");
const { PERMISSIONS } = require("../../middleware/role");
const { logAudit } = require("../../utils/audit");
const { HttpError } = require("../jobsearch/httpError");
const { PAT_PREFIX } = require("./auth");

const MAX_ACTIVE = 5;
const MAX_DAYS = 90;
const SECRET_RE = /^vita_pat_[A-Za-z0-9_-]{43}$/;
const ADMIN_ROLES = new Set(["Admin", "SuperAdmin"]);
const TOUCH_INTERVAL = "1 minute";

const sha256hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** Constant-time comparison of two hex digests (equal length by construction; unequal lengths are simply false). */
function hashEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const canUseMcp = (role) => {
  const p = PERMISSIONS[role] || [];
  return p.includes("*") || p.includes("mcp:use");
};

function defaultDays() {
  const n = Number(process.env.MCP_TOKEN_DEFAULT_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : 30;
}

function cleanName(name) {
  if (typeof name !== "string") throw new HttpError(400, "name is required (1 to 80 characters)");
  const n = name.trim();
  // eslint-disable-next-line no-control-regex
  if (n.length < 1 || n.length > 80 || /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(n)) throw new HttpError(400, "name is required (1 to 80 characters, no control characters)");
  return n;
}

function cleanDays(days) {
  if (days === undefined || days === null) return defaultDays();
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new HttpError(400, `days must be a whole number from 1 to ${MAX_DAYS}`);
  return days;
}

function requireActor(user) {
  if (!user || !Number.isSafeInteger(user.id) || user.id < 1) throw new HttpError(401, "Unauthorized");
  if (!canUseMcp(user.role)) throw new HttpError(403, "Permission denied: mcp:use");
}

async function inTx(fn) {
  const client = await db.connect();
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

/** @returns {Promise<{id:string, secret:string, prefix:string, expires_at:Date}>} the secret is returned here and nowhere else, ever. */
async function createToken(user, { name, days } = {}) {
  requireActor(user);
  const n = cleanName(name);
  const d = cleanDays(days);
  const random = crypto.randomBytes(32).toString("base64url"); // 43 url-safe characters
  const secret = PAT_PREFIX + random;
  const prefix = random.slice(0, 8);
  return inTx(async (client) => {
    // Serialise concurrent creations of the same user so the cap of 5 cannot be raced.
    const owner = await client.query("SELECT is_active FROM users WHERE id = $1 FOR UPDATE", [user.id]);
    if (owner.rowCount === 0 || !owner.rows[0].is_active) throw new HttpError(401, "Session expired");
    const active = await client.query("SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()", [user.id]);
    if (active.rows[0].n >= MAX_ACTIVE) throw new HttpError(409, `At most ${MAX_ACTIVE} active tokens per user: revoke one first`);
    const ins = await client.query(
      `INSERT INTO api_tokens (user_id, name, prefix, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 day')) RETURNING id, expires_at`,
      [user.id, n, prefix, sha256hex(secret), d]
    );
    const row = ins.rows[0];
    await logAudit({ userId: user.id, action: "mcp.token.create", tableName: "api_tokens", recordId: String(row.id), newData: { name: n, prefix, days: d, expires_at: row.expires_at }, client });
    return { id: String(row.id), secret, prefix, expires_at: row.expires_at };
  });
}

/** Own tokens; Admin / SuperAdmin see everyone's (with the owner's name). Never the hash, the IP hash or the secret. */
async function listTokens(user) {
  requireActor(user);
  const all = ADMIN_ROLES.has(user.role);
  const r = await db.query(
    `SELECT t.id, t.user_id, u.full_name AS owner_name, t.name, t.prefix, t.scopes, t.created_at, t.expires_at, t.last_used_at, t.revoked_at, t.revoked_by,
            CASE WHEN t.revoked_at IS NOT NULL THEN 'revoked' WHEN t.expires_at <= now() THEN 'expired' ELSE 'active' END AS status
       FROM api_tokens t JOIN users u ON u.id = t.user_id
      ${all ? "" : "WHERE t.user_id = $1"}
      ORDER BY t.id DESC LIMIT 500`,
    all ? [] : [user.id]
  );
  return { rows: r.rows.map((x) => ({ ...x, id: String(x.id) })) };
}

/** Own token, or any token for Admin / SuperAdmin. Idempotent; the first revocation is audited. A token that is not yours is a plain 404. */
async function revokeToken(user, id) {
  requireActor(user);
  if (typeof id !== "string" && typeof id !== "number") throw new HttpError(400, "Invalid token id");
  if (!/^[1-9][0-9]{0,17}$/.test(String(id))) throw new HttpError(400, "Invalid token id");
  return inTx(async (client) => {
    const cur = await client.query("SELECT id, user_id, revoked_at FROM api_tokens WHERE id = $1 FOR UPDATE", [String(id)]);
    const row = cur.rows[0];
    if (!row || (row.user_id !== user.id && !ADMIN_ROLES.has(user.role))) throw new HttpError(404, "Token not found");
    if (row.revoked_at) return { id: String(row.id), revoked: true, already_revoked: true };
    await client.query("UPDATE api_tokens SET revoked_at = now(), revoked_by = $2 WHERE id = $1", [row.id, user.id]);
    await logAudit({ userId: user.id, action: "mcp.token.revoke", tableName: "api_tokens", recordId: String(row.id), newData: { owner_id: row.user_id }, client });
    return { id: String(row.id), revoked: true, already_revoked: false };
  });
}

const USAGE_MAX = 50;

/**
 * Recent MCP calls from the audit log: tool, outcome, duration, row count and which token. Own calls; Admin / SuperAdmin see everyone's.
 * Metadata only: the arguments digest and anything else in the audit row are never selected, and no data is ever recorded there.
 */
async function listUsage(user, limit) {
  requireActor(user);
  let n = USAGE_MAX;
  if (limit !== undefined) {
    if (typeof limit !== "string" || !/^[1-9][0-9]?$/.test(limit) || Number(limit) > USAGE_MAX) throw new HttpError(400, `limit must be a whole number from 1 to ${USAGE_MAX}`);
    n = Number(limit);
  }
  const all = ADMIN_ROLES.has(user.role);
  const r = await db.query(
    `SELECT a.id, a.created_at, a.new_data->>'tool' AS tool, a.new_data->>'outcome' AS outcome,
            CASE WHEN (a.new_data->>'duration_ms') ~ '^[0-9]{1,9}$' THEN (a.new_data->>'duration_ms')::int END AS duration_ms,
            CASE WHEN (a.new_data->>'rows') ~ '^[0-9]{1,9}$' THEN (a.new_data->>'rows')::int END AS rows,
            t.name AS token_name, t.prefix AS token_prefix, u.full_name AS owner_name
       FROM audit_logs a
       LEFT JOIN api_tokens t ON t.id::text = a.record_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'MCP_CALL' ${all ? "" : "AND a.user_id = $2"}
      ORDER BY a.id DESC LIMIT $1`,
    all ? [n] : [n, user.id]
  );
  return { rows: r.rows.map((x) => ({ ...x, id: String(x.id) })) };
}

function ipHash(ip) {
  if (typeof ip !== "string" || !ip) return null;
  return crypto.createHmac("sha256", process.env.JWT_SECRET || "mcp").update(ip).digest("hex");
}

/**
 * Secret -> {user, token}, or null. The CURRENT user row is loaded: it must be active and still hold mcp:use (demotion and deactivation
 * apply at once). One generic null for every failure (malformed, unknown, expired, revoked, deactivated, demoted): the caller cannot tell which.
 * Never throws for a bad credential and never logs it.
 */
async function authenticate(secret, { ip } = {}) {
  if (typeof secret !== "string" || !SECRET_RE.test(secret)) return null;
  const hash = sha256hex(secret);
  const r = await db.query(
    `SELECT t.id, t.name, t.prefix, t.scopes, t.token_hash, t.expires_at, t.revoked_at, (t.expires_at > now()) AS live,
            u.id AS uid, u.full_name, u.role, u.is_active
       FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`,
    [hash]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (!hashEquals(hash, row.token_hash)) return null;
  if (row.revoked_at || !row.live || !row.is_active || !canUseMcp(row.role)) return null;
  // last_used_at moves at most once per minute (one cheap conditional UPDATE, no write amplification on a busy token).
  await db.query(
    `UPDATE api_tokens SET last_used_at = now(), last_used_ip_hash = COALESCE($2, last_used_ip_hash)
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '${TOUCH_INTERVAL}')`,
    [row.id, ipHash(ip)]
  );
  return {
    user: { id: row.uid, role: row.role, full_name: row.full_name },
    token: { id: String(row.id), name: row.name, prefix: row.prefix, scopes: row.scopes, expires_at: row.expires_at },
  };
}

module.exports = { createToken, listTokens, revokeToken, listUsage, authenticate, hashEquals, sha256hex, canUseMcp, ipHash, MAX_ACTIVE, MAX_DAYS, SECRET_RE };
