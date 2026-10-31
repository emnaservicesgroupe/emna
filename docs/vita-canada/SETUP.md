# VITA Canada service layer — setup and daily use

The Canada features are part of the same VITA app: no extra service, container or database. They are switched on by migrations 025-030, which run when the app starts (`./update.sh` on the
Hostinger kit). Everything is **off or empty until staff use it**: nothing is billed, sent or scheduled by itself. What was and was not verified: [CHECKLIST.md](CHECKLIST.md).

## 1. Settings (all optional)

Put them in `.env` (on the VPS: `deploy/hostinger/.env`), then `docker compose up -d`. Defaults apply when a line is absent. The commented lines are in `trust-crm/.env.example` and `deploy/hostinger/.env.production.example`.

| Variable | Default | Meaning |
|---|---|---|
| `REPORT_TIMEZONE` | `HR_TIMEZONE`, then `Africa/Tunis` | Time zone in which report days are cut and dates printed. An exact name from `SELECT name FROM pg_timezone_names` (`Africa/Tunis`, `America/Toronto`); `UTC+1` or a wrong-case name is ignored (logged) and the next fallback is used. An Administrator can override it in the console (**Reports** -> report settings); the stored value wins over the variable. |
| `REPORT_SCHEDULE_ENABLED` | `false` | Create daily, weekly and monthly company report snapshots automatically (previous full period, once per period). The Administrator setting in the console wins over this seed. |
| `JOBSEARCH_REPORT_MAX_ROWS` | `2000` (maximum 20000) | Rows per generated report. A longer report is **refused** with 413, never cut: narrow the dates. |
| `JOBSEARCH_REPORT_RATE_PER_HOUR` | `30` | PDF/Excel generations per user per hour (in memory, per process); beyond it the API answers 429 with `Retry-After`. |
| `FIN_DEFAULT_JURISDICTION` | empty | Jurisdiction used by the candidate-fee billing gate when a candidate has no desired province: `CA-ON`, `CA-QC` ... or a country code. Empty = such a candidate cannot be billed for a candidate-fee service (`jurisdiction_unknown`). It never replaces the legal review. |
| `MAX_UPLOAD_MB` (existing) | `10` | Also the size limit of a signed-contract document. |

Already existing and used by the reports: `HR_TIMEZONE`, `FIN_COMPANY_NAME` (else `SITE_NAME`), `FIN_COMPANY_ADDRESS`, `SITE_EMAIL`, `SITE_PHONE` (the report header shows **only** the facts that are set; nothing is invented), and
`MATCH_MIN_SCORE` / `MATCH_AUTO_PREPARE_MIN` (matching). `JOBSEARCH_EXPORT_*` limit the older CSV exports only.

## 2. Who can do what

| Action | Roles |
|---|---|
| See a candidate's reference, Canada file, Canadian CV, reports | Admin/SuperAdmin: all candidates. Manager, Receptionist, Agent: assigned candidates only (anything else looks like "not found"). HR, Accountant: no candidate data. |
| Generate a Canadian CV, classify a vacancy, add a do-not-contact entry | staff with job-search write access in scope (Agent, Receptionist, Manager, Admin) |
| Approve a Canadian CV version, accept or reject a match | Manager or Admin in scope (**not** Agent or Receptionist) |
| Authorise or withdraw a Canadian CV, download own report, see own contracts | the candidate, for themselves only |
| Edit an employer, remove a do-not-contact entry (with a reason), switch `require_match_acceptance`, report settings, record a legal review, create a candidate-fee service | Admin/SuperAdmin only |
| Create and sign contracts, invoices, payments | Accountant (and Admin); Manager can read |
| Everything above | Employer, Agency tokens: never |

## 3. Daily use, screen by screen

The steps use the English labels of the console (tab names in **bold**); French and Arabic labels have the same meaning.

### 3.1 New candidate and reference
1. An Administrator creates the candidate as before (and the candidate account, so the candidate can sign in with an e-mail code). The reference `CAN-YYYY-NNNN` appears on the candidate card and in the candidate's **My Canada file**.
2. Staff fill the Canada file on the candidate card: city, WhatsApp, work-authorization status, relocation readiness, **desired province** (this decides the billing jurisdiction), service start date. The candidate can edit only city, WhatsApp, relocation readiness and desired province.

### 3.2 What "confirmed profile" means
The candidate uploads a CV; the platform **extracts** fields from it (name, profession, skills, experience, education, certificates, languages). Nothing from the extraction is used for a Canadian CV until the **candidate has reviewed
it, corrected anything wrong and pressed Confirm** (`profile/confirm`). The Canadian CV then uses **only the confirmed values**: it never reads the unconfirmed extraction, the date of birth, nationality, passport number or any other field of
the candidate record. If the profile is unconfirmed, generation is refused. If the candidate changes the confirmed profile later, older CV versions no longer match and are not attached to new applications until a new version is generated, approved and authorised.

