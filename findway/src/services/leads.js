'use strict';
const { E } = require('../lib/errors');
const { normName } = require('../lib/normalize');
const P = require('../permissions');
const { audit } = require('./audit');
const { emit } = require('./outbox');
const candidates = require('./candidates');

async function createFromApplication(q, actor, app, cand, snapshot) {
  return q.one(
    `INSERT INTO leads (source, application_id, candidate_id, submitted_by_user, snapshot, email_norm, phone_norm)
     VALUES ('application',$1,$2,$3,$4,$5,$6) RETURNING *`,
    [app.id, cand.id, actor?.userId || null, JSON.stringify(snapshot), cand.email_norm, cand.phone_norm]);
}

// Queue visibility: admins see everything; staff see their own leads plus the unassigned queue.
function scopeSql(actor) {
  return P.can(actor, 'leads:view_all') ? { sql: 'TRUE', params: [] } : { sql: '(l.assigned_to = $%d OR l.assigned_to IS NULL)', params: [actor.userId] };
}

async function list(ctx, actor, { status, assigned = 'all', limit = 50, offset = 0 } = {}) {
  P.require(actor, 'leads:work');
  const all = P.can(actor, 'leads:view_all');
  const rows = await ctx.db.rows(
    `SELECT l.id, l.reference_no, l.status, l.source, l.assigned_to, l.created_at, l.first_response_at, l.snapshot->>'full_name' AS applicant,
            l.snapshot->>'profession' AS profession, l.snapshot->>'country' AS country, a.reference_no AS application_ref, a.stage AS application_stage,
            j.title AS job_title, o.name AS employer,
            (SELECT count(*)::int FROM duplicate_reviews d WHERE d.lead_id=l.id AND d.status='open') AS open_duplicates,
            GREATEST(0, EXTRACT(EPOCH FROM (now() - l.created_at))::int) AS age_seconds
       FROM leads l LEFT JOIN applications a ON a.id=l.application_id LEFT JOIN jobs j ON j.id=a.job_id LEFT JOIN organizations o ON o.id=j.org_id
      WHERE ($1 OR l.assigned_to=$2 OR l.assigned_to IS NULL)
        AND ($3::text IS NULL OR l.status=$3)
        AND ($4='all' OR ($4='mine' AND l.assigned_to=$2) OR ($4='unassigned' AND l.assigned_to IS NULL))
      ORDER BY l.created_at ASC LIMIT $5 OFFSET $6`,
    [all, actor.userId, status || null, assigned, Math.min(limit, 100), offset]);
  return rows;
}

async function load(ctx, actor, id, q = ctx.db) {
  P.require(actor, 'leads:work');
  const lead = await q.one('SELECT * FROM leads WHERE id=$1', [id]);
  if (!lead) throw E.notFound('lead');
  if (!P.can(actor, 'leads:view_all') && lead.assigned_to && lead.assigned_to !== actor.userId) throw E.notFound('lead');
  return lead;
}

async function get(ctx, actor, id) {
  const lead = await load(ctx, actor, id);
  const app = lead.application_id ? await ctx.db.one(
    `SELECT a.id, a.reference_no, a.stage, a.cover_note, a.created_at, j.id AS job_id, j.title AS job_title, j.reference_no AS job_ref, o.name AS employer
       FROM applications a JOIN jobs j ON j.id=a.job_id JOIN organizations o ON o.id=j.org_id WHERE a.id=$1`, [lead.application_id]) : null;
  const notes = await ctx.db.rows(`SELECT n.id, n.body, n.created_at, u.full_name AS author FROM internal_notes n JOIN users u ON u.id=n.author_id WHERE n.entity_type='lead' AND n.entity_id=$1 ORDER BY n.created_at`, [id]);
  const reviews = await ctx.db.rows(
    `SELECT d.id, d.reasons, d.status, d.matched_candidate_id, c.full_name AS matched_name, c.country AS matched_country, c.email IS NOT NULL AS matched_has_email
       FROM duplicate_reviews d JOIN candidates c ON c.id=d.matched_candidate_id WHERE d.lead_id=$1 OR d.candidate_id=$2 ORDER BY d.created_at DESC`, [id, lead.candidate_id]);
  return { ...lead, application: app, internal_notes: notes, duplicate_reviews: reviews };
}

