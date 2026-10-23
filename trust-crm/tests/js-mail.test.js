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
