'use strict';
// SMTP provider tested against a local SMTP server (no real mailbox, no real credentials).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const { createTestEnv, PW } = require('./helpers');

let smtp; let env; let broken; const inbox = [];
before(async () => {
  smtp = new SMTPServer({
    authOptional: true, disabledCommands: ['STARTTLS'], allowInsecureAuth: true,
    onData(stream, _session, cb) { simpleParser(stream).then((m) => { inbox.push(m); cb(); }, cb); },
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  const port = smtp.server.address().port;
  env = await createTestEnv({ config: { mail: { provider: 'smtp', from: 'FIND WAY <no-reply@findway.test>', smtp: { host: '127.0.0.1', port, secure: false, user: '', password: '', allowInsecure: true } } } });
  broken = await createTestEnv({ config: { mail: { provider: 'smtp', from: 'x@y.test', smtp: { host: '127.0.0.1', port: 1, secure: false, user: '', password: '', allowInsecure: true } } } });
});
after(async () => { await env.close(); await broken.close(); smtp.close(); });

test('OTP e-mail is really sent over SMTP, carries the code, and is recorded as provider_accepted (never "delivered")', async () => {
  const email = 'smtp.user@example.test';
  const r = await env.api('POST', '/api/auth/register', { body: { email, password: PW, full_name: 'Smtp User', role: 'candidate', accept_terms: true, locale: 'fr' } });
  assert.equal(r.status, 202);
  const m = inbox.find((x) => x.to.text.includes(email));
  assert.ok(m, 'message reached the SMTP server');
  assert.equal(m.from.value[0].address, 'no-reply@findway.test'); assert.equal(m.from.value[0].name, 'FIND WAY');
  assert.match(m.subject, /FIND WAY/); assert.match(m.text, /\b\d{6}\b/);
  assert.match(m.text, /code de vérification/i); // localised
  const row = await env.db.one('SELECT status, provider, provider_message_id, body_text FROM outbound_messages WHERE to_address=$1', [email]);
  assert.equal(row.status, 'provider_accepted'); assert.equal(row.provider, 'smtp'); assert.ok(row.provider_message_id);
  assert.match(row.body_text, /redacted/); // the code is never stored
  const code = m.text.match(/\b(\d{6})\b/)[1];
  assert.equal((await env.api('POST', '/api/auth/verify-email', { body: { email, code } })).status, 200); // the e-mailed code works
});

test('an unreachable mail server is recorded as failed and sign-up still succeeds (user can resend)', async () => {
  const email = 'down@example.test';
  const r = await broken.api('POST', '/api/auth/register', { body: { email, password: PW, full_name: 'Down User', role: 'candidate', accept_terms: true } });
  assert.equal(r.status, 202);
  const row = await broken.db.one('SELECT status, last_error FROM outbound_messages WHERE to_address=$1', [email]);
  assert.equal(row.status, 'failed'); assert.ok(row.last_error);
});

test('SMTP without credentials refuses to send and says why (no silent fake success)', async () => {
  const { createMailer } = require('../src/services/mailer');
  const { load } = require('../src/config');
  const m = createMailer(load({ NODE_ENV: 'production', APP_MASTER_KEY: Buffer.alloc(48, 1).toString('base64'), MAIL_PROVIDER: 'smtp' }));
  await assert.rejects(m.send({ to: 'a@b.test', subject: 's', text: 't' }), /not configured \(missing: host, user, password\)/);
});
