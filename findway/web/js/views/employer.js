import { get, post, patch, ApiError } from '../api.js';
import { t, tEnum, tError } from '../i18n.js';
import { h, field, checkbox, form, empty, toast, badge, enumBadge, tagInput, repeater, confirmReason, confirmDialog, dl, val, num, userText, table } from '../ui.js';
import { fmtDate, fmtDateTime, fmtNumber } from '../format.js';
import { state, loadMe } from '../store.js';
import { go, render } from '../router.js';
import { approvalCard, statusCard } from './shared.js';

const R = { auth: true, roles: ['employer_owner', 'employer_member'] };
export function registerEmployer(route) {
  route('/employer', overview, R); route('/employer/company', company, R); route('/employer/jobs', jobsList, R); route('/employer/jobs/new', (c) => jobEditor(c, null), R);
  route('/employer/jobs/:id', (c) => jobEditor(c, c.params.id), R); route('/employer/jobs/:id/applicants', applicants, R);
}
const empNav = (active) => h('nav', { 'aria-label': t('nav.account') }, h('div', { class: 'btn-row' }, [['/employer', 'cand.overview'], ['/employer/company', 'emp.company'], ['/employer/jobs', 'nav.my_jobs'], ['/notifications', 'notif.title'], ['/settings', 'nav.settings']]
  .map(([href, k]) => h('a', { class: 'btn secondary small', href: `#${href}`, 'aria-current': active === href ? 'page' : null }, t(k)))));

async function overview() {
  const me = state.me; const org = me.status.organizations[0];
  const [jobs, co] = await Promise.all([get('/employer/jobs'), get('/employer/company')]);
  const counts = {}; jobs.forEach((j) => { counts[j.status] = (counts[j.status] || 0) + 1; });
  return h('div', { class: 'stack' }, h('h1', {}, t('emp.title')), empNav('/employer'),
    me.status.approval !== 'approved' ? h('p', { class: 'notice warn' }, t('status.restricted_note')) : null,
    h('div', { class: 'grid cols-3' }, approvalCard(me),
      statusCard(t('emp.verification'), enumBadge('verification', org?.verification_status), co.verification_note),
      h('div', { class: 'card' }, h('h3', {}, t('emp.jobs_by_status')), Object.keys(counts).length ? h('ul', {}, Object.entries(counts).map(([s, n]) => h('li', {}, tEnum('jstatus', s), ': ', fmtNumber(n)))) : h('p', { class: 'muted' }, t('emp.no_jobs')))),
    h('p', {}, h('a', { class: 'btn', href: '#/employer/jobs/new' }, t('emp.new_job'))));
}

