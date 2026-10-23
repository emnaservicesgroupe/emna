// Our own sender addresses (MAIL_FROM / MAIL_REPLY_TO). Used for the From header, the Reply-To mailbox and
// the domain of every Message-ID we generate, so a reply can find its way back to us.
//
// A value is accepted only as a plain address ("jobs@agency.example"): no display name, no list, no CR/LF
// or other control characters anywhere (a header-injection attempt is refused, not trimmed away).
// Outside NODE_ENV=test there is NO fallback: fromAddress() throws MAIL_FROM_REQUIRED when MAIL_FROM is
// unset or invalid, so nothing is ever sent with a placeholder domain whose replies would be lost.
const TEST_FALLBACK = "vita@test.invalid";

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

/** Names of the problems with MAIL_FROM / MAIL_REPLY_TO (never the values). */
function problems() {
  const out = [];
  const from = process.env.MAIL_FROM;
  if (from === undefined || !String(from).trim()) out.push("MAIL_FROM");
  else if (!plainAddress(from)) out.push(`MAIL_FROM (${PLAIN_HINT})`);
  const replyTo = process.env.MAIL_REPLY_TO;
  if (replyTo !== undefined && String(replyTo).trim() && !plainAddress(replyTo)) out.push(`MAIL_REPLY_TO (${PLAIN_HINT})`);
  return out;
}

function requiredError() {
  const err = new Error(`MAIL_FROM must be set to a plain sender address of your domain before mail is sent (${problems().join(", ") || "MAIL_FROM"})`);
  err.code = "MAIL_FROM_REQUIRED";
  return err;
}

/** Our From address. Throws MAIL_FROM_REQUIRED outside NODE_ENV=test when MAIL_FROM is unset or invalid. */
function fromAddress() {
  const a = plainAddress(process.env.MAIL_FROM);
  if (a) return a;
  if (process.env.NODE_ENV === "test" && (process.env.MAIL_FROM === undefined || !String(process.env.MAIL_FROM).trim())) return TEST_FALLBACK;
  throw requiredError();
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

module.exports = { plainAddress, problems, fromAddress, replyToBase, messageIdDomain, TEST_FALLBACK };
