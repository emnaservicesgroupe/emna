import { get, post, put, ApiError } from '../api.js';
import { t, tEnum, tError } from '../i18n.js';
import { h, field, checkbox, form, empty, toast, badge, enumBadge, confirmReason, dl, val, userText, table, statusKind, copyButton } from '../ui.js';
import { fmtDateTime, fmtNumber } from '../format.js';
import { can, state } from '../store.js';
import { go, render } from '../router.js';
import { salaryText } from './public.js';

const C = (perm) => ({ auth: true, area: 'crm', perm });
export function registerAdmin(route) {
  route('/crm/approvals', approvals, C('users:approve')); route('/crm/company-verifications', verifications, C('orgs:verify'));
  route('/crm/job-reviews', jobReviews, C('jobs:review')); route('/crm/job-reviews/:id', jobReview, C('jobs:review'));
  route('/crm/staff', staff, C('users:approve')); route('/crm/integrations', integrations, C('integrations:view')); route('/crm/audit', audit, C('audit:read'));
}
const act = (fn) => async () => { try { await fn(); render(); } catch (e) { toast(tError(e), 'bad'); } };

async function approvals() {
  const rows = await get('/admin/approvals');
  const decide = async (u, decision) => {
    let note = '';
    if (decision === 'rejected') { note = await confirmReason({ title: t('crm.reject'), label: t('common.reason'), confirmLabel: t('crm.reject'), danger: true }); if (note === null) return; }
    try { await post(`/admin/users/${u.id}/approval`, { decision, note: note || null }); toast(t('common.saved')); render(); } catch (e) { toast(tError(e), 'bad'); }
  };
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.approvals')), h('p', { class: 'muted' }, t('crm.approvals_note')),
    table([{ label: t('auth.full_name'), render: (u) => userText('span', u.full_name) }, { label: t('auth.email'), render: (u) => h('span', { dir: 'ltr' }, u.email) }, { label: t('common.role'), render: (u) => enumBadge('role', u.role) },
      { label: t('company.title'), render: (u) => (u.org_name ? h('span', {}, userText('span', u.org_name), ' ', u.potential_duplicate_of ? badge(t('crm.possible_dup'), 'warn') : null) : '—') }, { label: t('emp.verification'), render: (u) => (u.verification_status ? enumBadge('verification', u.verification_status) : '—') },
      { label: t('common.created'), render: (u) => fmtDateTime(u.created_at) },
      { label: '', render: (u) => h('div', { class: 'btn-row' }, h('button', { class: 'btn small', type: 'button', onclick: () => decide(u, 'approved') }, t('crm.approve')), h('button', { class: 'btn secondary small', type: 'button', onclick: () => decide(u, 'rejected') }, t('crm.reject'))) }], rows,
      { empty: empty(t('crm.no_approvals'), t('crm.no_approvals_text')) }));
}

async function verifications() {
  const rows = await get('/admin/org-verifications');
  const decide = async (o, decision) => {
    let note = '';
    if (decision !== 'verified') { note = await confirmReason({ title: t(`crm.${decision}`), label: t('common.reason'), confirmLabel: t(`crm.${decision}`) }); if (note === null) return; }
    try { await post(`/admin/orgs/${o.id}/verification`, { decision, note: note || null }); toast(t('common.saved')); render(); } catch (e) { toast(tError(e), 'bad'); }
  };
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.verifications')), h('p', { class: 'muted' }, t('crm.verifications_note')),
    table([{ label: t('company.title'), render: (o) => h('span', {}, userText('strong', o.name), ' ', o.potential_duplicate_of ? badge(t('crm.possible_dup'), 'warn') : null) }, { label: t('common.type'), render: (o) => tEnum('orgtype', o.type) }, { label: t('prof.country'), render: (o) => userText('span', o.country) },
      { label: t('emp.reg_no'), render: (o) => h('span', { class: 'mono' }, o.registration_number || '—') }, { label: t('company.website'), render: (o) => userText('span', o.website) }, { label: t('emp.verify_notes'), render: (o) => userText('span', o.submission?.notes) },
      { label: '', render: (o) => h('div', { class: 'btn-row' }, h('button', { class: 'btn small', type: 'button', onclick: () => decide(o, 'verified') }, t('crm.verify')), h('button', { class: 'btn secondary small', type: 'button', onclick: () => decide(o, 'changes_requested') }, t('crm.changes_requested')), h('button', { class: 'btn secondary small', type: 'button', onclick: () => decide(o, 'rejected') }, t('crm.rejected'))) }], rows,
      { empty: empty(t('crm.no_verifications'), t('crm.no_verifications_text')) }));
}

