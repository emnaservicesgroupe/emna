// Agency portal API (mounted at /agency, with its own 16 KB JSON parser in app.js). Agency role only; the agency
// always comes from the token's crm_org_accounts link, never from the request.
const express = require("express");
const { requirePortalRole } = require("../modules/orgs/portalAuth");
const { HttpError } = require("../modules/jobsearch/httpError");
const { asyncHandler } = require("../modules/jobsearch/errorHandler");
const svc = require("../modules/orgs/agencyCandidates");

const router = express.Router();

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(requirePortalRole("Agency"));

router.get(
  "/me",
  asyncHandler(async (req, res) => res.json({ role: "Agency", org: await svc.getOrg(req.org.id) }))
);

router.get(
  "/candidates",
  asyncHandler(async (req, res) => res.json(await svc.list(req.org.id, req.query)))
);

router.post(
  "/candidates",
  asyncHandler(async (req, res) => res.status(201).json(await svc.create(req.user, req.org.id, req.body)))
);

router.get(
  "/candidates/:id",
  asyncHandler(async (req, res) => res.json(await svc.get(req.org.id, req.params.id)))
);

// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    if (err.retryAfter) res.set("Retry-After", String(err.retryAfter));
    return res.status(err.status).json({ error: err.message });
  }
  console.error("agency portal error:", err && err.name, err && err.code, err && err.message);
  return res.status(500).json({ error: "Internal server error" });
});

module.exports = router;
