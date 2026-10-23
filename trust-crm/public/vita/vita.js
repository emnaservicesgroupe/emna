/* VITA shared client: storage, i18n, formatting, API client, DOM helpers, SSE client.
   Security rules for every page script:
   - Server, employer, candidate and CV text is UNTRUSTED. It is only ever rendered through
     textContent / createTextNode (helper h()). No HTML-parsing sinks are used anywhere.
   - The session token lives in sessionStorage (memory fallback), is sent only in the
     Authorization header, and never appears in a URL or a log line.
   - A 401 from any call clears the session and returns the page to its login screen. */
(function () {
  "use strict";

  /**
   * Reconnect delay for the event stream: exponential (1 s, 2 s, 4 s ... capped at 30 s) with
   * "equal jitter" (half fixed, half random) so many clients do not reconnect in lockstep.
   * attempt >= 1; rand in [0, 1). Pure, so it is unit-tested from Node.
   */
  function backoffDelay(attempt, rand) {
    var n = Math.max(1, Math.floor(Number(attempt) || 1));
    var r = typeof rand === "number" && rand >= 0 && rand < 1 ? rand : 0;
    var base = Math.min(30000, 1000 * Math.pow(2, Math.min(n - 1, 5)));
    return Math.round(base / 2 + r * (base / 2));
  }
  /** A stream only counts as healthy (attempt counter reset) after it stayed open this long or delivered an event. */
  var STABLE_STREAM_MS = 10000;

  if (typeof window === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = { backoffDelay: backoffDelay, STABLE_STREAM_MS: STABLE_STREAM_MS };
    return;
  }

  var I18N = window.VITA_I18N;
  var TOKEN_KEY = "vita.session";
  var LANG_KEY = "vita.lang";

  // ---------------------------------------------------------------- storage
  var memory = Object.create(null);
  var session = {
    get: function (k) {
      try {
        var v = window.sessionStorage.getItem(k);
        if (v !== null) return v;
      } catch (e) { /* storage blocked: memory fallback */ }
      return k in memory ? memory[k] : null;
    },
    set: function (k, v) {
      memory[k] = v;
      try { window.sessionStorage.setItem(k, v); } catch (e) { /* memory only */ }
    },
    remove: function (k) {
      delete memory[k];
      try { window.sessionStorage.removeItem(k); } catch (e) { /* ignore */ }
    },
  };
  var local = {
    get: function (k) {
      try { return window.localStorage.getItem(k); } catch (e) { return null; }
    },
    set: function (k, v) {
      try { window.localStorage.setItem(k, v); } catch (e) { /* preference not persisted */ }
    },
  };

  /** Session = {token, role, name, userId, candidateId, kind:'staff'|'candidate'}. */
  function getSession() {
    var raw = session.get(TOKEN_KEY);
    if (!raw) return null;
    try {
      var s = JSON.parse(raw);
      return s && typeof s.token === "string" ? s : null;
    } catch (e) {
      return null;
    }
  }
  function setSession(s) { session.set(TOKEN_KEY, JSON.stringify(s)); }
  function clearSession() { session.remove(TOKEN_KEY); }
  function token() {
    var s = getSession();
    return s ? s.token : null;
  }

  // ---------------------------------------------------------------- i18n
  var LANGS = ["ar", "en", "fr"];
  var langListeners = [];
  function detectLang() {
    var saved = local.get(LANG_KEY);
    if (saved && LANGS.indexOf(saved) >= 0) return saved;
    var nav = (navigator.language || "en").slice(0, 2).toLowerCase();
    return LANGS.indexOf(nav) >= 0 ? nav : "en";
  }
  var lang = detectLang();

  function t(key, vars) {
    var d = I18N.dictionaries[lang] || I18N.dictionaries.en;
    var s = Object.prototype.hasOwnProperty.call(d, key) ? d[key] : I18N.dictionaries.en[key];
    if (typeof s !== "string") s = key;
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, function (m, k) {
        return vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m;
      });
    }
    return s;
  }
  function has(key) { return Object.prototype.hasOwnProperty.call(I18N.dictionaries.en, key); }
  /** Translation for a server code (status, reason...) with a readable fallback. */
  function tc(prefix, code) {
    if (code === null || code === undefined || code === "") return t("common.none");
    var k = prefix + "." + code;
    return has(k) ? t(k) : String(code).replace(/_/g, " ");
  }

  /**
   * Label for a candidate timeline reason code (Task 20): reason.<code>; "prefix:code" (held:module_paused)
   * -> "<prefix label>: <code label>"; unknown codes fall back to the humanised code (never raw underscores).
   */
  function reasonLabel(code) {
    if (code === null || code === undefined || code === "") return t("common.none");
    var c = String(code);
    if (has("reason." + c)) return t("reason." + c);
    var i = c.indexOf(":");
    if (i > 0) {
      var prefix = c.slice(0, i), rest = c.slice(i + 1);
      var head = has("reason." + prefix) ? t("reason." + prefix) : prefix.replace(/_/g, " ");
      return rest ? head + ": " + reasonLabel(rest) : head;
    }
    return c.replace(/_/g, " ");
  }

  function applyI18n(root) {
    var scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) { el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder"))); });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach(function (el) { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label"))); });
    scope.querySelectorAll("[data-i18n-title]").forEach(function (el) { el.setAttribute("title", t(el.getAttribute("data-i18n-title"))); });
    // Fixed-language slots (e.g. the disclaimer in all three languages) never follow the UI language.
    scope.querySelectorAll("[data-disclaimer-lang]").forEach(function (el) {
      var l = el.getAttribute("data-disclaimer-lang");
      el.textContent = I18N.dictionaries[l].disclaimer;
      el.setAttribute("lang", l);
      el.setAttribute("dir", I18N.dirFor(l));
    });
  }

  function setLang(l) {
    if (LANGS.indexOf(l) < 0) return;
    lang = l;
    local.set(LANG_KEY, l);
    document.documentElement.lang = l;
    document.documentElement.dir = I18N.dirFor(l);
    applyI18n(document);
    var page = document.body && document.body.getAttribute("data-title-key");
    if (page) document.title = t(page) + " · VITA";
    langListeners.forEach(function (fn) { safe(fn, l); });
  }
  function onLang(fn) { langListeners.push(fn); }
  function getLang() { return lang; }
  function locale() { return lang === "ar" ? "ar" : lang === "fr" ? "fr-FR" : "en-GB"; }

  /** Wires every <select data-lang-switch> on the page. */
  function initLangSwitch() {
    document.querySelectorAll("select[data-lang-switch]").forEach(function (sel) {
      sel.value = lang;
      sel.addEventListener("change", function () { setLang(sel.value); });
    });
    onLang(function (l) {
      document.querySelectorAll("select[data-lang-switch]").forEach(function (sel) { sel.value = l; });
    });
  }

  // ---------------------------------------------------------------- formatting
  function userTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; }
  }
  function validTz(tz) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz }).format(new Date());
      return true;
    } catch (e) {
      return false;
    }
  }
  /** Date-time in an explicit zone, always with the zone name shown. */
  function fmtDateTime(value, tz) {
    if (value === null || value === undefined || value === "") return "—";
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    var zone = tz && validTz(tz) ? tz : userTz();
    try {
      return new Intl.DateTimeFormat(locale(), {
        year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        timeZone: zone, timeZoneName: "short",
      }).format(d);
    } catch (e) {
      return d.toISOString();
    }
  }
  function fmtUtc(value) { return fmtDateTime(value, "UTC"); }
  function fmtDate(value) {
    if (!value) return "—";
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    try {
      return new Intl.DateTimeFormat(locale(), { year: "numeric", month: "short", day: "numeric", timeZone: userTz() }).format(d);
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }
  function fmtNumber(n) {
    if (n === null || n === undefined || n === "" || isNaN(Number(n))) return "—";
    try { return new Intl.NumberFormat(locale()).format(Number(n)); } catch (e) { return String(n); }
  }
  function fmtMoney(n, currency) {
    if (n === null || n === undefined || isNaN(Number(n))) return "—";
    try {
      return new Intl.NumberFormat(locale(), { style: "currency", currency: currency || "EUR", maximumFractionDigits: 0 }).format(Number(n));
    } catch (e) {
      return fmtNumber(n) + " " + (currency || "");
    }
  }
  function timeZones() {
    var list = [];
    try { if (typeof Intl.supportedValuesOf === "function") list = Intl.supportedValuesOf("timeZone"); } catch (e) { list = []; }
    if (!list.length) list = ["UTC", "America/Toronto", "America/Vancouver", "America/Halifax", "America/Winnipeg", "America/Edmonton", "Europe/Rome", "Europe/Tirane", "Europe/Bucharest", "Europe/Paris", "Europe/London", "Africa/Tunis", "Africa/Algiers", "Africa/Casablanca", "Africa/Cairo", "Asia/Dubai", "Asia/Riyadh"];
    if (list.indexOf("UTC") < 0) list = ["UTC"].concat(list);
    return list;
  }

  // ---------------------------------------------------------------- DOM helpers
  /**
   * h(tag, props, ...children). props: class, text, attrs{}, dataset{}, on{event: fn}, hidden,
   * disabled, value, checked, type, id, for (label), title. Children: nodes, strings (as text) or arrays.
   * Never parses HTML.
   */
  function h(tag, props) {
    var el = document.createElement(tag);
    var p = props || {};
    var badAttr = function (name) {
      if (/^on|^style$|^src(?:doc)$|^formaction$/i.test(name)) throw new Error("h(): attribute not allowed: " + name);
    };
    Object.keys(p).forEach(function (k) {
      if (k !== "on") badAttr(k);
      if (k === "attrs" && p[k] && typeof p[k] === "object") Object.keys(p[k]).forEach(badAttr);
      var v = p[k];
      if (v === undefined || v === null || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = String(v);
      else if (k === "on") Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else if (k === "dataset") Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
      else if (k === "attrs") Object.keys(v).forEach(function (a) { if (v[a] !== null && v[a] !== undefined && v[a] !== false) el.setAttribute(a, v[a] === true ? "" : String(v[a])); });
      else if (k === "for") el.htmlFor = v;
      else if (k === "value") el.value = v;
      else if (k === "checked" || k === "disabled" || k === "hidden" || k === "selected" || k === "required" || k === "multiple" || k === "open") el[k] = Boolean(v);
      else el.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    if (typeof child === "string" || typeof child === "number") { el.appendChild(document.createTextNode(String(child))); return; }
    el.appendChild(child);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function setContent(el) {
    clear(el);
    for (var i = 1; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /** Only http(s) links from data become anchors; anything else is shown as plain text. */
  function safeLink(url, label) {
    var u;
    try { u = new URL(String(url)); } catch (e) { return document.createTextNode(label || "—"); }
    if (u.protocol !== "https:" && u.protocol !== "http:") return document.createTextNode(label || "—");
    return h("a", { href: u.href, attrs: { target: "_blank", rel: "noopener noreferrer nofollow", referrerpolicy: "no-referrer" }, text: label || u.hostname });
  }

  function loading(label) { return h("span", { class: "loading", attrs: { role: "status" }, text: label || t("common.loading") }); }
  function empty(text) { return h("p", { class: "empty", text: text || t("common.empty") }); }

  // live region + toasts
  function announce(msg) {
    var live = document.getElementById("live");
    if (!live) return;
    live.textContent = "";
    window.setTimeout(function () { live.textContent = msg; }, 30);
  }
  function toast(msg, kind) {
    var box = document.getElementById("toasts");
    if (!box) return;
    var close = h("button", { type: "button", text: t("common.close") });
    var el = h("div", { class: "toast " + (kind || ""), attrs: { role: kind === "bad" ? "alert" : "status" } }, h("span", { text: msg }), close);
    close.addEventListener("click", function () { el.remove(); });
    box.appendChild(el);
    window.setTimeout(function () { el.remove(); }, kind === "bad" ? 12000 : 6000);
  }

  // ---------------------------------------------------------------- API client
  function ApiError(status, message, code, body) {
    this.name = "ApiError";
    this.status = status;
    this.message = message || "";
    this.code = code || null;
    this.body = body || null;
  }
  ApiError.prototype = Object.create(Error.prototype);

  var unauthorizedHandler = null;
  function onUnauthorized(fn) { unauthorizedHandler = fn; }
  function handleUnauthorized() {
    clearSession();
    if (unauthorizedHandler) safe(unauthorizedHandler);
  }

  function assertPath(path) {
    // Staff console + candidate portal (/jobsearch, /auth, /crm) and the employer / agency portals (/employer, /agency).
    if (typeof path !== "string" || !(/^\/(jobsearch|auth|crm)\//.test(path) || /^\/(employer|agency)\//.test(path))) throw new Error("API path not allowed");
  }

  /** JSON API call. opts: body, noAuth, raw (return Response), headers. */
  function api(method, path, opts) {
    var o = opts || {};
    assertPath(path);
    var headers = { Accept: o.raw ? "*/*" : "application/json" };
    var tok = token();
    if (tok && !o.noAuth) headers.Authorization = "Bearer " + tok;
    var body;
    if (o.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(o.body);
    }
    return fetch(path, { method: method, headers: headers, body: body, cache: "no-store", credentials: "same-origin", referrerPolicy: "no-referrer" })
      .catch(function () { throw new ApiError(0, "network", "network"); })
      .then(function (res) {
        if (o.raw && res.ok) return res;
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (!res.ok) {
            var err = new ApiError(res.status, data && typeof data.error === "string" ? data.error : res.statusText, data && data.code, data);
            if (res.status === 401 && !o.noAuth) handleUnauthorized();
            throw err;
          }
          return data;
        });
      });
  }

  /** Multipart upload with progress (XHR: fetch has no upload progress). */
  function upload(path, file, onProgress) {
    assertPath(path);
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", path);
      var tok = token();
      if (tok) xhr.setRequestHeader("Authorization", "Bearer " + tok);
      xhr.setRequestHeader("Accept", "application/json");
      xhr.upload.addEventListener("progress", function (e) { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); });
      xhr.addEventListener("error", function () { reject(new ApiError(0, "network", "network")); });
      xhr.addEventListener("load", function () {
        var data = null;
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { data = null; }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        if (xhr.status === 401) handleUnauthorized();
        reject(new ApiError(xhr.status, data && data.error, data && data.code, data));
      });
      var form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  }

  /** Authenticated download (e.g. CSV export) through a Blob; the token never goes into a URL. */
  function download(path, fallbackName) {
    return api("GET", path, { raw: true }).then(function (res) {
      var cd = res.headers.get("Content-Disposition") || "";
      var m = /filename="([A-Za-z0-9._-]{1,120})"/.exec(cd);
      var name = m ? m[1] : fallbackName || "download";
      var meta = { rows: res.headers.get("X-Export-Rows"), truncated: res.headers.get("X-Export-Truncated") === "true" };
      return res.blob().then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = h("a", { href: url, attrs: { download: name } });
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        return { name: name, size: blob.size, rows: meta.rows, truncated: meta.truncated };
      });
    });
  }

  /** Readable, localized message for an API error (server detail appended as plain text). */
  function errorMessage(err) {
    if (!err) return t("err.generic");
    if (!(err instanceof ApiError)) return t("err.generic");
    var code = err.code && has("err.code." + err.code) ? t("err.code." + err.code) : null;
    var base;
    if (err.status === 0) base = t("err.network");
    else if (code) base = code;
    else if (has("err." + err.status)) base = t("err." + err.status);
    else if (err.status >= 500) base = t("err.500");
    else base = t("err.generic");
    var detail = err.status >= 400 && err.status < 500 && err.message && err.status !== 401 ? String(err.message).slice(0, 300) : "";
    return detail && detail !== base ? base + " — " + detail : base;
  }

  function safe(fn, arg) {
    try {
      var r = fn(arg);
      if (r && typeof r.catch === "function") r.catch(function () { /* reported by caller */ });
    } catch (e) { /* listener failure must not break the page */ }
  }

  /** Runs an async action from a button: disables it, reports errors in a toast, re-enables it. */
  function busy(button, fn) {
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    var p = Promise.resolve()
      .then(fn)
      .catch(function (err) {
        toast(errorMessage(err), "bad");
        throw err;
      })
      .finally(function () {
        if (button) {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      });
    // The error is already reported in a toast: mark the promise handled so a caller that does
    // not chain .catch never produces an unhandled rejection (callers may still .catch it).
    p.catch(function () {});
    return p;
  }

  /** Accessible modal confirmation (native <dialog>). Resolves true/false. */
  function confirmDialog(message, confirmLabel, danger) {
    return new Promise(function (resolve) {
      var dlg = h("dialog", { attrs: { "aria-labelledby": "dlg-msg" } });
      var ok = h("button", { type: "button", class: "btn" + (danger ? " danger" : ""), text: confirmLabel || t("common.confirm") });
      var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
      dlg.appendChild(h("p", { id: "dlg-msg", text: message }));
      dlg.appendChild(h("div", { class: "btn-row" }, ok, cancel));
      document.body.appendChild(dlg);
      var opener = document.activeElement;
      var done = function (v) {
        if (dlg.open) dlg.close();
        dlg.remove();
        if (opener && opener.focus) opener.focus();
        resolve(v);
      };
      ok.addEventListener("click", function () { done(true); });
      cancel.addEventListener("click", function () { done(false); });
      dlg.addEventListener("cancel", function (e) { e.preventDefault(); done(false); });
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
      cancel.focus();
    });
  }

  // ---------------------------------------------------------------- realtime (SSE over fetch)
  /**
   * Streams /jobsearch/events with the Authorization header (EventSource cannot send headers).
   * - refetch() runs on every (re)connect, every `periodicMs`, and when the tab becomes visible,
   *   so state is correct even if events were missed.
   * - Reconnects with exponential backoff + jitter (1s .. 30s); Last-Event-ID resumes the stream.
   * - 401 stops the stream and returns to login; logout must call stop().
   */
  function connectEvents(o) {
    var stopped = false;
    var attempt = 0;
    var stableTimer = null;
    var controller = null;
    var timer = null;
    var lastId = null;
    var periodicMs = o.periodicMs || 60000;
    var status = function (s) { if (o.onStatus) safe(o.onStatus, s); };
    var refetch = function () { if (o.refetch) safe(o.refetch); };

    function frame(raw) {
      var data = [];
      var id = null;
      raw.split(/\r?\n/).forEach(function (line) {
        if (!line || line.charAt(0) === ":") return;
        var i = line.indexOf(":");
        var field = i < 0 ? line : line.slice(0, i);
        var value = i < 0 ? "" : line.slice(i + 1);
        if (value.charAt(0) === " ") value = value.slice(1);
        if (field === "data") data.push(value);
        else if (field === "id") id = value;
      });
      if (id && /^\d{1,18}$/.test(id)) lastId = id;
      if (!data.length) return;
      var ev;
      try { ev = JSON.parse(data.join("\n")); } catch (e) { return; }
      attempt = 0;
      if (o.onEvent) safe(o.onEvent, ev);
    }

    function schedule() {
      if (stopped) return;
      window.clearTimeout(stableTimer);
      attempt += 1;
      var delay = backoffDelay(attempt, Math.random());
      status("reconnecting");
      timer = window.setTimeout(run, delay);
    }

    function run() {
      if (stopped) return;
      var tok = token();
      if (!tok) { status("off"); return; }
      controller = new AbortController();
      var headers = { Accept: "text/event-stream", Authorization: "Bearer " + tok };
      if (lastId) headers["Last-Event-ID"] = lastId;
      fetch("/jobsearch/events", { headers: headers, signal: controller.signal, cache: "no-store", credentials: "same-origin" })
        .then(function (res) {
          if (res.status === 401) {
            stopped = true;
            status("off");
            handleUnauthorized();
            return null;
          }
          if (!res.ok || !res.body) throw new Error("events unavailable");
          // A bare 200 that closes at once must not reset the backoff (that would hammer the server):
          // reset only once the stream stayed open long enough or delivered an event.
          window.clearTimeout(stableTimer);
          stableTimer = window.setTimeout(function () { attempt = 0; }, STABLE_STREAM_MS);
          status("live");
          refetch();
          var reader = res.body.getReader();
          var decoder = new TextDecoder();
          var buf = "";
          var pump = function () {
            return reader.read().then(function (r) {
              if (r.done) throw new Error("stream closed");
              buf += decoder.decode(r.value, { stream: true });
              var m;
              while ((m = /\r?\n\r?\n/.exec(buf))) {
                frame(buf.slice(0, m.index));
                buf = buf.slice(m.index + m[0].length);
              }
              if (buf.length > 1000000) buf = "";
              return pump();
            });
          };
          return pump();
        })
        .catch(function (err) {
          if (stopped || (err && err.name === "AbortError")) return;
          schedule();
        });
    }

    var periodic = window.setInterval(function () { if (!document.hidden) refetch(); }, periodicMs);
    var onVisible = function () { if (!document.hidden) refetch(); };
    document.addEventListener("visibilitychange", onVisible);
    run();
    return {
      stop: function () {
        stopped = true;
        window.clearTimeout(timer);
        window.clearTimeout(stableTimer);
        window.clearInterval(periodic);
        document.removeEventListener("visibilitychange", onVisible);
        if (controller) controller.abort();
        status("off");
      },
    };
  }

  /** Debounces a refresh so a burst of events triggers one reload. */
  function debounce(fn, ms) {
    var timer = null;
    return function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { safe(fn); }, ms || 400);
    };
  }

  // ---------------------------------------------------------------- shared domain rendering
  var LABELS = ["confirmed", "stated_in_ad", "unknown", "unavailable"];
  /** Employer-support label: ALWAYS shown with its quoted evidence and the verify-with-employer notice. */
  function supportBlock(support) {
    var s = support || {};
    var label = LABELS.indexOf(s.label) >= 0 ? s.label : "unknown";
    var cls = label === "confirmed" ? "ok" : label === "stated_in_ad" ? "info" : label === "unavailable" ? "bad" : "neutral";
    var box = h("div", { class: "notice" },
      h("p", { class: "small" }, h("strong", { text: t("label.title") + ": " }), h("span", { class: "badge " + cls, text: t("label." + label) })),
      s.conflict ? h("p", { class: "small", text: t("label.conflict") }) : null,
      s.evidence ? [h("span", { class: "small muted", text: t("label.evidence") }), h("blockquote", { class: "evidence", text: s.evidence })] : h("p", { class: "small muted", text: t("label.noEvidence") }),
      h("p", { class: "small", text: label === "confirmed" ? t("label.noticeConfirmed") : t("label.notice") })
    );
    return box;
  }
  function overseasBlock(o) {
    var x = o || {};
    var v = x.accepted === true ? "yes" : x.accepted === false ? "no" : "unknown";
    return h("p", { class: "small" },
      h("strong", { text: t("overseas.title") + ": " }),
      h("span", { class: "badge " + (v === "yes" ? "ok" : v === "no" ? "bad" : "neutral"), text: t("overseas." + v) }),
      x.evidence ? h("blockquote", { class: "evidence", text: x.evidence }) : null
    );
  }
  function listOf(items, emptyKey) {
    var arr = Array.isArray(items) ? items : [];
    if (!arr.length) return h("p", { class: "small muted", text: t(emptyKey || "common.none") });
    return h("ul", { class: "compact" }, arr.map(function (x) {
      var text = typeof x === "string" ? x : x && typeof x === "object" ? x.text || x.reason || x.label || x.detail || JSON.stringify(x) : String(x);
      return h("li", { text: text });
    }));
  }
  function scoreBlock(m) {
    var score = Number(m && m.score) || 0;
    return h("div", null,
      h("p", null, h("strong", { text: t("match.score") + ": " }), h("span", { class: "score", text: fmtNumber(score) + " / 100" })),
      h("progress", { class: "meter", attrs: { max: "100", value: String(score), "aria-label": t("match.score") } }),
      h("h4", { text: t("match.reasons") }), listOf(m && m.reasons),
      h("h4", { text: t("match.missing") }), listOf(m && m.missing),
      h("h4", { text: t("match.uncertain") }), listOf(m && m.uncertain),
      h("p", { class: "small muted", text: t("match.notice") })
    );
  }
  var STATUS_CLASS = { matched: "neutral", preparing: "info", ready_for_review: "warn", approved: "info", queued: "info", sent: "warn", confirmed_submitted: "ok", failed: "bad", outcome_unknown: "warn", needs_staff: "bad", cancelled: "neutral", closed: "neutral", interview: "ok", offer: "ok", rejected: "bad" };
  function statusBadge(status) { return h("span", { class: "badge " + (STATUS_CLASS[status] || "neutral"), text: tc("status", status) }); }
  function interviewTimes(iv) {
    return h("div", { class: "small" },
      h("div", null, h("strong", { text: t("interview.local") + ": " }), fmtDateTime(iv.startsAtUtc, iv.tz), " – ", fmtDateTime(iv.endsAtUtc, iv.tz), " ", h("span", { class: "muted ltr-island", text: "(" + (iv.tz || "UTC") + ")" })),
      h("div", null, h("strong", { text: t("interview.utc") + ": " }), fmtUtc(iv.startsAtUtc)),
      iv.candidateTz && iv.candidateTz !== iv.tz ? h("div", null, h("strong", { text: t("interview.candidateLocal") + ": " }), fmtDateTime(iv.startsAtUtc, iv.candidateTz)) : null,
      h("div", null, h("strong", { text: t("interview.yourTime") + ": " }), fmtDateTime(iv.startsAtUtc, userTz()))
    );
  }
  function liveIndicator(el) {
    var last = null;
    var render = function () {
      if (last === null) return;
      setContent(el, h("span", { class: "dot " + (last === "live" ? "live" : last === "reconnecting" ? "reconnecting" : ""), attrs: { "aria-hidden": "true" } }), t("live." + last));
    };
    onLang(render);
    return function (s) {
      last = s || "off";
      render();
    };
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    document.documentElement.lang = lang;
    document.documentElement.dir = I18N.dirFor(lang);
    applyI18n(document);
    var page = document.body && document.body.getAttribute("data-title-key");
    if (page) document.title = t(page) + " · VITA";
    initLangSwitch();
    if (document.body && document.body.getAttribute("data-page") === "index") initIndex();
  }

  /** index.html: language + role chooser; deep links (#/applications/12 ...) go to the console. */
  function initIndex() {
    if (/^#\/(applications|candidates|messages|tasks)\/\d+$/.test(location.hash)) {
      location.replace("admin.html" + location.hash);
      return;
    }
    $all("[data-set-lang]").forEach(function (b) {
      var sync = function () { b.setAttribute("aria-pressed", String(b.getAttribute("data-set-lang") === lang)); };
      sync();
      onLang(sync);
      b.addEventListener("click", function () { setLang(b.getAttribute("data-set-lang")); });
    });
  }

  window.VITA = {
    t: t, tc: tc, has: has, reasonLabel: reasonLabel, applyI18n: applyI18n, setLang: setLang, getLang: getLang, onLang: onLang, locale: locale,
    getSession: getSession, setSession: setSession, clearSession: clearSession, token: token,
    fmtDateTime: fmtDateTime, fmtUtc: fmtUtc, fmtDate: fmtDate, fmtNumber: fmtNumber, fmtMoney: fmtMoney, userTz: userTz, validTz: validTz, timeZones: timeZones,
    h: h, append: append, clear: clear, setContent: setContent, $: $, $all: $all, safeLink: safeLink, loading: loading, empty: empty,
    announce: announce, toast: toast, busy: busy, confirmDialog: confirmDialog,
    api: api, upload: upload, download: download, ApiError: ApiError, errorMessage: errorMessage, onUnauthorized: onUnauthorized,
    connectEvents: connectEvents, debounce: debounce,
    supportBlock: supportBlock, overseasBlock: overseasBlock, scoreBlock: scoreBlock, listOf: listOf, statusBadge: statusBadge, interviewTimes: interviewTimes, liveIndicator: liveIndicator,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
