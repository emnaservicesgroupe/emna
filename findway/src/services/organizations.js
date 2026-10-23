'use strict';
const { E } = require('../lib/errors');
const { normName, normIdentity, domainOf } = require('../lib/normalize');
const P = require('../permissions');
const { audit } = require('./audit');
const { notify } = require('./notifications');

const PUBLIC_FIELDS = `o.id, o.name, o.country, o.city, o.industry, o.description, o.website, o.verification_status`;

async function findDuplicateOrgs(q, { name, registration, website, excludeId = null }) {
  const reg = registration ? normIdentity(registration) : null;
  const domain = domainOf(website);
  return q.rows(
    `SELECT id, name, country, claimed, verification_status FROM organizations
      WHERE ($4::uuid IS NULL OR id <> $4)
        AND ((registration_norm IS NOT NULL AND registration_norm = $1) OR (domain IS NOT NULL AND domain = $2) OR name_norm = $3)
      LIMIT 5`, [reg, domain, normName(name), excludeId]);
}

async function createForRegistration(q, user, o, type) {
  if (!o || !o.name) throw E.unprocessable('org_required', 'Organization details are required');
  const dups = await findDuplicateOrgs(q, { name: o.name, registration: o.registration_number, website: o.website });
  const org = await q.one(
    `INSERT INTO organizations (type, name, name_norm, registration_number, registration_norm, website, domain, country, city, industry,
        contact_email, contact_phone, claimed, source, created_by, potential_duplicate_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,'self_registered',$13,$14) RETURNING *`,
    [type, o.name.trim(), normName(o.name), o.registration_number || null, o.registration_number ? normIdentity(o.registration_number) : null,
      o.website || null, domainOf(o.website), o.country || null, o.city || null, o.industry || null,
      user.email, o.contact_phone || null, user.id, dups[0]?.id || null]);
  await q.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'owner')`, [user.id, org.id]);
  await audit(q, { userId: user.id, role: user.role }, { action: 'org.created', entityType: 'organization', entityId: org.id, details: { type, potential_duplicate: !!dups[0] } });
  return org;
}

function membershipOf(actor, orgId) {
  return actor.orgs.find((o) => o.orgId === orgId) || null;
}
function requireMember(actor, orgId, { owner = false } = {}) {
  const m = membershipOf(actor, orgId);
  if (!m || (owner && m.role !== 'owner')) throw E.notFound('organization'); // do not reveal other orgs exist
  return m;
}

async function getMine(ctx, actor) {
  const m = actor.orgs[0];
  if (!m) throw E.notFound('organization');
  const org = await ctx.db.one('SELECT * FROM organizations WHERE id=$1', [m.orgId]);
  const { owner_user_id, introduced_by, potential_duplicate_of, ...own } = org; // internal fields stay internal
  return { ...own, my_role: m.role };
}

async function updateMine(ctx, actor, orgId, patch, version) {
  P.require(actor, 'onboard:org');
  requireMember(actor, orgId, { owner: true });
  const cur = await ctx.db.one('SELECT * FROM organizations WHERE id=$1', [orgId]);
  if (version !== undefined && version !== cur.version) throw E.conflict('version_conflict', 'The company was changed elsewhere. Reload and retry.', { current_version: cur.version });
  const f = { ...patch };
  const next = {
    name: f.name ?? cur.name, legal_name: f.legal_name ?? cur.legal_name, registration_number: f.registration_number ?? cur.registration_number,
    website: f.website ?? cur.website, country: f.country ?? cur.country, city: f.city ?? cur.city, industry: f.industry ?? cur.industry,
    description: f.description ?? cur.description, contact_phone: f.contact_phone ?? cur.contact_phone,
    public_profile: f.public_profile ?? cur.public_profile, recruitment_mode: cur.recruitment_mode,
  };
  const row = await ctx.db.tx(async (q) => {
    const r = await q.one(
      `UPDATE organizations SET name=$2, name_norm=$3, legal_name=$4, registration_number=$5, registration_norm=$6, website=$7, domain=$8,
              country=$9, city=$10, industry=$11, description=$12, contact_phone=$13, public_profile=$14, updated_at=now(), version=version+1
        WHERE id=$1 AND version=$15 RETURNING *`,
      [orgId, next.name, normName(next.name), next.legal_name, next.registration_number, next.registration_number ? normIdentity(next.registration_number) : null,
        next.website, domainOf(next.website), next.country, next.city, next.industry, next.description, next.contact_phone, next.public_profile, cur.version]);
    if (!r) throw E.conflict('version_conflict', 'The company was changed elsewhere. Reload and retry.');
    await audit(q, actor, { action: 'org.updated', entityType: 'organization', entityId: orgId, details: { fields: Object.keys(patch) } });
    return r;
  });
  return row;
}

async function submitVerification(ctx, actor, orgId, payload) {
  P.require(actor, 'onboard:org');
  requireMember(actor, orgId, { owner: true });
  const cur = await ctx.db.one('SELECT verification_status FROM organizations WHERE id=$1', [orgId]);
  if (cur.verification_status === 'submitted') throw E.conflict('already_submitted', 'A review is already in progress');
  if (cur.verification_status === 'verified') throw E.conflict('already_verified', 'This company is already verified');
  await ctx.db.tx(async (q) => {
    await q.query(`INSERT INTO org_verification_submissions (org_id, submitted_by, payload) VALUES ($1,$2,$3)`, [orgId, actor.userId, JSON.stringify(payload)]);
    await q.query(`UPDATE organizations SET verification_status='submitted', verification_note=NULL,
        registration_number=COALESCE($2, registration_number), registration_norm=COALESCE($3, registration_norm), website=COALESCE($4, website),
        domain=COALESCE($5, domain), updated_at=now(), version=version+1 WHERE id=$1`,
      [orgId, payload.registration_number || null, payload.registration_number ? normIdentity(payload.registration_number) : null, payload.website || null, domainOf(payload.website)]);
    await audit(q, actor, { action: 'org.verification_submitted', entityType: 'organization', entityId: orgId });
  });
}

async function verificationQueue(ctx, actor) {
  P.require(actor, 'orgs:verify');
  return ctx.db.rows(
    `SELECT o.id, o.name, o.type, o.country, o.registration_number, o.website, o.verification_status, o.potential_duplicate_of, o.created_at,
            (SELECT payload FROM org_verification_submissions s WHERE s.org_id=o.id ORDER BY s.created_at DESC LIMIT 1) AS submission
       FROM organizations o WHERE o.verification_status='submitted' ORDER BY o.created_at ASC LIMIT 200`);
}

async function reviewVerification(ctx, actor, orgId, { decision, note }) {
  P.require(actor, 'orgs:verify');
  const map = { verified: 'verified', rejected: 'rejected', changes_requested: 'changes_requested' };
  if (!map[decision]) throw E.badRequest('invalid_decision', 'decision must be verified, rejected or changes_requested');
  if (decision !== 'verified' && !note) throw E.unprocessable('reason_required', 'A reason is required');
  const org = await ctx.db.one('SELECT * FROM organizations WHERE id=$1', [orgId]);
  if (!org) throw E.notFound('organization');
  if (org.verification_status !== 'submitted') throw E.conflict('not_pending_review', 'No review is pending for this company');
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE organizations SET verification_status=$2, verification_note=$3, verified_by=$4, verified_at=$5, updated_at=now(), version=version+1 WHERE id=$1`,
      [orgId, decision, note || null, decision === 'verified' ? actor.userId : null, decision === 'verified' ? ctx.clock.now() : null]);
    await q.query(`UPDATE org_verification_submissions SET status=$2, reviewed_by=$3, reviewed_at=$4, review_note=$5
        WHERE id = (SELECT id FROM org_verification_submissions WHERE org_id=$1 ORDER BY created_at DESC LIMIT 1)`, [orgId, decision, actor.userId, ctx.clock.now(), note || null]);
    const owner = await q.one(`SELECT user_id FROM memberships WHERE org_id=$1 AND role='owner' LIMIT 1`, [orgId]);
    await notify(q, owner?.user_id, 'org.verification_decided', { org_id: orgId, decision, note: note || null });
    await audit(q, actor, { action: `org.verification_${decision}`, entityType: 'organization', entityId: orgId, details: { note: note || null } });
  });
}

