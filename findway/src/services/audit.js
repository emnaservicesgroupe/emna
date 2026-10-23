'use strict';
const { redact } = require('../lib/logger');

const SYSTEM = Object.freeze({ userId: null, role: 'system', via: 'system', correlationId: null });

// Writes inside the caller's transaction so an action and its audit record commit (or roll back) together.
async function audit(q, actor, { action, entityType = null, entityId = null, details = {} }) {
  const a = actor || SYSTEM;
  await q.query(
    `INSERT INTO audit_events (actor_user_id, actor_role, via, client, action, entity_type, entity_id, details, correlation_id, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [a.userId || null, a.role || null, a.via || 'web', a.client || null, action, entityType,
      entityId ? String(entityId) : null, JSON.stringify(redact(details)), a.correlationId || null, a.ip || null],
  );
}

module.exports = { audit, SYSTEM };
