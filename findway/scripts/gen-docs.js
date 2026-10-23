'use strict';
// Generates docs that must never drift from the code: the role/permission matrix and the HTTP endpoint list.
// `node scripts/gen-docs.js` writes docs/generated/*; tests/docs.test.js fails if the committed copies are stale.
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/permissions');

const root = path.join(__dirname, '..');
const roles = ['super_admin', 'admin', 'staff', 'employer_owner', 'employer_member', 'agency', 'candidate', 'guest'];

function permissionMatrix() {
  const all = new Set();
  for (const r of roles) for (const p of [...(P.FULL[r] || []), ...(P.ONBOARDING[r] || [])]) if (p !== '*') all.add(p);
  const perms = [...all].sort();
  const lines = [
    '# Permission matrix (generated)', '',
    '_Generated from `src/permissions.js` by `scripts/gen-docs.js` — do not edit by hand._', '',
    'Legend: **✓** granted once the account is email-verified, approved and (for internal roles) MFA-verified · **○** available while awaiting approval (onboarding only) · **✓\\*** Super Admin holds the wildcard `*`.', '',
    `| Permission | ${roles.join(' | ')} |`, `|---|${roles.map(() => ':-:').join('|')}|`,
  ];
  for (const p of perms) {
    const cells = roles.map((r) => {
      if ((P.FULL[r] || []).includes('*')) return '✓*';
      if ((P.FULL[r] || []).includes(p)) return '✓';
      if ((P.ONBOARDING[r] || []).includes(p)) return '○';
      return '';
    });
    lines.push(`| \`${p}\` | ${cells.join(' | ')} |`);
  }
  lines.push('', '## Always available (any signed-in account)', '', '`self:read`, `session:manage`; `self:verify` until the email is verified; `self:onboard`/`self:mfa` once verified (`self:mfa` is the only capability of a privileged session that has not completed MFA).', '');
  lines.push('## Privileged roles', '', `Roles that must complete MFA before any permission applies: ${[...P.PRIVILEGED_ROLES].map((r) => `\`${r}\``).join(', ')}.`, '');
  return lines.join('\n');
}

function endpointList() {
  const mounts = { 'auth.js': '/api', 'public.js': '/api/public', 'candidate.js': '/api/candidate', 'employer.js': '/api/employer', 'staff.js': '/api/staff', 'admin.js': '/api/admin', 'inbound.js': '/api/integrations' };
  const rows = [['GET', '/api/health', 'app.js'], ['GET', '/api/dev/mail', 'app.js (development only; absent in production)']];
  for (const [file, prefix] of Object.entries(mounts)) {
    const src = fs.readFileSync(path.join(root, 'src/http/routes', file), 'utf8');
    for (const m of src.matchAll(/\br\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) rows.push([m[1].toUpperCase(), prefix + m[2], file]);
  }
  const lines = ['# HTTP endpoints (generated)', '', '_Generated from `src/http/routes/*.js` by `scripts/gen-docs.js` — do not edit by hand. Authorisation is enforced in the service layer; see PERMISSIONS and the per-area notes in docs/API.md._', '', '| Method | Path | Defined in |', '|---|---|---|'];
  for (const [m, p, f] of rows) lines.push(`| ${m} | \`${p}\` | ${f} |`);
  lines.push('', `Total: ${rows.length} endpoints.`, '');
  return lines.join('\n');
}

const outputs = { 'docs/generated/permission-matrix.md': permissionMatrix(), 'docs/generated/api-endpoints.md': endpointList() };
module.exports = { outputs };
if (require.main === module) {
  for (const [f, body] of Object.entries(outputs)) { fs.writeFileSync(path.join(root, f), body); console.log('wrote', f); }
}
