'use strict';
// Adapter FIND WAY -> trust-crm. See docs/INTEGRATION.md "Field ownership" for what flows where.
const C = require('../../lib/crypto');
const { normIdentity } = require('../../lib/normalize');
const { getSetting } = require('../../context');
const candidates = require('../../services/candidates');
const client = require('./client');
const { PermanentError } = require('../errors');

const SYSTEM = 'trustcrm';
const hashOf = (obj) => C.sha256(JSON.stringify(obj));

async function mappingFor(db, candidateId) {
  return db.one(`SELECT * FROM external_mappings WHERE system=$1 AND entity_type='candidate' AND canonical_id=$2`, [SYSTEM, candidateId]);
}

// FIND WAY-owned fields pushed to trust-crm (docs/INTEGRATION.md). Passport expiry flows the other way.
async function buildPayload(ctx, cand) {
  const id = await candidates.readIdentityForSync(ctx, cand.id, 'passport');
  if (!id) return null;
  return {
    full_name: cand.full_name,
    nationality: cand.nationality || null,
    date_of_birth: cand.date_of_birth || null,
    passport_number: id.number,
    passport_expiry: id.expiry_date || null,
  };
}

async function isQualified(ctx, candidateId) {
  const r = await ctx.db.one(`SELECT 1 FROM leads WHERE candidate_id=$1 AND status='qualified' LIMIT 1`, [candidateId]);
  return !!r;
}

async function ensureCandidate(ctx, candidateId) {
  const cand = await ctx.db.one('SELECT * FROM candidates WHERE id=$1', [candidateId]);
  if (!cand) return { status: 'skipped', detail: { reason: 'candidate_not_found' } };
  if (cand.merged_into) return { status: 'skipped', detail: { reason: 'candidate_merged' } };
  const mapping = await mappingFor(ctx.db, candidateId);
  if (!mapping && !(await isQualified(ctx, candidateId))) return { status: 'skipped', detail: { reason: 'not_qualified_yet' } };
  const payload = await buildPayload(ctx, cand);
  if (!payload) return { status: 'blocked', detail: { reason: 'missing_passport_number', hint: 'Record the passport number on the candidate; the delivery will be re-evaluated on the next candidate update.' } };
  const hash = hashOf(payload);

  if (mapping) {
    // An existing trust-crm record that we merely linked is never overwritten from FIND WAY.
    if (mapping.link_mode === 'linked_existing') return { status: 'skipped', detail: { reason: 'linked_existing_record_not_overwritten', external_id: mapping.external_id } };
    if (mapping.content_hash === hash) return { status: 'skipped', detail: { reason: 'no_change' } };
    // optimistic concurrency: only push if nobody changed the canonical record after the version we are sending
    await client.request(ctx, 'PUT', `/candidates/${mapping.external_id}`, payload);
    await ctx.db.query(`UPDATE external_mappings SET canonical_version=$2, content_hash=$3, last_synced_at=$4, sync_origin='findway' WHERE id=$1`, [mapping.id, cand.version, hash, ctx.clock.now()]);
    return { status: 'succeeded', detail: { action: 'updated', external_id: mapping.external_id } };
  }

  // Never create a second record for someone trust-crm already knows: look the passport up first.
  const found = await client.request(ctx, 'GET', `/candidates/all?search=${encodeURIComponent(payload.passport_number)}`);
  const existing = (Array.isArray(found) ? found : []).find((r) => normIdentity(r.passport_number) === normIdentity(payload.passport_number));
  if (existing) {
    await ctx.db.query(
      `INSERT INTO external_mappings (system, entity_type, canonical_id, external_id, canonical_version, last_synced_at, sync_origin, content_hash, link_mode)
       VALUES ($1,'candidate',$2,$3,$4,$5,'findway',$6,'linked_existing')`, [SYSTEM, candidateId, String(existing.id), cand.version, ctx.clock.now(), hashOf({ linked: existing.id })]);
    return { status: 'succeeded', detail: { action: 'linked_existing', external_id: String(existing.id), note: 'Existing trust-crm record linked without overwriting it' } };
  }
  const created = await client.request(ctx, 'POST', '/candidates/add', payload);
  await ctx.db.query(
    `INSERT INTO external_mappings (system, entity_type, canonical_id, external_id, canonical_version, last_synced_at, sync_origin, content_hash)
     VALUES ($1,'candidate',$2,$3,$4,$5,'findway',$6)`, [SYSTEM, candidateId, String(created.id), cand.version, ctx.clock.now(), hash]);
  return { status: 'succeeded', detail: { action: 'created', external_id: String(created.id) } };
}

