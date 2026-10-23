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

test("Task 19 M-6: without TEST_DATABASE_URL/DATABASE_URL the script prints a clear message and exits 2 (never falls back to .env DB_*)", () => {
  const { spawnSync } = require("child_process");
  const env = { ...process.env, DB_HOST: "db.example.invalid", DB_USER: "u", DB_PASSWORD: "p", DB_NAME: "n", DB_PORT: "5432" };
  delete env.TEST_DATABASE_URL;
  delete env.DATABASE_URL;
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "verify-migrations.js")], { env, cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /TEST_DATABASE_URL or DATABASE_URL/);
  assert.ok(!/db\.example\.invalid/.test(r.stdout + r.stderr), "never tried the DB_* host");
});
