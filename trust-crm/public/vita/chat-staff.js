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
  function visible() { return CU.canChatUse(role()); }
  /** HR / Accountant: no chat:* - they read and write only inside staff rooms they were added to (the server enforces it). */
  function participantOnly() { return CU.isChatParticipantOnly(role()); }
  function canWrite() { return CU.canChatWrite(role()) || participantOnly(); }
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

  // ---------------------------------------------------------------- staff rooms and participants
  /** Staff search (GET /chat/staff?q=, chat:moderate): name + role, no e-mail. onPick(user) receives the chosen person. */
  function staffPicker(idBase, onPick) {
    var search = h("input", { id: idBase + "-search", type: "search", attrs: { maxlength: "100", autocomplete: "off" } });
    var pick = h("select", { id: idBase + "-pick" });
    var add = h("button", { type: "button", class: "btn secondary small", text: t("chat.room.add") });
    var state = h("p", { class: "small muted", attrs: { "aria-live": "polite" } });
    var results = [];
    var n = 0;
    function fill() {
      A.fillSelect(pick, [["", results.length ? t("chat.room.pick") : t("chat.open.noMatches")]].concat(results.map(function (r) { return [String(r.id), r.full_name + " (" + roleName(r.role) + ")"]; })), "");
    }
    var lookup = V.debounce(function () {
      var mine = ++n;
      var q = search.value.trim();
      V.setContent(state, t("chat.open.searching"));
      return V.api("GET", "/chat/staff?limit=25&q=" + encodeURIComponent(q.slice(0, 100)))
        .then(function (data) {
          if (mine !== n) return;
          results = ((data && data.rows) || []).slice(0, 25).map(function (r) { return { id: r.id, full_name: String(r.full_name || ""), role: String(r.role || "") }; });
          fill();
          V.setContent(state, results.length ? t("chat.open.found", { n: results.length }) : t("chat.open.noMatches"));
        })
        .catch(function (err) { if (mine === n) V.setContent(state, V.errorMessage(err)); });
    }, 300);
    search.addEventListener("input", lookup);
    add.addEventListener("click", function () {
      var chosen = results.filter(function (r) { return String(r.id) === pick.value; })[0];
      if (chosen) onPick(chosen);
    });
    fill();
    lookup();
    return { el: h("div", null, field(idBase + "-search", t("chat.room.search"), search), field(idBase + "-pick", t("chat.open.results"), pick), add, state), input: search };
  }
  function roleName(r) { return V.has("chat.role." + r) ? t("chat.role." + r) : String(r); }

  /** A modal dialog with a form; returns {dlg, form, done}. */
  function modal(titleId, titleText, hint) {
    var form = h("form", { attrs: { novalidate: "" } }, h("h3", { id: titleId, text: titleText }), hint ? h("p", { class: "small muted", text: hint }) : null);
    var dlg = h("dialog", { class: "wide", attrs: { "aria-labelledby": titleId } }, form);
    document.body.appendChild(dlg);
    var opener = document.activeElement;
    function done() {
      if (dlg.open) dlg.close();
      dlg.remove();
      if (opener && opener.focus && opener.isConnected) opener.focus();
    }
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); done(); });
    return { dlg: dlg, form: form, done: done, show: function () { if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", ""); } };
  }

  /** New staff room (chat:moderate): a name and 1 to 50 staff participants; the creator joins automatically. HR and Accountant can be added. */
  function roomDialog() {
    if (!panel) return;
    var m = modal("chat-room-title", t("chat.room.title"), t("chat.room.hint"));
    var name = h("input", { id: "chat-room-name", type: "text", attrs: { maxlength: "120", autocomplete: "off" } });
    var chosen = [];
    var list = h("ul", { class: "plain chat-room-members", attrs: { "aria-live": "polite" } });
    var count = h("p", { class: "small muted" });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    function renderChosen() {
      V.clear(list);
      chosen.forEach(function (u) {
        list.appendChild(h("li", null, h("span", { text: u.full_name + " (" + roleName(u.role) + ") " }),
          h("button", { type: "button", class: "linklike small", text: t("chat.room.remove"), on: { click: function () { chosen = chosen.filter(function (x) { return x.id !== u.id; }); renderChosen(); } } })));
      });
      count.textContent = chosen.length ? t("chat.room.selected", { n: chosen.length }) : t("chat.room.none");
    }
    var picker = staffPicker("chat-room", function (u) {
      if (!chosen.some(function (x) { return x.id === u.id; })) chosen.push(u);
      renderChosen();
    });
    renderChosen();
    var ok = h("button", { type: "submit", class: "btn", text: t("chat.room.submit") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    [field("chat-room-name", t("chat.room.name"), name), picker.el, count, list, err, h("div", { class: "btn-row" }, ok, cancel)].forEach(function (el) { m.form.appendChild(el); });
    m.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      var built = U.staffRoomPayload(name.value, chosen.map(function (u) { return u.id; }));
      if (!built.ok) { err.textContent = t("chat.room.err." + built.error); (built.error === "title" ? name : picker.input).focus(); return; }
      V.busy(ok, function () {
        return V.api("POST", "/chat/conversations", { body: built.payload }).then(function (conv) {
          m.done();
          V.toast(t("chat.room.created"), "ok");
          return panel.reload().then(function () { if (conv && conv.id) panel.openConversation(conv.id); });
        });
      }).catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
    cancel.addEventListener("click", m.done);
    m.show();
    name.focus();
  }

  /** Add participant (chat:moderate) to the open organisation conversation or staff room, and remove the ones already added. */
  function participantDialog(conv) {
    if (!panel || !conv || !U.canAddParticipants(conv)) return;
    var m = modal("chat-part-title", t("chat.participants.title"), t("chat.participants.hint"));
    var current = h("ul", { class: "plain chat-participants", attrs: { "aria-label": t("chat.participants.current") } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    function loadCurrent() {
      return V.api("GET", "/chat/conversations/" + conv.id + "/participants").then(function (data) {
        var rows = (data && data.rows) || [];
        V.clear(current);
        if (!rows.length) current.appendChild(h("li", { class: "small muted", text: t("chat.participants.empty") }));
        rows.forEach(function (r) {
          current.appendChild(h("li", null, h("span", { text: String(r.full_name || "") + " (" + roleName(String(r.role || "")) + ") " }),
            h("button", { type: "button", class: "linklike small", text: t("chat.participants.remove"), on: { click: function (e) {
              V.busy(e.currentTarget, function () { return V.api("DELETE", "/chat/conversations/" + conv.id + "/participants/" + encodeURIComponent(String(r.user_id))).then(function () { V.toast(t("chat.participants.removed"), "ok"); return loadCurrent(); }); })
                .catch(function (e2) { err.textContent = V.errorMessage(e2); });
            } } })));
        });
      }).catch(function (e2) { err.textContent = V.errorMessage(e2); });
    }
    var picker = staffPicker("chat-part", function (u) {
      err.textContent = "";
      var built = U.participantPayload(String(u.id));
      if (!built.ok) { err.textContent = t("chat.participants.err.none"); return; }
      V.api("POST", "/chat/conversations/" + conv.id + "/participants", { body: built.payload }).then(function (out) {
        V.toast(t(out && out.changed ? "chat.participants.added" : "chat.participants.already"), "ok");
        return loadCurrent();
      }).catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
    var close = h("button", { type: "button", class: "btn secondary", text: t("common.close") });
    [h("h4", { text: t("chat.participants.current") }), current, picker.el, err, h("div", { class: "btn-row" }, close)].forEach(function (el) { m.form.appendChild(el); });
    m.form.addEventListener("submit", function (e) { e.preventDefault(); });
    close.addEventListener("click", m.done);
    loadCurrent();
    m.show();
    picker.input.focus();
  }

  // ---------------------------------------------------------------- tab wiring
  function init() {
    var badge = C.badge($("#chat-tab-badge"));
    panel = C.createPanel({
      root: $("#chat-staff-root"),
      mode: "staff",
      canWrite: canWrite,
      canModerate: function () { return CU.canChatModerate(role()); },
      participantOnly: participantOnly,
      onNew: openDialog,
      onNewRoom: roomDialog,
      onAddParticipant: participantDialog,
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
