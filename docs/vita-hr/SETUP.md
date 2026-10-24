# VITA Attendance and HR — setup and daily use

Attendance and HR are part of the same VITA app: no extra service, container or database. They are switched on by migrations 018, 019 and 020, which run with the normal
update (`./update.sh` / app start). What was and was not verified: [CHECKLIST.md](CHECKLIST.md).

**Nothing is preloaded.** A new installation has no schedule, no leave type, no holiday and no balance. Leave rules, entitlements, holidays and working schedules are **your
data entry** (owner or HR); the platform does not know Tunisian labour law and does not guess it.

## 1. Settings (all optional)

Put them in `.env` (on the VPS: `deploy/hostinger/.env`), then `docker compose up -d`. Defaults apply when a line is absent.

| Variable | Default | Meaning |
|---|---|---|
| `HR_TIMEZONE` | `Africa/Tunis` | Company timezone (an IANA name such as `Africa/Tunis` or `Europe/Paris`). Clock times, "today", late and absent are computed in it. A schedule can carry its own timezone; otherwise this one applies. It must be an exact name known to the database (`SELECT name FROM pg_timezone_names`): POSIX-style values such as `UTC+1` and unknown names are refused with an error in the server log and `Africa/Tunis` is used instead. |
| `HR_MAX_OPEN_HOURS` | `16` | A clock-in left open longer than this many hours (1 to 168) is not closed automatically: clock-out is refused, the record is flagged "needs correction" in reports and the employee requests a correction. |
| `HR_EXPORT_MAX_ROWS` | `50000` (also the maximum) | Row cap per attendance CSV export. When more rows match, the file is cut and the response carries `X-Row-Limit-Hit: true`; narrow the dates and export again. |

## 2. Who can do what

| Role | Clock, own attendance, request leave/correction, own balances, team calendar | Approve leave and corrections | Employees, schedules, leave types, holidays, balances | Reports and CSV export |
|---|---|---|---|---|
| SuperAdmin, Admin | yes | everyone (not their own) | yes | yes |
| HR | yes | everyone (not their own) | yes | yes |
| Manager | yes | direct reports only | no | no |
| Receptionist, Accountant, Agent | yes (own records only) | no | no | no |
| Employer, Agency, Candidate (portals) | no | no | no | no |

Everyone with a staff role is an employee. Nobody can read a colleague's attendance, corrections or leave reasons. A request outside a manager's team looks like "not found".
Nobody approves their own request: an HR or Admin user's request is decided by another HR/Admin user; if there is none, it stays pending.
Likewise nobody changes their own balance, manager, schedule, status or employment data (HR, Admin and SuperAdmin included): another HR/Admin user does it. Phone and emergency contact can be edited by the person themselves through HR.

## 3. First-time setup (HR or Admin, in this order)

Open the **HR** tab of the console, then **HR admin**.

1. **Schedules.** Create at least one: name, the start, end and break minutes of each working day (leave Saturday/Sunday empty if they are days off) and the grace minutes
   (for example Mon-Fri 09:00-17:30, 60 min break, grace 10). Someone is "late" when the first clock-in of a working day is later than start + grace.
2. **Leave types.** For each kind of leave you grant: a short upper-case code (`ANNUAL`, `UNPAID`, `SICK`), names in Arabic/English/French, whether it is paid, whether it is
   **counted against a balance**, and whether it needs approval. Only counted types need a balance. Types are deactivated, never deleted.
3. **Public holidays.** Add each holiday date with its name, year by year (movable holidays change every year). A holiday is not a working day: it is not counted as leave, late or absent.
4. **Employee profiles and managers.** For every staff member create the profile: employee number, position, department, hire date, employment type, phone, emergency contact,
   **schedule** and **manager**. The manager must be an active staff user; this is who approves. Fill in **department** consistently (informational only: colleagues do not see each other's leave on the calendar). Without a schedule, nobody is expected, so there is no late/absent report for that person. Do not put salary, ID numbers or medical information in
   any field, including the HR-only notes.
5. **Balances.** For each employee, leave type and year set the entitled days (and adjusted days for carry-over or corrections, negative allowed). Used days are never typed: they are
   calculated from approved requests.

## 4. Day to day

**Employee** (every staff role): open **HR -> My work**. *Clock in* when you start, *Clock out* when you finish. Pressing the button twice is safe (the second press within a minute shows
the same record). If you forgot to clock, or the time is wrong, use *Request correction*: the day (today or up to 60 days back), the real in and out times and a reason. Nothing changes
until your manager or HR approves. For leave: *Request leave* -> type, dates, optional half days at the start/end, optional reason (keep it short and **do not write medical details**).
The system counts the working days itself (weekends and holidays excluded) and refuses a request that overlaps another or exceeds your balance. You can cancel a pending request, or an
approved one that has not started yet (the days come back).

**Manager:** **HR -> Team**. *Pending approvals* lists the corrections and leave requests of your direct reports with their reasons; approve or reject with an optional note. The *team
calendar* shows who is on leave (name, type, dates only). You cannot approve your own request or anyone who is not your report; ask HR.

**HR / Admin:** approve anything that is pending (including requests of managers and of each other), keep the data of section 3 up to date, and use **Reports**: the *attendance report*
for a date range (optionally one person): worked minutes, late days, absent days, holidays, leave days, open sessions flagged *needs correction*; the *leave report* per employee and type
for a year; and **Export CSV** (opens in Excel; text starting with `= + - @` is saved with a leading quote). Exports are logged. An open session flagged *needs correction* (a forgotten clock-out) is solved either by
the employee requesting a correction (approving it corrects the open record and the employee can clock in again), or by HR in **Admin -> Attendance report -> Open sessions**: *Close* with the real
clock-out time (within 24 hours of the clock-in, not in the future; audited). If a correction overlaps a closed record, the approval is refused and HR contacts the employee.

## 5. First check after installing (15 minutes)

Nobody has run this on your server yet. As HR: create one schedule, the leave types `ANNUAL` and `UNPAID`, one holiday, two profiles (an employee and a manager) and a balance of 18 days.
As the employee: clock in and out, request a correction and a leave across a weekend, and check the day count. As the manager: approve both and open the team calendar. As HR: open the
attendance report and export the CSV in Excel. Then check the Arabic interface once and open the HR tab on a phone.

## 6. Privacy notes

- Stored: working time (clock in/out instants, server time), corrections and leave requests with the free-text reasons the employee wrote, a profile (position, department, dates, phone,
  emergency contact, manager, schedule, HR notes), leave balances. **Not stored:** salary, payroll, ID or passport numbers, medical data, performance data, location, photos, biometrics.
- Who sees what: the employee sees their own data; a manager sees direct reports' pending requests and reasons; HR/Admin see everything; the calendar, reports and CSV never contain
  leave reasons, correction reasons or decision notes. HR-only profile notes are returned only to HR/Admin and are never shown in the employee's own view or in the audit log text.
- Every change is audited (who, what, when). There is **no automatic deletion or retention limit**: how long to keep attendance and leave records, and the notices and legal basis for
  processing employee data, must be decided with your lawyer or the data-protection authority before real use (see CHECKLIST.md).
- Backups: HR data lives in the same Postgres database as everything else, so `./backup.sh` already covers it. Treat backups and CSV exports as personal data.
