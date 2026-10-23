// Dashboard, reports, health, exports and realtime events (Task 14), mounted at /jobsearch after the
// other /jobsearch routers:
//   GET /dashboard?candidateId=                    Candidate own / staff assigned / admin all; 404 outside scope
//   GET /reports?from&to&groupBy&period&filters    staff/admin (Candidate, Accountant, HR 403); 400 on bad params
//   GET /health                                    Admin/SuperAdmin/Manager (others 403); no secrets
//   GET /export.csv?type=&filters                  scope-filtered CSV, per-role columns, audited, 10/hour/user
//   GET /events                                    SSE; Authorization: Bearer header only; Last-Event-ID replay
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const { HttpError } = require("../modules/jobsearch/httpError");
const reports = require("../modules/jobsearch/reportService");
const exportsSvc = require("../modules/jobsearch/exportService");
const eventsHub = require("../modules/jobsearch/eventsHub");

const router = express.Router();

// Query values must be single strings: ?a=1&a=2 or ?a[b]=1 -> 400 instead of a 500 deeper down.
function plainQuery(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.query || {})) {
    if (typeof v !== "string") throw new HttpError(400, `${k} must be a single value`);
    if (v.length > 200) throw new HttpError(400, `${k} is too long`);
    out[k] = v;
  }
  return out;
}

const noStore = (res) => res.set({ "Cache-Control": "no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" });

router.get("/dashboard", verifyToken, asyncHandler(async (req, res) => {
  noStore(res).json(await reports.dashboard({ user: req.user, query: plainQuery(req) }));
}));

router.get("/reports", verifyToken, asyncHandler(async (req, res) => {
  noStore(res).json(await reports.report({ user: req.user, query: plainQuery(req) }));
}));

router.get("/health", verifyToken, asyncHandler(async (req, res) => {
  noStore(res).json(await reports.health({ user: req.user }));
}));

router.get("/export.csv", verifyToken, asyncHandler(async (req, res) => {
  let out;
  try {
    out = await exportsSvc.exportCsv({ user: req.user, query: plainQuery(req) });
  } catch (err) {
    if (err instanceof HttpError && err.status === 429 && err.retryAfter) res.set("Retry-After", String(err.retryAfter));
    throw err;
  }
  noStore(res).set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${out.filename}"`,
    "X-Export-Rows": String(out.rows),
    "X-Export-Truncated": out.truncated ? "true" : "false",
  });
  res.send(out.body);
}));

router.get("/events", verifyToken, asyncHandler(async (req, res) => {
  const user = req.user;
  if (user.role !== "Candidate" && !reports.hasPerm(user, "jobsearch:read")) throw new HttpError(403, "Access denied");
  const raw = req.get("Last-Event-ID");
  let lastEventId = null;
  if (raw !== undefined && raw !== "") {
    if (!/^\d{1,18}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new HttpError(400, "Last-Event-ID must be a numeric event id");
    lastEventId = Number(raw);
  }
  try {
    await eventsHub.subscribe({ user, req, res, lastEventId });
  } catch (err) {
    if (err instanceof eventsHub.LimitError && !res.headersSent) throw new HttpError(err.status, err.message);
    throw err;
  }
}));

router.use(jobsearchErrorHandler);

module.exports = router;
