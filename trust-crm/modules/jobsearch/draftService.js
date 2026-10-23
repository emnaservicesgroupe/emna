// Summaries, reply drafts and follow-up sends for employer replies (spec §8, Task 13).
//
//   summarize(message, lang?)                    deterministic neutral summary (never quotes employer text)
//   draftReply(message, application, lang?)      deterministic EN/FR template (AR -> EN with a note)
//   createDraft({messageId, actor, lang?})       stores js_messages direction='out', status='draft'
//   sendFollowUp({draftId, actor})               human approval (jobsearch:approve) OR an enabled, approved
//                                                'ack_reply' automation rule scoped to this candidate AND
//                                                employer + every guard check; sandbox/provider via mail.send
//
// LLM-pluggable: setGenerator({summarize, draftReply}) may replace the templates; outputs are still
// stored as drafts and still need the same approval to be sent.
const crypto = require("crypto");
const guard = require("./guard");
const consentService = require("./consentService");
const applicationService = require("./applicationService");
const matcher = require("./replyMatcher");
const S = require("./inboxShared");

const { httpErr, oneLine } = S;
const AUTO_WINDOW_HOURS = 24;
const LANGS = ["en", "fr", "ar"];
const AR_NOTE = "Arabic template not available yet; English text used.";

let generator = null;
/** Optional LLM hook. Its output is treated as a draft only. */
function setGenerator(g) {
  generator = g && typeof g === "object" ? g : null;
}

// ---------------------------------------------------------------- templates

const SUMMARY = {
  en: {
    acknowledgement: "The employer confirmed they received the application.",
    interview_request: "The employer would like to arrange an interview. Our team will contact you about the time.",
    rejection: "The employer decided not to continue with this application.",
    offer: "The employer sent a message about a possible job offer. Our team will review it with you.",
    info_request: "The employer asked for more information. Our team will contact you.",
    other: "The employer replied. Our team is reviewing the message.",
  },
  fr: {
    acknowledgement: "L'employeur a confirmé avoir reçu la candidature.",
    interview_request: "L'employeur souhaite organiser un entretien. Notre équipe vous contactera pour l'horaire.",
    rejection: "L'employeur a décidé de ne pas poursuivre cette candidature.",
    offer: "L'employeur a envoyé un message concernant une possible offre. Notre équipe l'examinera avec vous.",
    info_request: "L'employeur demande des informations complémentaires. Notre équipe vous contactera.",
    other: "L'employeur a répondu. Notre équipe examine le message.",
  },
};

const REPLY = {
  en: {
    greeting: "Dear Hiring Team,",
    acknowledgement: (t) => `Thank you for confirming that you received the application for the ${t} position. We remain available if you need any further information.`,
    interview_request: (t) => `Thank you for your interest in the application for the ${t} position. We will confirm the candidate's availability for an interview shortly.`,
    rejection: (t) => `Thank you for letting us know about your decision regarding the ${t} position. We appreciate the time you took to review the application.`,
    offer: (t) => `Thank you for your message regarding the ${t} position. We will review it with the candidate and get back to you shortly.`,
    info_request: (t) => `Thank you for your message regarding the ${t} position. We will get back to you with the requested information shortly.`,
    other: (t) => `Thank you for your message regarding the ${t} position. We will get back to you shortly.`,
    closing: "Kind regards,\nVITA recruitment team",
  },
  fr: {
    greeting: "Madame, Monsieur,",
    acknowledgement: (t) => `Merci d'avoir confirmé la réception de la candidature pour le poste de ${t}. Nous restons à votre disposition pour toute information complémentaire.`,
    interview_request: (t) => `Merci de l'intérêt porté à la candidature pour le poste de ${t}. Nous vous confirmerons rapidement les disponibilités du candidat pour un entretien.`,
    rejection: (t) => `Merci de nous avoir informés de votre décision concernant le poste de ${t}. Nous vous remercions du temps consacré à l'examen de la candidature.`,
    offer: (t) => `Merci pour votre message concernant le poste de ${t}. Nous l'examinons avec le candidat et revenons vers vous rapidement.`,
    info_request: (t) => `Merci pour votre message concernant le poste de ${t}. Nous revenons vers vous rapidement avec les informations demandées.`,
    other: (t) => `Merci pour votre message concernant le poste de ${t}. Nous revenons vers vous rapidement.`,
    closing: "Cordialement,\nL'équipe de recrutement VITA",
  },
};

