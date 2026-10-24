// Task 7: staff console tabs for CRM leads, site jobs and candidate stage/timeline.
// Static checks (i18n parity, CSP-safety, wiring) + unit tests of the pure helpers in public/vita/crm-util.js.
// The rendered behaviour is exercised by the browser smoke documented in the task report.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "crm-ui-test-secret";

const VITA = path.join(__dirname, "..", "public", "vita");
const I18N = require("../public/vita/i18n.js");
const U = require("../public/vita/crm-util.js");
const { PERMISSIONS } = require("../middleware/role");
const leadsAdmin = require("../modules/crm/leadsAdmin");
const convert = require("../modules/crm/convert");
const siteJobsAdmin = require("../modules/crm/siteJobsAdmin");

const read = (f) => fs.readFileSync(path.join(VITA, f), "utf8");
const NEW_JS = ["crm-util.js", "crm-candidate.js", "crm-leads.js", "crm-sitejobs.js"];
const LANGS = ["ar", "en", "fr"];

// ---------------------------------------------------------------- wiring

test("admin.html: Leads and Site jobs tabs + panels, CRM scripts loaded after admin.js, no inline code", () => {
  const html = read("admin.html");
  for (const [tab, key] of [["leads", "tab.leads"], ["sitejobs", "tab.siteJobs"]]) {
    assert.match(html, new RegExp(`<button type="button" role="tab" id="tab-${tab}" aria-controls="panel-${tab}" data-tab="${tab}" data-i18n="${key.replace(".", "\\.")}">`), `tab ${tab}`);
    assert.match(html, new RegExp(`<section id="panel-${tab}" role="tabpanel" aria-labelledby="tab-${tab}"`), `panel ${tab}`);
  }
  const order = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(order, ["i18n.js", "vita.js", "admin.js", ...NEW_JS, "orgs-util.js", "orgs-common.js", "crm-orgs.js", "crm-requests.js", "fin-util.js", "fin-invoices.js", "fin-services.js", "fin-expenses.js", "fin-reports.js", "hr-util.js", "hr-my.js", "hr-team.js", "hr-admin.js"], "scripts: external, deferred, ordered (the organisation tabs, the accounting tab and then the HR tab load last; see tests/orgs-ui.test.js, tests/fin-ui.test.js, tests/hr-ui.test.js)");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/i);
  // every data-i18n key resolves in all three languages
  const missing = [];
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) for (const l of LANGS) if (!(m[1] in I18N.dictionaries[l])) missing.push(`${l}:${m[1]}`);
  assert.deepEqual(missing, []);
});

