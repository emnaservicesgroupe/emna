// PDF / Excel reports, the "Canada Job Search Activity Report", immutable snapshots and the scheduled company snapshots (Stage 8, task 3).
//
//   buildCompanyReport(user, {period, from, to, groupBy})        company numbers = reportService.report() (called, never re-implemented)
//   buildCandidateActivityReport(user, candidateId, {from, to, lang})
//   renderPdf(model) / renderXlsx(model)                         (reportRender.js)
//   generate...()                                                 build + render + store + snapshot row + audit, in one transaction
//   listSnapshots / openSnapshot                                  scoped reads
//   ensureScheduledSnapshots({now})                               daily / weekly / monthly company snapshots (scheduler.js, off by default)
//   getSettings / updateSettings                                  report_timezone, report_schedule_enabled
//
// Rules: every number comes from SQL over real rows; dates are cut in the REPORT timezone (Postgres is the only timezone authority:
// day boundaries and local dates are computed with AT TIME ZONE); the verified list holds only submissions the provider accepted
// (status sent / confirmed_submitted) - never raw evidence JSON, recipient addresses or staff notes; other candidates' data never enters a
// candidate report; nothing is invented (an empty period shows zeros and empty lists).
const crypto = require("crypto");
const { HttpError } = require("./httpError");
const reports = require("./reportService");
const { assertCandidateAccess, candidateScopeSql, isAdmin } = require("./scope");
const { stableStringify, winAnsiOk } = require("./cvGenerator");
const render = require("./reportRender");
const storage = require("./storage");
const { auditJs } = require("../../utils/audit");
const hr = require("../hr/common");

const db = () => require("../../db");

