'use strict';
const C = require('../lib/crypto');
const { E } = require('../lib/errors');
const { normEmail, normPhone, normName, normIdentity, normText } = require('../lib/normalize');
const P = require('../permissions');
const { audit } = require('./audit');
const { emit } = require('./outbox');

const PROFILE_FIELDS = ['full_name', 'phone', 'date_of_birth', 'nationality', 'country', 'city', 'profession', 'skills', 'experience_years',
  'education', 'certifications', 'languages', 'availability_date', 'desired_destinations', 'salary_expectation_min', 'salary_expectation_max',
  'salary_expectation_currency', 'salary_expectation_period', 'relocation_preference', 'visibility'];
const REQUIRED_TO_APPLY = ['full_name', 'phone', 'country', 'profession'];
const NICE_TO_HAVE = ['city', 'experience_years', 'skills', 'languages', 'desired_destinations', 'availability_date', 'education'];

const present = (c, f) => {
  const v = c[f];
  if (Array.isArray(v)) return v.length > 0;
  return v !== null && v !== undefined && String(v).trim() !== '';
};

function completion(c) {
  const missingRequired = REQUIRED_TO_APPLY.filter((f) => !present(c, f) || (f === 'phone' && !c.phone_norm));
  const missingOptional = NICE_TO_HAVE.filter((f) => !present(c, f));
  const total = REQUIRED_TO_APPLY.length + NICE_TO_HAVE.length;
  const done = total - missingRequired.length - missingOptional.length;
  return { percent: Math.round((done / total) * 100), ready_to_apply: missingRequired.length === 0, missing_required: missingRequired, missing_optional: missingOptional };
}

async function completionFor(ctx, userId) {
  const c = await ctx.db.one('SELECT * FROM candidates WHERE user_id=$1', [userId]);
  return c ? completion(c) : { percent: 0, ready_to_apply: false, missing_required: REQUIRED_TO_APPLY, missing_optional: NICE_TO_HAVE };
}

// Called after email verification proves ownership of the address: claim a staff-created person or create one.
async function ensureForUser(q, actor, user) {
  const existing = await q.one('SELECT * FROM candidates WHERE user_id=$1', [user.id]);
  if (existing) return existing;
  const unlinked = await q.one(`SELECT * FROM candidates WHERE email_norm=$1 AND user_id IS NULL AND merged_into IS NULL FOR UPDATE`, [user.email_norm]);
  if (unlinked) {
    const row = await q.one('UPDATE candidates SET user_id=$2, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *', [unlinked.id, user.id]);
    await audit(q, actor, { action: 'candidate.claimed_by_user', entityType: 'candidate', entityId: row.id });
    await emit(q, actor, { type: 'candidate.updated', aggregateType: 'candidate', aggregateId: row.id, aggregateVersion: row.version, data: { fields: ['user_link'] } });
    return row;
  }
  const row = await q.one(
    `INSERT INTO candidates (user_id, full_name, name_norm, email, email_norm, source, created_by) VALUES ($1,$2,$3,$4,$5,'self_registered',$1) RETURNING *`,
    [user.id, user.full_name, normName(user.full_name), user.email, user.email_norm]);
  await audit(q, actor, { action: 'candidate.created', entityType: 'candidate', entityId: row.id });
  await emit(q, actor, { type: 'candidate.created', aggregateType: 'candidate', aggregateId: row.id, aggregateVersion: row.version, data: { source: 'self_registered' } });
  return row;
}

// ── views ──
const mask = (v) => (v ? `••••${String(v).slice(-3)}` : null);

