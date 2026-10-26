// Realtime chat events over SSE (stage 6, Task 3). In-process hub: ONE Node process owns the streams, so a multi-process deployment would
// need a shared bus (documented limitation; the stack runs a single app container).
//
//   subscribe(actor, req, res, lastEventId)   opens GET /chat/events for an actor built by scope.resolveActor (throws LimitError before writing)
//   publish({kind, conversation_id, message_id?, user_id?})   called AFTER COMMIT by messages.js / conversations.js; never throws
//
// Events carry ids and a kind only, never message text: {id, kind, conversation_id, message_id?}
//   kind 'message'    a message was sent                       id = the message id (also the SSE `id:` field -> Last-Event-ID)
//   kind 'hidden'     a message was hidden OR unhidden          id = null, message_id = the message (clients refetch)
//   kind 'closed' | 'reopened'  conversation status changed    id = null
//   kind 'read'       the viewer's own read marker moved        id = null; delivered ONLY to that user's own streams (no read receipts)
// Only 'message' events have an SSE `id:` line, so the browser's Last-Event-ID is always a chat_messages id.
//
// Safety rules (modelled on modules/jobsearch/eventsHub.js):
//   - every delivery re-reads the account (active, same role, token_version, live candidate / non-suspended organisation) AND re-evaluates the
//     actor's visibility of THAT conversation in SQL (scope.conversationVisibleSql); an event for a conversation the actor cannot see is never
//     written, and a revoked / deactivated / suspended account's stream is closed at once. The same check runs before every heartbeat.
//   - replay for Last-Event-ID is derived from chat_messages (ids greater than the last one, only conversations visible to the actor, newest 200),
//     so no events table exists; a hidden message replays as kind 'hidden' (ids only). Non-message events are not replayed: clients refetch on reconnect.
//   - per-user cap CHAT_SSE_MAX_PER_USER (default 5 -> 429), total cap CHAT_SSE_MAX_TOTAL (default 500 -> 503), heartbeat comment every
//     CHAT_SSE_HEARTBEAT_MS (default 25000), a stalled reader (unsent buffer > CHAT_SSE_MAX_BUFFER_BYTES, 256 KiB) or a runaway backlog is dropped.
//   - deliveries to one stream are serialised (order preserved); disconnects remove the stream; shutdown() closes everything (utils/shutdown.js via server.js).
const db = require("../../db");
const scope = require("./scope");

const envInt = (k, d) => {
  const n = Number(process.env[k]);
  return Number.isSafeInteger(n) && n > 0 ? n : d;
};
const cfg = () => ({
  maxPerUser: envInt("CHAT_SSE_MAX_PER_USER", 5),
  maxTotal: envInt("CHAT_SSE_MAX_TOTAL", 500),
  heartbeatMs: envInt("CHAT_SSE_HEARTBEAT_MS", 25000),
  maxBuffer: envInt("CHAT_SSE_MAX_BUFFER_BYTES", 256 * 1024),
});
const REPLAY_LIMIT = 200;
const MAX_BACKLOG = 500; // queued deliveries per stream before it is dropped (the client reconnects and replays)
const DEDUPE = 1000;
const KINDS = new Set(["message", "hidden", "closed", "reopened", "read"]);

class LimitError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const subs = new Set();

const gone = (sub) => sub.closed || sub.res.destroyed || sub.res.writableEnded || Boolean(sub.req && sub.req.socket && sub.req.socket.destroyed);

function close(sub) {
  if (sub.closed) return;
  sub.closed = true;
  subs.delete(sub);
  if (sub.timer) clearInterval(sub.timer);
  sub.timer = null;
  try {
    // A stalled reader's backlog would never drain through end(): drop the connection instead.
    if (sub.res.destroyed || sub.res.writableLength > 0) sub.res.destroy();
    else sub.res.end();
  } catch {
    /* already gone */
  }
}

function write(sub, text) {
  if (sub.closed) return false;
  if (gone(sub) || sub.res.writableLength > cfg().maxBuffer) {
    close(sub);
    return false;
  }
  try {
    sub.res.write(text);
    return true;
  } catch {
    close(sub);
    return false;
  }
}

