// Stage 5, Task 3: attendance clocking, corrections with approval, reports and CSV export (real Postgres, injected clock).
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "hr-attendance-test-secret";
delete process.env.HR_TIMEZONE;
delete process.env.HR_MAX_OPEN_HOURS;
delete process.env.HR_EXPORT_MAX_ROWS;

async function withWorld(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = (sql, p) => pool.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  // `now` (ISO) is the injected clock: honoured by the server only because NODE_ENV is "test".
  const http = async (method, url, token, body, now) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(now ? { "x-test-now": now } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = Buffer.from(await res.arrayBuffer()).toString("utf8"); // keeps a leading BOM (res.text() would strip it)
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const roles = { sa: "SuperAdmin", admin: "Admin", acct: "Accountant", mgr: "Manager", agent: "Agent", rec: "Receptionist", hr: "HR", cand: "Candidate" };
  const ids = {};
  const T = {};
  for (const [k, role] of Object.entries(roles)) {
    ids[k] = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`${role} ${k}`, `${k}@att.test.invalid`, role])).id;
    T[k] = jwt.sign({ id: ids[k], role, ...(k === "cand" ? { tv: 0 } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" });
  }
  T.emp = (await createEmployerUser(pool)).token;
  T.agy = (await createAgencyUser(pool)).token;
  let n = 0;
  const staff = async (role = "Agent", over = {}) => {
    n += 1;
    const id = (await one("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x',$3,$4) RETURNING id", [over.name || `Extra ${n}`, `extra${n}@att.test.invalid`, role, over.active ?? true])).id;
    return { id, token: jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
  };
  const schedule = async (over = {}) =>
    (await one("INSERT INTO hr_schedules (name, weekly, grace_minutes, timezone) VALUES ($1,$2::jsonb,$3,$4) RETURNING id", [
      over.name || `Sched ${++n}`,
      JSON.stringify(over.weekly || {}),
      over.grace ?? 10,
      over.tz || "Africa/Tunis",
    ])).id;
  const profile = (userId, o = {}) =>
    q("INSERT INTO hr_employees (user_id, manager_user_id, schedule_id, status, hire_date, end_date) VALUES ($1,$2,$3,$4,$5,$6)", [userId, o.manager ?? null, o.schedule ?? null, o.status || "active", o.hire ?? null, o.end ?? null]);
  const att = async (userId, workDate, inTs, outTs, source = "clock") =>
    (await one("INSERT INTO hr_attendance (user_id, work_date, clock_in, clock_out, source) VALUES ($1,$2::date,$3::timestamptz,$4::timestamptz,$5) RETURNING id", [userId, workDate, inTs, outTs, source])).id;
  const count = async (sql, p) => Number((await one(sql, p)).n);
  try {
    await fn({ pool, http, q, one, T, ids, staff, schedule, profile, att, count });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}
const ADMINS = ["sa", "admin", "hr"];
const NON_ADMIN_STAFF = ["mgr", "acct", "agent", "rec"];
const OUTSIDERS = ["cand", "emp", "agy"];
const WEEKDAYS = { mon: { start: "09:00", end: "17:00", break_minutes: 60 }, tue: { start: "09:00", end: "17:00", break_minutes: 60 }, wed: { start: "09:00", end: "17:00", break_minutes: 60 }, thu: { start: "09:00", end: "17:00", break_minutes: 60 }, fri: { start: "09:00", end: "17:00", break_minutes: 60 } };

// ------------------------------------------------------------------------------------------------ role matrix
test("role matrix: self-service for every active staff role; approvals for hr:approve; reports/export for hr:read; outsiders denied everywhere", () =>
  withWorld(async ({ http, T }) => {
    const all = [...ADMINS, ...NON_ADMIN_STAFF];
    for (const url of ["/hr/me/attendance", "/hr/me/corrections"]) {
      for (const k of all) assert.equal((await http("GET", url, T[k])).status, 200, `${k} ${url}`);
    }
    for (const k of ["sa", "admin", "hr", "mgr"]) assert.equal((await http("GET", "/hr/team/corrections", T[k])).status, 200, `${k} team/corrections`);
    for (const k of ["acct", "agent", "rec"]) assert.equal((await http("GET", "/hr/team/corrections", T[k])).status, 403, `${k} team/corrections`);
    for (const url of ["/hr/reports/attendance", "/hr/export/attendance.csv"]) {
      for (const k of ADMINS) assert.equal((await http("GET", url, T[k])).status, 200, `${k} ${url}`);
      for (const k of NON_ADMIN_STAFF) assert.equal((await http("GET", url, T[k])).status, 403, `${k} ${url}`);
    }
    for (const k of ["acct", "agent", "rec"]) assert.equal((await http("POST", "/hr/corrections/1/decide", T[k], { decision: "approved" })).status, 403, `${k} decide`);
    for (const k of ["sa", "admin", "hr", "mgr"]) assert.equal((await http("POST", "/hr/corrections/999999/decide", T[k], { decision: "approved" })).status, 404, `${k} decide unknown`);
    const routes = [["GET", "/hr/me/attendance"], ["POST", "/hr/clock-in"], ["POST", "/hr/clock-out"], ["POST", "/hr/me/corrections"], ["POST", "/hr/me/corrections/1/cancel"], ["GET", "/hr/me/corrections"], ["GET", "/hr/team/corrections"], ["POST", "/hr/corrections/1/decide"], ["GET", "/hr/reports/attendance"], ["GET", "/hr/export/attendance.csv"]];
    for (const [m, url] of routes) {
      for (const k of OUTSIDERS) assert.equal((await http(m, url, T[k], m === "POST" ? {} : undefined)).status, 403, `${k} ${m} ${url}`);
      assert.equal((await http(m, url, undefined, m === "POST" ? {} : undefined)).status, 401, `anon ${m} ${url}`);
    }
  }));

test("a deactivated staff account cannot clock in even with a still-valid token, and nothing is written", () =>
  withWorld(async ({ http, q, staff, count }) => {
    const u = await staff("Agent");
    await q("UPDATE users SET is_active=false WHERE id=$1", [u.id]);
    assert.equal((await http("POST", "/hr/clock-in", u.token)).status, 401);
    assert.equal((await http("POST", "/hr/clock-out", u.token)).status, 401);
    assert.equal((await http("GET", "/hr/me/attendance", u.token)).status, 401);
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance WHERE user_id=$1", [u.id]), 0);
  }));

// ------------------------------------------------------------------------------------------------ clock in / out
test("clock-in creates an open 'clock' record with the company-timezone work_date (no HR profile needed); audited", () =>
  withWorld(async ({ http, staff, one, count }) => {
    const u = await staff("Agent");
    const r = await http("POST", "/hr/clock-in", u.token, undefined, "2026-03-10T08:00:00Z");
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.replayed, false);
    assert.equal(r.body.record.work_date, "2026-03-10");
    assert.equal(r.body.record.source, "clock");
    assert.equal(r.body.record.clock_out, null);
    const row = await one("SELECT user_id, work_date::text AS d, clock_in, clock_out, source FROM hr_attendance WHERE id=$1", [r.body.record.id]);
    assert.equal(row.user_id, u.id);
    assert.equal(row.clock_in.toISOString(), "2026-03-10T08:00:00.000Z");
    assert.equal(await count("SELECT count(*) AS n FROM audit_logs WHERE table_name='hr_attendance' AND action='CLOCK_IN' AND user_id=$1", [u.id]), 1);
  }));

test("second clock-in while open: replay inside 60 s, 409 {error:'already clocked in', since} after", () =>
  withWorld(async ({ http, staff, count }) => {
    const u = await staff("Agent");
    const a = await http("POST", "/hr/clock-in", u.token, undefined, "2026-03-10T08:00:00Z");
    assert.equal(a.status, 201);
    const b = await http("POST", "/hr/clock-in", u.token, undefined, "2026-03-10T08:00:59Z");
    assert.equal(b.status, 200, b.text);
    assert.equal(b.body.replayed, true);
    assert.equal(b.body.record.id, a.body.record.id);
    const edge = await http("POST", "/hr/clock-in", u.token, undefined, "2026-03-10T08:01:00Z");
    assert.equal(edge.status, 200, "exactly 60 s is still a replay");
    const c = await http("POST", "/hr/clock-in", u.token, undefined, "2026-03-10T08:01:01Z");
    assert.equal(c.status, 409);
    assert.equal(c.body.error, "already clocked in");
    assert.equal(new Date(c.body.since).toISOString(), "2026-03-10T08:00:00.000Z");
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance WHERE user_id=$1", [u.id]), 1);
  }));

test("ten concurrent clock-ins leave exactly one record; the rest are replays or 409, never a 500", () =>
  withWorld(async ({ http, staff, count }) => {
    const u = await staff("Agent");
    const rs = await Promise.all(Array.from({ length: 10 }, () => http("POST", "/hr/clock-in", u.token)));
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance WHERE user_id=$1", [u.id]), 1);
    assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join());
    for (const r of rs) assert.ok(r.status === 201 || (r.status === 200 && r.body.replayed === true) || r.status === 409, `unexpected ${r.status} ${r.text}`);
    const ids = new Set(rs.filter((r) => r.status !== 409).map((r) => r.body.record.id));
    assert.equal(ids.size, 1);
  }));

test("clock-out closes the open record; replay within 60 s; none open => 409; too late => 409", () =>
  withWorld(async ({ http, staff, one, count }) => {
    const u = await staff("Agent");
    const none = await http("POST", "/hr/clock-out", u.token, undefined, "2026-03-10T08:00:00Z");
    assert.equal(none.status, 409);
    assert.match(none.body.error, /not clocked in/);
    await http("POST", "/hr/clock-in", u.token, undefined, "2026-03-10T08:00:00Z");
    const out = await http("POST", "/hr/clock-out", u.token, undefined, "2026-03-10T12:30:00Z");
    assert.equal(out.status, 200, out.text);
    assert.equal(out.body.replayed, false);
    assert.equal(out.body.record.worked_minutes, 270);
    const again = await http("POST", "/hr/clock-out", u.token, undefined, "2026-03-10T12:30:45Z");
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.record.id, out.body.record.id);
    const late = await http("POST", "/hr/clock-out", u.token, undefined, "2026-03-10T12:31:31Z");
    assert.equal(late.status, 409);
    const row = await one("SELECT clock_out FROM hr_attendance WHERE id=$1", [out.body.record.id]);
    assert.equal(row.clock_out.toISOString(), "2026-03-10T12:30:00.000Z", "the replay did not move the clock-out");
    assert.equal(await count("SELECT count(*) AS n FROM audit_logs WHERE table_name='hr_attendance' AND action='CLOCK_OUT'"), 1);
    // Clock back in after clocking out is a new record; back-to-back sessions are fine.
    const second = await http("POST", "/hr/clock-in", u.token, undefined, "2026-03-10T13:00:00Z");
    assert.equal(second.status, 201);
    assert.notEqual(second.body.record.id, out.body.record.id);
  }));

