// Shared helpers of the chat services: id / paging / text validation, transactions, the one place where rows become API shapes.
const { HttpError } = require("../jobsearch/httpError");
const hr = require("../hr/common");
const { EXTERNAL_ROLES } = require("./scope");

const NOT_FOUND = "Not found";
const PREVIEW_CHARS = 140;
const MAX_BODY = 2000;
const MAX_REASON = 500;

/** Path ids: malformed -> 400; above the 32-bit range -> the same 404 as any other missing id. */
const pathId = (raw) => hr.parseId(raw, { label: "id", notFound: NOT_FOUND });
const notFound = () => new HttpError(404, NOT_FOUND);

function bodyObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "A JSON object body is required");
  return input;
}

/** limit (default `def`, 1..max, larger values are clamped) and offset; malformed or repeated values are a 400. */
function paging(query, { def, max = 50 } = {}) {
  const num = (raw, label, dflt, cap, min) => {
    const v = hr.oneValue(raw, label);
    if (v === undefined) return dflt;
    if (!/^\d{1,9}$/.test(v)) throw new HttpError(400, `${label} must be a non-negative integer`);
    const n = Number(v);
    if (n < min) throw new HttpError(400, `${label} must be at least ${min}`);
    return Math.min(n, cap);
  };
  return { limit: num(query.limit, "limit", def, max, 1), offset: num(query.offset, "offset", 0, 1e6, 0) };
}

/**
 * Message text: a string, trimmed, 1..2000 characters (code points, as Postgres counts them), no NUL, no lone surrogates, something
 * visible (not only format \p{Cf}, control \p{Cc} or space characters) and no bidi OVERRIDE / EMBEDDING / ISOLATE controls
 * (U+202A-202E, U+2066-2069), which can disguise text. ZWJ / ZWNJ / LRM / RLM stay allowed inside visible text (Arabic shaping, emoji).
 * Mirrored by composeState() in public/vita/chat-util.js.
 */
const INVISIBLE_ONLY = /^[\p{Cf}\p{Cc}\p{Z}\s]*$/u;
const BIDI_FORMATTING = /[\u202A-\u202E\u2066-\u2069]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function messageText(v) {
  if (typeof v !== "string") throw new HttpError(400, "body must be a string");
  const t = v.trim();
  if (t.includes("\u0000")) throw new HttpError(400, "body contains invalid characters");
  if (LONE_SURROGATE.test(t)) throw new HttpError(400, "body contains invalid characters");
  if (BIDI_FORMATTING.test(t)) throw new HttpError(400, "body contains bidirectional override or isolate characters, which are not allowed");
  const len = [...t].length;
  if (len < 1 || INVISIBLE_ONLY.test(t)) throw new HttpError(400, "body is required: it must contain visible text");
  if (len > MAX_BODY) throw new HttpError(400, `body must be at most ${MAX_BODY} characters`);
  return { text: t, length: len };
}

function reasonText(v, { required }) {
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, "reason is required");
    return null;
  }
  if (typeof v !== "string") throw new HttpError(400, "reason must be a string");
  const t = v.trim();
  if (t.includes("\u0000") || LONE_SURROGATE.test(t)) throw new HttpError(400, "reason contains invalid characters");
  if ([...t].length > MAX_REASON) throw new HttpError(400, `reason must be at most ${MAX_REASON} characters`);
  if (!t) {
    if (required) throw new HttpError(400, "reason is required");
    return null;
  }
  return t;
}

const inTransaction = hr.inTransaction;

const isStaffSender = (role) => !EXTERNAL_ROLES.has(role);

/** Number() for bigint columns (ids stay far below 2^53). */
const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * One message row -> API shape.
 *  - External viewer: a hidden message is exactly {id, created_at, hidden:true}; a visible one carries no ids of other accounts, and a
 *    staff sender shows as role "staff" (+ display name).
 *  - Staff viewer: everything, including the real role, the sender id and, when hidden, who / when / why.
 * (The SQL already NULLs the text of hidden messages for external viewers; this is the second line of defence.)
 */
function shapeMessage(row, actor) {
  const hidden = row.hidden_at !== null && row.hidden_at !== undefined;
  if (actor.kind !== "staff") {
    if (hidden) return { id: num(row.id), created_at: row.created_at, hidden: true };
    return {
      id: num(row.id),
      conversation_id: num(row.conversation_id),
      body: row.body,
      created_at: row.created_at,
      sender_name: row.sender_name || null,
      sender_role: isStaffSender(row.sender_role) ? "staff" : row.sender_role,
      mine: row.sender_user_id === actor.userId,
      hidden: false,
    };
  }
  const out = {
    id: num(row.id),
    conversation_id: num(row.conversation_id),
    body: row.body,
    created_at: row.created_at,
    sender_user_id: row.sender_user_id === null || row.sender_user_id === undefined ? null : row.sender_user_id,
    sender_name: row.sender_name || null,
    sender_role: row.sender_role,
    mine: row.sender_user_id === actor.userId,
    hidden,
  };
  if (hidden) {
    out.hidden_at = row.hidden_at;
    out.hidden_by = row.hidden_by === undefined ? null : row.hidden_by;
    out.hidden_reason = row.hidden_reason;
  }
  return out;
}

/** SQL column list of a message with the sender's display name; external viewers never get the text of a hidden message from the database. */
function messageColumns(actor, alias = "m") {
  const body = actor.kind === "staff" ? `${alias}.body` : `CASE WHEN ${alias}.hidden_at IS NULL THEN ${alias}.body END`;
  return `${alias}.id, ${alias}.conversation_id, ${alias}.sender_user_id, ${alias}.sender_role, ${body} AS body, ${alias}.created_at, ${alias}.hidden_at, ${alias}.hidden_by, ${alias}.hidden_reason, u.full_name AS sender_name`;
}

module.exports = { NOT_FOUND, PREVIEW_CHARS, MAX_BODY, MAX_REASON, pathId, notFound, bodyObject, paging, messageText, reasonText, inTransaction, isStaffSender, num, shapeMessage, messageColumns, parseId: hr.parseId, HttpError };
