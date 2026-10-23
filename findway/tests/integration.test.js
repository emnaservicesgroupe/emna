'use strict';
// Integration tests run against the REAL trust-crm application (../trust-crm) on its own database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestEnv, startTrustCrm } = require('./helpers');
const secrets = require('../src/integrations/secrets');
const dispatcher = require('../src/integrations/dispatcher');
const inbound = require('../src/integrations/inbound');

let env; let trust; let admin; let staff;
const SVC = { serviceEmail: 'findway-service@example.test', servicePassword: 'Service-Pass-12345' };

before(async () => {
  trust = await startTrustCrm();
  env = await createTestEnv({ config: { trustcrm: { baseUrl: '', ...SVC, timeoutMs: 3000 } } });
  admin = await env.internal('admin'); staff = await env.internal('staff');
  await env.db.query(`UPDATE settings SET value='{"max_attempts":3,"base_seconds":10,"max_seconds":120}' WHERE key='policy.sync_retry'`);
});
after(async () => { await env.close(); await trust.close(); });

const connect = async () => {
  await env.api('PUT', '/api/admin/integrations/trustcrm', { token: admin.token, body: { base_url: trust.base, enabled: true } });
  return env.api('POST', '/api/admin/integrations/trustcrm/test', { token: admin.token });
};
const status = async () => (await env.api('GET', '/api/admin/integrations', { token: admin.token })).body.connections[0];
const runWorker = () => dispatcher.runUntilIdle(env.ctx);

async function qualifiedCandidate(opts = {}) {
  const { job } = opts.job ? { job: opts.job } : await env.employerWithPublishedJob({ admin });
  const cand = await env.readyCandidate(opts.cand);
  const a = await env.api('POST', '/api/candidate/applications', { token: cand.token, body: { job_id: job.id } });
  const lead = (await env.api('GET', '/api/staff/leads?assigned=unassigned&limit=100', { token: staff.token })).body.find((l) => l.application_ref === a.body.reference_no);
  await env.api('POST', `/api/staff/leads/${lead.id}/claim`, { token: staff.token });
  const q = await env.api('POST', `/api/staff/leads/${lead.id}/qualify`, { token: staff.token, body: {} });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  return { cand, job, app: a.body, lead, candidateId: cand.candidateId };
}
const recordPassport = (candidateId, number, expiry = '2031-05-20') =>
  env.api('POST', `/api/staff/candidates/${candidateId}/identity`, { token: staff.token, body: { kind: 'passport', number, issuing_country: 'Albania', expiry_date: expiry } });
const delivery = async (type, aggregateId, target = 'trustcrm') => env.db.rows(
  `SELECT d.* FROM sync_deliveries d JOIN outbox_events e ON e.id=d.event_id WHERE e.type=$1 AND e.aggregate_id=$2 AND d.target_key=$3 ORDER BY e.seq`, [type, aggregateId, target]);
const trustCandidate = async (passport) => (await trust.query('SELECT * FROM candidates WHERE passport_number=$1', [passport])).rows[0];

test('"connected" is only shown after real authentication and a real test request succeed', async () => {
  let c = await status();
  assert.equal(c.status, 'not_configured'); assert.equal(c.credentials_configured, true);
  // no base URL yet: the test cannot succeed and must not claim connection
  let t = await env.api('POST', '/api/admin/integrations/trustcrm/test', { token: admin.token });
  assert.notEqual(t.body.status, 'connected');
  // configured but untested is NOT connected
  await env.api('PUT', '/api/admin/integrations/trustcrm', { token: admin.token, body: { base_url: trust.base, enabled: true } });
  assert.equal((await status()).status, 'configured_untested');
  // server down -> unreachable
  trust.mode.fail = 'drop';
  t = await env.api('POST', '/api/admin/integrations/trustcrm/test', { token: admin.token });
  assert.equal(t.body.status, 'unreachable'); assert.match((await status()).last_test_error, /unreachable|timed out/);
  trust.mode.fail = null;
  // wrong credentials -> auth_failed (reachable but not authenticated)
  const good = env.ctx.config.trustcrm.servicePassword;
  env.ctx.config.trustcrm.servicePassword = 'wrong-password';
  require('../src/integrations/trustcrm/client').tokenCache.clear();
  t = await env.api('POST', '/api/admin/integrations/trustcrm/test', { token: admin.token });
  assert.equal(t.body.status, 'auth_failed');
  env.ctx.config.trustcrm.servicePassword = good;
  // real round-trip passes
  t = await env.api('POST', '/api/admin/integrations/trustcrm/test', { token: admin.token });
  assert.equal(t.body.status, 'connected'); assert.ok(t.body.latency_ms >= 0);
  c = await status(); assert.equal(c.status, 'connected'); assert.ok(c.last_success_at);
  assert.ok(trust.calls.some((x) => x === 'GET /candidates/all'), 'the test used a real authenticated trust-crm request');
  // staff cannot manage integrations
  assert.equal((await env.api('POST', '/api/admin/integrations/trustcrm/test', { token: staff.token })).status, 403);
});

