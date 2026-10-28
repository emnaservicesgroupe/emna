// Conversations: scoped list, idempotent open, close / reopen, read marker, unread totals.
const db = require("../../db");
const { logAudit } = require("../../utils/audit");
const { HttpError } = require("../jobsearch/httpError");
const scope = require("./scope");
const c = require("./common");
const hub = require("./hub");

const OPEN_TYPES = ["candidate", "employer_request", "agency"];
const ROOM_TITLE_MAX = 120;
const ROOM_MEMBERS_MAX = 50;
const ID_MAX = 2147483647;

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

/** Title of a staff room: a string, trimmed, 1..120 characters (code points), no NUL / lone surrogate, something visible. */
function roomTitle(v) {
  if (typeof v !== "string") throw new HttpError(400, "title must be a string");
  const t = v.trim();
  if (t.includes("\u0000") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t)) throw new HttpError(400, "title contains invalid characters");
  if (/[\u202A-\u202E\u2066-\u2069]/.test(t)) throw new HttpError(400, "title contains bidirectional override or isolate characters, which are not allowed");
  const len = [...t].length;
  if (len < 1 || /^[\p{Cf}\p{Cc}\p{Z}\s]*$/u.test(t)) throw new HttpError(400, "title is required");
  if (len > ROOM_TITLE_MAX) throw new HttpError(400, `title must be at most ${ROOM_TITLE_MAX} characters`);
  return t;
}

/** participant_user_ids: an array of 1..50 positive 32-bit ids (duplicates collapse). */
function roomMemberIds(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > ROOM_MEMBERS_MAX) throw new HttpError(400, `participant_user_ids must be a list of 1 to ${ROOM_MEMBERS_MAX} user ids`);
  const ids = new Set();
  for (const raw of v) {
    if (!Number.isSafeInteger(raw) || raw < 1 || raw > ID_MAX) throw new HttpError(400, "participant_user_ids must contain positive integer user ids");
    ids.add(raw);
  }
  return [...ids];
}

/** Active staff users among `ids` (who may be added to a staff room). */
async function activeStaff(runner, ids) {
  const r = await runner.query("SELECT id, full_name, role FROM users WHERE id = ANY($1::int[]) AND is_active = true AND role = ANY($2::text[])", [ids, [...scope.ROOM_MEMBER_ROLES]]);
  return r.rows;
}

/**
 * POST /chat/conversations {subject_type: 'staff', title, participant_user_ids} (chat:moderate): an internal room visible only to its
 * EXPLICIT participants (added_by set), HR and Accountant included. The creator is a participant too. Rooms are not idempotent (a new room
 * each time); every participant must be an active staff user. Audited once, with the participant ids (never any text).
 */
