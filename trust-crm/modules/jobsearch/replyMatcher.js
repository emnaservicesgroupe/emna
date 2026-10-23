// Matches an inbound (UNTRUSTED) employer mail to the application it answers (spec §8, Task 13).
//
//   match(mail) -> { applicationId, confidence: 'high'|'none', reason, submissionId, sender, authenticated }
//
// 'high' ONLY when exactly one application is referenced, by
//   (a) In-Reply-To / References = a stored outbound id (js_submissions.provider_message_id, the planned
//       Message-ID header in js_submissions.evidence.messageIdPlanned, or one of our follow-ups), and/or
//   (b) a [VITA-<token>] reply token (subject / body / To / Reply-To) that verifies by HMAC,
// AND the From address (parsed strictly: one address, no display-name address tricks) is the employer's
// verified contact or at the employer's verified domain / verified contact's domain (never free mail),
// AND no DKIM/DMARC failure is reported. Anything else -> 'none' (review queue). Names, subjects or text
// similarity are never used.
//
//   classifyReply(text) -> { category, evidence[], proposedStatus, instructionLike }
// Deterministic phrase rules; a PROPOSAL only. Nothing here changes any state.
const guard = require("./guard");
const submitter = require("./submitter");
const { db } = require("./inboxShared");
// Note: parseFrom returns {ok, address, domain, name?}.

const MAX_REFS = 50;
const MAX_TOKENS = 10;
const TOKEN_RE = /(?:^|[^a-z0-9])vita-([a-f0-9]{20})(?![a-f0-9])/gi;
const ADDR_LIKE = /[^\s<>"',;:()[\]]+@[^\s<>"',;:()[\]]+/g;

// ---------------------------------------------------------------- parsing

/** '<id@host>' (angle form). Bare 'id@host' is wrapped. Anything else -> null. */
function normalizeMessageId(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 300) return null;
  if (/^<[\x21-\x3b\x3d\x3f-\x7e]+>$/.test(s)) return s;
  if (/^[\x21-\x3b\x3d\x3f-\x7e]+@[\x21-\x3b\x3d\x3f-\x7e]+$/.test(s)) return `<${s}>`;
  return null;
}

/** Message ids from an In-Reply-To / References value (string or array), deduped, capped. */
function messageIdList(...values) {
  const out = [];
  for (const v of values) {
    const parts = Array.isArray(v) ? v : typeof v === "string" ? v.match(/<[^<>\s]+>|[^\s<>,]+@[^\s<>,]+/g) || [] : [];
    for (const p of parts) {
      const id = normalizeMessageId(typeof p === "string" ? p : "");
      if (id && !out.includes(id)) out.push(id);
      if (out.length >= MAX_REFS) return out;
    }
  }
  return out;
}

/**
 * Strict From parsing. Accepts `addr@x` or `Display Name <addr@x>` with exactly ONE address.
 * Display names containing an address ('x@employer.com <evil@evil.com>'), several From values,
 * groups/lists, comments and invalid addresses are refused.
 * @returns {{ok: true, address: string, domain: string} | {ok: false, reason: string}}
 */