async function caseMappingFor(db, caseId) {
  return db.one(`SELECT * FROM external_mappings WHERE system=$1 AND entity_type='case' AND canonical_id=$2`, [SYSTEM, caseId]);
}

async function pushCaseStage(ctx, event) {
  const kase = await ctx.db.one('SELECT * FROM recruitment_cases WHERE id=$1', [event.aggregate_id]);
  if (!kase) return { status: 'skipped', detail: { reason: 'case_not_found' } };
  let cm = await mappingFor(ctx.db, kase.candidate_id);
  if (!cm) {
    const r = await ensureCandidate(ctx, kase.candidate_id);
    if (r.status !== 'succeeded') return { status: r.status === 'skipped' ? 'blocked' : r.status, detail: { reason: 'candidate_not_in_trustcrm', ...r.detail } };
    cm = await mappingFor(ctx.db, kase.candidate_id);
  }
  const map = await getSetting(ctx, 'crm.case_stage_map', {});
  const stageText = map[kase.stage];
  if (!stageText) return { status: 'blocked', detail: { reason: 'unmapped_stage', stage: kase.stage } };
  const hash = hashOf({ stage: kase.stage });
  const sm = await caseMappingFor(ctx.db, kase.id);
  if (sm && sm.content_hash === hash) return { status: 'skipped', detail: { reason: 'no_change' } };
  try {
    await client.request(ctx, 'POST', `/candidates/${cm.external_id}/stage`, { stage: stageText, status: 'Pending', notes: `Synced from FIND WAY case ${kase.reference_no}` });
  } catch (e) {
    if (e instanceof PermanentError && e.detail?.status === 404) return { status: 'blocked', detail: { reason: 'trustcrm_has_no_visa_application_for_candidate', message: e.message } };
    throw e;
  }
  if (sm) await ctx.db.query(`UPDATE external_mappings SET content_hash=$2, canonical_version=$3, last_synced_at=$4, sync_origin='findway' WHERE id=$1`, [sm.id, hash, kase.version, ctx.clock.now()]);
  else await ctx.db.query(
    `INSERT INTO external_mappings (system, entity_type, canonical_id, external_id, canonical_version, last_synced_at, sync_origin, content_hash)
     VALUES ($1,'case',$2,$3,$4,$5,'findway',$6)`, [SYSTEM, kase.id, `${cm.external_id}:${kase.id}`, kase.version, ctx.clock.now(), hash]);
  return { status: 'succeeded', detail: { action: 'stage_pushed', stage: stageText } };
}

// Events the adapter acts on; everything else is recorded as skipped (not applicable), never silently dropped.
async function handle(ctx, event) {
  switch (event.type) {
    case 'lead.qualified': return ensureCandidate(ctx, event.data.candidate_id);
    case 'candidate.updated': return ensureCandidate(ctx, event.aggregate_id);
    case 'placement.updated': return pushCaseStage(ctx, event);
    default: return { status: 'skipped', detail: { reason: 'event_not_applicable_to_trustcrm', type: event.type } };
  }
}

module.exports = { handle, ensureCandidate, caseMappingFor, mappingFor, hashOf, SYSTEM };
