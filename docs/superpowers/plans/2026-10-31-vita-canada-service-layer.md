# VITA Canada Service Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stage 8 per `docs/superpowers/specs/2026-10-31-vita-canada-service-layer-design.md`.
**Architecture:** Additive migrations 025+; new modules `modules/jobsearch/{cvGenerator,reportExport,suppression,classification}.js` and `modules/finance/{contracts,legalReviews}.js`; routes extend existing routers; UI additions in `public/vita/`.
**Tech Stack:** Node 22, Express, pg, node:test; PDF/DOCX/XLSX libraries pinned at exact versions published at least two weeks ago (verify with `npm view <pkg> time --json`), no install scripts, no network at runtime.

## Global Constraints
- Additive only; never weaken consent/approval/caps/guard; CV content only from confirmed profile facts (no invention, no photo/age/marital); all report numbers from SQL on real rows; candidate downloads scoped to the owner; staff scoped by candidateScopeSql; no secrets/personal data in logs.
- Every mutation transactional + `logAudit(client)`; update `tests/orgs-route-sweep.test.js` classification for each new route; i18n ar/en/fr parity; strict CSP; textContent only.
- Run the full `npm test` ONCE per task at the end, never two at once; commits end with: Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com> and Claude-Session: https://claude.ai/code/session_01FJCJCrbEtXFCvjTVJwpqAi; branch claude/adoring-mendel-yrxr43; do not push.

## Review Focus
- CV output containing anything not present in the confirmed profile; sections for missing data; very long/Arabic/RTL names in PDF/DOCX; filename injection.
- Report download by a candidate for another candidate's id; report numbers drifting from SQL; timezone day boundaries.
- Suppressed address still receiving a send (case, subdomain, plus-addressing, display-name forms); opt-out reply misclassified as acknowledgement.
- Billing gate bypass via the legacy `/finance/invoices` route, other currencies, expired review, wrong jurisdiction, voided/ended contract.
- Reference counter gaps/duplicates under parallel creation; backfill of existing candidates.

### Task 1: Candidate reference and fields
Migration 025 (reference counter, columns per spec §2, backfill, unique index), candidate model/routes (staff edit with audit, validation), candidate portal exposes own reference/status fields, `crm-candidate` UI fields, tests `tests/js-candidate-ref.test.js`.

### Task 2: Canadian CV generator
Migration 026 (`js_cv_files` kind/status/approval columns as needed; `js_cv_generation` log), `modules/jobsearch/cvGenerator.js` (model builder + DOCX + PDF renderers), routes `POST /jobsearch/candidates/:id/canadian-cv` (staff), `GET .../canadian-cv` list, `POST .../canadian-cv/:fileId/approve` and `.../authorize` (candidate authorisation by the candidate themself), download routes; `applicationService` must attach only approved+authorised canadian CV versions when one exists; tests `tests/js-canadian-cv.test.js` (text extraction from PDF/DOCX, no-invention property checks, refusal on minimum, version naming, approval gates, scope, filenames safe).

### Task 3: Reports PDF/XLSX, activity report, snapshots, timezone
Migration 027 (`js_report_snapshots`, setting report_timezone), `modules/jobsearch/reportExport.js`, routes under `/jobsearch/reports/*` (company + per candidate; PDF/XLSX), candidate-facing `GET /jobsearch/me/activity-report.pdf` and staff `GET /jobsearch/candidates/:id/activity-report.pdf`, scheduler job for snapshots (off by default), tests `tests/js-report-export.test.js` (parse-back, numbers vs SQL, scope, timezone, disclaimer text, no other candidates' data).

### Task 4: Employers, contact history, suppression list
Migration 028 (employer columns, `js_suppressions`, application/message `outreach_basis`), employer routes/service extension, contact-history endpoint, reply classifier opt-out detection → suppression + employer status, guard refusal, staff suppression endpoints, tests `tests/js-employers-suppression.test.js`.

### Task 5: Vacancy classification, match bands, match accept/reject
Migration 029 (job columns classification/salary_text/employment_type/required_experience_text/closing_date; match columns band/decision/decided_by/decided_at), classification derivation and evidence rule, bands in matching output, endpoints, `applicationService` requires an accepted match when settings demand (default: setting `require_match_acceptance` false to keep current behaviour), tests `tests/js-classification.test.js`.

### Task 6: Service contracts and legal-review gate
Migration 030 (`fin_services.kind`, `fin_service_contracts`, `fin_legal_reviews`), `modules/finance/{contracts,legalReviews}.js`, routes in financeV2 (permissions finance:write/void; legal review record requires admin), gate enforced in `createInvoice` and legacy `/finance/invoices`, candidate "my contract" read-only, tests `tests/fin-contracts-gate.test.js` (full gate matrix incl. legacy route, expiry, jurisdiction, ended contract).

### Task 7: UI for tasks 1–6
Staff console: candidate reference/fields editor, Canadian CV section (generate, missing flags, approve, download), Reports section (period picker, PDF/XLSX, activity report), employer detail with history and suppression controls, match bands + accept/reject, contract & legal-review panel with "billing disabled" state; candidate portal: reference, Canadian CV authorise button, activity report download, contract view. i18n parity, CSP tests, Playwright smoke.

### Task 8: End-to-end, docs, review fix hook
`tests/canada-e2e.test.js` journey (candidate → confirmed profile → Canadian CV → approve+authorise → match accept → application → send (sandbox) → opt-out reply → suppression → reports PDF/XLSX → contract/legal gate), docs `docs/vita-canada/{CHECKLIST,SETUP}.md` (honest: what is not built per spec §8), update `docs/vita-job-search/DECISIONS.md` stale "not done on purpose" list, env additions, HOSTINGER-NGINX paragraph.