const LANGS = ["en", "fr", "ar"];
const FORMATS = ["pdf", "xlsx"];
const PERIODS = ["day", "week", "month"];
const MIME = { pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 3600 * 1000;
const SYSTEM_ACTOR = "system:scheduler";
// Internal read identity for the numbers of one already-authorised candidate / the scheduler. Never built from a request.
const SYSTEM_READER = Object.freeze({ id: null, role: "SuperAdmin" });
const PENDING_STATUSES = ["preparing", "ready_for_review", "approved", "queued"];
const ATTENTION_STATUSES = ["failed", "outcome_unknown", "needs_staff"];

const maxRows = () => {
  const n = Number(process.env.JOBSEARCH_REPORT_MAX_ROWS);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 20000) : 2000;
};
const ratePerHour = () => {
  const n = Number(process.env.JOBSEARCH_REPORT_RATE_PER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : 30;
};

const hits = new Map(); // userId -> timestamps
function rateLimit(userId) {
  const now = Date.now();
  const hour = 3600 * 1000;
  const list = (hits.get(userId) || []).filter((t) => now - t < hour);
  if (list.length >= ratePerHour()) {
    hits.set(userId, list);
    const e = new HttpError(429, "Report generation rate limit reached; try again later");
    e.retryAfter = Math.max(1, Math.ceil((hour - (now - list[0])) / 1000));
    throw e;
  }
  list.push(now);
  hits.set(userId, list);
  if (hits.size > 10000) for (const [k, v] of hits) if (!v.some((t) => now - t < hour)) hits.delete(k);
}
const _resetRateLimit = () => hits.clear();

// ---------------------------------------------------------------- settings (report_timezone, report_schedule_enabled)

const SETTINGS_KEY = "report_settings";
let warnedTz = null;

async function readStored() {
  const r = await db().query("SELECT value FROM js_module_state WHERE key = $1", [SETTINGS_KEY]);
  return r.rowCount && r.rows[0].value && typeof r.rows[0].value === "object" ? r.rows[0].value : {};
}

async function zoneExists(name) {
  return (await db().query("SELECT 1 FROM pg_timezone_names WHERE name = $1 LIMIT 1", [name])).rowCount > 0;
}

/**
 * Effective settings. Timezone: the stored value, else REPORT_TIMEZONE, else HR_TIMEZONE, else Africa/Tunis - each checked against
 * pg_timezone_names (exact name, as the HR module does); an unknown value is skipped (logged once, without data).
 * Schedule: the stored value, else REPORT_SCHEDULE_ENABLED (true / 1 / yes / on), else false.
 */
async function getSettings() {
  const stored = await readStored();
  let timezone = null;
  let source = "default";
  const candidates = [
    ["stored", stored.timezone],
    ["env", String(process.env.REPORT_TIMEZONE || "").trim()],
  ];
  for (const [src, v] of candidates) {
    if (typeof v !== "string" || !v) continue;
    if (await zoneExists(v)) {
      timezone = v;
      source = src;
      break;
    }
    if (warnedTz !== `${src}:${v}`) {
      warnedTz = `${src}:${v}`;
      console.error(`report timezone from ${src} setting is not a name known to the database (pg_timezone_names); ignored`);
    }
  }
  if (!timezone) {
    await hr.ensureTimezones(db());
    timezone = hr.companyTimezone();
    source = process.env.HR_TIMEZONE ? "hr_timezone" : "default";
  }
  const envOn = /^(1|true|yes|on)$/i.test(String(process.env.REPORT_SCHEDULE_ENABLED || "").trim());
  const scheduleEnabled = typeof stored.scheduleEnabled === "boolean" ? stored.scheduleEnabled : envOn;
  return {
    report_timezone: timezone,
    report_timezone_source: source,
    report_schedule_enabled: scheduleEnabled,
    report_schedule_enabled_source: typeof stored.scheduleEnabled === "boolean" ? "stored" : envOn ? "env" : "default",
  };
}

/** Admin / SuperAdmin only. report_timezone: a pg_timezone_names name, or null to go back to the environment / default. */
async function updateSettings(user, patch) {
  if (!user || !reports.hasPerm(user, "jobsearch:admin")) throw new HttpError(403, "Administrator access required");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "patch must be an object");
  const keys = Object.keys(patch);
  if (!keys.length) throw new HttpError(400, "No settings to update");
  for (const k of keys) if (k !== "report_timezone" && k !== "report_schedule_enabled") throw new HttpError(400, `Unknown setting: ${k}`);
  const change = {};
  if ("report_timezone" in patch) {
    change.timezone = patch.report_timezone === null ? null : await hr.validTimezone(db(), patch.report_timezone, "report_timezone");
  }
  if ("report_schedule_enabled" in patch) {
    if (typeof patch.report_schedule_enabled !== "boolean") throw new HttpError(400, "report_schedule_enabled must be true or false");
    change.scheduleEnabled = patch.report_schedule_enabled;
  }
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const cur = (await client.query("SELECT value FROM js_module_state WHERE key = $1 FOR UPDATE", [SETTINGS_KEY])).rows[0];
    const before = cur && cur.value && typeof cur.value === "object" ? cur.value : {};
    const next = { ...before, ...change };
    if (next.timezone === null) delete next.timezone;
    await client.query(
      "INSERT INTO js_module_state (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [SETTINGS_KEY, JSON.stringify(next)]
    );
    await auditJs({ client, userId: user.id, action: "report.settings", entity: "js_module_state", entityId: SETTINGS_KEY, detail: { changed: Object.keys(patch), values: patch } });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getSettings();
}

// ---------------------------------------------------------------- dates and ranges (all in the report timezone)

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseLocalDate(v, k) {
  if (typeof v !== "string" || !DATE_ONLY.test(v)) throw new HttpError(400, `${k} must be a date (YYYY-MM-DD) in the report timezone`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new HttpError(400, `${k} is not a valid date`);
  return v;
}

/**
 * Local days from..to (inclusive) -> UTC instants [start of `from` local day, start of the day after `to`). Default: the 30 local days
 * ending today. Max 366 days (local days and elapsed time, so a daylight-saving week cannot slip past the cap).
 */
async function resolveRange(tz, { from, to } = {}, now = new Date()) {
  const hasFrom = from !== undefined && from !== null && from !== "";
  const hasTo = to !== undefined && to !== null && to !== "";
  const today = (await db().query("SELECT to_char($1::timestamptz AT TIME ZONE $2::text, 'YYYY-MM-DD') AS d", [now, tz])).rows[0].d;
  const toDate = hasTo ? parseLocalDate(to, "to") : today;
  const fromDate = hasFrom
    ? parseLocalDate(from, "from")
    : (await db().query("SELECT to_char($1::date - 29, 'YYYY-MM-DD') AS d", [toDate])).rows[0].d;
  const r = (
    await db().query(
      `SELECT (($1::date)::timestamp AT TIME ZONE $3::text) AS f, (($2::date + 1)::timestamp AT TIME ZONE $3::text) AS t, ($2::date - $1::date + 1) AS days`,
      [fromDate, toDate, tz]
    )
  ).rows[0];
  if (r.days < 1) throw new HttpError(400, "from must not be after to");
  if (r.days > MAX_RANGE_DAYS || r.t.getTime() - r.f.getTime() > MAX_RANGE_DAYS * DAY_MS) throw new HttpError(400, `the date range may not exceed ${MAX_RANGE_DAYS} days`);
  return { fromDate, toDate, from: r.f, to: r.t };
}

const localStamp = async (instant, tz) =>
  (await db().query("SELECT to_char($1::timestamptz AT TIME ZONE $2::text, 'YYYY-MM-DD HH24:MI') AS s", [instant, tz])).rows[0].s;

// ---------------------------------------------------------------- header and flags

/** Company facts that are actually configured; nothing else. */
function companyHeader(env = process.env) {
  const g = (k) => render.cleanText(String(env[k] || "").trim(), 200);
  const name = g("FIN_COMPANY_NAME") || g("SITE_NAME");
  return [name, g("FIN_COMPANY_ADDRESS"), g("SITE_EMAIL"), g("SITE_PHONE")].filter(Boolean);
}

function collectStrings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectStrings(x, out));
  return out;
}

