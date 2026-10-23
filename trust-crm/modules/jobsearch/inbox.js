// Inbound employer mail: storage, matching, review queue (spec §8, Task 13).
//
//   normalizeInbound(raw)                 validates/sanitizes a pushed or polled message (UNTRUSTED)
//   ingest(mail)                          idempotent by Message-ID; matched -> attached + timeline + events
//                                         (+ for an eligible 'high' acknowledgement: a confirm_acknowledgement staff
//                                         task by default; automatic evidence only with INBOUND_AUTO_ACK_EVIDENCE=true);
//                                         otherwise review_state 'needs_review' + one 'unmatched_reply' task
//   pollAndStore()                        polls the configured provider (sandbox) and ingests
//   ingestDeliveryStatus(evt)             provider delivery event -> delivery_receipt evidence (system-only)
//   assignReview({messageId, applicationId, actor})   staff (jobsearch:approve + scope on BOTH)
//   confirmAcknowledgement({messageId, actor})        staff click -> employer_acknowledgement evidence (user actor)
//   shareWithCandidate({messageId, actor})            releases the neutral summary to the candidate
//   applyClassification({messageId, actor, status, reason})  staff-made status change (never automatic)
//   listMessages({user, query}) / getMessage({user, id})     scoped
//
// Message content is DATA: nothing in a body/subject can change a status, share a document or send mail.
// Bodies are sanitized (markup/scripts stripped, capped); attachments are never opened or stored - only
// sanitized metadata is kept, and executables are dropped.
const { sanitizeUntrusted } = require("./matching/sanitize");
const { candidateScopeSql } = require("./scope");
const applicationService = require("./applicationService");
const submitter = require("./submitter");
const matcher = require("./replyMatcher");
const draftService = require("./draftService");
const S = require("./inboxShared");

const { httpErr, oneLine } = S;
const SYSTEM_ACTOR = "system:inbox";
const BODY_MAX = 20000;
const MAX_ATTACHMENTS = 20;
const EXEC_EXT = /\.(exe|com|bat|cmd|scr|pif|msi|msp|mst|dll|cpl|sys|drv|js|jse|mjs|vbs|vbe|wsf|wsh|wsc|hta|ps1|psm1|psd1|sh|bash|zsh|csh|ksh|jar|class|apk|app|dmg|pkg|deb|rpm|lnk|url|reg|inf|iso|img|vhd|vhdx|docm|dotm|xlsm|xltm|xlam|pptm|potm|ppam|sldm|run|bin|elf|gadget|msc|application|appref-ms|chm|xll|svg|html?|xht|xhtml|mht|mhtml)$/i;
const REVIEW_ROLES = ["Admin", "SuperAdmin", "Manager"];
const CLASSIFIABLE = ["interview", "offer", "rejected"];
const NORMALIZED = new WeakSet(); // objects produced by normalizeInbound (anything else is re-normalized)

// ---------------------------------------------------------------- normalization

function sniff(base64) {
  if (typeof base64 !== "string" || !base64) return null;
  let head;
  try {
    head = Buffer.from(base64.replace(/\s+/g, "").slice(0, 24), "base64"); // first 18 bytes only; never stored
  } catch {
    return null;
  }
  const hex = head.toString("hex");
  if (hex.startsWith("4d5a")) return { mime: "application/x-msdownload", executable: true };
  if (hex.startsWith("7f454c46")) return { mime: "application/x-elf", executable: true };
  if (hex.startsWith("2321")) return { mime: "text/x-script", executable: true };
  if (hex.startsWith("cafebabe") || hex.startsWith("feedface") || hex.startsWith("cffaedfe")) return { mime: "application/x-mach-binary", executable: true };
  if (hex.startsWith("25504446")) return { mime: "application/pdf", executable: false };
  if (hex.startsWith("504b0304")) return { mime: "application/zip", executable: false };
  if (hex.startsWith("89504e47")) return { mime: "image/png", executable: false };
  if (hex.startsWith("ffd8ff")) return { mime: "image/jpeg", executable: false };
  if (hex.startsWith("d0cf11e0")) return { mime: "application/x-ole-storage", executable: false };
  return { mime: "application/octet-stream", executable: false };
}

function cleanFileName(name) {
  const base = String(name || "").normalize("NFKC").split(/[\\/]/).pop();
  const s = base.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿"<>|:*?]/g, "").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return s.slice(-120) || "attachment";
}

/** Attachment METADATA only. Content (if any was pushed) is never stored or opened; executables dropped. */
function attachmentMeta(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ATTACHMENTS).map((a) => {
    const x = a && typeof a === "object" ? a : {};
    const name = cleanFileName(x.filename || x.name);
    const size = Number.isSafeInteger(Number(x.size)) && Number(x.size) >= 0 ? Number(x.size) : null;
    const declared = typeof x.contentType === "string" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(x.contentType.trim()) ? x.contentType.trim().toLowerCase() : null;
    const sniffed = sniff(x.contentBase64 || x.content);
    const executable = EXEC_EXT.test(name) || Boolean(sniffed && sniffed.executable) || /x-msdownload|x-executable|x-sh\b|javascript|x-msdos/.test(declared || "");
    const out = { name, size, declaredType: declared, sniffedType: sniffed ? sniffed.mime : null };
    return executable ? { ...out, dropped: true, reason: "executable" } : { ...out, dropped: false };
  });
}