test('vertical slice: qualified lead -> blocked until a passport is recorded -> candidate created in trust-crm exactly once', async () => {
  await connect();
  const { candidateId } = await qualifiedCandidate();
  await runWorker();
  const [d] = await delivery('lead.qualified', (await env.db.one(`SELECT id FROM leads WHERE candidate_id=$1`, [candidateId])).id);
  assert.equal(d.status, 'blocked'); assert.equal(d.detail.reason, 'missing_passport_number'); // surfaced, not silently dropped
  assert.equal((await env.db.one(`SELECT count(*)::int AS n FROM external_mappings WHERE canonical_id=$1`, [candidateId])).n, 0);

  const pp = `AL${Date.now() % 1e7}A`;
  assert.equal((await recordPassport(candidateId, pp)).status, 201);
  await runWorker();
  const row = await trustCandidate(pp);
  assert.ok(row, 'candidate must now exist in trust-crm');
  assert.equal(row.full_name, 'Amina Candidate');
  assert.equal(String(row.passport_expiry.toISOString ? row.passport_expiry.toISOString() : row.passport_expiry).slice(0, 10), '2031-05-20');
  const visa = (await trust.query('SELECT * FROM visa_applications WHERE candidate_id=$1', [row.id])).rows[0];
  assert.equal(visa.stage, 'Documents'); // trust-crm created its own visa application: existing workflow preserved
  const map = await env.db.one(`SELECT * FROM external_mappings WHERE system='trustcrm' AND entity_type='candidate' AND canonical_id=$1`, [candidateId]);
  assert.equal(map.external_id, String(row.id));

  // a profile change updates the existing record and never creates a second one
  const before = (await trust.query('SELECT count(*)::int AS n FROM candidates')).rows[0].n;
  await env.db.query(`UPDATE candidates SET full_name='Amina K. Candidate', nationality='Albanian', version=version+1 WHERE id=$1`, [candidateId]);
  const { emit } = require('../src/services/outbox');
  await emit(env.db, { correlationId: 'test' }, { type: 'candidate.updated', aggregateType: 'candidate', aggregateId: candidateId, data: { fields: ['full_name'] } });
  await runWorker();
  assert.equal((await trust.query('SELECT count(*)::int AS n FROM candidates')).rows[0].n, before);
  assert.equal((await trustCandidate(pp)).full_name, 'Amina K. Candidate');
  // re-sending an identical state is detected as a no-op (no second PUT)
  const putsBefore = trust.calls.filter((c) => c.startsWith('PUT')).length;
  await emit(env.db, null, { type: 'candidate.updated', aggregateType: 'candidate', aggregateId: candidateId, data: {} });
  await runWorker();
  assert.equal(trust.calls.filter((c) => c.startsWith('PUT')).length, putsBefore);
});

test('an existing trust-crm record with the same passport is linked, never overwritten or duplicated', async () => {
  await connect();
  const pp = `EX${Date.now() % 1e7}`;
  const created = await (await fetch(`${trust.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: SVC.serviceEmail, password: SVC.servicePassword }) })).json();
  const pre = await (await fetch(`${trust.base}/candidates/add`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` }, body: JSON.stringify({ full_name: 'Legacy Name In Trust CRM', passport_number: pp, nationality: 'Albanian', work_company: 'Legacy Co' }) })).json();
  const { candidateId } = await qualifiedCandidate();
  await recordPassport(candidateId, pp);
  await runWorker();
  const rows = (await trust.query('SELECT * FROM candidates WHERE passport_number=$1', [pp])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].full_name, 'Legacy Name In Trust CRM'); assert.equal(rows[0].work_company, 'Legacy Co'); // untouched
  const map = await env.db.one(`SELECT external_id FROM external_mappings WHERE canonical_id=$1 AND entity_type='candidate'`, [candidateId]);
  assert.equal(map.external_id, String(pre.id));
});

