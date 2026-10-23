require("dotenv").config();
const app = require("./app");
const { startAlertScheduler } = require("./jobs/alertScheduler");

try {
  startAlertScheduler();
} catch (err) {
  console.log("Scheduler not started:", err.message);
}

try {
  const { startJobSearchScheduler } = require("./modules/jobsearch/scheduler");
  const task = startJobSearchScheduler();
  console.log(task ? "Job-search scheduler started" : "Job-search scheduler disabled (JOBSEARCH_SCHEDULER=off or NODE_ENV=test)");
} catch (err) {
  console.log("Job-search scheduler not started:", err.message);
}

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 EMNA CRM running on port ${PORT}`);
});
