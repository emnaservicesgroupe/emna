// DB-backed fixed-window rate limiter (table public_rate_limit), so limits survive restarts and are
// shared across processes. Keys must already be non-identifying (hashes), never raw IPs or emails.
const crypto = require("crypto");
const net = require("net");

// Without SITE_IP_SALT every process gets its own random salt (hashes then differ between restarts, which only
// resets counters); a fixed, publicly known default would make the stored hashes reversible for IPv4.
const PROCESS_SALT = crypto.randomBytes(32).toString("hex");
let warned = false;

function salt() {
  if (process.env.SITE_IP_SALT) return process.env.SITE_IP_SALT;
  if (process.env.NODE_ENV === "production" && !warned) {
    warned = true;
    console.warn("SITE_IP_SALT is not set; using a random per-process salt for public-form hashes (rate limits reset on every restart).");
  }
  return PROCESS_SALT;
}

/** sha256(SITE_IP_SALT + value) as hex. */
function hashWithSalt(value) {
  return crypto.createHash("sha256").update(salt() + String(value ?? "")).digest("hex");
}

/**
 * Normalises a client address before hashing: IPv4-mapped IPv6 becomes IPv4, other IPv6 addresses are reduced to
 * their /64 network (one subscriber usually owns a whole /64, so per-address limits would be trivial to evade).
 * Anything unparsable is returned as given.
 */
function bucketIp(ip) {
  if (ip === undefined || ip === null) return "";
  let s = String(ip).trim().toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (net.isIPv4(s)) return s;
  if (!net.isIPv6(s)) return String(ip);
  let tail = [];
  const dot = s.lastIndexOf(":");
  if (s.slice(dot + 1).includes(".")) {
    const v4 = s.slice(dot + 1).split(".").map(Number);
    tail = [((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16)];
    s = s.slice(0, dot + 1) + tail.join(":");
  }
  const [headPart, tailPart] = s.split("::");
  const head = headPart ? headPart.split(":") : [];
  const rest = tailPart === undefined ? [] : tailPart ? tailPart.split(":") : [];
  const groups = tailPart === undefined ? head : [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest];
  const g = groups.map((x) => parseInt(x, 16));
  if (g.length !== 8 || g.some((n) => !Number.isInteger(n))) return String(ip);
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((n) => n.toString(16)).join(":")}::/64`;
}

function intEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

/** Deletes counters whose window started more than 2 days ago (at most `limit` rows per call). Returns the count. */
async function cleanupExpired(pool, { limit = 1000 } = {}) {
  const r = await pool.query(
    `DELETE FROM public_rate_limit WHERE (key, window_start) IN (
       SELECT key, window_start FROM public_rate_limit WHERE window_start < now() - interval '2 days' LIMIT $1)`,
    [limit]
  );
  return r.rowCount;
}

/**
 * Counts one hit for `key` in the current fixed window (aligned to the epoch, DB clock).
 * Returns { allowed, retryAfter } where retryAfter is seconds until the window ends.
 */
async function hit(pool, key, { windowMs, max }) {
  const r = await pool.query(
    `WITH w AS (
       SELECT to_timestamp(floor(extract(epoch FROM now()) * 1000 / $2::float8) * $2::float8 / 1000) AS ws
     ), up AS (
       INSERT INTO public_rate_limit (key, window_start, count)
       SELECT $1, ws, 1 FROM w
       ON CONFLICT (key, window_start) DO UPDATE SET count = public_rate_limit.count + 1
       RETURNING count, window_start
     )
     SELECT up.count,
            GREATEST(1, ceil(extract(epoch FROM (up.window_start + ($2::float8 / 1000) * interval '1 second' - now()))))::int AS retry_after
       FROM up`,
    [key, windowMs]
  );
  const { count, retry_after: retryAfter } = r.rows[0];
  if (Math.random() < 0.01) await cleanupExpired(pool).catch(() => {});
  return { allowed: count <= max, retryAfter };
}

module.exports = { hit, hashWithSalt, bucketIp, intEnv, cleanupExpired };
