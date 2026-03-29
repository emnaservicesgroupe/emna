const express = require("express");
const db = require("../db");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");

const router = express.Router();

router.get("/", verifyToken, checkPermission("audit:read"), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const result = await db.query(
      `SELECT a.*, u.full_name AS user_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
