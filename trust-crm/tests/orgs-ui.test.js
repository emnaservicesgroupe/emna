// Task 7 (employer / agency portals): portal pages, staff tabs "Organisations" and "Employer requests".
// Static checks (i18n parity, CSP-safety, wiring, disclaimer), unit tests of the pure helpers in public/vita/orgs-util.js,
// and a contract test that feeds the helpers' payloads to the real API. The rendered behaviour is exercised by the
// browser smoke documented in the task report.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "orgs-ui-test-secret";

const VITA = path.join(__dirname, "..", "public", "vita");
const SITE = path.join(__dirname, "..", "public", "site");
const I18N = require("../public/vita/i18n.js");
const SITE_I18N = require("../public/site/i18n-site.js");
const U = require("../public/vita/crm-util.js");
const O = require("../public/vita/orgs-util.js");
const { PERMISSIONS } = require("../middleware/role");
const presentations = require("../modules/orgs/presentations");
const employerRequests = require("../modules/orgs/employerRequests");
const agencyCandidates = require("../modules/orgs/agencyCandidates");
const orgsAdmin = require("../modules/orgs/orgsAdmin");
const shareConsents = require("../modules/orgs/shareConsents");

const read = (f) => fs.readFileSync(path.join(VITA, f), "utf8");
const readSite = (f) => fs.readFileSync(path.join(SITE, f), "utf8");
const LANGS = ["ar", "en", "fr"];
const TITLE = "البحث الآلي عن عمل / AI Job Search & Applications";
const DISCLAIMER = {
  en: "This service helps you search and apply for job opportunities. It does not guarantee employment, employer sponsorship, a work permit or a visa.",
  ar: "تساعدك هذه الخدمة على البحث عن فرص العمل والتقديم إليها. وهي لا تضمن الحصول على عمل أو كفالة صاحب العمل أو تصريح عمل أو تأشيرة.",
  fr: "Ce service vous aide à rechercher des offres d'emploi et à y postuler. Il ne garantit ni un emploi, ni un parrainage de l'employeur, ni un permis de travail, ni un visa.",
};
const PORTALS = [
  { page: "employer", html: "employer.html", js: "employer.js", prefix: "/employer/", other: ["/agency/", "/crm/"] },
  { page: "agency", html: "agency.html", js: "agency.js", prefix: "/agency/", other: ["/employer/", "/crm/"] },
];
const NEW_JS = ["orgs-util.js", "orgs-common.js", "employer.js", "agency.js", "crm-orgs.js", "crm-requests.js"];
// V.api() path prefixes each script may call (everything is same-origin and literal)
const API_PREFIXES = {
  "orgs-util.js": [],
  "orgs-common.js": ["/jobsearch/auth/otp/"],
  "employer.js": ["/employer/"],
  "agency.js": ["/agency/"],
  "crm-orgs.js": ["/crm/"],
  "crm-requests.js": ["/crm/", "/jobsearch/dashboard"],
};
const KEY_PREFIXES = ["orgs.", "employer.", "agency.", "crm.org.", "crm.req."];
const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");

// ---------------------------------------------------------------- portal pages

for (const p of PORTALS) {
  test(`${p.html}: structure, exact section title, logo, ordered deferred scripts, three-language disclaimer, no inline code`, () => {
    const html = read(p.html);
    const h1 = /<h1\b[^>]*>([^<]*)<\/h1>/.exec(html);
    assert.ok(h1, "h1");
    assert.equal(h1[1].replace(/&amp;/g, "&"), TITLE);
    assert.doesNotMatch(h1[0], /data-i18n/);
    assert.match(html, /src="logo\.webp"[^>]*alt="VITA"|alt="VITA"[^>]*src="logo\.webp"/);
    assert.match(html, new RegExp(`<body data-page="${p.page}" data-title-key="${p.page}\\.title">`));
    const order = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(order, ["i18n.js", "vita.js", "orgs-util.js", "orgs-common.js", p.js]);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /\sstyle\s*=/i);
    assert.doesNotMatch(html, /<style\b/i);
    assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/i);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /(?:href|src)="(?:https?:)?\/\//i);
    assert.doesNotMatch(html, /https?:\/\//i);
    // the standard disclaimer: active language prominently + all three languages; English fallback without JS
    assert.match(html, /data-i18n="disclaimer"/);
    for (const lang of LANGS) assert.match(html, new RegExp(`data-disclaimer-lang="${lang}"`), `${lang} slot`);
    assert.ok(html.includes(DISCLAIMER.en), "English disclaimer text ships in the page");
    // OTP login reused from the candidate portal markup (ids used by orgs-common.js)
    for (const id of ["login-view", "otp-request-form", "otp-verify-form", "otp-email", "otp-code", "otp-error", "otp-resend", "app-view", "logout", "lang-switch", "toasts", "live"]) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /role="tablist"/);
    // every data-i18n key resolves in all three languages
    const missing = [];
    for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) for (const l of LANGS) if (!(m[1] in I18N.dictionaries[l])) missing.push(`${l}:${m[1]}`);
    assert.deepEqual(missing, []);
  });
}

test("employer.html shows the limited-details notice; agency.html explains the passport field and requires the consent attestation", () => {
  const emp = read("employer.html");
  assert.match(emp, /data-i18n="employer\.limited"/);
  assert.match(emp, /id="tab-requests"/);
  assert.match(emp, /id="tab-presentations"/);
  const en = I18N.dictionaries.en;
  assert.equal(en["employer.limited"], "Candidate details are limited. We do not guarantee employment, sponsorship, a work permit or a visa.");
  assert.match(I18N.dictionaries.ar["employer.limited"], /[؀-ۿ]/);
  assert.match(I18N.dictionaries.ar["employer.limited"], /تأشيرة/);
  assert.match(I18N.dictionaries.fr["employer.limited"], /visa/);
  assert.notEqual(I18N.dictionaries.fr["employer.limited"], en["employer.limited"]);

  const ag = read("agency.html");
  assert.match(ag, /id="tab-register"/);
  assert.match(ag, /id="tab-candidates"/);
  assert.match(ag, /<input[^>]*id="reg-consent"[^>]*type="checkbox"[^>]*required|<input[^>]*type="checkbox"[^>]*id="reg-consent"[^>]*required/);
  assert.match(ag, /data-i18n="agency\.passportHint"/);
  assert.match(en["agency.passportHint"], /only/i);
  assert.match(en["agency.passportHint"], /duplicate/i);
  assert.match(en["agency.consent"], /permission|consent/i);
  assert.ok(!/id="reg-consent"[^>]*checked/.test(ag), "attestation is never pre-ticked");
});

