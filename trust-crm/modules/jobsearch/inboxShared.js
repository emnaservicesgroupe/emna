// Shared helpers for the inbox / drafts / interviews modules (Task 13). Internal only.
const { HttpError } = require("./httpError");
const { PERMISSIONS } = require("../../middleware/role");
const { logAudit } = require("../../utils/audit");

const db = () => require("../../db");

const posInt = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);
const isUser = (a) => Boolean(a && typeof a === "object" && Number.isSafeInteger(a.id));

function hasPerm(user, perm) {
  const perms = (user && PERMISSIONS[user.role]) || [];
  return perms.includes("*") || perms.includes(perm);
}

function actorLabel(actor) {
  if (isUser(actor)) return actor.role === "Candidate" ? `candidate:${actor.id}` : `staff:${actor.id}`;
  return typeof actor === "string" && actor ? actor : "system:inbox";
}

/** Single-line, control-free text (headers, subjects, notes). */
const oneLine = (v, max = 200) => String(v === undefined || v === null ? "" : v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function httpErr(status, message, code) {
  const e = new HttpError(status, message);
  if (code) e.code = code;
  return e;
}

async function inTx(fn) {
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

async function timeline(client, applicationId, actor, ev, detail) {
  await client.query("INSERT INTO js_timeline (application_id, actor, event, detail) VALUES ($1,$2,$3,$4::jsonb)", [applicationId, actorLabel(actor), ev, JSON.stringify(detail || {})]);
}

async function auditEvent(client, actor, action, candidateId, applicationId, detail) {
  await client.query("INSERT INTO js_audit_events (actor, action, candidate_id, application_id, detail) VALUES ($1,$2,$3,$4,$5::jsonb)", [
    isUser(actor) ? `user:${actor.id}` : actorLabel(actor),
    action,
    candidateId || null,
    applicationId || null,
    JSON.stringify(detail || {}),
  ]);
}

/** Candidate-facing event (neutral payload only). */
async function candidateEvent(client, candidateId, kind, payload) {
  await client.query("INSERT INTO js_events (candidate_id, kind, payload, audience) VALUES ($1,$2,$3::jsonb,'candidate')", [candidateId, kind, JSON.stringify(payload || {})]);
}

/** Staff-facing event (never shown to the candidate). */
async function staffEvent(client, candidateId, userId, kind, payload) {
  await client.query("INSERT INTO js_events (candidate_id, kind, payload, audience, user_id) VALUES ($1,$2,$3::jsonb,'staff',$4)", [candidateId || null, kind, JSON.stringify(payload || {}), userId || null]);
}

/** audit_logs row; never throws into the caller's result path. */
async function auditLog(actor, action, tableName, recordId, newData) {
  try {
    await logAudit({ userId: isUser(actor) ? actor.id : null, action, tableName, recordId: recordId === null || recordId === undefined ? null : String(recordId), newData });
  } catch (err) {
    console.error("jobsearch inbox: audit_logs write failed:", err && err.code, err && err.message);
  }
}

/** Candidate first, then application (binding lock order). */
async function lockApplication(client, applicationId) {
  const pre = (await client.query("SELECT candidate_id FROM js_applications WHERE id = $1", [applicationId])).rows[0];
  if (!pre) throw httpErr(404, "Not found");
  const cand = (await client.query("SELECT id, assigned_to, is_deleted FROM candidates WHERE id = $1 FOR UPDATE", [pre.candidate_id])).rows[0];
  const app = (await client.query("SELECT * FROM js_applications WHERE id = $1 FOR UPDATE", [applicationId])).rows[0];
  if (!app || app.candidate_id !== pre.candidate_id) throw httpErr(409, "Application changed concurrently");
  return { app, cand };
}

const responsibleOf = (app, cand) => app.responsible_user_id || (cand && cand.assigned_to) || null;

module.exports = { db, posInt, isUser, hasPerm, actorLabel, oneLine, httpErr, inTx, timeline, auditEvent, candidateEvent, staffEvent, auditLog, lockApplication, responsibleOf };