function ownView(c) {
  const { name_norm, email_norm, phone_norm, profession_norm, introduced_by, owner_user_id, merged_into, created_by, ...rest } = c;
  return { ...rest, completion: completion(c) };
}
function staffView(c) {
  const { name_norm, email_norm, phone_norm, profession_norm, merged_into, ...rest } = c;
  return rest;
}
// What an employer may see about an applicant: never contact data (unless disclosed), identity, DOB or internal fields.
function employerView(snapshot, { disclose }) {
  const s = snapshot || {};
  const base = {
    full_name: s.full_name, profession: s.profession, country: s.country, city: s.city, skills: s.skills || [],
    experience_years: s.experience_years ?? null, languages: s.languages || [], education: s.education || [],
    certifications: s.certifications || [], availability_date: s.availability_date || null,
  };
  if (disclose) { base.email = s.email || null; base.phone = s.phone || null; }
  return base;
}
function snapshotOf(c) {
  return {
    full_name: c.full_name, email: c.email, phone: c.phone, nationality: c.nationality, country: c.country, city: c.city,
    profession: c.profession, skills: c.skills, experience_years: c.experience_years, education: c.education,
    certifications: c.certifications, languages: c.languages, availability_date: c.availability_date,
    desired_destinations: c.desired_destinations, relocation_preference: c.relocation_preference,
    salary_expectation: c.salary_expectation_min == null && c.salary_expectation_max == null ? null : {
      min: c.salary_expectation_min, max: c.salary_expectation_max, currency: c.salary_expectation_currency, period: c.salary_expectation_period },
  };
}

async function getOwn(ctx, actor) {
  const c = await ctx.db.one('SELECT * FROM candidates WHERE user_id=$1', [actor.userId]);
  if (!c) throw E.notFound('candidate profile');
  return ownView(c);
}

async function updateOwn(ctx, actor, patch, version) {
  P.require(actor, 'onboard:candidate_profile');
  const cur = await ctx.db.one('SELECT * FROM candidates WHERE user_id=$1', [actor.userId]);
  if (!cur) throw E.notFound('candidate profile');
  if (version !== undefined && version !== cur.version) throw E.conflict('version_conflict', 'Your profile was changed elsewhere. Reload and retry.', { current_version: cur.version });
  const next = { ...cur };
  const changed = [];
  for (const f of PROFILE_FIELDS) {
    if (patch[f] !== undefined && JSON.stringify(patch[f]) !== JSON.stringify(cur[f])) { next[f] = patch[f]; changed.push(f); }
  }
  if (patch.phone !== undefined && patch.phone !== null && !normPhone(patch.phone)) {
    throw E.unprocessable('invalid_phone', 'Enter the phone number in international format, e.g. +355 69 123 4567');
  }
  if (!changed.length) return ownView(cur);
  return ctx.db.tx(async (q) => {
    const r = await q.one(
      `UPDATE candidates SET full_name=$2, name_norm=$3, phone=$4, phone_norm=$5, date_of_birth=$6, nationality=$7, country=$8, city=$9,
              profession=$10, profession_norm=$11, skills=$12, experience_years=$13, education=$14, certifications=$15, languages=$16,
              availability_date=$17, desired_destinations=$18, salary_expectation_min=$19, salary_expectation_max=$20,
              salary_expectation_currency=$21, salary_expectation_period=$22, relocation_preference=$23, visibility=$24,
              updated_at=now(), version=version+1
        WHERE id=$1 AND version=$25 RETURNING *`,
      [cur.id, next.full_name, normName(next.full_name), next.phone, normPhone(next.phone || ''), next.date_of_birth, next.nationality, next.country, next.city,
        next.profession, next.profession ? normText(next.profession) : null, next.skills, next.experience_years,
        JSON.stringify(next.education), JSON.stringify(next.certifications), JSON.stringify(next.languages), next.availability_date,
        next.desired_destinations, next.salary_expectation_min, next.salary_expectation_max, next.salary_expectation_currency,
        next.salary_expectation_period, next.relocation_preference, next.visibility, cur.version]);
    if (!r) throw E.conflict('version_conflict', 'Your profile was changed elsewhere. Reload and retry.');
    if (changed.includes('full_name')) await q.query('UPDATE users SET full_name=$2 WHERE id=$1', [actor.userId, r.full_name]);
    await audit(q, actor, { action: 'candidate.updated', entityType: 'candidate', entityId: r.id, details: { fields: changed } });
    await emit(q, actor, { type: 'candidate.updated', aggregateType: 'candidate', aggregateId: r.id, aggregateVersion: r.version, data: { fields: changed } });
    return ownView(r);
  });
}

