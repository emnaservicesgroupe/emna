'use strict';
// Inbound webhooks from connected systems: signed, timestamped, idempotent, order-safe, conflict-aware.
const C = require('../lib/crypto');
const { E } = require('../lib/errors');
const { getSetting } = require('../context');
const { SYSTEM, audit } = require('../services/audit');
const cases = require('../services/cases');
const secrets = require('./secrets');
const adapter = require('./trustcrm/adapter');
const client = require('./trustcrm/client');

const KNOWN_SOURCES = ['trustcrm'];

function verifySignature(ctx, scopeSecrets, rawBody, headerValue) {
  const h = secrets.parseHeader(headerValue);
  if (!h.t || !h.v1) throw E.unauthorized('signature_missing', 'Missing or malformed signature header');
  const t = Number(h.t);
  const skew = Math.abs(ctx.clock.now().getTime() / 1000 - t);
  if (!Number.isFinite(t) || skew > ctx.config.inboundWebhookToleranceSeconds) throw E.unauthorized('signature_stale', 'Signature timestamp is outside the allowed window');
  const candidates = h.kid ? scopeSecrets.filter((s) => s.kid === h.kid) : scopeSecrets;
  const ok = candidates.some((s) => C.safeEqual(secrets.sign(s.secret, h.t, rawBody), h.v1));
  if (!ok) throw E.unauthorized('signature_invalid', 'Signature verification failed');
  return h.kid || null;
}

async function receive(ctx, source, rawBody, signatureHeader) {
  if (!KNOWN_SOURCES.includes(source)) throw E.notFound('integration');
  const active = await secrets.active(ctx, `inbound:${source}`);
  if (!active.length) throw E.unauthorized('no_secret_configured', 'No signing secret is configured for this integration');
  const kid = verifySignature(ctx, active, rawBody, signatureHeader);
  let ev; try { ev = JSON.parse(rawBody); } catch (_) { throw E.badRequest('invalid_json', 'Body is not valid JSON'); }
  if (!ev || typeof ev.id !== 'string' || typeof ev.type !== 'string' || !ev.occurred_at || Number.isNaN(Date.parse(ev.occurred_at))) {
    throw E.badRequest('invalid_event', 'id, type and occurred_at are required');
  }
  return process(ctx, source, ev, { kid, rawBody });
}

async function process(ctx, source, ev, { kid = null } = {}) {
  const ins = await ctx.db.one(
    `INSERT INTO inbound_events (source, event_id, type, occurred_at, kid, payload) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (source, event_id) DO NOTHING RETURNING id`, [source, ev.id, ev.type, ev.occurred_at, kid, JSON.stringify(ev)]);
  if (!ins) return { status: 'duplicate', applied: false };          // replay or provider retry: processed once only
  let result;
  try {
    result = await apply(ctx, source, ev);
    await ctx.db.query(`UPDATE inbound_events SET status=$2, error=$3, processed_at=$4 WHERE id=$1`, [ins.id, result.status, result.detail || null, ctx.clock.now()]);
  } catch (err) {
    await ctx.db.query(`UPDATE inbound_events SET status='failed', error=$2, processed_at=$3 WHERE id=$1`, [ins.id, String(err.message).slice(0, 500), ctx.clock.now()]);
    throw err;
  }
  return { status: result.status, applied: result.status === 'applied', detail: result.detail || null };
}

async function reverseStageMap(ctx) {
  const map = await getSetting(ctx, 'crm.case_stage_map', {});
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [String(v).toLowerCase(), k]));
}

async function applyStage(ctx, ev) {
  const d = ev.data || {};
  const mapping = await ctx.db.one(`SELECT * FROM external_mappings WHERE system='trustcrm' AND entity_type='candidate' AND external_id=$1`, [String(d.external_id)]);
  if (!mapping) return { status: 'ignored', detail: 'unmapped_external_id' };
  const kase = await ctx.db.one(`SELECT * FROM recruitment_cases WHERE candidate_id=$1 AND stage <> 'closed' ORDER BY created_at DESC LIMIT 1`, [mapping.canonical_id]);
  if (!kase) return { status: 'ignored', detail: 'no_active_case' };
  const cm = await adapter.caseMappingFor(ctx.db, kase.id);
  const occurred = new Date(ev.occurred_at);
  if (cm?.last_event_at && occurred <= cm.last_event_at) return { status: 'stale_ignored', detail: 'older_than_last_applied_event' };
  const target = (await reverseStageMap(ctx))[String(d.stage || '').toLowerCase()];
  if (!target) return { status: 'failed', detail: `unmapped_stage:${d.stage}` };
  const hash = adapter.hashOf({ stage: target });
  const touch = async (q, version) => {
    if (cm) await q.query(`UPDATE external_mappings SET last_event_at=$2, last_synced_at=$3, canonical_version=$4, content_hash=$5, sync_origin='trustcrm' WHERE id=$1`, [cm.id, occurred, ctx.clock.now(), version, hash]);
    else await q.query(`INSERT INTO external_mappings (system, entity_type, canonical_id, external_id, canonical_version, last_event_at, last_synced_at, sync_origin, content_hash) VALUES ('trustcrm','case',$1,$2,$3,$4,$5,'trustcrm',$6)`, [kase.id, `${mapping.external_id}:${kase.id}`, version, occurred, ctx.clock.now(), hash]);
  };
  if (target === kase.stage) { await touch(ctx.db, kase.version); return { status: 'ignored', detail: 'already_in_stage' }; }
  // Local edits made after the last sync and disagreeing with the remote value go to human review, not silent overwrite.
  if (cm && kase.version > cm.canonical_version) {
    await ctx.db.query(
      `INSERT INTO sync_conflicts (system, entity_type, canonical_id, field, local_value, remote_value, remote_event_at) VALUES ('trustcrm','case',$1,'stage',$2,$3,$4)
       ON CONFLICT (system, entity_type, canonical_id, field) WHERE status='open' DO UPDATE SET remote_value=EXCLUDED.remote_value, remote_event_at=EXCLUDED.remote_event_at`,
      [kase.id, JSON.stringify(kase.stage), JSON.stringify(target), occurred]);
    return { status: 'conflict', detail: `local:${kase.stage} remote:${target}` };
  }
  await ctx.db.tx(async (q) => {
    const cur = await q.one('SELECT * FROM recruitment_cases WHERE id=$1 FOR UPDATE', [kase.id]);
    const row = await cases.advanceInternal(q, SYSTEM, cur, target, { reason: 'Synced from trust-crm', origin: 'trustcrm' });
    await touch(q, row.version);
  });
  return { status: 'applied' };
}

