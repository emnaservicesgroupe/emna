// Computes and stores explainable matches. Reads only: confirmed profile, preferences, settings and
// OPEN jobs. Never creates or changes applications. A match is a review aid, not an eligibility claim.
const consentService = require("./consentService");
const { scoreMatch, country, neutralize } = require("./matching");
const { normalize } = require("./jobStore");

const db = () => require("../../db");
const MAX_JOBS = 5000;

function minScore() {
  const n = Number.parseInt(process.env.MATCH_MIN_SCORE, 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 40;
}

async function inTx(fn) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function present(row, extra) {
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    job_id: row.job_id,
    score: row.score,
    reasons: row.reasons,
    missing: row.missing,
    uncertain: row.uncertain,
    employer_support: row.employer_support,
    employer_support_evidence: row.employer_support_evidence,
    employer_support_conflict: row.employer_support_conflict,
    overseas_accepted: row.overseas_accepted,
    overseas_applicants_evidence: row.overseas_applicants_evidence,
    first_seen: row.created_at,
    ...extra,
  };
}

/** Non-revoked confirmations indexed for lookup: job-scoped (job_id) or employer-wide (job_id NULL). */
async function loadConfirmations(client) {
  const rows = (await client.query(
    `SELECT * FROM js_employer_confirmations
      WHERE revoked_at IS NULL AND btrim(coalesce(evidence_text,'')) <> '' ORDER BY id DESC`
  )).rows;
  const byJob = new Map();
  const byEmployer = new Map();
  for (const r of rows) {
    if (r.job_id) { if (!byJob.has(r.job_id)) byJob.set(r.job_id, r); }
    else if (r.employer_id && !byEmployer.has(r.employer_id)) byEmployer.set(r.employer_id, r);
  }
  return (job) => byJob.get(job.id) || (job.employer_id ? byEmployer.get(job.employer_id) : null) || null;
}

const UPSERT = `INSERT INTO js_matches (candidate_id, job_id, score, reasons, missing, uncertain, employer_support, employer_support_evidence, employer_support_conflict, overseas_accepted, overseas_applicants_evidence)
  VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11)
  ON CONFLICT (candidate_id, job_id) DO UPDATE SET
    score = EXCLUDED.score, reasons = EXCLUDED.reasons, missing = EXCLUDED.missing, uncertain = EXCLUDED.uncertain,
    employer_support = EXCLUDED.employer_support, employer_support_evidence = EXCLUDED.employer_support_evidence,
    employer_support_conflict = EXCLUDED.employer_support_conflict,
    overseas_accepted = EXCLUDED.overseas_accepted, overseas_applicants_evidence = EXCLUDED.overseas_applicants_evidence
  RETURNING *`;

function upsertParams(candidateId, job, r) {
  return [candidateId, job.id, r.score, JSON.stringify(r.reasons), JSON.stringify(r.missing), JSON.stringify(r.uncertain),
    r.employerSupport.label, r.employerSupport.evidence, r.employerSupport.conflict === true, r.overseas.accepted, r.overseas.evidence];
}

/**
 * @param {number} candidateId
 * @param {{now?: Date, minScore?: number}} [opts]
 * @returns {Promise<object[]>} stored matches at or above MATCH_MIN_SCORE ([] when the candidate is not search-eligible)
 */
async function matchCandidate(candidateId, opts = {}) {
  const threshold = opts.minScore ?? minScore();
  return inTx(async (client) => {
    // Same lock as consent grant/withdraw: a withdrawal and a match run serialise.
    const lock = await client.query("SELECT id FROM candidates WHERE id = $1 AND is_deleted = false FOR UPDATE", [candidateId]);
    if (!lock.rowCount) return [];
    const elig = await consentService.searchEligible(candidateId);
    if (!elig.eligible) return [];

    const profile = (await client.query("SELECT confirmed FROM js_profiles WHERE candidate_id = $1", [candidateId])).rows[0]?.confirmed || {};
    const prefs = (await client.query("SELECT * FROM js_preferences WHERE candidate_id = $1", [candidateId])).rows[0] || {};
    const settings = (await client.query("SELECT allowed_countries, allowed_professions FROM js_candidate_settings WHERE candidate_id = $1", [candidateId])).rows[0] || {};
    const consent = await consentService.activeConsent(candidateId, "search", client);

    let allowed = (settings.allowed_countries || []).length ? settings.allowed_countries : prefs.countries || [];
    const consentCountries = (consent && consent.scope && consent.scope.countries) || [];
    allowed = allowed.map(country).filter(Boolean);
    if (consentCountries.length) {
      const cc = consentCountries.map(country);
      allowed = allowed.filter((c) => cc.includes(c));
    }
    const professions = (settings.allowed_professions || []).map(normalize).filter(Boolean);
    const withApp = new Set((await client.query("SELECT job_id FROM js_applications WHERE candidate_id = $1", [candidateId])).rows.map((r) => r.job_id));
    const confirmationFor = await loadConfirmations(client);

    const stored = [];
    const keep = new Set();
    if (allowed.length) {
      const jobs = (await client.query(
        `SELECT j.* FROM js_jobs j
          WHERE j.status = 'open' AND (j.closing_at IS NULL OR j.closing_at > $1)
          ORDER BY j.id LIMIT ${MAX_JOBS}`,
        [opts.now || new Date()]
      )).rows;
      for (const job of jobs) {
        const jc = country(job.country);
        if (!jc || !allowed.includes(jc)) continue;
        if (professions.length) {
          const hay = normalize(`${neutralize(job.title).text} ${neutralize(job.description_text).text}`);
          if (!professions.some((p) => ` ${hay} `.includes(` ${p} `))) continue;
        }
        keep.add(job.id);
        const r = scoreMatch(profile, prefs, job, { confirmation: confirmationFor(job), now: opts.now });
        if (r.score < threshold && !withApp.has(job.id)) {
          // Fell below the threshold after a profile/job change: remove the stale match.
          await client.query("DELETE FROM js_matches WHERE candidate_id = $1 AND job_id = $2", [candidateId, job.id]);
          continue;
        }
        // Every run rewrites score AND labels (support, conflict, overseas), even when the score is unchanged.
        const row = (await client.query(UPSERT, upsertParams(candidateId, job, r))).rows[0];
        stored.push(present(row, { overseas: r.overseas, breakdown: r.breakdown }));
      }
    }
    // Matches for jobs that are no longer open/in scope are dropped unless an application exists.
    await client.query(
      `DELETE FROM js_matches m WHERE m.candidate_id = $1 AND NOT (m.job_id = ANY($2::int[]))
         AND NOT EXISTS (SELECT 1 FROM js_applications a WHERE a.candidate_id = m.candidate_id AND a.job_id = m.job_id)`,
      [candidateId, [...keep]]
    );
    return stored.sort((a, b) => b.score - a.score || a.job_id - b.job_id);
  });
}

