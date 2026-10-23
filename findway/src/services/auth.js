'use strict';
const C = require('../lib/crypto');
const { E } = require('../lib/errors');
const { normEmail } = require('../lib/normalize');
const { getSetting } = require('../context');
const P = require('../permissions');
const { audit } = require('./audit');
const { sendTransactional } = require('./messaging');
const { emit } = require('./outbox');
const candidates = require('./candidates');

const COMMON_PASSWORDS = new Set(['password123', 'password1234', '1234567890', 'qwertyuiop', 'letmein1234', 'iloveyou123', 'findway1234']);
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

function checkPassword(pw, email) {
  if (typeof pw !== 'string' || pw.length < 10) throw E.unprocessable('weak_password', 'Password must be at least 10 characters');
  if (pw.length > 200) throw E.unprocessable('weak_password', 'Password is too long');
  const lower = pw.toLowerCase();
  const local = (email || '').split('@')[0];
  if (COMMON_PASSWORDS.has(lower) || (local.length >= 4 && lower.includes(local)) || /^(.)\1+$/.test(pw)) {
    throw E.unprocessable('weak_password', 'Choose a less predictable password');
  }
}

const addMs = (d, ms) => new Date(d.getTime() + ms);

// ───────────── OTP ─────────────
async function issueOtp(ctx, q, { emailNorm, userId, purpose }) {
  const pol = await getSetting(ctx, 'policy.otp');
  const now = ctx.clock.now();
  const last = await q.one(
    `SELECT created_at FROM otp_challenges WHERE email_norm=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [emailNorm, purpose]);
  if (last) {
    const wait = pol.resend_cooldown_seconds * 1000 - (now - last.created_at);
    if (wait > 0) throw E.tooMany('otp_cooldown', 'Please wait before requesting another code', { retry_after_seconds: Math.ceil(wait / 1000) });
  }
  const hourAgo = addMs(now, -3600 * 1000);
  const recent = await q.rows(
    `SELECT created_at FROM otp_challenges WHERE email_norm=$1 AND purpose=$2 AND created_at > $3 ORDER BY created_at ASC`, [emailNorm, purpose, hourAgo]);
  if (recent.length >= pol.max_sends_per_hour) {
    const retry = Math.ceil((addMs(recent[0].created_at, 3600 * 1000) - now) / 1000);
    throw E.tooMany('otp_resend_limited', 'Too many codes requested. Try again later.', { retry_after_seconds: Math.max(retry, 1) });
  }
  // void earlier codes so only the newest is ever valid
  await q.query(`UPDATE otp_challenges SET locked_at=$3 WHERE email_norm=$1 AND purpose=$2 AND consumed_at IS NULL AND locked_at IS NULL`, [emailNorm, purpose, now]);
  const code = C.otpCode();
  await q.query(
    `INSERT INTO otp_challenges (email_norm, user_id, purpose, code_hmac, created_at, expires_at, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [emailNorm, userId, purpose, C.hmac(ctx.keys.otp, `${emailNorm}:${purpose}:${code}`), now, addMs(now, pol.ttl_minutes * 60000), pol.max_attempts]);
  return { code, ttlMinutes: pol.ttl_minutes };
}

async function sendOtpEmail(ctx, user, purpose, code, ttlMinutes) {
  const template = purpose === 'verify_email' ? 'otp_verify_email' : 'otp_recover_password';
  return sendTransactional(ctx, { to: user.email, userId: user.id, template, locale: user.locale, params: { code, minutes: ttlMinutes }, redactBody: true });
}

// Verifies and consumes a code. Failed attempts are persisted (we return a result and throw after commit).
async function checkOtp(ctx, { emailNorm, purpose, code }) {
  const now = ctx.clock.now();
  const result = await ctx.db.tx(async (q) => {
    const ch = await q.one(
      `SELECT * FROM otp_challenges WHERE email_norm=$1 AND purpose=$2 AND consumed_at IS NULL AND locked_at IS NULL
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [emailNorm, purpose]);
    if (!ch) return { err: ['otp_invalid', 'The code is invalid or has expired', 400] };
    if (ch.expires_at <= now) return { err: ['otp_expired', 'This code has expired. Request a new one.', 400] };
    if (ch.attempts >= ch.max_attempts) return { err: ['otp_locked', 'Too many incorrect attempts. Request a new code.', 429] };
    const ok = C.safeEqual(ch.code_hmac, C.hmac(ctx.keys.otp, `${emailNorm}:${purpose}:${String(code)}`));
    if (!ok) {
      await q.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id=$1', [ch.id]);
      const left = ch.max_attempts - ch.attempts - 1;
      return { err: [left <= 0 ? 'otp_locked' : 'otp_invalid', left <= 0 ? 'Too many incorrect attempts. Request a new code.' : 'The code is incorrect', left <= 0 ? 429 : 400, { attempts_left: Math.max(left, 0) }] };
    }
    await q.query('UPDATE otp_challenges SET consumed_at=$2 WHERE id=$1', [ch.id, now]);
    return { ok: true, userId: ch.user_id };
  });
  if (result.err) { const [c, m, s, d] = result.err; const e = new (require('../lib/errors').AppError)(s, c, m, d); throw e; }
  return result;
}

// ───────────── registration & verification ─────────────
async function register(ctx, input, meta = {}) {
  const emailNorm = normEmail(input.email);
  checkPassword(input.password, emailNorm);
  const hash = C.hashPassword(input.password); // always computed: equalises timing between new/existing emails
  const existing = await ctx.db.one('SELECT * FROM users WHERE email_norm=$1', [emailNorm]);
  if (existing) {
    if (existing.email_verified_at) {
      await sendTransactional(ctx, { to: existing.email, userId: existing.id, template: 'account_exists', locale: existing.locale });
    } else {
      const { code, ttlMinutes } = await ctx.db.tx((q) => issueOtp(ctx, q, { emailNorm, userId: existing.id, purpose: 'verify_email' }));
      await sendOtpEmail(ctx, existing, 'verify_email', code, ttlMinutes);
    }
    return { ok: true, next: 'verify_email' };
  }
  const { user, otp } = await ctx.db.tx(async (q) => {
    const user = await q.one(
      `INSERT INTO users (email, email_norm, password_hash, role, full_name, locale, timezone)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.email.trim(), emailNorm, hash, input.role, input.full_name.trim(), input.locale || 'en', input.timezone || 'UTC']);
    for (const type of ['terms', 'privacy']) {
      await q.query(`INSERT INTO consents (user_id, type, version, ip) VALUES ($1,$2,$3,$4)`, [user.id, type, input.consent_version || '2025-01', meta.ip || null]);
    }
    if (input.role === 'employer_owner' || input.role === 'agency') {
      const o = input.org;
      const orgs = require('./organizations');
      await orgs.createForRegistration(q, user, o, input.role === 'agency' ? 'agency' : 'employer');
    }
    await audit(q, { userId: user.id, role: user.role, via: 'web', ip: meta.ip }, { action: 'user.registered', entityType: 'user', entityId: user.id, details: { role: user.role } });
    const otp = await issueOtp(ctx, q, { emailNorm, userId: user.id, purpose: 'verify_email' });
    return { user, otp };
  });
  await sendOtpEmail(ctx, user, 'verify_email', otp.code, otp.ttlMinutes);
  return { ok: true, next: 'verify_email' };
}

