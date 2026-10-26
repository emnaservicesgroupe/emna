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

## Data (migration 021)

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

- [x] completed, tested: HR and Accountant are 403 on every `/chat` route and cannot open a stream; anonymous callers 401. `tests/chat-api.test.js`, `tests/chat-realtime.test.js`, `tests/chat-e2e.test.js` G.
- [x] completed, tested: Candidate, Employer and Agency tokens reach `/chat/*` only; they are 403 on the other route classes (spot check in `tests/chat-e2e.test.js` G) and the all-routes sweep, which classifies every `/chat/*` route and seeds sentinels in the conversations, passes as a child process (`tests/chat-e2e.test.js` O, `tests/orgs-route-sweep.test.js`).
- [x] completed, tested: a deactivated user's token stops working at once and the open stream is closed without receiving the next event (`tests/chat-e2e.test.js` M).
- [x] completed, tested: no message text appears in any SSE frame or any e-mail body or any audit row of the whole end-to-end run (sentinels, `tests/chat-e2e.test.js` N).

## User interface

- [x] completed, tested (string / structure level): "Messages" tab in the staff console and a Messages panel in the candidate, employer and agency portals; ar/en/fr parity, CSP-safe (no inline script), `textContent` only, SSE over `fetch` with a 30 s polling fallback. `tests/chat-ui.test.js`.
- [ ] **Blocked / not repeatable:** rendering in a real browser (live delivery, RTL Arabic, 375 px width, no CSP violations) has no committed test. It was exercised once by hand during Task 4 and not re-run for this checklist.

## Known limits (from the agents' reports)

- **Event ids exist only for message events.** The SSE `id:` field is set for `message` events only (it is the message id, so `Last-Event-ID` is always a message id). `hidden`, `closed`, `reopened` and `read` events have no id and are **not replayed** after a reconnect: clients refetch on reconnect.
- **Unhide emits `hidden`.** Hiding and unhiding both emit `kind: "hidden"` with the message id; the client refetches to learn the new state.
- **Nudge cooldown semantics.** The cooldown is per (conversation, person), measured from the last nudge actually sent. A message sent during the cooldown is not announced by e-mail later; the person sees it in the unread count. `CHAT_NUDGE_COOLDOWN_MIN=0` disables the cooldown (every staff message e-mails). A failed delivery gives the slot back.
- **Staff rooms only for explicit participants.** The `staff` subject type exists in the model and visibility, but there is no UI or endpoint to create a staff room yet, and **HR and Accountant have no chat access yet** (they hold no `chat:*` permission; the router refuses them).
- **Candidate start toggle.** `CHAT_CANDIDATE_CAN_START` (default `true`) lets a candidate open their own conversation; set it to `false` if staff must always write first.
- **The SSE hub is in-process.** A single app container is assumed. Several app processes would each only serve their own streams (the polling fallback still shows new messages within 30 s). A shared bus is not built.
- **Employer / agency users receive no message from one another and staff get no e-mail**: staff see in-app unread counts only.
- **No read receipts**: the other side never learns that a message was read (the `read` event goes only to the reader's own streams).
- **Retention** of chat data is the owner's decision (see above); nothing is purged.
