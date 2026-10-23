import { get, post, uuid, ApiError } from '../api.js';
import { t, tEnum, tError } from '../i18n.js';
import { h, link, userText, badge, field, checkbox, form, empty, pager, dl, confirmDialog, toast, enumBadge, val, num, tagInput } from '../ui.js';
import { fmtDate, fmtMoney, fmtNumber, fmtDateTime } from '../format.js';
import { state } from '../store.js';
import { go } from '../router.js';

export const salaryText = (s) => {
  if (!s || !s.specified) return t('job.salary_not_specified');
  const range = s.min != null && s.max != null && s.min !== s.max ? `${fmtMoney(s.min, s.currency)} – ${fmtMoney(s.max, s.currency)}` : fmtMoney(s.min ?? s.max, s.currency);
  return `${range} / ${tEnum('period', s.period)}${s.basis && s.basis !== 'unspecified' ? ` (${tEnum('basis', s.basis)})` : ''}`;
};
export const verifBadge = (e) => (e.verification_status === 'verified' ? badge(`✓ ${t('company.verified')}`, 'ok') : badge(t('company.not_verified'), 'warn'));
export const yesNo = (v) => (v === true ? t('common.yes') : v === false ? t('common.no') : t('common.not_specified'));
const where = (l) => [l.city, l.country].filter(Boolean).join(', ') || '—';

export function jobCard(j) {
  return h('article', { class: 'card job-card' },
    h('h3', {}, h('a', { href: `#/jobs/${j.reference_no}`, dir: 'auto' }, j.title)),
    h('p', { class: 'muted' }, userText('span', j.employer.name), ' ', verifBadge(j.employer)),
    h('ul', { class: 'meta' }, h('li', {}, '📍 ', userText('span', where(j.location))), h('li', {}, salaryText(j.salary)),
      j.contract.employment_type ? h('li', {}, tEnum('etype', j.contract.employment_type)) : null, h('li', {}, tEnum('wmode', j.contract.work_mode)),
      h('li', {}, `${t('job.ref')}: ${j.reference_no}`), j.deadline ? h('li', {}, `${t('job.deadline')}: ${fmtDate(j.deadline)}`) : null));
}

export function registerPublic(route) {
  route('/', home); route('/jobs', jobs); route('/jobs/:id', jobDetail); route('/companies', companies); route('/companies/:id', company);
  route('/help', help); route('/privacy', () => legal('privacy')); route('/terms', () => legal('terms')); route('/contact', contact);
}

async function home() {
  const q = field({ label: t('jobs.keyword'), name: 'q', placeholder: t('home.search_ph') });
  const c = field({ label: t('jobs.country'), name: 'country' });
  const search = h('form', { class: 'searchbox', role: 'search', onsubmit: (e) => { e.preventDefault(); go(`/jobs?${new URLSearchParams({ ...(q.input.value ? { q: q.input.value } : {}), ...(c.input.value ? { country: c.input.value } : {}) })}`); } },
    q.el, c.el, h('button', { class: 'btn', type: 'submit' }, t('home.search')));
  let latest;
  try { const r = await get('/public/jobs', { query: { limit: 6 } }); latest = r.items.length ? h('div', { class: 'grid cols-2' }, r.items.map(jobCard)) : empty(t('home.no_jobs'), t('home.no_jobs_text')); }
  catch (e) { latest = h('p', { class: 'notice bad' }, t('home.jobs_error')); }
  return h('div', { class: 'stack' },
    h('section', { class: 'hero' }, h('p', { class: 'tagline' }, t('brand.tagline')), h('h1', {}, t('home.title')), h('p', {}, t('home.lead')), search),
    h('section', {}, h('h2', {}, t('home.latest')), latest, h('p', {}, h('a', { href: '#/jobs' }, t('home.all_jobs'), ' ', h('span', { class: 'flip', 'aria-hidden': 'true' }, '→')))),
    h('section', { class: 'grid cols-3' },
      h('div', { class: 'card tint' }, h('h3', {}, t('home.cand_title')), h('p', {}, t('home.cand_text')), h('a', { class: 'btn', href: '#/register' }, t('home.cand_cta'))),
      h('div', { class: 'card tint' }, h('h3', {}, t('home.emp_title')), h('p', {}, t('home.emp_text')), h('a', { class: 'btn secondary', href: '#/register' }, t('home.emp_cta'))),
      h('div', { class: 'card tint' }, h('h3', {}, t('home.how_title')), h('p', {}, t('home.how_text')))));
}

const FILTER_KEYS = ['q', 'profession', 'country', 'city', 'experience_years', 'skills', 'languages', 'salary_min', 'salary_max', 'salary_currency', 'salary_period', 'employment_type', 'work_mode', 'accommodation', 'relocation_support', 'sort'];