async function resendVerification(ctx, { email }) {
  const emailNorm = normEmail(email);
  const user = await ctx.db.one('SELECT * FROM users WHERE email_norm=$1', [emailNorm]);
  if (!user || user.email_verified_at) return { ok: true }; // do not reveal state
  const { code, ttlMinutes } = await ctx.db.tx((q) => issueOtp(ctx, q, { emailNorm, userId: user.id, purpose: 'verify_email' }));
  await sendOtpEmail(ctx, user, 'verify_email', code, ttlMinutes);
  return { ok: true };
}

async function verifyEmail(ctx, { email, code }) {
  const emailNorm = normEmail(email);
  const { userId } = await checkOtp(ctx, { emailNorm, purpose: 'verify_email', code });
  const now = ctx.clock.now();
  await ctx.db.tx(async (q) => {
    const user = await q.one('UPDATE users SET email_verified_at = COALESCE(email_verified_at,$2), updated_at=now() WHERE id=$1 RETURNING *', [userId, now]);
    if (user.role === 'candidate') {
      await candidates.ensureForUser(q, { userId: user.id, role: 'candidate', via: 'system' }, user);
      const policy = await getSetting(ctx, 'policy.candidate_approval', 'auto');
      if (policy === 'auto' && user.approval_status === 'pending') {
        await q.query(`UPDATE users SET approval_status='approved', approval_note='Automatic approval (candidate policy)', approval_decided_at=$2 WHERE id=$1`, [user.id, now]);
      }
    }
    await audit(q, { userId: user.id, role: user.role, via: 'web' }, { action: 'user.email_verified', entityType: 'user', entityId: user.id });
  });
  return { ok: true };
}

