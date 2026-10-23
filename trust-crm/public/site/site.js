/* VITA public website behaviour: language switcher, config facts, job offers and lead forms.
   Plain script, no dependencies. All dynamic text is set with textContent / setAttribute only
   (never HTML strings), and nothing is requested outside this origin. */
(function (root) {
  "use strict";

  var STORE_KEY = "vita-site-lang";
  var EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
  var PHONE_RE = /^\+?[0-9 ().-]+$/;
  var FACT_ORDER = ["phone", "whatsapp", "email", "address", "licence"];

  // ------------------------------------------------------------ pure helpers (unit tested)

  /** Returns the URL string only when it is an https link; anything else (javascript:, data:, relative) is null. */
  function safeHref(value) {
    if (typeof value !== "string") return null;
    var u;
    try { u = new URL(value.trim()); } catch (e) { return null; }
    return u.protocol === "https:" ? u.href === value.trim() ? value.trim() : u.href : null;
  }

  function telHref(phone) {
    var digits = String(phone).replace(/[^0-9+]/g, "");
    if (!PHONE_RE.test(String(phone)) || digits.replace(/\D/g, "").length < 7) return undefined;
    return "tel:" + digits;
  }

  function mailHref(email) {
    return EMAIL_RE.test(String(email)) ? "mailto:" + email : undefined;
  }

  /** Facts to show, from the /public/config answer. Only keys that are actually set are returned. */
  function factsFrom(cfg) {
    var out = [];
    if (!cfg || typeof cfg !== "object") return out;
    FACT_ORDER.forEach(function (key) {
      var v = cfg[key];
      if (typeof v !== "string" || !v.trim()) return;
      v = v.trim();
      var href;
      if (key === "phone") href = telHref(v);
      else if (key === "email") href = mailHref(v);
      else if (key === "whatsapp") href = safeHref(v) || undefined;
      var item = { key: key, text: v };
      if (href) item.href = href;
      out.push(item);
    });
    return out;
  }

  /** How to apply for an offer. "register" and "contact_staff" link to our pages; only an absolute http(s) URL becomes
      an external link; any other value falls back to contacting staff and is never rendered as a link. */
  function applyLink(mode) {
    var m = typeof mode === "string" ? mode.trim() : "";
    if (m.toLowerCase() === "register") return { type: "register", href: "/site/register.html" };
    if (/^https?:\/\//i.test(m)) {
      try {
        var u = new URL(m);
        if (u.protocol === "https:" || u.protocol === "http:") return { type: "external", href: u.href };
      } catch (e) { /* fall through */ }
    }
    return { type: "contact", href: "/site/contact.html" };
  }

  /** Client-side checks mirroring the server rules. Returns [{field, key}] (empty = ok). */
  function validateLead(values, opts) {
    var errs = [];
    var o = opts || {};
    var name = String(values.name || "").trim();
    var email = String(values.email || "").trim();
    var phone = String(values.phone || "").trim();
    if (!name) errs.push({ field: "name", key: "form.error.name" });
    if (!email && !phone) errs.push({ field: "email", key: "form.error.contact" });
    if (email && !EMAIL_RE.test(email)) errs.push({ field: "email", key: "form.error.email" });
    if (phone) {
      var digits = phone.replace(/\D/g, "");
      if (!PHONE_RE.test(phone) || digits.length < 7 || digits.length > 15) errs.push({ field: "phone", key: "form.error.phone" });
    }
    if (o.needMessage && !String(values.message || "").trim()) errs.push({ field: "message", key: "form.error.message" });
    if (o.needConsent && values.consent !== true) errs.push({ field: "consent", key: "form.error.consent" });
    return errs;
  }

  var api = { safeHref: safeHref, factsFrom: factsFrom, validateLead: validateLead, applyLink: applyLink };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // ------------------------------------------------------------ browser only

  var I18N = root.VITA_SITE_I18N;
  var lang = "en";
  var jobsData = null;
  var jobsState = "loading";

  function detectLang() {
    var stored = null;
    try { stored = root.localStorage.getItem(STORE_KEY); } catch (e) { stored = null; }
    if (stored && I18N.languages.indexOf(stored) !== -1) return stored;
    var nav = "";
    try { nav = String(root.navigator.language || "").toLowerCase(); } catch (e) { nav = ""; }
    return nav.indexOf("ar") === 0 ? "ar" : "en";
  }

  function t(key, vars) {
    var d = I18N.dictionaries[lang] || I18N.dictionaries.en;
    var s = d[key];
    if (typeof s !== "string") s = I18N.dictionaries.en[key];
    if (typeof s !== "string") return key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split("{" + k + "}").join(String(vars[k])); });
    return s;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function applyI18n() {
    var de = document.documentElement;
    de.setAttribute("lang", lang);
    de.setAttribute("dir", I18N.dirFor(lang));
    document.querySelectorAll("[data-i18n]").forEach(function (n) { n.textContent = t(n.getAttribute("data-i18n")); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (n) { n.setAttribute("placeholder", t(n.getAttribute("data-i18n-placeholder"))); });
    document.querySelectorAll("[data-i18n-label]").forEach(function (n) { n.setAttribute("aria-label", t(n.getAttribute("data-i18n-label"))); });
    var tk = document.body && document.body.getAttribute("data-title-key");
    if (tk) document.title = t(tk);
    document.querySelectorAll("[data-lang-switch]").forEach(function (s) { s.value = lang; });
    document.querySelectorAll("[data-lead-form]").forEach(renderFormStatus);
    renderFacts();
    renderJobs();
  }

  function setLang(next) {
    if (I18N.languages.indexOf(next) === -1) return;
    lang = next;
    try { root.localStorage.setItem(STORE_KEY, next); } catch (e) { /* storage unavailable: still works for this page view */ }
    applyI18n();
  }

  // ------------------------------------------------------------ config facts

  var config = null;

  function renderFacts() {
    var facts = factsFrom(config);
    document.querySelectorAll("[data-site-facts]").forEach(function (box) {
      while (box.firstChild) box.removeChild(box.firstChild);
      if (!facts.length) { box.hidden = true; return; }
      facts.forEach(function (f) {
        var li = el("li", "fact");
        li.appendChild(el("span", "fact-label", t("facts." + f.key)));
        li.appendChild(document.createTextNode(" "));
        var value;
        if (f.href) {
          value = el("a", null, f.key === "whatsapp" ? t("facts.whatsappLink") : f.text);
          value.setAttribute("href", f.href);
          if (f.key === "whatsapp") { value.setAttribute("rel", "noopener noreferrer"); value.setAttribute("target", "_blank"); }
        } else {
          value = el("span", "fact-value", f.text);
        }
        li.appendChild(value);
        box.appendChild(li);
      });
      box.hidden = false;
    });
    var nameEl = document.querySelectorAll("[data-site-name]");
    if (config && typeof config.name === "string" && config.name.trim()) nameEl.forEach(function (n) { n.textContent = config.name.trim(); });
  }

  function loadConfig() {
    return fetch("/public/config", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) { config = c; renderFacts(); })
      .catch(function () { config = null; });
  }

  // ------------------------------------------------------------ job offers

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try { return d.toLocaleDateString(lang, { year: "numeric", month: "long", day: "numeric" }); } catch (e) { return d.toISOString().slice(0, 10); }
  }

  function addRow(dl, labelKey, value) {
    if (value === undefined || value === null || String(value).trim() === "") return;
    dl.appendChild(el("dt", null, t(labelKey)));
    dl.appendChild(el("dd", null, String(value)));
  }

  function addBlock(parent, labelKey, value) {
    if (typeof value !== "string" || !value.trim()) return;
    parent.appendChild(el("h4", null, t(labelKey)));
    parent.appendChild(el("p", "job-text", value));
  }

  function jobCard(job) {
    var card = el("article", "card job");
    card.appendChild(el("h3", null, job.title || ""));
    var dl = el("dl", "job-meta");
    addRow(dl, "jobs.employer", job.employer_name);
    addRow(dl, "jobs.location", [job.city, job.country].filter(Boolean).join(", "));
    addRow(dl, "jobs.type", job.employment_type);
    addRow(dl, "jobs.salary", job.salary_text);
    dl.appendChild(el("dt", null, t("jobs.closes")));
    dl.appendChild(el("dd", null, job.closes_at ? fmtDate(job.closes_at) : t("jobs.noClosing")));
    card.appendChild(dl);

    var hasMore = [job.description, job.requirements, job.language_requirements].some(function (v) { return typeof v === "string" && v.trim(); });
    if (hasMore) {
      var det = el("details", "job-more");
      det.appendChild(el("summary", null, t("jobs.details")));
      addBlock(det, "jobs.details", job.description);
      addBlock(det, "jobs.requirements", job.requirements);
      addBlock(det, "jobs.languages", job.language_requirements);
      card.appendChild(det);
    }

    var how = applyLink(job.apply_mode);
    var apply = el("div", "job-apply");
    apply.appendChild(el("h4", null, t("jobs.apply.h")));
    var msgKey = how.type === "register" ? "jobs.apply.register" : how.type === "external" ? "jobs.apply.external" : "jobs.apply.contact";
    var linkKey = how.type === "register" ? "jobs.apply.registerLink" : how.type === "external" ? "jobs.apply.externalLink" : "jobs.apply.contactLink";
    apply.appendChild(el("p", null, t(msgKey)));
    var a = el("a", "btn small", t(linkKey));
    a.setAttribute("href", how.href);
    if (how.type === "external") { a.setAttribute("rel", "noopener noreferrer"); a.setAttribute("target", "_blank"); }
    apply.appendChild(a);
    card.appendChild(apply);
    return card;
  }

  function renderJobs() {
    var list = document.getElementById("jobs-list");
    if (!list) return;
    var loading = document.getElementById("jobs-loading");
    var empty = document.getElementById("jobs-empty");
    var error = document.getElementById("jobs-error");
    while (list.firstChild) list.removeChild(list.firstChild);
    if (loading) loading.hidden = jobsState !== "loading";
    if (empty) empty.hidden = !(jobsState === "ready" && jobsData.length === 0);
    if (error) error.hidden = jobsState !== "error";
    if (jobsState === "ready") jobsData.forEach(function (j) { list.appendChild(jobCard(j)); });
    list.setAttribute("aria-busy", jobsState === "loading" ? "true" : "false");
  }

  function loadJobs() {
    if (!document.getElementById("jobs-list")) return;
    fetch("/public/jobs?limit=50", { headers: { Accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
      .then(function (body) {
        jobsData = body && Array.isArray(body.jobs) ? body.jobs : [];
        jobsState = "ready";
        renderJobs();
      })
      .catch(function () { jobsState = "error"; renderJobs(); });
  }

  // ------------------------------------------------------------ lead forms

  function renderFormStatus(form) {
    var box = form.querySelector("[data-form-status]");
    if (!box) return;
    var s = form._status;
    box.className = "form-status" + (s ? " " + s.kind : "");
    box.textContent = s ? t(s.key, s.vars) : "";
    box.setAttribute("role", s && s.kind === "bad" ? "alert" : "status");
  }

  function setStatus(form, kind, key, vars) {
    form._status = key ? { kind: kind, key: key, vars: vars } : null;
    renderFormStatus(form);
  }

  function readValues(form) {
    var v = {};
    ["name", "email", "phone", "country", "profession", "company", "message", "website"].forEach(function (n) {
      var f = form.elements[n];
      if (f) v[n] = String(f.value || "").trim();
    });
    var c = form.elements.consent;
    v.consent = c ? c.checked === true : undefined;
    return v;
  }

  function clearInvalid(form) {
    form.querySelectorAll("[aria-invalid]").forEach(function (n) { n.removeAttribute("aria-invalid"); });
  }

  function submitForm(form, ev) {
    ev.preventDefault();
    if (form._busy) return;
    clearInvalid(form);
    var kind = form.getAttribute("data-kind");
    var values = readValues(form);
    var errs = validateLead(values, { needConsent: !!form.elements.consent, needMessage: kind === "contact" });
    if (errs.length) {
      errs.forEach(function (e) { var f = form.elements[e.field]; if (f) f.setAttribute("aria-invalid", "true"); });
      setStatus(form, "bad", errs[0].key);
      var first = form.elements[errs[0].field];
      if (first && first.focus) first.focus();
      return;
    }
    var payload = { kind: kind, lang: lang };
    ["name", "email", "phone", "country", "profession", "company", "message"].forEach(function (n) { if (values[n]) payload[n] = values[n]; });
    if (values.consent !== undefined) payload.consent = values.consent;
    payload.website = values.website || "";

    form._busy = true;
    var submit = form.querySelector("button[type=submit]");
    if (submit) submit.disabled = true;
    setStatus(form, "info", "form.sending");

    fetch("/public/leads", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) })
      .then(function (r) {
        if (r.ok) { form.reset(); setStatus(form, "ok", "form.success"); return; }
        if (r.status === 429) {
          var secs = parseInt(r.headers.get("Retry-After") || "", 10);
          var mins = isFinite(secs) && secs > 0 ? Math.max(1, Math.ceil(secs / 60)) : 60;
          setStatus(form, "bad", "form.error.rate", { n: mins });
        } else if (r.status === 400) {
          setStatus(form, "bad", "form.error.invalid");
        } else {
          setStatus(form, "bad", "form.error.generic");
        }
      })
      .catch(function () { setStatus(form, "bad", "form.error.network"); })
      .then(function () { form._busy = false; if (submit) submit.disabled = false; });
  }

  // ------------------------------------------------------------ start

  function init() {
    lang = detectLang();
    document.querySelectorAll("[data-lang-switch]").forEach(function (s) {
      s.addEventListener("change", function () { setLang(s.value); });
    });
    document.querySelectorAll("[data-lead-form]").forEach(function (f) {
      f.addEventListener("submit", function (ev) { submitForm(f, ev); });
    });
    applyI18n();
    loadConfig();
    loadJobs();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(typeof window !== "undefined" ? window : this);
