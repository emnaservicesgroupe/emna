/* Staff console "Assistant access" tab (mcp:use: Admin, Manager, SuperAdmin): the MCP status card, personal access tokens
   (create, list, revoke), the usage log, copy-paste connection snippets and an honest "what the assistant can and cannot do" list.
   Secrets: a new token's secret is returned by the API exactly once. It is held in one module variable and in one text node of
   a modal dialog; closing the dialog (or signing out) blanks the text, drops the variable and removes the dialog. It is never
   stored in the browser, put in a URL, logged, or inserted into the connection snippets (they carry the <YOUR_TOKEN> placeholder).
   Every name, tool, owner and date shown is rendered as text only. The server decides on every call; mcp-util.js mirrors it. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var U = window.VITA_MCP_UTIL;
  var t = V.t, h = V.h, $ = V.$;

  var state = { data: null, usage: null, key: null, creating: false, loadError: null };
  var shownSecret = null; // the only in-memory copy of a freshly created secret; null whenever no dialog is open
  var secretOut = null;
  var dlg = null;
  var dlgOpener = null;

  function role() { return A.role(); }
  function isAdmin() { return role() === "Admin" || role() === "SuperAdmin"; }
  function root() { return $("#mcp-root"); }
  function badge(cls, text) { return h("span", { class: "badge " + cls, text: text }); }
  function ltr(text) { return h("span", { class: "ltr-island", text: text }); }

  // ================================================================ clipboard (async API, then the legacy command, then manual selection)
  function selectNode(node) {
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* the text is still visible and can be selected by hand */ }
  }
  /** Copies `text`; reports in `statusEl`. `host` receives the temporary field of the legacy path; `anchor` is selected when copying is unavailable. */
  function copyText(text, statusEl, host, anchor) {
    function ok() { statusEl.textContent = t("mcp.copy.ok"); V.announce(t("mcp.copy.ok")); }
    function failed() {
      statusEl.textContent = t("mcp.copy.failed");
      if (anchor) selectNode(anchor);
    }
    function legacy() {
      var field = h("textarea", { class: "sr-only", attrs: { readonly: "", "aria-hidden": "true", tabindex: "-1" }, value: text });
      var before = document.activeElement;
      var done = false;
      try {
        host.appendChild(field);
        field.focus();
        field.select();
        done = document.execCommand("copy");
      } catch (e) {
        done = false;
      }
      field.value = "";
      field.remove();
      if (before && before.isConnected && typeof before.focus === "function") before.focus();
      if (done) ok(); else failed();
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") navigator.clipboard.writeText(text).then(ok, legacy);
    else legacy();
  }

  // ================================================================ status card
  function renderStatus() {
    var on = U.mcpState(state.data) === "enabled";
    var url = U.serverUrl(window.location.origin);
    return h("div", { class: "card", id: "mcp-status-card" },
      h("h3", { text: t("mcp.status.title") }),
      A.kv([
        [t("mcp.status.mcp"), h("span", null, badge(on ? "ok" : "warn", t(on ? "mcp.state.enabled" : "mcp.state.disabled")), " ", h("span", { class: "small muted", id: "mcp-state-note", text: t(on ? "mcp.state.enabled.note" : "mcp.state.disabled.note") }))],
        [t("mcp.status.ai"), h("span", null, badge("warn", t("mcp.ai.state")), " ", h("span", { class: "small muted", id: "mcp-ai-note", text: t("mcp.ai.note") }))],
        [t("mcp.status.url"), h("span", null, h("code", { class: "mono ltr-island", id: "mcp-server-url", text: url }), " ", h("span", { class: "small muted", text: t("mcp.status.urlNote") }))],
      ])
    );
  }

  // ================================================================ create
  function renderCreate() {
    var prevName = $("#mcp-name") ? $("#mcp-name").value : "";
    var prevDays = $("#mcp-days") ? $("#mcp-days").value : String(U.DEFAULT_DAYS);
    var name = h("input", { id: "mcp-name", type: "text", attrs: { maxlength: String(U.NAME_MAX), autocomplete: "off", required: "" }, value: prevName });
    var days = h("select", { id: "mcp-days" });
    A.fillSelect(days, U.DAY_OPTIONS.map(function (n) { return [String(n), t("mcp.create.daysOpt", { n: n })]; }), prevDays);
    var err = h("p", { class: "form-error", id: "mcp-create-error", attrs: { role: "alert" } });
    var submit = h("button", { type: "submit", class: "btn", id: "mcp-create-submit", text: t("mcp.create.submit") });
    var form = h("form", { id: "mcp-create-form", attrs: { novalidate: "" } },
      h("div", { class: "field" }, h("label", { for: "mcp-name", text: t("mcp.create.name") }), name),
      h("div", { class: "field" }, h("label", { for: "mcp-days", text: t("mcp.create.days") }), days),
      err, submit);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (state.creating) return;
      err.textContent = "";
      V.$all("[aria-invalid]", form).forEach(function (el) { el.removeAttribute("aria-invalid"); });
      var n = U.checkName(name.value);
      if (!n.ok) { err.textContent = t("mcp.err." + n.code); name.setAttribute("aria-invalid", "true"); name.focus(); return; }
      var d = U.checkDays(days.value);
      if (!d.ok) { err.textContent = t("mcp.err." + d.code); days.setAttribute("aria-invalid", "true"); days.focus(); return; }
      state.creating = true;
      submit.disabled = true;
      submit.setAttribute("aria-busy", "true");
      submit.textContent = t("mcp.create.busy");
      V.api("POST", "/mcp-tokens", { body: { name: n.value, days: d.value } })
        .then(function (out) {
          name.value = "";
          V.toast(t("mcp.create.done"), "ok");
          openSecret(out);
          return load(true);
        })
        .catch(function (e2) { err.textContent = V.errorMessage(e2); })
        .then(function () {
          state.creating = false;
          submit.disabled = false;
          submit.removeAttribute("aria-busy");
          submit.textContent = t("mcp.create.submit");
        });
    });
    return h("div", { class: "card", id: "mcp-create-card" }, h("h3", { text: t("mcp.create.title") }), h("p", { class: "small muted", text: t("mcp.create.hint") }), form);
  }

  // ================================================================ the one-time secret dialog
  function openSecret(out) {
    closeSecret();
    if (!out || typeof out.secret !== "string") return;
    shownSecret = out.secret;
    dlgOpener = document.activeElement;
    secretOut = h("code", { class: "mono ltr-island mcp-secret", id: "mcp-secret-text", attrs: { dir: "ltr" } });
    secretOut.textContent = shownSecret;
    var copied = h("p", { class: "small", id: "mcp-secret-status", attrs: { "aria-live": "polite" } });
    var copy = h("button", { type: "button", class: "btn", id: "mcp-secret-copy", text: t("mcp.secret.copy") });
    var done = h("button", { type: "button", class: "btn secondary", id: "mcp-secret-close", text: t("mcp.secret.close") });
    copy.addEventListener("click", function () { if (shownSecret) copyText(shownSecret, copied, dlg, secretOut); });
    done.addEventListener("click", function () { closeSecret(); V.announce(t("mcp.secret.closed")); });
    var form = h("div", null,
      h("h2", { id: "mcp-secret-title", text: t("mcp.secret.title") }),
      h("p", { class: "notice warn", id: "mcp-secret-warning", attrs: { role: "alert" }, text: t("mcp.secret.warning") }),
      h("p", { class: "small", text: t("mcp.secret.detail", { name: String(out.name || ""), date: V.fmtDateTime(out.expires_at) }) }),
      h("div", { class: "field" }, h("span", { class: "label", text: t("mcp.secret.label") }), h("div", { class: "mcp-secret-box" }, secretOut)),
      h("div", { class: "btn-row" }, copy, done),
      copied);
    dlg = h("dialog", { class: "wide", attrs: { "aria-labelledby": "mcp-secret-title" } }, form);
    // Escape must not discard the only copy of the secret by accident: closing is the explicit button.
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); });
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    copy.focus();
  }
  function closeSecret() {
    if (secretOut) secretOut.textContent = "";
    shownSecret = null;
    secretOut = null;
    if (dlg) {
      if (dlg.open) dlg.close();
      dlg.remove();
      dlg = null;
    }
    if (dlgOpener && dlgOpener.isConnected && typeof dlgOpener.focus === "function") dlgOpener.focus();
    dlgOpener = null;
  }

  // ================================================================ tokens
  function renderTokens() {
    var rows = (state.data && state.data.rows) || [];
    var admin = isAdmin();
    var headers = [t("mcp.list.name"), t("mcp.list.prefix")];
    if (admin) headers.push(t("mcp.list.owner"));
    headers = headers.concat([t("mcp.list.created"), t("mcp.list.expires"), t("mcp.list.lastUsed"), t("mcp.list.status"), t("mcp.list.actions")]);
    var trs = rows.map(function (r) {
      var status = U.tokenStatus(r);
      var revoke = h("button", { type: "button", class: "btn secondary small", text: t("mcp.revoke.btn"), disabled: !U.canRevoke(r), attrs: { "aria-label": t("mcp.revoke.aria", { name: String(r.name || "") }) } });
      revoke.addEventListener("click", function () {
        V.confirmDialog(t("mcp.revoke.confirm", { name: String(r.name || "") }), t("mcp.revoke.confirmBtn"), true).then(function (yes) {
          if (!yes) return null;
          return V.busy(revoke, function () { return V.api("DELETE", "/mcp-tokens/" + encodeURIComponent(String(r.id))); })
            .then(function () { V.toast(t("mcp.revoke.done"), "ok"); return load(true); }, function () { return null; });
        });
      });
      var cells = [h("td", { text: String(r.name || "") }), h("td", null, h("code", { class: "mono ltr-island", text: U.maskPrefix(r.prefix) }))];
      if (admin) cells.push(h("td", { text: String(r.owner_name || "") }));
      cells.push(
        h("td", null, V.fmtDateTime(r.created_at)),
        h("td", null, V.fmtDateTime(r.expires_at)),
        h("td", null, r.last_used_at ? V.fmtDateTime(r.last_used_at) : t("mcp.list.never")),
        h("td", null, badge(U.statusClass(status), t("mcp.status." + status))),
        h("td", null, revoke));
      return h("tr", null, cells);
    });
    var refresh = h("button", { type: "button", class: "btn secondary small", id: "mcp-refresh", text: t("mcp.list.refresh") });
    refresh.addEventListener("click", function () { V.busy(refresh, function () { return load(true); }); });
    return h("div", { class: "card", id: "mcp-list-card" },
      h("div", { class: "card-head" }, h("h3", { text: t("mcp.list.title") }), h("span", { class: "spacer" }), refresh),
      h("p", { class: "small muted", text: t(admin ? "mcp.list.hintAll" : "mcp.list.hintOwn") }),
      h("div", { id: "mcp-list" }, A.table(headers, trs, { empty: t("mcp.list.empty") })));
  }

  // ================================================================ usage log
  function renderUsage() {
    var rows = (state.usage && state.usage.rows) || [];
    var admin = isAdmin();
    var headers = [t("mcp.usage.time"), t("mcp.usage.tool"), t("mcp.usage.outcome"), t("mcp.usage.duration"), t("mcp.usage.rows"), t("mcp.usage.token")];
    if (admin) headers.push(t("mcp.usage.owner"));
    var trs = rows.map(function (r) {
      var outcome = String(r.outcome || "");
      var cells = [
        h("td", null, V.fmtDateTime(r.created_at)),
        h("td", null, h("code", { class: "mono ltr-island", text: String(r.tool || "—") })),
        h("td", null, V.has("mcp.outcome." + outcome) ? badge(U.outcomeClass(outcome), t("mcp.outcome." + outcome)) : badge("neutral", outcome || "—")),
        h("td", { class: "num" }, ltr(U.formatMs(r.duration_ms))),
        h("td", { class: "num", text: typeof r.rows === "number" ? String(r.rows) : "—" }),
        h("td", null, String(r.token_name || "—") + " ", h("code", { class: "mono ltr-island", text: r.token_prefix ? U.maskPrefix(r.token_prefix) : "" })),
      ];
      if (admin) cells.push(h("td", { text: String(r.owner_name || "") }));
      return h("tr", null, cells);
    });
    return h("div", { class: "card", id: "mcp-usage-card" },
      h("h3", { text: t("mcp.usage.title") }),
      h("p", { class: "small muted", text: t("mcp.usage.hint", { n: U.USAGE_LIMIT }) + " " + t(admin ? "mcp.usage.scopeAll" : "mcp.usage.scopeOwn") }),
      h("div", { id: "mcp-usage" }, A.table(headers, trs, { empty: t("mcp.usage.empty") })));
  }

  // ================================================================ connection help
  function snippetBlock(id, title, hint, text) {
    var status = h("p", { class: "small", id: id + "-status", attrs: { "aria-live": "polite" } });
    var code = h("code", { id: id + "-text" });
    code.textContent = text;
    var pre = h("pre", { class: "mcp-snippet", id: id, attrs: { dir: "ltr", tabindex: "0", "aria-label": t("mcp.connect.snippetLabel", { title: title }) } }, code);
    var host = h("div", { class: "mcp-snippet-wrap" });
    var copy = h("button", { type: "button", class: "btn secondary small", id: id + "-copy", text: t("mcp.connect.copy") });
    copy.addEventListener("click", function () { copyText(text, status, host, code); });
    host.appendChild(copy);
    host.appendChild(status);
    return h("div", { class: "field" }, h("h4", { text: title }), h("p", { class: "small muted", text: hint }), pre, host);
  }
  function renderConnect() {
    var base = window.location.origin;
    return h("div", { class: "card", id: "mcp-connect-card" },
      h("h3", { text: t("mcp.connect.title") }),
      h("p", { class: "small muted", text: t("mcp.connect.hint") }),
      h("p", { class: "notice info small", id: "mcp-placeholder-note", text: t("mcp.connect.placeholder") }),
      snippetBlock("mcp-snippet-desktop", t("mcp.connect.desktop.title"), t("mcp.connect.desktop.hint"), U.desktopSnippet(base)),
      snippetBlock("mcp-snippet-code", t("mcp.connect.code.title"), t("mcp.connect.code.hint"), U.codeSnippet(base)));
  }

  // ================================================================ limits and safety
  function listOf(keys) { return h("ul", null, keys.map(function (k) { return h("li", { text: t(k) }); })); }
  function renderLimits() {
    return h("div", { class: "card", id: "mcp-limits-card" },
      h("h3", { text: t("mcp.limits.title") }),
      h("div", { class: "mcp-limits" },
        h("div", null, h("h4", { text: t("mcp.limits.can") }), listOf(["mcp.limits.canRead", "mcp.limits.scope"])),
        h("div", null, h("h4", { text: t("mcp.limits.cannot") }), listOf(["mcp.limits.readOnly", "mcp.limits.noSecrets", "mcp.limits.noOthers"]))),
      listOf(["mcp.limits.audit", "mcp.limits.expiry"]),
      h("div", { class: "notice warn", id: "mcp-safety" }, h("strong", { text: t("mcp.safety.title") }), h("p", { text: t("mcp.safety.body") }), h("p", { text: t("mcp.safety.tip") })));
  }

  // ================================================================ load / render
  function render() {
    var box = root();
    if (!box) return;
    var parts = [renderStatus(), renderCreate()];
    if (state.loadError) parts.push(h("div", { class: "card" }, h("p", { class: "notice bad", attrs: { role: "alert" }, text: t("mcp.loadError") + " " + state.loadError })));
    else if (!state.data) parts.push(h("div", { class: "card" }, V.loading()));
    else parts.push(renderTokens(), renderUsage());
    parts.push(renderConnect(), renderLimits());
    V.setContent.apply(null, [box].concat(parts));
  }

  function sessionKey() {
    var s = V.getSession();
    return s ? String(s.userId) + ":" + String(s.role) : null;
  }

  function load(force) {
    if (!U.canUse(role())) return Promise.resolve();
    var key = sessionKey();
    if (state.key !== key) {
      // Another person signed in on this page: nothing the previous one saw may remain.
      state.data = null;
      state.usage = null;
      state.loadError = null;
      state.key = key;
    }
    if (!state.data) render();
    var mine = key;
    return Promise.all([V.api("GET", "/mcp-tokens"), V.api("GET", "/mcp-tokens/usage?limit=" + U.USAGE_LIMIT)])
      .then(function (res) {
        if (state.key !== mine) return;
        state.data = res[0];
        state.usage = res[1];
        state.loadError = null;
        render();
      })
      .catch(function (err) {
        if (state.key !== mine) return;
        state.loadError = V.errorMessage(err);
        render();
      });
  }

  function onStop() {
    closeSecret();
    state.data = null;
    state.usage = null;
    state.key = null;
    state.loadError = null;
    var box = root();
    if (box) V.clear(box);
  }

  A.registerTab("mcp", { init: function () { render(); }, load: function () { return load(false); }, onStop: onStop, visible: function () { return U.canUse(A.role()); } });
})();
