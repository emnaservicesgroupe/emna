// Data-isolation scope for every job-search query. Deny by default.
const { HttpError } = require("./httpError");

const STAFF_ROLES = new Set(["Agent", "Manager", "Receptionist"]);
const ADMIN_ROLES = new Set(["Admin", "SuperAdmin"]);
const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isStaff(user) {
  return Boolean(user && STAFF_ROLES.has(user.role));
}

function isAdmin(user) {
  return Boolean(user && ADMIN_ROLES.has(user.role));
}

function userId(user) {
  const id = user && user.id;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Returns a parameterized WHERE fragment restricting `alias` (a candidates row)
 * to what `user` may see. Placeholders start at $(paramOffset + 1).
 *   Candidate            -> own linked candidate (js_candidate_accounts)
 *   Agent/Manager/Recep. -> candidates.assigned_to = user.id
 *   Admin/SuperAdmin     -> TRUE
 *   anything else        -> FALSE
 * Note: does not filter candidates.is_deleted; callers add that where needed.
 */
function candidateScopeSql(user, alias = "c", paramOffset = 0) {
  if (!ALIAS_RE.test(String(alias))) throw new Error(`Invalid SQL alias: ${alias}`);
  const offset = Number.isSafeInteger(paramOffset) && paramOffset >= 0 ? paramOffset : 0;
  if (isAdmin(user)) return { clause: "TRUE", params: [] };
  const id = userId(user);
  if (id === null) return { clause: "FALSE", params: [] };
  const p = `$${offset + 1}`;
  if (user.role === "Candidate") {
    return {
      clause: `${alias}.id = (SELECT candidate_id FROM js_candidate_accounts WHERE user_id = ${p})`,
      params: [id],
    };
  }
  if (isStaff(user)) return { clause: `${alias}.assigned_to = ${p}`, params: [id] };
  return { clause: "FALSE", params: [] };
}

/** Throws HttpError(404) unless the (non-deleted) candidate is within the user's scope. */
async function assertCandidateAccess(user, candidateId) {
  const id = typeof candidateId === "string" && /^\d+$/.test(candidateId) ? Number(candidateId) : candidateId;
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, "Not found");
  const { clause, params } = candidateScopeSql(user, "c", 1);
  const db = require("../../db");
  const r = await db.query(`SELECT 1 FROM candidates c WHERE c.id = $1 AND c.is_deleted = false AND ${clause}`, [id, ...params]);
  if (r.rowCount === 0) throw new HttpError(404, "Not found");
}

module.exports = { candidateScopeSql, assertCandidateAccess, isStaff, isAdmin, STAFF_ROLES, ADMIN_ROLES };
