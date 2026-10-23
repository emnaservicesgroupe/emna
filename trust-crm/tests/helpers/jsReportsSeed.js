// Realistic, deterministic dataset for the Task 14 dashboard/report/export/SSE/isolation tests.
// Staff X (Manager) owns candidates A, B and the soft-deleted D; staff Y (Agent) owns C. Rows are
// written directly with explicit timestamps in March 2026 so report date edges are exact.
const jwt = require("jsonwebtoken");

const T = (day, hour = 10, min = 0) => new Date(Date.UTC(2026, 2, day, hour, min, 0)); // 2026-03-<day>

async function seed(pool) {
  const q = (sql, params) => pool.query(sql, params);
  const one = async (sql, params) => (await q(sql, params)).rows[0];
  let n = 0;
  const user = async (role, name) => {
    n += 1;
    return (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [name, `${name.toLowerCase().replace(/\W+/g, "")}${n}@reports.test.invalid`, role])).id;
  };
  const s = { users: {}, cand: {}, apps: {}, jobs: [], sources: {} };
  s.users.admin = await user("Admin", "Admin One");
  s.users.X = await user("Manager", "Staff X");
  s.users.Y = await user("Agent", "Staff Y");
  s.users.accountant = await user("Accountant", "Acc Ount");
  s.users.hr = await user("HR", "Hr Person");
  s.users.receptionist = await user("Receptionist", "Rec Eption");

  const candidate = async (key, staff, { deleted = false, profession } = {}) => {
    const id = (await one("INSERT INTO candidates (full_name, passport_number, assigned_to, is_deleted) VALUES ($1,$2,$3,$4) RETURNING id", [`Candidate ${key}`, `PP-RPT-${key}`, staff, deleted])).id;
    await q("INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1,$2::jsonb,'confirmed',now())", [id, JSON.stringify({ name: `Candidate ${key}`, profession })]);
    const uid = await user("Candidate", `Cand ${key}`);
    await q("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [uid, id]);
    s.cand[key] = id;
    s.users[`cand${key}`] = uid;
    return id;
  };
  await candidate("A", s.users.X, { profession: "Electrician" });
  await candidate("B", s.users.X, { profession: "Welder" });
  await candidate("C", s.users.Y, { profession: "Electrician" });
  await candidate("D", s.users.X, { deleted: true, profession: "Plumber" });

  for (const key of ["src_alpha", "src_beta"]) {
    s.sources[key] = (await one("INSERT INTO js_sources (key, adapter, status, last_error, last_run_at) VALUES ($1,'partner_feed','connected',$2,$3) RETURNING id", [
      key,
      key === "src_beta" ? "fetch failed for https://feeduser:S3cretPass@feed.example/jobs?token=abc123SECRET&x=1 contact ops@vita.example" : null,
      T(20),
    ])).id;
  }
  await q("INSERT INTO js_runs (source_id, started_at, finished_at, found, new_count, errors) VALUES ($1,$2,$3,4,2,$4::jsonb)", [s.sources.src_beta, T(20), T(20, 10, 5), JSON.stringify([{ status: "failed", message: "401 for https://u:pw123@api.example/v1?api_key=KEY999", attempts: 2 }])]);
  await q("INSERT INTO js_runs (source_id, started_at, finished_at, found, new_count) VALUES ($1,$2,$3,7,3)", [s.sources.src_alpha, T(21), T(21, 10, 1)]);
  const emp = [
    (await one("INSERT INTO js_employers (name, normalized_name, domain) VALUES ('Northwind Energy','northwind energy','northwind.example') RETURNING id")).id,
    (await one("INSERT INTO js_employers (name, normalized_name, domain) VALUES ('Contoso Build','contoso build','contoso.example') RETURNING id")).id,
  ];
  s.employers = emp;
  const COUNTRIES = ["Canada", "Germany", "UAE"];
  const TITLES = ["Electrician", "Welder", "Site Electrician"];

  let j = 0;
  const job = async (day) => {
    j += 1;
    const country = COUNTRIES[j % 3];
    const srcKey = j % 2 ? "src_alpha" : "src_beta";
    const id = (await one(
      "INSERT INTO js_jobs (title, country, location, employer_id, source_primary, dedupe_key, url, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [TITLES[j % 3], country, `${country} city`, emp[j % 2], srcKey, `dk-rpt-${j}`, `https://jobs.example/r${j}`, T(day, 8)]
    )).id;
    await q("INSERT INTO js_job_sightings (job_id, source_id, source_job_id, url, seen_at) VALUES ($1,$2,$3,$4,$5)", [id, s.sources[srcKey], `rj-${j}`, `https://jobs.example/r${j}`, T(day, 8)]);
    s.jobs.push(id);
    return id;
  };

  // Per candidate: a list of [final status, day]. Statuses drive the derived rows.
  const PLAN = {
    A: [["matched", 2], ["preparing", 3], ["ready_for_review", 5], ["queued", 6], ["sent", 8], ["confirmed_submitted", 10], ["interview", 12], ["offer", 14], ["rejected", 15], ["needs_staff", 16], ["outcome_unknown", 18], ["failed", 20], ["cancelled", 22], ["closed", 25]],
    B: [["ready_for_review", 4], ["sent", 9], ["confirmed_submitted", 15], ["rejected", 28]],
    C: [["preparing", 1], ["sent", 7], ["confirmed_submitted", 11], ["interview", 15], ["offer", 30], ["needs_staff", 31], ["outcome_unknown", 14]],
    D: [["sent", 9], ["offer", 12]],
  };
  const PREPARED = new Set(["ready_for_review", "approved", "queued", "sent", "confirmed_submitted", "interview", "offer", "rejected", "needs_staff", "outcome_unknown", "failed", "closed"]);
  const SENT = new Set(["sent", "confirmed_submitted", "interview", "offer", "rejected"]);
  let sub = 0;
  let msg = 0;
  for (const [key, plan] of Object.entries(PLAN)) {
    const cid = s.cand[key];
    const staff = key === "C" ? s.users.Y : s.users.X;
    s.apps[key] = [];
    // two extra matches without application (one on a closed job)
    for (const extra of [1, 2]) {
      const jid = await job(extra + 1);
      if (extra === 2) await q("UPDATE js_jobs SET status='closed' WHERE id=$1", [jid]);
      await q("INSERT INTO js_matches (candidate_id, job_id, score, created_at) VALUES ($1,$2,55,$3)", [cid, jid, T(extra + 1, 9)]);
    }
    for (const [status, day] of plan) {
      const jid = await job(day);
      await q("INSERT INTO js_matches (candidate_id, job_id, score, employer_support, created_at) VALUES ($1,$2,80,'unknown',$3)", [cid, jid, T(day, 9)]);
      const appId = (await one(
        "INSERT INTO js_applications (candidate_id, job_id, status, mode_at_creation, responsible_user_id, created_at, updated_at) VALUES ($1,$2,$3,'prepare_for_approval',$4,$5,$6) RETURNING id",
        [cid, jid, status, staff, T(day, 10), T(day, 18)]
      )).id;
      s.apps[key].push({ id: appId, status, jobId: jid, day });
      await q("INSERT INTO js_timeline (application_id, actor, event, detail, created_at) VALUES ($1,'system','created','{}'::jsonb,$2)", [appId, T(day, 10)]);
      if (PREPARED.has(status)) {
        await q("INSERT INTO js_timeline (application_id, actor, event, detail, created_at) VALUES ($1,'system','package_built','{}'::jsonb,$2)", [appId, T(day, 11)]);
        // a second package build later must not double count 'prepared'
        if (status === "closed") await q("INSERT INTO js_timeline (application_id, actor, event, detail, created_at) VALUES ($1,'system','package_built','{}'::jsonb,$2)", [appId, T(day, 12)]);
      }
      const subRow = async (st, opts = {}) => {
        sub += 1;
        return (await one(
          "INSERT INTO js_submissions (application_id, attempt_no, idempotency_key, channel, recipient, provider_message_id, status, sent_at, confirmed_at, evidence, created_at) VALUES ($1,$2,$3,'email',$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id",
          [appId, opts.attempt || 1, `idem-rpt-${sub}`, `=HYPERLINK("http://evil.example")@${key.toLowerCase()}.example`, `<prov-${sub}@sandbox.invalid>`, st, opts.sentAt || null, opts.confirmedAt || null, st === "confirmed_submitted" ? JSON.stringify({ kind: "manual_confirmation" }) : null, opts.createdAt || T(day, 13)]
        )).id;
      };
      if (status === "queued") await subRow("queued");
      if (SENT.has(status)) {
        const confirmed = status !== "sent";
        await subRow(confirmed ? "confirmed_submitted" : "sent", { sentAt: T(day, 14), confirmedAt: confirmed ? T(day, 16) : null });
      }
      if (status === "outcome_unknown") await subRow("outcome_unknown");
      if (status === "failed") {
        await subRow("failed");
        await subRow("failed", { attempt: 2, createdAt: T(day, 15) });
      }
      if (status === "needs_staff") {
        await subRow("outcome_unknown");
        await q("INSERT INTO js_tasks (application_id, reason, detail, assigned_to, created_at) VALUES ($1,'verify_delivery','check delivery to hr@secret.example',$2,$3)", [appId, staff, T(day, 15)]);
      }
      if (["confirmed_submitted", "interview", "offer", "rejected"].includes(status)) {
        msg += 1;
        await q(
          "INSERT INTO js_messages (direction, message_id, application_id, from_addr, subject, review_state, body_sanitized, ai_summary, received_at, shared_with_candidate, classification) VALUES ('in',$1,$2,$3,$4,'matched','Body text','Employer replied',$5,$6,$7::jsonb)",
          [`<in-${msg}@mail.example>`, appId, `hr@employer${msg}.example`, `+Re: application, "quoted" line\nsecond`, T(day, 17), status !== "confirmed_submitted", JSON.stringify({ category: "acknowledgement" })]
        );
      }
      if (["interview", "offer"].includes(status)) {
        await q("INSERT INTO js_appointments (staff_user_id, candidate_id, application_id, starts_at, ends_at, status, tz, created_at) VALUES ($1,$2,$3,$4,$5,'tentative','UTC',$6)", [staff, cid, appId, T(day + 2, 9 + (appId % 8)), T(day + 2, 10 + (appId % 8)), T(day, 19)]);
      }
      if (status === "offer" || status === "rejected") {
        await q("INSERT INTO js_timeline (application_id, actor, event, detail, created_at) VALUES ($1,'staff:1','status_changed',$2::jsonb,$3)", [appId, JSON.stringify({ from: "sent", to: status }), T(day, 20)]);
      }
    }
  }
  // a cancelled appointment (not counted), an unmatched review-queue message (admin only), a needs_review message on A
  const a0 = s.apps.A.find((a) => a.status === "interview");
  await q("INSERT INTO js_appointments (staff_user_id, candidate_id, application_id, starts_at, ends_at, status, tz, created_at) VALUES ($1,$2,$3,$4,$5,'cancelled','UTC',$6)", [s.users.X, s.cand.A, a0.id, T(26, 9), T(26, 10), T(12, 19)]);
  await q("INSERT INTO js_messages (direction, message_id, from_addr, subject, review_state, received_at) VALUES ('in','<unmatched-1@mail.example>','stranger@unknown.example','Hello','needs_review',$1)", [T(13)]);
  // candidate-level scheduler task for B (no application) - counted for X only
  await q("INSERT INTO js_tasks (application_id, reason, detail, assigned_to, created_at) VALUES (NULL,'prepare_consent_missing',$1,$2,$3)", [`candidate:${s.cand.B}: no prepare consent`, s.users.X, T(5)]);
  // queue + module state for /health
  await q("INSERT INTO js_queue (kind, payload, status, locked_at) VALUES ('submit','{\"applicationId\":1}'::jsonb,'running', now() - interval '40 minutes')");
  await q("INSERT INTO js_queue (kind, payload, status) VALUES ('search','{}'::jsonb,'pending'), ('search','{}'::jsonb,'done')");
  await q("INSERT INTO js_module_state (key, value) VALUES ('scheduler_last_tick', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify({ at: T(21).toISOString(), finishedAt: T(21, 10, 1).toISOString(), summary: { errors: [{ message: "x" }] } })]);
  // events: candidate + staff audience for A and C, an unscoped system event
  for (const key of ["A", "C"]) {
    const app = s.apps[key][0].id;
    await q("INSERT INTO js_events (candidate_id, kind, payload, audience) VALUES ($1,'application.status_changed',$2::jsonb,'candidate')", [s.cand[key], JSON.stringify({ applicationId: app, from: "matched", to: "preparing", secret: "x" })]);
    await q("INSERT INTO js_events (candidate_id, kind, payload, audience, user_id) VALUES ($1,'staff.reply_received',$2::jsonb,'staff',$3)", [s.cand[key], JSON.stringify({ applicationId: app, messageId: 5, from: "hr@employer.example" }), key === "A" ? s.users.X : s.users.Y]);
  }
  await q("INSERT INTO js_events (candidate_id, kind, payload) VALUES (NULL,'module.paused','{\"paused\":true}'::jsonb)");
  return s;
}

function tokens(s, secret) {
  const t = {};
  const sign = (id, role, tv) => jwt.sign(tv === undefined ? { id, role } : { id, role, tv }, secret, { expiresIn: "1h" });
  t.admin = sign(s.users.admin, "Admin");
  t.X = sign(s.users.X, "Manager");
  t.Y = sign(s.users.Y, "Agent");
  t.accountant = sign(s.users.accountant, "Accountant");
  t.hr = sign(s.users.hr, "HR");
  t.receptionist = sign(s.users.receptionist, "Receptionist");
  t.candA = sign(s.users.candA, "Candidate", 0);
  t.candB = sign(s.users.candB, "Candidate", 0);
  t.candC = sign(s.users.candC, "Candidate", 0);
  return t;
}

module.exports = { seed, tokens, T };
