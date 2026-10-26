// Task 18: scripts/cleanup-test-schemas.js drops stale t_* schemas in the TEST database only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { cleanupTestSchemas, assertTestDatabase, RefusedError, LOCK_KEY } = require("../scripts/cleanup-test-schemas");

const URL = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/trustcrm_test";

test("refuses any database whose name does not contain 'test' (checked on the live connection)", async () => {
  for (const name of ["trustcrm", "postgres", "production", "", undefined]) assert.throws(() => assertTestDatabase(name), RefusedError, String(name));
  assert.doesNotThrow(() => assertTestDatabase("trustcrm_test"));
  const other = URL.replace(/\/[^/?]+(\?|$)/, "/postgres$1");
  await assert.rejects(cleanupTestSchemas({ connectionString: other }), (e) => e instanceof RefusedError && /not a test database/.test(e.message));
});

test("drops t_* schemas older than 1 h (by schema_migrations.applied_at) and half-created ones of dead processes; keeps fresh, live and foreign schemas", async () => {
  const admin = new Pool({ connectionString: URL, max: 2 });
  const tag = Math.random().toString(36).slice(2, 8);
  const old = `t_999999_old${tag}`;
  const fresh = `t_${process.pid}_fresh${tag}`;
  const deadHalf = `t_999998_half${tag}`;
  const liveHalf = `t_${process.pid}_half${tag}`;
  const foreign = `tx_keep_${tag}`;
  const odd = `t_keep_${tag}`;
  // Race fixed: schemas with a dead pid in their name are fair game for the start-up cleanup that every other
  // test process runs in parallel, so building them without the cleanup lock let that run drop them half-built
  // (CREATE TABLE then failed) or before our own call. Take the same advisory lock for the whole
  // setup + run + check; the cleanup under test is told the caller holds it.
  const locker = await admin.connect();
  try {
    await locker.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    for (const s of [old, fresh, deadHalf, liveHalf, foreign, odd]) await locker.query(`CREATE SCHEMA "${s}"`);
    for (const [s, age] of [[old, "2 hours"], [fresh, "1 minute"]]) {
      await locker.query(`CREATE TABLE "${s}".schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      await locker.query(`INSERT INTO "${s}".schema_migrations (name, applied_at) VALUES ('001.sql', now() - $1::interval)`, [age]);
    }
    const r = await cleanupTestSchemas({ connectionString: URL, callerHoldsLock: true });
    assert.match(r.database, /test/);
    assert.equal(r.skipped, undefined);
    assert.ok(r.dropped.includes(old) && r.dropped.includes(deadHalf), "this run dropped them (not a parallel process)");
    const left = new Set((await locker.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)", [[old, fresh, deadHalf, liveHalf, foreign, odd]])).rows.map((x) => x.nspname));
    assert.ok(!left.has(old), "old schema dropped");
    assert.ok(!left.has(deadHalf), "half-created schema of a dead pid dropped");
    for (const s of [fresh, liveHalf, foreign, odd]) assert.ok(left.has(s), `${s} kept`);
  } finally {
    for (const s of [old, fresh, deadHalf, liveHalf, foreign, odd]) await locker.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {});
    await locker.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]).catch(() => {});
    locker.release();
    await admin.end();
  }
});
