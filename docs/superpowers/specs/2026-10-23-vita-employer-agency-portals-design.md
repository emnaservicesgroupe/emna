# VITA — Employer and Agency Portals (Stage 3) — Design

Status: stage scope approved 2026-10-23; the owner's standing instruction ("fix everything, don't come back") covers spec and plan approval.
Code: `trust-crm/`. Additive only. Builds on stages 1–2 (`crm_leads`, `crm_employers`, `site_jobs`, `crm_timeline`, OTP login).

## 1. Goal and success criteria
Employers can sign in (email code), request staff to recruit for a vacancy, and review the candidates staff present to them, answering interested / interview / not suitable. Partner agencies can sign in, register their own candidates, and follow the status of only those candidates. Staff manage both organisations, review requests and decide what is presented. Done = journey tests on real Postgres, hard isolation proven (employer ↔ employer, agency ↔ agency, both ↔ candidates ↔ staff), checklist honest.

Hard rules: an employer sees only a **limited candidate summary** (profession, years of experience, languages, country of residence, availability, staff note) — never passport, date of birth, contact details, documents or the CV file — and only for candidates **presented to that employer** with a **recorded candidate consent to share** (staff-attested, with date and basis, withdrawable; withdrawal hides the candidate from the employer immediately). An agency sees only candidates it registered, with name, stage and staff-visible status text — no documents, no other agencies' data. No promise of hiring/sponsorship/visa anywhere; disclaimer shown in both portals (ar/en/fr).

## 2. Identity
New roles `Employer` and `Agency` (migration extends the `users.role` check), linked to organisations: `crm_employers` (existing, gains `status` use) and new `crm_agencies`; link tables `crm_org_accounts(user_id, org_type, org_id)` with unique user. Staff create the organisation and **invite** a portal user (creates user + link + sends the existing OTP code mail). Login uses the existing email-OTP flow generalised to eligible roles Candidate|Employer|Agency (Candidate behaviour unchanged); tokens carry `tv` like Candidate tokens, so suspension revokes sessions. Employer/Agency roles hold **no** staff permissions; every existing route must keep denying them (tested across jobsearch, candidates, finance, documents, audit, notifications, /crm).

## 3. Data (migration 013)
- `crm_agencies(id, name, contact_name, email, phone, country, status active|suspended, notes, created_by, created_at)`.
- `crm_org_accounts(user_id PK→users, org_type employer|agency, org_id, created_at)`.
- `candidates.agency_id` nullable FK; `crm_leads.agency_id` nullable FK (agency-registered candidates arrive as leads kind=candidate with `source='agency'`).
- `employer_requests(id, employer_id, title, positions int, country, city, category, description, requirements, salary_text, start_date, status submitted|in_review|accepted|declined|filled|cancelled, staff_note (internal), employer_visible_note, site_job_id nullable, created_at, updated_at)`.
- `employer_presentations(id, request_id, candidate_id, presented_by, summary jsonb (frozen allowlisted fields at presentation time), staff_note_for_employer, status presented|interested|interview|not_suitable|withdrawn, employer_note, responded_at, created_at, UNIQUE(request_id, candidate_id))`.
- `candidate_share_consents(id, candidate_id, employer_id, basis text, recorded_by, recorded_at, withdrawn_at)` — presenting requires an active row for that candidate + employer.
- All state changes also write `crm_timeline` (entities `employer_request`, `agency`, `presentation`) and `audit_logs`.

## 4. APIs
Staff (`/crm/...`, permission `orgs:write` Admin/SuperAdmin/Manager; read by Receptionist): organisations CRUD + `POST /crm/employers/:id/invite`, `POST /crm/agencies/:id/invite`, suspend/reactivate (revokes sessions via `token_version`); `GET/PATCH /crm/employer-requests`, `POST /crm/employer-requests/:id/presentations` (candidate in staff scope, active share consent, snapshot), `POST /crm/candidates/:id/share-consents` / `DELETE` (withdraw); `GET /crm/presentations`.
Employer portal (`/employer/*`, role Employer only, org taken from the token link — never from the request): `GET /employer/me`, `GET/POST /employer/requests`, `GET /employer/requests/:id`, `PATCH` own submitted request (until in_review), `GET /employer/presentations`, `POST /employer/presentations/:id/respond {status, note}`.
Agency portal (`/agency/*`, role Agency only): `GET /agency/me`, `POST /agency/candidates` (creates lead kind=candidate source=agency with agency_id; consent attestation checkbox that the agency has the candidate's permission), `GET /agency/candidates` and `/:id` (own only: name, profession, stage, status text, created_at).
Rate limits and 16 KB body caps on portal writes; 404 (not 403) for other organisations' objects.

## 5. UI
Two static portals under `/vita/employer.html` and `/vita/agency.html` (same CSP-safe style, ar/en/fr RTL, login by code), and staff console tabs "Organisations", "Employer requests" (with presentation dialog showing the exact summary that will be shared). Public site: employer page links to the employer portal.

## 6. Testing
Schema/migration idempotence; role matrix for every new route; exhaustive "Employer/Agency cannot call any pre-existing route" sweep (enumerate the app's routes); isolation (employer A cannot read/answer employer B's requests/presentations; agency A vs B); share-consent gate and withdrawal hides data immediately; summary allowlist test (no passport/DOB/email/phone/doc keys, frozen snapshot); invite → OTP login → session revocation on suspend; end-to-end journey; i18n parity/CSP checks; browser smoke.

## 7. Out of scope
Contracts, payments/commissions (accounting stage), employer-side file upload, chat, automatic matching of requests to candidates, agency bulk import.

## 8. Owner inputs
Real mail provider (invites/codes), legal wording for the sharing consent and employer terms, the list of partner employers/agencies to invite.
