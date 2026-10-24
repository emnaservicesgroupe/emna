// hr-e2e-README
// End-to-end journey for Attendance and HR (stage 5, Task 6). REAL HTTP server (app.listen(0) + fetch), REAL Postgres schema
// (fresh per file), real logins through /auth/login (HR, Admin, Manager, Agent, Receptionist, Accountant created by the SuperAdmin
// through /auth/register), a Candidate through the REAL e-mail OTP flow, and the shared helper tests/helpers/e2e.js (which also
// fences globalThis.fetch: no network). Time is deterministic: every clock / leave / report call carries X-Test-Now (honoured only
// while NODE_ENV is "test"); the company timezone is Africa/Tunis (UTC+1, no DST), so 09:25 Tunis is written 09:25:00+01:00.
//
//   A  HR sets up: schedule (Mon-Fri 09:00-17:30, 60 min break, grace 10), leave types (ANNUAL counted against the balance,
//      UNPAID not), a public holiday, profiles with the Manager as manager of Agent and Receptionist, balances (entitled 18)
//   B  attendance: late clock-in 09:25 + clock-out, the same click twice (replayed) vs a real double clock-in (409), a stale
//      session (clock-out refused, needs_correction), a correction request approved by the Manager (atomic attendance row)
//   C  leave: Fri..Thu across a weekend and the holiday = exactly 4 days; approval -> balance used; over-balance 409;
//      overlap 409; cancel an approved future leave restores the balance; a started leave cannot be cancelled; unpaid is not
//      counted; self-approval refused (HR's own request is approved by the Admin)
//   D  isolation: the Receptionist cannot see or touch the Agent's corrections / leave; the Manager cannot decide for a
//      non-report (404); the calendar shows leave entries but never the reason / decision note
//   E  reports: the HR attendance report equals an independent SQL computation for a week-and-a-half; CSV export parses back
//      (BOM, quoting, CRLF) and neutralises a formula-looking value (an employee number starting with "=")
//   F  authorization: Accountant / Receptionist / Agent denied on HR admin routes; Candidate (real OTP), Employer and Agency tokens
//      and anonymous callers denied on every /hr route class; a deactivated user's token dies at once
//   G  concurrency: 10 parallel clock-ins leave exactly one record
//   H  the all-routes authorization sweep file still passes (child process)
//
// NOT covered (by design): a real server / domain / HTTPS, a browser (see hr-ui and the browser smoke), real e-mail.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "hr-e2e-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hr-e2e-"));
process.env.STORAGE_URL_SECRET = "hr-e2e-storage-secret";
process.env.MAIL_PROVIDER = "sandbox";
process.env.MAIL_SANDBOX_ALLOWLIST = "*@test.invalid,*@*.test.invalid";
process.env.MAIL_FROM = "applications@vita.test.invalid";
process.env.SITE_IP_SALT = "hr-e2e-salt";
// Deterministic HR settings injected through env (never defaults that depend on the host).
process.env.HR_TIMEZONE = "Africa/Tunis";
process.env.HR_MAX_OPEN_HOURS = "16";
process.env.HR_EXPORT_MAX_ROWS = "50000";
for (const k of ["CLAMAV_HOST", "MAIL_REAL_SEND"]) delete process.env[k];

const E = require("./helpers/e2e");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");

const SENTINEL_REASON = "SENTINEL-REASON-7391-private-family-matter";
const SENTINEL_NOTE = "SENTINEL-NOTE-5527-decision-comment";
const SENTINEL_CORR = "SENTINEL-CORRECTION-4410-forgot-badge";
const ALL_SENTINELS = [SENTINEL_REASON, SENTINEL_NOTE, SENTINEL_CORR];

let w;
const S = {}; // shared state across the ordered tests
const at = (ts) => ({ "x-test-now": ts });
const T = () => w.tokens;
const hr = (method, url, who, body, now) => w.http(method, url, who === null ? null : T()[who] || who, body, now ? at(now) : {});

test.before(async () => {
  w = await E.startWorld();
  for (const [key, role] of [["admin", "Admin"], ["hr", "HR"], ["mgr", "Manager"], ["agent", "Agent"], ["rec", "Receptionist"], ["acc", "Accountant"]]) await E.addStaff(w, key, role);
});
test.after(async () => {
  if (w) await w.close().catch(() => {});
  assert.deepEqual(E.blockedNetwork, [], "no network call left the test process");
});

const dump = (r) => JSON.stringify(r.body);
/** The ANNUAL balance of 2026 for a user, read by HR (independent of the real calendar year /hr/me uses). */
async function annualBalance(key) {
  const r = await hr("GET", `/hr/balances?user_id=${w.users[key]}&year=2026`, "hr");
  assert.equal(r.status, 200, dump(r));
  return r.body.rows.find((b) => b.leave_type_id === S.annual);
}

