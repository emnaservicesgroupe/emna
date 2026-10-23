import { get, post, setToken, ApiError } from '../api.js';
import { t, tError } from '../i18n.js';
import { h, field, checkbox, form, toast, copyButton, clear, setFieldError } from '../ui.js';
import { loadMe, state, homeFor } from '../store.js';
import { go } from '../router.js';

async function afterLogin(token, enroll, next) {
  setToken(token); await loadMe(); window.dispatchEvent(new Event('fw:me-changed'));
  if (enroll) go('/mfa-setup'); else go(next && next.startsWith('/') ? next : homeFor());
}

export function registerAuth(route) {
  route('/login', login); route('/register', register); route('/verify', verify); route('/forgot', forgot); route('/reset', reset);
  route('/mfa-setup', mfaSetup, { auth: true });
}

function login({ query }) {
  const box = h('div', { class: 'card stack' });
  const email = field({ label: t('auth.email'), name: 'email', type: 'email', value: query.email || '', required: true, autocomplete: 'username' });
  const pw = field({ label: t('auth.password'), name: 'password', type: 'password', required: true, autocomplete: 'current-password' });
  const mfaStep = (mfaToken) => {
    clear(box);
    const code = field({ label: t('mfa.code'), name: 'code', value: '', required: true, autocomplete: 'one-time-code', hint: t('mfa.code_hint'), inputmode: 'numeric' });
    box.append(h('h2', {}, t('mfa.title')), form({ submitLabel: t('auth.login'), children: [code.el], onSubmit: async (f) => {
      const r = await post('/auth/login/mfa', { mfa_token: mfaToken, code: code.input.value.trim() });
      await afterLogin(r.token, false, query.next);
    } }));
    code.input.focus();
  };
  box.append(form({ submitLabel: t('auth.login'), children: [email.el, pw.el], onSubmit: async () => {
    try {
      const r = await post('/auth/login', { email: email.input.value.trim(), password: pw.input.value });
      if (r.mfa_required) return mfaStep(r.mfa_token);
      await afterLogin(r.token, r.mfa_enrollment_required, query.next);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'email_verification_required') { toast(t('err.email_verification_required'), 'bad'); go(`/verify?email=${encodeURIComponent(email.input.value.trim())}`); return; }
      throw e;
    }
  }, extra: h('a', { href: '#/forgot' }, t('auth.forgot')) }));
  return h('div', { class: 'auth-box stack' }, h('h1', {}, t('auth.login_title')), query.expired ? h('p', { class: 'notice warn', role: 'status' }, t('auth.session_expired')) : null,
    query.reset ? h('p', { class: 'notice ok', role: 'status' }, t('auth.reset_done')) : null, query.verified ? h('p', { class: 'notice ok', role: 'status' }, t('auth.verified_done')) : null,
    box, h('p', {}, t('auth.no_account'), ' ', h('a', { href: '#/register' }, t('nav.register'))));
}

function register() {
  let roleVal = 'candidate';
  const orgBox = h('div', { hidden: true });
  const name = field({ label: t('auth.full_name'), name: 'full_name', required: true, autocomplete: 'name' });
  const email = field({ label: t('auth.email'), name: 'email', type: 'email', required: true, autocomplete: 'email' });
  const pw = field({ label: t('auth.password'), name: 'password', type: 'password', required: true, autocomplete: 'new-password', hint: t('auth.password_hint') });
  const org = field({ label: t('auth.org_name'), name: 'org_name' }); const country = field({ label: t('auth.org_country'), name: 'org_country' });
  const terms = checkbox({ label: t('auth.accept_terms'), name: 'accept_terms' }); terms.input.setAttribute('aria-required', 'true');
  orgBox.append(org.el, country.el);
  const roles = [['candidate', 'role.candidate', 'role.candidate_desc'], ['employer_owner', 'role.employer', 'role.employer_desc'], ['agency', 'role.agency', 'role.agency_desc']];
  const pick = h('fieldset', { class: 'role-pick' }, h('legend', {}, t('auth.i_am')), roles.map(([v, k, d]) => h('label', {}, h('input', { type: 'radio', name: 'role', value: v, checked: v === 'candidate', onchange: () => {
    roleVal = v; orgBox.hidden = v === 'candidate'; for (const i of [org.input, country.input]) { if (v === 'candidate') i.removeAttribute('aria-required'); else i.setAttribute('aria-required', 'true'); }
  } }), h('span', {}, h('strong', {}, t(k)), h('br'), h('span', { class: 'small muted' }, t(d))))));
  const f = form({ submitLabel: t('nav.register'), children: [pick, name.el, email.el, pw.el, orgBox, terms.el, h('p', { class: 'small' }, h('a', { href: '#/terms' }, t('nav.terms')), ' · ', h('a', { href: '#/privacy' }, t('nav.privacy')))], onSubmit: async () => {
    const body = { email: email.input.value.trim(), password: pw.input.value, full_name: name.input.value.trim(), role: roleVal, accept_terms: terms.input.checked, locale: document.documentElement.lang };
    if (roleVal !== 'candidate') body.org = { name: org.input.value.trim(), country: country.input.value.trim() };
    await post('/auth/register', body);
    go(`/verify?email=${encodeURIComponent(body.email)}&sent=1`);
  } });
  return h('div', { class: 'auth-box stack' }, h('h1', {}, t('auth.register_title')), h('div', { class: 'card' }, f), h('p', {}, t('auth.have_account'), ' ', h('a', { href: '#/login' }, t('nav.login'))));
}

