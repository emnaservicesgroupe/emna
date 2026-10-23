'use strict';
// Usage: SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... node scripts/create-super-admin.js
// The account must enrol MFA on first sign-in before it can do anything privileged.
const { load } = require('../src/config');
const { createDb } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { createContext } = require('../src/context');
const { createSuperAdmin } = require('../src/services/bootstrap');

(async () => {
  const { SUPERADMIN_EMAIL: email, SUPERADMIN_PASSWORD: password, SUPERADMIN_NAME: name } = process.env;
  if (!email || !password) { console.error('Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD'); process.exit(2); }
  const config = load(); const db = createDb(config.databaseUrl); const ctx = createContext({ config, db });
  await migrate(db);
  const u = await createSuperAdmin(ctx, { email, password, full_name: name });
  console.log(`Super Admin created: ${u.email}`);
  await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
