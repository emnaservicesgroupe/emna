// The billing gate for candidate fees: ONE place that decides whether a candidate may be invoiced for (or pay against) a service of
// kind 'candidate_fee'. Used by createInvoice (v2), the legacy POST /finance/invoices, the payment path and GET /finance/billing-status.
//
// A candidate_fee line is billable only when ALL hold:
//   (a) legal review: the candidate's jurisdiction ('CA-' + desired_province, else FIN_DEFAULT_JURISDICTION) has a latest review for
//       service_kind 'candidate_fee' whose status is 'approved' and whose valid_until is empty or today (UTC) or later;
//       'prohibited' => 409 candidate_fee_prohibited; none / pending / expired => 409 legal_review_required;
//       no jurisdiction at all => 409 jurisdiction_unknown;
//   (b) contract: the candidate has an ACTIVE contract for that very service with agreement_signed_at set (not draft / ended /
//       cancelled; an end_date in the past also ends it) => otherwise 409 service_contract_required.
// The platform RECORDS legal reviews; messages here state the missing record only and are not legal advice. Employer-funded
// arrangements and services of kind 'standard' are never touched.
const { HttpError } = require("../jobsearch/httpError");

const KIND = "candidate_fee";
const JURISDICTION_RE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

let clock = () => new Date();
/** Test hook: replaces the clock used for "today" (UTC). Pass nothing to restore the real clock. */
function setClock(fn) {
  clock = typeof fn === "function" ? fn : () => new Date();
}
function todayUtc(now) {
  const d = now !== undefined && now !== null ? new Date(now) : clock();
  if (Number.isNaN(d.getTime())) throw new Error("billingGate: invalid clock value");
  return d.toISOString().slice(0, 10);
}

function defaultJurisdiction() {
  const v = String(process.env.FIN_DEFAULT_JURISDICTION || "").trim().toUpperCase();
  return JURISDICTION_RE.test(v) ? v : null;
}

/** 'CA-ON' from the candidate's desired_province, else the configured default, else null. */
async function jurisdictionFor(client, candidateId) {
  const row = (await client.query("SELECT desired_province FROM candidates WHERE id = $1", [candidateId])).rows[0];
  if (row && row.desired_province) return `CA-${row.desired_province}`;
  return defaultJurisdiction();
}

/** The latest review (reviewed_at, then id) for a jurisdiction and kind; null when none was ever recorded. */
async function latestFor(jurisdiction, kind = KIND, client = null) {
  const q = "SELECT id, jurisdiction, service_kind, status, reviewer_name, reviewer_role, to_char(reviewed_at,'YYYY-MM-DD') AS reviewed_at, to_char(valid_until,'YYYY-MM-DD') AS valid_until, note, evidence_key, recorded_by, created_at FROM fin_legal_reviews_latest WHERE jurisdiction = $1 AND service_kind = $2";
  const r = client ? await client.query(q, [jurisdiction, kind]) : await require("../../db").query(q, [jurisdiction, kind]);
  return r.rows[0] || null;
}

function reviewProblem(review, today) {
  if (!review) return "legal_review_required";
  if (review.status === "prohibited") return "candidate_fee_prohibited";
  if (review.status !== "approved") return "legal_review_required";
  if (review.valid_until && review.valid_until < today) return "legal_review_required";
  return null;
}

const MESSAGES = {
  jurisdiction_unknown: "Candidate-fee billing is blocked: the candidate's jurisdiction is not recorded, so no legal review can be matched.",
  legal_review_required: "Candidate-fee billing is blocked: no current approved legal review is recorded for this candidate's jurisdiction.",
  candidate_fee_prohibited: "Candidate-fee billing is blocked: the latest recorded legal review for this candidate's jurisdiction is 'prohibited'.",
  service_contract_required: "Candidate-fee billing is blocked: there is no active, signed service contract for this candidate and service.",
  candidate_fee_use_catalogue: "This candidate has an active candidate-fee contract; create the invoice from the service catalogue (POST /finance/invoices/v2) so the billing gate can check it.",
};

function fail(code) {
  return new HttpError(409, MESSAGES[code], code);
}

/** Active, signed, not-yet-ended contracts of the candidate for candidate_fee services (rows locked FOR SHARE when `lock`). */
async function activeFeeContracts(client, candidateId, today, { lock = false, serviceId = null } = {}) {
  const r = await client.query(
    `SELECT k.id, k.service_id, k.status, k.agreement_signed_at, to_char(k.start_date,'YYYY-MM-DD') AS start_date, to_char(k.end_date,'YYYY-MM-DD') AS end_date
       FROM fin_service_contracts k JOIN fin_services s ON s.id = k.service_id
      WHERE k.candidate_id = $1 AND s.kind = '${KIND}' AND k.status = 'active' AND k.agreement_signed_at IS NOT NULL
        AND (k.end_date IS NULL OR k.end_date >= $2::date) AND ($3::bigint IS NULL OR k.service_id = $3)
      ORDER BY k.id${lock ? " FOR SHARE OF k" : ""}`,
    [candidateId, today, serviceId]
  );
  return r.rows;
}

