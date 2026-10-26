# VITA Messaging — setup and daily use

Messaging is part of the same VITA app: no extra service, container or database. It is switched on by migration 021, which runs with the normal update (`./update.sh` / app start).
What was and was not verified: [CHECKLIST.md](CHECKLIST.md).

**What it is.** Text messages between staff and the people they serve: a candidate, an employer organisation or an agency. Each conversation is about one subject (a candidate,
an employer, an agency) and has unread counts, near-real-time delivery and an e-mail nudge. **Not included:** WhatsApp or SMS (needs your provider account and approved templates —
the channel shows "requires setup" and sends nothing), files, images and voice.

## 1. Settings (all optional)

Put them in `.env` (on the VPS: `deploy/hostinger/.env`), then `docker compose up -d`. Defaults apply when a line is absent or malformed.

| Variable | Default | Meaning |
|---|---|---|
| `CHAT_RATE_PER_MIN` | `30` | Messages one user can send per minute across **all** conversations. Above it the API answers 429 with `Retry-After`. |
| `CHAT_CANDIDATE_CAN_START` | `true` | May a candidate open their own conversation with their staff? `false` (or `0`, `no`, `off`): staff must write first. |
| `CHAT_NUDGE_COOLDOWN_MIN` | `15` | Minutes between two e-mail nudges for the same person in the same conversation. `0` = no cooldown (every staff message e-mails). |
| `CHAT_SSE_MAX_PER_USER` | `5` | Live-update streams one user can hold open (browser tabs). More are refused with 429; the page falls back to polling. |
| `CHAT_SSE_MAX_TOTAL` | `500` | Live-update streams in total (above it: 503). |
| `CHAT_SSE_HEARTBEAT_MS` | `25000` | Heartbeat of an idle stream, in milliseconds. Keep it below the idle timeout of any proxy in front of the app. |
| `SITE_BASE_URL` | empty | Public address of VITA (`https://your-domain`). If set, the e-mail nudge carries a link to it; if empty, no link. Also used by the public website. |
| `WHATSAPP_PROVIDER` | empty | **Has no effect on sending.** WhatsApp is not implemented; whatever the value, the channel reports "requires setup" and nothing is sent. |

E-mail nudges use the mail settings of the job-search module (`MAIL_PROVIDER` and friends; see `docs/vita-job-search/SETUP.md`, "Mail (outgoing)"). With the default **sandbox** provider the
nudge is only recorded in the sandbox mailbox and **no real e-mail leaves the server** — the "Channels" box of the Messages tab says so.

**Behind a proxy.** Live updates are a server-sent-events stream at `/chat/events`. The bundled Caddy flushes immediately and does not compress it. A different proxy or CDN must not
buffer or compress `/chat/events` (and `/jobsearch/events`). Run **one** app container: the hub that fans events out lives inside the app process.

## 2. Who can do what

| Role | Sees | Writes | Opens a conversation | Hides messages, closes / reopens |
|---|---|---|---|---|
| SuperAdmin, Admin, Manager | every candidate, employer and agency conversation | yes | for any candidate, employer or agency | yes |
| Receptionist, Agent | conversations of candidates **assigned to them** (and rooms they were explicitly added to) | yes | for their assigned candidates only | no |
| HR, Accountant | nothing (no chat access yet) | no | no | no |
| Candidate | only the conversation about themselves | yes (if staff opened it, or `CHAT_CANDIDATE_CAN_START`) | their own only | no |
| Employer user | the thread of their organisation (all users of the organisation share it) | yes | no | no |
| Agency user | the thread of their agency (shared by its users) | yes | no | no |

The permission columns (`chat:read`, `chat:write`, `chat:moderate`) per role are in the matrix of `docs/vita-job-search/SETUP.md` section 6 (Staff and candidate accounts); a test keeps it equal to the code.
Anything outside a person's scope looks exactly like a message that does not exist ("Not found"), so nobody can probe for other conversations. Reassigning a candidate moves the
conversation to the new owner immediately; the previous staff member loses it.

## 3. Staff: open a conversation and write

1. Open the console and the **Messages** tab. Unread conversations show a badge; the tab badge is the total.
2. **New conversation:** choose the subject (a candidate by name or id; an employer or an agency if your role may serve organisations). If the conversation already exists you are taken to it.
3. Write in the composer (up to 2000 characters, text only) and send. The person gets an e-mail saying only "you have a new message in VITA" (no content, at most one per 15 minutes
   per conversation by default). A reply from them appears in the list and in the unread count; staff are never e-mailed.
4. A person who switched off the e-mails still sees everything in the portal.

**Moderation (Admin, SuperAdmin, Manager):**

- **Hide** a message (a reason is required, up to 500 characters): the person on the other side sees "message removed" with no text; staff still see the text and the reason; the
  action is audited. **Unhide** restores it.
- **Close** a conversation: nobody can send (409) but everyone can still read; **Reopen** to continue.

## 4. Candidates, employers and agencies: the Messages tab

- **Candidate portal:** step **Messages with VITA**; **Employer portal** and **Agency portal:** the **Messages** tab. They show the thread with VITA staff, an unread badge and a composer.
  New messages appear within seconds (live stream) or within 30 seconds (fallback). People can switch the e-mail nudges off in the tab's settings.
- Employers and agencies cannot start a conversation: VITA staff write first. A candidate can start theirs unless `CHAT_CANDIDATE_CAN_START=false`.
- All users of one employer or agency organisation see the same thread, including each other's messages.

## 5. Privacy notes

- **Text only.** No attachments. Tell users **never to send passwords, one-time codes, bank details, passport or ID numbers** in a message: messages are stored as written and are
  readable by every staff member allowed to serve that person (Admin, Manager, and the assigned staff).
- Messages cannot be edited or deleted by their author; only a moderator can hide one. Hidden text stays in the database (it is not erased) and is shown only to staff.
- The audit log records who sent a message, in which conversation and its length, **never its text**. E-mail nudges and live-update events never contain message text either.
- **Retention is your decision.** Nothing is purged automatically. If you set a retention period, it has to be applied by an operator (backup policy and, if needed, a reviewed SQL clean-up), because messages are immutable by design.
- System-generated texts promise nothing (no employment, no visa). Staff are responsible for what they write.

## 6. First-use check on your own installation

1. As a Manager: Messages tab -> open a conversation with a test candidate (a candidate with a portal account and an e-mail address you can read), send a message.
2. As that candidate: the Messages step shows the message and an unread badge; reply. With the sandbox mail provider no e-mail leaves the server; with real mail, check the nudge arrived and contains no text.
3. As a Manager: hide the candidate's message and confirm the candidate sees "message removed"; close the conversation and confirm sending is refused; reopen.
4. As an unassigned Agent: confirm the conversation is not listed. Assign the candidate to that Agent and confirm it appears at once.
5. With the browser's network tab open, confirm `/chat/events` stays open and is not buffered (messages appear immediately); if a proxy buffers it, new messages only appear within 30 seconds.
6. In the Channels box confirm: in-app connected, e-mail as expected for your mail provider, WhatsApp "requires setup".
