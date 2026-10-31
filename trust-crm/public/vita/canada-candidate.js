/* Canada service layer, staff console: candidate card sections (reference + Canada profile, matches with bands and accept / reject,
   vacancy details and classification override, Canadian CV, activity report) and the shared helpers the other canada-*.js files use
   (window.VITA_CANADA). All server text (names, ad text, quotes, notes) is rendered as text only. Buttons for actions a role cannot
   take are not shown or are disabled with the reason; canada-util.js mirrors the permissions and the server decides on every call. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var U = window.VITA_CANADA_UTIL;
  var t = V.t, h = V.h, $ = V.$;

  var C = (window.VITA_CANADA = { reload: {} });

  // ================================================================ shared helpers
  C.role = function () { return A.role(); };
  C.can = function (perm) { return U.can(A.role(), perm); };
  C.field = function (id, label, control, hint) {
    return h("div", { class: "field" }, h("label", { for: id, text: label }), control, hint ? h("span", { class: "hint", text: hint }) : null);
  };
  C.select = function (id, items, current) {
    var sel = h("select", { id: id });
    A.fillSelect(sel, items, current);
    return sel;
  };
  /** [[code, label]] for a code family: C.items("canada.province.", U.PROVINCES). */
  C.items = function (prefix, codes, emptyLabel) {
    var list = codes.map(function (c) { return [c, t(prefix + c)]; });
    return emptyLabel ? [["", emptyLabel]].concat(list) : list;
  };
  C.chip = function (key, cls, vars) { return h("span", { class: "badge " + (cls || "neutral"), text: t(key, vars) }); };
  C.todayUtc = function () { return new Date().toISOString().slice(0, 10); };
  /** The date of "today" in a named zone as YYYY-MM-DD (falls back to the viewer's own zone). */
  C.todayIn = function (tz) {
    try {
      if (tz && V.validTz(tz)) {
        var p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
        var o = {};
        p.forEach(function (x) { o[x.type] = x.value; });
        return o.year + "-" + o.month + "-" + o.day;
      }
    } catch (e) { /* fall through */ }
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  };
  C.errText = function (key) { return t("canada.err." + key); };
  /** An API refusal in plain words: the server's reason for a refusal (400/409/413/422) follows the localized lead-in. */
  C.refusal = function (err, leadKey) {
    if (err && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403 && err.status !== 404 && err.message && err.code !== "network") {
      var billing = err.code && V.has("err.code." + err.code);
      return billing ? V.errorMessage(err) : t(leadKey || "canada.refused", { reason: String(err.message).slice(0, 300) });
    }
    return V.errorMessage(err);
  };
  C.refusalBox = function (err, leadKey) { return h("p", { class: "notice bad", attrs: { role: "alert" }, text: C.refusal(err, leadKey) }); };

  var dlgSeq = 0;
  /** Modal dialog around a <form>. Escape and Cancel close it; focus returns to the opener. Returns {form, close}. */
  C.modal = function (title, body, o) {
    var id = "cx-dlg-" + (++dlgSeq);
    var form = h("form", { attrs: { novalidate: "" } }, h("h2", { id: id + "-t", text: title }), body);
    var dlg = h("dialog", { class: o && o.wide ? "wide" : null, attrs: { "aria-labelledby": id + "-t" } }, form);
    document.body.appendChild(dlg);
    var opener = document.activeElement;
    var close = function () {
      if (dlg.open) dlg.close();
      dlg.remove();
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
    };
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    return { form: form, close: close, dialog: dlg };
  };
  /** Runs fn for a submit button once at a time; the caller shows the error inline. */
  C.submit = function (button, state, fn) {
    if (state.sending) return Promise.resolve();
    state.sending = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    return Promise.resolve().then(fn).then(function (v) { return v; }, function (err) {
      state.sending = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      throw err;
    });
  };
  C.flag = function (el, errEl, message) {
    errEl.textContent = message;
    if (el) { el.setAttribute("aria-invalid", "true"); el.focus(); }
  };
  C.unflag = function (form) { V.$all("[aria-invalid]", form).forEach(function (x) { x.removeAttribute("aria-invalid"); }); };

  /** Section box inside the candidate card, created once in the order of ensureSections(). */
  C.section = function (id) {
    var host = $("#dash-canada");
    var el = document.getElementById(id);
    if (!el && host) {
      el = h("section", { class: "cx-section card", id: id });
      host.appendChild(el);
    }
    return el;
  };
  /**
   * Starts a render of a section for candidate `id`. Returns false (skip) while the user is typing inside the section, so a live
   * refresh never wipes a form being edited; otherwise bumps the generation used by stale().
   */
  C.begin = function (box, id) {
    if (!box) return null;
    var active = document.activeElement;
    if (box._cid === id && active && active !== document.body && box.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return null;
    box._cid = id;
    box._gen = (box._gen || 0) + 1;
    var gen = box._gen;
    return function stale() { return gen !== box._gen; };
  };
  C.pager = function (box, page, pages, go) {
    V.clear(box);
    if (pages <= 1) return;
    var prev = h("button", { type: "button", class: "btn secondary small", text: t("common.prev"), disabled: page <= 1 });
    var next = h("button", { type: "button", class: "btn secondary small", text: t("common.next"), disabled: page >= pages });
    prev.addEventListener("click", function () { go(page - 1); });
    next.addEventListener("click", function () { go(page + 1); });
    box.appendChild(prev);
    box.appendChild(h("span", { class: "small", text: t("common.pageOf", { page: page, pages: pages }) }));
    box.appendChild(next);
  };
  C.bandChip = function (band) { return C.chip(U.bandKey(band), U.bandClass(band)); };
  C.decisionChip = function (d) { return C.chip(U.decisionKey(d), U.decisionClass(d)); };
  C.classChip = function (c) { return C.chip(U.classificationKey(c), U.classificationClass(c)); };
  /** Classification chip with its quoted evidence and the "an advertisement is not proof" notice. */
  C.classificationBlock = function (job) {
    var j = job || {};
    return h("div", { class: "cx-class" },
      h("p", null, h("strong", { text: t("canada.class.title") + ": " }), C.classChip(j.classification)),
      j.classificationEvidence ? [h("span", { class: "small muted", text: t("canada.class.evidence") }), h("blockquote", { class: "evidence", text: j.classificationEvidence })] : h("p", { class: "small muted", text: t("canada.class.noEvidence") }),
      j.classifiedBy ? h("p", { class: "small muted", text: t("canada.class.setByStaff") + (j.classifiedAt ? " · " + V.fmtDateTime(j.classifiedAt) : "") }) : null,
      h("p", { class: "small muted", text: t("canada.class.notice") })
    );
  };

  // ================================================================ 1. reference + Canada profile
  function renderProfile(id) {
    var box = C.section("canada-profile-box");
    var stale = C.begin(box, id);
    if (!stale) return;
    var head = h("h3", { text: t("canada.profile.title") });
    V.setContent(box, head, V.loading());
    V.api("GET", "/jobsearch/candidates/" + id + "/extras").then(function (x) {
      if (stale()) return;
      var editable = U.canEditCanadaProfile(C.role()) && Array.isArray(x.editable_fields) ? x.editable_fields : [];
      var can = function (f) { return editable.indexOf(f) >= 0; };
      var ref = U.referenceDisplay(x.reference);
      var p = "cx-pf-" + id + "-";
      var city = h("input", { id: p + "city", type: "text", value: x.city || "", disabled: !can("city"), attrs: { maxlength: "120", autocomplete: "off" } });
      var wa = h("input", { id: p + "wa", type: "tel", value: x.whatsapp || "", disabled: !can("whatsapp"), attrs: { maxlength: "30", autocomplete: "off", dir: "ltr", placeholder: "+1 416 555 0100" } });
      var work = C.select(p + "work", C.items("canada.workauth.", U.WORK_AUTH, t("canada.notSet")), x.work_authorization_status || "");
      work.disabled = !can("work_authorization_status");
      var rel = C.select(p + "rel", [["", t("canada.relocation.unknown")], ["true", t("canada.relocation.true")], ["false", t("canada.relocation.false")]], x.relocation_ready === true ? "true" : x.relocation_ready === false ? "false" : "");
      rel.disabled = !can("relocation_ready");
      var prov = C.select(p + "prov", C.items("canada.province.", U.PROVINCES, t("canada.notSet")), x.desired_province || "");
      prov.disabled = !can("desired_province");
      var start = h("input", { id: p + "start", type: "date", value: x.service_start_date || "", disabled: !can("service_start_date"), attrs: { dir: "ltr" } });
      var err = h("p", { class: "form-error", attrs: { role: "alert" } });
      var save = h("button", { type: "submit", class: "btn small", text: t("common.save"), disabled: editable.length === 0 });
      var form = h("form", { attrs: { novalidate: "" } },
        h("div", { class: "inline-fields" },
          C.field(p + "city", t("canada.profile.city"), city),
          C.field(p + "wa", t("canada.profile.whatsapp"), wa),
          C.field(p + "work", t("canada.profile.workAuth"), work, t("canada.profile.workAuthHint")),
          C.field(p + "rel", t("canada.profile.relocation"), rel),
          C.field(p + "prov", t("canada.profile.province"), prov, t("canada.profile.provinceHint")),
          C.field(p + "start", t("canada.profile.start"), start)),
        err, save, editable.length ? null : h("span", { class: "hint", text: t("canada.profile.readOnly") }));
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        err.textContent = "";
        C.unflag(form);
        var built = U.profilePatch({ city: city.value, whatsapp: wa.value, relocation_ready: rel.value, desired_province: prov.value, work_authorization_status: work.value, service_start_date: start.value }, x);
        var fields = { city: city, whatsapp: wa, relocation_ready: rel, desired_province: prov, work_authorization_status: work, service_start_date: start };
        if (!built.ok) return built.error === "nothing" ? V.toast(t("canada.err.nothing"), "bad") : C.flag(fields[built.error], err, C.errText(built.error));
        V.busy(save, function () {
          return V.api("PATCH", "/jobsearch/candidates/" + id + "/extras", { body: built.patch }).then(function () {
            V.toast(t("canada.profile.saved"), "ok");
            V.announce(t("canada.profile.saved"));
            box._cid = null;
            renderProfile(id);
            if (C.reload.billing) C.reload.billing(id); // the desired province decides the legal-review jurisdiction
          });
        }).catch(function (e2) { err.textContent = C.refusal(e2); });
      });
      V.setContent(box,
        head,
        h("div", { class: "cx-ref", attrs: { role: "group", "aria-label": t("canada.ref.label") } },
          h("span", { class: "cx-ref-label", text: t("canada.ref.label") }),
          h("strong", { class: "cx-ref-value ltr-island", id: "cx-ref-" + id, text: ref || t("canada.ref.none") })),
        ref ? null : h("p", { class: "small muted", text: t("canada.ref.noneHint") }),
        form);
    }).catch(function (err) {
      if (stale()) return;
      V.setContent(box, head, err && err.status === 404 ? h("p", { class: "notice info small", text: t("crm.cand.noAccess") }) : A.errorBox(err));
    });
  }

  // ================================================================ 2. matches: band, classification, decision
  var matchPage = {};
  function renderMatches(id, page) {
    var box = C.section("canada-matches-box");
    var stale = C.begin(box, id);
    if (!stale) return;
    var pg = page || matchPage[id] || 1;
    matchPage[id] = pg;
    var head = h("h3", { text: t("canada.matches.title") });
    V.setContent(box, head, V.loading());
    Promise.all([
      V.api("GET", "/jobsearch/candidates/" + id + "/matches?pageSize=10&page=" + pg),
      V.api("GET", "/jobsearch/match-settings").catch(function () { return null; }),
    ]).then(function (r) {
      if (stale()) return;
      var d = r[0];
      var rows = d.matches || [];
      var canDecide = U.canDecideMatch(C.role());
      var list = h("ul", { class: "cx-list" }, rows.map(function (m) {
        var job = m.job || {};
        var details = h("button", { type: "button", class: "btn secondary small", text: t("canada.matches.details"), attrs: { "aria-label": t("canada.matches.detailsNamed", { title: job.title || "#" + m.jobId }) } });
        details.addEventListener("click", function () { C.openJob(m.jobId, function () { box._cid = null; renderMatches(id, pg); }); });
        var btns = h("div", { class: "btn-row" }, details);
        if (canDecide) {
          [["accept", "canada.matches.accept", ""], ["reject", "canada.matches.reject", "danger"]].forEach(function (a) {
            var b = h("button", { type: "button", class: "btn small " + a[2], text: t(a[1]), disabled: m.decision === (a[0] === "accept" ? "accepted" : "rejected") });
            b.addEventListener("click", function () { C.decideMatch(m, a[0], function () { box._cid = null; renderMatches(id, pg); }); });
            btns.appendChild(b);
          });
        } else btns.appendChild(h("span", { class: "hint", text: t("canada.matches.approverOnly") }));
        return h("li", { class: "cx-item" },
          h("p", null, h("strong", { text: job.title || "—" }), " · ", job.employer || "—", job.location ? " · " + job.location : ""),
          h("div", { class: "cx-chips" },
            C.bandChip(m.band), h("span", { class: "badge neutral", text: t("canada.matches.score", { score: V.fmtNumber(m.score) }) }),
            C.classChip(job.classification), m.decision ? C.decisionChip(m.decision) : null),
          m.decisionNote ? h("p", { class: "small muted", text: t("canada.matches.note") + ": " + m.decisionNote }) : null,
          btns);
      }));
      var pager = h("div", { class: "btn-row" });
      C.pager(pager, pg, Math.max(1, Math.ceil((d.total || 0) / 10)), function (n) { box._cid = null; renderMatches(id, n); });
      V.setContent(box, head,
        h("p", { class: "small muted", text: t("canada.matches.hint") }),
        matchSettingBlock(r[1], function () { box._cid = null; renderMatches(id, pg); }),
        rows.length ? list : V.empty(t("canada.matches.none")), pager);
    }).catch(function (err) { if (!stale()) V.setContent(box, head, A.errorBox(err)); });
  }

  function matchSettingBlock(st, after) {
    if (!st) return null;
    var on = Boolean(st.require_match_acceptance);
    var admin = U.canSetMatchSetting(C.role());
    var cb = h("input", { id: "cx-require-accept", type: "checkbox", checked: on, disabled: !admin });
    if (admin) {
      cb.addEventListener("change", function () {
        var next = cb.checked;
        V.confirmDialog(t(next ? "canada.matches.requireOnConfirm" : "canada.matches.requireOffConfirm"), t("common.save")).then(function (ok) {
          if (!ok) { cb.checked = !next; return; }
          V.busy(cb, function () {
            return V.api("PUT", "/jobsearch/match-settings", { body: { require_match_acceptance: next } }).then(function () {
              V.toast(t("canada.matches.requireSaved"), "ok");
              after();
            });
          }).catch(function () { cb.checked = !next; });
        });
      });
    }
    return h("div", { class: "notice info small" },
      h("label", { class: "check", for: "cx-require-accept" }, cb, " ", t("canada.matches.requireLabel")),
      h("span", { class: "hint", text: admin ? t("canada.matches.requireHint") : t("canada.matches.requireAdminOnly", { state: on ? t("common.yes") : t("common.no") }) }));
  }

  /** Accept / reject a match with an optional internal note (never shown to the candidate). */
  C.decideMatch = function (m, verb, after) {
    var note = h("textarea", { id: "cx-dec-note", attrs: { rows: "3", maxlength: "500" } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn" + (verb === "reject" ? " danger" : ""), text: t(verb === "accept" ? "canada.matches.accept" : "canada.matches.reject") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var job = m.job || {};
    var dlg = C.modal(t(verb === "accept" ? "canada.matches.acceptTitle" : "canada.matches.rejectTitle", { title: job.title || "#" + m.jobId }), [
      h("p", { class: "small", text: t("canada.matches.decisionHint") }),
      C.field("cx-dec-note", t("canada.matches.noteLabel"), note, t("canada.matches.noteHint")),
      err, h("div", { class: "btn-row" }, go, cancel)]);
    var state = { sending: false };
    cancel.addEventListener("click", dlg.close);
    dlg.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      var body = {};
      if (note.value.trim()) body.note = note.value.trim();
      C.submit(go, state, function () {
        return V.api("POST", "/jobsearch/matches/" + m.id + "/" + verb, { body: body }).then(function () {
          dlg.close();
          V.toast(t(verb === "accept" ? "canada.matches.accepted" : "canada.matches.rejected"), "ok");
          if (after) after();
        });
      }).catch(function (e2) { err.textContent = C.refusal(e2); });
    });
    note.focus();
  };

  // ================================================================ vacancy details + classification override
  C.openJob = function (jobId, after) {
    var body = h("div", null, V.loading());
    var close = h("button", { type: "button", class: "btn secondary", text: t("common.close") });
    var dlg = C.modal(t("canada.job.title"), [body, h("div", { class: "btn-row" }, close)], { wide: true });
    close.addEventListener("click", function () { dlg.close(); if (after) after(); });
    V.api("GET", "/jobsearch/jobs/" + jobId).then(function (r) {
      var j = r.job || {};
      var override = h("button", { type: "button", class: "btn small", text: t("canada.class.change") });
      override.addEventListener("click", function () {
        C.openOverride(j, function () { dlg.close(); if (after) after(); });
      });
      V.setContent(body,
        h("h3", { text: j.title || "—" }),
        A.kv([
          [t("filter.employer"), j.employer],
          [t("drawer.location"), [j.location, j.country].filter(Boolean).join(", ")],
          [t("drawer.jobStatus"), j.status ? V.tc("jobStatus", j.status) : null],
          [t("canada.job.salary"), j.salaryText],
          [t("canada.job.employmentType"), j.employmentType],
          [t("canada.job.experience"), j.requiredExperienceText],
          [t("canada.job.closing"), j.closingDate ? h("span", { class: "ltr-island", text: j.closingDate }) : null],
          [t("drawer.link"), j.url ? V.safeLink(j.url, t("drawer.openAd")) : null],
        ]),
        C.classificationBlock(j),
        U.canClassify(C.role()) ? override : h("p", { class: "small muted", text: t("why.noPermission") }),
        j.description ? h("details", null, h("summary", { text: t("canada.job.description") }), h("div", { class: "untrusted", text: String(j.description).slice(0, 8000) })) : null,
        h("p", { class: "small muted", text: r.notice || t("canada.class.notice") }));
    }).catch(function (err) { V.setContent(body, A.errorBox(err)); });
  };

  /** Staff override of the classification. foreign_applicants_stated needs a quote that occurs verbatim in the ad (live check). */
  C.openOverride = function (job, after) {
    var cls = C.select("cx-ov-class", C.items("canada.class.", U.CLASSES, t("canada.class.clear")), job.classification || "");
    var evidence = h("textarea", { id: "cx-ov-evidence", attrs: { rows: "3", maxlength: String(U.MAX_EVIDENCE) } });
    evidence.value = job.classificationEvidence || "";
    var hint = h("p", { class: "hint", attrs: { "aria-live": "polite" } });
    var note = h("textarea", { id: "cx-ov-note", attrs: { rows: "2", maxlength: "500" } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: t("canada.class.save") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var evField = C.field("cx-ov-evidence", t("canada.class.evidenceLabel"), evidence, t("canada.class.evidenceHint"));
    var noteField = C.field("cx-ov-note", t("canada.class.noteLabel"), note, t("canada.class.noteHint"));
    var sync = function () {
      evField.hidden = cls.value === "";
      var evNeed = U.evidenceRequired(cls.value);
      var h1 = U.evidenceHint(evidence.value, job.description);
      hint.textContent = evidence.value.trim() === "" ? (evNeed ? t("canada.class.hint.required") : "") : t("canada.class.hint." + h1);
      hint.className = "hint" + (h1 === "found" ? " ok" : h1 === "not_found" ? " bad" : "");
      noteField.hidden = false;
    };
    cls.addEventListener("change", sync);
    evidence.addEventListener("input", sync);
    var dlg = C.modal(t("canada.class.overrideTitle"), [
      h("p", { class: "small", text: t("canada.class.overrideIntro") }),
      C.field("cx-ov-class", t("canada.class.title"), cls),
      evField, hint, noteField, err, h("div", { class: "btn-row" }, go, cancel)], { wide: true });
    sync();
    var state = { sending: false };
    cancel.addEventListener("click", dlg.close);
    dlg.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      C.unflag(dlg.form);
      var built = U.classificationPayload({ classification: cls.value, evidence: evidence.value, note: note.value });
      if (!built.ok) {
        var map = { evidence: evidence, evidence_long: evidence, note: note, note_long: note, classification: cls };
        return C.flag(map[built.error], err, C.errText("class_" + built.error));
      }
      C.submit(go, state, function () {
        return V.api("POST", "/jobsearch/jobs/" + job.id + "/classification", { body: built.payload }).then(function () {
          dlg.close();
          V.toast(t("canada.class.saved"), "ok");
          if (after) after();
        });
      }).catch(function (e2) { err.textContent = C.refusal(e2, "canada.class.refused"); });
    });
    cls.focus();
  };

  // ================================================================ 3. Canadian CV
  function missingChip(code) {
    var m = U.missingFlag(code);
    var vars = {};
    Object.keys(m.vars).forEach(function (k) { vars[k] = m.vars[k]; });
    if (m.vars.section !== undefined) vars.section = m.vars.sectionKey ? t(m.vars.sectionKey) : m.vars.section;
    var text = m.key ? t(m.key, vars) : t("canada.missing.other", { text: m.vars.text });
    return h("span", { class: "badge " + (/^latin_spelling_needed/.test(String(code)) ? "bad" : "warn"), text: text });
  }

  function renderCv(id) {
    var box = C.section("canada-cv-box");
    var stale = C.begin(box, id);
    if (!stale) return;
    var head = h("h3", { text: t("canada.cv.title") });
    V.setContent(box, head, V.loading());
    V.api("GET", "/jobsearch/candidates/" + id + "/canadian-cv").then(function (r) {
      if (stale()) return;
      var versions = r.versions || [];
      var canGen = U.canGenerateCv(C.role());
      var p = "cx-cv-" + id + "-";
      var lang = C.select(p + "lang", C.items("canada.cv.lang.", U.CV_LANGS), "en");
      var pdf = h("input", { id: p + "pdf", type: "checkbox", checked: true, value: "pdf" });
      var docx = h("input", { id: p + "docx", type: "checkbox", checked: true, value: "docx" });
      var err = h("div", { attrs: { "aria-live": "polite" } });
      var gen = h("button", { type: "submit", class: "btn small", text: t("canada.cv.generate"), disabled: !canGen });
      var form = h("form", { attrs: { novalidate: "" } },
        h("div", { class: "inline-fields" },
          C.field(p + "lang", t("canada.cv.language"), lang, t("canada.cv.langHint")),
          h("fieldset", { class: "field" }, h("legend", { text: t("canada.cv.formats") }),
            h("label", { class: "check", for: p + "pdf" }, pdf, " PDF"), " ", h("label", { class: "check", for: p + "docx" }, docx, " DOCX"))),
        h("div", { class: "btn-row" }, gen, canGen ? null : h("span", { class: "hint", text: t("why.noPermission") })), err);
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        V.clear(err);
        var formats = [pdf.checked ? "pdf" : null, docx.checked ? "docx" : null].filter(Boolean);
        if (!formats.length) return V.setContent(err, h("p", { class: "form-error", attrs: { role: "alert" }, text: C.errText("formats") }));
        V.busy(gen, function () {
          return V.api("POST", "/jobsearch/candidates/" + id + "/canadian-cv", { body: { lang: lang.value, formats: formats } }).then(function (res) {
            V.toast(t("canada.cv.generated", { n: res.version }), "ok");
            V.announce(t("canada.cv.generated", { n: res.version }));
            box._cid = null;
            renderCv(id);
          });
        }).catch(function (e2) { V.setContent(err, C.refusalBox(e2, "canada.cv.refused")); });
      });
      V.setContent(box, head,
        h("p", { class: "small muted", text: t("canada.cv.hint") }),
        h("p", { class: "notice info small", text: t("canada.cv.latinNote") }),
        form,
        versions.length ? h("div", { class: "cx-versions" }, versions.map(function (v) { return cvVersion(id, v, function () { box._cid = null; renderCv(id); }); })) : V.empty(t("canada.cv.none")));
    }).catch(function (err) { if (!stale()) V.setContent(box, head, A.errorBox(err)); });
  }

  function cvVersion(id, v, after) {
    var chips = U.cvStatusChips(v).map(function (c) { return C.chip(c.key, c.cls); });
    var approve = null;
    if (U.canApproveCv(C.role())) {
      approve = h("button", { type: "button", class: "btn small", text: t("canada.cv.approve"), disabled: !U.canApproveVersion(v), attrs: { title: v.stale ? t("canada.cv.staleHint") : "" } });
      approve.addEventListener("click", function () {
        V.confirmDialog(t("canada.cv.approveConfirm", { n: v.version }), t("canada.cv.approve")).then(function (ok) {
          if (!ok) return;
          V.busy(approve, function () {
            return V.api("POST", "/jobsearch/candidates/" + id + "/canadian-cv/" + v.version + "/approve?lang=" + encodeURIComponent(v.lang), { body: {} }).then(function () {
              V.toast(t("canada.cv.approved"), "ok");
              after();
            });
          }).catch(function () { /* reported by busy() */ });
        });
      });
    } else if (v.status === "draft") approve = h("span", { class: "hint", text: t("canada.cv.approverOnly") });
    var downloads = (v.files || []).map(function (f) {
      var b = h("button", { type: "button", class: "btn secondary small", text: t("canada.cv.download", { format: U.formatLabel(f) || "?" }), attrs: { title: U.filenameDisplay(f.name, "") } });
      b.addEventListener("click", function () {
        V.busy(b, function () {
          return V.download("/jobsearch/candidates/" + id + "/canadian-cv/" + v.version + "/download?format=" + encodeURIComponent(f.format) + "&lang=" + encodeURIComponent(v.lang), U.filenameDisplay(f.name)).then(function (res) {
            V.toast(t("canada.downloaded", { name: res.name }), "ok");
          });
        }).catch(function () { /* reported by busy() */ });
      });
      return b;
    });
    var missing = Array.isArray(v.missing) ? v.missing : [];
    return h("article", { class: "cx-version" },
      h("div", { class: "cx-version-head" },
        h("h4", { text: t("canada.cv.versionTitle", { n: V.fmtNumber(v.version), lang: t("canada.cv.lang." + (U.CV_LANGS.indexOf(v.lang) >= 0 ? v.lang : "en")) }) }),
        h("div", { class: "cx-chips" }, chips)),
      h("p", { class: "small muted" }, t("canada.cv.generatedAt", { when: V.fmtDateTime(v.generated_at) }),
        v.staff_approved_at ? " · " + t("canada.cv.approvedAt", { when: V.fmtDateTime(v.staff_approved_at) }) : "",
        v.candidate_authorised_at && !v.candidate_withdrawn_at ? " · " + t("canada.cv.authorisedAt", { when: V.fmtDateTime(v.candidate_authorised_at) }) : ""),
      U.needsLatinSpelling(missing) ? h("p", { class: "notice bad small", attrs: { role: "alert" }, text: t("canada.cv.latinNeeded") }) : null,
      missing.length ? h("div", null, h("p", { class: "small", text: t("canada.cv.missingTitle") }), h("div", { class: "cx-chips" }, missing.map(missingChip))) : h("p", { class: "small muted", text: t("canada.cv.noMissing") }),
      h("div", { class: "btn-row" }, downloads, approve));
  }

  // ================================================================ 4. activity report
  function renderActivity(id) {
    var box = C.section("canada-activity-box");
    var stale = C.begin(box, id);
    if (!stale) return;
    var head = h("h3", { text: t("canada.activity.title") });
    var p = "cx-ar-" + id + "-";
    var from = h("input", { id: p + "from", type: "date", attrs: { dir: "ltr" } });
    var to = h("input", { id: p + "to", type: "date", attrs: { dir: "ltr" } });
    var lang = C.select(p + "lang", C.items("canada.report.lang.", U.REPORT_LANGS), V.getLang() === "ar" || V.getLang() === "fr" ? V.getLang() : "en");
    var note = h("p", { class: "hint", attrs: { "aria-live": "polite" } });
    var sync = function () { var k = U.reportLangNoteKey(lang.value); note.textContent = k ? t(k) : ""; };
    lang.addEventListener("change", sync);
    sync();
    var status = h("div", { attrs: { "aria-live": "polite" } });
    var snapBox = h("div", { id: p + "snaps" });
    var buttons = U.REPORT_FORMATS.map(function (fmt) {
      var b = h("button", { type: "button", class: "btn small", text: t("canada.activity.download", { format: fmt.toUpperCase() }) });
      b.addEventListener("click", function () {
        V.clear(status);
        var q = U.reportQuery({ format: fmt, from: from.value, to: to.value, lang: lang.value });
        if (!q.ok) return V.setContent(status, h("p", { class: "form-error", attrs: { role: "alert" }, text: C.errText("range_" + q.error) }));
        V.busy(b, function () {
          return V.download("/jobsearch/candidates/" + id + "/activity-report" + A.qs(q.query), "activity." + fmt).then(function (res) {
            V.toast(t("canada.downloaded", { name: res.name }), "ok");
            loadSnapshots(snapBox, id);
          });
        }).catch(function (err) { V.setContent(status, C.refusalBox(err)); });
      });
      return b;
    });
    V.setContent(box, head,
      h("p", { class: "small muted", text: t("canada.activity.hint") }),
      h("div", { class: "inline-fields" },
        C.field(p + "from", t("canada.report.from"), from), C.field(p + "to", t("canada.report.to"), to), C.field(p + "lang", t("canada.report.language"), lang)),
      note, h("div", { class: "btn-row" }, buttons), status,
      h("h4", { text: t("canada.snapshots.title") }), snapBox);
    loadSnapshots(snapBox, id);
  }

  /** Immutable snapshots (history) with authenticated downloads. candidateId = null lists the company-level ones. */
  C.snapshotList = function (rows, opts) {
    var o = opts || {};
    if (!rows.length) return V.empty(t("canada.snapshots.none"));
    return A.table([t("canada.snapshots.kind"), t("canada.snapshots.period"), t("canada.snapshots.generated"), t("canada.snapshots.files")], rows.map(function (s) {
      var files = h("div", { class: "btn-row" }, (s.formats || []).map(function (fmt) {
        var b = h("button", { type: "button", class: "btn secondary small", text: fmt.toUpperCase() });
        b.addEventListener("click", function () {
          V.busy(b, function () { return V.download("/jobsearch/reports/snapshots/" + s.id + "/download?format=" + encodeURIComponent(fmt), "report." + fmt); }).catch(function () { /* reported by busy() */ });
        });
        return b;
      }));
      var kind = V.has("canada.snapshot.kind." + s.kind) ? t("canada.snapshot.kind." + s.kind) : String(s.kind || "").replace(/_/g, " ");
      return h("tr", null,
        h("td", null, kind, s.scheduled ? h("span", { class: "badge info", text: t("canada.snapshots.scheduled") }) : null, (s.flags || []).map(function (f) { return h("span", { class: "badge warn", text: V.has("canada.snapshot.flag." + f) ? t("canada.snapshot.flag." + f) : String(f) }); })),
        h("td", null, h("span", { class: "ltr-island", text: (s.from || "—") + " → " + (s.to || "—") })),
        h("td", { text: V.fmtDateTime(s.generatedAt, s.timezone) }),
        h("td", null, files));
    }), { empty: t("canada.snapshots.none"), caption: o.caption || t("canada.snapshots.title") });
  };
  function loadSnapshots(box, id) {
    V.setContent(box, V.loading());
    return V.api("GET", "/jobsearch/reports/snapshots?kind=candidate_activity&limit=20&candidateId=" + encodeURIComponent(id))
      .then(function (r) { V.setContent(box, C.snapshotList(r.snapshots || [])); })
      .catch(function (err) { V.setContent(box, A.errorBox(err)); });
  }

  // ================================================================ wiring
  function ensureSections() {
    ["canada-profile-box", "canada-matches-box", "canada-cv-box", "canada-activity-box", "canada-billing-box"].forEach(C.section);
  }
  A.onCandidate(function (id) {
    ensureSections();
    var activeId = id;
    C.currentCandidate = activeId;
    renderProfile(id);
    renderMatches(id);
    renderCv(id);
    renderActivity(id);
  });
  C.reload.cv = function (id) { var b = C.section("canada-cv-box"); b._cid = null; renderCv(id); };
})();