async function claim(ctx, actor, id) {
  P.require(actor, 'leads:work');
  return ctx.db.tx(async (q) => {
    const lead = await q.one('SELECT * FROM leads WHERE id=$1 FOR UPDATE', [id]);
    if (!lead) throw E.notFound('lead');
    if (lead.assigned_to && lead.assigned_to !== actor.userId) throw E.conflict('already_assigned', 'This lead is already assigned to someone else');
    if (lead.assigned_to === actor.userId) return lead;
    const row = await q.one('UPDATE leads SET assigned_to=$2, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *', [id, actor.userId]);
    await q.query(`INSERT INTO ownership_history (entity_type, entity_id, from_user, to_user, changed_by, reason) VALUES ('lead',$1,NULL,$2,$2,'claimed from queue')`, [id, actor.userId]);
    await audit(q, actor, { action: 'lead.claimed', entityType: 'lead', entityId: id });
    return row;
  });
}

// Audited reassignment: history keeps who owned it before; the original submitter attribution is never touched.
async function reassign(ctx, actor, entityType, id, toUserId, reason) {
  P.require(actor, 'assignments:manage');
  if (!reason) throw E.unprocessable('reason_required', 'A reason is required to reassign');
  const table = { lead: ['leads', 'assigned_to'], candidate: ['candidates', 'owner_user_id'], organization: ['organizations', 'owner_user_id'], case: ['recruitment_cases', 'owner_user_id'] }[entityType];
  if (!table) throw E.badRequest('invalid_entity', 'Unsupported entity type');
  const to = await ctx.db.one(`SELECT id, role, status FROM users WHERE id=$1`, [toUserId]);
  if (!to || to.status !== 'active' || !['staff', 'admin', 'super_admin'].includes(to.role)) throw E.unprocessable('invalid_assignee', 'The assignee must be an active staff member');
  return ctx.db.tx(async (q) => {
    const cur = await q.one(`SELECT ${table[1]} AS owner FROM ${table[0]} WHERE id=$1 FOR UPDATE`, [id]);
    if (!cur) throw E.notFound(entityType);
    await q.query(`UPDATE ${table[0]} SET ${table[1]}=$2, updated_at=now() WHERE id=$1`, [id, toUserId]);
    await q.query(`INSERT INTO ownership_history (entity_type, entity_id, from_user, to_user, changed_by, reason) VALUES ($1,$2,$3,$4,$5,$6)`, [entityType, id, cur.owner, toUserId, actor.userId, reason]);
    await audit(q, actor, { action: `${entityType}.reassigned`, entityType, entityId: id, details: { from: cur.owner, to: toUserId, reason } });
    return { id, from: cur.owner, to: toUserId };
  });
}

