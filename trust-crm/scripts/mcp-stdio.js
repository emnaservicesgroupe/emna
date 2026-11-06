#!/usr/bin/env node
// MCP stdio launcher for assistants that start servers as local commands (Claude Desktop, Claude Code `mcp add`).
// It holds no data and no database access: it forwards tools/list and tools/call to the VITA HTTP endpoint POST {VITA_BASE_URL}/mcp using
// the personal access token in VITA_MCP_TOKEN, so the server enforces exactly the same authorisation, limits and audit as for HTTP clients.
//   VITA_BASE_URL   e.g. https://crm.example.com   (http:// only for localhost)
//   VITA_MCP_TOKEN  vita_pat_...                    (created in the staff console; never printed, never written anywhere)
// stdout carries ONLY MCP protocol messages; every diagnostic goes to stderr and never contains the token.
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const pkg = require("../package.json");

const PREFIX = "mcp-stdio: ";
let secret = "";

/** Message text with the token removed, truncated: safe to print. */
function safe(msg) {
  let t = String(msg === undefined || msg === null ? "" : msg);
  if (secret) t = t.split(secret).join("[token]");
  return t.replace(/vita_pat_[A-Za-z0-9_-]+/g, "[token]").replace(/[\r\n]+/g, " ").slice(0, 300);
}
function fail(message, code = 1) {
  process.stderr.write(`${PREFIX}${message}\n`);
  process.exit(code);
}

function readConfig(env) {
  const missing = ["VITA_BASE_URL", "VITA_MCP_TOKEN"].filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) fail(`missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Set VITA_BASE_URL (for example https://crm.example.com) and VITA_MCP_TOKEN (a vita_pat_ token created under Assistant access).`, 2);
  const token = String(env.VITA_MCP_TOKEN).trim();
  secret = token;
  if (!token.startsWith("vita_pat_")) fail("VITA_MCP_TOKEN is not a VITA personal access token (it must start with vita_pat_).", 2);
  let base;
  try {
    base = new URL(String(env.VITA_BASE_URL).trim());
  } catch {
    return fail("VITA_BASE_URL is not a valid URL (example: https://crm.example.com).", 2);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && local)) fail("VITA_BASE_URL must use https:// (http:// is accepted for localhost only), so the token never travels in clear text.", 2);
  return { token, url: new URL("mcp", base.href.endsWith("/") ? base.href : `${base.href}/`) };
}

async function main() {
  const { token, url } = readConfig(process.env);
  const client = new Client({ name: "vita-mcp-stdio", version: pkg.version });
  const upstream = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  try {
    await client.connect(upstream);
  } catch (err) {
    const status = err && (err.code || err.status);
    if (status === 401) fail("the VITA server refused the token (expired, revoked or not valid). Create a new one under Assistant access.");
    if (status === 404) fail("the VITA server answered 404: MCP is disabled there (MCP_ENABLED) or VITA_BASE_URL is wrong.");
    return fail(`cannot reach the VITA MCP endpoint (${safe(err && err.message)})`);
  }

  const info = client.getServerVersion() || { name: "vita-crm", version: pkg.version };
  const server = new Server({ name: info.name, version: info.version }, { capabilities: { tools: {} }, instructions: client.getInstructions() });
  server.setRequestHandler(ListToolsRequestSchema, (req) => client.listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, (req) => client.callTool(req.params));

  const stdio = new StdioServerTransport();
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([server.close(), client.close()]);
    process.exit(0);
  };
  stdio.onclose = stop;
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdin.on("end", stop);
  await server.connect(stdio);
}

main().catch((err) => fail(`unexpected error (${safe(err && err.message)})`));