test("every CRM script exists and is served under the /vita CSP; the API client allows /crm paths", () => {
  for (const f of NEW_JS) assert.ok(fs.existsSync(path.join(VITA, f)), f);
  assert.match(read("vita.js"), /\^\\\/\(jobsearch\|auth\|crm\)\\\//);
});

test("static scan: CRM scripts render untrusted text only via textContent helpers and call only same-origin /crm paths", () => {
  const SINKS = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b|setTimeout\(\s*["'`]|setInterval\(\s*["'`]/;
  for (const f of NEW_JS) {
    const src = read(f);
    src.split("\n").forEach((line, i) => assert.doesNotMatch(line, SINKS, `${f}:${i + 1}`));
    assert.doesNotMatch(src, /https?:\/\//, `${f}: absolute URL`);
    assert.doesNotMatch(src, /\b(?:href|src)\s*:|srcdoc|\.(?:href|src)\s*=|setAttribute\(\s*["'](?:on|href|src|style)|\.on[a-z]+\s*=/, `${f}: link/handler sink`);
    assert.doesNotMatch(src, /localStorage|sessionStorage/, `${f}: storage access belongs in vita.js`);
    for (const m of src.matchAll(/V\.api\(\s*"[A-Z]+"\s*,\s*"([^"]*)"/g)) assert.match(m[1], /^\/(crm)\//, `${f}: ${m[1]}`);
    for (const m of src.matchAll(/V\.api\(\s*"[A-Z]+"\s*,\s*([^"\s][^,)]*)/g)) assert.fail(`${f}: API path must start with a literal "/crm/...": ${m[1]}`);
  }
  // data comes in through the shared DOM helper that refuses on*/style attributes
  assert.match(read("vita.js"), /function h\(tag, props\)/);
});

test("every t(\"...\") key used by the CRM scripts exists in ar/en/fr", () => {
  const used = new Set();
  for (const f of NEW_JS) for (const m of read(f).matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"\s*[,)]/g)) used.add(m[1]);
  assert.ok(used.size > 40, `expected many keys, got ${used.size}`);
  const missing = [];
  for (const k of used) for (const l of LANGS) if (!(k in I18N.dictionaries[l])) missing.push(`${l}:${k}`);
  assert.deepEqual(missing, []);
});

// ---------------------------------------------------------------- i18n

test("i18n: crm.* keys exist in ar/en/fr with identical placeholders, non-empty, and are translated (not copies of en)", () => {
  const { en, ar, fr } = I18N.dictionaries;
  const keys = Object.keys(en).filter((k) => k.startsWith("crm."));
  assert.ok(keys.length > 120, `crm keys: ${keys.length}`);
  assert.ok("tab.leads" in en && "tab.siteJobs" in en);
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
  for (const k of [...keys, "tab.leads", "tab.siteJobs"]) {
    for (const [name, d] of [["ar", ar], ["fr", fr]]) {
      assert.equal(typeof d[k], "string", `${name}.${k}`);
      assert.ok(d[k].trim().length > 0, `${name}.${k} empty`);
      assert.equal(ph(d[k]), ph(en[k]), `${name}.${k} placeholders`);
    }
  }
  // Arabic must actually be Arabic script for prose labels
  for (const k of ["crm.leads.title", "crm.convert.submit", "crm.sj.publish", "tab.leads", "tab.siteJobs"]) assert.match(ar[k], /[؀-ۿ]/, k);
  for (const k of ["crm.leads.title", "crm.convert.submit", "crm.sj.publish"]) assert.notEqual(fr[k], en[k], k);
});

test("i18n: runtime-built key families match the server enums", () => {
  const en = I18N.dictionaries.en;
  const fam = {
    "crm.status": leadsAdmin.STATUSES,
    "crm.kind": ["candidate", "employer", "contact"],
    "crm.stage": convert.STAGES,
    "crm.sjs": siteJobsAdmin.STATUSES,
    "crm.sj.apply": [...siteJobsAdmin.APPLY_MODES, "external"],
    "crm.ev": ["note", "status_changed", "assigned", "converted", "created_from_lead", "stage_changed", "created", "updated", "published", "closed"],
    "crm.f": ["kind", "status", "name", "email", "phone", "country", "profession", "company", "message", "lang", "consent", "source", "assigned", "candidate", "created", "updated"],
    "crm.sj.f": ["title", "employer_name", "country", "city", "category", "description", "requirements", "language_requirements", "employment_type", "salary_text", "apply_mode", "apply_url", "closes_at", "evidence_note"],
  };
  const missing = [];
  for (const [p, codes] of Object.entries(fam)) for (const c of codes) for (const l of LANGS) if (!(`${p}.${c}` in I18N.dictionaries[l])) missing.push(`${l}:${p}.${c}`);
  assert.deepEqual(missing, []);
  assert.deepEqual(U.LEAD_STATUSES, leadsAdmin.STATUSES);
  assert.deepEqual(U.LEAD_SETTABLE, leadsAdmin.SETTABLE_STATUSES);
  assert.deepEqual(U.STAGES, convert.STAGES);
  assert.equal(U.STAGES.length, 7);
  assert.deepEqual(U.SITE_STATUSES, siteJobsAdmin.STATUSES);
  assert.deepEqual(U.APPLY_MODES, siteJobsAdmin.APPLY_MODES);
  assert.equal(en["crm.sj.f.evidence_note"].length > 0, true);
});

test("every complete \"crm.*\" key literal in the CRM scripts (including keys passed as arguments) exists in ar/en/fr", () => {
  const missing = [];
  let n = 0;
  for (const f of NEW_JS) {
    for (const m of read(f).matchAll(/"(crm\.[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)"/g)) {
      n += 1;
      for (const l of LANGS) if (!(m[1] in I18N.dictionaries[l])) missing.push(`${l}:${m[1]} (${f})`);
    }
  }
  assert.ok(n > 40);
  assert.deepEqual(missing, []);
});

// ---------------------------------------------------------------- permissions (mirror of middleware/role.js)

test("U.can mirrors the server permission table for every staff role", () => {
  for (const role of ["SuperAdmin", "Admin", "Manager", "Receptionist", "Agent"]) {
    for (const perm of ["leads:read", "leads:write", "sitejobs:write", "users:write", "candidates:read", "candidates:write"]) {
      const perms = PERMISSIONS[role];
      assert.equal(U.can(role, perm), perms.includes("*") || perms.includes(perm), `${role} ${perm}`);
    }
  }
  assert.equal(U.can("Candidate", "leads:read"), false);
  assert.equal(U.can(undefined, "leads:read"), false);
  assert.equal(U.can("Admin", "bogus"), false);
  // derived UI capabilities
  assert.equal(U.canConvert("Manager"), true);
  assert.equal(U.canConvert("Agent"), false, "Agent lacks leads:write");
  assert.equal(U.canAssign("Admin"), true);
  assert.equal(U.canAssign("Manager"), false, "assign needs users:write");
  assert.equal(U.canSiteJobs("Agent"), false);
  assert.equal(U.canSiteJobs("Receptionist"), true);
});

// ---------------------------------------------------------------- pure helpers

test("apply_mode: keyword or https URL, round trip, rejects bad links", () => {
  assert.deepEqual(U.parseApplyMode("contact_staff"), { mode: "contact_staff", url: "" });
  assert.deepEqual(U.parseApplyMode("register"), { mode: "register", url: "" });
  assert.deepEqual(U.parseApplyMode("https://employer.example/apply"), { mode: "external", url: "https://employer.example/apply" });
  assert.deepEqual(U.parseApplyMode(null), { mode: "contact_staff", url: "" });
  assert.deepEqual(U.buildApplyMode({ mode: "register", url: "ignored" }), { ok: true, value: "register" });
  assert.deepEqual(U.buildApplyMode({ mode: "external", url: " https://e.example/a?b=1 " }), { ok: true, value: "https://e.example/a?b=1" });
  for (const bad of ["", "javascript:alert(1)", "ftp://x.example/a", "http://", "https://u:p@x.example/", "https://x.example/a b", "//x.example", "x".repeat(200)]) {
    assert.equal(U.buildApplyMode({ mode: "external", url: bad }).ok, false, bad);
  }
  assert.equal(U.buildApplyMode({ mode: "external", url: "http://plain.example/x" }).ok, false, "the console only offers https links (the API also accepts http)");
  assert.equal(U.buildApplyMode({ mode: "bogus", url: "" }).ok, false);
});

test("siteJobPayload: trims, empty -> null, closes_at -> ISO, apply_mode built; unchanged fields are omitted when diffing", () => {
  const form = {
    title: "  Welder  ", employer_name: "", country: "Canada", city: " ", category: "Welding", description: "Desc", requirements: "",
    language_requirements: "", employment_type: "full_time", salary_text: "", apply_mode: "external", apply_url: "https://e.example/a",
    closes_at: "2031-05-06T07:08", evidence_note: " Seen on employer site ",
  };
  const p = U.siteJobPayload(form);
  assert.equal(p.ok, true);
  assert.equal(p.payload.title, "Welder");
  assert.equal(p.payload.employer_name, null);
  assert.equal(p.payload.city, null);
  assert.equal(p.payload.apply_mode, "https://e.example/a");
  assert.equal(p.payload.evidence_note, "Seen on employer site");
  assert.equal(p.payload.closes_at, new Date("2031-05-06T07:08").toISOString());
  assert.deepEqual(Object.keys(p.payload).sort(), ["apply_mode", "category", "city", "closes_at", "country", "description", "employer_name", "employment_type", "evidence_note", "language_requirements", "requirements", "salary_text", "title"]);
  assert.equal(U.siteJobPayload({ ...form, closes_at: "" }).payload.closes_at, null);
  assert.deepEqual(U.siteJobPayload({ ...form, title: "  " }), { ok: false, error: "title" });
  assert.deepEqual(U.siteJobPayload({ ...form, apply_url: "javascript:1" }), { ok: false, error: "apply_url" });
  assert.deepEqual(U.siteJobPayload({ ...form, closes_at: "not a date" }), { ok: false, error: "closes_at" });
  // a long title is rejected client side with the server's limit
  assert.deepEqual(U.siteJobPayload({ ...form, title: "x".repeat(161) }), { ok: false, error: "title_long" });
  // evidence_note allows 1000 characters (other short fields stay at 160)
  assert.equal(U.siteJobPayload({ ...form, evidence_note: "e".repeat(1000) }).ok, true);
  assert.deepEqual(U.siteJobPayload({ ...form, evidence_note: "e".repeat(1001) }), { ok: false, error: "evidence_note_long" });
  assert.deepEqual(U.siteJobPayload({ ...form, city: "c".repeat(161) }), { ok: false, error: "city_long" });
  // datetime-local round trip
  assert.equal(U.toLocalInput(new Date("2031-05-06T07:08").toISOString()), "2031-05-06T07:08");
  assert.equal(U.toLocalInput(null), "");
  assert.equal(U.toLocalInput("garbage"), "");
  // diff for PATCH: only changed values
  const base = { title: "Welder", city: null, country: "Canada", closes_at: "2031-05-06T05:08:00.000Z" };
  assert.deepEqual(U.diffPayload(base, { title: "Welder", city: "Rome", country: "Canada", closes_at: "2031-05-06T05:08:00.000Z" }), { city: "Rome" });
  assert.deepEqual(U.diffPayload(base, { title: "Welder", city: null, country: "Canada", closes_at: "2031-05-06T05:08:00Z" }), {}, "same instant is not a change");
  assert.deepEqual(U.diffPayload(base, { closes_at: null }), { closes_at: null });
});

test("publishBlockers mirrors the server rules (title, country, description, evidence_note; future closes_at)", () => {
  const ok = { title: "T", country: "C", description: "D", evidence_note: "E", closes_at: new Date(Date.now() + 86400000).toISOString() };
  assert.deepEqual(U.publishBlockers(ok), { missing: [], closesPast: false });
  assert.deepEqual(U.publishBlockers({ ...ok, evidence_note: "  ", country: null }).missing, ["country", "evidence_note"]);
  assert.deepEqual(U.publishBlockers({ ...ok, closes_at: new Date(Date.now() - 1000).toISOString() }), { missing: [], closesPast: true });
  assert.deepEqual(U.publishBlockers({ ...ok, closes_at: null }), { missing: [], closesPast: false });
});

test("leadQuery builds an encoded query string; blanks omitted; page -> offset", () => {
  assert.equal(U.leadQuery({}, 1, 25), "?limit=25&offset=0");
  assert.equal(U.leadQuery({ status: "new", kind: "", q: " ali & bob " }, 3, 25), "?status=new&q=ali%20%26%20bob&limit=25&offset=50");
  assert.equal(U.leadQuery({ q: "x".repeat(300) }, 1, 25).includes("q=" + "x".repeat(100) + "&"), true, "q is capped at the server limit of 100");
  assert.equal(U.leadQuery({}, 0, 25), "?limit=25&offset=0", "page is clamped");
});

test("convertPayload: passport required, portal login only when the lead has an e-mail, optional fields dropped when blank", () => {
  const lead = { id: 5, name: "Amira", email: "amira@x.test" };
  assert.deepEqual(U.convertPayload({ passport_number: " ", full_name: "", nationality: "", portal: true }, lead), { ok: false, error: "passport" });
  assert.deepEqual(U.convertPayload({ passport_number: " P123 ", full_name: " ", nationality: "", portal: false }, lead), { ok: true, payload: { passport_number: "P123", createPortalLogin: false } });
  assert.deepEqual(
    U.convertPayload({ passport_number: "P1", full_name: "Amira B", nationality: "Tunisian", portal: true }, lead),
    { ok: true, payload: { passport_number: "P1", full_name: "Amira B", nationality: "Tunisian", createPortalLogin: true } }
  );
  assert.deepEqual(U.convertPayload({ passport_number: "P1", portal: true }, { id: 6, email: null }), { ok: true, payload: { passport_number: "P1", createPortalLogin: false } }, "no e-mail => no portal login");
  assert.deepEqual(U.convertPayload({ passport_number: "P".repeat(65), portal: false }, lead), { ok: false, error: "passport_long" });
  assert.equal(U.leadCanConvert({ kind: "candidate", status: "qualified" }), true);
  assert.equal(U.leadCanConvert({ kind: "candidate", status: "converted" }), false);
  assert.equal(U.leadCanConvert({ kind: "candidate", status: "spam" }), false);
  assert.equal(U.leadCanConvert({ kind: "employer", status: "new" }), false);
});

test("currentStage reads the latest stage_changed event, else the fallback, else 'lead'", () => {
  const rows = [
    { event: "created_from_lead", detail: { lead_id: 1 } },
    { event: "stage_changed", detail: { from: "lead", to: "documents" } },
    { event: "note", detail: { text: "x" } },
    { event: "stage_changed", detail: { from: "documents", to: "visa" } },
  ];
  assert.equal(U.currentStage(rows, "lead"), "visa");
  assert.equal(U.currentStage([], "interview"), "interview");
  assert.equal(U.currentStage([], undefined), "lead");
  assert.equal(U.currentStage([{ event: "stage_changed", detail: { to: "bogus" } }], "travel"), "travel", "unknown stages are ignored");
  assert.equal(U.currentStage(null, null), "lead");
});

test("describeEvent turns timeline rows into plain text (never HTML) with the translator it is given", () => {
  const t = (k, v) => (v ? `${k}|${Object.keys(v).sort().map((x) => `${x}=${v[x]}`).join(",")}` : k);
  const d = (event, detail) => U.describeEvent({ event, detail }, t);
  assert.equal(d("note", { text: "<b>hi</b>\nthere" }), "<b>hi</b>\nthere", "returned as data; the UI sets textContent");
  assert.equal(d("status_changed", { from: "new", to: "contacted" }), "crm.ev.statusChange|from=crm.status.new,to=crm.status.contacted");
  assert.equal(d("assigned", { from: null, to: 7 }), "crm.ev.assignChange|from=crm.detail.unassigned,to=#7");
  assert.equal(d("stage_changed", { from: "lead", to: "visa" }), "crm.ev.statusChange|from=crm.stage.lead,to=crm.stage.visa");
  assert.equal(d("converted", { candidate_id: 9, portal_login: true }), "crm.ev.convertedPortal|id=9");
  assert.equal(d("converted", { candidate_id: 9, portal_login: false }), "crm.ev.convertedPlain|id=9");
  assert.equal(d("created_from_lead", { lead_id: 4 }), "crm.ev.fromLead|id=4");
  assert.equal(d("updated", { fields: ["title", "city"], status: "draft" }), "title, city");
  assert.equal(d("published", { evidence_note: "seen on site" }), "seen on site");
  assert.equal(d("closed", null), "");
  assert.equal(d("something_new", { a: 1 }), "", "unknown events show only their label");
  assert.equal(U.eventLabelKey("note"), "crm.ev.note");
  assert.equal(U.eventLabelKey("weird_event"), null);
});

// ---------------------------------------------------------------- server addition: staff list for the assign select

test("GET /crm/staff lists assignable active staff for users:write only (no e-mails, no candidates)", async () => {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const mk = async (name, role, active = true) =>
      (await pool.query("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x',$3,$4) RETURNING id", [name, `${name.replace(/\s/g, "")}@ui.test.invalid`, role, active])).rows[0].id;
    const admin = await mk("Ada Admin", "Admin");
    const mgr = await mk("Max Mgr", "Manager");
    const agent = await mk("Ann Agent", "Agent");
    await mk("Gone Agent", "Agent", false);
    await mk("Cand Idate", "Candidate");
    await mk("Acc Ountant", "Accountant");
    const tok = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const get = (t) => fetch(`${base}/crm/staff`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
    const ok = await get(tok(admin, "Admin"));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.rows.map((r) => r.full_name).sort(), ["Ada Admin", "Ann Agent", "Max Mgr"]);
    assert.deepEqual(Object.keys(body.rows[0]).sort(), ["full_name", "id", "role"]);
    assert.equal((await get(tok(mgr, "Manager"))).status, 403, "Manager lacks users:write");
    assert.equal((await get(tok(agent, "Agent"))).status, 403);
    assert.equal((await get()).status, 401);
    // static assets are served with the strict CSP
    for (const f of NEW_JS) {
      const res = await fetch(`${base}/vita/${f}`);
      assert.equal(res.status, 200, f);
      assert.match(res.headers.get("content-type"), /javascript/);
      assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
      await res.arrayBuffer();
    }
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
});
