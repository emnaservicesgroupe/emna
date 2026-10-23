'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, PW } = require('./helpers');
const C = require('../src/lib/crypto');

let env;
before(async () => { env = await createTestEnv(); });
after(async () => { await env.close(); });

test('candidate approval policy "manual": can complete the profile while waiting, cannot apply until an admin approves', async () => {
  const admin = await env.internal('admin');
  const { job } = await env.employerWithPublishedJob({ admin });
  await env.db.query(`UPDATE settings SET value='"manual"' WHERE key='policy.candidate_approval'`);
  try {
    const c = await env.signup({ role: 'candidate', full_name: 'Waiting Candidate' });
    const me = await env.api('GET', '/api/me', { token: c.token });
    assert.equal(me.body.status.approval, 'pending'); assert.equal(me.body.status.email_verified, true);
    const p = await env.api('PATCH', '/api/candidate/profile', { token: c.token, body: { phone: '+355691234500', country: 'Albania', profession: 'Welder' } });
    assert.equal(p.status, 200); // onboarding allowed
    const blocked = await env.api('POST', '/api/candidate/applications', { token: c.token, body: { job_id: job.id } });
    assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'approval_required');
    const queue = await env.api('GET', '/api/admin/approvals', { token: admin.token });
    assert.ok(queue.body.some((u) => u.id === c.userId && u.role === 'candidate'));
    await env.api('POST', `/api/admin/users/${c.userId}/approval`, { token: admin.token, body: { decision: 'approved' } });
    assert.equal((await env.api('POST', '/api/candidate/applications', { token: c.token, body: { job_id: job.id } })).status, 201);
  } finally { await env.db.query(`UPDATE settings SET value='"auto"' WHERE key='policy.candidate_approval'`); }
});

test('rejected accounts stay locked out and are told why; the decision is e-mailed with an honest state', async () => {
  const admin = await env.internal('admin');
  const emp = await env.signup({ role: 'employer_owner' });
  await env.api('POST', `/api/admin/users/${emp.userId}/approval`, { token: admin.token, body: { decision: 'rejected', note: 'Could not verify the business' } });
  const me = await env.api('GET', '/api/me', { token: emp.token });
  assert.equal(me.body.status.approval, 'rejected'); assert.equal(me.body.status.approval_note, 'Could not verify the business');
  assert.equal((await env.api('POST', '/api/employer/jobs', { token: emp.token, body: { title: 'x' } })).status, 403);
  const mail = await env.db.one(`SELECT status, body_text FROM outbound_messages WHERE to_address=$1 AND template='account_decision'`, [emp.email]);
  assert.equal(mail.status, 'provider_accepted'); assert.match(mail.body_text, /rejected/);
});

test('company verification: changes requested -> resubmitted -> verified; reasons are required; reviewers are staff, not the employer', async () => {
  const staff = await env.internal('staff'); const admin = await env.internal('admin');
  const emp = await env.signup({ role: 'employer_owner' });
  await env.api('POST', `/api/admin/users/${emp.userId}/approval`, { token: admin.token, body: { decision: 'approved' } });
  const org = await env.db.one('SELECT o.id FROM organizations o JOIN memberships m ON m.org_id=o.id WHERE m.user_id=$1', [emp.userId]);
  assert.equal((await env.api('POST', '/api/employer/company/verification', { token: emp.token, body: { registration_number: 'AL-777' } })).status, 202);
  assert.equal((await env.api('POST', '/api/employer/company/verification', { token: emp.token, body: { registration_number: 'AL-777' } })).status, 409); // already in review
  assert.ok((await env.api('GET', '/api/admin/org-verifications', { token: staff.token })).body.some((o) => o.id === org.id));
  assert.equal((await env.api('POST', `/api/admin/orgs/${org.id}/verification`, { token: emp.token, body: { decision: 'verified' } })).status, 403);
  assert.equal((await env.api('POST', `/api/admin/orgs/${org.id}/verification`, { token: staff.token, body: { decision: 'changes_requested' } })).status, 422);
  assert.equal((await env.api('POST', `/api/admin/orgs/${org.id}/verification`, { token: staff.token, body: { decision: 'changes_requested', note: 'Upload registry extract number' } })).status, 200);
  const view = await env.api('GET', '/api/employer/company', { token: emp.token });
  assert.equal(view.body.verification_status, 'changes_requested'); assert.equal(view.body.verification_note, 'Upload registry extract number');
  assert.equal(view.body.owner_user_id, undefined); assert.equal(view.body.introduced_by, undefined); // internal fields stay internal
  assert.equal((await env.api('POST', '/api/employer/company/verification', { token: emp.token, body: { registration_number: 'AL-777-B' } })).status, 202);
  assert.equal((await env.api('POST', `/api/admin/orgs/${org.id}/verification`, { token: staff.token, body: { decision: 'verified' } })).status, 200);
  assert.equal((await env.api('GET', '/api/employer/company', { token: emp.token })).body.verification_status, 'verified');
  assert.ok((await env.api('GET', '/api/notifications', { token: emp.token })).body.items.some((n) => n.type === 'org.verification_decided'));
  // staff can see audit nothing; but the actions are in the audit log for admins
  const audit = await env.api('GET', `/api/admin/audit?entity_type=organization&entity_id=${org.id}`, { token: admin.token });
  assert.ok(audit.body.some((a) => a.action === 'org.verification_verified'));
  assert.equal((await env.api('GET', '/api/admin/audit', { token: staff.token })).status, 403);
});

