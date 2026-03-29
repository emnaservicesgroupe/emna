const express = require("express");
const db = require("../db");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");
const { logAudit } = require("../utils/audit");

const router = express.Router();

router.get("/latest", verifyToken, checkPermission("notifications:read"), async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT n.*, c.full_name
       FROM notifications n
       LEFT JOIN candidates c ON c.id = n.candidate_id
       ORDER BY n.is_read ASC, n.created_at DESC
       LIMIT 50`
    );

    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/read/:id", verifyToken, checkPermission("notifications:read"), async (req, res) => {
  try {
    const oldRow = await db.query("SELECT * FROM notifications WHERE id=$1", [req.params.id]);
    if (!oldRow.rows.length) return res.status(404).json({ error: "Notification not found" });

    const result = await db.query("UPDATE notifications SET is_read=true WHERE id=$1 RETURNING *", [req.params.id]);

    await logAudit({
      userId: req.user.id,
      action: "MARK_READ",
      tableName: "notifications",
      recordId: req.params.id,
      oldData: oldRow.rows[0],
      newData: result.rows[0],
    });

    return res.json({ ok: true, notification: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
