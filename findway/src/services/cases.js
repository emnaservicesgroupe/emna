'use strict';
const { E } = require('../lib/errors');
const P = require('../permissions');
const { audit } = require('./audit');
const { emit } = require('./outbox');
const { notify } = require('./notifications');
const applications = require('./applications');

const STAGES = ['offer', 'documents', 'contract', 'work_permit', 'visa_appointment', 'visa_result', 'travel', 'arrival', 'started_work', 'follow_up', 'closed'];

async function open(ctx, actor, applicationId) {
  P.require(actor, 'cases:work');
  const app = await applications.staffLoad(ctx, actor, applicationId);
  if (app.stage !== 'selected') throw E.conflict('not_selected', 'A recruitment case can only be opened for a selected candidate');
  return ctx.db.tx(async (q) => {
    const exists = await q.one('SELECT id FROM recruitment_cases WHERE application_id=$1', [applicationId]);
    if (exists) throw E.conflict('case_exists', 'A case already exists for this application', { case_id: exists.id });
    const row = await q.one(
      `INSERT INTO recruitment_cases (application_id, candidate_id, job_id, org_id, owner_user_id, opened_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
      [applicationId, app.candidate_id, app.job_id, app.org_id, actor.userId]);
    await q.query(`INSERT INTO case_events (case_id, from_stage, to_stage, actor_user_id) VALUES ($1,NULL,'offer',$2)`, [row.id, actor.userId]);
    await audit(q, actor, { action: 'case.opened', entityType: 'case', entityId: row.id });
    await emit(q, actor, { type: 'placement.updated', aggregateType: 'case', aggregateId: row.id, aggregateVersion: row.version, data: { stage: 'offer', candidate_id: app.candidate_id } });
    return row;
  });
}

async function loadScoped(ctx, actor, id, q = ctx.db) {
  P.require(actor, 'cases:work');
  const c = await q.one('SELECT * FROM recruitment_cases WHERE id=$1', [id]);
  if (!c) throw E.notFound('case');
  if (!P.can(actor, 'cases:view_all') && c.owner_user_id !== actor.userId) throw E.notFound('case');
  return c;
}

// Shared by staff actions and by inbound sync (system actor, origin = remote system). Caller owns the transaction.
async function advanceInternal(q, actor, cur, stage, { reason = null, origin = 'findway' } = {}) {
  const backwards = STAGES.indexOf(stage) < STAGES.indexOf(cur.stage);
  if ((backwards || stage === 'closed') && !reason) throw E.unprocessable('reason_required', 'A reason is required to reverse a stage or close a case');
  const row = await q.one(`UPDATE recruitment_cases SET stage=$2, stage_reason=$3, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`, [cur.id, stage, reason]);
  await q.query(`INSERT INTO case_events (case_id, from_stage, to_stage, actor_user_id, origin, reason) VALUES ($1,$2,$3,$4,$5,$6)`, [cur.id, cur.stage, stage, actor?.userId || null, origin, reason]);
  const c = await q.one('SELECT user_id FROM candidates WHERE id=$1', [cur.candidate_id]);
  await notify(q, c?.user_id, 'case.stage', { case_id: cur.id, stage }, `case-stage:${cur.id}:${row.version}`);
  await audit(q, actor, { action: 'case.stage_changed', entityType: 'case', entityId: cur.id, details: { from: cur.stage, to: stage, reason, origin } });
  await emit(q, actor, { type: 'placement.updated', aggregateType: 'case', aggregateId: cur.id, aggregateVersion: row.version, data: { from: cur.stage, to: stage, candidate_id: cur.candidate_id }, origin });
  return row;
}

async function advance(ctx, actor, id, { stage, reason, version }) {
  if (!STAGES.includes(stage)) throw E.badRequest('invalid_stage', 'Unknown stage');
  await loadScoped(ctx, actor, id);
  return ctx.db.tx(async (q) => {
    const cur = await q.one('SELECT * FROM recruitment_cases WHERE id=$1 FOR UPDATE', [id]);
    if (version !== undefined && version !== cur.version) throw E.conflict('version_conflict', 'The case was changed elsewhere. Reload and retry.', { current_version: cur.version });
    if (cur.stage === stage) return cur;
    if (cur.stage === 'closed') throw E.conflict('case_closed', 'A closed case cannot change stage');
    return advanceInternal(q, actor, cur, stage, { reason });
  });
}

async function list(ctx, actor, { limit = 50, offset = 0 } = {}) {
  P.require(actor, 'cases:work');
  const all = P.can(actor, 'cases:view_all');
  return ctx.db.rows(
    `SELECT rc.id, rc.reference_no, rc.stage, rc.version, rc.updated_at, c.full_name AS candidate, j.title AS job_title, o.name AS employer, rc.owner_user_id
       FROM recruitment_cases rc JOIN candidates c ON c.id=rc.candidate_id JOIN jobs j ON j.id=rc.job_id JOIN organizations o ON o.id=rc.org_id
      WHERE ($1 OR rc.owner_user_id=$2) ORDER BY rc.updated_at DESC LIMIT $3 OFFSET $4`, [all, actor.userId, Math.min(limit, 100), offset]);
}
async function get(ctx, actor, id) {
  const c = await loadScoped(ctx, actor, id);
  const events = await ctx.db.rows('SELECT from_stage, to_stage, origin, reason, created_at FROM case_events WHERE case_id=$1 ORDER BY created_at', [id]);
  return { ...c, events };
}

module.exports = { STAGES, open, advance, advanceInternal, list, get, loadScoped };
