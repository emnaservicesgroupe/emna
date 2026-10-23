'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv } = require('./helpers');

let env;
before(async () => { env = await createTestEnv(); });
after(async () => { await env.close(); });

const apply = (c, jobId, extra = {}) => env.api('POST', '/api/candidate/applications', { token: c.token, body: { job_id: jobId, ...extra.body }, headers: extra.headers });

test('candidate must complete the profile before applying', async () => {
  const { job } = await env.employerWithPublishedJob();
  const bare = await env.signup({ role: 'candidate' });
  const r = await apply(bare, job.id);
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'profile_incomplete');
  assert.ok(r.body.error.details.missing.includes('phone'));
  const bad = await env.api('PATCH', '/api/candidate/profile', { token: bare.token, body: { phone: '0691234567' } });
  assert.equal(bad.body.error.code, 'invalid_phone'); // only international format is comparable
});

test('application -> CRM lead -> qualification: one person, no duplicates, full history', async () => {
  const { job } = await env.employerWithPublishedJob();
  const staff = await env.internal('staff');
  const cand = await env.readyCandidate();
  const a = await apply(cand, job.id, { body: { cover_note: 'Available immediately' } });
  assert.equal(a.status, 201); assert.equal(a.body.stage, 'submitted');

  const lead = (await env.api('GET', '/api/staff/leads?assigned=unassigned', { token: staff.token })).body.find((l) => l.application_ref === a.body.reference_no);
  assert.ok(lead, 'application must land in the CRM leads queue');
  assert.equal(lead.status, 'received');
  const detail = await env.api('GET', `/api/staff/leads/${lead.id}`, { token: staff.token });
  assert.equal(detail.body.snapshot.full_name, 'Amina Candidate');

  assert.equal((await env.api('POST', `/api/staff/leads/${lead.id}/claim`, { token: staff.token })).status, 200);
  const q = await env.api('POST', `/api/staff/leads/${lead.id}/qualify`, { token: staff.token, body: {} });
  assert.equal(q.status, 200); assert.equal(q.body.lead.status, 'qualified');
  const people = await env.db.one(`SELECT count(*)::int AS n FROM candidates WHERE email_norm=$1`, [cand.email.toLowerCase()]);
  assert.equal(people.n, 1); // qualification linked, did not duplicate
  assert.equal(q.body.candidate_id, cand.candidateId);

  const own = await env.api('GET', `/api/candidate/applications/${a.body.id}`, { token: cand.token });
  assert.equal(own.body.stage, 'under_review');
  assert.deepEqual(own.body.history.map((h) => h.to_stage), ['submitted', 'under_review']);
  const ev = await env.db.one(`SELECT count(*)::int AS n FROM outbox_events WHERE type IN ('lead.created','lead.qualified','application.submitted')`);
  assert.ok(ev.n >= 3);
  // qualifying twice is refused
  const again = await env.api('POST', `/api/staff/leads/${lead.id}/qualify`, { token: staff.token, body: {} });
  assert.equal(again.status, 409);
});

test('duplicate submission protection: active duplicate, idempotency key replay, reapplication policy', async () => {
  const { job } = await env.employerWithPublishedJob();
  const cand = await env.readyCandidate();
  const k = { headers: { 'idempotency-key': 'abc-123' } };
  const first = await apply(cand, job.id, k);
  const replay = await apply(cand, job.id, k);
  assert.equal(first.status, 201); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.id, first.body.id);
  const dup = await apply(cand, job.id);
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'already_applied');
  // concurrent identical submissions create exactly one application
  const cand2 = await env.readyCandidate();
  const rs = await Promise.all([apply(cand2, job.id), apply(cand2, job.id), apply(cand2, job.id)]);
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal((await env.db.one('SELECT count(*)::int AS n FROM applications WHERE candidate_id=$1', [cand2.candidateId])).n, 1);
  // withdrawal needs a reason; reapplication only when the job allows it
  assert.equal((await env.api('POST', `/api/candidate/applications/${first.body.id}/withdraw`, { token: cand.token, body: {} })).status, 422);
  assert.equal((await env.api('POST', `/api/candidate/applications/${first.body.id}/withdraw`, { token: cand.token, body: { reason: 'Found another job' } })).status, 200);
  const re = await apply(cand, job.id);
  assert.equal(re.status, 409); assert.equal(re.body.error.code, 'reapplication_not_allowed');
  await env.db.query('UPDATE jobs SET allow_reapplication=true WHERE id=$1', [job.id]);
  assert.equal((await apply(cand, job.id)).status, 201);
});

