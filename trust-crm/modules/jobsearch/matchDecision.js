// Staff accept / reject of a MATCH (stage 8 task 5), before any application exists. Approvers only (jobsearch:approve), inside the
// caller's candidate scope. The decision feeds application preparation when the module setting require_match_acceptance is on.
// Re-deciding is allowed (only approvers can reach this code) and is always audited with the previous value. The note is staff-only.
const { HttpError } = require("./httpError");
const { candidateScopeSql } = require("./scope");
const { PERMISSIONS } = require("../../middleware/role");
const { logAudit } = require("../../utils/audit");
const consentService = require("./consentService");

const db = () => require("../../db");
const MAX_NOTE = 500;
const posInt = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);

function hasPerm(user, perm) {
  const perms = (user && PERMISSIONS[user.role]) || [];
  return perms.includes("*") || perms.includes(perm);
}

function cleanNote(note) {
  if (note === undefined || note === null) return null;
  if (typeof note !== "string") throw new HttpError(400, "note must be a string");
  const s = note.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > MAX_NOTE) throw new HttpError(400, `note must be at most ${MAX_NOTE} characters`);
  return s || null;
}

function present(row, changed) {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    jobId: row.job_id,
    decision: row.decision,
    decisionBy: row.decision_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    band: row.band,
    changed,
  };
}

/**
 * @param {{matchId, actor: {id, role}, decision: 'accepted'|'rejected', note?: string}} args
 * @returns {Promise<object>} the match decision, with `changed` false when the call repeated the current state
 */
async function decide({ matchId, actor, decision, note }) {
  if (decision !== "accepted" && decision !== "rejected") throw new HttpError(400, "decision must be accepted or rejected");
  const id = posInt(matchId);
  // Outside the caller's scope (or a role with no job-search access) is "not found", before any permission hint.
  if (!id || !actor || (!hasPerm(actor, "jobsearch:read") && actor.role !== "Candidate")) throw new HttpError(404, "Not found");
  const { clause, params } = candidateScopeSql(actor, "c", 1);
  const scoped = (await db().query(
    `SELECT m.candidate_id FROM js_matches m JOIN candidates c ON c.id = m.candidate_id WHERE m.id = $1 AND c.is_deleted = false AND ${clause}`,
    [id, ...params]
  )).rows[0];
  if (!scoped) throw new HttpError(404, "Not found");
  if (!hasPerm(actor, "jobsearch:approve")) throw new HttpError(403, "Deciding on a match requires a manager or administrator");
  const text = cleanNote(note);

  const client = await db().connect();
  let out;
  try {
    await client.query("BEGIN");
    // Lock order candidates -> match, as in the application paths.
    const cand = (await client.query("SELECT id FROM candidates WHERE id = $1 AND is_deleted = false FOR UPDATE", [scoped.candidate_id])).rows[0];
    if (!cand) throw new HttpError(404, "Not found");
    const cur = (await client.query("SELECT * FROM js_matches WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!cur) throw new HttpError(404, "Not found");
    const sameDecision = cur.decision === decision;
    const noteChanged = text !== null && text !== (cur.decision_note || null);
    if (sameDecision && !noteChanged) {
      out = present(cur, false); // idempotent repeat: nothing written, nothing audited
    } else {
      const row = (await client.query(
        `UPDATE js_matches SET decision = $2, decision_by = $3, decided_at = now(), decision_note = CASE WHEN $4::text IS NULL THEN decision_note ELSE $4 END
          WHERE id = $1 RETURNING *`,
        [id, decision, actor.id, text]
      )).rows[0];
      const action = cur.decision === "pending" ? (decision === "accepted" ? "match.accept" : "match.reject") : sameDecision ? "match.decision_note" : "match.decision_change";
      await client.query("INSERT INTO js_audit_events (actor, action, candidate_id, detail) VALUES ($1,$2,$3,$4::jsonb)", [
        `user:${actor.id}`,
        action,
        row.candidate_id,
        JSON.stringify({ matchId: id, jobId: row.job_id, previous: cur.decision, decision, noteProvided: text !== null, noteChanged }),
      ]);
      out = { ...present(row, true), action };
      // A rejection pulls back this job's approved / queued (never sent) application of the candidate: the guard would refuse it anyway,
      // but nothing should sit in the queue waiting to be refused. Same cancellation mechanism as consent withdrawal; sent ones are untouched.
      if (decision === "rejected") {
        const ids = (await client.query("SELECT id FROM js_applications WHERE candidate_id = $1 AND job_id = $2 AND status IN ('approved','queued')", [row.candidate_id, row.job_id])).rows.map((r) => r.id);
        if (ids.length) {
          const n = await consentService.cancelQueuedForCandidate(row.candidate_id, "match_rejected", client, { includeReady: false, actor: `staff:${actor.id}`, onlyApplicationIds: ids });
          await client.query("INSERT INTO js_audit_events (actor, action, candidate_id, detail) VALUES ($1,'match.cancel_applications',$2,$3::jsonb)", [`user:${actor.id}`, row.candidate_id, JSON.stringify({ matchId: id, jobId: row.job_id, cancelled: n })]);
          out.cancelledApplications = n;
        }
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (out.changed) await logAudit({ userId: actor.id, action: `jobsearch.${out.action}`, tableName: "js_matches", recordId: id, newData: { decision } });
  const { action, ...rest } = out;
  return rest;
}

module.exports = { decide, MAX_NOTE };
