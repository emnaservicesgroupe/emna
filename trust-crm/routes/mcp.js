// The read-only MCP endpoint (stage 7), mounted at /mcp BEFORE the global JSON parser (app.js) because it reads its own capped body.
//   POST /mcp   Streamable HTTP, stateless: one JSON-RPC message per request, a fresh McpServer + transport each time, JSON response.
//   any other method -> 405 {error} + Allow: POST (also while MCP is disabled, so the answer never depends on configuration).
// Order of the gates for POST (each refusal is generic and leaks nothing):
//   MCP_ENABLED !== true (read on every request) -> 404 | bearer is not a valid, live vita_pat_ token of an active user who still holds
//   mcp:use -> 401 (a normal JWT is a 401 too; the failure is audited at most once per minute per IP hash, never with the token) |
//   per-token rate limit (MCP_RATE_PER_MIN, default 60, sliding minute, in memory: see modules/mcp/limits.js) -> 429 + Retry-After |
//   global concurrency cap (MCP_MAX_CONCURRENT, default 8) -> 503 | body > 64 KB -> 413, not JSON / a batch -> 400 |
//   overall deadline (MCP_REQUEST_TIMEOUT_MS, default 15000) -> 504.
// Every tools/call writes ONE audit row (action MCP_CALL): user, token id, tool, keyed digest of the arguments, row count, outcome
// (ok | error | denied), duration. Never argument values, never data, never the token.
const express = require("express");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { authenticateRequest } = require("../modules/mcp/auth");
const { ipHash } = require("../modules/mcp/tokens");
const { createServer, argsDigest } = require("../modules/mcp/server");
const { TOOLS } = require("../modules/mcp/tools");
const { createRateLimiter, createFailureThrottle, intEnv } = require("../modules/mcp/limits");
const { logAudit } = require("../utils/audit");

const BODY_LIMIT = 64 * 1024;
const router = express.Router();
const limiter = createRateLimiter();
const failures = createFailureThrottle();
const active = new Set(); // in-flight exchanges ({ abort() }), for graceful shutdown
let inflight = 0;
let closing = false;
let testTools = null;

const enabled = () => String(process.env.MCP_ENABLED || "").toLowerCase() === "true";
const KNOWN_TOOLS = () => new Set((testTools || TOOLS).map((t) => t.name));
const log = (msg, err) => console.error(`mcp: ${msg}`, err && err.name, err && err.code); // never the message: it could echo user input

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const methodNotAllowed = (_req, res) => res.set("Allow", "POST").status(405).json({ error: "Method not allowed" });

async function auditFailedAuth(req) {
  const h = ipHash(req.ip);
  if (!failures.shouldRecord(h)) return;
  try {
    await logAudit({ userId: null, action: "MCP_AUTH_FAILED", tableName: "mcp", newData: { ip_hash: h ? h.slice(0, 16) : null } });
  } catch (err) {
    log("failed-auth audit not written", err);
  }
}

async function gate(req, res, next) {
  if (!enabled()) return res.status(404).json({ error: "MCP is disabled" });
  if (closing) return res.status(503).json({ error: "Server is shutting down" });
  const auth = await authenticateRequest(req, { ip: req.ip });
  if (!auth) {
    auditFailedAuth(req);
    return res.set("WWW-Authenticate", "Bearer").status(401).json({ error: "Unauthorized" });
  }
  const limit = intEnv("MCP_RATE_PER_MIN", 60, 1, 100000);
  const rate = limiter.hit(auth.token.id, limit);
  if (!rate.ok) return res.set("Retry-After", String(rate.retryAfterSec)).status(429).json({ error: "Rate limit exceeded" });
  if (inflight >= intEnv("MCP_MAX_CONCURRENT", 8, 1, 1000)) return res.set("Retry-After", "1").status(503).json({ error: "Server busy" });
  req.mcp = { auth, started: Date.now() };
  return next();
}

