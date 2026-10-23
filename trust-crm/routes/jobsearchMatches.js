// Matches (mounted at /jobsearch):
//   GET  /candidates/:id/matches     ?page&pageSize   candidate own / staff assigned / admin all, else 404
//   POST /employer-confirmations     admin only (jobsearch:write); records a staff/employer confirmation
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { PERMISSIONS } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const { HttpError } = require("../modules/jobsearch/httpError");
const { authorize } = require("../modules/jobsearch/profileService");
const { isAdmin } = require("../modules/jobsearch/scope");
const { detectOverseas, NOTICE } = require("../modules/jobsearch/matching");
const { sanitizeUntrusted } = require("../modules/jobsearch/matching/sanitize");
const { logAudit } = require("../utils/audit");

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
    `SELECT m.id, m.job_id, m.score, m.reasons, m.missing, m.uncertain, m.employer_support, m.employer_support_evidence, m.created_at,
            j.title, j.location, j.country, j.url, j.description_text, e.name AS employer
       FROM js_matches m JOIN js_jobs j ON j.id = m.job_id LEFT JOIN js_employers e ON e.id = j.employer_id
      WHERE m.candidate_id = $1 AND j.status = 'open'
      ORDER BY m.score DESC, m.id ASC LIMIT $2 OFFSET $3`,
    [id, pageSize, (page - 1) * pageSize]
  )).rows;
  res.json({
    notice: NOTICE,
    matches: rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      score: r.score,
      reasons: r.reasons,
      missing: r.missing,
      uncertain: r.uncertain,
      employerSupport: { label: r.employer_support, evidence: r.employer_support_evidence },
      overseas: detectOverseas(r.description_text),
      firstSeen: r.created_at,
      job: { title: r.title, employer: r.employer, location: r.location, country: r.country, url: r.url },
    })),
    page,
    pageSize,
    total,
  });
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
  let jobIds = [];
  if (b.applicationId !== undefined) {
    applicationId = posInt(b.applicationId);
    if (!applicationId) throw new HttpError(400, "applicationId must be a positive integer");
    const a = await db().query("SELECT a.job_id, j.employer_id FROM js_applications a JOIN js_jobs j ON j.id = a.job_id WHERE a.id = $1", [applicationId]);
    if (!a.rowCount) throw new HttpError(404, "Not found");
    employerId = a.rows[0].employer_id;
    jobIds = [a.rows[0].job_id];
  } else if (b.jobId !== undefined) {
    const jobId = posInt(b.jobId);
    if (!jobId) throw new HttpError(400, "jobId must be a positive integer");
    const j = await db().query("SELECT id, employer_id FROM js_jobs WHERE id = $1", [jobId]);
    if (!j.rowCount) throw new HttpError(404, "Not found");
    employerId = j.rows[0].employer_id;
    if (!employerId) throw new HttpError(400, "This job has no employer record to confirm against");
    jobIds = [jobId];
  } else if (b.employerId !== undefined) {
    employerId = posInt(b.employerId);
    if (!employerId) throw new HttpError(400, "employerId must be a positive integer");
    if (!(await db().query("SELECT 1 FROM js_employers WHERE id = $1", [employerId])).rowCount) throw new HttpError(404, "Not found");
  } else {
    throw new HttpError(400, "employerId, jobId or applicationId is required");
  }
  const client = await db().connect();
  let row;
  try {
    await client.query("BEGIN");
    row = (await client.query(
      "INSERT INTO js_employer_confirmations (employer_id, application_id, kind, evidence_text, confirmed_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, employer_id, application_id, kind, evidence_text, created_at",
      [applicationId ? null : employerId, applicationId, kind, note, req.user.id]
    )).rows[0];
    // Existing matches pick the label up immediately (a later match run resolves it the same way).
    await client.query(
      `UPDATE js_matches SET employer_support = 'confirmed', employer_support_evidence = $1
        WHERE job_id IN (SELECT id FROM js_jobs WHERE ($2::int IS NOT NULL AND employer_id = $2) OR id = ANY($3::int[]))`,
      [note, applicationId ? null : employerId, jobIds]
    );
    await client.query("INSERT INTO js_audit_events (actor, action, detail) VALUES ($1,'employer.confirmation',$2::jsonb)", [`user:${req.user.id}`, JSON.stringify({ confirmationId: row.id, employerId, applicationId, jobIds, kind })]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await logAudit({ userId: req.user.id, action: "jobsearch.employer.confirmation", tableName: "js_employer_confirmations", recordId: row.id, newData: { employerId, applicationId, kind } });
  res.status(201).json({ id: row.id, employerId: row.employer_id, applicationId: row.application_id, kind: row.kind, evidence: row.evidence_text, label: "confirmed", notice: NOTICE });
}));

router.use(jobsearchErrorHandler);

module.exports = router;
