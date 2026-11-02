// Service contracts between a candidate and a catalogue service (fin_service_contracts). A contract starts as a draft, becomes
// active when the signed agreement is recorded (agreement_signed_at, optionally the signed document stored as a private file),
// and ends or is cancelled. The billing gate (billingGate.js) only counts ACTIVE, signed, not-ended contracts.
//   create (finance:write)  sign (finance:write)  end / cancel (finance:void)  list / get / document (finance:read)
//   myContracts: role Candidate, own non-draft contracts only (no created_by, no stored document key, no staff data).
const { logAudit } = require("../../utils/audit");
const c = require("./common");
const gate = require("./billingGate");
const candidateView = require("./candidateView");

const { HttpError } = c;
const db = () => require("../../db");
const storage = () => require("../jobsearch/storage");

const TERMS_MAX = 2000;
const NAME_MAX = 200;
const REASON_MAX = 500;
const STATUSES = ["draft", "active", "ended", "cancelled"];

const STAFF_SELECT = `SELECT k.id, k.candidate_id, cd.full_name AS candidate_name, k.service_id, s.code AS service_code, s.kind AS service_kind,
       COALESCE(s.name_en, s.name_fr, s.name_ar) AS service_name, k.status, k.agreement_signed_at, k.signed_by_name,
       (k.signed_document_key IS NOT NULL) AS has_signed_document, to_char(k.start_date,'YYYY-MM-DD') AS start_date,
       to_char(k.end_date,'YYYY-MM-DD') AS end_date, k.refund_terms, k.jurisdiction, k.created_by, k.created_at, k.updated_at
  FROM fin_service_contracts k JOIN fin_services s ON s.id = k.service_id JOIN candidates cd ON cd.id = k.candidate_id`;

const notFound = () => new HttpError(404, "Contract not found");
const contractId = (raw) => c.parseId(raw, { notFound: "Contract not found" });

async function load(client, id) {
  return (await client.query(`${STAFF_SELECT} WHERE k.id = $1 AND cd.is_deleted = false`, [id])).rows[0] || null;
}

function bodyOnly(input, allowed) {
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  for (const k of Object.keys(input)) if (!allowed.includes(k)) throw new HttpError(400, `Unknown field: ${k}`);
}

/** Creates a draft contract (finance:write). */
async function create(user, input) {
  c.requirePerm(user, "finance:write");
  bodyOnly(input, ["candidate_id", "service_id", "start_date", "end_date", "refund_terms"]);
  const candidateId = c.parseId(input.candidate_id, { label: "candidate_id" });
  const serviceId = c.parseId(input.service_id, { label: "service_id" });
  const start = input.start_date === undefined || input.start_date === null ? null : c.parseDate(input.start_date, "start_date");
  const end = input.end_date === undefined || input.end_date === null ? null : c.parseDate(input.end_date, "end_date");
  if (start && end && end < start) throw new HttpError(400, "end_date cannot be before start_date");
  const terms = c.cleanText(input.refund_terms, "refund_terms", TERMS_MAX);
  return c.inTransaction(async (client) => {
    if (!(await client.query("SELECT 1 FROM candidates WHERE id = $1 AND is_deleted = false FOR SHARE", [candidateId])).rowCount) throw new HttpError(404, "Candidate not found");
    const svc = (await client.query("SELECT id, active FROM fin_services WHERE id = $1", [serviceId])).rows[0];
    if (!svc) throw new HttpError(400, "service_id: service not found");
    if (!svc.active) throw new HttpError(409, "The service is inactive");
    const ins = await client.query(
      "INSERT INTO fin_service_contracts (candidate_id, service_id, status, start_date, end_date, refund_terms, created_by) VALUES ($1,$2,'draft',$3,$4,$5,$6) RETURNING id",
      [candidateId, serviceId, start, end, terms, user.id]
    );
    const row = await load(client, ins.rows[0].id);
    await logAudit({ client, userId: user.id, action: "CREATE", tableName: "fin_service_contracts", recordId: row.id, newData: row });
    return row;
  });
}

function storageError(err) {
  const code = err && err.code;
  if (code === "FILE_TOO_LARGE") return new HttpError(413, "File too large");
  if (code === "UNSUPPORTED_TYPE" || code === "INVALID_UPLOAD") return new HttpError(400, "The signed document must be a PDF, DOCX, PNG or JPEG file");
  return null;
}