function listOf(v, max) {
  if (Array.isArray(v)) return v.map((x) => oneLine(x, 320)).filter(Boolean).slice(0, max);
  return typeof v === "string" && v.trim() ? [oneLine(v, 1000)] : [];
}

/**
 * Validates and sanitizes an inbound message. Required: messageId. Everything is treated as data.
 * @returns {object} normalized mail
 */
function normalizeInbound(raw) {
  const m = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!m) throw httpErr(400, "message must be a JSON object");
  const messageId = matcher.normalizeMessageId(m.messageId);
  if (!messageId) throw httpErr(400, "messageId is required (an RFC 5322 Message-ID)");
  const received = m.receivedAt ? new Date(m.receivedAt) : null;
  const text = typeof m.text === "string" && m.text.trim() ? m.text : typeof m.html === "string" ? m.html : "";
  const out = {
    messageId,
    inReplyTo: typeof m.inReplyTo === "string" ? oneLine(m.inReplyTo, 320) : null,
    references: matcher.messageIdList(m.references),
    from: Array.isArray(m.from) ? m.from.map((f) => (typeof f === "string" ? oneLine(f, 500) : f)) : typeof m.from === "string" ? m.from.slice(0, 600) : m.from && typeof m.from === "object" ? m.from : null,
    to: listOf(m.to, 20).join(", ").slice(0, 1000),
    replyTo: listOf(m.replyTo, 5).join(", ").slice(0, 600),
    subject: sanitizeUntrusted(oneLine(m.subject, 400), 300),
    text: sanitizeUntrusted(text, BODY_MAX),
    // classification copy: same sanitizer, but leading '>' quote prefixes survive (the sanitizer strips them),
    // so the classifier can tell a real trailing quoted block from prose; never stored
    classText: typeof m.text === "string" && m.text.trim() ? classifiableText(m.text) : null,
    receivedAt: received && !isNaN(received) ? received.toISOString() : new Date().toISOString(),
    attachments: attachmentMeta(m.attachments),
    // raw value kept for the matcher's evaluation (see replyMatcher field contract); never stored raw
    authResults: m.authResults !== undefined ? m.authResults : m.authenticationResults,
    autoHeaders: autoHeadersOf(m),
    // Message-IDs quoted in the RAW body (DSNs quote the original id; the sanitizer strips <...>)
    quotedIds: quotedIdsOf(text),
  };
  NORMALIZED.add(out);
  return out;
}

const QMARK = "vitaquotemark";
/** Sanitized text with line-leading '>' quote prefixes kept (as '> ' x depth). Writing the marker literally = writing '>'. */
function classifiableText(raw) {
  const prot = String(raw).slice(0, 60000).replace(/^[ \t]*((?:>[ \t]?)+)/gm, (_m, g) => `${QMARK}${Math.min((g.match(/>/g) || []).length, 20)} `);
  return sanitizeUntrusted(prot, BODY_MAX).replace(/(^|\n)[ \t]*vitaquotemark(\d+) ?/g, (_m, nl, d) => `${nl}${">".repeat(Number(d))} `);
}

function quotedIdsOf(rawText) {
  const t = String(rawText || "").slice(0, 60000);
  const angle = t.match(/<[^<>\s]{1,300}@[^<>\s]{1,255}>/g) || [];
  const labelled = [...t.matchAll(/message-id\s*:\s*<?([^\s<>]{1,300}@[^\s<>]{1,255})>?/gi)].map((x) => x[1]);
  return matcher.messageIdList([...angle, ...labelled].slice(0, 100));
}

/** Auto-reply / report markers from `headers` (any case) or top-level fields. Strings only. */
function autoHeadersOf(m) {
  const h = m.headers && typeof m.headers === "object" && !Array.isArray(m.headers) ? m.headers : {};
  const lower = {};
  for (const [k, v] of Object.entries(h).slice(0, 200)) if (typeof v === "string") lower[k.toLowerCase()] = v;
  const pickStr = (...vals) => {
    const v = vals.find((x) => typeof x === "string" && x.trim());
    return v ? oneLine(v, 200) : null;
  };
  return {
    autoSubmitted: pickStr(m.autoSubmitted, lower["auto-submitted"]),
    precedence: pickStr(m.precedence, lower.precedence),
    xAutoreply: pickStr(lower["x-autoreply"], lower["x-autorespond"] ? null : undefined),
    xAutorespond: pickStr(lower["x-autorespond"]),
    contentType: pickStr(m.contentType, lower["content-type"]),
  };
}

