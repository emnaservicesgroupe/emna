# VITA Attendance and HR — checklist

Status of Stage 5 (attendance and HR). Spec: [../superpowers/specs/2026-10-24-vita-attendance-hr-design.md](../superpowers/specs/2026-10-24-vita-attendance-hr-design.md).
Legend: **completed** = built; **tested** = a test proves it (file named); **blocked** = not done or not provable here.

**Honest summary.** Everything below was checked with automated tests on a real Postgres schema and a real in-process HTTP server (`app.listen(0)` + `fetch`,
real `/auth/login`, a candidate through the real e-mail OTP, no network, a fixed test clock). **Nothing was run on a real server, a real domain, a real
mailbox or a real phone/browser by this checklist.** Run the first-use check in [SETUP.md](SETUP.md) section 5 on your own installation before relying on it.

## Hard rules of the spec

| Requirement | Status | Evidence |
|---|---|---|
| No salary, payroll, payslip, national-ID/passport number, medical detail or performance data is stored | completed | Migration 018/019 hold only the fields listed in the spec (`hr_employees`: position, department, dates, phone, emergency contact, manager, schedule, notes). Tested by name: `tests/hr-e2e.test.js` A1 asserts no HR table has a salary/pay/ID/medical/location/biometric/performance column (a name match, not a proof about free text). Leave `reason` and HR `notes` are free text people type: tell staff not to write medical details there (SETUP.md section 6) |
| No GPS, photo or biometric capture; clock events are server-timestamped only | completed, tested | The clock routes accept no time, place or image from the client; the instant is the database clock (`tests/hr-attendance.test.js`, `tests/hr-e2e.test.js` B1). The `X-Test-Now` header is honoured only when `NODE_ENV=test` |
| No labour-law rule is invented or preloaded: leave types, entitlements, schedules and public holidays are owner/HR data entry | completed | A fresh install has zero schedules, leave types, holidays, profiles and balances (`tests/hr-e2e.test.js` A1); the console lists are simply empty until HR fills them. **You** enter everything (SETUP.md section 3) |
| Timestamps are `timestamptz`, shown in the company timezone (`HR_TIMEZONE`, default `Africa/Tunis`), day boundaries computed in SQL | completed, tested | `tests/hr-attendance.test.js` (midnight boundaries), `tests/hr-e2e.test.js` B1 (09:25 Tunis stored as 08:25Z, shown 09:25) |
| Every mutation is audited; attendance is changed only by approved correction entries | completed, tested | `tests/hr-attendance.test.js`, `tests/hr-leave.test.js`; `tests/hr-e2e.test.js` B3/B4/E2 (refused clock-out, correction, export audited) |

## Data (migration 018, 019)

- [x] completed, tested: additive and idempotent; one open session per user (partial unique index); `clock_out > clock_in`; no overlapping intervals per user
      (exclusion constraint, or the trigger fallback when `btree_gist` is unavailable); leave overlap guard; balance table unique per (user, type, year). `tests/hr-schema.test.js`.
- [x] completed, tested: permissions `hr:read`, `hr:write`, `hr:approve` and the role matrix. `tests/role.test.js`, `tests/hr-schema.test.js`.

## APIs and rules (spec section 4)

| Requirement | Status | Test file |
|---|---|---|
| Employee profiles, schedules, leave types (deactivate, never delete), holidays, balances; validation; manager cycles refused | completed, tested | `tests/hr-admin.test.js`, `tests/hr-e2e.test.js` A1 |
| `GET /hr/me` works with defaults for a user without profile | completed, tested | `tests/hr-admin.test.js` |
| Clock in / out; the same click twice within 60 s is replayed, a real double clock-in is 409; clock-out without clock-in is 409 | completed, tested | `tests/hr-attendance.test.js`, `tests/hr-e2e.test.js` B1, B2 |
| A session open longer than `HR_MAX_OPEN_HOURS` (default 16) is never closed silently: clock-out refused with `needs_correction`, reports flag it | completed, tested | `tests/hr-attendance.test.js`, `tests/hr-e2e.test.js` B3, E1 |
| Concurrency: 10 parallel clock-ins leave one record | completed, tested | `tests/hr-attendance.test.js`, `tests/hr-e2e.test.js` G1 |
| Correction request -> approver decides -> one attendance row created atomically; decided once; overlap with existing attendance is 409 | completed, tested | `tests/hr-attendance.test.js`, `tests/hr-e2e.test.js` B4 |
| Leave: working days counted server-side from schedule minus holidays (weekend + holiday exact), half days, overlap guard, balance check for counted types, unpaid not counted | completed, tested | `tests/hr-leave.test.js`, `tests/hr-e2e.test.js` C1, C2 |
| Approval: Manager only for direct reports (404 otherwise), HR/Admin/SuperAdmin all; approving a cancelled/decided request is 409; two approvals cannot overdraw a balance | completed, tested | `tests/hr-leave.test.js`, `tests/hr-e2e.test.js` C1, C4 |
| Self-approval refused (403); an HR/Admin user's own request is approved by another approver | completed, tested | `tests/hr-leave.test.js`, `tests/hr-e2e.test.js` C4 |
| Cancel: own pending, or own approved future leave (balance restored); a leave that has started cannot be cancelled | completed, tested | `tests/hr-leave.test.js`, `tests/hr-e2e.test.js` C3 |
| Team calendar: names, leave type, dates, status; never the reason, note, decider or day count | completed, tested | `tests/hr-leave.test.js`, `tests/hr-e2e.test.js` D2 |
| Attendance report: worked minutes, late (schedule + grace), absent (not leave/holiday/before today), open sessions; holiday and leave days excluded; equals an independent SQL computation | completed, tested | `tests/hr-attendance.test.js`, `tests/hr-e2e.test.js` E1 |
| Leave report per employee and type: entitled, adjusted, approved, pending, remaining | completed, tested | `tests/hr-leave.test.js`, `tests/hr-e2e.test.js` E1 |
| CSV export: UTF-8 BOM, every cell quoted, CRLF, formula-looking values neutralised, row cap (`HR_EXPORT_MAX_ROWS`), audited | completed, tested | `tests/hr-attendance.test.js`, `tests/hr-e2e.test.js` E2 (an employee number `=1+1` is exported as `'=1+1`) |
| Reasons and decision notes never appear in the calendar, reports or export | completed, tested | `tests/hr-e2e.test.js` D1, D2, E1, E2 (sentinel strings) |

