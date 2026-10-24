// Stage 5, Task 4: leave requests, approvals, balances, team calendar and leave report (real Postgres, injected clock).
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "hr-leave-test-secret";
delete process.env.HR_TIMEZONE;

const NOW = "2026-03-02T09:00:00Z"; // a Monday
const SECRET = "SENTINEL-REASON-7f3a";
const NOTE = "SENTINEL-NOTE-91bc";

async function withWorld(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = (sql, p) => pool.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  const http = async (method, url, token, body, now = NOW) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(now ? { "x-test-now": now } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text };
  };
  const roles = { sa: "SuperAdmin", admin: "Admin", acct: "Accountant", mgr: "Manager", agent: "Agent", rec: "Receptionist", hr: "HR", cand: "Candidate" };
  const ids = {};
  const T = {};
  for (const [k, role] of Object.entries(roles)) {
    ids[k] = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`${role} ${k}`, `${k}@lv.test.invalid`, role])).id;
    T[k] = jwt.sign({ id: ids[k], role, ...(k === "cand" ? { tv: 0 } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" });
  }
  T.emp = (await createEmployerUser(pool)).token;
  T.agy = (await createAgencyUser(pool)).token;
  let n = 0;
  const staff = async (role = "Agent", over = {}) => {
    n += 1;
    const id = (await one("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x',$3,$4) RETURNING id", [over.name || `Extra ${n}`, `extra${n}@lv.test.invalid`, role, over.active ?? true])).id;
    return { id, token: jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
  };
  const schedule = async (weekly) => (await one("INSERT INTO hr_schedules (name, weekly) VALUES ($1,$2::jsonb) RETURNING id", [`Sched ${++n}`, JSON.stringify(weekly)])).id;
  const profile = (userId, o = {}) => q("INSERT INTO hr_employees (user_id, manager_user_id, schedule_id, department) VALUES ($1,$2,$3,$4)", [userId, o.manager ?? null, o.schedule ?? null, o.dept ?? null]);
  const type = async (o = {}) =>
    (await one("INSERT INTO hr_leave_types (code, name_ar, name_en, name_fr, counts_against_balance, requires_approval, active) VALUES ($1,'ع',$2,'fr',$3,$4,$5) RETURNING id, name_en", [
      `LT${++n}`, o.name || `Leave ${n}`, o.counts ?? false, o.approval ?? true, o.active ?? true,
    ]));
  const balance = (userId, typeId, year, entitled, adjusted = 0) =>
    q("INSERT INTO hr_leave_balances (user_id, leave_type_id, year, entitled_days, adjusted_days) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, leave_type_id, year) DO UPDATE SET entitled_days=$4, adjusted_days=$5", [userId, typeId, year, entitled, adjusted]);
  const holiday = (day) => q("INSERT INTO hr_holidays (day, name) VALUES ($1::date,'Holiday')", [day]);
  const request = (token, typeId, start, end, extra = {}, now = NOW) => http("POST", "/hr/me/leave-requests", token, { leave_type_id: typeId, start_date: start, end_date: end, ...extra }, now);
  const sql = (userId, typeId, s, e, days, status = "pending", reason = null) =>
    one("INSERT INTO hr_leave_requests (user_id,leave_type_id,start_date,end_date,days,reason,status,decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7='pending' THEN NULL ELSE now() END) RETURNING id", [userId, typeId, s, e, days, reason, status]);
  try {
    await fn({ pool, http, q, one, T, ids, staff, schedule, profile, type, balance, holiday, request, sql });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}
const ADMINS = ["sa", "admin", "hr"];
const OUTSIDERS = ["cand", "emp", "agy"];
const ALL_STAFF = ["sa", "admin", "hr", "mgr", "acct", "agent", "rec"];

// ------------------------------------------------------------------------------------------------ day counting
test("day counting: weekends, holidays, half days, default schedule, custom schedules", () =>
  withWorld(async ({ staff, schedule, profile, type, holiday, request }) => {
    const lt = (await type()).id;
    const days = async (s, e, extra, who) => {
      const u = who || (await staff("Agent"));
      const r = await request(u.token, lt, s, e, extra);
      return { status: r.status, days: r.body && r.body.days, body: r.body };
    };
    let r = await days("2026-03-09", "2026-03-13");
    assert.deepEqual([r.status, r.days, r.body.days_note], [201, "5.00", "default schedule"], "Mon-Fri, no profile");
    assert.equal((await days("2026-03-13", "2026-03-17")).days, "3.00", "Fri-Tue across a weekend");
    assert.equal((await days("2026-03-14", "2026-03-16")).days, "1.00", "Sat-Mon counts Monday only");
    assert.equal((await days("2026-03-09", "2026-03-13", { half_day_start: true })).days, "4.50");
    assert.equal((await days("2026-03-09", "2026-03-13", { half_day_end: true })).days, "4.50");
    assert.equal((await days("2026-03-09", "2026-03-13", { half_day_start: true, half_day_end: true })).days, "4.00");
    assert.equal((await days("2026-03-09", "2026-03-09", { half_day_start: true })).days, "0.50", "a single half day");
    r = await days("2026-03-09", "2026-03-09", { half_day_start: true, half_day_end: true });
    assert.equal(r.status, 400, "both flags on one day is ambiguous");
    // Sunday only, Saturday-Sunday: nothing to take
    for (const [s, e] of [["2026-03-15", "2026-03-15"], ["2026-03-14", "2026-03-15"]]) {
      r = await days(s, e);
      assert.equal(r.status, 400);
      assert.match(r.body.error, /no working days in range/);
    }
    // half-day flags on non-working days are refused (Sat start, Sun end)
    assert.equal((await days("2026-03-14", "2026-03-16", { half_day_start: true })).status, 400);
    assert.equal((await days("2026-03-16", "2026-03-22", { half_day_end: true })).status, 400);
    // a holiday inside the range is not counted; a flag on a holiday is refused; a range of holidays only is 400
    await holiday("2026-03-11");
    await holiday("2026-04-06");
    await holiday("2026-04-07");
    assert.equal((await days("2026-03-09", "2026-03-13")).days, "4.00");
    assert.equal((await days("2026-03-11", "2026-03-13", { half_day_start: true })).status, 400);
    assert.equal((await days("2026-04-06", "2026-04-07")).status, 400);
    assert.equal((await days("2026-04-06", "2026-04-08")).days, "1.00");
    // custom schedule with Saturday working, Wednesday off
    const six = await staff("Agent");
    await profile(six.id, { schedule: await schedule({ mon: { start: "09:00", end: "17:00" }, tue: { start: "09:00", end: "17:00" }, thu: { start: "09:00", end: "17:00" }, fri: { start: "09:00", end: "17:00" }, sat: { start: "09:00", end: "13:00" }, wed: null }) });
    r = await days("2026-05-04", "2026-05-09", undefined, six);
    assert.deepEqual([r.status, r.days, r.body.days_note], [201, "5.00", undefined], "Mon,Tue,Thu,Fri,Sat (Wed off); configured schedule has no default note");
    const sat = await staff("Agent");
    await profile(sat.id, { schedule: await schedule({ sat: { start: "09:00", end: "13:00" } }) });
    assert.equal((await days("2026-03-14", "2026-03-14", undefined, sat)).days, "1.00", "Saturday-only schedule");
    assert.equal((await days("2026-03-16", "2026-03-20", undefined, sat)).status, 400, "that employee does not work Mon-Fri");
    // a profile without a schedule, and a schedule with no working day at all, both use the default Mon-Fri
    const noSched = await staff("Agent");
    await profile(noSched.id);
    assert.equal((await days("2026-05-18", "2026-05-22", undefined, noSched)).days, "5.00");
    const empty = await staff("Agent");
    await profile(empty.id, { schedule: await schedule({}) });
    r = await days("2026-05-18", "2026-05-22", undefined, empty);
    assert.deepEqual([r.days, r.body.days_note], ["5.00", "default schedule"]);
  }));

test("request validation", () =>
  withWorld(async ({ http, T, staff, type, request, q, count }) => {
    const u = await staff("Agent");
    const lt = (await type()).id;
    const off = (await type({ active: false })).id;
    const ok = await request(u.token, lt, "2026-03-09", "2026-03-09", { reason: "  family  " });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.reason, "family");
    assert.equal(ok.body.status, "pending");
    assert.equal(ok.body.decided_by, null);
    const bad = async (body, label) => assert.equal((await http("POST", "/hr/me/leave-requests", u.token, body)).status, 400, label || JSON.stringify(body));
    const base = { leave_type_id: lt, start_date: "2026-06-01", end_date: "2026-06-02" };
    await bad({ ...base, leave_type_id: off }, "inactive type");
    await bad({ ...base, leave_type_id: 999999 }, "unknown type");
    await bad({ ...base, leave_type_id: "x" });
    await bad({ ...base, leave_type_id: undefined });
    await bad({ ...base, start_date: undefined });
    await bad({ ...base, end_date: "2026-05-31" }, "end before start");
    await bad({ ...base, start_date: "2026-02-30" });
    await bad({ ...base, start_date: "2026-6-1" });
    await bad({ ...base, start_date: "2025-02-25", end_date: "2025-02-26" }, "more than 366 days in the past");
    await bad({ ...base, start_date: "2026-06-01", end_date: "2027-06-02" }, "span of 367 days");
    await bad({ ...base, reason: "x".repeat(501) });
    await bad({ ...base, reason: 5 });
    await bad({ ...base, half_day_start: "yes" });
    await bad({ ...base, days: 3 }, "days cannot be supplied");
    await bad({ ...base, status: "approved" }, "status cannot be supplied");
    await bad({ ...base, user_id: 1 }, "user_id cannot be supplied");
    assert.equal((await http("POST", "/hr/me/leave-requests", u.token, [1])).status, 400);
    assert.equal((await request(u.token, lt, "2025-03-02", "2025-03-03")).status, 201, "exactly 365 days back is still allowed");
    assert.equal((await request(u.token, lt, "2026-06-01", "2026-06-02", { reason: "x".repeat(500) })).status, 201, "500 characters is the limit");
    assert.equal(await count_(q, u.id), 3);
  }));
const count_ = async (q, uid) => Number((await q("SELECT count(*) AS n FROM hr_leave_requests WHERE user_id=$1", [uid])).rows[0].n);

// ------------------------------------------------------------------------------------------------ balances
test("balance: exhaustion, no balance row, non-counting types, cancelling frees days", () =>
  withWorld(async ({ http, T, staff, type, balance, request }) => {
    const u = await staff("Agent");
    const counted = (await type({ counts: true })).id;
    const free = (await type({ counts: false })).id;
    assert.equal((await request(u.token, counted, "2026-03-09", "2026-03-09")).status, 409, "no balance row = 0 days");
    await balance(u.id, counted, 2026, 5, 0);
    const a = await request(u.token, counted, "2026-03-09", "2026-03-13");
    assert.equal(a.status, 201);
    assert.equal((await request(u.token, counted, "2026-03-16", "2026-03-16")).status, 409, "5 of 5 reserved by the pending request");
    assert.equal((await request(u.token, free, "2026-03-16", "2026-03-20")).status, 201, "a type that does not count against the balance is unlimited");
    // adjusted days count, a half day fits in half a day
    await balance(u.id, counted, 2026, 5, 1.5);
    assert.equal((await request(u.token, counted, "2026-03-23", "2026-03-23")).status, 201);
    assert.equal((await request(u.token, counted, "2026-03-24", "2026-03-24", { half_day_start: true })).status, 201, "0.5 left");
    assert.equal((await request(u.token, counted, "2026-03-25", "2026-03-25", { half_day_start: true })).status, 409);
    // cancelling the big request frees 5 days
    assert.equal((await http("POST", `/hr/me/leave-requests/${a.body.id}/cancel`, u.token, {})).status, 200);
    assert.equal((await request(u.token, counted, "2026-03-25", "2026-03-27")).status, 201);
    const mine = (await http("GET", "/hr/me", u.token)).body;
    assert.ok(Array.isArray(mine.balances));
  }));

test("balance: a range crossing New Year is checked and attributed per year", () =>
  withWorld(async ({ http, T, ids, staff, type, balance, request, one }) => {
    const u = await staff("Agent");
    const lt = (await type({ counts: true })).id;
    const now = "2026-12-01T09:00:00Z";
    await balance(u.id, lt, 2026, 2);
    await balance(u.id, lt, 2027, 10);
    // Wed 30 Dec 2026 .. Tue 5 Jan 2027 = 2 days in 2026 (Wed, Thu) + 3 days in 2027 (Fri 1, Mon 4, Tue 5)
    await balance(u.id, lt, 2026, 1);
    let r = await request(u.token, lt, "2026-12-30", "2027-01-05", {}, now);
    assert.equal(r.status, 409, "2 days in 2026 but only 1 entitled");
    assert.match(r.body.error, /2026/);
    await balance(u.id, lt, 2026, 2);
    await balance(u.id, lt, 2027, 2);
    r = await request(u.token, lt, "2026-12-30", "2027-01-05", {}, now);
    assert.equal(r.status, 409, "3 days in 2027 but only 2 entitled");
    assert.match(r.body.error, /2027/);
    await balance(u.id, lt, 2027, 10);
    r = await request(u.token, lt, "2026-12-30", "2027-01-05", {}, now);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.days, "5.00");
    const bal = async (year) => (await http("GET", `/hr/balances?user_id=${u.id}&year=${year}`, T.hr)).body.rows[0];
    assert.deepEqual([(await bal(2026)).pending_days, (await bal(2026)).used_days, (await bal(2026)).available_days], ["2.00", "0.00", "0.00"]);
    assert.deepEqual([(await bal(2027)).pending_days, (await bal(2027)).used_days, (await bal(2027)).available_days], ["3.00", "0.00", "7.00"]);
    assert.equal((await http("POST", `/hr/leave-requests/${r.body.id}/decide`, T.hr, { decision: "approved" })).status, 200);
    assert.deepEqual([(await bal(2026)).pending_days, (await bal(2026)).used_days, (await bal(2026)).remaining_days], ["0.00", "2.00", "0.00"]);
    assert.deepEqual([(await bal(2027)).pending_days, (await bal(2027)).used_days, (await bal(2027)).remaining_days], ["0.00", "3.00", "7.00"]);
    // another request in 2027 only: 7 left
    assert.equal((await request(u.token, lt, "2027-01-11", "2027-01-19", {}, now)).status, 201, "7 working days left, exactly");
    assert.equal((await request(u.token, lt, "2027-01-20", "2027-01-20", {}, now)).status, 409);
    // half-day on the start with the flag in the first year
    const v = await staff("Agent");
    await balance(v.id, lt, 2026, 1.5);
    await balance(v.id, lt, 2027, 1);
    r = await request(v.token, lt, "2026-12-30", "2027-01-01", { half_day_start: true }, now);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.days, "2.50");
    // GET /hr/me exposes used and pending days
    const me = (await http("GET", "/hr/me", u.token, undefined, now)).body;
    assert.ok(me.balances.every((b) => "used_days" in b && "pending_days" in b));
  }));

