# VITA Employer and Agency Portals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Employer and agency portals plus staff tools, per the spec.
**Architecture:** Additive migration 013; generalise OTP eligibility; new modules `modules/orgs/*`; routes `routes/employerPortal.js`, `routes/agencyPortal.js`, extend `routes/crm.js`; static portals in `public/vita/`.
**Tech Stack:** Node 22, Express, pg, node:test, plain HTML/JS.
**Spec:** `docs/superpowers/specs/2026-10-23-vita-employer-agency-portals-design.md` (builds on `2026-10-23-vita-website-crm-core-design.md`).

## Global Constraints
- Additive; stages 1–2 and job-search behaviour unchanged (Candidate OTP login and tokens unchanged).
- Employer/Agency roles: zero staff permissions; org comes from the token link, never from request input; other orgs' objects ⇒ 404.
- Employer-visible candidate data = frozen allowlist `{profession, years_experience, languages, country_of_residence, availability, staff_note_for_employer}` only; requires active `candidate_share_consents` for (candidate, employer); withdrawal hides immediately.
- Strict CSP, ar/en/fr parity, disclaimer on both portals, textContent only, every mutation → `crm_timeline` + `logAudit(client)` in one transaction, commits with the repo trailers (Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>, Claude-Session: https://claude.ai/code/session_01FJCJCrbEtXFCvjTVJwpqAi). Full `npm test` stays green.

## Review Focus
- Employer token used against every old route (sweep) — must be denied.
- Presentation after consent withdrawal; employer reading a presentation of another employer by id.
- Suspended organisation/user: existing token stops working at once.
- Agency registering a candidate whose email/passport already exists in the CRM must not reveal that fact to the agency.
- Invite of an email that already belongs to a staff/candidate user.

### Task 1: Migration 013 + roles + OTP generalisation
Files: `sql/migrations/013_orgs_portals.sql`, `middleware/role.js`, `middleware/auth.js`, `modules/jobsearch/otp.js`, `routes/jobsearchAuth.js` (only if needed), test `tests/orgs-schema.test.js`, `tests/orgs-otp.test.js`.
Produces: tables per spec §3; `users.role` check extended (idempotent, no data loss); permissions `orgs:read`,`orgs:write` (Admin/SuperAdmin write+read, Manager write+read, Receptionist read); OTP `findEligibleUser` accepts Candidate (via js_candidate_accounts) and Employer/Agency (via crm_org_accounts); portal login endpoint(s) return a token with `tv` for those roles (reuse existing request/verify endpoints, responding with role). `verifyToken` treats Employer/Agency like Candidate for `tv` revocation.
Tests: migration idempotent; Candidate OTP unchanged (existing js-otp tests pass); Employer OTP works only when linked and active.

### Task 2: Staff organisation management + invite + suspend
Files: `modules/orgs/orgsAdmin.js`, `routes/crm.js`, test `tests/orgs-admin.test.js`.
Produces: CRUD for employers/agencies, `invite(user, orgType, orgId, {email, full_name})` (creates Employer/Agency user with unusable password, link row, sends OTP; refuses emails of existing staff/candidate users with 409; one user per org membership), suspend/reactivate (bumps `token_version`, deactivates user). Role matrix tests; audit/timeline.

### Task 3: Employer portal API (requests)
Files: `modules/orgs/employerRequests.js`, `routes/employerPortal.js`, `app.js` mount `/employer`, test `tests/employer-portal.test.js`.
Role-Employer-only middleware resolving org from `crm_org_accounts` (suspended org ⇒ 403). Requests CRUD per spec; limits/validation (title 160, description 8000, positions 1..1000); employer cannot see staff_note; isolation tests employer A vs B.

### Task 4: Staff request review + share consents + presentations
Files: `modules/orgs/presentations.js`, `modules/orgs/shareConsents.js`, `routes/crm.js`, test `tests/orgs-presentations.test.js`.
Produces: staff list/patch of employer requests (status transitions, employer_visible_note, optional draft `site_jobs` creation via existing service, never auto-publish); share-consent record/withdraw (candidate in staff scope; withdraw hides existing presentations: employer queries filter by active consent); `presentCandidate(user, requestId, candidateId, {staff_note_for_employer})` builds the frozen allowlisted summary from the confirmed job-search profile when present (js_profiles.confirmed) else staff-entered minimal fields; employer endpoints `GET /employer/presentations`, `POST /employer/presentations/:id/respond`. Tests: allowlist key set exact; consent gate; withdrawal hides; cross-employer 404; respond transitions; staff scope (Agent only own candidates).

### Task 5: Agency portal API
Files: `modules/orgs/agencyCandidates.js`, `routes/agencyPortal.js`, `app.js` mount `/agency`, test `tests/agency-portal.test.js`.
`POST /agency/candidates` creates a `crm_leads` row (kind candidate, source agency, agency_id, consent attestation required, honeypot not needed, per-agency daily cap env `AGENCY_CANDIDATES_PER_DAY` default 50); duplicates (email/phone/passport existing anywhere) return the same generic success without revealing existence (store as a staff-visible duplicate flag); `GET /agency/candidates[/:id]` own only via lead/candidate agency_id (name, profession, stage, status text, created_at). convertLead (stage 2) copies agency_id to the candidate. Tests: isolation, no leakage of duplicates, caps, Employer/Candidate denied.

### Task 6: All-routes sweep (security regression)
Files: test `tests/orgs-route-sweep.test.js` only (plus fixes it exposes).
Enumerate every registered route of the Express app (app._router stack), call each with an Employer token and an Agency token (and Candidate where relevant), assert 401/403/404 for everything except the allowed `/employer/*`, `/agency/*`, `/auth/*`-login, `/public/*`, healthz, static. Fix any leak found in the relevant route (minimal) and record it.

### Task 7: Portals UI + staff tabs
Files: `public/vita/employer.html|js`, `agency.html|js`, `crm-orgs.js`, `crm-requests.js`, `i18n.js`, `admin.html`, `vita.css`, `public/site/employers.html` link, tests `tests/orgs-ui.test.js`.
Employer portal: login by code, request list/form/detail, presentations with respond buttons. Agency portal: login, register candidate form, own list. Staff tabs: Organisations (create, invite, suspend), Employer requests (status, notes, present candidate dialog showing the exact summary, share-consent record/withdraw). ar/en/fr parity, CSP-safe, disclaimer. Browser smoke with Playwright (Chromium pre-installed) of the whole flow.

### Task 8: End-to-end, docs, deploy notes
Files: `tests/orgs-e2e.test.js`, `docs/vita-employer-agency/{CHECKLIST,SETUP}.md`, `.env.example` additions (`AGENCY_CANDIDATES_PER_DAY`), CHECKLIST honesty. Journey: staff creates employer + invites → employer logs in by code → submits request → staff reviews, records consent, presents candidate → employer sees summary only, responds interview → staff sees response → consent withdrawn → employer no longer sees it; agency invited → registers candidate → staff converts → agency sees stage; suspension kills tokens; isolation both ways.
