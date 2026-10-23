// Dashboard, reports and health (Task 14). Live SQL over the real js_* tables; every query is
// scope-filtered in SQL (candidateScopeSql + candidates.is_deleted = false). Nothing user-supplied
// is ever interpolated into SQL: dimensions/periods come from fixed maps, values are parameters.
//
//   dashboard({user, query:{candidateId?}})            Candidate: own; staff: assigned; admin: all
//   report({user, query:{from,to,groupBy,period,...}})  staff/admin (Candidate 403); counts = COUNT(*) of event rows
//   health({user})                                       Admin/SuperAdmin/Manager only
const { HttpError } = require("./httpError");
const { candidateScopeSql, assertCandidateAccess, isAdmin } = require("./scope");
const { PERMISSIONS } = require("../../middleware/role");

const db = () => require("../../db");

const APP_STATUSES = ["matched", "preparing", "ready_for_review", "approved", "queued", "sent", "confirmed_submitted", "failed", "outcome_unknown", "needs_staff", "cancelled", "closed", "interview", "offer", "rejected"];
const DAY_MS = 24 * 3600 * 1000;
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const STUCK_MINUTES = 15;
const ATTENTION_LIMIT = 100;
const CANDIDATE_LIST_LIMIT = 500;

// ---------------------------------------------------------------- shared helpers

function hasPerm(user, perm) {
  const perms = (user && PERMISSIONS[user.role]) || [];
  return perms.includes("*") || perms.includes(perm);
}

/** Candidate (own data) or a role with jobsearch:read; everything else (Accountant, HR, ...) is denied. */
function requireReader(user) {
  if (!user) throw new HttpError(401, "Access denied");
  if (user.role === "Candidate") return;
  if (!hasPerm(user, "jobsearch:read")) throw new HttpError(403, "Access denied");
}

function requireStaffReader(user) {
  if (!user) throw new HttpError(401, "Access denied");
  if (user.role === "Candidate" || !hasPerm(user, "jobsearch:read")) throw new HttpError(403, "Access denied");
}

