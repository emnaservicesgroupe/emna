// HR API (stage 5), mounted at /hr with its own 32 kb JSON parser. Router level: an authenticated, ACTIVE staff account
// (requireStaff: Candidate / Employer / Agency are refused everywhere, a deactivated account is 401); then per-route permission.
//   GET   /me                         any active staff -> own profile subset (profile:null without an HR row), schedule, balances of the year
//   GET   /employees ?status&department&q&limit&offset   hr:read -> {rows,total}
//   POST  /employees {user_id,...}    hr:write (201; 409 profile exists / employee_no taken)
//   GET   /employees/:user_id         hr:read (HR-only notes included only for hr:read callers; has_profile:false without a row)
//   PATCH /employees/:user_id         hr:write
//   GET   /schedules, POST /schedules, PATCH /schedules/:id           hr:read / hr:write
//   GET   /leave-types ?active&q, POST /leave-types, PATCH /leave-types/:id   hr:read / hr:write (deactivate, never delete)
//   GET   /holidays ?year, POST /holidays {day,name}, DELETE /holidays/:id   hr:read / hr:write (409 duplicate day)
//   GET   /balances ?user_id&year&limit&offset   hr:read;   PUT /balances {user_id,leave_type_id,year,entitled_days,adjusted_days?}   hr:write (upsert)
// Attendance (any active staff unless noted):
//   POST  /clock-in, /clock-out       201 new record | 200 {replayed:true} (same click twice within 60 s) | 409 (already clocked in {since} / not clocked in /
//                                     open session older than HR_MAX_OPEN_HOURS: "session too old; request a correction")
//   GET   /me/attendance ?from&to     own records + per-day totals (range <= 366 days)
//   POST  /me/corrections {work_date,requested_in,requested_out?,reason}   201; GET /me/corrections ?status; POST /me/corrections/:id/cancel
//   GET   /team/corrections ?status   hr:approve (Manager: direct reports only; HR/Admin/SuperAdmin: everyone)
//   POST  /corrections/:id/decide {decision:approved|rejected,note?}   hr:approve (404 outside scope, 403 own request, 409 decided / overlap)
//   GET   /reports/attendance ?from&to&user_id, GET /export/attendance.csv ?from&to&user_id   hr:read
// The clock can be injected through the X-Test-Now header ONLY while NODE_ENV is "test" (never in any other environment).
const express = require("express");
const { requireStaff } = require("../middleware/staff");
const { checkPermission } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const employees = require("../modules/hr/employees");
const schedules = require("../modules/hr/schedules");
const leaveTypes = require("../modules/hr/leaveTypes");
const holidays = require("../modules/hr/holidays");
const balances = require("../modules/hr/balances");
const attendance = require("../modules/hr/attendance");
const corrections = require("../modules/hr/corrections");
const attendanceReports = require("../modules/hr/attendanceReports");
const { HttpError } = require("../modules/jobsearch/httpError");

const router = express.Router();
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : req.body === undefined ? {} : null);

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(requireStaff);

router.get("/me", asyncHandler(async (req, res) => res.json(await employees.me(req.user))));

router.get("/employees", checkPermission("hr:read"), asyncHandler(async (req, res) => res.json(await employees.listEmployees(req.user, req.query))));
router.post("/employees", checkPermission("hr:write"), asyncHandler(async (req, res) => res.status(201).json(await employees.createEmployee(req.user, body(req)))));
router.get("/employees/:user_id", checkPermission("hr:read"), asyncHandler(async (req, res) => res.json(await employees.getEmployee(req.user, req.params.user_id))));
router.patch("/employees/:user_id", checkPermission("hr:write"), asyncHandler(async (req, res) => res.json(await employees.updateEmployee(req.user, req.params.user_id, body(req)))));

