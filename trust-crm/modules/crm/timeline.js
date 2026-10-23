// Insert-only CRM timeline (notes and stage/status history). The DB trigger forbids UPDATE/DELETE.
const ENTITIES = ["lead", "candidate", "employer", "site_job", "employer_request", "agency", "presentation", "share_consent"];

/** Inserts one timeline row on `client` (the caller's transaction). */
async function add(client, { entity, entityId, actorId = null, event, detail = null }) {
  if (!ENTITIES.includes(entity)) throw new Error("timeline.add: invalid entity");
  if (typeof event !== "string" || !event) throw new Error("timeline.add: event is required");
  const r = await client.query(
    `INSERT INTO crm_timeline (entity, entity_id, actor_id, event, detail) VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id, entity, entity_id, actor_id, event, detail, created_at`,
    [entity, entityId, actorId, event, detail === null || detail === undefined ? null : JSON.stringify(detail)]
  );
  return r.rows[0];
}

/** Oldest first; `db` defaults to the shared pool. */
async function list(entity, entityId, db = require("../../db")) {
  if (!ENTITIES.includes(entity)) throw new Error("timeline.list: invalid entity");
  const r = await db.query(
    `SELECT t.id, t.entity, t.entity_id, t.actor_id, u.full_name AS actor_name, t.event, t.detail, t.created_at
       FROM crm_timeline t LEFT JOIN users u ON u.id = t.actor_id
      WHERE t.entity = $1 AND t.entity_id = $2
      ORDER BY t.created_at, t.id LIMIT 1000`,
    [entity, entityId]
  );
  return r.rows;
}

module.exports = { add, list, ENTITIES };
