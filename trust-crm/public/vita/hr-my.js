/* HR tab (every active staff role): shared pieces (section switcher, dialogs, field helpers) and the "My work" section:
   the time clock, today's status, my attendance for a month, correction requests, my leave balances and leave requests.
   Times shown here are the SERVER's: the clock is the server's Date header plus the local tick, rendered in the schedule /
   company time zone with an explicit timeZone (hr-util.js). The browser's own zone and clock never decide anything.
   Server text (names, reasons, notes) is untrusted and rendered as text only. The console never adds leave days or minutes
   on its own except for the live "so far" counter; every balance, day count and approval comes from the API. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var HU = window.VITA_HR_UTIL;
  var t = V.t, h = V.h, $ = V.$;

  // ================================================================ shared helpers (window.VITA_HR)
  var HR = { sections: {}, current: "my", ready: false, me: null, offset: 0, tz: HU.DEFAULT_TZ, userId: null, staff: null };
  window.VITA_HR = HR;

  HR.role = function () { return A.role(); };
  HR.serverNow = function () { return Date.now() + HR.offset; };
  HR.today = function () { return HU.localDate(HR.serverNow(), HR.tz); };
  HR.time = function (value) { return HU.formatTime(value, HR.tz, V.locale()); };
  HR.ltr = function (text) { return h("span", { class: "ltr-island", text: text }); };
  HR.date = function (value) { return value ? HR.ltr(String(value).slice(0, 10)) : "—"; };
  HR.field = function (id, label, control, hint) {
    return h("div", { class: "field" }, h("label", { for: id, text: label }), control, hint ? h("span", { class: "hint", text: hint }) : null);
  };
  HR.select = function (id, items, current) {
    var sel = h("select", { id: id });
    A.fillSelect(sel, items, current);
    return sel;
  };
  HR.check = function (id, label, checked) {
    var box = h("input", { id: id, type: "checkbox", checked: Boolean(checked) });
    return { el: h("div", { class: "check" }, box, h("label", { for: id, text: label })), input: box };
  };
  HR.statusBadge = function (status) { return h("span", { class: "badge " + HU.statusClass(status), text: V.has("hr.status." + status) ? t("hr.status." + status) : String(status) }); };
  HR.badge = function (cls, text) { return h("span", { class: "badge " + cls, text: text }); };

  /** Localised text for a failed client-side check (result of a hr-util payload builder). */
  HR.errText = function (res) {
    var field = String(res.field || "");
    var weekly = /^weekly\.([a-z]{3})\./.exec(field);
    var label = t("hr.f." + (weekly ? "weekly" : field));
    var msg = t("hr.err." + res.code, { field: label });
    return weekly ? msg + " (" + t("hr.day." + weekly[1]) + ")" : msg;
  };
  /** Marks the control of a failed field, writes the message and focuses the control. `idOf(field)` maps a field to an element id. */
  HR.flag = function (res, idOf, errEl) {
    errEl.textContent = HR.errText(res);
    V.$all("[aria-invalid]").forEach(function (el) { el.removeAttribute("aria-invalid"); });
    var el = document.getElementById(idOf(res.field));
    if (el) {
      el.setAttribute("aria-invalid", "true");
      el.focus();
    }
  };

  HR.pager = function (box, page, pages, go) {
    V.clear(box);
    if (pages <= 1) return;
    var prev = h("button", { type: "button", class: "btn secondary small", text: t("common.prev"), disabled: page <= 1 });
    var next = h("button", { type: "button", class: "btn secondary small", text: t("common.next"), disabled: page >= pages });
    prev.addEventListener("click", function () { go(page - 1); });
    next.addEventListener("click", function () { go(page + 1); });
    box.appendChild(prev);
    box.appendChild(h("span", { class: "small", text: t("common.pageOf", { page: page, pages: pages }) }));
    box.appendChild(next);
  };

  var dlgSeq = 0;
  /** Modal dialog around a <form>. Returns {form, close}. Escape and Cancel close it; focus returns to the opener. */
  HR.modal = function (title, body, o) {
    var id = "hr-dlg-" + (++dlgSeq);
    var form = h("form", { attrs: { novalidate: "" } }, h("h2", { id: id + "-t", text: title }), body);
    var dlg = h("dialog", { class: o && o.wide ? "wide" : null, attrs: { "aria-labelledby": id + "-t" } }, form);
    document.body.appendChild(dlg);
    var opener = document.activeElement;
    var close = function () {
      if (dlg.open) dlg.close();
      dlg.remove();
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
    };
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    return { form: form, close: close };
  };
  HR.dialogOpen = function () { return Boolean(document.querySelector("dialog[open]")); };

  /** Ignores a second activation while the first is in flight (no double submit); re-enables the button when it fails. */
  HR.submit = function (button, state, fn) {
    if (state.sending) return Promise.resolve();
    state.sending = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    return Promise.resolve()
      .then(fn)
      .then(function (v) { return v; }, function (err) { state.sending = false; button.disabled = false; button.removeAttribute("aria-busy"); throw err; });
  };

  /** /hr/me with the server's clock (Date header). Caches the result on HR and returns the profile object. */
  HR.loadMe = function () {
    return V.api("GET", "/hr/me", { raw: true }).then(function (res) {
      var offset = HU.serverOffset(res.headers.get("Date"), Date.now());
      return res.json().then(function (me) {
        HR.me = me;
        HR.offset = offset;
        HR.tz = HU.effectiveTz(me);
        HR.userId = me && me.user ? me.user.id : null;
        return me;
      });
    });
  };

  /** Active staff (hr:read) for pickers; cached per load of the admin section. */
  HR.loadStaff = function (force) {
    if (HR.staff && !force) return Promise.resolve(HR.staff);
    return V.api("GET", "/hr/staff").then(function (d) { HR.staff = (d && d.rows) || []; return HR.staff; });
  };

  // ---------------------------------------------------------------- section switcher + tab registration
  var SECTIONS = ["my", "team", "admin"];
  HR.register = function (name, def) { HR.sections[name] = def; };

  function sectionVisible(name) {
    var def = HR.sections[name];
    return Boolean(def) && (!def.visible || def.visible(HR.role()));
  }
  function applyVisibility() {
    SECTIONS.forEach(function (s) {
      var btn = $("#hr-nav-" + s);
      if (btn) btn.hidden = !sectionVisible(s);
    });
  }
  function showSection(name) {
    if (!sectionVisible(name)) name = "my";
    HR.current = name;
    SECTIONS.forEach(function (s) {
      var box = $("#hr-sec-" + s);
      if (box) box.hidden = s !== name;
      var btn = $("#hr-nav-" + s);
      if (btn) btn.setAttribute("aria-pressed", String(s === name));
    });
    lastLoad.name = name;
    lastLoad.at = Date.now();
    var def = HR.sections[name];
    if (def && def.load) def.load();
  }
  HR.show = showSection;

  function initTab() {
    if (HR.ready) return;
    HR.ready = true;
    SECTIONS.forEach(function (s) {
      var btn = $("#hr-nav-" + s);
      if (btn) btn.addEventListener("click", function () { showSection(s); });
    });
    SECTIONS.forEach(function (s) { if (HR.sections[s] && HR.sections[s].init) HR.sections[s].init(); });
  }
  var lastLoad = { key: null, name: null, at: 0 };
  function loadTab() {
    applyVisibility();
    var sess = V.getSession();
    var key = sess ? String(sess.userId) + ":" + String(sess.role) : null;
    if (lastLoad.key !== key) {
      // Another person signed in on this page: drop everything the previous one saw before anything is shown.
      SECTIONS.forEach(function (s) { if (HR.sections[s] && HR.sections[s].reset) HR.sections[s].reset(); });
      HR.me = null;
      HR.staff = null;
      HR.current = "my";
      lastLoad = { key: key, name: null, at: 0 };
    }
    // Do not rebuild a section under an open dialog (the periodic refresh of the console also calls this), and do not
    // reload the same section twice within a few seconds (it would wipe values someone is typing).
    if (HR.dialogOpen()) return;
    if (lastLoad.name === HR.current && Date.now() - lastLoad.at < 20000) return;
    showSection(HR.current);
  }
  A.registerTab("hr", { init: initTab, load: loadTab, visible: function () { return HU.isStaffRole(HR.role()); } });

  // ================================================================ My work
  var M = {
    month: null, recent: [], monthData: null, today: { holiday: null, leave: [] }, corrections: null, leave: null, types: null,
    sending: false, cooldown: false, loadSeq: 0, notice: null, warn: null,
  };
  var PAGE = 50;

  function build() {
    var box = $("#hr-sec-my");
    V.setContent(box,
      h("div", { class: "hr-split" },
        h("div", { class: "card hr-clock", id: "hr-clock-card" },
          h("h2", { text: t("hr.my.title") }),
          h("p", { class: "small muted", id: "hr-clock-date" }),
          h("div", { class: "hr-time ltr-island", id: "hr-clock-time", attrs: { role: "timer", "aria-label": t("hr.clock.serverTime") } }, "--:--:--"),
          h("p", { class: "small muted", id: "hr-clock-tz" }),
          h("p", { id: "hr-clock-state", attrs: { role: "status", "aria-live": "polite" } }),
          h("div", { id: "hr-clock-warn" }),
          h("button", { type: "button", class: "btn big go", id: "hr-clock-btn", disabled: true, text: t("hr.clock.in") })
        ),
        h("div", { class: "card", id: "hr-today-card" }, h("h3", { text: t("hr.today.title") }), h("div", { id: "hr-today-body" }, V.loading()))
      ),
      h("div", { class: "card", id: "hr-att-card" }),
      h("div", { class: "card", id: "hr-cor-card" }),
      h("div", { class: "card", id: "hr-bal-card" }),
      h("div", { class: "card", id: "hr-lv-card" })
    );
    $("#hr-clock-btn").addEventListener("click", onClock);
    buildAttendanceCard();
    buildCorrectionCard();
    buildBalanceCard();
    buildLeaveCard();
  }

  // ---------------------------------------------------------------- clock
  function isOpen() { return Boolean(HU.openRecord(M.recent)); }

  function renderClockStatic() {
    var tz = HR.tz;
    $("#hr-clock-tz").textContent = t("hr.clock.tzNote", { tz: tz });
    var open = HU.openRecord(M.recent);
    var btn = $("#hr-clock-btn");
    btn.textContent = open ? t("hr.clock.out") : t("hr.clock.in");
    btn.classList.toggle("go", !open);
    btn.classList.toggle("stop", Boolean(open));
    btn.disabled = M.sending || M.cooldown || !HR.me;
    var state = $("#hr-clock-state");
    if (!HR.me) state.textContent = "";
    else if (open) {
      var since = HU.localDate(open.clock_in, tz) !== HR.today() ? HU.formatStamp(open.clock_in, tz) : HR.time(open.clock_in);
      V.setContent(state, h("strong", { text: t("hr.clock.stateIn") + " " }), HR.ltr(since), " · ", h("span", { id: "hr-clock-elapsed", class: "ltr-island" }));
    } else {
      state.textContent = t("hr.clock.stateOut");
    }
    renderLive();
  }
  /** The parts that change every second: the clock, the elapsed time of an open session and today's total. */
  function renderLive() {
    var el = $("#hr-clock-time");
    if (!el) return;
    var now = HR.serverNow();
    el.textContent = HR.me ? HU.formatClock(now, HR.tz, V.locale()) : "--:--:--";
    $("#hr-clock-date").textContent = HR.me ? HU.formatLongDate(now, HR.tz, V.locale()) : "";
    var open = HU.openRecord(M.recent);
    var elapsed = $("#hr-clock-elapsed");
    if (elapsed && open) elapsed.textContent = HU.formatDuration(HU.workedSoFar([open], now));
    var worked = $("#hr-today-worked");
    if (worked) worked.textContent = HU.formatDuration(HU.workedSoFar(todayRecords(), now));
  }
  function todayRecords() {
    var today = HR.today();
    return M.recent.filter(function (r) { return r.work_date === today || (r.clock_out === null || r.clock_out === undefined); });
  }

  function onClock() {
    var btn = $("#hr-clock-btn");
    if (M.sending || M.cooldown || !HR.me) return;
    M.sending = true;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    V.setContent($("#hr-clock-warn"));
    var call = isOpen() ? V.api("POST", "/hr/clock-out") : V.api("POST", "/hr/clock-in");
    call
      .then(function () { V.announce(isOpen() ? t("hr.clock.doneOut") : t("hr.clock.doneIn")); })
      .catch(function (err) {
        if (err && err.body && err.body.needs_correction) V.setContent($("#hr-clock-warn"), h("p", { class: "notice warn", attrs: { role: "alert" }, text: t("hr.clock.tooOld") }));
        else V.toast(V.errorMessage(err), "bad");
      })
      .then(function () { return Promise.all([refreshRecent(), refreshMonth()]); })
      .catch(function () {})
      .then(function () {
        M.sending = false;
        btn.removeAttribute("aria-busy");
        // A short lock after every answer: a double click must never become clock-in immediately followed by clock-out.
        M.cooldown = true;
        renderClockStatic();
        renderToday();
        window.setTimeout(function () { M.cooldown = false; renderClockStatic(); }, 1500);
      });
  }

  // ---------------------------------------------------------------- today
  function scheduleToday() {
    var s = HR.me && HR.me.schedule;
    if (!s || !s.weekly) return t("hr.today.noSchedule");
    var e = s.weekly[HU.weekdayKey(HR.today())];
    return e && typeof e === "object" ? h("span", null, HR.ltr(e.start + "–" + e.end), " (" + t("hr.today.break", { n: e.break_minutes || 0 }) + ")") : t("hr.today.dayOff");
  }
  function renderToday() {
    var box = $("#hr-today-body");
    if (!box) return;
    if (!HR.me) return V.setContent(box, V.loading());
    var recs = M.recent.filter(function (r) { return r.work_date === HR.today(); });
    var sessions = recs.length
      ? h("ul", { class: "compact" }, recs.map(function (r) {
          return h("li", null, HR.ltr(HR.time(r.clock_in) + " – " + (r.clock_out ? HR.time(r.clock_out) : "…")), r.source === "correction" ? " " : null, r.source === "correction" ? HR.badge("info", t("hr.source.correction")) : null);
        }))
      : t("hr.today.noSessions");
    var pairs = [
      [t("hr.today.schedule"), scheduleToday()],
      [t("hr.today.sessions"), sessions],
      [t("hr.today.worked"), h("strong", { id: "hr-today-worked", class: "ltr-island", text: HU.formatDuration(HU.workedSoFar(todayRecords(), HR.serverNow())) })],
    ];
    var flags = [];
    if (M.today.holiday) flags.push(HR.badge("gold", t("hr.today.holiday", { name: M.today.holiday })));
    M.today.leave.forEach(function (e) {
      flags.push(HR.badge(e.status === "approved" ? "info" : "warn", t(e.status === "approved" ? "hr.today.onLeave" : "hr.today.leavePending", { type: HU.typeName(e, V.getLang()) })));
    });
    if (flags.length) pairs.push([t("hr.today.notes"), h("span", { class: "hr-flags" }, flags)]);
    V.setContent(box, A.kv(pairs));
    if (!HR.me.profile) box.appendChild(h("p", { class: "notice info small", text: t("hr.my.noProfile") }));
  }

  // ---------------------------------------------------------------- attendance
  function buildAttendanceCard() {
    var prev = h("button", { type: "button", class: "btn secondary small", id: "hr-att-prev", text: t("common.prev") });
    var next = h("button", { type: "button", class: "btn secondary small", id: "hr-att-next", text: t("common.next") });
    var now = h("button", { type: "button", class: "btn secondary small", id: "hr-att-now", text: t("hr.att.thisMonth") });
    var label = h("span", { class: "label", id: "hr-att-label", attrs: { "aria-live": "polite" } });
    prev.addEventListener("click", function () { M.month = HU.shiftMonth(M.month, -1); refreshMonth().then(renderAttendance); });
    next.addEventListener("click", function () { M.month = HU.shiftMonth(M.month, 1); refreshMonth().then(renderAttendance); });
    now.addEventListener("click", function () { M.month = HU.monthOf(HR.today()); refreshMonth().then(renderAttendance); });
    V.setContent($("#hr-att-card"),
      h("div", { class: "card-head" }, h("h3", { text: t("hr.att.title") }), h("span", { class: "spacer" })),
      h("div", { class: "hr-month" }, prev, label, next, now),
      h("div", { id: "hr-att-body" }, V.loading())
    );
  }
  function renderAttendance() {
    var label = $("#hr-att-label");
    if (label) label.textContent = HU.monthLabel(M.month, V.locale());
    var box = $("#hr-att-body");
    if (!box) return;
    var d = M.monthData;
    if (!d) return V.setContent(box, V.loading());
    if (d.error) return V.setContent(box, A.errorBox(d.error));
    var tz = d.timezone || HR.tz;
    var byDay = {};
    d.records.forEach(function (r) { (byDay[r.work_date] = byDay[r.work_date] || []).push(r); });
    var rows = d.days.map(function (day) {
      var recs = byDay[day.work_date] || [];
      var sessions = recs.map(function (r) {
        return h("div", null, HR.ltr(HU.formatTime(r.clock_in, tz, V.locale()) + " – " + (r.clock_out ? HU.formatTime(r.clock_out, tz, V.locale()) : "…")), " ",
          r.source === "correction" ? HR.badge("info", t("hr.source.correction")) : null, !r.clock_out ? HR.badge("warn", t("hr.flag.open")) : null);
      });
      var brk = day.scheduled_break_minutes === null || day.scheduled_break_minutes === undefined ? "—" : HR.ltr(HU.formatDuration(day.scheduled_break_minutes));
      return h("tr", null,
        h("td", null, HR.date(day.work_date), h("div", { class: "small muted", text: t("hr.day." + HU.weekdayKey(day.work_date)) })),
        h("td", null, sessions),
        h("td", { class: "num" }, HR.ltr(HU.formatDuration(day.worked_minutes))),
        h("td", { class: "num" }, brk));
    });
    V.setContent(box,
      A.table([t("hr.att.date"), t("hr.att.sessions"), { label: t("hr.att.worked"), num: true }, { label: t("hr.att.break"), num: true }], rows, { empty: t("hr.att.none"), caption: t("hr.att.title") }),
      h("p", { class: "small", id: "hr-att-total" }, h("strong", { text: t("hr.att.total") + ": " }), HR.ltr(HU.formatDuration(d.worked_minutes)), " · ", t("hr.att.daysWorked", { n: d.days.length })),
      h("p", { class: "small muted", text: t("hr.att.breakNote") })
    );
  }

  // ---------------------------------------------------------------- corrections
  function buildCorrectionCard() {
    var open = h("button", { type: "button", class: "btn small", id: "hr-cor-new", text: t("hr.cor.request") });
    open.addEventListener("click", openCorrectionDialog);
    V.setContent($("#hr-cor-card"),
      h("div", { class: "card-head" }, h("h3", { text: t("hr.cor.title") }), h("span", { class: "spacer" }), open),
      h("p", { class: "small muted", text: t("hr.cor.hint") }),
      h("div", { id: "hr-cor-body" }, V.loading())
    );
  }
  function renderCorrections() {
    var box = $("#hr-cor-body");
    if (!box) return;
    var d = M.corrections;
    if (!d) return V.setContent(box, V.loading());
    if (d.error) return V.setContent(box, A.errorBox(d.error));
    var rows = d.rows.map(function (c) {
      var cancel = null;
      if (HU.canCancelCorrection(c)) {
        cancel = h("button", { type: "button", class: "btn secondary small", text: t("hr.cancel") });
        cancel.addEventListener("click", function () {
          V.confirmDialog(t("hr.cor.cancelConfirm"), t("hr.cancel")).then(function (yes) {
            if (!yes) return;
            V.busy(cancel, function () { return V.api("POST", "/hr/me/corrections/" + c.id + "/cancel"); })
              .then(function () { V.toast(t("hr.cor.cancelled"), "ok"); return refreshCorrections(); })
              .catch(function () {});
          });
        });
      }
      return h("tr", null,
        h("td", null, HR.date(c.work_date)),
        h("td", null, HR.ltr(HR.time(c.requested_in) + " – " + (c.requested_out ? HR.time(c.requested_out) : "…"))),
        h("td", { text: c.reason }),
        h("td", null, HR.statusBadge(c.status), c.decision_note ? h("div", { class: "small muted", text: t("hr.decision.note") + ": " + c.decision_note }) : null),
        h("td", null, cancel));
    });
    V.setContent(box, A.table([t("hr.att.date"), t("hr.cor.times"), t("hr.reason"), t("hr.status"), t("common.actions")], rows, { empty: t("hr.cor.none"), caption: t("hr.cor.title") }));
  }

  function openCorrectionDialog() {
    if (!HR.me) return;
    var today = HR.today();
    var date = h("input", { id: "hr-cd-date", type: "date", value: today, attrs: { min: HU.addDays(today, -HU.LIMITS.maxBackDays), max: today } });
    var tin = h("input", { id: "hr-cd-in", type: "time" });
    var tout = h("input", { id: "hr-cd-out", type: "time" });
    var next = HR.check("hr-cd-next", t("hr.cor.nextDay"), false);
    var reason = h("textarea", { id: "hr-cd-reason", attrs: { rows: "3", maxlength: String(HU.LIMITS.reason) } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: t("hr.cor.submit") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var m = HR.modal(t("hr.cor.request"), [
      h("p", { class: "small", text: t("hr.cor.dialogHint", { tz: HR.tz }) }),
      HR.field("hr-cd-date", t("hr.f.date"), date),
      h("div", { class: "inline-fields" }, HR.field("hr-cd-in", t("hr.f.in"), tin), HR.field("hr-cd-out", t("hr.f.out"), tout, t("hr.cor.outHint"))),
      next.el,
      HR.field("hr-cd-reason", t("hr.reason"), reason, t("hr.reasonHint", { max: HU.LIMITS.reason })),
      err,
      h("div", { class: "btn-row" }, go, cancel),
    ]);
    var state = { sending: false };
    cancel.addEventListener("click", m.close);
    m.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      var built = HU.correctionPayload({ date: date.value, in: tin.value, out: tout.value, nextDay: next.input.checked, reason: reason.value }, HR.tz, HR.today());
      if (!built.ok) return HR.flag(built, function (f) { return { date: "hr-cd-date", in: "hr-cd-in", out: "hr-cd-out", reason: "hr-cd-reason" }[f]; }, err);
      HR.submit(go, state, function () { return V.api("POST", "/hr/me/corrections", { body: built.payload }); })
        .then(function () {
          m.close();
          M.notice = null;
          V.toast(t("hr.cor.sent"), "ok");
          V.announce(t("hr.cor.sent"));
          return refreshCorrections();
        })
        .catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
    date.focus();
  }

  // ---------------------------------------------------------------- balances
  function buildBalanceCard() {
    V.setContent($("#hr-bal-card"), h("h3", { text: t("hr.bal.title") }), h("div", { id: "hr-bal-body" }, V.loading()));
  }
  function renderBalances() {
    var box = $("#hr-bal-body");
    if (!box || !HR.me) return;
    var lang = V.getLang();
    var rows = (HR.me.balances || []).map(function (b) {
      return h("tr", null,
        h("td", null, h("strong", { text: HU.typeName(b, lang) }), b.counts_against_balance ? null : h("div", { class: "small muted", text: t("hr.bal.notCounted") })),
        h("td", { class: "num" }, HR.ltr(HU.formatDays(b.entitled_days))),
        h("td", { class: "num" }, HR.ltr(HU.formatDays(b.adjusted_days))),
        h("td", { class: "num" }, HR.ltr(HU.formatDays(b.used_days))),
        h("td", { class: "num" }, HR.ltr(HU.formatDays(b.pending_days))),
        h("td", { class: "num" }, h("strong", { class: "ltr-island", text: HU.formatDays(b.available_days) })));
    });
    V.setContent(box,
      h("p", { class: "small muted", text: t("hr.bal.year", { year: HR.me.year }) }),
      A.table([t("hr.bal.type"), { label: t("hr.bal.entitled"), num: true }, { label: t("hr.bal.adjusted"), num: true }, { label: t("hr.bal.used"), num: true }, { label: t("hr.bal.pending"), num: true }, { label: t("hr.bal.available"), num: true }], rows, { empty: t("hr.bal.none"), caption: t("hr.bal.title") }),
      h("p", { class: "small muted", text: t("hr.bal.note") })
    );
  }

  // ---------------------------------------------------------------- leave
  function buildLeaveCard() {
    var open = h("button", { type: "button", class: "btn small", id: "hr-lv-new", text: t("hr.leave.request") });
    open.addEventListener("click", openLeaveDialog);
    V.setContent($("#hr-lv-card"),
      h("div", { class: "card-head" }, h("h3", { text: t("hr.leave.title") }), h("span", { class: "spacer" }), open),
      h("div", { id: "hr-lv-notice", attrs: { role: "status", "aria-live": "polite" } }),
      h("div", { id: "hr-lv-body" }, V.loading())
    );
  }
  function periodText(r) {
    if (r.start_date === r.end_date) return r.start_date + (r.half_day_start || r.half_day_end ? " ½" : "");
    return r.start_date + (r.half_day_start ? " ½" : "") + " → " + r.end_date + (r.half_day_end ? " ½" : "");
  }
  HR.periodText = periodText;
  function renderLeave() {
    var box = $("#hr-lv-body");
    if (!box) return;
    var notice = $("#hr-lv-notice");
    if (notice) V.setContent(notice, M.notice ? h("p", { class: "notice ok", text: M.notice }) : null);
    var d = M.leave;
    if (!d) return V.setContent(box, V.loading());
    if (d.error) return V.setContent(box, A.errorBox(d.error));
    var today = HR.today();
    var lang = V.getLang();
    var rows = d.rows.map(function (r) {
      var cancel = null;
      if (HU.canCancelLeave(r, today)) {
        cancel = h("button", { type: "button", class: "btn secondary small", text: t("hr.cancel") });
        cancel.addEventListener("click", function () {
          V.confirmDialog(t("hr.leave.cancelConfirm"), t("hr.cancel")).then(function (yes) {
            if (!yes) return;
            V.busy(cancel, function () { return V.api("POST", "/hr/me/leave-requests/" + r.id + "/cancel"); })
              .then(function () { M.notice = null; V.toast(t("hr.leave.cancelled"), "ok"); return Promise.all([refreshLeave(), refreshMeOnly()]); })
              .catch(function () {});
          });
        });
      }
      return h("tr", null,
        h("td", null, h("strong", { text: HU.typeName(r, lang) })),
        h("td", null, HR.ltr(periodText(r))),
        h("td", { class: "num" }, HR.ltr(HU.formatDays(r.days))),
        h("td", null, HR.statusBadge(r.status),
          r.reason ? h("div", { class: "small muted", text: t("hr.reason") + ": " + r.reason }) : null,
          r.decision_note ? h("div", { class: "small muted", text: t("hr.decision.note") + ": " + r.decision_note }) : null),
        h("td", null, cancel));
    });
    V.setContent(box, A.table([t("hr.leave.type"), t("hr.leave.period"), { label: t("hr.leave.days"), num: true }, t("hr.status"), t("common.actions")], rows, { empty: t("hr.leave.none"), caption: t("hr.leave.title") }),
      d.total > d.rows.length ? h("p", { class: "small muted", text: t("hr.leave.more", { shown: d.rows.length, total: d.total }) }) : null);
  }

  function loadTypes() {
    if (M.types) return Promise.resolve(M.types);
    return V.api("GET", "/hr/me/leave-types").then(function (d) { M.types = (d && d.rows) || []; return M.types; });
  }
  function availableFor(typeId) {
    var list = (HR.me && HR.me.balances) || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].leave_type_id) === String(typeId)) return list[i];
    return null;
  }

  function openLeaveDialog() {
    if (!HR.me) return;
    loadTypes().then(function (types) {
      var lang = V.getLang();
      var tomorrow = HU.addDays(HR.today(), 1);
      var type = HR.select("hr-ld-type", [["", t("common.choose")]].concat(types.map(function (x) { return [String(x.id), HU.typeName(x, lang) + (x.counts_against_balance ? "" : " · " + t("hr.bal.notCounted"))]; })), "");
      var info = h("p", { class: "small muted", id: "hr-ld-info", attrs: { "aria-live": "polite" } });
      var start = h("input", { id: "hr-ld-start", type: "date", value: tomorrow });
      var end = h("input", { id: "hr-ld-end", type: "date", value: tomorrow });
      var hs = HR.check("hr-ld-hs", t("hr.leave.halfStart"), false);
      var he = HR.check("hr-ld-he", t("hr.leave.halfEnd"), false);
      var reason = h("textarea", { id: "hr-ld-reason", attrs: { rows: "3", maxlength: String(HU.LIMITS.reason) } });
      var err = h("p", { class: "form-error", attrs: { role: "alert" } });
      var go = h("button", { type: "submit", class: "btn", text: t("hr.leave.submit") });
      var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
      var m = HR.modal(t("hr.leave.request"), [
        types.length ? null : h("p", { class: "notice warn", text: t("hr.leave.noTypes") }),
        HR.field("hr-ld-type", t("hr.leave.type"), type), info,
        h("div", { class: "inline-fields" }, HR.field("hr-ld-start", t("hr.f.start_date"), start), HR.field("hr-ld-end", t("hr.f.end_date"), end)),
        hs.el, he.el,
        HR.field("hr-ld-reason", t("hr.reason"), reason, t("hr.leave.reasonHint", { max: HU.LIMITS.reason })),
        err,
        h("div", { class: "btn-row" }, go, cancel),
      ]);
      type.addEventListener("change", function () {
        var b = availableFor(type.value);
        var chosen = types.filter(function (x) { return String(x.id) === type.value; })[0];
        if (!chosen) return V.setContent(info);
        info.textContent = !chosen.counts_against_balance ? t("hr.leave.infoNotCounted") : b ? t("hr.leave.infoAvailable", { n: HU.formatDays(b.available_days) }) : t("hr.leave.infoNoBalance");
      });
      var state = { sending: false };
      cancel.addEventListener("click", m.close);
      m.form.addEventListener("submit", function (e) {
        e.preventDefault();
        err.textContent = "";
        var built = HU.leavePayload({ leave_type_id: type.value, start_date: start.value, end_date: end.value, half_start: hs.input.checked, half_end: he.input.checked, reason: reason.value });
        if (!built.ok) return HR.flag(built, function (f) { return { leave_type_id: "hr-ld-type", start_date: "hr-ld-start", end_date: "hr-ld-end", half_end: "hr-ld-he", reason: "hr-ld-reason" }[f]; }, err);
        HR.submit(go, state, function () { return V.api("POST", "/hr/me/leave-requests", { body: built.payload }); })
          .then(function (row) {
            m.close();
            var days = HU.formatDays(row && row.days);
            M.notice = t(row && row.status === "approved" ? "hr.leave.sentApproved" : "hr.leave.sentPending", { days: days, from: row.start_date, to: row.end_date }) +
              (row && row.days_note ? " " + t("hr.leave.defaultSchedule") : "");
            V.announce(M.notice);
            return Promise.all([refreshLeave(), refreshMeOnly()]);
          })
          .catch(function (e2) { err.textContent = V.errorMessage(e2); });
      });
      type.focus();
    }).catch(function (err) { V.toast(V.errorMessage(err), "bad"); });
  }

  // ---------------------------------------------------------------- data
  function settle(p) { return p.then(function (v) { return v; }, function (error) { return { error: error }; }); }

  function refreshRecent() {
    var today = HR.today();
    return settle(V.api("GET", "/hr/me/attendance" + HU.rangeQuery(HU.addDays(today, -3), today))).then(function (d) {
      M.recent = d && !d.error ? d.records : M.recent;
      return d;
    });
  }
  function refreshMonth() {
    return settle(V.api("GET", "/hr/me/attendance" + HU.monthQuery(M.month))).then(function (d) {
      M.monthData = d;
      renderAttendance();
      return d;
    });
  }
  function refreshCorrections() {
    return settle(V.api("GET", "/hr/me/corrections?limit=" + PAGE)).then(function (d) { M.corrections = d; renderCorrections(); return d; });
  }
  function refreshLeave() {
    return settle(V.api("GET", "/hr/me/leave-requests?limit=" + PAGE)).then(function (d) { M.leave = d; renderLeave(); return d; });
  }
  function refreshMeOnly() {
    return HR.loadMe().then(function () { renderBalances(); renderClockStatic(); renderToday(); }).catch(function () {});
  }
  function refreshTodayCalendar() {
    var today = HR.today();
    return settle(V.api("GET", "/hr/team/calendar" + HU.rangeQuery(today, today))).then(function (d) {
      M.today = { holiday: null, leave: [] };
      if (d && !d.error) {
        var hol = (d.holidays || []).filter(function (x) { return x.day === today; })[0];
        M.today.holiday = hol ? hol.name : null;
        M.today.leave = (d.entries || []).filter(function (e) { return HU.isOwn(e, HR.userId); });
      }
    });
  }

  function loadMy() {
    var mine = ++M.loadSeq;
    return HR.loadMe()
      .then(function () {
        if (mine !== M.loadSeq) return null;
        if (!M.month) M.month = HU.monthOf(HR.today());
        renderClockStatic();
        renderBalances();
        return Promise.all([refreshRecent(), refreshMonth(), refreshCorrections(), refreshLeave(), refreshTodayCalendar()]);
      })
      .then(function () {
        if (mine !== M.loadSeq) return;
        renderClockStatic();
        renderToday();
        renderAttendance();
      })
      .catch(function (err) {
        V.setContent($("#hr-today-body"), A.errorBox(err));
        $("#hr-clock-state").textContent = V.errorMessage(err);
      });
  }

  var tick = null;
  HR.register("my", {
    reset: function () {
      M.month = null; M.recent = []; M.monthData = null; M.today = { holiday: null, leave: [] }; M.corrections = null; M.leave = null; M.types = null;
      M.notice = null; M.sending = false; M.cooldown = false;
      if ($("#hr-sec-my") && HR.ready) build();
    },
    init: function () {
      build();
      V.onLang(function () {
        if (!HR.ready || !$("#hr-sec-my")) return;
        build();
        renderClockStatic();
        renderBalances();
        renderToday();
        renderAttendance();
        renderCorrections();
        renderLeave();
      });
      if (tick === null) {
        tick = window.setInterval(function () {
          var panel = $("#panel-hr");
          var sec = $("#hr-sec-my");
          if (!panel || panel.hidden || !sec || sec.hidden || !HR.me) return;
          renderLive();
        }, 1000);
      }
    },
    load: loadMy,
  });
})();
