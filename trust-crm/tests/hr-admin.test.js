// Stage 5, Task 2: HR admin API (employees, schedules, leave types, holidays, balances) and the self-service GET /hr/me.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");
const { parseDays, parseHHMM, validTimezone, companyTimezone } = require("../modules/hr/common");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "hr-admin-test-secret";
delete process.env.HR_TIMEZONE;

// ------------------------------------------------------------------------------------------------ common.js (pure)
test("parseDays: 0..366, at most 2 decimals, normalised strings; negatives only when allowed", () => {
  const ok = [["0", "0.00"], [0, "0.00"], ["21", "21.00"], [21.5, "21.50"], ["0.25", "0.25"], ["366", "366.00"], ["366.00", "366.00"], [" 5 ", "5.00"]];
  for (const [i, o] of ok) assert.equal(parseDays(i), o, String(i));
  const bad = [NaN, Infinity, "NaN", "Infinity", "1e2", "366.01", 366.5, "367", "999", "1000", "-1", -1, "1.234", "1,5", "", " ", null, undefined, {}, [], true, "abc", ".5", "5."];
  for (const i of bad) assert.throws(() => parseDays(i), (e) => e.status === 400, `rejects ${String(i)}`);
  assert.equal(parseDays("-2.5", { allowNegative: true }), "-2.50");
  assert.equal(parseDays(-3, { allowNegative: true }), "-3.00");
  assert.equal(parseDays("-0", { allowNegative: true }), "0.00");
  for (const i of ["-367", "--1", "-1e2", "-NaN", "-"]) assert.throws(() => parseDays(i, { allowNegative: true }), (e) => e.status === 400, i);
});

test("parseHHMM and company timezone", () => {
  for (const ok of ["00:00", "09:05", "23:59"]) assert.equal(parseHHMM(ok, "t"), ok);
  for (const bad of ["24:00", "9:00", "09:60", "0900", "09:00:00", "", null, 900, "ab:cd", " 09:00"]) assert.throws(() => parseHHMM(bad, "t"), (e) => e.status === 400, String(bad));
  assert.equal(companyTimezone(), "Africa/Tunis");
  process.env.HR_TIMEZONE = "Europe/Paris";
  assert.equal(companyTimezone(), "Europe/Paris");
  process.env.HR_TIMEZONE = "not a zone;drop";
  assert.equal(companyTimezone(), "Africa/Tunis");
  delete process.env.HR_TIMEZONE;
});

