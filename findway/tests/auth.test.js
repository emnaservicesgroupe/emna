'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, PW } = require('./helpers');
const C = require('../src/lib/crypto');

let env;
before(async () => { env = await createTestEnv(); });
after(async () => { await env.close(); });

const reg = (email, extra = {}) => ({ email, password: PW, full_name: 'Sam Applicant', role: 'candidate', accept_terms: true, ...extra });

test('registration sends an OTP, the account cannot log in until verified, and the OTP email is never stored in clear', async () => {
  const email = 'sam@example.test';
  const r = await env.api('POST', '/api/auth/register', { body: reg(email) });
  assert.equal(r.status, 202);
  const early = await env.api('POST', '/api/auth/login', { body: { email, password: PW } });
  assert.equal(early.status, 403); assert.equal(early.body.error.code, 'email_verification_required');
  const code = env.lastCode(email); assert.match(code, /^\d{6}$/);
  const row = await env.db.one(`SELECT body_text, status FROM outbound_messages WHERE to_address=$1 ORDER BY created_at DESC LIMIT 1`, [email]);
  assert.match(row.body_text, /redacted/); assert.ok(!row.body_text.includes(code));
  assert.equal(row.status, 'provider_accepted'); // accepted by the dev provider; never claimed as "delivered"
  assert.equal((await env.api('POST', '/api/auth/verify-email', { body: { email, code } })).status, 200);
  const l = await env.api('POST', '/api/auth/login', { body: { email, password: PW } });
  assert.equal(l.status, 200); assert.ok(l.body.token);
});

test('OTP: wrong codes lock the challenge after 5 attempts, even for the right code afterwards', async () => {
  const email = 'lock@example.test';
  await env.api('POST', '/api/auth/register', { body: reg(email) });
  const good = env.lastCode(email);
  const wrong = good === '000000' ? '111111' : '000000';
  let last;
  for (let i = 0; i < 5; i++) last = await env.api('POST', '/api/auth/verify-email', { body: { email, code: wrong } });
  assert.equal(last.body.error.code, 'otp_locked');
  const after = await env.api('POST', '/api/auth/verify-email', { body: { email, code: good } });
  assert.equal(after.status, 429); assert.equal(after.body.error.code, 'otp_locked');
});

test('OTP expires after the configured TTL', async () => {
  const email = 'expire@example.test';
  await env.api('POST', '/api/auth/register', { body: reg(email) });
  const code = env.lastCode(email);
  env.clock.advance(11 * 60 * 1000);
  const r = await env.api('POST', '/api/auth/verify-email', { body: { email, code } });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'otp_expired');
});

test('OTP resend: 30s cooldown, max 3 sends per hour, and only the newest code works', async () => {
  const email = 'resend@example.test';
  await env.api('POST', '/api/auth/register', { body: reg(email) });
  const first = env.lastCode(email);
  const tooSoon = await env.api('POST', '/api/auth/resend-verification', { body: { email } });
  assert.equal(tooSoon.status, 429); assert.equal(tooSoon.body.error.code, 'otp_cooldown');
  env.clock.advance(31000);
  assert.equal((await env.api('POST', '/api/auth/resend-verification', { body: { email } })).status, 200);
  const second = env.lastCode(email);
  env.clock.advance(31000);
  assert.equal((await env.api('POST', '/api/auth/resend-verification', { body: { email } })).status, 200);
  env.clock.advance(31000);
  const capped = await env.api('POST', '/api/auth/resend-verification', { body: { email } });
  assert.equal(capped.status, 429); assert.equal(capped.body.error.code, 'otp_resend_limited');
  assert.ok(capped.body.error.details.retry_after_seconds > 0);
  if (first !== second) { // the superseded code must be dead
    const stale = await env.api('POST', '/api/auth/verify-email', { body: { email, code: first } });
    assert.notEqual(stale.status, 200);
  }
});

test('registering an existing verified email reveals nothing and does not create a second user', async () => {
  const u = await env.signup({ role: 'candidate' });
  const again = await env.api('POST', '/api/auth/register', { body: reg(u.email) });
  assert.equal(again.status, 202);
  const n = await env.db.one('SELECT count(*)::int AS n FROM users WHERE email_norm=$1', [u.email]);
  assert.equal(n.n, 1);
});