// ================================================================ A  HR setup (real HR login)
test("A1: HR configures schedule, leave types, holiday, profiles with managers, balances", async () => {
  // nothing statutory is preloaded: a fresh installation has no schedule, leave type, holiday, profile or balance
  for (const t of ["hr_schedules", "hr_leave_types", "hr_holidays", "hr_employees", "hr_leave_balances", "hr_attendance"]) assert.equal(await w.count(`SELECT count(*) AS n FROM ${t}`), 0, `${t} starts empty`);
  const noColumns = await w.q("SELECT table_name, column_name FROM information_schema.columns WHERE table_name LIKE 'hr\\_%' AND column_name ~* '(salary|wage|pay|passport|national|id_number|medical|health|diagnos|latitude|longitude|gps|photo|biometric|fingerprint|performance)'");
  assert.deepEqual(noColumns.rows, [], "no salary / ID / medical / location / biometric / performance column exists in the HR tables");
  const day = { start: "09:00", end: "17:30", break_minutes: 60 };
  const sch = await hr("POST", "/hr/schedules", "hr", { name: "Office hours", weekly: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: null, sun: null }, grace_minutes: 10 });
  assert.equal(sch.status, 201, dump(sch));
  assert.equal(sch.body.grace_minutes, 10);
  assert.equal(sch.body.timezone, "Africa/Tunis");
  S.schedule = sch.body.id;

  const annual = await hr("POST", "/hr/leave-types", "hr", { code: "ANNUAL", name_ar: "إجازة سنوية", name_en: "Annual leave", name_fr: "Congé annuel", paid: true, counts_against_balance: true, requires_approval: true });
  assert.equal(annual.status, 201, dump(annual));
  const unpaid = await hr("POST", "/hr/leave-types", "hr", { code: "UNPAID", name_ar: "إجازة بدون أجر", name_en: "Unpaid leave", name_fr: "Congé sans solde", paid: false, counts_against_balance: false, requires_approval: true });
  assert.equal(unpaid.status, 201, dump(unpaid));
  S.annual = annual.body.id;
  S.unpaid = unpaid.body.id;

  const hol = await hr("POST", "/hr/holidays", "hr", { day: "2026-11-11", name: "Test public holiday" });
  assert.equal(hol.status, 201, dump(hol));
  assert.equal((await hr("POST", "/hr/holidays", "hr", { day: "2026-11-11", name: "again" })).status, 409, "one holiday per day");

  const profiles = [
    ["agent", { employee_no: "=1+1", position: "Recruiter", department: "Sales", manager_user_id: w.users.mgr, schedule_id: S.schedule }],
    ["rec", { employee_no: "R-002", position: "Front desk", department: "Front office", manager_user_id: w.users.mgr, schedule_id: S.schedule }],
    ["acc", { employee_no: "A-003", position: "Accountant", department: "Sales" }],
    ["mgr", { employee_no: "M-004", position: "Manager", department: "Management" }],
    ["hr", { employee_no: "H-005", position: "HR officer", department: "HR" }],
  ];
  for (const [key, p] of profiles) {
    // separation of duties: HR cannot give itself a profile with approval-relevant fields; the Admin sets HR's up
    const r = await hr("POST", "/hr/employees", key === "hr" ? "admin" : "hr", { user_id: w.users[key], status: "active", ...p });
    assert.equal(r.status, 201, `${key}: ${dump(r)}`);
  }
  // a manager cycle is refused
  const cyc = await hr("PATCH", `/hr/employees/${w.users.mgr}`, "hr", { manager_user_id: w.users.agent });
  assert.equal(cyc.status, 400, "Manager -> Agent -> Manager would be a cycle");

  for (const key of ["agent", "rec", "acc", "mgr", "hr"]) {
    const b = await hr("PUT", "/hr/balances", key === "hr" ? "admin" : "hr", { user_id: w.users[key], leave_type_id: S.annual, year: 2026, entitled_days: "18" });
    assert.equal(b.status, 200, `${key}: ${dump(b)}`);
  }
  const me = await hr("GET", "/hr/me", "agent", undefined, "2026-11-02T08:00:00+01:00");
  assert.equal(me.status, 200, dump(me));
  assert.equal(me.body.profile.manager.id, w.users.mgr);
  assert.equal(me.body.profile.notes, undefined, "HR-only notes never in /hr/me");
  // /hr/me shows the balances of the current calendar year (real clock); the journey's year is 2026, read through HR below
  if (me.body.year === 2026) assert.equal(me.body.balances.find((x) => x.leave_type_code === "ANNUAL").entitled_days, "18.00");
  const bal = await annualBalance("agent");
  assert.equal(bal.entitled_days, "18.00");
  assert.equal(bal.remaining_days, "18.00");
});

// ================================================================ B  attendance
test("B1: late clock-in 09:25 Tunis and clock-out are recorded in the company timezone", async () => {
  const inn = await hr("POST", "/hr/clock-in", "agent", {}, "2026-11-02T09:25:00+01:00");
  assert.equal(inn.status, 201, dump(inn));
  assert.equal(inn.body.replayed, false);
  assert.equal(inn.body.record.work_date, "2026-11-02");
  assert.equal(new Date(inn.body.record.clock_in).toISOString(), "2026-11-02T08:25:00.000Z");
  const out = await hr("POST", "/hr/clock-out", "agent", {}, "2026-11-02T17:35:00+01:00");
  assert.equal(out.status, 200, dump(out));
  assert.equal(out.body.record.worked_minutes, 490);
  const mine = await hr("GET", "/hr/me/attendance?from=2026-11-02&to=2026-11-02", "agent", undefined, "2026-11-02T18:00:00+01:00");
  assert.equal(mine.body.records.length, 1);
  assert.equal(mine.body.records[0].clock_in_local, "09:25");
  assert.equal(mine.body.records[0].clock_out_local, "17:35");
  assert.equal(mine.body.worked_minutes, 490);
  // the Receptionist is on time that day
  assert.equal((await hr("POST", "/hr/clock-in", "rec", {}, "2026-11-02T09:00:00+01:00")).status, 201);
  assert.equal((await hr("POST", "/hr/clock-out", "rec", {}, "2026-11-02T17:30:00+01:00")).status, 200);
});

test("B2: the same click twice is replayed; a real double clock-in is refused; clock-out without clock-in is refused", async () => {
  const first = await hr("POST", "/hr/clock-in", "agent", {}, "2026-11-03T08:55:00+01:00");
  assert.equal(first.status, 201, dump(first));
  const twice = await hr("POST", "/hr/clock-in", "agent", {}, "2026-11-03T08:55:30+01:00");
  assert.equal(twice.status, 200);
  assert.equal(twice.body.replayed, true);
  assert.equal(twice.body.record.id, first.body.record.id, "same record, nothing new");
  const dbl = await hr("POST", "/hr/clock-in", "agent", {}, "2026-11-03T09:10:00+01:00");
  assert.equal(dbl.status, 409, dump(dbl));
  assert.match(dbl.body.error, /already clocked in/);
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_attendance WHERE user_id = $1 AND work_date = '2026-11-03'", [w.users.agent]), 1);
  const out = await hr("POST", "/hr/clock-out", "agent", {}, "2026-11-03T17:30:00+01:00");
  assert.equal(out.body.record.worked_minutes, 515);
  const none = await hr("POST", "/hr/clock-out", "agent", {}, "2026-11-03T18:30:00+01:00");
  assert.equal(none.status, 409, "not clocked in");
});

