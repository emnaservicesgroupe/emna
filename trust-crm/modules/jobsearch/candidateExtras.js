// Candidate reference (CAN-YYYY-NNNN, assigned by the database) and the Canada profile fields kept on `candidates`
// (migration 025): city, whatsapp, work_authorization_status, relocation_ready, desired_province, service_start_date.
// `phone` / `email` already exist (migration 001) and are shown read-only here; the legacy candidate routes keep editing them.
//
// Authorization:
//   staff     jobsearch:read to read, jobsearch:write AND candidates:write to edit; candidateScopeSql applies (Admin all,
//             Manager / Receptionist / Agent only candidates assigned to them). HR / Accountant hold no jobsearch permission -> 404.
//   candidate own record only (js_candidate_accounts). Candidates may edit ONLY city, whatsapp, relocation_ready and
//             desired_province; work_authorization_status and service_start_date are staff-recorded facts (403 for a candidate).
// A foreign or unknown candidate answers 404 (never reveals existence). Every update is one transaction with an audit row.
const { HttpError } = require("./httpError");
const { assertCandidateAccess } = require("./scope");
const { PERMISSIONS } = require("../../middleware/role");
const { logAudit } = require("../../utils/audit");

const db = () => require("../../db");

/** Canadian provinces and territories (ISO 3166-2:CA codes). */
const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
const WORK_AUTHORIZATION_STATUSES = ["none", "study_permit", "work_permit_open", "work_permit_employer_specific", "pr", "citizen", "unknown"];
const FIELDS = ["city", "whatsapp", "work_authorization_status", "relocation_ready", "desired_province", "service_start_date"];
const CANDIDATE_EDITABLE = ["city", "whatsapp", "relocation_ready", "desired_province"];
const CITY_MAX = 120;
const WHATSAPP_RE = /^\+?[0-9 ()-]{6,24}$/;

function hasPerm(user, permission) {
  const perms = (user && PERMISSIONS[user.role]) || [];
  return perms.includes("*") || perms.includes(permission);
}

function validCalendarDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1900 && y <= 2200 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Validates and normalises a patch. Returns only the supplied fields. Throws HttpError(400). */
function validatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "Body must be an object");
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new HttpError(400, "No fields to update");
  const out = {};
  for (const k of keys) {
    if (!FIELDS.includes(k)) throw new HttpError(400, `Unknown field: ${k}`);
    const v = patch[k];
    switch (k) {
      case "city": {
        if (v === null) { out.city = null; break; }
        if (typeof v !== "string") throw new HttpError(400, "city must be a string or null");
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f\u007f]/.test(v)) throw new HttpError(400, "city contains control characters");
        const s = v.replace(/\s+/g, " ").trim();
        if (s.length > CITY_MAX) throw new HttpError(400, `city must be at most ${CITY_MAX} characters`);
        out.city = s || null;
        break;
      }
      case "whatsapp": {
        if (v === null) { out.whatsapp = null; break; }
        if (typeof v !== "string") throw new HttpError(400, "whatsapp must be a string or null");
        const s = v.trim();
        if (s === "") { out.whatsapp = null; break; }
        if (!WHATSAPP_RE.test(s)) throw new HttpError(400, "whatsapp must be a phone number such as +1 416 555 0100");
        const digits = s.replace(/\D/g, "");
        if (digits.length < 6 || digits.length > 15) throw new HttpError(400, "whatsapp must have 6 to 15 digits");
        out.whatsapp = (s.startsWith("+") ? "+" : "") + digits;
        break;
      }
      case "work_authorization_status":
        if (v !== null && !WORK_AUTHORIZATION_STATUSES.includes(v)) throw new HttpError(400, `work_authorization_status must be one of ${WORK_AUTHORIZATION_STATUSES.join(", ")} or null`);
        out.work_authorization_status = v;
        break;
      case "relocation_ready":
        if (v !== null && typeof v !== "boolean") throw new HttpError(400, "relocation_ready must be true, false or null");
        out.relocation_ready = v;
        break;
      case "desired_province": {
        if (v === null) { out.desired_province = null; break; }
        const s = typeof v === "string" ? v.trim().toUpperCase() : "";
        if (!PROVINCES.includes(s)) throw new HttpError(400, `desired_province must be one of ${PROVINCES.join(", ")} or null`);
        out.desired_province = s;
        break;
      }
      case "service_start_date":
        if (v !== null && (typeof v !== "string" || !validCalendarDate(v))) throw new HttpError(400, "service_start_date must be a valid date (YYYY-MM-DD) or null");
        out.service_start_date = v;
        break;
      default:
        break;
    }
  }
  return out;
}

