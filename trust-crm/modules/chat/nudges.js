// E-mail nudges (stage 6, Task 3): after the commit of a message sent by STAFF into an external conversation, every external recipient with
// an e-mail address (the candidate's account user; the employer / agency organisation's users) who has not opted out gets ONE content-free
// e-mail per (conversation, user) per CHAT_NUDGE_COOLDOWN_MIN minutes (default 15). Messages from external parties never produce e-mail
// (staff see in-app unread counts only), and neither do staff rooms.
//
// Rules this module enforces:
//   - The cooldown is claimed with ONE atomic upsert on chat_nudges (INSERT .. ON CONFLICT DO UPDATE .. WHERE last_sent_at <= now - cooldown):
//     under any number of parallel sends exactly one caller wins a (conversation, user) slot, so there is no nudge storm.
//   - The text is neutral and trilingual (the user's language is not stored): it never contains the message, the sender, the subject name,
//     or any promise of employment / visa. A link to the portal is added only when SITE_BASE_URL is an http(s) URL.
//   - It runs after the commit, off the request path (fire-and-forget, tracked for tests), and NEVER throws into the send: failures are logged
//     (error code only). A failed or refused delivery keeps the slot held for CHAT_NUDGE_FAILURE_BACKOFF_MIN minutes (default 5; 0 = give it
//     back at once) instead of releasing it: a provider outage is retried by later messages at most once per backoff, not once per message,
//     and a recovered provider is not silenced for the whole cooldown.
//   - Delivery goes through the mail adapter facade (MAIL_PROVIDER sandbox by default: only *@test.invalid style allow-listed addresses are accepted).
const db = require("../../db");
const mail = require("../jobsearch/mail");
const { EXTERNAL_ROLES } = require("./scope");

const SUBJECT = "New message in VITA / رسالة جديدة في VITA / Nouveau message dans VITA";
const LINES = [
  "You have a new message in VITA.",
  "لديك رسالة جديدة في VITA.",
  "Vous avez un nouveau message dans VITA.",
];
const FOOTER = [
  "You can switch these e-mails off in your message settings.",
  "يمكنك إيقاف هذه الرسائل من إعدادات الرسائل.",
  "Vous pouvez désactiver ces e-mails dans vos paramètres de messagerie.",
];

let clock = () => new Date();
const pending = new Set();

function cooldownMinutes() {
  const raw = String(process.env.CHAT_NUDGE_COOLDOWN_MIN ?? "").trim();
  if (!/^\d{1,5}$/.test(raw)) return 15; // unset / blank / malformed -> the default; "0" explicitly disables the cooldown
  return Math.min(Number(raw), 7 * 24 * 60);
}

function failureBackoffMinutes() {
  const raw = String(process.env.CHAT_NUDGE_FAILURE_BACKOFF_MIN ?? "").trim();
  if (!/^\d{1,6}$/.test(raw)) return 5; // unset / blank / malformed -> the default; "0" gives the slot back immediately
  return Math.min(Number(raw), 24 * 60);
}