function flagsFor(model) {
  const flags = [];
  if (model.lang === "ar") flags.push("pdf_font_arabic_unavailable");
  const texts = collectStrings({ c: model.candidate, s: model.sent, n: model.nextActions, r: model.rows, h: model.header });
  if (texts.some((t) => t && !winAnsiOk(t))) flags.push("pdf_non_latin_text");
  return flags;
}

// ---------------------------------------------------------------- company report

function requireReportReader(user) {
  if (!user) throw new HttpError(401, "Access denied");
  if (user.role === "Candidate" || !reports.hasPerm(user, "jobsearch:read")) throw new HttpError(403, "Access denied");
}

function scopeLabel(user) {
  return isAdmin(user) ? "all" : "assigned";
}

/** Numbers from reportService.report() for the instants [from, to); `user` decides the scope exactly as for the JSON report. */
async function companyModel({ user, tz, fromDate, toDate, from, to, groupBy, period, now, scope }) {
  const query = { from: from.toISOString(), to: to.toISOString() };
  if (groupBy) query.groupBy = groupBy;
  if (period) query.period = period;
  const rep = await reports.report({ user, query, tz });
  if (rep.rows.length > maxRows()) throw new HttpError(413, "The report has too many rows; narrow the date range or group differently");
  const model = {
    type: "company",
    version: 1,
    header: companyHeader(),
    timezone: tz,
    period: { from: fromDate, to: toDate, fromInstant: from.toISOString(), toInstant: to.toISOString() },
    generatedAt: now.toISOString(),
    generatedAtLocal: await localStamp(now, tz),
    groupBy: rep.groupBy,
    bucket: rep.groupBy === "period" ? rep.period : null,
    scope: scope || rep.scope,
    filters: rep.filters,
    metrics: rep.metrics,
    rows: rep.rows,
    totals: rep.totals,
  };
  model.flags = flagsFor(model);
  return model;
}

async function buildCompanyReport(user, { period, from, to, groupBy, now = new Date() } = {}) {
  requireReportReader(user);
  if (groupBy !== undefined && groupBy !== "" && !reports.GROUPS.includes(groupBy)) throw new HttpError(400, `groupBy must be one of ${reports.GROUPS.join(", ")}`);
  if (period !== undefined && period !== "" && !PERIODS.includes(period)) throw new HttpError(400, `period must be one of ${PERIODS.join(", ")}`);
  const { report_timezone: tz } = await getSettings();
  const range = await resolveRange(tz, { from, to }, now);
  return companyModel({ user, tz, ...range, groupBy: groupBy || undefined, period: period || undefined, now });
}

// ---------------------------------------------------------------- candidate activity report

async function candidateIdOf(user, requested) {
  if (!user) throw new HttpError(401, "Access denied");
  if (user.role === "Candidate") {
    const own = await db().query(
      "SELECT a.candidate_id FROM js_candidate_accounts a JOIN candidates c ON c.id = a.candidate_id AND c.is_deleted = false WHERE a.user_id = $1",
      [user.id]
    );
    if (!own.rowCount) throw new HttpError(404, "Not found");
    const id = own.rows[0].candidate_id;
    if (requested !== undefined && requested !== null && Number(requested) !== id) throw new HttpError(404, "Not found");
    return id;
  }
  if (!reports.hasPerm(user, "jobsearch:read")) throw new HttpError(403, "Access denied");
  await assertCandidateAccess(user, requested); // 404 outside the staff member's scope
  return Number(requested);
}

