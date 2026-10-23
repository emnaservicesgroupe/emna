// Queue workers for the job-search module. Task 12 calls startWorkers() from server.js.
//   handlers = {submit: handleSubmit, search: handleSearchJob}
//   tick()   one pass: stale-lock sweep, interrupted-send sweep, then due items (capped)
//   startWorkers({intervalMs?}) -> timer | null   (unref'd; off when JOBSEARCH_WORKERS=off or NODE_ENV=test)
const queue = require("./queue");
const submitter = require("./submitter");
const searchRunner = require("./searchRunner");

const handlers = {
  submit: (job) => submitter.handleSubmit(job),
  search: (job) => searchRunner.handleSearchJob(job),
};

const DEFAULT_INTERVAL_MS = 30 * 1000;
const TICK_CAP = 50;

let running = false;
let timer = null;

/**
 * @param {{kinds?: string[], max?: number, now?: Date}} [opts]
 * @returns {Promise<{reclaimed: number, staleFailed: number, interrupted: number, processed: number}>}
 */
async function tick({ kinds, max = TICK_CAP, now } = {}) {
  const stale = await queue.reclaimStale({ now });
  const interrupted = await submitter.sweepStuckSending();
  const processed = await queue.work(handlers, { kinds, batch: 10, loop: true, max, now });
  return { reclaimed: stale.reclaimed, staleFailed: stale.failed, interrupted, processed };
}

function enabled() {
  return String(process.env.JOBSEARCH_WORKERS || "").toLowerCase() !== "off" && process.env.NODE_ENV !== "test";
}

function startWorkers({ intervalMs } = {}) {
  if (!enabled() || timer) return timer;
  const every = Number(intervalMs || process.env.JOBSEARCH_WORKER_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error("jobsearch worker tick failed:", err && err.code, err && err.message);
    } finally {
      running = false;
    }
  }, every);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function stopWorkers() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { handlers, tick, startWorkers, stopWorkers, enabled };
