// Matches (mounted at /jobsearch):
//   GET  /candidates/:id/matches     ?page&pageSize   candidate own / staff assigned / admin all, else 404
//   POST /matches/:id/accept|reject  {note?} jobsearch:approve (Manager/Admin) in scope; Agent 403; idempotent; re-decision audited
//   GET  /match-settings             staff; PUT /match-settings  admin only: {require_match_acceptance: boolean}
//   POST /employer-confirmations     admin only (jobsearch:write); job-scoped (jobId/applicationId) or employer-wide (employerId); evidence note required
//   DELETE /employer-confirmations/:id  admin only; revokes (labels revert immediately)
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { PERMISSIONS } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const { HttpError } = require("../modules/jobsearch/httpError");
const { authorize } = require("../modules/jobsearch/profileService");
const { isAdmin } = require("../modules/jobsearch/scope");
const { NOTICE, BAND_LABELS } = require("../modules/jobsearch/matching");
const classification = require("../modules/jobsearch/classification");
const matchDecision = require("../modules/jobsearch/matchDecision");
const settingsService = require("../modules/jobsearch/settingsService");
const { sanitizeUntrusted } = require("../modules/jobsearch/matching/sanitize");
const { relabelJobs, lockForRelabel } = require("../modules/jobsearch/matchService");
const { logAudit } = require("../utils/audit");

const { supportNotice } = require("../modules/jobsearch/exportService");

const router = express.Router();
const db = () => require("../db");
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
const posInt = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);

router.get("/candidates/:id/matches", verifyToken, asyncHandler(async (req, res) => {
  const id = await authorize(req.user, req.params.id, "read"); // 404 outside the caller's scope
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  if (page > 10000) throw new HttpError(400, "page must be at most 10000");
  const total = (await db().query("SELECT count(*)::int AS n FROM js_matches m JOIN js_jobs j ON j.id = m.job_id WHERE m.candidate_id = $1 AND j.status = 'open'", [id])).rows[0].n;
  const rows = (await db().query(
    `SELECT m.id, m.job_id, m.score, m.band, m.decision, m.decision_by, m.decided_at, m.decision_note, m.reasons, m.missing, m.uncertain, m.employer_support, m.employer_support_evidence, m.employer_support_conflict, m.overseas_accepted, m.overseas_applicants_evidence, m.created_at,
            j.title, j.location, j.country, j.url, e.name AS employer,
            j.classification, j.classification_evidence, j.classified_at, j.classified_by, j.salary_text, j.employment_type, j.required_experience_text,
            to_char(j.closing_date, 'YYYY-MM-DD') AS closing_date
       FROM js_matches m JOIN js_jobs j ON j.id = m.job_id LEFT JOIN js_employers e ON e.id = j.employer_id
      WHERE m.candidate_id = $1 AND j.status = 'open'
      ORDER BY m.score DESC, m.id ASC LIMIT $2 OFFSET $3`,
    [id, pageSize, (page - 1) * pageSize]
  )).rows;
  const staff = req.user.role !== "Candidate";
  res.json({
    notice: NOTICE,
    classificationNotice: classification.NOTICE,
    matches: rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      score: r.score,
      band: r.band,
      bandLabel: r.band ? BAND_LABELS[r.band] : null,
      // The staff decision and its note are never shown to the candidate here (they see a state only through an existing application).
      ...(staff ? { decision: r.decision, decisionBy: r.decision_by, decidedAt: r.decided_at, decisionNote: r.decision_note } : {}),
      reasons: r.reasons,
      missing: r.missing,
      uncertain: r.uncertain,
      employerSupport: { label: r.employer_support, evidence: r.employer_support_evidence, ...(r.employer_support_conflict ? { conflict: true } : {}), notice: supportNotice(r.employer_support) },
      overseas: { accepted: r.overseas_accepted, evidence: r.overseas_applicants_evidence },
      firstSeen: r.created_at,
      job: {
        title: r.title, employer: r.employer, location: r.location, country: r.country, url: r.url,
        salaryText: r.salary_text, employmentType: r.employment_type, requiredExperienceText: r.required_experience_text, closingDate: r.closing_date,
        ...classification.presentClassification(r, { staff }),
      },
    })),
    page,
    pageSize,
    total,
  });
}));

for (const [verb, decision] of [["accept", "accepted"], ["reject", "rejected"]]) {
  router.post(`/matches/:id/${verb}`, verifyToken, asyncHandler(async (req, res) => {
    res.json(await matchDecision.decide({ matchId: req.params.id, actor: req.user, decision, note: body(req).note }));
  }));
}

router.get("/match-settings", verifyToken, asyncHandler(async (req, res) => {
  const perms = PERMISSIONS[req.user && req.user.role] || [];
  if (req.user.role === "Candidate" || !(perms.includes("*") || perms.includes("jobsearch:read"))) throw new HttpError(403, "Access denied");
  res.json(await settingsService.getMatchSettings());
}));

router.put("/match-settings", verifyToken, asyncHandler(async (req, res) => {
  res.json(await settingsService.updateMatchSettings(req.body, req.user));
}));

