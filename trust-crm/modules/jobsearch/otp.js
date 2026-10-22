// Candidate email-OTP login.
//
// - 6-digit code from crypto.randomInt, stored only as a bcrypt hash in js_otps.
// - 10-minute expiry, single use (atomic UPDATE ... WHERE used_at IS NULL RETURNING),
//   max 5 attempts per code (counted before comparing, so the 6th try is refused).
// - Requesting a new code expires any previous live code for that email.
// - Resend cooldown 60 s: enforced in memory for every email (-> 429 from the route,
//   identical for known and unknown emails) and in the DB for real accounts (silent
//   backstop that survives restarts).
// - Request rate limits per email and per IP, and a verify limit per IP, are kept IN
//   MEMORY (per process; reset on restart). Multi-instance deployments need a shared
//   store; the per-code attempt cap and DB cooldown remain in the DB regardless.
// - Unknown / inactive / non-Candidate / unlinked emails: identical response, no row,
//   no mail, comparable bcrypt work to avoid gross timing differences.
// - Issuance + mail delivery run after the response (no timing difference on the
//   request path); tests await them with _testing.flush().
// - The code is never logged and never returned.
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { HttpError } = require("./httpError");

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 60 * 1000;
const TOKEN_TTL = "12h";
const BCRYPT_COST = 10;
const limits = {
  windowMs: 15 * 60 * 1000,
  emailRequests: 5,
  ipRequests: 20,
  ipVerifies: 30,
};

const EMAIL_RE = /^[^@\s]{1,128}@[^@\s]{1,253}$/;

function normalizeEmail(email) {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return e.length <= 320 && EMAIL_RE.test(e) ? e : null;
}

// ---------------------------------------------------------------- rate limits (memory)
let nowFn = () => Date.now();
const hits = new Map(); // key -> array of timestamps (ms)

function recent(key, windowMs) {
  const t = nowFn();
  const list = (hits.get(key) || []).filter((ts) => t - ts < windowMs);
  if (list.length) hits.set(key, list);
  else hits.delete(key);
  return list;
}

function record(...keys) {
  const t = nowFn();
  for (const key of keys) {
    const list = hits.get(key) || [];
    list.push(t);
    hits.set(key, list);
  }
  if (hits.size > 50000) {
    for (const key of [...hits.keys()]) recent(key, limits.windowMs);
  }
}

function retryAfter(list, windowMs) {
  return Math.max(1, Math.ceil((list[0] + windowMs - nowFn()) / 1000));
}

/** Checks (and on success records) an OTP request. Same outcome for any email. */
function checkRequestLimit({ email, ip } = {}) {
  const e = normalizeEmail(email) || String(email || "").trim().toLowerCase();
  const emailKey = `req:email:${e}`;
  const ipKey = `req:ip:${ip || "unknown"}`;
  const last = recent(emailKey, limits.windowMs);
  if (last.length && nowFn() - last[last.length - 1] < COOLDOWN_MS) {
    return { ok: false, retryAfter: Math.ceil((last[last.length - 1] + COOLDOWN_MS - nowFn()) / 1000) };
  }
  if (last.length >= limits.emailRequests) return { ok: false, retryAfter: retryAfter(last, limits.windowMs) };
  const byIp = recent(ipKey, limits.windowMs);
  if (byIp.length >= limits.ipRequests) return { ok: false, retryAfter: retryAfter(byIp, limits.windowMs) };
  record(emailKey, ipKey);
  return { ok: true };
}

/** Checks (and on success records) an OTP verify attempt from an IP. */
function checkVerifyLimit({ ip } = {}) {
  const key = `verify:ip:${ip || "unknown"}`;
  const list = recent(key, limits.windowMs);
  if (list.length >= limits.ipVerifies) return { ok: false, retryAfter: retryAfter(list, limits.windowMs) };
  record(key);
  return { ok: true };
}

// ---------------------------------------------------------------- helpers
function db() {
  return require("../../db");
}

let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = bcrypt.hash(crypto.randomBytes(16).toString("hex"), BCRYPT_COST);
  return dummyHashPromise;
}

