/* HR tab > Team (hr:approve): attendance corrections and leave requests waiting for a decision, and the team leave calendar.
   A Manager sees direct reports only, HR / Admin everyone; the server enforces that scope and answers 404 outside it. Nobody
   decides their own request (the console hides the buttons and says so; the server refuses with 403 anyway).
   Reasons are shown to approvers on the request lists. The calendar carries names, leave type and dates only: the API never
   sends a reason there and nothing here asks for one. All text from the server is rendered as text. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var HR = window.VITA_HR;
  var HU = window.VITA_HR_UTIL;
  var t = V.t, h = V.h, $ = V.$;

  var PAGE = 25;
  var T = { corStatus: "pending", corPage: 1, cor: null, lvStatus: "pending", lvPage: 1, lv: null, month: null, cal: null };
  var FILTERS = ["pending", "approved", "rejected", "cancelled", "all"];

  function statusItems() {
    return FILTERS.map(function (s) { return [s, s === "all" ? t("hr.filter.all") : t("hr.status." + s)]; });
  }
  function scopeNote() { return HU.canRead(HR.role()) ? t("hr.team.scopeAll") : t("hr.team.scopeReports"); }

  function build() {
    var corSel = HR.select("hr-tc-status", statusItems(), T.corStatus);
    var lvSel = HR.select("hr-tl-status", statusItems(), T.lvStatus);
    corSel.addEventListener("change", function () { T.corStatus = corSel.value; T.corPage = 1; loadCorrections(); });
    lvSel.addEventListener("change", function () { T.lvStatus = lvSel.value; T.lvPage = 1; loadLeave(); });
    var prev = h("button", { type: "button", class: "btn secondary small", id: "hr-tcal-prev", text: t("common.prev") });
    var next = h("button", { type: "button", class: "btn secondary small", id: "hr-tcal-next", text: t("common.next") });
    var now = h("button", { type: "button", class: "btn secondary small", id: "hr-tcal-now", text: t("hr.att.thisMonth") });
    prev.addEventListener("click", function () { T.month = HU.shiftMonth(T.month, -1); loadCalendar(); });
    next.addEventListener("click", function () { T.month = HU.shiftMonth(T.month, 1); loadCalendar(); });
    now.addEventListener("click", function () { T.month = HU.monthOf(HR.today()); loadCalendar(); });
    var refresh = h("button", { type: "button", class: "btn secondary small", id: "hr-team-refresh", text: t("common.refresh") });
    refresh.addEventListener("click", load);
    V.setContent($("#hr-sec-team"),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: t("hr.team.title") }), h("span", { class: "spacer" }), refresh),
        h("p", { class: "notice info small", text: scopeNote() })
      ),
      h("div", { class: "card", id: "hr-tc-card" },
        h("div", { class: "card-head" }, h("h3", { text: t("hr.team.corrections") }), h("span", { class: "spacer" }), h("label", { class: "sr-only", for: "hr-tc-status", text: t("hr.status") }), corSel),
        h("div", { id: "hr-tc-body" }, V.loading()), h("div", { class: "pager", id: "hr-tc-pager" })
      ),
      h("div", { class: "card", id: "hr-tl-card" },
        h("div", { class: "card-head" }, h("h3", { text: t("hr.team.leave") }), h("span", { class: "spacer" }), h("label", { class: "sr-only", for: "hr-tl-status", text: t("hr.status") }), lvSel),
        h("div", { id: "hr-tl-body" }, V.loading()), h("div", { class: "pager", id: "hr-tl-pager" })
      ),
      h("div", { class: "card", id: "hr-tcal-card" },
        h("div", { class: "card-head" }, h("h3", { text: t("hr.cal.title") })),
        h("div", { class: "hr-month" }, prev, h("span", { class: "label", id: "hr-tcal-label", attrs: { "aria-live": "polite" } }), next, now),
        h("p", { class: "small muted", text: t("hr.cal.hint") }),
        h("div", { id: "hr-tcal-body" }, V.loading())
      )
    );
  }

  function who(r) {
    return h("td", null, h("strong", { text: r.full_name || "#" + r.user_id }), r.department ? h("div", { class: "small muted", text: r.department }) : null, r.employee_no ? h("div", { class: "small muted ltr-island", text: r.employee_no }) : null);
  }

  /** Approve / reject buttons, or the self-approval hint when the request is the approver's own. */
  function actions(row, kind) {
    if (HU.isOwn(row, HR.userId)) return h("span", { class: "small muted", text: t("hr.team.own") });
    if (row.status !== "pending") return null;
    var ok = h("button", { type: "button", class: "btn small", text: t("hr.team.approve") });
    var no = h("button", { type: "button", class: "btn danger small", text: t("hr.team.reject") });
    ok.addEventListener("click", function () { openDecision(kind, row, "approved"); });
    no.addEventListener("click", function () { openDecision(kind, row, "rejected"); });
    return h("div", { class: "btn-row" }, ok, no);
  }

  function statusCell(r) {
    return h("td", null, HR.statusBadge(r.status), r.decision_note ? h("div", { class: "small muted", text: t("hr.decision.note") + ": " + r.decision_note }) : null);
  }

  // ---------------------------------------------------------------- corrections
  function renderCorrections() {
    var box = $("#hr-tc-body");
    if (!box) return;
    var d = T.cor;
    if (!d) return V.setContent(box, V.loading());
    if (d.error) return V.setContent(box, A.errorBox(d.error));
    var rows = d.rows.map(function (c) {
      return h("tr", null, who(c),
        h("td", null, HR.date(c.work_date)),
        h("td", null, HR.ltr(HR.time(c.requested_in) + " – " + (c.requested_out ? HR.time(c.requested_out) : "…"))),
        h("td", { text: c.reason }),
        statusCell(c),
        h("td", null, actions(c, "correction")));
    });
    V.setContent(box, A.table([t("hr.team.employee"), t("hr.att.date"), t("hr.cor.times"), t("hr.reason"), t("hr.status"), t("common.actions")], rows, { empty: t("hr.team.noCorrections"), caption: t("hr.team.corrections") }));
    HR.pager($("#hr-tc-pager"), T.corPage, Math.max(1, Math.ceil((d.total || 0) / PAGE)), function (p) { T.corPage = p; loadCorrections(); });
  }
  function loadCorrections() {
    return V.api("GET", "/hr/team/corrections" + HU.listQuery({ status: T.corStatus }, T.corPage, PAGE))
      .then(function (d) { T.cor = d; renderCorrections(); })
      .catch(function (err) { T.cor = { error: err }; renderCorrections(); });
  }

  // ---------------------------------------------------------------- leave requests
  function renderLeave() {
    var box = $("#hr-tl-body");
    if (!box) return;
    var d = T.lv;
    if (!d) return V.setContent(box, V.loading());
    if (d.error) return V.setContent(box, A.errorBox(d.error));
    var lang = V.getLang();
    var rows = d.rows.map(function (r) {
      return h("tr", null, who(r),
        h("td", null, h("strong", { text: HU.typeName(r, lang) })),
        h("td", null, HR.ltr(HR.periodText(r))),
        h("td", { class: "num" }, HR.ltr(HU.formatDays(r.days))),
        h("td", { text: r.reason || "—" }),
        statusCell(r),
        h("td", null, actions(r, "leave")));
    });
    V.setContent(box, A.table([t("hr.team.employee"), t("hr.leave.type"), t("hr.leave.period"), { label: t("hr.leave.days"), num: true }, t("hr.reason"), t("hr.status"), t("common.actions")], rows, { empty: t("hr.team.noLeave"), caption: t("hr.team.leave") }));
    HR.pager($("#hr-tl-pager"), T.lvPage, Math.max(1, Math.ceil((d.total || 0) / PAGE)), function (p) { T.lvPage = p; loadLeave(); });
  }
  function loadLeave() {
    // status filter + paging only; the API orders pending requests by start date
    return V.api("GET", "/hr/team/leave-requests" + HU.listQuery({ status: T.lvStatus }, T.lvPage, PAGE))
      .then(function (d) { T.lv = d; renderLeave(); })
      .catch(function (err) { T.lv = { error: err }; renderLeave(); });
  }

  // ---------------------------------------------------------------- decision dialog
  function openDecision(kind, row, decision) {
    var approve = decision === "approved";
    var lang = V.getLang();
    var summary = kind === "leave"
      ? A.kv([[t("hr.team.employee"), row.full_name], [t("hr.leave.type"), HU.typeName(row, lang)], [t("hr.leave.period"), HR.ltr(HR.periodText(row))], [t("hr.leave.days"), HR.ltr(HU.formatDays(row.days))], [t("hr.reason"), row.reason || "—"]])
      : A.kv([[t("hr.team.employee"), row.full_name], [t("hr.att.date"), HR.date(row.work_date)], [t("hr.cor.times"), HR.ltr(HR.time(row.requested_in) + " – " + (row.requested_out ? HR.time(row.requested_out) : "…"))], [t("hr.reason"), row.reason]]);
    var note = h("textarea", { id: "hr-dd-note", attrs: { rows: "3", maxlength: String(HU.LIMITS.note) } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn" + (approve ? "" : " danger"), text: approve ? t("hr.team.approve") : t("hr.team.reject") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var m = HR.modal(approve ? t("hr.team.approveTitle") : t("hr.team.rejectTitle"), [
      summary,
      HR.field("hr-dd-note", t("hr.decision.note"), note, t("hr.decision.noteHint", { max: HU.LIMITS.note })),
      err,
      h("div", { class: "btn-row" }, go, cancel),
    ]);
    var state = { sending: false };
    cancel.addEventListener("click", m.close);
    m.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      var built = HU.decisionPayload(decision, note.value);
      if (!built.ok) return HR.flag(built, function () { return "hr-dd-note"; }, err);
      HR.submit(go, state, function () {
        return kind === "leave"
          ? V.api("POST", "/hr/leave-requests/" + row.id + "/decide", { body: built.payload })
          : V.api("POST", "/hr/corrections/" + row.id + "/decide", { body: built.payload });
      })
        .then(function () {
          m.close();
          V.toast(t(approve ? "hr.team.approved" : "hr.team.rejected"), "ok");
          V.announce(t(approve ? "hr.team.approved" : "hr.team.rejected"));
          return Promise.all([loadCorrections(), loadLeave(), loadCalendar()]);
        })
        .catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
    note.focus();
  }

  // ---------------------------------------------------------------- calendar
  function renderCalendar() {
    var label = $("#hr-tcal-label");
    if (label) label.textContent = HU.monthLabel(T.month, V.locale());
    var box = $("#hr-tcal-body");
    if (!box) return;
    var d = T.cal;
    if (!d) return V.setContent(box, V.loading());
    if (d.error) return V.setContent(box, A.errorBox(d.error));
    var cal = HU.calendarMonth(T.month, d.entries, d.holidays);
    if (!cal) return V.setContent(box, V.empty());
    var lang = V.getLang();
    var head = h("tr", null, h("th", { scope: "col", class: "who", text: t("hr.team.employee") }),
      cal.days.map(function (day) {
        return h("th", { scope: "col", class: day.holiday ? "cal-holiday" : null, title: day.holiday ? day.holiday : t("hr.day." + day.weekday), text: String(day.n) });
      }));
    var rows = cal.people.map(function (p) {
      return h("tr", null, h("th", { scope: "row", class: "who", text: p.full_name }),
        cal.days.map(function (day) {
          var cell = p.cells[day.date];
          var cls = [];
          if (day.holiday) cls.push("cal-holiday");
          if (!cell) return h("td", { class: cls.join(" ") || null });
          cls.push(cell.status === "approved" ? "cal-approved" : "cal-pending");
          if (cell.half) cls.push("cal-half");
          var name = HU.typeName(cell.entry, lang);
          var full = name + " · " + t("hr.status." + cell.status) + (cell.half ? " · ½" : "");
          return h("td", { class: cls.join(" "), title: full }, h("span", { class: "sr-only", text: full }), h("span", { attrs: { "aria-hidden": "true" }, text: name.charAt(0).toUpperCase() }));
        }));
    });
    var list = d.entries.map(function (e) {
      return h("tr", null, h("td", { text: e.full_name }), h("td", { text: HU.typeName(e, lang) }), h("td", null, HR.ltr(HR.periodText(e))), h("td", null, HR.statusBadge(e.status)));
    });
    var hols = (d.holidays || []).map(function (x) { return h("li", null, HR.ltr(x.day), " ", x.name); });
    V.setContent(box,
      cal.people.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "hr-cal", id: "hr-cal-grid" }, h("caption", { class: "sr-only", text: t("hr.cal.title") }), h("thead", null, head), h("tbody", null, rows)))
        : V.empty(t("hr.cal.none")),
      h("div", { class: "hr-legend" },
        h("span", null, h("span", { class: "sw approved" }), t("hr.cal.legendApproved")),
        h("span", null, h("span", { class: "sw pending" }), t("hr.cal.legendPending")),
        h("span", null, h("span", { class: "sw holiday" }), t("hr.cal.legendHoliday"))),
      hols.length ? h("div", null, h("h4", { text: t("hr.cal.holidays") }), h("ul", { class: "compact" }, hols)) : null,
      list.length ? A.table([t("hr.team.employee"), t("hr.leave.type"), t("hr.leave.period"), t("hr.status")], list, { caption: t("hr.cal.entries") }) : null
    );
  }
  function loadCalendar() {
    return V.api("GET", "/hr/team/calendar" + HU.monthQuery(T.month))
      .then(function (d) { T.cal = d; renderCalendar(); })
      .catch(function (err) { T.cal = { error: err }; renderCalendar(); });
  }

  function load() {
    return HR.loadMe().then(function () {
      if (!T.month) T.month = HU.monthOf(HR.today());
      return Promise.all([loadCorrections(), loadLeave(), loadCalendar()]);
    }).catch(function (err) { V.setContent($("#hr-tc-body"), A.errorBox(err)); });
  }

  HR.register("team", {
    visible: function (role) { return HU.canApprove(role); },
    reset: function () {
      T.cor = null; T.lv = null; T.cal = null; T.month = null; T.corPage = 1; T.lvPage = 1; T.corStatus = "pending"; T.lvStatus = "pending";
      if ($("#hr-sec-team") && HR.ready) build();
    },
    init: function () {
      build();
      V.onLang(function () { if ($("#hr-sec-team")) { build(); renderCorrections(); renderLeave(); renderCalendar(); } });
    },
    load: load,
  });
})();
