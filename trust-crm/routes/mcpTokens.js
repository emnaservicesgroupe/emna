// Personal access token management for the MCP server (stage 7), mounted at /mcp-tokens with its own 2 kb JSON parser (app.js).
// A normal JWT of an ACTIVE staff account holding mcp:use (Admin, Manager, SuperAdmin); a PAT bearer is refused (401) by verifyToken, and
// Candidate / Employer / Agency are 403. Works even while MCP_ENABLED is false: every answer says {mcp_enabled} so the UI can explain.
//   POST   /        {name, days?}  -> 201 {id, secret, prefix, expires_at, mcp_enabled}   the secret appears HERE ONLY, once
//   GET    /                       -> {rows, mcp_enabled}  own tokens (Admin / SuperAdmin: everyone's, with owner_name); never a secret or hash
//   DELETE /:id                    -> {id, revoked, already_revoked, mcp_enabled}  own, or any for Admin / SuperAdmin; idempotent
const express = require("express");
const { requireStaff } = require("../middleware/staff");
const { checkPermission } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const { HttpError } = require("../modules/jobsearch/httpError");
const tokens = require("../modules/mcp/tokens");

const router = express.Router();
const mcpEnabled = () => String(process.env.MCP_ENABLED || "").toLowerCase() === "true";

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(requireStaff);
router.use(checkPermission("mcp:use"));

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
    if (!b) throw new HttpError(400, "A JSON object body is required");
    const out = await tokens.createToken(req.user, { name: b.name, days: b.days });
    return res.status(201).json({ ...out, mcp_enabled: mcpEnabled() });
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => res.json({ ...(await tokens.listTokens(req.user)), mcp_enabled: mcpEnabled() }))
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => res.json({ ...(await tokens.revokeToken(req.user, req.params.id)), mcp_enabled: mcpEnabled() }))
);

router.use(jobsearchErrorHandler);

module.exports = router;
