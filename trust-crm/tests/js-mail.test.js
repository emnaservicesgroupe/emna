const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb } = require("./helpers/db");

process.env.NODE_ENV = "test";
delete process.env.MAIL_PROVIDER;
delete process.env.MAIL_SANDBOX_ALLOWLIST;

async function withDb(fn) {
  const { pool, cleanup } = await createTestDb();
  require("../db").setPool(pool);
  try {
    await fn(pool);
  } finally {
    await cleanup();
  }
}

test("requiring mail with empty env works; default provider is sandbox", async () => {
  const mail = require("../modules/jobsearch/mail");
  assert.equal(typeof mail.status, "function");
  assert.equal(typeof mail.send, "function");
  assert.equal(typeof mail.poll, "function");
  const s = await mail.status();
  assert.equal(s.status, "connected");
  assert.match(s.detail, /sandbox/i);
});

test("sandbox stores allow-listed outbound mail in js_sandbox_mail", () =>
  withDb(async (pool) => {
    const mail = require("../modules/jobsearch/mail");
    const r = await mail.send({ to: "a@test.invalid", subject: "Hi", text: "Body", headers: { "X-A": "1" } });
    assert.equal(r.accepted, true);
    assert.ok(r.providerMessageId);
    const rows = (await pool.query("SELECT * FROM js_sandbox_mail")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].to_addr, "a@test.invalid");
    assert.equal(rows[0].subject, "Hi");
    assert.equal(rows[0].body, "Body");
    const out = await mail.sandbox.listOutbound({ to: "a@test.invalid" });
    assert.equal(out.length, 1);
  }));

test("sandbox rejects recipients outside the allow-list and stores nothing", () =>
  withDb(async (pool) => {
    const mail = require("../modules/jobsearch/mail");
    const r = await mail.send({ to: "real.person@gmail.com", subject: "x", text: "y" });
    assert.equal(r.accepted, false);
    assert.equal(r.providerMessageId, null);
    const mixed = await mail.send({ to: ["ok@test.invalid", "bad@example.com"], subject: "x", text: "y" });
    assert.equal(mixed.accepted, false);
    assert.equal((await pool.query("SELECT count(*)::int n FROM js_sandbox_mail")).rows[0].n, 0);
  }));

test("allow-list is configurable and lookalike domains do not match", () =>
  withDb(async () => {
    const mail = require("../modules/jobsearch/mail");
    process.env.MAIL_SANDBOX_ALLOWLIST = "me@example.com, *@qa.example.org";
    try {
      assert.equal((await mail.send({ to: "me@example.com", subject: "s", text: "t" })).accepted, true);
      assert.equal((await mail.send({ to: "x@qa.example.org", subject: "s", text: "t" })).accepted, true);
      assert.equal((await mail.send({ to: "x@evilqa.example.org", subject: "s", text: "t" })).accepted, false);
      assert.equal((await mail.send({ to: "x@qa.example.org.evil.com", subject: "s", text: "t" })).accepted, false);
      assert.equal((await mail.send({ to: "a@test.invalid", subject: "s", text: "t" })).accepted, false);
    } finally {
      delete process.env.MAIL_SANDBOX_ALLOWLIST;
    }
  }));

test("tests can inject inbound mail and poll with a cursor", () =>
  withDb(async () => {
    const mail = require("../modules/jobsearch/mail");
    await mail.send({ to: "a@test.invalid", subject: "out", text: "t" });
    await mail.sandbox.injectInbound({ from: "emp@test.invalid", to: "vita@test.invalid", subject: "Re: job", text: "hello" });
    const first = await mail.poll(null);
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0].subject, "Re: job");
    assert.equal(first.messages[0].from, "emp@test.invalid");
    const again = await mail.poll(first.cursor);
    assert.equal(again.messages.length, 0);
    assert.equal(again.cursor, first.cursor);
    await mail.sandbox.injectInbound({ from: "emp@test.invalid", to: "vita@test.invalid", subject: "2", text: "x" });
    const next = await mail.poll(first.cursor);
    assert.equal(next.messages.length, 1);
  }));

test("imapSmtp is requires_setup with empty env, does not send, never throws at import", async () => {
  for (const k of Object.keys(process.env)) if (/^MAIL_(SMTP|IMAP)_/.test(k)) delete process.env[k];
  const imap = require("../modules/jobsearch/mail/imapSmtp");
  const s = await imap.status();
  assert.equal(s.status, "requires_setup");
  assert.match(s.detail, /MAIL_SMTP_HOST/);
  await assert.rejects(imap.send({ to: "a@test.invalid", subject: "s", text: "t" }), /requires_setup|not configured/i);
  await assert.rejects(imap.poll(null), /requires_setup|not configured/i);
});

