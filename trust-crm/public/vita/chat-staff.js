/* Staff console "Messages" tab (chat:read): the messaging panel in staff mode, the open-conversation dialog (candidate by
   name or id; employers and agencies when the role may read organisations and moderate), moderation (chat:moderate), the
   e-mail nudge preference, an honest channel status card and the unread badge on the tab. Names, e-mails and message text
   are untrusted and rendered as text only. crm-util.js mirrors middleware/role.js; the server decides on every call. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var CU = window.VITA_CRM_UTIL;
  var U = window.VITA_CHAT_UTIL;
  var C = window.VITA_CHAT;
  var t = V.t, h = V.h, $ = V.$;

  var panel = null;
  var started = false;

  function role() { return A.role(); }
  function visible() { return CU.canChatRead(role()); }
  /** Organisation conversations: the role reads organisations AND moderates (the server opens them for Admin / Manager / SuperAdmin only). */
  function canOrgSubjects() { return CU.canOrgsRead(role()) && CU.canChatModerate(role()); }

  // ---------------------------------------------------------------- channel status (honest)
  function loadChannels() {
    var box = $("#chat-channels-body");
    if (!box) return Promise.resolve();
    return V.api("GET", "/chat/channels")
      .then(function (data) {
        var rows = (data && data.channels) || [];
        V.setContent(box, h("ul", { class: "plain chat-channel-list" }, rows.map(function (c) {
          var state = U.channelState(c);
          var cls = state === "connected" ? "ok" : state === "unknown" ? "neutral" : "warn";
          var name = V.has("chat.channel." + c.channel) ? t("chat.channel." + c.channel) : String(c.channel);
          return h("li", null,
            h("strong", { text: name + " " }),
            h("span", { class: "badge " + cls, text: t("chat.chstate." + state) }),
            h("p", { class: "small muted", text: t("chat.channel." + c.channel + ".note") }));
        })));
      })
      .catch(function (err) { V.setContent(box, h("p", { class: "notice bad small", attrs: { role: "alert" }, text: V.errorMessage(err) })); });
  }

  // ---------------------------------------------------------------- open-conversation dialog
  /** Organisation search: type part of a name (GET /crm/employers | /crm/agencies ?q=) or the numeric id. */
  function orgPicker(type) {
    var search = h("input", { id: "chat-open-org-search", type: "search", attrs: { maxlength: "100", autocomplete: "off" } });
    var pick = h("select", { id: "chat-open-org-pick" });
    var idInput = h("input", { id: "chat-open-org-id", type: "text", attrs: { inputmode: "numeric", maxlength: "10", autocomplete: "off", dir: "ltr" } });
    var state = h("p", { class: "small muted", attrs: { "aria-live": "polite" } });
    var results = [];
    var n = 0;
    function fill() {
      A.fillSelect(pick, [["", results.length ? t("chat.open.pick") : t("chat.open.noMatches")]].concat(results.map(function (r) { return [String(r.id), r.name + " (#" + r.id + ")"]; })), "");
    }
    var lookup = V.debounce(function () {
      var q = search.value.trim();
      var mine = ++n;
      if (q.length < 2) { results = []; fill(); V.setContent(state); return; }
      V.setContent(state, t("chat.open.searching"));
      var needle = encodeURIComponent(q.slice(0, 100));
      var request = type === "agency" ? V.api("GET", "/crm/agencies?limit=25&q=" + needle) : V.api("GET", "/crm/employers?limit=25&q=" + needle);
      return request
        .then(function (data) {
          if (mine !== n) return;
          results = ((data && data.rows) || []).slice(0, 25).map(function (r) { return { id: r.id, name: String(r.name || "") }; });
          fill();
          V.setContent(state, results.length ? t("chat.open.found", { n: results.length }) : t("chat.open.noMatches"));
        })
        .catch(function (err) { if (mine === n) V.setContent(state, V.errorMessage(err)); });
    }, 300);
    search.addEventListener("input", lookup);
    pick.addEventListener("change", function () { if (pick.value) idInput.value = pick.value; });
    fill();
    var el = h("div", null,
      field("chat-open-org-search", t("chat.open.orgSearch"), search),
      field("chat-open-org-pick", t("chat.open.results"), pick),
      field("chat-open-org-id", t("chat.open.id"), idInput),
      state);
    return { el: el, id: function () { return idInput.value; }, input: search };
  }
  function field(id, label, control) { return h("div", { class: "field" }, h("label", { for: id, text: label }), control); }

  function candidatePicker() {
    if (window.VITA_FIN && typeof window.VITA_FIN.candidatePicker === "function") {
      var p = window.VITA_FIN.candidatePicker("chat-open-cand", t("chat.open.candidate"));
      return { el: p.el, id: function () { return p.id(); }, input: p.input };
    }
    var idInput = h("input", { id: "chat-open-cand-id", type: "text", attrs: { inputmode: "numeric", maxlength: "10", autocomplete: "off", dir: "ltr" } });
    return { el: field("chat-open-cand-id", t("chat.open.id"), idInput), id: function () { return idInput.value; }, input: idInput };
  }

  function openDialog() {
    if (!panel) return;
    var types = [["candidate", t("chat.kind.candidate")]];
    if (canOrgSubjects()) types.push(["employer_request", t("chat.kind.employer_request")], ["agency", t("chat.kind.agency")]);
    var typeSel = h("select", { id: "chat-open-type" });
    A.fillSelect(typeSel, types, "candidate");
    var slot = h("div", null);
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var current = null;
    function swap() {
      current = typeSel.value === "candidate" ? candidatePicker() : orgPicker(typeSel.value);
      V.setContent(slot, current.el);
      err.textContent = "";
    }
    typeSel.addEventListener("change", swap);
    swap();
    var ok = h("button", { type: "submit", class: "btn", text: t("chat.open.submit") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var form = h("form", { attrs: { novalidate: "" } },
      h("h3", { id: "chat-open-title", text: t("chat.open.title") }),
      h("p", { class: "small muted", text: t("chat.open.hint") }),
      field("chat-open-type", t("chat.open.about"), typeSel),
      slot, err,
      h("div", { class: "btn-row" }, ok, cancel));
    var dlg = h("dialog", { class: "wide", attrs: { "aria-labelledby": "chat-open-title" } }, form);
    document.body.appendChild(dlg);
    var opener = document.activeElement;
    function done() {
      if (dlg.open) dlg.close();
      dlg.remove();
      if (opener && opener.focus && opener.isConnected) opener.focus();
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      var built = U.subjectOpenPayload(typeSel.value, current.id());
      if (!built.ok) { err.textContent = t("chat.open.err." + built.error); current.input.focus(); return; }
      V.busy(ok, function () {
        return panel.openSubject(built.payload.subject_type, String(built.payload.subject_id)).then(function (conv) {
          done();
          V.toast(t("chat.open.opened"), "ok");
          return conv;
        });
      }).catch(function (e2) { err.textContent = e2 && e2.status === 404 ? t("chat.open.notFound") : V.errorMessage(e2); });
    });
    cancel.addEventListener("click", done);
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); done(); });
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    typeSel.focus();
  }

  // ---------------------------------------------------------------- tab wiring
  function init() {
    var badge = C.badge($("#chat-tab-badge"));
    panel = C.createPanel({
      root: $("#chat-staff-root"),
      mode: "staff",
      canWrite: function () { return CU.canChatWrite(role()); },
      canModerate: function () { return CU.canChatModerate(role()); },
      onNew: openDialog,
      onUnread: badge,
    });
  }
  /** Sign-in of a role with chat:read: the stream and the unread badge run for the whole session, not only while the tab is open. */
  function onStart() {
    if (!panel || started) return;
    started = true;
    panel.start();
  }
  function onStop() {
    if (!panel) return;
    started = false;
    panel.stop();
    V.clear($("#chat-channels-body"));
  }
  function load() {
    if (!panel) return;
    onStart();
    panel.activate();
    loadChannels();
  }

  A.registerTab("chat", { init: init, load: load, visible: visible, onStart: onStart, onStop: onStop });
})();
