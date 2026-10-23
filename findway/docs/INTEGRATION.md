# Integration architecture: FIND WAY ⇄ trust-crm (and other systems)

Operational synchronisation uses **APIs and signed webhooks**. MCP is the AI-facing tool interface ([MCP_DESIGN.md](MCP_DESIGN.md)); it is not used to keep systems in sync.

Everything here is implemented in `src/integrations/` and proven by `tests/integration.test.js`, which boots the **real `trust-crm` application** (from `../trust-crm`) on its own database and drives the adapter against it. Where the live production CRM may differ, that is flagged *Blocked*.

## 1. Systems and adapters

| System | Direction | Mechanism | Status |
|---|---|---|---|
| trust-crm (visa/case CRM) | FIND WAY → trust-crm | REST adapter with a dedicated service account | Implemented, tested against real code |
| trust-crm → FIND WAY | inbound | HMAC-signed webhooks **or** reconciliation poller | Receiver implemented + tested; trust-crm has no emitter today, so the poller is the working path |
| Any subscriber (BI, website, partner) | FIND WAY → them | Signed outbound webhooks with subscriptions | Implemented, tested |
| "Platform"/website, other CRM instances | — | Not in the repository | Blocked (need URLs/docs) |
| MCP clients | read/act through services | Phase 3 | Deferred |

Because the two systems have **separate backends**, the full separate-backend rule set applies; each item maps to code:

| Requirement | Where |
|---|---|
| Adapter per external system | `integrations/trustcrm/{client,adapter}.js` |
| Source of truth per entity/field; sync direction | §4 below |
| Canonical ↔ external id mapping | `external_mappings` (unique both ways; `link_mode`) |
| Version / timestamp / sync origin | `canonical_version`, `last_event_at`, `last_synced_at`, `sync_origin`, `outbox_events.origin` |
| No update loops | events carry `origin`; deliveries to the origin system are recorded `skipped: origin_is_target`; content hashes make repeats no-ops |
| Idempotency keys | outbound: `X-FindWay-Event-Id`; inbound: unique `(source, event_id)`; applications: `Idempotency-Key` |
| Duplicate / out-of-order events | duplicates return `status: duplicate`; events older than `last_event_at` are `stale_ignored` |
| Optimistic concurrency + conflict queue | entity `version`; mapping `canonical_version`; `sync_conflicts` with resolve-local/remote |
| Retry with backoff, dead-letter, replay | `dispatcher.js`, `dead_letters`, admin replay |
| Reconciliation | `inbound.reconcile()` + admin "Reconcile now" |
| Deletion / consent / revocation propagation | `consent.revoked` event emitted; deletion workflow is Phase 2 (requests are tracked, not yet executed) |

## 2. trust-crm contract the adapter relies on

Observed from `trust-crm/routes/*.js` (not from a live system):

| Purpose | Call | Notes / quirks handled |
|---|---|---|
| Authenticate | `POST /auth/login {email,password}` → `{token}` | Service account must exist, role with `candidates:read/write`, `visa:write`. JWT lives 7 days; the client re-logs in once on `401` **or `400` "Invalid token"** (trust-crm returns 400 for bad tokens). Wrong credentials → `AuthError` → status `auth_failed`. |
| Health/connection test | `GET /candidates/all?search=__findway_ping__` | Authenticated round-trip; must return an array. This — not "the port answered" — is what turns the card green. |
| Find existing | `GET /candidates/all?search=<passport>` | ILIKE on name/passport, **unpaginated**; adapter requires an exact normalised passport match. |
| Create | `POST /candidates/add {full_name, nationality, date_of_birth, passport_number, passport_expiry}` → `{id, …, visa_application}` | `passport_number` is `NOT NULL UNIQUE`, hence a person cannot be created without one (deliveries are `blocked: missing_passport_number`, surfaced in the Integration Center, and re-evaluated on the next `candidate.updated`). trust-crm creates its own `visa_applications` row (stage `Documents`). |
| Update | `PUT /candidates/:id` | Partial merge (`??`), so only FIND WAY-owned fields are sent. |
| Stage | `POST /candidates/:id/stage {stage,status,notes}` | Requires an existing `visa_applications` row (otherwise 404 ⇒ `blocked`). Stage is free text; mapped via setting `crm.case_stage_map`. One visa application per candidate (UNIQUE) — so one live FIND WAY case per person is the supported shape. |
| Read for reconcile | `GET /candidates/:id` | Provides `visa_status`, `passport_expiry`, `updated_at`. |