test('login failures are generic, lock the account after 5 tries, and password recovery revokes sessions', async () => {
  const u = await env.signup({ role: 'candidate' });
  const unknown = await env.api('POST', '/api/auth/login', { body: { email: 'nobody@example.test', password: PW } });
  const wrong = await env.api('POST', '/api/auth/login', { body: { email: u.email, password: 'Wrong-Password-1' } });
  assert.equal(unknown.body.error.code, 'invalid_credentials'); assert.equal(wrong.body.error.code, 'invalid_credentials');
  for (let i = 0; i < 4; i++) await env.api('POST', '/api/auth/login', { body: { email: u.email, password: 'Wrong-Password-1' } });
  const locked = await env.api('POST', '/api/auth/login', { body: { email: u.email, password: PW } });
  assert.equal(locked.status, 429); assert.equal(locked.body.error.code, 'account_locked');
  env.clock.advance(16 * 60 * 1000);
  const ok = await env.api('POST', '/api/auth/login', { body: { email: u.email, password: PW } });
  assert.equal(ok.status, 200);
  // recovery
  assert.equal((await env.api('POST', '/api/auth/recover', { body: { email: u.email } })).status, 200);
  const code = env.lastCode(u.email);
  const reset = await env.api('POST', '/api/auth/recover/confirm', { body: { email: u.email, code, new_password: 'Brand-New-Passw0rd' } });
  assert.equal(reset.status, 200);
  assert.equal((await env.api('GET', '/api/me', { token: ok.body.token })).status, 401); // old session revoked
  assert.equal((await env.api('POST', '/api/auth/login', { body: { email: u.email, password: 'Brand-New-Passw0rd' } })).status, 200);
  // unknown email gets the same answer
  assert.equal((await env.api('POST', '/api/auth/recover', { body: { email: 'ghost@example.test' } })).status, 200);
});

test('weak passwords are rejected', async () => {
  const r = await env.api('POST', '/api/auth/register', { body: reg('weak@example.test', { password: 'short' }) });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'weak_password');
});

test('awaiting approval: can onboard and see own status, but gains no restricted access', async () => {
  const emp = await env.signup({ role: 'employer_owner' });
  const me = await env.api('GET', '/api/me', { token: emp.token });
  assert.equal(me.body.status.email_verified, true); assert.equal(me.body.status.approval, 'pending');
  assert.ok(me.body.permissions.includes('onboard:org'));
  assert.ok(!me.body.permissions.includes('employer:jobs'));
  const company = await env.api('PATCH', '/api/employer/company', { token: emp.token, body: { description: 'We build ships.' } });
  assert.equal(company.status, 200); // onboarding allowed
  const job = await env.api('POST', '/api/employer/jobs', { token: emp.token, body: { title: 'Welder' } });
  assert.equal(job.status, 403); assert.equal(job.body.error.code, 'approval_required');
  const staffArea = await env.api('GET', '/api/staff/leads', { token: emp.token });
  assert.equal(staffArea.status, 403);
});

test('admin approval is independent from email verification and company verification', async () => {
  const admin = await env.internal('admin');
  const emp = await env.signup({ role: 'employer_owner' });
  const queue = await env.api('GET', '/api/admin/approvals', { token: admin.token });
  assert.ok(queue.body.some((u) => u.id === emp.userId));
  const rej = await env.api('POST', `/api/admin/users/${emp.userId}/approval`, { token: admin.token, body: { decision: 'rejected' } });
  assert.equal(rej.status, 422); assert.equal(rej.body.error.code, 'reason_required');
  const ok = await env.api('POST', `/api/admin/users/${emp.userId}/approval`, { token: admin.token, body: { decision: 'approved', note: 'Looks legitimate' } });
  assert.equal(ok.status, 200);
  const me = await env.api('GET', '/api/me', { token: emp.token });
  assert.equal(me.body.status.approval, 'approved');
  assert.equal(me.body.status.organizations[0].verification_status, 'unsubmitted'); // approval did not verify the company
  const self = await env.api('POST', `/api/admin/users/${admin.userId}/approval`, { token: admin.token, body: { decision: 'approved' } });
  assert.equal(self.status, 403);
});

