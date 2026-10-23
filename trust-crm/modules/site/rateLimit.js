// DB-backed fixed-window rate limiter (table public_rate_limit), so limits survive restarts and are
// shared across processes. Keys must already be non-identifying (hashes), never raw IPs or emails.
const crypto = require("crypto");

const DEV_SALT = "vita-dev-insecure-salt";
let warned = false;

function salt() {
  if (process.env.SITE_IP_SALT) return process.env.SITE_IP_SALT;
  if (process.env.NODE_ENV === "production" && !warned) {
    warned = true;
    console.warn("SITE_IP_SALT is not set; using an insecure development salt for public-form hashes.");
  }
  return DEV_SALT;
}

/** sha256(SITE_IP_SALT + value) as hex. */
function hashWithSalt(value) {
  return crypto.createHash("sha256").update(salt() + String(value ?? "")).digest("hex");
}

function intEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : dflt;
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
  if (Math.random() < 0.01) {
    pool.query("DELETE FROM public_rate_limit WHERE window_start < now() - interval '3 days'").catch(() => {});
  }
  return { allowed: count <= max, retryAfter };
}

module.exports = { hit, hashWithSalt, intEnv };
