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
  if (v && typeof v === "object" && typeof v.address === "string") {
    if (typeof v.name === "string" && v.name.includes("@")) return { ok: false, reason: "display_name_spoof" };
    v = v.address;
  }
  if (typeof v !== "string" || !v.trim()) return { ok: false, reason: "missing_from" };
  const s = v.trim();
  if (s.length > 500 || /[\r\n\u0000]/.test(s)) return { ok: false, reason: "invalid_from" };
  const angle = /^(?:"([^"]*)"|([^"<>]*?))\s*<([^<>]+)>$/.exec(s);
  let address;
  if (angle) {
    const display = angle[1] !== undefined ? angle[1] : angle[2] || "";
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
  return { ok: true, address: norm, domain: norm.slice(norm.indexOf("@") + 1) };
}

/** {dkim, spf, dmarc} verdicts from an object or an Authentication-Results header string. */
function parseAuthResults(raw) {
  if (!raw) return null;
  const pick = (v) => (typeof v === "string" && /^[a-z]{2,12}$/i.test(v.trim()) ? v.trim().toLowerCase() : null);
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const out = { dkim: pick(raw.dkim), spf: pick(raw.spf), dmarc: pick(raw.dmarc) };
    return out.dkim || out.spf || out.dmarc ? out : null;
  }
  const s = Array.isArray(raw) ? raw.join(";") : String(raw);
  const get = (k) => {
    const m = new RegExp(`\\b${k}\\s*=\\s*([a-z]+)`, "i").exec(s.slice(0, 4000));
    return m ? m[1].toLowerCase() : null;
  };
  const out = { dkim: get("dkim"), spf: get("spf"), dmarc: get("dmarc") };
  return out.dkim || out.spf || out.dmarc ? out : null;
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

/** Exact verified contact, or the employer's verified domain / verified contact's domain (never free mail). */
function senderMatchesEmployer(employer, address) {
  if (!employer || !address) return false;
  if (guard.verifyRecipient({ domain: employer.domain, verified_contact_email: employer.verified_contact_email }, address, null)) return true;
  const contact = guard.normalizeEmail(employer.verified_contact_email || "");
  if (!contact) return false;
  const contactDomain = contact.slice(contact.indexOf("@") + 1);
  return guard.verifyRecipient({ domain: contactDomain }, address, null);
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
  const auth = parseAuthResults(m.authResults);
  const authenticated = Boolean(auth && auth.dkim === "pass");
  if (auth && (["fail", "permerror"].includes(auth.dkim) || auth.dmarc === "fail")) return none("auth_failed", { sender: from.address, authenticated: false });

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
  if (apps.size === 0) return none(refs.length ? "unknown_reference" : "no_reference", { sender: from.address, authenticated });
  if (apps.size > 1) return none("ambiguous", { sender: from.address, authenticated });
  const [applicationId] = apps;
  const row = (await c.query(
    `SELECT a.id, a.status, c.is_deleted, e.domain, e.verified_contact_email
       FROM js_applications a JOIN candidates c ON c.id = a.candidate_id
       LEFT JOIN js_jobs j ON j.id = a.job_id LEFT JOIN js_employers e ON e.id = j.employer_id
      WHERE a.id = $1`,
    [applicationId]
  )).rows[0];
  if (!row || row.is_deleted) return none("application_unavailable", { sender: from.address, authenticated });
  if (!senderMatchesEmployer(row, from.address)) return none("sender_domain_mismatch", { sender: from.address, authenticated });
  const via = byRef.has(applicationId) && byToken.has(applicationId) ? "reference_and_token" : byRef.has(applicationId) ? "reference" : "token";
  return {
    applicationId,
    confidence: "high",
    reason: `matched_${via}`,
    submissionId: byRef.get(applicationId) || byToken.get(applicationId) || null,
    sender: from.address,
    authenticated,
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
    /\breceived your application\b/, /\bthank you for applying\b/, /\bnous avons bien recu\b/, /\baccuse de reception\b/, /\bthank you for your application\b/,
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

/**
 * Deterministic, injection-safe classification of a SANITIZED reply body. Only proposes.
 * @returns {{category: string, evidence: {category: string, phrase: string}[], proposedStatus: string|null, instructionLike: boolean}}
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
  const first = RULES.map(([cat]) => cat).find((cat) => evidence.some((e) => e.category === cat));
  const category = first || "other";
  return { category, evidence: evidence.slice(0, 20), proposedStatus: PROPOSED_STATUS[category] || null, instructionLike: INSTRUCTION_LIKE.some((re) => re.test(t)) };
}

module.exports = { match, classifyReply, parseFrom, parseAuthResults, normalizeMessageId, messageIdList, tokensIn, senderMatchesEmployer, PROPOSED_STATUS };