// ───────────── login / sessions ─────────────
async function createSession(ctx, q, userId, { mfaVerified, ip, userAgent }) {
  const token = C.randomToken(32);
  const now = ctx.clock.now();
  const expires = addMs(now, ctx.config.sessionTtlHours * 3600000);
  await q.query(
    `INSERT INTO sessions (user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`,
    [userId, C.sha256(token), mfaVerified, now, expires, ip || null, (userAgent || '').slice(0, 200)]);
  return { token, expires_at: expires.toISOString() };
}

async function login(ctx, { email, password }, meta = {}) {
  const emailNorm = normEmail(email);
  const now = ctx.clock.now();
  const user = await ctx.db.one('SELECT * FROM users WHERE email_norm=$1', [emailNorm]);
  if (user && user.locked_until && user.locked_until > now) {
    throw E.tooMany('account_locked', 'Too many failed sign-ins. Try again later.', { retry_after_seconds: Math.ceil((user.locked_until - now) / 1000) });
  }
  const ok = C.verifyPassword(String(password || ''), user ? user.password_hash : C.DUMMY_HASH);
  if (!user || !ok) {
    if (user) {
      const fails = user.failed_logins + 1;
      const lock = fails >= MAX_FAILED_LOGINS ? addMs(now, LOCK_MINUTES * 60000) : null;
      await ctx.db.tx(async (q) => {
        await q.query('UPDATE users SET failed_logins=$2, locked_until=$3 WHERE id=$1', [user.id, lock ? 0 : fails, lock]);
        await audit(q, { userId: user.id, role: user.role, ip: meta.ip }, { action: 'auth.login_failed', entityType: 'user', entityId: user.id, details: { locked: !!lock } });
      });
    }
    throw E.unauthorized('invalid_credentials', 'Email or password is incorrect');
  }
  if (user.status === 'suspended') throw E.forbidden('account_suspended', 'This account is suspended');
  if (!user.email_verified_at) throw E.forbidden('email_verification_required', 'Verify your email address first');
  await ctx.db.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [user.id]);

  if (P.PRIVILEGED_ROLES.has(user.role) && user.mfa_enrolled_at) {
    const token = C.randomToken(24);
    await ctx.db.query(
      `INSERT INTO otp_challenges (email_norm, user_id, purpose, code_hmac, created_at, expires_at, max_attempts) VALUES ($1,$2,'mfa_pending',$3,$4,$5,5)`,
      [emailNorm, user.id, C.hmac(ctx.keys.otp, `mfa:${token}`), now, addMs(now, 5 * 60000)]);
    return { mfa_required: true, mfa_token: token };
  }
  const session = await ctx.db.tx(async (q) => {
    const s = await createSession(ctx, q, user.id, { mfaVerified: !P.PRIVILEGED_ROLES.has(user.role), ip: meta.ip, userAgent: meta.userAgent });
    await audit(q, { userId: user.id, role: user.role, ip: meta.ip }, { action: 'auth.login', entityType: 'user', entityId: user.id, details: { mfa: false } });
    return s;
  });
  return { ...session, mfa_enrollment_required: P.PRIVILEGED_ROLES.has(user.role) };
}

