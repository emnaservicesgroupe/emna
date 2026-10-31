# VITA Canada service layer (stage 8) — checklist

Honest status of stage 8. An item is marked **completed and tested** only when a named test file proves it against a real Postgres schema over real HTTP.
**Nothing here has been deployed.** No real server, no real mailbox, no real job source and no real customer data were involved. The owner's brief
(`Canada_Job_Search_System_Claude_Prompt_Blank_Details.md`, uploaded 2026-10-31) is not stored in the repository; the requirement list below follows the design
derived from it: `docs/superpowers/specs/2026-10-31-vita-canada-service-layer-design.md`. Setup and daily use: [SETUP.md](SETUP.md). Decisions: `docs/vita-job-search/DECISIONS.md` (#15-#33).

Legend: **[x]** completed and tested · **[~]** built, with a stated limit · **[ ]** not built (reason given).

## 1. Candidate reference and Canada profile (migration 025)

- [x] Reference `CAN-YYYY-NNNN` assigned at creation by every creation path (admin, legacy route, lead conversion, direct insert), gap-free per year under concurrency,
      immutable, unique; existing candidates backfilled in id order. Visible to staff in scope and to the candidate; shown in the dashboard, the profile response and the staff CSV exports. —
      `tests/js-candidate-ref.test.js`, `tests/canada-e2e.test.js`.
- [x] Canada fields: city, WhatsApp, work-authorization status, relocation readiness, desired province, service start date. Staff edit with an audit row; the candidate edits
      only city, WhatsApp, relocation readiness and desired province. — `tests/js-candidate-ref.test.js`.

## 2. Canadian-format CV (migration 026)

- [x] Built only from the **confirmed** profile; an extracted-but-unconfirmed profile is refused (409). Sections absent from the profile are listed in `missing[]`, never filled in. —
      `tests/js-canadian-cv.test.js` (including a property test that every output string is copied from the input or is a static label), `tests/canada-e2e.test.js`.
- [x] No photo, date of birth, age, nationality, marital status, passport or salary text. Verified on the PDF and DOCX **text** with sentinel strings placed in the candidate row, the
      uploaded CV text and the unconfirmed (extracted) profile. — `tests/js-canadian-cv.test.js`, `tests/canada-e2e.test.js`.
- [x] PDF and DOCX named `<reference>-CV-V<n>.pdf|docx` (`-FR` for French), new version = new immutable row, hashes equal the stored bytes. — same files.
- [x] Approval chain: Agent/Receptionist cannot approve; a Manager/Admin in scope approves the PDF and DOCX together; only then can the candidate authorise; the candidate sees staff-approved
      versions only. — `tests/js-canadian-cv.test.js`, `tests/canada-e2e.test.js`.
- [x] Application preparation attaches the latest version that is staff-approved **and** candidate-authorised and whose source profile still matches; the exact version, file and SHA-256 are in the
      package, the submission evidence and the sent mail. Withdrawing the authorisation blocks use at once and cancels queued applications that use it. — `tests/js-canadian-cv.test.js`, `tests/canada-e2e.test.js`.
- [~] French: section headings and the summary template only. Facts are **never translated** (no machine translation). — `tests/js-canadian-cv.test.js`.
- [~] **Arabic / non-Latin PDF.** The PDF uses a standard Latin font. A name or entry the font cannot draw makes PDF generation refuse with `latin_spelling_needed` (the candidate must supply a
      Latin spelling); the DOCX handles any script. In **reports** the PDF shows `[?]` for such characters and says so; the Excel version keeps the original text. Report disclaimers exist in English,
      French and Arabic in Excel; the **Arabic PDF falls back to English** and says so. — `tests/js-canadian-cv.test.js`, `tests/js-report-export.test.js`.
- [~] **Mail attachment name.** The e-mail channel names the attachment `CV-<Name>-v<version>.pdf`, not the canonical `<reference>-CV-V<n>.pdf` that staff and candidates see in the console. The bytes and the
      version are the authorised ones (checked by hash in `tests/canada-e2e.test.js`); only the name differs.

## 3. Reports and exports (migration 027)

- [x] Company report (daily/weekly/monthly/custom range) as **PDF and XLSX**; every number equals an independent SQL count; scoped (Admin all, others assigned candidates only). — `tests/js-report-export.test.js`, `tests/canada-e2e.test.js`.
- [x] **Canada Job Search Activity Report** (PDF and XLSX) per candidate: reference, period, counts, the list of applications **actually sent** (only provider-accepted submissions: `sent` and
      `confirmed_submitted`; never drafts, queued, failed or unconfirmed), pending and attention items, replies, interviews, next planned actions; no raw evidence, no recipient addresses, no other candidate. A candidate
      downloads only their own report (another id answers 404). The disclaimer (no promise of a job, LMIA, permit or visa) is in every report. — `tests/js-report-export.test.js`, `tests/canada-e2e.test.js`.
- [x] Insert-only snapshots with a payload hash and stored files; generation and downloads audited; range cap 366 days; row cap (413, never silently cut); per-user rate limit (429 + Retry-After);
      spreadsheet formula injection neutralised. — `tests/js-report-export.test.js`.
- [x] Scheduled daily/weekly/monthly company snapshots, **off by default**, idempotent per kind and period, DST-aware, failure recorded without data — tested with an **injected clock**. — `tests/js-report-export.test.js`.
      **Not observed running unattended on a server.**
- [~] **Snapshot visibility rules.** Candidate-level snapshots follow the candidate scope; `custom` snapshots are visible to their generator and to Admin/SuperAdmin; `scheduled` company snapshots to Admin, SuperAdmin and Manager only.
      A Manager who generated nothing therefore cannot open another user's custom report. — `tests/js-report-export.test.js`.
- [~] **Time zones.** Reports are cut in the report timezone (`REPORT_TIMEZONE`, else `HR_TIMEZONE`, else Africa/Tunis; exact IANA name) and say so in the header; the database keeps UTC. The older CSV exports
      (`/jobsearch/export.csv`) still carry ISO UTC timestamps and name the file with the server's UTC date; they are **not** converted to the report timezone, so a day boundary differs by the UTC offset between
      a CSV export and a report of the same date. Dates in e-mails were not part of this work and were not checked.
- [~] **Erased candidates.** A deleted candidate is a soft delete: they disappear from lists and scoped downloads, but uploaded CVs, generated Canadian CVs, report files and the insert-only snapshot rows
      (payload and hash) **remain in storage and in the database**, (the snapshot rows are insert-only by design; generated CV rows are immutable in their identity and content columns). There is **no erasure path** for them yet. A real erasure request (privacy law) needs an audited,
      Administrator-only procedure that removes the files and anonymises the snapshot payloads while keeping the hashes' audit trail. **Needed before real candidate data is stored.**

## 4. Employers, contact history, do-not-contact list (migration 028)

- [x] Employer record: province, city, industry, phone, recruiter contact, source URLs, eligibility note, status, verification date, staff-only notes; Admin-only edits with audit. — `tests/js-employers-suppression.test.js`.
- [x] Contact history (applications, submissions, replies) shown to staff before a new application, scoped: an Agent sees only own candidates' rows plus a bare number for other candidates' contacts;
      the preparation response carries a summary. — `tests/js-employers-suppression.test.js`, `tests/canada-e2e.test.js`.
- [x] Opt-out reply (English, French, some Arabic; authenticated and matched) -> suppression of the sender, employer `opted_out`, staff task, audit; never an acknowledgement; replay idempotent; an unmatched message, an
      auto-reply or a bounce creates nothing. — `tests/js-employers-suppression.test.js`, `tests/canada-e2e.test.js` (signed webhook).
- [x] The guard refuses a suppressed address, plus-address base, domain, subdomain or an `opted_out`/`blocked` employer at **approval, queueing, automatic approval, follow-up drafts and send time** (the retry path); nothing overrides it;
      only an Administrator removes an entry, with a reason. — `tests/js-employers-suppression.test.js`, `tests/canada-e2e.test.js` (queue refusal, already-queued item stopped at send time, re-queue refused).
- [~] **Domain suppression has no public-suffix list.** A domain entry covers the domain and all subdomains; suppressing a shared suffix such as `co.uk` would cover everything under it. Single-label names and free-mail providers
      are refused, but the platform does not know every public suffix. Staff must not suppress a shared suffix.
- [~] **Hard-bounce over-suppression.** A permanent failure (5.x.x or `Action: failed`) suppresses the address we sent to, including 5.2.2 (mailbox full) and 5.7.x (our domain was refused). Those two can be a temporary or
      provider-side problem and an Administrator may have to lift the entry. A soft bounce (4.x.x) never suppresses.
- [~] **Candidate timeline shows guard codes.** When a send is blocked, the timeline stores the guard code (for example `recipient_suppressed`, `employer_opted_out`). Candidates see fixed reason codes, not staff text, but those two codes
      reveal to a candidate that the employer asked not to be contacted. Decide whether to hide them from candidate-facing views.
- [x] Outreach basis recorded per application; only `published_vacancy_application` passes the guard. — `tests/js-employers-suppression.test.js`.
- [ ] **Prospective outreach (no advertised vacancy) is blocked by design** (CASL). Classification `prospective_no_vacancy` is staff-set and preparation is refused (409 `no_vacancy_outreach_not_permitted`); `employer_requested` and
      `other_documented` bases exist in the schema but are refused. Unblocking needs a lawyer's decision and a code change. — `tests/js-classification.test.js`.

## 5. Vacancy classification and matching (migration 029)

- [x] Six classes, derived in code and informational. `foreign_applicants_stated` needs a quoted evidence string that occurs **verbatim** in the ad (a non-verbatim quote is refused 400); the label is never proof of an LMIA, sponsorship or eligibility. — `tests/js-classification.test.js`, `tests/canada-e2e.test.js`.
- [~] **Classification stickiness.** A staff classification is sticky: no new sighting, re-check or confirmation changes it, even if the job closes, until staff send `classification: null`. A closed job can therefore keep an old label (the job *status*, which blocks preparation, still follows the sources).
- [x] Match bands (85/70/50) stored and shown; vetoes can only lower a band; `not_recommended` is never auto-proposed. Staff accept/reject matches (Manager/Admin; Agent 403), audited, note staff-only; candidates see the band label, not the decision. — `tests/js-classification.test.js`, `tests/canada-e2e.test.js`.
- [x] `require_match_acceptance` (admin-only, default off): when on, preparation needs an accepted match (409 `match_not_accepted`) and the scheduler creates no application for an unaccepted match. — `tests/js-classification.test.js`, `tests/canada-e2e.test.js`.
- [x] Preparation refused for `closed_unsuitable` and for `work_authorization_required` unless a permit/PR/citizen status is recorded; the recorded status is staff-entered and not verified by the platform. — `tests/js-classification.test.js`.
- [x] Vacancy fields: salary text, employment type, required experience, closing date. — `tests/js-classification.test.js`.

## 6. Service contracts and the legal-review gate (migration 030)

- [x] Service kind `candidate_fee` (Administrator only). Invoices and **new payments** for it need an approved, unexpired legal review for the candidate's jurisdiction **and** an active signed contract; `prohibited` blocks; a pending, missing or expired review
      blocks; unknown jurisdiction blocks. Refunds and voids stay possible. The legacy invoice route does not bypass the gate. — `tests/fin-contracts-gate.test.js`, `tests/canada-e2e.test.js`.
- [x] Legal reviews are insert-only (newest decides), recorded by Administrators only; contracts: draft -> signed (optional private PDF/DOCX) -> ended/cancelled; the candidate sees only their own non-draft contracts, with no staff data. — `tests/fin-contracts-gate.test.js`, `tests/canada-e2e.test.js`.
- [~] The platform **records** a legal review. **Legal opinions are the owner's**: whether a candidate fee is lawful in a province, recruiter licensing and immigration-advice questions are not decided or answered by the software. Packages and prices are entered by the owner; none is preloaded.

## 7. Screens (task 7)

- [x] Staff console: candidate Canada file, Canadian CV, matches with bands, vacancy classification, employers and history, do-not-contact list, reports, contract and billing; candidate portal "My Canada file". English, French and Arabic strings in parity; no inline scripts. — `tests/canada-ui.test.js`
      (static wiring and helper tests only).
- [ ] **No browser end-to-end run is recorded in this checklist.** The task report mentions a browser smoke done during development; it is not part of the automated suite and not repeated here.

## 8. Journey and security

- [x] One end-to-end journey over HTTP on a fresh schema with the sandbox mailbox and the fixture job source, no network (a fence fails the run on any outside request): `tests/canada-e2e.test.js`.
- [x] Employer, Agency and Candidate tokens and anonymous callers are refused on the new staff routes (spot check in `tests/canada-e2e.test.js`); the all-routes sweep classifies every route and passes (`tests/orgs-route-sweep.test.js`, run from `tests/canada-e2e.test.js`).
- [x] Migrations 025-030 are additive and idempotent; re-run keeps rows. — `tests/js-candidate-ref.test.js`, `tests/js-canadian-cv.test.js`, `tests/js-report-export.test.js`, `tests/js-employers-suppression.test.js`, `tests/js-classification.test.js`, `tests/fin-contracts-gate.test.js`, `tests/verify-migrations.test.js`.

## 9. Not built, and why

| Brief item | Status | Reason |
|---|---|---|
| Gmail API / OAuth drafts and sends | not built | Needs the owner's Google Cloud OAuth client, consent screen and scopes. The SMTP/IMAP adapter and the signed inbound webhook remain; a Gmail adapter behind the same interface can be built against a fake server once credentials exist. |
| Real job sources (Job Bank, LinkedIn, Indeed) | not built | Needs the owner's access and the sites' terms; no scraping. Only the fixture and manual import exist; feed adapters stay "requires setup". |
| LLM-written CVs and letters | not built | No AI provider key; templates are deterministic. Nothing is machine-translated. |
| NOC / TEER mapping | not built | Needs the official reference data from the owner. |
| Prospective-employer outreach without a vacancy | blocked by design | CASL risk (see section 4). |
| Legal opinions (candidate fees, licensing, immigration advice) | the owner's | The gate records reviews; it decides nothing. |
| Tokenised candidate link | not built | Candidates sign in with an e-mail code. |
| Deployment | not done | Nothing of stage 8 (or the earlier stages) runs on a real server. The Hostinger kit is documented in `docs/vita-job-search/SETUP-HOSTINGER*.md` with its own honest status. |
| Erasure of generated files and snapshots | not built | See section 3. |
| Report timezone for the CSV exports | not built | See section 3. |
