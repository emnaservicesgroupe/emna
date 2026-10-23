// Email channel for application submissions. Wraps mail.send (sandbox by default; real SMTP only with
// MAIL_PROVIDER=imap_smtp + MAIL_REAL_SEND=true). Never throws for provider problems: every outcome is
// mapped to one of
//   accepted  -> {accepted: true,  outcome: 'accepted', providerMessageId, evidence}
//   refused   -> {accepted: false, outcome: 'refused',  reason, evidence}   definite: nothing was delivered
//   unknown   -> {accepted: false, outcome: 'unknown',  reason, evidence}   timeout/network/5xx/anything else
// The caller (submitter) decides the statuses; 'unknown' is never retried automatically.
//
// Attachments are loaded from storage BY KEY (storage.get validates the key) and re-hashed; the
// filename is generated here, never taken from user input or the stored file.
const crypto = require("crypto");
const storage = require("../storage");

const MAX_REASON = 200;
const STORAGE_KEY_RE = /^[0-9]+-[a-f0-9]{64}\.(pdf|docx|png|jpg)$/;
// Nothing left our side / permanently rejected for this recipient or policy.
const PERMANENT_SMTP = new Set([550, 551, 552, 553, 554]);
const EXT_MIME = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg" };

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function providerName() {
  const n = String(process.env.MAIL_PROVIDER || "sandbox").toLowerCase();
  return n === "imap_smtp" || n === "imapsmtp" ? "imap_smtp" : "sandbox";
}

/** Strips anything that looks like a credential and bounds the length. */
function redact(text) {
  return String(text || "")
    .replace(/(pass(word)?|secret|token|auth|key)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, MAX_REASON);
}

function safeName(s) {
  const t = String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return t || "candidate";
}

/**
 * Loads package documents from storage and verifies their bytes against the recorded sha256.
 * @param {Array<{storageKey: string, sha256: string, kind: string, version?: number, docType?: string}>} refs
 * @param {{candidateName?: string}} [ctx]
 * @returns {Promise<{attachments: object[], problems: string[]}>}
 */
async function loadAttachments(refs, ctx = {}) {
  const attachments = [];
  const problems = [];
  let i = 0;
  for (const r of refs || []) {
    i += 1;
    const label = r.cvFileId ? `cv${r.cvFileId}` : `doc${r.documentId}`;
    const keyMatch = typeof r.storageKey === "string" ? STORAGE_KEY_RE.exec(r.storageKey) : null;
    if (!keyMatch || !r.sha256) {
      problems.push(`attachment_unavailable:${label}`);
      continue;
    }
    let buf;
    try {
      buf = await storage.get(r.storageKey);
    } catch {
      problems.push(`attachment_unavailable:${label}`);
      continue;
    }
    const got = sha256(buf);
    if (got !== r.sha256) {
      problems.push(`attachment_hash_mismatch:${label}`);
      continue;
    }
    const ext = keyMatch[1];
    const base = r.kind === "cv" ? `CV-${safeName(ctx.candidateName)}-v${Number(r.version) || 1}` : `${safeName(r.docType || "document")}-${i}`;
    attachments.push({ filename: `${base}.${ext}`, content: buf, contentType: EXT_MIME[ext] || "application/octet-stream", sha256: got, size: buf.length, ref: { cvFileId: r.cvFileId || null, documentId: r.documentId || null, version: r.version, sha256: r.sha256 } });
  }
  return { attachments, problems };
}

function smtpCode(err) {
  const n = Number(err.responseCode);
  if (Number.isInteger(n) && n >= 200 && n < 600) return n;
  const m = /^\s*([2-5]\d\d)[\s-]/.exec(String(err.response || ""));
  return m ? Number(m[1]) : null;
}

/**
 * 'config'  - our mail setup is wrong (EAUTH / 535 / REQUIRES_SETUP): nothing was sent -> failed + mail_config task
 * 'refused' - permanent recipient/policy rejection (SMTP 550-554, EENVELOPE with a 55x, explicit definite flag) -> failed
 * 'unknown' - timeouts, ECONNRESET, ETIMEDOUT, 4xx transient, anything else -> outcome_unknown (never retried)
 */
function classifyError(err) {
  if (!err) return "unknown";
  const code = smtpCode(err);
  if (err.code === "EAUTH" || code === 535 || err.code === "REQUIRES_SETUP") return "config";
  if (err.definite === true || err.permanent === true) return "refused";
  if (code !== null && PERMANENT_SMTP.has(code)) return "refused";
  return "unknown";
}

/**
 * @param {object} application js_applications row (used for logging context only)
 * @param {{subject: string, text: string, html?: string, headers?: object, attachments: object[]}} pkg loaded attachments
 * @param {string} recipient the guard-verified address
 * @param {{mailSend?: Function}} [ctx] mailSend injectable for tests (default: mail.send)
 */
async function send(application, pkg, recipient, ctx = {}) {
  const sendFn = ctx.mailSend || require("../mail").send;
  const provider = providerName();
  const attachMeta = (pkg.attachments || []).map((a) => ({ filename: a.filename, sha256: a.sha256 || (a.content ? sha256(a.content) : null), size: a.size || (a.content ? a.content.length : 0), ...(a.ref || {}) }));
  const base = { provider, channel: "email", recipient, messageId: pkg.headers && pkg.headers["Message-ID"], attachments: attachMeta };
  let res;
  try {
    res = await sendFn({
      to: recipient,
      subject: pkg.subject,
      text: pkg.text,
      html: pkg.html,
      headers: pkg.headers,
      attachments: (pkg.attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
  } catch (err) {
    const cls = classifyError(err);
    const outcome = cls === "config" ? "refused" : cls;
    const reason = redact(`${(err && err.code) || "error"}${err && smtpCode(err) ? ` ${smtpCode(err)}` : ""}: ${(err && err.message) || err}`);
    return { accepted: false, outcome, configError: cls === "config", providerMessageId: null, reason, evidence: { ...base, providerResponse: { error: reason, code: (err && err.code) || null, smtpCode: (err && smtpCode(err)) || null } } };
  }
  if (!res || typeof res !== "object") {
    return { accepted: false, outcome: "unknown", providerMessageId: null, reason: "provider_returned_nothing", evidence: { ...base, providerResponse: null } };
  }
  const providerResponse = { accepted: res.accepted === true, providerMessageId: res.providerMessageId || null, reason: res.reason ? redact(res.reason) : null };
  if (res.accepted === true) {
    return { accepted: true, outcome: "accepted", providerMessageId: res.providerMessageId || base.messageId || null, evidence: { ...base, providerResponse } };
  }
  // The provider answered and said no (e.g. sandbox allow-list, MAIL_REAL_SEND off): definite refusal.
  return { accepted: false, outcome: "refused", providerMessageId: null, reason: providerResponse.reason || "provider_refused", evidence: { ...base, providerResponse } };
}

module.exports = { send, loadAttachments, classifyError, redact, providerName };