/** Sandbox / poll format -> raw inbound object. */
function fromPolled(p) {
  const h = (p && p.headers) || {};
  const hv = (k) => h[k] || h[k.toLowerCase()];
  return {
    messageId: p.providerMessageId || hv("Message-ID"),
    inReplyTo: hv("In-Reply-To"),
    references: hv("References"),
    from: p.from,
    to: p.to,
    replyTo: hv("Reply-To"),
    subject: p.subject,
    text: p.text,
    receivedAt: p.receivedAt,
    attachments: Array.isArray(p.attachments) ? p.attachments : [],
    authResults: h.authResults || hv("Authentication-Results"),
    headers: h,
  };
}

// ---------------------------------------------------------------- ingest

async function reviewerOnDuty(c) {
  const envId = S.posInt(process.env.JOBSEARCH_INBOX_REVIEWER_ID);
  if (envId) {
    const r = await c.query("SELECT id FROM users WHERE id = $1 AND is_active = true AND role = ANY($2::text[])", [envId, REVIEW_ROLES]);
    if (r.rowCount) return envId;
  }
  const r = await c.query("SELECT id FROM users WHERE is_active = true AND role IN ('Admin','SuperAdmin') ORDER BY (role = 'Admin') DESC, id LIMIT 1");
  return r.rows[0] ? r.rows[0].id : null;
}

/** Message ids a DSN refers to: In-Reply-To / References + ids quoted in the report body. */
function bounceIds(m) {
  return matcher.messageIdList(m.inReplyTo, m.references, m.quotedIds || []);
}

async function storeRow(client, m, f) {
  const sender = matcher.parseFrom(m.from);
  const fromAddr = sender.ok ? sender.address : typeof m.from === "string" ? oneLine(m.from, 500) : oneLine(JSON.stringify(m.from === undefined ? null : m.from), 500);
  const thread = m.references[0] || matcher.normalizeMessageId(m.inReplyTo || "") || m.messageId;
  const auth = f.auth ? { present: f.auth.present, failed: f.auth.failed, authenticated: f.auth.authenticated, verdicts: f.auth.verdicts, ...(f.auth.reason ? { reason: f.auth.reason } : {}) } : null;
  return (await client.query(
    `INSERT INTO js_messages (direction, thread_ref, message_id, in_reply_to, refs, application_id, from_addr, from_name, to_addr, subject, match_confidence,
                              review_state, match_reason, body_sanitized, ai_summary, attachments, auth_results, classification, submission_id, received_at, message_kind)
     VALUES ('in',$1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20)
     ON CONFLICT (message_id) WHERE direction = 'in' DO NOTHING RETURNING *`,
    [
      thread, m.messageId, m.inReplyTo, JSON.stringify(m.references), f.applicationId || null, fromAddr, sender.ok && sender.name ? sender.name : null,
      m.to, m.subject, f.high ? 1 : 0, f.applicationId ? "matched" : "needs_review", f.reason, m.text, f.summary,
      JSON.stringify(m.attachments), auth ? JSON.stringify(auth) : null, JSON.stringify(f.cls), f.submissionId || null, m.receivedAt, f.kind,
    ]
  )).rows[0];
}

