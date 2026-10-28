# VITA — Messaging (Stage 6) — Design

Status: next stage in the owner's confirmed order; the owner's standing instruction ("finish what you start") covers spec/plan approval.
Code: `trust-crm/`. Additive only; same branch/PR #8 until merged.

## 1. Goal and success criteria
Staff and the external parties they serve (candidates, employers, agencies) can exchange text messages inside VITA, in conversations tied to a clear subject, with unread counts, near-real-time delivery, e-mail nudges, and strict privacy: an external party sees only their own conversations; staff see only conversations of people they are allowed to serve; nothing is ever delivered to the wrong person. Done = tests on real Postgres (isolation, concurrency, ordering, rate limits), an honest checklist, and a browser smoke across all four portals.

Hard rules: text only (no file upload, no links previews, no HTML); messages are immutable (no edit; staff/admin may *hide* a message with a reason, which keeps an audit record); every message is audited with sender role and time; no WhatsApp/SMS sending is implemented without the owner's provider credentials — the WhatsApp channel shows `requires_setup` and the code path is covered by a sandbox adapter only; external parties may message only staff-initiated or already-open conversations (no cold messaging between external parties); abuse controls (length cap, per-user rate limit, blocked conversation state); content is untrusted data rendered with `textContent`; no promises of employment/visa in system-generated texts.

## 2. Model and rules
- **Conversation** = `(subject_type, subject_id)` + participants. Subject types: `candidate` (staff ↔ that candidate), `employer_request` (staff ↔ that employer org's users), `agency` (staff ↔ that agency's users), `staff` (internal staff-only room created by HR/Admin, optional).
- **Who can read/write:**
  - Candidate: only the conversation about themselves; can reply only after staff opened it or, if the candidate's consent record exists, to start one with their assigned staff (`candidate_can_start` setting default true).
  - Employer/Agency users: conversations of their organisation only (all users of that org see the org's thread).
  - Staff: `chat:read`/`chat:write` for Admin, SuperAdmin, Manager, Receptionist, Agent (+ HR for `staff` rooms); candidate/agency/employer conversations visible to the assigned staff (`candidates.assigned_to`), Admins and Managers (all), HR/Accountant none unless they are explicit participants (`chat_participants`).
  - Staff-only `staff` rooms: participants only.
- **Unread:** per participant `last_read_message_id`; unread count computed in SQL.
- **Moderation:** staff with `chat:moderate` (Admin, SuperAdmin, Manager) can hide/unhide a message (`hidden_at`, `hidden_by`, `hidden_reason`); hidden messages show as "message removed" to external parties; can close/reopen a conversation (closed ⇒ no new messages).
- **Notifications:** after commit, enqueue an e-mail nudge ("you have a new message in VITA", no content) to external parties using the existing mail adapter with a per-conversation cooldown (default 15 min) and opt-out flag in `chat_prefs`; staff get in-app unread counts only.
- **Realtime:** SSE endpoint `/chat/events` with the same safety rules as the job-search hub (token via fetch Authorization, resumable by `Last-Event-ID`, per-user connection cap, events carry only ids/kinds — clients refetch).

## 3. Data (migration 021, additive, idempotent)
`chat_conversations(id, subject_type check, subject_id, title (staff rooms), status open|closed, created_by, created_at, last_message_at, last_message_id)` UNIQUE(subject_type, subject_id) for non-staff types;
`chat_participants(conversation_id, user_id, added_by, added_at, last_read_message_id, muted bool, PRIMARY KEY(conversation_id,user_id))` (explicit participants; external users are implicit via org/candidate link and get rows lazily on first read/write);
`chat_messages(id bigserial, conversation_id, sender_user_id, sender_role, body text 1..2000, created_at, hidden_at, hidden_by, hidden_reason)` insert-only except the hide columns (trigger forbids changing other columns and deletes);
`chat_prefs(user_id pk, email_nudges bool default true)`; `chat_nudges(conversation_id, user_id, last_sent_at)`; `chat_channel_outbox(id, message_id, channel whatsapp|email, status queued|sent|failed|requires_setup, detail, created_at)` (used by the WhatsApp sandbox adapter).
Permissions: `chat:read`, `chat:write`, `chat:moderate`.

## 4. APIs
Single router `/chat/*` (own 16 KB body parser): `GET /chat/conversations` (scoped list with unread counts, last message preview — preview omitted for hidden), `GET /chat/conversations/:id/messages?before&limit≤50`, `POST /chat/conversations/:id/messages {body}`, `POST /chat/conversations/:id/read {message_id}`, `POST /chat/conversations` (staff opening a conversation for a subject they can serve; idempotent per subject), `POST /chat/conversations/:id/close|reopen` (moderate), `POST /chat/messages/:id/hide|unhide {reason}` (moderate), `GET /chat/unread-count`, `GET /chat/events` (SSE), `GET/PUT /chat/prefs` (e-mail nudge opt-out), `GET /chat/channels` (honest status: in-app `connected`, e-mail `connected` per mail adapter, WhatsApp `requires_setup`). Out-of-scope ids ⇒ identical 404. Candidate/Employer/Agency tokens allowed on `/chat/*` only; all other routes remain denied for them (route sweep updated).

## 5. UI
Staff console tab "Messages" (conversation list with unread badges, thread view, composer, open-conversation dialog by subject, moderation actions); chat panel in the candidate portal, employer portal and agency portal ("Messages" tab). ar/en/fr, RTL, CSP-safe, SSE via fetch + reconnect, polling fallback every 30 s.

## 6. Testing
Isolation matrix (candidate A/B, employer A/B, agency A/B, each staff role, HR/Accountant), assignment change moves visibility, closed conversation, hidden message handling for external vs staff, ordering and pagination, concurrent sends (ids monotonic, no loss), rate limit and length cap, unread math, SSE scoping and replay (events never reach other users), e-mail nudge cooldown/opt-out via sandbox mailbox, WhatsApp requires_setup honesty, route sweep, immutability trigger, audit rows, XSS/HTML as text, e2e journey, browser smoke on four portals.

## 7. Out of scope
File/voice/image messages, group chats among external parties, message editing/deletion by authors, read receipts visible to the other side, push notifications/mobile app, real WhatsApp/SMS sending (needs the owner's provider account and approved templates), AI replies (stage 7).
Owner inputs: WhatsApp Business provider credentials and approved templates (later), retention period for chat data, staff routing preferences.
