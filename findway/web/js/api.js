// Thin fetch wrapper: bearer token, 15s timeout, structured errors, 401 handling.
export class ApiError extends Error {
  constructor(status, body) {
    const e = body && body.error ? body.error : {};
    super(e.message || `HTTP ${status}`);
    this.status = status; this.code = e.code || (status === 0 ? 'network_error' : 'http_error'); this.details = e.details; this.correlationId = e.correlation_id;
  }
}
let token = null;
try { token = localStorage.getItem('fw_token'); } catch (_) { /* no storage: session lives in memory */ }
const listeners = new Set();
export const onSessionExpired = (fn) => listeners.add(fn);
export function setToken(t) {
  token = t || null;
  try { if (t) localStorage.setItem('fw_token', t); else localStorage.removeItem('fw_token'); } catch (_) { /* ignore */ }
}
export const hasToken = () => !!token;
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export async function api(method, path, { body, headers = {}, timeout = 15000, query } = {}) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeout);
  let url = `/api${path}`;
  if (query) { const p = new URLSearchParams(); for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, v); const s = p.toString(); if (s) url += (url.includes('?') ? '&' : '?') + s; }
  let res;
  try {
    res = await fetch(url, {
      method, signal: ctl.signal,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, { error: { code: e.name === 'AbortError' ? 'timeout' : 'network_error', message: 'Network problem' } });
  } finally { clearTimeout(timer); }
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-json */ }
  if (!res.ok) {
    const err = new ApiError(res.status, json);
    if (res.status === 401 && token && !path.startsWith('/auth/login')) { setToken(null); listeners.forEach((f) => f()); }
    throw err;
  }
  return json;
}
export const get = (p, o) => api('GET', p, o);
export const post = (p, body, o) => api('POST', p, { body: body ?? {}, ...o });
export const patch = (p, body, o) => api('PATCH', p, { body, ...o });
export const put = (p, body, o) => api('PUT', p, { body, ...o });
export const del = (p, o) => api('DELETE', p, o);
