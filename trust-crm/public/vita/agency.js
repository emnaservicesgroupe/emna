/* VITA agency portal. Uses only the agency-scoped /agency/* API (the agency always comes from the session on the
   server). An agency sees only the candidates it registered: name, profession, country, status and date. A
   registration never tells the agency whether the person is already known to VITA. */
(function () {
  "use strict";
  var V = window.VITA;
  var O = window.VITA_ORGS_UTIL;
  var C = window.VITA_ORGS;
  var t = V.t, h = V.h, $ = V.$;

  var PAGE_SIZE = 20;
  var FORM_IDS = { full_name: "reg-name", email: "reg-email", phone: "reg-phone", country: "reg-country", profession: "reg-profession", message: "reg-message", passport_number: "reg-passport", consent_attested: "reg-consent" };
  var S = { item: null, org: null, tab: "register", page: 1, total: 0, loaded: false, openId: null, tabs: null };

  function statusText(item) {
    var key = O.agencyStageKey(item);
    return key ? t(key) : String(item.status_text || "—");
  }
  function statusBadge(item) { return C.badge(item.stage === "rejected" || item.stage === "closed" ? "neutral" : item.stage === "converted" ? "ok" : "info", statusText(item)); }

  // ================================================================ session
  function showLogin() {
    S.org = null;
    S.loaded = false;
    C.showLogin();
  }

  function start() {
    var s = V.getSession();
    if (!s || s.kind !== "agency") return showLogin();
    V.api("GET", "/agency/me").then(function (me) {
      if (!me || me.role !== "Agency") {
        V.clearSession();
        showLogin();
        $("#otp-error").textContent = t("orgs.otp.wrongPortal");
        return;
      }
      S.org = me.org;
      C.showApp(me.org && me.org.name);
      if (!S.tabs) S.tabs = C.tabs($("#tabs"), function (name) { S.tab = name; if (name === "candidates") loadList(); });
      S.tabs.select(S.tab, false);
    }).catch(function (err) {
      if (err && err.status === 403) {
        V.clearSession();
        showLogin();
        $("#otp-error").textContent = t("orgs.otp.wrongPortal");
      } else if (err && err.status !== 401) V.toast(V.errorMessage(err), "bad");
    });
  }

  // ================================================================ register
  function readForm() {
    var v = {};
    Object.keys(FORM_IDS).forEach(function (k) {
      var el = $("#" + FORM_IDS[k]);
      v[k] = k === "consent_attested" ? el.checked : el.value;
    });
    return v;
  }

  function initRegister() {
    var err = $("#reg-error");
    $("#reg-form").addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      $("#reg-done").hidden = true;
      var built = O.agencyPayload(readForm());
      if (!built.ok) { C.flagField(built, function (field) { return FORM_IDS[field] || ""; }, err); return; }
      V.busy($("#reg-submit"), function () {
        // The answer is always the same plain success: it never says whether the person is already known to VITA.
        return V.api("POST", "/agency/candidates", { body: built.payload }).then(function () {
          $("#reg-form").reset();
          V.$all("#reg-form [aria-invalid]").forEach(function (el) { el.removeAttribute("aria-invalid"); });
          $("#reg-done").hidden = false;
          V.announce(t("agency.register.done"));
          V.toast(t("agency.register.done"), "ok");
          S.loaded = false;
          $("#reg-done").scrollIntoView({ block: "nearest" });
        });
      }).catch(function (e2) { err.textContent = e2 && e2.status === 429 ? t("agency.register.limit") : V.errorMessage(e2); });
    });
  }

  // ================================================================ my candidates
  function loadList() {
    var box = $("#cand-table");
    if (!S.loaded) V.setContent(box, V.loading());
    return V.api("GET", "/agency/candidates?limit=" + PAGE_SIZE + "&offset=" + (S.page - 1) * PAGE_SIZE)
      .then(function (data) {
        S.loaded = true;
        S.total = data.total;
        var pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
        if (S.page > pages) { S.page = pages; return loadList(); }
        renderList(data.candidates, pages);
      })
      .catch(function (err) { V.setContent(box, C.errorBox(err)); V.setContent($("#cand-summary")); V.clear($("#cand-pager")); });
  }

  function renderList(rows, pages) {
    V.setContent($("#cand-summary"), t("agency.list.count", { n: V.fmtNumber(S.total) }));
    var trs = rows.map(function (r) {
      var open = h("button", { type: "button", class: "btn secondary small", text: t("common.open") });
      open.addEventListener("click", function () { openCandidate(r.id, true); });
      return h("tr", { class: String(r.id) === String(S.openId) ? "selected" : null },
        h("td", null, h("strong", { text: r.full_name })),
        h("td", { text: r.profession || "—" }),
        h("td", { text: r.country || "—" }),
        h("td", null, statusBadge(r)),
        h("td", { text: V.fmtDate(r.created_at) }),
        h("td", null, open)
      );
    });
    V.setContent($("#cand-table"), C.table(
      [t("agency.f.full_name_short"), t("agency.f.profession"), t("agency.f.country"), t("orgs.f.status"), t("agency.list.registered"), t("common.actions")],
      trs, { empty: t("agency.list.none"), caption: t("agency.list.title") }));
    C.pager($("#cand-pager"), S.page, pages, function (p) { S.page = p; loadList(); });
  }

  function closeCandidate() {
    S.openId = null;
    S.item = null;
    $("#cand-card").hidden = true;
  }

  function renderCandidate(item) {
    V.setContent($("#cand-card-title"), item.full_name);
    V.setContent($("#cand-body"),
      C.kv([
        [t("agency.f.full_name_short"), item.full_name],
        [t("agency.f.profession"), item.profession],
        [t("agency.f.country"), item.country],
        [t("orgs.f.status"), statusBadge(item)],
        [t("agency.list.registered"), V.fmtDateTime(item.created_at)],
      ]),
      h("p", { class: "small muted", text: t("agency.list.statusNote") })
    );
  }

  function openCandidate(id, focus) {
    S.openId = id;
    var card = $("#cand-card");
    card.hidden = false;
    V.setContent($("#cand-body"), V.loading());
    return V.api("GET", "/agency/candidates/" + encodeURIComponent(id))
      .then(function (item) {
        if (String(S.openId) !== String(id)) return;
        S.item = item;
        renderCandidate(item);
        if (focus) { card.scrollIntoView({ block: "start" }); $("#cand-card-title").focus(); }
      })
      .catch(function (err) { V.setContent($("#cand-body"), C.errorBox(err)); });
  }

  // ================================================================ boot
  function init() {
    C.initLogin({ kind: "agency", role: "Agency", onReady: start, onLogout: showLogin });
    initRegister();
    $("#cand-refresh").addEventListener("click", function () { loadList(); });
    $("#cand-close").addEventListener("click", closeCandidate);
    V.onLang(function () {
      if (!S.org) return;
      if (S.loaded && S.tab === "candidates") loadList();
      if (S.item && !$("#cand-card").hidden) renderCandidate(S.item);
    });
    V.onUnauthorized(function () { showLogin(); V.toast(t("err.401"), "bad"); });
    var s = V.getSession();
    if (s && s.kind === "agency") start();
    else showLogin();
  }

  init();
})();
