# CLAUDE.md

Guidance for AI assistants (and humans) working in this repository.

## What this repository is

`emna` is the backend for **EMNA Services CRM** — a production REST API for a
visa / recruitment agency ("Emna Visa Services"). It tracks candidates through a
visa lifecycle, manages document metadata, runs finance (invoices, payments,
expenses), and sends expiry alerts / notifications, all behind role-based access
control with audit logging.

The entire application lives in the [`trust-crm/`](trust-crm/) subdirectory. The
repository root only holds the `LICENSE`, a one-line `README.md`, and a `Makefile`
that proxies to the app's tests.

## Tech stack

- **Runtime:** Node.js (Docker image pins `node:18`)
- **Framework:** Express 4
- **Database:** PostgreSQL via the `pg` driver (raw SQL, no ORM)
- **Auth:** `jsonwebtoken` (JWT) + `bcrypt` password hashing
- **Scheduling:** `node-cron` for the daily alert job
- **Config:** `dotenv`
- **Mail:** `nodemailer` is a dependency but not yet wired into a route
- **Tests:** Node's built-in test runner (`node --test`) — no external test framework

## Repository layout

```
.
├── LICENSE
├── Makefile              # `make test` → runs the app test suite
├── README.md             # placeholder ("# emna")
└── trust-crm/            # the actual application
    ├── server.js         # entry point: loads env, starts scheduler, listens
    ├── app.js            # builds the Express app, mounts routes, error handler
    ├── db.js             # exports a shared pg Pool
    ├── package.json      # scripts: start, test
    ├── Dockerfile        # node:18, EXPOSE 5000, `npm start`
    ├── .env.example      # template for required env vars
    ├── README.md         # detailed API/setup docs (keep in sync with reality)
    ├── ai/
    │   └── aiEngine.js   # scoreCandidate() heuristic → "Hot"/"Warm"/"Cold"
    ├── jobs/
    │   └── alertScheduler.js  # cron job: expiry → notifications
    ├── middleware/
    │   ├── auth.js       # verifyToken (JWT)
    │   └── role.js       # PERMISSIONS map + checkRole / checkPermission
    ├── models/
    │   ├── candidateModel.js  # candidate CRUD (raw SQL, transactional create)
    │   └── userModel.js       # user create/find/count
    ├── routes/
    │   ├── auth.js          # /auth   (bootstrap, login, register)
    │   ├── candidates.js    # /candidates
    │   ├── documents.js     # /documents
    │   ├── finance.js       # /finance
    │   ├── alerts.js        # /alerts
    │   ├── notifications.js # /notifications
    │   └── audit.js         # /audit-logs
    ├── sql/
    │   ├── schema.sql       # canonical table definitions + indexes
    │   └── rls_policies.sql # optional Supabase/Postgres RLS policies
    ├── tests/               # *.test.js (node:test)
    └── utils/
        ├── audit.js         # logAudit() → audit_logs
        └── finance.js       # validatePaymentAmount() pure helper
```

## Architecture & request flow

The app follows a conventional layered Express structure:

1. **`server.js`** loads env vars, calls `startAlertScheduler()` (guarded in a
   try/catch so a scheduler failure never blocks the HTTP server), then
   `app.listen(PORT)` — default port **5000**.
2. **`app.js`** wires middleware (`cors`, `express.json({ limit: "10mb" })`),
   a public `GET /` health/status route, mounts each route module under its
   prefix, and ends with a catch-all error handler returning `500`.
3. **Routes** apply middleware in the order `verifyToken` → `checkPermission(...)`,
   then either call a **model** (candidates, users) or run SQL directly via
   `db` (finance, documents, alerts, notifications, audit).
4. **`db.js`** exposes a single shared `pg.Pool`. Use `db.query(sql, params)` for
   one-off queries and `db.connect()` when you need an explicit
   `BEGIN`/`COMMIT`/`ROLLBACK` transaction with a dedicated client.

### Auth & RBAC

- Login (`POST /auth/login`) returns a JWT signed with `JWT_SECRET`, expiring in
  7 days, carrying `{ id, role }`.
- `verifyToken` (`middleware/auth.js`) reads `Authorization: Bearer <token>`,
  verifies it, and sets `req.user`.
- Authorization is **permission-based**, not just role-based. `middleware/role.js`
  holds a `PERMISSIONS` map from role → list of `resource:action` strings
  (e.g. `candidates:write`, `finance:read`). `SuperAdmin` has `"*"` (all).
  `checkPermission("candidates:write")` is the primary guard used in routes;
  `checkRole(...)` also exists but is rarely used.
- Roles (must stay in sync with the DB `CHECK` constraint in `sql/schema.sql`):
  `SuperAdmin`, `Admin`, `Manager`, `Receptionist`, `Accountant`, `HR`, `Agent`.
- First user is created via `POST /auth/bootstrap-super-admin`, which is
  **disabled once any user exists** (`countUsers() > 0`). After that, users are
  created through `POST /auth/register` (requires `users:write`).

### Audit logging

Every meaningful write goes through `utils/audit.js` → `logAudit(...)`, inserting
into `audit_logs` with `action`, `table_name`, `record_id`, and JSONB
`old_data` / `new_data`. When you add a new write endpoint, **call `logAudit`**
to match the established pattern.

### Soft deletes

Candidates, documents, invoices, payments, and expenses use an `is_deleted`
boolean (and sometimes `deleted_at`) rather than hard `DELETE`. Read queries
filter `WHERE is_deleted=false`. Preserve this convention.

### Transactions