async function openReviewTask(client, row, reason) {
  const reviewer = await reviewerOnDuty(client);
  const task = (await client.query(
    `INSERT INTO js_tasks (application_id, reason, detail, assigned_to, message_id) VALUES (NULL,'unmatched_reply',$1,$2,$3)
     ON CONFLICT (message_id, reason) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
    [`message:${row.id}: inbound message could not be matched (${reason})`, reviewer, row.id]
  )).rows[0];
  await S.auditEvent(client, SYSTEM_ACTOR, "message.needs_review", null, null, { messageId: row.id, reason, taskId: task ? task.id : null });
  await S.staffEvent(client, null, reviewer, "staff.reply_needs_review", { messageId: row.id, reason, taskId: task ? task.id : null });
  return task ? task.id : null;
}

/**
 * Plausible DSN (replyMatcher.isPlausibleBounce, auth not failed): never attached, NEVER changes a
 * submission or application status, NEVER writes the candidate timeline or candidate events. A hard
 * bounce (5.x.x / Action: failed) whose referenced Message-ID belongs to exactly one submission opens
 * ONE deduped staff task 'verify_delivery' (detail 'bounce_reported: ...') + a staff event + audit;
 * staff decide (manual_confirmation, or leave it). Anything else stays in the review queue.
 */
async function ingestBounce(client, m, cls, auth) {
  const ids = bounceIds(m);
  const subs = ids.length
    ? (await client.query("SELECT id, application_id, status FROM js_submissions WHERE provider_message_id = ANY($1::text[]) OR evidence->>'messageIdPlanned' = ANY($1::text[]) ORDER BY id DESC", [ids])).rows
    : [];
  const apps = [...new Set(subs.map((x) => x.application_id))];
  const st = matcher.bounceStatus(m.text);
  const row = await storeRow(client, m, { reason: "bounce", kind: "bounce", cls, auth, summary: "Delivery status notification (bounce).", submissionId: null });
  if (!row) return { duplicate: true };
  const res = { confidence: "none", reason: "bounce" };
  if (apps.length !== 1 || !st.hard) return { row, res, taskId: await openReviewTask(client, row, apps.length > 1 ? "bounce_ambiguous" : st.hard ? "bounce_unmatched" : "bounce_soft") };
  const app = (await client.query("SELECT a.id, a.candidate_id, a.responsible_user_id, c.assigned_to FROM js_applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.id = $1", [apps[0]])).rows[0];
  const sub = subs[0];
  const responsible = app.responsible_user_id || app.assigned_to || null;
  const detail = `bounce_reported: submission ${sub.id} (status ${sub.status}), DSN message ${row.id} (${m.messageId}), code ${st.code || "unknown"}; verify delivery with the employer`;
  const existing = (await client.query("SELECT id FROM js_tasks WHERE application_id = $1 AND reason = 'verify_delivery' AND status = 'open' LIMIT 1", [app.id])).rows[0];
  const taskId = existing
    ? existing.id
    : (await client.query("INSERT INTO js_tasks (application_id, reason, detail, assigned_to, message_id) VALUES ($1,'verify_delivery',$2,$3,$4) RETURNING id", [app.id, detail, responsible, row.id])).rows[0].id;
  await S.auditEvent(client, SYSTEM_ACTOR, "submission.bounce_reported", app.candidate_id, app.id, { submissionId: sub.id, messageId: row.id, code: st.code, submissionStatus: sub.status, taskId });
  await S.staffEvent(client, app.candidate_id, responsible, "staff.delivery_bounce", { applicationId: app.id, submissionId: sub.id, messageId: row.id, taskId });
  return { row, res, taskId, bounce: { submissionId: sub.id, applicationId: app.id } };
}

/**
 * Stores one normalized inbound message (idempotent by Message-ID).
 * @returns {Promise<{id, duplicate, matched, confidence, reason, applicationId?, taskId?, evidence?}>}
 */
async function ingest(mail) {
  const m = NORMALIZED.has(mail) ? mail : normalizeInbound(mail);
  const existing = (await S.db().query("SELECT id, application_id, review_state FROM js_messages WHERE direction = 'in' AND message_id = $1", [m.messageId])).rows[0];
  if (existing) return { id: existing.id, duplicate: true, matched: Boolean(existing.application_id), confidence: null, reason: "duplicate" };
  const cls = matcher.classifyReply(m.classText || m.text);
  const sender = matcher.parseFrom(m.from);
  const preAuth = matcher.evaluateAuth(m.authResults, sender.ok ? sender.domain : null);
  const plausibleBounce = matcher.isPlausibleBounce(m) && !preAuth.failed;
  const bounceLike = plausibleBounce || matcher.isBounce(m);
  const autoReply = !bounceLike && matcher.isAutoReply(m);
  const out = await S.inTx(async (client) => {
    if (plausibleBounce) return ingestBounce(client, m, cls, preAuth);
    const res = await matcher.match(m, { client });
    let app = null;
    let cand = null;
    if (res.confidence === "high") ({ app, cand } = await S.lockApplication(client, res.applicationId));
    const summary = draftService.summarize({ classification: cls });
    const row = await storeRow(client, m, { applicationId: app ? app.id : null, high: Boolean(app), reason: res.reason, summary, cls, auth: res.auth, submissionId: app ? res.submissionId : null, kind: autoReply ? "auto_reply" : "reply" });
    if (!row) return { duplicate: true };
    if (app) {
      const responsible = S.responsibleOf(app, cand);
      await S.timeline(client, app.id, SYSTEM_ACTOR, "reply_received", { messageId: row.id, classification: cls.category, via: res.reason });
      await S.auditEvent(client, SYSTEM_ACTOR, "message.received", app.candidate_id, app.id, { messageId: row.id, reason: res.reason, sender: res.sender, authenticated: res.authenticated, autoReply, classification: cls.category, instructionLike: cls.instructionLike, attachmentsDropped: m.attachments.filter((a) => a.dropped).length });
      await S.staffEvent(client, app.candidate_id, responsible, "staff.reply_received", { applicationId: app.id, messageId: row.id, classification: cls.category, proposedStatus: cls.proposedStatus });
      await S.candidateEvent(client, app.candidate_id, "application.update", { applicationId: app.id, message: "You have an update" });
      return { row, app, res };
    }
    return { row, res, taskId: await openReviewTask(client, row, res.reason) };
  });
  if (out.duplicate) {
    const r = (await S.db().query("SELECT id, application_id FROM js_messages WHERE direction = 'in' AND message_id = $1", [m.messageId])).rows[0];
    return { id: r ? r.id : null, duplicate: true, matched: Boolean(r && r.application_id), confidence: null, reason: "duplicate" };
  }
  const result = { id: out.row.id, duplicate: false, matched: Boolean(out.app), confidence: out.res.confidence, reason: out.res.reason };
  if (out.app) result.applicationId = out.app.id;
  else result.taskId = out.taskId;
  if (out.bounce) result.bounce = out.bounce;
  await S.auditLog(SYSTEM_ACTOR, out.app ? "jobsearch.message.matched" : "jobsearch.message.needs_review", "js_messages", out.row.id, { reason: out.res.reason });
  // Evidence only for: 'high' + DKIM-authenticated (aligned) + an un-negated acknowledgement sentence +
  // not an auto-reply/bounce (+ the matcher already refused our own / the candidate's address).
  if (out.app) {
    // whole-message veto over body (classifyReply) AND subject
    const ack = cls.acknowledgement && !matcher.ackVeto(m.subject.replace(/^(?:\s*(?:re|aw|tr|fwd?)\s*:)+/i, ""));
    const why = !ack ? null : out.res.confidence !== "high" ? "not_high" : out.res.authenticated !== true ? "not_authenticated" : autoReply ? "auto_reply" : bounceLike ? "bounce" : !out.res.submissionId ? "no_submission" : "";
    if (why === "") result.evidence = autoAckEvidence() ? await acknowledge(out.row, out.res.submissionId) : await suggestAcknowledgement(out.row, out.res.submissionId, m);
    else if (why) result.evidence = { recorded: false, reason: why };
  }
  return result;
}

/**
 * INBOUND_AUTO_ACK_EVIDENCE (controller ruling, round 4): default false in EVERY environment. Only
 * 'true' (any case) turns on automatic employer_acknowledgement evidence from inbound mail - use it only if
 * you accept the classifier's residual false-accept risk. Otherwise an eligible acknowledgement only
 * opens a 'confirm_acknowledgement' staff task; a human confirms (POST /messages/:id/confirm-acknowledgement
 * or POST /submissions/:id/evidence).
 */
function autoAckEvidence() {
  return String(process.env.INBOUND_AUTO_ACK_EVIDENCE || "").trim().toLowerCase() === "true";
}

/**
 * Default mode: NO evidence. Flags the message (classification.suggested_ack = true) and opens ONE
 * deduped 'confirm_acknowledgement' task for the responsible staff member (per message, and at most one
 * open per application) + a staff-audience event + audit. Nothing candidate-visible.
 */
async function suggestAcknowledgement(row, submissionId, m) {
  const sub = (await S.db().query("SELECT status FROM js_submissions WHERE id = $1", [submissionId])).rows[0];
  if (!sub || !["sent", "outcome_unknown"].includes(sub.status)) return { recorded: false, reason: sub ? `submission_${sub.status}` : "no_submission" };
  return S.inTx(async (client) => {
    const { app, cand } = await S.lockApplication(client, row.application_id);
    const responsible = S.responsibleOf(app, cand);
    await client.query("UPDATE js_messages SET classification = COALESCE(classification, '{}'::jsonb) || '{\"suggested_ack\": true}'::jsonb WHERE id = $1", [row.id]);
    const excerpt = oneLine(sanitizeUntrusted(m.text, 2000), 200);
    const existing = (await client.query("SELECT id FROM js_tasks WHERE application_id = $1 AND reason = 'confirm_acknowledgement' AND status = 'open' LIMIT 1", [app.id])).rows[0];
    const created = existing
      ? null
      : (await client.query(
          `INSERT INTO js_tasks (application_id, reason, detail, assigned_to, message_id) VALUES ($1,'confirm_acknowledgement',$2,$3,$4)
           ON CONFLICT (message_id, reason) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
          [app.id, `message:${row.id}: ${excerpt}`, responsible, row.id]
        )).rows[0];
    const taskId = existing ? existing.id : created ? created.id : null;
    await S.auditEvent(client, SYSTEM_ACTOR, "message.ack_suggested", app.candidate_id, app.id, { messageId: row.id, submissionId, taskId, deduped: !created });
    if (created) await S.staffEvent(client, app.candidate_id, responsible, "staff.ack_suggested", { applicationId: app.id, messageId: row.id, submissionId, taskId });
    return { recorded: false, reason: "staff_confirmation_required", suggested: true, taskId };
  });
}

