'use strict';
// Verifies the SMTP settings for real, then sends one test message. Usage:
//   MAIL_PROVIDER=smtp MAIL_SMTP_HOST=... MAIL_SMTP_USER=... MAIL_SMTP_PASSWORD=... MAIL_FROM='FIND WAY <no-reply@yourdomain>' \
//   node scripts/test-mail.js you@example.com
const { load } = require('../src/config');
const { createMailer } = require('../src/services/mailer');
(async () => {
  const to = process.argv[2];
  if (!to) { console.error('Usage: node scripts/test-mail.js <recipient>'); process.exit(2); }
  const config = load({ ...process.env, MAIL_PROVIDER: 'smtp' });
  const mailer = createMailer(config);
  await mailer.send({ to: '__noop__', subject: '', text: '' }).catch(() => {}); // surfaces "not configured" early
  if (mailer.verify) { await mailer.verify(); console.log('SMTP connection + authentication: OK'); }
  const r = await mailer.send({ to, subject: 'FIND WAY test message', text: 'If you can read this, FIND WAY can send e-mail through this account. (Accepted by the SMTP server; delivery is not guaranteed by this check.)' });
  console.log('Accepted by SMTP server, message id:', r.providerMessageId);
})().catch((e) => { console.error('FAILED:', e.code || '', e.message); process.exit(1); });