test("/hr/me balances and /hr/balances report real used and pending days", () =>
  withWorld(async ({ http, T, staff, type, balance, request, q }) => {
    const u = await staff("Agent");
    const lt = (await type({ counts: true })).id;
    const year = (await q("SELECT extract(year FROM now() AT TIME ZONE 'Africa/Tunis')::int AS y")).rows[0].y;
    await balance(u.id, lt, year, 10, 2);
    const now = `${year}-03-02T09:00:00Z`;
    const a = await request(u.token, lt, `${year}-03-09`, `${year}-03-10`, {}, now);
    assert.equal(a.status, 201, a.text);
    await request(u.token, lt, `${year}-04-13`, `${year}-04-13`, {}, now);
    await http("POST", `/hr/leave-requests/${a.body.id}/decide`, T.hr, { decision: "approved" });
    const me = (await http("GET", "/hr/me", u.token)).body.balances[0];
    assert.deepEqual([me.entitled_days, me.adjusted_days, me.used_days, me.pending_days, me.remaining_days, me.available_days], ["10.00", "2.00", "2.00", "1.00", "10.00", "9.00"]);
    const adm = (await http("GET", `/hr/balances?user_id=${u.id}&year=${year}`, T.hr)).body.rows[0];
    assert.deepEqual([adm.used_days, adm.pending_days, adm.remaining_days], ["2.00", "1.00", "10.00"]);
  }));

