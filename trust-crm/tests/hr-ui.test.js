// Stage 5, Task 5: staff console "HR" tab (public/vita/hr-*.js).
// Static checks (ar/en/fr parity, CSP safety, wiring), unit tests of the pure helpers in public/vita/hr-util.js
// (durations without floats, times in the company zone through Intl with an explicit timeZone, leave-day strings),
// the permission mirror against middleware/role.js, and a contract test that sends payloads built by the helpers to
// the real API. The rendered behaviour is covered by the browser smoke recorded in the task report.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "hr-ui-test-secret";

const VITA = path.join(__dirname, "..", "public", "vita");
const I18N = require("../public/vita/i18n.js");
const U = require("../public/vita/hr-util.js");
const CU = require("../public/vita/crm-util.js");
const { PERMISSIONS } = require("../middleware/role");
const { STAFF_ROLES } = require("../middleware/staff");

const read = (f) => fs.readFileSync(path.join(VITA, f), "utf8");
const HR_JS = ["hr-util.js", "hr-my.js", "hr-team.js", "hr-admin.js"];
const LANGS = ["ar", "en", "fr"];
const HR_PERMS = ["hr:read", "hr:write", "hr:approve"];
const SINKS = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b|setTimeout\(\s*["'`]|setInterval\(\s*["'`]/;

// ---------------------------------------------------------------- wiring

test("admin.html: HR tab + panel, hr scripts after the crm/fin scripts and in order, no inline code, every data-i18n key resolves", () => {
  const html = read("admin.html");
  assert.match(html, /<button type="button" role="tab" id="tab-hr" aria-controls="panel-hr" data-tab="hr" data-i18n="tab\.hr">/);
  assert.match(html, /<section id="panel-hr" role="tabpanel" aria-labelledby="tab-hr"/);
  const order = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(order.slice(-HR_JS.length), HR_JS, "hr scripts are the last scripts, util first");
  for (const f of HR_JS) assert.ok(order.indexOf(f) > order.indexOf("admin.js") && order.indexOf(f) > order.indexOf("crm-util.js"), f);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /(?:href|src)="(?:https?:)?\/\//i);
  const missing = [];
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) for (const l of LANGS) if (!(m[1] in I18N.dictionaries[l])) missing.push(`${l}:${m[1]}`);
  assert.deepEqual(missing, []);
  for (const f of HR_JS) assert.ok(fs.existsSync(path.join(VITA, f)), f);
  for (const id of ["hr-nav-my", "hr-nav-team", "hr-nav-admin", "hr-sec-my", "hr-sec-team", "hr-sec-admin"]) assert.match(html, new RegExp(`id="${id}"`), id);
});

test("the API client allows /hr/ besides the existing prefixes (which are unchanged)", () => {
  const src = read("vita.js");
  assert.match(src, /\^\\\/\(jobsearch\|auth\|crm\)\\\//);
  assert.match(src, /\^\\\/\(employer\|agency\)\\\//);
  assert.match(src, /\^\\\/finance\\\//);
  assert.match(src, /\^\\\/hr\\\//);
});

test("admin.js: every staff role (HR included) may use the console and sees the HR tab; no live stream without jobsearch:read", () => {
  const js = read("admin.js");
  const m = /var STAFF_ROLES = \[([^\]]*)\]/.exec(js);
  assert.ok(m);
  const roles = [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual(roles, [...STAFF_ROLES].sort(), "console staff roles equal middleware/staff.js STAFF_ROLES");
  assert.match(js, /if \(hasJobsearch\(\)\) S\.events = V\.connectEvents/);
  // the HR tab registers itself through the extension API and its visibility does not depend on jobsearch access
  const my = read("hr-my.js");
  assert.match(my, /A\.registerTab\("hr",/);
  assert.match(my, /visible: function \(\) \{ return HU\.isStaffRole\(/);
});

test("static scan: hr scripts render text via the DOM helpers only, call only literal same-origin /hr/ paths, never store data", () => {
  for (const f of HR_JS) {
    const src = read(f);
    src.split("\n").forEach((line, i) => assert.doesNotMatch(line, SINKS, `${f}:${i + 1}`));
    assert.doesNotMatch(src, /https?:\/\//, `${f}: absolute URL`);
    assert.doesNotMatch(src, /\b(?:href|src)\s*:|srcdoc|\.(?:href|src)\s*=|setAttribute\(\s*["'](?:on|href|src|style)|\.on[a-z]+\s*=/, `${f}: link/handler sink`);
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${f}: nothing sensitive is stored in the browser`);
    assert.doesNotMatch(src, /console\.(log|info|debug|warn|error)/, `${f}: console output`);
    assert.doesNotMatch(src, /[?&](?:token|access_token)=/, `${f}: token in a URL`);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest/, `${f}: network access goes through V.api / V.download`);
    assert.doesNotMatch(src, /\bstyle\s*:|\.style\b|cssText/, `${f}: no inline styles (CSP)`);
    assert.doesNotMatch(src, /parseFloat|Number\.parseFloat/, `${f}: day counts are never parsed as floats`);
    if (f === "hr-util.js") continue;
    for (const m of src.matchAll(/V\.(?:api|download)\(\s*(?:"[A-Z]+"\s*,\s*)?"([^"]*)"/g)) assert.match(m[1], /^\/hr\//, `${f}: ${m[1]}`);
    for (const m of src.matchAll(/V\.api\(\s*"[A-Z]+"\s*,\s*([^"\s][^,)]*)/g)) assert.fail(`${f}: API path must start with a string literal: ${m[1]}`);
    for (const m of src.matchAll(/h\("button",\s*\{([^}]*)\}/g)) assert.match(m[1], /type:/, `${f}: button without a type: ${m[0].slice(0, 60)}`);
    assert.doesNotMatch(src, /attrs\s*:\s*\{\s*\[/, `${f}: computed attribute names`);
  }
  // pure helpers never touch the DOM
  assert.doesNotMatch(read("hr-util.js"), /\bdocument\b|\bwindow\.VITA\b|\bV\./);
  assert.match(read("vita.js"), /function h\(tag, props\)/);
});

test("hr-my.js: the clock button is disabled while a request is in flight and the clock shows server time in the company zone", () => {
  const src = read("hr-my.js");
  assert.match(src, /state\.sending/);
  assert.match(src, /\.disabled = true/);
  assert.match(src, /V\.api\("POST", "\/hr\/clock-in"\)/);
  assert.match(src, /V\.api\("POST", "\/hr\/clock-out"\)/);
  assert.match(src, /headers\.get\("Date"\)|headers\.get\('Date'\)/, "server time comes from the response Date header");
  assert.match(src, /HU\.formatClock\(/);
});

test("hr-admin.js: the CSV export is an authenticated blob download (no token in a URL)", () => {
  const src = read("hr-admin.js");
  assert.match(src, /V\.download\("\/hr\/export\/attendance\.csv" \+ /);
  assert.match(src, /X-Row-Limit-Hit|truncated/);
});

test("served under the strict /vita CSP like every other script", async () => {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const f of [...HR_JS, "admin.html"]) {
      const res = await fetch(`${base}/vita/${f}`);
      assert.equal(res.status, 200, f);
      assert.match(res.headers.get("content-security-policy"), /script-src 'self'; style-src 'self'/, f);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      await res.arrayBuffer();
    }
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
});

// ---------------------------------------------------------------- i18n

test("i18n: tab.hr and every hr.* key exist in ar/en/fr, non-empty, identical placeholders, actually translated", () => {
  const { en, ar, fr } = I18N.dictionaries;
  const keys = Object.keys(en).filter((k) => k.startsWith("hr.") || k === "tab.hr" || k === "role.HR" || k === "role.Accountant");
  assert.ok(keys.length >= 190, `hr keys: ${keys.length}`);
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
  for (const k of keys) {
    for (const [name, d] of [["ar", ar], ["fr", fr]]) {
      assert.equal(typeof d[k], "string", `${name}.${k}`);
      assert.ok(d[k].trim().length > 0, `${name}.${k} empty`);
      assert.equal(ph(d[k]), ph(en[k]), `${name}.${k} placeholders`);
    }
  }
  for (const k of ["tab.hr", "hr.my.title", "hr.clock.in", "hr.clock.out", "hr.leave.request", "hr.team.title", "hr.admin.title"]) {
    assert.match(ar[k], /[؀-ۿ]/, `ar ${k}`);
    assert.notEqual(fr[k], en[k], `fr ${k} should be translated`);
  }
  assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
});

test("i18n: every t(\"...\") key and every complete \"hr.*\" key literal in the hr scripts exists in ar/en/fr", () => {
  const used = new Set();
  for (const f of HR_JS) {
    const src = read(f);
    for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"\s*[,)]/g)) used.add(m[1]);
    for (const m of src.matchAll(/"(hr(?:\.[a-zA-Z0-9_]+)+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 120, `expected many keys, got ${used.size}`);
  const missing = [];
  for (const k of used) for (const l of LANGS) if (!(k in I18N.dictionaries[l])) missing.push(`${l}:${k}`);
  assert.deepEqual(missing, []);
});

test("i18n: runtime-built key families (statuses, weekdays, flags, sections, helper error codes and fields) all exist", () => {
  const fam = {
    "hr.status": ["pending", "approved", "rejected", "cancelled"],
    "hr.day": U.DAYS,
    "hr.flag": ["late", "absent", "open", "needs_correction", "holiday", "leave", "scheduled"],
    "hr.sec": ["my", "team", "admin"],
    "hr.admin.sec": ["employees", "schedules", "leaveTypes", "holidays", "balances", "attReport", "leaveReport"],
    "hr.source": ["clock", "correction"],
    "hr.empStatus": ["active", "inactive"],
  };
  const missing = [];
  for (const [p, codes] of Object.entries(fam)) for (const c of codes) for (const l of LANGS) if (!(`${p}.${c}` in I18N.dictionaries[l])) missing.push(`${l}:${p}.${c}`);
  // every error code / field the payload builders can return has a message
  const src = read("hr-util.js");
  let fails = 0;
  for (const m of src.matchAll(/fail\(\s*"([A-Za-z_.]+)"\s*,\s*"([A-Za-z]+)"\s*\)/g)) {
    fails += 1;
    const field = m[1].startsWith("weekly.") ? "weekly" : m[1];
    for (const l of LANGS) {
      if (!(`hr.err.${m[2]}` in I18N.dictionaries[l])) missing.push(`${l}:hr.err.${m[2]}`);
      if (!(`hr.f.${field}` in I18N.dictionaries[l])) missing.push(`${l}:hr.f.${field}`);
    }
  }
  assert.ok(fails > 40, `expected the builders' failure sites, got ${fails}`);
  assert.deepEqual([...new Set(missing)], []);
  assert.deepEqual(U.DAYS, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
});

// ---------------------------------------------------------------- permission mirror

test("hr-util can(): equals middleware/role.js PERMISSIONS for every role and every hr:* key (and denies unknown roles)", () => {
  for (const [role, perms] of Object.entries(PERMISSIONS)) {
    for (const p of HR_PERMS) {
      assert.equal(U.can(role, p), perms.includes("*") || perms.includes(p), `${role} ${p}`);
      assert.equal(CU.can(role, p), perms.includes("*") || perms.includes(p), `crm-util ${role} ${p}`);
    }
  }
  for (const role of [undefined, null, "", "Nobody", "__proto__", "constructor"]) for (const p of HR_PERMS) assert.equal(U.can(role, p), false, `${String(role)} ${p}`);
  assert.equal(U.can("Admin", "hr:bogus"), false);
  assert.equal(U.canRead("HR"), true);
  assert.equal(U.canWrite("HR"), true);
  assert.equal(U.canApprove("Manager"), true);
  assert.equal(U.canRead("Manager"), false, "a Manager approves their reports but has no HR admin access");
  assert.equal(U.canWrite("Manager"), false);
  assert.equal(U.canApprove("Accountant"), false);
  assert.equal(U.canApprove("Agent"), false);
  assert.equal(U.canRead("Candidate"), false);
  // every staff role may use the self-service part, nobody else
  for (const r of STAFF_ROLES) assert.equal(U.isStaffRole(r), true, r);
  for (const r of ["Candidate", "Employer", "Agency", "", undefined, null, "Nobody"]) assert.equal(U.isStaffRole(r), false, String(r));
  assert.deepEqual([...U.STAFF_ROLES].sort(), [...STAFF_ROLES].sort());
});

test("crm-util can() still mirrors the finance:* and crm keys for the roles it knew before (HR was added, nothing removed)", () => {
  for (const role of ["SuperAdmin", "Admin", "Manager", "Receptionist", "Agent", "Accountant"]) {
    for (const p of ["finance:read", "finance:write", "leads:read", "leads:write", "sitejobs:write", "orgs:read", "orgs:write", "users:write", "candidates:read", "candidates:write"]) {
      const perms = PERMISSIONS[role];
      assert.equal(CU.can(role, p), perms.includes("*") || perms.includes(p), `${role} ${p}`);
    }
  }
});

// ---------------------------------------------------------------- durations (integers only)

test("formatDuration: minutes -> 'Hh MMm' by integer arithmetic; anything that is not a whole non-negative number is a dash", () => {
  assert.equal(U.formatDuration(0), "0h 00m");
  assert.equal(U.formatDuration(5), "0h 05m");
  assert.equal(U.formatDuration(59), "0h 59m");
  assert.equal(U.formatDuration(60), "1h 00m");
  assert.equal(U.formatDuration(125), "2h 05m");
  assert.equal(U.formatDuration(480), "8h 00m");
  assert.equal(U.formatDuration(1440), "24h 00m");
  assert.equal(U.formatDuration(100000), "1666h 40m");
  assert.equal(U.formatDuration("125"), "2h 05m", "digit strings are accepted");
  assert.equal(U.formatDuration(2147483647), "35791394h 07m", "beyond float-rounding territory it still divides exactly");
  for (const bad of [-1, 12.5, "12.5", "1e3", NaN, Infinity, null, undefined, "", "abc", {}, []]) assert.equal(U.formatDuration(bad), "—", String(bad));
});

test("workedSoFar: closed sessions use the server's minutes, an open one counts to the (server) clock; integers only", () => {
  const recs = [
    { clock_in: "2026-10-24T08:00:00.000Z", clock_out: "2026-10-24T10:30:00.000Z", worked_minutes: 150 },
    { clock_in: "2026-10-24T11:00:00.000Z", clock_out: null, worked_minutes: null },
  ];
  const now = Date.parse("2026-10-24T11:45:59.000Z");
  assert.equal(U.workedSoFar(recs, now), 150 + 45);
  assert.equal(U.workedSoFar([], now), 0);
  assert.equal(U.workedSoFar([recs[0]], now), 150);
  assert.equal(U.workedSoFar([{ clock_in: "2026-10-24T11:50:00.000Z", clock_out: null }], now), 0, "a clock slightly behind the server never shows negative time");
  assert.equal(U.openRecord(recs), recs[1]);
  assert.equal(U.openRecord([recs[0]]), null);
  assert.equal(U.openRecord(null), null);
});

// ---------------------------------------------------------------- time zone display

test("formatTime/formatClock/localDate: Intl with an explicit timeZone, independent of the machine zone", () => {
  const instant = "2026-10-24T22:30:15.000Z"; // 23:30:15 in Tunis (UTC+1), 18:30:15 in Toronto (UTC-4)
  assert.equal(U.formatTime(instant, "Africa/Tunis", "en-GB"), "23:30");
  assert.equal(U.formatTime(instant, "America/Toronto", "en-GB"), "18:30");
  assert.equal(U.formatTime(instant, "UTC", "en-GB"), "22:30");
  assert.equal(U.formatClock(Date.parse(instant), "Africa/Tunis", "en-GB"), "23:30:15");
  assert.equal(U.localDate(instant, "Africa/Tunis"), "2026-10-24");
  // crossing midnight: 23:59:59 and 00:00:00 in Tunis are different local days
  assert.equal(U.localDate("2026-10-24T22:59:59.000Z", "Africa/Tunis"), "2026-10-24");
  assert.equal(U.localDate("2026-10-24T23:00:00.000Z", "Africa/Tunis"), "2026-10-25");
  assert.equal(U.formatTime("2026-10-24T23:00:00.000Z", "Africa/Tunis", "en-GB"), "00:00", "midnight is 00:00, never 24:00");
  assert.equal(U.formatStamp(instant, "Africa/Tunis"), "2026-10-24 23:30");
  assert.equal(U.formatStamp(null, "Africa/Tunis"), "—");
  assert.equal(U.formatTime("garbage", "Africa/Tunis", "en-GB"), "—");
  // an unknown zone falls back to the company default instead of the browser's
  assert.equal(U.validTz("Africa/Tunis"), true);
  assert.equal(U.validTz("Mars/Olympus"), false);
  assert.equal(U.validTz(""), false);
  assert.equal(U.validTz(null), false);
  assert.equal(U.formatTime(instant, "Mars/Olympus", "en-GB"), "23:30");
  assert.equal(U.DEFAULT_TZ, "Africa/Tunis");
  // the zone shown is the schedule's, else the company's from /hr/me, else the default
  assert.equal(U.effectiveTz({ timezone: "Europe/Paris", schedule: { timezone: "Africa/Tunis" } }), "Africa/Tunis");
  assert.equal(U.effectiveTz({ timezone: "Europe/Paris", schedule: null }), "Europe/Paris");
  assert.equal(U.effectiveTz({ timezone: "Nope/Nope", schedule: { timezone: "Also/Nope" } }), "Africa/Tunis");
  assert.equal(U.effectiveTz({}), "Africa/Tunis");
  assert.equal(U.effectiveTz(null), "Africa/Tunis");
});

test("zonedIso: wall-clock date + HH:MM in a zone -> ISO instant with that zone's offset (what the corrections API wants)", () => {
  assert.equal(U.zonedIso("2026-10-24", "09:00", "Africa/Tunis"), "2026-10-24T09:00:00+01:00");
  assert.equal(U.zonedIso("2026-10-24", "00:00", "Africa/Tunis"), "2026-10-24T00:00:00+01:00");
  assert.equal(U.zonedIso("2026-10-24", "23:59", "Africa/Tunis"), "2026-10-24T23:59:00+01:00");
  assert.equal(U.zonedIso("2026-07-01", "12:30", "Europe/Paris"), "2026-07-01T12:30:00+02:00");
  assert.equal(U.zonedIso("2026-01-15", "12:30", "Europe/Paris"), "2026-01-15T12:30:00+01:00");
  assert.equal(U.zonedIso("2026-07-01", "12:30", "America/Toronto"), "2026-07-01T12:30:00-04:00");
  assert.equal(U.zonedIso("2026-01-01", "12:30", "America/Toronto"), "2026-01-01T12:30:00-05:00");
  assert.equal(U.zonedIso("2026-01-01", "12:30", "Asia/Kolkata"), "2026-01-01T12:30:00+05:30");
  assert.equal(U.zonedIso("2026-01-01", "12:30", "UTC"), "2026-01-01T12:30:00+00:00");
  // the instant round-trips through the same zone
  const iso = U.zonedIso("2026-03-29", "09:15", "Europe/Paris"); // the day DST starts, after the jump
  assert.equal(iso, "2026-03-29T09:15:00+02:00");
  assert.equal(U.formatTime(iso, "Europe/Paris", "en-GB"), "09:15");
  assert.equal(U.zonedIso("2026-02-30", "09:00", "Africa/Tunis"), null);
  assert.equal(U.zonedIso("2026-10-24", "25:00", "Africa/Tunis"), null);
  assert.equal(U.zonedIso("2026-10-24", "9:00", "Africa/Tunis"), null);
  assert.equal(U.zonedIso("2026-10-24", "09:00", "Nope/Nope"), "2026-10-24T09:00:00+01:00", "unknown zone -> company default");
});

test("serverOffset: the difference between the server's Date header and the local clock; garbage -> 0", () => {
  assert.equal(U.serverOffset("Sat, 24 Oct 2026 10:00:05 GMT", Date.parse("2026-10-24T10:00:00Z")), 5000);
  assert.equal(U.serverOffset("Sat, 24 Oct 2026 09:59:50 GMT", Date.parse("2026-10-24T10:00:00Z")), -10000);
  assert.equal(U.serverOffset(null, 1), 0);
  assert.equal(U.serverOffset("not a date", 1), 0);
});

// ---------------------------------------------------------------- leave-day strings

test("date helpers: calendar arithmetic on YYYY-MM-DD strings (no local-zone Date use)", () => {
  assert.equal(U.isDate("2026-02-28"), true);
  assert.equal(U.isDate("2026-02-29"), false);
  assert.equal(U.isDate("2028-02-29"), true);
  assert.equal(U.isDate("2026-2-3"), false);
  assert.equal(U.isDate(20260203), false);
  assert.equal(U.isDate("2026-10-24T00:00"), false);
  assert.equal(U.addDays("2026-10-24", 1), "2026-10-25");
  assert.equal(U.addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(U.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(U.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(U.addDays("2028-03-01", -1), "2028-02-29");
  assert.equal(U.addDays("garbage", 1), null);
  assert.equal(U.diffDays("2026-10-24", "2026-10-24"), 0);
  assert.equal(U.diffDays("2026-10-24", "2026-10-31"), 7);
  assert.equal(U.diffDays("2026-12-25", "2027-01-05"), 11);
  assert.equal(U.diffDays("2026-10-31", "2026-10-24"), -7);
  assert.equal(U.diffDays("x", "2026-10-24"), null);
  assert.equal(U.weekdayKey("2026-10-24"), "sat");
  assert.equal(U.weekdayKey("2026-10-26"), "mon");
  assert.equal(U.weekdayKey("2026-10-25"), "sun");
  assert.equal(U.weekdayKey("nope"), null);
  assert.deepEqual(U.monthBounds("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(U.monthBounds("2028-02"), { from: "2028-02-01", to: "2028-02-29" });
  assert.deepEqual(U.monthBounds("2026-12"), { from: "2026-12-01", to: "2026-12-31" });
  assert.equal(U.monthBounds("2026-13"), null);
  assert.equal(U.shiftMonth("2026-12", 1), "2027-01");
  assert.equal(U.shiftMonth("2026-01", -1), "2025-12");
  assert.equal(U.shiftMonth("2026-10", 0), "2026-10");
  assert.equal(U.shiftMonth("2026-10", 14), "2027-12");
  assert.equal(U.monthOf("2026-10-24"), "2026-10");
  assert.equal(U.compareDates("2026-10-24", "2026-10-25"), -1);
  assert.equal(U.compareDates("2026-10-25", "2026-10-25"), 0);
  assert.equal(U.compareDates("2027-01-01", "2026-12-31"), 1);
  assert.equal(U.compareDates("x", "2026-12-31"), null);
});

test("formatDays/parseDaysInput: day counts are decimal STRINGS handled by string operations", () => {
  assert.equal(U.formatDays("2.00"), "2");
  assert.equal(U.formatDays("2.50"), "2.5");
  assert.equal(U.formatDays("0.50"), "0.5");
  assert.equal(U.formatDays("0.00"), "0");
  assert.equal(U.formatDays("-1.50"), "-1.5");
  assert.equal(U.formatDays("21.25"), "21.25");
  assert.equal(U.formatDays(null), "—");
  assert.equal(U.formatDays(2.5), "—", "numbers are refused: day counts travel as strings");
  assert.equal(U.formatDays("abc"), "—");
  assert.deepEqual(U.parseDaysInput("12"), { ok: true, value: "12.00" });
  assert.deepEqual(U.parseDaysInput(" 12.5 "), { ok: true, value: "12.50" });
  assert.deepEqual(U.parseDaysInput("0"), { ok: true, value: "0.00" });
  assert.deepEqual(U.parseDaysInput("366"), { ok: true, value: "366.00" });
  assert.equal(U.parseDaysInput("367").ok, false);
  assert.equal(U.parseDaysInput("1.234").ok, false);
  assert.equal(U.parseDaysInput("1,5").ok, false);
  assert.equal(U.parseDaysInput("1e2").ok, false);
  assert.equal(U.parseDaysInput("-1").ok, false, "entitlement is not negative");
  assert.equal(U.parseDaysInput("").ok, false);
  assert.deepEqual(U.parseDaysInput("-1.5", { allowNegative: true }), { ok: true, value: "-1.50" });
  assert.deepEqual(U.parseDaysInput("-0", { allowNegative: true }), { ok: true, value: "0.00" });
  assert.equal(U.parseDaysInput("-367", { allowNegative: true }).ok, false);
});

// ---------------------------------------------------------------- payload builders

test("correctionPayload: date + HH:MM in the company zone -> ISO instants with offset; checks the rules the API enforces", () => {
  const f = { date: "2026-10-23", in: "09:00", out: "17:30", nextDay: false, reason: "  Forgot to clock in  " };
  assert.deepEqual(U.correctionPayload(f, "Africa/Tunis", "2026-10-24"), {
    ok: true,
    payload: { work_date: "2026-10-23", requested_in: "2026-10-23T09:00:00+01:00", requested_out: "2026-10-23T17:30:00+01:00", reason: "Forgot to clock in" },
  });
  // night shift: the out time is on the next day
  assert.equal(U.correctionPayload({ ...f, in: "22:00", out: "06:00", nextDay: true }, "Africa/Tunis", "2026-10-24").payload.requested_out, "2026-10-24T06:00:00+01:00");
  // today may omit the out time (still working); a past day needs both ends
  const today = U.correctionPayload({ ...f, date: "2026-10-24", out: "" }, "Africa/Tunis", "2026-10-24");
  assert.equal(today.ok, true);
  assert.equal("requested_out" in today.payload, false);
  assert.deepEqual(U.correctionPayload({ ...f, out: "" }, "Africa/Tunis", "2026-10-24"), { ok: false, field: "out", code: "required" });
  assert.deepEqual(U.correctionPayload({ ...f, out: "08:00" }, "Africa/Tunis", "2026-10-24"), { ok: false, field: "out", code: "order" });
  assert.deepEqual(U.correctionPayload({ ...f, in: "09:00", out: "09:00" }, "Africa/Tunis", "2026-10-24"), { ok: false, field: "out", code: "order" });
  assert.deepEqual(U.correctionPayload({ ...f, date: "2026-10-25" }, "Africa/Tunis", "2026-10-24"), { ok: false, field: "date", code: "future" });
  assert.deepEqual(U.correctionPayload({ ...f, date: "2026-08-01" }, "Africa/Tunis", "2026-10-24"), { ok: false, field: "date", code: "past" });
  assert.deepEqual(U.correctionPayload({ ...f, date: "2026-02-30" }, "Africa/Tunis", "2026-10-24"), { ok: false, field: "date", code: "invalid" });
  assert.deepEqual(U.correctionPayload({ ...f, in: "" }, "Africa/Tunis", "2026-10-24"), { ok: false, field: "in", code: "required" });
  assert.deepEqual(U.correctionPayload({ ...f, in: "9am" }, "Africa/Tunis", "2026-10-24"), { ok: false, field: "in", code: "invalid" });
  assert.deepEqual(U.correctionPayload({ ...f, reason: "   " }, "Africa/Tunis", "2026-10-24"), { ok: false, field: "reason", code: "required" });
  assert.deepEqual(U.correctionPayload({ ...f, reason: "x".repeat(501) }, "Africa/Tunis", "2026-10-24"), { ok: false, field: "reason", code: "long" });
  assert.equal(U.correctionPayload({ ...f, reason: "x".repeat(500) }, "Africa/Tunis", "2026-10-24").ok, true);
  assert.deepEqual(U.correctionPayload({ ...f, in: "09:00", out: "09:30", nextDay: true }, "Africa/Tunis", "2026-10-24"), { ok: false, field: "out", code: "range" }, "a corrected session may not exceed 24 hours (the API says so too)");
});

test("leavePayload: dates, half-day flags and reason, as the API wants them", () => {
  const f = { leave_type_id: "3", start_date: "2026-11-02", end_date: "2026-11-04", half_start: false, half_end: true, reason: " Family  " };
  assert.deepEqual(U.leavePayload(f), { ok: true, payload: { leave_type_id: 3, start_date: "2026-11-02", end_date: "2026-11-04", half_day_start: false, half_day_end: true, reason: "Family" } });
  assert.deepEqual(U.leavePayload({ ...f, reason: "  ", half_end: false }), { ok: true, payload: { leave_type_id: 3, start_date: "2026-11-02", end_date: "2026-11-04", half_day_start: false, half_day_end: false } });
  assert.deepEqual(U.leavePayload({ ...f, leave_type_id: "" }), { ok: false, field: "leave_type_id", code: "required" });
  assert.deepEqual(U.leavePayload({ ...f, leave_type_id: "abc" }), { ok: false, field: "leave_type_id", code: "invalid" });
  assert.deepEqual(U.leavePayload({ ...f, start_date: "" }), { ok: false, field: "start_date", code: "required" });
  assert.deepEqual(U.leavePayload({ ...f, end_date: "2026-13-01" }), { ok: false, field: "end_date", code: "invalid" });
  assert.deepEqual(U.leavePayload({ ...f, end_date: "2026-11-01" }), { ok: false, field: "end_date", code: "order" });
  assert.deepEqual(U.leavePayload({ ...f, end_date: "2026-11-02", half_start: true, half_end: true }), { ok: false, field: "half_end", code: "halfSingle" });
  assert.equal(U.leavePayload({ ...f, end_date: "2026-11-02", half_start: true, half_end: false }).ok, true);
  assert.deepEqual(U.leavePayload({ ...f, reason: "x".repeat(501) }), { ok: false, field: "reason", code: "long" });
});

test("decisionPayload / cancel rules", () => {
  assert.deepEqual(U.decisionPayload("approved", "  ok  "), { ok: true, payload: { decision: "approved", note: "ok" } });
  assert.deepEqual(U.decisionPayload("rejected", ""), { ok: true, payload: { decision: "rejected" } });
  assert.deepEqual(U.decisionPayload("maybe", ""), { ok: false, field: "decision", code: "invalid" });
  assert.deepEqual(U.decisionPayload("approved", "x".repeat(501)), { ok: false, field: "note", code: "long" });
  assert.equal(U.canCancelLeave({ status: "pending", start_date: "2026-10-01" }, "2026-10-24"), true);
  assert.equal(U.canCancelLeave({ status: "approved", start_date: "2026-10-25" }, "2026-10-24"), true);
  assert.equal(U.canCancelLeave({ status: "approved", start_date: "2026-10-24" }, "2026-10-24"), false, "an approved leave that has started cannot be cancelled");
  assert.equal(U.canCancelLeave({ status: "rejected", start_date: "2026-11-01" }, "2026-10-24"), false);
  assert.equal(U.canCancelLeave(null, "2026-10-24"), false);
  assert.equal(U.canCancelCorrection({ status: "pending" }), true);
  assert.equal(U.canCancelCorrection({ status: "approved" }), false);
  assert.equal(U.isOwn({ user_id: 7 }, 7), true);
  assert.equal(U.isOwn({ user_id: 7 }, 8), false);
  assert.equal(U.isOwn({ user_id: 7 }, undefined), false);
});

test("schedulePayload: weekly grid -> API body with HH:MM, break minutes and grace; days off are null", () => {
  const days = {};
  for (const d of U.DAYS) days[d] = { on: false, start: "", end: "", break_minutes: "" };
  for (const d of ["mon", "tue", "wed", "thu", "fri"]) days[d] = { on: true, start: "09:00", end: "17:30", break_minutes: "60" };
  const form = { name: " Office ", grace_minutes: "10", timezone: "Africa/Tunis", days };
  const out = U.schedulePayload(form);
  assert.equal(out.ok, true);
  assert.equal(out.payload.name, "Office");
  assert.equal(out.payload.grace_minutes, 10);
  assert.equal(out.payload.timezone, "Africa/Tunis");
  assert.deepEqual(out.payload.weekly.mon, { start: "09:00", end: "17:30", break_minutes: 60 });
  assert.equal(out.payload.weekly.sat, null);
  assert.equal(out.payload.weekly.sun, null);
  assert.deepEqual(Object.keys(out.payload.weekly), U.DAYS);
  // blank break -> 0
  days.fri.break_minutes = "";
  assert.equal(U.schedulePayload({ ...form, days }).payload.weekly.fri.break_minutes, 0);
  days.fri.break_minutes = "60";
  assert.deepEqual(U.schedulePayload({ ...form, name: " " }), { ok: false, field: "name", code: "required" });
  assert.deepEqual(U.schedulePayload({ ...form, grace_minutes: "121" }), { ok: false, field: "grace_minutes", code: "range" });
  assert.deepEqual(U.schedulePayload({ ...form, grace_minutes: "1.5" }), { ok: false, field: "grace_minutes", code: "number" });
  assert.deepEqual(U.schedulePayload({ ...form, timezone: "Mars/Olympus" }), { ok: false, field: "timezone", code: "invalid" });
  const bad = (patch) => U.schedulePayload({ ...form, days: { ...days, mon: { on: true, start: "09:00", end: "17:30", break_minutes: "60", ...patch } } });
  assert.deepEqual(bad({ start: "9:00" }), { ok: false, field: "weekly.mon.start", code: "invalid" });
  assert.deepEqual(bad({ end: "" }), { ok: false, field: "weekly.mon.end", code: "required" });
  assert.deepEqual(bad({ end: "08:00" }), { ok: false, field: "weekly.mon.end", code: "order" });
  assert.deepEqual(bad({ break_minutes: "721" }), { ok: false, field: "weekly.mon.break_minutes", code: "range" });
  assert.deepEqual(bad({ break_minutes: "x" }), { ok: false, field: "weekly.mon.break_minutes", code: "number" });
  assert.deepEqual(bad({ break_minutes: "510" }), { ok: false, field: "weekly.mon.break_minutes", code: "range" }, "a break as long as the day is refused (the API refuses it too)");
  // stored weekly -> editable grid and back
  const grid = U.scheduleToGrid({ mon: { start: "08:00", end: "12:00", break_minutes: 0 }, tue: null });
  assert.deepEqual(grid.mon, { on: true, start: "08:00", end: "12:00", break_minutes: "0" });
  assert.deepEqual(grid.tue, { on: false, start: "", end: "", break_minutes: "" });
  assert.deepEqual(grid.sun, { on: false, start: "", end: "", break_minutes: "" });
  assert.equal(U.describeDay({ start: "09:00", end: "17:30", break_minutes: 60 }), "09:00–17:30 (60)");
  assert.equal(U.describeDay(null), null);
});

test("leaveTypePayload / holidayPayload / balancePayload / employeePayload", () => {
  const lt = { code: " annual ", name_ar: "سنوية", name_en: "Annual", name_fr: "Annuel", paid: true, counts_against_balance: true, requires_approval: true, active: true };
  assert.deepEqual(U.leaveTypePayload(lt, { creating: true }), { ok: true, payload: { code: "ANNUAL", name_ar: "سنوية", name_en: "Annual", name_fr: "Annuel", paid: true, counts_against_balance: true, requires_approval: true, active: true } });
  assert.equal("code" in U.leaveTypePayload(lt, { creating: false }).payload, false, "the code cannot be changed after creation");
  assert.deepEqual(U.leaveTypePayload({ ...lt, code: "a" }, { creating: true }), { ok: false, field: "code", code: "invalid" });
  assert.deepEqual(U.leaveTypePayload({ ...lt, name_fr: " " }, { creating: true }), { ok: false, field: "name_fr", code: "required" });
  assert.deepEqual(U.leaveTypePayload({ ...lt, name_en: "x".repeat(121) }, { creating: true }), { ok: false, field: "name_en", code: "long" });
  assert.deepEqual(U.holidayPayload({ day: "2026-12-25", name: " Christmas " }), { ok: true, payload: { day: "2026-12-25", name: "Christmas" } });
  assert.deepEqual(U.holidayPayload({ day: "", name: "x" }), { ok: false, field: "day", code: "required" });
  assert.deepEqual(U.holidayPayload({ day: "2026-02-30", name: "x" }), { ok: false, field: "day", code: "invalid" });
  assert.deepEqual(U.holidayPayload({ day: "2026-12-25", name: "" }), { ok: false, field: "name", code: "required" });
  assert.deepEqual(U.holidayPayload({ day: "2026-12-25", name: "x".repeat(161) }), { ok: false, field: "name", code: "long" });
  assert.deepEqual(U.balancePayload({ user_id: "5", leave_type_id: "2", year: "2026", entitled_days: "21", adjusted_days: "-1.5" }), {
    ok: true, payload: { user_id: 5, leave_type_id: 2, year: 2026, entitled_days: "21.00", adjusted_days: "-1.50" },
  });
  assert.deepEqual(U.balancePayload({ user_id: "5", leave_type_id: "2", year: "2026", entitled_days: "21", adjusted_days: "" }).payload, { user_id: 5, leave_type_id: 2, year: 2026, entitled_days: "21.00" });
  assert.deepEqual(U.balancePayload({ user_id: "", leave_type_id: "2", year: "2026", entitled_days: "21" }), { ok: false, field: "user_id", code: "required" });
  assert.deepEqual(U.balancePayload({ user_id: "5", leave_type_id: "2", year: "1999", entitled_days: "21" }), { ok: false, field: "year", code: "range" });
  assert.deepEqual(U.balancePayload({ user_id: "5", leave_type_id: "2", year: "2026", entitled_days: "-3" }), { ok: false, field: "entitled_days", code: "number" });
  assert.deepEqual(U.balancePayload({ user_id: "5", leave_type_id: "2", year: "2026", entitled_days: "21", adjusted_days: "1.234" }), { ok: false, field: "adjusted_days", code: "number" });

  const emp = {
    employee_no: " E-1 ", position: "Clerk", department: " Visa ", hire_date: "2026-01-05", end_date: "", employment_type: "", phone: "", emergency_contact_name: "", emergency_contact_phone: "",
    manager_user_id: "7", schedule_id: "", status: "active", notes: " private ",
  };
  const ep = U.employeePayload(emp, { creating: false, withNotes: true });
  assert.equal(ep.ok, true);
  assert.deepEqual(ep.payload, {
    employee_no: "E-1", position: "Clerk", department: "Visa", hire_date: "2026-01-05", end_date: null, employment_type: null, phone: null, emergency_contact_name: null,
    emergency_contact_phone: null, manager_user_id: 7, schedule_id: null, status: "active", notes: "private",
  });
  assert.equal("notes" in U.employeePayload(emp, { creating: false, withNotes: false }).payload, false, "notes are sent only by callers who can see them");
  assert.equal(U.employeePayload({ ...emp, user_id: "9" }, { creating: true, withNotes: true }).payload.user_id, 9);
  assert.deepEqual(U.employeePayload({ ...emp }, { creating: true, withNotes: true }), { ok: false, field: "user_id", code: "required" });
  assert.deepEqual(U.employeePayload({ ...emp, hire_date: "x" }, { creating: false }), { ok: false, field: "hire_date", code: "invalid" });
  assert.deepEqual(U.employeePayload({ ...emp, hire_date: "2026-05-01", end_date: "2026-01-01" }, { creating: false }), { ok: false, field: "end_date", code: "order" });
  assert.deepEqual(U.employeePayload({ ...emp, phone: "1".repeat(41) }, { creating: false }), { ok: false, field: "phone", code: "long" });
  assert.deepEqual(U.employeePayload({ ...emp, status: "gone" }, { creating: false }), { ok: false, field: "status", code: "invalid" });
  assert.deepEqual(U.changedFields({ a: 1, b: null, c: "x" }, { a: 1, b: null, c: "y", d: null }), { c: "y" }, "null vs missing is not a change");
  assert.deepEqual(U.changedFields({ a: 1 }, { a: 1 }), {});
});

test("query builders: encoded, validated, month ranges", () => {
  assert.equal(U.rangeQuery("2026-10-01", "2026-10-31"), "?from=2026-10-01&to=2026-10-31");
  assert.equal(U.rangeQuery("2026-10-01", "2026-10-31", { user_id: "12" }), "?from=2026-10-01&to=2026-10-31&user_id=12");
  assert.equal(U.rangeQuery("bad", "2026-10-31"), "?to=2026-10-31");
  assert.equal(U.rangeQuery("2026-10-01", "2026-10-31", { user_id: "1 OR 1" }), "?from=2026-10-01&to=2026-10-31", "a user id is digits only");
  assert.equal(U.monthQuery("2026-10"), "?from=2026-10-01&to=2026-10-31");
  assert.equal(U.monthQuery("nope"), "");
  assert.equal(U.listQuery({ status: "pending", q: " a&b ", department: "" }, 3, 25), "?status=pending&q=a%26b&limit=25&offset=50");
  assert.equal(U.listQuery({}, 0, 25), "?limit=25&offset=0");
});

test("report flags: late / absent / open / needs_correction / holiday / leave in a stable order", () => {
  assert.deepEqual(U.reportFlags({ late: true, absent: false, open_session: false, needs_correction: false, holiday: false, on_leave: false, scheduled: true }), ["late"]);
  assert.deepEqual(U.reportFlags({ late: false, absent: true, scheduled: true }), ["absent"]);
  assert.deepEqual(U.reportFlags({ open_session: true, needs_correction: true, late: true }), ["late", "open", "needs_correction"]);
  assert.deepEqual(U.reportFlags({ holiday: true, scheduled: true }), ["holiday"]);
  assert.deepEqual(U.reportFlags({ on_leave: true, scheduled: true }), ["leave"]);
  assert.deepEqual(U.reportFlags({}), []);
});

test("calendarMonth: one row per person, cells for the days inside the month, half days on the right edge, holidays marked", () => {
  const entries = [
    { user_id: 2, full_name: "Zed", name_en: "Annual", name_fr: "Annuel", name_ar: "سنوية", leave_type_code: "ANNUAL", start_date: "2026-10-29", end_date: "2026-11-03", half_day_start: false, half_day_end: true, status: "approved" },
    { user_id: 1, full_name: "Amal", name_en: "Sick", name_fr: "Maladie", name_ar: "مرض", leave_type_code: "SICK", start_date: "2026-10-05", end_date: "2026-10-05", half_day_start: true, half_day_end: false, status: "pending" },
    { user_id: 1, full_name: "Amal", name_en: "Annual", name_fr: "Annuel", name_ar: "سنوية", leave_type_code: "ANNUAL", start_date: "2026-09-28", end_date: "2026-10-02", half_day_start: false, half_day_end: true, status: "approved" },
  ];
  const cal = U.calendarMonth("2026-10", entries, [{ day: "2026-10-15", name: "Evacuation Day" }]);
  assert.equal(cal.days.length, 31);
  assert.deepEqual(cal.days[0], { date: "2026-10-01", n: 1, weekday: "thu", holiday: null });
  assert.equal(cal.days[14].holiday, "Evacuation Day");
  assert.deepEqual(cal.people.map((p) => p.full_name), ["Amal", "Zed"], "sorted by name");
  const amal = cal.people[0];
  assert.deepEqual(Object.keys(amal.cells).sort(), ["2026-10-01", "2026-10-02", "2026-10-05"]);
  assert.equal(amal.cells["2026-10-02"].half, true, "half_day_end on the last day (2 Oct)");
  assert.equal(amal.cells["2026-10-01"].half, false);
  assert.equal(amal.cells["2026-10-05"].half, true);
  assert.equal(amal.cells["2026-10-05"].status, "pending");
  const zed = cal.people[1];
  assert.deepEqual(Object.keys(zed.cells).sort(), ["2026-10-29", "2026-10-30", "2026-10-31"], "the part of the range that falls in November is not in this month");
  assert.equal(zed.cells["2026-10-31"].half, false);
  assert.equal(U.calendarMonth("2026-10", [], []).people.length, 0);
  assert.equal(U.calendarMonth("nope", entries, []), null);
  assert.equal(U.typeName({ name_en: "Annual", name_fr: "Annuel", name_ar: "سنوية", code: "ANNUAL" }, "fr"), "Annuel");
  assert.equal(U.typeName({ name_en: "Annual", name_fr: "", name_ar: "", code: "ANNUAL" }, "ar"), "Annual");
  assert.equal(U.typeName({ code: "ANNUAL" }, "en"), "ANNUAL");
  // the calendar entries the API sends never carry a reason, and the helper never looks for one
  assert.doesNotMatch(read("hr-util.js"), /\.reason\b.*calendar|calendar.*\.reason\b/i);
});

// ---------------------------------------------------------------- contract with the real API

test("contract: payloads built by the helpers are accepted by the API; /hr/staff and /hr/me/leave-types behave per role", async () => {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  try {
    const mk = async (name, role, active = true) =>
      (await one("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x',$3,$4) RETURNING id", [name, `${name.replace(/\s/g, "")}@hrui.test.invalid`, role, active])).id;
    const hr = await mk("Hana Hr", "HR");
    const mgr = await mk("Mehdi Mgr", "Manager");
    const agent = await mk("Amel Agent", "Agent");
    await mk("Gone Agent", "Agent", false);
    const cand = await mk("Cand Idate", "Candidate");
    const tok = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const T = { hr: tok(hr, "HR"), mgr: tok(mgr, "Manager"), agent: tok(agent, "Agent"), cand: tok(cand, "Candidate") };
    const http = async (who, method, url, body) => {
      const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${T[who]}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    // --- staff list (hr:read) and active leave types (any active staff)
    const staff = await http("hr", "GET", "/hr/staff");
    assert.equal(staff.status, 200);
    assert.deepEqual(staff.body.rows.map((r) => r.full_name).sort(), ["Amel Agent", "Hana Hr", "Mehdi Mgr"], "active staff only: no candidates, no deactivated accounts");
    assert.deepEqual(Object.keys(staff.body.rows[0]).sort(), ["full_name", "has_profile", "role", "user_id"], "no e-mail addresses");
    assert.equal((await http("mgr", "GET", "/hr/staff")).status, 403);
    assert.equal((await http("agent", "GET", "/hr/staff")).status, 403);
    assert.ok([401, 403].includes((await http("cand", "GET", "/hr/staff")).status), "a Candidate is refused");
    assert.equal((await http(null, "GET", "/hr/staff")).status, 401);
    assert.equal((await http("hr", "GET", "/hr/staff?without_profile=maybe")).status, 400);

    // --- HR sets up a schedule, a leave type, a holiday, a profile and a balance with helper-built payloads
    const days = {};
    for (const d of U.DAYS) days[d] = { on: false, start: "", end: "", break_minutes: "" };
    for (const d of ["mon", "tue", "wed", "thu", "fri"]) days[d] = { on: true, start: "09:00", end: "17:30", break_minutes: "60" };
    const sp = U.schedulePayload({ name: "Office", grace_minutes: "10", timezone: "Africa/Tunis", days });
    assert.equal(sp.ok, true);
    const sched = await http("hr", "POST", "/hr/schedules", sp.payload);
    assert.equal(sched.status, 201, JSON.stringify(sched.body));
    assert.deepEqual(sched.body.weekly.mon, { start: "09:00", end: "17:30", break_minutes: 60 });
    const grid = U.scheduleToGrid(sched.body.weekly);
    assert.deepEqual(U.schedulePayload({ name: "Office", grace_minutes: "10", timezone: "Africa/Tunis", days: grid }).payload.weekly, sp.payload.weekly, "stored weekly -> grid -> payload round-trips");

    const ltp = U.leaveTypePayload({ code: "annual", name_ar: "سنوية", name_en: "Annual leave", name_fr: "Congé annuel", paid: true, counts_against_balance: true, requires_approval: true, active: true }, { creating: true });
    const lt = await http("hr", "POST", "/hr/leave-types", ltp.payload);
    assert.equal(lt.status, 201, JSON.stringify(lt.body));
    const ltp2 = U.leaveTypePayload({ code: "unpaid", name_ar: "بدون أجر", name_en: "Unpaid", name_fr: "Sans solde", paid: false, counts_against_balance: false, requires_approval: true, active: true }, { creating: true });
    const lt2 = await http("hr", "POST", "/hr/leave-types", ltp2.payload);
    assert.equal(lt2.status, 201);
    const ltOff = await http("hr", "POST", "/hr/leave-types", U.leaveTypePayload({ code: "old", name_ar: "قديم", name_en: "Old", name_fr: "Ancien", active: false }, { creating: true }).payload);
    assert.equal(ltOff.status, 201);
    const active = await http("agent", "GET", "/hr/me/leave-types");
    assert.equal(active.status, 200);
    assert.deepEqual(active.body.rows.map((r) => r.code), ["ANNUAL", "UNPAID"], "inactive types are not offered; a type without a balance row (UNPAID) is");
    assert.equal((await http("mgr", "GET", "/hr/me/leave-types")).status, 200);
    assert.ok([401, 403].includes((await http("cand", "GET", "/hr/me/leave-types")).status), "a Candidate is refused");
    assert.equal((await http(null, "GET", "/hr/me/leave-types")).status, 401);

    const hp = U.holidayPayload({ day: "2027-01-01", name: "New Year" });
    const hol = await http("hr", "POST", "/hr/holidays", hp.payload);
    assert.equal(hol.status, 201, JSON.stringify(hol.body));

    const ep = U.employeePayload({ user_id: String(agent), employee_no: "E-1", position: "Clerk", department: "Visa", hire_date: "2026-01-05", end_date: "", employment_type: "full_time", phone: "", emergency_contact_name: "", emergency_contact_phone: "", manager_user_id: String(mgr), schedule_id: String(sched.body.id), status: "active", notes: "hr only" }, { creating: true, withNotes: true });
    assert.equal(ep.ok, true, JSON.stringify(ep));
    const emp = await http("hr", "POST", "/hr/employees", ep.payload);
    assert.equal(emp.status, 201, JSON.stringify(emp.body));
    assert.equal(emp.body.manager_user_id, mgr);
    const without = await http("hr", "GET", "/hr/staff?without_profile=true");
    assert.deepEqual(without.body.rows.map((r) => r.full_name).sort(), ["Hana Hr", "Mehdi Mgr"]);
    const patch = U.changedFields(
      { position: "Clerk", department: "Visa" },
      U.employeePayload({ position: "Senior clerk", department: "Visa", status: "active" }, { creating: false }).payload
    );
    assert.deepEqual(patch, { position: "Senior clerk", status: "active" });
    assert.equal((await http("hr", "PATCH", `/hr/employees/${agent}`, patch)).status, 200);

    const bp = U.balancePayload({ user_id: String(agent), leave_type_id: String(lt.body.id), year: "2026", entitled_days: "21", adjusted_days: "-1.5" });
    const bal = await http("hr", "PUT", "/hr/balances", bp.payload);
    assert.equal(bal.status, 200, JSON.stringify(bal.body));
    assert.equal(bal.body.entitled_days, "21.00");
    assert.equal(bal.body.adjusted_days, "-1.50");

    // --- the employee: /hr/me shows the balance, a helper-built correction and leave request are accepted
    const me = await http("agent", "GET", "/hr/me");
    assert.equal(me.status, 200);
    const tz = U.effectiveTz(me.body);
    assert.equal(tz, "Africa/Tunis");
    assert.equal(me.body.balances.length, 1);
    assert.equal(U.formatDays(me.body.balances[0].entitled_days), "21");
    assert.equal(U.formatDays(me.body.balances[0].available_days), "19.5");
    const today = U.localDate(Date.now(), tz);
    const yesterday = U.addDays(today, -1);
    const cp = U.correctionPayload({ date: yesterday, in: "09:00", out: "17:00", nextDay: false, reason: "Forgot to clock" }, tz, today);
    assert.equal(cp.ok, true);
    const cor = await http("agent", "POST", "/hr/me/corrections", cp.payload);
    assert.equal(cor.status, 201, JSON.stringify(cor.body));
    assert.equal(U.formatTime(cor.body.requested_in, tz, "en-GB"), "09:00", "what the employee typed is what comes back, in the company zone");

    // next Monday at least a week ahead, Monday..Tuesday with a half day at the end: 1.5 working days
    let start = U.addDays(today, 8);
    while (U.weekdayKey(start) !== "mon") start = U.addDays(start, 1);
    const lp = U.leavePayload({ leave_type_id: String(lt.body.id), start_date: start, end_date: U.addDays(start, 1), half_start: false, half_end: true, reason: "Family" });
    assert.equal(lp.ok, true);
    const lr = await http("agent", "POST", "/hr/me/leave-requests", lp.payload);
    assert.equal(lr.status, 201, JSON.stringify(lr.body));
    assert.equal(U.formatDays(lr.body.days), "1.5", "the server computes the days; the console only formats them");
    assert.equal(U.canCancelLeave(lr.body, today), true);
    // the same dates again: the server's overlap message is what the console shows
    const dup = await http("agent", "POST", "/hr/me/leave-requests", lp.payload);
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /overlap/i);
    // the manager sees the request, decides it with a helper-built payload; the balance then shows it as used
    const team = await http("mgr", "GET", "/hr/team/leave-requests?status=pending");
    assert.equal(team.status, 200);
    assert.equal(team.body.rows.length, 1);
    assert.equal(U.isOwn(team.body.rows[0], mgr), false);
    const dp = U.decisionPayload("approved", "Enjoy");
    assert.equal((await http("mgr", "POST", `/hr/leave-requests/${lr.body.id}/decide`, dp.payload)).status, 200);
    const me2 = await http("agent", "GET", "/hr/me");
    assert.equal(U.formatDays(me2.body.balances[0].used_days), "1.5");
    // the calendar shows the leave without any reason
    const calRes = await http("agent", "GET", `/hr/team/calendar${U.rangeQuery(start, U.addDays(start, 1))}`);
    assert.equal(calRes.status, 200);
    assert.equal(calRes.body.entries.length, 1);
    assert.equal(JSON.stringify(calRes.body).includes("Family"), false);
    const calMonth = U.calendarMonth(U.monthOf(start), calRes.body.entries, calRes.body.holidays);
    assert.equal(calMonth.people.length, 1);
    // the server's error messages for limits the helper does not duplicate surface as plain text
    const longRange = await http("agent", "POST", "/hr/me/leave-requests", { ...lp.payload, start_date: U.addDays(start, 400), end_date: U.addDays(start, 402) });
    assert.ok([400, 409].includes(longRange.status));
    assert.equal(typeof longRange.body.error, "string");
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
});

test("hr-admin.js: the attendance section lists stale open sessions and closes them through the API (hr:write only), keys in ar/en/fr", () => {
  const src = read("hr-admin.js");
  assert.match(src, /V\.api\("GET", "\/hr\/attendance\/open/);
  assert.match(src, /"\/hr\/attendance\/" \+ r\.id \+ "\/close"/);
  assert.match(src, /canWrite\(\) \? h\("button"[^;]*hr\.open\.close/, "the Close button is only built for hr:write callers");
  for (const k of ["hr.open.title", "hr.open.hint", "hr.open.none", "hr.open.close", "hr.open.dialog", "hr.open.dialogHint", "hr.open.closed", "hr.open.invalid"]) {
    for (const l of LANGS) assert.ok(I18N.dictionaries[l][k] && I18N.dictionaries[l][k].length > 3, `${l}:${k}`);
  }
});
