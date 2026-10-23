// Search runner: drives source adapters, stores jobs, records js_runs.
// js_runs has no status/error columns (migration 002 is fixed), so the outcome of a run that did
// not finish normally is recorded as errors = [{status, message, attempts}]; an empty errors
// array means status 'ok'.
const { HttpError } = require("./httpError");
const registry = require("./sources");
const { SourceNotConnected } = require("./sources/errors");
const jobStore = require("./jobStore");
const consentService = require("./consentService");
const queue = require("./queue");
const { assertCandidateAccess } = require("./scope");
const { PERMISSIONS } = require("../../middleware/role");

const db = () => require("../../db");
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_COUNTRIES = 5;
// A single Retry-After longer than this is not waited for inline: the source is recorded as
// 'rate_limited' for this run and the scheduler / a later queue job tries again.
const MAX_INLINE_WAIT_MS = 30000;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Seeds one js_sources row per registered adapter (idempotent) and syncs setup-derived status. */
async function ensureSources() {
  for (const a of registry.adapters()) {
    const d = a.describe();
    await db().query(
      "INSERT INTO js_sources (key, adapter, status, rate_limit_per_min) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING",
      [a.key, a.key, a.status().status, d.rateLimitPerMin || null]
    );
    const st = a.status();
    // 'unavailable' (after exhausted retries) stays until a run succeeds, unless setup is lost.
    await db().query(
      `UPDATE js_sources SET status = CASE WHEN status = 'unavailable' AND $2 = 'connected' THEN status ELSE $2 END,
         last_error = CASE WHEN $2 IN ('requires_setup') THEN $3 ELSE last_error END
       WHERE key = $1`,
      [a.key, st.status, st.detail]
    );
  }
}

function errText(err) {
  return String((err && err.message) || err || "error").replace(/\s+/g, " ").slice(0, 500);
}

async function moduleIsPaused() {
  const r = await db().query("SELECT value FROM js_module_state WHERE key = 'module_paused'");
  return r.rowCount > 0 && r.rows[0].value && r.rows[0].value.paused === true;
}

async function buildCandidateQuery(candidateId) {
  const p = await db().query("SELECT confirmed FROM js_profiles WHERE candidate_id = $1 AND status = 'confirmed'", [candidateId]);
  const prefs = await db().query("SELECT countries, categories FROM js_preferences WHERE candidate_id = $1", [candidateId]);
  const confirmed = p.rows[0] ? p.rows[0].confirmed || {} : {};
  const pr = prefs.rows[0] || { countries: [], categories: [] };
  const keywords = [...new Set([confirmed.profession, ...(pr.categories || [])].filter((k) => typeof k === "string" && k.trim()).map((k) => k.trim()))];
  const languages = Array.isArray(confirmed.languages) ? confirmed.languages.map((l) => l && l.lang).filter(Boolean) : [];
  return { keywords, countries: (pr.countries || []).slice(0, MAX_COUNTRIES), language: languages[0] || null };
}

/** Decodes js_runs.errors -> {status, message, attempts, skipped_invalid}. Empty errors = 'ok'. */
function runStatus(row) {
  const e = row && Array.isArray(row.errors) ? row.errors[0] : null;
  if (!e) return { status: "ok", message: null, attempts: null, skipped_invalid: 0 };
  const out = { status: e.status || "failed", message: e.message || null, attempts: e.attempts === undefined ? null : e.attempts, skipped_invalid: e.skipped_invalid || 0 };
  if (Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0) out.retryAfterMs = e.retryAfterMs; // upstream Retry-After (structured)
  return out;
}

/**
 * Reserves a run slot for `source` atomically: the rate-limit count and the run insert happen under a
 * per-source advisory lock so two simultaneous clicks cannot both pass. Returns {runId} or {skipped}.
 */
