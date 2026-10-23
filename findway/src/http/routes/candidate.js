'use strict';
const express = require('express');
const candidates = require('../../services/candidates');
const applications = require('../../services/applications');
const jobs = require('../../services/jobs');

module.exports = (ctx, { wrap, need, meta, parse, s }) => {
  const r = express.Router();
  r.get('/profile', wrap(async (req, res) => res.json(await candidates.getOwn(ctx, need(req)))));
  r.patch('/profile', wrap(async (req, res) => { const { version, ...patch } = parse(s.candidateProfile, req.body); res.json(await candidates.updateOwn(ctx, need(req), patch, version)); }));
  r.get('/consents', wrap(async (req, res) => res.json(await candidates.listConsents(ctx, need(req)))));
  r.put('/consents/:type', wrap(async (req, res) => res.json(await candidates.setConsent(ctx, need(req), req.params.type, parse(s.consentSet, req.body).granted, meta(req)))));
  r.post('/data-requests', wrap(async (req, res) => res.status(201).json(await candidates.requestDataRight(ctx, need(req), parse(s.dataRequest, req.body).type))));

  r.get('/applications', wrap(async (req, res) => res.json(await applications.listOwn(ctx, need(req)))));
  r.post('/applications', wrap(async (req, res) => {
    const key = String(req.headers['idempotency-key'] || '').slice(0, 100) || null;
    const out = await applications.apply(ctx, need(req), parse(s.apply, req.body), key);
    res.status(out.replayed ? 200 : 201).json({ id: out.application.id, reference_no: out.application.reference_no, stage: out.application.stage, replayed: out.replayed });
  }));
  r.get('/applications/:id', wrap(async (req, res) => res.json(await applications.getOwn(ctx, need(req), req.params.id))));
  r.post('/applications/:id/withdraw', wrap(async (req, res) => res.json(await applications.withdraw(ctx, need(req), req.params.id, parse(s.reasonOnly, req.body)))));
  r.post('/applications/:id/respond', wrap(async (req, res) => res.json(await applications.respondToRequest(ctx, need(req), req.params.id, parse(s.message, req.body)))));
  r.get('/job-changes', wrap(async (req, res) => res.json(await jobs.pendingAcks(ctx, need(req)))));
  r.post('/applications/:id/job-changes/:version/ack', wrap(async (req, res) => { await jobs.ackChange(ctx, need(req), req.params.id, Number(req.params.version)); res.json({ ok: true }); }));
  return r;
};