// ------------------------------------------------------------------------------------------------ world
async function withWorld(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = (sql, p) => pool.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  const http = async (method, url, token, body, raw) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined && raw === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
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
    ids[k] = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`${role} ${k}`, `${k}@hr.test.invalid`, role])).id;
    T[k] = jwt.sign({ id: ids[k], role, ...(k === "cand" ? { tv: 0 } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" });
  }
  T.emp = (await createEmployerUser(pool)).token;
  T.agy = (await createAgencyUser(pool)).token;
  let n = 0;
  const staff = async (role = "Agent", over = {}) => {
    n += 1;
    const id = (await one("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x',$3,$4) RETURNING id", [over.name || `Extra ${n}`, `extra${n}@hr.test.invalid`, role, over.active ?? true])).id;
    return { id, token: jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
  };
  const type = async (over = {}) => {
    n += 1;
    const r = await http("POST", "/hr/leave-types", T.hr, { code: `LT${n}`, name_ar: "إجازة", name_en: `Leave ${n}`, name_fr: `Congé ${n}`, ...over });
    assert.equal(r.status, 201, r.text);
    return r.body;
  };
  const auditCount = async (table, action) => Number((await q("SELECT count(*) AS n FROM audit_logs WHERE table_name=$1 AND ($2::text IS NULL OR action=$2)", [table, action || null])).rows[0].n);
  try {
    await fn({ pool, http, q, one, T, ids, staff, type, auditCount, base });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}
const ADMIN_ROLES = ["sa", "admin", "hr"];
const DENIED_STAFF = ["mgr", "acct", "agent", "rec"];
const OUTSIDERS = ["cand", "emp", "agy"];

// ------------------------------------------------------------------------------------------------ role matrix
test("role matrix: HR/Admin/SuperAdmin full; other staff 403; Candidate/Employer/Agency 403 everywhere (even /hr/me); anonymous 401", () =>
  withWorld(async ({ http, T }) => {
    const reads = ["/hr/employees", "/hr/schedules", "/hr/leave-types", "/hr/holidays", "/hr/balances"];
    for (const url of reads) {
      for (const k of ADMIN_ROLES) assert.equal((await http("GET", url, T[k])).status, 200, `${k} GET ${url}`);
      for (const k of [...DENIED_STAFF, ...OUTSIDERS]) assert.equal((await http("GET", url, T[k])).status, 403, `${k} GET ${url}`);
      assert.equal((await http("GET", url)).status, 401, `anon GET ${url}`);
    }
    const writes = [["POST", "/hr/employees", {}], ["PATCH", "/hr/employees/1", {}], ["POST", "/hr/schedules", {}], ["PATCH", "/hr/schedules/1", {}], ["POST", "/hr/leave-types", {}], ["PATCH", "/hr/leave-types/1", {}], ["POST", "/hr/holidays", {}], ["DELETE", "/hr/holidays/1"], ["PUT", "/hr/balances", {}]];
    for (const [m, url, b] of writes) {
      for (const k of [...DENIED_STAFF, ...OUTSIDERS]) assert.equal((await http(m, url, T[k], b)).status, 403, `${k} ${m} ${url}`);
      assert.equal((await http(m, url, undefined, b)).status, 401, `anon ${m} ${url}`);
      for (const k of ADMIN_ROLES) {
        const s = (await http(m, url, T[k], b)).status;
        assert.ok(s === 400 || s === 404, `${k} ${m} ${url} passes the gate (got ${s})`);
      }
    }
    // /hr/me: every active staff role, nobody else.
    for (const k of [...ADMIN_ROLES, ...DENIED_STAFF]) assert.equal((await http("GET", "/hr/me", T[k])).status, 200, `${k} /hr/me`);
    for (const k of OUTSIDERS) assert.equal((await http("GET", "/hr/me", T[k])).status, 403, `${k} /hr/me`);
    assert.equal((await http("GET", "/hr/me")).status, 401);
    assert.ok([400, 401].includes((await http("GET", "/hr/me", "garbage")).status), "malformed token refused");
  }));

test("a deactivated or demoted staff account is refused at once, even with a still-valid legacy token", () =>
  withWorld(async ({ http, q, staff }) => {
    const u = await staff("Agent");
    assert.equal((await http("GET", "/hr/me", u.token)).status, 200);
    await q("UPDATE users SET is_active=false WHERE id=$1", [u.id]);
    assert.equal((await http("GET", "/hr/me", u.token)).status, 401);
    await q("UPDATE users SET is_active=true, role='Candidate' WHERE id=$1", [u.id]);
    assert.equal((await http("GET", "/hr/me", u.token)).status, 401, "role changed since the token was issued");
  }));

test("body limit is 32 kb and malformed JSON is a 400 (own parser)", () =>
  withWorld(async ({ http, T }) => {
    const big = await http("POST", "/hr/holidays", T.hr, undefined, JSON.stringify({ day: "2026-01-01", name: "x".repeat(40000) }));
    assert.equal(big.status, 413);
    assert.equal((await http("POST", "/hr/holidays", T.hr, undefined, "{nope")).status, 400);
    assert.equal((await http("POST", "/hr/holidays", T.hr, undefined, "[1,2]")).status, 400);
  }));

// ------------------------------------------------------------------------------------------------ employees
test("employees: create / get / patch / list filters / paging / validation / audit", () =>
  withWorld(async ({ http, T, ids, staff, q, auditCount }) => {
    const sch = (await http("POST", "/hr/schedules", T.hr, { name: "Office", weekly: { mon: { start: "09:00", end: "17:00", break_minutes: 60 } } })).body;
    const e1 = await staff("Agent", { name: "Amel Ben Salah" });
    const mk = (b, t = T.hr) => http("POST", "/hr/employees", t, b);
    const created = await mk({ user_id: e1.id, employee_no: "E-001", position: "Advisor", department: "Visa", hire_date: "2024-03-01", employment_type: "full-time", phone: "+216 20 000 000", emergency_contact_name: "Sami", emergency_contact_phone: "+216 21 000 000", manager_user_id: ids.mgr, schedule_id: sch.id, notes: "HR-ONLY-SENTINEL" });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.user_id, e1.id);
    assert.equal(created.body.hire_date, "2024-03-01", "dates are plain YYYY-MM-DD strings");
    assert.equal(created.body.manager_name, "Manager mgr");
    assert.equal(created.body.schedule_name, "Office");
    assert.equal(created.body.status, "active");
    assert.equal(created.body.notes, "HR-ONLY-SENTINEL");
    assert.equal((await mk({ user_id: e1.id })).status, 409, "one profile per user");
    const e2 = await staff("Receptionist", { name: "Zied Mejri" });
    assert.equal((await mk({ user_id: e2.id, employee_no: "E-001" })).status, 409, "employee_no unique");
    assert.equal((await mk({ user_id: e2.id, employee_no: "E-002", department: "Front desk", hire_date: "2023-01-10", status: "inactive" })).status, 201);

    // validation table
    const e3 = await staff("Agent");
    for (const bad of [
      {}, { user_id: "abc" }, { user_id: 0 }, { user_id: -1 }, { user_id: 2147483648 }, { user_id: 1.5 }, { user_id: e3.id, extra: 1 },
      { user_id: e3.id, status: "retired" }, { user_id: e3.id, hire_date: "2024-02-30" }, { user_id: e3.id, hire_date: "01/02/2024" }, { user_id: e3.id, hire_date: "1999-12-31" },
      { user_id: e3.id, hire_date: "2024-05-01", end_date: "2024-04-30" }, { user_id: e3.id, position: "x".repeat(121) }, { user_id: e3.id, department: 5 },
      { user_id: e3.id, phone: "1".repeat(41) }, { user_id: e3.id, notes: "n".repeat(4001) }, { user_id: e3.id, employee_no: "e".repeat(41) }, { user_id: e3.id, position: "a\u0000b" },
      { user_id: e3.id, manager_user_id: e3.id }, { user_id: e3.id, manager_user_id: ids.cand }, { user_id: e3.id, manager_user_id: 999999 }, { user_id: e3.id, manager_user_id: "x" },
      { user_id: e3.id, schedule_id: 999999 }, { user_id: e3.id, schedule_id: 2147483649 },
    ]) assert.equal((await mk(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await mk({ user_id: 999999 })).status, 404, "unknown user");
    assert.equal((await mk({ user_id: ids.cand })).status, 400, "a Candidate is not staff");
    const inactive = await staff("Agent", { active: false });
    assert.equal((await mk({ user_id: inactive.id })).status, 400, "inactive user");
    const inactiveMgr = await staff("Manager", { active: false });
    assert.equal((await mk({ user_id: e3.id, manager_user_id: inactiveMgr.id })).status, 400, "inactive manager");
    assert.equal((await mk(null)).status, 400);

    // get
    const g = await http("GET", `/hr/employees/${e1.id}`, T.hr);
    assert.equal(g.status, 200);
    assert.equal(g.body.notes, "HR-ONLY-SENTINEL");
    assert.equal(g.body.has_profile, true);
    assert.equal((await http("GET", `/hr/employees/${e3.id}`, T.admin)).body.has_profile, false, "staff without a row: HR sees no profile");
    assert.equal((await http("GET", `/hr/employees/${e3.id}`, T.admin)).body.notes, null);
    assert.equal((await http("GET", `/hr/employees/${ids.cand}`, T.hr)).status, 404, "a Candidate is not an employee");
    assert.equal((await http("GET", "/hr/employees/999999", T.hr)).status, 404);
    assert.equal((await http("GET", "/hr/employees/2147483648", T.hr)).status, 404, "above int max: 404");
    assert.equal((await http("GET", "/hr/employees/abc", T.hr)).status, 400);
    assert.equal((await http("GET", `/hr/employees/${e1.id}`, T.mgr)).status, 403, "Manager has no hr:read");

    // patch
    const p = await http("PATCH", `/hr/employees/${e1.id}`, T.hr, { position: "Senior advisor", end_date: null, manager_user_id: null, notes: null, status: "inactive" });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.body.position, "Senior advisor");
    assert.equal(p.body.manager_user_id, null);
    assert.equal(p.body.notes, null);
    assert.equal(p.body.status, "inactive");
    assert.equal((await http("PATCH", `/hr/employees/${e1.id}`, T.hr, {})).status, 400);
    assert.equal((await http("PATCH", `/hr/employees/${e1.id}`, T.hr, { user_id: 5 })).status, 400, "user_id is not patchable");
    assert.equal((await http("PATCH", `/hr/employees/${e1.id}`, T.hr, { end_date: "2020-01-01" })).status, 400, "end before the stored hire_date");
    assert.equal((await http("PATCH", `/hr/employees/${e1.id}`, T.hr, { employee_no: "E-002" })).status, 409);
    assert.equal((await http("PATCH", `/hr/employees/${e3.id}`, T.hr, { position: "x" })).status, 404, "no profile yet -> create it first");
    assert.equal((await http("PATCH", "/hr/employees/999999999999", T.hr, { position: "x" })).status, 404);
    assert.equal((await http("PATCH", `/hr/employees/${e1.id}`, T.hr, { status: "active", notes: "n2" })).body.notes, "n2");

    // list + filters + paging; wildcard in q is escaped; notes never in list
    const all = await http("GET", "/hr/employees", T.admin);
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 2);
    assert.ok(all.body.rows.every((r) => !("notes" in r)));
    assert.equal((await http("GET", "/hr/employees?status=inactive", T.hr)).body.rows.length, 1);
    assert.equal((await http("GET", "/hr/employees?department=visa", T.hr)).body.rows.length, 1);
    assert.equal((await http("GET", "/hr/employees?q=zied", T.hr)).body.rows[0].full_name, "Zied Mejri");
    assert.equal((await http("GET", "/hr/employees?q=%25", T.hr)).body.rows.length, 0, "% is literal");
    assert.equal((await http("GET", "/hr/employees?q=_", T.hr)).body.rows.length, 0, "_ is literal");
    assert.equal((await http("GET", "/hr/employees?status=bogus", T.hr)).status, 400);
    assert.equal((await http("GET", "/hr/employees?q=a&q=b", T.hr)).status, 400);
    const pg = await http("GET", "/hr/employees?limit=1&offset=1", T.hr);
    assert.equal(pg.body.rows.length, 1);
    assert.equal(pg.body.total, 2);
    assert.equal((await http("GET", "/hr/employees?limit=abc", T.hr)).status, 400);

    // audit: 2 creates + 3 successful patches, notes never copied into the trail
    assert.equal(await auditCount("hr_employees", "CREATE"), 2);
    assert.equal(await auditCount("hr_employees", "UPDATE"), 2);
    const leaked = await q("SELECT 1 FROM audit_logs WHERE table_name='hr_employees' AND (old_data::text LIKE '%HR-ONLY-SENTINEL%' OR new_data::text LIKE '%HR-ONLY-SENTINEL%' OR new_data::text LIKE '%\"n2\"%')");
    assert.equal(leaked.rowCount, 0, "notes content stays out of the audit trail");
  }));

test("employees: manager must not create a cycle (self, A<->B, longer chains), including on creation", () =>
  withWorld(async ({ http, T, staff }) => {
    const [a, b, c] = [await staff("Manager"), await staff("Agent"), await staff("Agent")];
    const mk = (id, extra = {}) => http("POST", "/hr/employees", T.hr, { user_id: id, ...extra });
    assert.equal((await mk(a.id)).status, 201);
    assert.equal((await mk(b.id, { manager_user_id: a.id })).status, 201);
    assert.equal((await mk(c.id, { manager_user_id: b.id })).status, 201);
    const patch = (id, m) => http("PATCH", `/hr/employees/${id}`, T.hr, { manager_user_id: m });
    assert.equal((await patch(a.id, a.id)).status, 400, "self");
    assert.equal((await patch(a.id, b.id)).status, 400, "A manages B manages A");
    assert.equal((await patch(a.id, c.id)).status, 400, "A -> C -> B -> A");
    assert.equal((await patch(b.id, c.id)).status, 400);
    assert.equal((await patch(c.id, a.id)).status, 200, "skip-level is fine");
    assert.equal((await patch(a.id, null)).status, 200);
    // creation: D has no profile but is already the manager of E; giving D the manager E would close the loop
    const [d, e] = [await staff("Agent"), await staff("Agent")];
    assert.equal((await mk(e.id, { manager_user_id: d.id })).status, 201);
    assert.equal((await mk(d.id, { manager_user_id: e.id })).status, 400, "cycle on create");
    assert.equal((await http("GET", `/hr/employees/${d.id}`, T.hr)).body.has_profile, false, "nothing was created");
  }));

test("employees: concurrent opposite manager assignments cannot both succeed", () =>
  withWorld(async ({ http, T, staff }) => {
    const [a, b] = [await staff("Agent"), await staff("Agent")];
    for (const u of [a, b]) assert.equal((await http("POST", "/hr/employees", T.hr, { user_id: u.id })).status, 201);
    const rs = await Promise.all([http("PATCH", `/hr/employees/${a.id}`, T.hr, { manager_user_id: b.id }), http("PATCH", `/hr/employees/${b.id}`, T.hr, { manager_user_id: a.id })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400]);
  }));

// ------------------------------------------------------------------------------------------------ schedules
test("schedules: weekly shape, HH:MM, break, grace, timezone, duplicate-safe patch, audit", () =>
  withWorld(async ({ http, T, auditCount }) => {
    const mk = (b, t = T.hr) => http("POST", "/hr/schedules", t, b);
    const weekly = { mon: { start: "09:00", end: "17:30", break_minutes: 60 }, tue: { start: "09:00", end: "17:30" }, sat: null };
    const ok = await mk({ name: "Standard", weekly });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.grace_minutes, 10, "default grace");
    assert.equal(ok.body.timezone, "Africa/Tunis", "default company timezone");
    assert.deepEqual(ok.body.weekly, weekly);
    assert.equal((await mk({ name: "Empty week", weekly: {}, grace_minutes: 0, timezone: "Europe/Paris" })).status, 201);
    const W = (day) => ({ weekly: { mon: day } });
    for (const bad of [
      {}, { name: "x" }, { weekly: {} }, { name: " ", weekly: {} }, { name: "x".repeat(121), weekly: {} }, { name: "x", weekly: [] }, { name: "x", weekly: "mon" }, { name: "x", weekly: null },
      { name: "x", ...W({ start: "9:00", end: "17:00" }) }, { name: "x", ...W({ start: "09:00", end: "24:00" }) }, { name: "x", ...W({ start: "09:00", end: "25:61" }) },
      { name: "x", ...W({ start: "17:00", end: "09:00" }) }, { name: "x", ...W({ start: "09:00", end: "09:00" }) }, { name: "x", ...W({ start: "09:00" }) }, { name: "x", ...W("09:00-17:00") },
      { name: "x", ...W({ start: "09:00", end: "17:00", break_minutes: 721 }) }, { name: "x", ...W({ start: "09:00", end: "17:00", break_minutes: -1 }) },
      { name: "x", ...W({ start: "09:00", end: "17:00", break_minutes: "60" }) }, { name: "x", ...W({ start: "09:00", end: "17:00", break_minutes: 1.5 }) },
      { name: "x", ...W({ start: "09:00", end: "10:00", break_minutes: 60 }) }, { name: "x", ...W({ start: "09:00", end: "17:00", lunch: 1 }) },
      { name: "x", weekly: { funday: { start: "09:00", end: "17:00" } } }, { name: "x", weekly: { Mon: { start: "09:00", end: "17:00" } } },
      { name: "x", weekly: {}, grace_minutes: 121 }, { name: "x", weekly: {}, grace_minutes: -1 }, { name: "x", weekly: {}, grace_minutes: "10" }, { name: "x", weekly: {}, grace_minutes: 2.5 },
      { name: "x", weekly: {}, timezone: "Mars/Olympus" }, { name: "x", weekly: {}, timezone: "africa/tunis" }, { name: "x", weekly: {}, timezone: "" }, { name: "x", weekly: {}, timezone: 5 }, { name: "x", weekly: {}, timezone: "Z".repeat(65) },
      { name: "x", weekly: {}, extra: true },
    ]) assert.equal((await mk(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await mk({ name: "Edge", weekly: { mon: { start: "00:00", end: "23:59", break_minutes: 720 } }, grace_minutes: 120 })).status, 201, "boundary values");
    assert.equal((await mk(null)).status, 400);

    const patched = await http("PATCH", `/hr/schedules/${ok.body.id}`, T.hr, { grace_minutes: 15, weekly: { fri: { start: "08:00", end: "13:00" } }, name: "Standard v2" });
    assert.equal(patched.status, 200, patched.text);
    assert.deepEqual(patched.body.weekly, { fri: { start: "08:00", end: "13:00" } }, "weekly is replaced wholesale");
    assert.equal(patched.body.grace_minutes, 15);
    assert.equal((await http("PATCH", `/hr/schedules/${ok.body.id}`, T.hr, { grace_minutes: 500 })).status, 400);
    assert.equal((await http("PATCH", `/hr/schedules/${ok.body.id}`, T.hr, {})).status, 400);
    assert.equal((await http("PATCH", `/hr/schedules/${ok.body.id}`, T.hr, { timezone: "Nope/Zone" })).status, 400);
    assert.equal((await http("PATCH", "/hr/schedules/999999", T.hr, { name: "x" })).status, 404);
    assert.equal((await http("PATCH", "/hr/schedules/2147483648", T.hr, { name: "x" })).status, 404);
    assert.equal((await http("PATCH", "/hr/schedules/0", T.hr, { name: "x" })).status, 400);
    const list = await http("GET", "/hr/schedules", T.admin);
    assert.equal(list.body.total, 3);
    assert.equal(await auditCount("hr_schedules", "CREATE"), 3);
    assert.equal(await auditCount("hr_schedules", "UPDATE"), 1);
  }));

// ------------------------------------------------------------------------------------------------ leave types
test("leave types: code format, names, flags, duplicates, deactivate (no delete), audit", () =>
  withWorld(async ({ http, T, q, auditCount }) => {
    const mk = (b, t = T.hr) => http("POST", "/hr/leave-types", t, b);
    const names = { name_ar: "إجازة سنوية", name_en: "Annual leave", name_fr: "Congé annuel" };
    const a = await mk({ code: "ANNUAL", ...names });
    assert.equal(a.status, 201, a.text);
    assert.deepEqual([a.body.paid, a.body.counts_against_balance, a.body.requires_approval, a.body.active], [true, true, true, true]);
    assert.equal((await mk({ code: "ANNUAL", ...names })).status, 409, "duplicate code");
    assert.equal((await mk({ code: "SICK_1-A", ...names, paid: false, counts_against_balance: false, requires_approval: false })).status, 201);
    for (const bad of [
      { ...names }, { code: "annual", ...names }, { code: "A", ...names }, { code: "A".repeat(31), ...names }, { code: "SP ACE", ...names }, { code: "É1", ...names }, { code: 12, ...names },
      { code: "NONAME" }, { code: "NOAR", name_en: "x", name_fr: "x" }, { code: "BIGAR", ...names, name_ar: "x".repeat(121) }, { code: "BLANK", ...names, name_fr: "  " }, { code: "NULLN", ...names, name_en: null },
      { code: "FLAG1", ...names, paid: "yes" }, { code: "FLAG2", ...names, active: 1 }, { code: "XTRA", ...names, extra: 1 },
    ]) assert.equal((await mk(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await mk({ code: "MAXLEN", name_ar: "ع".repeat(120), name_en: "x".repeat(120), name_fr: "é".repeat(120) })).status, 201);

    const p = await http("PATCH", `/hr/leave-types/${a.body.id}`, T.hr, { name_en: "Annual", paid: false, active: false });
    assert.equal(p.status, 200);
    assert.deepEqual([p.body.name_en, p.body.paid, p.body.active, p.body.code], ["Annual", false, false, "ANNUAL"]);
    assert.equal((await http("PATCH", `/hr/leave-types/${a.body.id}`, T.hr, { code: "OTHER" })).status, 400);
    assert.equal((await http("PATCH", `/hr/leave-types/${a.body.id}`, T.hr, {})).status, 400);
    assert.equal((await http("PATCH", `/hr/leave-types/${a.body.id}`, T.hr, { name_ar: null })).status, 400);
    assert.equal((await http("PATCH", "/hr/leave-types/999999", T.hr, { active: true })).status, 404);
    assert.equal((await http("PATCH", "/hr/leave-types/abc", T.hr, { active: true })).status, 400);
    assert.equal((await http("DELETE", `/hr/leave-types/${a.body.id}`, T.hr)).status, 404, "no delete route");
    assert.equal((await q("SELECT count(*) AS n FROM hr_leave_types")).rows[0].n, "3");
    assert.equal((await http("GET", "/hr/leave-types?active=true", T.hr)).body.rows.length, 2);
    assert.equal((await http("GET", "/hr/leave-types?active=false", T.hr)).body.rows.length, 1);
    assert.equal((await http("GET", "/hr/leave-types?active=maybe", T.hr)).status, 400);
    assert.equal((await http("GET", "/hr/leave-types?q=%25", T.hr)).body.rows.length, 0);
    assert.equal((await http("GET", "/hr/leave-types?q=sick", T.hr)).body.rows.length, 1);
    assert.equal(await auditCount("hr_leave_types", "CREATE"), 3);
    assert.equal(await auditCount("hr_leave_types", "UPDATE"), 1);
  }));

// ------------------------------------------------------------------------------------------------ holidays
test("holidays: create / list by year / duplicate day / delete (audited) / validation / int bounds", () =>
  withWorld(async ({ http, T, auditCount, q }) => {
    const mk = (b, t = T.hr) => http("POST", "/hr/holidays", t, b);
    const a = await mk({ day: "2026-01-01", name: "New Year" });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.body.day, "2026-01-01", "plain date string, no timezone shift");
    assert.equal((await mk({ day: "2026-01-01", name: "Again" })).status, 409);
    assert.equal((await mk({ day: "2026-03-20", name: "Independence Day" })).status, 201);
    assert.equal((await mk({ day: "2027-01-01", name: "Next year" })).status, 201);
    for (const bad of [{}, { day: "2026-02-30", name: "x" }, { day: "2026-13-01", name: "x" }, { day: "26-01-01", name: "x" }, { day: "2026-01-01T00:00:00Z", name: "x" }, { day: "1999-12-31", name: "x" }, { day: "2201-01-01", name: "x" }, { day: 20260101, name: "x" }, { day: "2026-05-01" }, { day: "2026-05-01", name: " " }, { day: "2026-05-01", name: "n".repeat(161) }, { day: "2026-05-01", name: "x", extra: 1 }]) {
      assert.equal((await mk(bad)).status, 400, JSON.stringify(bad));
    }
    const l = await http("GET", "/hr/holidays?year=2026", T.hr);
    assert.deepEqual(l.body.rows.map((r) => r.day), ["2026-01-01", "2026-03-20"]);
    assert.equal(l.body.year, 2026);
    assert.equal((await http("GET", "/hr/holidays?year=2027", T.hr)).body.rows.length, 1);
    assert.equal((await http("GET", "/hr/holidays", T.hr)).status, 200, "defaults to the current company year");
    for (const bad of ["abc", "20266", "1999", "2201", "26"]) assert.equal((await http("GET", `/hr/holidays?year=${bad}`, T.hr)).status, 400, bad);
    const del = await http("DELETE", `/hr/holidays/${a.body.id}`, T.admin);
    assert.equal(del.status, 200);
    assert.equal(del.body.holiday.day, "2026-01-01");
    assert.equal((await http("DELETE", `/hr/holidays/${a.body.id}`, T.hr)).status, 404, "already gone");
    assert.equal((await http("DELETE", "/hr/holidays/2147483648", T.hr)).status, 404);
    assert.equal((await http("DELETE", "/hr/holidays/abc", T.hr)).status, 400);
    assert.equal((await http("DELETE", "/hr/holidays/-1", T.hr)).status, 400);
    assert.equal((await q("SELECT count(*) AS n FROM hr_holidays")).rows[0].n, "2");
    assert.equal(await auditCount("hr_holidays", "CREATE"), 3);
    assert.equal(await auditCount("hr_holidays", "DELETE"), 1);
    // the same day can be re-created after a delete
    assert.equal((await mk({ day: "2026-01-01", name: "New Year" })).status, 201);
  }));

test("holidays: the same day created in parallel gives one 201 and one 409", () =>
  withWorld(async ({ http, T, q }) => {
    const rs = await Promise.all(Array.from({ length: 2 }, () => http("POST", "/hr/holidays", T.hr, { day: "2026-07-25", name: "Republic Day" })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await q("SELECT count(*) AS n FROM hr_holidays WHERE day='2026-07-25'")).rows[0].n, "1");
    const many = await Promise.all(Array.from({ length: 6 }, (_, i) => http("POST", "/hr/holidays", i % 2 ? T.admin : T.hr, { day: "2026-08-13", name: "Women's Day" })));
    assert.equal(many.filter((r) => r.status === 201).length, 1);
    assert.equal(many.filter((r) => r.status === 409).length, 5);
  }));

// ------------------------------------------------------------------------------------------------ balances
test("balances: PUT upserts idempotently, validates decimal strings, derives used/remaining, audits", () =>
  withWorld(async ({ http, T, ids, type, staff, q, auditCount }) => {
    const lt = await type({ code: "ANNUAL" });
    const u = await staff("Agent");
    const put = (b, t = T.hr) => http("PUT", "/hr/balances", t, b);
    const body = { user_id: u.id, leave_type_id: lt.id, year: 2026, entitled_days: "21", adjusted_days: "1.5" };
    const first = await put(body);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.entitled_days, "21.00");
    assert.equal(first.body.adjusted_days, "1.50");
    assert.equal(first.body.used_days, "0.00");
    assert.equal(first.body.remaining_days, "22.50");
    assert.equal(first.body.created, true);
    const again = await put(body);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id, "same row");
    assert.equal(again.body.created, false);
    assert.equal((await q("SELECT count(*) AS n FROM hr_leave_balances")).rows[0].n, "1");
    // omitted adjusted_days keeps the stored value; entitled_days updates
    const upd = await put({ user_id: u.id, leave_type_id: lt.id, year: 2026, entitled_days: 25.25 });
    assert.equal(upd.body.entitled_days, "25.25");
    assert.equal(upd.body.adjusted_days, "1.50");
    // negative adjustment is allowed, negative entitlement is not
    assert.equal((await put({ ...body, adjusted_days: "-2" })).body.adjusted_days, "-2.00");
    // another year / user are separate rows
    assert.equal((await put({ ...body, year: 2027 })).status, 200);
    assert.equal((await q("SELECT count(*) AS n FROM hr_leave_balances")).rows[0].n, "2");

    // used days come from APPROVED requests only (attributed to the start-date year)
    const ins = (s, e, days, status) => q("INSERT INTO hr_leave_requests (user_id,leave_type_id,start_date,end_date,days,status,decided_at) VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $6='pending' THEN NULL ELSE now() END)", [u.id, lt.id, s, e, days, status]);
    await ins("2026-03-02", "2026-03-04", "3", "approved");
    await ins("2026-04-06", "2026-04-07", "2", "pending");
    await ins("2026-05-04", "2026-05-04", "1", "rejected");
    const got = (await http("GET", `/hr/balances?user_id=${u.id}&year=2026`, T.hr)).body;
    assert.equal(got.total, 1);
    assert.equal(got.rows[0].used_days, "3.00");
    assert.equal(got.rows[0].remaining_days, "16.00", "21 entitled - 2 adjusted - 3 used");

    // validation table
    const bads = [
      {}, { ...body, user_id: "x" }, { ...body, user_id: 2147483648 }, { ...body, leave_type_id: 0 }, { ...body, year: 1999 }, { ...body, year: 2201 }, { ...body, year: "20x6" }, { ...body, year: 2026.5 },
      { ...body, entitled_days: undefined }, { ...body, entitled_days: "NaN" }, { ...body, entitled_days: NaN }, { ...body, entitled_days: "-1" }, { ...body, entitled_days: "367" }, { ...body, entitled_days: "1.234" },
      { ...body, entitled_days: "1e2" }, { ...body, entitled_days: "" }, { ...body, entitled_days: null }, { ...body, entitled_days: {} }, { ...body, adjusted_days: "abc" }, { ...body, adjusted_days: "-367" },
      { ...body, adjusted_days: "1.234" }, { ...body, adjusted_days: "Infinity" }, { ...body, extra: 1 },
    ];
    for (const bad of bads) assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await put({ ...body, user_id: 999999 })).status, 404);
    assert.equal((await put({ ...body, user_id: ids.cand })).status, 404, "a Candidate has no HR balances");
    assert.equal((await put({ ...body, leave_type_id: 999999 })).status, 404);
    assert.equal((await put({ ...body, entitled_days: "366", adjusted_days: "-366" })).status, 200, "bounds");

    // GET filters
    assert.equal((await http("GET", `/hr/balances?user_id=${u.id}`, T.hr)).body.total, 2);
    assert.equal((await http("GET", "/hr/balances?year=2027", T.hr)).body.total, 1);
    assert.equal((await http("GET", "/hr/balances?user_id=abc", T.hr)).status, 400);
    assert.equal((await http("GET", "/hr/balances?user_id=2147483648", T.hr)).status, 400);
    assert.equal((await http("GET", "/hr/balances?year=1", T.hr)).status, 400);
    // audit: one CREATE per new key (2), UPDATE for every later write
    assert.equal(await auditCount("hr_leave_balances", "CREATE"), 2);
    assert.ok((await auditCount("hr_leave_balances", "UPDATE")) >= 4);
  }));

