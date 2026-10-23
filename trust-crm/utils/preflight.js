// Production preflight (Task 20). server.js calls runPreflight() before anything else; app.js (and so the
// test suite) never does. With NODE_ENV=production every problem is collected and the process refuses to
// start (exit 1) with ONE message listing all of them. Values are never printed: only setting NAMES and
// what is wrong with them. Warnings (sandbox mode, no malware scan, scheduler off...) are printed and the
// server starts.
//
// checkEnv(env, { storageWritable }) is pure (env object in, { problems, warnings } out); the only side
// effect - trying to create and remove a file in STORAGE_DIR - is injected through storageWritable.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { trustProxySetting } = require("./trustProxy");
const { realSendEnabled, nearTrue } = require("./flags");

const MIN_SECRET = 32;
const MIN_WEBHOOK_SECRET = 16;
// Values copied from .env.example / docs / tutorials. Matched case-insensitively anywhere in the value.
const PLACEHOLDER_RE = /change_?this|change_?me|replace_?with|placeholder|your[_-]?(?:secret|key|password)|secret_?here|generate_?(?:one|a|me)|example|xxxxx|todo/i;
const SMTP_REQUIRED = ["MAIL_SMTP_HOST", "MAIL_SMTP_USER", "MAIL_SMTP_PASS"];

const isSet = (v) => v !== undefined && v !== null && String(v).trim() !== "";
const lower = (v) => String(v === undefined || v === null ? "" : v).trim().toLowerCase();

function realProvider(env) {
  const p = lower(env.MAIL_PROVIDER || "sandbox");
  return p === "imap_smtp" || p === "imapsmtp";
}

function plainAddress(raw) {
  // same rules as modules/jobsearch/mail/address.js (loaded lazily: it pulls in the guard module)
  return require("../modules/jobsearch/mail/address").plainAddress(raw);
}

/**
 * True for values a generator would never produce: fewer than 8 distinct characters (incl. one repeated
 * character), a short unit repeated, or mostly consecutive characters (abcdef..., 0123..., zyx...).
 */
function lowEntropy(v) {
  if (new Set(v).size < 8) return true;
  for (let u = 1; u <= 8 && u < v.length; u++) {
    const unit = v.slice(0, u);
    if (unit.repeat(Math.ceil(v.length / u)).slice(0, v.length) === v) return true;
  }
  let steps = 0;
  for (let i = 1; i < v.length; i++) if (Math.abs(v.charCodeAt(i) - v.charCodeAt(i - 1)) === 1) steps++;
  return steps / (v.length - 1) >= 0.6;
}

/** Problems with one secret, as messages naming the variable (never the value). */
function secretProblems(name, value, { min = MIN_SECRET, required = true } = {}) {
  if (!isSet(value)) return required ? [`${name} is not set (generate one: openssl rand -hex 32)`] : [];
  const v = String(value).trim();
  const out = [];
  if (v.length < min) out.push(`${name} is too short (at least ${min} characters; generate one: openssl rand -hex 32)`);
  if (PLACEHOLDER_RE.test(v)) out.push(`${name} still holds a placeholder value from an example file (generate a new one: openssl rand -hex 32)`);
  else if (lowEntropy(v)) out.push(`${name} looks too predictable (repeated or sequential characters; generate one: openssl rand -hex 32)`);
  return out;
}

function dbProblems(env) {
  const out = [];
  if (isSet(env.TEST_DATABASE_URL)) out.push("TEST_DATABASE_URL is set: it overrides DATABASE_URL and DB_* (test suite only) - remove it on a server");
  if (isSet(env.DATABASE_URL)) {
    let ok = false;
    try {
      const u = new URL(String(env.DATABASE_URL).trim());
      ok = /^postgres(?:ql)?:$/.test(u.protocol) && Boolean(u.hostname);
    } catch {
      ok = false;
    }
    if (!ok) out.push("DATABASE_URL is not a valid postgres:// connection string");
    return out;
  }
  const missing = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"].filter((k) => !isSet(env[k]));
  if (missing.length) out.push(`Database settings missing: ${missing.join(", ")} (or set DATABASE_URL)`);
  if (isSet(env.DB_PORT) && !(/^\d{1,5}$/.test(String(env.DB_PORT).trim()) && Number(env.DB_PORT) >= 1 && Number(env.DB_PORT) <= 65535)) out.push("DB_PORT must be a port number (1-65535)");
  return out;
}

