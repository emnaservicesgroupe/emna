/* CRM "Leads" tab: filterable list, detail with notes/timeline, status, assignment and the Convert dialog.
   Everything that comes from the public website (names, messages, notes) is untrusted and rendered as text only.
   The UI hides actions a role cannot take (crm-util.js mirrors the permissions); the server decides on every call. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var U = window.VITA_CRM_UTIL;
  var C = window.VITA_CRM;
  var t = V.t, h = V.h, $ = V.$;

  var PAGE_SIZE = 25;
  var STATUS_CLASS = { new: "info", contacted: "neutral", qualified: "gold", converted: "ok", rejected: "neutral", spam: "bad" };
  var L = { filters: { status: "", kind: "", q: "" }, page: 1, total: 0, staff: null, lead: null, openId: null, result: null, draftNote: "" };

  function role() { return A.role(); }

  function statusBadge(status) {
    return h("span", { class: "badge " + (STATUS_CLASS[status] || "neutral"), text: t("crm.status." + status) });
  }

  function assignedLabel(id) {
    if (id === null || id === undefined) return t("crm.detail.unassigned");
    var me = V.getSession();
    if (me && Number(me.userId) === Number(id)) return t("crm.detail.you");
    var s = (L.staff || []).filter(function (x) { return x.id === id; })[0];
    return s ? s.full_name : "#" + id;
  }

  // ---------------------------------------------------------------- list
  function fillFilters() {
    A.fillSelect($("#leads-f-status"), [["", t("crm.leads.allStatuses")]].concat(U.LEAD_STATUSES.map(function (s) { return [s, t("crm.status." + s)]; })), L.filters.status);
    A.fillSelect($("#leads-f-kind"), [["", t("crm.leads.allKinds")]].concat(U.LEAD_KINDS.map(function (k) { return [k, t("crm.kind." + k)]; })), L.filters.kind);
  }

  function readFilters() {
    L.filters = { status: $("#leads-f-status").value, kind: $("#leads-f-kind").value, q: $("#leads-f-q").value };
  }

  function loadStaff() {
    if (!U.canAssign(role()) || L.staff) return Promise.resolve();
    return V.api("GET", "/crm/staff").then(function (r) { L.staff = (r && r.rows) || []; }).catch(function () { L.staff = null; });
  }

  function loadLeads() {
    var box = $("#leads-table");
    if (!L.loaded) V.setContent(box, V.loading());
    return Promise.all([V.api("GET", "/crm/leads" + U.leadQuery(L.filters, L.page, PAGE_SIZE)), loadStaff()])
      .then(function (res) {
        var data = res[0];
        L.loaded = true;
        L.total = data.total;
        var pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
        if (L.page > pages) { L.page = pages; return loadLeads(); }
        renderList(data.rows, pages);
      })
      .catch(function (err) { V.setContent(box, A.errorBox(err)); V.setContent($("#leads-summary")); V.clear($("#leads-pager")); });
  }

  function renderList(rows, pages) {
    V.setContent($("#leads-summary"), t("crm.leads.count", { n: V.fmtNumber(L.total) }));
    var trs = rows.map(function (r) {
      var open = h("button", { type: "button", class: "btn secondary small", text: t("common.open") });
      open.addEventListener("click", function () { openLead(r.id, true); });
      return h("tr", { class: r.id === L.openId ? "selected" : null },
        h("td", { text: V.fmtDate(r.created_at) }),
        h("td", null, h("strong", { text: r.name }), r.company ? h("div", { class: "small muted", text: r.company }) : null),
        h("td", { text: t("crm.kind." + r.kind) }),
        h("td", null, statusBadge(r.status)),
        h("td", null, r.email ? h("div", { text: r.email }) : null, r.phone ? h("div", { class: "small ltr-island", text: r.phone }) : null, !r.email && !r.phone ? "—" : null),
        h("td", { text: [r.country, r.profession].filter(Boolean).join(" · ") || "—" }),
        h("td", { text: assignedLabel(r.assigned_to) }),
        h("td", null, open)
      );
    });
    V.setContent($("#leads-table"), A.table(
      [t("crm.f.created"), t("crm.f.name"), t("crm.f.kind"), t("crm.f.status"), t("crm.f.contact"), t("crm.f.where"), t("crm.f.assigned"), t("common.actions")],
      trs, { empty: t("crm.leads.none"), caption: t("crm.leads.title") }));
    renderPager($("#leads-pager"), L.page, pages, function (p) { L.page = p; loadLeads(); });
  }

  /** Previous / next pager shared with the site jobs tab. */
  function renderPager(box, page, pages, go) {
    V.clear(box);
    if (pages <= 1) return;
    var prev = h("button", { type: "button", class: "btn secondary small", text: t("common.prev"), disabled: page <= 1 });
    var next = h("button", { type: "button", class: "btn secondary small", text: t("common.next"), disabled: page >= pages });
    prev.addEventListener("click", function () { go(page - 1); });
    next.addEventListener("click", function () { go(page + 1); });
    box.appendChild(prev);
    box.appendChild(h("span", { class: "small", text: t("common.pageOf", { page: page, pages: pages }) }));
    box.appendChild(next);
  }

  // ---------------------------------------------------------------- detail
  function openLead(id, focus) {
    if (L.openId !== id) { L.result = null; L.draftNote = ""; }
    L.openId = id;
    var card = $("#lead-card");
    card.hidden = false;
    V.setContent($("#lead-body"), V.loading());
    return Promise.all([V.api("GET", "/crm/leads/" + id), loadStaff()])
      .then(function (res) {
        if (L.openId !== id) return;
        L.lead = res[0];
        renderLead();
        if (focus) { card.scrollIntoView({ block: "start" }); $("#lead-title").focus(); }
      })
      .catch(function (err) { V.setContent($("#lead-body"), A.errorBox(err)); });
  }

  function closeLead() {
    L.openId = null;
    L.lead = null;
    L.result = null;
    $("#lead-card").hidden = true;
  }

  function refreshLead() {
    loadLeads();
    return openLead(L.openId, false);
  }

  function renderLead() {
    var lead = L.lead;
    if (!lead) return;
    V.setContent($("#lead-title"), lead.name);
    var me = role();
    var canWrite = U.can(me, "leads:write");
    var parts = [];
    if (L.result) parts.push(resultNotice(L.result));

    parts.push(A.kv([
      [t("crm.f.kind"), t("crm.kind." + lead.kind)],
      [t("crm.f.status"), statusBadge(lead.status)],
      [t("crm.f.name"), lead.name],
      [t("crm.f.email"), lead.email],
      [t("crm.f.phone"), lead.phone ? h("span", { class: "ltr-island", text: lead.phone }) : null],
      [t("crm.f.country"), lead.country],
      [t("crm.f.profession"), lead.profession],
      [t("crm.f.company"), lead.company],
      [t("crm.f.message"), lead.message ? h("div", { class: "untrusted", text: lead.message }) : null],
      [t("crm.f.lang"), lead.lang],
      [t("crm.f.consent"), lead.consent_at ? t("crm.detail.consent", { date: V.fmtDateTime(lead.consent_at), version: lead.consent_text_version || "—" }) : t("crm.detail.noConsent")],
      [t("crm.f.source"), lead.source],
      [t("crm.f.assigned"), assignedLabel(lead.assigned_to)],
      [t("crm.f.candidate"), lead.candidate_id ? "#" + lead.candidate_id : null],
      [t("crm.f.created"), V.fmtDateTime(lead.created_at)],
      [t("crm.f.updated"), V.fmtDateTime(lead.updated_at)],
    ]));

    if (!canWrite) parts.push(h("p", { class: "notice info small", text: t("crm.detail.noWritePerm") }));
    else parts.push(statusForm(lead));
    if (U.canAssign(me)) parts.push(assignForm(lead));
    if (U.canConvert(me) && U.leadCanConvert(lead)) {
      var conv = h("button", { type: "button", class: "btn", text: t("crm.convert.button") });
      conv.addEventListener("click", function () { openConvert(lead, conv); });
      parts.push(h("div", { class: "btn-row" }, conv));
    } else if (lead.kind !== "candidate" && lead.status !== "converted") {
      parts.push(h("p", { class: "small muted", text: t("crm.convert.onlyCandidate") }));
    }

    if (lead.candidate_id) {
      var box = h("div", { class: "card" });
      parts.push(box);
      C.candidateSection(box, lead.candidate_id, { stage: L.result && L.result.candidate ? L.result.candidate.crm_stage : undefined });
    }

    parts.push(h("h3", { text: t("crm.notes.title") }));
    if (canWrite) parts.push(noteForm(lead));
    parts.push(C.timelineList(lead.timeline, "crm.notes.empty"));
    V.setContent($("#lead-body"), parts);
  }

  function statusForm(lead) {
    var converted = lead.status === "converted";
    var items = U.LEAD_SETTABLE.map(function (s) { return [s, t("crm.status." + s)]; });
    if (converted) items.push(["converted", t("crm.status.converted")]);
    var sel = h("select", { id: "lead-status", disabled: converted });
    A.fillSelect(sel, items, lead.status);
    var save = h("button", { type: "button", class: "btn small", text: t("common.save"), disabled: converted });
    save.addEventListener("click", function () {
      if (sel.value === lead.status) return;
      V.busy(save, function () {
        return V.api("PATCH", "/crm/leads/" + lead.id, { body: { status: sel.value } }).then(function () {
          V.toast(t("crm.detail.statusSaved"), "ok");
          return refreshLead();
        });
      }).catch(function () {});
    });
    return h("div", { class: "field" },
      h("label", { for: "lead-status", text: t("crm.detail.statusLabel") }),
      h("div", { class: "btn-row" }, sel, save),
      converted ? h("span", { class: "hint", text: t("crm.detail.statusConverted") }) : null
    );
  }

  function assignForm(lead) {
    var staff = L.staff;
    var field = h("div", { class: "field" });
    if (!staff) return h("p", { class: "small muted", text: t("crm.detail.staffUnavailable") });
    var items = [["", t("crm.detail.unassigned")]].concat(staff.map(function (s) { return [String(s.id), s.full_name + " (" + t("role." + s.role) + ")"]; }));
    var sel = h("select", { id: "lead-assign" });
    A.fillSelect(sel, items, lead.assigned_to === null ? "" : String(lead.assigned_to));
    var save = h("button", { type: "button", class: "btn small", text: t("crm.detail.assignSave") });
    save.addEventListener("click", function () {
      V.busy(save, function () {
        return V.api("PATCH", "/crm/leads/" + lead.id, { body: { assigned_to: sel.value === "" ? null : Number(sel.value) } }).then(function () {
          V.toast(t("crm.detail.assignSaved"), "ok");
          return refreshLead();
        });
      }).catch(function () {});
    });
    field.appendChild(h("label", { for: "lead-assign", text: t("crm.detail.assignLabel") }));
    field.appendChild(h("div", { class: "btn-row" }, sel, save));
    field.appendChild(h("span", { class: "hint", text: t("crm.detail.assignHint") }));
    return field;
  }

  function noteForm(lead) {
    var ta = h("textarea", { id: "lead-note", attrs: { maxlength: String(U.NOTE_MAX), rows: "3" }, value: L.draftNote });
    ta.addEventListener("input", function () { L.draftNote = ta.value; });
    var add = h("button", { type: "button", class: "btn small", text: t("crm.notes.add") });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    add.addEventListener("click", function () {
      var text = ta.value.trim();
      err.textContent = "";
      if (!text) { err.textContent = t("crm.notes.required"); ta.setAttribute("aria-invalid", "true"); ta.focus(); return; }
      ta.removeAttribute("aria-invalid");
      V.busy(add, function () {
        return V.api("POST", "/crm/leads/" + lead.id + "/notes", { body: { text: text } }).then(function () {
          L.draftNote = "";
          V.toast(t("crm.notes.saved"), "ok");
          return refreshLead();
        });
      }).catch(function () {});
    });
    return h("div", { class: "field" },
      h("label", { for: "lead-note", text: t("crm.notes.label") }),
      ta,
      h("span", { class: "hint", text: t("crm.notes.limit", { max: V.fmtNumber(U.NOTE_MAX) }) }),
      err,
      h("div", { class: "btn-row" }, add)
    );
  }

  // ---------------------------------------------------------------- convert
  function resultNotice(res) {
    var c = res.candidate || {};
    var kids = [h("strong", { text: t(res.created ? "crm.convert.done" : "crm.convert.already", { id: c.id }) })];
    if (res.portal) {
      kids.push(h("p", { class: "small", text: res.portal.inviteSent ? t("crm.convert.inviteSent", { email: L.lead && L.lead.email ? L.lead.email : "" }) : t("crm.convert.inviteFailed") }));
    } else if (res.created) {
      kids.push(h("p", { class: "small", text: t("crm.convert.noPortal") }));
    }
    var warn = res.portal && !res.portal.inviteSent;
    return h("div", { class: "notice " + (warn ? "warn" : "ok"), attrs: { role: "status" } }, kids);
  }

  function convertError(err) {
    if (err && err.status === 409) {
      if (/passport/i.test(err.message || "")) return t("crm.convert.dupPassport");
      return t("crm.convert.conflict") + (err.message ? " — " + err.message : "");
    }
    return V.errorMessage(err);
  }

  function openConvert(lead, opener) {
    var hasEmail = Boolean(lead.email);
    var passport = h("input", { id: "cv-passport", type: "text", attrs: { maxlength: "64", autocomplete: "off", required: "" } });
    var fullName = h("input", { id: "cv-name", type: "text", attrs: { maxlength: "200", autocomplete: "off" }, value: lead.name });
    var nat = h("input", { id: "cv-nat", type: "text", attrs: { maxlength: "100", autocomplete: "off" } });
    var portal = h("input", { id: "cv-portal", type: "checkbox", disabled: !hasEmail });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var submit = h("button", { type: "submit", class: "btn", text: t("crm.convert.submit") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var form = h("form", { attrs: { novalidate: "" } },
      h("h2", { id: "cv-title", text: t("crm.convert.title") }),
      h("p", { class: "small", text: t("crm.convert.intro", { name: lead.name }) }),
      h("div", { class: "field" }, h("label", { for: "cv-passport", text: t("crm.convert.passport") }), passport, h("span", { class: "hint", text: t("crm.convert.passportHint") })),
      h("div", { class: "field" }, h("label", { for: "cv-name", text: t("crm.convert.fullName") }), fullName),
      h("div", { class: "field" }, h("label", { for: "cv-nat", text: t("crm.convert.nationality") }), nat),
      h("div", { class: "field" },
        h("div", { class: "check" }, portal, h("label", { for: "cv-portal", text: t("crm.convert.portal") })),
        h("span", { class: "hint", text: hasEmail ? t("crm.convert.portalHint", { email: lead.email }) : t("crm.convert.portalNeedsEmail") })
      ),
      err,
      h("div", { class: "btn-row" }, submit, cancel)
    );
    var dlg = h("dialog", { attrs: { "aria-labelledby": "cv-title" } }, form);
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
      var built = U.convertPayload({ passport_number: passport.value, full_name: fullName.value, nationality: nat.value, portal: portal.checked }, lead);
      if (!built.ok) {
        err.textContent = t(built.error === "passport" ? "crm.convert.passportRequired" : "crm.convert.fieldLong");
        passport.setAttribute("aria-invalid", "true");
        (built.error === "passport" || built.error === "passport_long" ? passport : fullName).focus();
        return;
      }
      passport.removeAttribute("aria-invalid");
      V.busy(submit, function () {
        return V.api("POST", "/crm/leads/" + lead.id + "/convert", { body: built.payload })
          .then(function (out) {
            L.result = out;
            done();
            V.announce(t(out.created ? "crm.convert.done" : "crm.convert.already", { id: out.candidate && out.candidate.id }));
            return refreshLead();
          })
          .catch(function (e2) {
            err.textContent = convertError(e2);
            throw e2;
          });
      }).catch(function () {});
    });
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    passport.focus();
  }

  // ---------------------------------------------------------------- tab wiring
  function init() {
    fillFilters();
    $("#leads-filters").addEventListener("submit", function (e) {
      e.preventDefault();
      readFilters();
      L.page = 1;
      loadLeads();
    });
    $("#leads-filters").addEventListener("reset", function () {
      window.setTimeout(function () { L.filters = { status: "", kind: "", q: "" }; L.page = 1; fillFilters(); loadLeads(); }, 0);
    });
    $("#leads-refresh").addEventListener("click", function () { loadLeads(); });
    $("#lead-close").addEventListener("click", closeLead);
    V.onLang(function () {
      readFilters();
      fillFilters();
      if (L.lead) renderLead();
    });
  }

  A.registerTab("leads", { init: init, load: loadLeads, visible: function () { return U.can(role(), "leads:read"); } });
  C.renderPager = renderPager;
})();
