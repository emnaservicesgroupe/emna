import { get, post, ApiError } from '../api.js';
import { t, tEnum, tError } from '../i18n.js';
import { h, field, checkbox, form, empty, toast, badge, enumBadge, confirmReason, dl, val, userText, table, pager, statusKind } from '../ui.js';
import { fmtDateTime, fmtNumber, fmtDuration, fmtDate } from '../format.js';
import { can, state } from '../store.js';
import { go, render } from '../router.js';

const C = (perm) => ({ auth: true, area: 'crm', perm });
export function registerStaff(route) {
  route('/crm', overview, { auth: true, area: 'crm', roles: ['staff', 'admin', 'super_admin'] });
  route('/crm/leads', leads, C('leads:work')); route('/crm/leads/:id', leadDetail, C('leads:work')); route('/crm/duplicates', duplicates, C('leads:work'));
  route('/crm/candidates', candidates, C('candidates:view_assigned')); route('/crm/candidates/:id', candidateDetail, C('candidates:view_assigned'));
  route('/crm/companies', companies, C('orgs:view_assigned')); route('/crm/companies/:id', companyDetail, C('orgs:view_assigned'));
  route('/crm/applications/:id', applicationDetail, C('applications:work')); route('/crm/requests', requests, C('requests:resolve'));
  route('/crm/cases', cases, C('cases:work')); route('/crm/cases/:id', caseDetail, C('cases:work'));
}
const back = (href, label) => h('p', {}, h('a', { href: `#${href}` }, h('span', { class: 'flip', 'aria-hidden': 'true' }, '←'), ' ', label));
const LEAD_STATUSES = ['received', 'under_review', 'missing_information', 'rejected', 'qualified'];

async function overview() {
  const tasks = [['leads', 'leads:work', () => get('/staff/leads', { query: { status: 'received', limit: 100 } }), '/crm/leads'], ['dups', 'leads:work', () => get('/staff/duplicates'), '/crm/duplicates'],
    ['reqs', 'requests:resolve', () => get('/staff/requests'), '/crm/requests'], ['appr', 'users:approve', () => get('/admin/approvals'), '/crm/approvals'], ['ver', 'orgs:verify', () => get('/admin/org-verifications'), '/crm/company-verifications'],
    ['jobs', 'jobs:review', () => get('/admin/job-reviews'), '/crm/job-reviews'], ['conf', 'integrations:view', () => get('/admin/integrations/conflicts'), '/crm/integrations']].filter(([, p]) => can(p));
  const res = await Promise.allSettled(tasks.map(([, , fn]) => fn()));
  const labels = { leads: 'crm.q_leads', dups: 'crm.q_dups', reqs: 'crm.q_reqs', appr: 'crm.q_appr', ver: 'crm.q_ver', jobs: 'crm.q_jobs', conf: 'crm.q_conf' };
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.title')), h('p', { class: 'muted' }, t('crm.queues_note')),
    h('div', { class: 'grid cols-3' }, tasks.map(([k, , , href], i) => h('a', { class: 'card', href: `#${href}` }, h('h3', {}, t(labels[k])), res[i].status === 'fulfilled' ? h('p', { class: 'kpi' }, fmtNumber(res[i].value.length)) : h('p', { class: 'muted' }, t('crm.unavailable'))))));
}

async function leads({ query }) {
  const status = query.status || ''; const assigned = query.assigned || 'all';
  const rows = await get('/staff/leads', { query: { status, assigned, limit: 100 } });
  const sel = (name, label, value, options) => field({ label, name, value, options });
  const s = sel('status', t('common.status'), status, [{ value: '', label: t('common.any') }, ...LEAD_STATUSES.map((v) => ({ value: v, label: tEnum('lead', v) }))]);
  const a = sel('assigned', t('crm.assignment'), assigned, [{ value: 'all', label: t('common.any') }, { value: 'mine', label: t('crm.mine') }, { value: 'unassigned', label: t('crm.unassigned') }]);
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.leads')),
    h('form', { class: 'card grid cols-3', onsubmit: (e) => { e.preventDefault(); go(`/crm/leads?${new URLSearchParams({ ...(s.input.value ? { status: s.input.value } : {}), assigned: a.input.value })}`); } }, s.el, a.el, h('div', {}, h('button', { class: 'btn', type: 'submit' }, t('jobs.apply_filters')))),
    table([{ label: t('crm.lead'), render: (l) => h('a', { href: `#/crm/leads/${l.id}` }, l.reference_no) }, { label: t('crm.applicant'), render: (l) => userText('span', l.applicant) }, { label: t('prof.profession'), render: (l) => userText('span', l.profession) },
      { label: t('crm.job'), render: (l) => userText('span', l.job_title) }, { label: t('common.status'), render: (l) => enumBadge('lead', l.status) },
      { label: t('crm.age'), render: (l) => fmtDuration(l.age_seconds) }, { label: t('crm.dups'), render: (l) => (l.open_duplicates ? badge(String(l.open_duplicates), 'warn') : '—') },
      { label: t('crm.assignment'), render: (l) => (l.assigned_to ? t('crm.assigned') : t('crm.unassigned')) }], rows, { empty: empty(t('crm.no_leads'), t('crm.no_leads_text')) }));
}

