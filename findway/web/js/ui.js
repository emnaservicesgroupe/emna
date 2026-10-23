import { t, tError, tEnum } from './i18n.js';
import { ApiError } from './api.js';

// ── DOM builder: all dynamic text goes through text nodes, never innerHTML ──
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden') el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const uid = (() => { let n = 0; return (p = 'f') => `${p}${++n}`; })();

export function safeHref(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith('#/')) return url;
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? u.href : null; } catch (_) { return null; }
}
export function link(href, text, props = {}) {
  const ok = safeHref(href);
  if (!ok) return h('span', props, text);
  const external = !ok.startsWith('#/');
  return h('a', { href: ok, ...(external ? { rel: 'noopener noreferrer', target: '_blank' } : {}), ...props }, text);
}
// user-entered text: preserve original language and direction
export const userText = (tag, text, props = {}) => h(tag, { dir: 'auto', ...props }, text ?? '');

export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);
export const statusKind = (v) => (['approved', 'verified', 'published', 'qualified', 'connected', 'succeeded', 'selected', 'applied', 'active', 'resolved_local', 'resolved_remote'].includes(v) ? 'ok'
  : ['rejected', 'dead', 'failed', 'suspended', 'auth_failed', 'unreachable', 'closed', 'position_closed', 'withdrawn'].includes(v) ? 'bad'
    : ['pending', 'pending_approval', 'submitted', 'received', 'missing_information', 'changes_requested', 'retry', 'blocked', 'configured_untested', 'not_configured', 'open', 'paused', 'conflict'].includes(v) ? 'warn' : '');

