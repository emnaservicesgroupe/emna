const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb } = require("./helpers/db");

async function seed(pool) {
  const u = await pool.query(
    "INSERT INTO users (full_name,email,password,role) VALUES ('S','s@x.io','h','Agent') RETURNING id"
  );
  const c = await pool.query("INSERT INTO candidates (full_name, passport_number) VALUES ('Cand','P1') RETURNING id");
  const j = await pool.query(
    "INSERT INTO js_jobs (title, dedupe_key) VALUES ('Nurse','dk1') RETURNING id"
  );
  return { userId: u.rows[0].id, candidateId: c.rows[0].id, jobId: j.rows[0].id };
}

async function withDb(fn) {
  const { pool, cleanup } = await createTestDb();
  try {
    await fn(pool, await seed(pool));
  } finally {
    await cleanup();
  }
}

async function newApp(pool, s) {
  const r = await pool.query(
    "INSERT INTO js_applications (candidate_id, job_id) VALUES ($1,$2) RETURNING id",
    [s.candidateId, s.jobId]
  );
  return r.rows[0].id;
}

test("duplicate (candidate_id, job_id) application is rejected", () =>
  withDb(async (pool, s) => {
    await newApp(pool, s);
    await assert.rejects(newApp(pool, s), /duplicate key|unique/i);
  }));

test("duplicate (candidate_id, job_id) match is rejected", () =>
  withDb(async (pool, s) => {
    const q = "INSERT INTO js_matches (candidate_id, job_id, score) VALUES ($1,$2,80)";
    await pool.query(q, [s.candidateId, s.jobId]);
    await assert.rejects(pool.query(q, [s.candidateId, s.jobId]), /duplicate key|unique/i);
  }));

test("invalid submission status is rejected", () =>
  withDb(async (pool, s) => {
    const appId = await newApp(pool, s);
    await assert.rejects(
      pool.query(
        "INSERT INTO js_submissions (application_id, idempotency_key, status) VALUES ($1,'k1','bogus')",
        [appId]
      ),
      /check constraint/i
    );
    await pool.query(
      "INSERT INTO js_submissions (application_id, idempotency_key, status) VALUES ($1,'k1','queued')",
      [appId]
    );
  }));

test("duplicate idempotency_key is rejected", () =>
  withDb(async (pool, s) => {
    const appId = await newApp(pool, s);
    const q = "INSERT INTO js_submissions (application_id, attempt_no, idempotency_key, status) VALUES ($1,$2,'same','queued')";
    await pool.query(q, [appId, 1]);
    await assert.rejects(pool.query(q, [appId, 2]), /duplicate key|unique/i);
  }));

test("invalid application status, source status, employer support are rejected", () =>
  withDb(async (pool, s) => {
    await assert.rejects(
      pool.query("INSERT INTO js_applications (candidate_id, job_id, status) VALUES ($1,$2,'nope')", [
        s.candidateId,
        s.jobId,
      ]),
      /check constraint/i
    );
    await assert.rejects(
      pool.query("INSERT INTO js_sources (key, adapter, status) VALUES ('a','b','nope')"),
      /check constraint/i
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO js_matches (candidate_id, job_id, score, employer_support) VALUES ($1,$2,1,'nope')",
        [s.candidateId, s.jobId]
      ),
      /check constraint/i
    );
    await assert.rejects(
      pool.query("INSERT INTO js_candidate_settings (candidate_id, mode) VALUES ($1,'nope')", [s.candidateId]),
      /check constraint/i
    );
    await assert.rejects(
      pool.query("INSERT INTO js_jobs (title, dedupe_key, status) VALUES ('t','dk2','nope')"),
      /check constraint/i
    );
  }));

test("js_timeline update and delete raise; insert works", () =>
  withDb(async (pool, s) => {
    const appId = await newApp(pool, s);
    await pool.query("INSERT INTO js_timeline (application_id, actor, event) VALUES ($1,'sys','created')", [appId]);
    await assert.rejects(pool.query("UPDATE js_timeline SET event='x'"), /insert-only|append-only/i);
    await assert.rejects(pool.query("DELETE FROM js_timeline"), /insert-only|append-only/i);
  }));

