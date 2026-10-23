const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
// Same database as every other test file (tests/helpers/db.js default): never the DB_* values of a local .env.
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/trustcrm_test";
const { verifyMigrations, verifyOnExistingData } = require("../scripts/verify-migrations");

test("verify-migrations: real migrations apply from scratch and keep existing rows unchanged", async () => {
  const r = await verifyMigrations();
  const files = fs.readdirSync(path.join(__dirname, "..", "sql", "migrations")).filter((f) => f.endsWith(".sql"));
  assert.equal(r.scratch.applied, files.length);
  assert.equal(r.existing.applied, files.length);
  assert.ok(r.existing.rowsUnchanged.candidates >= 3);
  assert.ok(r.existing.rowsUnchanged.users >= 3);
});

test("verify-migrations: a migration that rewrites existing data is detected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-bad-"));
  try {
    for (const f of fs.readdirSync(path.join(__dirname, "..", "sql", "migrations"))) {
      fs.copyFileSync(path.join(__dirname, "..", "sql", "migrations", f), path.join(dir, f));
    }
    fs.writeFileSync(path.join(dir, "999_bad.sql"), "UPDATE candidates SET work_company = 'changed';");
    await assert.rejects(verifyOnExistingData({ dir }), /candidates row changed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
