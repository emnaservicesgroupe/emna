# VITA Messaging — checklist

Status of Stage 6 (messaging). Spec: [../superpowers/specs/2026-10-26-vita-messaging-design.md](../superpowers/specs/2026-10-26-vita-messaging-design.md).
Legend: **completed** = built; **tested** = a test proves it (file named); **blocked** = not done or not provable here.

**Honest summary.** Everything below was checked with automated tests on a real Postgres schema and a real in-process HTTP server (`app.listen(0)` + `fetch`,
real `/auth/login` for staff, candidates and portal users through the real e-mail OTP read from the sandbox mailbox, real SSE streams, no network).
**Nothing was run on a real server, a real domain, a real mailbox, a real phone or a real WhatsApp account.** The browser rendering (RTL, 375 px, live delivery in four portals)
was exercised by a one-off browser smoke during Task 4 that is **not** a committed, repeatable test. Run the first-use check in [SETUP.md](SETUP.md) section 6 on your own installation
before relying on it.

**Not delivered, and why**

- **WhatsApp is NOT implemented.** Only an honest adapter exists: `GET /chat/channels` reports WhatsApp as `requires_setup`, and a sandbox adapter can record an outbox row with status
  `requires_setup` (never `sent`). It is not even wired into message sending. A real channel needs **your WhatsApp Business provider account and approved message templates**.
- **E-mail nudges are sandbox until a real mail provider is configured** (`MAIL_PROVIDER` and the mail settings of the job-search module). Until then the nudge is only recorded in the sandbox mailbox.
- **Retention of chat data is an owner decision.** Nothing is deleted automatically; messages are immutable and there is no purge job.
- **Text only.** No files, images, voice, links previews or HTML.

## Hard rules of the spec

| Requirement | Status | Evidence |
|---|---|---|
| Text only: body 1..2000 characters, no NUL, no lone surrogates; HTML / script / bidi / zero-width text is stored verbatim and returned as JSON strings; the UI renders with `textContent` | completed, tested | `tests/chat-schema.test.js` (constraints), `tests/chat-api.test.js`, `tests/chat-e2e.test.js` K (five hostile strings round-trip byte for byte; NUL and 2001 characters refused and not stored), `tests/chat-ui.test.js` (no `innerHTML` sinks) |
| Messages are immutable; staff/admin can only hide with a reason (audited); no edit or delete endpoint | completed, tested | DB trigger: `tests/chat-schema.test.js` (immutability, hide/unhide); `tests/chat-api.test.js`; `tests/chat-e2e.test.js` E |
| Every message is audited with sender role and length (never the text) | completed, tested | `tests/chat-api.test.js`; `tests/chat-e2e.test.js` N (one `chat.message.send` audit row per message; no message text in any audit row) |
| No WhatsApp / SMS sending without the owner's provider credentials; WhatsApp shows `requires_setup`; sandbox adapter only | completed (honest adapter), tested; **real channel blocked on the owner** | `tests/chat-realtime.test.js`; `tests/chat-e2e.test.js` J (status `requires_setup`, the outbox never holds `sent`, normal traffic never touches the outbox, an unimplemented provider name is still `requires_setup`) |
| External parties cannot cold-message each other; employers and agencies cannot start a conversation; a candidate may start only their own (`CHAT_CANDIDATE_CAN_START`) | completed, tested | `tests/chat-api.test.js`; `tests/chat-e2e.test.js` C, D (403 for employer / agency start) |
| Abuse controls: length cap, per-user rate limit across all conversations, closed conversations | completed, tested | `tests/chat-api.test.js`; `tests/chat-e2e.test.js` H (429 with `Retry-After`, the refused message is not stored, other users unaffected), F |
| Content is untrusted data; system-generated texts promise nothing | completed, tested | The e-mail nudge is one fixed, trilingual, content-free text (`tests/chat-e2e.test.js` A, N: no message text, sender, subject name, or promise of employment / visa) |

## Data (migrations 021 and 022)

- [x] completed, tested: additive and idempotent; unique subject per non-staff conversation; indexes for thread paging, participants, unread and rate-limit lookups; immutability trigger; deleting a user never blocks. `tests/chat-schema.test.js`.
- [x] completed, tested: permissions `chat:read`, `chat:write`, `chat:moderate` and the role matrix; the matrix in `docs/vita-job-search/SETUP.md` is compared with the code. `tests/chat-schema.test.js`, `tests/role.test.js`.

## APIs and rules (spec sections 2 and 4)

