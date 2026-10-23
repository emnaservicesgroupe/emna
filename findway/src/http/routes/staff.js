'use strict';
const express = require('express');
const leads = require('../../services/leads');
const candidates = require('../../services/candidates');
const orgs = require('../../services/organizations');
const applications = require('../../services/applications');
const cases = require('../../services/cases');
const jobs = require('../../services/jobs');
const P = require('../../permissions');

const page = (req) => ({ limit: Math.min(Number(req.query.limit) || 50, 100), offset: Number(req.query.offset) || 0 });

module.exports = (ctx, { wrap, need, parse, s }) => {
  const r = express.Router();
  // leads
  r.get('/leads', wrap(async (req, res) => res.json(await leads.list(ctx, need(req), { status: req.query.status, assigned: req.query.assigned || 'all', ...page(req) }))));
  r.get('/leads/:id', wrap(async (req, res) => res.json(await leads.get(ctx, need(req), req.params.id))));
  r.post('/leads/:id/claim', wrap(async (req, res) => res.json(await leads.claim(ctx, need(req), req.params.id))));
  r.post('/leads/:id/status', wrap(async (req, res) => res.json(await leads.setStatus(ctx, need(req), req.params.id, parse(s.leadStatus, req.body)))));
  r.post('/leads/:id/qualify', wrap(async (req, res) => res.json(await leads.qualify(ctx, need(req), req.params.id, parse(s.qualify, req.body || {})))));
  r.get('/duplicates', wrap(async (req, res) => res.json(await leads.listDuplicateReviews(ctx, need(req), { status: req.query.status || 'open' }))));
  r.post('/duplicates/:id', wrap(async (req, res) => res.json(await leads.resolveDuplicate(ctx, need(req), req.params.id, parse(s.duplicateResolve, req.body)))));
  r.post('/reassign', wrap(async (req, res) => { const b = parse(s.reassign, req.body); res.json(await leads.reassign(ctx, need(req), b.entity_type, b.entity_id, b.to_user_id, b.reason)); }));
  // candidates
  r.get('/candidates', wrap(async (req, res) => res.json(await candidates.staffList(ctx, need(req), { q: req.query.q, ...page(req) }))));
  r.get('/candidates/:id', wrap(async (req, res) => res.json(await candidates.staffGet(ctx, need(req), req.params.id))));
  r.post('/candidates/:id/identity', wrap(async (req, res) => { const out = await candidates.recordIdentityRef(ctx, need(req), req.params.id, parse(s.identity, req.body)); res.status(out.flagged ? 409 : 201).json(out.flagged ? { error: { code: 'duplicate_review_required', message: 'This document number already belongs to another person. A duplicate review was opened.', details: out } } : out); }));
  // companies
  r.get('/companies', wrap(async (req, res) => res.json(await orgs.listForStaff(ctx, need(req), { q: req.query.q, ...page(req) }))));
  r.post('/companies', wrap(async (req, res) => res.status(201).json(await orgs.staffCreate(ctx, need(req), parse(s.staffCompany, req.body)))));
  r.get('/companies/:id', wrap(async (req, res) => res.json(await orgs.getForStaff(ctx, need(req), req.params.id))));
  r.post('/companies/:id/contact', wrap(async (req, res) => { await orgs.logContact(ctx, need(req), req.params.id, parse(s.contactLog, req.body)); res.json({ ok: true }); }));
  r.post('/companies/:id/mode', wrap(async (req, res) => { await orgs.setRecruitmentMode(ctx, need(req), req.params.id, parse(s.mode, req.body).mode); res.json({ ok: true }); }));
  // applications
  r.get('/applications/:id', wrap(async (req, res) => res.json(await applications.staffGet(ctx, need(req), req.params.id))));
  r.post('/applications/:id/stage', wrap(async (req, res) => res.json(await applications.staffSetStage(ctx, need(req), req.params.id, parse(s.stage, req.body)))));
  r.post('/applications/:id/release', wrap(async (req, res) => res.json(await applications.staffRelease(ctx, need(req), req.params.id, parse(s.release, req.body || {})))));
  r.post('/notes', wrap(async (req, res) => { const b = parse(s.note, req.body); res.status(201).json(await applications.addNote(ctx, need(req), b.entity_type, b.entity_id, b.body)); }));
  r.get('/requests', wrap(async (req, res) => res.json(await applications.listRequests(ctx, need(req), { status: req.query.status || 'pending' }))));
  r.post('/requests/:id', wrap(async (req, res) => res.json(await applications.resolveRequest(ctx, need(req), req.params.id, parse(s.requestResolve, req.body)))));
  // cases
  r.get('/cases', wrap(async (req, res) => res.json(await cases.list(ctx, need(req), page(req)))));
  r.post('/cases', wrap(async (req, res) => res.status(201).json(await cases.open(ctx, need(req), parse(s.caseOpen, req.body).application_id))));
  r.get('/cases/:id', wrap(async (req, res) => res.json(await cases.get(ctx, need(req), req.params.id))));
  r.post('/cases/:id/stage', wrap(async (req, res) => res.json(await cases.advance(ctx, need(req), req.params.id, parse(s.caseStage, req.body)))));
  // jobs (read-only overview for staff)
  r.get('/jobs', wrap(async (req, res) => res.json(await jobs.listAll(ctx, need(req), { status: req.query.status, ...page(req) }))));
  // staff directory for assignment pickers
  r.get('/team', wrap(async (req, res) => { const a = need(req); P.require(a, 'leads:work'); res.json(await ctx.db.rows(`SELECT id, full_name, role FROM users WHERE role IN ('staff','admin','super_admin') AND status='active' ORDER BY full_name`)); }));
  return r;
};
