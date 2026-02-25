const cron = require("node-cron");
const db = require("../db");

const DAYS = 20;

async function upsertNotification(candidateId, type, message, dueDate) {
  await db.query(
    `INSERT INTO notifications (candidate_id, type, message, due_date)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (candidate_id, type, due_date)
     DO NOTHING`,
    [candidateId, type, message, dueDate]
  );
}

async function generateAlerts() {
  const passport = await db.query(
    `SELECT id, full_name, passport_expiry
     FROM candidates
     WHERE passport_expiry IS NOT NULL
       AND passport_expiry <= (CURRENT_DATE + $1::int)`,
    [DAYS]
  );

  for (const c of passport.rows) {
    await upsertNotification(
      c.id,
      "PASSPORT_EXPIRY",
      `⚠ Passport expiring soon for ${c.full_name} (${String(c.passport_expiry).slice(0, 10)})`,
      c.passport_expiry
    );
  }

  const b3 = await db.query(
    `SELECT id, full_name, b3_expiry
     FROM candidates
     WHERE b3_expiry IS NOT NULL
       AND b3_expiry <= (CURRENT_DATE + $1::int)`,
    [DAYS]
  );

  for (const c of b3.rows) {
    await upsertNotification(
      c.id,
      "B3_EXPIRY",
      `⚠ B3 expiring soon for ${c.full_name} (${String(c.b3_expiry).slice(0, 10)})`,
      c.b3_expiry
    );
  }

  const embassy = await db.query(
    `SELECT id, full_name, embassy_date
     FROM candidates
     WHERE embassy_date IS NOT NULL
       AND embassy_date <= (CURRENT_DATE + $1::int)`,
    [DAYS]
  );

  for (const c of embassy.rows) {
    await upsertNotification(
      c.id,
      "EMBASSY_SOON",
      `📌 Embassy appointment soon for ${c.full_name} (${String(c.embassy_date).slice(0, 10)})`,
      c.embassy_date
    );
  }

  console.log("✅ Alerts generated:", {
    passport: passport.rows.length,
    b3: b3.rows.length,
    embassy: embassy.rows.length,
  });
}

function startAlertScheduler() {
  cron.schedule("0 8 * * *", async () => {
    try {
      await generateAlerts();
    } catch (err) {
      console.error("❌ Alert scheduler error:", err.message);
    }
  });
}

module.exports = { startAlertScheduler, generateAlerts };