test('uncertain duplicates (same phone, different email) need a human decision; name alone never matches', async () => {
  const { job } = await env.employerWithPublishedJob();
  const staff = await env.internal('staff');
  // existing person created earlier by staff intake with the same phone
  const old = await env.db.one(`INSERT INTO candidates (full_name, name_norm, email, email_norm, phone, phone_norm, source) VALUES ('A. Candidate','a candidate','amina.old@example.test','amina.old@example.test','+355691112233','+355691112233','manual') RETURNING id`);
  const cand = await env.readyCandidate({ phone: '+355 69 111 2233' });
  const a = await apply(cand, job.id);
  const lead = (await env.api('GET', '/api/staff/leads?assigned=unassigned', { token: staff.token })).body.find((l) => l.application_ref === a.body.reference_no);
  await env.api('POST', `/api/staff/leads/${lead.id}/claim`, { token: staff.token });
  const blocked = await env.api('POST', `/api/staff/leads/${lead.id}/qualify`, { token: staff.token, body: {} });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'duplicate_review_required');
  assert.deepEqual(blocked.body.error.details.reviews[0].reasons, ['phone']);
  assert.equal((await env.db.one('SELECT status FROM leads WHERE id=$1', [lead.id])).status, 'received'); // nothing was merged or qualified
  assert.equal((await env.db.one('SELECT count(*)::int AS n FROM candidates WHERE merged_into IS NOT NULL')).n, 0);
  // keep-separate needs a recorded reason
  const noReason = await env.api('POST', `/api/staff/leads/${lead.id}/qualify`, { token: staff.token, body: { resolution: { action: 'keep_separate' } } });
  assert.equal(noReason.status, 422);
  const merged = await env.api('POST', `/api/staff/leads/${lead.id}/qualify`, { token: staff.token, body: { resolution: { action: 'merge_into', candidate_id: old.id, note: 'Same person, old intake record' } } });
  assert.equal(merged.status, 200); assert.equal(merged.body.candidate_id, old.id);
  const kept = await env.db.one('SELECT user_id FROM candidates WHERE id=$1', [old.id]);
  assert.equal(kept.user_id, cand.userId); // account moved onto the surviving record
  assert.equal((await env.db.one('SELECT candidate_id FROM applications WHERE id=$1', [a.body.id])).candidate_id, old.id);
  assert.equal((await env.db.one('SELECT merged_into FROM candidates WHERE id=$1', [cand.candidateId])).merged_into, old.id);

  // same name only: no flag at all
  const cand2 = await env.readyCandidate({ full_name: 'Amina Candidate', phone: '+355 69 999 0000' });
  const a2 = await apply(cand2, job.id);
  const lead2 = (await env.api('GET', '/api/staff/leads?assigned=unassigned', { token: staff.token })).body.find((l) => l.application_ref === a2.body.reference_no);
  await env.api('POST', `/api/staff/leads/${lead2.id}/claim`, { token: staff.token });
  assert.equal((await env.api('POST', `/api/staff/leads/${lead2.id}/qualify`, { token: staff.token, body: {} })).status, 200);
});

test('registering with an email a staff member already entered claims that record after OTP proof, instead of duplicating', async () => {
  const pre = await env.db.one(`INSERT INTO candidates (full_name, name_norm, email, email_norm, source) VALUES ('Pre Entered','pre entered','pre@example.test','pre@example.test','manual') RETURNING id`);
  const c = await env.signup({ role: 'candidate', email: 'pre@example.test', full_name: 'Pre Entered' });
  const rows = await env.db.rows(`SELECT id, user_id FROM candidates WHERE email_norm='pre@example.test'`);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, pre.id); assert.equal(rows[0].user_id, c.userId);
});