function parseFrom(from) {
  let v = from;
  if (Array.isArray(v)) {
    if (v.length !== 1) return { ok: false, reason: v.length ? "multiple_from" : "missing_from" };
    v = v[0];
  }
  let objName = null;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (typeof v.address !== "string") return { ok: false, reason: "invalid_from" };
    if (v.name !== undefined && v.name !== null && typeof v.name !== "string") return { ok: false, reason: "invalid_from" };
    if (typeof v.name === "string" && v.name.includes("@")) return { ok: false, reason: "display_name_spoof" };
    objName = typeof v.name === "string" ? v.name : null;
    v = v.address;
  }
  if (typeof v !== "string" || !v.trim()) return { ok: false, reason: "missing_from" };
  const s = v.trim();
  if (s.length > 500 || /[\r\n\u0000]/.test(s)) return { ok: false, reason: "invalid_from" };
  const angle = /^(?:"([^"]*)"|([^"<>]*?))\s*<([^<>]+)>$/.exec(s);
  let address;
  let display = objName;
  if (angle) {
    display = angle[1] !== undefined ? angle[1] : angle[2] || "";
    if (display.includes("@")) return { ok: false, reason: "display_name_spoof" };
    if (/[,;]/.test(display) && angle[1] === undefined) return { ok: false, reason: "multiple_from" };
    address = angle[3];
  } else {
    if (s.includes("<") || s.includes(">")) return { ok: false, reason: (s.match(/</g) || []).length > 1 ? "multiple_from" : "invalid_from" };
    address = s;
  }
  const all = s.match(ADDR_LIKE) || [];
  if (all.length > 1) return { ok: false, reason: angle ? "display_name_spoof" : "multiple_from" };
  const norm = guard.normalizeEmail(address);
  if (!norm) return { ok: false, reason: "invalid_from" };
  const name = display ? display.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return { ok: true, address: norm, domain: norm.slice(norm.indexOf("@") + 1), ...(name ? { name } : {}) };
}

// ---------------------------------------------------------------- authentication results
//
// Field contract (webhook / poll payload): `authResults` (alias `authenticationResults`) is what the
// receiving MTA / inbound-parse provider computed, as
//   - a string: an Authentication-Results header value ("mx.example; dkim=pass header.d=employer.com; spf=pass; dmarc=pass"),
//   - an array of such strings (one per Authentication-Results header), or
//   - an object {dkim, spf, dmarc, dkimDomain?} whose values are verdict STRINGS.
// The WHOLE value (cap 64 KiB) is scanned: ANY dkim=fail|permerror|temperror or dmarc=fail|permerror|temperror
// anywhere wins ('auth_failed'), so an injected earlier "pass" cannot hide a later failure. Non-string
// members / garbage / oversize values are failures. `authenticated` = no failure AND at least one
// dkim=pass whose header.d / header.i domain equals (or is a parent of) the sender's domain (a pass
// without a d=/i= tag is accepted). SPF is recorded but never decides (forwarding breaks it).
// When the value is absent or carries no verdict, INBOUND_AUTH_REQUIRED (default true; false when
// NODE_ENV=test) decides: true -> 'auth_missing'. A value that is present but unparseable, non-ASCII,
// oversize or of the wrong type is a FAILURE. Acknowledgement evidence ALWAYS needs authenticated
// (aligned d=; a dkim=pass without header.d does not count).
// TRUST: only YOUR OWN receiving MTA's Authentication-Results may be used - the bridge must strip any
// sender-supplied Authentication-Results headers. With INBOUND_AUTHSERV_ID set, only results whose
// authserv-id (first token, e.g. "mx.vita.example") matches are considered (object form: authservId).
const AUTH_CAP = 65536;
const DKIM_FAIL = new Set(["fail", "permerror", "temperror"]);
const DMARC_FAIL = new Set(["fail", "permerror", "temperror"]);

function authRequired() {
  const v = String(process.env.INBOUND_AUTH_REQUIRED || "").trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return process.env.NODE_ENV !== "test";
}

const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.?$/i;

