'use strict';
const { E } = require('../lib/errors');
const P = require('../permissions');
const { audit } = require('./audit');
const { emit } = require('./outbox');
const { notify } = require('./notifications');
const candidates = require('./candidates');
const leads = require('./leads');
const orgs = require('./organizations');

const TERMINAL = ['rejected', 'withdrawn', 'position_closed'];
const RANK = { submitted: 0, under_review: 1, shortlisted: 2, interview_requested: 3, interview_scheduled: 4, selected: 5 };
const TRANSITIONS = {
  submitted: ['under_review', 'missing_information', 'rejected', 'withdrawn', 'position_closed'],
  under_review: ['missing_information', 'shortlisted', 'interview_requested', 'rejected', 'withdrawn', 'position_closed'],
  missing_information: ['under_review', 'rejected', 'withdrawn', 'position_closed'],
  shortlisted: ['under_review', 'interview_requested', 'rejected', 'withdrawn', 'position_closed'],
  interview_requested: ['shortlisted', 'interview_scheduled', 'rejected', 'withdrawn', 'position_closed'],
  interview_scheduled: ['interview_requested', 'selected', 'rejected', 'withdrawn', 'position_closed'],
  selected: ['rejected', 'withdrawn'],
  rejected: [], withdrawn: [], position_closed: [],
};
const isReversal = (from, to) => RANK[from] !== undefined && RANK[to] !== undefined && RANK[to] < RANK[from];

// Single place where an application's stage changes. Records history, notifies, emits the integration event.
async function changeStage(q, actor, app, to, { reason = null, message = null, visibility = 'public', notifyCandidate = true } = {}) {
  const from = app.stage;
  if (!TRANSITIONS[from]?.includes(to)) throw E.conflict('invalid_transition', `Cannot move an application from ${from} to ${to}`, { from, to, allowed: TRANSITIONS[from] });
  if ((['rejected', 'withdrawn', 'position_closed'].includes(to) || isReversal(from, to)) && !reason) {
    throw E.unprocessable('reason_required', 'A reason is required for rejection, cancellation or reversing a stage');
  }
  const row = await q.one(
    `UPDATE applications SET stage=$2, stage_reason=$3, updated_at=now(), version=version+1 WHERE id=$1 AND stage=$4 RETURNING *`, [app.id, to, reason, from]);
  if (!row) throw E.conflict('stale_stage', 'The application was changed by someone else. Reload and retry.');
  await q.query(
    `INSERT INTO application_events (application_id, from_stage, to_stage, actor_user_id, actor_role, reason, message, visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [app.id, from, to, actor?.userId || null, actor?.role || 'system', reason, message, visibility]);
  if (notifyCandidate && visibility === 'public') {
    const c = await q.one('SELECT user_id FROM candidates WHERE id=$1', [app.candidate_id]);
    await notify(q, c?.user_id, 'application.status', { application_id: app.id, stage: to, message }, `app-stage:${app.id}:${row.version}`);
  }
  await emit(q, actor, { type: 'application.status_changed', aggregateType: 'application', aggregateId: app.id, aggregateVersion: row.version, data: { from, to } });
  return row;
}

// ───────────── candidate side ─────────────
async function apply(ctx, actor, { job_id, cover_note }, idempotencyKey) {
  P.require(actor, 'applications:apply');
  const cand = await ctx.db.one('SELECT * FROM candidates WHERE user_id=$1', [actor.userId]);
  if (!cand) throw E.notFound('candidate profile');
  if (idempotencyKey) {
    const prior = await ctx.db.one('SELECT * FROM applications WHERE submitted_by_user=$1 AND idempotency_key=$2', [actor.userId, idempotencyKey]);
    if (prior) return { application: prior, replayed: true };
  }
  const completion = candidates.completion(cand);
  if (!completion.ready_to_apply) throw E.unprocessable('profile_incomplete', 'Complete your profile before applying', { missing: completion.missing_required });
  const today = ctx.clock.now().toISOString().slice(0, 10);
  try {
    const app = await ctx.db.tx(async (q) => {
      const job = await q.one(`SELECT * FROM jobs WHERE id=$1 FOR SHARE`, [job_id]);
      if (!job || job.status !== 'published' || (job.deadline && job.deadline < today)) throw E.conflict('job_not_open', 'This job is not open for applications');
      const prior = await q.one('SELECT id, stage FROM applications WHERE candidate_id=$1 AND job_id=$2 ORDER BY created_at DESC LIMIT 1', [cand.id, job_id]);
      if (prior && !TERMINAL.includes(prior.stage)) throw E.conflict('already_applied', 'You already have an active application for this job', { application_id: prior.id });
      if (prior && !job.allow_reapplication) throw E.conflict('reapplication_not_allowed', 'This employer does not accept a new application after a previous one has ended', { application_id: prior.id });
      const snapshot = candidates.snapshotOf(cand);
      const app = await q.one(
        `INSERT INTO applications (job_id, candidate_id, submitted_by_user, cover_note, profile_snapshot, job_version, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [job_id, cand.id, actor.userId, cover_note || null, JSON.stringify(snapshot), job.published_version, idempotencyKey || null]);
      await q.query(`INSERT INTO application_events (application_id, from_stage, to_stage, actor_user_id, actor_role) VALUES ($1,NULL,'submitted',$2,$3)`, [app.id, actor.userId, actor.role]);
      const lead = await leads.createFromApplication(q, actor, app, cand, snapshot);
      await audit(q, actor, { action: 'application.submitted', entityType: 'application', entityId: app.id, details: { job_id, lead_id: lead.id } });
      await emit(q, actor, { type: 'application.submitted', aggregateType: 'application', aggregateId: app.id, aggregateVersion: app.version, data: { job_id, candidate_id: cand.id } });
      await emit(q, actor, { type: 'lead.created', aggregateType: 'lead', aggregateId: lead.id, aggregateVersion: lead.version, data: { application_id: app.id } });
      return app;
    });
    return { application: app, replayed: false };
  } catch (err) {
    if (err.code === '23505') { // lost a race with ourselves: report as the duplicate it is
      if (String(err.constraint).includes('idem')) {
        const prior = await ctx.db.one('SELECT * FROM applications WHERE submitted_by_user=$1 AND idempotency_key=$2', [actor.userId, idempotencyKey]);
        return { application: prior, replayed: true };
      }
      throw E.conflict('already_applied', 'You already have an active application for this job');
    }
    throw err;
  }
}

