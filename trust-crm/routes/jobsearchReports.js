// Dashboard, reports, health, exports and realtime events (Task 14), mounted at /jobsearch after the
// other /jobsearch routers:
//   GET /dashboard?candidateId=                    Candidate own / staff assigned / admin all; 404 outside scope
//   GET /reports?from&to&groupBy&period&filters    staff/admin (Candidate, Accountant, HR 403); 400 on bad params
//   GET /health                                    Admin/SuperAdmin/Manager (others 403); no secrets
//   GET /export.csv?type=&filters                  scope-filtered CSV, per-role columns, audited, 10/hour/user
//   GET /events                                    SSE; Authorization: Bearer header only; Last-Event-ID replay
//   GET /reports/export?format=pdf|xlsx&period&from&to&groupBy        company numbers as PDF / Excel (staff, same scope as /reports); snapshot kind 'custom'
//   GET /candidates/:id/activity-report?format&from&to&lang           Canada Job Search Activity Report (staff in scope, or the candidate's own record)
//   GET /me/activity-report?format&from&to&lang                       the same for the signed-in candidate (own record only)
//   GET /reports/snapshots?kind&candidateId&limit                     immutable snapshots the caller may see (staff)
//   GET /reports/snapshots/:id/download?format=pdf|xlsx               a stored snapshot file (staff, visibility re-checked)
//   GET /reports/settings, PUT /reports/settings                      report_timezone / report_schedule_enabled (read: staff; write: Admin / SuperAdmin)
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const { HttpError } = require("../modules/jobsearch/httpError");
const reports = require("../modules/jobsearch/reportService");
const exportsSvc = require("../modules/jobsearch/exportService");
const eventsHub = require("../modules/jobsearch/eventsHub");
const reportExport = require("../modules/jobsearch/reportExport");

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

// ---------------------------------------------------------------- PDF / Excel exports and snapshots

function sendReport(res, out, format) {
  const fmt = reportExport.FORMATS.includes(format) ? format : "pdf";
  res.set({
    "Content-Type": reportExport.MIME[fmt],
    // the name is built from validated parts only (candidate reference pattern, ISO dates), never from a request value
    "Content-Disposition": `attachment; filename="${out.filename(fmt)}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Report-Snapshot": String(out.id),
  });
  if (out.model && out.model.flags && out.model.flags.length) res.set("X-Report-Flags", out.model.flags.join(","));
  return res.send(fmt === "pdf" ? out.pdf : out.xlsx);
}

function formatOf(q) {
  const f = q.format === undefined || q.format === "" ? "pdf" : q.format;
  if (!reportExport.FORMATS.includes(f)) throw new HttpError(400, `format must be one of ${reportExport.FORMATS.join(", ")}`);
  return f;
}

function withRetryAfter(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError && err.status === 429 && err.retryAfter) res.set("Retry-After", String(err.retryAfter));
      throw err;
    }
  };
}

router.get("/reports/export", verifyToken, asyncHandler(withRetryAfter(async (req, res) => {
  const q = plainQuery(req);
  const format = formatOf(q);
  sendReport(res, await reportExport.exportCompanyReport(req.user, q), format);
})));

router.get("/candidates/:id/activity-report", verifyToken, asyncHandler(withRetryAfter(async (req, res) => {
  const q = plainQuery(req);
  const format = formatOf(q);
  sendReport(res, await reportExport.exportCandidateActivity(req.user, req.params.id, q), format);
})));

router.get("/me/activity-report", verifyToken, asyncHandler(withRetryAfter(async (req, res) => {
  if (req.user.role !== "Candidate") throw new HttpError(403, "Access denied");
  const q = plainQuery(req);
  const format = formatOf(q);
  sendReport(res, await reportExport.exportCandidateActivity(req.user, undefined, q), format);
})));

router.get("/reports/snapshots", verifyToken, asyncHandler(async (req, res) => {
  noStore(res).json(await reportExport.listSnapshots(req.user, plainQuery(req)));
}));

router.get("/reports/snapshots/:id/download", verifyToken, asyncHandler(async (req, res) => {
  const q = plainQuery(req);
  const out = await reportExport.openSnapshot(req.user, req.params.id, q.format);
  res.set({
    "Content-Type": out.mime,
    "Content-Disposition": `attachment; filename="${out.filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Report-Snapshot": String(out.snapshotId),
  });
  if (out.flags.length) res.set("X-Report-Flags", out.flags.join(","));
  res.send(out.buf);
}));

router.get("/reports/settings", verifyToken, asyncHandler(async (req, res) => {
  if (req.user.role === "Candidate" || !reports.hasPerm(req.user, "jobsearch:read")) throw new HttpError(403, "Access denied");
  noStore(res).json(await reportExport.getSettings());
}));

router.put("/reports/settings", verifyToken, asyncHandler(async (req, res) => {
  noStore(res).json(await reportExport.updateSettings(req.user, req.body));
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
