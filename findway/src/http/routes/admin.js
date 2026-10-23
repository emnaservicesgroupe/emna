'use strict';
const express = require('express');
const auth = require('../../services/auth');
const jobs = require('../../services/jobs');
const orgs = require('../../services/organizations');
const integrations = require('../../integrations/admin');
const P = require('../../permissions');

module.exports = (ctx, { wrap, need, parse, s }) => {
  const r = express.Router();
  // accounts
  r.get('/approvals', wrap(async (req, res) => res.json(await auth.approvalQueue(ctx, need(req)))));
  r.post('/users/:id/approval', wrap(async (req, res) => res.json(await auth.decideApproval(ctx, need(req), req.params.id, parse(s.approvalDecision, req.body)))));
  r.post('/users/:id/suspension', wrap(async (req, res) => { await auth.setSuspended(ctx, need(req), req.params.id, parse(s.suspension, req.body)); res.json({ ok: true }); }));
  r.post('/users/:id/mfa-reset', wrap(async (req, res) => { await auth.resetMfa(ctx, need(req), req.params.id); res.json({ ok: true }); }));
  r.get('/users', wrap(async (req, res) => res.json(await auth.listUsers(ctx, need(req), { role: req.query.role, q: req.query.q, limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0 }))));
  r.post('/users', wrap(async (req, res) => res.status(201).json(await auth.createInternalUser(ctx, need(req), parse(s.createInternal, req.body)))));
  // company verification (identity/company review is separate from account approval)
  r.get('/org-verifications', wrap(async (req, res) => res.json(await orgs.verificationQueue(ctx, need(req)))));
  r.post('/orgs/:id/verification', wrap(async (req, res) => { await orgs.reviewVerification(ctx, need(req), req.params.id, parse(s.orgVerificationDecision, req.body)); res.json({ ok: true }); }));
  // job approvals
  r.get('/job-reviews', wrap(async (req, res) => res.json(await jobs.reviewQueue(ctx, need(req)))));
  r.get('/jobs/:id/review', wrap(async (req, res) => res.json(await jobs.getForReview(ctx, need(req), req.params.id))));
  r.post('/jobs/:id/review', wrap(async (req, res) => res.json(await jobs.review(ctx, need(req), req.params.id, parse(s.jobReview, req.body)))));
  r.post('/jobs/:id/close', wrap(async (req, res) => res.json(await jobs.close(ctx, need(req), req.params.id, parse(s.closeJob, req.body).reason))));
  // audit log (restricted)
  r.get('/audit', wrap(async (req, res) => {
    const a = need(req); P.require(a, 'audit:read');
    const q = req.query;
    res.json(await ctx.db.rows(
      `SELECT e.seq, e.at, e.actor_user_id, u.full_name AS actor_name, e.actor_role, e.via, e.action, e.entity_type, e.entity_id, e.details, e.correlation_id
         FROM audit_events e LEFT JOIN users u ON u.id=e.actor_user_id
        WHERE ($1::text IS NULL OR e.entity_type=$1) AND ($2::text IS NULL OR e.entity_id=$2) AND ($3::text IS NULL OR e.action LIKE $3)
          AND ($4::bigint IS NULL OR e.seq < $4)
        ORDER BY e.seq DESC LIMIT $5`,
      [q.entity_type || null, q.entity_id || null, q.action ? `${String(q.action).replace(/[%_]/g, '')}%` : null, q.before ? Number(q.before) : null, Math.min(Number(q.limit) || 100, 200)]));
  }));
  // integration center
  r.get('/integrations', wrap(async (req, res) => res.json(await integrations.overview(ctx, need(req)))));
  r.put('/integrations/trustcrm', wrap(async (req, res) => res.json(await integrations.configure(ctx, need(req), parse(s.integrationConfig, req.body)))));
  r.post('/integrations/trustcrm/test', wrap(async (req, res) => res.json(await integrations.test(ctx, need(req)))));
  r.post('/integrations/trustcrm/reconcile', wrap(async (req, res) => res.json(await integrations.runReconcile(ctx, need(req)))));
  r.post('/integrations/trustcrm/inbound-secret', wrap(async (req, res) => res.status(201).json(await integrations.rotateInboundSecret(ctx, need(req)))));
  r.post('/integrations/worker/run', wrap(async (req, res) => res.json(await integrations.runWorkerNow(ctx, need(req)))));
  r.get('/integrations/deliveries', wrap(async (req, res) => res.json(await integrations.listDeliveries(ctx, need(req), { status: req.query.status, target: req.query.target, limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0 }))));
  r.post('/integrations/deliveries/:id/retry', wrap(async (req, res) => res.json(await integrations.retryDelivery(ctx, need(req), req.params.id))));
  r.get('/integrations/dead-letters', wrap(async (req, res) => res.json(await integrations.listDeadLetters(ctx, need(req)))));
  r.post('/integrations/dead-letters/:id/replay', wrap(async (req, res) => res.json(await integrations.replayDeadLetter(ctx, need(req), req.params.id))));
  r.get('/integrations/conflicts', wrap(async (req, res) => res.json(await integrations.listConflicts(ctx, need(req), { status: req.query.status || 'open' }))));
  r.post('/integrations/conflicts/:id/resolve', wrap(async (req, res) => res.json(await integrations.resolveConflict(ctx, need(req), req.params.id, parse(s.conflictResolve, req.body)))));
  r.post('/integrations/subscriptions', wrap(async (req, res) => res.status(201).json(await integrations.createSubscription(ctx, need(req), parse(s.subscription, req.body)))));
  r.post('/integrations/subscriptions/:id/active', wrap(async (req, res) => { await integrations.setSubscriptionActive(ctx, need(req), req.params.id, parse(s.active, req.body).active); res.json({ ok: true }); }));
  r.post('/integrations/subscriptions/:id/rotate-secret', wrap(async (req, res) => res.status(201).json(await integrations.rotateSubscriptionSecret(ctx, need(req), req.params.id))));
  return r;
};