async function jobs({ query }) {
  const limit = 10; const offset = Number(query.offset) || 0;
  const f = (name, label, extra = {}) => field({ label, name, value: query[name] ?? '', ...extra });
  const opt = (prefix, vals) => [{ value: '', label: t('common.any') }, ...vals.map((v) => ({ value: v, label: tEnum(prefix, v) }))];
  const fields = {
    q: f('q', t('jobs.keyword')), profession: f('profession', t('jobs.profession')), country: f('country', t('jobs.country')), city: f('city', t('jobs.city')),
    experience_years: f('experience_years', t('jobs.experience'), { type: 'number', min: 0, hint: t('jobs.experience_hint') }),
    skills: f('skills', t('jobs.skills'), { hint: t('jobs.comma_hint') }), languages: f('languages', t('jobs.languages'), { hint: t('jobs.lang_hint') }),
    salary_min: f('salary_min', t('jobs.salary_min'), { type: 'number', min: 0 }), salary_max: f('salary_max', t('jobs.salary_max'), { type: 'number', min: 0 }),
    salary_currency: f('salary_currency', t('jobs.currency'), { maxlength: 3, hint: t('jobs.currency_hint') }),
    salary_period: f('salary_period', t('jobs.period'), { options: opt('period', ['hour', 'day', 'week', 'month', 'year']) }),
    employment_type: f('employment_type', t('jobs.etype'), { options: opt('etype', ['full_time', 'part_time', 'contract', 'seasonal', 'temporary']) }),
    work_mode: f('work_mode', t('jobs.wmode'), { options: opt('wmode', ['onsite', 'remote', 'hybrid']) }),
    sort: f('sort', t('jobs.sort'), { options: [{ value: '', label: t('sort.newest') }, { value: 'deadline', label: t('sort.deadline') }, { value: 'salary_desc', label: t('sort.salary_desc') }] }),
  };
  const acc = checkbox({ label: t('jobs.accommodation'), name: 'accommodation', checked: !!query.accommodation });
  const rel = checkbox({ label: t('jobs.relocation'), name: 'relocation_support', checked: !!query.relocation_support });
  const submit = (e) => {
    e.preventDefault(); const p = new URLSearchParams();
    for (const k of FILTER_KEYS) { const inp = fields[k]?.input; const v = inp ? inp.value.trim() : ''; if (v) p.set(k, k === 'salary_currency' ? v.toUpperCase() : v); }
    if (acc.input.checked) p.set('accommodation', '1'); if (rel.input.checked) p.set('relocation_support', '1');
    go(`/jobs${p.toString() ? `?${p}` : ''}`);
  };
  const panel = h('form', { class: 'card filters-panel', id: 'filters', role: 'search', 'aria-label': t('jobs.filters'), hidden: window.innerWidth < 900 && !Object.keys(query).length ? true : false, onsubmit: submit },
    h('div', { class: 'grid cols-2' }, fields.q.el, fields.profession.el, fields.country.el, fields.city.el, fields.experience_years.el, fields.skills.el, fields.languages.el, fields.employment_type.el, fields.work_mode.el),
    h('fieldset', {}, h('legend', {}, t('jobs.salary')), h('div', { class: 'grid cols-4' }, fields.salary_min.el, fields.salary_max.el, fields.salary_currency.el, fields.salary_period.el)),
    h('div', { class: 'grid cols-2' }, acc.el, rel.el, fields.sort.el),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'submit' }, t('jobs.apply_filters')), h('a', { class: 'btn secondary', href: '#/jobs' }, t('jobs.clear'))));
  const toggle = h('button', { class: 'btn secondary filters-toggle', type: 'button', 'aria-expanded': String(!panel.hidden), 'aria-controls': 'filters', onclick: () => { panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); } }, t('jobs.filters'));
  const params = {}; for (const k of FILTER_KEYS) if (query[k]) params[k] = query[k];
  const res = await get('/public/jobs', { query: { ...params, limit, offset } });
  const list = res.items.length ? h('div', { class: 'stack' }, res.items.map(jobCard)) : empty(t('jobs.none'), t('jobs.none_text'), h('a', { class: 'btn secondary', href: '#/jobs' }, t('jobs.clear')));
  const pg = pager({ offset, limit, total: res.total, onPage: (o) => { const p = new URLSearchParams(query); p.set('offset', String(o)); go(`/jobs?${p}`); } });
  return h('div', { class: 'stack' }, h('h1', {}, t('jobs.title')), toggle, panel, h('p', { class: 'muted', role: 'status' }, t('jobs.count', { n: fmtNumber(res.total) })), list, pg);
}

