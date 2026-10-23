# VITA public website + CRM core — requirement checklist

This page says, for each requirement of the design (`docs/superpowers/specs/2026-10-23-vita-website-crm-core-design.md`, sections 1 to 10), what is built, what is tested and what is waiting for the owner. Evidence entries are real files and test titles in `trust-crm/` (titles are shortened with "..." where long).

**Status key**

| Mark | Meaning |
|---|---|
| Done + tested | Built and covered by automated tests (the test file is named) |
| Done, partly tested | Built; the untested part is named in the notes |
| Blocked (owner) | Code exists but needs something only the owner can provide |
| Not built | Deliberately left out or deferred; said plainly |

**Read this first (honest status)**

- Everything was tested only by automated tests on a development machine: real HTTP server, real Postgres (a throw-away schema per test file), sandbox mail, no network. **Nothing has been run on a real server, behind a real domain, with real HTTPS, or with a real mail provider.**
- **The optional notification e-mail to staff for a new lead (spec section 3) was NOT built.** It was deferred: no mail provider is connected. Staff see new leads in the Leads tab; nobody is told by e-mail.
- The company facts (`SITE_*`), the domain and the licence wording are **owner inputs**. Until they are set, the website shows none of them.
- The privacy and terms pages use generic wording and **need a legal review** before real visitors use the site.
- Test counts for this work are in the final report of the task; run `npm test` in `trust-crm/` to reproduce them.

Related: [SETUP.md](SETUP.md) · [../vita-job-search/CHECKLIST.md](../vita-job-search/CHECKLIST.md) · [../vita-job-search/SETUP-HOSTINGER.md](../vita-job-search/SETUP-HOSTINGER.md)

---

## Section 1. Goal and success criteria

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| A visitor can submit a candidate registration, an employer inquiry or a contact message; each becomes a lead | Done + tested | `tests/crm-e2e.test.js` (A, B); `tests/site-public.test.js` "valid candidate lead stored with consent..."; `tests/site-ui.test.js` "http: the lead form payload the site sends is accepted by /public/leads..." | |
| Staff review leads, convert a candidate lead (with optional portal login), keep notes and a timeline, manage published offers | Done + tested | `tests/crm-e2e.test.js` (A, D); `tests/crm-leads.test.js`; `tests/crm-convert.test.js`; `tests/crm-sitejobs.test.js` | |
| Whole path public form -> lead -> convert -> candidate account -> OTP login | Done + tested | `tests/crm-e2e.test.js` "A: candidate lead -> staff list -> convert with portal login -> OTP from sandbox mailbox -> candidate sees only own data" | The OTP is read from the sandbox mailbox. A real candidate cannot receive a code until real mail is configured (see Blocked items below). |
| Isolation rules hold | Done + tested | `tests/crm-e2e.test.js` (A, E, F); `tests/crm-leads.test.js`; `tests/crm-convert.test.js` | |
| No placeholder content presented as real (no fake jobs, testimonials, statistics, licence numbers) | Done + tested | `tests/site-ui.test.js` "site.js factsFrom: renders only facts that are set...", "markup: config fact containers are hidden and empty...", "i18n: honest wording, no promises..."; `tests/crm-e2e.test.js` D (empty public job list before staff publish) | Pages were read by the developers, not by a lawyer or a native-speaker reviewer. |
| No promise of employment, sponsorship, work permit or visa; standard disclaimer on every page in ar/en/fr | Done + tested | `tests/site-ui.test.js` "i18n: the required disclaimer is exact in ar/en/fr and on every page..." | The disclaimer wording needs the owner's approval. |
| Public input is untrusted; endpoints rate limited and honeypot protected; personal data minimised; consent recorded | Done + tested | `tests/site-public.test.js` (validation, honeypot, limits, hashes only); `tests/crm-e2e.test.js` (B, C, G) | |
| This checklist exists and is honest | Done | This file | |