async function leadDetail({ params }) {
  const l = await get(`/staff/leads/${params.id}`); const s = l.snapshot; const open = !['qualified', 'rejected'].includes(l.status);
  const panel = h('div', { class: 'stack' });
  const qualify = async (resolution) => {
    try { await post(`/staff/leads/${l.id}/qualify`, resolution ? { resolution } : {}); toast(t('crm.qualified')); render(); }
    catch (e) { if (e instanceof ApiError && e.code === 'duplicate_review_required') { showDup(e.details?.reviews || []); } else toast(tError(e), 'bad'); }
  };
  const showDup = (reviews) => {
    panel.replaceChildren();
    const note = field({ label: t('crm.keep_note'), name: 'note', textarea: true, rows: 2 }); let choice = 'keep_separate';
    const radios = [...reviews.map((r) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'dup', value: r.matched_candidate_id, onchange: () => { choice = r.matched_candidate_id; } }), h('span', {}, t('crm.merge_into'), ' ', userText('strong', r.matched_name), ` (${r.reasons.map((x) => tEnum('dupreason', x)).join(', ')})`))),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'dup', value: 'keep', checked: true, onchange: () => { choice = 'keep_separate'; } }), h('span', {}, t('crm.keep_separate')))];
    panel.append(h('section', { class: 'card notice warn', role: 'alert' }, h('h2', {}, t('crm.dup_title')), h('p', {}, t('crm.dup_text')), h('fieldset', {}, h('legend', {}, t('crm.dup_choose')), radios), note.el,
      h('button', { class: 'btn', type: 'button', onclick: () => {
        if (choice === 'keep_separate' && !note.input.value.trim()) { note.input.setAttribute('aria-invalid', 'true'); note.input.focus(); toast(t('crm.keep_note_required'), 'bad'); return; }
        qualify(choice === 'keep_separate' ? { action: 'keep_separate', note: note.input.value.trim() } : { action: 'merge_into', candidate_id: choice, note: note.input.value.trim() || undefined });
      } }, t('crm.qualify_confirm'))));
    panel.querySelector('section').scrollIntoView?.({ block: 'center' });
  };
  const to = field({ label: t('crm.change_status'), name: 'to', options: [{ value: 'under_review', label: tEnum('lead', 'under_review') }, { value: 'missing_information', label: tEnum('lead', 'missing_information') }, { value: 'rejected', label: tEnum('lead', 'rejected') }] });
  const reason = field({ label: t('common.reason'), name: 'reason', textarea: true, rows: 2, hint: t('crm.reason_hint') }); const message = field({ label: t('crm.msg_to_candidate'), name: 'message', textarea: true, rows: 2, hint: t('crm.msg_hint') });
  const statusForm = form({ submitLabel: t('crm.update_status'), children: [to.el, reason.el, message.el], onSubmit: async () => { await post(`/staff/leads/${l.id}/status`, { to: to.input.value, reason: val(reason.input), message: val(message.input) }); toast(t('common.saved')); render(); } });
  return h('div', { class: 'stack' }, back('/crm/leads', t('crm.leads')), h('div', { class: 'row' }, h('h1', {}, `${t('crm.lead')} ${l.reference_no}`), enumBadge('lead', l.status)),
    h('div', { class: 'grid cols-2' }, h('section', { class: 'card' }, h('h2', {}, t('crm.applicant')), dl([[t('auth.full_name'), userText('span', s.full_name)], [t('auth.email'), h('span', { dir: 'ltr' }, s.email || '—')], [t('prof.phone'), h('span', { dir: 'ltr' }, s.phone || '—')],
      [t('prof.country'), userText('span', [s.city, s.country].filter(Boolean).join(', '))], [t('prof.profession'), userText('span', s.profession)], [t('prof.experience'), s.experience_years != null ? t('job.years', { n: fmtNumber(s.experience_years) }) : '—'],
      [t('prof.skills'), (s.skills || []).join(', ') || '—'], [t('prof.languages'), (s.languages || []).map((x) => `${x.code} ${x.level || ''}`).join(', ') || '—']]),
      l.candidate_id ? h('a', { href: `#/crm/candidates/${l.candidate_id}` }, t('crm.open_candidate')) : null),
    h('section', { class: 'card' }, h('h2', {}, t('crm.application')), l.application ? [dl([[t('job.ref'), l.application.reference_no], [t('crm.job'), userText('span', l.application.job_title)], [t('company.title'), userText('span', l.application.employer)], [t('common.stage'), enumBadge('stage', l.application.stage)], [t('apps.submitted'), fmtDateTime(l.application.created_at)], l.application.cover_note ? [t('emp.cover_note'), userText('span', l.application.cover_note)] : null]),
      h('a', { href: `#/crm/applications/${l.application.id}` }, t('crm.open_application'))] : h('p', { class: 'muted' }, '—'))),
    l.duplicate_reviews.length ? h('section', { class: 'card notice warn' }, h('h2', {}, t('crm.duplicates')), h('ul', {}, l.duplicate_reviews.map((d) => h('li', {}, userText('strong', d.matched_name), ` — ${d.reasons.map((x) => tEnum('dupreason', x)).join(', ')} — `, enumBadge('dupstatus', d.status))))) : null,
    panel,
    open ? h('section', { class: 'card stack' }, h('h2', {}, t('crm.actions')), h('div', { class: 'btn-row' },
      l.assigned_to ? null : h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await post(`/staff/leads/${l.id}/claim`); toast(t('crm.claimed')); render(); } catch (e) { toast(tError(e), 'bad'); } } }, t('crm.claim')),
      h('button', { class: 'btn', type: 'button', id: 'qualify-btn', onclick: () => qualify() }, t('crm.qualify'))), h('details', {}, h('summary', {}, t('crm.change_status')), statusForm)) : h('p', { class: 'notice' }, t('crm.lead_closed', { status: tEnum('lead', l.status) })));
}