test('outage -> retry with exponential backoff -> dead letter -> replay succeeds', async () => {
  await connect();
  const { candidateId, lead } = await qualifiedCandidate();
  const pp = `OU${Date.now() % 1e7}`;
  await recordPassport(candidateId, pp);
  trust.mode.fail = '503';
  let r = await runWorker();
  assert.ok(r.retry >= 1);
  let [d] = await delivery('lead.qualified', lead.id);
  assert.equal(d.status, 'retry'); assert.equal(d.attempts, 1); assert.match(d.last_error, /503/);
  const first = d.next_attempt_at.getTime() - env.clock.now().getTime();
  assert.ok(first > 0 && first <= 13000, `first backoff ~10s, got ${first}`);
  r = await runWorker(); assert.equal(r.processed, 0); // not due yet: no hammering
  env.clock.advance(15000); await runWorker();
  [d] = await delivery('lead.qualified', lead.id);
  assert.equal(d.attempts, 2);
  assert.ok(d.next_attempt_at.getTime() - env.clock.now().getTime() > 12000, 'backoff doubles');
  env.clock.advance(30000); await runWorker();
  [d] = await delivery('lead.qualified', lead.id);
  assert.equal(d.status, 'dead'); assert.equal(d.attempts, 3);
  const dl = (await env.api('GET', '/api/admin/integrations/dead-letters', { token: admin.token })).body.find((x) => x.delivery_id === d.id);
  assert.ok(dl); assert.equal(dl.event_type, 'lead.qualified');
  assert.equal((await env.api('GET', '/api/admin/integrations', { token: admin.token })).body.dead_letters >= 1, true);
  assert.equal(await trustCandidate(pp), undefined); // nothing leaked through during the outage
  // recovery + replay
  trust.mode.fail = null;
  assert.equal((await env.api('POST', `/api/admin/integrations/dead-letters/${dl.id}/replay`, { token: staff.token })).status, 403);
  assert.equal((await env.api('POST', `/api/admin/integrations/dead-letters/${dl.id}/replay`, { token: admin.token })).status, 200);
  await runWorker();
  [d] = await delivery('lead.qualified', lead.id);
  assert.equal(d.status, 'succeeded');
  assert.ok(await trustCandidate(pp));
  assert.equal((await env.api('POST', `/api/admin/integrations/dead-letters/${dl.id}/replay`, { token: admin.token })).status, 409); // replay is once
  // events for one aggregate are delivered in order: nothing duplicated
  assert.equal((await trust.query('SELECT count(*)::int AS n FROM candidates WHERE passport_number=$1', [pp])).rows[0].n, 1);
});

test('permanent failures go straight to the dead-letter queue (no pointless retries)', async () => {
  await connect();
  const { candidateId, lead } = await qualifiedCandidate();
  const orig = env.ctx.config.trustcrm.serviceEmail;
  await recordPassport(candidateId, `PF${Date.now() % 1e7}`);
  env.ctx.config.trustcrm.servicePassword = 'definitely-wrong';
  require('../src/integrations/trustcrm/client').tokenCache.clear();
  await runWorker();
  const [d] = await delivery('lead.qualified', lead.id);
  assert.equal(d.status, 'dead'); assert.equal(d.attempts, 1);
  assert.equal((await status()).status, 'auth_failed');
  env.ctx.config.trustcrm.servicePassword = SVC.servicePassword; assert.equal(orig, SVC.serviceEmail);
  require('../src/integrations/trustcrm/client').tokenCache.clear();
  await connect();
});