test("MAIL_PROVIDER=imap_smtp selects imapSmtp; unknown value falls back to sandbox", async () => {
  const mail = require("../modules/jobsearch/mail");
  process.env.MAIL_PROVIDER = "imap_smtp";
  try {
    assert.equal((await mail.status()).status, "requires_setup");
    process.env.MAIL_PROVIDER = "bogus";
    assert.equal((await mail.status()).status, "connected");
  } finally {
    delete process.env.MAIL_PROVIDER;
  }
});

test("imapSmtp refuses to send unless MAIL_REAL_SEND=true", async () => {
  const imap = require("../modules/jobsearch/mail/imapSmtp");
  Object.assign(process.env, {
    MAIL_SMTP_HOST: "smtp.invalid", MAIL_SMTP_USER: "u", MAIL_SMTP_PASS: "p",
    MAIL_IMAP_HOST: "imap.invalid", MAIL_IMAP_USER: "u", MAIL_IMAP_PASS: "p",
  });
  delete process.env.MAIL_REAL_SEND;
  try {
    // Honest status (Task 13): inbound polling is not implemented, so a configured mailbox is not 'connected'.
    assert.equal((await imap.status()).status, "requires_setup");
    assert.match((await imap.status()).detail, /inbound polling not implemented/);
    const r = await imap.send({ to: "a@test.invalid", subject: "s", text: "t" });
    assert.equal(r.accepted, false);
  } finally {
    for (const k of Object.keys(process.env)) if (/^MAIL_(SMTP|IMAP)_/.test(k)) delete process.env[k];
  }
});

// ---------------------------------------------------------------- Task 18: SMTP needs only SMTP settings

