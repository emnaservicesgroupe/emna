'use strict';
// In-process loops for development and single-node deployments. The same functions can be run by an external scheduler.
const dispatcher = require('./integrations/dispatcher');
const jobs = require('./services/jobs');

function startWorkers(ctx) {
  const timers = [];
  const every = (ms, name, fn) => {
    let running = false;
    timers.push(setInterval(async () => {
      if (running) return; running = true;
      try { await fn(); } catch (e) { ctx.log.error(`worker ${name} failed`, { error: e.message }); } finally { running = false; }
    }, ms));
  };
  every(5000, 'sync-dispatcher', () => dispatcher.runOnce(ctx));
  every(60 * 60 * 1000, 'job-expiry', () => jobs.closeExpired(ctx));
  return () => timers.forEach(clearInterval);
}
module.exports = { startWorkers };
