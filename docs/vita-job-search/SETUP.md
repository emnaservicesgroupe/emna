# VITA AI Job Search — Setup and Operations

This guide is for the person who installs and runs the server. It covers the `trust-crm/` backend and the
job-search module (`/jobsearch/*` API, `/vita/` web pages).

Nothing in this guide connects a live job source or sends real e-mail by itself. Those steps need
URLs, credentials or agreements that only the owner can provide. See
[SOURCES_AND_PROVIDERS.md](SOURCES_AND_PROVIDERS.md). What is done and what is not is in
[CHECKLIST.md](CHECKLIST.md).

**Hostinger VPS / Docker:** a ready-made kit (Postgres + app + Caddy HTTPS, generated secrets, backups,
first admin, safe sandbox defaults) is in `deploy/hostinger/`; follow [SETUP-HOSTINGER.md](SETUP-HOSTINGER.md).
This page explains every setting in depth and applies to any server.

**Never paste passwords, API keys or feed credentials into a chat, an issue or a commit.** Put them
only in the server's environment (the `.env` file on the server, or the host's secret settings).

---

## 1. Prerequisites

| Item | Version / note |
|---|---|
| Node.js | 22 (tested on 22.22). `pdf-parse` 2.x needs Node `>=20.16 <21` or `>=22.3`. |
| PostgreSQL | 16 (tested on 16.15). The `btree_gist` extension must be installable (it ships with standard PostgreSQL packages; migration 002 runs `CREATE EXTENSION IF NOT EXISTS btree_gist`). The database user needs permission to create it, or an admin creates it once. |
| Disk | A private directory for uploaded CVs (`STORAGE_DIR`), outside any web-served folder. |
| Optional | ClamAV daemon (`clamd`) for malware scanning; an SMTP account; an inbound mail bridge (see SOURCES_AND_PROVIDERS.md). |

## 2. Install

```bash
cd trust-crm
npm ci            # or: npm install
cp .env.example .env
# edit .env (see section 3); keep it out of git (it is in .gitignore)
```

## 3. Environment variables

Every variable the code reads is listed in `trust-crm/.env.example` with a comment. The table below gives
the meaning, the default, whether the value is a secret, and whether production needs it.

"Secret" = never share it, never commit it. "Required (prod)" = the server must not go live without it.

### Core

| Variable | Meaning | Default | Secret | Required (prod) |
|---|---|---|---|---|
| `NODE_ENV` | Set `production` on a real server. `test` is reserved for the test suite: it enables the test job source, turns off the scheduler and workers, and relaxes secret checks. | unset | no | yes (`production`) |
| `PORT` | HTTP port | `5000` | no | no |
| `DATABASE_URL` | Postgres connection string (overrides `DB_*`) | unset | **yes** (contains the password) | yes (or `DB_*`) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Postgres connection when `DATABASE_URL` is unset | see `.env.example` | `DB_PASSWORD` yes | yes (or `DATABASE_URL`) |
| `TEST_DATABASE_URL` | Used by tests **and preferred by `db.js` over `DATABASE_URL`** | unset | yes | **must be unset in production** |
| `JWT_SECRET` | Signs staff and candidate login tokens. Also the fallback for `JOBSEARCH_REPLY_SECRET`. | placeholder | **yes** | yes (long random value, new for this server) |
| `JWT_EXPIRES_IN` | Lifetime of staff tokens from `/auth/login`: seconds, or a number with `s`/`m`/`h`/`d` (e.g. `12h`, `7d`). An invalid value falls back to the default. | `12h` (was `7d` before Task 18) | no | no (set `7d` only to keep the old lifetime) |
| `TRUST_PROXY` | Behind an HTTPS reverse proxy: proxy hop count (usually `1`) or an address list such as `loopback`. `true` is refused. | unset | no | yes when behind a proxy |

### Storage and CV upload

| Variable | Meaning | Default | Secret | Required (prod) |
|---|---|---|---|---|
| `STORAGE_URL_SECRET` | Signs short-lived file download links. Without it, links are refused outside tests. | unset | **yes** | yes |
| `STORAGE_DIR` | Private upload directory | `trust-crm/.storage` | no | recommended (absolute path, outside the app folder) |
| `MAX_UPLOAD_MB` | Max upload size | `10` | no | no |
| `JS_UPLOADS_PER_HOUR` | Max CV uploads per user per hour | `20` | no | no |
| `EXTRACT_TIMEOUT_MS` | CV text-extraction timeout | `10000` | no | no |
| `MAX_UNCOMPRESSED_MB` | Max total uncompressed size of a DOCX (zip-bomb guard) | `50` | no | no |
| `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS` | clamd INSTREAM over TCP. Unset (or unreachable) = every upload is `scan_unavailable`. | unset, `3310`, `10000` | no | **yes** (unscanned CVs are not attached by default) |
| `ALLOW_UNSCANNED_ATTACHMENTS` | Exactly `true` = CVs marked `scan_unavailable` may be attached to applications. Anything else (default) = they are blocked with `attachment_unscanned` (preparation, approval and the pre-send check). `infected` is always blocked. | unset (= blocked) | no | leave unset; connect ClamAV instead (section 8.1) |

### Mail (outgoing)

| Variable | Meaning | Default | Secret | Required (prod) |
|---|---|---|---|---|
| `MAIL_PROVIDER` | `sandbox` (records mail in the database, sends nothing) or `imap_smtp` | `sandbox` | no | `imap_smtp` for real mail |
| `MAIL_SANDBOX_ALLOWLIST` | Sandbox only: recipients it accepts (comma list, `*` wildcards) | `*@test.invalid` | no | no |
| `MAIL_REAL_SEND` | Must be exactly `true` for `imap_smtp` to send. Health shows outbound `connected` only when the SMTP settings **and** `MAIL_FROM` are valid **and** this is `true` (it does not test the connection). | `false` | no | `true` only when you are ready |
| `MAIL_FROM` | From address, and the domain of every Reply-To and Message-ID we generate (replies are matched through them). Must be a **plain address** (`jobs@your-domain.example`): no display name, no list, no line breaks. **Required for real mail** (`MAIL_PROVIDER=imap_smtp`): without a valid value outbound is `not_configured` (Health names `MAIL_FROM`), `imap_smtp` refuses to send, and outside `NODE_ENV=test` every real send stops before the provider call with a staff task (`internal_error`, "MAIL_FROM must be set…"); follow-up replies answer 503. **With the sandbox provider (the default)** an unset `MAIL_FROM` is fine (Task 20): the sandbox records mail as from `vita@test.invalid` and Health shows no mail problems. A value that is set but invalid (line breaks, display name, list) is refused with every provider. | unset (sandbox: `vita@test.invalid`; real provider: refused) | no | **yes** before real mail |
| `MAIL_REPLY_TO` | Reply-To mailbox; plus-addressed with a reply token. Plain address only (same rules as `MAIL_FROM`). | `MAIL_FROM` | no | recommended |
| `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_USER`, `MAIL_SMTP_PASS` | SMTP account (port 465 = TLS, otherwise STARTTLS) | unset, `587` | `MAIL_SMTP_PASS` **yes** | yes for real mail |
| `MAIL_IMAP_HOST`, `MAIL_IMAP_USER`, `MAIL_IMAP_PASS` | **Not used.** IMAP polling is not implemented; replies arrive through the webhook (10.2). Since Task 18 sending no longer needs them. | unset | `MAIL_IMAP_PASS` yes | no |
| `JOBSEARCH_REPLY_SECRET` | HMAC key for the `[VITA-…]` reply token | `JWT_SECRET` | **yes** | recommended (separate from `JWT_SECRET`) |