/**
 * Staff confirm that a matched reply is the employer's acknowledgement (jobsearch:approve + scope).
 * The message must be inbound, matched to an application, and from the employer's verified domain /
 * contact (recordEvidence re-checks this). Records employer_acknowledgement with the USER as actor
 * (never the system grant) and resolves the confirm_acknowledgement task.
 */
async function confirmAcknowledgement({ messageId, actor }) {
  if (!S.isUser(actor)) throw httpErr(404, "Not found");
  if (actor.role === "Candidate") throw httpErr(403, "Confirming an acknowledgement requires a manager or administrator");
  const msg = await draftService.loadMessageScoped(actor, messageId); // 404 outside scope
  requireApprover(actor, "Confirming an acknowledgement");
  if (msg.direction !== "in" || !msg.application_id || !["matched", "resolved"].includes(msg.review_state)) throw httpErr(409, "Only an inbound message matched to an application can be confirmed", "not_matched");
  if (msg.message_kind === "bounce") throw httpErr(409, "A delivery notification is not an acknowledgement", "not_acknowledgement");
  const subs = (await S.db().query("SELECT id, status FROM js_submissions WHERE application_id = $1 ORDER BY id DESC", [msg.application_id])).rows;
  const sub = (msg.submission_id && subs.find((x) => x.id === msg.submission_id)) || subs.find((x) => ["sent", "outcome_unknown"].includes(x.status)) || null;
  if (!sub) throw httpErr(409, "The application has no sent submission to confirm", "no_submission");
  const out = await submitter.recordEvidence({ submissionId: sub.id, kind: "employer_acknowledgement", detail: { messageId: msg.id }, actor });
  await S.inTx(async (client) => {
    await client.query("UPDATE js_tasks SET status = 'resolved', resolved_at = now() WHERE application_id = $1 AND reason = 'confirm_acknowledgement' AND status = 'open'", [msg.application_id]);
    await S.auditEvent(client, actor, "message.ack_confirmed", null, msg.application_id, { messageId: msg.id, submissionId: sub.id });
  });
  await S.auditLog(actor, "jobsearch.message.confirm_acknowledgement", "js_messages", msg.id, { applicationId: msg.application_id, submissionId: sub.id });
  return { messageId: msg.id, ...out };
}