// ------------------------------------------------------------------------------------------------ overlap
test("overlap: pending/approved block, cancelled/rejected do not, concurrent identical requests give one 201 and one 409", () =>
  withWorld(async ({ http, T, staff, type, request, count, q }) => {
    const u = await staff("Agent");
    const lt = (await type()).id;
    const a = await request(u.token, lt, "2026-03-09", "2026-03-13");
    assert.equal(a.status, 201);
    for (const [s, e] of [["2026-03-09", "2026-03-09"], ["2026-03-13", "2026-03-17"], ["2026-03-02", "2026-03-30"], ["2026-03-11", "2026-03-12"]]) {
      const r = await request(u.token, lt, s, e);
      assert.equal(r.status, 409, `${s}..${e}`);
    }
    assert.equal((await request(u.token, lt, "2026-03-16", "2026-03-17")).status, 201, "adjacent is fine");
    // other users may overlap
    const w = await staff("Agent");
    assert.equal((await request(w.token, lt, "2026-03-09", "2026-03-13")).status, 201);
    // approved blocks, rejected does not
    assert.equal((await http("POST", `/hr/leave-requests/${a.body.id}/decide`, T.hr, { decision: "rejected" })).status, 200);
    const b = await request(u.token, lt, "2026-03-09", "2026-03-13");
    assert.equal(b.status, 201, "a rejected request frees the dates");
    assert.equal((await http("POST", `/hr/leave-requests/${b.body.id}/decide`, T.hr, { decision: "approved" })).status, 200);
    assert.equal((await request(u.token, lt, "2026-03-10", "2026-03-10")).status, 409);
    // concurrent identical creation
    const x = await staff("Agent");
    const rs = await Promise.all(Array.from({ length: 6 }, () => request(x.token, lt, "2026-04-13", "2026-04-17")));
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
    assert.equal(await count_(q, x.id), 1);
  }));

