'use strict';
// Drives the real UI in Chromium against an in-process FIND WAY server and a throwaway database.
//   node scripts/e2e-ui.js        (Postgres must be running; see tests/helpers.js for TEST_PG_ADMIN_URL)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createTestEnv } = require('../tests/helpers');
const C = require('../src/lib/crypto');

const OUT = path.join(__dirname, '..', 'e2e-artifacts');
const EXE = process.env.CHROMIUM_PATH || ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const results = []; const problems = [];
const ok = (name) => { results.push(['PASS', name]); console.log(`PASS  ${name}`); };
const bad = (name, err) => { results.push(['FAIL', name]); problems.push(`${name}: ${err && err.message ? err.message : err}`); console.log(`FAIL  ${name}\n      ${String(err && err.message ? err.message : err).split('\n')[0]}`); };
async function step(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

// ── helpers ──
function watch(page, label, sink) {
  // Chromium logs every non-2xx response as a console error. 4xx answers are the deliberate negative-path checks in this script
  // (wrong OTP, invalid phone, revoked session); only 5xx and genuine script errors count as problems.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) sink.push(`[${label}] console: ${m.text()}`); });
  page.on('pageerror', (e) => sink.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => { if (!/favicon/.test(r.url())) sink.push(`[${label}] requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
}
const CSP_HOOK = () => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); };
async function a11yCheck(page, label) {
  await page.waitForSelector('main h1', { state: 'visible', timeout: 6000 }).catch(() => {});
  const r = await page.evaluate(() => {
    const issues = [];
    const named = (el) => {
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
      return !!el.closest('label');
    };
    document.querySelectorAll('input:not([type=hidden]),select,textarea').forEach((el) => { if (el.offsetParent !== null && !named(el)) issues.push(`unlabelled ${el.tagName.toLowerCase()}#${el.id || el.name}`); });
    document.querySelectorAll('img').forEach((img) => { if (!img.hasAttribute('alt')) issues.push(`img without alt ${img.src.split('/').pop()}`); });
    const h1 = [...document.querySelectorAll('main h1')].filter((e) => e.offsetParent !== null);
    if (h1.length !== 1) issues.push(`${h1.length} visible h1 elements`);
    if (!document.querySelector('main#main')) issues.push('no main landmark');
    document.querySelectorAll('button').forEach((b) => { if (b.offsetParent !== null && !b.textContent.trim() && !b.getAttribute('aria-label')) issues.push('button without name'); });
    return issues;
  });
  if (r.length) throw new Error(`a11y [${label}]: ${r.join('; ')}`);
}
const noOverflow = (page, label) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })).then(({ sw, iw }) => { if (sw > iw) throw new Error(`horizontal overflow on ${label}: scrollWidth ${sw} > ${iw}`); });
const shot = (page, name, full = false) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
const ready = async (page, hash) => { await page.goto(`${hash.startsWith('http') ? '' : ''}${hash}`); await page.waitForSelector('main h1', { timeout: 15000 }); await page.waitForTimeout(150); };

