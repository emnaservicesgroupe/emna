const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const db = require("../db");
const candidateModel = require("../models/candidateModel");

let ctx;
let previousPool;

test.before(async () => {
  ctx = await createTestDb();
  previousPool = db.setPool(ctx.pool);
});

test.after(async () => {
  db.setPool(previousPool);
  await ctx.cleanup();
});

const q = (sql, params) => ctx.pool.query(sql, params);

async function mkUser(role) {
  const email = `cm-${role.toLowerCase()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  return (await q("INSERT INTO users (full_name, email, password, role) VALUES ($1,$2,'x',$3) RETURNING id", [role, email, role])).rows[0].id;
}

async function mkCandidate(assignedTo, extra = {}) {
  const c = await candidateModel.createCandidate({
    full_name: "Old Name",
    nationality: "TN",
    passport_number: `P-${Math.random().toString(36).slice(2)}`,
    work_company: "Old Co",
    partner_company: "Partner",
    assigned_to: assignedTo,
    ...extra,
  });
  return c.id;
}

test("updateCandidate merges missing fields with the current row", async () => {
  const agent = await mkUser("Agent");
  const id = await mkCandidate(agent);
  const out = await candidateModel.updateCandidate(id, { full_name: "New Name" });
  assert.equal(out.full_name, "New Name");
  assert.equal(out.work_company, "Old Co");
  assert.equal(out.nationality, "TN");
  assert.equal(out.assigned_to, agent);
  assert.equal(await candidateModel.updateCandidate(999999, { full_name: "x" }), null);
});

test("updateCandidate: opts.canAssign=false refuses a CHANGE of assigned_to inside the row lock (403), keeps the same value", async () => {
  const a = await mkUser("Agent");
  const b = await mkUser("Agent");
  const id = await mkCandidate(a);
  await assert.rejects(candidateModel.updateCandidate(id, { assigned_to: b, work_company: "X" }, { canAssign: false }), (e) => e.status === 403 && e.code === "ASSIGN_DENIED");
  const row = (await q("SELECT assigned_to, work_company FROM candidates WHERE id=$1", [id])).rows[0];
  assert.deepEqual([row.assigned_to, row.work_company], [a, "Old Co"], "nothing written");
  const same = await candidateModel.updateCandidate(id, { assigned_to: String(a), work_company: "Y" }, { canAssign: false });
  assert.equal(same.work_company, "Y");
  assert.equal(same.assigned_to, a);
});

/**
 * Wraps a pool so that the UPDATE carrying `marker` in its values waits until `release()` is called or
 * `maxWaitMs` passed (an operation blocked on a row lock never resolves, so the barrier also times out).
 */
function barrierPool(pool, marker, maxWaitMs) {
  let releaseFn;
  const released = new Promise((r) => (releaseFn = r));
  let reached;
  const reachedP = new Promise((r) => (reached = r));
  const hold = async (sql, values) => {
    if (/^\s*UPDATE candidates/i.test(String(sql)) && Array.isArray(values) && values.includes(marker)) {
      reached();
      await Promise.race([released, new Promise((r) => setTimeout(r, maxWaitMs))]);
    }
  };
  return {
    reachedUpdate: reachedP,
    release: () => releaseFn(),
    query: async (sql, values) => {
      await hold(sql, values);
      return pool.query(sql, values);
    },
    connect: async () => {
      const c = await pool.connect();
      return {
        query: async (sql, values) => {
          await hold(sql, values);
          return c.query(sql, values);
        },
        release: (...a) => c.release(...a),
      };
    },
    end: () => pool.end(),
  };
}

test("Task 20 race: an admin reassignment survives a concurrent staff edit of other fields (no stale assigned_to written back)", async () => {
  const staffA = await mkUser("Agent");
  const staffB = await mkUser("Agent");
  const id = await mkCandidate(staffA);
  const wrapped = barrierPool(ctx.pool, "Staff Edit Co", 400);
  db.setPool(wrapped);
  try {
    // 1. staff edits work_company: reads the row (assigned_to = A) and pauses right before its UPDATE
    const staffOp = candidateModel.updateCandidate(id, { work_company: "Staff Edit Co" }, { canAssign: false });
    await wrapped.reachedUpdate;
    // 2. meanwhile an admin reassigns the candidate to B (blocks on the row lock if the model takes one)
    const adminOp = candidateModel.updateCandidate(id, { assigned_to: staffB }, { canAssign: true });
    const adminDone = adminOp.then(() => wrapped.release(), () => wrapped.release());
    // 3. the staff UPDATE proceeds once the admin finished (old code) or after the barrier timeout (locked)
    await Promise.all([staffOp, adminOp, adminDone]);
  } finally {
    db.setPool(ctx.pool);
  }
  const row = (await q("SELECT assigned_to, work_company FROM candidates WHERE id=$1", [id])).rows[0];
  assert.equal(row.assigned_to, staffB, "the admin's reassignment must not be overwritten by the staff edit");
  assert.equal(row.work_company, "Staff Edit Co", "the staff edit itself is kept");
});

test("Task 20 race: a staff edit re-sending the STALE assignee after an admin reassignment is refused under the lock", async () => {
  const staffA = await mkUser("Agent");
  const staffB = await mkUser("Agent");
  const id = await mkCandidate(staffA);
  // staff saw assigned_to = A (a route check against that snapshot would pass), the admin reassigns first
  await candidateModel.updateCandidate(id, { assigned_to: staffB }, { canAssign: true });
  await assert.rejects(candidateModel.updateCandidate(id, { assigned_to: staffA, work_company: "Z" }, { canAssign: false }), (e) => e.status === 403);
  assert.equal((await q("SELECT assigned_to FROM candidates WHERE id=$1", [id])).rows[0].assigned_to, staffB);
});
