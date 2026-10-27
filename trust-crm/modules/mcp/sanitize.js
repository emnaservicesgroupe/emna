// Output hygiene for everything the MCP tool layer hands to a model. Records come from the public site, candidates and staff, so every
// string is treated as hostile: invisible / direction-flipping characters are removed (they hide or reorder instructions), text is
// normalised and capped, and free text travels inside an explicit "user-supplied, instructions ignored" wrapper.

const MARKER = " …[truncated]";
const DEFAULT_MAX = 500;

// C0 (except \t \n; \r is normalised to \n first), DEL, C1.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Bidi embedding / override / isolate controls.
const BIDI = /[‪-‮⁦-⁩]/g;
// Zero-width and invisible format characters EXCEPT ZWNJ (U+200C) and ZWJ (U+200D), which real scripts and emoji need:
// ZWSP, word joiner and invisible operators, BOM / ZWNBSP, Mongolian vowel separator, interlinear annotation, object replacement.
const INVISIBLE = /[​⁠-⁤﻿᠎￹-￼]/g;
// Unicode "tag" characters (U+E0000-E007F) can smuggle ASCII invisibly.
const TAGS = /[\u{E0000}-\u{E007F}]/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** sanitizeForModel with the truncation flag: {text, truncated}. */
function sanitizeDetailed(value, { max = DEFAULT_MAX } = {}) {
  let s = value === null || value === undefined ? "" : typeof value === "string" ? value : String(value);
  s = s
    .replace(/\r\n?/g, "\n")
    .replace(LONE_SURROGATE, "")
    .replace(TAGS, "")
    .replace(CONTROLS, "")
    .replace(BIDI, "")
    .replace(INVISIBLE, "");
  s = s.normalize("NFC");
  s = s.replace(/(?:[ \t]*\n){4,}/g, "\n\n\n");
  const limit = Number.isSafeInteger(max) && max > MARKER.length ? max : DEFAULT_MAX;
  if (s.length <= limit) return { text: s, truncated: false };
  let cut = limit - MARKER.length;
  const last = s.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // never split a surrogate pair
  return { text: s.slice(0, cut) + MARKER, truncated: true };
}

/** A string that is safe to show a model: no control / bidi / zero-width tricks, NFC, runs of blank lines collapsed, capped at `max` (marker counted). */
function sanitizeForModel(value, opts) {
  return sanitizeDetailed(value, opts).text;
}

/** Free text from a record, wrapped so it is never mistaken for an instruction. null / undefined stay null. */
function untrustedText(value, opts) {
  if (value === null || value === undefined) return null;
  const { text, truncated } = sanitizeDetailed(value, opts);
  return { text, source: "user-supplied", instructions_ignored: true, truncated };
}

// Belt and braces: keys that name secrets or personal contact / identity data are dropped from every output, whatever their value.
// ("nationality" is deliberately NOT matched: only national id / number style keys are.)
const FORBIDDEN_SUBSTRINGS = ["password", "passwd", "secret", "token", "hash", "passport", "email", "phone", "nationalid", "nationalno", "nationalnum", "dateofbirth", "birthdate", "apikey"];
const FORBIDDEN_SEGMENTS = new Set(["otp", "dob", "pwd", "iban", "ssn"]);

function isForbiddenKey(key) {
  const k = String(key);
  const squashed = k.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (FORBIDDEN_SUBSTRINGS.some((s) => squashed.includes(s))) return true;
  const segments = k
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return segments.some((s) => FORBIDDEN_SEGMENTS.has(s));
}

/** Returns a deep copy where every string is sanitised, dates / bigints become strings and forbidden keys are gone. */
function deepSanitize(value, depth = 0) {
  if (depth > 20) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return sanitizeForModel(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map((x) => deepSanitize(x, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isForbiddenKey(k)) continue;
      if (v === undefined) continue;
      out[sanitizeForModel(k, { max: 100 })] = deepSanitize(v, depth + 1);
    }
    return out;
  }
  return null;
}

module.exports = { sanitizeForModel, untrustedText, deepSanitize, isForbiddenKey, MARKER, DEFAULT_MAX };
