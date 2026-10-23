'use strict';
function normEmail(v) {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').trim().toLowerCase();
  return s || null;
}
// Only E.164-style numbers are comparable; anything else returns null (never guessed).
function normPhone(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!/^\+[1-9]\d{6,14}$/.test(s)) return null;
  return s;
}
function normName(v) {
  if (typeof v !== 'string') return '';
  return v.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function normIdentity(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function normText(v) { return normName(v); }
function domainOf(urlOrEmail) {
  if (!urlOrEmail) return null;
  const s = String(urlOrEmail).trim().toLowerCase();
  const m = s.includes('@') ? s.split('@').pop() : s.replace(/^https?:\/\//, '').split('/')[0];
  return m.replace(/^www\./, '') || null;
}
module.exports = { normEmail, normPhone, normName, normIdentity, normText, domainOf };
