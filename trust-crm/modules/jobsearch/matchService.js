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
    overseas_applicants_evidence: row.overseas_applicants_evidence,
    first_seen: row.created_at,
    ...extra,
  };
}

/** Staff/employer confirmation for this employer or any application on this job; null if none. */
async function findConfirmation(client, job) {
  const r = await client.query(
    `SELECT ec.* FROM js_employer_confirmations ec
      WHERE btrim(coalesce(ec.evidence_text,'')) <> ''
        AND ((ec.employer_id IS NOT NULL AND ec.employer_id = $1)
             OR ec.application_id IN (SELECT id FROM js_applications WHERE job_id = $2))
      ORDER BY ec.id DESC LIMIT 1`,
    [job.employer_id, job.id]
  );
  return r.rows[0] || null;
}

/**
 * @param {number} candidateId
 * @param {{now?: Date}} [opts]
 * @returns {Promise<object[]>} stored matches at or above MATCH_MIN_SCORE ([] when the candidate is not search-eligible)
 */
async function matchCandidate(candidateId, opts = {}) {
  const threshold = opts.minScore ?? minScore();
  return inTx(async (client) => {
    // Same lock as consent grant/withdraw: a withdrawal and a match run serialise.
    const lock = await client.query("SELECT id FROM candidates WHERE id = $1 FOR UPDATE", [candidateId]);
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

    const stored = [];
    const keep = new Set();
    if (allowed.length) {
      const jobs = (await client.query(
        `SELECT j.*, e.name AS employer_name FROM js_jobs j LEFT JOIN js_employers e ON e.id = j.employer_id
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
        const confirmation = await findConfirmation(client, job);
        const r = scoreMatch(profile, prefs, job, { confirmation, now: opts.now });
        const hasApp = (await client.query("SELECT 1 FROM js_applications WHERE candidate_id = $1 AND job_id = $2", [candidateId, job.id])).rowCount > 0;
        if (r.score < threshold && !hasApp) {
          // Fell below the threshold after a profile/job change: remove the stale match.
          await client.query("DELETE FROM js_matches WHERE candidate_id = $1 AND job_id = $2", [candidateId, job.id]);
          continue;
        }
        const row = (await client.query(
          `INSERT INTO js_matches (candidate_id, job_id, score, reasons, missing, uncertain, employer_support, employer_support_evidence, overseas_applicants_evidence)
           VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9)
           ON CONFLICT (candidate_id, job_id) DO UPDATE SET
             score = EXCLUDED.score, reasons = EXCLUDED.reasons, missing = EXCLUDED.missing, uncertain = EXCLUDED.uncertain,
             employer_support = EXCLUDED.employer_support, employer_support_evidence = EXCLUDED.employer_support_evidence,
             overseas_applicants_evidence = EXCLUDED.overseas_applicants_evidence
           RETURNING *`,
          [candidateId, job.id, r.score, JSON.stringify(r.reasons), JSON.stringify(r.missing), JSON.stringify(r.uncertain), r.employerSupport.label, r.employerSupport.evidence, r.overseas.evidence]
        )).rows[0];
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

module.exports = { matchCandidate, minScore, findConfirmation };
