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

// ---------- migration 015 (review round 1) ----------

const MIG15 = () => fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "015_orgs_review_fixes.sql"), "utf8");

test("migration 015 is idempotent and adds employer_presentations.consent_id as a nullable FK to candidate_share_consents", () =>
  withDb(async (pool) => {
    const { runMigrations } = require("../scripts/migrate");
    assert.deepEqual(await runMigrations(pool), []);
    await pool.query(MIG15());
    await pool.query(MIG15());
    const col = await pool.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name='employer_presentations' AND column_name='consent_id'"
    );
    assert.equal(col.rows[0] && col.rows[0].is_nullable, "YES");
    const e = await employer(pool);
    const rid = (await request(pool, e)).rows[0].id;
    const c = await candidate(pool);
    await assert.rejects(pool.query("INSERT INTO employer_presentations (request_id, candidate_id, consent_id) VALUES ($1,$2,999999)", [rid, c]), /foreign key/i);
  }));

test("migration 015 backfills consent_id with the latest consent at or before the presentation", () =>
  withDb(async (pool) => {
    const e = await employer(pool);
    const other = await employer(pool, "Other");
    const rid = (await request(pool, e)).rows[0].id;
    const c = await candidate(pool);
    const cons = async (emp, rec, wd) =>
      (await pool.query("INSERT INTO candidate_share_consents (candidate_id, employer_id, basis, recorded_at, withdrawn_at) VALUES ($1,$2,'b',$3,$4) RETURNING id", [c, emp, rec, wd])).rows[0].id;
    const old = await cons(e, "2026-01-01T00:00:00Z", "2026-01-05T00:00:00Z");
    const cur = await cons(e, "2026-02-01T00:00:00Z", null);
    await cons(other, "2026-01-20T00:00:00Z", null); // other employer: ignored
    const later = await cons(e, "2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z"); // after the presentation: ignored
    const p = (await pool.query("INSERT INTO employer_presentations (request_id, candidate_id, created_at) VALUES ($1,$2,'2026-02-10T00:00:00Z') RETURNING id", [rid, c])).rows[0].id;
    await pool.query("UPDATE employer_presentations SET consent_id = NULL");
    await pool.query(MIG15());
    const got = (await pool.query("SELECT consent_id FROM employer_presentations WHERE id=$1", [p])).rows[0].consent_id;
    assert.equal(String(got), String(cur));
    assert.notEqual(String(got), String(old));
    assert.notEqual(String(got), String(later));
  }));

test("migration 015 normalises junk crm_employers.status to 'new' and validates the 013 constraint", () =>
  withDb(async (pool) => {
    await pool.query("ALTER TABLE crm_employers DROP CONSTRAINT crm_employers_status_check");
    await pool.query("INSERT INTO crm_employers (name, status) VALUES ('J1','weird'), ('J2','active'), ('J3','suspended')");
    await pool.query("ALTER TABLE crm_employers ADD CONSTRAINT crm_employers_status_check CHECK (status IN ('new','active','suspended','inactive')) NOT VALID");
    const before = await pool.query("SELECT convalidated FROM pg_constraint WHERE conname='crm_employers_status_check' AND conrelid='crm_employers'::regclass");
    assert.equal(before.rows[0].convalidated, false);
    await pool.query(MIG15());
    const after = await pool.query("SELECT convalidated FROM pg_constraint WHERE conname='crm_employers_status_check' AND conrelid='crm_employers'::regclass");
    assert.equal(after.rows[0].convalidated, true);
    const st = (await pool.query("SELECT name, status FROM crm_employers ORDER BY name")).rows;
    assert.deepEqual(st.map((r) => r.status), ["new", "active", "suspended"]);
    await assert.rejects(pool.query("INSERT INTO crm_employers (name, status) VALUES ('J4','bogus')"), /check constraint/i);
  }));

test("users constraints after all migrations: the only CHECK mentioning role is the role-in-list one; the others keep their schema.sql names", () =>
  withDb(async (pool) => {
    const list = async () =>
      (await pool.query("SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = to_regclass('users') AND contype IN ('c','p','u','f') ORDER BY conname")).rows;
    const rows = await list();
    const checks = rows.filter((r) => r.contype === "c");
    assert.deepEqual(checks.map((r) => r.conname), ["users_role_check"]);
    for (const role of ["SuperAdmin", "Admin", "Manager", "Receptionist", "Accountant", "HR", "Agent", "Candidate", "Employer", "Agency"]) assert.match(checks[0].def, new RegExp(`'${role}'`));
    assert.deepEqual(rows.filter((r) => r.contype !== "c").map((r) => r.conname), ["users_email_key", "users_pkey"]);
    // an unrelated CHECK on users survives a re-run of 015, and a dropped role check is restored
    await pool.query("ALTER TABLE users ADD CONSTRAINT users_name_len_check CHECK (length(full_name) > 0)");
    await pool.query("ALTER TABLE users DROP CONSTRAINT users_role_check");
    await pool.query(MIG15());
    assert.deepEqual((await list()).filter((r) => r.contype === "c").map((r) => r.conname), ["users_name_len_check", "users_role_check"]);
    assert.ok(await user(pool, "Employer", "e15@x.invalid"));
    await assert.rejects(user(pool, "Nope", "n15@x.invalid"), /check constraint/i);
  }));