router.get("/schedules", checkPermission("hr:read"), asyncHandler(async (req, res) => res.json(await schedules.listSchedules(req.user, req.query))));
router.post("/schedules", checkPermission("hr:write"), asyncHandler(async (req, res) => res.status(201).json(await schedules.createSchedule(req.user, body(req)))));
router.patch("/schedules/:id", checkPermission("hr:write"), asyncHandler(async (req, res) => res.json(await schedules.updateSchedule(req.user, req.params.id, body(req)))));

router.get("/leave-types", checkPermission("hr:read"), asyncHandler(async (req, res) => res.json(await leaveTypes.listLeaveTypes(req.user, req.query))));
router.post("/leave-types", checkPermission("hr:write"), asyncHandler(async (req, res) => res.status(201).json(await leaveTypes.createLeaveType(req.user, body(req)))));
router.patch("/leave-types/:id", checkPermission("hr:write"), asyncHandler(async (req, res) => res.json(await leaveTypes.updateLeaveType(req.user, req.params.id, body(req)))));

router.get("/holidays", checkPermission("hr:read"), asyncHandler(async (req, res) => res.json(await holidays.listHolidays(req.user, req.query))));
router.post("/holidays", checkPermission("hr:write"), asyncHandler(async (req, res) => res.status(201).json(await holidays.createHoliday(req.user, body(req)))));
router.delete("/holidays/:id", checkPermission("hr:write"), asyncHandler(async (req, res) => res.json(await holidays.deleteHoliday(req.user, req.params.id))));

router.get("/balances", checkPermission("hr:read"), asyncHandler(async (req, res) => res.json(await balances.listBalances(req.user, req.query))));
router.put("/balances", checkPermission("hr:write"), asyncHandler(async (req, res) => res.json(await balances.setBalance(req.user, body(req)))));

// Self-service attendance. Services re-check the staff role; clock events are server-timestamped (no client time is ever trusted).
const clock = (req) => (process.env.NODE_ENV === "test" && req.get("x-test-now") ? { now: req.get("x-test-now") } : {});

router.post("/clock-in", asyncHandler(async (req, res) => {
  const out = await attendance.clockIn(req.user, clock(req));
  res.status(out.replayed ? 200 : 201).json(out);
}));
router.post("/clock-out", asyncHandler(async (req, res) => res.json(await attendance.clockOut(req.user, clock(req)))));
router.get("/me/attendance", asyncHandler(async (req, res) => res.json(await attendance.myAttendance(req.user, req.query, clock(req)))));
router.post("/me/corrections", asyncHandler(async (req, res) => res.status(201).json(await corrections.requestCorrection(req.user, body(req), clock(req)))));
router.get("/me/corrections", asyncHandler(async (req, res) => res.json(await corrections.myCorrections(req.user, req.query))));
router.post("/me/corrections/:id/cancel", asyncHandler(async (req, res) => res.json(await corrections.cancelCorrection(req.user, req.params.id))));

router.get("/team/corrections", checkPermission("hr:approve"), asyncHandler(async (req, res) => res.json(await corrections.teamCorrections(req.user, req.query))));
router.post("/corrections/:id/decide", checkPermission("hr:approve"), asyncHandler(async (req, res) => res.json(await corrections.decide(req.user, req.params.id, body(req)))));

router.get("/reports/attendance", checkPermission("hr:read"), asyncHandler(async (req, res) => res.json(await attendanceReports.attendanceReport(req.user, req.query, clock(req)))));
router.get(
  "/export/attendance.csv",
  checkPermission("hr:read"),
  asyncHandler(async (req, res) => {
    const out = await attendanceReports.exportAttendanceCsv(req.user, req.query, clock(req));
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${out.filename}"`, "X-Content-Type-Options": "nosniff" });
    if (out.truncated) res.set("X-Row-Limit-Hit", "true");
    res.send(Buffer.from(out.csv, "utf8"));
  })
);

// Errors that carry extra fields (e.g. since, needs_correction) keep them in the JSON body.
router.use((err, _req, res, next) => (err instanceof HttpError && err.extra ? res.status(err.status).json({ error: err.message, ...err.extra }) : next(err)));
router.use(jobsearchErrorHandler);

module.exports = router;
