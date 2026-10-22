# VITA — AI Job Search & Applications (البحث الآلي عن عمل) — Design

Status: approved in conversation 2026-10-22; pending written-spec review.
Code location: `trust-crm/` (Node 18+/Express/Postgres). Additive only; existing tables, routes and data are untouched.

## 1. Goal and success criteria

After a candidate's CV is uploaded, confirmed and consented, the module searches **real, permitted** job sources, scores matches with explainable reasons, prepares truthful applications, submits only within recorded consent and admin rules, tracks replies and interviews, and reports from real records.

Done means (not "screens exist"):
- The full journey is exercised by automated tests against real Postgres with sandbox adapters/recipients: CV upload → extraction → profile confirmation → consent → search → match → prepare → approve/auto-submit → reply tracking → interview scheduling.
- Each requirement is marked completed / tested / blocked in `docs/vita-job-search/CHECKLIST.md`.
- No fake jobs are shown as live; no success is shown without evidence.

Hard rules: uploading a CV never authorizes sending; no invented qualifications, experience, language ability, certificates, references or work authorization; no CAPTCHA/restriction bypass; no automatic sending of passports/IDs/police/medical documents; CV, job and email text are untrusted data and never instructions; scores never establish immigration eligibility.

## 2. Assumptions and scope decisions

- Repo has no candidate portal, mailbox, calendar, file storage, realtime or staff scoping; minimal versions are built inside this module (option A).
- Existing `/candidates`, `/documents` routes unchanged; staff scoping applies to the new module only. Their lack of scoping is recorded in the checklist as a separate risk.
- Brand VITA (navy/light blue/gold, logo supplied by the user) is used in this module's UI, printables and candidate messages. Existing API metadata/EMNA references stay.
- First SuperAdmin email: `alouimohamed19840@gmail.com`, created via existing `/auth/bootstrap-super-admin` by the owner. No password is seeded.
- First live source target: Canada Job Bank (official feed) plus a generic approved partner feed adapter; both show `requires_setup` until credentials/URLs are provided.
- Deterministic extraction/letter generation is the default; an LLM implementation plugs into the same interfaces when a key is configured and may only restate CV fields.

## 3. Foundations

- **Migrations:** `trust-crm/sql/migrations/NNN_*.sql` + `schema_migrations` table + `scripts/migrate.js`. Additive, idempotent, transactional. `sql/schema.sql` unchanged.
- **Roles/auth:** new `Candidate` role (extends the `users.role` check by migration) linked via `js_candidate_accounts(user_id, candidate_id)`. Email-OTP login: hashed OTP, 10-min expiry, single use, resend cooldown, attempt limit, per-IP/email rate limit, never logged. Revoking/suspending a user invalidates sessions (token version check).
- **Scope module** (`modules/jobsearch/scope.js`): every new-module query takes a scope. Candidate → own candidate id only; staff roles (Agent, Manager, Receptionist) → `candidates.assigned_to = user.id`; Admin/SuperAdmin → all. Enforced in SQL (WHERE), not in UI; used by APIs, search, exports, file download and realtime events.
- **Storage:** interface `put/get/signedUrl/delete`; local-disk implementation under `STORAGE_DIR` (outside any served path). Files stored by content hash; MIME sniffed from content; size limits; short-lived HMAC-signed download links re-authorized on every request.
- **Mail adapter:** `sandbox` (default; records to DB, allow-listed recipients only) and `imap_smtp` (shows `requires_setup` without credentials). Real sending requires `MAIL_REAL_SEND=true` plus an allow-list or explicit approval.
- **Calendar:** `js_appointments` (tz-aware timestamptz, status tentative/confirmed/cancelled, overlap exclusion constraint per staff).
- **Events:** `js_events` outbox + SSE endpoint filtered by scope.
- **Jobs runner:** node-cron + DB-backed `js_job_queue` (SKIP LOCKED, retries with backoff, idempotency keys). Started from `server.js` next to the existing alert scheduler.

## 4. Data model (all prefixed `js_`)

