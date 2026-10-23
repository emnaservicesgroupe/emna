/* CRM "Site jobs" tab: staff-authored public job offers (draft -> published -> closed).
   An offer needs an evidence note (where it came from) before it can be published; publishing and closing ask for
   confirmation. All text is rendered as text only; the server validates every field and has the last word. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var U = window.VITA_CRM_UTIL;
  var C = window.VITA_CRM;
  var t = V.t, h = V.h, $ = V.$;

  var PAGE_SIZE = 25;
  var STATUS_CLASS = { draft: "neutral", published: "ok", closed: "bad" };
  var TEXT_INPUTS = ["title", "employer_name", "country", "city", "category", "employment_type", "salary_text", "language_requirements"];
  var AREAS = { description: 6, requirements: 4, evidence_note: 3 };
  var SJ = { status: "", page: 1, total: 0, loaded: false, row: null, timeline: [], form: null };

  function statusBadge(s) { return h("span", { class: "badge " + (STATUS_CLASS[s] || "neutral"), text: t("crm.sjs." + s) }); }

  // ---------------------------------------------------------------- list
  function fillFilter() {
    A.fillSelect($("#sj-f-status"), [["", t("crm.sj.allStatuses")]].concat(U.SITE_STATUSES.map(function (s) { return [s, t("crm.sjs." + s)]; })), SJ.status);
  }

  function listQuery() {
    var parts = [];
    if (SJ.status) parts.push("status=" + encodeURIComponent(SJ.status));
    parts.push("limit=" + PAGE_SIZE, "offset=" + (SJ.page - 1) * PAGE_SIZE);
    return "?" + parts.join("&");
  }

  function loadList() {
    var box = $("#sj-table");
    if (!SJ.loaded) V.setContent(box, V.loading());
    return V.api("GET", "/crm/site-jobs" + listQuery())
      .then(function (data) {
        SJ.loaded = true;
        SJ.total = data.total;
        var pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
        if (SJ.page > pages) { SJ.page = pages; return loadList(); }
        renderList(data.rows, pages);
      })
      .catch(function (err) { V.setContent(box, A.errorBox(err)); V.setContent($("#sj-summary")); V.clear($("#sj-pager")); });
  }

  function renderList(rows, pages) {
    V.setContent($("#sj-summary"), t("crm.sj.count", { n: V.fmtNumber(SJ.total) }));
    var trs = rows.map(function (r) {
      var open = h("button", { type: "button", class: "btn secondary small", text: t("common.open") });
      open.addEventListener("click", function () { openEditor(r.id, true); });
      return h("tr", null,
        h("td", null, h("strong", { text: r.title }), r.employer_name ? h("div", { class: "small muted", text: r.employer_name }) : null),
        h("td", { text: [r.country, r.city].filter(Boolean).join(" · ") || "—" }),
        h("td", null, statusBadge(r.status)),
        h("td", { text: r.published_at ? V.fmtDate(r.published_at) : "—" }),
        h("td", { text: r.closes_at ? V.fmtDate(r.closes_at) : "—" }),
        h("td", null, open)
      );
    });
    V.setContent($("#sj-table"), A.table(
      [t("crm.sj.f.title"), t("crm.sj.col.where"), t("crm.f.status"), t("crm.sj.col.published"), t("crm.sj.f.closes_at"), t("common.actions")],
      trs, { empty: t("crm.sj.none"), caption: t("crm.sj.title") }));
    C.renderPager($("#sj-pager"), SJ.page, pages, function (p) { SJ.page = p; loadList(); });
  }

  // ---------------------------------------------------------------- editor
  /** Form values (strings) for a stored row, or the blank values of a new offer. */
  function valuesOf(row) {
    var r = row || {};
    var am = U.parseApplyMode(r.apply_mode);
    var v = { apply_mode: am.mode, apply_url: am.url, closes_at: U.toLocalInput(r.closes_at) };
    TEXT_INPUTS.concat(Object.keys(AREAS)).forEach(function (k) { v[k] = r[k] === null || r[k] === undefined ? "" : String(r[k]); });
    return v;
  }

  function readForm() {
    var v = {};
    TEXT_INPUTS.concat(Object.keys(AREAS), ["apply_mode", "apply_url", "closes_at"]).forEach(function (k) {
      var el = $("#sj-" + k);
      v[k] = el ? el.value : "";
    });
    return v;
  }

  function openEditor(id, focus) {
    var card = $("#sj-card");
    card.hidden = false;
    if (id === null) {
      SJ.row = null;
      SJ.timeline = [];
      SJ.form = valuesOf(null);
      renderEditor();
      if (focus) { card.scrollIntoView({ block: "start" }); $("#sj-card-title").focus(); }
      return Promise.resolve();
    }
    V.setContent($("#sj-body"), V.loading());
    return V.api("GET", "/crm/site-jobs/" + id)
      .then(function (row) {
        SJ.row = row;
        SJ.timeline = row.timeline || [];
        SJ.form = valuesOf(row);
        renderEditor();
        if (focus) { card.scrollIntoView({ block: "start" }); $("#sj-card-title").focus(); }
      })
      .catch(function (err) { V.setContent($("#sj-body"), A.errorBox(err)); });
  }

  function closeEditor() {
    SJ.row = null;
    SJ.form = null;
    $("#sj-card").hidden = true;
  }

  function fieldBox(name, control, hint) {
    return h("div", { class: "field" }, h("label", { for: "sj-" + name, text: t("crm.sj.f." + name) }), control, hint ? h("span", { class: "hint", text: hint }) : null);
  }

  function renderEditor() {
    var row = SJ.row;
    var v = SJ.form || valuesOf(row);
    var closed = Boolean(row && row.status === "closed");
    var published = Boolean(row && row.status === "published");
    V.setContent($("#sj-card-title"), row ? t("crm.sj.formEdit", { id: row.id }) : t("crm.sj.formNew"));

    var inputs = {};
    var text = function (name, extra) {
      inputs[name] = h("input", { id: "sj-" + name, type: "text", attrs: { maxlength: "160", autocomplete: "off" }, value: v[name], disabled: closed });
      return fieldBox(name, inputs[name], extra);
    };
    var area = function (name, hint) {
      inputs[name] = h("textarea", { id: "sj-" + name, attrs: { rows: String(AREAS[name]), maxlength: name === "description" ? "8000" : name === "requirements" ? "4000" : name === "evidence_note" ? "1000" : "160" }, value: v[name], disabled: closed });
      return fieldBox(name, inputs[name], hint);
    };

    var modeSel = h("select", { id: "sj-apply_mode", disabled: closed });
    A.fillSelect(modeSel, U.APPLY_MODES.concat(["external"]).map(function (m) { return [m, t("crm.sj.apply." + m)]; }), v.apply_mode);
    var url = h("input", { id: "sj-apply_url", type: "text", attrs: { maxlength: "160", autocomplete: "off", inputmode: "url", dir: "ltr" }, value: v.apply_url, disabled: closed });
    var urlField = fieldBox("apply_url", url, t("crm.sj.applyUrlHint"));
    var syncUrl = function () { urlField.hidden = modeSel.value !== "external"; };
    modeSel.addEventListener("change", syncUrl);
    syncUrl();

    var closes = h("input", { id: "sj-closes_at", type: "datetime-local", value: v.closes_at, disabled: closed });
    var evidence = fieldBox("evidence_note", (inputs.evidence_note = h("textarea", { id: "sj-evidence_note", attrs: { rows: "3", maxlength: "1000" }, value: v.evidence_note, disabled: closed })), null);
    evidence.appendChild(h("p", { class: "notice info small", text: t("crm.sj.evidenceHelp") }));

    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var buttons = [];
    if (!closed) {
      var save = h("button", { type: "button", class: "btn", text: t("common.save") });
      save.addEventListener("click", function () { doSave(save, err); });
      buttons.push(save);
    }
    if (row && row.status === "draft") {
      var pub = h("button", { type: "button", class: "btn", text: t("crm.sj.publish") });
      pub.addEventListener("click", function () { doPublish(pub, err); });
      buttons.push(pub);
    }
    if (published) {
      var close = h("button", { type: "button", class: "btn danger", text: t("crm.sj.close") });
      close.addEventListener("click", function () { doClose(close); });
      buttons.push(close);
    }

    var parts = [];
    if (row) {
      parts.push(A.kv([
        [t("crm.f.status"), statusBadge(row.status)],
        [t("crm.sj.col.published"), row.published_at ? V.fmtDateTime(row.published_at) : null],
        [t("crm.f.updated"), V.fmtDateTime(row.updated_at)],
      ]));
      if (row.status === "draft") parts.push(h("p", { class: "small muted", text: t("crm.sj.draftNote") }));
      if (closed) parts.push(h("p", { class: "notice warn small", text: t("crm.sj.closedReadonly") }));
    }
    parts.push(h("form", { id: "sj-form", attrs: { novalidate: "" } },
      h("div", { class: "grid two" },
        h("div", null, text("title"), text("employer_name"), text("country"), text("city"), text("category")),
        h("div", null, text("employment_type"), text("salary_text"), text("language_requirements"), fieldBox("closes_at", closes, t("crm.sj.closesHint")))
      ),
      area("description"),
      area("requirements"),
      fieldBox("apply_mode", modeSel, null),
      urlField,
      evidence,
      err,
      h("div", { class: "btn-row" }, buttons)
    ));
    if (row) {
      parts.push(h("h3", { text: t("crm.sj.history") }));
      parts.push(C.timelineList(SJ.timeline, "crm.notes.empty"));
    }
    V.setContent($("#sj-body"), parts);
    $("#sj-form").addEventListener("submit", function (e) { e.preventDefault(); });
  }

  // ---------------------------------------------------------------- actions
  function fieldError(code) {
    var field = String(code).replace(/_long$/, "");
    if (code === "title") return t("crm.sj.titleRequired");
    if (code === "apply_url") return t("crm.sj.applyUrlInvalid");
    if (code === "closes_at") return t("crm.sj.closesInvalid");
    return t("crm.sj.tooLong", { field: V.has("crm.sj.f." + field) ? t("crm.sj.f." + field) : field });
  }

  function focusField(code) {
    var name = String(code).replace(/_long$/, "");
    var el = $("#sj-" + name);
    if (el) el.focus();
  }

  /** Validates the form; returns the payload or shows the problem in `err` and returns null. */
  function build(err) {
    err.textContent = "";
    var built = U.siteJobPayload(readForm());
    if (!built.ok) {
      err.textContent = fieldError(built.error);
      focusField(built.error);
      return null;
    }
    return built.payload;
  }

  function afterChange(row, msgKey) {
    SJ.row = row;
    loadList();
    V.toast(t(msgKey), "ok");
    V.announce(t(msgKey));
    return openEditor(row.id, false);
  }

  /** Creates the offer, or patches only the changed fields; resolves to the stored row (or the unchanged one). */
  function persist(payload) {
    if (!SJ.row) return V.api("POST", "/crm/site-jobs", { body: payload });
    var changes = U.diffPayload(SJ.row, payload);
    if (!Object.keys(changes).length) return Promise.resolve(SJ.row);
    return V.api("PATCH", "/crm/site-jobs/" + SJ.row.id, { body: changes });
  }

  function doSave(btn, err) {
    var payload = build(err);
    if (!payload) return;
    var isNew = !SJ.row;
    if (!isNew && !Object.keys(U.diffPayload(SJ.row, payload)).length) { V.toast(t("crm.sj.nothingToSave")); return; }
    V.busy(btn, function () {
      return persist(payload).then(function (row) { return afterChange(row, "crm.sj.saved"); });
    }).catch(function (e) { err.textContent = V.errorMessage(e); });
  }

  function doPublish(btn, err) {
    var payload = build(err);
    if (!payload) return;
    var blockers = U.publishBlockers(payload);
    if (blockers.missing.length || blockers.closesPast) {
      var msgs = [];
      if (blockers.missing.length) msgs.push(t("crm.sj.publishMissing", { fields: blockers.missing.map(function (k) { return t("crm.sj.f." + k); }).join(", ") }));
      if (blockers.closesPast) msgs.push(t("crm.sj.closesPast"));
      err.textContent = msgs.join(" ");
      focusField(blockers.missing[0] || "closes_at");
      return;
    }
    V.confirmDialog(t("crm.sj.publishConfirm", { title: payload.title }), t("crm.sj.publish")).then(function (ok) {
      if (!ok) return;
      V.busy(btn, function () {
        return persist(payload)
          .then(function () { return V.api("POST", "/crm/site-jobs/" + SJ.row.id + "/publish", { body: {} }); })
          .then(function (row) { return afterChange(row, "crm.sj.published"); });
      }).catch(function (e) { err.textContent = V.errorMessage(e); });
    });
  }

  function doClose(btn) {
    V.confirmDialog(t("crm.sj.closeConfirm", { title: SJ.row.title }), t("crm.sj.close"), true).then(function (ok) {
      if (!ok) return;
      V.busy(btn, function () {
        return V.api("POST", "/crm/site-jobs/" + SJ.row.id + "/close", { body: {} }).then(function (row) { return afterChange(row, "crm.sj.closed"); });
      }).catch(function () {});
    });
  }

  // ---------------------------------------------------------------- tab wiring
  function init() {
    fillFilter();
    $("#sj-filters").addEventListener("submit", function (e) {
      e.preventDefault();
      SJ.status = $("#sj-f-status").value;
      SJ.page = 1;
      loadList();
    });
    $("#sj-filters").addEventListener("reset", function () {
      window.setTimeout(function () { SJ.status = ""; SJ.page = 1; fillFilter(); loadList(); }, 0);
    });
    $("#sj-refresh").addEventListener("click", function () { loadList(); });
    $("#sj-new").addEventListener("click", function () { openEditor(null, true); });
    $("#sj-close").addEventListener("click", closeEditor);
    V.onLang(function () {
      SJ.status = $("#sj-f-status").value;
      fillFilter();
      if (!$("#sj-card").hidden && $("#sj-form")) {
        SJ.form = readForm(); // keep what was typed while switching language
        renderEditor();
      }
    });
  }

  A.registerTab("sitejobs", { init: init, load: loadList, visible: function () { return U.canSiteJobs(A.role()); } });
})();
