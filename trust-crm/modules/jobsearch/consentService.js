// Consent (versioned, scoped, withdrawable) and the search-eligibility gate.
// CV upload / profile confirmation never create consent: only grantConsent does, and only
// the candidate themself (or staff recording WRITTEN consent with evidence) may call it.
const { HttpError } = require("./httpError");
const { authorize } = require("./profileService");
const { isAdmin } = require("./scope");
const { logAudit } = require("../../utils/audit");

const db = () => require("../../db");

const SCOPE_KEYS = ["search", "prepare", "submit"];
const WITHDRAW_KEYS = [...SCOPE_KEYS, "all"];
const MAX_COUNTRIES = 100;

function actorOf(user) {
  return user.role === "Candidate" ? "candidate" : `staff:${user.id}`;
}

function validateScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new HttpError(400, "scope is required");
  const out = {};
  for (const k of SCOPE_KEYS) {
    if (typeof scope[k] !== "boolean") throw new HttpError(400, `scope.${k} must be true or false`);
    out[k] = scope[k];
  }
  const countries = scope.countries === undefined ? [] : scope.countries;
  if (!Array.isArray(countries) || countries.length > MAX_COUNTRIES || countries.some((c) => typeof c !== "string" || !c.trim() || c.length > 100)) {
    throw new HttpError(400, "scope.countries must be an array of non-empty strings");
  }
  out.countries = [...new Set(countries.map((c) => c.trim()))];
  return out;
}

async function auditRow(client, user, action, candidateId, detail) {
  await client.query("INSERT INTO js_audit_events (actor, action, candidate_id, detail) VALUES ($1,$2,$3,$4::jsonb)", [
    `user:${user.id}`,
    action,
    candidateId,
    JSON.stringify(detail),
  ]);
}

