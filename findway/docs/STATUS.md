# Requirement status ledger

Honest status for every numbered requirement of the brief. **T** = covered by automated tests (file in brackets) · **I** = implemented, not separately tested · **P** = partial · **D** = deferred to the phase shown · **B** = blocked on input from you · **M** = mocked/placeholder (named explicitly).
Test totals and how they were produced: see §Results at the bottom.

## 1. Start with existing systems
| Requirement | Status |
|---|---|
| Inspect repository, CRM, auth, DB structure, APIs, deployment | **Done** for the one codebase available (`trust-crm`): ARCHITECTURE §1. Live CRM/platform/deployment **B** |
| Identify reusable functionality; module vs connected app; preserve records/workflows | **Done**: ARCHITECTURE §2 — connected application; trust-crm untouched |
| No second candidate/company database without ownership + sync plan | **Done**: ARCHITECTURE §2.1, INTEGRATION §4; people reach trust-crm only after human qualification; linking never overwrites **T** [integration] |
| No production data migrated/modified without backup/preview/rollback | **Honoured**: nothing migrated; plan in INTEGRATION §10, OPERATIONS §5; restore check **T** [backup] |
| Concise checklist of missing information | [INTEGRATION_CHECKLIST.md](INTEGRATION_CHECKLIST.md) |
| Continue with schemas/adapters/local dev | Done |

## 2. Platform structure
| Experience | Status |
|---|---|
| A Public website · B Candidate portal · C Employer portal | **I** Phase-1 scope (SITEMAP) |
| D Agency portal | **P** status-only; tools **D** Phase 2 |
| E Staff workspace · F Admin/Super Admin workspace | **I** Phase-1 scope: leads, duplicates, candidates, companies, applications, requests, cases, approvals, verifications, job reviews, staff, audit |
| G AI assistant/automation center | **D** Phase 3 |
| H API/webhook/MCP integration center | Integration Center **I/T**; MCP **D** Phase 3 (design: MCP_DESIGN.md) |
| Responsive website + installable PWA; shared backend for native apps | **I**; PWA is explicitly *not* described as an App Store/Play Store release. Native apps **D** Phase 4 |

## 3. Brand, language, usability
| Requirement | Status |
|---|---|
| Light-blue primary, white, restrained gold, readable type, clear status labels | **I** (browser-checked; screenshots in docs/screenshots) |
| Original logo/icons or marked placeholders | **M** the logo you supplied is used and recorded as *pending formal brand approval* (`web/assets/README.md`) |
| English, Arabic, Albanian, French; room for more | **I** (JSON per language + one registry line); key parity **T** [i18n]. Copy for AR/SQ/FR was written by me and **needs native-speaker review** (B-08) |
| Complete Arabic RTL | **I** logical CSS properties, mirrored icons; no horizontal overflow at 390 px checked in browser run |
| Mobile-first, keyboard nav, labels, loading/empty/error/success/permission-denied states | **I** (automated structural checks in the browser run; **no assistive-technology audit yet**) |
| Slow connections, **resumable large uploads** | timeouts/retry **I**; resumable uploads **D** Phase 2 (no uploads exist) |
| Localised dates/currency/time zones; user content preserved | **I** (`Intl`; `dir="auto"` on user content) |
| No fabricated statistics/testimonials/badges/logos | **I** — verified badge only when API says `verified`; no stats shown |

## 4. Accounts, approvals, permissions
| Requirement | Status |
|---|---|
| Roles (8) | **I/T** |
| Email OTP with expiry, attempt limit, resend limits | **T** [auth] |
| Secure login, recovery, sessions, suspension | **T** [auth] |
| Optional social login | **D/B** (provider credentials) |
| MFA for privileged users | **T** [auth, workflows] (TOTP + recovery codes + reset by Super Admin) |
| Keep email verification / profile completion / identity-company review / admin approval separate | **T** [auth, workflows] |
| Pending users can onboard and see status, no restricted access | **T** [auth, workflows] |
| Enforce permissions in APIs, queries, files, exports, background tasks, MCP | APIs/queries **T**; background worker uses a system actor and reads only what the adapter needs **I**; files/exports/MCP **D** (do not exist yet) |
| Default boundaries (candidate/employer/agency/staff/guest/super admin) | candidate, employer, staff, agency **T** [recruitment, jobs, workflows]; guest links **D** Phase 2; "Super Admin controls pricing" **D** (no finance yet) |
| Audited reassignment keeping attribution | **T** [recruitment] |