## Section 2. Public website

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| `GET /` returns the site HTML for `text/html`, otherwise the existing JSON status | Done + tested | `tests/site-ui.test.js` "http: GET / negotiates - html for browsers, the existing JSON otherwise" | In the Hostinger kit, Caddy used to redirect `/` to `/vita/`. That redirect was removed in this task so the site is reachable (kit tests updated). Not run on a real stack. |
| Plain HTML/CSS/JS, no build step, same strict CSP as `/vita`, self-hosted logo, mobile first | Done + tested | `tests/site-ui.test.js` "site: all ten pages plus css, js, i18n and the logo exist", "static scan: no inline scripts...", "http: /site assets carry exactly the /vita CSP and security headers..." | Mobile layout was not checked on real devices or in a browser by an automated test. |
| Arabic (RTL), English, French with a parity test | Done + tested | `tests/site-ui.test.js` "i18n: ar/en/fr have identical key sets...", "i18n: every data-i18n* key used in html..." | Translations were not reviewed by native speakers. |
| Pages: Home, Services, Destinations (Canada first), How it works, Jobs, For employers, Register, Contact, Privacy, Terms; links to candidate portal and staff login | Done + tested | `tests/site-ui.test.js` "site: all ten pages...", "markup: every page links the candidate portal and staff console..." | Privacy and terms wording is generic: legal review needed. |
| Accessibility basics (lang/dir, skip link, one h1, labelled inputs) | Done + tested | `tests/site-ui.test.js` "accessibility scan..." | A scan of the markup, not a full audit with assistive technology. |
| Company facts from `SITE_*`; an absent value is not rendered | Done + tested | `tests/site-public.test.js` "/public/config omits unset facts and defaults the name to VITA"; `tests/site-ui.test.js` "http: with SITE_* unset /public/config exposes no contact facts and the pages carry none" | Blocked (owner): the real values are not known. |
| Jobs page lists only published offers; honest empty state | Done + tested | `tests/crm-e2e.test.js` D; `tests/site-ui.test.js` "markup: every page links...; jobs page has an honest empty state hook" | |

## Section 3. Public API

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| `GET /public/config` returns only the facts that are set | Done + tested | `tests/site-public.test.js` "/public/config omits unset facts..." | |
| `GET /public/jobs`, `/public/jobs/:id`: published, not expired, allowlisted keys only; closed or draft gone | Done + tested | `tests/crm-e2e.test.js` D (exact key list, evidence note never leaks); `tests/site-public.test.js` "/public/jobs returns only live published rows with exactly the allowlisted keys"; `tests/crm-sitejobs.test.js` | |
| `POST /public/leads`: validation, length caps, email/phone shape, consent required for candidate/employer | Done + tested | `tests/site-public.test.js` (validation, caps, consent); `tests/crm-e2e.test.js` B | |
| Honeypot: answers ok, stored as spam, not shown by default | Done + tested | `tests/crm-e2e.test.js` C; `tests/site-public.test.js` honeypot tests | |
| Per-IP and per-email rate limit, DB backed; hard limit answers 429 | Done + tested | `tests/crm-e2e.test.js` G (limits injected through env, Retry-After); `tests/site-public.test.js` limit tests | "Survives restart" holds because the counters are in Postgres; no test restarts a real process. |
| Duplicate within 24 h by email/phone updates the same lead | Done + tested | `tests/crm-e2e.test.js` G; `tests/site-public.test.js` "same email twice within 24h updates one row...", "concurrent duplicate submissions still produce one row" | |
| Responds `{ok:true}` regardless of duplicate | Done + tested | `tests/crm-e2e.test.js` C, G | |
| Optional notification e-mail to staff via the mail adapter | **Not built (deferred)** | none | No mail provider is connected, so it was left out. Staff must open the Leads tab. Building it later needs a real provider (see `../vita-job-search/SETUP.md`, section "Real e-mail"). |