function frame(ev) {
  const data = { id: ev.kind === "message" ? ev.message_id : null, kind: ev.kind, conversation_id: ev.conversation_id };
  if (ev.message_id !== undefined && ev.message_id !== null) data.message_id = ev.message_id;
  return `${ev.kind === "message" ? `id: ${ev.message_id}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Re-reads the account: active, same role, same token_version (logout / suspension bump it), live candidate / non-suspended organisation,
 * current permissions. Returns the fresh actor, or null when the stream must close.
 */
async function recheck(sub) {
  try {
    const actor = await scope.resolveActor(db, { id: sub.user.id, role: sub.user.role });
    if (sub.user.tv !== undefined) {
      const r = await db.query("SELECT token_version FROM users WHERE id = $1", [sub.user.id]);
      if (r.rowCount === 0 || r.rows[0].token_version !== sub.user.tv) return null;
    }
    sub.actor = actor;
    return actor;
  } catch (err) {
    if (!(err && (err.status === 401 || err.status === 403))) console.error("chat events: access re-check failed:", err && err.code, err && err.message);
    return null; // revoked, or unable to prove access -> close (the client reconnects and replays)
  }
}

async function visible(actor, conversationId) {
  const sc = scope.conversationVisibleSql(actor, "c", 1);
  const r = await db.query(`SELECT 1 FROM chat_conversations c WHERE c.id = $1 AND ${sc.clause}`, [conversationId, ...sc.params]);
  return r.rowCount > 0;
}

/** Delivers one live event to one stream (runs inside the stream's serial chain). */
async function deliver(sub, ev) {
  if (sub.closed) return;
  if (ev.user_id !== undefined && ev.user_id !== null && ev.user_id !== sub.user.id) return; // targeted event (own read marker)
  const actor = await recheck(sub);
  if (!actor) return close(sub);
  if (gone(sub)) return close(sub);
  if (ev.kind === "message") {
    if (sub.seen.has(ev.message_id)) return; // already sent by the replay
    sub.seen.add(ev.message_id);
    if (sub.seen.size > DEDUPE) sub.seen.delete(sub.seen.values().next().value);
  }
  if (!(await visible(actor, ev.conversation_id))) return; // not for this actor: never written
  if (gone(sub)) return close(sub);
  write(sub, frame(ev));
}

async function replay(sub, lastId) {
  const actor = await recheck(sub);
  if (!actor) return close(sub);
  const sc = scope.conversationVisibleSql(actor, "c", 1);
  const rows = (
    await db.query(
      `SELECT * FROM (
         SELECT m.id, m.conversation_id, (m.hidden_at IS NOT NULL) AS hidden
           FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
          WHERE m.id > $1 AND ${sc.clause} ORDER BY m.id DESC LIMIT ${REPLAY_LIMIT}) x
        ORDER BY id`,
      [lastId, ...sc.params]
    )
  ).rows;
  for (const row of rows) {
    if (gone(sub)) return close(sub);
    const id = Number(row.id);
    sub.seen.add(id);
    write(sub, frame({ kind: row.hidden ? "hidden" : "message", conversation_id: Number(row.conversation_id), message_id: id }));
  }
}

/** Queues work on the stream's serial chain; a stream with a runaway backlog is dropped. */
function enqueue(sub, fn) {
  if (sub.closed) return;
  if (sub.pending >= MAX_BACKLOG) return close(sub);
  sub.pending += 1;
  sub.chain = sub.chain
    .then(fn)
    .catch((err) => {
      console.error("chat events: delivery failed:", err && err.code, err && err.message);
      close(sub);
    })
    .finally(() => {
      sub.pending -= 1;
    });
}

/**
 * Opens an SSE stream for `actor` (from scope.resolveActor). Throws LimitError(429 / 503) BEFORE anything is written when a cap is reached.
 * The slot is reserved synchronously, so concurrent connects cannot overshoot the cap.
 */
async function subscribe(actor, req, res, lastEventId) {
  const c = cfg();
  const user = { id: actor.userId, role: actor.role, tv: req && req.user ? req.user.tv : undefined };
  if (subs.size >= c.maxTotal) throw new LimitError(503, "Too many event streams; try again later");
  let mine = 0;
  for (const s of subs) if (s.user.id === user.id) mine += 1;
  if (mine >= c.maxPerUser) throw new LimitError(429, `At most ${c.maxPerUser} event streams per user`);
  const sub = { user, actor, req, res, chain: Promise.resolve(), pending: 0, seen: new Set(), closed: false, timer: null };
  subs.add(sub);
  res.on("close", () => close(sub));
  res.on("error", () => close(sub));
  if (req && req.socket) req.socket.setTimeout(0);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  write(sub, "retry: 5000\n: connected\n\n");
  if (Number.isSafeInteger(lastEventId) && lastEventId >= 0) enqueue(sub, () => replay(sub, lastEventId));
  sub.timer = setInterval(() => {
    enqueue(sub, async () => {
      if (!(await recheck(sub))) return close(sub);
      write(sub, `: heartbeat ${Date.now()}\n\n`);
    });
  }, c.heartbeatMs);
  if (sub.timer.unref) sub.timer.unref();
  return sub;
}

/**
 * Fan-out of one event; call AFTER the transaction committed. Never throws and never waits: each stream re-checks access on its own.
 * @param {{kind: string, conversation_id: number, message_id?: number|null, user_id?: number|null}} ev
 */
function publish(ev) {
  try {
    if (!ev || !KINDS.has(ev.kind)) throw new Error("invalid chat event kind");
    const conversation_id = Number(ev.conversation_id);
    if (!Number.isSafeInteger(conversation_id) || conversation_id <= 0) throw new Error("invalid conversation id");
    const message_id = ev.message_id === undefined || ev.message_id === null ? null : Number(ev.message_id);
    if (ev.kind === "message" && !(Number.isSafeInteger(message_id) && message_id > 0)) throw new Error("message event needs a message id");
    const out = { kind: ev.kind, conversation_id, message_id, user_id: ev.user_id === undefined ? null : ev.user_id };
    for (const sub of [...subs]) {
      if (out.user_id !== null && out.user_id !== sub.user.id) continue;
      enqueue(sub, () => deliver(sub, out));
    }
  } catch (err) {
    console.error("chat events: publish failed:", err && err.message);
  }
}

/** Closes every stream (graceful shutdown, tests). */
function shutdown() {
  for (const sub of [...subs]) close(sub);
}

const stats = () => ({ subscribers: subs.size });
/** Test helper: resolves when every queued delivery has been processed. */
const idle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.all([...subs].map((s) => s.chain));
};

module.exports = { subscribe, publish, shutdown, stats, idle, LimitError };