test("an open session older than HR_MAX_OPEN_HOURS is refused (not capped), flagged, and stays open", () =>
  withWorld(async ({ http, staff, att, one, count }) => {
    const u = await staff("Agent");
    const id = await att(u.id, "2026-03-09", "2026-03-09T08:00:00Z", null);
    const ok = await http("POST", "/hr/clock-out", u.token, undefined, "2026-03-10T00:00:00Z"); // exactly 16 h
    assert.equal(ok.status, 200, "16 h is within the limit");
    await one("UPDATE hr_attendance SET clock_out=NULL WHERE id=$1", [id]);
    const r = await http("POST", "/hr/clock-out", u.token, undefined, "2026-03-10T00:00:01Z");
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "session too old; request a correction");
    assert.equal(r.body.needs_correction, true);
    assert.equal((await one("SELECT clock_out FROM hr_attendance WHERE id=$1", [id])).clock_out, null);
    assert.equal(await count("SELECT count(*) AS n FROM audit_logs WHERE table_name='hr_attendance' AND action='CLOCK_OUT_REFUSED' AND record_id=$1", [id]), 1);
    // A new clock-in is not allowed either (the old session is still open) and says so.
    const ci = await http("POST", "/hr/clock-in", u.token, undefined, "2026-03-10T00:10:00Z");
    assert.equal(ci.status, 409);
    assert.equal(ci.body.error, "already clocked in");
    assert.equal(ci.body.needs_correction, true);
    // The limit is configurable.
    process.env.HR_MAX_OPEN_HOURS = "100";
    try {
      assert.equal((await http("POST", "/hr/clock-out", u.token, undefined, "2026-03-10T00:20:00Z")).status, 200);
    } finally {
      delete process.env.HR_MAX_OPEN_HOURS;
    }
  }));

test("midnight boundary in Africa/Tunis: 22:59:59Z is still the 10th, 23:00:00Z is the 11th; a session spanning midnight belongs to its clock-in day", () =>
  withWorld(async ({ http, staff }) => {
    const a = await staff("Agent");
    const b = await staff("Agent");
    const before = await http("POST", "/hr/clock-in", a.token, undefined, "2026-03-10T22:59:59Z");
    const after = await http("POST", "/hr/clock-in", b.token, undefined, "2026-03-10T23:00:00Z");
    assert.equal(before.body.record.work_date, "2026-03-10");
    assert.equal(after.body.record.work_date, "2026-03-11");
    const out = await http("POST", "/hr/clock-out", a.token, undefined, "2026-03-11T02:00:00Z");
    assert.equal(out.status, 200);
    assert.equal(out.body.record.work_date, "2026-03-10", "attributed to the clock-in day");
    const list = await http("GET", "/hr/me/attendance?from=2026-03-10&to=2026-03-11", a.token, undefined, "2026-03-11T03:00:00Z");
    assert.deepEqual(list.body.days.map((d) => [d.work_date, d.worked_minutes]), [["2026-03-10", 180]]);
  }));

test("the schedule's timezone decides the work_date when the employee has one (HR_TIMEZONE otherwise)", () =>
  withWorld(async ({ http, staff, schedule, profile }) => {
    const dubai = await schedule({ tz: "Asia/Dubai", weekly: WEEKDAYS });
    const u = await staff("Agent");
    await profile(u.id, { schedule: dubai });
    const v = await staff("Agent");
    const r1 = await http("POST", "/hr/clock-in", u.token, undefined, "2026-03-10T22:59:59Z"); // 02:59:59 on the 11th in Dubai
    const r2 = await http("POST", "/hr/clock-in", v.token, undefined, "2026-03-10T22:59:59Z");
    assert.equal(r1.body.record.work_date, "2026-03-11");
    assert.equal(r2.body.record.work_date, "2026-03-10");
    process.env.HR_TIMEZONE = "Asia/Tokyo";
    try {
      const w = await staff("Agent");
      const r3 = await http("POST", "/hr/clock-in", w.token, undefined, "2026-03-10T16:00:00Z"); // 01:00 on the 11th in Tokyo
      assert.equal(r3.body.record.work_date, "2026-03-11");
    } finally {
      delete process.env.HR_TIMEZONE;
    }
  }));

