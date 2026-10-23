import { get, post, put, patch, ApiError } from '../api.js';
import { t, tEnum, tError } from '../i18n.js';
import { h, field, checkbox, form, empty, toast, badge, enumBadge, tagInput, repeater, confirmReason, dl, val, num, userText } from '../ui.js';
import { fmtDate, fmtDateTime } from '../format.js';
import { state, loadMe } from '../store.js';
import { render } from '../router.js';
import { approvalCard, progressClass, statusCard } from './shared.js';

const R = { auth: true, roles: ['candidate'] };
export function registerCandidate(route) {
  route('/candidate', overview, R); route('/candidate/profile', profile, R); route('/candidate/applications', applications, R);
  route('/candidate/applications/:id', applicationDetail, R); route('/candidate/privacy', privacy, R);
}
export const candNav = (active) => h('nav', { class: 'row', 'aria-label': t('nav.account') }, h('div', { class: 'btn-row' }, [['/candidate', 'cand.overview'], ['/candidate/profile', 'cand.profile'], ['/candidate/applications', 'nav.applications'], ['/notifications', 'notif.title'], ['/candidate/privacy', 'cand.privacy'], ['/settings', 'nav.settings']]
  .map(([href, k]) => h('a', { class: 'btn secondary small', href: `#${href}`, 'aria-current': active === href ? 'page' : null }, t(k)))));

const stageBadge = (s) => enumBadge('stage', s);

async function overview() {
  const me = state.me; const c = me.status.profile_completion;
  const [apps, acks] = await Promise.all([get('/candidate/applications'), get('/candidate/job-changes')]);
  return h('div', { class: 'stack' }, h('h1', {}, t('cand.welcome', { name: me.full_name })), candNav('/candidate'),
    me.status.approval !== 'approved' ? h('p', { class: 'notice warn' }, t('status.restricted_note')) : null,
    h('div', { class: 'grid cols-3' },
      statusCard(t('status.email'), badge(me.status.email_verified ? t('common.yes') : t('common.no'), me.status.email_verified ? 'ok' : 'warn')), approvalCard(me),
      h('div', { class: 'card' }, h('h3', {}, t('status.profile')), h('p', {}, `${c.percent}%`), h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(c.percent), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': t('status.profile') }, h('span', { class: progressClass(c.percent) })),
        c.missing_required.length ? h('p', { class: 'small' }, t('status.missing'), ': ', c.missing_required.map((f) => tEnum('field', f)).join(', ')) : h('p', { class: 'small muted' }, t('status.ready_to_apply')), h('a', { href: '#/candidate/profile' }, t('cand.edit_profile')))),
    acks.length ? h('section', { class: 'card notice warn' }, h('h2', {}, t('cand.acks_title')), h('ul', {}, acks.map((a) => h('li', {}, userText('span', a.title), ' — ', h('a', { href: `#/candidate/applications/${a.application_id}` }, t('cand.review_change'))))) ) : null,
    h('section', {}, h('h2', {}, t('cand.recent')), apps.length ? h('div', { class: 'stack' }, apps.slice(0, 3).map(appCard)) : empty(t('apps.none'), t('apps.none_text'), h('a', { class: 'btn', href: '#/jobs' }, t('nav.jobs')))));
}
const appCard = (a) => h('article', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, h('a', { href: `#/candidate/applications/${a.id}`, dir: 'auto' }, a.job.title)), stageBadge(a.stage)),
  h('p', { class: 'muted small' }, userText('span', a.job.employer), ' · ', a.reference_no, ' · ', fmtDate(a.created_at)));

async function applications() {
  const apps = await get('/candidate/applications');
  return h('div', { class: 'stack' }, h('h1', {}, t('nav.applications')), candNav('/candidate/applications'), apps.length ? h('div', { class: 'stack' }, apps.map(appCard)) : empty(t('apps.none'), t('apps.none_text'), h('a', { class: 'btn', href: '#/jobs' }, t('nav.jobs'))));
}

