'use strict';
const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function randomToken(bytes = 32) { return b64u(crypto.randomBytes(bytes)); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest('hex'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Purpose-bound subkeys so one leaked derived key never opens another domain.
function deriveKey(master, label) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `findway:${label}`, 32));
}

// ── passwords (scrypt) ──
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(h)}`;
}
function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'base64url'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(h, expected);
}
const DUMMY_HASH = hashPassword('findway-timing-equaliser');

// ── authenticated encryption (AES-256-GCM) ──
function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(ct)}`;
}
function decrypt(blob, key) {
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1') throw new Error('unsupported ciphertext version');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ── OTP ──
function otpCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

// ── TOTP (RFC 6238, SHA-1, 30s, 6 digits) ──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch); if (idx < 0) throw new Error('bad base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(secretB32, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
const totpStep = (nowMs) => Math.floor(nowMs / 30000);
// Returns the matched step (so callers can reject replays of the same step) or null.
function verifyTotp(secretB32, code, nowMs, lastUsedStep = null) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const cur = totpStep(nowMs);
  for (let s = cur - 1; s <= cur + 1; s++) {
    if (lastUsedStep !== null && s <= lastUsedStep) continue;
    if (safeEqual(totpAt(secretB32, s), code)) return s;
  }
  return null;
}
function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }

module.exports = {
  randomToken, sha256, hmac, safeEqual, deriveKey, hashPassword, verifyPassword, DUMMY_HASH,
  encrypt, decrypt, otpCode, base32Encode, base32Decode, totpAt, totpStep, verifyTotp, newTotpSecret,
};