test('missing information loop: staff request -> candidate response -> back under review; rejection needs a reason', async () => {
  const { job } = await env.employerWithPublishedJob();
  const staff = await env.internal('staff'); const cand = await env.readyCandidate();
  const a = await apply(cand, job.id);
  const lead = (await env.api('GET', '/api/staff/leads?assigned=unassigned', { token: staff.token })).body.find((l) => l.application_ref === a.body.reference_no);
  const noMsg = await env.api('POST', `/api/staff/leads/${lead.id}/status`, { token: staff.token, body: { to: 'missing_information' } });
  assert.equal(noMsg.status, 422);
  assert.equal((await env.api('POST', `/api/staff/leads/${lead.id}/status`, { token: staff.token, body: { to: 'missing_information', message: 'Please add your welding certificates' } })).status, 200);
  const mid = await env.api('GET', `/api/candidate/applications/${a.body.id}`, { token: cand.token });
  assert.equal(mid.body.stage, 'missing_information');
  assert.equal(mid.body.history.at(-1).message, 'Please add your welding certificates');
  assert.equal((await env.api('POST', `/api/candidate/applications/${a.body.id}/respond`, { token: cand.token, body: { message: 'Certificates added to my profile' } })).status, 200);
  assert.equal((await env.api('GET', `/api/candidate/applications/${a.body.id}`, { token: cand.token })).body.stage, 'under_review');
  const rej = await env.api('POST', `/api/staff/leads/${lead.id}/status`, { token: staff.token, body: { to: 'rejected' } });
  assert.equal(rej.status, 422); assert.equal(rej.body.error.code, 'reason_required');
  assert.equal((await env.api('POST', `/api/staff/leads/${lead.id}/status`, { token: staff.token, body: { to: 'rejected', reason: 'Not enough experience' } })).status, 200);
  const final = await env.api('GET', `/api/candidate/applications/${a.body.id}`, { token: cand.token });
  assert.equal(final.body.stage, 'rejected');
  assert.equal(final.body.stage_reason_public, null); // internal rejection reasons are not shown to the candidate
});

test('internal notes never reach candidates or employers; employers see a minimised applicant view', async () => {
  const { emp, job } = await env.employerWithPublishedJob({ mode: 'managed' });
  const staff = await env.internal('staff'); const cand = await env.readyCandidate({ profile: { date_of_birth: '1990-01-01' } });
  const a = await apply(cand, job.id);
  const lead = (await env.api('GET', '/api/staff/leads?assigned=unassigned', { token: staff.token })).body.find((l) => l.application_ref === a.body.reference_no);
  await env.api('POST', `/api/staff/leads/${lead.id}/claim`, { token: staff.token });
  assert.equal((await env.api('POST', '/api/staff/notes', { token: staff.token, body: { entity_type: 'application', entity_id: a.body.id, body: 'SECRET: agency pricing discussed, weak English' } })).status, 201);
  // before qualification the employer sees nothing
  assert.deepEqual((await env.api('GET', `/api/employer/jobs/${job.id}/applicants`, { token: emp.token })).body, []);
  await env.api('POST', `/api/staff/leads/${lead.id}/qualify`, { token: staff.token, body: {} });
  const list = await env.api('GET', `/api/employer/jobs/${job.id}/applicants`, { token: emp.token });
  assert.equal(list.body.length, 1);
  const row = list.body[0];
  assert.equal(row.candidate.full_name, 'Amina Candidate');
  assert.equal(row.candidate.email, undefined); assert.equal(row.candidate.phone, undefined); // managed mode: contact withheld
  const blob = JSON.stringify(row);
  for (const leak of ['SECRET', 'date_of_birth', '1990-01-01', 'passport', 'owner_user_id', cand.email]) assert.ok(!blob.includes(leak), `employer view leaked ${leak}`);
  const own = JSON.stringify((await env.api('GET', `/api/candidate/applications/${a.body.id}`, { token: cand.token })).body);
  assert.ok(!own.includes('SECRET'));
  // staff can disclose contact; direct-mode companies disclose on release
  await env.api('POST', `/api/staff/applications/${a.body.id}/release`, { token: staff.token, body: { release: true, disclose_contact: true } });
  const after = (await env.api('GET', `/api/employer/applications/${a.body.id}`, { token: emp.token })).body;
  assert.equal(after.candidate.email, cand.email);
});

