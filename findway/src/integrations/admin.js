'use strict';
// Integration Center back-end: status, tests, deliveries, dead letters, conflicts, secrets, subscriptions.
const { E } = require('../lib/errors');
const P = require('../permissions');
const { audit } = require('../services/audit');
const { emit } = require('../services/outbox');
const cases = require('../services/cases');
const { SYSTEM } = require('../services/audit');
const client = require('./trustcrm/client');
const adapter = require('./trustcrm/adapter');
const secrets = require('./secrets');
const webhooks = require('./webhooks');
const inbound = require('./inbound');
const dispatcher = require('./dispatcher');

async function overview(ctx, actor) {
  P.require(actor, 'integrations:view');
  const conns = await ctx.db.rows('SELECT * FROM integration_connections ORDER BY key');
  const counts = await ctx.db.rows(`SELECT target_key, status, count(*)::int AS n FROM sync_deliveries GROUP BY 1,2`);
  const byTarget = (key) => Object.fromEntries(counts.filter((c) => c.target_key === key).map((c) => [c.status, c.n]));
  const failures1h = await ctx.db.rows(`SELECT target_key, count(*)::int AS n FROM sync_deliveries WHERE last_error IS NOT NULL AND last_attempt_at > $1 AND status IN ('retry','dead') GROUP BY 1`, [new Date(ctx.clock.now().getTime() - 3600000)]);
  const conflicts = (await ctx.db.one(`SELECT count(*)::int AS n FROM sync_conflicts WHERE status='open'`)).n;
  const dead = (await ctx.db.one(`SELECT count(*)::int AS n FROM dead_letters WHERE replayed_at IS NULL`)).n;
  const subs = await ctx.db.rows('SELECT id, url, events, active, description, created_at FROM webhook_subscriptions ORDER BY created_at DESC');
  const inboundSecret = (await secrets.active(ctx, 'inbound:trustcrm')).map((s) => ({ kid: s.kid, created_at: s.created_at }));
  return {
    connections: conns.map((c) => ({
      key: c.key, name: c.display_name, enabled: c.enabled, status: c.enabled || c.status === 'not_configured' ? c.status : 'disabled', base_url: c.base_url,
      credentials_configured: c.key === 'trustcrm' ? !!(ctx.config.trustcrm.serviceEmail && ctx.config.trustcrm.servicePassword) : null,
      last_tested_at: c.last_tested_at, last_test_error: c.last_test_error, last_success_at: c.last_success_at,
      deliveries: byTarget(c.key), recent_failures: failures1h.find((f) => f.target_key === c.key)?.n || 0,
      inbound_secrets: c.key === 'trustcrm' ? inboundSecret : undefined,
    })),
    open_conflicts: conflicts, dead_letters: dead, webhook_subscriptions: subs,
  };
}

