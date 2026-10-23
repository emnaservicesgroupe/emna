import { LANGS, detectLang, setLang, t, lang } from './i18n.js';
import { h, clear, link, toast } from './ui.js';
import { loadMe, state, role, can, isCrm, homeFor, clearMe } from './store.js';
import { onSessionExpired, post, patch, setToken, hasToken } from './api.js';
import { route, start, go, render, current } from './router.js';
import { registerPublic } from './views/public.js';
import { registerAuth } from './views/auth.js';
import { registerCandidate } from './views/candidate.js';
import { registerEmployer } from './views/employer.js';
import { registerAgency } from './views/agency.js';
import { registerStaff } from './views/staff.js';
import { registerAdmin } from './views/admin.js';
import { registerShared } from './views/shared.js';

const app = document.getElementById('app');
let headerEl; let mainEl; let installEvt = null; let menuOpen = false;

const navLink = (href, text, path) => h('a', { href: `#${href}`, 'aria-current': path === href || (href !== '/' && path.startsWith(`${href}/`)) ? 'page' : null }, text);

function headerNav(path) {
  const items = [navLink('/jobs', t('nav.jobs'), path), navLink('/companies', t('nav.companies'), path), navLink('/help', t('nav.help'), path)];
  const me = state.me;
  if (me) {
    items.push(navLink(homeFor(), isCrm() ? t('nav.crm') : t('nav.account'), path === '/' ? '' : path));
    if (role() === 'candidate') items.push(navLink('/candidate/applications', t('nav.applications'), path));
    if (role() === 'employer_owner' || role() === 'employer_member') items.push(navLink('/employer/jobs', t('nav.my_jobs'), path));
  }
  return items;
}
function langSelect() {
  const sel = h('select', { class: 'lang-select', id: 'lang-select', 'aria-label': t('nav.language') }, Object.entries(LANGS).map(([c, l]) => h('option', { value: c, selected: c === lang() }, l.name)));
  sel.addEventListener('change', async () => {
    await setLang(sel.value);
    if (state.me) { try { await patch('/me', { locale: sel.value }); } catch (_) { /* preference sync is best-effort */ } }
    paintChrome(current().path); await render();
  });
  return sel;
}
async function logout() {
  try { await post('/auth/logout'); } catch (_) { /* token may already be invalid */ }
  setToken(null); clearMe(); paintChrome('/'); go('/');
}
function paintHeader(path) {
  const crm = isCrm();
  const nav = h('nav', { id: 'main-nav', class: `main-nav ${menuOpen ? 'open' : ''}`, 'aria-label': t('nav.main') }, headerNav(path),
    h('div', { class: 'nav-end' }, langSelect(),
      state.me ? h('button', { type: 'button', class: 'linklike', onclick: logout }, t('nav.logout')) : [navLink('/login', t('nav.login'), path), h('a', { class: 'btn', href: '#/register' }, t('nav.register'))]));
  const toggle = h('button', { type: 'button', class: 'btn secondary nav-toggle', 'aria-expanded': String(menuOpen), 'aria-controls': 'main-nav', onclick: () => { menuOpen = !menuOpen; paintChrome(current().path); document.getElementById('main-nav')?.querySelector('a,button')?.focus(); } }, t('nav.menu'));
  return h('header', { class: 'site-header' }, h('div', { class: 'container bar' },
    h('a', { class: 'brand', href: '#/', 'aria-label': 'FIND WAY' }, h('img', { src: 'assets/findway-logo-header.png', alt: 'FIND WAY', width: '112', height: '40' }), crm ? h('span', { class: 'crm-tag' }, 'CRM') : null), toggle, nav));
}
function paintFooter() {
  const install = installEvt ? h('button', { type: 'button', class: 'btn secondary small', onclick: async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; paintChrome(current().path); } }, t('pwa.install')) : null;
  return h('footer', { class: 'footer' }, h('div', { class: 'container stack' }, h('p', { class: 'tagline-foot' }, h('strong', {}, 'FIND WAY'), ' — ', t('brand.tagline')),
    h('nav', { 'aria-label': t('nav.footer') }, navLink('/help', t('nav.help'), ''), navLink('/privacy', t('nav.privacy'), ''), navLink('/terms', t('nav.terms'), ''), navLink('/contact', t('nav.contact'), '')), install));
}
function paintChrome(path) {
  const header = paintHeader(path); headerEl.replaceWith(header); headerEl = header;
  document.getElementById('skip-link').textContent = t('nav.skip');
  const old = document.getElementById('footer-host'); const f = paintFooter(); f.id = 'footer-host'; old.replaceWith(f);
}

