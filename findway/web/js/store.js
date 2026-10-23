import { get, hasToken, ApiError } from './api.js';
import { setTimezone } from './format.js';

export const state = { me: null };
export async function loadMe() {
  if (!hasToken()) { state.me = null; return null; }
  try { state.me = await get('/me'); setTimezone(state.me.timezone); }
  catch (e) { if (e instanceof ApiError && e.status === 401) state.me = null; else throw e; }
  return state.me;
}
export const clearMe = () => { state.me = null; };
export const role = () => state.me?.role || null;
export const can = (p) => !!state.me && (state.me.permissions.includes('*') || state.me.permissions.includes(p));
export const isCrm = () => ['staff', 'admin', 'super_admin'].includes(role());
export const isAdmin = () => ['admin', 'super_admin'].includes(role());
export const isEmployer = () => ['employer_owner', 'employer_member'].includes(role());
export function homeFor(r = role()) {
  return { candidate: '/candidate', employer_owner: '/employer', employer_member: '/employer', agency: '/agency', staff: '/crm', admin: '/crm', super_admin: '/crm' }[r] || '/';
}
