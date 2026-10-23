// Scheduler administration (Task 12), mounted at /jobsearch after the other /jobsearch routers:
//   POST /scheduler/tick     jobsearch:admin; runs one scheduler tick now (under the advisory lock), returns its summary
//   GET  /scheduler/status   jobsearch:admin; last tick (js_module_state 'scheduler_last_tick'), module pause, per-source last runs
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { PERMISSIONS } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const { HttpError } = require("../modules/jobsearch/httpError");
const scheduler = require("../modules/jobsearch/scheduler");
const { logAudit } = require("../utils/audit");

const router = express.Router();
const db = () => require("../db");

function needAdmin(user) {
  const perms = (user && PERMISSIONS[user.role]) || [];
  if (!(perms.includes("*") || perms.includes("jobsearch:admin"))) throw new HttpError(403, "Administrator access required");
}

router.post("/scheduler/tick", verifyToken, asyncHandler(async (req, res) => {
  needAdmin(req.user);
  await db().query("INSERT INTO js_audit_events (actor, action, detail) VALUES ($1,'scheduler.manual_tick','{}'::jsonb)", [`user:${req.user.id}`]);
  const summary = await scheduler.guardedTick(new Date());
  await logAudit({ userId: req.user.id, action: "jobsearch.scheduler.tick", tableName: "js_module_state", newData: { skipped: summary.skipped || null, errors: (summary.errors || []).length } });
  res.json(summary);
}));

router.get("/scheduler/status", verifyToken, asyncHandler(async (req, res) => {
  needAdmin(req.user);
  res.json(await scheduler.status());
}));

router.use(jobsearchErrorHandler);

module.exports = router;
