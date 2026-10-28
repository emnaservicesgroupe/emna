/* "Assistant access" console helpers (MCP personal access tokens, stage 7): permission mirror, validation of the create form, masked
   token prefixes, token status, usage-log wording and the copy-paste connection snippets. Pure data/logic only (no DOM): loaded as a
   classic script in the browser (window.VITA_MCP_UTIL) and required by tests/mcp-ui.test.js. The server stays the authority on every
   rule mirrored here (modules/mcp/tokens.js).

   Secrets: a token secret is shown once by the console (mcp-admin.js) and is never passed to anything in this file by default. The
   snippet builders use the placeholder <YOUR_TOKEN>; they accept a real secret only through an explicit `secret` option AND only when it
   has the exact token shape, so nothing else can ever be injected into a command line or a JSON file. */
(function (root) {
  "use strict";

  var CU = root.VITA_CRM_UTIL || (typeof require === "function" ? require("./crm-util.js") : null);

  var DAY_OPTIONS = [7, 30, 90];
  var DEFAULT_DAYS = 30;
  var MAX_DAYS = 90;
  var NAME_MAX = 80;
  var TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";
  var URL_PLACEHOLDER = "<YOUR_VITA_URL>";
  var SECRET_RE = /^vita_pat_[A-Za-z0-9_-]{43}$/;
  var PREFIX_RE = /^[A-Za-z0-9_-]{8}$/;
  var STATUSES = ["active", "expired", "revoked"];
  var USAGE_LIMIT = 50;

  // ---------------------------------------------------------------- permissions (mirror of middleware/role.js)
  function canUse(role) { return Boolean(CU) && CU.can(role, "mcp:use"); }

  function fail(code) { return { ok: false, code: code }; }

  // ---------------------------------------------------------------- create form
  /** Days: a whole number 1..90, as a number or a string of ASCII digits. */
  function checkDays(v) {
    var n;
    if (typeof v === "number") n = v;
    else if (typeof v === "string" && /^[0-9]{1,3}$/.test(v.trim())) n = Number(v.trim());
    else return fail("days");
    if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > MAX_DAYS) return fail("days");
    return { ok: true, value: n };
  }

  /** Name: 1..80 characters after trimming, no control or bidi-override characters (same rule as the server). */
  function checkName(v) {
    if (typeof v !== "string") return fail("nameEmpty");
    var n = v.trim();
    if (n.length < 1) return fail("nameEmpty");
    if (n.length > NAME_MAX) return fail("nameLong");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(n)) return fail("nameChars");
    return { ok: true, value: n };
  }

  // ---------------------------------------------------------------- display
  /** The only part of a token the console ever shows after creation: its 8 stored characters inside the fixed shape. */
  function maskPrefix(prefix) {
    return typeof prefix === "string" && PREFIX_RE.test(prefix) ? "vita_pat_" + prefix + "…" : "—";
  }

  /** "active" | "expired" | "revoked". The server's status wins; an unknown or unreadable row is never "active". */
  function tokenStatus(row, nowMs) {
    if (!row || typeof row !== "object") return "expired";
    if (STATUSES.indexOf(row.status) >= 0) return row.status;
    if (row.revoked_at) return "revoked";
    var exp = typeof row.expires_at === "string" ? Date.parse(row.expires_at) : NaN;
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    return isFinite(exp) && exp > now ? "active" : "expired";
  }
  function canRevoke(row) { return tokenStatus(row) !== "revoked"; }
  function statusClass(status) { return status === "active" ? "ok" : status === "revoked" ? "bad" : "warn"; }
  function outcomeClass(outcome) { return outcome === "ok" ? "ok" : outcome === "denied" ? "warn" : outcome === "error" ? "bad" : "neutral"; }
  /** True only when the server says exactly `true` (MCP_ENABLED). */
  function mcpState(data) { return data && data.mcp_enabled === true ? "enabled" : "disabled"; }

  /** Whole milliseconds -> "12 ms" / "1.2 s" by integer arithmetic. */
  function formatMs(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || Math.floor(ms) !== ms || ms < 0) return "—";
    if (ms < 1000) return ms + " ms";
    var tenths = Math.floor(ms / 100);
    return Math.floor(tenths / 10) + "." + (tenths % 10) + " s";
  }

  // ---------------------------------------------------------------- connection snippets
  function isSecret(s) { return typeof s === "string" && SECRET_RE.test(s); }

  /** The origin of an http(s) URL without credentials, path, query or fragment; anything else -> the placeholder. */
  function serverUrl(v) {
    if (typeof v !== "string" || !v) return URL_PLACEHOLDER;
    var u;
    try { u = new URL(v); } catch (e) { return URL_PLACEHOLDER; }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || !u.hostname) return URL_PLACEHOLDER;
    return u.origin;
  }
  function tokenFor(opts) { return opts && isSecret(opts.secret) ? opts.secret : TOKEN_PLACEHOLDER; }

  /** Claude Desktop (claude_desktop_config.json): a local stdio server that forwards to POST <base>/mcp. */
  function desktopSnippet(base, opts) {
    return JSON.stringify({
      mcpServers: {
        vita: {
          command: "node",
          args: ["/path/to/trust-crm/scripts/mcp-stdio.js"],
          env: { VITA_BASE_URL: serverUrl(base), VITA_MCP_TOKEN: tokenFor(opts) },
        },
      },
    }, null, 2);
  }

  /** Claude Code: the streamable-HTTP server added from the command line. */
  function codeSnippet(base, opts) {
    return "claude mcp add --transport http vita " + serverUrl(base) + "/mcp --header \"Authorization: Bearer " + tokenFor(opts) + "\"";
  }

  var api = {
    DAY_OPTIONS: DAY_OPTIONS, DEFAULT_DAYS: DEFAULT_DAYS, MAX_DAYS: MAX_DAYS, NAME_MAX: NAME_MAX, USAGE_LIMIT: USAGE_LIMIT,
    TOKEN_PLACEHOLDER: TOKEN_PLACEHOLDER, URL_PLACEHOLDER: URL_PLACEHOLDER, STATUSES: STATUSES,
    canUse: canUse, checkDays: checkDays, checkName: checkName, maskPrefix: maskPrefix, tokenStatus: tokenStatus, canRevoke: canRevoke,
    statusClass: statusClass, outcomeClass: outcomeClass, mcpState: mcpState, formatMs: formatMs,
    isSecret: isSecret, serverUrl: serverUrl, desktopSnippet: desktopSnippet, codeSnippet: codeSnippet,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VITA_MCP_UTIL = api;
})(typeof window !== "undefined" ? window : this);
