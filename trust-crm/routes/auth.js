const process = require("node:process");
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const userModel = require("../models/userModel");
const { verifyToken } = require("../middleware/auth");
const { checkPermission, PERMISSIONS } = require("../middleware/role");
const { logAudit } = require("../utils/audit");

const router = express.Router();

router.post("/register", verifyToken, checkPermission("users:write"), async (req, res) => {
  try {
    const { full_name, email, password, role } = req.body;

    if (!full_name || !email || !password || !role) {
      return res.status(400).json({ error: "full_name, email, password and role are required" });
    }

    if (!PERMISSIONS[role]) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
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

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: "7d",
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