async function jobDetail({ params, retry }) {
  const j = await get(`/public/jobs/${encodeURIComponent(params.id)}`);
  const me = state.me;
  const applyArea = h('div', { class: 'card tint stack' });
  const msg = (k, kind = '') => h('p', { class: `notice ${kind}` }, t(k));
  if (!me) applyArea.append(msg('apply.login'), h('a', { class: 'btn', href: `#/login?next=${encodeURIComponent(`/jobs/${j.reference_no}`)}` }, t('nav.login')), ' ', h('a', { class: 'btn secondary', href: '#/register' }, t('nav.register')));
  else if (me.role !== 'candidate') applyArea.append(msg('apply.only_candidates'));
  else if (me.status.approval !== 'approved') applyArea.append(msg('apply.pending_approval', 'warn'));
  else if (!me.status.profile_completion?.ready_to_apply) applyArea.append(msg('apply.complete_profile', 'warn'), h('a', { class: 'btn', href: '#/candidate/profile' }, t('cand.profile')));
  else {
    const btn = h('button', { class: 'btn', type: 'button' }, t('apply.cta'));
    const key = uuid();
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog(t('apply.confirm_title'), t('apply.confirm_text', { title: j.title }), t('apply.cta'));
      if (!ok) return;
      btn.disabled = true;
      try {
        const r = await post('/candidate/applications', { job_id: j.id }, { headers: { 'Idempotency-Key': key } });
        toast(t('apply.done')); go(`/candidate/applications/${r.id}`);
      } catch (e) {
        btn.disabled = false;
        if (e instanceof ApiError && e.code === 'already_applied' && e.details?.application_id) go(`/candidate/applications/${e.details.application_id}`);
        else toast(tError(e), 'bad');
      }
    });
    applyArea.append(btn, h('p', { class: 'small muted' }, t('apply.note')));
  }
  const text = (title, body) => (body ? h('section', {}, h('h3', {}, title), userText('p', body, { class: 'pre' })) : null);
  return h('article', { class: 'stack' },
    h('p', {}, h('a', { href: '#/jobs' }, h('span', { class: 'flip', 'aria-hidden': 'true' }, '←'), ' ', t('jobs.title'))),
    h('div', { class: 'row' }, h('div', {}, h('h1', { dir: 'auto' }, j.title), h('p', {}, userText('span', j.employer.name), ' ', verifBadge(j.employer)))),
    h('div', { class: 'grid cols-2' },
      h('section', { class: 'card' }, h('h2', {}, t('job.overview')), dl([
        [t('job.ref'), h('span', { class: 'mono' }, j.reference_no)], [t('job.profession'), userText('span', j.profession)], [t('job.category'), userText('span', j.category)], [t('job.vacancies'), fmtNumber(j.vacancies)],
        [t('job.location'), userText('span', [j.location.address, j.location.city, j.location.country].filter(Boolean).join(', ') || '—')],
        j.location.latitude != null ? [t('job.map'), link(`https://www.openstreetmap.org/?mlat=${j.location.latitude}&mlon=${j.location.longitude}#map=14/${j.location.latitude}/${j.location.longitude}`, t('job.map_open'))] : null,
        [t('job.salary'), salaryText(j.salary)], [t('job.employment_type'), tEnum('etype', j.contract.employment_type)], [t('job.work_mode'), tEnum('wmode', j.contract.work_mode)],
        [t('job.experience'), j.experience_min_years != null ? t('job.years', { n: fmtNumber(j.experience_min_years) }) : t('common.not_specified')],
        [t('job.deadline'), j.deadline ? fmtDate(j.deadline) : t('common.not_specified')], [t('job.accepted_formats'), j.accepted_formats.map((f) => tEnum('format', f)).join(', ')],
        [t('job.reapply'), yesNo(j.allow_reapplication)],
      ])),
      h('section', { class: 'card' }, h('h2', {}, t('job.terms')), dl([
        [t('job.hours'), j.schedule.hours_per_day != null ? t('job.hours_value', { n: fmtNumber(j.schedule.hours_per_day) }) : t('common.not_specified')],
        [t('job.days'), j.schedule.days_per_week != null ? t('job.days_value', { n: fmtNumber(j.schedule.days_per_week) }) : t('common.not_specified')],
        [t('job.shifts'), userText('span', j.schedule.shifts || t('common.not_specified'))], [t('job.overtime'), userText('span', j.schedule.overtime_terms || t('common.not_specified'))],
        [t('job.contract'), j.contract.duration_months != null ? t('job.months', { n: fmtNumber(j.contract.duration_months) }) : t('common.not_specified')],
        [t('job.probation'), j.contract.probation_months != null ? t('job.months', { n: fmtNumber(j.contract.probation_months) }) : t('common.not_specified')],
        [t('job.accommodation'), tEnum('benefit', j.benefits.accommodation)], [t('job.food'), tEnum('benefit', j.benefits.food)], [t('job.transport'), tEnum('benefit', j.benefits.transport)],
        [t('job.insurance'), tEnum('benefit', j.benefits.insurance)], [t('job.other_benefits'), userText('span', j.benefits.other || t('common.not_specified'))],
        [t('job.relocation'), yesNo(j.relocation_support)],
      ]))),
    h('section', { class: 'card tint' }, h('h2', {}, t('job.intl')), h('p', { class: 'small muted' }, t('job.intl_note')), dl([
      [t('job.intl_open'), yesNo(j.international_recruitment.open_to_international)], [t('job.intl_visa'), yesNo(j.international_recruitment.employer_confirmed_visa_support)]])),
    h('section', { class: 'card stack' }, text(t('job.description'), j.description), text(t('job.responsibilities'), j.responsibilities), text(t('job.requirements'), j.requirements),
      j.skills.length ? h('div', {}, h('h3', {}, t('job.skills')), h('ul', { class: 'tags' }, j.skills.map((s) => h('li', { dir: 'auto' }, s)))) : null,
      j.languages.length ? h('div', {}, h('h3', {}, t('job.languages')), h('ul', { class: 'tags' }, j.languages.map((l) => h('li', {}, `${l.code.toUpperCase()}${l.level ? ` · ${l.level}` : ''}`)))) : null),
    h('p', { class: 'small muted' }, `${t('job.last_verified')}: ${fmtDateTime(j.last_verified_at)} · ${t('job.revision')} ${j.revision} · ${t('job.published')}: ${fmtDate(j.published_at)}`),
    applyArea);
}