const refTail = (providerId) => {
  if (typeof providerId !== "string") return null;
  const local = providerId.replace(/[<>\s]/g, "").split("@")[0];
  const tail = local.replace(/[^A-Za-z0-9]/g, "").slice(-8);
  return tail ? `...${tail}` : null;
};

async function buildCandidateActivityReport(user, candidateId, { from, to, lang, now = new Date() } = {}) {
  const L = lang === undefined || lang === "" ? "en" : lang;
  if (!LANGS.includes(L)) throw new HttpError(400, `lang must be one of ${LANGS.join(", ")}`);
  const id = await candidateIdOf(user, candidateId);
  const audience = user.role === "Candidate" ? "candidate" : "staff";
  const { report_timezone: tz } = await getSettings();
  const range = await resolveRange(tz, { from, to }, now);
  const c = db();

  const cand = (await c.query("SELECT reference, full_name FROM candidates WHERE id = $1 AND is_deleted = false", [id])).rows[0];
  if (!cand) throw new HttpError(404, "Not found");

  // Counts: the same function as the JSON report (so the numbers are identical), restricted to this one candidate.
  const rep = await reports.report({
    user: SYSTEM_READER,
    query: { candidateId: String(id), from: range.from.toISOString(), to: range.to.toISOString(), groupBy: "candidate" },
    tz,
  });
  const t = rep.totals;
  let replies = t.replies;
  if (audience === "candidate") {
    // a candidate's own view counts only the replies staff shared with them (as the candidate dashboard does)
    replies = (
      await c.query(
        `SELECT count(*)::int AS n FROM js_messages mg JOIN js_applications a ON a.id = mg.application_id
          WHERE a.candidate_id = $1 AND mg.direction = 'in' AND mg.review_state IN ('matched','resolved') AND mg.shared_with_candidate = true
            AND COALESCE(mg.received_at, mg.created_at) >= $2 AND COALESCE(mg.received_at, mg.created_at) < $3`,
        [id, range.from, range.to]
      )
    ).rows[0].n;
  }

  const cv = (
    await c.query(
      `SELECT count(DISTINCT (language, version)) FILTER (WHERE staff_approved_at >= $2 AND staff_approved_at < $3)::int AS in_period,
              bool_or(staff_approved_at < $3) AS to_date
         FROM js_cv_files WHERE candidate_id = $1 AND kind = 'canadian' AND staff_approved_at IS NOT NULL`,
      [id, range.from, range.to]
    )
  ).rows[0];

  // Verified list: provider-accepted submissions only. No evidence JSON, no recipient, no notes.
  const sentRows = (
    await c.query(
      `SELECT s.status, s.provider_message_id, j.title, e.name AS employer, to_char(s.sent_at AT TIME ZONE $4::text, 'YYYY-MM-DD') AS local_date
         FROM js_submissions s JOIN js_applications a ON a.id = s.application_id JOIN js_jobs j ON j.id = a.job_id LEFT JOIN js_employers e ON e.id = j.employer_id
        WHERE a.candidate_id = $1 AND s.status IN ('sent','confirmed_submitted') AND s.sent_at >= $2 AND s.sent_at < $3
        ORDER BY s.sent_at, s.id LIMIT $5`,
      [id, range.from, range.to, tz, maxRows() + 1]
    )
  ).rows;
  if (sentRows.length > maxRows()) throw new HttpError(413, "The report has too many rows; narrow the date range");

  const st = (
    await c.query(
      `SELECT count(*) FILTER (WHERE status = ANY($2::text[]))::int AS pending, count(*) FILTER (WHERE status = ANY($3::text[]))::int AS attention
         FROM js_applications WHERE candidate_id = $1`,
      [id, PENDING_STATUSES, ATTENTION_STATUSES]
    )
  ).rows[0];

  const planned = (
    await c.query(
      `SELECT a.status, j.title, e.name AS employer FROM js_applications a JOIN js_jobs j ON j.id = a.job_id LEFT JOIN js_employers e ON e.id = j.employer_id
        WHERE a.candidate_id = $1 AND a.status IN ('queued','approved') ORDER BY a.updated_at, a.id LIMIT 50`,
      [id]
    )
  ).rows;
  const interviews = (
    await c.query(
      `SELECT ap.status, j.title, e.name AS employer, to_char(ap.starts_at AT TIME ZONE $3::text, 'YYYY-MM-DD HH24:MI') AS local_start
         FROM js_appointments ap LEFT JOIN js_applications a ON a.id = ap.application_id LEFT JOIN js_jobs j ON j.id = a.job_id LEFT JOIN js_employers e ON e.id = j.employer_id
        WHERE ap.candidate_id = $1 AND ap.status IN ('tentative','confirmed') AND ap.starts_at >= $2 ORDER BY ap.starts_at, ap.id LIMIT 50`,
      [id, now, tz]
    )
  ).rows;

  const model = {
    type: "candidate_activity",
    version: 1,
    lang: L,
    audience,
    header: companyHeader(),
    candidate: { reference: cand.reference || null, name: render.cleanText(cand.full_name, 200) },
    timezone: tz,
    period: { from: range.fromDate, to: range.toDate, fromInstant: range.from.toISOString(), toInstant: range.to.toISOString() },
    generatedAt: now.toISOString(),
    generatedAtLocal: await localStamp(now, tz),
    activities: {
      cvVersionsApproved: cv.in_period || 0,
      cvApproved: cv.to_date === true,
      matchesProposed: t.matched,
      applicationsPrepared: t.prepared,
      applicationsSent: sentRows.length,
      applicationsPending: st.pending,
      needsAttention: st.attention,
      employerReplies: replies,
      interviews: t.interviews,
    },
    sent: sentRows.map((r) => ({
      employer: render.cleanText(r.employer, 200),
      position: render.cleanText(r.title, 200),
      date: r.local_date,
      status: r.status,
      evidence: refTail(r.provider_message_id),
    })),
    nextActions: [
      ...planned.map((r) => ({ type: r.status, employer: render.cleanText(r.employer, 200), position: render.cleanText(r.title, 200), when: null })),
      ...interviews.map((r) => ({ type: r.status === "confirmed" ? "interview_confirmed" : "interview_tentative", employer: render.cleanText(r.employer, 200), position: render.cleanText(r.title, 200), when: r.local_start })),
    ],
    disclaimer: render.DISCLAIMER[L],
  };
  model.flags = flagsFor(model);
  return model;
}

