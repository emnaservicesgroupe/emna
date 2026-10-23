// Minimal durable work queue over js_queue. Task 11 extends this file; keep the interface:
//   enqueue({kind, payload, runAt?, idempotencyKey?}) -> job row (a repeated key returns the existing row)
//   claim(kinds, n) -> jobs (FOR UPDATE SKIP LOCKED)   complete(id)   fail(id, err)   work(handlers)
// Statuses: pending | running | done | failed | cancelled. Failures back off 2^attempts * 30s,
// up to max_attempts (5), then become 'failed'.
const db = () => require("../../db");

async function enqueue({ kind, payload = {}, runAt, idempotencyKey } = {}) {
  if (!kind || typeof kind !== "string") throw new Error("queue kind is required");
  const ins = await db().query(
    `INSERT INTO js_queue (kind, payload, run_at, idempotency_key) VALUES ($1,$2::jsonb,COALESCE($3, now()),$4)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [kind, JSON.stringify(payload), runAt || null, idempotencyKey || null]
  );
  if (ins.rowCount) return ins.rows[0];
  return (await db().query("SELECT * FROM js_queue WHERE idempotency_key = $1", [idempotencyKey])).rows[0];
}

async function claim(kinds, n = 1) {
  const r = await db().query(
    `UPDATE js_queue SET status = 'running', locked_at = now(), attempts = attempts + 1
      WHERE id IN (SELECT id FROM js_queue WHERE status = 'pending' AND kind = ANY($1::text[]) AND run_at <= now()
                    ORDER BY run_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [kinds, n]
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

/** Claims and runs one batch; with {loop:true} keeps going until nothing is due. Returns jobs processed. */
async function work(handlers, { n = 10, loop = false } = {}) {
  let processed = 0;
  for (;;) {
    const jobs = await claim(Object.keys(handlers), n);
    if (!jobs.length) return processed;
    for (const job of jobs) {
      try {
        await handlers[job.kind](job);
        await complete(job.id);
      } catch (err) {
        await fail(job.id, err);
      }
      processed += 1;
    }
    if (!loop) return processed;
  }
}

module.exports = { enqueue, claim, complete, fail, work };
