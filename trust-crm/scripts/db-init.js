#!/usr/bin/env node
// Database initialisation for a container start (Task 20; run by scripts/docker-entrypoint.sh before
// server.js). Idempotent:
//   1. NODE_ENV=production: the same preflight as server.js (refuses to start, listing every problem);
//   2. waits for the database (retries; docker compose also waits for the db healthcheck);
//   3. on an EMPTY database (no `users` table) applies sql/schema.sql - the original CRM tables;
//   4. applies every pending migration (scripts/migrate.js, one transaction each, serialized by a lock).
// A database that already has the tables is never touched by step 3.
const fs = require("fs");
const path = require("path");
const { runMigrations } = require("./migrate");

const SCHEMA_FILE = path.join(__dirname, "..", "sql", "schema.sql");

async function waitForDb(pool, { retries, delayMs, log }) {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (attempt >= retries) throw new Error(`database not reachable after ${retries} attempts (${(err && err.code) || "error"})`);
      log.log(`db-init: waiting for the database (attempt ${attempt}/${retries}, ${(err && err.code) || "error"})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * @param {import("pg").Pool|{query: Function, connect: Function}} pool
 * @param {{log?: Console, retries?: number, delayMs?: number}} [opts]
 * @returns {Promise<{schemaApplied: boolean, applied: string[]}>}
 */
async function initDatabase(pool, { log = console, retries = 30, delayMs = 2000 } = {}) {
  await waitForDb(pool, { retries, delayMs, log });
  const has = await pool.query("SELECT to_regclass('users') AS t");
  let schemaApplied = false;
  if (!has.rows[0].t) {
    log.log("db-init: empty database - creating the original CRM tables (sql/schema.sql)");
    await pool.query(fs.readFileSync(SCHEMA_FILE, "utf8"));
    schemaApplied = true;
  }
  const applied = await runMigrations(pool);
  log.log(applied.length ? `db-init: applied migrations: ${applied.join(", ")}` : "db-init: database is up to date (no pending migrations)");
  // Task 20 (I6): the app should never connect as a Postgres superuser
  const role = (await pool.query("SELECT rolsuper OR rolcreaterole OR rolcreatedb AS privileged FROM pg_roles WHERE rolname = current_user")).rows[0];
  const privileged = Boolean(role && role.privileged);
  if (privileged) log.log("db-init: WARNING the app connects with a privileged Postgres role (superuser/createrole/createdb); use an unprivileged role that owns the database (the Docker kit creates vita_app)");
  return { schemaApplied, applied, privileged };
}

module.exports = { initDatabase };

if (require.main === module) {
  require("dotenv").config();
  // problems only: the warnings are printed once, by server.js right after this step
  require("../utils/preflight").runPreflight({ printWarnings: false });
  const db = require("../db");
  initDatabase(db)
    .then(() => db.end())
    .catch((err) => {
      console.error(`db-init failed: ${err.message}`);
      db.end().catch(() => {});
      process.exit(1);
    });
}
