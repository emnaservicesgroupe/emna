'use strict';
const { E } = require('../lib/errors');
const { normText } = require('../lib/normalize');
const { getSetting } = require('../context');
const P = require('../permissions');
const { audit } = require('./audit');
const { emit } = require('./outbox');
const { notify } = require('./notifications');
const orgs = require('./organizations');

// Fields whose change alters the deal for applicants: versioned, and applicants are notified to acknowledge.
const MATERIAL = ['salary_specified', 'salary_min', 'salary_max', 'salary_currency', 'salary_period', 'salary_basis', 'country', 'city', 'address',
  'hours_per_day', 'days_per_week', 'shifts', 'overtime_terms', 'contract_months', 'probation_months', 'employment_type', 'work_mode',
  'accommodation', 'food', 'transport', 'insurance'];
// A live job may only change these without going back through review.
const LIVE_SAFE = ['deadline', 'vacancies', 'allow_reapplication'];
const CONTENT = ['title', 'profession', 'category', 'vacancies', 'country', 'city', 'address', 'latitude', 'longitude', 'description', 'responsibilities',
  'requirements', 'experience_min_years', 'skills', 'languages', 'salary_specified', 'salary_min', 'salary_max', 'salary_currency', 'salary_period',
  'salary_basis', 'hours_per_day', 'days_per_week', 'shifts', 'overtime_terms', 'contract_months', 'probation_months', 'employment_type', 'work_mode',
  'accommodation', 'food', 'transport', 'insurance', 'other_benefits', 'relocation_support', 'international_recruitment',
  'employer_confirmed_visa_support', 'accepted_formats', 'deadline', 'allow_reapplication'];
const REQUIRED_TO_SUBMIT = ['title', 'profession', 'country', 'city', 'description', 'requirements', 'employment_type'];

const jsonFields = new Set(['languages']);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function validateContent(j) {
  if (j.salary_specified) {
    if (j.salary_min == null && j.salary_max == null) throw E.unprocessable('salary_required', 'Enter a salary amount or mark the salary as not specified');
    if (!j.salary_currency || !j.salary_period) throw E.unprocessable('salary_terms_required', 'Salary needs a currency and a pay period');
    if (j.salary_min != null && j.salary_max != null && Number(j.salary_min) > Number(j.salary_max)) throw E.unprocessable('salary_range_invalid', 'Minimum salary exceeds maximum');
  }
  if (j.hours_per_day != null && (j.hours_per_day <= 0 || j.hours_per_day > 24)) throw E.unprocessable('hours_invalid', 'Hours per day must be between 0 and 24');
  if (j.days_per_week != null && (j.days_per_week <= 0 || j.days_per_week > 7)) throw E.unprocessable('days_invalid', 'Days per week must be between 0 and 7');
}
function clean(input) {
  const out = {};
  for (const f of CONTENT) if (input[f] !== undefined) out[f] = input[f];
  if (out.salary_specified === false) Object.assign(out, { salary_min: null, salary_max: null, salary_currency: null, salary_period: null, salary_basis: 'unspecified' });
  return out;
}
const snapshotOf = (row) => Object.fromEntries(CONTENT.map((f) => [f, row[f] ?? null]));
function diffMaterial(prev, next) {
  return MATERIAL.filter((f) => !same(prev?.[f], next[f])).map((f) => ({ field: f, from: prev?.[f] ?? null, to: next[f] ?? null }));
}

async function loadOwned(ctx, actor, jobId, { owner = false } = {}) {
  const job = await ctx.db.one('SELECT * FROM jobs WHERE id=$1', [jobId]);
  if (!job) throw E.notFound('job');
  orgs.requireMember(actor, job.org_id, { owner });
  return job;
}

async function createDraft(ctx, actor, input) {
  P.require(actor, 'employer:jobs');
  const m = actor.orgs.find((o) => o.type === 'employer');
  if (!m) throw E.forbidden('no_employer_org', 'Your account is not linked to an employer');
  const c = clean(input); validateContent({ salary_specified: false, ...c });
  return ctx.db.tx(async (q) => {
    const cols = Object.keys(c);
    const vals = cols.map((k) => (jsonFields.has(k) ? JSON.stringify(c[k]) : c[k]));
    const row = await q.one(
      `INSERT INTO jobs (org_id, created_by, profession_norm${cols.length ? ', ' + cols.join(', ') : ''})
       VALUES ($1,$2,$3${cols.map((_, i) => `, $${i + 4}`).join('')}) RETURNING *`,
      [m.orgId, actor.userId, c.profession ? normText(c.profession) : null, ...vals]);
    await q.query(`INSERT INTO job_status_events (job_id, from_status, to_status, actor_user_id) VALUES ($1,NULL,'draft',$2)`, [row.id, actor.userId]);
    await audit(q, actor, { action: 'job.created', entityType: 'job', entityId: row.id });
    return row;
  });
}