function smtpProblems(env) {
  const out = SMTP_REQUIRED.filter((k) => !isSet(env[k])).map((k) => `${k} is not set`);
  if (isSet(env.MAIL_SMTP_PORT) && !(/^\d{1,5}$/.test(String(env.MAIL_SMTP_PORT).trim()) && Number(env.MAIL_SMTP_PORT) >= 1 && Number(env.MAIL_SMTP_PORT) <= 65535)) out.push("MAIL_SMTP_PORT must be a port number (1-65535)");
  if (!isSet(env.MAIL_FROM)) out.push("MAIL_FROM is not set (a plain sender address of your domain is required for real mail)");
  else if (!plainAddress(env.MAIL_FROM)) out.push("MAIL_FROM must be a plain address like jobs@your-domain.example");
  if (isSet(env.MAIL_REPLY_TO) && !plainAddress(env.MAIL_REPLY_TO)) out.push("MAIL_REPLY_TO must be a plain address like replies@your-domain.example");
  return out;
}

/**
 * Pure check of a production environment.
 * @param {Record<string, string|undefined>} env
 * @param {{storageWritable?: (dir: string) => boolean|string}} [deps] returns true when writable, or a short reason
 * @returns {{problems: string[], warnings: string[]}}
 */
function checkEnv(env, deps = {}) {
  const problems = [];
  const warnings = [];

  problems.push(...secretProblems("JWT_SECRET", env.JWT_SECRET));
  problems.push(...secretProblems("STORAGE_URL_SECRET", env.STORAGE_URL_SECRET));
  problems.push(...secretProblems("JOBSEARCH_REPLY_SECRET", env.JOBSEARCH_REPLY_SECRET, { required: false }));
  if (isSet(env.JWT_SECRET) && isSet(env.STORAGE_URL_SECRET) && String(env.JWT_SECRET).trim() === String(env.STORAGE_URL_SECRET).trim()) {
    problems.push("JWT_SECRET and STORAGE_URL_SECRET must be different values");
  }

  problems.push(...dbProblems(env));
  if (lower(env.DB_PASSWORD) === "postgres" || (isSet(env.DB_PASSWORD) && PLACEHOLDER_RE.test(String(env.DB_PASSWORD)))) {
    warnings.push("DB_PASSWORD is a default/placeholder value - use a generated password (setup.sh does this)");
  }
  if (lower(env.DB_USER) === "postgres") warnings.push('DB_USER is "postgres" (a superuser): connect the app with an unprivileged role that owns the database (the Docker kit creates vita_app)');

  if (isSet(env.PORT) && !(/^\d{1,5}$/.test(String(env.PORT).trim()) && Number(env.PORT) >= 1 && Number(env.PORT) <= 65535)) problems.push("PORT must be a port number (1-65535)");

  // Inbound webhook: the route answers 503 while INBOUND_MAIL_SECRET is unset, so unset is safe (warning only).
  if (!isSet(env.INBOUND_MAIL_SECRET)) warnings.push("INBOUND_MAIL_SECRET is not set: the inbound mail webhook is disabled (503) - employer replies are not received");
  else problems.push(...secretProblems("INBOUND_MAIL_SECRET", env.INBOUND_MAIL_SECRET, { min: MIN_WEBHOOK_SECRET }));
  if (lower(env.INBOUND_AUTH_REQUIRED) === "false") warnings.push("INBOUND_AUTH_REQUIRED=false: replies without DKIM/DMARC results can be matched automatically");
  if (lower(env.INBOUND_AUTO_ACK_EVIDENCE) === "true") warnings.push("INBOUND_AUTO_ACK_EVIDENCE=true is risk-accepting: acknowledgement evidence is recorded without staff confirmation");

  // Mail
  // same rule as the app (utils/flags.js): only the exact string "true" enables real sending
  const realSend = realSendEnabled(env);
  if (nearTrue(env.MAIL_REAL_SEND)) warnings.push('MAIL_REAL_SEND is set but not exactly "true": real sending stays OFF (write true in lower case to enable it)');
  const clamav = isSet(env.CLAMAV_HOST);
  const unscannedAllowed = String(env.ALLOW_UNSCANNED_ATTACHMENTS || "").trim() === "true";
  if (realSend) {
    if (!realProvider(env)) problems.push("MAIL_REAL_SEND=true needs MAIL_PROVIDER=imap_smtp (the sandbox never sends real mail)");
    else problems.push(...smtpProblems(env));
    if (unscannedAllowed && !clamav) problems.push("MAIL_REAL_SEND=true with ALLOW_UNSCANNED_ATTACHMENTS=true and no malware scanner (CLAMAV_HOST): unscanned CVs would be e-mailed to employers - set ALLOW_UNSCANNED_ATTACHMENTS=false or configure ClamAV");
  } else {
    warnings.push(realProvider(env) ? "MAIL_PROVIDER=imap_smtp but MAIL_REAL_SEND is not true: no real mail is sent" : "SANDBOX MODE: no real mail is sent (MAIL_PROVIDER=sandbox; messages are recorded in the database only)");
  }
  if (isSet(env.MAIL_FROM) && !plainAddress(env.MAIL_FROM) && !realSend) problems.push("MAIL_FROM must be a plain address like jobs@your-domain.example (or leave it unset in sandbox mode)");
  if (!clamav) warnings.push(`No malware scanner (CLAMAV_HOST unset): uploaded CVs are marked scan_unavailable${unscannedAllowed ? " and ALLOW_UNSCANNED_ATTACHMENTS=true lets them be attached" : " and are not attached to applications"}`);
  if (isSet(env.CLAMAV_PORT) && !(/^\d{1,5}$/.test(String(env.CLAMAV_PORT).trim()) && Number(env.CLAMAV_PORT) >= 1 && Number(env.CLAMAV_PORT) <= 65535)) problems.push("CLAMAV_PORT must be a port number (1-65535)");

  // Reverse proxy
  if (!isSet(env.TRUST_PROXY)) {
    warnings.push("TRUST_PROXY is not set: behind Caddy/another HTTPS proxy set TRUST_PROXY=1 so rate limits see the client address");
  } else {
    try {
      trustProxySetting(env.TRUST_PROXY);
    } catch {
      problems.push("TRUST_PROXY is invalid: use a hop count (1) or an address list, never true/yes/*");
    }
  }

  // Storage
  const dir = isSet(env.STORAGE_DIR) ? String(env.STORAGE_DIR).trim() : path.join(__dirname, "..", ".storage");
  if (typeof deps.storageWritable === "function") {
    const w = deps.storageWritable(dir);
    if (w !== true) problems.push(`STORAGE_DIR is not writable${typeof w === "string" && w ? ` (${w})` : ""}: uploads and CV files cannot be stored`);
  }

  // Background jobs
  warnings.push(lower(env.JOBSEARCH_SCHEDULER) === "off" ? "Job-search scheduler is OFF (JOBSEARCH_SCHEDULER=off)" : "Job-search scheduler is on (runs every minute)");
  warnings.push(lower(env.JOBSEARCH_WORKERS) === "off" ? "Queue workers are OFF (JOBSEARCH_WORKERS=off): queued searches and sends are not processed" : "Queue workers are on");

  return { problems, warnings };
}

