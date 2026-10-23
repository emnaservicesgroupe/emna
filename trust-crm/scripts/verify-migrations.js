#!/usr/bin/env node
// Migration dry run (Task 17). Proves, on THROWAWAY schemas only, that:
//   1. from scratch: sql/schema.sql + every migration applies cleanly, and a second run applies nothing;
//   2. on existing data: a schema loaded with sql/schema.sql and sample rows in every original table
//      keeps every original row and column value byte-for-byte after all migrations are applied.
//
//   node scripts/verify-migrations.js            (uses TEST_DATABASE_URL, else DATABASE_URL, else DB_*)
//
// It never touches existing tables: it creates schemas named vm_<random>, pins search_path to them and
// drops them at the end (also on failure). Exit code 0 = all checks passed, 1 = a check failed.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { runMigrations } = require("./migrate");

const ROOT = path.join(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "sql", "migrations");
const ORIGINAL_TABLES = ["users", "candidates", "visa_applications", "documents", "invoices", "payments", "expenses", "notifications", "audit_logs"];

function connectionConfig() {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (url) return { connectionString: url };
  return { host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: process.env.DB_PORT };
}

async function withScratchSchema(fn) {
  const schema = `vm_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new Pool({ ...connectionConfig(), max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ ...connectionConfig(), options: `-c search_path=${schema},public` });
  try {
    return await fn(pool, schema);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

function expectedMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

async function loadBaseSchema(pool) {
  await pool.query(fs.readFileSync(path.join(ROOT, "sql", "schema.sql"), "utf8"));
}

async function insertSampleRows(pool) {
  const u = await pool.query(
    `INSERT INTO users (full_name, email, password, role) VALUES
       ('Sample Admin', 'sample.admin@test.invalid', '$2b$10$abcdefghijklmnopqrstuuJ0Yl3n0sV8tq7q2Zq8m0Zt1eY6Gm2', 'Admin'),
       ('Sample Agent', 'sample.agent@test.invalid', 'hash-agent', 'Agent'),
       ('Sample Accountant', 'sample.acc@test.invalid', 'hash-acc', 'Accountant')
     RETURNING id`
  );
  const [admin, agent] = u.rows.map((r) => r.id);
  const c = await pool.query(
    `INSERT INTO candidates (full_name, nationality, date_of_birth, passport_number, passport_expiry, b3_expiry, embassy_date,
                             visa_status, work_company, partner_company, assigned_to, created_by)
     VALUES ('Amina Sample', 'TN', '1990-05-01', 'P-0001', '2030-01-01', '2027-03-01', '2026-12-01', 'Documents', 'Acme', 'Partner A', $1, $2),
            ('Youssef Sample', 'MA', '1985-11-20', 'P-0002', '2029-06-30', NULL, NULL, 'Embassy', NULL, NULL, NULL, $2),
            ('Deleted Sample', 'DZ', NULL, 'P-0003', NULL, NULL, NULL, 'Documents', NULL, NULL, $1, $2)
     RETURNING id`,
    [agent, admin]
  );
  const [c1, c2, c3] = c.rows.map((r) => r.id);
  await pool.query("UPDATE candidates SET is_deleted = true, deleted_at = '2026-01-02 03:04:05' WHERE id = $1", [c3]);
  await pool.query("INSERT INTO visa_applications (candidate_id, stage, status, notes, updated_by) VALUES ($1,'Embassy','Pending','note',$2)", [c2, admin]);
  await pool.query(
    "INSERT INTO documents (candidate_id, doc_type, file_path, expiry_date, status, notes, uploaded_by) VALUES ($1,'passport','/files/p1.pdf','2030-01-01','Uploaded','scan',$2), ($1,'cv','/files/cv.pdf',NULL,'Uploaded',NULL,$2)",
    [c1, agent]
  );
  const inv = await pool.query("INSERT INTO invoices (candidate_id, total_amount, remaining_amount, currency, due_date, created_by) VALUES ($1, 1500.50, 500.25, 'TND', '2026-12-31', $2) RETURNING id", [c1, admin]);
  await pool.query("INSERT INTO payments (invoice_id, candidate_id, amount_paid, payment_method, created_by) VALUES ($1,$2,1000.25,'cash',$3)", [inv.rows[0].id, c1, admin]);
  await pool.query("INSERT INTO expenses (title, amount, created_by) VALUES ('Office rent', 800, $1)", [admin]);
  await pool.query("INSERT INTO notifications (candidate_id, type, message, due_date) VALUES ($1,'passport_expiry','Passport expires soon','2029-12-01')", [c2]);
  await pool.query("INSERT INTO audit_logs (user_id, action, table_name, record_id, new_data) VALUES ($1,'CREATE','candidates',$2,'{\"full_name\":\"Amina Sample\"}')", [admin, String(c1)]);
}

async function columnsOf(pool, table) {
  const r = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
    [table]
  );
  return r.rows.map((x) => x.column_name);
}

/** Every row of `table` restricted to `cols`, as text (exact values), ordered by id. */
async function snapshot(pool, table, cols) {
  const list = cols.map((c) => `"${c}"`).join(", ");
  const r = await pool.query(`SELECT row_to_json(t)::text AS j FROM (SELECT ${list} FROM "${table}" ORDER BY id) t`);
  return r.rows.map((x) => x.j);
}

async function verifyFromScratch({ dir = MIGRATIONS_DIR } = {}) {
  return withScratchSchema(async (pool) => {
    await loadBaseSchema(pool);
    const applied = await runMigrations(pool, dir);
    const want = expectedMigrations(dir);
    if (JSON.stringify(applied) !== JSON.stringify(want)) throw new Error(`from scratch: applied ${applied.join(",")} but expected ${want.join(",")}`);
    const again = await runMigrations(pool, dir);
    if (again.length) throw new Error(`from scratch: second run applied ${again.join(",")} (not idempotent)`);
    const tables = (await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'js\\_%'")).rows[0].n;
    if (tables < 1) throw new Error("from scratch: no js_* tables were created");
    return { applied: applied.length, jsTables: tables };
  });
}

async function verifyOnExistingData({ dir = MIGRATIONS_DIR } = {}) {
  return withScratchSchema(async (pool) => {
    await loadBaseSchema(pool);
    await insertSampleRows(pool);
    const before = {};
    for (const t of ORIGINAL_TABLES) {
      const cols = await columnsOf(pool, t);
      before[t] = { cols, rows: await snapshot(pool, t, cols) };
    }
    const applied = await runMigrations(pool, dir);
    if (applied.length !== expectedMigrations(dir).length) throw new Error(`existing data: applied ${applied.length} of ${expectedMigrations(dir).length} migrations`);
    const counts = {};
    for (const t of ORIGINAL_TABLES) {
      const colsAfter = await columnsOf(pool, t);
      const lost = before[t].cols.filter((c) => !colsAfter.includes(c));
      if (lost.length) throw new Error(`existing data: ${t} lost column(s) ${lost.join(",")}`);
      const rows = await snapshot(pool, t, before[t].cols);
      if (rows.length !== before[t].rows.length) throw new Error(`existing data: ${t} row count ${before[t].rows.length} -> ${rows.length}`);
      for (let i = 0; i < rows.length; i++) {
        if (rows[i] !== before[t].rows[i]) throw new Error(`existing data: ${t} row changed:\n  before ${before[t].rows[i]}\n  after  ${rows[i]}`);
      }
      counts[t] = rows.length;
    }
    const again = await runMigrations(pool, dir);
    if (again.length) throw new Error(`existing data: second run applied ${again.join(",")} (not idempotent)`);
    // the migrated schema still accepts the original roles and the new one
    await pool.query("INSERT INTO users (full_name, email, password, role) VALUES ('Post HR','post.hr@test.invalid','h','HR'), ('Post Cand','post.cand@test.invalid','h','Candidate')");
    return { applied: applied.length, rowsUnchanged: counts };
  });
}

async function verifyMigrations(opts = {}) {
  const scratch = await verifyFromScratch(opts);
  const existing = await verifyOnExistingData(opts);
  return { scratch, existing };
}

module.exports = { verifyMigrations, verifyFromScratch, verifyOnExistingData };

if (require.main === module) {
  verifyMigrations()
    .then((r) => {
      console.log(`OK from scratch: ${r.scratch.applied} migrations applied, ${r.scratch.jsTables} js_* tables, second run applied 0`);
      const rows = Object.entries(r.existing.rowsUnchanged).map(([t, n]) => `${t}=${n}`).join(" ");
      console.log(`OK on existing data: ${r.existing.applied} migrations applied, original rows unchanged (${rows}), second run applied 0`);
    })
    .catch((err) => {
      console.error(`FAILED: ${err.message}`);
      process.exit(1);
    });
}
