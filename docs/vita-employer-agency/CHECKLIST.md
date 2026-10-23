# VITA employer and agency portals — requirement checklist

For each requirement of the design (`docs/superpowers/specs/2026-10-23-vita-employer-agency-portals-design.md`, sections 1 to 8) this page says whether it is completed, tested (and in which test file) or blocked. Test files are in `trust-crm/tests/`.

| Mark | Meaning |
|---|---|
| Done + tested | Built and covered by automated tests (file named) |
| Done, partly tested | Built; the untested part is named in the notes |
| Blocked (owner) | Code exists but needs something only the owner can provide |
| Not built | Left out on purpose; said plainly |

## Read this first (honest status)

- Everything was tested only by automated tests on a development machine: real HTTP server, real Postgres (a throw-away schema per test file), sandbox mail, no network. **Nothing has been run on a real server, behind a real domain, with real HTTPS or with a real mail provider.**
- **A real mail provider is needed** for invites and sign-in codes to reach real people. With the sandbox provider the codes only land in a test table.
- **The wording of the candidate sharing consent and the employer terms is placeholder text and needs legal review** before any real employer or candidate uses the portals. Staff attest the consent (date and basis); the system does not collect the candidate's signature.
- The portal pages were checked by static, helper and contract tests (`orgs-ui.test.js`). The rendered pages in a real browser were smoke-checked by hand during development; that check is not an automated test and has not been repeated on a real server.
- No promise of hiring, sponsorship or visa is made anywhere; the disclaimer is shown in both portals in Arabic, English and French.

## Section 1. Goal and hard rules

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Employers sign in by e-mail code, send a recruitment request, review presented candidates and answer interested / interview / not suitable | Done + tested | `orgs-e2e.test.js` (A); `employer-portal.test.js`; `orgs-presentations.test.js` "employer respond transitions..." | |
| Agencies sign in, register their own candidates and follow only those | Done + tested | `orgs-e2e.test.js` (B); `agency-portal.test.js` | |
| Staff manage both organisations, review requests, decide what is presented | Done + tested | `orgs-admin.test.js`; `orgs-presentations.test.js`; `orgs-e2e.test.js` | |
| Employer sees only the six summary fields (profession, years of experience, languages, country of residence, availability, staff note) | Done + tested | `orgs-e2e.test.js` (A: exact key set, no name / e-mail / phone / passport / extra profile data anywhere in the raw response text); `orgs-presentations.test.js` "present: exact allowlist snapshot..." (also re-filtered at read time if stored data is tampered with) | |
| Only for candidates presented to that employer with an active recorded share consent | Done + tested | `orgs-presentations.test.js` (consent gate, duplicate, status gate); `orgs-e2e.test.js` (A) | |
| Withdrawing the consent hides the candidate from the employer at once and blocks answering | Done + tested | `orgs-e2e.test.js` (A: list empty, detail and respond 404); `orgs-presentations.test.js` "withdrawing the share consent..." | |
| Agency sees only its own candidates: name, stage, status text; no documents; no other agency's data | Done + tested | `agency-portal.test.js` (isolation, allowlisted columns); `orgs-e2e.test.js` (B: agency B sees nothing of A) | |
| Duplicate registrations are not disclosed to the agency | Done + tested | `agency-portal.test.js` "duplicate non-disclosure..."; `orgs-e2e.test.js` (B: identical status and body shape) | |
| Disclaimer (no hiring / visa promise) in both portals, ar/en/fr | Done + tested | `orgs-ui.test.js` (notice and i18n parity) | Wording needs legal review |

