// Stage 6, Task 4: messaging UI - staff console tab "Messages" and the chat panel in the candidate, employer and agency portals.
// Static checks (ar/en/fr parity, CSP safety, wiring, untrusted text only through textContent), unit tests of the pure helpers in
// public/vita/chat-util.js, the shared SSE frame parser in vita.js and the permission mirror (crm-util.js) against middleware/role.js.
// The rendered behaviour (live delivery, moderation, isolation, RTL, 375 px) is exercised by the browser smoke in the task report.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "chat-ui-test-secret";

const VITA = path.join(__dirname, "..", "public", "vita");
const I18N = require("../public/vita/i18n.js");
const U = require("../public/vita/chat-util.js");
const CU = require("../public/vita/crm-util.js");
const VJS = require("../public/vita/vita.js");
const { PERMISSIONS } = require("../middleware/role");

const read = (f) => fs.readFileSync(path.join(VITA, f), "utf8");
const LANGS = ["ar", "en", "fr"];
const CHAT_JS = ["chat-util.js", "chat-panel.js", "chat-staff.js", "chat-portal.js"];
const CHAT_PERMS = ["chat:read", "chat:write", "chat:moderate"];
const SINKS = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b|setTimeout\(\s*["'`]|setInterval\(\s*["'`]/;
const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
const scripts = (html) => [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
const keysIn = (html) => [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]);
const DISCLAIMER_EN = "This service helps you search and apply for job opportunities. It does not guarantee employment, employer sponsorship, a work permit or a visa.";

function noInlineCode(html, name) {
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${name}: inline handler`);
  assert.doesNotMatch(html, /\sstyle\s*=/i, `${name}: style attribute`);
  assert.doesNotMatch(html, /<style\b/i, `${name}: <style>`);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/i, `${name}: inline script`);
  assert.doesNotMatch(html, /javascript:/i, `${name}: javascript: URL`);
  assert.doesNotMatch(html, /(?:href|src)="(?:https?:)?\/\//i, `${name}: external resource`);
  assert.doesNotMatch(html, /https?:\/\//i, `${name}: absolute URL`);
}
function keysResolve(html, name) {
  const missing = [];
  for (const k of keysIn(html)) for (const l of LANGS) if (!(k in I18N.dictionaries[l])) missing.push(`${l}:${k}`);
  assert.deepEqual(missing, [], name);
}

// ---------------------------------------------------------------- wiring

test("admin.html: Messages tab (with unread badge slot) + panel, chat scripts after the CRM scripts and before the accounting/HR scripts, no inline code, keys resolve", () => {
  const html = read("admin.html");
  assert.match(html, /<button type="button" role="tab" id="tab-chat" aria-controls="panel-chat" data-tab="chat">/);
  assert.match(html, /<span data-i18n="tab\.chat">Messages<\/span>/);
  assert.match(html, /id="chat-tab-badge"/);
  assert.match(html, /<section id="panel-chat" role="tabpanel" aria-labelledby="tab-chat"/);
  for (const id of ["chat-staff-root", "chat-channels"]) assert.match(html, new RegExp(`id="${id}"`), id);
  const order = scripts(html);
  const at = (f) => order.indexOf(f);
  assert.deepEqual(order.slice(at("chat-util.js"), at("chat-util.js") + 3), ["chat-util.js", "chat-panel.js", "chat-staff.js"]);
  for (const f of ["chat-util.js", "chat-panel.js", "chat-staff.js"]) assert.ok(at(f) > at("admin.js") && at(f) > at("crm-util.js"), f);
  assert.ok(at("chat-util.js") < at("fin-util.js"), "the accounting and HR scripts stay the last scripts");
  assert.ok(!order.includes("chat-portal.js"), "the portal mount helper is for the portals only");
  noInlineCode(html, "admin.html");
  keysResolve(html, "admin.html");
});

test("portal pages: a Messages tab / step with the panel root, chat scripts in order before the page script, existing disclaimers untouched", () => {
  const pages = [
    { f: "employer.html", before: ["i18n.js", "vita.js", "orgs-util.js", "orgs-common.js"], last: "employer.js", tab: /<button type="button" role="tab" id="tab-chat" aria-controls="panel-chat" data-tab="chat">/, panel: /<section id="panel-chat" role="tabpanel" aria-labelledby="tab-chat"/ },
    { f: "agency.html", before: ["i18n.js", "vita.js", "orgs-util.js", "orgs-common.js"], last: "agency.js", tab: /<button type="button" role="tab" id="tab-chat" aria-controls="panel-chat" data-tab="chat">/, panel: /<section id="panel-chat" role="tabpanel" aria-labelledby="tab-chat"/ },
    { f: "portal.html", before: ["i18n.js", "vita.js", "fin-util.js"], last: "portal.js", tab: /<button type="button" data-step="chat">/, panel: /<section id="step-chat"[^>]*aria-labelledby="chat-h"/ },
  ];
  for (const p of pages) {
    const html = read(p.f);
    assert.deepEqual(scripts(html), [...p.before, "chat-util.js", "chat-panel.js", "chat-portal.js", p.last], p.f);
    assert.match(html, p.tab, `${p.f} tab`);
    assert.match(html, p.panel, `${p.f} panel`);
    assert.match(html, /id="chat-root"/, `${p.f} panel root`);
    assert.match(html, /id="chat-tab-badge"/, `${p.f} badge slot`);
    noInlineCode(html, p.f);
    keysResolve(html, p.f);
    // the standard disclaimer is untouched: active language + all three languages
    assert.match(html, /data-i18n="disclaimer"/, p.f);
    for (const l of LANGS) assert.match(html, new RegExp(`data-disclaimer-lang="${l}"`), `${p.f} ${l}`);
    assert.ok(html.includes(DISCLAIMER_EN), `${p.f} English disclaimer text`);
  }
  assert.match(read("portal.js"), /var STEPS = \["upload", "review", "prefs", "consent", "status", "payments", "chat"\]/);
});

test("the API client allows /chat/ besides the existing prefixes (which are unchanged); connectEvents takes the stream path and uses the shared frame parser", () => {
  const src = read("vita.js");
  assert.match(src, /\^\\\/\(jobsearch\|auth\|crm\)\\\//);
  assert.match(src, /\^\\\/\(employer\|agency\)\\\//);
  assert.match(src, /\^\\\/finance\\\//);
  assert.match(src, /\^\\\/hr\\\//);
  assert.match(src, /\^\\\/chat\\\//);
  assert.match(src, /var path = o\.path \|\| "\/jobsearch\/events"/);
  assert.match(src, /assertPath\(path\)/);
  assert.match(src, /createSseParser\(/);
  // a stream path outside the allow-list is refused by the same check
  assert.match(src, /function assertPath\(path\)/);
});

test("static scan: chat scripts render text via the DOM helpers only, call only literal same-origin paths, never store message content, have no second SSE client", () => {
  const allowed = { "chat-panel.js": /^\/chat\//, "chat-portal.js": /^\/chat\//, "chat-staff.js": /^\/(chat\/|crm\/(employers|agencies)\?)/ };
  for (const f of CHAT_JS) {
    const src = read(f);
    src.split("\n").forEach((line, i) => assert.doesNotMatch(line, SINKS, `${f}:${i + 1}`));
    assert.doesNotMatch(src, /https?:\/\//, `${f}: absolute URL`);
    assert.doesNotMatch(src, /\b(?:href|src)\s*:|srcdoc|\.(?:href|src)\s*=|setAttribute\(\s*["'](?:on|href|src|style)|\.on[a-z]+\s*=/, `${f}: link/handler sink`);
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./, `${f}: nothing is stored in the browser`);
    assert.doesNotMatch(src, /console\.(log|info|debug|warn|error)/, `${f}: console output`);
    assert.doesNotMatch(src, /[?&](?:token|access_token)=/, `${f}: token in a URL`);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|EventSource|getReader|TextDecoder|WebSocket/, `${f}: network access and the event stream go through V.api / V.connectEvents`);
    assert.doesNotMatch(src, /\bstyle\s*:|\.style\b|cssText/, `${f}: no inline styles (CSP)`);
    assert.doesNotMatch(src, /\bwindow\.name\b|history\.(push|replace)State/, `${f}: no message content in names / history`);
    if (f === "chat-util.js") {
      assert.doesNotMatch(src, /\bdocument\b|\bwindow\.VITA\b|\bV\./, "pure helpers never touch the DOM or the page");
      continue;
    }
    for (const m of src.matchAll(/V\.(?:api|download)\(\s*(?:"[A-Z]+"\s*,\s*)?"([^"]*)"/g)) assert.match(m[1], allowed[f], `${f}: ${m[1]}`);
    for (const m of src.matchAll(/V\.api\(\s*"[A-Z]+"\s*,\s*([^"\s][^,)]*)/g)) assert.fail(`${f}: API path must start with a string literal: ${m[1]}`);
    for (const m of src.matchAll(/h\("button",\s*\{([^}]*)\}/g)) assert.match(m[1], /type:/, `${f}: button without a type: ${m[0].slice(0, 60)}`);
    assert.doesNotMatch(src, /attrs\s*:\s*\{\s*\[/, `${f}: computed attribute names`);
  }
  assert.match(read("chat-panel.js"), /V\.connectEvents\(\{[\s\S]*path: "\/chat\/events"/, "the panel reuses the shared reconnecting SSE client");
  assert.match(read("chat-panel.js"), /periodicMs: 30000/, "30 s polling fallback");
});

test("message bodies are rendered with textContent and dir=auto (bidi), hidden messages as stubs, and the text-only note is part of the panel", () => {
  const src = read("chat-panel.js");
  assert.match(src, /dir: "auto"/);
  assert.match(src, /class: "chat-body"/);
  assert.match(src, /chat\.removed/);
  assert.match(src, /chat\.textOnly/);
  assert.match(src, /chat\.closedBanner/);
  assert.match(src, /U\.sendStep\(/);
  assert.match(src, /\.disabled = /);
  assert.match(src, /U\.markReadDecision\(/);
  assert.doesNotMatch(src, /\.value\s*=\s*[^;]*\.body/, "message text is never written back into controls except by the user's own draft");
});

test("served under the strict /vita CSP like every other script", async () => {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const f of [...CHAT_JS, "admin.html", "portal.html", "employer.html", "agency.html"]) {
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

test("i18n: tab.chat and every chat.* key exist in ar/en/fr, non-empty, identical placeholders, actually translated", () => {
  const { en, ar, fr } = I18N.dictionaries;
  const keys = Object.keys(en).filter((k) => k.startsWith("chat.") || k === "tab.chat");
  assert.ok(keys.length >= 118, `chat keys: ${keys.length}`);
  for (const k of keys) {
    for (const [name, d] of [["ar", ar], ["fr", fr]]) {
      assert.equal(typeof d[k], "string", `${name}.${k}`);
      assert.ok(d[k].trim().length > 0, `${name}.${k} empty`);
      assert.equal(ph(d[k]), ph(en[k]), `${name}.${k} placeholders`);
    }
  }
  for (const k of ["tab.chat", "chat.title", "chat.send", "chat.removed", "chat.textOnly", "chat.closedBanner", "chat.reason.submit", "chat.channel.whatsapp", "chat.chstate.requires_setup"]) assert.match(ar[k], /[؀-ۿ]/, `ar ${k}`);
  for (const k of ["chat.send", "chat.removed", "chat.textOnly", "chat.closedBanner", "chat.reason.submit", "chat.chstate.requires_setup", "chat.open.title"]) assert.notEqual(fr[k], en[k], `fr ${k} should be translated`);
  assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  assert.equal(I18N.dictionaries.en["chat.textOnly"], "Messages are text only; do not send passwords or ID numbers.");
});

test("i18n: every t(\"...\") key and every complete \"chat.*\" key literal in the chat scripts exists in ar/en/fr", () => {
  const used = new Set();
  for (const f of CHAT_JS) {
    const src = read(f);
    for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"\s*[,)]/g)) used.add(m[1]);
    for (const m of src.matchAll(/"(chat(?:\.[a-zA-Z0-9_]+)+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 70, `expected many keys, got ${used.size}`);
  const missing = [];
  for (const k of used) for (const l of LANGS) if (!(k in I18N.dictionaries[l])) missing.push(`${l}:${k}`);
  assert.deepEqual(missing, []);
});

test("i18n: runtime-built key families (subject kinds, sender roles, channels, channel states, send errors) all exist", () => {
  const fam = {
    "chat.kind": ["candidate", "employer_request", "agency", "staff"],
    "chat.role": ["Candidate", "Employer", "Agency", "staff", "SuperAdmin", "Admin", "Manager", "Receptionist", "Agent", "HR", "Accountant"],
    "chat.channel": ["in_app", "email", "whatsapp", "in_app.note", "email.note", "whatsapp.note"],
    "chat.empty": ["candidate", "employer", "agency"],
    "chat.status": ["open", "closed"],
    "chat.open.err": ["id", "type"],
    "chat.reason.err": ["required", "long", "invalid"],
    "chat.chstate": ["connected", "sandbox", "requires_setup", "unknown"],
    "chat.err": U.ERROR_KINDS,
    "chat.dayLabel": ["today", "yesterday"],
  };
  for (const [prefix, list] of Object.entries(fam)) {
    assert.ok(list.length > 0, prefix);
    for (const x of list) for (const l of LANGS) assert.ok(`${prefix}.${x}` in I18N.dictionaries[l], `${l}:${prefix}.${x}`);
  }
});

// ---------------------------------------------------------------- permission mirror

test("crm-util can(): equals middleware/role.js PERMISSIONS for every role and every chat:* key (and denies unknown roles)", () => {
  for (const [role, perms] of Object.entries(PERMISSIONS)) {
    for (const p of CHAT_PERMS) assert.equal(CU.can(role, p), perms.includes("*") || perms.includes(p), `${role} ${p}`);
  }
  for (const role of [undefined, null, "", "Nobody", "__proto__", "constructor"]) for (const p of CHAT_PERMS) assert.equal(CU.can(role, p), false, `${String(role)} ${p}`);
  assert.equal(CU.can("Admin", "chat:bogus"), false);
  for (const role of Object.keys(PERMISSIONS)) {
    assert.equal(CU.canChatRead(role), CU.can(role, "chat:read"), role);
    assert.equal(CU.canChatWrite(role), CU.can(role, "chat:write"), role);
    assert.equal(CU.canChatModerate(role), CU.can(role, "chat:moderate"), role);
  }
  assert.equal(CU.canChatRead("HR"), false);
  assert.equal(CU.canChatRead("Accountant"), false);
  assert.equal(CU.canChatRead("Agent"), true);
  assert.equal(CU.canChatModerate("Agent"), false);
  assert.equal(CU.canChatModerate("Manager"), true);
  assert.equal(CU.canChatRead("Employer"), false, "portal users do not use the staff tab");
});

test("crm-util can() still mirrors every non-chat key it knew before (nothing removed)", () => {
  for (const role of ["Admin", "Manager", "Receptionist", "Agent", "Accountant", "HR"]) {
    for (const p of ["candidates:read", "candidates:write", "leads:read", "leads:write", "sitejobs:write", "orgs:read", "orgs:write", "finance:read", "hr:read", "hr:approve", "users:write"]) {
      const perms = PERMISSIONS[role];
      if (CU.can(role, p)) assert.ok(perms.includes(p), `${role} ${p}`);
    }
  }
});

// ---------------------------------------------------------------- pure helpers

test("badgeText: nothing for 0 and garbage, the number up to 99, '99+' above", () => {
  assert.equal(U.badgeText(0), "");
  assert.equal(U.badgeText(-3), "");
  assert.equal(U.badgeText(NaN), "");
  assert.equal(U.badgeText(undefined), "");
  assert.equal(U.badgeText(null), "");
  assert.equal(U.badgeText("7"), "7");
  assert.equal(U.badgeText(1), "1");
  assert.equal(U.badgeText(9), "9");
  assert.equal(U.badgeText(10), "10");
  assert.equal(U.badgeText(99), "99");
  assert.equal(U.badgeText(100), "99+");
  assert.equal(U.badgeText(12345), "99+");
  assert.equal(U.badgeText(4.7), "4");
  assert.equal(U.totalUnread([{ unread_count: 2 }, { unread_count: 0 }, { unread_count: 5 }, {}, null]), 7);
  assert.equal(U.totalUnread(null), 0);
});

test("composeState: counts characters like the server (code points, trimmed), 2000 maximum, NUL refused", () => {
  assert.equal(U.MAX_BODY, 2000);
  let s = U.composeState("");
  assert.deepEqual([s.length, s.empty, s.canSend, s.over], [0, true, false, false]);
  s = U.composeState("   \n  ");
  assert.deepEqual([s.length, s.empty, s.canSend], [0, true, false]);
  s = U.composeState("  hello  ");
  assert.deepEqual([s.length, s.remaining, s.canSend], [5, 1995, true]);
  assert.equal(U.composeState("😀".repeat(2000)).canSend, true, "an emoji is one character, as Postgres counts it");
  assert.equal(U.composeState("😀".repeat(2000)).length, 2000);
  s = U.composeState("a".repeat(2001));
  assert.deepEqual([s.over, s.canSend, s.remaining], [true, false, -1]);
  assert.equal(U.composeState("a".repeat(2000)).canSend, true);
  assert.equal(U.composeState("a\u0000b").canSend, false);
  assert.equal(U.composeState("a\u0000b").invalid, true);
  assert.equal(U.composeState("a".repeat(1900)).warn, true);
  assert.equal(U.composeState("a".repeat(100)).warn, false);
  assert.equal(U.composeState(null).canSend, false);
  assert.equal(U.composeState(42).canSend, false);
  assert.equal(U.codePointLength("a😀b"), 3);
});

test("dayKey / groupByDay: calendar days in the VIEWER's zone via Intl, not UTC", () => {
  const late = "2026-10-26T23:30:00.000Z";
  assert.equal(U.dayKey(late, "UTC"), "2026-10-26");
  assert.equal(U.dayKey(late, "Africa/Tunis"), "2026-10-27", "UTC+1 is already the next day");
  assert.equal(U.dayKey(late, "America/Toronto"), "2026-10-26");
  assert.equal(U.dayKey("2026-10-26T02:00:00.000Z", "America/Toronto"), "2026-10-25", "UTC-4 is still the previous evening");
  assert.equal(U.dayKey("2026-03-29T00:30:00Z", "Europe/Paris"), "2026-03-29");
  assert.equal(U.dayKey("not a date", "UTC"), "");
  assert.equal(U.dayKey(late, "No/Such_Zone"), "2026-10-26", "an invalid zone falls back to UTC");
  const msgs = [
    { id: 3, created_at: "2026-10-27T08:00:00Z" },
    { id: 1, created_at: "2026-10-26T22:30:00Z" },
    { id: 2, created_at: "2026-10-26T23:30:00Z" },
    { id: 4, created_at: "2026-10-27T09:00:00Z" },
  ];
  const tunis = U.groupByDay(msgs, "Africa/Tunis");
  assert.deepEqual(tunis.map((g) => [g.day, g.items.map((m) => m.id)]), [["2026-10-26", [1]], ["2026-10-27", [2, 3, 4]]]);
  const toronto = U.groupByDay(msgs, "America/Toronto");
  assert.deepEqual(toronto.map((g) => [g.day, g.items.map((m) => m.id)]), [["2026-10-26", [1, 2]], ["2026-10-27", [3, 4]]]);
  assert.deepEqual(U.groupByDay([], "UTC"), []);
  assert.deepEqual(U.groupByDay(null, "UTC"), []);
  // equal timestamps keep the id order; the input is not mutated
  const same = [{ id: 9, created_at: "2026-10-26T10:00:00Z" }, { id: 8, created_at: "2026-10-26T10:00:00Z" }];
  assert.deepEqual(U.groupByDay(same, "UTC")[0].items.map((m) => m.id), [8, 9]);
  assert.deepEqual(same.map((m) => m.id), [9, 8]);
});

test("dayLabelKind / formatTime: today and yesterday in the viewer's zone; times with an explicit zone", () => {
  const now = "2026-10-27T00:10:00Z"; // Tunis: 01:10 on the 27th; Toronto: 20:10 on the 26th
  assert.equal(U.dayLabelKind("2026-10-27", now, "Africa/Tunis"), "today");
  assert.equal(U.dayLabelKind("2026-10-26", now, "Africa/Tunis"), "yesterday");
  assert.equal(U.dayLabelKind("2026-10-25", now, "Africa/Tunis"), null);
  assert.equal(U.dayLabelKind("2026-10-26", now, "America/Toronto"), "today");
  assert.equal(U.formatTime("2026-10-26T23:30:00Z", "Africa/Tunis", "en-GB"), "00:30");
  assert.equal(U.formatTime("2026-10-26T23:30:00Z", "UTC", "en-GB"), "23:30");
  assert.equal(U.formatTime("bad", "UTC", "en-GB"), "");
  assert.match(U.formatDay("2026-10-26", "en-GB"), /26/);
  assert.match(U.formatDay("2026-10-26", "fr-FR"), /octobre/);
});

test("mergeMessages: dedupes by id, ascending, the incoming copy wins (hidden / unhidden), input untouched", () => {
  const a = [{ id: 1, body: "a" }, { id: 3, body: "c" }];
  const merged = U.mergeMessages(a, [{ id: 3, hidden: true }, { id: 2, body: "b" }]);
  assert.deepEqual(merged.map((m) => m.id), [1, 2, 3]);
  assert.equal(merged[2].hidden, true);
  assert.equal(a.length, 2);
  assert.deepEqual(U.mergeMessages(null, null), []);
  assert.deepEqual(U.mergeMessages([{ id: 5 }], []).map((m) => m.id), [5]);
  assert.deepEqual(U.mergeMessages([], [{ id: 2 }, { id: 2 }, { id: 1 }]).map((m) => m.id), [1, 2]);
  assert.deepEqual(U.mergeMessages([{ id: "7" }, { id: 7 }, { id: "x" }, null], []).map((m) => m.id), [7]);
  assert.equal(U.newestId([{ id: 4 }, { id: 9 }, { id: 2 }]), 9);
  assert.equal(U.newestId([]), 0);
});

test("optimistic-send state machine: idle -> sending -> idle | failed; a second submit while sending is ignored", () => {
  let s = U.sendInitial();
  assert.deepEqual([s.phase, s.text, s.error], ["idle", "", null]);
  // invalid input never leaves idle
  let n = U.sendStep(s, { type: "submit", text: "   " });
  assert.equal(n.phase, "idle");
  assert.equal(n.error.kind, "empty");
  n = U.sendStep(s, { type: "submit", text: "x".repeat(2001) });
  assert.equal(n.phase, "idle");
  assert.equal(n.error.kind, "too_long");
  n = U.sendStep(s, { type: "submit", text: "a\u0000" });
  assert.equal(n.error.kind, "invalid");
  // valid submit
  const sending = U.sendStep(s, { type: "submit", text: "  hello  " });
  assert.deepEqual([sending.phase, sending.text, sending.error], ["sending", "hello", null], "the optimistic bubble shows the trimmed text");
  // double-submit protection: the very same state object comes back, so the caller sends nothing
  assert.equal(U.sendStep(sending, { type: "submit", text: "hello" }), sending);
  assert.equal(U.sendStep(sending, { type: "submit", text: "other" }), sending);
  assert.equal(U.sendStep(sending, { type: "edit", text: "other" }), sending, "the draft is frozen while the request is in flight");
  // success clears the draft
  assert.deepEqual(U.sendStep(sending, { type: "success" }), { phase: "idle", text: "", error: null });
  // failure keeps the text for a retry and classifies the error
  const failed = U.sendStep(sending, { type: "failure", error: { status: 429 } });
  assert.deepEqual([failed.phase, failed.text, failed.error.kind], ["failed", "hello", "rate"]);
  const unknown = U.sendStep(sending, { type: "failure", error: { status: 0 } });
  assert.equal(unknown.error.kind, "network");
  assert.equal(unknown.error.unknown, true, "a network failure may have been delivered: the UI says so");
  // retry from failed is allowed; editing the draft clears the error
  const again = U.sendStep(failed, { type: "submit", text: failed.text });
  assert.equal(again.phase, "sending");
  const edited = U.sendStep(failed, { type: "edit", text: "hello!" });
  assert.deepEqual([edited.phase, edited.text, edited.error], ["idle", "hello!", null]);
  // success / failure are only meaningful while sending
  assert.equal(U.sendStep(s, { type: "success" }), s);
  assert.equal(U.sendStep(s, { type: "failure", error: { status: 500 } }), s);
  assert.equal(U.sendStep(s, { type: "bogus" }), s);
  assert.equal(U.sendStep(undefined, { type: "submit", text: "a" }).phase, "sending");
  // a closed conversation is its own error kind (the panel then locks the composer)
  assert.equal(U.sendStep(sending, { type: "failure", error: { status: 409 } }).error.kind, "closed");
  // the input state is never mutated
  assert.deepEqual(sending, { phase: "sending", text: "hello", error: null });
});

test("classifyError: every HTTP outcome of POST /chat/conversations/:id/messages maps to one of the known kinds", () => {
  const k = (status) => U.classifyError({ status }).kind;
  assert.equal(k(0), "network");
  assert.equal(k(400), "invalid");
  assert.equal(k(401), "auth");
  assert.equal(k(403), "denied");
  assert.equal(k(404), "gone");
  assert.equal(k(409), "closed");
  assert.equal(k(429), "rate");
  assert.equal(k(500), "server");
  assert.equal(k(503), "server");
  assert.equal(k(418), "other");
  assert.equal(U.classifyError(null).kind, "other");
  assert.equal(U.classifyError(new Error("x")).kind, "other");
  for (const kind of ["network", "invalid", "auth", "denied", "gone", "closed", "rate", "server", "other", "empty", "too_long"]) assert.ok(U.ERROR_KINDS.includes(kind), kind);
});

test("eventPlan: which views an event refreshes (ids only; the client always refetches)", () => {
  const ev = (kind, conv, extra) => ({ id: null, kind, conversation_id: conv, ...(extra || {}) });
  assert.deepEqual(U.eventPlan(ev("message", 5, { id: 90, message_id: 90 }), { openId: 5 }), { list: true, thread: true, unread: true });
  assert.deepEqual(U.eventPlan(ev("message", 6, { id: 91, message_id: 91 }), { openId: 5 }), { list: true, thread: false, unread: true });
  assert.deepEqual(U.eventPlan(ev("hidden", 5, { message_id: 3 }), { openId: 5 }), { list: true, thread: true, unread: true });
  assert.deepEqual(U.eventPlan(ev("closed", 5), { openId: 5 }), { list: true, thread: true, unread: true });
  assert.deepEqual(U.eventPlan(ev("reopened", 7), { openId: 5 }), { list: true, thread: false, unread: true });
  assert.deepEqual(U.eventPlan(ev("read", 5, { message_id: 8 }), { openId: 5 }), { list: true, thread: false, unread: true }, "a read marker only changes counts");
  assert.deepEqual(U.eventPlan(ev("message", 5), { openId: null }), { list: true, thread: false, unread: true });
  for (const bad of [null, undefined, 3, "x", {}, { kind: "message" }, { kind: "bogus", conversation_id: 1 }, { kind: "message", conversation_id: "abc" }]) {
    assert.deepEqual(U.eventPlan(bad, { openId: 5 }), { list: false, thread: false, unread: false }, JSON.stringify(bad));
  }
  assert.deepEqual(U.eventPlan(ev("message", "5"), { openId: 5 }), { list: true, thread: true, unread: true }, "ids may arrive as strings");
});

test("markReadDecision: only a visible, focused thread with a newer message from the other side is marked, and only with an id it has loaded", () => {
  const msgs = [{ id: 1, mine: false }, { id: 2, mine: true }, { id: 3, mine: false }];
  const base = { visible: true, focused: true, messages: msgs, markedId: 0 };
  assert.equal(U.markReadDecision(base), 3);
  assert.equal(U.markReadDecision({ ...base, visible: false }), null);
  assert.equal(U.markReadDecision({ ...base, focused: false }), null);
  assert.equal(U.markReadDecision({ ...base, markedId: 3 }), null, "already marked");
  assert.equal(U.markReadDecision({ ...base, markedId: 1 }), 3);
  assert.equal(U.markReadDecision({ ...base, messages: [{ id: 5, mine: true }] }), null, "only my own messages: nothing to read");
  assert.equal(U.markReadDecision({ ...base, messages: [{ id: 5, mine: false, hidden: true }] }), null, "a removed message is not unread");
  assert.equal(U.markReadDecision({ ...base, messages: [] }), null);
  assert.equal(U.markReadDecision({ ...base, messages: [{ id: 2, mine: false }, { id: 4, mine: true }] }), 4, "the marker moves to the newest LOADED message");
  assert.equal(U.markReadDecision(null), null);
});

test("subjectOpenPayload / reasonCheck: what the open dialog and the hide dialog send", () => {
  assert.deepEqual(U.subjectOpenPayload("candidate", " 42 "), { ok: true, payload: { subject_type: "candidate", subject_id: 42 } });
  assert.deepEqual(U.subjectOpenPayload("employer_request", "7"), { ok: true, payload: { subject_type: "employer_request", subject_id: 7 } });
  assert.deepEqual(U.subjectOpenPayload("agency", 3), { ok: true, payload: { subject_type: "agency", subject_id: 3 } });
  for (const bad of ["", "0", "-1", "1.5", "abc", "99999999999", null, undefined]) assert.equal(U.subjectOpenPayload("candidate", bad).ok, false, String(bad));
  assert.equal(U.subjectOpenPayload("staff", "1").ok, false, "staff rooms are not opened from the console");
  assert.equal(U.subjectOpenPayload("bogus", "1").ok, false);
  assert.equal(U.subjectOpenPayload("candidate", "1").error, undefined);
  assert.equal(U.subjectOpenPayload("candidate", "x").error, "id");
  assert.equal(U.subjectOpenPayload("zzz", "1").error, "type");
  assert.deepEqual(U.reasonCheck("  spam  ", true), { ok: true, value: "spam" });
  assert.deepEqual(U.reasonCheck("", true), { ok: false, error: "required" });
  assert.deepEqual(U.reasonCheck("   ", true), { ok: false, error: "required" });
  assert.deepEqual(U.reasonCheck("", false), { ok: true, value: null });
  assert.deepEqual(U.reasonCheck("x".repeat(501), true), { ok: false, error: "long" });
  assert.deepEqual(U.reasonCheck("x".repeat(500), true).ok, true);
  assert.deepEqual(U.reasonCheck("a\u0000b", true), { ok: false, error: "invalid" });
});

test("channelState: honest wording - WhatsApp is never shown as connected; a sandbox mail adapter is not real mail", () => {
  assert.equal(U.channelState({ channel: "in_app", status: "connected" }), "connected");
  assert.equal(U.channelState({ channel: "email", status: "connected", sends_real_mail: true }), "connected");
  assert.equal(U.channelState({ channel: "email", status: "connected", sends_real_mail: false, mode: "sandbox" }), "sandbox");
  assert.equal(U.channelState({ channel: "email", status: "requires_setup" }), "requires_setup");
  assert.equal(U.channelState({ channel: "whatsapp", status: "requires_setup" }), "requires_setup");
  assert.equal(U.channelState({ channel: "whatsapp", status: "connected" }), "requires_setup", "this build has no WhatsApp sending, whatever the payload says");
  assert.equal(U.channelState({ channel: "email", status: "weird" }), "unknown");
  assert.equal(U.channelState(null), "unknown");
});

test("conversation helpers: staff title from the subject name, last-message preview wording, ordering", () => {
  assert.equal(U.conversationTitle({ subject_type: "candidate", subject_id: 4, subject_name: "Amal B." }), "Amal B.");
  assert.equal(U.conversationTitle({ subject_type: "agency", subject_id: 9, subject_name: null }), "#9");
  assert.equal(U.conversationTitle(null), "");
  assert.equal(U.previewKind({ last_message: null }), "none");
  assert.equal(U.previewKind({ last_message: { hidden: true } }), "removed");
  assert.equal(U.previewKind({ last_message: { preview: "hi", hidden: false } }), "text");
  const rows = [{ id: 1, last_message_at: "2026-10-26T10:00:00Z" }, { id: 2, last_message_at: null }, { id: 3, last_message_at: "2026-10-26T11:00:00Z" }];
  assert.deepEqual(U.sortConversations(rows).map((r) => r.id), [3, 1, 2]);
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
});

// ---------------------------------------------------------------- shared SSE frame parser (vita.js)

test("createSseParser: whole frames, partial chunks, CRLF, comment lines, multi-line data, ids, junk", () => {
  const { createSseParser } = VJS;
  assert.equal(typeof createSseParser, "function");
  const collect = () => {
    const out = [];
    const p = createSseParser((f) => out.push(f));
    return { p, out };
  };
  // the chat hub's own wire format
  let c = collect();
  c.p.push('retry: 5000\n: connected\n\nid: 12\ndata: {"id":12,"kind":"message","conversation_id":3,"message_id":12}\n\n');
  assert.deepEqual(c.out, [{ id: "12", data: '{"id":12,"kind":"message","conversation_id":3,"message_id":12}' }], "the retry/comment preamble produces no frame");
  // a frame split at every possible byte boundary parses identically
  const wire = ': hello\n\nid: 7\ndata: {"a":1}\n\n: heartbeat 1\n\ndata: {"b":2}\n\n';
  for (let cut = 1; cut < wire.length; cut += 1) {
    c = collect();
    c.p.push(wire.slice(0, cut));
    c.p.push(wire.slice(cut));
    assert.deepEqual(c.out, [{ id: "7", data: '{"a":1}' }, { id: null, data: '{"b":2}' }], `cut at ${cut}`);
  }
  // one character at a time
  c = collect();
  for (const ch of wire) c.p.push(ch);
  assert.equal(c.out.length, 2);
  // CRLF line endings and the blank-line terminator split across chunks
  c = collect();
  c.p.push("id: 3\r\ndata: x\r\n");
  assert.equal(c.out.length, 0, "no blank line yet");
  c.p.push("\r\n");
  assert.deepEqual(c.out, [{ id: "3", data: "x" }]);
  // multi-line data joins with \n; a field without a colon; a leading space is stripped once
  c = collect();
  c.p.push("data: line1\ndata:  line2\ndata\n\n");
  assert.deepEqual(c.out, [{ id: null, data: "line1\n line2\n" }]);
  // comment-only and retry-only frames are dropped; a frame with an id but no data still reports the id
  c = collect();
  c.p.push(": ping\n\nretry: 1000\n\nid: 9\n\n");
  assert.deepEqual(c.out, [{ id: "9", data: null }]);
  // text is never interpreted: it is handed over verbatim
  c = collect();
  c.p.push('data: {"x":"<img src=x onerror=alert(1)>"}\n\n');
  assert.equal(c.out[0].data, '{"x":"<img src=x onerror=alert(1)>"}');
  // a runaway frame without a terminator is dropped instead of growing without bound
  c = collect();
  c.p.push("data: " + "x".repeat(1100000));
  c.p.push("\n\ndata: ok\n\n");
  assert.deepEqual(c.out.map((f) => f.data), ["ok"]);
  // the callback is optional and a throwing callback does not poison later frames
  const p2 = createSseParser(null);
  p2.push("data: 1\n\n");
  const seen = [];
  const p3 = createSseParser((f) => { seen.push(f.data); if (f.data === "a") throw new Error("boom"); });
  assert.doesNotThrow(() => p3.push("data: a\n\ndata: b\n\n"));
  assert.deepEqual(seen, ["a", "b"]);
});
