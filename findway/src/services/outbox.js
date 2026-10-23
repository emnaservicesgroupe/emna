'use strict';
// Transactional outbox: the event row and its per-target delivery rows commit with the business change.
const EVENT_TYPES = [
  'candidate.created', 'candidate.updated', 'lead.created', 'lead.qualified', 'application.submitted',
  'application.status_changed', 'job.published', 'job.closed', 'document.uploaded', 'document.reviewed',
  'interview.scheduled', 'placement.updated', 'consent.revoked',
];

async function emit(q, actor, { type, aggregateType, aggregateId, aggregateVersion = 0, data = {}, origin = 'findway' }) {
  const ev = await q.one(
    `INSERT INTO outbox_events (type, aggregate_type, aggregate_id, aggregate_version, origin, correlation_id, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [type, aggregateType, aggregateId, aggregateVersion, origin, actor?.correlationId || null, JSON.stringify(data)],
  );
  const targets = [];
  const conns = await q.rows(`SELECT key FROM integration_connections WHERE enabled = true AND status <> 'disabled'`);
  for (const c of conns) targets.push(c.key);
  const subs = await q.rows(`SELECT id FROM webhook_subscriptions WHERE active = true AND $1 = ANY(events)`, [type]);
  for (const s of subs) targets.push(`webhook:${s.id}`);
  for (const t of targets) {
    const loop = t === origin; // never echo an event back to the system it came from
    await q.query(
      `INSERT INTO sync_deliveries (event_id, target_key, status, detail, completed_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $3 = 'skipped' THEN now() END)`,
      [ev.id, t, loop ? 'skipped' : 'pending', loop ? JSON.stringify({ reason: 'origin_is_target' }) : null],
    );
  }
  return ev;
}

module.exports = { emit, EVENT_TYPES };
