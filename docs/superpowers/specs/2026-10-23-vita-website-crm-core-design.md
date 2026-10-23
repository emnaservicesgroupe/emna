# VITA — Public Website + CRM Core (Stages 1–2) — Design

Status: scope approved by the owner in conversation 2026-10-23 ("approved"); the owner's standing instruction is to proceed without further check-ins.
Code: `trust-crm/` (Node 22 / Express / Postgres). Additive only; existing tables, routes and the job-search module are untouched except where noted.

## 1. Goal and success criteria
A visitor can read the VITA site in Arabic, English or French, see **real, staff-published** job offers, and submit a candidate registration, an employer inquiry or a contact message. Each submission becomes a lead in the CRM. Staff review leads, convert a candidate lead into a CRM candidate (with an optional portal login for the job-search module), keep notes and a timeline, and manage the published offers.

Done means: automated tests against real Postgres exercise the whole path (public form → lead → staff convert → candidate account → OTP login), the isolation rules hold, `docs/vita-website-crm/CHECKLIST.md` marks each requirement completed / tested / blocked, and no placeholder content is presented as real (no fake jobs, testimonials, statistics or licence numbers).

Hard rules: no invented company facts (licence numbers, addresses, phone numbers, success rates are env/config-supplied and hidden when absent); the site never promises employment, sponsorship, a work permit or a visa (the standard disclaimer appears on every page in ar/en/fr); all public input is untrusted data; public endpoints are rate-limited and honeypot-protected; personal data is minimised and consent for processing is recorded.

## 2. Public website (`/site/` assets, served at `/`)
- `GET /` returns the site HTML when the client accepts `text/html`; otherwise the existing JSON status (API clients and tests unchanged).
- Plain HTML/CSS/JS, no build step, strict CSP (same as `/vita`), self-hosted VITA logo, ar (RTL) / en / fr with a parity test, mobile-first.
- Pages (hash-free static files): Home, Services, Destinations (Canada first), How it works, Jobs, For employers, Register as a candidate, Contact, Privacy, Terms, plus a link to the candidate portal (`/vita/portal.html`) and staff login.
- Company facts come from `SITE_*` env (name, phone, WhatsApp link, email, address, licence text). Absent value ⇒ the element is not rendered.
- Jobs page lists only rows from `site_jobs` with `status='published'` (§4). Empty state says so honestly.

## 3. Public API (`/public/*`, no auth)
- `GET /public/config` — non-secret site facts that are set.
- `GET /public/jobs`, `GET /public/jobs/:id` — published offers only; no internal fields.
- `POST /public/leads` — body `{kind: candidate|employer|contact, name, email?, phone?, country?, profession?, message?, company?, consent: true, lang, website}` (`website` is the honeypot). Validation, length caps, email/phone shape checks, consent required for candidate/employer. Per-IP and per-email rate limit (DB-backed, survives restart). Duplicate within 24 h by email/phone ⇒ same lead updated, not duplicated. Responds `{ok:true}` regardless of duplicate/limit-near to avoid enumeration (hard limit ⇒ 429).
- Optional notification email to staff via the existing mail adapter (sandbox by default).

## 4. Data model (migration 011, additive, idempotent)
- `crm_leads` (id, kind, status new|contacted|qualified|converted|rejected|spam, name, email, phone, country, profession, company, message, lang, consent_at, consent_text_version, source, ip_hash, assigned_to, candidate_id nullable, created_at, updated_at; unique partial index for 24 h dedupe key).
- `crm_lead_notes` / `crm_timeline` (insert-only): entity (lead|candidate|employer), entity_id, actor, event, detail, created_at.
- `crm_employers` (name, contact_name, email, phone, country, sector, status, notes, created_from_lead) — employer-side records for stage 3 to build on; **separate from** `js_employers` (job-source employers).
- `site_jobs` (title, employer_name, country, city, category, description, requirements, language_requirements, employment_type, salary_text, apply_mode, status draft|published|closed, published_at, closes_at, created_by). Staff-authored only; each row records `evidence_note` (where the offer came from) which is required to publish. No import of third-party jobs here.
- `candidates` gains no required columns. Added by migration: `email`, `phone` already exist (001); add `crm_stage` (lead|documents|submitted|interview|visa|travel|closed) with history in `crm_timeline`.
- Public-form retention: `ip_hash` is a salted hash, never the raw IP.

## 5. Staff API and permissions
New permissions: `leads:read`, `leads:write`, `sitejobs:write`. Admin/SuperAdmin all; Manager and Receptionist both; Agent `leads:read` only on leads assigned to them; Accountant/HR none (deny by default).
- `GET /crm/leads` (filters, scope-filtered), `GET /crm/leads/:id`, `PATCH /crm/leads/:id` (status, assigned_to — assignment admin-only), `POST /crm/leads/:id/notes`.
- `POST /crm/leads/:id/convert` — transactional: creates a `candidates` row (passport number required from staff because the column is `NOT NULL UNIQUE`; conflict ⇒ 409 with a clear message, never a silent duplicate), sets lead `converted`, writes timeline and audit, optionally creates the portal login (`users` role Candidate + `js_candidate_accounts`) and triggers the existing candidate OTP invite. Idempotent: converting twice returns the same candidate.
- `GET/POST/PATCH /crm/site-jobs`, `POST /crm/site-jobs/:id/publish|close`. Publish requires `evidence_note`.
- `GET /crm/candidates/:id/timeline`, `PATCH /crm/candidates/:id/stage`.
- Everything goes through the existing `verifyToken`/`checkPermission` and `candidateScopeSql`-style scoping; every mutation is written to `audit_logs`.

## 6. Staff UI (`/vita/admin.html`, new tabs)
Leads inbox (filters, assign, status, notes, convert dialog), Site jobs (create/edit/publish/close), Candidate pipeline stage + timeline. ar/en/fr parity, CSP-safe, same code style as existing admin.js.

## 7. Security
CSRF not applicable (bearer tokens, no cookies); CSP strict; honeypot + DB rate limit + body size cap (16 KB) on public endpoints; output escaping via textContent only; no staff data on any `/public` response (tested by key-allowlist test); spam status for honeypot hits (stored for audit, not shown as leads by default).

## 8. Testing
`node --test`, real Postgres schema-isolated per file: public validation/rate limit/honeypot/dedupe; consent required; published-only job exposure and field allowlist; role matrix for every new route (Agent sees only assigned leads, Accountant/HR denied, Candidate denied); convert happy path, duplicate passport 409, idempotent re-convert, portal login creation then OTP login; migration idempotency; i18n parity for new pages and CSP/no-inline-script check; end-to-end journey test (form → lead → convert → candidate login).

## 9. Out of scope (later stages)
Employer/agency portals (stage 3), accounting UI, attendance/HR, chat/WhatsApp, MCP assistant, SEO sitemap beyond a basic `sitemap.xml`/`robots.txt`, CMS-style page editing, payments, importing third-party job boards.

## 10. Owner inputs needed (site facts, hidden until set)
`SITE_PHONE`, `SITE_WHATSAPP`, `SITE_EMAIL`, `SITE_ADDRESS`, `SITE_LICENCE_TEXT`, domain/HTTPS, real mail provider for lead notifications.
