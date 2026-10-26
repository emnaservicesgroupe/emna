// Who may see which chat conversation. Deny by default; every query is scoped IN SQL through conversationVisibleSql, never by
// loading a row and checking it afterwards.
//
//   Candidate           -> the candidate conversation about themselves (subject_type 'candidate', subject_id = their candidate)
//   Employer            -> the 'employer_request' conversation whose subject_id is THEIR organisation (all users of the org share it)
//   Agency              -> the 'agency' conversation whose subject_id is THEIR agency
//   Admin/SuperAdmin/Manager   -> every non-staff-room conversation; staff rooms only as an explicit participant
//   Receptionist/Agent  -> candidate conversations of candidates assigned to them (candidates.assigned_to, not deleted), plus
//                          organisation / staff-room conversations they were EXPLICITLY added to
//   HR/Accountant       -> nothing (refused at the router)
// "Explicit participant" = a chat_participants row with added_by set. Rows created lazily when somebody reads or writes (added_by NULL)
// only hold the read marker and never grant access, so reassigning a candidate or demoting a user takes effect at once.
// subject_id of an 'employer_request' / 'agency' conversation is the organisation id (crm_employers.id / crm_agencies.id).
const { HttpError } = require("../jobsearch/httpError");
const { hasPerm } = require("../crm/leadsAdmin");

const STAFF_CHAT_ROLES = new Set(["SuperAdmin", "Admin", "Manager", "Receptionist", "Agent"]);
const WIDE_ROLES = new Set(["SuperAdmin", "Admin", "Manager"]);
const EXTERNAL_ROLES = new Set(["Candidate", "Employer", "Agency"]);
const ALL_CHAT_ROLES = new Set([...STAFF_CHAT_ROLES, ...EXTERNAL_ROLES]);
const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ORG = { Employer: { type: "employer", table: "crm_employers", kind: "employer" }, Agency: { type: "agency", table: "crm_agencies", kind: "agency" } };
const SUBJECT_TABLE = { employer_request: "crm_employers", agency: "crm_agencies" };

const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;

/**
 * Builds the actor from the database (never from the token alone): the account must be active and still hold the role in the token;
 * Candidates need a live (not deleted) candidate record, Employer / Agency a non-suspended organisation. `runner` is a pool or a
 * transaction client; with { lock: true } the user row is share-locked so a concurrent deactivation waits for the transaction.
 * Throws 401 (unknown / inactive / role changed) or 403 (role without chat access, missing link, suspended organisation).
 */
async function resolveActor(runner, user, { lock = false } = {}) {
  const id = user && user.id;
  if (!isPosInt(id) || typeof user.role !== "string") throw new HttpError(401, "Session expired");
  const r = await runner.query(`SELECT id, full_name, role, is_active FROM users WHERE id = $1 ${lock ? "FOR SHARE" : ""}`, [id]);
  const row = r.rows[0];
  if (!row || !row.is_active || row.role !== user.role) throw new HttpError(401, "Session expired");
  const base = { userId: row.id, role: row.role, name: row.full_name };
  if (STAFF_CHAT_ROLES.has(row.role)) {
    const perms = { read: hasPerm(row, "chat:read"), write: hasPerm(row, "chat:write"), moderate: hasPerm(row, "chat:moderate") };
    if (!perms.read) throw new HttpError(403, "Access denied");
    return Object.freeze({ kind: "staff", ...base, perms: Object.freeze(perms) });
  }
  const external = Object.freeze({ read: true, write: true, moderate: false });
  if (row.role === "Candidate") {
    const c = await runner.query(
      `SELECT a.candidate_id FROM js_candidate_accounts a JOIN candidates c ON c.id = a.candidate_id WHERE a.user_id = $1 AND c.is_deleted = false`,
      [row.id]
    );
    if (c.rowCount === 0) throw new HttpError(403, "Access denied");
    return Object.freeze({ kind: "candidate", ...base, candidateId: Number(c.rows[0].candidate_id), perms: external });
  }
  const cfg = ORG[row.role];
  if (cfg) {
    const o = await runner.query(
      `SELECT o.id FROM crm_org_accounts oa JOIN ${cfg.table} o ON o.id = oa.org_id WHERE oa.user_id = $1 AND oa.org_type = $2 AND o.status <> 'suspended'`,
      [row.id, cfg.type]
    );
    if (o.rowCount === 0) throw new HttpError(403, "Access denied");
    return Object.freeze({ kind: cfg.kind, ...base, orgId: Number(o.rows[0].id), perms: external });
  }
  throw new HttpError(403, "Access denied");
}

