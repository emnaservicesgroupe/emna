# VITA — Attendance and HR (Stage 5) — Design

Status: stage order confirmed by the owner 2026-10-24 ("Confirm"); standing instruction covers spec/plan approval.
Code: `trust-crm/`. Additive only; same branch/PR as stage 4 until merged.

## 1. Goal and success criteria
VITA staff can clock in and out, see their own attendance and leave, request leave and attendance corrections; managers approve for their direct reports; HR and admins manage staff profiles, schedules, leave types, balances, public holidays and see reports. Done = tests on real Postgres (including timezone, overlap and concurrency cases), strict privacy isolation (an employee sees only their own records; managers only direct reports; HR/Admin all; everyone else nothing), and an honest checklist.

Hard rules: no salary, payroll, ID numbers, medical details or performance data are stored in this stage; no GPS, photo or biometric capture (clock events are server-timestamped only); no labour-law rules are invented — leave types, entitlements, working schedules and public holidays are **data entered by the owner/HR**, with sensible empty defaults and a clear "to be configured" state; all timestamps are stored as `timestamptz` and displayed in the company timezone (`HR_TIMEZONE`, default `Africa/Tunis`); every mutation is audited; records are corrected by approved correction entries, never silently edited.

## 2. Who can do what
- Every active **staff** role (SuperAdmin, Admin, Manager, Receptionist, Accountant, HR, Agent) = employee: clock in/out, view own attendance and balances, request leave/correction, cancel own pending requests.
- **Manager** (and anyone listed as `manager_user_id` of an employee): approve/reject leave and corrections of direct reports, see their attendance and the team calendar.
- **HR**, **Admin**, **SuperAdmin**: manage employees/schedules/leave types/holidays/balances, approve anything, see all, run reports, export CSV.
- Candidate, Employer, Agency: denied everywhere.
- New permissions `hr:read`, `hr:write`, `hr:approve` (HR, Admin, SuperAdmin; Manager gets `hr:approve` limited by report-line rule in service code). Self-service routes need only an active staff role (new `requireStaff` middleware), not a permission.

## 3. Data (migration 018, additive, idempotent)
- `hr_employees(user_id PK→users, employee_no unique nullable, position, department, hire_date, end_date, employment_type text, phone, emergency_contact_name, emergency_contact_phone, manager_user_id nullable→users, schedule_id nullable, status active|inactive, notes (HR-only), created_at, updated_at)`.
- `hr_schedules(id, name, weekly jsonb {mon:{start:"09:00",end:"17:30",break_minutes:60}|null,…}, grace_minutes int default 10, timezone default company tz)`.
- `hr_holidays(id, day date unique, name, created_by)`.
- `hr_attendance(id, user_id, work_date date, clock_in timestamptz, clock_out timestamptz null, source clock|correction, correction_id nullable, note, created_at)`; at most one open (clock_out null) record per user (partial unique index); `clock_out > clock_in`; no overlapping intervals per user (exclusion constraint using tstzrange, requires btree_gist — guard extension creation or use a trigger if the extension is unavailable).
- `hr_attendance_corrections(id, user_id, work_date, requested_in, requested_out, reason, status pending|approved|rejected|cancelled, decided_by, decided_at, decision_note, created_at)`.
- `hr_leave_types(id, code unique, name_ar, name_en, name_fr, paid bool, counts_against_balance bool, requires_approval bool default true, active)`.
- `hr_leave_balances(id, user_id, leave_type_id, year int, entitled_days numeric(6,2), adjusted_days numeric(6,2) default 0, UNIQUE(user_id, leave_type_id, year))`; used days are derived from approved requests, not stored.
- `hr_leave_requests(id, user_id, leave_type_id, start_date, end_date, half_day_start bool, half_day_end bool, days numeric(6,2) computed server-side (working days per schedule minus holidays), reason (private to employee/approver/HR), status pending|approved|rejected|cancelled, decided_by, decided_at, decision_note, created_at)` with CHECK end>=start and an overlap guard against other pending/approved requests of the same user.
- `hr_audit` reuses `audit_logs` via logAudit(client); timeline not needed.

## 4. APIs (`/hr/*`)
Self: `GET /hr/me` (profile subset, schedule, balances for current year, open clock state), `POST /hr/clock-in`, `POST /hr/clock-out` (idempotent within 60 s; refuses double clock-in; auto-flags >16 h open sessions as `needs_correction` in reports instead of silently closing), `GET /hr/me/attendance?from&to`, `POST /hr/me/corrections`, `POST /hr/me/leave-requests`, `GET /hr/me/leave-requests`, `POST /hr/me/leave-requests/:id/cancel`.
Team/approval: `GET /hr/team/leave-requests?status`, `POST /hr/leave-requests/:id/decide {decision, note}`, `GET /hr/team/corrections`, `POST /hr/corrections/:id/decide`, `GET /hr/team/calendar?from&to` (who is on leave; names + dates only, never reasons) — scope: direct reports for managers, all for HR/Admin.
HR admin: `GET/POST/PATCH /hr/employees`, `GET/POST/PATCH /hr/schedules`, `GET/POST/PATCH /hr/leave-types`, `GET/POST/DELETE /hr/holidays`, `PUT /hr/balances` (set entitled/adjusted), `GET /hr/reports/attendance?from&to&user_id` (worked minutes, late count by schedule+grace, absent working days not covered by leave/holiday, open sessions), `GET /hr/reports/leave?year`, `GET /hr/export/attendance.csv` (CSV-safe like finance).
All decisions re-validate scope inside a transaction; a manager cannot approve their own request (self-approval refused; HR/Admin self-requests go to another approver: any other user with hr:approve; if none exists the request stays pending and the UI says so).

## 5. UI
Staff console tab "HR": **My work** (big Clock in/out button with today's status and server time, my attendance list, request correction, my leave balances and requests, request leave), **Team** (pending approvals, team calendar) for approvers, **HR admin** (employees, schedules, leave types, holidays, balances, reports/export) for hr:write/read. ar/en/fr RTL, CSP-safe, same style as `crm-*`/`fin-*`.

## 6. Testing
Timezone boundaries (clock around midnight Tunis, DST-free but still use tz functions), overlap/double clock-in/idempotency under Promise.all, correction approval creates the attendance record atomically, leave day counting with weekends/holidays/half days, overlap guard, balance exhaustion for balance-counted types, self-approval refusal, manager sees only direct reports (404 for others), employee cannot read colleagues, HR sees all, Accountant/Agent/Receptionist only self, Candidate/Employer/Agency denied (all-routes sweep updated), CSV safety, privacy (reasons never in calendar or reports for non-approvers), migration idempotent, e2e journey, browser smoke.

## 7. Out of scope
Payroll/salary/payslips, contracts, performance reviews, staff recruitment, biometric/GPS attendance, shift rostering, statutory leave rules (owner configures), mobile app, external calendar sync. Owner inputs: staff list and managers, working schedules, leave types and entitlements, public holiday dates, company timezone, labour-law review of the retention of attendance data.
