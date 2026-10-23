// Task 6: public VITA website (static, strict CSP) and its routing.
// Real app over HTTP + static scans of public/site (no build step, no inline code, no external origins).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "site-ui-test-secret";

const SITE = path.join(__dirname, "..", "public", "site");
const PAGES = ["index", "services", "destinations", "how-it-works", "jobs", "employers", "register", "contact", "privacy", "terms"];
const DISCLAIMER = {
  en: "This service helps you search and apply for job opportunities. It does not guarantee employment, employer sponsorship, a work permit or a visa.",
  ar: "تساعدك هذه الخدمة على البحث عن فرص العمل والتقديم إليها. وهي لا تضمن الحصول على عمل أو كفالة صاحب العمل أو تصريح عمل أو تأشيرة.",
  fr: "Ce service vous aide à rechercher des offres d'emploi et à y postuler. Il ne garantit ni un emploi, ni un parrainage de l'employeur, ni un permis de travail, ni un visa.",
};

const read = (f) => fs.readFileSync(path.join(SITE, f), "utf8");
const files = (ext) => fs.readdirSync(SITE).filter((f) => f.endsWith(ext));
const I18N = () => require("../public/site/i18n-site.js");

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

// ---------------------------------------------------------------- files

test("site: all ten pages plus css, js, i18n and the logo exist", () => {
  for (const p of PAGES) assert.ok(fs.existsSync(path.join(SITE, `${p}.html`)), `${p}.html`);
  for (const f of ["site.css", "site.js", "i18n-site.js", "logo.webp"]) assert.ok(fs.existsSync(path.join(SITE, f)), f);
});

// ---------------------------------------------------------------- CSP-safe shape

test("static scan: no inline scripts, handlers, style attributes, javascript: or external URLs in html", () => {
  for (const f of files(".html")) {
    const html = read(f);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\bsrc="[^"]+"/, `${f}: inline <script>`);
      assert.equal(m[2].trim(), "", `${f}: script with body`);
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${f}: inline event handler`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${f}: style attribute`);
    assert.doesNotMatch(html, /<style\b/i, `${f}: <style> element`);
    assert.doesNotMatch(html, /javascript:/i, `${f}: javascript: URL`);
    assert.doesNotMatch(html, /https?:\/\//i, `${f}: absolute URL`);
    assert.doesNotMatch(html, /(?:href|src)="\/\//i, `${f}: protocol-relative URL`);
  }
});