async function staffCreate(ctx, actor, input) {
  P.require(actor, 'orgs:create');
  const dups = await findDuplicateOrgs(ctx.db, { name: input.name, registration: input.registration_number, website: input.website });
  if (dups.length && !input.confirm_not_duplicate) {
    throw E.conflict('possible_duplicate', 'Similar companies already exist. Review them, then resubmit with confirm_not_duplicate.', { matches: dups });
  }
  return ctx.db.tx(async (q) => {
    const org = await q.one(
      `INSERT INTO organizations (type, name, name_norm, registration_number, registration_norm, website, domain, country, city, industry, description,
          contact_email, contact_phone, claimed, source, introduced_by, owner_user_id, created_by, relationship_status, last_contact_at)
       VALUES ('employer',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13,$14,$14,$14,'prospect',$15) RETURNING *`,
      [input.name.trim(), normName(input.name), input.registration_number || null, input.registration_number ? normIdentity(input.registration_number) : null,
        input.website || null, domainOf(input.website), input.country || null, input.city || null, input.industry || null, input.description || null,
        input.contact_email || null, input.contact_phone || null, input.source || null, actor.userId, input.last_contact_at || null]);
    await audit(q, actor, { action: 'org.staff_created', entityType: 'organization', entityId: org.id, details: { source: input.source || null } });
    return org;
  });
}

