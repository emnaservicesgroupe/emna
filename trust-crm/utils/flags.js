// Shared boolean settings (Task 20): one parsing rule for the app and the production preflight.
// MAIL_REAL_SEND enables real e-mail only when it is EXACTLY "true" (lower case, no spaces): "TRUE", "yes",
// "1" or " true" keep real sending OFF (fail-safe). The preflight warns when such a near-miss is set.

/** True only for the exact string "true". */
function exactTrue(v) {
  return v === "true";
}

/** Real sending switch (imapSmtp adapter, Health, preflight). */
function realSendEnabled(env = process.env) {
  return exactTrue(env.MAIL_REAL_SEND);
}

/** A value that looks like it was meant to be true but is not exactly "true". */
function nearTrue(v) {
  return typeof v === "string" && v !== "true" && /^\s*(true|yes|on|1|y)\s*$/i.test(v);
}

module.exports = { exactTrue, realSendEnabled, nearTrue };
