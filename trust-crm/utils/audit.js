const db = require("../db");

async function logAudit({ userId, action, tableName, recordId = null, oldData = null, newData = null }) {
  await db.query(
    `INSERT INTO audit_logs (user_id, action, table_name, record_id, old_data, new_data)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [userId, action, tableName, recordId, oldData ? JSON.stringify(oldData) : null, newData ? JSON.stringify(newData) : null]
  );
}

module.exports = { logAudit };