async function reserveRun(source, now) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`search-rate:${source.key}`]);
    const fresh = (await client.query("SELECT paused, rate_limit_per_min FROM js_sources WHERE id = $1", [source.id])).rows[0];
    let skip = null;
    if (fresh.paused) skip = ["paused", "Source is paused"];
    else if (fresh.rate_limit_per_min) {
      const n = (await client.query(
        "SELECT count(*)::int AS n FROM js_runs WHERE source_id = $1 AND started_at > $2 AND (errors = '[]'::jsonb OR (errors->0->>'status' IN ('failed','ok_with_skips','rate_limited') AND COALESCE((errors->0->>'attempts')::int, 0) > 0))",
        [source.id, new Date(now.getTime() - 60000)]
      )).rows[0].n;
      if (n >= fresh.rate_limit_per_min) skip = ["rate_limited", `Per-source rate limit of ${fresh.rate_limit_per_min}/min reached`];
    }
    let out;
    if (skip) {
      const id = (await client.query("INSERT INTO js_runs (source_id, started_at, finished_at, errors) VALUES ($1,$2,$2,$3::jsonb) RETURNING id", [source.id, now, JSON.stringify([{ status: skip[0], message: skip[1], attempts: 0 }])])).rows[0].id;
      out = { skipped: { sourceKey: source.key, runId: id, status: skip[0], found: 0, created: 0, attempts: 0, error: skip[1] } };
    } else {
      out = { runId: (await client.query("INSERT INTO js_runs (source_id, started_at) VALUES ($1,$2) RETURNING id", [source.id, now])).rows[0].id };
    }
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function finishRun(runId, now, { found, created, errors }) {
  await db().query("UPDATE js_runs SET finished_at = $2, found = $3, new_count = $4, errors = $5::jsonb WHERE id = $1", [runId, now, found, created, JSON.stringify(errors)]);
}

async function runSource(source, adapter, query, deps, run) {
  const now = deps.now();
  const out = { sourceKey: source.key, runId: run, status: "ok", found: 0, created: 0, attempts: 0, skipped_invalid: 0 };
  const done = async (status, extra = {}) => {
    Object.assign(out, { status }, extra);
    const errors = status === "ok" ? [] : [{ status, message: out.error || null, attempts: out.attempts, ...(out.skipped_invalid ? { skipped_invalid: out.skipped_invalid } : {}), ...(out.retryAfterMs ? { retryAfterMs: out.retryAfterMs } : {}) }];
    await finishRun(run, deps.now(), { found: out.found, created: out.created, errors });
    return out;
  };

  const st = adapter.status();
  if (st.status === "manual") return done("manual", { error: null });
  if (st.status !== "connected") {
    await db().query("UPDATE js_sources SET status = $2, last_error = $3, last_run_at = $4 WHERE id = $1", [source.id, st.status, st.detail, now]);
    return done("requires_setup", { error: st.detail });
  }

  const ctx = { fetch: deps.fetch, lookup: deps.lookup, now: deps.now, cache: deps.cache };
  const countries = query.countries && query.countries.length ? query.countries : [null];
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    out.attempts = attempt;
    try {
      const raws = [];
      for (const country of countries) {
        raws.push(...(await adapter.search({ keywords: query.keywords || [], country, language: query.language || null, since: null }, ctx)));
      }
      let created = 0;
      let skipped = 0;
      for (const raw of raws) {
        try {
          const r = await jobStore.upsertJob(raw, source.id, { now: deps.now() });
          if (r.created) created += 1;
        } catch (err) {
          if (err instanceof HttpError && err.status === 400) skipped += 1; // one bad item must not fail the run
          else throw err;
        }
      }
      await db().query("UPDATE js_sources SET status = $2, last_error = NULL, last_run_at = $3 WHERE id = $1", [source.id, st.status, deps.now()]);
      if (skipped) return done("ok_with_skips", { found: raws.length, created, skipped_invalid: skipped, error: `${skipped} invalid item(s) skipped` });
      return done("ok", { found: raws.length, created });
    } catch (err) {
      lastErr = err;
      if (err instanceof SourceNotConnected) {
        await db().query("UPDATE js_sources SET status = 'requires_setup', last_error = $2, last_run_at = $3 WHERE id = $1", [source.id, errText(err), deps.now()]);
        return done("requires_setup", { error: errText(err) });
      }
      if (err && err.retriable === false) break; // refused by the safety rules / auth required: retrying cannot help
      if (err && err.retryAfterMs > MAX_INLINE_WAIT_MS) {
        const message = `Source asked to wait ${Math.round(err.retryAfterMs / 1000)}s (Retry-After); will retry later`;
        await db().query("UPDATE js_sources SET last_error = $2, last_run_at = $3 WHERE id = $1", [source.id, message, deps.now()]);
        return done("rate_limited", { error: message, retryAfterMs: Math.round(err.retryAfterMs) });
      }
      if (attempt < MAX_ATTEMPTS) {
        const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        await deps.sleep(err && err.retryAfterMs ? Math.max(err.retryAfterMs, backoff) : backoff);
      }
    }
  }
  const message = errText(lastErr);
  await db().query("UPDATE js_sources SET status = 'unavailable', last_error = $2, last_run_at = $3 WHERE id = $1", [source.id, message, deps.now()]);
  return done("failed", { error: message });
}

/**
 * @param {{sourceKey?: string, candidateId?: number, manual?: boolean}} opts
 * @param {{now?: Function, sleep?: Function, fetch?: Function, lookup?: Function}} deps injectable for tests
 * @returns {Promise<{status: string, found: number, created: number, runs: object[]}>}
 */
