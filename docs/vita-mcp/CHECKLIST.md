# VITA assistant access (MCP) — checklist

Status of Stage 7. Spec: [../superpowers/specs/2026-10-27-vita-mcp-assistant-design.md](../superpowers/specs/2026-10-27-vita-mcp-assistant-design.md).
Legend: **completed** = built; **tested** = a test proves it (file named); **blocked** = not done or not provable here.

**Honest summary.** Everything below was checked with automated tests on a real Postgres schema and a real in-process HTTP server (`app.listen(0)` + `fetch`, real `/auth/login`
for staff, a candidate through the real e-mail OTP, no network). The MCP side was exercised with **the MCP SDK's own client** (Streamable HTTP, Authorization header) and with the
**stdio launcher** (`scripts/mcp-stdio.js`) spawned as a real child process. **It was NOT exercised with a real Claude Desktop or Claude Code client**, nor on a real server, domain,
HTTPS proxy or browser session against a live installation. Run the first connection described in [SETUP.md](SETUP.md) sections 3 to 5 on your own installation before relying on it.

**Not delivered, and why**

- **No write tools.** Deliberately not built: the first version is read-only until the owner has reviewed real usage.
- **No in-app LLM assistant.** It would need the owner's LLM provider key; the console shows it as `requires_setup` and nothing calls an LLM.
- **No OAuth for MCP** (personal access tokens only), no assistants for candidates, employers or agencies, no semantic search, no documents / CVs / passports / chat bodies exposed.
- **Off by default.** `MCP_ENABLED` must be set to `true` by the owner.

## Hard rules of the spec

