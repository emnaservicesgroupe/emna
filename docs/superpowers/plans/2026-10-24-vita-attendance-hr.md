# VITA Attendance and HR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Attendance and HR per `docs/superpowers/specs/2026-10-24-vita-attendance-hr-design.md`.
**Architecture:** Additive migration 018; `modules/hr/*` services (transactional, tz-aware SQL), `routes/hr.js` mounted at `/hr` with own 32kb parser, `middleware` helper `requireStaff`; UI in `public/vita/hr-*.js`.
**Tech Stack:** Node 22, Express, pg, node:test.

## Global Constraints
- No salary/payroll/ID/medical/performance data; no GPS/photo/biometrics; timestamps timestamptz; company tz from `HR_TIMEZONE` (default Africa/Tunis) applied in SQL (`AT TIME ZONE`), never JS Date arithmetic for day boundaries.
- Scope rules per spec §2 enforced in SQL/service after loading; out-of-scope ⇒ 404; Candidate/Employer/Agency denied at router level; update `tests/orgs-route-sweep.test.js` tables for every new route.
- Every mutation transactional + `logAudit(client)`; no silent edits of attendance (corrections only).
- Strict CSP, ar/en/fr parity, textContent only, CSV injection protection (reuse finance exportCsv helpers).
- Commits end with: Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com> and Claude-Session: https://claude.ai/code/session_01FJCJCrbEtXFCvjTVJwpqAi. Full `npm test` (run once, never two at once) stays green. Branch claude/adoring-mendel-yrxr43; don't push.

## Review Focus
- Two concurrent clock-ins; clock-out without clock-in; session spanning midnight; clock events at 23:59:59/00:00:00 Tunis.
- Leave spanning weekend/holiday; half days; overlapping requests; balance exhaustion; approving a request after it was cancelled.
- Manager approving non-reports; self-approval; approver deactivated; employee reading colleague's reasons through calendar/reports.
- Deactivated employee tokens; employee with no hr_employees row (self-service must still work with defaults, HR sees "no profile").
- Correction approval racing with a clock-in on the same day.

### Task 1: Migration 018 + permissions + requireStaff
Files: `sql/migrations/018_hr.sql`, `middleware/role.js` (hr:read/hr:write/hr:approve per spec; update SETUP.md matrix + test block like finance did), `middleware/staff.js` (requireStaff: verified token with an active staff role), tests `tests/hr-schema.test.js`.
Everything in spec §3 (guard btree_gist: `CREATE EXTENSION IF NOT EXISTS btree_gist` in a DO block with exception handling; if unavailable fall back to a trigger-based overlap check — implement the trigger fallback regardless and test it). Tests: idempotence, constraints, partial unique open session, overlap prevention, role matrix.

### Task 2: Employees, schedules, holidays, leave types, balances (HR admin API)
Files: `modules/hr/{common,employees,schedules,holidays,leaveTypes,balances}.js`, `routes/hr.js` (+ app.js mount), tests `tests/hr-admin.test.js`. CRUD per spec §4 with validation (schedule JSON shape, HH:MM, break minutes, grace), manager cycles refused, `GET /hr/me` basic (profile defaults when no row).

### Task 3: Attendance (clock, corrections, reports)
Files: `modules/hr/attendance.js`, `modules/hr/corrections.js`, `modules/hr/attendanceReports.js`, routes, tests `tests/hr-attendance.test.js`. Per spec §4 and Review Focus; reports computed in SQL with company tz; injectable clock for tests.

### Task 4: Leave (requests, approval, balances, calendar)
Files: `modules/hr/leaveRequests.js`, `modules/hr/leaveCalendar.js`, `modules/hr/approvals.js`, routes, tests `tests/hr-leave.test.js`. Working-day counting via schedule + holidays in SQL; approval scope; self-approval refusal; leave report; privacy of reasons; update route sweep.

### Task 5: UI
Files: `public/vita/hr-util.js`, `hr-my.js`, `hr-team.js`, `hr-admin.js`, `admin.html`, `admin.js` (all staff roles may see the HR tab; hide jobsearch tabs as already done for Accountant), `crm-util.js` mirror, `i18n.js`, `vita.js` allowlist `/hr/`, tests `tests/hr-ui.test.js`; browser smoke with Playwright (clock in/out, correction request+approval, leave request+approval, team calendar, HR admin setup, ar RTL, 375px, role visibility for Accountant/Agent/Manager/HR).

### Task 6: End-to-end, docs
Files: `tests/hr-e2e.test.js`, `docs/vita-hr/{CHECKLIST,SETUP}.md`, env additions (`HR_TIMEZONE`, `HR_MAX_OPEN_HOURS`) in both env examples, HOSTINGER doc paragraph. Journey across roles + isolation + sweep child process.
