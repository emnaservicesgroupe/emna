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

router.post("/bootstrap-super-admin", async (req, res) => {
  try {
    const usersCount = await userModel.countUsers();
    if (usersCount > 0) return res.status(403).json({ error: "Bootstrap is disabled once users exist" });

    const { full_name, email, password } = req.body;
    if (!full_name || !email || !password) {
      return res.status(400).json({ error: "full_name, email, password are required" });
    }

    const weak = checkPassword(password, String(email).trim().toLowerCase());
    if (weak) return res.status(400).json({ error: weak });

    const user = await userModel.createUser({ full_name, email: String(email).trim().toLowerCase(), password, role: "SuperAdmin" });
    return res.status(201).json(user);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const user = await userModel.findUserByEmail(String(email).trim().toLowerCase());
    if (!user || !user.is_active) {
      return res.status(400).json({ error: "User not found or inactive" });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(400).json({ error: "Wrong password" });
    }

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