Quirks recorded: dates come back as ISO timestamps built from `DATE` columns (server time zone dependent — keep trust-crm on UTC); `500` responses include raw `err.message`; no pagination; no rate limits.

## 3. Event catalogue

Envelope (webhook body and internal outbox row share this shape):

```json
{
  "id": "uuid",                       // idempotency key for receivers
  "type": "lead.qualified",
  "occurred_at": "2026-10-23T18:01:02.123Z",
  "schema_version": 1,
  "aggregate": { "type": "lead", "id": "uuid", "version": 3 },
  "origin": "findway",                // system that caused the change
  "data": { "candidate_id": "uuid", "application_id": "uuid" }
}
```

`data` carries **identifiers and changed-field names only** — no names, contact data or identity numbers. Adapters/subscribers fetch current state through authorised channels. This is deliberate data minimisation (tested: webhook payload keys).

| Event | Emitted when | Aggregate | trust-crm adapter action |
|---|---|---|---|
| `candidate.created` | Candidate profile created after email verification | candidate | skipped (not qualified) |
| `candidate.updated` | Profile/identity/consent-link change | candidate | update mapped record, or re-evaluate a blocked qualification |
| `lead.created` | Application submitted | lead | skipped |
| `lead.qualified` | Staff qualify a lead | lead | create **or link** candidate in trust-crm |
| `application.submitted` | Candidate applies | application | skipped |
| `application.status_changed` | Any application stage change | application | skipped (recorded) |
| `job.published` | Job approved (first time or after material change) | job | skipped |
| `job.closed` | Job closed/expired | job | skipped |
| `placement.updated` | Recruitment case opened / stage changed | case | push stage to trust-crm |
| `consent.revoked` | Candidate withdraws a consent | candidate | skipped (subscribers act on it) |
| `document.uploaded`, `document.reviewed`, `interview.scheduled` | **Phase 2** (modules not built) | — | — |

"Skipped" deliveries are stored with the reason (`event_not_applicable_to_trustcrm`) — nothing is silently dropped.

## 4. Field ownership (source of truth)

| Entity / field | Owner | Direction | Conflict rule |
|---|---|---|---|
| Candidate: name, nationality, DOB, contact, profile fields, consents | FIND WAY | → trust-crm (name, nationality, DOB, passport no./expiry **only**) | FIND WAY wins; inbound changes to these fields are ignored |
| Candidate: passport number | FIND WAY (recorded by staff) = identity key | → trust-crm at creation | A number already on another person opens a duplicate review |
| Candidate: **passport expiry** | trust-crm | ← FIND WAY | trust-crm wins (`candidate.updated` inbound / reconcile) |
| Candidate: embassy date, invoices, payments, expenses, expiry alerts | trust-crm | not synchronised | — |
| Lead, application, job, employer, organisation, user | FIND WAY | not synchronised | — |
| Recruitment case stage | Shared | ⇄ | Last-synced-version rule: remote change applied only if local has not changed since last sync; otherwise **conflict queue** |
| Existing trust-crm candidate matched by passport | trust-crm | link only (`linked_existing`) | Never overwritten |

## 5. Delivery lifecycle (states shown in the Integration Center)

`pending → succeeded | skipped | blocked | retry → … → dead`.
`blocked` = cannot proceed without a human (missing passport, connection disabled, trust-crm has no visa application). `dead` = permanent failure or retries exhausted; a `dead_letters` row exists and **Replay** resets the delivery. Retry policy lives in setting `policy.sync_retry` (`max_attempts`, `base_seconds`, `max_seconds`). Events for one aggregate are delivered in order.

Connection states: `not_configured` → `configured_untested` → **`connected`** (only after login *and* the test request succeed) / `auth_failed` / `unreachable` / `disabled`. Any change of base URL resets to `configured_untested`.

