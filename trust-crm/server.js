require("dotenv").config();
require("./utils/preflight").runPreflight(); // NODE_ENV=production only: refuses to start on unsafe settings (Task 20)
const app = require("./app");
const db = require("./db");
const { startAlertScheduler } = require("./jobs/alertScheduler");
const { createShutdown } = require("./utils/shutdown");

let alertTask = null;
try {
  alertTask = startAlertScheduler();
} catch (err) {
  console.log("Scheduler not started:", err.message);
}

let jobSearch = null;
try {
  jobSearch = require("./modules/jobsearch/scheduler");
  const task = jobSearch.startJobSearchScheduler();
  console.log(task ? "Job-search scheduler started" : "Job-search scheduler disabled (JOBSEARCH_SCHEDULER=off or NODE_ENV=test)");
} catch (err) {
  console.log("Job-search scheduler not started:", err.message);
}

// HR: HR_TIMEZONE and the schedule timezones are checked against the database's zone list; problems are logged, never fatal.
require("./modules/hr/common").checkTimezoneConfig(db).catch((err) => console.log("HR timezone check skipped:", err.message));

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`🚀 EMNA CRM running on port ${PORT}`);
});

// Graceful shutdown (Task 20): docker stop / compose down send SIGTERM.
const shutdown = createShutdown({
  server,
  stop: [
    () => jobSearch && jobSearch.stopJobSearchScheduler(),
    () => alertTask && typeof alertTask.stop === "function" && alertTask.stop(),
    () => require("./modules/jobsearch/eventsHub").shutdown(),
    () => require("./modules/chat/hub").shutdown(),
  ],
  isIdle: () => !jobSearch || typeof jobSearch.isIdle !== "function" || jobSearch.isIdle(),
  closeDb: () => db.end(),
  timeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS) > 0 ? Number(process.env.SHUTDOWN_TIMEOUT_MS) : 25000,
});
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