const ownRow = (r) => ({
  id: r.id, reference_no: r.reference_no, stage: r.stage, stage_reason_public: r.stage === 'rejected' ? null : r.stage_reason, cover_note: r.cover_note,
  created_at: r.created_at, updated_at: r.updated_at,
  job: { id: r.job_id, reference_no: r.job_ref, title: r.job_title, status: r.job_status, employer: r.employer_name, country: r.job_country, city: r.job_city },
});

async function listOwn(ctx, actor) {
  P.require(actor, 'applications:own');
  const rows = await ctx.db.rows(
    `SELECT a.*, j.reference_no AS job_ref, j.title AS job_title, j.status AS job_status, j.country AS job_country, j.city AS job_city, o.name AS employer_name
       FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id JOIN organizations o ON o.id=j.org_id
      WHERE c.user_id=$1 ORDER BY a.created_at DESC`, [actor.userId]);
  return rows.map(ownRow);
}
async function loadOwn(ctx, actor, id) {
  const r = await ctx.db.one(
    `SELECT a.*, j.reference_no AS job_ref, j.title AS job_title, j.status AS job_status, j.country AS job_country, j.city AS job_city, o.name AS employer_name
       FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id JOIN organizations o ON o.id=j.org_id
      WHERE a.id=$1 AND c.user_id=$2`, [id, actor.userId]);
  if (!r) throw E.notFound('application');
  return r;
}
async function getOwn(ctx, actor, id) {
  P.require(actor, 'applications:own');
  const r = await loadOwn(ctx, actor, id);
  const history = await ctx.db.rows(
    `SELECT from_stage, to_stage, message, created_at FROM application_events WHERE application_id=$1 AND visibility='public' ORDER BY created_at ASC`, [id]);
  const ack = await ctx.db.rows(`SELECT job_version, changes, notified_at, acknowledged_at FROM job_change_acks WHERE application_id=$1 ORDER BY job_version`, [id]);
  const c = await ctx.db.one(`SELECT stage, reference_no FROM recruitment_cases WHERE application_id=$1`, [id]);
  return { ...ownRow(r), history, job_changes: ack, case: c ? { reference_no: c.reference_no, stage: c.stage } : null };
}
async function withdraw(ctx, actor, id, { reason }) {
  P.require(actor, 'applications:own');
  const r = await loadOwn(ctx, actor, id);
  return ctx.db.tx(async (q) => {
    const app = await q.one('SELECT * FROM applications WHERE id=$1 FOR UPDATE', [id]);
    const row = await changeStage(q, actor, app, 'withdrawn', { reason, notifyCandidate: false });
    await q.query(`UPDATE leads SET status = CASE WHEN status='qualified' THEN status ELSE 'rejected' END, status_reason=COALESCE(status_reason,'withdrawn_by_candidate'), updated_at=now() WHERE application_id=$1 AND status <> 'rejected'`, [id]);
    await audit(q, actor, { action: 'application.withdrawn', entityType: 'application', entityId: id, details: { reason } });
    return { id: row.id, stage: row.stage, reference_no: r.reference_no };
  });
}
async function respondToRequest(ctx, actor, id, { message }) {
  P.require(actor, 'applications:own');
  await loadOwn(ctx, actor, id);
  return ctx.db.tx(async (q) => {
    const app = await q.one('SELECT * FROM applications WHERE id=$1 FOR UPDATE', [id]);
    if (app.stage !== 'missing_information') throw E.conflict('nothing_requested', 'No information is currently requested for this application');
    const row = await changeStage(q, actor, app, 'under_review', { message, visibility: 'public', notifyCandidate: false });
    await q.query(`UPDATE leads SET status='under_review', updated_at=now(), version=version+1 WHERE application_id=$1 AND status='missing_information'`, [id]);
    await q.query(`INSERT INTO internal_notes (entity_type, entity_id, author_id, body) VALUES ('application',$1,$2,$3)`, [id, actor.userId, `Candidate response: ${message}`]);
    await audit(q, actor, { action: 'application.info_provided', entityType: 'application', entityId: id });
    return { id: row.id, stage: row.stage };
  });
}