async function loginMfa(ctx, { mfa_token, code }, meta = {}) {
  const now = ctx.clock.now();
  const hmac = C.hmac(ctx.keys.otp, `mfa:${mfa_token}`);
  const out = await ctx.db.tx(async (q) => {
    const ch = await q.one(`SELECT * FROM otp_challenges WHERE code_hmac=$1 AND purpose='mfa_pending' AND consumed_at IS NULL AND locked_at IS NULL FOR UPDATE`, [hmac]);
    if (!ch || ch.expires_at <= now) return { err: ['mfa_token_invalid', 'Sign in again', 401] };
    if (ch.attempts >= ch.max_attempts) return { err: ['otp_locked', 'Too many attempts. Sign in again.', 429] };
    const user = await q.one('SELECT * FROM users WHERE id=$1 FOR UPDATE', [ch.user_id]);
    const secret = C.decrypt(user.mfa_secret_enc, ctx.keys.enc);
    let step = C.verifyTotp(secret, String(code).trim(), now.getTime(), user.mfa_last_step);
    let usedRecovery = false;
    if (step === null) {
      const h = C.sha256(String(code).trim().toLowerCase());
      const idx = (user.mfa_recovery || []).indexOf(h);
      if (idx >= 0) { usedRecovery = true; const rest = user.mfa_recovery.filter((_, i) => i !== idx); await q.query('UPDATE users SET mfa_recovery=$2 WHERE id=$1', [user.id, JSON.stringify(rest)]); }
    }
    if (step === null && !usedRecovery) {
      await q.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [ch.id]);
      return { err: ['mfa_invalid', 'The authentication code is incorrect', 400] };
    }
    if (step !== null) await q.query('UPDATE users SET mfa_last_step=$2 WHERE id=$1', [user.id, step]);
    await q.query('UPDATE otp_challenges SET consumed_at=$2 WHERE id=$1', [ch.id, now]);
    const s = await createSession(ctx, q, user.id, { mfaVerified: true, ip: meta.ip, userAgent: meta.userAgent });
    await audit(q, { userId: user.id, role: user.role, ip: meta.ip }, { action: 'auth.login', entityType: 'user', entityId: user.id, details: { mfa: true, recovery_code: usedRecovery } });
    return { session: s };
  });
  if (out.err) { const [c, m, s] = out.err; throw new (require('../lib/errors').AppError)(s, c, m); }
  return out.session;
}

async function authenticate(ctx, token) {
  if (!token) return null;
  const now = ctx.clock.now();
  const s = await ctx.db.one(
    `SELECT s.id AS session_id, s.mfa_verified, s.last_seen_at, s.expires_at, s.revoked_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=$1`, [C.sha256(token)]);
  if (!s || s.revoked_at || s.expires_at <= now) return null;
  if (now - s.last_seen_at > 60000) await ctx.db.query('UPDATE sessions SET last_seen_at=$2 WHERE id=$1', [s.session_id, now]);
  const orgs = await ctx.db.rows(
    `SELECT m.org_id, m.role, o.type, o.verification_status FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=$1`, [s.id]);
  return {
    userId: s.id, role: s.role, email: s.email, fullName: s.full_name, locale: s.locale, timezone: s.timezone,
    emailVerified: !!s.email_verified_at, approval: s.approval_status, approvalNote: s.approval_note, status: s.status,
    mfaEnrolled: !!s.mfa_enrolled_at, mfaVerified: s.mfa_verified, sessionId: s.session_id,
    orgs: orgs.map((o) => ({ orgId: o.org_id, role: o.role, type: o.type, verificationStatus: o.verification_status })),
    via: 'web',
  };
}

