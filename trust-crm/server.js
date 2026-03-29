require("dotenv").config();
const app = require("./app");
const { startAlertScheduler } = require("./jobs/alertScheduler");

try {
  startAlertScheduler();
} catch (err) {
  console.log("Scheduler not started:", err.message);
}

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 EMNA CRM running on port ${PORT}`);
});