/**
 * Records the signed agreement (finance:write): draft -> active. `file` is an optional {buffer} stored as a private file (content
 * sniffed, never trusted by name). Body: {signed_by_name, signed_at?, jurisdiction?}; signed_at defaults to now and cannot be in the future;
 * when it is older than 60 days a signed document upload is required. `jurisdiction` (CA-ON, CA-QC, TN...) is REQUIRED for a
 * candidate_fee service: staff record which legal review covers this contract (the candidate cannot choose it).
 */
async function sign(user, rawId, input, file = null) {
  c.requirePerm(user, "finance:write");
  const id = contractId(rawId);
  bodyOnly(input, ["signed_by_name", "signed_at", "jurisdiction"]);
  let jurisdiction = null;
  if (input.jurisdiction !== undefined && input.jurisdiction !== null && input.jurisdiction !== "") {
    jurisdiction = typeof input.jurisdiction === "string" ? input.jurisdiction.trim().toUpperCase() : "";
    if (!gate.JURISDICTION_RE.test(jurisdiction)) throw new HttpError(400, "jurisdiction must look like CA-ON, CA-QC or TN");
  }
  const signedBy = c.requiredText(input.signed_by_name, "signed_by_name", NAME_MAX);
  let signedAt = null;
  if (input.signed_at !== undefined && input.signed_at !== null && input.signed_at !== "") {
    const d = typeof input.signed_at === "string" ? new Date(input.signed_at) : null;
    if (!d || Number.isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(input.signed_at)) throw new HttpError(400, "signed_at must be an ISO date or date-time");
    signedAt = d.toISOString();
  }
  try {
    return await c.inTransaction(async (client) => {
      const cur = (
        await client.query(
          `SELECT k.id, k.candidate_id, k.service_id, k.status, s.active AS service_active, s.kind AS service_kind
             FROM fin_service_contracts k JOIN fin_services s ON s.id = k.service_id JOIN candidates cd ON cd.id = k.candidate_id AND cd.is_deleted = false
            WHERE k.id = $1 FOR UPDATE OF k`,
          [id]
        )
      ).rows[0];
      if (!cur) throw notFound();
      if (cur.status !== "draft") throw new HttpError(409, `Contract is ${cur.status}; only a draft can be signed`);
      if (!cur.service_active) throw new HttpError(409, "The service is inactive");
      if (signedAt) {
        const chk = (await client.query("SELECT $1::timestamptz <= now() AS ok, $1::timestamptz >= timestamptz '2000-01-01' AS sane, $1::timestamptz < now() - interval '60 days' AS old", [signedAt])).rows[0];
        if (!chk.ok || !chk.sane) throw new HttpError(400, "signed_at cannot be in the future");
        // An agreement dated long ago is only believable with the signed paper behind it.
        if (chk.old && !(file && file.buffer)) throw new HttpError(400, "A signed document upload is required when the agreement is dated more than 60 days ago");
      }
      if (cur.service_kind === "candidate_fee" && !jurisdiction) throw new HttpError(400, "jurisdiction is required to sign a candidate-fee contract (for example CA-ON, CA-QC or TN)");
      let key = null;
      if (file && file.buffer) {
        try {
          key = (await storage().put(file.buffer, { candidateId: cur.candidate_id })).key;
        } catch (err) {
          throw storageError(err) || err;
        }
      }
      await client.query(
        `UPDATE fin_service_contracts SET status = 'active', agreement_signed_at = COALESCE($2::timestamptz, now()), signed_by_name = $3,
                signed_document_key = COALESCE($4, signed_document_key), jurisdiction = COALESCE($5, jurisdiction), updated_at = now() WHERE id = $1`,
        [id, signedAt, signedBy, key, jurisdiction]
      );
      const row = await load(client, id);
      await logAudit({ client, userId: user.id, action: "UPDATE", tableName: "fin_service_contracts", recordId: id, oldData: { status: "draft" }, newData: { status: "active", event: "sign", agreement_signed_at: row.agreement_signed_at, signed_by_name: signedBy, has_signed_document: row.has_signed_document, jurisdiction: row.jurisdiction } });
      return row;
    });
  } catch (err) {
    if (err && err.code === "23505") throw new HttpError(409, "An active contract for this candidate and service already exists");
    throw err;
  }
}