async function logout(ctx, actor) {
  await ctx.db.query('UPDATE sessions SET revoked_at=$2 WHERE id=$1', [actor.sessionId, ctx.clock.now()]);
}
async function listSessions(ctx, actor) {
  return ctx.db.rows(
    `SELECT id, created_at, last_seen_at, expires_at, ip, user_agent, (id = $2) AS current FROM sessions
      WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > $3 ORDER BY created_at DESC`, [actor.userId, actor.sessionId, ctx.clock.now()]);
}
async function revokeSession(ctx, actor, sessionId) {
  const r = await ctx.db.query('UPDATE sessions SET revoked_at=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [sessionId, actor.userId, ctx.clock.now()]);
  if (!r.rowCount) throw E.notFound('session');
}
const revokeAllSessions = (q, userId, now, exceptId = null) =>
  q.query('UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3)', [userId, now, exceptId]);

// ───────────── recovery ─────────────
async function requestRecovery(ctx, { email }) {
  const emailNorm = normEmail(email);
  const user = await ctx.db.one('SELECT * FROM users WHERE email_norm=$1', [emailNorm]);
  if (!user || user.status === 'suspended') return { ok: true };
  try {
    const { code, ttlMinutes } = await ctx.db.tx((q) => issueOtp(ctx, q, { emailNorm, userId: user.id, purpose: 'recover_password' }));
    await sendOtpEmail(ctx, user, 'recover_password', code, ttlMinutes);
  } catch (e) { if (e.status !== 429) throw e; } // silently swallow rate limits: do not reveal that the account exists
  return { ok: true };
}

async function confirmRecovery(ctx, { email, code, new_password }) {
  const emailNorm = normEmail(email);
  checkPassword(new_password, emailNorm);
  const { userId } = await checkOtp(ctx, { emailNorm, purpose: 'recover_password', code });
  const now = ctx.clock.now();
  await ctx.db.tx(async (q) => {
    const u = await q.one(
      `UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL, email_verified_at=COALESCE(email_verified_at,$3), updated_at=now()
       WHERE id=$1 RETURNING *`, [userId, C.hashPassword(new_password), now]);
    await revokeAllSessions(q, userId, now);
    await audit(q, { userId, role: u.role }, { action: 'auth.password_reset', entityType: 'user', entityId: userId });
  });
  return { ok: true };
}

// ───────────── MFA ─────────────
async function startMfaEnrollment(ctx, actor) {
  const u = await ctx.db.one('SELECT * FROM users WHERE id=$1', [actor.userId]);
  if (u.mfa_enrolled_at) throw E.conflict('mfa_already_enrolled', 'MFA is already enabled; ask a Super Admin to reset it');
  const secret = C.newTotpSecret();
  await ctx.db.query('UPDATE users SET mfa_secret_enc=$2 WHERE id=$1', [u.id, C.encrypt(secret, ctx.keys.enc)]);
  const issuer = 'FIND WAY CRM';
  return { secret, otpauth_url: `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(u.email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30` };
}

async function confirmMfaEnrollment(ctx, actor, { code }) {
  const u = await ctx.db.one('SELECT * FROM users WHERE id=$1', [actor.userId]);
  if (u.mfa_enrolled_at) throw E.conflict('mfa_already_enrolled', 'MFA is already enabled');
  if (!u.mfa_secret_enc) throw E.conflict('mfa_not_started', 'Start enrolment first');
  const step = C.verifyTotp(C.decrypt(u.mfa_secret_enc, ctx.keys.enc), String(code).trim(), ctx.clock.now().getTime());
  if (step === null) throw E.badRequest('mfa_invalid', 'The authentication code is incorrect');
  const recovery = Array.from({ length: 8 }, () => C.randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x'));
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE users SET mfa_enrolled_at=$2, mfa_last_step=$3, mfa_recovery=$4 WHERE id=$1',
      [u.id, ctx.clock.now(), step, JSON.stringify(recovery.map((r) => C.sha256(r)))]);
    await q.query('UPDATE sessions SET mfa_verified=true WHERE id=$1', [actor.sessionId]);
    await audit(q, actor, { action: 'auth.mfa_enrolled', entityType: 'user', entityId: u.id });
  });
  return { recovery_codes: recovery }; // shown once
}

