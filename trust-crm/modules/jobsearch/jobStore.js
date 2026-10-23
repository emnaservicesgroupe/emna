// Job store: sanitising, dedupe (hash key + canonical URL + 21-day fuzzy match), sightings, re-check.
// Job/ad text is UNTRUSTED: it is stored as inert text only and never interpreted as instructions.
const crypto = require("crypto");
const { HttpError } = require("./httpError");

const db = () => require("../../db");
const FUZZY_DAYS = 21;
const MAX = { title: 300, employer: 300, location: 300, country: 100, url: 2000, description: 20000 };

// ---------- sanitising ----------
function sanitizeText(input, max = MAX.description) {
  if (input === null || input === undefined) return "";
  let s = String(input);
  s = s.replace(/<(script|style|iframe|object|embed)\b[\s\S]*?(<\/\1\s*>|$)/gi, " ");
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, " ");
  s = s.replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]*>/g, " ");
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
  // entities may have re-introduced markup: strip again, then drop stray angle brackets
  s = s.replace(/<[^>]*>/g, " ").replace(/[<>]/g, " ");
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, "");
  s = s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.length > max ? s.slice(0, max) : s;
}
const oneLine = (v, max) => sanitizeText(v, max).replace(/\s+/g, " ").trim();

// ---------- normalisation ----------
function normalize(v) {
  return String(v || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const CORP_SUFFIX = /\s(inc|incorporated|ltd|limited|llc|llp|corp|corporation|co|company|gmbh|sarl|sa|plc)$/;
function normalizeEmployer(v) {
  let n = normalize(v);
  while (CORP_SUFFIX.test(n)) n = n.replace(CORP_SUFFIX, "");
  return n;
}
function normalizeCity(location) {
  return normalize(String(location || "").split(",")[0]);
}

function isoYearWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

function canonicalUrl(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  let path = u.pathname.replace(/\/+$/, "");
  if (path === "") path = "";
  return `${u.hostname}${u.port ? `:${u.port}` : ""}${path}${u.search}`;
}

function dedupeKey(employer, title, location, when) {
  return crypto.createHash("sha1").update(`${normalizeEmployer(employer)}|${normalize(title)}|${normalizeCity(location)}|${isoYearWeek(when)}`).digest("hex");
}

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function cleanRaw(raw) {
  const url = raw.url && canonicalUrl(raw.url) ? String(raw.url).trim().slice(0, MAX.url) : null;
  return {
    sourceJobId: oneLine(raw.sourceJobId, 500),
    url,
    title: oneLine(raw.title, MAX.title),
    employerName: oneLine(raw.employerName, MAX.employer),
    location: oneLine(raw.location, MAX.location),
    country: oneLine(raw.country, MAX.country),
    publishedAt: toDate(raw.publishedAt),
    closingAt: toDate(raw.closingAt),
    description: sanitizeText(raw.description, MAX.description),
  };
}

// ---------- upsert ----------
async function findByCanonicalUrl(client, canon) {
  if (!canon) return null;
  const hostPath = canon.split("?")[0];
  const like = `%${hostPath.replace(/[\\%_]/g, "\\$&")}%`;
  const r = await client.query(
    `SELECT id, url FROM js_jobs WHERE url ILIKE $1
     UNION SELECT j.id, s.url FROM js_job_sightings s JOIN js_jobs j ON j.id = s.job_id WHERE s.url ILIKE $1`,
    [like]
  );
  const hit = r.rows.find((row) => canonicalUrl(row.url) === canon);
  return hit ? hit.id : null;
}

async function upsertEmployer(client, name) {
  const norm = normalizeEmployer(name);
  if (!norm) return null;
  const r = await client.query("SELECT id FROM js_employers WHERE normalized_name = $1 ORDER BY id LIMIT 1", [norm]);
  if (r.rowCount) return r.rows[0].id;
  return (await client.query("INSERT INTO js_employers (name, normalized_name) VALUES ($1,$2) RETURNING id", [name, norm])).rows[0].id;
}

async function findFuzzy(client, employerId, title, city, now) {
  if (!employerId) return null;
  const since = new Date(now.getTime() - FUZZY_DAYS * 86400000);
  const r = await client.query(
    "SELECT id, title, location FROM js_jobs WHERE employer_id = $1 AND GREATEST(COALESCE(last_checked_at, created_at), created_at) >= $2",
    [employerId, since]
  );
  const nt = normalize(title);
  const hit = r.rows.find((row) => normalize(row.title) === nt && normalizeCity(row.location) === city);
  return hit ? hit.id : null;
}

/**
 * Stores one vacancy seen at `sourceId`. One vacancy from several sources -> ONE js_jobs row, one
 * sighting per (source, source_job_id). Repeats only refresh last_checked_at.
 * @returns {{job: object, created: boolean}}
 */
async function upsertJob(raw, sourceId, opts = {}) {
  const now = opts.now || new Date();
  const r = cleanRaw(raw || {});
  if (!r.title || !r.sourceJobId) throw new HttpError(400, "A job needs a title and a source job id");
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    // Serialise concurrent upserts of the same vacancy identity.
    const key = dedupeKey(r.employerName, r.title, r.location, r.publishedAt || now);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`js_job:${normalizeEmployer(r.employerName)}|${normalize(r.title)}|${normalizeCity(r.location)}`]);
    const src = await client.query("SELECT key FROM js_sources WHERE id = $1", [sourceId]);
    if (!src.rowCount) throw new HttpError(404, "Unknown source");
    const canon = canonicalUrl(r.url);

    let jobId = null;
    const sighting = await client.query("SELECT job_id FROM js_job_sightings WHERE source_id = $1 AND source_job_id = $2", [sourceId, r.sourceJobId]);
    if (sighting.rowCount) jobId = sighting.rows[0].job_id;
    if (!jobId) jobId = await findByCanonicalUrl(client, canon);
    if (!jobId) jobId = (await client.query("SELECT id FROM js_jobs WHERE dedupe_key = $1", [key])).rows[0]?.id || null;
    const employerId = await upsertEmployer(client, r.employerName);
    if (!jobId) jobId = await findFuzzy(client, employerId, r.title, normalizeCity(r.location), now);

    let created = false;
    if (jobId) {
      await client.query(
        `UPDATE js_jobs SET last_checked_at = $2,
           employer_id = COALESCE(employer_id, $3), url = COALESCE(url, $4), location = COALESCE(NULLIF(location,''), $5),
           country = COALESCE(NULLIF(country,''), $6), published_at = COALESCE(published_at, $7),
           closing_at = COALESCE($8, closing_at), description_text = COALESCE(NULLIF(description_text,''), $9),
           status = CASE WHEN COALESCE($8, closing_at) < $2 THEN 'expired' ELSE 'open' END
         WHERE id = $1`,
        [jobId, now, employerId, r.url, r.location || null, r.country || null, r.publishedAt, r.closingAt, r.description || null]
      );
    } else {
      const status = r.closingAt && r.closingAt < now ? "expired" : "open";
      const ins = await client.query(
        `INSERT INTO js_jobs (url, source_primary, employer_id, title, location, country, published_at, last_checked_at, closing_at, status, dedupe_key, description_text, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$8) RETURNING id`,
        [r.url, src.rows[0].key, employerId, r.title, r.location || null, r.country || null, r.publishedAt, now, r.closingAt, status, key, r.description || null]
      );
      jobId = ins.rows[0].id;
      created = true;
    }
    await client.query(
      `INSERT INTO js_job_sightings (job_id, source_id, source_job_id, url, seen_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (source_id, source_job_id) DO UPDATE SET seen_at = EXCLUDED.seen_at, url = COALESCE(EXCLUDED.url, js_job_sightings.url)`,
      [jobId, sourceId, r.sourceJobId, r.url, now]
    );
    const job = (await client.query("SELECT * FROM js_jobs WHERE id = $1", [jobId])).rows[0];
    await client.query("COMMIT");
    return { job, created };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------- re-check ----------
/**
 * Re-checks a stored vacancy: closing date in the past -> 'expired'; every sighting's adapter says
 * the job is gone (fetchDetail null or HTTP 404) -> 'closed'; otherwise 'open'. Transient errors
 * leave the status unchanged. Updates status and last_checked_at.
 */
async function recheckJob(jobId, opts = {}) {
  return (await recheckJobDetailed(jobId, opts)).status;
}

/**
 * recheckJob with provenance: `verified` is true only when the answer is definitive — the closing
 * date passed, every sighting's adapter says the job is gone, or a live (non-manual) adapter
 * returned it. When no source could confirm (unavailable / requires_setup / transient errors, or only
 * staff-entered manual sightings that read back our own row) the stored status is kept and
 * `verified` is false. Same writes as recheckJob (status + last_checked_at).
 * @returns {Promise<{status: string, verified: boolean, reason: string}>}
 */
async function recheckJobDetailed(jobId, opts = {}) {
  const now = opts.now || new Date();
  const registry = opts.registry || require("./sources");
  const j = await db().query("SELECT id, status, closing_at FROM js_jobs WHERE id = $1", [jobId]);
  if (!j.rowCount) throw new HttpError(404, "Not found");
  const job = j.rows[0];
  let status;
  let verified = true;
  let reason;
  if (job.closing_at && new Date(job.closing_at) < now) {
    status = "expired";
    reason = "closing_date_passed";
  } else {
    const sightings = await db().query(
      "SELECT s.source_job_id, src.key FROM js_job_sightings s JOIN js_sources src ON src.id = s.source_id WHERE s.job_id = $1 ORDER BY s.seen_at DESC",
      [jobId]
    );
    let open = false;
    let liveOpen = false;
    let gone = 0;
    let unknown = 0;
    let closing = null;
    for (const s of sightings.rows) {
      const adapter = registry.getAdapter(s.key);
      if (!adapter) {
        unknown += 1;
        continue;
      }
      try {
        const d = await adapter.fetchDetail(s.source_job_id, opts.ctx || {});
        if (d) {
          open = true;
          if (s.key !== "manual_import") liveOpen = true;
          if (d.closingAt && !Number.isNaN(new Date(d.closingAt).getTime())) closing = new Date(d.closingAt);
        } else gone += 1;
      } catch (err) {
        if (err && err.status === 404) gone += 1;
        else unknown += 1;
      }
    }
    if (closing && closing < now) {
      status = "expired";
      reason = "closing_date_passed";
    } else if (open) {
      status = "open";
      verified = liveOpen;
      reason = liveOpen ? "source_confirmed_open" : "manual_only";
    } else if (gone > 0 && unknown === 0) {
      status = "closed";
      reason = "all_sources_gone";
    } else {
      status = job.status; // could not verify: keep what we know, never guess
      verified = false;
      reason = "sources_unavailable";
    }
    if (closing) await db().query("UPDATE js_jobs SET closing_at = $2 WHERE id = $1", [jobId, closing]);
  }
  await db().query("UPDATE js_jobs SET status = $2, last_checked_at = $3 WHERE id = $1", [jobId, status, now]);
  return { status, verified, reason };
}

// ---------- manual import ----------
async function importManual(input, user, opts = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Body must be an object");
  const title = oneLine(input.title, MAX.title);
  const employerName = oneLine(input.employerName, MAX.employer);
  if (!title) throw new HttpError(400, "title is required");
  if (!employerName) throw new HttpError(400, "employerName is required");
  if (input.url !== undefined && input.url !== null && input.url !== "" && !canonicalUrl(input.url)) throw new HttpError(400, "url must be an http(s) URL");
  for (const f of ["publishedAt", "closingAt"]) {
    if (input[f] && !toDate(input[f])) throw new HttpError(400, `${f} is not a valid date`);
  }
  const { ensureSources } = require("./searchRunner");
  await ensureSources();
  const src = await db().query("SELECT id FROM js_sources WHERE key = 'manual_import'");
  const sourceJobId = `manual-${crypto.createHash("sha1").update(`${canonicalUrl(input.url) || ""}|${normalizeEmployer(employerName)}|${normalize(title)}|${normalizeCity(input.location)}`).digest("hex")}`;
  const out = await upsertJob({ sourceJobId, url: input.url || null, title, employerName, location: input.location, country: input.country, publishedAt: input.publishedAt, closingAt: input.closingAt, description: input.description }, src.rows[0].id, opts);
  await db().query("INSERT INTO js_audit_events (actor, action, detail) VALUES ($1,'job.manual_import',$2::jsonb)", [`user:${user.id}`, JSON.stringify({ jobId: out.job.id, created: out.created })]);
  return out;
}

module.exports = { upsertJob, recheckJob, recheckJobDetailed, importManual, sanitizeText, normalize, normalizeEmployer, normalizeCity, isoYearWeek, canonicalUrl, dedupeKey };
