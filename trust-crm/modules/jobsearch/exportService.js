// CSV exports (Task 14): GET /jobsearch/export.csv?type=applications|matches|submissions|messages|tasks
// Scope-filtered in SQL (candidateScopeSql + is_deleted = false), column whitelist per role, CSV
// formula-injection safe, row cap with a '# truncated' first line, audited, rate limited per user.
const { HttpError } = require("./httpError");
const { isAdmin } = require("./scope");
const r = require("./reportService");
const { auditJs } = require("../../utils/audit");

const db = () => require("../../db");

// Employer-support labels always travel with their evidence and this notice (label-safety ruling).
const SUPPORT_NOTICE = "Label from the advertisement; verify with the employer. Not proof of sponsorship, LMIA or visa.";
const SUPPORT_NOTICE_CONFIRMED = "Confirmed with the employer by staff; still not proof of sponsorship, LMIA or visa.";
const supportNotice = (label) => (label === "confirmed" ? SUPPORT_NOTICE_CONFIRMED : SUPPORT_NOTICE);

const TYPES = ["applications", "matches", "submissions", "messages", "tasks"];
const CANDIDATE_TYPES = ["applications", "matches"];
const SUBMISSION_STATUSES = ["queued", "sent", "confirmed_submitted", "failed", "outcome_unknown"];
const MESSAGE_STATES = ["matched", "needs_review", "resolved"];
const TASK_STATUSES = ["open", "resolved", "cancelled", "done"];