test("B3: a stale open session is never closed silently: clock-out and clock-in are refused with needs_correction", async () => {
  assert.equal((await hr("POST", "/hr/clock-in", "rec", {}, "2026-11-03T09:00:00+01:00")).status, 201);
  const out = await hr("POST", "/hr/clock-out", "rec", {}, "2026-11-04T10:00:00+01:00"); // 25 h later, limit 16 h
  assert.equal(out.status, 409, dump(out));
  assert.equal(out.body.needs_correction, true);
  assert.match(out.body.error, /request a correction/);
  const again = await hr("POST", "/hr/clock-in", "rec", {}, "2026-11-04T10:05:00+01:00");
  assert.equal(again.status, 409);
  assert.equal(again.body.needs_correction, true);
  const row = await w.one("SELECT clock_out FROM hr_attendance WHERE user_id = $1 AND work_date = '2026-11-03'", [w.users.rec]);
  assert.equal(row.clock_out, null, "still open: nothing was capped or closed");
  assert.ok(await w.count("SELECT count(*) AS n FROM audit_logs WHERE action = 'CLOCK_OUT_REFUSED'"), "the refusal is audited");
});

test("B4: correction request -> the Manager approves -> one attendance row is created atomically", async () => {
  // the Agent forgot to clock on Thursday 5 Nov
  const bad = await hr("POST", "/hr/me/corrections", "agent", { work_date: "2026-11-05", requested_in: "2026-11-05T09:00:00+01:00", requested_out: "2026-11-05T17:30:00+01:00" }, "2026-11-06T09:00:00+01:00");
  assert.equal(bad.status, 400, "a reason is required");
  const req = await hr("POST", "/hr/me/corrections", "agent", { work_date: "2026-11-05", requested_in: "2026-11-05T09:00:00+01:00", requested_out: "2026-11-05T17:30:00+01:00", reason: SENTINEL_CORR }, "2026-11-06T09:00:00+01:00");
  assert.equal(req.status, 201, dump(req));
  assert.equal(req.body.status, "pending");
  S.corr = req.body.id;
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_attendance WHERE user_id = $1 AND work_date = '2026-11-05'", [w.users.agent]), 0, "nothing recorded before approval");

  const list = await hr("GET", "/hr/team/corrections", "mgr");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.rows.map((r) => r.id), [req.body.id]);
  assert.equal((await hr("POST", `/hr/corrections/${req.body.id}/decide`, "agent", { decision: "approved" })).status, 403, "an employee has no approval permission");
  const ok = await hr("POST", `/hr/corrections/${req.body.id}/decide`, "mgr", { decision: "approved", note: SENTINEL_NOTE });
  assert.equal(ok.status, 200, dump(ok));
  assert.equal(ok.body.correction.status, "approved");
  assert.equal(ok.body.attendance.source, "correction");
  assert.equal(ok.body.attendance.correction_id, req.body.id);
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_attendance WHERE user_id = $1 AND work_date = '2026-11-05'", [w.users.agent]), 1);
  assert.equal((await hr("POST", `/hr/corrections/${req.body.id}/decide`, "mgr", { decision: "approved" })).status, 409, "decided once");
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_attendance WHERE correction_id = $1", [req.body.id]), 1, "no second record");
  assert.ok((await w.count("SELECT count(*) AS n FROM audit_logs WHERE table_name = 'hr_attendance_corrections' AND record_id = $1", [req.body.id])) >= 2, "request and decision audited");
});

// ================================================================ C  leave
test("C1: leave across a weekend and a holiday is counted exactly, approved by the Manager, balance used", async () => {
  // Fri 6 Nov .. Thu 12 Nov: Fri 6 (1) + Mon 9 + Tue 10 + [Wed 11 holiday] + Thu 12 = 4; Sat/Sun excluded
  const req = await hr("POST", "/hr/me/leave-requests", "agent", { leave_type_id: S.annual, start_date: "2026-11-06", end_date: "2026-11-12", reason: SENTINEL_REASON }, "2026-11-05T12:00:00+01:00");
  assert.equal(req.status, 201, dump(req));
  assert.equal(req.body.days, "4.00");
  assert.equal(req.body.status, "pending");
  S.leave1 = req.body.id;
  const bal = await annualBalance("agent");
  assert.equal(bal.used_days, "0.00");
  assert.equal(bal.pending_days, "4.00");

  const team = await hr("GET", "/hr/team/leave-requests", "mgr");
  assert.deepEqual(team.body.rows.map((r) => r.id), [S.leave1]);
  assert.equal(team.body.rows[0].reason, SENTINEL_REASON, "the approver sees the reason");
  const ok = await hr("POST", `/hr/leave-requests/${S.leave1}/decide`, "mgr", { decision: "approved", note: SENTINEL_NOTE });
  assert.equal(ok.status, 200, dump(ok));
  assert.equal(ok.body.status, "approved");
  const after = await annualBalance("agent");
  assert.equal(after.used_days, "4.00");
  assert.equal(after.pending_days, "0.00");
  assert.equal(after.remaining_days, "14.00");
  assert.equal((await hr("POST", `/hr/leave-requests/${S.leave1}/decide`, "mgr", { decision: "rejected" })).status, 409, "decided once");
});