test("balances: concurrent first writes of one key leave a single row", () =>
  withWorld(async ({ http, T, type, staff, q }) => {
    const lt = await type({ code: "RACE" });
    const u = await staff("Agent");
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => http("PUT", "/hr/balances", T.hr, { user_id: u.id, leave_type_id: lt.id, year: 2026, entitled_days: String(10 + i) })));
    assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join());
    assert.equal((await q("SELECT count(*) AS n FROM hr_leave_balances WHERE user_id=$1", [u.id])).rows[0].n, "1");
  }));

// ------------------------------------------------------------------------------------------------ /hr/me
test("/hr/me: staff without an HR row gets defaults (profile null, schedule null), never any notes", () =>
  withWorld(async ({ http, T, ids }) => {
    for (const k of ["agent", "acct", "rec", "mgr", "hr", "admin", "sa"]) {
      const r = await http("GET", "/hr/me", T[k]);
      assert.equal(r.status, 200, k);
      assert.equal(r.body.profile, null);
      assert.equal(r.body.schedule, null);
      assert.deepEqual(r.body.balances, []);
      assert.equal(r.body.user.id, ids[k]);
      assert.equal(r.body.timezone, "Africa/Tunis");
      assert.equal(typeof r.body.year, "number");
      assert.ok(!("notes" in r.body) && !("password" in r.body.user));
    }
  }));