async function setStatus(ctx, actor, id, { to, reason, message }) {
  const applications = require('./applications');
  const lead = await load(ctx, actor, id);
  if (!['under_review', 'missing_information', 'rejected'].includes(to)) throw E.badRequest('invalid_status', 'status must be under_review, missing_information or rejected (use qualify to qualify)');
  if (['rejected'].includes(to) && !reason) throw E.unprocessable('reason_required', 'A reason is required to reject a lead');
  if (to === 'missing_information' && !message) throw E.unprocessable('message_required', 'Tell the candidate what information is missing');
  if (['qualified', 'rejected'].includes(lead.status)) throw E.conflict('lead_closed', `This lead is already ${lead.status}`);
  return ctx.db.tx(async (q) => {
    const cur = await q.one('SELECT * FROM leads WHERE id=$1 FOR UPDATE', [id]);
    if (['qualified', 'rejected'].includes(cur.status)) throw E.conflict('lead_closed', `This lead is already ${cur.status}`);
    const row = await q.one(
      `UPDATE leads SET status=$2, status_reason=$3, assigned_to=COALESCE(assigned_to,$4), first_response_at=COALESCE(first_response_at, now()), updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
      [id, to, reason || null, actor.userId]);
    if (cur.application_id) {
      const app = await q.one('SELECT * FROM applications WHERE id=$1 FOR UPDATE', [cur.application_id]);
      const appStage = { under_review: 'under_review', missing_information: 'missing_information', rejected: 'rejected' }[to];
      if (app.stage !== appStage && applications.TRANSITIONS[app.stage]?.includes(appStage)) {
        await applications.changeStage(q, actor, app, appStage, { reason: reason || null, message: message || null });
      }
    }
    await audit(q, actor, { action: `lead.${to}`, entityType: 'lead', entityId: id, details: { reason: reason || null } });
    return row;
  });
}

// Phase 1: find potential duplicates, persist them for human review, and report them.
async function detectAndRecord(ctx, actor, lead) {
  return ctx.db.tx(async (q) => {
    const cand = await q.one('SELECT * FROM candidates WHERE id=$1', [lead.candidate_id]);
    const dups = await candidates.findDuplicates(q, cand);
    const reviews = [];
    for (const d of dups) {
      const r = await q.one(
        `INSERT INTO duplicate_reviews (lead_id, candidate_id, matched_candidate_id, reasons) VALUES ($1,$2,$3,$4)
         ON CONFLICT (candidate_id, matched_candidate_id) WHERE status='open' DO UPDATE SET lead_id=COALESCE(duplicate_reviews.lead_id, EXCLUDED.lead_id)
         RETURNING id`, [lead.id, cand.id, d.candidate.id, d.reasons]);
      reviews.push({ review_id: r.id, matched_candidate_id: d.candidate.id, matched_name: d.candidate.full_name, reasons: d.reasons });
    }
    return reviews;
  });
}

async function qualify(ctx, actor, id, { resolution, release_to_employer = true, disclose_contact } = {}) {
  const applications = require('./applications');
  const lead = await load(ctx, actor, id);
  if (!['received', 'under_review', 'missing_information'].includes(lead.status)) throw E.conflict('lead_closed', `A ${lead.status} lead cannot be qualified`);

  // 1) link or create the person; uncertain matches stop here until a human decides
  let candidateId = lead.candidate_id;
  if (!candidateId) {
    const snap = lead.snapshot;
    const byEmail = lead.email_norm ? await ctx.db.one('SELECT id, full_name FROM candidates WHERE email_norm=$1 AND merged_into IS NULL', [lead.email_norm]) : null;
    if (byEmail && !resolution) throw E.conflict('duplicate_review_required', 'A person with this email already exists. Confirm whether this is the same person.', { reviews: [{ matched_candidate_id: byEmail.id, matched_name: byEmail.full_name, reasons: ['email'] }] });
    if (byEmail && resolution?.action === 'merge_into' && resolution.candidate_id === byEmail.id) candidateId = byEmail.id;
    else {
      const created = await ctx.db.one(
        `INSERT INTO candidates (full_name, name_norm, email, email_norm, phone, phone_norm, country, city, profession, source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'lead',$10) RETURNING id`,
        [snap.full_name, normName(snap.full_name), snap.email || null, byEmail ? null : lead.email_norm, snap.phone || null, lead.phone_norm, snap.country || null, snap.city || null, snap.profession || null, actor.userId]);
      candidateId = created.id;
    }
    await ctx.db.query('UPDATE leads SET candidate_id=$2 WHERE id=$1', [id, candidateId]);
    lead.candidate_id = candidateId;
  }
  const open = await detectAndRecord(ctx, actor, lead);
  if (open.length && !resolution) {
    throw E.conflict('duplicate_review_required', 'Possible duplicate people were found. A staff member must decide whether to link or keep them separate before qualification.', { reviews: open });
  }

  return ctx.db.tx(async (q) => {
    const cur = await q.one('SELECT * FROM leads WHERE id=$1 FOR UPDATE', [id]);
    if (!['received', 'under_review', 'missing_information'].includes(cur.status)) throw E.conflict('lead_closed', `A ${cur.status} lead cannot be qualified`);
    let finalCandidate = cur.candidate_id;
    if (resolution) {
      if (resolution.action === 'merge_into') {
        const matched = open.find((o) => o.matched_candidate_id === resolution.candidate_id);
        if (!matched) throw E.unprocessable('not_a_match', 'That person was not flagged as a possible match');
        finalCandidate = await candidates.mergeInto(q, actor, finalCandidate, resolution.candidate_id);
        await q.query(`UPDATE duplicate_reviews SET status='merged', resolved_by=$2, resolved_at=now(), resolution_note=$3 WHERE (candidate_id=$1 OR matched_candidate_id=$1) AND status='open'`, [cur.candidate_id, actor.userId, resolution.note || null]);
      } else if (resolution.action === 'keep_separate') {
        if (!resolution.note) throw E.unprocessable('reason_required', 'Record why these are different people');
        await q.query(`UPDATE duplicate_reviews SET status='kept_separate', resolved_by=$2, resolved_at=now(), resolution_note=$3 WHERE candidate_id=$1 AND status='open'`, [cur.candidate_id, actor.userId, resolution.note]);
      } else throw E.badRequest('invalid_resolution', 'resolution.action must be merge_into or keep_separate');
    }
    const row = await q.one(
      `UPDATE leads SET status='qualified', candidate_id=$2, assigned_to=COALESCE(assigned_to,$3), qualified_at=now(), first_response_at=COALESCE(first_response_at, now()), updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
      [id, finalCandidate, actor.userId]);
    await q.query(`UPDATE candidates SET owner_user_id=COALESCE(owner_user_id,$2) WHERE id=$1`, [finalCandidate, actor.userId]);
    if (cur.application_id) {
      const app = await q.one('SELECT * FROM applications WHERE id=$1 FOR UPDATE', [cur.application_id]);
      let released = app;
      if (['submitted', 'missing_information'].includes(app.stage)) released = await applications.changeStage(q, actor, app, 'under_review', { message: null });
      if (release_to_employer) {
        const org = await q.one('SELECT o.recruitment_mode FROM jobs j JOIN organizations o ON o.id=j.org_id WHERE j.id=$1', [app.job_id]);
        const disclose = disclose_contact ?? org.recruitment_mode === 'direct';
        await q.query('UPDATE applications SET released_to_employer=true, contact_disclosed=$2, updated_at=now() WHERE id=$1', [released.id, disclose]);
      }
    }
    await audit(q, actor, { action: 'lead.qualified', entityType: 'lead', entityId: id, details: { candidate_id: finalCandidate, resolution: resolution?.action || null } });
    await emit(q, actor, { type: 'lead.qualified', aggregateType: 'lead', aggregateId: id, aggregateVersion: row.version, data: { candidate_id: finalCandidate, application_id: cur.application_id } });
    return { lead: row, candidate_id: finalCandidate };
  });
}

