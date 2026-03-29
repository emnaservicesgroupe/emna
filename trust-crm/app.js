const express = require("express");
const cors = require("cors");

const candidateRoutes = require("./routes/candidates");
const alertRoutes = require("./routes/alerts");
const authRoutes = require("./routes/auth");
const notificationRoutes = require("./routes/notifications");
const financeRoutes = require("./routes/finance");
const documentRoutes = require("./routes/documents");
const auditRoutes = require("./routes/audit");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => {
  res.json({
    system: "EMNA Services CRM",
    status: "Running",
    company: "Emna Visa Services",
    mode: "Production API",
  });
});

app.use("/auth", authRoutes);
app.use("/candidates", candidateRoutes);
app.use("/alerts", alertRoutes);
app.use("/notifications", notificationRoutes);
app.use("/finance", financeRoutes);
app.use("/documents", documentRoutes);
app.use("/audit-logs", auditRoutes);

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  return res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