## Section 4. Data model (migration 011)

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| `crm_leads` with kind/status constraints and a 24 h dedupe key (not applied to spam) | Done + tested | `tests/crm-schema.test.js` "crm_leads kind/status constraints", "crm_leads dedupe_key is unique except for spam rows" | |
| Notes and timeline are insert-only | Done + tested | `tests/crm-schema.test.js` "crm_timeline is insert-only" | |
| `crm_employers`, `site_jobs` with evidence note | Done + tested | `tests/crm-schema.test.js` "crm_employers and site_jobs constraints and defaults" | `crm_employers` exists for stage 3; no screen or API uses it yet. |
| `candidates.crm_stage` (lead, documents, submitted, interview, visa, travel, closed) with history in the timeline | Done + tested | `tests/crm-schema.test.js` "candidates.crm_stage defaults to lead and is constrained"; `tests/crm-convert.test.js` "stage change writes timeline + audit..." | Known limit: the stage shown is **inferred from the latest stage-change event in the timeline** (fallback: the stored column), see `tests/crm-ui.test.js` "currentStage reads the latest stage_changed event...". |
| Migration additive and idempotent | Done + tested | `tests/crm-schema.test.js` "migration 011 is idempotent..." | Run on a throw-away test schema, not on a copy of production data. |
| IP stored only as a salted hash | Done + tested | `tests/site-public.test.js` "valid candidate lead stored with consent, hashed ip..."; `tests/crm-e2e.test.js` A, G | Production needs `SITE_IP_SALT` (setup.sh generates it). |
| `site_jobs.evidence_note` up to 1000 characters (other short fields 160) | Done + tested | `tests/crm-sitejobs.test.js` "evidence_note allows up to 1000 characters..."; `tests/crm-ui.test.js` "siteJobPayload..." | Raised from 160 in this task. |

