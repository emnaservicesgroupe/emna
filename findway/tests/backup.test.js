'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTestEnv } = require('./helpers');
const { check } = require('../scripts/backup-restore-check');

let env;
before(async () => { env = await createTestEnv(); if (!process.env.PG_BIN && fs.existsSync('/usr/lib/postgresql/16/bin/pg_dump')) process.env.PG_BIN = '/usr/lib/postgresql/16/bin'; });
after(async () => { await env.close(); });

test('backup restoration succeeds: a dump of a populated database restores with identical row counts and intact append-only guards', async () => {
  const { job } = await env.employerWithPublishedJob();
  const c = await env.readyCandidate();
  await env.api('POST', '/api/candidate/applications', { token: c.token, body: { job_id: job.id } });
  const url = env.ctx.config.databaseUrl;
  const r = await check(url);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.rows > 40 && r.tables >= 35, `expected a populated schema, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.mismatched, []);
  assert.equal(r.append_only_enforced_after_restore, true);
});
