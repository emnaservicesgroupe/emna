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
//   - FAN-OUT COST: publish resolves the recipients of an event ONCE, with a single SQL query (scope.subscriberAccess) over all subscribed
//     users: per user whether the account is still live (active, same role, same token_version, live candidate / non-suspended organisation)
//     and whether the conversation is in their scope (the rules of scope.conversationVisibleSql). Only the streams of visible users are
//     queued for delivery; a stream whose account is no longer live is closed at once; everybody else costs nothing. The cost of the
//     visibility step is O(1) queries per event, whatever the number of streams.
//   - a queued delivery re-reads the account of ITS stream (resolveActor + token_version) at most every CHAT_SSE_RECHECK_MS (default 5000) - a
//     per-stream cache; the heartbeat ALWAYS re-reads it (no cache), and the replay at connect time too. Because the batch query reads the
//     current state on every event, a revocation never lets an event through; the cache only bounds the extra per-stream queries.
//   - replay for Last-Event-ID is derived from chat_messages (ids greater than the last one PLUS lower ids created within 2 minutes before it, because
//     ids are assigned at INSERT and may commit out of order; only conversations visible to the actor, newest 200, ascending), so no events table
//     exists and clients dedupe by message id; a hidden message replays as kind 'hidden' (ids only). Non-message events are not replayed: clients refetch on reconnect.
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
  recheckMs: envInt("CHAT_SSE_RECHECK_MS", 5000),
});
const REPLAY_LIMIT = 200;
const REPLAY_OVERLAP = "2 minutes"; // late commits: see replay()
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

let clock = () => Date.now();

/**
 * Re-reads the account: active, same role, same token_version (logout / suspension bump it), live candidate / organisation, current
 * permissions. Returns the fresh actor, or null when the stream must close. Always queries; see recheckCached.
 */
async function recheck(sub) {
  try {
    const actor = await scope.resolveActor(db, { id: sub.user.id, role: sub.user.role });
    if (sub.user.tv !== undefined) {
      const r = await db.query("SELECT token_version FROM users WHERE id = $1", [sub.user.id]);
      if (r.rowCount === 0 || r.rows[0].token_version !== sub.user.tv) return null;
    }
    sub.actor = actor;
    sub.checkedAt = clock();
    return actor;
  } catch (err) {
    if (!(err && (err.status === 401 || err.status === 403))) console.error("chat events: access re-check failed:", err && err.code, err && err.message);
    return null; // revoked, or unable to prove access -> close (the client reconnects and replays)
  }
}

/** The per-stream account re-check at delivery time: reuses the last positive result for CHAT_SSE_RECHECK_MS. */
async function recheckCached(sub) {
  if (sub.actor && sub.checkedAt !== null && clock() - sub.checkedAt < cfg().recheckMs && clock() >= sub.checkedAt) return sub.actor;
  return recheck(sub);
}

/** Delivers one live event to one stream (runs inside the stream's serial chain). The caller already proved that the user may see the conversation. */
async function deliver(sub, ev) {
  if (sub.closed) return;
  const actor = await recheckCached(sub);
  if (!actor) return close(sub);
  if (gone(sub)) return close(sub);
  if (ev.kind === "message") {
    if (sub.seen.has(ev.message_id)) return; // already sent by the replay
    sub.seen.add(ev.message_id);
    if (sub.seen.size > DEDUPE) sub.seen.delete(sub.seen.values().next().value);
  }
  write(sub, frame(ev));
}

async function replay(sub, lastId) {
  const actor = await recheck(sub);
  if (!actor) return close(sub);
  const sc = scope.conversationVisibleSql(actor, "c", 1);
  // Ids are assigned at INSERT, not at COMMIT, so a lower id can become visible AFTER a higher one was already delivered. The replay therefore
  // also returns messages with id <= lastId that are at most REPLAY_OVERLAP older than the last one the client saw; the client dedupes by id.
  const rows = (
    await db.query(
      `SELECT * FROM (
         SELECT m.id, m.conversation_id, (m.hidden_at IS NOT NULL) AS hidden
           FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
          WHERE (m.id > $1 OR (m.id <= $1 AND m.created_at >= (SELECT l.created_at FROM chat_messages l WHERE l.id = $1) - interval '${REPLAY_OVERLAP}'))
            AND ${sc.clause} ORDER BY m.id DESC LIMIT ${REPLAY_LIMIT}) x
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
  const sub = { user, actor, checkedAt: clock(), req, res, chain: Promise.resolve(), pending: 0, seen: new Set(), closed: false, timer: null };
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

// Fan-outs run one after the other so that the events of one stream keep the order in which they were published.
let fanout = Promise.resolve();

async function distribute(ev, targets) {
  const live = targets.filter((sub) => !sub.closed);
  if (live.length === 0) return;
  let access;
  try {
    access = await scope.subscriberAccess(db, ev.conversation_id, live.map((sub) => ({ id: sub.user.id, role: sub.user.role, tv: sub.user.tv })));
  } catch (err) {
    console.error("chat events: recipient resolution failed:", err && err.code, err && err.message);
    for (const sub of live) close(sub); // unable to prove access -> close (the clients reconnect and replay)
    return;
  }
  for (const sub of live) {
    const a = access.get(scope.subscriberKey({ id: sub.user.id, tv: sub.user.tv }));
    if (!a || !a.live) close(sub); // revoked / deactivated / suspended / logged out
    else if (a.visible) enqueue(sub, () => deliver(sub, ev));
  }
}

/**
 * Fan-out of one event; call AFTER the transaction committed. Never throws and never waits: the recipients are resolved once, in one query.
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
    const targets = [...subs].filter((sub) => out.user_id === null || out.user_id === sub.user.id);
    if (targets.length === 0) return;
    fanout = fanout
      .then(() => distribute(out, targets))
      .catch((err) => console.error("chat events: fan-out failed:", err && err.message));
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
  for (let i = 0; i < 5; i += 1) {
    await fanout;
    await Promise.all([...subs].map((s) => s.chain));
  }
};
/** Test hooks: forget every cached account re-check (the next delivery re-reads the account), and replace the clock (ms) used for the cache. */
const clearRecheckCache = () => {
  for (const sub of subs) sub.checkedAt = null;
};
const setClock = (fn) => {
  clock = typeof fn === "function" ? fn : () => Date.now();
};

module.exports = { subscribe, publish, shutdown, stats, idle, clearRecheckCache, setClock, LimitError };