router.post("/employer-confirmations", verifyToken, asyncHandler(async (req, res) => {
  const perms = PERMISSIONS[req.user && req.user.role] || [];
  if (!isAdmin(req.user) || !(perms.includes("*") || perms.includes("jobsearch:write"))) throw new HttpError(403, "Admin access required");
  const b = body(req);
  const note = typeof b.evidenceNote === "string" ? sanitizeUntrusted(b.evidenceNote, 2000).replace(/\s+/g, " ").trim() : "";
  if (!note) throw new HttpError(400, "evidenceNote is required (what was confirmed, by whom, and how)");
  const kind = b.kind === undefined ? "staff" : b.kind;
  if (!["staff", "employer"].includes(kind)) throw new HttpError(400, "kind must be staff or employer");
  let employerId = null;
  let applicationId = null;
  let jobId = null;
  let applicationCandidate = null;
  if (b.applicationId !== undefined) {
    applicationId = posInt(b.applicationId);
    if (!applicationId) throw new HttpError(400, "applicationId must be a positive integer");
    const a = await db().query("SELECT a.job_id, a.candidate_id, j.employer_id FROM js_applications a JOIN js_jobs j ON j.id = a.job_id WHERE a.id = $1", [applicationId]);
    if (!a.rowCount) throw new HttpError(404, "Not found");
    employerId = a.rows[0].employer_id;
    applicationCandidate = a.rows[0].candidate_id;
    jobId = a.rows[0].job_id;
  } else if (b.jobId !== undefined) {
    jobId = posInt(b.jobId);
    if (!jobId) throw new HttpError(400, "jobId must be a positive integer");
    const j = await db().query("SELECT id, employer_id FROM js_jobs WHERE id = $1", [jobId]);
    if (!j.rowCount) throw new HttpError(404, "Not found");
    employerId = j.rows[0].employer_id;
  } else if (b.employerId !== undefined) {
    // Employer-wide: applies to every job of this employer (employers are matched by normalized name only).
    employerId = posInt(b.employerId);
    if (!employerId) throw new HttpError(400, "employerId must be a positive integer");
    if (!(await db().query("SELECT 1 FROM js_employers WHERE id = $1", [employerId])).rowCount) throw new HttpError(404, "Not found");
  } else {
    throw new HttpError(400, "employerId, jobId or applicationId is required");
  }
  const scope = jobId ? "job" : "employer";
  const client = await db().connect();
  let row;
  try {
    await client.query("BEGIN");
    // Lock order candidates -> applications (as in consent/approval paths): lock the affected
    // candidates (and the application's candidate) BEFORE the insert, whose FK check locks the application.
    const affected = jobId ? [jobId] : (await client.query("SELECT id FROM js_jobs WHERE employer_id = $1", [employerId])).rows.map((r) => r.id);
    const locked = await lockForRelabel(client, affected, applicationCandidate ? [applicationCandidate] : []);
    row = (await client.query(
      "INSERT INTO js_employer_confirmations (employer_id, application_id, job_id, kind, evidence_text, confirmed_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, employer_id, application_id, job_id, kind, evidence_text, created_at",
      [employerId, applicationId, jobId, kind, note, req.user.id]
    )).rows[0];
    await relabelJobs(client, affected, { candidateIds: locked, now: new Date() });
    await client.query("INSERT INTO js_audit_events (actor, action, detail) VALUES ($1,'employer.confirmation',$2::jsonb)", [`user:${req.user.id}`, JSON.stringify({ confirmationId: row.id, employerId, applicationId, jobId, scope, kind })]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await logAudit({ userId: req.user.id, action: "jobsearch.employer.confirmation", tableName: "js_employer_confirmations", recordId: row.id, newData: { employerId, applicationId, jobId, scope, kind } });
  res.status(201).json({ id: row.id, scope, jobId: row.job_id, employerId: row.employer_id, applicationId: row.application_id, kind: row.kind, evidence: row.evidence_text, label: "confirmed", notice: NOTICE });
}));

router.delete("/employer-confirmations/:id", verifyToken, asyncHandler(async (req, res) => {
  const perms = PERMISSIONS[req.user && req.user.role] || [];
  if (!isAdmin(req.user) || !(perms.includes("*") || perms.includes("jobsearch:write"))) throw new HttpError(403, "Admin access required");
  const id = posInt(req.params.id);
  if (!id) throw new HttpError(404, "Not found");
  const client = await db().connect();
  let row;
  try {
    await client.query("BEGIN");
    // Resolve the scope without locking, lock the affected candidates, then revoke (same order as POST).
    const target = (await client.query("SELECT job_id, employer_id, application_id FROM js_employer_confirmations WHERE id = $1 AND revoked_at IS NULL", [id])).rows[0];
    if (!target) throw new HttpError(404, "Not found");
    const affected = target.job_id ? [target.job_id] : (await client.query("SELECT id FROM js_jobs WHERE employer_id = $1", [target.employer_id])).rows.map((r) => r.id);
    const appCand = target.application_id ? (await client.query("SELECT candidate_id FROM js_applications WHERE id = $1", [target.application_id])).rows.map((r) => r.candidate_id) : [];
    const locked = await lockForRelabel(client, affected, appCand);
    row = (await client.query("UPDATE js_employer_confirmations SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id, employer_id, job_id", [id, req.user.id])).rows[0];
    if (!row) throw new HttpError(404, "Not found");
    await relabelJobs(client, affected, { candidateIds: locked, now: new Date() });
    await client.query("INSERT INTO js_audit_events (actor, action, detail) VALUES ($1,'employer.confirmation.revoke',$2::jsonb)", [`user:${req.user.id}`, JSON.stringify({ confirmationId: id, employerId: row.employer_id, jobId: row.job_id })]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await logAudit({ userId: req.user.id, action: "jobsearch.employer.confirmation.revoke", tableName: "js_employer_confirmations", recordId: id });
  res.json({ id, revoked: true });
}));

router.use(jobsearchErrorHandler);

module.exports = router;
