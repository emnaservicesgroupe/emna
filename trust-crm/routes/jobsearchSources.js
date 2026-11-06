// Sources, jobs and "Search now" (mounted at /jobsearch):
//   GET  /sources                      status + describe() + last run          (jobsearch:read)
//   POST /sources/:key/pause|resume                                          (jobsearch:admin)
//   POST /search/run                   {candidateId?, sourceKey?}   (write; no candidateId => admin)
//   GET  /jobs                         ?country&source&status&q&page&pageSize (staff/admin; Candidate 403)
//   GET  /jobs/:id                     one vacancy with its classification      (staff)
//   POST /jobs/:id/classification      {classification|null, evidence?, note?} staff override, audited (jobsearch:approve)
//   POST /jobs/manual                  staff-entered vacancy                   (jobsearch:write)
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { PERMISSIONS } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const { HttpError } = require("../modules/jobsearch/httpError");
const { authorize } = require("../modules/jobsearch/profileService");
const registry = require("../modules/jobsearch/sources");
const { ensureSources, enqueueSearch, runStatus } = require("../modules/jobsearch/searchRunner");
const consentService = require("../modules/jobsearch/consentService");
const jobStore = require("../modules/jobsearch/jobStore");
const classification = require("../modules/jobsearch/classification");
const { logAudit } = require("../utils/audit");

const router = express.Router();
const db = () => require("../db");
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

function need(user, perm) {
  const perms = (user && PERMISSIONS[user.role]) || [];
  if (!(perms.includes("*") || perms.includes(perm))) throw new HttpError(403, `Permission denied: ${perm}`);
}

router.get("/sources", verifyToken, asyncHandler(async (req, res) => {
  need(req.user, "jobsearch:read");
  await ensureSources();
  const rows = (await db().query("SELECT id, key, status, paused, rate_limit_per_min, last_error, last_run_at FROM js_sources ORDER BY id")).rows;
  const out = [];
  for (const row of rows) {
    const adapter = registry.getAdapter(row.key);
    if (!adapter) continue;
    const st = adapter.status();
    const last = (await db().query("SELECT id, started_at, finished_at, found, new_count, errors FROM js_runs WHERE source_id = $1 ORDER BY id DESC LIMIT 1", [row.id])).rows[0];
    out.push({
      key: row.key,
      status: row.status === "unavailable" && st.status === "connected" ? "unavailable" : st.status,
      detail: st.detail,
      paused: row.paused,
      rate_limit_per_min: row.rate_limit_per_min,
      last_error: row.last_error,
      last_run_at: row.last_run_at,
      ...adapter.describe(),
      last_run: last ? { id: last.id, started_at: last.started_at, finished_at: last.finished_at, found: last.found, new_count: last.new_count, status: runStatus(last).status, error: runStatus(last).message, skipped_invalid: runStatus(last).skipped_invalid } : null,
    });
  }
  res.json(out);
}));

async function setPaused(req, res, paused) {
  need(req.user, "jobsearch:admin");
  await ensureSources();
  const r = await db().query("UPDATE js_sources SET paused = $2 WHERE key = $1 RETURNING key, paused", [req.params.key, paused]);
  if (!r.rowCount) throw new HttpError(404, "Not found");
  await db().query("INSERT INTO js_audit_events (actor, action, detail) VALUES ($1,$2,$3::jsonb)", [`user:${req.user.id}`, paused ? "source.pause" : "source.resume", JSON.stringify({ key: req.params.key })]);
  await logAudit({ userId: req.user.id, action: paused ? "jobsearch.source.pause" : "jobsearch.source.resume", tableName: "js_sources", newData: { key: req.params.key } });
  res.json(r.rows[0]);
}
router.post("/sources/:key/pause", verifyToken, asyncHandler((req, res) => setPaused(req, res, true)));
router.post("/sources/:key/resume", verifyToken, asyncHandler((req, res) => setPaused(req, res, false)));

router.post("/search/run", verifyToken, asyncHandler(async (req, res) => {
  const b = body(req);
  if (req.user.role === "Candidate") throw new HttpError(403, "Staff access required");
  need(req.user, "jobsearch:write");
  if (b.sourceKey !== undefined && typeof b.sourceKey !== "string") throw new HttpError(400, "sourceKey must be a string");
  let candidateId;
  if (b.candidateId !== undefined && b.candidateId !== null) {
    const n = typeof b.candidateId === "string" && /^\d+$/.test(b.candidateId) ? Number(b.candidateId) : b.candidateId;
    candidateId = await authorize(req.user, n, "write"); // 404 outside the caller's scope
  } else {
    need(req.user, "jobsearch:admin"); // a candidate-less refresh is not scoped to anyone
  }
  // Authorization, scope and eligibility are checked now AND again when the queue job runs.
  if (b.sourceKey !== undefined && !registry.getAdapter(b.sourceKey)) throw new HttpError(404, "Not found");
  if (candidateId !== undefined) {
    const elig = await consentService.searchEligible(candidateId);
    if (!elig.eligible) throw new HttpError(403, `Candidate is not eligible for search: ${elig.reasons.join(", ")}`);
  }
  await ensureSources();
  const job = await enqueueSearch({ sourceKey: b.sourceKey, candidateId, requestedBy: req.user.id });
  await logAudit({ userId: req.user.id, action: "jobsearch.search.run", tableName: "js_queue", recordId: Number(job.id), newData: { candidateId: candidateId || null, sourceKey: b.sourceKey || null } });
  res.status(202).json({ queued: true, queueId: Number(job.id) });
}));

