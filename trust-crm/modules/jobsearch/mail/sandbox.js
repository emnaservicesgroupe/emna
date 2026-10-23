// Sandbox mail adapter: records to js_sandbox_mail, never touches the network.
const crypto = require("crypto");

const DIRECTION = "_direction";

function db() {
  return require("../../../db");
}

function allowPatterns() {
  const raw = process.env.MAIL_SANDBOX_ALLOWLIST;
  return (raw && raw.trim() ? raw : "*@test.invalid")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
}

function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^@\\s]*");
  return new RegExp(`^${escaped}$`);
}

function isAllowed(address, patterns = allowPatterns()) {
  const addr = String(address || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(addr)) return false;
  return patterns.some((p) => patternToRegExp(p).test(addr));
}

function toList(to) {
  return (Array.isArray(to) ? to : [to]).map((a) => String(a || "").trim()).filter(Boolean);
}

async function status() {
  return { status: "connected", detail: `sandbox (recorded in js_sandbox_mail; allow-list: ${allowPatterns().join(", ")})` };
}

async function send({ to, subject, text, html, attachments, headers } = {}) {
  const recipients = toList(to);
  const patterns = allowPatterns();
  if (recipients.length === 0 || !recipients.every((r) => isAllowed(r, patterns))) {
    return { providerMessageId: null, accepted: false, reason: "recipient not in MAIL_SANDBOX_ALLOWLIST" };
  }
  const providerMessageId = `<sandbox-${crypto.randomUUID()}@vita.test.invalid>`;
  const meta = (attachments || []).map((a) => ({
    filename: a && a.filename,
    contentType: a && a.contentType,
    size: a && a.content ? Buffer.byteLength(a.content) : 0,
    sha256: a && a.content ? crypto.createHash("sha256").update(a.content).digest("hex") : null,
  }));
  await db().query(
    `INSERT INTO js_sandbox_mail (to_addr, from_addr, subject, body, message_id, headers, attachments)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      recipients.join(", "),
      process.env.MAIL_FROM || "vita@test.invalid",
      subject || "",
      text || (html ? String(html) : ""),
      providerMessageId,
      JSON.stringify({ ...(headers || {}), [DIRECTION]: "outbound" }),
      JSON.stringify(meta),
    ]
  );
  return { providerMessageId, accepted: true };
}

function toInbound(row) {
  return {
    id: row.id,
    providerMessageId: row.message_id,
    from: row.from_addr,
    to: row.to_addr,
    subject: row.subject,
    text: row.body,
    headers: row.headers,
    attachments: row.attachments,
    receivedAt: row.created_at,
  };
}

async function poll(sinceCursor) {
  const since = Number(sinceCursor) || 0;
  const r = await db().query(
    `SELECT * FROM js_sandbox_mail WHERE headers->>'${DIRECTION}' = 'inbound' AND id > $1 ORDER BY id`,
    [since]
  );
  const messages = r.rows.map(toInbound);
  return { messages, cursor: messages.length ? messages[messages.length - 1].id : since };
}

/** Test helper: simulate an inbound message. */
async function injectInbound({ from, to, subject, text, headers, messageId } = {}) {
  const r = await db().query(
    `INSERT INTO js_sandbox_mail (to_addr, from_addr, subject, body, message_id, headers)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      to || "vita@test.invalid",
      from,
      subject || "",
      text || "",
      messageId || `<inbound-${crypto.randomUUID()}@test.invalid>`,
      JSON.stringify({ ...(headers || {}), [DIRECTION]: "inbound" }),
    ]
  );
  return toInbound(r.rows[0]);
}

/** Test helper: outbound messages, optionally filtered by recipient. */
async function listOutbound({ to } = {}) {
  const r = await db().query(
    `SELECT * FROM js_sandbox_mail WHERE headers->>'${DIRECTION}' = 'outbound' AND ($1::text IS NULL OR to_addr = $1) ORDER BY id`,
    [to || null]
  );
  return r.rows;
}

module.exports = { status, send, poll, injectInbound, listOutbound, isAllowed };
