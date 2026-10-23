# Setup, deployment, backup and recovery

## 1. Local development
Requirements: Node ≥ 20 (tested on 22), PostgreSQL ≥ 14 (tested on 16), and — only to run the integration tests — the sibling `trust-crm` installed (`cd ../trust-crm && npm ci`).

```bash
cd findway
npm ci
cp .env.example .env            # edit DATABASE_URL; leave APP_MASTER_KEY empty in dev (a non-secret dev key is derived)
createdb findway
npm run migrate
SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD='a-long-passphrase' node scripts/create-super-admin.js
npm start                       # http://localhost:4000  (API under /api, web app at /)
npm run seed:demo               # optional: clearly synthetic demo accounts/jobs (refuses to run in production)
```
The Super Admin must enrol MFA on first sign-in (authenticator app: use the shown secret/otpauth URL). Registration e-mails are captured in memory in development at `GET /api/dev/mail` (the route does not exist in production).

## 2. Tests
```bash
export TEST_PG_ADMIN_URL=postgres://postgres@localhost:5432/postgres   # a role that can CREATE/DROP DATABASE
export PG_BIN=/usr/lib/postgresql/16/bin                                # for the backup/restore test
npm test                                                                # ≈100 tests, each file uses its own throw-away database
npm run test:e2e                                                        # Chromium UI run (needs a Chromium binary; set PLAYWRIGHT_BROWSERS_PATH)
node scripts/gen-docs.js                                                # regenerate docs/generated/* after changing routes/permissions
```

## 3. Configuration
All settings are environment variables — see `.env.example` (no secrets in the repo). Policy values (OTP limits, retry policy, candidate approval, job-approval-needs-verified-employer, case-stage map) are rows in the `settings` table, auditable and changeable without a deploy.

| Secret / key | Purpose | Notes |
|---|---|---|
| `APP_MASTER_KEY` | derives OTP, encryption (MFA secrets, identity numbers), identity-hash and webhook-secret keys | **Required in production.** Losing it makes encrypted values unreadable; rotating it requires a re-encryption job (not built — plan before first real data). Store in a secret manager. |
| `DATABASE_URL` | Postgres | TLS to the DB in production |
| `TRUSTCRM_*` | adapter service account | separate from every user/MCP credential |

## 4. Deployment (untested here)
* `Dockerfile` (multi-stage, non-root, health check) and `docker-compose.yml` (app + Postgres 16) are provided but **were not built in the authoring environment** (no Docker daemon). Run `docker compose build && docker compose up` in staging first.
* Put the app behind an HTTPS reverse proxy (TLS 1.2+); set `TRUST_PROXY=true` so rate limits and audit IPs use the real client address; terminate HSTS at the proxy.
* Migrations run at start (`AUTO_MIGRATE=false` to run `npm run migrate` as a separate release step). Migrations are forward-only and checksummed; a modified applied migration aborts startup.
* Workers: delivery dispatcher (every 5 s) and job-expiry (hourly) run in-process (`WORKERS_ENABLED=true`). They are lease-based, so several instances are safe; for dedicated workers start one instance with the HTTP port unexposed. Rate limiting is per-process memory — use a shared store (e.g. Redis) before running multiple web instances.
* Schedule reconciliation (`POST /api/admin/integrations/trustcrm/reconcile`, or call `inbound.reconcile`) every ~10 min until trust-crm emits webhooks.

## 5. Backup and recovery
* **Backups:** nightly `pg_dump --format=custom` + continuous WAL archiving / managed-DB point-in-time recovery; keep ≥ 30 days; encrypt at rest; store off-host.
* **Restore drill (automated check):** `DATABASE_URL=… PG_BIN=… node scripts/backup-restore-check.js` dumps the database, restores into a scratch database, compares **every table's row count** and confirms the append-only triggers survived, then drops the scratch DB. `tests/backup.test.js` runs it on a populated database in CI. Run it against a production-sized copy monthly and after any migration.
* **Recovery procedure:** (1) stop writers (scale app to 0); (2) restore the dump/PITR into a new database; (3) point `DATABASE_URL` at it; (4) start one instance (migrations are idempotent); (5) run *Reconcile*; (6) review Integration Center for blocked/dead deliveries — the outbox is part of the database, so events not yet delivered at backup time are still queued, and events delivered after it are re-detected by reconciliation and idempotency.
* **Before touching trust-crm production:** its own backup is a precondition (INTEGRATION.md §10); FIND WAY never migrates or rewrites trust-crm rows.

## 6. Monitoring and alerts (to wire to your tooling)
Structured JSON logs (`level`, `msg`, `correlation_id`) with redaction. Health: `GET /api/health`. Suggested alerts: any `dead_letters` without `replayed_at`; deliveries in `retry` older than 15 min; `integration_connections.status` ≠ `connected` while enabled; spikes of `auth.login_failed` audit events; 5xx rate; DB backup age.

## 7. Go-live checklist
- [ ] `APP_MASTER_KEY` set from a secret manager; `NODE_ENV=production` (boot fails otherwise)
- [ ] HTTPS + `TRUST_PROXY` + `PUBLIC_BASE_URL`
- [ ] Real mail provider (replace `dev`), SPF/DKIM for the sender domain
- [ ] Super Admin created by CLI, MFA enrolled, recovery codes stored offline
- [ ] trust-crm secrets from SECURITY_FINDINGS #1 rotated; service account created
- [ ] Backup + restore drill passed on staging data
- [ ] Legal texts, contact details, official brand assets supplied (UI currently shows honest placeholders)
- [ ] Penetration test / dependency audit (`npm audit`) reviewed
