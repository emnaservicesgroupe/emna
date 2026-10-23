// Our own sender addresses (MAIL_FROM / MAIL_REPLY_TO). Used for the From header, the Reply-To mailbox and
// the domain of every Message-ID we generate, so a reply can find its way back to us.
//
// A value is accepted only as a plain address ("jobs@agency.example"): no display name, no list, no CR/LF
// or other control characters anywhere (a header-injection attempt is refused, not trimmed away).
// Provider-aware (Task 20):
//  - real provider (MAIL_PROVIDER=imap_smtp): MAIL_FROM is REQUIRED outside NODE_ENV=test - fromAddress() throws
//    MAIL_FROM_REQUIRED when it is unset or invalid, so nothing real is ever sent with a placeholder domain
//    whose replies would be lost;
//  - sandbox provider (the default; nothing leaves the server): an UNSET MAIL_FROM falls back to
//    vita@test.invalid in every environment and is not reported as a problem.
// A configured but invalid value (CR/LF, display name, list...) is refused with every provider.
const TEST_FALLBACK = "vita@test.invalid";
const SANDBOX_FALLBACK = TEST_FALLBACK;

/** Same provider choice as mail/index.js: only imap_smtp is a real provider; anything else is the sandbox. */
function realProvider() {
  const name = String(process.env.MAIL_PROVIDER || "sandbox").toLowerCase();
  return name === "imap_smtp" || name === "imapsmtp";
}

function unset(v) {
  return v === undefined || !String(v).trim();
}

/**
 * True when an unset MAIL_FROM may fall back to the placeholder (sandbox provider, or the test suite).
 * opts.real = true: the caller IS the real provider (imap_smtp adapter) whatever MAIL_PROVIDER says.
 */
function fallbackAllowed(opts) {
  return !isReal(opts) || process.env.NODE_ENV === "test";
}

function isReal(opts) {
  return Boolean(opts && opts.real) || realProvider();
}

function normalizeEmail(raw) {
  return require("../guard").normalizeEmail(raw);
}

/** The normalized plain address in `raw`, or null (unset, CR/LF/controls, display names, junk). */
function plainAddress(raw) {
  if (typeof raw !== "string") return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const s = raw.trim();
  if (!s || !/^[\x21-\x7e]+$/.test(s)) return null;
  return normalizeEmail(s);
}

const PLAIN_HINT = "must be a plain address like jobs@your-domain.example";

/** Names of the problems with MAIL_FROM / MAIL_REPLY_TO (never the values). opts.real: see fallbackAllowed. */
function problems(opts) {
  const out = [];
  const from = process.env.MAIL_FROM;
  if (unset(from)) {
    if (isReal(opts)) out.push("MAIL_FROM");
  } else if (!plainAddress(from)) {
    out.push(`MAIL_FROM (${PLAIN_HINT})`);
  }
  const replyTo = process.env.MAIL_REPLY_TO;
  if (replyTo !== undefined && String(replyTo).trim() && !plainAddress(replyTo)) out.push(`MAIL_REPLY_TO (${PLAIN_HINT})`);
  return out;
}

function requiredError(opts) {
  const err = new Error(`MAIL_FROM must be set to a plain sender address of your domain before mail is sent (${problems(opts).join(", ") || "MAIL_FROM"})`);
  err.code = "MAIL_FROM_REQUIRED";
  return err;
}

/**
 * Our From address. Unset MAIL_FROM: vita@test.invalid with the sandbox provider (or under NODE_ENV=test),
 * MAIL_FROM_REQUIRED with a real provider. Invalid MAIL_FROM: MAIL_FROM_REQUIRED (outside tests).
 */
function fromAddress(opts) {
  const a = plainAddress(process.env.MAIL_FROM);
  if (a) return a;
  if (unset(process.env.MAIL_FROM) && fallbackAllowed(opts)) return SANDBOX_FALLBACK;
  throw requiredError(opts);
}

/** The Reply-To mailbox (before plus-addressing): MAIL_REPLY_TO when valid, else MAIL_FROM. */
function replyToBase() {
  const r = process.env.MAIL_REPLY_TO;
  if (r !== undefined && String(r).trim()) {
    const a = plainAddress(r);
    if (a) return a;
    if (process.env.NODE_ENV !== "test") throw requiredError();
  }
  return fromAddress();
}

/** Domain for generated Message-IDs (the MAIL_FROM domain). */
function messageIdDomain() {
  return fromAddress().split("@")[1];
}

module.exports = { plainAddress, problems, fromAddress, replyToBase, messageIdDomain, realProvider, TEST_FALLBACK, SANDBOX_FALLBACK };
