'use strict';
// Transactional email with honest states. A message is 'queued' when stored, 'provider_accepted' only when the
// provider call returns, and never 'delivered' without a provider receipt (no receipt channel exists yet).
const { render } = require('./templates');

async function sendTransactional(ctx, { to, userId = null, template, locale = 'en', params = {}, redactBody = false }) {
  const { subject, text } = render(template, locale, params);
  const row = await ctx.db.one(
    `INSERT INTO outbound_messages (kind, template, to_user_id, to_address, locale, subject, body_text, status, provider, queued_at)
     VALUES ('transactional',$1,$2,$3,$4,$5,$6,'queued',$7, now()) RETURNING id`,
    [template, userId, to, locale, subject, redactBody ? '[redacted: contains a one-time code]' : text, ctx.mailer.name],
  );
  try {
    const res = await ctx.mailer.send({ to, subject, text });
    await ctx.db.query(
      `UPDATE outbound_messages SET status='provider_accepted', accepted_at=now(), attempts=attempts+1, provider_message_id=$2 WHERE id=$1`,
      [row.id, res.providerMessageId || null],
    );
    return { id: row.id, status: 'provider_accepted' };
  } catch (err) {
    await ctx.db.query(
      `UPDATE outbound_messages SET status='failed', failed_at=now(), attempts=attempts+1, last_error=$2 WHERE id=$1`,
      [row.id, String(err.message).slice(0, 500)],
    );
    ctx.log.warn('mail send failed', { template, error: err.message });
    return { id: row.id, status: 'failed' };
  }
}

// AI- or staff-written outreach never sends itself: it is stored as 'prepared' and needs an explicit approval.
async function prepareOutreachDraft(ctx, actor, { to, subject, body, locale = 'en' }) {
  return ctx.db.one(
    `INSERT INTO outbound_messages (kind, template, to_address, locale, subject, body_text, status)
     VALUES ('outreach_draft','custom',$1,$2,$3,$4,'prepared') RETURNING id, status`,
    [to, locale, subject, body],
  );
}

module.exports = { sendTransactional, prepareOutreachDraft };
