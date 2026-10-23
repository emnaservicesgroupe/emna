// Staff-attested candidate consent to share a limited summary with ONE employer. Withdrawable. At most one ACTIVE
// consent per (candidate, employer) (partial unique index). The staff user must be able to see the candidate
// (candidate scope); every mutation writes crm_timeline (entity share_consent) + audit_logs in one transaction.
const { HttpError } = require("../jobsearch/httpError");
const { assertCandidateAccess } = require("../jobsearch/scope");
const { logAudit } = require("../../utils/audit");
const timeline = require("../crm/timeline");
const { inTransaction, parseId, hasPerm } = require("../crm/leadsAdmin");

const db = () => require("../../db");
const BASIS_MAX = 500;
const COLS = `sc.id, sc.candidate_id, sc.employer_id, e.name AS employer_name, sc.basis, sc.recorded_by,
  sc.recorded_at, sc.withdrawn_at`;

function cleanBasis(v) {
  if (typeof v !== "string") throw new HttpError(400, "basis is required");
  if (v.includes("\u0000")) throw new HttpError(400, "basis contains invalid characters");
  const t = v.trim();
  if (t.length < 1 || t.length > BASIS_MAX) throw new HttpError(400, `basis must be 1..${BASIS_MAX} characters`);
  return t;
}

async function list(user, rawCandidateId) {
  const id = parseId(rawCandidateId);
  await assertCandidateAccess(user, id);
  const r = await db().query(
    `SELECT ${COLS} FROM candidate_share_consents sc JOIN crm_employers e ON e.id = sc.employer_id
      WHERE sc.candidate_id = $1 ORDER BY sc.recorded_at DESC, sc.id DESC`,
    [id]
  );
  return { rows: r.rows };
}

async function record(user, rawCandidateId, input) {
  const id = parseId(rawCandidateId);
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  for (const k of Object.keys(body)) if (k !== "employer_id" && k !== "basis") throw new HttpError(400, `Unknown field: ${k.slice(0, 40)}`);
  const employerId = parseId(typeof body.employer_id === "number" ? String(body.employer_id) : body.employer_id);
  const basis = cleanBasis(body.basis);
  await assertCandidateAccess(user, id);
  return inTransaction(async (client) => {
    const emp = await client.query("SELECT id FROM crm_employers WHERE id = $1 FOR SHARE", [employerId]);
    if (emp.rowCount === 0) throw new HttpError(404, "Employer not found");
    // Serialise per candidate so the duplicate check and insert cannot race (the unique index is the backstop).
    await client.query("SELECT 1 FROM candidates WHERE id = $1 FOR UPDATE", [id]);
    const dup = await client.query("SELECT 1 FROM candidate_share_consents WHERE candidate_id = $1 AND employer_id = $2 AND withdrawn_at IS NULL", [id, employerId]);
    if (dup.rowCount > 0) throw new HttpError(409, "An active share consent already exists for this candidate and employer");
    const ins = await client.query(
      "INSERT INTO candidate_share_consents (candidate_id, employer_id, basis, recorded_by) VALUES ($1,$2,$3,$4) RETURNING id",
      [id, employerId, basis, user.id]
    );
    const cid = ins.rows[0].id;
    await timeline.add(client, { entity: "share_consent", entityId: cid, actorId: user.id, event: "recorded", detail: { candidate_id: id, employer_id: employerId } });
    await logAudit({ client, userId: user.id, action: "crm.share_consent.record", tableName: "candidate_share_consents", recordId: String(cid), newData: { candidate_id: id, employer_id: employerId, basis } });
    return (await client.query(`SELECT ${COLS} FROM candidate_share_consents sc JOIN crm_employers e ON e.id = sc.employer_id WHERE sc.id = $1`, [cid])).rows[0];
  });
}

async function withdraw(user, rawCandidateId, rawConsentId) {
  const id = parseId(rawCandidateId);
  const consentId = parseId(rawConsentId);
  // Withdrawing a consent is a safety action: Admin/SuperAdmin may always do it (candidate soft-deleted or reassigned
  // out of scope); other staff need the usual candidate scope.
  if (!hasPerm(user, "users:write")) await assertCandidateAccess(user, id);
  return inTransaction(async (client) => {
    const cur = await client.query("SELECT id, employer_id, withdrawn_at FROM candidate_share_consents WHERE id = $1 AND candidate_id = $2 FOR UPDATE", [consentId, id]);
    if (cur.rowCount === 0) throw new HttpError(404, "Not found");
    if (cur.rows[0].withdrawn_at) throw new HttpError(409, "Consent is already withdrawn");
    await client.query("UPDATE candidate_share_consents SET withdrawn_at = GREATEST(now(), recorded_at) WHERE id = $1", [consentId]);
    await timeline.add(client, { entity: "share_consent", entityId: consentId, actorId: user.id, event: "withdrawn", detail: { candidate_id: id, employer_id: Number(cur.rows[0].employer_id) } });
    await logAudit({ client, userId: user.id, action: "crm.share_consent.withdraw", tableName: "candidate_share_consents", recordId: String(consentId), oldData: { withdrawn: false }, newData: { withdrawn: true } });
    return (await client.query(`SELECT ${COLS} FROM candidate_share_consents sc JOIN crm_employers e ON e.id = sc.employer_id WHERE sc.id = $1`, [consentId])).rows[0];
  });
}

module.exports = { list, record, withdraw, BASIS_MAX };
