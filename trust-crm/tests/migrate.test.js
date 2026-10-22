const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb } = require("./helpers/db");
const { runMigrations } = require("../scripts/migrate");

test("applies migrations once and is idempotent", async () => {
  const { pool, cleanup } = await createTestDb();
  try {
    const rows = await pool.query("SELECT name FROM schema_migrations ORDER BY name");
    assert.ok(rows.rows.some((r) => r.name === "001_migrations_and_roles.sql"));
    assert.deepEqual(await runMigrations(pool), []);
  } finally {
    await cleanup();
  }
});

test("Candidate role is accepted by users.role", async () => {
  const { pool, cleanup } = await createTestDb();
  try {
    await pool.query(
      "INSERT INTO users (full_name,email,password,role) VALUES ('C','c@x.io','h','Candidate')"
    );
    await assert.rejects(
      pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('B','b@x.io','h','Bogus')")
    );
  } finally {
    await cleanup();
  }
});

test("users.token_version defaults to 0", async () => {
  const { pool, cleanup } = await createTestDb();
  try {
    const r = await pool.query(
      "INSERT INTO users (full_name,email,password,role) VALUES ('A','a@x.io','h','Agent') RETURNING token_version"
    );
    assert.equal(r.rows[0].token_version, 0);
    await pool.query("SELECT email, phone FROM candidates");
  } finally {
    await cleanup();
  }
});

test("cleanup drops the isolated schema", async () => {
  const { pool, schema, cleanup } = await createTestDb();
  await cleanup();
  const { Pool } = require("pg");
  const admin = new Pool({
    connectionString: process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/trustcrm_test",
  });
  try {
    const r = await admin.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
    assert.equal(r.rowCount, 0);
  } finally {
    await admin.end();
  }
});
