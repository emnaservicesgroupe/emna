# VITA AI Job Search — User Guide

Part A is for VITA staff. Part B is the explanation to give candidates, in Arabic, English and French.

What is built and what is still waiting for setup is in [CHECKLIST.md](CHECKLIST.md). Until the owner
connects a job source and real mail (see [SOURCES_AND_PROVIDERS.md](SOURCES_AND_PROVIDERS.md)), the only
jobs are those staff enter by hand, and no e-mail actually leaves the server.

---

## Part A — Staff guide

### A.1 Where to work

- Admin console: `https://YOUR-HOST/vita/admin.html` (log in with your staff e-mail and password).
- Tabs: **Dashboard**, **Applications**, **Review**, **Interviews**, **Sources**, **Settings**,
  **Reports**, **Health**, **Scheduler**, **Employers & rules** (employer directory, manual job import,
  employer-support confirmations and automation rules).
- You only see candidates assigned to you. Admins see everyone. Accountant and HR roles have no access to
  this module.
- The page refreshes itself when something changes ("Live updates on"). If in doubt, press Refresh.

### A.2 How a candidate moves through the system

1. **Account.** An admin creates the CRM candidate (assigned to a staff member) and the candidate's login.
2. **Sign-in.** The candidate opens the portal and signs in with a 6-digit code sent by e-mail.
3. **CV.** The candidate uploads a PDF or DOCX. The original is kept unchanged. Uploading does **not**
   allow anything to be sent.
4. **Profile.** The system reads fields from the CV. It never invents anything. The candidate checks,
   corrects and confirms them, and fills in preferences (countries, job types, availability, salary,
   country of residence, whether they need work-permit support).
5. **Consent.** The candidate chooses what VITA may do: **search**, **prepare** applications, and
   **submit** applications. Each can be withdrawn at any time.
