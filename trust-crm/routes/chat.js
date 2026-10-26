// Messaging API (stage 6), mounted at /chat with its own 16 kb JSON parser (app.js). Router level: a verified token (versioned portal
// tokens are re-checked against the account and organisation), a role that can use chat at all (HR / Accountant are refused for now),
// and the ACTOR is rebuilt from the database on every request (deactivated account -> 401, suspended organisation / deleted candidate -> 403).
//   GET  /conversations ?limit(<=50)&offset                 scoped list: unread_count, last-message preview (a hidden message is a stub for external viewers)
//   POST /conversations {subject_type, subject_id}          staff (serves the subject) or a candidate (own conversation, CHAT_CANDIDATE_CAN_START); idempotent: 201 new / 200 existing
//   GET  /conversations/:id/messages ?before&limit(<=50)    newest first; hidden messages are {id, created_at, hidden:true} for external viewers
//   POST /conversations/:id/messages {body}                 1..2000 characters; 409 closed; 429 + Retry-After above CHAT_RATE_PER_MIN (default 30) per user
//   POST /conversations/:id/read {message_id}               monotonic read marker
//   GET  /unread-count                                      {unread, conversations}
//   POST /conversations/:id/close | reopen                  chat:moderate
//   POST /messages/:id/hide {reason} | unhide {reason?}     chat:moderate
//   GET  /events                                            SSE (fetch + Authorization header, Last-Event-ID replay, ids only, per-user cap -> 429); see modules/chat/hub.js
//   GET | PUT /prefs {email_nudges: boolean}                e-mail nudge opt-out, any allowed actor
//   GET  /channels                                          honest channel status (staff only): in_app, email (mail adapter), whatsapp requires_setup
// Out-of-scope and nonexistent ids answer the identical 404 for every actor; malformed ids are a 400. There is no edit or delete endpoint:
// messages are immutable (the database also refuses it).
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const { HttpError } = require("../modules/jobsearch/httpError");
const db = require("../db");
const scope = require("../modules/chat/scope");
const conversations = require("../modules/chat/conversations");
const messages = require("../modules/chat/messages");
const hub = require("../modules/chat/hub");
const prefs = require("../modules/chat/prefs");
const channels = require("../modules/chat/channels");

const router = express.Router();
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null);

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(verifyToken);
router.use((req, res, next) => (req.user && scope.ALL_CHAT_ROLES.has(req.user.role) ? next() : res.status(403).json({ error: "Access denied" })));
router.use(
  asyncHandler(async (req, _res, next) => {
    req.chat = await scope.resolveActor(db, req.user);
    next();
  })
);

const moderator = (req, _res, next) => (req.chat.perms.moderate ? next() : next(new HttpError(403, "Permission denied: chat:moderate")));

router.get("/conversations", asyncHandler(async (req, res) => res.json(await conversations.listConversations(req.chat, req.query))));
router.post(
  "/conversations",
  asyncHandler(async (req, res) => {
    const out = await conversations.openConversation(req.chat, body(req));
    res.status(out.created ? 201 : 200).json(out.conversation);
  })
);
router.get("/conversations/:id/messages", asyncHandler(async (req, res) => res.json(await messages.listMessages(req.chat, req.params.id, req.query))));
router.post("/conversations/:id/messages", asyncHandler(async (req, res) => res.status(201).json(await messages.sendMessage(req.chat, req.params.id, body(req)))));
router.post("/conversations/:id/read", asyncHandler(async (req, res) => res.json(await conversations.markRead(req.chat, req.params.id, body(req)))));
router.get("/unread-count", asyncHandler(async (req, res) => res.json(await conversations.unreadCount(req.chat))));
router.post("/conversations/:id/close", moderator, asyncHandler(async (req, res) => res.json(await conversations.setStatus(req.chat, req.params.id, "closed"))));
router.post("/conversations/:id/reopen", moderator, asyncHandler(async (req, res) => res.json(await conversations.setStatus(req.chat, req.params.id, "open"))));
router.post("/messages/:id/hide", moderator, asyncHandler(async (req, res) => res.json(await messages.setHidden(req.chat, req.params.id, body(req), true))));
router.post("/messages/:id/unhide", moderator, asyncHandler(async (req, res) => res.json(await messages.setHidden(req.chat, req.params.id, body(req), false))));

router.get(
  "/events",
  asyncHandler(async (req, res) => {
    const raw = req.get("Last-Event-ID");
    let lastEventId = null;
    if (raw !== undefined && raw !== "") {
      if (!/^\d{1,18}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new HttpError(400, "Last-Event-ID must be a numeric event id");
      lastEventId = Number(raw);
    }
    try {
      await hub.subscribe(req.chat, req, res, lastEventId);
    } catch (err) {
      if (err instanceof hub.LimitError && !res.headersSent) throw new HttpError(err.status, err.message);
      throw err;
    }
  })
);
router.get("/prefs", asyncHandler(async (req, res) => res.json(await prefs.getPrefs(req.chat))));
router.put("/prefs", asyncHandler(async (req, res) => res.json(await prefs.setPrefs(req.chat, body(req)))));
router.get(
  "/channels",
  asyncHandler(async (req, res) => {
    if (req.chat.kind !== "staff") throw new HttpError(403, "Access denied");
    res.json(await channels.channels());
  })
);

router.use((err, _req, res, next) => {
  if (err && err.retryAfter) res.set("Retry-After", String(err.retryAfter));
  next(err);
});
router.use(jobsearchErrorHandler);

module.exports = router;
