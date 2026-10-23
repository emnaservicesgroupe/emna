// Realtime job-search events over SSE (Task 14).
//
//   publish(candidateId, kind, payload, audience = 'candidate', {userId?, client?})
//       persists a js_events row (the durable log; replay by Last-Event-ID). Delivery happens from the
//       shared poller, exactly like rows written directly by other modules.
//   subscribe(req, res)   attaches an SSE stream for req.user (route GET /jobsearch/events)
//
// Delivery model: ONE shared poller (not one query per connection) reads js_events with id > cursor
// every JOBSEARCH_SSE_POLL_MS (2 s) while at least one stream is open, and hands each row to every
// subscriber whose CURRENT scope allows it:
//   Candidate -> own candidate_id AND audience = 'candidate' (never 'staff')
//   staff     -> candidate_id in their assigned (non-deleted) candidates, audience staff|candidate,
//                plus staff events with no candidate addressed to them (user_id = me)
//   admin     -> everything (incl. unscoped system events with candidate_id NULL)
// Each subscriber's scope (assigned candidates, is_active, role, token_version) is re-read from the DB at
// most every JOBSEARCH_SSE_RECHECK_MS (60 s); a suspended/revoked/role-changed user's stream is closed and
// a reassignment takes effect at the next re-check. Payloads are reduced to neutral whitelisted fields.
// Out-of-order commits of bigserial ids: a 50-id look-back window + per-stream dedupe catches rows that
// commit slightly late. A row that commits later than that (or with an id at/below the stream's
// connect-time head) is NEVER delivered on that stream - and Last-Event-ID replay will not return it either
// once the client has seen a higher id. It is lost for live delivery, not deferred: clients must treat
// events as change hints and refetch state (on connect, on reconnect and periodically).
// Streams whose response is destroyed/ended, or whose unsent buffer exceeds JOBSEARCH_SSE_MAX_BUFFER_BYTES
// (256 KiB; a stalled reader), are closed and unregistered by the poller.
const { candidateScopeSql, isAdmin } = require("./scope");

const db = () => require("../../db");

const envInt = (k, d) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const cfg = () => ({
  pollMs: envInt("JOBSEARCH_SSE_POLL_MS", 2000),
  recheckMs: envInt("JOBSEARCH_SSE_RECHECK_MS", 60000),
  heartbeatMs: envInt("JOBSEARCH_SSE_HEARTBEAT_MS", 25000),
  maxPerUser: envInt("JOBSEARCH_SSE_MAX_PER_USER", 3),
  maxTotal: envInt("JOBSEARCH_SSE_MAX_TOTAL", 500),
  maxBuffer: envInt("JOBSEARCH_SSE_MAX_BUFFER_BYTES", 256 * 1024),
  batch: envInt("JOBSEARCH_SSE_BATCH", 500),
});
const REPLAY_LIMIT = 500;
const LOOKBACK = 50; // ids re-read each poll to catch rows whose transaction committed late
const DEDUPE = 1000;

// ---------------------------------------------------------------- payload whitelist

const KIND_RE = /^[a-z][a-z0-9_.]{0,59}$/;
const STATUS_RE = /^[a-z_]{1,40}$/;
// Neutral fields per kind; anything not listed is dropped. Default: applicationId + status.
const BASE = ["applicationId", "status"];
const KIND_FIELDS = {
  "application.status_changed": ["applicationId", "from", "to"],
  "application.created": ["applicationId"],
  "application.prepared": ["applicationId", "status"],
  "application.approved": ["applicationId"],
  "application.update": ["applicationId"],
  "application.message_shared": ["applicationId", "messageId"],
  "submission.queued": ["applicationId", "submissionId", "status"],
  "submission.sent": ["applicationId", "submissionId", "status"],
  "submission.confirmed": ["applicationId", "submissionId", "status"],
  "submission.failed": ["applicationId", "submissionId", "status"],
  "submission.outcome_unknown": ["applicationId", "submissionId", "status"],
  "submission.blocked": ["applicationId", "submissionId", "status"],
  "interview.proposed": ["applicationId", "appointmentId", "status"],
  "interview.confirmed": ["applicationId", "appointmentId", "status"],
  "interview.cancelled": ["applicationId", "appointmentId", "status"],
  "interview.rescheduled": ["applicationId", "appointmentId", "status"],
  "sharing.granted": ["applicationId"],
  "sharing.revoked": ["applicationId"],
};
const STAFF_EXTRA = ["messageId", "taskId", "submissionId", "appointmentId"];
const ID_FIELDS = new Set(["applicationId", "messageId", "taskId", "submissionId", "appointmentId"]);

