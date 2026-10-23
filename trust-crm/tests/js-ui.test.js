// Task 15: VITA web UI (static admin console + candidate portal at /vita/).
// Real app over HTTP + static scans of public/vita (no build step, strict CSP, no HTML injection sinks).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "js-ui-test-secret";

const VITA = path.join(__dirname, "..", "public", "vita");
const I18N = require("../public/vita/i18n.js");

const TITLE = "البحث الآلي عن عمل / AI Job Search & Applications";
const DISCLAIMER = {
  en: "This service helps you search and apply for job opportunities. It does not guarantee employment, employer sponsorship, a work permit or a visa.",
  ar: "تساعدك هذه الخدمة على البحث عن فرص العمل والتقديم إليها. وهي لا تضمن الحصول على عمل أو كفالة صاحب العمل أو تصريح عمل أو تأشيرة.",
  fr: "Ce service vous aide à rechercher des offres d'emploi et à y postuler. Il ne garantit ni un emploi, ni un parrainage de l'employeur, ni un permis de travail, ni un visa.",
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const read = (f) => fs.readFileSync(path.join(VITA, f), "utf8");
const files = (ext) => fs.readdirSync(VITA).filter((f) => f.endsWith(ext));

async function withServer(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ pool, base });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

// ---------------------------------------------------------------- i18n

test("i18n: ar/en/fr have identical key sets and no empty strings", () => {
  const { dictionaries } = I18N;
  assert.deepEqual(Object.keys(dictionaries).sort(), ["ar", "en", "fr"]);
  const en = Object.keys(dictionaries.en).sort();
  assert.ok(en.length > 100, "expected a real dictionary");
  for (const lang of ["ar", "fr"]) assert.deepEqual(Object.keys(dictionaries[lang]).sort(), en, `${lang} keys differ from en`);
  for (const [lang, dict] of Object.entries(dictionaries)) {
    for (const [k, v] of Object.entries(dict)) {
      assert.equal(typeof v, "string", `${lang}.${k} is not a string`);
      assert.ok(v.trim().length > 0, `${lang}.${k} is empty`);
    }
  }
  assert.equal(I18N.dirFor("ar"), "rtl");
  assert.equal(I18N.dirFor("en"), "ltr");
  assert.equal(I18N.dirFor("fr"), "ltr");
});

test("i18n: disclaimer exact in all three languages; section title constant", () => {
  for (const lang of ["en", "ar", "fr"]) assert.equal(I18N.dictionaries[lang].disclaimer, DISCLAIMER[lang], lang);
  assert.equal(I18N.SECTION_TITLE, TITLE);
});