// ------------------------------------------------------------------------------------------------ my attendance
test("GET /hr/me/attendance: own records only, worked minutes, day totals, schedule break reported separately, range validation", () =>
  withWorld(async ({ http, staff, schedule, profile, att }) => {
    const sid = await schedule({ weekly: WEEKDAYS });
    const u = await staff("Agent");
    await profile(u.id, { schedule: sid });
    const other = await staff("Agent");
    await att(u.id, "2026-03-10", "2026-03-10T08:00:00Z", "2026-03-10T12:00:00Z");
    await att(u.id, "2026-03-10", "2026-03-10T13:00:00Z", "2026-03-10T17:30:00Z", "correction");
    await att(u.id, "2026-03-11", "2026-03-11T08:00:00Z", null);
    await att(other.id, "2026-03-10", "2026-03-10T08:00:00Z", "2026-03-10T09:00:00Z");
    const r = await http("GET", "/hr/me/attendance?from=2026-03-10&to=2026-03-12", u.token, undefined, "2026-03-11T08:30:00Z");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.records.length, 3);
    assert.deepEqual(r.body.records.map((x) => x.worked_minutes), [240, 270, null]);
    assert.ok(r.body.records.every((x) => x.user_id === undefined || x.user_id === u.id));
    const d10 = r.body.days.find((d) => d.work_date === "2026-03-10");
    assert.equal(d10.worked_minutes, 510);
    assert.equal(d10.sessions, 2);
    assert.equal(d10.scheduled_break_minutes, 60, "reported, not deducted");
    assert.equal(d10.open, false);
    const d11 = r.body.days.find((d) => d.work_date === "2026-03-11");
    assert.equal(d11.open, true);
    assert.equal(d11.worked_minutes, 0);
    assert.equal(r.body.timezone, "Africa/Tunis");
    // Validation.
    for (const qs of ["from=2026-03-12&to=2026-03-10", "from=2026-02-30&to=2026-03-01", "from=abc", "from=2025-01-01&to=2026-03-01", "from=2026-03-01&from=2026-03-02"]) {
      assert.equal((await http("GET", `/hr/me/attendance?${qs}`, u.token)).status, 400, qs);
    }
    assert.equal((await http("GET", "/hr/me/attendance?from=2025-03-11&to=2026-03-11", u.token)).status, 200, "366 days inclusive is the limit");
    assert.equal((await http("GET", "/hr/me/attendance?from=2025-03-10&to=2026-03-11", u.token)).status, 400, "367 days");
    const empty = await http("GET", "/hr/me/attendance?from=2026-01-01&to=2026-01-31", other.token);
    assert.deepEqual(empty.body.records, []);
  }));

// ------------------------------------------------------------------------------------------------ corrections: request
const NOW = "2026-03-12T10:00:00Z";
const goodCorrection = (over = {}) => ({ work_date: "2026-03-10", requested_in: "2026-03-10T09:00:00+01:00", requested_out: "2026-03-10T17:00:00+01:00", reason: "Forgot to clock in", ...over });

test("correction request: validation (work_date window, offsets, order, reason, unknown fields) and the cap of 3 pending", () =>
  withWorld(async ({ http, staff, count }) => {
    const u = await staff("Agent");
    const post = (b, now = NOW) => http("POST", "/hr/me/corrections", u.token, b, now);
    const bad = [
      goodCorrection({ work_date: "2026-03-13" }), // future
      goodCorrection({ work_date: "2026-01-10", requested_in: "2026-01-10T09:00:00+01:00", requested_out: "2026-01-10T17:00:00+01:00" }), // 61 days back
      goodCorrection({ work_date: "2026-02-30" }),
      goodCorrection({ work_date: undefined }),
      goodCorrection({ requested_in: "2026-03-10T09:00:00" }), // no offset
      goodCorrection({ requested_in: "yesterday" }),
      goodCorrection({ requested_out: "2026-03-10T17:00:00" }),
      goodCorrection({ requested_in: "2026-03-10T17:00:00+01:00", requested_out: "2026-03-10T09:00:00+01:00" }),
      goodCorrection({ requested_out: "2026-03-10T09:00:00+01:00" }), // out == in
      goodCorrection({ requested_in: "2026-03-09T09:00:00+01:00" }), // in is not on work_date
      goodCorrection({ requested_in: "2026-03-10T09:00:00+01:00", requested_out: "2026-03-11T10:00:00+01:00" }), // > 24 h
      goodCorrection({ requested_in: "2026-03-12T14:00:00+01:00", work_date: "2026-03-12", requested_out: undefined }), // in the future (13:00Z > 10:00Z)
      goodCorrection({ requested_out: undefined }), // missing out is only allowed for today
      goodCorrection({ reason: "" }),
      goodCorrection({ reason: "   " }),
      goodCorrection({ reason: "x".repeat(501) }),
      goodCorrection({ reason: 5 }),
      goodCorrection({ status: "approved" }),
      goodCorrection({ user_id: 1 }),
    ];
    for (const b of bad) {
      const r = await post(b);
      assert.equal(r.status, 400, `${JSON.stringify(b)} -> ${r.status} ${r.text}`);
    }
    assert.equal((await http("POST", "/hr/me/corrections", u.token, [1])).status, 400);
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance_corrections"), 0);
    // Boundaries that are valid: exactly 60 days back, reason of exactly 500, today without an out.
    const edge = await post(goodCorrection({ work_date: "2026-01-11", requested_in: "2026-01-11T09:00:00+01:00", requested_out: "2026-01-11T17:00:00+01:00", reason: "r".repeat(500) }));
    assert.equal(edge.status, 201, edge.text);
    assert.equal(edge.body.status, "pending");
    assert.equal(edge.body.work_date, "2026-01-11");
    const today = await post(goodCorrection({ work_date: "2026-03-12", requested_in: "2026-03-12T08:00:00Z", requested_out: undefined }));
    assert.equal(today.status, 201, today.text);
    assert.equal(today.body.requested_out, null);
    const third = await post(goodCorrection());
    assert.equal(third.status, 201);
    const fourth = await post(goodCorrection({ reason: "again" }));
    assert.equal(fourth.status, 409);
    assert.match(fourth.body.error, /pending/);
    // Cancelling one frees a slot.
    assert.equal((await http("POST", `/hr/me/corrections/${edge.body.id}/cancel`, u.token, {})).status, 200);
    assert.equal((await post(goodCorrection({ reason: "again" }))).status, 201);
    assert.equal((await http("POST", `/hr/me/corrections/${edge.body.id}/cancel`, u.token, {})).status, 409, "already cancelled");
  }));

test("ten concurrent correction requests respect the cap of 3 pending", () =>
  withWorld(async ({ http, staff, count }) => {
    const u = await staff("Agent");
    const rs = await Promise.all(Array.from({ length: 10 }, (_v, i) => http("POST", "/hr/me/corrections", u.token, goodCorrection({ reason: `r${i}` }), NOW)));
    assert.equal(rs.filter((r) => r.status === 201).length, 3, rs.map((r) => r.status).join());
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance_corrections WHERE user_id=$1 AND status='pending'", [u.id]), 3);
  }));

