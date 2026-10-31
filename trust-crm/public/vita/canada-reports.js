/* Canada service layer, staff console: company reports as PDF / Excel (period picker, snapshot history, report settings) inside the
   Reports tab. Numbers come from the server (SQL over real rows); nothing is computed here. Downloads go through authenticated
   blobs (no token in a URL). Report timezone and the scheduled snapshots can only be changed by an administrator. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var U = window.VITA_CANADA_UTIL;
  var C = window.VITA_CANADA;
  var t = V.t, h = V.h, $ = V.$;

  var GROUPS = ["candidate", "country", "staff", "profession", "employer", "source", "status", "period"];
  var S = { built: false, settings: null, snapKind: "" };

  function root() { return $("#canada-reports-card"); }

  function build() {
    var box = root();
    if (!box) return;
    // keep what the user typed across live refreshes: build once per language
    if (S.built && box.firstChild) return;
    S.built = true;
    var tz = S.settings ? S.settings.report_timezone : null;
    var today = C.todayIn(tz);
    var preset = C.select("cx-cr-preset", C.items("canada.report.preset.", U.PERIOD_PRESETS), "monthly");
    var from = h("input", { id: "cx-cr-from", type: "date", attrs: { dir: "ltr" } });
    var to = h("input", { id: "cx-cr-to", type: "date", attrs: { dir: "ltr" } });
    var group = C.select("cx-cr-group", GROUPS.map(function (g) { return [g, V.tc("group", g)]; }), "candidate");
    var status = h("div", { attrs: { "aria-live": "polite" } });
    var snapBox = h("div", { id: "cx-cr-snaps" });
    var snapKind = C.select("cx-cr-snapkind", [["", t("canada.snapshots.allKinds")]].concat(["daily", "weekly", "monthly", "custom", "candidate_activity"].map(function (k) { return [k, t("canada.snapshot.kind." + k)]; })), S.snapKind);
    var settingsBox = h("div", { id: "cx-cr-settings" });
    var applyPreset = function () {
      var r = U.presetRange(preset.value, C.todayIn(S.settings ? S.settings.report_timezone : null));
      var custom = preset.value === "custom";
      from.readOnly = !custom;
      to.readOnly = !custom;
      if (r) { from.value = r.from; to.value = r.to; }
    };
    preset.addEventListener("change", applyPreset);
    applyPreset();
    var buttons = U.REPORT_FORMATS.map(function (fmt) {
      var b = h("button", { type: "button", class: "btn", text: t("canada.company.download", { format: fmt.toUpperCase() }) });
      b.addEventListener("click", function () {
        V.clear(status);
        var r = U.rangeQuery(from.value, to.value);
        if (!r.ok) return V.setContent(status, h("p", { class: "form-error", attrs: { role: "alert" }, text: C.errText("range_" + r.error) }));
        var q = { format: fmt, from: r.query.from, to: r.query.to, groupBy: group.value };
        var pr = U.presetRange(preset.value, today);
        if (group.value === "period") q.period = pr ? pr.period : "week";
        V.busy(b, function () {
          return V.download("/jobsearch/reports/export" + A.qs(q), "report." + fmt).then(function (res) {
            V.setContent(status, h("p", { class: "notice ok small", text: t("canada.downloaded", { name: res.name }) }));
            V.announce(t("canada.downloaded", { name: res.name }));
            loadSnapshots(snapBox, snapKind.value);
          });
        }).catch(function (err) { V.setContent(status, C.refusalBox(err)); });
      });
      return b;
    });
    snapKind.addEventListener("change", function () { S.snapKind = snapKind.value; loadSnapshots(snapBox, snapKind.value); });
    var refresh = h("button", { type: "button", class: "btn secondary small", text: t("common.refresh") });
    refresh.addEventListener("click", function () { loadSnapshots(snapBox, snapKind.value); loadSettings(settingsBox); });
    V.setContent(box,
      h("div", { class: "card-head" }, h("h2", { text: t("canada.company.title") }), h("span", { class: "spacer" }), refresh),
      h("p", { class: "small muted", text: t("canada.company.hint") }),
      h("div", { class: "inline-fields" },
        C.field("cx-cr-preset", t("canada.report.period"), preset), C.field("cx-cr-from", t("canada.report.from"), from), C.field("cx-cr-to", t("canada.report.to"), to), C.field("cx-cr-group", t("reports.groupBy"), group)),
      h("div", { class: "btn-row" }, buttons), status,
      h("h3", { text: t("canada.snapshots.title") }),
      C.field("cx-cr-snapkind", t("canada.snapshots.kind"), snapKind), snapBox,
      h("h3", { text: t("canada.settings.title") }), settingsBox);
    loadSnapshots(snapBox, snapKind.value);
    loadSettings(settingsBox);
  }

  function loadSnapshots(box, kind) {
    V.setContent(box, V.loading());
    var q = { limit: 30 };
    if (kind) q.kind = kind;
    return V.api("GET", "/jobsearch/reports/snapshots" + A.qs(q))
      .then(function (r) { V.setContent(box, C.snapshotList(r.snapshots || [], { caption: t("canada.snapshots.title") })); })
      .catch(function (err) { V.setContent(box, A.errorBox(err)); });
  }

  function loadSettings(box) {
    return V.api("GET", "/jobsearch/reports/settings").then(function (s) {
      S.settings = s;
      var admin = U.canEditReportSettings(C.role());
      var tzInput = h("input", { id: "cx-cr-tz", type: "text", value: s.report_timezone || "", disabled: !admin, attrs: { list: "cx-cr-tzlist", autocomplete: "off", dir: "ltr", maxlength: "80" } });
      var dl = h("datalist", { id: "cx-cr-tzlist" }, V.timeZones().slice(0, 600).map(function (z) { return h("option", { value: z }); }));
      var sched = h("input", { id: "cx-cr-sched", type: "checkbox", checked: Boolean(s.report_schedule_enabled), disabled: !admin });
      var err = h("p", { class: "form-error", attrs: { role: "alert" } });
      var save = h("button", { type: "submit", class: "btn small", text: t("common.save"), hidden: !admin });
      var form = h("form", { attrs: { novalidate: "" } },
        C.field("cx-cr-tz", t("canada.settings.timezone"), tzInput, t("canada.settings.timezoneHint", { source: V.has("canada.settings.source." + s.report_timezone_source) ? t("canada.settings.source." + s.report_timezone_source) : String(s.report_timezone_source || "") })),
        dl,
        h("div", { class: "field" }, h("label", { class: "check", for: "cx-cr-sched" }, sched, " ", t("canada.settings.schedule")), h("span", { class: "hint", text: t("canada.settings.scheduleHint") })),
        err, save, admin ? null : h("p", { class: "small muted", text: t("canada.settings.adminOnly") }));
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        err.textContent = "";
        var built = U.reportSettingsPatch({ timezone: tzInput.value, schedule: sched.checked }, s);
        if (!built.ok) return built.error === "nothing" ? V.toast(t("canada.err.nothing"), "bad") : C.flag(tzInput, err, C.errText("timezone"));
        V.busy(save, function () {
          return V.api("PUT", "/jobsearch/reports/settings", { body: built.patch }).then(function () {
            V.toast(t("canada.settings.saved"), "ok");
            return loadSettings(box);
          });
        }).catch(function (e2) { err.textContent = C.refusal(e2); });
      });
      V.setContent(box, form);
    }).catch(function (err) { V.setContent(box, A.errorBox(err)); });
  }

  A.onTabLoad("reports", function () {
    if (!root()) return;
    if (!S.settings) V.api("GET", "/jobsearch/reports/settings").then(function (s) { S.settings = s; }).catch(function () { /* the card shows its own error */ }).then(build);
    else build();
  });
  V.onLang(function () {
    S.built = false;
    var box = root();
    if (!box) return;
    V.clear(box);
    var panel = $("#panel-reports");
    if (panel && !panel.hidden) build();
  });
})();