// ---------------------------------------------------------------- snapshots

const payloadHash = (model) => crypto.createHash("sha256").update(stableStringify(model)).digest("hex");

/**
 * Renders both files, stores them, inserts the insert-only snapshot row and the audit rows in ONE transaction.
 * `before(client)` runs first inside the transaction (the scheduler takes its advisory lock there and may return 'skip').
 * @returns {Promise<{id, kind, model, pdf, xlsx, created}>}  created=false when `before` answered 'skip'
 */
async function persistSnapshot({ kind, model, build, scopeCandidateId = null, generatedBy = null, actor, before, auditExtra = {}, now = new Date() }) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    if (before && (await before(client)) === "skip") {
      await client.query("ROLLBACK");
      return { created: false };
    }
    const m = model || (await build());
    const pdf = await render.renderPdf(m);
    const xlsx = await render.renderXlsx(m);
    const owner = scopeCandidateId || 0;
    const pdfFile = await storage.putGenerated(pdf, { ext: "pdf", candidateId: owner });
    const xlsxFile = await storage.putGenerated(xlsx, { ext: "xlsx", candidateId: owner });
    const hash = payloadHash(m);
    const row = (
      await client.query(
        `INSERT INTO js_report_snapshots (kind, scope_candidate_id, period_start, period_end, timezone, generated_by, generated_at, payload, payload_sha256, pdf_key, xlsx_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING id`,
        [kind, scopeCandidateId, m.period.fromInstant, m.period.toInstant, m.timezone, generatedBy, now, JSON.stringify(m), hash, pdfFile.key, xlsxFile.key]
      )
    ).rows[0];
    await auditJs({
      client,
      userId: generatedBy,
      actor,
      action: "report.generate",
      entity: "js_report_snapshots",
      entityId: row.id,
      candidateId: scopeCandidateId,
      detail: { snapshotId: Number(row.id), kind, from: m.period.from, to: m.period.to, timezone: m.timezone, payloadSha256: hash, flags: m.flags, ...auditExtra },
    });
    await client.query("COMMIT");
    return { created: true, id: Number(row.id), kind, model: m, pdf, xlsx };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err && err.code === "FILE_TOO_LARGE") throw new HttpError(413, "The generated file is too large");
    throw err;
  } finally {
    client.release();
  }
}