// ───────────── staff side ─────────────
async function staffLoad(ctx, actor, id) {
  P.require(actor, 'applications:work');
  const app = await ctx.db.one(
    `SELECT a.*, j.title AS job_title, j.reference_no AS job_ref, j.org_id, o.name AS employer_name, c.owner_user_id, l.assigned_to AS lead_assigned
       FROM applications a JOIN jobs j ON j.id=a.job_id JOIN organizations o ON o.id=j.org_id JOIN candidates c ON c.id=a.candidate_id
       LEFT JOIN leads l ON l.application_id=a.id WHERE a.id=$1`, [id]);
  if (!app) throw E.notFound('application');
  if (!P.can(actor, 'applications:view_all') && app.owner_user_id !== actor.userId && app.lead_assigned !== actor.userId) throw E.notFound('application');
  return app;
}
async function staffGet(ctx, actor, id) {
  const app = await staffLoad(ctx, actor, id);
  const history = await ctx.db.rows(`SELECT from_stage, to_stage, actor_role, reason, message, visibility, created_at FROM application_events WHERE application_id=$1 ORDER BY created_at`, [id]);
  const notes = await ctx.db.rows(`SELECT n.id, n.body, n.created_at, u.full_name AS author FROM internal_notes n JOIN users u ON u.id=n.author_id WHERE n.entity_type='application' AND n.entity_id=$1 ORDER BY n.created_at`, [id]);
  const requests = await ctx.db.rows(`SELECT id, type, status, note, created_at, decided_at, decision_note FROM employer_requests WHERE application_id=$1 ORDER BY created_at DESC`, [id]);
  const { owner_user_id, lead_assigned, ...rest } = app;
  return { ...rest, history, internal_notes: notes, employer_requests: requests };
}
async function staffSetStage(ctx, actor, id, { to, reason, message }) {
  const app = await staffLoad(ctx, actor, id);
  return ctx.db.tx(async (q) => {
    const fresh = await q.one('SELECT * FROM applications WHERE id=$1 FOR UPDATE', [id]);
    const row = await changeStage(q, actor, fresh, to, { reason, message, visibility: 'public' });
    await audit(q, actor, { action: 'application.stage_set', entityType: 'application', entityId: app.id, details: { from: fresh.stage, to, reason: reason || null } });
    return row;
  });
}
async function staffRelease(ctx, actor, id, { release = true, disclose_contact = false }) {
  const app = await staffLoad(ctx, actor, id);
  if (app.stage === 'submitted') throw E.conflict('lead_not_reviewed', 'Review and qualify the lead before releasing the applicant to the employer');
  return ctx.db.tx(async (q) => {
    await q.query('UPDATE applications SET released_to_employer=$2, contact_disclosed=$3, updated_at=now() WHERE id=$1', [id, release, release && disclose_contact]);
    await audit(q, actor, { action: 'application.released', entityType: 'application', entityId: id, details: { release, disclose_contact } });
    return { id, released_to_employer: release, contact_disclosed: release && disclose_contact };
  });
}
async function addNote(ctx, actor, entityType, entityId, body) {
  P.require(actor, 'applications:work');
  if (entityType === 'application') await staffLoad(ctx, actor, entityId);
  else if (entityType === 'organization') await orgs.getForStaff(ctx, actor, entityId);
  else if (entityType === 'candidate') await candidates.staffGet(ctx, actor, entityId);
  else throw E.badRequest('invalid_entity', 'Unsupported entity type');
  const r = await ctx.db.one(`INSERT INTO internal_notes (entity_type, entity_id, author_id, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at`, [entityType, entityId, actor.userId, body]);
  await audit(ctx.db, actor, { action: 'note.added', entityType, entityId });
  return r;
}

