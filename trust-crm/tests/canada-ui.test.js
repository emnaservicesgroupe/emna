// Stage 8, Task 7: UI for the Canada service layer - staff console (candidate card, vacancy classification and match bands, employers,
// do-not-contact list, company reports, contract and billing panel) and the candidate portal ("My Canada file").
// Static checks (wiring, CSP-safety, ar/en/fr parity) + unit tests of the pure helpers in public/vita/canada-util.js.
// The rendered behaviour is exercised by the browser smoke documented in the task report.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "canada-ui-test-secret";

const VITA = path.join(__dirname, "..", "public", "vita");
const I18N = require("../public/vita/i18n.js");
const U = require("../public/vita/canada-util.js");
const CRM = require("../public/vita/crm-util.js");
const FIN = require("../public/vita/fin-util.js");
const { PERMISSIONS } = require("../middleware/role");
const extras = require("../modules/jobsearch/candidateExtras");
const classification = require("../modules/jobsearch/classification");
const { BAND_LABELS } = require("../modules/jobsearch/matching");
const suppression = require("../modules/jobsearch/suppression");
const reportExport = require("../modules/jobsearch/reportExport");
const legalReviews = require("../modules/finance/legalReviews");
const contracts = require("../modules/finance/contracts");
const billingGate = require("../modules/finance/billingGate");

