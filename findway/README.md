# FIND WAY

*Find Your Job. Build Your Future.* — an international recruitment platform: public website, candidate / employer / agency portals and the internal **FIND WAY CRM**, connected to the existing visa CRM (`../trust-crm`).

**Read first:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (what was inspected and why FIND WAY is a connected application) · [docs/STATUS.md](docs/STATUS.md) (every requirement: implemented / tested / deferred / blocked) · [docs/INTEGRATION_CHECKLIST.md](docs/INTEGRATION_CHECKLIST.md) (what is needed from you).

## What works today (Phase 0 + Phase 1)
* Accounts with e-mail OTP, MFA for staff/admin, separate approval states, session management
* Employers: company verification, job drafts → administrator approval → public listing, versioned material changes with applicant acknowledgement
* Candidates: profile, consents, applications; every application becomes a **CRM Lead** reviewed by staff; qualification links people without duplicating them (uncertain matches go to a human)
* Employer applicant workflow in *direct* or *managed* recruitment mode; selection ≠ placement
* **trust-crm integration vertical slice**, tested against the real trust-crm code: create-or-link, stage sync both ways, signed idempotent webhooks, retry/dead-letter, conflict queue, reconciliation, secret rotation, Integration Center
* Web app in English, Arabic (full RTL), Albanian, French; installable PWA (a PWA is *not* an App Store / Play Store release)

Not built yet (see [docs/BACKLOG.md](docs/BACKLOG.md)): documents/video uploads, messaging, finance, attendance, agency tools, MCP server, AI features, native apps.

## Quick start
```bash
npm ci && cp .env.example .env
createdb findway && npm run migrate
SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD='a-long-passphrase' node scripts/create-super-admin.js
npm start            # http://localhost:4000
npm run seed:demo    # optional synthetic demo data
npm test             # needs PostgreSQL and ../trust-crm installed — see docs/OPERATIONS.md
```

## Layout
```
src/services/      all business rules + permission checks (one layer for web, workers and the future MCP server)
src/http/          routes + zod validation (thin)
src/integrations/  trust-crm adapter, inbound webhooks, dispatcher, signed outbound webhooks
src/db/migrations/ forward-only SQL
web/               dependency-free SPA + PWA (en/ar/sq/fr)
tests/             node:test suites (real PostgreSQL; integration tests run the real trust-crm app)
scripts/           CLI: super admin, seed, backup-restore check, doc generator, UI browser run
docs/              architecture, integration, permissions, API, operations, status, backlog
```
