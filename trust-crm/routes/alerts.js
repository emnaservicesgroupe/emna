const express = require("express");
const router = express.Router();
const db = require("../db");

router.get("/expiring", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM candidates
      WHERE passport_expiry < NOW() + INTERVAL '20 days'
         OR b3_expiry < NOW() + INTERVAL '20 days'
         OR embassy_date < NOW() + INTERVAL '20 days'
    `);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
