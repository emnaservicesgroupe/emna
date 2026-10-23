// Per-candidate settings and modes. Only Admin/SuperAdmin may enable 'automatic', caps,
// allow-lists, approved document versions and the salary limit.
const { HttpError } = require("./httpError");
const { authorize, validatePreferences } = require("./profileService");
const { isAdmin } = require("./scope");
const { PERMISSIONS } = require("../../middleware/role");
const { logAudit } = require("../../utils/audit");

const db = () => require("../../db");

const MODES = ["search_only", "prepare_for_approval", "automatic"];
const ADMIN_KEYS = ["cap_per_day", "cap_per_week", "allowed_countries", "allowed_professions", "allowed_sources", "approved_doc_versions", "salary_limit"];
const STRING_LISTS = ["allowed_countries", "allowed_professions", "allowed_sources"];
const ALL_KEYS = ["mode", "paused", ...ADMIN_KEYS];
const COLUMNS = "mode, paused, cap_per_day, cap_per_week, allowed_countries, allowed_professions, allowed_sources, approved_doc_versions, salary_limit, admin_approved_by, updated_at";

function hasPerm(user, perm) {
  const perms = PERMISSIONS[user.role] || [];
  return perms.includes("*") || perms.includes(perm);
}

function validate(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "patch must be an object");
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!ALL_KEYS.includes(k)) throw new HttpError(400, `Unknown setting: ${k}`);
    if (k === "mode") {
      if (!MODES.includes(v)) throw new HttpError(400, "mode must be search_only, prepare_for_approval or automatic");
    } else if (k === "paused") {
      if (typeof v !== "boolean") throw new HttpError(400, "paused must be true or false");
    } else if (k === "cap_per_day" || k === "cap_per_week") {
      if (!Number.isInteger(v) || v < 0 || v > 1000) throw new HttpError(400, `${k} must be an integer between 0 and 1000`);
    } else if (STRING_LISTS.includes(k)) {
      if (!Array.isArray(v) || v.length > 200 || v.some((x) => typeof x !== "string" || !x.trim() || x.length > 100)) throw new HttpError(400, `${k} must be an array of non-empty strings`);
    } else if (k === "approved_doc_versions") {
      if (!Array.isArray(v) || v.length > 200) throw new HttpError(400, "approved_doc_versions must be an array");
    } else if (k === "salary_limit") {
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) throw new HttpError(400, "salary_limit must be a non-negative number or null");
    }
    out[k] = STRING_LISTS.includes(k) ? [...new Set(v.map((x) => x.trim()))] : v;
  }
  if (Object.keys(out).length === 0) throw new HttpError(400, "No settings to update");
  return out;
}

const DEFAULTS = { mode: "search_only", paused: false, cap_per_day: 0, cap_per_week: 0, allowed_countries: [], allowed_professions: [], allowed_sources: [], approved_doc_versions: [], salary_limit: null, admin_approved_by: null, updated_at: null };

async function getSettings({ user, candidateId }) {
  const id = await authorize(user, candidateId, "read");
  const r = await db().query(`SELECT ${COLUMNS} FROM js_candidate_settings WHERE candidate_id = $1`, [id]);
  const p = await db().query("SELECT countries, categories, availability, salary_min, salary_currency, residence_country, needs_work_auth_support FROM js_preferences WHERE candidate_id = $1", [id]);
  const row = { ...(r.rows[0] || DEFAULTS) };
  if (user.role === "Candidate") delete row.admin_approved_by; // which administrator approved: staff-only
  return { candidate_id: id, ...row, preferences: p.rows[0] || null };
}

async function writeAudit(client, user, action, id, detail) {
  await client.query("INSERT INTO js_audit_events (actor, action, candidate_id, detail) VALUES ($1,$2,$3,$4::jsonb)", [`user:${user.id}`, action, id, JSON.stringify(detail)]);
}

