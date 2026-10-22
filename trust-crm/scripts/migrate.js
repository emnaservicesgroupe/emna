const fs = require("fs");
const path = require("path");

const DEFAULT_DIR = path.join(__dirname, "..", "sql", "migrations");

/**
 * Applies pending *.sql files (sorted by name) from `dir`, each in its own
 * transaction, recording them in schema_migrations. Returns applied filenames.
 */
async function runMigrations(pool, dir = DEFAULT_DIR) {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
  );

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize concurrent runners; re-check inside the lock.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('trustcrm_migrations'))");
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [file]);
      if (done.rowCount === 0) {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        applied.push(file);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      err.message = `Migration ${file} failed: ${err.message}`;
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}

module.exports = { runMigrations };

if (require.main === module) {
  const pool = require("../db");
  runMigrations(pool)
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "No pending migrations");
      return pool.end();
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
