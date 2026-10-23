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
    // dotfiles and traversal are not served
    assert.equal((await fetch(`${base}/vita/..%2fapp.js`)).status, 404);
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
