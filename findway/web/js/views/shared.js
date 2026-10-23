import { get, post, patch, del, setToken } from '../api.js';
import { t, tEnum, lang, LANGS, setLang } from '../i18n.js';
import { h, field, form, empty, toast, table, badge, enumBadge, confirmDialog } from '../ui.js';
import { fmtDateTime } from '../format.js';
import { state, loadMe, clearMe, homeFor, isCrm } from '../store.js';
import { setTimezone } from '../format.js';
import { go, render } from '../router.js';

export const progressClass = (p) => `w${Math.min(100, Math.max(0, Math.round((p || 0) / 10) * 10))}`;
export const statusCard = (title, value, note) => h('div', { class: 'card' }, h('h3', {}, title), h('p', {}, value), note ? h('p', { class: 'small muted', dir: 'auto' }, note) : null);

export function approvalCard(me) {
  const a = me.status.approval;
  return statusCard(t('status.approval'), enumBadge('approval', a), a === 'pending' ? t('status.approval_pending_note') : a === 'rejected' ? (me.status.approval_note || t('status.approval_rejected_note')) : me.status.approval_note);
}

export function registerShared(route) {
  route('/settings', settings, { auth: true, area: 'public' });
  route('/notifications', notifications, { auth: true });
}

function describeNotification(n) {
  const p = n.payload || {};
  const known = ['application.status', 'case.stage', 'job.terms_changed', 'job.review_decided', 'org.verification_decided'];
  if (!known.includes(n.type)) return n.type;
  return t(`notif.${n.type}`, { stage: tEnum('stage', p.stage), decision: tEnum('decision', p.decision), n: p.fields ? p.fields.map((f) => tEnum('field', f)).join(', ') : '' });
}
async function notifications() {
  const r = await get('/notifications');
  const list = r.items.length ? h('ul', { class: 'stack', role: 'list' }, r.items.map((n) => h('li', { class: 'card' }, h('div', { class: 'row' }, h('strong', {}, describeNotification(n)), n.read_at ? null : badge(t('notif.new'), 'gold')),
    h('p', { class: 'small muted' }, fmtDateTime(n.created_at)), n.payload?.message ? h('p', { dir: 'auto' }, n.payload.message) : null,
    n.payload?.application_id ? h('a', { href: `#/candidate/applications/${n.payload.application_id}` }, t('notif.open')) : null,
    n.read_at ? null : h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { await post(`/notifications/${n.id}/read`); render(); } }, t('notif.mark_read'))))) : empty(t('notif.none'), t('notif.none_text'));
  return h('div', { class: 'stack' }, h('h1', {}, t('notif.title')), list);
}

async function settings() {
  const me = state.me;
  const sel = field({ label: t('nav.language'), name: 'locale', value: lang(), options: Object.entries(LANGS).map(([c, l]) => ({ value: c, label: l.name })) });
  const zones = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['UTC']);
  if (!zones.includes('UTC')) zones.push('UTC');
  const tz = field({ label: t('settings.timezone'), name: 'timezone', value: me.timezone, options: zones.map((z) => ({ value: z, label: z })), hint: t('settings.timezone_hint') });
  const prefs = form({ submitLabel: t('common.save'), children: [sel.el, tz.el], onSubmit: async () => {
    await patch('/me', { locale: sel.input.value, timezone: tz.input.value });
    await setLang(sel.input.value); await loadMe(); setTimezone(tz.input.value); window.dispatchEvent(new Event('fw:me-changed')); toast(t('common.saved')); render();
  } });
  const sessions = await get('/auth/sessions');
  const sessTable = table([
    { label: t('settings.started'), render: (s) => fmtDateTime(s.created_at) }, { label: t('settings.last_seen'), render: (s) => fmtDateTime(s.last_seen_at) },
    { label: t('settings.device'), render: (s) => h('span', { dir: 'ltr', class: 'small' }, (s.user_agent || '—').slice(0, 60)) },
    { label: '', render: (s) => (s.current ? badge(t('settings.current'), 'ok') : h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { await del(`/auth/sessions/${s.id}`); toast(t('settings.revoked')); render(); } }, t('settings.revoke'))) },
  ], sessions);
  const mfa = me.status.mfa.required ? h('div', { class: 'card' }, h('h2', {}, t('mfa.title')), h('p', {}, me.status.mfa.enrolled ? t('mfa.enabled') : t('mfa.not_enabled')), me.status.mfa.enrolled ? null : h('a', { class: 'btn', href: '#/mfa-setup' }, t('mfa.setup'))) : null;
  return h('div', { class: 'stack' }, h('h1', {}, t('nav.settings')),
    h('div', { class: 'card' }, h('h2', {}, t('settings.account')), h('p', { dir: 'auto' }, `${me.full_name} · ${me.email}`), h('p', {}, enumBadge('role', me.role))),
    h('div', { class: 'card' }, h('h2', {}, t('settings.preferences')), prefs), mfa,
    h('div', { class: 'card' }, h('h2', {}, t('settings.sessions')), sessTable),
    h('p', {}, h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await post('/auth/logout'); } catch (_) { /* already invalid */ } setToken(null); clearMe(); window.dispatchEvent(new Event('fw:me-changed')); go('/'); } }, t('nav.logout'))));
}