## 6. Inbound webhooks (`POST /api/integrations/{source}/webhook`)

Header: `X-FindWay-Signature: t=<unix seconds>,kid=<key id>,v1=<hex>` where `v1 = HMAC_SHA256(secret, "<t>.<raw body>")`.

Senders must use `Content-Type: application/json` (the raw body bytes are what is signed). Checks, in order: signature present → timestamp within ±300 s (`WEBHOOK_TOLERANCE_SECONDS`) → HMAC matches **one of the currently valid secrets** (rotation overlap) → JSON/schema → idempotent insert on `(source, event.id)` (replays are no-ops) → order check against `last_event_at` → ownership/conflict rules → apply in one transaction → status recorded (`applied | stale_ignored | conflict | ignored | failed | duplicate`).

Receiver example (Node):

```js
const sig = Object.fromEntries(req.headers['x-findway-signature'].split(',').map(p => p.split('=')));
const expected = crypto.createHmac('sha256', SECRET).update(`${sig.t}.${rawBody}`).digest('hex');
ok = Math.abs(Date.now()/1000 - sig.t) < 300 && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig.v1));
```

Secrets are stored AES-256-GCM encrypted, shown **once** at creation, and rotated from the Integration Center: the new key is primary immediately; the previous one stays valid for 24 h then stops (tested). Outbound subscriptions use the same scheme with `X-FindWay-Event`, `X-FindWay-Event-Id`, `X-FindWay-Delivery` headers; receivers de-duplicate on the event id.

## 7. Reconciliation

`POST /api/admin/integrations/trustcrm/reconcile` (also a button) reads every mapped record from trust-crm, derives synthetic events with deterministic ids (`reconcile:<external id>:<hash of state+updated_at>`) and feeds the same pipeline as webhooks, so idempotency, ordering and conflict rules are identical. Running it twice applies nothing the second time (tested). Schedule it (e.g. every 10 minutes) until trust-crm can emit webhooks.

## 8. Required service account and network

* A trust-crm user (role `Manager` or custom with `candidates:read`, `candidates:write`, `visa:write`) used **only** by the adapter; credentials in env (`TRUSTCRM_SERVICE_EMAIL/PASSWORD`), never in the DB or logs, never reused for MCP/user tokens.
* FIND WAY must reach `TRUSTCRM_BASE_URL`; for inbound webhooks, trust-crm (or a relay) must reach `/api/integrations/trustcrm/webhook`.

## 9. Proposed (not applied) trust-crm change: webhook emitter

Add an optional module that POSTs signed `candidate.stage_changed` / `candidate.updated` events to FIND WAY after `routes/candidates.js` commits (`/:id/stage`, `PUT /:id`). Payload: `{id, type, occurred_at, data:{external_id, stage|fields}}`, signed exactly as in §6. Behind an env flag, off by default, fire-and-forget with its own small outbox table. This removes the need for polling. **Not implemented because it changes the existing system — needs your approval and a staging copy first.**

## 10. Safe rollout plan (no production data touched so far)

1. Point FIND WAY at a **staging copy** of trust-crm; run *Test connection* (must turn green only on a real authenticated call).
2. Back up trust-crm (`pg_dump`), keep the dump with the date in the change record.
3. Enable the integration with a handful of synthetic candidates; inspect Deliveries (`linked_existing` vs `created`).
4. Run Reconcile; confirm zero conflicts.
5. Rollback = disable the connection (pending deliveries become `blocked`, nothing is lost); records created in trust-crm carry the FIND WAY case reference in the stage note and can be located by passport.
No existing trust-crm rows are modified by linking. Updates (PUT/stage) touch only the fields in §4.

## 11. Integration Center (admin UI/API)

Status per connection, enabled flag, credentials-present flag (never the secret), last test and last success, delivery counts by status, recent failures, open conflicts, dead letters, retry/replay/resolve actions, rotate secret, webhook subscriptions. API: `/api/admin/integrations/*` (see [generated/api-endpoints.md](generated/api-endpoints.md)).
