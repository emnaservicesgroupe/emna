// Interviews from employer replies (spec §8, Task 13).
//
//   createFromMessage({messageId, proposedStart, tz, actor, durationMinutes?, title?})
//       staff with jobsearch:approve; the message must be matched to an application in scope. Creates a
//       TENTATIVE js_appointments row (calendar adapter, staff = responsible staff; explicit IANA tz;
//       end = start + 60 min by default; overlap -> 409 APPOINTMENT_OVERLAP), then moves the application
//       to 'interview' (staff actor). proposedStart: ISO with offset/Z (absolute) or a wall time
//       'YYYY-MM-DDTHH:mm' interpreted in `tz`.
//   confirmInterview({id, candidateAvailabilityConfirmed, actor, note?})
//       requires candidateAvailabilityConfirmed === true, by the CANDIDATE (own appointment) or staff
//       recording the candidate's confirmation with a note (>= 10 chars); then calendar.confirm.
//   cancelInterview({id, actor, reason}) / rescheduleInterview({id, proposedStart, tz, actor})
//   listInterviews({user}) scoped. Times always come back as UTC ISO + explicit tz + local ISO.
const calendar = require("./calendar");
const applicationService = require("./applicationService");
const { candidateScopeSql } = require("./scope");
const draftService = require("./draftService");
const S = require("./inboxShared");

const { httpErr, oneLine } = S;
const DEFAULT_MINUTES = 60;
const INTERVIEWABLE = ["sent", "confirmed_submitted", "outcome_unknown", "interview"];
const MIN_NOTE = 10;

// ---------------------------------------------------------------- time helpers

function validTz(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `tz` at instant `ms`. */
function tzOffset(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ABS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Instant for proposedStart (absolute ISO, or wall time in tz). */
function resolveStart(proposedStart, tz) {
  if (typeof proposedStart !== "string") throw httpErr(400, "proposedStart is required (ISO date-time)", "INVALID_TIME");
  const s = proposedStart.trim();
  if (ABS_RE.test(s)) {
    const d = new Date(s);
    if (isNaN(d)) throw httpErr(400, "proposedStart is not a valid date-time", "INVALID_TIME");
    return d;
  }
  const m = WALL_RE.exec(s);
  if (!m) throw httpErr(400, "proposedStart must be ISO 8601 (with offset, or a wall time in tz)", "INVALID_TIME");
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
  let ms = guess - tzOffset(guess, tz);
  ms = guess - tzOffset(ms, tz);
  const d = new Date(ms);
  if (isNaN(d)) throw httpErr(400, "proposedStart is not a valid date-time", "INVALID_TIME");
  return d;
}

/** 'YYYY-MM-DDTHH:mm:ss+hh:mm' in tz. */
function localIso(date, tz) {
  if (!validTz(tz)) return null;
  const ms = new Date(date).getTime();
  const off = tzOffset(ms, tz);
  const local = new Date(Math.floor(ms / 1000) * 1000 + off).toISOString().slice(0, 19);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off) / 60000;
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

async function candidateTz(c, candidateId) {
  const p = (await c.query("SELECT timezone FROM js_preferences WHERE candidate_id = $1", [candidateId])).rows[0];
  if (p && validTz(p.timezone)) return p.timezone;
  const pr = (await c.query("SELECT confirmed->>'timezone' AS tz FROM js_profiles WHERE candidate_id = $1", [candidateId])).rows[0];
  return pr && validTz(pr.tz) ? pr.tz : null;
}

function presentTimes(a, ctz) {
  const out = {
    startsAtUtc: new Date(a.starts_at || a.startsAt).toISOString(),
    endsAtUtc: new Date(a.ends_at || a.endsAt).toISOString(),
    tz: a.tz,
    startsAtLocal: localIso(a.starts_at || a.startsAt, a.tz),
    endsAtLocal: localIso(a.ends_at || a.endsAt, a.tz),
  };
  if (ctz) {
    out.candidateTz = ctz;
    out.startsAtCandidateLocal = localIso(a.starts_at || a.startsAt, ctz);
  }
  return out;
}

function present(row, ctz) {
  return {
    id: row.id,
    applicationId: row.application_id,
    candidateId: row.candidate_id,
    staffUserId: row.staff_user_id,
    status: row.status,
    title: row.title,
    ...presentTimes(row, ctz),
  };
}

// ---------------------------------------------------------------- scoped appointment

async function loadAppointment(user, id) {
  const apptId = S.posInt(id);
  if (!apptId || !user) throw httpErr(404, "Not found");
  const pre = (await S.db().query("SELECT * FROM js_appointments WHERE id = $1", [apptId])).rows[0];
  if (!pre || !pre.application_id) throw httpErr(404, "Not found");
  await applicationService.loadScoped(user, pre.application_id); // 404 outside scope (Candidate: own only)
  return pre;
}

function requireApprover(actor, what) {
  if (!S.isUser(actor) || actor.role === "Candidate" || !S.hasPerm(actor, "jobsearch:approve")) throw httpErr(403, `${what} requires a manager or administrator`);
}

function mapCalendarError(err) {
  if (err && err.code === "APPOINTMENT_OVERLAP") return httpErr(409, err.message, "APPOINTMENT_OVERLAP");
  if (err && err.code === "INVALID_TZ") return httpErr(400, err.message, "INVALID_TZ");
  if (err && err.code === "INVALID_TIME") return httpErr(400, err.message, "INVALID_TIME");
  if (err && err.code === "AVAILABILITY_NOT_CONFIRMED") return httpErr(409, err.message, "AVAILABILITY_NOT_CONFIRMED");
  if (err && err.code === "APPOINTMENT_CANCELLED") return httpErr(409, err.message, "APPOINTMENT_CANCELLED");
  if (err && err.code === "NOT_FOUND") return httpErr(404, "Not found");
  return err;
}

async function notify(client, app, staffUserId, kind, appt, ctz, extra = {}) {
  const times = presentTimes(appt, ctz);
  await S.staffEvent(client, app.candidate_id, staffUserId, `staff.${kind}`, { applicationId: app.id, appointmentId: appt.id, ...times, ...extra });
  await S.candidateEvent(client, app.candidate_id, kind, { applicationId: app.id, appointmentId: appt.id, ...times });
}

// ---------------------------------------------------------------- create / confirm / cancel

function durationOf(v) {
  if (v === undefined || v === null) return DEFAULT_MINUTES;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 15 || n > 480) throw httpErr(400, "durationMinutes must be an integer between 15 and 480");
  return n;
}

async function liveAppointment(client, applicationId) {
  return (await client.query("SELECT id FROM js_appointments WHERE application_id = $1 AND status IN ('tentative','confirmed') ORDER BY id LIMIT 1", [applicationId])).rows[0] || null;
}

/** Retries a transaction that hit a Postgres deadlock (40P01) up to 3 times with jitter, then 409 try_again. */
async function withDeadlockRetry(fn, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!err || err.code !== "40P01") throw err;
      if (attempt >= 3) throw httpErr(409, "The calendar is busy; please try again", "try_again");
      await sleep(20 + Math.floor(Math.random() * 80) * attempt);
    }
  }
}

