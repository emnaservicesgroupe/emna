'use strict';
const { load } = require('./config');
const { createDb } = require('./db');
const { migrate } = require('./db/migrate');
const { createContext } = require('./context');
const { createApp } = require('./http/app');
const { startWorkers } = require('./workers');

async function main() {
  const config = load();
  const db = createDb(config.databaseUrl);
  const ctx = createContext({ config, db });
  if (process.env.AUTO_MIGRATE !== 'false') await migrate(db, { log: (m) => ctx.log.info(m) });
  const app = createApp(ctx);
  const server = app.listen(config.port, () => ctx.log.info('FIND WAY listening', { port: config.port, env: config.env }));
  const stop = config.workersEnabled ? startWorkers(ctx) : () => {};
  const shutdown = async () => { stop(); server.close(); await db.close(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
