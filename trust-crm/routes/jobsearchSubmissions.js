// Submissions (mounted at /jobsearch):
//   POST /applications/:id/queue              human, jobsearch:approve + scope. 200 {queued:true,...}; 409 {error, code, handoff?} on guard refusal
//   POST /applications/:id/manual-completion  {note, channel?, recipient?, fileRef?} jobsearch:approve + scope; needs_staff -> sent
//   POST /submissions/:id/evidence            {kind: manual_confirmation|employer_acknowledgement, detail} jobsearch:approve + scope; delivery_receipt -> 400 (system-only)
//   GET  /submissions?applicationId=          scope; Candidate sees status + timestamps only
//   POST /queue/run                           {kinds?, max?} jobsearch:admin; processes due submit/search items now (cap 50)
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { PERMISSIONS } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const { HttpError } = require("../modules/jobsearch/httpError");
const applicationService = require("../modules/jobsearch/applicationService");
const submitter = require("../modules/jobsearch/submitter");
const workers = require("../modules/jobsearch/workers");
const { logAudit } = require("../utils/audit");

const router = express.Router();
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
const hasPerm = (user, perm) => {
  const perms = (user && PERMISSIONS[user.role]) || [];
  return perms.includes("*") || perms.includes(perm);
};
const RUN_KINDS = ["submit", "search"];

router.post("/applications/:id/queue", verifyToken, asyncHandler(async (req, res) => {
  const app = await applicationService.loadScoped(req.user, req.params.id); // 404 outside scope
  if (req.user.role === "Candidate" || !hasPerm(req.user, "jobsearch:approve")) throw new HttpError(403, "Queueing a submission requires a manager or administrator");
  const out = await submitter.queueSubmission(app.id, req.user);
  if (!out.queued) return res.status(409).json({ error: out.detail || out.reason, code: out.reason, ...(out.handoff ? { handoff: out.handoff } : {}) });
  return res.json(out);
}));

router.post("/applications/:id/manual-completion", verifyToken, asyncHandler(async (req, res) => {
  res.json(await submitter.recordManualCompletion({ applicationId: req.params.id, actor: req.user, detail: body(req) }));
}));

router.post("/submissions/:id/evidence", verifyToken, asyncHandler(async (req, res) => {
  const b = body(req);
  // delivery_receipt is system-only (provider DSN ingested by Task 13); a staff click proves nothing.
  if (b.kind === "delivery_receipt") throw new HttpError(400, "use manual_confirmation or wait for the provider receipt");
  res.json(await submitter.recordEvidence({ submissionId: req.params.id, kind: b.kind, detail: b.detail, actor: req.user }));
}));

router.get("/submissions", verifyToken, asyncHandler(async (req, res) => {
  res.json(await submitter.listSubmissions({ user: req.user, applicationId: req.query.applicationId }));
}));

router.post("/queue/run", verifyToken, asyncHandler(async (req, res) => {
  if (!hasPerm(req.user, "jobsearch:admin")) throw new HttpError(403, "Running the queue requires an administrator");
  const b = body(req);
  let kinds = RUN_KINDS;
  if (b.kinds !== undefined) {
    if (!Array.isArray(b.kinds) || !b.kinds.length || !b.kinds.every((k) => RUN_KINDS.includes(k))) throw new HttpError(400, `kinds must be a subset of ${RUN_KINDS.join(", ")}`);
    kinds = [...new Set(b.kinds)];
  }
  const max = b.max === undefined ? 50 : Number(b.max);
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new HttpError(400, "max must be between 1 and 50");
  const out = await workers.tick({ kinds, max });
  await logAudit({ userId: req.user.id, action: "jobsearch.queue.run", tableName: "js_queue", newData: { kinds, max, ...out } });
  res.json(out);
}));

router.use(jobsearchErrorHandler);

module.exports = router;
