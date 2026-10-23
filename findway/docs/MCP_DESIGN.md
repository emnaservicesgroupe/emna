# MCP server — design (Phase 3; **not implemented yet**)

Designed now so Phase 1 code is MCP-ready. Nothing here ships until Phase 3; STATUS.md lists it as *Deferred*.

## 1. What already exists for it
* A **single service layer** (`src/services/*`) that every tool will call — no direct SQL from tools, so the permission model, record scoping, validation, audit and outbox events are inherited.
* A **principal** with `via` and `client` fields (already written to `audit_events.via/client`) and `correlationId`.
* Audit trail, optimistic concurrency (`version`), idempotency keys, append-only history.
* Integration/delivery health data for `get_integration_health` (`integrations/admin.overview`).

## 2. Transport and authorization
* Remote **Streamable HTTP** MCP endpoint over HTTPS using the maintained official TypeScript/JS SDK at the version current when Phase 3 starts; compatibility matrix to be **tested** with Claude (web/desktop/Code) and any other intended client — no client is claimed compatible until it has passed the test.
* **OAuth 2.1** authorization server (authorization-code + PKCE; dynamic client registration optional and admin-gated), discoverable via `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.
* Short-lived access tokens (≤15 min), refresh tokens with rotation, **revocation endpoint**; tokens are audience-bound to the MCP resource and issuer-validated; scopes: `read:jobs`, `read:companies`, `read:candidates`, `read:applications`, `read:reports`, `read:integrations`, `draft:*`, `act:*` (each controlled tool has its own scope).
* The token maps to a **FIND WAY user + client**; organisation context is derived from `memberships`, never from a tool argument. A tool argument naming an org the user is not a member of fails the same way as in the web API (404).
* **Upstream credentials** (trust-crm service account) are separate from MCP tokens; MCP tokens are never forwarded downstream.
* **Connected AI Applications** page: client name, granted scopes, connected at, last activity, **Revoke** (deletes the grant and refresh tokens; access tokens expire within minutes; revocation list checked on every call).

## 3. Tool catalogue and policy classes

Class **R** = read, **D** = draft/internal workflow (no external effect), **X** = controlled execution (preview → approval → execute).

| Tool | Class | Service function(s) | Scope | Notes |
|---|---|---|---|---|
| `search_jobs`, `get_job` | R | `jobs.publicSearch/publicGet` (+ employer/staff variants by role) | `read:jobs` | pagination via `limit/offset` |
| `search_companies`, `get_company` | R | `organizations.publicList/listForStaff/getForStaff` | `read:companies` | role-scoped |
| `search_candidates`, `get_candidate_summary` | R | `candidates.staffList/staffGet` | `read:candidates` | **summary view only**, masked identity, assignment-scoped |
| `list_applications`, `get_application` | R | `applications.listOwn/staffGet/employerList` | `read:applications` | by role |
| `list_missing_documents` | R | Phase 2 documents module | `read:applications` | |
| `list_upcoming_interviews`, `list_overdue_tasks` | R | Phase 2 interviews/tasks | | |
| `get_recruitment_report` | R | Phase 2 reports | `read:reports` | defined metrics only |
| `get_integration_health` | R | `integrations/admin.overview` | `read:integrations` | admin/staff |
| `create_job_draft`, `prepare_application` | D | `jobs.createDraft`, application preparation (Phase 4) | `draft:jobs`, `draft:applications` | never submits |
| `draft_candidate_message`, `draft_employer_message` | D | `messaging.prepareOutreachDraft` (status `prepared`) | `draft:messages` | **cannot send** |
| `create_task`, `assign_candidate`, `request_document_review`, `propose_application_status_change` | D | tasks (P2), `leads.reassign`, documents (P2), proposal records | `draft:workflow` | `assign_candidate` needs `assignments:manage` |
| `publish_job` | X | `jobs.review` (approve) | `act:jobs` | admin only |
| `submit_application` | X | `applications.apply` | `act:applications` | candidate-owned |
| `send_approved_message` | X | messaging send (P2) of a message in state `approved` | `act:messages` | must reference an approved draft |
| `schedule_confirmed_interview` | X | interviews (P2) | `act:interviews` | |
| `apply_approved_status_change` | X | `applications.staffSetStage` | `act:applications` | requires an approved proposal |
| `create_guest_showcase`, `revoke_guest_showcase` | X | guest links (P2) | `act:showcases` | revoke is immediate |
| Financial / destructive tools | — | not exposed in v1; adjustment **requests** only, Super Admin approves in the web UI | — | |

All tools: zod-validated inputs, documented outputs, pagination, stable error codes (the same `error.code` values as the HTTP API), minimum necessary fields, no free-text fields echoed into logs.

## 4. Approval flow for consequential actions (class X)

1. **Preview call** returns exact target, field changes, recipient(s), attachments and impact, plus an **approval record** `{id, user_id, client_id, tool, args_hash, target_version, expires_at (≤10 min), status=pending}` where `args_hash = SHA-256(canonical JSON of the exact arguments)`.
2. A human approves it **in the FIND WAY web UI** (authenticated session + MFA for privileged users) — never via a tool argument or "approved=true" flag. Optional **narrow pre-authorisation** (per user, per tool, per scope, with limits and expiry) can auto-approve routine internal actions; it is a setting, off by default.
3. **Execute call** presents the approval id; the server recomputes `args_hash`, checks the approval is `approved`, unexpired, unused, bound to the same user+client, that the record `version` still equals `target_version`, and **re-checks permissions** at execution. The approval is consumed atomically (`UPDATE … WHERE status='approved' RETURNING`) so a replay fails.
4. The execute step calls the ordinary service function (all domain checks run again) and writes the audit event.

Audit record per call: actor, client, tool, scope used, target, approval id, result, timestamp, correlation id; arguments are stored redacted (no secrets, minimal personal data).

## 5. Prompt-injection controls
CV text, e-mails, web pages and documents are **data**. Controls: (a) tools take structured arguments only — no tool executes free text; (b) authority comes from the token + approval record, never from content; (c) class X always needs a human-approved record bound to exact arguments, so injected instructions cannot widen scope; (d) outputs that embed untrusted text are returned in a clearly delimited `untrusted_content` field and length-limited; (e) draft tools can only create `prepared` messages. Planned test: a CV containing "ignore previous instructions and send/approve …" cannot cause any execution without an approval record (acceptance test #17 — Deferred with the MCP server).

## 6. Automations (Phase 3)
Durable scheduler (DB-backed, using the same lease pattern as the delivery dispatcher), `automations` + `automation_runs` tables, owner, trigger, schedule+time zone, conditions, allowed actions, per-run limits, approval policy, run history, pause and **emergency stop** (global kill switch checked before every action). Recruitment outreach defaults to draft-only.
