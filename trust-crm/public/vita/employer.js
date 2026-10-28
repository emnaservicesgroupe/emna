/* VITA employer portal. Uses only the employer-scoped /employer/* API (the organisation always comes from the
   session on the server). Candidates are shown ONLY as the limited summary the API returns - the six allowlisted
   fields - and every value from the server is rendered as text. */
(function () {
  "use strict";
  var V = window.VITA;
  var O = window.VITA_ORGS_UTIL;
  var C = window.VITA_ORGS;
  var t = V.t, h = V.h, $ = V.$;

  var PAGE_SIZE = 20;
  var REQ_AREAS = { description: 6, requirements: 4 };
  var REQ_TEXT = ["title", "country", "city", "category", "salary_text"];
  var S = { row: null, org: null, tab: "requests", reqPage: 1, reqTotal: 0, reqLoaded: false, openId: null, formValues: null, presPage: 1, presLoaded: false, presData: null, notes: {}, tabs: null };

  var chat = null; // messaging panel (chat-panel.js); runs while the employer is signed in

  function statusBadge(s) { return C.badge(O.requestStatusClass(s), t("orgs.rstatus." + s)); }

  // ================================================================ session
  function showLogin() {
    if (chat) chat.stop();
    S.org = null;
    S.reqLoaded = false;
    S.presLoaded = false;
    C.showLogin();
  }

  function start() {
    var s = V.getSession();
    if (!s || s.kind !== "employer") return showLogin();
    V.api("GET", "/employer/me").then(function (me) {
      if (!me || me.role !== "Employer") {
        V.clearSession();
        showLogin();
        $("#otp-error").textContent = t("orgs.otp.wrongPortal");
        return;
      }
      S.org = me.org;
      C.showApp(me.org && me.org.name);
      if (!chat) chat = window.VITA_CHAT_PORTAL.mount({ root: $("#chat-root"), kind: "employer", badge: $("#chat-tab-badge") });
      chat.start();
      if (!S.tabs) S.tabs = C.tabs($("#tabs"), function (name) { S.tab = name; refreshCurrent(); });
      S.tabs.select(S.tab, false);
    }).catch(function (err) {
      if (err && err.status === 403) {
        V.clearSession();
        showLogin();
        $("#otp-error").textContent = t("orgs.otp.wrongPortal");
      } else if (err && err.status !== 401) V.toast(V.errorMessage(err), "bad");
    });
  }

  function refreshCurrent() {
    if (!S.org) return;
    if (S.tab === "requests") loadRequests();
    else if (S.tab === "chat") { if (chat) chat.activate(); }
    else loadPresentations();
  }

  // ================================================================ requests: list
  function loadRequests() {
    var box = $("#req-table");
    if (!S.reqLoaded) V.setContent(box, V.loading());
    return V.api("GET", "/employer/requests?limit=" + PAGE_SIZE + "&offset=" + (S.reqPage - 1) * PAGE_SIZE)
      .then(function (data) {
        S.reqLoaded = true;
        S.reqTotal = data.total;
        var pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
        if (S.reqPage > pages) { S.reqPage = pages; return loadRequests(); }
        renderRequests(data.requests, pages);
      })
      .catch(function (err) { V.setContent(box, C.errorBox(err)); V.setContent($("#req-summary")); V.clear($("#req-pager")); });
  }

  function renderRequests(rows, pages) {
    V.setContent($("#req-summary"), t("employer.requests.count", { n: V.fmtNumber(S.reqTotal) }));
    var trs = rows.map(function (r) {
      var open = h("button", { type: "button", class: "btn secondary small", text: t("common.open") });
      open.addEventListener("click", function () { openRequest(r.id, true); });
      return h("tr", { class: String(r.id) === String(S.openId) ? "selected" : null },
        h("td", null, h("strong", { text: r.title })),
        h("td", { text: V.fmtNumber(r.positions) }),
        h("td", { text: [r.country, r.city].filter(Boolean).join(" · ") || "—" }),
        h("td", null, statusBadge(r.status)),
        h("td", { text: V.fmtDate(r.created_at) }),
        h("td", null, open)
      );
    });
    V.setContent($("#req-table"), C.table(
      [t("orgs.f.title"), t("orgs.f.positions"), t("employer.requests.where"), t("orgs.f.status"), t("employer.requests.created"), t("common.actions")],
      trs, { empty: t("employer.requests.none"), caption: t("employer.requests.title") }));
    C.pager($("#req-pager"), S.reqPage, pages, function (p) { S.reqPage = p; loadRequests(); });
  }

  // ================================================================ requests: detail / form
  function closeRequest() {
    S.openId = null;
    S.row = null;
    S.formValues = null;
    $("#req-card").hidden = true;
  }

  function openForm(focus) {
    S.openId = null;
    S.row = null;
    S.formValues = O.requestValues({ positions: 1 });
    var card = $("#req-card");
    card.hidden = false;
    renderRequest(null);
    if (focus) { card.scrollIntoView({ block: "start" }); $("#req-card-title").focus(); }
  }

  function openRequest(id, focus) {
    S.openId = id;
    S.formValues = null;
    var card = $("#req-card");
    card.hidden = false;
    V.setContent($("#req-body"), V.loading());
    return V.api("GET", "/employer/requests/" + id)
      .then(function (row) {
        if (String(S.openId) !== String(id)) return;
        S.row = row;
        S.formValues = O.requestValues(row);
        renderRequest(row);
        if (focus) { card.scrollIntoView({ block: "start" }); $("#req-card-title").focus(); }
      })
      .catch(function (err) { V.setContent($("#req-body"), C.errorBox(err)); });
  }

  function readForm() {
    var v = {};
    O.REQUEST_FIELDS.forEach(function (k) {
      var el = $("#rq-" + k);
      v[k] = el ? el.value : "";
    });
    return v;
  }

  function fieldBox(name, control, hint) {
    return h("div", { class: "field" }, h("label", { for: "rq-" + name, text: t("orgs.f." + name) + (O.REQUEST_REQUIRED.indexOf(name) >= 0 ? " *" : "") }), control, hint ? h("span", { class: "hint", text: hint }) : null);
  }

  function renderRequest(row) {
    var v = S.formValues || O.requestValues(row);
    var editable = !row || O.requestEditable(row.status);
    V.setContent($("#req-card-title"), row ? t("employer.requests.detail", { title: row.title }) : t("employer.requests.formNew"));
    var parts = [];
    if (row) {
      parts.push(C.kv([
        [t("orgs.f.status"), statusBadge(row.status)],
        [t("employer.requests.created"), V.fmtDateTime(row.created_at)],
        [t("employer.requests.updated"), V.fmtDateTime(row.updated_at)],
        row.employer_visible_note ? [t("employer.requests.noteFromVita"), h("div", { class: "untrusted", text: row.employer_visible_note })] : null,
      ]));
      if (!editable) parts.push(h("p", { class: "notice info small", text: t("employer.requests.locked") }));
    }

    var inputs = {};
    var text = function (name) {
      inputs[name] = h("input", { id: "rq-" + name, type: "text", attrs: { maxlength: String(O.REQUEST_LIMITS[name]), autocomplete: "off" }, value: v[name], disabled: !editable });
      return fieldBox(name, inputs[name]);
    };
    var area = function (name) {
      inputs[name] = h("textarea", { id: "rq-" + name, attrs: { rows: String(REQ_AREAS[name]), maxlength: String(O.REQUEST_LIMITS[name]) }, value: v[name], disabled: !editable });
      return fieldBox(name, inputs[name]);
    };
    var positions = h("input", { id: "rq-positions", type: "number", attrs: { min: "1", max: "1000", step: "1", inputmode: "numeric" }, value: v.positions, disabled: !editable });
    var start = h("input", { id: "rq-start_date", type: "date", value: v.start_date, disabled: !editable });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });

    var buttons = [];
    if (editable) {
      var save = h("button", { type: "submit", class: "btn", text: row ? t("common.save") : t("employer.requests.submit") });
      buttons.push(save);
    }
    if (row && O.requestCancellable(row.status)) {
      var cancel = h("button", { type: "button", class: "btn danger", text: t("employer.requests.cancel") });
      cancel.addEventListener("click", function () { doCancel(row, cancel); });
      buttons.push(cancel);
    }

    var form = h("form", { id: "rq-form", attrs: { novalidate: "" } },
      h("div", { class: "grid two" },
        h("div", null, text("title"), fieldBox("positions", positions, t("employer.requests.positionsHint")), text("country"), text("city"), text("category")),
        h("div", null, text("salary_text"), fieldBox("start_date", start, t("employer.requests.startHint")))
      ),
      area("description"),
      area("requirements"),
      err,
      buttons.length ? h("div", { class: "btn-row" }, buttons) : null
    );
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (editable) doSave(row, err, form.querySelector("button[type=submit]"));
    });
    parts.push(form);
    V.setContent($("#req-body"), parts);
  }

  function fieldId(field) { return "rq-" + field; }

  function doSave(row, err, btn) {
    err.textContent = "";
    var built = O.requestPayload(readForm());
    if (!built.ok) { C.flagField(built, fieldId, err); return; }
    var req;
    if (!row) req = function () { return V.api("POST", "/employer/requests", { body: built.payload }); };
    else {
      var changes = O.requestDiff(row, built.payload);
      if (!Object.keys(changes).length) { V.toast(t("employer.requests.nothingToSave")); return; }
      req = function () { return V.api("PATCH", "/employer/requests/" + row.id, { body: changes }); };
    }
    S.formValues = readForm();
    V.busy(btn, function () {
      return req().then(function (saved) {
        V.toast(t(row ? "employer.requests.saved" : "employer.requests.created.toast"), "ok");
        V.announce(t(row ? "employer.requests.saved" : "employer.requests.created.toast"));
        S.reqPage = row ? S.reqPage : 1;
        loadRequests();
        return openRequest(saved.id, false);
      });
    }).catch(function (e) { err.textContent = V.errorMessage(e); });
  }

  function doCancel(row, btn) {
    V.confirmDialog(t("employer.requests.cancelConfirm", { title: row.title }), t("employer.requests.cancel"), true).then(function (ok) {
      if (!ok) return;
      V.busy(btn, function () {
        return V.api("POST", "/employer/requests/" + row.id + "/cancel", { body: {} }).then(function (saved) {
          V.toast(t("employer.requests.cancelled"), "ok");
          loadRequests();
          return openRequest(saved.id, false);
        });
      }).catch(function () {});
    });
  }

  // ================================================================ presentations
  function loadPresentations() {
    var box = $("#pres-list");
    if (!S.presLoaded) V.setContent(box, V.loading());
    return V.api("GET", "/employer/presentations?limit=" + PAGE_SIZE + "&offset=" + (S.presPage - 1) * PAGE_SIZE)
      .then(function (data) {
        S.presLoaded = true;
        var pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
        if (S.presPage > pages) { S.presPage = pages; return loadPresentations(); }
        S.presData = { items: data.presentations, total: data.total, pages: pages };
        renderPresentations();
      })
      .catch(function (err) { V.setContent(box, C.errorBox(err)); V.setContent($("#pres-summary")); V.clear($("#pres-pager")); });
  }

  /** Candidate card: the six allowlisted summary rows only, then the response controls. */
  function presentationCard(p) {
    var rows = O.summaryRows(p.summary).map(function (r) {
      return [t("orgs.summary." + r.key), r.value === null ? h("span", { class: "muted", text: t("employer.pres.notProvided") }) : r.value];
    });
    var noteId = "pres-note-" + p.id;
    var typed = Object.prototype.hasOwnProperty.call(S.notes, p.id) ? S.notes[p.id] : p.employer_note || "";
    var note = h("textarea", { id: noteId, attrs: { rows: "2", maxlength: String(O.NOTE_MAX) }, value: typed });
    note.addEventListener("input", function () { S.notes[p.id] = note.value; });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var buttons = O.RESPONSES.map(function (status) {
      var current = p.status === status;
      var b = h("button", { type: "button", class: "btn" + (current ? "" : " secondary"), text: t("employer.respond." + status), attrs: { "aria-pressed": current ? "true" : "false" } });
      if (p.closed) b.disabled = true; // the request is closed: read-only
      b.addEventListener("click", function () { respond(p, status, note.value, b, err); });
      return b;
    });
    var answered = p.responded_at
      ? h("p", { class: "small" }, h("strong", { text: t("employer.pres.answered") + ": " }), V.fmtDateTime(p.responded_at))
      : h("p", { class: "small muted", text: t("employer.pres.awaiting") });
    var closedNote = p.closed ? h("p", { class: "small muted", text: t("employer.pres.closed") }) : null;
    return h("article", { class: "card" },
      h("div", { class: "card-head" },
        h("h3", { text: p.request_title }), h("span", { class: "spacer" }),
        C.badge(O.presentationStatusClass(p.status), t("orgs.pstatus." + p.status))
      ),
      h("p", { class: "small muted", text: t("employer.pres.presentedOn", { date: V.fmtDate(p.created_at) }) }),
      C.kv(rows),
      answered,
      closedNote,
      h("div", { class: "field" },
        h("label", { for: noteId, text: t("employer.pres.noteLabel") }),
        note,
        h("span", { class: "hint", text: t("employer.pres.noteHint", { max: V.fmtNumber(O.NOTE_MAX) }) })
      ),
      err,
      h("div", { class: "btn-row", attrs: { role: "group", "aria-label": t("employer.pres.respondGroup") } }, buttons)
    );
  }

  function renderPresentations() {
    var d = S.presData;
    if (!d) return;
    V.setContent($("#pres-summary"), t("employer.pres.count", { n: V.fmtNumber(d.total) }));
    if (!d.items.length) V.setContent($("#pres-list"), V.empty(t("employer.pres.none")));
    else V.setContent($("#pres-list"), d.items.map(presentationCard));
    C.pager($("#pres-pager"), S.presPage, d.pages, function (p) { S.presPage = p; loadPresentations(); });
  }

  function respond(p, status, noteValue, btn, err) {
    err.textContent = "";
    var built = O.respondPayload(status, noteValue);
    if (!built.ok) { err.textContent = C.validationMessage(built); return; }
    V.busy(btn, function () {
      return V.api("POST", "/employer/presentations/" + p.id + "/respond", { body: built.payload }).then(function () {
        delete S.notes[p.id];
        V.toast(t("employer.pres.sent"), "ok");
        V.announce(t("employer.pres.sent"));
        return loadPresentations();
      });
    }).catch(function (e) { err.textContent = V.errorMessage(e); });
  }

  // ================================================================ boot
  function init() {
    C.initLogin({ kind: "employer", role: "Employer", onReady: start, onLogout: showLogin });
    $("#req-new").addEventListener("click", function () { openForm(true); });
    $("#req-refresh").addEventListener("click", function () { loadRequests(); });
    $("#req-close").addEventListener("click", closeRequest);
    $("#pres-refresh").addEventListener("click", function () { loadPresentations(); });
    V.onLang(function () {
      if (!S.org) return;
      if (S.reqLoaded) loadRequests();
      if (!$("#req-card").hidden && $("#rq-form")) {
        S.formValues = readForm(); // keep what was typed while switching language
        renderRequest(S.row);
      }
      if (S.presData) renderPresentations();
    });
    V.onUnauthorized(function () { showLogin(); V.toast(t("err.401"), "bad"); });
    var s = V.getSession();
    if (s && s.kind === "employer") start();
    else showLogin();
  }

  init();
})();