async function duplicates() {
  const rows = await get('/staff/duplicates'); const admin = can('candidates:write_all');
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.duplicates')), h('p', { class: 'muted' }, t('crm.dups_note')),
    table([{ label: t('crm.person'), render: (d) => h('a', { href: `#/crm/candidates/${d.candidate_id}`, dir: 'auto' }, d.candidate_name) }, { label: t('crm.possible_match'), render: (d) => h('a', { href: `#/crm/candidates/${d.matched_candidate_id}`, dir: 'auto' }, d.matched_name) },
      { label: t('crm.reasons'), render: (d) => d.reasons.map((x) => tEnum('dupreason', x)).join(', ') }, { label: t('common.created'), render: (d) => fmtDateTime(d.created_at) },
      { label: '', render: (d) => h('div', { class: 'btn-row' }, admin ? h('button', { class: 'btn small', type: 'button', onclick: async () => { const note = await confirmReason({ title: t('crm.merge'), label: t('common.note'), required: false }); if (note === null) return; try { await post(`/staff/duplicates/${d.id}`, { action: 'merge', note: note || null }); render(); } catch (e) { toast(tError(e), 'bad'); } } }, t('crm.merge')) : null,
        h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { const note = await confirmReason({ title: t('crm.keep_separate'), label: t('crm.keep_note') }); if (note === null) return; try { await post(`/staff/duplicates/${d.id}`, { action: 'keep_separate', note }); render(); } catch (e) { toast(tError(e), 'bad'); } } }, t('crm.keep_separate'))) }], rows,
      { empty: empty(t('crm.no_dups'), t('crm.no_dups_text')) }));
}