const CRM_NAV = [
  ['/crm', 'crm.overview', null, null],
  ['grp', 'crm.grp_work'],
  ['/crm/leads', 'crm.leads', 'leads:work'], ['/crm/duplicates', 'crm.duplicates', 'leads:work'], ['/crm/candidates', 'crm.candidates', 'candidates:view_assigned'],
  ['/crm/companies', 'crm.companies', 'orgs:view_assigned'], ['/crm/requests', 'crm.requests', 'requests:resolve'], ['/crm/cases', 'crm.cases', 'cases:work'],
  ['grp', 'crm.grp_review'],
  ['/crm/approvals', 'crm.approvals', 'users:approve'], ['/crm/company-verifications', 'crm.verifications', 'orgs:verify'], ['/crm/job-reviews', 'crm.job_reviews', 'jobs:review'],
  ['grp', 'crm.grp_admin'],
  ['/crm/staff', 'crm.staff', 'users:approve'], ['/crm/integrations', 'crm.integrations', 'integrations:view'], ['/crm/audit', 'crm.audit', 'audit:read'], ['/settings', 'nav.settings', null],
];
function crmSide(path) {
  return h('nav', { class: `crm-side ${menuOpen ? 'open' : ''}`, 'aria-label': t('crm.nav') },
    CRM_NAV.filter(([, , perm]) => !perm || can(perm)).map(([href, key]) => href === 'grp' ? h('div', { class: 'grp' }, t(key)) : navLink(href, t(key), path)));
}

const shell = {
  mount(area, node, path) {
    menuOpen = false;
    clear(mainEl);
    paintChrome(path);
    if (area === 'crm' && isCrm()) {
      const toggle = h('button', { type: 'button', class: 'btn secondary crm-toggle', 'aria-expanded': String(menuOpen), onclick: () => { menuOpen = !menuOpen; paintChrome(current().path); mainEl.querySelector('.crm-side')?.classList.toggle('open', menuOpen); } }, t('crm.menu'));
      mainEl.append(h('div', { class: 'container' }, toggle, h('div', { class: 'crm-layout' }, crmSide(path), h('div', { class: 'crm-content stack' }, node))));
    } else mainEl.append(h('div', { class: 'container' }, node));
    const h1 = mainEl.querySelector('h1');
    document.title = `${h1 ? h1.textContent : 'FIND WAY'} — FIND WAY${area === 'crm' ? ' CRM' : ''}`;
    if (h1 && !node.matches?.('.state[aria-busy]') && !mainEl.querySelector('[aria-busy="true"]')) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: false }); window.scrollTo(0, 0); }
  },
};

async function boot() {
  await setLang(detectLang());
  try { if (hasToken()) await loadMe(); } catch (_) { /* offline: public pages still work */ }
  headerEl = h('header'); mainEl = h('main', { id: 'main', tabindex: '-1' }); const foot = h('footer', { id: 'footer-host' });
  app.append(headerEl, mainEl, foot);
  registerPublic(route); registerAuth(route); registerCandidate(route); registerEmployer(route); registerAgency(route); registerStaff(route); registerAdmin(route); registerShared(route);
  onSessionExpired(() => { clearMe(); toast(t('auth.session_expired'), 'bad'); go('/login?expired=1'); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; paintChrome(current().path); });
  window.addEventListener('fw:me-changed', () => paintChrome(current().path));
  await start(shell);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
export { shell, paintChrome };