async function update(ctx, actor, jobId, patch, version) {
  P.require(actor, 'employer:jobs');
  const job = await loadOwned(ctx, actor, jobId);
  if (version !== undefined && version !== job.version) throw E.conflict('version_conflict', 'This job was changed elsewhere. Reload and retry.', { current_version: job.version });
  if (job.status === 'pending_approval') throw E.conflict('job_locked_in_review', 'Withdraw the submission before editing');
  if (job.status === 'closed') throw E.conflict('job_closed', 'Closed jobs cannot be edited');
  const c = clean(patch);
  const changedFields = Object.keys(c).filter((f) => !same(job[f], c[f]));
  if (!changedFields.length) return job;
  const merged = { ...job, ...c };
  validateContent(merged);
  const live = ['published', 'paused'].includes(job.status);
  const needsReview = live && changedFields.some((f) => !LIVE_SAFE.includes(f));
  const nextStatus = needsReview ? 'pending_approval' : job.status;
  return ctx.db.tx(async (q) => {
    const cols = changedFields;
    const sets = cols.map((k, i) => `${k}=$${i + 3}`).join(', ');
    const vals = cols.map((k) => (jsonFields.has(k) ? JSON.stringify(c[k]) : c[k]));
    const row = await q.one(
      `UPDATE jobs SET ${sets}, profession_norm=$${cols.length + 3}, status=$${cols.length + 4}, status_reason=CASE WHEN $${cols.length + 4} <> status THEN 'edited_after_publication' ELSE status_reason END,
              updated_at=now(), version=version+1 WHERE id=$1 AND version=$2 RETURNING *`,
      [jobId, job.version, ...vals, merged.profession ? normText(merged.profession) : null, nextStatus]);
    if (!row) throw E.conflict('version_conflict', 'This job was changed elsewhere. Reload and retry.');
    if (needsReview) await q.query(`INSERT INTO job_status_events (job_id, from_status, to_status, actor_user_id, reason) VALUES ($1,$2,'pending_approval',$3,'edited_after_publication')`, [jobId, job.status, actor.userId]);
    await audit(q, actor, { action: 'job.updated', entityType: 'job', entityId: jobId, details: { fields: changedFields, returned_to_review: needsReview } });
    return row;
  });
}

async function setStatus(q, actor, job, to, reason = null) {
  const row = await q.one('UPDATE jobs SET status=$2, status_reason=$3, updated_at=now() WHERE id=$1 RETURNING *', [job.id, to, reason]);
  await q.query('INSERT INTO job_status_events (job_id, from_status, to_status, actor_user_id, reason) VALUES ($1,$2,$3,$4,$5)', [job.id, job.status, to, actor?.userId || null, reason]);
  return row;
}

async function submit(ctx, actor, jobId) {
  P.require(actor, 'employer:jobs');
  const job = await loadOwned(ctx, actor, jobId);
  if (!['draft', 'changes_requested', 'rejected'].includes(job.status)) throw E.conflict('invalid_state', `A job in status ${job.status} cannot be submitted`);
  const missing = REQUIRED_TO_SUBMIT.filter((f) => job[f] === null || job[f] === '' || job[f] === undefined);
  if (missing.length) throw E.unprocessable('job_incomplete', 'Complete the required fields before submitting', { missing });
  validateContent(job);
  if (job.deadline && job.deadline < ctx.clock.now().toISOString().slice(0, 10)) throw E.unprocessable('deadline_in_past', 'The application deadline has already passed');
  return ctx.db.tx(async (q) => {
    const row = await setStatus(q, actor, job, 'pending_approval');
    await audit(q, actor, { action: 'job.submitted', entityType: 'job', entityId: jobId });
    return row;
  });
}

async function withdrawSubmission(ctx, actor, jobId) {
  P.require(actor, 'employer:jobs');
  const job = await loadOwned(ctx, actor, jobId);
  if (job.status !== 'pending_approval') throw E.conflict('invalid_state', 'This job is not awaiting approval');
  // A live job that was pulled for review goes back to paused (its approved content stays in job_versions).
  return ctx.db.tx(async (q) => {
    const row = await setStatus(q, actor, job, job.published_version > 0 ? 'paused' : 'draft', 'submission_withdrawn');
    await audit(q, actor, { action: 'job.submission_withdrawn', entityType: 'job', entityId: jobId });
    return row;
  });
}