const isExternal = (actor) => Boolean(actor) && actor.kind !== "staff";

/**
 * WHERE fragment (+ params) restricting `alias` (a chat_conversations row) to what `actor` may see. Placeholders start at
 * $(paramOffset + 1). An unknown / malformed actor gets FALSE.
 */
function conversationVisibleSql(actor, alias = "c", paramOffset = 0) {
  if (!ALIAS_RE.test(String(alias))) throw new Error(`Invalid SQL alias: ${alias}`);
  const a = alias;
  const offset = Number.isSafeInteger(paramOffset) && paramOffset >= 0 ? paramOffset : 0;
  const p = `$${offset + 1}`;
  const deny = { clause: "FALSE", params: [] };
  if (!actor || typeof actor !== "object") return deny;
  switch (actor.kind) {
    case "candidate":
      return isPosInt(actor.candidateId) ? { clause: `(${a}.subject_type = 'candidate' AND ${a}.subject_id = ${p})`, params: [actor.candidateId] } : deny;
    case "employer":
      return isPosInt(actor.orgId) ? { clause: `(${a}.subject_type = 'employer_request' AND ${a}.subject_id = ${p})`, params: [actor.orgId] } : deny;
    case "agency":
      return isPosInt(actor.orgId) ? { clause: `(${a}.subject_type = 'agency' AND ${a}.subject_id = ${p})`, params: [actor.orgId] } : deny;
    case "staff": {
      if (!isPosInt(actor.userId) || !actor.perms || actor.perms.read !== true) return deny;
      const explicit = `EXISTS (SELECT 1 FROM chat_participants xp WHERE xp.conversation_id = ${a}.id AND xp.user_id = ${p} AND xp.added_by IS NOT NULL)`;
      if (WIDE_ROLES.has(actor.role)) return { clause: `(${a}.subject_type <> 'staff' OR ${explicit})`, params: [actor.userId] };
      if (actor.role === "Agent" || actor.role === "Receptionist") {
        return {
          clause:
            `((${a}.subject_type = 'candidate' AND EXISTS (SELECT 1 FROM candidates sc WHERE sc.id = ${a}.subject_id AND sc.is_deleted = false AND sc.assigned_to = ${p}))` +
            ` OR (${a}.subject_type <> 'candidate' AND ${explicit}))`,
          params: [actor.userId],
        };
      }
      return deny;
    }
    default:
      return deny;
  }
}

/** Staff only: may this actor open / serve a conversation about the subject? (Admin / Manager: any existing subject; Agent / Receptionist: assigned, live candidates.) */
async function canServeSubject(runner, actor, type, subjectId) {
  if (!actor || actor.kind !== "staff" || !actor.perms.write || !isPosInt(subjectId)) return false;
  if (type === "candidate") {
    const wide = WIDE_ROLES.has(actor.role);
    if (!wide && actor.role !== "Agent" && actor.role !== "Receptionist") return false;
    const r = await runner.query(`SELECT 1 FROM candidates WHERE id = $1 AND is_deleted = false ${wide ? "" : "AND assigned_to = $2"}`, wide ? [subjectId] : [subjectId, actor.userId]);
    return r.rowCount > 0;
  }
  const table = SUBJECT_TABLE[type];
  if (!table || !WIDE_ROLES.has(actor.role)) return false;
  return (await runner.query(`SELECT 1 FROM ${table} WHERE id = $1`, [subjectId])).rowCount > 0;
}

module.exports = { resolveActor, conversationVisibleSql, canServeSubject, isExternal, STAFF_CHAT_ROLES, WIDE_ROLES, EXTERNAL_ROLES, ALL_CHAT_ROLES };