// ────────────────────────── case stage sync (both directions) ──────────────────────────
async function selectedCase() {
  const q = await qualifiedCandidate();
  const pp = `CS${Date.now() % 1e7}${Math.floor(Math.random() * 99)}`;
  await recordPassport(q.candidateId, pp);
  for (const to of ['interview_requested', 'interview_scheduled', 'selected']) {
    const r = await env.api('POST', `/api/staff/applications/${q.app.id}/stage`, { token: staff.token, body: { to } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const kase = (await env.api('POST', '/api/staff/cases', { token: staff.token, body: { application_id: q.app.id } })).body;
  await runWorker();
  return { ...q, pp, kase };
}
const signedPost = (body, { secret, t } = {}) => {
  const raw = JSON.stringify(body);
  const header = secrets.header(secret, raw, t ?? env.clock.now().getTime());
  return env.api('POST', '/api/integrations/trustcrm/webhook', { raw, headers: { 'x-findway-signature': header } });
};
const stageEvent = (ext, stage, at, id) => ({ id: id || `evt-${Math.random().toString(36).slice(2)}`, type: 'candidate.stage_changed', occurred_at: at.toISOString(), origin: 'trustcrm', data: { external_id: String(ext), stage } });

test('case stage pushes to trust-crm; inbound signed events update FIND WAY; duplicates and out-of-order events are safe', async () => {
  await connect();
  const sec = (await env.api('POST', '/api/admin/integrations/trustcrm/inbound-secret', { token: admin.token })).body;
  const secret = { kid: sec.kid, secret: sec.secret };
  const { kase, pp, cand, app } = await selectedCase();
  const tc = await trustCandidate(pp);
  assert.ok(tc);

  // outbound: advancing the case in FIND WAY updates trust-crm's visa stage
  await env.api('POST', `/api/staff/cases/${kase.id}/stage`, { token: staff.token, body: { stage: 'documents' } });
  await runWorker();
  assert.equal((await trustCandidate(pp)).visa_status, 'Documents');
  assert.equal((await trust.query('SELECT stage FROM visa_applications WHERE candidate_id=$1', [tc.id])).rows[0].stage, 'Documents');

  // inbound: trust-crm says the case reached "Visa Appointment"
  const t1 = new Date(env.clock.now().getTime() + 1000);
  const ev = stageEvent(tc.id, 'Visa Appointment', t1);
  const first = await signedPost(ev, { secret });
  assert.equal(first.status, 200); assert.equal(first.body.status, 'applied');
  assert.equal((await env.db.one('SELECT stage FROM recruitment_cases WHERE id=$1', [kase.id])).stage, 'visa_appointment');
  // loop prevention: the change that came from trust-crm is not pushed back to trust-crm
  const echoed = await env.db.rows(`SELECT d.status, d.detail FROM sync_deliveries d JOIN outbox_events e ON e.id=d.event_id WHERE e.aggregate_id=$1 AND e.origin='trustcrm' AND d.target_key='trustcrm'`, [kase.id]);
  assert.ok(echoed.length >= 1 && echoed.every((x) => x.status === 'skipped' && x.detail.reason === 'origin_is_target'));
  const putsBefore = trust.calls.filter((c) => c.includes('/stage')).length; await runWorker();
  assert.equal(trust.calls.filter((c) => c.includes('/stage')).length, putsBefore);

  // duplicate delivery (provider retry or attacker replay): processed once
  const again = await signedPost(ev, { secret });
  assert.equal(again.body.status, 'duplicate');
  assert.equal((await env.db.one(`SELECT count(*)::int AS n FROM case_events WHERE case_id=$1 AND to_stage='visa_appointment'`, [kase.id])).n, 1);

  // out-of-order: an OLDER event arriving late must not overwrite newer state
  const stale = await signedPost(stageEvent(tc.id, 'Contract', new Date(t1.getTime() - 60000)), { secret });
  assert.equal(stale.body.status, 'stale_ignored');
  assert.equal((await env.db.one('SELECT stage FROM recruitment_cases WHERE id=$1', [kase.id])).stage, 'visa_appointment');
  // a genuinely newer event still applies
  const newer = await signedPost(stageEvent(tc.id, 'Visa Result', new Date(t1.getTime() + 60000)), { secret });
  assert.equal(newer.body.status, 'applied');
  // unknown stage text is recorded as failed-to-map, not guessed
  const odd = await signedPost(stageEvent(tc.id, 'Flying Carpet', new Date(t1.getTime() + 120000)), { secret });
  assert.equal(odd.body.status, 'failed');
  // the candidate sees the mirrored stage (read-only) on their own application
  const mine = await env.api('GET', `/api/candidate/applications/${app.id}`, { token: cand.token });
  assert.equal(mine.body.case.stage, 'visa_result');
  // everything is logged for diagnosis
  const log = await env.db.rows(`SELECT status FROM inbound_events WHERE source='trustcrm' ORDER BY received_at`);
  assert.ok(log.some((l) => l.status === 'applied') && log.some((l) => l.status === 'stale_ignored'));
});

test('webhook security: bad signature, wrong secret, stale timestamp, tampered body and unknown source are all rejected', async () => {
  const sec = (await env.api('POST', '/api/admin/integrations/trustcrm/inbound-secret', { token: admin.token })).body;
  const secret = { kid: sec.kid, secret: sec.secret };
  const ev = stageEvent(99999, 'Documents', new Date());
  const raw = JSON.stringify(ev);
  const post = (headers, body = raw) => env.api('POST', '/api/integrations/trustcrm/webhook', { raw: body, headers });
  assert.equal((await post({})).body.error.code, 'signature_missing');
  assert.equal((await post({ 'x-findway-signature': 'garbage' })).status, 401);
  const wrong = secrets.header({ kid: secret.kid, secret: 'not-the-secret' }, raw, env.clock.now().getTime());
  assert.equal((await post({ 'x-findway-signature': wrong })).body.error.code, 'signature_invalid');
  const old = secrets.header(secret, raw, env.clock.now().getTime() - 10 * 60 * 1000);
  assert.equal((await post({ 'x-findway-signature': old })).body.error.code, 'signature_stale');
  const future = secrets.header(secret, raw, env.clock.now().getTime() + 10 * 60 * 1000);
  assert.equal((await post({ 'x-findway-signature': future })).body.error.code, 'signature_stale');
  const good = secrets.header(secret, raw, env.clock.now().getTime());
  assert.equal((await post({ 'x-findway-signature': good }, raw.replace('Documents', 'Contract'))).body.error.code, 'signature_invalid'); // tampered body
  assert.equal((await env.api('POST', '/api/integrations/unknown/webhook', { raw, headers: { 'x-findway-signature': good } })).status, 404);
  assert.equal((await post({ 'x-findway-signature': good })).status, 200);
  assert.equal((await env.db.one(`SELECT count(*)::int AS n FROM inbound_events WHERE event_id=$1`, [ev.id])).n, 1);
});

test('secret rotation: old secret keeps working during the overlap window, then stops; new secret works immediately', async () => {
  const s1 = (await env.api('POST', '/api/admin/integrations/trustcrm/inbound-secret', { token: admin.token })).body;
  const s2 = (await env.api('POST', '/api/admin/integrations/trustcrm/inbound-secret', { token: admin.token })).body;
  assert.notEqual(s1.kid, s2.kid);
  const send = (s) => signedPost(stageEvent(424242, 'Documents', new Date()), { secret: s });
  assert.equal((await send(s2)).status, 200);
  assert.equal((await send(s1)).status, 200); // still inside the 24h overlap
  env.clock.advance(25 * 3600 * 1000);
  assert.equal((await send(s1)).body.error.code, 'signature_invalid'); // expired
  assert.equal((await send(s2)).status, 200);
  await admin.login(); await staff.login(); // the 25h clock jump expired the sessions
});

test('conflict review: a remote change that collides with an unsynced local change is queued, not silently applied', async () => {
  await connect();
  const sec = (await env.api('POST', '/api/admin/integrations/trustcrm/inbound-secret', { token: admin.token })).body;
  const secret = { kid: sec.kid, secret: sec.secret };
  const { kase, pp } = await selectedCase();
  const tc = await trustCandidate(pp);
  await env.api('POST', `/api/staff/cases/${kase.id}/stage`, { token: staff.token, body: { stage: 'documents' } });
  await runWorker(); // synced: mapping now at the current version
  await env.api('POST', `/api/staff/cases/${kase.id}/stage`, { token: staff.token, body: { stage: 'contract' } }); // local change NOT yet synced (worker not run)
  const r = await signedPost(stageEvent(tc.id, 'Travel', new Date(env.clock.now().getTime() + 5000)), { secret });
  assert.equal(r.body.status, 'conflict');
  assert.equal((await env.db.one('SELECT stage FROM recruitment_cases WHERE id=$1', [kase.id])).stage, 'contract'); // local value preserved
  const open = (await env.api('GET', '/api/admin/integrations/conflicts', { token: admin.token })).body.find((c) => c.canonical_id === kase.id);
  assert.ok(open); assert.equal(open.local_value, 'contract'); assert.equal(open.remote_value, 'travel');
  assert.equal((await env.api('POST', `/api/admin/integrations/conflicts/${open.id}/resolve`, { token: staff.token, body: { resolution: 'remote' } })).status, 403);
  assert.equal((await env.api('POST', `/api/admin/integrations/conflicts/${open.id}/resolve`, { token: admin.token, body: { resolution: 'remote' } })).status, 200);
  assert.equal((await env.db.one('SELECT stage FROM recruitment_cases WHERE id=$1', [kase.id])).stage, 'travel');
  assert.equal((await env.api('POST', `/api/admin/integrations/conflicts/${open.id}/resolve`, { token: admin.token, body: { resolution: 'local' } })).status, 409);

  // resolving in favour of FIND WAY pushes our value back out
  await env.api('POST', `/api/staff/cases/${kase.id}/stage`, { token: staff.token, body: { stage: 'arrival' } });
  const r2 = await signedPost(stageEvent(tc.id, 'Visa Result', new Date(env.clock.now().getTime() + 9000)), { secret });
  assert.equal(r2.body.status, 'conflict');
  const open2 = (await env.api('GET', '/api/admin/integrations/conflicts', { token: admin.token })).body.find((c) => c.canonical_id === kase.id);
  await env.api('POST', `/api/admin/integrations/conflicts/${open2.id}/resolve`, { token: admin.token, body: { resolution: 'local' } });
  await runWorker();
  assert.equal((await trustCandidate(pp)).visa_status, 'Arrival');
});

test('reconciliation detects drift made directly inside trust-crm (it has no webhook emitter) and applies it safely', async () => {
  await connect();
  const { kase, pp } = await selectedCase();
  await env.api('POST', `/api/staff/cases/${kase.id}/stage`, { token: staff.token, body: { stage: 'documents' } });
  await runWorker();
  // someone in trust-crm moves the visa stage with its own API
  const login = await (await fetch(`${trust.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: SVC.serviceEmail, password: SVC.servicePassword }) })).json();
  const tc = await trustCandidate(pp);
  env.clock.advance(5000);
  await new Promise((r) => setTimeout(r, 1100)); // trust-crm stamps updated_at with its own clock
  const mv = await fetch(`${trust.base}/candidates/${tc.id}/stage`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: JSON.stringify({ stage: 'Work Permit', status: 'Pending' }) });
  assert.equal(mv.status, 200);
  const rec = await env.api('POST', '/api/admin/integrations/trustcrm/reconcile', { token: admin.token });
  assert.equal(rec.status, 200); assert.ok(rec.body.checked >= 1);
  assert.equal((await env.db.one('SELECT stage FROM recruitment_cases WHERE id=$1', [kase.id])).stage, 'work_permit');
  const again = await env.api('POST', '/api/admin/integrations/trustcrm/reconcile', { token: admin.token });
  assert.equal(again.body.applied, 0); // idempotent: nothing new to apply
});

test('passport expiry is owned by trust-crm and flows back into FIND WAY', async () => {
  await connect();
  const sec = (await env.api('POST', '/api/admin/integrations/trustcrm/inbound-secret', { token: admin.token })).body;
  const { candidateId } = await qualifiedCandidate();
  const pp = `PE${Date.now() % 1e7}`;
  await recordPassport(candidateId, pp, '2027-01-01'); await runWorker();
  const tc = await trustCandidate(pp);
  const r = await signedPost({ id: `pe-${Date.now()}`, type: 'candidate.updated', occurred_at: new Date(env.clock.now().getTime() + 1000).toISOString(), data: { external_id: String(tc.id), fields: { passport_expiry: '2032-02-02', full_name: 'Hacked Name' } } }, { secret: { kid: sec.kid, secret: sec.secret } });
  assert.equal(r.body.status, 'applied');
  const ref = await env.db.one(`SELECT expiry_date FROM candidate_identity_refs WHERE candidate_id=$1`, [candidateId]);
  assert.equal(ref.expiry_date, '2032-02-02');
  assert.notEqual((await env.db.one('SELECT full_name FROM candidates WHERE id=$1', [candidateId])).full_name, 'Hacked Name'); // fields FIND WAY owns are never overwritten inbound
});

// ────────────────────────── generic signed webhooks ──────────────────────────
test('outbound webhooks are signed, minimal, retried, and refuse private addresses', async () => {
  const received = []; let failNext = 0;
  const recv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { if (failNext > 0) { failNext--; res.statusCode = 500; return res.end(); } received.push({ headers: req.headers, body: b }); res.end('ok'); }); });
  await new Promise((r) => recv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${recv.address().port}/hook`;
  try {
    const unsafe = await env.api('POST', '/api/admin/integrations/subscriptions', { token: admin.token, body: { url: 'http://10.0.0.5/hook', events: ['job.published'] } });
    assert.equal(unsafe.status, 400); assert.equal(unsafe.body.error.code, 'unsafe_url');
    const meta = await env.api('POST', '/api/admin/integrations/subscriptions', { token: admin.token, body: { url: 'http://169.254.169.254/latest', events: ['job.published'] } });
    assert.equal(meta.status, 400);
    const sub = await env.api('POST', '/api/admin/integrations/subscriptions', { token: admin.token, body: { url, events: ['job.published'], description: 'test receiver' } });
    assert.equal(sub.status, 201); assert.ok(sub.body.secret);
    failNext = 1;
    await env.employerWithPublishedJob({ admin, jobOverrides: { title: 'Webhook Welder' } });
    await runWorker(); // first attempt gets a 500 -> retry
    assert.equal(received.length, 0);
    env.clock.advance(15000); await runWorker();
    assert.equal(received.length, 1);
    const { headers, body } = received[0];
    const h = secrets.parseHeader(headers['x-findway-signature']);
    assert.equal(h.kid, sub.body.kid);
    assert.equal(secrets.sign(sub.body.secret, h.t, body), h.v1); // receiver can verify
    const ev = JSON.parse(body);
    assert.equal(ev.type, 'job.published'); assert.equal(headers['x-findway-event-id'], ev.id);
    assert.deepEqual(Object.keys(ev.data), ['material_changes']); // ids only: no personal data or job content in the payload
    // rotate the signing secret: new deliveries use the new kid
    const rot = await env.api('POST', `/api/admin/integrations/subscriptions/${sub.body.id}/rotate-secret`, { token: admin.token });
    assert.notEqual(rot.body.kid, sub.body.kid);
    await env.employerWithPublishedJob({ admin, jobOverrides: { title: 'Second Welder' } });
    await runWorker();
    assert.equal(secrets.parseHeader(received.at(-1).headers['x-findway-signature']).kid, rot.body.kid);
    // disabled subscriptions receive nothing
    await env.api('POST', `/api/admin/integrations/subscriptions/${sub.body.id}/active`, { token: admin.token, body: { active: false } });
    const n = received.length;
    await env.employerWithPublishedJob({ admin, jobOverrides: { title: 'Third Welder' } }); await runWorker();
    assert.equal(received.length, n);
  } finally { recv.close(); }
});

test('disabling the integration blocks (never silently drops) pending deliveries, and they can be retried later', async () => {
  await connect();
  const { candidateId, lead } = await qualifiedCandidate();
  await recordPassport(candidateId, `DI${Date.now() % 1e7}`);
  await env.api('PUT', '/api/admin/integrations/trustcrm', { token: admin.token, body: { enabled: false } });
  await runWorker();
  const [d] = await delivery('lead.qualified', lead.id);
  assert.equal(d.status, 'blocked'); assert.equal(d.detail.reason, 'connection_disabled');
  await env.api('PUT', '/api/admin/integrations/trustcrm', { token: admin.token, body: { enabled: true } });
  assert.equal((await env.api('POST', `/api/admin/integrations/deliveries/${d.id}/retry`, { token: admin.token })).status, 200);
  await runWorker();
  assert.equal((await delivery('lead.qualified', lead.id))[0].status, 'succeeded');
});