| Requirement | Status | Test file |
|---|---|---|
| Scoped conversation list with unread count and last-message preview (a hidden message is a stub for external viewers) | completed, tested | `tests/chat-api.test.js`; `tests/chat-e2e.test.js` A, E |
| Idempotent open per subject (201 new / 200 existing); staff open only subjects they serve | completed, tested | `tests/chat-api.test.js`; `tests/chat-e2e.test.js` A, B, C |
| Paged thread (newest first), send, ordering | completed, tested | `tests/chat-api.test.js`; `tests/chat-e2e.test.js` L |
| Unread per participant (read marker only moves forward; own messages never unread; hidden messages not counted) | completed, tested | `tests/chat-api.test.js`; `tests/chat-e2e.test.js` A, E, L (after 20 parallel sends each side has exactly the 10 messages of the other) |
| Concurrency: 20 parallel sends give unique ids in commit order, no loss, the conversation pointer is the highest id | completed, tested | `tests/chat-api.test.js`; `tests/chat-e2e.test.js` L |
| Candidate sees only their own conversation; employer and agency users see only their organisation's thread, shared by all users of the organisation | completed, tested | `tests/chat-api.test.js`; `tests/chat-e2e.test.js` A, C, D |
| Out-of-scope and nonexistent ids give the identical 404 (another candidate / employer / agency, an unassigned Agent, a Receptionist on an organisation) | completed, tested | `tests/chat-api.test.js`; `tests/chat-e2e.test.js` B, C, D |
| Assignment change moves visibility at once; the old staff loses the thread (REST and events) | completed, tested | `tests/chat-api.test.js`; `tests/chat-e2e.test.js` B |
| Moderation: hide / unhide with reason (Admin, SuperAdmin, Manager only); candidate sees a stub without text or reason; close / reopen; send to a closed conversation is 409, reading still works | completed, tested | `tests/chat-api.test.js`; `tests/chat-e2e.test.js` E, F |
| E-mail nudge after commit: content-free, per (conversation, person) cooldown (`CHAT_NUDGE_COOLDOWN_MIN`), opt-out in `chat_prefs`, never to staff, never for a deactivated account, one claim under parallel sends (no storm) | completed, tested (sandbox mailbox only) | `tests/chat-realtime.test.js`; `tests/chat-e2e.test.js` A, C, D, I, L, M |
| Realtime: SSE `/chat/events` with the token in the Authorization header, ids and kinds only, replay by `Last-Event-ID`, per-user cap, access re-checked on every delivery, stream closed when the account is revoked | completed, tested | `tests/chat-realtime.test.js`; `tests/chat-e2e.test.js` A, B, C, E, F, M, N (no text and no unexpected key in any frame of the whole run) |
| `GET /chat/channels`: in-app connected, e-mail per mail adapter (`sends_real_mail` false for the sandbox), WhatsApp `requires_setup`; staff only | completed, tested | `tests/chat-realtime.test.js`; `tests/chat-e2e.test.js` J |

## Roles and isolation (spec section 2)

- [x] completed, tested (review round 1): HR and Accountant reach `/chat` (no blanket 403) but their list, unread count and event stream cover only staff rooms they were explicitly added to; every other conversation is the identical 404; they cannot open candidate / employer / agency conversations, create rooms or moderate (403); anonymous callers 401. `tests/chat-api.test.js`, `tests/chat-realtime.test.js`, `tests/chat-e2e.test.js` G, P, `tests/orgs-route-sweep.test.js`.
- [x] completed, tested: Candidate, Employer and Agency tokens reach `/chat/*` only; they are 403 on the other route classes (spot check in `tests/chat-e2e.test.js` G) and the all-routes sweep, which classifies every `/chat/*` route and seeds sentinels in the conversations, passes as a child process (`tests/chat-e2e.test.js` O, `tests/orgs-route-sweep.test.js`).
- [x] completed, tested: a deactivated user's token stops working at once and the open stream is closed without receiving the next event (`tests/chat-e2e.test.js` M).
- [x] completed, tested: no message text appears in any SSE frame or any e-mail body or any audit row of the whole end-to-end run (sentinels, `tests/chat-e2e.test.js` N).

## User interface

- [x] completed, tested (string / structure level): "Messages" tab in the staff console and a Messages panel in the candidate, employer and agency portals; ar/en/fr parity, CSP-safe (no inline script), `textContent` only, SSE over `fetch` with a 30 s polling fallback. `tests/chat-ui.test.js`.
- [ ] **Blocked / not repeatable:** rendering in a real browser (live delivery, RTL Arabic, 375 px width, no CSP violations) has no committed test. It was exercised once by hand during Task 4 and not re-run for this checklist.

## Known limits (from the agents' reports)

