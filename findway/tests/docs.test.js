'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { outputs } = require('../scripts/gen-docs');

test('generated documentation (permission matrix, endpoint list) is up to date with the code', () => {
  for (const [file, body] of Object.entries(outputs)) {
    const onDisk = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.equal(onDisk, body, `${file} is stale: run \`node scripts/gen-docs.js\``);
  }
});
