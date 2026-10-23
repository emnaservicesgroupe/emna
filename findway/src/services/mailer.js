'use strict';
// Mail providers. 'dev' accepts and keeps messages in memory (never claims delivery). 'smtp' is a
// placeholder until credentials exist; it refuses to send rather than pretending.
function createMailer(config) {
  const captured = [];
  if (config.mail.provider === 'smtp') {
    return {
      name: 'smtp',
      async send() { const e = new Error('SMTP provider is not configured (awaiting credentials)'); e.code = 'provider_not_configured'; throw e; },
      captured,
    };
  }
  return {
    name: 'dev',
    async send({ to, subject, text }) {
      if (config.devMailCapture) { captured.push({ to, subject, text, at: new Date().toISOString() }); if (captured.length > 200) captured.shift(); }
      return { providerMessageId: `dev-${Date.now()}-${captured.length}` };   // accepted by the dev provider only
    },
    captured,
  };
}
module.exports = { createMailer };
