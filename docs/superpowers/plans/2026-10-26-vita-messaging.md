# VITA Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Messaging per `docs/superpowers/specs/2026-10-26-vita-messaging-design.md`.
**Architecture:** Additive migration 021; `modules/chat/*` (scope, conversations, messages, hub, nudges, channels); `routes/chat.js` mounted `/chat` with own 16kb parser; UI in `public/vita/chat-*.js` and the three portals.
**Tech Stack:** Node 22, Express, pg, node:test, SSE.

## Global Constraints
- Text only; body 1..2000 chars, NUL rejected; messages immutable except hide columns (DB trigger); everything rendered with textContent.
- Scope enforced in SQL after loading; out-of-scope ⇒ identical 404; Candidate/Employer/Agency tokens reach only `/chat/*` (update `tests/orgs-route-sweep.test.js` tables and positive controls); other portals' data never exposed.
- Every mutation transactional + `logAudit(client)`; hub events carry ids only.
- Strict CSP, ar/en/fr parity, no localStorage for message content.
- Commits end with: Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com> and Claude-Session: https://claude.ai/code/session_01FJCJCrbEtXFCvjTVJwpqAi. Run full `npm test` ONCE per task at the end, never two at once; branch claude/adoring-mendel-yrxr43; don't push.

## Review Focus
- Employer user of org A reading org B's thread by id; candidate reading another candidate's; assignment change taking effect immediately; deactivated users and suspended orgs.
- Parallel sends ordering/ids; send to closed conversation; hidden message leaking through preview, SSE payload, unread math or pagination.
- SSE: event for conversation X delivered to a user without access; reconnect replay after access was revoked.
- E-mail nudge storms; nudge content leaking message text; opt-out honoured.
- Rate-limit bypass using many conversations; huge/unicode/bidi/zero-width messages.

### Task 1: Migration 021 + permissions
Files: `sql/migrations/021_chat.sql`, `middleware/role.js` (+ SETUP.md matrix block and test like finance/hr), tests `tests/chat-schema.test.js`. Spec §3 in full: constraints, indexes (conversation+id desc, participant user), immutability trigger (only hide columns may change; no delete), unique subject, permissions `chat:read/write/moderate` per spec. Update migration-list assertions in `tests/fin-schema.test.js` and similar.

### Task 2: Scope, conversations, messages API
Files: `modules/chat/{scope,conversations,messages}.js`, `routes/chat.js` + app.js mount, tests `tests/chat-api.test.js`. Per spec §2/§4 (without SSE/nudges): subject resolution per type (candidate via candidates.assigned_to / js_candidate_accounts, org via crm_org_accounts, staff rooms via participants), idempotent open, send/list/read/unread, close/reopen, hide/unhide, rate limit (default 30 msgs/min/user, env), full isolation matrix, sweep update.

### Task 3: Realtime hub, e-mail nudges, channel status
Files: `modules/chat/{hub,nudges,channels}.js`, route additions (`/chat/events`, `/chat/prefs`, `/chat/channels`), tests `tests/chat-realtime.test.js`. SSE modelled on `modules/jobsearch/eventsHub.js` (study it; reuse helpers where clean) with per-user cap and replay by Last-Event-ID backed by `chat_messages`/an events table; access re-check on every delivery; nudges via mail adapter with cooldown and opt-out, content-free; WhatsApp sandbox adapter writes `chat_channel_outbox` rows with status `requires_setup`; honesty endpoint.

### Task 4: UI (staff console + three portals)
Files: `public/vita/chat-util.js`, `chat-staff.js`, `chat-portal.js`, `admin.html`, `portal.html|js`, `employer.html|js`, `agency.html|js`, `i18n.js`, `vita.js` allowlist `/chat/`, `crm-util.js` mirror, tests `tests/chat-ui.test.js`; Playwright smoke across staff/candidate/employer/agency with isolation checks, ar RTL, 375px, no CSP violations.

### Task 5: End-to-end, docs
Files: `tests/chat-e2e.test.js`, `docs/vita-messaging/{CHECKLIST,SETUP}.md`, env vars (`CHAT_RATE_PER_MIN`, `CHAT_NUDGE_COOLDOWN_MIN`) in both env examples, HOSTINGER paragraph. Full journey across roles + sweep child process.
