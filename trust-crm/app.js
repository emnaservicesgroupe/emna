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
const jobsearchDirectoryRoutes = require("./routes/jobsearchDirectory");
const { jobsearchBodyErrorHandler } = require("./modules/jobsearch/errorHandler");
const publicRoutes = require("./routes/public");
const { mountVita } = require("./routes/vitaStatic");
const { trustProxySetting } = require("./utils/trustProxy");

const app = express();

// Opt-in (TRUST_PROXY): needed behind an HTTPS reverse proxy so per-IP rate limits see the client IP.
const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
if (trustProxy !== null) app.set("trust proxy", trustProxy);

app.use(cors());
// /jobsearch parses its own JSON first so parser errors (which carry the raw body,
// possibly an OTP) are answered without logging; the global parser then skips
// already-parsed requests. Non-jobsearch routes are unaffected.
// The inbound-mail webhook needs the RAW body (HMAC over the exact bytes) and its own size cap.
app.use("/jobsearch/inbound/mail", express.raw({ type: () => true, limit: Number(process.env.INBOUND_MAIL_MAX_BYTES) > 0 ? Number(process.env.INBOUND_MAIL_MAX_BYTES) : "1mb" }), jobsearchBodyErrorHandler);
app.use("/jobsearch", express.json({ limit: "10mb" }), jobsearchBodyErrorHandler);
// /public (unauthenticated website API) has a tight 16 KB cap and answers parser errors itself.
app.use("/public", express.json({ limit: "16kb" }), jobsearchBodyErrorHandler);
app.use(express.json({ limit: "10mb" }));

// Task 20: unauthenticated liveness/readiness probe for Docker and the reverse proxy. Answers only
// {ok:true} (200) or {ok:false} (503, database not answering within 2 s) - never versions, hosts or errors.
app.get("/healthz", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  let timer;
  try {
    await Promise.race([
      require("./db").query("SELECT 1"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 2000);
      }),
    ]);
    return res.json({ ok: true });
  } catch {
    return res.status(503).json({ ok: false });
  } finally {
    clearTimeout(timer);
  }
});

app.get("/", (_req, res) => {
  res.json({
    system: "EMNA Services CRM",
    status: "Running",
    company: "Emna Visa Services",
    mode: "Production API",
  });
});

app.use("/public", publicRoutes);
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
app.use("/jobsearch", jobsearchDirectoryRoutes);

// VITA web UI (static, strict CSP): GET /vita -> /vita/
mountVita(app);

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  return res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