test('job review outcomes: changes requested -> employer edits -> resubmits -> rejected; reasons required; pull-back of own submission', async () => {
  const admin = await env.internal('admin');
  const emp = await env.signup({ role: 'employer_owner' });
  await env.api('POST', `/api/admin/users/${emp.userId}/approval`, { token: admin.token, body: { decision: 'approved' } });
  const job = await env.draftJob(emp);
  await env.api('POST', `/api/employer/jobs/${job.id}/submit`, { token: emp.token });
  assert.equal((await env.api('PATCH', `/api/employer/jobs/${job.id}`, { token: emp.token, body: { title: 'sneaky edit' } })).status, 409); // locked in review
  assert.equal((await env.api('POST', `/api/admin/jobs/${job.id}/review`, { token: admin.token, body: { decision: 'request_changes' } })).status, 422);
  assert.equal((await env.api('POST', `/api/admin/jobs/${job.id}/review`, { token: admin.token, body: { decision: 'request_changes', note: 'State the salary basis' } })).status, 200);
  const mine = await env.api('GET', `/api/employer/jobs/${job.id}`, { token: emp.token });
  assert.equal(mine.body.status, 'changes_requested'); assert.equal(mine.body.status_reason, 'State the salary basis');
  assert.equal((await env.api('PATCH', `/api/employer/jobs/${job.id}`, { token: emp.token, body: { salary_basis: 'gross' } })).status, 200);
  assert.equal((await env.api('POST', `/api/employer/jobs/${job.id}/submit`, { token: emp.token })).status, 200);
  assert.equal((await env.api('POST', `/api/employer/jobs/${job.id}/withdraw-submission`, { token: emp.token })).body.status, 'draft');
  await env.api('POST', `/api/employer/jobs/${job.id}/submit`, { token: emp.token });
  assert.equal((await env.api('POST', `/api/admin/jobs/${job.id}/review`, { token: admin.token, body: { decision: 'reject', note: 'Misleading terms' } })).body.status, 'rejected');
  assert.equal((await env.api('GET', `/api/public/jobs/${job.id}`)).status, 404);
  const n = (await env.api('GET', '/api/notifications', { token: emp.token })).body;
  assert.ok(n.unread >= 2);
  await env.api('POST', `/api/notifications/${n.items[0].id}/read`, { token: emp.token });
  assert.equal((await env.api('GET', '/api/notifications', { token: emp.token })).body.unread, n.unread - 1);
  const hist = await env.db.rows('SELECT to_status FROM job_status_events WHERE job_id=$1 ORDER BY created_at', [job.id]);
  assert.deepEqual(hist.map((h) => h.to_status), ['draft', 'pending_approval', 'changes_requested', 'pending_approval', 'draft', 'pending_approval', 'rejected']);
});

