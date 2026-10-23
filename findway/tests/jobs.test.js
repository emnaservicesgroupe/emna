'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv } = require('./helpers');

let env;
before(async () => { env = await createTestEnv(); });
after(async () => { await env.close(); });

test('employer draft -> admin approval -> public listing (and not before)', async () => {
  const admin = await env.internal('admin');
  const emp = await env.signup({ role: 'employer_owner' });
  await env.api('POST', `/api/admin/users/${emp.userId}/approval`, { token: admin.token, body: { decision: 'approved' } });
  const draft = await env.draftJob(emp, { title: 'Pipe Fitter' });
  assert.equal(draft.status, 'draft');
  assert.match(draft.reference_no, /^FW-J-\d+$/);
  let pub = await env.api('GET', '/api/public/jobs?q=pipe');
  assert.equal(pub.body.total, 0); // drafts are invisible
  assert.equal((await env.api('GET', `/api/public/jobs/${draft.id}`)).status, 404);

  assert.equal((await env.api('POST', `/api/employer/jobs/${draft.id}/submit`, { token: emp.token })).status, 200);
  pub = await env.api('GET', '/api/public/jobs?q=pipe');
  assert.equal(pub.body.total, 0); // pending approval is still invisible

  // approval is blocked while the employer is unverified (policy), unless an override reason is recorded
  const blocked = await env.api('POST', `/api/admin/jobs/${draft.id}/review`, { token: admin.token, body: { decision: 'approve' } });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'employer_not_verified');

  const org = await env.db.one('SELECT o.id FROM organizations o JOIN memberships m ON m.org_id=o.id WHERE m.user_id=$1', [emp.userId]);
  await env.api('POST', '/api/employer/company/verification', { token: emp.token, body: { registration_number: 'AL-123456' } });
  await env.api('POST', `/api/admin/orgs/${org.id}/verification`, { token: admin.token, body: { decision: 'verified' } });
  // an employer cannot approve their own job
  assert.equal((await env.api('POST', `/api/admin/jobs/${draft.id}/review`, { token: emp.token, body: { decision: 'approve' } })).status, 403);
  const ok = await env.api('POST', `/api/admin/jobs/${draft.id}/review`, { token: admin.token, body: { decision: 'approve' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.status, 'published');

  pub = await env.api('GET', '/api/public/jobs?q=pipe');
  assert.equal(pub.body.total, 1);
  const detail = pub.body.items[0];
  assert.equal(detail.employer.verification_status, 'verified');
  assert.equal(detail.salary.specified, true); assert.equal(detail.salary.currency, 'EUR');
  assert.equal(detail.international_recruitment.open_to_international, null); // never inferred
  assert.equal(detail.international_recruitment.employer_confirmed_visa_support, null);
  assert.ok(detail.last_verified_at);
  assert.equal(detail.created_by, undefined); // internal fields are not exposed
  const byRef = await env.api('GET', `/api/public/jobs/${detail.reference_no}`);
  assert.equal(byRef.status, 200);
});

test('salary "not specified" is explicit, and incomplete or inconsistent jobs are rejected before review', async () => {
  const admin = await env.internal('admin');
  const emp = await env.signup({ role: 'employer_owner' });
  await env.api('POST', `/api/admin/users/${emp.userId}/approval`, { token: admin.token, body: { decision: 'approved' } });
  const thin = await env.api('POST', '/api/employer/jobs', { token: emp.token, body: { title: 'Cook' } });
  assert.equal(thin.status, 201);
  const sub = await env.api('POST', `/api/employer/jobs/${thin.body.id}/submit`, { token: emp.token });
  assert.equal(sub.status, 422); assert.equal(sub.body.error.code, 'job_incomplete');
  assert.ok(sub.body.error.details.missing.includes('requirements'));
  const bad = await env.api('POST', '/api/employer/jobs', { token: emp.token, body: { title: 'Cook', salary_specified: true, salary_min: 5, salary_max: 1, salary_currency: 'EUR', salary_period: 'month' } });
  assert.equal(bad.status, 422); assert.equal(bad.body.error.code, 'salary_range_invalid');
  const noTerms = await env.api('POST', '/api/employer/jobs', { token: emp.token, body: { title: 'Cook', salary_specified: true, salary_min: 5 } });
  assert.equal(noTerms.body.error.code, 'salary_terms_required');
});

test('material changes on a live job go back to review, are versioned, and notify applicants for acknowledgement', async () => {
  const { admin, emp, job } = await env.employerWithPublishedJob();
  const cand = await env.readyCandidate();
  const app = await env.api('POST', '/api/candidate/applications', { token: cand.token, body: { job_id: job.id } });
  assert.equal(app.status, 201);
  // non-material, live-safe edit: stays published
  const live = await env.api('PATCH', `/api/employer/jobs/${job.id}`, { token: emp.token, body: { vacancies: 5 } });
  assert.equal(live.body.status, 'published');
  // material edit: salary drops -> pulled for re-approval, hidden from the public until approved
  const edit = await env.api('PATCH', `/api/employer/jobs/${job.id}`, { token: emp.token, body: { salary_min: 2000, salary_max: 2500 } });
  assert.equal(edit.status, 200); assert.equal(edit.body.status, 'pending_approval');
  assert.equal((await env.api('GET', `/api/public/jobs/${job.id}`)).status, 404);
  const review = await env.api('GET', `/api/admin/jobs/${job.id}/review`, { token: admin.token });
  assert.deepEqual(review.body.pending_material_changes.map((c) => c.field).sort(), ['salary_max', 'salary_min']);
  const re = await env.api('POST', `/api/admin/jobs/${job.id}/review`, { token: admin.token, body: { decision: 'approve' } });
  assert.equal(re.status, 200);
  const versions = await env.api('GET', `/api/employer/jobs/${job.id}/versions`, { token: emp.token });
  assert.equal(versions.body.length, 2);
  assert.equal(versions.body[0].material_changes.length, 2);
  // the applicant was notified and must acknowledge
  const pending = await env.api('GET', '/api/candidate/job-changes', { token: cand.token });
  assert.equal(pending.body.length, 1);
  assert.deepEqual(pending.body[0].changes.map((c) => c.field).sort(), ['salary_max', 'salary_min']);
  const notes = await env.api('GET', '/api/notifications', { token: cand.token });
  assert.ok(notes.body.items.some((n) => n.type === 'job.terms_changed'));
  const ack = await env.api('POST', `/api/candidate/applications/${app.body.id}/job-changes/${pending.body[0].job_version}/ack`, { token: cand.token });
  assert.equal(ack.status, 200);
  assert.equal((await env.api('GET', '/api/candidate/job-changes', { token: cand.token })).body.length, 0);
  // acknowledgement is only possible once
  assert.equal((await env.api('POST', `/api/candidate/applications/${app.body.id}/job-changes/${pending.body[0].job_version}/ack`, { token: cand.token })).status, 404);
});

test('optimistic concurrency: stale job edits are rejected', async () => {
  const admin = await env.internal('admin');
  const emp = await env.signup({ role: 'employer_owner' });
  await env.api('POST', `/api/admin/users/${emp.userId}/approval`, { token: admin.token, body: { decision: 'approved' } });
  const job = await env.draftJob(emp);
  const a = await env.api('PATCH', `/api/employer/jobs/${job.id}`, { token: emp.token, body: { title: 'First edit', version: job.version } });
  assert.equal(a.status, 200);
  const b = await env.api('PATCH', `/api/employer/jobs/${job.id}`, { token: emp.token, body: { title: 'Stale edit', version: job.version } });
  assert.equal(b.status, 409); assert.equal(b.body.error.code, 'version_conflict');
});

test('employers cannot see or touch another company\'s jobs', async () => {
  const { job } = await env.employerWithPublishedJob();
  const { emp: other } = await env.employerWithPublishedJob();
  for (const [m, p, b] of [['GET', `/api/employer/jobs/${job.id}`], ['PATCH', `/api/employer/jobs/${job.id}`, { title: 'hijack' }], ['POST', `/api/employer/jobs/${job.id}/close`, { reason: 'x' }], ['GET', `/api/employer/jobs/${job.id}/applicants`], ['GET', `/api/employer/jobs/${job.id}/versions`]]) {
    const r = await env.api(m, p, { token: other.token, body: b });
    assert.equal(r.status, 404, `${m} ${p} leaked`);
  }
  const mine = await env.api('GET', '/api/employer/jobs', { token: other.token });
  assert.ok(!mine.body.some((j) => j.id === job.id));
});

test('public search: keyword, country, salary (needs currency+period), skills, languages, accommodation, closed/expired exclusion', async () => {
  const { admin, emp } = await env.employerWithPublishedJob({ jobOverrides: { title: 'Search Target Electrician', profession: 'Electrician', country: 'Italy', city: 'Milan', salary_min: 1800, salary_max: 2200, skills: ['wiring', 'plc'], languages: [{ code: 'it' }, { code: 'en' }], accommodation: 'allowance' } });
  const s = (qs) => env.api('GET', `/api/public/jobs?${qs}`);
  assert.equal((await s('q=target+electrician')).body.total, 1);
  assert.equal((await s('country=italy&profession=Electrician')).body.total, 1);
  assert.equal((await s('country=Japan')).body.total, 0);
  assert.equal((await s('skills=wiring,plc&languages=it')).body.total, 1);
  assert.equal((await s('skills=welding&country=Italy')).body.total, 0);
  assert.equal((await s('accommodation=true&country=Italy')).body.total, 1);
  assert.equal((await s('salary_min=1900&salary_currency=EUR&salary_period=month&country=Italy')).body.total, 1);
  assert.equal((await s('salary_min=2500&salary_currency=EUR&salary_period=month&country=Italy')).body.total, 0);
  assert.equal((await s('salary_min=1900&country=Italy')).status, 400); // needs currency + period
  assert.equal((await s('salary_min=1900&salary_currency=USD&salary_period=month&country=Italy')).body.total, 0);
  // wildcard characters are literal
  assert.equal((await s('q=%25')).body.total, 0);
  // an expired job disappears from search and closes via the worker
  const job2 = await env.draftJob(emp, { title: 'Short Lived', deadline: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) });
  await env.api('POST', `/api/employer/jobs/${job2.id}/submit`, { token: emp.token });
  await env.api('POST', `/api/admin/jobs/${job2.id}/review`, { token: admin.token, body: { decision: 'approve' } });
  assert.equal((await s('q=short+lived')).body.total, 1);
  env.clock.advance(4 * 86400000);
  assert.equal((await s('q=short+lived')).body.total, 0);
  assert.equal(await require('../src/services/jobs').closeExpired(env.ctx), 1);
  assert.equal((await env.db.one('SELECT status FROM jobs WHERE id=$1', [job2.id])).status, 'closed');
});