async function applyCandidateUpdate(ctx, ev) {
  const d = ev.data || {};
  const mapping = await ctx.db.one(`SELECT * FROM external_mappings WHERE system='trustcrm' AND entity_type='candidate' AND external_id=$1`, [String(d.external_id)]);
  if (!mapping) return { status: 'ignored', detail: 'unmapped_external_id' };
  const occurred = new Date(ev.occurred_at);
  if (mapping.last_event_at && occurred <= mapping.last_event_at) return { status: 'stale_ignored', detail: 'older_than_last_applied_event' };
  const f = d.fields || {};
  // trust-crm owns passport_expiry; every other inbound field is ignored (FIND WAY owns the profile)
  if (f.passport_expiry !== undefined) {
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE candidate_identity_refs SET expiry_date=$2 WHERE id = (SELECT id FROM candidate_identity_refs WHERE candidate_id=$1 AND kind='passport' ORDER BY created_at DESC LIMIT 1)`, [mapping.canonical_id, f.passport_expiry]);
      await q.query(`UPDATE external_mappings SET last_event_at=$2, last_synced_at=$3, sync_origin='trustcrm' WHERE id=$1`, [mapping.id, occurred, ctx.clock.now()]);
      await audit(q, SYSTEM, { action: 'sync.passport_expiry_updated', entityType: 'candidate', entityId: mapping.canonical_id });
    });
    return { status: 'applied' };
  }
  return { status: 'ignored', detail: 'no_fields_owned_by_trustcrm' };
}

async function apply(ctx, source, ev) {
  if (ev.type === 'candidate.stage_changed') return applyStage(ctx, ev);
  if (ev.type === 'candidate.updated') return applyCandidateUpdate(ctx, ev);
  return { status: 'ignored', detail: `unsupported_event_type:${ev.type}` };
}

// Polling fallback: trust-crm has no webhook emitter today, so drift is detected by comparing mapped records.
async function reconcile(ctx) {
  const maps = await ctx.db.rows(`SELECT * FROM external_mappings WHERE system='trustcrm' AND entity_type='candidate'`);
  const out = { checked: 0, applied: 0, conflicts: 0, unchanged: 0, errors: 0 };
  for (const m of maps) {
    out.checked++;
    try {
      const remote = await client.request(ctx, 'GET', `/candidates/${m.external_id}`);
      const stamp = remote.updated_at || new Date().toISOString();
      const stageEv = { id: `reconcile:${m.external_id}:stage:${C.sha256(`${remote.visa_status}|${stamp}`).slice(0, 16)}`, type: 'candidate.stage_changed', occurred_at: stamp, data: { external_id: m.external_id, stage: remote.visa_status } };
      const r1 = await process(ctx, 'trustcrm', stageEv, { kid: 'reconcile' });
      const expEv = { id: `reconcile:${m.external_id}:passport:${C.sha256(`${remote.passport_expiry}|${stamp}`).slice(0, 16)}`, type: 'candidate.updated', occurred_at: stamp, data: { external_id: m.external_id, fields: { passport_expiry: remote.passport_expiry ? String(remote.passport_expiry).slice(0, 10) : null } } };
      const r2 = await process(ctx, 'trustcrm', expEv, { kid: 'reconcile' });
      if (r1.status === 'applied' || r2.status === 'applied') out.applied++;
      else if (r1.status === 'conflict') out.conflicts++;
      else out.unchanged++;
    } catch (e) { out.errors++; ctx.log.warn('reconcile error', { external_id: m.external_id, error: e.message }); }
  }
  return out;
}

module.exports = { receive, process, reconcile, verifySignature };