test('privileged accounts need MFA: unenrolled sessions are confined to enrolment; TOTP codes are single-use', async () => {
  const email = 'newadmin@findway.test';
  const sa = await env.superAdmin();
  const made = await env.api('POST', '/api/admin/users', { token: sa.token, body: { email, full_name: 'New Admin', role: 'admin' } });
  assert.equal(made.status, 201);
  // invited user sets a password through recovery (proves control of the mailbox)
  await env.api('POST', '/api/auth/recover', { body: { email } });
  await env.api('POST', '/api/auth/recover/confirm', { body: { email, code: env.lastCode(email), new_password: 'Admin-Pass-Word-1' } });
  const login = await env.api('POST', '/api/auth/login', { body: { email, password: 'Admin-Pass-Word-1' } });
  assert.equal(login.body.mfa_enrollment_required, true);
  const blocked = await env.api('GET', '/api/admin/approvals', { token: login.body.token });
  assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'mfa_required');
  const enroll = await env.api('POST', '/api/auth/mfa/enroll', { token: login.body.token });
  assert.equal(enroll.status, 200);
  const step = C.totpStep(env.clock.now().getTime());
  const confirm = await env.api('POST', '/api/auth/mfa/confirm', { token: login.body.token, body: { code: C.totpAt(enroll.body.secret, step) } });
  assert.equal(confirm.status, 200); assert.equal(confirm.body.recovery_codes.length, 8);
  assert.equal((await env.api('GET', '/api/admin/approvals', { token: login.body.token })).status, 200);
  // the same TOTP step cannot be replayed to log in again
  const again = await env.api('POST', '/api/auth/login', { body: { email, password: 'Admin-Pass-Word-1' } });
  const replay = await env.api('POST', '/api/auth/login/mfa', { body: { mfa_token: again.body.mfa_token, code: C.totpAt(enroll.body.secret, step) } });
  assert.equal(replay.status, 400); assert.equal(replay.body.error.code, 'mfa_invalid');
  // admins cannot create other admins; staff cannot approve anyone
  const adm = await env.internal('admin');
  const nope = await env.api('POST', '/api/admin/users', { token: adm.token, body: { email: 'x@findway.test', full_name: 'X', role: 'admin' } });
  assert.equal(nope.status, 403);
  const staff = await env.internal('staff');
  assert.equal((await env.api('GET', '/api/admin/approvals', { token: staff.token })).status, 403);
});

test('suspension revokes sessions immediately and blocks login', async () => {
  const sa = await env.superAdmin();
  const u = await env.signup({ role: 'candidate' });
  assert.equal((await env.api('GET', '/api/me', { token: u.token })).status, 200);
  const r = await env.api('POST', `/api/admin/users/${u.userId}/suspension`, { token: sa.token, body: { suspended: true, reason: 'fraud review' } });
  assert.equal(r.status, 200);
  assert.equal((await env.api('GET', '/api/me', { token: u.token })).status, 401);
  const l = await env.api('POST', '/api/auth/login', { body: { email: u.email, password: PW } });
  assert.equal(l.status, 403); assert.equal(l.body.error.code, 'account_suspended');
});

test('sessions can be listed and revoked individually', async () => {
  const u = await env.signup({ role: 'candidate' });
  const second = await env.api('POST', '/api/auth/login', { body: { email: u.email, password: PW } });
  const list = await env.api('GET', '/api/auth/sessions', { token: u.token });
  assert.equal(list.body.length, 2);
  const other = list.body.find((s) => !s.current);
  assert.equal((await env.api('DELETE', `/api/auth/sessions/${other.id}`, { token: u.token })).status, 200);
  assert.equal((await env.api('GET', '/api/me', { token: second.body.token })).status, 401);
});

test('audit log is append-only at the database level', async () => {
  const row = await env.db.one('SELECT id FROM audit_events LIMIT 1');
  await assert.rejects(env.db.query(`UPDATE audit_events SET action='tampered' WHERE id=$1`, [row.id]), /append-only/);
  await assert.rejects(env.db.query('DELETE FROM audit_events WHERE id=$1', [row.id]), /append-only/);
});
