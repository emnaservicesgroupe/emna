// Applications (mounted at /jobsearch):
//   GET    /applications                       filters: candidateId,country,profession,staffId,employerId,sourceKey,status,from,to; page,pageSize
//   GET    /applications/:id                   404 outside scope; timeline, documents (metadata only), job, employer, match label + notice
//   POST   /applications                       {matchId}  201 created / 200 existing (idempotent)
//   POST   /applications/:id/prepare           {documents?: [{cvFileId}|{documentId}], lang?}
//   POST   /applications/:id/approve           jobsearch:approve (Manager/Admin/SuperAdmin) in scope
//   POST   /applications/:id/reject            {reason} jobsearch:approve
//   POST   /applications/:id/cancel            {reason} candidate (own) or staff in scope
//   POST   /applications/:id/sharing-authorizations          {documentId, legitimateNeed}  CANDIDATE only
//   DELETE /applications/:id/sharing-authorizations/:authId  CANDIDATE only
//   POST   /cv-files/:id/approve               {language, note?} candidate (own) or jobsearch:approve in scope (staff: note >= 10 chars required)
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const svc = require("../modules/jobsearch/applicationService");

const router = express.Router();
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

router.get("/applications", verifyToken, asyncHandler(async (req, res) => {
  res.json(await svc.listApplications({ user: req.user, query: req.query }));
}));

router.get("/applications/:id", verifyToken, asyncHandler(async (req, res) => {
  res.json(await svc.getApplication({ user: req.user, id: req.params.id }));
}));

router.post("/applications", verifyToken, asyncHandler(async (req, res) => {
  const { created, ...application } = await svc.createFromMatch({ matchId: body(req).matchId, actor: req.user });
  res.status(created ? 201 : 200).json({ application, created });
}));

router.post("/applications/:id/prepare", verifyToken, asyncHandler(async (req, res) => {
  const b = body(req);
  res.json(await svc.prepareApplication({ id: req.params.id, actor: req.user, documents: b.documents, lang: b.lang }));
}));

router.post("/applications/:id/approve", verifyToken, asyncHandler(async (req, res) => {
  res.json(await svc.approveApplication({ id: req.params.id, actor: req.user, reason: body(req).reason }));
}));

router.post("/applications/:id/reject", verifyToken, asyncHandler(async (req, res) => {
  res.json(await svc.rejectApplication({ id: req.params.id, actor: req.user, reason: body(req).reason }));
}));

router.post("/applications/:id/cancel", verifyToken, asyncHandler(async (req, res) => {
  res.json(await svc.cancelApplication({ id: req.params.id, actor: req.user, reason: body(req).reason }));
}));

router.post("/applications/:id/sharing-authorizations", verifyToken, asyncHandler(async (req, res) => {
  const b = body(req);
  res.status(201).json(await svc.grantSharing({ id: req.params.id, actor: req.user, documentId: b.documentId, legitimateNeed: b.legitimateNeed }));
}));

router.delete("/applications/:id/sharing-authorizations/:authId", verifyToken, asyncHandler(async (req, res) => {
  res.json(await svc.revokeSharing({ id: req.params.id, actor: req.user, authorizationId: req.params.authId }));
}));

router.post("/cv-files/:id/approve", verifyToken, asyncHandler(async (req, res) => {
  res.json(await svc.approveCvVersion({ user: req.user, cvFileId: req.params.id, language: body(req).language, note: body(req).note }));
}));

router.use(jobsearchErrorHandler);

module.exports = router;
