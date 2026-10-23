# Sitemap and screen inventory

Routes are hash-based (`#/…`) so the static host needs no rewrites. Status: ✅ built in Phase 1 (verified by the browser run in docs/DEMO.md) · 🕒 later phase (not shown in the UI) · 🔒 blocked on a decision/credential.

## A. Public website
| Screen | Route | Status |
|---|---|---|
| Home (value proposition, live search, latest jobs from the API) | `#/` | ✅ |
| Jobs search (keyword, profession, country, city, experience, skills, languages, salary range+currency+period, employment type, onsite/remote/hybrid, accommodation, relocation) | `#/jobs` | ✅ |
| Job details (all fields in the brief, real verification status, "not specified" where unknown) | `#/jobs/:id` | ✅ |
| Company directory / profile (verified + opted-in only) | `#/companies`, `#/companies/:id` | ✅ |
| Help/FAQ, Privacy, Terms (honest placeholders pending approved legal text), Contact (channel pending configuration) | `#/help` … | ✅ |
| Login, Register (candidate / employer / agency), Verify e-mail, Forgot/Reset password | `#/login` … | ✅ |
| Projects, country pages, profession pages | — | 🕒 Phase 4 / content |

## B. Candidate portal
Overview ✅ · Profile ✅ · Applications (+ detail, withdraw, respond, acknowledge job changes) ✅ · Notifications ✅ · Privacy (consents, export/deletion requests) ✅ · Settings (language, sessions) ✅ · CVs, Documents, Videos, Saved Jobs, Interviews, Messages, AI Job Search 🕒 (Phase 2–4).

## C. Employer portal
Overview ✅ · Company (+ verification) ✅ · Jobs ✅ · Job editor (submit/withdraw/pause/resume/close, versions) ✅ · Applicants (minimised view; shortlist / request interview / request selection / reject) ✅ · Settings ✅ · Team, Approved Catalogue, Shortlists (as a separate screen), Interviews, Messages, Reports 🕒.

## D. Agency portal
Status-only overview ✅ (approval + verification state, honest "tools arrive later") · Offers, Submissions, Candidates, Missing Documents, Messages, Settlements 🕒 Phase 2.

## E/F. Internal workspace — "FIND WAY CRM" (staff, admin, super admin)
Overview ✅ · Leads (+ detail, claim, status, **Qualify with duplicate resolution**) ✅ · Duplicates ✅ · Candidates (+ identity recording) ✅ · Companies (+ create, contact log) ✅ · Applications (detail) ✅ · Employer Requests ✅ · Cases ✅ · Approval Queue ✅ · Company Verifications ✅ · Job Reviews ✅ · Staff (users, create, suspend, reassign) ✅ · Integrations ✅ · Audit Log ✅ · MFA enrolment ✅.
Documents, Videos, Interviews, Tasks, Finance, Agencies, Reports, Messages, Catalogue, Attendance 🕒 Phase 2.

## G. AI assistant & automation control center · H. MCP/Connected AI apps
🕒 Phase 3 (design in MCP_DESIGN.md). Integration Center (the "API, webhook" part of H) ✅.

Machine-readable endpoint list: [generated/api-endpoints.md](generated/api-endpoints.md).
