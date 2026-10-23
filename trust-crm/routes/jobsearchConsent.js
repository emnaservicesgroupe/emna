// Consent, settings and modes (mounted at /jobsearch):
//   POST /candidates/:id/consent            GET /candidates/:id/consent
//   POST /candidates/:id/consent/withdraw
//   GET|PUT /candidates/:id/settings        PUT /candidates/:id/preferences
//   POST /candidates/:id/pause              POST /module/pause
//   GET  /candidates/:id/eligibility
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const consent = require("../modules/jobsearch/consentService");
const settings = require("../modules/jobsearch/settingsService");

const router = express.Router();
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

router.post("/candidates/:id/consent", verifyToken, asyncHandler(async (req, res) => {
  const b = body(req);
  const c = await consent.grantConsent({ user: req.user, candidateId: req.params.id, scope: b.scope, version: b.version, recordedBy: b.recordedBy, evidenceNote: b.evidenceNote });
  res.status(201).json(c);
}));

router.get("/candidates/:id/consent", verifyToken, asyncHandler(async (req, res) => {
  res.json(await consent.listConsents({ user: req.user, candidateId: req.params.id }));
}));

router.post("/candidates/:id/consent/withdraw", verifyToken, asyncHandler(async (req, res) => {
  const b = body(req);
  res.json(await consent.withdrawConsent({ user: req.user, candidateId: req.params.id, scopeKey: b.scopeKey !== undefined ? b.scopeKey : b.scope }));
}));

router.get("/candidates/:id/settings", verifyToken, asyncHandler(async (req, res) => {
  res.json(await settings.getSettings({ user: req.user, candidateId: req.params.id }));
}));

router.put("/candidates/:id/settings", verifyToken, asyncHandler(async (req, res) => {
  res.json(await settings.updateSettings({ user: req.user, candidateId: req.params.id, patch: req.body }));
}));

router.put("/candidates/:id/preferences", verifyToken, asyncHandler(async (req, res) => {
  res.json(await settings.updatePreferences({ user: req.user, candidateId: req.params.id, preferences: req.body }));
}));

router.post("/candidates/:id/pause", verifyToken, asyncHandler(async (req, res) => {
  res.json(await settings.pauseCandidate(req.params.id, body(req).paused, req.user));
}));

router.post("/module/pause", verifyToken, asyncHandler(async (req, res) => {
  res.json(await settings.pauseModule(body(req).paused, req.user));
}));

router.get("/candidates/:id/eligibility", verifyToken, asyncHandler(async (req, res) => {
  res.json(await consent.eligibilityFor({ user: req.user, candidateId: req.params.id }));
}));

router.use(jobsearchErrorHandler);

module.exports = router;