async function company() {
  const o = await get('/employer/company'); let version = o.version; const owner = o.my_role === 'owner';
  const f = (name, label, x = {}) => field({ label, name, value: o[name] ?? '', ...x });
  const F = { name: f('name', t('auth.org_name'), { required: true }), legal_name: f('legal_name', t('emp.legal_name')), registration_number: f('registration_number', t('emp.reg_no')), website: f('website', t('company.website'), { type: 'url' }),
    country: f('country', t('prof.country')), city: f('city', t('prof.city')), industry: f('industry', t('company.industry')), contact_phone: f('contact_phone', t('prof.phone'), { type: 'tel' }), description: f('description', t('company.about'), { textarea: true, rows: 5 }) };
  const pub = checkbox({ label: t('emp.public_profile'), name: 'public_profile', checked: o.public_profile });
  const edit = form({ submitLabel: t('common.save'), children: [h('fieldset', { disabled: !owner }, h('div', { class: 'grid cols-2' }, F.name.el, F.legal_name.el, F.registration_number.el, F.website.el, F.country.el, F.city.el, F.industry.el, F.contact_phone.el), F.description.el, pub.el, h('p', { class: 'small muted' }, t('emp.public_note')))],
    onSubmit: async () => { const r = await patch('/employer/company', { version, name: F.name.input.value.trim(), legal_name: val(F.legal_name.input), registration_number: val(F.registration_number.input), website: val(F.website.input), country: val(F.country.input), city: val(F.city.input), industry: val(F.industry.input), contact_phone: val(F.contact_phone.input), description: val(F.description.input), public_profile: pub.input.checked }); version = r.version; toast(t('common.saved')); } });
  const reg = field({ label: t('emp.reg_no'), name: 'registration_number', value: o.registration_number || '', required: true }); const site = field({ label: t('company.website'), name: 'website', type: 'url', value: o.website || '' });
  const notes = field({ label: t('emp.verify_notes'), name: 'notes', textarea: true, rows: 3 });
  const st = o.verification_status;
  const verifyCard = h('section', { class: 'card stack' }, h('h2', {}, t('emp.verification')), h('p', {}, enumBadge('verification', st)),
    o.verification_note ? h('p', { class: 'notice warn' }, t('emp.reviewer_note'), ': ', userText('span', o.verification_note)) : null,
    st === 'verified' ? h('p', {}, t('emp.verified_text')) : st === 'submitted' ? h('p', {}, t('emp.submitted_text')) : owner ? [h('p', {}, t('emp.verify_text')), form({ submitLabel: t('emp.submit_verification'), children: [reg.el, site.el, notes.el], onSubmit: async () => { await post('/employer/company/verification', { registration_number: reg.input.value.trim(), website: val(site.input), notes: val(notes.input) }); await loadMe(); toast(t('emp.submitted')); render(); } })] : h('p', {}, t('emp.owner_only')));
  return h('div', { class: 'stack' }, h('h1', {}, t('emp.company')), empNav('/employer/company'), h('section', { class: 'card' }, h('h2', {}, t('emp.profile')), edit),
    verifyCard, h('p', { class: 'small muted' }, `${t('emp.mode')}: ${tEnum('mode', o.recruitment_mode)} — ${t(`emp.mode_${o.recruitment_mode}`)}`));
}

async function jobsList() {
  const jobs = await get('/employer/jobs');
  return h('div', { class: 'stack' }, h('div', { class: 'row' }, h('h1', {}, t('nav.my_jobs')), h('a', { class: 'btn', href: '#/employer/jobs/new' }, t('emp.new_job'))), empNav('/employer/jobs'),
    table([{ label: t('job.title'), render: (j) => h('a', { href: `#/employer/jobs/${j.id}`, dir: 'auto' }, j.title) }, { label: t('job.ref'), key: 'reference_no' }, { label: t('common.status'), render: (j) => enumBadge('jstatus', j.status) },
      { label: t('job.location'), render: (j) => userText('span', [j.city, j.country].filter(Boolean).join(', ') || '—') }, { label: t('job.deadline'), render: (j) => fmtDate(j.deadline) },
      { label: t('emp.applicants'), render: (j) => h('a', { href: `#/employer/jobs/${j.id}/applicants` }, fmtNumber(j.applicants)) }], jobs, { empty: empty(t('emp.no_jobs'), t('emp.no_jobs_text'), h('a', { class: 'btn', href: '#/employer/jobs/new' }, t('emp.new_job'))) }));
}

const tri = (v) => (v === true ? 'true' : v === false ? 'false' : '');
const triOpts = () => [{ value: '', label: t('common.not_specified') }, { value: 'true', label: t('common.yes') }, { value: 'false', label: t('common.no') }];
const triVal = (i) => (i.value === '' ? null : i.value === 'true');
const benefitOpts = (vals) => vals.map((v) => ({ value: v, label: tEnum('benefit', v) }));