/** Runs fn inside ONE transaction that first locks the candidate, then the application row. */
async function inAppTx(applicationId, fn) {
  return S.inTx(async (client) => {
    const locked = await S.lockApplication(client, applicationId);
    return fn(client, locked);
  });
}

async function createFromMessage({ messageId, proposedStart, tz, actor, durationMinutes, title, additionalRound, deps = {} }) {
  if (!S.isUser(actor) || actor.role === "Candidate") throw httpErr(404, "Not found");
  const msg = await draftService.loadMessageScoped(actor, messageId);
  requireApprover(actor, "Scheduling an interview");
  if (msg.direction !== "in" || !msg.application_id) throw httpErr(409, "The message must be matched to an application first");
  if (!validTz(tz)) throw httpErr(400, "tz must be a valid IANA time zone (e.g. Europe/Paris)", "INVALID_TZ");
  if (additionalRound !== undefined && typeof additionalRound !== "boolean") throw httpErr(400, "additionalRound must be a boolean");
  const start = resolveStart(proposedStart, tz);
  const end = new Date(start.getTime() + durationOf(durationMinutes) * 60000);
  const scoped = await applicationService.loadScoped(actor, msg.application_id);
  const out = await inAppTx(scoped.id, async (client, { app, cand }) => {
    if (!INTERVIEWABLE.includes(app.status)) throw httpErr(409, `Application is ${app.status}; an interview needs a sent application`);
    if (additionalRound !== true && (await liveAppointment(client, app.id))) {
      throw httpErr(409, "An interview is already scheduled for this application: reschedule it instead (or set additionalRound for another round)", "interview_already_scheduled");
    }
    const staffUserId = app.responsible_user_id || (cand && cand.assigned_to) || actor.id;
    let appt;
    try {
      appt = await calendar.createTentative({ candidateId: app.candidate_id, staffUserId, applicationId: app.id, startsAt: start.toISOString(), endsAt: end.toISOString(), tz, title: oneLine(title, 120) || "Interview", additionalRound: additionalRound === true, client });
    } catch (err) {
      throw mapCalendarError(err);
    }
    // status -> interview only now that the tentative slot exists (same transaction)
    if (app.status !== "interview") {
      await applicationService.transition(app.id, "interview", actor, { client, reason: "interview_proposed", event: "status_changed", detail: { appointmentId: appt.id, messageId: msg.id } });
    }
    const ctz = await candidateTz(client, app.candidate_id);
    const times = presentTimes(appt, null);
    await S.timeline(client, app.id, actor, "interview_proposed", { appointmentId: appt.id, messageId: msg.id, status: "tentative", startsAtUtc: times.startsAtUtc, tz });
    await S.auditEvent(client, actor, "interview.proposed", app.candidate_id, app.id, { appointmentId: appt.id, messageId: msg.id, staffUserId, ...times });
    await notify(client, app, staffUserId, "interview.proposed", appt, ctz);
    if (typeof deps.afterCreate === "function") await deps.afterCreate(appt);
    return { appointment: present({ ...appt, starts_at: appt.startsAt, ends_at: appt.endsAt, application_id: app.id, candidate_id: app.candidate_id, staff_user_id: staffUserId }, ctz), applicationStatus: "interview" };
  });
  await S.auditLog(actor, "jobsearch.interview.create", "js_appointments", out.appointment.id, { applicationId: scoped.id });
  return out;
}

