// Agency-side candidate registration and tracking. Every function takes the agency id resolved by
// requirePortalRole (never from the request). Agencies only ever see their own rows, a fixed allowlist of
// columns and a status wording derived from the stage - never staff notes, duplicate flags or internal ids.
const crypto = require("crypto");
const { HttpError } = require("../jobsearch/httpError");
const { logAudit } = require("../../utils/audit");
const timeline = require("../crm/timeline");

const db = () => require("../../db");

const CONSENT_VERSION = "agency-v1";
const FIELDS = ["full_name", "email", "phone", "country", "profession", "message", "passport_number", "consent_attested"];
const CAPS = { full_name: 120, email: 254, phone: 32, country: 80, profession: 120, message: 4000, passport_number: 40 };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const PHONE_RE = /^\+?[0-9 ().-]+$/;

const STATUS_TEXT = {
  new: "Received",
  contacted: "In contact",
  qualified: "Qualified",
  rejected: "Not proceeding",
  converted: "Registered",
  lead: "Registered",
  documents: "Documents",
  submitted: "Submitted",
  interview: "Interview",
  visa: "Visa",
  travel: "Travel",
  closed: "Closed",
};

function dailyCap() {
  const n = Number(process.env.AGENCY_CANDIDATES_PER_DAY);
  return Number.isInteger(n) && n > 0 ? n : 50;
}

function parseId(raw) {
  if (typeof raw !== "string" || !/^c?[1-9]\d{0,14}$/.test(raw)) throw new HttpError(400, "invalid id");
  return raw.startsWith("c") ? { kind: "candidate", id: raw.slice(1) } : { kind: "lead", id: raw };
}

function pageParam(raw, name, { min, max, dflt }) {
  if (raw === undefined) return dflt;
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) throw new HttpError(400, `${name} is invalid`);
  const n = Number(raw);
  if (n < min || n > max) throw new HttpError(400, `${name} is invalid`);
  return n;
}

