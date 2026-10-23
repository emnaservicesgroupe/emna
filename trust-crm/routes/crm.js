// Staff CRM API (mounted at /crm). Router-level: valid session, never a Candidate; then per-route permission.
//   GET   /leads          ?status&kind&q&assignedTo&limit&offset   leads:read   -> {rows,total}
//   GET   /leads/:id                                               leads:read   (Agent: only own, else 404)
//   PATCH /leads/:id      {status?, assigned_to?}                  leads:write; assigned_to needs users:write
//   POST  /leads/:id/notes {text}                                  leads:write
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const leads = require("../modules/crm/leadsAdmin");

const router = express.Router();
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(verifyToken);
router.use((req, res, next) => {
  if (req.user && req.user.role === "Candidate") return res.status(403).json({ error: "Access denied" });
  return next();
});

router.get("/leads", checkPermission("leads:read"), asyncHandler(async (req, res) => res.json(await leads.listLeads(req.user, req.query))));

router.get("/leads/:id", checkPermission("leads:read"), asyncHandler(async (req, res) => res.json(await leads.getLead(req.user, req.params.id))));

// Write permission is enforced inside the service after the scope check so an Agent probing a foreign lead gets 404, not 403.
router.patch("/leads/:id", checkPermission("leads:read"), asyncHandler(async (req, res) => res.json(await leads.updateLead(req.user, req.params.id, body(req)))));

router.post(
  "/leads/:id/notes",
  checkPermission("leads:read"),
  asyncHandler(async (req, res) => res.status(201).json(await leads.addNote(req.user, req.params.id, body(req).text)))
);

router.use(jobsearchErrorHandler);

module.exports = router;