async function resetMfa(ctx, actor, userId) {
  if (actor.role !== 'super_admin') throw E.forbidden('permission_denied', 'Only a Super Admin can reset MFA');
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE users SET mfa_secret_enc=NULL, mfa_enrolled_at=NULL, mfa_last_step=NULL, mfa_recovery='[]' WHERE id=$1`, [userId]);
    await revokeAllSessions(q, userId, ctx.clock.now());
    await audit(q, actor, { action: 'auth.mfa_reset', entityType: 'user', entityId: userId });
  });
}

// ───────────── admin: approval, suspension, internal users ─────────────
async function approvalQueue(ctx, actor) {
  P.require(actor, 'users:approve');
  return ctx.db.rows(
    `SELECT u.id, u.email, u.full_name, u.role, u.created_at, u.email_verified_at, u.approval_status, u.approval_note,
            o.id AS org_id, o.name AS org_name, o.type AS org_type, o.country AS org_country, o.verification_status, o.potential_duplicate_of
       FROM users u LEFT JOIN memberships m ON m.user_id=u.id AND m.role='owner' LEFT JOIN organizations o ON o.id=m.org_id
      WHERE u.approval_status='pending' AND u.email_verified_at IS NOT NULL AND u.role IN ('employer_owner','agency','candidate')
      ORDER BY u.created_at ASC LIMIT 200`);
}

async function decideApproval(ctx, actor, userId, { decision, note }) {
  P.require(actor, 'users:approve');
  if (!['approved', 'rejected'].includes(decision)) throw E.badRequest('invalid_decision', 'decision must be approved or rejected');
  if (decision === 'rejected' && !note) throw E.unprocessable('reason_required', 'A reason is required to reject an account');
  if (userId === actor.userId) throw E.forbidden('self_approval', 'You cannot decide your own account');
  const u = await ctx.db.one('SELECT * FROM users WHERE id=$1', [userId]);
  if (!u) throw E.notFound('user');
  if (!u.email_verified_at) throw E.conflict('email_not_verified', 'The account has not verified its email address yet');
  if (['super_admin', 'admin', 'staff'].includes(u.role)) throw E.forbidden('permission_denied', 'Internal accounts are managed under Staff');
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE users SET approval_status=$2, approval_note=$3, approval_decided_by=$4, approval_decided_at=$5, updated_at=now() WHERE id=$1`,
      [userId, decision, note || null, actor.userId, ctx.clock.now()]);
    await audit(q, actor, { action: `user.approval_${decision}`, entityType: 'user', entityId: userId, details: { note: note || null } });
  });
  await sendTransactional(ctx, { to: u.email, userId: u.id, template: 'account_decision', locale: u.locale, params: { status: decision, note: note || '' } });
  return { ok: true };
}

