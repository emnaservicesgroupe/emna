// Inbox, review queue, drafts and interviews (mounted at /jobsearch, Task 13):
//   POST /inbound/mail                       provider push; HMAC-SHA256 of the raw body in X-VITA-Signature
//                                            ("sha256=<hex>", secret INBOUND_MAIL_SECRET); 401 without a valid
//                                            signature, 413 over INBOUND_MAIL_MAX_BYTES, 429 over the rate limit.
//                                            Body: normalized message JSON, or {type:'delivery_status', ...}
//   GET  /messages?state=&applicationId=     scoped (unmatched: Admin/SuperAdmin/Manager; Candidate: released only)
//   GET  /messages/:id
//   POST /messages/:id/assign                {applicationId}            jobsearch:approve + scope (message AND application)
//   POST /messages/:id/share-with-candidate  {}                         staff jobsearch:write + scope
//   POST /messages/:id/apply-classification {status, reason?}          jobsearch:approve + scope; status interview|offer|rejected
//   POST /messages/:id/draft                 {lang?}                    staff jobsearch:write + scope
//   POST /drafts/:id/send                    {}                         jobsearch:approve, or an enabled ack_reply rule
//   POST /messages/:id/interview             {proposedStart, tz, durationMinutes?, title?, additionalRound?}  jobsearch:approve + scope;
//                                            409 interview_already_scheduled when a live slot exists (reschedule it)
//   POST /interviews/:id/availability        {available: true, note?}   Candidate (own) or staff recording it (note)
//   POST /interviews/:id/cancel              {reason?}                  jobsearch:approve + scope
//   POST /interviews/:id/reschedule          {proposedStart, tz, durationMinutes?}
//   GET  /interviews?applicationId=          scoped
const crypto = require("crypto");
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { asyncHandler } = require("../modules/jobsearch/errorHandler");
const { HttpError } = require("../modules/jobsearch/httpError");
const inbox = require("../modules/jobsearch/inbox");
const draftService = require("../modules/jobsearch/draftService");
const interviewService = require("../modules/jobsearch/interviewService");

const router = express.Router();
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) && !Buffer.isBuffer(req.body) ? req.body : {});

/** Only the listed fields; anything else in the body is refused (400). */
function pick(req, allowed) {
  const b = body(req);
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) throw new HttpError(400, `Unknown field(s): ${extra.slice(0, 5).join(", ")}`);
  return b;
}

// ---------------------------------------------------------------- inbound webhook

const hits = new Map(); // ip -> [timestamps] (insertion order = least recently refreshed first)
const MAX_TRACKED = 10000;
function evict(now) {
  for (const [ip, arr] of hits) if (!arr.length || now - arr[arr.length - 1] >= 60000) hits.delete(ip);
  // still too many live entries: drop the least recently seen ones (never the whole map)
  for (const ip of hits.keys()) {
    if (hits.size <= MAX_TRACKED) break;
    hits.delete(ip);
  }
}
function rateLimited(ip) {
  const limit = Number(process.env.INBOUND_MAIL_RATE_PER_MIN) > 0 ? Number(process.env.INBOUND_MAIL_RATE_PER_MIN) : 120;
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.delete(ip);
  hits.set(ip, arr); // re-insert: most recent last
  if (hits.size > MAX_TRACKED) evict(now);
  return arr.length > limit;
}