async function finish(user, rawId, input, { to, from, event }) {
  c.requirePerm(user, "finance:void");
  const id = contractId(rawId);
  bodyOnly(input, ["reason"]);
  const reason = c.cleanText(input.reason, "reason", REASON_MAX);
  return c.inTransaction(async (client) => {
    const cur = (await client.query("SELECT id, status FROM fin_service_contracts WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!cur) throw notFound();
    if (!from.includes(cur.status)) throw new HttpError(409, `Contract is ${cur.status}; it cannot be ${to === "ended" ? "ended" : "cancelled"}`);
    await client.query("UPDATE fin_service_contracts SET status = $2, updated_at = now() WHERE id = $1", [id, to]);
    const row = await load(client, id);
    await logAudit({ client, userId: user.id, action: "UPDATE", tableName: "fin_service_contracts", recordId: id, oldData: { status: cur.status }, newData: { status: to, event, reason } });
    return row;
  });
}

const end = (user, id, input) => finish(user, id, input, { to: "ended", from: ["active"], event: "end" });
const cancel = (user, id, input) => finish(user, id, input, { to: "cancelled", from: ["draft", "active"], event: "cancel" });

async function list(user, query = {}) {
  c.requirePerm(user, "finance:read");
  const where = ["cd.is_deleted = false"];
  const params = [];
  const add = (val) => (params.push(val), `$${params.length}`);
  const cand = c.oneValue(query.candidate_id, "candidate_id");
  if (cand !== undefined && cand !== "") where.push(`k.candidate_id = ${add(c.parseId(cand, { label: "candidate_id" }))}`);
  const svc = c.oneValue(query.service_id, "service_id");
  if (svc !== undefined && svc !== "") where.push(`k.service_id = ${add(c.parseId(svc, { label: "service_id" }))}`);
  const status = c.oneValue(query.status, "status");
  if (status !== undefined && status !== "") {
    if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}`);
    where.push(`k.status = ${add(status)}`);
  }
  const { limit, offset } = c.pageParams(query);
  const w = `WHERE ${where.join(" AND ")}`;
  const total = (await db().query(`SELECT count(*)::int AS n FROM fin_service_contracts k JOIN candidates cd ON cd.id = k.candidate_id ${w}`, params)).rows[0].n;
  const rows = (await db().query(`${STAFF_SELECT} ${w} ORDER BY k.id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`, params)).rows;
  return { rows, total };
}

async function get(user, rawId) {
  c.requirePerm(user, "finance:read");
  const id = contractId(rawId);
  const row = await load(db(), id);
  if (!row) throw notFound();
  return row;
}

/** The signed document bytes for staff (finance:read). */
async function document(user, rawId) {
  c.requirePerm(user, "finance:read");
  const id = contractId(rawId);
  const r = (await db().query("SELECT k.signed_document_key AS key FROM fin_service_contracts k JOIN candidates cd ON cd.id = k.candidate_id AND cd.is_deleted = false WHERE k.id = $1", [id])).rows[0];
  if (!r || !r.key) throw new HttpError(404, "No signed document");
  let buf;
  try {
    buf = await storage().get(r.key);
  } catch {
    throw new HttpError(404, "No signed document");
  }
  return { buffer: buf, mime: storage().sniffMime(buf), filename: `contract-${id}.${r.key.split(".").pop()}` };
}

/** Candidate self-view (role Candidate only): own non-draft contracts, terms and dates; nothing internal. */
async function myContracts(user) {
  candidateView.requireCandidate(user);
  const client = await db().connect();
  try {
    const cand = await candidateView.ownCandidateId(client, user.id);
    const rows = (
      await client.query(
        `SELECT k.id, COALESCE(s.name_en, s.name_fr, s.name_ar) AS service_name, s.name_ar, s.name_en, s.name_fr, k.status, k.agreement_signed_at,
                (k.signed_document_key IS NOT NULL) AS has_signed_document, to_char(k.start_date,'YYYY-MM-DD') AS start_date,
                to_char(k.end_date,'YYYY-MM-DD') AS end_date, k.refund_terms
           FROM fin_service_contracts k JOIN fin_services s ON s.id = k.service_id
          WHERE k.candidate_id = $1 AND k.status <> 'draft' ORDER BY k.id DESC LIMIT 100`,
        [cand]
      )
    ).rows;
    return { contracts: rows };
  } finally {
    client.release();
  }
}

module.exports = { create, sign, end, cancel, list, get, document, myContracts, STATUSES };
