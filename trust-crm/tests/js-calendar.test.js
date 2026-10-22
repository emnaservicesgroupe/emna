const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb } = require("./helpers/db");

async function withDb(fn) {
  const { pool, cleanup } = await createTestDb();
  require("../db").setPool(pool);
  try {
    const u1 = await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('S1','s1@x.io','h','Agent') RETURNING id");
    const u2 = await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('S2','s2@x.io','h','Agent') RETURNING id");
    const c = await pool.query("INSERT INTO candidates (full_name, passport_number) VALUES ('C','P1') RETURNING id");
    await fn(pool, { staff1: u1.rows[0].id, staff2: u2.rows[0].id, candidateId: c.rows[0].id });
  } finally {
    await cleanup();
  }
}

const calendar = () => require("../modules/jobsearch/calendar");
const slot = (s, h0, h1, extra = {}) => ({
  candidateId: s.candidateId,
  staffUserId: s.staff1,
  startsAt: `2026-11-02T${h0}:00:00Z`,
  endsAt: `2026-11-02T${h1}:00:00Z`,
  tz: "Africa/Tunis",
  title: "Interview prep",
  ...extra,
});

test("createTentative returns the stored tz and tentative status", () =>
  withDb(async (pool, s) => {
    const a = await calendar().createTentative(slot(s, "09", "10"));
    assert.equal(a.status, "tentative");
    assert.equal(a.tz, "Africa/Tunis");
    assert.equal(a.title, "Interview prep");
    assert.equal(new Date(a.startsAt).toISOString(), "2026-11-02T09:00:00.000Z");
    assert.equal(a.staffUserId, s.staff1);
  }));

test("invalid timezone and inverted range are rejected", () =>
  withDb(async (pool, s) => {
    await assert.rejects(calendar().createTentative(slot(s, "09", "10", { tz: "Mars/Base" })), /timezone/i);
    await assert.rejects(calendar().createTentative(slot(s, "10", "09")), /end/i);
  }));

test("overlapping appointment for the same staff is rejected with a clear error", () =>
  withDb(async (pool, s) => {
    await calendar().createTentative(slot(s, "09", "10"));
    await assert.rejects(calendar().createTentative(slot(s, "09", "11")), (e) => {
      assert.equal(e.code, "APPOINTMENT_OVERLAP");
      assert.match(e.message, /overlap/i);
      return true;
    });
    // adjacent and other staff are fine
    await calendar().createTentative(slot(s, "10", "11"));
    await calendar().createTentative(slot(s, "09", "10", { staffUserId: s.staff2 }));
  }));

test("cancelled appointment frees the slot", () =>
  withDb(async (pool, s) => {
    const a = await calendar().createTentative(slot(s, "09", "10"));
    const c = await calendar().cancel(a.id);
    assert.equal(c.status, "cancelled");
    await calendar().createTentative(slot(s, "09", "10"));
  }));

test("confirm throws unless availabilityConfirmedByCandidate is exactly true", () =>
  withDb(async (pool, s) => {
    const a = await calendar().createTentative(slot(s, "09", "10"));
    for (const arg of [undefined, {}, { availabilityConfirmedByCandidate: false }, { availabilityConfirmedByCandidate: "true" }, { availabilityConfirmedByCandidate: 1 }]) {
      await assert.rejects(calendar().confirm(a.id, arg), /availability/i);
    }
    assert.equal((await pool.query("SELECT status FROM js_appointments WHERE id=$1", [a.id])).rows[0].status, "tentative");
    const ok = await calendar().confirm(a.id, { availabilityConfirmedByCandidate: true });
    assert.equal(ok.status, "confirmed");
    assert.equal(ok.tz, "Africa/Tunis");
  }));

test("confirm on cancelled or unknown appointment throws", () =>
  withDb(async (pool, s) => {
    const a = await calendar().createTentative(slot(s, "09", "10"));
    await calendar().cancel(a.id);
    await assert.rejects(calendar().confirm(a.id, { availabilityConfirmedByCandidate: true }), /cancelled|not found/i);
    await assert.rejects(calendar().confirm(99999, { availabilityConfirmedByCandidate: true }), /not found/i);
    await assert.rejects(calendar().cancel(99999), /not found/i);
  }));
