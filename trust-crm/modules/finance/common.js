// Shared helpers for the accounting services: permission guard, id/date/currency/text validation, transactions.
const { HttpError } = require("../jobsearch/httpError");
const { hasPerm, inTransaction: rawInTransaction } = require("../crm/leadsAdmin");

/** Largest value of a Postgres INT column; ids above it can never exist and must not reach SQL (22003 -> 500). */
const PG_INT_MAX = 2147483647;

/**
 * Parses a positive integer id (a number or a digit string). Malformed values are a 400 naming `label`.
 * An id above PG_INT_MAX is a 404 `notFound` when the caller passes the message (path ids), otherwise a 400 (body and
 * query fields, where the value is the caller's input, not a resource address).
 */
function parseId(raw, { label = "id", notFound = null } = {}) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `${label} must be a positive integer`);
  if (n > PG_INT_MAX) throw notFound ? new HttpError(404, notFound) : new HttpError(400, `${label} is too large`);
  return n;
}

// The legacy tables carry CHECK constraints that 016 added NOT VALID: Postgres re-checks them on every UPDATE of an
// existing row, so a record with data the rules reject (currency 'TN', status 'Unpaid', ...) fails the write with 23514.
// That is a data problem the owner has to fix, not a server fault: answer 409 and never echo the constraint text.
const LEGACY_TABLES = new Set(["invoices", "payments", "expenses", "fin_ledger"]);
function legacyDataError(err) {
  if (!err || err.code !== "23514" || !LEGACY_TABLES.has(String(err.table || ""))) return null;
  const name = String(err.constraint || "");
  const field = /currency/.test(name) ? "currency" : /method/.test(name) ? "method" : /status/.test(name) ? "status" : "currency/method";
  return new HttpError(409, `this record has legacy data that must be corrected: ${field}`);
}

/** The shared transaction wrapper, with legacy check violations (23514) turned into a clean 409. */
async function inTransaction(fn) {
  try {
    return await rawInTransaction(fn);
  } catch (err) {
    throw legacyDataError(err) || err;
  }
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Defence in depth: routes already run checkPermission, services re-check so a new caller cannot skip it. */
function requirePerm(user, perm) {
  if (!user || !hasPerm(user, perm)) throw new HttpError(403, `Permission denied: ${perm}`);
}

/** Currencies the owner enabled (FIN_CURRENCIES, default TND,EUR,CAD,USD), read at call time. */
function allowedCurrencies() {
  const list = String(process.env.FIN_CURRENCIES || "TND,EUR,CAD,USD")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z]{3}$/.test(s));
  return list.length ? [...new Set(list)] : ["TND", "EUR", "CAD", "USD"];
}

function parseCurrency(v, label = "currency") {
  if (typeof v !== "string" || !allowedCurrencies().includes(v)) {
    throw new HttpError(400, `${label} must be one of ${allowedCurrencies().join(", ")}`);
  }
  return v;
}

/** Optional single-line/multi-line text: trimmed, NUL-free, max length; empty -> null. */
function cleanText(v, label, max) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new HttpError(400, `${label} must be a string`);
  const t = v.trim();
  if (t.includes("\u0000")) throw new HttpError(400, `${label} contains invalid characters`);
  if (t.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  return t === "" ? null : t;
}

function requiredText(v, label, max) {
  const t = cleanText(v, label, max);
  if (t === null) throw new HttpError(400, `${label} is required`);
  return t;
}

/** YYYY-MM-DD that is a real calendar date. */
function parseDate(v, label) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${label} must be a date (YYYY-MM-DD)`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new HttpError(400, `${label} must be a valid date`);
  return v;
}

function oneValue(v, label) {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${label} must be a single value`);
  return v;
}

/** Optional inclusive ?from&to window (YYYY-MM-DD); empty values are "no bound"; from after to is a 400. */
function parseRange(query) {
  const get = (k) => {
    const v = oneValue(query[k], k);
    return v === undefined || v === "" ? null : parseDate(v, k);
  };
  const from = get("from");
  const to = get("to");
  if (from && to && from > to) throw new HttpError(400, "from must not be after to");
  return { from, to };
}

function pageParams(query) {
  const num = (raw, label, def, max) => {
    const v = oneValue(raw, label);
    if (v === undefined || v === "") return def;
    if (!/^\d{1,9}$/.test(v)) throw new HttpError(400, `${label} must be a non-negative integer`);
    return Math.min(Number(v), max);
  };
  const limit = num(query.limit, "limit", 25, 100);
  return { limit: limit < 1 ? 1 : limit, offset: num(query.offset, "offset", 0, 1e9) };
}

/**
 * Draws the next number "<prefix>-YYYY-NNNNNN" from fin_counters (key "<counter>-YYYY", year from the DB clock in UTC).
 * The upsert holds the counter row lock until the caller's transaction ends, so concurrent callers are serialised
 * and a rolled-back transaction gives its number back (gap-free). `nowArg` is a test hook for the DB clock.
 */
async function nextNumber(client, prefix, counter, nowArg = null) {
  const clock = (await client.query("SELECT COALESCE($1::timestamptz, now()) AS ts, to_char(COALESCE($1::timestamptz, now()) AT TIME ZONE 'UTC', 'YYYY') AS y", [nowArg])).rows[0];
  const row = (
    await client.query("INSERT INTO fin_counters (key, value) VALUES ($1, 1) ON CONFLICT (key) DO UPDATE SET value = fin_counters.value + 1 RETURNING value::text AS value", [`${counter}-${clock.y}`])
  ).rows[0];
  return { number: `${prefix}-${clock.y}-${row.value.padStart(6, "0")}`, ts: clock.ts, year: clock.y };
}

module.exports = { nextNumber, HttpError, hasPerm, parseId, inTransaction, legacyDataError, PG_INT_MAX, likeEscape, isObj, requirePerm, allowedCurrencies, parseCurrency, cleanText, requiredText, parseDate, parseRange, oneValue, pageParams };
