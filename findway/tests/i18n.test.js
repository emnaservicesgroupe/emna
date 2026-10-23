'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const LANGS = fs.readdirSync(path.join(WEB, 'i18n')).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
const dict = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(fs.readFileSync(path.join(WEB, 'i18n', `${l}.json`), 'utf8'))]));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const jsFiles = walk(path.join(WEB, 'js')).filter((f) => f.endsWith('.js'));
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('the four launch languages are present', () => { for (const l of ['en', 'ar', 'sq', 'fr']) assert.ok(dict[l], l); });

test('every language has exactly the same keys as English, none empty', () => {
  const en = Object.keys(dict.en);
  for (const l of LANGS.filter((x) => x !== 'en')) {
    const keys = Object.keys(dict[l]);
    assert.deepEqual(en.filter((k) => !(k in dict[l])), [], `${l} is missing keys`);
    assert.deepEqual(keys.filter((k) => !(k in dict.en)), [], `${l} has keys English lacks`);
  }
  for (const l of LANGS) for (const [k, v] of Object.entries(dict[l])) assert.ok(typeof v === 'string' && v.trim() !== '', `${l}.${k} is empty`);
});

test('placeholders are identical across languages', () => {
  for (const l of LANGS.filter((x) => x !== 'en')) for (const k of Object.keys(dict.en)) assert.equal(placeholders(dict[l][k]), placeholders(dict.en[k]), `${l}.${k}`);
});

test('Arabic, Albanian and French are actually translated (not English copies) for user-facing sentences', () => {
  for (const l of ['ar', 'sq', 'fr']) {
    const same = Object.keys(dict.en).filter((k) => dict.en[k].length > 25 && dict.en[k] === dict[l][k]);
    assert.deepEqual(same, [], `${l} has untranslated long strings`);
  }
});

// identifiers that look like keys but are integration event names or notification type codes, not UI strings
const NOT_UI = new Set(['lead.created', 'job.closed', 'consent.revoked', 'case.stage', 'job.terms_changed', 'job.review_decided', 'candidate.created', 'candidate.updated', 'lead.qualified', 'application.submitted', 'application.status_changed', 'job.published', 'placement.updated', 'application.status', 'org.verification_decided']);

test('every translation key referenced in the front-end code exists', () => {
  const prefixes = new Set(Object.keys(dict.en).map((k) => k.split('.')[0]));
  const missing = new Set();
  for (const f of jsFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/['"`]([a-z]+(?:\.[a-z0-9_]+)+)['"`]/g)) {
      const key = m[1];
      if (!prefixes.has(key.split('.')[0]) || key.includes('${')) continue;
      if (NOT_UI.has(key)) continue;
      if (/\.(js|json|css|png|html)$/.test(key) || /^(document|window|navigator|e|el)\./.test(key)) continue;
      if (!(key in dict.en)) missing.add(`${path.basename(f)}: ${key}`);
    }
    for (const m of src.matchAll(/(?:tEnum|enumBadge)\(\s*'([a-z]+)'/g)) assert.ok(prefixes.has(m[1]), `enum prefix ${m[1]} has no translations (${path.basename(f)})`);
  }
  assert.deepEqual([...missing], []);
});

test('enum values the backend can return are translated', () => {
  const need = {
    stage: ['submitted', 'under_review', 'missing_information', 'shortlisted', 'interview_requested', 'interview_scheduled', 'selected', 'rejected', 'withdrawn', 'position_closed'],
    case: ['offer', 'documents', 'contract', 'work_permit', 'visa_appointment', 'visa_result', 'travel', 'arrival', 'started_work', 'follow_up', 'closed'],
    jstatus: ['draft', 'pending_approval', 'changes_requested', 'rejected', 'published', 'paused', 'closed'],
    lead: ['received', 'under_review', 'missing_information', 'rejected', 'qualified'],
    role: ['super_admin', 'admin', 'staff', 'employer_owner', 'employer_member', 'agency', 'candidate', 'guest'],
    connstatus: ['not_configured', 'configured_untested', 'connected', 'auth_failed', 'unreachable', 'disabled'],
    dstatus: ['pending', 'retry', 'succeeded', 'skipped', 'blocked', 'dead'],
    verification: ['unsubmitted', 'submitted', 'verified', 'rejected', 'changes_requested'],
    approval: ['pending', 'approved', 'rejected'],
  };
  for (const [p, vals] of Object.entries(need)) for (const v of vals) assert.ok(`${p}.${v}` in dict.en, `${p}.${v}`);
  for (const code of ['otp_invalid', 'otp_expired', 'otp_locked', 'otp_cooldown', 'otp_resend_limited', 'invalid_credentials', 'account_locked', 'approval_required', 'duplicate_review_required', 'version_conflict', 'already_applied', 'profile_incomplete']) assert.ok(`err.${code}` in dict.en, `err.${code}`);
});

test('front-end is CSP-clean: no inline scripts, handlers, style attributes or external origins', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), 'inline <script>'); assert.ok(!/\son\w+=/i.test(html), 'inline handler'); assert.ok(!/<style/i.test(html), '<style>'); assert.ok(!/style="/i.test(html), 'style attr');
  for (const f of [...jsFiles, path.join(WEB, 'css', 'app.css'), path.join(WEB, 'index.html')]) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/(?:src|href)\s*=\s*["']https?:\/\//.test(src), `${path.basename(f)} loads an external resource`);
    assert.ok(!/@import\s+url\(\s*['"]?https?:/.test(src), `${path.basename(f)} imports external CSS`);
    if (f.endsWith('.js')) { assert.ok(!/\.innerHTML\s*=/.test(src), `${path.basename(f)} assigns innerHTML`); assert.ok(!/setAttribute\(\s*['"]style['"]/.test(src), `${path.basename(f)} sets a style attribute`); }
  }
});

test('CSS uses logical properties (no physical left/right layout) so RTL mirrors correctly', () => {
  const css = fs.readFileSync(path.join(WEB, 'css', 'app.css'), 'utf8');
  const bad = css.split('\n').filter((l) => /(^|[;{\s])(margin|padding)-(left|right)\s*:|(^|[;{\s])(left|right)\s*:|text-align\s*:\s*(left|right)|border-(left|right)\s*:/.test(l));
  assert.deepEqual(bad, []);
});

test('service worker never caches API calls and the manifest is installable', () => {
  const sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');
  assert.match(sw, /\/api\//); assert.match(sw, /method !== 'GET'/);
  const m = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone'); assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512') && m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(WEB, i.src)), i.src);
  for (const f of ['index.html', 'offline.html']) assert.ok(fs.existsSync(path.join(WEB, f)));
});
