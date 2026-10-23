// Staff CRM API (mounted at /crm). Router-level: valid session, never a Candidate; then per-route permission.
//   GET   /leads          ?status&kind&q&assignedTo&limit&offset   leads:read   -> {rows,total}
//   GET   /leads/:id                                               leads:read   (Agent: only own, else 404)
//   PATCH /leads/:id      {status?, assigned_to?}                  leads:write; assigned_to needs users:write
//   POST  /leads/:id/notes {text}                                  leads:write
//   POST  /leads/:id/convert {passport_number, full_name?, nationality?, createPortalLogin}  leads:write + candidates:write (201, or 200 when already converted)
//   PATCH /candidates/:id/stage {stage}                            candidates:write (+ CRM staff), scope via assertCandidateAccess
//   GET   /site-jobs      ?status&limit&offset                     sitejobs:write -> {rows,total}
//   GET   /site-jobs/:id                                           sitejobs:write (with timeline)
//   POST  /site-jobs      {title,...}                              sitejobs:write (201, draft)
//   PATCH /site-jobs/:id  {fields}                                 sitejobs:write (409 when closed)
//   POST  /site-jobs/:id/publish                                   sitejobs:write (draft only; needs evidence_note, title, country, description, future closes_at)
//   POST  /site-jobs/:id/close                                     sitejobs:write (published only; final)
//   GET   /candidates/:id/timeline                                 candidates:read (+ CRM staff), same scope
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const leads = require("../modules/crm/leadsAdmin");
const convert = require("../modules/crm/convert");
const siteJobs = require("../modules/crm/siteJobsAdmin");

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

// Write permissions are enforced inside the service after the scope check (foreign Agent leads: 404, not 403).
router.post(
  "/leads/:id/convert",
  checkPermission("leads:read"),
  asyncHandler(async (req, res) => {
    const out = await convert.convertLead(req.user, req.params.id, body(req));
    return res.status(out.created ? 201 : 200).json(out);
  })
);

// Candidate routes: leads:read marks CRM staff (Accountant/HR hold candidates:read but are not CRM users).
router.patch(
  "/candidates/:id/stage",
  checkPermission("leads:read"),
  checkPermission("candidates:write"),
  asyncHandler(async (req, res) => res.json(await convert.setStage(req.user, req.params.id, body(req).stage)))
);

router.get(
  "/candidates/:id/timeline",
  checkPermission("leads:read"),
  checkPermission("candidates:read"),
  asyncHandler(async (req, res) => res.json(await convert.getCandidateTimeline(req.user, req.params.id)))
);

const SJ = checkPermission("sitejobs:write");
router.get("/site-jobs", SJ, asyncHandler(async (req, res) => res.json(await siteJobs.listSiteJobs(req.user, req.query))));
router.get("/site-jobs/:id", SJ, asyncHandler(async (req, res) => res.json(await siteJobs.getSiteJob(req.user, req.params.id))));
router.post("/site-jobs", SJ, asyncHandler(async (req, res) => res.status(201).json(await siteJobs.createSiteJob(req.user, body(req)))));
router.patch("/site-jobs/:id", SJ, asyncHandler(async (req, res) => res.json(await siteJobs.updateSiteJob(req.user, req.params.id, body(req)))));
router.post("/site-jobs/:id/publish", SJ, asyncHandler(async (req, res) => res.json(await siteJobs.publishSiteJob(req.user, req.params.id))));
router.post("/site-jobs/:id/close", SJ, asyncHandler(async (req, res) => res.json(await siteJobs.closeSiteJob(req.user, req.params.id))));

router.use(jobsearchErrorHandler);

module.exports = router;
