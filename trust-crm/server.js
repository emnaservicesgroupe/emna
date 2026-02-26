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

// ✅ ROOT ROUTE (باش ما عادش يظهر Cannot GET /)
app.get("/", (req, res) => {
  res.json({
    system: "EMNA CRM",
    status: "Running",
    company: "Emna Visa Services",
    owner: "Mohamed Aloui"
  });
});

// ✅ ROUTES
app.use("/candidates", candidateRoutes);
app.use("/alerts", alertRoutes);
app.use("/auth", authRoutes);
app.use("/notifications", notificationRoutes);

// ✅ START SCHEDULER
try {
  startAlertScheduler();
} catch (err) {
  console.log("Scheduler not started:", err.message);
}

// ✅ PORT (مهم جدا ل Render)
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 EMNA CRM running on port ${PORT}`);
});
