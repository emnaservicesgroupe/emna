'use strict';
// Proves a backup is restorable: dump -> restore into a scratch database -> compare every table's row count and
// confirm the append-only protections survived. Usage: DATABASE_URL=... node scripts/backup-restore-check.js
// Needs pg_dump/pg_restore (set PG_BIN to their directory if they are not on PATH).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const bin = (name) => (process.env.PG_BIN ? path.join(process.env.PG_BIN, name) : name);
const swapDb = (url, db) => url.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);

async function counts(client) {
  const tables = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`)).rows.map((r) => r.tablename);
  const out = {};
  for (const t of tables) out[t] = (await client.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n;
  return out;
}

async function check(sourceUrl, { keepDump = false } = {}) {
  const dump = path.join(os.tmpdir(), `findway-backup-${Date.now()}.dump`);
  const scratch = `fw_restore_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: swapDb(sourceUrl, 'postgres') });
  await admin.connect();
  try {
    execFileSync(bin('pg_dump'), ['--format=custom', '--no-owner', '--file', dump, sourceUrl], { stdio: 'pipe' });
    await admin.query(`CREATE DATABASE ${scratch}`);
    const restoreUrl = swapDb(sourceUrl, scratch);
    execFileSync(bin('pg_restore'), ['--no-owner', '--exit-on-error', '--dbname', restoreUrl, dump], { stdio: 'pipe' });
    const src = new Client({ connectionString: sourceUrl }); const dst = new Client({ connectionString: restoreUrl });
    await src.connect(); await dst.connect();
    try {
      const a = await counts(src); const b = await counts(dst);
      const mismatched = Object.keys(a).filter((t) => a[t] !== b[t]);
      const missing = Object.keys(a).filter((t) => !(t in b));
      const trig = (await dst.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('audit_events_immutable','application_events_immutable')`)).rows[0].n;
      let appendOnly = false;
      try { await dst.query(`UPDATE audit_events SET action='x' WHERE false`); await dst.query(`DELETE FROM audit_events WHERE id = (SELECT id FROM audit_events LIMIT 1)`); } catch (e) { appendOnly = /append-only/.test(e.message); }
      const rows = Object.values(a).reduce((x, y) => x + y, 0);
      return { ok: !mismatched.length && !missing.length && trig === 2 && (rows === 0 || a.audit_events === 0 || appendOnly), tables: Object.keys(a).length, rows, mismatched, missing, triggers_restored: trig, append_only_enforced_after_restore: appendOnly, dump_bytes: fs.statSync(dump).size };
    } finally { await src.end(); await dst.end(); }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => {});
    await admin.end();
    if (!keepDump) fs.rmSync(dump, { force: true });
  }
}

module.exports = { check };

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Set DATABASE_URL'); process.exit(2); }
  check(url).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }).catch((e) => { console.error(e.message); process.exit(1); });
}