test("C2: a request exceeding the balance is 409; an overlapping request is 409; unpaid leave is not counted", async () => {
  // Dec 2026 has 23 working days; 14 remain
  const over = await hr("POST", "/hr/me/leave-requests", "agent", { leave_type_id: S.annual, start_date: "2026-12-01", end_date: "2026-12-31" }, "2026-11-05T12:05:00+01:00");
  assert.equal(over.status, 409, dump(over));
  assert.match(over.body.error, /balance/i);
  const overlap = await hr("POST", "/hr/me/leave-requests", "agent", { leave_type_id: S.annual, start_date: "2026-11-10", end_date: "2026-11-10" }, "2026-11-05T12:06:00+01:00");
  assert.equal(overlap.status, 409, dump(overlap));
  const overlapUnpaid = await hr("POST", "/hr/me/leave-requests", "agent", { leave_type_id: S.unpaid, start_date: "2026-11-12", end_date: "2026-11-13" }, "2026-11-05T12:07:00+01:00");
  assert.equal(overlapUnpaid.status, 409, "overlap is checked across leave types");
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_leave_requests WHERE user_id = $1", [w.users.agent]), 1, "refused requests left no row");

  const un = await hr("POST", "/hr/me/leave-requests", "agent", { leave_type_id: S.unpaid, start_date: "2027-01-04", end_date: "2027-01-05", reason: "unpaid" }, "2026-11-05T12:08:00+01:00");
  assert.equal(un.status, 201, dump(un));
  assert.equal(un.body.days, "2.00");
  assert.equal((await hr("POST", `/hr/leave-requests/${un.body.id}/decide`, "mgr", { decision: "approved" })).status, 200);
  const bal = await annualBalance("agent");
  assert.equal(bal.remaining_days, "14.00", "unpaid leave never touches the annual balance");
});

test("C3: cancelling an approved future leave restores the balance; a leave that has started cannot be cancelled", async () => {
  const req = await hr("POST", "/hr/me/leave-requests", "agent", { leave_type_id: S.annual, start_date: "2026-12-14", end_date: "2026-12-18" }, "2026-11-05T12:10:00+01:00");
  assert.equal(req.status, 201, dump(req));
  assert.equal(req.body.days, "5.00");
  assert.equal((await hr("POST", `/hr/leave-requests/${req.body.id}/decide`, "mgr", { decision: "approved" })).status, 200);
  const used = await annualBalance("agent");
  assert.equal(used.remaining_days, "9.00");
  const started = await hr("POST", `/hr/me/leave-requests/${S.leave1}/cancel`, "agent", {}, "2026-11-16T09:00:00+01:00");
  assert.equal(started.status, 409, "leave 6-12 Nov has already started");
  const cancel = await hr("POST", `/hr/me/leave-requests/${req.body.id}/cancel`, "agent", {}, "2026-11-16T09:00:00+01:00");
  assert.equal(cancel.status, 200, dump(cancel));
  assert.equal(cancel.body.status, "cancelled");
  const back = await annualBalance("agent");
  assert.equal(back.remaining_days, "14.00", "balance restored");
  assert.equal((await hr("POST", `/hr/leave-requests/${req.body.id}/decide`, "mgr", { decision: "approved" })).status, 409, "a cancelled request cannot be approved");
});

test("C4: self-approval is refused; an HR user's own request is approved by the Admin; a non-report is 404 for the Manager", async () => {
  const req = await hr("POST", "/hr/me/leave-requests", "hr", { leave_type_id: S.annual, start_date: "2026-12-21", end_date: "2026-12-22", reason: "HR private" }, "2026-11-05T13:00:00+01:00");
  assert.equal(req.status, 201, dump(req));
  assert.equal(req.body.days, "2.00", "default Mon-Fri schedule when the profile has none");
  const self = await hr("POST", `/hr/leave-requests/${req.body.id}/decide`, "hr", { decision: "approved" });
  assert.equal(self.status, 403, dump(self));
  const mgrTry = await hr("POST", `/hr/leave-requests/${req.body.id}/decide`, "mgr", { decision: "approved" });
  assert.equal(mgrTry.status, 404, "HR is not a report of the Manager");
  assert.equal((await hr("GET", "/hr/team/leave-requests", "mgr")).body.rows.some((r) => r.id === req.body.id), false);
  assert.equal((await w.one("SELECT status FROM hr_leave_requests WHERE id = $1", [req.body.id])).status, "pending");
  const ok = await hr("POST", `/hr/leave-requests/${req.body.id}/decide`, "admin", { decision: "approved" });
  assert.equal(ok.status, 200, dump(ok));
  assert.equal(ok.body.status, "approved");
  // the Manager's own request cannot be approved by the Manager either
  const mine = await hr("POST", "/hr/me/leave-requests", "mgr", { leave_type_id: S.unpaid, start_date: "2027-02-01", end_date: "2027-02-01" }, "2026-11-05T13:10:00+01:00");
  assert.equal(mine.status, 201, dump(mine));
  assert.equal((await hr("POST", `/hr/leave-requests/${mine.body.id}/decide`, "mgr", { decision: "approved" })).status, 403);
  // a correction of a non-report: the Manager gets 404
  const c = await hr("POST", "/hr/me/corrections", "hr", { work_date: "2026-11-05", requested_in: "2026-11-05T09:00:00+01:00", requested_out: "2026-11-05T17:00:00+01:00", reason: "hr forgot" }, "2026-11-06T09:00:00+01:00");
  assert.equal(c.status, 201, dump(c));
  assert.equal((await hr("POST", `/hr/corrections/${c.body.id}/decide`, "mgr", { decision: "approved" })).status, 404);
  assert.equal((await hr("POST", `/hr/corrections/${c.body.id}/decide`, "hr", { decision: "approved" })).status, 403, "self-approval of a correction");
  assert.equal((await hr("POST", `/hr/corrections/${c.body.id}/decide`, "admin", { decision: "rejected", note: "not needed" })).status, 200);
  S.hrLeave = req.body.id;
});