async function configure(ctx, actor, { base_url, enabled }) {
  P.require(actor, 'integrations:manage');
  if (base_url) { try { const u = new URL(base_url); if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol'); } catch (_) { throw E.badRequest('invalid_url', 'base_url must be an http(s) URL'); } }
  const creds = !!(ctx.config.trustcrm.serviceEmail && ctx.config.trustcrm.servicePassword);
  return ctx.db.tx(async (q) => {
    const cur = await q.one(`SELECT * FROM integration_connections WHERE key='trustcrm' FOR UPDATE`);
    const url = base_url !== undefined ? base_url.replace(/\/+$/, '') : cur.base_url;
    const en = enabled === undefined ? cur.enabled : enabled;
    // A changed target, or re-enabling after a pause, invalidates the previous test: it must be proven again.
    let status = cur.status;
    if (!url || !creds) status = 'not_configured';
    else if (url !== cur.base_url || (en && !cur.enabled) || cur.status === 'not_configured') status = 'configured_untested';
    const row = await q.one(`UPDATE integration_connections SET base_url=$1, enabled=$2, status=$3, updated_at=now() WHERE key='trustcrm' RETURNING *`, [url, en, status]);
    await audit(q, actor, { action: 'integration.configured', entityType: 'integration', entityId: 'trustcrm', details: { enabled: en, base_url: url } });
    return row;
  });
}

async function test(ctx, actor) {
  P.require(actor, 'integrations:manage');
  const now = ctx.clock.now();
  let status = 'connected'; let error = null; let latency = null;
  try { latency = (await client.ping(ctx)).latency_ms; } catch (e) {
    error = e.message;
    status = e.detail?.code === 'not_configured' ? 'not_configured' : e.auth ? 'auth_failed' : e.transient ? 'unreachable' : 'unreachable';
  }
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE integration_connections SET status=$1, last_tested_at=$2, last_test_error=$3, last_success_at=CASE WHEN $1='connected' THEN $2 ELSE last_success_at END, updated_at=now() WHERE key='trustcrm'`, [status, now, error]);
    await audit(q, actor, { action: 'integration.tested', entityType: 'integration', entityId: 'trustcrm', details: { status, error } });
  });
  return { status, error, latency_ms: latency };
}

async function listDeliveries(ctx, actor, { status, target, limit = 50, offset = 0 } = {}) {
  P.require(actor, 'integrations:view');
  return ctx.db.rows(
    `SELECT d.id, d.target_key, d.status, d.attempts, d.next_attempt_at, d.last_attempt_at, d.last_error, d.detail, d.created_at, e.type, e.aggregate_type, e.aggregate_id, e.origin
       FROM sync_deliveries d JOIN outbox_events e ON e.id=d.event_id
      WHERE ($1::text IS NULL OR d.status=$1) AND ($2::text IS NULL OR d.target_key=$2) ORDER BY e.seq DESC LIMIT $3 OFFSET $4`,
    [status || null, target || null, Math.min(limit, 200), offset]);
}

async function retryDelivery(ctx, actor, id) {
  P.require(actor, 'integrations:manage');
  const r = await ctx.db.tx(async (q) => {
    const d = await q.one(`UPDATE sync_deliveries SET status='pending', attempts=0, next_attempt_at=$2, completed_at=NULL, last_error=NULL WHERE id=$1 AND status IN ('retry','blocked','dead') RETURNING id`, [id, ctx.clock.now()]);
    if (!d) throw E.conflict('not_retryable', 'Only retrying, blocked or dead deliveries can be retried');
    await audit(q, actor, { action: 'sync.retry_requested', entityType: 'delivery', entityId: id });
    return d;
  });
  return r;
}

async function listDeadLetters(ctx, actor) {
  P.require(actor, 'integrations:view');
  return ctx.db.rows(`SELECT * FROM dead_letters ORDER BY created_at DESC LIMIT 200`);
}
async function replayDeadLetter(ctx, actor, id) {
  P.require(actor, 'integrations:manage');
  return ctx.db.tx(async (q) => {
    const dl = await q.one('SELECT * FROM dead_letters WHERE id=$1 FOR UPDATE', [id]);
    if (!dl) throw E.notFound('dead letter');
    if (dl.replayed_at) throw E.conflict('already_replayed', 'This dead letter was already replayed');
    await q.query(`UPDATE sync_deliveries SET status='pending', attempts=0, next_attempt_at=$2, completed_at=NULL, last_error=NULL WHERE id=$1`, [dl.delivery_id, ctx.clock.now()]);
    await q.query('UPDATE dead_letters SET replayed_at=$2, replayed_by=$3 WHERE id=$1', [id, ctx.clock.now(), actor.userId]);
    await audit(q, actor, { action: 'sync.dead_letter_replayed', entityType: 'delivery', entityId: dl.delivery_id });
    return { delivery_id: dl.delivery_id };
  });
}

async function listConflicts(ctx, actor, { status = 'open' } = {}) {
  P.require(actor, 'integrations:view');
  return ctx.db.rows(`SELECT c.*, rc.reference_no AS case_reference FROM sync_conflicts c LEFT JOIN recruitment_cases rc ON rc.id=c.canonical_id WHERE c.status=$1 ORDER BY c.created_at DESC LIMIT 200`, [status]);
}
async function resolveConflict(ctx, actor, id, { resolution }) {
  P.require(actor, 'integrations:manage');
  if (!['local', 'remote'].includes(resolution)) throw E.badRequest('invalid_resolution', 'resolution must be local or remote');
  const c = await ctx.db.one('SELECT * FROM sync_conflicts WHERE id=$1', [id]);
  if (!c) throw E.notFound('conflict');
  if (c.status !== 'open') throw E.conflict('already_resolved', 'This conflict is already resolved');
  return ctx.db.tx(async (q) => {
    const kase = await q.one('SELECT * FROM recruitment_cases WHERE id=$1 FOR UPDATE', [c.canonical_id]);
    const cm = await adapter.caseMappingFor(q, c.canonical_id);
    if (resolution === 'remote') {
      const row = await cases.advanceInternal(q, actor, kase, c.remote_value, { reason: 'Conflict resolved in favour of trust-crm', origin: 'trustcrm' });
      if (cm) await q.query(`UPDATE external_mappings SET canonical_version=$2, last_event_at=$3, content_hash=$4, sync_origin='trustcrm' WHERE id=$1`, [cm.id, row.version, c.remote_event_at, adapter.hashOf({ stage: c.remote_value })]);
    } else {
      // keep ours: mark the remote event as seen, then push our value
      if (cm) await q.query(`UPDATE external_mappings SET last_event_at=$2, content_hash=NULL, canonical_version=$3 WHERE id=$1`, [cm.id, c.remote_event_at, kase.version]);
      await emit(q, actor, { type: 'placement.updated', aggregateType: 'case', aggregateId: kase.id, aggregateVersion: kase.version, data: { to: kase.stage, candidate_id: kase.candidate_id, reason: 'conflict_resolved_local' } });
    }
    await q.query(`UPDATE sync_conflicts SET status=$2, resolved_by=$3, resolved_at=$4 WHERE id=$1`, [id, resolution === 'local' ? 'resolved_local' : 'resolved_remote', actor.userId, ctx.clock.now()]);
    await audit(q, actor, { action: 'sync.conflict_resolved', entityType: 'case', entityId: c.canonical_id, details: { resolution } });
    return { id, resolution };
  });
}

async function rotateInboundSecret(ctx, actor, { overlapHours = 24 } = {}) {
  P.require(actor, 'integrations:manage');
  return ctx.db.tx(async (q) => {
    const existing = await secrets.active(ctx, 'inbound:trustcrm', q);
    const s = existing.length ? await secrets.rotate(ctx, q, 'inbound:trustcrm', overlapHours) : await secrets.create(ctx, q, 'inbound:trustcrm');
    await audit(q, actor, { action: 'integration.secret_rotated', entityType: 'integration', entityId: 'trustcrm', details: { kid: s.kid, overlapHours } });
    return { kid: s.kid, secret: s.secret, note: 'Store this secret now; it is not shown again.' };
  });
}

async function createSubscription(ctx, actor, { url, events, description }) {
  P.require(actor, 'integrations:manage');
  await webhooks.assertSafeUrl(ctx, url).catch((e) => { throw E.badRequest('unsafe_url', e.message); });
  return ctx.db.tx(async (q) => {
    const sub = await q.one('INSERT INTO webhook_subscriptions (url, events, description, created_by) VALUES ($1,$2,$3,$4) RETURNING id, url, events, active', [url, events, description || null, actor.userId]);
    const s = await secrets.create(ctx, q, `outbound:${sub.id}`);
    await audit(q, actor, { action: 'webhook.subscription_created', entityType: 'webhook_subscription', entityId: sub.id, details: { url, events } });
    return { ...sub, kid: s.kid, secret: s.secret, note: 'Store this secret now; it is not shown again.' };
  });
}
async function setSubscriptionActive(ctx, actor, id, active) {
  P.require(actor, 'integrations:manage');
  const r = await ctx.db.query('UPDATE webhook_subscriptions SET active=$2 WHERE id=$1', [id, active]);
  if (!r.rowCount) throw E.notFound('subscription');
  await audit(ctx.db, actor, { action: active ? 'webhook.subscription_enabled' : 'webhook.subscription_disabled', entityType: 'webhook_subscription', entityId: id });
}
async function rotateSubscriptionSecret(ctx, actor, id) {
  P.require(actor, 'integrations:manage');
  return ctx.db.tx(async (q) => {
    if (!(await q.one('SELECT 1 FROM webhook_subscriptions WHERE id=$1', [id]))) throw E.notFound('subscription');
    const s = await secrets.rotate(ctx, q, `outbound:${id}`);
    await audit(q, actor, { action: 'webhook.secret_rotated', entityType: 'webhook_subscription', entityId: id });
    return { kid: s.kid, secret: s.secret };
  });
}

async function runReconcile(ctx, actor) {
  P.require(actor, 'integrations:manage');
  const r = await inbound.reconcile(ctx);
  await audit(ctx.db, actor, { action: 'sync.reconciled', entityType: 'integration', entityId: 'trustcrm', details: r });
  return r;
}
async function runWorkerNow(ctx, actor) {
  P.require(actor, 'integrations:manage');
  return dispatcher.runUntilIdle(ctx);
}

module.exports = {
  overview, configure, test, listDeliveries, retryDelivery, listDeadLetters, replayDeadLetter, listConflicts, resolveConflict,
  rotateInboundSecret, createSubscription, setSubscriptionActive, rotateSubscriptionSecret, runReconcile, runWorkerNow,
};