### 3.3 Canadian CV (candidate card -> **Canadian CV**)
1. **Generate a new version** (choose English or French, PDF and DOCX). The result lists anything missing (for example "no education", "dates missing on entry 2", "latin spelling needed"); fix the profile with the candidate, then generate again. Every generation is a new version; nothing is overwritten.
2. Open and read both files (download buttons). A Manager or Admin presses **Approve this version** (PDF and DOCX are approved together).
3. The candidate opens **My Canada file**, reads the files and presses **Authorise**. They can withdraw the authorisation at any time: use stops at once and queued applications using that version are cancelled.
4. When staff prepare an application, the package shows the exact Canadian CV that will be attached. If no version is both approved and authorised, the approved uploaded CV is used with a note.

### 3.4 Vacancies, classification and matches (tabs **Applications**, candidate card -> **Matches**)
1. A match shows its score, band (Strong >= 85, Good >= 70, Manual review >= 50, Not recommended) and the reasons. The vacancy classification is shown with its quoted evidence and the notice that it is **not proof of an LMIA, sponsorship or eligibility**.
2. To classify a vacancy as "Foreign applicants stated", paste a sentence that appears **word for word** in the advertisement; a paraphrase is refused. "Prospective, no vacancy" and "Closed or unsuitable" need a note. A staff classification stays until it is cleared.
3. A Manager or Admin presses **Accept** or **Reject** on a match (with an optional internal note the candidate never sees).
4. If an Administrator turned on **require match acceptance** (an Administrator-only switch in the candidate card's **Matches** section), an application can only be prepared for an accepted match, and the scheduler stops creating applications for unaccepted ones.
5. Prepare -> Approve -> Queue as before. Approval and queueing are refused for a suppressed recipient or an opted-out employer.

### 3.5 Employers and the do-not-contact list (tabs **Employers & rules** and **Do-not-contact list**)
1. An Administrator keeps the employer record up to date (province, city, industry, contact, source links, status, internal notes).
2. The employer's **history** shows your candidates' applications, replies and sends, and a bare number for other staff's candidates. Read it before preparing another application at the same company.
3. When an employer replies "remove us from your list" (and the reply is matched and authenticated), the platform adds the sender to the list, marks the employer **opted out** and opens a task for the responsible staff member. Read the reply, tell the candidate neutrally, and take no further action toward that employer.
4. Staff can add an address or a domain by hand (not a shared suffix such as `co.uk`). Only an Administrator can remove an entry, and must give a reason. Nothing sends to a listed address or an opted-out employer, whoever approves it.

### 3.6 Reports (tab **Reports**, candidate card -> **Reports**)
1. Company reports: choose daily, weekly, monthly or a custom range (366 days at most) and PDF or Excel. The header shows the time zone and only the company facts you configured.
2. Candidate "Canada Job Search Activity Report": generated from the candidate card, or downloaded by the candidate in **My Canada file**. It lists **only applications actually sent** with their evidence reference, plus pending items, replies, interviews and next planned actions, and carries the disclaimer that it promises no job, LMIA, permit or visa.
3. **History of generated reports** lists the stored snapshots you are allowed to see. A report is a snapshot: later changes in the data do not alter an old one.
4. PDF limits: Arabic and other non-Latin text cannot be drawn in the PDF (shown as `[?]` with a notice); use the Excel file, which keeps the original text. The Arabic PDF disclaimer falls back to English.

### 3.7 Contract and billing (candidate card -> **Contract & billing**, tab **Accounting**)
1. An Administrator creates the **service** in the **Accounting** tab (Services) with kind **candidate fee** (only an Administrator can set that kind) and enters the owner's own price. Nothing is preloaded.
2. **Recording a legal review** (Administrator, in the candidate card's **Contract & billing** panel): choose the jurisdiction (`CA-ON`, `CA-QC` ... matching the candidate's desired province, or a country code), the status (**approved**, **pending** or **prohibited**), the reviewer's name and role, the date of the review, an optional "valid until" date, an optional internal note and an evidence reference (file name; the file itself is kept by you). The platform **records** what your lawyer or adviser decided. It does not judge, check or give legal advice. Records are never edited: record a new one to supersede the old (the newest by review date decides). Record `prohibited` to stop billing again.
3. The Accountant creates the candidate's **contract** for that service in the same panel (refund terms as agreed), then signs it (name of the signer, optional scan of the signed paper). Only an **active, signed** contract for that very service counts.
4. **What the gate means.** A candidate-fee line can be put on an invoice, and a **new payment** recorded on such an invoice, only when **both** hold: an approved, unexpired legal review exists for the candidate's jurisdiction, **and** the candidate has an active signed contract for that service. Otherwise the screen says "billing disabled" with the missing item and the API answers 409 (`legal_review_required`, `service_contract_required`, `jurisdiction_unknown`) or `candidate_fee_prohibited`. Refunds and voids are always possible. Standard services (translation, etc.) and employer-funded arrangements are never affected. The old invoice screen cannot be used to bill a candidate who has an active fee contract.
5. The candidate sees their own non-draft contracts in **My Canada file**, nothing else of accounting.

## 4. Known limits

See [CHECKLIST.md](CHECKLIST.md) sections 2-6 for the full list: Arabic PDF limits, report/CSV/mail time zones, mail attachment names, snapshots and files of an erased candidate (no erasure path yet), domain suppression without a public-suffix list, hard-bounce over-suppression
(5.2.2, 5.7.x), guard codes visible in a candidate's timeline, snapshot visibility rules, sticky classifications, prospective outreach blocked by design.
