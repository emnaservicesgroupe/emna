const express = require("express");
const db = require("../db");
const { verifyToken } = require("../middleware/auth");
const { checkRole } = require("../middleware/role");

const router = express.Router();

router.get(
  "/latest",
  verifyToken,
  checkRole("Admin", "Manager", "Receptionist", "Accountant", "HR"),
  async (req, res) => {
    try {
      const result = await db.query(
        `SELECT n.*, c.full_name
         FROM notifications n
         JOIN candidates c ON c.id = n.candidate_id
         ORDER BY n.is_read ASC, n.created_at DESC
         LIMIT 50`
      );

      return res.json(result.rows);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
);

router.post(
  "/read/:id",
  verifyToken,
  checkRole("Admin", "Manager", "Receptionist", "Accountant", "HR"),
  async (req, res) => {
    try {
      await db.query("UPDATE notifications SET is_read=true WHERE id=$1", [req.params.id]);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
