# EMNA Services CRM API

Production backend API for visa/recruitment CRM operations.

## Features

- Role-based access control (permissions)
- Candidate lifecycle with visa stage tracking
- Document metadata management (upload/replace/delete metadata)
- Finance workflows (invoices, payments, in/out dashboard totals)
- Notifications and expiry alerts scheduler
- Audit logging for critical write actions
- Transaction-safe database writes for critical flows

## 1) Setup

```bash
npm install
cp .env.example .env
npm start
```

## 2) Environment variables

```env
PORT=5000
DB_HOST=localhost
DB_USER=postgres
DB_PASSWORD=yourpassword
DB_NAME=trustcrm
DB_PORT=5432
JWT_SECRET=change_this_to_long_random_secret
```

## 3) Database

Run SQL in order:

```bash
psql -d trustcrm -f sql/schema.sql
# Optional for Supabase/Postgres JWT-claim authorization
psql -d trustcrm -f sql/rls_policies.sql
```

## 4) Authentication flow

### Step A: Bootstrap first super admin (only once)

```http
POST /auth/bootstrap-super-admin
Content-Type: application/json

{
  "full_name": "Super Admin",
  "email": "admin@example.com",
  "password": "StrongPassword123!"
}
```

### Step B: Login

```http
POST /auth/login
```

### Step C: Create users (requires `users:write` permission)

```http
POST /auth/register
Authorization: Bearer <token>
```

## 5) Main modules and endpoints

### Candidates
- `POST /candidates/add`
- `GET /candidates/all?search=`
- `GET /candidates/:id`
- `PUT /candidates/:id`
- `DELETE /candidates/:id` (soft delete)
- `POST /candidates/:id/stage`

### Documents
- `POST /documents`
- `PUT /documents/:id`
- `DELETE /documents/:id`

### Finance
- `GET /finance/dashboard`
- `POST /finance/invoices`
- `POST /finance/payments` (transactional payment + invoice update)

### Notifications / Alerts
- `GET /alerts/expiring`
- `GET /notifications/latest`
- `POST /notifications/read/:id`

### Audit
- `GET /audit-logs?limit=100`

## 6) Security notes

- Passwords are hashed with bcrypt.
- Protected routes require JWT authentication.
- Permissions are enforced with middleware.
- Critical write actions are logged to `audit_logs`.
- Soft-delete is used for sensitive entities.
- Optional RLS policies are provided for Supabase deployments.

## 7) Production recommendations

- Run behind HTTPS reverse proxy.
- Rotate JWT secret and DB credentials.
- Use private storage + signed URLs for real document delivery.
- Enable daily backups and restore checks.
- Add API rate limiting/WAF at gateway level.

## 8) Tests

```bash
make test
```

This runs `npm test` in `trust-crm` and executes all Node.js tests in `tests/*.test.js`.

## 9) VITA AI Job Search & Applications module (البحث الآلي عن عمل)

An additive module under `/jobsearch/*` (API) and `/vita/` (admin console `admin.html`, candidate portal
`portal.html`). It takes a candidate from CV upload and consent to matching, truthful application
preparation, e-mail submission within recorded consent and admin rules, reply tracking and interviews.
Existing tables and routes are unchanged; new tables are prefixed `js_`.

After `sql/schema.sql`, apply the module's migrations (idempotent, one transaction per file):

```bash
npm run migrate
node scripts/verify-migrations.js   # optional dry run on throwaway schemas
```

Status: the code and tests are complete, but the module is **not production-ready** until the owner
connects a job source, real mail, ClamAV and HTTPS. By default mail goes to a database sandbox and no job
feed is connected.

- [Requirement checklist (what is done, tested, blocked)](../docs/vita-job-search/CHECKLIST.md)
- [Setup and operations](../docs/vita-job-search/SETUP.md)
- [Sources and providers the owner must connect](../docs/vita-job-search/SOURCES_AND_PROVIDERS.md)
- [User guide (staff and candidates)](../docs/vita-job-search/USER_GUIDE.md)

All environment variables are listed in `.env.example`.