/**
 * Throws a 409 (with a stable `code`) when the invoice items would bill a candidate_fee service without a passing gate.
 * Call it inside the invoice transaction, after the candidate row is locked. `items` are {serviceId|service_id|null}.
 * @returns {{checked: boolean}} checked=false when no candidate_fee service is involved
 */
async function assertBillable(client, { candidateId, serviceIds, items }, opts = {}) {
  const today = todayUtc(opts.now);
  const lines = Array.isArray(items) ? items : [];
  const ids = new Set((serviceIds || []).map(String));
  let freeText = false;
  for (const it of lines) {
    const sid = it.serviceId !== undefined ? it.serviceId : it.service_id;
    if (sid === null || sid === undefined) freeText = true;
    else ids.add(String(sid));
  }
  const feeServices = ids.size
    ? (await client.query(`SELECT id FROM fin_services WHERE id = ANY($1::bigint[]) AND kind = '${KIND}'`, [[...ids]])).rows.map((r) => String(r.id))
    : [];

  if (!feeServices.length) {
    // A free-text line cannot be told apart from a package fee. For a candidate that holds an active candidate-fee contract it is
    // refused: such billing must go through the catalogue, where the gate applies.
    if (freeText && (await activeFeeContracts(client, candidateId, today)).length) throw fail("candidate_fee_use_catalogue");
    return { checked: false };
  }

  const jurisdiction = await jurisdictionFor(client, candidateId);
  if (!jurisdiction) throw fail("jurisdiction_unknown");
  const problem = reviewProblem(await latestFor(jurisdiction, KIND, client), today);
  if (problem) throw fail(problem);

  for (const sid of feeServices) {
    const rows = await activeFeeContracts(client, candidateId, today, { lock: true, serviceId: sid });
    if (!rows.length) throw fail("service_contract_required");
  }
  return { checked: true };
}

/**
 * Legacy POST /finance/invoices has no items: it creates a plain invoice. It is refused when the candidate has an ACTIVE
 * candidate-fee contract (bill through the catalogue) or when their jurisdiction's latest review is 'prohibited'. Otherwise it behaves as before.
 */
async function assertLegacyInvoiceAllowed(client, { candidateId }, opts = {}) {
  const today = todayUtc(opts.now);
  if ((await activeFeeContracts(client, candidateId, today)).length) throw fail("candidate_fee_use_catalogue");
  const jurisdiction = await jurisdictionFor(client, candidateId);
  if (jurisdiction) {
    const review = await latestFor(jurisdiction, KIND, client);
    if (review && review.status === "prohibited") throw fail("candidate_fee_prohibited");
  }
}

/**
 * A NEW payment on an invoice that bills a candidate_fee service is refused once the candidate's jurisdiction review is 'prohibited'.
 * Refunds and voids never call this. Payments on other invoices are unaffected.
 */
async function assertPaymentAllowed(client, inv) {
  const fee = (
    await client.query(`SELECT 1 FROM invoice_items it JOIN fin_services s ON s.id = it.service_id WHERE it.invoice_id = $1 AND s.kind = '${KIND}' LIMIT 1`, [inv.id])
  ).rowCount;
  if (!fee) return;
  const jurisdiction = await jurisdictionFor(client, inv.candidate_id);
  if (!jurisdiction) return;
  const review = await latestFor(jurisdiction, KIND, client);
  if (review && review.status === "prohibited") throw fail("candidate_fee_prohibited");
}

/** Staff overview for one candidate: {candidate_fee_billable, reasons, jurisdiction, review, contract}. */
async function billingStatus(client, candidateId, opts = {}) {
  const today = todayUtc(opts.now);
  const reasons = [];
  const jurisdiction = await jurisdictionFor(client, candidateId);
  let review = null;
  if (!jurisdiction) reasons.push("jurisdiction_unknown");
  else {
    review = await latestFor(jurisdiction, KIND, client);
    const p = reviewProblem(review, today);
    if (p) reasons.push(p);
  }
  const active = await activeFeeContracts(client, candidateId, today);
  let contract = active[0] || null;
  if (!contract) {
    reasons.push("service_contract_required");
    contract =
      (
        await client.query(
          `SELECT k.id, k.service_id, k.status, k.agreement_signed_at, to_char(k.start_date,'YYYY-MM-DD') AS start_date, to_char(k.end_date,'YYYY-MM-DD') AS end_date
             FROM fin_service_contracts k JOIN fin_services s ON s.id = k.service_id WHERE k.candidate_id = $1 AND s.kind = '${KIND}' ORDER BY k.id DESC LIMIT 1`,
          [candidateId]
        )
      ).rows[0] || null;
  }
  return {
    candidate_fee_billable: reasons.length === 0,
    reasons,
    jurisdiction,
    review: review ? { status: review.status, valid_until: review.valid_until, reviewer_name: review.reviewer_name } : null,
    contract,
  };
}

module.exports = { assertBillable, assertLegacyInvoiceAllowed, assertPaymentAllowed, billingStatus, latestFor, jurisdictionFor, setClock, todayUtc, KIND, JURISDICTION_RE, MESSAGES };