/** Real STORAGE_DIR check: create the directory if needed, then create and remove a temp file. */
function storageWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = path.join(dir, `.preflight-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
    fs.writeFileSync(probe, "ok", { flag: "wx", mode: 0o600 });
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    return (err && err.code) || "error";
  }
}

function format({ problems, warnings }) {
  const lines = [];
  if (warnings.length) lines.push("VITA preflight warnings:", ...warnings.map((w) => `  - ${w}`));
  if (problems.length) {
    lines.push(`VITA preflight: refusing to start (NODE_ENV=production) - ${problems.length} problem(s):`, ...problems.map((p) => `  - ${p}`));
    lines.push("Fix the settings in your .env file (see deploy/hostinger/.env.production.example) and start again.");
  }
  return lines.join(os.EOL);
}

/**
 * Runs the check when env.NODE_ENV === "production". Exits 1 (after printing every problem) when there is one.
 * @returns {{problems: string[], warnings: string[]}|null} null when not in production
 */
function runPreflight({ env = process.env, exit = (code) => process.exit(code), log = console, writable = storageWritable, printWarnings = true } = {}) {
  if (env.NODE_ENV !== "production") return null;
  const result = checkEnv(env, { storageWritable: writable });
  const text = format(printWarnings ? result : { problems: result.problems, warnings: [] });
  if (result.problems.length) {
    log.error(text);
    exit(1);
  } else if (text) {
    log.log(text);
  }
  return result;
}

module.exports = { checkEnv, runPreflight, storageWritable, format, lowEntropy, PLACEHOLDER_RE, MIN_SECRET };
