// Stage 7, Task 4: staff console tab "Assistant access" (public/vita/mcp-util.js, mcp-admin.js).
// Static checks (ar/en/fr parity, CSP safety, wiring, secret handling), unit tests of the pure helpers (connection snippets,
// day / name validation, masked prefixes, token status) and the permission mirror against middleware/role.js.
// The rendered behaviour (secret shown once, revoke, usage, RTL, 375 px) is covered by the browser smoke in the task report.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "mcp-ui-test-secret";

const VITA = path.join(__dirname, "..", "public", "vita");
const I18N = require("../public/vita/i18n.js");
const U = require("../public/vita/mcp-util.js");
const CU = require("../public/vita/crm-util.js");
const { PERMISSIONS } = require("../middleware/role");
const { STAFF_ROLES } = require("../middleware/staff");

const read = (f) => fs.readFileSync(path.join(VITA, f), "utf8");
const MCP_JS = ["mcp-util.js", "mcp-admin.js"];
const LANGS = ["ar", "en", "fr"];
const SINKS = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b|setTimeout\(\s*["'`]|setInterval\(\s*["'`]/;
const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
const SECRET = "vita_pat_" + "A1b2C3d4".repeat(5) + "xyz"; // 9 + 43 characters

// ---------------------------------------------------------------- wiring

test("admin.html: Assistant access tab + panel, mcp scripts after crm-util.js and admin.js (util first), no inline code, every data-i18n key resolves", () => {
  const html = read("admin.html");
  assert.match(html, /<button type="button" role="tab" id="tab-mcp" aria-controls="panel-mcp" data-tab="mcp" data-i18n="tab\.mcp">/);
  assert.match(html, /<section id="panel-mcp" role="tabpanel" aria-labelledby="tab-mcp"/);
  const order = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(order.slice(-MCP_JS.length), MCP_JS, "mcp scripts come last, util first");
  for (const f of MCP_JS) assert.ok(order.indexOf(f) > order.indexOf("admin.js") && order.indexOf(f) > order.indexOf("crm-util.js"), f);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /(?:href|src)="(?:https?:)?\/\//i);
  const missing = [];
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) for (const l of LANGS) if (!(m[1] in I18N.dictionaries[l])) missing.push(`${l}:${m[1]}`);
  assert.deepEqual(missing, []);
  for (const f of MCP_JS) assert.ok(fs.existsSync(path.join(VITA, f)), f);
  assert.match(html, /id="mcp-root"/);
});

test("the API client allows /mcp-tokens besides the existing prefixes (which are unchanged); /mcp itself is not callable from the console", () => {
  const src = read("vita.js");
  for (const re of [/\^\\\/\(jobsearch\|auth\|crm\)\\\//, /\^\\\/\(employer\|agency\)\\\//, /\^\\\/finance\\\//, /\^\\\/hr\\\//, /\^\\\/chat\\\//]) assert.match(src, re);
  const m = /\/(\^\\\/mcp-tokens\(\?:\[\\\/\?\]\|\$\))\/\.test\(path\)/.exec(src);
  assert.ok(m, "allowlist entry for /mcp-tokens");
  const re = new RegExp(m[1]);
  for (const ok of ["/mcp-tokens", "/mcp-tokens/", "/mcp-tokens/12", "/mcp-tokens/usage?limit=50", "/mcp-tokens?x=1"]) assert.ok(re.test(ok), ok);
  for (const bad of ["/mcp", "/mcp/", "/mcp-tokensx", "/mcp-token", "//mcp-tokens", "/x/mcp-tokens"]) assert.ok(!re.test(bad), bad);
});

test("admin.js: the tab registers through the extension API and is visible only with mcp:use", () => {
  const src = read("mcp-admin.js");
  assert.match(src, /A\.registerTab\("mcp",/);
  assert.match(src, /visible: function \(\) \{ return U\.canUse\(/);
  assert.match(read("admin.html"), /id="tab-mcp"[^>]*data-i18n="tab\.mcp"/);
});

test("static scan: mcp scripts render text via the DOM helpers only, call only literal /mcp-tokens paths, store and log nothing", () => {
  for (const f of MCP_JS) {
    const src = read(f);
    src.split("\n").forEach((line, i) => assert.doesNotMatch(line, SINKS, `${f}:${i + 1}`));
    assert.doesNotMatch(src, /https?:\/\//, `${f}: no absolute URL (no external resource, no hard-coded host)`);
    assert.doesNotMatch(src, /\b(?:href|src)\s*:|srcdoc|\.(?:href|src)\s*=|setAttribute\(\s*["'](?:on|href|src|style)|\.on[a-z]+\s*=/, `${f}: link/handler sink`);
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${f}: nothing is stored in the browser (the secret least of all)`);
    assert.doesNotMatch(src, /console\.(log|info|debug|warn|error)/, `${f}: console output`);
    assert.doesNotMatch(src, /[?&](?:token|access_token|secret)=/, `${f}: secret in a URL`);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest/, `${f}: network access goes through V.api`);
    assert.doesNotMatch(src, /\bstyle\s*:|\.style\b|cssText/, `${f}: no inline styles (CSP)`);
    assert.doesNotMatch(src, /location\.(?:hash|search)\s*=|history\.(?:push|replace)State/, `${f}: nothing goes into the URL`);
    assert.doesNotMatch(src, /attrs\s*:\s*\{\s*\[/, `${f}: computed attribute names`);
    if (f === "mcp-util.js") continue;
    for (const m of src.matchAll(/V\.api\(\s*"[A-Z]+"\s*,\s*"([^"]*)"/g)) assert.match(m[1], /^\/mcp-tokens(?:\/|\?|$)/, `${f}: ${m[1]}`);
    for (const m of src.matchAll(/V\.api\(\s*"[A-Z]+"\s*,\s*([^"\s][^,)]*)/g)) assert.fail(`${f}: API path must start with a string literal: ${m[1]}`);
    for (const m of src.matchAll(/h\("button",\s*\{([^}]*)\}/g)) assert.match(m[1], /type:/, `${f}: button without a type: ${m[0].slice(0, 60)}`);
  }
  assert.doesNotMatch(read("mcp-util.js"), /\bdocument\b|\bwindow\.VITA\b|\bV\./, "pure helpers never touch the DOM");
});

test("mcp-admin.js: the secret lives in one variable and one text node, is cleared when the dialog closes, uses the clipboard API with a fallback", () => {
  const src = read("mcp-admin.js");
  assert.match(src, /navigator\.clipboard/);
  assert.match(src, /execCommand\(\s*["']copy["']\s*\)/, "fallback for browsers / contexts without the async clipboard");
  assert.match(src, /shownSecret = null/, "the in-memory copy is dropped");
  assert.match(src, /dlg\.remove\(\)/, "the dialog (and the text node holding the secret) leaves the DOM");
  assert.match(src, /secretOut\.textContent = ""/, "the secret text is blanked before removal");
  // the snippets never receive the secret: they use the placeholder only
  assert.doesNotMatch(src, /(?:desktopSnippet|codeSnippet)\([^)]*shownSecret/);
  assert.doesNotMatch(src, /(?:desktopSnippet|codeSnippet)\([^)]*\.secret/);
  assert.match(src, /autocomplete: "off"/);
});

test("served under the strict /vita CSP like every other script", async () => {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const f of [...MCP_JS, "admin.html"]) {
      const res = await fetch(`${base}/vita/${f}`);
      assert.equal(res.status, 200, f);
      assert.match(res.headers.get("content-security-policy"), /script-src 'self'; style-src 'self'/, f);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      await res.arrayBuffer();
    }
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
});

// ---------------------------------------------------------------- i18n

test("i18n: tab.mcp and every mcp.* key exist in ar/en/fr, non-empty, identical placeholders, actually translated, identical key sets", () => {
  const { en, ar, fr } = I18N.dictionaries;
  const keys = Object.keys(en).filter((k) => k.startsWith("mcp.") || k === "tab.mcp");
  assert.ok(keys.length >= 75, `mcp keys: ${keys.length}`);
  for (const k of keys) {
    for (const [name, d] of [["ar", ar], ["fr", fr]]) {
      assert.equal(typeof d[k], "string", `${name}.${k}`);
      assert.ok(d[k].trim().length > 0, `${name}.${k} empty`);
      assert.equal(ph(d[k]), ph(en[k]), `${name}.${k} placeholders`);
    }
  }
  for (const k of ["tab.mcp", "mcp.title", "mcp.create.submit", "mcp.secret.warning", "mcp.revoke.confirm", "mcp.limits.readOnly"]) {
    assert.match(ar[k], /[؀-ۿ]/, `ar ${k}`);
    assert.notEqual(fr[k], en[k], `fr ${k} should be translated`);
  }
  assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  assert.equal(en["tab.mcp"], "Assistant access");
});

test("i18n: every t(\"...\") key and every complete \"mcp.*\" key literal in the mcp scripts exists in ar/en/fr, and the required messages are present", () => {
  const used = new Set();
  for (const f of MCP_JS) {
    const src = read(f);
    for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"\s*[,)]/g)) used.add(m[1]);
    for (const m of src.matchAll(/"(mcp(?:\.[a-zA-Z0-9_]+)+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 50, `expected many keys, got ${used.size}`);
  const missing = [];
  for (const k of used) for (const l of LANGS) if (!(k in I18N.dictionaries[l])) missing.push(`${l}:${k}`);
  assert.deepEqual(missing, []);
  const en = I18N.dictionaries.en;
  const all = Object.entries(en).filter(([k]) => k.startsWith("mcp.")).map(([, v]) => v).join("\n");
  assert.match(all, /off by default; the server administrator enables it/i);
  assert.match(all, /requires an LLM provider key/i);
  assert.match(all, /not sending data anywhere/i);
  assert.match(all, /store it now; it cannot be shown again/i);
  assert.match(all, /ignore|instructions/i);
});

test("i18n: runtime-built key families (statuses, outcomes, helper error codes, sections) all exist in all three languages", () => {
  const fam = {
    "mcp.status": ["active", "expired", "revoked"],
    "mcp.outcome": ["ok", "denied", "error"],
    "mcp.state": ["enabled", "disabled"],
  };
  const missing = [];
  for (const [p, codes] of Object.entries(fam)) for (const c of codes) for (const l of LANGS) if (!(`${p}.${c}` in I18N.dictionaries[l])) missing.push(`${l}:${p}.${c}`);
  const src = read("mcp-util.js");
  let fails = 0;
  for (const m of src.matchAll(/fail\(\s*"([A-Za-z_]+)"\s*\)/g)) {
    fails += 1;
    for (const l of LANGS) if (!(`mcp.err.${m[1]}` in I18N.dictionaries[l])) missing.push(`${l}:mcp.err.${m[1]}`);
  }
  assert.ok(fails >= 4, `expected the validators' failure sites, got ${fails}`);
  assert.deepEqual([...new Set(missing)], []);
});

// ---------------------------------------------------------------- permission mirror

test("crm-util can() and mcp-util canUse() equal middleware/role.js PERMISSIONS for mcp:use for every role (and deny unknown roles)", () => {
  for (const [role, perms] of Object.entries(PERMISSIONS)) {
    const expected = perms.includes("*") || perms.includes("mcp:use");
    assert.equal(CU.can(role, "mcp:use"), expected, `crm-util ${role}`);
    assert.equal(U.canUse(role), expected, `mcp-util ${role}`);
  }
  for (const role of [undefined, null, "", "Nobody", "__proto__", "constructor", "Candidate", "Employer", "Agency"]) assert.equal(U.canUse(role), false, String(role));
  assert.deepEqual([...STAFF_ROLES].filter((r) => U.canUse(r)).sort(), ["Admin", "Manager", "SuperAdmin"]);
  for (const r of ["Receptionist", "Agent", "HR", "Accountant"]) assert.equal(U.canUse(r), false, r);
});

test("crm-util can() still mirrors every key it mirrored before (mcp:use was added, nothing removed)", () => {
  for (const role of ["SuperAdmin", "Admin", "Manager", "Receptionist", "Agent", "Accountant", "HR"]) {
    for (const p of ["finance:read", "finance:write", "leads:read", "leads:write", "sitejobs:write", "orgs:read", "orgs:write", "users:write", "candidates:read", "candidates:write", "hr:read", "hr:write", "hr:approve", "chat:read", "chat:write", "chat:moderate"]) {
      const perms = PERMISSIONS[role];
      assert.equal(CU.can(role, p), perms.includes("*") || perms.includes(p), `${role} ${p}`);
    }
  }
});

// ---------------------------------------------------------------- days / name validation

test("checkDays: whole numbers 1..90 (numbers or digit strings); everything else is refused; the select offers 7, 30 and 90", () => {
  assert.deepEqual(U.DAY_OPTIONS, [7, 30, 90]);
  assert.equal(U.MAX_DAYS, 90);
  assert.ok(U.DAY_OPTIONS.includes(U.DEFAULT_DAYS));
  for (const [v, n] of [[1, 1], [7, 7], [30, 30], [90, 90], ["7", 7], ["90", 90], [" 30 ", 30]]) assert.deepEqual(U.checkDays(v), { ok: true, value: n }, String(v));
  for (const bad of [0, 91, -1, 1.5, "1.5", "0", "91", "", "abc", "1e1", "0x10", null, undefined, NaN, Infinity, {}, [], true, "٣٠", "09x"]) {
    const r = U.checkDays(bad);
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.code, "days");
  }
});

test("checkName: 1..80 characters after trimming, no control or bidi-override characters", () => {
  assert.deepEqual(U.checkName("  My laptop  "), { ok: true, value: "My laptop" });
  assert.equal(U.checkName("x".repeat(80)).ok, true);
  assert.equal(U.checkName("x".repeat(81)).code, "nameLong");
  for (const bad of ["", "   ", null, undefined, 5, {}]) assert.equal(U.checkName(bad).code, "nameEmpty", String(bad));
  for (const bad of ["a\u0000b", "a\nb", "a‮b", "a⁦b", "a\u007fb"]) assert.equal(U.checkName(bad).code, "nameChars", JSON.stringify(bad));
  assert.equal(U.checkName("حاسوب المكتب").ok, true);
});

// ---------------------------------------------------------------- masked prefix, status, usage helpers

test("maskPrefix: shows the 8 stored characters inside the fixed token shape, never anything else", () => {
  assert.equal(U.maskPrefix("AbCd1234"), "vita_pat_AbCd1234…");
  assert.equal(U.maskPrefix("a-_B9z0Q"), "vita_pat_a-_B9z0Q…");
  for (const bad of ["", "short", "toolongprefix", "bad char", "<script>", null, undefined, 12345678, SECRET, "AbCd123\n"]) assert.equal(U.maskPrefix(bad), "—", String(bad));
  assert.ok(!/[A-Za-z0-9_-]{20}/.test(U.maskPrefix("AbCd1234")), "never a full-length secret");
});

test("tokenStatus: the server's status wins, else revoked > expired > active from the dates; unknown values degrade to expired (never active)", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  assert.equal(U.tokenStatus({ status: "revoked" }, now), "revoked");
  assert.equal(U.tokenStatus({ status: "active" }, now), "active");
  assert.equal(U.tokenStatus({ revoked_at: "2026-10-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z" }, now), "revoked");
  assert.equal(U.tokenStatus({ revoked_at: null, expires_at: "2026-10-27T11:59:59Z" }, now), "expired");
  assert.equal(U.tokenStatus({ revoked_at: null, expires_at: "2026-11-27T00:00:00Z" }, now), "active");
  for (const bad of [null, undefined, {}, { status: "weird" }, { expires_at: "garbage" }]) assert.notEqual(U.tokenStatus(bad, now), "active", JSON.stringify(bad));
  assert.equal(U.canRevoke({ status: "active" }), true);
  assert.equal(U.canRevoke({ status: "expired" }), true, "an expired token can still be revoked/cleaned up");
  assert.equal(U.canRevoke({ status: "revoked" }), false);
  assert.equal(U.statusClass("active"), "ok");
  assert.equal(U.statusClass("revoked"), "bad");
  assert.equal(U.statusClass("expired"), "warn");
});

test("mcpState: enabled only when the server says exactly true; outcomeClass and formatMs are total functions", () => {
  assert.equal(U.mcpState({ mcp_enabled: true }), "enabled");
  for (const bad of [{ mcp_enabled: false }, { mcp_enabled: "true" }, { mcp_enabled: 1 }, {}, null, undefined]) assert.equal(U.mcpState(bad), "disabled", JSON.stringify(bad));
  assert.equal(U.outcomeClass("ok"), "ok");
  assert.equal(U.outcomeClass("denied"), "warn");
  assert.equal(U.outcomeClass("error"), "bad");
  assert.equal(U.outcomeClass("whatever"), "neutral");
  assert.equal(U.formatMs(0), "0 ms");
  assert.equal(U.formatMs(999), "999 ms");
  assert.equal(U.formatMs(1000), "1.0 s");
  assert.equal(U.formatMs(1250), "1.2 s");
  assert.equal(U.formatMs(15000), "15.0 s");
  for (const bad of [-1, 1.5, "12", null, undefined, NaN]) assert.equal(U.formatMs(bad), "—", String(bad));
});

// ---------------------------------------------------------------- connection snippets

test("serverUrl: an http(s) origin without credentials, path, query or trailing slash; anything else becomes the placeholder", () => {
  assert.equal(U.serverUrl("https://crm.example.com"), "https://crm.example.com");
  assert.equal(U.serverUrl("https://crm.example.com/"), "https://crm.example.com");
  assert.equal(U.serverUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(U.serverUrl("https://crm.example.com/vita/admin.html?x=1#y"), "https://crm.example.com");
  for (const bad of ["", null, undefined, "javascript:alert(1)", "ftp://x.test", "not a url", "https://user:pw@crm.example.com", 5, "https://", "data:text/html,x"]) assert.equal(U.serverUrl(bad), U.URL_PLACEHOLDER, String(bad));
  assert.match(U.URL_PLACEHOLDER, /^<[A-Z_]+>$/);
});

test("desktopSnippet: valid JSON for the Claude Desktop stdio config (node + scripts/mcp-stdio.js, VITA_BASE_URL, token placeholder only)", () => {
  const cfg = JSON.parse(U.desktopSnippet("https://crm.example.com"));
  assert.deepEqual(Object.keys(cfg), ["mcpServers"]);
  assert.deepEqual(Object.keys(cfg.mcpServers), ["vita"]);
  const s = cfg.mcpServers.vita;
  assert.equal(s.command, "node");
  assert.equal(s.args.length, 1);
  assert.match(s.args[0], /scripts[\\/]mcp-stdio\.js$/);
  assert.deepEqual(s.env, { VITA_BASE_URL: "https://crm.example.com", VITA_MCP_TOKEN: U.TOKEN_PLACEHOLDER });
  assert.equal(U.TOKEN_PLACEHOLDER, "<YOUR_TOKEN>");
  assert.doesNotMatch(U.desktopSnippet("https://crm.example.com"), /vita_pat_/);
  // the base URL is sanitised and the result is still valid JSON
  const odd = JSON.parse(U.desktopSnippet('https://crm.example.com/"},{"x":"'));
  assert.equal(odd.mcpServers.vita.env.VITA_BASE_URL, "https://crm.example.com");
  assert.equal(JSON.parse(U.desktopSnippet(undefined)).mcpServers.vita.env.VITA_BASE_URL, U.URL_PLACEHOLDER);
});

test("codeSnippet: the exact Claude Code HTTP command with the /mcp URL and the Authorization header placeholder", () => {
  assert.equal(U.codeSnippet("https://crm.example.com"), 'claude mcp add --transport http vita https://crm.example.com/mcp --header "Authorization: Bearer <YOUR_TOKEN>"');
  assert.equal(U.codeSnippet("https://crm.example.com/"), 'claude mcp add --transport http vita https://crm.example.com/mcp --header "Authorization: Bearer <YOUR_TOKEN>"');
  assert.equal(U.codeSnippet("nonsense"), `claude mcp add --transport http vita ${U.URL_PLACEHOLDER}/mcp --header "Authorization: Bearer <YOUR_TOKEN>"`);
  assert.doesNotMatch(U.codeSnippet("https://crm.example.com"), /vita_pat_/);
});

test("snippets include a real secret only when one is passed explicitly AND it has the exact token shape; a malformed 'secret' (or anything injected) falls back to the placeholder", () => {
  assert.equal(U.isSecret(SECRET), true);
  for (const bad of ["vita_pat_short", SECRET + "x", SECRET.replace("vita_pat_", "vita_pax_"), "", null, undefined, 5, SECRET + '" --evil', `"${SECRET}`]) assert.equal(U.isSecret(bad), false, String(bad));
  assert.match(U.codeSnippet("https://crm.example.com", { secret: SECRET }), new RegExp(SECRET));
  assert.equal(JSON.parse(U.desktopSnippet("https://crm.example.com", { secret: SECRET })).mcpServers.vita.env.VITA_MCP_TOKEN, SECRET);
  for (const bad of ["vita_pat_short", SECRET + '" --evil', "$(curl x)", "Bearer abc"]) {
    assert.doesNotMatch(U.codeSnippet("https://crm.example.com", { secret: bad }), /evil|curl|abc|vita_pat_short/);
    assert.equal(JSON.parse(U.desktopSnippet("https://crm.example.com", { secret: bad })).mcpServers.vita.env.VITA_MCP_TOKEN, U.TOKEN_PLACEHOLDER);
  }
  // without options nothing but the placeholder ever appears
  assert.doesNotMatch(U.codeSnippet("https://crm.example.com") + U.desktopSnippet("https://crm.example.com"), /vita_pat_/);
});

test("the helpers keep working when loaded without a window (node) and expose a frozen-looking, stable surface", () => {
  for (const name of ["canUse", "checkDays", "checkName", "maskPrefix", "tokenStatus", "canRevoke", "statusClass", "outcomeClass", "formatMs", "mcpState", "serverUrl", "desktopSnippet", "codeSnippet", "isSecret"]) assert.equal(typeof U[name], "function", name);
});
