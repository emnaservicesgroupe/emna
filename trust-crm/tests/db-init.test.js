// Task 20: scripts/db-init.js (run by the container entrypoint before server.js): applies sql/schema.sql on an
// EMPTY database, then every pending migration; a second run changes nothing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { initDatabase } = require("../scripts/db-init");

const URL_ = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/trustcrm_test";

test("db-init: empty database -> original schema + all migrations; second run is a no-op; existing data kept", async () => {
  const schema = `t_${process.pid}_init_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new Pool({ connectionString: URL_, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: URL_, options: `-c search_path=${schema}` });
  const quiet = { log: () => {}, error: () => {} };
  try {
    const first = await initDatabase(pool, { log: quiet });
    assert.equal(first.schemaApplied, true);
    const files = fs.readdirSync(path.join(__dirname, "..", "sql", "migrations")).filter((f) => f.endsWith(".sql")).sort();
    assert.deepEqual(first.applied, files);
    for (const t of ["users", "candidates", "js_applications", "js_queue", "schema_migrations"]) {
      assert.ok((await pool.query("SELECT to_regclass($1) AS t", [t])).rows[0].t, t);
    }
    await pool.query("INSERT INTO users (full_name, email, password, role) VALUES ('Kept','kept@test.invalid','x','Admin')");
    const lines = [];
    const second = await initDatabase(pool, { log: { log: (m) => lines.push(m), error: (m) => lines.push(m) } });
    assert.equal(second.privileged, true, "the test database connects as the postgres superuser");
    assert.ok(lines.some((l) => /WARNING the app connects with a privileged Postgres role/.test(l)));
    assert.equal(second.schemaApplied, false);
    assert.deepEqual(second.applied, []);
    assert.equal((await pool.query("SELECT count(*)::int n FROM users")).rows[0].n, 1);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});

test("db-init: retries while the database is not reachable yet, then gives up with a clear error (no password printed)", async () => {
  const dead = new Pool({ host: "127.0.0.1", port: 1, user: "u", password: "pw-never-printed", database: "d", connectionTimeoutMillis: 200 });
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  try {
    await assert.rejects(initDatabase(dead, { log, retries: 3, delayMs: 10 }), /database not reachable after 3 attempts/);
    assert.equal(lines.filter((l) => /waiting for the database/.test(l)).length, 2);
    assert.ok(!lines.join("\n").includes("pw-never-printed"));
  } finally {
    await dead.end().catch(() => {});
  }
});