function neutralPayload(kind, payload, staff) {
  const allowed = new Set([...(KIND_FIELDS[kind] || BASE), ...(staff ? STAFF_EXTRA : [])]);
  const out = {};
  const src = payload && typeof payload === "object" ? payload : {};
  for (const k of allowed) {
    let v = src[k];
    if (v === undefined && k === "appointmentId") v = src.interviewId;
    if (v === undefined || v === null) continue;
    if (ID_FIELDS.has(k)) {
      const n = Number(v);
      if (Number.isSafeInteger(n) && n > 0) out[k] = n;
    } else if (typeof v === "string" && STATUS_RE.test(v)) out[k] = v;
  }
  return out;
}

function frame(row, staff) {
  const data = { id: Number(row.id), kind: row.kind, at: new Date(row.created_at).toISOString(), ...neutralPayload(row.kind, row.payload, staff) };
  return `id: ${Number(row.id)}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------- subscribers

const subs = new Set();
// Test-only injection points (e.g. a delay inside the connect window).
const hooks = { beforeRefresh: null };
let timer = null;
let polling = false;
let cursor = null; // highest js_events.id the poller has read

function staffish(sub) {
  return sub.user.role !== "Candidate";
}

function allowed(sub, row) {
  if (!KIND_RE.test(row.kind || "")) return false;
  if (sub.admin) return true;
  const cid = row.candidate_id === null || row.candidate_id === undefined ? null : Number(row.candidate_id);
  if (sub.user.role === "Candidate") return cid !== null && cid === sub.ownCandidate && row.audience === "candidate";
  if (cid === null) return row.audience === "staff" && Number(row.user_id) === sub.user.id;
  return sub.candidates.has(cid) && (row.audience === "staff" || row.audience === "candidate");
}

/** Re-reads the user's account and scope. Returns false when the stream must close. */
async function refresh(sub) {
  const u = (await db().query("SELECT is_active, token_version, role FROM users WHERE id = $1", [sub.user.id])).rows[0];
  if (!u || !u.is_active || u.role !== sub.user.role) return false;
  if (sub.user.tv !== undefined && u.token_version !== sub.user.tv) return false;
  sub.admin = isAdmin(sub.user);
  if (!sub.admin) {
    const { clause, params } = candidateScopeSql(sub.user, "c", 0);
    const ids = (await db().query(`SELECT c.id FROM candidates c WHERE c.is_deleted = false AND ${clause}`, params)).rows.map((r) => r.id);
    sub.candidates = new Set(ids);
    if (sub.user.role === "Candidate") {
      sub.ownCandidate = ids.length === 1 ? ids[0] : null;
      if (sub.ownCandidate === null) return false;
    }
  }
  sub.checkedAt = Date.now();
  return true;
}

/** The client went away (abort during connect, network drop) or the response is finished. */
function gone(sub) {
  const { res, req } = sub;
  return sub.closed || res.destroyed || res.writableEnded || Boolean(req && req.socket && req.socket.destroyed);
}

function write(sub, text) {
  if (sub.closed) return;
  if (gone(sub)) {
    close(sub);
    return;
  }
  try {
    sub.res.write(text);
    sub.lastWrite = Date.now();
  } catch {
    close(sub);
  }
}

function deliver(sub, row) {
  const id = Number(row.id);
  if (id <= sub.floor || sub.seen.has(id)) return;
  // Every row is judged ONCE per stream (allowed or not): a row re-read through the look-back window
  // after a scope change is never delivered late, so delivery for a newly assigned candidate starts
  // with events created after the re-check.
  sub.seen.add(id);
  if (sub.seen.size > DEDUPE) sub.seen.delete(sub.seen.values().next().value);
  if (!allowed(sub, row)) return;
  write(sub, frame(row, staffish(sub)));
}

function close(sub) {
  if (sub.closed) return;
  sub.closed = true;
  subs.delete(sub);
  try {
    // A stalled reader's backlog would never drain through end(): drop the connection instead.
    if (sub.res.destroyed || sub.res.writableLength > 0) sub.res.destroy();
    else sub.res.end();
  } catch {
    /* already gone */
  }
  if (!subs.size) stopPoller();
}

function startPoller() {
  if (timer) return;
  const run = async () => {
    timer = null;
    if (!subs.size) return;
    if (!polling) {
      polling = true;
      try {
        await tick();
      } catch (err) {
        console.error("jobsearch events: poll failed:", err && err.code, err && err.message);
      } finally {
        polling = false;
      }
    }
    if (subs.size && !timer) {
      timer = setTimeout(run, cfg().pollMs);
      if (timer.unref) timer.unref();
    }
  };
  timer = setTimeout(run, cfg().pollMs);
  if (timer.unref) timer.unref();
}

function stopPoller() {
  if (timer) clearTimeout(timer);
  timer = null;
  cursor = null;
}

/** One poll: due re-checks first (so revocations/reassignments apply before delivery), then new rows, then heartbeats. */
async function tick() {
  const c = cfg();
  const now = Date.now();
  for (const sub of [...subs]) {
    if (sub.closed || now - sub.checkedAt < c.recheckMs) continue;
    let ok = false;
    try {
      ok = await refresh(sub);
    } catch (err) {
      console.error("jobsearch events: re-check failed:", err && err.code, err && err.message);
      ok = false;
    }
    if (!ok) close(sub);
  }
  // Dead or stalled streams: a destroyed/ended response emits nothing on write, so sweep explicitly;
  // a reader that stopped reading lets the unsent buffer grow - close it before it grows unbounded.
  for (const sub of [...subs]) {
    if (gone(sub) || sub.res.writableLength > c.maxBuffer) close(sub);
  }
  if (!subs.size) return;
  if (cursor === null) cursor = await maxId();
  const from = Math.max(0, cursor - LOOKBACK);
  const rows = (await db().query("SELECT id, candidate_id, kind, payload, audience, user_id, created_at FROM js_events WHERE id > $1 ORDER BY id LIMIT $2", [from, c.batch + LOOKBACK])).rows;
  for (const row of rows) {
    const id = Number(row.id);
    if (id > cursor) cursor = id;
    for (const sub of [...subs]) deliver(sub, row);
  }
  const t = Date.now();
  for (const sub of [...subs]) if (t - sub.lastWrite >= c.heartbeatMs) write(sub, `: heartbeat ${t}\n\n`);
}

async function maxId() {
  return Number((await db().query("SELECT COALESCE(max(id), 0) AS n FROM js_events")).rows[0].n);
}

/** Replay rows after `lastId` (newest 500 at most), filtered in SQL by scope AND audience. */
async function replay(sub, lastId) {
  const p = [lastId];
  let where;
  if (sub.admin) where = "TRUE";
  else if (sub.user.role === "Candidate") {
    p.push(sub.ownCandidate);
    where = `e.candidate_id = $2 AND e.audience = 'candidate'`;
  } else {
    const { clause, params } = candidateScopeSql(sub.user, "c", 1);
    p.push(...params);
    p.push(sub.user.id);
    where = `((e.audience IN ('staff','candidate') AND EXISTS (SELECT 1 FROM candidates c WHERE c.id = e.candidate_id AND c.is_deleted = false AND ${clause}))
              OR (e.candidate_id IS NULL AND e.audience = 'staff' AND e.user_id = $${p.length}))`;
  }
  const rows = (await db().query(
    `SELECT * FROM (SELECT e.id, e.candidate_id, e.kind, e.payload, e.audience, e.user_id, e.created_at FROM js_events e
       WHERE e.id > $1 AND ${where} ORDER BY e.id DESC LIMIT ${REPLAY_LIMIT}) x ORDER BY id`,
    p
  )).rows;
  for (const row of rows) deliver(sub, row); // allowed() re-applies the same rule in memory
}

class LimitError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Opens an SSE stream on `res` for `user`. Throws LimitError(429/503) before writing anything when
 * the per-user or total connection cap is reached.
 */
async function subscribe({ user, req, res, lastEventId }) {
  const c = cfg();
  const sub = { user, req, res, candidates: new Set(), ownCandidate: null, admin: false, checkedAt: 0, lastWrite: Date.now(), floor: 0, seen: new Set(), closed: false };
  // Listeners BEFORE any await: a client that aborts while we query the DB is cleaned up. verifyToken
  // already awaited before we got here, so 'close' may have fired already -> also check gone() after
  // every await and give the slot back.
  res.on("close", () => close(sub));
  res.on("error", () => close(sub));
  if (gone(sub)) {
    close(sub);
    return null;
  }
  if (subs.size >= c.maxTotal) throw new LimitError(503, "Too many event streams; try again later");
  if ([...subs].filter((s) => s.user.id === user.id).length >= c.maxPerUser) throw new LimitError(429, `At most ${c.maxPerUser} event streams per user`);
  if (hooks.beforeRefresh) await hooks.beforeRefresh(sub);
  const ok = await refresh(sub);
  if (gone(sub)) {
    close(sub);
    return null;
  }
  if (!ok) throw new LimitError(401, "Session expired");
  // Re-count after the awaits (another connect may have interleaved), then reserve the slot.
  if (subs.size >= c.maxTotal) throw new LimitError(503, "Too many event streams; try again later");
  if ([...subs].filter((s) => s.user.id === user.id).length >= c.maxPerUser) throw new LimitError(429, `At most ${c.maxPerUser} event streams per user`);
  subs.add(sub);
  if (req && req.socket) req.socket.setTimeout(0);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  write(sub, `retry: 5000\n: connected\n\n`);
  try {
    const head = await maxId();
    if (gone(sub)) {
      close(sub);
      return null;
    }
    if (Number.isSafeInteger(lastEventId) && lastEventId >= 0) {
      await replay(sub, lastEventId);
      if (gone(sub)) {
        close(sub);
        return null;
      }
    }
    // Everything up to `head` that this stream should see has now been replayed (or deliberately
    // skipped when no Last-Event-ID was sent); live delivery starts after it.
    sub.floor = Math.max(sub.floor, head);
    if (cursor === null || cursor > head) cursor = head;
  } catch (err) {
    console.error("jobsearch events: replay failed:", err && err.code, err && err.message);
    close(sub);
    return null;
  }
  startPoller();
  return sub;
}

/**
 * Persists an event (the poller delivers it). audience: 'candidate' (default) | 'staff'.
 * @returns {Promise<{id: number}>}
 */
async function publish(candidateId, kind, payload = {}, audience = "candidate", opts = {}) {
  if (!KIND_RE.test(String(kind))) throw new Error("eventsHub.publish: invalid kind");
  if (audience !== "candidate" && audience !== "staff") throw new Error("eventsHub.publish: audience must be candidate or staff");
  const cid = candidateId === null || candidateId === undefined ? null : Number(candidateId);
  if (cid !== null && !(Number.isSafeInteger(cid) && cid > 0)) throw new Error("eventsHub.publish: invalid candidateId");
  const uid = Number.isSafeInteger(opts.userId) ? opts.userId : null;
  const r = await (opts.client || db()).query(
    "INSERT INTO js_events (candidate_id, kind, payload, audience, user_id) VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING id",
    [cid, kind, JSON.stringify(payload || {}), audience, uid]
  );
  return { id: Number(r.rows[0].id) };
}

/** Closes every stream and stops the poller (tests / shutdown). */
function shutdown() {
  for (const sub of [...subs]) close(sub);
  stopPoller();
}

const stats = () => ({ subscribers: subs.size, polling: Boolean(timer) });
/** Test helpers: per-stream last scope re-check time; connect-window hook. */
const subscribers = () => [...subs].map((x) => ({ userId: x.user.id, checkedAt: x.checkedAt }));
const _setHooks = (h = {}) => {
  hooks.beforeRefresh = typeof h.beforeRefresh === "function" ? h.beforeRefresh : null;
};

module.exports = { publish, subscribe, shutdown, stats, neutralPayload, LimitError, _internal: { tick, allowed, subscribers, setHooks: _setHooks } };