test("cancel and list are own-only: a colleague's correction is a 404, never visible in my list", () =>
  withWorld(async ({ http, staff, T }) => {
    const a = await staff("Agent");
    const b = await staff("Receptionist");
    const c = (await http("POST", "/hr/me/corrections", a.token, goodCorrection(), NOW)).body;
    assert.equal((await http("POST", `/hr/me/corrections/${c.id}/cancel`, b.token, {})).status, 404);
    assert.equal((await http("POST", `/hr/me/corrections/${c.id}/cancel`, T.hr, {})).status, 404, "even HR cancels only their own");
    assert.equal((await http("POST", "/hr/me/corrections/999999/cancel", a.token, {})).status, 404);
    assert.equal((await http("POST", "/hr/me/corrections/abc/cancel", a.token, {})).status, 400);
    assert.deepEqual((await http("GET", "/hr/me/corrections", b.token)).body.rows, []);
    const mine = await http("GET", "/hr/me/corrections?status=pending", a.token);
    assert.equal(mine.body.rows.length, 1);
    assert.equal(mine.body.rows[0].id, c.id);
    assert.equal((await http("GET", "/hr/me/corrections?status=bogus", a.token)).status, 400);
    // The colleague cannot decide it: an Agent has no approval right at all.
    assert.equal((await http("POST", `/hr/corrections/${c.id}/decide`, b.token, { decision: "approved" })).status, 403);
    assert.equal((await http("GET", "/hr/team/corrections", b.token)).status, 403);
    const cancelled = await http("POST", `/hr/me/corrections/${c.id}/cancel`, a.token, {});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
  }));

// ------------------------------------------------------------------------------------------------ corrections: decide
async function makeCorrection(world, user, over = {}) {
  const r = await world.http("POST", "/hr/me/corrections", user.token, goodCorrection(over), NOW);
  assert.equal(r.status, 201, r.text);
  return r.body;
}

test("approving creates exactly one 'correction' attendance record with correction_id, atomically, audited; deciding twice is 409", () =>
  withWorld(async (w) => {
    const { http, T, ids, staff, q, count, one } = w;
    const u = await staff("Agent");
    const c = await makeCorrection(w, u);
    const bad = [{}, { decision: "maybe" }, { decision: "approved", note: "x".repeat(501) }, { decision: "approved", note: 5 }, { decision: "approved", extra: 1 }];
    for (const b of bad) assert.equal((await http("POST", `/hr/corrections/${c.id}/decide`, T.hr, b)).status, 400, JSON.stringify(b));
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance"), 0);
    const r = await http("POST", `/hr/corrections/${c.id}/decide`, T.hr, { decision: "approved", note: "ok" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.correction.status, "approved");
    assert.equal(r.body.correction.decided_by, ids.hr);
    assert.equal(r.body.correction.decision_note, "ok");
    assert.equal(r.body.attendance.source, "correction");
    assert.equal(r.body.attendance.correction_id, c.id);
    const rows = (await q("SELECT user_id, work_date::text AS d, clock_in, clock_out, source, correction_id FROM hr_attendance")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, u.id);
    assert.equal(rows[0].d, "2026-03-10");
    assert.equal(rows[0].clock_in.toISOString(), "2026-03-10T08:00:00.000Z");
    assert.equal(rows[0].clock_out.toISOString(), "2026-03-10T16:00:00.000Z");
    assert.equal(await count("SELECT count(*) AS n FROM audit_logs WHERE table_name='hr_attendance' AND action='CREATE'"), 1);
    assert.equal(await count("SELECT count(*) AS n FROM audit_logs WHERE table_name='hr_attendance_corrections' AND action='UPDATE' AND record_id=$1", [c.id]), 1);
    const again = await http("POST", `/hr/corrections/${c.id}/decide`, T.admin, { decision: "rejected" });
    assert.equal(again.status, 409);
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance"), 1);
    // The requester cannot cancel a decided correction.
    assert.equal((await http("POST", `/hr/me/corrections/${c.id}/cancel`, u.token, {})).status, 409);
    // Rejection writes nothing.
    const c2 = await makeCorrection(w, u, { work_date: "2026-03-09", requested_in: "2026-03-09T09:00:00+01:00", requested_out: "2026-03-09T17:00:00+01:00" });
    const rej = await http("POST", `/hr/corrections/${c2.id}/decide`, T.admin, { decision: "rejected", note: "no evidence" });
    assert.equal(rej.status, 200);
    assert.equal(rej.body.correction.status, "rejected");
    assert.equal(rej.body.attendance, undefined);
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance"), 1);
    assert.equal((await one("SELECT status FROM hr_attendance_corrections WHERE id=$1", [c2.id])).status, "rejected");
    // A cancelled correction cannot be decided.
    const c3 = await makeCorrection(w, u, { work_date: "2026-03-08", requested_in: "2026-03-08T09:00:00+01:00", requested_out: "2026-03-08T17:00:00+01:00" });
    await http("POST", `/hr/me/corrections/${c3.id}/cancel`, u.token, {});
    assert.equal((await http("POST", `/hr/corrections/${c3.id}/decide`, T.hr, { decision: "approved" })).status, 409);
  }));

test("an approval that overlaps existing attendance fails with 409 and writes nothing; the correction stays pending", () =>
  withWorld(async (w) => {
    const { http, T, staff, att, count, one } = w;
    const u = await staff("Agent");
    await att(u.id, "2026-03-10", "2026-03-10T10:00:00Z", "2026-03-10T12:00:00Z");
    const c = await makeCorrection(w, u); // 08:00Z-16:00Z swallows the existing record
    const r = await http("POST", `/hr/corrections/${c.id}/decide`, T.hr, { decision: "approved" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "overlaps existing attendance; ask HR to resolve");
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance WHERE user_id=$1", [u.id]), 1);
    const row = await one("SELECT status, decided_by, decided_at FROM hr_attendance_corrections WHERE id=$1", [c.id]);
    assert.equal(row.status, "pending");
    assert.equal(row.decided_by, null);
    assert.equal(await count("SELECT count(*) AS n FROM audit_logs WHERE (table_name, action) IN (('hr_attendance','CREATE'),('hr_attendance_corrections','UPDATE'))"), 0);
    // Rejecting is still possible, and so is approving a non-overlapping one.
    assert.equal((await http("POST", `/hr/corrections/${c.id}/decide`, T.hr, { decision: "rejected" })).status, 200);
    // An open-ended approved correction on the day of an existing OPEN session corrects that session (review round 1), no second open row.
    await att(u.id, "2026-03-12", "2026-03-12T07:00:00Z", null);
    const open = await http("POST", "/hr/me/corrections", u.token, goodCorrection({ work_date: "2026-03-12", requested_in: "2026-03-12T05:00:00Z", requested_out: undefined }), NOW);
    assert.equal(open.status, 201, open.text);
    const fixed = await http("POST", `/hr/corrections/${open.body.id}/decide`, T.hr, { decision: "approved" });
    assert.equal(fixed.status, 200, fixed.text);
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance WHERE user_id=$1", [u.id]), 2, "the closed record and the corrected open one, nothing new");
    assert.equal((await one("SELECT clock_in, source FROM hr_attendance WHERE user_id=$1 AND clock_out IS NULL", [u.id])).source, "correction");
  }));

test("self-approval is refused (HR, Admin and Manager alike); another approver can decide an HR/Admin request", () =>
  withWorld(async (w) => {
    const { http, T, ids, q, count } = w;
    const own = async (k) => (await http("POST", "/hr/me/corrections", T[k], goodCorrection({ reason: `mine ${k}` }), NOW)).body;
    const hrC = await own("hr");
    const adminC = await own("admin");
    const mgrC = await own("mgr");
    const saC = await own("sa");
    for (const [k, c] of [["hr", hrC], ["admin", adminC], ["mgr", mgrC], ["sa", saC]]) {
      const r = await http("POST", `/hr/corrections/${c.id}/decide`, T[k], { decision: "approved" });
      assert.equal(r.status, 403, `${k} self-approval`);
    }
    // A manager who (wrongly) reports to themselves cannot self-approve via the report line either: the row has no such link.
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance"), 0);
    assert.equal((await http("POST", `/hr/corrections/${hrC.id}/decide`, T.admin, { decision: "approved" })).status, 200, "Admin approves the HR request");
    assert.equal((await http("POST", `/hr/corrections/${adminC.id}/decide`, T.sa, { decision: "rejected" })).status, 200);
    assert.equal((await http("POST", `/hr/corrections/${mgrC.id}/decide`, T.hr, { decision: "approved" })).status, 200, "HR approves a Manager's request");
    assert.equal((await q("SELECT decided_by FROM hr_attendance_corrections WHERE id=$1", [hrC.id])).rows[0].decided_by, ids.admin);
  }));

test("manager scope: direct reports only (decide and list); non-reports are 404; HR/Admin see everyone; filters work", () =>
  withWorld(async (w) => {
    const { http, T, ids, staff, profile } = w;
    const report = await staff("Agent", { name: "Report One" });
    const stranger = await staff("Receptionist", { name: "Stranger" });
    const otherMgrReport = await staff("Agent", { name: "Other Report" });
    await profile(report.id, { manager: ids.mgr });
    await profile(otherMgrReport.id, { manager: ids.hr });
    const cReport = await makeCorrection(w, report);
    const cStranger = await makeCorrection(w, stranger);
    const cOther = await makeCorrection(w, otherMgrReport);
    const mgrList = await http("GET", "/hr/team/corrections", T.mgr);
    assert.equal(mgrList.status, 200);
    assert.deepEqual(mgrList.body.rows.map((r) => r.id), [cReport.id]);
    assert.equal(mgrList.body.rows[0].full_name, "Report One");
    assert.equal(mgrList.body.rows[0].reason, "Forgot to clock in", "approvers see the reason");
    assert.equal(mgrList.body.total, 1);
    const hrList = await http("GET", "/hr/team/corrections", T.hr);
    assert.deepEqual(hrList.body.rows.map((r) => r.id).sort((a, b) => a - b), [cReport.id, cStranger.id, cOther.id].sort((a, b) => a - b));
    assert.equal((await http("GET", "/hr/team/corrections", T.admin)).body.total, 3);
    assert.equal((await http("GET", "/hr/team/corrections?status=approved", T.hr)).body.total, 0);
    assert.equal((await http("GET", "/hr/team/corrections?status=nope", T.hr)).status, 400);
    assert.equal((await http("GET", "/hr/team/corrections?status=pending&limit=1", T.hr)).body.rows.length, 1);
    // Decide: the stranger's and the other manager's report are 404 for this manager, with no side effects.
    assert.equal((await http("POST", `/hr/corrections/${cStranger.id}/decide`, T.mgr, { decision: "approved" })).status, 404);
    assert.equal((await http("POST", `/hr/corrections/${cOther.id}/decide`, T.mgr, { decision: "approved" })).status, 404);
    assert.equal((await w.count("SELECT count(*) AS n FROM hr_attendance")), 0);
    assert.equal((await http("POST", `/hr/corrections/${cReport.id}/decide`, T.mgr, { decision: "approved", note: "fine" })).status, 200);
    assert.equal((await http("GET", "/hr/team/corrections?status=approved", T.mgr)).body.total, 1);
    // A manager who is no longer the manager cannot decide (scope is re-validated at decision time).
    await w.q("UPDATE hr_employees SET manager_user_id=$1 WHERE user_id=$2", [ids.hr, report.id]);
    const c2 = await makeCorrection(w, report, { work_date: "2026-03-09", requested_in: "2026-03-09T09:00:00+01:00", requested_out: "2026-03-09T17:00:00+01:00" });
    assert.equal((await http("POST", `/hr/corrections/${c2.id}/decide`, T.mgr, { decision: "approved" })).status, 404);
  }));

test("two approvers racing on one correction: exactly one 200, one 409, one attendance record", () =>
  withWorld(async (w) => {
    const { http, T, staff, count } = w;
    const u = await staff("Agent");
    const c = await makeCorrection(w, u);
    const rs = await Promise.all([
      http("POST", `/hr/corrections/${c.id}/decide`, T.hr, { decision: "approved" }),
      http("POST", `/hr/corrections/${c.id}/decide`, T.admin, { decision: "approved" }),
      http("POST", `/hr/corrections/${c.id}/decide`, T.sa, { decision: "rejected" }),
    ]);
    const statuses = rs.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 200).length, 1, statuses.join());
    assert.equal(statuses.filter((s) => s === 409).length, 2, statuses.join());
    const approvedWon = rs.some((r) => r.status === 200 && r.body.correction.status === "approved");
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance"), approvedWon ? 1 : 0);
  }));

