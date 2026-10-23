import { locale } from './i18n.js';
let tz;
export function setTimezone(z) { tz = z || undefined; }
const safe = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
export function fmtDate(v) {
  if (!v) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00Z`) : new Date(v);
  return safe(() => new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeZone: /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'UTC' : tz }).format(d), String(v));
}
export function fmtDateTime(v) {
  if (!v) return '—';
  return safe(() => new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(v)), String(v));
}
export const fmtNumber = (n) => (n === null || n === undefined ? '—' : safe(() => new Intl.NumberFormat(locale()).format(n), String(n)));
export function fmtMoney(n, currency) {
  if (n === null || n === undefined) return '—';
  return safe(() => new Intl.NumberFormat(locale(), { style: 'currency', currency, maximumFractionDigits: 2 }).format(n), `${n} ${currency}`);
}
export function fmtDuration(seconds) {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${fmtNumber(m)} min`;
  const h = Math.floor(m / 60); return h < 48 ? `${fmtNumber(h)} h` : `${fmtNumber(Math.floor(h / 24))} d`;
}