function categoryOf(message) {
  const cls = message && (message.classification || message.cls);
  const cat = cls && typeof cls === "object" ? cls.category : null;
  return SUMMARY.en[cat] ? cat : "other";
}

function pickLang(lang) {
  return LANGS.includes(lang) ? lang : "en";
}

/** Neutral summary for staff and (after release) the candidate. Never quotes the employer's text. */
function summarize(message, lang) {
  if (generator && typeof generator.summarize === "function") {
    const out = generator.summarize(message, lang);
    if (typeof out === "string" && out.trim()) return oneLine(out, 500);
  }
  const l = pickLang(lang);
  const cat = categoryOf(message);
  if (l === "ar") return `${SUMMARY.en[cat]} (${AR_NOTE})`;
  return SUMMARY[l][cat];
}

/** Deterministic reply draft. */
function draftReply(message, application, lang) {
  if (generator && typeof generator.draftReply === "function") {
    const out = generator.draftReply(message, application, lang);
    if (typeof out === "string" && out.trim()) return String(out).replace(/\r\n?/g, "\n").slice(0, 5000);
  }
  const l = pickLang(lang);
  const t = REPLY[l === "ar" ? "en" : l];
  const title = oneLine((application && (application.jobTitle || application.title)) || "", 120) || (l === "fr" ? "proposé" : "advertised");
  const body = `${t.greeting}\n\n${t[categoryOf(message)](title)}\n\n${t.closing}\n`;
  return l === "ar" ? `[${AR_NOTE}]\n\n${body}` : body;
}

// ---------------------------------------------------------------- scoped loading

/** Inbound message row visible to `user`, else 404. Unmatched messages: Admin/SuperAdmin/Manager only. */
async function loadMessageScoped(user, messageId, client) {
  const id = S.posInt(messageId);
  if (!id || !user) throw httpErr(404, "Not found");
  const c = client || S.db();
  const row = (await c.query("SELECT * FROM js_messages WHERE id = $1", [id])).rows[0];
  if (!row) throw httpErr(404, "Not found");
  if (user.role === "Candidate") {
    if (row.direction !== "in" || !row.application_id || !row.shared_with_candidate) throw httpErr(404, "Not found");
    await applicationService.loadScoped(user, row.application_id, c);
    return row;
  }
  if (!S.hasPerm(user, "jobsearch:read")) throw httpErr(404, "Not found");
  if (!row.application_id) {
    if (!["Admin", "SuperAdmin", "Manager"].includes(user.role)) throw httpErr(404, "Not found");
    return row;
  }
  await applicationService.loadScoped(user, row.application_id, c); // 404 outside scope
  return row;
}

async function employerOfApp(c, app) {
  return (await c.query(
    "SELECT j.title, e.id AS employer_id, e.domain, e.verified_contact_email FROM js_jobs j LEFT JOIN js_employers e ON e.id = j.employer_id WHERE j.id = $1",
    [app.job_id]
  )).rows[0] || {};
}

// ---------------------------------------------------------------- drafts

const crlfSafe = (v, max) => oneLine(v, max);
const bodySafe = (v) => String(v || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 5000);

function replySubject(subject) {
  const s = crlfSafe(subject, 180).replace(/\[?VITA-[a-f0-9]{20}\]?/gi, "").trim();
  return /^(re|aw|tr)\s*:/i.test(s) ? s : `Re: ${s || "Your message"}`;
}

/**
 * Creates a reply draft for a MATCHED inbound message (staff with jobsearch:write + scope).
 * @returns {Promise<object>} presented draft
 */
