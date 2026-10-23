const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb } = require("./helpers/db");
const { PERMISSIONS } = require("../middleware/role");

async function withDb(fn) {
  const { pool, cleanup } = await createTestDb();
  try {
    await fn(pool);
  } finally {
    await cleanup();
  }
}

const lead = (pool, kind = "candidate", status = "new", dedupe = null) =>
  pool.query("INSERT INTO crm_leads (kind, status, name, dedupe_key) VALUES ($1,$2,'N',$3) RETURNING id", [kind, status, dedupe]);

test("migration 011 is idempotent (re-run applies nothing, re-executing the SQL is safe)", () =>
  withDb(async (pool) => {
    const { runMigrations } = require("../scripts/migrate");
    assert.deepEqual(await runMigrations(pool), []);
    const fs = require("fs");
    const path = require("path");
    const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "011_crm_site.sql"), "utf8");
    await pool.query(sql);
    await pool.query(sql);
  }));

test("crm_leads kind/status constraints", () =>
  withDb(async (pool) => {
    for (const k of ["candidate", "employer", "contact"]) await lead(pool, k);
    for (const s of ["new", "contacted", "qualified", "converted", "rejected", "spam"]) await lead(pool, "contact", s);
    await assert.rejects(lead(pool, "bogus"), /check constraint/i);
    await assert.rejects(lead(pool, "candidate", "bogus"), /check constraint/i);
  }));

test("crm_leads dedupe_key is unique except for spam rows", () =>
  withDb(async (pool) => {
    await lead(pool, "candidate", "new", "candidate:a@b.c:2026-10-23");
    await assert.rejects(lead(pool, "candidate", "new", "candidate:a@b.c:2026-10-23"), /duplicate key|unique/i);
    await lead(pool, "candidate", "spam", "candidate:a@b.c:2026-10-23");
    await lead(pool, "candidate", "spam", "candidate:a@b.c:2026-10-23");
    await lead(pool, "candidate", "new", null);
    await lead(pool, "candidate", "new", null);
  }));

test("crm_leads links to candidates and users with SET NULL", () =>
  withDb(async (pool) => {
    const c = await pool.query("INSERT INTO candidates (full_name, passport_number) VALUES ('C','PX1') RETURNING id");
    const u = await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('S','s@x.io','h','Agent') RETURNING id");
    const l = await pool.query(
      "INSERT INTO crm_leads (kind, name, candidate_id, assigned_to) VALUES ('candidate','N',$1,$2) RETURNING id",
      [c.rows[0].id, u.rows[0].id]
    );
    await pool.query("DELETE FROM users WHERE id=$1", [u.rows[0].id]);
    const r = await pool.query("SELECT assigned_to, candidate_id FROM crm_leads WHERE id=$1", [l.rows[0].id]);
    assert.equal(r.rows[0].assigned_to, null);
    assert.equal(r.rows[0].candidate_id, c.rows[0].id);
  }));

test("crm_timeline is insert-only", () =>
  withDb(async (pool) => {
    await pool.query("INSERT INTO crm_timeline (entity, entity_id, event) VALUES ('lead',1,'note')");
    await assert.rejects(pool.query("INSERT INTO crm_timeline (entity, entity_id, event) VALUES ('bogus',1,'x')"), /check constraint/i);
    await assert.rejects(pool.query("UPDATE crm_timeline SET event='x'"), /insert-only/i);
    await assert.rejects(pool.query("DELETE FROM crm_timeline"), /insert-only/i);
  }));

test("crm_employers and site_jobs constraints and defaults", () =>
  withDb(async (pool) => {
    await pool.query("INSERT INTO crm_employers (name) VALUES ('Acme')");
    const j = await pool.query("INSERT INTO site_jobs (title) VALUES ('Nurse') RETURNING status, evidence_note, published_at");
    assert.equal(j.rows[0].status, "draft");
    assert.equal(j.rows[0].evidence_note, null);
    for (const s of ["draft", "published", "closed"]) await pool.query("INSERT INTO site_jobs (title,status) VALUES ('t',$1)", [s]);
    await assert.rejects(pool.query("INSERT INTO site_jobs (title,status) VALUES ('t','bogus')"), /check constraint/i);
    for (const col of ["employer_name", "country", "city", "category", "description", "requirements", "language_requirements",
      "employment_type", "salary_text", "apply_mode", "closes_at", "created_by", "evidence_note"]) {
      await pool.query(`SELECT ${col} FROM site_jobs LIMIT 1`);
    }
  }));

test("public_rate_limit has composite primary key", () =>
  withDb(async (pool) => {
    const q = "INSERT INTO public_rate_limit (key, window_start, count) VALUES ('k', '2026-10-23T10:00Z', 1)";
    await pool.query(q);
    await assert.rejects(pool.query(q), /duplicate key/i);
    await pool.query("INSERT INTO public_rate_limit (key, window_start, count) VALUES ('k', '2026-10-23T11:00Z', 1)");
  }));

test("candidates.crm_stage defaults to lead and is constrained", () =>
  withDb(async (pool) => {
    const c = await pool.query("INSERT INTO candidates (full_name, passport_number) VALUES ('C','PS1') RETURNING id, crm_stage");
    assert.equal(c.rows[0].crm_stage, "lead");
    for (const s of ["lead", "documents", "submitted", "interview", "visa", "travel", "closed"]) {
      await pool.query("UPDATE candidates SET crm_stage=$1 WHERE id=$2", [s, c.rows[0].id]);
    }
    await assert.rejects(pool.query("UPDATE candidates SET crm_stage='bogus' WHERE id=$1", [c.rows[0].id]), /check constraint/i);
    await assert.rejects(pool.query("UPDATE candidates SET crm_stage=NULL WHERE id=$1", [c.rows[0].id]), /not-null/i);
  }));

test("CRM permission matrix", () => {
  const perms = ["leads:read", "leads:write", "sitejobs:write"];
  for (const role of ["Admin", "Manager", "Receptionist"]) for (const p of perms) assert.ok(PERMISSIONS[role].includes(p), `${role} ${p}`);
  assert.ok(PERMISSIONS.Agent.includes("leads:read"));
  assert.ok(!PERMISSIONS.Agent.includes("leads:write"));
  assert.ok(!PERMISSIONS.Agent.includes("sitejobs:write"));
  for (const role of ["Accountant", "HR", "Candidate"]) for (const p of perms) assert.ok(!PERMISSIONS[role].includes(p), `${role} ${p}`);
  assert.ok(PERMISSIONS.SuperAdmin.includes("*"));
});