// ================================================================ D  isolation
test("D1: the Receptionist cannot see or touch the Agent's corrections and leave", async () => {
  const leave2 = await hr("POST", "/hr/me/leave-requests", "agent", { leave_type_id: S.annual, start_date: "2026-12-28", end_date: "2026-12-28", reason: SENTINEL_REASON }, "2026-11-16T09:00:00+01:00");
  assert.equal(leave2.status, 201, dump(leave2));
  S.pendingLeave = leave2.body.id;
  const corr2 = await hr("POST", "/hr/me/corrections", "agent", { work_date: "2026-11-04", requested_in: "2026-11-04T09:00:00+01:00", requested_out: "2026-11-04T17:30:00+01:00", reason: SENTINEL_CORR }, "2026-11-16T09:00:00+01:00");
  assert.equal(corr2.status, 201, dump(corr2));
  S.pendingCorr = corr2.body.id;

  for (const who of ["rec", "acc"]) {
    for (const u of ["/hr/team/corrections", "/hr/team/leave-requests", "/hr/employees", "/hr/reports/leave", "/hr/balances"]) {
      const r = await hr("GET", u, who);
      assert.equal(r.status, 403, `${who} GET ${u}`);
      assert.equal(dump(r).includes("SENTINEL"), false);
    }
    assert.equal((await hr("POST", `/hr/leave-requests/${S.pendingLeave}/decide`, who, { decision: "approved" })).status, 403, `${who} decide leave`);
    assert.equal((await hr("POST", `/hr/corrections/${S.pendingCorr}/decide`, who, { decision: "approved" })).status, 403, `${who} decide correction`);
    // own lists contain only own rows
    const mineL = await hr("GET", "/hr/me/leave-requests", who);
    assert.equal(mineL.body.rows.every((r) => r.user_id === w.users[who]), true);
    assert.equal(dump(mineL).includes("SENTINEL"), false);
    const mineC = await hr("GET", "/hr/me/corrections", who);
    assert.equal(dump(mineC).includes("SENTINEL"), false);
    // someone else's request is 404 on the own-cancel routes
    assert.equal((await hr("POST", `/hr/me/leave-requests/${S.pendingLeave}/cancel`, who, {})).status, 404, `${who} cancel foreign leave`);
    assert.equal((await hr("POST", `/hr/me/corrections/${S.pendingCorr}/cancel`, who, {})).status, 404, `${who} cancel foreign correction`);
  }
  assert.equal((await w.one("SELECT status FROM hr_leave_requests WHERE id = $1", [S.pendingLeave])).status, "pending", "untouched");
  assert.equal((await w.one("SELECT status FROM hr_attendance_corrections WHERE id = $1", [S.pendingCorr])).status, "pending", "untouched");
  // the Manager reaches both (direct report) and the pending correction can then be rejected
  assert.equal((await hr("GET", "/hr/team/corrections", "mgr")).body.rows.some((r) => r.id === S.pendingCorr), true);
  assert.equal((await hr("POST", `/hr/corrections/${S.pendingCorr}/decide`, "mgr", { decision: "rejected", note: "no record, no correction" })).status, 200);
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_attendance WHERE user_id = $1 AND work_date = '2026-11-04'", [w.users.agent]), 0, "a rejected correction records nothing");
});

test("D2: the team calendar shows leave entries but the JSON never contains a reason or note", async () => {
  const q = "/hr/team/calendar?from=2026-11-01&to=2026-12-31";
  const asMgr = await hr("GET", q, "mgr");
  assert.equal(asMgr.status, 200, dump(asMgr));
  const agentEntries = (r) => r.body.entries.filter((e) => e.user_id === w.users.agent);
  assert.equal(agentEntries(asMgr).length, 2, "Manager sees the approved 6-12 Nov and the pending 28 Dec of a direct report");
  const nov = agentEntries(asMgr).find((e) => e.start_date === "2026-11-06");
  assert.equal(nov.end_date, "2026-11-12");
  assert.equal(nov.status, "approved");
  assert.equal(asMgr.body.holidays.some((h) => h.day === "2026-11-11"), true);
  const asAcc = await hr("GET", q, "acc"); // same department "Sales": a department grants nothing (privacy review)
  assert.equal(agentEntries(asAcc).length, 0, "a colleague in the same department does not see the Agent's leave");
  const asRec = await hr("GET", q, "rec"); // different department: nothing of the Agent
  assert.equal(agentEntries(asRec).length, 0);
  const asHr = await hr("GET", q, "hr");
  assert.equal(agentEntries(asHr).length, 2);
  assert.equal(agentEntries(await hr("GET", q, "agent")).length, 2, "the owner sees their own approved and pending leave");
  for (const [who, r] of [["mgr", asMgr], ["acc", asAcc], ["rec", asRec], ["hr", asHr], ["agent", await hr("GET", q, "agent")]]) {
    for (const s of ALL_SENTINELS) assert.equal(dump(r).includes(s), false, `${who}: calendar leaks ${s}`);
    for (const e of r.body.entries) assert.equal(Object.keys(e).some((k) => /reason|note|days|decided|request_id/i.test(k)), false, `${who}: entry keys ${Object.keys(e)}`);
  }
});

// ================================================================ E  reports and export
const REPORT_NOW = "2026-11-16T10:00:00+01:00"; // Monday after the report window

test("E0: the Agent works Fri 13 Nov exactly on the grace boundary (09:10:00 is not late)", async () => {
  assert.equal((await hr("POST", "/hr/clock-in", "agent", {}, "2026-11-13T09:10:00+01:00")).status, 201);
  const out = await hr("POST", "/hr/clock-out", "agent", {}, "2026-11-13T13:00:00+01:00");
  assert.equal(out.body.record.worked_minutes, 230);
});

