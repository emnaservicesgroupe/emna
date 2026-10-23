'use strict';
// HTTP client for the existing trust-crm API (see docs/INTEGRATION.md for the contract we rely on).
// Upstream credentials are separate from anything a FIND WAY user or MCP client holds.
const { TransientError, PermanentError, AuthError } = require('../errors');

const tokenCache = new Map(); // `${baseUrl}|${email}` -> { token, exp }

async function resolveBaseUrl(ctx) {
  const row = await ctx.db.one(`SELECT base_url FROM integration_connections WHERE key='trustcrm'`);
  return (row?.base_url || ctx.config.trustcrm.baseUrl || '').replace(/\/+$/, '');
}

async function rawFetch(ctx, url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ctx.config.trustcrm.timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (e) {
    throw new TransientError(e.name === 'AbortError' ? 'trust-crm request timed out' : `trust-crm unreachable: ${e.cause?.code || e.message}`);
  } finally { clearTimeout(timer); }
}

async function login(ctx, baseUrl) {
  const { serviceEmail, servicePassword } = ctx.config.trustcrm;
  if (!baseUrl || !serviceEmail || !servicePassword) throw new PermanentError('trust-crm connection is not configured (base URL / service credentials missing)', { code: 'not_configured' });
  const res = await rawFetch(ctx, `${baseUrl}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: serviceEmail, password: servicePassword }),
  });
  if (res.status >= 500) throw new TransientError(`trust-crm login failed with HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new AuthError(`trust-crm rejected the service credentials (HTTP ${res.status})`);
  tokenCache.set(`${baseUrl}|${serviceEmail}`, { token: body.token, exp: ctx.clock.now().getTime() + 6 * 3600 * 1000 });
  return body.token;
}

async function token(ctx, baseUrl, force = false) {
  const hit = tokenCache.get(`${baseUrl}|${ctx.config.trustcrm.serviceEmail}`);
  if (!force && hit && hit.exp > ctx.clock.now().getTime()) return hit.token;
  return login(ctx, baseUrl);
}

async function request(ctx, method, path, body) {
  const baseUrl = await resolveBaseUrl(ctx);
  let t = await token(ctx, baseUrl);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await rawFetch(ctx, `${baseUrl}${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined,
    });
    // trust-crm answers 400 "Invalid token" (not 401) for expired tokens: re-login once on either.
    if ((res.status === 401 || res.status === 400) && attempt === 0) {
      const peek = await res.clone().json().catch(() => ({}));
      if (res.status === 401 || /token|denied/i.test(peek.error || '')) { t = await token(ctx, baseUrl, true); continue; }
    }
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body */ }
    if (res.status >= 500 || res.status === 429) throw new TransientError(`trust-crm HTTP ${res.status}`, { status: res.status });
    if (!res.ok) throw new PermanentError(`trust-crm HTTP ${res.status}: ${(json && json.error) || text.slice(0, 120)}`, { status: res.status });
    return json;
  }
  throw new AuthError('trust-crm authentication failed after re-login');
}

// A real authenticated round-trip: the connection is only "connected" if this passes.
async function ping(ctx) {
  const started = Date.now();
  const baseUrl = await resolveBaseUrl(ctx);
  await token(ctx, baseUrl, true);
  const rows = await request(ctx, 'GET', '/candidates/all?search=__findway_ping__');
  if (!Array.isArray(rows)) throw new PermanentError('trust-crm returned an unexpected response to the test request');
  return { latency_ms: Date.now() - started };
}

module.exports = { request, ping, resolveBaseUrl, tokenCache };