### Mail (incoming webhook)

| Variable | Meaning | Default | Secret | Required (prod) |
|---|---|---|---|---|
| `INBOUND_MAIL_SECRET` | HMAC key the bridge uses to sign each POST. Unset = webhook returns 503. | unset | **yes** | yes to receive replies |
| `INBOUND_MAIL_MAX_BYTES` | Max webhook body | `1048576` | no | no |
| `INBOUND_MAIL_RATE_PER_MIN` | Webhook requests per minute per IP | `120` | no | no |
| `INBOUND_AUTH_REQUIRED` | `true`: a message without DKIM/DMARC results is never matched automatically | `true` outside tests | no | keep `true` |
| `INBOUND_AUTHSERV_ID` | Only trust Authentication-Results from this server id (e.g. `mx.example.com`) | unset | no | recommended |
| `INBOUND_BOUNCE_DOMAINS` | Domains whose MAILER-DAEMON/postmaster bounces open a staff task | `MAIL_FROM` domain | no | no |
| `INBOUND_AUTO_ACK_EVIDENCE` | `true` = record employer acknowledgements as evidence automatically. **Risk-accepting** (see CHECKLIST limitation 1). | `false` | no | keep `false` |
| `JOBSEARCH_INBOX_REVIEWER_ID` | User id that receives unmatched-reply tasks | first active Admin | no | no |

### Sources and matching

| Variable | Meaning | Default | Secret | Required (prod) |
|---|---|---|---|---|
| `JOBBANK_CA_FEED_URL` | Authorized Job Bank feed URL (https, public host) | unset → `requires_setup` | treat as secret if it carries a key | to use Job Bank |
| `PARTNER_FEED_URLS` | Approved partner feed URLs, comma separated | unset → `requires_setup` | same | to use partner feeds |
| `JOBSEARCH_USER_AGENT` | User-Agent sent to feeds | `VITA-JobSearch/1.0 …` | no | recommended (with a contact address) |
| `MATCH_MIN_SCORE` | Matches below this score are not stored | `40` | no | no |

### Scheduler and workers

| Variable | Meaning | Default |
|---|---|---|
| `JOBSEARCH_SCHEDULER` | `off` disables the once-a-minute scheduler tick | on (never under `NODE_ENV=test`) |
| `JOBSEARCH_WORKERS` | `off` disables the queue workers (sending, queued searches) | on (never under `NODE_ENV=test`) |
| `JOBSEARCH_WORKER_INTERVAL_MS` | Worker poll interval | `30000` |
| `APPLICATIONS_PER_TICK` | New applications per candidate per tick | `5` |
| `MATCH_AUTO_PREPARE_MIN` | Minimum score for the scheduler to create and prepare an application | `60` |
| `JOB_RECHECK_HOURS` | Re-check open jobs not checked for this long | `24` |
| `SCHEDULER_QUEUE_BATCH`, `SCHEDULER_RECHECK_BATCH`, `SCHEDULER_CANDIDATES_PER_TICK`, `SCHEDULER_RETRY_BATCH` | Per-tick bounds | `50`, `20`, `200`, `20` |
| `SCHEDULER_REFUSAL_BACKOFF_HOURS` | Retry delay for refused automatic approvals (minimum 6) | `6` |

### Reports, exports, live events

`JOBSEARCH_EXPORT_MAX_ROWS` (10000), `JOBSEARCH_EXPORT_RATE_PER_HOUR` (10), `JOBSEARCH_SSE_POLL_MS` (2000),
`JOBSEARCH_SSE_RECHECK_MS` (60000), `JOBSEARCH_SSE_HEARTBEAT_MS` (25000), `JOBSEARCH_SSE_MAX_PER_USER` (3),
`JOBSEARCH_SSE_MAX_TOTAL` (500), `JOBSEARCH_SSE_MAX_BUFFER_BYTES` (262144), `JOBSEARCH_SSE_BATCH` (500).
None are secret; the defaults are fine for one server.

### Development and test only

`VITA_SEED_PASSWORD`, `VITA_SEED_ALLOW_REMOTE`, `VITA_SEED_FORCE` (demo seed, section 13) and
`EXTRACT_TEST_DELAY_MS` (tests). Leave them unset in production.

---

## 4. Database

### 4.1 New installation

```bash
sudo -u postgres createuser --pwprompt trustcrm        # choose a strong password
sudo -u postgres createdb -O trustcrm trustcrm
sudo -u postgres psql -d trustcrm -c "CREATE EXTENSION IF NOT EXISTS btree_gist;"   # if trustcrm cannot create extensions

cd trust-crm
psql "$DATABASE_URL" -f sql/schema.sql     # the original CRM tables
npm run migrate                            # applies sql/migrations/001..010
```

`npm run migrate` prints `Applied: …` or `No pending migrations`.

### 4.2 What the migrations do

| File | Change |
|---|---|
| `001_migrations_and_roles.sql` | `schema_migrations` table; `users.role` also allows `Candidate`; `users.token_version`; `candidates.email`, `candidates.phone` |
| `002_jobsearch_core.sql` | All shared `js_*` tables, `btree_gist`, insert-only triggers on timeline/audit tables |
| `003_js_appointments_tz.sql` | Time zone and title on appointments |
| `004_js_cv_scan.sql` | Malware-scan columns on CV files |
| `005_js_matching.sql` | Employer-confirmation scope/revocation; stored overseas acceptance |
| `006_js_confirmation_backfill.sql` | Backfill of application-scoped confirmations |
| `007_js_application_package.sql` | Application package columns |
| `008_js_inbox.sql` | Inbox tables and indexes |
| `009_js_inbox_fix.sql` | Inbox fixes |
| `010_js_indexes.sql` | Lookup indexes |

