# What I need from you (one checklist)

Work continued without these (design, schemas, adapter, local development, tests against the repository's real `trust-crm`). Each item below blocks something specific.

**Existing systems**
- [ ] **CRM URL** (production and staging) and confirmation that the live CRM is the `trust-crm` code in this repo (or a fork — which?). *Blocks: live connection test, field mapping validation.*
- [ ] **"Platform"/website URL** and its repository (is it Staff.al-like? a separate site you built?). *Blocks: deciding whether anything must be migrated or kept in sync.*
- [ ] Repository + **deployment access** (hosting provider, how trust-crm is deployed today, who can restart it). *Blocks: rollout plan §10 of INTEGRATION.md.*
- [ ] **API documentation / webhooks** available for the live CRM and platform (or approval to apply the trust-crm webhook emitter patch described in INTEGRATION.md §9, on staging first).
- [ ] **Authentication provider** (is there SSO/Google/Microsoft? organisation model?). *Blocks: social login.*
- [ ] Existing **identifiers**: how candidates, companies, jobs and applications are numbered today (trust-crm uses integer ids and passport numbers). *Blocks: importing historical records.*
- [ ] A **copy/backup of production data** for a migration *preview* (only after you approve; nothing has been migrated or modified).

**Providers**
- [ ] **E-mail (you chose Hostinger SMTP):** the SMTP host/port/user/password and a sender address your Hostinger mailbox may send as. Set them as `MAIL_SMTP_*` + `MAIL_FROM` on the server (see OPERATIONS §3) — **do not paste the password in chat or commit it** — then run `node scripts/test-mail.js your@address`. Also add SPF/DKIM for your domain in hPanel so codes don't land in spam. *Blocks: real sign-ups.*
- [ ] **File storage** provider (S3-compatible / Azure / GCS) and malware-scanning option. *Blocks: CVs, documents, videos (Phase 2).*
- [ ] Push / WhatsApp providers (optional). 
- [ ] Domain name + TLS plan for the public site and API.

**Secure channel** (never in chat/commits): development/staging credentials for trust-crm (a service account), the production `APP_MASTER_KEY` generation, DB credentials.

**Business decisions**
- [ ] Candidate approval: automatic after email verification (current default) or manual?
- [ ] Employer default recruitment mode: *managed* (current default) or *direct*?
- [ ] Rotate the secrets committed in `trust-crm/.env` (SECURITY_FINDINGS #1) — yes/no, and who does it.
- [ ] Legal texts (privacy, terms), contact details for the public site, official brand assets (the logo you supplied is used as an approved-pending placeholder).
- [ ] Pricing, currencies beyond EUR/TND/ALL, commission rules (Phase 2 — nothing invented).