function verify({ query }) {
  const email = field({ label: t('auth.email'), name: 'email', type: 'email', value: query.email || '', required: true });
  const code = field({ label: t('auth.code'), name: 'code', required: true, autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6, hint: t('auth.code_hint') });
  const resend = h('button', { class: 'btn secondary', type: 'button' }, t('auth.resend'));
  const msg = h('p', { role: 'status', class: 'small muted' });
  let timer = null;
  const cooldown = (secs) => {
    clearInterval(timer); let left = secs; resend.disabled = true;
    const tick = () => { if (left <= 0) { clearInterval(timer); resend.disabled = false; resend.textContent = t('auth.resend'); } else resend.textContent = t('auth.resend_in', { n: left }); left -= 1; };
    tick(); timer = setInterval(tick, 1000);
  };
  if (query.sent) cooldown(30);
  resend.addEventListener('click', async () => {
    if (!email.input.value.trim()) { setFieldError(email.input, t('v.required')); email.input.focus(); return; }
    resend.disabled = true;
    try { await post('/auth/resend-verification', { email: email.input.value.trim() }); msg.textContent = t('auth.code_sent'); cooldown(30); }
    catch (e) { msg.textContent = tError(e); if (e instanceof ApiError && e.status === 429) cooldown(e.details?.retry_after_seconds || 30); else resend.disabled = false; }
  });
  const f = form({ submitLabel: t('auth.verify'), children: [email.el, code.el], extra: resend, onSubmit: async () => {
    await post('/auth/verify-email', { email: email.input.value.trim(), code: code.input.value.trim() });
    go(`/login?verified=1&email=${encodeURIComponent(email.input.value.trim())}`);
  } });
  return h('div', { class: 'auth-box stack' }, h('h1', {}, t('auth.verify_title')), query.sent ? h('p', { class: 'notice', role: 'status' }, t('auth.code_sent')) : null, h('div', { class: 'card' }, f, msg));
}

function forgot() {
  const email = field({ label: t('auth.email'), name: 'email', type: 'email', required: true });
  return h('div', { class: 'auth-box stack' }, h('h1', {}, t('auth.forgot_title')), h('p', {}, t('auth.forgot_text')),
    h('div', { class: 'card' }, form({ submitLabel: t('auth.send_code'), children: [email.el], onSubmit: async () => { await post('/auth/recover', { email: email.input.value.trim() }); go(`/reset?email=${encodeURIComponent(email.input.value.trim())}`); } })));
}
function reset({ query }) {
  const email = field({ label: t('auth.email'), name: 'email', type: 'email', value: query.email || '', required: true });
  const code = field({ label: t('auth.code'), name: 'code', required: true, autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6 });
  const pw = field({ label: t('auth.new_password'), name: 'new_password', type: 'password', required: true, autocomplete: 'new-password', hint: t('auth.password_hint') });
  return h('div', { class: 'auth-box stack' }, h('h1', {}, t('auth.reset_title')), h('p', { class: 'notice', role: 'status' }, t('auth.reset_sent')),
    h('div', { class: 'card' }, form({ submitLabel: t('auth.reset'), children: [email.el, code.el, pw.el], onSubmit: async () => {
      await post('/auth/recover/confirm', { email: email.input.value.trim(), code: code.input.value.trim(), new_password: pw.input.value }); go('/login?reset=1');
    } })));
}

function mfaSetup() {
  const me = state.me; const root = h('div', { class: 'auth-box stack' }, h('h1', {}, t('mfa.setup_title')));
  if (!me.status.mfa.required) { root.append(h('p', { class: 'notice' }, t('mfa.not_required')), h('a', { class: 'btn', href: `#${homeFor()}` }, t('nav.account'))); return root; }
  if (me.status.mfa.enrolled && me.status.mfa.verified) { root.append(h('p', { class: 'notice ok' }, t('mfa.done')), h('a', { class: 'btn', href: `#${homeFor()}` }, t('nav.account'))); return root; }
  const body = h('div', { class: 'card stack' });
  root.append(h('p', { class: 'notice warn' }, t('mfa.required_text')), body);
  const start = h('button', { class: 'btn', type: 'button' }, t('mfa.start'));
  const showCodes = (codes) => {
    clear(body); const ack = checkbox({ label: t('mfa.saved_ack'), name: 'ack' }); const cont = h('button', { class: 'btn', type: 'button', disabled: true }, t('common.continue'));
    ack.input.addEventListener('change', () => { cont.disabled = !ack.input.checked; });
    cont.addEventListener('click', async () => { await loadMe(); window.dispatchEvent(new Event('fw:me-changed')); go(homeFor()); });
    body.append(h('h2', {}, t('mfa.recovery_title')), h('p', {}, t('mfa.recovery_text')), h('ul', { class: 'codes mono' }, codes.map((c) => h('li', {}, c))), copyButton(codes.join('\n'), t('mfa.copy_codes')), ack.el, cont);
  };
  start.addEventListener('click', async () => {
    start.disabled = true;
    try {
      const r = await post('/auth/mfa/enroll'); clear(body);
      const code = field({ label: t('mfa.code'), name: 'code', required: true, inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, hint: t('mfa.code_hint') });
      body.append(h('h2', {}, t('mfa.secret_title')), h('p', {}, t('mfa.secret_text')), h('p', { class: 'mono card tint', id: 'mfa-secret' }, r.secret), copyButton(r.secret, t('common.copy')),
        h('details', {}, h('summary', {}, t('mfa.url_label')), h('p', { class: 'mono small' }, r.otpauth_url)),
        form({ submitLabel: t('mfa.confirm'), children: [code.el], onSubmit: async () => { const c = await post('/auth/mfa/confirm', { code: code.input.value.trim() }); showCodes(c.recovery_codes); } }));
    } catch (e) { start.disabled = false; toast(tError(e), 'bad'); }
  });
  body.append(h('p', {}, t('mfa.start_text')), start);
  return root;
}
