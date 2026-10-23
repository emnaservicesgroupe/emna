'use strict';
const express = require('express');
const auth = require('../../services/auth');
const notifications = require('../../services/notifications');
const P = require('../../permissions');
const { E } = require('../../lib/errors');
const { audit } = require('../../services/audit');

module.exports = (ctx, { wrap, need, meta, parse, s }) => {
  const r = express.Router();
  r.post('/auth/register', wrap(async (req, res) => res.status(202).json(await auth.register(ctx, parse(s.register, req.body), meta(req)))));
  r.post('/auth/resend-verification', wrap(async (req, res) => res.json(await auth.resendVerification(ctx, parse(s.email, req.body)))));
  r.post('/auth/verify-email', wrap(async (req, res) => res.json(await auth.verifyEmail(ctx, parse(s.verifyEmail, req.body)))));
  r.post('/auth/login', wrap(async (req, res) => res.json(await auth.login(ctx, parse(s.login, req.body), meta(req)))));
  r.post('/auth/login/mfa', wrap(async (req, res) => res.json(await auth.loginMfa(ctx, parse(s.loginMfa, req.body), meta(req)))));
  r.post('/auth/recover', wrap(async (req, res) => res.json(await auth.requestRecovery(ctx, parse(s.email, req.body)))));
  r.post('/auth/recover/confirm', wrap(async (req, res) => res.json(await auth.confirmRecovery(ctx, parse(s.recoverConfirm, req.body)))));
  r.post('/auth/logout', wrap(async (req, res) => { await auth.logout(ctx, need(req)); res.json({ ok: true }); }));
  r.get('/auth/sessions', wrap(async (req, res) => res.json(await auth.listSessions(ctx, need(req)))));
  r.delete('/auth/sessions/:id', wrap(async (req, res) => { await auth.revokeSession(ctx, need(req), req.params.id); res.json({ ok: true }); }));
  r.post('/auth/mfa/enroll', wrap(async (req, res) => { const a = need(req); if (!P.PRIVILEGED_ROLES.has(a.role)) throw E.forbidden(); res.json(await auth.startMfaEnrollment(ctx, a)); }));
  r.post('/auth/mfa/confirm', wrap(async (req, res) => { const a = need(req); if (!P.PRIVILEGED_ROLES.has(a.role)) throw E.forbidden(); res.json(await auth.confirmMfaEnrollment(ctx, a, parse(s.code6, req.body))); }));

  r.get('/me', wrap(async (req, res) => res.json(await auth.describeMe(ctx, need(req)))));
  r.patch('/me', wrap(async (req, res) => {
    const a = need(req); const b = parse(s.patchMe, req.body);
    await ctx.db.query('UPDATE users SET locale=COALESCE($2,locale), timezone=COALESCE($3,timezone), updated_at=now() WHERE id=$1', [a.userId, b.locale || null, b.timezone || null]);
    await audit(ctx.db, a, { action: 'user.preferences_updated', entityType: 'user', entityId: a.userId });
    res.json({ ok: true });
  }));
  r.get('/notifications', wrap(async (req, res) => { const a = need(req); res.json({ unread: await notifications.unreadCount(ctx, a), items: await notifications.list(ctx, a) }); }));
  r.post('/notifications/:id/read', wrap(async (req, res) => { await notifications.markRead(ctx, need(req), req.params.id); res.json({ ok: true }); }));
  return r;
};