Multi-step writes that must stay consistent use an explicit client transaction:
- `candidateModel.createCandidate` — inserts a candidate **and** its
  `visa_applications` row atomically.
- `finance.js` `POST /payments` — locks the invoice `FOR UPDATE`, validates via
  `validatePaymentAmount`, inserts the payment, and updates the invoice's
  `remaining_amount` / `status`, all in one transaction.

Follow this pattern (BEGIN → work → COMMIT, ROLLBACK on error, `client.release()`
in `finally`) for any new critical multi-write flow.

### Scheduler

`jobs/alertScheduler.js` runs daily at **08:00** (`cron.schedule("0 8 * * *")`)
and upserts `notifications` for candidates whose `passport_expiry`, `b3_expiry`,
or `embassy_date` falls within `DAYS = 20`. `generateAlerts` is exported
separately so it can be invoked/tested without the cron wrapper.

## Data model (see `sql/schema.sql` for the source of truth)

Core tables: `users`, `candidates`, `visa_applications` (1:1 with candidate),
`documents`, `invoices`, `payments`, `expenses`, `notifications`, `audit_logs`.

Candidate visa lifecycle is tracked by `candidates.visa_status` and the linked
`visa_applications.stage` (default `'Documents'`). Updating a stage via
`POST /candidates/:id/stage` writes both the `visa_applications` row and the
candidate's `visa_status`.

`sql/rls_policies.sql` contains **optional** Row-Level Security policies for
Supabase / Postgres deployments that authorize via JWT claims (`auth.jwt()`).
These are not required for the plain Express + JWT flow.

## API surface (prefixes mounted in `app.js`)

| Prefix           | Module               | Notable endpoints |
|------------------|----------------------|-------------------|
| `/`              | `app.js`             | `GET /` status (public) |
| `/auth`          | `routes/auth.js`     | `POST /bootstrap-super-admin`, `/login`, `/register` |
| `/candidates`    | `routes/candidates.js` | `POST /add`, `GET /all?search=`, `GET/PUT/DELETE /:id`, `POST /:id/stage` |
| `/documents`     | `routes/documents.js` | `POST /`, `PUT /:id`, `DELETE /:id` (metadata only) |
| `/finance`       | `routes/finance.js`  | `GET /dashboard`, `POST /invoices`, `POST /payments` |
| `/alerts`        | `routes/alerts.js`   | `GET /expiring` |
| `/notifications` | `routes/notifications.js` | `GET /latest`, `POST /read/:id` |
| `/audit-logs`    | `routes/audit.js`    | `GET /?limit=` (max 500) |

## Development workflow

All commands run **inside `trust-crm/`** unless noted.

```bash
cd trust-crm
npm install
cp .env.example .env    # then edit values
npm start               # node server.js  → http://localhost:5000
```

### Database setup

```bash
psql -d trustcrm -f sql/schema.sql
psql -d trustcrm -f sql/rls_policies.sql   # optional, Supabase/RLS only
```

### Environment variables (`.env`)

`PORT`, `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`, `JWT_SECRET`.
`.env` is gitignored — never commit real secrets. Keep `.env.example` updated
when you introduce a new variable.

### Docker

```bash
cd trust-crm
docker build -t emna-crm .
docker run -p 5000:5000 --env-file .env emna-crm
```

## Testing

Tests use Node's built-in runner (`node --test tests/*.test.js`). Run from the
repo root or the app dir:

```bash
make test            # from repo root — runs `npm test` in trust-crm
# or
cd trust-crm && npm test
```

Existing tests (`trust-crm/tests/`):
- `smoke.test.js` — boots the Express app on an ephemeral port and asserts `GET /`.
- `finance.test.js` — unit-tests the pure `validatePaymentAmount` helper.
- `role.test.js` — asserts the `PERMISSIONS` map covers required roles.
- `candidate-model.test.js` — tests `updateCandidate` field-merge logic by
  **monkey-patching `db.query`** (no live DB needed).

### Conventions for new tests

- Use `node:test` + `node:assert/strict` — no Jest/Mocha.
- Prefer testing pure helpers (like `utils/finance.js`) directly.
- For model logic, stub `db.query` (see `candidate-model.test.js`) so tests run
  without a database. Keep DB-dependent behavior thin and push logic into pure
  functions where practical.
- Name files `*.test.js` under `trust-crm/tests/` so the glob picks them up.

## Conventions & guidance for changes

- **Language/style:** CommonJS (`require` / `module.exports`), double-quoted
  strings, 2-space indentation, `async/await` with try/catch in every route,
  returning JSON `{ error: ... }` on failure. Match the surrounding style.
- **Raw parameterized SQL only** — always use `$1, $2, ...` placeholders; never
  string-interpolate user input into SQL.
- **Every new write endpoint** should: guard with `verifyToken` +
  `checkPermission(...)`, validate required body fields (return `400` if
  missing), perform the write, and call `logAudit(...)`.
- **Preserve soft-delete and transaction patterns** described above.
- **Keep the two READMEs and this file honest.** `trust-crm/README.md` documents
  the API in detail; update it (and this file) when routes, roles, env vars, or
  the schema change.
- **New roles/permissions** must be added in three places consistently:
  `middleware/role.js` `PERMISSIONS`, the `role` `CHECK` constraint in
  `sql/schema.sql`, and (if relevant) `role.test.js`.

## Git workflow

- Default branch: `main`. Feature work here lands via pull requests (see history:
  `codex/*` branches merged into `main`).
- Make small, descriptive commits. Run `make test` before pushing.