/** Independent computation straight from the tables (no use of the report SQL or hr_is_on_approved_leave). */
async function independent(from, to, today) {
  const rows = (
    await w.q(
      `WITH emp AS (
         SELECT e.user_id, s.grace_minutes, s.timezone, (s.weekly->'mon'->>'start')::time AS start_t
           FROM hr_employees e JOIN hr_schedules s ON s.id = e.schedule_id WHERE e.status = 'active'),
       d AS (SELECT g::date AS day FROM generate_series($1::date, $2::date, interval '1 day') g WHERE extract(isodow FROM g) BETWEEN 1 AND 5),
       pd AS (
         SELECT emp.*, d.day,
                EXISTS (SELECT 1 FROM hr_holidays h WHERE h.day = d.day) AS hol,
                EXISTS (SELECT 1 FROM hr_leave_requests r WHERE r.user_id = emp.user_id AND r.status = 'approved' AND d.day BETWEEN r.start_date AND r.end_date) AS lv
           FROM emp CROSS JOIN d),
       att AS (
         SELECT user_id, (clock_in AT TIME ZONE 'Africa/Tunis')::date AS day, min(clock_in) AS first_in,
                COALESCE(sum(floor(extract(epoch FROM clock_out - clock_in) / 60)) FILTER (WHERE clock_out IS NOT NULL), 0)::int AS mins
           FROM hr_attendance GROUP BY 1, 2)
       SELECT pd.user_id,
              COALESCE(sum(att.mins), 0)::int AS worked,
              count(*) FILTER (WHERE NOT pd.hol AND NOT pd.lv AND att.first_in IS NOT NULL AND (att.first_in AT TIME ZONE pd.timezone)::time > pd.start_t + make_interval(mins => pd.grace_minutes))::int AS late,
              count(*) FILTER (WHERE NOT pd.hol AND NOT pd.lv AND att.first_in IS NULL AND pd.day < $3::date)::int AS absent,
              count(*) FILTER (WHERE pd.hol)::int AS holiday,
              count(*) FILTER (WHERE NOT pd.hol AND pd.lv)::int AS leave,
              count(*) FILTER (WHERE NOT pd.hol AND NOT pd.lv)::int AS scheduled
         FROM pd LEFT JOIN att ON att.user_id = pd.user_id AND att.day = pd.day
        GROUP BY pd.user_id ORDER BY pd.user_id`,
      [from, to, today]
    )
  ).rows;
  return Object.fromEntries(rows.map((r) => [r.user_id, r]));
}

