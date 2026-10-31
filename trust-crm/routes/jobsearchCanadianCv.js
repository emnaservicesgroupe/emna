// Canadian-format CV (mounted at /jobsearch). Versions are numbered per candidate and language; every route that names a version
// takes ?lang=en|fr (default en).
//   POST /candidates/:id/canadian-cv                          {lang?, formats?: ["pdf","docx"]}  staff (jobsearch:write) in scope; profile must be confirmed
//   GET  /candidates/:id/canadian-cv                          staff in scope: versions, status, missing flags (no storage keys)
//   POST /candidates/:id/canadian-cv/:version/approve         jobsearch:approve (Manager / Admin / SuperAdmin) in scope; approves the PDF + DOCX of the version together
//   POST /cv-files/:fileId/staff-approve                      same approval, addressed by one of the version's files
//   GET  /candidates/:id/canadian-cv/:version/download        ?format=pdf|docx  staff in scope
//   GET  /me/canadian-cv                                      candidate: staff-approved versions only
//   POST /me/canadian-cv/:version/authorise                   candidate, after staff approval: content and distribution
//   POST /me/canadian-cv/:version/withdraw-authorisation      candidate: blocks use at once, cancels queued applications using the version
//   GET  /me/canadian-cv/:version/download                    ?format=pdf|docx  candidate, own, staff-approved versions only
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const svc = require("../modules/jobsearch/canadianCvService");

const router = express.Router();
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
const one = (v) => (Array.isArray(v) ? undefined : v);
const noStore = (res) => res.set("Cache-Control", "private, no-store");

function sendFile(res, out) {
  res.set({
    "Content-Type": out.mime,
    // the name comes from the validated canonical-name pattern only (safeDownloadName), never from a request value
    "Content-Disposition": `attachment; filename="${out.filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Cache-Control": "private, no-store",
  });
  return res.send(out.buf);
}

router.post("/candidates/:id/canadian-cv", verifyToken, asyncHandler(async (req, res) => {
  const b = body(req);
  return noStore(res).status(201).json(await svc.generateCanadianCv(req.user, req.params.id, { lang: b.lang, formats: b.formats }));
}));

router.get("/candidates/:id/canadian-cv", verifyToken, asyncHandler(async (req, res) => {
  return noStore(res).json(await svc.listCanadianCvs(req.user, req.params.id));
}));

router.post("/candidates/:id/canadian-cv/:version/approve", verifyToken, asyncHandler(async (req, res) => {
  return noStore(res).json(await svc.staffApproveVersion(req.user, req.params.id, req.params.version, one(req.query.lang)));
}));

router.post("/cv-files/:fileId/staff-approve", verifyToken, asyncHandler(async (req, res) => {
  return noStore(res).json(await svc.staffApproveByFile(req.user, req.params.fileId));
}));

router.get("/candidates/:id/canadian-cv/:version/download", verifyToken, asyncHandler(async (req, res) => {
  return sendFile(res, await svc.downloadStaff(req.user, req.params.id, { version: req.params.version, lang: one(req.query.lang), format: one(req.query.format) }));
}));

router.get("/me/canadian-cv", verifyToken, asyncHandler(async (req, res) => {
  return noStore(res).json(await svc.listOwnCanadianCvs(req.user));
}));

router.post("/me/canadian-cv/:version/authorise", verifyToken, asyncHandler(async (req, res) => {
  return noStore(res).json(await svc.authoriseOwn(req.user, req.params.version, one(req.query.lang)));
}));

router.post("/me/canadian-cv/:version/withdraw-authorisation", verifyToken, asyncHandler(async (req, res) => {
  return noStore(res).json(await svc.withdrawOwn(req.user, req.params.version, one(req.query.lang)));
}));

router.get("/me/canadian-cv/:version/download", verifyToken, asyncHandler(async (req, res) => {
  return sendFile(res, await svc.downloadOwn(req.user, { version: req.params.version, lang: one(req.query.lang), format: one(req.query.format) }));
}));

router.use(jobsearchErrorHandler);

module.exports = router;
