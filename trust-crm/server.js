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
app.get("/", (req, res) => {
  res.send("EMNA CRM Backend Running 🚀");
});

app.use("/candidates", candidateRoutes);
app.use("/alerts", alertRoutes);
app.use("/auth", authRoutes);
app.use("/notifications", notificationRoutes);

startAlertScheduler();

app.listen(process.env.PORT, () => {
  console.log("🚀 CRM Running on port " + process.env.PORT);
});