// Everything below runs while a concurrency slot is held; it is released exactly once when the response is finished or aborted.
function hold(req, res, next) {
  inflight += 1;
  const ex = {
    abort() {
      if (!res.headersSent) res.status(503).json({ error: "Server is shutting down" });
      else res.destroy();
    },
  };
  active.add(ex);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inflight -= 1;
    active.delete(ex);
  };
  res.once("close", release);
  const timer = setTimeout(() => {
    req.mcp.timedOut = true;
    if (!res.headersSent) res.status(504).json({ error: "Request timed out" });
    else res.destroy();
  }, intEnv("MCP_REQUEST_TIMEOUT_MS", 15000, 50, 120000));
  res.once("close", () => clearTimeout(timer));
  next();
}

const rawBody = express.raw({ type: () => true, limit: BODY_LIMIT });

function parseBody(req, res, next) {
  let msg;
  try {
    msg = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "");
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  if (!msg || typeof msg !== "object") return res.status(400).json({ error: "Invalid JSON-RPC message" });
  if (Array.isArray(msg)) return res.status(400).json({ error: "Batch requests are not supported" });
  req.mcp.message = msg;
  return next();
}

async function audit(req, rec) {
  const a = req.mcp.auth;
  await logAudit({
    userId: a.user.id,
    action: "MCP_CALL",
    tableName: "mcp",
    recordId: a.token.id,
    newData: { token_id: a.token.id, tool: rec.tool, args_digest: rec.args_digest, rows: rec.rows, outcome: rec.outcome, duration_ms: rec.duration_ms },
  });
}

async function handle(req, res) {
  const { auth, message } = req.mcp;
  const isCall = message.method === "tools/call";
  let handled = false;
  const mcp = createServer(auth.user, {
    tools: testTools || TOOLS,
    onCall: async (rec) => {
      handled = true;
      await audit(req, rec);
    },
  });
  // The SDK refuses a call before our handler (unknown tool, invalid arguments, malformed request), or the deadline passes: still one audit row.
  res.once("close", () => {
    mcp.close().catch(() => {});
    if (!isCall || handled) return;
    const p = message.params && typeof message.params === "object" ? message.params : {};
    const tool = typeof p.name === "string" && KNOWN_TOOLS().has(p.name) ? p.name : "(unknown)";
    audit(req, { tool, args_digest: argsDigest(p.arguments), rows: null, outcome: "error", duration_ms: Date.now() - req.mcp.started }).catch((err) => log("call audit not written", err));
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp.connect(transport);
  try {
    await transport.handleRequest(req, res, message);
  } catch (err) {
    if (!req.mcp.timedOut && !res.headersSent) throw err;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.route("/").post(wrap(gate), hold, rawBody, parseBody, wrap(handle)).all(methodNotAllowed);

router.use((_req, res) => res.status(404).json({ error: "Not found" }));

// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => {
  if (res.headersSent) return res.destroy();
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Request body too large" });
  if (err && typeof err.type === "string" && err.type.startsWith("encoding.")) return res.status(415).json({ error: "Unsupported request encoding" });
  if (err && typeof err.type === "string" && err.status >= 400 && err.status < 500) return res.status(400).json({ error: "Invalid request body" });
  log("request failed", err);
  return res.status(500).json({ error: "Internal server error" });
});

/** Graceful shutdown: refuse new calls and cut the in-flight ones (utils/shutdown.js stop step). */
router.shutdown = () => {
  closing = true;
  for (const ex of [...active]) ex.abort();
};

/** Test hooks (NODE_ENV=test only): inject a tool catalogue, reset the in-memory counters. */
router.__test = {
  setTools(tools) {
    if (process.env.NODE_ENV !== "test") throw new Error("test hook");
    testTools = tools;
  },
  reset() {
    if (process.env.NODE_ENV !== "test") throw new Error("test hook");
    testTools = null;
    closing = false;
    limiter.reset();
    failures.reset();
  },
  inflight: () => inflight,
};

module.exports = router;
