const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb } = require("./helpers/db");

const scope = () => require("../modules/jobsearch/scope");
const { HttpError } = require("../modules/jobsearch/httpError");

async function addUser(pool, email, role) {
  const r = await pool.query(
    "INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id, role",
    [email, email, role]
  );
  return r.rows[0];
}

async function withDb(fn) {
  const { pool, cleanup } = await createTestDb();
  require("../db").setPool(pool);
  try {
    const u = {
      agentA: await addUser(pool, "a@x.io", "Agent"),
      agentB: await addUser(pool, "b@x.io", "Agent"),
      manager: await addUser(pool, "m@x.io", "Manager"),
      receptionist: await addUser(pool, "r@x.io", "Receptionist"),
      admin: await addUser(pool, "admin@x.io", "Admin"),
      superAdmin: await addUser(pool, "sa@x.io", "SuperAdmin"),
      accountant: await addUser(pool, "acc@x.io", "Accountant"),
      hr: await addUser(pool, "hr@x.io", "HR"),
      cand1User: await addUser(pool, "c1@test.invalid", "Candidate"),
      unlinkedCand: await addUser(pool, "c9@test.invalid", "Candidate"),
    };
    const cand = async (name, assignedTo, deleted = false) =>
      (
        await pool.query(
          "INSERT INTO candidates (full_name, passport_number, assigned_to, is_deleted) VALUES ($1,$1,$2,$3) RETURNING id",
          [name, assignedTo, deleted]
        )
      ).rows[0].id;
    const c = {
      c1: await cand("P1", u.agentA.id),
      c2: await cand("P2", u.agentB.id),
      c3deleted: await cand("P3", u.agentA.id, true),
      c4manager: await cand("P4", u.manager.id),
    };
    await pool.query("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [u.cand1User.id, c.c1]);
    await fn(pool, u, c);
  } finally {
    await cleanup();
  }
}

async function denied(promise) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${err && err.constructor && err.constructor.name}`);
    assert.equal(err.status, 404);
    return true;
  });
}

async function ids(pool, user) {
  const { clause, params } = scope().candidateScopeSql(user, "c", 1);
  const r = await pool.query(`SELECT c.id FROM candidates c WHERE c.id > $1 AND ${clause} ORDER BY c.id`, [0, ...params]);
  return r.rows.map((row) => row.id);
}

test("HttpError carries status and message", () => {
  const e = new HttpError(404, "Not found");
  assert.ok(e instanceof Error);
  assert.equal(e.status, 404);
  assert.equal(e.message, "Not found");
});

test("staff A cannot access staff B's candidate; gets 404 (never 403)", () =>
  withDb(async (_pool, u, c) => {
    await scope().assertCandidateAccess(u.agentA, c.c1);
    await denied(scope().assertCandidateAccess(u.agentA, c.c2));
    await scope().assertCandidateAccess(u.agentB, c.c2);
    await denied(scope().assertCandidateAccess(u.agentB, c.c1));
    await scope().assertCandidateAccess(u.manager, c.c4manager);
    await denied(scope().assertCandidateAccess(u.manager, c.c1));
    await denied(scope().assertCandidateAccess(u.receptionist, c.c1));
  }));

test("Admin and SuperAdmin can access every non-deleted candidate", () =>
  withDb(async (_pool, u, c) => {
    for (const user of [u.admin, u.superAdmin]) {
      await scope().assertCandidateAccess(user, c.c1);
      await scope().assertCandidateAccess(user, c.c2);
      await scope().assertCandidateAccess(user, c.c4manager);
    }
  }));

test("Candidate can access only their own linked candidate", () =>
  withDb(async (_pool, u, c) => {
    await scope().assertCandidateAccess(u.cand1User, c.c1);
    await denied(scope().assertCandidateAccess(u.cand1User, c.c2));
    await denied(scope().assertCandidateAccess(u.unlinkedCand, c.c1));
  }));

test("other roles, unknown roles and missing users are denied by default", () =>
  withDb(async (_pool, u, c) => {
    for (const user of [u.accountant, u.hr, { id: u.admin.id, role: "Wizard" }, { id: u.admin.id }, null, undefined, {}]) {
      await denied(scope().assertCandidateAccess(user, c.c1));
    }
    // a staff role with no usable id is denied too
    await denied(scope().assertCandidateAccess({ role: "Agent" }, c.c1));
    await denied(scope().assertCandidateAccess({ role: "Candidate", id: "1 OR 1=1" }, c.c1));
  }));

test("soft-deleted, nonexistent and malformed candidate ids give 404 for everyone", () =>
  withDb(async (_pool, u, c) => {
    await denied(scope().assertCandidateAccess(u.agentA, c.c3deleted));
    await denied(scope().assertCandidateAccess(u.admin, c.c3deleted));
    await denied(scope().assertCandidateAccess(u.superAdmin, 999999));
    for (const bad of ["abc", "1; DROP TABLE users", -1, 0, 1.5, null, undefined, {}]) {
      await denied(scope().assertCandidateAccess(u.admin, bad));
    }
  }));

test("candidateScopeSql clause excludes rows outside scope", () =>
  withDb(async (pool, u, c) => {
    assert.deepEqual(await ids(pool, u.agentA), [c.c1, c.c3deleted]);
    assert.deepEqual(await ids(pool, u.agentB), [c.c2]);
    assert.deepEqual(await ids(pool, u.manager), [c.c4manager]);
    assert.deepEqual(await ids(pool, u.receptionist), []);
    assert.deepEqual(await ids(pool, u.cand1User), [c.c1]);
    assert.deepEqual(await ids(pool, u.unlinkedCand), []);
    assert.deepEqual(await ids(pool, u.admin), [c.c1, c.c2, c.c3deleted, c.c4manager]);
    assert.deepEqual(await ids(pool, u.superAdmin), [c.c1, c.c2, c.c3deleted, c.c4manager]);
    assert.deepEqual(await ids(pool, u.accountant), []);
    assert.deepEqual(await ids(pool, u.hr), []);
    assert.deepEqual(await ids(pool, null), []);
    assert.deepEqual(await ids(pool, { id: u.admin.id, role: "Unknown" }), []);
  }));

test("candidateScopeSql is parameterized, honours alias and placeholder offset", () => {
  const s = scope();
  const staff = s.candidateScopeSql({ id: 7, role: "Agent" }, "cand");
  assert.equal(staff.clause, "cand.assigned_to = $1");
  assert.deepEqual(staff.params, [7]);
  const shifted = s.candidateScopeSql({ id: 7, role: "Agent" }, "c", 3);
  assert.equal(shifted.clause, "c.assigned_to = $4");
  const cand = s.candidateScopeSql({ id: 9, role: "Candidate" });
  assert.match(cand.clause, /^c\.id = \(SELECT .*js_candidate_accounts.*\$1.*\)$/);
  assert.deepEqual(cand.params, [9]);
  assert.deepEqual(s.candidateScopeSql({ id: 1, role: "Admin" }), { clause: "TRUE", params: [] });
  assert.deepEqual(s.candidateScopeSql({ id: 1, role: "HR" }), { clause: "FALSE", params: [] });
  assert.deepEqual(s.candidateScopeSql({ id: "7 OR 1=1", role: "Agent" }), { clause: "FALSE", params: [] });
  assert.throws(() => s.candidateScopeSql({ id: 1, role: "Admin" }, "c; DROP TABLE x"), /alias/i);
});

test("isStaff / isAdmin", () => {
  const s = scope();
  for (const role of ["Agent", "Manager", "Receptionist"]) assert.equal(s.isStaff({ role }), true);
  for (const role of ["Admin", "SuperAdmin", "Candidate", "Accountant", "HR", undefined]) assert.equal(s.isStaff({ role }), false);
  for (const role of ["Admin", "SuperAdmin"]) assert.equal(s.isAdmin({ role }), true);
  for (const role of ["Manager", "Agent", "Candidate", "HR"]) assert.equal(s.isAdmin({ role }), false);
  assert.equal(s.isStaff(null), false);
  assert.equal(s.isAdmin(undefined), false);
});

test("role permissions: Candidate has none; jobsearch permissions per role", () => {
  const { PERMISSIONS } = require("../middleware/role");
  assert.deepEqual(PERMISSIONS.Candidate, []);
  const all = ["jobsearch:read", "jobsearch:write", "jobsearch:approve", "jobsearch:admin"];
  for (const p of all) assert.ok(PERMISSIONS.Admin.includes(p), `Admin ${p}`);
  assert.ok(PERMISSIONS.SuperAdmin.includes("*"));
  assert.deepEqual(PERMISSIONS.Manager.filter((p) => p.startsWith("jobsearch:")).sort(), ["jobsearch:approve", "jobsearch:read", "jobsearch:write"]);
  for (const role of ["Agent", "Receptionist"]) {
    assert.deepEqual(PERMISSIONS[role].filter((p) => p.startsWith("jobsearch:")).sort(), ["jobsearch:read", "jobsearch:write"]);
  }
  for (const role of ["Accountant", "HR"]) {
    assert.deepEqual(PERMISSIONS[role].filter((p) => p.startsWith("jobsearch:")), []);
  }
});

test("checkPermission denies Candidate any jobsearch permission", () => {
  const { checkPermission } = require("../middleware/role");
  let status = null;
  const res = { status(s) { status = s; return { json() {} }; } };
  checkPermission("jobsearch:read")({ user: { id: 1, role: "Candidate" } }, res, () => assert.fail("must not pass"));
  assert.equal(status, 403);
});