## Section 5. Staff API and permissions

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| New permissions `leads:read`, `leads:write`, `sitejobs:write`; Admin/SuperAdmin all; Manager and Receptionist both; Agent `leads:read` on assigned leads only; Accountant/HR none | Done + tested | `tests/crm-schema.test.js` "CRM permission matrix"; `tests/crm-leads.test.js` "role matrix on GET /crm/leads"; `tests/crm-e2e.test.js` E, F | |
| Leads list/detail/patch/notes; assignment admin-only; spam hidden by default | Done + tested | `tests/crm-leads.test.js`; `tests/crm-e2e.test.js` A, C, E | |
| Agents cannot convert or write leads | Done + tested | `tests/crm-e2e.test.js` E; `tests/crm-convert.test.js` "permissions: Agent only on own leads..." | By design: Agents have `leads:read` only. A foreign lead is 404 (not 403) for every Agent action. |
| Convert: transactional; passport required; conflict 409; lead `converted`; timeline and audit; optional portal login with OTP invite; idempotent | Done + tested | `tests/crm-e2e.test.js` A; `tests/crm-convert.test.js` (happy path, duplicate passport, idempotent, conflicts, mail failure) | If the invite mail cannot be sent, the conversion stays and `inviteSent=false` is reported. |
| Only candidate leads can be converted (employer/contact and spam cannot) | Done + tested | `tests/crm-e2e.test.js` B, C | |
| Site jobs: create/edit/publish/close; publish needs an evidence note | Done + tested | `tests/crm-e2e.test.js` D; `tests/crm-sitejobs.test.js` | |
| Candidate timeline and stage endpoints | Done + tested | `tests/crm-e2e.test.js` A; `tests/crm-convert.test.js` | Known limit: **candidate scope is stricter than lead scope** (the existing candidate scope rules apply to candidates), so a staff member can see a lead and still get 404 on the candidate it was converted to. |
| Existing auth and permission middleware; every mutation audited | Done + tested | `tests/crm-e2e.test.js` D (audit rows); `tests/crm-leads.test.js`, `tests/crm-convert.test.js`, `tests/crm-sitejobs.test.js` | |
| Candidate sees only own job-search data after conversion | Done + tested | `tests/crm-e2e.test.js` A (own profile 200, another candidate's 404, `/crm` 403) | |
| Existing job-search journey endpoints still work for a converted candidate | Done, partly tested | `tests/crm-e2e.test.js` A (CV upload, profile, applications list, auth/me) | The full job-search journey keeps its own suite (`tests/js-e2e.test.js`); this test touches only a few endpoints. |

## Section 6. Staff UI (`/vita/admin.html`)

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Leads inbox (filters, assign, status, notes, convert dialog) | Done, partly tested | `tests/crm-ui.test.js` (markup, i18n, helpers, API client); server side fully tested | **Not exercised in a real browser.** Only scripts, markup, helpers and server responses are tested; the screens were never clicked through by a test. |
| Site jobs (create/edit/publish/close) | Done, partly tested | `tests/crm-ui.test.js` "siteJobPayload...", "publishBlockers mirrors the server rules..." | Same limit. |
| Candidate pipeline stage and timeline | Done, partly tested | `tests/crm-ui.test.js` "currentStage...", "describeEvent..." | Same limit. |
| ar/en/fr parity, CSP-safe, textContent only | Done + tested | `tests/crm-ui.test.js` i18n tests and "static scan: CRM scripts render untrusted text only via textContent helpers..." | |

## Section 7. Security

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Bearer tokens (no CSRF surface), strict CSP | Done + tested | `tests/site-ui.test.js` "http: /site assets carry exactly the /vita CSP..." | |
| Honeypot, DB rate limit, 16 KB body cap on public endpoints | Done + tested | `tests/site-public.test.js` "oversized or malformed JSON bodies get a clean 4xx...", limit tests; `tests/crm-e2e.test.js` C, G | |
| Escaping through textContent only | Done + tested | `tests/site-ui.test.js` "static scan: no external origins in css/js and no HTML-injection or eval sinks in js"; `tests/crm-ui.test.js` static scan | |
| No staff data on any `/public` response (key allowlist) | Done + tested | `tests/crm-e2e.test.js` D; `tests/site-public.test.js` | |
| Spam stored for audit, not shown by default | Done + tested | `tests/crm-e2e.test.js` C | Spam rows are never purged automatically. |
| Real client IP behind Caddy | Done, partly tested | `TRUST_PROXY=1` in the kit; `tests/trust-proxy.test.js` | Not run behind real Caddy. Per-IP limits are only as good as the proxy setup. |

## Section 8. Testing

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Real Postgres, schema isolated per file; public validation/limit/honeypot/dedupe; consent; published-only exposure; role matrix for every new route; convert paths; migration idempotency; i18n parity; CSP check | Done + tested | `tests/site-public.test.js`, `tests/site-ui.test.js`, `tests/crm-schema.test.js`, `tests/crm-leads.test.js`, `tests/crm-convert.test.js`, `tests/crm-sitejobs.test.js`, `tests/crm-ui.test.js` | |
| End-to-end journey (form -> lead -> convert -> candidate login) | Done + tested | `tests/crm-e2e.test.js` (sections A to G; limits injected by env, no network: `globalThis.fetch` is fenced by `tests/helpers/e2e.js`) | |

## Section 9. Out of scope (not built, on purpose)

Employer and agency portals (stage 3), accounting UI, attendance/HR, chat/WhatsApp, MCP assistant, SEO beyond a basic `sitemap.xml` and `robots.txt`, CMS-style page editing, payments, importing third-party job boards. None of these exist. `sitemap.xml` has absolute URLs only when `SITE_BASE_URL` is set (`tests/site-ui.test.js` "http: robots.txt and sitemap.xml are served...").

## Section 10. Owner inputs needed

| Input | Status | What happens until it is provided |
|---|---|---|
| `SITE_PHONE`, `SITE_WHATSAPP` (https link), `SITE_EMAIL`, postal address, `SITE_LICENCE_TEXT` | Blocked (owner) | The site shows no contact fact, no licence line. |
| Domain and HTTPS | Blocked (owner) | The first install works on an sslip.io address. `SITE_BASE_URL` (needed for the sitemap) stays empty. |
| Real mail provider | Blocked (owner) | Candidates cannot receive sign-in codes (the sandbox only accepts allow-listed test addresses), and no staff notification e-mail exists. |
| Legal review of privacy and terms pages | Blocked (owner) | The pages carry generic wording written by the developers. |
| Approval of the disclaimer and all ar/en/fr copy | Blocked (owner) | Texts were not reviewed by native speakers. |

## Known limits (from the earlier task reports)

- The current candidate stage is inferred from the timeline (latest stage change), with the stored column as fallback.
- Candidate scope is stricter than lead scope (see Section 5).
- Agents cannot convert or write leads, by design.
- No data retention job: leads, spam rows and hashes are kept until someone deletes them; the privacy page promises correction and deletion on request, which is a manual database task today (no staff screen for it).
- Staff UI never tested in a browser; mobile layout of the site not tested on devices.
- `crm_employers` is a table only (stage 3 builds on it).
- `evidence_note` on a site job offer is free text typed by staff. The system checks that it is not empty before publishing; it does **not** verify that the source exists or says what the note claims. The public pages therefore say offers are "entered by our staff with a note of their source" and tell candidates to verify details and never pay anyone for a job.
- Rate limits are per client address (IPv6 per /64) plus a global daily cap (`SITE_LEAD_GLOBAL_PER_DAY`, default 2000). A determined attacker with many addresses can still fill the Leads tab with junk up to the global cap each day, and a legitimate visitor can be refused (429) when the cap is reached. Spam rows are not purged automatically.
- Behind Caddy the per-IP limits only work with `TRUST_PROXY=1` (setup.sh now adds it to an `.env` that lacks it, and never overwrites an existing value). Without a proxy the setting must be removed.
- Without `SITE_IP_SALT` the app uses a random salt per process: nothing breaks, but hashes and rate-limit counters reset on every restart (production logs one warning).
- A same-email resubmission within 24 hours only fills empty fields of a new/contacted/qualified lead; a changed name, a second message or fresh consent from the same person are ignored by design (staff see the original). Resubmissions for converted or rejected leads are acknowledged and dropped without a new lead.
- The honeypot field is `hp_url`. Browsers or password managers that fill hidden fields anyway would have such a visitor stored as spam (answered "ok"); the field has `autocomplete="off"` and non-credential attribute names to make this unlikely, but it was not tested in real browsers.

## Review round 1 (independent review) - fixes recorded

| Finding | Fix | Evidence |
|---|---|---|
| The public form could overwrite an existing lead (name, consent time, status-agnostic) | Only new/contacted/qualified leads are updated, fill-if-empty only; name and consent never change; converted/rejected leads are acknowledged and untouched | `tests/site-public.test.js` "review 1.1: ..." (2 tests) |
| Passport duplicate check missed case/whitespace variants | Compared as `upper(btrim())`; stored trimmed and upper-cased; message unchanged and generic | `tests/crm-convert.test.js` "review 2a: ..." |
| Re-converting a converted lead returned the full candidate row without a candidate-scope check | Same permission check, `assertCandidateAccess` (staff out of scope: 404); answer is only `{candidate:{id, full_name, crm_stage}, created:false}` | `tests/crm-convert.test.js` "second convert is idempotent...", "review 2b: ..." |
| `/public/jobs?offset=1e30` could give 500 | Only digit strings that are safe integers are accepted, offset capped at 100000, anything else falls back to the default | `tests/site-public.test.js` "review 1.3: ..." |
| Honeypot named `website` (autofill risk) | Renamed `hp_url` in all three forms, `site.js`, the service, docs and tests; hidden by the `.hp` CSS class; only a non-blank value is spam | `tests/site-public.test.js` "review 1.4: ...", `tests/site-ui.test.js` "forms: honeypot..." |
| Fixed development salt for IP hashes; privacy page said "we do not store your IP address" | Random per-process salt when `SITE_IP_SALT` is unset (one production warning); privacy text (ar/en/fr) now says a salted one-way hash of the IP is stored | `tests/site-public.test.js` "review 1.5: ...", `tests/site-ui.test.js` "review 5: ..." |
| `assigned_to` accepted any non-Candidate user (Accountant, HR) | Must be an active user with a role from the `/crm/staff` list (one shared constant) | `tests/crm-leads.test.js` "review 6: ..." |
| IPv6 evasion of per-IP limits, no global ceiling, unbounded rate-limit table, missing `TRUST_PROXY` on older installs | /64 bucketing (IPv4-mapped as IPv4) for limits and `ip_hash`; `SITE_LEAD_GLOBAL_PER_DAY` (default 2000, honeypot included); deletion of counters older than 2 days (about 1% of hits, at most 1000 rows per run); `setup.sh` ensures `TRUST_PROXY=1` | `tests/site-public.test.js` "review 1.7: ..." (5 tests), `tests/deploy-kit.test.js` "review 7: ..." (3 tests) |
| Wording promised contact ("our team will get in touch") and claimed offers were "checked against their source" | ar/en/fr and the HTML fallbacks now say "may contact you" / "we aim to reply" (no timing), and that offers are entered by staff with a note of their source, to be verified by the candidate, who must never pay anyone for a job; disclaimer unchanged | `tests/site-ui.test.js` "review 8: ..." (3 tests), i18n parity test |