// ── consent & data rights ──
const REVOCABLE = ['data_processing', 'marketing', 'media_sharing', 'ai_processing'];
async function listConsents(ctx, actor) {
  return ctx.db.rows('SELECT type, version, granted_at, revoked_at FROM consents WHERE user_id=$1 ORDER BY granted_at DESC', [actor.userId]);
}
async function setConsent(ctx, actor, type, granted, meta = {}) {
  if (!REVOCABLE.includes(type)) throw E.badRequest('not_changeable', 'Terms and privacy consent can only be withdrawn by requesting account deletion');
  return ctx.db.tx(async (q) => {
    const active = await q.one('SELECT * FROM consents WHERE user_id=$1 AND type=$2 AND revoked_at IS NULL', [actor.userId, type]);
    if (granted && !active) await q.query('INSERT INTO consents (user_id, type, version, ip) VALUES ($1,$2,$3,$4)', [actor.userId, type, '2025-01', meta.ip || null]);
    if (!granted && active) {
      await q.query('UPDATE consents SET revoked_at=$2 WHERE id=$1', [active.id, ctx.clock.now()]);
      const cand = await q.one('SELECT id FROM candidates WHERE user_id=$1', [actor.userId]);
      if (cand) await emit(q, actor, { type: 'consent.revoked', aggregateType: 'candidate', aggregateId: cand.id, data: { consent: type } });
    }
    await audit(q, actor, { action: granted ? 'consent.granted' : 'consent.revoked', entityType: 'user', entityId: actor.userId, details: { type } });
    return { type, granted };
  });
}
async function requestDataRight(ctx, actor, type) {
  if (!['export', 'deletion'].includes(type)) throw E.badRequest('invalid_type', 'type must be export or deletion');
  const open = await ctx.db.one(`SELECT id FROM data_requests WHERE user_id=$1 AND type=$2 AND status IN ('received','in_review')`, [actor.userId, type]);
  if (open) throw E.conflict('request_open', 'A request of this type is already open', { id: open.id });
  return ctx.db.tx(async (q) => {
    const r = await q.one(`INSERT INTO data_requests (user_id, type) VALUES ($1,$2) RETURNING id, type, status, created_at`, [actor.userId, type]);
    await audit(q, actor, { action: `data_request.${type}`, entityType: 'user', entityId: actor.userId });
    return r;
  });
}

// ── staff access ──
function canStaffSee(actor, c, assignedLeadCandidateIds = []) {
  if (P.can(actor, 'candidates:view_all')) return true;
  if (!P.can(actor, 'candidates:view_assigned')) return false;
  return c.owner_user_id === actor.userId || assignedLeadCandidateIds.includes(c.id);
}
async function staffGet(ctx, actor, id) {
  P.require(actor, 'candidates:view_assigned');
  const c = await ctx.db.one('SELECT * FROM candidates WHERE id=$1 AND merged_into IS NULL', [id]);
  if (!c) throw E.notFound('candidate');
  const leads = await ctx.db.rows(`SELECT candidate_id FROM leads WHERE assigned_to=$1 AND candidate_id=$2`, [actor.userId, id]);
  if (!canStaffSee(actor, c, leads.map((l) => l.candidate_id))) throw E.notFound('candidate');
  const refs = await ctx.db.rows('SELECT id, kind, value_enc, issuing_country, issue_date, expiry_date FROM candidate_identity_refs WHERE candidate_id=$1', [id]);
  return {
    ...staffView(c),
    identity_refs: refs.map((r) => ({ id: r.id, kind: r.kind, number_masked: mask(C.decrypt(r.value_enc, ctx.keys.enc)), issuing_country: r.issuing_country, issue_date: r.issue_date, expiry_date: r.expiry_date })),
  };
}
async function staffList(ctx, actor, { q: search, limit = 50, offset = 0 } = {}) {
  P.require(actor, 'candidates:view_assigned');
  const all = P.can(actor, 'candidates:view_all');
  const rows = await ctx.db.rows(
    `SELECT c.id, c.full_name, c.country, c.city, c.profession, c.owner_user_id, c.source, c.created_at, c.identity_review_status
       FROM candidates c
      WHERE c.merged_into IS NULL AND ($1 OR c.owner_user_id=$2 OR EXISTS (SELECT 1 FROM leads l WHERE l.candidate_id=c.id AND l.assigned_to=$2))
        AND ($3::text IS NULL OR c.name_norm LIKE $3 OR c.email_norm LIKE $3)
      ORDER BY c.created_at DESC LIMIT $4 OFFSET $5`,
    [all, actor.userId, search ? `%${normName(search)}%` : null, Math.min(limit, 100), offset]);
  return rows;
}