test('employer actions: shortlist directly; interview/selection are requests staff must confirm; selection is not a placement', async () => {
  const { emp, job } = await env.employerWithPublishedJob({ mode: 'managed' });
  const staff = await env.internal('staff'); const cand = await env.readyCandidate();
  const a = await apply(cand, job.id);
  const lead = (await env.api('GET', '/api/staff/leads?assigned=unassigned', { token: staff.token })).body.find((l) => l.application_ref === a.body.reference_no);
  await env.api('POST', `/api/staff/leads/${lead.id}/claim`, { token: staff.token });
  await env.api('POST', `/api/staff/leads/${lead.id}/qualify`, { token: staff.token, body: {} });
  const act = (action, body = {}) => env.api('POST', `/api/employer/applications/${a.body.id}/${action}`, { token: emp.token, body });
  assert.equal((await act('shortlist')).body.stage, 'shortlisted');
  const iv = await act('request_interview', { note: 'Tuesday?' });
  assert.equal(iv.status, 200); assert.equal(iv.body.request.status, 'pending'); assert.equal(iv.body.stage, 'shortlisted'); // not yet an interview
  assert.equal((await act('request_interview')).status, 409); // duplicate pending request
  const reqs = (await env.api('GET', '/api/staff/requests', { token: staff.token })).body;
  const req = reqs.find((r) => r.application_id === a.body.id);
  assert.equal((await env.api('POST', `/api/staff/requests/${req.id}`, { token: staff.token, body: { decision: 'decline' } })).status, 422);
  assert.equal((await env.api('POST', `/api/staff/requests/${req.id}`, { token: staff.token, body: { decision: 'approve' } })).body.stage, 'interview_requested');
  const sel = await act('request_selection', { note: 'We want her' });
  assert.equal(sel.body.stage, 'interview_requested'); // requesting selection does NOT select
  assert.equal((await env.db.one('SELECT count(*)::int AS n FROM recruitment_cases')).n, 0);
  const selReq = (await env.api('GET', '/api/staff/requests', { token: staff.token })).body.find((r) => r.type === 'selection');
  const done = await env.api('POST', `/api/staff/requests/${selReq.id}`, { token: staff.token, body: { decision: 'approve' } });
  assert.equal(done.body.stage, 'selected');
  // only staff can open the case; it then begins at "offer"
  const kase = await env.api('POST', '/api/staff/cases', { token: staff.token, body: { application_id: a.body.id } });
  assert.equal(kase.status, 201); assert.equal(kase.body.stage, 'offer');
  assert.equal((await env.api('POST', '/api/staff/cases', { token: staff.token, body: { application_id: a.body.id } })).status, 409);
  const back = await env.api('POST', `/api/staff/cases/${kase.body.id}/stage`, { token: staff.token, body: { stage: 'documents' } });
  assert.equal(back.body.stage, 'documents');
  assert.equal((await env.api('POST', `/api/staff/cases/${kase.body.id}/stage`, { token: staff.token, body: { stage: 'offer' } })).status, 422); // reversal needs a reason
  assert.equal((await env.api('POST', `/api/staff/cases/${kase.body.id}/stage`, { token: staff.token, body: { stage: 'offer', reason: 'Employer revised the offer' } })).status, 200);
  const own = await env.api('GET', `/api/candidate/applications/${a.body.id}`, { token: cand.token });
  assert.equal(own.body.case.stage, 'offer');
});