test('company directory only lists verified, opted-in employers and hides internal fields', async () => {
  const { emp, org } = await env.employerWithPublishedJob();
  assert.equal((await env.api('GET', `/api/public/companies/${org.id}`)).status, 404); // not opted in yet
  await env.api('PATCH', '/api/employer/company', { token: emp.token, body: { public_profile: true, description: 'Shipyard' } });
  const r = await env.api('GET', `/api/public/companies/${org.id}`);
  assert.equal(r.status, 200); assert.equal(r.body.verification_status, 'verified');
  assert.equal(r.body.owner_user_id, undefined); assert.equal(r.body.introduced_by, undefined); assert.equal(r.body.registration_number, undefined);
  const list = await env.api('GET', '/api/public/companies');
  assert.ok(list.body.some((c) => c.id === org.id && c.open_jobs >= 1));
});

test('closing a job closes open applications with a recorded reason and keeps selected candidates', async () => {
  const { emp, job } = await env.employerWithPublishedJob();
  const cand = await env.readyCandidate();
  const app = await env.api('POST', '/api/candidate/applications', { token: cand.token, body: { job_id: job.id } });
  const noReason = await env.api('POST', `/api/employer/jobs/${job.id}/close`, { token: emp.token, body: {} });
  assert.equal(noReason.status, 422);
  assert.equal((await env.api('POST', `/api/employer/jobs/${job.id}/close`, { token: emp.token, body: { reason: 'filled' } })).status, 200);
  const a = await env.api('GET', `/api/candidate/applications/${app.body.id}`, { token: cand.token });
  assert.equal(a.body.stage, 'position_closed');
  const apply2 = await env.readyCandidate();
  const late = await env.api('POST', '/api/candidate/applications', { token: apply2.token, body: { job_id: job.id } });
  assert.equal(late.status, 409); assert.equal(late.body.error.code, 'job_not_open');
});
