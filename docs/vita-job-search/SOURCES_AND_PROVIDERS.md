# VITA AI Job Search — Sources and Providers

This page lists every outside connection the module can use, what state it is in today, and what the
owner has to provide before it works.

**How to provide credentials safely.** Put URLs, keys and passwords only in the server's environment
(the `trust-crm/.env` file on the server, readable only by the app user, or the host's secret settings),
then restart the app. Never send them in chat, e-mail, an issue, a commit or a screenshot. Nobody working
on the code needs to see them.

## Summary

| Connection | Status today | Owner must provide | Until then |
|---|---|---|---|
| Canada Job Bank feed (`jobbank_ca`) | Requires setup | An authorized feed URL, after checking Job Bank's terms | No Job Bank jobs |
| Partner feeds (`partner_feed`) | Requires setup | Feed URLs + the partner's written permission | No partner jobs |
| Manual import (`manual_import`) | Working (manual) | Nothing | — (staff enter vacancies by hand) |
| Test data (`test_fixture`) | Tests only | Nothing | Never available on a real server |
| Outgoing mail (SMTP) | Requires setup (sandbox in use) | SMTP account for your domain | No real e-mail leaves the server; candidates cannot receive sign-in codes |
| Reading a mailbox (IMAP) | Not built | — | Use the inbound webhook |
| Inbound mail webhook + bridge | Code ready, bridge not set up | A bridge (forwarding / inbound-parse service) and a shared secret | No employer replies are seen |
| Delivery receipts | Code ready, bridge not set up | Provider delivery events sent to the webhook | Submissions stay "sent — awaiting confirmation" unless staff confirm |
| ClamAV malware scan | Requires setup | A clamd server | Every CV shows "scan unavailable" and is still usable |
| AI model (LLM) key | Not built | — | Rule-based extraction and template letters only |
| WhatsApp / Meta | Out of scope | — | — |
| External calendar (Google, Outlook) | Not built | — | Internal interview appointments only |
| Domain and HTTPS | Owner's server | Domain, DNS, certificate (e.g. Caddy) | Not reachable safely from the internet |

## Job sources

Every source reports one of: `connected` (returns live jobs), `requires_setup` (missing or rejected
configuration), `unavailable` (configured but failing, e.g. a bad schedule), `manual` (staff entry).
Only `connected` sources return jobs. The Sources tab of the admin console and `GET /jobsearch/sources`
show the status and the missing variable.

All feed fetching follows the same rules (`modules/jobsearch/sources/http.js`):

- https only; hosts that resolve to private, loopback, link-local or reserved addresses are refused;
  redirects must stay https and public; no credentials in the URL;
- size cap, timeout, and an identifying User-Agent (`JOBSEARCH_USER_AGENT`, add a contact address);
- HTTP 401/403 is never worked around; HTTP 429 `Retry-After` is honoured; a per-source rate limit
  (2 per minute) and back-off apply;
- no scraping of web pages, no logins, no CAPTCHA solving.

### Canada Job Bank (`jobbank_ca`)

| | |
|---|---|
| File | `modules/jobsearch/sources/jobbankCa.js` |
| Status today | `requires_setup` ("JOBBANK_CA_FEED_URL is not set") |
| Owner provides | `JOBBANK_CA_FEED_URL` = a Job Bank feed URL you are **authorized** to use |
| Format accepted | JSON (an array, or an object with `jobs` or `items`) or RSS 2.0 `<item>`s. Job country defaults to Canada. |
| Terms | Check Job Bank's terms of use and any data/feed agreement before using it (start from https://www.jobbank.gc.ca/). This project does **not** supply or assume any feed URL. If Job Bank does not offer a feed you may use in this way, leave this source off. |
| Tested? | The shared feed reader is tested with stubbed responses. It has **never** fetched a real Job Bank feed. Check the first real run in the Health tab. |

### Partner feeds (`partner_feed`)

| | |
|---|---|
| File | `modules/jobsearch/sources/partnerFeed.js` |
| Status today | `requires_setup` ("PARTNER_FEED_URLS is not set") |
| Owner provides | `PARTNER_FEED_URLS` = comma-separated https URLs, one per partner (an employer, an agency, an ATS export) that has agreed in writing that you may read its vacancies and apply on candidates' behalf |
| Format accepted | JSON items with `id` (or `sourceJobId` / `jobId` / `url`), `title`, `url`, `employer` (or `company`), `location` (text or `{city, region, country}`), `country`, `publishedAt`, `closingAt` (or `validThrough`), `description`, `language`; or RSS 2.0 |
| Terms | Respect each partner's terms and rate limits. Keep the agreement on file. |
| Tested? | Yes, with stubbed network responses (`tests/js-sources.test.js`). Never against a real partner. |

If a feed URL contains an access key, treat the whole URL as a secret.

### Manual import (`manual_import`)

Works now. Staff with `jobsearch:write` add a vacancy in the admin console or with
`POST /jobsearch/jobs/manual` (`title` and `employerName` required; `url`, `location`, `country`,
`publishedAt`, `closingAt`, `description` optional). Text is sanitized and stored as data. Staff should
only enter vacancies they found through a legitimate channel, and keep the original URL.

### Test data (`test_fixture`)

Exists only when `NODE_ENV=test`. It is never registered on a real server.

## Mail

### Outgoing: SMTP (`MAIL_PROVIDER=imap_smtp`)

| | |
|---|---|
| File | `modules/jobsearch/mail/imapSmtp.js` |
| Status today | Sandbox in use (`MAIL_PROVIDER` unset). The SMTP adapter reports `requires_setup`. |
| Owner provides | `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_USER`, `MAIL_SMTP_PASS`, `MAIL_FROM`, `MAIL_REPLY_TO`; and, in this build, `MAIL_IMAP_HOST`, `MAIL_IMAP_USER`, `MAIL_IMAP_PASS` (checked but not used). Then `MAIL_REAL_SEND=true`. |
| Suitable accounts | A mailbox on your own domain at your mail host (e.g. a Hostinger mailbox, Google Workspace, or a transactional provider's SMTP relay). Use an app password if the provider offers one. Configure SPF, DKIM and DMARC for the domain. |
| Not supported | OAuth sign-in (Gmail/Microsoft OAuth) is not implemented; SMTP with a password or app password only. |
| Until then | Nothing leaves the server. Candidate sign-in codes and applications are recorded in `js_sandbox_mail` only. |
| Tested? | Only the sandbox and the "refuses to send unless `MAIL_REAL_SEND=true`" path. **No real e-mail has been sent.** |

Supported submission channel: **e-mail only**. Automatic mode sends only to the employer's verified
contact address or an address at its verified domain. With human approval, the single address named in the
ad may be used, and the approver sees it first. Online portals, forms, logins, CAPTCHAs, payments,
declarations and custom questions are handed to staff as tasks.

### Reading a mailbox (IMAP)

Not implemented (`poll()` throws `NOT_IMPLEMENTED`; there is no IMAP client library in the project).
Replies must come through the inbound webhook below.

### Inbound webhook and bridge

| | |
|---|---|
| Endpoint | `POST https://YOUR-HOST/jobsearch/inbound/mail` |
| Status today | Returns 503 until `INBOUND_MAIL_SECRET` is set |
| Owner provides | `INBOUND_MAIL_SECRET` (random, 32+ bytes) shared only with the bridge; a bridge that receives mail for `MAIL_REPLY_TO` and posts it as JSON with `X-VITA-Signature: sha256=<HMAC of the raw body>`; `INBOUND_AUTHSERV_ID` = your receiving server's id |
| Contract | Message JSON and delivery-status JSON: see SETUP.md section 10.2 |

Bridge options (the owner picks and configures one; none is set up):

- **Your mail host's forwarding or webhook feature** (for example, a Hostinger or Google Workspace mailbox
  that forwards to a small relay script, or a mailbox webhook if the host offers one). The relay converts
  each message to the JSON contract, adds your server's Authentication-Results, signs it and posts it.
- **An inbound-parse service** (for example SendGrid Inbound Parse or Mailgun Routes) receiving mail for a
  reply subdomain. A small adapter maps its fields to the contract and signs the body.

Whatever you use, the bridge must (1) only forward Authentication-Results produced by **your** receiving
server and drop any that arrived with the message, and (2) send `delivery_status` events only from genuine
provider delivery notifications, because `action: "delivered"` confirms a submission.

## ClamAV

| | |
|---|---|
| File | `modules/jobsearch/scan.js` |
| Status today | Not configured: every upload is `scan_unavailable` |
| Owner provides | A clamd daemon reachable over TCP (`CLAMAV_HOST`, `CLAMAV_PORT` default 3310), e.g. the `clamav-daemon` package on the same server listening on 127.0.0.1, with signature updates (`freshclam`) running |
| Behaviour | `clean` → stored; `infected` → refused (422) and audited; scanner unreachable → `scan_unavailable`, stored, shown honestly |
| Risk until then | CVs that were never scanned can be attached to applications |
| Tested? | With a fake scanner only |

## AI model (LLM) key

Not implemented. CV extraction (`modules/jobsearch/extract/deterministic.js`), cover letters
(`coverLetter.js`) and reply summaries/drafts (`draftService.js`) are rule-based templates. There is an
internal hook in `draftService.js` (`setGenerator`) that could later accept a model, but nothing calls an
AI service and no key variable exists. Do not add a key expecting a change in behaviour.

## WhatsApp / Meta

Not part of this module and out of scope. Candidate and employer communication here is e-mail only.

## Calendar

Internal appointments only (`js_appointments`, `modules/jobsearch/calendar.js`): tentative until the
candidate confirms availability, explicit time zone, no double booking per staff member. There is no sync
with Google Calendar, Outlook or any external calendar, and no invitations are sent to employers.

## Domain and HTTPS

The owner's hosting: a domain or subdomain pointing at the server, HTTPS through a reverse proxy (SETUP.md
section 9), firewall rules. Nothing has been deployed by this project.