/** GET /reports/export: company numbers as PDF / XLSX (one snapshot row, kind 'custom'). */
async function exportCompanyReport(user, query = {}, { now = new Date() } = {}) {
  requireReportReader(user);
  rateLimit(user.id);
  const model = await buildCompanyReport(user, { period: query.period, from: query.from, to: query.to, groupBy: query.groupBy, now });
  const out = await persistSnapshot({ kind: "custom", model, generatedBy: user.id, now, auditExtra: { groupBy: model.groupBy, scope: model.scope, role: user.role } });
  return { ...out, filename: (format) => companyFileName(model, format) };
}

/** Activity report of one candidate (staff in scope, or the candidate's own record). One snapshot row, kind 'candidate_activity'. */
async function exportCandidateActivity(user, candidateId, query = {}, { now = new Date() } = {}) {
  const id = await candidateIdOf(user, candidateId); // 404 before any work
  rateLimit(user.id);
  const model = await buildCandidateActivityReport(user, id, { from: query.from, to: query.to, lang: query.lang, now });
  const out = await persistSnapshot({
    kind: "candidate_activity",
    model,
    scopeCandidateId: id,
    generatedBy: user.id,
    now,
    auditExtra: { lang: model.lang, audience: model.audience, role: user.role },
  });
  return { ...out, filename: (format) => activityFileName(model, format) };
}

// ---------------------------------------------------------------- file names (never from request values)

const REF_RE = /^CAN-[0-9]{4}-[0-9]{4,}$/;
function activityFileName(model, format) {
  const ext = FORMATS.includes(format) ? format : "bin";
  const ref = model.candidate && REF_RE.test(model.candidate.reference || "") ? model.candidate.reference : null;
  const { from, to } = model.period || {};
  if (ref && DATE_ONLY.test(from) && DATE_ONLY.test(to)) return `${ref}-activity-${from}_${to}.${ext}`;
  return `activity-report.${ext}`;
}
function companyFileName(model, format, kind = "report") {
  const ext = FORMATS.includes(format) ? format : "bin";
  const { from, to } = model.period || {};
  if (DATE_ONLY.test(from) && DATE_ONLY.test(to) && /^[a-z]{3,20}$/.test(kind)) return `vita-${kind}-${from}_${to}.${ext}`;
  return `vita-report.${ext}`;
}

// ---------------------------------------------------------------- snapshot reads

const COMPANY_VIEWERS = new Set(["Admin", "SuperAdmin", "Manager"]);

/**
 * WHERE fragment (alias s) of the snapshots `user` may see; parameters appended to `p`.
 *   candidate-level  scope_candidate_id set     -> the candidate is in the user's scope NOW (candidateScopeSql, not deleted)
 *   scheduled company daily / weekly / monthly  -> Admin, SuperAdmin, Manager
 *   custom company   kind 'custom', no candidate -> Admin, SuperAdmin, and the staff member who generated it
 */
function visibleSql(user, p) {
  const parts = [];
  const { clause, params } = candidateScopeSql(user, "c", p.length);
  p.push(...params);
  parts.push(`(s.scope_candidate_id IS NOT NULL AND EXISTS (SELECT 1 FROM candidates c WHERE c.id = s.scope_candidate_id AND c.is_deleted = false AND ${clause}))`);
  if (COMPANY_VIEWERS.has(user.role)) parts.push("(s.scope_candidate_id IS NULL AND s.kind IN ('daily','weekly','monthly'))");
  if (isAdmin(user)) parts.push("(s.scope_candidate_id IS NULL AND s.kind = 'custom')");
  else if (Number.isSafeInteger(user.id)) {
    p.push(user.id);
    parts.push(`(s.scope_candidate_id IS NULL AND s.kind = 'custom' AND s.generated_by = $${p.length})`);
  }
  return `(${parts.join(" OR ")})`;
}