const fmtVal = (v) => (v === null || v === undefined ? t('common.not_specified') : typeof v === 'object' ? JSON.stringify(v) : String(v));
async function applicationDetail({ params }) {
  const a = await get(`/candidate/applications/${params.id}`);
  const terminal = ['rejected', 'withdrawn', 'position_closed'].includes(a.stage);
  const pending = a.job_changes.filter((c) => !c.acknowledged_at);
  const msgForm = a.stage === 'missing_information' ? (() => { const m = field({ label: t('apps.respond_label'), name: 'message', textarea: true, required: true, hint: t('apps.respond_hint') });
    return h('section', { class: 'card tint' }, h('h2', {}, t('apps.info_requested')), form({ submitLabel: t('apps.send'), children: [m.el], onSubmit: async () => { await post(`/candidate/applications/${a.id}/respond`, { message: m.input.value.trim() }); toast(t('common.saved')); render(); } })); })() : null;
  return h('div', { class: 'stack' }, h('p', {}, h('a', { href: '#/candidate/applications' }, h('span', { class: 'flip', 'aria-hidden': 'true' }, '←'), ' ', t('nav.applications'))),
    h('div', { class: 'row' }, h('h1', { dir: 'auto' }, a.job.title), stageBadge(a.stage)),
    h('div', { class: 'card' }, dl([[t('job.ref'), a.reference_no], [t('company.title'), userText('span', a.job.employer)], [t('job.location'), userText('span', [a.job.city, a.job.country].filter(Boolean).join(', '))], [t('apps.submitted'), fmtDateTime(a.created_at)], [t('apps.updated'), fmtDateTime(a.updated_at)]]), a.job.status === 'published' ? h('a', { href: `#/jobs/${a.job.reference_no}` }, t('apps.view_job')) : null),
    pending.length ? h('section', { class: 'notice warn' }, h('h2', {}, t('apps.changes_title')), h('p', {}, t('apps.changes_text')), pending.map((c) => h('div', { class: 'card stack' }, h('ul', {}, c.changes.map((x) => h('li', {}, h('strong', {}, tEnum('field', x.field)), ': ', fmtVal(x.from), ' → ', fmtVal(x.to)))),
      h('button', { class: 'btn', type: 'button', onclick: async () => { await post(`/candidate/applications/${a.id}/job-changes/${c.job_version}/ack`); toast(t('apps.acknowledged')); render(); } }, t('apps.acknowledge'))))) : null,
    msgForm,
    a.case ? h('div', { class: 'card tint' }, h('h2', {}, t('apps.case')), h('p', {}, a.case.reference_no, ' · ', enumBadge('case', a.case.stage)), h('p', { class: 'small muted' }, t('apps.case_note'))) : null,
    h('section', { class: 'card' }, h('h2', {}, t('apps.history')), h('ol', { class: 'timeline' }, a.history.map((e) => h('li', {}, h('strong', {}, tEnum('stage', e.to_stage)), ' ', h('span', { class: 'small muted' }, fmtDateTime(e.created_at)), e.message ? userText('p', e.message) : null)))),
    terminal ? null : h('p', {}, h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      const reason = await confirmReason({ title: t('apps.withdraw'), label: t('apps.withdraw_reason'), confirmLabel: t('apps.withdraw'), danger: true });
      if (reason === null) return;
      try { await post(`/candidate/applications/${a.id}/withdraw`, { reason }); toast(t('apps.withdrawn')); render(); } catch (e) { toast(tError(e), 'bad'); }
    } }, t('apps.withdraw'))));
}