test("/hr/me: own profile subset, manager name, schedule, balances of the company-tz year; HR-only notes never leak", () =>
  withWorld(async ({ http, T, ids, q, type }) => {
    const sch = (await http("POST", "/hr/schedules", T.hr, { name: "Office", weekly: { mon: { start: "09:00", end: "17:00" } }, grace_minutes: 5 })).body;
    assert.equal((await http("POST", "/hr/employees", T.hr, { user_id: ids.agent, employee_no: "A-1", position: "Advisor", department: "Visa", hire_date: "2024-03-01", employment_type: "full-time", phone: "+216 99 111 222", emergency_contact_name: "Secret Contact", manager_user_id: ids.mgr, schedule_id: sch.id, notes: "NOTES-SENTINEL-DO-NOT-LEAK" })).status, 201);
    const lt = await type({ code: "ANNUAL" });
    const year = (await q("SELECT extract(year FROM now() AT TIME ZONE 'Africa/Tunis')::int AS y")).rows[0].y;
    assert.equal((await http("PUT", "/hr/balances", T.hr, { user_id: ids.agent, leave_type_id: lt.id, year, entitled_days: "20", adjusted_days: "2" })).status, 200);
    assert.equal((await http("PUT", "/hr/balances", T.hr, { user_id: ids.agent, leave_type_id: lt.id, year: year - 1, entitled_days: "99" })).status, 200);
    await q("INSERT INTO hr_leave_requests (user_id,leave_type_id,start_date,end_date,days,status,decided_at) VALUES ($1,$2,make_date($3,2,2),make_date($3,2,3),2,'approved',now())", [ids.agent, lt.id, year]);
    const r = await http("GET", "/hr/me", T.agent);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.profile.position, "Advisor");
    assert.equal(r.body.profile.department, "Visa");
    assert.equal(r.body.profile.hire_date, "2024-03-01");
    assert.deepEqual(r.body.profile.manager, { id: ids.mgr, full_name: "Manager mgr" });
    assert.equal(r.body.schedule.name, "Office");
    assert.equal(r.body.schedule.grace_minutes, 5);
    assert.equal(r.body.year, year);
    assert.equal(r.body.balances.length, 1, "only the current year");
    assert.deepEqual([r.body.balances[0].entitled_days, r.body.balances[0].adjusted_days, r.body.balances[0].used_days, r.body.balances[0].remaining_days], ["20.00", "2.00", "2.00", "20.00"]);
    for (const secret of ["NOTES-SENTINEL-DO-NOT-LEAK", "+216 99 111 222", "Secret Contact"]) assert.ok(!r.text.includes(secret), `${secret} must not appear`);
    assert.ok(!("notes" in r.body.profile));
    // the manager sees their own /hr/me, not their report's data
    const m = await http("GET", "/hr/me", T.mgr);
    assert.equal(m.body.profile, null);
    assert.ok(!m.text.includes("Advisor"));
    // a non-HR caller can neither read the detail (notes) nor list
    assert.equal((await http("GET", `/hr/employees/${ids.agent}`, T.agent)).status, 403);
    assert.equal((await http("GET", `/hr/employees/${ids.agent}`, T.mgr)).status, 403);
    // HR sees the notes
    assert.equal((await http("GET", `/hr/employees/${ids.agent}`, T.hr)).body.notes, "NOTES-SENTINEL-DO-NOT-LEAK");
  }));

test("/hr/me honours HR_TIMEZONE for the year boundary", () =>
  withWorld(async ({ http, T }) => {
    process.env.HR_TIMEZONE = "Pacific/Kiritimati"; // UTC+14: already next calendar year for the last 14 h of every year
    try {
      const r = await http("GET", "/hr/me", T.agent);
      assert.equal(r.body.timezone, "Pacific/Kiritimati");
      const expect = new Date(Date.now() + 14 * 3600e3).getUTCFullYear();
      assert.equal(r.body.year, expect);
    } finally {
      delete process.env.HR_TIMEZONE;
    }
  }));

test("validTimezone checks pg_timezone_names", () =>
  withWorld(async ({ pool }) => {
    assert.equal(await validTimezone(pool, "Africa/Tunis"), "Africa/Tunis");
    assert.equal(await validTimezone(pool, " UTC "), "UTC");
    for (const bad of ["Nowhere/City", "", "  ", null, 5, "x".repeat(70), "africa/tunis"]) await assert.rejects(() => validTimezone(pool, bad), (e) => e.status === 400, String(bad));
  }));