## Section 2. Identity

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Roles `Employer` and `Agency`, linked to an organisation, one organisation per user | Done + tested | `orgs-schema.test.js`; `orgs-admin.test.js` | |
| Staff create the organisation and invite a portal user (user + link + code mail) | Done + tested | `orgs-admin.test.js`; `orgs-e2e.test.js` (invite mail code read from the sandbox mailbox, wrong code refused, single use) | Delivery to a real mailbox: blocked (owner, mail provider) |
| Login by the existing e-mail code flow, Candidate behaviour unchanged | Done + tested | `orgs-otp.test.js`; `orgs-e2e.test.js` (C: second login by a requested code) | |
| Tokens carry `tv`; suspension revokes sessions at once; reactivation needs a new login | Done + tested | `orgs-e2e.test.js` (C); `orgs-admin.test.js`; `employer-portal.test.js` "suspended organisation..." | |
| Employer / Agency roles hold no staff permissions; every pre-existing route denies them | Done + tested | `orgs-route-sweep.test.js` (enumerates the app's routes); `orgs-e2e.test.js` (D re-runs the sweep file and requires it to pass) | |

## Section 3. Data (migration 013)

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Tables `crm_agencies`, `crm_org_accounts`, `employer_requests`, `employer_presentations`, `candidate_share_consents`; `agency_id` on candidates and leads; role check extended; idempotent | Done + tested | `orgs-schema.test.js`; `migrate.test.js` | |
| State changes write the timeline and the audit log | Done + tested | `orgs-presentations.test.js`; `orgs-admin.test.js`; `employer-portal.test.js`; `agency-portal.test.js` | |

## Section 4. APIs

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Staff APIs: organisations, invite, suspend / reactivate, employer requests, presentations, share consents; permissions `orgs:read` / `orgs:write` | Done + tested | `orgs-admin.test.js` (role matrix); `orgs-presentations.test.js` | |
| Preview shows exactly what will be shared, before presenting | Done + tested | `orgs-e2e.test.js` (A: preview equals the shared summary) | |
| Employer portal: me, requests (create, read, edit while submitted, cancel), presentations, respond; organisation from the token only | Done + tested | `employer-portal.test.js`; `orgs-e2e.test.js` | |
| Agency portal: me, register candidate, list and read own | Done + tested | `agency-portal.test.js`; `orgs-e2e.test.js` | |
| Converting an agency lead keeps `agency_id`; the agency sees the stage label after staff change it | Done + tested | `agency-portal.test.js`; `orgs-e2e.test.js` (B) | |
| 404 (not 403) for other organisations' objects; 16 KB body caps; rate limits on portal writes | Done + tested | `employer-portal.test.js` (isolation, 413, daily cap); `agency-portal.test.js` (daily cap, isolation) | Limits are per organisation per day, kept in the database |

## Section 5. UI

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| `/vita/employer.html` and `/vita/agency.html`, ar/en/fr with RTL, login by code, CSP-safe | Done, partly tested | `orgs-ui.test.js` (static, CSP, i18n parity, helpers, contract with the API) | Rendering in a real browser is not an automated test |
| Staff tabs "Organisations" and "Employer requests" with the presentation preview | Done, partly tested | `orgs-ui.test.js` | Same limit |
| Public employer page links to the employer portal | Done + tested | `orgs-ui.test.js` | |

## Section 6. Testing

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Schema and migration idempotence | Done + tested | `orgs-schema.test.js`; `migrate.test.js` | |
| Role matrix, all-routes sweep, isolation both ways, consent gate and withdrawal, summary allowlist, invite -> code login -> revocation, end-to-end journey | Done + tested | `orgs-admin.test.js`, `orgs-route-sweep.test.js`, `employer-portal.test.js`, `agency-portal.test.js`, `orgs-presentations.test.js`, `orgs-otp.test.js`, `orgs-e2e.test.js` | |
| i18n parity and CSP checks | Done + tested | `orgs-ui.test.js` | |
| Browser smoke | Done, partly tested | Manual, during development | Not repeatable from this repository |

## Section 7. Out of scope (not built, on purpose)

| Item | Status |
|---|---|
| Contracts | Not built |
| Payments and commissions (accounting stage) | Not built |
| Employer-side file upload | Not built |
| Chat between employer, agency and staff | Not built |
| Automatic matching of requests to candidates | Not built |
| Agency bulk import | Not built |

## Section 8. Owner inputs

| Input | Status |
|---|---|
| Real mail provider (invites and codes) | Blocked (owner) |
| Legal wording for the sharing consent and the employer terms | Blocked (owner / legal review) |
| The list of partner employers and agencies to invite | Blocked (owner) |
| Two new settings `EMPLOYER_REQUESTS_PER_DAY`, `AGENCY_CANDIDATES_PER_DAY` | Done: optional, defaults 20 and 50; see [SETUP.md](SETUP.md) |

## Known limits (from the build reports)

- The employer portal has **no live updates**: a new presentation or a changed request note appears after the page is reloaded (the candidate portal has live events; these portals do not).
- The candidate lookup used by the presentation tooling and by reports is **capped by `CANDIDATE_LIST_LIMIT` (500)** in `modules/jobsearch/reportService.js`; beyond that, find a candidate by id or narrow the search.
- `years_experience` is **derived** when the confirmed profile does not state it: the calendar-year spans of the experience entries are added up (an open end counts to the current year), so overlapping jobs are counted twice and part years are approximate. Staff can supply the value by hand, and should check it in the preview.
- A suspended organisation's old token answers **401** (the session was revoked), whereas a token of an organisation suspended without a version bump (data edited directly) answers **403**. Both mean "no access"; the tests accept the documented one per case.
- After a code mail the same address cannot request another for 60 seconds (a silent cooldown, kept in the database); the page shows the same message either way.
- Staff APIs do not return the duplicate flag of an agency lead in the lead list; the flag is stored (`duplicate_of`, `duplicate_candidate_id`, a timeline entry "duplicate_flagged") and is not shown to the agency.
- The share consent is attested by staff; there is no candidate-side button to grant or withdraw it.
- Rate-limit counters for the code login are in memory (reset when the app restarts); the daily caps for employer requests and agency candidates are counted in the database.

## Review round 1 (independent review) — fixes and remaining limits

Migration `015_orgs_review_fixes.sql` (additive, idempotent). Every item below has a test written first in the existing test file for that area.

| # | Finding | Status | Where tested |
|---|---|---|---|
| 1 | Employer reads and respond showed presentations of soft-deleted candidates; staff withdraw could be blocked by deletion or reassignment | Fixed: every employer query joins `candidates` with `is_deleted = false`; consent withdraw and presentation withdraw are always allowed for Admin/SuperAdmin (`users:write`), other staff need candidate scope as before | `orgs-presentations.test.js` (review 1: soft-deleted, reassigned) |
| 2 | A later NEW consent revived an old presentation | Fixed: `employer_presentations.consent_id` (backfilled in 015); employer queries join that exact consent and need it un-withdrawn. Presenting again after a new consent refreshes the same row (the `(request, candidate)` key stays unique) under the new consent with a rebuilt summary and a cleared response | `orgs-presentations.test.js`, `orgs-schema.test.js` (backfill) |
| 3 | Respond was accepted on closed requests | Fixed: respond needs request status `in_review` or `accepted` (else 409). Presentations of declined/filled/cancelled requests stay visible read-only with `closed: true`; the employer page disables the buttons and says so | `orgs-presentations.test.js`, `orgs-ui.test.js` |
| 4 | Suspend/reactivate toggled `users.is_active` | Fixed: both only change the organisation status and bump `token_version`; access is blocked by the org-status check; users deactivated individually stay deactivated | `orgs-admin.test.js` |
| 5 | Contact data could reach the employer through the summary | Fixed: before freezing/previewing, string values that contain `@`, a URL scheme or `www.`, 6 or more digits (separators ignored) or more than 120 characters are set to null and listed in `redacted` (preview and POST response). `staff_note_for_employer` is rejected with 400 for the same contact patterns (the 120-character rule does not apply to the note; its cap stays 1000) | `orgs-presentations.test.js` |
| 6 | create-site-job was not atomic | Fixed: check, draft, link, timeline and audit run in one transaction with `pg_advisory_xact_lock`; `siteJobsAdmin.createSiteJob` accepts an optional client. A failing link leaves no draft | `orgs-presentations.test.js` (injected trigger failure, concurrent calls) |
| 7 | Ids are global sequences | **Known limit, not changed** (see below) | n/a |
| 8 | `crm_employers.status` constraint left NOT VALID; 013 role-check drop loop matches `%role%` | Fixed in 015: junk statuses set to `new`, constraint validated (only if present and not yet valid); `users_role_check` is re-created if missing/stale. 013 is untouched. After all migrations the only CHECK on `users` is `users_role_check`; the others keep their `schema.sql` names (`users_pkey`, `users_email_key`) | `orgs-schema.test.js` |
| 9 | Disclaimer was candidate-oriented on the portals | Fixed: `employer.disclaimer` and `agency.disclaimer` (ar/en/fr) are the primary line, the standard sentence follows, and the all-languages block shows both | `orgs-ui.test.js` |

Remaining limits after this round:

- **Ids are global sequences** (`bigserial`): a portal user sees ids of their own requests, presentations and candidates, so the gaps between them let them infer platform-wide volume. Not changed on purpose.
- Migration 013's loop drops every `users` CHECK whose definition mentions "role". `schema.sql` has only the role-in-list check, so nothing else is lost on a database built from this repository; a database with extra hand-added role-related CHECKs lost them when 013 ran (015 cannot restore what it cannot know).
- The staff presentation preview returns `redacted` but the staff tab does not highlight it yet; staff see the field as empty.
- A presentation refreshed after a new consent keeps its id (history is in the timeline and audit log, not in a second row).
- The 120-character rule is defensive: staff-supplied values are already capped at 100/120 by validation and profile values are trimmed to 100/120.
