# VITA employer and agency portals — setup and daily use

Related: [CHECKLIST.md](CHECKLIST.md) · [../vita-job-search/SETUP-HOSTINGER.md](../vita-job-search/SETUP-HOSTINGER.md) · [../vita-website-crm/SETUP.md](../vita-website-crm/SETUP.md)

## 1. What this adds

- `https://<your-address>/vita/employer.html` for partner employers and `https://<your-address>/vita/agency.html` for partner agencies. Both sign in with an e-mail code, like the candidate portal.
- In the staff console (`/vita/admin.html`): the tabs **Organisations** and **Employer requests**.
- The database migration (013) is applied by the normal start-up; nothing to run by hand.

## 2. Settings (both optional)

Put them in `.env` (they are listed, commented out, in `trust-crm/.env.example` and `deploy/hostinger/.env.production.example`) and restart the app.

| Variable | Default | Meaning |
|---|---|---|
| `EMPLOYER_REQUESTS_PER_DAY` | 20 | Recruitment requests one employer can send per day. Over it the portal answers 429 with a wait time. |
| `AGENCY_CANDIDATES_PER_DAY` | 50 | Candidates one agency can register per day. Same behaviour. |

A value that is not a whole number above zero is ignored and the default is used.

## 3. Who can do what (staff)

- Create, edit, invite, suspend and reactivate organisations; review requests; record or withdraw consent; present: **SuperAdmin, Admin, Manager**.
- Read organisations, requests and presentations: also **Receptionist**.
- Presenting also needs access to the candidate (a Manager only sees the candidates assigned to them).
- Agents, Accountants, HR and candidates have no access to these functions. Employer and agency users can only use their own portal.

## 4. Create, invite and suspend

1. **Organisations** tab, choose Employers or Agencies, **New**: name, contact, e-mail, country.
2. Open it and press **Invite**: enter the person's e-mail and full name. The system creates the portal user, links it to the organisation and e-mails a first sign-in code (valid 10 minutes, single use). One portal user per e-mail; a second invite for the same e-mail is refused.
3. The person opens the portal page, enters the e-mail, asks for a code if the first one expired, and signs in. Codes can be requested again after 60 seconds.
4. **Suspend** blocks the organisation at once: every open session of its users stops working and nobody can sign in. **Reactivate** lets them sign in again with a new code; old sessions stay dead.

Invites need a working mail provider (`MAIL_PROVIDER` and the sender settings, see the job-search setup). With the sandbox provider no real person receives anything.

## 5. How presenting a candidate works, step by step

1. The employer sends a request (title, country, description, positions...). It starts as *submitted* and can be edited or cancelled by the employer until staff open it.
2. In **Employer requests**, open it and set the status to **in review** (or *accepted*). Optional: write an internal note (never shown to the employer) and a note the employer can read. You can create a **draft** website job from the request; it is never published automatically.
3. Open the candidate and **record the share consent** for that employer: the basis (for example "signed form 2026-10-01") is required. Without an active consent, presenting is refused.
4. In the request, choose the candidate and **Preview**. The preview is exactly what the employer will see (section 6). If the candidate has no confirmed job-search profile, enter the six values by hand.
5. Add an optional note for the employer and press **Present**. The summary is frozen at that moment; later profile changes do not alter it. The same candidate can be presented to the same request only once.
6. The employer sees the candidate under *Presentations* (after a page reload) and answers **interested**, **interview** or **not suitable**, with an optional note. They may change their answer.
7. Staff see the answers in the *Presentations* list of the request and under `GET /crm/presentations`.
8. To stop sharing: **withdraw the consent** (the candidate disappears for that employer at once and cannot be answered) or **withdraw the presentation**.

## 6. What an employer sees, and what never leaves

Shared, nothing else: **profession, years of experience, languages (with level), country of residence, availability, and your note for the employer.** Plus the employer's own requests, their statuses and the notes you marked as visible.

Never shared with an employer: name, date of birth, nationality details, passport number, e-mail, phone, address, documents, the CV file, the candidate's id, internal staff notes, other employers' requests, other candidates, job-search applications and any other profile data (skills, education, employers of the past). The restriction is applied when the summary is built, again when it is stored, and again every time it is read.

An agency sees only the candidates it registered: name, profession, country, stage, a plain status word (for example "Interview") and the date. Not passport, documents, staff notes or whether the person already existed in VITA.

## 7. Agencies: what staff see

- A registered candidate arrives as a lead in the Leads tab with source *agency* and the agency's id. A candidate who already exists in VITA is stored as a normal lead for the agency, flagged for staff, and the agency gets the same answer as for a new one.
- Converting the lead keeps the agency link. Change the candidate's stage as usual; the agency sees the stage label.

## 8. What the owner must review or provide

- A real mail provider, so invites and codes reach real people.
- Legal review of the candidate sharing-consent wording, the employer terms and the portal disclaimers (Arabic, English, French).
- The list of partner employers and agencies to invite, and who on the staff owns each relationship.
- A decision on how long presentations and requests are kept (no automatic deletion exists).

Not included: contracts, payments, chat, automatic matching and agency bulk import.