/** Records employer_acknowledgement evidence (once per submission; failures audited). Callers check eligibility. */
async function acknowledge(row, submissionId) {
  const sub = (await S.db().query("SELECT status FROM js_submissions WHERE id = $1", [submissionId])).rows[0];
  if (!sub || !["sent", "outcome_unknown"].includes(sub.status)) return { recorded: false, reason: sub ? `submission_${sub.status}` : "no_submission" };
  try {
    await submitter.recordEvidence({ submissionId, kind: "employer_acknowledgement", detail: { messageId: row.id }, actor: SYSTEM_ACTOR, [submitter._internal.EVIDENCE_GRANT]: true });
    return { recorded: true };
  } catch (err) {
    await S.inTx((c) => S.auditEvent(c, SYSTEM_ACTOR, "message.ack_evidence_refused", null, row.application_id, { messageId: row.id, submissionId, error: oneLine(err && err.message, 200) }));
    return { recorded: false, reason: oneLine(err && err.message, 200) };
  }
}

/** Polls the configured provider and ingests new messages. requires_setup providers are reported, not thrown. */
async function pollAndStore() {
  const mail = require("./mail");
  const key = "inbox_poll_cursor";
  const st = (await S.db().query("SELECT value FROM js_module_state WHERE key = $1", [key])).rows[0];
  const cursor = st && st.value ? st.value.cursor : null;
  let polled;
  try {
    polled = await mail.poll(cursor);
  } catch (err) {
    if (err && ["NOT_IMPLEMENTED", "REQUIRES_SETUP"].includes(err.code)) return { matched: 0, queued: 0, duplicates: 0, rejected: 0, status: "requires_setup", detail: oneLine(err.message, 200) };
    throw err;
  }
  const out = { matched: 0, queued: 0, duplicates: 0, rejected: 0, status: "ok" };
  for (const p of polled.messages || []) {
    let r;
    try {
      r = await ingest(normalizeInbound(fromPolled(p)));
    } catch (err) {
      if (err && err.status === 400) {
        out.rejected += 1;
        continue;
      }
      throw err;
    }
    if (r.duplicate) out.duplicates += 1;
    else if (r.matched) out.matched += 1;
    else out.queued += 1;
  }
  await S.db().query(
    "INSERT INTO js_module_state (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, JSON.stringify({ cursor: polled.cursor === undefined ? cursor : polled.cursor, at: new Date().toISOString() })]
  );
  return out;
}

/**
 * Provider delivery event (pushed through the authenticated webhook): {type:'delivery_status',
 * originalMessageId, action, reportId, receivedAt?}. Only 'delivered' for the PROVIDER message id of
 * a sent submission becomes delivery_receipt evidence (system-only grant).
 */
async function ingestDeliveryStatus(evt) {
  const e = evt && typeof evt === "object" ? evt : {};
  const mid = typeof e.originalMessageId === "string" ? oneLine(e.originalMessageId, 300) : "";
  const action = oneLine(e.action, 40).toLowerCase();
  const reportRef = oneLine(e.reportId, 200);
  if (!mid || !action || !reportRef) throw httpErr(400, "delivery_status needs originalMessageId, action and reportId");
  const sub = (await S.db().query("SELECT id, status FROM js_submissions WHERE provider_message_id = $1 ORDER BY id DESC LIMIT 1", [mid])).rows[0];
  if (!sub) return { recorded: false, reason: "unknown_message" };
  if (action !== "delivered") return { recorded: false, reason: `action_${action}` };
  if (!["sent", "outcome_unknown"].includes(sub.status)) return { recorded: false, reason: `submission_${sub.status}` };
  await submitter.recordEvidence({ submissionId: sub.id, kind: "delivery_receipt", detail: { providerMessageId: mid, action, reportRef, receivedAt: oneLine(e.receivedAt, 40) || null }, actor: SYSTEM_ACTOR, [submitter._internal.EVIDENCE_GRANT]: true });
  return { recorded: true, submissionId: sub.id };
}