async function tx(fn) {
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

async function updateSettings({ user, candidateId, patch }) {
  const id = await authorize(user, candidateId, "write"); // 404 when out of scope
  const clean = validate(patch);
  const keys = Object.keys(clean);
  const admin = isAdmin(user);
  if (user.role === "Candidate") {
    if (keys.some((k) => k !== "paused")) throw new HttpError(403, "Candidates may only pause or resume their own search");
  } else if (!admin) {
    if (keys.some((k) => ADMIN_KEYS.includes(k)) || clean.mode === "automatic") throw new HttpError(403, "Only an administrator can change this setting");
    if (clean.mode !== undefined && !hasPerm(user, "jobsearch:approve")) throw new HttpError(403, "Only a manager or administrator can change the mode");
  }
  await tx(async (client) => {
    await client.query("SELECT id FROM candidates WHERE id = $1 FOR UPDATE", [id]);
    // First creation uses the column default: mode 'search_only'.
    await client.query("INSERT INTO js_candidate_settings (candidate_id) VALUES ($1) ON CONFLICT (candidate_id) DO NOTHING", [id]);
    const before = (await client.query(`SELECT ${COLUMNS} FROM js_candidate_settings WHERE candidate_id = $1 FOR UPDATE`, [id])).rows[0];
    const sets = [];
    const params = [id];
    for (const k of keys) {
      params.push(k === "approved_doc_versions" ? JSON.stringify(clean[k]) : clean[k]);
      sets.push(`${k} = $${params.length}${k === "approved_doc_versions" ? "::jsonb" : ""}`);
    }
    if (clean.mode === "automatic") {
      params.push(user.id);
      sets.push(`admin_approved_by = $${params.length}`);
    }
    await client.query(`UPDATE js_candidate_settings SET ${sets.join(", ")}, updated_at = now() WHERE candidate_id = $1`, params);
    const old = {};
    for (const k of keys) old[k] = before[k];
    await writeAudit(client, user, "settings.update", id, { changed: clean, previous: old });
    await client.query("INSERT INTO js_events (candidate_id, kind, payload) VALUES ($1,'settings.updated',$2::jsonb)", [id, JSON.stringify({ keys })]);
  });
  await logAudit({ userId: user.id, action: "jobsearch.settings.update", tableName: "js_candidate_settings", recordId: id, newData: clean });
  return getSettings({ user, candidateId: id });
}

/** Pause/unpause one candidate. When `user` is given the caller is authorized here. */
async function pauseCandidate(candidateId, paused, user) {
  if (typeof paused !== "boolean") throw new HttpError(400, "paused must be true or false");
  let id = candidateId;
  if (user) id = await authorize(user, candidateId, "write");
  await tx(async (client) => {
    await client.query(
      `INSERT INTO js_candidate_settings (candidate_id, paused) VALUES ($1,$2)
       ON CONFLICT (candidate_id) DO UPDATE SET paused = EXCLUDED.paused, updated_at = now()`,
      [id, paused]
    );
    const actor = user ? `user:${user.id}` : "system";
    await client.query("INSERT INTO js_audit_events (actor, action, candidate_id, detail) VALUES ($1,$2,$3,$4::jsonb)", [actor, paused ? "candidate.pause" : "candidate.unpause", id, JSON.stringify({ paused })]);
    await client.query("INSERT INTO js_events (candidate_id, kind, payload) VALUES ($1,$2,$3::jsonb)", [id, paused ? "candidate.paused" : "candidate.unpaused", JSON.stringify({ paused })]);
  });
  if (user) await logAudit({ userId: user.id, action: paused ? "jobsearch.candidate.pause" : "jobsearch.candidate.unpause", tableName: "js_candidate_settings", recordId: id, newData: { paused } });
  return { candidate_id: id, paused };
}

/** Module-wide kill switch (admin only). */
async function pauseModule(paused, user) {
  if (!user || !hasPerm(user, "jobsearch:admin")) throw new HttpError(403, "Administrator access required"); // before validation: never hint at the body shape to non-admins
  if (typeof paused !== "boolean") throw new HttpError(400, "paused must be true or false");
  await tx(async (client) => {
    await client.query(
      `INSERT INTO js_module_state (key, value) VALUES ('module_paused', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ paused, by: user.id, at: new Date().toISOString() })]
    );
    await client.query("INSERT INTO js_audit_events (actor, action, detail) VALUES ($1,$2,$3::jsonb)", [`user:${user.id}`, paused ? "module.pause" : "module.unpause", JSON.stringify({ paused })]);
    await client.query("INSERT INTO js_events (candidate_id, kind, payload) VALUES (NULL,$1,$2::jsonb)", [paused ? "module.paused" : "module.unpaused", JSON.stringify({ paused })]);
  });
  await logAudit({ userId: user.id, action: paused ? "jobsearch.module.pause" : "jobsearch.module.unpause", tableName: "js_module_state", newData: { paused } });
  return { paused };
}

/** Candidate (own) or staff/admin in scope edits preferences; same validation as profile confirmation. */
async function updatePreferences({ user, candidateId, preferences }) {
  const id = await authorize(user, candidateId, "write");
  const prefs = validatePreferences(preferences);
  await tx(async (client) => {
    await client.query(
      `INSERT INTO js_preferences (candidate_id, countries, categories, availability, salary_min, salary_currency, residence_country, needs_work_auth_support)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (candidate_id) DO UPDATE
         SET countries = EXCLUDED.countries, categories = EXCLUDED.categories, availability = EXCLUDED.availability,
             salary_min = EXCLUDED.salary_min, salary_currency = EXCLUDED.salary_currency,
             residence_country = EXCLUDED.residence_country, needs_work_auth_support = EXCLUDED.needs_work_auth_support,
             updated_at = now()`,
      [id, prefs.countries, prefs.categories, prefs.availability, prefs.salary_min, prefs.salary_currency, prefs.residence_country, prefs.needs_work_auth_support]
    );
    await writeAudit(client, user, "preferences.update", id, { fields: Object.keys(prefs) });
    await client.query("INSERT INTO js_events (candidate_id, kind, payload) VALUES ($1,'preferences.updated',$2::jsonb)", [id, "{}"]);
  });
  await logAudit({ userId: user.id, action: "jobsearch.preferences.update", tableName: "js_preferences", recordId: id });
  return getSettings({ user, candidateId: id });
}

module.exports = { getSettings, updateSettings, pauseCandidate, pauseModule, updatePreferences };
