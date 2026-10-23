'use strict';
// Dependency container. Services receive `ctx` so tests can inject a fake clock, mailer and database.
const { deriveKey } = require('./lib/crypto');
const { createLogger } = require('./lib/logger');
const { createMailer } = require('./services/mailer');

function createContext({ config, db, clock, mailer, log }) {
  return {
    config,
    db,
    clock: clock || { now: () => new Date() },
    log: log || createLogger(),
    mailer: mailer || createMailer(config),
    keys: {
      otp: deriveKey(config.masterKey, 'otp'),
      enc: deriveKey(config.masterKey, 'enc'),
      identity: deriveKey(config.masterKey, 'identity'),
      webhook: deriveKey(config.masterKey, 'webhook'),
    },
  };
}

async function getSetting(ctx, key, fallback = null) {
  const r = await ctx.db.one('SELECT value FROM settings WHERE key=$1', [key]);
  return r ? r.value : fallback;
}

module.exports = { createContext, getSetting };
