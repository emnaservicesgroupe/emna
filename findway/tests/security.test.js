'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, PW } = require('./helpers');

let env; let limited;
before(async () => { env = await createTestEnv(); limited = await createTestEnv({ rateLimits: true }); });
after(async () => { await env.close(); await limited.close(); });

test('security headers and a strict CSP are sent on every response', async () => {
  const r = await env.api('GET', '/api/health');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/); assert.match(csp, /script-src 'self'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.ok(r.headers.get('x-correlation-id'));
});

test('auth endpoints are rate limited per client (abuse protection)', async () => {
  let last;
  for (let i = 0; i < 35; i++) last = await limited.api('POST', '/api/auth/login', { body: { email: 'a@example.test', password: 'x' } });
  assert.equal(last.status, 429); assert.equal(last.body.error.code, 'rate_limited');
});

test('malformed input is rejected cleanly and never leaks internals', async () => {
  assert.equal((await env.api('POST', '/api/auth/login', { raw: '{not json' })).body.error.code, 'invalid_json');
  const big = await env.api('POST', '/api/auth/login', { raw: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(2 * 1024 * 1024) }) });
  assert.equal(big.status, 413);
  const bad = await env.api('POST', '/api/auth/register', { body: { email: 'not-an-email', password: PW, full_name: '', role: 'super_admin', accept_terms: true } });
  assert.equal(bad.status, 422); assert.equal(bad.body.error.code, 'validation_failed');
  // a user can never self-register into a privileged role
  assert.ok(bad.body.error.details.some((d) => d.path === 'role'));
  const u = await env.api('POST', '/api/auth/register', { body: { email: 'priv@example.test', password: PW, full_name: 'Eve', role: 'admin', accept_terms: true } });
  assert.equal(u.status, 422);
  assert.equal((await env.api('GET', '/api/does-not-exist')).status, 404);
  const err = await env.api('GET', '/api/candidate/profile', { token: 'garbage' });
  assert.equal(err.status, 401);
  assert.ok(!JSON.stringify(err.body).match(/select|postgres|stack|at .*\.js/i));
});

test('unknown fields are rejected on profile and job writes (no mass assignment)', async () => {
  const c = await env.readyCandidate();
  const r = await env.api('PATCH', '/api/candidate/profile', { token: c.token, body: { full_name: 'X', owner_user_id: c.userId, user_id: c.userId, merged_into: c.candidateId } });
  assert.equal(r.status, 422);
  const me = await env.api('PATCH', '/api/me', { token: c.token, body: { role: 'super_admin' } });
  assert.equal(me.status, 422);
  assert.equal((await env.db.one('SELECT role FROM users WHERE id=$1', [c.userId])).role, 'candidate');
});

test('responses never expose password hashes, MFA secrets, token hashes or encrypted identity values', async () => {
  const sa = await env.superAdmin();
  const c = await env.readyCandidate();
  const staff = await env.internal('staff');
  const blobs = [];
  for (const [p, t] of [['/api/me', c.token], ['/api/candidate/profile', c.token], ['/api/admin/users', sa.token], ['/api/auth/sessions', c.token], ['/api/admin/integrations', sa.token], ['/api/staff/team', staff.token]]) blobs.push(JSON.stringify((await env.api('GET', p, { token: t })).body));
  const all = blobs.join('\n');
  for (const needle of ['password_hash', 'scrypt$', 'mfa_secret', 'token_hash', 'value_enc', 'mfa_recovery']) assert.ok(!all.includes(needle), `leaked ${needle}`);
});

test('the dev mail capture endpoint does not exist in production configuration', async () => {
  const prod = await createTestEnv({ config: { devMailCapture: false, production: true } });
  try { assert.equal((await prod.api('GET', '/api/dev/mail')).status, 404); } finally { await prod.close(); }
  assert.equal((await env.api('GET', '/api/dev/mail')).status, 200);
});

test('production refuses to start without a real master key', () => {
  const { load } = require('../src/config');
  assert.throws(() => load({ NODE_ENV: 'production' }), /APP_MASTER_KEY/);
  assert.throws(() => load({ NODE_ENV: 'production', APP_MASTER_KEY: Buffer.from('short').toString('base64') }), /APP_MASTER_KEY/);
  assert.doesNotThrow(() => load({ NODE_ENV: 'production', APP_MASTER_KEY: Buffer.alloc(48, 7).toString('base64') }));
});

test('identity numbers are encrypted at rest and only masked values leave the API', async () => {
  const staff = await env.internal('staff');
  const { job } = await env.employerWithPublishedJob();
  const cand = await env.readyCandidate();
  const a = await env.api('POST', '/api/candidate/applications', { token: cand.token, body: { job_id: job.id } });
  const lead = (await env.api('GET', '/api/staff/leads?assigned=unassigned&limit=100', { token: staff.token })).body.find((l) => l.application_ref === a.body.reference_no);
  await env.api('POST', `/api/staff/leads/${lead.id}/claim`, { token: staff.token });
  await env.api('POST', `/api/staff/leads/${lead.id}/qualify`, { token: staff.token, body: {} });
  const rec = await env.api('POST', `/api/staff/candidates/${cand.candidateId}/identity`, { token: staff.token, body: { kind: 'passport', number: 'X1234567', expiry_date: '2031-01-01' } });
  assert.equal(rec.status, 201);
  const raw = await env.db.one('SELECT value_enc, value_hash FROM candidate_identity_refs WHERE candidate_id=$1', [cand.candidateId]);
  assert.ok(!raw.value_enc.includes('X1234567')); assert.ok(!raw.value_hash.includes('X1234567'));
  const view = JSON.stringify((await env.api('GET', `/api/staff/candidates/${cand.candidateId}`, { token: staff.token })).body);
  assert.ok(!view.includes('X1234567')); assert.ok(view.includes('••••567'));
  // the same number on a different person opens a duplicate review instead of silently attaching
  const other = await env.readyCandidate();
  await env.db.query('UPDATE candidates SET owner_user_id=$2 WHERE id=$1', [other.candidateId, staff.userId]);
  const dup = await env.api('POST', `/api/staff/candidates/${other.candidateId}/identity`, { token: staff.token, body: { kind: 'passport', number: 'x 123-4567' } });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'duplicate_review_required');
  assert.equal((await env.db.one('SELECT count(*)::int AS n FROM candidate_identity_refs WHERE candidate_id=$1', [other.candidateId])).n, 0);
  assert.equal((await env.db.one(`SELECT count(*)::int AS n FROM duplicate_reviews WHERE status='open' AND reasons @> '{identity}'`)).n >= 1, true);
});
