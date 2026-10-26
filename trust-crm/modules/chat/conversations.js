// Conversations: scoped list, idempotent open, close / reopen, read marker, unread totals.
const db = require("../../db");
const { logAudit } = require("../../utils/audit");
const { HttpError } = require("../jobsearch/httpError");
const scope = require("./scope");
const c = require("./common");

const OPEN_TYPES = ["candidate", "employer_request", "agency"];

const candidateCanStart = () => !/^(false|0|no|off)$/i.test(String(process.env.CHAT_CANDIDATE_CAN_START ?? "true").trim());

function shapeConversation(row, actor) {
  const out = {
    id: c.num(row.id),
    subject_type: row.subject_type,
    subject_id: c.num(row.subject_id),
    title: row.title || null,
    status: row.status,
    created_at: row.created_at,
    last_message_at: row.last_message_at || null,
  };
  if (actor.kind === "staff" && row.subject_name !== undefined) out.subject_name = row.subject_name || null;
  return out;
}

/**
 * Loads a conversation the actor may see, or throws the one 404 every missing / foreign / out-of-scope id gets.
 * The scope is part of the SELECT. With { lock: true } the row is locked FOR UPDATE (inside a transaction).
 */
async function loadVisible(runner, actor, id, { lock = false } = {}) {
  const sc = scope.conversationVisibleSql(actor, "c", 1);
  const r = await runner.query(
    `SELECT c.id, c.subject_type, c.subject_id, c.title, c.status, c.created_at, c.last_message_at, c.last_message_id
       FROM chat_conversations c WHERE c.id = $1 AND ${sc.clause} ${lock ? "FOR UPDATE OF c" : ""}`,
    [id, ...sc.params]
  );
  if (r.rowCount === 0) throw c.notFound();
  return r.rows[0];
}

const SUBJECT_NAME_SQL = `CASE c.subject_type
    WHEN 'candidate' THEN (SELECT s.full_name FROM candidates s WHERE s.id = c.subject_id)
    WHEN 'employer_request' THEN (SELECT s.name FROM crm_employers s WHERE s.id = c.subject_id)
    WHEN 'agency' THEN (SELECT s.name FROM crm_agencies s WHERE s.id = c.subject_id)
  END`;

/** GET /chat/conversations ?limit(<=50) &offset -> {rows, has_more}: newest activity first, with unread_count and a last-message preview. */
async function listConversations(actor, query) {
  const { limit, offset } = c.paging(query || {}, { def: 25 });
  const external = actor.kind !== "staff";
  const sc = scope.conversationVisibleSql(actor, "c", 1);
  const lim = sc.params.length + 2;
  const preview = external ? `CASE WHEN lm.hidden_at IS NULL THEN left(lm.body, ${c.PREVIEW_CHARS}) END` : `left(lm.body, ${c.PREVIEW_CHARS})`;
  const r = await db.query(
    `SELECT c.id, c.subject_type, c.subject_id, c.title, c.status, c.created_at, c.last_message_at,
            ${external ? "" : `${SUBJECT_NAME_SQL} AS subject_name,`}
            lm.id AS lm_id, lm.created_at AS lm_created_at, lm.sender_role AS lm_sender_role, lm.hidden_at AS lm_hidden_at, ${preview} AS lm_preview,
            (SELECT count(*) FROM chat_messages m
              WHERE m.conversation_id = c.id AND m.id > COALESCE(p.last_read_message_id, 0) AND m.hidden_at IS NULL AND m.sender_user_id IS DISTINCT FROM $1)::int AS unread_count
       FROM chat_conversations c
       LEFT JOIN chat_participants p ON p.conversation_id = c.id AND p.user_id = $1
       LEFT JOIN chat_messages lm ON lm.id = c.last_message_id AND lm.conversation_id = c.id
      WHERE ${sc.clause}
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
      LIMIT $${lim} OFFSET $${lim + 1}`,
    [actor.userId, ...sc.params, limit + 1, offset]
  );
  const rows = r.rows.slice(0, limit).map((row) => {
    const out = shapeConversation(row, actor);
    out.unread_count = row.unread_count;
    if (row.lm_id === null) out.last_message = null;
    else if (row.lm_hidden_at && external) out.last_message = { id: c.num(row.lm_id), created_at: row.lm_created_at, hidden: true };
    else {
      out.last_message = {
        id: c.num(row.lm_id),
        created_at: row.lm_created_at,
        preview: row.lm_preview,
        sender_role: external && c.isStaffSender(row.lm_sender_role) ? "staff" : row.lm_sender_role,
        hidden: Boolean(row.lm_hidden_at),
      };
    }
    return out;
  });
  return { rows, has_more: r.rows.length > limit };
}

/**
 * POST /chat/conversations {subject_type, subject_id}. Staff open a conversation for a subject they can serve; a candidate may open
 * only their own candidate conversation (CHAT_CANDIDATE_CAN_START, default true); employers and agencies never start one.
 * Idempotent per subject: -> {created:true, conversation} (201) or {created:false, conversation} (200).
 */
