'use strict';
// Central configuration. Secrets come only from the environment (see .env.example).
const crypto = require('node:crypto');

function bool(v, d) { return v === undefined ? d : /^(1|true|yes)$/i.test(String(v)); }
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

function load(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const masterKey = env.APP_MASTER_KEY || null;
  if (production && (!masterKey || Buffer.from(masterKey, 'base64').length < 32)) {
    throw new Error('APP_MASTER_KEY (base64, >=32 bytes) is required in production');
  }
  return {
    env: env.NODE_ENV || 'development',
    production,
    port: int(env.PORT, 4000),
    databaseUrl: env.DATABASE_URL || 'postgres://postgres@localhost:55432/findway',
    // In development a deterministic key is derived so the app boots; it is NOT secret.
    masterKey: masterKey ? Buffer.from(masterKey, 'base64') : crypto.createHash('sha256').update('findway-dev-only-key').digest(),
    publicBaseUrl: env.PUBLIC_BASE_URL || `http://localhost:${int(env.PORT, 4000)}`,
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
    trustProxy: bool(env.TRUST_PROXY, false),
    devMailCapture: !production && bool(env.DEV_MAIL_CAPTURE, true),
    mail: {
      provider: env.MAIL_PROVIDER || 'dev',            // 'dev' | 'smtp' (smtp awaiting credentials)
      from: env.MAIL_FROM || 'FIND WAY <no-reply@findway.example>',
      smtp: {
        host: env.MAIL_SMTP_HOST || '',
        port: int(env.MAIL_SMTP_PORT, 465),
        secure: bool(env.MAIL_SMTP_SECURE, int(env.MAIL_SMTP_PORT, 465) === 465),   // true = implicit TLS (465); false = STARTTLS (587)
        user: env.MAIL_SMTP_USER || '',
        password: env.MAIL_SMTP_PASSWORD || '',
        allowInsecure: !production && bool(env.MAIL_SMTP_ALLOW_INSECURE, false),   // tests only: plain, unauthenticated local server
      },
    },
    trustcrm: {
      baseUrl: env.TRUSTCRM_BASE_URL || '',
      serviceEmail: env.TRUSTCRM_SERVICE_EMAIL || '',
      servicePassword: env.TRUSTCRM_SERVICE_PASSWORD || '',
      timeoutMs: int(env.TRUSTCRM_TIMEOUT_MS, 8000),
    },
    inboundWebhookToleranceSeconds: int(env.WEBHOOK_TOLERANCE_SECONDS, 300),
    allowedWebhookHosts: (env.WEBHOOK_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    workersEnabled: bool(env.WORKERS_ENABLED, true),
  };
}

module.exports = { load };
