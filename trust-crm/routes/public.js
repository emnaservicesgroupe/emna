// Unauthenticated public website API (mounted at /public, with its own 16 KB JSON parser in app.js):
//   GET  /config      set SITE_* facts only
//   GET  /jobs        staff-published, not-expired offers (allowlisted fields)
//   GET  /jobs/:id
//   POST /leads       candidate / employer / contact form. Honeypot field: `hp_url` (any non-blank value => stored as
//                     spam, still answered ok). Limits: per client (IPv6 by /64) per hour, per e-mail/phone per day and
//                     SITE_LEAD_GLOBAL_PER_DAY overall; all answer 429 + Retry-After. A same-email resubmission within
//                     24h only fills gaps of a new/contacted/qualified lead; converted/rejected leads are never written.
const express = require("express");
const { HttpError } = require("../modules/jobsearch/httpError");
const { asyncHandler } = require("../modules/jobsearch/errorHandler");
const { getPublicConfig } = require("../modules/site/publicConfig");
const { listPublishedJobs, getPublishedJob } = require("../modules/site/siteJobs");
const { createLead, checkIpLimit } = require("../modules/site/leadService");

const router = express.Router();
const db = () => require("../db");

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/config", (_req, res) => res.json(getPublicConfig()));

router.get(
  "/jobs",
  asyncHandler(async (req, res) => {
    const q = req.query;
    const pick = (v) => (typeof v === "string" ? v : undefined);
    const jobs = await listPublishedJobs(db(), { country: pick(q.country), category: pick(q.category), limit: pick(q.limit), offset: pick(q.offset) });
    return res.json({ jobs });
  })
);

router.get(
  "/jobs/:id",
  asyncHandler(async (req, res) => {
    const job = await getPublishedJob(db(), req.params.id);
    if (!job) throw new HttpError(404, "Not found");
    return res.json(job);
  })
);

router.post(
  "/leads",
  asyncHandler(async (req, res) => {
    await checkIpLimit(db(), req.ip);
    const out = await createLead(db(), req.body, { ip: req.ip });
    return res.json({ ok: out.ok });
  })
);

// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    if (err.retryAfter) res.set("Retry-After", String(err.retryAfter));
    return res.status(err.status).json({ error: err.message });
  }
  // Never log request bodies (personal data).
  console.error("public error:", err && err.name, err && err.code, err && err.message);
  return res.status(500).json({ error: "Internal server error" });
});

module.exports = router;