test('only a Super Admin can reset MFA; the reset ends the target\'s sessions and forces re-enrolment', async () => {
  const sa = await env.superAdmin(); const admin = await env.internal('admin'); const other = await env.internal('admin');
  assert.equal((await env.api('POST', `/api/admin/users/${admin.userId}/mfa-reset`, { token: other.token })).status, 403);
  assert.equal((await env.api('POST', `/api/admin/users/${admin.userId}/mfa-reset`, { token: sa.token })).status, 200);
  assert.equal((await env.api('GET', '/api/me', { token: admin.token })).status, 401);
  const login = await env.api('POST', '/api/auth/login', { body: { email: admin.email, password: PW } });
  assert.equal(login.body.mfa_enrollment_required, true);
  assert.equal((await env.api('GET', '/api/admin/approvals', { token: login.body.token })).body.error.code, 'mfa_required');
});

test('recovery codes work once as an MFA fallback', async () => {
  const sa = await env.superAdmin();
  const email = 'qa-mfa@findway.test';
  await env.api('POST', '/api/admin/users', { token: sa.token, body: { email, full_name: 'Recovery Test', role: 'staff' } });
  await env.api('POST', '/api/auth/recover', { body: { email } });
  await env.api('POST', '/api/auth/recover/confirm', { body: { email, code: env.lastCode(email), new_password: 'Recovery-Test-Pass1' } });
  const l = await env.api('POST', '/api/auth/login', { body: { email, password: 'Recovery-Test-Pass1' } });
  const en = await env.api('POST', '/api/auth/mfa/enroll', { token: l.body.token });
  const done = await env.api('POST', '/api/auth/mfa/confirm', { token: l.body.token, body: { code: C.totpAt(en.body.secret, C.totpStep(env.clock.now().getTime())) } });
  const [code] = done.body.recovery_codes;
  const step1 = await env.api('POST', '/api/auth/login', { body: { email, password: 'Recovery-Test-Pass1' } });
  assert.equal((await env.api('POST', '/api/auth/login/mfa', { body: { mfa_token: step1.body.mfa_token, code } })).status, 200);
  const step2 = await env.api('POST', '/api/auth/login', { body: { email, password: 'Recovery-Test-Pass1' } });
  assert.equal((await env.api('POST', '/api/auth/login/mfa', { body: { mfa_token: step2.body.mfa_token, code } })).status, 400); // used up
});

test('agencies are confined to onboarding/status in Phase 1 and cannot reach employer, staff or candidate areas', async () => {
  const admin = await env.internal('admin');
  const ag = await env.signup({ role: 'agency', org: { name: 'Demo Agency Tunis', country: 'Tunisia' } });
  const me = await env.api('GET', '/api/me', { token: ag.token });
  assert.equal(me.body.role, 'agency'); assert.equal(me.body.status.organizations[0].type, 'agency');
  await env.api('POST', `/api/admin/users/${ag.userId}/approval`, { token: admin.token, body: { decision: 'approved' } });
  for (const p of ['/api/employer/jobs', '/api/staff/leads', '/api/candidate/applications', '/api/admin/approvals']) assert.equal((await env.api('GET', p, { token: ag.token })).status, 403, p);
  assert.equal((await env.api('POST', '/api/auth/register', { body: { email: 'g@example.test', password: PW, full_name: 'Guest', role: 'guest', accept_terms: true } })).status, 422);
});

test('duplicate company registration is flagged for admin review without revealing other companies to the registrant', async () => {
  const a = await env.signup({ role: 'employer_owner', org: { name: 'Twin Marine Ltd', country: 'Albania', registration_number: 'AL-TWIN-1', website: 'https://twin-marine.example' } });
  const b = await env.signup({ role: 'employer_owner', org: { name: 'Twin Marine Limited', country: 'Albania', registration_number: 'al twin 1', website: 'https://www.twin-marine.example/about' } });
  const admin = await env.internal('admin');
  const queue = await env.api('GET', '/api/admin/approvals', { token: admin.token });
  const row = queue.body.find((u) => u.id === b.userId);
  assert.ok(row.potential_duplicate_of, 'second registration must be flagged as a potential duplicate');
  const mine = await env.api('GET', '/api/employer/company', { token: b.token });
  assert.equal(mine.body.potential_duplicate_of, undefined);
  assert.ok(a.userId);
});

test('public facets are derived from live data only', async () => {
  const f = await env.api('GET', '/api/public/facets');
  assert.equal(f.status, 200);
  const live = await env.db.rows(`SELECT DISTINCT country FROM jobs WHERE status='published'`);
  assert.deepEqual(Object.keys(f.body.countries).sort(), live.map((r) => r.country).filter(Boolean).sort());
});