async function jobReviews() {
  const rows = await get('/admin/job-reviews');
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.job_reviews')), table([{ label: t('job.title'), render: (j) => h('a', { href: `#/crm/job-reviews/${j.id}`, dir: 'auto' }, j.title) }, { label: t('job.ref'), key: 'reference_no' }, { label: t('company.title'), render: (j) => userText('span', j.employer) },
    { label: t('emp.verification'), render: (j) => enumBadge('verification', j.verification_status) }, { label: t('job.location'), render: (j) => userText('span', [j.city, j.country].filter(Boolean).join(', ')) },
    { label: t('common.note'), render: (j) => (j.published_version > 0 ? badge(t('crm.edited_live'), 'warn') : badge(t('crm.new_job'), '')) }], rows, { empty: empty(t('crm.no_job_reviews'), t('crm.no_job_reviews_text')) }));
}
const fmtVal = (v) => (v === null || v === undefined ? t('common.not_specified') : typeof v === 'object' ? JSON.stringify(v) : String(v));
async function jobReview({ params }) {
  const { job: j, pending_material_changes: changes } = await get(`/admin/jobs/${params.id}/review`);
  const decision = field({ label: t('crm.decision'), name: 'decision', options: [{ value: 'approve', label: t('crm.approve') }, { value: 'request_changes', label: t('crm.request_changes') }, { value: 'reject', label: t('crm.reject') }] });
  const note = field({ label: t('common.note'), name: 'note', textarea: true, rows: 3, hint: t('crm.note_to_employer') });
  const override = field({ label: t('crm.override_reason'), name: 'override_unverified_reason', hint: t('crm.override_hint') }); const overrideBox = h('div', { hidden: true }, override.el);
  const f = form({ submitLabel: t('crm.submit_decision'), children: [decision.el, note.el, overrideBox], onSubmit: async () => {
    if (decision.input.value !== 'approve' && !note.input.value.trim()) { const e = new ApiError(422, { error: { code: 'reason_required' } }); throw e; }
    try { await post(`/admin/jobs/${j.id}/review`, { decision: decision.input.value, note: val(note.input), override_unverified_reason: val(override.input) }); toast(t('common.saved')); go('/crm/job-reviews'); }
    catch (e) { if (e instanceof ApiError && e.code === 'employer_not_verified') overrideBox.hidden = false; throw e; }
  } });
  return h('div', { class: 'stack' }, h('p', {}, h('a', { href: '#/crm/job-reviews' }, h('span', { class: 'flip', 'aria-hidden': 'true' }, '←'), ' ', t('crm.job_reviews'))), h('h1', { dir: 'auto' }, j.title),
    j.employer_verification !== 'verified' ? h('p', { class: 'notice warn' }, t('crm.employer_unverified', { status: tEnum('verification', j.employer_verification) })) : null,
    changes.length ? h('section', { class: 'card notice warn' }, h('h2', {}, t('crm.material_changes')), h('p', {}, t('crm.material_note')), h('ul', {}, changes.map((c) => h('li', {}, h('strong', {}, tEnum('field', c.field)), ': ', fmtVal(c.from), ' → ', fmtVal(c.to))))) : null,
    h('section', { class: 'card' }, dl([[t('job.ref'), j.reference_no], [t('company.title'), userText('span', j.employer_name)], [t('job.profession'), userText('span', j.profession)], [t('job.location'), userText('span', [j.address, j.city, j.country].filter(Boolean).join(', '))],
      [t('job.salary'), salaryText(j.salary_specified ? { specified: true, min: j.salary_min, max: j.salary_max, currency: j.salary_currency, period: j.salary_period, basis: j.salary_basis } : { specified: false })], [t('job.employment_type'), tEnum('etype', j.employment_type)],
      [t('job.description'), userText('span', j.description, { class: 'pre' })], [t('job.requirements'), userText('span', j.requirements, { class: 'pre' })], [t('job.responsibilities'), userText('span', j.responsibilities, { class: 'pre' })], [t('job.deadline'), j.deadline || t('common.not_specified')]])),
    h('section', { class: 'card' }, h('h2', {}, t('crm.decision')), f));
}