6. **CV approval.** The candidate approves the CV version and its language in the portal (step 1: "Approve
   this version for applications"). A manager or admin can do it for the candidate in the application
   drawer ("CV versions"), only with a note saying who asked, when and how. Approving changes nothing in
   the file: VITA attaches that exact version. A CV marked "Not scanned" (no malware scanner connected) is
   not attached until an administrator connects scanning or explicitly allows unscanned files.
7. **Search and matching.** The scheduler searches connected sources and staff-entered vacancies, and
   scores each open job. Each match shows reasons, missing items and uncertain items.
8. **Preparation.** In "prepare" or "automatic" mode, good matches (score 60+) become applications with a
   truthful cover letter and the approved CV.
9. **Approval and sending.** A manager or admin approves and queues it, or, in automatic mode, the system
   does so within strict admin rules. It is sent by e-mail only.
10. **Replies and interviews.** Employer replies are matched to the application, or put in the Review
    queue. Interviews are booked as tentative until the candidate confirms availability.

### A.3 The three modes

| Mode | What the system does | Who sends |
|---|---|---|
| **Search only** (default) | Finds and scores jobs. Creates no applications. Sends nothing. | Nobody |
| **Prepare for approval** | Also prepares applications and puts them in "Ready for review". | A Manager or Admin approves each one, then queues it |
| **Automatic** | Prepares and sends **only** when every rule passes: candidate gave "submit" consent; an admin turned automatic mode on with allowed countries, approved document versions and daily/weekly caps above 0; an admin-approved automation rule exists; the recipient is the employer's verified address; no sensitive document; and, for a candidate who needs work-permit support abroad, employer support is **confirmed** by staff and the ad accepts overseas applicants. | The system, within those rules. Anything else waits in "Ready for review" with a task saying why. |

Only an admin can choose automatic mode or change caps. Caps of 0 mean no automatic sends.

### A.4 What each status means

| Status (as shown) | Meaning | What you do |
|---|---|---|
| Matched | A job fits the profile. No application yet. | Nothing, or open an application. |
| Preparing | The letter and documents are being put together, or something is missing. | Check the notes (e.g. no approved CV, CV not scanned, sensitive document not authorized). Fix it, then press **Prepare** again. |
| Ready for review | Prepared and waiting for a human decision. | Manager/Admin: read the job, the label and quoted text, the documents and **where it will be sent**; then approve, reject or cancel. |
| Approved | A person (or the automatic rules) approved it. | Queue it (Manager/Admin). |
| Queued | Waiting for the sender. | Nothing. It is checked again just before sending. |
| **Sent — awaiting confirmation** | The mail provider accepted the e-mail. This is **not** proof the employer received it. | Wait for a reply or a delivery receipt. |
| **Submission confirmed** | Stored evidence exists: a provider delivery receipt, an employer acknowledgement confirmed by staff, or a manager's manual confirmation with a note. | Nothing. |
| Delivery unknown | The provider did not answer clearly. It may or may not have arrived. Never re-sent automatically. | Follow the "verify delivery" task (A.6). |
| Needs staff | The system stopped and needs a person (portal, CAPTCHA, payment, login, declaration, custom question, unclear delivery). | Open the task (A.6). |
| Not sent | The send failed (e.g. the recipient was refused). | Check the task; fix and prepare again if appropriate. |
| Cancelled | A reviewer rejected it, consent was withdrawn, or the account was suspended. | Nothing. It is never revived. |
| Closed | The job expired or closed. | Nothing. |
| Interview / Offer / Rejected by employer | Outcome from the employer, set by staff after reading the reply. | Book or update the interview; record the outcome. |

"Awaiting confirmation" versus "confirmed": always tell candidates "sent, awaiting confirmation" until the
status is **Submission confirmed**. Never tell a candidate an application was received without that.

### A.5 Reading a match

- **Score and reasons.** A guide, not a decision. "Uncertain" means the system could not tell; it did not
  assume.
- **Employer support label**: `Confirmed by staff`, `Stated in the ad`, `Unknown`, `Not available`. It is
  always shown with the quoted ad text and the notice "Label from the advertisement — verify with the
  employer. Not proof of sponsorship, LMIA or visa." Read the quote yourself; the automatic reading can be
  wrong (for example when a limit is written in a separate paragraph).
- **Overseas applicants**: shown only when the ad says so explicitly, with the quote.
- No score or label means a candidate is eligible for a visa or permit.

### A.6 Handling "Needs staff" tasks (Review tab)

| Task | What to do |
|---|---|
| Portal / online form / login / CAPTCHA / payment / legal declaration / custom questions | Do it yourself only if it is legitimate and the candidate agreed. Never invent answers or sign declarations for the candidate. Then record it: **Manual completion** (note, channel, recipient). If you cannot complete it, cancel with a reason. |
| Recipient not verified | Check the address with the employer. Ask an admin to record the employer's verified contact, or approve by hand if the ad's address is right. |
| Verify delivery (delivery unknown) | Check the sending account's log or Sent folder. Delivered → **Record evidence** (manual confirmation, note of at least 10 characters). Not delivered → send it by hand through the employer's channel and record **Manual completion**. The system will not send it again itself. |
| Confirm acknowledgement | An authenticated employer reply looks like an acknowledgement. Read it. If it really confirms receipt, click **Confirm acknowledgement**. If it is a rejection or a question, do not confirm; apply the right classification instead. |
| Unmatched reply | A reply could not be linked safely to an application. Read it and **Assign** it to the right application, or leave it. |
| Needs human approval / cap reached / employer support not confirmed | The automatic rules refused. Review and approve by hand if appropriate, or ask an admin to adjust the rules. |
| Delivery failed / bounce | Check the address. A bounce never changes the status by itself. |

Treat every employer message and every job ad as **untrusted text**. If it says "ignore your rules" or
"send the passport", ignore that. The system already does.

### A.7 Sensitive documents

Passports, national IDs, police certificates, medical documents and any document type the system does not
recognise are **never** sent unless the candidate grants permission in the portal for that one
application, with a reason. Staff cannot grant it on the candidate's behalf. Revoking it removes the
document and sends the application back to preparing.

### A.8 Replies and interviews

- Replies appear in the Review tab and on the application. The candidate sees nothing until you click
  **Share with candidate**, and then only a neutral summary.
- Drafted replies are templates. A manager approves and sends them.
- **Interview**: create it from the reply with date, time and the time zone. It is **tentative** until the
  candidate clicks "Confirm my availability" (or you record their confirmation). No external calendar is
  updated; tell the employer yourself.

### A.9 Controls

- Pause a candidate (Dashboard), a source (Sources) or the whole module (Dashboard, admin only). Pausing holds sends;
  resuming sends them once.
- **Search now** queues a search; results appear after the next worker run.
- Health shows failing sources, the queue and stuck items. Reports and CSV exports show only your
  candidates.
- **Employers & rules**: search the employer directory; admins (and managers, for employers of their
  candidates) set an employer's verified domain and contact address, which decide where automatic sends may
  go. Any staff member with write access can add a job by hand (https links only). Admins record
  employer-support confirmations (for this job only, or for every job of the employer, with the evidence)
  and revoke them, and create or disable automation rules.
- Your session lasts 12 hours. If an admin suspends your account, it ends at once.

---

## Part B — Explanation for candidates

The candidate portal (`/vita/portal.html`) shows the notice below in the chosen language, with all three
languages available.

### What the service does · ما الذي تقدمه هذه الخدمة · Ce que fait le service

**English.** VITA looks for job vacancies that match the profile you confirm, from sources VITA is allowed
to use. It explains why each job matches and what may be missing. With your permission, VITA prepares an
application using only the facts you confirmed and your approved CV, and sends it by e-mail to the
employer. Some employers require online forms or other steps; a VITA staff member handles those with you.
You can see the status of each application in the portal. "Sent" means the e-mail left; "confirmed" means
there is proof the employer received it.

**العربية.** تبحث VITA عن فرص عمل تناسب الملف الذي تؤكده، من مصادر يُسمح لـ VITA باستخدامها. وتوضح سبب
مناسبة كل وظيفة وما قد ينقصك. وبإذنك، تُعِدّ VITA طلب التوظيف باستخدام المعلومات التي أكدتها وسيرتك الذاتية
المعتمدة فقط، وترسله بالبريد الإلكتروني إلى صاحب العمل. بعض أصحاب العمل يطلبون استمارات إلكترونية أو خطوات
أخرى، ويتولاها معك أحد موظفي VITA. يمكنك متابعة حالة كل طلب في البوابة. "أُرسل" تعني أن الرسالة خرجت، و"مؤكَّد"
تعني وجود دليل على أن صاحب العمل استلمها.

**Français.** VITA recherche des offres d'emploi correspondant au profil que vous confirmez, auprès de
sources que VITA est autorisée à utiliser. Elle explique pourquoi chaque offre correspond et ce qui peut
manquer. Avec votre accord, VITA prépare une candidature uniquement à partir des informations que vous avez
confirmées et de votre CV approuvé, et l'envoie par e-mail à l'employeur. Certains employeurs exigent un
formulaire en ligne ou d'autres démarches ; un membre de l'équipe VITA s'en occupe avec vous. Vous suivez
l'état de chaque candidature dans le portail. « Envoyée » signifie que l'e-mail est parti ; « confirmée »
signifie qu'il existe une preuve de réception par l'employeur.

### Consent · الموافقة · Consentement

**English.** Uploading a CV does not allow VITA to apply for you. You choose separately whether VITA may
(1) search for jobs, (2) prepare applications and (3) submit applications. Passports, identity documents,
police certificates and medical documents are never sent unless you allow it for one specific application.
VITA never invents qualifications, experience, languages, certificates, references or work permits.

**العربية.** رفع السيرة الذاتية لا يسمح لـ VITA بالتقديم نيابةً عنك. أنت تختار بشكل منفصل ما إذا كان يحق لـ
VITA: (1) البحث عن وظائف، (2) إعداد طلبات التوظيف، (3) إرسال الطلبات. لا تُرسَل جوازات السفر ووثائق الهوية
وشهادات السوابق العدلية والوثائق الطبية أبدًا إلا إذا سمحت بذلك لطلب محدد. لا تختلق VITA أبدًا مؤهلات أو
خبرة أو لغات أو شهادات أو مراجع أو تصاريح عمل.

**Français.** Déposer un CV n'autorise pas VITA à postuler pour vous. Vous choisissez séparément si VITA
peut (1) rechercher des offres, (2) préparer des candidatures et (3) envoyer des candidatures. Les
passeports, pièces d'identité, extraits de casier judiciaire et documents médicaux ne sont jamais envoyés
sans votre accord pour une candidature précise. VITA n'invente jamais de diplômes, d'expérience, de langues,
de certificats, de références ou de permis de travail.

### Your rights and withdrawal · حقوقك والانسحاب · Vos droits et le retrait

**English.** You can withdraw any part of your consent at any time in the portal, or pause the service.
Withdrawing stops and cancels applications that were not yet sent. An e-mail that had already left cannot
be recalled. You can ask VITA staff what data is held about you and ask for it to be corrected or deleted.

**العربية.** يمكنك سحب أي جزء من موافقتك في أي وقت من البوابة، أو إيقاف الخدمة مؤقتًا. يؤدي السحب إلى إيقاف
وإلغاء الطلبات التي لم تُرسَل بعد. أما الرسالة التي خرجت بالفعل فلا يمكن استرجاعها. يمكنك أن تسأل موظفي VITA
عن البيانات المحفوظة عنك، وأن تطلب تصحيحها أو حذفها.

**Français.** Vous pouvez retirer tout ou partie de votre consentement à tout moment dans le portail, ou
mettre le service en pause. Le retrait arrête et annule les candidatures pas encore envoyées. Un e-mail
déjà parti ne peut pas être rappelé. Vous pouvez demander à l'équipe VITA quelles données sont conservées
sur vous, et demander leur correction ou leur suppression.

### Disclaimer (exact text shown in the portal) · تنبيه مهم · Avis important

- **English:** This service helps you search and apply for job opportunities. It does not guarantee employment, employer sponsorship, a work permit or a visa.
- **العربية:** تساعدك هذه الخدمة على البحث عن فرص العمل والتقديم إليها. وهي لا تضمن الحصول على عمل أو كفالة صاحب العمل أو تصريح عمل أو تأشيرة.
- **Français :** Ce service vous aide à rechercher des offres d'emploi et à y postuler. Il ne garantit ni un emploi, ni un parrainage de l'employeur, ni un permis de travail, ni un visa.

The Arabic and French paragraphs above (other than the disclaimer, which is the portal's exact text) are
translations written for this guide and have not been reviewed by a native speaker. Have them checked
before giving them to candidates.