async function closeForJob(q, actor, jobId) {
  const apps = await q.rows(`SELECT * FROM applications WHERE job_id=$1 AND stage NOT IN ('rejected','withdrawn','position_closed','selected') FOR UPDATE`, [jobId]);
  for (const a of apps) await changeStage(q, actor, a, 'position_closed', { reason: 'job_closed', message: null });
  return apps.length;
}

// ───────────── employer side ─────────────
async function employerJobAccess(ctx, actor, jobId) {
  P.require(actor, 'employer:applicants');
  const job = await ctx.db.one('SELECT j.*, o.recruitment_mode FROM jobs j JOIN organizations o ON o.id=j.org_id WHERE j.id=$1', [jobId]);
  if (!job) throw E.notFound('job');
  orgs.requireMember(actor, job.org_id);
  return job;
}
function employerRow(a, mode) {
  return {
    id: a.id, reference_no: a.reference_no, stage: a.stage, created_at: a.created_at, job_id: a.job_id,
    candidate: candidates.employerView(a.profile_snapshot, { disclose: a.contact_disclosed }),
    cover_note: a.cover_note,
    contact_disclosed: a.contact_disclosed,
    pending_requests: a.pending_requests || [],
    recruitment_mode: mode,
  };
}
async function employerList(ctx, actor, jobId) {
  const job = await employerJobAccess(ctx, actor, jobId);
  const rows = await ctx.db.rows(
    `SELECT a.*, COALESCE((SELECT array_agg(r.type) FROM employer_requests r WHERE r.application_id=a.id AND r.status='pending'),'{}') AS pending_requests
       FROM applications a WHERE a.job_id=$1 AND a.released_to_employer = true AND a.stage NOT IN ('withdrawn') ORDER BY a.created_at DESC`, [jobId]);
  return rows.map((r) => employerRow(r, job.recruitment_mode));
}
async function employerLoad(ctx, actor, appId) {
  P.require(actor, 'employer:applicants');
  const a = await ctx.db.one(
    `SELECT a.*, j.org_id, o.recruitment_mode FROM applications a JOIN jobs j ON j.id=a.job_id JOIN organizations o ON o.id=j.org_id WHERE a.id=$1`, [appId]);
  if (!a || !a.released_to_employer) throw E.notFound('application');
  orgs.requireMember(actor, a.org_id);
  return a;
}
async function employerGet(ctx, actor, appId) {
  const a = await employerLoad(ctx, actor, appId);
  const reqs = await ctx.db.rows(`SELECT type, status, created_at FROM employer_requests WHERE application_id=$1 ORDER BY created_at DESC`, [appId]);
  return { ...employerRow(a, a.recruitment_mode), requests: reqs };
}
async function employerAct(ctx, actor, appId, action, { note, reason } = {}) {
  P.require(actor, 'employer:requests');
  const a = await employerLoad(ctx, actor, appId);
  if (TERMINAL.includes(a.stage)) throw E.conflict('application_closed', 'This application is no longer active');
  const direct = a.recruitment_mode === 'direct';
  return ctx.db.tx(async (q) => {
    const app = await q.one('SELECT * FROM applications WHERE id=$1 FOR UPDATE', [appId]);
    const asRequest = async (type) => {
      const r = await q.one(
        `INSERT INTO employer_requests (application_id, org_id, type, requested_by, note) VALUES ($1,$2,$3,$4,$5) RETURNING id, type, status`,
        [appId, a.org_id, type, actor.userId, note || null]).catch((e) => { if (e.code === '23505') throw E.conflict('request_pending', 'A request of this type is already pending'); throw e; });
      await audit(q, actor, { action: `employer.${type}_requested`, entityType: 'application', entityId: appId });
      return { request: r, stage: app.stage };
    };
    if (action === 'shortlist') {
      const row = await changeStage(q, actor, app, 'shortlisted');
      await audit(q, actor, { action: 'employer.shortlisted', entityType: 'application', entityId: appId });
      return { stage: row.stage };
    }
    if (action === 'request_interview') {
      if (direct) { const row = await changeStage(q, actor, app, 'interview_requested'); await audit(q, actor, { action: 'employer.interview_requested', entityType: 'application', entityId: appId }); return { stage: row.stage }; }
      return asRequest('interview');
    }
    if (action === 'request_selection') return asRequest('selection'); // never automatic: placement is confirmed by staff
    if (action === 'reject') {
      if (!reason) throw E.unprocessable('reason_required', 'A reason is required');
      const row = await changeStage(q, actor, app, 'rejected', { reason, message: null });
      await audit(q, actor, { action: 'employer.rejected', entityType: 'application', entityId: appId });
      return { stage: row.stage };
    }
    throw E.badRequest('invalid_action', 'Unknown action');
  });
}

