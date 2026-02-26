require("dotenv").config();
const express = require("express");
const cors = require("cors");

const candidateRoutes = require("./routes/candidates");
const alertRoutes = require("./routes/alerts");
const authRoutes = require("./routes/auth");
const notificationRoutes = require("./routes/notifications");
const { startAlertScheduler } = require("./jobs/alertScheduler");

const app = express();

app.use(cors());
app.use(express.json());

// ⭐️ ROOT ROUTE
app.get("/status", (req, res) => {
  res.json({
    system: "EMNA CRM",
    status: "Running",
    company: "Emna Visa Services",
    owner: "Mohamed Aloui"
  });
});
app.get("/", (req, res) => {
  res.send("EMNA CRM Backend Running 🚀");
});
app.use("/candidates", candidateRoutes);
app.use("/alerts", alertRoutes);
app.use("/auth", authRoutes);
app.use("/notifications", notificationRoutes);

try {
  startAlertScheduler();
} catch (err) {
  console.log("Scheduler skipped:", err.message);
}
startAlertScheduler();
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
