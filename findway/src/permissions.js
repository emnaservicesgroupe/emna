'use strict';
// Role → permission matrix. Resource-level checks (ownership, org membership, assignment) live in the
// services; this file answers only "may this role attempt this kind of action at all".
const { E } = require('./lib/errors');

const PRIVILEGED_ROLES = new Set(['super_admin', 'admin', 'staff']);

const STAFF = [
  'leads:work', 'candidates:view_assigned', 'candidates:write_assigned', 'orgs:view_assigned', 'orgs:create',
  'orgs:verify', 'applications:work', 'cases:work', 'requests:resolve', 'integrations:view', 'jobs:view_all',
];
const ADMIN = [
  ...STAFF,
  'users:approve', 'users:suspend', 'users:create_staff', 'jobs:review', 'leads:view_all', 'candidates:view_all',
  'candidates:write_all', 'orgs:view_all', 'integrations:manage', 'audit:read', 'assignments:manage',
  'applications:view_all', 'cases:view_all',
];

const FULL = {
  super_admin: ['*'],
  admin: ADMIN,
  staff: STAFF,
  employer_owner: ['employer:org_manage', 'employer:jobs', 'employer:applicants', 'employer:requests'],
  employer_member: ['employer:jobs', 'employer:applicants'],
  agency: ['agency:self'],
  candidate: ['candidate:self', 'applications:apply', 'applications:own'],
  guest: [],
};

// What an account may do while still waiting for approval: finish onboarding and see its own status.
const ONBOARDING = {
  employer_owner: ['onboard:org'],
  employer_member: [],
  agency: ['onboard:org'],
  candidate: ['onboard:candidate_profile'],
  guest: [],
};
const BASE = ['self:read', 'session:manage'];

function effectivePermissions(p) {
  if (!p || p.status === 'suspended') return [];
  if (!p.emailVerified) return [...BASE, 'self:verify'];
  if (PRIVILEGED_ROLES.has(p.role) && !p.mfaVerified) return [...BASE, 'self:mfa'];
  if (p.approval !== 'approved') return [...BASE, 'self:onboard', ...(ONBOARDING[p.role] || [])];
  // approved accounts keep their onboarding abilities (edit company/profile, submit verification) and gain the full role set
  return [...BASE, 'self:onboard', 'self:mfa', ...(ONBOARDING[p.role] || []), ...(FULL[p.role] || [])];
}

function can(p, perm) {
  const perms = effectivePermissions(p);
  return perms.includes('*') || perms.includes(perm);
}

// Throws the most informative error: callers learn *why* (verify email, wait for approval, enrol MFA).
function require_(p, perm) {
  if (!p) throw E.unauthorized();
  if (can(p, perm)) return;
  if (p.status === 'suspended') throw E.forbidden('account_suspended', 'This account is suspended');
  if (!p.emailVerified) throw E.forbidden('email_verification_required', 'Verify your email address first');
  if (PRIVILEGED_ROLES.has(p.role) && !p.mfaVerified) throw E.forbidden('mfa_required', 'Multi-factor authentication is required for this account');
  if (p.approval !== 'approved') throw E.forbidden('approval_required', 'Your account is awaiting administrator approval');
  throw E.forbidden('permission_denied', `Missing permission: ${perm}`);
}

const isInternal = (p) => PRIVILEGED_ROLES.has(p.role);
const isAdmin = (p) => p.role === 'admin' || p.role === 'super_admin';

module.exports = { PRIVILEGED_ROLES, FULL, ONBOARDING, effectivePermissions, can, require: require_, isInternal, isAdmin };
