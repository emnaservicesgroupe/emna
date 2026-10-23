// Job-search scheduler (Task 12): search -> match -> prepare -> (approve | auto-approve) -> queue -> send.
//
//   tick(now, {deps?}) -> TickSummary   one bounded, deterministic pass (injectable clock + adapters).
//                                       Every step is isolated: a failing step is recorded in
//                                       summary.errors and never stops later steps; tick never throws.
//   guardedTick(now, {deps?})           tick under a Postgres session advisory lock (19028, 1) held on a
//                                       pinned connection, so only one process ticks at a time.
//   startJobSearchScheduler()           node-cron every minute -> guardedTick(new Date()); also starts the
//                                       queue workers. Off when JOBSEARCH_SCHEDULER=off or NODE_ENV=test.
//
// Safety (binding rulings, constraints.md): the scheduler never approves through transition(); the only
// non-human approval is applicationService.autoApprove, attempted ONLY when autoApproveEligibility
// allows it (deny-by-default incl. the employer-support label ruling). Everything else stays at
// ready_for_review with ONE open 'needs_human_approval' task. Queueing uses submitter.queueSubmission
// with no actor (SYSTEM_GRANT inside the submitter); the pre-send guard runs again at send time.
// Refusals back off >= 6 h (recorded in js_audit_events as 'scheduler.retry_deferred'), so a refused
// application is never retried every tick. Every automatic action is audited as 'system:scheduler'.
const cron = require("node-cron");
const { HttpError } = require("./httpError");
const queue = require("./queue");
const registry = require("./sources");
const searchRunner = require("./searchRunner");
const matchService = require("./matchService");
const consentService = require("./consentService");
const applicationService = require("./applicationService");
const submitter = require("./submitter");
const jobStore = require("./jobStore");

const db = () => require("../../db");

const ACTOR = "system:scheduler";
const DEFAULT_SCHEDULE = "0 */6 * * *";
const LOCK_KEY = [19028, 1];
const STATE_KEY = "scheduler_last_tick";
const CURSOR_KEY = "scheduler_candidate_cursor";
const HOUR_MS = 3600 * 1000;
const MIN_BACKOFF_HOURS = 6;
const { SCHEDULER_GRANT, sendBlockers } = applicationService._internal;
const HOLD_CODES = new Set(["candidate_paused", "module_paused", "source_paused"]);
const CLOSABLE = ["matched", "preparing", "ready_for_review"];

// ---------------------------------------------------------------- minimal 5-field cron evaluator (UTC)
// Fields: minute hour day-of-month month day-of-week. Each: '*', a number, a range a-b, a list a,b,c,
// and steps (*/n, a-b/n, a/n = a..max step n). Day-of-week 0-7 (0 and 7 = Sunday). Names (jan, sun) are
// not supported (invalid). When both day-of-month and day-of-week are restricted (neither starts with
// '*'), a day matches if EITHER does; otherwise both must match (so '*/2' steps still apply).
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dom", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dow", min: 0, max: 7 },
];

function parseField(text, { name, min, max }) {
  const set = new Set();
  const int = (s) => {
    if (!/^\d{1,2}$/.test(s)) throw new Error(`invalid ${name} value '${s}'`);
    const n = Number(s);
    if (n < min || n > max) throw new Error(`${name} value ${n} out of range ${min}-${max}`);
    return n;
  };
  for (const part of text.split(",")) {
    const m = /^([^/]+)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw new Error(`invalid ${name} field '${text}'`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!(step >= 1)) throw new Error(`invalid ${name} step in '${part}'`);
    let lo;
    let hi;
    if (m[1] === "*") [lo, hi] = [min, max];
    else if (m[1].includes("-")) {
      const [a, b, extra] = m[1].split("-");
      if (extra !== undefined) throw new Error(`invalid ${name} range '${m[1]}'`);
      [lo, hi] = [int(a), int(b)];
      if (lo > hi) throw new Error(`invalid ${name} range '${m[1]}'`);
    } else {
      lo = int(m[1]);
      hi = m[2] === undefined ? lo : max;
    }
    for (let v = lo; v <= hi; v += step) set.add(name === "dow" && v === 7 ? 0 : v);
  }
  return { set, any: text.startsWith("*") };
}

