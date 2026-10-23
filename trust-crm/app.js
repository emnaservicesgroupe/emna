const express = require("express");
const cors = require("cors");

const candidateRoutes = require("./routes/candidates");
const alertRoutes = require("./routes/alerts");
const authRoutes = require("./routes/auth");
const notificationRoutes = require("./routes/notifications");
const financeRoutes = require("./routes/finance");
const documentRoutes = require("./routes/documents");
const auditRoutes = require("./routes/audit");
const jobsearchAuthRoutes = require("./routes/jobsearchAuth");
const jobsearchProfileRoutes = require("./routes/jobsearchProfile");
const jobsearchConsentRoutes = require("./routes/jobsearchConsent");
const jobsearchSourcesRoutes = require("./routes/jobsearchSources");
const jobsearchMatchesRoutes = require("./routes/jobsearchMatches");
const jobsearchApplicationsRoutes = require("./routes/jobsearchApplications");
const jobsearchSubmissionsRoutes = require("./routes/jobsearchSubmissions");
const jobsearchAdminRoutes = require("./routes/jobsearchAdmin");
const jobsearchInboxRoutes = require("./routes/jobsearchInbox");
const jobsearchReportsRoutes = require("./routes/jobsearchReports");
const { jobsearchBodyErrorHandler } = require("./modules/jobsearch/errorHandler");
const { mountVita } = require("./routes/vitaStatic");

const app = express();

app.use(cors());
// /jobsearch parses its own JSON first so parser errors (which carry the raw body,
// possibly an OTP) are answered without logging; the global parser then skips
// already-parsed requests. Non-jobsearch routes are unaffected.
// The inbound-mail webhook needs the RAW body (HMAC over the exact bytes) and its own size cap.
app.use("/jobsearch/inbound/mail", express.raw({ type: () => true, limit: Number(process.env.INBOUND_MAIL_MAX_BYTES) > 0 ? Number(process.env.INBOUND_MAIL_MAX_BYTES) : "1mb" }), jobsearchBodyErrorHandler);
app.use("/jobsearch", express.json({ limit: "10mb" }), jobsearchBodyErrorHandler);
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
app.use("/jobsearch", jobsearchAuthRoutes);
app.use("/jobsearch", jobsearchProfileRoutes);
app.use("/jobsearch", jobsearchConsentRoutes);
app.use("/jobsearch", jobsearchSourcesRoutes);
app.use("/jobsearch", jobsearchMatchesRoutes);
app.use("/jobsearch", jobsearchApplicationsRoutes);
app.use("/jobsearch", jobsearchSubmissionsRoutes);
app.use("/jobsearch", jobsearchAdminRoutes);
app.use("/jobsearch", jobsearchInboxRoutes);
app.use("/jobsearch", jobsearchReportsRoutes);

// VITA web UI (static, strict CSP): GET /vita -> /vita/
mountVita(app);

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  return res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