function str(input, field, { required = false } = {}) {
  const v = input[field];
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be text`);
  if (v.includes("\u0000")) throw new HttpError(400, `${field} contains invalid characters`);
  const t = v.trim();
  if (!t) {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (t.length > CAPS[field]) throw new HttpError(400, `${field} must be at most ${CAPS[field]} characters`);
  return t;
}

function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "JSON object body required");
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) throw new HttpError(400, `unknown field: ${k.slice(0, 40)}`);
  if (input.consent_attested !== true) throw new HttpError(400, "consent_attested is required");
  const fullName = str(input, "full_name", { required: true });
  let email = str(input, "email");
  if (email) {
    email = email.toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "email is not valid");
  }
  const phone = str(input, "phone");
  let phoneDigits = null;
  if (phone) {
    phoneDigits = phone.replace(/\D/g, "");
    if (!PHONE_RE.test(phone) || phoneDigits.length < 7 || phoneDigits.length > 15) throw new HttpError(400, "phone is not valid");
  }
  if (!email && !phone) throw new HttpError(400, "email or phone is required");
  const passportRaw = str(input, "passport_number");
  let passportNorm = null;
  if (passportRaw) {
    passportNorm = passportRaw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (passportNorm.length < 4) throw new HttpError(400, "passport_number is not valid");
  }
  return {
    fullName,
    email,
    phone,
    phoneDigits,
    passportNorm,
    country: str(input, "country"),
    profession: str(input, "profession"),
    message: str(input, "message"),
  };
}

async function inTransaction(fn) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getOrg(agencyId) {
  const r = await db().query("SELECT id, name, contact_name, email, phone, country FROM crm_agencies WHERE id = $1", [agencyId]);
  if (r.rowCount === 0) throw new HttpError(403, "Forbidden");
  return r.rows[0];
}

/** Any existing record (lead of any origin, or candidate) sharing a normalised email, phone or passport. */
async function findDuplicate(client, v) {
  const lead = await client.query(
    `SELECT id FROM crm_leads
      WHERE status <> 'spam'
        AND (($1::text IS NOT NULL AND lower(email) = $1)
          OR ($2::text IS NOT NULL AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = $2)
          OR ($3::text IS NOT NULL AND passport_norm = $3))
      ORDER BY id LIMIT 1`,
    [v.email, v.phoneDigits, v.passportNorm]
  );
  const cand = await client.query(
    `SELECT id FROM candidates
      WHERE ($1::text IS NOT NULL AND lower(btrim(email)) = $1)
         OR ($2::text IS NOT NULL AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = $2)
         OR ($3::text IS NOT NULL AND regexp_replace(upper(passport_number), '[^A-Z0-9]', '', 'g') = $3)
      ORDER BY id LIMIT 1`,
    [v.email, v.phoneDigits, v.passportNorm]
  );
  return { leadId: lead.rows[0] ? lead.rows[0].id : null, candidateId: cand.rows[0] ? cand.rows[0].id : null };
}

/**
 * Registers a candidate. A duplicate of any existing record is stored as an ordinary new lead of this agency,
 * flagged for staff (duplicate_of / duplicate_candidate_id + timeline) - the answer is byte-for-byte the same shape.
 */
async function create(user, agencyId, input) {
  const v = validate(input);
  return inTransaction(async (client) => {
    // Serialise per agency so concurrent submissions cannot slip past the cap.
    await client.query("SELECT 1 FROM crm_agencies WHERE id = $1 FOR UPDATE", [agencyId]);
    const used = await client.query("SELECT count(*)::int AS n FROM crm_leads WHERE agency_id = $1 AND created_at > now() - interval '24 hours'", [agencyId]);
    if (used.rows[0].n >= dailyCap()) {
      const e = new HttpError(429, "Daily registration limit reached");
      e.retryAfter = 3600;
      throw e;
    }
    const dup = await findDuplicate(client, v);
    const r = await client.query(
      `INSERT INTO crm_leads (kind, status, name, email, phone, country, profession, message, consent_at, consent_text_version,
                              source, agency_id, dedupe_key, passport_norm, duplicate_of, duplicate_candidate_id)
       VALUES ('candidate','new',$1,$2,$3,$4,$5,$6, now(), $7,'agency',$8,$9,$10,$11,$12) RETURNING id`,
      [v.fullName, v.email, v.phone, v.country, v.profession, v.message, CONSENT_VERSION, agencyId, `agency:${agencyId}:${crypto.randomUUID()}`, v.passportNorm, dup.leadId, dup.candidateId]
    );
    const id = r.rows[0].id;
    await timeline.add(client, { entity: "agency", entityId: agencyId, actorId: user.id, event: "candidate_registered", detail: { lead_id: Number(id) } });
    await timeline.add(client, { entity: "lead", entityId: id, actorId: user.id, event: "registered_by_agency", detail: { agency_id: Number(agencyId) } });
    if (dup.leadId !== null || dup.candidateId !== null) {
      await timeline.add(client, {
        entity: "lead",
        entityId: id,
        actorId: null,
        event: "duplicate_flagged",
        detail: { duplicate_of: dup.leadId === null ? null : Number(dup.leadId), duplicate_candidate_id: dup.candidateId },
      });
    }
    await logAudit({ client, userId: user.id, action: "agency.candidate.create", tableName: "crm_leads", recordId: String(id), newData: { agency_id: Number(agencyId), source: "agency", consent_text_version: CONSENT_VERSION } });
    return { ok: true, id: String(id) };
  });
}

// One allowlisted projection for leads (converted leads show their candidate's stage) and agency candidates that
// have no lead of this agency. Lead ids are plain; candidate-only ids are prefixed "c" so the id spaces never clash.
const ITEMS_SQL = `
  SELECT l.id::text AS id, l.name AS full_name, l.profession, l.country,
         CASE WHEN l.status = 'converted' AND c.id IS NOT NULL THEN c.crm_stage ELSE l.status END AS stage,
         l.created_at, 0 AS src, l.id AS sort_id
    FROM crm_leads l LEFT JOIN candidates c ON c.id = l.candidate_id AND c.is_deleted = false
   WHERE l.agency_id = $1 AND l.status <> 'spam'
  UNION ALL
  SELECT 'c' || c.id, c.full_name, NULL, c.nationality, c.crm_stage, c.created_at, 1, c.id
    FROM candidates c
   WHERE c.agency_id = $1 AND c.is_deleted = false
     AND NOT EXISTS (SELECT 1 FROM crm_leads l WHERE l.candidate_id = c.id AND l.agency_id = $1)`;

function shape(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    profession: row.profession,
    country: row.country,
    stage: row.stage,
    status_text: STATUS_TEXT[row.stage] || "In progress",
    created_at: row.created_at,
  };
}

async function list(agencyId, query) {
  const limit = pageParam(query.limit, "limit", { min: 1, max: 100, dflt: 20 });
  const offset = pageParam(query.offset, "offset", { min: 0, max: 100000, dflt: 0 });
  const rows = await db().query(`SELECT * FROM (${ITEMS_SQL}) i ORDER BY created_at DESC, src, sort_id DESC LIMIT $2 OFFSET $3`, [agencyId, limit, offset]);
  const total = await db().query(`SELECT count(*)::int AS n FROM (${ITEMS_SQL}) i`, [agencyId]);
  return { candidates: rows.rows.map(shape), total: total.rows[0].n, limit, offset };
}

async function get(agencyId, rawId) {
  const p = parseId(rawId);
  const wanted = p.kind === "candidate" ? `c${p.id}` : p.id;
  const r = await db().query(`SELECT * FROM (${ITEMS_SQL}) i WHERE i.id = $2`, [agencyId, wanted]);
  if (r.rowCount === 0) throw new HttpError(404, "Not found");
  return shape(r.rows[0]);
}

module.exports = { getOrg, create, list, get, dailyCap, STATUS_TEXT, CAPS };
