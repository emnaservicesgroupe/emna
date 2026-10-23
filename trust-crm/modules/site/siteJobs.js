// Public read side of staff-published offers. Explicit column allowlist: internal fields
// (evidence_note, status, created_by, ...) can never leak.
const COLUMNS = [
  "id",
  "title",
  "employer_name",
  "country",
  "city",
  "category",
  "description",
  "requirements",
  "language_requirements",
  "employment_type",
  "salary_text",
  "apply_mode",
  "published_at",
  "closes_at",
];
const SELECT = COLUMNS.join(", ");
const LIVE = "status = 'published' AND (closes_at IS NULL OR closes_at > now())";

async function listPublishedJobs(pool, { country, category, limit, offset } = {}) {
  const lim = Math.min(50, Math.max(1, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 20));
  const off = Math.max(0, Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0);
  const params = [];
  let where = LIVE;
  if (typeof country === "string" && country.trim()) {
    params.push(country.trim().slice(0, 80));
    where += ` AND lower(country) = lower($${params.length})`;
  }
  if (typeof category === "string" && category.trim()) {
    params.push(category.trim().slice(0, 80));
    where += ` AND lower(category) = lower($${params.length})`;
  }
  params.push(lim, off);
  const r = await pool.query(
    `SELECT ${SELECT} FROM site_jobs WHERE ${where} ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return r.rows;
}

async function getPublishedJob(pool, id) {
  if (!/^\d{1,15}$/.test(String(id))) return null;
  const r = await pool.query(`SELECT ${SELECT} FROM site_jobs WHERE id = $1 AND ${LIVE}`, [String(id)]);
  return r.rows[0] || null;
}

module.exports = { listPublishedJobs, getPublishedJob, COLUMNS };