async function staff() {
  const rows = await get('/admin/users', { query: { limit: 100 } }); const team = await get('/staff/team');
  const email = field({ label: t('auth.email'), name: 'email', type: 'email', required: true }); const name = field({ label: t('auth.full_name'), name: 'full_name', required: true });
  const roleSel = field({ label: t('common.role'), name: 'role', options: [{ value: 'staff', label: tEnum('role', 'staff') }, ...(state.me.role === 'super_admin' ? [{ value: 'admin', label: tEnum('role', 'admin') }] : [])] });
  const create = form({ submitLabel: t('crm.create_user'), children: [h('div', { class: 'grid cols-3' }, email.el, name.el, roleSel.el), h('p', { class: 'small muted' }, t('crm.invite_note'))], onSubmit: async () => { await post('/admin/users', { email: email.input.value.trim(), full_name: name.input.value.trim(), role: roleSel.input.value }); toast(t('common.saved')); render(); } });
  const suspend = async (u) => { if (u.status === 'suspended') return act(() => post(`/admin/users/${u.id}/suspension`, { suspended: false }))(); const r = await confirmReason({ title: t('crm.suspend'), label: t('common.reason'), confirmLabel: t('crm.suspend'), danger: true }); if (r === null) return; await act(() => post(`/admin/users/${u.id}/suspension`, { suspended: true, reason: r }))(); };
  const etype = field({ label: t('crm.entity'), name: 'entity_type', options: ['lead', 'candidate', 'organization', 'case'].map((v) => ({ value: v, label: tEnum('entity', v) })) }); const eid = field({ label: t('crm.entity_id'), name: 'entity_id', required: true, hint: t('crm.entity_id_hint') });
  const to = field({ label: t('crm.assignee'), name: 'to_user_id', options: team.map((m) => ({ value: m.id, label: `${m.full_name} (${tEnum('role', m.role)})` })) }); const why = field({ label: t('common.reason'), name: 'reason', required: true });
  const reassign = can('assignments:manage') ? h('section', { class: 'card' }, h('h2', {}, t('crm.reassign')), h('p', { class: 'small muted' }, t('crm.reassign_note')), form({ submitLabel: t('crm.reassign'), children: [h('div', { class: 'grid cols-2' }, etype.el, eid.el, to.el, why.el)], onSubmit: async () => { await post('/staff/reassign', { entity_type: etype.input.value, entity_id: eid.input.value.trim(), to_user_id: to.input.value, reason: why.input.value.trim() }); toast(t('common.saved')); } })) : null;
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.staff')),
    can('users:create_staff') ? h('section', { class: 'card' }, h('h2', {}, t('crm.create_user')), create) : null,
    table([{ label: t('auth.full_name'), render: (u) => userText('span', u.full_name) }, { label: t('auth.email'), render: (u) => h('span', { dir: 'ltr' }, u.email) }, { label: t('common.role'), render: (u) => enumBadge('role', u.role) }, { label: t('common.status'), render: (u) => enumBadge('ustatus', u.status) },
      { label: t('crm.approval'), render: (u) => enumBadge('approval', u.approval_status) }, { label: 'MFA', render: (u) => (u.mfa ? t('common.yes') : t('common.no')) },
      { label: '', render: (u) => h('div', { class: 'btn-row' }, can('users:suspend') && u.id !== state.me.id ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => suspend(u) }, u.status === 'suspended' ? t('crm.unsuspend') : t('crm.suspend')) : null,
        state.me.role === 'super_admin' && u.mfa ? h('button', { class: 'btn secondary small', type: 'button', onclick: act(() => post(`/admin/users/${u.id}/mfa-reset`)) }, t('crm.mfa_reset')) : null) }], rows), reassign);
}