- `js_profiles` (candidate_id, extracted jsonb, confirmed jsonb, field provenance, status extracted/confirmed, confirmed_by/at)
- `js_cv_files` (candidate_id, storage key, sha256, version, language, approved bool, original flag; originals are never mutated)
- `js_preferences` (countries[], categories[], availability, salary min/currency, residence_country, needs_work_auth_support)
- `js_consents` (candidate_id, scope jsonb, version, granted_at, withdrawn_at, granted_by)
- `js_candidate_settings` (mode `search_only|prepare_for_approval|automatic`, paused, caps/day, caps/week, allowed countries/professions/sources, approved doc versions, salary limit, admin_approved_by)
- `js_sources` (key, adapter, status `connected|requires_setup|unavailable|manual`, schedule cron, rate limit, paused, last_error, last_run_at)
- `js_jobs` (canonical: url, source_primary, employer_id, title, location, country, published_at, last_checked_at, closing_at, status open/expired/closed, dedupe_key unique, description_text sanitized)
- `js_job_sightings` (job_id, source_id, source_job_id, url, seen_at; unique source+source_job_id)
- `js_employers` (name, normalized_name, domain, verified_contact_email/endpoint)
- `js_matches` (candidate_id, job_id unique, score, reasons, missing, uncertain, employer_support label `confirmed|stated_in_ad|unknown|unavailable` + evidence_text, overseas_applicants evidence)
- `js_applications` (candidate_id, job_id, UNIQUE(candidate_id, job_id), status, mode_at_creation, responsible_user_id, cover_letter_id, channel)
- `js_application_documents` (application_id, cv_file_id/doc id, version, approved_by/at, sensitive bool, sharing_authorization_id)
- `js_sharing_authorizations` (candidate_id, document id, application_id, legitimate_need, granted_by candidate, granted_at, revoked_at)
- `js_submissions` (application_id, attempt_no, idempotency_key unique, channel, recipient, provider_message_id, status, evidence jsonb, sent_at, confirmed_at)
- `js_messages` (direction, thread refs, message_id, application_id nullable, match_confidence, review_state, body_sanitized, ai_summary, draft_reply)
- `js_tasks` (application_id, reason `captcha|payment|login|legal_declaration|unconfirmed_answer|review|unmatched_reply|...`, assigned_to, status)
- `js_timeline` (application_id, actor, event, detail, created_at; insert-only)
- `js_runs` (source_id, started/finished, found, new, errors)
- `js_audit` reuses `audit_logs` via `logAudit` (extended action names); consent/approval/sharing/submission/cancellation always logged.

## 5. Source adapters

Contract: `describe()` (name, terms URL, rate limit, required credentials), `status()`, `search(query, ctx)`, `fetchDetail(id)`. Adapters: `jobbank_ca` (official feed, requires_setup until configured), `partner_feed` (generic JSON/RSS from admin-configured approved URL), `manual_import` (staff paste/upload), `test_fixture` (loadable only when `NODE_ENV=test`). Runner enforces per-source rate limit, backoff, pause flags, and records failures in `js_runs`. Closed/expired detection on re-check; dedupe via normalized (employer, title, location, posting-date-bucket) + URL canonicalization; multiple sightings attach to one job.

## 6. Matching

Rule-based, explainable. Inputs: profession/skills overlap, required vs. confirmed experience, language requirements vs. confirmed languages, destination preference, salary (if stated), licensing requirement, overseas acceptance, work-authorization text. Output: score 0–100, reasons[], missing[], uncertain[]. Unknowns are `uncertain`, never assumed. Employer support label requires quoted evidence; absent evidence → `unknown`. Canada: vacancy ≠ willingness to hire from abroad; UI states an ad is not proof of LMIA/sponsorship/visa. Job text is sanitized and passed only as data.

## 7. Applications, modes and submission

State machine (enforced in code + DB CHECK/transition table): `matched → preparing → ready_for_review → approved → queued → sent → confirmed_submitted`; side states `failed`, `outcome_unknown`, `needs_staff`, `cancelled`, `closed`, `interview`, `offer`, `rejected`.

