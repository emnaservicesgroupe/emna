// Task 20: production preflight (utils/preflight.js). checkEnv is pure; runPreflight is driven with injected
// env / exit / log / writable so no test touches process.env or exits.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkEnv, runPreflight, storageWritable } = require("../utils/preflight");

const crypto = require("crypto");
// realistic generated secrets (openssl rand -hex 32); a repeated character is now refused as low-entropy
const HEXES = { a: crypto.randomBytes(32).toString("hex"), b: crypto.randomBytes(32).toString("hex"), c: crypto.randomBytes(32).toString("hex"), d: crypto.randomBytes(32).toString("hex") };
const HEX = (c) => HEXES[c];
// A complete, safe production environment (sandbox mail) - every test starts from this and breaks one thing.
const GOOD = Object.freeze({
  NODE_ENV: "production",
  JWT_SECRET: HEX("a"),
  STORAGE_URL_SECRET: HEX("b"),
  DB_HOST: "db",
  DB_USER: "vita",
  DB_PASSWORD: HEX("c"),
  DB_NAME: "vita",
  DB_PORT: "5432",
  TRUST_PROXY: "1",
  MAIL_PROVIDER: "sandbox",
  MAIL_REAL_SEND: "false",
  ALLOW_UNSCANNED_ATTACHMENTS: "true",
  INBOUND_AUTH_REQUIRED: "true",
});
const ok = () => true;
const check = (over = {}, deps = { storageWritable: ok }) => {
  const env = { ...GOOD, ...over };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete env[k];
  return checkEnv(env, deps);
};
const has = (list, re) => list.some((m) => re.test(m));
const SECRET_VALUES = [HEX("a"), HEX("b"), HEX("c"), "S3cr3t-smtp-pass", "short-secret", "replace_with_secure_random_secret"];
const noValues = (r) => {
  const text = [...r.problems, ...r.warnings].join("\n");
  for (const v of SECRET_VALUES) assert.ok(!text.includes(v), `a value leaked: ${v.slice(0, 8)}...`);
};

test("preflight: the safe production template passes with warnings only (sandbox, no ClamAV, scheduler/workers state)", () => {
  const r = check();
  assert.deepEqual(r.problems, []);
  assert.ok(has(r.warnings, /SANDBOX MODE: no real mail is sent/));
  assert.ok(has(r.warnings, /No malware scanner/));
  assert.ok(has(r.warnings, /scheduler is on/));
  assert.ok(has(r.warnings, /Queue workers are on/));
  assert.ok(has(r.warnings, /INBOUND_MAIL_SECRET is not set: the inbound mail webhook is disabled \(503\)/), "the webhook 503s without a secret: warning only");
  const off = check({ JOBSEARCH_SCHEDULER: "off", JOBSEARCH_WORKERS: "OFF" });
  assert.ok(has(off.warnings, /scheduler is OFF/));
  assert.ok(has(off.warnings, /workers are OFF/));
  noValues(r);
});