async function jobEditor({ params }, id) {
  const j = id ? await get(`/employer/jobs/${id}`) : {}; let version = j.version;
  const locked = ['pending_approval', 'closed'].includes(j.status); const live = ['published', 'paused'].includes(j.status);
  const f = (name, label, x = {}) => field({ label, name, value: j[name] ?? '', ...x });
  const F = {
    title: f('title', t('job.title'), { required: true }), profession: f('profession', t('job.profession')), category: f('category', t('job.category')), vacancies: f('vacancies', t('job.vacancies'), { type: 'number', min: 1, value: j.vacancies ?? 1 }),
    deadline: f('deadline', t('job.deadline'), { type: 'date' }), employment_type: f('employment_type', t('job.employment_type'), { options: [{ value: '', label: '—' }, ...['full_time', 'part_time', 'contract', 'seasonal', 'temporary'].map((v) => ({ value: v, label: tEnum('etype', v) }))] }),
    work_mode: f('work_mode', t('job.work_mode'), { options: ['onsite', 'remote', 'hybrid'].map((v) => ({ value: v, label: tEnum('wmode', v) })), value: j.work_mode || 'onsite' }),
    country: f('country', t('prof.country')), city: f('city', t('prof.city')), address: f('address', t('job.address')), latitude: f('latitude', t('job.lat'), { type: 'number', step: 'any' }), longitude: f('longitude', t('job.lng'), { type: 'number', step: 'any' }),
    description: f('description', t('job.description'), { textarea: true, rows: 5 }), responsibilities: f('responsibilities', t('job.responsibilities'), { textarea: true, rows: 5 }), requirements: f('requirements', t('job.requirements'), { textarea: true, rows: 5 }),
    experience_min_years: f('experience_min_years', t('job.experience'), { type: 'number', min: 0, step: '0.5' }),
    salary_min: f('salary_min', t('jobs.salary_min'), { type: 'number', min: 0 }), salary_max: f('salary_max', t('jobs.salary_max'), { type: 'number', min: 0 }), salary_currency: f('salary_currency', t('jobs.currency'), { maxlength: 3, hint: t('jobs.currency_hint') }),
    salary_period: f('salary_period', t('jobs.period'), { options: [{ value: '', label: '—' }, ...['hour', 'day', 'week', 'month', 'year'].map((v) => ({ value: v, label: tEnum('period', v) }))] }),
    salary_basis: f('salary_basis', t('job.basis'), { options: ['unspecified', 'gross', 'net'].map((v) => ({ value: v, label: tEnum('basis', v) })), value: j.salary_basis || 'unspecified' }),
    hours_per_day: f('hours_per_day', t('job.hours'), { type: 'number', min: 0, max: 24, step: '0.5' }), days_per_week: f('days_per_week', t('job.days'), { type: 'number', min: 0, max: 7, step: '0.5' }),
    shifts: f('shifts', t('job.shifts')), overtime_terms: f('overtime_terms', t('job.overtime')), contract_months: f('contract_months', t('job.contract_months'), { type: 'number', min: 0 }), probation_months: f('probation_months', t('job.probation_months'), { type: 'number', min: 0 }),
    accommodation: f('accommodation', t('job.accommodation'), { options: benefitOpts(['unspecified', 'provided', 'allowance', 'not_provided']), value: j.accommodation || 'unspecified' }),
    food: f('food', t('job.food'), { options: benefitOpts(['unspecified', 'provided', 'allowance', 'not_provided']), value: j.food || 'unspecified' }),
    transport: f('transport', t('job.transport'), { options: benefitOpts(['unspecified', 'provided', 'allowance', 'not_provided']), value: j.transport || 'unspecified' }),
    insurance: f('insurance', t('job.insurance'), { options: benefitOpts(['unspecified', 'provided', 'not_provided']), value: j.insurance || 'unspecified' }),
    other_benefits: f('other_benefits', t('job.other_benefits'), { textarea: true, rows: 3 }),
    relocation_support: f('relocation_support', t('job.relocation'), { options: triOpts(), value: tri(j.relocation_support) }),
    international_recruitment: f('international_recruitment', t('job.intl_open'), { options: triOpts(), value: tri(j.international_recruitment), hint: t('job.intl_note') }),
    employer_confirmed_visa_support: f('employer_confirmed_visa_support', t('job.intl_visa'), { options: triOpts(), value: tri(j.employer_confirmed_visa_support) }),
  };
  const specified = checkbox({ label: t('job.salary_specified'), name: 'salary_specified', checked: !!j.salary_specified });
  const reapply = checkbox({ label: t('job.reapply'), name: 'allow_reapplication', checked: !!j.allow_reapplication });
  const formats = ['cv', 'video', 'audio', 'portfolio'].map((v) => checkbox({ label: tEnum('format', v), name: `fmt_${v}`, checked: (j.accepted_formats || ['cv']).includes(v) }));
  const skills = tagInput({ label: t('prof.skills'), value: j.skills || [], hint: t('prof.tags_hint') });
  const langs = repeater({ legend: t('job.languages'), addLabel: t('prof.add_language'), value: j.languages || [], fields: [{ key: 'code', label: t('prof.lang_code') }, { key: 'level', label: t('prof.lang_level'), options: [{ value: '', label: '—' }, ...['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native'].map((v) => ({ value: v, label: v }))] }] });
  const g = (...els) => h('div', { class: 'grid cols-2' }, els.map((e) => e.el));
  const body = form({ submitLabel: id ? t('common.save') : t('emp.create_draft'), children: [h('fieldset', { disabled: locked },
    h('fieldset', {}, h('legend', {}, t('emp.sec_basics')), g(F.title, F.profession, F.category, F.vacancies, F.deadline, F.employment_type, F.work_mode), reapply.el),
    h('fieldset', {}, h('legend', {}, t('emp.sec_location')), g(F.country, F.city, F.address), h('div', { class: 'grid cols-2' }, F.latitude.el, F.longitude.el)),
    h('fieldset', {}, h('legend', {}, t('emp.sec_description')), F.description.el, F.responsibilities.el, F.requirements.el, F.experience_min_years.el, skills.el, langs.el),
    h('fieldset', {}, h('legend', {}, t('emp.sec_pay')), specified.el, h('div', { class: 'grid cols-4' }, F.salary_min.el, F.salary_max.el, F.salary_currency.el, F.salary_period.el), F.salary_basis.el),
    h('fieldset', {}, h('legend', {}, t('emp.sec_schedule')), g(F.hours_per_day, F.days_per_week, F.shifts, F.overtime_terms, F.contract_months, F.probation_months)),
    h('fieldset', {}, h('legend', {}, t('emp.sec_benefits')), g(F.accommodation, F.food, F.transport, F.insurance), F.other_benefits.el, g(F.relocation_support, F.international_recruitment, F.employer_confirmed_visa_support)),
    h('fieldset', {}, h('legend', {}, t('job.accepted_formats')), formats.map((c) => c.el)))],
  onSubmit: async () => {
    const s = (k) => val(F[k].input); const n = (k) => num(F[k].input);
    const payload = { title: F.title.input.value.trim(), profession: s('profession'), category: s('category'), vacancies: n('vacancies') || 1, deadline: s('deadline'), employment_type: s('employment_type'), work_mode: F.work_mode.input.value,
      allow_reapplication: reapply.input.checked, country: s('country'), city: s('city'), address: s('address'), latitude: n('latitude'), longitude: n('longitude'), description: s('description'), responsibilities: s('responsibilities'), requirements: s('requirements'),
      experience_min_years: n('experience_min_years'), skills: skills.get(), languages: langs.get(), salary_specified: specified.input.checked, salary_min: n('salary_min'), salary_max: n('salary_max'),
      salary_currency: s('salary_currency') ? s('salary_currency').toUpperCase() : null, salary_period: s('salary_period'), salary_basis: F.salary_basis.input.value, hours_per_day: n('hours_per_day'), days_per_week: n('days_per_week'),
      shifts: s('shifts'), overtime_terms: s('overtime_terms'), contract_months: n('contract_months'), probation_months: n('probation_months'), accommodation: F.accommodation.input.value, food: F.food.input.value,
      transport: F.transport.input.value, insurance: F.insurance.input.value, other_benefits: s('other_benefits'), relocation_support: triVal(F.relocation_support.input), international_recruitment: triVal(F.international_recruitment.input),
      employer_confirmed_visa_support: triVal(F.employer_confirmed_visa_support.input), accepted_formats: ['cv', 'video', 'audio', 'portfolio'].filter((_, i) => formats[i].input.checked) };
    if (!id) { const r = await post('/employer/jobs', payload); toast(t('common.saved')); go(`/employer/jobs/${r.id}`); return; }
    const r = await patch(`/employer/jobs/${id}`, { ...payload, version });
    version = r.version; toast(r.status === 'pending_approval' && live ? t('emp.sent_back') : t('common.saved')); if (r.status !== j.status) render();
  } });
  const act = (label, fn, cls = '') => h('button', { class: `btn ${cls}`, type: 'button', onclick: async () => { try { await fn(); render(); } catch (e) { toast(tError(e), 'bad'); } } }, label);
  const actions = id ? h('div', { class: 'btn-row' },
    ['draft', 'changes_requested', 'rejected'].includes(j.status) ? act(t('emp.submit_review'), async () => { await post(`/employer/jobs/${id}/submit`); toast(t('emp.submitted')); }) : null,
    j.status === 'pending_approval' ? act(t('emp.withdraw_submission'), () => post(`/employer/jobs/${id}/withdraw-submission`), 'secondary') : null,
    j.status === 'published' ? act(t('emp.pause'), () => post(`/employer/jobs/${id}/pause`), 'secondary') : null,
    j.status === 'paused' && j.published_version === j.version ? act(t('emp.resume'), () => post(`/employer/jobs/${id}/resume`), 'secondary') : null,
    j.status !== 'closed' ? h('button', { class: 'btn danger', type: 'button', onclick: async () => { const r = await confirmReason({ title: t('emp.close'), label: t('emp.close_reason'), confirmLabel: t('emp.close'), danger: true, hint: t('emp.close_hint') }); if (r === null) return; try { await post(`/employer/jobs/${id}/close`, { reason: r }); toast(t('emp.closed')); render(); } catch (e) { toast(tError(e), 'bad'); } } }, t('emp.close')) : null,
    h('a', { class: 'btn secondary', href: `#/employer/jobs/${id}/applicants` }, t('emp.applicants'))) : null;
  const versions = id ? await get(`/employer/jobs/${id}/versions`) : [];
  return h('div', { class: 'stack' }, h('p', {}, h('a', { href: '#/employer/jobs' }, h('span', { class: 'flip', 'aria-hidden': 'true' }, '←'), ' ', t('nav.my_jobs'))),
    h('h1', {}, id ? j.title : t('emp.new_job')),
    id ? h('div', { class: 'card' }, h('p', {}, enumBadge('jstatus', j.status), ' ', h('span', { class: 'mono' }, j.reference_no)), j.status_reason ? h('p', { class: 'notice warn' }, t('emp.reviewer_note'), ': ', userText('span', t(`reason.${j.status_reason}`) !== `reason.${j.status_reason}` ? t(`reason.${j.status_reason}`) : j.status_reason)) : null, actions) : null,
    locked ? h('p', { class: 'notice' }, j.status === 'closed' ? t('emp.locked_closed') : t('emp.locked_review')) : null,
    live ? h('p', { class: 'notice warn' }, t('emp.live_warning')) : null, body,
    versions.length ? h('section', { class: 'card' }, h('h2', {}, t('emp.versions')), table([{ label: t('emp.version'), key: 'version' }, { label: t('emp.approved_at'), render: (v) => fmtDateTime(v.created_at) }, { label: t('emp.material_changes'), render: (v) => (v.material_changes.length ? v.material_changes.map((c) => tEnum('field', c.field)).join(', ') : '—') }], versions)) : null);
}