test("a correction approval racing a clock-in over the same time: exactly one wins, no overlapping records ever exist", () =>
  withWorld(async (w) => {
    const { http, T, staff, q, count } = w;
    for (let i = 0; i < 3; i++) {
      const u = await staff("Agent");
      const c = await makeCorrection(w, u, { requested_in: "2026-03-10T09:00:00+01:00", requested_out: "2026-03-10T11:00:00+01:00" }); // 08:00Z-10:00Z
      const [dec, ci] = await Promise.all([
        http("POST", `/hr/corrections/${c.id}/decide`, T.hr, { decision: "approved" }),
        http("POST", "/hr/clock-in", u.token, undefined, "2026-03-10T09:00:00Z"), // inside the corrected interval
      ]);
      // Clock-in first: its open row is on the corrected day, so the approval corrects it (review round 1) and both succeed.
      // Approval first: the clock-in lands inside the corrected closed interval and is refused. Never two rows.
      const wins = (dec.status === 200 ? 1 : 0) + (ci.status === 201 ? 1 : 0);
      assert.ok(wins >= 1, `decide ${dec.status} ${dec.text} / clock-in ${ci.status} ${ci.text}`);
      assert.ok([200, 409].includes(dec.status) && [201, 409].includes(ci.status));
      assert.equal(await count("SELECT count(*) AS n FROM hr_attendance WHERE user_id=$1", [u.id]), 1);
    }
    const dup = await q(`SELECT 1 FROM hr_attendance a JOIN hr_attendance b ON a.user_id=b.user_id AND a.id<b.id
                          WHERE a.clock_in < COALESCE(b.clock_out,'infinity') AND COALESCE(a.clock_out,'infinity') > b.clock_in`);
    assert.equal(dup.rowCount, 0);
  }));

// ------------------------------------------------------------------------------------------------ is_on_approved_leave
test("hr_is_on_approved_leave: approved requests covering the day only; half-day boundaries are not full leave", () =>
  withWorld(async ({ q, one, staff, http, T }) => {
    const u = await staff("Agent");
    const lt = (await http("POST", "/hr/leave-types", T.hr, { code: "ANN", name_ar: "س", name_en: "Annual", name_fr: "Annuel" })).body;
    const mk = (s, e, status, hs = false, he = false) =>
      q("INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, half_day_start, half_day_end, days, status, decided_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,CASE WHEN $7='pending' THEN NULL ELSE now() END)", [u.id, lt.id, s, e, hs, he, status]);
    await mk("2026-04-01", "2026-04-03", "approved");
    await mk("2026-05-04", "2026-05-06", "approved", true, true);
    await mk("2026-06-01", "2026-06-02", "pending");
    await mk("2026-07-01", "2026-07-02", "rejected");
    const is = async (d, uid = u.id) => (await one("SELECT hr_is_on_approved_leave($1, $2::date) AS v", [uid, d])).v;
    assert.equal(await is("2026-03-31"), false);
    for (const d of ["2026-04-01", "2026-04-02", "2026-04-03"]) assert.equal(await is(d), true, d);
    assert.equal(await is("2026-04-04"), false);
    assert.equal(await is("2026-05-04"), false, "half day at the start");
    assert.equal(await is("2026-05-05"), true);
    assert.equal(await is("2026-05-06"), false, "half day at the end");
    assert.equal(await is("2026-06-01"), false, "pending");
    assert.equal(await is("2026-07-01"), false, "rejected");
    assert.equal(await is("2026-04-02", u.id + 999), false, "someone else");
  }));

