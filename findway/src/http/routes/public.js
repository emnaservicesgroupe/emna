'use strict';
const express = require('express');
const jobs = require('../../services/jobs');
const orgs = require('../../services/organizations');
const { jobSearch, parse } = require('../schemas');

module.exports = (ctx, { wrap }) => {
  const r = express.Router();
  r.get('/jobs', wrap(async (req, res) => res.json(await jobs.publicSearch(ctx, parse(jobSearch, req.query)))));
  r.get('/jobs/:id', wrap(async (req, res) => res.json(await jobs.publicGet(ctx, req.params.id))));
  r.get('/companies', wrap(async (req, res) => res.json(await orgs.publicList(ctx, { q: req.query.q, country: req.query.country, limit: Number(req.query.limit) || 20, offset: Number(req.query.offset) || 0 }))));
  r.get('/companies/:id', wrap(async (req, res) => res.json(await orgs.publicGet(ctx, req.params.id))));
  // reference lists the forms and filters use; derived from live data, never fabricated
  r.get('/facets', wrap(async (_req, res) => {
    const today = ctx.clock.now().toISOString().slice(0, 10);
    const rows = await ctx.db.rows(`SELECT country, profession, count(*)::int AS n FROM jobs WHERE status='published' AND (deadline IS NULL OR deadline >= $1) GROUP BY 1,2`, [today]);
    const countries = {}; const professions = {};
    for (const x of rows) { if (x.country) countries[x.country] = (countries[x.country] || 0) + x.n; if (x.profession) professions[x.profession] = (professions[x.profession] || 0) + x.n; }
    res.json({ countries, professions });
  }));
  return r;
};
