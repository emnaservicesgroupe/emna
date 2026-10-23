const db = require("../db");

async function logAudit({ userId, action, tableName, recordId = null, oldData = null, newData = null }) {
  await db.query(
    `INSERT INTO audit_logs (user_id, action, table_name, record_id, old_data, new_data)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [userId, action, tableName, recordId, oldData ? JSON.stringify(oldData) : null, newData ? JSON.stringify(newData) : null]
  );
}

/**
 * Job-search audit: writes exactly ONE audit_logs row (action `jobsearch.<action>`, table `entity`)
 * and exactly ONE js_audit_events row (action `<action>`, actor `user:<id>` or the given system actor).
 * Runs on `client` (caller's transaction) when given, so both rows commit or roll back together.
 * @param {{userId?: number|null, actor?: string, action: string, entity: string, entityId?: any,
 *          detail?: object, candidateId?: number|null, applicationId?: number|null, client?: object}} a
 */
async function auditJs({ userId = null, actor, action, entity, entityId = null, detail = null, candidateId = null, applicationId = null, client } = {}) {
  if (typeof action !== "string" || !/^[a-z][a-z0-9_.]{0,80}$/.test(action)) throw new Error("auditJs: invalid action");
  if (typeof entity !== "string" || !entity) throw new Error("auditJs: entity is required");
  const uid = Number.isSafeInteger(userId) && userId > 0 ? userId : null;
  const who = uid ? `user:${uid}` : typeof actor === "string" && actor ? actor : "system";
  const c = client || db;
  const json = detail ? JSON.stringify(detail) : null;
  await c.query(
    `INSERT INTO audit_logs (user_id, action, table_name, record_id, old_data, new_data) VALUES ($1, $2, $3, $4, NULL, $5::jsonb)`,
    [uid, `jobsearch.${action}`, entity, entityId === null || entityId === undefined ? null : String(entityId), json]
  );
  await c.query(
    "INSERT INTO js_audit_events (actor, action, candidate_id, application_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [who, action, candidateId || null, applicationId || null, json || "{}"]
  );
}

module.exports = { logAudit, auditJs };