function validSignature(raw, header) {
  const secret = process.env.INBOUND_MAIL_SECRET;
  if (!secret || typeof header !== "string") return false;
  const m = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(m[1], "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

router.post("/inbound/mail", asyncHandler(async (req, res) => {
  if (rateLimited(req.ip || "unknown")) {
    res.set("Retry-After", "60");
    throw new HttpError(429, "Too many requests");
  }
  if (!process.env.INBOUND_MAIL_SECRET) throw new HttpError(503, "Inbound mail webhook is not configured (INBOUND_MAIL_SECRET)");
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!validSignature(raw, req.get("x-vita-signature"))) throw new HttpError(401, "Invalid signature");
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  if (payload && payload.type === "delivery_status") return res.json(await inbox.ingestDeliveryStatus(payload));
  const r = await inbox.ingest(inbox.normalizeInbound(payload));
  return res.json({ stored: !r.duplicate, duplicate: r.duplicate, id: r.id });
}));

// ---------------------------------------------------------------- messages

router.get("/messages", verifyToken, asyncHandler(async (req, res) => {
  res.json(await inbox.listMessages({ user: req.user, query: { state: req.query.state, applicationId: req.query.applicationId } }));
}));

router.get("/messages/:id", verifyToken, asyncHandler(async (req, res) => {
  res.json(await inbox.getMessage({ user: req.user, id: req.params.id }));
}));

router.post("/messages/:id/assign", verifyToken, asyncHandler(async (req, res) => {
  const b = pick(req, ["applicationId"]);
  res.json(await inbox.assignReview({ messageId: req.params.id, applicationId: b.applicationId, actor: req.user }));
}));

router.post("/messages/:id/share-with-candidate", verifyToken, asyncHandler(async (req, res) => {
  pick(req, []);
  res.json(await inbox.shareWithCandidate({ messageId: req.params.id, actor: req.user }));
}));

router.post("/messages/:id/apply-classification", verifyToken, asyncHandler(async (req, res) => {
  const b = pick(req, ["status", "reason"]);
  res.json(await inbox.applyClassification({ messageId: req.params.id, actor: req.user, status: b.status, reason: b.reason }));
}));

router.post("/messages/:id/draft", verifyToken, asyncHandler(async (req, res) => {
  const b = pick(req, ["lang"]);
  res.status(201).json(await draftService.createDraft({ messageId: req.params.id, actor: req.user, lang: b.lang }));
}));

router.post("/drafts/:id/send", verifyToken, asyncHandler(async (req, res) => {
  pick(req, []);
  const out = await draftService.sendFollowUp({ draftId: req.params.id, actor: req.user });
  res.status(out.sent ? 200 : 409).json(out);
}));

// ---------------------------------------------------------------- interviews

router.post("/messages/:id/interview", verifyToken, asyncHandler(async (req, res) => {
  const b = pick(req, ["proposedStart", "tz", "durationMinutes", "title", "additionalRound"]);
  res.status(201).json(await interviewService.createFromMessage({ messageId: req.params.id, proposedStart: b.proposedStart, tz: b.tz, durationMinutes: b.durationMinutes, title: b.title, additionalRound: b.additionalRound, actor: req.user }));
}));

router.post("/interviews/:id/availability", verifyToken, asyncHandler(async (req, res) => {
  const b = pick(req, ["available", "note"]);
  res.json(await interviewService.confirmInterview({ id: req.params.id, candidateAvailabilityConfirmed: b.available === true, actor: req.user, note: b.note }));
}));

router.post("/interviews/:id/cancel", verifyToken, asyncHandler(async (req, res) => {
  const b = pick(req, ["reason"]);
  res.json(await interviewService.cancelInterview({ id: req.params.id, actor: req.user, reason: b.reason }));
}));

router.post("/interviews/:id/reschedule", verifyToken, asyncHandler(async (req, res) => {
  const b = pick(req, ["proposedStart", "tz", "durationMinutes"]);
  res.json(await interviewService.rescheduleInterview({ id: req.params.id, proposedStart: b.proposedStart, tz: b.tz, durationMinutes: b.durationMinutes, actor: req.user }));
}));

router.get("/interviews", verifyToken, asyncHandler(async (req, res) => {
  res.json(await interviewService.listInterviews({ user: req.user, query: { applicationId: req.query.applicationId } }));
}));

// Same contract as the shared jobsearch handler, plus a machine-readable code when one is set.
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  console.error("jobsearch inbox error:", err && err.name, err && err.code, err && err.message);
  return res.status(500).json({ error: "Internal server error" });
});

module.exports = router;
module.exports._internal = { hits, rateLimited, MAX_TRACKED };
