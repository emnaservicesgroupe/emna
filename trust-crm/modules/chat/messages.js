// Messages: paged thread, send (rate limited, serialised per conversation), hide / unhide (moderation).
const db = require("../../db");
const { logAudit } = require("../../utils/audit");
const { HttpError } = require("../jobsearch/httpError");
const hr = require("../hr/common");
const scope = require("./scope");
const c = require("./common");
const { loadVisible } = require("./conversations");
const hub = require("./hub");
const nudges = require("./nudges");

const RATE_LOCK_KEY = 4217; // advisory-lock namespace: one lock per sending user serialises the rate check with the insert
const WINDOW_SECONDS = 60;

class RateLimitError extends HttpError {
  constructor(retryAfter) {
    super(429, "Too many messages. Please wait a moment before sending again.");
    this.retryAfter = retryAfter;
  }
}

function ratePerMinute() {
  const n = Number(String(process.env.CHAT_RATE_PER_MIN ?? "").trim());
  return Number.isSafeInteger(n) && n >= 1 ? Math.min(n, 100000) : 30;
}

/** GET /chat/conversations/:id/messages ?before(message id) &limit(<=50) -> {rows (newest first), has_more, next_before}. */
async function listMessages(actor, rawId, query) {
  const id = c.pathId(rawId);
  const q = query || {};
  const { limit } = c.paging({ limit: q.limit }, { def: 30 });
  let before = null;
  if (q.before !== undefined) before = c.parseId(hr.oneValue(q.before, "before"), { label: "before" });
  await loadVisible(db, actor, id);
  const params = [id];
  let cond = "";
  if (before !== null) {
    params.push(before);
    cond = "AND m.id < $2";
  }
  params.push(limit + 1);
  const r = await db.query(
    `SELECT ${c.messageColumns(actor)} FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_user_id
      WHERE m.conversation_id = $1 ${cond} ORDER BY m.id DESC LIMIT $${params.length}`,
    params
  );
  const page = r.rows.slice(0, limit);
  const hasMore = r.rows.length > limit;
  return { rows: page.map((row) => c.shapeMessage(row, actor)), has_more: hasMore, next_before: hasMore ? c.num(page[page.length - 1].id) : null };
}

/**
 * POST /chat/conversations/:id/messages {body}. One transaction: re-check the account, serialise on the sender (rate limit counted in SQL
 * across ALL conversations) and on the conversation (ids follow commit order), insert, move the conversation pointer, audit. The sender's
 * read marker is NOT moved (own messages are never unread; replying must not hide messages that arrived meanwhile). The text is never written to the audit log.
 */
async function sendMessage(actor0, rawId, input) {
  const id = c.pathId(rawId);
  const { text, length } = c.messageText(c.bodyObject(input).body);
  const sent = await c.inTransaction(async (client) => {
    const actor = await scope.resolveActor(client, { id: actor0.userId, role: actor0.role }, { lock: true });
    if (!actor.perms.write) throw new HttpError(403, "Permission denied: chat:write");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [RATE_LOCK_KEY, actor.userId]);
    const conv = await loadVisible(client, actor, id, { lock: true });
    if (conv.status !== "open") throw new HttpError(409, "This conversation is closed");
    const rate = await client.query(
      `SELECT count(*)::int AS n, CEIL(EXTRACT(EPOCH FROM (min(created_at) + make_interval(secs => $2) - clock_timestamp())))::int AS wait
         FROM chat_messages WHERE sender_user_id = $1 AND created_at > clock_timestamp() - make_interval(secs => $2)`,
      [actor.userId, WINDOW_SECONDS]
    );
    if (rate.rows[0].n >= ratePerMinute()) throw new RateLimitError(Math.min(WINDOW_SECONDS, Math.max(1, rate.rows[0].wait || 1)));
    const ins = await client.query(
      `INSERT INTO chat_messages (conversation_id, sender_user_id, sender_role, body, created_at) VALUES ($1,$2,$3,$4, clock_timestamp())
       RETURNING id, conversation_id, sender_user_id, sender_role, body, created_at, hidden_at, hidden_by, hidden_reason`,
      [id, actor.userId, actor.role, text]
    );
    const m = ins.rows[0];
    await client.query("UPDATE chat_conversations SET last_message_id = $2, last_message_at = $3 WHERE id = $1", [id, m.id, m.created_at]);
    await logAudit({ client, userId: actor.userId, action: "chat.message.send", tableName: "chat_messages", recordId: String(m.id), newData: { conversation_id: id, sender_role: actor.role, length } });
    return { out: c.shapeMessage({ ...m, sender_name: actor.name }, actor), conversationId: id, messageId: Number(m.id), senderRole: actor.role };
  });
  // After the commit (a failed send never publishes or e-mails). Neither can fail the request: publish never throws, the nudge logs and resolves.
  hub.publish({ kind: "message", conversation_id: sent.conversationId, message_id: sent.messageId });
  nudges.schedule({ conversationId: sent.conversationId, senderRole: sent.senderRole });
  return sent.out;
}

/**
 * POST /chat/messages/:id/hide {reason} and /unhide {reason?} (chat:moderate). The message must be in a conversation the moderator can see
 * (else the same 404). Idempotent: repeating a hide keeps the first reason / moderator and is not audited again.
 */
async function setHidden(actor0, rawId, input, hide) {
  const id = c.pathId(rawId);
  if (actor0.kind !== "staff" || !actor0.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
  const reason = c.reasonText(c.bodyObject(input).reason, { required: hide });
  const done = await c.inTransaction(async (client) => {
    const actor = await scope.resolveActor(client, { id: actor0.userId, role: actor0.role }, { lock: true });
    if (!actor.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
    const sc = scope.conversationVisibleSql(actor, "c", 1);
    const found = await client.query(
      `SELECT m.id, m.conversation_id, m.hidden_at, m.hidden_reason FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.id = $1 AND ${sc.clause} FOR UPDATE OF m`,
      [id, ...sc.params]
    );
    if (found.rowCount === 0) throw c.notFound();
    const cur = found.rows[0];
    const isHidden = cur.hidden_at !== null;
    let changed = false;
    if (hide && !isHidden) {
      await client.query("UPDATE chat_messages SET hidden_at = clock_timestamp(), hidden_by = $2, hidden_reason = $3 WHERE id = $1", [id, actor.userId, reason]);
      changed = true;
    } else if (!hide && isHidden) {
      await client.query("UPDATE chat_messages SET hidden_at = NULL, hidden_by = NULL, hidden_reason = NULL WHERE id = $1", [id]);
      changed = true;
    }
    if (changed) {
      await logAudit({
        client, userId: actor.userId, action: hide ? "chat.message.hide" : "chat.message.unhide", tableName: "chat_messages", recordId: String(id),
        oldData: hide ? null : { hidden_reason: cur.hidden_reason }, newData: { reason },
      });
    }
    const r = await client.query(`SELECT ${c.messageColumns(actor)} FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.id = $1`, [id]);
    return { out: { ...c.shapeMessage(r.rows[0], actor), changed }, changed, conversationId: Number(cur.conversation_id) };
  });
  if (done.changed) hub.publish({ kind: "hidden", conversation_id: done.conversationId, message_id: id });
  return done.out;
}

module.exports = { listMessages, sendMessage, setHidden, RateLimitError, ratePerMinute };