## 5. Public website and job search
| Requirement | Status |
|---|---|
| Pages: home, search, details, company directory/profile, help, privacy, terms, contact, account pages | **I**; privacy/terms/contact are **honest placeholders** pending your approved legal text and contact details **B**. Projects, country, profession, about pages **D** |
| All listed search filters | **T** [jobs] (keyword, profession, country, city, experience, skills, languages, salary range+currency+period, employment type, mode, accommodation, relocation) |
| Job details fields incl. reference no., verification status, location, salary (gross/net or "not specified"), hours, shifts, overtime, contract, probation, benefits, deadline, accepted formats, international-recruitment eligibility, last verified | **T** [jobs]; map display **D** (coordinates stored) |
| Do not infer sponsorship/visa eligibility | **T** [jobs] (`null` ⇒ "not specified") |
| Version material changes; notify applicants; acknowledgement | **T** [jobs] |

## 6. Candidate profiles and documents
| Requirement | Status |
|---|---|
| Profile fields | **T** [recruitment] |
| Multiple CVs, CV per application, videos, voice, saved jobs/searches, alerts | **D** Phase 2/4 |
| Track applications, interviews, offers, requests | applications/requests/case stage **T**; interviews **D** |
| Visibility/consent management; data export/deletion requests | consent **T**; requests are **recorded** (T) but **not executed** (Phase 2) |
| Passport/ID collection only when needed; scanned-PDF rules; upload validation, malware scanning, expiry/review/version history | identity *numbers* + expiry **T** [security]; **document uploads D** (needs storage provider **B**) |

## 7. Leads, applications, recruitment cases
| Requirement | Status |
|---|---|
| Separate linked entities: person, lead, application, case | **T** [recruitment] |
| Every application enters Leads; Received → Under Review → Missing Info / Rejected / Qualified | **T** [recruitment] |
| Qualification links/creates candidate; continues application and case | **T** [recruitment] (case opening is an explicit staff action after "selected") |
| Duplicate prevention (normalised email, phone, identity refs); uncertain → human; never name-only merge | **T** [recruitment, security] |
| Multiple applications per candidate; one active per job; duplicate protection; withdrawal/reapplication policy; separate internal notes; status history | **T** [recruitment] |
| Application stages (10) and case stages (11); reasons for rejection/cancellation/reversal | **T** [recruitment] |

## 8. Employer portal
| Requirement | Status |
|---|---|
| Register + company verification | **T** [workflows] |
| Team members | **D** (membership model exists; invitations not built) |
| Draft → approval; edit/pause/renew(deadline)/close | **T** [jobs, workflows] |
| Review applications and *approved candidate media* | applications **T**; media **D** |
| Filter and shortlist; interview/selection requests; offers | shortlist/requests **T**; offers **D** (case stage "offer" exists) |
| Messaging, response-time and hiring reports | **D** Phase 2 |
| Direct vs managed recruitment mode; selection ≠ placement | **T** [recruitment] |
| Private identity docs, agency pricing, internal notes, unrelated candidates inaccessible | **T** [recruitment, security] |

## 9. Video catalogue and guest showcases — **D** Phase 2 (design constraints captured: canonical media source, short-lived links, consent, access logs)

## 10. Agency portal — **D** Phase 2 (agency accounts, org, approval and isolation exist **T** [workflows])