async function candidates({ query }) {
  const q = field({ label: t('jobs.keyword'), name: 'q', value: query.q || '' });
  const rows = await get('/staff/candidates', { query: { q: query.q } });
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.candidates')), h('form', { class: 'card grid cols-3', role: 'search', onsubmit: (e) => { e.preventDefault(); go(`/crm/candidates${q.input.value ? `?q=${encodeURIComponent(q.input.value)}` : ''}`); } }, q.el, h('div', {}, h('button', { class: 'btn', type: 'submit' }, t('home.search')))),
    table([{ label: t('auth.full_name'), render: (c) => h('a', { href: `#/crm/candidates/${c.id}`, dir: 'auto' }, c.full_name) }, { label: t('prof.profession'), render: (c) => userText('span', c.profession) }, { label: t('prof.country'), render: (c) => userText('span', c.country) },
      { label: t('crm.source'), render: (c) => tEnum('source', c.source) }, { label: t('crm.identity_review'), render: (c) => enumBadge('idreview', c.identity_review_status) }], rows, { empty: empty(t('crm.no_candidates'), t('crm.no_candidates_text')) }));
}
async function candidateDetail({ params }) {
  const c = await get(`/staff/candidates/${params.id}`);
  const kind = field({ label: t('crm.doc_kind'), name: 'kind', options: [{ value: 'passport', label: tEnum('dockind', 'passport') }, { value: 'national_id', label: tEnum('dockind', 'national_id') }] });
  const num_ = field({ label: t('crm.doc_number'), name: 'number', required: true, hint: t('crm.doc_hint') }); const ctry = field({ label: t('crm.issuing_country'), name: 'issuing_country' });
  const iss = field({ label: t('crm.issue_date'), name: 'issue_date', type: 'date' }); const exp = field({ label: t('crm.expiry_date'), name: 'expiry_date', type: 'date', hint: t('crm.expiry_hint') });
  const f = form({ submitLabel: t('crm.record_doc'), children: [h('div', { class: 'grid cols-2' }, kind.el, num_.el, ctry.el, iss.el, exp.el)], onSubmit: async () => { await post(`/staff/candidates/${c.id}/identity`, { kind: kind.input.value, number: num_.input.value.trim(), issuing_country: val(ctry.input), issue_date: val(iss.input), expiry_date: val(exp.input) }); toast(t('common.saved')); render(); } });
  f.addEventListener('apierror', (e) => { if (e.detail.code === 'duplicate_review_required') toast(t('crm.dup_flagged'), 'bad'); });
  return h('div', { class: 'stack' }, back('/crm/candidates', t('crm.candidates')), h('h1', { dir: 'auto' }, c.full_name),
    h('section', { class: 'card' }, dl([[t('auth.email'), h('span', { dir: 'ltr' }, c.email || '—')], [t('prof.phone'), h('span', { dir: 'ltr' }, c.phone || '—')], [t('prof.dob'), fmtDate(c.date_of_birth)], [t('prof.nationality'), userText('span', c.nationality)],
      [t('prof.country'), userText('span', [c.city, c.country].filter(Boolean).join(', '))], [t('prof.profession'), userText('span', c.profession)], [t('prof.skills'), (c.skills || []).join(', ') || '—'], [t('crm.source'), tEnum('source', c.source)], [t('crm.identity_review'), enumBadge('idreview', c.identity_review_status)]])),
    h('section', { class: 'card' }, h('h2', {}, t('crm.identity_docs')), c.identity_refs.length ? table([{ label: t('crm.doc_kind'), render: (r) => tEnum('dockind', r.kind) }, { label: t('crm.doc_number'), render: (r) => h('span', { class: 'mono' }, r.number_masked) }, { label: t('crm.issuing_country'), key: 'issuing_country' }, { label: t('crm.expiry_date'), render: (r) => fmtDate(r.expiry_date) }], c.identity_refs) : h('p', { class: 'muted' }, t('crm.no_docs')),
      h('h3', {}, t('crm.record_doc')), h('p', { class: 'small muted' }, t('crm.doc_sync_note')), f));
}