async function openConversation(actor0, input) {
  const body = c.bodyObject(input);
  const type = body.subject_type;
  if (typeof type !== "string" || !OPEN_TYPES.includes(type)) throw new HttpError(400, `subject_type must be one of ${OPEN_TYPES.join(", ")}`);
  if (actor0.kind !== "staff") {
    if (actor0.kind !== "candidate" || type !== "candidate") throw new HttpError(403, "Access denied");
    if (!candidateCanStart()) throw new HttpError(403, "Starting a conversation is not enabled");
  } else if (!actor0.perms.write) throw new HttpError(403, "Permission denied: chat:write");
  let subjectId;
  if (actor0.kind === "candidate" && (body.subject_id === undefined || body.subject_id === null)) subjectId = actor0.candidateId;
  else subjectId = c.parseId(body.subject_id, { label: "subject_id" });
  if (actor0.kind === "candidate" && subjectId !== actor0.candidateId) throw c.notFound();

  return c.inTransaction(async (client) => {
    const actor = await scope.resolveActor(client, { id: actor0.userId, role: actor0.role }, { lock: true });
    if (actor.kind === "candidate") {
      if (subjectId !== actor.candidateId) throw c.notFound();
    } else if (!(await scope.canServeSubject(client, actor, type, subjectId))) throw c.notFound();
    const ins = await client.query(
      `INSERT INTO chat_conversations (subject_type, subject_id, created_by) VALUES ($1,$2,$3)
       ON CONFLICT (subject_type, subject_id) WHERE subject_type <> 'staff' DO NOTHING
       RETURNING id, subject_type, subject_id, title, status, created_at, last_message_at`,
      [type, subjectId, actor.userId]
    );
    if (ins.rowCount > 0) {
      await logAudit({ client, userId: actor.userId, action: "chat.conversation.open", tableName: "chat_conversations", recordId: String(ins.rows[0].id), newData: { subject_type: type, subject_id: subjectId, opened_by_role: actor.role } });
      return { created: true, conversation: shapeConversation(ins.rows[0], actor) };
    }
    const ex = await client.query(
      "SELECT id, subject_type, subject_id, title, status, created_at, last_message_at FROM chat_conversations WHERE subject_type = $1 AND subject_id = $2",
      [type, subjectId]
    );
    return { created: false, conversation: shapeConversation(ex.rows[0], actor) };
  });
}

/** POST /chat/conversations/:id/close | reopen (chat:moderate). Idempotent: only a real change is audited. */
async function setStatus(actor0, rawId, status) {
  const id = c.pathId(rawId);
  if (actor0.kind !== "staff" || !actor0.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
  return c.inTransaction(async (client) => {
    const actor = await scope.resolveActor(client, { id: actor0.userId, role: actor0.role }, { lock: true });
    if (!actor.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
    const conv = await loadVisible(client, actor, id, { lock: true });
    const out = shapeConversation(conv, actor);
    if (conv.status === status) return { ...out, changed: false };
    await client.query("UPDATE chat_conversations SET status = $2 WHERE id = $1", [id, status]);
    await logAudit({ client, userId: actor.userId, action: status === "closed" ? "chat.conversation.close" : "chat.conversation.reopen", tableName: "chat_conversations", recordId: String(id), oldData: { status: conv.status }, newData: { status } });
    return { ...out, status, changed: true };
  });
}

async function unreadFor(runner, actor, conversationId) {
  const r = await runner.query(
    `SELECT count(*)::int AS n FROM chat_messages m
       LEFT JOIN chat_participants p ON p.conversation_id = m.conversation_id AND p.user_id = $1
      WHERE m.conversation_id = $2 AND m.id > COALESCE(p.last_read_message_id, 0) AND m.hidden_at IS NULL AND m.sender_user_id IS DISTINCT FROM $1`,
    [actor.userId, conversationId]
  );
  return r.rows[0].n;
}

/** POST /chat/conversations/:id/read {message_id}: moves the viewer's read marker forward (never back). The message must belong to the conversation. */
async function markRead(actor, rawId, input) {
  const id = c.pathId(rawId);
  const body = c.bodyObject(input);
  return c.inTransaction(async (client) => {
    await loadVisible(client, actor, id);
    const messageId = c.parseId(body.message_id, { label: "message_id" });
    const m = await client.query("SELECT 1 FROM chat_messages WHERE id = $1 AND conversation_id = $2", [messageId, id]);
    if (m.rowCount === 0) throw c.notFound();
    // The read marker lives in chat_participants; the row is created lazily (added_by NULL) and never grants access.
    const up = await client.query(
      `INSERT INTO chat_participants (conversation_id, user_id, last_read_message_id) VALUES ($1,$2,$3)
       ON CONFLICT (conversation_id, user_id) DO UPDATE
         SET last_read_message_id = GREATEST(COALESCE(chat_participants.last_read_message_id, 0), EXCLUDED.last_read_message_id)
       RETURNING last_read_message_id`,
      [id, actor.userId, messageId]
    );
    return { conversation_id: id, last_read_message_id: c.num(up.rows[0].last_read_message_id), unread_count: await unreadFor(client, actor, id) };
  });
}

/** GET /chat/unread-count -> {unread, conversations}: unread, non-hidden messages of others in the conversations the viewer can see. */
async function unreadCount(actor) {
  const sc = scope.conversationVisibleSql(actor, "c", 1);
  const r = await db.query(
    `SELECT count(*)::int AS unread, count(DISTINCT m.conversation_id)::int AS conversations
       FROM chat_conversations c
       LEFT JOIN chat_participants p ON p.conversation_id = c.id AND p.user_id = $1
       JOIN chat_messages m ON m.conversation_id = c.id AND m.id > COALESCE(p.last_read_message_id, 0) AND m.hidden_at IS NULL AND m.sender_user_id IS DISTINCT FROM $1
      WHERE ${sc.clause}`,
    [actor.userId, ...sc.params]
  );
  return { unread: r.rows[0].unread, conversations: r.rows[0].conversations };
}

module.exports = { listConversations, openConversation, setStatus, markRead, unreadCount, loadVisible, shapeConversation, candidateCanStart };