function portalUrl() {
  const raw = String(process.env.SITE_BASE_URL || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The fixed, content-free message. Exported for tests. */
function buildMessage() {
  const link = portalUrl();
  const text = [...LINES, ...(link ? ["", link] : []), "", ...FOOTER].join("\n");
  return { subject: SUBJECT, text, headers: { "Auto-Submitted": "auto-generated" } };
}

/** External users of the conversation's subject who may be nudged: active, with an e-mail, not opted out. */
async function recipients(conversationId) {
  const r = await db.query(
    `SELECT DISTINCT u.id, u.email
       FROM chat_conversations c
       JOIN LATERAL (
              SELECT a.user_id FROM js_candidate_accounts a JOIN candidates ca ON ca.id = a.candidate_id
               WHERE c.subject_type = 'candidate' AND a.candidate_id = c.subject_id AND ca.is_deleted = false
              UNION
              SELECT oa.user_id FROM crm_org_accounts oa JOIN crm_employers o ON o.id = oa.org_id
               WHERE c.subject_type = 'employer_request' AND oa.org_type = 'employer' AND oa.org_id = c.subject_id AND o.status <> 'suspended'
              UNION
              SELECT oa.user_id FROM crm_org_accounts oa JOIN crm_agencies o ON o.id = oa.org_id
               WHERE c.subject_type = 'agency' AND oa.org_type = 'agency' AND oa.org_id = c.subject_id AND o.status <> 'suspended'
            ) m ON TRUE
       JOIN users u ON u.id = m.user_id
       LEFT JOIN chat_prefs p ON p.user_id = u.id
      WHERE c.id = $1 AND u.is_active = true AND u.role = ANY($2) AND COALESCE(btrim(u.email), '') <> '' AND COALESCE(p.email_nudges, true)`,
    [conversationId, [...EXTERNAL_ROLES]]
  );
  return r.rows;
}

/** Atomically claims the cooldown slot. true = this caller must send. */
async function claim(conversationId, userId, now, minutes) {
  const r = await db.query(
    `INSERT INTO chat_nudges (conversation_id, user_id, last_sent_at) VALUES ($1,$2,$3)
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_sent_at = EXCLUDED.last_sent_at
       WHERE chat_nudges.last_sent_at <= EXCLUDED.last_sent_at - make_interval(mins => $4::int)
     RETURNING 1`,
    [conversationId, userId, now, minutes]
  );
  return r.rowCount > 0;
}

/**
 * After a failed delivery: keeps the slot claimed so that it can be claimed again `backoff` minutes after `claimedAt` (the claim succeeds
 * when last_sent_at <= now - cooldown, so the stored time is claimedAt + backoff - cooldown). Only if nobody claimed it since.
 * backoff 0 deletes the slot (the old behaviour).
 */
async function holdAfterFailure(conversationId, userId, claimedAt, cooldown, backoff) {
  if (backoff <= 0) {
    await db.query("DELETE FROM chat_nudges WHERE conversation_id = $1 AND user_id = $2 AND last_sent_at = $3", [conversationId, userId, claimedAt]);
    return;
  }
  await db.query(
    "UPDATE chat_nudges SET last_sent_at = $3::timestamptz + make_interval(mins => $4::int - $5::int) WHERE conversation_id = $1 AND user_id = $2 AND last_sent_at = $3",
    [conversationId, userId, claimedAt, backoff, cooldown]
  );
}

/**
 * @param {{conversationId: number, senderRole: string}} msg  the committed message (no text needed or accepted)
 * @returns {Promise<{sent: number, skipped: number}>} resolves, never rejects
 */
async function nudge({ conversationId, senderRole }) {
  const out = { sent: 0, skipped: 0 };
  try {
    if (EXTERNAL_ROLES.has(senderRole)) return out; // external -> staff: in-app unread only
    const minutes = cooldownMinutes();
    const backoff = failureBackoffMinutes();
    const body = buildMessage();
    for (const rcpt of await recipients(conversationId)) {
      let claimedAt = null;
      try {
        const now = clock();
        if (!(await claim(conversationId, rcpt.id, now, minutes))) {
          out.skipped += 1;
          continue;
        }
        claimedAt = now;
        const res = await mail.send({ to: rcpt.email, ...body });
        if (res && res.accepted) out.sent += 1;
        else {
          out.skipped += 1;
          await holdAfterFailure(conversationId, rcpt.id, claimedAt, minutes, backoff);
        }
      } catch (err) {
        out.skipped += 1;
        console.error("chat nudge failed:", (err && (err.code || err.name)) || "unknown");
        if (claimedAt) await holdAfterFailure(conversationId, rcpt.id, claimedAt, minutes, backoff).catch(() => {});
      }
    }
  } catch (err) {
    console.error("chat nudge failed:", (err && (err.code || err.name)) || "unknown");
  }
  return out;
}

/** Fire-and-forget after the commit; tracked so tests (and shutdown) can wait for it. */
function schedule(msg) {
  const p = nudge(msg).finally(() => pending.delete(p));
  pending.add(p);
  return p;
}

const idle = async () => {
  while (pending.size) await Promise.all([...pending]);
};

/** Test hook: replace the clock used for the cooldown (a function returning a Date), or restore it with no argument. */
const setClock = (fn) => {
  clock = typeof fn === "function" ? fn : () => new Date();
};

module.exports = { nudge, schedule, idle, setClock, buildMessage, cooldownMinutes, failureBackoffMinutes };