async function listDuplicateReviews(ctx, actor, { status = 'open' } = {}) {
  P.require(actor, 'leads:work');
  return ctx.db.rows(
    `SELECT d.id, d.reasons, d.status, d.created_at, d.candidate_id, a.full_name AS candidate_name, d.matched_candidate_id, b.full_name AS matched_name, d.lead_id
       FROM duplicate_reviews d JOIN candidates a ON a.id=d.candidate_id JOIN candidates b ON b.id=d.matched_candidate_id WHERE d.status=$1 ORDER BY d.created_at ASC LIMIT 200`, [status]);
}
async function resolveDuplicate(ctx, actor, reviewId, { action, note }) {
  P.require(actor, 'leads:work');
  const rev = await ctx.db.one('SELECT * FROM duplicate_reviews WHERE id=$1', [reviewId]);
  if (!rev) throw E.notFound('duplicate review');
  if (rev.status !== 'open') throw E.conflict('already_resolved', 'This review is already resolved');
  return ctx.db.tx(async (q) => {
    if (action === 'merge') {
      if (!P.can(actor, 'candidates:write_all')) throw E.forbidden('permission_denied', 'Only an administrator can merge people outside a lead');
      await candidates.mergeInto(q, actor, rev.candidate_id, rev.matched_candidate_id);
      await q.query(`UPDATE duplicate_reviews SET status='merged', resolved_by=$2, resolved_at=now(), resolution_note=$3 WHERE id=$1`, [reviewId, actor.userId, note || null]);
    } else if (action === 'keep_separate') {
      if (!note) throw E.unprocessable('reason_required', 'Record why these are different people');
      await q.query(`UPDATE duplicate_reviews SET status='kept_separate', resolved_by=$2, resolved_at=now(), resolution_note=$3 WHERE id=$1`, [reviewId, actor.userId, note]);
    } else throw E.badRequest('invalid_action', 'action must be merge or keep_separate');
    await audit(q, actor, { action: `duplicate.${action}`, entityType: 'duplicate_review', entityId: reviewId });
    return { id: reviewId, status: action === 'merge' ? 'merged' : 'kept_separate' };
  });
}

module.exports = { createFromApplication, list, get, claim, reassign, setStatus, qualify, listDuplicateReviews, resolveDuplicate, load, scopeSql };
