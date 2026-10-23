import { state, homeFor } from './store.js';
import { errorState, loading } from './ui.js';
import { ApiError, takeExpired } from './api.js';

const routes = [];
let shell = null; let renderId = 0;

export function route(pattern, view, opts = {}) {
  const keys = []; const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
  routes.push({ re, keys, view, opts });
}
export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs || '')) };
}
export const go = (path, { replace = false } = {}) => { const h = `#${path}`; if (replace) location.replace(h); else location.hash = h; };
export const current = () => parseHash();

function match(path) {
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) return { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

export async function render() {
  const { path, query } = parseHash();
  const id = ++renderId;
  const m = match(path);
  const mount = (area, node) => { if (id === renderId) shell.mount(area, node, path); };
  if (!m) { mount('public', errorState(new ApiError(404, { error: { code: 'not_found', message: 'Not found' } }))); return; }
  const { opts } = m.r; const me = state.me;
  if (opts.auth && !me) { go(`/login?next=${encodeURIComponent(path)}${takeExpired() ? '&expired=1' : ''}`, { replace: true }); return; }
  if (me && me.status.mfa.required && !me.status.mfa.verified && path !== '/mfa-setup' && opts.auth) { go('/mfa-setup', { replace: true }); return; }
  if (opts.roles && (!me || !opts.roles.includes(me.role))) { mount(opts.area || 'public', errorState(new ApiError(403, { error: { code: 'permission_denied' } }))); return; }
  if (opts.perm && !(me && (me.permissions.includes('*') || me.permissions.includes(opts.perm)))) { mount(opts.area || 'public', errorState(new ApiError(403, { error: { code: 'permission_denied' } }))); return; }
  mount(opts.area || 'public', loading());
  let node;
  try { node = await m.r.view({ params: m.params, query, retry: render, me }); }
  catch (e) { node = errorState(e instanceof ApiError ? e : new ApiError(0, { error: { code: 'unknown', message: String(e.message || e) } }), render); console.error(e); }
  mount(opts.area || 'public', node);
}
export function start(s) { shell = s; window.addEventListener('hashchange', render); return render(); }
export { homeFor };