// ------------------------------------------------------------------------------------------------ reports
async function reportWorld(w) {
  const { staff, schedule, profile, att, q, http, T } = w;
  const sid = await schedule({ weekly: WEEKDAYS, grace: 10 });
  const mk = async (name, opts = {}) => {
    const u = await staff("Agent", { name });
    if (opts.profile !== false) await profile(u.id, { schedule: sid, ...opts.profile });
    return u;
  };
  const lt = (await http("POST", "/hr/leave-types", T.hr, { code: "ANN", name_ar: "س", name_en: "Annual", name_fr: "Annuel" })).body;
  await q("INSERT INTO hr_holidays (day, name) VALUES ('2026-03-11', 'Test holiday')");
  const U = await mk("Alice Worker");
  // Mon 9th on time (09:00 Tunis = 08:00Z), Tue 10th late by 11 min (09:11), Wed holiday, Thu on leave, Fri absent.
  await att(U.id, "2026-03-09", "2026-03-09T08:00:00Z", "2026-03-09T16:00:00Z");
  await att(U.id, "2026-03-10", "2026-03-10T08:11:00Z", "2026-03-10T12:00:00Z");
  await att(U.id, "2026-03-10", "2026-03-10T13:00:00Z", "2026-03-10T16:00:00Z");
  await q("INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, days, status, decided_at) VALUES ($1,$2,'2026-03-12','2026-03-12',1,'approved',now())", [U.id, lt.id]);
  const V = await mk("Bob Edge");
  await att(V.id, "2026-03-09", "2026-03-09T08:10:00Z", "2026-03-09T16:00:00Z"); // exactly start + grace: not late
  await att(V.id, "2026-03-10", "2026-03-10T08:10:30Z", "2026-03-10T16:00:00Z"); // 30 s past the grace: late
  const W = await mk("Cara Open"); // open session today (16th)
  await att(W.id, "2026-03-16", "2026-03-16T08:00:00Z", null);
  const X = await mk("Dan Stale"); // open session for days
  await att(X.id, "2026-03-13", "2026-03-13T08:00:00Z", null);
  const Y = await mk("Eve Inactive", { profile: { status: "inactive" } });
  const Z = await mk("Finn Later", { profile: { hire: "2026-03-14" } });
  const N = await mk("Gus NoSchedule", { profile: false });
  await att(N.id, "2026-03-09", "2026-03-09T10:00:00Z", "2026-03-09T11:00:00Z");
  return { sid, U, V, W, X, Y, Z, N, lt };
}
const REPORT_NOW = "2026-03-16T10:00:00Z"; // Monday the 16th, 11:00 in Tunis

test("report math: late (schedule start + grace in company tz), absent (not holiday/leave, before today), open sessions, worked minutes", () =>
  withWorld(async (w) => {
    const { http, T } = w;
    const { U, V, W, X, Y, Z, N } = await reportWorld(w);
    const r = await http("GET", "/hr/reports/attendance?from=2026-03-09&to=2026-03-16", T.hr, undefined, REPORT_NOW);
    assert.equal(r.status, 200, r.text);
    const row = (u, d) => r.body.rows.find((x) => x.user_id === u.id && x.day === d);
    // Alice
    assert.deepEqual([row(U, "2026-03-09").worked_minutes, row(U, "2026-03-09").late, row(U, "2026-03-09").absent], [480, false, false]);
    assert.equal(row(U, "2026-03-09").first_in, "2026-03-09T08:00:00Z");
    assert.equal(row(U, "2026-03-09").last_out, "2026-03-09T16:00:00Z");
    assert.equal(row(U, "2026-03-09").first_in_local, "09:00");
    assert.deepEqual([row(U, "2026-03-10").worked_minutes, row(U, "2026-03-10").late, row(U, "2026-03-10").late_minutes, row(U, "2026-03-10").sessions], [409 + 0, true, 11, 2]);
    assert.equal(row(U, "2026-03-11").holiday, true);
    assert.equal(row(U, "2026-03-11").absent, false);
    assert.equal(row(U, "2026-03-12").on_leave, true);
    assert.equal(row(U, "2026-03-12").absent, false);
    assert.equal(row(U, "2026-03-13").absent, true, "Friday: scheduled, nothing, not holiday/leave, before today");
    assert.equal(row(U, "2026-03-14"), undefined, "Saturday is not scheduled and has no attendance");
    assert.equal(row(U, "2026-03-16").absent, false, "today is never absent yet");
    assert.equal(row(U, "2026-03-16").scheduled, true);
    // Bob: the grace limit is inclusive, one past it is late.
    assert.equal(row(V, "2026-03-09").late, false);
    assert.equal(row(V, "2026-03-10").late, true);
    // Open sessions.
    assert.equal(row(W, "2026-03-16").open_session, true);
    assert.equal(row(W, "2026-03-16").needs_correction, false);
    assert.equal(row(X, "2026-03-13").open_session, true);
    assert.equal(row(X, "2026-03-13").needs_correction, true, "open for > 16 h");
    assert.equal(row(X, "2026-03-13").absent, false, "attendance exists");
    // No expectation for an inactive profile, a not-yet-hired employee or someone without a schedule.
    assert.ok(!r.body.rows.some((x) => x.user_id === Y.id && x.absent));
    assert.ok(!r.body.rows.some((x) => x.user_id === Z.id && x.absent));
    assert.ok(!r.body.rows.some((x) => x.user_id === N.id && (x.absent || x.late || x.scheduled)));
    assert.equal(row(N, "2026-03-09").worked_minutes, 60);
    // Summary totals are consistent with the rows.
    const sumOf = (f) => r.body.rows.filter(f).length;
    assert.equal(r.body.summary.absent_days, sumOf((x) => x.absent));
    assert.equal(r.body.summary.late_days, sumOf((x) => x.late));
    assert.equal(r.body.summary.open_sessions, sumOf((x) => x.open_session));
    assert.equal(r.body.summary.needs_correction, 1);
    assert.equal(r.body.summary.worked_minutes, r.body.rows.reduce((a, x) => a + x.worked_minutes, 0));
    assert.equal(r.body.timezone, "Africa/Tunis");
    // Single-user filter and validation.
    const one = await http("GET", `/hr/reports/attendance?from=2026-03-09&to=2026-03-10&user_id=${U.id}`, T.hr, undefined, REPORT_NOW);
    assert.deepEqual([...new Set(one.body.rows.map((x) => x.user_id))], [U.id]);
    assert.equal(one.body.summary.worked_minutes, 480 + 409);
    for (const qs of ["from=2026-03-10&to=2026-03-09", "from=x", "user_id=abc", "from=2024-01-01&to=2026-03-01", "user_id=999999&from=2026-03-09&to=2026-03-10"]) {
      const st = (await http("GET", `/hr/reports/attendance?${qs}`, T.hr, undefined, REPORT_NOW)).status;
      assert.ok(st === 400 || st === 404, `${qs} -> ${st}`);
    }
    assert.equal((await http("GET", "/hr/reports/attendance?user_id=999999&from=2026-03-09&to=2026-03-10", T.hr, undefined, REPORT_NOW)).status, 404);
  }));