## 11. Internal CRM and operations
Modules built: Dashboard (queue counts), Leads, Candidates, Companies (staff-added with *introduced by*, owner, source, last contact, next action), Applications, Recruitment Cases, Staff, Integrations, Audit Log, Settings (policy rows via DB) — **I/T**. Modules not built: Contacts, Jobs (read-only list for staff), Agencies, Documents, Videos, Interviews, Messages, Tasks, Finance, Reports, saved views, bulk actions, response-time targets, overdue/missing-document queues, tourist visa module — **D** Phase 2. Separation of candidates in Albania vs abroad vs other destinations: country fields exist; dedicated workflow views **D**.

## 12. Messaging, email, notifications
In-app notifications **T**; transactional e-mail with honest states (`queued → provider_accepted`, never "delivered" without receipt) **T** [auth, workflows]; outreach drafts are stored as `prepared` and cannot send (no send path exists) **I**; SMTP provider **I/T** [mail] — verified against a local SMTP server (message arrives, localised, code works, failure recorded as `failed`); **a real Hostinger mailbox has not been tested** (needs your SMTP credentials **B**); delivery receipts/bounces **D** (SMTP only proves hand-off). Conversations, push, WhatsApp, preferences/quiet hours/unsubscribe, reporting, search — **D** Phase 2.

## 13. Finance and commissions — **D** Phase 2 (nothing invented; no prices, rates or commissions exist)

## 14. Staff attendance — **D** Phase 2