async function companies({ query }) {
  const q = field({ label: t('jobs.keyword'), name: 'q', value: query.q ?? '' }); const c = field({ label: t('jobs.country'), name: 'country', value: query.country ?? '' });
  const res = await get('/public/companies', { query: { q: query.q, country: query.country, limit: 24 } });
  const list = res.length ? h('div', { class: 'grid cols-3' }, res.map((o) => h('article', { class: 'card' }, h('h3', {}, h('a', { href: `#/companies/${o.id}`, dir: 'auto' }, o.name)), verifBadge(o),
    h('p', { class: 'muted small' }, userText('span', [o.city, o.country].filter(Boolean).join(', ')), o.industry ? ' · ' : '', userText('span', o.industry || '')), h('p', { class: 'small' }, t('company.open_jobs', { n: fmtNumber(o.open_jobs) }))))) : empty(t('company.none'), t('company.none_text'));
  return h('div', { class: 'stack' }, h('h1', {}, t('companies.title')),
    h('form', { class: 'card grid cols-3', role: 'search', onsubmit: (e) => { e.preventDefault(); go(`/companies?${new URLSearchParams({ ...(q.input.value ? { q: q.input.value } : {}), ...(c.input.value ? { country: c.input.value } : {}) })}`); } }, q.el, c.el, h('div', {}, h('button', { class: 'btn', type: 'submit' }, t('home.search')))), list);
}
async function company({ params }) {
  const o = await get(`/public/companies/${params.id}`);
  return h('article', { class: 'stack' }, h('p', {}, h('a', { href: '#/companies' }, h('span', { class: 'flip', 'aria-hidden': 'true' }, '←'), ' ', t('companies.title'))),
    h('h1', { dir: 'auto' }, o.name), verifBadge(o),
    h('div', { class: 'card' }, dl([[t('company.location'), userText('span', [o.city, o.country].filter(Boolean).join(', ') || '—')], [t('company.industry'), userText('span', o.industry)],
      [t('company.website'), o.website ? link(o.website, o.website, { dir: 'ltr' }) : '—'], [t('company.about'), userText('span', o.description)], [t('company.open_jobs_label'), fmtNumber(o.open_jobs)]])),
    h('p', {}, h('a', { class: 'btn', href: `#/jobs?q=${encodeURIComponent(o.name)}` }, t('company.see_jobs'))));
}

function help() {
  const faq = ['apply', 'verify', 'approval', 'data', 'visa'].map((k) => h('details', { class: 'card' }, h('summary', {}, h('strong', {}, t(`faq.${k}.q`))), h('p', {}, t(`faq.${k}.a`))));
  return h('div', { class: 'stack' }, h('h1', {}, t('help.title')), h('p', {}, t('help.lead')), faq, h('p', {}, h('a', { href: '#/contact' }, t('nav.contact'))));
}
function legal(kind) { return h('div', { class: 'stack' }, h('h1', {}, t(`${kind}.title`)), h('p', { class: 'notice warn' }, t('legal.placeholder')), h('p', {}, t(`${kind}.text`))); }
function contact() { return h('div', { class: 'stack' }, h('h1', {}, t('contact.title')), h('p', { class: 'notice warn' }, t('contact.pending')), h('p', {}, t('contact.alt'))); }
