# VITA public website + CRM core — setup and daily use

For the person who runs the server and the staff who use the Leads and Site jobs tabs. The requirement status is in [CHECKLIST.md](CHECKLIST.md). Server installation (Hostinger VPS) is in [../vita-job-search/SETUP-HOSTINGER.md](../vita-job-search/SETUP-HOSTINGER.md).

**Nothing here has been run on a real server or domain yet.** Treat the first install as a trial.

## 1. What you get

- The public website at the domain root: `https://your-domain/` (Arabic, English, French). It links to the candidate portal (`/vita/portal.html`) and the staff console (`/vita/admin.html`).
- Public forms (candidate registration, employer inquiry, contact) that create **leads**.
- In the staff console: a **Leads** tab and a **Site jobs** tab, and a stage and history view for converted candidates.

The website never promises a job, sponsorship, a work permit or a visa, and shows no company fact you have not provided.

## 2. Settings (environment variables)

All are optional except the salt in production. On the Hostinger kit they go in `deploy/hostinger/.env`; for a manual run see `trust-crm/.env.example`.

| Variable | Meaning |
|---|---|
| `SITE_NAME` | Name shown on the site (default `VITA`). |
| `SITE_PHONE` | Phone number shown on the site. |
| `SITE_WHATSAPP` | A full `https://` link, for example `https://wa.me/21612345678`. |
| `SITE_EMAIL` | Contact e-mail shown on the site. |
| `SITE_ADDRESS` | Postal address shown on the site. **On the Hostinger kit use `SITE_POSTAL_ADDRESS` instead**: in that kit `SITE_ADDRESS` is the server host name for Caddy, and `docker-compose.yml` hands `SITE_POSTAL_ADDRESS` to the app as `SITE_ADDRESS`. |
| `SITE_LICENCE_TEXT` | Licence wording exactly as issued by the authority. Leave empty until you have it. Never invent one. |
| `SITE_BASE_URL` | `https://your-domain` without a trailing slash. Needed for the absolute URLs in `/sitemap.xml` and `/robots.txt`; without it the sitemap has relative paths only. |
| `SITE_IP_SALT` | Secret salt for the one-way hashes behind the lead rate limits. **Required in production**: without it the app logs a warning and falls back to an insecure built-in salt. Generate with `openssl rand -hex 32`. `deploy/hostinger/setup.sh` generates it for you (also for an older `.env` that lacks it). Changing it only resets the rate-limit counters. |
| `SITE_LEAD_IP_PER_HOUR` | Lead submissions allowed per IP per hour (default 5). |
| `SITE_LEAD_EMAIL_PER_DAY` | Lead submissions allowed per e-mail or phone per day (default 3). |
| `SITE_CONSENT_VERSION` | Label of the consent wording stored with each lead (default `2026-10-v1`). Change it whenever the consent or privacy wording changes. |

A fact that is empty is not shown at all (no empty labels). After changing `.env`: `docker compose up -d`.

The sitemap needs `SITE_BASE_URL`. On the sslip.io address, leave it empty or set it to that address.

## 3. How staff use it

Sign in at `/vita/admin.html`. Roles:

| Role | Leads | Site jobs |
|---|---|---|
| SuperAdmin, Admin | Everything, including assigning leads to staff | Everything |
| Manager, Receptionist | Read, change status, add notes, convert | Create, edit, publish, close |
| Agent | **Read-only**, and only the leads assigned to them (another lead looks like it does not exist) | No access |
| Accountant, HR, Candidate | No access | No access |

### Leads

1. Open the **Leads** tab. New leads are listed newest first; filter by status, kind, assignee or text. Spam (honeypot) leads are hidden unless you filter by the `spam` status.
2. Open a lead, call or write to the person, set the status (new, contacted, qualified, rejected, spam) and add notes. Notes and status changes are kept in a history that cannot be edited.
3. An **Admin** can assign a lead to an Agent or other staff.
4. For a **candidate** lead you can **convert** it: enter the passport number (required; the system refuses a passport that already exists). Tick "portal login" to let the person sign in to the candidate portal; this needs the lead's e-mail. Converting twice returns the same candidate and creates nothing new.
5. **Employer** and **contact** leads cannot be converted. They stay as leads (an employer record for stage 3 is not created yet).
6. After conversion, set the candidate's stage (lead, documents, submitted, interview, visa, travel, closed) from the candidate view; each change is written to the history.

**Portal login and e-mail.** The sign-in code is sent by the existing mail adapter. In the safe sandbox mode (the default), real addresses receive **nothing**: only allow-listed test addresses get a code, stored in the database (`./show-sandbox-mail.sh`). Candidates can sign in only after real mail is configured (`../vita-job-search/SETUP.md`, "Real e-mail"). If the mail cannot be sent, the conversion still succeeds and the screen says the invite was not sent.

**No e-mail notification for new leads.** It was not built (no mail provider). Someone must check the Leads tab regularly.

### Site jobs

1. Open **Site jobs** and create an offer. A draft is never public.
2. To **publish** you need a title, country, description and an **evidence note**: where the offer came from and when you checked it (up to 1000 characters). The note is for staff only and never appears on the website.
3. Only published offers that have not passed their closing date appear on the website, and only these fields: title, employer name, country, city, category, description, requirements, language requirements, employment type, salary text, how to apply, publication and closing dates.
4. **Close** an offer to remove it from the website at once. Do not publish an offer you cannot back with evidence: the website promises nothing but what you publish.

## 4. What is stored (privacy notes)

From a form: name, e-mail, phone, country, profession, company, message, language, the time of consent and the version of the consent wording. For visitors the site stores a **one-way salted hash** of the IP address (never the address itself, never the browser user agent) in the lead and in the rate-limit counters. Honeypot (spam) submissions store only the name, kind, language and the hash. The site sets no tracking cookie; the browser remembers only the language choice.

Staff actions (status, assignment, notes, conversion, publishing) are written to the history and to the audit log with the staff user.

There is **no automatic deletion**. Removing a person's data on request (the privacy page promises correction and deletion) is a manual task done by an administrator in the database today. Decide a retention period with your legal adviser before launch.

## 5. What the owner must review before real visitors

1. **Privacy and terms pages**: the wording is generic and written by the developers. Have it reviewed against the law that applies to you and to your visitors (data protection, consent, recruitment-agency rules in each destination country).
2. The standard disclaimer and the Arabic, English and French texts of every page.
3. The consent wording and `SITE_CONSENT_VERSION`.
4. The company facts (`SITE_*`) and the licence wording, taken from your real documents.
5. Domain and HTTPS (SETUP-HOSTINGER section 9), then `SITE_BASE_URL`.
6. Real mail, so portal logins can work, and decide whether you want a staff notification e-mail built.
7. A test of the whole path on the real server: submit a form from a phone, find the lead, convert, sign in as the candidate.

## 6. Quick check after install

1. `https://your-domain/` shows the site in a browser; `curl https://your-domain/` (no browser) shows the JSON status.
2. `https://your-domain/public/config` lists only the facts you set.
3. Submit the contact form; the lead appears in the Leads tab.
4. Publish a test offer with an evidence note; it appears on the Jobs page; close it; it disappears. Remove test leads afterwards.
