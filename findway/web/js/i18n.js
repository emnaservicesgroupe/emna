// Language registry: adding a language = one JSON file in /i18n + one line here.
export const LANGS = {
  en: { name: 'English', dir: 'ltr', locale: 'en' },
  ar: { name: 'العربية', dir: 'rtl', locale: 'ar' },
  sq: { name: 'Shqip', dir: 'ltr', locale: 'sq' },
  fr: { name: 'Français', dir: 'ltr', locale: 'fr' },
};
const cache = {};
let current = 'en';
let dict = {};
let fallback = {};

async function load(code) {
  if (cache[code]) return cache[code];
  const res = await fetch(`i18n/${code}.json`);
  if (!res.ok) throw new Error(`cannot load language ${code}`);
  return (cache[code] = await res.json());
}
export function storedLang() { try { return localStorage.getItem('fw_lang'); } catch (_) { return null; } }
export function detectLang() {
  const s = storedLang(); if (s && LANGS[s]) return s;
  for (const l of navigator.languages || [navigator.language || 'en']) { const c = String(l).slice(0, 2).toLowerCase(); if (LANGS[c]) return c; }
  return 'en';
}
export async function setLang(code) {
  if (!LANGS[code]) code = 'en';
  fallback = await load('en');
  dict = code === 'en' ? fallback : await load(code);
  current = code;
  try { localStorage.setItem('fw_lang', code); } catch (_) { /* storage unavailable */ }
  document.documentElement.lang = code;
  document.documentElement.dir = LANGS[code].dir;
  return code;
}
export const lang = () => current;
export const locale = () => LANGS[current].locale;
export const isRtl = () => LANGS[current].dir === 'rtl';
export function t(key, params) {
  let s = dict[key] ?? fallback[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] === undefined ? `{${k}}` : String(params[k])));
  return s;
}
// Enum values (stages, statuses ...) come from the API; unknown ones fall back to the raw value.
export function tEnum(prefix, value) {
  if (value === null || value === undefined || value === '') return '—';
  const k = `${prefix}.${value}`;
  return dict[k] ?? fallback[k] ?? String(value);
}
export function tError(err) {
  const k = `err.${err.code}`;
  return dict[k] ?? fallback[k] ?? err.message ?? t('err.unknown');
}
