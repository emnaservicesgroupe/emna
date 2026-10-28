# VITA assistant access (MCP) — setup and daily use

Assistant access lets an AI assistant such as **Claude Desktop** or **Claude Code** answer questions about the VITA data a staff member is already allowed to see. It is part of the
same VITA app: no extra service, container or database (it adds one table, migration 023, and binds tokens to the owner's account, migration 024). It is **read-only** and **off by default**. What was and was not verified:
[CHECKLIST.md](CHECKLIST.md).

## 1. Settings (all optional)

Put them in `.env` (on the VPS: `deploy/hostinger/.env`), then `docker compose up -d`. Defaults apply when a line is absent.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_ENABLED` | absent = **off** | Must be exactly `true` to switch assistant access on. Anything else, or absent, and `/mcp` answers 404 to everyone. Token management in the staff console works either way (it tells you MCP is off). Read on every request. |
| `MCP_RATE_PER_MIN` | `60` | Calls one token may make per minute (1 to 100000). Above it: 429 with `Retry-After`. Counted in the app process: **resets on restart**, per process. |
| `MCP_MAX_CONCURRENT` | `8` | Requests handled at the same time across all tokens (1 to 1000). Above it: 503. |
| `MCP_MAX_CONCURRENT_PER_TOKEN` | `2` | Requests one token may have in flight (1 to 1000). Above it: 429. Keeps one token (or a thief of one) from using up every slot. |
| `MCP_BODY_TIMEOUT_MS` | `5000` | Time a client has to send the whole request body (50 to 120000). A connection that sends headers and then stalls is cut with 408 and its slot is freed. |
| `MCP_USER_RATE_PER_MIN` | `120` | Calls one **user** may make per minute across all of his tokens (1 to 1000000). Above it: 429. |
| `MCP_AUTH_FAIL_PER_MIN` | `30` | Failed authentications per minute from one client address (1 to 1000000). Above it that address gets 429 + `Retry-After` **before** any database lookup, even with a valid token, until the minute passes. Needs `TRUST_PROXY` (see below). |
| `MCP_REQUEST_TIMEOUT_MS` | `15000` | Overall deadline for one request (50 to 120000). Above it: 504; the call is audited once as an error. |
| `MCP_TOOL_TIMEOUT_MS` | `10000` | Deadline for one tool (1 to 120000). A slower tool returns an error result (`timeout`). |
| `MCP_TOKEN_DEFAULT_DAYS` | `30` | Lifetime of a new token when its creator does not choose one (1 to 90; 90 is also the maximum anyone can choose). |

## 2. Switch it on

1. Add `MCP_ENABLED=true` to `.env` and run `docker compose up -d` (a plain `node` start works the same with the variable in the environment).
2. If you use a proxy other than the bundled Caddy, do not buffer, compress or cache `/mcp` (see `docs/vita-job-search/SETUP-HOSTINGER.md`).
3. Run **one** app container: the rate limits live in the process.
3b. **Set `TRUST_PROXY=1` when the app runs behind Caddy (or any proxy).** The per-address limit (`MCP_AUTH_FAIL_PER_MIN`) and the failed-login audit key on the client address; without `TRUST_PROXY` every request appears to come from the proxy, so a handful of mistyped tokens from anybody would lock **everybody** out of `/mcp` for a minute. The startup check warns when `MCP_ENABLED=true` and `TRUST_PROXY` is not set.
4. Sign in to the staff console as an Admin or a Manager and open the tab **Assistant access**: the status card should say MCP is connected.

To switch it off again, remove the line (or set it to `false`) and run `docker compose up -d`. Existing tokens are kept but unusable until you switch it back on.

## 3. Create a token (console)

1. Staff console, tab **Assistant access**, **Create token**. Give it a name you will recognise (for example "Amira laptop") and, if you want, a number of days (1 to 90).
2. The token (`vita_pat_` followed by 43 characters) is shown **once**. Copy it now; VITA stores only a fingerprint and can never show it again. Treat it like a password.
3. The same tab lists your tokens (an Admin sees everyone's), lets you **revoke** one, and shows the last 50 calls (who, which tool, outcome, how long, how many rows — never the data).
4. A person can hold at most 5 active tokens. A token acts **as its owner**, with the owner's **current** role.

## 4. Connect Claude Desktop (stdio)

Claude Desktop starts local commands, so it uses the small launcher `scripts/mcp-stdio.js`. It holds no data and no database access: it forwards to `POST {VITA_BASE_URL}/mcp` with your token,
so the server applies exactly the same checks, limits and audit. It needs Node.js (the same version as the server) and a copy of the `trust-crm` folder (the launcher uses that folder's `node_modules`; run `npm ci` there once).

Edit `claude_desktop_config.json` (Claude Desktop, Settings, Developer, Edit config) and add:

```json
{
  "mcpServers": {
    "vita": {
      "command": "node",
      "args": ["/path/to/trust-crm/scripts/mcp-stdio.js"],
      "env": {
        "VITA_BASE_URL": "https://crm.example.com",
        "VITA_MCP_TOKEN": "vita_pat_PASTE_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

Restart Claude Desktop. `VITA_BASE_URL` must be `https://` (plain `http://` is accepted for `localhost` only). The launcher never prints the token; if it is wrong it says so on stderr (expired, revoked, MCP disabled, unreachable).

## 5. Connect Claude Code (HTTP)

```bash
claude mcp add --transport http vita https://crm.example.com/mcp --header "Authorization: Bearer vita_pat_PASTE_YOUR_TOKEN_HERE"
```

Then `claude mcp list` should show `vita`. (The console shows both snippets with your server address filled in.)

## 6. What the eight tools do

All are read-only (annotated `readOnlyHint`), all results are wrapped as untrusted data, and each tool needs the permission shown.

| Tool | Needs | Returns |
|---|---|---|
| `search_candidates {q?, limit<=20}` | `candidates:read` | id, name, nationality, visa status, CRM stage, assigned staff name, created. Name search only. No passport, e-mail, phone, documents. |
| `get_candidate_overview {candidate_id}` | `candidates:read` | Stage, assigned staff, the last 20 timeline events (free text marked untrusted) and job-search counts. Out of scope, deleted and nonexistent all answer "not found". |
| `list_leads {status?, kind?, limit<=30}` | `leads:read` | Recent leads (spam hidden), the message as untrusted text. No e-mail or phone. |
| `list_employer_requests {status?, limit<=30}` | `orgs:read` | Recent employer requests: title, employer, positions, country, status. No staff notes. |
| `list_applications_needing_staff {limit<=30}` | `jobsearch:read` | The job-search staff queue, limited to the candidates you may see. |
| `finance_summary {from, to}` | `finance:read` | Per-currency invoiced, collected, refunded, expenses, net for a date range. Currencies are never added together. |
| `my_leave_and_attendance {from?, to?}` | none (self only) | Your own leave balances and worked minutes per day. Never reasons or notes, never anyone else. |
| `platform_status {}` | none | Counts only, limited to what you may see; sections you have no permission for are left out. |

## 7. Who can do what

| Role | Create tokens | Candidates seen through the tools | Tools that answer |
|---|---|---|---|
| SuperAdmin | yes | all | all eight |
| Admin | yes | all | all eight |
| Manager | yes | only candidates assigned to him (existing scope rule) | all eight (`finance_summary` included: Managers hold `finance:read`) |
| Receptionist | no | only assigned (rule exists, but no token can be made) | none |
| Agent, Accountant, HR | no | — | none |
| Candidate, Employer, Agency | never | — | none |

Only roles holding `mcp:use` (SuperAdmin, Admin, Manager) can create or use a token. The role is read from the database on **every** call: demote or deactivate someone and their very next call is refused (401). A token is also tied to the owner's account state: it is **revoked for good** (not just suspended) when the owner is deactivated or loses `mcp:use`, so reactivating or promoting the person again does **not** bring a leaked token back (create a new one); and it stops working whenever the owner's sessions are revoked (any bump of the account's session version: suspension, "log out everywhere", a password reset). There is no password-change screen in VITA yet; when one is added it must bump the session version (`bumpTokenVersion`), which then also kills the person's tokens.

## 8. Security model

- **Read-only by design.** No tool writes, sends or deletes. Write tools were deliberately **not built**; the test suite counts rows of the key tables around a barrage of calls.
- **Acts as the owner.** The same scope rules as the normal API (a Manager sees assigned candidates only; another's candidate looks exactly like a nonexistent one).
- **Tokens** are random (32 bytes), shown once, stored only as a SHA-256 fingerprint, compared in constant time, expire (default 30, max 90 days) and can be revoked. They are accepted **only** on `POST /mcp`; every other route answers 401 to a token, and `/mcp` answers 401 to a normal login token.
- **Data is untrusted.** Tool output is sanitised (control characters and every Unicode "format" character removed, except the joiners real scripts and emoji need (ZWJ, ZWNJ); soft hyphen, variation selectors, Hangul fillers and similar invisible look-alikes also removed; long text truncated) and wrapped (`untrusted_content`; free text carries `instructions_ignored`). The server instructions tell the assistant to treat it as data and never follow instructions found in it. Because no tool can change anything, an injected instruction cannot make the assistant change data.
- **No secrets or identity data** in results: no passport numbers, e-mail, phone, password hashes, OTPs, tokens or document contents.
- **Limits:** 64 KB request body (which must arrive within `MCP_BODY_TIMEOUT_MS`), 200 KB response, one JSON-RPC message per request (no batches), tool arguments at most 12 levels deep and 5000 values (else 400), rate limit per token and per user, per-token and global concurrency caps, a per-address throttle on failed authentication, per-request and per-tool deadlines.
- **Audit:** every call writes one `MCP_CALL` row: user, token id, tool, a keyed digest of the arguments, row count, outcome (`ok`, `error`, `denied`), duration. Never the arguments, never the data, never the token. Failed authentication is recorded at most once a minute per source (hashed).
- **Off by default**, and the stdio launcher refuses a non-HTTPS server address except `localhost`.

## 9. If a token leaks

1. **Revoke it now**: console, **Assistant access**, Revoke (the owner or any Admin can). The next call with it is refused. If you cannot reach the console, set `MCP_ENABLED=false` and restart: `/mcp` answers 404 to everyone.
2. **Check the usage log** (same tab, last 50 calls; or the audit log, action `MCP_CALL`, by token id and time) to see which tools were called with it and when. The log holds no data, so it tells you what *kinds* of questions were asked, not the answers.
3. Create a new token for the owner. If the leak may be part of a wider problem (a stolen laptop), also deactivate the user (this revokes all of his tokens; reactivating him later does not revive them) or revoke his sessions.
4. Remember what a leaked token could see: only what its owner can see, read-only, for at most its remaining lifetime.

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| 404 from `/mcp`, or the launcher says "MCP is disabled" | `MCP_ENABLED` is not `true`, or the base URL is wrong |
| 401 | Token revoked, expired, mistyped, or its owner was deactivated, no longer holds `mcp:use`, or had his sessions revoked (create a new token) |
| 408 | The request body did not arrive within `MCP_BODY_TIMEOUT_MS` |
| 429 | More than `MCP_RATE_PER_MIN` calls per token or `MCP_USER_RATE_PER_MIN` per user in a minute, more than `MCP_MAX_CONCURRENT_PER_TOKEN` at once, or too many failed authentications from your address; wait for `Retry-After` |
| 400 with a JSON-RPC error | The tool arguments are nested too deeply or hold too many values |
| 503 | `MCP_MAX_CONCURRENT` reached, or the server is shutting down |
| 504 or a tool error `timeout` | A request or tool exceeded its deadline; narrow the question |
| The assistant says "not found" for a candidate you know exists | It is not assigned to the token's owner (Managers see assigned candidates only) |