async function createDraft({ messageId, actor, lang }) {
  if (!S.isUser(actor) || actor.role === "Candidate" || !S.hasPerm(actor, "jobsearch:write")) throw httpErr(403, "Creating a reply draft requires staff access");
  const msg = await loadMessageScoped(actor, messageId);
  if (msg.direction !== "in" || !msg.application_id) throw httpErr(409, "Only a message matched to an application can be answered");
  if (lang !== undefined && !LANGS.includes(lang)) throw httpErr(400, `lang must be one of ${LANGS.join(", ")}`);
  const sender = matcher.parseFrom(msg.from_addr);
  if (!sender.ok) throw httpErr(409, "The message has no usable sender address");
  const out = await S.inTx(async (client) => {
    const { app } = await S.lockApplication(client, msg.application_id);
    const emp = await employerOfApp(client, app);
    const l = pickLang(lang || app.cover_letter_lang);
    const text = bodySafe(draftReply(msg, { jobTitle: emp.title }, l));
    const subject = replySubject(msg.subject);
    const kind = categoryOf(msg) === "acknowledgement" ? "ack_reply" : "reply";
    const row = (await client.query(
      `INSERT INTO js_messages (direction, thread_ref, in_reply_to, application_id, to_addr, subject, body_text, status, parent_message_id, draft_kind, lang, created_by, review_state)
       VALUES ('out',$1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,'resolved') RETURNING *`,
      [msg.thread_ref || msg.message_id, msg.message_id, app.id, sender.address, subject, text, msg.id, kind, l, actor.id]
    )).rows[0];
    await client.query("UPDATE js_messages SET draft_reply = $2 WHERE id = $1", [msg.id, text]);
    await S.timeline(client, app.id, actor, "reply_draft_created", { messageId: msg.id, draftId: row.id });
    await S.auditEvent(client, actor, "message.draft_created", app.candidate_id, app.id, { messageId: msg.id, draftId: row.id, kind });
    await S.staffEvent(client, app.candidate_id, actor.id, "staff.draft_created", { applicationId: app.id, messageId: msg.id, draftId: row.id });
    return row;
  });
  await S.auditLog(actor, "jobsearch.message.draft", "js_messages", out.id, { messageId: msg.id });
  return presentDraft(out);
}

