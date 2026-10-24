// Approval scope shared by the HR decision flows (attendance corrections, leave requests).
//  - hr:read holders (HR, Admin, SuperAdmin) approve and see everyone; a hr:approve-only Manager only their direct reports
//    (hr_employees.manager_user_id = the approver).
//  - Nobody decides their own request (403: another hr:approve holder must).
//  - A request outside the approver's scope is a 404, indistinguishable from an unknown id.
const c = require("./common");

const { HttpError } = c;

/** True when the caller's scope is everyone (HR / Admin / SuperAdmin). */
const seesAll = (user) => c.hasPerm(user, "hr:read");

/** SQL condition limiting `col` (a user id column) to the caller's scope; pushes its parameter. Empty string = no limit. */
function scopeSql(user, params, col) {
  if (seesAll(user)) return "";
  params.push(user.id);
  return `${col} IN (SELECT r.user_id FROM hr_employees r WHERE r.manager_user_id = $${params.length})`;
}

/** Throws 404 unless `ownerId` is in the approver's scope. Run inside the deciding transaction. */
async function assertInScope(client, user, ownerId, notFound) {
  if (seesAll(user)) return;
  const r = await client.query("SELECT 1 FROM hr_employees WHERE user_id = $1 AND manager_user_id = $2", [ownerId, user.id]);
  if (!r.rowCount) throw new HttpError(404, notFound);
}

/** Self-approval refusal, then scope. Order matters: the requester learns "own request" (403), others learn nothing (404). */
async function assertCanDecide(client, user, ownerId, { notFound, own }) {
  if (ownerId === user.id) throw new HttpError(403, own);
  await assertInScope(client, user, ownerId, notFound);
}

module.exports = { seesAll, scopeSql, assertInScope, assertCanDecide };