function shapeSnapshot(r) {
  const m = r.payload || {};
  return {
    id: Number(r.id),
    kind: r.kind,
    candidateId: r.scope_candidate_id,
    candidateReference: r.kind === "candidate_activity" && m.candidate ? m.candidate.reference || null : undefined,
    from: m.period ? m.period.from : null,
    to: m.period ? m.period.to : null,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    timezone: r.timezone,
    generatedBy: r.generated_by,
    scheduled: r.generated_by === null,
    generatedAt: r.generated_at,
    payloadSha256: r.payload_sha256,
    formats: [r.pdf_key ? "pdf" : null, r.xlsx_key ? "xlsx" : null].filter(Boolean),
    flags: Array.isArray(m.flags) ? m.flags : [],
  };
}

async function listSnapshots(user, { kind, candidateId, limit } = {}) {
  requireReportReader(user);
  const p = [];
  const where = [visibleSql(user, p)];
  if (kind !== undefined && kind !== "") {
    if (!["daily", "weekly", "monthly", "custom", "candidate_activity"].includes(kind)) throw new HttpError(400, "kind is not valid");
    p.push(kind);
    where.push(`s.kind = $${p.length}`);
  }
  if (candidateId !== undefined && candidateId !== "") {
    const n = reports.optInt({ candidateId }, "candidateId");
    p.push(n);
    where.push(`s.scope_candidate_id = $${p.length}`);
  }
  let lim = 50;
  if (limit !== undefined && limit !== "") {
    lim = reports.optInt({ limit }, "limit");
    if (lim > 200) throw new HttpError(400, "limit may not exceed 200");
  }
  p.push(lim);
  const r = await db().query(
    `SELECT s.id, s.kind, s.scope_candidate_id, s.period_start, s.period_end, s.timezone, s.generated_by, s.generated_at, s.payload_sha256, s.pdf_key, s.xlsx_key,
            jsonb_build_object('period', s.payload->'period', 'candidate', jsonb_build_object('reference', s.payload->'candidate'->'reference'), 'flags', COALESCE(s.payload->'flags', '[]'::jsonb)) AS payload
       FROM js_report_snapshots s WHERE ${where.join(" AND ")} ORDER BY s.generated_at DESC, s.id DESC LIMIT $${p.length}`,
    p
  );
  return { snapshots: r.rows.map(shapeSnapshot) };
}

/** One snapshot's file; 404 when it does not exist or is not visible to the user. Audited. */
async function openSnapshot(user, snapshotId, format) {
  requireReportReader(user);
  const fmt = format === undefined || format === "" ? "pdf" : format;
  if (!FORMATS.includes(fmt)) throw new HttpError(400, `format must be one of ${FORMATS.join(", ")}`);
  const id = reports.optInt({ id: snapshotId }, "id");
  if (!id) throw new HttpError(404, "Not found");
  const p = [id];
  const vis = visibleSql(user, p);
  const r = await db().query(`SELECT s.* FROM js_report_snapshots s WHERE s.id = $1 AND ${vis}`, p);
  if (!r.rowCount) throw new HttpError(404, "Not found");
  const row = r.rows[0];
  const key = fmt === "pdf" ? row.pdf_key : row.xlsx_key;
  if (!key) throw new HttpError(404, "Not found");
  let buf;
  try {
    buf = await storage.get(key);
  } catch {
    throw new HttpError(404, "Not found");
  }
  const want = /^[0-9]+-([a-f0-9]{64})\./.exec(key);
  if (!want || crypto.createHash("sha256").update(buf).digest("hex") !== want[1]) throw new HttpError(500, "The stored report failed its integrity check");
  const m = row.payload;
  await auditJs({
    userId: user.id,
    action: "report.download",
    entity: "js_report_snapshots",
    entityId: row.id,
    candidateId: row.scope_candidate_id,
    detail: { snapshotId: Number(row.id), format: fmt, kind: row.kind, role: user.role },
  });
  const filename = row.kind === "candidate_activity" ? activityFileName(m, fmt) : companyFileName(m, fmt, row.kind === "custom" ? "report" : row.kind);
  return { buf, mime: MIME[fmt], filename, snapshotId: Number(row.id), flags: Array.isArray(m.flags) ? m.flags : [] };
}

// ---------------------------------------------------------------- scheduled company snapshots