## 15. CRM and platform integration
| Requirement | Status |
|---|---|
| Documented architecture before implementation | **Done** (INTEGRATION.md) |
| Adapter, source of truth per field, id mapping, direction, versions/origin, loop prevention | **T** [integration] |
| Idempotency keys; duplicate and out-of-order events; optimistic concurrency + conflict queue | **T** [integration] |
| Retry with backoff; dead-letter; replay; reconciliation | **T** [integration] |
| Propagate deletion/consent/revocation | `consent.revoked` event emitted **T**; deletion propagation **D** Phase 2 |
| Required events | emitted: candidate.created/updated, lead.created/qualified, application.submitted/status_changed, job.published/closed, placement.updated, consent.revoked **T**; `document.*`, `interview.scheduled` **D** (modules don't exist) |
| Sign webhooks, verify timestamps, prevent replay, rotate secrets, log outcomes | **T** [integration] |
| Integration Center; "Connected" only after real auth + test request | **T** [integration] |
| Live CRM / platform | **B** (tested against the repo's real trust-crm; the live deployment may differ) |

## 16–17. MCP server and tools — **D** Phase 3 (design: MCP_DESIGN.md; service layer, principal `via/client`, audit and versioning are already in place)
## 18–19. AI workspace, automations, AI job search — **D** Phase 3/4
## 20. Projects, subscriptions — **D** Phase 4 (paid plans stay disabled; no prices invented)

## 21. Data, security, reliability
| Requirement | Status |
|---|---|
| Core entities | Phase-1 subset (DATA_MODEL.md) |
| DB constraints/migrations | **T** (checksummed forward-only migrations; constraints exercised by tests) |
| Organisation and record-level access control | **T** |
| Private file storage, upload validation, malware scanning | **D/B** |
| Encryption in transit | **deployment** (TLS at the proxy, OPERATIONS §4). At rest: application-level AES-GCM for secrets/identity **T**; volume/DB encryption is an infrastructure setting **B** |
| Secret management | env-only, production boot guard **T**; external secret manager **B** |
| Rate limits and abuse protection | **T** [security] (per-process memory) |
| Backup and *tested* recovery | **T** [backup]: dump → restore → identical row counts, triggers intact |
| Structured monitoring and alerts | logs/health **I**; alert wiring **B** (suggestions in OPERATIONS §6) |
| Retention/deletion workflows | requests recorded; execution **D** |
| Audit logs with restricted access | **T** (append-only; admin-only read) |
| No hard-coded legal/immigration assumptions | **Honoured** (policy rows; document rules not hard-coded; nothing infers visa eligibility) |

## 22. Reports — **D** Phase 2 (metric definitions to be written with the module)

## 23. Required screens — see [SITEMAP.md](SITEMAP.md)

## 24. Delivery phases — Phase 0 **done**; Phase 1 **done within the scope above**; Phases 2–4 **not started**

## 25. Acceptance tests
| Acceptance test | Result |
|---|---|
| Registration, OTP expiry, resend limits, approval | **Pass** [auth] |
| Employer draft → admin approval → public listing | **Pass** [jobs] |
| Candidate application → Lead → qualification without duplication | **Pass** [recruitment] |
| Missing-document request → upload → review | **Not testable yet** (documents Phase 2). The *missing-information* request/response loop passes [recruitment] |
| Employer shortlist → interview request → confirmed interview | shortlist → request → **staff confirmation** passes [recruitment]; *scheduled interview details* **D** Phase 2 |
| Candidate status updates synchronised between systems | case-stage both directions **Pass** [integration]; application-stage → trust-crm is intentionally not synchronised (trust-crm has no application concept) |
| Cross-company, cross-agency, staff, file-access isolation | company/candidate/staff/agency **Pass** [recruitment, jobs, workflows]; file access **D** |
| Expired and revoked guest links blocked | **D** Phase 2 |
| Duplicate webhook processed once; out-of-order handled | **Pass** [integration] |
| Integration outage, retry, conflict review, reconciliation | **Pass** [integration] |
| MCP authentication / scope rejection / revocation / approval replay | **D** Phase 3 |
| Prompt injection in CV cannot authorise actions | **D** Phase 3 (control design in MCP_DESIGN §5; today no endpoint interprets free text as instructions) |
| Unauthorised pricing changes rejected | **D** (no pricing yet) |
| Email drafts remain unsent until approved | draft state exists and no send path exists **I**; approval workflow **D** Phase 2/3 |
| Arabic mobile workflows work | **Pass** (partial scope) — Chromium at 390×844: RTL + no horizontal overflow on home, jobs, job detail, login, register, profile, applications; live language switch; keyboard menu. Exactly what was exercised: [DEMO.md](DEMO.md) |
| Backup restoration succeeds | **Pass** [backup] |
Synthetic data only: every record created by tests/seed is fictional.

## 26. Deliverables
Source + migrations ✔ · architecture/data model ✔ · screen inventory + permission matrix ✔ · API docs + webhook contracts ✔ · CRM mapping + sync rules ✔ · MCP tool catalogue + auth setup (design) ✔ · env examples ✔ · automated test results ✔ · setup/deploy/backup/recovery ✔ (Docker/CI files **untested**) · known limitations + pending credentials ✔ · this ledger ✔.

## Known limitations / things to verify yourself
1. Tested against the trust-crm *source in this repo*; the live system may differ.
2. Docker image and the GitHub Actions workflow were not executed here.
3. Rate limiting is per process; OTP/login limits are DB-backed and multi-instance safe.
4. Translations (AR/SQ/FR) are machine-assisted drafts needing native review; legal pages are placeholders.
5. No assistive-technology accessibility audit and no penetration test have been done.
6. Until `MAIL_PROVIDER=smtp` and the `MAIL_SMTP_*` credentials are set, e-mail goes to a development capture and nothing real is sent. Run `node scripts/test-mail.js you@example.com` to prove the real account works.
7. trust-crm date handling depends on its server time zone (keep UTC).

## Results

## Results (verified 2026-10-23, re-run independently of the agent that wrote the UI)
* `npm test`: **77 tests, 77 pass** (auth 13, jobs 8, recruitment 12, workflows 9, integration 13 against the real trust-crm app, security 8, backup 1, docs 1, i18n 9, mail 3).
* `npm run test:e2e` (real Chromium, throw-away DB, synthetic data): **21/21 steps pass**, zero console errors, zero CSP violations. Details and the honest limits: [DEMO.md](DEMO.md).
* Not covered by any automated check: colour-contrast measurement, screen-reader behaviour, the lead duplicate-merge panel, employer applicant actions and the full job-editor field set in the *browser* (their APIs are tested), webhook subscription forms.
* Known small API gaps found while building the UI: internal notes cannot be attached to a *lead* (application notes are used); `/api/me` has no profile-completion breakdown for non-candidates; an edit-after-publication reason is a raw code string the UI maps.