Properties:

- **Additive.** They create `js_*` tables and indexes. The only changes to original tables are in 001:
  the `users.role` check is replaced by one that also allows `Candidate`, and three columns are added
  with `ADD COLUMN IF NOT EXISTS` (`users.token_version` default 0, `candidates.email`, `candidates.phone`).
  No original row is updated or deleted.
- **Idempotent.** Each file uses `IF NOT EXISTS` forms, and `schema_migrations` records applied files, so
  running `npm run migrate` again applies nothing.
- **One transaction per file.** `scripts/migrate.js` runs each file inside `BEGIN … COMMIT` with an
  advisory lock, so a failing file is rolled back completely and the files after it are not applied.

This was checked with `TEST_DATABASE_URL=postgres://… node scripts/verify-migrations.js` (see CHECKLIST
"Checks run"). The database URL must be given explicitly (`TEST_DATABASE_URL`, or `DATABASE_URL`); without
one the script prints what to set and exits with code 2 — it never falls back to `DB_*` or a `.env` file. That script
builds throwaway schemas, loads `sql/schema.sql` plus sample rows in every original table, applies all
migrations and compares every original row and column before and after. It never touches your tables.

### 4.3 Applying on an existing database that holds real data

1. **Stop the app** (so nothing writes during the change).
2. **Back up the database and the storage directory** (section 11). Do not continue without a backup you
   have checked can be read (`pg_restore --list backup.dump | head`).
3. Optional dry run against a copy:
   ```bash
   createdb trustcrm_copy && pg_restore -d trustcrm_copy backup.dump
   DATABASE_URL=postgres://…/trustcrm_copy npm run migrate
   ```
4. Check whether your `users.role` check still has its original name and values:
   `psql "$DATABASE_URL" -c "\d users"`. Migration 001 drops every CHECK on `users` whose definition
   mentions "role" and recreates `users_role_check`. If you added your own check that mentions "role", note
   it and re-create it afterwards.
5. Run `npm run migrate`. Each file runs in its own transaction.
6. Check: `psql "$DATABASE_URL" -c "SELECT name, applied_at FROM schema_migrations ORDER BY name"` lists
   001…010, and row counts of `users` and `candidates` are unchanged.
7. Start the app.

**Rollback.** The migrations have no "down" scripts. If something is wrong after step 5, stop the app and
restore the backup from step 2 (section 11.2). Because each file is transactional, a failed file leaves
nothing half-applied; earlier files stay applied, which is harmless (they are additive), and a later
`npm run migrate` continues from the failed file after you fix the cause.

---

## 5. First SuperAdmin

`POST /auth/bootstrap-super-admin` works **only while the `users` table is empty** (after the first user
exists it returns 403; two simultaneous calls create at most one account - the check and the insert run
under one lock). It is unauthenticated by nature, so it is protected by **where it can be called from**
(Task 20):

- **With `NODE_ENV=production` the app answers it only for a caller on its own loopback interface**
  (`127.0.0.1` / `::1`) **and without proxy headers** (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `Via`...).
  A request relayed by Caddy/nginx - i.e. anything from the internet - gets `404`, like an unknown route.
- The Docker kit's Caddyfile also answers `404` for this path (any case, extra slashes).
- So the order of steps is: start the server, then **on the server** run `deploy/hostinger/create-admin.sh`
  (Docker kit: it posts from inside the app container) - or, without Docker, call it on the server itself:

```bash
# on the server, to the app's own port (not through the proxy); production refuses any other caller
curl -sS -X POST http://127.0.0.1:5000/auth/bootstrap-super-admin \
  -H 'Content-Type: application/json' \
  --data @bootstrap.json
```

with `bootstrap.json` (create it on the server, delete it afterwards):

```json
{ "full_name": "Mohamed Aloui", "email": "alouimohamed19840@gmail.com", "password": "<choose it yourself>" }
```

The endpoint (and `/auth/register`) refuses a password shorter than 12 characters, one on a small list of
common passwords, or one that contains the part of the e-mail address before `@`, with a clear 400 error.
That is a floor, not a recommendation:

- At least 16 characters; a passphrase of 4–5 unrelated words, or a password manager's random password.
- Not used on any other site; never sent in chat or e-mail.
- Type it into the file or prompt on the server yourself. Shell history keeps `--data '{"password":…}'`,
  so use a file as above, or a client such as an HTTP tool that does not log bodies.

Still do the bootstrap **right after** the first start. Outside production (`NODE_ENV` not `production`)
the loopback rule does not apply: never expose a development server with an empty `users` table.

Log in:

```bash
curl -sS -X POST https://YOUR-HOST/auth/login -H 'Content-Type: application/json' --data @login.json
# -> {"token": "...", "role": "SuperAdmin", ...}   token valid 12 hours (JWT_EXPIRES_IN)
```

The admin console is at `https://YOUR-HOST/vita/admin.html` and uses the same login.

Sign-in protection (Task 20): an unknown e-mail, a wrong password and an inactive account all get the same
`400 {"error":"Invalid email or password"}` (unknown e-mails also pay a bcrypt comparison, so timing does not
reveal which accounts exist). Each attempt is reserved (counted as a failure for the e-mail and the IP) in
the same synchronous step as the limit check, before the database lookup and the bcrypt comparison, so
simultaneous requests cannot slip past the limit; a successful sign-in clears the e-mail's failures and gives
back its own provisional IP failure. After 5 failures for one e-mail, or 10 failures (or 100 attempts) from
one IP address, within 15 minutes, `/auth/login` answers `429` with `Retry-After`, even for the right password.
When the table grows past 50 000 keys, expired entries go first, then per-IP buckets, then e-mails that are
not locked; a locked e-mail is dropped only as a last resort. These counters are kept **in memory, per app
process** (reset on restart; not shared between processes - see CHECKLIST limitation 3); tune them with
`LOGIN_EMAIL_FAILURES`, `LOGIN_IP_FAILURES`, `LOGIN_IP_ATTEMPTS`.
Behind a proxy they need `TRUST_PROXY` to see client addresses.

Staff tokens carry a version claim (`tv`, from `users.token_version`): every request re-checks that the
user is still active and has the same role and version. Suspending a user
(`POST /jobsearch/admin/users/:id/suspend`) bumps the version, so that user's tokens stop working on the
next request; reinstating does not revive old tokens. **Upgrade note:** tokens issued before this change
have no `tv` and keep working until they expire (at most 7 days after they were issued). To end them at
once, rotate `JWT_SECRET` (this signs everybody out, candidates included).