async function applicants({ params }) {
  const [rows, job] = await Promise.all([get(`/employer/jobs/${params.id}/applicants`), get(`/employer/jobs/${params.id}`)]);
  const mode = rows[0]?.recruitment_mode;
  const run = async (a, action, body = {}) => { try { const r = await post(`/employer/applications/${a.id}/${action}`, body); toast(r.request ? t('emp.request_sent') : t('common.saved')); render(); } catch (e) { toast(tError(e), 'bad'); } };
  const card = (a) => h('article', { class: 'card stack' }, h('div', { class: 'row' }, h('h3', { dir: 'auto' }, a.candidate.full_name), enumBadge('stage', a.stage)),
    dl([[t('prof.profession'), userText('span', a.candidate.profession)], [t('job.location'), userText('span', [a.candidate.city, a.candidate.country].filter(Boolean).join(', '))], [t('prof.experience'), a.candidate.experience_years != null ? t('job.years', { n: fmtNumber(a.candidate.experience_years) }) : '—'],
      [t('prof.skills'), a.candidate.skills.length ? h('ul', { class: 'tags' }, a.candidate.skills.map((s) => h('li', { dir: 'auto' }, s))) : '—'], [t('prof.languages'), a.candidate.languages.map((l) => `${l.code.toUpperCase()}${l.level ? ` ${l.level}` : ''}`).join(', ') || '—'],
      [t('emp.contact'), a.contact_disclosed ? h('span', { dir: 'ltr' }, `${a.candidate.email || ''} ${a.candidate.phone || ''}`) : t('emp.contact_withheld')], [t('apps.submitted'), fmtDate(a.created_at)], a.cover_note ? [t('emp.cover_note'), userText('span', a.cover_note)] : null]),
    a.pending_requests.length ? h('p', {}, a.pending_requests.map((p) => badge(t('emp.pending_request', { type: tEnum('rtype', p) }), 'warn'))) : null,
    ['rejected', 'position_closed'].includes(a.stage) ? null : h('div', { class: 'btn-row' },
      a.stage === 'under_review' || a.stage === 'submitted' ? h('button', { class: 'btn small', type: 'button', onclick: () => run(a, 'shortlist') }, t('emp.shortlist')) : null,
      h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { const note = await confirmReason({ title: t('emp.request_interview'), label: t('emp.note_optional'), required: false, confirmLabel: t('emp.request_interview') }); if (note !== null) run(a, 'request_interview', { note: note || null }); } }, t('emp.request_interview')),
      h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { const note = await confirmReason({ title: t('emp.request_selection'), label: t('emp.note_optional'), required: false, confirmLabel: t('emp.request_selection'), hint: t('emp.selection_note') }); if (note !== null) run(a, 'request_selection', { note: note || null }); } }, t('emp.request_selection')),
      h('button', { class: 'btn danger small', type: 'button', onclick: async () => { const reason = await confirmReason({ title: t('emp.reject'), label: t('emp.reject_reason'), confirmLabel: t('emp.reject'), danger: true }); if (reason !== null) run(a, 'reject', { reason }); } }, t('emp.reject'))));
  return h('div', { class: 'stack' }, h('p', {}, h('a', { href: `#/employer/jobs/${params.id}` }, h('span', { class: 'flip', 'aria-hidden': 'true' }, '←'), ' ', job.title)), h('h1', {}, t('emp.applicants')), empNav('/employer/jobs'),
    h('div', { class: 'notice' }, mode ? h('p', {}, h('strong', {}, tEnum('mode', mode)), ': ', t(`emp.mode_${mode}`)) : null, h('p', {}, t('emp.selection_not_placement'))),
    rows.length ? h('div', { class: 'stack' }, rows.map(card)) : empty(t('emp.no_applicants'), t('emp.no_applicants_text')));
}