test("E1: the HR attendance report equals an independent SQL computation (late, absent, worked, holiday/leave excluded)", async () => {
  const rep = await hr("GET", "/hr/reports/attendance?from=2026-11-02&to=2026-11-13", "hr", undefined, REPORT_NOW);
  assert.equal(rep.status, 200, dump(rep));
  assert.equal(rep.body.timezone, "Africa/Tunis");
  const ind = await independent("2026-11-02", "2026-11-13", "2026-11-16");
  const per = {};
  for (const r of rep.body.rows) {
    const p = (per[r.user_id] ||= { worked: 0, late: 0, absent: 0, holiday: 0, leave: 0, scheduled: 0 });
    p.worked += r.worked_minutes;
    if (r.late) p.late += 1;
    if (r.absent) p.absent += 1;
    if (r.scheduled && r.holiday) p.holiday += 1;
    if (r.scheduled && !r.holiday && r.on_leave) p.leave += 1;
    if (r.scheduled && !r.holiday && !r.on_leave) p.scheduled += 1;
  }
  assert.deepEqual(Object.keys(per).map(Number).sort(), [w.users.agent, w.users.rec].sort(), "only people with a schedule are expected");
  for (const uid of [w.users.agent, w.users.rec]) assert.deepEqual(per[uid], { worked: Number(ind[uid].worked), late: ind[uid].late, absent: ind[uid].absent, holiday: ind[uid].holiday, leave: ind[uid].leave, scheduled: ind[uid].scheduled }, `user ${uid}`);
  // hand-computed expectations
  assert.deepEqual(per[w.users.agent], { worked: 490 + 515 + 510 + 230, late: 1, absent: 1, holiday: 1, leave: 4, scheduled: 5 });
  assert.deepEqual(per[w.users.rec], { worked: 510, late: 0, absent: 7, holiday: 1, leave: 0, scheduled: 9 });
  // holiday and leave days are neither absent nor late
  const agentRows = rep.body.rows.filter((r) => r.user_id === w.users.agent);
  for (const d of ["2026-11-06", "2026-11-09", "2026-11-10", "2026-11-12"]) assert.equal(agentRows.find((r) => r.day === d).on_leave, true, d);
  for (const d of ["2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]) {
    const r = agentRows.find((x) => x.day === d);
    assert.equal(r.absent || r.late, false, d);
  }
  assert.equal(agentRows.find((r) => r.day === "2026-11-11").holiday, true);
  assert.equal(agentRows.find((r) => r.day === "2026-11-13").late, false, "09:10:00 is inside the 10 minute grace");
  const lateRow = agentRows.find((r) => r.day === "2026-11-02");
  assert.equal(lateRow.late, true);
  assert.equal(lateRow.late_minutes, 25);
  assert.equal(agentRows.find((r) => r.day === "2026-11-04").absent, true);
  assert.equal(agentRows.find((r) => r.day === "2026-11-05").worked_minutes, 510, "the corrected day counts");
  // the stale session is flagged, not closed
  const staleRow = rep.body.rows.find((r) => r.user_id === w.users.rec && r.day === "2026-11-03");
  assert.equal(staleRow.open_session, true);
  assert.equal(staleRow.needs_correction, true);
  // summary equals the sum of the independent numbers
  const sum = (k) => Object.values(ind).reduce((s, r) => s + Number(r[k]), 0);
  assert.equal(rep.body.summary.worked_minutes, sum("worked"));
  assert.equal(rep.body.summary.late_days, sum("late"));
  assert.equal(rep.body.summary.absent_days, sum("absent"));
  assert.equal(rep.body.summary.holiday_days, sum("holiday"));
  assert.equal(rep.body.summary.leave_days, sum("leave"));
  assert.equal(rep.body.summary.scheduled_days, sum("scheduled"));
  assert.equal(rep.body.summary.needs_correction, 1);
  for (const s of ALL_SENTINELS) assert.equal(dump(rep).includes(s), false, "reasons never in the report");
  // a single employee filter
  const one = await hr("GET", `/hr/reports/attendance?from=2026-11-02&to=2026-11-13&user_id=${w.users.agent}`, "hr", undefined, REPORT_NOW);
  assert.equal(one.body.summary.worked_minutes, 1745);
  assert.equal(one.body.summary.people, 1);
  // the Manager has no hr:read: no reports
  assert.equal((await hr("GET", "/hr/reports/attendance?from=2026-11-02&to=2026-11-13", "mgr", undefined, REPORT_NOW)).status, 403);
  // leave report: remaining after approved
  const lr = await hr("GET", "/hr/reports/leave?year=2026", "hr");
  const row = lr.body.rows.find((r) => r.user_id === w.users.agent && r.leave_type_code === "ANNUAL");
  assert.equal(row.entitled_days, "18.00");
  assert.equal(row.approved_days, "4.00");
  assert.equal(row.pending_days, "1.00", "the pending 28 Dec request");
  assert.equal(row.remaining_days, "14.00");
  assert.equal(row.available_days, "13.00");
  for (const s of ALL_SENTINELS) assert.equal(dump(lr).includes(s), false, "reasons never in the leave report");
});

/** Minimal RFC 4180 reader: every cell quoted, "" for a quote, CRLF rows. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r") {
      /* CR of CRLF */
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

test("E2: the CSV export parses back (BOM, CRLF, quoting) and neutralises a formula-looking value", async () => {
  // raw bytes: fetch().text() would swallow the BOM
  const raw = await fetch(`${w.base}/hr/export/attendance.csv?from=2026-11-02&to=2026-11-13`, { headers: { authorization: `Bearer ${T().hr}`, ...at(REPORT_NOW) } });
  const bytes = Buffer.from(await raw.arrayBuffer());
  const res = { status: raw.status, headers: raw.headers, body: bytes.toString("utf8") };
  assert.equal(res.status, 200);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM bytes EF BB BF");
  assert.match(res.headers.get("content-type"), /^text\/csv; charset=utf-8/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="attendance-2026-11-02_2026-11-13\.csv"/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(typeof res.body, "string");
  assert.ok(res.body.includes("\r\n"));
  const rows = parseCsv(res.body.replace(/^\uFEFF/, ""));
  const [head, ...data] = rows;
  assert.deepEqual(head.slice(0, 5), ["day", "user_id", "employee_no", "employee_name", "scheduled"]);
  const rep = await hr("GET", "/hr/reports/attendance?from=2026-11-02&to=2026-11-13", "hr", undefined, REPORT_NOW);
  assert.equal(data.length, rep.body.rows.length, "one CSV line per report row");
  for (const r of data) assert.equal(r.length, head.length, "every row has every column");
  const col = (name) => head.indexOf(name);
  const agentRows = data.filter((r) => r[col("user_id")] === String(w.users.agent));
  assert.ok(agentRows.length > 0);
  for (const r of agentRows) assert.equal(r[col("employee_no")], "'=1+1", "a leading = is neutralised with a quote");
  for (const r of data) for (const cell of r) assert.equal(/^[=+\-@\t]/.test(cell), false, `cell starts like a formula: ${cell}`);
  assert.ok(res.body.includes(`"'=1+1"`));
  assert.equal(res.body.includes(`"=1+1"`), false);
  const nov2 = agentRows.find((r) => r[col("day")] === "2026-11-02");
  assert.equal(nov2[col("worked_minutes")], "490");
  assert.equal(nov2[col("late")], "true");
  for (const s of ALL_SENTINELS) assert.equal(res.body.includes(s), false, "reasons never in the export");
  assert.equal((await hr("GET", "/hr/export/attendance.csv", "agent")).status, 403);
  assert.ok(await w.count("SELECT count(*) AS n FROM audit_logs WHERE action = 'EXPORT' AND table_name = 'hr_attendance'"), "exports are audited");
});

// ================================================================ F  authorization
test("F1: Accountant, Receptionist and Agent are denied on every HR admin route; nothing is written", async () => {
  const before = {
    emp: await w.count("SELECT count(*) AS n FROM hr_employees"),
    sch: await w.count("SELECT count(*) AS n FROM hr_schedules"),
    hol: await w.count("SELECT count(*) AS n FROM hr_holidays"),
    typ: await w.count("SELECT count(*) AS n FROM hr_leave_types"),
    bal: await w.count("SELECT COALESCE(sum(entitled_days),0) AS n FROM hr_leave_balances"),
  };
  const gets = ["/hr/employees", `/hr/employees/${w.users.agent}`, "/hr/schedules", "/hr/leave-types", "/hr/holidays", "/hr/balances", "/hr/staff", "/hr/reports/attendance?from=2026-11-02&to=2026-11-13", "/hr/reports/leave", "/hr/export/attendance.csv", "/hr/attendance/open"];
  const writes = [
    ["POST", "/hr/attendance/1/close", { clock_out: "2026-11-02T17:00:00+01:00" }],
    ["POST", "/hr/employees", { user_id: w.users.admin }],
    ["PATCH", `/hr/employees/${w.users.agent}`, { department: "Hacked" }],
    ["POST", "/hr/schedules", { name: "x", weekly: { mon: null } }],
    ["PATCH", `/hr/schedules/${S.schedule}`, { grace_minutes: 600 }],
    ["POST", "/hr/leave-types", { code: "NOPE", name_ar: "x", name_en: "x", name_fr: "x" }],
    ["PATCH", `/hr/leave-types/${S.annual}`, { active: false }],
    ["POST", "/hr/holidays", { day: "2026-12-25", name: "x" }],
    ["DELETE", "/hr/holidays/1", undefined],
    ["PUT", "/hr/balances", { user_id: w.users.agent, leave_type_id: S.annual, year: 2026, entitled_days: "365" }],
  ];
  for (const who of ["acc", "rec", "agent"]) {
    for (const u of gets) assert.equal((await hr("GET", u, who)).status, 403, `${who} GET ${u}`);
    for (const [m, u, b] of writes) assert.equal((await hr(m, u, who, b)).status, 403, `${who} ${m} ${u}`);
  }
  // the Manager has hr:approve only
  for (const u of gets) assert.equal((await hr("GET", u, "mgr")).status, 403, `mgr GET ${u}`);
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_employees"), before.emp);
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_schedules"), before.sch);
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_holidays"), before.hol);
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_leave_types"), before.typ);
  assert.equal(await w.count("SELECT COALESCE(sum(entitled_days),0) AS n FROM hr_leave_balances"), before.bal);
  assert.equal((await w.one("SELECT active FROM hr_leave_types WHERE id = $1", [S.annual])).active, true);
  // the positive control: HR and Admin do get through
  for (const who of ["hr", "admin"]) for (const u of gets.slice(0, 7)) assert.equal((await hr("GET", u, who)).status, 200, `${who} GET ${u}`);
});

test("F2: Candidate (real OTP login), Employer and Agency tokens and anonymous callers are denied on every /hr route class", async () => {
  const cand = await E.createCandidate(w, "hr", "mgr");
  const emp = await createEmployerUser(w.pool, { orgName: "HR Employer" });
  const ag = await createAgencyUser(w.pool, { orgName: "HR Agency" });
  const actors = { Candidate: cand.token, Employer: emp.token, Agency: ag.token };
  const gets = [
    "/hr/me", "/hr/me/leave-types", "/hr/me/attendance", "/hr/me/corrections", "/hr/me/leave-requests", // self-service
    "/hr/team/calendar?from=2026-11-01&to=2026-11-30", // calendar
    "/hr/team/corrections", "/hr/team/leave-requests", // approvals
    "/hr/employees", "/hr/schedules", "/hr/leave-types", "/hr/holidays", "/hr/balances", "/hr/staff", // admin
    "/hr/reports/attendance?from=2026-11-02&to=2026-11-13", "/hr/reports/leave", "/hr/export/attendance.csv", "/hr/attendance/open", // reports / export / stale sessions
  ];
  const posts = [
    ["POST", "/hr/clock-in", {}], ["POST", "/hr/clock-out", {}],
    ["POST", "/hr/me/corrections", { work_date: "2026-11-05", requested_in: "2026-11-05T09:00:00+01:00", requested_out: "2026-11-05T17:00:00+01:00", reason: "x" }],
    ["POST", "/hr/me/leave-requests", { leave_type_id: S.annual, start_date: "2027-03-01", end_date: "2027-03-01" }],
    ["POST", `/hr/me/leave-requests/${S.pendingLeave}/cancel`, {}],
    ["POST", `/hr/leave-requests/${S.pendingLeave}/decide`, { decision: "approved" }],
    ["POST", `/hr/corrections/${S.corr}/decide`, { decision: "approved" }],
    ["POST", "/hr/employees", { user_id: w.users.admin }],
    ["POST", "/hr/attendance/1/close", { clock_out: "2026-11-02T17:00:00+01:00" }],
    ["POST", "/hr/holidays", { day: "2026-12-26", name: "x" }],
    ["PUT", "/hr/balances", { user_id: w.users.agent, leave_type_id: S.annual, year: 2026, entitled_days: "365" }],
  ];
  const att = await w.count("SELECT count(*) AS n FROM hr_attendance");
  const lv = await w.count("SELECT count(*) AS n FROM hr_leave_requests");
  const co = await w.count("SELECT count(*) AS n FROM hr_attendance_corrections");
  const ho = await w.count("SELECT count(*) AS n FROM hr_holidays");
  for (const [name, tok] of Object.entries(actors)) {
    for (const u of gets) {
      const r = await hr("GET", u, tok);
      assert.equal(r.status, 403, `${name} GET ${u}`);
      assert.equal(dump(r).includes("SENTINEL"), false);
    }
    for (const [m, u, b] of posts) assert.equal((await hr(m, u, tok, b)).status, 403, `${name} ${m} ${u}`);
  }
  for (const u of gets) assert.equal((await hr("GET", u, null)).status, 401, `anonymous GET ${u}`);
  for (const [m, u, b] of posts) assert.equal((await hr(m, u, null, b)).status, 401, `anonymous ${m} ${u}`);
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_attendance"), att);
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_leave_requests"), lv);
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_attendance_corrections"), co);
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_holidays"), ho);
  assert.equal((await w.one("SELECT status FROM hr_leave_requests WHERE id = $1", [S.pendingLeave])).status, "pending");
  // a staff token is not a portal token the other way round either
  assert.equal((await hr("GET", "/employer/me", "hr")).status, 403);
});

// ================================================================ G  concurrency
test("G1: 10 parallel clock-ins leave exactly one record", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => hr("POST", "/hr/clock-in", "acc", {}, "2026-11-16T08:30:00+01:00")));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 1, `exactly one created: ${statuses}`);
  assert.equal(statuses.every((s) => s === 201 || s === 200), true, `the rest are replays, never 5xx: ${statuses}`);
  assert.equal(new Set(results.map((r) => r.body.record.id)).size, 1, "every answer names the same record");
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_attendance WHERE user_id = $1", [w.users.acc]), 1);
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_attendance WHERE user_id = $1 AND clock_out IS NULL", [w.users.acc]), 1);
});

