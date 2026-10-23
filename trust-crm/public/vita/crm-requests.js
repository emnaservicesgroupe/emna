/* Staff console "Employer requests" tab: review employer requests, notes (internal + employer-visible), status
   transitions, a DRAFT site job, and presenting candidates. Presenting always goes through the same steps:
   pick the candidate -> check the share consent (record / withdraw) -> read the EXACT summary the API will freeze
   (the server's preview of the confirmed profile) -> confirm. The employer never receives anything else.
   Every value from employers, candidates and notes is untrusted and rendered as text only. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var U = window.VITA_CRM_UTIL;
  var O = window.VITA_ORGS_UTIL;
  var C = window.VITA_ORGS;
  var t = V.t, h = V.h, $ = V.$;

  var PAGE_SIZE = 25;
  var R = { filters: { status: "", employer_id: "", q: "" }, page: 1, total: 0, loaded: false, employers: null, openId: null, req: null, draft: null, siteJob: null, candidates: null };

  function role() { return A.role(); }
  function statusBadge(s) { return C.badge(O.requestStatusClass(s), t("orgs.rstatus." + s)); }
  function plain(text) { return h("div", { class: "untrusted", text: text }); }

  // ---------------------------------------------------------------- list
  function loadEmployers() {
    if (R.employers) return Promise.resolve();
    return V.api("GET", "/crm/employers?limit=100&offset=0")
      .then(function (r) { R.employers = (r && r.rows) || []; })
      .catch(function () { R.employers = []; });
  }

  function fillFilters() {
    C.fillSelect($("#rq-f-status"), [["", t("crm.req.allStatuses")]].concat(O.REQUEST_STATUSES.map(function (s) { return [s, t("orgs.rstatus." + s)]; })), R.filters.status);
    C.fillSelect($("#rq-f-employer"), [["", t("crm.req.allEmployers")]].concat((R.employers || []).map(function (e) { return [String(e.id), e.name]; })), R.filters.employer_id);
  }

  function readFilters() {
    R.filters = { status: $("#rq-f-status").value, employer_id: $("#rq-f-employer").value, q: $("#rq-f-q").value };
  }

  function loadList() {
    var box = $("#rq-table");
    if (!R.loaded) V.setContent(box, V.loading());
    return loadEmployers().then(function () {
      if (!R.loaded) fillFilters();
      return V.api("GET", "/crm/employer-requests" + O.requestQuery(R.filters, R.page, PAGE_SIZE));
    }).then(function (data) {
      R.loaded = true;
      R.total = data.total;
      var pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      if (R.page > pages) { R.page = pages; return loadList(); }
      renderList(data.rows, pages);
    }).catch(function (err) { V.setContent(box, C.errorBox(err)); V.setContent($("#rq-summary")); V.clear($("#rq-pager")); });
  }

  function renderList(rows, pages) {
    V.setContent($("#rq-summary"), t("crm.req.count", { n: V.fmtNumber(R.total) }));
    var trs = rows.map(function (r) {
      var open = h("button", { type: "button", class: "btn secondary small", text: t("common.open") });
      open.addEventListener("click", function () { openRequest(r.id, true); });
      return h("tr", { class: String(r.id) === String(R.openId) ? "selected" : null },
        h("td", { text: "#" + r.id }),
        h("td", null, h("strong", { text: r.title })),
        h("td", { text: r.employer_name }),
        h("td", { text: V.fmtNumber(r.positions) }),
        h("td", { text: [r.country, r.city].filter(Boolean).join(" · ") || "—" }),
        h("td", null, statusBadge(r.status)),
        h("td", { text: V.fmtNumber(r.presentations_count) }),
        h("td", { text: V.fmtDate(r.created_at) }),
        h("td", null, open)
      );
    });
    V.setContent($("#rq-table"), C.table(
      ["#", t("orgs.f.title"), t("crm.req.employer"), t("orgs.f.positions"), t("employer.requests.where"), t("orgs.f.status"), t("crm.req.presentations"), t("employer.requests.created"), t("common.actions")],
      trs, { empty: t("crm.req.none"), caption: t("crm.req.title") }));
    C.pager($("#rq-pager"), R.page, pages, function (p) { R.page = p; loadList(); });
  }

  // ---------------------------------------------------------------- detail
  function closeRequest() {
    R.openId = null;
    R.req = null;
    R.draft = null;
    R.siteJob = null;
    $("#rq-card").hidden = true;
  }

  function openRequest(id, focus) {
    if (String(R.openId) !== String(id)) { R.draft = null; R.siteJob = null; }
    R.openId = id;
    var card = $("#rq-card");
    card.hidden = false;
    V.setContent($("#rq-body"), V.loading());
    return V.api("GET", "/crm/employer-requests/" + id)
      .then(function (row) {
        if (String(R.openId) !== String(id)) return;
        R.req = row;
        renderRequest();
        if (focus) { card.scrollIntoView({ block: "start" }); $("#rq-card-title").focus(); }
      })
      .catch(function (err) { V.setContent($("#rq-body"), C.errorBox(err)); });
  }

  function refreshRequest() {
    loadList();
    return openRequest(R.openId, false);
  }

  function draftOf(field) {
    return R.draft && Object.prototype.hasOwnProperty.call(R.draft, field) ? R.draft[field] : R.req[field] || "";
  }

  function renderRequest() {
    var req = R.req;
    if (!req) return;
    var me = role();
    var write = U.canOrgsWrite(me);
    V.setContent($("#rq-card-title"), t("crm.req.detail", { id: req.id, title: req.title }));
    var parts = [];
    if (R.siteJob) parts.push(h("div", { class: "notice ok", attrs: { role: "status" } }, h("strong", { text: t("crm.req.siteJobDone", { id: R.siteJob }) }), h("p", { class: "small", text: t("crm.req.siteJobNote") })));

    parts.push(C.kv([
      [t("crm.req.employer"), req.employer_name],
      [t("orgs.f.status"), statusBadge(req.status)],
      [t("orgs.f.title"), req.title],
      [t("orgs.f.positions"), V.fmtNumber(req.positions)],
      [t("employer.requests.where"), [req.country, req.city].filter(Boolean).join(" · ")],
      [t("orgs.f.category"), req.category],
      [t("orgs.f.salary_text"), req.salary_text],
      [t("orgs.f.start_date"), req.start_date ? h("span", { class: "ltr-island", text: req.start_date }) : null],
      [t("orgs.f.description"), req.description ? plain(req.description) : null],
      [t("orgs.f.requirements"), req.requirements ? plain(req.requirements) : null],
      [t("employer.requests.created"), V.fmtDateTime(req.created_at)],
      [t("employer.requests.updated"), V.fmtDateTime(req.updated_at)],
    ]));
    if (!write) parts.push(h("p", { class: "notice info small", text: t("crm.req.readOnly") }));

    // status transitions
    var next = O.nextStatuses(req.status);
    if (write) {
      if (next.length) {
        parts.push(h("h3", { text: t("crm.req.statusTitle") }));
        parts.push(h("div", { class: "btn-row", attrs: { role: "group", "aria-label": t("crm.req.statusTitle") } }, next.map(function (s) {
          var b = h("button", { type: "button", class: "btn" + (s === "declined" || s === "cancelled" ? " danger" : " secondary"), text: t("crm.req.tr." + s) });
          b.addEventListener("click", function () { doStatus(s, b); });
          return b;
        })));
      } else parts.push(h("p", { class: "small muted", text: t("crm.req.finalStatus") }));
    }

    // notes
    parts.push(h("h3", { text: t("crm.req.notes") }));
    var staffNote = h("textarea", { id: "rq-staff-note", attrs: { rows: "3", maxlength: String(O.STAFF_NOTE_MAX) }, value: draftOf("staff_note"), disabled: !write });
    var visNote = h("textarea", { id: "rq-vis-note", attrs: { rows: "3", maxlength: String(O.NOTE_MAX) }, value: draftOf("employer_visible_note"), disabled: !write });
    staffNote.addEventListener("input", function () { R.draft = Object.assign({}, R.draft, { staff_note: staffNote.value }); });
    visNote.addEventListener("input", function () { R.draft = Object.assign({}, R.draft, { employer_visible_note: visNote.value }); });
    var noteErr = h("p", { class: "form-error", attrs: { role: "alert" } });
    var saveNotes = h("button", { type: "button", class: "btn small", text: t("crm.req.saveNotes") });
    saveNotes.addEventListener("click", function () { doNotes(staffNote, visNote, noteErr, saveNotes); });
    parts.push(h("div", { class: "field" },
      h("label", { for: "rq-staff-note", text: t("crm.req.staffNote") }), staffNote,
      h("span", { class: "hint", text: t("crm.req.staffNoteHint", { max: V.fmtNumber(O.STAFF_NOTE_MAX) }) })));
    parts.push(h("div", { class: "field" },
      h("label", { for: "rq-vis-note", text: t("crm.req.visibleNote") }), visNote,
      h("span", { class: "hint", text: t("crm.req.visibleNoteHint", { max: V.fmtNumber(O.NOTE_MAX) }) })));
    parts.push(noteErr);
    if (write) parts.push(h("div", { class: "btn-row" }, saveNotes));

    // draft site job
    if (req.site_job_id) parts.push(h("p", { class: "small", text: t("crm.req.hasSiteJob", { id: req.site_job_id }) }));
    else if (U.canCreateSiteJob(me) && O.canPresentStatus(req.status)) {
      var sj = h("button", { type: "button", class: "btn secondary", text: t("crm.req.createSiteJob") });
      sj.addEventListener("click", function () { doSiteJob(sj); });
      parts.push(h("div", { class: "btn-row" }, sj, h("span", { class: "small muted", text: t("crm.req.createSiteJobHint") })));
    }

    // presentations
    parts.push(h("h3", { text: t("crm.req.presentations") }));
    parts.push(presentationsView(req, write));
    if (U.canPresent(me)) {
      if (O.canPresentStatus(req.status)) {
        var pb = h("button", { type: "button", class: "btn", text: t("crm.req.present") });
        pb.addEventListener("click", function () { openPresent(req, pb); });
        parts.push(h("div", { class: "btn-row" }, pb));
      } else parts.push(h("p", { class: "small muted", text: t("crm.req.presentNeedsStatus") }));
    }

    parts.push(h("h3", { text: t("crm.org.history") }));
    parts.push(C.timelineList(req.timeline, "crm.notes.empty"));
    V.setContent($("#rq-body"), parts);
  }

  function presentationsView(req, write) {
    var list = Array.isArray(req.presentations) ? req.presentations : [];
    if (!list.length) return V.empty(t("crm.req.noPresentations"));
    return C.table(
      [t("crm.req.candidate"), t("orgs.f.status"), t("crm.req.consent"), t("crm.req.response"), t("common.actions")],
      list.map(function (p) {
        var actions = [];
        if (write && p.status !== "withdrawn") {
          var w = h("button", { type: "button", class: "btn secondary small", text: t("crm.req.withdraw") });
          w.addEventListener("click", function () { doWithdraw(p, w); });
          actions.push(w);
        }
        return h("tr", null,
          h("td", null, h("strong", { text: p.candidate_name }), h("div", { class: "small muted", text: "#" + p.candidate_id })),
          h("td", null, C.badge(O.presentationStatusClass(p.status), t("orgs.pstatus." + p.status))),
          h("td", null, C.badge(p.consent_active ? "ok" : "bad", t(p.consent_active ? "crm.req.consentActive" : "crm.req.consentNone"))),
          h("td", null,
            p.responded_at ? h("div", { class: "small", text: V.fmtDateTime(p.responded_at) }) : h("span", { class: "small muted", text: t("crm.req.noResponse") }),
            p.employer_note ? plain(p.employer_note) : null),
          h("td", null, actions));
      }),
      { caption: t("crm.req.presentations") });
  }

  // ---------------------------------------------------------------- actions on the request
  function doStatus(status, btn) {
    V.confirmDialog(t("crm.req.statusConfirm", { status: t("orgs.rstatus." + status) }), t("crm.req.tr." + status), status === "declined" || status === "cancelled").then(function (ok) {
      if (!ok) return;
      V.busy(btn, function () {
        return V.api("PATCH", "/crm/employer-requests/" + R.req.id, { body: { status: status } }).then(function () {
          V.toast(t("crm.req.statusSaved"), "ok");
          V.announce(t("crm.req.statusSaved"));
          return refreshRequest();
        });
      }).catch(function () {});
    });
  }

  function doNotes(staffEl, visEl, err, btn) {
    err.textContent = "";
    var changes = {};
    var cur = R.req;
    var pairs = [["staff_note", staffEl, O.STAFF_NOTE_MAX], ["employer_visible_note", visEl, O.NOTE_MAX]];
    for (var i = 0; i < pairs.length; i++) {
      var value = pairs[i][1].value.trim();
      if (value.length > pairs[i][2]) { err.textContent = C.validationMessage({ field: pairs[i][0] === "staff_note" ? "notes" : "note", error: "long" }); pairs[i][1].focus(); return; }
      var stored = cur[pairs[i][0]] || "";
      if (value !== stored) changes[pairs[i][0]] = value === "" ? null : value;
    }
    if (!Object.keys(changes).length) { V.toast(t("crm.org.nothingToSave")); return; }
    V.busy(btn, function () {
      return V.api("PATCH", "/crm/employer-requests/" + cur.id, { body: changes }).then(function () {
        R.draft = null;
        V.toast(t("crm.req.notesSaved"), "ok");
        return refreshRequest();
      });
    }).catch(function (e) { err.textContent = V.errorMessage(e); });
  }

  function doSiteJob(btn) {
    V.confirmDialog(t("crm.req.createSiteJobConfirm", { title: R.req.title }), t("crm.req.createSiteJob")).then(function (ok) {
      if (!ok) return;
      V.busy(btn, function () {
        return V.api("POST", "/crm/employer-requests/" + R.req.id + "/create-site-job", { body: {} }).then(function (out) {
          R.siteJob = out && out.site_job ? out.site_job.id : null;
          V.toast(t("crm.req.siteJobDone", { id: R.siteJob }), "ok");
          return refreshRequest();
        });
      }).catch(function () {});
    });
  }

  function doWithdraw(p, btn) {
    V.confirmDialog(t("crm.req.withdrawConfirm", { name: p.candidate_name }), t("crm.req.withdraw"), true).then(function (ok) {
      if (!ok) return;
      V.busy(btn, function () {
        return V.api("PATCH", "/crm/presentations/" + p.id + "/withdraw", { body: {} }).then(function () {
          V.toast(t("crm.req.withdrawn"), "ok");
          return refreshRequest();
        });
      }).catch(function () {});
    });
  }

  // ---------------------------------------------------------------- present a candidate (dialog)
  var PD_FIELD_IDS = { candidate_id: "pd-id", staff_note_for_employer: "pd-note", profession: "pd-profession", years_experience: "pd-years", languages: "pd-languages", country_of_residence: "pd-country", availability: "pd-availability" };

  function loadCandidates() {
    if (R.candidates) return Promise.resolve(R.candidates);
    return V.api("GET", "/jobsearch/dashboard")
      .then(function (d) { R.candidates = ((d && d.candidates) || []).map(function (c) { return { id: c.candidateId, name: c.name }; }); return R.candidates; })
      .catch(function () { R.candidates = []; return R.candidates; });
  }

  function openPresent(req, opener) {
    var P = { fresh: false, consents: null, preview: null, previewQuery: null, canRecord: U.canRecordConsent(role()) };

    var search = h("input", { id: "pd-search", type: "search", attrs: { maxlength: "100", autocomplete: "off" } });
    var pick = h("select", { id: "pd-pick" });
    var idInput = h("input", { id: "pd-id", type: "text", attrs: { inputmode: "numeric", maxlength: "15", autocomplete: "off", dir: "ltr" } });
    var check = h("button", { type: "button", class: "btn secondary", text: t("crm.req.pd.check") });
    var inputs = {
      profession: h("input", { id: "pd-profession", type: "text", attrs: { maxlength: "120", autocomplete: "off" } }),
      years_experience: h("input", { id: "pd-years", type: "text", attrs: { inputmode: "numeric", maxlength: "3", autocomplete: "off", dir: "ltr" } }),
      languages: h("input", { id: "pd-languages", type: "text", attrs: { autocomplete: "off" } }),
      country_of_residence: h("input", { id: "pd-country", type: "text", attrs: { maxlength: "100", autocomplete: "off" } }),
      availability: h("input", { id: "pd-availability", type: "text", attrs: { maxlength: "100", autocomplete: "off" } }),
    };
    var note = h("textarea", { id: "pd-note", attrs: { rows: "2", maxlength: String(O.NOTE_MAX) } });
    var state = h("div", { attrs: { "aria-live": "polite" } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var confirm = h("button", { type: "button", class: "btn", text: t("crm.req.pd.confirm", { employer: req.employer_name }), disabled: true });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });

    function field(id, label, control, hint) { return h("div", { class: "field" }, h("label", { for: id, text: label }), control, hint ? h("span", { class: "hint", text: hint }) : null); }

    var form = h("form", { attrs: { novalidate: "" } },
      h("h2", { id: "pd-title", text: t("crm.req.pd.title", { title: req.title }) }),
      h("p", { class: "small", text: t("crm.req.pd.intro", { employer: req.employer_name }) }),
      h("fieldset", null,
        h("legend", { text: t("crm.req.pd.candidate") }),
        field("pd-search", t("crm.req.pd.search"), search),
        field("pd-pick", t("crm.req.pd.pick"), pick),
        field("pd-id", t("crm.req.pd.id"), idInput, t("crm.req.pd.idHint")),
        h("div", { class: "btn-row" }, check)
      ),
      state,
      h("fieldset", null,
        h("legend", { text: t("crm.req.pd.details") }),
        h("p", { class: "small muted", text: t("crm.req.pd.detailsHint") }),
        field("pd-profession", t("orgs.f.profession"), inputs.profession),
        field("pd-years", t("orgs.f.years_experience"), inputs.years_experience),
        field("pd-languages", t("orgs.f.languages"), inputs.languages, t("crm.req.pd.languagesHint")),
        field("pd-country", t("orgs.f.country_of_residence"), inputs.country_of_residence),
        field("pd-availability", t("orgs.f.availability"), inputs.availability),
        field("pd-note", t("orgs.f.staff_note_for_employer"), note, t("crm.req.pd.noteHint", { max: V.fmtNumber(O.NOTE_MAX) }))
      ),
      err,
      h("div", { class: "btn-row" }, confirm, cancel)
    );
    var dlg = h("dialog", { class: "wide", attrs: { "aria-labelledby": "pd-title" } }, form);
    document.body.appendChild(dlg);
    var done = function () {
      if (dlg.open) dlg.close();
      dlg.remove();
      if (opener && opener.isConnected) opener.focus();
    };

    function formValues() {
      return { note: note.value, profession: inputs.profession.value, years_experience: inputs.years_experience.value, languages: inputs.languages.value, country_of_residence: inputs.country_of_residence.value, availability: inputs.availability.value };
    }
    function currentInput() { return O.presentationInput(idInput.value, formValues()); }

    /** The confirm button works only for a fresh preview of exactly the values now in the form. */
    function syncConfirm() {
      var cur = currentInput();
      var fresh = Boolean(P.preview && cur.ok && cur.query === P.previewQuery);
      confirm.disabled = !(fresh && P.preview.presentable);
      return fresh;
    }
    /** Typing in the details re-renders only when the preview turns stale (or fresh again). */
    function onDetailsInput() {
      var fresh = syncConfirm();
      if (P.preview && fresh !== P.fresh) renderState();
    }

    function renderState() {
      var kids = [];
      if (!P.preview) {
        kids.push(h("p", { class: "small muted", text: t("crm.req.pd.choose") }));
      } else {
        kids.push(consentView());
        kids.push(summaryView());
      }
      V.setContent(state, kids);
      P.fresh = syncConfirm();
    }

    function consentView() {
      var active = O.activeConsent(P.consents, req.employer_id);
      var past = (P.consents || []).filter(function (c) { return String(c.employer_id) === String(req.employer_id) && c.withdrawn_at; });
      var box = h("div", { class: "card" }, h("h3", { text: t("crm.req.pd.consentTitle") }));
      if (active) {
        box.appendChild(h("p", null, C.badge("ok", t("crm.req.consentActive")), " ", h("span", { class: "small", text: t("crm.req.pd.consentSince", { date: V.fmtDate(active.recorded_at) }) })));
        box.appendChild(h("p", { class: "small" }, h("strong", { text: t("crm.req.pd.basis") + ": " }), active.basis));
        if (P.canRecord) {
          var wd = h("button", { type: "button", class: "btn secondary small", text: t("crm.req.consent.withdraw") });
          wd.addEventListener("click", function () { withdrawConsent(active, wd); });
          box.appendChild(h("div", { class: "btn-row" }, wd));
        }
      } else {
        box.appendChild(h("p", null, C.badge("bad", t("crm.req.consentNone")), " ", h("span", { class: "small", text: t("crm.req.pd.noConsentHint") })));
        if (P.canRecord) {
          var basis = h("textarea", { id: "pd-basis", attrs: { rows: "2", maxlength: String(O.BASIS_MAX) } });
          var rec = h("button", { type: "button", class: "btn small", text: t("crm.req.consent.record") });
          rec.addEventListener("click", function () { recordConsent(basis, rec); });
          box.appendChild(h("div", { class: "field" }, h("label", { for: "pd-basis", text: t("crm.req.consent.basis") }), basis, h("span", { class: "hint", text: t("crm.req.consent.basisHint", { max: V.fmtNumber(O.BASIS_MAX) }) })));
          box.appendChild(h("div", { class: "btn-row" }, rec));
        } else box.appendChild(h("p", { class: "small muted", text: t("crm.req.consent.noPermission") }));
      }
      if (past.length) {
        box.appendChild(h("p", { class: "small muted", text: t("crm.req.pd.pastConsents", { n: past.length }) }));
      }
      return box;
    }

    function summaryView() {
      var pv = P.preview;
      var box = h("div", { class: "card" }, h("h3", { text: t("crm.req.pd.willShare", { employer: req.employer_name }) }));
      if (!syncConfirm()) {
        // The form changed since the preview was read: never show a summary that is not what would be shared.
        box.appendChild(h("p", { class: "notice info small", text: t("crm.req.pd.stale") }));
        return box;
      }
      if (pv.summary) {
        box.appendChild(C.kv(O.summaryRows(pv.summary).map(function (r) {
          return [t("orgs.summary." + r.key), r.value === null ? h("span", { class: "muted", text: t("employer.pres.notProvided") }) : r.value];
        })));
        box.appendChild(h("p", { class: "small muted", text: t("crm.req.pd.onlyThis") }));
      } else if (pv.needs_summary) {
        box.appendChild(h("p", { class: "notice warn small", text: t("crm.req.pd.needsSummary") }));
      }
      if (!pv.consent_active) box.appendChild(h("p", { class: "notice bad small", text: t("crm.req.pd.blockedConsent") }));
      if (pv.already_presented) box.appendChild(h("p", { class: "notice warn small", text: t("crm.req.pd.blockedDuplicate") }));
      if (!O.canPresentStatus(pv.request_status)) box.appendChild(h("p", { class: "notice warn small", text: t("crm.req.presentNeedsStatus") }));
      return box;
    }

    /** Loads the consents of the chosen candidate and the server's preview of the summary. */
    function runCheck() {
      err.textContent = "";
      var input = currentInput();
      if (!input.ok) { C.flagField(input, function (f) { return PD_FIELD_IDS[f] || "pd-id"; }, err); return Promise.resolve(); }
      var cid = input.body.candidate_id;
      return V.busy(check, function () {
        return Promise.all([
          V.api("GET", "/crm/candidates/" + cid + "/share-consents"),
          V.api("GET", "/crm/employer-requests/" + req.id + "/presentation-preview?" + input.query),
        ]).then(function (res) {
          P.consents = res[0].rows;
          P.preview = res[1];
          P.previewQuery = input.query;
          renderState();
        });
      }).catch(function (e) {
        P.preview = null;
        P.previewQuery = null;
        err.textContent = e && e.status === 404 ? t("crm.req.pd.notFound") : V.errorMessage(e);
        renderState();
      });
    }

    function recordConsent(basis, btn) {
      err.textContent = "";
      var built = O.consentPayload(req.employer_id, basis.value);
      if (!built.ok) { C.flagField(built, function () { return "pd-basis"; }, err); return; }
      var cid = P.preview.candidate_id;
      V.busy(btn, function () {
        return V.api("POST", "/crm/candidates/" + cid + "/share-consents", { body: built.payload }).then(function () {
          V.toast(t("crm.req.consent.recorded"), "ok");
          V.announce(t("crm.req.consent.recorded"));
          return runCheck();
        });
      }).catch(function (e) { err.textContent = V.errorMessage(e); });
    }

    function withdrawConsent(consent, btn) {
      V.confirmDialog(t("crm.req.consent.withdrawConfirm", { employer: req.employer_name }), t("crm.req.consent.withdraw"), true).then(function (ok) {
        if (!ok) return;
        var cid = P.preview.candidate_id;
        V.busy(btn, function () {
          return V.api("DELETE", "/crm/candidates/" + cid + "/share-consents/" + consent.id).then(function () {
            V.toast(t("crm.req.consent.withdrawn"), "ok");
            V.announce(t("crm.req.consent.withdrawn"));
            return runCheck();
          });
        }).catch(function (e) { err.textContent = V.errorMessage(e); });
      });
    }

    // candidate picker: filter the staff-visible candidate list (the console's existing lookup) or type an id
    function fillPick() {
      var needle = search.value.trim().toLowerCase();
      var list = (R.candidates || []).filter(function (c) { return !needle || String(c.name).toLowerCase().indexOf(needle) >= 0 || String(c.id).indexOf(needle) === 0; }).slice(0, 50);
      C.fillSelect(pick, [["", list.length ? t("crm.req.pd.pickPlaceholder") : t("crm.req.pd.noMatches")]].concat(list.map(function (c) { return [String(c.id), c.name + " (#" + c.id + ")"]; })), "");
    }
    function invalidate() {
      var had = P.preview !== null;
      P.preview = null;
      P.previewQuery = null;
      if (had) renderState();
      else P.fresh = syncConfirm();
    }

    search.addEventListener("input", fillPick);
    pick.addEventListener("change", function () { if (pick.value) { idInput.value = pick.value; invalidate(); } });
    idInput.addEventListener("input", function () { P.consents = null; invalidate(); });
    [note, inputs.profession, inputs.years_experience, inputs.languages, inputs.country_of_residence, inputs.availability].forEach(function (el) {
      el.addEventListener("input", onDetailsInput);
    });
    check.addEventListener("click", function () { runCheck(); });
    cancel.addEventListener("click", done);
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); done(); });
    form.addEventListener("submit", function (e) { e.preventDefault(); });
    confirm.addEventListener("click", function () {
      err.textContent = "";
      var input = currentInput();
      if (!input.ok) { C.flagField(input, function (f) { return PD_FIELD_IDS[f] || "pd-id"; }, err); return; }
      if (!syncConfirm()) { err.textContent = t("crm.req.pd.stale"); return; }
      V.busy(confirm, function () {
        return V.api("POST", "/crm/employer-requests/" + req.id + "/presentations", { body: input.body }).then(function () {
          done();
          V.toast(t("crm.req.presented"), "ok");
          V.announce(t("crm.req.presented"));
          return refreshRequest();
        });
      }).catch(function (e) { err.textContent = V.errorMessage(e); });
    });

    renderState();
    loadCandidates().then(fillPick);
    fillPick();
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    search.focus();
  }

  // ---------------------------------------------------------------- tab wiring
  function init() {
    fillFilters();
    $("#rq-filters").addEventListener("submit", function (e) {
      e.preventDefault();
      readFilters();
      R.page = 1;
      loadList();
    });
    $("#rq-filters").addEventListener("reset", function () {
      window.setTimeout(function () { R.filters = { status: "", employer_id: "", q: "" }; R.page = 1; fillFilters(); loadList(); }, 0);
    });
    $("#rq-refresh").addEventListener("click", function () { loadList(); });
    $("#rq-close").addEventListener("click", closeRequest);
    V.onLang(function () {
      readFilters();
      fillFilters();
      if (R.req && !$("#rq-card").hidden) renderRequest();
    });
  }

  A.registerTab("employerRequests", { init: init, load: loadList, visible: function () { return U.canOrgsRead(role()); } });
})();