test('direct-hiring employers move candidates themselves and see contact details; rejection needs a reason', async () => {
  const { emp, job } = await env.employerWithPublishedJob({ mode: 'direct' });
  const staff = await env.internal('staff'); const cand = await env.readyCandidate();
  const a = await apply(cand, job.id);
  const lead = (await env.api('GET', '/api/staff/leads?assigned=unassigned', { token: staff.token })).body.find((l) => l.application_ref === a.body.reference_no);
  await env.api('POST', `/api/staff/leads/${lead.id}/claim`, { token: staff.token });
  await env.api('POST', `/api/staff/leads/${lead.id}/qualify`, { token: staff.token, body: {} });
  const seen = (await env.api('GET', `/api/employer/applications/${a.body.id}`, { token: emp.token })).body;
  assert.equal(seen.candidate.phone, cand.phone);
  assert.equal((await env.api('POST', `/api/employer/applications/${a.body.id}/request_interview`, { token: emp.token, body: {} })).body.stage, 'interview_requested');
  assert.equal((await env.api('POST', `/api/employer/applications/${a.body.id}/reject`, { token: emp.token, body: {} })).status, 422);
  assert.equal((await env.api('POST', `/api/employer/applications/${a.body.id}/reject`, { token: emp.token, body: { reason: 'Position filled' } })).body.stage, 'rejected');
});

test('isolation: candidates, employers, agencies and unassigned staff cannot reach records that are not theirs', async () => {
  const { emp, job } = await env.employerWithPublishedJob({ mode: 'direct' });
  const { emp: otherEmp } = await env.employerWithPublishedJob();
  const staffA = await env.internal('staff'); const staffB = await env.internal('staff'); const admin = await env.internal('admin');
  const c1 = await env.readyCandidate(); const c2 = await env.readyCandidate({ phone: '+355 69 555 0101' });
  const a1 = await apply(c1, job.id);
  const lead = (await env.api('GET', '/api/staff/leads?assigned=unassigned', { token: staffA.token })).body.find((l) => l.application_ref === a1.body.reference_no);
  await env.api('POST', `/api/staff/leads/${lead.id}/claim`, { token: staffA.token });
  await env.api('POST', `/api/staff/leads/${lead.id}/qualify`, { token: staffA.token, body: {} });

  // candidate vs candidate
  assert.equal((await env.api('GET', `/api/candidate/applications/${a1.body.id}`, { token: c2.token })).status, 404);
  assert.equal((await env.api('POST', `/api/candidate/applications/${a1.body.id}/withdraw`, { token: c2.token, body: { reason: 'x' } })).status, 404);
  assert.deepEqual((await env.api('GET', '/api/candidate/applications', { token: c2.token })).body, []);
  // employer vs employer
  assert.equal((await env.api('GET', `/api/employer/applications/${a1.body.id}`, { token: otherEmp.token })).status, 404);
  assert.equal((await env.api('POST', `/api/employer/applications/${a1.body.id}/shortlist`, { token: otherEmp.token, body: {} })).status, 404);
  // candidates and employers are not staff
  for (const t of [c1.token, emp.token]) { assert.equal((await env.api('GET', '/api/staff/leads', { token: t })).status, 403); assert.equal((await env.api('GET', '/api/admin/audit', { token: t })).status, 403); }
  // staff B (not assigned) cannot open A's lead/candidate/application, nor see them in lists; admin can
  assert.equal((await env.api('GET', `/api/staff/leads/${lead.id}`, { token: staffB.token })).status, 404);
  assert.equal((await env.api('GET', `/api/staff/candidates/${c1.candidateId}`, { token: staffB.token })).status, 404);
  assert.equal((await env.api('GET', `/api/staff/applications/${a1.body.id}`, { token: staffB.token })).status, 404);
  assert.ok(!(await env.api('GET', '/api/staff/candidates', { token: staffB.token })).body.some((c) => c.id === c1.candidateId));
  assert.equal((await env.api('GET', `/api/staff/candidates/${c1.candidateId}`, { token: staffA.token })).status, 200);
  assert.equal((await env.api('GET', `/api/staff/candidates/${c1.candidateId}`, { token: admin.token })).status, 200);
  // audited reassignment: B gains access, A loses it, history keeps both
  assert.equal((await env.api('POST', '/api/staff/reassign', { token: staffA.token, body: { entity_type: 'candidate', entity_id: c1.candidateId, to_user_id: staffB.userId, reason: 'x' } })).status, 403);
  const re = await env.api('POST', '/api/staff/reassign', { token: admin.token, body: { entity_type: 'candidate', entity_id: c1.candidateId, to_user_id: staffB.userId, reason: 'Territory change' } });
  assert.equal(re.status, 200);
  assert.equal((await env.api('GET', `/api/staff/candidates/${c1.candidateId}`, { token: staffB.token })).status, 200);
  const hist = await env.db.rows(`SELECT from_user, to_user FROM ownership_history WHERE entity_type='candidate' AND entity_id=$1 ORDER BY created_at`, [c1.candidateId]);
  assert.equal(hist.at(-1).from_user, staffA.userId); assert.equal(hist.at(-1).to_user, staffB.userId);
  assert.equal((await env.api('POST', '/api/staff/reassign', { token: admin.token, body: { entity_type: 'candidate', entity_id: c1.candidateId, to_user_id: c2.userId, reason: 'x' } })).status, 422); // only staff can be assignees
  // unauthenticated and malformed
  assert.equal((await env.api('GET', '/api/candidate/profile')).status, 401);
  assert.equal((await env.api('GET', '/api/staff/leads/not-a-uuid', { token: admin.token })).status, 400);
});