(async () => {
  if (!EXE) throw new Error('No Chromium executable found (set CHROMIUM_PATH)');
  const env = await createTestEnv();
  const consoleProblems = []; const cspViolations = [];
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const _nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await _nc(o); c.setDefaultTimeout(7000); return c; };
  try {
    // ── seed with synthetic data through the API ──
    const admin = await env.internal('admin'); const staff = await env.internal('staff');
    const { emp, org } = await env.employerWithPublishedJob({ admin, jobOverrides: { title: 'Welder', city: 'Hamburg', country: 'Germany', description: 'Weld steel structures in a modern shipyard.\nTraining provided.', responsibilities: 'MIG/MAG welding of hull sections.', requirements: '3 years of welding experience.\nBasic English.' } });
    await env.api('PATCH', '/api/employer/company', { token: emp.token, body: { public_profile: true, description: 'Synthetic shipyard used for demonstration.' } });
    await env.draftJob(emp, { title: 'فني لحام معتمد', profession: 'Welder', country: 'Germany', city: 'Bremen', description: 'مطلوب فني لحام للعمل في ورشة بناء السفن.', requirements: 'خبرة لا تقل عن ثلاث سنوات.' })
      .then(async (j) => { await env.api('POST', `/api/employer/jobs/${j.id}/submit`, { token: emp.token }); await env.api('POST', `/api/admin/jobs/${j.id}/review`, { token: admin.token, body: { decision: 'approve' } }); });
    // things that must show up in admin queues
    const pendingEmp = await env.signup({ role: 'employer_owner', full_name: 'Pending Owner', org: { name: 'Waiting Logistics Ltd', country: 'Albania' } });
    const pendingJob = await env.draftJob(emp, { title: 'Crane Operator', profession: 'Crane operator' });
    await env.api('POST', `/api/employer/jobs/${pendingJob.id}/submit`, { token: emp.token });
    const base = env.base;

    const open = async (ctx, hash) => { const page = ctx.pages()[0]; await ready(page, `${base}/#${hash}`); return page; };
    const mfaLogin = async (page, who) => {
      await ready(page, `${base}/#/login`);
      await page.getByLabel('Email', { exact: true }).fill(who.email); await page.getByLabel('Password', { exact: true }).fill(who.password);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.getByLabel('Authentication code').waitFor();
      env.clock.advance(31000); // server clock is virtual: next TOTP step
      await page.getByLabel('Authentication code').fill(C.totpAt(who.secret, C.totpStep(env.clock.now().getTime())));
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.waitForURL(/#\/crm/); await page.waitForSelector('main h1');
    };

    // ───────────── (a) English desktop candidate journey ─────────────
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
    await ctxA.addInitScript(CSP_HOOK); const pA = await ctxA.newPage(); watch(pA, 'A-en-desktop', consoleProblems);
    const email = 'sara.candidate@example.test'; const password = 'Strong-Passw0rd-123';
    await step('a1 home page renders with live jobs, no fabricated stats', async () => {
      await ready(pA, `${base}/#/`);
      const txt = await pA.locator('main').innerText();
      if (!/Welder/.test(txt)) throw new Error('latest jobs list missing seeded job');
      if (/\b\d{2,}[,.]?\d*\s*(\+|%|k)?\s*(jobs|companies|candidates|placements)/i.test(txt) && !/found/.test(txt)) throw new Error('numeric claim on home page');
      if (/testimonial|trusted by/i.test(txt)) throw new Error('fabricated social proof');
      await a11yCheck(pA, 'home'); await shot(pA, 'en-desktop-home', true);
    });
    await step('a2 register candidate -> email OTP from dev mail -> verify -> login', async () => {
      await ready(pA, `${base}/#/register`);
      await pA.getByLabel('Full name').fill('Sara Candidate'); await pA.getByLabel('Email', { exact: true }).fill(email); await pA.getByLabel('Password', { exact: true }).fill(password);
      await pA.getByRole('button', { name: 'Register' }).click(); // terms unchecked: must be blocked client-side
      await pA.getByText('This field is required').first().waitFor();
      await a11yCheck(pA, 'register');
      await pA.getByLabel('I accept the terms of use and privacy policy').check();
      await pA.getByRole('button', { name: 'Register' }).click();
      await pA.waitForURL(/#\/verify/);
      const mail = await (await fetch(`${base}/api/dev/mail`)).json();
      const code = mail.messages.filter((m) => m.to === email).at(-1).text.match(/\b(\d{6})\b/)[1];
      await pA.getByLabel('6-digit code').fill('000000'); await pA.getByRole('button', { name: 'Verify' }).click();
      await pA.getByText(/incorrect|no longer valid/i).first().waitFor(); // wrong code shows a translated error
      await pA.getByLabel('6-digit code').fill(code); await pA.getByRole('button', { name: 'Verify' }).click();
      await pA.waitForURL(/#\/login/); await pA.getByText('Email verified').waitFor();
      await pA.getByLabel('Password', { exact: true }).fill(password); await pA.getByRole('button', { name: 'Log in' }).click();
      await pA.waitForURL(/#\/candidate$/); await pA.getByRole('heading', { name: /Welcome, Sara Candidate/ }).waitFor();
    });
    await step('a3 pre-profile: cannot apply yet, profile page lists what is missing', async () => {
      await ready(pA, `${base}/#/jobs/${(await env.db.one(`SELECT reference_no FROM jobs WHERE title='Welder'`)).reference_no}`);
      await pA.getByText('Complete the required profile fields before applying.').waitFor();
    });
    await step('a4 complete profile (phone format validated) and save', async () => {
      await ready(pA, `${base}/#/candidate/profile`);
      await pA.getByLabel('Phone', { exact: false }).first().fill('0691234567');
      await pA.getByLabel('Country', { exact: true }).fill('Albania'); await pA.getByLabel('Profession', { exact: true }).fill('Welder');
      await pA.getByLabel('Years of experience').fill('5');
      await pA.getByRole('button', { name: 'Save' }).first().click();
      await pA.getByText(/international format/i).first().waitFor(); // server validation shown in the form
      await pA.getByLabel('Phone').first().fill('+355 69 123 4567');
      await pA.getByLabel('Skills').fill('mig welding'); await pA.keyboard.press('Enter');
      await pA.getByRole('button', { name: 'Save' }).first().click();
      await pA.locator('#toasts').getByText('Saved').waitFor();
      await a11yCheck(pA, 'candidate profile');
    });
    await step('a5 search jobs with URL-synced filters, open details, apply', async () => {
      await ready(pA, `${base}/#/jobs`);
      await pA.getByLabel('Keyword', { exact: true }).fill('weld'); await pA.getByLabel('Country', { exact: true }).fill('Germany');
      await pA.getByLabel('Minimum').fill('2500'); await pA.getByLabel('Currency').fill('eur'); await pA.getByLabel('Pay period').selectOption('month');
      await pA.getByRole('button', { name: 'Apply filters' }).click();
      await pA.waitForURL(/#\/jobs\?.*salary_currency=EUR/); await pA.getByText(/jobs found/).waitFor();
      const link = pA.getByRole('link', { name: 'Welder', exact: true }).first(); await link.waitFor(); await a11yCheck(pA, 'jobs');
      await link.click(); await pA.getByRole('heading', { name: 'Welder', level: 1 }).waitFor();
      const body = await pA.locator('main').innerText();
      for (const must of ['FW-J-', 'Hamburg', 'Germany', 'Verified employer', 'Not specified']) if (!body.includes(must)) throw new Error(`job detail lacks "${must}"`);
      if (!/€2,800.*€3,400/.test(body.replace(/\s/g, ' ').replace(/ /g, ' '))) throw new Error('salary range not formatted with its own currency');
      await a11yCheck(pA, 'job detail'); await shot(pA, 'en-desktop-job-detail', true);
      await pA.getByRole('button', { name: 'Apply for this job' }).click();
      await pA.getByRole('dialog').getByRole('button', { name: 'Apply for this job' }).click();
      await pA.waitForURL(/#\/candidate\/applications\//); await pA.getByRole('heading', { level: 1, name: 'Welder' }).waitFor();
      await pA.getByText('Submitted').first().waitFor();
    });
    await step('a6 applying twice is blocked with a clear message', async () => {
      const ref = (await env.db.one(`SELECT reference_no FROM jobs WHERE title='Welder'`)).reference_no;
      await ready(pA, `${base}/#/jobs/${ref}`);
      await pA.getByRole('button', { name: 'Apply for this job' }).click();
      await pA.getByRole('dialog').getByRole('button', { name: 'Apply for this job' }).click();
      await pA.waitForURL(/#\/candidate\/applications\//); // redirected to the existing application, no second one created
      const n = await env.db.one(`SELECT count(*)::int AS n FROM applications`); if (n.n !== 1) throw new Error(`expected 1 application, got ${n.n}`);
    });
    await step('a7 session expiry: revoked token sends the user to login with a notice', async () => {
      await env.db.query(`UPDATE sessions SET revoked_at=now()`);
      await pA.reload(); await pA.goto(`${base}/#/candidate/applications`); await pA.waitForURL(/#\/login/); await pA.getByText('Your session expired').first().waitFor();
    });

    // ───────────── (b) staff: MFA login -> lead -> qualify ─────────────
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
    await ctxB.addInitScript(CSP_HOOK); const pB = await ctxB.newPage(); watch(pB, 'B-staff', consoleProblems);
    await step('b1 staff logs in with TOTP (two-step) and lands in the CRM shell', async () => { await mfaLogin(pB, staff); await pB.getByText('FIND WAY CRM').first().waitFor(); await a11yCheck(pB, 'crm overview'); });
    await step('b2 lead queue shows the application; open it; qualify without duplicating the person', async () => {
      await ready(pB, `${base}/#/crm/leads`);
      await pB.getByRole('link', { name: /FW-L-/ }).first().waitFor(); await a11yCheck(pB, 'crm leads'); await shot(pB, 'crm-leads', true);
      await pB.getByRole('link', { name: /FW-L-/ }).first().click(); await pB.getByRole('heading', { level: 1, name: /Lead FW-L-/ }).waitFor();
      await pB.getByText('Sara Candidate').first().waitFor();
      await pB.getByRole('button', { name: 'Qualify lead' }).click();
      await pB.locator('#toasts').getByText('Lead qualified').waitFor();
      const people = await env.db.one(`SELECT count(*)::int AS n FROM candidates WHERE email_norm=$1`, [email]); if (people.n !== 1) throw new Error('duplicate person created');
      const st = await env.db.one(`SELECT status FROM leads`); if (st.status !== 'qualified') throw new Error(`lead is ${st.status}`);
    });
    await step('b3 staff without permission sees an explanation, not data (direct navigation to admin area)', async () => {
      await ready(pB, `${base}/#/crm/approvals`); await pB.getByText(/does not have access|cannot open this page/i).first().waitFor();
    });

    // ───────────── (c) admin: queues, job review, integrations honesty ─────────────
    const ctxC = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
    await ctxC.addInitScript(CSP_HOOK); const pC = await ctxC.newPage(); watch(pC, 'C-admin', consoleProblems);
    await step('c1 admin sees the approval queue and approves an account', async () => {
      await mfaLogin(pC, admin); await ready(pC, `${base}/#/crm/approvals`);
      await pC.getByText('Pending Owner').first().waitFor(); await a11yCheck(pC, 'approvals');
      await pC.getByRole('row', { name: /Pending Owner/ }).getByRole('button', { name: 'Approve' }).click();
      await pC.locator('#toasts').getByText('Saved').waitFor();
      const u = await env.db.one(`SELECT approval_status FROM users WHERE id=$1`, [pendingEmp.userId]); if (u.approval_status !== 'approved') throw new Error('not approved');
    });
    await step('c2 job review shows the job; approving needs a verified employer; publishing makes it public', async () => {
      await ready(pC, `${base}/#/crm/job-reviews`); await pC.getByRole('link', { name: 'Crane Operator' }).click();
      await pC.getByRole('heading', { level: 1, name: 'Crane Operator' }).waitFor(); await a11yCheck(pC, 'job review');
      await pC.getByRole('button', { name: 'Submit decision' }).click();
      await pC.waitForURL(/#\/crm\/job-reviews$/);
      const j = await env.db.one(`SELECT status FROM jobs WHERE id=$1`, [pendingJob.id]); if (j.status !== 'published') throw new Error(`job is ${j.status}`);
    });
    await step('c3 integrations page never claims "Connected" without a real test', async () => {
      await ready(pC, `${base}/#/crm/integrations`);
      await pC.getByText('Not configured').first().waitFor();
      const t = await pC.locator('main').innerText();
      if (/✓\s*Connected/.test(t)) throw new Error('claims connected');
      if (!/awaiting credentials|Missing/i.test(t)) throw new Error('does not say credentials are missing');
      await pC.getByRole('button', { name: 'Test connection' }).click();
      await pC.locator('#toasts').getByText(/failed/i).waitFor(); // the test genuinely fails without config
      await pC.waitForTimeout(300); const after = await pC.locator('main').innerText(); if (/✓\s*Connected/.test(after)) throw new Error('claims connected after failed test');
      await a11yCheck(pC, 'integrations'); await shot(pC, 'crm-integrations', true);
    });
    await step('c4 audit log lists the actions just performed', async () => {
      await ready(pC, `${base}/#/crm/audit`); await pC.getByText('user.approval_approved').first().waitFor(); await pC.getByText('job.approved').first().waitFor();
    });

    // ───────────── (d) Arabic, mobile 390x844, RTL ─────────────
    const cand = await env.readyCandidate({ full_name: 'سارة المرشحة' });
    const ctxD = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'ar' });
    await ctxD.addInitScript(CSP_HOOK); await ctxD.addInitScript(() => { try { localStorage.setItem('fw_lang', 'ar'); } catch (_) { /* */ } });
    const pD = await ctxD.newPage(); watch(pD, 'D-ar-mobile', consoleProblems);
    const rtl = async (label) => { const d = await pD.evaluate(() => [document.documentElement.dir, document.documentElement.lang]); if (d[0] !== 'rtl' || d[1] !== 'ar') throw new Error(`${label}: dir/lang = ${d}`); await noOverflow(pD, label); await a11yCheck(pD, `ar ${label}`); };
    const ref = (await env.db.one(`SELECT reference_no FROM jobs WHERE title='Welder'`)).reference_no;
    await step('d1 AR mobile: home, jobs, job detail, login, register are RTL with no horizontal overflow', async () => {
      await ready(pD, `${base}/#/`); await rtl('home'); await shot(pD, 'ar-mobile-home', true);
      await ready(pD, `${base}/#/jobs`); await pD.getByText('فني لحام معتمد').first().waitFor(); await rtl('jobs'); await shot(pD, 'ar-mobile-jobs', true);
      const arTitle = pD.getByText('فني لحام معتمد').first(); const dir = await arTitle.evaluate((e) => e.closest('[dir]')?.getAttribute('dir') || e.getAttribute('dir')); if (dir !== 'auto') throw new Error('user-entered title lacks dir=auto');
      await ready(pD, `${base}/#/jobs/${ref}`); await rtl('job detail'); await shot(pD, 'ar-mobile-job-detail', true);
      await ready(pD, `${base}/#/login`); await rtl('login'); await ready(pD, `${base}/#/register`); await rtl('register'); await shot(pD, 'ar-mobile-register', true);
      const sample = await pD.locator('main').innerText(); if (!/[؀-ۿ]/.test(sample)) throw new Error('page is not Arabic');
    });
    await step('d2 AR mobile: logged-in candidate pages (profile, applications) stay RTL and usable', async () => {
      await ready(pD, `${base}/#/login`);
      await pD.getByLabel('البريد الإلكتروني').fill(cand.email); await pD.getByLabel('كلمة المرور').fill(cand.password); await pD.getByRole('button', { name: 'تسجيل الدخول' }).last().click();
      await pD.waitForURL(/#\/candidate$/); await rtl('candidate overview');
      await ready(pD, `${base}/#/candidate/profile`); await rtl('profile'); await shot(pD, 'ar-mobile-profile', true);
      await ready(pD, `${base}/#/jobs/${ref}`); await pD.getByRole('button', { name: 'قدّم على هذه الوظيفة' }).click();
      await pD.getByRole('dialog').getByRole('button', { name: 'قدّم على هذه الوظيفة' }).click(); await pD.waitForURL(/#\/candidate\/applications\//); await rtl('application detail'); await shot(pD, 'ar-mobile-application', true);
      await ready(pD, `${base}/#/candidate/applications`); await rtl('applications');
    });
    await step('d3 mobile menu opens by keyboard and exposes navigation (AR)', async () => {
      await ready(pD, `${base}/#/`); const btn = pD.getByRole('button', { name: 'القائمة' }); await btn.focus(); await pD.keyboard.press('Enter');
      if ((await btn.getAttribute('aria-expanded')) !== 'true') throw new Error('menu did not expand'); await pD.getByRole('link', { name: 'الوظائف' }).first().waitFor();
    });
    await step('d4 language switcher changes language and direction live', async () => {
      const pE = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage(); watch(pE, 'E-lang', consoleProblems);
      await ready(pE, `${base}/#/`); for (const [code, dir] of [['ar', 'rtl'], ['sq', 'ltr'], ['fr', 'ltr'], ['en', 'ltr']]) {
        await pE.locator('#lang-select').selectOption(code); await pE.waitForFunction((c) => document.documentElement.lang === c, code);
        const d = await pE.evaluate(() => document.documentElement.dir); if (d !== dir) throw new Error(`${code}: dir ${d}`); await a11yCheck(pE, `home ${code}`); await noOverflow(pE, `home ${code}`);
      }
      await pE.close();
    });
    await step('d5 service worker registers and the manifest is served', async () => {
      const p = await (await browser.newContext()).newPage(); await ready(p, `${base}/#/`);
      await p.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => !!r), null, { timeout: 8000 });
      const m = await (await fetch(`${base}/manifest.webmanifest`)).json(); if (m.display !== 'standalone') throw new Error('manifest');
      const swRes = await fetch(`${base}/sw.js`); if (!swRes.ok) throw new Error('sw.js not served'); await p.close();
    });

    // ───────────── (e) global assertions ─────────────
    for (const ctx of [ctxA, ctxB, ctxC, ctxD]) for (const page of ctx.pages()) { const v = await page.evaluate(() => window.__csp || []).catch(() => []); cspViolations.push(...v); }
    await step('e1 zero console errors / page errors / failed requests across the whole run', async () => { if (consoleProblems.length) throw new Error(consoleProblems.slice(0, 5).join(' | ')); });
    await step('e2 zero Content-Security-Policy violations', async () => { if (cspViolations.length) throw new Error(cspViolations.slice(0, 5).join(' | ')); });
  } finally { await browser.close(); await env.close(); }
  const fails = results.filter(([s]) => s === 'FAIL').length;
  console.log(`\n${results.length - fails}/${results.length} steps passed`); if (problems.length) console.log(problems.join('\n'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