## Roles and isolation (spec section 2)

- [x] completed, tested: every active staff role can clock, request leave/corrections and see only its own records (`tests/hr-e2e.test.js` D1: Receptionist and Accountant cannot list,
      decide, cancel or read the Agent's corrections or leave; the Agent's rows stay pending and untouched).
- [x] completed, tested: Accountant, Receptionist, Agent and Manager are refused (403) on every HR admin route and write nothing; HR and Admin get through (`tests/hr-e2e.test.js` F1).
- [x] completed, tested: Candidate (real OTP login), Employer and Agency tokens are 403 on every route class (self, calendar, approvals, admin, reports, export, writes) and anonymous callers 401,
      with zero rows written (`tests/hr-e2e.test.js` F2). The all-routes sweep (`tests/orgs-route-sweep.test.js`) classifies every `/hr/*` route and passes, run as a child
      process from `hr-e2e` (H1).
- [x] completed, tested: a deactivated user's token stops working at once (`requireStaff` re-reads the account on every request), and the account cannot log in (`tests/hr-e2e.test.js` G2).

## User interface

- [x] completed, tested (string/structure level): "HR" tab with My work, Team and HR admin views, ar/en/fr parity, CSP-safe (no inline script), `textContent` only. `tests/hr-ui.test.js`.
- [ ] **Blocked / not repeatable:** rendering in a real browser (layout, Arabic RTL, 375 px width, the clock button on a phone) has no committed test and was not run for this checklist.

## End-to-end (Task 6)

`tests/hr-e2e.test.js`: real HTTP, real Postgres schema, real logins (HR, Admin, Manager, Agent, Receptionist, Accountant, Candidate by OTP), no network, deterministic
(`X-Test-Now`). HR sets up the schedule, leave types, holiday, profiles/managers and balances; the Agent clocks late, double clock-in and stale-session cases, a correction
approved by the Manager; leave across a weekend and a holiday counts exactly 4 days; over-balance and overlap are 409; cancel restores the balance; self-approval refused;
isolation; calendar privacy; report numbers equal an independent SQL computation; CSV parses back; denial matrices; 10 parallel clock-ins; the sweep.