const EVENTS = ['candidate.created', 'candidate.updated', 'lead.created', 'lead.qualified', 'application.submitted', 'application.status_changed', 'job.published', 'job.closed', 'placement.updated', 'consent.revoked'];
async function integrations() {
  const o = await get('/admin/integrations'); const manage = can('integrations:manage'); const c = o.connections[0];
  const [deliveries, dead, conflicts] = await Promise.all([get('/admin/integrations/deliveries', { query: { limit: 25 } }), get('/admin/integrations/dead-letters'), get('/admin/integrations/conflicts')]);
  const shown = h('div', { 'aria-live': 'polite' });
  const secretShown = (r) => shown.replaceChildren(h('div', { class: 'notice ok', role: 'status' }, h('p', {}, t('int.secret_once')), h('p', { class: 'mono' }, `${r.kid}: ${r.secret}`), copyButton(r.secret)));
  const url = field({ label: t('int.base_url'), name: 'base_url', type: 'url', value: c.base_url || '', hint: t('int.base_url_hint') }); const en = checkbox({ label: t('int.enabled'), name: 'enabled', checked: c.enabled });
  const cfg = form({ submitLabel: t('common.save'), children: [url.el, en.el], onSubmit: async () => { await put('/admin/integrations/trustcrm', { ...(url.input.value.trim() ? { base_url: url.input.value.trim() } : {}), enabled: en.input.checked }); toast(t('common.saved')); render(); } });
  const dcount = Object.entries(c.deliveries).map(([k, v]) => h('li', {}, enumBadge('dstatus', k), ' ', fmtNumber(v)));
  const card = h('section', { class: 'card stack' }, h('div', { class: 'row' }, h('h2', {}, c.name), h('span', { class: 'badge ' + (c.status === 'connected' ? 'ok' : statusKind(c.status) || 'warn') }, c.status === 'connected' ? `✓ ${t('int.connected')}` : tEnum('connstatus', c.status))),
    c.status !== 'connected' ? h('p', { class: 'notice warn' }, t('int.not_connected_note')) : null,
    dl([[t('int.credentials'), c.credentials_configured ? t('int.cred_yes') : t('int.cred_no')], [t('int.enabled'), c.enabled ? t('common.yes') : t('common.no')], [t('int.last_tested'), c.last_tested_at ? fmtDateTime(c.last_tested_at) : t('int.never')], [t('int.last_success'), c.last_success_at ? fmtDateTime(c.last_success_at) : t('int.never')],
      [t('int.last_error'), userText('span', c.last_test_error)], [t('int.recent_failures'), fmtNumber(c.recent_failures)], [t('int.deliveries'), dcount.length ? h('ul', { class: 'meta' }, dcount) : '—'], [t('int.inbound_keys'), (c.inbound_secrets || []).map((s) => s.kid).join(', ') || t('int.none')]]),
    manage ? h('div', { class: 'stack' }, cfg, h('div', { class: 'btn-row' },
      h('button', { class: 'btn', type: 'button', id: 'test-conn', onclick: async (e) => { e.target.disabled = true; try { const r = await post('/admin/integrations/trustcrm/test'); toast(r.status === 'connected' ? t('int.test_ok') : `${t('int.test_fail')}: ${tEnum('connstatus', r.status)}`, r.status === 'connected' ? 'ok' : 'bad'); render(); } catch (er) { toast(tError(er), 'bad'); e.target.disabled = false; } } }, t('int.test')),
      h('button', { class: 'btn secondary', type: 'button', onclick: act(async () => { const r = await post('/admin/integrations/worker/run'); toast(t('int.worker_done', { n: r.processed })); }) }, t('int.run_worker')),
      h('button', { class: 'btn secondary', type: 'button', onclick: act(async () => { const r = await post('/admin/integrations/trustcrm/reconcile'); toast(t('int.reconciled', { n: r.checked, a: r.applied, c: r.conflicts })); }) }, t('int.reconcile')),
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { secretShown(await post('/admin/integrations/trustcrm/inbound-secret')); } catch (e) { toast(tError(e), 'bad'); } } }, t('int.rotate_inbound')))) : null, shown);
  const retry = (d) => h('button', { class: 'btn secondary small', type: 'button', onclick: act(() => post(`/admin/integrations/deliveries/${d.id}/retry`)) }, t('int.retry'));
  const subs = o.webhook_subscriptions;
  const surl = field({ label: t('int.sub_url'), name: 'url', type: 'url', required: true, hint: t('int.sub_url_hint') }); const evBoxes = EVENTS.map((e) => checkbox({ label: e, name: `ev_${e}` }));
  const subForm = form({ submitLabel: t('int.sub_create'), children: [surl.el, h('fieldset', {}, h('legend', {}, t('int.sub_events')), h('div', { class: 'grid cols-2' }, evBoxes.map((b) => b.el)))], onSubmit: async () => {
    const events = EVENTS.filter((_, i) => evBoxes[i].input.checked); if (!events.length) { toast(t('int.pick_event'), 'bad'); return; }
    const r = await post('/admin/integrations/subscriptions', { url: surl.input.value.trim(), events }); secretShown(r); toast(t('common.saved'));
  } });
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.integrations')), h('p', { class: 'muted' }, t('int.intro')), card,
    h('section', { class: 'card' }, h('h2', {}, t('int.deliveries')), table([{ label: t('int.event'), key: 'type' }, { label: t('int.target'), key: 'target_key' }, { label: t('common.status'), render: (d) => enumBadge('dstatus', d.status) }, { label: t('int.attempts'), render: (d) => fmtNumber(d.attempts) },
      { label: t('int.detail'), render: (d) => h('span', { class: 'small' }, d.last_error || (d.detail && d.detail.reason) || '—') }, { label: t('common.created'), render: (d) => fmtDateTime(d.created_at) }, { label: '', render: (d) => (manage && ['retry', 'blocked', 'dead'].includes(d.status) ? retry(d) : null) }], deliveries, { empty: empty(t('int.no_deliveries')) })),
    h('section', { class: 'card' }, h('h2', {}, t('int.dead')), table([{ label: t('int.event'), key: 'event_type' }, { label: t('int.target'), key: 'target_key' }, { label: t('int.last_error'), render: (d) => h('span', { class: 'small' }, d.error) }, { label: t('int.attempts'), render: (d) => fmtNumber(d.attempts) },
      { label: '', render: (d) => (d.replayed_at ? badge(t('int.replayed'), 'ok') : manage ? h('button', { class: 'btn small', type: 'button', onclick: act(() => post(`/admin/integrations/dead-letters/${d.id}/replay`)) }, t('int.replay')) : null) }], dead, { empty: empty(t('int.no_dead')) })),
    h('section', { class: 'card' }, h('h2', {}, t('int.conflicts')), table([{ label: t('crm.case'), render: (x) => x.case_reference || x.canonical_id }, { label: t('int.field'), render: (x) => x.field }, { label: t('int.local'), render: (x) => String(x.local_value) }, { label: t('int.remote'), render: (x) => String(x.remote_value) },
      { label: '', render: (x) => (manage ? h('div', { class: 'btn-row' }, h('button', { class: 'btn small', type: 'button', onclick: act(() => post(`/admin/integrations/conflicts/${x.id}/resolve`, { resolution: 'local' })) }, t('int.keep_local')), h('button', { class: 'btn secondary small', type: 'button', onclick: act(() => post(`/admin/integrations/conflicts/${x.id}/resolve`, { resolution: 'remote' })) }, t('int.take_remote'))) : null) }], conflicts, { empty: empty(t('int.no_conflicts')) })),
    h('section', { class: 'card stack' }, h('h2', {}, t('int.subs')), subs.length ? table([{ label: t('int.sub_url'), render: (s) => h('span', { class: 'mono small' }, s.url) }, { label: t('int.sub_events'), render: (s) => s.events.join(', ') }, { label: t('common.status'), render: (s) => badge(s.active ? t('int.active') : t('int.inactive'), s.active ? 'ok' : 'warn') },
      { label: '', render: (s) => (manage ? h('div', { class: 'btn-row' }, h('button', { class: 'btn secondary small', type: 'button', onclick: act(() => post(`/admin/integrations/subscriptions/${s.id}/active`, { active: !s.active })) }, s.active ? t('int.disable') : t('int.enable')),
        h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { secretShown(await post(`/admin/integrations/subscriptions/${s.id}/rotate-secret`)); } catch (e) { toast(tError(e), 'bad'); } } }, t('int.rotate'))) : null) }], subs) : h('p', { class: 'muted' }, t('int.no_subs')), manage ? subForm : null));
}