function authList(raw) {
  if (raw === undefined || raw === null || raw === "") return { absent: true };
  if (typeof raw === "string") return { list: [raw] };
  if (Array.isArray(raw)) {
    if (!raw.length) return { absent: true };
    return raw.every((x) => typeof x === "string") ? { list: raw } : { garbage: true };
  }
  if (typeof raw === "object") {
    const parts = [];
    if (raw.authservId !== undefined && typeof raw.authservId !== "string") return { garbage: true };
    for (const k of ["dkim", "spf", "dmarc"]) {
      const v = raw[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string" || !/^[a-z]{1,20}$/i.test(v.trim())) return { garbage: true };
      let seg = `${k}=${v.trim()}`;
      if (k === "dkim" && raw.dkimDomain !== undefined) {
        // a domain only: anything else (e.g. "evil.example; dkim=pass header.d=...") is garbage
        if (typeof raw.dkimDomain !== "string" || !DOMAIN_RE.test(raw.dkimDomain.trim())) return { garbage: true };
        seg += ` header.d=${raw.dkimDomain.trim()}`;
      }
      parts.push(seg);
    }
    if (!parts.length) return Object.keys(raw).length ? { garbage: true } : { absent: true };
    return { list: [`${raw.authservId ? raw.authservId.trim() : "object"}; ${parts.join("; ")}`], object: true };
  }
  return { garbage: true };
}

const aligns = (senderDomain, d) => Boolean(senderDomain && d && d.includes(".") && (senderDomain === d || senderDomain.endsWith(`.${d}`)));
const stripComments = (seg) => seg.replace(/\([^()]*\)/g, " ").replace(/\([^()]*\)/g, " ");

/** authserv-id = the first token of an Authentication-Results value (before ';'). */
function authservIdOf(str) {
  const m = /^\s*([^\s;]+)/.exec(str);
  return m ? m[1].toLowerCase() : "";
}

/**
 * @returns {{present: boolean, failed: boolean, authenticated: boolean, verdicts: {dkim: string[], spf: string[], dmarc: string[]}|null, reason?: string}}
 */
function evaluateAuth(raw, senderDomain) {
  const a = authList(raw);
  if (a.garbage) return { present: true, failed: true, authenticated: false, verdicts: null, reason: "garbage" };
  if (a.absent) return { present: false, failed: false, authenticated: false, verdicts: null };
  if (a.list.length > 50 || a.list.reduce((n, x) => n + x.length, 0) > AUTH_CAP) return { present: true, failed: true, authenticated: false, verdicts: null, reason: "oversize" };
  // Real Authentication-Results are ASCII; non-ASCII (look-alike letters, fullwidth '=') is a failure.
  if (a.list.some((x) => /[^\x09\x0a\x0d\x20-\x7e]/.test(x))) return { present: true, failed: true, authenticated: false, verdicts: null, reason: "non_ascii" };
  let list = a.list;
  const servId = String(process.env.INBOUND_AUTHSERV_ID || "").trim().toLowerCase();
  if (servId) {
    list = list.filter((x) => authservIdOf(x) === servId);
    if (!list.length) return { present: false, failed: false, authenticated: false, verdicts: null, reason: "no_trusted_authserv" };
  }
  const verdicts = { dkim: [], spf: [], dmarc: [] };
  let aligned = false;
  let anyFailToken = false;
  for (const str of list) {
    // failure scan over the WHOLE value, comments included: any fail anywhere wins
    if (/(?:^|[^a-z0-9])dkim\s*=\s*(?:fail|permerror|temperror)\b/i.test(str) || /(?:^|[^a-z0-9])dmarc\s*=\s*(?:fail|permerror|temperror)\b/i.test(str)) anyFailToken = true;
    for (const seg0 of str.split(/[;\n]/)) {
      const seg = stripComments(seg0);
      for (const m of seg.matchAll(/(?:^|[\s])(dkim|spf|dmarc)\s*=\s*([a-z]+)/gi)) verdicts[m[1].toLowerCase()].push(m[2].toLowerCase());
      if (/(?:^|\s)dkim\s*=\s*pass\b/i.test(seg)) {
        // alignment needs the signing domain d= (outside comments); header.i alone is not enough
        const d = /(?:^|\s)header\.d\s*=\s*([a-z0-9.-]+)/i.exec(seg);
        if (d && aligns(senderDomain, d[1].toLowerCase().replace(/\.+$/, ""))) aligned = true;
      }
    }
  }
  const failed = anyFailToken || verdicts.dkim.some((v) => DKIM_FAIL.has(v)) || verdicts.dmarc.some((v) => DMARC_FAIL.has(v));
  if (!failed && !verdicts.dkim.length && !verdicts.spf.length && !verdicts.dmarc.length) {
    // a value that is present but carries no verdict is garbage -> failure (only truly absent is absent)
    return { present: true, failed: true, authenticated: false, verdicts: null, reason: "unparseable" };
  }
  return { present: true, failed, authenticated: !failed && aligned, verdicts };
}

/** Back-compat summary {dkim, spf, dmarc} (first verdict of each) - display only, never a decision. */
function parseAuthResults(raw) {
  const e = evaluateAuth(raw, null);
  if (!e.verdicts) return null;
  return { dkim: e.verdicts.dkim[0] || null, spf: e.verdicts.spf[0] || null, dmarc: e.verdicts.dmarc[0] || null };
}

// ---------------------------------------------------------------- auto-replies and bounces

const AUTO_SUBJECT = /\b(?:out of (?:the )?office|automatic reply|auto(?:matic)?[- ]?(?:reply|response|responder)|autoreply|vacation|on leave|absence|absent du bureau|reponse automatique|réponse automatique|abwesenheit)\b/i;
const BOUNCE_SUBJECT = /\b(?:delivery status notification|undeliver(?:ed|able)|mail delivery (?:failed|failure|subsystem)|returned mail|delivery (?:has )?failed|failure notice|non[- ]?remis|non distribu)/i;

/** Auto-replies (RFC 3834 auto-replied, X-Autoreply, Precedence bulk/junk/auto_reply, OOO subjects). 'auto-generated' notices (ATS acknowledgements) are not auto-replies. */
function isAutoReply(m) {
  const h = (m && m.autoHeaders) || {};
  const as = String(h.autoSubmitted || "").trim().toLowerCase();
  if (as && as !== "no" && as !== "auto-generated") return true;
  if (/^(?:bulk|junk|list|auto_reply)$/i.test(String(h.precedence || "").trim())) return true;
  if (h.xAutoreply || h.xAutorespond) return true;
  return AUTO_SUBJECT.test(String((m && m.subject) || ""));
}

/** Bounce / DSN: MAILER-DAEMON or postmaster sender, multipart/report delivery-status, or a DSN subject. */
function isBounce(m) {
  const from = parseFrom(m && m.from);
  const local = from.ok ? from.address.split("@")[0] : String((m && m.from) || "").toLowerCase();
  if (/^(?:mailer-daemon|postmaster|mail-daemon)$/i.test(local) || /mailer-daemon|postmaster@/i.test(local)) return true;
  const ct = String((m && m.autoHeaders && m.autoHeaders.contentType) || "").toLowerCase();
  if (/multipart\/report/.test(ct) && /delivery-status/.test(ct)) return true;
  return BOUNCE_SUBJECT.test(String((m && m.subject) || ""));
}

/** Domains a genuine DSN for OUR mail comes from: INBOUND_BOUNCE_DOMAINS (comma list) + our MAIL_FROM domain. */
function bounceDomains() {
  const out = new Set(String(process.env.INBOUND_BOUNCE_DOMAINS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
  const from = guard.normalizeEmail(String(process.env.MAIL_FROM || ""));
  if (from) out.add(from.slice(from.indexOf("@") + 1));
  return out;
}

/**
 * A DSN we are willing to open a staff task for: MAILER-DAEMON/postmaster at the sending provider's
 * domain (or a subdomain), or a multipart/report; report-type=delivery-status message. Everything
 * else that merely LOOKS like a bounce (subject words) is handled as a normal message.
 */
function isPlausibleBounce(m) {
  const from = parseFrom(m && m.from);
  const ct = String((m && m.autoHeaders && m.autoHeaders.contentType) || "").toLowerCase();
  if (/multipart\/report/.test(ct) && /report-type\s*=\s*"?delivery-status/.test(ct)) return true;
  if (!from.ok || !/^(?:mailer-daemon|postmaster)$/i.test(from.address.split("@")[0])) return false;
  return [...bounceDomains()].some((d) => from.domain === d || from.domain.endsWith(`.${d}`));
}

/** {hard, code} from a DSN body: a 5.x.x enhanced status (or 'Action: failed') is hard. */
function bounceStatus(text) {
  const t = String(text || "").slice(0, 60000);
  const five = /\b(5\.\d{1,3}\.\d{1,3})\b/.exec(t);
  if (five) return { hard: true, code: five[1] };
  if (/\baction\s*:\s*failed\b/i.test(t)) return { hard: true, code: "action_failed" };
  const four = /\b(4\.\d{1,3}\.\d{1,3})\b/.exec(t);
  return { hard: false, code: four ? four[1] : null };
}

/** Our own addresses / domain (loop protection). */
function ownAddresses() {
  const out = new Set();
  for (const v of [process.env.MAIL_FROM, process.env.MAIL_REPLY_TO, "vita@test.invalid"]) {
    const a = guard.normalizeEmail(String(v || ""));
    if (a) out.add(a);
  }
  return out;
}
function isOwnAddress(address) {
  if (!address) return false;
  const own = ownAddresses();
  if (own.has(address)) return true;
  const domain = address.slice(address.indexOf("@") + 1);
  return [...own].some((a) => a.slice(a.indexOf("@") + 1) === domain);
}

function tokensIn(...values) {
  const out = [];
  for (const v of values) {
    const s = (Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : "").slice(0, 60000);
    for (const m of s.matchAll(TOKEN_RE)) {
      const t = `VITA-${m[1].toLowerCase()}`;
      if (!out.includes(t)) out.push(t);
      if (out.length >= MAX_TOKENS) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------- employer check

/**
 * Exact verified contact address, or an address at the employer's verified domain (never free mail).
 * Without an employer domain only the exact verified contact matches (agency / free-mail contacts).
 */
function senderMatchesEmployer(employer, address) {
  if (!employer || !address) return false;
  return guard.verifyRecipient({ domain: employer.domain, verified_contact_email: employer.verified_contact_email }, address, null);
}

// ---------------------------------------------------------------- match

const none = (reason, extra = {}) => ({ applicationId: null, confidence: "none", reason, submissionId: null, ...extra });

/**
 * @param {object} mail normalized inbound mail {messageId, inReplyTo, references[], from, to, replyTo?, subject, text, authResults?}
 * @param {{client?: object}} [opts]
 */
async function match(mail, opts = {}) {
  const c = opts.client || db();
  const m = mail && typeof mail === "object" ? mail : {};
  const from = parseFrom(m.from);
  if (!from.ok) return none(from.reason);
  const auth = evaluateAuth(m.authResults, from.domain);
  const authenticated = auth.authenticated;
  if (auth.failed) return none("auth_failed", { sender: from.address, authenticated: false, auth });
  if (!auth.present && authRequired()) return none("auth_missing", { sender: from.address, authenticated: false, auth });
  if (isOwnAddress(from.address)) return none("own_address", { sender: from.address, authenticated, auth });

  const refs = messageIdList(m.inReplyTo, m.references);
  const byRef = new Map(); // applicationId -> submissionId|null
  if (refs.length) {
    const subs = (await c.query(
      "SELECT id, application_id FROM js_submissions WHERE provider_message_id = ANY($1::text[]) OR evidence->>'messageIdPlanned' = ANY($1::text[]) ORDER BY id DESC",
      [refs]
    )).rows;
    for (const s of subs) if (!byRef.has(s.application_id)) byRef.set(s.application_id, s.id);
    const outs = (await c.query(
      "SELECT DISTINCT application_id FROM js_messages WHERE direction = 'out' AND application_id IS NOT NULL AND status = 'sent' AND (message_id = ANY($1::text[]) OR provider_message_id = ANY($1::text[]))",
      [refs]
    )).rows;
    for (const o of outs) if (!byRef.has(o.application_id)) byRef.set(o.application_id, null);
  }
  const byToken = new Map();
  for (const t of tokensIn(m.subject, m.text, m.to, m.replyTo)) {
    const sub = await submitter.findByReplyToken(t, c);
    if (sub && !byToken.has(sub.application_id)) byToken.set(sub.application_id, sub.id);
  }
  const apps = new Set([...byRef.keys(), ...byToken.keys()]);
  if (apps.size === 0) return none(refs.length ? "unknown_reference" : "no_reference", { sender: from.address, authenticated, auth });
  if (apps.size > 1) return none("ambiguous", { sender: from.address, authenticated, auth });
  const [applicationId] = apps;
  const row = (await c.query(
    `SELECT a.id, a.status, c.is_deleted, e.domain, e.verified_contact_email,
            (SELECT p.confirmed->>'email' FROM js_profiles p WHERE p.candidate_id = a.candidate_id) AS profile_email,
            (SELECT u.email FROM js_candidate_accounts ca JOIN users u ON u.id = ca.user_id WHERE ca.candidate_id = a.candidate_id LIMIT 1) AS account_email
       FROM js_applications a JOIN candidates c ON c.id = a.candidate_id
       LEFT JOIN js_jobs j ON j.id = a.job_id LEFT JOIN js_employers e ON e.id = j.employer_id
      WHERE a.id = $1`,
    [applicationId]
  )).rows[0];
  if (!row || row.is_deleted) return none("application_unavailable", { sender: from.address, authenticated, auth });
  const candidateAddrs = [row.profile_email, row.account_email].map((x) => guard.normalizeEmail(String(x || ""))).filter(Boolean);
  if (candidateAddrs.includes(from.address)) return none("candidate_sender", { sender: from.address, authenticated, auth });
  if (!senderMatchesEmployer(row, from.address)) return none("sender_domain_mismatch", { sender: from.address, authenticated, auth });
  const via = byRef.has(applicationId) && byToken.has(applicationId) ? "reference_and_token" : byRef.has(applicationId) ? "reference" : "token";
  return {
    applicationId,
    confidence: "high",
    reason: `matched_${via}`,
    submissionId: byRef.get(applicationId) || byToken.get(applicationId) || null,
    sender: from.address,
    authenticated,
    auth,
  };
}

// ---------------------------------------------------------------- classification (proposal only)

const RULES = [
  ["rejection", [
    /\bregret to inform\b/, /\bunfortunately\b/, /\b(?:decided|chosen) to (?:move forward|proceed|continue) with other\b/, /\bnot (?:be )?(?:moving|progressing|proceeding) (?:forward )?with your\b/,
    /\b(?:have|has) not been successful\b/, /\bposition has (?:now )?been filled\b/, /\bnous (?:sommes au )?regret(?:tons|s)\b/, /\bmalheureusement\b/,
    /\bpas (?:ete )?retenue?s?\b/, /\bne pas donner suite\b/, /\bne (?:pouvons|pourrons) pas donner suite\b/,
  ]],
  ["offer", [
    /\b(?:pleased|happy|delighted|glad) to (?:extend (?:you )?|make you |offer you)/, /\bwe (?:would like|want|are pleased) to offer you\b/, /\boffer of employment\b/, /\boffer letter\b/,
    /\bnous avons le plaisir de vous (?:proposer|offrir)\b/, /\bproposition d'?embauche\b/, /\bpromesse d'?embauche\b/,
  ]],
  ["interview_request", [
    /\binterviews?\b/, /\bentretiens?\b/, /\bentrevue\b/, /\bschedule a (?:call|meeting|video call)\b/, /\binvite you (?:to|for) (?:a |an )?(?:call|meeting|interview)\b/,
    /\bavailable for a (?:call|meeting|phone call)\b/, /\bvos disponibilites\b/,
  ]],
  ["info_request", [
    /\bplease (?:send|provide|share|submit|forward)\b/, /\bcould you (?:please )?(?:send|provide|share)\b/, /\bwe (?:need|require) (?:a copy|your|additional|further)\b/,
    /\bmerci de (?:nous )?(?:envoyer|transmettre|fournir|faire parvenir)\b/, /\bpourriez-vous (?:nous )?(?:envoyer|transmettre|fournir)\b/,
  ]],
  ["acknowledgement", [
    /\breceived your application\b/, /\b(?:your )?application (?:has been|was) (?:successfully )?received\b/, /\b(?:candidature|dossier) a (?:bien )?ete recue?\b/, /\bthank you for applying\b/, /\bnous avons bien recu\b/, /\baccuse de reception\b/, /\bthank you for your application\b/,
  ]],
];
const PROPOSED_STATUS = { rejection: "rejected", offer: "offer", interview_request: "interview" };
const INSTRUCTION_LIKE = [/\bignore (?:all |any )?(?:the )?(?:previous|prior|above) instructions?\b/, /\b(?:mark|set|change|update) (?:this|the) application\b/, /\bsystem prompt\b/, /\byou are (?:now )?an? (?:ai|assistant)\b/, /\bsend (?:me |us )?(?:the |your )?passport\b/];

function foldText(text) {
  return String(text || "")
    .slice(0, 20000)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------- acknowledgement (asymmetric safety)
//
// Evidence from a reply is only taken when the WHOLE message is a plain acknowledgement: missing
// evidence is cheap (staff confirm by hand), false evidence is not. After removing a small list of
// benign boilerplate negations, ANY negation / failure / request / hedge / rejection marker anywhere
// in the (folded, capped) text - or any non-ASCII letter left after folding (look-alike letters,
// zero-width characters) - vetoes the acknowledgement. All patterns are plain alternations of
// literals (linear time).
const BENIGN = [
  /\b(?:please )?do not (?:reply|respond)(?: directly)?(?: to this (?:automated |automatic |auto-generated )?(?:message|email|e-mail|mail|address|notification))?\b/g,
  /\bno later than\b/g,
  /\bno (?:further )?action is (?:required|needed|necessary)\b/g,
  /\bno-?reply\b/g,
  /\b(?:merci de )?ne pas repondre(?: a ce (?:message|courriel|mail|e-mail))?\b/g,
  /\baucune action (?:n'est |est )?(?:requise|necessaire)\b/g,
  /\bwill not hear back (?:from us )?unless\b/g,
  /\bnous ne manquerons pas de\b/g,
];
const VETO = new RegExp([
  "\\bnot\\b", "n't\\b", "\\b(?:havent|hasnt|hadnt|didnt|dont|doesnt|cant|wont|couldnt|wouldnt|shouldnt|isnt|arent|wasnt|werent)\\b",
  "\\bnever\\b", "\\bno longer\\b", "\\bunable\\b", "\\bcannot\\b", "\\bfail", "\\bmissing\\b", "\\bincomplet", "\\bcorrupt", "\\bblank\\b", "\\bempty\\b",
  "\\bunreadable\\b", "\\billisible\\b", "\\bcould\\b", "\\bcan you\\b", "\\bplease\\b", "\\bkindly\\b", "\\bhowever\\b", "\\bbut\\b", "\\btoutefois\\b", "\\bcependant\\b",
  "\\bmais\\b", "\\bmalheureusement\\b", "\\bunfortunately\\b", "\\bsadly\\b", "\\bregret", "\\bsorry\\b", "\\bdesole", "\\bpas\\b", "\\bne\\b", "\\bn'", "\\baucun",
  "\\bsans\\b", "\\bmanqu", "\\bveuillez\\b", "\\bmerci de\\b", "\\brenvoy", "\\benvoy", "\\bresend", "\\bre-send", "\\bresubmit", "\\bre-?upload", "\\bupload",
  "\\bfilled\\b", "\\bpourvu", "\\bposition has been\\b", "\\bclosed\\b", "\\bdeclin", "\\breject", "\\bnot selected\\b", "\\bmoving forward\\b",
  "\\bretenu", "\\bretenons\\b", "\\banother candidate\\b", "\\bother candidates\\b", "\\bwrong\\b", "\\btoo (?:large|big|small)\\b", "\\berror\\b", "\\bproblem",
  "\\bissue\\b", "\\bwaiting\\b", "\\bawait", "\\bpending\\b", "\\byet\\b", "\\bstill\\b", "\\battente\\b", "\\bencore\\b", "\\binvalid\\b", "\\bwhether\\b", "\\bunable\\b", "\\bimpossible\\b", "\\bdid you\\b", "\\bno idea\\b", "\\bonly if\\b", "\\bexcept\\b",
  "\\?",
].join("|"));
const PUNCT_MAP = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "“": '"', "”": '"', "„": '"', "«": '"', "»": '"', "–": "-", "—": "-", "…": "...", " ": " ", " ": " " };

/** Folded text for the acknowledgement veto: typographic punctuation mapped to ASCII. */
function ackFold(text) {
  return foldText(text).replace(/[‘’‚‛′“”„«»–—…  ]/g, (c) => PUNCT_MAP[c]);
}

/**
 * Whole-message veto. @returns {string|null} the veto reason, or null when the text may count as an acknowledgement.
 */
function ackVeto(...texts) {
  if (texts.some((x) => String(x || "").length > 20000)) return "too_long";
  let t = texts.map(ackFold).join("\n");
  for (const re of BENIGN) t = t.replace(re, " ");
  if (/[^\x00-\x7f]/.test(t)) return "non_ascii";
  const v = VETO.exec(t);
  return v ? `veto:${v[0].trim().slice(0, 30)}` : null;
}

/** True only for a whole-message, un-negated acknowledgement (see ackVeto) with no other category. */
function isAcknowledgement(text) {
  return classifyReply(text).acknowledgement;
}

/**
 * Deterministic, injection-safe classification of a SANITIZED reply body. Only proposes.
 * @returns {{category: string, evidence: {category: string, phrase: string}[], proposedStatus: string|null, instructionLike: boolean, acknowledgement: boolean}}
 */
function classifyReply(text) {
  const t = foldText(text);
  const evidence = [];
  for (const [category, patterns] of RULES) {
    for (const re of patterns) {
      const hit = re.exec(t);
      if (hit) evidence.push({ category, phrase: hit[0].trim().slice(0, 80) });
    }
  }
  const hasAck = evidence.some((e) => e.category === "acknowledgement");
  const otherCategory = evidence.some((e) => e.category !== "acknowledgement");
  const veto = hasAck ? (otherCategory ? "other_category" : ackVeto(text)) : null;
  const acknowledgement = hasAck && !veto;
  // a vetoed acknowledgement is not reported as one
  const kept = acknowledgement ? evidence : evidence.filter((e) => e.category !== "acknowledgement");
  const first = RULES.map(([cat]) => cat).find((cat) => kept.some((e) => e.category === cat));
  const category = first || "other";
  return { category, evidence: kept.slice(0, 20), proposedStatus: PROPOSED_STATUS[category] || null, instructionLike: INSTRUCTION_LIKE.some((re) => re.test(t)), acknowledgement, ...(veto ? { ackVeto: veto } : {}) };
}

module.exports = { match, classifyReply, isAcknowledgement, evaluateAuth, authRequired, isAutoReply, isBounce, isPlausibleBounce, bounceStatus, ackVeto, isOwnAddress, parseFrom, parseAuthResults, normalizeMessageId, messageIdList, tokensIn, senderMatchesEmployer, PROPOSED_STATUS };
