'use strict';
// Durable delivery worker: leases due deliveries, preserves per-aggregate order, retries with backoff, dead-letters exhausted ones.
const { getSetting } = require('../context');
const { audit, SYSTEM } = require('../services/audit');
const { TransientError } = require('./errors');
const trustcrm = require('./trustcrm/adapter');
const webhooks = require('./webhooks');

const LEASE_MS = 5 * 60 * 1000;

async function claim(ctx, limit) {
  const now = ctx.clock.now();
  return ctx.db.rows(
    `UPDATE sync_deliveries d SET next_attempt_at=$2, last_attempt_at=$1
      WHERE d.id IN (
        SELECT d2.id FROM sync_deliveries d2 JOIN outbox_events e ON e.id=d2.event_id
         WHERE d2.status IN ('pending','retry') AND d2.next_attempt_at <= $1
           AND NOT EXISTS (SELECT 1 FROM sync_deliveries p JOIN outbox_events pe ON pe.id=p.event_id
                            WHERE p.target_key=d2.target_key AND pe.aggregate_type=e.aggregate_type AND pe.aggregate_id=e.aggregate_id
                              AND pe.seq < e.seq AND p.status IN ('pending','retry'))
         ORDER BY e.seq LIMIT $3 FOR UPDATE OF d2 SKIP LOCKED)
      RETURNING d.*`, [now, new Date(now.getTime() + LEASE_MS), limit]);
}

async function execute(ctx, d, event) {
  if (d.target_key === 'trustcrm') {
    const conn = await ctx.db.one(`SELECT enabled, status FROM integration_connections WHERE key='trustcrm'`);
    if (!conn?.enabled) return { status: 'blocked', detail: { reason: 'connection_disabled' } };
    return trustcrm.handle(ctx, event);
  }
  if (d.target_key.startsWith('webhook:')) return webhooks.deliver(ctx, d.target_key.slice(8), event, d.id);
  return { status: 'skipped', detail: { reason: 'unknown_target' } };
}

async function processOne(ctx, d, policy) {
  const event = await ctx.db.one('SELECT * FROM outbox_events WHERE id=$1', [d.event_id]);
  const attempts = d.attempts + 1;
  const now = ctx.clock.now();
  try {
    const r = await execute(ctx, d, event);
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE sync_deliveries SET status=$2, attempts=$3, completed_at=$4, last_error=NULL, detail=$5 WHERE id=$1`, [d.id, r.status, attempts, now, JSON.stringify(r.detail || {})]);
      if (r.status === 'succeeded' && d.target_key === 'trustcrm') await q.query(`UPDATE integration_connections SET last_success_at=$1 WHERE key='trustcrm'`, [now]);
    });
    return r.status;
  } catch (err) {
    const transient = err.transient !== false; // unknown (bug) errors retry, then surface in the dead-letter queue
    const exhausted = !transient || attempts >= policy.max_attempts;
    const msg = String(err.message || err).slice(0, 500);
    await ctx.db.tx(async (q) => {
      if (exhausted) {
        await q.query(`UPDATE sync_deliveries SET status='dead', attempts=$2, last_error=$3, completed_at=$4 WHERE id=$1`, [d.id, attempts, msg, now]);
        await q.query(`INSERT INTO dead_letters (delivery_id, target_key, event_type, error, attempts) VALUES ($1,$2,$3,$4,$5)`, [d.id, d.target_key, event.type, msg, attempts]);
        await audit(q, SYSTEM, { action: 'sync.dead_lettered', entityType: 'delivery', entityId: d.id, details: { target: d.target_key, type: event.type, error: msg } });
        if (err.auth) await q.query(`UPDATE integration_connections SET status='auth_failed', last_test_error=$1 WHERE key='trustcrm'`, [msg]);
      } else {
        const base = Math.min(policy.max_seconds, policy.base_seconds * 2 ** (attempts - 1));
        const delay = Math.round(base * (0.8 + Math.random() * 0.4));
        await q.query(`UPDATE sync_deliveries SET status='retry', attempts=$2, last_error=$3, next_attempt_at=$4 WHERE id=$1`, [d.id, attempts, msg, new Date(now.getTime() + delay * 1000)]);
      }
    });
    ctx.log.warn('delivery failed', { target: d.target_key, type: event.type, attempts, exhausted, error: msg });
    return exhausted ? 'dead' : 'retry';
  }
}

async function runOnce(ctx, { limit = 25 } = {}) {
  const policy = await getSetting(ctx, 'policy.sync_retry');
  const claimed = await claim(ctx, limit);
  const out = { processed: claimed.length, succeeded: 0, skipped: 0, blocked: 0, retry: 0, dead: 0 };
  for (const d of claimed) out[await processOne(ctx, d, policy)]++;
  return out;
}

async function runUntilIdle(ctx, { maxRounds = 20 } = {}) {
  const total = { processed: 0, succeeded: 0, skipped: 0, blocked: 0, retry: 0, dead: 0 };
  for (let i = 0; i < maxRounds; i++) {
    const r = await runOnce(ctx);
    for (const k of Object.keys(total)) total[k] += r[k];
    if (!r.processed) break;
  }
  return total;
}

module.exports = { runOnce, runUntilIdle, TransientError };
