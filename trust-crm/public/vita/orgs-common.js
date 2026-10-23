/* Shared browser code for the employer / agency portals and the staff organisation tabs:
   e-mail code login (same flow as the candidate portal), tabs, pager, tables, validation messages and the
   timeline wording for organisation events. Server text (names, notes, candidate summaries) is untrusted and is
   only ever rendered through the textContent helpers of vita.js (V.h). */
(function () {
  "use strict";
  var V = window.VITA;
  var O = window.VITA_ORGS_UTIL;
  var t = V.t, h = V.h, $ = V.$;

  // ---------------------------------------------------------------- small views
  function errorBox(err) { return h("p", { class: "notice bad", attrs: { role: "alert" }, text: V.errorMessage(err) }); }

  function badge(cls, text) { return h("span", { class: "badge " + (cls || "neutral"), text: text }); }

  /** <dl> of [label, value] pairs; empty values show a dash. Values are text or DOM nodes built with V.h. */
  function kv(pairs) {
    var dl = h("dl", { class: "kv" });
    pairs.forEach(function (p) {
      if (!p) return;
      dl.appendChild(h("dt", { text: p[0] }));
      dl.appendChild(h("dd", null, p[1] === null || p[1] === undefined || p[1] === "" ? "—" : p[1]));
    });
    return dl;
  }

  function table(headers, rows, opts) {
    var o = opts || {};
    if (!rows.length) return V.empty(o.empty);
    var thead = h("thead", null, h("tr", null, headers.map(function (x) { return h("th", { scope: "col", text: x }); })));
    return h("div", { class: "table-wrap" }, h("table", null, o.caption ? h("caption", { class: "sr-only", text: o.caption }) : null, thead, h("tbody", null, rows)));
  }

  function option(value, label, selected) { return h("option", { value: value, text: label, selected: selected }); }
  function fillSelect(sel, items, current) {
    V.clear(sel);
    items.forEach(function (it) { sel.appendChild(option(it[0], it[1], String(it[0]) === String(current === undefined || current === null ? "" : current))); });
  }

  /** Previous / next pager. */
  function pager(box, page, pages, go) {
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

  // ---------------------------------------------------------------- validation messages
  /** Localised message for a helper result {field, error}. */
  function validationMessage(res) {
    var field = V.has("orgs.f." + res.field) ? t("orgs.f." + res.field) : res.field;
    if (res.error === "contact") return t("orgs.v.contact");
    return t(V.has("orgs.v." + res.error) ? "orgs.v." + res.error : "orgs.v.invalid", { field: field });
  }

  /** Marks the control of a failed field and focuses it. `ids` maps field code -> element id. */
  function flagField(res, idOf, errEl) {
    errEl.textContent = validationMessage(res);
    V.$all("[aria-invalid]").forEach(function (el) { el.removeAttribute("aria-invalid"); });
    var el = document.getElementById(idOf(res.field));
    if (el) {
      el.setAttribute("aria-invalid", "true");
      el.focus();
    }
  }

  // ---------------------------------------------------------------- tabs
  /** Wires a tablist whose buttons carry data-tab and whose panels are #panel-<name>. Returns {select}. */
  function tabs(listEl, onSelect) {
    var buttons = V.$all("[role=tab]", listEl);
    function select(name, focusPanel) {
      buttons.forEach(function (b) {
        var on = b.getAttribute("data-tab") === name;
        b.setAttribute("aria-selected", String(on));
        b.tabIndex = on ? 0 : -1;
      });
      V.$all("[role=tabpanel]").forEach(function (p) { p.hidden = p.id !== "panel-" + name; });
      if (focusPanel) {
        var panel = document.getElementById("panel-" + name);
        if (panel) panel.focus();
      }
      if (onSelect) onSelect(name);
    }
    buttons.forEach(function (b, i) {
      b.addEventListener("click", function () { select(b.getAttribute("data-tab"), true); });
      b.addEventListener("keydown", function (e) {
        var rtl = document.documentElement.dir === "rtl";
        var next = null;
        if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = buttons[(i + 1) % buttons.length];
        else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = buttons[(i - 1 + buttons.length) % buttons.length];
        else if (e.key === "Home") next = buttons[0];
        else if (e.key === "End") next = buttons[buttons.length - 1];
        if (next) {
          e.preventDefault();
          next.focus();
          select(next.getAttribute("data-tab"), false);
        }
      });
    });
    return { select: select, first: buttons.length ? buttons[0].getAttribute("data-tab") : null };
  }

  // ---------------------------------------------------------------- timeline wording
  var EVENTS = ["created", "updated", "portal_user_invited", "suspended", "reactivated", "candidate_registered", "status_changed", "notes_updated", "site_job_created", "candidate_presented", "presented", "employer_responded", "withdrawn", "cancelled"];

  function describeEvent(row) {
    var d = (row && row.detail) || {};
    var from = function (prefix, v) { return V.has(prefix + v) ? t(prefix + v) : String(v === undefined || v === null ? "—" : v); };
    switch (row && row.event) {
      case "created": return String(d.title || d.name || "");
      case "updated": return Array.isArray(d.fields) ? d.fields.join(", ") : "";
      case "notes_updated": return Array.isArray(d.fields) ? d.fields.join(", ") : "";
      case "portal_user_invited": return String(d.email || "");
      case "suspended":
      case "reactivated": return t("orgs.ev.users", { n: Number(d.users) || 0 });
      case "status_changed":
      case "cancelled": return t("orgs.ev.change", { from: from("orgs.rstatus.", d.from), to: from("orgs.rstatus.", d.to) });
      case "employer_responded": return t("orgs.ev.change", { from: from("orgs.pstatus.", d.from), to: from("orgs.pstatus.", d.to) });
      case "site_job_created": return t("orgs.ev.siteJob", { id: d.site_job_id });
      case "candidate_presented": return t("orgs.ev.candidate", { id: d.candidate_id });
      case "presented": return t("orgs.ev.candidate", { id: d.candidate_id });
      case "candidate_registered": return t("orgs.ev.lead", { id: d.lead_id });
      default: return "";
    }
  }

  function timelineList(rows, emptyKey) {
    var list = Array.isArray(rows) ? rows : [];
    if (!list.length) return V.empty(t(emptyKey || "crm.notes.empty"));
    return h("ol", { class: "timeline" }, list.map(function (r) {
      var label = EVENTS.indexOf(r.event) >= 0 ? t("orgs.ev." + r.event) : String(r.event || "").replace(/_/g, " ");
      var text = describeEvent(r);
      return h("li", null,
        h("div", { class: "when" }, V.fmtDateTime(r.created_at), r.actor_name ? " · " + r.actor_name : ""),
        h("strong", { text: label }),
        text ? h("p", { class: "note-text", text: text }) : null
      );
    }));
  }

  // ---------------------------------------------------------------- e-mail code login (portal pages)
  var cooldownTimer = null;

  function stopCooldown() {
    if (cooldownTimer) window.clearInterval(cooldownTimer);
    cooldownTimer = null;
  }

  /** Disables the resend button for `seconds`, counting down in its label. */
  function startCooldown(seconds) {
    var btn = $("#otp-resend");
    if (!btn) return;
    stopCooldown();
    var left = seconds;
    var paint = function () {
      btn.disabled = left > 0;
      V.setContent(btn, left > 0 ? t("orgs.otp.resendIn", { s: left }) : t("orgs.otp.resend"));
    };
    paint();
    cooldownTimer = window.setInterval(function () {
      left -= 1;
      paint();
      if (left <= 0) stopCooldown();
    }, 1000);
  }

  /**
   * cfg: { kind: "employer"|"agency", role: "Employer"|"Agency", onReady(), onLogout() }.
   * Request -> code -> verify. The token is only stored when the server confirms the expected portal role.
   */
  function initLogin(cfg) {
    var err = $("#otp-error");
    var emailInput = $("#otp-email");

    function requestCode(btn, resend) {
      err.textContent = "";
      var email = emailInput.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        emailInput.setAttribute("aria-invalid", "true");
        err.textContent = t("otp.badEmail");
        emailInput.focus();
        return;
      }
      emailInput.removeAttribute("aria-invalid");
      V.busy(btn, function () {
        return V.api("POST", "/jobsearch/auth/otp/request", { body: { email: email }, noAuth: true }).then(function () {
          // Always the same message: we never reveal whether an account exists.
          $("#otp-request-form").hidden = true;
          $("#otp-verify-form").hidden = false;
          startCooldown(O.OTP_COOLDOWN_SECONDS);
          V.announce(t("otp.generic"));
          if (resend) V.toast(t("orgs.otp.resent"), "ok");
          $("#otp-code").focus();
        });
      }).catch(function (e) {
        if (e && e.status === 429) {
          err.textContent = t("orgs.otp.wait");
          if ($("#otp-verify-form").hidden === false) startCooldown(O.OTP_COOLDOWN_SECONDS);
        } else err.textContent = V.errorMessage(e);
      });
    }

    $("#otp-request-form").addEventListener("submit", function (e) {
      e.preventDefault();
      requestCode($("#otp-request-form button[type=submit]"), false);
    });
    $("#otp-resend").addEventListener("click", function () { requestCode($("#otp-resend"), true); });
    $("#otp-back").addEventListener("click", function () {
      stopCooldown();
      $("#otp-verify-form").hidden = true;
      $("#otp-request-form").hidden = false;
      $("#otp-code").value = "";
      err.textContent = "";
      emailInput.focus();
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
      V.busy($("#otp-verify-form button[type=submit]"), function () {
        return V.api("POST", "/jobsearch/auth/otp/verify", { body: { email: emailInput.value.trim(), code: code }, noAuth: true }).then(function (r) {
          $("#otp-code").value = "";
          if (!r || r.role !== cfg.role) {
            // A candidate (or other) code belongs to another portal: never keep that token here.
            err.textContent = t("orgs.otp.wrongPortal");
            return;
          }
          stopCooldown();
          V.setSession({ kind: cfg.kind, token: r.token, role: r.role });
          cfg.onReady();
        });
      }).catch(function (e2) { err.textContent = e2 && e2.status === 401 ? t("otp.invalid") : e2 && e2.status === 429 ? t("orgs.otp.wait") : V.errorMessage(e2); });
    });
    $("#logout").addEventListener("click", function () {
      V.clearSession();
      V.announce(t("common.signedOut"));
      cfg.onLogout();
    });
  }

  /** Shows the code-login screen and hides the portal. */
  function showLogin() {
    stopCooldown();
    $("#app-view").hidden = true;
    $("#logout").hidden = true;
    V.setContent($("#who"));
    $("#login-view").hidden = false;
    $("#otp-request-form").hidden = false;
    $("#otp-verify-form").hidden = true;
    $("#otp-email").focus();
  }

  function showApp(orgName) {
    $("#login-view").hidden = true;
    $("#app-view").hidden = false;
    $("#logout").hidden = false;
    V.setContent($("#who"), orgName || "");
  }

  window.VITA_ORGS = {
    errorBox: errorBox, badge: badge, kv: kv, table: table, option: option, fillSelect: fillSelect, pager: pager,
    validationMessage: validationMessage, flagField: flagField, tabs: tabs,
    timelineList: timelineList, describeEvent: describeEvent, EVENTS: EVENTS,
    initLogin: initLogin, showLogin: showLogin, showApp: showApp,
  };
})();
