/* VITA candidate portal. Uses only candidate-scoped /jobsearch/* APIs, which already redact
   staff-only data (recipients, internal notes, unreleased messages). Every value from the server,
   the CV extraction or an employer is rendered as text only. */
(function () {
  "use strict";
  var V = window.VITA;
  var t = V.t, tc = V.tc, h = V.h, $ = V.$;

  var CONSENT_VERSION = "2026-10-v1";
  var PRIORITY_COUNTRIES = ["Canada", "Albania", "Romania", "Italy"];
  var CATEGORIES = ["Construction", "Electrician", "Welding", "Plumbing", "Hospitality", "Agriculture", "Healthcare", "Transport", "Manufacturing", "Cleaning", "IT"];
  var AVAILABILITY = ["immediately", "within_1_month", "within_3_months", "within_6_months"];
  var CURRENCIES = ["CAD", "EUR", "ALL", "RON", "USD", "GBP", "TND", "MAD", "DZD", "EGP"];
  var SCALARS = ["name", "email", "phone", "profession"];
  var LISTS = ["skills", "education", "certificates"];
  var STEPS = ["upload", "review", "prefs", "consent", "status", "payments"];

  var S = {
    session: null,
    candidateId: null,
    profile: null,
    consent: null,
    settings: null,
    eligibility: null,
    step: "upload",
    statusTab: "matches",
    dirty: {},
    pendingEdits: null,
    events: null,
    appDetail: null,
  };

  function errorBox(err) { return h("p", { class: "notice bad", attrs: { role: "alert" }, text: V.errorMessage(err) }); }
  function base() { return "/jobsearch/candidates/" + S.candidateId; }

  // ================================================================ login (email OTP)
  function showLogin() {
    if (S.events) { S.events.stop(); S.events = null; }
    S.session = null;
    S.candidateId = null;
    $("#app-view").hidden = true;
    $("#logout").hidden = true;
    V.setContent($("#live-status"));
    $("#login-view").hidden = false;
    $("#otp-request-form").hidden = false;
    $("#otp-verify-form").hidden = true;
    $("#otp-email").focus();
  }

  function initLogin() {
    var err = $("#otp-error");
    $("#otp-request-form").addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      var email = $("#otp-email").value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        $("#otp-email").setAttribute("aria-invalid", "true");
        err.textContent = t("otp.badEmail");
        $("#otp-email").focus();
        return;
      }
      $("#otp-email").removeAttribute("aria-invalid");
      var btn = $("#otp-request-form button[type=submit]");
      V.busy(btn, function () {
        return V.api("POST", "/jobsearch/auth/otp/request", { body: { email: email }, noAuth: true }).then(function () {
          // Always the same message: we never reveal whether an account exists.
          $("#otp-request-form").hidden = true;
          $("#otp-verify-form").hidden = false;
          V.announce(t("otp.generic"));
          $("#otp-code").focus();
        });
      }).catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
    $("#otp-back").addEventListener("click", function () {
      $("#otp-verify-form").hidden = true;
      $("#otp-request-form").hidden = false;
      $("#otp-code").value = "";
      err.textContent = "";
      $("#otp-email").focus();
    });
    $("#otp-verify-form").addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      var code = $("#otp-code").value.replace(/\s+/g, "");
      if (!/^\d{6}$/.test(code)) {
        $("#otp-code").setAttribute("aria-invalid", "true");
        err.textContent = t("otp.badCode");
        $("#otp-code").focus();
        return;
      }
      $("#otp-code").removeAttribute("aria-invalid");
      var btn = $("#otp-verify-form button[type=submit]");
      V.busy(btn, function () {
        return V.api("POST", "/jobsearch/auth/otp/verify", { body: { email: $("#otp-email").value.trim(), code: code }, noAuth: true }).then(function (r) {
          $("#otp-code").value = "";
          V.setSession({ kind: "candidate", token: r.token });
          start();
        });
      }).catch(function (e2) { err.textContent = e2 && e2.status === 401 ? t("otp.invalid") : V.errorMessage(e2); });
    });
    $("#logout").addEventListener("click", function () {
      V.clearSession();
      V.announce(t("common.signedOut"));
      showLogin();
    });
  }

  function start() {
    var s = V.getSession();
    if (!s || s.kind !== "candidate") return showLogin();
    S.session = s;
    V.api("GET", "/jobsearch/auth/me").then(function (me) {
      if (!me || me.role !== "Candidate" || !me.candidate_id) {
        V.clearSession();
        showLogin();
        $("#otp-error").textContent = t("otp.notCandidate");
        return;
      }
      S.candidateId = me.candidate_id;
      $("#login-view").hidden = true;
      $("#app-view").hidden = false;
      $("#logout").hidden = false;
      initStepper();
      S.events = V.connectEvents({
        onEvent: function () { refreshSoon(); },
        onStatus: V.liveIndicator($("#live-status")),
        refetch: function () { refreshState(false); },
      });
      refreshState(true);
    }).catch(function (err) {
      if (err && err.status !== 401) V.toast(V.errorMessage(err), "bad");
    });
  }

  var refreshSoon = V.debounce(function () { refreshState(false); }, 600);

  /** Reloads profile, consent, settings and eligibility; picks the first unfinished step on first load. */
  function refreshState(first) {
    if (!S.candidateId) return Promise.resolve();
    var profile = V.api("GET", base() + "/profile").catch(function (err) { if (err.status === 404) return null; throw err; });
    return Promise.all([profile, V.api("GET", base() + "/consent"), V.api("GET", base() + "/settings"), V.api("GET", base() + "/eligibility")])
      .then(function (r) {
        S.profile = r[0];
        S.consent = r[1];
        S.settings = r[2];
        S.eligibility = r[3];
        updateStepper();
        if (first) {
          var step = !S.profile ? "upload" : S.profile.status !== "confirmed" ? "review" : !S.consent.active ? "consent" : "status";
          goStep(step, false);
        } else if (S.step === "status") renderStatus();
        else if (S.step === "consent") renderConsent();
        else if (S.step === "upload") renderVersions();
      })
      .catch(function (err) { if (err && err.status !== 401) V.toast(V.errorMessage(err), "bad"); });
  }

  // ================================================================ stepper
  var stepperReady = false;
  function initStepper() {
    if (stepperReady) return;
    stepperReady = true;
    V.$all("#stepper [data-step]").forEach(function (b) {
      b.addEventListener("click", function () { goStep(b.getAttribute("data-step"), true); });
    });
    initUpload();
    $("#payments-refresh").addEventListener("click", function () { loadPayments(); });
    V.$all("#status-tabs [role=tab]").forEach(function (b, i, all) {
      b.addEventListener("click", function () { selectStatusTab(b.getAttribute("data-st"), true); });
      b.addEventListener("keydown", function (e) {
        var rtl = document.documentElement.dir === "rtl";
        var next = null;
        if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = all[(i + 1) % all.length];
        else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = all[(i - 1 + all.length) % all.length];
        if (next) { e.preventDefault(); next.focus(); selectStatusTab(next.getAttribute("data-st"), false); }
      });
    });
  }
  function stepDone(step) {
    if (step === "upload") return Boolean(S.profile);
    if (step === "review" || step === "prefs") return Boolean(S.profile && S.profile.status === "confirmed" && S.profile.preferences);
    if (step === "consent") return Boolean(S.consent && S.consent.active);
    return false;
  }
  function updateStepper() {
    V.$all("#stepper [data-step]").forEach(function (b) {
      var st = b.getAttribute("data-step");
      b.classList.toggle("done", stepDone(st));
      if (st === S.step) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
      var needsProfile = st === "review" || st === "prefs";
      b.disabled = needsProfile && !S.profile;
    });
  }
  function goStep(step, focus) {
    if (STEPS.indexOf(step) < 0) step = "upload";
    if ((step === "review" || step === "prefs") && !S.profile) step = "upload";
    S.step = step;
    STEPS.forEach(function (s) { $("#step-" + s).hidden = s !== step; });
    updateStepper();
    if (step === "upload") renderVersions();
    if (step === "review") renderReview();
    if (step === "prefs") renderPrefs();
    if (step === "consent") renderConsent();
    if (step === "status") renderStatus();
    if (step === "payments") loadPayments();
    if (focus) $("#step-" + step).focus();
  }

  V.onLang(function () {
    if (!S.candidateId) return;
    // Re-render dynamic content (keeps unsaved edits in the review form state).
    if (S.step === "review") renderReview(true);
    else goStep(S.step, false);
  });

  // ================================================================ 1 upload
  var UPLOAD_ERRORS = { 413: "upload.err413", 415: "upload.err415", 422: "upload.err422", 429: "upload.err429" };
  function initUpload() {
    $("#upload-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var input = $("#cv-file");
      var status = $("#upload-status");
      var file = input.files && input.files[0];
      if (!file) {
        input.setAttribute("aria-invalid", "true");
        status.textContent = t("upload.choose");
        input.focus();
        return;
      }
      input.removeAttribute("aria-invalid");
      if (file.size > 10 * 1024 * 1024) {
        status.textContent = t("upload.err413");
        return;
      }
      var bar = $("#upload-progress");
      bar.hidden = false;
      bar.value = 0;
      status.textContent = t("upload.uploading");
      var btn = $("#upload-form button[type=submit]");
      btn.disabled = true;
      V.upload(base() + "/cv", file, function (p) { bar.value = Math.round(p * 100); })
        .then(function (r) {
          bar.value = 100;
          S.profile = r.profile;
          S.dirty = {};
          input.value = "";
          var scanMsg = r.scan && r.scan.status === "clean" ? t("upload.scanClean") : t("upload.scanUnavailable");
          status.textContent = t("upload.done", { version: V.fmtNumber(r.version) }) + " " + scanMsg;
          V.announce(status.textContent);
          updateStepper();
          renderVersions();
          window.setTimeout(function () { goStep("review", true); }, 600);
        })
        .catch(function (err) {
          var key = err && UPLOAD_ERRORS[err.status];
          status.textContent = key ? t(key) : V.errorMessage(err);
          V.toast(status.textContent, "bad");
        })
        .finally(function () {
          btn.disabled = false;
          window.setTimeout(function () { bar.hidden = true; }, 1500);
        });
    });
  }
  var CV_LANGS = ["en", "fr", "ar"];
  function scanBadge(f) {
    return h("span", { class: "badge " + (f.scan_status === "clean" ? "ok" : f.scan_status === "infected" ? "bad" : "warn"), text: tc("scan", f.scan_status) });
  }
  function renderVersions() {
    var box = $("#cv-versions");
    var files = S.profile && S.profile.cv_files ? S.profile.cv_files : [];
    if (!files.length) return V.setContent(box, h("p", { class: "small muted", text: t("upload.noneYet") }));
    V.setContent(box, h("h3", { text: t("upload.versions") }),
      h("p", { class: "notice info small", text: t("cv.approveExplain") }),
      h("ul", { class: "plain" }, files.slice().reverse().map(cvVersionItem)));
  }
  /** One CV version: scan status, approval state, and (unless infected or already approved) the approval form. */
  function cvVersionItem(f) {
    var li = h("li", { class: "card" },
      h("p", null, h("strong", { text: t("upload.version", { n: V.fmtNumber(f.version) }) }), " · ", V.fmtDateTime(f.created_at), " · ", scanBadge(f),
        f.approved ? [" ", h("span", { class: "badge ok", text: t("cv.approvedIn", { lang: cvLangName(f.language) }) })] : null));
    if (f.scan_status === "scan_unavailable") li.appendChild(h("p", { class: "small notice warn", text: t("cv.unscannedNotice") }));
    if (f.scan_status === "infected") {
      li.appendChild(h("p", { class: "small notice bad", text: t("cv.infectedNoApprove") }));
      return li;
    }
    if (f.approved) return li;
    var selId = "cv-lang-" + f.id;
    var otherId = "cv-lang-other-" + f.id;
    var sel = h("select", { id: selId }, CV_LANGS.map(function (l) { return h("option", { value: l, text: t("cv.lang." + l) }); }), h("option", { value: "other", text: t("cv.lang.other") }));
    var other = h("input", { id: otherId, type: "text", attrs: { maxlength: "2", autocomplete: "off", inputmode: "latin", pattern: "[A-Za-z]{2}" } });
    var otherField = h("div", { class: "field" }, h("label", { for: otherId, text: t("cv.otherCode") }), other);
    otherField.hidden = true;
    sel.addEventListener("change", function () { otherField.hidden = sel.value !== "other"; });
    var btn = h("button", { type: "submit", class: "btn small", text: t("cv.approveButton"), attrs: { "aria-label": t("cv.approveNamed", { n: V.fmtNumber(f.version) }) } });
    var form = h("form", { class: "inline-fields", attrs: { novalidate: true } },
      h("div", { class: "field" }, h("label", { for: selId, text: t("cv.language") }), sel), otherField, btn);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var lang = sel.value;
      if (lang === "other") {
        lang = other.value.trim().toLowerCase();
        if (!/^[a-z]{2}$/.test(lang)) {
          other.setAttribute("aria-invalid", "true");
          other.focus();
          V.toast(t("cv.badCode"), "bad");
          return;
        }
        other.removeAttribute("aria-invalid");
      }
      V.busy(btn, function () {
        return V.api("POST", "/jobsearch/cv-files/" + f.id + "/approve", { body: { language: lang } }).then(function () {
          var msg = t("cv.approvedDone", { n: V.fmtNumber(f.version) });
          V.toast(msg, "ok");
          V.announce(msg);
          return refreshState(false);
        });
      }).catch(function () {});
    });
    li.appendChild(form);
    return li;
  }
  function cvLangName(code) {
    return CV_LANGS.indexOf(code) >= 0 ? t("cv.lang." + code) : String(code || "—").toUpperCase();
  }
  function hasApprovedCv() {
    return Boolean(S.profile && (S.profile.cv_files || []).some(function (f) { return f.approved && f.scan_status !== "infected"; }));
  }

  // ================================================================ 2 review extracted fields
  function sourceValues() {
    var p = S.profile || {};
    return (p.status === "confirmed" ? p.confirmed : p.extracted) || {};
  }
  function hasValue(v) { return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== ""; }
  function provBadge(field, value) {
    var prov = (S.profile && S.profile.provenance) || {};
    var span;
    if (S.dirty[field]) span = h("span", { class: "prov edited", text: t("prov.edited") });
    else if (!hasValue(value)) span = h("span", { class: "prov missing", text: t("prov.missing") });
    else if (prov[field] === "cv") span = h("span", { class: "prov cv", text: t("prov.cv") });
    else if (prov[field] === "candidate") span = h("span", { class: "prov edited", text: t("prov.edited") });
    else if (typeof prov[field] === "string" && prov[field].indexOf("staff:") === 0) span = h("span", { class: "prov edited", text: t("prov.staff") });
    else span = h("span", { class: "prov cv", text: t("prov.cv") });
    span.id = "prov-" + field;
    return span;
  }
  function markDirty(field) {
    S.dirty[field] = true;
    var old = document.getElementById("prov-" + field);
    if (old) old.replaceWith(provBadge(field, "x"));
  }

  function rowsEditor(field, items, cols) {
    var wrap = h("div", { class: "rows", id: "rows-" + field });
    var add = function (item) {
      var idx = wrap.querySelectorAll(".row").length + 1;
      var row = h("div", { class: "row" + (cols.length === 2 ? " two" : "") });
      cols.forEach(function (c) {
        var id = field + "-" + c + "-" + idx + "-" + Math.random().toString(36).slice(2, 6);
        var input = h("input", { id: id, type: "text", value: item && item[c] ? String(item[c]) : "", attrs: { maxlength: "200", "data-col": c } });
        input.addEventListener("input", function () { markDirty(field); });
        row.appendChild(h("div", { class: "field" }, h("label", { for: id, text: t("field." + field + "." + c) }), input));
      });
      var rm = h("button", { type: "button", class: "btn secondary small", text: t("common.remove") });
      rm.addEventListener("click", function () { row.remove(); markDirty(field); });
      row.appendChild(rm);
      wrap.appendChild(row);
    };
    (items || []).forEach(add);
    var addBtn = h("button", { type: "button", class: "btn secondary small", text: t("review.addRow") });
    addBtn.addEventListener("click", function () { add(null); markDirty(field); var last = wrap.lastElementChild; if (last) last.querySelector("input").focus(); });
    return h("div", null, wrap, addBtn);
  }

  function renderReview(keepDirty) {
    var form = $("#review-form");
    if (!S.profile) return V.setContent(form, V.empty(t("review.uploadFirst")));
    if (!keepDirty) S.dirty = {};
    var vals = sourceValues();
    var pending = keepDirty && S.pendingEdits ? S.pendingEdits : null;
    var get = function (f) { return pending && f in pending ? pending[f] : vals[f]; };
    var out = [];
    out.push(h("p", { class: "small" }, h("span", { class: "badge " + (S.profile.status === "confirmed" ? "ok" : "warn"), text: S.profile.status === "confirmed" ? t("review.confirmed") : t("review.toConfirm") })));
    SCALARS.forEach(function (f) {
      var v = get(f);
      var id = "pf-" + f;
      var input = h("input", { id: id, type: f === "email" ? "email" : f === "phone" ? "text" : "text", value: hasValue(v) ? String(v) : "", attrs: { maxlength: "200", autocomplete: f === "name" ? "name" : f === "email" ? "email" : f === "phone" ? "tel" : "off", "aria-describedby": "prov-" + f } });
      input.addEventListener("input", function () { markDirty(f); });
      out.push(h("div", { class: "field" }, h("label", { for: id }, t("field." + f), provBadge(f, v)), input));
    });
    LISTS.forEach(function (f) {
      var v = get(f) || [];
      var id = "pf-" + f;
      var ta = h("textarea", { id: id, value: (Array.isArray(v) ? v : []).join("\n"), attrs: { rows: "4", "aria-describedby": "prov-" + f + " hint-" + f } });
      ta.addEventListener("input", function () { markDirty(f); });
      out.push(h("div", { class: "field" }, h("label", { for: id }, t("field." + f), provBadge(f, v)), ta, h("span", { class: "hint", id: "hint-" + f, text: t("review.onePerLine") })));
    });
    var exp = get("experience") || [];
    out.push(h("fieldset", null, h("legend", null, t("field.experience"), provBadge("experience", exp)), rowsEditor("experience", exp, ["title", "employer", "start", "end"])));
    var langs = get("languages") || [];
    out.push(h("fieldset", null, h("legend", null, t("field.languages"), provBadge("languages", langs)), rowsEditor("languages", langs, ["lang", "level"])));
    var next = h("button", { type: "submit", class: "btn", text: t("review.next") });
    out.push(h("p", { class: "small muted", text: t("review.saveHint") }));
    out.push(next);
    V.setContent(form, out);
    if (!form.dataset.wired) {
      form.dataset.wired = "1";
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var problem = validateReview();
        if (problem) {
          problem.setAttribute("aria-invalid", "true");
          problem.focus();
          V.toast(t("review.invalid"), "bad");
          return;
        }
        S.pendingEdits = collectEdits();
        goStep("prefs", true);
      });
    }
  }
  function validateReview() {
    var email = $("#pf-email");
    if (email && email.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) return email;
    var bad = null;
    V.$all("#rows-languages .row").forEach(function (row) {
      var lang = row.querySelector("[data-col=lang]");
      var level = row.querySelector("[data-col=level]");
      if (!bad && !lang.value.trim() && level.value.trim()) bad = lang;
    });
    return bad;
  }
  /** Only fields the candidate changed are sent; untouched fields keep their CV provenance. */
  function collectEdits() {
    var edits = {};
    SCALARS.forEach(function (f) {
      if (!S.dirty[f]) return;
      var v = $("#pf-" + f).value.trim();
      edits[f] = v ? v : null;
    });
    LISTS.forEach(function (f) {
      if (!S.dirty[f]) return;
      edits[f] = $("#pf-" + f).value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
    });
    var rows = function (field, cols) {
      return V.$all("#rows-" + field + " .row").map(function (row) {
        var o = {};
        cols.forEach(function (c) { var v = row.querySelector("[data-col=" + c + "]").value.trim(); o[c] = v || null; });
        return o;
      }).filter(function (o) { return cols.some(function (c) { return o[c]; }); });
    };
    if (S.dirty.experience) edits.experience = rows("experience", ["title", "employer", "start", "end"]);
    if (S.dirty.languages) edits.languages = rows("languages", ["lang", "level"]).filter(function (l) { return l.lang; });
    return edits;
  }

  // ================================================================ 3 preferences (+ confirm)
  function checkbox(name, value, label, checked, extra) {
    var id = name + "-" + value.replace(/\W+/g, "_");
    return h("div", { class: "check" }, h("input", { id: id, type: "checkbox", name: name, value: value, checked: checked }), h("label", { for: id }, label, extra || null));
  }
  function renderPrefs() {
    var form = $("#prefs-form");
    if (!S.profile) return V.setContent(form, V.empty(t("review.uploadFirst")));
    var p = S.profile.preferences || {};
    var countries = p.countries || [];
    var cats = p.categories || [];
    var otherCountries = countries.filter(function (c) { return PRIORITY_COUNTRIES.indexOf(c) < 0; });
    var otherCats = cats.filter(function (c) { return CATEGORIES.indexOf(c) < 0; });
    var avail = h("select", { id: "pr-avail", attrs: { required: true } }, h("option", { value: "", text: t("common.choose") }), AVAILABILITY.map(function (a) { return h("option", { value: a, text: tc("avail", a), selected: p.availability === a }); }));
    if (p.availability && AVAILABILITY.indexOf(p.availability) < 0) avail.appendChild(h("option", { value: p.availability, text: p.availability, selected: true }));
    var cur = h("select", { id: "pr-currency", attrs: { required: true } }, h("option", { value: "", text: t("common.choose") }), CURRENCIES.map(function (c) { return h("option", { value: c, text: c, selected: p.salary_currency === c }); }));
    if (p.salary_currency && CURRENCIES.indexOf(p.salary_currency) < 0) cur.appendChild(h("option", { value: p.salary_currency, text: p.salary_currency, selected: true }));
    var supportYes = h("input", { id: "pr-support-yes", type: "radio", name: "support", value: "yes", checked: p.needs_work_auth_support === true });
    var supportNo = h("input", { id: "pr-support-no", type: "radio", name: "support", value: "no", checked: p.needs_work_auth_support === false });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var save = h("button", { type: "submit", class: "btn", text: t("prefs.save") });
    V.setContent(form,
      h("fieldset", { id: "pr-countries" }, h("legend", { text: t("prefs.countries") }),
        PRIORITY_COUNTRIES.map(function (c, i) { return checkbox("country", c, tc("country", c), countries.indexOf(c) >= 0, i === 0 ? h("span", { class: "badge gold", text: t("prefs.priority") }) : null); }),
        h("div", { class: "field" }, h("label", { for: "pr-country-other", text: t("prefs.otherCountries") }), h("input", { id: "pr-country-other", type: "text", value: otherCountries.join(", "), attrs: { maxlength: "500" } }), h("span", { class: "hint", text: t("prefs.commaHint") }))),
      h("fieldset", { id: "pr-categories" }, h("legend", { text: t("prefs.categories") }),
        h("div", { class: "inline-fields" }, CATEGORIES.map(function (c) { return checkbox("category", c, tc("cat", c), cats.indexOf(c) >= 0); })),
        h("div", { class: "field" }, h("label", { for: "pr-cat-other", text: t("prefs.otherCategories") }), h("input", { id: "pr-cat-other", type: "text", value: otherCats.join(", "), attrs: { maxlength: "500" } }), h("span", { class: "hint", text: t("prefs.commaHint") }))),
      h("div", { class: "field" }, h("label", { for: "pr-avail", text: t("prefs.availability") }), avail),
      h("div", { class: "inline-fields" },
        h("div", { class: "field" }, h("label", { for: "pr-salary", text: t("prefs.salary") }), h("input", { id: "pr-salary", type: "number", value: p.salary_min !== undefined && p.salary_min !== null ? String(p.salary_min) : "", attrs: { min: "0", step: "1", inputmode: "numeric", required: true } }), h("span", { class: "hint", text: t("prefs.salaryHint") })),
        h("div", { class: "field" }, h("label", { for: "pr-currency", text: t("prefs.currency") }), cur)),
      h("div", { class: "field" }, h("label", { for: "pr-residence", text: t("prefs.residence") }), h("input", { id: "pr-residence", type: "text", value: p.residence_country || "", attrs: { maxlength: "100", required: true, autocomplete: "country-name" } })),
      h("fieldset", { id: "pr-support" }, h("legend", { text: t("prefs.support") }),
        h("p", { class: "hint", text: t("prefs.supportHint") }),
        h("div", { class: "check" }, supportYes, h("label", { for: "pr-support-yes", text: t("common.yes") })),
        h("div", { class: "check" }, supportNo, h("label", { for: "pr-support-no", text: t("common.no") }))),
      S.pendingEdits && Object.keys(S.pendingEdits).length ? h("p", { class: "notice info small", text: t("prefs.pendingEdits", { n: V.fmtNumber(Object.keys(S.pendingEdits).length) }) }) : null,
      h("p", { class: "notice info small", text: t("prefs.confirmNote") }),
      err, save);
    if (form.dataset.wired) return;
    form.dataset.wired = "1";
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var err = form.querySelector(".form-error");
      err.textContent = "";
      V.$all("[aria-invalid]", form).forEach(function (x) { x.removeAttribute("aria-invalid"); });
      var split = function (v) { return v.split(",").map(function (x) { return x.trim(); }).filter(Boolean); };
      var checked = function (name) { return V.$all("input[name=" + name + "]:checked", form).map(function (x) { return x.value; }); };
      var countriesV = checked("country").concat(split($("#pr-country-other").value));
      var catsV = checked("category").concat(split($("#pr-cat-other").value));
      var salaryRaw = $("#pr-salary").value;
      var supportV = V.$all("input[name=support]:checked", form).map(function (x) { return x.value; })[0];
      var fail = function (el, key) {
        var target = el.tagName === "FIELDSET" ? el.querySelector("input") : el;
        el.setAttribute("aria-invalid", "true");
        err.textContent = t(key);
        target.focus();
      };
      if (!countriesV.length) return fail($("#pr-countries"), "prefs.errCountries");
      if (!catsV.length) return fail($("#pr-categories"), "prefs.errCategories");
      if (!$("#pr-avail").value) return fail($("#pr-avail"), "prefs.errAvailability");
      if (salaryRaw === "" || isNaN(Number(salaryRaw)) || Number(salaryRaw) < 0) return fail($("#pr-salary"), "prefs.errSalary");
      if (!$("#pr-currency").value) return fail($("#pr-currency"), "prefs.errCurrency");
      if (!$("#pr-residence").value.trim()) return fail($("#pr-residence"), "prefs.errResidence");
      if (!supportV) return fail($("#pr-support"), "prefs.errSupport");
      var preferences = {
        countries: countriesV,
        categories: catsV,
        availability: $("#pr-avail").value,
        salary_expectation: Number(salaryRaw),
        salary_currency: $("#pr-currency").value,
        residence_country: $("#pr-residence").value.trim(),
        needs_work_auth_support: supportV === "yes",
      };
      var btn = form.querySelector("button[type=submit]");
      V.busy(btn, function () {
        return V.api("PUT", base() + "/profile/confirm", { body: { edits: S.pendingEdits || {}, preferences: preferences } }).then(function (profile) {
          S.profile = profile;
          S.pendingEdits = null;
          S.dirty = {};
          V.toast(t("prefs.saved"), "ok");
          V.announce(t("prefs.saved"));
          goStep(S.consent && S.consent.active ? "status" : "consent", true);
        });
      }).catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
  }

  // ================================================================ 4 consent
  var SCOPE_KEYS = ["search", "prepare", "submit"];
  function renderConsent() {
    var box = $("#consent-box");
    var active = S.consent && S.consent.active;
    var scope = active ? active.scope || {} : {};
    var prefsCountries = S.profile && S.profile.preferences ? S.profile.preferences.countries || [] : [];
    var out = [];
    out.push(h("div", { class: "notice info" },
      h("p", null, h("strong", { text: t("consent.versionLabel") + ": " }), h("span", { class: "ltr-island mono", text: CONSENT_VERSION })),
      h("p", { text: t("consent.text1") }),
      h("p", { text: t("consent.text2") }),
      h("p", { text: t("consent.text3") }),
      h("p", null, h("strong", { text: t("upload.noSend") }))));
    var boxes = SCOPE_KEYS.map(function (k) {
      return h("div", { class: "check" },
        h("input", { id: "cs-" + k, type: "checkbox", checked: scope[k] === true }),
        h("label", { for: "cs-" + k }, h("strong", { text: t("consent." + k) }), h("span", { class: "hint", text: t("consent." + k + "Hint") })));
    });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var grant = h("button", { type: "submit", class: "btn", text: active ? t("consent.update") : t("consent.grant") });
    var form = h("form", { attrs: { novalidate: true } },
      h("fieldset", null, h("legend", { text: t("consent.scopes") }), boxes,
        h("p", { class: "small" }, t("consent.countriesLine") + " ", prefsCountries.length ? prefsCountries.map(function (c) { return tc("country", c); }).join(", ") : t("consent.noCountries"))),
      err, grant);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      var sc = {};
      SCOPE_KEYS.forEach(function (k) { sc[k] = $("#cs-" + k).checked; });
      if (!sc.search && !sc.prepare && !sc.submit) { err.textContent = t("consent.pickOne"); $("#cs-search").focus(); return; }
      sc.countries = prefsCountries;
      var go = function () {
        V.busy(grant, function () {
          return V.api("POST", base() + "/consent", { body: { scope: sc, version: CONSENT_VERSION } }).then(function () {
            V.toast(t("consent.saved"), "ok");
            V.announce(t("consent.saved"));
            return refreshState(false);
          });
        }).catch(function (e2) { err.textContent = V.errorMessage(e2); });
      };
      // Narrowing (unticking a key that is currently granted) stops work: confirm it like a withdrawal.
      var narrowed = active ? SCOPE_KEYS.filter(function (k) { return scope[k] === true && !sc[k]; }) : [];
      var steps = [];
      if (narrowed.length) steps.push([t("consent.withdrawConfirm", { scope: narrowed.map(function (k) { return t("consent." + k); }).join(", ") }), t("consent.withdraw"), true]);
      if (sc.submit && !scope.submit) steps.push([t("consent.submitConfirm"), t("consent.grant"), false]);
      var ask = function (i) {
        if (i >= steps.length) return go();
        V.confirmDialog(steps[i][0], steps[i][1], steps[i][2]).then(function (ok) { if (ok) ask(i + 1); });
      };
      ask(0);
    });
    out.push(form);

    if (active) {
      var current = h("div", { class: "card" }, h("h3", { text: t("consent.current") }),
        h("p", { class: "small", text: t("consent.grantedOn", { at: V.fmtDateTime(active.granted_at), version: active.version }) }));
      var list = h("ul", { class: "plain" });
      SCOPE_KEYS.forEach(function (k) {
        var on = scope[k] === true;
        var li = h("li", { class: "btn-row" }, h("span", { class: "badge " + (on ? "ok" : "neutral"), text: t("consent." + k) + ": " + (on ? t("consent.on") : t("consent.off")) }));
        if (on) {
          var w = h("button", { type: "button", class: "btn secondary small", text: t("consent.withdraw"), attrs: { "aria-label": t("consent.withdrawNamed", { scope: t("consent." + k) }) } });
          w.addEventListener("click", function () { withdraw(k, w); });
          li.appendChild(w);
        }
        list.appendChild(li);
      });
      current.appendChild(list);
      var all = h("button", { type: "button", class: "btn danger small", text: t("consent.withdrawAll") });
      all.addEventListener("click", function () { withdraw("all", all); });
      current.appendChild(all);
      out.push(current);
    }

    // pause + mode
    var st = S.settings || {};
    var paused = Boolean(st.paused);
    var pauseBtn = h("button", { type: "button", class: "btn secondary", text: paused ? t("pause.resume") : t("pause.pause"), attrs: { "aria-pressed": String(paused) } });
    pauseBtn.addEventListener("click", function () {
      V.busy(pauseBtn, function () {
        return V.api("POST", base() + "/pause", { body: { paused: !paused } }).then(function () {
          V.toast(paused ? t("pause.resumed") : t("pause.paused"), "ok");
          return refreshState(false);
        });
      }).catch(function () {});
    });
    out.push(h("div", { class: "card" }, h("h3", { text: t("pause.title") }),
      h("p", null, h("span", { class: "badge " + (paused ? "warn" : "ok"), text: paused ? t("pause.isPaused") : t("pause.isActive") })),
      h("p", { class: "small", text: t("pause.hint") }), pauseBtn));
    out.push(h("div", { class: "card" }, h("h3", { text: t("mode.title") }),
      h("p", null, h("span", { class: "badge info", text: tc("mode", st.mode || "search_only") })),
      h("p", { class: "small", text: tc("modeHelp", st.mode || "search_only") }),
      h("p", { class: "small muted", text: t("mode.staffSets") })));
    var el = S.eligibility;
    if (el) out.push(h("div", { class: "card" }, h("h3", { text: t("elig.title") }),
      h("p", null, h("span", { class: "badge " + (el.eligible ? "ok" : "warn"), text: el.eligible ? t("elig.yes") : t("elig.no") })),
      el.eligible ? null : V.listOf(el.reasons.map(function (r) { return tc("elig", r); }))));
    if (active) {
      var go = h("button", { type: "button", class: "btn", text: t("consent.toStatus") });
      go.addEventListener("click", function () { goStep("status", true); });
      out.push(go);
    }
    V.setContent(box, out);
  }
  function withdraw(key, btn) {
    var label = key === "all" ? t("consent.all") : t("consent." + key);
    V.confirmDialog(t("consent.withdrawConfirm", { scope: label }), t("consent.withdraw"), true).then(function (ok) {
      if (!ok) return;
      V.busy(btn, function () {
        return V.api("POST", base() + "/consent/withdraw", { body: { scopeKey: key } }).then(function (r) {
          V.toast(t("consent.withdrawn", { n: V.fmtNumber(r.cancelledApplications || 0) }), "ok");
          return refreshState(false);
        });
      }).catch(function () {});
    });
  }

  // ================================================================ status
  function selectStatusTab(name, focus) {
    S.statusTab = name;
    V.$all("#status-tabs [role=tab]").forEach(function (b) {
      var on = b.getAttribute("data-st") === name;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    ["matches", "apps", "interviews", "messages"].forEach(function (k) { $("#sp-" + k).hidden = k !== name; });
    loadStatusTab();
    if (focus) $("#sp-" + name).focus();
  }
  function renderStatus() {
    var st = S.settings || {};
    var el = S.eligibility || { eligible: false, reasons: [] };
    V.setContent($("#status-summary"), h("div", { class: "card" },
      h("p", { class: "btn-row" },
        h("span", { class: "badge info", text: t("mode.title") + ": " + tc("mode", st.mode || "search_only") }),
        h("span", { class: "badge " + (st.paused ? "warn" : "ok"), text: st.paused ? t("pause.isPaused") : t("pause.isActive") }),
        h("span", { class: "badge " + (el.eligible ? "ok" : "warn"), text: el.eligible ? t("elig.yes") : t("elig.no") })),
      el.eligible ? null : h("p", { class: "small", text: el.reasons.map(function (r) { return tc("elig", r); }).join(" · ") }),
      hasApprovedCv() ? null : noApprovedCvNotice()));
    selectStatusTab(S.statusTab, false);
  }
  function noApprovedCvNotice() {
    var go = h("button", { type: "button", class: "btn secondary small", text: t("cv.goApprove") });
    go.addEventListener("click", function () { goStep("upload", true); });
    return h("div", { class: "notice warn small" }, h("p", { text: t("cv.noneApproved") }), go);
  }
  function loadStatusTab() {
    var loaders = { matches: loadMatches, apps: loadApps, interviews: loadInterviews, messages: loadMessages };
    loaders[S.statusTab]();
  }

  function loadMatches() {
    var box = $("#sp-matches");
    if (!box.firstChild) V.setContent(box, V.loading());
    V.api("GET", base() + "/matches?pageSize=50").then(function (r) {
      var out = [h("p", { class: "notice info small", text: t("match.notice") })];
      if (!r.matches.length) out.push(V.empty(t("matches.none")));
      r.matches.forEach(function (m) {
        out.push(h("article", { class: "card", attrs: { "aria-label": m.job.title } },
          h("div", { class: "card-head" }, h("h3", { text: m.job.title }), h("span", { class: "spacer" }), h("span", { class: "score", text: V.fmtNumber(m.score) + " / 100" })),
          h("p", { class: "small muted", text: [m.job.employer, m.job.location, m.job.country].filter(Boolean).join(" · ") + " · " + t("matches.seen", { at: V.fmtDate(m.firstSeen) }) }),
          V.supportBlock(m.employerSupport),
          V.overseasBlock(m.overseas),
          h("details", null, h("summary", { text: t("matches.why") }), V.scoreBlock(m)),
          m.job.url ? h("p", null, V.safeLink(m.job.url, t("drawer.openAd"))) : null));
      });
      V.setContent(box, out);
    }).catch(function (err) { V.setContent(box, errorBox(err)); });
  }

  function loadApps() {
    var box = $("#sp-apps");
    if (!box.firstChild) V.setContent(box, V.loading());
    V.api("GET", "/jobsearch/applications?pageSize=100").then(function (r) {
      if (!r.applications.length) return V.setContent(box, V.empty(t("apps.noneCandidate")));
      var list = h("ul", { class: "plain" }, r.applications.map(function (a) {
        var b = h("button", { type: "button", class: "btn secondary small", text: t("apps.details"), attrs: { "aria-expanded": String(S.appDetail === a.id) } });
        var detail = h("div", { id: "app-detail-" + a.id });
        b.addEventListener("click", function () {
          var open = S.appDetail === a.id;
          V.$all("[id^=app-detail-]").forEach(function (d) { V.clear(d); });
          V.$all("#sp-apps [aria-expanded]").forEach(function (x) { x.setAttribute("aria-expanded", "false"); });
          S.appDetail = open ? null : a.id;
          if (!open) {
            b.setAttribute("aria-expanded", "true");
            loadAppDetail(a.id, detail);
          }
        });
        return h("li", { class: "card" },
          h("div", { class: "card-head" }, h("h3", { text: a.job.title }), h("span", { class: "spacer" }), statusFor(a.status)),
          h("p", { class: "small muted", text: [a.employer.name, a.job.location, a.job.country].filter(Boolean).join(" · ") + " · " + t("apps.updatedAt", { at: V.fmtDateTime(a.updatedAt) }) }),
          b, detail);
      }));
      V.setContent(box, list);
      if (S.appDetail) {
        var d = document.getElementById("app-detail-" + S.appDetail);
        if (d) loadAppDetail(S.appDetail, d);
      }
    }).catch(function (err) { V.setContent(box, errorBox(err)); });
  }
  /** "Submitted" wording only where the stored evidence says so: sent = awaiting confirmation. */
  function statusFor(status) {
    if (status === "sent") return h("span", { class: "badge warn", text: t("status.sentAwaiting") });
    return V.statusBadge(status);
  }

  function loadAppDetail(id, box) {
    V.setContent(box, V.loading());
    Promise.all([
      V.api("GET", "/jobsearch/applications/" + id),
      V.api("GET", "/jobsearch/submissions?applicationId=" + id).catch(function () { return { submissions: [] }; }),
    ]).then(function (r) {
      var d = r[0];
      var subs = r[1].submissions || [];
      var out = [];
      if (d.match) out.push(V.supportBlock(d.match.employerSupport));
      if (subs.length) {
        out.push(h("h4", { text: t("apps.sending") }));
        out.push(h("ul", { class: "compact" }, subs.map(function (s) {
          return h("li", { text: tc("candSub", s.status) + (s.sentAt ? " · " + V.fmtDateTime(s.sentAt) : "") + (s.confirmedAt ? " · " + t("apps.confirmedAt", { at: V.fmtDateTime(s.confirmedAt) }) : "") });
        })));
      }
      out.push(h("h4", { text: t("drawer.timeline") }));
      var tl = h("ol", { class: "timeline" });
      (d.timeline || []).forEach(function (e) {
        var det = e.detail || {};
        var bits = [];
        if (det.from || det.to) bits.push(tc("status", det.from) + " → " + tc("status", det.to));
        if (det.reason) bits.push(V.reasonLabel(det.reason));
        tl.appendChild(h("li", null, h("strong", { text: tc("event", e.event) }), bits.length ? h("div", { class: "small", text: bits.join(" · ") }) : null, h("div", { class: "when", text: V.fmtDateTime(e.at) })));
      });
      out.push((d.timeline || []).length ? tl : V.empty());
      out.push(sharingBlock(d, box));
      V.setContent(box, out);
    }).catch(function (err) { V.setContent(box, errorBox(err)); });
  }

  /** Candidate-only: authorize (or revoke) sharing ONE document with the employer of ONE application. */
  function sharingBlock(d, box) {
    var a = d.application;
    var sec = h("div", { class: "notice" }, h("h4", { text: t("share.title") }), h("p", { class: "small", text: t("share.hint") }));
    var auths = (d.sharingAuthorizations || []);
    if (auths.length) {
      sec.appendChild(h("ul", { class: "plain" }, auths.map(function (x) {
        var li = h("li", { class: "small" }, t("share.docLine", { id: x.documentId }) + " · " + V.fmtDateTime(x.grantedAt) + " · ", h("q", { text: x.legitimateNeed || "" }), " ",
          x.revokedAt ? h("span", { class: "badge neutral", text: t("share.revoked") }) : h("span", { class: "badge ok", text: t("share.active") }));
        if (!x.revokedAt) {
          var rv = h("button", { type: "button", class: "btn secondary small", text: t("share.revoke") });
          rv.addEventListener("click", function () {
            V.confirmDialog(t("share.revokeConfirm"), t("share.revoke"), true).then(function (ok) {
              if (ok) V.busy(rv, function () { return V.api("DELETE", "/jobsearch/applications/" + a.id + "/sharing-authorizations/" + x.id).then(function () { V.toast(t("share.revokedDone"), "ok"); loadAppDetail(a.id, box); }); }).catch(function () {});
            });
          });
          li.appendChild(rv);
        }
        return li;
      })));
    }
    // documents this application needs: package documents + blocked (not yet authorized) documents
    var docIds = {};
    (d.documents || []).forEach(function (x) { if (x.documentId && !x.removedAt) docIds[x.documentId] = x.docType; });
    (a.packageBlocked || []).forEach(function (b) { if (b && b.doc && b.doc.documentId) docIds[b.doc.documentId] = b.doc.docType || null; });
    var ids = Object.keys(docIds);
    var open = ["matched", "preparing", "ready_for_review", "approved", "queued", "needs_staff", "failed"].indexOf(a.status) >= 0;
    if (!ids.length || !open) {
      sec.appendChild(h("p", { class: "small muted", text: t("share.nothing") }));
      return sec;
    }
    var sel = h("select", { id: "share-doc-" + a.id }, ids.map(function (k) { return h("option", { value: k, text: (docIds[k] ? tc("docType", docIds[k]) : t("share.document")) + " #" + k }); }));
    var need = h("textarea", { id: "share-need-" + a.id, attrs: { rows: "2", maxlength: "500", required: true } });
    var btn = h("button", { type: "submit", class: "btn small", text: t("share.grant") });
    var f = h("form", { attrs: { novalidate: true } },
      h("div", { class: "field" }, h("label", { for: "share-doc-" + a.id, text: t("share.document") }), sel),
      h("div", { class: "field" }, h("label", { for: "share-need-" + a.id, text: t("share.need") }), need, h("span", { class: "hint", text: t("share.needHint") })),
      btn);
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!need.value.trim()) { need.setAttribute("aria-invalid", "true"); need.focus(); V.toast(t("share.needRequired"), "bad"); return; }
      V.confirmDialog(t("share.grantConfirm"), t("share.grant")).then(function (ok) {
        if (!ok) return;
        V.busy(btn, function () {
          return V.api("POST", "/jobsearch/applications/" + a.id + "/sharing-authorizations", { body: { documentId: Number(sel.value), legitimateNeed: need.value.trim() } }).then(function () { V.toast(t("share.granted"), "ok"); loadAppDetail(a.id, box); });
        }).catch(function () {});
      });
    });
    sec.appendChild(f);
    return sec;
  }

  function loadInterviews() {
    var box = $("#sp-interviews");
    if (!box.firstChild) V.setContent(box, V.loading());
    V.api("GET", "/jobsearch/interviews").then(function (r) {
      if (!r.interviews.length) return V.setContent(box, V.empty(t("interviews.none")));
      V.setContent(box, h("ul", { class: "plain" }, r.interviews.map(function (iv) {
        var li = h("li", { class: "card" },
          h("p", null, h("strong", { text: iv.title || t("interviews.interview") }), " ", h("span", { class: "badge " + (iv.status === "confirmed" ? "ok" : iv.status === "cancelled" ? "neutral" : "warn"), text: tc("ivStatus", iv.status) })),
          V.interviewTimes(iv));
        if (iv.status === "tentative") {
          var b = h("button", { type: "button", class: "btn", text: t("interviews.confirmMine") });
          b.addEventListener("click", function () {
            V.confirmDialog(t("interviews.confirmMineQuestion", { when: V.fmtDateTime(iv.startsAtUtc, iv.tz) }), t("interviews.confirmMine")).then(function (ok) {
              if (ok) V.busy(b, function () { return V.api("POST", "/jobsearch/interviews/" + iv.id + "/availability", { body: { available: true } }).then(function () { V.toast(t("interviews.confirmedMine"), "ok"); loadInterviews(); }); }).catch(function () {});
            });
          });
          li.appendChild(h("p", { class: "small", text: t("interviews.tentativeHint") }));
          li.appendChild(b);
        }
        return li;
      })));
    }).catch(function (err) { V.setContent(box, errorBox(err)); });
  }

  function loadMessages() {
    var box = $("#sp-messages");
    if (!box.firstChild) V.setContent(box, V.loading());
    V.api("GET", "/jobsearch/messages").then(function (r) {
      var out = [h("p", { class: "small muted", text: t("messages.hint") })];
      if (!r.messages.length) out.push(V.empty(t("messages.none")));
      r.messages.forEach(function (m) {
        out.push(h("article", { class: "card" },
          h("p", { class: "small muted" }, V.fmtDateTime(m.receivedAt), m.category ? [" · ", h("span", { class: "badge info", text: tc("category", m.category) })] : null),
          h("p", { text: m.summary || t("messages.noSummary") })));
      });
      V.setContent(box, out);
    }).catch(function (err) { V.setContent(box, errorBox(err)); });
  }

  // ================================================================ my payments (read only)
  // GET /finance/me answers with this candidate's invoices (items, payments) and per-currency totals. Everything is
  // shown as the decimal strings the server sent (no sums here). Staff notes, references and refund details are never
  // sent to a candidate. The print page is fetched with the bearer token and opened from a blob: URL.
  var FU = window.VITA_FIN_UTIL;
  var payState = { data: null, error: null };

  function money(v, cur) { return h("span", { class: "ltr-island", text: FU.formatMoney(v, cur) }); }
  function dateText(v) { return v ? h("span", { class: "ltr-island", text: String(v).slice(0, 10) }) : "\u2014"; }

  function loadPayments() {
    var box = $("#payments-box");
    if (!payState.data) V.setContent(box, V.loading());
    return V.api("GET", "/finance/me")
      .then(function (d) { payState.data = d; payState.error = null; renderPayments(); })
      .catch(function (err) { payState.error = err; V.setContent(box, errorBox(err)); });
  }

  function openInvoicePrint(inv, button) {
    V.busy(button, function () {
      return V.download("/finance/me/invoices/" + inv.id + "/print?lang=" + V.getLang(), "invoice.html", {
        open: true,
        rewrite: function (html) { return FU.rewriteDoc(html, window.location.origin); },
      });
    }).catch(function () {});
  }

  function renderPayments() {
    var d = payState.data;
    var box = $("#payments-box");
    if (!d) return;
    var out = [];
    if (!d.invoices.length) {
      V.setContent(box, V.empty(t("fin.me.none")));
      return;
    }
    out.push(h("h3", { text: t("fin.me.totals") }));
    out.push(d.totals.length ? tableOf(
      [t("fin.currency"), { label: t("fin.me.invoiced"), num: true }, { label: t("fin.me.paid"), num: true }, { label: t("fin.me.refunded"), num: true }, { label: t("fin.me.remaining"), num: true }],
      d.totals.map(function (x) {
        return h("tr", null, h("td", null, h("strong", { text: x.currency })), h("td", { class: "num" }, money(x.invoiced, x.currency)), h("td", { class: "num" }, money(x.paid, x.currency)),
          h("td", { class: "num" }, money(x.refunded, x.currency)), h("td", { class: "num" }, money(x.remaining, x.currency)));
      }), t("fin.me.totals")) : V.empty(t("fin.me.none")));
    out.push(h("p", { class: "small muted", text: t("fin.me.perCurrency") }));
    out.push(h("h3", { text: t("fin.me.invoices") }));
    d.invoices.forEach(function (inv) {
      var print = h("button", { type: "button", class: "btn secondary small", text: t("fin.me.print") });
      print.addEventListener("click", function () { openInvoicePrint(inv, print); });
      var items = tableOf([t("fin.description"), { label: t("fin.quantity"), num: true }, { label: t("fin.unitPrice"), num: true }, { label: t("fin.lineTotal"), num: true }],
        inv.items.map(function (it) {
          return h("tr", null, h("td", { text: it.description }), h("td", { class: "num" }, h("span", { class: "ltr-island", text: FU.formatMoney(it.quantity) })), h("td", { class: "num" }, money(it.unit_price, inv.currency)), h("td", { class: "num" }, money(it.line_total, inv.currency)));
        }), t("fin.me.items"));
      var pays = inv.payments.length ? tableOf([t("fin.receipt"), t("fin.date"), t("fin.method"), { label: t("fin.amount"), num: true }, t("fin.status")],
        inv.payments.map(function (p) {
          return h("tr", null, h("td", { text: p.receipt_number || "\u2014" }), h("td", null, dateText(p.payment_date)), h("td", { text: t("fin.method." + p.method) }), h("td", { class: "num" }, money(p.amount, inv.currency)),
            h("td", null, h("span", { class: "badge " + (p.voided ? "bad" : "ok"), text: p.voided ? t("fin.pay.voided") : t("fin.pay.valid") })));
        }), t("fin.me.paymentsTable")) : h("p", { class: "small muted", text: t("fin.me.noPayments") });
      out.push(h("article", { class: "card" },
        h("div", { class: "card-head" }, h("h3", { text: inv.number || "#" + inv.id }), h("span", { class: "badge " + FU.statusClass(inv.status), text: t("fin.status." + inv.status) }), h("span", { class: "spacer" }), print),
        h("dl", { class: "kv" },
          h("dt", { text: t("fin.issued") }), h("dd", null, dateText(inv.issued_at)),
          h("dt", { text: t("fin.dueDate") }), h("dd", null, dateText(inv.due_date)),
          h("dt", { text: t("fin.total") }), h("dd", null, money(inv.total, inv.currency)),
          h("dt", { text: t("fin.balance") }), h("dd", null, h("strong", null, money(inv.remaining, inv.currency)))),
        items,
        h("h4", { text: t("fin.me.payments") }),
        pays));
    });
    V.setContent(box, out);
  }

  function tableOf(headers, rows, caption) {
    var thead = h("thead", null, h("tr", null, headers.map(function (x) { return h("th", { scope: "col", class: x.num ? "num" : null, text: x.label || x }); })));
    return h("div", { class: "table-wrap" }, h("table", null, h("caption", { class: "sr-only", text: caption }), thead, h("tbody", null, rows)));
  }

  // ================================================================ boot
  V.onUnauthorized(function () { showLogin(); V.toast(t("err.401"), "bad"); });
  initLogin();
  if (V.getSession() && V.getSession().kind === "candidate") start();
  else showLogin();
})();
