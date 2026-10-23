# HTTP API

Full endpoint list (generated from the route files): [generated/api-endpoints.md](generated/api-endpoints.md). Authorisation per endpoint is in the service layer; see [PERMISSIONS.md](PERMISSIONS.md).

* **Base**: `/api`. JSON in/out. **Auth**: `Authorization: Bearer <token>` from `POST /api/auth/login` (or `/login/mfa`). No cookies.
* **Errors**: `{ "error": { "code": "snake_case", "message": "…", "details": …, "correlation_id": "…" } }` with status 400 (bad request), 401 (unauthenticated), 403 (gate/permission), 404 (not found *or not yours*), 409 (state/conflict), 422 (validation / business rule), 429 (rate/limit; `details.retry_after_seconds`), 413, 500. Clients should switch on `code`, not `message`. Send `X-Correlation-Id` to trace a request; it is echoed back and stored in audit rows.
* **Concurrency**: mutable resources carry `version`; send it back on `PATCH` (`409 version_conflict` if stale). Application submission accepts `Idempotency-Key`.
* **Pagination**: `limit` (≤100) and `offset`; public job search returns `{items,total,limit,offset}`; audit uses a `before` cursor.
* **Versioning**: unversioned in Phase 1. **Freeze under `/api/v1` before any native client ships** (backlog B-01).

## Flows worth knowing
```text
Register  POST /auth/register          → 202 (always; no account enumeration)
Verify    POST /auth/verify-email      {email, code}   errors: otp_invalid | otp_expired | otp_locked | otp_cooldown | otp_resend_limited
Login     POST /auth/login             → {token} | {mfa_required, mfa_token} | {token, mfa_enrollment_required}
Me        GET  /me                     → status (verified/approval/MFA/org verification/profile completion) + effective permissions
Apply     POST /candidate/applications {job_id, cover_note}  + Idempotency-Key   → 201 | 200 replay | 409 already_applied | 422 profile_incomplete
Qualify   POST /staff/leads/:id/qualify {resolution?}        → 200 | 409 duplicate_review_required {reviews:[…]}
Review    POST /admin/jobs/:id/review  {decision, note?, override_unverified_reason?}
```

## Webhooks
Outbound and inbound contracts, signature scheme, event catalogue and retry semantics: [INTEGRATION.md](INTEGRATION.md) §3–§6. A machine-readable OpenAPI description is on the backlog (B-02); today the zod schemas in `src/http/schemas.js` are the validation source of truth.
