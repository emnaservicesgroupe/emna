// Real mailbox adapter. Importing never throws; without configuration it reports requires_setup.
//
// Outbound (SMTP) needs the SMTP settings MAIL_SMTP_HOST, MAIL_SMTP_USER, MAIL_SMTP_PASS (+ optional
// MAIL_SMTP_PORT, default 587; 465 = implicit TLS) AND MAIL_FROM, a plain sender address of your domain
// (Task 19: without it Reply-To / Message-ID would point at a placeholder domain and replies were lost).
// Nothing is sent unless MAIL_REAL_SEND=true.
// Inbound: IMAP polling is NOT implemented in this build (no IMAP client dependency); replies arrive through
// the signed webhook POST /jobsearch/inbound/mail (INBOUND_MAIL_SECRET). MAIL_IMAP_* are not used.
//
// status():
//   outbound 'connected'                 SMTP settings valid AND MAIL_REAL_SEND=true (not a live connection test)
//            'configured_send_disabled'  SMTP settings valid, MAIL_REAL_SEND is not exactly "true"
//            'not_configured'            an SMTP setting or MAIL_FROM is missing or invalid (names listed in detail)
//   inbound  'webhook'                   INBOUND_MAIL_SECRET is set (the webhook accepts signed pushes)
//            'requires_setup'            no inbound path configured
//   status   'connected' only when outbound is 'connected' AND inbound is 'webhook'; else 'requires_setup'.
const REQUIRED = ["MAIL_SMTP_HOST", "MAIL_SMTP_USER", "MAIL_SMTP_PASS"];
const address = require("./address");
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\d{1,3}(?:\.\d{1,3}){3}$/i;

/** Names of the SMTP / sender settings that are missing or invalid (values are never returned). */
function problems() {
  const out = REQUIRED.filter((k) => !process.env[k] || !String(process.env[k]).trim());
  const host = process.env.MAIL_SMTP_HOST;
  if (host && !out.includes("MAIL_SMTP_HOST") && !HOST_RE.test(host.trim())) out.push("MAIL_SMTP_HOST (invalid host name)");
  const port = process.env.MAIL_SMTP_PORT;
  if (port !== undefined && port !== "" && !(/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) out.push("MAIL_SMTP_PORT (must be 1-65535)");
  out.push(...address.problems());
  return out;
}

function setupError() {
  const err = new Error(`imap_smtp requires_setup: SMTP not configured (missing or invalid ${problems().join(", ")})`);
  err.code = "REQUIRES_SETUP";
  return err;
}

// Inbound IMAP polling is not implemented in this build; 'connected' never claims that replies are read
// from a mailbox (they come through the webhook instead).
const POLLING_IMPLEMENTED = false;

async function status() {
  const p = problems();
  const realSend = process.env.MAIL_REAL_SEND === "true";
  const outbound = p.length ? "not_configured" : realSend ? "connected" : "configured_send_disabled";
  const inbound = process.env.INBOUND_MAIL_SECRET ? "webhook" : "requires_setup";
  const outText = p.length
    ? `SMTP not configured (missing or invalid: ${p.join(", ")})`
    : realSend ? "SMTP configured, real sending enabled (MAIL_REAL_SEND=true)" : "SMTP configured; sending disabled until MAIL_REAL_SEND=true";
  const inText = inbound === "webhook" ? "inbound via signed webhook POST /jobsearch/inbound/mail" : "no inbound path: set INBOUND_MAIL_SECRET and point the mail bridge at POST /jobsearch/inbound/mail";
  return {
    status: outbound === "connected" && inbound === "webhook" ? "connected" : "requires_setup",
    detail: `${outText}; ${inText}; inbound polling not implemented (IMAP settings are not used)`,
    mode: "smtp",
    outbound,
    inbound,
    problems: p,
  };
}

async function send({ to, subject, text, html, attachments, headers } = {}) {
  if (problems().length) throw setupError();
  if (process.env.MAIL_REAL_SEND !== "true") {
    return { providerMessageId: null, accepted: false, reason: "MAIL_REAL_SEND is not true" };
  }
  const nodemailer = require("nodemailer");
  const port = Number(process.env.MAIL_SMTP_PORT) || 587;
  const transport = nodemailer.createTransport({
    host: process.env.MAIL_SMTP_HOST.trim(),
    port,
    secure: port === 465,
    auth: { user: process.env.MAIL_SMTP_USER, pass: process.env.MAIL_SMTP_PASS },
  });
  const info = await transport.sendMail({
    from: address.fromAddress(),
    to, subject, text, html, attachments, headers,
  });
  return { providerMessageId: info.messageId || null, accepted: Array.isArray(info.accepted) ? info.accepted.length > 0 : true };
}

async function poll() {
  const err = new Error("IMAP polling is not implemented in this build (requires_setup: use the signed inbound webhook POST /jobsearch/inbound/mail)");
  err.code = "NOT_IMPLEMENTED";
  throw err;
}

module.exports = { status, send, poll, problems, POLLING_IMPLEMENTED };