| Requirement | Status | Evidence |
|---|---|---|
| Read-only: no tool creates, changes, sends or deletes anything | completed, tested | `tests/mcp-tools.test.js` (table counts unchanged after every tool as every role), `tests/mcp-e2e.test.js` H1 (22 tables unchanged after a barrage over real HTTP; `audit_logs` grows by exactly the number of calls) |
| Acts as the token owner with the **current** role, re-read on every call; demotion or deactivation applies at once | completed, tested | `tests/mcp-tools.test.js` (permissions re-read, forged role ignored), `tests/mcp-tokens.test.js`, `tests/mcp-e2e.test.js` C1 (Manager demoted to Receptionist: next call 401 and the tokens are revoked, promotion does not revive them), D1 (deactivated owner: revoked, reactivation does not revive) |
| No tool bypasses the services' scope rules; another's candidate is indistinguishable from a nonexistent one | completed, tested | `tests/mcp-tools.test.js`, `tests/mcp-e2e.test.js` B2 (Admin sees all, Manager only assigned; identical answers for other's, deleted and missing ids) |
| Tokens: personal, hashed at rest, shown once, constant-time compare, expiring (default 30, max 90 days), revocable, 5 active per user | completed, tested | `tests/mcp-tokens.test.js`, `tests/mcp-e2e.test.js` A1, D1 (revoke idempotent, expiry, owner cannot revoke others') |
| Tokens usable **only** on `/mcp`; a token on any other route is refused; a normal JWT is refused on `/mcp` | completed, tested | `tests/orgs-route-sweep.test.js` (PAT on every authenticated route), `tests/mcp-e2e.test.js` E1 (`/candidates/all`, `/finance/dashboard`, `/hr/me`, `/chat/conversations`, `/jobsearch/auth/me`, `/mcp-tokens`; JWTs of Admin, Manager, SuperAdmin, Candidate, Employer on `/mcp`) |
| Agent, Accountant, HR, Receptionist, Candidate, Employer, Agency can never create or use a token | completed, tested | `tests/mcp-e2e.test.js` A2 (403 on create, list, usage), A3 (a token row planted for each of them, a forged and an altered secret: 401) |
| Output is data: sanitised, size-capped, wrapped as untrusted; injection text returned unmodified inside the wrapper | completed, tested | `tests/mcp-tools.test.js`, `tests/mcp-e2e.test.js` B3 (lead message with an injection string: `untrusted_content`, text intact, `instructions_ignored`) |
| No secrets, passport numbers, e-mail, phone, password hashes, OTPs, tokens, document contents in any output | completed, tested | `tests/mcp-tools.test.js` (sentinel scan over every tool and role), `tests/mcp-e2e.test.js` B2, B3 |
| Every call audited (who, tool, arguments digest, row count, outcome — not the data) | completed, tested | `tests/mcp-server.test.js`, `tests/mcp-e2e.test.js` H2 (exact field set per row; a full-table scan of `audit_logs` finds no argument value, candidate name, passport, e-mail, phone or token secret/hash) |
| Off by default; token management works while off and says so | completed, tested | `tests/mcp-server.test.js`, `tests/mcp-e2e.test.js` F1 (404 with or without a token; create, list, revoke, usage still work; `mcp_enabled: false`), `tests/deploy-kit.test.js` (absent/false in the production template) |
| Limits: 64 KB body, 200 KB response, rate limit per token, concurrency cap, per-request and per-tool deadlines | completed, tested | `tests/mcp-server.test.js` (all limits; the 504 deadline test is deterministic), `tests/mcp-e2e.test.js` F2 (429 + `Retry-After`, per token) |
| Transport: Streamable HTTP `POST /mcp` (stateless), other methods 405; stdio launcher that holds no data and never prints the token | completed, tested | `tests/mcp-server.test.js`, `tests/mcp-e2e.test.js` B1 (SDK client lists the eight tools), G1 (launcher spawned: initialize, tools/list, `platform_status`; no token on stdout or stderr; call audited as the token) |
| Graceful shutdown cuts in-flight MCP calls | completed, tested | `tests/mcp-server.test.js` |

## Tools (spec section 4)

| Tool | Status | Test file |
|---|---|---|
| `search_candidates`, `get_candidate_overview` | completed, tested | `tests/mcp-tools.test.js`, `tests/mcp-e2e.test.js` B2 |
| `list_leads`, `list_employer_requests`, `list_applications_needing_staff` | completed, tested | `tests/mcp-tools.test.js`, `tests/mcp-e2e.test.js` B3, B4 |
| `finance_summary` (Manager allowed: holds `finance:read`) | completed, tested | `tests/mcp-tools.test.js`, `tests/mcp-e2e.test.js` B4 |
| `my_leave_and_attendance`, `platform_status` | completed, tested | `tests/mcp-tools.test.js`, `tests/mcp-e2e.test.js` B4, B2, G1 |
| Write tools | **not built, deliberately** | n/a |

## Console and deployment

| Requirement | Status | Evidence |
|---|---|---|
| Staff console tab "Assistant access" (create with one-time secret, list, revoke, usage log, connection snippets for Claude Desktop and Claude Code, status card with the in-app assistant as `requires_setup`; ar/en/fr, CSP-safe) | completed, tested (markup and logic); **not seen in a real browser here** | `tests/mcp-ui.test.js` |
| Env settings documented in both env examples (commented; `MCP_ENABLED` absent) | completed, tested | `trust-crm/.env.example`, `deploy/hostinger/.env.production.example`, `tests/deploy-kit.test.js` |
| Proxy: `/mcp` excluded from compression and flushed immediately in the bundled Caddy; guidance for other proxies | completed, tested (the config text); **not run through a live Caddy** | `deploy/hostinger/Caddyfile`, `tests/deploy-kit.test.js`, `docs/vita-job-search/SETUP-HOSTINGER.md` |
| Connection instructions and security/leak procedure | completed (documents) | [SETUP.md](SETUP.md) |
| The all-routes authorization sweep still passes with `/mcp` and `/mcp-tokens` classified | completed, tested | `tests/orgs-route-sweep.test.js`, run again as a child process by `tests/mcp-e2e.test.js` I1 |

## Known limits (read before relying on it)

- **Not tried with a real Claude Desktop or Claude Code.** Only the SDK client and the stdio launcher were used. Client behaviour differs between versions; the config snippets follow the documented formats but were not run in those applications.
- **Rate limiting is in-process.** Counters live in the app's memory: they reset on restart and are per process, so a second replica would multiply the allowed rate. The deployment assumes a single app container.
- **Stateless, no streaming.** Every request is one JSON-RPC exchange with a JSON response; the server sends no notifications, progress or resource subscriptions, and batches are refused.
- **Manager (and Receptionist/Agent) scope.** Candidates are limited to those assigned to the caller by the existing scope rules; a Manager does not see unassigned candidates. Only SuperAdmin, Admin and Manager can hold tokens, so Receptionist and Agent cannot use the assistant at all.
- **Some tools are not per-owner filtered by the existing services.** `list_employer_requests` follows `orgs:read` (everyone allowed sees all requests) and `finance_summary` follows `finance:read` (company-wide totals); this mirrors the normal API.
- **Output is trimmed:** at most 20 timeline events per candidate, short per-field character limits (300 characters for free text), 200 KB per response (arrays are halved with a note when a result is too big).
- **Usage log** in the console shows the last 50 calls; `last_used_at` of a token moves at most once a minute.
- **A call that hits the request deadline** is audited once as an error; if the tool finishes later its result is discarded (found and fixed in this task: it used to write a second audit row).
- **Free text can still be misleading.** Untrusted-content wrapping reduces, but does not remove, the risk that an assistant is swayed by text written by a candidate or the public. Read-only access is the real safeguard: nothing can be changed through it.
- **Token secrets on the user's machine.** The token sits in the Claude Desktop config file or the Claude Code settings in clear text; protect that file and revoke tokens for lost devices.

## Review round 1

An independent review of the first delivery found the items below. Each has a test written first (failing), then the fix.

| # | Severity | Finding | Status | Evidence |
|---|---|---|---|---|
| 1 | HIGH | A 6 KB deeply nested argument crashed the whole process: `canonicalJson` recursed without limit and the RangeError was thrown inside the response `close` handler (uncaught). | fixed, tested. `canonicalJson`/`argsDigest` are depth-limited (32) and node-limited (5000) and return a fixed marker digest past either; the whole `close` handler is in try/catch and logs one generic line; the route refuses, before any processing, `params.arguments` nested deeper than 12 levels or holding more than 5000 values with a 400 JSON-RPC error **and** one `MCP_CALL` audit row (outcome `error`). | `tests/mcp-server.test.js` (3000-deep array, 30000-element array, deep object, boundary 12/13, server alive afterwards, one audit row, no uncaught exception) |
| 2 | MEDIUM | Connections that send headers but no body held a concurrency slot for the whole 15 s deadline: nine of them from one token produced 503 for everybody. | fixed, tested. `MCP_MAX_CONCURRENT_PER_TOKEN` (default 2, 429) and `MCP_BODY_TIMEOUT_MS` (default 5000, 408, slot freed). | `tests/mcp-server.test.js` (raw sockets: 9 stalled from one token = 7 x 429 + 2 x 408, other tokens served, never 503) |
| 3 | MEDIUM | A leaked token survived a password change and came back to life when its owner was reactivated or promoted again. | fixed, tested. Migration `024_mcp_hardening.sql`: `api_tokens.owner_token_version` (backfilled once), `authenticate()` requires it to equal `users.token_version`, `createToken` stores it; a trigger on `users` revokes all live tokens when `is_active` goes true to false or the role is changed to one without `mcp:use` (`revoked_by` stays NULL = system). | `tests/mcp-tokens.test.js`, `tests/mcp-server.test.js`, `tests/mcp-e2e.test.js` C1/D1, `tests/fin-schema.test.js` (migration lists) |
| 4 | LOW | `list_applications_needing_staff` showed tasks bound to no candidate to Managers/Admins, contradicting "limited to candidates you may see". | fixed, tested. Those items are dropped before the limit is applied. | `tests/mcp-tools.test.js` |
| 5 | LOW | The sanitiser kept several invisible characters (soft hyphen, Arabic letter mark, variation selectors, Hangul fillers...). | fixed, tested. All `\p{Cf}` except ZWJ/ZWNJ, plus U+034F, U+115F-1160, U+17B4-17B5, U+180B-180F, U+3164, U+FE00-FE0F, U+FFA0, U+E0100-E01EF. Side effect: emoji variation selectors (U+FE0F) are removed too, so some emoji lose their colour presentation in tool output. | `tests/mcp-tools.test.js` |
| 6 | LOW | No pre-authentication throttle; no aggregate limit across a user's tokens. | fixed, tested. `MCP_AUTH_FAIL_PER_MIN` (default 30, 429 before any database lookup, per address hash, in memory), `MCP_USER_RATE_PER_MIN` (default 120). `TRUST_PROXY` requirement documented (SETUP.md section 2) and the startup check warns when MCP is on without it. Audit growth is bounded as before (one failed-auth row per address per minute, 60 per minute overall). Trade-off: a throttled address is refused even with a valid token, so a shared address (NAT, or a proxy without `TRUST_PROXY`) can lock its users out for a minute after 30 failures. | `tests/mcp-server.test.js`, `tests/preflight.test.js` |
| 7 | LOW | Very recent transitive packages (hono 4.13.14 and ip-address 10.7.5, both published 2026-10-25). | fixed. `overrides` in `package.json` pin `hono` 4.13.13 (published 2026-10-04) and `ip-address` 10.7.4 (published 2026-10-11); both satisfy the SDK's declared ranges (`hono ^4.13.9`, `ip-address ^10.2.0`). Lockfile regenerated, `npm ls` clean, MCP tests pass. Revisit the pins when the newer releases are two weeks old. | `package.json`, `package-lock.json` |
| 8 | LOW | A staff room could be left without participants (nobody could see it again). | fixed, tested. Removing the last remaining participant of a staff room (yourself included) answers 409. | `tests/chat-api.test.js` |

Notes and limits of this round:

- There is **no password-change route** in the repository, so "password change kills the token" is tested through the session-version bump (`bumpTokenVersion`) that any such feature must call. Account deactivation through the app (`consentService`) already bumps the version; a role change has no code path in the app (it is a database operation), and the trigger revokes the tokens in that case.
- The shape gate allows at most 5000 values, which is far below what a 64 KB body can hold (a flat array of 30000 numbers fits), so a "100 000-node" request body cannot exist inside the body limit; the test uses a 30000-element array.
- Tokens revoked by the trigger show as revoked with no revoking user in the console list.
- Not re-run against a real Claude Desktop or Claude Code; nothing here changes client behaviour except the new 400/408/429 answers.