async function audit({ query }) {
  const before = query.before; const ent = field({ label: t('audit.entity_type'), name: 'entity_type', value: query.entity_type || '' }); const eid = field({ label: t('crm.entity_id'), name: 'entity_id', value: query.entity_id || '' }); const action = field({ label: t('audit.action'), name: 'action', value: query.action || '', hint: t('audit.action_hint') });
  const rows = await get('/admin/audit', { query: { entity_type: query.entity_type, entity_id: query.entity_id, action: query.action, before, limit: 50 } });
  const base = new URLSearchParams(Object.fromEntries(['entity_type', 'entity_id', 'action'].filter((k) => query[k]).map((k) => [k, query[k]])));
  const next = rows.length === 50 ? `/crm/audit?${new URLSearchParams({ ...Object.fromEntries(base), before: String(rows.at(-1).seq) })}` : null;
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.audit')), h('p', { class: 'muted' }, t('audit.note')),
    h('form', { class: 'card grid cols-4', role: 'search', onsubmit: (e) => { e.preventDefault(); const p = new URLSearchParams(); for (const [k, i] of [['entity_type', ent], ['entity_id', eid], ['action', action]]) if (i.input.value.trim()) p.set(k, i.input.value.trim()); go(`/crm/audit${p.toString() ? `?${p}` : ''}`); } }, ent.el, eid.el, action.el, h('div', {}, h('button', { class: 'btn', type: 'submit' }, t('jobs.apply_filters')))),
    table([{ label: t('audit.when'), render: (a) => fmtDateTime(a.at) }, { label: t('audit.actor'), render: (a) => userText('span', a.actor_name || a.actor_role || 'system') }, { label: t('audit.action'), render: (a) => h('span', { class: 'mono small' }, a.action) },
      { label: t('audit.entity'), render: (a) => h('span', { class: 'mono small' }, [a.entity_type, a.entity_id ? String(a.entity_id).slice(0, 8) : ''].filter(Boolean).join(' ')) }, { label: t('int.detail'), render: (a) => h('span', { class: 'small mono' }, Object.keys(a.details || {}).length ? JSON.stringify(a.details).slice(0, 120) : '—') }], rows, { empty: empty(t('audit.none')) }),
    next ? h('p', {}, h('a', { class: 'btn secondary', href: `#${next}` }, t('audit.older'))) : null);
}