test("report never leaks leave reasons or correction reasons; a schedule in another timezone shifts the late threshold", () =>
  withWorld(async (w) => {
    const { http, T, staff, schedule, profile, att, q } = w;
    const lt = (await http("POST", "/hr/leave-types", T.hr, { code: "ANN", name_ar: "س", name_en: "Annual", name_fr: "Annuel" })).body;
    const paris = await schedule({ tz: "Europe/Paris", weekly: WEEKDAYS, grace: 0 });
    const u = await staff("Agent");
    await profile(u.id, { schedule: paris });
    await q("INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, days, reason, status, decided_at) VALUES ($1,$2,'2026-03-12','2026-03-12',1,'SECRET-LEAVE-REASON','approved',now())", [u.id, lt.id]);
    await w.http("POST", "/hr/me/corrections", u.token, goodCorrection({ reason: "SECRET-CORRECTION-REASON" }), NOW);
    await att(u.id, "2026-03-09", "2026-03-09T08:00:00Z", "2026-03-09T16:00:00Z"); // 09:00 Paris (+1): on time with grace 0
    await att(u.id, "2026-03-10", "2026-03-10T08:01:00Z", "2026-03-10T16:00:00Z"); // 09:01: late
    const r = await http("GET", "/hr/reports/attendance?from=2026-03-09&to=2026-03-12", T.hr, undefined, REPORT_NOW);
    assert.ok(!r.text.includes("SECRET-"), "no reasons in the report");
    const row = (d) => r.body.rows.find((x) => x.user_id === u.id && x.day === d);
    assert.equal(row("2026-03-09").late, false);
    assert.equal(row("2026-03-10").late, true);
    const csv = await http("GET", "/hr/export/attendance.csv?from=2026-03-09&to=2026-03-12", T.hr, undefined, REPORT_NOW);
    assert.ok(!csv.text.includes("SECRET-"));
  }));

test("CSV export: BOM, quoted cells, formula injection neutralised, hr:read only, audited, row cap header", () =>
  withWorld(async (w) => {
    const { http, T, staff, profile, schedule, att, count } = w;
    const sid = await schedule({ weekly: WEEKDAYS });
    const evil = await staff("Agent", { name: '=HYPERLINK("http://evil.invalid","x")' });
    const plus = await staff("Agent", { name: "+1+1" });
    const at = await staff("Agent", { name: "@SUM(A1)" });
    const dash = await staff("Agent", { name: "-2+3" });
    const tab = await staff("Agent", { name: "\tTabbed" });
    const fw = await staff("Agent", { name: "＝fullwidth" });
    for (const u of [evil, plus, at, dash, tab, fw]) {
      await profile(u.id, { schedule: sid });
      await att(u.id, "2026-03-09", "2026-03-09T08:00:00Z", "2026-03-09T16:00:00Z");
    }
    const r = await http("GET", "/hr/export/attendance.csv?from=2026-03-09&to=2026-03-09", T.hr, undefined, REPORT_NOW);
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get("content-type"), /^text\/csv/);
    assert.match(r.headers.get("content-disposition"), /attachment; filename="attendance-2026-03-09_2026-03-09\.csv"/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-row-limit-hit"), null);
    assert.ok(r.text.startsWith("﻿\"day\","), "BOM then quoted header");
    assert.ok(r.text.includes(`"'=HYPERLINK(""http://evil.invalid"",""x"")"`), r.text);
    for (const v of ["'+1+1", "'@SUM(A1)", "'-2+3", "'\tTabbed", "'＝fullwidth"]) assert.ok(r.text.includes(`"${v}"`), v);
    for (const line of r.text.slice(1).split("\r\n").filter(Boolean)) assert.ok(/^"/.test(line));
    assert.equal(await count("SELECT count(*) AS n FROM audit_logs WHERE table_name='hr_attendance' AND action='EXPORT'"), 1);
    // Row cap.
    process.env.HR_EXPORT_MAX_ROWS = "2";
    try {
      const capped = await http("GET", "/hr/export/attendance.csv?from=2026-03-09&to=2026-03-09", T.hr, undefined, REPORT_NOW);
      assert.equal(capped.headers.get("x-row-limit-hit"), "true");
      assert.equal(capped.text.slice(1).split("\r\n").filter(Boolean).length, 3, "header + 2 rows");
    } finally {
      delete process.env.HR_EXPORT_MAX_ROWS;
    }
    assert.equal((await http("GET", "/hr/export/attendance.csv?from=2026-03-10&to=2026-03-09", T.hr)).status, 400);
    for (const k of ["mgr", "acct", "agent", "rec", "cand", "emp", "agy"]) assert.equal((await http("GET", "/hr/export/attendance.csv", T[k])).status, 403, k);
  }));

test("the report refuses ranges that would be unbounded (too many person-days)", () =>
  withWorld(async ({ http, T, staff, q }) => {
    // 366 days is accepted for a single person; the person-day budget protects the all-staff report.
    const u = await staff("Agent");
    assert.equal((await http("GET", `/hr/reports/attendance?from=2025-03-11&to=2026-03-11&user_id=${u.id}`, T.hr)).status, 200);
    assert.equal((await http("GET", `/hr/reports/attendance?from=2025-03-10&to=2026-03-11&user_id=${u.id}`, T.hr)).status, 400, "367 days");
    await q("INSERT INTO users (full_name,email,password,role) SELECT 'Bulk '||g, 'bulk'||g||'@att.test.invalid','x','Agent' FROM generate_series(1,200) g");
    const r = await http("GET", "/hr/reports/attendance?from=2025-03-11&to=2026-03-11", T.hr);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /narrow/i);
  }));

