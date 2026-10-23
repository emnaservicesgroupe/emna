'use strict';
// Webhook signing secrets: stored encrypted, rotated with an overlap window, shown once on creation.
const C = require('../lib/crypto');

const kidNow = () => `k${Date.now().toString(36)}${C.randomToken(2).replace(/[^a-z0-9]/gi, '')}`;
const signedPayload = (t, body) => `${t}.${body}`;
const sign = (secret, t, body) => C.hmac(secret, signedPayload(t, body));

async function create(ctx, q, scope) {
  const kid = kidNow();
  const secret = C.randomToken(32);
  await q.query('INSERT INTO webhook_secrets (scope, kid, secret_enc) VALUES ($1,$2,$3)', [scope, kid, C.encrypt(secret, ctx.keys.webhook)]);
  return { kid, secret };
}

async function active(ctx, scope, q = ctx.db) {
  const now = ctx.clock.now();
  const rows = await q.rows(
    `SELECT kid, secret_enc, created_at FROM webhook_secrets WHERE scope=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at DESC`, [scope, now]);
  return rows.map((r) => ({ kid: r.kid, secret: C.decrypt(r.secret_enc, ctx.keys.webhook), created_at: r.created_at }));
}

// New secret becomes primary immediately; previous ones keep verifying until `overlapHours` pass.
async function rotate(ctx, q, scope, overlapHours = 24) {
  const now = ctx.clock.now();
  await q.query(`UPDATE webhook_secrets SET expires_at=$2 WHERE scope=$1 AND revoked_at IS NULL AND expires_at IS NULL`, [scope, new Date(now.getTime() + overlapHours * 3600000)]);
  return create(ctx, q, scope);
}

function header(secretObj, body, nowMs) {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},kid=${secretObj.kid},v1=${sign(secretObj.secret, t, body)}`;
}

function parseHeader(h) {
  const out = {};
  for (const part of String(h || '').split(',')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}

module.exports = { create, active, rotate, header, parseHeader, sign };
