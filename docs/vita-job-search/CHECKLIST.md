# VITA AI Job Search & Applications — Requirement Checklist

البحث الآلي عن عمل / AI Job Search & Applications

This page says, for each requirement in the original request, what is built, what is tested and what is
waiting for the owner. Every "Evidence" entry is a real file or test name in `trust-crm/`. Test names are
quoted from the `test("…")` titles, shortened with "…" where long.

**Status key**

| Mark | Meaning |
|---|---|
| ✅ | Completed and covered by automated tests |
| 🟡 | Completed, but only partly tested (the gap is named in Notes) |
| 🔴 | Blocked on the owner: code exists, but it needs something only the owner can provide |
| ⚪ | Not built |

**Read this first.** The module is **not** ready for production use yet. No live job source is connected,
no real e-mail has ever been sent, and no real mailbox is connected. All tests use sandbox mail and test
job data. See [Completion statement](#completion-statement).

Related documents: [SETUP.md](SETUP.md) · [SOURCES_AND_PROVIDERS.md](SOURCES_AND_PROVIDERS.md) · [USER_GUIDE.md](USER_GUIDE.md)

---

## 1. CV upload → search start

| Requirement | Status | Evidence | Notes / limits |
|---|---|---|---|
| Candidate account created by an admin and linked to a CRM candidate | ✅ | `routes/jobsearchAuth.js` (`POST /jobsearch/admin/candidate-accounts`); `tests/js-otp.test.js` "admin creates a Candidate account linked to an existing candidate" | The account has no usable password. The candidate signs in by e-mail code only. |
| Candidate sign-in by e-mail one-time code (6 digits, hashed, 10 min, single use, 5 attempts, 60 s resend, rate limit, never logged) | ✅ | `modules/jobsearch/otp.js`; `tests/js-otp.test.js` (expired, single use, 5 attempts, resend, rate limit, "the OTP code never appears in console output or response bodies") | Rate limits are kept in memory per process (see limitations). Codes are sent through the mail adapter, so real candidates only receive codes once real mail is set up. |
| CV upload: PDF or DOCX, type checked from the file bytes, size limit, upload rate limit | ✅ | `routes/jobsearchProfile.js`, `modules/jobsearch/storage/`; `tests/js-profile.test.js` "oversize upload is cut off at the request layer with 413", "an EXE disguised as .pdf is refused (415)…"; `tests/js-storage.test.js` "sniffMime accepts only PDF, DOCX, PNG, JPEG" | PNG/JPEG are stored but give an empty extraction (no OCR). |
| Original CV kept unchanged; each upload is a new version | ✅ | `tests/js-profile.test.js` "a second upload creates a new version and leaves the original untouched" | |
| Field extraction invents nothing; hostile CV text stays inert | ✅ | `modules/jobsearch/extract/deterministic.js`; `tests/js-profile.test.js` "extract: sample CV returns exactly the fields present and nothing invented", "injection CV: no side effects…", "extract: hostile long lines finish fast (no ReDoS)…", "zip bomb DOCX is rejected 422 quickly…" | Extraction is rule-based (no AI model). It finds fewer fields than a person would. The candidate reviews and completes them. |
| Candidate confirms the profile; each field records its origin (CV, candidate, staff) | ✅ | `tests/js-profile.test.js` "confirm requires every preference (400), then succeeds and records provenance" | |
| Uploading a CV never grants consent and never starts sending | ✅ | `tests/js-consent.test.js` "eligibility requires confirmed profile AND search consent (CV upload alone is not enough)"; `tests/js-e2e.test.js` J1 | |
| Search starts only after a confirmed profile **and** search consent | ✅ | `modules/jobsearch/consentService.js` (`searchEligible`); `tests/js-matching.test.js` "matchCandidate: candidate without search consent / unconfirmed / paused -> [] and writes nothing"; `tests/js-sources.test.js` "candidate search uses the confirmed profile + preferences only, and only when eligible" | |
| Malware scan of uploads | 🔴 | `modules/jobsearch/scan.js`; `tests/js-profile.test.js` "scan hook: clean, infected (422, not stored) and unreachable scanner" (fake scanner) | Needs a ClamAV server (`CLAMAV_HOST`). Without it every CV is marked `scan_unavailable`, shown honestly, and **still usable and sendable**. Only `infected` blocks a CV. |

## 2. Real, permitted job sources

| Requirement | Status | Evidence | Notes / limits |
|---|---|---|---|
| Source adapters with honest status (`connected`, `requires_setup`, `unavailable`, `manual`); only `connected` returns jobs | ✅ | `modules/jobsearch/sources/`; `tests/js-sources.test.js` "unconfigured jobbank_ca / partner_feed report requires_setup; search throws SourceNotConnected", "runSearch on unconfigured sources inserts nothing and records requires_setup" | |
| Canada Job Bank official feed | 🔴 | `modules/jobsearch/sources/jobbankCa.js` | Needs an authorized feed URL in `JOBBANK_CA_FEED_URL`. Not set, so the source shows `requires_setup`. The adapter has never fetched a real Job Bank feed. It shares its feed reader with the partner feed adapter, which is tested with a stubbed network. |
| Approved partner feeds (JSON or RSS) | 🔴 | `modules/jobsearch/sources/partnerFeed.js`, `feedCommon.js`; `tests/js-sources.test.js` "partner_feed configured: parses JSON and RSS from approved URLs and stores real fetched jobs" (stubbed network) | Needs approved feed URLs in `PARTNER_FEED_URLS` and the partner's permission. |
| Manual import of a vacancy by staff | ✅ | `POST /jobsearch/jobs/manual`; `tests/js-sources.test.js` "GET /jobs filters and paginates; Candidate is refused; manual import is sanitised and idempotent"; J1 | Works today without any setup. |
| Test data source only in tests | ✅ | `modules/jobsearch/sources/index.js`; `tests/js-sources.test.js` "sources are seeded idempotently and test_fixture exists only under NODE_ENV=test" | |
| Feed safety: https only; private, loopback and link-local hosts refused; size cap; timeout; identifying User-Agent | ✅ | `modules/jobsearch/sources/http.js`; `tests/js-sources.test.js` "feed URLs: http, loopback, private, link-local, credentials rejected", "hostname resolving to a private address is refused…", "oversize responses are rejected…", "IPv6 / IPv4 reserved ranges are blocked" | DNS-rebinding gap: the host is checked when resolved, but the connection is not pinned to the checked address. Risk is low because only admin-configured URLs are fetched. |
| No scraping, no login or CAPTCHA bypass; 401/403 respected; 429 `Retry-After` honoured | ✅ | `tests/js-sources.test.js` "HTTP 429 surfaces Retry-After; 401/403 are not bypassed", "a 429 backoff honours Retry-After; auth/safety refusals are not retried" | There is no scraper in the code. Sources are feeds, staff entry, or nothing. |
| Same vacancy from several sources stored once (dedupe), each sighting kept | ✅ | `modules/jobsearch/jobStore.js`; `tests/js-jobs.test.js` "same vacancy from two sources -> one job, two sightings", "concurrent upserts of one vacancy create one row" | |
| Expired or closed jobs detected and never matched | ✅ | `tests/js-jobs.test.js` "closing date in the past -> expired; fetchDetail null -> closed; 404 -> closed; still there -> open"; `tests/js-scheduler.test.js` "expiry: a stale open job that is gone from its source closes its not-yet-approved applications" | |
| Per-source rate limit, retries with back-off, pause, run history | ✅ | `modules/jobsearch/searchRunner.js`; `tests/js-sources.test.js` "per-source rate limit is enforced…", "failing adapter is retried 3 times with exponential backoff…", "paused source is skipped; module pause does nothing" | |
| "Search now" button queues a search (does not run it inside the web request) | ✅ | `POST /jobsearch/search/run`; `tests/js-sources.test.js` "POST /search/run enqueues (202), runs nothing inline…" | |

## 3. Matching

| Requirement | Status | Evidence | Notes / limits |
|---|---|---|---|
| Score 0–100 with reasons, missing items and uncertain items | ✅ | `modules/jobsearch/matching/index.js`; `tests/js-matching.test.js` "scoreMatch: shape, range, no immigration-eligibility field…" | Rule-based. Matches below `MATCH_MIN_SCORE` (default 40) are not stored. |
| Unknowns stay "uncertain", never assumed (language, licence, salary) | ✅ | `tests/js-matching.test.js` "scoreMatch: French required and candidate has none…", "scoreMatch: licence requirement absent from confirmed certificates -> missing, never guessed", "salary: period read from the words next to the figure…" | |
| A score never states immigration eligibility | ✅ | `tests/js-matching.test.js` "scoreMatch: work-authorisation text lowers the auth component but is never an eligibility claim" | |
| Employer-support label (`confirmed`, `stated_in_ad`, `unknown`, `unavailable`) with the quoted ad text and a "verify with the employer" notice | 🟡 | `modules/jobsearch/matching/employerSupport.js`; `tests/js-matching.test.js` (label corpus, rounds 4–5) | Known detector gaps A and B (see limitations) can show `stated_in_ad` where the ad limits it. The label is informational only: automatic sending for a candidate who needs work-permit support abroad requires `confirmed` (a staff confirmation record). |
| Staff can confirm employer support (job or employer scope) and revoke it | ✅ | `POST /jobsearch/employer-confirmations`; `tests/js-matching.test.js` "POST /employer-confirmations: admin only, evidence required, upgrades label to confirmed, audited", "confirmations: job-scoped vs employer-wide, revoke reverts…" | |
| Overseas-applicant acceptance read only from explicit wording, with the quote | 🟡 | `tests/js-matching.test.js` "overseas: stays null without explicit wording; explicit yes/no carry a quote", "round 5: overseas true needs a clean unit…" | Conservative. It sometimes returns "unknown" for genuine ads, which sends the application to human review. |
| Job text treated as data (prompt-injection text has no effect) | ✅ | `tests/js-matching.test.js` "scoreMatch: injection text in the job does not change the score", "injection filter never hides a negative…"; J6 | |
| Matching uses open jobs only, in the consented and allowed countries | ✅ | `tests/js-matching.test.js` "matchCandidate: open jobs only, in allowed countries, sorted/stored…", "matchCandidate: respects allowed_countries from settings and consent countries" | |

## 4. CRM dashboard and candidate view

| Requirement | Status | Evidence | Notes / limits |
|---|---|---|---|
| Admin console at `/vita/admin.html`: dashboard, applications, review queues, interviews, sources, settings, reports, health, scheduler | 🟡 | `public/vita/admin.html`, `admin.js`; `tests/js-ui.test.js` (i18n, static XSS scan, headers) | Driven in a real browser during Task 15 (25 screenshots), but most write buttons were **not** clicked there, and there is no automated browser test. The APIs behind every button are tested. Some actions have **no button at all** and need the API: approving a CV version, manual job import, employer-support confirmation, creating staff/candidate accounts and CRM candidates, automation rules and the employer directory (limitation 19). |
| Dashboard per candidate: matches, preparing, ready for review, queued, submitted, replies, interviews, outcomes, items needing staff | ✅ | `GET /jobsearch/dashboard`; `tests/js-reports.test.js` "dashboard: totals equal independent counts…"; J1, J7 | |
| Filters: candidate, country, profession, staff, employer, source, status, date | ✅ | `tests/js-applications.test.js` "list filters return the correct subsets…"; `tests/js-reports.test.js`; J7 | In the UI the staff filter takes a numeric user id (there is no staff-list API), and the employer filter only lists employers already seen on loaded pages. |
| Candidate portal at `/vita/portal.html`: upload, review fields, preferences, consent, matches, applications, interviews, messages | 🟡 | `public/vita/portal.html`, `portal.js`; J1, J8 (APIs) | Browser-checked by hand in Task 15. Document sharing grant/revoke was not clicked in the browser. |
| Arabic (right-to-left), English and French | 🟡 | `public/vita/i18n.js`; `tests/js-ui.test.js` "i18n: ar/en/fr have identical key sets and no empty strings" | Machine-checked for completeness, not reviewed by a native speaker. No screen-reader test. No formal contrast audit. |
| Exact disclaimer in ar/en/fr in the candidate portal | ✅ | `tests/js-ui.test.js` "i18n: disclaimer exact in all three languages…"; J8 | |
| Staff see only candidates assigned to them; admins see all; candidates see only themselves (new module only) | ✅ | `modules/jobsearch/scope.js`; `tests/js-scope.test.js`; `tests/js-isolation.test.js` (matrix, SSE); J6 | Existing `/candidates` and `/documents` routes are **not** scoped (see limitations). |
| Candidate responses carry no staff-only fields (recipients, message ids, hashes, approver) | ✅ | J8 "disclaimer over HTTP + candidate-facing API responses carry no staff-only fields"; `tests/js-submit.test.js` "candidate GET /jobsearch/applications/:id after sent / failed / outcome_unknown shows no recipient…" | Residual: `POST /applications/:id/prepare` still returns the sha256 of the candidate's own documents to the candidate (deferred). |
| Live updates (server-sent events) filtered by scope | 🟡 | `GET /jobsearch/events`; `tests/js-isolation.test.js` "SSE live: X never receives C…", "SSE: Last-Event-ID replay obeys scope and audience…" | Server side tested. Live push into an open browser page was not observed. Events can be lost on a late commit; the UI refetches on connect, every 60 s and on tab focus. |

## 5. Truthful application preparation

| Requirement | Status | Evidence | Notes / limits |
|---|---|---|---|
| Cover letter built only from the confirmed profile and the job title/employer | ✅ | `modules/jobsearch/coverLetter.js`; `tests/js-applications.test.js` "cover letter: every capitalised word and number comes from the confirmed profile, the job or the fixed template" | Template-based, EN/FR/AR. No AI writing. |
| No claim of a permit, visa, eligibility or anything not in the profile | ✅ | `tests/js-applications.test.js` "cover letter never claims a permit, visa or eligibility…", "cover letter: hostile job title cannot inject a claim…" | |
| Approved CV version chosen by job language; original untouched | ✅ | `tests/js-applications.test.js` "prepare: letter from confirmed profile, approved CV in the job language, originals untouched", "CV language fallback is flagged language_mismatch…" | The CV version must first be approved by the candidate or a manager (API only, limitation 19). |
| Passport, ID, police certificate, medical (and any unknown document type) never sent without the candidate's own authorization for that one application | ✅ | `modules/jobsearch/documentPolicy.js`; `tests/js-applications.test.js` "document types are sensitive by default…", "sensitive documents: blocked without a candidate authorization…"; J5 | Staff cannot grant this for the candidate. Sensitive documents are never in an automatically approved package. |
| Package re-checked before sending (CV un-approved, file changed, document deleted, authorization revoked) | ✅ | `tests/js-guard.test.js` "package_changed: …", "document_unapproved: …"; `tests/js-applications.test.js` "CV bytes or recorded sha256 changed after packaging…" | |
| Questions the system cannot answer truthfully go to staff, never guessed | ✅ | `modules/jobsearch/handoffDetector.js`; `tests/js-guard.test.js` "handoff flags in the posting (captcha, payment, login, legal declaration, custom questions) stop the send" | Detection is phrase-based; some wordings are missed or over-flagged (deferred list). |
| AI-written letters / answers (LLM) | ⚪ | — | Not built. No AI model is called anywhere. See SOURCES_AND_PROVIDERS.md. |

## 6. Three operating modes and consent

| Requirement | Status | Evidence | Notes / limits |
|---|---|---|---|
| Mode `search_only`: matches only, no applications, no mail | ✅ | `tests/js-scheduler.test.js` "search_only: tick searches + matches, ZERO applications, ZERO mails" | Default mode for every candidate. |
| Mode `prepare_for_approval`: applications prepared, a manager or admin approves each one | ✅ | `tests/js-scheduler.test.js` "prepare_for_approval: application ready_for_review…, ZERO mails…"; J1 | |
| Mode `automatic`: sends only inside consent, admin rules and caps | 🟡 | `modules/jobsearch/applicationService.js` (`autoApproveEligibility`); `tests/js-applications.test.js` "autoApprove enforces the admin scope, caps and package…"; `tests/js-scheduler.test.js` "automatic + consent + admin rules + CONFIRMED employer support…"; J2 | Tested. But two things it needs have **no screen or API yet**: the automation rule (`js_automation_rules`) and the employer's verified domain / contact address (`js_employers`). An admin must insert them with SQL (see SETUP.md). |
| Consent per scope (search, prepare, submit), versioned, with history | ✅ | `tests/js-consent.test.js` "consent persists version, scope and timestamp; new grant supersedes and keeps history" | |
| Staff can record written consent only with who recorded it and an evidence note | ✅ | `tests/js-consent.test.js` "staff records written consent only with recordedBy and evidenceNote…" | |
| Withdrawing consent cancels queued and approved work in the same transaction | ✅ | `tests/js-consent.test.js` "withdraw cancels queued+approved applications and queue items…"; `tests/js-submit.test.js` "consent withdrawn after queueing (real withdrawal)… zero mails…"; J3 | If the e-mail is already being handed to the provider at that exact moment, it may still go (tested: "consent withdrawn WHILE the provider call runs…"). |
| Only an admin can turn on automatic mode, caps and allowed countries/professions/sources | ✅ | `tests/js-consent.test.js` "settings: default mode, candidate cannot set automatic (403), role matrix, scope isolation" | |
| Daily/weekly caps; default 0 = no automatic sends | ✅ | `tests/js-guard.test.js` "cap_exceeded: per-day boundary, rolling 7-day week, cap 0"; `tests/js-scheduler.test.js` "caps: cap_per_day=1 with two eligible matches -> one mail…" | |
| Candidate, source and whole-module pause; paused sends are held and resume once | ✅ | `tests/js-scheduler.test.js` "pause -> resume (…): held application re-queued exactly once and sent exactly once"; `tests/js-consent.test.js` "module pause (admin only) makes everyone ineligible"; J3 | |

## 7. Submission through supported channels

| Requirement | Status | Evidence | Notes / limits |
|---|---|---|---|
| Supported channel: e-mail to the employer | ✅ (sandbox) | `modules/jobsearch/channels/email.js`, `submitter.js`; `tests/js-submit.test.js` "happy path: exactly one mail…" | Only e-mail is supported. Portals, online forms, logins, CAPTCHAs, payments and declarations go to staff as tasks (`channels/unsupported.js`). |
| Recipient check: automatic sends only to the employer's verified contact or its exact domain; a human approver may use the address named in the ad | ✅ | `modules/jobsearch/guard.js` (`verifyRecipient`); `tests/js-guard.test.js` "verifyRecipient: exact employer domain or exact posted/verified address; lookalikes, subdomains and free-mail rejected", "recipient under automatic approval: an address only the ad names -> recipient_unverified…"; J2 | |
| Real e-mail delivery | 🔴 | `modules/jobsearch/mail/imapSmtp.js`; `tests/js-mail.test.js` "imapSmtp refuses to send unless MAIL_REAL_SEND=true" | Needs SMTP credentials, `MAIL_PROVIDER=imap_smtp` and `MAIL_REAL_SEND=true`. **No real e-mail has ever been sent by this module.** In this build the SMTP adapter also requires the three `MAIL_IMAP_*` variables to be set before it will send, although IMAP is not used. |
| One check before every send, also on retries (consent, pauses, job still open, duplicates, fields, documents, recipient, caps) | ✅ | `modules/jobsearch/guard.js`; `tests/js-guard.test.js` (one test per refusal reason), "the guard never mutates state…" | |
| Exactly one e-mail per application, also under retries and concurrency | ✅ | `tests/js-submit.test.js` "double queueSubmission + double handleSubmit -> one submission row, one queue item, exactly one mail", "concurrent handleSubmit x3 on the same item -> exactly one mail"; J4 | |
| Uncertain delivery becomes `outcome_unknown` and is never retried automatically | ✅ | `tests/js-submit.test.js` "provider throws (timeout) after the intent was persisted -> outcome_unknown…never retried"; J4 | Staff must resolve it (runbook in SETUP.md). |
| "Confirmed submitted" only with stored evidence | ✅ | `submitter.recordEvidence`; `tests/js-submit.test.js` "recordEvidence: staff delivery_receipt -> 400…", "recordEvidence employer_acknowledgement…" | Evidence = provider delivery receipt (via webhook), employer acknowledgement confirmed by staff, or a manager's manual confirmation with a note. |
| Staff can record an application they completed by hand | ✅ | `POST /jobsearch/applications/:id/manual-completion`; `tests/js-submit.test.js` "manual completion: needs_staff -> sent only with evidence + approver…" | |
| Automatic submission on job portals / websites | ⚪ | — | Not built, by design. Not every job website accepts automatic applications; this module does not automate any website. |

## 8. Replies, interviews and calendar

| Requirement | Status | Evidence | Notes / limits |
|---|---|---|---|
| Inbound mail through a signed webhook (`POST /jobsearch/inbound/mail`, HMAC) | ✅ | `routes/jobsearchInbox.js`; `tests/js-inbox.test.js` "webhook: HMAC missing/invalid -> 401; valid -> stored; replay -> one row; oversize -> 413; bad JSON -> 400" | Code tested. In production it needs a mail bridge the owner sets up (🔴, see SOURCES_AND_PROVIDERS.md). |
| Reading a mailbox by IMAP | ⚪ | `modules/jobsearch/mail/imapSmtp.js` (`poll` throws `NOT_IMPLEMENTED`); `tests/js-inbox.test.js` "imapSmtp.status() is honest…" | Not implemented. Use the webhook. |
| Replies matched only by Message-ID / In-Reply-To / reply token and sender domain; anything uncertain goes to a review queue | ✅ | `modules/jobsearch/replyMatcher.js`; `tests/js-inbox.test.js` "forged In-Reply-To from another domain -> needs_review…", "no references and no token -> needs_review (never by name/subject similarity)" | |
| Sender authentication (DKIM/DMARC results from the bridge) required for automatic matching | ✅ | `tests/js-inbox.test.js` "I2: auth evaluation fails closed…", "I2 round 2: … INBOUND_AUTHSERV_ID" | Only as good as the bridge: it must pass your own receiving server's results and strip sender-supplied ones. |
| Employer acknowledgement confirms a submission only after a staff click (default) | ✅ | `tests/js-inbox.test.js` "round 4: INBOUND_AUTO_ACK_EVIDENCE defaults to false in every environment…", "round 4 confirm endpoint: …" | `INBOUND_AUTO_ACK_EVIDENCE=true` turns on automatic evidence. That option accepts a known risk of false confirmations. |
| Bounces never change a status; they open a staff task | ✅ | `tests/js-inbox.test.js` "bounce (round 2): a plausible DSN only opens a staff task + staff event…" | |
| Hostile reply text cannot change anything; classification only proposes | ✅ | `tests/js-inbox.test.js` "injection reply changes nothing…", "classifyReply is deterministic EN/FR and only proposes"; J6 | |
| Reply drafts need approval (except an enabled acknowledgement rule) | ✅ | `tests/js-inbox.test.js` "follow-up: draft needs approval…", "ack_reply automation rule: auto-acknowledgement once per thread per 24h…" | Drafts and summaries are fixed templates (EN/FR; AR falls back to EN with a note). |
| Interview: tentative appointment with an explicit time zone; confirmed only after the candidate confirms availability; no double booking | ✅ | `modules/jobsearch/calendar.js`, `interviewService.js`; `tests/js-calendar.test.js`; `tests/js-inbox.test.js` "interview: tentative with explicit tz…", "I3: reschedule is one transaction…" | Internal calendar only. |
| Sync with Google/Outlook calendars, invitations to the employer | ⚪ | — | Not built. |

## 9. Controls, reporting, audit and private storage

| Requirement | Status | Evidence | Notes / limits |
|---|---|---|---|
| Reports from real records by period, candidate, country, staff, profession, employer, source, status | ✅ | `modules/jobsearch/reportService.js`; `tests/js-reports.test.js` "reports: totals equal independent COUNT(*)s…", "reports: every groupBy variant adds up to the same totals…"; J7 | |
| Health view: source failures, queue, stuck items, open tasks (no secrets) | ✅ | `GET /jobsearch/health`; `tests/js-reports.test.js` "health: staff (Agent/Receptionist), Candidate, Accountant 403; Manager and Admin 200…" | |
| CSV exports: scope-filtered, spreadsheet-formula-safe, audited, rate-limited | ✅ | `GET /jobsearch/export.csv`; `tests/js-reports.test.js` "csvCell: formula triggers… neutralised…", "export.csv: headers, scope-filtered rows equal SQL counts…" | |
| Audit trail for consent, approvals, sharing, submissions, evidence, pauses, suspensions, exports, scheduler | ✅ | `audit_logs` + insert-only `js_audit_events`, `js_timeline`; `tests/js-reports.test.js` "audit: …" (6 tests); `tests/js-schema.test.js` "js_timeline update and delete raise; insert works" | |
| Private file storage outside the web root; short-lived signed links checked again on every request | ✅ | `modules/jobsearch/storage/`; `tests/js-storage.test.js` "signed URL verifies; tampered and expired return null", "path traversal keys are rejected"; `tests/js-profile.test.js` "signed file link: …" | Files are on local disk under `STORAGE_DIR`. Backups are the owner's job (SETUP.md). |
| Suspending a user cancels their work and ends candidate sessions | ✅ | `POST /jobsearch/admin/users/:id/suspend`; `tests/js-consent.test.js` "admin suspend cancels work, revokes sessions, audits; reinstate resurrects nothing" | Staff tokens from `/auth/login` cannot be revoked before they expire (7 days). |
| Pause module / source / candidate; scheduler status and manual tick | ✅ | `tests/js-scheduler.test.js` "admin endpoints: POST /jobsearch/scheduler/tick (admin only) and GET /jobsearch/scheduler/status", "module paused: tick does nothing…" | |
| Background scheduler runs in one process at a time | ✅ | `modules/jobsearch/scheduler.js` (`guardedTick`); `tests/js-scheduler.test.js` "re-entrancy: … guardedTick skips while another session holds the advisory lock" | Needs direct or session-pooled Postgres connections (not PgBouncer transaction mode). |
| Secrets only in environment variables; `.env.example` lists every variable | ✅ | `trust-crm/.env.example` (checked against every `process.env.*` read in the code, see Checks run) | `trust-crm/.env` was in git history (rotate, see limitations). |
| HTTPS, domain, firewall, backups in production | 🔴 | SETUP.md | Owner's server work. Nothing is deployed. |

## 10. Verification

| Requirement | Status | Evidence | Notes / limits |
|---|---|---|---|
| Full journey tested end to end on real Postgres with sandbox mail | ✅ | `tests/js-e2e.test.js` J1–J8 | CV → consent → search → match → prepare → approve → send (sandbox) → reply → confirmation → interview → reports. |
| Isolation between staff, candidates and other roles | ✅ | `tests/js-isolation.test.js`; J6 | |
| Duplicate listings and duplicate submissions | ✅ | `tests/js-jobs.test.js`, `tests/js-guard.test.js`, `tests/js-submit.test.js`; J4 | |
| Consent withdrawal, expired jobs, unavailable sources, failed and uncertain delivery, sensitive documents, hand-offs, reply mismatch, time zones, report numbers, OTP limits, prompt injection | ✅ | see sections above; J3, J4, J5, J6, J7 | |
| Migrations from scratch and on an existing database with data | ✅ | `scripts/verify-migrations.js`; `tests/verify-migrations.test.js` | See Checks run. |
| Real sources, real mail, real mailbox, ClamAV, browser live updates, screen reader | ⚪ | — | Not covered by tests (see below). |
| Continuous integration runs these tests | 🔴 | — (this branch has no `.github/workflows`) | Per the ledger, the CI check on PR #6 comes from a "Deno" workflow the owner added on `main`; it runs a Deno linter, fails on `main` too, and does not run `npm test`. A Node workflow was proposed in a PR comment but not applied. Not re-verified here (that commit is not in the local clone). |

---

## Known limitations and residual risks

| # | Limitation / risk | Impact | What to do |
|---|---|---|---|
| 1 | **Employer-support label gaps A and B** (parked, cleanup batch 8b). A: a limit written after a blank line ("We offer visa sponsorship." … "Note: this applies to our Toronto location only.") is missed. B: an LMIA the candidate must already hold, listed as "asset" / "nice to have" / "atout", can be read as employer support. | Staff may see "stated in ad" on an ad that limits sponsorship. | Never decisive: automatic sending for a candidate needing support abroad requires a staff `confirmed` record. Staff must read the quoted text. |
| 2 | **`INBOUND_AUTO_ACK_EVIDENCE=true` is risk-accepting.** The classifier still has known false accepts (e.g. text after the sign-off). | A cleverly worded rejection could mark a submission "confirmed". | Keep the default `false`. Staff confirm acknowledgements by clicking. |
| 3 | **Staff tokens are not revocable.** Tokens from `/auth/login` carry no version claim and last 7 days. Suspending a staff user blocks new logins but not an existing token. | A suspended staff member keeps API access for up to 7 days. | Rotate `JWT_SECRET` to log everyone out at once (this also ends all candidate sessions). |
| 4 | **`/auth/register` accepts the role `Candidate`.** Such a user gets a token that is refused (no version claim) and has no candidate link. | Confusing but harmless. | Create candidate accounts only through `POST /jobsearch/admin/candidate-accounts`. |
| 5 | **Existing `/candidates` and `/documents` routes are not scoped.** Any Agent/Manager/Receptionist sees every candidate there (unchanged from before this module). | Staff scoping applies to the new module only. | Decide on scoping for those routes separately. |
| 6 | **Rate limiters are in memory, per process** (OTP, uploads, inbound webhook, exports). | Limits reset on restart and are not shared between processes. Behind a proxy they need `TRUST_PROXY`. | Run one app process, set `TRUST_PROXY`, and add gateway rate limiting. |
| 7 | **Advisory locks need session-level connections.** The scheduler and the sender use Postgres session advisory locks. | PgBouncer in transaction mode would break the "one sender / one scheduler" guarantee. | Connect directly or with session pooling. |
| 8 | **Live events can be missed** when a transaction commits late. | A screen may lag. | The UI refetches on connect, every 60 s and on tab focus. |
| 9 | **Caps default to 0**: no automatic sends happen until an admin sets daily/weekly caps above 0. | Automatic mode looks "on" but sends nothing. | Intended. Set caps per candidate. |
| 10 | **IMAP polling is not implemented.** Replies arrive only through the signed webhook. | No replies are seen until a bridge is set up. | See SOURCES_AND_PROVIDERS.md. |
| 11 | **Malware scan is `scan_unavailable` without ClamAV**, and such CVs are still usable and sendable. | An infected CV could be forwarded to an employer. | Connect ClamAV before real use. |
| 12 | **DNS-rebinding gap in the feed fetcher.** | A malicious feed host could switch IP between check and fetch. | Only add feed URLs you trust. |
| 13 | **Test flake history.** Full-suite flakes were seen during development (shared advisory-lock key across test schemas; a 1-in-16 tamper test; clock mixing). All were fixed in Task 16 and the suite passed 5 times in a row then; one more run is recorded below. | A rare timing flake may still exist. | Re-run once before treating a single failure as a regression. |
| 14 | **`trust-crm/.env` was committed in git history** (DB host/user/password/name/port and `JWT_SECRET`). It was removed from the index in commit `3833848`, but it remains in history. | Anyone with the repository can read those values. | Treat them as public: use a new `JWT_SECRET` and new database credentials on any real server. |
| 15 | **Automation rules and the employer directory have no API or screen.** | Automatic mode needs SQL by an admin. | See SETUP.md "Automatic mode". |
| 16 | **Delivery receipts are trusted from the signed webhook.** A signed `delivery_status` event with `action: delivered` marks a submission confirmed. | A misconfigured bridge could confirm a submission falsely. | The bridge must forward only genuine provider delivery events. Keep the webhook secret private. |
| 17 | **Bootstrap SuperAdmin has no password-strength check.** | A weak first password is possible. | Follow the password guidance in SETUP.md. |
| 18 | **Single local storage disk.** | Files are lost with the server unless backed up. | Back up `STORAGE_DIR` with the database. |
| 19 | **Some required steps have no screen.** Approving a CV version (`POST /jobsearch/cv-files/:id/approve` with a `language`) has no button in the portal or the admin console, yet preparation needs an approved CV. Also API-only: manual job import, employer-support confirmation, creating accounts and CRM candidates; SQL-only: automation rules and employer domain/contact. | Staff using only the web pages cannot get an application past "preparing". | Use the API calls in SETUP.md / USER_GUIDE.md until buttons are added. |

### Not covered by tests

- Real job sources (Job Bank or any partner feed): only stubbed network responses are tested.
- Real e-mail delivery through SMTP: only the sandbox adapter and the "refuses without `MAIL_REAL_SEND`" path are tested.
- A real inbound mail bridge and real DKIM/DMARC results from a real mail server.
- Real IMAP (not implemented).
- A real ClamAV server (a fake scanner is used).
- Live server-sent events pushed into an open browser page; reconnect in a browser.
- Screen reader use, formal colour-contrast audit, printing.
- Most admin write buttons in a browser (their APIs are tested); Manager/Agent/Receptionist views in a browser.
- Load and performance beyond the bounded-input tests.

### Deferred cleanup batch 8b

Copied from the ledger (`.superpowers/sdd/2026-10-22-vita-ai-job-search/progress.md`). None of these allow an automatic send that the rules forbid; most are wording-detection quality or tidy-ups. Items already fixed later are marked.

**Employer-support label (Task 8)**
- Gap A: a limit or qualifier after a blank line ("Note: this applies to our Toronto location only.").
- Gap B: an approved/positive LMIA held by the candidate listed as "asset" / "nice to have" / "atout".
- Scope given in label lines ("Type d'emploi : temps partiel"); conditions ("should you meet…", "en fonction de votre profil"); cost wording (IRCC filing amount, débours); the government-fee rule is too broad ("employer covers government fees" is vetoed).
- Natural positive phrasings recognised about 72% (6 of 36 missed, e.g. "The family will apply for an LMIA", "Notre résidence offre le parrainage").
- `_setDebugHook` exported from production code (`matching/employerSupport.js`); a DELETE-lock test is not session-scoped.

**Document types (Task 9)**
- "CV + test results" is classified safe (should be limited to language-test context).
- Ordinary names containing person or employer words fail closed (acceptable).
- The `SENSITIVE_TYPES` export lacks the newer classes.

**Hand-off detector (Task 10)**
- Anti-scam wording ("candidates do not pay any fee") is flagged as payment.
- "will sign an employment agreement" is flagged as a legal declaration.
- Missed: CAPTCHA variants (real person / puzzle / anti-robot), payments for purchases from the employer, some "online portal only" phrasings.
- The middle of ads over 40k characters is only sampled for channel/question cues.
- Lower-cased local part of addresses.
- Human approver did not see the recipient: addressed in Task 15 by `GET /jobsearch/applications/:id/recipient`.

**Submission (Task 11)**
- `documents[].sha256` visible to the candidate: fixed in Task 16 for `GET /applications/:id`; still returned by `POST /applications/:id/prepare` (own documents only).
- Staff-written reason/note text is visible to the candidate when it contains no "@", "<" or hex.
- `employer_acknowledgement` accepts a sender equal to the submission recipient even when that address came from the ad.
- No test for a `system:auto` approval surviving a pause hold.

**Scheduler (Task 12)**
- One `scheduler_match:<candidate>` state row per candidate accumulates.
- The match signature includes the latest job re-check time, so every re-check re-matches all candidates.
- A user-requested search blocks the scheduled search for the same pair in that window.
- The `js-profile` "signed file link" flake: fixed in Task 16.

**UI (Task 15)**
- Employer filter lists only employers seen on loaded pages; staff filter is a numeric id.

**End-to-end tests (Task 16)**
- Guard duplicate window still uses the Node clock in one place; rolling-deploy lock-key difference; a test title in `js-submit.test.js` (line ~369); J7 country-filter assertion is weak; a conditional assert in `js-e2e.test.js` (~line 214); J6/J8 reuse the J1 world.
- Stale `t_*` test schemas from interrupted runs need a cleanup script.

**Other deferred minors (Tasks 1–7, 13)**
- `loadApp` test helper leaves the db proxy on a closed pool; migration 001 drops any users CHECK containing "role"; `pdf-parse` 2.x engine range may constrain the Node version.
- Schema tests do not re-run 002 or test every enum value.
- Signed-URL tests do not tamper key/expiry; calendar has no integer validation.
- OTP: 415/403 branches of the body-error handler untested; code issuance is fire-and-forget (lost on shutdown); no daily per-email failure cap across codes.
- CV extraction: worker memory limits do not cover off-heap buffers; the zip check uses the last end-of-directory signature; the lying-header zip case has no committed test.
- Consent: no self-suspend guard for admins; staff may unpause a pause the candidate set.
- Sources: per-minute idempotency key matches finished items; a run row can stay unfinished on an unexpected error; withdrawing any consent scope cancels pending search items; DNS rebinding (see limitation 12).
- Inbox: four genuine replies are refused by the strict acknowledgement rules; HTML-only quoted replies are not eligible; crossing reschedules both get 409; `inbox.pollAndStore` is not wired (webhook only).

---

## Completion statement

The code for this module is written and its automated tests pass (see Checks run). That does **not**
make it complete for production. It must not be marked complete for production until the owner has done
the items marked 🔴 above:

1. Connected at least one authorized job source (Job Bank feed URL after checking its terms, or a partner
   feed with the partner's agreement). Until then, only jobs that staff enter by hand exist.
2. Set up real outgoing mail (SMTP) and the inbound mail bridge, and tested them with an address the owner
   controls.
3. Connected ClamAV.
4. Deployed behind HTTPS with new secrets, backups and the security checklist in SETUP.md.
5. Set up CI that runs `npm test`.

**About automatic applications.** This module does **not** apply automatically on job websites, and many
job websites do not accept automatic applications at all. The only channel it can send through is
**e-mail to the employer**:

- In automatic mode, only to the employer's staff-verified contact address or an address at the
  employer's exact verified domain (never free-mail, subdomains or lookalikes).
- With human approval, also to the single address named in the ad, shown to the approver first.

Everything else goes to a staff member as a task: an online portal or form, a login, a CAPTCHA, a payment,
a legal declaration, a custom question, or an address that cannot be verified. Staff complete those by hand
and record what they did.

Scores and labels never establish immigration eligibility. The service does not guarantee employment,
employer sponsorship, a work permit or a visa.

---

## Checks run

Run on 2026-10-23 (UTC) in the development container: Node 22.22.0, PostgreSQL 16.15, branch
`claude/adoring-mendel-yrxr43`, base commit `77c09ef` plus this task's changes (the docs commit that adds
this file). Database: a local `trustcrm_test` database; every test and check uses its own throwaway schema.

| Check | Command | Result |
|---|---|---|
| Full test suite | `TEST_DATABASE_URL=postgres://…/trustcrm_test npm test` | **449 tests, 449 pass, 0 fail**, 0 skipped (≈98 s). Before this task's two new test files: 443/443. |
| Migrations from scratch | `node scripts/verify-migrations.js` | `OK from scratch: 10 migrations applied, 28 js_* tables, second run applied 0` |
| Migrations on existing data | same script | `OK on existing data: 10 migrations applied, original rows unchanged (users=3 candidates=3 visa_applications=1 documents=2 invoices=1 payments=1 expenses=1 notifications=1 audit_logs=1), second run applied 0`. Every original column value of every sample row was compared before and after. `tests/verify-migrations.test.js` also proves the check fails when a migration rewrites a candidate row. |
| Committed key/env files | `git ls-files \| grep -E '\.(env\|pem\|key)$'` | No output (exit 1). `trust-crm/.env.example` is the only tracked env-like file (placeholders only). |
| `.env` in history | `git log --oneline --all -- trust-crm/.env` | Committed in `cac5abc` and `1f798cc`; removed from the index in `3833848`. **Still in git history** with `PORT`, `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`, `JWT_SECRET`. Rotate (limitation 14). |
| Secret patterns in tracked files | `git ls-files \| xargs grep -lInE '(BEGIN … PRIVATE KEY\|AKIA…\|sk-…\|xox[baprs]-\|ghp_…)'` and a password/secret assignment pattern | No matches. |
| Real e-mail addresses in tracked files | grep for free-mail domains | Only test fixtures (e.g. `northwind.hr@gmail.com` used to prove free-mail senders are rejected) and the owner's chosen admin address in the design spec and plan. No customer data. |
| Every env variable the code reads is in `.env.example` | loop over `grep -rhoE 'process\.env\.[A-Z0-9_]+'` (60 names, plus names read via `process.env[name]`) | All present (`HOME`/`PATH` excluded: only read by `tests/js-seed.test.js`). |

Not run here: anything against a real job feed, a real SMTP server, a real mail bridge, ClamAV or a
deployed HTTPS server (none is configured).
