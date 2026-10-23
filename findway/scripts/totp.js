'use strict';
// Prints the current 6-digit code for a base32 TOTP secret (development helper for seeded demo accounts).
const C = require('../src/lib/crypto');
const secret = process.argv[2];
if (!secret) { console.error('Usage: node scripts/totp.js <base32-secret>'); process.exit(2); }
console.log(C.totpAt(secret, C.totpStep(Date.now())));
