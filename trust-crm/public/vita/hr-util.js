/* HR console helpers: permission mirror, durations, company-time display, leave-day strings, payload builders and query
   builders. Pure data/logic only (no DOM): loaded as a classic script in the browser (window.VITA_HR_UTIL) and required by
   tests/hr-ui.test.js. The server stays the authority on every rule mirrored here.

   Rules the helpers follow:
   - durations are whole minutes handled by integer arithmetic ("2h 05m"); day counts are decimal STRINGS ("1.50") that
     are formatted by string operations and never parsed as floats; the console never adds leave days, the server does;
   - every clock time is shown in an explicit zone through Intl.DateTimeFormat({ timeZone }): the schedule's zone, else the
     company zone returned by /hr/me, else Africa/Tunis. The machine's own zone is never used for HR times;
   - calendar-date arithmetic works on YYYY-MM-DD strings through UTC fields, so the viewer's zone cannot shift a day. */
(function (root) {
  "use strict";

  var CU = root.VITA_CRM_UTIL || (typeof require === "function" ? require("./crm-util.js") : null);

  var DEFAULT_TZ = "Africa/Tunis";
  var DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  var STAFF_ROLES = ["SuperAdmin", "Admin", "Manager", "Receptionist", "Accountant", "HR", "Agent"]; // middleware/staff.js
  var STATUSES = ["pending", "approved", "rejected", "cancelled"];
  var LIMITS = { reason: 500, note: 500, graceMax: 120, breakMax: 720, typeName: 120, holidayName: 160, scheduleName: 120, maxBackDays: 60, maxSpanMinutes: 1440, listMax: 100, daysMax: 366 };
  var EMP_TEXT = { employee_no: 40, position: 120, department: 120, employment_type: 40, phone: 40, emergency_contact_name: 120, emergency_contact_phone: 40, notes: 4000 };

  // ---------------------------------------------------------------- permissions (mirror of middleware/role.js)
  function can(role, perm) { return Boolean(CU) && CU.can(role, perm); }
  function canRead(role) { return can(role, "hr:read"); }
  function canWrite(role) { return can(role, "hr:write"); }
  function canApprove(role) { return can(role, "hr:approve"); }
  /** Every active staff role is an employee (self-service); Candidate / Employer / Agency are not. */
  function isStaffRole(role) { return typeof role === "string" && STAFF_ROLES.indexOf(role) >= 0; }

  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function trimmed(v) { return typeof v === "string" ? v.trim() : ""; }
  function fail(field, code) { return { ok: false, field: field, code: code }; }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  // ---------------------------------------------------------------- durations (integers only)
  /** Whole minutes -> "Hh MMm". Anything that is not a whole non-negative number (or digit string) -> "—". */
  function formatDuration(minutes) {
    var n;
    if (typeof minutes === "number") {
      if (!isFinite(minutes) || Math.floor(minutes) !== minutes) return "—";
      n = minutes;
    } else if (typeof minutes === "string" && /^\d{1,12}$/.test(minutes)) {
      n = Number(minutes);
    } else {
      return "—";
    }
    if (n < 0) return "—";
    return Math.floor(n / 60) + "h " + pad2(n % 60) + "m";
  }

  function toMs(value) {
    if (typeof value === "number") return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string" && value) return Date.parse(value);
    return NaN;
  }

  /** Minutes worked in `records` as of nowMs: closed sessions use the server's figure, an open one counts up to now (never negative). */
  function workedSoFar(records, nowMs) {
    var total = 0;
    (Array.isArray(records) ? records : []).forEach(function (r) {
      if (!r) return;
      if (r.clock_out === null || r.clock_out === undefined) {
        var start = toMs(r.clock_in);
        if (isFinite(start) && isFinite(nowMs)) total += Math.max(0, Math.floor((nowMs - start) / 60000));
      } else if (typeof r.worked_minutes === "number" && Math.floor(r.worked_minutes) === r.worked_minutes) {
        total += r.worked_minutes;
      } else {
        var a = toMs(r.clock_in), b = toMs(r.clock_out);
        if (isFinite(a) && isFinite(b) && b > a) total += Math.floor((b - a) / 60000);
      }
    });
    return total;
  }
  /** The record that is still open (clock_out null), if any. */
  function openRecord(records) {
    var list = Array.isArray(records) ? records : [];
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i] && (list[i].clock_out === null || list[i].clock_out === undefined)) return list[i];
    }
    return null;
  }

  // ---------------------------------------------------------------- time zones
  function validTz(tz) {
    if (typeof tz !== "string" || !tz.trim()) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch (e) {
      return false;
    }
  }
  function resolveTz(tz) { return validTz(tz) ? tz : DEFAULT_TZ; }
  /** The zone HR times are shown in: the schedule's, else the company zone from /hr/me, else Africa/Tunis. */
  function effectiveTz(me) {
    if (me && me.schedule && validTz(me.schedule.timezone)) return me.schedule.timezone;
    if (me && validTz(me.timezone)) return me.timezone;
    return DEFAULT_TZ;
  }

  var fmtCache = {};
  function dtf(locale, tz, key, opts) {
    var k = locale + "|" + tz + "|" + key;
    if (!fmtCache[k]) {
      var o = {};
      Object.keys(opts).forEach(function (x) { o[x] = opts[x]; });
      o.timeZone = tz;
      fmtCache[k] = new Intl.DateTimeFormat(locale, o);
    }
    return fmtCache[k];
  }

  /** Wall-clock fields of an instant in a zone. */
  function partsIn(ms, tz) {
    var f = dtf("en-CA", tz, "parts", { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    var o = {};
    f.formatToParts(new Date(ms)).forEach(function (p) { if (p.type !== "literal") o[p.type] = Number(p.value); });
    if (o.hour === 24) o.hour = 0;
    return o;
  }
  function offsetMinutes(ms, tz) {
    var p = partsIn(ms, tz);
    var asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  }

  /** "HH:MM" (24 h) of an instant in `tz`. */
  function formatTime(value, tz, locale) {
    var ms = toMs(value);
    if (!isFinite(ms)) return "—";
    try {
      return dtf(locale || "en-GB", resolveTz(tz), "hm", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
    } catch (e) {
      return "—";
    }
  }
  /** "HH:MM:SS" (24 h) of an instant in `tz` (the live clock). */
  function formatClock(value, tz, locale) {
    var ms = toMs(value);
    if (!isFinite(ms)) return "—";
    try {
      return dtf(locale || "en-GB", resolveTz(tz), "hms", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(ms));
    } catch (e) {
      return "—";
    }
  }
  /** YYYY-MM-DD of an instant in `tz`. */
  function localDate(value, tz) {
    var ms = toMs(value);
    if (!isFinite(ms)) return null;
    var p = partsIn(ms, resolveTz(tz));
    return p.year + "-" + pad2(p.month) + "-" + pad2(p.day);
  }
  /** "YYYY-MM-DD HH:MM" in `tz` (language-neutral, used in tables). */
  function formatStamp(value, tz) {
    var ms = toMs(value);
    if (!isFinite(ms)) return "—";
    return localDate(ms, tz) + " " + formatTime(ms, tz, "en-GB");
  }
  /** Long date for the clock card, in the viewer's language but in `tz`. */
  function formatLongDate(value, tz, locale) {
    var ms = toMs(value);
    if (!isFinite(ms)) return "—";
    try {
      return dtf(locale || "en-GB", resolveTz(tz), "long", { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date(ms));
    } catch (e) {
      return localDate(ms, tz);
    }
  }

  /** Wall-clock date + "HH:MM" in `tz` -> ISO instant with that zone's offset ("2026-10-24T09:00:00+01:00"); null when malformed. */
  function zonedIso(date, hhmm, tz) {
    if (!isDate(date) || typeof hhmm !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null;
    var z = resolveTz(tz);
    var y = Number(date.slice(0, 4)), mo = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
    var hh = Number(hhmm.slice(0, 2)), mm = Number(hhmm.slice(3, 5));
    var wall = Date.UTC(y, mo - 1, d, hh, mm);
    var off = offsetMinutes(wall, z);
    var inst = wall - off * 60000;
    var off2 = offsetMinutes(inst, z);
    if (off2 !== off) { inst = wall - off2 * 60000; off = offsetMinutes(inst, z); }
    var sign = off < 0 ? "-" : "+";
    var abs = Math.abs(off);
    return date + "T" + hhmm + ":00" + sign + pad2(Math.floor(abs / 60)) + ":" + pad2(abs % 60);
  }

  /** Milliseconds to add to Date.now() to get the server's time, from the response's Date header (second precision). */
  function serverOffset(dateHeader, localMs) {
    var s = typeof dateHeader === "string" ? Date.parse(dateHeader) : NaN;
    return isFinite(s) && isFinite(localMs) ? s - localMs : 0;
  }

  // ---------------------------------------------------------------- calendar dates as YYYY-MM-DD strings
  function isDate(s) {
    if (typeof s !== "string") return false;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  function utcOf(s) { return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))); }
  function addDays(s, n) {
    if (!isDate(s) || Math.floor(n) !== n) return null;
    return new Date(utcOf(s) + n * 86400000).toISOString().slice(0, 10);
  }
  /** Whole days from a to b (b - a). */
  function diffDays(a, b) {
    if (!isDate(a) || !isDate(b)) return null;
    return Math.round((utcOf(b) - utcOf(a)) / 86400000);
  }
  function compareDates(a, b) {
    if (!isDate(a) || !isDate(b)) return null;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function weekdayKey(s) {
    if (!isDate(s)) return null;
    return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(utcOf(s)).getUTCDay()];
  }
  function monthBounds(ym) {
    var m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(typeof ym === "string" ? ym : "");
    if (!m) return null;
    var last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    return { from: ym + "-01", to: ym + "-" + pad2(last) };
  }
  function shiftMonth(ym, n) {
    var m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(typeof ym === "string" ? ym : "");
    if (!m || Math.floor(n) !== n) return null;
    var total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
    return Math.floor(total / 12) + "-" + pad2((total % 12) + 1);
  }
  function monthOf(date) { return isDate(date) ? date.slice(0, 7) : null; }
  /** "October 2026" in the viewer's language (the month is a calendar fact: formatted in UTC so no zone can shift it). */
  function monthLabel(ym, locale) {
    var b = monthBounds(ym);
    if (!b) return "—";
    try {
      return new Intl.DateTimeFormat(locale || "en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1)));
    } catch (e) {
      return ym;
    }
  }

  // ---------------------------------------------------------------- day counts (decimal strings)
  var DEC = /^(-?)(\d+)(?:\.(\d+))?$/;
  /** "2.50" -> "2.5", "3.00" -> "3". Anything that is not a plain decimal string -> "—". */
  function formatDays(value) {
    if (typeof value !== "string") return "—";
    var m = DEC.exec(value.trim());
    if (!m) return "—";
    var int = m[2].replace(/^0+(?=\d)/, "");
    var frac = (m[3] || "").replace(/0+$/, "");
    var zero = int === "0" && frac === "";
    return (m[1] === "-" && !zero ? "-" : "") + int + (frac ? "." + frac : "");
  }
  /** Days typed by a person: up to 2 decimals, 0..366 (negative only for adjustments) -> "N.NN". */
  function parseDaysInput(raw, opts) {
    var allowNegative = Boolean(opts && opts.allowNegative);
    if (typeof raw !== "string" || !raw.trim()) return { ok: false, code: "required" };
    var m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
    if (!m) return { ok: false, code: "number" };
    if (m[1] === "-" && !allowNegative) return { ok: false, code: "number" };
    var int = m[2].replace(/^0+(?=\d)/, "");
    var frac = m[3] || "";
    while (frac.length < 2) frac += "0";
    if (int.length > 3 || Number(int) > LIMITS.daysMax || (Number(int) === LIMITS.daysMax && frac !== "00")) return { ok: false, code: "range" };
    var zero = int === "0" && frac === "00";
    return { ok: true, value: (m[1] === "-" && !zero ? "-" : "") + int + "." + frac };
  }

  // ---------------------------------------------------------------- payload builders
  function parseTime(v) { return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? v.trim() : null; }
  function posInt(raw) {
    var s = typeof raw === "number" ? String(raw) : trimmed(raw);
    return /^[1-9]\d{0,9}$/.test(s) && Number(s) <= 2147483647 ? Number(s) : null;
  }

  /** Form values of the correction dialog -> API body (instants carry the zone's offset). `today` (company zone) enables the date window checks. */
  function correctionPayload(f, tz, today) {
    var v = f || {};
    var date = trimmed(v.date);
    if (!date) return fail("date", "required");
    if (!isDate(date)) return fail("date", "invalid");
    if (isDate(today)) {
      if (date > today) return fail("date", "future");
      if (diffDays(date, today) > LIMITS.maxBackDays) return fail("date", "past");
    }
    var tin = trimmed(v.in);
    if (!tin) return fail("in", "required");
    if (!parseTime(tin)) return fail("in", "invalid");
    var tout = trimmed(v.out);
    var out = {};
    var inIso = zonedIso(date, tin, tz);
    var outIso = null;
    if (!tout) {
      if (!isDate(today) || date !== today) return fail("out", "required");
    } else {
      if (!parseTime(tout)) return fail("out", "invalid");
      outIso = zonedIso(v.nextDay ? addDays(date, 1) : date, tout, tz);
      var span = Date.parse(outIso) - Date.parse(inIso);
      if (!(span > 0)) return fail("out", "order");
      if (span > LIMITS.maxSpanMinutes * 60000) return fail("out", "range");
    }
    var reason = trimmed(v.reason);
    if (!reason) return fail("reason", "required");
    if (reason.length > LIMITS.reason) return fail("reason", "long");
    out.work_date = date;
    out.requested_in = inIso;
    if (outIso) out.requested_out = outIso;
    out.reason = reason;
    return { ok: true, payload: out };
  }

  function leavePayload(f) {
    var v = f || {};
    var tid = trimmed(str(v.leave_type_id));
    if (!tid) return fail("leave_type_id", "required");
    var typeId = posInt(tid);
    if (typeId === null) return fail("leave_type_id", "invalid");
    var start = trimmed(v.start_date), end = trimmed(v.end_date);
    if (!start) return fail("start_date", "required");
    if (!isDate(start)) return fail("start_date", "invalid");
    if (!end) return fail("end_date", "required");
    if (!isDate(end)) return fail("end_date", "invalid");
    if (end < start) return fail("end_date", "order");
    var hs = Boolean(v.half_start), he = Boolean(v.half_end);
    if (start === end && hs && he) return fail("half_end", "halfSingle");
    var reason = trimmed(v.reason);
    if (reason.length > LIMITS.reason) return fail("reason", "long");
    var out = { leave_type_id: typeId, start_date: start, end_date: end, half_day_start: hs, half_day_end: he };
    if (reason) out.reason = reason;
    return { ok: true, payload: out };
  }

  function decisionPayload(decision, note) {
    if (decision !== "approved" && decision !== "rejected") return fail("decision", "invalid");
    var n = trimmed(note);
    if (n.length > LIMITS.note) return fail("note", "long");
    var out = { decision: decision };
    if (n) out.note = n;
    return { ok: true, payload: out };
  }

  function canCancelLeave(req, today) {
    if (!req) return false;
    if (req.status === "pending") return true;
    return req.status === "approved" && isDate(req.start_date) && isDate(today) && req.start_date > today;
  }
  function canCancelCorrection(c) { return Boolean(c) && c.status === "pending"; }
  function isOwn(row, userId) { return userId !== undefined && userId !== null && Boolean(row) && Number(row.user_id) === Number(userId); }

  // --- schedule
  function emptyDay() { return { on: false, start: "", end: "", break_minutes: "" }; }
  function scheduleToGrid(weekly) {
    var w = weekly && typeof weekly === "object" ? weekly : {};
    var grid = {};
    DAYS.forEach(function (d) {
      var e = w[d];
      grid[d] = e && typeof e === "object"
        ? { on: true, start: str(e.start), end: str(e.end), break_minutes: e.break_minutes === undefined || e.break_minutes === null ? "" : String(e.break_minutes) }
        : emptyDay();
    });
    return grid;
  }
  function describeDay(e) {
    if (!e || typeof e !== "object") return null;
    return e.start + "–" + e.end + " (" + (e.break_minutes || 0) + ")";
  }
  function minutesOf(hhmm) { return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)); }
  function schedulePayload(f) {
    var v = f || {};
    var name = trimmed(v.name);
    if (!name) return fail("name", "required");
    if (name.length > LIMITS.scheduleName) return fail("name", "long");
    var g = trimmed(str(v.grace_minutes));
    if (!g) return fail("grace_minutes", "required");
    if (!/^\d+$/.test(g)) return fail("grace_minutes", "number");
    if (Number(g) > LIMITS.graceMax) return fail("grace_minutes", "range");
    var out = { name: name, grace_minutes: Number(g) };
    var tz = trimmed(v.timezone);
    if (tz) {
      if (!validTz(tz)) return fail("timezone", "invalid");
      out.timezone = tz;
    }
    var weekly = {};
    var days = v.days || {};
    for (var i = 0; i < DAYS.length; i++) {
      var d = DAYS[i];
      var e = days[d];
      if (!e || !e.on) { weekly[d] = null; continue; }
      var start = trimmed(e.start), end = trimmed(e.end);
      if (!start) return fail("weekly." + d + ".start", "required");
      if (!parseTime(start)) return fail("weekly." + d + ".start", "invalid");
      if (!end) return fail("weekly." + d + ".end", "required");
      if (!parseTime(end)) return fail("weekly." + d + ".end", "invalid");
      if (minutesOf(end) <= minutesOf(start)) return fail("weekly." + d + ".end", "order");
      var b = trimmed(str(e.break_minutes));
      var brk = 0;
      if (b) {
        if (!/^\d+$/.test(b)) return fail("weekly." + d + ".break_minutes", "number");
        brk = Number(b);
        if (brk > LIMITS.breakMax || brk >= minutesOf(end) - minutesOf(start)) return fail("weekly." + d + ".break_minutes", "range");
      }
      weekly[d] = { start: start, end: end, break_minutes: brk };
    }
    out.weekly = weekly;
    return { ok: true, payload: out };
  }

  // --- leave types, holidays, balances
  function leaveTypePayload(f, o) {
    var v = f || {};
    var creating = Boolean(o && o.creating);
    var out = {};
    if (creating) {
      var code = trimmed(v.code).toUpperCase();
      if (!code) return fail("code", "required");
      if (!/^[A-Z0-9_-]{2,30}$/.test(code)) return fail("code", "invalid");
      out.code = code;
    }
    var names = ["name_ar", "name_en", "name_fr"];
    for (var i = 0; i < names.length; i++) {
      var n = trimmed(v[names[i]]);
      if (!n) {
        if (creating || v[names[i]] !== undefined) return fail(names[i], "required");
        continue;
      }
      if (n.length > LIMITS.typeName) return fail(names[i], "long");
      out[names[i]] = n;
    }
    ["paid", "counts_against_balance", "requires_approval", "active"].forEach(function (k) { if (typeof v[k] === "boolean") out[k] = v[k]; });
    return { ok: true, payload: out };
  }
  function holidayPayload(f) {
    var v = f || {};
    var day = trimmed(v.day);
    if (!day) return fail("day", "required");
    if (!isDate(day)) return fail("day", "invalid");
    var name = trimmed(v.name);
    if (!name) return fail("name", "required");
    if (name.length > LIMITS.holidayName) return fail("name", "long");
    return { ok: true, payload: { day: day, name: name } };
  }
  function balancePayload(f) {
    var v = f || {};
    var uid = trimmed(str(v.user_id));
    if (!uid) return fail("user_id", "required");
    var userId = posInt(uid);
    if (userId === null) return fail("user_id", "invalid");
    var tid = trimmed(str(v.leave_type_id));
    if (!tid) return fail("leave_type_id", "required");
    var typeId = posInt(tid);
    if (typeId === null) return fail("leave_type_id", "invalid");
    var yr = trimmed(str(v.year));
    if (!yr) return fail("year", "required");
    if (!/^\d{4}$/.test(yr) || Number(yr) < 2000 || Number(yr) > 2200) return fail("year", "range");
    var ent = parseDaysInput(str(v.entitled_days));
    if (!ent.ok) return fail("entitled_days", ent.code);
    var out = { user_id: userId, leave_type_id: typeId, year: Number(yr), entitled_days: ent.value };
    if (trimmed(str(v.adjusted_days)) !== "") {
      var adj = parseDaysInput(str(v.adjusted_days), { allowNegative: true });
      if (!adj.ok) return fail("adjusted_days", adj.code);
      out.adjusted_days = adj.value;
    }
    return { ok: true, payload: out };
  }

  // --- employee profile
  function employeePayload(f, o) {
    var v = f || {};
    var creating = Boolean(o && o.creating);
    var withNotes = !o || o.withNotes !== false;
    var out = {};
    if (creating) {
      var uid = trimmed(str(v.user_id));
      if (!uid) return fail("user_id", "required");
      var id = posInt(uid);
      if (id === null) return fail("user_id", "invalid");
      out.user_id = id;
    }
    var textKeys = Object.keys(EMP_TEXT);
    for (var i = 0; i < textKeys.length; i++) {
      var k = textKeys[i];
      if (v[k] === undefined) continue;
      if (k === "notes" && !withNotes) continue;
      var t = trimmed(str(v[k]));
      if (t.length > EMP_TEXT[k]) return fail(k, "long");
      out[k] = t === "" ? null : t;
    }
    var dates = ["hire_date", "end_date"];
    for (var j = 0; j < dates.length; j++) {
      var dk = dates[j];
      if (v[dk] === undefined) continue;
      var dv = trimmed(str(v[dk]));
      if (dv === "") { out[dk] = null; continue; }
      if (!isDate(dv)) return fail(dk, "invalid");
      out[dk] = dv;
    }
    if (out.hire_date && out.end_date && out.end_date < out.hire_date) return fail("end_date", "order");
    if (v.status !== undefined) {
      if (v.status !== "active" && v.status !== "inactive") return fail("status", "invalid");
      out.status = v.status;
    }
    var refs = ["manager_user_id", "schedule_id"];
    for (var r = 0; r < refs.length; r++) {
      var rk = refs[r];
      if (v[rk] === undefined) continue;
      var rv = trimmed(str(v[rk]));
      if (rv === "") { out[rk] = null; continue; }
      var rid = posInt(rv);
      if (rid === null) return fail(rk, "invalid");
      out[rk] = rid;
    }
    return { ok: true, payload: out };
  }
  /** Only the keys of `next` whose value differs from `base` (a missing key and null are the same). */
  function changedFields(base, next) {
    var out = {};
    var b = base || {};
    Object.keys(next || {}).forEach(function (k) {
      var a = b[k] === undefined ? null : b[k];
      var c = next[k] === undefined ? null : next[k];
      if (a !== c) out[k] = next[k];
    });
    return out;
  }

  // ---------------------------------------------------------------- query builders
  function dateParam(parts, key, v) { if (isDate(v)) parts.push(key + "=" + v); }
  function rangeQuery(from, to, extra) {
    var parts = [];
    dateParam(parts, "from", from);
    dateParam(parts, "to", to);
    var uid = extra && extra.user_id !== undefined && extra.user_id !== null ? trimmed(str(extra.user_id)) : "";
    if (/^[1-9]\d{0,9}$/.test(uid)) parts.push("user_id=" + uid);
    return parts.length ? "?" + parts.join("&") : "";
  }
  function monthQuery(ym) {
    var b = monthBounds(ym);
    return b ? "?from=" + b.from + "&to=" + b.to : "";
  }
  function listQuery(filters, page, pageSize) {
    var f = filters || {};
    var size = Math.max(1, Math.min(LIMITS.listMax, Math.floor(Number(pageSize) || 25)));
    var p = Math.max(1, Math.floor(Number(page) || 1));
    var parts = [];
    Object.keys(f).forEach(function (k) {
      var v = trimmed(str(f[k]));
      if (k === "q") v = v.slice(0, 100).trim();
      if (v) parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    });
    parts.push("limit=" + size, "offset=" + (p - 1) * size);
    return "?" + parts.join("&");
  }

  // ---------------------------------------------------------------- display helpers
  function statusClass(status) {
    return { pending: "warn", approved: "ok", rejected: "bad", cancelled: "neutral" }[status] || "neutral";
  }
  /** Localised leave type name with fallbacks (the viewer's language, then English, French, Arabic, then the code). */
  function typeName(t, lang) {
    if (!t) return "";
    return str(t["name_" + lang]) || str(t.name_en) || str(t.name_fr) || str(t.name_ar) || str(t.code || t.leave_type_code);
  }
  /** Flags of an attendance report row, in a stable order. */
  function reportFlags(r) {
    var row = r || {};
    var out = [];
    if (row.late) out.push("late");
    if (row.absent) out.push("absent");
    if (row.open_session) out.push("open");
    if (row.needs_correction) out.push("needs_correction");
    if (row.holiday && row.scheduled) out.push("holiday");
    else if (row.on_leave && row.scheduled) out.push("leave");
    return out;
  }

  /**
   * Month grid for the team calendar: {days:[{date,n,weekday,holiday}], people:[{user_id,full_name,cells:{date:{status,half,entry}}}]}.
   * Only the part of a leave that falls inside the month is drawn; half-day flags apply to the first / last day of the leave.
   * The calendar API never sends reasons and this helper never reads one.
   */
  function calendarMonth(ym, entries, holidays) {
    var b = monthBounds(ym);
    if (!b) return null;
    var hol = {};
    (Array.isArray(holidays) ? holidays : []).forEach(function (x) { if (x && x.day) hol[x.day] = x.name || ""; });
    var days = [];
    for (var d = b.from, n = 1; d <= b.to; d = addDays(d, 1), n++) {
      days.push({ date: d, n: n, weekday: weekdayKey(d), holiday: Object.prototype.hasOwnProperty.call(hol, d) ? hol[d] : null });
    }
    var byUser = {};
    (Array.isArray(entries) ? entries : []).forEach(function (e) {
      if (!e || !isDate(e.start_date) || !isDate(e.end_date)) return;
      var p = byUser[e.user_id] || (byUser[e.user_id] = { user_id: e.user_id, full_name: str(e.full_name), cells: {} });
      var from = e.start_date < b.from ? b.from : e.start_date;
      var to = e.end_date > b.to ? b.to : e.end_date;
      for (var x = from; x <= to; x = addDays(x, 1)) {
        var half = (x === e.start_date && Boolean(e.half_day_start)) || (x === e.end_date && Boolean(e.half_day_end));
        var prev = p.cells[x];
        if (prev && prev.status === "approved" && e.status !== "approved") continue;
        p.cells[x] = { status: e.status, half: half, entry: e };
      }
    });
    var people = Object.keys(byUser).map(function (k) { return byUser[k]; });
    people.sort(function (a, c) { return a.full_name < c.full_name ? -1 : a.full_name > c.full_name ? 1 : a.user_id - c.user_id; });
    return { days: days, people: people };
  }

  var api = {
    DEFAULT_TZ: DEFAULT_TZ, DAYS: DAYS, STAFF_ROLES: STAFF_ROLES, STATUSES: STATUSES, LIMITS: LIMITS,
    can: can, canRead: canRead, canWrite: canWrite, canApprove: canApprove, isStaffRole: isStaffRole,
    formatDuration: formatDuration, workedSoFar: workedSoFar, openRecord: openRecord,
    validTz: validTz, effectiveTz: effectiveTz, formatTime: formatTime, formatClock: formatClock, localDate: localDate, formatStamp: formatStamp, formatLongDate: formatLongDate,
    zonedIso: zonedIso, serverOffset: serverOffset,
    isDate: isDate, addDays: addDays, diffDays: diffDays, compareDates: compareDates, weekdayKey: weekdayKey, monthBounds: monthBounds, shiftMonth: shiftMonth, monthOf: monthOf, monthLabel: monthLabel,
    formatDays: formatDays, parseDaysInput: parseDaysInput,
    correctionPayload: correctionPayload, leavePayload: leavePayload, decisionPayload: decisionPayload,
    canCancelLeave: canCancelLeave, canCancelCorrection: canCancelCorrection, isOwn: isOwn,
    schedulePayload: schedulePayload, scheduleToGrid: scheduleToGrid, describeDay: describeDay,
    leaveTypePayload: leaveTypePayload, holidayPayload: holidayPayload, balancePayload: balancePayload, employeePayload: employeePayload, changedFields: changedFields,
    rangeQuery: rangeQuery, monthQuery: monthQuery, listQuery: listQuery,
    statusClass: statusClass, typeName: typeName, reportFlags: reportFlags, calendarMonth: calendarMonth,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VITA_HR_UTIL = api;
})(typeof window !== "undefined" ? window : this);
