/* HR tab > HR admin (hr:read, with edits for hr:write): employee profiles, working schedules, leave types, public holidays,
   leave balances, the attendance report (with an authenticated CSV download) and the leave report.
   Everything shown is data entered by the owner / HR: the console invents no labour rules, no leave types and no holidays.
   The HR-only `notes` field is requested, shown and sent only for callers holding hr:read. Day counts and balances are the
   API's decimal strings. Server text is rendered as text only; the server is the authority on every call. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var HR = window.VITA_HR;
  var HU = window.VITA_HR_UTIL;
  var t = V.t, h = V.h, $ = V.$;

  var SECS = ["employees", "schedules", "leaveTypes", "holidays", "balances", "attReport", "leaveReport"];
  var PAGE = 25;
  var ROW_CAP = 500;
  var AD = {
    sec: "employees", built: false,
    emp: { filters: { q: "", status: "", department: "" }, page: 1, data: null, noProfile: null },
    schedules: null, leaveTypes: null,
    hol: { year: null, data: null },
    bal: { userId: "", year: null, data: null, types: null },
    rep: { from: "", to: "", userId: "", problems: false, data: null, status: "" },
    lrep: { year: null, page: 1, data: null },
  };

  function canWrite() { return HU.canWrite(HR.role()); }
  function canRead() { return HU.canRead(HR.role()); }

  // ================================================================ shell + sub navigation
  function build() {
    var nav = h("div", { class: "btn-row hr-subnav", attrs: { role: "group", "aria-label": t("hr.admin.sections") } },
      SECS.map(function (s) {
        var b = h("button", { type: "button", class: "btn secondary small", id: "hr-ad-nav-" + s, text: t("hr.admin.sec." + s), attrs: { "aria-pressed": String(s === AD.sec) } });
        b.addEventListener("click", function () { showSec(s); });
        return b;
      }));
    V.setContent($("#hr-sec-admin"),
      h("div", { class: "card" }, h("h2", { text: t("hr.admin.title") }), h("p", { class: "notice info small", text: t("hr.admin.hint") }), nav),
      SECS.map(function (s) { return h("div", { id: "hr-ad-" + s, hidden: s !== AD.sec }); })
    );
    SECS.forEach(function (s) { SECTION[s].build(); });
  }
  function showSec(name) {
    AD.sec = name;
    SECS.forEach(function (s) {
      var box = $("#hr-ad-" + s);
      if (box) box.hidden = s !== name;
      var b = $("#hr-ad-nav-" + s);
      if (b) b.setAttribute("aria-pressed", String(s === name));
    });
    SECTION[name].load();
  }

  // ---------------------------------------------------------------- shared data (small lists used by several sections)
  function loadSchedules(force) {
    if (AD.schedules && !force) return Promise.resolve(AD.schedules);
    return V.api("GET", "/hr/schedules?limit=100").then(function (d) { AD.schedules = (d && d.rows) || []; return AD.schedules; });
  }
  function loadLeaveTypes(force) {
    if (AD.leaveTypes && !force) return Promise.resolve(AD.leaveTypes);
    return V.api("GET", "/hr/leave-types").then(function (d) { AD.leaveTypes = (d && d.rows) || []; return AD.leaveTypes; });
  }
  function staffItems(withAny, exclude) {
    var items = (HR.staff || []).filter(function (s) { return s.user_id !== exclude; }).map(function (s) { return [String(s.user_id), s.full_name + " (" + t("role." + s.role) + ")"]; });
    return withAny ? [["", withAny]].concat(items) : items;
  }
  function yearNav(prefix, getYear, setYear, onChange) {
    var prev = h("button", { type: "button", class: "btn secondary small", id: prefix + "-prev", text: t("common.prev") });
    var next = h("button", { type: "button", class: "btn secondary small", id: prefix + "-next", text: t("common.next") });
    var label = h("span", { class: "label ltr-island", id: prefix + "-label", text: String(getYear()) });
    prev.addEventListener("click", function () { setYear(getYear() - 1); label.textContent = String(getYear()); onChange(); });
    next.addEventListener("click", function () { setYear(getYear() + 1); label.textContent = String(getYear()); onChange(); });
    return { el: h("div", { class: "hr-month" }, prev, label, next), sync: function () { label.textContent = String(getYear()); } };
  }
  function boolBadge(on, yes, no) { return HR.badge(on ? "ok" : "neutral", on ? yes : no); }
  function readOnlyNote() { return canWrite() ? null : h("p", { class: "notice info small", text: t("hr.admin.readOnly") }); }

  var SECTION = {};

  // ================================================================ employees
  SECTION.employees = {
    build: function () {
      var q = h("input", { id: "hr-ef-q", type: "search", attrs: { maxlength: "100", autocomplete: "off" }, value: AD.emp.filters.q });
      var status = HR.select("hr-ef-status", [["", t("hr.filter.any")], ["active", t("hr.empStatus.active")], ["inactive", t("hr.empStatus.inactive")]], AD.emp.filters.status);
      var dept = h("input", { id: "hr-ef-dept", type: "text", attrs: { maxlength: "100", autocomplete: "off" }, value: AD.emp.filters.department });
      var apply = h("button", { type: "submit", class: "btn", text: t("filter.apply") });
      var reset = h("button", { type: "reset", class: "btn secondary", text: t("filter.reset") });
      var form = h("form", { class: "filters", attrs: { novalidate: "" } }, HR.field("hr-ef-q", t("hr.emp.search"), q), HR.field("hr-ef-status", t("hr.status"), status), HR.field("hr-ef-dept", t("hr.f.department"), dept), h("div", { class: "field btn-row" }, apply, reset));
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        AD.emp.filters = { q: q.value, status: status.value, department: dept.value };
        AD.emp.page = 1;
        SECTION.employees.load();
      });
      form.addEventListener("reset", function () {
        window.setTimeout(function () { AD.emp.filters = { q: "", status: "", department: "" }; AD.emp.page = 1; SECTION.employees.load(); }, 0);
      });
      V.setContent($("#hr-ad-employees"),
        h("div", { class: "card" }, h("h3", { text: t("hr.emp.title") }), readOnlyNote(), form),
        h("div", { class: "card" }, h("p", { class: "small muted", id: "hr-emp-summary", attrs: { "aria-live": "polite" } }), h("div", { id: "hr-emp-table" }, V.loading()), h("div", { class: "pager", id: "hr-emp-pager" })),
        h("div", { class: "card", id: "hr-emp-missing-card" }, h("h3", { text: t("hr.emp.noProfileTitle") }), h("p", { class: "small muted", text: t("hr.emp.noProfileHint") }), h("div", { id: "hr-emp-missing" }, V.loading()))
      );
    },
    load: function () {
      Promise.all([HR.loadStaff(true).catch(function () { return []; }), loadSchedules(true).catch(function () { return []; })]).then(function () { return null; });
      var box = $("#hr-emp-table");
      if (!AD.emp.data) V.setContent(box, V.loading());
      V.api("GET", "/hr/employees" + HU.listQuery(AD.emp.filters, AD.emp.page, PAGE))
        .then(function (d) { AD.emp.data = d; renderEmployees(); })
        .catch(function (err) { V.setContent($("#hr-emp-table"), A.errorBox(err)); });
      V.api("GET", "/hr/staff?without_profile=true")
        .then(function (d) { AD.emp.noProfile = d.rows; renderNoProfile(); })
        .catch(function (err) { V.setContent($("#hr-emp-missing"), A.errorBox(err)); });
    },
  };
  function renderEmployees() {
    var d = AD.emp.data;
    if (!d || !$("#hr-emp-table")) return;
    $("#hr-emp-summary").textContent = t("hr.emp.summary", { n: d.total });
    var rows = d.rows.map(function (e) {
      var open = h("button", { type: "button", class: "btn secondary small", text: canWrite() ? t("hr.edit") : t("common.open") });
      open.addEventListener("click", function () { openEmployee(e.user_id); });
      return h("tr", null,
        h("td", null, h("strong", { text: e.full_name }), h("div", { class: "small muted", text: t("role." + e.role) })),
        h("td", { text: e.employee_no || "—" }),
        h("td", null, e.position || "—", e.department ? h("div", { class: "small muted", text: e.department }) : null),
        h("td", { text: e.manager_name || "—" }),
        h("td", { text: e.schedule_name || "—" }),
        h("td", null, HR.badge(e.status === "active" ? "ok" : "neutral", t("hr.empStatus." + e.status))),
        h("td", null, open));
    });
    V.setContent($("#hr-emp-table"), A.table([t("hr.team.employee"), t("hr.f.employee_no"), t("hr.emp.positionDept"), t("hr.f.manager_user_id"), t("hr.f.schedule_id"), t("hr.status"), t("common.actions")], rows, { empty: t("hr.emp.none"), caption: t("hr.emp.title") }));
    HR.pager($("#hr-emp-pager"), AD.emp.page, Math.max(1, Math.ceil(d.total / PAGE)), function (p) { AD.emp.page = p; SECTION.employees.load(); });
  }
  function renderNoProfile() {
    var box = $("#hr-emp-missing");
    if (!box) return;
    var rows = (AD.emp.noProfile || []).map(function (s) {
      var b = h("button", { type: "button", class: "btn small", text: t("hr.emp.create") });
      b.addEventListener("click", function () { openEmployee(s.user_id); });
      return h("tr", null, h("td", { text: s.full_name }), h("td", { text: t("role." + s.role) }), h("td", null, canWrite() ? b : null));
    });
    V.setContent(box, A.table([t("hr.team.employee"), t("hr.emp.role"), t("common.actions")], rows, { empty: t("hr.emp.allHaveProfile"), caption: t("hr.emp.noProfileTitle") }));
  }

  var EMP_TEXT_FIELDS = ["employee_no", "position", "department", "employment_type", "phone", "emergency_contact_name", "emergency_contact_phone"];
  function openEmployee(userId) {
    Promise.all([V.api("GET", "/hr/employees/" + userId), HR.loadStaff(), loadSchedules()])
      .then(function (r) { employeeDialog(r[0]); })
      .catch(function (err) { V.toast(V.errorMessage(err), "bad"); });
  }
  function employeeDialog(emp) {
    var creating = !emp.has_profile;
    var writable = canWrite();
    var withNotes = canRead();
    var ids = {};
    var ctl = {};
    var text = function (k, label, type, extra) {
      ids[k] = "hr-ed-" + k;
      ctl[k] = h("input", { id: ids[k], type: type || "text", value: emp[k] || "", disabled: !writable, attrs: extra || { maxlength: "120", autocomplete: "off" } });
      return HR.field(ids[k], label, ctl[k]);
    };
    var mgrItems = [["", t("common.none")]].concat(staffItems(null, emp.user_id));
    ids.manager_user_id = "hr-ed-manager_user_id";
    ctl.manager_user_id = HR.select(ids.manager_user_id, mgrItems, emp.manager_user_id === null || emp.manager_user_id === undefined ? "" : emp.manager_user_id);
    ctl.manager_user_id.disabled = !writable;
    ids.schedule_id = "hr-ed-schedule_id";
    ctl.schedule_id = HR.select(ids.schedule_id, [["", t("common.none")]].concat((AD.schedules || []).map(function (s) { return [String(s.id), s.name]; })), emp.schedule_id === null || emp.schedule_id === undefined ? "" : emp.schedule_id);
    ctl.schedule_id.disabled = !writable;
    ids.status = "hr-ed-status";
    ctl.status = HR.select(ids.status, [["active", t("hr.empStatus.active")], ["inactive", t("hr.empStatus.inactive")]], emp.status || "active");
    ctl.status.disabled = !writable;
    ids.notes = "hr-ed-notes";
    ctl.notes = h("textarea", { id: ids.notes, value: emp.notes || "", disabled: !writable, attrs: { rows: "4", maxlength: "4000" } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: t("common.save") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: writable ? t("common.cancel") : t("common.close") });
    var body = [
      h("p", { class: "small" }, h("strong", { text: emp.full_name }), " · ", t("role." + emp.role), emp.is_active ? null : " · " + t("hr.emp.accountOff")),
      creating ? h("p", { class: "notice info small", text: t("hr.emp.newProfile") }) : null,
      h("div", { class: "inline-fields" }, text("employee_no", t("hr.f.employee_no"), "text", { maxlength: "40" }), text("position", t("hr.f.position")), text("department", t("hr.f.department"))),
      h("div", { class: "inline-fields" }, text("employment_type", t("hr.f.employment_type"), "text", { maxlength: "40" }), text("hire_date", t("hr.f.hire_date"), "date", {}), text("end_date", t("hr.f.end_date"), "date", {})),
      h("div", { class: "inline-fields" }, HR.field(ids.manager_user_id, t("hr.f.manager_user_id"), ctl.manager_user_id), HR.field(ids.schedule_id, t("hr.f.schedule_id"), ctl.schedule_id), HR.field(ids.status, t("hr.status"), ctl.status)),
      h("div", { class: "inline-fields" }, text("phone", t("hr.f.phone"), "text", { maxlength: "40" }), text("emergency_contact_name", t("hr.f.emergency_contact_name")), text("emergency_contact_phone", t("hr.f.emergency_contact_phone"), "text", { maxlength: "40" })),
      withNotes ? HR.field(ids.notes, t("hr.f.notes"), ctl.notes, t("hr.emp.notesHint")) : null,
      err,
      h("div", { class: "btn-row" }, writable ? go : null, cancel),
    ];
    var m = HR.modal(creating ? t("hr.emp.createTitle") : t("hr.emp.editTitle"), body, { wide: true });
    var state = { sending: false };
    cancel.addEventListener("click", m.close);
    m.form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!writable) return;
      err.textContent = "";
      var f = { user_id: String(emp.user_id), status: ctl.status.value, manager_user_id: ctl.manager_user_id.value, schedule_id: ctl.schedule_id.value };
      EMP_TEXT_FIELDS.concat(["hire_date", "end_date"]).forEach(function (k) { f[k] = ctl[k].value; });
      if (withNotes) f.notes = ctl.notes.value;
      var built = HU.employeePayload(f, { creating: creating, withNotes: withNotes });
      if (!built.ok) return HR.flag(built, function (field) { return ids[field]; }, err);
      var payload = built.payload;
      if (!creating) {
        payload = HU.changedFields(emp, payload);
        if (!Object.keys(payload).length) { err.textContent = t("hr.err.nothing"); return; }
      }
      HR.submit(go, state, function () {
        return creating ? V.api("POST", "/hr/employees", { body: payload }) : V.api("PATCH", "/hr/employees/" + emp.user_id, { body: payload });
      })
        .then(function () { m.close(); V.toast(t("hr.saved"), "ok"); SECTION.employees.load(); })
        .catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
  }

  // ================================================================ schedules
  SECTION.schedules = {
    build: function () {
      var add = h("button", { type: "button", class: "btn small", id: "hr-sch-new", text: t("hr.sch.new") });
      add.addEventListener("click", function () { scheduleDialog(null); });
      V.setContent($("#hr-ad-schedules"), h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h3", { text: t("hr.sch.title") }), h("span", { class: "spacer" }), canWrite() ? add : null),
        h("p", { class: "small muted", text: t("hr.sch.hint") }), readOnlyNote(), h("div", { id: "hr-sch-body" }, V.loading())));
    },
    load: function () {
      loadSchedules(true).then(renderSchedules).catch(function (err) { V.setContent($("#hr-sch-body"), A.errorBox(err)); });
    },
  };
  function renderSchedules() {
    var box = $("#hr-sch-body");
    if (!box) return;
    var rows = (AD.schedules || []).map(function (s) {
      var days = HU.DAYS.map(function (d) {
        var e = s.weekly && s.weekly[d];
        return h("li", null, h("strong", { text: t("hr.day." + d) + ": " }), e ? HR.ltr(HU.describeDay(e)) : h("span", { class: "muted", text: t("hr.sch.dayOff") }));
      });
      var edit = h("button", { type: "button", class: "btn secondary small", text: canWrite() ? t("hr.edit") : t("common.open") });
      edit.addEventListener("click", function () { scheduleDialog(s); });
      return h("tr", null, h("td", null, h("strong", { text: s.name })), h("td", null, HR.ltr(s.timezone)), h("td", { class: "num" }, HR.ltr(String(s.grace_minutes))), h("td", null, h("ul", { class: "compact" }, days)), h("td", null, edit));
    });
    V.setContent(box, A.table([t("hr.f.name"), t("hr.f.timezone"), { label: t("hr.f.grace_minutes"), num: true }, t("hr.sch.weekly"), t("common.actions")], rows, { empty: t("hr.sch.none"), caption: t("hr.sch.title") }), h("p", { class: "small muted", text: t("hr.sch.breakNote") }));
  }
  function scheduleDialog(s) {
    var writable = canWrite();
    var grid = HU.scheduleToGrid(s ? s.weekly : { mon: { start: "09:00", end: "17:00", break_minutes: 60 } });
    var name = h("input", { id: "hr-sd-name", type: "text", value: s ? s.name : "", disabled: !writable, attrs: { maxlength: "120", autocomplete: "off" } });
    var tz = h("input", { id: "hr-sd-tz", type: "text", value: s ? s.timezone : HR.tz, disabled: !writable, attrs: { list: "hr-sd-tzlist", autocomplete: "off", dir: "ltr" } });
    var tzList = h("datalist", { id: "hr-sd-tzlist" }, V.timeZones().map(function (z) { return h("option", { value: z }); }));
    var grace = h("input", { id: "hr-sd-grace", type: "number", value: s ? String(s.grace_minutes) : "10", disabled: !writable, attrs: { min: "0", max: String(HU.LIMITS.graceMax), inputmode: "numeric" } });
    var rows = {};
    var dayRows = HU.DAYS.map(function (d) {
      var g = grid[d];
      var on = HR.check("hr-sd-" + d + "-on", t("hr.day." + d), g.on);
      on.input.disabled = !writable;
      var start = h("input", { id: "hr-sd-" + d + "-start", type: "time", value: g.start, disabled: !writable || !g.on });
      var end = h("input", { id: "hr-sd-" + d + "-end", type: "time", value: g.end, disabled: !writable || !g.on });
      var brk = h("input", { id: "hr-sd-" + d + "-break_minutes", type: "number", value: g.break_minutes, disabled: !writable || !g.on, attrs: { min: "0", max: String(HU.LIMITS.breakMax), inputmode: "numeric" } });
      on.input.addEventListener("change", function () {
        [start, end, brk].forEach(function (x) { x.disabled = !on.input.checked || !writable; });
        if (on.input.checked && !start.value) { start.value = "09:00"; end.value = end.value || "17:00"; }
      });
      rows[d] = { on: on.input, start: start, end: end, brk: brk };
      return h("div", { class: "hr-day-row" }, h("div", { class: "day-name" }, on.el), HR.field("hr-sd-" + d + "-start", t("hr.sch.start"), start), HR.field("hr-sd-" + d + "-end", t("hr.sch.end"), end), HR.field("hr-sd-" + d + "-break_minutes", t("hr.sch.break"), brk));
    });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: t("common.save") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: writable ? t("common.cancel") : t("common.close") });
    var m = HR.modal(s ? t("hr.sch.edit") : t("hr.sch.new"), [
      h("div", { class: "inline-fields" }, HR.field("hr-sd-name", t("hr.f.name"), name), HR.field("hr-sd-tz", t("hr.f.timezone"), tz), tzList, HR.field("hr-sd-grace", t("hr.f.grace_minutes"), grace, t("hr.sch.graceHint"))),
      h("fieldset", null, h("legend", { text: t("hr.sch.weekly") }), h("div", { class: "hr-days" }, dayRows)),
      err,
      h("div", { class: "btn-row" }, writable ? go : null, cancel),
    ], { wide: true });
    var state = { sending: false };
    cancel.addEventListener("click", m.close);
    m.form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!writable) return;
      err.textContent = "";
      var days = {};
      HU.DAYS.forEach(function (d) { days[d] = { on: rows[d].on.checked, start: rows[d].start.value, end: rows[d].end.value, break_minutes: rows[d].brk.value }; });
      var built = HU.schedulePayload({ name: name.value, grace_minutes: grace.value, timezone: tz.value, days: days });
      if (!built.ok) {
        return HR.flag(built, function (f) {
          var w = /^weekly\.([a-z]{3})\.(.+)$/.exec(f);
          return w ? "hr-sd-" + w[1] + "-" + w[2] : { name: "hr-sd-name", grace_minutes: "hr-sd-grace", timezone: "hr-sd-tz" }[f];
        }, err);
      }
      HR.submit(go, state, function () {
        return s ? V.api("PATCH", "/hr/schedules/" + s.id, { body: built.payload }) : V.api("POST", "/hr/schedules", { body: built.payload });
      })
        .then(function () { m.close(); V.toast(t("hr.saved"), "ok"); AD.schedules = null; SECTION.schedules.load(); })
        .catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
    name.focus();
  }

  // ================================================================ leave types
  SECTION.leaveTypes = {
    build: function () {
      var add = h("button", { type: "button", class: "btn small", id: "hr-lt-new", text: t("hr.lt.new") });
      add.addEventListener("click", function () { leaveTypeDialog(null); });
      V.setContent($("#hr-ad-leaveTypes"), h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h3", { text: t("hr.lt.title") }), h("span", { class: "spacer" }), canWrite() ? add : null),
        h("p", { class: "small muted", text: t("hr.lt.hint") }), readOnlyNote(), h("div", { id: "hr-lt-body" }, V.loading())));
    },
    load: function () {
      loadLeaveTypes(true).then(renderLeaveTypes).catch(function (err) { V.setContent($("#hr-lt-body"), A.errorBox(err)); });
    },
  };
  function renderLeaveTypes() {
    var box = $("#hr-lt-body");
    if (!box) return;
    var rows = (AD.leaveTypes || []).map(function (x) {
      var edit = h("button", { type: "button", class: "btn secondary small", text: canWrite() ? t("hr.edit") : t("common.open") });
      edit.addEventListener("click", function () { leaveTypeDialog(x); });
      return h("tr", null,
        h("td", null, h("strong", { class: "ltr-island", text: x.code })),
        h("td", null, h("div", { text: x.name_en }), h("div", { class: "small muted", text: x.name_fr }), h("div", { class: "small muted", text: x.name_ar })),
        h("td", null, h("span", { class: "hr-flags" }, boolBadge(x.paid, t("hr.lt.paid"), t("hr.lt.unpaid")), boolBadge(x.counts_against_balance, t("hr.lt.counts"), t("hr.lt.noCount")), boolBadge(x.requires_approval, t("hr.lt.approval"), t("hr.lt.auto")))),
        h("td", null, HR.badge(x.active ? "ok" : "neutral", x.active ? t("hr.lt.active") : t("hr.lt.inactive"))),
        h("td", null, edit));
    });
    V.setContent(box, A.table([t("hr.f.code"), t("hr.lt.names"), t("hr.lt.rules"), t("hr.status"), t("common.actions")], rows, { empty: t("hr.lt.none"), caption: t("hr.lt.title") }));
  }
  function leaveTypeDialog(x) {
    var writable = canWrite();
    var creating = !x;
    var code = h("input", { id: "hr-lt-code", type: "text", value: x ? x.code : "", disabled: !creating, attrs: { maxlength: "30", autocomplete: "off", dir: "ltr" } });
    var names = {};
    ["name_en", "name_fr", "name_ar"].forEach(function (k) { names[k] = h("input", { id: "hr-lt-" + k, type: "text", value: x ? x[k] : "", disabled: !writable, attrs: { maxlength: "120", autocomplete: "off" } }); });
    var flags = {
      paid: HR.check("hr-lt-paid", t("hr.lt.paid"), x ? x.paid : true),
      counts_against_balance: HR.check("hr-lt-counts", t("hr.lt.counts"), x ? x.counts_against_balance : true),
      requires_approval: HR.check("hr-lt-approval", t("hr.lt.approval"), x ? x.requires_approval : true),
      active: HR.check("hr-lt-active", t("hr.lt.active"), x ? x.active : true),
    };
    Object.keys(flags).forEach(function (k) { flags[k].input.disabled = !writable; });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: t("common.save") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: writable ? t("common.cancel") : t("common.close") });
    var m = HR.modal(creating ? t("hr.lt.new") : t("hr.lt.edit"), [
      HR.field("hr-lt-code", t("hr.f.code"), code, creating ? t("hr.lt.codeHint") : t("hr.lt.codeLocked")),
      HR.field("hr-lt-name_en", t("hr.f.name_en"), names.name_en), HR.field("hr-lt-name_fr", t("hr.f.name_fr"), names.name_fr), HR.field("hr-lt-name_ar", t("hr.f.name_ar"), names.name_ar),
      flags.paid.el, flags.counts_against_balance.el, flags.requires_approval.el, flags.active.el,
      err,
      h("div", { class: "btn-row" }, writable ? go : null, cancel),
    ]);
    var state = { sending: false };
    cancel.addEventListener("click", m.close);
    m.form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!writable) return;
      err.textContent = "";
      var built = HU.leaveTypePayload({
        code: code.value, name_en: names.name_en.value, name_fr: names.name_fr.value, name_ar: names.name_ar.value,
        paid: flags.paid.input.checked, counts_against_balance: flags.counts_against_balance.input.checked, requires_approval: flags.requires_approval.input.checked, active: flags.active.input.checked,
      }, { creating: creating });
      if (!built.ok) return HR.flag(built, function (f) { return "hr-lt-" + f; }, err);
      HR.submit(go, state, function () {
        return creating ? V.api("POST", "/hr/leave-types", { body: built.payload }) : V.api("PATCH", "/hr/leave-types/" + x.id, { body: built.payload });
      })
        .then(function () { m.close(); V.toast(t("hr.saved"), "ok"); AD.leaveTypes = null; SECTION.leaveTypes.load(); })
        .catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
    (creating ? code : names.name_en).focus();
  }

  // ================================================================ holidays
  SECTION.holidays = {
    build: function () {
      if (!AD.hol.year) AD.hol.year = Number(HR.today().slice(0, 4));
      var nav = yearNav("hr-hol", function () { return AD.hol.year; }, function (y) { AD.hol.year = y; }, function () { SECTION.holidays.load(); });
      var day = h("input", { id: "hr-hd-day", type: "date" });
      var name = h("input", { id: "hr-hd-name", type: "text", attrs: { maxlength: "160", autocomplete: "off" } });
      var add = h("button", { type: "submit", class: "btn", id: "hr-hol-add", text: t("hr.hol.add") });
      var err = h("p", { class: "form-error", attrs: { role: "alert" } });
      var form = h("form", { class: "filters", attrs: { novalidate: "" } }, HR.field("hr-hd-day", t("hr.f.day"), day), HR.field("hr-hd-name", t("hr.f.name"), name), h("div", { class: "field btn-row" }, add));
      var state = { sending: false };
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        err.textContent = "";
        var built = HU.holidayPayload({ day: day.value, name: name.value });
        if (!built.ok) return HR.flag(built, function (f) { return { day: "hr-hd-day", name: "hr-hd-name" }[f]; }, err);
        state.sending = false;
        HR.submit(add, state, function () { return V.api("POST", "/hr/holidays", { body: built.payload }); })
          .then(function () {
            V.toast(t("hr.saved"), "ok");
            day.value = "";
            name.value = "";
            add.disabled = false;
            add.removeAttribute("aria-busy");
            if (built.payload.day.slice(0, 4) !== String(AD.hol.year)) { AD.hol.year = Number(built.payload.day.slice(0, 4)); nav.sync(); }
            SECTION.holidays.load();
          })
          .catch(function (e2) { err.textContent = V.errorMessage(e2); });
      });
      V.setContent($("#hr-ad-holidays"), h("div", { class: "card" },
        h("h3", { text: t("hr.hol.title") }), h("p", { class: "small muted", text: t("hr.hol.hint") }), readOnlyNote(), nav.el,
        canWrite() ? [form, err] : null, h("div", { id: "hr-hol-body" }, V.loading())));
    },
    load: function () {
      V.api("GET", "/hr/holidays?year=" + AD.hol.year)
        .then(function (d) { AD.hol.data = d; renderHolidays(); })
        .catch(function (err) { V.setContent($("#hr-hol-body"), A.errorBox(err)); });
    },
  };
  function renderHolidays() {
    var box = $("#hr-hol-body");
    var d = AD.hol.data;
    if (!box || !d) return;
    var rows = d.rows.map(function (x) {
      var del = null;
      if (canWrite()) {
        del = h("button", { type: "button", class: "btn danger small", text: t("hr.delete") });
        del.addEventListener("click", function () {
          V.confirmDialog(t("hr.hol.deleteConfirm", { name: x.name, day: x.day }), t("hr.delete"), true).then(function (yes) {
            if (!yes) return;
            V.busy(del, function () { return V.api("DELETE", "/hr/holidays/" + x.id); })
              .then(function () { V.toast(t("hr.deleted"), "ok"); SECTION.holidays.load(); })
              .catch(function () {});
          });
        });
      }
      return h("tr", null, h("td", null, HR.ltr(x.day), h("div", { class: "small muted", text: t("hr.day." + HU.weekdayKey(x.day)) })), h("td", { text: x.name }), h("td", null, del));
    });
    V.setContent(box, A.table([t("hr.f.day"), t("hr.f.name"), t("common.actions")], rows, { empty: t("hr.hol.none"), caption: t("hr.hol.title") }));
  }

  // ================================================================ balances
  SECTION.balances = {
    build: function () {
      if (!AD.bal.year) AD.bal.year = Number(HR.today().slice(0, 4));
      var nav = yearNav("hr-bal", function () { return AD.bal.year; }, function (y) { AD.bal.year = y; }, function () { SECTION.balances.load(); });
      var who = HR.select("hr-bal-user", staffItems(t("hr.bal.pickEmployee")), AD.bal.userId);
      who.addEventListener("change", function () { AD.bal.userId = who.value; SECTION.balances.load(); });
      V.setContent($("#hr-ad-balances"), h("div", { class: "card" },
        h("h3", { text: t("hr.bal.adminTitle") }), h("p", { class: "small muted", text: t("hr.bal.adminHint") }), readOnlyNote(),
        h("div", { class: "filters" }, HR.field("hr-bal-user", t("hr.team.employee"), who), h("div", { class: "field" }, h("span", { class: "label", text: t("hr.bal.yearLabel") }), nav.el)),
        h("div", { id: "hr-bal-admin-body" }, h("p", { class: "empty", text: t("hr.bal.pickEmployee") }))));
    },
    load: function () {
      var who = $("#hr-bal-user");
      HR.loadStaff().then(function () {
        if (who && who.options.length <= 1) A.fillSelect(who, staffItems(t("hr.bal.pickEmployee")), AD.bal.userId);
        if (!AD.bal.userId) return V.setContent($("#hr-bal-admin-body"), h("p", { class: "empty", text: t("hr.bal.pickEmployee") }));
        V.setContent($("#hr-bal-admin-body"), V.loading());
        return Promise.all([loadLeaveTypes(), V.api("GET", "/hr/balances?user_id=" + encodeURIComponent(AD.bal.userId) + "&year=" + AD.bal.year + "&limit=100")])
          .then(function (r) { AD.bal.data = r[1].rows; renderBalanceEditor(); });
      }).catch(function (err) { V.setContent($("#hr-bal-admin-body"), A.errorBox(err)); });
    },
  };
  function renderBalanceEditor() {
    var box = $("#hr-bal-admin-body");
    if (!box) return;
    var lang = V.getLang();
    var existing = {};
    (AD.bal.data || []).forEach(function (b) { existing[b.leave_type_id] = b; });
    var types = (AD.leaveTypes || []).filter(function (x) { return x.active || existing[x.id]; });
    var rows = types.map(function (x) {
      var b = existing[x.id];
      var ent = h("input", { type: "text", value: b ? HU.formatDays(b.entitled_days) : "", disabled: !canWrite(), attrs: { inputmode: "decimal", "aria-label": t("hr.bal.entitled") + " – " + HU.typeName(x, lang), dir: "ltr", autocomplete: "off" } });
      var adj = h("input", { type: "text", value: b ? HU.formatDays(b.adjusted_days) : "", disabled: !canWrite(), attrs: { inputmode: "decimal", "aria-label": t("hr.bal.adjusted") + " – " + HU.typeName(x, lang), dir: "ltr", autocomplete: "off" } });
      var save = canWrite() ? h("button", { type: "button", class: "btn small", text: t("common.save") }) : null;
      var msg = h("div", { class: "form-error small", attrs: { role: "alert" } });
      if (save) save.addEventListener("click", function () {
        msg.textContent = "";
        var built = HU.balancePayload({ user_id: AD.bal.userId, leave_type_id: String(x.id), year: String(AD.bal.year), entitled_days: ent.value, adjusted_days: adj.value });
        if (!built.ok) { msg.textContent = HR.errText(built); return; }
        V.busy(save, function () { return V.api("PUT", "/hr/balances", { body: built.payload }); })
          .then(function () { V.toast(t("hr.saved"), "ok"); SECTION.balances.load(); })
          .catch(function (e2) { msg.textContent = V.errorMessage(e2); });
      });
      return h("tr", null,
        h("td", null, h("strong", { text: HU.typeName(x, lang) }), x.counts_against_balance ? null : h("div", { class: "small muted", text: t("hr.bal.notCounted") })),
        h("td", null, ent), h("td", null, adj),
        h("td", { class: "num" }, b ? HR.ltr(HU.formatDays(b.used_days)) : "—"),
        h("td", { class: "num" }, b ? HR.ltr(HU.formatDays(b.pending_days)) : "—"),
        h("td", { class: "num" }, b ? h("strong", { class: "ltr-island", text: HU.formatDays(b.available_days) }) : "—"),
        h("td", null, save, msg));
    });
    V.setContent(box, A.table([t("hr.bal.type"), t("hr.bal.entitled"), t("hr.bal.adjusted"), { label: t("hr.bal.used"), num: true }, { label: t("hr.bal.pending"), num: true }, { label: t("hr.bal.available"), num: true }, t("common.actions")], rows, { empty: t("hr.bal.noTypes"), caption: t("hr.bal.adminTitle") }),
      h("p", { class: "small muted", text: t("hr.bal.adjustedHint") }));
  }

  // ================================================================ attendance report
  SECTION.attReport = {
    build: function () {
      if (!AD.rep.from) {
        var b = HU.monthBounds(HU.monthOf(HR.today()));
        AD.rep.from = b.from;
        AD.rep.to = HR.today();
      }
      var from = h("input", { id: "hr-rf-from", type: "date", value: AD.rep.from });
      var to = h("input", { id: "hr-rf-to", type: "date", value: AD.rep.to });
      var who = HR.select("hr-rf-user", staffItems(t("hr.rep.everyone")), AD.rep.userId);
      var prob = HR.check("hr-rf-problems", t("hr.rep.problemsOnly"), AD.rep.problems);
      var run = h("button", { type: "submit", class: "btn", id: "hr-rep-run", text: t("hr.rep.run") });
      var csv = h("button", { type: "button", class: "btn secondary", id: "hr-rep-csv", text: t("hr.rep.csv") });
      var status = h("p", { class: "small", id: "hr-rep-status", attrs: { role: "status", "aria-live": "polite" } });
      var err = h("p", { class: "form-error", attrs: { role: "alert" } });
      var form = h("form", { class: "filters", attrs: { novalidate: "" } },
        HR.field("hr-rf-from", t("hr.rep.from"), from), HR.field("hr-rf-to", t("hr.rep.to"), to), HR.field("hr-rf-user", t("hr.team.employee"), who), prob.el,
        h("div", { class: "field btn-row" }, run, csv));
      function read() {
        AD.rep.from = from.value; AD.rep.to = to.value; AD.rep.userId = who.value; AD.rep.problems = prob.input.checked;
        if (!HU.isDate(AD.rep.from) || !HU.isDate(AD.rep.to)) { err.textContent = HR.errText({ field: "date", code: "invalid" }); return false; }
        if (AD.rep.to < AD.rep.from) { err.textContent = HR.errText({ field: "date", code: "order" }); return false; }
        err.textContent = "";
        return true;
      }
      form.addEventListener("submit", function (e) { e.preventDefault(); if (read()) SECTION.attReport.run(); });
      prob.input.addEventListener("change", function () { AD.rep.problems = prob.input.checked; renderReport(); });
      csv.addEventListener("click", function () {
        if (!read()) return;
        status.textContent = "";
        V.busy(csv, function () {
          return V.download("/hr/export/attendance.csv" + HU.rangeQuery(AD.rep.from, AD.rep.to, { user_id: AD.rep.userId }), "attendance.csv").then(function (r) {
            AD.rep.status = t(r.truncated ? "hr.rep.csvCut" : "hr.rep.csvDone", { name: r.name, size: V.fmtNumber(r.size) });
            status.textContent = AD.rep.status;
            V.announce(AD.rep.status);
          });
        }).catch(function () {});
      });
      V.setContent($("#hr-ad-attReport"),
        h("div", { class: "card" }, h("h3", { text: t("hr.rep.title") }), h("p", { class: "small muted", text: t("hr.rep.hint") }), form, err, status),
        h("div", { class: "card" }, h("div", { id: "hr-rep-body", attrs: { "aria-live": "polite" } }, h("p", { class: "empty", text: t("hr.rep.notRun") }))));
    },
    load: function () {
      HR.loadStaff().then(function () {
        var who = $("#hr-rf-user");
        if (who && who.options.length <= 1) A.fillSelect(who, staffItems(t("hr.rep.everyone")), AD.rep.userId);
      }).catch(function () {});
      if (!AD.rep.data) SECTION.attReport.run();
      else renderReport();
    },
    run: function () {
      var box = $("#hr-rep-body");
      V.setContent(box, V.loading());
      V.api("GET", "/hr/reports/attendance" + HU.rangeQuery(AD.rep.from, AD.rep.to, { user_id: AD.rep.userId }))
        .then(function (d) { AD.rep.data = d; renderReport(); })
        .catch(function (err) { AD.rep.data = null; V.setContent(box, A.errorBox(err)); });
    },
  };
  function stat(n, label, cls) { return h("div", { class: "stat " + (cls || "") }, h("div", { class: "n", text: V.fmtNumber(n) }), h("div", { class: "l", text: label })); }
  function renderReport() {
    var box = $("#hr-rep-body");
    var d = AD.rep.data;
    if (!box || !d) return;
    var s = d.summary;
    var rows = d.rows.filter(function (r) { return !AD.rep.problems || r.late || r.absent || r.open_session || r.needs_correction; });
    var shown = rows.slice(0, ROW_CAP);
    var tbody = shown.map(function (r) {
      var flags = HU.reportFlags(r).map(function (f) {
        var cls = { late: "warn", absent: "bad", open: "warn", needs_correction: "bad", holiday: "gold", leave: "info" }[f];
        return HR.badge(cls, f === "late" && r.late_minutes ? t("hr.flag.lateBy", { n: r.late_minutes }) : t("hr.flag." + f));
      });
      return h("tr", null,
        h("td", null, HR.ltr(r.day), h("div", { class: "small muted", text: t("hr.day." + HU.weekdayKey(r.day)) })),
        h("td", null, h("strong", { text: r.full_name }), r.employee_no ? h("div", { class: "small muted ltr-island", text: r.employee_no }) : null),
        h("td", null, r.scheduled ? HR.ltr(r.scheduled_start + "–" + r.scheduled_end) : "—"),
        h("td", null, r.first_in ? HR.ltr(r.first_in_local || HU.formatTime(r.first_in, d.timezone, V.locale())) : "—"),
        h("td", null, r.last_out ? HR.ltr(r.last_out_local || HU.formatTime(r.last_out, d.timezone, V.locale())) : "—"),
        h("td", { class: "num" }, HR.ltr(HU.formatDuration(r.worked_minutes))),
        h("td", null, h("span", { class: "hr-flags" }, flags)));
    });
    V.setContent(box,
      h("p", { class: "small muted", text: t("hr.rep.period", { from: d.from, to: d.to, tz: d.timezone }) }),
      h("div", { class: "stats", id: "hr-rep-stats" },
        stat(s.people, t("hr.rep.people")), stat(s.scheduled_days, t("hr.rep.scheduledDays")), stat(s.late_days, t("hr.flag.late"), s.late_days ? "gold" : ""), stat(s.absent_days, t("hr.flag.absent"), s.absent_days ? "bad" : ""),
        stat(s.open_sessions, t("hr.flag.open")), stat(s.needs_correction, t("hr.flag.needs_correction"), s.needs_correction ? "bad" : "")),
      h("p", { class: "small" }, h("strong", { text: t("hr.att.total") + ": " }), HR.ltr(HU.formatDuration(s.worked_minutes))),
      A.table([t("hr.att.date"), t("hr.team.employee"), t("hr.rep.scheduled"), t("hr.rep.firstIn"), t("hr.rep.lastOut"), { label: t("hr.att.worked"), num: true }, t("hr.rep.flags")], tbody, { empty: t("hr.rep.none"), caption: t("hr.rep.title") }),
      rows.length > shown.length ? h("p", { class: "notice info small", text: t("hr.rep.capped", { shown: shown.length, total: rows.length }) }) : null,
      h("p", { class: "small muted", text: t("hr.rep.note") }));
  }

  // ================================================================ leave report
  SECTION.leaveReport = {
    build: function () {
      if (!AD.lrep.year) AD.lrep.year = Number(HR.today().slice(0, 4));
      var nav = yearNav("hr-lrep", function () { return AD.lrep.year; }, function (y) { AD.lrep.year = y; AD.lrep.page = 1; }, function () { SECTION.leaveReport.load(); });
      V.setContent($("#hr-ad-leaveReport"), h("div", { class: "card" },
        h("h3", { text: t("hr.lrep.title") }), h("p", { class: "small muted", text: t("hr.lrep.hint") }), nav.el,
        h("div", { id: "hr-lrep-body" }, V.loading()), h("div", { class: "pager", id: "hr-lrep-pager" })));
    },
    load: function () {
      V.api("GET", "/hr/reports/leave?year=" + AD.lrep.year + "&limit=" + PAGE + "&offset=" + (AD.lrep.page - 1) * PAGE)
        .then(function (d) { AD.lrep.data = d; renderLeaveReport(); })
        .catch(function (err) { V.setContent($("#hr-lrep-body"), A.errorBox(err)); });
    },
  };
  function renderLeaveReport() {
    var d = AD.lrep.data;
    var box = $("#hr-lrep-body");
    if (!d || !box) return;
    var lang = V.getLang();
    var num = function (v, strong) { return h("td", { class: "num" }, strong ? h("strong", { class: "ltr-island", text: HU.formatDays(v) }) : HR.ltr(HU.formatDays(v))); };
    var rows = d.rows.map(function (r) {
      return h("tr", null,
        h("td", null, h("strong", { text: r.full_name }), r.department ? h("div", { class: "small muted", text: r.department }) : null),
        h("td", { text: HU.typeName(r, lang) }),
        num(r.entitled_days), num(r.adjusted_days), num(r.approved_days), num(r.pending_days), num(r.remaining_days), num(r.available_days, true));
    });
    V.setContent(box, A.table([t("hr.team.employee"), t("hr.leave.type"), { label: t("hr.bal.entitled"), num: true }, { label: t("hr.bal.adjusted"), num: true }, { label: t("hr.lrep.approved"), num: true }, { label: t("hr.bal.pending"), num: true }, { label: t("hr.lrep.remaining"), num: true }, { label: t("hr.bal.available"), num: true }], rows, { empty: t("hr.lrep.none"), caption: t("hr.lrep.title") }),
      h("p", { class: "small muted", text: t("hr.lrep.note") }));
    HR.pager($("#hr-lrep-pager"), AD.lrep.page, Math.max(1, Math.ceil((d.total || 0) / PAGE)), function (p) { AD.lrep.page = p; SECTION.leaveReport.load(); });
  }

  // ================================================================ registration
  HR.register("admin", {
    visible: function (role) { return HU.canRead(role) || HU.canWrite(role); },
    reset: function () {
      AD.built = false; AD.sec = "employees"; AD.schedules = null; AD.leaveTypes = null;
      AD.emp = { filters: { q: "", status: "", department: "" }, page: 1, data: null, noProfile: null };
      AD.hol = { year: null, data: null };
      AD.bal = { userId: "", year: null, data: null, types: null };
      AD.rep = { from: "", to: "", userId: "", problems: false, data: null, status: "" };
      AD.lrep = { year: null, page: 1, data: null };
      if ($("#hr-sec-admin")) V.clear($("#hr-sec-admin"));
    },
    init: function () {
      V.onLang(function () { if (AD.built && $("#hr-sec-admin")) { build(); showSec(AD.sec); } });
    },
    load: function () {
      return HR.loadMe().then(function () {
        if (!AD.built) { AD.built = true; build(); }
        showSec(AD.sec);
      }).catch(function (err) { V.setContent($("#hr-sec-admin"), A.errorBox(err)); });
    },
  });
})();
