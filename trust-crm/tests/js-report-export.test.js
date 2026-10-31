// Stage 8 task 3: PDF / Excel reports, the Canada Job Search Activity Report, immutable snapshots, report timezone and the scheduled
// company snapshots. Real Postgres + HTTP. Numbers in the generated files are parsed back and compared with INDEPENDENT SQL counts.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { createTestDb, loadApp } = require("./helpers/db");
const { seed, tokens } = require("./helpers/jsReportsSeed");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-report-export-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "js-rexp-"));
process.env.MAIL_PROVIDER = "sandbox";
process.env.MAIL_FROM = "applications@vita.test.invalid";
process.env.JOBSEARCH_EXPORT_RATE_PER_HOUR = "1000";
process.env.JOBSEARCH_REPORT_RATE_PER_HOUR = "100000";
for (const k of ["CLAMAV_HOST", "MAIL_REAL_SEND", "HR_TIMEZONE", "REPORT_TIMEZONE", "REPORT_SCHEDULE_ENABLED", "FIN_COMPANY_NAME", "FIN_COMPANY_ADDRESS", "SITE_NAME", "SITE_EMAIL", "SITE_PHONE", "JOBSEARCH_REPORT_MAX_ROWS"]) delete process.env[k];

const reportExport = require("../modules/jobsearch/reportExport");
const scheduler = require("../modules/jobsearch/scheduler");
const storage = require("../modules/jobsearch/storage");
const { stableStringify } = require("../modules/jobsearch/cvGenerator");
const { METRIC_LABELS } = require("../modules/jobsearch/reportRender");
const SQL027 = fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "027_report_exports.sql"), "utf8");

let pool;
let cleanup;
let server;
let base;
let s;
let tk;
let X; // extra fixtures

test.before(async () => {
  ({ pool, cleanup } = await createTestDb());
  const app = loadApp(pool);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  s = await seed(pool);
  tk = tokens(s, process.env.JWT_SECRET);
  X = await extraFixtures();
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await cleanup();
});

const q = (sql, params) => pool.query(sql, params);
const one = async (sql, params) => (await q(sql, params)).rows[0];

// ---------------------------------------------------------------- readers: zip / xlsx / pdf

function zipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert.ok(eocd >= 0, "not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const entryName = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    if (entryName === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
const unxml = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const colIndex = (letters) => [...letters].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** { sheetName: { rows: [[{v, t, s}]], xml } }  v = string for shared strings, number otherwise, undefined for empty cells */
function readXlsx(buf) {
  const wb = zipEntry(buf, "xl/workbook.xml").toString("utf8");
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unxml(m[1]));
  const sstXml = zipEntry(buf, "xl/sharedStrings.xml");
  const sst = sstXml ? [...sstXml.toString("utf8").matchAll(/<si>(.*?)<\/si>/gs)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((x) => x[1]).join(""))) : [];
  const out = {};
  names.forEach((name, i) => {
    const xml = zipEntry(buf, `xl/worksheets/sheet${i + 1}.xml`).toString("utf8");
    const rows = [];
    for (const rm of xml.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
      const row = [];
      for (const cm of rm[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
        const attrs = cm[2];
        const t = /t="(\w+)"/.exec(attrs);
        const st = /s="(\d+)"/.exec(attrs);
        const v = /<v>(.*?)<\/v>/s.exec(cm[3] || "");
        let val;
        if (v) val = t && t[1] === "s" ? sst[Number(v[1])] : Number(v[1]);
        row[colIndex(cm[1])] = { v: val, t: t ? t[1] : "n", s: st ? Number(st[1]) : 0 };
      }
      rows[Number(rm[1]) - 1] = row;
    }
    out[name] = { rows: Array.from(rows, (r) => r || []), xml };
  });
  return out;
}
const cellVals = (sheet) => sheet.rows.map((r) => Array.from(r, (c) => (c ? c.v : undefined)));
const allStrings = (wb) => Object.values(wb).flatMap((sh) => sh.rows.flatMap((r) => r.filter((c) => c && typeof c.v === "string").map((c) => c.v)));
const serial = (y, m, d, hh = 0, mm = 0) => (Date.UTC(y, m - 1, d, hh, mm) - Date.UTC(1899, 11, 30)) / 86400000;

async function pdfInfo(buf) {
  const { PDFParse } = require("pdf-parse");
  const p = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const r = await p.getText();
    return { text: r.text, pages: r.total };
  } finally {
    if (typeof p.destroy === "function") await p.destroy().catch(() => {});
  }
}
const norm = (t) => t.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- http

async function raw(url, token, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  if ((res.headers.get("content-type") || "").includes("json")) json = JSON.parse(buf.toString("utf8"));
  return { status: res.status, buf, json, headers: res.headers };
}
const qs = (o) => new URLSearchParams(o).toString();
const exportCompany = (token, o = {}) => raw(`/jobsearch/reports/export?${qs(o)}`, token);
const activity = (token, id, o = {}) => raw(`/jobsearch/candidates/${id}/activity-report?${qs(o)}`, token);
const myActivity = (token, o = {}) => raw(`/jobsearch/me/activity-report?${qs(o)}`, token);
const setSettings = (token, body) => raw("/jobsearch/reports/settings", token, { method: "PUT", body });

// ---------------------------------------------------------------- independent counts (test-side SQL, same definitions as the JSON report)

const SUBJOIN = "js_submissions s JOIN js_applications a ON a.id = s.application_id JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id";
const APPJOIN = "js_applications a JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id";
const METRIC_SQL = {
  found: { from: "js_matches m JOIN js_jobs j ON j.id = m.job_id JOIN candidates c ON c.id = m.candidate_id", at: "j.created_at" },
  matched: { from: "js_matches m JOIN js_jobs j ON j.id = m.job_id JOIN candidates c ON c.id = m.candidate_id", at: "m.created_at" },
  prepared: { from: APPJOIN, at: "(SELECT min(t.created_at) FROM js_timeline t WHERE t.application_id = a.id AND t.event = 'package_built')" },
  submitted: { from: SUBJOIN, at: "s.sent_at" },
  confirmed: { from: SUBJOIN, at: "s.confirmed_at", where: "s.status = 'confirmed_submitted'" },
  failed: { from: SUBJOIN, at: "s.created_at", where: "s.status = 'failed'" },
  outcome_unknown: { from: SUBJOIN, at: "s.created_at", where: "s.status = 'outcome_unknown'" },
  replies: { from: `js_messages mg JOIN js_applications a ON a.id = mg.application_id JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id`, at: "COALESCE(mg.received_at, mg.created_at)", where: "mg.direction = 'in' AND mg.review_state IN ('matched','resolved')" },
  interviews: { from: `js_appointments ap JOIN js_applications a ON a.id = ap.application_id JOIN js_jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id`, at: "ap.created_at", where: "ap.status <> 'cancelled'" },
  offers: { from: APPJOIN, at: "(SELECT min(t.created_at) FROM js_timeline t WHERE t.application_id = a.id AND t.detail->>'to' = 'offer')" },
  rejections: { from: APPJOIN, at: "(SELECT min(t.created_at) FROM js_timeline t WHERE t.application_id = a.id AND t.detail->>'to' = 'rejected')" },
};
const METRICS = Object.keys(METRIC_SQL);
const scopeOf = (who) => ({ admin: "TRUE", X: `c.assigned_to = ${s.users.X}`, Y: `c.assigned_to = ${s.users.Y}` })[who];
async function indepAll(who, from, to, extra = "") {
  const out = {};
  for (const m of METRICS) {
    const d = METRIC_SQL[m];
    out[m] = Number((await one(`SELECT count(*) AS n FROM ${d.from} WHERE c.is_deleted = false AND ${scopeOf(who)} AND ${d.at} >= $1 AND ${d.at} < $2 ${d.where ? `AND ${d.where}` : ""} ${extra}`, [from, to])).n);
  }
  return out;
}
// Tunis is UTC+1 all year: local 2026-03-01 .. 2026-03-31 = [2026-02-28T23:00Z, 2026-03-31T23:00Z)
const MARCH_TUNIS = [new Date("2026-02-28T23:00:00Z"), new Date("2026-03-31T23:00:00Z")];

// ---------------------------------------------------------------- extra fixtures (outside March so the seeded March numbers stay as they are)