async function companies({ query }) {
  const q = field({ label: t('jobs.keyword'), name: 'q', value: query.q || '' }); const rows = await get('/staff/companies', { query: { q: query.q } });
  const name = field({ label: t('auth.org_name'), name: 'name', required: true }); const country = field({ label: t('prof.country'), name: 'country' }); const website = field({ label: t('company.website'), name: 'website', type: 'url' });
  const source = field({ label: t('crm.source'), name: 'source', hint: t('crm.source_hint') }); const email = field({ label: t('crm.contact_email'), name: 'contact_email', type: 'email' });
  const dupBox = h('div', { class: 'stack' }); let confirmNotDup = false;
  const create = form({ submitLabel: t('crm.add_company'), children: [h('div', { class: 'grid cols-2' }, name.el, country.el, website.el, source.el, email.el), dupBox], onSubmit: async () => {
    try { const r = await post('/staff/companies', { name: name.input.value.trim(), country: val(country.input), website: val(website.input), source: val(source.input), contact_email: val(email.input), ...(confirmNotDup ? { confirm_not_duplicate: true } : {}) }); toast(t('common.saved')); go(`/crm/companies/${r.id}`); }
    catch (e) { if (e instanceof ApiError && e.code === 'possible_duplicate') { dupBox.replaceChildren(h('div', { class: 'notice warn', role: 'alert' }, h('p', {}, t('crm.dup_company')), h('ul', {}, (e.details.matches || []).map((m) => h('li', {}, userText('strong', m.name), ' ', m.country || ''))), h('button', { class: 'btn secondary', type: 'button', onclick: () => { confirmNotDup = true; create.requestSubmit(); } }, t('crm.not_duplicate')))); return; } throw e; }
  } });
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.companies')), h('form', { class: 'card grid cols-3', role: 'search', onsubmit: (e) => { e.preventDefault(); go(`/crm/companies${q.input.value ? `?q=${encodeURIComponent(q.input.value)}` : ''}`); } }, q.el, h('div', {}, h('button', { class: 'btn', type: 'submit' }, t('home.search')))),
    table([{ label: t('company.title'), render: (o) => h('a', { href: `#/crm/companies/${o.id}`, dir: 'auto' }, o.name) }, { label: t('prof.country'), render: (o) => userText('span', o.country) }, { label: t('emp.verification'), render: (o) => enumBadge('verification', o.verification_status) },
      { label: t('crm.vacancies'), render: (o) => fmtNumber(o.active_vacancies) }, { label: t('crm.last_contact'), render: (o) => (o.last_contact_at ? fmtDate(o.last_contact_at) : '—') }, { label: t('crm.days_silent'), render: (o) => (o.days_since_contact != null ? fmtNumber(o.days_since_contact) : '—') },
      { label: t('crm.relationship'), render: (o) => tEnum('relationship', o.relationship_status) }], rows, { empty: empty(t('crm.no_companies'), t('crm.no_companies_text')) }),
    h('section', { class: 'card' }, h('h2', {}, t('crm.add_company')), h('p', { class: 'small muted' }, t('crm.add_company_note')), create));
}
async function companyDetail({ params }) {
  const o = await get(`/staff/companies/${params.id}`);
  const note = field({ label: t('crm.contact_note'), name: 'note', textarea: true, rows: 3 }); const next = field({ label: t('crm.next_action'), name: 'next_action' }); const nextAt = field({ label: t('crm.next_action_at'), name: 'next_action_at', type: 'datetime-local' });
  const log = form({ submitLabel: t('crm.log_contact'), children: [note.el, h('div', { class: 'grid cols-2' }, next.el, nextAt.el)], onSubmit: async () => { await post(`/staff/companies/${o.id}/contact`, { note: val(note.input), next_action: val(next.input), next_action_at: nextAt.input.value ? new Date(nextAt.input.value).toISOString() : null }); toast(t('common.saved')); render(); } });
  const mode = can('orgs:view_all') ? h('div', { class: 'btn-row' }, ['managed', 'direct'].map((m) => h('button', { class: 'btn secondary small', type: 'button', disabled: o.recruitment_mode === m, onclick: async () => { await post(`/staff/companies/${o.id}/mode`, { mode: m }); toast(t('common.saved')); render(); } }, `${t('emp.mode')}: ${tEnum('mode', m)}`))) : null;
  return h('div', { class: 'stack' }, back('/crm/companies', t('crm.companies')), h('h1', { dir: 'auto' }, o.name),
    h('section', { class: 'card' }, dl([[t('emp.verification'), enumBadge('verification', o.verification_status)], [t('prof.country'), userText('span', [o.city, o.country].filter(Boolean).join(', '))], [t('company.website'), userText('span', o.website)], [t('crm.source'), userText('span', o.source)],
      [t('crm.claimed'), o.claimed ? t('common.yes') : t('crm.not_claimed')], [t('crm.relationship'), tEnum('relationship', o.relationship_status)], [t('emp.mode'), tEnum('mode', o.recruitment_mode)], [t('crm.last_contact'), o.last_contact_at ? fmtDateTime(o.last_contact_at) : '—'], [t('crm.next_action'), userText('span', o.next_action)]]), mode),
    h('section', { class: 'card' }, h('h2', {}, t('crm.log_contact')), log));
}

