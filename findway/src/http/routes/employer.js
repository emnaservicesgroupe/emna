'use strict';
const express = require('express');
const orgs = require('../../services/organizations');
const jobs = require('../../services/jobs');
const applications = require('../../services/applications');

module.exports = (ctx, { wrap, need, parse, s }) => {
  const r = express.Router();
  r.get('/company', wrap(async (req, res) => res.json(await orgs.getMine(ctx, need(req)))));
  r.patch('/company', wrap(async (req, res) => { const a = need(req); const { version, ...patch } = parse(s.companyPatch, req.body); res.json(await orgs.updateMine(ctx, a, a.orgs[0]?.orgId, patch, version)); }));
  r.post('/company/verification', wrap(async (req, res) => { const a = need(req); await orgs.submitVerification(ctx, a, a.orgs[0]?.orgId, parse(s.verificationSubmit, req.body)); res.status(202).json({ ok: true }); }));

  r.get('/jobs', wrap(async (req, res) => res.json(await jobs.listForEmployer(ctx, need(req), { status: req.query.status }))));
  r.post('/jobs', wrap(async (req, res) => { const { version, ...b } = parse(s.job, req.body); res.status(201).json(await jobs.createDraft(ctx, need(req), b)); }));
  r.get('/jobs/:id', wrap(async (req, res) => res.json(await jobs.getForEmployer(ctx, need(req), req.params.id))));
  r.patch('/jobs/:id', wrap(async (req, res) => { const { version, ...b } = parse(s.job, req.body); res.json(await jobs.update(ctx, need(req), req.params.id, b, version)); }));
  r.post('/jobs/:id/submit', wrap(async (req, res) => res.json(await jobs.submit(ctx, need(req), req.params.id))));
  r.post('/jobs/:id/withdraw-submission', wrap(async (req, res) => res.json(await jobs.withdrawSubmission(ctx, need(req), req.params.id))));
  r.post('/jobs/:id/pause', wrap(async (req, res) => res.json(await jobs.setLive(ctx, need(req), req.params.id, 'paused'))));
  r.post('/jobs/:id/resume', wrap(async (req, res) => res.json(await jobs.setLive(ctx, need(req), req.params.id, 'published'))));
  r.post('/jobs/:id/close', wrap(async (req, res) => res.json(await jobs.close(ctx, need(req), req.params.id, parse(s.closeJob, req.body).reason))));
  r.get('/jobs/:id/versions', wrap(async (req, res) => res.json(await jobs.versions(ctx, need(req), req.params.id))));
  r.get('/jobs/:id/applicants', wrap(async (req, res) => res.json(await applications.employerList(ctx, need(req), req.params.id))));
  r.get('/applications/:id', wrap(async (req, res) => res.json(await applications.employerGet(ctx, need(req), req.params.id))));
  r.post('/applications/:id/:action', wrap(async (req, res) => {
    const action = req.params.action;
    if (!['shortlist', 'request_interview', 'request_selection', 'reject'].includes(action)) return res.status(404).json({ error: { code: 'not_found', message: 'Unknown action' } });
    res.json(await applications.employerAct(ctx, need(req), req.params.id, action, parse(s.employerAct, req.body || {})));
  }));
  return r;
};
