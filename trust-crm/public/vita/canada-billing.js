/* Canada service layer, staff console: "Contract & billing" panel of the candidate card. It shows whether a candidate fee may be
   billed at all (GET /finance/billing-status: a recorded, approved, unexpired legal review for the candidate's jurisdiction AND an
   active signed contract), the candidate's service contracts (create / sign / end / cancel for the finance roles) and the dialog
   that records a legal review (administrators only). The platform RECORDS reviews; it does not give legal advice. There is no way
   around the gate here: invoices are created in the Accounting tab, where the server applies the same gate. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var U = window.VITA_CANADA_UTIL;
  var C = window.VITA_CANADA;
  var t = V.t, h = V.h;

  function renderStatus(st) {
    var sum = U.billingSummary(st);
    var out = [
      h("div", { class: "notice " + (sum.billable ? "ok" : "bad"), attrs: { role: "status" } },
        h("p", null, h("strong", { text: t("canada.billing.fee") + ": " }), C.chip(sum.billable ? "canada.billing.enabled" : "canada.billing.disabled", sum.billable ? "ok" : "bad")),
        sum.billable ? h("p", { class: "small", text: t("canada.billing.okExplain") }) : h("ul", { class: "compact" }, sum.items.map(function (i) { return h("li", { text: t(i.key, i.vars) }); })))
    ];
    var rev = st && st.review;
    out.push(A.kv([
      [t("canada.billing.jurisdiction"), st && st.jurisdiction ? h("span", { class: "ltr-island", text: st.jurisdiction }) : null],
      [t("canada.billing.latestReview"), rev ? h("span", null, C.chip("canada.legal.status." + (U.LEGAL_STATUSES.indexOf(rev.status) >= 0 ? rev.status : "pending"), rev.status === "approved" ? "ok" : rev.status === "prohibited" ? "bad" : "warn"),
        rev.reviewer_name ? " " + rev.reviewer_name : "", rev.valid_until ? " · " + t("canada.legal.validUntilShort", { date: rev.valid_until }) : "") : t("canada.billing.noReview")],
    ]));
    return out;
  }

  function contractRow(k, id, after) {
    var acts = U.contractActions(k, C.role());
    var row = h("li", { class: "cx-item" },
      h("p", null, h("strong", { text: k.service_name || k.service_code || "#" + k.service_id }), " · ", C.chip("canada.contract.status." + (U.CONTRACT_STATUSES.indexOf(k.status) >= 0 ? k.status : "draft"), k.status === "active" ? "ok" : k.status === "draft" ? "warn" : "neutral"),
        k.service_kind === "candidate_fee" ? [" ", C.chip("canada.svckind.candidate_fee", "info")] : null),
      h("p", { class: "small muted" },
        k.agreement_signed_at ? t("canada.contract.signedOn", { date: V.fmtDateTime(k.agreement_signed_at), name: k.signed_by_name || "—" }) : t("canada.contract.notSigned"),
        k.start_date || k.end_date ? " · " + (k.start_date || "—") + " → " + (k.end_date || "—") : ""),
      k.refund_terms ? h("p", { class: "small", text: t("canada.contract.refund") + ": " + k.refund_terms }) : null);
    var btns = h("div", { class: "btn-row" });
    if (acts.sign) {
      var sign = h("button", { type: "button", class: "btn small", text: t("canada.contract.sign") });
      sign.addEventListener("click", function () { openSign(k, after); });
      btns.appendChild(sign);
    }
    [["end", acts.end, "canada.contract.end"], ["cancel", acts.cancel, "canada.contract.cancel"]].forEach(function (a) {
      if (!a[1]) return;
      var b = h("button", { type: "button", class: "btn secondary small danger", text: t(a[2]) });
      b.addEventListener("click", function () { openReason(k, a[0], after); });
      btns.appendChild(b);
    });
    row.appendChild(btns);
    return row;
  }

  function openSign(k, after) {
    var name = h("input", { id: "cx-sg-name", type: "text", attrs: { maxlength: "200", autocomplete: "off" } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: t("canada.contract.sign") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var dlg = C.modal(t("canada.contract.signTitle"), [
      h("p", { class: "small", text: t("canada.contract.signIntro") }),
      C.field("cx-sg-name", t("canada.contract.signedBy"), name, t("canada.contract.signedByHint")), err, h("div", { class: "btn-row" }, go, cancel)]);
    var state = { sending: false };
    cancel.addEventListener("click", dlg.close);
    dlg.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      var built = U.contractSignPayload({ signed_by_name: name.value });
      if (!built.ok) return C.flag(name, err, C.errText("signed_by_name"));
      C.submit(go, state, function () {
        return V.api("POST", "/finance/contracts/" + k.id + "/sign", { body: built.payload }).then(function () {
          dlg.close();
          V.toast(t("canada.contract.signed"), "ok");
          after();
        });
      }).catch(function (e2) { err.textContent = C.refusal(e2); });
    });
    name.focus();
  }

  function openReason(k, verb, after) {
    var reason = h("textarea", { id: "cx-ct-reason", attrs: { rows: "3", maxlength: "500" } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn danger", text: t(verb === "end" ? "canada.contract.end" : "canada.contract.cancel") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var dlg = C.modal(t(verb === "end" ? "canada.contract.endTitle" : "canada.contract.cancelTitle"), [
      h("p", { class: "notice warn small", text: t("canada.contract.endWarning") }),
      C.field("cx-ct-reason", t("canada.contract.reason"), reason), err, h("div", { class: "btn-row" }, go, cancel)]);
    var state = { sending: false };
    cancel.addEventListener("click", dlg.close);
    dlg.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      if (reason.value.trim().length > 500) return C.flag(reason, err, C.errText("reason_long"));
      C.submit(go, state, function () {
        return V.api("POST", "/finance/contracts/" + k.id + "/" + verb, { body: reason.value.trim() ? { reason: reason.value.trim() } : {} }).then(function () {
          dlg.close();
          V.toast(t(verb === "end" ? "canada.contract.ended" : "canada.contract.cancelled"), "ok");
          after();
        });
      }).catch(function (e2) { err.textContent = C.refusal(e2); });
    });
    reason.focus();
  }

  function openNewContract(candidateId, after) {
    var svc = h("select", { id: "cx-nc-svc" });
    var start = h("input", { id: "cx-nc-start", type: "date", attrs: { dir: "ltr" } });
    var end = h("input", { id: "cx-nc-end", type: "date", attrs: { dir: "ltr" } });
    var terms = h("textarea", { id: "cx-nc-terms", attrs: { rows: "3", maxlength: "2000" } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: t("canada.contract.create") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var dlg = C.modal(t("canada.contract.newTitle"), [
      h("p", { class: "small", text: t("canada.contract.newIntro") }),
      C.field("cx-nc-svc", t("canada.contract.service"), svc),
      h("div", { class: "inline-fields" }, C.field("cx-nc-start", t("canada.contract.start"), start), C.field("cx-nc-end", t("canada.contract.endDate"), end)),
      C.field("cx-nc-terms", t("canada.contract.refund"), terms, t("canada.contract.refundHint")), err, h("div", { class: "btn-row" }, go, cancel)]);
    V.api("GET", "/finance/services?active=true").then(function (r) {
      var rows = r.rows || [];
      A.fillSelect(svc, [["", t("canada.contract.pickService")]].concat(rows.map(function (s) {
        return [String(s.id), (s.code || "#" + s.id) + " — " + (s.name_en || s.name_fr || s.name_ar || "") + (s.kind === "candidate_fee" ? " (" + t("canada.svckind.candidate_fee") + ")" : "")];
      })), "");
    }).catch(function (e) { err.textContent = V.errorMessage(e); });
    var state = { sending: false };
    cancel.addEventListener("click", dlg.close);
    dlg.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      C.unflag(dlg.form);
      var built = U.contractCreatePayload({ candidate_id: candidateId, service_id: svc.value, start_date: start.value, end_date: end.value, refund_terms: terms.value });
      if (!built.ok) return C.flag({ service: svc, start_date: start, end_date: end, date_order: end, refund_terms: terms }[built.error], err, C.errText("contract_" + built.error));
      C.submit(go, state, function () {
        return V.api("POST", "/finance/contracts", { body: built.payload }).then(function () {
          dlg.close();
          V.toast(t("canada.contract.created"), "ok");
          after();
        });
      }).catch(function (e2) { err.textContent = C.refusal(e2); });
    });
    svc.focus();
  }

  /** Records a legal review (administrators). Insert-only: a newer review supersedes the older one; nothing is edited or deleted. */
  function openLegalReview(defaultJurisdiction, after) {
    var p = "cx-lr-";
    var jur = h("input", { id: p + "jur", type: "text", value: defaultJurisdiction || "", attrs: { maxlength: "6", autocomplete: "off", dir: "ltr", placeholder: "CA-ON" } });
    var status = C.select(p + "status", C.items("canada.legal.status.", U.LEGAL_STATUSES), "approved");
    var name = h("input", { id: p + "name", type: "text", attrs: { maxlength: "200", autocomplete: "off" } });
    var role = h("input", { id: p + "role", type: "text", attrs: { maxlength: "200", autocomplete: "off" } });
    var reviewed = h("input", { id: p + "date", type: "date", value: C.todayUtc(), attrs: { dir: "ltr", max: C.todayUtc() } });
    var until = h("input", { id: p + "until", type: "date", attrs: { dir: "ltr" } });
    var note = h("textarea", { id: p + "note", attrs: { rows: "3", maxlength: "2000" } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: t("canada.legal.record") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var dlg = C.modal(t("canada.legal.title"), [
      h("p", { class: "notice warn", id: "cx-legal-notice", text: t("canada.legal.notice") }),
      h("p", { class: "small", text: t("canada.legal.intro") }),
      h("div", { class: "inline-fields" }, C.field(p + "jur", t("canada.legal.jurisdiction"), jur, t("canada.legal.jurisdictionHint")), C.field(p + "status", t("canada.legal.statusLabel"), status)),
      h("div", { class: "inline-fields" }, C.field(p + "name", t("canada.legal.reviewerName"), name), C.field(p + "role", t("canada.legal.reviewerRole"), role)),
      h("div", { class: "inline-fields" }, C.field(p + "date", t("canada.legal.reviewedAt"), reviewed), C.field(p + "until", t("canada.legal.validUntil"), until, t("canada.legal.validUntilHint"))),
      C.field(p + "note", t("canada.legal.noteLabel"), note, t("canada.legal.noteHint")),
      err, h("div", { class: "btn-row" }, go, cancel)], { wide: true });
    var fields = { jurisdiction: jur, status: status, reviewer_name: name, reviewer_role: role, reviewed_at: reviewed, reviewed_future: reviewed, valid_until: until, valid_order: until, note: note };
    var state = { sending: false };
    cancel.addEventListener("click", dlg.close);
    dlg.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      C.unflag(dlg.form);
      var built = U.legalReviewPayload({ jurisdiction: jur.value, status: status.value, reviewer_name: name.value, reviewer_role: role.value, reviewed_at: reviewed.value, valid_until: until.value, note: note.value }, C.todayUtc());
      if (!built.ok) return C.flag(fields[built.error], err, C.errText("legal_" + built.error));
      C.submit(go, state, function () {
        return V.api("POST", "/finance/legal-reviews", { body: built.payload }).then(function () {
          dlg.close();
          V.toast(t("canada.legal.recorded"), "ok");
          V.announce(t("canada.legal.recorded"));
          after();
        });
      }).catch(function (e2) { err.textContent = C.refusal(e2); });
    });
    jur.focus();
  }

  function render(id) {
    var box = C.section("canada-billing-box");
    if (!box) return;
    if (!U.canSeeBilling(C.role())) { box.hidden = true; return; }
    box.hidden = false;
    var stale = C.begin(box, id);
    if (!stale) return;
    var head = h("h3", { text: t("canada.billing.title") });
    V.setContent(box, head, V.loading());
    var again = function () { box._cid = null; render(id); };
    Promise.all([
      V.api("GET", "/finance/billing-status?candidate_id=" + encodeURIComponent(id)),
      V.api("GET", "/finance/contracts?candidate_id=" + encodeURIComponent(id) + "&limit=20"),
      V.api("GET", "/jobsearch/candidates/" + id + "/extras").catch(function () { return null; }),
    ]).then(function (r) {
      var st = r[0];
      var contracts = r[1].rows || [];
      var jur = U.defaultJurisdiction(r[2] && r[2].desired_province, st.jurisdiction);
      var reviews = jur
        ? V.api("GET", "/finance/legal-reviews?jurisdiction=" + encodeURIComponent(jur) + "&limit=5").then(function (x) { return x.rows || []; }).catch(function () { return []; })
        : Promise.resolve([]);
      return reviews.then(function (revs) {
        if (stale()) return;
        var actions = h("div", { class: "btn-row" });
        if (U.canRecordLegalReview(C.role())) {
          var rec = h("button", { type: "button", class: "btn small", id: "cx-legal-open", text: t("canada.legal.record") });
          rec.addEventListener("click", function () { openLegalReview(jur, again); });
          actions.appendChild(rec);
        } else actions.appendChild(h("span", { class: "hint", text: t("canada.legal.adminOnly") }));
        if (U.canWriteContracts(C.role())) {
          var nc = h("button", { type: "button", class: "btn secondary small", id: "cx-contract-new", text: t("canada.contract.new") });
          nc.addEventListener("click", function () { openNewContract(id, again); });
          actions.appendChild(nc);
        }
        V.setContent(box, head,
          h("p", { class: "notice info small", text: t("canada.legal.notice") }),
          renderStatus(st),
          actions,
          h("h4", { text: t("canada.legal.history", { jurisdiction: jur || "—" }) }),
          revs.length ? h("ul", { class: "cx-list" }, revs.map(function (rv) {
            return h("li", { class: "cx-item" },
              h("p", null, C.chip("canada.legal.status." + (U.LEGAL_STATUSES.indexOf(rv.status) >= 0 ? rv.status : "pending"), rv.status === "approved" ? "ok" : rv.status === "prohibited" ? "bad" : "warn"), " ", rv.reviewer_name || "—",
                rv.current ? [" ", C.chip("canada.legal.current", "info")] : null),
              h("p", { class: "small muted", text: t("canada.legal.reviewedOn", { date: rv.reviewed_at }) + (rv.valid_until ? " · " + t("canada.legal.validUntilShort", { date: rv.valid_until }) : "") + (rv.reviewer_role ? " · " + rv.reviewer_role : "") }),
              rv.note ? h("p", { class: "small", text: rv.note }) : null);
          })) : h("p", { class: "small muted", text: t("canada.legal.none") }),
          h("h4", { text: t("canada.contract.title") }),
          contracts.length ? h("ul", { class: "cx-list" }, contracts.map(function (k) { return contractRow(k, id, again); })) : V.empty(t("canada.contract.none")));
      });
    }).catch(function (err) { if (!stale()) V.setContent(box, head, A.errorBox(err)); });
  }

  C.reload.billing = function (id) { var b = C.section("canada-billing-box"); if (b) b._cid = null; render(id); };
  A.onCandidate(function (id) { render(id); });
})();
