// Shared helpers for the HR services: permission guard, id/date/time/text/days validation, tz check, transactions.
const { HttpError } = require("../jobsearch/httpError");
const { hasPerm, inTransaction: rawInTransaction } = require("../crm/leadsAdmin");
const fin = require("../finance/common");
const { parseMoney } = require("../finance/money");

const DEFAULT_TZ = "Africa/Tunis";
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MAX_DAYS = 366;

/** Company timezone (HR_TIMEZONE, default Africa/Tunis), read at call time. A malformed value falls back to the default. */
function companyTimezone() {
  const v = String(process.env.HR_TIMEZONE || "").trim();
  return /^[A-Za-z0-9_+\-/]{1,64}$/.test(v) ? v : DEFAULT_TZ;
}

/** Defence in depth: routes already run checkPermission, services re-check so a new caller cannot skip it. */
const requirePerm = fin.requirePerm;
const { parseId, cleanText, requiredText, parseDate, oneValue, pageParams, likeEscape, isObj, PG_INT_MAX } = fin;

/** Rejects keys outside `allowed` (a typo must not be silently ignored). */
function onlyKeys(input, allowed) {
  for (const k of Object.keys(input)) if (!allowed.includes(k)) throw new HttpError(400, `Unknown field: ${k}`);
}

/** Dates the tables accept comfortably (also keeps `year` arithmetic sane). */
function parseHrDate(v, label) {
  const d = parseDate(v, label);
  if (d < "2000-01-01" || d > "2200-12-31") throw new HttpError(400, `${label} must be between 2000-01-01 and 2200-12-31`);
  return d;
}

function parseHHMM(v, label) {
  if (typeof v !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v)) throw new HttpError(400, `${label} must be a time HH:MM (24h)`);
  return v;
}

function parseBool(v, label) {
  if (typeof v !== "boolean") throw new HttpError(400, `${label} must be true or false`);
  return v;
}

function parseYear(raw, label = "year") {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{4}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 2000 || n > 2200) throw new HttpError(400, `${label} must be a year between 2000 and 2200`);
  return n;
}

/**
 * Day counts as normalised "N.NN" strings (no float arithmetic): 0..366, at most 2 decimals. With allowNegative a leading
 * "-" is accepted (an adjustment can take days away), range -366..366; "-0" collapses to "0.00".
 */
function parseDays(value, { label = "days", allowNegative = false } = {}) {
  let x = value;
  let neg = false;
  if (typeof x === "number" && Number.isFinite(x) && x < 0) {
    neg = true;
    x = -x;
  } else if (typeof x === "string" && x.trim().startsWith("-")) {
    neg = true;
    x = x.trim().slice(1);
  }
  if (neg && !allowNegative) throw new HttpError(400, `${label} must not be negative`);
  const s = parseMoney(x, { label, maxIntDigits: 3 });
  if (Number(s) > MAX_DAYS) throw new HttpError(400, `${label} must be at most ${MAX_DAYS}`);
  return neg && s !== "0.00" ? `-${s}` : s;
}

/** A timezone name that Postgres knows (pg_timezone_names, exact case). */
async function validTimezone(runner, v, label = "timezone") {
  if (typeof v !== "string" || !v.trim() || v.trim().length > 64) throw new HttpError(400, `${label} must be a timezone name`);
  const name = v.trim();
  const r = await runner.query("SELECT 1 FROM pg_timezone_names WHERE name = $1 LIMIT 1", [name]);
  if (!r.rowCount) throw new HttpError(400, `${label} is not a known timezone`);
  return name;
}


/**
 * Transaction wrapper. Database rule violations that the services did not pre-empt become clean client errors instead of
 * 500s, and the constraint text is never echoed. `unique` is a message, or {constraint_name: message}, for 23505.
 */
async function inTransaction(fn, { unique = null } = {}) {
  try {
    return await rawInTransaction(fn);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const code = err && err.code;
    if (code === "23505") {
      const msg = typeof unique === "string" ? unique : (unique && unique[err.constraint]) || "A record with these values already exists";
      throw new HttpError(409, msg);
    }
    if (code === "23P01") throw new HttpError(409, "This overlaps an existing record");
    if (code === "23503") throw new HttpError(409, "A referenced record does not exist or is still in use");
    if (code === "23514" || code === "22003" || code === "22007" || code === "22008" || code === "22P02" || code === "22001") {
      throw new HttpError(400, "A value is outside the allowed range");
    }
    throw err;
  }
}

/** Active user holding a staff role (what an employee / manager must be). */
async function activeStaffUser(client, id, { lock = false } = {}) {
  const { STAFF_ROLES } = require("../../middleware/staff");
  const r = await client.query(`SELECT id, full_name, email, role, is_active FROM users WHERE id = $1 ${lock ? "FOR SHARE" : ""}`, [id]);
  const u = r.rows[0];
  if (!u || !u.is_active || !STAFF_ROLES.has(u.role)) return null;
  return u;
}

module.exports = {
  HttpError, hasPerm, requirePerm, parseId, cleanText, requiredText, parseDate, parseHrDate, parseHHMM, parseBool, parseYear, parseDays,
  validTimezone, inTransaction, activeStaffUser, onlyKeys, oneValue, pageParams, likeEscape, isObj, PG_INT_MAX, companyTimezone, DEFAULT_TZ, DAYS, MAX_DAYS,
};
