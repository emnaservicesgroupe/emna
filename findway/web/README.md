# FIND WAY web app (website + installable PWA)

Vanilla ES modules, no build step, no external resources (the server CSP only allows `'self'`). Served by the Node app from `/`.

* **This is an installable PWA, not an App Store / Google Play release.** Browsers that support it offer "Install app". Native iOS and Android
  apps are a later phase and will reuse the same HTTP API.
* Languages: `i18n/{en,ar,sq,fr}.json`. Add a language = add a JSON file with the same keys + one line in `js/i18n.js` (`LANGS`). Arabic is fully RTL
  (CSS logical properties only; enforced by `tests/i18n.test.js`).
* User-entered content is never translated (`dir="auto"`); enum values and API error codes are translated with a raw-value fallback.
* Routing is hash-based (`#/jobs/FW-J-1000`), so no server rewrites are needed.
* The service worker caches only the static app shell; `/api/*` is never cached.
* Brand assets in `assets/` are the owner-supplied logo used as a placeholder pending formal brand approval.

Verification: `node --test tests/i18n.test.js` and `node scripts/e2e-ui.js` (Chromium via playwright-core; needs Postgres, see `tests/helpers.js`).