test("admin.html: Organisations and Employer requests tabs + panels; scripts load after the CRM scripts; no inline code", () => {
  const html = read("admin.html");
  for (const [tab, key] of [["orgs", "tab.orgs"], ["employerRequests", "tab.employerRequests"]]) {
    assert.match(html, new RegExp(`<button type="button" role="tab" id="tab-${tab}" aria-controls="panel-${tab}" data-tab="${tab}" data-i18n="${key.replace(".", "\\.")}">`), `tab ${tab}`);
    assert.match(html, new RegExp(`<section id="panel-${tab}" role="tabpanel" aria-labelledby="tab-${tab}"`), `panel ${tab}`);
  }
  const order = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  assert.ok(order.indexOf("orgs-util.js") > order.indexOf("crm-util.js"));
  assert.ok(order.indexOf("crm-orgs.js") > order.indexOf("orgs-util.js") && order.indexOf("crm-requests.js") > order.indexOf("orgs-util.js"));
  assert.ok(order.indexOf("crm-orgs.js") > order.indexOf("admin.js") && order.indexOf("crm-requests.js") > order.indexOf("admin.js"));
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/i);
  const missing = [];
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) for (const l of LANGS) if (!(m[1] in I18N.dictionaries[l])) missing.push(`${l}:${m[1]}`);
  assert.deepEqual(missing, []);
});

test("index.html links to the employer and agency portals (and still to candidate + staff)", () => {
  const html = read("index.html");
  for (const f of ["portal.html", "admin.html", "employer.html", "agency.html"]) assert.match(html, new RegExp(`<a class="card" href="${f.replace(".", "\\.")}">`), f);
  const missing = [];
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) for (const l of LANGS) if (!(m[1] in I18N.dictionaries[l])) missing.push(`${l}:${m[1]}`);
  assert.deepEqual(missing, []);
});

test("public site: employers page links to the employer portal, plus a line for agencies, with ar/en/fr parity", () => {
  const html = readSite("employers.html");
  assert.match(html, /href="\/vita\/employer\.html"/);
  assert.match(html, /href="\/vita\/agency\.html"/);
  const { dictionaries } = SITE_I18N;
  for (const k of ["employers.portal.h", "employers.portal.p", "employers.portal.link", "employers.agency.p", "employers.agency.link"]) {
    assert.match(html, new RegExp(`data-i18n="${k.replace(/\./g, "\\.")}"`), `${k} used in employers.html`);
    for (const l of LANGS) assert.ok(typeof dictionaries[l][k] === "string" && dictionaries[l][k].trim(), `${l}.${k}`);
  }
  // the site never promises hiring through the portal
  assert.doesNotMatch(dictionaries.en["employers.portal.p"], /\bwe guarantee\b/i);
  assert.doesNotMatch(dictionaries.fr["employers.portal.p"], /nous garantissons/i);
  assert.match(dictionaries.ar["employers.portal.link"], /[؀-ۿ]/);
});

// ---------------------------------------------------------------- scripts: CSP-safety + wiring