async function profile() {
  const p = await get('/candidate/profile'); let version = p.version;
  const f = (name, label, o = {}) => field({ label, name, value: p[name] ?? '', ...o });
  const F = { full_name: f('full_name', t('auth.full_name'), { required: true }), phone: f('phone', t('prof.phone'), { type: 'tel', hint: t('prof.phone_hint'), autocomplete: 'tel' }),
    date_of_birth: f('date_of_birth', t('prof.dob'), { type: 'date' }), nationality: f('nationality', t('prof.nationality')), country: f('country', t('prof.country')), city: f('city', t('prof.city')),
    profession: f('profession', t('prof.profession')), experience_years: f('experience_years', t('prof.experience'), { type: 'number', min: 0, step: '0.5' }),
    availability_date: f('availability_date', t('prof.availability'), { type: 'date' }),
    salary_expectation_min: f('salary_expectation_min', t('prof.salary_min'), { type: 'number', min: 0 }), salary_expectation_max: f('salary_expectation_max', t('prof.salary_max'), { type: 'number', min: 0 }),
    salary_expectation_currency: f('salary_expectation_currency', t('jobs.currency'), { maxlength: 3, hint: t('jobs.currency_hint') }),
    salary_expectation_period: f('salary_expectation_period', t('jobs.period'), { options: [{ value: '', label: '—' }, ...['hour', 'day', 'week', 'month', 'year'].map((v) => ({ value: v, label: tEnum('period', v) }))] }),
    relocation_preference: f('relocation_preference', t('prof.relocation'), { textarea: true, rows: 3 }),
    visibility: f('visibility', t('prof.visibility'), { options: ['private', 'staff_only', 'catalogue_requested'].map((v) => ({ value: v, label: tEnum('visibility', v) })), hint: t('prof.visibility_hint') }) };
  const skills = tagInput({ label: t('prof.skills'), value: p.skills, hint: t('prof.tags_hint') }); const dest = tagInput({ label: t('prof.destinations'), value: p.desired_destinations, hint: t('prof.tags_hint') });
  const langs = repeater({ legend: t('prof.languages'), addLabel: t('prof.add_language'), value: p.languages, fields: [{ key: 'code', label: t('prof.lang_code') }, { key: 'level', label: t('prof.lang_level'), options: [{ value: '', label: '—' }, ...['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native'].map((v) => ({ value: v, label: v }))] }] });
  const edu = repeater({ legend: t('prof.education'), addLabel: t('prof.add_education'), value: p.education, fields: [{ key: 'institution', label: t('prof.institution') }, { key: 'degree', label: t('prof.degree') }, { key: 'year', label: t('prof.year'), type: 'number', min: 1950, max: 2100 }] });
  const cert = repeater({ legend: t('prof.certifications'), addLabel: t('prof.add_cert'), value: p.certifications, fields: [{ key: 'name', label: t('prof.cert_name') }, { key: 'issuer', label: t('prof.issuer') }, { key: 'year', label: t('prof.year'), type: 'number', min: 1950, max: 2100 }] });
  const conflict = h('div', { class: 'notice warn', hidden: true, role: 'alert' }, t('err.version_conflict'), ' ', h('button', { class: 'btn small', type: 'button', onclick: () => render() }, t('common.reload')));
  const nul = (i) => val(i); const n = (i) => num(i);
  const el = form({ submitLabel: t('common.save'), children: [conflict,
    h('fieldset', {}, h('legend', {}, t('prof.basic')), h('div', { class: 'grid cols-2' }, F.full_name.el, F.phone.el, F.date_of_birth.el, F.nationality.el, F.country.el, F.city.el)),
    h('fieldset', {}, h('legend', {}, t('prof.work')), h('div', { class: 'grid cols-2' }, F.profession.el, F.experience_years.el), skills.el, langs.el, edu.el, cert.el),
    h('fieldset', {}, h('legend', {}, t('prof.prefs')), h('div', { class: 'grid cols-2' }, F.availability_date.el, F.visibility.el), dest.el, F.relocation_preference.el,
      h('div', { class: 'grid cols-4' }, F.salary_expectation_min.el, F.salary_expectation_max.el, F.salary_expectation_currency.el, F.salary_expectation_period.el))],
  onSubmit: async () => {
    const body = { version, full_name: F.full_name.input.value.trim(), phone: nul(F.phone.input), date_of_birth: nul(F.date_of_birth.input), nationality: nul(F.nationality.input), country: nul(F.country.input), city: nul(F.city.input),
      profession: nul(F.profession.input), experience_years: n(F.experience_years.input), skills: skills.get(), languages: langs.get(), education: edu.get(), certifications: cert.get(), availability_date: nul(F.availability_date.input),
      desired_destinations: dest.get(), salary_expectation_min: n(F.salary_expectation_min.input), salary_expectation_max: n(F.salary_expectation_max.input), salary_expectation_currency: nul(F.salary_expectation_currency.input) ? nul(F.salary_expectation_currency.input).toUpperCase() : null,
      salary_expectation_period: nul(F.salary_expectation_period.input), relocation_preference: nul(F.relocation_preference.input), visibility: F.visibility.input.value };
    const r = await patch('/candidate/profile', body); version = r.version; await loadMe(); window.dispatchEvent(new Event('fw:me-changed')); toast(t('common.saved'));
  } });
  el.addEventListener('apierror', (e) => { if (e.detail.code === 'version_conflict') conflict.hidden = false; });
  return h('div', { class: 'stack' }, h('h1', {}, t('cand.profile')), candNav('/candidate/profile'), h('p', { class: 'notice' }, t('prof.intro')), el);
}

const CONSENTS = ['data_processing', 'marketing', 'media_sharing', 'ai_processing'];
async function privacy() {
  const rows = await get('/candidate/consents');
  const active = (type) => rows.some((r) => r.type === type && !r.revoked_at);
  const boxes = CONSENTS.map((c) => { const cb = checkbox({ label: `${tEnum('consent', c)} — ${t(`consent.${c}_desc`)}`, name: c, checked: active(c) });
    cb.input.addEventListener('change', async () => { cb.input.disabled = true; try { await put(`/candidate/consents/${c}`, { granted: cb.input.checked }); toast(t('common.saved')); } catch (e) { cb.input.checked = !cb.input.checked; toast(tError(e), 'bad'); } finally { cb.input.disabled = false; } });
    return cb.el; });
  const req = (type) => h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await post('/candidate/data-requests', { type }); toast(t('priv.requested')); } catch (e) { toast(tError(e), 'bad'); } } }, t(`priv.${type}`));
  return h('div', { class: 'stack' }, h('h1', {}, t('cand.privacy')), candNav('/candidate/privacy'),
    h('section', { class: 'card' }, h('h2', {}, t('priv.consents')), h('p', { class: 'small muted' }, t('priv.consents_note')), boxes),
    h('section', { class: 'card' }, h('h2', {}, t('priv.rights')), h('p', {}, t('priv.rights_text')), h('div', { class: 'btn-row' }, req('export'), req('deletion'))));
}