const SELECT_COLS = `c.id, c.reference, c.phone, c.city, c.whatsapp, c.work_authorization_status, c.relocation_ready, c.desired_province,
       to_char(c.service_start_date, 'YYYY-MM-DD') AS service_start_date`;

function present(r, user) {
  return {
    candidate_id: r.id,
    reference: r.reference,
    phone: r.phone,
    city: r.city,
    whatsapp: r.whatsapp,
    work_authorization_status: r.work_authorization_status,
    relocation_ready: r.relocation_ready,
    desired_province: r.desired_province,
    service_start_date: r.service_start_date,
    editable_fields: user.role === "Candidate" ? CANDIDATE_EDITABLE : FIELDS,
  };
}

function toId(candidateId) {
  return typeof candidateId === "string" && /^\d+$/.test(candidateId) ? Number(candidateId) : candidateId;
}

async function authorize(user, candidateId, level) {
  if (!user) throw new HttpError(404, "Not found");
  if (user.role !== "Candidate") {
    const ok = level === "write" ? hasPerm(user, "jobsearch:write") && hasPerm(user, "candidates:write") : hasPerm(user, "jobsearch:read");
    if (!ok) throw new HttpError(404, "Not found");
  }
  await assertCandidateAccess(user, candidateId);
  return toId(candidateId);
}

async function getExtras(user, candidateId) {
  const id = await authorize(user, candidateId, "read");
  const r = await db().query(`SELECT ${SELECT_COLS} FROM candidates c WHERE c.id = $1 AND c.is_deleted = false`, [id]);
  if (r.rowCount === 0) throw new HttpError(404, "Not found");
  return present(r.rows[0], user);
}

async function updateExtras(user, candidateId, patch) {
  const id = await authorize(user, candidateId, "write");
  const clean = validatePatch(patch);
  if (user.role === "Candidate") {
    const denied = Object.keys(clean).filter((k) => !CANDIDATE_EDITABLE.includes(k));
    if (denied.length) throw new HttpError(403, `Only staff can change: ${denied.join(", ")}`);
  }
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(`SELECT ${SELECT_COLS} FROM candidates c WHERE c.id = $1 AND c.is_deleted = false FOR UPDATE`, [id]);
    if (cur.rowCount === 0) throw new HttpError(404, "Not found");
    const before = cur.rows[0];
    if (before.reference === null) before.reference = (await client.query("SELECT assign_candidate_reference($1) AS ref", [id])).rows[0].ref;
    const cols = Object.keys(clean);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`);
    const upd = await client.query(
      `UPDATE candidates c SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE c.id = $1 RETURNING ${SELECT_COLS}`,
      [id, ...cols.map((c) => clean[c])]
    );
    const after = upd.rows[0];
    const oldData = {};
    const newData = {};
    for (const c of cols) {
      oldData[c] = before[c];
      newData[c] = after[c];
    }
    await logAudit({
      client,
      userId: user.id,
      action: user.role === "Candidate" ? "candidate.extras.update_self" : "candidate.extras.update",
      tableName: "candidates",
      recordId: String(id),
      oldData,
      newData,
    });
    await client.query("COMMIT");
    return present(after, user);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The candidate id behind a Candidate user's login (404 when there is none). */
async function ownCandidateId(user) {
  if (!user || user.role !== "Candidate") throw new HttpError(403, "A candidate account is required");
  const r = await db().query("SELECT candidate_id FROM js_candidate_accounts WHERE user_id = $1", [user.id]);
  if (r.rowCount === 0) throw new HttpError(404, "Not found");
  return r.rows[0].candidate_id;
}

module.exports = { getExtras, updateExtras, ownCandidateId, validatePatch, PROVINCES, WORK_AUTHORIZATION_STATUSES, FIELDS, CANDIDATE_EDITABLE };