const STAGES = ['under_review', 'missing_information', 'shortlisted', 'interview_requested', 'interview_scheduled', 'selected', 'rejected'];
async function applicationDetail({ params }) {
  const a = await get(`/staff/applications/${params.id}`);
  const to = field({ label: t('crm.change_stage'), name: 'to', options: STAGES.map((v) => ({ value: v, label: tEnum('stage', v) })) }); const reason = field({ label: t('common.reason'), name: 'reason', textarea: true, rows: 2, hint: t('crm.reason_hint') }); const msg = field({ label: t('crm.msg_to_candidate'), name: 'message', textarea: true, rows: 2 });
  const stageForm = form({ submitLabel: t('crm.update_stage'), children: [to.el, reason.el, msg.el], onSubmit: async () => { await post(`/staff/applications/${a.id}/stage`, { to: to.input.value, reason: val(reason.input), message: val(msg.input) }); toast(t('common.saved')); render(); } });
  const note = field({ label: t('common.note'), name: 'body', textarea: true, rows: 3, required: true, hint: t('crm.internal_note_hint') });
  const noteForm = form({ submitLabel: t('crm.add_note'), children: [note.el], onSubmit: async () => { await post('/staff/notes', { entity_type: 'application', entity_id: a.id, body: note.input.value.trim() }); toast(t('common.saved')); render(); } });
  const rel = (disclose) => h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { await post(`/staff/applications/${a.id}/release`, { release: true, disclose_contact: disclose }); toast(t('common.saved')); render(); } catch (e) { toast(tError(e), 'bad'); } } }, disclose ? t('crm.release_disclose') : t('crm.release'));
  return h('div', { class: 'stack' }, back('/crm/leads', t('crm.leads')), h('div', { class: 'row' }, h('h1', {}, `${t('crm.application')} ${a.reference_no}`), enumBadge('stage', a.stage)),
    h('section', { class: 'card' }, dl([[t('crm.job'), userText('span', `${a.job_title} (${a.job_ref})`)], [t('company.title'), userText('span', a.employer_name)], [t('crm.released'), a.released_to_employer ? t('common.yes') : t('common.no')], [t('crm.contact_disclosed'), a.contact_disclosed ? t('common.yes') : t('common.no')]]),
      h('div', { class: 'btn-row' }, rel(false), rel(true), a.stage === 'selected' ? h('button', { class: 'btn small', type: 'button', onclick: async () => { try { const c = await post('/staff/cases', { application_id: a.id }); toast(t('crm.case_opened')); go(`/crm/cases/${c.id}`); } catch (e) { toast(tError(e), 'bad'); } } }, t('crm.open_case')) : null)),
    a.employer_requests.length ? h('section', { class: 'card' }, h('h2', {}, t('crm.requests')), table([{ label: t('common.type'), render: (r) => tEnum('rtype', r.type) }, { label: t('common.status'), render: (r) => enumBadge('rstatus', r.status) }, { label: t('common.note'), render: (r) => userText('span', r.note) }, { label: t('common.created'), render: (r) => fmtDateTime(r.created_at) }], a.employer_requests), h('a', { href: '#/crm/requests' }, t('crm.requests'))) : null,
    h('section', { class: 'card' }, h('h2', {}, t('apps.history')), h('ol', { class: 'timeline' }, a.history.map((e) => h('li', {}, h('strong', {}, tEnum('stage', e.to_stage)), ' ', e.visibility === 'internal' ? badge(t('crm.internal'), 'gold') : null, ' ', h('span', { class: 'small muted' }, `${fmtDateTime(e.created_at)} · ${e.actor_role || ''}`), e.reason ? h('p', { class: 'small' }, t('common.reason'), ': ', userText('span', e.reason)) : null, e.message ? userText('p', e.message) : null)))),
    h('div', { class: 'grid cols-2' }, h('section', { class: 'card' }, h('h2', {}, t('crm.change_stage')), stageForm),
      h('section', { class: 'card' }, h('h2', {}, t('crm.internal_notes')), h('p', { class: 'small muted' }, t('crm.notes_private')), a.internal_notes.length ? h('ul', { class: 'stack' }, a.internal_notes.map((n) => h('li', {}, userText('span', n.body), h('br'), h('span', { class: 'small muted' }, `${n.author} · ${fmtDateTime(n.created_at)}`)))) : null, noteForm)));
}

