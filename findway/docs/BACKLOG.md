# Phased backlog

Legend: ✅ done in this delivery · ⬜ not done · 🔒 blocked on input from you (see INTEGRATION_CHECKLIST).

## Phase 0 — inspection & design
✅ inspect repo · ✅ architecture + decision (ARCHITECTURE) · ✅ sitemap · ✅ permission matrix (generated) · ✅ data ownership map · ✅ integration contracts · ✅ MCP design · ✅ security findings on trust-crm · 🔒 inspect live CRM/platform

## Phase 1 — foundations + vertical slice (this delivery)
✅ Accounts: registration, e-mail OTP (expiry/attempts/resend), login, recovery, sessions, suspension
✅ MFA for privileged roles · ⬜ optional social login 🔒 (provider apps)
✅ Approval workflow separate from e-mail/profile/company review
✅ Companies (employer registration, verification review, staff-discovered companies with attribution)
✅ Jobs: draft → approval → publication, versions, material-change notification + acknowledgement, public search/detail
✅ Candidate profile + consents + data-request records · ✅ Leads → qualification with human-reviewed duplicates
✅ Applications (history, public vs internal, withdrawal/reapplication, idempotency) · ✅ employer applicant workflow (direct/managed)
✅ Recruitment cases (stage machine, reasons on reversal)
✅ trust-crm adapter vertical slice (create/link, update, stage push, inbound signed webhooks, reconcile, retry/DLQ/conflicts, secrets rotation, Integration Center)
✅ Web app (public, candidate, employer, agency status, CRM) in EN/AR(RTL)/SQ/FR, installable PWA
✅ Security tests, backup-restore check, generated docs
⬜ Employer team members/invitations · ⬜ saved jobs/searches, job alerts · ⬜ e-mail notification preferences/quiet hours/unsubscribe (in-app notifications exist)

## Phase 2 — operations
⬜ Documents (private storage, validation, malware scan, review, expiry dates, versions) 🔒 storage provider
⬜ Videos/audio (resumable uploads, processing states, diagnostics) · ⬜ catalogue + guest showcases (expiry, revoke, password, logs)
⬜ Interviews (request → confirmed) · ⬜ messaging (application/case conversations, delivery states) · ⬜ tasks
⬜ Agency portal (offers, submissions, Excel import with preview/duplicates, settlements)
⬜ Finance: ledger, multi-currency with rate dates, commissions, Super-Admin-only price edits
⬜ Staff attendance (policy-driven, corrections) · ⬜ reports with defined metrics + permissioned CSV/Excel export
⬜ Execute data export/deletion requests · ⬜ contacts as separate records · ⬜ webhook emitter in trust-crm (needs approval)
⬜ Document-related events (`document.uploaded/reviewed`, `interview.scheduled`)

## Phase 3 — MCP, approvals, automation
⬜ MCP server (OAuth, scopes, revocation, Connected AI Applications) · ⬜ read tools · ⬜ draft tools · ⬜ approval records + controlled execution · ⬜ automation scheduler/control center · ⬜ AI workspace

## Phase 4 — extensions
⬜ External job integrations + AI application assistance (consent, duplicate/closed-job checks, snapshots) · ⬜ Projects/proposals · ⬜ optional subscriptions (disabled until prices/provider exist) · ⬜ native iOS/Android apps (React Native/Expo or native) on the frozen API

## Hardening / platform
| ID | Item |
|---|---|
| B-01 | Freeze API under `/api/v1`; deprecation policy (needed before native apps) |
| B-02 | OpenAPI document generated from the zod schemas |
| B-03 | Shared rate-limit store (Redis) for multi-instance |
| B-04 | `APP_MASTER_KEY` rotation / re-encryption job |
| B-05 | ✅ SMTP provider done; still open: bounce/delivery webhooks or a provider API to move messages `provider_accepted → delivered/failed` |
| B-06 | Replace in-process workers by a managed scheduler if load requires |
| B-07 | Dependency/SAST scanning in CI, container build + scan |
| B-08 | Accessibility audit with assistive technology (automated checks only so far) and native-speaker review of AR/SQ/FR copy |
| B-09 | Idempotent historical import tooling (preview + rollback) once production data access is approved 🔒 |
