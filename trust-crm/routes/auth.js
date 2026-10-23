const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const userModel = require("../models/userModel");
const { verifyToken } = require("../middleware/auth");
const { checkPermission, PERMISSIONS } = require("../middleware/role");
const { logAudit } = require("../utils/audit");
const { checkPassword } = require("../utils/passwordPolicy");

const router = express.Router();

// Staff session lifetime: JWT_EXPIRES_IN (jsonwebtoken format: seconds, or a number with s/m/h/d, e.g. "12h",
// "7d"); default 12h. An invalid value falls back to the default instead of breaking logins.
const DEFAULT_EXPIRES_IN = "12h";
function tokenLifetime() {
  const v = String(process.env.JWT_EXPIRES_IN || "").trim();
  if (/^[1-9]\d{0,8}$/.test(v)) return Number(v);
  if (/^[1-9]\d{0,6}\s?(?:s|m|h|d)$/.test(v)) return v.replace(/\s/g, "");
  return DEFAULT_EXPIRES_IN;
}

router.post("/register", verifyToken, checkPermission("users:write"), async (req, res) => {
  try {
    const { full_name, email, password, role } = req.body;

    if (!full_name || !email || !password || !role) {
      return res.status(400).json({ error: "full_name, email, password and role are required" });
    }

    if (!PERMISSIONS[role]) {
      return res.status(400).json({ error: "Invalid role" });
    }
    // Candidate logins are created (and linked to a CRM candidate) only by POST /jobsearch/admin/candidate-accounts.
    if (role === "Candidate") {
      return res.status(400).json({ error: "Candidate accounts are created with POST /jobsearch/admin/candidate-accounts, not /auth/register" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const weak = checkPassword(password, normalizedEmail);
    if (weak) return res.status(400).json({ error: weak });
    const existing = await userModel.findUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: "User already exists" });
    }

    const user = await userModel.createUser({ full_name, email: normalizedEmail, password, role });

    await logAudit({ userId: req.user.id, action: "CREATE", tableName: "users", recordId: user.id, newData: user });

    return res.status(201).json(user);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- first SuperAdmin (Task 20 C1)
// The bootstrap route is unauthenticated by nature (no user exists yet). In production it answers ONLY a
// caller on the loopback interface of the app itself (deploy/hostinger/create-admin.sh runs inside the app
// container and posts to 127.0.0.1) and only when no proxy header is present: a request relayed by Caddy /
// nginx comes from another address and/or carries X-Forwarded-For, so it gets 404 like an unknown route.
// The Caddyfile also answers 404 for this path, and the check-then-create is atomic (userModel).
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host", "x-forwarded-proto", "via"];

function bootstrapAllowed(req, nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv !== "production") return true;
  const addr = req && req.socket ? req.socket.remoteAddress : undefined;
  if (!LOOPBACK.has(String(addr || ""))) return false;
  const headers = (req && req.headers) || {};
  return !PROXY_HEADERS.some((h) => headers[h] !== undefined);
}

router.post("/bootstrap-super-admin", async (req, res) => {
  if (!bootstrapAllowed(req)) return res.status(404).json({ error: "Not found" });
  try {
    if ((await userModel.countUsers()) > 0) return res.status(403).json({ error: "Bootstrap is disabled once users exist" });

    const { full_name, email, password } = req.body || {};
    if (!full_name || !email || !password) {
      return res.status(400).json({ error: "full_name, email, password are required" });
    }

    const normalized = String(email).trim().toLowerCase();
    const weak = checkPassword(password, normalized);
    if (weak) return res.status(400).json({ error: weak });

    const user = await userModel.createFirstSuperAdmin({ full_name, email: normalized, password });
    if (!user) return res.status(403).json({ error: "Bootstrap is disabled once users exist" });
    return res.status(201).json(user);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- login (Task 20 I5)
// One generic message for unknown user / wrong password / inactive account, a dummy bcrypt compare for unknown
// e-mails (similar timing), and in-memory rate limits PER PROCESS (reset on restart, not shared between
// processes - run one app process; see CHECKLIST limitations):
//   - per e-mail: LOGIN_EMAIL_FAILURES (default 5) failed attempts per 15 min -> 429 (even with the right password)
//   - per IP: LOGIN_IP_FAILURES (default 10) failed attempts per 15 min, and LOGIN_IP_ATTEMPTS (default 100)
//     attempts of any outcome -> 429 with Retry-After
const LOGIN_FAILED = "Invalid email or password";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const envInt = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : dflt;
};

function createLoginLimiter({ now = () => Date.now(), windowMs = LOGIN_WINDOW_MS, ipFailures, emailFailures, ipAttempts } = {}) {
  const buckets = new Map();
  const limits = () => ({
    ipFailures: ipFailures || envInt("LOGIN_IP_FAILURES", 10),
    emailFailures: emailFailures || envInt("LOGIN_EMAIL_FAILURES", 5),
    ipAttempts: ipAttempts || envInt("LOGIN_IP_ATTEMPTS", 100),
  });
  const recent = (key) => {
    const t = now();
    const list = (buckets.get(key) || []).filter((ts) => t - ts < windowMs);
    if (list.length) buckets.set(key, list);
    else buckets.delete(key);
    return list;
  };
  const push = (key) => {
    const list = recent(key);
    list.push(now());
    buckets.set(key, list);
    if (buckets.size > 50000) for (const k of [...buckets.keys()].slice(0, 10000)) buckets.delete(k);
  };
  const retry = (list) => Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000));
  return {
    check(ip, email) {
      const l = limits();
      for (const [key, max] of [[`ef:${email}`, l.emailFailures], [`if:${ip}`, l.ipFailures], [`ia:${ip}`, l.ipAttempts]]) {
        const list = recent(key);
        if (list.length >= max) return { ok: false, retryAfter: retry(list) };
      }
      return { ok: true };
    },
    attempt(ip) {
      push(`ia:${ip}`);
    },
    failure(ip, email) {
      push(`ef:${email}`);
      push(`if:${ip}`);
    },
    success(_ip, email) {
      buckets.delete(`ef:${email}`);
    },
    reset() {
      buckets.clear();
    },
  };
}

const loginLimiter = createLoginLimiter();
let dummyHash = null;
async function dummyCompare(password) {
  if (!dummyHash) dummyHash = await bcrypt.hash(`dummy-${Math.random()}`, 12);
  await bcrypt.compare(String(password), dummyHash);
}

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const normalized = String(email).trim().toLowerCase();
    const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || "unknown");
    const gate = loginLimiter.check(ip, normalized);
    if (!gate.ok) {
      res.set("Retry-After", String(gate.retryAfter));
      return res.status(429).json({ error: "Too many sign-in attempts. Try again later." });
    }
    loginLimiter.attempt(ip);

    const user = await userModel.findUserByEmail(normalized);
    const valid = user ? await bcrypt.compare(String(password), user.password) : (await dummyCompare(password), false);
    if (!user || !valid || !user.is_active) {
      loginLimiter.failure(ip, normalized);
      return res.status(400).json({ error: LOGIN_FAILED });
    }
    loginLimiter.success(ip, normalized);

    // `tv` (users.token_version) makes the session revocable: verifyToken re-checks is_active, token_version
    // and role on every request, and suspension bumps token_version. Tokens issued before this change carry
    // no `tv` and keep working until they expire (at most the old 7-day lifetime).
    const token = jwt.sign({ id: user.id, role: user.role, tv: user.token_version }, process.env.JWT_SECRET, {
      expiresIn: tokenLifetime(),
    });

    return res.json({
      token,
      role: user.role,
      name: user.full_name,
      user_id: user.id,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports._internal = { bootstrapAllowed, createLoginLimiter, resetLoginLimits: () => loginLimiter.reset() };