test('introduced_by attribution is immutable even through reassignment and direct SQL', async () => {
  const staffA = await env.internal('staff'); const staffB = await env.internal('staff'); const admin = await env.internal('admin');
  const made = await env.api('POST', '/api/staff/companies', { token: staffA.token, body: { name: 'Discovered Shipyard Ltd', country: 'Albania', source: 'trade fair', website: 'https://shipyard.example' } });
  assert.equal(made.status, 201);
  assert.equal(made.body.introduced_by, staffA.userId); assert.equal(made.body.claimed, false);
  const dup = await env.api('POST', '/api/staff/companies', { token: staffB.token, body: { name: 'Discovered Shipyard Ltd' } });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'possible_duplicate');
  await env.api('POST', '/api/staff/reassign', { token: admin.token, body: { entity_type: 'organization', entity_id: made.body.id, to_user_id: staffB.userId, reason: 'Account handover' } });
  const org = await env.db.one('SELECT introduced_by, owner_user_id FROM organizations WHERE id=$1', [made.body.id]);
  assert.equal(org.introduced_by, staffA.userId); assert.equal(org.owner_user_id, staffB.userId);
  await assert.rejects(env.db.query('UPDATE organizations SET introduced_by=$2 WHERE id=$1', [made.body.id, staffB.userId]), /immutable/);
  // staff only see their own companies
  assert.equal((await env.api('GET', `/api/staff/companies/${made.body.id}`, { token: staffA.token })).status, 404);
  assert.equal((await env.api('GET', `/api/staff/companies/${made.body.id}`, { token: staffB.token })).status, 200);
});

test('consent withdrawal is recorded and emitted; data export/deletion requests are tracked once', async () => {
  const c = await env.readyCandidate();
  assert.equal((await env.api('PUT', '/api/candidate/consents/marketing', { token: c.token, body: { granted: true } })).status, 200);
  assert.equal((await env.api('PUT', '/api/candidate/consents/marketing', { token: c.token, body: { granted: false } })).status, 200);
  assert.equal((await env.db.one(`SELECT count(*)::int AS n FROM outbox_events WHERE type='consent.revoked' AND aggregate_id=$1`, [c.candidateId])).n, 1);
  assert.equal((await env.api('PUT', '/api/candidate/consents/terms', { token: c.token, body: { granted: false } })).status, 400);
  assert.equal((await env.api('POST', '/api/candidate/data-requests', { token: c.token, body: { type: 'deletion' } })).status, 201);
  assert.equal((await env.api('POST', '/api/candidate/data-requests', { token: c.token, body: { type: 'deletion' } })).status, 409);
});
