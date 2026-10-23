// Task 20: unauthenticated liveness endpoint GET /healthz and graceful SIGTERM shutdown (utils/shutdown.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

let ctx;
let server;
let base;

test.before(async () => {
  ctx = await createTestDb();
  const app = loadApp(ctx.pool);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await ctx.cleanup();
});

test("GET /healthz: no auth, exactly {ok:true}, no-store, no system/DB details", async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { ok: true });
  assert.doesNotMatch(text, /postgres|version|db|host|secret|env/i);
  assert.equal((await fetch(`${base}/healthz`, { method: "POST" })).status, 404, "GET only");
});

test("GET /healthz: 503 {ok:false} when the database does not answer (no error text leaked)", async () => {
  const db = require("../db");
  const dead = new Pool({ host: "127.0.0.1", port: 1, user: "x", password: "y", database: "z", connectionTimeoutMillis: 500 });
  const prev = db.setPool(dead);
  try {
    const r = await fetch(`${base}/healthz`);
    assert.equal(r.status, 503);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { ok: false });
  } finally {
    db.setPool(prev);
    await dead.end().catch(() => {});
  }
});

const { createShutdown } = require("../utils/shutdown");

function fakeLog() {
  const lines = [];
  return { lines, log: (m) => lines.push(`log:${m}`), error: (m) => lines.push(`error:${m}`) };
}

test("shutdown: stops timers first, closes the HTTP server, waits for idle work, closes the DB pool, exits 0; second signal ignored", async () => {
  const order = [];
  const srv = http.createServer((_q, s) => s.end("ok"));
  await new Promise((r) => srv.listen(0, r));
  let busy = true;
  setTimeout(() => (busy = false), 150);
  const exits = [];
  const log = fakeLog();
  const shutdown = createShutdown({
    server: srv,
    stop: [() => order.push("scheduler"), () => order.push("alerts"), () => order.push("sse")],
    isIdle: () => !busy,
    closeDb: async () => order.push(`db(busy=${busy})`),
    exit: (c) => exits.push(c),
    log,
    timeoutMs: 5000,
  });
  const p = shutdown("SIGTERM");
  shutdown("SIGTERM");
  await p;
  assert.deepEqual(order, ["scheduler", "alerts", "sse", "db(busy=false)"], "db closed only after the running work finished");
  assert.deepEqual(exits, [0]);
  assert.equal(srv.listening, false);
  assert.ok(log.lines.some((l) => /SIGTERM received/.test(l)));
});

test("shutdown: a step that throws does not stop the others; a hang is cut by the timeout (exit 1)", async () => {
  const srv = http.createServer((_q, s) => s.end("ok"));
  await new Promise((r) => srv.listen(0, r));
  const exits = [];
  const order = [];
  const shutdown = createShutdown({
    server: srv,
    stop: [() => { throw new Error("boom"); }, () => order.push("second")],
    closeDb: () => new Promise(() => {}), // never resolves
    exit: (c) => exits.push(c),
    log: fakeLog(),
    timeoutMs: 200,
  });
  await shutdown("SIGINT");
  assert.deepEqual(order, ["second"]);
  assert.deepEqual(exits, [1]);
  await new Promise((r) => srv.close(() => r()));
});

test("server.js wires graceful shutdown on SIGTERM and SIGINT with the scheduler, alert job, SSE hub and DB pool", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /createShutdown\(/);
  assert.match(src, /process\.on\("SIGTERM"/);
  assert.match(src, /process\.on\("SIGINT"/);
  assert.match(src, /stopJobSearchScheduler/);
  assert.match(src, /eventsHub"\)\.shutdown|eventsHub\.shutdown/);
  assert.match(src, /db\.end\(\)|require\("\.\/db"\)\.end\(\)/);
  const alerts = require("../jobs/alertScheduler");
  assert.equal(typeof alerts.startAlertScheduler, "function");
});

const { spawn } = require("child_process");
const os = require("os");

function runServer(env, { untilLog, signalAfterLog } = {}) {
  // cwd = an empty temp dir: dotenv finds no .env, so only `env` applies
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vita-server-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => {
    out += d;
    if (signalAfterLog && out.includes(signalAfterLog) && !child.signalled) {
      child.signalled = true;
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (d) => (out += d));
  return new Promise((resolve) => {
    const t = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("exit", (code, signal) => {
      clearTimeout(t);
      fs.rmSync(cwd, { recursive: true, force: true });
      resolve({ code, signal, out });
    });
  });
}

test("server.js (child process): NODE_ENV=production with unsafe settings refuses to start, exit 1, every problem listed, no value printed", async () => {
  const r = await runServer({ NODE_ENV: "production", JWT_SECRET: "replace_with_secure_random_secret", TRUST_PROXY: "true" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /refusing to start/);
  for (const re of [/JWT_SECRET still holds a placeholder/, /STORAGE_URL_SECRET is not set/, /Database settings missing/, /TRUST_PROXY is invalid/]) assert.match(r.out, re);
  assert.ok(!r.out.includes("replace_with_secure_random_secret"));
  assert.doesNotMatch(r.out, /running on port/);
});

test("server.js (child process): a clean production config starts, then SIGTERM shuts down gracefully (exit 0)", async () => {
  const u = new URL(process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/trustcrm_test");
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "vita-storage-"));
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = String(probe.address().port);
  await new Promise((r) => probe.close(r));
  try {
    const r = await runServer(
      {
        NODE_ENV: "production",
        PORT: port,
        JWT_SECRET: "a".repeat(64),
        STORAGE_URL_SECRET: "b".repeat(64),
        DB_HOST: u.hostname,
        DB_PORT: u.port || "5432",
        DB_USER: decodeURIComponent(u.username),
        DB_PASSWORD: decodeURIComponent(u.password) || "unused-password",
        DB_NAME: u.pathname.slice(1),
        TRUST_PROXY: "1",
        STORAGE_DIR: storage,
        JOBSEARCH_SCHEDULER: "off",
        JOBSEARCH_WORKERS: "off",
      },
      { signalAfterLog: "running on port" }
    );
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /SANDBOX MODE/);
    assert.match(r.out, /SIGTERM received: shutting down gracefully/);
    assert.match(r.out, /shutdown complete/);
    assert.ok(!r.out.includes("a".repeat(64)));
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});
