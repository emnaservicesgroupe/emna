const db = () => require("../../db");

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function validTz(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function map(r) {
  return {
    id: r.id,
    staffUserId: r.staff_user_id,
    candidateId: r.candidate_id,
    applicationId: r.application_id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    tz: r.tz,
    title: r.title,
    status: r.status,
  };
}

async function createTentative({ candidateId, staffUserId, startsAt, endsAt, tz, title, applicationId } = {}) {
  if (!validTz(tz)) throw fail("Invalid or missing timezone", "INVALID_TZ");
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  if (isNaN(s) || isNaN(e)) throw fail("Invalid start or end time", "INVALID_TIME");
  if (e <= s) throw fail("Appointment end must be after start", "INVALID_TIME");
  try {
    const r = await db().query(
      `INSERT INTO js_appointments (staff_user_id, candidate_id, application_id, starts_at, ends_at, tz, title, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'tentative') RETURNING *`,
      [staffUserId, candidateId, applicationId || null, s.toISOString(), e.toISOString(), tz, title || null]
    );
    return map(r.rows[0]);
  } catch (err) {
    if (err.code === "23P01") {
      throw fail("Appointment overlaps an existing appointment for this staff member", "APPOINTMENT_OVERLAP");
    }
    throw err;
  }
}

async function confirm(id, opts) {
  if (!opts || opts.availabilityConfirmedByCandidate !== true) {
    throw fail("Cannot confirm: the candidate has not confirmed their availability", "AVAILABILITY_NOT_CONFIRMED");
  }
  const r = await db().query(
    "UPDATE js_appointments SET status='confirmed' WHERE id=$1 AND status IN ('tentative','confirmed') RETURNING *",
    [id]
  );
  if (r.rowCount) return map(r.rows[0]);
  const exists = await db().query("SELECT status FROM js_appointments WHERE id=$1", [id]);
  if (!exists.rowCount) throw fail("Appointment not found", "NOT_FOUND");
  throw fail("Appointment is cancelled and cannot be confirmed", "APPOINTMENT_CANCELLED");
}

async function cancel(id) {
  const r = await db().query("UPDATE js_appointments SET status='cancelled' WHERE id=$1 RETURNING *", [id]);
  if (!r.rowCount) throw fail("Appointment not found", "NOT_FOUND");
  return map(r.rows[0]);
}

module.exports = { createTentative, confirm, cancel };