// ── toasts (announced through the aria-live region) ──
export function toast(message, kind = 'ok') {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind === 'ok' ? '' : 'bad'}` }, message);
  box.append(el); setTimeout(() => el.remove(), kind === 'ok' ? 4500 : 8000);
}

// ── page states ──
export const loading = () => h('div', { class: 'state', role: 'status', 'aria-busy': 'true' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', {}, t('state.loading')));
export const skeleton = (rows = 4) => h('div', { 'aria-busy': 'true', role: 'status' }, h('span', { class: 'sr-only' }, t('state.loading')), Array.from({ length: rows }, () => h('div', { class: 'skeleton' })));
export const empty = (title, text, action) => h('div', { class: 'state' }, h('h2', {}, title), text ? h('p', {}, text) : null, action || null);

const DENIED = { email_verification_required: 'denied.email', approval_required: 'denied.approval', mfa_required: 'denied.mfa', account_suspended: 'denied.suspended', permission_denied: 'denied.generic' };
export function errorState(err, retry) {
  if (err instanceof ApiError && err.status === 403) {
    const k = DENIED[err.code] || 'denied.generic';
    return h('div', { class: 'state', role: 'alert' }, h('h1', { tabindex: '-1' }, t('denied.title')), h('p', {}, t(k)),
      err.code === 'mfa_required' ? h('a', { class: 'btn', href: '#/mfa-setup' }, t('mfa.setup')) : null, h('a', { class: 'btn secondary', href: '#/' }, t('nav.home')));
  }
  const timeout = err instanceof ApiError && (err.code === 'timeout' || err.code === 'network_error');
  return h('div', { class: 'state', role: 'alert' },
    h('h1', { tabindex: '-1' }, t(timeout ? 'err.slow_title' : 'err.title')), h('p', {}, tError(err)),
    retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, t('common.retry')) : null,
    err && err.correlationId ? h('details', { class: 'errdetails' }, h('summary', {}, t('err.details')), h('p', { class: 'mono small' }, `${t('err.reference')}: ${err.correlationId}`)) : null);
}

// ── dialogs (native <dialog>: focus trap + Esc) ──
export function modal({ title, body, actions }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { 'aria-labelledby': 'dlg-title' });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    dlg.append(h('div', { class: 'dlg' }, h('h2', { id: 'dlg-title' }, title), body, h('div', { class: 'btn-row' }, actions(close))));
    document.body.append(dlg); dlg.showModal();
  });
}
export function confirmReason({ title, label, required = true, confirmLabel, danger = false, hint }) {
  const input = h('textarea', { id: 'dlg-reason', name: 'reason', rows: '3', 'aria-required': required ? 'true' : 'false' });
  const err = h('p', { class: 'err', role: 'alert', id: 'dlg-err' });
  return modal({
    title,
    body: h('div', { class: 'field' }, h('label', { for: 'dlg-reason' }, label), hint ? h('span', { class: 'hint' }, hint) : null, input, err),
    actions: (close) => [
      h('button', { class: `btn ${danger ? 'danger' : ''}`, type: 'button', onclick: () => {
        const v = input.value.trim();
        if (required && !v) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'dlg-err'); err.textContent = t('v.required'); input.focus(); return; }
        close(v || '');
      } }, confirmLabel || t('common.confirm')),
      h('button', { class: 'btn secondary', type: 'button', onclick: () => close(null) }, t('common.cancel')),
    ],
  });
}
export const confirmDialog = (title, text, confirmLabel, danger) => modal({
  title, body: h('p', {}, text),
  actions: (close) => [h('button', { class: `btn ${danger ? 'danger' : ''}`, type: 'button', onclick: () => close(true) }, confirmLabel || t('common.confirm')), h('button', { class: 'btn secondary', type: 'button', onclick: () => close(null) }, t('common.cancel'))],
});

// ── forms ──
export function field({ label, name, type = 'text', value = '', required = false, hint, options, textarea, rows, autocomplete, placeholder, min, max, step, inputmode, maxlength, id }) {
  const fid = id || uid(name || 'f');
  let input;
  if (options) {
    input = h('select', { id: fid, name }, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label)));
  } else if (textarea) input = h('textarea', { id: fid, name, rows: rows || 4, value: value ?? '', maxlength });
  else input = h('input', { id: fid, name, type, value: value ?? '', autocomplete, placeholder, min, max, step, inputmode, maxlength });
  if (required) input.setAttribute('aria-required', 'true');
  const err = h('span', { class: 'err', id: `${fid}-err`, role: 'alert' });
  const hintEl = hint ? h('span', { class: 'hint', id: `${fid}-hint` }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', `${fid}-hint`);
  if (type === 'email' || type === 'tel' || type === 'url' || type === 'password' || type === 'text') input.setAttribute('dir', type === 'text' && !name?.match(/email|code/) ? 'auto' : 'ltr');
  const el = h('div', { class: 'field' }, h('label', { for: fid }, label, required ? h('span', { 'aria-hidden': 'true' }, ' *') : null), hintEl, input, err);
  return { el, input };
}
export function checkbox({ label, name, checked = false, id }) {
  const fid = id || uid(name || 'c');
  const input = h('input', { type: 'checkbox', id: fid, name, checked });
  const err = h('span', { class: 'err', id: `${fid}-err`, role: 'alert' });
  return { el: h('div', { class: 'field' }, h('div', { class: 'check' }, input, h('label', { for: fid }, label)), err), input };
}
export function setFieldError(input, msg) {
  const err = input.parentElement && (input.parentElement.querySelector('.err') || input.closest('.field')?.querySelector('.err'));
  if (msg) { input.setAttribute('aria-invalid', 'true'); const id = err && err.id; if (id) { const d = (input.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && x !== id); d.push(id); input.setAttribute('aria-describedby', d.join(' ')); } if (err) err.textContent = msg; }
  else { input.removeAttribute('aria-invalid'); if (err) err.textContent = ''; }
}
// form(): handles client-side required checks, pending state, server validation errors and errors in general.
export function form({ onSubmit, children, submitLabel, submitClass = '', extra, id }) {
  const errBox = h('div', { class: 'notice bad', role: 'alert', hidden: true });
  const submit = h('button', { class: `btn ${submitClass}`, type: 'submit' }, submitLabel || t('common.save'));
  const el = h('form', { novalidate: true, id }, children, errBox, h('div', { class: 'btn-row' }, submit, extra || null));
  el.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errBox.hidden = true; clear(errBox);
    el.querySelectorAll('[aria-invalid]').forEach((i) => setFieldError(i, null));
    let first = null;
    el.querySelectorAll('[aria-required="true"]').forEach((i) => {
      const missing = i.type === 'checkbox' ? !i.checked : !String(i.value).trim();
      if (missing) { setFieldError(i, t('v.required')); first = first || i; }
      else if (i.type === 'email' && !/^\S+@\S+\.\S+$/.test(i.value)) { setFieldError(i, t('v.email')); first = first || i; }
    });
    if (first) { first.focus(); return; }
    submit.disabled = true; el.setAttribute('aria-busy', 'true');
    try { await onSubmit(el); }
    catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const fields = e.code === 'validation_failed' && Array.isArray(e.details) ? e.details : [];
      let focused = false;
      for (const d of fields) {
        const input = el.querySelector(`[name="${d.path.split('.')[0]}"]`);
        if (input) { setFieldError(input, d.message); if (!focused) { input.focus(); focused = true; } }
      }
      if (!focused) { errBox.hidden = false; errBox.append(h('strong', {}, tError(e)), e.details && !Array.isArray(e.details) ? h('p', { class: 'small mono' }, summariseDetails(e.details)) : null); errBox.focus?.(); }
      if (e.correlationId) errBox.append(h('p', { class: 'small mono' }, `${t('err.reference')}: ${e.correlationId}`));
      el.dispatchEvent(new CustomEvent('apierror', { detail: e }));
    } finally { submit.disabled = false; el.removeAttribute('aria-busy'); }
  });
  return el;
}
const summariseDetails = (d) => { try { return Object.entries(d).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '); } catch (_) { return ''; } };
export const formData = (el) => Object.fromEntries(new FormData(el).entries());
export const val = (input) => { const v = String(input.value).trim(); return v === '' ? null : v; };
export const num = (input) => { const v = String(input.value).trim(); return v === '' ? null : Number(v); };

// ── tag input & repeater ──
export function tagInput({ label, value = [], id, hint }) {
  const fid = id || uid('tags'); let items = [...value];
  const list = h('ul', { class: 'tags', 'aria-label': label });
  const input = h('input', { id: fid, type: 'text', dir: 'auto', maxlength: 60 });
  const paint = () => { clear(list); items.forEach((it, i) => list.append(h('li', {}, h('span', { dir: 'auto' }, it), h('button', { type: 'button', 'aria-label': `${t('common.remove')} ${it}`, onclick: () => { items.splice(i, 1); paint(); } }, '×')))); };
  const add = () => { const v = input.value.trim(); if (v && !items.includes(v)) { items.push(v); paint(); } input.value = ''; };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } });
  paint();
  const el = h('div', { class: 'field' }, h('label', { for: fid }, label), hint ? h('span', { class: 'hint' }, hint) : null, list,
    h('div', { class: 'btn-row' }, input, h('button', { type: 'button', class: 'btn secondary small', onclick: add }, t('common.add'))));
  input.style.flex = '1';
  return { el, get: () => { add(); return [...items]; } };
}
export function repeater({ legend, fields, value = [], addLabel }) {
  const box = h('div', { class: 'stack' }); const rows = [];
  const addRow = (v = {}) => {
    const row = {}; const wrap = h('div', { class: 'grid cols-3' });
    for (const f of fields) { const fl = field({ label: f.label, name: f.key, type: f.type || 'text', value: v[f.key] ?? '', options: f.options, min: f.min, max: f.max }); row[f.key] = fl.input; wrap.append(fl.el); }
    const rm = h('button', { type: 'button', class: 'btn secondary small', onclick: () => { rows.splice(rows.indexOf(row), 1); card.remove(); } }, t('common.remove'));
    const card = h('div', { class: 'card' }, wrap, rm); row.card = card; rows.push(row); box.append(card);
  };
  value.forEach(addRow);
  const el = h('fieldset', {}, h('legend', {}, legend), box, h('p', {}, h('button', { type: 'button', class: 'btn secondary small', onclick: () => addRow() }, addLabel || t('common.add'))));
  const get = () => rows.map((r) => {
    const o = {};
    for (const f of fields) { const v = r[f.key].value.trim(); if (v !== '') o[f.key] = f.type === 'number' ? Number(v) : v; }
    return o;
  }).filter((o) => Object.keys(o).length);
  return { el, get };
}

// ── data table → stacked cards on narrow screens ──
export function table(cols, rows, { empty: emptyEl } = {}) {
  if (!rows.length) return emptyEl || empty(t('common.nothing'));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'cards' },
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => h('td', { 'data-label': c.label }, c.render ? c.render(r) : (r[c.key] ?? '—'))))))));
}
export function pager({ offset, limit, total, onPage }) {
  if (!total || total <= limit) return null;
  const page = Math.floor(offset / limit) + 1; const pages = Math.ceil(total / limit);
  return h('nav', { class: 'pager', 'aria-label': t('common.pagination') },
    h('button', { class: 'btn secondary', type: 'button', disabled: offset <= 0, onclick: () => onPage(Math.max(0, offset - limit)) }, h('span', { class: 'flip', 'aria-hidden': 'true' }, '←'), ' ', t('common.prev')),
    h('span', {}, t('common.page_of', { page, pages })),
    h('button', { class: 'btn secondary', type: 'button', disabled: offset + limit >= total, onclick: () => onPage(offset + limit) }, t('common.next'), ' ', h('span', { class: 'flip', 'aria-hidden': 'true' }, '→')));
}
export const dl = (pairs) => h('dl', { class: 'dl' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));
export const enumBadge = (prefix, v) => badge(tEnum(prefix, v), statusKind(v));
export function copyButton(text, label) {
  return h('button', { type: 'button', class: 'btn secondary small', onclick: async () => { try { await navigator.clipboard.writeText(text); toast(t('common.copied')); } catch (_) { toast(t('common.copy_failed'), 'bad'); } } }, label || t('common.copy'));
}
