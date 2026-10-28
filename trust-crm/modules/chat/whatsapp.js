// WhatsApp sandbox adapter (stage 6, Task 3). There is NO WhatsApp sending in this build: a real channel needs the owner's WhatsApp Business
// provider account and approved message templates. This adapter exists so the code path and its honesty are testable:
//   send({messageId}) records a chat_channel_outbox row with status 'requires_setup' and returns {accepted: false, status: 'requires_setup', ...}.
// It never opens a network connection, never stores message text (only the message id and a fixed detail), and it is NOT wired into message
// sending yet - it is only called from tests / an operator hook. Setting WHATSAPP_PROVIDER does not change that: an unimplemented provider
// is reported as requires_setup too, never as sent.
const db = require("../../db");

const NEEDS = "WhatsApp needs the owner's WhatsApp Business provider account and approved message templates; nothing is sent until they are configured.";

function provider() {
  const p = String(process.env.WHATSAPP_PROVIDER || "").trim().toLowerCase();
  return p || null;
}

function status() {
  const p = provider();
  return {
    channel: "whatsapp",
    status: "requires_setup",
    detail: p ? `${NEEDS} (provider "${p}" is not implemented in this build)` : NEEDS,
  };
}

/** @returns {Promise<{accepted: false, status: 'requires_setup', outbox_id: number, detail: string}>} */
async function send(message = {}) {
  const messageId = Number(message.messageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("whatsapp.send: messageId is required");
  const detail = status().detail;
  const r = await db.query("INSERT INTO chat_channel_outbox (message_id, channel, status, detail) VALUES ($1,'whatsapp','requires_setup',$2) RETURNING id", [messageId, detail]);
  return { accepted: false, status: "requires_setup", outbox_id: Number(r.rows[0].id), detail };
}

module.exports = { send, status };
