#!/usr/bin/env node
// Drops stale per-test schemas (t_<pid>_...) left behind by interrupted test runs.
//
//   node scripts/cleanup-test-schemas.js            (uses TEST_DATABASE_URL, else the test default URL)
//
// Safety:
//  - Refuses unless the connected database's name contains "test" (checked with current_database() on
//    the live connection, not on the URL text).
//  - Only schemas named t_<digits>_<suffix> (the names tests/helpers/db.js creates) are considered.
//  - A schema is dropped only when it is older than maxAgeMs (default 1 hour), judged by its
//    schema_migrations.applied_at; a schema without that table is dropped only when the process id in its
//    name is no longer running on this host (half-created schema of a dead run).
//  - One process at a time (session advisory lock); others skip. Never throws from the test helper path.
const { Pool } = require("pg");

const DEFAULT_URL = "postgres://postgres:postgres@localhost:5432/trustcrm_test";
const NAME_RE = /^t_(\d{1,10})_[0-9a-z_]{1,40}$/;
const LOCK_KEY = "trustcrm:cleanup-test-schemas";

class RefusedError extends Error {}

function assertTestDatabase(name) {
  if (typeof name !== "string" || !name.toLowerCase().includes("test")) {
    throw new RefusedError(`refusing to clean schemas: database "${name}" is not a test database (its name must contain "test")`);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * @param {{connectionString?: string, maxAgeMs?: number, wait?: boolean, log?: (msg: string) => void}} [opts]
 *   wait: block until another cleanup finishes instead of skipping (the test helper skips)
 *   callerHoldsLock: the caller already holds the advisory lock (LOCK_KEY) on its own connection; this run does
 *     not take it (the script's own test builds dead-pid schemas under the lock so that the start-up cleanup of
 *     a parallel test process cannot drop them half-built)
 * @returns {Promise<{database: string, dropped: string[], kept: number, skipped?: string}>}
 */
async function cleanupTestSchemas(opts = {}) {
  const connectionString = opts.connectionString || process.env.TEST_DATABASE_URL || DEFAULT_URL;
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs >= 0 ? opts.maxAgeMs : 3600 * 1000;
  const log = opts.log || (() => {});
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    const database = (await client.query("SELECT current_database() AS d")).rows[0].d;
    assertTestDatabase(database);
    if (opts.callerHoldsLock === true) {
      /* lock already held by the caller */
    } else if (opts.wait === true) await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    else if (!(await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [LOCK_KEY])).rows[0].ok) {
      return { database, dropped: [], kept: 0, skipped: "another cleanup is running" };
    }
    try {
      const schemas = (await client.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 't\\_%' ORDER BY nspname")).rows.map((r) => r.nspname);
      const dropped = [];
      let kept = 0;
      for (const name of schemas) {
        const m = NAME_RE.exec(name);
        if (!m) {
          kept += 1;
          continue;
        }
        const hasTable = (await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`"${name}".schema_migrations`])).rows[0].ok;
        let stale;
        if (hasTable) {
          const r = (await client.query(`SELECT min(applied_at) AS at FROM "${name}".schema_migrations`)).rows[0];
          stale = r.at ? Date.now() - new Date(r.at).getTime() > maxAgeMs : !pidAlive(Number(m[1]));
        } else {
          stale = !pidAlive(Number(m[1]));
        }
        if (!stale) {
          kept += 1;
          continue;
        }
        try {
          await client.query(`DROP SCHEMA "${name}" CASCADE`);
          dropped.push(name);
          log(`dropped ${name}`);
        } catch (err) {
          kept += 1; // dropped concurrently or still in use: leave it
        }
      }
      return { database, dropped, kept };
    } finally {
      if (opts.callerHoldsLock !== true) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

module.exports = { cleanupTestSchemas, assertTestDatabase, RefusedError, NAME_RE, LOCK_KEY };

if (require.main === module) {
  cleanupTestSchemas({ log: (m) => console.log(m) })
    .then((r) => {
      console.log(`${r.database}: dropped ${r.dropped.length} stale test schema(s), kept ${r.kept}${r.skipped ? ` (${r.skipped})` : ""}`);
    })
    .catch((err) => {
      console.error(err instanceof RefusedError ? err.message : `cleanup failed: ${err.message}`);
      process.exit(1);
    });
}