const read = (f) => fs.readFileSync(path.join(VITA, f), "utf8");
const LANGS = ["ar", "en", "fr"];
const STAFF_JS = ["canada-util.js", "canada-candidate.js", "canada-employers.js", "canada-reports.js", "canada-billing.js"];
const PORTAL_JS = ["canada-util.js", "canada-portal.js"];
const ALL_JS = [...new Set([...STAFF_JS, ...PORTAL_JS])];
const SINKS = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b|setTimeout\(\s*["'`]|setInterval\(\s*["'`]/;
const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
const scripts = (html) => [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
const keysIn = (html) => [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]);
const en = I18N.dictionaries.en;
const canadaKeys = Object.keys(en).filter((k) => k.startsWith("canada."));
const STAFF_ROLES = ["SuperAdmin", "Admin", "Manager", "Receptionist", "Agent", "Accountant", "HR"];

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

test("admin.html: Canada scripts load once, in order, after the CRM scripts and before the messaging/accounting/HR/MCP scripts; hooks exist; no inline code", () => {
  const html = read("admin.html");
  const order = scripts(html);
  const at = (f) => order.indexOf(f);
  assert.deepEqual(order.slice(at("canada-util.js"), at("canada-util.js") + STAFF_JS.length), STAFF_JS, "canada scripts are contiguous, util first");
  assert.ok(at("canada-util.js") > at("admin.js") && at("canada-util.js") > at("crm-requests.js"), "after the console and the CRM scripts");
  assert.ok(at("canada-billing.js") < at("chat-util.js"), "before the messaging, accounting and HR scripts");
  assert.deepEqual(order.slice(-2), ["mcp-util.js", "mcp-admin.js"], "mcp scripts stay last");
  assert.equal(order.filter((f) => f === "canada-util.js").length, 1);
  assert.ok(!order.includes("canada-portal.js"), "the portal script is for the portal only");
  // containers the scripts render into
  assert.match(html, /id="dash-canada"/);
  assert.match(html, /<button type="button" role="tab" id="tab-suppressions" aria-controls="panel-suppressions" data-tab="suppressions" data-i18n="canada\.supp\.tab">/);
  assert.match(html, /<section id="panel-suppressions" role="tabpanel" aria-labelledby="tab-suppressions"/);
  assert.match(html, /id="canada-reports-card"/);
  assert.ok(html.indexOf('id="canada-reports-card"') > html.indexOf('id="panel-reports"') && html.indexOf('id="canada-reports-card"') < html.indexOf('id="panel-health"'), "company reports live in the Reports tab");
  noInlineCode(html, "admin.html");
  keysResolve(html, "admin.html");
});

test("portal.html: 'My Canada file' step with reference banner, canada scripts between the chat scripts and portal.js, disclaimer kept, no inline code", () => {
  const html = read("portal.html");
  assert.deepEqual(scripts(html), ["i18n.js", "vita.js", "fin-util.js", "chat-util.js", "chat-panel.js", "chat-portal.js", "canada-util.js", "canada-portal.js", "portal.js"]);
  assert.match(html, /<button type="button" data-step="canada" data-i18n="canada\.portal\.step">/);
  assert.match(html, /<section id="step-canada"[^>]*aria-labelledby="canada-h"/);
  assert.match(html, /id="canada-root"/);
  assert.match(html, /id="canada-ref-banner"/);
  noInlineCode(html, "portal.html");
  keysResolve(html, "portal.html");
  assert.match(html, /data-i18n="disclaimer"/);
  for (const l of LANGS) assert.match(html, new RegExp(`data-disclaimer-lang="${l}"`), l);
  const js = read("portal.js");
  assert.match(js, /var STEPS = \["upload", "review", "prefs", "consent", "status", "payments", "canada", "chat"\]/);
  assert.match(js, /window\.VITA_CANADA_PORTAL/);
  // the existing steps and their order are untouched
  assert.ok(html.indexOf('data-step="upload"') < html.indexOf('data-step="review"') && html.indexOf('data-step="payments"') < html.indexOf('data-step="canada"') && html.indexOf('data-step="canada"') < html.indexOf('data-step="chat"'));
});

test("every Canada script exists and is served under the strict /vita CSP; the API client prefixes are unchanged", async () => {
  for (const f of ALL_JS) assert.ok(fs.existsSync(path.join(VITA, f)), f);
  const src = read("vita.js");
  assert.match(src, /\^\\\/\(jobsearch\|auth\|crm\)\\\//);
  assert.match(src, /\^\\\/finance\\\//);
  assert.doesNotMatch(src, /canada/i, "no new API prefix is needed");
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const f of [...ALL_JS, "admin.html", "portal.html", "vita.css"]) {
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

test("static scan: Canada scripts render untrusted text via textContent helpers, call only literal same-origin paths, download through authenticated blobs", () => {
  for (const f of ALL_JS) {
    const src = read(f);
    src.split("\n").forEach((line, i) => assert.doesNotMatch(line, SINKS, `${f}:${i + 1}`));
    assert.doesNotMatch(src, /https?:\/\//, `${f}: absolute URL`);
    assert.doesNotMatch(src, /\b(?:href|src)\s*:|srcdoc|\.(?:href|src)\s*=|setAttribute\(\s*["'](?:on|href|src|style)|\.on[a-z]+\s*=/, `${f}: link/handler sink`);
    assert.doesNotMatch(src, /localStorage|sessionStorage|document\.cookie/, `${f}: storage access belongs in vita.js`);
    assert.doesNotMatch(src, /console\.(log|info|debug|error|warn)/, `${f}: console output`);
    assert.doesNotMatch(src, /[?&](?:token|access_token)=/, `${f}: token in a URL`);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|window\.open\(|location\.(?:href|assign|replace)/, `${f}: network access and navigation go through V.api / V.download / V.safeLink`);
    assert.doesNotMatch(src, /attrs\s*:\s*\{\s*\[/, `${f}: computed attribute names`);
    for (const m of src.matchAll(/V\.(?:api|download)\(\s*(?:"[A-Z]+"\s*,\s*)?"([^"]*)"/g)) assert.match(m[1], /^\/(jobsearch|finance)\//, `${f}: ${m[1]}`);
    for (const m of src.matchAll(/V\.api\(\s*"[A-Z]+"\s*,\s*([^"\s][^,)]*)/g)) assert.fail(`${f}: API path must start with a string literal: ${m[1]}`);
    for (const m of src.matchAll(/V\.download\(\s*([^"\s][^,)]*)/g)) assert.fail(`${f}: download path must start with a string literal: ${m[1]}`);
    for (const m of src.matchAll(/h\("button",\s*\{([^}]*)\}/g)) assert.match(m[1], /type:/, `${f}: button without a type: ${m[0].slice(0, 70)}`);
    if (f.endsWith("-util.js")) assert.doesNotMatch(src, /\bdocument\b|\bwindow\.VITA\b|\bV\.|\bfetch\b/, `${f}: pure helpers never touch the DOM or the network`);
  }
  assert.match(read("vita.js"), /function h\(tag, props\)/);
});

test("portal scripts only reach candidate-scoped paths (/jobsearch/me/*, /finance/me/contracts); staff scripts never call the candidate-only /me/ routes", () => {
  const portal = read("canada-portal.js");
  for (const m of portal.matchAll(/V\.(?:api|download)\(\s*(?:"[A-Z]+"\s*,\s*)?"([^"]*)"/g)) assert.match(m[1], /^\/(jobsearch\/me\/|finance\/me\/contracts)/, m[1]);
  assert.match(portal, /"\/finance\/me\/contracts"/);
  for (const f of STAFF_JS) {
    const src = read(f);
    for (const m of src.matchAll(/V\.(?:api|download)\(\s*(?:"[A-Z]+"\s*,\s*)?"([^"]*)"/g)) assert.doesNotMatch(m[1], /^\/(jobsearch\/me\/|finance\/me)/, `${f}: ${m[1]}`);
  }
});

test("every t(\"...\") key used by the Canada scripts, and every complete \"canada.*\" literal, exists in ar/en/fr", () => {
  const used = new Set();
  for (const f of ALL_JS) {
    const src = read(f);
    for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"\s*[,)]/g)) used.add(m[1]);
    for (const m of src.matchAll(/"(canada\.[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 90, `expected many keys, got ${used.size}`);
  const missing = [];
  for (const k of used) for (const l of LANGS) if (!(k in I18N.dictionaries[l])) missing.push(`${l}:${k}`);
  assert.deepEqual(missing, []);
});

test("every key used with a dynamic suffix (prefix + code) has an entry for every possible code", () => {
  const dyn = {
    "canada.province.": U.PROVINCES,
    "canada.workauth.": U.WORK_AUTH,
    "canada.band.": [...U.BANDS, "unknown"],
    "canada.class.": [...U.CLASSES, "unclassified"],
    "canada.decision.": U.DECISIONS,
    "canada.empstatus.": U.EMPLOYER_STATUSES,
    "canada.supp.kind.": U.SUPPRESSION_KINDS,
    "canada.supp.source.": U.SUPPRESSION_SOURCES,
    "canada.legal.status.": U.LEGAL_STATUSES,
    "canada.contract.status.": U.CONTRACT_STATUSES,
    "canada.svckind.": U.SERVICE_KINDS,
    "canada.outreach.": U.OUTREACH_CODES,
    "canada.report.preset.": U.PERIOD_PRESETS,
    "canada.report.lang.": U.REPORT_LANGS,
    "canada.cv.lang.": U.CV_LANGS,
    "canada.section.": U.SECTION_KEYS,
    "canada.cv.status.": [...U.CV_STATUSES, "stale"],
    "canada.billing.reason.": [...U.BILLING_REASONS, "unknown"],
    "canada.relocation.": ["unknown", "true", "false"],
    "canada.missing.": ["professional_summary", "experience", "skills", "education", "certifications", "languages", "contact.location", "contact.email", "contact.phone", "latin_spelling_needed", "excluded_sensitive", "dates"],
    "canada.snapshot.kind.": ["daily", "weekly", "monthly", "custom", "candidate_activity"],
    "canada.snapshot.flag.": ["pdf_font_arabic_unavailable", "pdf_non_latin_text"],
    "canada.settings.source.": ["stored", "env", "hr_timezone", "default"],
    "canada.err.": [
      "nothing", "formats", "city", "whatsapp", "relocation_ready", "desired_province", "work_authorization_status", "service_start_date",
      "class_classification", "class_evidence", "class_evidence_long", "class_note", "class_note_long",
      "range_from", "range_to", "range_order", "range_long", "range_lang",
      "province", "industry", "phone", "recruiterContactName", "status", "sourceUrlsMany", "eligibilityNote", "notes", "sourceUrls",
      "supp_kind", "supp_value", "supp_email", "supp_domain", "supp_reason_long", "supp_remove_short", "supp_remove_long",
      "timezone", "signed_by_name", "reason_long",
      "contract_candidate", "contract_service", "contract_start_date", "contract_end_date", "contract_date_order", "contract_refund_terms",
      "legal_jurisdiction", "legal_status", "legal_reviewer_name", "legal_reviewer_role", "legal_reviewed_at", "legal_reviewed_future", "legal_valid_until", "legal_valid_order", "legal_note",
    ],
    "err.code.": ["jurisdiction_unknown", "legal_review_required", "candidate_fee_prohibited", "service_contract_required", "candidate_fee_use_catalogue", "recipient_suppressed", "employer_opted_out", "outreach_basis_not_permitted"],
    "canada.class.hint.": ["short", "found", "not_found", "no_text", "required"],
  };
  const missing = [];
  for (const [prefix, codes] of Object.entries(dyn)) for (const c of codes) for (const l of LANGS) if (!(`${prefix}${c}` in I18N.dictionaries[l])) missing.push(`${l}:${prefix}${c}`);
  assert.deepEqual(missing, []);
  // the server enums are the source of truth for these families
  assert.deepEqual(U.PROVINCES, extras.PROVINCES);
  assert.deepEqual(U.WORK_AUTH, extras.WORK_AUTHORIZATION_STATUSES);
  assert.deepEqual(U.BANDS, Object.keys(BAND_LABELS));
  assert.deepEqual(U.CLASSES, classification.CLASSES);
  assert.deepEqual(U.SUPPRESSION_KINDS, suppression.KINDS);
  assert.deepEqual(U.SUPPRESSION_SOURCES, suppression.SOURCES);
  assert.deepEqual(U.LEGAL_STATUSES, legalReviews.STATUSES);
  assert.deepEqual(U.CONTRACT_STATUSES, contracts.STATUSES);
  assert.deepEqual(U.REPORT_LANGS, reportExport.LANGS);
  assert.deepEqual(U.REPORT_FORMATS, reportExport.FORMATS);
  assert.deepEqual(U.BILLING_REASONS.slice().sort(), ["candidate_fee_prohibited", "jurisdiction_unknown", "legal_review_required", "service_contract_required"]);
  for (const r of U.BILLING_REASONS) assert.ok(r in billingGate.MESSAGES, r);
  assert.deepEqual(U.PROVINCES.length, 13);
});

// ---------------------------------------------------------------- i18n

test("i18n: canada.* keys exist in ar/en/fr with identical placeholders, non-empty, translated (not copies of en)", () => {
  assert.ok(canadaKeys.length >= 120, `canada keys: ${canadaKeys.length}`);
  const { ar, fr } = I18N.dictionaries;
  const extra = ["tab.suppressions", "fin.svc.kind", "fin.svc.kindHint", "fin.svc.kind.standard", "fin.svc.kind.candidate_fee"].filter((k) => k in en);
  for (const k of [...canadaKeys, ...extra]) {
    for (const [name, d] of [["ar", ar], ["fr", fr]]) {
      assert.equal(typeof d[k], "string", `${name}.${k}`);
      assert.ok(d[k].trim().length > 0, `${name}.${k} empty`);
      assert.equal(ph(d[k]), ph(en[k]), `${name}.${k} placeholders`);
    }
  }
  for (const k of ["canada.cv.title", "canada.cv.generate", "canada.supp.tab", "canada.portal.step", "canada.billing.title", "canada.band.strong", "canada.legal.notice"]) assert.match(ar[k], /[؀-ۿ]/, k);
  for (const k of ["canada.cv.title", "canada.cv.generate", "canada.billing.title", "canada.portal.step", "canada.legal.notice"]) assert.notEqual(fr[k], en[k], k);
  // the three dictionaries keep identical key sets (the repo-wide rule)
  assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
});

test("required wording: legal notice, candidate consent sentence, Arabic-report note, billing reason for a missing legal review", () => {
  assert.equal(en["canada.legal.notice"], "The platform records reviews; it does not give legal advice.");
  assert.equal(en["canada.portal.cv.consent"], "I confirm the content is accurate and I authorise VITA to send this CV to employers for suitable vacancies.");
  assert.match(en["canada.report.arNote"], /Arabic PDF uses English labels/);
  assert.equal(en["canada.billing.reason.legal_review_required"], "Billing disabled — a legal review for {jurisdiction} is required.");
  assert.match(en["canada.billing.reason.service_contract_required"], /contract/i);
  assert.match(en["canada.billing.reason.candidate_fee_prohibited"], /prohibited/i);
  // none of the new wording promises a job, a permit or a visa
  for (const k of canadaKeys) assert.doesNotMatch(en[k], /guaranteed (?:job|visa|permit|employment)|will (?:get|find) you a job/i, k);
  assert.match(en["canada.cv.latinNote"], /Latin/);
});

// ---------------------------------------------------------------- permission mirror

test("canada-util permission mirror equals the server table for every staff role and every permission it uses", () => {
  const perms = ["candidates:read", "candidates:write", "users:write", "finance:read", "finance:write", "finance:void", "finance:refund", "jobsearch:read", "jobsearch:write", "jobsearch:approve", "jobsearch:admin"];
  for (const role of STAFF_ROLES) {
    for (const perm of perms) {
      const serverPerms = PERMISSIONS[role];
      assert.equal(U.can(role, perm), serverPerms.includes("*") || serverPerms.includes(perm), `${role} ${perm}`);
    }
  }
  for (const role of ["Candidate", "Employer", "Agency", undefined, "Nobody"]) assert.equal(U.can(role, "jobsearch:read"), false, String(role));
  assert.equal(U.can("Admin", "bogus"), false);
});

test("derived capabilities: Agent sees the editing controls but not approve / admin controls; only Admin legal reviews; Accountant has finance only", () => {
  assert.equal(U.canEditCanadaProfile("Agent"), true);
  assert.equal(U.canEditCanadaProfile("HR"), false);
  assert.equal(U.canEditCanadaProfile("Accountant"), false);
  assert.equal(U.canGenerateCv("Agent"), true);
  assert.equal(U.canApproveCv("Agent"), false);
  assert.equal(U.canApproveCv("Receptionist"), false);
  assert.equal(U.canApproveCv("Manager"), true);
  assert.equal(U.canDecideMatch("Agent"), false);
  assert.equal(U.canDecideMatch("Manager"), true);
  assert.equal(U.canClassify("Agent"), true);
  assert.equal(U.canEditEmployer("Manager"), false);
  assert.equal(U.canEditEmployer("Admin"), true);
  assert.equal(U.canAddSuppression("Agent"), true);
  assert.equal(U.canRemoveSuppression("Manager"), false);
  assert.equal(U.canRemoveSuppression("SuperAdmin"), true);
  assert.equal(U.canSetMatchSetting("Manager"), false);
  assert.equal(U.canSeeBilling("Agent"), false);
  assert.equal(U.canSeeBilling("Manager"), true);
  assert.equal(U.canWriteContracts("Manager"), false);
  assert.equal(U.canWriteContracts("Admin"), true);
  assert.equal(U.canEndContracts("Admin"), true);
  assert.equal(U.canRecordLegalReview("Admin"), true);
  assert.equal(U.canRecordLegalReview("Accountant"), false);
  assert.equal(U.canRecordLegalReview("Manager"), false);
  assert.equal(U.canSetServiceKind("Accountant"), false);
});

test("the existing CRM and finance permission mirrors are unchanged", () => {
  assert.equal(CRM.can("Manager", "leads:write"), true);
  assert.equal(CRM.can("Agent", "leads:write"), false);
  assert.equal(CRM.can("Admin", "users:write"), true);
  assert.equal(CRM.canAssign("Manager"), false);
  assert.equal(FIN.canWrite("Accountant"), true);
  assert.equal(FIN.canRead("Agent"), false);
  assert.deepEqual(CRM.STAGES.length, 7);
  assert.equal(CRM.can("Admin", "jobsearch:admin"), false, "the CRM mirror is not extended; canada-util carries its own table");
});

// ---------------------------------------------------------------- pure helpers

test("band labels: key, class and unknown handling for the four bands", () => {
  assert.equal(U.bandKey("strong"), "canada.band.strong");
  assert.equal(U.bandKey("good"), "canada.band.good");
  assert.equal(U.bandKey("manual_review"), "canada.band.manual_review");
  assert.equal(U.bandKey("not_recommended"), "canada.band.not_recommended");
  assert.equal(U.bandKey(null), "canada.band.unknown");
  assert.equal(U.bandKey("<img>"), "canada.band.unknown");
  assert.deepEqual(U.BANDS.map(U.bandClass), ["ok", "info", "warn", "bad"]);
  assert.equal(U.bandClass(undefined), "neutral");
  const labels = { strong: "Strong", good: "Good", manual_review: "Manual review", not_recommended: "Not recommended" };
  for (const b of U.BANDS) assert.equal(en[U.bandKey(b)], labels[b], b);
  assert.deepEqual(U.DECISIONS.map(U.decisionKey), ["canada.decision.pending", "canada.decision.accepted", "canada.decision.rejected"]);
  assert.equal(U.decisionKey("bogus"), "canada.decision.pending");
  assert.equal(U.decisionClass("accepted"), "ok");
  assert.equal(U.decisionClass("rejected"), "bad");
});

test("classification labels: one key and class per class, unknown -> unclassified", () => {
  for (const c of U.CLASSES) assert.equal(U.classificationKey(c), `canada.class.${c}`);
  assert.equal(U.classificationKey(null), "canada.class.unclassified");
  assert.equal(U.classificationKey("made_up"), "canada.class.unclassified");
  assert.equal(U.classificationClass("verified_active"), "ok");
  assert.equal(U.classificationClass("work_authorization_required"), "bad");
  assert.equal(U.classificationClass("eligibility_unclear"), "warn");
  assert.equal(U.classificationClass(undefined), "neutral");
  assert.equal(en["canada.class.foreign_applicants_stated"], "Foreign applicants stated");
});

test("reference display: only a CAN-YYYY-NNNN reference is shown, never a made-up value", () => {
  assert.equal(U.referenceDisplay("CAN-2026-0001"), "CAN-2026-0001");
  assert.equal(U.referenceDisplay("  CAN-2026-12345 "), "CAN-2026-12345");
  for (const bad of [null, undefined, "", "can-2026-0001", "CAN-26-0001", "CAN-2026-1", "CAN-2026-0001<script>", "REF-1", 5, {}]) assert.equal(U.referenceDisplay(bad), "", String(bad));
});

test("file name display: canonical names pass, anything else falls back (no path, no injection)", () => {
  assert.equal(U.filenameDisplay("CAN-2026-0001-CV-V2.pdf"), "CAN-2026-0001-CV-V2.pdf");
  assert.equal(U.filenameDisplay("activity-CAN-2026-0001-2026-10-01_2026-10-31.xlsx"), "activity-CAN-2026-0001-2026-10-01_2026-10-31.xlsx");
  for (const bad of ["../../etc/passwd", "a b.pdf", 'x".pdf', "<b>.pdf", "", null, undefined, "é.pdf", "a".repeat(121)]) assert.equal(U.filenameDisplay(bad, "fallback.bin"), "fallback.bin", String(bad));
  assert.equal(U.filenameDisplay("../x"), "download");
  assert.equal(U.formatLabel({ format: "pdf" }), "PDF");
  assert.equal(U.formatLabel({ format: "docx" }), "DOCX");
  assert.equal(U.formatLabel({ name: "CAN-2026-0001-CV-V1.docx" }), "DOCX");
  assert.equal(U.formatLabel({ format: "exe", name: "x.exe" }), "");
  assert.equal(U.formatLabel(null), "");
});

test("CV status chips: draft / approved / authorised / withdrawn, plus stale; stale never hides a withdrawal", () => {
  const keys = (v) => U.cvStatusChips(v).map((c) => c.key);
  assert.deepEqual(keys({ status: "draft" }), ["canada.cv.status.draft"]);
  assert.deepEqual(keys({ status: "staff_approved" }), ["canada.cv.status.approved"]);
  assert.deepEqual(keys({ status: "authorised" }), ["canada.cv.status.authorised"]);
  assert.deepEqual(keys({ status: "withdrawn" }), ["canada.cv.status.withdrawn"]);
  assert.deepEqual(keys({ status: "authorised", stale: true }), ["canada.cv.status.authorised", "canada.cv.status.stale"]);
  assert.deepEqual(keys({ status: "withdrawn", stale: true }), ["canada.cv.status.withdrawn"]);
  assert.deepEqual(keys({ status: "weird" }), ["canada.cv.status.draft"]);
  assert.deepEqual(U.cvStatusChips({ status: "authorised" })[0], { key: "canada.cv.status.authorised", cls: "ok" });
  assert.equal(U.canApproveVersion({ status: "draft", stale: false }), true);
  assert.equal(U.canApproveVersion({ status: "draft", stale: true }), false, "the server refuses a stale version");
  assert.equal(U.canApproveVersion({ status: "staff_approved" }), false);
});

test("CV missing flags become readable chips (latin spelling, sensitive exclusions, dated entries, plain sections); unknown codes are humanised", () => {
  assert.deepEqual(U.missingFlag("latin_spelling_needed:name"), { key: "canada.missing.latin_spelling_needed", vars: { path: "name" } });
  assert.deepEqual(U.missingFlag("latin_spelling_needed:experience[0].title"), { key: "canada.missing.latin_spelling_needed", vars: { path: "experience[0].title" } });
  assert.deepEqual(U.missingFlag("dates:experience[2]"), { key: "canada.missing.dates", vars: { n: 3 } });
  assert.deepEqual(U.missingFlag("excluded_sensitive:skills"), { key: "canada.missing.excluded_sensitive", vars: { section: "skills", sectionKey: "canada.section.skills" } });
  assert.equal(U.missingFlag("excluded_sensitive:weird").vars.sectionKey, null);
  for (const c of ["professional_summary", "experience", "skills", "education", "certifications", "languages", "contact.location", "contact.email", "contact.phone"]) assert.deepEqual(U.missingFlag(c), { key: `canada.missing.${c}`, vars: {} }, c);
  assert.deepEqual(U.missingFlag("brand_new_flag"), { key: null, vars: { text: "brand new flag" } });
  assert.deepEqual(U.missingFlag(""), { key: null, vars: { text: "—" } });
  assert.deepEqual(U.missingFlag("<script>alert(1)</script>"), { key: null, vars: { text: "<script>alert(1)</script>" } });
  assert.equal(U.needsLatinSpelling(["skills", "latin_spelling_needed:name"]), true);
  assert.equal(U.needsLatinSpelling(["skills"]), false);
  assert.equal(U.needsLatinSpelling(null), false);
  // every flag the generator can produce has a key
  const gen = require("../modules/jobsearch/cvGenerator");
  const model = gen.buildCvModel({ name: "A B", experience: [{ title: "T", employer: "E" }] }, {}, { now: new Date("2026-10-31T00:00:00Z") });
  for (const f of model.missing) {
    const m = U.missingFlag(f);
    if (m.key) for (const l of LANGS) assert.ok(m.key in I18N.dictionaries[l], `${l}:${m.key} (${f})`);
    else assert.fail(`no readable key for generator flag ${f}`);
  }
});

test("billing messages: plain words per reason, jurisdiction filled in, billable only with no reasons", () => {
  const blocked = U.billingSummary({ candidate_fee_billable: false, reasons: ["legal_review_required", "service_contract_required"], jurisdiction: "CA-ON" });
  assert.equal(blocked.billable, false);
  assert.deepEqual(blocked.items.map((i) => i.key), ["canada.billing.reason.legal_review_required", "canada.billing.reason.service_contract_required"]);
  assert.equal(blocked.items[0].vars.jurisdiction, "CA-ON");
  const msg = en[blocked.items[0].key].replace("{jurisdiction}", blocked.items[0].vars.jurisdiction);
  assert.equal(msg, "Billing disabled — a legal review for CA-ON is required.");
  assert.equal(U.billingSummary({ candidate_fee_billable: true, reasons: [], jurisdiction: "CA-ON" }).billable, true);
  // a payload claiming billable but listing a reason is NOT billable; unknown reasons stay visible
  assert.equal(U.billingSummary({ candidate_fee_billable: true, reasons: ["legal_review_required"] }).billable, false);
  assert.equal(U.billingSummary({ candidate_fee_billable: false, reasons: ["something_new"] }).items[0].key, "canada.billing.reason.unknown");
  assert.equal(U.billingSummary(null).billable, false);
  assert.equal(U.billingSummary({ reasons: [] }).billable, false, "billable must be an explicit true");
  assert.equal(U.billingSummary({ candidate_fee_billable: false, reasons: ["jurisdiction_unknown"] }).items[0].vars.jurisdiction, "—");
  for (const r of ["jurisdiction_unknown", "candidate_fee_use_catalogue", "legal_review_required", "service_contract_required", "candidate_fee_prohibited"]) {
    assert.equal(U.isBillingCode(r), true, r);
    assert.ok(`err.code.${r}` in en, `err.code.${r}`);
  }
  assert.equal(U.isBillingCode("nope"), false);
  for (const c of U.OUTREACH_CODES) assert.ok(`err.code.${c}` in en, `err.code.${c}`);
});

test("profile patch: only changed values, normalised, candidate limited to four fields, bad input named", () => {
  const base = { city: "Tunis", whatsapp: "+21620111222", work_authorization_status: "none", relocation_ready: null, desired_province: null, service_start_date: null };
  const form = { city: " Sfax  City ", whatsapp: "+216 20 111 222", relocation_ready: "true", desired_province: "on", work_authorization_status: "study_permit", service_start_date: "2026-11-15" };
  assert.deepEqual(U.profilePatch(form, base), { ok: true, patch: { city: "Sfax City", relocation_ready: true, desired_province: "ON", work_authorization_status: "study_permit", service_start_date: "2026-11-15" } });
  assert.deepEqual(U.profilePatch(form, base, { candidate: true }), { ok: true, patch: { city: "Sfax City", relocation_ready: true } }, "a candidate never sends the province, work authorization or the start date");
  assert.deepEqual(U.profilePatch({ city: "Tunis", whatsapp: "+216 20 111 222", relocation_ready: "", desired_province: "", work_authorization_status: "none", service_start_date: "" }, base), { ok: false, error: "nothing" });
  assert.deepEqual(U.profilePatch({ ...form, city: "x".repeat(121) }, base), { ok: false, error: "city" });
  assert.deepEqual(U.profilePatch({ ...form, whatsapp: "call me" }, base), { ok: false, error: "whatsapp" });
  assert.deepEqual(U.profilePatch({ ...form, whatsapp: "+1234" }, base), { ok: false, error: "whatsapp" });
  assert.deepEqual(U.profilePatch({ ...form, desired_province: "ZZ" }, base), { ok: false, error: "desired_province" });
  assert.deepEqual(U.profilePatch({ ...form, work_authorization_status: "tourist" }, base), { ok: false, error: "work_authorization_status" });
  assert.deepEqual(U.profilePatch({ ...form, service_start_date: "2026-02-30" }, base), { ok: false, error: "service_start_date" });
  assert.deepEqual(U.profilePatch({ ...form, relocation_ready: "maybe" }, base), { ok: false, error: "relocation_ready" });
  // clearing a value sends null
  assert.deepEqual(U.profilePatch({ ...form, city: "", whatsapp: "" , relocation_ready: "", desired_province: "", work_authorization_status: "", service_start_date: "" }, { ...base, desired_province: "QC", service_start_date: "2026-01-01" }).patch, { city: null, whatsapp: null, work_authorization_status: null, desired_province: null, service_start_date: null });
  // every value the client sends passes the server's own validator
  const ok = U.profilePatch(form, base);
  assert.doesNotThrow(() => extras.validatePatch(ok.patch));
  assert.throws(() => extras.validatePatch({ desired_province: "ZZ" }));
});

test("classification override payload: quote required for foreign_applicants_stated, note for prospective / closed, clearing sends null", () => {
  assert.deepEqual(U.classificationPayload({ classification: "foreign_applicants_stated", evidence: "We welcome international applicants" }), { ok: true, payload: { classification: "foreign_applicants_stated", evidence: "We welcome international applicants" } });
  assert.deepEqual(U.classificationPayload({ classification: "foreign_applicants_stated", evidence: "short" }), { ok: false, error: "evidence" });
  assert.deepEqual(U.classificationPayload({ classification: "foreign_applicants_stated", evidence: "   " }), { ok: false, error: "evidence" });
  assert.deepEqual(U.classificationPayload({ classification: "closed_unsuitable", note: "" }), { ok: false, error: "note" });
  assert.deepEqual(U.classificationPayload({ classification: "prospective_no_vacancy", note: "Talent pool page" }), { ok: true, payload: { classification: "prospective_no_vacancy", note: "Talent pool page" } });
  assert.deepEqual(U.classificationPayload({ classification: "", evidence: "ignored text here" }), { ok: true, payload: { classification: null } });
  assert.deepEqual(U.classificationPayload({ classification: "verified_active" }), { ok: true, payload: { classification: "verified_active" } });
  assert.deepEqual(U.classificationPayload({ classification: "made_up" }), { ok: false, error: "classification" });
  assert.deepEqual(U.classificationPayload({ classification: "foreign_applicants_stated", evidence: "x".repeat(501) }), { ok: false, error: "evidence_long" });
  assert.equal(U.evidenceRequired("foreign_applicants_stated"), true);
  assert.equal(U.evidenceRequired("verified_active"), false);
  assert.equal(U.noteRequired("closed_unsuitable"), true);
  // live verbatim check (same rule as the server: case and white-space insensitive, at least 8 characters)
  const ad = "We are hiring.\nWe welcome   International applicants\nand offer visa support.";
  assert.equal(U.evidenceHint("we welcome international APPLICANTS and offer visa", ad), "found");
  assert.equal(U.evidenceHint("We sponsor everybody", ad), "not_found");
  assert.equal(U.evidenceHint("short", ad), "short");
  assert.equal(U.evidenceHint("We welcome international applicants", ""), "no_text");
  assert.equal(U.evidenceOccursIn("We welcome international applicants", ad), true);
  assert.equal(classification.evidenceOccursIn("We welcome international applicants", ad), true, "agrees with the server rule");
  assert.equal(classification.evidenceOccursIn("We sponsor everybody", ad), U.evidenceOccursIn("We sponsor everybody", ad));
});

test("employer source URLs: http/https only, no credentials, de-duplicated; patch carries only changes", () => {
  assert.equal(U.safeHttpUrl("https://www.example.ca/careers?a=1"), "https://www.example.ca/careers?a=1");
  assert.equal(U.safeHttpUrl("http://example.ca"), "http://example.ca/");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://example.ca", "//example.ca", "https://u:p@example.ca", "https://exa mple.ca", "", null, undefined, "https://", "x".repeat(600)]) assert.equal(U.safeHttpUrl(bad), "", String(bad));
  assert.deepEqual(U.safeUrls(["https://a.example/", "javascript:1", "http://b.example/x", 5]), ["https://a.example/", "http://b.example/x"]);
  assert.deepEqual(U.parseUrlLines("https://a.example/x\n\n https://a.example/x \nhttp://b.example/"), { ok: true, urls: ["https://a.example/x", "http://b.example/"] });
  assert.deepEqual(U.parseUrlLines("https://a.example/x\nnot a url"), { ok: false, error: "url", line: 2 });
  assert.deepEqual(U.parseUrlLines(Array.from({ length: 21 }, (_x, i) => `https://a.example/${i}`).join("\n")), { ok: false, error: "many" });
  const base = { province: "ON", city: "Toronto", industry: "Construction", phone: null, recruiterContactName: null, sourceUrls: ["https://a.example/"], eligibilityNote: null, status: "new", notes: null };
  const same = { province: "ON", city: "Toronto", industry: "Construction", phone: "", recruiterContactName: "", sourceUrls: "https://a.example/", eligibilityNote: "", status: "new", notes: "" };
  assert.deepEqual(U.employerPatch(same, base), { ok: false, error: "nothing" });
  assert.deepEqual(U.employerPatch({ ...same, status: "verified", city: " Ottawa ", phone: "+1 (613) 555-0100", sourceUrls: "https://a.example/\nhttps://b.example/" }, base), { ok: true, patch: { city: "Ottawa", phone: "+1 (613) 555-0100", status: "verified", sourceUrls: ["https://a.example/", "https://b.example/"] } });
  assert.deepEqual(U.employerPatch({ ...same, province: "ZZ" }, base), { ok: false, error: "province" });
  assert.deepEqual(U.employerPatch({ ...same, status: "gone" }, base), { ok: false, error: "status" });
  assert.deepEqual(U.employerPatch({ ...same, phone: "abc" }, base), { ok: false, error: "phone" });
  assert.deepEqual(U.employerPatch({ ...same, sourceUrls: "javascript:alert(1)" }, base), { ok: false, error: "sourceUrls", line: 1 });
  assert.deepEqual(U.employerPatch({ ...same, notes: "n".repeat(4001) }, base), { ok: false, error: "notes" });
  assert.deepEqual(U.employerPatch({ ...same, province: "" }, base).patch, { province: null });
  assert.deepEqual(U.historySummary({ totals: { applications: 3, sent: 2, replies: 1, lastContactAt: "2026-10-01T00:00:00Z" }, contactedByOtherCandidates: 4 }), { applications: 3, sent: 2, replies: 1, lastContactAt: "2026-10-01T00:00:00Z", others: 4 });
  assert.deepEqual(U.historySummary({ employerId: 9, applications: 2, sent: 1, replies: 0, lastContactAt: null, contactedByOtherCandidates: 1 }), { applications: 2, sent: 1, replies: 0, lastContactAt: null, others: 1 }, "flat package summary");
  assert.deepEqual(U.historySummary(null), { applications: 0, sent: 0, replies: 0, lastContactAt: null, others: 0 });
});

test("suppression helpers: add payload, mandatory removal reason, list query", () => {
  assert.deepEqual(U.suppressionPayload({ kind: "email", value: " HR@Acme.example ", reason: "asked to stop" }), { ok: true, payload: { kind: "email", value: "HR@Acme.example", reason: "asked to stop" } });
  assert.deepEqual(U.suppressionPayload({ kind: "domain", value: "acme.example" }), { ok: true, payload: { kind: "domain", value: "acme.example" } });
  assert.deepEqual(U.suppressionPayload({ kind: "domain", value: "a@acme.example" }), { ok: false, error: "domain" });
  assert.deepEqual(U.suppressionPayload({ kind: "email", value: "nope" }), { ok: false, error: "email" });
  assert.deepEqual(U.suppressionPayload({ kind: "other", value: "x@y.example" }), { ok: false, error: "kind" });
  assert.deepEqual(U.suppressionPayload({ kind: "email", value: "" }), { ok: false, error: "value" });
  assert.deepEqual(U.suppressionPayload({ kind: "email", value: "a@b.example", reason: "r".repeat(501) }), { ok: false, error: "reason_long" });
  assert.deepEqual(U.suppressionRemovalReason("  "), { ok: false, error: "short" });
  assert.deepEqual(U.suppressionRemovalReason("ab"), { ok: false, error: "short" });
  assert.deepEqual(U.suppressionRemovalReason("Employer asked to be re-added"), { ok: true, reason: "Employer asked to be re-added" });
  assert.deepEqual(U.suppressionRemovalReason("x".repeat(501)), { ok: false, error: "long" });
  assert.equal(U.suppressionQuery({ kind: "email", source: "bounce", q: " Acme " }, 2, 25), "?kind=email&source=bounce&q=Acme&page=2&pageSize=25");
  assert.equal(U.suppressionQuery({ kind: "bogus" }, 0, 1000), "?page=1&pageSize=100");
});

test("report helpers: ranges, presets, query building, Arabic note", () => {
  assert.deepEqual(U.rangeQuery("", ""), { ok: true, query: {} });
  assert.deepEqual(U.rangeQuery("2026-10-01", "2026-10-31"), { ok: true, query: { from: "2026-10-01", to: "2026-10-31" } });
  assert.deepEqual(U.rangeQuery("2026-10-31", "2026-10-01"), { ok: false, error: "order" });
  assert.deepEqual(U.rangeQuery("2026-13-01", ""), { ok: false, error: "from" });
  assert.deepEqual(U.rangeQuery("", "garbage"), { ok: false, error: "to" });
  assert.deepEqual(U.rangeQuery("2025-01-01", "2026-12-31"), { ok: false, error: "long" });
  assert.equal(U.rangeQuery("2025-10-30", "2026-10-31").ok, false, "367 days");
  assert.equal(U.rangeQuery("2025-10-31", "2026-10-31").ok, true, "366 days is the server maximum");
  assert.equal(U.rangeQuery("2025-11-01", "2026-10-31").ok, true, "365 days");
  assert.deepEqual(U.presetRange("daily", "2026-10-31"), { from: "2026-10-31", to: "2026-10-31", period: "day" });
  assert.deepEqual(U.presetRange("weekly", "2026-10-31"), { from: "2026-10-25", to: "2026-10-31", period: "week" });
  assert.deepEqual(U.presetRange("monthly", "2026-10-31"), { from: "2026-10-02", to: "2026-10-31", period: "month" });
  assert.equal(U.presetRange("custom", "2026-10-31"), null);
  assert.equal(U.presetRange("daily", "nope"), null);
  assert.equal(U.addDays("2026-03-01", -1), "2026-02-28");
  assert.deepEqual(U.reportQuery({ format: "xlsx", from: "2026-10-01", to: "2026-10-31", lang: "fr" }), { ok: true, query: { format: "xlsx", from: "2026-10-01", to: "2026-10-31", lang: "fr" } });
  assert.deepEqual(U.reportQuery({ format: "weird" }), { ok: true, query: { format: "pdf" } });
  assert.deepEqual(U.reportQuery({ format: "pdf", lang: "de" }), { ok: false, error: "lang" });
  assert.deepEqual(U.reportQuery({ format: "pdf", from: "x" }), { ok: false, error: "from" });
  assert.equal(U.reportLangNoteKey("ar"), "canada.report.arNote");
  assert.equal(U.reportLangNoteKey("en"), null);
  assert.deepEqual(U.reportSettingsPatch({ timezone: "America/Toronto", schedule: true }, { report_timezone: "Africa/Tunis", report_schedule_enabled: false }), { ok: true, patch: { report_timezone: "America/Toronto", report_schedule_enabled: true } });
  assert.deepEqual(U.reportSettingsPatch({ timezone: "Africa/Tunis", schedule: false }, { report_timezone: "Africa/Tunis", report_schedule_enabled: false }), { ok: false, error: "nothing" });
  assert.deepEqual(U.reportSettingsPatch({ timezone: "bad zone!", schedule: false }, {}), { ok: false, error: "timezone" });
});

test("legal review + contract payloads: required fields, dates, no future review, contract actions follow the role", () => {
  const good = { jurisdiction: "ca-on", status: "approved", reviewer_name: "Maître Tremblay", reviewer_role: "Immigration lawyer", reviewed_at: "2026-10-30", valid_until: "2027-10-30", note: "Opinion on file" };
  assert.deepEqual(U.legalReviewPayload(good, "2026-10-31"), { ok: true, payload: { jurisdiction: "CA-ON", service_kind: "candidate_fee", status: "approved", reviewer_name: "Maître Tremblay", reviewer_role: "Immigration lawyer", reviewed_at: "2026-10-30", valid_until: "2027-10-30", note: "Opinion on file" } });
  assert.deepEqual(U.legalReviewPayload({ ...good, jurisdiction: "Ontario" }, "2026-10-31"), { ok: false, error: "jurisdiction" });
  assert.deepEqual(U.legalReviewPayload({ ...good, status: "maybe" }, "2026-10-31"), { ok: false, error: "status" });
  assert.deepEqual(U.legalReviewPayload({ ...good, reviewer_name: " " }, "2026-10-31"), { ok: false, error: "reviewer_name" });
  assert.deepEqual(U.legalReviewPayload({ ...good, reviewed_at: "2026-11-01" }, "2026-10-31"), { ok: false, error: "reviewed_future" });
  assert.deepEqual(U.legalReviewPayload({ ...good, reviewed_at: "" }, "2026-10-31"), { ok: false, error: "reviewed_at" });
  assert.deepEqual(U.legalReviewPayload({ ...good, valid_until: "2026-01-01" }, "2026-10-31"), { ok: false, error: "valid_order" });
  assert.deepEqual(U.legalReviewPayload({ ...good, valid_until: "", reviewer_role: "", note: "" }, "2026-10-31").payload, { jurisdiction: "CA-ON", service_kind: "candidate_fee", status: "approved", reviewer_name: "Maître Tremblay", reviewed_at: "2026-10-30" });
  assert.equal(U.defaultJurisdiction("ON", null), "CA-ON");
  assert.equal(U.defaultJurisdiction(null, "CA-QC"), "CA-QC");
  assert.equal(U.defaultJurisdiction(null, null), "");
  // the server accepts what the client builds
  assert.doesNotThrow(() => { const p = U.legalReviewPayload(good, "2026-10-31").payload; assert.match(p.jurisdiction, billingGate.JURISDICTION_RE); });
  assert.deepEqual(U.contractActions({ status: "draft" }, "Admin"), { sign: true, end: false, cancel: true });
  assert.deepEqual(U.contractActions({ status: "active" }, "Admin"), { sign: false, end: true, cancel: true });
  assert.deepEqual(U.contractActions({ status: "active" }, "Manager"), { sign: false, end: false, cancel: false });
  assert.deepEqual(U.contractActions({ status: "ended" }, "Admin"), { sign: false, end: false, cancel: false });
  assert.deepEqual(U.contractCreatePayload({ candidate_id: "5", service_id: 2, start_date: "2026-11-01", end_date: "2027-11-01", refund_terms: " Pro rata " }), { ok: true, payload: { candidate_id: 5, service_id: 2, start_date: "2026-11-01", end_date: "2027-11-01", refund_terms: "Pro rata" } });
  assert.deepEqual(U.contractCreatePayload({ candidate_id: 5, service_id: "" }), { ok: false, error: "service" });
  assert.deepEqual(U.contractCreatePayload({ candidate_id: 5, service_id: 2, start_date: "2026-11-01", end_date: "2026-10-01" }), { ok: false, error: "date_order" });
  assert.deepEqual(U.contractSignPayload({ signed_by_name: "  " }), { ok: false, error: "signed_by_name" });
  assert.deepEqual(U.contractSignPayload({ signed_by_name: "Karim Benali" }), { ok: true, payload: { signed_by_name: "Karim Benali" } });
  assert.deepEqual(U.contractSignPayload({ signed_by_name: "Karim Benali", jurisdiction: " ca-qc " }), { ok: true, payload: { signed_by_name: "Karim Benali", jurisdiction: "CA-QC" } });
  assert.deepEqual(U.contractSignPayload({ signed_by_name: "Karim Benali", jurisdiction: "Quebec" }), { ok: false, error: "jurisdiction" });
});

test("outreach blockers: only the three stage-8 codes are picked out of a package or auto-approval list", () => {
  assert.deepEqual(U.outreachBlockers([{ code: "recipient_suppressed", detail: "listed" }, { code: "package_blocked" }, "employer_opted_out", { code: "outreach_basis_not_permitted" }, null]),
    [{ code: "recipient_suppressed", detail: "listed" }, { code: "employer_opted_out", detail: "" }, { code: "outreach_basis_not_permitted", detail: "" }]);
  assert.deepEqual(U.outreachBlockers(undefined), []);
});

test("finance service kind: the service payload carries kind only when it is given (existing payloads are unchanged)", () => {
  const base = { code: "PKG-A", name_en: "Package A", default_price: "250.00", currency: "EUR" };
  const plain = FIN.servicePayload({ ...base }, { creating: true });
  assert.equal(plain.ok, true);
  assert.ok(!("kind" in plain.payload), "no kind unless the form sends one");
  assert.equal(FIN.servicePayload({ ...base, kind: "candidate_fee" }, { creating: true }).payload.kind, "candidate_fee");
  assert.equal(FIN.servicePayload({ ...base, kind: "bogus" }, { creating: true }).ok, false);
  const upd = FIN.servicePayload({ ...base, kind: "candidate_fee" }, { creating: false, base: { ...base, default_price: "250.00", kind: "standard" } });
  assert.deepEqual(upd, { ok: true, payload: { kind: "candidate_fee" } });
  assert.equal(FIN.servicePayload({ ...base }, { creating: false, base: { ...base, kind: "candidate_fee" } }).ok, false, "an untouched kind is not a change");
  assert.match(read("fin-services.js"), /fin\.svc\.kind/);
});

test("the legal-review dialog states that the platform records reviews and gives no legal advice; billing panel never offers a way around the gate", () => {
  const src = read("canada-billing.js");
  assert.match(src, /canada\.legal\.notice/);
  assert.match(src, /\/finance\/billing-status/);
  assert.match(src, /\/finance\/legal-reviews/);
  assert.match(src, /\/finance\/contracts/);
  assert.doesNotMatch(src, /\/finance\/invoices/, "invoices are created in the Accounting tab, where the gate applies");
  assert.match(read("canada-candidate.js"), /canada\.cv\.latinNote/);
});