async function runSearch(opts = {}, deps = {}) {
  const d = { now: deps.now || (() => new Date()), sleep: deps.sleep || realSleep, fetch: deps.fetch, lookup: deps.lookup, cache: new Map() };
  await ensureSources();
  if (await moduleIsPaused()) return { status: "module_paused", found: 0, created: 0, skipped_invalid: 0, runs: [] };

  let query = { keywords: [], countries: [], language: null };
  if (opts.candidateId !== undefined && opts.candidateId !== null) {
    const elig = await consentService.searchEligible(opts.candidateId);
    if (!elig.eligible) throw new HttpError(403, `Candidate is not eligible for search: ${elig.reasons.join(", ")}`);
    query = await buildCandidateQuery(opts.candidateId);
  }

  let adapters = registry.adapters();
  if (opts.sourceKey) {
    const a = registry.getAdapter(opts.sourceKey);
    if (!a) throw new HttpError(404, "Not found");
    adapters = [a];
  } else {
    adapters = adapters.filter((a) => a.status().status !== "manual");
  }

  const runs = [];
  for (const adapter of adapters) {
    const source = (await db().query("SELECT id, key FROM js_sources WHERE key = $1", [adapter.key])).rows[0];
    const slot = await reserveRun(source, d.now());
    if (slot.skipped) {
      runs.push(slot.skipped);
      continue;
    }
    runs.push(await runSource(source, adapter, query, d, slot.runId));
  }
  const statuses = [...new Set(runs.map((r) => r.status))];
  return {
    status: runs.length === 0 ? "no_sources" : statuses.length === 1 ? statuses[0] : "partial",
    found: runs.reduce((n, r) => n + r.found, 0),
    created: runs.reduce((n, r) => n + r.created, 0),
    skipped_invalid: runs.reduce((n, r) => n + (r.skipped_invalid || 0), 0),
    runs,
  };
}

const minuteBucket = () => Math.floor(Date.now() / 60000);

/**
 * Queues a "Search now". The caller has already authorised the request and checked eligibility; the
 * handler repeats every check when the job executes. One item per (source, candidate, minute).
 */
async function enqueueSearch({ sourceKey, candidateId, requestedBy }) {
  const job = await queue.enqueue({
    kind: "search",
    payload: { sourceKey: sourceKey || null, candidateId: candidateId || null, manual: true, requestedBy },
    idempotencyKey: `search:${sourceKey || "all"}:${candidateId || "all"}:${minuteBucket()}`,
  });
  return job;
}

/** Queue handler for kind 'search'. Anything that is no longer allowed becomes a recorded no-op. */
async function handleSearchJob(job, deps = {}) {
  const p = job.payload || {};
  const noop = (reason) => ({ status: "skipped", reason, found: 0, created: 0, runs: [] });
  if (p.scheduled === true && (p.requestedBy === undefined || p.requestedBy === null)) {
    // Scheduler-created item (Task 12; built server-side only): no requester. runSearch repeats the
    // module-pause, eligibility (searchEligible), source-pause and rate-limit checks at run time.
    if (!p.candidateId || !p.sourceKey) return noop("bad_scheduled_payload");
    try {
      return await runSearch({ sourceKey: p.sourceKey, candidateId: p.candidateId, manual: false }, deps);
    } catch (err) {
      if (err instanceof HttpError) return noop(`${err.status}: ${err.message}`);
      throw err;
    }
  }
  const u = await db().query("SELECT id, role, is_active FROM users WHERE id = $1", [p.requestedBy]);
  if (!u.rowCount || !u.rows[0].is_active) return noop("requester_inactive");
  const user = { id: u.rows[0].id, role: u.rows[0].role };
  const perms = PERMISSIONS[user.role] || [];
  const has = (x) => perms.includes("*") || perms.includes(x);
  if (!has("jobsearch:write")) return noop("requester_not_authorized");
  if (p.candidateId) {
    try {
      await assertCandidateAccess(user, p.candidateId);
    } catch {
      return noop("candidate_out_of_scope");
    }
  } else if (!has("jobsearch:admin")) return noop("requester_not_authorized");
  try {
    return await runSearch({ sourceKey: p.sourceKey || undefined, candidateId: p.candidateId || undefined, manual: true }, deps);
  } catch (err) {
    if (err instanceof HttpError) return noop(`${err.status}: ${err.message}`); // eligibility lost (consent withdrawn...), unknown source
    throw err;
  }
}

const handlers = { search: (job) => handleSearchJob(job) };

module.exports = { runSearch, ensureSources, buildCandidateQuery, runStatus, enqueueSearch, handleSearchJob, handlers, MAX_ATTEMPTS, MAX_INLINE_WAIT_MS };