async function extraFixtures() {
  const x = {};
  const emp = async (name) => (await one("INSERT INTO js_employers (name, normalized_name) VALUES ($1,lower($1)) RETURNING id", [name])).id;
  let n = 0;
  const jobApp = async (cid, employerId, title, status = "sent") => {
    n += 1;
    const job = (await one("INSERT INTO js_jobs (title, country, employer_id, source_primary, dedupe_key, created_at) VALUES ($1,'Canada',$2,'src_alpha',$3,'2026-04-01T08:00:00Z') RETURNING id", [title, employerId, `dk-x-${n}`])).id;
    return (await one("INSERT INTO js_applications (candidate_id, job_id, status, mode_at_creation, created_at, updated_at) VALUES ($1,$2,$3,'prepare_for_approval','2026-04-01T09:00:00Z','2026-04-01T09:00:00Z') RETURNING id", [cid, job, status])).id;
  };
  const submission = async (appId, st, sentAt, providerId) => {
    n += 1;
    await q("INSERT INTO js_submissions (application_id, attempt_no, idempotency_key, channel, recipient, provider_message_id, status, sent_at, evidence, created_at) VALUES ($1,1,$2,'email','recipient-secret@hr.test.invalid',$3,$4,$5,$6::jsonb,$7)", [
      appId, `idem-x-${n}`, providerId === undefined ? `<pm-${n}@sandbox.invalid>` : providerId, st, sentAt, JSON.stringify({ kind: "raw-evidence-sentinel", detail: "EVIDENCE-JSON-SENTINEL" }), sentAt || "2026-07-15T09:30:00Z",
    ]);
  };
  const cand = async (name, assignedTo, { account = false } = {}) => {
    const id = (await one("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [name, `PP-X-${name.replace(/\W+/g, "")}`, assignedTo])).id;
    return id;
  };

  // E: timezone day boundaries (May 2026). Tunis UTC+1, Toronto UTC-4 (EDT), Kiritimati UTC+14.
  x.E = await cand("Edge Tz Candidate", s.users.X);
  const eEmp = await emp("Edge Employer");
  for (const [title, at] of [["Edge Job 2230Z", "2026-05-10T22:30:00Z"], ["Edge Job 2330Z", "2026-05-10T23:30:00Z"], ["Edge Job 0030Z", "2026-05-11T00:30:00Z"]]) {
    await submission(await jobApp(x.E, eEmp, title), "sent", at);
  }

  // F: many sent applications -> PDF tables across pages (June 2026)
  x.F = await cand("Many Sent Candidate", s.users.X);
  const fEmp = await emp("Bulk Employer");
  for (let i = 1; i <= 70; i++) {
    await submission(await jobApp(x.F, fEmp, `Bulk position number ${i}`), i % 2 ? "sent" : "confirmed_submitted", `2026-06-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00Z`);
  }
  await q("UPDATE js_applications SET created_at = '2026-06-01T08:00:00Z' WHERE candidate_id = $1", [x.F]);

  // G: Arabic name and employer (cannot be drawn with the standard PDF font)
  x.G = await cand("محمد الأمين بن علي", s.users.X);
  const gEmp = await emp("شركة الخليج للبناء");
  await submission(await jobApp(x.G, gEmp, "كهربائي"), "confirmed_submitted", "2026-04-05T10:00:00Z");

  // H: formula-injection strings in employer / position
  x.H = await cand("Injection Candidate", s.users.X);
  const inj = ["=HYPERLINK(\"http://evil.example\",\"x\")", "+1+1", "-2+3", "@SUM(1+1)", "\t=cmd|' /C calc'!A0", "ok employer"];
  x.injection = inj;
  for (let i = 0; i < inj.length; i++) {
    const e = await emp(inj[i]);
    await submission(await jobApp(x.H, e, inj[(i + 1) % inj.length]), "sent", `2026-04-${20 + i}T10:00:00Z`);
  }

  // Sentinels that must never reach a candidate report: B's employer / job, drafts, queued, failed of E2, staff notes
  x.sentinelEmployer = "ZZ-SENTINEL-EMPLOYER-OF-B";
  const sEmp = await emp(x.sentinelEmployer);
  await submission(await jobApp(s.cand.B, sEmp, "ZZ-SENTINEL-JOB-OF-B"), "sent", "2026-03-20T10:00:00Z");

  // K: one application per status, to check which ones count as sent / pending / attention (April 2026)
  x.K = await cand("Status Matrix Candidate", s.users.X);
  const kEmp = await emp("Matrix Employer");
  x.kApps = {};
  for (const st of ["matched", "preparing", "ready_for_review", "approved", "queued", "failed", "outcome_unknown", "needs_staff", "cancelled", "closed"]) {
    const app = await jobApp(x.K, kEmp, `Matrix ${st}`, st);
    x.kApps[st] = app;
    if (st === "queued") await submission(app, "queued", null);
    if (st === "failed") await submission(app, "failed", null);
    if (st === "outcome_unknown" || st === "needs_staff") await submission(app, "outcome_unknown", null);
  }
  await submission(await jobApp(x.K, kEmp, "Matrix sent", "sent"), "sent", "2026-04-10T10:00:00Z");
  // a "sent" application whose only submission failed must NOT be listed
  await submission(await jobApp(x.K, kEmp, "Matrix status sent but submission failed", "sent"), "failed", null);
  await q("INSERT INTO js_tasks (application_id, reason, detail, assigned_to) VALUES ($1,'verify_delivery','STAFF-NOTE-SENTINEL do not show',$2)", [x.kApps.needs_staff, s.users.X]);
  await q("INSERT INTO js_timeline (application_id, actor, event, detail) VALUES ($1,'staff:1','note','{\"note\":\"TIMELINE-NOTE-SENTINEL\"}'::jsonb)", [x.kApps.queued]);
  // upcoming interview (tentative) for K, visible under "next planned actions"
  await q("INSERT INTO js_appointments (staff_user_id, candidate_id, application_id, starts_at, ends_at, status) VALUES ($1,$2,$3,'2036-11-20T15:00:00Z','2036-11-20T16:00:00Z','tentative')", [s.users.X, x.K, x.kApps.queued]);
  await q("INSERT INTO js_appointments (staff_user_id, candidate_id, starts_at, ends_at, status) VALUES ($1,$2,'2020-09-01T15:00:00Z','2020-09-01T16:00:00Z','confirmed')", [s.users.X, x.K]); // in the past: not planned
  return x;
}

// ---------------------------------------------------------------- migration

test("migration 027: idempotent, insert-only, constrained", async () => {
  await q(SQL027);
  await q(SQL027);
  const ins = (kind, scope, extra = "") =>
    q(`INSERT INTO js_report_snapshots (kind, scope_candidate_id, period_start, period_end, timezone, payload, payload_sha256) VALUES ($1,$2,'2030-01-01','2030-01-02','UTC','{}'::jsonb,$3) ${extra}`, [kind, scope, "a".repeat(64)]);
  await assert.rejects(() => ins("weekly2", null), /js_report_snapshots_kind_check/);
  await assert.rejects(() => ins("candidate_activity", null), /js_report_snapshots_scope_check/, "an activity report needs a candidate");
  await assert.rejects(() => ins("daily", s.cand.A), /js_report_snapshots_scope_check/, "a scheduled company report names no candidate");
  await assert.rejects(() => q("INSERT INTO js_report_snapshots (kind, period_start, period_end, timezone, payload, payload_sha256) VALUES ('custom','2030-01-02','2030-01-01','UTC','{}','" + "a".repeat(64) + "')"), /js_report_snapshots_period_check/);
  await assert.rejects(() => q("INSERT INTO js_report_snapshots (kind, period_start, period_end, timezone, payload, payload_sha256) VALUES ('custom','2030-01-01','2030-01-02','UTC','{}','nothex')"), /js_report_snapshots_hash_check/);
  await assert.rejects(() => q("INSERT INTO js_report_snapshots (kind, period_start, period_end, timezone, payload, payload_sha256, pdf_key) VALUES ('custom','2030-01-01','2030-01-02','UTC','{}','" + "a".repeat(64) + "','../../etc/passwd')"), /js_report_snapshots_keys_check/);
  await ins("daily", null);
  await assert.rejects(() => ins("daily", null), /js_report_snapshots_period_uq/, "one scheduled snapshot per (kind, period_start)");
  await ins("custom", null);
  await ins("custom", null); // custom exports are not unique
  const id = (await one("SELECT id FROM js_report_snapshots WHERE kind = 'daily' AND period_start = '2030-01-01'")).id;
  await assert.rejects(() => q("UPDATE js_report_snapshots SET timezone = 'Europe/Paris' WHERE id = $1", [id]), /insert-only/);
  await assert.rejects(() => q("UPDATE js_report_snapshots SET payload = '{\"x\":1}' WHERE id = $1", [id]), /insert-only/);
  await assert.rejects(() => q("DELETE FROM js_report_snapshots WHERE id = $1", [id]), /insert-only/);
  await q("TRUNCATE js_report_snapshots"); // test cleanup only (TRUNCATE is not a row operation)
});

test("storage: generated PDF/XLSX are accepted only through putGenerated; a spreadsheet is still not an uploadable CV", async () => {
  const out = await reportExport.renderXlsx({ type: "company", header: [], timezone: "UTC", period: { from: "2026-01-01", to: "2026-01-02" }, generatedAtLocal: "2026-01-03 10:00", groupBy: "country", bucket: null, scope: "all", metrics: ["found"], rows: [], totals: { found: 0 }, flags: [] });
  await assert.rejects(() => storage.put(out, { candidateId: 1 }), (e) => e.code === "UNSUPPORTED_TYPE");
  const f = await storage.putGenerated(out, { ext: "xlsx" });
  assert.match(f.key, /^0-[a-f0-9]{64}\.xlsx$/);
  await assert.rejects(() => storage.putGenerated(Buffer.from("not a spreadsheet at all, really"), { ext: "xlsx" }), (e) => e.code === "INVALID_UPLOAD");
  await assert.rejects(() => storage.putGenerated(out, { ext: "docx" }), (e) => e.code === "INVALID_UPLOAD");
});

// ---------------------------------------------------------------- company report: numbers equal SQL

test("company export XLSX: every number equals an independent SQL count (admin, manager X, agent Y)", async () => {
  for (const [who, token] of [["admin", tk.admin], ["X", tk.X], ["Y", tk.Y]]) {
    const r = await exportCompany(token, { format: "xlsx", from: "2026-03-01", to: "2026-03-31" });
    assert.equal(r.status, 200, who);
    assert.equal(r.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const wb = readXlsx(r.buf);
    assert.deepEqual(Object.keys(wb), ["Summary", "Report", "Notes"], "one sheet per section");
    const rows = cellVals(wb.Report);
    const total = rows[rows.length - 1];
    assert.equal(total[0], "Total");
    const want = await indepAll(who, ...MARCH_TUNIS);
    METRICS.forEach((m, i) => assert.equal(total[2 + i], want[m], `${who} total ${m}`));
    // per-candidate rows add up to the total, and every cell is numeric
    const body = rows.slice(1, -1);
    METRICS.forEach((m, i) => assert.equal(body.reduce((a, row) => a + row[2 + i], 0), want[m], `${who} rows sum ${m}`));
    for (const row of body) for (let i = 0; i < METRICS.length; i++) assert.equal(typeof row[2 + i], "number");
    // the summary sheet repeats the totals as numeric cells
    const sum = cellVals(wb.Summary);
    METRICS.forEach((m) => {
      const line = sum.find((row) => row[0] === METRIC_LABELS[m]);
      assert.ok(line, `summary row for ${m}`);
      assert.equal(line[1], want[m]);
    });
  }
});

test("company export equals the JSON report of the same range (same function, identical numbers)", async () => {
  const x = await exportCompany(tk.admin, { format: "xlsx", from: "2026-03-01", to: "2026-03-31", groupBy: "country" });
  const json = await raw(`/jobsearch/reports?${qs({ from: MARCH_TUNIS[0].toISOString(), to: MARCH_TUNIS[1].toISOString(), groupBy: "country" })}`, tk.admin);
  assert.equal(json.status, 200);
  const rows = cellVals(readXlsx(x.buf).Report);
  const body = rows.slice(1, -1);
  assert.equal(body.length, json.json.rows.length);
  json.json.rows.forEach((jr, i) => {
    assert.equal(body[i][0], jr.key);
    json.json.metrics.forEach((m, k) => assert.equal(body[i][2 + k], jr[m], `${jr.key} ${m}`));
  });
});

test("company export PDF: A4 landscape text with the same totals, page numbers, snapshot header", async () => {
  const r = await exportCompany(tk.admin, { format: "pdf", from: "2026-03-01", to: "2026-03-31" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.equal(r.buf.subarray(0, 5).toString(), "%PDF-");
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="vita-report-2026-03-01_2026-03-31\.pdf"$/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const { text, pages } = await pdfInfo(r.buf);
  const want = await indepAll("admin", ...MARCH_TUNIS);
  assert.ok(norm(text).includes(`Total ${METRICS.map((m) => want[m]).join(" ")}`), `totals row in PDF text: ${norm(text).slice(0, 600)}`);
  assert.match(text, /Page 1 of \d+/);
  assert.ok(pages >= 1);
  assert.match(text, /Reporting period 2026-03-01 - 2026-03-31/);
  assert.match(text, /Time zone Africa\/Tunis/);
  // the snapshot row exists, was written for this user, and the file is stored
  const snap = await one("SELECT * FROM js_report_snapshots WHERE id = $1", [r.headers.get("x-report-snapshot")]);
  assert.equal(snap.kind, "custom");
  assert.equal(snap.generated_by, s.users.admin);
  assert.equal(snap.scope_candidate_id, null);
  assert.equal(snap.timezone, "Africa/Tunis");
  assert.equal(crypto.createHash("sha256").update(await storage.get(snap.pdf_key)).digest("hex"), crypto.createHash("sha256").update(r.buf).digest("hex"), "the stored PDF is the one returned");
});

test("company export scoping: the agent sees only assigned candidates, never another's name", async () => {
  const r = await exportCompany(tk.Y, { format: "xlsx", from: "2026-03-01", to: "2026-03-31" });
  const strings = allStrings(readXlsx(r.buf)).join("\n");
  assert.ok(strings.includes("Candidate C"));
  assert.ok(!strings.includes("Candidate A") && !strings.includes("Candidate B") && !strings.includes("Candidate D"));
  assert.ok(strings.includes("assigned"), "scope is labelled");
  const p = await exportCompany(tk.Y, { format: "pdf", from: "2026-03-01", to: "2026-03-31" });
  const text = (await pdfInfo(p.buf)).text;
  assert.ok(text.includes("Candidate C") && !text.includes("Candidate A") && !text.includes("Candidate B"));
  // roles without jobsearch:read and the candidate are refused
  for (const t of [tk.accountant, tk.hr, tk.candA]) assert.equal((await exportCompany(t, { format: "pdf" })).status, 403);
  assert.equal((await exportCompany(null, { format: "pdf" })).status, 401);
});

test("company export groupBy=period buckets days in the REPORT timezone, not UTC", async () => {
  const r = await exportCompany(tk.admin, { format: "xlsx", from: "2026-05-01", to: "2026-05-31", groupBy: "period", period: "day" });
  assert.equal(r.status, 200);
  const rows = cellVals(readXlsx(r.buf).Report).slice(1, -1);
  // E's submissions: 22:30Z (23:30 Tunis 05-10), 23:30Z (00:30 Tunis 05-11), 00:30Z (01:30 Tunis 05-11)
  const day = (y, m, d) => serial(y, m, d);
  const get = (d) => rows.find((row) => row[0] === d);
  assert.equal(get(day(2026, 5, 10))[2 + METRICS.indexOf("submitted")], 1);
  assert.equal(get(day(2026, 5, 11))[2 + METRICS.indexOf("submitted")], 2);
  const { xml } = readXlsx(r.buf).Report;
  assert.ok(!/<f>/.test(xml), "no formulas anywhere");
});

// ---------------------------------------------------------------- candidate activity report

async function activityOf(token, id, o) {
  const r = await activity(token, id, { format: "xlsx", ...o });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { wb: readXlsx(r.buf), res: r };
}
const sumValue = (wb, label) => cellVals(wb.Summary).find((row) => row[0] === label)[1];

test("activity report: numbers equal SQL; the verified list is exactly the provider-accepted submissions in range", async () => {
  const { wb, res } = await activityOf(tk.X, s.cand.A, { from: "2026-03-01", to: "2026-03-31" });
  assert.deepEqual(Object.keys(wb), ["Summary", "Applications sent", "Next actions", "Notes"]);
  const A = s.cand.A;
  const count = async (m) => {
    const d = METRIC_SQL[m];
    return Number((await one(`SELECT count(*) AS n FROM ${d.from} WHERE c.id = $3 AND ${d.at} >= $1 AND ${d.at} < $2 ${d.where ? `AND ${d.where}` : ""}`, [...MARCH_TUNIS, A])).n);
  };
  assert.equal(sumValue(wb, "Job matches proposed"), await count("matched"));
  assert.equal(sumValue(wb, "Applications prepared"), await count("prepared"));
  assert.equal(sumValue(wb, "Interviews"), await count("interviews"));
  assert.equal(sumValue(wb, "Employer replies"), await count("replies"), "staff view: all matched replies");
  const sentSql = (await q(
    `SELECT j.title, to_char(s.sent_at AT TIME ZONE 'Africa/Tunis','YYYY-MM-DD') AS d, s.status FROM js_submissions s JOIN js_applications a ON a.id = s.application_id JOIN js_jobs j ON j.id = a.job_id
      WHERE a.candidate_id = $1 AND s.status IN ('sent','confirmed_submitted') AND s.sent_at >= $2 AND s.sent_at < $3 ORDER BY s.sent_at, s.id`, [A, ...MARCH_TUNIS])).rows;
  assert.equal(sentSql.length, 5);
  assert.equal(sumValue(wb, "Applications sent (verified)"), sentSql.length);
  assert.equal(sentSql.length, await count("submitted"), "identical to the report's 'submitted' count");
  const list = cellVals(wb["Applications sent"]).slice(1);
  assert.equal(list.length, sentSql.length);
  sentSql.forEach((row, i) => {
    assert.equal(list[i][1], row.title);
    const [y, m, d] = row.d.split("-").map(Number);
    assert.equal(list[i][2], serial(y, m, d), "a real date cell, in the report timezone");
    assert.equal(list[i][3], row.status === "sent" ? "Sent" : "Confirmed submitted");
    assert.match(list[i][4], /^\.\.\.[A-Za-z0-9]{1,8}$/, "evidence reference = provider message id suffix only");
  });
  // pending = preparing / ready_for_review / approved / queued (seed: 3); attention = failed / outcome_unknown / needs_staff (3)
  const pend = await one("SELECT count(*)::int AS n FROM js_applications WHERE candidate_id = $1 AND status IN ('preparing','ready_for_review','approved','queued')", [A]);
  const att = await one("SELECT count(*)::int AS n FROM js_applications WHERE candidate_id = $1 AND status IN ('failed','outcome_unknown','needs_staff')", [A]);
  assert.equal(sumValue(wb, "Applications pending (as of generation)"), pend.n);
  assert.equal(sumValue(wb, "Submissions not delivered or awaiting verification"), att.n);
  // headers + snapshot
  const ref = (await one("SELECT reference FROM candidates WHERE id = $1", [A])).reference;
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="${ref}-activity-2026-03-01_2026-03-31.xlsx"`);
  const snap = await one("SELECT * FROM js_report_snapshots WHERE id = $1", [res.headers.get("x-report-snapshot")]);
  assert.equal(snap.kind, "candidate_activity");
  assert.equal(snap.scope_candidate_id, A);
  assert.equal(snap.generated_by, s.users.X);
  assert.equal(snap.payload.candidate.reference, ref);
});

test("activity report: drafts, queued, failed and unconfirmed items are never in the verified list", async () => {
  const { wb } = await activityOf(tk.X, X.K, { from: "2026-04-01", to: "2026-04-30" });
  const list = cellVals(wb["Applications sent"]).slice(1);
  assert.deepEqual(list.map((r) => r[1]), ["Matrix sent"], "only the application whose submission the provider accepted");
  assert.equal(sumValue(wb, "Applications sent (verified)"), 1);
  // pending: preparing, ready_for_review, approved, queued = 4; attention: failed, outcome_unknown, needs_staff + the 'sent' app whose submission failed is status sent (not counted)
  assert.equal(sumValue(wb, "Applications pending (as of generation)"), 4);
  assert.equal(sumValue(wb, "Submissions not delivered or awaiting verification"), 3);
  const strings = allStrings({ sent: wb["Applications sent"] }).join("\n"); // (queued items legitimately appear under "Next actions")
  for (const bad of ["Matrix failed", "Matrix queued", "Matrix preparing", "Matrix status sent but submission failed", "Matrix cancelled"]) assert.ok(!strings.includes(bad), `${bad} must not be listed`);
  // next planned actions: queued + approved applications, and the FUTURE interview only
  const next = cellVals(wb["Next actions"]).slice(1);
  assert.deepEqual(next.map((r) => [r[0], r[2]]).sort(), [["Application queued for sending", "Matrix queued"], ["Interview (tentative)", "Matrix queued"], ["Application approved, to be sent", "Matrix approved"]].sort());
  const iv = next.find((r) => r[0] === "Interview (tentative)");
  assert.ok(Math.abs(iv[3] - serial(2036, 11, 20, 16, 0)) < 1e-6, "interview 15:00Z = 16:00 Tunis, as a real date-time");
});

test("activity report text never contains raw evidence, recipients, staff notes, other candidates or their employers", async () => {
  const needles = ["EVIDENCE-JSON-SENTINEL", "raw-evidence-sentinel", "recipient-secret@hr.test.invalid", "STAFF-NOTE-SENTINEL", "TIMELINE-NOTE-SENTINEL", "@sandbox.invalid", "hr@secret.example", "HYPERLINK(\"http://evil.example\")"];
  const others = ["Candidate B", "Candidate C", X.sentinelEmployer, "ZZ-SENTINEL-JOB-OF-B", "PP-RPT", "PP-X-", "Employer replied", "Body text", "manual_confirmation"];
  for (const [id, token] of [[s.cand.A, tk.X], [X.K, tk.X], [s.cand.B, tk.X]]) {
    for (const lang of ["en", "fr", "ar"]) {
      const x = await activity(token, id, { format: "xlsx", from: "2026-03-01", to: "2026-06-30", lang });
      const pdf = await activity(token, id, { format: "pdf", from: "2026-03-01", to: "2026-06-30", lang });
      assert.equal(x.status, 200);
      const text = `${allStrings(readXlsx(x.buf)).join("\n")}\n${(await pdfInfo(pdf.buf)).text}`;
      for (const n of needles) assert.ok(!text.includes(n), `${n} leaked (cand ${id}, ${lang})`);
      for (const n of others) {
        const own = id === s.cand.B && (n === X.sentinelEmployer || n === "ZZ-SENTINEL-JOB-OF-B" || n === "Candidate B");
        if (!own) assert.ok(!new RegExp(`${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`).test(text), `${n} leaked into the report of candidate ${id}`);
      }
    }
  }
  // positive control: B's own report does show B's sentinel employer
  const own = await activity(tk.X, s.cand.B, { format: "xlsx", from: "2026-03-01", to: "2026-03-31" });
  assert.ok(allStrings(readXlsx(own.buf)).includes(X.sentinelEmployer));
});

test("activity report PDF: A4 text, reference, name, period, tables, page numbers", async () => {
  const r = await activity(tk.X, s.cand.A, { format: "pdf", from: "2026-03-01", to: "2026-03-31" });
  assert.equal(r.headers.get("content-type"), "application/pdf");
  const ref = (await one("SELECT reference FROM candidates WHERE id = $1", [s.cand.A])).reference;
  const t = norm((await pdfInfo(r.buf)).text);
  for (const frag of ["Canada Job Search Activity Report", `Candidate reference ${ref}`, "Candidate Candidate A", "Reporting period 2026-03-01 - 2026-03-31", "Time zone Africa/Tunis", "Applications sent (verified) 5", "Next planned actions", "Page 1 of 1"]) assert.ok(t.includes(frag), `missing "${frag}" in ${t.slice(0, 900)}`);
  assert.ok(/2026-03-08 Sent \.\.\.prov\d+/.test(t) || /Date sent/.test(t));
  assert.ok(!r.headers.get("x-report-flags"), "nothing flagged for Latin text");
});

test("activity report PDF: a long list breaks across pages with a repeated header and 'Page i of n' on each", async () => {
  const r = await activity(tk.X, X.F, { format: "pdf", from: "2026-06-01", to: "2026-06-30" });
  assert.equal(r.status, 200);
  const info = await pdfInfo(r.buf);
  assert.ok(info.pages >= 2, `pages ${info.pages}`);
  const t = norm(info.text);
  for (let i = 1; i <= info.pages; i++) assert.ok(t.includes(`Page ${i} of ${info.pages}`), `page number ${i}`);
  assert.ok((t.match(/Evidence reference/g) || []).length >= 2, "table header repeated on following pages");
  for (const n of [1, 35, 70]) assert.ok(t.includes(`Bulk position number ${n}`), `row ${n} present`);
  const x = readXlsx((await activity(tk.X, X.F, { format: "xlsx", from: "2026-06-01", to: "2026-06-30" })).buf);
  assert.equal(cellVals(x["Applications sent"]).slice(1).length, 70);
});

test("disclaimer: present in en, fr and ar (XLSX) and in en/fr PDFs; arabic PDF falls back to English and says so; no promise anywhere else", async () => {
  const D = reportExport.DISCLAIMER;
  assert.equal(D.en, "This report documents activities performed. It does not guarantee a job offer, employer sponsorship, a work permit or a visa.");
  for (const lang of ["en", "fr", "ar"]) {
    const x = await activity(tk.X, s.cand.A, { format: "xlsx", from: "2026-03-01", to: "2026-03-31", lang });
    assert.ok(allStrings(readXlsx(x.buf)).includes(D[lang]), `xlsx ${lang}`);
    const p = await activity(tk.X, s.cand.A, { format: "pdf", from: "2026-03-01", to: "2026-03-31", lang });
    const t = norm((await pdfInfo(p.buf)).text);
    if (lang === "ar") {
      assert.ok(t.includes(D.en), "the arabic PDF carries the English notice (the standard font cannot draw Arabic)");
      assert.match(p.headers.get("x-report-flags"), /pdf_font_arabic_unavailable/);
      assert.ok(t.includes("This PDF is in English because its font cannot draw Arabic"));
    } else {
      assert.ok(t.includes(norm(D[lang])), `pdf ${lang}: ${t.slice(-500)}`);
    }
    // no promise or guarantee text outside the disclaimer itself
    const rest = (lang === "ar" ? t.replace(D.en, "") : t.replace(norm(D[lang]), ""));
    assert.ok(!/guarantee|garanti|promise|promis|assured|will get|vous obtiendrez|sponsor|LMIA|\bvisa\b|work permit|permis de travail/i.test(rest), `promise-like text outside the disclaimer (${lang}): ${rest}`);
  }
  assert.equal((await activity(tk.X, s.cand.A, { format: "pdf", lang: "de" })).status, 400);
});

test("non-Latin text: PDF shows the [?] marker and the flag, XLSX keeps the original", async () => {
  const pdf = await activity(tk.X, X.G, { format: "pdf", from: "2026-04-01", to: "2026-04-30" });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get("x-report-flags"), /pdf_non_latin_text/);
  const t = norm((await pdfInfo(pdf.buf)).text);
  assert.ok(t.includes("[?]"));
  assert.ok(t.includes("The Excel version has the original text"));
  const x = await activity(tk.X, X.G, { format: "xlsx", from: "2026-04-01", to: "2026-04-30" });
  const strings = allStrings(readXlsx(x.buf));
  assert.ok(strings.includes("شركة الخليج للبناء") && strings.includes("محمد الأمين بن علي"));
  const snap = await one("SELECT payload FROM js_report_snapshots WHERE id = $1", [pdf.headers.get("x-report-snapshot")]);
  assert.ok(snap.payload.flags.includes("pdf_non_latin_text"));
});

test("company header: only what is configured; nothing invented", async () => {
  const before = norm((await pdfInfo((await activity(tk.X, s.cand.A, { format: "pdf", from: "2026-03-01", to: "2026-03-31" })).buf)).text);
  assert.ok(!/VITA|Acme|@|\+\d/.test(before), `no header facts when unset: ${before.slice(0, 200)}`);
  assert.deepEqual(reportExport.companyHeader({}), []);
  assert.deepEqual(reportExport.companyHeader({ SITE_NAME: "  ", FIN_COMPANY_ADDRESS: "" }), []);
  process.env.FIN_COMPANY_NAME = "Acme Recruitment Ltd";
  process.env.FIN_COMPANY_ADDRESS = "12 Rue Exemple, Tunis";
  process.env.SITE_EMAIL = "info@acme.example";
  process.env.SITE_PHONE = "+216 70 000 000";
  try {
    assert.deepEqual(reportExport.companyHeader(), ["Acme Recruitment Ltd", "12 Rue Exemple, Tunis", "info@acme.example", "+216 70 000 000"]);
    const t = norm((await pdfInfo((await activity(tk.X, s.cand.A, { format: "pdf", from: "2026-03-01", to: "2026-03-31" })).buf)).text);
    for (const f of ["Acme Recruitment Ltd", "12 Rue Exemple, Tunis", "info@acme.example", "+216 70 000 000"]) assert.ok(t.includes(f), f);
    const x = allStrings(readXlsx((await activity(tk.X, s.cand.A, { format: "xlsx", from: "2026-03-01", to: "2026-03-31" })).buf));
    assert.ok(x.includes("Acme Recruitment Ltd"));
    delete process.env.FIN_COMPANY_NAME;
    process.env.SITE_NAME = "Site Brand";
    assert.equal(reportExport.companyHeader()[0], "Site Brand", "SITE_NAME is the fallback for the name");
  } finally {
    for (const k of ["FIN_COMPANY_NAME", "FIN_COMPANY_ADDRESS", "SITE_NAME", "SITE_EMAIL", "SITE_PHONE"]) delete process.env[k];
  }
});

test("formula injection: text cells that start with = + - @ (also after blanks) are neutralised, numbers stay numeric, no formula elements", async () => {
  const r = await activity(tk.X, X.H, { format: "xlsx", from: "2026-04-01", to: "2026-04-30" });
  const wb = readXlsx(r.buf);
  assert.ok(!Object.values(wb).some((sh) => /<f[ >]/.test(sh.xml)), "no <f> formula element in any sheet");
  const cells = Object.values(wb).flatMap((sh) => sh.rows.flat().filter((c) => c && typeof c.v === "string"));
  for (const c of cells) assert.ok(!/^[\s ​-‍⁠﻿]*[=+\-@＝＋－＠]/.test(c.v), `cell starts with a formula trigger: ${JSON.stringify(c.v)}`);
  const strings = cells.map((c) => c.v);
  for (const raw of X.injection.filter((v) => /^[\t=+\-@]/.test(v))) assert.ok(strings.includes(`'${raw.replace(/\t+/g, " ")}`), `neutralised ${JSON.stringify(raw)}`);
  assert.ok(strings.includes("ok employer"), "ordinary text is untouched");
  const total = cellVals(wb.Summary).find((row) => row[0] === "Applications sent (verified)")[1];
  assert.equal(typeof total, "number");
});

// ---------------------------------------------------------------- access

test("access: a candidate gets only their own report; foreign ids answer 404; staff only inside their scope", async () => {
  const A = s.cand.A;
  const B = s.cand.B;
  const own = await myActivity(tk.candA, { format: "pdf", from: "2026-03-01", to: "2026-03-31" });
  assert.equal(own.status, 200);
  const ref = (await one("SELECT reference FROM candidates WHERE id = $1", [A])).reference;
  assert.match(own.headers.get("content-disposition"), new RegExp(`^attachment; filename="${ref}-activity-2026-03-01_2026-03-31\\.pdf"$`));
  assert.ok((await pdfInfo(own.buf)).text.includes("Candidate A"));
  assert.equal((await activity(tk.candA, A, { format: "pdf" })).status, 200, "own id through the staff-style route");
  for (const [tok, who] of [[tk.candA, "candA"], [tk.candB, "candB"], [tk.candC, "candC"]]) {
    for (const id of [A, B, s.cand.C, s.cand.D, 99999, "abc"]) {
      const mine = (who === "candA" && id === A) || (who === "candB" && id === B) || (who === "candC" && id === s.cand.C);
      const r = await activity(tok, id, { format: "pdf" });
      assert.equal(r.status, mine ? 200 : 404, `${who} -> candidate ${id}`);
      if (!mine) assert.deepEqual(r.json, { error: "Not found" });
    }
  }
  // the candidate's own report never reveals unshared replies: seed has 4 matched replies for A, 1 unshared
  const own2 = readXlsx((await myActivity(tk.candA, { format: "xlsx", from: "2026-03-01", to: "2026-03-31" })).buf);
  const shared = Number((await one(`SELECT count(*) AS n FROM js_messages mg JOIN js_applications a ON a.id = mg.application_id WHERE a.candidate_id = $1 AND mg.direction='in' AND mg.review_state IN ('matched','resolved') AND mg.shared_with_candidate = true`, [A])).n);
  const all = Number((await one(`SELECT count(*) AS n FROM js_messages mg JOIN js_applications a ON a.id = mg.application_id WHERE a.candidate_id = $1 AND mg.direction='in' AND mg.review_state IN ('matched','resolved')`, [A])).n);
  assert.ok(shared < all, "fixture has an unshared reply");
  assert.equal(sumValue(own2, "Employer replies"), shared);
  // staff
  assert.equal((await activity(tk.X, B, { format: "pdf" })).status, 200);
  assert.equal((await activity(tk.Y, A, { format: "pdf" })).status, 404, "agent Y: A is X's candidate");
  assert.equal((await activity(tk.X, s.cand.C, { format: "pdf" })).status, 404);
  assert.equal((await activity(tk.admin, s.cand.C, { format: "pdf" })).status, 200);
  assert.equal((await activity(tk.admin, s.cand.D, { format: "pdf" })).status, 404, "deleted candidate");
  assert.equal((await activity(tk.accountant, A, { format: "pdf" })).status, 403);
  assert.equal((await activity(tk.hr, A, { format: "pdf" })).status, 403);
  assert.equal((await activity(null, A, { format: "pdf" })).status, 401);
  assert.equal((await myActivity(tk.X, { format: "pdf" })).status, 403, "/me is for candidates");
  assert.equal((await myActivity(null, {})).status, 401);
});

test("generation is audited (who, what, hash) and downloads of snapshots are audited too", async () => {
  const r = await activity(tk.X, s.cand.A, { format: "pdf", from: "2026-03-01", to: "2026-03-31" });
  const id = Number(r.headers.get("x-report-snapshot"));
  const a = await one("SELECT * FROM js_audit_events WHERE action = 'report.generate' AND detail->>'snapshotId' = $1", [String(id)]);
  assert.equal(a.actor, `user:${s.users.X}`);
  assert.equal(a.candidate_id, s.cand.A);
  assert.equal(a.detail.kind, "candidate_activity");
  assert.match(a.detail.payloadSha256, /^[0-9a-f]{64}$/);
  const al = await one("SELECT * FROM audit_logs WHERE action = 'jobsearch.report.generate' AND record_id = $1", [String(id)]);
  assert.equal(al.user_id, s.users.X);
  const dl = await raw(`/jobsearch/reports/snapshots/${id}/download?format=pdf`, tk.X);
  assert.equal(dl.status, 200);
  const d = await one("SELECT * FROM js_audit_events WHERE action = 'report.download' AND detail->>'snapshotId' = $1", [String(id)]);
  assert.equal(d.actor, `user:${s.users.X}`);
});

// ---------------------------------------------------------------- timezone

test("report timezone: local date and day boundaries follow the configured zone (Tunis UTC+1, Toronto UTC-4, Kiritimati UTC+14)", async () => {
  const E = X.E;
  const datesOf = async (from, to) => cellVals(readXlsx((await activity(tk.X, E, { format: "xlsx", from, to })).buf)["Applications sent"]).slice(1).map((r) => [r[1], r[2]]);
  const d = (m, dd) => serial(2026, m, dd);
  try {
    // Africa/Tunis (default): 22:30Z = 23:30 on 05-10; 23:30Z = 00:30 on 05-11; 00:30Z = 01:30 on 05-11
    assert.equal((await setSettings(tk.admin, { report_timezone: null })).status, 200);
    assert.deepEqual(await datesOf("2026-05-10", "2026-05-11"), [["Edge Job 2230Z", d(5, 10)], ["Edge Job 2330Z", d(5, 11)], ["Edge Job 0030Z", d(5, 11)]]);
    assert.deepEqual(await datesOf("2026-05-10", "2026-05-10"), [["Edge Job 2230Z", d(5, 10)]], "the 10th ends at 23:00Z");
    assert.deepEqual((await datesOf("2026-05-11", "2026-05-11")).map((r) => r[0]), ["Edge Job 2330Z", "Edge Job 0030Z"], "the 11th starts at 23:00Z the day before");
    // America/Toronto (EDT, UTC-4): 18:30, 19:30 on 05-10 and 20:30 on 05-10
    assert.equal((await setSettings(tk.admin, { report_timezone: "America/Toronto" })).status, 200);
    assert.deepEqual(await datesOf("2026-05-10", "2026-05-10"), [["Edge Job 2230Z", d(5, 10)], ["Edge Job 2330Z", d(5, 10)], ["Edge Job 0030Z", d(5, 10)]]);
    assert.deepEqual(await datesOf("2026-05-11", "2026-05-11"), [], "nothing happened on the 11th in Toronto");
    // Pacific/Kiritimati (UTC+14): 12:30 and 13:30 on 05-11 and 14:30 on 05-11
    assert.equal((await setSettings(tk.admin, { report_timezone: "Pacific/Kiritimati" })).status, 200);
    assert.deepEqual(await datesOf("2026-05-11", "2026-05-11"), [["Edge Job 2230Z", d(5, 11)], ["Edge Job 2330Z", d(5, 11)], ["Edge Job 0030Z", d(5, 11)]]);
    const p = await activity(tk.X, E, { format: "pdf", from: "2026-05-11", to: "2026-05-11" });
    const t = norm((await pdfInfo(p.buf)).text);
    assert.ok(t.includes("Time zone Pacific/Kiritimati") && t.includes("Edge Job 2230Z 2026-05-11"));
    const snap = await one("SELECT timezone, period_start, period_end FROM js_report_snapshots WHERE id = $1", [p.headers.get("x-report-snapshot")]);
    assert.equal(snap.timezone, "Pacific/Kiritimati");
    assert.equal(snap.period_start.toISOString(), "2026-05-10T10:00:00.000Z", "local midnight of the 11th in UTC+14");
  } finally {
    await setSettings(tk.admin, { report_timezone: null });
  }
});

test("report timezone is DST-aware: a spring-forward day has 23 hours in Toronto", async () => {
  const r = await reportExport.resolveRange("America/Toronto", { from: "2026-03-08", to: "2026-03-08" });
  assert.equal(r.to - r.from, 23 * 3600 * 1000);
  const f = await reportExport.resolveRange("America/Toronto", { from: "2026-11-01", to: "2026-11-01" });
  assert.equal(f.to - f.from, 25 * 3600 * 1000);
});

test("settings: defaults, environment seeding, exact-name validation, admin-only edits, audited", async () => {
  const get = async () => (await raw("/jobsearch/reports/settings", tk.X)).json;
  let st = await get();
  assert.equal(st.report_timezone, "Africa/Tunis");
  assert.equal(st.report_schedule_enabled, false, "scheduling is off by default");
  process.env.HR_TIMEZONE = "Europe/Paris";
  assert.equal((await get()).report_timezone, "Europe/Paris", "HR_TIMEZONE is the fallback");
  process.env.REPORT_TIMEZONE = "America/Toronto";
  assert.equal((await get()).report_timezone, "America/Toronto", "REPORT_TIMEZONE wins");
  process.env.REPORT_TIMEZONE = "UTC+1"; // POSIX style: not a pg_timezone_names entry
  assert.equal((await get()).report_timezone, "Europe/Paris", "an invalid value is ignored");
  process.env.REPORT_TIMEZONE = "africa/tunis"; // wrong case
  assert.equal((await get()).report_timezone, "Europe/Paris");
  delete process.env.REPORT_TIMEZONE;
  delete process.env.HR_TIMEZONE;
  process.env.REPORT_SCHEDULE_ENABLED = "true";
  assert.equal((await get()).report_schedule_enabled, true, "the environment seeds the schedule switch");
  // admin edits
  assert.equal((await setSettings(tk.admin, { report_schedule_enabled: false })).json.report_schedule_enabled, false, "a stored value overrides the environment");
  delete process.env.REPORT_SCHEDULE_ENABLED;
  for (const bad of ["UTC+1", "africa/tunis", "Mars/Olympus", "", 5]) {
    assert.equal((await setSettings(tk.admin, { report_timezone: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await setSettings(tk.admin, { report_schedule_enabled: "yes" })).status, 400);
  assert.equal((await setSettings(tk.admin, { other: 1 })).status, 400);
  assert.equal((await setSettings(tk.admin, {})).status, 400);
  for (const t of [tk.X, tk.Y, tk.accountant, tk.candA]) assert.equal((await setSettings(t, { report_timezone: "UTC" })).status, 403);
  assert.equal((await setSettings(null, { report_timezone: "UTC" })).status, 401);
  assert.equal((await setSettings(tk.admin, { report_timezone: "Asia/Tokyo" })).json.report_timezone, "Asia/Tokyo");
  const aud = await one("SELECT detail FROM js_audit_events WHERE action = 'report.settings' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(aud.detail.values, { report_timezone: "Asia/Tokyo" });
  assert.equal((await raw("/jobsearch/reports/settings", tk.candA)).status, 403);
  await setSettings(tk.admin, { report_timezone: null, report_schedule_enabled: false });
  await q("DELETE FROM js_module_state WHERE key = 'report_settings'");
});

// ---------------------------------------------------------------- limits and validation

test("range cap: 366 days is accepted, 367 is not; bad dates, formats and parameters are 400", async () => {
  const ok = await exportCompany(tk.admin, { format: "xlsx", from: "2025-03-31", to: "2026-03-31" });
  assert.equal(ok.status, 200, "366 inclusive days");
  const tooLong = await exportCompany(tk.admin, { format: "xlsx", from: "2025-03-30", to: "2026-03-31" });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.json.error, /366/);
  assert.equal((await activity(tk.X, s.cand.A, { format: "pdf", from: "2024-01-01", to: "2026-03-31" })).status, 400);
  for (const o of [
    { from: "2026-02-30" }, { from: "2026-03-01T00:00:00Z" }, { from: "yesterday" }, { to: "2026-13-01" }, { from: "2026-04-02", to: "2026-04-01" },
    { format: "docx" }, { format: "csv" }, { groupBy: "everything" }, { period: "year" },
  ]) {
    const r = await exportCompany(tk.admin, { format: "pdf", ...o });
    assert.equal(r.status, 400, JSON.stringify(o));
  }
  const dup = await raw("/jobsearch/reports/export?format=pdf&format=xlsx", tk.admin);
  assert.equal(dup.status, 400);
  const nested = await raw("/jobsearch/reports/export?from[a]=1", tk.admin);
  assert.equal(nested.status, 400);
});

test("row cap: an over-long report is refused (413), never silently truncated", async () => {
  process.env.JOBSEARCH_REPORT_MAX_ROWS = "2";
  try {
    const r = await exportCompany(tk.admin, { format: "xlsx", from: "2026-03-01", to: "2026-03-31", groupBy: "candidate" });
    assert.equal(r.status, 413);
    const ok = await exportCompany(tk.admin, { format: "xlsx", from: "2026-03-01", to: "2026-03-31", groupBy: "period", period: "month" });
    assert.equal(ok.status, 200, "one month row fits");
  } finally {
    delete process.env.JOBSEARCH_REPORT_MAX_ROWS;
  }
});

test("generation rate limit answers 429 with Retry-After", async () => {
  process.env.JOBSEARCH_REPORT_RATE_PER_HOUR = "2";
  reportExport._resetRateLimit();
  try {
    assert.equal((await exportCompany(tk.Y, { format: "xlsx" })).status, 200);
    assert.equal((await exportCompany(tk.Y, { format: "xlsx" })).status, 200);
    const r = await exportCompany(tk.Y, { format: "xlsx" });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
  } finally {
    process.env.JOBSEARCH_REPORT_RATE_PER_HOUR = "100000";
    reportExport._resetRateLimit();
  }
});

// ---------------------------------------------------------------- snapshots

test("snapshots are immutable and verifiable: stored payload hash, files, no updates or deletes", async () => {
  const r = await activity(tk.X, s.cand.A, { format: "xlsx", from: "2026-03-01", to: "2026-03-31" });
  const id = r.headers.get("x-report-snapshot");
  const row = await one("SELECT * FROM js_report_snapshots WHERE id = $1", [id]);
  assert.equal(crypto.createHash("sha256").update(stableStringify(row.payload)).digest("hex"), row.payload_sha256);
  assert.equal(row.payload.activities.applicationsSent, 5);
  // later data changes do not alter the snapshot
  await assert.rejects(() => q("UPDATE js_report_snapshots SET payload = '{}'::jsonb WHERE id = $1", [id]), /insert-only/);
  await assert.rejects(() => q("DELETE FROM js_report_snapshots WHERE id = $1", [id]), /insert-only/);
  await assert.rejects(() => q("UPDATE js_report_snapshots SET pdf_key = NULL WHERE id = $1", [id]), /insert-only/);
  // both formats were stored; the xlsx downloaded now is byte-identical to the one returned at generation
  const dl = await raw(`/jobsearch/reports/snapshots/${id}/download?format=xlsx`, tk.X);
  assert.equal(dl.status, 200);
  assert.ok(dl.buf.equals(r.buf));
  const pdf = await raw(`/jobsearch/reports/snapshots/${id}/download?format=pdf`, tk.X);
  assert.equal(pdf.buf.subarray(0, 5).toString(), "%PDF-");
  const ref = row.payload.candidate.reference;
  assert.equal(dl.headers.get("content-disposition"), `attachment; filename="${ref}-activity-2026-03-01_2026-03-31.xlsx"`);
  // a tampered stored file is detected
  const file = path.join(process.env.STORAGE_DIR, row.xlsx_key);
  const orig = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([orig, Buffer.from("x")]));
  try {
    assert.equal((await raw(`/jobsearch/reports/snapshots/${id}/download?format=xlsx`, tk.X)).status, 500);
  } finally {
    fs.writeFileSync(file, orig);
  }
});

test("snapshot listing and download are scoped: candidate-level by scope, custom by generator/admin, scheduled by Admin/Manager", async () => {
  await q("TRUNCATE js_report_snapshots");
  const a = (await activity(tk.X, s.cand.A, { format: "pdf", from: "2026-03-01", to: "2026-03-31" })).headers.get("x-report-snapshot");
  const c = (await activity(tk.Y, s.cand.C, { format: "pdf", from: "2026-03-01", to: "2026-03-31" })).headers.get("x-report-snapshot");
  const customX = (await exportCompany(tk.X, { format: "pdf" })).headers.get("x-report-snapshot");
  const customY = (await exportCompany(tk.Y, { format: "pdf" })).headers.get("x-report-snapshot");
  const sched = Number((await one(
    `INSERT INTO js_report_snapshots (kind, period_start, period_end, timezone, payload, payload_sha256) VALUES ('daily','2026-03-01','2026-03-02','UTC','{"period":{"from":"2026-03-01","to":"2026-03-01"},"flags":[]}'::jsonb,$1) RETURNING id`, ["b".repeat(64)])).id);
  const ids = async (tok, params = {}) => (await raw(`/jobsearch/reports/snapshots?${qs(params)}`, tok)).json.snapshots.map((x) => String(x.id)).sort();
  assert.deepEqual(await ids(tk.admin), [a, c, customX, customY, String(sched)].sort());
  assert.deepEqual(await ids(tk.X), [a, customX, String(sched)].sort(), "manager: own candidates, own custom, scheduled company snapshots");
  assert.deepEqual(await ids(tk.Y), [c, customY].sort(), "agent: own candidates and own custom only");
  assert.deepEqual(await ids(tk.admin, { kind: "daily" }), [String(sched)]);
  assert.deepEqual(await ids(tk.admin, { candidateId: s.cand.A }), [a]);
  for (const t of [tk.accountant, tk.hr, tk.candA]) assert.equal((await raw("/jobsearch/reports/snapshots", t)).status, 403);
  assert.equal((await raw("/jobsearch/reports/snapshots", null)).status, 401);
  assert.equal((await raw("/jobsearch/reports/snapshots?kind=nope", tk.admin)).status, 400);
  assert.equal((await raw("/jobsearch/reports/snapshots?limit=500", tk.admin)).status, 400);
  const dl = (tok, id, f = "pdf") => raw(`/jobsearch/reports/snapshots/${id}/download?format=${f}`, tok);
  assert.equal((await dl(tk.Y, a)).status, 404, "agent Y cannot download X's candidate snapshot");
  assert.equal((await dl(tk.X, c)).status, 404);
  assert.equal((await dl(tk.Y, customX)).status, 404);
  assert.equal((await dl(tk.X, customY)).status, 404);
  assert.equal((await dl(tk.admin, customY)).status, 200);
  assert.equal((await dl(tk.Y, String(sched))).status, 404, "scheduled company snapshots: Admin / SuperAdmin / Manager only");
  assert.equal((await dl(tk.X, String(sched))).status, 404, "no stored file -> 404");
  assert.equal((await dl(tk.candA, a)).status, 403);
  assert.equal((await dl(tk.admin, a, "docx")).status, 400);
  assert.equal((await dl(tk.admin, 999999)).status, 404);
  assert.equal((await dl(tk.admin, "abc")).status, 400);
  // reassigning the candidate removes the old agent's access at once (scope is re-checked on every request)
  await q("UPDATE candidates SET assigned_to = $1 WHERE id = $2", [s.users.Y, s.cand.A]);
  try {
    assert.equal((await dl(tk.X, a)).status, 404);
    assert.equal((await dl(tk.Y, a)).status, 200);
  } finally {
    await q("UPDATE candidates SET assigned_to = $1 WHERE id = $2", [s.users.X, s.cand.A]);
  }
  // the listing never exposes storage keys or the payload
  const body = JSON.stringify((await raw("/jobsearch/reports/snapshots", tk.admin)).json);
  assert.ok(!/\.pdf"|\.xlsx"|payload"|storage|"key"/.test(body.replace(/payloadSha256/g, "")), body.slice(0, 300));
});

// ---------------------------------------------------------------- scheduler

const tick = (now) => scheduler.tick(now, { deps: { onStep: async (name) => (name === "report_snapshots" ? undefined : "skip") } });
const snaps = async () => (await q("SELECT id, kind, period_start, period_end, generated_by, generated_at, timezone, payload FROM js_report_snapshots WHERE kind IN ('daily','weekly','monthly') ORDER BY kind, period_start")).rows;

test("scheduler: disabled by default - nothing is created", async () => {
  await q("TRUNCATE js_report_snapshots");
  const sum = await tick(new Date("2026-04-01T00:05:00+01:00"));
  assert.deepEqual(sum.errors, []);
  assert.equal((await snaps()).length, 0);
  assert.equal(sum.reportSnapshots, undefined);
});

test("scheduler: daily / weekly / monthly company snapshots for the previous full period, idempotent across a month boundary (injected clock)", async () => {
  await q("TRUNCATE js_report_snapshots");
  assert.equal((await setSettings(tk.admin, { report_schedule_enabled: true })).status, 200);
  try {
    // 2026-04-01 00:05 in Tunis (= 2026-03-31T23:05Z): the first moment after local midnight on the 1st (a Wednesday)
    const t1 = new Date("2026-03-31T23:05:00Z");
    const s1 = await tick(t1);
    assert.deepEqual(s1.errors, []);
    assert.deepEqual(s1.reportSnapshots, { created: 3, existing: 0 });
    let rows = await snaps();
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
    assert.equal(by.daily.period_start.toISOString(), "2026-03-30T23:00:00.000Z", "yesterday 03-31 local");
    assert.equal(by.daily.period_end.toISOString(), "2026-03-31T23:00:00.000Z");
    assert.equal(by.weekly.period_start.toISOString(), "2026-03-22T23:00:00.000Z", "Monday 03-23 local");
    assert.equal(by.weekly.period_end.toISOString(), "2026-03-29T23:00:00.000Z", "up to Monday 03-30 local");
    assert.equal(by.monthly.period_start.toISOString(), "2026-02-28T23:00:00.000Z", "March 1st local");
    assert.equal(by.monthly.period_end.toISOString(), "2026-03-31T23:00:00.000Z");
    for (const r of rows) {
      assert.equal(r.generated_by, null, "created by the scheduler");
      assert.equal(r.timezone, "Africa/Tunis");
      assert.equal(r.payload.scope, "all");
      assert.equal(r.generated_at.toISOString(), t1.toISOString(), "stamped with the injected clock");
    }
    // the monthly numbers are the numbers of the whole of March (company-wide), equal to raw SQL
    const want = await indepAll("admin", ...MARCH_TUNIS);
    assert.deepEqual(by.monthly.payload.totals, want);
    assert.equal(by.monthly.payload.groupBy, "period");
    assert.ok(by.monthly.payload.rows.every((r) => !("label" in r) || r.label === null), "company snapshots hold aggregates by day, no names");
    // files exist and carry the same totals
    const full = await one("SELECT pdf_key, xlsx_key FROM js_report_snapshots WHERE id = $1", [by.monthly.id]);
    const wb = readXlsx(await storage.get(full.xlsx_key));
    const trows = cellVals(wb.Report);
    const total = trows[trows.length - 1];
    METRICS.forEach((m, i) => assert.equal(total[2 + i], want[m], m));
    assert.ok((await pdfInfo(await storage.get(full.pdf_key))).text.includes("Reporting period 2026-03-01 - 2026-03-31"));
    // audited as the scheduler
    const au = await q("SELECT actor, detail FROM js_audit_events WHERE action = 'report.generate' AND actor = 'system:scheduler'");
    assert.equal(au.rowCount, 3);

    // same period again, a minute later and an hour later: nothing new
    for (const t of ["2026-03-31T23:06:00Z", "2026-04-01T08:00:00Z", "2026-04-01T21:59:00Z"]) {
      const sx = await tick(new Date(t));
      assert.deepEqual(sx.reportSnapshots, { created: 0, existing: 3 }, t);
    }
    assert.equal((await snaps()).length, 3);

    // the next local day: only the new daily snapshot (04-01); the week and the month are unchanged
    const s2 = await tick(new Date("2026-04-01T23:30:00Z")); // 2026-04-02 00:30 Tunis
    assert.deepEqual(s2.reportSnapshots, { created: 1, existing: 2 });
    rows = await snaps();
    assert.equal(rows.filter((r) => r.kind === "daily").length, 2);
    const apr1 = rows.find((r) => r.kind === "daily" && r.period_start.toISOString() === "2026-03-31T23:00:00.000Z");
    // nothing happened on 04-01 in the seed: the snapshot says so with zeros, and has no invented rows
    assert.deepEqual(apr1.payload.totals, Object.fromEntries(METRICS.map((m) => [m, 0])));
    assert.deepEqual(apr1.payload.rows, []);

    // the following Monday (04-06 local): the week of 03-30 .. 04-05 appears
    const s3 = await tick(new Date("2026-04-05T23:10:00Z")); // Monday 04-06 00:10 Tunis
    assert.equal(s3.reportSnapshots.created >= 2, true, "daily for 04-05 and weekly for 03-30");
    assert.ok((await snaps()).some((r) => r.kind === "weekly" && r.period_start.toISOString() === "2026-03-29T23:00:00.000Z"));
    const n = (await snaps()).length;
    await tick(new Date("2026-04-05T23:11:00Z"));
    assert.equal((await snaps()).length, n);
  } finally {
    await setSettings(tk.admin, { report_schedule_enabled: false });
  }
});

test("scheduler: concurrent runs create exactly one snapshot per (kind, period_start)", async () => {
  await q("TRUNCATE js_report_snapshots");
  await setSettings(tk.admin, { report_schedule_enabled: true });
  try {
    const now = new Date("2026-05-12T10:00:00Z");
    const results = await Promise.all([1, 2, 3, 4].map(() => reportExport.ensureScheduledSnapshots({ now })));
    assert.equal(results.reduce((a, r) => a + r.created.length, 0), 3, "3 snapshots created in total across 4 racing runs");
    assert.deepEqual(results.flatMap((r) => r.errors), []);
    assert.equal((await snaps()).length, 3);
  } finally {
    await setSettings(tk.admin, { report_schedule_enabled: false });
  }
});

test("scheduler: a DST day is cut in the report timezone (Toronto, 2026-03-08 has 23 hours)", async () => {
  await q("TRUNCATE js_report_snapshots");
  await setSettings(tk.admin, { report_timezone: "America/Toronto", report_schedule_enabled: true });
  try {
    await reportExport.ensureScheduledSnapshots({ now: new Date("2026-03-09T12:00:00Z") });
    const d = (await snaps()).find((r) => r.kind === "daily");
    assert.equal(d.period_start.toISOString(), "2026-03-08T05:00:00.000Z");
    assert.equal(d.period_end.toISOString(), "2026-03-09T04:00:00.000Z");
    assert.equal(d.timezone, "America/Toronto");
  } finally {
    await setSettings(tk.admin, { report_timezone: null, report_schedule_enabled: false });
  }
});

test("scheduler: a failure is recorded by kind and code only, other kinds still run, nothing partial is stored", async () => {
  await q("TRUNCATE js_report_snapshots");
  await setSettings(tk.admin, { report_schedule_enabled: true });
  process.env.JOBSEARCH_REPORT_MAX_ROWS = "1"; // the March report has more than one day row -> 413 for monthly; the daily/weekly fit
  try {
    const sum = await tick(new Date("2026-03-31T23:05:00Z"));
    assert.ok(sum.errors.length >= 1);
    for (const e of sum.errors) {
      assert.equal(e.step, "report_snapshots");
      assert.match(e.message, /^report_snapshot_failed:(daily|weekly|monthly):[A-Za-z0-9_]+$/, "no report data in the message");
    }
    const kinds = (await snaps()).map((r) => r.kind);
    assert.ok(!kinds.includes("monthly"), "the failed kind left no row");
    assert.ok(kinds.includes("daily"));
  } finally {
    delete process.env.JOBSEARCH_REPORT_MAX_ROWS;
    await setSettings(tk.admin, { report_schedule_enabled: false });
  }
  // once the cause is gone the next run completes the missing kind
  await setSettings(tk.admin, { report_schedule_enabled: true });
  try {
    await tick(new Date("2026-03-31T23:10:00Z"));
    assert.ok((await snaps()).some((r) => r.kind === "monthly"));
  } finally {
    await setSettings(tk.admin, { report_schedule_enabled: false });
  }
});