test("the API client allows /employer/ and /agency/ besides the existing prefixes (which are unchanged)", () => {
  const src = read("vita.js");
  assert.match(src, /\^\\\/\(jobsearch\|auth\|crm\)\\\//);
  assert.match(src, /\^\\\/\(employer\|agency\)\\\//);
});

test("static scan: new scripts render untrusted text via textContent helpers only and call only their own literal API prefixes", () => {
  const SINKS = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b|setTimeout\(\s*["'`]|setInterval\(\s*["'`]/;
  for (const f of NEW_JS) {
    assert.ok(fs.existsSync(path.join(VITA, f)), `${f} exists`);
    const src = read(f);
    src.split("\n").forEach((line, i) => assert.doesNotMatch(line, SINKS, `${f}:${i + 1}`));
    assert.doesNotMatch(src, /https?:\/\//, `${f}: absolute URL`);
    assert.doesNotMatch(src, /\b(?:href|src)\s*:|srcdoc|\.(?:href|src)\s*=|setAttribute\(\s*["'](?:on|href|src|style)|\.on[a-z]+\s*=/, `${f}: link/handler sink`);
    assert.doesNotMatch(src, /localStorage|sessionStorage|document\.cookie/, `${f}: storage access belongs in vita.js`);
    assert.doesNotMatch(src, /console\.(log|info|debug)/, `${f}: console output`);
    assert.doesNotMatch(src, /[?&](?:token|access_token)=/, `${f}: token in a URL`);
    const allowed = API_PREFIXES[f];
    for (const m of src.matchAll(/V\.api\(\s*"[A-Z]+"\s*,\s*"([^"]*)"/g)) assert.ok(allowed.some((a) => m[1].startsWith(a)), `${f}: ${m[1]} not within ${allowed.join(",")}`);
    for (const m of src.matchAll(/V\.api\(\s*"[A-Z]+"\s*,\s*([^"\s][^,)]*)/g)) assert.fail(`${f}: API path must start with a string literal: ${m[1]}`);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest/, `${f}: network access goes through V.api`);
  }
  // pure helpers never touch the DOM
  assert.doesNotMatch(read("orgs-util.js"), /\bdocument\b|\bV\.|VITA\b/);
  // the employer script never reaches the staff or agency APIs, and vice versa
  for (const p of PORTALS) for (const o of p.other) assert.ok(!read(p.js).includes(`"${o}`), `${p.js} must not call ${o}`);
});

test("scripts use only DOM-safe attribute handling: textContent via h(), buttons carry type, no data-driven attribute names", () => {
  for (const f of ["employer.js", "agency.js", "crm-orgs.js", "crm-requests.js", "orgs-common.js"]) {
    const src = read(f);
    for (const m of src.matchAll(/h\("button",\s*\{([^}]*)\}/g)) assert.match(m[1], /type:/, `${f}: button without a type: ${m[0].slice(0, 60)}`);
    assert.doesNotMatch(src, /attrs\s*:\s*\{\s*\[/, `${f}: computed attribute names`);
  }
});

test("every t(\"...\") key and every complete orgs/employer/agency/crm.org/crm.req key literal in the new scripts exists in ar/en/fr", () => {
  const used = new Set();
  for (const f of NEW_JS) {
    const src = read(f);
    for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"\s*[,)]/g)) used.add(m[1]);
    for (const m of src.matchAll(/"((?:orgs|employer|agency|crm\.org|crm\.req)\.[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 80, `expected many keys, got ${used.size}`);
  const missing = [];
  for (const k of used) for (const l of LANGS) if (!(k in I18N.dictionaries[l])) missing.push(`${l}:${k}`);
  assert.deepEqual(missing, []);
});

// ---------------------------------------------------------------- i18n

test("i18n: every new key (orgs.*, employer.*, agency.*, crm.org.*, crm.req.*, tabs, index cards) is present, translated and placeholder-identical in ar/en/fr", () => {
  const { en, ar, fr } = I18N.dictionaries;
  const keys = Object.keys(en).filter((k) => KEY_PREFIXES.some((p) => k.startsWith(p)));
  for (const extra of ["tab.orgs", "tab.employerRequests", "index.employer", "index.employerHint", "index.agency", "index.agencyHint", "employer.title", "agency.title"]) {
    assert.ok(extra in en, extra);
    if (!keys.includes(extra)) keys.push(extra);
  }
  assert.ok(keys.length > 200, `new keys: ${keys.length}`);
  for (const k of keys) {
    for (const [name, d] of [["ar", ar], ["fr", fr]]) {
      assert.equal(typeof d[k], "string", `${name}.${k}`);
      assert.ok(d[k].trim().length > 0, `${name}.${k} empty`);
      assert.equal(ph(d[k]), ph(en[k]), `${name}.${k} placeholders`);
    }
  }
  // Arabic must be Arabic script, French must differ from English for prose labels
  for (const k of ["employer.limited", "employer.requests.new", "employer.respond.interview", "agency.register.submit", "agency.consent", "crm.org.invite", "crm.req.present", "crm.req.consent.record", "tab.orgs", "tab.employerRequests"]) {
    assert.match(ar[k], /[؀-ۿ]/, `ar ${k}`);
    if (k !== "tab.orgs") assert.notEqual(fr[k], en[k], `fr ${k} is a copy of en`); // "Organisations" is the same word in French
  }
  // no key is a bare copy of its own name (forgotten translation)
  for (const k of keys) assert.notEqual(en[k], k, k);
});

test("i18n: runtime-built key families match the server enums and the helper constants", () => {
  const families = {
    "orgs.rstatus": presentations.TRANSITIONS && Object.keys(presentations.TRANSITIONS),
    "orgs.pstatus": O.PRESENTATION_STATUSES,
    "orgs.ostatus": ["new", "active", "suspended", "inactive"],
    "orgs.summary": presentations.SUMMARY_KEYS,
    "orgs.f": O.FIELD_LABELS,
    "agency.st": Object.keys(agencyCandidates.STATUS_TEXT),
    "crm.req.tr": ["in_review", "accepted", "declined", "filled", "cancelled"],
    "orgs.v": ["required", "long", "invalid", "contact"],
    "employer.respond": O.RESPONSES,
  };
  const missing = [];
  for (const [prefix, codes] of Object.entries(families)) {
    assert.ok(Array.isArray(codes) && codes.length > 0, prefix);
    for (const c of codes) for (const l of LANGS) if (!(`${prefix}.${c}` in I18N.dictionaries[l])) missing.push(`${l}:${prefix}.${c}`);
  }
  assert.deepEqual(missing, []);
});

// ---------------------------------------------------------------- mirrors of server rules

test("helper constants mirror the server (statuses, transitions, allowlist, field limits)", () => {
  assert.deepEqual(O.REQUEST_STATUSES, Object.keys(presentations.TRANSITIONS));
  assert.deepEqual(O.REQUEST_TRANSITIONS, presentations.TRANSITIONS);
  assert.deepEqual(O.SUMMARY_KEYS, presentations.SUMMARY_KEYS);
  assert.deepEqual(O.REQUEST_FIELDS, employerRequests.FIELDS);
  assert.deepEqual(O.REQUEST_LIMITS, employerRequests.LIMITS);
  assert.deepEqual(O.REQUEST_REQUIRED, employerRequests.REQUIRED);
  assert.deepEqual(O.AGENCY_CAPS, agencyCandidates.CAPS);
  assert.deepEqual(O.AGENCY_CODES, Object.keys(agencyCandidates.STATUS_TEXT));
  assert.deepEqual(O.ORG_FIELDS.employer, orgsAdmin.TYPES.employer.fields);
  assert.deepEqual(O.ORG_FIELDS.agency, orgsAdmin.TYPES.agency.fields);
  assert.deepEqual(O.ORG_STATUSES.employer, orgsAdmin.TYPES.employer.statuses);
  assert.deepEqual(O.ORG_STATUSES.agency, orgsAdmin.TYPES.agency.statuses);
  assert.equal(O.BASIS_MAX, shareConsents.BASIS_MAX);
  assert.deepEqual(O.RESPONSES, ["interested", "interview", "not_suitable"]);
  assert.deepEqual(O.PRESENTATION_STATUSES, ["presented", "interested", "interview", "not_suitable", "withdrawn"]);
  assert.deepEqual(O.PRESENT_STATUSES, ["in_review", "accepted"]);
  assert.equal(O.OTP_COOLDOWN_SECONDS, 60);
});

test("U.can mirrors orgs:read / orgs:write for every staff role and denies portal and candidate roles", () => {
  for (const role of ["SuperAdmin", "Admin", "Manager", "Receptionist", "Agent"]) {
    for (const perm of ["orgs:read", "orgs:write", "candidates:read", "candidates:write", "sitejobs:write", "leads:read"]) {
      const perms = PERMISSIONS[role];
      assert.equal(U.can(role, perm), perms.includes("*") || perms.includes(perm), `${role} ${perm}`);
    }
  }
  for (const role of ["Employer", "Agency", "Candidate", "Accountant", "HR", undefined]) {
    assert.equal(U.can(role, "orgs:read"), false, `${role} orgs:read`);
    assert.equal(U.can(role, "orgs:write"), false, `${role} orgs:write`);
  }
  assert.equal(U.canOrgsRead("Receptionist"), true);
  assert.equal(U.canOrgsWrite("Receptionist"), false, "Receptionist reads organisations only");
  assert.equal(U.canOrgsWrite("Manager"), true);
  assert.equal(U.canOrgsRead("Agent"), false);
  assert.equal(U.canPresent("Manager"), true);
  assert.equal(U.canPresent("Receptionist"), false);
  assert.equal(U.canRecordConsent("Agent"), true, "consent needs candidates:write (+ scope)");
  assert.equal(U.canRecordConsent("Receptionist"), true);
  assert.equal(U.canCreateSiteJob("Manager"), true);
  assert.equal(U.canCreateSiteJob("Receptionist"), false);
});

// ---------------------------------------------------------------- pure helpers

test("requestPayload: trims, blanks -> null, numbers and dates validated with the server limits; errors name the field", () => {
  const form = { title: " Welders ", positions: "3", country: "Canada", city: " ", category: "", description: "Weld", requirements: "", salary_text: "", start_date: "2031-02-03" };
  assert.deepEqual(O.requestPayload(form), {
    ok: true,
    payload: { title: "Welders", positions: 3, country: "Canada", city: null, category: null, description: "Weld", requirements: null, salary_text: null, start_date: "2031-02-03" },
  });
  assert.equal(O.requestPayload({ ...form, start_date: "" }).payload.start_date, null);
  assert.deepEqual(O.requestPayload({ ...form, title: "  " }), { ok: false, field: "title", error: "required" });
  assert.deepEqual(O.requestPayload({ ...form, country: "" }), { ok: false, field: "country", error: "required" });
  assert.deepEqual(O.requestPayload({ ...form, description: "\n " }), { ok: false, field: "description", error: "required" });
  assert.deepEqual(O.requestPayload({ ...form, title: "t".repeat(161) }), { ok: false, field: "title", error: "long" });
  assert.equal(O.requestPayload({ ...form, title: "t".repeat(160) }).ok, true);
  assert.deepEqual(O.requestPayload({ ...form, description: "d".repeat(8001) }), { ok: false, field: "description", error: "long" });
  assert.equal(O.requestPayload({ ...form, description: "d".repeat(8000) }).ok, true);
  assert.deepEqual(O.requestPayload({ ...form, requirements: "r".repeat(4001) }), { ok: false, field: "requirements", error: "long" });
  assert.deepEqual(O.requestPayload({ ...form, salary_text: "s".repeat(161) }), { ok: false, field: "salary_text", error: "long" });
  for (const bad of ["0", "1001", "1.5", "abc", "", "-2", "1e2"]) assert.deepEqual(O.requestPayload({ ...form, positions: bad }), { ok: false, field: "positions", error: "invalid" }, bad);
  assert.equal(O.requestPayload({ ...form, positions: "1000" }).payload.positions, 1000);
  assert.equal(O.requestPayload({ ...form, positions: 7 }).payload.positions, 7, "numbers are accepted too");
  for (const bad of ["2031-02-30", "31/12/2031", "1800-01-01", "2031-13-01", "x"]) assert.deepEqual(O.requestPayload({ ...form, start_date: bad }), { ok: false, field: "start_date", error: "invalid" }, bad);
  assert.deepEqual(Object.keys(O.requestPayload(form).payload).sort(), [...O.REQUEST_FIELDS].sort());
});

test("requestDiff keeps only changed fields (null and empty are the same); requestValues turns a stored row into form strings", () => {
  const row = { id: "9", title: "Welders", positions: 3, country: "Canada", city: null, category: "Welding", description: "Weld", requirements: null, salary_text: null, start_date: "2031-02-03", status: "submitted" };
  const same = O.requestPayload(O.requestValues(row)).payload;
  assert.deepEqual(O.requestDiff(row, same), {});
  assert.deepEqual(O.requestValues(row), { title: "Welders", positions: "3", country: "Canada", city: "", category: "Welding", description: "Weld", requirements: "", salary_text: "", start_date: "2031-02-03" });
  const next = O.requestPayload({ ...O.requestValues(row), city: "Toronto", positions: "4", category: "", start_date: "" }).payload;
  assert.deepEqual(O.requestDiff(row, next), { city: "Toronto", positions: 4, category: null, start_date: null });
});

test("request status rules: editable only while submitted, cancellable while submitted or in_review", () => {
  assert.equal(O.requestEditable("submitted"), true);
  for (const s of ["in_review", "accepted", "declined", "filled", "cancelled"]) assert.equal(O.requestEditable(s), false, s);
  assert.equal(O.requestCancellable("submitted"), true);
  assert.equal(O.requestCancellable("in_review"), true);
  for (const s of ["accepted", "declined", "filled", "cancelled"]) assert.equal(O.requestCancellable(s), false, s);
  assert.deepEqual(O.nextStatuses("submitted"), ["in_review", "declined", "cancelled"]);
  assert.deepEqual(O.nextStatuses("declined"), []);
  assert.deepEqual(O.nextStatuses("bogus"), []);
  assert.equal(O.canPresentStatus("accepted"), true);
  assert.equal(O.canPresentStatus("submitted"), false);
  for (const s of O.REQUEST_STATUSES) assert.ok(["neutral", "info", "warn", "ok", "bad", "gold"].includes(O.requestStatusClass(s)), s);
  for (const s of O.PRESENTATION_STATUSES) assert.ok(["neutral", "info", "warn", "ok", "bad", "gold"].includes(O.presentationStatusClass(s)), s);
  assert.equal(O.requestStatusClass("weird"), "neutral");
});

test("summaryRows: exactly the six allowlisted keys, in order, as plain text; anything else in the object is ignored", () => {
  const rows = O.summaryRows({
    profession: "Welder", years_experience: 5, languages: ["Arabic (native)", "German (B1)"], country_of_residence: "Tunisia", availability: "immediately",
    staff_note_for_employer: "Good", passport: "P1", email: "x@y.z", full_name: "Secret", candidate_id: 4,
  });
  assert.deepEqual(rows, [
    { key: "profession", value: "Welder" },
    { key: "years_experience", value: "5" },
    { key: "languages", value: "Arabic (native), German (B1)" },
    { key: "country_of_residence", value: "Tunisia" },
    { key: "availability", value: "immediately" },
    { key: "staff_note_for_employer", value: "Good" },
  ]);
  assert.deepEqual(rows.map((r) => r.key), O.SUMMARY_KEYS);
  assert.equal(O.summaryRows({ years_experience: 0 })[1].value, "0");
  assert.deepEqual(O.summaryRows(null).map((r) => r.value), [null, null, null, null, null, null]);
  assert.deepEqual(O.summaryRows({ languages: [], profession: "  " }).slice(0, 3).map((r) => r.value), [null, null, null]);
  assert.equal(O.summaryRows({ profession: "<b>x</b>" })[0].value, "<b>x</b>", "returned as data; the UI sets textContent");
});

test("respondPayload: only interested / interview / not_suitable, note trimmed and capped at 1000", () => {
  assert.deepEqual(O.respondPayload("interview", " ok "), { ok: true, payload: { status: "interview", note: "ok" } });
  assert.deepEqual(O.respondPayload("interested", "  "), { ok: true, payload: { status: "interested" } });
  assert.deepEqual(O.respondPayload("not_suitable"), { ok: true, payload: { status: "not_suitable" } });
  for (const bad of ["withdrawn", "presented", "", undefined, "INTERVIEW"]) assert.deepEqual(O.respondPayload(bad, ""), { ok: false, field: "status", error: "invalid" }, String(bad));
  assert.equal(O.respondPayload("interview", "n".repeat(1000)).ok, true);
  assert.deepEqual(O.respondPayload("interview", "n".repeat(1001)), { ok: false, field: "note", error: "long" });
});

test("agencyPayload: mirrors the API (name, e-mail or phone, passport only for duplicates, caps, required attestation)", () => {
  const form = { full_name: " Amira ", email: " A@X.TEST ", phone: "+216 20 123 456", country: "Tunisia", profession: "Welder", message: "", passport_number: " aa 1234 ", consent_attested: true };
  assert.deepEqual(O.agencyPayload(form), {
    ok: true,
    payload: { full_name: "Amira", email: "a@x.test", phone: "+216 20 123 456", country: "Tunisia", profession: "Welder", passport_number: "aa 1234", consent_attested: true },
  });
  assert.deepEqual(O.agencyPayload({ full_name: "B", phone: "0612345678", consent_attested: true }), { ok: true, payload: { full_name: "B", phone: "0612345678", consent_attested: true } });
  assert.deepEqual(O.agencyPayload({ ...form, consent_attested: false }), { ok: false, field: "consent_attested", error: "required" });
  assert.deepEqual(O.agencyPayload({ ...form, consent_attested: "true" }), { ok: false, field: "consent_attested", error: "required" }, "strictly boolean true");
  assert.deepEqual(O.agencyPayload({ ...form, full_name: " " }), { ok: false, field: "full_name", error: "required" });
  assert.deepEqual(O.agencyPayload({ ...form, email: "", phone: "" }), { ok: false, field: "email", error: "contact" });
  assert.deepEqual(O.agencyPayload({ ...form, email: "not-an-email" }), { ok: false, field: "email", error: "invalid" });
  assert.deepEqual(O.agencyPayload({ ...form, phone: "abc" }), { ok: false, field: "phone", error: "invalid" });
  assert.deepEqual(O.agencyPayload({ ...form, phone: "12 34" }), { ok: false, field: "phone", error: "invalid" });
  assert.deepEqual(O.agencyPayload({ ...form, passport_number: "a-b" }), { ok: false, field: "passport_number", error: "invalid" });
  assert.deepEqual(O.agencyPayload({ ...form, full_name: "n".repeat(121) }), { ok: false, field: "full_name", error: "long" });
  assert.deepEqual(O.agencyPayload({ ...form, message: "m".repeat(4001) }), { ok: false, field: "message", error: "long" });
  assert.deepEqual(O.agencyPayload({ ...form, country: "c".repeat(81) }), { ok: false, field: "country", error: "long" });
  assert.deepEqual(O.agencyPayload({ ...form, profession: "p".repeat(121) }), { ok: false, field: "profession", error: "long" });
  assert.deepEqual(O.agencyPayload({ ...form, passport_number: "p".repeat(41) }), { ok: false, field: "passport_number", error: "long" });
  assert.equal(O.agencyStageKey({ stage: "visa" }), "agency.st.visa");
  assert.equal(O.agencyStageKey({ stage: "new" }), "agency.st.new");
  assert.equal(O.agencyStageKey({ stage: "something-new" }), null);
  assert.equal(O.agencyStageKey(null), null);
});

test("orgPayload / orgDiff: trimmed text, blank -> null, name required, e-mail lower-cased and checked, per-type fields only", () => {
  const form = { name: " Acme ", contact_name: "", email: " Hr@Acme.TEST ", phone: "", country: "Germany", sector: "Industry", notes: "n", status: "active", bogus: "x" };
  assert.deepEqual(O.orgPayload("employer", form), { ok: true, payload: { name: "Acme", contact_name: null, email: "hr@acme.test", phone: null, country: "Germany", sector: "Industry", notes: "n" } });
  assert.deepEqual(Object.keys(O.orgPayload("agency", form).payload).sort(), ["contact_name", "country", "email", "name", "notes", "phone"], "agencies have no sector; status is never sent");
  assert.deepEqual(O.orgPayload("employer", { ...form, name: " " }), { ok: false, field: "name", error: "required" });
  assert.deepEqual(O.orgPayload("employer", { ...form, email: "nope" }), { ok: false, field: "email", error: "invalid" });
  assert.deepEqual(O.orgPayload("employer", { ...form, notes: "n".repeat(4001) }), { ok: false, field: "notes", error: "long" });
  assert.deepEqual(O.orgPayload("agency", { ...form, phone: "9".repeat(41) }), { ok: false, field: "phone", error: "long" });
  const base = { id: "1", name: "Acme", contact_name: null, email: "hr@acme.test", phone: null, country: "Germany", sector: "Industry", notes: "n", status: "active" };
  assert.deepEqual(O.orgDiff(base, O.orgPayload("employer", O.orgValues("employer", base)).payload), {});
  assert.deepEqual(O.orgDiff(base, O.orgPayload("employer", { ...O.orgValues("employer", base), phone: "+49 1", sector: "" }).payload), { phone: "+49 1", sector: null });
});

test("invitePayload / consentPayload / activeConsent", () => {
  assert.deepEqual(O.invitePayload({ email: " A@B.CO ", full_name: " X " }), { ok: true, payload: { email: "a@b.co", full_name: "X" } });
  assert.deepEqual(O.invitePayload({ email: "bad", full_name: "X" }), { ok: false, field: "email", error: "invalid" });
  assert.deepEqual(O.invitePayload({ email: "a@b.co", full_name: " " }), { ok: false, field: "full_name", error: "required" });
  assert.deepEqual(O.invitePayload({ email: "a@b.co", full_name: "n".repeat(201) }), { ok: false, field: "full_name", error: "long" });
  assert.deepEqual(O.consentPayload("5", " signed form "), { ok: true, payload: { employer_id: 5, basis: "signed form" } });
  assert.deepEqual(O.consentPayload(5, " "), { ok: false, field: "basis", error: "required" });
  assert.deepEqual(O.consentPayload(5, "b".repeat(501)), { ok: false, field: "basis", error: "long" });
  assert.equal(O.consentPayload(5, "b".repeat(500)).ok, true);
  assert.deepEqual(O.consentPayload("x", "b"), { ok: false, field: "employer_id", error: "invalid" });
  const rows = [
    { id: 1, employer_id: "5", withdrawn_at: "2026-10-01T00:00:00Z" },
    { id: 2, employer_id: "5", withdrawn_at: null },
    { id: 3, employer_id: "6", withdrawn_at: null },
  ];
  assert.equal(O.activeConsent(rows, 5).id, 2);
  assert.equal(O.activeConsent(rows, "6").id, 3);
  assert.equal(O.activeConsent(rows, 7), null);
  assert.equal(O.activeConsent([rows[0]], 5), null, "withdrawn consents do not count");
  assert.equal(O.activeConsent(null, 5), null);
});

test("presentationInput builds the preview query and the POST body from the same values (no private candidate data possible)", () => {
  assert.deepEqual(O.presentationInput("12", {}), { ok: true, query: "candidate_id=12", body: { candidate_id: 12 } });
  const form = { note: " Good one ", profession: "Welder", years_experience: "5", languages: "Arabic, French ,", country_of_residence: "Tunisia", availability: "now" };
  const r = O.presentationInput(12, form);
  assert.deepEqual(r, {
    ok: true,
    query: "candidate_id=12&staff_note_for_employer=Good%20one&profession=Welder&years_experience=5&languages=Arabic%2CFrench&country_of_residence=Tunisia&availability=now",
    body: { candidate_id: 12, staff_note_for_employer: "Good one", summary: { profession: "Welder", years_experience: 5, languages: ["Arabic", "French"], country_of_residence: "Tunisia", availability: "now" } },
  });
  for (const bad of ["abc", "0", "", "-3", null]) assert.deepEqual(O.presentationInput(bad, {}), { ok: false, field: "candidate_id", error: "invalid" }, String(bad));
  for (const bad of ["x", "71", "-1", "1.5"]) assert.deepEqual(O.presentationInput(1, { years_experience: bad }), { ok: false, field: "years_experience", error: "invalid" }, bad);
  assert.equal(O.presentationInput(1, { years_experience: "0" }).body.summary.years_experience, 0);
  assert.deepEqual(O.presentationInput(1, { languages: Array(11).fill("a").join(",") }), { ok: false, field: "languages", error: "long" });
  assert.deepEqual(O.presentationInput(1, { languages: "x".repeat(61) }), { ok: false, field: "languages", error: "long" });
  assert.deepEqual(O.presentationInput(1, { profession: "p".repeat(121) }), { ok: false, field: "profession", error: "long" });
  assert.deepEqual(O.presentationInput(1, { country_of_residence: "p".repeat(101) }), { ok: false, field: "country_of_residence", error: "long" });
  assert.deepEqual(O.presentationInput(1, { availability: "p".repeat(101) }), { ok: false, field: "availability", error: "long" });
  assert.deepEqual(O.presentationInput(1, { note: "n".repeat(1001) }), { ok: false, field: "staff_note_for_employer", error: "long" });
});

test("requestQuery / orgQuery: encoded, blanks omitted, page -> offset, q capped at 100", () => {
  assert.equal(O.requestQuery({}, 1, 25), "?limit=25&offset=0");
  assert.equal(O.requestQuery({ status: "in_review", employer_id: "3", q: " ali & bob " }, 2, 25), "?status=in_review&employer_id=3&q=ali%20%26%20bob&limit=25&offset=25");
  assert.equal(O.requestQuery({ q: "x".repeat(300) }, 1, 25).includes("q=" + "x".repeat(100) + "&"), true);
  assert.equal(O.orgQuery({ status: "active", q: "ac me" }, 3, 10), "?status=active&q=ac%20me&limit=10&offset=20");
  assert.equal(O.orgQuery({}, 0, 500), "?limit=100&offset=0");
});

// ---------------------------------------------------------------- contract: helper payloads are accepted by the real API

async function withWorld(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, url, token, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  try {
    await fn({ pool, base, http });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

test("contract: payloads built by the helpers are accepted by the API, and the limits the helpers enforce are the API's limits", async () => {
  await withWorld(async ({ pool, http }) => {
    const q = (sql, p) => pool.query(sql, p);
    const mkUser = async (role, name) => (await q("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [name, `${name}@orgs-ui.test.invalid`, role])).rows[0].id;
    const adminId = await mkUser("Admin", "ui-admin");
    const admin = jwt.sign({ id: adminId, role: "Admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    // staff: organisation create / edit / invite
    const org = O.orgPayload("employer", { name: " Contract GmbH ", contact_name: "Hans", email: "HR@contract.test", phone: "+49 30 1", country: "Germany", sector: "Industry", notes: "" });
    assert.equal(org.ok, true);
    const created = await http("POST", "/crm/employers", admin, org.payload);
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.email, "hr@contract.test");
    const empId = created.body.id;
    const diff = O.orgDiff(created.body, O.orgPayload("employer", { ...O.orgValues("employer", created.body), city: "x", phone: "" }).payload);
    assert.deepEqual(diff, { phone: null });
    assert.equal((await http("PATCH", `/crm/employers/${empId}`, admin, diff)).status, 200);
    const ag = O.orgPayload("agency", { name: "Contract Agency", email: "a@agency.test", country: "Tunisia" });
    const agency = await http("POST", "/crm/agencies", admin, ag.payload);
    assert.equal(agency.status, 201, agency.text);
    const inv = O.invitePayload({ email: " Boss@Contract.TEST ", full_name: "Boss" });
    const invited = await http("POST", `/crm/employers/${empId}/invite`, admin, inv.payload);
    assert.equal(invited.status, 201, invited.text);
    assert.equal(typeof invited.body.inviteSent, "boolean");
    assert.equal((await http("POST", `/crm/agencies/${agency.body.id}/invite`, admin, O.invitePayload({ email: "ceo@agency.test", full_name: "CEO" }).payload)).status, 201);
    for (const [type, id] of [["employers", empId], ["agencies", agency.body.id]]) {
      assert.equal((await http("POST", `/crm/${type}/${id}/suspend`, admin)).status, 200);
      assert.equal((await http("POST", `/crm/${type}/${id}/reactivate`, admin)).status, 200);
    }
    // the list query string the console builds is accepted
    assert.equal((await http("GET", `/crm/employers${O.orgQuery({ status: "new", q: "contract" }, 1, 25)}`, admin)).status, 200);

    // employer portal: request form -> create -> edit diff -> cancel
    const emp = await createEmployerUser(pool, { orgName: "Portal Employer" });
    const form = { title: " Welders ", positions: "3", country: "Canada", city: "", category: "Welding", description: "Weld pipes", requirements: "", salary_text: "", start_date: "2031-02-03" };
    const built = O.requestPayload(form);
    assert.equal(built.ok, true);
    const req = await http("POST", "/employer/requests", emp.token, built.payload);
    assert.equal(req.status, 201, req.text);
    const next = O.requestPayload({ ...O.requestValues(req.body), positions: "4", start_date: "", city: "Toronto" });
    const changes = O.requestDiff(req.body, next.payload);
    assert.deepEqual(changes, { positions: 4, start_date: null, city: "Toronto" });
    const patched = await http("PATCH", `/employer/requests/${req.body.id}`, emp.token, changes);
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.body.positions, 4);
    // limits: the helper's boundary values are the API's boundary values
    for (const [field, max] of Object.entries(O.REQUEST_LIMITS)) {
      const okForm = { ...form, [field]: "x".repeat(max) };
      assert.equal(O.requestPayload(okForm).ok, true, `${field} ${max}`);
      assert.equal((await http("POST", "/employer/requests", emp.token, O.requestPayload(okForm).payload)).status, 201, `api ${field} ${max}`);
      assert.equal(O.requestPayload({ ...form, [field]: "x".repeat(max + 1) }).ok, false, `${field} ${max + 1}`);
      assert.equal((await http("POST", "/employer/requests", emp.token, { ...built.payload, [field]: "x".repeat(max + 1) })).status, 400, `api ${field} ${max + 1}`);
    }

    // agency portal: register -> list shows own candidate
    const agencyUser = await createAgencyUser(pool, { orgName: "Portal Agency" });
    const reg = O.agencyPayload({ full_name: "Amira B", email: "AMIRA@x.test", phone: "", country: "Tunisia", profession: "Welder", message: "ok", passport_number: "p 123456", consent_attested: true });
    assert.equal(reg.ok, true);
    const registered = await http("POST", "/agency/candidates", agencyUser.token, reg.payload);
    assert.equal(registered.status, 201, registered.text);
    const mine = await http("GET", "/agency/candidates?limit=20&offset=0", agencyUser.token);
    assert.equal(mine.body.candidates.length, 1);
    assert.ok(O.agencyStageKey(mine.body.candidates[0]), "stage code is one the UI has a label for");
    assert.equal((await http("GET", `/agency/candidates/${mine.body.candidates[0].id}`, agencyUser.token)).status, 200);
    for (const [field, max] of Object.entries(O.AGENCY_CAPS)) {
      if (field === "email" || field === "phone") continue;
      assert.equal((await http("POST", "/agency/candidates", agencyUser.token, { ...reg.payload, [field]: "x".repeat(max + 1) })).status, 400, `api ${field} ${max + 1}`);
      assert.equal(O.agencyPayload({ full_name: "A", email: "a@x.test", [field]: "x".repeat(max + 1), consent_attested: true }).ok, false, `helper ${field}`);
    }

    // staff: consent -> preview -> present -> employer responds with the helper payload -> staff sees the response
    const cand = (await q("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ('Sec Ret','PP-UI-1',$1) RETURNING id", [adminId])).rows[0].id;
    await q("INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1,$2::jsonb,'confirmed',now())", [cand, JSON.stringify({ profession: "Welder", languages: [{ lang: "Arabic", level: "native" }], email: "leak@x.test" })]);
    await q("INSERT INTO js_preferences (candidate_id, availability, residence_country) VALUES ($1,'immediately','Tunisia')", [cand]);
    const rid = req.body.id;
    assert.equal((await http("PATCH", `/crm/employer-requests/${rid}`, admin, { status: "in_review" })).status, 200);
    const noConsentPrev = await http("GET", `/crm/employer-requests/${rid}/presentation-preview?${O.presentationInput(cand, { note: "Good" }).query}`, admin);
    assert.equal(noConsentPrev.status, 200, noConsentPrev.text);
    assert.equal(noConsentPrev.body.consent_active, false);
    const cp = O.consentPayload(emp.orgId, " signed form 2026-10-01 ");
    const rec = await http("POST", `/crm/candidates/${cand}/share-consents`, admin, cp.payload);
    assert.equal(rec.status, 201, rec.text);
    const consents = await http("GET", `/crm/candidates/${cand}/share-consents`, admin);
    assert.equal(O.activeConsent(consents.body.rows, emp.orgId).id, rec.body.id);
    const input = O.presentationInput(cand, { note: " Good ", profession: "", languages: "" });
    const prev = await http("GET", `/crm/employer-requests/${rid}/presentation-preview?${input.query}`, admin);
    assert.equal(prev.body.presentable, true);
    assert.deepEqual(O.summaryRows(prev.body.summary).map((r) => r.key), O.SUMMARY_KEYS);
    const posted = await http("POST", `/crm/employer-requests/${rid}/presentations`, admin, input.body);
    assert.equal(posted.status, 201, posted.text);
    assert.deepEqual(posted.body.summary, prev.body.summary, "what was previewed is what was stored");
    const list = await http("GET", "/employer/presentations", emp.token);
    assert.equal(list.body.presentations.length, 1);
    assert.ok(!list.text.includes("leak@x.test") && !list.text.includes("Sec Ret") && !list.text.includes("PP-UI-1"));
    assert.deepEqual(O.summaryRows(list.body.presentations[0].summary).map((r) => r.key), O.SUMMARY_KEYS);
    const resp = O.respondPayload("interview", " Please schedule ");
    const answered = await http("POST", `/employer/presentations/${list.body.presentations[0].id}/respond`, emp.token, resp.payload);
    assert.equal(answered.status, 200, answered.text);
    assert.equal(answered.body.status, "interview");
    assert.equal((await http("POST", `/employer/presentations/${list.body.presentations[0].id}/respond`, emp.token, { status: "interview", note: "n".repeat(1001) })).status, 400);
    assert.equal(O.respondPayload("interview", "n".repeat(1001)).ok, false);
    const staffView = await http("GET", `/crm/employer-requests/${rid}`, admin);
    assert.equal(staffView.body.presentations[0].status, "interview");
    assert.equal(staffView.body.presentations[0].employer_note, "Please schedule");
    assert.equal(staffView.body.presentations[0].consent_active, true);
    // notes: staff_note / employer_visible_note limits
    assert.equal((await http("PATCH", `/crm/employer-requests/${rid}`, admin, { staff_note: "s".repeat(2000), employer_visible_note: "e".repeat(1000) })).status, 200);
    assert.equal((await http("PATCH", `/crm/employer-requests/${rid}`, admin, { employer_visible_note: "e".repeat(1001) })).status, 400);
    assert.equal((await http("PATCH", `/crm/employer-requests/${rid}`, admin, { staff_note: "s".repeat(2001) })).status, 400);
    assert.equal(O.NOTE_MAX, 1000);
    assert.equal(O.STAFF_NOTE_MAX, 2000);
    // withdraw consent -> the presentation is gone for the employer at once
    assert.equal((await http("DELETE", `/crm/candidates/${cand}/share-consents/${rec.body.id}`, admin)).status, 200);
    assert.equal((await http("GET", "/employer/presentations", emp.token)).body.presentations.length, 0);
    // the request list query the console builds is accepted
    assert.equal((await http("GET", `/crm/employer-requests${O.requestQuery({ status: "in_review", q: "weld" }, 1, 25)}`, admin)).status, 200);
  });
});

test("http: the new pages and scripts are served under the strict CSP and security headers", async () => {
  const CSP = require("../routes/vitaStatic").CSP;
  await withWorld(async ({ base }) => {
    for (const f of ["employer.html", "agency.html", ...NEW_JS]) {
      const res = await fetch(`${base}/vita/${f}`);
      assert.equal(res.status, 200, f);
      assert.equal(res.headers.get("content-security-policy"), CSP, `${f} CSP`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("cache-control"), "no-cache");
      assert.match(res.headers.get("content-type"), f.endsWith(".html") ? /text\/html/ : /javascript/);
      await res.arrayBuffer();
    }
    const pub = await fetch(`${base}/site/employers.html`);
    assert.equal(pub.status, 200);
    assert.match(await pub.text(), /href="\/vita\/employer\.html"/);
  });
});