// ------------------------------------------------------------------------------------------------ review round 1: forgotten clock-out
test("forgotten clock-out: Monday clock-in, Tuesday clock-out is 409, the approved correction fixes the open row, clock-in works again", () =>
  withWorld(async (w) => {
    const { http, T, staff, q, count, one } = w;
    const u = await staff("Agent");
    const mon = "2026-03-09T08:00:00Z";
    const tue = "2026-03-10T10:00:00Z";
    const inn = await http("POST", "/hr/clock-in", u.token, undefined, mon);
    assert.equal(inn.status, 201);
    const out = await http("POST", "/hr/clock-out", u.token, undefined, tue);
    assert.equal(out.status, 409);
    assert.equal(out.body.needs_correction, true);
    assert.equal((await http("POST", "/hr/clock-in", u.token, undefined, tue)).status, 409, "locked out until fixed");
    const c = await http("POST", "/hr/me/corrections", u.token, goodCorrection({ work_date: "2026-03-09", requested_in: "2026-03-09T09:00:00+01:00", requested_out: "2026-03-09T17:00:00+01:00" }), tue);
    assert.equal(c.status, 201, c.text);
    const dec = await http("POST", `/hr/corrections/${c.body.id}/decide`, T.hr, { decision: "approved", note: "forgot" }, tue);
    assert.equal(dec.status, 200, dec.text);
    assert.equal(dec.body.attendance.id, inn.body.record.id, "the open row itself was corrected");
    assert.equal(dec.body.attendance.source, "correction");
    assert.equal(dec.body.attendance.correction_id, c.body.id);
    const rows = (await q("SELECT id, clock_in, clock_out, source, correction_id FROM hr_attendance WHERE user_id=$1", [u.id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].clock_out.toISOString(), "2026-03-09T16:00:00.000Z");
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance WHERE user_id=$1 AND clock_out IS NULL", [u.id]), 0);
    assert.equal(await count("SELECT count(*) AS n FROM audit_logs WHERE table_name='hr_attendance' AND action='UPDATE' AND record_id=$1", [inn.body.record.id]), 1, "audited");
    const again = await http("POST", "/hr/clock-in", u.token, undefined, "2026-03-10T10:05:00Z");
    assert.equal(again.status, 201, again.text);
    assert.equal((await one("SELECT count(*) AS n FROM hr_attendance WHERE user_id=$1", [u.id])).n, "2");
  }));

test("a correction overlapping a CLOSED record is still 409; one overlapping an open row of another day does not touch it", () =>
  withWorld(async (w) => {
    const { http, T, staff, att, count } = w;
    const u = await staff("Agent");
    await att(u.id, "2026-03-10", "2026-03-10T10:00:00Z", "2026-03-10T12:00:00Z");
    const c = await w.http("POST", "/hr/me/corrections", u.token, goodCorrection(), NOW);
    assert.equal((await http("POST", `/hr/corrections/${c.body.id}/decide`, T.hr, { decision: "approved" })).status, 409);
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance WHERE user_id=$1", [u.id]), 1);
  }));

test("HR close of a stale open session: hr:write only, open records only, clock_out within (clock_in, clock_in+24h] and not in the future, audited", () =>
  withWorld(async (w) => {
    const { http, T, staff, att, q, count } = w;
    const u = await staff("Agent");
    const id = await att(u.id, "2026-03-09", "2026-03-09T08:00:00Z", null);
    const closedId = await att(u.id, "2026-03-05", "2026-03-05T08:00:00Z", "2026-03-05T16:00:00Z");
    const now = "2026-03-10T10:00:00Z";
    const body = { clock_out: "2026-03-09T17:00:00+01:00", note: "Employee confirmed 17:00" };
    for (const k of ["mgr", "acct", "agent", "rec"]) assert.equal((await http("POST", `/hr/attendance/${id}/close`, T[k], body, now)).status, 403, k);
    for (const k of ["cand", "emp", "agy"]) assert.equal((await http("POST", `/hr/attendance/${id}/close`, T[k], body, now)).status, 403, k);
    assert.equal((await http("POST", `/hr/attendance/${id}/close`, undefined, body, now)).status, 401);
    const bad = [{}, { clock_out: "2026-03-09T17:00:00" }, { clock_out: "nope" }, { ...body, extra: 1 }, { ...body, note: "x".repeat(501) }, { ...body, note: 5 },
      { clock_out: "2026-03-09T08:00:00Z" }, { clock_out: "2026-03-09T07:00:00Z" }, { clock_out: "2026-03-10T08:00:01Z" }, { clock_out: "2026-03-10T10:00:01Z" }];
    for (const b of bad) assert.equal((await http("POST", `/hr/attendance/${id}/close`, T.hr, b, now)).status, 400, JSON.stringify(b));
    assert.equal((await http("POST", `/hr/attendance/${closedId}/close`, T.hr, body, now)).status, 409, "closed record");
    assert.equal((await http("POST", "/hr/attendance/999999/close", T.hr, body, now)).status, 404);
    assert.equal((await http("POST", "/hr/attendance/abc/close", T.hr, body, now)).status, 400);
    assert.equal(await count("SELECT count(*) AS n FROM hr_attendance WHERE clock_out IS NULL"), 1, "nothing changed by the refusals");
    const ok = await http("POST", `/hr/attendance/${id}/close`, T.admin, body, now);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(new Date(ok.body.clock_out).toISOString(), "2026-03-09T16:00:00.000Z");
    assert.equal(ok.body.worked_minutes, 480);
    assert.equal(ok.body.note, "Employee confirmed 17:00");
    assert.equal(await count("SELECT count(*) AS n FROM audit_logs WHERE table_name='hr_attendance' AND record_id=$1 AND user_id=$2 AND action='UPDATE'", [id, w.ids.admin]), 1);
    assert.equal((await http("POST", `/hr/attendance/${id}/close`, T.hr, body, now)).status, 409, "already closed");
    assert.equal((await http("POST", "/hr/clock-in", u.token, undefined, now)).status, 201, "the employee can clock in again");
    // exactly 24 h is allowed
    const v = await staff("Agent");
    const vid = await att(v.id, "2026-03-09", "2026-03-09T08:00:00Z", null);
    assert.equal((await http("POST", `/hr/attendance/${vid}/close`, T.hr, { clock_out: "2026-03-10T08:00:00Z" }, now)).status, 200);
  }));

test("GET /hr/attendance/open lists open sessions older than HR_MAX_OPEN_HOURS with names, hr:read only", () =>
  withWorld(async (w) => {
    const { http, T, staff, att } = w;
    const old = await staff("Agent", { name: "Old Session" });
    const fresh = await staff("Agent", { name: "Fresh Session" });
    const id = await att(old.id, "2026-03-09", "2026-03-09T08:00:00Z", null);
    await att(fresh.id, "2026-03-10", "2026-03-10T08:00:00Z", null);
    const now = "2026-03-10T10:00:00Z";
    for (const k of ["mgr", "acct", "agent", "rec", "cand", "emp", "agy"]) assert.equal((await http("GET", "/hr/attendance/open", T[k], undefined, now)).status, 403, k);
    assert.equal((await http("GET", "/hr/attendance/open", undefined, undefined, now)).status, 401);
    for (const k of ["sa", "admin", "hr"]) {
      const r = await http("GET", "/hr/attendance/open", T[k], undefined, now);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.rows.map((x) => [x.id, x.full_name, x.user_id]), [[id, "Old Session", old.id]]);
      assert.equal(r.body.rows[0].open_hours, 26);
      assert.equal(r.body.rows[0].work_date, "2026-03-09");
    }
  }));

test("correction audit rows mask the reason and the decision note ('[private]')", () =>
  withWorld(async (w) => {
    const { http, T, staff, q } = w;
    const u = await staff("Agent");
    const r = await http("POST", "/hr/me/corrections", u.token, goodCorrection({ reason: "SENTINEL-COR-REASON" }), NOW);
    assert.equal(r.status, 201);
    assert.equal((await http("POST", `/hr/me/corrections/${r.body.id}/cancel`, u.token, {})).status, 200);
    const r2 = await http("POST", "/hr/me/corrections", u.token, goodCorrection({ reason: "SENTINEL-COR-REASON" }), NOW);
    assert.equal((await http("POST", `/hr/corrections/${r2.body.id}/decide`, T.hr, { decision: "rejected", note: "SENTINEL-COR-NOTE" })).status, 200);
    const rows = (await q("SELECT old_data, new_data FROM audit_logs WHERE table_name='hr_attendance_corrections'")).rows;
    assert.ok(rows.length >= 4);
    const dump = JSON.stringify(rows);
    assert.equal(dump.includes("SENTINEL-COR-REASON"), false, "reason leaked into audit");
    assert.equal(dump.includes("SENTINEL-COR-NOTE"), false, "decision note leaked into audit");
    assert.ok(dump.includes("[private]"));
    // the real data is intact
    assert.equal((await q("SELECT reason, decision_note FROM hr_attendance_corrections WHERE id=$1", [r2.body.id])).rows[0].decision_note, "SENTINEL-COR-NOTE");
  }));
