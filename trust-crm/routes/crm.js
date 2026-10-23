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
//   GET|POST /employers, /agencies  ?q&status&limit&offset; GET|PATCH /:id    orgs:read (GET) / orgs:write (POST, PATCH)
//   POST  /employers|agencies/:id/invite {email, full_name}        orgs:write (201; inviteSent reports the OTP mail)
//   POST  /employers|agencies/:id/suspend|reactivate               orgs:write (revokes portal sessions)
//   GET|POST /candidates/:id/share-consents {employer_id, basis}  GET: candidates:read; POST: candidates:write (+ candidate scope; 409 duplicate active)
//   DELETE /candidates/:id/share-consents/:consentId               candidates:write (withdraws; hides presentations from the employer at once)
//   GET   /employer-requests ?status&employer_id&q&limit&offset; GET /:id   orgs:read (GET /:id includes staff_note, presentations, timeline)
//   PATCH /employer-requests/:id {status?, staff_note?, employer_visible_note?}   orgs:write (validated status transitions)
//   POST  /employer-requests/:id/create-site-job                   orgs:write + sitejobs:write (DRAFT only, never published)
//   POST  /employer-requests/:id/presentations {candidate_id, staff_note_for_employer?, summary?}   orgs:write + candidates:read + candidate scope + ACTIVE share consent
//   GET   /employer-requests/:id/presentation-preview ?candidate_id&staff_note_for_employer&profession&years_experience&languages&country_of_residence&availability
//         orgs:write + candidates:read + candidate scope; read-only: the exact summary POST would freeze + {consent_active, presentable, needs_summary, already_presented}
//   GET   /presentations ?status&request_id&employer_id            orgs:read (candidate scope); PATCH /presentations/:id/withdraw  orgs:write
//   GET   /staff                                                   users:write  -> {rows:[{id,full_name,role}]} (assign-to select)
//   GET   /candidates/:id/timeline                                 candidates:read (+ CRM staff), same scope
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const leads = require("../modules/crm/leadsAdmin");
const convert = require("../modules/crm/convert");
const siteJobs = require("../modules/crm/siteJobsAdmin");
const orgs = require("../modules/orgs/orgsAdmin");
const shareConsents = require("../modules/orgs/shareConsents");
const presentations = require("../modules/orgs/presentations");

const router = express.Router();
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(verifyToken);
router.use((req, res, next) => {
  if (req.user && (req.user.role === "Candidate" || req.user.role === "Employer" || req.user.role === "Agency")) return res.status(403).json({ error: "Access denied" });
  return next();
});

router.get("/leads", checkPermission("leads:read"), asyncHandler(async (req, res) => res.json(await leads.listLeads(req.user, req.query))));

router.get("/staff", checkPermission("users:write"), asyncHandler(async (_req, res) => res.json(await leads.listStaff())));

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

for (const type of ["employer", "agency"]) {
  const base = `/${type === "employer" ? "employers" : "agencies"}`;
  const R = checkPermission("orgs:read");
  const W = checkPermission("orgs:write");
  router.get(base, R, asyncHandler(async (req, res) => res.json(await orgs.list(type, req.query))));
  router.get(`${base}/:id`, R, asyncHandler(async (req, res) => res.json(await orgs.get(type, req.params.id))));
  router.post(base, W, asyncHandler(async (req, res) => res.status(201).json(await orgs.create(req.user, type, body(req)))));
  router.patch(`${base}/:id`, W, asyncHandler(async (req, res) => res.json(await orgs.update(req.user, type, req.params.id, body(req)))));
  router.post(`${base}/:id/invite`, W, asyncHandler(async (req, res) => res.status(201).json(await orgs.invite(req.user, type, req.params.id, body(req)))));
  router.post(`${base}/:id/suspend`, W, asyncHandler(async (req, res) => res.json(await orgs.suspend(req.user, type, req.params.id))));
  router.post(`${base}/:id/reactivate`, W, asyncHandler(async (req, res) => res.json(await orgs.reactivate(req.user, type, req.params.id))));
}

const CR = checkPermission("candidates:read");
const CW = checkPermission("candidates:write");
router.get("/candidates/:id/share-consents", CR, asyncHandler(async (req, res) => res.json(await shareConsents.list(req.user, req.params.id))));
router.post("/candidates/:id/share-consents", CW, asyncHandler(async (req, res) => res.status(201).json(await shareConsents.record(req.user, req.params.id, body(req)))));
router.delete("/candidates/:id/share-consents/:consentId", CW, asyncHandler(async (req, res) => res.json(await shareConsents.withdraw(req.user, req.params.id, req.params.consentId))));

const OR = checkPermission("orgs:read");
const OW = checkPermission("orgs:write");
router.get("/employer-requests", OR, asyncHandler(async (req, res) => res.json(await presentations.listRequests(req.query))));
router.get("/employer-requests/:id", OR, asyncHandler(async (req, res) => res.json(await presentations.getRequest(req.user, req.params.id))));
router.patch("/employer-requests/:id", OW, asyncHandler(async (req, res) => res.json(await presentations.patchRequest(req.user, req.params.id, body(req)))));
router.post("/employer-requests/:id/create-site-job", OW, asyncHandler(async (req, res) => res.status(201).json(await presentations.createSiteJobFromRequest(req.user, req.params.id))));
router.post("/employer-requests/:id/presentations", OW, CR, asyncHandler(async (req, res) => res.status(201).json(await presentations.present(req.user, req.params.id, body(req)))));
router.get("/employer-requests/:id/presentation-preview", OW, CR, asyncHandler(async (req, res) => res.json(await presentations.previewPresentation(req.user, req.params.id, req.query))));
router.get("/presentations", OR, asyncHandler(async (req, res) => res.json(await presentations.listPresentations(req.user, req.query))));
router.patch("/presentations/:id/withdraw", OW, asyncHandler(async (req, res) => res.json(await presentations.withdrawPresentation(req.user, req.params.id))));

router.use(jobsearchErrorHandler);

module.exports = router;