async function review(ctx, actor, jobId, { decision, note, override_unverified_reason }) {
  P.require(actor, 'jobs:review');
  const job = await ctx.db.one('SELECT * FROM jobs WHERE id=$1', [jobId]);
  if (!job) throw E.notFound('job');
  if (job.status !== 'pending_approval') throw E.conflict('invalid_state', 'This job is not awaiting approval');
  if (!['approve', 'request_changes', 'reject'].includes(decision)) throw E.badRequest('invalid_decision', 'decision must be approve, request_changes or reject');
  if (decision !== 'approve' && !note) throw E.unprocessable('reason_required', 'A reason is required');
  const org = await ctx.db.one('SELECT * FROM organizations WHERE id=$1', [job.org_id]);
  if (decision === 'approve') {
    const needVerified = await getSetting(ctx, 'policy.employer_job_requires_verified_org', true);
    if (needVerified && org.verification_status !== 'verified' && !override_unverified_reason) {
      throw E.conflict('employer_not_verified', 'The employer has not passed company verification. Verify it first or record an override reason.', { verification_status: org.verification_status });
    }
  }
  return ctx.db.tx(async (q) => {
    const fresh = await q.one('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [jobId]);
    if (fresh.status !== 'pending_approval') throw E.conflict('invalid_state', 'This job is no longer awaiting approval');
    const creator = fresh.created_by;
    if (decision !== 'approve') {
      const to = decision === 'reject' ? 'rejected' : 'changes_requested';
      const row = await setStatus(q, actor, fresh, to, note);
      await notify(q, creator, 'job.review_decided', { job_id: jobId, decision: to, note });
      await audit(q, actor, { action: `job.${to}`, entityType: 'job', entityId: jobId, details: { note } });
      return row;
    }
    const prev = fresh.published_version > 0
      ? (await q.one('SELECT snapshot FROM job_versions WHERE job_id=$1 AND version=$2', [jobId, fresh.published_version]))?.snapshot : null;
    const snap = snapshotOf(fresh);
    const changes = prev ? diffMaterial(prev, snap) : [];
    await q.query('INSERT INTO job_versions (job_id, version, snapshot, material_changes, approved_by) VALUES ($1,$2,$3,$4,$5)',
      [jobId, fresh.version, JSON.stringify(snap), JSON.stringify(changes), actor.userId]);
    const now = ctx.clock.now();
    const row = await q.one(
      `UPDATE jobs SET status='published', status_reason=NULL, published_version=$2, published_at=COALESCE(published_at,$3), last_verified_at=$3, updated_at=now() WHERE id=$1 RETURNING *`,
      [jobId, fresh.version, now]);
    await q.query(`INSERT INTO job_status_events (job_id, from_status, to_status, actor_user_id, reason) VALUES ($1,'pending_approval','published',$2,$3)`, [jobId, actor.userId, override_unverified_reason ? `override: ${override_unverified_reason}` : null]);
    if (changes.length) {
      const apps = await q.rows(
        `SELECT a.id, a.candidate_id, c.user_id FROM applications a JOIN candidates c ON c.id=a.candidate_id
          WHERE a.job_id=$1 AND a.stage NOT IN ('rejected','withdrawn','position_closed')`, [jobId]);
      for (const a of apps) {
        await q.query(`INSERT INTO job_change_acks (job_id, job_version, application_id, candidate_id, changes) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [jobId, fresh.version, a.id, a.candidate_id, JSON.stringify(changes)]);
        await notify(q, a.user_id, 'job.terms_changed', { job_id: jobId, application_id: a.id, version: fresh.version, fields: changes.map((c) => c.field), requires_ack: true }, `job-change:${a.id}:${fresh.version}`);
      }
    }
    await notify(q, creator, 'job.review_decided', { job_id: jobId, decision: 'published' });
    await audit(q, actor, { action: 'job.approved', entityType: 'job', entityId: jobId, details: { version: fresh.version, material_changes: changes.map((c) => c.field), override: override_unverified_reason || null } });
    await emit(q, actor, { type: 'job.published', aggregateType: 'job', aggregateId: jobId, aggregateVersion: fresh.version, data: { material_changes: changes.map((c) => c.field) } });
    return row;
  });
}

async function setLive(ctx, actor, jobId, to) {
  P.require(actor, 'employer:jobs');
  const job = await loadOwned(ctx, actor, jobId);
  const ok = (to === 'paused' && job.status === 'published') || (to === 'published' && job.status === 'paused' && job.published_version === job.version);
  if (!ok) throw E.conflict('invalid_state', `Cannot change a ${job.status} job to ${to}`);
  return ctx.db.tx(async (q) => {
    const row = await setStatus(q, actor, job, to);
    await audit(q, actor, { action: to === 'paused' ? 'job.paused' : 'job.resumed', entityType: 'job', entityId: jobId });
    return row;
  });
}

async function close(ctx, actor, jobId, reason) {
  const job = await ctx.db.one('SELECT * FROM jobs WHERE id=$1', [jobId]);
  if (!job) throw E.notFound('job');
  if (P.can(actor, 'jobs:review')) { /* admins may close any job */ } else { P.require(actor, 'employer:jobs'); orgs.requireMember(actor, job.org_id); }
  if (job.status === 'closed') throw E.conflict('invalid_state', 'The job is already closed');
  if (!reason) throw E.unprocessable('reason_required', 'A reason is required to close a job');
  return closeInternal(ctx, actor, job, reason);
}
async function closeInternal(ctx, actor, job, reason) {
  const applications = require('./applications');
  return ctx.db.tx(async (q) => {
    const row = await q.one('UPDATE jobs SET status=$2, status_reason=$3, closed_at=$4, updated_at=now() WHERE id=$1 RETURNING *', [job.id, 'closed', reason, ctx.clock.now()]);
    await q.query('INSERT INTO job_status_events (job_id, from_status, to_status, actor_user_id, reason) VALUES ($1,$2,$3,$4,$5)', [job.id, job.status, 'closed', actor?.userId || null, reason]);
    await applications.closeForJob(q, actor, job.id);
    await audit(q, actor, { action: 'job.closed', entityType: 'job', entityId: job.id, details: { reason } });
    await emit(q, actor, { type: 'job.closed', aggregateType: 'job', aggregateId: job.id, aggregateVersion: row.version, data: { reason } });
    return row;
  });
}

// Worker: jobs past their deadline close themselves (and their open applications become 'position_closed').
async function closeExpired(ctx) {
  const today = ctx.clock.now().toISOString().slice(0, 10);
  const jobs = await ctx.db.rows(`SELECT * FROM jobs WHERE status IN ('published','paused') AND deadline IS NOT NULL AND deadline < $1`, [today]);
  for (const j of jobs) await closeInternal(ctx, null, j, 'deadline_passed');
  return jobs.length;
}

async function ackChange(ctx, actor, applicationId, version) {
  const cand = await ctx.db.one('SELECT id FROM candidates WHERE user_id=$1', [actor.userId]);
  if (!cand) throw E.notFound('candidate profile');
  const r = await ctx.db.query(
    `UPDATE job_change_acks SET acknowledged_at=$4 WHERE application_id=$1 AND job_version=$2 AND candidate_id=$3 AND acknowledged_at IS NULL`,
    [applicationId, version, cand.id, ctx.clock.now()]);
  if (!r.rowCount) throw E.notFound('pending acknowledgement');
  await audit(ctx.db, actor, { action: 'job.change_acknowledged', entityType: 'application', entityId: applicationId, details: { version } });
}
async function pendingAcks(ctx, actor) {
  const cand = await ctx.db.one('SELECT id FROM candidates WHERE user_id=$1', [actor.userId]);
  if (!cand) return [];
  return ctx.db.rows(
    `SELECT k.application_id, k.job_id, k.job_version, k.changes, k.notified_at, j.title, j.reference_no
       FROM job_change_acks k JOIN jobs j ON j.id=k.job_id WHERE k.candidate_id=$1 AND k.acknowledged_at IS NULL ORDER BY k.notified_at DESC`, [cand.id]);
}

// ───────────── reads ─────────────
function publicView(j, o) {
  return {
    id: j.id, reference_no: j.reference_no, title: j.title, profession: j.profession, category: j.category, vacancies: j.vacancies,
    employer: { id: o.id, name: o.name, verification_status: o.verification_status, country: o.country, profile_public: o.public_profile },
    location: { country: j.country, city: j.city, address: j.address, latitude: j.latitude, longitude: j.longitude },
    description: j.description, responsibilities: j.responsibilities, requirements: j.requirements,
    experience_min_years: j.experience_min_years, skills: j.skills, languages: j.languages,
    salary: j.salary_specified
      ? { specified: true, min: j.salary_min, max: j.salary_max, currency: j.salary_currency, period: j.salary_period, basis: j.salary_basis }
      : { specified: false },
    schedule: { hours_per_day: j.hours_per_day, days_per_week: j.days_per_week, shifts: j.shifts, overtime_terms: j.overtime_terms },
    contract: { duration_months: j.contract_months, probation_months: j.probation_months, employment_type: j.employment_type, work_mode: j.work_mode },
    benefits: { accommodation: j.accommodation, food: j.food, transport: j.transport, insurance: j.insurance, other: j.other_benefits },
    relocation_support: j.relocation_support,                                   // null = not specified
    international_recruitment: { open_to_international: j.international_recruitment, employer_confirmed_visa_support: j.employer_confirmed_visa_support },
    accepted_formats: j.accepted_formats, deadline: j.deadline, allow_reapplication: j.allow_reapplication,
    published_at: j.published_at, last_verified_at: j.last_verified_at, revision: j.published_version,
  };
}

const esc = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

async function publicSearch(ctx, f) {
  const today = ctx.clock.now().toISOString().slice(0, 10);
  const where = [`j.status='published'`, `(j.deadline IS NULL OR j.deadline >= $1)`];
  const p = [today];
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
  if (f.q) {
    p.push(`%${esc(f.q.toLowerCase())}%`); const raw = p.length;       // literal match: user-typed % and _ are escaped
    const nq = normText(f.q);
    let normClause = '';
    if (nq) { p.push(`%${esc(nq)}%`); normClause = `j.profession_norm LIKE $${p.length} OR `; }   // diacritic-insensitive match on the normalised profession
    where.push(`(${normClause}lower(j.title) LIKE $${raw} OR lower(coalesce(j.description,'')) LIKE $${raw} OR lower(coalesce(j.city,'')) LIKE $${raw} OR lower(o.name) LIKE $${raw})`);
  }
  if (f.profession) add('j.profession_norm = ?', normText(f.profession));
  if (f.country) add('lower(j.country) = lower(?)', f.country);
  if (f.city) add('lower(j.city) = lower(?)', f.city);
  if (f.experience_years != null) add('(j.experience_min_years IS NULL OR j.experience_min_years <= ?)', f.experience_years);
  if (f.skills?.length) add('j.skills @> ?::text[]', f.skills);
  for (const code of f.languages || []) add(`j.languages @> ?::jsonb`, JSON.stringify([{ code }]));
  if (f.employment_type) add('j.employment_type = ?', f.employment_type);
  if (f.work_mode) add('j.work_mode = ?', f.work_mode);
  if (f.accommodation) where.push(`j.accommodation IN ('provided','allowance')`);
  if (f.relocation_support) where.push('j.relocation_support = true');
  if (f.salary_min != null || f.salary_max != null) {
    if (!f.salary_currency || !f.salary_period) throw E.badRequest('salary_filter_needs_terms', 'Filtering by salary needs a currency and a pay period');
    where.push('j.salary_specified = true');
    add('j.salary_currency = ?', f.salary_currency); add('j.salary_period = ?', f.salary_period);
    if (f.salary_min != null) add('COALESCE(j.salary_max, j.salary_min) >= ?', f.salary_min);
    if (f.salary_max != null) add('COALESCE(j.salary_min, j.salary_max) <= ?', f.salary_max);
  }
  const order = { newest: 'j.published_at DESC', deadline: 'j.deadline ASC NULLS LAST', salary_desc: 'COALESCE(j.salary_max, j.salary_min) DESC NULLS LAST' }[f.sort || 'newest'] || 'j.published_at DESC';
  const limit = Math.min(f.limit || 20, 50); const offset = f.offset || 0;
  const base = `FROM jobs j JOIN organizations o ON o.id=j.org_id WHERE ${where.join(' AND ')}`;
  const total = (await ctx.db.one(`SELECT count(*)::int AS n ${base}`, p)).n;
  const rows = await ctx.db.rows(`SELECT j.*, o.id AS o_id, o.name AS o_name, o.verification_status AS o_vs, o.country AS o_country, o.public_profile AS o_pp ${base} ORDER BY ${order}, j.id LIMIT ${limit} OFFSET ${offset}`, p);
  return { items: rows.map((r) => publicView(r, { id: r.o_id, name: r.o_name, verification_status: r.o_vs, country: r.o_country, public_profile: r.o_pp })), total, limit, offset };
}

async function publicGet(ctx, idOrRef) {
  const today = ctx.clock.now().toISOString().slice(0, 10);
  const isRef = /^FW-J-\d+$/i.test(idOrRef);
  const r = await ctx.db.one(
    `SELECT j.*, o.id AS o_id, o.name AS o_name, o.verification_status AS o_vs, o.country AS o_country, o.public_profile AS o_pp
       FROM jobs j JOIN organizations o ON o.id=j.org_id
      WHERE ${isRef ? 'j.reference_no = upper($1)' : 'j.id::text = $1'} AND j.status='published' AND (j.deadline IS NULL OR j.deadline >= $2)`, [idOrRef, today]);
  if (!r) throw E.notFound('job');
  return publicView(r, { id: r.o_id, name: r.o_name, verification_status: r.o_vs, country: r.o_country, public_profile: r.o_pp });
}

async function listForEmployer(ctx, actor, { status, limit = 50, offset = 0 } = {}) {
  P.require(actor, 'employer:jobs');
  const ids = actor.orgs.map((o) => o.orgId);
  return ctx.db.rows(
    `SELECT j.id, j.reference_no, j.title, j.status, j.status_reason, j.country, j.city, j.vacancies, j.deadline, j.version, j.published_version, j.created_at, j.updated_at,
            (SELECT count(*)::int FROM applications a WHERE a.job_id=j.id AND a.released_to_employer = true) AS applicants
       FROM jobs j WHERE j.org_id = ANY($1) AND ($2::text IS NULL OR j.status=$2) ORDER BY j.updated_at DESC LIMIT $3 OFFSET $4`,
    [ids, status || null, Math.min(limit, 100), offset]);
}
async function getForEmployer(ctx, actor, jobId) {
  P.require(actor, 'employer:jobs');
  return loadOwned(ctx, actor, jobId);
}

async function reviewQueue(ctx, actor) {
  P.require(actor, 'jobs:review');
  return ctx.db.rows(
    `SELECT j.id, j.reference_no, j.title, j.country, j.city, j.version, j.published_version, j.status_reason, j.updated_at, o.name AS employer, o.verification_status
       FROM jobs j JOIN organizations o ON o.id=j.org_id WHERE j.status='pending_approval' ORDER BY j.updated_at ASC LIMIT 200`);
}
async function getForReview(ctx, actor, jobId) {
  P.require(actor, 'jobs:review');
  const j = await ctx.db.one(`SELECT j.*, o.name AS employer_name, o.verification_status AS employer_verification FROM jobs j JOIN organizations o ON o.id=j.org_id WHERE j.id=$1`, [jobId]);
  if (!j) throw E.notFound('job');
  const prev = j.published_version > 0 ? (await ctx.db.one('SELECT snapshot FROM job_versions WHERE job_id=$1 AND version=$2', [jobId, j.published_version]))?.snapshot : null;
  return { job: j, pending_material_changes: prev ? diffMaterial(prev, snapshotOf(j)) : [] };
}
async function listAll(ctx, actor, { status, limit = 50, offset = 0 } = {}) {
  P.require(actor, 'jobs:view_all');
  return ctx.db.rows(
    `SELECT j.id, j.reference_no, j.title, j.status, j.country, j.city, j.deadline, o.name AS employer FROM jobs j JOIN organizations o ON o.id=j.org_id
      WHERE ($1::text IS NULL OR j.status=$1) ORDER BY j.updated_at DESC LIMIT $2 OFFSET $3`, [status || null, Math.min(limit, 100), offset]);
}
async function versions(ctx, actor, jobId) {
  const j = await ctx.db.one('SELECT org_id FROM jobs WHERE id=$1', [jobId]);
  if (!j) throw E.notFound('job');
  if (!P.can(actor, 'jobs:view_all')) { P.require(actor, 'employer:jobs'); orgs.requireMember(actor, j.org_id); }
  return ctx.db.rows('SELECT version, material_changes, approved_by, created_at FROM job_versions WHERE job_id=$1 ORDER BY version DESC', [jobId]);
}

module.exports = {
  createDraft, update, submit, withdrawSubmission, review, setLive, close, closeExpired, ackChange, pendingAcks, publicSearch, publicGet,
  listForEmployer, getForEmployer, reviewQueue, getForReview, listAll, versions, MATERIAL, LIVE_SAFE, diffMaterial,
};
