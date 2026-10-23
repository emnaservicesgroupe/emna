// Task 15 fix round 1: scripts/dev-seed-ui.js must never seed a real or remote database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const bcrypt = require("bcrypt");
const { createTestDb } = require("./helpers/db");

const SCRIPT = path.join(__dirname, "..", "scripts", "dev-seed-ui.js");
const BASE_URL = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/trustcrm_test";

/** Runs the seed with a controlled environment (no inherited DB settings). */
function run(env) {
  const clean = { PATH: process.env.PATH, HOME: process.env.HOME };
  // dotenv never overrides variables that are set, so pin every DB variable explicitly.
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: path.join(__dirname, ".."),
    env: { ...clean, DATABASE_URL: "", DB_HOST: "", PGHOST: "", TEST_DATABASE_URL: "", ...env },
    encoding: "utf8",
    timeout: 60000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

function schemaUrl(schema) {
  const u = new URL(BASE_URL);
  u.searchParams.set("options", `-c search_path=${schema},public`);
  return u.toString();
}

test("seed refuses NODE_ENV=production even against a local database", () => {
  const r = run({ NODE_ENV: "production", TEST_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/none" });
  assert.equal(r.code, 2);
  assert.match(r.err, /refusing.*production/i);
});

test("seed refuses other NODE_ENV values", () => {
  const r = run({ NODE_ENV: "staging", TEST_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/none" });
  assert.equal(r.code, 2);
});

test("seed refuses a remote database host without VITA_SEED_ALLOW_REMOTE=1, and always when NODE_ENV is unset", () => {
  for (const env of [
    { NODE_ENV: "development", DATABASE_URL: "postgres://u:p@db.prod.example.com:5432/crm" },
    { NODE_ENV: "development", TEST_DATABASE_URL: "postgres://u:p@10.0.0.5/crm" },
    { NODE_ENV: "test", DB_HOST: "db.internal.example" },
    { DATABASE_URL: "postgres://u:p@db.prod.example.com/crm" },
    { DATABASE_URL: "postgres://u:p@db.prod.example.com/crm", VITA_SEED_ALLOW_REMOTE: "1" },
  ]) {
    const r = run(env);
    assert.equal(r.code, 2, JSON.stringify(env) + r.err);
    assert.match(r.err, /not local/);
  }
});

test("seed refuses a VITA_SEED_PASSWORD shorter than 12 characters", () => {
  const r = run({ NODE_ENV: "development", TEST_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/none", VITA_SEED_PASSWORD: "short-pass1" });
  assert.equal(r.code, 2);
  assert.match(r.err, /at least 12/);
});

test("seed refuses a database that already has a non-DEMO user (real install) unless VITA_SEED_FORCE=1", async () => {
  const { pool, schema, cleanup } = await createTestDb();
  try {
    await pool.query("INSERT INTO users (full_name, email, password, role) VALUES ('Real Owner','owner@real-company.example','x','SuperAdmin')");
    const r = run({ NODE_ENV: "development", TEST_DATABASE_URL: schemaUrl(schema) });
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /non-DEMO user/);
    const demo = await pool.query("SELECT count(*)::int AS n FROM users WHERE email LIKE 'demo.%@test.invalid'");
    assert.equal(demo.rows[0].n, 0, "nothing was written");
    const cands = await pool.query("SELECT count(*)::int AS n FROM candidates");
    assert.equal(cands.rows[0].n, 0);
  } finally {
    await cleanup();
  }
});

test("seed on a local empty database: banner, random password printed once, DEMO-labelled rows, idempotent", async () => {
  const { pool, schema, cleanup } = await createTestDb();
  try {
    const r = run({ NODE_ENV: "development", TEST_DATABASE_URL: schemaUrl(schema) });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /DEMO DATA — NOT FOR PRODUCTION/);
    const m = /SuperAdmin: demo\.superadmin@test\.invalid {2}password: (\S+)/.exec(r.out);
    assert.ok(m, r.out);
    const pw = m[1];
    assert.ok(pw.length >= 20, "random password is long");
    const admin = (await pool.query("SELECT password, role FROM users WHERE email = 'demo.superadmin@test.invalid'")).rows[0];
    assert.equal(admin.role, "SuperAdmin");
    assert.ok(await bcrypt.compare(pw, admin.password));
    const names = (await pool.query("SELECT full_name FROM candidates")).rows.map((x) => x.full_name);
    assert.ok(names.length >= 2 && names.every((n) => n.startsWith("DEMO ")), names.join(","));
    const jobs = (await pool.query("SELECT title FROM js_jobs")).rows.map((x) => x.title);
    assert.ok(jobs.length > 0 && jobs.every((x) => x.startsWith("[DEMO]")));
    const connected = await pool.query("SELECT count(*)::int AS n FROM js_sources WHERE status = 'connected'");
    assert.equal(connected.rows[0].n, 0, "no source is shown as live");

    // second run: different password would be generated, but nothing changes and none is printed
    const again = run({ NODE_ENV: "development", TEST_DATABASE_URL: schemaUrl(schema) });
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /already present/);
    assert.ok(!again.out.includes(pw));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 4);

    // a different run generates a different password (never a fixed default)
    const { pool: pool2, schema: schema2, cleanup: cleanup2 } = await createTestDb();
    try {
      const r2 = run({ NODE_ENV: "test", TEST_DATABASE_URL: schemaUrl(schema2) });
      assert.equal(r2.code, 0, r2.err);
      const pw2 = /password: (\S+)/.exec(r2.out)[1];
      assert.notEqual(pw2, pw);
      void pool2;
    } finally {
      await cleanup2();
    }
  } finally {
    await cleanup();
  }
});

test("seed source contains no fixed/default passwords", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src, /DemoPass|password123|admin123|changeme|letmein|P@ssw0rd|secret123|demo1234|qwerty/i);
  assert.doesNotMatch(src, /VITA_SEED_PASSWORD\s*\|\|\s*["'`]/, "no literal fallback password");
  assert.match(src, /crypto\.randomBytes\(/);
});
