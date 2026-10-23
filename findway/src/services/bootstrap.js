'use strict';
// Creates the first Super Admin out-of-band (CLI). There is intentionally no HTTP endpoint for this.
const C = require('../lib/crypto');
const { normEmail } = require('../lib/normalize');
const auth = require('./auth');
const { audit, SYSTEM } = require('./audit');

async function createSuperAdmin(ctx, { email, password, full_name }) {
  auth.checkPassword(password, email);
  const emailNorm = normEmail(email);
  return ctx.db.tx(async (q) => {
    if (await q.one('SELECT 1 FROM users WHERE email_norm=$1', [emailNorm])) throw new Error('A user with this email already exists');
    const u = await q.one(
      `INSERT INTO users (email, email_norm, password_hash, role, full_name, email_verified_at, approval_status, approval_decided_at)
       VALUES ($1,$2,$3,'super_admin',$4,now(),'approved',now()) RETURNING id, email`,
      [email.trim(), emailNorm, C.hashPassword(password), full_name || 'Super Admin']);
    await audit(q, SYSTEM, { action: 'user.super_admin_bootstrapped', entityType: 'user', entityId: u.id });
    return u;
  });
}
module.exports = { createSuperAdmin };