test("js_audit_events update and delete raise", () =>
  withDb(async (pool) => {
    await pool.query("INSERT INTO js_audit_events (actor, action) VALUES ('sys','consent.granted')");
    await assert.rejects(pool.query("UPDATE js_audit_events SET action='x'"), /insert-only|append-only/i);
    await assert.rejects(pool.query("DELETE FROM js_audit_events"), /insert-only|append-only/i);
  }));

test("overlapping non-cancelled appointments for one staff user are rejected, cancelled ones are not", () =>
  withDb(async (pool, s) => {
    const ins = (start, end, status) =>
      pool.query(
        "INSERT INTO js_appointments (staff_user_id, candidate_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,$5)",
        [s.userId, s.candidateId, start, end, status]
      );
    await ins("2026-11-01T10:00Z", "2026-11-01T11:00Z", "confirmed");
    await assert.rejects(ins("2026-11-01T10:30Z", "2026-11-01T11:30Z", "tentative"), /conflicting key|exclusion/i);
    await ins("2026-11-01T10:30Z", "2026-11-01T11:30Z", "cancelled");
    await ins("2026-11-01T11:00Z", "2026-11-01T12:00Z", "tentative"); // adjacent is fine
    await assert.rejects(ins("2026-11-02T10:00Z", "2026-11-02T11:00Z", "bogus"), /check constraint/i);
  }));

test("shared tables exist with expected constraints", () =>
  withDb(async (pool, s) => {
    await pool.query("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [s.userId, s.candidateId]);
    await assert.rejects(
      pool.query("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [s.userId, s.candidateId]),
      /duplicate key/i
    );
    await pool.query("INSERT INTO js_otps (email, code_hash, expires_at) VALUES ('a@b.c','h', now())");
    await pool.query("INSERT INTO js_module_state (key, value) VALUES ('k','{}')");
    // sources / sightings / jobs uniqueness
    const src = await pool.query("INSERT INTO js_sources (key, adapter) VALUES ('s1','test_fixture') RETURNING id");
    const sight = "INSERT INTO js_job_sightings (job_id, source_id, source_job_id) VALUES ($1,$2,'x')";
    await pool.query(sight, [s.jobId, src.rows[0].id]);
    await assert.rejects(pool.query(sight, [s.jobId, src.rows[0].id]), /duplicate key/i);
    await assert.rejects(
      pool.query("INSERT INTO js_jobs (title, dedupe_key) VALUES ('t2','dk1')"),
      /duplicate key/i
    );
    // queue: nullable unique idempotency key
    const q = "INSERT INTO js_queue (kind, payload, idempotency_key) VALUES ('k','{}',$1)";
    await pool.query(q, [null]);
    await pool.query(q, [null]);
    await pool.query(q, ["i1"]);
    await assert.rejects(pool.query(q, ["i1"]), /duplicate key/i);
    const ev = await pool.query("INSERT INTO js_events (candidate_id, kind) VALUES ($1,'e') RETURNING id", [s.candidateId]);
    assert.ok(ev.rows[0].id);
    for (const t of [
      "js_profiles", "js_cv_files", "js_preferences", "js_consents", "js_runs", "js_employers",
      "js_application_documents", "js_sharing_authorizations", "js_messages", "js_tasks",
      "js_employer_confirmations", "js_automation_rules", "js_sandbox_mail",
    ]) {
      await pool.query(`SELECT * FROM ${t} LIMIT 1`);
    }
  }));

test("message review_state and migration idempotency", () =>
  withDb(async (pool) => {
    await assert.rejects(
      pool.query("INSERT INTO js_messages (direction, review_state) VALUES ('in','bogus')"),
      /check constraint/i
    );
    await pool.query("INSERT INTO js_messages (direction, review_state) VALUES ('in','needs_review')");
    const { runMigrations } = require("../scripts/migrate");
    assert.deepEqual(await runMigrations(pool), []);
  }));