async function confirmInterview({ id, candidateAvailabilityConfirmed, actor, note }) {
  const pre = await loadAppointment(actor, id);
  if (candidateAvailabilityConfirmed !== true) throw httpErr(409, "Cannot confirm: the candidate has not confirmed their availability", "AVAILABILITY_NOT_CONFIRMED");
  let recorded = null;
  if (actor.role !== "Candidate") {
    requireApprover(actor, "Recording the candidate's availability");
    recorded = oneLine(note, 500);
    if (recorded.length < MIN_NOTE) throw httpErr(400, `note is required (at least ${MIN_NOTE} characters: how the candidate confirmed)`);
  }
  const out = await inAppTx(pre.application_id, async (client, { app }) => {
    const appt = (await client.query("SELECT * FROM js_appointments WHERE id = $1 FOR UPDATE", [pre.id])).rows[0];
    let row;
    try {
      row = await calendar.confirm(appt.id, { availabilityConfirmedByCandidate: true, client });
    } catch (err) {
      throw mapCalendarError(err);
    }
    const ctz = await candidateTz(client, app.candidate_id);
    await S.timeline(client, app.id, actor, "interview_confirmed", { appointmentId: appt.id, status: "confirmed", by: actor.role === "Candidate" ? "candidate" : "staff_recorded" });
    await S.auditEvent(client, actor, "interview.confirmed", app.candidate_id, app.id, { appointmentId: appt.id, note: recorded });
    await notify(client, app, appt.staff_user_id, "interview.confirmed", appt, ctz);
    return present({ ...appt, status: row.status }, ctz);
  });
  await S.auditLog(actor, "jobsearch.interview.confirm", "js_appointments", pre.id, { by: actor.role });
  return out;
}

async function cancelInterview({ id, actor, reason }) {
  if (!S.isUser(actor) || actor.role === "Candidate") throw httpErr(404, "Not found");
  const pre = await loadAppointment(actor, id);
  requireApprover(actor, "Cancelling an interview");
  const staffNote = oneLine(reason, 300) || null;
  const out = await inAppTx(pre.application_id, async (client, { app }) => {
    const appt = (await client.query("SELECT * FROM js_appointments WHERE id = $1 FOR UPDATE", [pre.id])).rows[0];
    if (appt.status === "cancelled") throw httpErr(409, "Interview is already cancelled");
    await calendar.cancel(appt.id, { client });
    const ctz = await candidateTz(client, app.candidate_id);
    // candidate-visible: fixed code only; the staff's text stays in the audit trail
    await S.timeline(client, app.id, actor, "interview_cancelled", { appointmentId: appt.id, status: "cancelled", reason: "cancelled_by_staff", staffNote });
    await S.auditEvent(client, actor, "interview.cancelled", app.candidate_id, app.id, { appointmentId: appt.id, reason: staffNote });
    await notify(client, app, appt.staff_user_id, "interview.cancelled", appt, ctz);
    return present({ ...appt, status: "cancelled" }, ctz);
  });
  await S.auditLog(actor, "jobsearch.interview.cancel", "js_appointments", pre.id, { reason: staffNote });
  return out;
}