async function event(client, candidateId, kind, payload) {
  await client.query("INSERT INTO js_events (candidate_id, kind, payload) VALUES ($1,$2,$3::jsonb)", [candidateId, kind, JSON.stringify(payload)]);
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

function present(row) {
  return row && { id: row.id, candidate_id: row.candidate_id, scope: row.scope, version: row.version, granted_at: row.granted_at, withdrawn_at: row.withdrawn_at, granted_by: row.granted_by };
}

/** @returns {Promise<object>} the new active consent */
async function grantConsent({ user, candidateId, scope, version, recordedBy, evidenceNote }) {
  const id = await authorize(user, candidateId, "write");
  const clean = validateScope(scope);
  if (typeof version !== "string" || !version.trim() || version.length > 50) throw new HttpError(400, "version is required");
  if (user.role !== "Candidate") {
    if (typeof recordedBy !== "string" || !recordedBy.trim()) throw new HttpError(400, "recordedBy is required when recording consent on behalf of a candidate");
    if (typeof evidenceNote !== "string" || !evidenceNote.trim()) throw new HttpError(400, "evidenceNote (written consent evidence) is required");
    clean.evidence = { method: "written", recorded_by: recordedBy.trim().slice(0, 200), evidence_note: evidenceNote.trim().slice(0, 2000), recorded_by_user: user.id };
  }
  const row = await inTx(async (client) => {
    await client.query("SELECT id FROM candidates WHERE id = $1 FOR UPDATE", [id]);
    // History is kept: the previous active consent is closed, not deleted.
    const prev = await client.query(
      `UPDATE js_consents SET withdrawn_at = now(), scope = scope || '{"superseded": true}'::jsonb
       WHERE candidate_id = $1 AND withdrawn_at IS NULL RETURNING id`,
      [id]
    );
    const ins = await client.query(
      "INSERT INTO js_consents (candidate_id, scope, version, granted_by) VALUES ($1,$2::jsonb,$3,$4) RETURNING *",
      [id, JSON.stringify(clean), version.trim(), user.id]
    );
    const c = ins.rows[0];
    const detail = { consent_id: c.id, version: c.version, scope: clean, superseded: prev.rows.map((r) => r.id), actor: actorOf(user) };
    await auditRow(client, user, "consent.grant", id, detail);
    await event(client, id, "consent.granted", { consent_id: c.id, version: c.version, scope: { search: clean.search, prepare: clean.prepare, submit: clean.submit } });
    return c;
  });
  await logAudit({ userId: user.id, action: "jobsearch.consent.grant", tableName: "js_consents", recordId: row.id, newData: { candidate_id: id, version: row.version } });
  return present(row);
}

/** Active consent if scope[scopeKey] is true and the consent is not withdrawn, else null. */
async function activeConsent(candidateId, scopeKey, client) {
  if (!SCOPE_KEYS.includes(scopeKey)) return null;
  const r = await (client || db()).query("SELECT * FROM js_consents WHERE candidate_id = $1 AND withdrawn_at IS NULL ORDER BY id DESC LIMIT 1", [candidateId]);
  if (r.rowCount === 0) return null;
  return r.rows[0].scope && r.rows[0].scope[scopeKey] === true ? present(r.rows[0]) : null;
}

/**
 * Cancels the candidate's queued/approved applications (plus ready_for_review when
 * includeReady) and their pending submit queue items. Runs on `client` (caller's
 * transaction) or opens its own. Returns the number of cancelled applications.
 */
async function cancelQueuedForCandidate(candidateId, reason, client, { includeReady = false, actor = "system" } = {}) {
  if (!client) return inTx((c) => cancelQueuedForCandidate(candidateId, reason, c, { includeReady, actor }));
  const statuses = includeReady ? ["queued", "approved", "ready_for_review"] : ["queued", "approved"];
  const apps = await client.query("SELECT id, status FROM js_applications WHERE candidate_id = $1 AND status = ANY($2) ORDER BY id FOR UPDATE", [candidateId, statuses]);
  const ids = apps.rows.map((a) => a.id);
  if (ids.length > 0) {
    await client.query("UPDATE js_applications SET status = 'cancelled', updated_at = now() WHERE id = ANY($1)", [ids]);
    for (const a of apps.rows) {
      await client.query("INSERT INTO js_timeline (application_id, actor, event, detail) VALUES ($1,$2,'cancelled',$3::jsonb)", [
        a.id,
        actor,
        JSON.stringify({ reason, previous_status: a.status }),
      ]);
    }
  }
  // Queue items for this candidate (by application or candidate id in the payload); only
  // not-yet-claimed submit jobs can be stopped here.
  await client.query(
    `UPDATE js_queue SET status = 'cancelled', last_error = $3
     WHERE kind = 'submit' AND status = 'pending' AND locked_at IS NULL
       AND ( COALESCE(payload->>'applicationId', payload->>'application_id') = ANY($1::text[])
          OR COALESCE(payload->>'candidateId', payload->>'candidate_id') = $2 )`,
    [ids.map(String), String(candidateId), reason]
  );
  return ids.length;
}

/** Called when a candidate's login account is suspended/deactivated. */
async function cancelForDeactivatedUser(userId, client) {
  const r = await (client || db()).query("SELECT candidate_id FROM js_candidate_accounts WHERE user_id = $1", [userId]);
  let n = 0;
  for (const row of r.rows) n += await cancelQueuedForCandidate(row.candidate_id, "user_deactivated", client, { includeReady: true });
  return n;
}

/** @returns {Promise<{cancelledApplications:number}>} */
async function withdrawConsent({ user, candidateId, scopeKey }) {
  const id = await authorize(user, candidateId, "write");
  if (typeof scopeKey !== "string" || !WITHDRAW_KEYS.includes(scopeKey)) throw new HttpError(400, "scopeKey must be one of search, prepare, submit, all");
  const keys = scopeKey === "all" ? SCOPE_KEYS : [scopeKey];
  const result = await inTx(async (client) => {
    await client.query("SELECT id FROM candidates WHERE id = $1 FOR UPDATE", [id]);
    const cur = await client.query("SELECT * FROM js_consents WHERE candidate_id = $1 AND withdrawn_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE", [id]);
    const consent = cur.rows[0];
    const effective = consent ? keys.filter((k) => consent.scope[k] === true) : [];
    if (effective.length === 0) return { cancelledApplications: 0, changed: false }; // idempotent no-op

    const scope = { ...consent.scope };
    const withdrawn = { ...(scope.withdrawn || {}) };
    const now = new Date().toISOString();
    for (const k of effective) {
      scope[k] = false;
      withdrawn[k] = now;
    }
    scope.withdrawn = withdrawn;
    const anyLeft = SCOPE_KEYS.some((k) => scope[k] === true);
    await client.query("UPDATE js_consents SET scope = $2::jsonb, withdrawn_at = CASE WHEN $3 THEN NULL ELSE now() END WHERE id = $1", [consent.id, JSON.stringify(scope), anyLeft]);

    if (effective.includes("search")) {
      await client.query(
        `INSERT INTO js_candidate_settings (candidate_id, paused) VALUES ($1, true)
         ON CONFLICT (candidate_id) DO UPDATE SET paused = true, updated_at = now()`,
        [id]
      );
    }
    const includeReady = effective.includes("submit");
    const cancelled = await cancelQueuedForCandidate(id, `consent_withdrawn:${effective.join(",")}`, client, { includeReady, actor: actorOf(user) });
    await auditRow(client, user, "consent.withdraw", id, { consent_id: consent.id, withdrawn: effective, cancelled_applications: cancelled, actor: actorOf(user) });
    await event(client, id, "consent.withdrawn", { consent_id: consent.id, withdrawn: effective, cancelled_applications: cancelled });
    return { cancelledApplications: cancelled, changed: true, consentId: consent.id, withdrawn: effective };
  });
  if (result.changed) {
    await logAudit({ userId: user.id, action: "jobsearch.consent.withdraw", tableName: "js_consents", recordId: result.consentId, newData: { candidate_id: id, withdrawn: result.withdrawn, cancelled_applications: result.cancelledApplications } });
  }
  return { cancelledApplications: result.cancelledApplications };
}

async function listConsents({ user, candidateId }) {
  const id = await authorize(user, candidateId, "read");
  const r = await db().query("SELECT * FROM js_consents WHERE candidate_id = $1 ORDER BY id DESC", [id]);
  const rows = r.rows.map(present);
  const active = rows.find((c) => c.withdrawn_at === null && SCOPE_KEYS.some((k) => c.scope[k] === true)) || null;
  return { active, history: rows };
}

async function moduleState(key) {
  const r = await db().query("SELECT value FROM js_module_state WHERE key = $1", [key]);
  return r.rowCount ? r.rows[0].value : null;
}

/** Search starts only when profile confirmed AND search consent AND not paused AND account active. */
async function searchEligible(candidateId) {
  const reasons = [];
  const p = await db().query("SELECT status FROM js_profiles WHERE candidate_id = $1", [candidateId]);
  if (p.rowCount === 0 || p.rows[0].status !== "confirmed") reasons.push("profile_not_confirmed");
  if (!(await activeConsent(candidateId, "search"))) reasons.push("no_search_consent");
  const s = await db().query("SELECT paused FROM js_candidate_settings WHERE candidate_id = $1", [candidateId]);
  if (s.rowCount && s.rows[0].paused) reasons.push("candidate_paused");
  const m = await moduleState("module_paused");
  if (m && m.paused === true) reasons.push("module_paused");
  const u = await db().query(
    "SELECT u.is_active FROM js_candidate_accounts a JOIN users u ON u.id = a.user_id WHERE a.candidate_id = $1",
    [candidateId]
  );
  if (u.rows.some((r) => !r.is_active)) reasons.push("account_inactive");
  return { eligible: reasons.length === 0, reasons };
}

async function eligibilityFor({ user, candidateId }) {
  const id = await authorize(user, candidateId, "read");
  return searchEligible(id);
}

module.exports = { grantConsent, withdrawConsent, activeConsent, searchEligible, cancelQueuedForCandidate, cancelForDeactivatedUser, listConsents, eligibilityFor, moduleState, isAdmin };
