// Graceful shutdown (Task 20). `docker compose stop` / `docker stop` sends SIGTERM and kills the process
// after the grace period (docker-compose.yml: stop_grace_period 30s). On the first SIGTERM/SIGINT:
//   1. stop the timers (job-search scheduler + queue workers, alert job) and close every SSE stream, so no
//      new work starts and keep-alive event streams do not hold the HTTP server open;
//   2. stop accepting connections and wait for in-flight HTTP requests (server.close);
//   3. wait until a running scheduler tick / worker batch has finished (isIdle);
//   4. close the database pool - this also ends the sessions that hold Postgres advisory locks, so the
//      next process can take the scheduler and sender locks at once;
//   5. exit 0. If anything hangs longer than timeoutMs the process exits 1 (the sender's two-phase intent
//      records make an interrupted send visible as outcome_unknown, never as a silent duplicate).
// Later signals are ignored while shutting down.

/**
 * @param {{server: import("http").Server, stop?: Array<() => void>, isIdle?: () => boolean,
 *          closeDb?: () => Promise<void>, exit?: (code: number) => void, log?: Console, timeoutMs?: number}} opts
 * @returns {(signal: string) => Promise<void>}
 */
function createShutdown({ server, stop = [], isIdle = () => true, closeDb = async () => {}, exit = (c) => process.exit(c), log = console, timeoutMs = 25000 }) {
  let running = null;

  async function waitIdle(deadline) {
    while (!isIdle() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  async function run(signal) {
    log.log(`${signal} received: shutting down gracefully (max ${Math.round(timeoutMs / 1000)}s)`);
    const deadline = Date.now() + timeoutMs;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    const work = (async () => {
      for (const step of stop) {
        try {
          step();
        } catch (err) {
          log.error(`shutdown step failed: ${err && err.message}`);
        }
      }
      if (server && server.listening) {
        await new Promise((resolve) => {
          server.close(() => resolve());
          if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
        });
      }
      await waitIdle(deadline);
      await closeDb();
      return "done";
    })().catch((err) => {
      log.error(`shutdown failed: ${err && err.message}`);
      return "error";
    });
    const outcome = await Promise.race([work, timeout]);
    clearTimeout(timer);
    if (outcome === "done") {
      log.log("shutdown complete");
      exit(0);
    } else {
      log.error(outcome === "timeout" ? `shutdown did not finish within ${Math.round(timeoutMs / 1000)}s: forcing exit` : "shutdown incomplete: forcing exit");
      exit(1);
    }
  }

  return function shutdown(signal) {
    if (!running) running = run(signal);
    return running;
  };
}

module.exports = { createShutdown };