const SMTP_KEYS = ["MAIL_FROM", "MAIL_SMTP_HOST", "MAIL_SMTP_PORT", "MAIL_SMTP_USER", "MAIL_SMTP_PASS", "MAIL_IMAP_HOST", "MAIL_IMAP_USER", "MAIL_IMAP_PASS", "MAIL_REAL_SEND", "INBOUND_MAIL_SECRET"];
async function withMailEnv(env, fn) {
  const saved = Object.fromEntries(SMTP_KEYS.map((k) => [k, process.env[k]]));
  for (const k of SMTP_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of SMTP_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Minimal local SMTP server (no TLS, no auth checks): records envelopes and DATA. */
async function fakeSmtp() {
  const net = require("net");
  const got = [];
  const server = net.createServer((sock) => {
    let buf = "";
    let inData = false;
    let cur = { from: null, to: [], data: "" };
    sock.write("220 fake.test ESMTP\r\n");
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            got.push(cur);
            cur = { from: null, to: [], data: "" };
            sock.write("250 2.0.0 queued as FAKE1\r\n");
          } else cur.data += `${line}\n`;
          continue;
        }
        const u = line.toUpperCase();
        if (u.startsWith("EHLO")) sock.write("250-fake.test\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (u.startsWith("HELO")) sock.write("250 fake.test\r\n");
        else if (u.startsWith("AUTH")) sock.write("235 2.7.0 ok\r\n");
        else if (u.startsWith("MAIL FROM")) { cur.from = line; sock.write("250 ok\r\n"); }
        else if (u.startsWith("RCPT TO")) { cur.to.push(line); sock.write("250 ok\r\n"); }
        else if (u === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (u === "QUIT") { sock.end("221 bye\r\n"); }
        else if (u === "RSET" || u === "NOOP") sock.write("250 ok\r\n");
        else sock.write("502 unknown\r\n");
      }
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, got, close: () => new Promise((r) => server.close(r)) };
}

test("Task 18 imapSmtp: real sending needs ONLY the SMTP settings + MAIL_REAL_SEND=true (no MAIL_IMAP_*)", async () => {
  const imap = require("../modules/jobsearch/mail/imapSmtp");
  const smtp = await fakeSmtp();
  try {
    await withMailEnv({ MAIL_SMTP_HOST: "127.0.0.1", MAIL_SMTP_PORT: String(smtp.port), MAIL_SMTP_USER: "vita", MAIL_SMTP_PASS: "pw-not-logged", MAIL_REAL_SEND: "true", MAIL_FROM: "applications@vita.test.invalid" }, async () => {
      const r = await imap.send({ to: "hr@employer.test.invalid", subject: "Application", text: "Hello" });
      assert.equal(r.accepted, true, JSON.stringify(r));
      assert.equal(smtp.got.length, 1);
      assert.match(smtp.got[0].to[0], /hr@employer\.test\.invalid/);
      assert.match(smtp.got[0].data, /Subject: Application/);
    });
    // MAIL_REAL_SEND not true: nothing reaches the server (sandbox default unchanged)
    await withMailEnv({ MAIL_SMTP_HOST: "127.0.0.1", MAIL_SMTP_PORT: String(smtp.port), MAIL_SMTP_USER: "vita", MAIL_SMTP_PASS: "pw" }, async () => {
      const r = await imap.send({ to: "hr@employer.test.invalid", subject: "x", text: "y" });
      assert.equal(r.accepted, false);
      assert.equal(smtp.got.length, 1);
    });
    // an SMTP setting missing -> requires_setup, whatever the IMAP settings
    await withMailEnv({ MAIL_SMTP_HOST: "127.0.0.1", MAIL_SMTP_USER: "vita", MAIL_IMAP_HOST: "imap.invalid", MAIL_IMAP_USER: "u", MAIL_IMAP_PASS: "p", MAIL_REAL_SEND: "true" }, async () => {
      await assert.rejects(imap.send({ to: "a@test.invalid", subject: "s", text: "t" }), (e) => e.code === "REQUIRES_SETUP" && /MAIL_SMTP_PASS/.test(e.message) && !/MAIL_IMAP/.test(e.message));
    });
  } finally {
    await smtp.close();
  }
});

test("Task 18 imapSmtp.status(): outbound 'connected' only with valid SMTP settings AND MAIL_REAL_SEND=true; inbound 'webhook' vs 'requires_setup'", async () => {
  const imap = require("../modules/jobsearch/mail/imapSmtp");
  const SMTP = { MAIL_SMTP_HOST: "smtp.example.test", MAIL_SMTP_USER: "vita", MAIL_SMTP_PASS: "secret-value" };
  const cases = [
    [{}, { status: "requires_setup", outbound: "not_configured", inbound: "requires_setup" }],
    [{ MAIL_IMAP_HOST: "imap.x", MAIL_IMAP_USER: "u", MAIL_IMAP_PASS: "p", MAIL_REAL_SEND: "true" }, { status: "requires_setup", outbound: "not_configured", inbound: "requires_setup" }],
    [{ ...SMTP }, { status: "requires_setup", outbound: "configured_send_disabled", inbound: "requires_setup" }],
    [{ ...SMTP, MAIL_REAL_SEND: "TRUE" }, { status: "requires_setup", outbound: "configured_send_disabled", inbound: "requires_setup" }],
    [{ ...SMTP, MAIL_REAL_SEND: "true" }, { status: "requires_setup", outbound: "connected", inbound: "requires_setup" }],
    [{ ...SMTP, MAIL_REAL_SEND: "true", INBOUND_MAIL_SECRET: "s" }, { status: "connected", outbound: "connected", inbound: "webhook" }],
    [{ ...SMTP, INBOUND_MAIL_SECRET: "s" }, { status: "requires_setup", outbound: "configured_send_disabled", inbound: "webhook" }],
    [{ ...SMTP, MAIL_SMTP_PORT: "abc", MAIL_REAL_SEND: "true" }, { status: "requires_setup", outbound: "not_configured", inbound: "requires_setup" }],
    [{ ...SMTP, MAIL_SMTP_PORT: "70000", MAIL_REAL_SEND: "true" }, { status: "requires_setup", outbound: "not_configured", inbound: "requires_setup" }],
    [{ ...SMTP, MAIL_SMTP_HOST: "bad host!", MAIL_REAL_SEND: "true" }, { status: "requires_setup", outbound: "not_configured", inbound: "requires_setup" }],
    [{ ...SMTP, MAIL_SMTP_PORT: "465", MAIL_REAL_SEND: "true", INBOUND_MAIL_SECRET: "s" }, { status: "connected", outbound: "connected", inbound: "webhook" }],
  ];
  for (const [env, want] of cases) {
    await withMailEnv(env, async () => {
      const s = await imap.status();
      assert.deepEqual({ status: s.status, outbound: s.outbound, inbound: s.inbound }, want, JSON.stringify(env));
      assert.match(s.detail, /inbound polling not implemented/, "IMAP polling is never claimed");
      assert.ok(!s.detail.includes("secret-value"), "never a secret in the status");
    });
  }
  await withMailEnv({ MAIL_SMTP_PORT: "abc" }, async () => assert.match((await imap.status()).detail, /MAIL_SMTP_PORT/));
});