async function setSuspended(ctx, actor, userId, { suspended, reason }) {
  P.require(actor, 'users:suspend');
  if (userId === actor.userId) throw E.forbidden('self_action', 'You cannot suspend your own account');
  const u = await ctx.db.one('SELECT * FROM users WHERE id=$1', [userId]);
  if (!u) throw E.notFound('user');
  if (['admin', 'super_admin'].includes(u.role) && actor.role !== 'super_admin') throw E.forbidden('permission_denied', 'Only a Super Admin can suspend administrators');
  if (suspended && !reason) throw E.unprocessable('reason_required', 'A reason is required');
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE users SET status=$2, suspended_reason=$3, suspended_at=$4, updated_at=now() WHERE id=$1`,
      [userId, suspended ? 'suspended' : 'active', suspended ? reason : null, suspended ? ctx.clock.now() : null]);
    if (suspended) await revokeAllSessions(q, userId, ctx.clock.now());
    await audit(q, actor, { action: suspended ? 'user.suspended' : 'user.unsuspended', entityType: 'user', entityId: userId, details: { reason: reason || null } });
  });
}

async function createInternalUser(ctx, actor, { email, full_name, role, locale }) {
  P.require(actor, 'users:create_staff');
  if (!['staff', 'admin'].includes(role)) throw E.badRequest('invalid_role', 'role must be staff or admin');
  if (role === 'admin' && actor.role !== 'super_admin') throw E.forbidden('permission_denied', 'Only a Super Admin can create administrators');
  const emailNorm = normEmail(email);
  if (await ctx.db.one('SELECT 1 FROM users WHERE email_norm=$1', [emailNorm])) throw E.conflict('email_in_use', 'A user with this email already exists');
  const user = await ctx.db.tx(async (q) => {
    const u = await q.one(
      `INSERT INTO users (email, email_norm, password_hash, role, full_name, locale, approval_status, approval_decided_by, approval_decided_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'approved',$7,$8,$7) RETURNING *`,
      [email.trim(), emailNorm, C.hashPassword(C.randomToken(24)), role, full_name.trim(), locale || 'en', actor.userId, ctx.clock.now()]);
    await audit(q, actor, { action: 'user.internal_created', entityType: 'user', entityId: u.id, details: { role } });
    return u;
  });
  await sendTransactional(ctx, { to: user.email, userId: user.id, template: 'staff_invite', locale: user.locale });
  return { id: user.id, email: user.email, role: user.role };
}

async function listUsers(ctx, actor, { role, q: search, limit = 50, offset = 0 }) {
  P.require(actor, 'users:approve');
  return ctx.db.rows(
    `SELECT id, email, full_name, role, status, approval_status, email_verified_at, mfa_enrolled_at IS NOT NULL AS mfa, created_at
       FROM users WHERE ($1::text IS NULL OR role=$1) AND ($2::text IS NULL OR email_norm ILIKE $2 OR full_name ILIKE $2)
      ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [role || null, search ? `%${String(search).replace(/[%_]/g, '')}%` : null, Math.min(limit, 100), offset]);
}

async function describeMe(ctx, actor) {
  const profile = actor.role === 'candidate' ? await candidates.completionFor(ctx, actor.userId) : null;
  return {
    id: actor.userId, email: actor.email, full_name: actor.fullName, role: actor.role, locale: actor.locale, timezone: actor.timezone,
    status: {
      email_verified: actor.emailVerified,
      approval: actor.approval, approval_note: actor.approvalNote,
      suspended: actor.status === 'suspended',
      mfa: { required: P.PRIVILEGED_ROLES.has(actor.role), enrolled: actor.mfaEnrolled, verified: actor.mfaVerified },
      profile_completion: profile,
      organizations: actor.orgs.map((o) => ({ org_id: o.orgId, role: o.role, type: o.type, verification_status: o.verificationStatus })),
    },
    permissions: P.effectivePermissions(actor),
  };
}

module.exports = {
  register, resendVerification, verifyEmail, login, loginMfa, authenticate, logout, listSessions, revokeSession,
  requestRecovery, confirmRecovery, startMfaEnrollment, confirmMfaEnrollment, resetMfa, approvalQueue, decideApproval,
  setSuspended, createInternalUser, listUsers, describeMe, checkPassword, issueOtp, revokeAllSessions,
};
