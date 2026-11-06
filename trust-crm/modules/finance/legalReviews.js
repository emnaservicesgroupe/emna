// Recorded legal reviews for candidate fees. The platform RECORDS what a lawyer or reviewer decided; it gives no legal advice.
// Insert-only: a review is never edited or deleted (database trigger); recording a newer review supersedes the older one (the latest
// row per jurisdiction + service kind decides, see billingGate.latestFor). Recording needs users:write (Admin, SuperAdmin).
const { logAudit } = require("../../utils/audit");
const c = require("./common");
const gate = require("./billingGate");

const { HttpError } = c;
const db = () => require("../../db");

const STATUSES = ["pending", "approved", "prohibited"];
const KINDS = ["candidate_fee"];
const FIELDS = ["jurisdiction", "service_kind", "status", "reviewer_name", "reviewer_role", "reviewed_at", "valid_until", "note", "evidence_key"];
const COLS = `id, jurisdiction, service_kind, status, reviewer_name, reviewer_role, to_char(reviewed_at,'YYYY-MM-DD') AS reviewed_at,
  to_char(valid_until,'YYYY-MM-DD') AS valid_until, note, evidence_key, recorded_by, created_at`;
const EVIDENCE_RE = /^[A-Za-z0-9._-]{1,200}$/;

function validate(input, today) {
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) throw new HttpError(400, `Unknown field: ${k}`);
  const jurisdiction = typeof input.jurisdiction === "string" ? input.jurisdiction.trim().toUpperCase() : "";
  if (!gate.JURISDICTION_RE.test(jurisdiction)) throw new HttpError(400, "jurisdiction must look like CA-ON, CA-QC or TN");
  const serviceKind = input.service_kind === undefined ? "candidate_fee" : input.service_kind;
  if (!KINDS.includes(serviceKind)) throw new HttpError(400, `service_kind must be one of ${KINDS.join(", ")}`);
  if (!STATUSES.includes(input.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}`);
  const reviewerName = c.requiredText(input.reviewer_name, "reviewer_name", 200);
  const reviewerRole = c.cleanText(input.reviewer_role, "reviewer_role", 200);
  if (input.reviewed_at === undefined || input.reviewed_at === null) throw new HttpError(400, "reviewed_at is required");
  const reviewedAt = c.parseDate(input.reviewed_at, "reviewed_at");
  if (reviewedAt > today) throw new HttpError(400, "reviewed_at cannot be in the future");
  const validUntil = input.valid_until === undefined || input.valid_until === null ? null : c.parseDate(input.valid_until, "valid_until");
  if (validUntil && validUntil < reviewedAt) throw new HttpError(400, "valid_until cannot be before reviewed_at");
  const note = c.cleanText(input.note, "note", 2000);
  const evidence = c.cleanText(input.evidence_key, "evidence_key", 200);
  if (evidence !== null && !EVIDENCE_RE.test(evidence)) throw new HttpError(400, "evidence_key must be a file reference (letters, digits, . _ -)");
  return { jurisdiction, serviceKind, status: input.status, reviewerName, reviewerRole, reviewedAt, validUntil, note, evidence };
}

/** Records a review (users:write). Never updates an earlier row. */
async function record(user, input, opts = {}) {
  c.requirePerm(user, "users:write");
  const v = validate(input, gate.todayUtc(opts.now));
  return c.inTransaction(async (client) => {
    const r = await client.query(
      `INSERT INTO fin_legal_reviews (jurisdiction, service_kind, status, reviewer_name, reviewer_role, reviewed_at, valid_until, note, evidence_key, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10) RETURNING ${COLS}`,
      [v.jurisdiction, v.serviceKind, v.status, v.reviewerName, v.reviewerRole, v.reviewedAt, v.validUntil, v.note, v.evidence, user.id]
    );
    await logAudit({ client, userId: user.id, action: "CREATE", tableName: "fin_legal_reviews", recordId: r.rows[0].id, newData: r.rows[0] });
    return r.rows[0];
  });
}

/** History (newest first) with `current` marking the row that decides for its jurisdiction + kind. finance:read. */
async function list(user, query = {}) {
  c.requirePerm(user, "finance:read");
  const where = [];
  const params = [];
  const add = (val) => (params.push(val), `$${params.length}`);
  const j = c.oneValue(query.jurisdiction, "jurisdiction");
  if (j !== undefined && j !== "") {
    const up = j.trim().toUpperCase();
    if (!gate.JURISDICTION_RE.test(up)) throw new HttpError(400, "jurisdiction must look like CA-ON, CA-QC or TN");
    where.push(`r.jurisdiction = ${add(up)}`);
  }
  const k = c.oneValue(query.service_kind, "service_kind");
  if (k !== undefined && k !== "") {
    if (!KINDS.includes(k)) throw new HttpError(400, `service_kind must be one of ${KINDS.join(", ")}`);
    where.push(`r.service_kind = ${add(k)}`);
  }
  const { limit, offset } = c.pageParams(query);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await db().query(`SELECT count(*)::int AS n FROM fin_legal_reviews r ${w}`, params)).rows[0].n;
  const rows = (
    await db().query(
      `SELECT r.id, r.jurisdiction, r.service_kind, r.status, r.reviewer_name, r.reviewer_role, to_char(r.reviewed_at,'YYYY-MM-DD') AS reviewed_at,
              to_char(r.valid_until,'YYYY-MM-DD') AS valid_until, r.note, r.evidence_key, r.recorded_by, r.created_at, (l.id IS NOT NULL) AS current
         FROM fin_legal_reviews r LEFT JOIN fin_legal_reviews_latest l ON l.id = r.id ${w}
        ORDER BY r.id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params
    )
  ).rows;
  return { rows, total };
}

module.exports = { record, list, latestFor: gate.latestFor, STATUSES };
