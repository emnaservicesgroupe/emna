// Public VITA website: static pages under /site/, served at / for browsers (Accept: text/html), plus
// /robots.txt and /sitemap.xml. Uses the same strict CSP and security headers as /vita.
const path = require("path");
const express = require("express");
const { securityHeaders } = require("./vitaStatic");

const SITE_DIR = path.join(__dirname, "..", "public", "site");
const PAGES = ["services", "destinations", "how-it-works", "jobs", "employers", "register", "contact", "privacy", "terms"];

/** True only for browsers: text/html is named explicitly in Accept and wins content negotiation over JSON. */
function wantsSiteHtml(req) {
  const accept = req.get("Accept");
  return typeof accept === "string" && /text\/html/i.test(accept) && req.accepts(["json", "html"]) === "html";
}

/** SITE_BASE_URL when it is a plain http(s) origin/path, without a trailing slash; otherwise "". */
function baseUrl(env = process.env) {
  const raw = typeof env.SITE_BASE_URL === "string" ? env.SITE_BASE_URL.trim() : "";
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return u.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function sitemapXml(env = process.env) {
  const base = baseUrl(env);
  const paths = ["/", ...PAGES.map((p) => `/site/${p}.html`)];
  const urls = paths.map((p) => `  <url><loc>${esc(base + p)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function robotsTxt(env = process.env) {
  const base = baseUrl(env);
  const lines = ["User-agent: *", "Allow: /", "Disallow: /vita/", "Disallow: /public/", "Disallow: /crm/"];
  if (base) lines.push("", `Sitemap: ${base}/sitemap.xml`);
  return lines.join("\n") + "\n";
}

/** GET / handler: the site's home page for browsers, otherwise `next()` so the JSON status answers. */
function siteHome(req, res, next) {
  res.vary("Accept");
  if (!wantsSiteHtml(req)) return next();
  return securityHeaders(req, res, () => res.sendFile(path.join(SITE_DIR, "index.html")));
}

function mountSite(app) {
  app.get("/robots.txt", (_req, res) => {
    res.set("Cache-Control", "no-cache").type("text/plain").send(robotsTxt());
  });
  app.get("/sitemap.xml", (_req, res) => {
    res.set("Cache-Control", "no-cache").type("application/xml").send(sitemapXml());
  });

  const router = express.Router();
  router.use(express.static(SITE_DIR, { index: "index.html", dotfiles: "ignore", redirect: false, fallthrough: true, cacheControl: false }));
  router.use((_req, res) => res.status(404).type("text/plain").send("Not found"));

  app.use("/site", securityHeaders, (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") {
      if (req.originalUrl.split("?")[0] === "/site") return res.redirect(301, "/site/");
    }
    return next();
  });
  app.use("/site", router);
}

module.exports = { mountSite, siteHome, wantsSiteHtml, sitemapXml, robotsTxt, SITE_DIR };