test("G2: a deactivated user's token dies at once", async () => {
  assert.equal((await hr("GET", "/hr/me", "acc")).status, 200);
  assert.equal((await hr("POST", "/hr/clock-out", "acc", {}, "2026-11-16T09:00:00+01:00")).status, 200);
  await w.q("UPDATE users SET is_active = false WHERE id = $1", [w.users.acc]);
  for (const [m, u, b] of [["GET", "/hr/me"], ["POST", "/hr/clock-in", {}], ["POST", "/hr/clock-out", {}], ["GET", "/hr/team/calendar?from=2026-11-01&to=2026-11-30"], ["GET", "/hr/me/leave-requests"]]) {
    assert.equal((await hr(m, u, "acc", b, "2026-11-16T10:00:00+01:00")).status, 401, `${m} ${u}`);
  }
  assert.equal(await w.count("SELECT count(*) AS n FROM hr_attendance WHERE user_id = $1", [w.users.acc]), 1, "no record after deactivation");
  const login = await w.http("POST", "/auth/login", null, { email: "acc-accountant@test.invalid", password: "e2e-Passw0rd!" });
  assert.notEqual(login.status, 200, "a deactivated account cannot log in either");
});

// ================================================================ H  sweep
test("H1: the all-routes authorization sweep file still passes", () => {
  const r = spawnSync(process.execPath, ["--test", path.join(__dirname, "orgs-route-sweep.test.js")], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", NODE_TEST_CONTEXT: undefined }, timeout: 240000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /# pass [1-9]/, "the sweep actually ran");
  assert.match(r.stdout, /# fail 0/);
});
