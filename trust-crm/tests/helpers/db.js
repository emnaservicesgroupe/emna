const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { runMigrations } = require("../../scripts/migrate");

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_URL = "postgres://postgres:postgres@localhost:5432/trustcrm_test";

function baseUrl() {
  return process.env.TEST_DATABASE_URL || DEFAULT_URL;
}

// Best effort, once per test process: drop stale t_* schemas left by interrupted runs (older than 1 h, in the
// TEST database only - the script refuses any other database). Never fails a test.
let cleanupOnce = null;
function cleanupStaleSchemas() {
  if (!cleanupOnce) {
    cleanupOnce = require("../../scripts/cleanup-test-schemas")
      .cleanupTestSchemas({ connectionString: baseUrl() })
      .catch(() => null);
  }
  return cleanupOnce;
}

/**
 * Creates a uniquely named schema, applies sql/schema.sql and all migrations
 * inside it, and returns a pool whose search_path is pinned to that schema.
 */
async function createTestDb() {
  await cleanupStaleSchemas();
  const schema = `t_${process.pid}_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: baseUrl(), max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);

  const pool = new Pool({
    connectionString: baseUrl(),
    options: `-c search_path=${schema},public`,
  });

  try {
    await pool.query(fs.readFileSync(path.join(ROOT, "sql", "schema.sql"), "utf8"));
    await runMigrations(pool);
  } catch (err) {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await admin.end();
    throw err;
  }

  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    await pool.end();
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  }

  return { pool, schema, cleanup };
}

/** Points the shared db proxy at `pool` and returns the express app. */
function loadApp(pool) {
  require("../../db").setPool(pool);
  return require("../../app");
}

module.exports = { createTestDb, loadApp };