## Review round 1 (independent HR review)

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | HIGH: a forgotten clock-out locked the employee out (clock-out 409 after 16 h, clock-in 409 "already clocked in", correction approval 409 on the open row) | completed | An approved correction now updates the user's OPEN row of that work day (clock_in/out replaced, source `correction`, `correction_id`, audited, same clock lock); an overlap with a CLOSED record is still 409. New HR actions `GET /hr/attendance/open` (hr:read, stale sessions with names) and `POST /hr/attendance/:id/close` (hr:write, open records only, clock_out in (clock_in, clock_in+24 h], not in the future, note <= 500, audited); "Open sessions" table with a Close button in the console (ar/en/fr). Tests: `hr-attendance.test.js` (Monday 08:00 in, Tuesday 10:00 out = 409, correction approved, clock-in works; HR close matrix; open list), `hr-ui.test.js`, route sweep |
| 2 | MEDIUM: leave calendar privacy (department branch) | completed | Department branch removed from `leaveCalendar.js`; non-approvers see only their own leave, Managers direct reports + own, HR/Admin/SuperAdmin all. `hr-leave.test.js`, `hr-e2e.test.js` D2 updated |
| 3 | MEDIUM: separation of duties | completed | `PUT /hr/balances` for oneself and `PATCH/POST /hr/employees` on oneself touching anything but phone / emergency contact are 403 "someone else must change your own balance/manager/schedule" for HR, Admin and SuperAdmin alike. `hr-admin.test.js` (the e2e journey now has the Admin set up HR's own profile and balance) |
| 4 | LOW: correction reason / decision note in audit rows | completed | Masked as `[private]` like leave. `hr-attendance.test.js` |
| 5 | LOW: cross-year split recomputed at read time | completed | Migration `020_hr_leave_year_split.sql` (idempotent, columns + consistency CHECK + `hr_working_days()` + backfill with the previous formula); stored at creation; balances / report / checks read the stored parts (NULL falls back). Tests: holiday and schedule change after approval leave both years unchanged (`hr-leave.test.js`), migration backfill and re-run (`hr-schema.test.js`), migration lists in `fin-schema.test.js` |
| 6 | LOW: `setBalance` ignored the balance lock | completed | Takes the same advisory lock as leave creation / approval; lowering the granted days below approved + pending (that year, counted types only) is 409; raising or keeping is allowed. Parallel lowering + approval + new request never leaves approved + pending above the entitlement (`hr-leave.test.js`) |
| 7 | LOW: HR_TIMEZONE validation | completed | Exact match against `pg_timezone_names` (POSIX-style `UTC+1`, wrong case and unknown names are refused); an invalid `HR_TIMEZONE` logs a clear error at start-up and on first use and falls back to `Africa/Tunis`; stored schedules with an unknown zone are reported at start-up; schedule create/patch with an invalid zone is 400; Postgres 22023 inside `inTransaction` becomes a clean error without the Postgres text. `hr-admin.test.js` |

Remaining limits found by the review and **not fixed** (documented only):

- **All-null schedule.** A schedule with no working day counts leave as Mon-Fri (the default week) while the attendance report treats that person as never expected, so the two
  views disagree for that person until a working day is configured.
- **Two timezones.** Leave arithmetic (today, the 366-day window, the current year) uses the company timezone (`HR_TIMEZONE`); attendance uses the employee's schedule timezone.
  For an employee whose schedule zone differs from the company zone, "today" can differ by a day near midnight.
- **Half-day leave without attendance.** A half-day leave day is not full-day leave, so a person who takes the half day off and does not clock in at all for the other half is
  flagged absent for that day.
- **Overnight shifts.** A session belongs to the day it was clocked in on; when an overnight shift has no row on the next calendar day, that next day can be flagged absent
  because the report looks for attendance rows by work date.

## Not done / blocked

- [ ] **Not run on a real server.** Same as the other stages: tests ran against a throw-away Postgres schema and an in-process server only.
- [ ] **Owner / labour-law review needed** before real use: how long attendance and leave data may and must be kept (no retention or deletion job exists), the legal basis and
      notices for processing employee data (Tunisian data-protection law, INPDP), whether recording working time this way is acceptable under your contracts and any
      works-council or employee-representative rules. The system stores data and provides reports; it does not decide what is lawful.
- [ ] **Not built (out of scope by the spec):** payroll/salary/payslips, contracts, performance reviews, staff recruitment, biometric/GPS attendance, shift rostering, statutory leave rules,
      mobile app, external calendar sync, e-mail notifications of requests/decisions.
- [ ] **Not preloaded:** public holidays (including movable religious holidays), leave entitlements, carry-over rules, schedules. The owner/HR enters them; carry-over from one year
      to the next is a manual balance entry (`PUT /hr/balances` with `adjusted_days`).

## Known limits (from the implementation reports)

1. **Team leave list excludes a manager's own requests.** A Manager sees the leave requests of their direct reports; the Manager's own request is never in that list and cannot be
   approved by them (403): it goes to HR/Admin.
2. **Cross-year leave split is stored at creation (migration 020).** A request that crosses New Year keeps the days of each year (`days_year_start`, `days_year_end`) as computed
   when it was made; balances, reports and the balance checks use them, so a later holiday or schedule change never moves days between years. Only rows without stored parts
   (made by code older than 020) fall back to the live computation. The balance check still runs per calendar year.
3. **Calendar privacy (review round 1).** There is no department rule any more: staff see only their own leave (approved and pending); a Manager sees direct reports (approved and
   pending) and their own; HR/Admin/SuperAdmin see everyone. Colleagues in the same department do not see each other.
4. **The clock page relies on the server `Date` header** to show the server time; a phone with a wrong clock still records the correct (server) time, but the displayed clock may be
   off until the page is reloaded.
5. **A session open longer than 16 hours (`HR_MAX_OPEN_HOURS`) needs a fix.** It is never auto-closed or capped. Two ways out (review round 1): the employee requests a correction for
   that day and its approval corrects the open record itself (the employee can clock in again at once); or HR closes the session from **HR -> Admin -> Attendance report -> Open
   sessions** (`POST /hr/attendance/:id/close`, within 24 h of the clock-in, not in the future, audited). A correction that overlaps a CLOSED record is still refused (409) and HR
   resolves it manually.
6. **The attendance report excludes people without a schedule** (nothing is expected of them, so nobody can be "late" or "absent"); their clock records still appear on days they clocked.
   People with a profile but no schedule use the default Mon-Fri week only for leave day counting.
7. **Late/absent are computed per calendar day of the schedule's timezone;** several sessions in one day count from the first clock-in; the schedule's break is shown next to the worked
   time and is not deducted.
8. **Deactivating a user** (a deactivated account is refused at once); their history stays in the reports for the dates they have records.
