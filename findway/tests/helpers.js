'use strict';
// Test harness: isolated database per test file, controllable clock, captured mail, real HTTP server.
const crypto = require('node:crypto');
const http = require('node:http');
const { Client } = require('pg');
const { load } = require('../src/config');
const { createDb } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { createContext } = require('../src/context');
const { createApp } = require('../src/http/app');
const { createLogger } = require('../src/lib/logger');
const C = require('../src/lib/crypto');
const { createSuperAdmin } = require('../src/services/bootstrap');

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL || 'postgres://postgres@localhost:55432/postgres';
const PW = 'CorrectHorse-Battery9';

async function createTestEnv({ config: overrides = {}, rateLimits = false } = {}) {
  const name = `fw_test_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const config = { ...load({ NODE_ENV: 'test', DATABASE_URL: url, DEV_MAIL_CAPTURE: 'true', WEBHOOK_ALLOWED_HOSTS: '127.0.0.1,localhost' }), ...overrides };
  const db = createDb(url);
  await migrate(db);
  let offset = 0;
  const clock = { now: () => new Date(Date.now() + offset), advance: (ms) => { offset += ms; } };
  const ctx = createContext({ config, db, clock, log: createLogger({ silent: true }) });
  const app = createApp(ctx, { rateLimits });
  const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(method, path, { token, body, headers = {}, raw } = {}) {
    const res = await fetch(base + path, {
      method, headers: { ...(body !== undefined || raw ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* not json */ }
    return { status: res.status, body: json, headers: res.headers };
  }

  const lastCode = (email) => {
    const m = [...ctx.mailer.captured].reverse().find((x) => x.to === email && /\d{6}/.test(x.text));
    return m ? m.text.match(/\b(\d{6})\b/)[1] : null;
  };

  const env = {
    ctx, db, api, base, clock, lastCode,
    async close() { server.close(); await db.close(); const a = new Client({ connectionString: ADMIN_URL }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end(); },

    // register -> verify -> login; returns { token, email, userId }
    async signup({ role = 'candidate', email, full_name = 'Test User', org, password = PW, locale = 'en' }) {
      email = email || `${role}.${crypto.randomBytes(3).toString('hex')}@example.test`;
      const body = { email, password, full_name, role, locale, accept_terms: true, ...(org ? { org } : {}) };
      if (role !== 'candidate' && !org) body.org = { name: `Org ${crypto.randomBytes(3).toString('hex')}`, country: 'Albania' };
      const reg = await api('POST', '/api/auth/register', { body });
      if (reg.status !== 202) throw new Error(`register failed ${reg.status} ${JSON.stringify(reg.body)}`);
      const ver = await api('POST', '/api/auth/verify-email', { body: { email, code: lastCode(email) } });
      if (ver.status !== 200) throw new Error(`verify failed ${JSON.stringify(ver.body)}`);
      const login = await api('POST', '/api/auth/login', { body: { email, password } });
      const user = await db.one('SELECT id FROM users WHERE email_norm=$1', [email.toLowerCase()]);
      return { email, password, token: login.body.token, userId: user.id };
    },

    // internal users have enrolled TOTP so they can use privileged endpoints
    async internal(role = 'staff', { email } = {}) {
      email = email || `${role}.${crypto.randomBytes(3).toString('hex')}@findway.test`;
      const secret = C.newTotpSecret();
      const u = await db.one(
        `INSERT INTO users (email, email_norm, password_hash, role, full_name, email_verified_at, approval_status, mfa_secret_enc, mfa_enrolled_at)
         VALUES ($1,$1,$2,$3,$4,now(),'approved',$5,now()) RETURNING id`, [email, C.hashPassword(PW), role, `${role} ${email.slice(0, 4)}`, C.encrypt(secret, ctx.keys.enc)]);
      const who = { email, userId: u.id, secret, password: PW };
      who.login = async () => {
        clock.advance(31000); // next TOTP step: codes are single-use
        const step = await api('POST', '/api/auth/login', { body: { email, password: PW } });
        if (!step.body.mfa_required) throw new Error(`expected MFA challenge: ${JSON.stringify(step.body)}`);
        const code = C.totpAt(secret, C.totpStep(clock.now().getTime()));
        const done = await api('POST', '/api/auth/login/mfa', { body: { mfa_token: step.body.mfa_token, code } });
        if (done.status !== 200) throw new Error(`mfa login failed ${JSON.stringify(done.body)}`);
        who.token = done.body.token; return who.token;
      };
      await who.login();
      return who;
    },

    async superAdmin() { return env.internal('super_admin'); },

    // an approved, verified employer with a published job
    async employerWithPublishedJob({ jobOverrides = {}, admin, mode } = {}) {
      admin = admin || await env.internal('admin');
      const emp = await env.signup({ role: 'employer_owner', full_name: 'Owner One' });
      const org = emp && (await db.one('SELECT o.* FROM organizations o JOIN memberships m ON m.org_id=o.id WHERE m.user_id=$1', [emp.userId]));
      await api('POST', `/api/admin/users/${emp.userId}/approval`, { token: admin.token, body: { decision: 'approved' } });
      await api('POST', '/api/employer/company/verification', { token: emp.token, body: { registration_number: `REG-${crypto.randomBytes(3).toString('hex')}` } });
      await api('POST', `/api/admin/orgs/${org.id}/verification`, { token: admin.token, body: { decision: 'verified' } });
      if (mode) await db.query('UPDATE organizations SET recruitment_mode=$2 WHERE id=$1', [org.id, mode]);
      const job = await env.draftJob(emp, jobOverrides);
      const sub = await api('POST', `/api/employer/jobs/${job.id}/submit`, { token: emp.token });
      if (sub.status !== 200) throw new Error(`submit failed ${JSON.stringify(sub.body)}`);
      const rev = await api('POST', `/api/admin/jobs/${job.id}/review`, { token: admin.token, body: { decision: 'approve' } });
      if (rev.status !== 200) throw new Error(`approve failed ${JSON.stringify(rev.body)}`);
      return { admin, emp, org, job: rev.body };
    },
    async draftJob(emp, overrides = {}) {
      const r = await api('POST', '/api/employer/jobs', { token: emp.token, body: {
        title: 'Welder', profession: 'Welder', country: 'Germany', city: 'Hamburg', description: 'Weld steel structures.', requirements: '3 years experience',
        employment_type: 'full_time', vacancies: 2, salary_specified: true, salary_min: 2800, salary_max: 3400, salary_currency: 'EUR', salary_period: 'month', salary_basis: 'gross',
        accommodation: 'provided', languages: [{ code: 'en', level: 'B1' }], skills: ['mig welding'], ...overrides } });
      if (r.status !== 201) throw new Error(`draft failed ${JSON.stringify(r.body)}`);
      return r.body;
    },
    async readyCandidate(over = {}) {
      const c = await env.signup({ role: 'candidate', full_name: over.full_name || 'Amina Candidate', email: over.email });
      const p = await api('PATCH', '/api/candidate/profile', { token: c.token, body: { phone: over.phone || `+3556${crypto.randomInt(10000000, 99999999)}`, country: 'Albania', city: 'Tirana', profession: 'Welder', experience_years: 5, skills: ['mig welding'], languages: [{ code: 'en', level: 'B2' }], ...over.profile } });
      if (p.status !== 200) throw new Error(`profile failed ${JSON.stringify(p.body)}`);
      c.candidateId = (await db.one('SELECT id FROM candidates WHERE user_id=$1', [c.userId])).id;
      c.phone = p.body.phone;
      return c;
    },
  };
  return env;
}

// Real trust-crm (../trust-crm) on its own database, wrapped so tests can simulate outages.
async function startTrustCrm() {
  const name = `fw_trustcrm_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  const url = new URL(ADMIN_URL);
  Object.assign(process.env, { DB_HOST: url.hostname, DB_PORT: url.port, DB_USER: url.username, DB_PASSWORD: url.password || '', DB_NAME: name, JWT_SECRET: 'test-only-trustcrm-secret' });
  const fs = require('node:fs'); const path = require('node:path');
  const root = path.join(__dirname, '..', '..', 'trust-crm');
  const pg = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, `/${name}`) }); await pg.connect();
  await pg.query(fs.readFileSync(path.join(root, 'sql', 'schema.sql'), 'utf8'));
  const userModel = require(path.join(root, 'models', 'userModel'));
  await userModel.createUser({ full_name: 'FindWay Service', email: 'findway-service@example.test', password: 'Service-Pass-12345', role: 'SuperAdmin' });
  const trustApp = require(path.join(root, 'app'));
  const mode = { fail: null }; const calls = [];
  const wrapper = require('express')();
  wrapper.use((req, res, next) => {
    calls.push(`${req.method} ${req.path}`);
    if (mode.fail === '503') return res.status(503).json({ error: 'maintenance' });
    if (mode.fail === 'drop') return req.socket.destroy();
    return next();
  });
  wrapper.use(trustApp);
  const server = await new Promise((resolve) => { const s = http.createServer(wrapper); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const trustDb = require(path.join(root, 'db'));
  return {
    base, mode, calls, query: (q, p) => pg.query(q, p),
    async close() { server.close(); await pg.end(); await trustDb.end(); const a = new Client({ connectionString: ADMIN_URL }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end(); },
  };
}

module.exports = { createTestEnv, startTrustCrm, PW };