test("a type that does not require approval is approved at once and counts as used", () =>
  withWorld(async ({ http, T, staff, type, balance, request, q, one }) => {
    const u = await staff("Agent");
    const lt = (await type({ approval: false, counts: true })).id;
    await balance(u.id, lt, 2026, 3);
    const r = await request(u.token, lt, "2026-03-09", "2026-03-11");
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "approved");
    assert.equal(r.body.decided_by, null);
    assert.ok(r.body.decided_at);
    assert.equal((await request(u.token, lt, "2026-03-16", "2026-03-16")).status, 409, "balance exhausted by the auto-approved request");
    const bal = (await http("GET", `/hr/balances?user_id=${u.id}&year=2026`, T.hr)).body.rows[0];
    assert.deepEqual([bal.used_days, bal.pending_days], ["3.00", "0.00"]);
    // nothing for an approver to decide
    assert.equal((await http("POST", `/hr/leave-requests/${r.body.id}/decide`, T.hr, { decision: "approved" })).status, 409);
  }));

// ------------------------------------------------------------------------------------------------ cancel
test("cancel: own pending; own approved only before it starts (balance restored); everything else 409/404", () =>
  withWorld(async ({ http, T, staff, type, balance, request, sql }) => {
    const u = await staff("Agent");
    const other = await staff("Agent");
    const lt = (await type({ counts: true })).id;
    await balance(u.id, lt, 2026, 4);
    const cancel = (token, id, now) => http("POST", `/hr/me/leave-requests/${id}/cancel`, token, {}, now);
    const p = await request(u.token, lt, "2026-03-09", "2026-03-10");
    assert.equal((await cancel(other.token, p.body.id)).status, 404, "someone else's request");
    assert.equal((await cancel(u.token, 999999)).status, 404);
    assert.equal((await cancel(u.token, "abc")).status, 400);
    let r = await cancel(u.token, p.body.id);
    assert.deepEqual([r.status, r.body.status], [200, "cancelled"]);
    assert.equal((await cancel(u.token, p.body.id)).status, 409, "already cancelled");
    // approved, in the future: cancel restores the balance
    const a = await request(u.token, lt, "2026-03-16", "2026-03-19");
    assert.equal((await http("POST", `/hr/leave-requests/${a.body.id}/decide`, T.hr, { decision: "approved" })).status, 200);
    assert.equal((await request(u.token, lt, "2026-03-23", "2026-03-23")).status, 409, "balance used up");
    assert.equal((await cancel(u.token, a.body.id, "2026-03-16T08:00:00Z")).status, 409, "starts today: cannot cancel");
    assert.equal((await cancel(u.token, a.body.id, "2026-03-17T08:00:00Z")).status, 409, "already started");
    r = await cancel(u.token, a.body.id, "2026-03-15T22:59:00Z");
    assert.deepEqual([r.status, r.body.status], [200, "cancelled"], "the day before (Tunis clock)");
    assert.equal((await request(u.token, lt, "2026-03-23", "2026-03-26")).status, 201, "balance restored: 4 days available again");
    // company-timezone boundary: 2026-03-15T23:30Z is already 2026-03-16 in Tunis (UTC+1)
    const b = await sql(u.id, lt, "2026-05-04", "2026-05-04", 1, "approved");
    assert.equal((await cancel(u.token, b.id, "2026-05-03T23:30:00Z")).status, 409, "00:30 on the start day in Tunis");
    assert.equal((await cancel(u.token, b.id, "2026-05-03T22:30:00Z")).status, 200);
    // rejected cannot be cancelled
    const c = await sql(u.id, lt, "2026-06-01", "2026-06-01", 1, "rejected");
    assert.equal((await cancel(u.token, c.id)).status, 409);
  }));

// ------------------------------------------------------------------------------------------------ approvals
test("decide: self-approval refused, another approver may decide, approval is audited", () =>
  withWorld(async ({ http, T, ids, staff, type, request, q, one }) => {
    const lt = (await type()).id;
    for (const k of ["hr", "admin", "mgr"]) {
      const r = await request(T[k], lt, `2026-03-${k === "hr" ? "09" : k === "admin" ? "16" : "23"}`, `2026-03-${k === "hr" ? "09" : k === "admin" ? "16" : "23"}`, { reason: SECRET });
      assert.equal(r.status, 201);
      const own = await http("POST", `/hr/leave-requests/${r.body.id}/decide`, T[k], { decision: "approved" });
      assert.equal(own.status, 403, `${k} deciding their own`);
      assert.equal((await one("SELECT status FROM hr_leave_requests WHERE id=$1", [r.body.id])).status, "pending");
      const other = await http("POST", `/hr/leave-requests/${r.body.id}/decide`, T[k === "hr" ? "admin" : "hr"], { decision: "approved", note: NOTE });
      assert.equal(other.status, 200, other.text);
      assert.equal(other.body.status, "approved");
      assert.equal(other.body.decided_by, ids[k === "hr" ? "admin" : "hr"]);
      assert.ok(other.body.decided_at);
      assert.equal(other.body.decision_note, NOTE);
    }
    const audits = (await q("SELECT action, old_data, new_data FROM audit_logs WHERE table_name='hr_leave_requests'")).rows;
    assert.ok(audits.filter((a) => a.action === "CREATE").length >= 3);
    assert.ok(audits.filter((a) => a.action === "UPDATE").length >= 3);
    assert.ok(!JSON.stringify(audits).includes(SECRET) && !JSON.stringify(audits).includes(NOTE), "audit trail never stores reasons or decision notes");
  }));

