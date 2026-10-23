'use strict';
// Outbound signed webhooks to subscriber systems.
const dns = require('node:dns').promises;
const net = require('node:net');
const { TransientError, PermanentError } = require('./errors');
const secrets = require('./secrets');

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

// SSRF guard: https only in production, and never to private/loopback ranges unless the host is explicitly allow-listed.
async function assertSafeUrl(ctx, rawUrl) {
  let u; try { u = new URL(rawUrl); } catch (_) { throw new PermanentError('Invalid webhook URL'); }
  if (!['https:', 'http:'].includes(u.protocol)) throw new PermanentError('Webhook URL must use https');
  const allowed = ctx.config.allowedWebhookHosts.includes(u.hostname);
  if (u.protocol === 'http:' && ctx.config.production && !allowed) throw new PermanentError('Webhook URL must use https');
  if (allowed) return u;
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => { throw new TransientError(`Cannot resolve ${u.hostname}`); });
  if (addrs.some((a) => isPrivate(a.address))) throw new PermanentError('Webhook URL resolves to a private address and is not allow-listed');
  return u;
}

function envelope(event) {
  return {
    id: event.id, type: event.type, occurred_at: event.created_at.toISOString(), schema_version: 1,
    aggregate: { type: event.aggregate_type, id: event.aggregate_id, version: event.aggregate_version }, origin: event.origin, data: event.data,
  };
}

async function deliver(ctx, subscriptionId, event, deliveryId) {
  const sub = await ctx.db.one('SELECT * FROM webhook_subscriptions WHERE id=$1', [subscriptionId]);
  if (!sub || !sub.active) return { status: 'skipped', detail: { reason: 'subscription_inactive' } };
  const url = await assertSafeUrl(ctx, sub.url);
  const [sec] = await secrets.active(ctx, `outbound:${sub.id}`);
  if (!sec) throw new PermanentError('Subscription has no active signing secret');
  const body = JSON.stringify(envelope(event));
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', redirect: 'manual', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-findway-event': event.type, 'x-findway-event-id': event.id, 'x-findway-delivery': deliveryId, 'x-findway-signature': secrets.header(sec, body, ctx.clock.now().getTime()) },
      body,
    });
  } catch (e) { throw new TransientError(e.name === 'AbortError' ? 'Webhook timed out' : `Webhook unreachable: ${e.cause?.code || e.message}`); } finally { clearTimeout(timer); }
  if (res.status >= 200 && res.status < 300) return { status: 'succeeded', detail: { http_status: res.status } };
  if (res.status >= 300 && res.status < 400) throw new PermanentError(`Webhook endpoint redirected (HTTP ${res.status}); redirects are not followed`);
  if (res.status === 408 || res.status === 429 || res.status >= 500) throw new TransientError(`Webhook endpoint answered HTTP ${res.status}`);
  throw new PermanentError(`Webhook endpoint rejected the event (HTTP ${res.status})`);
}

module.exports = { deliver, assertSafeUrl, envelope, isPrivate };
