const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const userModel = require("../models/userModel");

const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const { full_name, email, password, role } = req.body;

    if (!full_name || !email || !password || !role) {
      return res.status(400).json({ error: "full_name, email, password and role are required" });
    }

    const existing = await userModel.findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "User already exists" });
    }

    const user = await userModel.createUser(req.body);
    return res.json(user);
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

    const user = await userModel.findUserByEmail(email);
    if (!user) {
      return res.status(400).json({ error: "User not found" });
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
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