async function findDuplicates(q, cand) {
  const out = new Map();
  const add = (row, reason) => { const e = out.get(row.id) || { candidate: row, reasons: [] }; if (!e.reasons.includes(reason)) e.reasons.push(reason); out.set(row.id, e); };
  if (cand.phone_norm) for (const r of await q.rows(`SELECT * FROM candidates WHERE phone_norm=$1 AND id<>$2 AND merged_into IS NULL`, [cand.phone_norm, cand.id])) add(r, 'phone');
  const refs = await q.rows('SELECT value_hash FROM candidate_identity_refs WHERE candidate_id=$1', [cand.id]);
  for (const ref of refs) for (const r of await q.rows(
    `SELECT c.* FROM candidates c JOIN candidate_identity_refs i ON i.candidate_id=c.id WHERE i.value_hash=$1 AND c.id<>$2 AND c.merged_into IS NULL`, [ref.value_hash, cand.id])) add(r, 'identity');
  // name + date of birth is only a *hint* for a human; a name alone is never a match
  if (cand.name_norm && cand.date_of_birth) for (const r of await q.rows(
    `SELECT * FROM candidates WHERE name_norm=$1 AND date_of_birth=$2 AND id<>$3 AND merged_into IS NULL`, [cand.name_norm, cand.date_of_birth, cand.id])) add(r, 'name_and_birth_date');
  return [...out.values()];
}

