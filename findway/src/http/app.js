'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { AppError } = require('../lib/errors');
const auth = require('../services/auth');
const { s, parse } = require('./schemas');

function createApp(ctx, { rateLimits = true } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (ctx.config.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"] },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use((req, res, next) => {
    req.correlationId = String(req.headers['x-correlation-id'] || '').slice(0, 64).replace(/[^\w.-]/g, '') || crypto.randomUUID();
    res.setHeader('x-correlation-id', req.correlationId);
    next();
  });

  // raw body is kept for webhook signature verification
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

  if (rateLimits) {
    const json = (code, message) => (_req, res) => res.status(429).json({ error: { code, message } });
    app.use('/api/auth', rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false, handler: json('rate_limited', 'Too many requests, slow down') }));
    app.use('/api', rateLimit({ windowMs: 60000, limit: 600, standardHeaders: true, legacyHeaders: false, handler: json('rate_limited', 'Too many requests, slow down') }));
  }

  // authentication: attaches req.actor when a valid bearer token is present
  app.use('/api', async (req, _res, next) => {
    try {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
      const principal = await auth.authenticate(ctx, token);
      if (principal) req.actor = { ...principal, ip: req.ip, correlationId: req.correlationId, via: 'web' };
      next();
    } catch (e) { next(e); }
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const need = (req) => { if (!req.actor) throw new AppError(401, 'unauthenticated', 'Authentication required'); return req.actor; };
  const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
  const h = { wrap, need, meta, parse, s };

  app.get('/api/health', wrap(async (_req, res) => { await ctx.db.query('SELECT 1'); res.json({ ok: true }); }));
  app.use('/api', require('./routes/auth')(ctx, h));
  app.use('/api/public', require('./routes/public')(ctx, h));
  app.use('/api/candidate', require('./routes/candidate')(ctx, h));
  app.use('/api/employer', require('./routes/employer')(ctx, h));
  app.use('/api/staff', require('./routes/staff')(ctx, h));
  app.use('/api/admin', require('./routes/admin')(ctx, h));
  app.use('/api/integrations', require('./routes/inbound')(ctx, h));
  if (ctx.config.devMailCapture) {
    app.get('/api/dev/mail', (_req, res) => res.json({ note: 'development mail capture; disabled in production', messages: ctx.mailer.captured || [] }));
  }
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown API route' } }));

  // static web app (SPA fallback for non-API paths)
  const webDir = path.join(__dirname, '..', '..', 'web');
  app.use(express.static(webDir, { index: 'index.html', maxAge: 0, setHeaders: (res, p) => { if (p.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/'); } }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, correlation_id: req.correlationId } });
    }
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body', correlation_id: req.correlationId } });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large', correlation_id: req.correlationId } });
    if (err && err.code === '23505') return res.status(409).json({ error: { code: 'conflict', message: 'That record already exists', correlation_id: req.correlationId } });
    if (err && err.code === '22P02') return res.status(400).json({ error: { code: 'invalid_id', message: 'Malformed identifier', correlation_id: req.correlationId } });
    ctx.log.error('unhandled error', { correlation_id: req.correlationId, path: req.path, error: err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err) });
    return res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong', correlation_id: req.correlationId } });
  });
  return app;
}

module.exports = { createApp };
