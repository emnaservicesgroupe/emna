# VITA MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Read-only MCP server per `docs/superpowers/specs/2026-10-27-vita-mcp-assistant-design.md`.
**Architecture:** Additive migration 023; `modules/mcp/*` (tokens, auth, sanitize, tools, server), `routes/mcp.js` (`POST /mcp`) and `routes/mcpTokens.js`, `scripts/mcp-stdio.js`; UI in `public/vita/mcp-*.js`.
**Tech Stack:** Node 22, Express, pg, `@modelcontextprotocol/sdk` (pin an exact version ≥ two weeks old, add to package.json/package-lock), zod, node:test.

## Global Constraints
- Read-only; no write tools; off by default (`MCP_ENABLED`); PAT accepted only by `/mcp`; every tool re-uses existing services/scope helpers (never raw SQL that bypasses scope); user permissions re-read per call.
- No secrets, hashes, OTPs, tokens, passport numbers, contact details, documents or chat bodies in tool output; sanitise and cap all strings; free text wrapped as untrusted.
- Audit every call without data; tests never hit the network; update `tests/orgs-route-sweep.test.js` (classify `/mcp`, `/mcp-tokens`; assert PAT bearer is 401 everywhere except `/mcp`).
- Strict CSP, ar/en/fr parity, textContent only. Commits end with: Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com> and Claude-Session: https://claude.ai/code/session_01FJCJCrbEtXFCvjTVJwpqAi. Run full `npm test` ONCE per task at the end; branch claude/adoring-mendel-yrxr43; don't push.

## Review Focus
- A PAT used as a JWT / a JWT used as PAT; timing of hash compare; token in logs/audit/errors; expired/revoked/deactivated owner.
- Tool args that smuggle scope (candidate_id of another staff's candidate; q with SQL wildcards); limit overflow; huge outputs.
- Prompt-injection text in leads/notes/candidate names; output containing control/bidi characters.
- Demotion mid-session; MCP disabled flag; per-token rate limit under concurrency; denial of service via slow tools.

### Task 1: Tokens (migration 023, permissions, token endpoints, PAT auth module)
Files: `sql/migrations/023_mcp_tokens.sql`, `middleware/role.js` (`mcp:use`; matrix block in SETUP.md + test), `modules/mcp/{tokens,auth}.js`, `routes/mcpTokens.js` (+app.js mount), tests `tests/mcp-tokens.test.js`; update hard-coded migration lists. verifyToken must refuse `vita_pat_` bearer with 401 everywhere else (explicit test). 

### Task 2: Sanitiser and tool layer
Files: `modules/mcp/{sanitize,tools}.js`, tests `tests/mcp-tools.test.js`. All eight tools per spec §4 calling existing services with a user object; authorisation matrix; forbidden-field sentinel scan; injection test; caps.

### Task 3: MCP transport (HTTP + stdio) and wiring
Files: `package.json`/lock (add `@modelcontextprotocol/sdk` and `zod` at exact versions), `modules/mcp/server.js`, `routes/mcp.js` (+app.js mount, off by default), `scripts/mcp-stdio.js`, tests `tests/mcp-server.test.js` (use the SDK client over in-memory/HTTP to run initialize, tools/list, tools/call; rate limit; body/response caps; timeout; disabled flag; audit rows; demotion immediate; route sweep updated).

### Task 4: UI "Assistant access"
Files: `public/vita/mcp-util.js`, `mcp-admin.js`, `admin.html`, `admin.js`, `crm-util.js`, `vita.js` allowlist `/mcp-tokens`, `i18n.js`, tests `tests/mcp-ui.test.js`; Playwright smoke (create token, shown once, revoke, usage log, snippets, disabled state message, ar RTL, 375px).

### Task 5: End-to-end, docs
Files: `tests/mcp-e2e.test.js` (real HTTP: create token via API, SDK client over HTTP calls tools as different roles, isolation, revocation, audit), `docs/vita-mcp/{CHECKLIST,SETUP}.md`, env (`MCP_ENABLED`, `MCP_RATE_PER_MIN`, `MCP_TOKEN_DEFAULT_DAYS`) in both env examples, HOSTINGER paragraph (Caddy: /mcp no compression/buffering), connection instructions for Claude Desktop (stdio) and Claude Code (HTTP).