test("i18n: every key referenced by the pages and scripts exists", () => {
  const used = new Set();
  for (const f of files(".html")) {
    for (const m of read(f).matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) used.add(m[1]);
  }
  for (const f of files(".js")) {
    if (f === "i18n.js") continue;
    for (const m of read(f).matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"\s*[,)]/g)) used.add(m[1]);
  }
  assert.ok(used.size > 50);
  const missing = [...used].filter((k) => !(k in I18N.dictionaries.en));
  assert.deepEqual(missing, [], `missing i18n keys: ${missing.join(", ")}`);
});

test("i18n: keys built at runtime (statuses, labels, sources, errors...) all exist", () => {
  const en = I18N.dictionaries.en;
  const { STATUSES } = require("../modules/jobsearch/applicationService");
  const families = {
    status: STATUSES,
    label: ["confirmed", "stated_in_ad", "unknown", "unavailable"],
    overseas: ["yes", "no", "unknown"],
    live: ["live", "reconnecting", "off"],
    mode: ["search_only", "prepare_for_approval", "automatic"],
    modeHelp: ["search_only", "prepare_for_approval", "automatic"],
    srcStatus: ["connected", "requires_setup", "unavailable", "manual"],
    elig: ["candidate_deleted", "profile_not_confirmed", "no_search_consent", "candidate_paused", "module_paused", "account_inactive"],
    rsrc: ["opts", "verified_contact", "employer_domain", "posted_in_ad"],
    err: ["400", "401", "403", "404", "409", "413", "415", "422", "429", "500", "generic", "network"],
    subStatus: ["queued", "sent", "confirmed_submitted", "failed", "outcome_unknown"],
    candSub: ["queued", "sent", "confirmed_submitted", "failed", "outcome_unknown"],
    ivStatus: ["tentative", "confirmed", "cancelled"],
    consent: ["search", "prepare", "submit", "searchHint", "prepareHint", "submitHint"],
    role: ["SuperAdmin", "Admin", "Manager", "Receptionist", "Agent", "Candidate"],
    task: ["captcha", "payment", "login", "legal_declaration", "verify_delivery", "confirm_acknowledgement", "unmatched_reply", "duplicate_submission"],
    group: ["candidate", "country", "staff", "profession", "employer", "source", "status", "period"],
    metric: ["found", "matched", "prepared", "submitted", "confirmed", "failed", "outcome_unknown", "replies", "interviews", "offers", "rejections"],
    exportType: ["applications", "matches", "submissions", "messages", "tasks"],
    lane: ["preparing", "ready_for_review", "queued", "submitted", "interviews", "outcomes", "attention", "matches"],
    field: ["name", "email", "phone", "profession", "skills", "education", "certificates", "experience", "languages", "experience.title", "experience.employer", "experience.start", "experience.end", "languages.lang", "languages.level"],
  };
  const missing = [];
  for (const [prefix, codes] of Object.entries(families)) for (const c of codes) if (!(`${prefix}.${c}` in en)) missing.push(`${prefix}.${c}`);
  assert.deepEqual(missing, []);
  // 'sent' is never worded as a confirmed submission
  for (const lang of ["en", "ar", "fr"]) {
    assert.notEqual(I18N.dictionaries[lang]["status.sent"], I18N.dictionaries[lang]["status.confirmed_submitted"]);
  }
  assert.match(en["status.sent"], /awaiting confirmation/);
  assert.equal(en["label.notice"], "Label from the advertisement — verify with the employer. Not proof of sponsorship, LMIA or visa.");
  assert.equal(en["label.confirmed"], "Confirmed by staff");
  assert.equal(en["otp.generic"], "If an account exists you will receive a code.");
});

// ---------------------------------------------------------------- page content

test("pages: exact bilingual section title in admin and portal; portal references the disclaimer in all languages", () => {
  for (const f of ["admin.html", "portal.html"]) {
    const html = read(f);
    const h1 = /<h1\b[^>]*>([^<]*)<\/h1>/.exec(html);
    assert.ok(h1, `${f} has no h1`);
    assert.equal(h1[1].replace(/&amp;/g, "&"), TITLE, `${f} h1 is not the exact section title`);
    assert.doesNotMatch(h1[0], /data-i18n/, `${f}: the section title must not be translated away`);
    assert.match(html, /src="logo\.webp"[^>]*alt="VITA"|alt="VITA"[^>]*src="logo\.webp"/, `${f} lacks the logo`);
  }
  const portal = read("portal.html");
  assert.match(portal, /data-i18n="disclaimer"/);
  for (const lang of ["ar", "en", "fr"]) assert.match(portal, new RegExp(`data-disclaimer-lang="${lang}"`), `portal lacks the ${lang} disclaimer slot`);
  // dir handling: the shared script sets <html dir> from the dictionary
  const js = read("vita.js");
  assert.match(js, /documentElement\.dir\s*=/);
  assert.match(js, /documentElement\.lang\s*=/);
});

test("static scan: no inline scripts, handlers, style attributes or javascript: URLs in html", () => {
  for (const f of files(".html")) {
    const html = read(f);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\bsrc="[^"]+"/, `${f}: inline <script>`);
      assert.equal(m[2].trim(), "", `${f}: script with body`);
      assert.doesNotMatch(m[1], /src="(?:https?:)?\/\//, `${f}: external script`);
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${f}: inline event handler`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${f}: style attribute`);
    assert.doesNotMatch(html, /<style\b/i, `${f}: <style> element`);
    assert.doesNotMatch(html, /javascript:/i, `${f}: javascript: URL`);
    assert.doesNotMatch(html, /(?:href|src)="(?:https?:)?\/\//i, `${f}: external resource`);
  }
});

test("static scan: no HTML-injection or eval sinks in public/vita/*.js", () => {
  const SINKS = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b|setTimeout\(\s*["'`]|setInterval\(\s*["'`]/;
  for (const f of files(".js")) {
    const lines = read(f).split("\n");
    lines.forEach((line, i) => assert.doesNotMatch(line, SINKS, `${f}:${i + 1}: ${line.trim()}`));
    assert.doesNotMatch(read(f), /console\.(log|info|debug)\([^)]*token/i, `${f}: logs a token`);
    assert.doesNotMatch(read(f), /https?:\/\//, `${f}: absolute URL (everything is same-origin)`);
  }
  for (const f of files(".css")) assert.doesNotMatch(read(f), /@import|url\(\s*["']?(?:https?:)?\/\//i, `${f}: external css resource`);
});

test("static scan: href/src/srcdoc and on* attributes are only set inside the allowed helpers", () => {
  // Allowed: safeLink (http/https only) and download (blob: object URL) in vita.js.
  const ALLOWED = { "vita.js": ["safeLink", "download"] };
  for (const f of files(".js")) {
    if (f === "i18n.js") continue;
    const src = read(f);
    const fnAt = (idx) => {
      const before = src.slice(0, idx);
      const m = [...before.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].pop();
      return m ? m[1] : null;
    };
    for (const m of src.matchAll(/\b(?:href|src)\s*:|srcdoc|setAttribute\(\s*["'](?:on|href|src|style)|\.on[a-z]+\s*=|\.(?:href|src)\s*=/g)) {
      const fn = fnAt(m.index);
      assert.ok((ALLOWED[f] || []).includes(fn), `${f}: "${m[0]}" used in ${fn || "top level"}`);
    }
  }
  // the generic DOM helper refuses event-handler attributes passed through attrs{}
  assert.match(read("vita.js"), /function safeLink[\s\S]*?u\.protocol !== "https:" && u\.protocol !== "http:"/);
});

test("SSE reconnect backoff: exponential, capped at 30 s, jittered, attempt >= 1", () => {
  const { backoffDelay, STABLE_STREAM_MS } = require("../public/vita/vita.js");
  assert.equal(STABLE_STREAM_MS, 10000);
  assert.equal(backoffDelay(1, 0), 500);
  assert.equal(backoffDelay(1, 0.999999), 1000);
  assert.equal(backoffDelay(2, 0), 1000);
  assert.equal(backoffDelay(3, 0), 2000);
  for (const a of [6, 7, 50, 1e6]) {
    assert.ok(backoffDelay(a, 0) === 15000 && backoffDelay(a, 0.999999) <= 30000, `attempt ${a}`);
  }
  assert.equal(backoffDelay(0, 0), 500, "attempt is clamped to >= 1");
  assert.equal(backoffDelay(4, 2), backoffDelay(4, 0), "bad random input falls back to 0");
  const samples = new Set(Array.from({ length: 20 }, (_, i) => backoffDelay(5, i / 20)));
  assert.ok(samples.size > 10, "jitter spreads reconnects");
  // the client must not reset the counter on a bare 200: only after a stable period or an event
  const js = read("vita.js");
  assert.match(js, /stableTimer = window\.setTimeout\(function \(\) \{ attempt = 0; \}, STABLE_STREAM_MS\)/);
  assert.doesNotMatch(js, /throw new Error\("events unavailable"\);\s*attempt = 0;/);
});

test("tokens are kept in sessionStorage (with memory fallback), never put in URLs", () => {
  const js = read("vita.js");
  assert.match(js, /sessionStorage/);
  assert.doesNotMatch(js, /localStorage\.setItem\([^)]*token/i);
  for (const f of files(".js")) assert.doesNotMatch(read(f), /[?&](?:token|access_token)=/, `${f}: token in a URL`);
});

// ---------------------------------------------------------------- HTTP

test("http: /vita redirects, assets are served with CSP and security headers, / is unchanged", async () => {
  await withServer(async ({ base }) => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.deepEqual(await root.json(), { system: "EMNA Services CRM", status: "Running", company: "Emna Visa Services", mode: "Production API" });

    const r = await fetch(`${base}/vita`, { redirect: "manual" });
    assert.ok([301, 302, 308].includes(r.status), `status ${r.status}`);
    assert.equal(r.headers.get("location"), "/vita/");
    for (const [k, v] of Object.entries({ "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "cache-control": "no-cache" })) {
      assert.equal(r.headers.get(k), v, `redirect ${k}`);
    }

    const assets = [...files(".html"), ...files(".js"), ...files(".css"), "logo.webp"];
    for (const f of ["index.html", "admin.html", "portal.html", "vita.css", "print.css", "vita.js", "i18n.js", "admin.js", "portal.js", "logo.webp"]) assert.ok(assets.includes(f), `missing ${f}`);
    for (const f of ["", ...assets]) {
      const res = await fetch(`${base}/vita/${f}`);
      assert.equal(res.status, 200, `/vita/${f}`);
      assert.equal(res.headers.get("content-security-policy"), CSP, `/vita/${f} CSP`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      if (f === "" || f.endsWith(".html")) {
        assert.match(res.headers.get("content-type"), /text\/html/);
        assert.match(res.headers.get("cache-control"), /no-cache/);
      }
      if (f.endsWith(".js")) assert.match(res.headers.get("content-type"), /javascript/);
      if (f === "logo.webp") {
        assert.equal(res.headers.get("content-type"), "image/webp");
        const buf = Buffer.from(await res.arrayBuffer());
        assert.equal(buf.subarray(0, 4).toString(), "RIFF");
        assert.equal(buf.subarray(8, 12).toString(), "WEBP");
      } else await res.arrayBuffer();
    }
    const portal = await (await fetch(`${base}/vita/portal.html`)).text();
    assert.match(portal, /data-i18n="disclaimer"/);
    assert.ok(portal.includes(DISCLAIMER.en), "portal ships the English disclaimer as no-JS fallback");

    const missing = await fetch(`${base}/vita/nope.js`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("content-security-policy"), CSP);
    assert.equal(missing.headers.get("cache-control"), "no-cache");
    assert.equal(missing.headers.get("x-content-type-options"), "nosniff");
    // dotfiles, source maps and traversal attempts are not served; every refusal still carries the CSP
    const http = require("http");
    const rawGet = (p) => new Promise((resolve, reject) => {
      const u = new URL(base);
      http.get({ host: u.hostname, port: u.port, path: p }, (res) => { res.resume(); res.on("end", () => resolve(res)); }).on("error", reject);
    });
    for (const p of [
      "/vita/..%2fapp.js", "/vita/%2e%2e/app.js", "/vita/%2e%2e%2fapp.js", "/vita/..%252fapp.js", "/vita/%252e%252e%252fapp.js",
      "/vita/.env", "/vita/..%2f.env", "/vita/%2e%2e%2f.env", "/vita/vita.js.map", "/vita/..%5capp.js", "/vita/..\\app.js",
      "/vita//etc/passwd", "/vita/%2fetc%2fpasswd", "/vita/..%2f..%2f..%2fetc%2fpasswd", "/vita/../app.js",
    ]) {
      const res = await rawGet(p);
      assert.equal(res.statusCode, 404, `${p} -> ${res.statusCode}`);
      assert.equal(res.headers["content-security-policy"], CSP, `${p} CSP`);
      assert.equal(res.headers["x-content-type-options"], "nosniff", `${p} nosniff`);
    }
    // the API is untouched by the static mount
    assert.equal((await fetch(`${base}/jobsearch/auth/me`)).status, 401);
  });
});

test("http: GET /jobsearch/applications/:id/recipient shows the approver where a CV would go (staff in scope only)", async () => {
  await withServer(async ({ pool, base }) => {
    const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
    const mgr = (await one("INSERT INTO users (full_name,email,password,role) VALUES ('M','m@ui.test.invalid','x','Manager') RETURNING id")).id;
    const other = (await one("INSERT INTO users (full_name,email,password,role) VALUES ('O','o@ui.test.invalid','x','Agent') RETURNING id")).id;
    const candUser = (await one("INSERT INTO users (full_name,email,password,role) VALUES ('C','c@ui.test.invalid','x','Candidate') RETURNING id")).id;
    const cid = (await one("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ('Cand','PPUI1',$1) RETURNING id", [mgr])).id;
    await pool.query("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [candUser, cid]);
    const emp = (await one("INSERT INTO js_employers (name, normalized_name, domain) VALUES ('Acme','acme','acme.example') RETURNING id")).id;
    const job = (await one(
      "INSERT INTO js_jobs (title, country, employer_id, dedupe_key, url, description_text) VALUES ('Welder','Canada',$1,'dk-ui-1','https://jobs.example/1','Send your CV to jobs@gmail.example') RETURNING id",
      [emp]
    )).id;
    const app = (await one("INSERT INTO js_applications (candidate_id, job_id, status) VALUES ($1,$2,'ready_for_review') RETURNING id", [cid, job])).id;
    const tok = (id, role, extra = {}) => jwt.sign({ id, role, ...extra }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const get = (t, id = app) => fetch(`${base}/jobsearch/applications/${id}/recipient`, { headers: { authorization: `Bearer ${t}` } });

    const ok = await get(tok(mgr, "Manager"));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.applicationId, app);
    assert.equal(body.recipient, "jobs@gmail.example");
    assert.equal(body.recipientSource, "posted_in_ad");
    assert.equal(body.verified, false);
    assert.equal(body.domainMatchesEmployer, false);

    assert.equal((await get(tok(other, "Agent"))).status, 404, "staff outside scope");
    assert.equal((await get(tok(candUser, "Candidate", { tv: 0 }))).status, 403, "candidates never see recipients");
    assert.equal((await get(tok(mgr, "Manager"), 999999)).status, 404);
    assert.equal((await fetch(`${base}/jobsearch/applications/${app}/recipient`)).status, 401);

    await pool.query("UPDATE js_employers SET verified_contact_email = 'hr@acme.example' WHERE id = $1", [emp]);
    const v = await (await get(tok(mgr, "Manager"))).json();
    assert.equal(v.recipient, "hr@acme.example");
    assert.equal(v.recipientSource, "verified_contact");
    assert.equal(v.verified, true);
  });
});

test("dev seed script refuses to run in production", () => {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "dev-seed-ui.js")], {
    env: { ...process.env, NODE_ENV: "production", DATABASE_URL: "postgres://invalid.invalid:1/none", TEST_DATABASE_URL: "" },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refus/i);
});

// ---------------------------------------------------------------- Task 18: CV approval in the UI

test("Task 18 portal: each CV version shows its scan status and can be approved with a language (en/fr/ar/other ISO code)", () => {
  const js = read("portal.js");
  const en = I18N.dictionaries.en;
  assert.equal(en["cv.approveExplain"], "Approving lets VITA attach this exact file to applications you authorize; the original is never changed.");
  assert.equal(en["cv.approveButton"], "Approve this version for applications");
  assert.match(js, /V\.api\("POST", "\/jobsearch\/cv-files\/" \+ f\.id \+ "\/approve", \{ body: \{ language: lang \} \}\)/, "the portal calls the approval endpoint");
  assert.match(js, /var CV_LANGS = \["en", "fr", "ar"\]/);
  assert.match(js, /h\("option", \{ value: "other"/, "an 'other' language choice");
  assert.match(js, /\/\^\[a-z\]\{2\}\$\/\.test\(lang\)/, "other = 2-letter ISO code, validated client side");
  assert.match(js, /t\("cv\.approveExplain"\)/);
  assert.match(js, /scanBadge\(f\)/, "scan status per version");
  assert.match(js, /f\.scan_status === "infected"[\s\S]{0,120}cv\.infectedNoApprove/, "infected versions offer no approval");
  assert.match(js, /cv\.noneApproved/, "the status page says when no version is approved");
  for (const k of ["en", "fr", "ar", "other"]) assert.ok(`cv.lang.${k}` in en);
});

test("Task 18 admin: the application drawer lists CV versions; approval on the candidate's behalf needs jobsearch:approve and a note >= 10 chars", () => {
  const js = read("admin.js");
  assert.match(js, /"\/jobsearch\/candidates\/" \+ r\[0\]\.application\.candidateId \+ "\/profile"/, "the drawer loads the candidate's CV versions");
  assert.match(js, /if \(!f\.approved && f\.scan_status !== "infected" && can\("approve"\)\) box\.appendChild\(cvApproveForm\(a, f\)\)/, "only approvers get the form");
  assert.match(js, /if \(n\.length < 10\)/, "note length checked before the call");
  assert.match(js, /"\/jobsearch\/cv-files\/" \+ f\.id \+ "\/approve", \{ body: \{ language: lang, note: n \} \}/);
  assert.equal(I18N.dictionaries.en["cvAdmin.note"], "Note (required): who asked, when and how");
});

test("Task 18 unscanned files: the UI says 'Not scanned — an administrator must enable scanning or explicitly allow unscanned files'", () => {
  const en = I18N.dictionaries.en;
  assert.equal(en["cv.unscannedNotice"], "Not scanned — an administrator must enable scanning or explicitly allow unscanned files.");
  assert.equal(en["block.attachment_unscanned"], "Not scanned — an administrator must enable scanning or explicitly allow unscanned files");
  assert.match(read("portal.js"), /f\.scan_status === "scan_unavailable"\) li\.appendChild\(h\("p", \{ class: "small notice warn", text: t\("cv\.unscannedNotice"\) \}\)\)/);
  assert.match(read("admin.js"), /f\.scan_status === "scan_unavailable"\) box\.appendChild\(h\("p", \{ class: "small", text: t\("cv\.unscannedNotice"\) \}\)\)/);
  assert.match(read("admin.js"), /tc\("block", b && b\.reason\)/, "blocked package reasons (attachment_unscanned) are shown in the drawer");
});

test("Task 18 admin 'Employers & rules' panel: directory, manual import (https only), confirmations (note >= 10, job vs employer-wide), automation rules; role-gated; text only", () => {
  const html = read("admin.html");
  const js = read("admin.js");
  assert.match(html, /<button type="button" role="tab" id="tab-directory" aria-controls="panel-directory" data-tab="directory" data-i18n="tab\.directory">/);
  assert.match(html, /<section id="panel-directory" role="tabpanel" aria-labelledby="tab-directory"/);
  assert.match(js, /directory: loadDirectory/);
  for (const call of [
    /V\.api\("GET", "\/jobsearch\/employers" \+ qs\(/,
    /V\.api\("PUT", "\/jobsearch\/employers\/" \+ e\.id, \{ body: patch \}\)/,
    /V\.api\("POST", "\/jobsearch\/jobs\/manual", \{ body: bodyOut \}\)/,
    /V\.api\("POST", "\/jobsearch\/employer-confirmations", \{ body: payload \}\)/,
    /V\.api\("DELETE", "\/jobsearch\/employer-confirmations\/" \+ k\.id\)/,
    /V\.api\("GET", "\/jobsearch\/employer-confirmations"\)/,
    /V\.api\("GET", "\/jobsearch\/automation-rules"\)/,
    /V\.api\("POST", "\/jobsearch\/automation-rules", \{ body: payload \}\)/,
    /V\.api\("DELETE", "\/jobsearch\/automation-rules\/" \+ r\.id\)/,
  ]) assert.match(js, call);
  assert.match(js, /if \(u && !\/\^https:/, "manual import accepts https links only");
  assert.match(js, /if \(n\.length < 10\) \{ note\.setAttribute\("aria-invalid", "true"\); note\.focus\(\); V\.toast\(t\("conf\.noteTooShort"\)/);
  assert.match(js, /wide \? \{ employerId: app\.employer\.id, evidenceNote: n \} : \{ applicationId: app\.id, evidenceNote: n \}/, "job-specific vs employer-wide");
  assert.match(js, /\$\("#confirm-card"\)\.hidden = !isAdmin\(\);\s*\$\("#rules-card"\)\.hidden = !isAdmin\(\);/);
  assert.match(js, /function canEditEmployers\(\) \{ return isAdmin\(\) \|\| role\(\) === "Manager"; \}/);
  const en = I18N.dictionaries.en;
  for (const k of ["conf.scopeJobHint", "conf.scopeEmployerHint", "rules.hint", "ruleType.auto_submit", "ruleType.ack_reply"]) assert.ok(en[k], k);
});

test("Task 19 M-3: Health renders sandbox mail as 'Sandbox — no real mail is sent' (ar/en/fr), never as 'Connected'; SMTP problems are named", () => {
  assert.equal(I18N.dictionaries.en["health.mailSandbox"], "Sandbox — no real mail is sent");
  for (const lang of ["ar", "fr"]) assert.ok(I18N.dictionaries[lang]["health.mailSandbox"] && I18N.dictionaries[lang]["health.mailSandbox"] !== I18N.dictionaries.en["health.mailSandbox"], lang);
  for (const lang of ["en", "ar", "fr"]) assert.match(I18N.dictionaries[lang]["health.mailMissing"], /\{names\}/, lang);
  const admin = read("admin.js");
  assert.match(admin, /m\.mode === "sandbox"\) return t\("health\.mailSandbox"\)/);
  assert.ok(!admin.includes('tc("srcStatus", hl.mail.status)'), "the sandbox status is no longer shown as a source status");
  assert.match(admin, /t\("health\.mailMissing", \{ names: m\.problems\.join/);
});