test("decide: validation, 404/409 paths", () =>
  withWorld(async ({ http, T, staff, type, request }) => {
    const u = await staff("Agent");
    const lt = (await type()).id;
    const a = await request(u.token, lt, "2026-03-09", "2026-03-09");
    const dec = (id, body, tok = T.hr) => http("POST", `/hr/leave-requests/${id}/decide`, tok, body);
    for (const body of [{}, { decision: "maybe" }, { decision: "approved", note: "x".repeat(501) }, { decision: "approved", extra: 1 }, { decision: "approved", note: 5 }]) {
      assert.equal((await dec(a.body.id, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await dec(999999, { decision: "approved" })).status, 404);
    assert.equal((await dec("abc", { decision: "approved" })).status, 400);
    assert.equal((await dec(a.body.id, { decision: "rejected", note: "x".repeat(500) })).status, 200);
    assert.equal((await dec(a.body.id, { decision: "approved" })).status, 409, "already rejected");
    assert.equal((await dec(a.body.id, { decision: "rejected" }, T.admin)).status, 409);
    // a cancelled request cannot be approved
    const b = await request(u.token, lt, "2026-03-16", "2026-03-16");
    await http("POST", `/hr/me/leave-requests/${b.body.id}/cancel`, u.token, {});
    const r = await dec(b.body.id, { decision: "approved" });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /cancelled/);
  }));

test("scope: a Manager decides and lists only direct reports (404 for others); HR/Admin/SuperAdmin see all", () =>
  withWorld(async ({ http, T, ids, staff, profile, type, request }) => {
    const lt = (await type()).id;
    const rep = await staff("Agent");
    const stranger = await staff("Agent");
    const otherMgr = await staff("Manager");
    const repOfOther = await staff("Receptionist");
    await profile(rep.id, { manager: ids.mgr });
    await profile(repOfOther.id, { manager: otherMgr.id });
    const rr = await request(rep.token, lt, "2026-03-09", "2026-03-09", { reason: SECRET });
    const rs = await request(stranger.token, lt, "2026-03-09", "2026-03-09");
    const ro = await request(repOfOther.token, lt, "2026-03-09", "2026-03-09");
    const team = async (tok, qs = "") => (await http("GET", `/hr/team/leave-requests${qs}`, tok)).body;
    const mgrList = await team(T.mgr);
    assert.deepEqual(mgrList.rows.map((r) => r.id), [rr.body.id]);
    assert.equal(mgrList.rows[0].reason, SECRET, "the approver sees the reason of their report");
    assert.ok(mgrList.rows[0].full_name);
    for (const k of ADMINS) assert.equal((await team(T[k])).total, 3, `${k} sees everyone`);
    assert.equal((await team(T.mgr, "?status=all")).total, 1);
    assert.equal((await http("GET", "/hr/team/leave-requests?status=bogus", T.mgr)).status, 400);
    // the other manager is the manager of someone else only
    assert.deepEqual((await team(otherMgr.token)).rows.map((r) => r.id), [ro.body.id]);
    const dec = (tok, id) => http("POST", `/hr/leave-requests/${id}/decide`, tok, { decision: "approved" });
    assert.equal((await dec(T.mgr, rs.body.id)).status, 404, "a stranger's request");
    assert.equal((await dec(T.mgr, ro.body.id)).status, 404, "another manager's report");
    assert.equal((await dec(otherMgr.token, rr.body.id)).status, 404);
    assert.equal((await dec(T.mgr, rr.body.id)).status, 200, "own report");
    assert.equal((await dec(T.hr, rs.body.id)).status, 200);
    assert.equal((await dec(T.sa, ro.body.id)).status, 200);
    // the 404 does not reveal whether the request exists: same body as an unknown id
    const x = await dec(T.mgr, 999999);
    const y = await http("POST", `/hr/leave-requests/${(await request(stranger.token, lt, "2026-04-13", "2026-04-13")).body.id}/decide`, T.mgr, { decision: "approved" });
    assert.deepEqual([x.status, x.body.error], [y.status, y.body.error]);
  }));

test("approval re-checks the balance: two approvals that together exceed it => exactly one wins", () =>
  withWorld(async ({ http, T, staff, type, balance, sql, one, q }) => {
    const lt = (await type({ counts: true })).id;
    for (let round = 0; round < 3; round++) {
      const u = await staff("Agent");
      await balance(u.id, lt, 2026, 3);
      const a = await sql(u.id, lt, "2026-03-09", "2026-03-10", 2);
      const b = await sql(u.id, lt, "2026-03-16", "2026-03-17", 2);
      const rs = await Promise.all([
        http("POST", `/hr/leave-requests/${a.id}/decide`, T.hr, { decision: "approved" }),
        http("POST", `/hr/leave-requests/${b.id}/decide`, T.admin, { decision: "approved" }),
        http("POST", `/hr/leave-requests/${b.id}/decide`, T.sa, { decision: "approved" }),
      ]);
      const codes = rs.map((r) => r.status).sort();
      const approved = Number((await one("SELECT count(*) AS n FROM hr_leave_requests WHERE user_id=$1 AND status='approved'", [u.id])).n);
      assert.equal(approved, 1, `round ${round}: ${codes}`);
      assert.equal(codes.filter((c) => c === 200).length, 1);
      assert.ok(codes.every((c) => c === 200 || c === 409), codes.join());
      const bal = (await http("GET", `/hr/balances?user_id=${u.id}&year=2026`, T.hr)).body.rows[0];
      assert.equal(bal.used_days, "2.00");
    }
    // entitlement lowered after the request was made: approval is refused, rejection still works
    const v = await staff("Agent");
    await balance(v.id, lt, 2026, 2);
    const r = await sql(v.id, lt, "2026-05-04", "2026-05-05", 2);
    await balance(v.id, lt, 2026, 1);
    const ap = await http("POST", `/hr/leave-requests/${r.id}/decide`, T.hr, { decision: "approved" });
    assert.equal(ap.status, 409);
    assert.match(ap.body.error, /balance/i);
    assert.equal((await http("POST", `/hr/leave-requests/${r.id}/decide`, T.hr, { decision: "rejected" })).status, 200);
    // a type that does not count against the balance can be approved beyond any balance
    const free = (await type({ counts: false })).id;
    const f = await sql(v.id, free, "2026-06-01", "2026-06-12", 10);
    assert.equal((await http("POST", `/hr/leave-requests/${f.id}/decide`, T.hr, { decision: "approved" })).status, 200);
  }));

// ------------------------------------------------------------------------------------------------ calendar privacy
test("calendar: names and dates only, never reasons or notes, in any role's response", () =>
  withWorld(async ({ http, T, ids, staff, profile, type, request }) => {
    const lt = (await type({ name: "Annual leave" })).id;
    const rep = await staff("Agent", { name: "Rep Person" });
    await profile(rep.id, { manager: ids.mgr, dept: "Visa" });
    const r1 = await request(rep.token, lt, "2026-03-09", "2026-03-10", { reason: SECRET });
    await http("POST", `/hr/leave-requests/${r1.body.id}/decide`, T.hr, { decision: "approved", note: NOTE });
    const r2 = await request(rep.token, lt, "2026-03-16", "2026-03-17", { reason: SECRET });
    for (const k of [...ALL_STAFF]) {
      const r = await http("GET", "/hr/team/calendar?from=2026-03-01&to=2026-03-31", T[k]);
      assert.equal(r.status, 200, `${k}: ${r.text}`);
      assert.ok(!r.text.includes(SECRET) && !r.text.includes(NOTE), `${k} calendar leaks a reason/note`);
      assert.ok(!/reason|decision_note|decided_by|"days"/.test(r.text), `${k} calendar has private fields`);
    }
    // reports and balances never carry them either
    for (const url of ["/hr/reports/leave?year=2026", "/hr/balances", "/hr/me"]) {
      const r = await http("GET", url, T.hr);
      assert.ok(!r.text.includes(SECRET) && !r.text.includes(NOTE), url);
    }
    // the requester sees their own reason, and only they, the approvers in scope and hr:read ever do
    const mine = await http("GET", "/hr/me/leave-requests", rep.token);
    assert.ok(mine.text.includes(SECRET) && mine.text.includes(NOTE));
    const cal = (await http("GET", "/hr/team/calendar?from=2026-03-01&to=2026-03-31", T.hr)).body;
    assert.equal(cal.entries.length, 2);
    assert.deepEqual(Object.keys(cal.entries[0]).sort(), ["full_name", "half_day_end", "half_day_start", "end_date", "leave_type_code", "leave_type_name", "name_ar", "name_en", "name_fr", "start_date", "status", "user_id"].sort());
    assert.equal(cal.entries[0].full_name, "Rep Person");
    assert.equal(cal.entries[0].leave_type_name, "Annual leave");
    assert.equal(r2.status, 201);
  }));

test("calendar: visibility by department / report line / admin, pending only for approvers and the owner", () =>
  withWorld(async ({ http, T, ids, staff, profile, type, request, holiday }) => {
    const lt = (await type()).id;
    const visa1 = await staff("Agent", { name: "Visa One" });
    const visa2 = await staff("Receptionist", { name: "Visa Two" });
    const visa3 = await staff("Accountant", { name: "Visa Three" });
    const hrDept = await staff("Agent", { name: "Other Dept" });
    const nodept = await staff("Agent", { name: "No Dept" });
    const noProfile = await staff("Agent", { name: "No Profile" });
    await profile(visa1.id, { dept: "Visa", manager: ids.mgr });
    await profile(visa2.id, { dept: " visa " });
    await profile(visa3.id, { dept: "VISA" });
    await profile(hrDept.id, { dept: "Finance", manager: ids.mgr });
    await profile(nodept.id, {});
    const approved = async (u, s, e) => {
      const r = await request(u.token, lt, s, e);
      assert.equal(r.status, 201, r.text);
      assert.equal((await http("POST", `/hr/leave-requests/${r.body.id}/decide`, T.hr, { decision: "approved" })).status, 200);
    };
    await approved(visa1, "2026-03-09", "2026-03-09");
    await approved(visa2, "2026-03-10", "2026-03-10");
    await approved(hrDept, "2026-03-11", "2026-03-11");
    await approved(nodept, "2026-03-12", "2026-03-12");
    await approved(noProfile, "2026-03-13", "2026-03-13");
    await request(visa3.token, lt, "2026-03-16", "2026-03-16"); // pending
    await request(visa1.token, lt, "2026-03-17", "2026-03-17"); // pending
    await holiday("2026-03-20");
    const cal = async (tok) => (await http("GET", "/hr/team/calendar?from=2026-03-01&to=2026-03-31", tok)).body;
    const names = (c) => c.entries.map((e) => `${e.full_name}:${e.status}`).sort();
    // same department (case/space-insensitive): approved of colleagues + own pending; not other departments
    assert.deepEqual(names(await cal(visa2.token)), ["Visa One:approved", "Visa Two:approved"]);
    assert.deepEqual(names(await cal(visa3.token)), ["Visa One:approved", "Visa Three:pending", "Visa Two:approved"], "own pending visible to the owner, a colleague's pending not");
    assert.deepEqual(names(await cal(visa1.token)), ["Visa One:approved", "Visa One:pending", "Visa Two:approved"]);
    assert.deepEqual(names(await cal(hrDept.token)), ["Other Dept:approved"]);
    assert.deepEqual(names(await cal(nodept.token)), ["No Dept:approved"], "no department: only themselves");
    assert.deepEqual(names(await cal(noProfile.token)), ["No Profile:approved"], "no HR profile: only themselves");
    // Manager: direct reports (visa1, hrDept) incl. pending, plus approved of their own department (none: no profile)
    assert.deepEqual(names(await cal(T.mgr)), ["Other Dept:approved", "Visa One:approved", "Visa One:pending"]);
    // HR/Admin/SuperAdmin: everything, pending marked
    for (const k of ADMINS) {
      const c = await cal(T[k]);
      assert.equal(c.entries.length, 7, k);
      assert.equal(c.entries.filter((e) => e.status === "pending").length, 2);
      assert.deepEqual(c.holidays, [{ day: "2026-03-20", name: "Holiday" }]);
    }
    // cancelled / rejected never appear; deactivated people never appear
    // window rules
    const bad = ["", "?from=2026-03-01", "?to=2026-03-31", "?from=2026-03-31&to=2026-03-01", "?from=2026-01-01&to=2026-04-04", "?from=x&to=y", "?from=2026-03-01&to=2026-03-01&to=2026-03-02"];
    for (const qs of bad) assert.equal((await http("GET", `/hr/team/calendar${qs}`, T.hr)).status, 400, qs);
    assert.equal((await http("GET", "/hr/team/calendar?from=2026-01-01&to=2026-04-03", T.hr)).status, 200, "93 days exactly");
    assert.equal((await http("GET", "/hr/team/calendar?from=2026-03-31&to=2026-03-31", T.hr)).status, 200);
  }));

test("calendar: deactivated people and rejected/cancelled requests are not listed", () =>
  withWorld(async ({ http, T, staff, profile, type, request, q }) => {
    const lt = (await type()).id;
    const a = await staff("Agent", { name: "A" });
    const b = await staff("Agent", { name: "B" });
    const c = await staff("Agent", { name: "C" });
    for (const u of [a, b, c]) await profile(u.id, { dept: "X" });
    const ra = await request(a.token, lt, "2026-03-09", "2026-03-09");
    await http("POST", `/hr/leave-requests/${ra.body.id}/decide`, T.hr, { decision: "rejected" });
    const rb = await request(b.token, lt, "2026-03-09", "2026-03-09");
    await http("POST", `/hr/me/leave-requests/${rb.body.id}/cancel`, b.token, {});
    const rc = await request(c.token, lt, "2026-03-09", "2026-03-09");
    await http("POST", `/hr/leave-requests/${rc.body.id}/decide`, T.hr, { decision: "approved" });
    assert.equal((await http("GET", "/hr/team/calendar?from=2026-03-01&to=2026-03-31", T.hr)).body.entries.length, 1);
    await q("UPDATE users SET is_active=false WHERE id=$1", [c.id]);
    assert.equal((await http("GET", "/hr/team/calendar?from=2026-03-01&to=2026-03-31", T.hr)).body.entries.length, 0);
  }));

// ------------------------------------------------------------------------------------------------ roles
test("role matrix: every staff role has self-service leave; approvals need hr:approve; report needs hr:read; outsiders denied", () =>
  withWorld(async ({ http, T, ids, staff, type, request }) => {
    const lt = (await type()).id;
    let day = 9;
    for (const k of ALL_STAFF) {
      const r = await request(T[k], lt, `2026-04-${String(day).padStart(2, "0")}`, `2026-04-${String(day).padStart(2, "0")}`);
      assert.equal(r.status, 201, `${k} ${r.text}`);
      day += 1;
      if (day % 7 === 4 || day % 7 === 5) day += 2;
      assert.equal((await http("GET", "/hr/me/leave-requests", T[k])).status, 200, k);
      assert.equal((await http("GET", "/hr/team/calendar?from=2026-04-01&to=2026-04-30", T[k])).status, 200, k);
    }
    for (const k of ["sa", "admin", "hr", "mgr"]) assert.equal((await http("GET", "/hr/team/leave-requests", T[k])).status, 200, k);
    for (const k of ["acct", "agent", "rec"]) {
      assert.equal((await http("GET", "/hr/team/leave-requests", T[k])).status, 403, k);
      assert.equal((await http("POST", "/hr/leave-requests/1/decide", T[k], { decision: "approved" })).status, 403, k);
    }
    for (const k of ADMINS) assert.equal((await http("GET", "/hr/reports/leave", T[k])).status, 200, k);
    for (const k of ["mgr", "acct", "agent", "rec"]) assert.equal((await http("GET", "/hr/reports/leave", T[k])).status, 403, `${k} report`);
    // a non-approver cannot read a colleague's request through any route
    const mine = (await http("GET", "/hr/me/leave-requests", T.agent)).body;
    assert.equal(mine.total, 1);
    assert.equal((await http("POST", `/hr/me/leave-requests/${(await http("GET", "/hr/me/leave-requests", T.acct)).body.rows[0].id}/cancel`, T.agent, {})).status, 404);
    const routes = [["POST", "/hr/me/leave-requests"], ["GET", "/hr/me/leave-requests"], ["POST", "/hr/me/leave-requests/1/cancel"], ["GET", "/hr/team/leave-requests"], ["POST", "/hr/leave-requests/1/decide"], ["GET", "/hr/team/calendar?from=2026-04-01&to=2026-04-30"], ["GET", "/hr/reports/leave"]];
    for (const [m, url] of routes) {
      for (const k of OUTSIDERS) assert.equal((await http(m, url, T[k], m === "POST" ? {} : undefined)).status, 403, `${k} ${m} ${url}`);
      assert.equal((await http(m, url, undefined, m === "POST" ? {} : undefined)).status, 401, `anon ${m} ${url}`);
    }
  }));

test("deactivated users: tokens are refused for self-service and for deciding; nothing is written", () =>
  withWorld(async ({ http, T, staff, type, request, q, count, sql }) => {
    const lt = (await type()).id;
    const approver = await staff("HR");
    const u = await staff("Agent");
    const pending = await request(u.token, lt, "2026-03-09", "2026-03-09");
    await q("UPDATE users SET is_active=false WHERE id=$1", [approver.id]);
    const r = await http("POST", `/hr/leave-requests/${pending.body.id}/decide`, approver.token, { decision: "approved" });
    assert.equal(r.status, 401);
    assert.equal((await q("SELECT status FROM hr_leave_requests WHERE id=$1", [pending.body.id])).rows[0].status, "pending");
    assert.equal((await http("GET", "/hr/team/leave-requests", approver.token)).status, 401);
    await q("UPDATE users SET is_active=false WHERE id=$1", [u.id]);
    assert.equal((await request(u.token, lt, "2026-04-13", "2026-04-13")).status, 401);
    assert.equal((await http("POST", `/hr/me/leave-requests/${pending.body.id}/cancel`, u.token, {})).status, 401);
    assert.equal((await http("GET", "/hr/team/calendar?from=2026-03-01&to=2026-03-31", u.token)).status, 401);
    assert.equal((await q("SELECT count(*) AS n FROM hr_leave_requests WHERE user_id=$1", [u.id])).rows[0].n, "1");
  }));

// ------------------------------------------------------------------------------------------------ report
test("leave report: numbers equal the manual sums per employee and type", () =>
  withWorld(async ({ http, T, staff, profile, type, balance, sql, q }) => {
    const annual = (await type({ counts: true, name: "Annual" })).id;
    const sick = (await type({ counts: true, name: "Sick" })).id;
    const u1 = await staff("Agent", { name: "Alpha" });
    const u2 = await staff("Receptionist", { name: "Beta" });
    const u3 = await staff("Agent", { name: "Gamma" });
    await profile(u1.id, { dept: "Visa" });
    await balance(u1.id, annual, 2026, 20, 2);
    await balance(u1.id, sick, 2026, 10, 0);
    await balance(u2.id, annual, 2026, 15, -1);
    await balance(u1.id, annual, 2025, 99, 0);
    await sql(u1.id, annual, "2026-03-02", "2026-03-04", 3, "approved", SECRET);
    await sql(u1.id, annual, "2026-04-06", "2026-04-07", 2, "approved");
    await sql(u1.id, annual, "2026-05-04", "2026-05-04", 0.5, "pending");
    await sql(u1.id, annual, "2026-06-01", "2026-06-01", 1, "rejected");
    await sql(u1.id, annual, "2026-07-01", "2026-07-01", 1, "cancelled");
    await sql(u1.id, sick, "2026-03-09", "2026-03-09", 1, "approved");
    await sql(u1.id, annual, "2025-03-03", "2025-03-03", 1, "approved");
    await sql(u3.id, sick, "2026-02-02", "2026-02-03", 2, "pending"); // no balance row at all
    // u2 has nothing but a balance; u3 appears through its request only
    const rep = (await http("GET", "/hr/reports/leave?year=2026", T.hr)).body;
    assert.equal(rep.year, 2026);
    const get = (u, t) => rep.rows.find((r) => r.user_id === u.id && r.leave_type_id === String(t) || r.user_id === u.id && r.leave_type_id === t);
    const f = (r) => [r.entitled_days, r.adjusted_days, r.approved_days, r.pending_days, r.remaining_days, r.available_days];
    assert.deepEqual(f(get(u1, annual)), ["20.00", "2.00", "5.00", "0.50", "17.00", "16.50"]);
    assert.deepEqual(f(get(u1, sick)), ["10.00", "0.00", "1.00", "0.00", "9.00", "9.00"]);
    assert.deepEqual(f(get(u2, annual)), ["15.00", "-1.00", "0.00", "0.00", "14.00", "14.00"]);
    assert.deepEqual(f(get(u3, sick)), ["0.00", "0.00", "0.00", "2.00", "0.00", "-2.00"]);
    assert.equal(rep.rows.length, 4);
    assert.equal(rep.total, 4);
    assert.equal(get(u1, annual).full_name, "Alpha");
    assert.equal(get(u1, annual).department, "Visa");
    // manual cross-check against SQL sums
    for (const [u, t] of [[u1, annual], [u1, sick], [u3, sick]]) {
      const m = (await q("SELECT COALESCE(sum(days) FILTER (WHERE status='approved'),0)::numeric(8,2)::text AS a, COALESCE(sum(days) FILTER (WHERE status='pending'),0)::numeric(8,2)::text AS p FROM hr_leave_requests WHERE user_id=$1 AND leave_type_id=$2 AND start_date >= '2026-01-01' AND start_date <= '2026-12-31'", [u.id, t])).rows[0];
      const row = get(u, t);
      assert.deepEqual([row.approved_days, row.pending_days], [m.a, m.p]);
    }
    const r25 = (await http("GET", "/hr/reports/leave?year=2025", T.hr)).body;
    assert.equal(r25.rows.length, 1);
    assert.deepEqual(f(r25.rows[0]), ["99.00", "0.00", "1.00", "0.00", "98.00", "98.00"]);
    assert.equal((await http("GET", "/hr/reports/leave?year=1999", T.hr)).status, 400);
    assert.equal((await http("GET", "/hr/reports/leave?year=abc", T.hr)).status, 400);
    assert.equal((await http("GET", "/hr/reports/leave", T.hr)).status, 200, "defaults to the current year");
    assert.ok(!JSON.stringify(rep).includes(SECRET));
  }));