async function listRequests(ctx, actor, { status = 'pending' } = {}) {
  P.require(actor, 'requests:resolve');
  const all = P.can(actor, 'applications:view_all');
  return ctx.db.rows(
    `SELECT r.id, r.type, r.status, r.note, r.created_at, a.id AS application_id, a.reference_no, a.stage, j.title AS job_title, o.name AS employer
       FROM employer_requests r JOIN applications a ON a.id=r.application_id JOIN jobs j ON j.id=a.job_id JOIN organizations o ON o.id=r.org_id
       JOIN candidates c ON c.id=a.candidate_id LEFT JOIN leads l ON l.application_id=a.id
      WHERE r.status=$1 AND ($2 OR c.owner_user_id=$3 OR l.assigned_to=$3) ORDER BY r.created_at ASC LIMIT 200`, [status, all, actor.userId]);
}
async function resolveRequest(ctx, actor, requestId, { decision, note }) {
  P.require(actor, 'requests:resolve');
  if (!['approve', 'decline'].includes(decision)) throw E.badRequest('invalid_decision', 'decision must be approve or decline');
  if (decision === 'decline' && !note) throw E.unprocessable('reason_required', 'A reason is required to decline');
  const req = await ctx.db.one('SELECT * FROM employer_requests WHERE id=$1', [requestId]);
  if (!req) throw E.notFound('request');
  await staffLoad(ctx, actor, req.application_id);
  return ctx.db.tx(async (q) => {
    const r = await q.one(`UPDATE employer_requests SET status=$2, decided_by=$3, decided_at=$4, decision_note=$5 WHERE id=$1 AND status='pending' RETURNING *`,
      [requestId, decision === 'approve' ? 'approved' : 'declined', actor.userId, ctx.clock.now(), note || null]);
    if (!r) throw E.conflict('already_resolved', 'This request was already resolved');
    let stage = null;
    if (decision === 'approve') {
      const app = await q.one('SELECT * FROM applications WHERE id=$1 FOR UPDATE', [r.application_id]);
      const to = r.type === 'selection' ? 'selected' : r.type === 'interview' ? 'interview_requested' : 'shortlisted';
      if (app.stage !== to) {
        // selection needs a scheduled interview first in the normal flow; staff may confirm directly, which is recorded
        const path = r.type === 'selection' && app.stage !== 'interview_scheduled' ? 'interview_scheduled' : null;
        let cur = app;
        if (path && TRANSITIONS[cur.stage]?.includes('interview_requested') && cur.stage !== 'interview_requested' && cur.stage !== 'interview_scheduled') {
          cur = await changeStage(q, actor, cur, 'interview_requested', { message: null, visibility: 'internal', notifyCandidate: false });
        }
        if (path && cur.stage === 'interview_requested') cur = await changeStage(q, actor, cur, 'interview_scheduled', { message: null, visibility: 'internal', notifyCandidate: false });
        const row = await changeStage(q, actor, cur, to, { message: null });
        stage = row.stage;
      } else stage = app.stage;
    }
    await audit(q, actor, { action: `employer_request.${decision}d`, entityType: 'application', entityId: r.application_id, details: { type: r.type, note: note || null } });
    return { id: r.id, status: r.status, stage };
  });
}

module.exports = {
  apply, listOwn, getOwn, withdraw, respondToRequest, staffGet, staffSetStage, staffRelease, addNote, closeForJob, changeStage, staffLoad,
  employerList, employerGet, employerAct, listRequests, resolveRequest, TRANSITIONS, TERMINAL,
};