async function requests() {
  const rows = await get('/staff/requests');
  const resolve = async (r, decision) => { let note = ''; if (decision === 'decline') { note = await confirmReason({ title: t('crm.decline'), label: t('common.reason'), confirmLabel: t('crm.decline'), danger: true }); if (note === null) return; } try { await post(`/staff/requests/${r.id}`, { decision, note: note || null }); toast(t('common.saved')); render(); } catch (e) { toast(tError(e), 'bad'); } };
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.requests')), h('p', { class: 'muted' }, t('crm.requests_note')),
    table([{ label: t('crm.application'), render: (r) => h('a', { href: `#/crm/applications/${r.application_id}` }, r.reference_no) }, { label: t('common.type'), render: (r) => tEnum('rtype', r.type) }, { label: t('crm.job'), render: (r) => userText('span', r.job_title) }, { label: t('company.title'), render: (r) => userText('span', r.employer) },
      { label: t('common.note'), render: (r) => userText('span', r.note) }, { label: t('common.created'), render: (r) => fmtDateTime(r.created_at) },
      { label: '', render: (r) => h('div', { class: 'btn-row' }, h('button', { class: 'btn small', type: 'button', onclick: () => resolve(r, 'approve') }, t('crm.approve')), h('button', { class: 'btn secondary small', type: 'button', onclick: () => resolve(r, 'decline') }, t('crm.decline'))) }], rows, { empty: empty(t('crm.no_requests'), t('crm.no_requests_text')) }));
}

async function cases() {
  const rows = await get('/staff/cases');
  return h('div', { class: 'stack' }, h('h1', {}, t('crm.cases')), table([{ label: t('crm.case'), render: (c) => h('a', { href: `#/crm/cases/${c.id}` }, c.reference_no) }, { label: t('crm.candidate'), render: (c) => userText('span', c.candidate) }, { label: t('crm.job'), render: (c) => userText('span', c.job_title) },
    { label: t('company.title'), render: (c) => userText('span', c.employer) }, { label: t('common.stage'), render: (c) => enumBadge('case', c.stage) }, { label: t('common.updated'), render: (c) => fmtDateTime(c.updated_at) }], rows, { empty: empty(t('crm.no_cases'), t('crm.no_cases_text')) }));
}
const CASE_STAGES = ['offer', 'documents', 'contract', 'work_permit', 'visa_appointment', 'visa_result', 'travel', 'arrival', 'started_work', 'follow_up', 'closed'];
async function caseDetail({ params }) {
  const c = await get(`/staff/cases/${params.id}`); let version = c.version;
  const stage = field({ label: t('crm.change_stage'), name: 'stage', value: c.stage, options: CASE_STAGES.map((v) => ({ value: v, label: tEnum('case', v) })) }); const reason = field({ label: t('common.reason'), name: 'reason', textarea: true, rows: 2, hint: t('crm.case_reason_hint') });
  const f = form({ submitLabel: t('crm.update_stage'), children: [stage.el, reason.el], onSubmit: async () => { await post(`/staff/cases/${c.id}/stage`, { stage: stage.input.value, reason: val(reason.input), version }); toast(t('common.saved')); render(); } });
  return h('div', { class: 'stack' }, back('/crm/cases', t('crm.cases')), h('div', { class: 'row' }, h('h1', {}, `${t('crm.case')} ${c.reference_no}`), enumBadge('case', c.stage)), h('p', { class: 'notice' }, t('crm.case_sync_note')),
    h('section', { class: 'card' }, h('h2', {}, t('crm.change_stage')), f),
    h('section', { class: 'card' }, h('h2', {}, t('apps.history')), h('ol', { class: 'timeline' }, c.events.map((e) => h('li', {}, h('strong', {}, tEnum('case', e.to_stage)), ' ', h('span', { class: 'small muted' }, `${fmtDateTime(e.created_at)} · ${tEnum('origin', e.origin)}`), e.reason ? h('p', { class: 'small' }, userText('span', e.reason)) : null)))));
}
