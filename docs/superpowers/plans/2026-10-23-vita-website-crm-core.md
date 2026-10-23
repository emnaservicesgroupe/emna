# VITA Public Website + CRM Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the public VITA website (ar/en/fr), a public lead/offer API, and the CRM core (lead inbox, convert-to-candidate with portal login, notes/timeline, staff-published offers).

**Architecture:** Additive migration 011; new modules `modules/crm/*` and `modules/site/*`; new routes `routes/public.js`, `routes/crm.js`; static site in `public/site/` mounted like `/vita` (strict CSP); staff UI tabs added to `public/vita/admin.*`. Follows existing patterns (HttpError, `checkPermission`, `logAudit`, `createTestDb`, schema-isolated `node --test`).

**Tech Stack:** Node 22, Express 4, pg, node:test, plain HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-10-23-vita-website-crm-core-design.md`

## Global Constraints
- Additive only: no change to existing tables' required columns, existing routes' behavior, or the job-search module (except `middleware/role.js` permissions and `app.js` mounts).
- `GET /` keeps returning the existing JSON unless `Accept` includes `text/html`.
- Strict CSP identical to `/vita` (no inline script/style, no external origins). Public strings in ar/en/fr with an i18n parity test.
- Never render invented company facts: `SITE_PHONE`, `SITE_WHATSAPP`, `SITE_EMAIL`, `SITE_ADDRESS`, `SITE_LICENCE_TEXT` hidden when unset. No fake jobs/testimonials/statistics.
- Disclaimer on every page (ar/en/fr): "This service helps you search and apply for job opportunities. It does not guarantee employment, employer sponsorship, a work permit or a visa."
- Public endpoints: body cap 16 KB, honeypot field `website`, DB-backed rate limit, `ip_hash` = salted SHA-256 (salt `SITE_IP_SALT`, never raw IP stored).
- Public responses never include staff/internal fields (key-allowlist tested).
- Every staff mutation writes `audit_logs` via `logAudit`; timeline rows are insert-only.
- Commits end with the repo's Co-Authored-By/Claude-Session trailers. Full suite (`npm test` in `trust-crm`) must stay green.

## Review Focus
- Honeypot/spam submissions must answer `{ok:true}` yet never appear in the default lead list.
- Same email/phone submitting twice in 24 h must update one lead, not create two.
- Unicode/RTL names, 10 000-char messages, HTML/script text in any field: stored as text, rendered via `textContent`, capped.
- Converting a lead whose passport number already exists must 409 without partial writes (no orphan user/candidate).
- Agent with a lead not assigned to them must get 404 (not 403) to avoid enumeration; Accountant/HR/Candidate denied everywhere under `/crm`.
- Publishing a site job without `evidence_note` or with a past `closes_at` must be refused.

## File Structure
- Create `sql/migrations/011_crm_site.sql` — tables `crm_leads`, `crm_timeline`, `crm_employers`, `site_jobs`, `public_rate_limit`; `candidates.crm_stage`.
- Create `modules/site/publicConfig.js`, `modules/site/rateLimit.js`, `modules/site/leadService.js`, `modules/site/siteJobs.js` (public read side).
- Create `modules/crm/leadsAdmin.js`, `modules/crm/convert.js`, `modules/crm/timeline.js`, `modules/crm/siteJobsAdmin.js`.
- Create `routes/public.js`, `routes/crm.js`, `routes/siteStatic.js`.
- Create `public/site/*` (index.html, jobs.html, register.html, employers.html, contact.html, services.html, privacy.html, terms.html, site.css, site.js, i18n-site.js, robots.txt, sitemap.xml).
- Modify `middleware/role.js`, `app.js`, `public/vita/admin.html|js`, `public/vita/i18n.js`.
- Tests: `tests/crm-schema.test.js`, `tests/site-public.test.js`, `tests/crm-leads.test.js`, `tests/crm-convert.test.js`, `tests/crm-sitejobs.test.js`, `tests/site-ui.test.js`, `tests/crm-e2e.test.js`.
- Docs: `docs/vita-website-crm/CHECKLIST.md`, `SETUP.md`.

---

### Task 1: Migration 011 and permissions
**Files:** Create `sql/migrations/011_crm_site.sql`; Modify `middleware/role.js`; Test `tests/crm-schema.test.js`.
**Interfaces — Produces:** tables per spec §4; constraints: `crm_leads.kind IN ('candidate','employer','contact')`, `status IN ('new','contacted','qualified','converted','rejected','spam')`; `site_jobs.status IN ('draft','published','closed')`; `candidates.crm_stage` default `'lead'` with CHECK of the 7 stages; `public_rate_limit(key text, window_start timestamptz, count int, PRIMARY KEY(key, window_start))`; partial unique index `crm_leads(dedupe_key) WHERE status <> 'spam'` where `dedupe_key = kind || ':' || lower(email or phone) || ':' || date(created_at)`-style value computed by the service (column `dedupe_key text`). Permissions `leads:read`, `leads:write`, `sitejobs:write` added: Admin all three, Manager/Receptionist all three, Agent `leads:read`; Accountant/HR/Candidate none.
- [ ] Write failing tests: migration applies twice (idempotent via `runMigrations`), constraints reject bad `kind`/`status`/`crm_stage`, `PERMISSIONS` matrix matches the sentence above.
- [ ] Run `node --test tests/crm-schema.test.js` — FAIL.
- [ ] Implement the migration (`IF NOT EXISTS`, `DO $$` guards for constraints) and role entries.
- [ ] Run the new test plus `tests/role.test.js tests/migrate.test.js tests/verify-migrations.test.js` — PASS.
- [ ] Commit.

### Task 2: Public API (config, jobs, leads)
**Files:** Create `modules/site/{publicConfig,rateLimit,leadService,siteJobs}.js`, `routes/public.js`; Modify `app.js` (mount `/public` with its own `express.json({limit:"16kb"})` before the global parser); Test `tests/site-public.test.js`.
**Interfaces — Produces:** `getPublicConfig(env=process.env) -> {name, phone?, whatsapp?, email?, address?, licence?}` (only set keys); `rateLimit.hit(pool, key, {windowMs, max}) -> {allowed:boolean, retryAfter:number}`; `createLead(pool, input, {ip, userAgent}) -> {ok:true, spam:boolean}` (validation errors thrown as `HttpError(400, ...)`); `listPublishedJobs(pool, {country?, category?, limit<=50, offset}) -> row[]` and `getPublishedJob(pool, id)` returning only allowlisted keys `id,title,employer_name,country,city,category,description,requirements,language_requirements,employment_type,salary_text,apply_mode,published_at,closes_at`.
- [ ] Failing tests: valid candidate lead stored with consent timestamp; missing consent for candidate/employer ⇒ 400; honeypot filled ⇒ 200 `{ok:true}` and row `status='spam'`; invalid email/phone ⇒ 400; over-length ⇒ 400 or truncated at documented caps (name 120, message 4000); same email twice within 24 h ⇒ one row, `updated_at` bumped; 6th submit/hour from one IP ⇒ 429 with `Retry-After`; raw IP never stored; `/public/jobs` returns only published rows with exactly the allowlisted keys; `/public/config` omits unset facts; HTML in `name` stored verbatim as text.
- [ ] Run — FAIL.
- [ ] Implement modules and router; limits env-tunable (`SITE_LEAD_IP_PER_HOUR` default 5, `SITE_LEAD_EMAIL_PER_DAY` default 3).
- [ ] Run the test plus `tests/smoke.test.js` — PASS.
- [ ] Commit.

### Task 3: Staff lead API with scoping
**Files:** Create `modules/crm/{leadsAdmin,timeline}.js`, `routes/crm.js`; Modify `app.js` (mount `/crm`); Test `tests/crm-leads.test.js`.
**Interfaces — Consumes:** `logAudit`, `checkPermission`, `HttpError`. **Produces:** `listLeads(user, {status?, kind?, q?, assignedTo?, limit, offset}) -> {rows,total}` (spam excluded unless `status=spam`); `getLead(user, id)`; `updateLead(user, id, {status?, assigned_to?})` (`assigned_to` requires `users:write`); `addNote(user, id, text)`; `timeline.add(client, {entity, entityId, actorId, event, detail})`; `timeline.list(user, entity, id)`. Scope rule: Admin/SuperAdmin/Manager/Receptionist see all; Agent only `assigned_to = user.id` (others 404).
- [ ] Failing tests: role matrix on `GET /crm/leads` (Admin, Manager, Receptionist 200; Agent only own; Accountant, HR, Candidate 403; anonymous 401); Agent GET of someone else's lead ⇒ 404; status transition validation; note stored + timeline row + audit row; spam hidden by default; notes capped at 4000 chars.
- [ ] Run — FAIL. Implement. Run — PASS. Commit.

### Task 4: Convert lead to candidate, stage and timeline
**Files:** Create `modules/crm/convert.js`; Modify `routes/crm.js`; Test `tests/crm-convert.test.js`.
**Interfaces — Produces:** `convertLead(user, leadId, {passport_number, full_name?, nationality?, createPortalLogin:boolean}) -> {candidate, created:boolean, portal?:{userId, inviteSent:boolean}}`; `POST /crm/leads/:id/convert`; `PATCH /crm/candidates/:id/stage` (`{stage}`, scope via `assertCandidateAccess`), `GET /crm/candidates/:id/timeline`. One transaction: candidate insert (`assigned_to` = lead's assignee or acting staff), lead → `converted` with `candidate_id`, timeline + audit; portal login creates `users` (role Candidate, random unusable password hash, `is_active`) + `js_candidate_accounts`, then requests the existing OTP via `otp.requestOtp(email)` (sandbox mailer in tests) — requires lead email. Re-convert returns the same candidate (`created:false`). Duplicate passport ⇒ `HttpError(409)` with nothing written.
- [ ] Failing tests: happy path creates candidate + account and OTP mail appears in sandbox mailbox and `verifyOtp` logs the candidate in; second call idempotent; duplicate passport 409 leaves zero new users/candidates/lead changes; portal login without email ⇒ 400; Agent may convert only own lead; stage change writes timeline; invalid stage 400; Candidate role cannot call any `/crm` route.
- [ ] Run — FAIL. Implement. Run — PASS (also `tests/js-otp.test.js`). Commit.

### Task 5: Staff site-jobs API
**Files:** Create `modules/crm/siteJobsAdmin.js`; Modify `routes/crm.js`; Test `tests/crm-sitejobs.test.js`.
**Interfaces — Produces:** `createSiteJob(user, input)`, `updateSiteJob(user, id, patch)`, `publishSiteJob(user, id)`, `closeSiteJob(user, id)`, `listSiteJobs(user, {status?})`; routes `/crm/site-jobs[...]` guarded by `sitejobs:write`. Publish requires non-empty `evidence_note`, title, country, description, and `closes_at` null or in the future; sets `published_at`. Edits to a published job are allowed and audited; closing is final (re-publish requires a new row).
- [ ] Failing tests: publish without evidence 400; past `closes_at` 400; published job appears in `/public/jobs`, closed one disappears immediately; Agent/Accountant/HR 403; audit rows written; description HTML stored as text.
- [ ] Run — FAIL. Implement. Run — PASS. Commit.

### Task 6: Public website (static) and routing
**Files:** Create `public/site/*`, `routes/siteStatic.js`; Modify `app.js` (`GET /` content negotiation, mount `/site`, serve `/robots.txt` and `/sitemap.xml`); Test `tests/site-ui.test.js`.
**Interfaces — Consumes:** `/public/config`, `/public/jobs`, `/public/leads`. **Produces:** pages listed in spec §2; `site.js` renders config facts and jobs with `textContent`; forms POST to `/public/leads` with a hidden `website` honeypot and a required consent checkbox; language switcher persists to `localStorage` in try/catch; RTL for `ar`.
- [ ] Failing tests: `GET /` with `Accept: text/html` ⇒ HTML, without ⇒ existing JSON; every HTML file has the CSP-safe shape (no inline `<script>` body, no `style=`/`on*=` attributes, no external URLs); CSP header equals the `/vita` policy; i18n key parity ar/en/fr for `i18n-site.js`; disclaimer text present in all three languages; every `data-i18n` key used in HTML exists; `robots.txt` and `sitemap.xml` served; unset `SITE_*` ⇒ no phone/WhatsApp/address element text.
- [ ] Run — FAIL. Implement. Run — PASS. Commit.
- [ ] Visual check: start the server against the test DB, load `/` with the pre-installed Chromium via Playwright at 390 px and 1280 px in ar/en, confirm no horizontal scroll; keep screenshots out of git.

### Task 7: Staff UI tabs in the admin console
**Files:** Modify `public/vita/admin.html`, `admin.js`, `i18n.js`, `vita.css`; Test extend `tests/js-ui.test.js` (parity + CSP-safety checks already there must keep passing) and add DOM-free unit checks in `tests/crm-ui.test.js`.
**Interfaces — Consumes:** `/crm/leads`, `/crm/leads/:id`, `/crm/leads/:id/notes`, `/crm/leads/:id/convert`, `/crm/site-jobs*`, `/crm/candidates/:id/stage|timeline`. **Produces:** tabs "Leads", "Site jobs"; lead detail with notes, status, assign (admin only), convert dialog (passport number, portal login checkbox); candidate detail shows stage selector and timeline. All dynamic text via `textContent`; ar/en/fr keys added with parity.
- [ ] Failing test: new i18n keys exist in all three languages; admin.html has no inline handlers; every `data-i18n` key resolves.
- [ ] Run — FAIL. Implement. Run — PASS together with `tests/js-ui.test.js`. Commit.
- [ ] Browser smoke with Playwright against a seeded test server: log in as SuperAdmin, submit a public lead, see it in Leads, convert it, see the candidate; record result in the report.

### Task 8: End-to-end journey, docs and checklist
**Files:** Test `tests/crm-e2e.test.js`; Create `docs/vita-website-crm/CHECKLIST.md`, `SETUP.md`; Modify `deploy/hostinger/.env.production.example` (add `SITE_*`, `SITE_IP_SALT`, rate-limit vars) and `docs/vita-job-search/SETUP-HOSTINGER.md` (one paragraph: where the site lives and which variables are optional).
- [ ] Failing e2e (real HTTP, real Postgres schema, no network): visitor submits candidate lead ⇒ staff logs in ⇒ lists lead ⇒ converts with portal login ⇒ reads OTP from sandbox mailbox ⇒ candidate logs in and sees only their own job-search data (another candidate's id ⇒ 404); employer lead creates no candidate; staff publishes an offer ⇒ visible at `/public/jobs`, closed ⇒ gone; Agent isolation across two leads.
- [ ] Run — FAIL. Fix any gaps. Run the whole suite (`npm test`) — all PASS.
- [ ] Write CHECKLIST (each spec requirement completed / tested / blocked, honest about unconfigured mail provider, domain, site facts, and that nothing was run on a real server) and SETUP.
- [ ] Commit, push, update PR description.

## Self-Review (done)
Spec §2→T6, §3→T2, §4→T1, §5→T3/T4/T5, §6→T7, §7→T2/T6, §8→T1–T8, §10→T6/T8. Names used across tasks (`convertLead`, `createLead`, `timeline.add`, `crm_stage`, permissions) are consistent.