/**
 * ONE transaction: candidate lock -> application lock -> appointment row FOR UPDATE -> in-place UPDATE
 * of starts/ends/tz (EXCLUDE constraint checks overlaps atomically; on overlap everything rolls back
 * and the old slot is untouched) -> status back to 'tentative' (candidate must re-confirm) -> timeline/events.
 */
async function rescheduleInterview({ id, proposedStart, tz, actor, durationMinutes, deps = {} }) {
  if (!S.isUser(actor) || actor.role === "Candidate") throw httpErr(404, "Not found");
  const pre = await loadAppointment(actor, id);
  requireApprover(actor, "Rescheduling an interview");
  if (!validTz(tz)) throw httpErr(400, "tz must be a valid IANA time zone (e.g. Europe/Paris)", "INVALID_TZ");
  const start = resolveStart(proposedStart, tz);
  const end = new Date(start.getTime() + durationOf(durationMinutes) * 60000);
  const out = await withDeadlockRetry(() => inAppTx(pre.application_id, async (client, { app }) => {
    // Deadlock-safe: lock this appointment AND every live appointment of the same staff member that the
    // new slot touches, in id order (two crossing reschedules then queue instead of deadlocking).
    await client.query(
      `SELECT id FROM js_appointments WHERE staff_user_id = $1 AND (id = $2 OR (status <> 'cancelled' AND tstzrange(starts_at, ends_at) && tstzrange($3::timestamptz, $4::timestamptz)))
        ORDER BY id FOR UPDATE`,
      [pre.staff_user_id, pre.id, start.toISOString(), end.toISOString()]
    );
    const appt = (await client.query("SELECT * FROM js_appointments WHERE id = $1", [pre.id])).rows[0];
    if (appt.status === "cancelled") throw httpErr(409, "Interview is cancelled");
    let moved;
    try {
      moved = await calendar.reschedule(appt.id, { startsAt: start.toISOString(), endsAt: end.toISOString(), tz, client });
    } catch (err) {
      throw mapCalendarError(err);
    }
    if (typeof deps.afterUpdate === "function") await deps.afterUpdate(moved);
    const ctz = await candidateTz(client, app.candidate_id);
    const times = presentTimes(moved, null);
    await S.timeline(client, app.id, actor, "interview_rescheduled", { appointmentId: appt.id, status: "tentative", startsAtUtc: times.startsAtUtc, tz, previousStartsAtUtc: new Date(appt.starts_at).toISOString() });
    await S.auditEvent(client, actor, "interview.rescheduled", app.candidate_id, app.id, { appointmentId: appt.id, previous: presentTimes(appt, null), ...times });
    await notify(client, app, appt.staff_user_id, "interview.rescheduled", moved, ctz);
    return present({ ...appt, starts_at: moved.startsAt, ends_at: moved.endsAt, tz: moved.tz, status: moved.status }, ctz);
  }), deps);
  await S.auditLog(actor, "jobsearch.interview.reschedule", "js_appointments", pre.id, {});
  return out;
}

async function listInterviews({ user, query = {} }) {
  if (!user) throw httpErr(404, "Not found");
  if (user.role !== "Candidate" && !S.hasPerm(user, "jobsearch:read")) throw httpErr(403, "Permission denied: jobsearch:read");
  const appId = query.applicationId === undefined || query.applicationId === "" ? null : S.posInt(query.applicationId);
  if (query.applicationId !== undefined && query.applicationId !== "" && !appId) throw httpErr(400, "applicationId must be a positive integer");
  const { clause, params } = candidateScopeSql(user, "c", 1);
  const rows = (await S.db().query(
    `SELECT p.*, pr.timezone AS candidate_tz FROM js_appointments p
       JOIN js_applications a ON a.id = p.application_id JOIN candidates c ON c.id = a.candidate_id
       LEFT JOIN js_preferences pr ON pr.candidate_id = c.id
      WHERE c.is_deleted = false AND ($1::int IS NULL OR p.application_id = $1) AND ${clause}
      ORDER BY p.starts_at, p.id LIMIT 500`,
    [appId, ...params]
  )).rows;
  return { interviews: rows.map((r) => present(r, validTz(r.candidate_tz) ? r.candidate_tz : null)) };
}

module.exports = { withDeadlockRetry, createFromMessage, confirmInterview, cancelInterview, rescheduleInterview, listInterviews, resolveStart, localIso, validTz, DEFAULT_MINUTES };
