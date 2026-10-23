// Search runner: drives source adapters, stores jobs, records js_runs.
// js_runs has no status/error columns (migration 002 is fixed), so the outcome of a run that did
// not finish normally is recorded as errors = [{status, message, attempts}]; an empty errors
// array means status 'ok'.
const { HttpError } = require("./httpError");
const registry = require("./sources");
const { SourceNotConnected } = require("./sources/errors");
const jobStore = require("./jobStore");
const consentService = require("./consentService");

const db = () => require("../../db");
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_COUNTRIES = 5;

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

async function recentCalls(sourceId, now) {
  const since = new Date(now.getTime() - 60000);
  const r = await db().query(
    "SELECT count(*)::int AS n FROM js_runs WHERE source_id = $1 AND started_at > $2 AND (errors = '[]'::jsonb OR errors->0->>'status' = 'failed')",
    [sourceId, since]
  );
  return r.rows[0].n;
}

async function finishRun(runId, now, { found, created, errors }) {
  await db().query("UPDATE js_runs SET finished_at = $2, found = $3, new_count = $4, errors = $5::jsonb WHERE id = $1", [runId, now, found, created, JSON.stringify(errors)]);
}

async function runSource(source, adapter, query, deps) {
  const now = deps.now();
  const run = (await db().query("INSERT INTO js_runs (source_id, started_at) VALUES ($1,$2) RETURNING id", [source.id, now])).rows[0].id;
  const out = { sourceKey: source.key, runId: run, status: "ok", found: 0, created: 0, attempts: 0 };
  const done = async (status, extra = {}) => {
    Object.assign(out, { status }, extra);
    const errors = status === "ok" ? [] : [{ status, message: out.error || null, attempts: out.attempts }];
    await finishRun(run, deps.now(), { found: out.found, created: out.created, errors });
    return out;
  };

  const st = adapter.status();
  if (st.status === "manual") return done("manual", { error: null });
  if (st.status !== "connected") {
    await db().query("UPDATE js_sources SET status = $2, last_error = $3, last_run_at = $4 WHERE id = $1", [source.id, st.status, st.detail, now]);
    return done("requires_setup", { error: st.detail });
  }

  const ctx = { fetch: deps.fetch, lookup: deps.lookup, now: deps.now };
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
      for (const raw of raws) {
        const r = await jobStore.upsertJob(raw, source.id, { now: deps.now() });
        if (r.created) created += 1;
      }
      await db().query("UPDATE js_sources SET status = $2, last_error = NULL, last_run_at = $3 WHERE id = $1", [source.id, st.status, deps.now()]);
      return done("ok", { found: raws.length, created });
    } catch (err) {
      lastErr = err;
      if (err instanceof SourceNotConnected) {
        await db().query("UPDATE js_sources SET status = 'requires_setup', last_error = $2, last_run_at = $3 WHERE id = $1", [source.id, errText(err), deps.now()]);
        return done("requires_setup", { error: errText(err) });
      }
      if (err && err.retriable === false) break; // refused by the safety rules / auth required: retrying cannot help
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
  const d = { now: deps.now || (() => new Date()), sleep: deps.sleep || realSleep, fetch: deps.fetch, lookup: deps.lookup };
  await ensureSources();
  if (await moduleIsPaused()) return { status: "module_paused", found: 0, created: 0, runs: [] };

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
    const source = (await db().query("SELECT id, key, paused, rate_limit_per_min FROM js_sources WHERE key = $1", [adapter.key])).rows[0];
    const skip = async (status, message) => {
      const r = (await db().query("INSERT INTO js_runs (source_id, started_at, finished_at, errors) VALUES ($1,$2,$2,$3::jsonb) RETURNING id", [source.id, d.now(), JSON.stringify([{ status, message, attempts: 0 }])])).rows[0].id;
      runs.push({ sourceKey: source.key, runId: r, status, found: 0, created: 0, attempts: 0, error: message });
    };
    if (source.paused) {
      await skip("paused", "Source is paused");
      continue;
    }
    const limit = source.rate_limit_per_min;
    if (limit && (await recentCalls(source.id, d.now())) >= limit) {
      await skip("rate_limited", `Per-source rate limit of ${limit}/min reached`);
      continue;
    }
    runs.push(await runSource(source, adapter, query, d));
  }
  const statuses = [...new Set(runs.map((r) => r.status))];
  return {
    status: runs.length === 0 ? "no_sources" : statuses.length === 1 ? statuses[0] : "partial",
    found: runs.reduce((n, r) => n + r.found, 0),
    created: runs.reduce((n, r) => n + r.created, 0),
    runs,
  };
}

module.exports = { runSearch, ensureSources, buildCandidateQuery, MAX_ATTEMPTS };