test("preflight: JWT_SECRET missing, short, or a placeholder is refused", () => {
  assert.ok(has(check({ JWT_SECRET: undefined }).problems, /^JWT_SECRET is not set/));
  assert.ok(has(check({ JWT_SECRET: "  " }).problems, /^JWT_SECRET is not set/));
  assert.ok(has(check({ JWT_SECRET: "short-secret" }).problems, /^JWT_SECRET is too short \(at least 32/));
  assert.ok(has(check({ JWT_SECRET: HEX("a").slice(0, 31) }).problems, /^JWT_SECRET is too short/));
  assert.ok(!has(check({ JWT_SECRET: HEX("a").slice(0, 32) }).problems, /JWT_SECRET/));
  for (const ph of ["replace_with_secure_random_secret", "please_change_this_secret_value_now_123456", "CHANGEME-CHANGEME-CHANGEME-CHANGEME", "your_secret_your_secret_your_secret_x"]) {
    const r = check({ JWT_SECRET: ph });
    assert.ok(has(r.problems, /^JWT_SECRET still holds a placeholder/), ph);
    noValues(r);
  }
});

test("preflight (fix round): low-entropy secrets are refused - one repeated character, < 8 distinct characters, repeated short units, keyboard/alphabet sequences", () => {
  const low = ["a".repeat(64), "ab".repeat(32), "abcdabcd".repeat(8), "1234567".repeat(10), "abcdefghijklmnopqrstuvwxyz0123456789", "0123456789abcdef0123456789abcdef", "zyxwvutsrqponmlkjihgfedcba9876543210"];
  for (const v of low) {
    for (const key of ["JWT_SECRET", "STORAGE_URL_SECRET", "JOBSEARCH_REPLY_SECRET"]) {
      const r = check({ [key]: v });
      assert.ok(has(r.problems, new RegExp(`^${key} looks too predictable`)), `${key}=${v.slice(0, 12)}...`);
      noValues(r);
    }
  }
  assert.ok(has(check({ INBOUND_MAIL_SECRET: "q".repeat(40) }).problems, /^INBOUND_MAIL_SECRET looks too predictable/));
  for (let i = 0; i < 20; i++) assert.deepEqual(check({ JWT_SECRET: crypto.randomBytes(32).toString("hex") }).problems, [], "random hex always passes");
  assert.deepEqual(check({ JWT_SECRET: crypto.randomBytes(30).toString("base64url") }).problems, []);
});

test("preflight (fix round): MAIL_REAL_SEND uses the app's exact rule (only \"true\"); near-misses warn that real sending stays off", () => {
  const { realSendEnabled } = require("../utils/flags");
  for (const v of ["TRUE", "True", " true", "true ", "yes", "1", "on"]) {
    assert.equal(realSendEnabled({ MAIL_REAL_SEND: v }), false, v);
    const r = check({ MAIL_REAL_SEND: v });
    assert.ok(!has(r.problems, /MAIL_REAL_SEND=true needs/), `${v} is not real sending`);
    assert.ok(has(r.warnings, /MAIL_REAL_SEND is set but not exactly "true": real sending stays OFF/), v);
  }
  assert.equal(realSendEnabled({ MAIL_REAL_SEND: "true" }), true);
  assert.ok(has(check({ MAIL_REAL_SEND: "true" }).problems, /MAIL_REAL_SEND=true needs MAIL_PROVIDER=imap_smtp/));
});

test("preflight (fix round): DB_USER=postgres (a superuser) is warned; runPreflight can skip warnings (db-init prints them only once, server.js does)", () => {
  assert.ok(has(check({ DB_USER: "postgres" }).warnings, /DB_USER is "postgres"/));
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  runPreflight({ env: { ...GOOD }, exit: () => {}, log, writable: ok, printWarnings: false });
  assert.deepEqual(lines, []);
  const db = fs.readFileSync(path.join(__dirname, "..", "scripts", "db-init.js"), "utf8");
  assert.match(db, /runPreflight\(\{ printWarnings: false \}\)/);
});

test("preflight: STORAGE_URL_SECRET missing/short/placeholder; must differ from JWT_SECRET; optional JOBSEARCH_REPLY_SECRET validated when set", () => {
  assert.ok(has(check({ STORAGE_URL_SECRET: undefined }).problems, /^STORAGE_URL_SECRET is not set/));
  assert.ok(has(check({ STORAGE_URL_SECRET: "x".repeat(10) }).problems, /^STORAGE_URL_SECRET is too short/));
  assert.ok(has(check({ STORAGE_URL_SECRET: "replace_with_" + HEX("d") }).problems, /^STORAGE_URL_SECRET still holds a placeholder/));
  assert.ok(has(check({ STORAGE_URL_SECRET: HEX("a") }).problems, /must be different/));
  assert.deepEqual(check({ JOBSEARCH_REPLY_SECRET: undefined }).problems, []);
  assert.ok(has(check({ JOBSEARCH_REPLY_SECRET: "tiny" }).problems, /^JOBSEARCH_REPLY_SECRET is too short/));
});

test("preflight: database settings - DB_* all required unless DATABASE_URL; invalid URL / port; TEST_DATABASE_URL refused; weak DB password warned", () => {
  const r = check({ DB_HOST: undefined, DB_PASSWORD: "" });
  assert.ok(has(r.problems, /^Database settings missing: DB_HOST, DB_PASSWORD \(or set DATABASE_URL\)/));
  assert.deepEqual(check({ DB_HOST: undefined, DB_USER: undefined, DB_PASSWORD: undefined, DB_NAME: undefined, DATABASE_URL: "postgres://u:p@db:5432/vita" }).problems, []);
  assert.ok(has(check({ DATABASE_URL: "mysql://x" }).problems, /DATABASE_URL is not a valid postgres/));
  assert.ok(has(check({ DATABASE_URL: "not a url" }).problems, /DATABASE_URL is not a valid postgres/));
  assert.ok(has(check({ DB_PORT: "99999" }).problems, /^DB_PORT must be a port number/));
  assert.ok(has(check({ TEST_DATABASE_URL: "postgres://x@y/z" }).problems, /^TEST_DATABASE_URL is set/));
  assert.ok(has(check({ DB_PASSWORD: "postgres" }).warnings, /DB_PASSWORD is a default/));
  assert.ok(has(check({ PORT: "abc" }).problems, /^PORT must be a port number/));
});

test("preflight: INBOUND_MAIL_SECRET unset is only a warning (webhook 503s); set but short is refused; risky inbound switches warned", () => {
  assert.deepEqual(check({ INBOUND_MAIL_SECRET: undefined }).problems, []);
  assert.ok(has(check({ INBOUND_MAIL_SECRET: "abc" }).problems, /^INBOUND_MAIL_SECRET is too short \(at least 16/));
  const r = check({ INBOUND_MAIL_SECRET: HEX("d") });
  assert.deepEqual(r.problems, []);
  assert.ok(!has(r.warnings, /INBOUND_MAIL_SECRET/));
  assert.ok(has(check({ INBOUND_AUTH_REQUIRED: "false" }).warnings, /INBOUND_AUTH_REQUIRED=false/));
  assert.ok(has(check({ INBOUND_AUTO_ACK_EVIDENCE: "true" }).warnings, /INBOUND_AUTO_ACK_EVIDENCE=true is risk-accepting/));
});

test("preflight: MAIL_REAL_SEND=true needs MAIL_PROVIDER=imap_smtp and complete SMTP + MAIL_FROM settings", () => {
  const sandbox = check({ MAIL_REAL_SEND: "true", ALLOW_UNSCANNED_ATTACHMENTS: "false" });
  assert.ok(has(sandbox.problems, /^MAIL_REAL_SEND=true needs MAIL_PROVIDER=imap_smtp/));
  const bare = check({ MAIL_REAL_SEND: "true", MAIL_PROVIDER: "imap_smtp", ALLOW_UNSCANNED_ATTACHMENTS: "false" });
  for (const k of ["MAIL_SMTP_HOST", "MAIL_SMTP_USER", "MAIL_SMTP_PASS", "MAIL_FROM"]) assert.ok(has(bare.problems, new RegExp(`^${k} is not set`)), k);
  const SMTP = { MAIL_REAL_SEND: "true", MAIL_PROVIDER: "imap_smtp", MAIL_SMTP_HOST: "smtp.hostinger.com", MAIL_SMTP_USER: "jobs@agency.example", MAIL_SMTP_PASS: "S3cr3t-smtp-pass", MAIL_FROM: "jobs@agency.example", ALLOW_UNSCANNED_ATTACHMENTS: "false" };
  const good = check(SMTP);
  assert.deepEqual(good.problems, []);
  assert.ok(!has(good.warnings, /SANDBOX/));
  noValues(good);
  assert.ok(has(check({ ...SMTP, MAIL_FROM: "Jobs <jobs@agency.example>" }).problems, /^MAIL_FROM must be a plain address/));
  assert.ok(has(check({ ...SMTP, MAIL_REPLY_TO: "a@b.example, c@d.example" }).problems, /^MAIL_REPLY_TO must be a plain address/));
  assert.ok(has(check({ ...SMTP, MAIL_SMTP_PORT: "70000" }).problems, /^MAIL_SMTP_PORT must be a port number/));
  assert.ok(has(check({ MAIL_PROVIDER: "imap_smtp" }).warnings, /MAIL_REAL_SEND is not true: no real mail is sent/));
  assert.ok(has(check({ MAIL_FROM: "x@y.example\r\nBcc: z@evil.example" }).problems, /^MAIL_FROM must be a plain address/), "an invalid configured MAIL_FROM is refused in sandbox too");
  assert.deepEqual(check({ MAIL_FROM: undefined }).problems, [], "sandbox: MAIL_FROM may be unset");
});

test("preflight: real sending + ALLOW_UNSCANNED_ATTACHMENTS=true without ClamAV is refused; with ClamAV or with the flag off it passes", () => {
  const SMTP = { MAIL_REAL_SEND: "true", MAIL_PROVIDER: "imap_smtp", MAIL_SMTP_HOST: "smtp.hostinger.com", MAIL_SMTP_USER: "u", MAIL_SMTP_PASS: "p", MAIL_FROM: "jobs@agency.example" };
  assert.ok(has(check({ ...SMTP, ALLOW_UNSCANNED_ATTACHMENTS: "true" }).problems, /ALLOW_UNSCANNED_ATTACHMENTS=true and no malware scanner/));
  assert.deepEqual(check({ ...SMTP, ALLOW_UNSCANNED_ATTACHMENTS: "true", CLAMAV_HOST: "clamav" }).problems, []);
  assert.deepEqual(check({ ...SMTP, ALLOW_UNSCANNED_ATTACHMENTS: "false" }).problems, []);
  assert.ok(has(check({ CLAMAV_HOST: "clamav", CLAMAV_PORT: "x" }).problems, /^CLAMAV_PORT must be a port number/));
  assert.ok(!has(check({ CLAMAV_HOST: "clamav" }).warnings, /No malware scanner/));
});

test("preflight: TRUST_PROXY invalid (true/yes/*) refused; unset warned; hop count / list accepted", () => {
  for (const bad of ["true", "YES", "*", "on"]) assert.ok(has(check({ TRUST_PROXY: bad }).problems, /^TRUST_PROXY is invalid/), bad);
  assert.ok(has(check({ TRUST_PROXY: undefined }).warnings, /TRUST_PROXY is not set/));
  for (const good of ["1", "2", "loopback", "loopback,10.0.0.0/8"]) assert.deepEqual(check({ TRUST_PROXY: good }).problems, [], good);
});

test("preflight: STORAGE_DIR not writable is refused (checker injected); the real checker creates the directory and removes its probe", () => {
  const r = check({ STORAGE_DIR: "/data/storage" }, { storageWritable: (d) => (d === "/data/storage" ? "EACCES" : true) });
  assert.ok(has(r.problems, /^STORAGE_DIR is not writable \(EACCES\)/));
  assert.ok(has(check({}, { storageWritable: () => false }).problems, /^STORAGE_DIR is not writable:/));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vita-preflight-"));
  try {
    const dir = path.join(tmp, "nested", "storage");
    assert.equal(storageWritable(dir), true);
    assert.deepEqual(fs.readdirSync(dir), [], "probe file removed");
    const file = path.join(tmp, "a-file");
    fs.writeFileSync(file, "x");
    assert.notEqual(storageWritable(path.join(file, "sub")), true, "a path under a file is not writable");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("preflight: ALL problems are collected at once and no value is ever printed", () => {
  const r = check({ JWT_SECRET: "replace_with_secure_random_secret", STORAGE_URL_SECRET: undefined, DB_NAME: undefined, TRUST_PROXY: "true", MAIL_REAL_SEND: "true" }, { storageWritable: () => "EROFS" });
  assert.ok(r.problems.length >= 6, JSON.stringify(r.problems));
  for (const re of [/^JWT_SECRET/, /^STORAGE_URL_SECRET/, /^Database settings missing: DB_NAME/, /^TRUST_PROXY/, /^MAIL_REAL_SEND=true needs/, /^STORAGE_DIR/]) assert.ok(has(r.problems, re), String(re));
  noValues(r);
});

test("runPreflight: only in production; exits 1 with one message listing every problem; prints warnings and continues when clean", () => {
  const calls = { exit: [], error: [], log: [] };
  const log = { error: (m) => calls.error.push(m), log: (m) => calls.log.push(m) };
  const exit = (c) => calls.exit.push(c);
  assert.equal(runPreflight({ env: { NODE_ENV: "development" }, exit, log, writable: ok }), null);
  assert.equal(runPreflight({ env: {}, exit, log, writable: ok }), null);
  assert.deepEqual(calls, { exit: [], error: [], log: [] });

  const bad = runPreflight({ env: { NODE_ENV: "production", JWT_SECRET: "short-secret" }, exit, log, writable: ok });
  assert.deepEqual(calls.exit, [1]);
  assert.equal(calls.error.length, 1);
  const msg = calls.error[0];
  assert.match(msg, /refusing to start \(NODE_ENV=production\) - \d+ problem\(s\)/);
  for (const p of bad.problems) assert.ok(msg.includes(p), p);
  assert.ok(!msg.includes("short-secret"));

  calls.exit.length = 0;
  const good = runPreflight({ env: { ...GOOD }, exit, log, writable: ok });
  assert.deepEqual(good.problems, []);
  assert.deepEqual(calls.exit, []);
  assert.match(calls.log.join("\n"), /VITA preflight warnings:[\s\S]*SANDBOX MODE/);
});

test("server.js runs the preflight before anything else; app.js never does", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const lines = server.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
  assert.match(lines[0], /require\("dotenv"\)\.config\(\)/);
  assert.match(lines[1], /require\("\.\/utils\/preflight"\)\.runPreflight\(\)/);
  assert.ok(!fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").includes("preflight"));
});

test("preflight (review round 1): MCP_ENABLED=true without TRUST_PROXY gets a specific warning; with TRUST_PROXY or MCP off it does not", () => {
  assert.ok(has(check({ MCP_ENABLED: "true", TRUST_PROXY: undefined }).warnings, /MCP_ENABLED=true but TRUST_PROXY is not set/));
  assert.ok(!has(check({ MCP_ENABLED: "true", TRUST_PROXY: "1" }).warnings, /MCP_ENABLED=true but TRUST_PROXY/));
  assert.ok(!has(check({ MCP_ENABLED: undefined, TRUST_PROXY: undefined }).warnings, /MCP_ENABLED=true but TRUST_PROXY/));
  assert.ok(!has(check({ MCP_ENABLED: "false", TRUST_PROXY: undefined }).warnings, /MCP_ENABLED=true but TRUST_PROXY/));
  assert.deepEqual(check({ MCP_ENABLED: "true", TRUST_PROXY: undefined }).problems, [], "a warning, not a refusal to start");
});