function presentDraft(r) {
  return {
    id: r.id,
    applicationId: r.application_id,
    parentMessageId: r.parent_message_id,
    to: r.to_addr,
    subject: r.subject,
    body: r.body_text,
    status: r.status,
    kind: r.draft_kind,
    lang: r.lang,
    messageId: r.message_id,
    autoSent: r.auto_sent,
    error: r.send_error,
    sentAt: r.sent_at,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------- send

async function activeAckRule(client, candidateId, employerId) {
  if (!employerId) return null;
  const r = await client.query(
    `SELECT * FROM js_automation_rules
      WHERE candidate_id = $1 AND active = true AND approved_by IS NOT NULL AND approved_at IS NOT NULL
        AND rule->>'type' = 'ack_reply' AND rule->>'enabled' = 'true'
      ORDER BY id`,
    [candidateId]
  );
  return r.rows.find((row) => {
    const ids = [row.rule.employerId, ...(Array.isArray(row.rule.employerIds) ? row.rule.employerIds : [])].map(Number).filter(Number.isSafeInteger);
    return ids.includes(Number(employerId));
  }) || null;
}

/** Every pre-send check (inside the candidate-locked transaction). Returns null when OK, else {code, detail}. */
async function checkSend(client, { app, draft, parent, emp, auto }) {
  const blockers = await applicationService._internal.sendBlockers(client, app.candidate_id, "submit");
  const relevant = blockers.filter((b) => auto || b !== "mode_search_only");
  if (relevant.length) return { code: relevant[0], detail: `Follow-up blocked: ${relevant.join(", ")}` };
  if (!(await consentService.activeConsent(app.candidate_id, "submit", client))) return { code: "consent_missing", detail: "No active consent to contact employers" };
  if (!parent || parent.direction !== "in" || parent.application_id !== app.id) return { code: "no_parent", detail: "The draft does not answer a message of this application" };
  if (auto && !/^matched_/.test(parent.match_reason || "")) return { code: "not_auto_matched", detail: "Only replies matched with high confidence can be answered automatically" };
  const sender = matcher.parseFrom(parent.from_addr);
  const to = guard.normalizeEmail(draft.to_addr || "");
  if (!sender.ok || !to || to !== sender.address) return { code: "recipient_changed", detail: "The recipient must be the sender of the employer's message" };
  if (!matcher.senderMatchesEmployer(emp, to)) return { code: "recipient_unverified", detail: "The recipient is not at the employer's verified domain" };
  if (auto) {
    const n = (await client.query(
      `SELECT count(*)::int AS n FROM js_messages WHERE direction = 'out' AND auto_sent = true AND thread_ref = $1
          AND status IN ('sending','sent','outcome_unknown') AND COALESCE(sent_at, created_at) > now() - make_interval(hours => $2)`,
      [draft.thread_ref, AUTO_WINDOW_HOURS]
    )).rows[0].n;
    if (n >= 1) return { code: "rate_limited", detail: `At most one automatic acknowledgement per thread per ${AUTO_WINDOW_HOURS}h` };
  }
  return null;
}

function messageIdForDraft(draftId) {
  const from = guard.normalizeEmail(process.env.MAIL_FROM || "") || "vita@test.invalid";
  return `<vita-fu-${draftId}-${crypto.randomBytes(8).toString("hex")}@${from.split("@")[1]}>`;
}

/**
 * Sends a stored draft. Authorization: a staff user with jobsearch:approve, OR (any staff user or a
 * system actor) an enabled+approved 'ack_reply' rule for this candidate and employer on an
 * acknowledgement thread (max one automatic send per thread per 24h). Every send re-checks consent,
 * pauses, suspension and that the recipient is the employer sender at the verified domain. No
 * attachments are ever added. {accepted:false} keeps the draft unsent with the provider's reason.
 * @returns {Promise<{sent: boolean, draft: object, error?: string}>}
 */
async function sendFollowUp({ draftId, actor, deps = {} }) {
  const id = S.posInt(draftId);
  if (!id) throw httpErr(404, "Not found");
  const pre = (await S.db().query("SELECT id, application_id, direction FROM js_messages WHERE id = $1", [id])).rows[0];
  if (!pre || pre.direction !== "out" || !pre.application_id) throw httpErr(404, "Not found");
  if (S.isUser(actor)) {
    if (actor.role === "Candidate") throw httpErr(404, "Not found");
    await applicationService.loadScoped(actor, pre.application_id); // 404 outside scope
  } else if (typeof actor !== "string" || !/^system:[a-z_]{1,40}$/.test(actor)) {
    throw httpErr(403, "Unknown actor");
  }
  const approver = S.isUser(actor) && S.hasPerm(actor, "jobsearch:approve");
  const plan = await S.inTx(async (client) => {
    const { app } = await S.lockApplication(client, pre.application_id);
    const draft = (await client.query("SELECT * FROM js_messages WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (draft.status !== "draft") throw httpErr(409, `Draft is ${draft.status}`);
    const parent = draft.parent_message_id ? (await client.query("SELECT * FROM js_messages WHERE id = $1", [draft.parent_message_id])).rows[0] : null;
    const emp = await employerOfApp(client, app);
    let auto = false;
    let rule = null;
    if (!approver) {
      rule = draft.draft_kind === "ack_reply" && parent && parent.classification && parent.classification.category === "acknowledgement" ? await activeAckRule(client, app.candidate_id, emp.employer_id) : null;
      if (!rule) throw httpErr(403, "Sending a follow-up requires approval (jobsearch:approve) or an enabled acknowledgement rule for this candidate and employer");
      auto = true;
    }
    const blocked = await checkSend(client, { app, draft, parent, emp, auto });
    if (blocked) {
      await client.query("UPDATE js_messages SET send_error = $2 WHERE id = $1", [id, blocked.detail]);
      await S.auditEvent(client, actor, "message.follow_up_refused", app.candidate_id, app.id, { draftId: id, code: blocked.code });
      return { refused: blocked, app };
    }
    const messageId = messageIdForDraft(id);
    const refs = matcher.messageIdList(parent.refs, parent.message_id);
    await client.query("UPDATE js_messages SET status = 'sending', message_id = $2, auto_sent = $3, sent_by = $4, send_error = NULL WHERE id = $1", [id, messageId, auto, S.actorLabel(actor)]);
    await S.auditEvent(client, actor, "message.follow_up_sending", app.candidate_id, app.id, { draftId: id, auto, ruleId: rule ? rule.id : null, to: draft.to_addr });
    return {
      app,
      auto,
      ruleId: rule ? rule.id : null,
      mail: {
        to: draft.to_addr,
        subject: crlfSafe(draft.subject, 200),
        text: bodySafe(draft.body_text),
        headers: { "Message-ID": messageId, "In-Reply-To": parent.message_id, References: refs.join(" ").slice(0, 4000) },
      },
    };
  });
  if (plan.refused) {
    await S.auditLog(actor, "jobsearch.message.follow_up_refused", "js_messages", id, { code: plan.refused.code });
    throw httpErr(plan.refused.code === "rate_limited" ? 429 : 409, plan.refused.detail, plan.refused.code);
  }
  const send = deps.mailSend || ((m) => require("./mail").send(m));
  let res;
  try {
    res = await send(plan.mail);
  } catch (err) {
    res = { thrown: true, reason: `${(err && err.code) || "error"}: ${oneLine(err && err.message, 200)}` };
  }
  const { app } = plan;
  const final = await S.inTx(async (client) => {
    let row;
    if (res && res.accepted === true) {
      row = (await client.query("UPDATE js_messages SET status = 'sent', sent_at = now(), provider_message_id = $2 WHERE id = $1 RETURNING *", [id, res.providerMessageId || null])).rows[0];
      await S.timeline(client, app.id, actor, "follow_up_sent", { draftId: id, auto: plan.auto });
      await S.auditEvent(client, actor, "message.follow_up_sent", app.candidate_id, app.id, { draftId: id, auto: plan.auto, ruleId: plan.ruleId, providerMessageId: res.providerMessageId || null });
      await S.staffEvent(client, app.candidate_id, app.responsible_user_id, "staff.follow_up_sent", { applicationId: app.id, draftId: id, auto: plan.auto });
    } else if (res && res.thrown) {
      // Unknown whether the provider took it: never re-sent automatically.
      row = (await client.query("UPDATE js_messages SET status = 'outcome_unknown', send_error = $2 WHERE id = $1 RETURNING *", [id, res.reason])).rows[0];
      await S.auditEvent(client, actor, "message.follow_up_unknown", app.candidate_id, app.id, { draftId: id, error: res.reason });
    } else {
      const reason = oneLine((res && res.reason) || "not accepted by the mail provider", 300);
      row = (await client.query("UPDATE js_messages SET status = 'draft', message_id = NULL, auto_sent = false, send_error = $2 WHERE id = $1 RETURNING *", [id, reason])).rows[0];
      await S.auditEvent(client, actor, "message.follow_up_not_accepted", app.candidate_id, app.id, { draftId: id, reason });
    }
    return row;
  });
  await S.auditLog(actor, "jobsearch.message.follow_up", "js_messages", id, { status: final.status, auto: plan.auto });
  if (final.status === "sent") return { sent: true, draft: presentDraft(final) };
  return { sent: false, draft: presentDraft(final), error: final.send_error };
}

module.exports = { summarize, draftReply, createDraft, sendFollowUp, setGenerator, loadMessageScoped, presentDraft, replySubject, AUTO_WINDOW_HOURS };
