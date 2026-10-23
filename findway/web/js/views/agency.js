import { t } from '../i18n.js';
import { h, enumBadge } from '../ui.js';
import { state } from '../store.js';
import { approvalCard, statusCard } from './shared.js';

export function registerAgency(route) { route('/agency', overview, { auth: true, roles: ['agency'] }); }
function overview() {
  const me = state.me; const org = me.status.organizations[0];
  return h('div', { class: 'stack' }, h('h1', {}, t('agency.title')), h('p', { class: 'notice' }, t('agency.later')),
    h('div', { class: 'grid cols-3' }, approvalCard(me), statusCard(t('emp.verification'), enumBadge('verification', org?.verification_status))),
    h('p', {}, h('a', { class: 'btn secondary', href: '#/settings' }, t('nav.settings'))));
}