/**
 * Locks (FOR UPDATE, id order) every live candidate that has a match on the given jobs, plus
 * `extraCandidateIds` (e.g. the candidate of an application a confirmation will reference). Call it
 * BEFORE touching js_employer_confirmations/js_applications so the lock order is always
 * candidates -> applications, as in consent/approval paths. Deleted candidates are not locked.
 * @returns {Promise<number[]>} the locked candidate ids
 */
async function lockForRelabel(client, jobIds, extraCandidateIds = []) {
  const fromMatches = jobIds.length
    ? (await client.query("SELECT DISTINCT candidate_id FROM js_matches WHERE job_id = ANY($1::int[])", [jobIds])).rows.map((r) => r.candidate_id)
    : [];
  const ids = [...new Set([...fromMatches, ...extraCandidateIds.filter((x) => Number.isSafeInteger(x))])];
  if (!ids.length) return [];
  return (await client.query("SELECT id FROM candidates WHERE id = ANY($1::int[]) AND is_deleted = false ORDER BY id FOR UPDATE", [ids])).rows.map((r) => r.id);
}

/**
 * Re-scores EXISTING matches on the given jobs (after a confirmation is recorded or revoked) so the
 * label, score, reasons and notes never go stale. Only rows of the candidates locked by
 * lockForRelabel are touched (rows of deleted or unlocked candidates are skipped); match rows are read
 * after the lock. Never creates or deletes matches; created_at is untouched (pruning below the
 * threshold still happens only in matchCandidate).
 * @param {{now?: Date, candidateIds?: number[]}} [opts] candidateIds: the set returned by lockForRelabel (locked here when omitted)
 */
async function relabelJobs(client, jobIds, opts = {}) {
  if (!jobIds.length) return 0;
  const locked = opts.candidateIds || (await lockForRelabel(client, jobIds));
  if (!locked.length) return 0;
  const rows = (await client.query(
    "SELECT candidate_id, job_id FROM js_matches WHERE job_id = ANY($1::int[]) AND candidate_id = ANY($2::int[]) ORDER BY candidate_id, job_id",
    [jobIds, locked]
  )).rows;
  if (!rows.length) return 0;
  const confirmationFor = await loadConfirmations(client);
  const jobs = new Map((await client.query("SELECT * FROM js_jobs WHERE id = ANY($1::int[])", [jobIds])).rows.map((j) => [j.id, j]));
  const cache = new Map();
  for (const { candidate_id: cid, job_id: jid } of rows) {
    if (!cache.has(cid)) {
      cache.set(cid, {
        profile: (await client.query("SELECT confirmed FROM js_profiles WHERE candidate_id = $1", [cid])).rows[0]?.confirmed || {},
        prefs: (await client.query("SELECT * FROM js_preferences WHERE candidate_id = $1", [cid])).rows[0] || {},
      });
    }
    const job = jobs.get(jid);
    const { profile, prefs } = cache.get(cid);
    const r = scoreMatch(profile, prefs, job, { confirmation: confirmationFor(job), now: opts.now });
    await client.query(
      `UPDATE js_matches SET score = $3, reasons = $4::jsonb, missing = $5::jsonb, uncertain = $6::jsonb,
         employer_support = $7, employer_support_evidence = $8, employer_support_conflict = $9,
         overseas_accepted = $10, overseas_applicants_evidence = $11
       WHERE candidate_id = $1 AND job_id = $2`,
      upsertParams(cid, job, r)
    );
  }
  return rows.length;
}

module.exports = { matchCandidate, relabelJobs, lockForRelabel, minScore };