- **Modes:** search_only creates matches only; prepare_for_approval requires approval by an authorized user; automatic submits only within consent scope + admin-approved rules + caps.
- **Preparation:** truthful cover letter from confirmed profile only; picks approved CV version by language; originals preserved; package contains only required and authorized documents. Sensitive types blocked unless a `js_sharing_authorizations` row exists for that application.
- **Pre-send guard (single function, always run, including on retry):** consent active and in scope; candidate/module/source not paused or suspended; job still open (re-fetch); no duplicate application/submission; required fields present; documents approved; recipient domain/endpoint verified against employer record; caps not exceeded. Any failure → no send, task or cancel with reason.
- **Handoffs:** CAPTCHA, payment, unsupported login, legal declaration, or unconfirmed answer → `needs_staff` + task. Never guessed or signed.
- **Retry safety:** idempotency key `application_id:attempt_group`; DB unique; provider call recorded before/after; uncertain delivery → `outcome_unknown`, not retried blindly.
- **Evidence:** `confirmed_submitted` only with stored evidence (provider message id + delivery receipt, or employer acknowledgement linked). Otherwise `sent`/`outcome_unknown`.
- **Consent withdrawal / suspension:** transaction cancels all queued/approved-unsent items, logs it, emits events.

## 8. Replies, interviews, reporting

- Inbound mail matched by Message-ID/In-Reply-To/References and verified identifiers (application token in Reply-To/subject); anything uncertain → review queue (`js_messages.review_state='needs_review'`), never attached. Bodies sanitized; attachments not auto-opened.
- AI summaries/drafts stored as drafts; outgoing follow-ups require approval unless a specifically enabled rule exists.
- Interview requests create tentative `js_appointments` with explicit timezone; confirmation requires candidate availability confirmation.
- Reports (live SQL on real tables, scope-filtered): opportunities found, applications prepared/submitted/failed, replies, interviews, offers by period, candidate, country, staff, source, status. Health: source failures, queue depth, awaiting-human items. Module/source/candidate pause–resume.
- Exports respect scope.

## 9. API and UI

- REST under `/jobsearch/*` (profile, consent, preferences, settings, sources, jobs, matches, applications, tasks, messages, reports, SSE `/jobsearch/events`).
- Static minimal UI served at `/vita/` (admin dashboard + candidate portal), Arabic (RTL)/English/French, mobile-friendly, VITA branding. Candidate portal shows the required disclaimer in ar/en/fr: "This service helps you search and apply for job opportunities. It does not guarantee employment, employer sponsorship, a work permit or a visa."
- Dashboard sections per candidate: matches, preparing, ready for review, queued, submitted, replies, interviews, offers/rejections/closed, staff-attention items; filters by candidate, country, profession, staff, employer, source, status, date.

## 10. Security

Private storage; secrets only in env (`.env.example` updated, no secrets committed); input validation; rate limits on OTP and uploads; upload MIME/size/magic-byte checks and a pluggable malware-scan hook (ClamAV when configured, otherwise status `scan_unavailable` shown honestly); prompt-injection stripping + treat-as-data; audit log redaction; token-version session revocation.

## 11. Testing

`node --test` with a real Postgres (CI/dev via `TEST_DATABASE_URL`; tests create an isolated schema). Cases: end-to-end journey; candidate/staff/admin isolation (API, search, export, file URL, SSE); duplicate listings and duplicate submissions (repeat searches, retries, multi-source); consent withdrawal with queued items; expired jobs; unavailable source; failed and uncertain delivery; sensitive-document restriction; CAPTCHA/unsupported-question handoff; reply mis-match → review queue; interview timezone/confirmation; report numbers equal underlying rows; OTP expiry/reuse/rate limit; prompt-injection content has no effect. Sandbox adapters/recipients only; no real applications sent.

## 12. Deliverables

Code, migrations, tests, `docs/vita-job-search/{SETUP.md,CHECKLIST.md,SOURCES_AND_PROVIDERS.md}`, `.env.example`. External items needing the owner: Job Bank/partner feed URLs or credentials, IMAP/SMTP or Gmail/Hostinger mailbox via secure setup, optional LLM key, ClamAV, production HTTPS/domain.

## 13. Out of scope

Scraping or automating sites without an authorized API/feed/email channel; guaranteeing any immigration outcome; replacing existing routes' permission model; the full EMNA multi-portal platform in the original brief beyond what this module needs.
