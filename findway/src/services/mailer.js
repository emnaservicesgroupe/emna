'use strict';
// Mail providers. 'dev' accepts and keeps messages in memory (development only; never claims delivery).
// 'smtp' sends through a real SMTP account (e.g. Hostinger). A successful SMTP hand-off is recorded as
// provider_accepted only; "delivered" needs a provider receipt, which SMTP does not give us.
const nodemailer = require('nodemailer');

function createMailer(config) {
  const captured = [];
  if (config.mail.provider === 'smtp') {
    const c = config.mail.smtp;
    const missing = ['host', 'user', 'password'].filter((k) => !c[k] && !(c.allowInsecure && k !== 'host'));
    if (missing.length) {
      return { name: 'smtp', captured, async send() { const e = new Error(`SMTP is not configured (missing: ${missing.join(', ')})`); e.code = 'provider_not_configured'; throw e; } };
    }
    const transport = nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.secure,
      ...(c.allowInsecure ? { ignoreTLS: true } : { requireTLS: !c.secure, tls: { minVersion: 'TLSv1.2' } }),
      ...(c.user ? { auth: { user: c.user, pass: c.password } } : {}),
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
    return {
      name: 'smtp', captured,
      verify: () => transport.verify(),
      async send({ to, subject, text }) {
        const info = await transport.sendMail({ from: config.mail.from, to, subject, text });
        if (!info.accepted || !info.accepted.length) { const e = new Error('SMTP server accepted no recipients'); e.code = 'rejected'; throw e; }
        return { providerMessageId: info.messageId };
      },
    };
  }
  return {
    name: 'dev', captured,
    async send({ to, subject, text }) {
      if (config.devMailCapture) { captured.push({ to, subject, text, at: new Date().toISOString() }); if (captured.length > 200) captured.shift(); }
      return { providerMessageId: `dev-${Date.now()}-${captured.length}` };
    },
  };
}
module.exports = { createMailer };