// ---------------------------------------------------------------- staff actions

function requireApprover(actor, what) {
  if (!S.isUser(actor) || actor.role === "Candidate" || !S.hasPerm(actor, "jobsearch:approve")) throw httpErr(403, `${what} requires a manager or administrator`);
}

/** Attach a needs_review message to an application. Scope is checked for BOTH. */
async function assignReview({ messageId, applicationId, actor }) {
  if (!S.isUser(actor) || actor.role === "Candidate") throw httpErr(404, "Not found");
  const msg = await draftService.loadMessageScoped(actor, messageId);
  requireApprover(actor, "Assigning a reply");
  if (msg.direction !== "in") throw httpErr(404, "Not found");
  if (msg.review_state !== "needs_review" || msg.application_id) throw httpErr(409, "Only a message in the review queue can be assigned");
  const target = await applicationService.loadScoped(actor, applicationId); // 404 outside scope
  const out = await S.inTx(async (client) => {
    const { app, cand } = await S.lockApplication(client, target.id);
    const upd = await client.query(
      "UPDATE js_messages SET application_id = $2, review_state = 'resolved', match_reason = 'staff_assigned', assigned_by = $3, assigned_at = now() WHERE id = $1 AND review_state = 'needs_review' AND application_id IS NULL RETURNING *",
      [msg.id, app.id, actor.id]
    );
    if (!upd.rowCount) throw httpErr(409, "The message was assigned concurrently");
    await client.query("UPDATE js_tasks SET status = 'resolved', resolved_at = now() WHERE message_id = $1 AND reason = 'unmatched_reply' AND status = 'open'", [msg.id]);
    const cls = upd.rows[0].classification || {};
    await S.timeline(client, app.id, actor, "reply_received", { messageId: msg.id, via: "staff_assigned", classification: cls.category || null });
    await S.auditEvent(client, actor, "message.assigned", app.candidate_id, app.id, { messageId: msg.id, previousReason: msg.match_reason });
    await S.staffEvent(client, app.candidate_id, S.responsibleOf(app, cand), "staff.reply_received", { applicationId: app.id, messageId: msg.id, assignedBy: actor.id });
    await S.candidateEvent(client, app.candidate_id, "application.update", { applicationId: app.id, message: "You have an update" });
    return upd.rows[0];
  });
  await S.auditLog(actor, "jobsearch.message.assign", "js_messages", msg.id, { applicationId: out.application_id });
  return presentMessage(out, actor);
}

/** Releases the neutral summary of a matched message to the candidate (staff, jobsearch:write + scope). */
async function shareWithCandidate({ messageId, actor }) {
  if (!S.isUser(actor) || actor.role === "Candidate") throw httpErr(404, "Not found");
  const msg = await draftService.loadMessageScoped(actor, messageId);
  if (!S.hasPerm(actor, "jobsearch:write")) throw httpErr(403, "Sharing a reply requires staff access");
  if (msg.direction !== "in" || !msg.application_id) throw httpErr(409, "Only a message matched to an application can be shared");
  const out = await S.inTx(async (client) => {
    const { app } = await S.lockApplication(client, msg.application_id);
    const row = (await client.query("UPDATE js_messages SET shared_with_candidate = true, shared_by = COALESCE(shared_by, $2), shared_at = COALESCE(shared_at, now()) WHERE id = $1 RETURNING *", [msg.id, actor.id])).rows[0];
    if (!msg.shared_with_candidate) {
      await S.timeline(client, app.id, actor, "reply_shared", { messageId: msg.id });
      await S.auditEvent(client, actor, "message.shared_with_candidate", app.candidate_id, app.id, { messageId: msg.id });
      await S.candidateEvent(client, app.candidate_id, "application.message_shared", { applicationId: app.id, messageId: msg.id, summary: row.ai_summary });
    }
    return row;
  });
  await S.auditLog(actor, "jobsearch.message.share", "js_messages", msg.id, { applicationId: out.application_id });
  return presentMessage(out, actor);
}

/**
 * Staff-made status change from a reply's proposal. The classification never changes anything by itself.
 * 'interview' needs an existing (non-cancelled) appointment: use the interview route to create one.
 */