const posInt = (v) => (typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

function optInt(q, k) {
  const v = q[k];
  if (v === undefined || v === "") return null;
  const n = posInt(v);
  if (!n) throw new HttpError(400, `${k} must be a positive integer`);
  return n;
}

function optStr(q, k, re = /^[\p{L}\p{N} .,'()&/_-]{1,100}$/u) {
  const v = q[k];
  if (v === undefined || v === "") return null;
  if (typeof v !== "string" || !re.test(v.trim())) throw new HttpError(400, `${k} is not valid`);
  return v.trim();
}

function optEnum(q, k, list) {
  const v = q[k];
  if (v === undefined || v === "") return null;
  if (typeof v !== "string" || !list.includes(v)) throw new HttpError(400, `${k} must be one of ${list.join(", ")}`);
  return v;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** ISO date (YYYY-MM-DD, UTC midnight) or ISO date-time with an explicit zone; else 400. */
function parseIsoDate(v, k) {
  if (typeof v !== "string" || !(DATE_ONLY.test(v) || DATE_TIME.test(v))) throw new HttpError(400, `${k} must be an ISO date (YYYY-MM-DD) or date-time with a timezone`);
  const d = new Date(DATE_ONLY.test(v) ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${k} is not a valid date`);
  if (DATE_ONLY.test(v) && d.toISOString().slice(0, 10) !== v) throw new HttpError(400, `${k} is not a valid date`);
  return d;
}

/**
 * Range [from, to): `from` inclusive; a date-only `to` covers that whole day (exclusive end = next
 * midnight UTC), a date-time `to` is exclusive. Default: the last 30 days. Max 366 days.
 */
function parseRange(q, { required = false } = {}) {
  const hasFrom = q.from !== undefined && q.from !== "";
  const hasTo = q.to !== undefined && q.to !== "";
  if (!hasFrom && !hasTo && !required) {
    const to = new Date();
    return { from: new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS), to };
  }
  let to = hasTo ? parseIsoDate(q.to, "to") : new Date();
  if (hasTo && DATE_ONLY.test(q.to)) to = new Date(to.getTime() + DAY_MS);
  const from = hasFrom ? parseIsoDate(q.from, "from") : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (from.getTime() >= to.getTime()) throw new HttpError(400, "from must be before to");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) throw new HttpError(400, `the date range may not exceed ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

/** Pushes the scope parameters into `p`; returns "(alias.is_deleted = false AND <scope>)". */
function scopeWhere(user, alias, p) {
  const { clause, params } = candidateScopeSql(user, alias, p.length);
  p.push(...params);
  return `(${alias}.is_deleted = false AND ${clause})`;
}

function scopeName(user) {
  if (isAdmin(user)) return "all";
  return user.role === "Candidate" ? "own" : "assigned";
}

// ---------------------------------------------------------------- dashboard

function emptyCounts() {
  const c = { matches: 0, replies: 0, interviews: 0, open_tasks: 0, applications: 0 };
  for (const s of APP_STATUSES) c[s] = 0;
  return c;
}

function shape(c, candidate) {
  const out = {
    matches: c.matches,
    applications: c.applications,
    matched: c.matched,
    preparing: c.preparing,
    ready_for_review: c.ready_for_review,
    approved: c.approved,
    queued: c.queued,
    submitted: { total: c.sent + c.confirmed_submitted, awaiting_confirmation: c.sent, confirmed: c.confirmed_submitted },
    failed: c.failed,
    outcome_unknown: c.outcome_unknown,
    needs_staff: c.needs_staff,
    replies: c.replies,
    interviews: c.interviews,
    interview_stage: c.interview,
    offers: c.offer,
    rejected: c.rejected,
    closed: c.closed,
    cancelled: c.cancelled,
  };
  if (!candidate) out.open_tasks = c.open_tasks;
  return out;
}

// Candidate id of a task: through its application, else the 'candidate:<id>:' detail prefix (scheduler).
const TASK_CANDIDATE = "COALESCE(ta.candidate_id, CASE WHEN t.application_id IS NULL AND t.detail ~ '^candidate:[0-9]{1,9}:' THEN substring(t.detail from '^candidate:([0-9]{1,9}):')::int END)";

async function dashboard({ user, query = {} }) {
  requireReader(user);
  const candidateId = optInt(query, "candidateId");
  if (candidateId) await assertCandidateAccess(user, candidateId); // 404 outside scope
  const isCand = user.role === "Candidate";
  const p = [];
  const w = scopeWhere(user, "c", p);
  let cf = "";
  if (candidateId) {
    p.push(candidateId);
    cf = ` AND c.id = $${p.length}`;
  }
  const c = db();
  const per = new Map();
  const at = (id) => {
    if (!per.has(id)) per.set(id, emptyCounts());
    return per.get(id);
  };
  const matches = await c.query(
    `SELECT c.id AS cid, count(*)::int AS n FROM js_matches m JOIN candidates c ON c.id = m.candidate_id JOIN js_jobs j ON j.id = m.job_id
      WHERE j.status = 'open' AND ${w}${cf} GROUP BY c.id`,
    p
  );
  for (const r of matches.rows) at(r.cid).matches = r.n;
  const apps = await c.query(`SELECT c.id AS cid, a.status, count(*)::int AS n FROM js_applications a JOIN candidates c ON c.id = a.candidate_id WHERE ${w}${cf} GROUP BY c.id, a.status`, p);
  for (const r of apps.rows) {
    const x = at(r.cid);
    x[r.status] = r.n;
    x.applications += r.n;
  }
  const replies = await c.query(
    `SELECT c.id AS cid, count(*)::int AS n FROM js_messages m JOIN js_applications a ON a.id = m.application_id JOIN candidates c ON c.id = a.candidate_id
      WHERE m.direction = 'in' AND m.review_state IN ('matched','resolved') ${isCand ? "AND m.shared_with_candidate = true" : ""} AND ${w}${cf} GROUP BY c.id`,
    p
  );
  for (const r of replies.rows) at(r.cid).replies = r.n;
  const interviews = await c.query(`SELECT c.id AS cid, count(*)::int AS n FROM js_appointments ap JOIN candidates c ON c.id = ap.candidate_id WHERE ap.status <> 'cancelled' AND ${w}${cf} GROUP BY c.id`, p);
  for (const r of interviews.rows) at(r.cid).interviews = r.n;

  let attention = [];
  let unscopedCount = null;
  if (!isCand) {
    const tasks = await c.query(
      `SELECT c.id AS cid, count(*)::int AS n FROM js_tasks t LEFT JOIN js_applications ta ON ta.id = t.application_id
         JOIN candidates c ON c.id = ${TASK_CANDIDATE}
        WHERE t.status = 'open' AND ${w}${cf} GROUP BY c.id`,
      p
    );
    for (const r of tasks.rows) at(r.cid).open_tasks = r.n;
    const items = await c.query(
      `SELECT * FROM (
         SELECT 'task' AS type, t.id AS task_id, t.reason, t.application_id, c.id AS candidate_id, t.created_at
           FROM js_tasks t LEFT JOIN js_applications ta ON ta.id = t.application_id JOIN candidates c ON c.id = ${TASK_CANDIDATE}
          WHERE t.status = 'open' AND ${w}${cf}
         UNION ALL
         SELECT 'application' AS type, NULL::int, 'needs_staff', a.id, c.id, a.updated_at
           FROM js_applications a JOIN candidates c ON c.id = a.candidate_id
          WHERE a.status = 'needs_staff' AND ${w}${cf}
            AND NOT EXISTS (SELECT 1 FROM js_tasks t2 WHERE t2.application_id = a.id AND t2.status = 'open')
       ) x ORDER BY created_at ASC, application_id LIMIT ${ATTENTION_LIMIT}`,
      p
    );
    // Tasks bound to no candidate (unmatched replies, mailbox/config problems...): only for roles that may
    // see the unmatched review queue (jobsearch:approve = Manager/Admin/SuperAdmin, as in the inbox rules),
    // and only on the unfiltered dashboard. Candidate-level tasks ('candidate:<id>:' prefix) are scoped above.
    let unscoped = [];
    if (!candidateId && hasPerm(user, "jobsearch:approve")) {
      unscoped = (await c.query(
        `SELECT 'task' AS type, t.id AS task_id, t.reason, NULL::int AS application_id, NULL::int AS candidate_id, t.message_id, t.created_at
           FROM js_tasks t
          WHERE t.status = 'open' AND t.application_id IS NULL AND (t.detail IS NULL OR t.detail !~ '^candidate:[0-9]{1,9}:')
          ORDER BY t.created_at ASC, t.id LIMIT ${ATTENTION_LIMIT}`
      )).rows;
      unscopedCount = (await c.query("SELECT count(*)::int AS n FROM js_tasks t WHERE t.status = 'open' AND t.application_id IS NULL AND (t.detail IS NULL OR t.detail !~ '^candidate:[0-9]{1,9}:')")).rows[0].n;
    }
    const merged = [...items.rows, ...unscoped].sort((x, y) => new Date(x.created_at) - new Date(y.created_at)).slice(0, ATTENTION_LIMIT);
    const now = Date.now();
    attention = merged.map((r) => ({
      type: r.type,
      taskId: r.task_id,
      reason: r.reason,
      candidateId: r.candidate_id,
      applicationId: r.application_id,
      link: r.application_id ? `/vita/#/applications/${r.application_id}` : r.candidate_id ? `/vita/#/candidates/${r.candidate_id}` : r.message_id ? `/vita/#/messages/${r.message_id}` : `/vita/#/tasks/${r.task_id}`,
      createdAt: r.created_at,
      ageHours: Math.max(0, Math.floor((now - new Date(r.created_at).getTime()) / 3600000)),
    }));
  }

  const total = emptyCounts();
  for (const x of per.values()) for (const k of Object.keys(total)) total[k] += x[k];
  const names = await c.query(`SELECT c.id, c.full_name FROM candidates c WHERE ${w}${cf} ORDER BY c.id LIMIT ${CANDIDATE_LIST_LIMIT}`, p);
  const totals = shape(total, isCand);
  if (unscopedCount !== null) totals.unassigned_open_tasks = unscopedCount;
  return {
    scope: scopeName(user),
    candidateId: candidateId || null,
    totals,
    candidates: names.rows.map((r) => ({ candidateId: r.id, name: r.full_name, counts: shape(per.get(r.id) || emptyCounts(), isCand) })),
    attention,
  };
}

// ---------------------------------------------------------------- reports

const METRICS = ["found", "matched", "prepared", "submitted", "confirmed", "failed", "outcome_unknown", "replies", "interviews", "offers", "rejections"];
const GROUPS = ["candidate", "country", "staff", "profession", "employer", "source", "status", "period"];
const PERIODS = ["day", "week", "month"];

// One row per counted event: (metric, candidate_id, job_id, application_id, at). Every metric is a
// COUNT(*) of these rows under the same joins and filters.
//  found       js_matches whose job was first seen (js_jobs.created_at = first sighting) in range
//  matched     js_matches created in range
//  prepared    applications whose FIRST package_built timeline event is in range
//  submitted   js_submissions with sent_at in range (provider accepted; incl. later confirmed)
//  confirmed   js_submissions confirmed_submitted with confirmed_at in range
//  failed / outcome_unknown   js_submissions in that status, created in range
//  replies     inbound js_messages matched/resolved to an application, received in range
//  interviews  js_appointments (not cancelled) with an application, created in range
//  offers / rejections   applications whose FIRST transition to offer / rejected is in range
const EVENTS_SQL = `
  SELECT 'found'::text AS metric, m.candidate_id, m.job_id, j0.created_at AS at FROM js_matches m JOIN js_jobs j0 ON j0.id = m.job_id
  UNION ALL SELECT 'matched', m.candidate_id, m.job_id, m.created_at FROM js_matches m
  UNION ALL SELECT 'prepared', a.candidate_id, a.job_id, t.at FROM (SELECT application_id, min(created_at) AS at FROM js_timeline WHERE event = 'package_built' GROUP BY application_id) t JOIN js_applications a ON a.id = t.application_id
  UNION ALL SELECT 'submitted', a.candidate_id, a.job_id, s.sent_at FROM js_submissions s JOIN js_applications a ON a.id = s.application_id WHERE s.sent_at IS NOT NULL
  UNION ALL SELECT 'confirmed', a.candidate_id, a.job_id, s.confirmed_at FROM js_submissions s JOIN js_applications a ON a.id = s.application_id WHERE s.status = 'confirmed_submitted' AND s.confirmed_at IS NOT NULL
  UNION ALL SELECT 'failed', a.candidate_id, a.job_id, s.created_at FROM js_submissions s JOIN js_applications a ON a.id = s.application_id WHERE s.status = 'failed'
  UNION ALL SELECT 'outcome_unknown', a.candidate_id, a.job_id, s.created_at FROM js_submissions s JOIN js_applications a ON a.id = s.application_id WHERE s.status = 'outcome_unknown'
  UNION ALL SELECT 'replies', a.candidate_id, a.job_id, COALESCE(mg.received_at, mg.created_at) FROM js_messages mg JOIN js_applications a ON a.id = mg.application_id WHERE mg.direction = 'in' AND mg.review_state IN ('matched','resolved')
  UNION ALL SELECT 'interviews', a.candidate_id, a.job_id, ap.created_at FROM js_appointments ap JOIN js_applications a ON a.id = ap.application_id WHERE ap.status <> 'cancelled'
  UNION ALL SELECT 'offers', a.candidate_id, a.job_id, t.at FROM (SELECT application_id, min(created_at) AS at FROM js_timeline WHERE detail->>'to' = 'offer' GROUP BY application_id) t JOIN js_applications a ON a.id = t.application_id
  UNION ALL SELECT 'rejections', a.candidate_id, a.job_id, t.at FROM (SELECT application_id, min(created_at) AS at FROM js_timeline WHERE detail->>'to' = 'rejected' GROUP BY application_id) t JOIN js_applications a ON a.id = t.application_id`;

// Fixed dimension expressions (never user input).
const DIMENSIONS = {
  candidate: { key: "c.id::text", label: "max(c.full_name)" },
  country: { key: "COALESCE(NULLIF(btrim(j.country), ''), 'unknown')", label: null },
  staff: { key: "COALESCE(c.assigned_to::text, 'unassigned')", label: "max(u.full_name)" },
  profession: { key: "COALESCE(NULLIF(btrim(pr.confirmed->>'profession'), ''), 'unknown')", label: null },
  employer: { key: "COALESCE(j.employer_id::text, 'unknown')", label: "max(e.name)" },
  source: { key: "COALESCE(j.source_primary, 'unknown')", label: null },
  status: { key: "COALESCE(a.status, 'no_application')", label: null },
  period: { key: null, label: null }, // date_trunc($period, ev.at) - built with a parameter
};

const likeEscape = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function parseReportQuery(user, q) {
  const groupBy = optEnum(q, "groupBy", GROUPS) || "candidate";
  const period = optEnum(q, "period", PERIODS) || "week";
  const range = parseRange(q);
  const f = {
    candidateId: optInt(q, "candidateId"),
    staffId: optInt(q, "staffId"),
    employerId: optInt(q, "employerId"),
    country: optStr(q, "country"),
    profession: optStr(q, "profession"),
    sourceKey: optStr(q, "sourceKey", /^[A-Za-z0-9_.:-]{1,100}$/),
    status: optEnum(q, "status", APP_STATUSES),
  };
  if (!isAdmin(user) && f.staffId && f.staffId !== user.id) throw new HttpError(403, "Staff may only report on their own candidates");
  return { groupBy, period, ...range, f };
}

/** WHERE fragments for the report/export filters on aliases c (candidates), j (jobs), a (application). */
function filterSql(f, p, { statusCol = "a.status" } = {}) {
  const where = [];
  const add = (sql, v) => {
    p.push(v);
    where.push(sql.replace(/\?/g, `$${p.length}`));
  };
  if (f.candidateId) add("c.id = ?", f.candidateId);
  if (f.staffId) add("c.assigned_to = ?", f.staffId);
  if (f.employerId) add("j.employer_id = ?", f.employerId);
  if (f.country) add("lower(btrim(j.country)) = lower(?)", f.country);
  if (f.profession) add("j.title ILIKE ?", `%${likeEscape(f.profession)}%`);
  if (f.sourceKey) add("(j.source_primary = ? OR EXISTS (SELECT 1 FROM js_job_sightings sg JOIN js_sources src ON src.id = sg.source_id WHERE sg.job_id = j.id AND src.key = ?))", f.sourceKey);
  if (f.status && statusCol) add(`${statusCol} = ?`, f.status);
  return where;
}

async function report({ user, query = {} }) {
  requireStaffReader(user);
  const { groupBy, period, from, to, f } = parseReportQuery(user, query);
  const p = [];
  const w = scopeWhere(user, "c", p);
  const where = [w, ...filterSql(f, p)];
  p.push(from);
  where.push(`ev.at >= $${p.length}`);
  p.push(to);
  where.push(`ev.at < $${p.length}`);
  let keyExpr;
  let labelExpr;
  if (groupBy === "period") {
    p.push(period);
    keyExpr = `to_char(date_trunc($${p.length}::text, ev.at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
    labelExpr = "NULL::text";
  } else {
    keyExpr = DIMENSIONS[groupBy].key;
    labelExpr = DIMENSIONS[groupBy].label || "NULL::text";
  }
  const sql = `
    SELECT ${keyExpr} AS key, ${labelExpr} AS label, ev.metric, count(*)::int AS n
      FROM (${EVENTS_SQL}) ev
      JOIN candidates c ON c.id = ev.candidate_id
      JOIN js_jobs j ON j.id = ev.job_id
      LEFT JOIN js_applications a ON a.candidate_id = ev.candidate_id AND a.job_id = ev.job_id
      LEFT JOIN js_employers e ON e.id = j.employer_id
      LEFT JOIN users u ON u.id = c.assigned_to
      LEFT JOIN js_profiles pr ON pr.candidate_id = c.id
     WHERE ${where.join(" AND ")}
     GROUP BY 1, ev.metric
     ORDER BY 1`;
  const r = await db().query(sql, p);
  const rows = new Map();
  const totals = Object.fromEntries(METRICS.map((m) => [m, 0]));
  for (const x of r.rows) {
    if (!rows.has(x.key)) rows.set(x.key, { key: x.key, label: x.label, ...Object.fromEntries(METRICS.map((m) => [m, 0])) });
    const row = rows.get(x.key);
    if (x.label && !row.label) row.label = x.label;
    row[x.metric] = x.n;
    totals[x.metric] += x.n;
  }
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    groupBy,
    ...(groupBy === "period" ? { period } : {}),
    scope: scopeName(user),
    filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null)),
    metrics: METRICS,
    rows: [...rows.values()],
    totals,
  };
}

// ---------------------------------------------------------------- health

const HEALTH_ROLES = new Set(["Admin", "SuperAdmin", "Manager"]);

/** Strips credentials, tokens and e-mail addresses from operator-facing error text. */
function redactSecrets(v, max = 300) {
  if (v === null || v === undefined) return null;
  return String(v)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|passwd|pass|pwd|sig|signature|auth|authorization|key|client[_-]?secret)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi, "$1$2***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, max);
}

async function health({ user }) {
  if (!user) throw new HttpError(401, "Access denied");
  if (!HEALTH_ROLES.has(user.role)) throw new HttpError(403, "Administrator or manager access required");
  const c = db();
  const { runStatus } = require("./searchRunner");
  const src = (await c.query(
    `SELECT s.id, s.key, s.status, s.paused, s.last_error, s.last_run_at, r.id AS run_id, r.started_at, r.finished_at, r.found, r.new_count, r.errors
       FROM js_sources s
       LEFT JOIN LATERAL (SELECT * FROM js_runs WHERE source_id = s.id ORDER BY started_at DESC, id DESC LIMIT 1) r ON true
      ORDER BY s.key`
  )).rows;
  const sources = src.map((s) => {
    const rs = s.run_id ? runStatus(s) : null;
    return {
      key: s.key,
      status: s.status,
      paused: s.paused,
      lastError: redactSecrets(s.last_error),
      lastRunAt: s.last_run_at,
      lastRun: s.run_id
        ? { startedAt: s.started_at, finishedAt: s.finished_at, found: s.found, newCount: s.new_count, status: rs.status, message: redactSecrets(rs.message), attempts: rs.attempts }
        : null,
    };
  });
  const queue = (await c.query("SELECT kind, status, count(*)::int AS n FROM js_queue GROUP BY kind, status ORDER BY kind, status")).rows.map((r) => ({ kind: r.kind, status: r.status, count: r.n }));
  const stuckRows = (await c.query(
    `SELECT id, kind, locked_at, attempts FROM js_queue WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1) ORDER BY locked_at LIMIT 50`,
    [STUCK_MINUTES]
  )).rows;
  const stuckCount = (await c.query("SELECT count(*)::int AS n FROM js_queue WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1)", [STUCK_MINUTES])).rows[0].n;
  const tasks = (await c.query("SELECT reason, count(*)::int AS n FROM js_tasks WHERE status = 'open' GROUP BY reason ORDER BY reason")).rows.map((r) => ({ reason: r.reason, count: r.n }));
  const outcomeUnknown = (await c.query("SELECT count(*)::int AS n FROM js_submissions WHERE status = 'outcome_unknown'")).rows[0].n;
  const state = (await c.query("SELECT key, value FROM js_module_state WHERE key IN ('scheduler_last_tick','module_paused')")).rows;
  const tick = (state.find((r) => r.key === "scheduler_last_tick") || {}).value || null;
  const paused = (state.find((r) => r.key === "module_paused") || {}).value || null;
  let mailStatus;
  try {
    const st = await require("./mail").status();
    // mode 'sandbox' = nothing leaves the server (status 'connected' there means only "the sandbox works");
    // problems = NAMES of missing/invalid settings (e.g. MAIL_FROM), never values.
    mailStatus = {
      status: st.status,
      mode: st.mode || "smtp",
      outbound: st.outbound || null,
      inbound: st.inbound || null,
      realSend: st.mode !== "sandbox" && process.env.MAIL_REAL_SEND === "true",
      problems: Array.isArray(st.problems) ? st.problems.map((x) => String(x).slice(0, 120)) : [],
    };
  } catch (err) {
    mailStatus = { status: "unavailable", error: redactSecrets(err && err.message) };
  }
  return {
    generatedAt: new Date().toISOString(),
    modulePaused: Boolean(paused && paused.paused === true),
    scheduler: {
      lastTickAt: tick && tick.at ? tick.at : null,
      finishedAt: tick && tick.finishedAt ? tick.finishedAt : null,
      errors: tick && tick.summary && Array.isArray(tick.summary.errors) ? tick.summary.errors.length : 0,
    },
    sources,
    queue,
    stuck: { thresholdMinutes: STUCK_MINUTES, count: stuckCount, items: stuckRows.map((r) => ({ id: Number(r.id), kind: r.kind, lockedAt: r.locked_at, attempts: r.attempts })) },
    tasksAwaitingHuman: tasks,
    outcomeUnknown,
    mail: mailStatus,
    storage: { malwareScan: process.env.CLAMAV_HOST ? "configured" : "scan_unavailable", unscannedAttachments: process.env.ALLOW_UNSCANNED_ATTACHMENTS === "true" ? "allowed" : "blocked" },
  };
}

module.exports = {
  dashboard,
  report,
  health,
  // shared with exportService
  requireReader,
  scopeWhere,
  filterSql,
  parseRange,
  optInt,
  optStr,
  optEnum,
  hasPerm,
  redactSecrets,
  APP_STATUSES,
  METRICS,
  GROUPS,
  EVENTS_SQL,
};