## 6. Staff and candidate accounts

All calls below need `Authorization: Bearer <admin token>`.

**Staff** (Admin, Manager, Agent, Receptionist, Accountant, HR) — existing endpoint, needs `users:write`
(Admin or SuperAdmin):

```http
POST /auth/register
{ "full_name": "…", "email": "…", "password": "…", "role": "Manager" }
```

The password rules of section 5 apply. Role `Candidate` is refused here (400): candidate logins are created
only with `POST /jobsearch/admin/candidate-accounts` (below), which links them to a CRM candidate.

Who can do what in the job-search module. The table below is checked against `middleware/role.js`
(`PERMISSIONS`) by `tests/role.test.js` ("Task 19 SETUP §6 permission matrix…"), so it cannot drift from the
code: ✓ = the role holds the permission.

<!-- permission-matrix:start -->
| Role | jobsearch:read | jobsearch:write | jobsearch:approve | jobsearch:admin | users:write | Sees in the module |
|---|---|---|---|---|---|---|
| SuperAdmin | ✓ | ✓ | ✓ | ✓ | ✓ | all candidates |
| Admin | ✓ | ✓ | ✓ | ✓ | ✓ | all candidates |
| Manager | ✓ | ✓ | ✓ | — | — | candidates assigned to them |
| Receptionist | ✓ | ✓ | — | — | — | candidates assigned to them |
| Agent | ✓ | ✓ | — | — | — | candidates assigned to them |
| Accountant | — | — | — | — | — | nothing |
| HR | — | — | — | — | — | nothing |
| Candidate | — | — | — | — | — | only their own record (ownership checks, no permissions) |
| Employer | — | — | — | — | — | nothing (portal role: own organisation only via `/employer/*`) |
| Agency | — | — | — | — | — | nothing (portal role: own organisation only via `/agency/*`) |
<!-- permission-matrix:end -->

### Accounting permissions

Who can do what in the accounting module (Stage 4). Checked against `middleware/role.js` by
`tests/fin-schema.test.js`. ✓ = the role holds the permission. Candidates read their own invoices through
ownership checks only (`GET /finance/me`), never through a staff permission.

<!-- finance-permission-matrix:start -->
| Role | finance:read | finance:write | finance:void | finance:refund | finance:export |
|---|---|---|---|---|---|
| SuperAdmin | ✓ | ✓ | ✓ | ✓ | ✓ |
| Admin | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manager | ✓ | — | — | — | ✓ |
| Receptionist | — | — | — | — | — |
| Accountant | ✓ | ✓ | ✓ | ✓ | ✓ |
| HR | — | — | — | — | — |
| Agent | — | — | — | — | — |
| Candidate | — | — | — | — | — |
| Employer | — | — | — | — | — |
| Agency | — | — | — | — | — |
<!-- finance-permission-matrix:end -->

### Attendance and HR permissions

Who can do what in the HR module (Stage 5). Checked against `middleware/role.js` by `tests/hr-schema.test.js`.
✓ = the role holds the permission. Every active staff role (SuperAdmin, Admin, Manager, Receptionist, Accountant,
HR, Agent) can clock in/out, see its own attendance and balances and request leave or corrections: that
self-service needs no permission, only an active staff account (`requireStaff`, `middleware/staff.js`).
Candidate, Employer and Agency are refused everywhere. **hr:approve** for Manager is further limited in service
code to the manager's direct reports (never their own requests); HR, Admin and SuperAdmin approve anyone else's.

<!-- hr-permission-matrix:start -->
| Role | hr:read | hr:write | hr:approve |
|---|---|---|---|
| SuperAdmin | ✓ | ✓ | ✓ |
| Admin | ✓ | ✓ | ✓ |
| Manager | — | — | ✓ |
| Receptionist | — | — | — |
| Accountant | — | — | — |
| HR | ✓ | ✓ | ✓ |
| Agent | — | — | — |
| Candidate | — | — | — |
| Employer | — | — | — |
| Agency | — | — | — |
<!-- hr-permission-matrix:end -->

### Messaging permissions (Stage 6)