const maxRows = () => {
  const n = Number(process.env.JOBSEARCH_EXPORT_MAX_ROWS);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10000) : 10000;
};
const ratePerHour = () => {
  const n = Number(process.env.JOBSEARCH_EXPORT_RATE_PER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : 10;
};

// ---------------------------------------------------------------- CSV

const MAX_CELL = 2000;
// Leading characters a spreadsheet skips before looking for a formula trigger: whitespace (incl. tab,
// CR/LF, NBSP), zero-width characters and BOM.
const LEADING_INVISIBLE = /^[\s\u00A0\u200B-\u200D\u2060\uFEFF]+/;
// ASCII and full-width formula triggers.
const FORMULA_TRIGGER = /^[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/;

/**
 * One cell: capped at 2000 characters ('…' marks a cut); a leading apostrophe when the cell starts with
 * TAB/CR or its first visible character is a formula trigger (= + - @, also full-width); quoted when needed.
 */
function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (s.length > MAX_CELL) s = `${Array.from(s.slice(0, MAX_CELL)).slice(0, MAX_CELL - 1).join("")}…`;
  if (/^[\t\r]/.test(s) || FORMULA_TRIGGER.test(s.replace(LEADING_INVISIBLE, ""))) s = `'${s}`;
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(columns, rows, { truncated = false, bom = false, cap = 0 } = {}) {
  const lines = [];
  if (truncated) lines.push(`# truncated: only the first ${cap} rows are included`);
  lines.push(columns.map((c) => csvCell(c.header)).join(","));
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c.key])).join(","));
  return (bom ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- rate limit (in memory, per process)

const hits = new Map(); // userId -> timestamps (ms)
function rateLimit(userId) {
  const now = Date.now();
  const hour = 3600 * 1000;
  const list = (hits.get(userId) || []).filter((t) => now - t < hour);
  if (list.length >= ratePerHour()) {
    hits.set(userId, list);
    const retry = Math.ceil((hour - (now - list[0])) / 1000);
    const e = new HttpError(429, "Export rate limit reached; try again later");
    e.retryAfter = Math.max(1, retry);
    throw e;
  }
  list.push(now);
  hits.set(userId, list);
  if (hits.size > 10000) for (const [k, v] of hits) if (!v.some((t) => now - t < hour)) hits.delete(k);
}
const _resetRateLimit = () => hits.clear();

// ---------------------------------------------------------------- column whitelists

const col = (key, header = key) => ({ key, header });

function columnsFor(type, user) {
  const cand = user.role === "Candidate";
  const approver = !cand && r.hasPerm(user, "jobsearch:approve");
  switch (type) {
    case "applications":
      return cand
        ? [col("id"), col("job_title"), col("employer"), col("country"), col("status"), col("employer_support"), col("employer_support_evidence"), col("notice"), col("created_at"), col("updated_at")]
        : [col("id"), col("candidate_id"), col("candidate_name"), col("job_id"), col("job_title"), col("employer"), col("country"), col("source"), col("status"), col("employer_support"), col("employer_support_evidence"), col("notice"), col("mode_at_creation"), col("responsible_user_id"), col("created_at"), col("updated_at")];
    case "matches":
      return cand
        ? [col("id"), col("job_title"), col("employer"), col("country"), col("score"), col("employer_support"), col("employer_support_evidence"), col("notice"), col("created_at")]
        : [col("id"), col("candidate_id"), col("candidate_name"), col("job_id"), col("job_title"), col("employer"), col("country"), col("source"), col("score"), col("employer_support"), col("employer_support_evidence"), col("notice"), col("created_at")];
    // Recipient / sender addresses and provider ids: approvers (Manager/Admin) only.
    case "submissions":
      return [col("id"), col("application_id"), col("candidate_id"), col("candidate_name"), col("attempt"), col("status"), col("channel"), ...(approver ? [col("recipient"), col("provider_message_id")] : []), col("created_at"), col("sent_at"), col("confirmed_at")];
    case "messages":
      return [col("id"), col("application_id"), col("candidate_id"), col("direction"), col("review_state"), ...(approver ? [col("from_addr")] : []), col("subject"), col("category"), col("shared_with_candidate"), ...(approver ? [col("message_id")] : []), col("received_at")];
    case "tasks":
      return [col("id"), col("application_id"), col("candidate_id"), col("reason"), col("status"), col("assigned_to"), col("created_at"), col("resolved_at")];
    default:
      throw new HttpError(400, `type must be one of ${TYPES.join(", ")}`);
  }
}

// ---------------------------------------------------------------- queries

function parse(user, q) {
  const type = r.optEnum(q, "type", TYPES);
  if (!type) throw new HttpError(400, `type must be one of ${TYPES.join(", ")}`);
  const statusList = type === "submissions" ? SUBMISSION_STATUSES : type === "messages" ? MESSAGE_STATES : type === "tasks" ? TASK_STATUSES : r.APP_STATUSES;
  const f = {
    candidateId: r.optInt(q, "candidateId"),
    staffId: r.optInt(q, "staffId"),
    employerId: r.optInt(q, "employerId"),
    country: r.optStr(q, "country"),
    profession: r.optStr(q, "profession"),
    sourceKey: r.optStr(q, "sourceKey", /^[A-Za-z0-9_.:-]{1,100}$/),
    status: r.optEnum(q, "status", statusList),
  };
  const hasRange = (q.from !== undefined && q.from !== "") || (q.to !== undefined && q.to !== "");
  const range = hasRange ? r.parseRange(q) : null;
  const bomRaw = q.bom;
  if (bomRaw !== undefined && !["0", "1", "true", "false"].includes(bomRaw)) throw new HttpError(400, "bom must be 1/0/true/false");
  const bom = bomRaw === "1" || bomRaw === "true";
  if (!isAdmin(user) && user.role !== "Candidate" && f.staffId && f.staffId !== user.id) throw new HttpError(403, "Staff may only export their own candidates");
  return { type, f, range, bom };
}

function buildQuery(type, user, f, range, limit) {
  const p = [];
  const scope = r.scopeWhere(user, "c", p);
  const statusCol = { applications: "a.status", matches: "a.status", submissions: "s.status", messages: "m.review_state", tasks: "t.status" }[type];
  const where = [scope, ...r.filterSql(f, p, { statusCol })];
  const dateCol = { applications: "a.created_at", matches: "m.created_at", submissions: "s.created_at", messages: "COALESCE(m.received_at, m.created_at)", tasks: "t.created_at" }[type];
  if (range) {
    p.push(range.from);
    where.push(`${dateCol} >= $${p.length}`);
    p.push(range.to);
    where.push(`${dateCol} < $${p.length}`);
  }
  p.push(limit);
  const lim = `$${p.length}`;
  const W = where.join(" AND ");
  switch (type) {
    case "applications":
      return {
        sql: `SELECT a.id, a.candidate_id, c.full_name AS candidate_name, a.job_id, j.title AS job_title, e.name AS employer, j.country, j.source_primary AS source,
                     a.status, mm.employer_support, mm.employer_support_evidence, a.mode_at_creation, a.responsible_user_id, a.created_at, a.updated_at
                FROM js_applications a JOIN candidates c ON c.id = a.candidate_id JOIN js_jobs j ON j.id = a.job_id LEFT JOIN js_employers e ON e.id = j.employer_id
                LEFT JOIN js_matches mm ON mm.candidate_id = a.candidate_id AND mm.job_id = a.job_id
               WHERE ${W} ORDER BY a.id LIMIT ${lim}`,
        params: p,
      };
    case "matches":
      return {
        sql: `SELECT m.id, m.candidate_id, c.full_name AS candidate_name, m.job_id, j.title AS job_title, e.name AS employer, j.country, j.source_primary AS source,
                     m.score, m.employer_support, m.employer_support_evidence, m.created_at
                FROM js_matches m JOIN candidates c ON c.id = m.candidate_id JOIN js_jobs j ON j.id = m.job_id LEFT JOIN js_employers e ON e.id = j.employer_id
                LEFT JOIN js_applications a ON a.candidate_id = m.candidate_id AND a.job_id = m.job_id
               WHERE ${W} ORDER BY m.id LIMIT ${lim}`,
        params: p,
      };
    case "submissions":
      return {
        sql: `SELECT s.id, s.application_id, a.candidate_id, c.full_name AS candidate_name, s.attempt_no AS attempt, s.status, s.channel, s.recipient, s.provider_message_id,
                     s.created_at, s.sent_at, s.confirmed_at
                FROM js_submissions s JOIN js_applications a ON a.id = s.application_id JOIN candidates c ON c.id = a.candidate_id JOIN js_jobs j ON j.id = a.job_id
               WHERE ${W} ORDER BY s.id LIMIT ${lim}`,
        params: p,
      };
    case "messages":
      // Matched messages only (their application/candidate is in scope); the unmatched review queue is not exported.
      return {
        sql: `SELECT m.id, m.application_id, a.candidate_id, m.direction, m.review_state, m.from_addr, m.subject, m.classification->>'category' AS category,
                     m.shared_with_candidate, m.message_id, COALESCE(m.received_at, m.created_at) AS received_at
                FROM js_messages m JOIN js_applications a ON a.id = m.application_id JOIN candidates c ON c.id = a.candidate_id JOIN js_jobs j ON j.id = a.job_id
               WHERE ${W} ORDER BY m.id LIMIT ${lim}`,
        params: p,
      };
    case "tasks":
      return {
        sql: `SELECT t.id, t.application_id, a.candidate_id, t.reason, t.status, t.assigned_to, t.created_at, t.resolved_at
                FROM js_tasks t JOIN js_applications a ON a.id = t.application_id JOIN candidates c ON c.id = a.candidate_id JOIN js_jobs j ON j.id = a.job_id
               WHERE ${W} ORDER BY t.id LIMIT ${lim}`,
        params: p,
      };
    default:
      throw new HttpError(400, "unknown type");
  }
}

/**
 * @returns {Promise<{filename: string, body: string, rows: number, truncated: boolean}>}
 */
async function exportCsv({ user, query = {} }) {
  r.requireReader(user);
  const { type, f, range, bom } = parse(user, query);
  if (user.role === "Candidate" && !CANDIDATE_TYPES.includes(type)) throw new HttpError(403, "Candidates can export their applications and matches only");
  // A candidate's export is always their own (another candidateId just matches no row); staff filters are not theirs.
  if (user.role === "Candidate" && f.staffId) throw new HttpError(403, "Access denied");
  rateLimit(user.id);
  const cap = maxRows();
  const q = buildQuery(type, user, f, range, cap + 1);
  const rows = (await db().query(q.sql, q.params)).rows;
  const truncated = rows.length > cap;
  const out = truncated ? rows.slice(0, cap) : rows;
  if (type === "applications" || type === "matches") {
    for (const row of out) {
      row.employer_support = row.employer_support || "unknown";
      row.notice = supportNotice(row.employer_support);
    }
  }
  const columns = columnsFor(type, user);
  const body = toCsv(columns, out, { truncated, bom, cap });
  const filters = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null));
  if (range) Object.assign(filters, { from: range.from.toISOString(), to: range.to.toISOString() });
  await auditJs({ userId: user.id, action: "export", entity: `js_${type}`, detail: { type, filters, rows: out.length, truncated, role: user.role } });
  const day = new Date().toISOString().slice(0, 10);
  return { filename: `vita-${type}-${day}.csv`.replace(/[^A-Za-z0-9._-]/g, "_"), body, rows: out.length, truncated };
}

module.exports = { exportCsv, csvCell, toCsv, TYPES, SUPPORT_NOTICE, SUPPORT_NOTICE_CONFIRMED, supportNotice, _resetRateLimit };
