/* Canada service layer, staff console: employer detail dialog (record, contact history, administrator edit), the do-not-contact list
   (suppressions tab) and the extra sections of the application drawer (vacancy classification, match decision, outreach checks and
   employer history). All server text is rendered as text only; source links are shown only when they are http(s) URLs. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var U = window.VITA_CANADA_UTIL;
  var C = window.VITA_CANADA;
  var t = V.t, h = V.h, $ = V.$;

  // ================================================================ employer history panel
  /** Counts, last contact and the "other candidates" number; the rows are the caller's own scope only. */
  function historyPanel(hist) {
    var s = U.historySummary(hist);
    var rows = Array.isArray(hist && hist.applications) ? hist.applications : [];
    var out = [
      h("dl", { class: "kv" },
        h("dt", { text: t("canada.hist.applications") }), h("dd", { text: V.fmtNumber(s.applications) }),
        h("dt", { text: t("canada.hist.sent") }), h("dd", { text: V.fmtNumber(s.sent) }),
        h("dt", { text: t("canada.hist.replies") }), h("dd", { text: V.fmtNumber(s.replies) }),
        h("dt", { text: t("canada.hist.last") }), h("dd", { text: s.lastContactAt ? V.fmtDateTime(s.lastContactAt) : t("canada.hist.never") }),
        h("dt", { text: t("canada.hist.others") }), h("dd", { text: V.fmtNumber(s.others) })),
      s.others > 0 ? h("p", { class: "notice warn small", text: t("canada.hist.othersWarning", { n: V.fmtNumber(s.others) }) }) : null,
    ];
    if (hist && Array.isArray(hist.applications)) {
      out.push(rows.length ? h("ul", { class: "cx-list" }, rows.slice(0, 25).map(function (a) {
        return h("li", { class: "cx-item" },
          h("p", null, h("strong", { text: a.candidateName || "#" + a.candidateId }), " · ", a.jobTitle || "—", " ", V.statusBadge(a.status)),
          h("p", { class: "small muted", text: V.fmtDateTime(a.createdAt) + " · " + t("canada.hist.rowCounts", { sent: V.fmtNumber((a.submissions || []).length), msgs: V.fmtNumber((a.messages || []).length) }) }));
      })) : V.empty(t("canada.hist.none")));
    }
    out.push(h("p", { class: "small muted", text: t("canada.hist.scopeNote") }));
    return out;
  }

  // ================================================================ employer detail dialog
  C.openEmployer = function (employerId) {
    var body = h("div", null, V.loading());
    var close = h("button", { type: "button", class: "btn secondary", text: t("common.close") });
    var dlg = C.modal(t("canada.emp.title"), [body, h("div", { class: "btn-row" }, close)], { wide: true });
    close.addEventListener("click", dlg.close);
    Promise.all([
      V.api("GET", "/jobsearch/employers/" + employerId),
      V.api("GET", "/jobsearch/employers/" + employerId + "/history").catch(function () { return null; }),
    ]).then(function (r) {
      var e = r[0];
      var urls = U.safeUrls(e.sourceUrls);
      var admin = U.canEditEmployer(C.role()) && e.canEdit === true;
      var actions = h("div", { class: "btn-row" });
      if (U.canAddSuppression(C.role()) && (e.domain || e.verifiedContactEmail)) {
        var sup = h("button", { type: "button", class: "btn secondary small", text: t("canada.supp.addForEmployer") });
        sup.addEventListener("click", function () { openAddSuppression({ kind: e.domain ? "domain" : "email", value: e.domain || e.verifiedContactEmail, employerId: e.id }, function () { dlg.close(); C.openEmployer(employerId); }); });
        actions.appendChild(sup);
      }
      var parts = [
        h("h3", { text: e.name }),
        h("p", null, C.chip("canada.empstatus." + (U.EMPLOYER_STATUSES.indexOf(e.status) >= 0 ? e.status : "new"), e.status === "opted_out" || e.status === "blocked" ? "bad" : e.status === "verified" ? "ok" : "neutral"), " ",
          e.suppressed ? C.chip("canada.emp.suppressed", "bad") : null),
        e.status === "opted_out" || e.suppressed ? h("p", { class: "notice bad small", text: t("canada.emp.optedOutNote") }) : null,
        A.kv([
          [t("dir.domain"), e.domain ? h("span", { class: "ltr-island", text: e.domainUnicode && e.domainUnicode !== e.domain ? e.domainUnicode + " (" + e.domain + ")" : e.domain }) : null],
          [t("dir.contact"), e.verifiedContactEmail ? h("span", { class: "ltr-island mono", text: e.verifiedContactEmail }) : null],
          [t("canada.emp.province"), e.province ? t("canada.province." + e.province) : null],
          [t("canada.emp.city"), e.city],
          [t("canada.emp.industry"), e.industry],
          [t("canada.emp.phone"), e.phone ? h("span", { class: "ltr-island", text: e.phone }) : null],
          [t("canada.emp.recruiter"), e.recruiterContactName],
          [t("canada.emp.eligibility"), e.eligibilityNote],
          [t("canada.emp.verifiedAt"), e.lastVerifiedAt ? V.fmtDateTime(e.lastVerifiedAt) : null],
          [t("canada.emp.sources"), urls.length ? h("ul", { class: "compact" }, urls.map(function (u) { return h("li", null, V.safeLink(u, u)); })) : null],
          admin ? [t("canada.emp.notes"), e.notes] : null,
        ]),
        actions,
        admin ? null : h("p", { class: "small muted", text: t("canada.emp.adminOnlyEdit") }),
        h("h4", { text: t("canada.hist.title") }),
        r[1] ? historyPanel(r[1]) : h("p", { class: "small muted", text: t("canada.hist.unavailable") }),
      ];
      if (admin) parts.push(h("h4", { text: t("canada.emp.edit") }), employerForm(e, function () { dlg.close(); C.openEmployer(employerId); }));
      V.setContent(body, parts);
    }).catch(function (err) { V.setContent(body, A.errorBox(err)); });
  };

  function employerForm(e, after) {
    var p = "cx-emp-" + e.id + "-";
    var prov = C.select(p + "prov", C.items("canada.province.", U.PROVINCES, t("canada.notSet")), e.province || "");
    var city = h("input", { id: p + "city", type: "text", value: e.city || "", attrs: { maxlength: "100", autocomplete: "off" } });
    var industry = h("input", { id: p + "industry", type: "text", value: e.industry || "", attrs: { maxlength: "100", autocomplete: "off" } });
    var phone = h("input", { id: p + "phone", type: "tel", value: e.phone || "", attrs: { maxlength: "30", autocomplete: "off", dir: "ltr" } });
    var recruiter = h("input", { id: p + "rec", type: "text", value: e.recruiterContactName || "", attrs: { maxlength: "120", autocomplete: "off" } });
    var status = C.select(p + "status", C.items("canada.empstatus.", U.EMPLOYER_STATUSES), e.status || "new");
    var urls = h("textarea", { id: p + "urls", attrs: { rows: "3", dir: "ltr", maxlength: "10000" } });
    urls.value = U.safeUrls(e.sourceUrls).join("\n");
    var elig = h("textarea", { id: p + "elig", attrs: { rows: "2", maxlength: "1000" } });
    elig.value = e.eligibilityNote || "";
    var notes = h("textarea", { id: p + "notes", attrs: { rows: "3", maxlength: "4000" } });
    notes.value = e.notes || "";
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var save = h("button", { type: "submit", class: "btn small", text: t("common.save") });
    var form = h("form", { class: "notice info", attrs: { novalidate: "" } },
      h("div", { class: "inline-fields" },
        C.field(p + "prov", t("canada.emp.province"), prov), C.field(p + "city", t("canada.emp.city"), city), C.field(p + "industry", t("canada.emp.industry"), industry),
        C.field(p + "phone", t("canada.emp.phone"), phone), C.field(p + "rec", t("canada.emp.recruiter"), recruiter), C.field(p + "status", t("canada.emp.status"), status)),
      C.field(p + "urls", t("canada.emp.sources"), urls, t("canada.emp.sourcesHint")),
      C.field(p + "elig", t("canada.emp.eligibility"), elig, t("canada.emp.eligibilityHint")),
      C.field(p + "notes", t("canada.emp.notes"), notes, t("canada.emp.notesHint")),
      err, save);
    var fields = { province: prov, city: city, industry: industry, phone: phone, recruiterContactName: recruiter, status: status, sourceUrls: urls, sourceUrlsMany: urls, eligibilityNote: elig, notes: notes };
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      err.textContent = "";
      C.unflag(form);
      var built = U.employerPatch({ province: prov.value, city: city.value, industry: industry.value, phone: phone.value, recruiterContactName: recruiter.value, status: status.value, sourceUrls: urls.value, eligibilityNote: elig.value, notes: notes.value }, e);
      if (!built.ok) {
        if (built.error === "nothing") return V.toast(t("canada.err.nothing"), "bad");
        return C.flag(fields[built.error], err, built.error === "sourceUrls" ? t("canada.err.sourceUrls", { line: built.line }) : C.errText(built.error));
      }
      V.busy(save, function () {
        return V.api("PATCH", "/jobsearch/employers/" + e.id, { body: built.patch }).then(function () {
          V.toast(t("canada.emp.saved"), "ok");
          after();
        });
      }).catch(function (e2) { err.textContent = C.refusal(e2); });
    });
    return form;
  }

  A.onEmployerRow(function (e) {
    var b = h("button", { type: "button", class: "btn secondary small", text: t("canada.emp.details"), attrs: { "aria-label": t("canada.emp.detailsNamed", { name: e.name }) } });
    b.addEventListener("click", function () { C.openEmployer(e.id); });
    return b;
  });

  // ================================================================ do-not-contact list
  var S = { page: 1, filters: { kind: "", source: "", q: "" }, built: false };

  function openAddSuppression(preset, after) {
    var o = preset || {};
    var kind = C.select("cx-sp-kind", C.items("canada.supp.kind.", U.SUPPRESSION_KINDS), o.kind || "email");
    var value = h("input", { id: "cx-sp-value", type: "text", value: o.value || "", attrs: { maxlength: "300", autocomplete: "off", dir: "ltr" } });
    var reason = h("textarea", { id: "cx-sp-reason", attrs: { rows: "2", maxlength: "500" } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: t("canada.supp.add") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var dlg = C.modal(t("canada.supp.addTitle"), [
      h("p", { class: "small", text: t("canada.supp.addIntro") }),
      C.field("cx-sp-kind", t("canada.supp.kind"), kind), C.field("cx-sp-value", t("canada.supp.value"), value, t("canada.supp.valueHint")),
      C.field("cx-sp-reason", t("canada.supp.reason"), reason, t("canada.supp.reasonHint")), err, h("div", { class: "btn-row" }, go, cancel)]);
    var state = { sending: false };
    cancel.addEventListener("click", dlg.close);
    dlg.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      C.unflag(dlg.form);
      var built = U.suppressionPayload({ kind: kind.value, value: value.value, reason: reason.value });
      if (!built.ok) return C.flag(built.error === "reason_long" ? reason : value, err, C.errText("supp_" + built.error));
      if (o.employerId) built.payload.employerId = o.employerId;
      C.submit(go, state, function () {
        return V.api("POST", "/jobsearch/suppressions", { body: built.payload }).then(function (row) {
          dlg.close();
          V.toast(t("canada.supp.added"), "ok");
          if (after) after(row);
        });
      }).catch(function (e2) { err.textContent = C.refusal(e2); });
    });
    value.focus();
  }

  function openRemoveSuppression(row, after) {
    var reason = h("textarea", { id: "cx-spr-reason", attrs: { rows: "3", maxlength: "500" } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn danger", text: t("canada.supp.remove") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var dlg = C.modal(t("canada.supp.removeTitle"), [
      h("p", { class: "notice warn small", text: t("canada.supp.removeWarning", { value: row.value }) }),
      C.field("cx-spr-reason", t("canada.supp.removeReason"), reason, t("canada.supp.removeReasonHint")), err, h("div", { class: "btn-row" }, go, cancel)]);
    var state = { sending: false };
    cancel.addEventListener("click", dlg.close);
    dlg.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      var r = U.suppressionRemovalReason(reason.value);
      if (!r.ok) return C.flag(reason, err, C.errText("supp_remove_" + r.error));
      C.submit(go, state, function () {
        return V.api("DELETE", "/jobsearch/suppressions/" + row.id, { body: { reason: r.reason } }).then(function () {
          dlg.close();
          V.toast(t("canada.supp.removed"), "ok");
          after();
        });
      }).catch(function (e2) { err.textContent = C.refusal(e2); });
    });
    reason.focus();
  }

  function buildSuppressionsPanel() {
    var panel = $("#panel-suppressions");
    if (!panel || S.built) return;
    S.built = true;
    var kind = C.select("cx-sf-kind", C.items("canada.supp.kind.", U.SUPPRESSION_KINDS, t("canada.supp.allKinds")), "");
    var source = C.select("cx-sf-source", C.items("canada.supp.source.", U.SUPPRESSION_SOURCES, t("canada.supp.allSources")), "");
    var q = h("input", { id: "cx-sf-q", type: "search", attrs: { maxlength: "100", autocomplete: "off" } });
    var form = h("form", { class: "filters", attrs: { novalidate: "" } },
      C.field("cx-sf-kind", t("canada.supp.kind"), kind), C.field("cx-sf-source", t("canada.supp.source"), source), C.field("cx-sf-q", t("canada.supp.search"), q),
      h("div", { class: "field btn-row" }, h("button", { type: "submit", class: "btn", text: t("canada.supp.filter") })));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      S.filters = { kind: kind.value, source: source.value, q: q.value };
      S.page = 1;
      loadSuppressions();
    });
    var add = h("button", { type: "button", class: "btn small", id: "cx-sp-new", text: t("canada.supp.add"), hidden: !U.canAddSuppression(C.role()) });
    add.addEventListener("click", function () { openAddSuppression(null, loadSuppressions); });
    var refresh = h("button", { type: "button", class: "btn secondary small", text: t("common.refresh") });
    refresh.addEventListener("click", loadSuppressions);
    V.setContent(panel,
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: t("canada.supp.title") }), h("span", { class: "spacer" }), add, refresh),
        h("p", { class: "notice info small", text: t("canada.supp.intro") }),
        form),
      h("div", { class: "card" }, h("p", { class: "small muted", id: "cx-sp-summary", attrs: { "aria-live": "polite" } }), h("div", { id: "cx-sp-list" }), h("div", { class: "btn-row", id: "cx-sp-pager" })));
  }

  function loadSuppressions() {
    var list = $("#cx-sp-list");
    if (!list) return;
    V.setContent(list, V.loading());
    return V.api("GET", "/jobsearch/suppressions" + U.suppressionQuery(S.filters, S.page, 25)).then(function (r) {
      V.setContent($("#cx-sp-summary"), t("canada.supp.count", { n: V.fmtNumber(r.total) }));
      var canRemove = U.canRemoveSuppression(C.role());
      V.setContent(list, A.table([t("canada.supp.value"), t("canada.supp.kind"), t("canada.supp.source"), t("canada.supp.reason"), t("canada.supp.created"), t("common.actions")],
        (r.suppressions || []).map(function (s) {
          var rm = canRemove ? h("button", { type: "button", class: "btn secondary small", text: t("canada.supp.remove"), attrs: { "aria-label": t("canada.supp.removeNamed", { value: s.value }) } }) : h("span", { class: "hint", text: t("canada.supp.adminOnly") });
          if (canRemove) rm.addEventListener("click", function () { openRemoveSuppression(s, loadSuppressions); });
          return h("tr", null,
            h("td", null, h("span", { class: "ltr-island mono", text: s.value })),
            h("td", { text: V.has("canada.supp.kind." + s.kind) ? t("canada.supp.kind." + s.kind) : String(s.kind) }),
            h("td", { text: V.has("canada.supp.source." + s.source) ? t("canada.supp.source." + s.source) : String(s.source) }),
            h("td", { text: s.reason || "—" }),
            h("td", { text: V.fmtDateTime(s.createdAt) }),
            h("td", null, rm));
        }), { empty: t("canada.supp.none"), caption: t("canada.supp.title") }));
      C.pager($("#cx-sp-pager"), r.page || S.page, Math.max(1, Math.ceil((r.total || 0) / (r.pageSize || 25))), function (n) { S.page = n; loadSuppressions(); });
    }).catch(function (err) { V.setContent(list, A.errorBox(err)); });
  }

  A.registerTab("suppressions", {
    init: buildSuppressionsPanel,
    load: function () { buildSuppressionsPanel(); return loadSuppressions(); },
    visible: function () { return U.canRead(C.role()); },
  });
  V.onLang(function () { if (S.built && $("#panel-suppressions") && !$("#panel-suppressions").hidden) { S.built = false; buildSuppressionsPanel(); loadSuppressions(); } });

  // ================================================================ application drawer sections
  A.onDrawer(function (d, ctx) {
    var out = [];
    var job = d.job || {};
    // ---- vacancy details + classification
    var vac = h("section", { class: "card" }, h("h3", { text: t("canada.job.title") }),
      A.kv([
        [t("canada.job.salary"), job.salaryText], [t("canada.job.employmentType"), job.employmentType], [t("canada.job.experience"), job.requiredExperienceText],
        [t("canada.job.closing"), job.closingDate ? h("span", { class: "ltr-island", text: job.closingDate }) : null],
      ]),
      C.classificationBlock(job));
    if (job.id && U.canClassify(C.role())) {
      var change = h("button", { type: "button", class: "btn secondary small", text: t("canada.class.change") });
      change.addEventListener("click", function () {
        V.api("GET", "/jobsearch/jobs/" + job.id).then(function (r) { C.openOverride(r.job, ctx.refresh); }).catch(function (err) { V.toast(V.errorMessage(err), "bad"); });
      });
      vac.appendChild(change);
    }
    out.push(vac);

    // ---- match decision (the staff accept / reject that feeds application preparation)
    var m = d.match;
    if (m && m.id) {
      var sec = h("section", { class: "card" }, h("h3", { text: t("canada.matches.decisionTitle") }),
        h("div", { class: "cx-chips" }, C.bandChip(m.band), C.decisionChip(m.decision)),
        m.decisionNote ? h("p", { class: "small muted", text: t("canada.matches.note") + ": " + m.decisionNote }) : null);
      if (U.canDecideMatch(C.role())) {
        var row = h("div", { class: "btn-row" });
        [["accept", "canada.matches.accept", ""], ["reject", "canada.matches.reject", "danger"]].forEach(function (a) {
          var b = h("button", { type: "button", class: "btn small " + a[2], text: t(a[1]), disabled: m.decision === (a[0] === "accept" ? "accepted" : "rejected") });
          b.addEventListener("click", function () { C.decideMatch({ id: m.id, jobId: job.id, job: { title: job.title } }, a[0], ctx.refresh); });
          row.appendChild(b);
        });
        sec.appendChild(row);
      } else sec.appendChild(h("p", { class: "hint", text: t("canada.matches.approverOnly") }));
      out.push(sec);
    }

    // ---- outreach checks (do-not-contact list, opted-out employer, outreach basis) + employer history
    var blockers = U.outreachBlockers(ctx.lastPackage ? ctx.lastPackage.outreach_blockers : []);
    U.outreachBlockers(d.autoApproval ? d.autoApproval.reasons : []).forEach(function (b) {
      if (!blockers.some(function (x) { return x.code === b.code; })) blockers.push(b);
    });
    var outreach = h("section", { class: "card", id: "cx-outreach" }, h("h3", { text: t("canada.outreach.title") }),
      blockers.length ? h("div", { class: "notice bad", attrs: { role: "alert" } }, h("strong", { text: t("canada.outreach.blocked") }),
        h("ul", { class: "compact" }, blockers.map(function (b) { return h("li", { text: t("canada.outreach." + b.code) + (b.detail ? " — " + b.detail : "") }); })))
        : h("p", { class: "small muted", text: t("canada.outreach.clear") }));
    var histBox = h("div", null);
    if (ctx.lastPackage && ctx.lastPackage.employer_history) histBox.appendChild(h("div", null, h("h4", { text: t("canada.hist.title") }), historyPanel(ctx.lastPackage.employer_history)));
    else if (d.employer && d.employer.id) {
      V.setContent(histBox, V.loading());
      V.api("GET", "/jobsearch/employers/" + d.employer.id + "/history").then(function (hist) {
        V.setContent(histBox, h("h4", { text: t("canada.hist.title") }), historyPanel(hist));
      }).catch(function () { V.clear(histBox); });
    }
    outreach.appendChild(histBox);
    if (d.employer && d.employer.id) {
      var open = h("button", { type: "button", class: "btn secondary small", text: t("canada.emp.details") });
      open.addEventListener("click", function () { C.openEmployer(d.employer.id); });
      outreach.appendChild(open);
    }
    out.push(outreach);
    return out;
  });
})();
