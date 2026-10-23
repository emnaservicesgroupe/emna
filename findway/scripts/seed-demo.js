'use strict';
// Seeds clearly synthetic demo data (never real people). Refuses to run in production.
// Usage: DATABASE_URL=... node scripts/seed-demo.js     (idempotent for the demo accounts)
const { load } = require('../src/config');
const { createDb } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { createContext } = require('../src/context');
const C = require('../src/lib/crypto');
const { createSuperAdmin } = require('../src/services/bootstrap');
const auth = require('../src/services/auth');
const jobs = require('../src/services/jobs');

const DEMO_PW = 'Demo-Password-2026!';

(async () => {
  const config = load();
  if (config.production) { console.error('Refusing to seed demo data in production.'); process.exit(1); }
  const db = createDb(config.databaseUrl); const ctx = createContext({ config, db });
  await migrate(db);
  const out = [];
  const exists = (email) => db.one('SELECT id FROM users WHERE email_norm=$1', [email]);

  async function internal(email, role, name) {
    let u = await exists(email);
    const secret = C.newTotpSecret();
    if (!u) {
      u = role === 'super_admin'
        ? await createSuperAdmin(ctx, { email, password: DEMO_PW, full_name: name })
        : await db.one(`INSERT INTO users (email, email_norm, password_hash, role, full_name, email_verified_at, approval_status) VALUES ($1,$1,$2,$3,$4,now(),'approved') RETURNING id`, [email, C.hashPassword(DEMO_PW), role, name]);
      await db.query('UPDATE users SET mfa_secret_enc=$2, mfa_enrolled_at=now() WHERE id=$1', [u.id, C.encrypt(secret, ctx.keys.enc)]);
      out.push({ email, role, password: DEMO_PW, totp_secret: secret });
    }
    return (await exists(email)).id;
  }
  const adminId = await internal('admin@demo.findway.test', 'admin', 'Demo Admin');
  await internal('superadmin@demo.findway.test', 'super_admin', 'Demo Super Admin');
  await internal('staff@demo.findway.test', 'staff', 'Demo Staff');

  async function verifiedUser(email, role, name, org, locale) {
    let u = await exists(email);
    if (u) return u.id;
    await auth.register(ctx, { email, password: DEMO_PW, full_name: name, role, locale, accept_terms: true, org });
    const code = ctx.mailer.captured.at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
    await auth.verifyEmail(ctx, { email, code });
    out.push({ email, role, password: DEMO_PW });
    return (await exists(email)).id;
  }
  const admin = { userId: adminId, role: 'admin', emailVerified: true, approval: 'approved', status: 'active', mfaVerified: true, orgs: [], via: 'system' };

  const employers = [
    ['employer1@demo.findway.test', 'Demo Shipyard Hamburg GmbH', 'Germany', 'Hamburg', 'en'],
    ['employer2@demo.findway.test', 'Demo Hotel Group Tirana', 'Albania', 'Tirana', 'sq'],
  ];
  const created = [];
  for (const [email, name, country, city, locale] of employers) {
    const uid = await verifiedUser(email, 'employer_owner', 'Demo Owner', { name, country, city, registration_number: `DEMO-${country.slice(0, 2).toUpperCase()}-0001` }, locale);
    await auth.decideApproval(ctx, admin, uid, { decision: 'approved', note: 'Synthetic demo account' }).catch(() => {});
    const m = await db.one('SELECT org_id FROM memberships WHERE user_id=$1', [uid]);
    await db.query(`UPDATE organizations SET verification_status='verified', verified_by=$2, verified_at=now(), public_profile=true, description=$3 WHERE id=$1`, [m.org_id, adminId, `${name} — synthetic demo company`]);
    created.push({ uid, orgId: m.org_id });
  }
  const principal = async (uid) => ({ userId: uid, role: 'employer_owner', emailVerified: true, approval: 'approved', status: 'active', mfaVerified: true, via: 'system', orgs: [{ orgId: created.find((c) => c.uid === uid).orgId, role: 'owner', type: 'employer', verificationStatus: 'verified' }] });
  const demoJobs = [
    [0, { title: 'MIG/TIG Welder', profession: 'Welder', country: 'Germany', city: 'Hamburg', description: 'Join our ship-building team. Demo posting.', responsibilities: 'Weld hull sections to specification.', requirements: '3+ years industrial welding.', employment_type: 'full_time', vacancies: 4, salary_specified: true, salary_min: 2800, salary_max: 3400, salary_currency: 'EUR', salary_period: 'month', salary_basis: 'gross', accommodation: 'provided', hours_per_day: 8, days_per_week: 5, contract_months: 24, probation_months: 3, skills: ['mig welding', 'tig welding'], languages: [{ code: 'en', level: 'B1' }] }],
    [0, { title: 'Industrial Electrician', profession: 'Electrician', country: 'Germany', city: 'Bremen', description: 'Maintenance electrician (demo).', requirements: 'Vocational electrical qualification.', employment_type: 'full_time', salary_specified: false, skills: ['plc', 'wiring'] }],
    [1, { title: 'Front Desk Receptionist', profession: 'Receptionist', country: 'Albania', city: 'Tirana', description: 'Demo hotel receptionist role.', requirements: 'Fluent Albanian and English.', employment_type: 'full_time', salary_specified: true, salary_min: 60000, salary_max: 75000, salary_currency: 'ALL', salary_period: 'month', salary_basis: 'net', languages: [{ code: 'sq', level: 'native' }, { code: 'en', level: 'B2' }] }],
    [1, { title: 'Cook (Mediterranean kitchen)', profession: 'Cook', country: 'Albania', city: 'Durrës', description: 'Demo kitchen position.', requirements: '2 years restaurant experience.', employment_type: 'seasonal', accommodation: 'allowance', skills: ['grill'] }],
  ];
  for (const [i, body] of demoJobs) {
    const actor = await principal(created[i].uid);
    if (await db.one('SELECT 1 FROM jobs WHERE org_id=$1 AND title=$2', [created[i].orgId, body.title])) continue;
    const j = await jobs.createDraft(ctx, actor, body);
    await jobs.submit(ctx, actor, j.id);
    await jobs.review(ctx, admin, j.id, { decision: 'approve' });
  }
  console.log(JSON.stringify({ note: 'Synthetic demo accounts. Use `node scripts/totp.js <totp_secret>` for the MFA code of internal accounts.', created_accounts: out }, null, 2));
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
