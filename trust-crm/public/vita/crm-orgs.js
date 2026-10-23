/* Staff console "Organisations" tab: employers and partner agencies - list, create/edit, portal-user invite,
   suspend / reactivate. Names, e-mails and notes are untrusted and rendered as text only. Write controls are shown
   only to roles holding orgs:write (crm-util.js mirrors middleware/role.js); the server decides on every call. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var U = window.VITA_CRM_UTIL;
  var O = window.VITA_ORGS_UTIL;
  var C = window.VITA_ORGS;
  var t = V.t, h = V.h, $ = V.$;

  var PAGE_SIZE = 25;
  var G = { type: "employer", filters: { status: "", q: "" }, page: 1, total: 0, loaded: false, openId: null, row: null, form: null, isNew: false, invite: null };

  function role() { return A.role(); }
  function canWrite() { return U.canOrgsWrite(role()); }
  function statusBadge(s) { return C.badge(O.orgStatusClass(s), t("orgs.ostatus." + s)); }

  /** Same call for either organisation type; every path is a literal /crm/... prefix. */
  function api(method, suffix, body) {
    var opts = body === undefined ? undefined : { body: body };
    return G.type === "employer" ? V.api(method, "/crm/employers" + suffix, opts) : V.api(method, "/crm/agencies" + suffix, opts);
  }

  // ---------------------------------------------------------------- type switch + filters
  function fillFilter() {
    var items = [["", t("crm.org.allStatuses")]].concat(O.ORG_STATUSES[G.type].map(function (s) { return [s, t("orgs.ostatus." + s)]; }));
    C.fillSelect($("#org-f-status"), items, G.filters.status);
  }

  function syncTypeButtons() {
    ["employer", "agency"].forEach(function (ty) { $("#org-type-" + ty).setAttribute("aria-pressed", String(ty === G.type)); });
  }

  function setType(type) {
    if (type === G.type) return;
    G.type = type;
    G.filters = { status: "", q: "" };
    $("#org-f-q").value = "";
    G.page = 1;
    G.loaded = false;
    closeCard();
    syncTypeButtons();
    fillFilter();
    loadList();
  }

  // ---------------------------------------------------------------- list
  function loadList() {
    var box = $("#org-table");
    if (!G.loaded) V.setContent(box, V.loading());
    var type = G.type;
    return api("GET", O.orgQuery(G.filters, G.page, PAGE_SIZE))
      .then(function (data) {
        if (type !== G.type) return;
        G.loaded = true;
        G.total = data.total;
        var pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
        if (G.page > pages) { G.page = pages; return loadList(); }
        renderList(data.rows, pages);
      })
      .catch(function (err) { V.setContent(box, C.errorBox(err)); V.setContent($("#org-summary")); V.clear($("#org-pager")); });
  }

  function renderList(rows, pages) {
    V.setContent($("#org-summary"), t("crm.org.count", { n: V.fmtNumber(G.total) }));
    var trs = rows.map(function (r) {
      var open = h("button", { type: "button", class: "btn secondary small", text: t("common.open") });
      open.addEventListener("click", function () { openOrg(r.id, true); });
      return h("tr", { class: String(r.id) === String(G.openId) ? "selected" : null },
        h("td", null, h("strong", { text: r.name }), r.contact_name ? h("div", { class: "small muted", text: r.contact_name }) : null),
        h("td", null, r.email ? h("div", { text: r.email }) : null, r.phone ? h("div", { class: "small ltr-island", text: r.phone }) : null, !r.email && !r.phone ? "—" : null),
        h("td", { text: r.country || "—" }),
        h("td", null, statusBadge(r.status)),
        h("td", { text: V.fmtNumber(r.portal_users) }),
        h("td", null, open)
      );
    });
    V.setContent($("#org-table"), C.table(
      [t("orgs.f.name"), t("crm.org.contact"), t("orgs.f.country"), t("orgs.f.status"), t("crm.org.portalUsers"), t("common.actions")],
      trs, { empty: t("crm.org.none"), caption: t("crm.org.title") }));
    C.pager($("#org-pager"), G.page, pages, function (p) { G.page = p; loadList(); });
  }

  // ---------------------------------------------------------------- detail / editor
  function closeCard() {
    G.openId = null;
    G.row = null;
    G.form = null;
    G.isNew = false;
    G.invite = null;
    $("#org-card").hidden = true;
  }

  function openNew() {
    G.openId = null;
    G.row = null;
    G.isNew = true;
    G.invite = null;
    G.form = O.orgValues(G.type, {});
    $("#org-card").hidden = false;
    renderCard();
    $("#org-card").scrollIntoView({ block: "start" });
    $("#org-card-title").focus();
  }

  function openOrg(id, focus) {
    if (String(G.openId) !== String(id)) G.invite = null;
    G.openId = id;
    G.isNew = false;
    var card = $("#org-card");
    card.hidden = false;
    V.setContent($("#org-body"), V.loading());
    var type = G.type;
    return api("GET", "/" + id)
      .then(function (row) {
        if (String(G.openId) !== String(id) || type !== G.type) return;
        G.row = row;
        G.form = O.orgValues(type, row);
        renderCard();
        if (focus) { card.scrollIntoView({ block: "start" }); $("#org-card-title").focus(); }
      })
      .catch(function (err) { V.setContent($("#org-body"), C.errorBox(err)); });
  }

  function readForm() {
    var v = {};
    Object.keys(O.ORG_FIELDS[G.type]).forEach(function (k) {
      var el = $("#org-f-" + k);
      v[k] = el ? el.value : "";
    });
    return v;
  }

  function fieldId(field) { return "org-f-" + field; }

  function renderCard() {
    var row = G.row;
    var write = canWrite();
    var v = G.form || O.orgValues(G.type, row);
    V.setContent($("#org-card-title"), row ? row.name : t(G.type === "employer" ? "crm.org.newEmployer" : "crm.org.newAgency"));
    var parts = [];

    if (G.invite) {
      parts.push(h("div", { class: "notice " + (G.invite.sent ? "ok" : "warn"), attrs: { role: "status" } },
        h("strong", { text: t("crm.org.invited", { email: G.invite.email }) }),
        h("p", { class: "small", text: G.invite.sent ? t("crm.org.inviteSent") : t("crm.org.inviteNotSent") })));
    }
    if (row) {
      parts.push(C.kv([
        [t("orgs.f.status"), statusBadge(row.status)],
        [t("crm.org.created"), V.fmtDateTime(row.created_at)],
        [t("crm.org.updated"), V.fmtDateTime(row.updated_at)],
      ]));
      if (row.status === "suspended") parts.push(h("p", { class: "notice warn small", text: t("crm.org.suspendedNote") }));
    }
    if (!write) parts.push(h("p", { class: "notice info small", text: t("crm.org.readOnly") }));

    var inputs = Object.keys(O.ORG_FIELDS[G.type]).map(function (k) {
      var max = O.ORG_FIELDS[G.type][k];
      var control = k === "notes"
        ? h("textarea", { id: fieldId(k), attrs: { rows: "3", maxlength: String(max) }, value: v[k], disabled: !write })
        : h("input", { id: fieldId(k), type: k === "email" ? "email" : "text", attrs: { maxlength: String(max), autocomplete: "off" }, value: v[k], disabled: !write });
      return h("div", { class: "field" }, h("label", { for: fieldId(k), text: t("orgs.f." + k) + (k === "name" ? " *" : "") }), control);
    });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var form = h("form", { id: "org-form", attrs: { novalidate: "" } },
      h("div", { class: "grid two" }, h("div", null, inputs.slice(0, 4)), h("div", null, inputs.slice(4))),
      err,
      write ? h("div", { class: "btn-row" }, h("button", { type: "submit", class: "btn", text: row ? t("common.save") : t("crm.org.create") })) : null
    );
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (write) doSave(err, form.querySelector("button[type=submit]"));
    });
    parts.push(form);

    if (row) {
      parts.push(h("h3", { text: t("crm.org.portalUsers") }));
      parts.push(usersView(row));
      if (write) {
        var invite = h("button", { type: "button", class: "btn", text: t("crm.org.invite"), disabled: row.status === "suspended" });
        invite.addEventListener("click", function () { openInvite(row, invite); });
        var suspended = row.status === "suspended";
        var toggle = h("button", { type: "button", class: "btn" + (suspended ? " secondary" : " danger"), text: t(suspended ? "crm.org.reactivate" : "crm.org.suspend") });
        toggle.addEventListener("click", function () { doToggle(row, toggle); });
        parts.push(h("div", { class: "btn-row" }, invite, toggle));
        parts.push(h("p", { class: "small muted", text: t("crm.org.inviteHint") }));
      }
      parts.push(h("h3", { text: t("crm.org.history") }));
      parts.push(C.timelineList(row.timeline, "crm.notes.empty"));
    }
    V.setContent($("#org-body"), parts);
  }

  function usersView(row) {
    var users = Array.isArray(row.portal_users) ? row.portal_users : [];
    if (!users.length) return V.empty(t("crm.org.noUsers"));
    return C.table(
      [t("orgs.f.full_name"), t("orgs.f.email"), t("orgs.f.status"), t("crm.org.linked")],
      users.map(function (u) {
        return h("tr", null,
          h("td", { text: u.full_name }),
          h("td", { text: u.email }),
          h("td", null, C.badge(u.is_active ? "ok" : "neutral", t(u.is_active ? "crm.org.userActive" : "crm.org.userInactive"))),
          h("td", { text: V.fmtDate(u.linked_at) }));
      }),
      { caption: t("crm.org.portalUsers") });
  }

  // ---------------------------------------------------------------- actions
  function afterChange(row, msgKey) {
    G.row = row;
    loadList();
    V.toast(t(msgKey), "ok");
    V.announce(t(msgKey));
    return openOrg(row.id, false);
  }

  function doSave(err, btn) {
    err.textContent = "";
    var built = O.orgPayload(G.type, readForm());
    if (!built.ok) { C.flagField(built, fieldId, err); return; }
    var req;
    if (G.isNew) req = function () { return api("POST", "", built.payload).then(function (row) { G.isNew = false; return afterChange(row, "crm.org.created.toast"); }); };
    else {
      var changes = O.orgDiff(G.row, built.payload);
      if (!Object.keys(changes).length) { V.toast(t("crm.org.nothingToSave")); return; }
      req = function () { return api("PATCH", "/" + G.row.id, changes).then(function (row) { return afterChange(row, "crm.org.saved"); }); };
    }
    G.form = readForm();
    V.busy(btn, req).catch(function (e) { err.textContent = V.errorMessage(e); });
  }

  function doToggle(row, btn) {
    var suspend = row.status !== "suspended";
    V.confirmDialog(t(suspend ? "crm.org.suspendConfirm" : "crm.org.reactivateConfirm", { name: row.name }), t(suspend ? "crm.org.suspend" : "crm.org.reactivate"), suspend).then(function (ok) {
      if (!ok) return;
      V.busy(btn, function () {
        return api("POST", "/" + row.id + (suspend ? "/suspend" : "/reactivate"), {}).then(function (saved) { return afterChange(saved, suspend ? "crm.org.suspended" : "crm.org.reactivated"); });
      }).catch(function () {});
    });
  }

  function openInvite(row, opener) {
    var email = h("input", { id: "inv-email", type: "email", attrs: { maxlength: "320", autocomplete: "off", required: "", dir: "ltr" } });
    var name = h("input", { id: "inv-name", type: "text", attrs: { maxlength: "200", autocomplete: "off", required: "" } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var submit = h("button", { type: "submit", class: "btn", text: t("crm.org.inviteSubmit") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var form = h("form", { attrs: { novalidate: "" } },
      h("h2", { id: "inv-title", text: t("crm.org.inviteTitle", { name: row.name }) }),
      h("p", { class: "small", text: t("crm.org.inviteIntro") }),
      h("div", { class: "field" }, h("label", { for: "inv-email", text: t("orgs.f.email") + " *" }), email),
      h("div", { class: "field" }, h("label", { for: "inv-name", text: t("orgs.f.full_name") + " *" }), name),
      err,
      h("div", { class: "btn-row" }, submit, cancel)
    );
    var dlg = h("dialog", { attrs: { "aria-labelledby": "inv-title" } }, form);
    document.body.appendChild(dlg);
    var done = function () {
      if (dlg.open) dlg.close();
      dlg.remove();
      if (opener && opener.isConnected) opener.focus();
    };
    cancel.addEventListener("click", done);
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); done(); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      var built = O.invitePayload({ email: email.value, full_name: name.value });
      if (!built.ok) {
        err.textContent = C.validationMessage(built);
        (built.field === "email" ? email : name).setAttribute("aria-invalid", "true");
        (built.field === "email" ? email : name).focus();
        return;
      }
      V.busy(submit, function () {
        return api("POST", "/" + row.id + "/invite", built.payload).then(function (out) {
          G.invite = { email: out.user ? out.user.email : built.payload.email, sent: out.inviteSent === true };
          done();
          V.announce(t("crm.org.invited", { email: G.invite.email }));
          loadList();
          return openOrg(row.id, false);
        });
      }).catch(function (e2) { err.textContent = e2 && e2.status === 409 ? t("crm.org.inviteConflict") + (e2.message ? " — " + e2.message : "") : V.errorMessage(e2); });
    });
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    email.focus();
  }

  // ---------------------------------------------------------------- tab wiring
  function init() {
    fillFilter();
    syncTypeButtons();
    ["employer", "agency"].forEach(function (ty) { $("#org-type-" + ty).addEventListener("click", function () { setType(ty); }); });
    $("#org-filters").addEventListener("submit", function (e) {
      e.preventDefault();
      G.filters = { status: $("#org-f-status").value, q: $("#org-f-q").value };
      G.page = 1;
      loadList();
    });
    $("#org-filters").addEventListener("reset", function () {
      window.setTimeout(function () { G.filters = { status: "", q: "" }; G.page = 1; fillFilter(); loadList(); }, 0);
    });
    $("#org-refresh").addEventListener("click", function () { loadList(); });
    $("#org-new").hidden = !canWrite();
    $("#org-new").addEventListener("click", openNew);
    $("#org-close").addEventListener("click", closeCard);
    V.onLang(function () {
      G.filters.status = $("#org-f-status").value;
      fillFilter();
      if (!$("#org-card").hidden && $("#org-form")) {
        G.form = readForm(); // keep what was typed while switching language
        renderCard();
      }
    });
  }

  A.registerTab("orgs", { init: init, load: loadList, visible: function () { return U.canOrgsRead(role()); } });
})();