async function listForStaff(ctx, actor, { q: search, limit = 50, offset = 0 } = {}) {
  if (!P.can(actor, 'orgs:view_all') && !P.can(actor, 'orgs:view_assigned')) P.require(actor, 'orgs:view_assigned');
  const all = P.can(actor, 'orgs:view_all');
  return ctx.db.rows(
    `SELECT o.*, (SELECT count(*)::int FROM jobs j WHERE j.org_id=o.id AND j.status='published') AS active_vacancies,
            GREATEST(0, EXTRACT(DAY FROM now() - o.last_contact_at)::int) AS days_since_contact
       FROM organizations o
      WHERE ($1 OR o.owner_user_id = $2) AND ($3::text IS NULL OR o.name_norm LIKE $3)
      ORDER BY o.created_at DESC LIMIT $4 OFFSET $5`,
    [all, actor.userId, search ? `%${normName(search)}%` : null, Math.min(limit, 100), offset]);
}

async function getForStaff(ctx, actor, orgId) {
  const org = await ctx.db.one('SELECT * FROM organizations WHERE id=$1', [orgId]);
  if (!org) throw E.notFound('organization');
  if (!P.can(actor, 'orgs:view_all')) {
    P.require(actor, 'orgs:view_assigned');
    if (org.owner_user_id !== actor.userId) throw E.notFound('organization');
  }
  return org;
}

async function logContact(ctx, actor, orgId, { note, next_action, next_action_at }) {
  const org = await getForStaff(ctx, actor, orgId);
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE organizations SET last_contact_at=$2, next_action=$3, next_action_at=$4, updated_at=now() WHERE id=$1`,
      [org.id, ctx.clock.now(), next_action || null, next_action_at || null]);
    if (note) await q.query(`INSERT INTO internal_notes (entity_type, entity_id, author_id, body) VALUES ('organization',$1,$2,$3)`, [org.id, actor.userId, note]);
    await audit(q, actor, { action: 'org.contact_logged', entityType: 'organization', entityId: org.id });
  });
}

async function setRecruitmentMode(ctx, actor, orgId, mode) {
  P.require(actor, 'orgs:view_all');
  if (!['direct', 'managed'].includes(mode)) throw E.badRequest('invalid_mode', 'mode must be direct or managed');
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE organizations SET recruitment_mode=$2, updated_at=now(), version=version+1 WHERE id=$1', [orgId, mode]);
    await audit(q, actor, { action: 'org.recruitment_mode_set', entityType: 'organization', entityId: orgId, details: { mode } });
  });
}

// Public directory: only companies that are verified AND opted in. Never shows internal fields.
async function publicList(ctx, { q: search, country, limit = 20, offset = 0 }) {
  return ctx.db.rows(
    `SELECT ${PUBLIC_FIELDS}, (SELECT count(*)::int FROM jobs j WHERE j.org_id=o.id AND j.status='published') AS open_jobs
       FROM organizations o WHERE o.type='employer' AND o.verification_status='verified' AND o.public_profile = true
        AND ($1::text IS NULL OR o.name_norm LIKE $1) AND ($2::text IS NULL OR lower(o.country)=lower($2))
      ORDER BY o.name LIMIT $3 OFFSET $4`,
    [search ? `%${normName(search)}%` : null, country || null, Math.min(limit, 50), offset]);
}
async function publicGet(ctx, id) {
  const o = await ctx.db.one(`SELECT ${PUBLIC_FIELDS} FROM organizations o WHERE o.id=$1 AND o.type='employer' AND o.verification_status='verified' AND o.public_profile=true`, [id]);
  if (!o) throw E.notFound('company');
  return o;
}

module.exports = {
  createForRegistration, getMine, updateMine, submitVerification, verificationQueue, reviewVerification, staffCreate, listForStaff,
  getForStaff, logContact, setRecruitmentMode, publicList, publicGet, requireMember, membershipOf, findDuplicateOrgs,
};
