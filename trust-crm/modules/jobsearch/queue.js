// Minimal durable work queue over js_queue. Interface (Task 7, extended in Task 11):
//   enqueue({kind, payload, runAt?, idempotencyKey?, client?}) -> job row (a repeated key returns the existing row)
//   claim(kinds, n, {now?}) -> jobs (FOR UPDATE SKIP LOCKED)   complete(id)   fail(id, err)
//   work(handlers, {kinds?, batch?|n?, loop?, now?})            reclaimStale({olderThanMs?, now?})
// Statuses: pending | running | done | failed | cancelled. Failures back off 2^attempts * 30s,
// up to max_attempts (5), then become 'failed'. `attempts` is counted at claim time, so a crashed
// worker's item that is reclaimed keeps the attempt it used.
const db = () => require("../../db");

const STALE_LOCK_MS = 15 * 60 * 1000;
// A handler may return {[RESCHEDULE]: Date, payload?}: the item (payload replaced when given) goes back to 'pending' at that time WITHOUT
// consuming an attempt (e.g. a per-source rate limit: the work was not done, nothing failed).
const RESCHEDULE = Symbol("jobsearch.queue.reschedule");

function validDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
}

/**
 * @param {{kind: string, payload?: object, runAt?: Date, idempotencyKey?: string, client?: object}} job
 * @param {{client?: object}} [opts] run inside the caller's transaction (client may also be given in `job`)
 */
async function enqueue({ kind, payload = {}, runAt, idempotencyKey, client } = {}, opts = {}) {
  if (!kind || typeof kind !== "string") throw new Error("queue kind is required");
  const c = opts.client || client || db();
  const ins = await c.query(
    `INSERT INTO js_queue (kind, payload, run_at, idempotency_key) VALUES ($1,$2::jsonb,COALESCE($3, now()),$4)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [kind, JSON.stringify(payload), runAt || null, idempotencyKey || null]
  );
  if (ins.rowCount) return ins.rows[0];
  return (await c.query("SELECT * FROM js_queue WHERE idempotency_key = $1", [idempotencyKey])).rows[0];
}

async function claim(kinds, n = 1, { now } = {}) {
  const at = validDate(now);
  const r = await db().query(
    `UPDATE js_queue SET status = 'running', locked_at = COALESCE($3::timestamptz, now()), attempts = attempts + 1
      WHERE id IN (SELECT id FROM js_queue WHERE status = 'pending' AND kind = ANY($1::text[]) AND run_at <= COALESCE($3::timestamptz, now())
                    ORDER BY run_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [kinds, n, at]
  );
  return r.rows;
}

async function complete(id) {
  await db().query("UPDATE js_queue SET status = 'done', locked_at = NULL WHERE id = $1 AND status = 'running'", [id]);
}

async function fail(id, err) {
  const message = String((err && err.message) || err || "error").slice(0, 500);
  await db().query(
    `UPDATE js_queue SET last_error = $2, locked_at = NULL,
            status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            run_at = CASE WHEN attempts >= max_attempts THEN run_at ELSE now() + (power(2, attempts) * 30) * interval '1 second' END
      WHERE id = $1 AND status = 'running'`,
    [id, message]
  );
}

/** Back to 'pending' at `runAt`, giving back the attempt the claim counted. */
async function reschedule(id, runAt, payload) {
  await db().query(
    `UPDATE js_queue SET status = 'pending', locked_at = NULL, run_at = $2, attempts = GREATEST(attempts - 1, 0),
            payload = COALESCE($3::jsonb, payload) WHERE id = $1 AND status = 'running'`,
    [id, runAt, payload && typeof payload === "object" ? JSON.stringify(payload) : null]
  );
}

/**
 * Stale-lock sweep: items left 'running' by a crashed worker (locked_at older than olderThanMs) go
 * back to 'pending' (their claim already counted an attempt), or to 'failed' once attempts reached
 * max_attempts. Handlers must be safe to re-run (the submit handler never re-sends: see submitter).
 * @returns {Promise<{reclaimed: number, failed: number, ids: number[]}>}
 */
async function reclaimStale({ olderThanMs = STALE_LOCK_MS, now } = {}) {
  const at = validDate(now);
  const ms = Number.isFinite(Number(olderThanMs)) && Number(olderThanMs) >= 0 ? Number(olderThanMs) : STALE_LOCK_MS;
  const r = await db().query(
    `UPDATE js_queue SET locked_at = NULL,
            status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            last_error = left('stale_lock_reclaimed' || COALESCE(': ' || last_error, ''), 500)
      WHERE id IN (SELECT id FROM js_queue WHERE status = 'running' AND locked_at IS NOT NULL
                     AND locked_at < COALESCE($1::timestamptz, now()) - ($2::double precision * interval '1 millisecond')
                   FOR UPDATE SKIP LOCKED)
      RETURNING id, status`,
    [at, ms]
  );
  return { reclaimed: r.rows.filter((x) => x.status === "pending").length, failed: r.rows.filter((x) => x.status === "failed").length, ids: r.rows.map((x) => Number(x.id)) };
}

/**
 * Claims and runs one batch; with {loop:true} keeps going until nothing is due (or `max` items ran).
 * A handler that returns normally completes the item; a throw goes through fail() (backoff).
 * @param {Object<string, Function>} handlers kind -> async (job) => any
 * @param {{kinds?: string[], batch?: number, n?: number, loop?: boolean, now?: Date, max?: number}} [opts]
 * @returns {Promise<number>} items processed
 */
async function work(handlers, { kinds, batch, n, loop = false, now, max } = {}) {
  const size = Number.isInteger(batch) && batch > 0 ? batch : Number.isInteger(n) && n > 0 ? n : 10;
  const allowed = (Array.isArray(kinds) && kinds.length ? kinds : Object.keys(handlers)).filter((k) => typeof handlers[k] === "function");
  const cap = Number.isInteger(max) && max > 0 ? max : Infinity;
  let processed = 0;
  if (!allowed.length) return 0;
  for (;;) {
    const jobs = await claim(allowed, Math.min(size, cap - processed), { now });
    if (!jobs.length) return processed;
    for (const job of jobs) {
      try {
        const out = await handlers[job.kind](job);
        const at = out && typeof out === "object" ? validDate(out[RESCHEDULE]) : null;
        if (at) await reschedule(job.id, at, out.payload);
        else await complete(job.id);
      } catch (err) {
        await fail(job.id, err);
      }
      processed += 1;
    }
    if (!loop || processed >= cap) return processed;
  }
}

module.exports = { enqueue, claim, complete, fail, reschedule, work, reclaimStale, STALE_LOCK_MS, RESCHEDULE };
