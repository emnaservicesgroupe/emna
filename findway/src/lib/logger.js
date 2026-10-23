'use strict';
const SENSITIVE = /pass(word)?|token|secret|code|authorization|cookie|passport|identity|otp|signature/i;
function redact(v, depth = 0) {
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(val, depth + 1);
  return out;
}
function createLogger({ silent = false } = {}) {
  const emit = (level, msg, fields) => {
    if (silent) return;
    process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...redact(fields || {}) }) + '\n');
  };
  return { info: (m, f) => emit('info', m, f), warn: (m, f) => emit('warn', m, f), error: (m, f) => emit('error', m, f) };
}
module.exports = { createLogger, redact };