async function applyClassification({ messageId, actor, status, reason }) {
  if (!S.isUser(actor) || actor.role === "Candidate") throw httpErr(404, "Not found");
  const msg = await draftService.loadMessageScoped(actor, messageId);
  requireApprover(actor, "Changing an application status from a reply");
  if (msg.direction !== "in" || !msg.application_id) throw httpErr(409, "Only a message matched to an application can be applied");
  if (!CLASSIFIABLE.includes(status)) throw httpErr(400, `status must be one of ${CLASSIFIABLE.join(", ")}`);
  if (status === "interview") {
    const a = await S.db().query("SELECT 1 FROM js_appointments WHERE application_id = $1 AND status <> 'cancelled'", [msg.application_id]);
    if (!a.rowCount) throw httpErr(409, "Create the interview appointment first (POST /jobsearch/messages/:id/interview)");
  }
  const cls = msg.classification || {};
  // The candidate-visible reason is a fixed code; the staff's free text stays in staff-only fields.
  const staffNote = typeof reason === "string" && reason.trim() ? oneLine(reason, 500) : null;
  const row = await applicationService.transition(msg.application_id, status, actor, {
    reason: `reply_${status}`,
    event: "status_from_reply",
    detail: { messageId: msg.id, proposed: cls.category || null, proposedStatus: cls.proposedStatus || null, staffNote },
  });
  await S.auditLog(actor, "jobsearch.message.apply_classification", "js_messages", msg.id, { applicationId: row.id, status });
  return { applicationId: row.id, status: row.status, messageId: msg.id };
}

// ---------------------------------------------------------------- reads

function presentMessage(r, user) {
  const cls = r.classification || null;
  if (user && user.role === "Candidate") {
    return { id: r.id, applicationId: r.application_id, receivedAt: r.received_at || r.created_at, summary: r.ai_summary, category: cls ? cls.category : null };
  }
  if (r.direction === "out") return { direction: "out", ...draftService.presentDraft(r) };
  return {
    id: r.id,
    direction: "in",
    applicationId: r.application_id,
    reviewState: r.review_state,
    confidence: Number(r.match_confidence) >= 1 ? "high" : "none",
    matchReason: r.match_reason,
    from: r.from_addr,
    fromName: r.from_name || null,
    kind: r.message_kind || "reply",
    to: r.to_addr,
    subject: r.subject,
    body: r.body_sanitized,
    summary: r.ai_summary,
    classification: cls,
    attachments: r.attachments || [],
    authResults: r.auth_results,
    sharedWithCandidate: r.shared_with_candidate,
    draftReply: r.draft_reply,
    receivedAt: r.received_at || r.created_at,
  };
}

const STATES = ["needs_review", "matched", "resolved"];

async function listMessages({ user, query = {} }) {
  if (!user) throw httpErr(404, "Not found");
  const state = query.state === undefined || query.state === "" ? null : String(query.state);
  if (state && !STATES.includes(state)) throw httpErr(400, `state must be one of ${STATES.join(", ")}`);
  const appId = query.applicationId === undefined || query.applicationId === "" ? null : S.posInt(query.applicationId);
  if (query.applicationId !== undefined && query.applicationId !== "" && !appId) throw httpErr(400, "applicationId must be a positive integer");
  const c = S.db();
  if (user.role === "Candidate") {
    const { clause, params } = candidateScopeSql(user, "c", 1);
    const rows = (await c.query(
      `SELECT m.* FROM js_messages m JOIN js_applications a ON a.id = m.application_id JOIN candidates c ON c.id = a.candidate_id
        WHERE m.direction = 'in' AND m.shared_with_candidate = true AND c.is_deleted = false AND ($1::int IS NULL OR m.application_id = $1) AND ${clause}
        ORDER BY m.id DESC LIMIT 200`,
      [appId, ...params]
    )).rows;
    return { messages: rows.map((r) => presentMessage(r, user)) };
  }
  if (!S.hasPerm(user, "jobsearch:read")) throw httpErr(403, "Permission denied: jobsearch:read");
  const { clause, params } = candidateScopeSql(user, "c", 2);
  const seeUnmatched = REVIEW_ROLES.includes(user.role);
  const rows = (await c.query(
    `SELECT m.* FROM js_messages m
       LEFT JOIN js_applications a ON a.id = m.application_id LEFT JOIN candidates c ON c.id = a.candidate_id
      WHERE m.direction = 'in' AND ($1::text IS NULL OR m.review_state = $1) AND ($2::int IS NULL OR m.application_id = $2)
        AND ((m.application_id IS NOT NULL AND c.is_deleted = false AND ${clause}) ${seeUnmatched ? "OR m.application_id IS NULL" : ""})
      ORDER BY m.id DESC LIMIT 200`,
    [state, appId, ...params]
  )).rows;
  return { messages: rows.map((r) => presentMessage(r, user)) };
}

async function getMessage({ user, id }) {
  const row = await draftService.loadMessageScoped(user, id);
  const out = presentMessage(row, user);
  if (user.role !== "Candidate" && row.direction === "in") {
    const drafts = (await S.db().query("SELECT * FROM js_messages WHERE parent_message_id = $1 AND direction = 'out' ORDER BY id", [row.id])).rows;
    out.drafts = drafts.map(draftService.presentDraft);
  }
  return out;
}

module.exports = { normalizeInbound, fromPolled, ingest, pollAndStore, ingestDeliveryStatus, assignReview, confirmAcknowledgement, autoAckEvidence, shareWithCandidate, applyClassification, listMessages, getMessage, presentMessage, attachmentMeta, classifyReply: matcher.classifyReply, SYSTEM_ACTOR };