/**
 * The previous full day / week (Monday-Sunday) / calendar month of the report timezone, relative to `now`, as local dates + UTC instants.
 * Computed by Postgres (AT TIME ZONE), so daylight-saving changes are right.
 */
async function previousPeriods(tz, now) {
  const r = (
    await db().query(
      `WITH l AS (SELECT $1::timestamptz AT TIME ZONE $2::text AS n)
       SELECT to_char(date_trunc('day', n) - interval '1 day', 'YYYY-MM-DD') AS d_from, to_char(date_trunc('day', n) - interval '1 day', 'YYYY-MM-DD') AS d_to,
              (date_trunc('day', n) - interval '1 day') AT TIME ZONE $2::text AS d_start, date_trunc('day', n) AT TIME ZONE $2::text AS d_end,
              to_char(date_trunc('week', n) - interval '7 days', 'YYYY-MM-DD') AS w_from, to_char(date_trunc('week', n) - interval '1 day', 'YYYY-MM-DD') AS w_to,
              (date_trunc('week', n) - interval '7 days') AT TIME ZONE $2::text AS w_start, date_trunc('week', n) AT TIME ZONE $2::text AS w_end,
              to_char(date_trunc('month', n) - interval '1 month', 'YYYY-MM-DD') AS m_from, to_char(date_trunc('month', n) - interval '1 day', 'YYYY-MM-DD') AS m_to,
              (date_trunc('month', n) - interval '1 month') AT TIME ZONE $2::text AS m_start, date_trunc('month', n) AT TIME ZONE $2::text AS m_end
         FROM l`,
      [now, tz]
    )
  ).rows[0];
  return [
    { kind: "daily", fromDate: r.d_from, toDate: r.d_to, from: r.d_start, to: r.d_end, period: "day" },
    { kind: "weekly", fromDate: r.w_from, toDate: r.w_to, from: r.w_start, to: r.w_end, period: "day" },
    { kind: "monthly", fromDate: r.m_from, toDate: r.m_to, from: r.m_start, to: r.m_end, period: "day" },
  ];
}

/**
 * Creates the missing daily / weekly / monthly company snapshot for the previous full period (at most one per (kind, period_start):
 * advisory lock + unique index). Company-wide aggregates by day (no names). A period with no activity gets a snapshot of zeros.
 * Does nothing unless report_schedule_enabled. Failures are reported by kind and error code only.
 * @returns {Promise<{enabled: boolean, created: string[], existing: string[], errors: {kind: string, code: string}[]}>}
 */
async function ensureScheduledSnapshots({ now = new Date() } = {}) {
  const settings = await getSettings();
  const out = { enabled: settings.report_schedule_enabled, created: [], existing: [], errors: [] };
  if (!out.enabled) return out;
  const tz = settings.report_timezone;
  for (const p of await previousPeriods(tz, now)) {
    try {
      const res = await persistSnapshot({
        kind: p.kind,
        generatedBy: null,
        actor: SYSTEM_ACTOR,
        now,
        before: async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('js_report_snapshot:' || current_schema() || ':' || $1::text || ':' || $2::text))", [p.kind, p.from.toISOString()]);
          const have = await client.query("SELECT 1 FROM js_report_snapshots WHERE kind = $1 AND period_start = $2", [p.kind, p.from]);
          return have.rowCount ? "skip" : null;
        },
        build: () => companyModel({ user: SYSTEM_READER, tz, fromDate: p.fromDate, toDate: p.toDate, from: p.from, to: p.to, groupBy: "period", period: p.period, now, scope: "all" }),
        auditExtra: { scheduled: true },
      });
      (res.created ? out.created : out.existing).push(p.kind);
    } catch (err) {
      out.errors.push({ kind: p.kind, code: String((err && (err.code || err.status)) || "error").slice(0, 40) });
    }
  }
  return out;
}

module.exports = {
  buildCompanyReport,
  buildCandidateActivityReport,
  renderPdf: render.renderPdf,
  renderXlsx: render.renderXlsx,
  exportCompanyReport,
  exportCandidateActivity,
  listSnapshots,
  openSnapshot,
  ensureScheduledSnapshots,
  previousPeriods,
  getSettings,
  updateSettings,
  companyHeader,
  activityFileName,
  companyFileName,
  payloadHash,
  resolveRange,
  MIME,
  FORMATS,
  LANGS,
  DISCLAIMER: render.DISCLAIMER,
  _resetRateLimit,
};