router.get("/jobs", verifyToken, asyncHandler(async (req, res) => {
  if (req.user.role === "Candidate") throw new HttpError(403, "Candidates see jobs through their matches");
  need(req.user, "jobsearch:read");
  const q = req.query;
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (typeof q.country === "string" && q.country) add("lower(j.country) = lower(?)", q.country);
  if (typeof q.status === "string" && q.status) {
    if (!["open", "expired", "closed"].includes(q.status)) throw new HttpError(400, "status must be open, expired or closed");
    add("j.status = ?", q.status);
  }
  if (typeof q.source === "string" && q.source) add("EXISTS (SELECT 1 FROM js_job_sightings s JOIN js_sources src ON src.id = s.source_id WHERE s.job_id = j.id AND src.key = ?)", q.source);
  if (typeof q.q === "string" && q.q.trim()) {
    params.push(`%${q.q.trim().slice(0, 100).replace(/[\\%_]/g, "\\$&")}%`);
    const n = `$${params.length}`;
    where.push(`(j.title ILIKE ${n} OR e.name ILIKE ${n} OR j.location ILIKE ${n})`);
  }
  const pageSize = Math.min(Math.max(parseInt(q.pageSize, 10) || 25, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  if (page > 10000) throw new HttpError(400, "page must be at most 10000");
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await db().query(`SELECT count(*)::int AS n FROM js_jobs j LEFT JOIN js_employers e ON e.id = j.employer_id ${w}`, params)).rows[0].n;
  const rows = (await db().query(
    `SELECT j.id, j.title, e.name AS employer, j.location, j.country, j.url, j.status, j.published_at, j.last_checked_at, j.closing_at, j.source_primary,
            j.classification, j.classification_evidence, j.classified_by, j.classified_at, j.salary_text, j.employment_type, j.required_experience_text,
            to_char(j.closing_date, 'YYYY-MM-DD') AS closing_date,
            (SELECT array_agg(src.key ORDER BY src.key) FROM js_job_sightings s JOIN js_sources src ON src.id = s.source_id WHERE s.job_id = j.id) AS sources
       FROM js_jobs j LEFT JOIN js_employers e ON e.id = j.employer_id ${w}
      ORDER BY COALESCE(j.published_at, j.created_at) DESC, j.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize]
  )).rows;
  res.json({ jobs: rows, page, pageSize, total });
}));

const jobView = (j) => ({
  id: j.id, title: j.title, status: j.status, url: j.url, location: j.location, country: j.country, source_primary: j.source_primary,
  salaryText: j.salary_text || null, employmentType: j.employment_type || null, requiredExperienceText: j.required_experience_text || null,
  closingDate: j.closing_date_s !== undefined ? j.closing_date_s : j.closing_date ? new Date(j.closing_date).toISOString().slice(0, 10) : null,
  ...classification.presentClassification(j, { staff: true }),
});

router.get("/jobs/:id", verifyToken, asyncHandler(async (req, res) => {
  if (req.user.role === "Candidate") throw new HttpError(403, "Candidates see jobs through their matches");
  need(req.user, "jobsearch:read");
  const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0;
  const r = id ? await db().query("SELECT j.*, to_char(j.closing_date, 'YYYY-MM-DD') AS closing_date_s, e.name AS employer FROM js_jobs j LEFT JOIN js_employers e ON e.id = j.employer_id WHERE j.id = $1", [id]) : { rows: [] };
  if (!r.rows[0]) throw new HttpError(404, "Not found");
  res.json({ job: { ...jobView(r.rows[0]), employer: r.rows[0].employer, description: r.rows[0].description_text }, notice: classification.NOTICE });
}));

router.post("/jobs/:id/classification", verifyToken, asyncHandler(async (req, res) => {
  if (req.user.role === "Candidate") throw new HttpError(403, "Staff access required");
  need(req.user, "jobsearch:approve");
  const b = body(req);
  const row = await classification.setStaffClassification({ jobId: req.params.id, user: req.user, classification: b.classification, evidence: b.evidence, note: b.note });
  const full = (await db().query("SELECT j.*, to_char(j.closing_date, 'YYYY-MM-DD') AS closing_date_s FROM js_jobs j WHERE j.id = $1", [row.id])).rows[0];
  res.json({ job: jobView(full), notice: classification.NOTICE });
}));

router.post("/jobs/manual", verifyToken, asyncHandler(async (req, res) => {
  if (req.user.role === "Candidate") throw new HttpError(403, "Staff access required");
  need(req.user, "jobsearch:write");
  const out = await jobStore.importManual(body(req), req.user);
  await logAudit({ userId: req.user.id, action: "jobsearch.job.manual_import", tableName: "js_jobs", recordId: out.job.id });
  const full = (await db().query("SELECT j.*, to_char(j.closing_date, 'YYYY-MM-DD') AS closing_date_s FROM js_jobs j WHERE j.id = $1", [out.job.id])).rows[0];
  res.status(out.created ? 201 : 200).json({ created: out.created, job: jobView(full) });
}));

router.use(jobsearchErrorHandler);

module.exports = router;
