// HR API (stage 5), mounted at /hr with its own 32 kb JSON parser. Router level: an authenticated, ACTIVE staff account
// (requireStaff: Candidate / Employer / Agency are refused everywhere, a deactivated account is 401); then per-route permission.
//   GET   /me                         any active staff -> own profile subset (profile:null without an HR row), schedule, balances of the year
//   GET   /staff ?without_profile        hr:read -> {rows:[{user_id,full_name,role,has_profile}]} active staff for the console pickers
//   GET   /me/leave-types                 any active staff -> {rows} the ACTIVE leave types (for the request dialog)
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
//   GET   /attendance/open ?limit&offset   hr:read -> open sessions older than HR_MAX_OPEN_HOURS with user names (stale sessions to close)
//   POST  /attendance/:id/close {clock_out ISO+offset, note?<=500}   hr:write: closes an OPEN record (clock_out > clock_in, <= 24 h later, not future); 409 when closed
//   GET   /reports/attendance ?from&to&user_id, GET /export/attendance.csv ?from&to&user_id   hr:read
// Leave (any active staff unless noted):
//   POST  /me/leave-requests {leave_type_id,start_date,end_date,half_day_start?,half_day_end?,reason?<=500}   201 (status pending, or approved when the type needs no approval)
//         days are computed server-side (schedule + holidays); 400 no working days / bad flags; 409 overlap / insufficient balance
//   GET   /me/leave-requests ?status&year   own requests (with reason and decision note)
//   POST  /me/leave-requests/:id/cancel     own pending, or own approved that has not started (409 otherwise)
//   GET   /team/leave-requests ?status&year  hr:approve (Manager: direct reports only; HR/Admin/SuperAdmin: everyone); includes reasons (approver scope)
//   POST  /leave-requests/:id/decide {decision:approved|rejected,note?}   hr:approve (404 outside scope, 403 own request, 409 decided / balance)
//   GET   /team/calendar ?from&to           any active staff, range <= 93 days; own leave only (Manager: + direct reports; HR/Admin: everyone); names, leave type name and dates only, NEVER reasons / notes
//   GET   /reports/leave ?year              hr:read, per employee and leave type: entitled, adjusted, approved, pending, remaining
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
const leaveRequests = require("../modules/hr/leaveRequests");
const leaveCalendar = require("../modules/hr/leaveCalendar");
const { HttpError } = require("../modules/jobsearch/httpError");

const router = express.Router();
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : req.body === undefined ? {} : null);

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(requireStaff);
// First HR request loads the pg_timezone_names list used to validate HR_TIMEZONE (cached for the process).
router.use(asyncHandler(async (_req, _res, next) => {
  await require("../modules/hr/common").ensureTimezones(require("../db"));
  next();
}));

router.get("/me", asyncHandler(async (req, res) => res.json(await employees.me(req.user))));

router.get("/staff", checkPermission("hr:read"), asyncHandler(async (req, res) => res.json(await employees.listStaff(req.user, req.query))));
router.get("/me/leave-types", asyncHandler(async (req, res) => res.json(await leaveTypes.listActiveForStaff(req.user))));
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

router.get("/attendance/open", checkPermission("hr:read"), asyncHandler(async (req, res) => res.json(await attendance.listStaleOpen(req.user, req.query, clock(req)))));
router.post("/attendance/:id/close", checkPermission("hr:write"), asyncHandler(async (req, res) => res.json(await attendance.closeOpen(req.user, req.params.id, body(req), clock(req)))));
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

router.post("/me/leave-requests", asyncHandler(async (req, res) => res.status(201).json(await leaveRequests.createRequest(req.user, body(req), clock(req)))));
router.get("/me/leave-requests", asyncHandler(async (req, res) => res.json(await leaveRequests.myRequests(req.user, req.query))));
router.post("/me/leave-requests/:id/cancel", asyncHandler(async (req, res) => res.json(await leaveRequests.cancelRequest(req.user, req.params.id, clock(req)))));
router.get("/team/leave-requests", checkPermission("hr:approve"), asyncHandler(async (req, res) => res.json(await leaveRequests.teamRequests(req.user, req.query))));
router.post("/leave-requests/:id/decide", checkPermission("hr:approve"), asyncHandler(async (req, res) => res.json(await leaveRequests.decide(req.user, req.params.id, body(req)))));
router.get("/team/calendar", asyncHandler(async (req, res) => res.json(await leaveCalendar.teamCalendar(req.user, req.query))));
router.get("/reports/leave", checkPermission("hr:read"), asyncHandler(async (req, res) => res.json(await leaveCalendar.leaveReport(req.user, req.query))));

// Errors that carry extra fields (e.g. since, needs_correction) keep them in the JSON body.
router.use((err, _req, res, next) => (err instanceof HttpError && err.extra ? res.status(err.status).json({ error: err.message, ...err.extra }) : next(err)));
router.use(jobsearchErrorHandler);

module.exports = router;