async function createStaffRoom(actor0, body) {
  if (actor0.kind !== "staff" || !actor0.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
  const title = roomTitle(body.title);
  const requested = roomMemberIds(body.participant_user_ids);
  return c.inTransaction(async (client) => {
    const actor = await scope.resolveActor(client, { id: actor0.userId, role: actor0.role }, { lock: true });
    if (!actor.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
    const members = [...new Set([actor.userId, ...requested])];
    const found = await activeStaff(client, members);
    if (found.length !== members.length) throw new HttpError(400, "participant_user_ids must be active staff users");
    const ins = await client.query(
      `INSERT INTO chat_conversations (subject_type, subject_id, title, created_by) VALUES ('staff', NULL, $1, $2)
       RETURNING id, subject_type, subject_id, title, status, created_at, last_message_at`,
      [title, actor.userId]
    );
    const id = ins.rows[0].id;
    await client.query("INSERT INTO chat_participants (conversation_id, user_id, added_by) SELECT $1, x, $2 FROM unnest($3::int[]) AS x", [id, actor.userId, members]);
    await logAudit({ client, userId: actor.userId, action: "chat.conversation.open", tableName: "chat_conversations", recordId: String(id), newData: { subject_type: "staff", participant_user_ids: members.sort((a, b) => a - b) } });
    return { created: true, conversation: { ...shapeConversation(ins.rows[0], actor), participant_user_ids: members } };
  });
}

/**
 * POST /chat/conversations {subject_type, subject_id}. Staff open a conversation for a subject they can serve; a candidate may open
 * only their own candidate conversation (CHAT_CANDIDATE_CAN_START, default true); employers and agencies never start one.
 * Idempotent per subject: -> {created:true, conversation} (201) or {created:false, conversation} (200).
 */
async function openConversation(actor0, input) {
  const body = c.bodyObject(input);
  const type = body.subject_type;
  if (type === "staff") return createStaffRoom(actor0, body);
  if (typeof type !== "string" || !OPEN_TYPES.includes(type)) throw new HttpError(400, `subject_type must be one of ${OPEN_TYPES.join(", ")}`);
  if (actor0.kind !== "staff") {
    if (actor0.kind !== "candidate" || type !== "candidate") throw new HttpError(403, "Access denied");
    if (!candidateCanStart()) throw new HttpError(403, "Starting a conversation is not enabled");
  } else if (actor0.participantOnly) throw new HttpError(403, "Access denied");
  else if (!actor0.perms.write) throw new HttpError(403, "Permission denied: chat:write");
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
  const result = await c.inTransaction(async (client) => {
    const actor = await scope.resolveActor(client, { id: actor0.userId, role: actor0.role }, { lock: true });
    if (!actor.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
    const conv = await loadVisible(client, actor, id, { lock: true });
    const out = shapeConversation(conv, actor);
    if (conv.status === status) return { ...out, changed: false };
    await client.query("UPDATE chat_conversations SET status = $2 WHERE id = $1", [id, status]);
    await logAudit({ client, userId: actor.userId, action: status === "closed" ? "chat.conversation.close" : "chat.conversation.reopen", tableName: "chat_conversations", recordId: String(id), oldData: { status: conv.status }, newData: { status } });
    return { ...out, status, changed: true };
  });
  if (result.changed) hub.publish({ kind: status === "closed" ? "closed" : "reopened", conversation_id: id });
  return result;
}

/**
 * POST /chat/conversations/:id/participants {user_id} (chat:moderate): makes an active STAFF user an explicit participant (added_by = the actor),
 * which gives Receptionist / Agent access to employer / agency conversations and staff rooms, and HR / Accountant access to staff rooms.
 * Idempotent: -> 201 {changed: true} when added, 200 {changed: false} when already a participant; audited only on a change. The moderator must
 * see the conversation (else the usual 404). HR / Accountant can only join staff rooms; candidate conversations follow the assignment, not participants.
 */
async function addParticipant(actor0, rawId, input) {
  const id = c.pathId(rawId);
  if (actor0.kind !== "staff" || !actor0.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
  const userId = c.parseId(c.bodyObject(input).user_id, { label: "user_id" });
  return c.inTransaction(async (client) => {
    const actor = await scope.resolveActor(client, { id: actor0.userId, role: actor0.role }, { lock: true });
    if (!actor.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
    const conv = await loadVisible(client, actor, id, { lock: true });
    const target = (await activeStaff(client, [userId]))[0];
    if (!target) throw new HttpError(400, "user_id must be an active staff user");
    if (conv.subject_type === "candidate") throw new HttpError(400, "Participants cannot be added to a candidate conversation: it follows the candidate's assignment");
    if (conv.subject_type !== "staff" && scope.PARTICIPANT_ONLY_ROLES.has(target.role)) throw new HttpError(400, "HR and Accountant can only join staff rooms");
    const up = await client.query(
      `INSERT INTO chat_participants (conversation_id, user_id, added_by) VALUES ($1,$2,$3)
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET added_by = EXCLUDED.added_by, added_at = now() WHERE chat_participants.added_by IS NULL
       RETURNING user_id`,
      [id, userId, actor.userId]
    );
    const changed = up.rowCount > 0;
    if (changed) {
      await logAudit({ client, userId: actor.userId, action: "chat.participant.add", tableName: "chat_participants", recordId: `${id}:${userId}`, newData: { conversation_id: id, user_id: userId, role: target.role } });
    }
    return { conversation_id: id, user_id: userId, full_name: target.full_name, role: target.role, changed };
  });
}

/**
 * DELETE /chat/conversations/:id/participants/:user_id (chat:moderate): withdraws the explicit access (added_by -> NULL; the read marker, if any,
 * stays). Idempotent: {changed: false} when the user was not an explicit participant; audited only on a change. Works for deactivated users too.
 */
async function removeParticipant(actor0, rawId, rawUserId) {
  const id = c.pathId(rawId);
  if (actor0.kind !== "staff" || !actor0.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
  const userId = c.parseId(rawUserId, { label: "user_id" });
  return c.inTransaction(async (client) => {
    const actor = await scope.resolveActor(client, { id: actor0.userId, role: actor0.role }, { lock: true });
    if (!actor.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
    const conv = await loadVisible(client, actor, id, { lock: true });
    if (conv.subject_type === "staff") {
      // A staff room is visible to its explicit participants only: taking the last one out (yourself included) would orphan it for good.
      const rest = await client.query("SELECT count(*)::int AS n FROM chat_participants WHERE conversation_id = $1 AND added_by IS NOT NULL AND user_id <> $2", [id, userId]);
      const target = await client.query("SELECT 1 FROM chat_participants WHERE conversation_id = $1 AND user_id = $2 AND added_by IS NOT NULL", [id, userId]);
      if (target.rowCount > 0 && rest.rows[0].n === 0) throw new HttpError(409, "A staff room must keep at least one participant");
    }
    const del = await client.query("UPDATE chat_participants SET added_by = NULL WHERE conversation_id = $1 AND user_id = $2 AND added_by IS NOT NULL RETURNING user_id", [id, userId]);
    const changed = del.rowCount > 0;
    if (changed) {
      await logAudit({ client, userId: actor.userId, action: "chat.participant.remove", tableName: "chat_participants", recordId: `${id}:${userId}`, oldData: { conversation_id: id, user_id: userId } });
    }
    return { conversation_id: id, user_id: userId, changed };
  });
}

/** GET /chat/conversations/:id/participants (chat:moderate): the explicit participants, for the "add participant" dialog. */
async function listParticipants(actor, rawId) {
  const id = c.pathId(rawId);
  if (actor.kind !== "staff" || !actor.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
  await loadVisible(db, actor, id);
  const r = await db.query(
    `SELECT p.user_id, u.full_name, u.role, p.added_at FROM chat_participants p JOIN users u ON u.id = p.user_id
      WHERE p.conversation_id = $1 AND p.added_by IS NOT NULL ORDER BY u.full_name, p.user_id`,
    [id]
  );
  return { rows: r.rows.map((row) => ({ user_id: row.user_id, full_name: row.full_name, role: row.role, added_at: row.added_at })) };
}

/** GET /chat/staff ?q&limit(<=50) (chat:moderate): active staff users {id, full_name, role} to pick participants from (no e-mail addresses). */
async function staffDirectory(actor, query) {
  if (actor.kind !== "staff" || !actor.perms.moderate) throw new HttpError(403, "Permission denied: chat:moderate");
  const q = query || {};
  const { limit } = c.paging({ limit: q.limit }, { def: 25 });
  let term = "";
  if (q.q !== undefined) {
    if (typeof q.q !== "string") throw new HttpError(400, "q must be a single value");
    term = q.q.trim().slice(0, 100);
  }
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const r = await db.query(
    `SELECT id, full_name, role FROM users WHERE is_active = true AND role = ANY($1::text[]) AND ($2 = '' OR full_name ILIKE $3) ORDER BY full_name, id LIMIT $4`,
    [[...scope.ROOM_MEMBER_ROLES], term, like, limit]
  );
  return { rows: r.rows };
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
  const result = await c.inTransaction(async (client) => {
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
  // Delivered only to the reader's own streams (other tabs refresh their unread badge); the other side never learns that a message was read.
  hub.publish({ kind: "read", conversation_id: id, message_id: result.last_read_message_id, user_id: actor.userId });
  return result;
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

module.exports = { listConversations, openConversation, setStatus, markRead, unreadCount, loadVisible, shapeConversation, candidateCanStart, addParticipant, removeParticipant, listParticipants, staffDirectory };
