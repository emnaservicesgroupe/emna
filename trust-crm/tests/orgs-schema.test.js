const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
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

const user = async (pool, role, email) =>
  (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('U',$1,'h',$2) RETURNING id", [email, role])).rows[0].id;
const employer = async (pool, name = "Acme") => (await pool.query("INSERT INTO crm_employers (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
const agency = async (pool, name = "Ag") => (await pool.query("INSERT INTO crm_agencies (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
const candidate = async (pool, n = 1) =>
  (await pool.query("INSERT INTO candidates (full_name, passport_number) VALUES ($1,$2) RETURNING id", [`C${n}`, `PP${n}`])).rows[0].id;
const request = (pool, employerId, extra = {}) => {
  const r = { title: "Welder", positions: 2, status: "submitted", ...extra };
  return pool.query("INSERT INTO employer_requests (employer_id, title, positions, status) VALUES ($1,$2,$3,$4) RETURNING id", [
    employerId,
    r.title,
    r.positions,
    r.status,
  ]);
};

test("migration 013 is idempotent (re-run applies nothing, re-executing the SQL is safe)", () =>
  withDb(async (pool) => {
    const { runMigrations } = require("../scripts/migrate");
    assert.deepEqual(await runMigrations(pool), []);
    const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "013_orgs_portals.sql"), "utf8");
    await pool.query(sql);
    await pool.query(sql);
  }));

test("all stage-3 tables and the new agency_id columns exist", () =>
  withDb(async (pool) => {
    for (const t of ["crm_agencies", "crm_org_accounts", "employer_requests", "employer_presentations", "candidate_share_consents"]) {
      const r = await pool.query("SELECT to_regclass($1) AS t", [t]);
      assert.ok(r.rows[0].t, `${t} exists`);
    }
    for (const t of ["candidates", "crm_leads"]) {
      const r = await pool.query(
        "SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name=$1 AND column_name='agency_id'",
        [t]
      );
      assert.equal(r.rows[0] && r.rows[0].is_nullable, "YES", `${t}.agency_id nullable`);
      const idx = await pool.query("SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND tablename=$1 AND indexdef ILIKE '%agency_id%'", [t]);
      assert.ok(idx.rowCount > 0, `${t}.agency_id indexed`);
    }
  }));

test("users.role accepts Employer and Agency, still rejects unknown roles, existing roles intact", () =>
  withDb(async (pool) => {
    let i = 0;
    for (const role of ["SuperAdmin", "Admin", "Manager", "Receptionist", "Accountant", "HR", "Agent", "Candidate", "Employer", "Agency"]) {
      await user(pool, role, `r${i++}@x.io`);
    }
    await assert.rejects(user(pool, "Hacker", "h@x.io"), /check constraint/i);
  }));

test("agency_id on candidates and crm_leads is an FK (SET NULL on agency delete)", () =>
  withDb(async (pool) => {
    const a = await agency(pool);
    const c = await candidate(pool);
    await pool.query("UPDATE candidates SET agency_id=$1 WHERE id=$2", [a, c]);
    const l = (await pool.query("INSERT INTO crm_leads (kind,name,agency_id) VALUES ('candidate','N',$1) RETURNING id", [a])).rows[0].id;
    await assert.rejects(pool.query("UPDATE candidates SET agency_id=999999 WHERE id=$1", [c]), /foreign key/i);
    await pool.query("DELETE FROM crm_agencies WHERE id=$1", [a]);
    assert.equal((await pool.query("SELECT agency_id FROM candidates WHERE id=$1", [c])).rows[0].agency_id, null);
    assert.equal((await pool.query("SELECT agency_id FROM crm_leads WHERE id=$1", [l])).rows[0].agency_id, null);
  }));

test("crm_agencies: status check and defaults", () =>
  withDb(async (pool) => {
    const a = await agency(pool);
    const row = (await pool.query("SELECT status, created_at FROM crm_agencies WHERE id=$1", [a])).rows[0];
    assert.equal(row.status, "active");
    assert.ok(row.created_at);
    await pool.query("UPDATE crm_agencies SET status='suspended' WHERE id=$1", [a]);
    await assert.rejects(pool.query("UPDATE crm_agencies SET status='gone' WHERE id=$1", [a]), /check constraint/i);
    await assert.rejects(pool.query("INSERT INTO crm_agencies (name) VALUES ('')"), /check constraint/i);
  }));

test("crm_employers.status accepts suspended and rejects junk for new values", () =>
  withDb(async (pool) => {
    const e = await employer(pool);
    for (const s of ["new", "active", "suspended"]) await pool.query("UPDATE crm_employers SET status=$1 WHERE id=$2", [s, e]);
    await assert.rejects(pool.query("UPDATE crm_employers SET status='bogus' WHERE id=$1", [e]), /check constraint/i);
  }));

test("crm_org_accounts: one org per user, org_type checked, cascades with the user", () =>
  withDb(async (pool) => {
    const u = await user(pool, "Employer", "e@x.io");
    const e = await employer(pool);
    await pool.query("INSERT INTO crm_org_accounts (user_id, org_type, org_id) VALUES ($1,'employer',$2)", [u, e]);
    await assert.rejects(pool.query("INSERT INTO crm_org_accounts (user_id, org_type, org_id) VALUES ($1,'employer',$2)", [u, e]), /duplicate key|unique/i);
    const u2 = await user(pool, "Agency", "a@x.io");
    await assert.rejects(pool.query("INSERT INTO crm_org_accounts (user_id, org_type, org_id) VALUES ($1,'bogus',1)", [u2]), /check constraint/i);
    await assert.rejects(pool.query("INSERT INTO crm_org_accounts (user_id, org_type, org_id) VALUES (999999,'agency',1)"), /foreign key/i);
    await pool.query("DELETE FROM users WHERE id=$1", [u]);
    assert.equal((await pool.query("SELECT count(*)::int n FROM crm_org_accounts")).rows[0].n, 0);
  }));

test("employer_requests: status and positions/length constraints, defaults", () =>
  withDb(async (pool) => {
    const e = await employer(pool);
    for (const s of ["submitted", "in_review", "accepted", "declined", "filled", "cancelled"]) await request(pool, e, { status: s });
    await assert.rejects(request(pool, e, { status: "bogus" }), /check constraint/i);
    await assert.rejects(request(pool, e, { positions: 0 }), /check constraint/i);
    await assert.rejects(request(pool, e, { positions: 1001 }), /check constraint/i);
    await request(pool, e, { positions: 1000 });
    await assert.rejects(request(pool, e, { title: "x".repeat(161) }), /check constraint/i);
    await assert.rejects(request(pool, e, { title: "" }), /check constraint/i);
    await assert.rejects(request(pool, 999999), /foreign key/i);
    await assert.rejects(
      pool.query("INSERT INTO employer_requests (employer_id,title,description) VALUES ($1,'T',$2)", [e, "d".repeat(8001)]),
      /check constraint/i
    );
    const row = (await pool.query("SELECT staff_note, employer_visible_note, site_job_id, created_at, updated_at FROM employer_requests LIMIT 1")).rows[0];
    assert.equal(row.staff_note, null);
    assert.ok(row.created_at && row.updated_at);
    const def = (await pool.query("INSERT INTO employer_requests (employer_id,title) VALUES ($1,'D') RETURNING status, positions", [e])).rows[0];
    assert.equal(def.status, "submitted");
    assert.equal(def.positions, 1);
  }));

test("employer_presentations: unique per (request, candidate), status check, summary is an object", () =>
  withDb(async (pool) => {
    const e = await employer(pool);
    const rid = (await request(pool, e)).rows[0].id;
    const c = await candidate(pool);
    const ins = (status = "presented", summary = "{}") =>
      pool.query("INSERT INTO employer_presentations (request_id, candidate_id, summary, status) VALUES ($1,$2,$3::jsonb,$4) RETURNING id", [rid, c, summary, status]);
    const p = await ins();
    await assert.rejects(ins(), /duplicate key|unique/i);
    for (const s of ["interested", "interview", "not_suitable", "withdrawn"]) await pool.query("UPDATE employer_presentations SET status=$1 WHERE id=$2", [s, p.rows[0].id]);
    await assert.rejects(pool.query("UPDATE employer_presentations SET status='bogus' WHERE id=$1", [p.rows[0].id]), /check constraint/i);
    const c2 = await candidate(pool, 2);
    await assert.rejects(
      pool.query("INSERT INTO employer_presentations (request_id, candidate_id, summary) VALUES ($1,$2,'[1]'::jsonb)", [rid, c2]),
      /check constraint/i
    );
    await assert.rejects(pool.query("INSERT INTO employer_presentations (request_id, candidate_id) VALUES (999999,$1)", [c2]), /foreign key/i);
  }));

test("candidate_share_consents: one active consent per (candidate, employer); withdrawn ones may repeat; basis required", () =>
  withDb(async (pool) => {
    const e = await employer(pool);
    const c = await candidate(pool);
    const ins = (basis = "signed form 2026-10-01") =>
      pool.query("INSERT INTO candidate_share_consents (candidate_id, employer_id, basis) VALUES ($1,$2,$3) RETURNING id", [c, e, basis]);
    const first = await ins();
    await assert.rejects(ins(), /duplicate key|unique/i);
    await assert.rejects(ins(""), /check constraint|duplicate key/i);
    await pool.query("UPDATE candidate_share_consents SET withdrawn_at = now() WHERE id=$1", [first.rows[0].id]);
    await ins();
    const e2 = await employer(pool, "Other");
    await pool.query("INSERT INTO candidate_share_consents (candidate_id, employer_id, basis) VALUES ($1,$2,'b')", [c, e2]);
    await assert.rejects(
      pool.query("INSERT INTO candidate_share_consents (candidate_id, employer_id, basis, recorded_at, withdrawn_at) VALUES ($1,$2,'b', now(), now() - interval '1 day')", [c, e2]),
      /check constraint/i
    );
  }));

test("crm_timeline accepts the new entities and still rejects unknown ones; stays insert-only", () =>
  withDb(async (pool) => {
    for (const entity of ["lead", "candidate", "employer", "site_job", "employer_request", "agency", "presentation", "share_consent"]) {
      await pool.query("INSERT INTO crm_timeline (entity, entity_id, event) VALUES ($1, 1, 'x')", [entity]);
    }
    await assert.rejects(pool.query("INSERT INTO crm_timeline (entity, entity_id, event) VALUES ('bogus', 1, 'x')"), /check constraint/i);
    await assert.rejects(pool.query("UPDATE crm_timeline SET event='y'"), /insert-only/);
    const ENTITIES = require("../modules/crm/timeline").ENTITIES;
    for (const e of ["employer_request", "agency", "employer", "presentation", "share_consent"]) assert.ok(ENTITIES.includes(e), e);
  }));

test("permissions: orgs:read/orgs:write per role; Employer and Agency hold nothing", () => {
  assert.ok(PERMISSIONS.SuperAdmin.includes("*"));
  for (const role of ["Admin", "Manager"]) {
    assert.ok(PERMISSIONS[role].includes("orgs:read"), `${role} orgs:read`);
    assert.ok(PERMISSIONS[role].includes("orgs:write"), `${role} orgs:write`);
  }
  assert.ok(PERMISSIONS.Receptionist.includes("orgs:read"));
  assert.ok(!PERMISSIONS.Receptionist.includes("orgs:write"));
  for (const role of ["Accountant", "HR", "Agent", "Candidate"]) {
    assert.ok(!PERMISSIONS[role].some((p) => p.startsWith("orgs:")), `${role} has no orgs permission`);
  }
  assert.deepEqual(PERMISSIONS.Employer, []);
  assert.deepEqual(PERMISSIONS.Agency, []);
});

test("/auth/register refuses Employer and Agency roles (portal users are created by invitation only)", async () => {
  const jwt = require("jsonwebtoken");
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "orgs-schema-secret";
  const { pool, cleanup } = await createTestDb();
  const { loadApp } = require("./helpers/db");
  const app = loadApp(pool);
  const server = app.listen(0);
  try {
    const id = await user(pool, "SuperAdmin", "sa@x.io");
    const token = jwt.sign({ id, role: "SuperAdmin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    for (const role of ["Employer", "Agency"]) {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ full_name: "X", email: `${role}@x.io`, password: "Str0ng!Passw0rd#2026", role }),
      });
      assert.equal(r.status, 400, role);
    }
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE role IN ('Employer','Agency')")).rows[0].n, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
  }
});