async function dummyCompare() {
  await bcrypt.compare("000000", await dummyHash());
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

async function findEligibleUser(email) {
  const r = await db().query(
    `SELECT u.id, u.token_version
       FROM users u
       JOIN js_candidate_accounts a ON a.user_id = u.id
      WHERE lower(u.email) = $1 AND u.role = 'Candidate' AND u.is_active = true
      ORDER BY u.id
      LIMIT 1`,
    [email]
  );
  return r.rows[0] || null;
}

function errTag(err) {
  return (err && (err.code || err.name)) || "unknown";
}

// ---------------------------------------------------------------- request
async function issue(email) {
  if (!email) {
    await bcrypt.hash(generateCode(), BCRYPT_COST);
    return;
  }
  const user = await findEligibleUser(email);
  const code = generateCode();
  const codeHash = await bcrypt.hash(code, BCRYPT_COST); // done for unknown emails too (timing)
  if (!user) return;

  const client = await db().connect();
  let otpId = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('js_otp:' || $1))", [email]);
    const cooling = await client.query(
      "SELECT 1 FROM js_otps WHERE email = $1 AND created_at > now() - make_interval(secs => $2) LIMIT 1",
      [email, COOLDOWN_MS / 1000]
    );
    if (cooling.rowCount === 0) {
      await client.query("UPDATE js_otps SET expires_at = now() WHERE email = $1 AND used_at IS NULL AND expires_at > now()", [email]);
      const ins = await client.query(
        `INSERT INTO js_otps (email, code_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING id`,
        [email, codeHash, CODE_TTL_MINUTES]
      );
      otpId = ins.rows[0].id;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (otpId === null) return; // DB cooldown: silently do nothing

  let accepted = false;
  try {
    const mail = require("./mail");
    const result = await mail.send({
      to: email,
      subject: "Your VITA sign-in code",
      text:
        `Your VITA sign-in code is ${code}.\n\n` +
        `It expires in ${CODE_TTL_MINUTES} minutes and can be used once. ` +
        "If you did not request it, you can ignore this email.",
    });
    accepted = Boolean(result && result.accepted);
  } catch (err) {
    console.error("OTP mail send failed for user", user.id, errTag(err));
  }
  if (!accepted) {
    // Never leave an undelivered code valid.
    await db().query("UPDATE js_otps SET expires_at = now() WHERE id = $1", [otpId]);
    console.warn("OTP mail was not accepted by the mail provider for user", user.id);
  }
}

// Issuance (lookup, hashing, DB transaction, mail delivery) runs in the background
// after the caller has answered, so known and unknown emails take the same time on
// the request path. Errors are caught and logged without the code or email.
const pending = new Set();

/**
 * Always resolves immediately; behaves identically whether or not the account exists.
 * The code is issued and mailed asynchronously (see _testing.flush()).
 */
async function requestOtp(email) {
  const normalized = normalizeEmail(email);
  const job = new Promise((resolve) => setImmediate(resolve))
    .then(() => issue(normalized))
    .catch((err) => {
      console.error("OTP request failed:", errTag(err));
    })
    .finally(() => pending.delete(job));
  pending.add(job);
}

// ---------------------------------------------------------------- verify
function invalid() {
  return new HttpError(401, "Invalid or expired code");
}

async function verifyOtp(email, code) {
  const e = normalizeEmail(email);
  const c = typeof code === "string" || typeof code === "number" ? String(code).trim() : "";
  if (!e || !/^\d{6}$/.test(c)) {
    await dummyCompare();
    throw invalid();
  }
  const row = (
    await db().query(
      `UPDATE js_otps SET attempts = attempts + 1
        WHERE id = (SELECT id FROM js_otps
                     WHERE email = $1 AND used_at IS NULL AND expires_at > now()
                     ORDER BY created_at DESC, id DESC LIMIT 1)
          AND attempts < $2 AND used_at IS NULL AND expires_at > now()
        RETURNING id, code_hash`,
      [e, MAX_ATTEMPTS]
    )
  ).rows[0];
  if (!row) {
    await dummyCompare();
    throw invalid();
  }
  if (!(await bcrypt.compare(c, row.code_hash))) throw invalid();

  const used = await db().query(
    "UPDATE js_otps SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id",
    [row.id]
  );
  if (used.rowCount === 0) throw invalid();

  const user = await findEligibleUser(e);
  if (!user) throw invalid();
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not configured");
  const token = jwt.sign({ id: user.id, role: "Candidate", tv: user.token_version }, process.env.JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
  return { token };
}

module.exports = {
  requestOtp,
  verifyOtp,
  checkRequestLimit,
  checkVerifyLimit,
  normalizeEmail,
  _testing: {
    limits,
    reset() {
      hits.clear();
    },
    /** Resolves once all background OTP issuance has finished. */
    async flush() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    setNow(fn) {
      nowFn = fn || (() => Date.now());
    },
  },
};
