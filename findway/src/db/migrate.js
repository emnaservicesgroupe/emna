'use strict';
// Forward-only SQL migrations with checksums. Usage: node src/db/migrate.js [--status]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDb } = require('./index');

const DIR = path.join(__dirname, 'migrations');

async function migrate(db, { log = () => {} } = {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Map((await db.rows('SELECT name, checksum FROM schema_migrations')).map((r) => [r.name, r.checksum]));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const ran = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
      continue;
    }
    await db.tx(async (t) => {
      await t.query(sql);
      await t.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)', [file, checksum]);
    });
    log(`applied ${file}`);
    ran.push(file);
  }
  return ran;
}

module.exports = { migrate };

if (require.main === module) {
  const { load } = require('../config');
  const db = createDb(load().databaseUrl);
  migrate(db, { log: console.log })
    .then((r) => { console.log(r.length ? `done (${r.length} applied)` : 'up to date'); return db.close(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