test("static scan: no external origins in css/js and no HTML-injection or eval sinks in js", () => {
  const SINKS = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b|setTimeout\(\s*["'`]|setInterval\(\s*["'`]|\bsrcdoc\b|\.on[a-z]+\s*=/;
  for (const f of [...files(".js"), ...files(".css")]) {
    assert.doesNotMatch(read(f), /https?:\/\//i, `${f}: absolute URL`);
  }
  for (const f of files(".css")) assert.doesNotMatch(read(f), /@import|url\(\s*["']?(?:https?:)?\/\//i, `${f}: external css resource`);
  for (const f of files(".js")) {
    read(f).split("\n").forEach((line, i) => assert.doesNotMatch(line, SINKS, `${f}:${i + 1}: ${line.trim()}`));
  }
});

test("accessibility scan: lang/dir, skip link, one h1, main landmark, labelled inputs, logo", () => {
  for (const p of PAGES) {
    const html = read(`${p}.html`);
    assert.match(html, /<html lang="en" dir="ltr">/, p);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, p);
    assert.match(html, /class="skip-link" href="#main"/, p);
    assert.match(html, /<main id="main"/, p);
    assert.equal((html.match(/<h1\b/g) || []).length, 1, `${p}: exactly one h1`);
    assert.match(html, /<img src="\/site\/logo\.webp" alt="[^"]+" width="\d+" height="\d+">/, p);
    assert.match(html, /<link rel="stylesheet" href="\/site\/site\.css">/, p);
    assert.match(html, /<script src="\/site\/i18n-site\.js" defer><\/script>/, p);
    assert.match(html, /<script src="\/site\/site\.js" defer><\/script>/, p);
    for (const m of html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
      if (/type="hidden"/.test(m[2])) continue;
      const id = (m[2].match(/\bid="([^"]+)"/) || [])[1];
      assert.ok(id, `${p}: <${m[1]}> without id`);
      assert.match(html, new RegExp(`<label[^>]*\\bfor="${id}"`), `${p}: no label for #${id}`);
    }
  }
});

test("forms: honeypot is hidden from assistive tech and tab order; consent is a required checkbox; no inline handlers", () => {
  const forms = { register: "candidate", employers: "employer", contact: "contact" };
  for (const [page, kind] of Object.entries(forms)) {
    const html = read(`${page}.html`);
    assert.match(html, new RegExp(`<form[^>]*data-lead-form[^>]*data-kind="${kind}"`), page);
    const hp = html.match(/<div class="hp"[^>]*>[\s\S]*?<\/div>/);
    assert.ok(hp, `${page}: honeypot container`);
    assert.match(hp[0], /aria-hidden="true"/);
    assert.match(hp[0], /name="website"/);
    assert.match(hp[0], /tabindex="-1"/);
    assert.match(hp[0], /autocomplete="off"/);
    if (kind !== "contact") assert.match(html, /<input[^>]*type="checkbox"[^>]*name="consent"[^>]*required|<input[^>]*name="consent"[^>]*type="checkbox"[^>]*required/, `${page}: consent`);
  }
  assert.match(read("register.html"), /data-i18n="form\.consent\.candidate"/);
  assert.match(read("register.html"), /name="country"/);
  assert.match(read("register.html"), /name="profession"/);
});

// ---------------------------------------------------------------- i18n

test("i18n: ar/en/fr have identical key sets, no empty strings; dir is rtl only for ar", () => {
  const { dictionaries, dirFor } = I18N();
  assert.deepEqual(Object.keys(dictionaries).sort(), ["ar", "en", "fr"]);
  const en = Object.keys(dictionaries.en).sort();
  assert.ok(en.length > 100, "expected a real dictionary");
  for (const lang of ["ar", "fr"]) assert.deepEqual(Object.keys(dictionaries[lang]).sort(), en, `${lang} keys differ from en`);
  for (const [lang, dict] of Object.entries(dictionaries)) {
    for (const [k, v] of Object.entries(dict)) {
      assert.equal(typeof v, "string", `${lang}.${k}`);
      assert.ok(v.trim().length > 0, `${lang}.${k} is empty`);
    }
  }
  assert.equal(dirFor("ar"), "rtl");
  assert.equal(dirFor("en"), "ltr");
  assert.equal(dirFor("fr"), "ltr");
});

test("i18n: every data-i18n* key used in html and every t('key') in site.js exists", () => {
  const { dictionaries } = I18N();
  const used = new Set();
  for (const f of files(".html")) for (const m of read(f).matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) used.add(m[1]);
  for (const m of read("site.js").matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"\s*[,)]/g)) used.add(m[1]);
  for (const f of files(".html")) for (const m of read(f).matchAll(/data-title-key="([^"]+)"/g)) used.add(m[1]);
  assert.ok(used.size > 60);
  const missing = [...used].filter((k) => !(k in dictionaries.en));
  assert.deepEqual(missing, [], `missing i18n keys: ${missing.join(", ")}`);
});

test("i18n: the required disclaimer is exact in ar/en/fr and on every page (English fallback text in the markup)", () => {
  const { dictionaries } = I18N();
  for (const lang of ["en", "ar", "fr"]) assert.equal(dictionaries[lang].disclaimer, DISCLAIMER[lang], lang);
  for (const p of PAGES) {
    const html = read(`${p}.html`);
    const m = html.match(/<p[^>]*data-i18n="disclaimer"[^>]*>([^<]*)<\/p>/);
    assert.ok(m, `${p}: disclaimer element`);
    assert.equal(m[1], DISCLAIMER.en, `${p}: English fallback text`);
  }
});

test("i18n: honest wording, no promises (no 'guarantee' without negation, no success claims)", () => {
  const { dictionaries } = I18N();
  const en = Object.entries(dictionaries.en);
  for (const [k, v] of en) {
    if (k === "disclaimer") continue;
    assert.doesNotMatch(v, /\b(100\s?%|guaranteed|we guarantee|you will get|visa approved|success rate)\b/i, `${k}: ${v}`);
  }
  assert.match(dictionaries.en["jobs.empty"], /^No offers are published right now/);
  assert.match(dictionaries.en["destinations.canada.p"], /cannot promise|do not promise|no promise/i);
});

// ---------------------------------------------------------------- config facts (pure helper)

test("site.js factsFrom: renders only facts that are set; nothing invented", () => {
  const { factsFrom, safeHref } = require("../public/site/site.js");
  assert.deepEqual(factsFrom({ name: "VITA" }), []);
  assert.deepEqual(factsFrom(null), []);
  assert.deepEqual(factsFrom({}), []);
  const all = factsFrom({ name: "X", phone: "+1 555 0100", whatsapp: "https://wa.me/15550100", email: "a@b.example", address: "1 Main St", licence: "Licence 123" });
  assert.deepEqual(all.map((f) => f.key), ["phone", "whatsapp", "email", "address", "licence"]);
  assert.equal(all[0].href, "tel:+15550100");
  assert.equal(all[1].href, "https://wa.me/15550100");
  assert.equal(all[2].href, "mailto:a@b.example");
  assert.equal(all[3].href, undefined);
  assert.equal(all[4].href, undefined);
  // unsafe links are never made clickable
  const bad = factsFrom({ whatsapp: "javascript:alert(1)", email: "x y@z", phone: "call me" });
  for (const f of bad) assert.equal(f.href, undefined, f.key);
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,x"), null);
  assert.equal(safeHref("https://wa.me/1"), "https://wa.me/1");
  assert.equal(safeHref("/site/jobs.html"), null);
});

test("markup: config fact containers are hidden and empty in the static html (filled only from /public/config)", () => {
  for (const p of PAGES) {
    const html = read(`${p}.html`);
    const blocks = [...html.matchAll(/<(\w+)[^>]*data-site-facts[^>]*>([\s\S]*?)<\/\1>/g)];
    assert.ok(blocks.length >= 1, `${p}: facts container`);
    for (const b of blocks) {
      assert.match(b[0], /\shidden[\s>]/, `${p}: facts container must be hidden`);
      assert.equal(b[2].trim(), "", `${p}: facts container must be empty`);
    }
    assert.doesNotMatch(html, /tel:|mailto:|wa\.me|whatsapp\.com/i, `${p}: hard-coded contact fact`);
  }
});

test("markup: every page links the candidate portal and staff console; jobs page has an honest empty state hook", () => {
  for (const p of PAGES) {
    const html = read(`${p}.html`);
    assert.match(html, /href="\/vita\/portal\.html"/, p);
    assert.match(html, /href="\/vita\/"/, p);
    assert.match(html, /href="\/site\/privacy\.html"/, p);
    assert.match(html, /href="\/site\/terms\.html"/, p);
  }
  assert.match(read("jobs.html"), /id="jobs-list"/);
  assert.match(read("jobs.html"), /id="jobs-empty"[^>]*hidden/);
});

// ---------------------------------------------------------------- HTTP

test("http: GET / negotiates - html for browsers, the existing JSON otherwise", async () => {
  await withServer(async ({ base }) => {
    const browser = await fetch(`${base}/`, { headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" } });
    assert.equal(browser.status, 200);
    assert.match(browser.headers.get("content-type"), /text\/html/);
    assert.match(browser.headers.get("vary") || "", /Accept/i);
    const body = await browser.text();
    assert.match(body, /<html lang="en" dir="ltr">/);
    assert.ok(body.includes(DISCLAIMER.en));

    for (const accept of [undefined, "*/*", "application/json", "text/plain"]) {
      const r = await fetch(`${base}/`, { headers: accept ? { Accept: accept } : {} });
      assert.equal(r.status, 200, String(accept));
      assert.match(r.headers.get("content-type"), /application\/json/, String(accept));
      assert.deepEqual(await r.json(), { system: "EMNA Services CRM", status: "Running", company: "Emna Visa Services", mode: "Production API" });
      assert.match(r.headers.get("vary") || "", /Accept/i);
    }
    // wildcard-only text/* does not name text/html explicitly -> JSON
    const wild = await fetch(`${base}/`, { headers: { Accept: "text/*" } });
    assert.match(wild.headers.get("content-type"), /application\/json/);
  });
});

test("http: /site assets carry exactly the /vita CSP and security headers; /site redirects; unknown paths 404", async () => {
  const { CSP } = require("../routes/vitaStatic");
  await withServer(async ({ base }) => {
    const vita = await fetch(`${base}/vita/`);
    const vitaCsp = vita.headers.get("content-security-policy");
    assert.equal(vitaCsp, CSP);
    const root = await fetch(`${base}/`, { headers: { Accept: "text/html" } });
    assert.equal(root.headers.get("content-security-policy"), vitaCsp);
    for (const p of ["/site/", "/site/index.html", "/site/jobs.html", "/site/site.css", "/site/site.js", "/site/i18n-site.js", "/site/logo.webp", "/site/nope.html"]) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.headers.get("content-security-policy"), vitaCsp, p);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", p);
      assert.equal(r.headers.get("x-frame-options"), "DENY", p);
      assert.equal(r.status, p.endsWith("nope.html") ? 404 : 200, p);
    }
    const redirect = await fetch(`${base}/site`, { redirect: "manual" });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("location"), "/site/");
    assert.match((await fetch(`${base}/site/site.js`)).headers.get("content-type"), /javascript/);
    assert.match((await fetch(`${base}/site/logo.webp`)).headers.get("content-type"), /image\/webp/);
  });
});

test("http: robots.txt and sitemap.xml are served; sitemap lists every page; absolute only with SITE_BASE_URL", async () => {
  await withServer(async ({ base }) => {
    const prev = process.env.SITE_BASE_URL;
    try {
      delete process.env.SITE_BASE_URL;
      const robots = await fetch(`${base}/robots.txt`);
      assert.equal(robots.status, 200);
      assert.match(robots.headers.get("content-type"), /text\/plain/);
      const rt = await robots.text();
      assert.match(rt, /User-agent: \*/);
      assert.match(rt, /Disallow: \/vita\//);
      assert.doesNotMatch(rt, /Sitemap:/);

      const sm = await fetch(`${base}/sitemap.xml`);
      assert.equal(sm.status, 200);
      assert.match(sm.headers.get("content-type"), /xml/);
      const xml = await sm.text();
      assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
      for (const p of PAGES.filter((x) => x !== "index")) assert.ok(xml.includes(`<loc>/site/${p}.html</loc>`), p);
      assert.ok(xml.includes("<loc>/</loc>"));

      process.env.SITE_BASE_URL = "https://example.test/";
      const xml2 = await (await fetch(`${base}/sitemap.xml`)).text();
      assert.ok(xml2.includes("<loc>https://example.test/site/jobs.html</loc>"));
      assert.ok(xml2.includes("<loc>https://example.test/</loc>"));
      assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Sitemap: https:\/\/example\.test\/sitemap\.xml/);

      process.env.SITE_BASE_URL = "javascript:alert(1)";
      assert.doesNotMatch(await (await fetch(`${base}/sitemap.xml`)).text(), /javascript/);
    } finally {
      if (prev === undefined) delete process.env.SITE_BASE_URL;
      else process.env.SITE_BASE_URL = prev;
    }
  });
});

test("http: with SITE_* unset /public/config exposes no contact facts and the pages carry none", async () => {
  await withServer(async ({ base }) => {
    const saved = {};
    for (const k of ["SITE_PHONE", "SITE_WHATSAPP", "SITE_EMAIL", "SITE_ADDRESS", "SITE_LICENCE_TEXT"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const cfg = await (await fetch(`${base}/public/config`)).json();
      assert.deepEqual(Object.keys(cfg), ["name"]);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });
});

test("http: the lead form payload the site sends is accepted by /public/leads (candidate, employer, contact)", async () => {
  await withServer(async ({ base, pool }) => {
    const post = (b) => fetch(`${base}/public/leads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const r1 = await post({ kind: "candidate", lang: "ar", name: "محمد <b>x</b>", email: "site.c@example.test", phone: "+216 20 000 000", country: "تونس", profession: "لحام", message: "مرحبا", consent: true, website: "" });
    assert.deepEqual(await r1.json(), { ok: true });
    const r2 = await post({ kind: "employer", lang: "en", name: "Boss", company: "Acme", email: "site.e@example.test", consent: true, website: "" });
    assert.equal(r2.status, 200);
    const r3 = await post({ kind: "contact", lang: "fr", name: "Claire", email: "site.f@example.test", message: "Bonjour", website: "" });
    assert.equal(r3.status, 200);
    const rows = (await pool.query("SELECT kind, status, lang, consent_at IS NOT NULL AS consent FROM crm_leads ORDER BY id")).rows;
    assert.deepEqual(rows.map((r) => [r.kind, r.status, r.lang, r.consent]), [["candidate", "new", "ar", true], ["employer", "new", "en", true], ["contact", "new", "fr", false]]);
  });
});