- **Event ids exist only for message events.** The SSE `id:` field is set for `message` events only (it is the message id, so `Last-Event-ID` is always a message id). `hidden`, `closed`, `reopened` and `read` events have no id and are **not replayed** after a reconnect: clients refetch on reconnect.
- **Unhide emits `hidden`.** Hiding and unhiding both emit `kind: "hidden"` with the message id; the client refetches to learn the new state.
- **Nudge cooldown semantics.** The cooldown is per (conversation, person), measured from the last nudge actually sent. A message sent during the cooldown is not announced by e-mail later; the person sees it in the unread count. `CHAT_NUDGE_COOLDOWN_MIN=0` disables the cooldown (every staff message e-mails). A failed or refused delivery keeps the slot held for `CHAT_NUDGE_FAILURE_BACKOFF_MIN` minutes (default 5; `0` releases it at once) so an outage is retried at most once per backoff.
- **Staff rooms and explicit participants** are implemented (review round 1): create a room, add / remove participants, HR and Accountant limited to the rooms they joined (see SETUP.md section 3a). Deleting (not deactivating) the user who added a participant clears `added_by` and ends that participant's access.
- **Candidate start toggle.** `CHAT_CANDIDATE_CAN_START` (default `true`) lets a candidate open their own conversation; set it to `false` if staff must always write first.
- **The SSE hub is in-process.** A single app container is assumed. Several app processes would each only serve their own streams (the polling fallback still shows new messages within 30 s). A shared bus is not built.
- **Employer / agency users receive no message from one another and staff get no e-mail**: staff see in-app unread counts only.
- **No read receipts**: the other side never learns that a message was read (the `read` event goes only to the reader's own streams).
- **Retention** of chat data is the owner's decision (see above); nothing is purged.

## Review round 1 (independent messaging review)

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | Fan-out cost: every event cost several queries per subscribed stream | completed, tested | `hub.publish` resolves the recipients with ONE query (`scope.subscriberAccess`: account still live + conversation in scope, same rules as `conversationVisibleSql`) and queues delivery only for visible users; revoked accounts are closed from the same query. The per-stream account re-check is cached `CHAT_SSE_RECHECK_MS` (default 5000) and always runs on heartbeat. `tests/chat-realtime.test.js` (50 and 100 streams without access = 1 statement; cache window driven by an injected clock and `hub.clearRecheckCache()`; revocation inside the window; ordering), `tests/chat-api.test.js` (SQL consistency for every user x conversation). The existing revocation tests are unchanged and still pass because the single query reads current state on every event. |
| 2 | Staff rooms and explicit participants were promised but missing | completed, tested; **UI wiring only tested at string level** | `POST/DELETE/GET /chat/conversations/:id/participants`, `GET /chat/staff`, `POST /chat/conversations` with `subject_type: "staff"`; HR / Accountant access rule; "New staff room" and "Add participant" dialogs (ar/en/fr). `tests/chat-api.test.js`, `tests/chat-realtime.test.js`, `tests/chat-e2e.test.js` P, `tests/chat-ui.test.js`. Not rendered in a browser. |
| 3 | Replay could miss a lower id that committed after a higher one | completed, tested | Replay = `id > last` OR (`id <= last` and created within 2 minutes before the last message), newest 200, ascending; index `chat_messages_created_idx` (migration 022). Two real transactions commit out of order in `tests/chat-realtime.test.js`; duplicate-safe merge in `tests/chat-ui.test.js`. |
| 4 | Client could mark read messages it never loaded | completed, tested | `markReadPlan` / `markReadDecision` in `chat-util.js` + auto page-in (max 5 pages) in `chat-panel.js`. `tests/chat-ui.test.js`. |
| 5 | Invisible / disguised message bodies | completed, tested | Bodies with nothing but format, space or control characters are refused; bidi override / embedding / isolate controls (U+202A-202E, U+2066-2069) are refused (400, clear message) on the server (`common.js`) and in the composer counter. ZWJ / ZWNJ / LRM / RLM stay allowed. `tests/chat-api.test.js`, `tests/chat-ui.test.js`, `tests/chat-e2e.test.js` K. |
| 6 | A failed nudge released its slot immediately | completed, tested | Slot held for `CHAT_NUDGE_FAILURE_BACKOFF_MIN` (default 5). `tests/chat-realtime.test.js` (injected clock). |
| 7 | Immutability trigger allowed any UPDATE of `sender_user_id` to NULL | completed, tested | Migration `022_chat_hardening.sql`: NULL only when `pg_trigger_depth() > 1` (the foreign-key action). User deletion still works. `tests/chat-schema.test.js`, migration lists in `tests/fin-schema.test.js`. |

Remaining limits after this round: the hub is in-process (one app container); ids are not globally commit-ordered (replay overlap of 2 minutes mitigates it; a client offline for more than 200 messages must refetch); the browser behaviour of the new dialogs and of the read-marker paging has not been exercised in a real browser.
