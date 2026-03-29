const express = require("express");
const router = express.Router();
const db = require("../db");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");

router.get("/expiring", verifyToken, checkPermission("notifications:read"), async (_req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM candidates
      WHERE is_deleted=false AND (
        passport_expiry < NOW() + INTERVAL '20 days'
        OR b3_expiry < NOW() + INTERVAL '20 days'
        OR embassy_date < NOW() + INTERVAL '20 days'
      )
      ORDER BY passport_expiry ASC NULLS LAST, b3_expiry ASC NULLS LAST, embassy_date ASC NULLS LAST
    `);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