async function recordIdentityRef(ctx, actor, candidateId, input) {
  P.require(actor, 'candidates:write_assigned');
  await staffGet(ctx, actor, candidateId); // enforces assignment scope
  const number = normIdentity(input.number);
  if (number.length < 5) throw E.unprocessable('invalid_identity', 'The document number looks too short');
  const hash = C.hmac(ctx.keys.identity, `${input.kind}:${number}`);
  return ctx.db.tx(async (q) => {
    const clash = await q.one(`SELECT candidate_id FROM candidate_identity_refs WHERE kind=$1 AND value_hash=$2`, [input.kind, hash]);
    if (clash && clash.candidate_id !== candidateId) {
      const rev = await q.one(
        `INSERT INTO duplicate_reviews (candidate_id, matched_candidate_id, reasons) VALUES ($1,$2,'{identity}')
         ON CONFLICT (candidate_id, matched_candidate_id) WHERE status='open' DO UPDATE SET reasons = duplicate_reviews.reasons RETURNING id`, [candidateId, clash.candidate_id]);
      await audit(q, actor, { action: 'candidate.identity_duplicate_flagged', entityType: 'candidate', entityId: candidateId, details: { review_id: rev.id } });
      return { duplicate_review_id: rev.id, flagged: true };
    }
    const row = clash ? await q.one('UPDATE candidate_identity_refs SET issue_date=$2, expiry_date=$3, issuing_country=$4 WHERE kind=$5 AND value_hash=$1 RETURNING id',
      [hash, input.issue_date || null, input.expiry_date || null, input.issuing_country || null, input.kind])
      : await q.one(
        `INSERT INTO candidate_identity_refs (candidate_id, kind, value_enc, value_hash, issuing_country, issue_date, expiry_date, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [candidateId, input.kind, C.encrypt(number, ctx.keys.enc), hash, input.issuing_country || null, input.issue_date || null, input.expiry_date || null, actor.userId]);
    const v = await q.one('UPDATE candidates SET updated_at=now(), version=version+1 WHERE id=$1 RETURNING version', [candidateId]);
    await audit(q, actor, { action: 'candidate.identity_recorded', entityType: 'candidate', entityId: candidateId, details: { kind: input.kind } });
    await emit(q, actor, { type: 'candidate.updated', aggregateType: 'candidate', aggregateId: candidateId, aggregateVersion: v.version, data: { fields: ['identity'] } });
    return { id: row.id, flagged: false };
  });
}

// Used only by integration adapters, in-process, never over HTTP.
async function readIdentityForSync(ctx, candidateId, kind = 'passport') {
  const r = await ctx.db.one('SELECT * FROM candidate_identity_refs WHERE candidate_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1', [candidateId, kind]);
  if (!r) return null;
  return { number: C.decrypt(r.value_enc, ctx.keys.enc), expiry_date: r.expiry_date, issue_date: r.issue_date, issuing_country: r.issuing_country };
}

// Human-approved merge: `source` disappears into `target`. Never called automatically.
async function mergeInto(q, actor, sourceId, targetId) {
  if (sourceId === targetId) throw E.badRequest('same_candidate', 'Cannot merge a person into themselves');
  const s = await q.one('SELECT * FROM candidates WHERE id=$1 AND merged_into IS NULL FOR UPDATE', [sourceId]);
  const t = await q.one('SELECT * FROM candidates WHERE id=$1 AND merged_into IS NULL FOR UPDATE', [targetId]);
  if (!s || !t) throw E.notFound('candidate');
  if (s.user_id && t.user_id && s.user_id !== t.user_id) throw E.conflict('both_have_accounts', 'Both records belong to different user accounts and cannot be merged automatically');
  // release unique slots before re-pointing
  await q.query(`UPDATE candidates SET merged_into=$2, email_norm=NULL, user_id=NULL, updated_at=now() WHERE id=$1`, [sourceId, targetId]);
  await q.query(
    `UPDATE candidates SET user_id=COALESCE(user_id,$2), email=COALESCE(email,$3), email_norm=COALESCE(email_norm,$4), phone=COALESCE(phone,$5), phone_norm=COALESCE(phone_norm,$6),
            date_of_birth=COALESCE(date_of_birth,$7), country=COALESCE(country,$8), city=COALESCE(city,$9), profession=COALESCE(profession,$10),
            profession_norm=COALESCE(profession_norm,$11), updated_at=now(), version=version+1 WHERE id=$1`,
    [targetId, s.user_id, s.email, s.email_norm, s.phone, s.phone_norm, s.date_of_birth, s.country, s.city, s.profession, s.profession_norm]);
  await q.query('UPDATE applications SET candidate_id=$2 WHERE candidate_id=$1', [sourceId, targetId]);
  await q.query('UPDATE leads SET candidate_id=$2 WHERE candidate_id=$1', [sourceId, targetId]);
  await q.query('UPDATE candidate_identity_refs SET candidate_id=$2 WHERE candidate_id=$1', [sourceId, targetId]);
  await q.query('UPDATE recruitment_cases SET candidate_id=$2 WHERE candidate_id=$1', [sourceId, targetId]);
  await audit(q, actor, { action: 'candidate.merged', entityType: 'candidate', entityId: targetId, details: { source_id: sourceId } });
  return t.id;
}

module.exports = {
  ensureForUser, getOwn, updateOwn, completion, completionFor, listConsents, setConsent, requestDataRight, staffGet, staffList,
  findDuplicates, recordIdentityRef, readIdentityForSync, mergeInto, employerView, snapshotOf, canStaffSee, ownView, staffView, PROFILE_FIELDS,
};