Who may use VITA messaging at all. Candidate, Employer and Agency users hold no permission: they are authorised by
ownership (their own conversation / their organisation's thread) and reach only `/chat/*`. HR and Accountant hold
none either; they still reach `/chat` and can read and write in the internal `staff` rooms they were explicitly added
to as a participant (service rule, not a permission) - nothing else: no candidate / employer / agency conversation,
no moderation. Staff see candidate / organisation conversations only for people they may serve
(assigned staff, Admin, Manager).

<!-- chat-permission-matrix:start -->
| Role | chat:read | chat:write | chat:moderate |
|---|---|---|---|
| SuperAdmin | ✓ | ✓ | ✓ |
| Admin | ✓ | ✓ | ✓ |
| Manager | ✓ | ✓ | ✓ |
| Receptionist | ✓ | ✓ | — |
| Accountant | — | — | — |
| HR | — | — | — |
| Agent | ✓ | ✓ | — |
| Candidate | — | — | — |
| Employer | — | — | — |
| Agency | — | — | — |
<!-- chat-permission-matrix:end -->

### MCP assistant access (`mcp:use`)

Who may create personal access tokens (PAT) for the read-only MCP server (stage 7, `/mcp-tokens`). Only Admin, Manager and
SuperAdmin hold it; everybody else, and every Candidate / Employer / Agency account, is refused. A PAT works **only** on `/mcp`:
every other route answers `401` to a `vita_pat_...` bearer, and the token endpoints themselves need a normal login. Tokens are
personal, shown once, hashed at rest, expire (default 30 days, max 90), max 5 active per user, and stop working the moment the
owner is deactivated or loses `mcp:use`. `MCP_ENABLED` (default off) switches the `/mcp` server itself; token management works either way.

<!-- mcp-permission-matrix:start -->
| Role | mcp:use |
|---|---|
| SuperAdmin | ✓ |
| Admin | ✓ |
| Manager | ✓ |
| Receptionist | — |
| Accountant | — |
| HR | — |
| Agent | — |
| Candidate | — |
| Employer | — |
| Agency | — |
<!-- mcp-permission-matrix:end -->

`chat:moderate` (Admin, Manager, SuperAdmin) hides / unhides a message with a reason and closes / reopens a conversation.

What each permission allows (always limited to the candidates the user may see):

- **jobsearch:read** — applications, matches, messages released to staff, interviews, dashboard, reports
  and CSV exports, the employer directory list, the recipient preview of an application.
- **jobsearch:write** (so **Agent and Receptionist too**, not only Managers) — create and cancel
  applications, prepare them (package + cover letter), import a job by hand (`POST /jobsearch/jobs/manual`),
  "Search now" for an assigned candidate (`POST /jobsearch/search/run`), record written consent with
  evidence, pause/resume an assigned candidate, edit profile and preferences, share an employer reply with
  the candidate, create reply drafts. They **cannot** approve, queue or send anything.
- **jobsearch:approve** (Manager, Admin, SuperAdmin) — approve or reject prepared applications, queue
  sends, approve a CV version on the candidate's behalf (with a note), record submission evidence and
  manual completions, apply reply classifications, assign unmatched replies, propose / cancel interviews,
  send reply drafts, change a candidate's mode (except to `automatic`).
- **jobsearch:admin** (Admin, SuperAdmin) — `automatic` mode, caps, allowed countries/professions/sources,
  module and source pauses, scheduler and queue runs, automation rules, the employer's verified **domain and
  contact address** and its **name** (Task 19/20: a rename re-keys job matching by normalized name and can
  redirect where a verified contact applies, so Managers cannot rename either), employer-support confirmations,
  candidate accounts, suspending/reinstating users (never one's own account, never the last active
  SuperAdmin).
- **Health** (`GET /jobsearch/health`) is shown to Manager, Admin and SuperAdmin.
- **users:write** (Admin, SuperAdmin) — create staff accounts, **set or change `candidates.assigned_to`**
  and **delete candidates** (Task 19). Because the assignment decides which staff member sees a
  candidate's job-search data, staff can no longer reassign a candidate: `PUT /candidates/:id` with a
  different `assigned_to` returns 403 for them. `POST /candidates/add` from a staff member assigns the new
  candidate to **that staff member only when the request sends `assigned_to`** (any value they send is
  replaced by their own id); when `assigned_to` is not sent the candidate is created **unassigned**, no
  staff member sees it in the job-search module, and only an admin can assign it later
  (`PUT /candidates/:id`). `DELETE /candidates/:id` is admin-only. `assigned_to` must be a user id or `null`
  (anything else, or an unknown id, is 400); an admin sending `null` unassigns the candidate, a staff member's
  `null` keeps the current value (Task 20).

Outside the module: the original routes `GET /candidates/all`, `GET /candidates/:id`, `PUT /candidates/:id`
(every field except `assigned_to`), `POST /candidates/:id/stage` (`visa:write`: Admin, Manager, Agent),
`GET /alerts/expiring`, `GET /notifications/latest` (and `POST /notifications/read/:id`) and `/finance/*` are
**not** scoped to assigned candidates (see CHECKLIST limitation 2). None of them exposes job-search data. `/documents` writes (POST/PUT/DELETE) are scoped for
Agent/Manager/Receptionist to their assigned candidates since Task 19.

**Candidates**

1. Create the CRM candidate (existing endpoint; `passport_number` is required by the original schema) and
   assign the responsible staff member:
   ```http
   POST /candidates/add
   { "full_name": "…", "passport_number": "…", "assigned_to": <staff user id> }
   ```
   Only an Admin/SuperAdmin can choose `assigned_to`. A staff member who sends `assigned_to` is assigned
   themselves whatever id they send; a staff member who leaves it out creates an **unassigned** candidate
   that only an admin can assign. Reassign later with `PUT /candidates/:id { "assigned_to": … }` (admin only).
2. Create the candidate's login, linked to that candidate:
   ```http
   POST /jobsearch/admin/candidate-accounts
   { "candidate_id": 123, "email": "candidate@example.com" }
   ```
   The account has no usable password. The candidate opens `https://YOUR-HOST/vita/portal.html`, enters the
   e-mail and receives a 6-digit code. **The code is sent through the mail adapter**: with the default
   sandbox it is only stored in the database (`js_sandbox_mail`), so real candidates can sign in only after
   real mail is set up (section 9).

Creating an account grants nothing. The candidate still has to upload a CV, confirm the profile and
preferences, and give consent. Before any application can be prepared, a CV version must also be
approved with its language. The candidate does it in the portal (step 1, "Approve this version for
applications", language en/fr/ar or another 2-letter code). A Manager or Admin can do it for the candidate
in the staff console (application drawer → "CV versions"), but only with a note of at least 10 characters
saying who asked, when and how; the note is stored in the audit trail. API:
`POST /jobsearch/cv-files/:id/approve { "language": "en" }` (candidate) or
`{ "language": "en", "note": "…" }` (staff).

## 7. Starting the server, workers and scheduler

```bash
NODE_ENV=production npm start
```

`server.js` starts, in the same process:

- the HTTP API and the `/vita/` pages;
- the existing alert scheduler;
- the **job-search queue workers** (every 30 s; off with `JOBSEARCH_WORKERS=off`);
- the **job-search scheduler** (every minute; off with `JOBSEARCH_SCHEDULER=off`). Each source is searched
  on its own `js_sources.schedule_cron` (UTC; default every 6 hours).

Rules:

- **Run one app process.** The scheduler takes a Postgres advisory lock so only one process ticks at a
  time, and each send takes a lock per submission. But rate limiters are in memory per process, so more
  processes mean looser limits.
- **Use direct or session-pooled Postgres connections.** The locks are *session-level*. PgBouncer in
  *transaction* pooling mode breaks them. Session pooling or no pooler is fine.
- Use a process manager (systemd, pm2 or Docker restart policy) so the app restarts after a crash. A send
  interrupted by a crash becomes `outcome_unknown`; it is never re-sent blindly.
- **Preflight (Task 20).** With `NODE_ENV=production`, `server.js` first checks the settings and **refuses to
  start** (exit 1), listing every problem by name (never a value): missing, short (< 32 characters) or
  placeholder `JWT_SECRET` / `STORAGE_URL_SECRET`, missing database settings, `TEST_DATABASE_URL` set,
  invalid `TRUST_PROXY` or ports, an unwritable `STORAGE_DIR`, `MAIL_REAL_SEND=true` without a complete
  `imap_smtp` setup (SMTP settings + `MAIL_FROM`), real mail together with `ALLOW_UNSCANNED_ATTACHMENTS=true`
  and no ClamAV, or a short `INBOUND_MAIL_SECRET`. It prints warnings (sandbox mode, no ClamAV, webhook
  disabled, scheduler/workers on or off) and starts.
- **Graceful stop.** On SIGTERM/SIGINT (`docker stop`, `systemctl stop`) the server stops the scheduler,
  workers and alert job, closes live-event streams, finishes in-flight requests and a running tick, closes
  the database pool (releasing the advisory locks) and exits 0; after `SHUTDOWN_TIMEOUT_MS` (default 25 s)
  it exits 1.

Example systemd unit (adapt paths and user):

```ini
[Unit]
Description=VITA trust-crm
After=network.target postgresql.service

[Service]
WorkingDirectory=/srv/emna/trust-crm
EnvironmentFile=/srv/emna/trust-crm/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=vita

[Install]
WantedBy=multi-user.target
```

## 8. Storage, private files

- CVs are stored by content hash under `STORAGE_DIR` (default `trust-crm/.storage`, git-ignored). Use an
  absolute path outside the code folder, e.g. `/var/lib/vita/storage`, owned by the app user, mode `700`.
- Never put `STORAGE_DIR` under a web-served folder. The app serves only `public/vita/`; files are
  downloaded through short-lived signed links that are re-authorized for the logged-in user.
- CRM documents referenced by the existing `/documents` routes are separate (metadata with a `file_path`).
- Back up `STORAGE_DIR` together with the database (section 11): rows point to files by hash.

### 8.1 Malware scanning (ClamAV)

Every upload is scanned when `CLAMAV_HOST` points to a `clamd` daemon (INSTREAM over TCP). Results:
`clean`, `infected` (the upload is refused with 422 and not stored) or `scan_unavailable` (no scanner, or it
did not answer in `CLAMAV_TIMEOUT_MS`).

**Policy (Task 18):** a CV marked `scan_unavailable` is kept and shown as "Not scanned", but it is **not
attached to any application** unless an administrator explicitly sets `ALLOW_UNSCANNED_ATTACHMENTS=true`.
Preparation stops with the blocked reason `attachment_unscanned`, approval refuses, and the pre-send check
fails with the code `attachment_unscanned`. The portal and the staff drawer say "Not scanned — an
administrator must enable scanning or explicitly allow unscanned files". The Health tab shows the setting.

Set up ClamAV (Debian/Ubuntu):

```bash
sudo apt install clamav-daemon clamav-freshclam
sudo systemctl enable --now clamav-freshclam clamav-daemon
# make clamd listen on TCP localhost:3310 (in /etc/clamav/clamd.conf: TCPSocket 3310, TCPAddr 127.0.0.1),
# then: sudo systemctl restart clamav-daemon
```

Then set `CLAMAV_HOST=127.0.0.1` (and `CLAMAV_PORT=3310`), restart the app, upload a test CV and check that
it shows "Clean". Files uploaded before ClamAV was connected stay `scan_unavailable`; ask the candidate to
upload them again (a new version is scanned). Only set `ALLOW_UNSCANNED_ATTACHMENTS=true` if you knowingly
accept forwarding files nobody scanned.

## 9. HTTPS and reverse proxy

Run the app behind an HTTPS reverse proxy (Caddy, nginx). Keep port 5000 closed to the internet.
The Docker kit (`deploy/hostinger/Caddyfile`) already does this, including immediate flushing and no
compression for `/jobsearch/events`. `GET /healthz` (no authentication) answers `{"ok":true}` when the app
and its database respond, `503 {"ok":false}` otherwise - use it for load-balancer / container health checks.

Caddy example:

```
vita.example.com {
  reverse_proxy 127.0.0.1:5000 {
    flush_interval -1        # needed for live events (server-sent events)
  }
}
```

nginx: `proxy_pass http://127.0.0.1:5000;` plus, for `/jobsearch/events`, `proxy_buffering off;` and a
read timeout above 60 s.

Set `TRUST_PROXY=1` (one proxy in front). Without it every request seems to come from the proxy, so all
users share one OTP and webhook rate-limit bucket. Do **not** set it when the app is reachable directly,
because then clients could fake `X-Forwarded-For`.

CORS: the app answers any origin (`cors()`, unchanged from the original CRM). Tokens travel in the
`Authorization` header, not cookies. If you want to limit origins, do it in the proxy.

## 10. Mail

### 10.1 Outgoing

The default is the sandbox: every "sent" message is only written to `js_sandbox_mail`, and only to
allow-listed recipients. Nothing leaves the server.

To send real mail, all of these must be true:

1. `MAIL_PROVIDER=imap_smtp`
2. `MAIL_SMTP_HOST`, `MAIL_SMTP_USER`, `MAIL_SMTP_PASS` (and `MAIL_SMTP_PORT` if not 587; it must be
   1–65535) set. The `MAIL_IMAP_*` variables are **not** needed (since Task 18).
3. `MAIL_REAL_SEND=true`
4. `MAIL_FROM` set to a plain address of your domain (`jobs@your-domain.example`) with SPF, DKIM and DMARC
   configured at your mail host. **Required:** without it nothing is sent (Task 19). Replies to our mail go
   to `MAIL_REPLY_TO` (or `MAIL_FROM`), plus-addressed with the reply token, and the Message-IDs use the
   `MAIL_FROM` domain, so that mailbox must be the one your inbound bridge reads.

The Health tab shows the mail adapter:

- With the **sandbox** (default): "Sandbox — no real mail is sent" (the API reports `mode: "sandbox"`; its
  `status` stays `connected` for compatibility, which only means the sandbox works).
- With `imap_smtp`: outbound `connected` only when the SMTP settings **and** `MAIL_FROM` are valid and
  `MAIL_REAL_SEND=true` (a configuration check, not a live connection test); `configured_send_disabled`
  when only `MAIL_REAL_SEND` is missing; `not_configured` otherwise, and Health lists the names of the
  missing or invalid variables (`problems`, e.g. `MAIL_FROM`; never their values). Inbound shows `webhook`
  when `INBOUND_MAIL_SECRET` is set, else `requires_setup`. The overall status is `connected` only when
  both are.

Test first with `MAIL_PROVIDER=sandbox` and a `MAIL_SANDBOX_ALLOWLIST` of your own test address, then
switch to real sending with one candidate whose account e-mail is yours. The sandbox allow-list does **not**
apply to `imap_smtp`: once real sending is on, the pre-send guard and recipient rules are the protection.

Even with real mail on, **no application is sent automatically until** a candidate is in `automatic` mode
with submit consent, an admin-approved rule, allowed countries, approved document versions and caps above
0 (section 12.3).

### 10.2 Incoming (webhook)

Replies reach the module only through `POST /jobsearch/inbound/mail`. You need a bridge that receives
mail for `MAIL_REPLY_TO` and posts it here (options in SOURCES_AND_PROVIDERS.md).

**Signature.** The bridge computes `HMAC-SHA256(INBOUND_MAIL_SECRET, raw request body)` and sends header
`X-VITA-Signature: sha256=<hex>`. Wrong or missing signature → 401. Unset secret → 503.

**Message body** (JSON):

```json
{
  "messageId": "<abc123@mail.employer.example>",
  "inReplyTo": "<the Message-ID of our application e-mail>",
  "references": "<id1> <id2>",
  "from": "Hiring Team <jobs@employer.example>",
  "to": ["replies+VITA-token@yourdomain.example"],
  "replyTo": [],
  "subject": "Re: Application …",
  "text": "plain text body",
  "html": "optional HTML body (used only when text is empty)",
  "receivedAt": "2026-10-23T10:00:00Z",
  "headers": { "Auto-Submitted": "auto-replied", "Precedence": "bulk" },
  "attachments": [ { "filename": "invite.pdf", "contentType": "application/pdf", "size": 12345 } ],
  "authResults": "mx.yourdomain.example; dkim=pass header.d=employer.example; spf=pass; dmarc=pass"
}
```

- `messageId` is required. `references` may be a string or an array.
- `authResults` may be a header string, an array of header strings, or `{ "dkim": "pass", "spf": "pass",
  "dmarc": "pass", "dkimDomain": "employer.example" }`. Any `fail`, `permerror` or `temperror` means the
  message is never matched automatically. With `INBOUND_AUTH_REQUIRED=true` (default) a message without
  results is never matched automatically either; it goes to the review queue.
- **Trust:** pass only the Authentication-Results written by **your own** receiving server, and strip any
  Authentication-Results headers that came with the message from outside. Set `INBOUND_AUTHSERV_ID` to
  your server's id so only those count.
- Attachments: only metadata is stored. Content is never stored or opened; executables are dropped.

**Delivery receipts** (optional), same signature:

```json
{ "type": "delivery_status", "originalMessageId": "<our Message-ID>", "action": "delivered", "reportId": "provider-event-id", "receivedAt": "…" }
```

`action: "delivered"` records a delivery receipt and marks the submission **confirmed submitted**. Send
these only from your mail provider's genuine delivery events.

## 11. Backups and restore test

### 11.1 Backup (daily)

```bash
# database (custom format, compressed)
pg_dump --format=custom --no-owner --file=/backups/trustcrm-$(date +%F).dump "$DATABASE_URL"
# private files
tar -C "$(dirname "$STORAGE_DIR")" -czf /backups/storage-$(date +%F).tar.gz "$(basename "$STORAGE_DIR")"
```

Keep copies off the server, encrypted (they contain CVs and personal data). Decide a retention period
(section 14).

### 11.2 Restore

```bash
systemctl stop vita                         # stop the app
dropdb trustcrm && createdb -O trustcrm trustcrm
pg_restore --no-owner --dbname=trustcrm /backups/trustcrm-YYYY-MM-DD.dump
rm -rf "$STORAGE_DIR" && tar -C "$(dirname "$STORAGE_DIR")" -xzf /backups/storage-YYYY-MM-DD.tar.gz
systemctl start vita
```

### 11.3 Restore test (monthly)

```bash
createdb trustcrm_restore_test
pg_restore --no-owner --dbname=trustcrm_restore_test /backups/trustcrm-YYYY-MM-DD.dump
psql -d trustcrm_restore_test -c "SELECT count(*) FROM users; SELECT count(*) FROM candidates; SELECT count(*) FROM js_cv_files;"
psql -d trustcrm_restore_test -c "SELECT name FROM schema_migrations ORDER BY name;"
mkdir /tmp/storage-test && tar -C /tmp/storage-test -xzf /backups/storage-YYYY-MM-DD.tar.gz && ls /tmp/storage-test/* | wc -l
dropdb trustcrm_restore_test; rm -rf /tmp/storage-test
```

The counts should match production at backup time, and the number of files should be at least the number
of distinct `js_cv_files.storage_key` values.

## 12. Operation

### 12.1 Everyday controls (admin console or API)

| Task | Where | API |
|---|---|---|
| Pause / resume the whole module | Dashboard (admin) | `POST /jobsearch/module/pause` `{ "paused": true }` (admin) |
| Pause / resume a source | Sources | `POST /jobsearch/sources/:key/pause` · `/resume` (admin) |
| Pause / resume a candidate | Dashboard | `POST /jobsearch/candidates/:id/pause` `{ "paused": true }` |
| Search now for a candidate | Dashboard | `POST /jobsearch/search/run` (queued, answered 202) |
| Scheduler status / run one tick now | Scheduler | `GET /jobsearch/scheduler/status` · `POST /jobsearch/scheduler/tick` (admin) |
| Run the send queue now | — | `POST /jobsearch/queue/run` (admin) |
| Health (sources, queue, stuck items, tasks) | Health | `GET /jobsearch/health` (Manager, Admin) |
| Reports / CSV export | Reports | `GET /jobsearch/reports`, `GET /jobsearch/export.csv?type=applications\|matches\|submissions\|messages\|tasks` |
| Withdraw consent for a candidate | Portal (candidate) | `POST /jobsearch/candidates/:id/consent/withdraw` `{ "scopeKey": "submit" }` (`search`, `prepare`, `submit` or `all`) |
| Suspend / reinstate a user (staff or candidate; ends their sessions) | — | `POST /jobsearch/admin/users/:id/suspend` · `/reinstate` (admin; your own account and the last active SuperAdmin are refused with 409) |
| Approve a CV version | Portal step 1 (candidate) · drawer "CV versions" (Manager/Admin, note required) | `POST /jobsearch/cv-files/:id/approve` |
| Employer directory: verified domain / contact and name (Admin only, Task 20) | Employers & rules | `GET /jobsearch/employers?q=` · `PUT /jobsearch/employers/:id` `{ "domain", "verifiedContactEmail", "name" }` (any non-admin, Managers included, gets 403) |
| Add a job by hand | Employers & rules (staff with write access) | `POST /jobsearch/jobs/manual` |
| Record / revoke employer-support confirmation | Employers & rules (Admin) | `POST /jobsearch/employer-confirmations` · `GET` (list) · `DELETE /jobsearch/employer-confirmations/:id` |
| Automation rules | Employers & rules (Admin) | `GET /jobsearch/automation-rules` · `POST` · `DELETE /jobsearch/automation-rules/:id` (disables) |
| Audit trail | — | `GET /audit-logs` (existing) and the `js_audit_events`, `js_timeline` tables |

A pause **holds** work: queued sends go back to "approved" and are re-queued once on resume. Consent
withdrawal and suspension **cancel** work; nothing is resurrected later.

`POST /jobsearch/scheduler/tick` runs a full tick inside the request, so it can take a while.

### 12.2 Handling `outcome_unknown` (delivery uncertain)

This happens when the mail provider did not answer clearly (timeout, crash during the call). The system
**never** re-sends it by itself, because the employer may already have it.

1. Open the "verify delivery" task (Review tab). The application is in "Needs staff".
2. Check the SMTP provider's log or the "Sent" folder of the sending account for that application.
3. If it was delivered: record evidence with a note of at least 10 characters:
   `POST /jobsearch/submissions/:id/evidence { "kind": "manual_confirmation", "detail": { "note": "Found in provider log, accepted 10:02 UTC" } }`
   (Manager or Admin). The submission becomes confirmed submitted.
4. If it was clearly **not** delivered: the system will not send this application again (the pre-send
   check blocks a second attempt after an unknown outcome). Send it yourself through the employer's
   channel, then record it:
   `POST /jobsearch/applications/:id/manual-completion { "note": "Re-sent by hand from …", "channel": "email", "recipient": "jobs@employer.example" }`
5. If you cannot tell, leave it in "Needs staff" and contact the employer.

### 12.3 Automatic mode (admin)

Automatic sending needs **all** of the following. Since Task 18 every item has a screen ("Employers &
rules" tab) and an API; no SQL is needed.

1. Candidate consent includes `submit` (given by the candidate, or recorded by staff with evidence).
2. An admin sets the candidate's settings (`PUT /jobsearch/candidates/:id/settings`):
   `mode: "automatic"`, `cap_per_day` and `cap_per_week` > 0, `allowed_countries` (required), optional
   `allowed_professions` / `allowed_sources`, and `approved_doc_versions` listing the CV versions that may
   be sent, e.g. `[{ "cvFileId": 12, "version": 2 }]`. Leave `salary_limit` null (a salary limit blocks
   automatic approval because job salaries cannot be verified).
3. The candidate's CV version is approved with its language (portal step 1, or a Manager/Admin in the
   drawer with a note; **every** mode needs it before an application can be prepared). It must be scanned
   clean (section 8.1).
4. An approved automation rule (Admin, "Employers & rules" → Automation rules, or
   `POST /jobsearch/automation-rules`):
   ```json
   { "candidateId": 123, "type": "auto_submit", "countries": ["Canada"], "professions": ["Electrician"], "employerIds": [45], "note": "…" }
   ```
   `countries` is required; `professions`, `sources` and `employerIds` narrow it further (every rule must
   allow the job). `type: "ack_reply"` with `employerIds` enables automatic acknowledgement replies to those
   employers. The rule is recorded with your user id; `DELETE /jobsearch/automation-rules/:id` disables it
   (history is kept).
5. The employer's verified domain or contact address (automatic sends go only there): "Employers & rules"
   → Employer directory → Edit, or `PUT /jobsearch/employers/:id { "domain": "employer.example",
   "verifiedContactEmail": "jobs@employer.example" }`. Verify the address with the employer first. Free-mail
   domains, addresses, ports and IP addresses are refused as a domain; internationalised domains are stored
   in their `xn--` form.
6. For a candidate who needs work-permit support and applies outside their country of residence: an
   employer-support confirmation recorded by an admin with evidence (`POST /jobsearch/employer-confirmations`),
   and the ad must explicitly accept overseas applicants. Otherwise the application waits for human approval.

Anything that fails these checks stays "Ready for review" with a task explaining why.

## 13. Demo seed (development only)

`scripts/dev-seed-ui.js` fills a database with DEMO logins and data for trying the UI. **Never run it
against a production database.** It refuses to run (exit code 2, nothing written) when:

- `NODE_ENV=production`, or `NODE_ENV` is anything other than `development` / `test` (or unset with a
  local database);
- the database host is not local (localhost, 127.0.0.1, ::1, unix socket), unless `VITA_SEED_ALLOW_REMOTE=1`
  (and never when `NODE_ENV` is unset);
- the `users` table already has a non-demo user, unless `VITA_SEED_FORCE=1`;
- `VITA_SEED_PASSWORD` is shorter than 12 characters.

The demo users use `@test.invalid` addresses. If a production database was ever seeded by mistake, delete
the `demo.*@test.invalid` users and all rows labelled DEMO before going live.

## 14. Security checklist before production

- [ ] New `JWT_SECRET`, `STORAGE_URL_SECRET`, `JOBSEARCH_REPLY_SECRET`, `INBOUND_MAIL_SECRET` (each a
      random value of 32+ bytes, e.g. `openssl rand -hex 32`), and a new database password. The values in
      the old committed `trust-crm/.env` (git history) must not be reused anywhere.
- [ ] `NODE_ENV=production`; `TEST_DATABASE_URL` unset.
- [ ] No demo seed data (section 13).
- [ ] HTTPS only; port 5000 and Postgres (5432) closed to the internet by the firewall.
- [ ] `TRUST_PROXY` set to match the proxy; rate limiting also at the proxy/gateway.
- [ ] ClamAV connected (`CLAMAV_HOST`), and an upload checked to show "clean"; `ALLOW_UNSCANNED_ATTACHMENTS`
      unset (section 8.1).
- [ ] Every staff member logged in again after the upgrade (tokens issued before Task 18 cannot be revoked
      until they expire), or `JWT_SECRET` rotated.
- [ ] `STORAGE_DIR` private, backed up, restore tested (section 11.3).
- [ ] Logs: the app does not log OTP codes or request bodies on `/jobsearch`, but your proxy may log URLs
      and headers. Do not log `Authorization` headers or request bodies at the proxy.
- [ ] `INBOUND_AUTO_ACK_EVIDENCE=false`, `INBOUND_AUTH_REQUIRED=true`, `INBOUND_AUTHSERV_ID` set.
- [ ] Real mail tested with your own address before any candidate is in automatic mode.
- [ ] Data protection review: what personal data you hold (CVs, contact details, documents), the legal
      basis and consent text (`2026-10-v1` in the portal), how long you keep CVs, backups and logs, and how a
      candidate's data is deleted on request. Decide retention periods; the module does not delete data on
      a timer.
- [ ] `MAIL_FROM` set to a plain address of your domain (Health shows no `problems` for mail).
- [ ] Decide whether the remaining unscoped original routes (`GET /candidates/all`, `GET /candidates/:id`,
      `POST /candidates/:id/stage`, `/finance`) are acceptable for your staff (CHECKLIST limitation 2).
      Assignment changes and deletions are admin-only, and `/documents` writes are scoped (Task 19).
