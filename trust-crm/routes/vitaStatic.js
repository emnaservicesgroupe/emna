// VITA web UI (Task 15): static admin console + candidate portal served at /vita/.
// Everything is self-hosted plain HTML/CSS/JS, so a strict CSP applies to every response under
// /vita (including 404s): no inline scripts/styles, no external origins, no framing.
const path = require("path");
const express = require("express");

const PUBLIC_DIR = path.join(__dirname, "..", "public", "vita");

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function securityHeaders(_req, res, next) {
  res.set({
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  });
  next();
}

const router = express.Router();
router.use(securityHeaders);
router.use(
  express.static(PUBLIC_DIR, {
    index: "index.html",
    dotfiles: "ignore",
    redirect: false,
    fallthrough: true,
    setHeaders(res) {
      // Always revalidate (ETag/Last-Modified) so a deploy is picked up immediately.
      res.set("Cache-Control", "no-cache");
    },
  })
);
router.use((_req, res) => {
  res.status(404).type("text/plain").send("Not found");
});

/** Mounts GET /vita -> /vita/ and the static UI. The trailing-slash check avoids a redirect loop. */
function mountVita(app) {
  app.use("/vita", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") {
      const pathname = req.originalUrl.split("?")[0];
      if (pathname === "/vita") return res.redirect(301, "/vita/");
    }
    return next();
  });
  app.use("/vita", router);
}

module.exports = { mountVita, CSP, PUBLIC_DIR };
