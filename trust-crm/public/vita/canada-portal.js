/* Canada service layer, candidate portal ("My Canada file"): my reference, my Canada profile (four fields only), my Canadian CV
   (download, authorise with explicit consent, withdraw), my activity report (PDF / Excel) and my contract (read only). Uses only
   candidate-scoped routes (/jobsearch/me/*, /finance/me/contracts); every file goes through an authenticated blob (no token in a URL).
   Everything from the server is rendered as text only. The portal never shows staff notes, internal decisions or other people's data. */
(function () {
  "use strict";
  var V = window.VITA;
  var U = window.VITA_CANADA_UTIL;
  var t = V.t, h = V.h, $ = V.$;

  var seq = 0;
  function field(id, label, control, hint) {
    return h("div", { class: "field" }, h("label", { for: id, text: label }), control, hint ? h("span", { class: "hint", text: hint }) : null);
  }
  function select(id, items, current) {
    var sel = h("select", { id: id });
    V.clear(sel);
    items.forEach(function (it) { sel.appendChild(h("option", { value: it[0], text: it[1], selected: String(it[0]) === String(current === undefined || current === null ? "" : current) })); });
    return sel;
  }
  function items(prefix, codes, emptyLabel) {
    var list = codes.map(function (c) { return [c, t(prefix + c)]; });
    return emptyLabel ? [["", emptyLabel]].concat(list) : list;
  }
  function chip(key, cls, vars) { return h("span", { class: "badge " + (cls || "neutral"), text: t(key, vars) }); }
  function errorBox(err) { return h("p", { class: "notice bad", attrs: { role: "alert" }, text: V.errorMessage(err) }); }
  function refusal(err) {
    if (err && err.status === 409 && err.message) return t("canada.refused", { reason: String(err.message).slice(0, 300) });
    return V.errorMessage(err);
  }
  function qs(obj) {
    var parts = [];
    Object.keys(obj).forEach(function (k) { if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(obj[k]))); });
    return parts.length ? "?" + parts.join("&") : "";
  }
  function card(titleKey, hintKey, id) {
    return h("section", { class: "cx-section card", id: id, attrs: { "aria-labelledby": id + "-h" } }, h("h3", { id: id + "-h", text: t(titleKey) }), hintKey ? h("p", { class: "small muted", text: t(hintKey) }) : null);
  }

  // ---------------------------------------------------------------- reference banner (always visible once signed in)
  var bannerEl = null;
  V.onLang(function () { if (bannerEl && !bannerEl.hidden) loadBanner(bannerEl); });
  function loadBanner(banner) {
    if (!banner) return Promise.resolve();
    bannerEl = banner;
    return V.api("GET", "/jobsearch/me/extras").then(function (x) {
      var ref = U.referenceDisplay(x.reference);
      V.setContent(banner, h("span", { class: "cx-ref-label", text: t("canada.ref.label") }), " ", h("strong", { class: "cx-ref-value ltr-island", id: "cx-portal-ref", text: ref || t("canada.ref.none") }));
      banner.hidden = false;
    }).catch(function () { banner.hidden = true; });
  }

  // ---------------------------------------------------------------- my Canada profile
  function profileCard(root) {
    var box = card("canada.portal.profile.title", "canada.portal.profile.hint", "cx-portal-profile");
    root.appendChild(box);
    var body = h("div", null, V.loading());
    box.appendChild(body);
    V.api("GET", "/jobsearch/me/extras").then(function (x) {
      var ed = Array.isArray(x.editable_fields) ? x.editable_fields : [];
      var p = "cx-mp-";
      var city = h("input", { id: p + "city", type: "text", value: x.city || "", attrs: { maxlength: "120", autocomplete: "address-level2" } });
      var wa = h("input", { id: p + "wa", type: "tel", value: x.whatsapp || "", attrs: { maxlength: "30", autocomplete: "tel", dir: "ltr", placeholder: "+1 416 555 0100" } });
      var rel = select(p + "rel", [["", t("canada.relocation.unknown")], ["true", t("canada.relocation.true")], ["false", t("canada.relocation.false")]], x.relocation_ready === true ? "true" : x.relocation_ready === false ? "false" : "");
      var err = h("p", { class: "form-error", attrs: { role: "alert" } });
      var save = h("button", { type: "submit", class: "btn", text: t("common.save") });
      var form = h("form", { attrs: { novalidate: "" } },
        h("div", { class: "inline-fields" }, field(p + "city", t("canada.profile.city"), city), field(p + "wa", t("canada.profile.whatsapp"), wa), field(p + "rel", t("canada.profile.relocation"), rel)),
        err, save);
      [city, wa, rel].forEach(function (el, i) { el.disabled = ed.indexOf(["city", "whatsapp", "relocation_ready"][i]) < 0; });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        err.textContent = "";
        var built = U.profilePatch({ city: city.value, whatsapp: wa.value, relocation_ready: rel.value }, x, { candidate: true });
        if (!built.ok) {
          if (built.error === "nothing") return V.toast(t("canada.err.nothing"), "bad");
          err.textContent = t("canada.err." + built.error);
          return;
        }
        V.busy(save, function () {
          return V.api("PATCH", "/jobsearch/me/extras", { body: built.patch }).then(function () {
            V.toast(t("canada.profile.saved"), "ok");
            V.announce(t("canada.profile.saved"));
            return render(root);
          });
        }).catch(function (e2) { err.textContent = V.errorMessage(e2); });
      });
      V.setContent(body, form);
    }).catch(function (err) { V.setContent(body, errorBox(err)); });
  }

  // ---------------------------------------------------------------- my Canadian CV
  function cvCard(root) {
    var box = card("canada.portal.cv.title", "canada.portal.cv.hint", "cx-portal-cv");
    root.appendChild(box);
    var body = h("div", null, V.loading());
    box.appendChild(body);
    var again = function () { render(root); };
    V.api("GET", "/jobsearch/me/canadian-cv").then(function (r) {
      var versions = r.versions || [];
      if (!versions.length) return V.setContent(body, V.empty(t("canada.portal.cv.none")));
      V.setContent(body, versions.map(function (v) { return cvVersion(v, again); }));
    }).catch(function (err) { V.setContent(body, errorBox(err)); });
  }

  function cvVersion(v, after) {
    var n = ++seq;
    var lang = U.CV_LANGS.indexOf(v.lang) >= 0 ? v.lang : "en";
    var authorised = v.status === "authorised";
    var chips = U.cvStatusChips(v).map(function (c) { return chip(c.key, c.cls); });
    var downloads = (v.files || []).map(function (f) {
      var b = h("button", { type: "button", class: "btn secondary small", text: t("canada.cv.download", { format: U.formatLabel(f) || "?" }), attrs: { title: U.filenameDisplay(f.name, "") } });
      b.addEventListener("click", function () {
        V.busy(b, function () {
          return V.download("/jobsearch/me/canadian-cv/" + v.version + "/download?format=" + encodeURIComponent(f.format) + "&lang=" + encodeURIComponent(lang), U.filenameDisplay(f.name)).then(function (res) {
            V.toast(t("canada.downloaded", { name: res.name }), "ok");
          });
        }).catch(function () { /* reported by busy() */ });
      });
      return b;
    });
    var out = h("article", { class: "cx-version" },
      h("div", { class: "cx-version-head" }, h("h4", { text: t("canada.cv.versionTitle", { n: V.fmtNumber(v.version), lang: t("canada.cv.lang." + lang) }) }), h("div", { class: "cx-chips" }, chips)),
      h("p", { class: "small muted", text: t("canada.cv.generatedAt", { when: V.fmtDateTime(v.generated_at) }) + (v.staff_approved_at ? " · " + t("canada.cv.approvedAt", { when: V.fmtDateTime(v.staff_approved_at) }) : "") }),
      h("div", { class: "btn-row" }, downloads));
    if (authorised) {
      var wd = h("button", { type: "button", class: "btn secondary small danger", text: t("canada.portal.cv.withdraw") });
      wd.addEventListener("click", function () {
        V.confirmDialog(t("canada.portal.cv.withdrawConfirm", { n: v.version }), t("canada.portal.cv.withdraw"), true).then(function (ok) {
          if (!ok) return;
          V.busy(wd, function () {
            return V.api("POST", "/jobsearch/me/canadian-cv/" + v.version + "/withdraw-authorisation?lang=" + encodeURIComponent(lang), { body: {} }).then(function (res) {
              V.toast(t("canada.portal.cv.withdrawn", { n: V.fmtNumber(res.cancelledApplications || 0) }), "ok");
              after();
            });
          }).catch(function () { /* reported by busy() */ });
        });
      });
      out.appendChild(h("p", { class: "small", text: t("canada.portal.cv.authorisedNote", { when: V.fmtDateTime(v.candidate_authorised_at) }) }));
      out.appendChild(h("div", { class: "btn-row" }, wd));
      return out;
    }
    // approved (or withdrawn) and current: the candidate may authorise it, after confirming the consent sentence
    if (v.stale) {
      out.appendChild(h("p", { class: "notice warn small", text: t("canada.portal.cv.stale") }));
      return out;
    }
    var cbId = "cx-cvc-" + n;
    var cb = h("input", { id: cbId, type: "checkbox" });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "button", class: "btn small", text: t("canada.portal.cv.authorise") });
    go.addEventListener("click", function () {
      err.textContent = "";
      if (!cb.checked) { cb.setAttribute("aria-invalid", "true"); cb.focus(); err.textContent = t("canada.portal.cv.consentRequired"); return; }
      cb.removeAttribute("aria-invalid");
      V.busy(go, function () {
        return V.api("POST", "/jobsearch/me/canadian-cv/" + v.version + "/authorise?lang=" + encodeURIComponent(lang), { body: {} }).then(function () {
          V.toast(t("canada.portal.cv.authorised"), "ok");
          V.announce(t("canada.portal.cv.authorised"));
          after();
        });
      }).catch(function (e) { err.textContent = refusal(e); });
    });
    out.appendChild(h("div", { class: "notice info" },
      h("label", { class: "check", for: cbId }, cb, " ", t("canada.portal.cv.consent")),
      h("p", { class: "small muted", text: t("canada.portal.cv.consentNote") }),
      err, h("div", { class: "btn-row" }, go)));
    return out;
  }

  // ---------------------------------------------------------------- my activity report
  function reportCard(root) {
    var box = card("canada.portal.report.title", "canada.portal.report.hint", "cx-portal-report");
    root.appendChild(box);
    var p = "cx-mr-";
    var from = h("input", { id: p + "from", type: "date", attrs: { dir: "ltr" } });
    var to = h("input", { id: p + "to", type: "date", attrs: { dir: "ltr" } });
    var cur = V.getLang();
    var lang = select(p + "lang", items("canada.report.lang.", U.REPORT_LANGS), U.REPORT_LANGS.indexOf(cur) >= 0 ? cur : "en");
    var note = h("p", { class: "hint", attrs: { "aria-live": "polite" } });
    var sync = function () { var k = U.reportLangNoteKey(lang.value); note.textContent = k ? t(k) : ""; };
    lang.addEventListener("change", sync);
    sync();
    var status = h("div", { attrs: { "aria-live": "polite" } });
    var buttons = U.REPORT_FORMATS.map(function (fmt) {
      var b = h("button", { type: "button", class: "btn small", text: t("canada.activity.download", { format: fmt.toUpperCase() }) });
      b.addEventListener("click", function () {
        V.clear(status);
        var q = U.reportQuery({ format: fmt, from: from.value, to: to.value, lang: lang.value });
        if (!q.ok) return V.setContent(status, h("p", { class: "form-error", attrs: { role: "alert" }, text: t("canada.err." + ("range_" + q.error)) }));
        V.busy(b, function () {
          return V.download("/jobsearch/me/activity-report" + qs(q.query), "activity." + fmt).then(function (res) {
            V.setContent(status, h("p", { class: "notice ok small", text: t("canada.downloaded", { name: res.name }) }));
          });
        }).catch(function (err) { V.setContent(status, errorBox(err)); });
      });
      return b;
    });
    box.appendChild(h("div", { class: "inline-fields" }, field(p + "from", t("canada.report.from"), from), field(p + "to", t("canada.report.to"), to), field(p + "lang", t("canada.report.language"), lang)));
    box.appendChild(note);
    box.appendChild(h("div", { class: "btn-row" }, buttons));
    box.appendChild(status);
    box.appendChild(h("p", { class: "small muted", text: t("canada.portal.report.disclaimer") }));
  }

  // ---------------------------------------------------------------- my contract (read only)
  function contractCard(root) {
    var box = card("canada.portal.contract.title", "canada.portal.contract.hint", "cx-portal-contract");
    root.appendChild(box);
    var body = h("div", null, V.loading());
    box.appendChild(body);
    V.api("GET", "/finance/me/contracts").then(function (r) {
      var rows = r.contracts || [];
      if (!rows.length) return V.setContent(body, V.empty(t("canada.portal.contract.none")));
      V.setContent(body, h("ul", { class: "cx-list" }, rows.map(function (k) {
        var name = V.getLang() === "ar" && k.name_ar ? k.name_ar : V.getLang() === "fr" && k.name_fr ? k.name_fr : k.name_en || k.service_name;
        return h("li", { class: "cx-item" },
          h("p", null, h("strong", { text: name || "—" }), " ", chip("canada.contract.status." + (U.CONTRACT_STATUSES.indexOf(k.status) >= 0 ? k.status : "draft"), k.status === "active" ? "ok" : "neutral")),
          A_dl([
            [t("canada.contract.signedLabel"), k.agreement_signed_at ? V.fmtDate(k.agreement_signed_at) : t("canada.contract.notSigned")],
            [t("canada.contract.start"), k.start_date ? h("span", { class: "ltr-island", text: k.start_date }) : null],
            [t("canada.contract.endDate"), k.end_date ? h("span", { class: "ltr-island", text: k.end_date }) : null],
            [t("canada.contract.refund"), k.refund_terms],
          ]));
      })));
    }).catch(function (err) { V.setContent(body, errorBox(err)); });
  }
  function A_dl(pairs) {
    var dl = h("dl", { class: "kv" });
    pairs.forEach(function (p) {
      if (!p || p[1] === null || p[1] === undefined || p[1] === "") return;
      dl.appendChild(h("dt", { text: p[0] }));
      dl.appendChild(h("dd", null, p[1]));
    });
    return dl;
  }

  var building = 0;
  function render(root) {
    if (!root) return Promise.resolve();
    var gen = ++building;
    V.clear(root);
    if (gen !== building) return Promise.resolve();
    root.appendChild(h("p", { class: "notice info small", text: t("canada.portal.intro") }));
    profileCard(root);
    cvCard(root);
    reportCard(root);
    contractCard(root);
    return Promise.resolve();
  }

  window.VITA_CANADA_PORTAL = { render: render, loadBanner: loadBanner };
})();
