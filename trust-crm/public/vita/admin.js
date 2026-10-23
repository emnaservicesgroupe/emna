/* VITA staff console. All data comes from /jobsearch/* (and /auth/login). Everything coming from
   the server - job ads, employer replies, CV extraction, notes - is rendered as text only. The UI
   hides or disables actions a role cannot take, but the server is the authority on every call. */
(function () {
  "use strict";
  var V = window.VITA;
  var t = V.t, tc = V.tc, h = V.h, $ = V.$;

  var STAFF_ROLES = ["SuperAdmin", "Admin", "Manager", "Receptionist", "Agent"];
  var PERMS = {
    SuperAdmin: ["read", "write", "approve", "admin"],
    Admin: ["read", "write", "approve", "admin"],
    Manager: ["read", "write", "approve"],
    Receptionist: ["read", "write"],
    Agent: ["read", "write"],
  };
  var STATUSES = ["matched", "preparing", "ready_for_review", "approved", "queued", "sent", "confirmed_submitted", "failed", "outcome_unknown", "needs_staff", "cancelled", "closed", "interview", "offer", "rejected"];
  var PREPARABLE = ["matched", "preparing", "ready_for_review", "failed", "needs_staff"];
  var CANCELLABLE = ["matched", "preparing", "ready_for_review", "approved", "queued", "failed", "needs_staff", "outcome_unknown"];
  var LANES = [
    { key: "preparing", statuses: ["matched", "preparing"] },
    { key: "ready_for_review", statuses: ["ready_for_review"] },
    { key: "queued", statuses: ["approved", "queued"] },
    { key: "submitted", statuses: ["sent", "confirmed_submitted"], cls: "done" },
    { key: "interviews", statuses: ["interview"], cls: "done" },
    { key: "outcomes", statuses: ["offer", "rejected", "closed", "cancelled"], cls: "done" },
    { key: "attention", statuses: ["needs_staff", "failed", "outcome_unknown"], cls: "attention" },
  ];
  var GROUPS = ["candidate", "country", "staff", "profession", "employer", "source", "status", "period"];
  var PERIODS = ["day", "week", "month"];
  var EXPORT_TYPES = ["applications", "matches", "submissions", "messages", "tasks"];
  var METRICS = ["found", "matched", "prepared", "submitted", "confirmed", "failed", "outcome_unknown", "replies", "interviews", "offers", "rejections"];

  var S = {
    session: null,
    tab: "dashboard",
    dash: null,
    candidateId: null,
    appsPage: 1,
    appsQuery: {},
    sources: [],
    employers: {},
    drawerAppId: null,
    drawerOpener: null,
    messageId: null,
    events: null,
  };

  function role() { return S.session ? S.session.role : null; }
  function can(p) { return (PERMS[role()] || []).indexOf(p) >= 0; }
  function isAdmin() { return role() === "Admin" || role() === "SuperAdmin"; }
  function canSeeHealth() { return ["Admin", "SuperAdmin", "Manager"].indexOf(role()) >= 0; }
  function candidateName(id) {
    var c = S.dash && S.dash.candidates.find(function (x) { return x.candidateId === id; });
    return c ? c.name : "#" + id;
  }
  function errorBox(err) { return h("p", { class: "notice bad", attrs: { role: "alert" }, text: V.errorMessage(err) }); }
  function kv(pairs) {
    var dl = h("dl", { class: "kv" });
    pairs.forEach(function (p) {
      if (!p) return;
      dl.appendChild(h("dt", { text: p[0] }));
      dl.appendChild(h("dd", null, p[1] === null || p[1] === undefined || p[1] === "" ? "—" : p[1]));
    });
    return dl;
  }
  function qs(obj) {
    var parts = [];
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v === undefined || v === null || v === "") return;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    });
    return parts.length ? "?" + parts.join("&") : "";
  }
  function table(headers, rows, opts) {
    var o = opts || {};
    if (!rows.length) return V.empty(o.empty);
    var thead = h("thead", null, h("tr", null, headers.map(function (x) { return h("th", { scope: "col", class: x.num ? "num" : null, text: x.label || x }); })));
    var tbody = h("tbody", null, rows);
    return h("div", { class: "table-wrap" }, h("table", null, o.caption ? h("caption", { class: "sr-only", text: o.caption }) : null, thead, tbody));
  }
  function option(value, label, selected) { return h("option", { value: value, text: label, selected: selected }); }
  function fillSelect(sel, items, current) {
    V.clear(sel);
    items.forEach(function (it) { sel.appendChild(option(it[0], it[1], String(it[0]) === String(current === undefined || current === null ? "" : current))); });
  }

  // ================================================================ login / session
  function showLogin() {
    if (S.events) { S.events.stop(); S.events = null; }
    S.session = null;
    $("#app-view").hidden = true;
    $("#logout").hidden = true;
    V.setContent($("#who"));
    V.setContent($("#live-status"));
    closeDrawer();
    $("#login-view").hidden = false;
    var email = $("#login-email");
    if (email) email.focus();
  }

  function initLogin() {
    $("#login-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var email = $("#login-email").value.trim();
      var password = $("#login-password").value;
      var errEl = $("#login-error");
      errEl.textContent = "";
      if (!email || !password) {
        errEl.textContent = t("login.required");
        return;
      }
      var btn = e.submitter || $("#login-form button[type=submit]");
      btn.disabled = true;
      V.api("POST", "/auth/login", { body: { email: email, password: password }, noAuth: true })
        .then(function (r) {
          if (!r || !r.token || STAFF_ROLES.indexOf(r.role) < 0) {
            errEl.textContent = r && r.role === "Candidate" ? t("login.candidateUsePortal") : t("login.notStaff");
            return;
          }
          V.setSession({ kind: "staff", token: r.token, role: r.role, name: r.name, userId: r.user_id });
          $("#login-password").value = "";
          start();
        })
        .catch(function (err) {
          errEl.textContent = err && err.status === 400 ? t("login.failed") : V.errorMessage(err);
        })
        .finally(function () { btn.disabled = false; });
    });
    $("#logout").addEventListener("click", function () {
      V.clearSession();
      V.announce(t("common.signedOut"));
      showLogin();
    });
  }

  function start() {
    var s = V.getSession();
    if (!s || s.kind !== "staff") return showLogin();
    S.session = s;
    V.api("GET", "/jobsearch/auth/me")
      .then(function (me) {
        if (!me || STAFF_ROLES.indexOf(me.role) < 0) {
          V.clearSession();
          return showLogin();
        }
        S.session.role = me.role;
        $("#login-view").hidden = true;
        $("#app-view").hidden = false;
        $("#logout").hidden = false;
        renderWho();
        setupTabs();
        S.events = V.connectEvents({
          onEvent: function () { refreshSoon(); },
          onStatus: V.liveIndicator($("#live-status")),
          refetch: function () { refreshCurrent(); },
        });
        if (!routeFromHash()) selectTab(S.tab, false);
      })
      .catch(function (err) {
        if (err && err.status !== 401) V.toast(V.errorMessage(err), "bad");
      });
  }

  // ================================================================ tabs + routing
  var tabsReady = false;
  function setupTabs() {
    if (tabsReady) return;
    tabsReady = true;
    var buttons = V.$all("#tabs [role=tab]");
    buttons.forEach(function (b, i) {
      b.addEventListener("click", function () { selectTab(b.getAttribute("data-tab"), true); });
      b.addEventListener("keydown", function (e) {
        var rtl = document.documentElement.dir === "rtl";
        var next = null;
        if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = buttons[(i + 1) % buttons.length];
        else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = buttons[(i - 1 + buttons.length) % buttons.length];
        else if (e.key === "Home") next = buttons[0];
        else if (e.key === "End") next = buttons[buttons.length - 1];
        if (next) {
          e.preventDefault();
          next.focus();
          selectTab(next.getAttribute("data-tab"), false);
        }
      });
    });
    // role-dependent tabs
    $("#tab-health").hidden = !canSeeHealth();
    $("#tab-scheduler").hidden = !isAdmin();
    initDashboard();
    initApplications();
    initReview();
    initInterviews();
    initSources();
    initSettings();
    initReports();
    initHealth();
    initScheduler();
    initDirectory();
    initDrawer();
    window.addEventListener("hashchange", routeFromHash);
  }

  function selectTab(name, focusPanel) {
    S.tab = name;
    V.$all("#tabs [role=tab]").forEach(function (b) {
      var on = b.getAttribute("data-tab") === name;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    V.$all("[role=tabpanel]").forEach(function (p) { p.hidden = p.id !== "panel-" + name; });
    if (focusPanel) {
      var panel = $("#panel-" + name);
      if (panel) panel.focus();
    }
    refreshCurrent();
  }

  function routeFromHash() {
    var m = /^#\/(applications|candidates|messages|tasks)\/(\d+)$/.exec(location.hash);
    if (!m) return false;
    var id = Number(m[2]);
    if (m[1] === "applications") {
      selectTab("applications", false);
      openDrawer(id);
    } else if (m[1] === "candidates") {
      S.candidateId = id;
      selectTab("dashboard", false);
    } else if (m[1] === "messages") {
      selectTab("review", false);
      openMessage(id);
    } else {
      selectTab("review", false);
    }
    return true;
  }

  var refreshSoon = V.debounce(function () { refreshCurrent(); }, 600);
  function refreshCurrent() {
    if (!S.session) return;
    var loaders = { dashboard: loadDashboard, applications: loadApplications, review: loadReview, interviews: loadInterviews, sources: loadSources, settings: loadSettings, reports: function () {}, health: loadHealth, scheduler: loadScheduler, directory: loadDirectory };
    (loaders[S.tab] || function () {})();
    if (S.drawerAppId) renderDrawer(S.drawerAppId, true);
  }

  function renderWho() { if (S.session) V.setContent($("#who"), (S.session.name || "") + " · " + tc("role", S.session.role)); }
  V.onLang(function () { if (S.session) { renderWho(); refreshCurrent(); } });

  // ================================================================ dashboard
  function initDashboard() {
    $("#dash-refresh").addEventListener("click", function () { loadDashboard(); });
    $("#dash-candidate").addEventListener("change", function () {
      var v = $("#dash-candidate").value;
      S.candidateId = v ? Number(v) : null;
      renderCandidateCard();
    });
  }

  function loadDashboard() {
    var box = $("#dash-totals");
    if (!S.dash) V.setContent(box, V.loading());
    return V.api("GET", "/jobsearch/dashboard")
      .then(function (d) {
        S.dash = d;
        fillCandidateSelects();
        renderTotals(d);
        renderCandidates(d);
        renderAttention(d);
        renderModuleControls();
        renderCandidateCard();
        return d;
      })
      .catch(function (err) { V.setContent(box, errorBox(err)); });
  }

  function fillCandidateSelects() {
    var items = [["", t("filter.allCandidates")]].concat((S.dash ? S.dash.candidates : []).map(function (c) { return [String(c.candidateId), c.name + " (#" + c.candidateId + ")"]; }));
    fillSelect($("#dash-candidate"), items, S.candidateId);
    fillSelect($("#f-candidate"), items, S.appsQuery.candidateId || "");
    var sItems = [["", t("settings.pick")]].concat(items.slice(1));
    fillSelect($("#settings-candidate"), sItems, S.settingsCandidate || "");
  }

  function stat(n, label, cls) { return h("div", { class: "stat " + (cls || "") }, h("div", { class: "n", text: V.fmtNumber(n) }), h("div", { class: "l", text: label })); }

  function renderTotals(d) {
    var x = d.totals || {};
    var sub = x.submitted || {};
    V.setContent($("#dash-totals"), h("div", { class: "stats" },
      stat(x.matches, t("lane.matches")),
      stat((x.matched || 0) + (x.preparing || 0), t("lane.preparing")),
      stat(x.ready_for_review, t("lane.ready_for_review"), "gold"),
      stat((x.approved || 0) + (x.queued || 0), t("lane.queued")),
      stat(sub.awaiting_confirmation, t("lane.sentAwaiting")),
      stat(sub.confirmed, t("lane.confirmed"), "gold"),
      stat(x.replies, t("lane.replies")),
      stat(x.interviews, t("lane.interviews")),
      stat(x.offers, t("lane.offers"), "gold"),
      stat((x.rejected || 0) + (x.closed || 0) + (x.cancelled || 0), t("lane.outcomes")),
      stat((x.needs_staff || 0) + (x.failed || 0) + (x.outcome_unknown || 0), t("lane.attention"), "bad"),
      x.open_tasks !== undefined ? stat(x.open_tasks, t("lane.openTasks"), "bad") : null
    ));
  }

  function renderCandidates(d) {
    var rows = d.candidates.map(function (c) {
      var x = c.counts;
      var open = h("button", { type: "button", class: "btn secondary small", text: t("common.open") });
      open.addEventListener("click", function () {
        S.candidateId = c.candidateId;
        $("#dash-candidate").value = String(c.candidateId);
        renderCandidateCard();
        $("#dash-candidate-card").scrollIntoView({ block: "start" });
        $("#dash-candidate-name").focus();
      });
      return h("tr", null,
        h("td", null, h("strong", { text: c.name }), h("div", { class: "small muted", text: "#" + c.candidateId })),
        h("td", { class: "num", text: V.fmtNumber(x.matches) }),
        h("td", { class: "num", text: V.fmtNumber(x.ready_for_review) }),
        h("td", { class: "num", text: V.fmtNumber((x.approved || 0) + (x.queued || 0)) }),
        h("td", { class: "num", text: V.fmtNumber(x.submitted.awaiting_confirmation) }),
        h("td", { class: "num", text: V.fmtNumber(x.submitted.confirmed) }),
        h("td", { class: "num", text: V.fmtNumber(x.replies) }),
        h("td", { class: "num", text: V.fmtNumber(x.interviews) }),
        h("td", { class: "num", text: V.fmtNumber((x.needs_staff || 0) + (x.open_tasks || 0)) }),
        h("td", null, open)
      );
    });
    V.setContent($("#dash-candidates"), table([
      t("dash.candidate"), { label: t("lane.matches"), num: true }, { label: t("lane.ready_for_review"), num: true }, { label: t("lane.queued"), num: true },
      { label: t("lane.sentAwaiting"), num: true }, { label: t("lane.confirmed"), num: true }, { label: t("lane.replies"), num: true },
      { label: t("lane.interviews"), num: true }, { label: t("lane.attention"), num: true }, t("common.actions"),
    ], rows, { empty: t("dash.noCandidates"), caption: t("dash.candidates") }));
  }

  function renderAttention(d) {
    var items = d.attention || [];
    if (!items.length) return V.setContent($("#dash-attention"), V.empty(t("dash.noAttention")));
    var rows = items.map(function (a) {
      var go = h("button", { type: "button", class: "btn secondary small", text: t("common.open") });
      go.addEventListener("click", function () { openAttention(a); });
      return h("tr", null,
        h("td", null, h("span", { class: "badge bad", text: tc("task", a.reason) })),
        h("td", { text: a.candidateId ? candidateName(a.candidateId) : t("dash.unassigned") }),
        h("td", { text: a.applicationId ? "#" + a.applicationId : "—" }),
        h("td", { text: t("dash.ageHours", { n: V.fmtNumber(a.ageHours) }) }),
        h("td", null, go)
      );
    });
    V.setContent($("#dash-attention"), table([t("dash.reason"), t("dash.candidate"), t("dash.application"), t("dash.age"), t("common.actions")], rows, { caption: t("dash.attention") }));
  }

  function openAttention(a) {
    if (a.applicationId) return openDrawer(a.applicationId);
    var m = /#\/messages\/(\d+)$/.exec(a.link || "");
    if (m) {
      selectTab("review", false);
      return openMessage(Number(m[1]));
    }
    if (a.candidateId) {
      S.candidateId = a.candidateId;
      $("#dash-candidate").value = String(a.candidateId);
      return renderCandidateCard();
    }
    selectTab("review", true);
  }

  function renderModuleControls() {
    var box = $("#dash-module");
    var gen = (S.modGen = (S.modGen || 0) + 1);
    V.clear(box);
    if (isAdmin()) {
      var all = h("button", { type: "button", class: "btn secondary small", text: t("search.nowAll") });
      all.addEventListener("click", function () {
        V.busy(all, function () {
          return V.api("POST", "/jobsearch/search/run", { body: {} }).then(function (r) {
            V.toast(t("search.queued", { id: r.queueId }), "ok");
          });
        }).catch(function () {});
      });
      box.appendChild(all);
    }
    if (canSeeHealth()) {
      V.api("GET", "/jobsearch/health").then(function (hl) {
        if (gen !== S.modGen) return; // a newer render owns the box
        var paused = hl.modulePaused;
        box.appendChild(h("span", { class: "badge " + (paused ? "bad" : "ok"), text: paused ? t("module.paused") : t("module.running") }));
        if (isAdmin()) {
          var b = h("button", { type: "button", class: "btn small " + (paused ? "" : "danger"), text: paused ? t("module.resume") : t("module.pause") });
          b.addEventListener("click", function () {
            V.confirmDialog(paused ? t("module.resumeConfirm") : t("module.pauseConfirm"), paused ? t("module.resume") : t("module.pause"), !paused).then(function (ok) {
              if (!ok) return;
              V.busy(b, function () {
                return V.api("POST", "/jobsearch/module/pause", { body: { paused: !paused } }).then(function () {
                  V.toast(paused ? t("module.resumed") : t("module.pausedDone"), "ok");
                  loadDashboard();
                });
              }).catch(function () {});
            });
          });
          box.appendChild(b);
        }
      }).catch(function () { /* health is optional here */ });
    }
  }

  function renderCandidateCard() {
    var card = $("#dash-candidate-card");
    if (!S.candidateId) { card.hidden = true; return; }
    card.hidden = false;
    var id = S.candidateId;
    var gen = (S.cardGen = (S.cardGen || 0) + 1);
    var stale = function () { return gen !== S.cardGen; };
    V.setContent($("#dash-candidate-name"), candidateName(id));
    $("#dash-candidate-name").setAttribute("tabindex", "-1");
    V.setContent($("#dash-lanes"), V.loading());
    var actions = $("#dash-candidate-actions");
    V.clear(actions);
    var search = h("button", { type: "button", class: "btn small", text: t("search.now") });
    search.addEventListener("click", function () {
      V.busy(search, function () {
        return V.api("POST", "/jobsearch/search/run", { body: { candidateId: id } }).then(function (r) {
          var msg = t("search.queuedAt", { id: r.queueId, time: V.fmtDateTime(new Date()) });
          V.setContent($("#dash-search-status"), h("span", { class: "badge info", text: t("search.queuedBadge") }), " ", msg);
          V.announce(msg);
        });
      }).catch(function () {});
    });
    actions.appendChild(search);
    var settingsBtn = h("button", { type: "button", class: "btn secondary small", text: t("tab.settings") });
    settingsBtn.addEventListener("click", function () { S.settingsCandidate = id; selectTab("settings", true); });
    actions.appendChild(settingsBtn);

    V.api("GET", "/jobsearch/candidates/" + id + "/settings").then(function (st) {
      if (stale()) return;
      var paused = Boolean(st.paused);
      var b = h("button", { type: "button", class: "btn secondary small", text: paused ? t("candidate.resume") : t("candidate.pause") });
      b.addEventListener("click", function () {
        V.busy(b, function () {
          return V.api("POST", "/jobsearch/candidates/" + id + "/pause", { body: { paused: !paused } }).then(function () {
            V.toast(paused ? t("candidate.resumed") : t("candidate.pausedDone"), "ok");
            renderCandidateCard();
          });
        }).catch(function () { /* reported by busy() */ });
      });
      actions.appendChild(h("span", { class: "badge " + (paused ? "bad" : "ok"), text: paused ? t("candidate.paused") : t("candidate.active") }));
      actions.appendChild(h("span", { class: "badge neutral", text: tc("mode", st.mode) }));
      actions.appendChild(b);
    }).catch(function () {});
    V.api("GET", "/jobsearch/candidates/" + id + "/eligibility").then(function (e) {
      if (stale()) return;
      if (!e.eligible) {
        V.setContent($("#dash-search-status"), h("span", { class: "badge warn", text: t("search.notEligible") }), " ", e.reasons.map(function (r) { return tc("elig", r); }).join(" · "));
        search.disabled = true;
        search.title = t("search.notEligible");
      }
    }).catch(function () {});

    Promise.all([
      V.api("GET", "/jobsearch/applications" + qs({ candidateId: id, pageSize: 100 })),
      V.api("GET", "/jobsearch/candidates/" + id + "/matches?pageSize=5"),
    ]).then(function (res) {
      if (stale()) return;
      var apps = res[0].applications;
      var matches = res[1];
      var counts = (S.dash.candidates.find(function (c) { return c.candidateId === id; }) || {}).counts || {};
      var lanes = [];
      var ml = h("div", { class: "lane" }, h("h3", null, h("span", { text: t("lane.matches") }), h("span", { class: "badge info", text: V.fmtNumber(matches.total) })));
      var ul = h("ul");
      matches.matches.forEach(function (m) {
        ul.appendChild(h("li", null, h("strong", { text: m.job.title }), " · ", m.job.employer || "—", " · ", h("span", { class: "score", text: V.fmtNumber(m.score) })));
      });
      ml.appendChild(ul);
      lanes.push(ml);
      LANES.forEach(function (lane) {
        var items = apps.filter(function (a) { return lane.statuses.indexOf(a.status) >= 0; });
        var el = h("div", { class: "lane " + (lane.cls || "") }, h("h3", null, h("span", { text: t("lane." + lane.key) }), h("span", { class: "badge neutral", text: V.fmtNumber(items.length) })));
        if (lane.key === "submitted") el.appendChild(h("p", { class: "small muted", text: t("lane.submittedHint") }));
        var list = h("ul");
        items.slice(0, 12).forEach(function (a) {
          var b = h("button", { type: "button", class: "linklike", text: a.job.title + " · " + (a.employer.name || "—") });
          b.addEventListener("click", function () { openDrawer(a.id, b); });
          list.appendChild(h("li", null, b, " ", V.statusBadge(a.status)));
        });
        el.appendChild(list);
        lanes.push(el);
      });
      lanes.push(h("div", { class: "lane" }, h("h3", null, h("span", { text: t("lane.replies") }), h("span", { class: "badge neutral", text: V.fmtNumber(counts.replies) }))));
      V.setContent($("#dash-lanes"), lanes);
    }).catch(function (err) { V.setContent($("#dash-lanes"), errorBox(err)); });
  }

  // ================================================================ applications
  function initApplications() {
    fillSelect($("#f-status"), [["", t("filter.any")]].concat(STATUSES.map(function (s) { return [s, tc("status", s)]; })), "");
    fillSelect($("#f-employer"), [["", t("filter.any")]], "");
    fillSelect($("#f-source"), [["", t("filter.any")]], "");
    $("#app-filters").addEventListener("submit", function (e) {
      e.preventDefault();
      S.appsPage = 1;
      S.appsQuery = readFilters();
      loadApplications();
    });
    $("#app-filters").addEventListener("reset", function () {
      window.setTimeout(function () {
        S.appsPage = 1;
        S.appsQuery = {};
        loadApplications();
      }, 0);
    });
  }
  function readFilters() {
    var f = $("#app-filters");
    var q = {};
    ["candidateId", "country", "profession", "staffId", "employerId", "sourceKey", "status", "from", "to"].forEach(function (k) {
      var el = f.elements[k];
      if (el && el.value.trim()) q[k] = el.value.trim();
    });
    return q;
  }
  function refreshFilterOptions() {
    var emp = [["", t("filter.any")]].concat(Object.keys(S.employers).map(function (id) { return [id, S.employers[id]]; }));
    var cur = $("#f-employer").value;
    fillSelect($("#f-employer"), emp, cur);
    var src = [["", t("filter.any")]].concat(S.sources.map(function (s) { return [s.key, s.name || s.key]; }));
    var curS = $("#f-source").value;
    fillSelect($("#f-source"), src, curS);
  }
  function loadApplications() {
    if (!S.dash) loadDashboard();
    if (!S.sources.length) loadSourcesData().then(refreshFilterOptions).catch(function () {});
    var box = $("#apps-table");
    V.setContent(box, V.loading());
    var q = Object.assign({}, S.appsQuery, { page: S.appsPage, pageSize: 25 });
    return V.api("GET", "/jobsearch/applications" + qs(q)).then(function (r) {
      r.applications.forEach(function (a) { if (a.employer && a.employer.id) S.employers[a.employer.id] = a.employer.name || "#" + a.employer.id; });
      refreshFilterOptions();
      var pages = Math.max(1, Math.ceil(r.total / r.pageSize));
      V.setContent($("#apps-summary"), t("apps.summary", { total: V.fmtNumber(r.total), page: V.fmtNumber(r.page), pages: V.fmtNumber(pages) }));
      var rows = r.applications.map(function (a) {
        var open = h("button", { type: "button", class: "btn secondary small", text: t("common.open"), attrs: { "aria-label": t("apps.openNamed", { id: a.id }) } });
        open.addEventListener("click", function () { openDrawer(a.id, open); });
        return h("tr", null,
          h("td", { class: "num", text: "#" + a.id }),
          h("td", { text: a.candidateName || "#" + a.candidateId }),
          h("td", { text: a.job.title }),
          h("td", { text: a.employer.name || "—" }),
          h("td", { text: a.job.country || "—" }),
          h("td", { text: a.job.source || "—" }),
          h("td", null, V.statusBadge(a.status)),
          h("td", { text: V.fmtDateTime(a.updatedAt) }),
          h("td", null, open)
        );
      });
      V.setContent(box, table([{ label: "#", num: true }, t("filter.candidate"), t("apps.job"), t("filter.employer"), t("filter.country"), t("filter.source"), t("filter.status"), t("apps.updated"), t("common.actions")], rows, { empty: t("apps.none"), caption: t("apps.title") }));
      var pager = $("#apps-pager");
      V.clear(pager);
      var prev = h("button", { type: "button", class: "btn secondary small", text: t("common.prev"), disabled: r.page <= 1 });
      var next = h("button", { type: "button", class: "btn secondary small", text: t("common.next"), disabled: r.page >= pages });
      prev.addEventListener("click", function () { S.appsPage -= 1; loadApplications(); });
      next.addEventListener("click", function () { S.appsPage += 1; loadApplications(); });
      pager.appendChild(prev);
      pager.appendChild(h("span", { class: "small", text: t("common.pageOf", { page: V.fmtNumber(r.page), pages: V.fmtNumber(pages) }) }));
      pager.appendChild(next);
    }).catch(function (err) { V.setContent(box, errorBox(err)); });
  }

  // ================================================================ application drawer
  function initDrawer() {
    $("#drawer-close").addEventListener("click", closeDrawer);
    $("#drawer-backdrop").addEventListener("click", closeDrawer);
    $("#drawer-print").addEventListener("click", function () { window.print(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("#drawer").hidden && !document.querySelector("dialog[open]")) closeDrawer();
      if (e.key === "Tab" && !$("#drawer").hidden) trapFocus(e);
    });
  }
  function trapFocus(e) {
    var d = $("#drawer");
    var f = V.$all("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex='0']", d).filter(function (x) { return x.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === d)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function openDrawer(id, opener) {
    S.drawerAppId = id;
    S.drawerOpener = opener || document.activeElement;
    $("#drawer").hidden = false;
    $("#drawer-backdrop").hidden = false;
    V.setContent($("#drawer-body"), V.loading());
    $("#drawer").focus();
    renderDrawer(id, false);
  }
  function closeDrawer() {
    if (!S.drawerAppId && $("#drawer").hidden) return;
    S.drawerAppId = null;
    $("#drawer").hidden = true;
    $("#drawer-backdrop").hidden = true;
    if (/^#\/applications\//.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
    if (S.drawerOpener && S.drawerOpener.focus && document.body.contains(S.drawerOpener)) S.drawerOpener.focus();
  }

  function renderDrawer(id, quiet) {
    var body = $("#drawer-body");
    var calls = [
      V.api("GET", "/jobsearch/applications/" + id),
      V.api("GET", "/jobsearch/submissions?applicationId=" + id).catch(function () { return { submissions: [] }; }),
      V.api("GET", "/jobsearch/applications/" + id + "/recipient").catch(function (err) { return { error: err }; }),
      V.api("GET", "/jobsearch/messages?applicationId=" + id).catch(function () { return { messages: [] }; }),
      V.api("GET", "/jobsearch/interviews?applicationId=" + id).catch(function () { return { interviews: [] }; }),
    ];
    return Promise.all(calls).then(function (r) {
      if (S.drawerAppId !== id) return null;
      // the candidate's CV versions (for approval on the candidate's behalf); a missing profile is not an error
      return V.api("GET", "/jobsearch/candidates/" + r[0].application.candidateId + "/profile").catch(function () { return null; }).then(function (p) { r.push(p); return r; });
    }).then(function (r) {
      if (!r || S.drawerAppId !== id) return;
      var scrollTop = $("#drawer").scrollTop;
      V.setContent(body, drawerContent(r[0], r[1].submissions, r[2], r[3].messages, r[4].interviews, r[5]));
      if (quiet) $("#drawer").scrollTop = scrollTop;
      else V.announce(t("drawer.loaded"));
    }).catch(function (err) {
      if (S.drawerAppId === id) V.setContent(body, errorBox(err));
    });
  }

  function drawerContent(d, subs, recipient, messages, interviews, profile) {
    var a = d.application;
    var out = [];
    V.setContent($("#drawer-title"), (d.job ? d.job.title : t("drawer.title")) + " · #" + a.id);
    out.push(h("p", null, V.statusBadge(a.status), " ", h("span", { class: "small muted", text: t("drawer.candidate") + ": " + candidateName(a.candidateId) + " · " + t("drawer.mode") + ": " + tc("mode", a.modeAtCreation) })));

    // ---- recipient (who would receive the CV)
    out.push(recipientBlock(recipient));

    // ---- actions
    out.push(actionsBlock(d, recipient));

    // ---- job + employer
    var job = d.job || {};
    out.push(h("section", { class: "card" }, h("h3", { text: t("drawer.job") }), kv([
      [t("drawer.jobTitle"), job.title],
      [t("filter.employer"), d.employer ? d.employer.name : null],
      [t("drawer.employerDomain"), d.employer && d.employer.domain ? h("span", { class: "ltr-island", text: d.employer.domain }) : null],
      [t("filter.country"), job.country],
      [t("drawer.location"), job.location],
      [t("filter.source"), job.source],
      [t("drawer.jobStatus"), job.status ? tc("jobStatus", job.status) : null],
      [t("drawer.closing"), job.closingAt ? V.fmtDateTime(job.closingAt) : null],
      [t("drawer.link"), job.url ? V.safeLink(job.url, t("drawer.openAd")) : null],
    ])));

    // ---- match + label
    var m = d.match;
    var matchSec = h("section", { class: "card" }, h("h3", { text: t("drawer.match") }));
    if (m) {
      matchSec.appendChild(V.supportBlock(m.employerSupport));
      matchSec.appendChild(V.overseasBlock(m.overseas));
      matchSec.appendChild(V.scoreBlock(m));
    } else matchSec.appendChild(h("p", { class: "muted", text: t("drawer.noMatch") }));
    out.push(matchSec);

    // ---- auto approval
    if (d.autoApproval) {
      out.push(h("section", { class: "card" }, h("h3", { text: t("drawer.autoApproval") }),
        h("p", null, h("span", { class: "badge " + (d.autoApproval.allowed ? "ok" : "neutral"), text: d.autoApproval.allowed ? t("drawer.autoAllowed") : t("drawer.autoNotAllowed") })),
        d.autoApproval.reasons && d.autoApproval.reasons.length ? h("ul", { class: "compact" }, d.autoApproval.reasons.map(function (x) { return h("li", { text: tc("auto", x) }); })) : null
      ));
    }

    // ---- documents
    var docs = d.documents || [];
    var sensitive = docs.some(function (x) { return x.sensitive && !x.removedAt; });
    var docRows = docs.map(function (x) {
      return h("tr", null,
        h("td", { text: x.kind === "cv" ? t("docs.cv") : tc("docType", x.docType) }),
        h("td", { class: "num", text: x.version !== null && x.version !== undefined ? V.fmtNumber(x.version) : "—" }),
        h("td", { text: x.language || "—" }),
        h("td", null, x.sensitive ? h("span", { class: "badge bad", text: t("docs.sensitive") }) : h("span", { class: "badge neutral", text: t("docs.normal") })),
        h("td", { text: x.approvedAt ? V.fmtDateTime(x.approvedAt) : t("docs.notApproved") }),
        h("td", { text: x.removedAt ? t("docs.removed", { reason: x.removedReason || "" }) : x.sharingAuthorizationId ? t("docs.authorized") : "—" })
      );
    });
    var docSec = h("section", { class: "card" }, h("h3", { text: t("drawer.documents") }),
      sensitive ? h("p", { class: "notice bad", text: t("docs.sensitiveWarning") }) : null,
      table([t("docs.kind"), { label: t("docs.version"), num: true }, t("docs.language"), t("docs.sensitivity"), t("docs.approved"), t("docs.state")], docRows, { empty: t("docs.none") }));
    if ((a.packageBlocked || []).length) {
      docSec.appendChild(h("div", { class: "notice warn" }, h("strong", { text: t("docs.blocked") }), h("ul", { class: "compact" }, a.packageBlocked.map(function (b) {
        var doc = b && b.doc ? b.doc : {};
        return h("li", { text: tc("block", b && b.reason) + (doc.documentId ? " · #" + doc.documentId : "") + (doc.docType ? " · " + tc("docType", doc.docType) : "") });
      }))));
    }
    if ((a.packageNotes || []).length) docSec.appendChild(h("div", { class: "notice info" }, h("strong", { text: t("docs.notes") }), V.listOf(a.packageNotes.map(function (n) { return typeof n === "string" ? n : n && (n.note || n.code || n.reason) ? String(n.note || n.code || n.reason) : ""; }))));
    out.push(docSec);
    out.push(cvVersionsBlock(a, profile));

    if (a.coverLetter) out.push(h("section", { class: "card" }, h("h3", { text: t("drawer.coverLetter") }), h("div", { class: "untrusted", text: a.coverLetter })));

    // ---- submissions
    out.push(submissionsBlock(a, subs));

    // ---- replies + interviews
    var msgSec = h("section", { class: "card" }, h("h3", { text: t("drawer.replies") }));
    if (!messages.length) msgSec.appendChild(h("p", { class: "muted small", text: t("drawer.noReplies") }));
    messages.forEach(function (msg) {
      var b = h("button", { type: "button", class: "linklike", text: (msg.subject || t("msg.noSubject")) + " · " + V.fmtDateTime(msg.receivedAt) });
      b.addEventListener("click", function () { closeDrawer(); selectTab("review", false); openMessage(msg.id); });
      msgSec.appendChild(h("p", null, b, " ", msg.classification && msg.classification.category ? h("span", { class: "badge info", text: tc("category", msg.classification.category) }) : null));
    });
    out.push(msgSec);
    var ivSec = h("section", { class: "card" }, h("h3", { text: t("drawer.interviews") }));
    if (!interviews.length) ivSec.appendChild(h("p", { class: "muted small", text: t("interviews.none") }));
    interviews.forEach(function (iv) { ivSec.appendChild(h("div", { class: "notice info" }, h("p", null, h("strong", { text: iv.title || t("interviews.interview") }), " ", h("span", { class: "badge " + (iv.status === "confirmed" ? "ok" : iv.status === "cancelled" ? "neutral" : "warn"), text: tc("ivStatus", iv.status) })), V.interviewTimes(iv))); });
    out.push(ivSec);

    // ---- timeline
    var tl = h("ol", { class: "timeline" });
    (d.timeline || []).forEach(function (e) {
      var det = e.detail && typeof e.detail === "object" ? e.detail : {};
      var bits = [];
      if (det.from || det.to) bits.push(tc("status", det.from) + " → " + tc("status", det.to));
      if (det.reason) bits.push(String(det.reason));
      if (det.note) bits.push(String(det.note));
      if (det.code) bits.push(String(det.code));
      if (det.recipientSource) bits.push(t("recipient.source") + ": " + tc("rsrc", det.recipientSource));
      tl.appendChild(h("li", null, h("div", null, h("strong", { text: tc("event", e.event) }), " ", h("span", { class: "small muted", text: e.actor })), bits.length ? h("div", { class: "small", text: bits.join(" · ") }) : null, h("div", { class: "when", text: V.fmtDateTime(e.at) })));
    });
    out.push(h("section", { class: "card" }, h("h3", { text: t("drawer.timeline") }), (d.timeline || []).length ? tl : V.empty()));
    out.push(h("p", { class: "small muted", text: d.notice || t("match.notice") }));
    return out;
  }

  function recipientBlock(r) {
    if (!r || r.error) return h("section", { class: "notice warn" }, h("strong", { text: t("recipient.title") + ": " }), t("recipient.unavailable"));
    var box = h("section", { class: "notice " + (r.recipient ? (r.recipientSource === "posted_in_ad" ? "warn" : "info") : "bad"), attrs: { "aria-label": t("recipient.title") } },
      h("p", null, h("strong", { text: t("recipient.title") + ": " }), r.recipient ? h("span", { class: "ltr-island mono", text: r.recipient }) : t("recipient.none")),
      r.recipient ? h("p", { class: "small" }, t("recipient.source") + ": ", h("span", { class: "badge " + (r.verified ? "ok" : "neutral"), text: tc("rsrc", r.recipientSource) })) : null,
      r.recipientSource === "posted_in_ad" ? h("p", { class: "small", text: t("recipient.notVerified") }) : null,
      r.ambiguous ? h("p", { class: "small", text: t("recipient.ambiguous") }) : null,
      r.recipient && !r.domainMatchesEmployer && !r.verified ? h("p", { class: "small", text: t("recipient.domainMismatch") }) : null
    );
    return box;
  }

  function actionButton(label, enabled, reason, cls, onClick) {
    var id = "why-" + Math.random().toString(36).slice(2, 9);
    var b = h("button", { type: "button", class: "btn small " + (cls || ""), text: label, disabled: !enabled, attrs: reason && !enabled ? { "aria-describedby": id } : null });
    if (enabled) b.addEventListener("click", function () { onClick(b); });
    return h("div", { class: "field" }, b, reason && !enabled ? h("span", { class: "hint", id: id, text: reason }) : null);
  }

  function actionsBlock(d, recipient) {
    var a = d.application;
    var blocked = (a.packageBlocked || []).length > 0;
    var sec = h("section", { class: "card no-print" }, h("h3", { text: t("drawer.actions") }));
    var reason = h("textarea", { id: "action-reason", attrs: { rows: "2", maxlength: "500" } });
    var reasonField = h("div", { class: "field" }, h("label", { for: "action-reason", text: t("drawer.reason") }), reason, h("span", { class: "hint", text: t("drawer.reasonHint") }));
    var needReason = function () {
      var v = reason.value.trim();
      if (!v) {
        reason.setAttribute("aria-invalid", "true");
        reason.focus();
        V.toast(t("drawer.reasonRequired"), "bad");
        return null;
      }
      reason.removeAttribute("aria-invalid");
      return v;
    };
    var after = function (msg) {
      V.toast(msg, "ok");
      renderDrawer(a.id, true);
      refreshSoon();
    };
    var recipientText = recipient && recipient.recipient ? t("recipient.confirmLine", { to: recipient.recipient, source: tc("rsrc", recipient.recipientSource) }) + (recipient.recipientSource === "posted_in_ad" ? " " + t("recipient.notVerified") : "") : !recipient || recipient.error ? t("recipient.unavailable") : t("recipient.none");

    var row = h("div", { class: "btn-row" });
    var canPrep = can("write") && PREPARABLE.indexOf(a.status) >= 0;
    row.appendChild(actionButton(t("action.prepare"), canPrep, !can("write") ? t("why.noPermission") : t("why.status", { status: tc("status", a.status) }), "secondary", function (b) {
      V.busy(b, function () { return V.api("POST", "/jobsearch/applications/" + a.id + "/prepare", { body: {} }).then(function () { after(t("action.prepared")); }); }).catch(function () {});
    }));
    var approveWhy = !can("approve") ? t("why.approverOnly") : a.status !== "ready_for_review" ? t("why.status", { status: tc("status", a.status) }) : blocked ? t("why.blocked") : null;
    row.appendChild(actionButton(t("action.approve"), !approveWhy, approveWhy, "", function (b) {
      V.confirmDialog(t("action.approveConfirm") + " " + recipientText, t("action.approve")).then(function (ok) {
        if (!ok) return;
        V.busy(b, function () { return V.api("POST", "/jobsearch/applications/" + a.id + "/approve", { body: reason.value.trim() ? { reason: reason.value.trim() } : {} }).then(function () { after(t("action.approved")); }); }).catch(function () {});
      });
    }));
    var queueWhy = !can("approve") ? t("why.approverOnly") : a.status !== "approved" ? t("why.status", { status: tc("status", a.status) }) : null;
    row.appendChild(actionButton(t("action.queue"), !queueWhy, queueWhy, "", function (b) {
      V.confirmDialog(t("action.queueConfirm") + " " + recipientText, t("action.queue")).then(function (ok) {
        if (!ok) return;
        V.busy(b, function () {
          return V.api("POST", "/jobsearch/applications/" + a.id + "/queue", { body: {} }).then(function (r) {
            after(t("action.queued", { to: r.recipient || "—", source: tc("rsrc", r.recipientSource) }));
          });
        }).catch(function () {});
      });
    }));
    var rejectWhy = !can("approve") ? t("why.approverOnly") : a.status !== "ready_for_review" ? t("why.status", { status: tc("status", a.status) }) : null;
    row.appendChild(actionButton(t("action.reject"), !rejectWhy, rejectWhy, "danger", function (b) {
      var why = needReason();
      if (!why) return;
      V.busy(b, function () { return V.api("POST", "/jobsearch/applications/" + a.id + "/reject", { body: { reason: why } }).then(function () { after(t("action.rejected")); }); }).catch(function () {});
    }));
    var cancelWhy = !can("write") ? t("why.noPermission") : CANCELLABLE.indexOf(a.status) < 0 ? t("why.status", { status: tc("status", a.status) }) : null;
    row.appendChild(actionButton(t("action.cancel"), !cancelWhy, cancelWhy, "danger", function (b) {
      var why = needReason();
      if (!why) return;
      V.confirmDialog(t("action.cancelConfirm"), t("action.cancel"), true).then(function (ok) {
        if (!ok) return;
        V.busy(b, function () { return V.api("POST", "/jobsearch/applications/" + a.id + "/cancel", { body: { reason: why } }).then(function () { after(t("action.cancelled")); }); }).catch(function () {});
      });
    }));
    sec.appendChild(row);
    sec.appendChild(reasonField);
    if (blocked) sec.appendChild(h("p", { class: "notice warn small", text: t("why.blocked") }));

    if (a.status === "needs_staff" && can("approve")) sec.appendChild(manualCompletionForm(a, after));
    return sec;
  }

  /**
   * The candidate's CV versions. Staff with jobsearch:approve may approve a version on the candidate's
   * behalf ONLY with a recorded note (the server enforces >= 10 characters and audits it).
   */
  var CV_LANGS = ["en", "fr", "ar"];
  function cvVersionsBlock(a, profile) {
    var sec = h("section", { class: "card" }, h("h3", { text: t("cvAdmin.title") }));
    var files = profile && profile.cv_files ? profile.cv_files : [];
    if (!files.length) {
      sec.appendChild(h("p", { class: "muted small", text: t("cvAdmin.none") }));
      return sec;
    }
    sec.appendChild(h("p", { class: "small", text: t("cv.approveExplain") }));
    if (!can("approve")) sec.appendChild(h("p", { class: "small muted", text: t("cvAdmin.approverOnly") }));
    files.slice().reverse().forEach(function (f) {
      var box = h("div", { class: "notice " + (f.approved ? "ok" : "info") },
        h("p", null, h("strong", { text: t("upload.version", { n: V.fmtNumber(f.version) }) }), " · ", V.fmtDateTime(f.created_at), " · ",
          h("span", { class: "badge " + (f.scan_status === "clean" ? "ok" : f.scan_status === "infected" ? "bad" : "warn"), text: tc("scan", f.scan_status) }), " ",
          f.approved ? h("span", { class: "badge ok", text: t("cv.approvedIn", { lang: CV_LANGS.indexOf(f.language) >= 0 ? t("cv.lang." + f.language) : String(f.language || "—").toUpperCase() }) }) : h("span", { class: "badge neutral", text: t("cvAdmin.notApproved") })));
      if (f.scan_status === "scan_unavailable") box.appendChild(h("p", { class: "small", text: t("cv.unscannedNotice") }));
      if (!f.approved && f.scan_status !== "infected" && can("approve")) box.appendChild(cvApproveForm(a, f));
      sec.appendChild(box);
    });
    return sec;
  }
  function cvApproveForm(a, f) {
    var selId = "cva-lang-" + f.id;
    var otherId = "cva-other-" + f.id;
    var noteId = "cva-note-" + f.id;
    var sel = h("select", { id: selId }, CV_LANGS.map(function (l) { return option(l, t("cv.lang." + l)); }), option("other", t("cv.lang.other")));
    var other = h("input", { id: otherId, type: "text", attrs: { maxlength: "2", autocomplete: "off" } });
    var otherField = h("div", { class: "field" }, h("label", { for: otherId, text: t("cv.otherCode") }), other);
    otherField.hidden = true;
    sel.addEventListener("change", function () { otherField.hidden = sel.value !== "other"; });
    var note = h("textarea", { id: noteId, attrs: { rows: "2", maxlength: "500", required: true, "aria-describedby": noteId + "-hint" } });
    var b = h("button", { type: "submit", class: "btn small", text: t("cvAdmin.onBehalf") });
    var form = h("form", { attrs: { novalidate: true } },
      h("div", { class: "inline-fields" }, h("div", { class: "field" }, h("label", { for: selId, text: t("cv.language") }), sel), otherField),
      h("div", { class: "field" }, h("label", { for: noteId, text: t("cvAdmin.note") }), note, h("span", { class: "hint", id: noteId + "-hint", text: t("cvAdmin.noteHint") })),
      b);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var lang = sel.value;
      if (lang === "other") {
        lang = other.value.trim().toLowerCase();
        if (!/^[a-z]{2}$/.test(lang)) { other.setAttribute("aria-invalid", "true"); other.focus(); V.toast(t("cv.badCode"), "bad"); return; }
      }
      var n = note.value.trim();
      if (n.length < 10) { note.setAttribute("aria-invalid", "true"); note.focus(); V.toast(t("cvAdmin.noteTooShort"), "bad"); return; }
      note.removeAttribute("aria-invalid");
      V.confirmDialog(t("cvAdmin.confirm", { n: V.fmtNumber(f.version) }), t("cvAdmin.onBehalf")).then(function (ok) {
        if (!ok) return;
        V.busy(b, function () {
          return V.api("POST", "/jobsearch/cv-files/" + f.id + "/approve", { body: { language: lang, note: n } }).then(function () {
            V.toast(t("cvAdmin.approved"), "ok");
            renderDrawer(a.id, true);
          });
        }).catch(function () {});
      });
    });
    return form;
  }

  function manualCompletionForm(a, after) {
    var note = h("textarea", { id: "mc-note", attrs: { rows: "3", maxlength: "2000" } });
    var channel = h("input", { id: "mc-channel", type: "text", attrs: { maxlength: "40", placeholder: "portal" } });
    var to = h("input", { id: "mc-to", type: "email", attrs: { maxlength: "200" } });
    var b = h("button", { type: "submit", class: "btn small", text: t("manual.submit") });
    var form = h("form", { class: "notice info", attrs: { novalidate: true } },
      h("h4", { text: t("manual.title") }),
      h("p", { class: "small", text: t("manual.hint") }),
      h("div", { class: "field" }, h("label", { for: "mc-note", text: t("manual.note") }), note),
      h("div", { class: "inline-fields" },
        h("div", { class: "field" }, h("label", { for: "mc-channel", text: t("manual.channel") }), channel),
        h("div", { class: "field" }, h("label", { for: "mc-to", text: t("manual.recipient") }), to)),
      b);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!note.value.trim()) { note.setAttribute("aria-invalid", "true"); note.focus(); return; }
      var body = { note: note.value.trim() };
      if (channel.value.trim()) body.channel = channel.value.trim();
      if (to.value.trim()) body.recipient = to.value.trim();
      V.busy(b, function () { return V.api("POST", "/jobsearch/applications/" + a.id + "/manual-completion", { body: body }).then(function () { after(t("manual.done")); }); }).catch(function () {});
    });
    return form;
  }

  function submissionsBlock(a, subs) {
    var sec = h("section", { class: "card" }, h("h3", { text: t("drawer.submissions") }));
    if (!subs.length) {
      sec.appendChild(h("p", { class: "muted small", text: t("subs.none") }));
      return sec;
    }
    subs.forEach(function (s) {
      var label = s.status === "sent" ? t("subs.sentAwaiting") : tc("subStatus", s.status);
      var box = h("div", { class: "notice " + (s.status === "confirmed_submitted" ? "ok" : s.status === "failed" ? "bad" : "info") },
        h("p", null, h("strong", { text: t("subs.attempt", { n: V.fmtNumber(s.attempt) }) + ": " }), label),
        kv([
          [t("recipient.title"), s.recipient ? h("span", { class: "ltr-island mono", text: s.recipient }) : null],
          [t("subs.channel"), s.channel],
          [t("subs.sentAt"), s.sentAt ? V.fmtDateTime(s.sentAt) : null],
          [t("subs.confirmedAt"), s.confirmedAt ? V.fmtDateTime(s.confirmedAt) : null],
          [t("subs.evidence"), s.evidence && Array.isArray(s.evidence.confirmations) && s.evidence.confirmations.length ? s.evidence.confirmations.map(function (c) { return tc("evidence", c.kind) + " (" + V.fmtDateTime(c.at) + ")"; }).join(" · ") : t("subs.noEvidence")],
        ]));
      if ((s.status === "sent" || s.status === "outcome_unknown") && can("approve")) {
        var id = "ev-" + s.id;
        var note = h("textarea", { id: id, attrs: { rows: "2", maxlength: "2000" } });
        var b = h("button", { type: "submit", class: "btn small secondary", text: t("subs.recordManual") });
        var form = h("form", { attrs: { novalidate: true } }, h("div", { class: "field" }, h("label", { for: id, text: t("subs.manualNote") }), note, h("span", { class: "hint", text: t("subs.manualHint") })), b);
        form.addEventListener("submit", function (e) {
          e.preventDefault();
          if (note.value.trim().length < 10) { note.setAttribute("aria-invalid", "true"); note.focus(); V.toast(t("subs.noteTooShort"), "bad"); return; }
          V.busy(b, function () {
            return V.api("POST", "/jobsearch/submissions/" + s.id + "/evidence", { body: { kind: "manual_confirmation", detail: { note: note.value.trim() } } }).then(function () {
              V.toast(t("subs.confirmed"), "ok");
              renderDrawer(a.id, true);
            });
          }).catch(function () {});
        });
        box.appendChild(form);
      }
      sec.appendChild(box);
    });
    return sec;
  }

  // ================================================================ review queues
  function initReview() {
    $("#review-refresh").addEventListener("click", loadReview);
    $("#message-close").addEventListener("click", function () {
      S.messageId = null;
      $("#message-card").hidden = true;
      if (/^#\/messages\//.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
    });
  }

  function messageRow(m, extra) {
    var b = h("button", { type: "button", class: "linklike", text: (m.subject || t("msg.noSubject")) });
    b.addEventListener("click", function () { openMessage(m.id); });
    return h("li", { class: "notice info" },
      h("div", null, b),
      h("div", { class: "small muted" }, h("span", { class: "ltr-island", text: m.from || "—" }), " · ", V.fmtDateTime(m.receivedAt), m.applicationId ? " · #" + m.applicationId : ""),
      m.classification && m.classification.category ? h("span", { class: "badge info", text: tc("category", m.classification.category) }) : null,
      extra || null);
  }

  function loadReview() {
    var reviewer = can("approve");
    var unmatchedBox = $("#review-unmatched");
    if (!reviewer) V.setContent(unmatchedBox, h("p", { class: "muted small", text: t("review.reviewersOnly") }));
    else {
      V.setContent(unmatchedBox, V.loading());
      V.api("GET", "/jobsearch/messages?state=needs_review").then(function (r) {
        var unm = r.messages.filter(function (m) { return !m.applicationId; });
        V.setContent(unmatchedBox, unm.length ? h("ul", { class: "plain" }, unm.map(function (m) { return messageRow(m); })) : V.empty(t("review.noneUnmatched")));
      }).catch(function (err) { V.setContent(unmatchedBox, errorBox(err)); });
    }
    V.setContent($("#review-acks"), V.loading());
    V.setContent($("#review-matched"), V.loading());
    V.api("GET", "/jobsearch/messages?state=matched").then(function (r) {
      var acks = r.messages.filter(function (m) { return m.classification && m.classification.suggested_ack === true; });
      var rest = r.messages.filter(function (m) { return !(m.classification && m.classification.suggested_ack === true); });
      V.setContent($("#review-acks"), acks.length ? h("ul", { class: "plain" }, acks.map(function (m) { return messageRow(m, ackButton(m)); })) : V.empty(t("review.noneAcks")));
      V.setContent($("#review-matched"), rest.length ? h("ul", { class: "plain" }, rest.slice(0, 50).map(function (m) { return messageRow(m); })) : V.empty(t("review.noneMatched")));
    }).catch(function (err) {
      V.setContent($("#review-acks"), errorBox(err));
      V.setContent($("#review-matched"), errorBox(err));
    });
    var p = S.dash ? Promise.resolve(S.dash) : loadDashboard();
    p.then(function (d) {
      var tasks = (d && d.attention ? d.attention : []).filter(function (a) { return a.type === "task" || a.type === "application"; });
      if (!tasks.length) return V.setContent($("#review-tasks"), V.empty(t("review.noneTasks")));
      V.setContent($("#review-tasks"), h("ul", { class: "plain" }, tasks.map(function (a) {
        var b = h("button", { type: "button", class: "btn secondary small", text: t("common.open") });
        b.addEventListener("click", function () { openAttention(a); });
        return h("li", { class: "notice warn" }, h("strong", { text: tc("task", a.reason) }), h("div", { class: "small", text: (a.candidateId ? candidateName(a.candidateId) : t("dash.unassigned")) + (a.applicationId ? " · #" + a.applicationId : "") + " · " + t("dash.ageHours", { n: V.fmtNumber(a.ageHours) }) }), h("p", { class: "small muted", text: tc("taskHelp", a.reason) }), b);
      })));
    });
    if (S.messageId) openMessage(S.messageId, true);
  }

  function ackButton(m) {
    if (!can("approve")) return h("p", { class: "small muted", text: t("review.ackApproverOnly") });
    var b = h("button", { type: "button", class: "btn small", text: t("review.confirmAck") });
    b.addEventListener("click", function () {
      V.confirmDialog(t("review.confirmAckQuestion"), t("review.confirmAck")).then(function (ok) {
        if (!ok) return;
        V.busy(b, function () { return V.api("POST", "/jobsearch/messages/" + m.id + "/confirm-acknowledgement", { body: {} }).then(function () { V.toast(t("review.ackConfirmed"), "ok"); loadReview(); }); }).catch(function () {});
      });
    });
    return h("div", null, h("p", { class: "small", text: t("review.ackExplain") }), b);
  }

  function openMessage(id, quiet) {
    S.messageId = id;
    var card = $("#message-card");
    card.hidden = false;
    if (!quiet) V.setContent($("#message-body"), V.loading());
    V.api("GET", "/jobsearch/messages/" + id).then(function (m) {
      V.setContent($("#message-body"), messageView(m));
      if (!quiet) card.focus();
    }).catch(function (err) { V.setContent($("#message-body"), errorBox(err)); });
  }

  function messageView(m) {
    var out = [];
    var cls = m.classification || {};
    out.push(kv([
      [t("msg.from"), h("span", { class: "ltr-island", text: (m.fromName ? m.fromName + " " : "") + "<" + (m.from || "") + ">" })],
      [t("msg.subject"), m.subject],
      [t("msg.received"), V.fmtDateTime(m.receivedAt)],
      [t("msg.state"), tc("reviewState", m.reviewState)],
      [t("msg.application"), m.applicationId ? "#" + m.applicationId : t("msg.unassigned")],
      [t("msg.category"), cls.category ? tc("category", cls.category) : null],
      [t("msg.sharedLabel"), m.sharedWithCandidate ? t("common.yes") : t("common.no")],
      [t("msg.attachments"), (m.attachments || []).length ? (m.attachments || []).map(function (x) { return (x && (x.filename || x.name)) || "?"; }).join(", ") : null],
    ]));
    if (Array.isArray(cls.evidence) && cls.evidence.length) out.push(h("div", null, h("span", { class: "small muted", text: t("msg.evidence") }), cls.evidence.map(function (e) { return h("blockquote", { class: "evidence", text: (e.phrase || "") }); })));
    if (cls.instructionLike) out.push(h("p", { class: "notice warn small", text: t("msg.instructionLike") }));
    if (m.summary) out.push(h("p", null, h("strong", { text: t("msg.summary") + ": " }), m.summary));
    out.push(h("p", { class: "small muted", text: t("msg.untrusted") }));
    out.push(h("div", { class: "untrusted", attrs: { lang: "" }, text: m.body || "" }));

    var actions = h("div", { class: "no-print" });
    var after = function (msg) { V.toast(msg, "ok"); openMessage(m.id, true); loadReview(); };
    if (!m.applicationId && can("approve")) {
      var appIn = h("input", { id: "assign-app", type: "number", attrs: { min: "1", inputmode: "numeric", required: true } });
      var ab = h("button", { type: "submit", class: "btn small", text: t("msg.assign") });
      var af = h("form", { class: "notice info", attrs: { novalidate: true } }, h("div", { class: "field" }, h("label", { for: "assign-app", text: t("msg.assignTo") }), appIn, h("span", { class: "hint", text: t("msg.assignHint") })), ab);
      af.addEventListener("submit", function (e) {
        e.preventDefault();
        var v = Number(appIn.value);
        if (!v) { appIn.setAttribute("aria-invalid", "true"); appIn.focus(); return; }
        V.busy(ab, function () { return V.api("POST", "/jobsearch/messages/" + m.id + "/assign", { body: { applicationId: v } }).then(function () { after(t("msg.assigned")); }); }).catch(function () {});
      });
      actions.appendChild(af);
    }
    if (m.applicationId) {
      var row = h("div", { class: "btn-row" });
      var openApp = h("button", { type: "button", class: "btn secondary small", text: t("msg.openApplication") });
      openApp.addEventListener("click", function () { openDrawer(m.applicationId, openApp); });
      row.appendChild(openApp);
      if (!m.sharedWithCandidate && can("write")) {
        var share = h("button", { type: "button", class: "btn secondary small", text: t("msg.share") });
        share.addEventListener("click", function () {
          V.confirmDialog(t("msg.shareConfirm"), t("msg.share")).then(function (ok) {
            if (ok) V.busy(share, function () { return V.api("POST", "/jobsearch/messages/" + m.id + "/share-with-candidate", { body: {} }).then(function () { after(t("msg.shared")); }); }).catch(function () {});
          });
        });
        row.appendChild(share);
      }
      if (cls.suggested_ack === true) row.appendChild(ackButton(m));
      actions.appendChild(row);
      if (can("approve")) {
        var sel = h("select", { id: "cls-status" }, ["interview", "offer", "rejected"].map(function (s) { return option(s, tc("status", s)); }));
        var why = h("input", { id: "cls-reason", type: "text", attrs: { maxlength: "300" } });
        var cb = h("button", { type: "submit", class: "btn small secondary", text: t("msg.applyClassification") });
        var cf = h("form", { class: "inline-fields", attrs: { novalidate: true } }, h("div", { class: "field" }, h("label", { for: "cls-status", text: t("msg.setStatus") }), sel), h("div", { class: "field" }, h("label", { for: "cls-reason", text: t("drawer.reason") }), why), h("div", { class: "field" }, cb));
        cf.addEventListener("submit", function (e) {
          e.preventDefault();
          var body = { status: sel.value };
          if (why.value.trim()) body.reason = why.value.trim();
          V.busy(cb, function () { return V.api("POST", "/jobsearch/messages/" + m.id + "/apply-classification", { body: body }).then(function () { after(t("msg.statusApplied")); }); }).catch(function () {});
        });
        actions.appendChild(cf);
        actions.appendChild(interviewForm(m, after));
      }
      if (can("write")) actions.appendChild(draftsBlock(m, after));
    }
    out.push(actions);
    return out;
  }

  function tzSelect(id, current) {
    var sel = h("select", { id: id });
    V.timeZones().forEach(function (z) { sel.appendChild(option(z, z, z === current)); });
    return sel;
  }

  function interviewForm(m, after) {
    var when = h("input", { id: "iv-start", type: "datetime-local", attrs: { required: true } });
    var tz = tzSelect("iv-tz", V.userTz());
    var dur = h("input", { id: "iv-dur", type: "number", value: "60", attrs: { min: "15", max: "480", step: "15" } });
    var title = h("input", { id: "iv-title", type: "text", attrs: { maxlength: "200" } });
    var preview = h("p", { class: "small", attrs: { "aria-live": "polite" } });
    var b = h("button", { type: "submit", class: "btn small", text: t("iv.create") });
    var f = h("form", { class: "notice info", attrs: { novalidate: true } },
      h("h4", { text: t("iv.title") }),
      h("p", { class: "small", text: t("iv.hint") }),
      h("div", { class: "inline-fields" },
        h("div", { class: "field" }, h("label", { for: "iv-start", text: t("iv.start") }), when),
        h("div", { class: "field" }, h("label", { for: "iv-tz", text: t("iv.tz") }), tz),
        h("div", { class: "field" }, h("label", { for: "iv-dur", text: t("iv.duration") }), dur)),
      h("div", { class: "field" }, h("label", { for: "iv-title", text: t("iv.name") }), title),
      preview, b);
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!when.value) { when.setAttribute("aria-invalid", "true"); when.focus(); return; }
      var body = { proposedStart: when.value.length === 16 ? when.value + ":00" : when.value, tz: tz.value, durationMinutes: Number(dur.value) || 60 };
      if (title.value.trim()) body.title = title.value.trim();
      V.busy(b, function () {
        return V.api("POST", "/jobsearch/messages/" + m.id + "/interview", { body: body }).then(function (iv) {
          var appt = iv && (iv.appointment || iv);
          V.setContent(preview, appt && appt.startsAtUtc ? V.interviewTimes(appt) : t("iv.created"));
          after(t("iv.created"));
        });
      }).catch(function () {});
    });
    return f;
  }

  function draftsBlock(m, after) {
    var box = h("div", { class: "notice" }, h("h4", { text: t("drafts.title") }), h("p", { class: "small", text: t("drafts.hint") }));
    (m.drafts || []).forEach(function (d) {
      var dbox = h("div", { class: "card" },
        h("p", null, h("span", { class: "badge " + (d.status === "sent" ? "ok" : d.status === "draft" ? "warn" : "neutral"), text: tc("draftStatus", d.status) }), " ", h("span", { class: "small muted", text: V.fmtDateTime(d.createdAt) })),
        kv([[t("msg.to"), d.to ? h("span", { class: "ltr-island", text: d.to }) : null], [t("msg.subject"), d.subject]]),
        h("div", { class: "untrusted", text: d.body || "" }),
        d.error ? h("p", { class: "small notice warn", text: d.error }) : null);
      if (d.status === "draft" && can("approve")) {
        var send = h("button", { type: "button", class: "btn small", text: t("drafts.approveSend") });
        send.addEventListener("click", function () {
          V.confirmDialog(t("drafts.sendConfirm", { to: d.to || "—" }), t("drafts.approveSend")).then(function (ok) {
            if (!ok) return;
            V.busy(send, function () {
              return V.api("POST", "/jobsearch/drafts/" + d.id + "/send", { body: {} }).then(function (r) { after(r && r.sent ? t("drafts.sent") : t("drafts.notSent")); });
            }).catch(function () {});
          });
        });
        dbox.appendChild(send);
      }
      box.appendChild(dbox);
    });
    var lang = h("select", { id: "draft-lang" }, ["en", "fr", "ar"].map(function (l) { return option(l, tc("langName", l), l === V.getLang()); }));
    var mk = h("button", { type: "submit", class: "btn small secondary", text: t("drafts.create") });
    var f = h("form", { class: "inline-fields", attrs: { novalidate: true } }, h("div", { class: "field" }, h("label", { for: "draft-lang", text: t("drafts.lang") }), lang), h("div", { class: "field" }, mk));
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      V.busy(mk, function () { return V.api("POST", "/jobsearch/messages/" + m.id + "/draft", { body: { lang: lang.value } }).then(function () { after(t("drafts.created")); }); }).catch(function () {});
    });
    box.appendChild(f);
    return box;
  }

  // ================================================================ interviews
  function initInterviews() { $("#interviews-refresh").addEventListener("click", loadInterviews); }
  function loadInterviews() {
    var box = $("#interviews-list");
    V.setContent(box, V.loading());
    V.api("GET", "/jobsearch/interviews").then(function (r) {
      if (!r.interviews.length) return V.setContent(box, V.empty(t("interviews.none")));
      V.setContent(box, h("ul", { class: "plain" }, r.interviews.map(function (iv) {
        var li = h("li", { class: "card" },
          h("p", null, h("strong", { text: iv.title || t("interviews.interview") }), " ", h("span", { class: "badge " + (iv.status === "confirmed" ? "ok" : iv.status === "cancelled" ? "neutral" : "warn"), text: tc("ivStatus", iv.status) }), " ", h("span", { class: "small muted", text: candidateName(iv.candidateId) + " · #" + iv.applicationId })),
          V.interviewTimes(iv));
        var row = h("div", { class: "btn-row no-print" });
        var open = h("button", { type: "button", class: "btn secondary small", text: t("msg.openApplication") });
        open.addEventListener("click", function () { openDrawer(iv.applicationId, open); });
        row.appendChild(open);
        if (iv.status !== "cancelled" && can("approve")) {
          var cancel = h("button", { type: "button", class: "btn danger small", text: t("interviews.cancel") });
          cancel.addEventListener("click", function () {
            V.confirmDialog(t("interviews.cancelConfirm"), t("interviews.cancel"), true).then(function (ok) {
              if (ok) V.busy(cancel, function () { return V.api("POST", "/jobsearch/interviews/" + iv.id + "/cancel", { body: {} }).then(function () { V.toast(t("interviews.cancelled"), "ok"); loadInterviews(); }); }).catch(function () {});
            });
          });
          row.appendChild(cancel);
        }
        if (iv.status === "tentative") {
          var noteId = "ivn-" + iv.id;
          var note = h("input", { id: noteId, type: "text", attrs: { maxlength: "300" } });
          var rec = h("button", { type: "submit", class: "btn secondary small", text: t("interviews.recordAvailability") });
          var f = h("form", { class: "inline-fields", attrs: { novalidate: true } }, h("div", { class: "field" }, h("label", { for: noteId, text: t("interviews.availabilityNote") }), note), h("div", { class: "field" }, rec));
          f.addEventListener("submit", function (e) {
            e.preventDefault();
            if (!note.value.trim()) { note.setAttribute("aria-invalid", "true"); note.focus(); return; }
            V.busy(rec, function () { return V.api("POST", "/jobsearch/interviews/" + iv.id + "/availability", { body: { available: true, note: note.value.trim() } }).then(function () { V.toast(t("interviews.availabilityRecorded"), "ok"); loadInterviews(); }); }).catch(function () {});
          });
          li.appendChild(f);
        }
        li.appendChild(row);
        return li;
      })));
    }).catch(function (err) { V.setContent(box, errorBox(err)); });
  }

  // ================================================================ sources
  function initSources() { $("#sources-refresh").addEventListener("click", loadSources); }
  function loadSourcesData() {
    return V.api("GET", "/jobsearch/sources").then(function (list) {
      S.sources = list;
      return list;
    });
  }
  var SOURCE_CLASS = { connected: "ok", requires_setup: "warn", unavailable: "bad", manual: "info" };
  function loadSources() {
    var box = $("#sources-list");
    V.setContent(box, V.loading());
    loadSourcesData().then(function (list) {
      if (!list.length) return V.setContent(box, V.empty());
      V.setContent(box, h("div", { class: "grid two" }, list.map(function (s) {
        var lr = s.last_run;
        var card = h("div", { class: "card" },
          h("div", { class: "card-head" }, h("h3", { text: s.name || s.key }), h("span", { class: "spacer" }),
            h("span", { class: "badge " + (SOURCE_CLASS[s.status] || "neutral"), text: tc("srcStatus", s.status) }),
            s.paused ? h("span", { class: "badge bad", text: t("sources.paused") }) : null,
            s.key === "test_fixture" ? h("span", { class: "badge demo", text: t("common.demo") }) : null),
          s.status === "requires_setup" ? h("div", { class: "notice warn small" }, h("p", { text: t("sources.requiresSetup") }), (s.requires || []).length ? h("p", null, t("sources.missingEnv") + " ", (s.requires || []).map(function (r, i) { return [i ? ", " : "", h("code", { class: "ltr-island", text: r })]; })) : null) : null,
          kv([
            [t("sources.key"), h("code", { class: "ltr-island", text: s.key })],
            [t("sources.detail"), s.detail],
            [t("sources.rateLimit"), s.rateLimitPerMin !== undefined ? t("sources.perMin", { n: V.fmtNumber(s.rateLimitPerMin) }) : null],
            [t("sources.terms"), s.termsUrl ? V.safeLink(s.termsUrl) : null],
            [t("sources.lastRunAt"), s.last_run_at ? V.fmtDateTime(s.last_run_at) : t("sources.never")],
            [t("sources.lastRun"), lr ? tc("runStatus", lr.status) + " · " + t("sources.found", { found: V.fmtNumber(lr.found), fresh: V.fmtNumber(lr.new_count) }) : null],
            [t("sources.lastError"), s.last_error || (lr && lr.error) || null],
          ]));
        if (isAdmin()) {
          var row = h("div", { class: "btn-row no-print" });
          var pb = h("button", { type: "button", class: "btn secondary small", text: s.paused ? t("sources.resume") : t("sources.pause") });
          pb.addEventListener("click", function () {
            V.busy(pb, function () { return V.api("POST", "/jobsearch/sources/" + encodeURIComponent(s.key) + (s.paused ? "/resume" : "/pause"), { body: {} }).then(function () { V.toast(s.paused ? t("sources.resumed") : t("sources.pausedDone"), "ok"); loadSources(); }); }).catch(function () {});
          });
          row.appendChild(pb);
          var run = h("button", { type: "button", class: "btn small", text: t("search.nowSource"), disabled: s.status !== "connected" || s.paused });
          run.addEventListener("click", function () {
            V.busy(run, function () { return V.api("POST", "/jobsearch/search/run", { body: { sourceKey: s.key } }).then(function (r) { V.toast(t("search.queued", { id: r.queueId }), "ok"); }); }).catch(function () {});
          });
          row.appendChild(run);
          card.appendChild(row);
        }
        return card;
      })));
    }).catch(function (err) { V.setContent(box, errorBox(err)); });
  }

  // ================================================================ settings + consent
  function initSettings() {
    $("#settings-candidate").addEventListener("change", function () {
      var v = $("#settings-candidate").value;
      S.settingsCandidate = v ? Number(v) : null;
      loadSettings();
    });
  }
  function loadSettings() {
    if (!S.dash) return loadDashboard().then(function () { if (S.dash) loadSettings(); });
    fillCandidateSelects();
    var id = S.settingsCandidate;
    if (!id) {
      V.setContent($("#settings-consent"), V.empty(t("settings.pickFirst")));
      V.setContent($("#settings-form-box"), V.empty(t("settings.pickFirst")));
      return;
    }
    V.setContent($("#settings-consent"), V.loading());
    V.setContent($("#settings-form-box"), V.loading());
    Promise.all([
      V.api("GET", "/jobsearch/candidates/" + id + "/consent"),
      V.api("GET", "/jobsearch/candidates/" + id + "/settings"),
      V.api("GET", "/jobsearch/candidates/" + id + "/eligibility"),
    ]).then(function (r) {
      V.setContent($("#settings-consent"), consentView(r[0], r[2]));
      V.setContent($("#settings-form-box"), settingsForm(id, r[1]));
    }).catch(function (err) {
      V.setContent($("#settings-consent"), errorBox(err));
      V.setContent($("#settings-form-box"), errorBox(err));
    });
  }
  function consentView(c, elig) {
    var out = [];
    out.push(h("p", null, h("strong", { text: t("settings.eligibility") + ": " }), h("span", { class: "badge " + (elig.eligible ? "ok" : "warn"), text: elig.eligible ? t("settings.eligible") : t("settings.notEligible") })));
    if (!elig.eligible) out.push(V.listOf(elig.reasons.map(function (r) { return tc("elig", r); })));
    if (!c.active) out.push(h("p", { class: "notice warn", text: t("consent.none") }));
    else {
      var sc = c.active.scope || {};
      out.push(kv([
        [t("consent.version"), c.active.version],
        [t("consent.grantedAt"), V.fmtDateTime(c.active.granted_at)],
        [t("consent.search"), sc.search ? t("common.yes") : t("common.no")],
        [t("consent.prepare"), sc.prepare ? t("common.yes") : t("common.no")],
        [t("consent.submit"), sc.submit ? t("common.yes") : t("common.no")],
        [t("consent.countries"), (sc.countries || []).join(", ")],
        [t("consent.recorded"), sc.evidence ? t("consent.writtenBy", { who: sc.evidence.recorded_by }) : t("consent.byCandidate")],
      ]));
    }
    if (c.history && c.history.length) {
      out.push(h("h3", { text: t("consent.history") }));
      out.push(h("ul", { class: "compact" }, c.history.map(function (x) {
        return h("li", { text: x.version + " · " + V.fmtDateTime(x.granted_at) + (x.withdrawn_at ? " → " + t("consent.closedAt", { at: V.fmtDateTime(x.withdrawn_at) }) : "") });
      })));
    }
    return out;
  }
  function settingsForm(id, st) {
    var admin = isAdmin();
    var mode = h("select", { id: "s-mode" }, ["search_only", "prepare_for_approval", "automatic"].map(function (m) {
      return h("option", { value: m, text: tc("mode", m) + (m === "automatic" && !admin ? " — " + t("settings.adminOnly") : ""), selected: st.mode === m, disabled: m === "automatic" && !admin });
    }));
    mode.disabled = !can("approve");
    var paused = h("input", { id: "s-paused", type: "checkbox", checked: st.paused });
    var capDay = h("input", { id: "s-cap-day", type: "number", value: String(st.cap_per_day || 0), attrs: { min: "0", max: "1000" }, disabled: !admin });
    var capWeek = h("input", { id: "s-cap-week", type: "number", value: String(st.cap_per_week || 0), attrs: { min: "0", max: "1000" }, disabled: !admin });
    var list = function (idv, arr) { return h("textarea", { id: idv, attrs: { rows: "2" }, value: (arr || []).join(", "), disabled: !admin }); };
    var countries = list("s-countries", st.allowed_countries);
    var professions = list("s-professions", st.allowed_professions);
    var sources = list("s-sources", st.allowed_sources);
    var salary = h("input", { id: "s-salary", type: "number", value: st.salary_limit === null || st.salary_limit === undefined ? "" : String(st.salary_limit), attrs: { min: "0" }, disabled: !admin });
    var capWarn = h("p", { class: "notice warn small", attrs: { "aria-live": "polite" } });
    var syncWarn = function () {
      var zero = Number(capDay.value) === 0 || Number(capWeek.value) === 0;
      capWarn.hidden = !(mode.value === "automatic" && zero);
      capWarn.textContent = t("settings.capZeroAuto");
    };
    [mode, capDay, capWeek].forEach(function (el) { el.addEventListener("change", syncWarn); el.addEventListener("input", syncWarn); });
    syncWarn();
    var save = h("button", { type: "submit", class: "btn", text: t("common.save") });
    var f = h("form", { attrs: { novalidate: true } },
      h("div", { class: "field" }, h("label", { for: "s-mode", text: t("settings.mode") }), mode, h("span", { class: "hint", text: t("settings.modeHint") })),
      h("div", { class: "check" }, paused, h("label", { for: "s-paused", text: t("settings.paused") })),
      h("fieldset", null, h("legend", { text: t("settings.caps") }),
        h("div", { class: "inline-fields" },
          h("div", { class: "field" }, h("label", { for: "s-cap-day", text: t("settings.capDay") }), capDay),
          h("div", { class: "field" }, h("label", { for: "s-cap-week", text: t("settings.capWeek") }), capWeek)),
        h("span", { class: "hint", text: t("settings.capHint") })),
      capWarn,
      h("div", { class: "field" }, h("label", { for: "s-countries", text: t("settings.allowedCountries") }), countries, h("span", { class: "hint", text: t("settings.listHint") })),
      h("div", { class: "field" }, h("label", { for: "s-professions", text: t("settings.allowedProfessions") }), professions),
      h("div", { class: "field" }, h("label", { for: "s-sources", text: t("settings.allowedSources") }), sources),
      h("div", { class: "field" }, h("label", { for: "s-salary", text: t("settings.salaryLimit") }), salary),
      !admin ? h("p", { class: "small muted", text: t("settings.adminFieldsNote") }) : null,
      st.admin_approved_by ? h("p", { class: "small", text: t("settings.approvedBy", { id: st.admin_approved_by }) }) : null,
      save);
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var patch = {};
      if (paused.checked !== Boolean(st.paused)) patch.paused = paused.checked;
      if (can("approve") && mode.value !== st.mode) patch.mode = mode.value;
      if (admin) {
        var splitList = function (el) { return el.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean); };
        patch.cap_per_day = Number(capDay.value) || 0;
        patch.cap_per_week = Number(capWeek.value) || 0;
        patch.allowed_countries = splitList(countries);
        patch.allowed_professions = splitList(professions);
        patch.allowed_sources = splitList(sources);
        patch.salary_limit = salary.value === "" ? null : Number(salary.value);
      }
      if (!Object.keys(patch).length) return V.toast(t("settings.noChanges"));
      var go = function () {
        V.busy(save, function () { return V.api("PUT", "/jobsearch/candidates/" + id + "/settings", { body: patch }).then(function () { V.toast(t("settings.saved"), "ok"); loadSettings(); }); }).catch(function () {});
      };
      if (patch.mode === "automatic") V.confirmDialog(t("settings.autoConfirm"), t("common.save"), true).then(function (ok) { if (ok) go(); });
      else go();
    });
    return f;
  }

  // ================================================================ reports + export
  function initReports() {
    fillSelect($("#r-group"), GROUPS.map(function (g) { return [g, tc("group", g)]; }), "candidate");
    fillSelect($("#r-period"), PERIODS.map(function (p) { return [p, tc("period", p)]; }), "week");
    fillSelect($("#x-type"), EXPORT_TYPES.map(function (x) { return [x, tc("exportType", x)]; }), "applications");
    $("#report-form").addEventListener("submit", function (e) { e.preventDefault(); runReport(); });
    $("#export-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = e.submitter || $("#export-form button");
      var q = { type: $("#x-type").value, from: $("#r-from").value, to: $("#r-to").value };
      V.setContent($("#export-status"), V.loading(t("export.preparing")));
      V.busy(btn, function () {
        return V.download("/jobsearch/export.csv" + qs(q), "vita-" + q.type + ".csv").then(function (r) {
          var msg = t("export.done", { name: r.name, rows: V.fmtNumber(r.rows) }) + (r.truncated ? " " + t("export.truncated") : "");
          V.setContent($("#export-status"), msg);
          V.announce(msg);
        });
      }).catch(function (err) { V.setContent($("#export-status"), errorBox(err)); });
    });
  }
  function runReport() {
    var q = { from: $("#r-from").value, to: $("#r-to").value, groupBy: $("#r-group").value, period: $("#r-period").value };
    var box = $("#report-out");
    V.setContent(box, V.loading());
    V.api("GET", "/jobsearch/reports" + qs(q)).then(function (r) {
      var metrics = r.metrics || METRICS;
      var rows = r.rows.map(function (row) {
        return h("tr", null, h("th", { scope: "row", text: row.label ? row.label + " (" + row.key + ")" : r.groupBy === "status" ? tc("status", row.key) : row.key }), metrics.map(function (m) { return h("td", { class: "num", text: V.fmtNumber(row[m]) }); }));
      });
      rows.push(h("tr", null, h("th", { scope: "row", text: t("reports.total") }), metrics.map(function (m) { return h("td", { class: "num" }, h("strong", { text: V.fmtNumber(r.totals[m]) })); })));
      V.setContent(box,
        h("p", { class: "small muted", text: t("reports.range", { from: V.fmtDateTime(r.from, "UTC"), to: V.fmtDateTime(r.to, "UTC"), scope: tc("scope", r.scope) }) }),
        r.rows.length ? table([tc("group", r.groupBy)].concat(metrics.map(function (m) { return { label: tc("metric", m), num: true }; })), rows, { caption: t("reports.title") }) : V.empty(t("reports.none")));
    }).catch(function (err) { V.setContent(box, errorBox(err)); });
  }

  // ================================================================ health + scheduler
  function initHealth() { $("#health-refresh").addEventListener("click", loadHealth); }
  function loadHealth() {
    var box = $("#health-out");
    if (!canSeeHealth()) return V.setContent(box, V.empty(t("health.roleOnly")));
    V.setContent(box, V.loading());
    V.api("GET", "/jobsearch/health").then(function (hl) {
      V.setContent(box,
        h("div", { class: "stats" },
          stat(hl.stuck.count, t("health.stuck"), hl.stuck.count ? "bad" : ""),
          stat(hl.outcomeUnknown, t("health.outcomeUnknown"), hl.outcomeUnknown ? "bad" : ""),
          stat(hl.tasksAwaitingHuman.reduce(function (n, x) { return n + x.count; }, 0), t("health.tasks"), "gold"),
          stat(hl.queue.filter(function (q) { return q.status === "pending"; }).reduce(function (n, x) { return n + x.count; }, 0), t("health.pending"))),
        kv([
          [t("health.generated"), V.fmtDateTime(hl.generatedAt)],
          [t("health.module"), h("span", { class: "badge " + (hl.modulePaused ? "bad" : "ok"), text: hl.modulePaused ? t("module.paused") : t("module.running") })],
          [t("health.lastTick"), hl.scheduler.lastTickAt ? V.fmtDateTime(hl.scheduler.lastTickAt) + (hl.scheduler.errors ? " · " + t("health.tickErrors", { n: V.fmtNumber(hl.scheduler.errors) }) : "") : t("sources.never")],
          [t("health.mail"), tc("srcStatus", hl.mail.status) + (hl.mail.realSend ? " · " + t("health.realSend") : " · " + t("health.sandbox"))],
          [t("health.scan"), tc("scan", hl.storage.malwareScan)],
          [t("health.unscanned"), hl.storage.unscannedAttachments === "allowed" ? t("health.unscannedAllowed") : t("health.unscannedBlocked")],
        ]),
        h("h3", { text: t("health.sources") }),
        table([t("sources.key"), t("filter.status"), t("sources.lastRunAt"), t("sources.lastRun"), t("sources.lastError")], hl.sources.map(function (s) {
          return h("tr", null, h("td", null, h("code", { text: s.key })), h("td", null, h("span", { class: "badge " + (SOURCE_CLASS[s.status] || "neutral"), text: tc("srcStatus", s.status) }), s.paused ? h("span", { class: "badge bad", text: t("sources.paused") }) : null), h("td", { text: s.lastRunAt ? V.fmtDateTime(s.lastRunAt) : t("sources.never") }), h("td", { text: s.lastRun ? tc("runStatus", s.lastRun.status) : "—" }), h("td", { text: s.lastError || (s.lastRun && s.lastRun.message) || "—" }));
        })),
        h("h3", { text: t("health.queue") }),
        table([t("health.kind"), t("filter.status"), { label: t("health.count"), num: true }], hl.queue.map(function (q) { return h("tr", null, h("td", { text: q.kind }), h("td", { text: q.status }), h("td", { class: "num", text: V.fmtNumber(q.count) })); })),
        h("h3", { text: t("health.tasks") }),
        table([t("dash.reason"), { label: t("health.count"), num: true }], hl.tasksAwaitingHuman.map(function (x) { return h("tr", null, h("td", { text: tc("task", x.reason) }), h("td", { class: "num", text: V.fmtNumber(x.count) })); })));
    }).catch(function (err) { V.setContent(box, errorBox(err)); });
  }

  // ================================================================ employers & rules (Task 18)
  function canEditEmployers() { return isAdmin() || role() === "Manager"; }
  function splitList(v) { return v.split(",").map(function (x) { return x.trim(); }).filter(Boolean); }
  function field(id, labelKey, input, hintKey) {
    return h("div", { class: "field" }, h("label", { for: id, text: t(labelKey) }), input, hintKey ? h("span", { class: "hint", text: t(hintKey) }) : null);
  }
  function initDirectory() {
    $("#directory-refresh").addEventListener("click", function () {
      // explicit refresh: rebuild the forms too (e.g. a candidate list loaded since)
      dirForms = { manual: false, confirm: false, rules: false };
      ["#manual-box", "#confirm-box", "#rules-box", "#emp-list"].forEach(function (sel) { V.clear($(sel)); });
      loadDirectory();
    });
    $("#emp-search").addEventListener("submit", function (e) { e.preventDefault(); loadEmployers(); });
  }
  /** Called on tab open AND on every live refresh: forms are built once (typing is never wiped), lists are reloaded. */
  var dirForms = { manual: false, confirm: false, rules: false };
  function loadDirectory() {
    if (!$("#emp-list form")) loadEmployers(); // never wipe an open edit form
    if (!dirForms.manual) { dirForms.manual = true; renderManualImport(); }
    $("#confirm-card").hidden = !isAdmin();
    $("#rules-card").hidden = !isAdmin();
    if (isAdmin()) { loadConfirmations(); loadRules(); }
  }

  function loadEmployers() {
    var box = $("#emp-list");
    V.setContent(box, V.loading());
    var q = $("#emp-q").value.trim();
    V.api("GET", "/jobsearch/employers" + qs({ q: q, pageSize: 100 })).then(function (r) {
      var rows = r.employers.map(function (e) {
        var cells = [
          h("td", { text: e.name }),
          h("td", null, e.domain ? h("span", { class: "ltr-island", text: e.domainUnicode && e.domainUnicode !== e.domain ? e.domainUnicode + " (" + e.domain + ")" : e.domain }) : h("span", { class: "muted", text: "—" })),
          h("td", null, e.verifiedContactEmail ? h("span", { class: "ltr-island mono", text: e.verifiedContactEmail }) : h("span", { class: "muted", text: "—" })),
          h("td", { class: "num", text: V.fmtNumber(e.jobs || 0) }),
          h("td", { class: "num", text: V.fmtNumber(e.applications || 0) }),
        ];
        var actions = h("td");
        if (canEditEmployers()) {
          var b = h("button", { type: "button", class: "btn secondary small", text: t("dir.edit"), attrs: { "aria-label": t("dir.editNamed", { name: e.name }) } });
          b.addEventListener("click", function () { V.setContent(actions, employerForm(e)); });
          actions.appendChild(b);
        }
        cells.push(actions);
        return h("tr", null, cells);
      });
      V.setContent(box, h("p", { class: "small muted", text: t("dir.count", { n: V.fmtNumber(r.total) }) }),
        table([t("dir.name"), t("dir.domain"), t("dir.contact"), { label: t("dir.jobs"), num: true }, { label: t("dir.applications"), num: true }, t("dir.actions")], rows, { empty: t("dir.none") }));
    }).catch(function (err) { V.setContent(box, errorBox(err)); });
  }

  function employerForm(e) {
    var p = "emp-" + e.id + "-";
    var name = h("input", { id: p + "name", type: "text", value: e.name, attrs: { maxlength: "200" } });
    var domain = h("input", { id: p + "domain", type: "text", value: e.domain || "", attrs: { maxlength: "255", autocomplete: "off", placeholder: "employer.com" } });
    var contact = h("input", { id: p + "contact", type: "email", value: e.verifiedContactEmail || "", attrs: { maxlength: "254", autocomplete: "off" } });
    var save = h("button", { type: "submit", class: "btn small", text: t("common.save") });
    var form = h("form", { class: "notice info", attrs: { novalidate: true } },
      field(p + "name", "dir.name", name),
      field(p + "domain", "dir.domain", domain, "dir.domainHint"),
      field(p + "contact", "dir.contact", contact, "dir.contactHint"),
      save);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var patch = {};
      if (name.value.trim() !== e.name) patch.name = name.value.trim();
      if (domain.value.trim() !== (e.domain || "")) patch.domain = domain.value.trim();
      if (contact.value.trim() !== (e.verifiedContactEmail || "")) patch.verifiedContactEmail = contact.value.trim();
      if (!Object.keys(patch).length) { V.toast(t("dir.noChange"), "bad"); return; }
      V.confirmDialog(t("dir.saveConfirm", { name: e.name }), t("common.save")).then(function (ok) {
        if (!ok) return;
        V.busy(save, function () {
          return V.api("PUT", "/jobsearch/employers/" + e.id, { body: patch }).then(function () {
            V.toast(t("dir.saved"), "ok");
            loadEmployers();
          });
        }).catch(function () {});
      });
    });
    return form;
  }

  function renderManualImport() {
    var box = $("#manual-box");
    if (!can("write")) return V.setContent(box, V.empty(t("why.noPermission")));
    var f = {
      title: h("input", { id: "mi-title", type: "text", attrs: { maxlength: "200", required: true } }),
      employerName: h("input", { id: "mi-employer", type: "text", attrs: { maxlength: "200", required: true } }),
      location: h("input", { id: "mi-location", type: "text", attrs: { maxlength: "200" } }),
      country: h("input", { id: "mi-country", type: "text", attrs: { maxlength: "100", list: "country-list" } }),
      url: h("input", { id: "mi-url", type: "url", attrs: { maxlength: "2000"} }),
      description: h("textarea", { id: "mi-description", attrs: { rows: "6", maxlength: "20000" } }),
      closingAt: h("input", { id: "mi-closing", type: "date" }),
    };
    var out = h("div", { attrs: { "aria-live": "polite" } });
    var b = h("button", { type: "submit", class: "btn", text: t("manual.importSubmit") });
    var form = h("form", { attrs: { novalidate: true } },
      h("div", { class: "inline-fields" }, field("mi-title", "manual.jobTitle", f.title), field("mi-employer", "filter.employer", f.employerName)),
      h("div", { class: "inline-fields" }, field("mi-location", "drawer.location", f.location), field("mi-country", "filter.country", f.country), field("mi-closing", "drawer.closing", f.closingAt)),
      field("mi-url", "manual.url", f.url, "manual.urlHint"),
      field("mi-description", "manual.description", f.description, "manual.descriptionHint"),
      b, out);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      V.$all("[aria-invalid]", form).forEach(function (x) { x.removeAttribute("aria-invalid"); });
      var bad = function (el, key) { el.setAttribute("aria-invalid", "true"); el.focus(); V.toast(t(key), "bad"); };
      if (!f.title.value.trim()) return bad(f.title, "manual.titleRequired");
      if (!f.employerName.value.trim()) return bad(f.employerName, "manual.employerRequired");
      var u = f.url.value.trim();
      if (u && !/^https:\/\/[^\s\/?#]+\.[^\s\/?#]+(?:[\/?#]\S*)?$/i.test(u)) return bad(f.url, "manual.httpsOnly");
      var bodyOut = { title: f.title.value.trim(), employerName: f.employerName.value.trim() };
      ["location", "country", "description"].forEach(function (k) { if (f[k].value.trim()) bodyOut[k] = f[k].value.trim(); });
      if (u) bodyOut.url = u;
      if (f.closingAt.value) bodyOut.closingAt = f.closingAt.value + "T23:59:59Z";
      V.busy(b, function () {
        return V.api("POST", "/jobsearch/jobs/manual", { body: bodyOut }).then(function (r) {
          var msg = r.created ? t("manual.importCreated", { id: r.job.id }) : t("manual.importExisting", { id: r.job.id });
          V.setContent(out, h("p", { class: "notice ok small", text: msg }));
          V.announce(msg);
          form.reset();
        });
      }).catch(function (err) { V.setContent(out, errorBox(err)); });
    });
    V.setContent(box, form);
  }

  function loadConfirmations(rebuildForm) {
    var box = $("#confirm-box");
    if (!box.firstChild) V.setContent(box, h("div", { id: "confirm-form-box" }), h("div", { id: "confirm-list-box" }, V.loading()));
    if (rebuildForm || !dirForms.confirm) {
      dirForms.confirm = true;
      V.api("GET", "/jobsearch/applications" + qs({ pageSize: 100 })).then(function (r) {
        V.setContent($("#confirm-form-box"), confirmationForm(r.applications));
      }).catch(function (err) { dirForms.confirm = false; V.setContent($("#confirm-form-box"), errorBox(err)); });
    }
    V.api("GET", "/jobsearch/employer-confirmations").then(function (r) {
      V.setContent($("#confirm-list-box"), confirmationList(r.confirmations));
    }).catch(function (err) { V.setContent($("#confirm-list-box"), errorBox(err)); });
  }

  function confirmationForm(apps) {
    var sel = h("select", { id: "cf-app" }, option("", t("common.choose")), apps.map(function (a) {
      return option(String(a.id), "#" + a.id + " · " + (a.job && a.job.title ? a.job.title : "") + " · " + (a.employer && a.employer.name ? a.employer.name : t("common.none")) + " · " + (a.candidateName || ""));
    }));
    var scopeJob = h("input", { id: "cf-scope-job", type: "radio", name: "cf-scope", value: "job", checked: true });
    var scopeEmp = h("input", { id: "cf-scope-emp", type: "radio", name: "cf-scope", value: "employer" });
    var note = h("textarea", { id: "cf-note", attrs: { rows: "3", maxlength: "2000", required: true } });
    var b = h("button", { type: "submit", class: "btn", text: t("conf.submit") });
    var form = h("form", { class: "notice info", attrs: { novalidate: true } },
      h("p", { class: "small", text: t("conf.hint") }),
      field("cf-app", "conf.application", sel),
      h("fieldset", null, h("legend", { text: t("conf.scope") }),
        h("div", { class: "check" }, scopeJob, h("label", { for: "cf-scope-job" }, h("strong", { text: t("conf.scopeJob") }), h("span", { class: "hint", text: t("conf.scopeJobHint") }))),
        h("div", { class: "check" }, scopeEmp, h("label", { for: "cf-scope-emp" }, h("strong", { text: t("conf.scopeEmployer") }), h("span", { class: "hint", text: t("conf.scopeEmployerHint") })))),
      field("cf-note", "conf.note", note, "conf.noteHint"),
      b);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var app = apps.find(function (a) { return String(a.id) === sel.value; });
      if (!app) { sel.setAttribute("aria-invalid", "true"); sel.focus(); V.toast(t("conf.pickApplication"), "bad"); return; }
      sel.removeAttribute("aria-invalid");
      var n = note.value.trim();
      if (n.length < 10) { note.setAttribute("aria-invalid", "true"); note.focus(); V.toast(t("conf.noteTooShort"), "bad"); return; }
      note.removeAttribute("aria-invalid");
      var wide = scopeEmp.checked;
      if (wide && !(app.employer && app.employer.id)) { V.toast(t("conf.noEmployer"), "bad"); return; }
      var payload = wide ? { employerId: app.employer.id, evidenceNote: n } : { applicationId: app.id, evidenceNote: n };
      V.confirmDialog(wide ? t("conf.confirmEmployer", { name: app.employer.name || "#" + app.employer.id }) : t("conf.confirmJob", { id: app.id }), t("conf.submit")).then(function (ok) {
        if (!ok) return;
        V.busy(b, function () {
          return V.api("POST", "/jobsearch/employer-confirmations", { body: payload }).then(function () {
            V.toast(t("conf.recorded"), "ok");
            loadConfirmations(true);
          });
        }).catch(function () {});
      });
    });
    return form;
  }

  function confirmationList(items) {
    var rows = items.map(function (k) {
      var cell = h("td");
      if (!k.revoked) {
        var rv = h("button", { type: "button", class: "btn danger small", text: t("conf.revoke") });
        rv.addEventListener("click", function () {
          V.confirmDialog(t("conf.revokeConfirm"), t("conf.revoke"), true).then(function (ok) {
            if (!ok) return;
            V.busy(rv, function () { return V.api("DELETE", "/jobsearch/employer-confirmations/" + k.id).then(function () { V.toast(t("conf.revoked"), "ok"); loadConfirmations(); }); }).catch(function () {});
          });
        });
        cell.appendChild(rv);
      } else cell.appendChild(h("span", { class: "badge neutral", text: t("conf.revokedBadge") }));
      return h("tr", null,
        h("td", { text: "#" + k.id }),
        h("td", { text: k.scope === "job" ? t("conf.scopeJob") + (k.jobTitle ? " · " + k.jobTitle : "") : t("conf.scopeEmployer") }),
        h("td", { text: k.employerName || (k.employerId ? "#" + k.employerId : "—") }),
        h("td", null, h("div", { class: "untrusted small", text: k.evidence || "" })),
        h("td", { text: V.fmtDateTime(k.createdAt) }),
        cell);
    });
    return h("div", null, h("h3", { text: t("conf.listTitle") }), table(["#", t("conf.scope"), t("filter.employer"), t("conf.note"), t("conf.at"), t("dir.actions")], rows, { empty: t("conf.none") }));
  }

  var RULE_TYPES = ["auto_submit", "ack_reply"];
  function loadRules(rebuildForm) {
    var box = $("#rules-box");
    if (!box.firstChild) V.setContent(box, h("div", { id: "rules-form-box" }), h("div", { id: "rules-list-box" }, V.loading()));
    if (rebuildForm || !dirForms.rules) {
      dirForms.rules = true;
      V.setContent($("#rules-form-box"), rulesForm());
    }
    V.api("GET", "/jobsearch/automation-rules").then(function (r) {
      V.setContent($("#rules-list-box"), rulesList(r.rules));
    }).catch(function (err) { V.setContent($("#rules-list-box"), errorBox(err)); });
  }

  function rulesForm() {
    var cands = (S.dash ? S.dash.candidates : []).map(function (c) { return [String(c.candidateId), c.name + " (#" + c.candidateId + ")"]; });
    var cand = h("select", { id: "ru-cand" }, option("", t("common.choose")), cands.map(function (c) { return option(c[0], c[1]); }));
    var type = h("select", { id: "ru-type" }, RULE_TYPES.map(function (x) { return option(x, tc("ruleType", x)); }));
    var countries = h("input", { id: "ru-countries", type: "text", attrs: { maxlength: "1000" } });
    var professions = h("input", { id: "ru-professions", type: "text", attrs: { maxlength: "1000" } });
    var sources = h("input", { id: "ru-sources", type: "text", attrs: { maxlength: "500" } });
    var employers = h("input", { id: "ru-employers", type: "text", attrs: { maxlength: "500", inputmode: "numeric" } });
    var note = h("textarea", { id: "ru-note", attrs: { rows: "2", maxlength: "500" } });
    var submitOnly = h("div", null,
      field("ru-countries", "rules.countries", countries, "rules.countriesHint"),
      field("ru-professions", "rules.professions", professions, "rules.listHint"),
      field("ru-sources", "rules.sources", sources, "rules.sourcesHint"));
    type.addEventListener("change", function () { submitOnly.hidden = type.value !== "auto_submit"; });
    var b = h("button", { type: "submit", class: "btn", text: t("rules.create") });
    var form = h("form", { class: "notice info", attrs: { novalidate: true } },
      h("p", { class: "small", text: t("rules.hint") }),
      h("div", { class: "inline-fields" }, field("ru-cand", "filter.candidate", cand), field("ru-type", "rules.type", type)),
      submitOnly,
      field("ru-employers", "rules.employers", employers, "rules.employersHint"),
      field("ru-note", "rules.note", note),
      b);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!cand.value) { cand.setAttribute("aria-invalid", "true"); cand.focus(); V.toast(t("rules.pickCandidate"), "bad"); return; }
      var payload = { candidateId: Number(cand.value), type: type.value };
      var emp = splitList(employers.value);
      if (emp.some(function (x) { return !/^\d{1,9}$/.test(x); })) { employers.setAttribute("aria-invalid", "true"); employers.focus(); V.toast(t("rules.badEmployers"), "bad"); return; }
      if (emp.length) payload.employerIds = emp.map(Number);
      if (type.value === "auto_submit") {
        var cs = splitList(countries.value);
        if (!cs.length) { countries.setAttribute("aria-invalid", "true"); countries.focus(); V.toast(t("rules.countriesRequired"), "bad"); return; }
        payload.countries = cs;
        if (splitList(professions.value).length) payload.professions = splitList(professions.value);
        if (splitList(sources.value).length) payload.sources = splitList(sources.value);
      } else if (!emp.length) { employers.setAttribute("aria-invalid", "true"); employers.focus(); V.toast(t("rules.employersRequired"), "bad"); return; }
      if (note.value.trim()) payload.note = note.value.trim();
      V.confirmDialog(t("rules.createConfirm"), t("rules.create")).then(function (ok) {
        if (!ok) return;
        V.busy(b, function () { return V.api("POST", "/jobsearch/automation-rules", { body: payload }).then(function () { V.toast(t("rules.created"), "ok"); loadRules(true); }); }).catch(function () {});
      });
    });
    return form;
  }

  function rulesList(rules) {
    var rows = rules.map(function (r) {
      var sc = r.scope || {};
      var bits = [];
      if (sc.countries) bits.push(t("rules.countries") + ": " + sc.countries.join(", "));
      if (sc.professions) bits.push(t("rules.professions") + ": " + sc.professions.join(", "));
      if (sc.sources) bits.push(t("rules.sources") + ": " + sc.sources.join(", "));
      if (sc.employerIds) bits.push(t("rules.employers") + ": " + sc.employerIds.map(function (x) { return "#" + x; }).join(", "));
      var cell = h("td");
      if (r.active) {
        var d = h("button", { type: "button", class: "btn danger small", text: t("rules.disable") });
        d.addEventListener("click", function () {
          V.confirmDialog(t("rules.disableConfirm"), t("rules.disable"), true).then(function (ok) {
            if (!ok) return;
            V.busy(d, function () { return V.api("DELETE", "/jobsearch/automation-rules/" + r.id).then(function () { V.toast(t("rules.disabled"), "ok"); loadRules(); }); }).catch(function () {});
          });
        });
        cell.appendChild(d);
      }
      return h("tr", null,
        h("td", { text: "#" + r.id }),
        h("td", { text: (r.candidateName || "") + " (#" + r.candidateId + ")" }),
        h("td", { text: tc("ruleType", r.type) }),
        h("td", { class: "small", text: bits.join(" · ") || t("rules.noScope") }),
        h("td", null, h("span", { class: "badge " + (r.enabled ? "ok" : "neutral"), text: r.enabled ? t("rules.enabled") : t("rules.off") })),
        cell);
    });
    return h("div", null, h("h3", { text: t("rules.listTitle") }), table(["#", t("filter.candidate"), t("rules.type"), t("rules.scope"), t("rules.state"), t("dir.actions")], rows, { empty: t("rules.none") }));
  }

  function initScheduler() { $("#scheduler-refresh").addEventListener("click", loadScheduler); }
  function loadScheduler() {
    var box = $("#scheduler-out");
    if (!isAdmin()) return V.setContent(box, V.empty(t("scheduler.adminOnly")));
    V.setContent(box, V.loading());
    V.api("GET", "/jobsearch/scheduler/status").then(function (st) {
      var tick = h("button", { type: "button", class: "btn", text: t("scheduler.tick") });
      var result = h("div", { attrs: { "aria-live": "polite" } });
      tick.addEventListener("click", function () {
        V.busy(tick, function () {
          return V.api("POST", "/jobsearch/scheduler/tick", { body: {} }).then(function (sum) {
            var lines = Object.keys(sum || {}).map(function (k) {
              var v = sum[k];
              return h("li", { text: k + ": " + (Array.isArray(v) ? V.fmtNumber(v.length) : v && typeof v === "object" ? Object.keys(v).length + " …" : String(v)) });
            });
            V.setContent(result, h("div", { class: "notice ok" }, h("strong", { text: t("scheduler.tickDone") }), h("ul", { class: "compact" }, lines)));
            V.announce(t("scheduler.tickDone"));
          });
        }).catch(function () {});
      });
      var last = st.lastTick || {};
      V.setContent(box,
        kv([
          [t("scheduler.enabled"), st.enabled ? t("common.yes") : t("scheduler.disabled")],
          [t("scheduler.running"), st.running ? t("common.yes") : t("common.no")],
          [t("health.module"), st.modulePaused ? t("module.paused") : t("module.running")],
          [t("health.lastTick"), last.at ? V.fmtDateTime(last.at) : t("sources.never")],
        ]),
        h("div", { class: "btn-row" }, tick),
        result,
        h("h3", { text: t("health.sources") }),
        table([t("sources.key"), t("scheduler.schedule"), t("sources.lastRunAt"), t("sources.lastRun")], st.sources.map(function (s) {
          return h("tr", null, h("td", null, h("code", { text: s.key })), h("td", null, h("code", { class: "ltr-island", text: s.schedule })), h("td", { text: s.lastRunAt ? V.fmtDateTime(s.lastRunAt) : t("sources.never") }), h("td", { text: s.lastRun ? tc("runStatus", s.lastRun.status) : "—" }));
        })));
    }).catch(function (err) { V.setContent(box, errorBox(err)); });
  }

  // ================================================================ boot
  V.onUnauthorized(function () { showLogin(); V.toast(t("err.401"), "bad"); });
  initLogin();
  if (V.getSession() && V.getSession().kind === "staff") start();
  else showLogin();
})();