/** @returns {{minute, hour, dom, month, dow}} parsed fields; throws on an invalid expression */
function parseCron(expr) {
  if (typeof expr !== "string") throw new Error("cron expression must be a string");
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron expression needs 5 fields, got ${parts.length}`);
  const out = {};
  FIELDS.forEach((f, i) => { out[f.name] = parseField(parts[i], f); });
  return out;
}

function dayMatches(c, d) {
  // Vixie-cron rule: a field starting with '*' ('*' or '*/n') is a "star" field. If either field is a
  // star, BOTH sets must match (the step of '*/n' still applies); only when both are restricted lists /
  // ranges does a day match if EITHER does.
  const domOk = c.dom.set.has(d.getUTCDate());
  const dowOk = c.dow.set.has(d.getUTCDay());
  if (c.dom.any || c.dow.any) return domOk && dowOk;
  return domOk || dowOk;
}

function cronMatches(expr, date) {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  return c.minute.set.has(date.getUTCMinutes()) && c.hour.set.has(date.getUTCHours()) && c.month.set.has(date.getUTCMonth() + 1) && dayMatches(c, date);
}

/** Latest fire time <= now (minute precision, UTC), or null when none within ~5 years. */
function previousFire(expr, now) {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  let t = Math.floor(now.getTime() / 60000) * 60000;
  const floor = t - 5 * 366 * 86400000;
  while (t >= floor) {
    const d = new Date(t);
    if (!c.month.set.has(d.getUTCMonth() + 1)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 60000;
    } else if (!dayMatches(c, d)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 60000;
    } else if (!c.hour.set.has(d.getUTCHours())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()) - 60000;
    } else if (!c.minute.set.has(d.getUTCMinutes())) {
      t -= 60000;
    } else return d;
  }
  return null;
}

/** A source is due when it never ran, or a scheduled fire time passed after its last run. */
function isDue(expr, lastRunAt, now) {
  const c = parseCron(expr || DEFAULT_SCHEDULE);
  if (!lastRunAt) return true;
  const prev = previousFire(c, now);
  return Boolean(prev && prev.getTime() > new Date(lastRunAt).getTime());
}

// ---------------------------------------------------------------- helpers

function envInt(name, dflt, min = 0) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= min ? n : dflt;
}

function limits(over = {}) {
  return {
    applicationsPerTick: envInt("APPLICATIONS_PER_TICK", 5, 0),
    minScore: Math.min(100, envInt("MATCH_AUTO_PREPARE_MIN", 60, 0)),
    recheckHours: envInt("JOB_RECHECK_HOURS", 24, 1),
    queueBatch: envInt("SCHEDULER_QUEUE_BATCH", 50, 1),
    recheckBatch: envInt("SCHEDULER_RECHECK_BATCH", 20, 0),
    candidatesPerTick: envInt("SCHEDULER_CANDIDATES_PER_TICK", 200, 1),
    retryBatch: envInt("SCHEDULER_RETRY_BATCH", 20, 0),
    backoffHours: Math.max(MIN_BACKOFF_HOURS, envInt("SCHEDULER_REFUSAL_BACKOFF_HOURS", MIN_BACKOFF_HOURS, 1)),
    pauseBackoffHours: 1, // a pause / transient error: retried after >= 1 h
    rematchHours: 24, // matchCandidate runs again at least this often even when nothing changed
    ...over,
  };
}

function emptySummary(at) {
  return {
    at: at.toISOString(),
    searchesQueued: 0,
    searchesRescheduled: 0,
    searchesAbandoned: 0,
    queueProcessed: 0,
    matched: 0,
    matchSkipped: 0,
    applicationsCreated: 0,
    prepared: 0,
    autoApproved: 0,
    queuedForSend: 0,
    tasksOpened: 0,
    heldRequeued: 0,
    jobsRechecked: 0,
    applicationsClosed: 0,
    refusals: [],
    errors: [],
  };
}

const errMsg = (err) => String((err && err.message) || err || "error").replace(/\s+/g, " ").slice(0, 300);

async function audit(action, candidateId, applicationId, detail) {
  await db().query("INSERT INTO js_audit_events (actor, action, candidate_id, application_id, detail) VALUES ($1,$2,$3,$4,$5::jsonb)", [ACTOR, action, candidateId || null, applicationId || null, JSON.stringify(detail || {})]);
}

async function moduleIsPaused() {
  const r = await db().query("SELECT value FROM js_module_state WHERE key = 'module_paused'");
  return r.rowCount > 0 && r.rows[0].value && r.rows[0].value.paused === true;
}

async function setState(key, value) {
  await db().query("INSERT INTO js_module_state (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, JSON.stringify(value)]);
}
async function getState(key) {
  const r = await db().query("SELECT value FROM js_module_state WHERE key = $1", [key]);
  return r.rowCount ? r.rows[0].value : null;
}

/**
 * ONE open task per (application, reason) - or per (candidate, reason) when applicationId is null, keyed
 * by the 'candidate:<id>:' prefix of the detail (js_tasks has no candidate column). Returns true when opened.
 */
async function openTask(ctx, { applicationId = null, candidateId, assignee }, reason, detail) {
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`js-task:${applicationId || `c${candidateId}`}:${reason}`]);
    const prefix = `candidate:${candidateId}:`;
    const open = applicationId
      ? await c.query("SELECT id FROM js_tasks WHERE application_id = $1 AND reason = $2 AND status = 'open' LIMIT 1", [applicationId, reason])
      : await c.query("SELECT id FROM js_tasks WHERE application_id IS NULL AND reason = $1 AND status = 'open' AND left(detail, $3) = $2 LIMIT 1", [reason, prefix, prefix.length]);
    let created = false;
    if (!open.rowCount) {
      const to = assignee || (await c.query("SELECT assigned_to FROM candidates WHERE id = $1", [candidateId])).rows[0]?.assigned_to || null;
      const text = `${applicationId ? "" : prefix} ${detail || ""}`.trim().slice(0, 1000);
      const t = (await c.query("INSERT INTO js_tasks (application_id, reason, detail, assigned_to) VALUES ($1,$2,$3,$4) RETURNING id", [applicationId, reason, text || null, to])).rows[0];
      await c.query("INSERT INTO js_audit_events (actor, action, candidate_id, application_id, detail) VALUES ($1,'scheduler.task_opened',$2,$3,$4::jsonb)", [ACTOR, candidateId, applicationId, JSON.stringify({ taskId: t.id, reason })]);
      created = true;
    }
    await c.query("COMMIT");
    if (created) ctx.summary.tasksOpened += 1;
    return created;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}
const openAppTask = (ctx, app, reason, detail) => openTask(ctx, { applicationId: app.id, candidateId: app.candidate_id, assignee: app.responsible_user_id }, reason, detail);

async function resolveCandidateTask(candidateId, reason) {
  const prefix = `candidate:${candidateId}:`;
  await db().query("UPDATE js_tasks SET status = 'resolved', resolved_at = now() WHERE application_id IS NULL AND reason = $1 AND status = 'open' AND left(detail, $3) = $2", [reason, prefix, prefix.length]);
}

/** Back-off: a 'scheduler.retry_deferred' audit row; the latest one's retryAfter is compared to the tick clock (in SQL). */
async function deferRetry(ctx, app, kind, code, hours = ctx.L.backoffHours) {
  const retryAfter = new Date(ctx.now.getTime() + hours * HOUR_MS).toISOString();
  await audit("scheduler.retry_deferred", app.candidate_id, app.id, { kind, code, at: ctx.now.toISOString(), retryAfter });
  ctx.summary.refusals.push({ applicationId: app.id, kind, code, retryAfter });
}

const appRow = async (id) => (await db().query("SELECT * FROM js_applications WHERE id = $1", [id])).rows[0];

// SQL fragments (applied BEFORE any LIMIT, so blocked rows never take a batch slot).
const JOB_SOURCES = (j) => `SELECT src.paused FROM js_job_sightings s JOIN js_sources src ON src.id = s.source_id WHERE s.job_id = ${j}
     UNION ALL SELECT src.paused FROM js_jobs jj JOIN js_sources src ON src.key = jj.source_primary WHERE jj.id = ${j}`;
const ALL_SOURCES_PAUSED = (j) => `(EXISTS (SELECT 1 FROM (${JOB_SOURCES(j)}) x) AND NOT EXISTS (SELECT 1 FROM (${JOB_SOURCES(j)}) x WHERE NOT x.paused))`;
const NOT_DEFERRED = (a, nowParam) => `COALESCE((SELECT (e.detail->>'retryAfter')::timestamptz FROM js_audit_events e
     WHERE e.application_id = ${a}.id AND e.action = 'scheduler.retry_deferred' ORDER BY e.id DESC LIMIT 1), '-infinity'::timestamptz) <= ${nowParam}`;
const NOT_PAUSED = (a) => `NOT EXISTS (SELECT 1 FROM js_candidate_settings cs WHERE cs.candidate_id = ${a}.candidate_id AND cs.paused) AND NOT ${ALL_SOURCES_PAUSED(`${a}.job_id`)}`;
const LATEST_STATUS_EVENT = (a) => `(SELECT t.event FROM js_timeline t WHERE t.application_id = ${a}.id AND t.event IN ('held_paused','status_changed') ORDER BY t.id DESC LIMIT 1)`;
const APPROVER = (a) => `(SELECT t.actor FROM js_timeline t WHERE t.application_id = ${a}.id AND t.event = 'status_changed' AND t.detail->>'to' = 'approved' ORDER BY t.id DESC LIMIT 1)`;

/** Pause blockers (cheap SQL, before any network re-check): candidate / module / all job sources paused. */
async function pauseBlockers(app) {
  const out = [];
  const s = (await db().query("SELECT paused FROM js_candidate_settings WHERE candidate_id = $1", [app.candidate_id])).rows[0];
  if (s && s.paused) out.push("candidate_paused");
  if (await moduleIsPaused()) out.push("module_paused");
  if ((await db().query(`SELECT ${ALL_SOURCES_PAUSED("$1")} AS p`, [app.job_id])).rows[0].p) out.push("source_paused");
  return out;
}

// Eligibility prefilters in SQL (before the LIMIT): not deleted, confirmed profile, latest active consent
// has search, not paused, no suspended account. searchEligible() is still applied to every returned id.
const ELIGIBLE_SQL = `SELECT c.id FROM candidates c JOIN js_profiles p ON p.candidate_id = c.id AND p.status = 'confirmed'
  WHERE c.is_deleted = false
    AND (SELECT k.scope->>'search' FROM js_consents k WHERE k.candidate_id = c.id AND k.withdrawn_at IS NULL ORDER BY k.id DESC LIMIT 1) = 'true'
    AND NOT EXISTS (SELECT 1 FROM js_candidate_settings cs WHERE cs.candidate_id = c.id AND cs.paused)
    AND NOT EXISTS (SELECT 1 FROM js_candidate_accounts ca JOIN users u ON u.id = ca.user_id WHERE ca.candidate_id = c.id AND u.is_active = false)`;

/**
 * This tick's candidates: a ROTATING window of at most candidatesPerTick eligible candidates starting
 * after the cursor (js_module_state 'scheduler_candidate_cursor' = {lastId}), wrapping to the start.
 * The cursor advances once per tick (cached in ctx), so every eligible candidate is reached.
 */
async function eligibleCandidates(ctx) {
  if (ctx.eligible) return ctx.eligible;
  const N = ctx.L.candidatesPerTick;
  const cur = await getState(CURSOR_KEY);
  const lastId = cur && Number.isSafeInteger(cur.lastId) ? cur.lastId : 0;
  const first = (await db().query(`${ELIGIBLE_SQL} AND c.id > $1 ORDER BY c.id LIMIT $2`, [lastId, N])).rows.map((r) => r.id);
  let wrapped = [];
  if (first.length < N && lastId > 0) wrapped = (await db().query(`${ELIGIBLE_SQL} AND c.id <= $1 ORDER BY c.id LIMIT $2`, [lastId, N - first.length])).rows.map((r) => r.id);
  const ids = [...first, ...wrapped];
  const next = wrapped.length ? wrapped[wrapped.length - 1] : first.length ? first[first.length - 1] : 0;
  await setState(CURSOR_KEY, { lastId: next, at: ctx.now.toISOString() });
  const out = [];
  for (const id of ids) {
    if ((await consentService.searchEligible(id)).eligible) out.push(id);
  }
  ctx.eligible = out;
  return out;
}

const isRateLimited = (r) => r && (r.status === "rate_limited" || ((r.runs || []).length > 0 && r.runs.some((x) => x.status === "rate_limited")));
const MAX_RESCHEDULES = 24;
const MAX_ITEM_AGE_MS = 6 * HOUR_MS;
const MAX_SOURCE_BACKOFF_MS = 6 * HOUR_MS;
const backoffKey = (sourceKey) => `source_backoff:${sourceKey}`;

/** Upstream Retry-After for a source (js_module_state 'source_backoff:<key>' = {until}); null when none is active. */
async function sourceBackoffUntil(sourceKey, now) {
  const v = await getState(backoffKey(sourceKey));
  const until = v && v.until ? new Date(v.until) : null;
  return until && until.getTime() > now.getTime() ? until : null;
}

/**
 * Upstream Retry-After in ms: the structured value the runner exposes (result.retryAfterMs, or each run's
 * retryAfterMs as stored in js_runs.errors[0]) first; the "wait Ns" message text only as a fallback.
 */
function retryAfterMsOf(r) {
  const ok = (v) => Number.isFinite(v) && v > 0;
  if (r && ok(r.retryAfterMs)) return r.retryAfterMs;
  const runs = ((r && r.runs) || []).filter((x) => x.status === "rate_limited");
  for (const x of runs) if (ok(x.retryAfterMs)) return x.retryAfterMs;
  for (const x of runs) {
    const m = /wait (\d+)s/.exec(String(x.error || ""));
    if (m) return Number(m[1]) * 1000;
  }
  return null;
}

/** A scheduled search that stayed rate-limited too long: closed with a 'rate_limited' run note, not retried. */
async function giveUpSearch(ctx, job, p, reschedules) {
  const src = (await db().query("SELECT id FROM js_sources WHERE key = $1", [p.sourceKey])).rows[0];
  const message = `Scheduled search abandoned after ${reschedules} reschedule(s): source still rate-limited`;
  if (src) await db().query("INSERT INTO js_runs (source_id, started_at, finished_at, errors) VALUES ($1,$2,$2,$3::jsonb)", [src.id, ctx.now, JSON.stringify([{ status: "rate_limited", message, attempts: 0 }])]);
  await audit("scheduler.search_abandoned", p.candidateId, null, { queueId: Number(job.id), sourceKey: p.sourceKey, reschedules, firstQueuedAt: p.firstQueuedAt });
  ctx.summary.searchesAbandoned += 1;
  return { status: "rate_limited", abandoned: true, runs: [] };
}

function handlersFor(ctx) {
  const d = ctx.deps;
  const searchDeps = { now: () => ctx.now, sleep: d.sleep, fetch: d.fetch, lookup: d.lookup };
  const submitDeps = { recheck: d.recheck, now: ctx.now, mailSend: d.mailSend };
  return {
    search: async (job) => {
      const p = job.payload || {};
      const scheduled = p.scheduled === true;
      // Bounded rescheduling: at most MAX_RESCHEDULES, and never for an item older than MAX_ITEM_AGE_MS.
      const reschedules = Number.isSafeInteger(p.reschedules) ? p.reschedules : 0;
      const first = p.firstQueuedAt && !Number.isNaN(new Date(p.firstQueuedAt).getTime()) ? p.firstQueuedAt : ctx.now.toISOString();
      const exhausted = (n) => n >= MAX_RESCHEDULES || ctx.now.getTime() - new Date(first).getTime() >= MAX_ITEM_AGE_MS;
      const again = (at) => {
        ctx.summary.searchesRescheduled += 1;
        return { [queue.RESCHEDULE]: at, payload: { ...p, reschedules: reschedules + 1, firstQueuedAt: first } };
      };
      if (scheduled) {
        const until = await sourceBackoffUntil(p.sourceKey, ctx.now); // honour the upstream Retry-After: no call
        if (until) return exhausted(reschedules) ? giveUpSearch(ctx, job, p, reschedules) : again(until);
      }
      const r = await (d.handleSearchJob || searchRunner.handleSearchJob)(job, searchDeps);
      for (const run of (r && r.runs) || []) {
        if (run.status === "failed") ctx.summary.errors.push({ step: "search", sourceKey: run.sourceKey, candidateId: p.candidateId || null, message: run.error || "search failed" });
      }
      if (scheduled && isRateLimited(r)) {
        const waitMs = retryAfterMsOf(r);
        let at = new Date(ctx.now.getTime() + 60000); // per-source rate limit: next minute window
        if (waitMs) {
          at = new Date(ctx.now.getTime() + Math.min(Math.max(waitMs, 60000), MAX_SOURCE_BACKOFF_MS));
          await setState(backoffKey(p.sourceKey), { until: at.toISOString(), setAt: ctx.now.toISOString() });
        }
        // Not done and nothing failed: back to pending for the next window (attempt not consumed), within bounds.
        return exhausted(reschedules) ? giveUpSearch(ctx, job, p, reschedules) : again(at);
      }
      return r;
    },
    submit: (job) => submitter.handleSubmit(job, submitDeps),
  };
}

// ---------------------------------------------------------------- steps

async function stepDueSearches(ctx) {
  await searchRunner.ensureSources();
  const sources = (await db().query("SELECT id, key, schedule_cron, last_run_at, paused, last_error FROM js_sources WHERE paused = false ORDER BY id")).rows;
  const hourBucket = Math.floor(ctx.now.getTime() / HOUR_MS);
  let candidates = null;
  for (const src of sources) {
    try {
      const adapter = registry.getAdapter(src.key);
      if (!adapter || adapter.status().status !== "connected") continue; // manual / requires_setup: never scheduled
      let due;
      try {
        due = isDue(src.schedule_cron || DEFAULT_SCHEDULE, src.last_run_at, ctx.now);
      } catch (err) {
        // Never silently replace an admin's schedule: mark the source once and skip it.
        const msg = `invalid schedule_cron: ${errMsg(err)}`.slice(0, 500);
        if (src.last_error !== msg) {
          await db().query("UPDATE js_sources SET status = 'unavailable', last_error = $2 WHERE id = $1", [src.id, msg]);
          await audit("scheduler.invalid_schedule", null, null, { sourceKey: src.key, schedule: src.schedule_cron });
          console.warn(`jobsearch scheduler: source ${src.key} has an invalid schedule_cron; it is not scheduled`);
          ctx.summary.errors.push({ step: "search", sourceKey: src.key, message: msg });
        }
        continue;
      }
      if (!due) continue;
      if (await sourceBackoffUntil(src.key, ctx.now)) continue; // upstream Retry-After still running
      if (!candidates) candidates = await eligibleCandidates(ctx);
      for (const candidateId of candidates) {
        const key = `sched-search:${src.key}:${candidateId}:${hourBucket}`;
        const exists = await db().query("SELECT 1 FROM js_queue WHERE idempotency_key = $1", [key]);
        if (exists.rowCount) continue;
        // One live item per (source, candidate): a pending/running (e.g. rescheduled) one is enough.
        const live = await db().query(
          "SELECT 1 FROM js_queue WHERE kind = 'search' AND status IN ('pending','running') AND payload->>'sourceKey' = $1 AND payload->>'candidateId' = $2 LIMIT 1",
          [src.key, String(candidateId)]
        );
        if (live.rowCount) continue;
        await queue.enqueue({ kind: "search", payload: { sourceKey: src.key, candidateId, scheduled: true, requestedBy: null, reschedules: 0, firstQueuedAt: ctx.now.toISOString() }, runAt: ctx.now, idempotencyKey: key });
        ctx.summary.searchesQueued += 1;
      }
    } catch (err) {
      ctx.summary.errors.push({ step: "search", sourceKey: src.key, message: errMsg(err) });
    }
  }
}

async function stepDrain(ctx, kinds) {
  await queue.reclaimStale({ now: ctx.now });
  if (!kinds || kinds.includes("submit")) await submitter.sweepStuckSending();
  ctx.summary.queueProcessed += await queue.work(handlersFor(ctx), { kinds, batch: 10, loop: true, max: ctx.L.queueBatch, now: ctx.now });
}

/** What a match run depends on; matchCandidate is skipped while it is unchanged (re-run at least every rematchHours). */
async function matchSignature(candidateId, globalSig) {
  const r = (await db().query(
    `SELECT (SELECT updated_at FROM js_profiles WHERE candidate_id = $1) AS p,
            (SELECT updated_at FROM js_preferences WHERE candidate_id = $1) AS pr,
            (SELECT updated_at FROM js_candidate_settings WHERE candidate_id = $1) AS s,
            (SELECT max(id) FROM js_consents WHERE candidate_id = $1) AS k,
            (SELECT max(withdrawn_at) FROM js_consents WHERE candidate_id = $1) AS kw`,
    [candidateId]
  )).rows[0];
  return JSON.stringify([globalSig, r.p, r.pr, r.s, r.k, r.kw]);
}

async function stepMatch(ctx) {
  const match = ctx.deps.matchCandidate || matchService.matchCandidate;
  const g = (await db().query(
    `SELECT (SELECT COALESCE(max(id), 0) FROM js_jobs) AS j, (SELECT count(*) FROM js_jobs WHERE status = 'open') AS o,
            (SELECT max(last_checked_at) FROM js_jobs) AS lc, (SELECT COALESCE(max(id), 0) FROM js_employer_confirmations) AS ec,
            (SELECT count(*) FROM js_employer_confirmations WHERE revoked_at IS NOT NULL) AS er`
  )).rows[0];
  const globalSig = [g.j, g.o, g.lc, g.ec, g.er];
  for (const candidateId of await eligibleCandidates(ctx)) {
    try {
      const sig = await matchSignature(candidateId, globalSig);
      const key = `scheduler_match:${candidateId}`;
      const prev = await getState(key);
      if (prev && prev.sig === sig && ctx.now.getTime() - new Date(prev.at).getTime() < ctx.L.rematchHours * HOUR_MS) {
        ctx.summary.matchSkipped += 1;
        continue;
      }
      const rows = await match(candidateId, { now: ctx.now });
      ctx.summary.matched += rows.length;
      await setState(key, { sig, at: ctx.now.toISOString() });
    } catch (err) {
      ctx.summary.errors.push({ step: "match", candidateId, message: errMsg(err) });
    }
  }
}

/** Queue an approved application (system path). Refusals: deduped task + back-off; pauses: quiet 1 h back-off. */
async function tryQueue(ctx, app, counter) {
  if ((await pauseBlockers(app)).length) {
    await deferRetry(ctx, app, "queue", "paused", ctx.L.pauseBackoffHours);
    return false;
  }
  let r;
  try {
    r = await submitter.queueSubmission(app.id, undefined, { recheck: ctx.deps.recheck, now: ctx.now });
  } catch (err) {
    await deferRetry(ctx, app, "queue", "error", ctx.L.pauseBackoffHours); // never a per-minute retry loop
    throw err;
  }
  if (r.queued) {
    if (!r.existing) ctx.summary[counter] += 1;
    await audit(counter === "heldRequeued" ? "scheduler.requeued_after_hold" : "scheduler.queued_for_send", app.candidate_id, app.id, { submissionId: r.submissionId, attempt: r.attempt, existing: r.existing === true });
    return true;
  }
  if (HOLD_CODES.has(r.reason)) {
    await deferRetry(ctx, app, "queue", r.reason, ctx.L.pauseBackoffHours); // a pause appeared meanwhile
    return false;
  }
  await openAppTask(ctx, app, r.reason, `Automatic queueing refused by the pre-send guard (${r.reason}${r.handoff ? `, handoff: ${r.handoff}` : ""}). ${r.detail || ""}`.trim());
  await deferRetry(ctx, app, "queue", r.reason);
  return false;
}

/**
 * automatic mode: nothing is approved while a pause applies (no stranded 'approved' rows consuming caps);
 * auto-approve ONLY when eligible, then queue; otherwise ready_for_review + one task + back-off.
 */
async function autoFlow(ctx, app) {
  const pauses = await pauseBlockers(app);
  if (pauses.length) {
    await deferRetry(ctx, app, "auto_approve", pauses.join(","), ctx.L.pauseBackoffHours);
    return false;
  }
  let approved = false;
  let reasons;
  try {
    const elig = await applicationService.autoApproveEligibility(app.id);
    reasons = elig.reasons;
    if (elig.allowed) {
      const r = await applicationService.autoApprove(app.id);
      approved = r.approved;
      reasons = r.reasons;
    }
  } catch (err) {
    await deferRetry(ctx, app, "auto_approve", "error", ctx.L.pauseBackoffHours);
    throw err;
  }
  if (approved) {
    ctx.summary.autoApproved += 1;
    await audit("scheduler.auto_approved", app.candidate_id, app.id, {});
    return tryQueue(ctx, await appRow(app.id), "queuedForSend");
  }
  await openAppTask(ctx, app, "needs_human_approval", `Automatic approval not allowed: ${reasons.join(", ")}`);
  await deferRetry(ctx, app, "auto_approve", reasons.join(",").slice(0, 300));
  return false;
}

/** Prepare a scheduler-created application; a refusal leaves it 'matched' with a >= 6 h back-off. */
async function prepareAndContinue(ctx, mode, app) {
  const prepare = ctx.deps.prepareApplication || applicationService.prepareApplication;
  let p;
  try {
    p = await prepare({ id: app.id, actor: ACTOR, [SCHEDULER_GRANT]: true });
  } catch (err) {
    if (err instanceof HttpError) {
      await deferRetry(ctx, app, "prepare", String(err.status));
      ctx.summary.refusals[ctx.summary.refusals.length - 1].message = errMsg(err);
      return;
    }
    await deferRetry(ctx, app, "prepare", "error", ctx.L.pauseBackoffHours);
    throw err;
  }
  const row = await appRow(app.id);
  if (p.application.status !== "ready_for_review") {
    await openAppTask(ctx, row, "preparation_blocked", `Automatic preparation left the application at ${p.application.status}: ${(p.package.blocked || []).map((b) => b.reason).join(", ")}`);
    return;
  }
  ctx.summary.prepared += 1;
  await audit("scheduler.prepared", row.candidate_id, row.id, { status: row.status });
  if (mode === "automatic") await autoFlow(ctx, row); // prepare_for_approval: STOP at ready_for_review
}

async function processNewMatch(ctx, cand, matchId) {
  const created = await applicationService.createFromMatch({ matchId, actor: ACTOR, [SCHEDULER_GRANT]: true });
  if (!created.created) return;
  ctx.summary.applicationsCreated += 1;
  await audit("scheduler.application_created", cand.candidate_id, created.id, { matchId, mode: cand.mode });
  await prepareAndContinue(ctx, cand.mode, await appRow(created.id));
}

async function stepOrchestrate(ctx) {
  const eligible = await eligibleCandidates(ctx);
  if (!eligible.length) return;
  const cands = (await db().query(
    "SELECT candidate_id, mode FROM js_candidate_settings WHERE candidate_id = ANY($1::int[]) AND mode <> 'search_only' AND paused = false ORDER BY candidate_id",
    [eligible]
  )).rows;
  for (const cand of cands) {
    const cid = cand.candidate_id;
    try {
      // No application is created while it could not be prepared: no prepare consent -> one candidate task.
      const blockers = await sendBlockers(db(), cid, "prepare");
      if (blockers.includes("no_prepare_consent")) {
        await openTask(ctx, { candidateId: cid }, "prepare_consent_missing", `Mode ${cand.mode} but no active 'prepare' consent: matches are kept, no application is created until the candidate consents.`);
        continue;
      }
      if (blockers.length) continue; // paused / suspended / deleted: quietly skipped
      await resolveCandidateTask(cid, "prepare_consent_missing");
      const matches = (await db().query(
        `SELECT m.id FROM js_matches m JOIN js_jobs j ON j.id = m.job_id
          WHERE m.candidate_id = $1 AND m.score >= $2 AND j.status = 'open'
            AND NOT EXISTS (SELECT 1 FROM js_applications a WHERE a.candidate_id = m.candidate_id AND a.job_id = m.job_id)
          ORDER BY m.score DESC, m.id LIMIT $3`,
        [cid, ctx.L.minScore, ctx.L.applicationsPerTick]
      )).rows;
      for (const m of matches) {
        try {
          await processNewMatch(ctx, cand, m.id);
        } catch (err) {
          if (err instanceof HttpError) ctx.summary.refusals.push({ candidateId: cid, matchId: m.id, kind: "create", code: err.status, message: errMsg(err) });
          else ctx.summary.errors.push({ step: "orchestrate", candidateId: cid, matchId: m.id, message: errMsg(err) });
        }
      }
      await retryDeferred(ctx, cand);
    } catch (err) {
      ctx.summary.errors.push({ step: "orchestrate", candidateId: cid, message: errMsg(err) });
    }
  }
}

/**
 * Earlier scheduler work whose back-off expired (filtered in SQL before the LIMIT, as are pauses):
 *  - scheduler-created applications still 'matched' (preparation refused) -> prepare again;
 *  - automatic: scheduler-deferred 'ready_for_review' -> auto-approval attempt again;
 *  - automatic: approved by 'system:auto', not held, without a queued submission -> queue again
 *    (whether or not a deferral row exists; its own back-off applies once one does).
 * Pause holds are step 6.
 */
async function retryDeferred(ctx, cand) {
  const rows = (await db().query(
    `SELECT a.* FROM js_applications a
      WHERE a.candidate_id = $1 AND ${NOT_DEFERRED("a", "$2")} AND ${NOT_PAUSED("a")} AND (
        (a.status = 'matched' AND EXISTS (SELECT 1 FROM js_audit_events e WHERE e.application_id = a.id AND e.action = 'scheduler.application_created'))
        OR ($3 = 'automatic' AND a.status = 'ready_for_review' AND EXISTS (SELECT 1 FROM js_audit_events e WHERE e.application_id = a.id AND e.action = 'scheduler.retry_deferred'))
        OR ($3 = 'automatic' AND a.status = 'approved' AND ${APPROVER("a")} = 'system:auto'
            AND COALESCE(${LATEST_STATUS_EVENT("a")}, '') <> 'held_paused'
            AND NOT EXISTS (SELECT 1 FROM js_submissions s WHERE s.application_id = a.id AND s.status = 'queued')))
      ORDER BY a.id LIMIT $4`,
    [cand.candidate_id, ctx.now, cand.mode, ctx.L.retryBatch]
  )).rows;
  for (const app of rows) {
    try {
      if (app.status === "matched") await prepareAndContinue(ctx, cand.mode, app);
      else if (app.status === "ready_for_review") await autoFlow(ctx, app);
      else await tryQueue(ctx, app, "queuedForSend");
    } catch (err) {
      ctx.summary.errors.push({ step: "orchestrate", applicationId: app.id, message: errMsg(err) });
    }
  }
}

/** Step 6: 'approved' applications whose latest status event is a pause hold -> re-queued once the pause is lifted. */
async function stepRequeueHeld(ctx) {
  const rows = (await db().query(
    `SELECT a.* FROM js_applications a JOIN candidates c ON c.id = a.candidate_id AND c.is_deleted = false
      WHERE a.status = 'approved' AND ${LATEST_STATUS_EVENT("a")} = 'held_paused'
        AND ${NOT_DEFERRED("a", "$1")} AND ${NOT_PAUSED("a")}
      ORDER BY a.id LIMIT $2`,
    [ctx.now, ctx.L.retryBatch]
  )).rows;
  for (const app of rows) {
    try {
      await tryQueue(ctx, app, "heldRequeued");
    } catch (err) {
      ctx.summary.errors.push({ step: "requeue_held", applicationId: app.id, message: errMsg(err) });
    }
  }
}

/**
 * Step 7: re-check stale open jobs, skipping jobs whose every source is paused and never asking a paused
 * source (its sightings read as "unknown", so they cannot close the job). Each source's rate_limit_per_min
 * bounds its re-checks per tick. Closed/expired jobs close their not-yet-sent applications (matched,
 * preparing, ready_for_review, and approved without a queued submission - incl. pause holds).
 */
async function stepExpiry(ctx) {
  if (!ctx.L.recheckBatch) return;
  const recheck = ctx.deps.recheckJob || jobStore.recheckJob;
  const cutoff = new Date(ctx.now.getTime() - ctx.L.recheckHours * HOUR_MS);
  const srcRows = (await db().query("SELECT key, paused, rate_limit_per_min FROM js_sources")).rows;
  const paused = new Set(srcRows.filter((s) => s.paused).map((s) => s.key));
  const limitOf = new Map(srcRows.map((s) => [s.key, s.rate_limit_per_min]));
  const used = new Map();
  const filtered = { getAdapter: (key) => (paused.has(key) ? null : registry.getAdapter(key)), adapters: registry.adapters, keys: registry.keys };
  const jobs = (await db().query(
    `SELECT j.id FROM js_jobs j WHERE j.status = 'open' AND (j.last_checked_at IS NULL OR j.last_checked_at < $1) AND NOT ${ALL_SOURCES_PAUSED("j.id")}
      ORDER BY j.last_checked_at NULLS FIRST, j.id LIMIT $2`,
    [cutoff, ctx.L.recheckBatch * 5]
  )).rows;
  let done = 0;
  for (const { id } of jobs) {
    if (done >= ctx.L.recheckBatch) break;
    try {
      const keys = [...new Set((await db().query(
        "SELECT src.key FROM js_job_sightings s JOIN js_sources src ON src.id = s.source_id WHERE s.job_id = $1 AND NOT src.paused", [id]
      )).rows.map((r) => r.key))];
      if (keys.some((k) => limitOf.get(k) && (used.get(k) || 0) >= limitOf.get(k))) continue; // that source's budget is spent this tick
      for (const k of keys) used.set(k, (used.get(k) || 0) + 1);
      const st = await recheck(id, { now: ctx.now, registry: filtered });
      const status = typeof st === "string" ? st : st && st.status;
      done += 1;
      ctx.summary.jobsRechecked += 1;
      if (status !== "closed" && status !== "expired") continue;
      const apps = (await db().query(
        `SELECT a.id FROM js_applications a WHERE a.job_id = $1 AND (a.status = ANY($2::text[])
           OR (a.status = 'approved' AND NOT EXISTS (SELECT 1 FROM js_submissions s WHERE s.application_id = a.id AND s.status = 'queued')))
         ORDER BY a.id`,
        [id, CLOSABLE]
      )).rows;
      for (const a of apps) {
        try {
          await applicationService.transition(a.id, "closed", ACTOR, { reason: `job_${status}`, expectFrom: [...CLOSABLE, "approved"] });
          ctx.summary.applicationsClosed += 1;
        } catch (err) {
          if (!(err instanceof HttpError)) throw err; // moved on concurrently: nothing to close
        }
      }
      // queued applications are stopped by the pre-send guard (job_closed) at send time.
    } catch (err) {
      ctx.summary.errors.push({ step: "expiry", jobId: id, message: errMsg(err) });
    }
  }
}


async function step(ctx, name, fn) {
  try {
    // Observability / test hook: deps.onStep(name) runs before each step; returning 'skip' skips it.
    if (typeof ctx.deps.onStep === "function" && (await ctx.deps.onStep(name)) === "skip") return;
    await fn(ctx);
  } catch (err) {
    ctx.summary.errors.push({ step: name, message: errMsg(err) });
  }
}

async function recordTick(summary) {
  try {
    await db().query(
      "INSERT INTO js_module_state (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [STATE_KEY, JSON.stringify({ at: summary.at, finishedAt: new Date().toISOString(), summary })]
    );
  } catch (err) {
    summary.errors.push({ step: "record", message: errMsg(err) });
  }
}

// ---------------------------------------------------------------- tick

let ticking = false;

/**
 * @param {Date} [now] tick clock (searches, queue claims, back-off, job re-check cut-off)
 * @param {{deps?: {sleep?, fetch?, lookup?, recheck?, recheckJob?, matchCandidate?, prepareApplication?, handleSearchJob?, mailSend?, onStep?, limits?: object}}} [opts]
 * @returns {Promise<object>} TickSummary, or {skipped: 'module_paused'|'already_running'}
 */
async function tick(now = new Date(), { deps = {} } = {}) {
  if (ticking) return { skipped: "already_running" };
  ticking = true;
  try {
    const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const summary = emptySummary(at);
    const ctx = { now: at, deps, L: limits(deps.limits), summary, eligible: null };
    let paused;
    try {
      paused = await moduleIsPaused();
    } catch (err) {
      return { skipped: "module_state_unavailable", at: summary.at, errors: [{ step: "module_state", message: errMsg(err) }] };
    }
    if (paused) {
      const out = { skipped: "module_paused", at: summary.at };
      await recordTick({ ...out, errors: [] });
      return out;
    }
    await step(ctx, "search", stepDueSearches);
    await step(ctx, "queue", (c) => stepDrain(c));
    await step(ctx, "match", stepMatch);
    await step(ctx, "orchestrate", stepOrchestrate);
    await step(ctx, "requeue_held", stepRequeueHeld);
    await step(ctx, "send", (c) => stepDrain(c, ["submit"])); // what this tick queued is sent this tick (bounded)
    await step(ctx, "expiry", stepExpiry);
    await step(ctx, "stale", async (c) => { await queue.reclaimStale({ now: c.now }); });
    await recordTick(summary);
    return summary;
  } catch (err) {
    return { skipped: "internal_error", errors: [{ step: "tick", message: errMsg(err) }] };
  } finally {
    ticking = false;
  }
}

/** tick() under the cluster-wide session advisory lock (pinned connection); skips when another process holds it. */
async function guardedTick(now = new Date(), opts = {}) {
  let conn;
  try {
    conn = await db().connect();
  } catch (err) {
    return { skipped: "db_unavailable", errors: [{ step: "lock", message: errMsg(err) }] };
  }
  let locked = false;
  let destroy = false;
  try {
    locked = (await conn.query("SELECT pg_try_advisory_lock($1, $2) AS ok", LOCK_KEY)).rows[0].ok === true;
    if (!locked) return { skipped: "locked_elsewhere" };
    return await tick(now, opts);
  } catch (err) {
    return { skipped: "internal_error", errors: [{ step: "lock", message: errMsg(err) }] };
  } finally {
    if (locked) {
      try {
        await conn.query("SELECT pg_advisory_unlock($1, $2)", LOCK_KEY);
      } catch {
        destroy = true; // closing the session releases the lock
      }
    }
    conn.release(destroy);
  }
}

// ---------------------------------------------------------------- start / status

let task = null;

function schedulerEnabled() {
  return String(process.env.JOBSEARCH_SCHEDULER || "").toLowerCase() !== "off" && process.env.NODE_ENV !== "test";
}

function startJobSearchScheduler() {
  require("./workers").startWorkers(); // own switch: JOBSEARCH_WORKERS=off / NODE_ENV=test
  if (!schedulerEnabled() || task) return task;
  task = cron.schedule("* * * * *", () => {
    guardedTick(new Date())
      .then((s) => { if (s && s.errors && s.errors.length) console.error("jobsearch scheduler tick errors:", s.errors.length); })
      .catch((err) => console.error("jobsearch scheduler tick failed:", err && err.message));
  });
  return task;
}

function stopJobSearchScheduler() {
  if (task) task.stop();
  task = null;
  require("./workers").stopWorkers();
}

async function status() {
  const last = (await db().query("SELECT value FROM js_module_state WHERE key = $1", [STATE_KEY])).rows[0];
  await searchRunner.ensureSources();
  const sources = (await db().query("SELECT id, key, paused, schedule_cron, last_run_at FROM js_sources ORDER BY id")).rows;
  const out = [];
  for (const s of sources) {
    if (!registry.getAdapter(s.key)) continue;
    const run = (await db().query("SELECT id, started_at, finished_at, found, new_count, errors FROM js_runs WHERE source_id = $1 ORDER BY id DESC LIMIT 1", [s.id])).rows[0];
    out.push({
      key: s.key,
      paused: s.paused,
      schedule: s.schedule_cron || DEFAULT_SCHEDULE,
      lastRunAt: s.last_run_at,
      lastRun: run ? { id: run.id, startedAt: run.started_at, finishedAt: run.finished_at, found: run.found, newCount: run.new_count, ...searchRunner.runStatus(run) } : null,
    });
  }
  return { enabled: schedulerEnabled(), running: ticking, modulePaused: await moduleIsPaused(), lastTick: last ? last.value : null, sources: out };
}

module.exports = {
  tick,
  guardedTick,
  startJobSearchScheduler,
  stopJobSearchScheduler,
  status,
  schedulerEnabled,
  parseCron,
  cronMatches,
  previousFire,
  isDue,
  DEFAULT_SCHEDULE,
  ACTOR,
};
