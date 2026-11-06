// Contact history of one employer (stage 8 task 4): every application, submission and message exchanged with it, so staff see
// prior contact BEFORE drafting a new application and cannot cause duplicate-outreach surprises.
//
// SCOPE (data isolation, same rule as everywhere in job search): rows are limited by candidateScopeSql, so an Agent / Manager /
// Receptionist sees only the applications of candidates assigned to them; Admin / SuperAdmin see all; soft-deleted candidates
// never appear. Contact made by candidates OUTSIDE the caller's scope is reported as ONE NUMBER (contactedByOtherCandidates):
// no names, ids, jobs or dates - enough to avoid contacting an employer twice, nothing about someone else's candidate.
const { candidateScopeSql } = require("./scope");

const db = () => require("../../db");
// A submission in one of these states means we really reached out (a queued / failed attempt did not).
const CONTACTED = ["sent", "confirmed_submitted", "outcome_unknown"];
const MAX_APPLICATIONS = 200;

const isUser = (u) => Boolean(u && typeof u === "object" && Number.isSafeInteger(u.id) && typeof u.role === "string");

/**
 * @param {object|null} client  pg client or pool (default: the app pool)
 * @param {{id: number, role: string}} user
 * @param {number} employerId
 * @param {{excludeApplicationId?: number, detail?: boolean}} [opts]
 * @returns {Promise<{employerId: number, applications: object[]|undefined, totals: {applications: number, sent: number, replies: number, lastContactAt: string|null}, contactedByOtherCandidates: number}>}
 */
async function historyFor(client, user, employerId, opts = {}) {
  const c = client || db();
  const scope = candidateScopeSql(user, "c", 2);
  const scope2 = candidateScopeSql(user, "c", 3);
  const exclude = Number.isSafeInteger(opts.excludeApplicationId) ? opts.excludeApplicationId : 0;
  const apps = (await c.query(
    `SELECT a.id, a.candidate_id, c.full_name AS candidate_name, a.job_id, j.title AS job_title, a.status, a.created_at
       FROM js_applications a JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id
      WHERE j.employer_id = $1 AND a.id <> $2 AND c.is_deleted = false AND ${scope.clause}
      ORDER BY a.id DESC LIMIT ${MAX_APPLICATIONS}`,
    [employerId, exclude, ...scope.params]
  )).rows;
  const ids = apps.map((a) => a.id);
  const subs = ids.length
    ? (await c.query("SELECT id, application_id, attempt_no, status, COALESCE(sent_at, created_at) AS at FROM js_submissions WHERE application_id = ANY($1::int[]) ORDER BY id", [ids])).rows
    : [];
  const msgs = ids.length
    ? (await c.query(
      "SELECT id, application_id, direction, subject, message_kind, classification->>'category' AS category, COALESCE(received_at, created_at) AS at FROM js_messages WHERE application_id = ANY($1::int[]) ORDER BY id",
      [ids]
    )).rows
    : [];
  const contacted = subs.filter((s) => CONTACTED.includes(s.status));
  const replies = msgs.filter((m) => m.direction === "in");
  const last = contacted.reduce((m, s) => (!m || new Date(s.at) > m ? new Date(s.at) : m), null);
  const other = (await c.query(
    `SELECT count(DISTINCT a.candidate_id)::int AS n
       FROM js_applications a JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id
       JOIN js_submissions s ON s.application_id = a.id AND s.status = ANY($2::text[])
      WHERE j.employer_id = $1 AND c.is_deleted = false AND a.id <> $3 AND NOT (${scope2.clause})`,
    [employerId, CONTACTED, exclude, ...scope2.params]
  )).rows[0].n;
  const out = {
    employerId,
    totals: { applications: apps.length, sent: contacted.length, replies: replies.length, lastContactAt: last ? last.toISOString() : null },
    contactedByOtherCandidates: other,
  };
  if (opts.detail) {
    out.applications = apps.map((a) => ({
      applicationId: a.id,
      candidateId: a.candidate_id,
      candidateName: a.candidate_name,
      jobId: a.job_id,
      jobTitle: a.job_title,
      status: a.status,
      createdAt: a.created_at,
      submissions: subs.filter((s) => s.application_id === a.id).map((s) => ({ id: s.id, attempt: s.attempt_no, status: s.status, at: s.at })),
      messages: msgs.filter((m) => m.application_id === a.id).map((m) => ({ id: m.id, direction: m.direction, subject: m.subject || null, kind: m.message_kind || null, category: m.category || null, at: m.at })),
    }));
  }
  return out;
}

/**
 * The compact summary shown in the application preparation response. null when the caller is not a staff user in scope
 * (system actors such as the scheduler need no history) or the job has no employer.
 */
async function summaryFor(client, user, employerId, excludeApplicationId) {
  if (!isUser(user) || !employerId) return null;
  const h = await historyFor(client, user, employerId, { excludeApplicationId });
  return {
    employerId,
    applications: h.totals.applications,
    sent: h.totals.sent,
    replies: h.totals.replies,
    lastContactAt: h.totals.lastContactAt,
    contactedByOtherCandidates: h.contactedByOtherCandidates,
  };
}

module.exports = { historyFor, summaryFor, CONTACTED };
