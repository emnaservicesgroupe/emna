// Real mailbox adapter. Importing never throws; without configuration it reports requires_setup.
const REQUIRED = [
  "MAIL_SMTP_HOST", "MAIL_SMTP_USER", "MAIL_SMTP_PASS",
  "MAIL_IMAP_HOST", "MAIL_IMAP_USER", "MAIL_IMAP_PASS",
];

function missing() {
  return REQUIRED.filter((k) => !process.env[k]);
}

function setupError() {
  const err = new Error(`imap_smtp requires_setup: not configured (missing ${missing().join(", ")})`);
  err.code = "REQUIRES_SETUP";
  return err;
}

async function status() {
  const m = missing();
  if (m.length) return { status: "requires_setup", detail: `Missing env: ${m.join(", ")}` };
  const real = process.env.MAIL_REAL_SEND === "true";
  return { status: "connected", detail: real ? "imap_smtp (real sending enabled)" : "imap_smtp configured; sending disabled until MAIL_REAL_SEND=true" };
}

async function send({ to, subject, text, html, attachments, headers } = {}) {
  if (missing().length) throw setupError();
  if (process.env.MAIL_REAL_SEND !== "true") {
    return { providerMessageId: null, accepted: false, reason: "MAIL_REAL_SEND is not true" };
  }
  const nodemailer = require("nodemailer");
  const port = Number(process.env.MAIL_SMTP_PORT) || 587;
  const transport = nodemailer.createTransport({
    host: process.env.MAIL_SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.MAIL_SMTP_USER, pass: process.env.MAIL_SMTP_PASS },
  });
  const info = await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.MAIL_SMTP_USER,
    to, subject, text, html, attachments, headers,
  });
  return { providerMessageId: info.messageId || null, accepted: Array.isArray(info.accepted) ? info.accepted.length > 0 : true };
}

async function poll() {
  if (missing().length) throw setupError();
  const err = new Error("IMAP polling is not implemented in this build");
  err.code = "NOT_IMPLEMENTED";
  throw err;
}

module.exports = { status, send, poll };
