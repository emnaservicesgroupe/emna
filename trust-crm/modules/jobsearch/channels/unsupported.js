// Channels we do not (and must not) automate: online forms with CAPTCHA, payment, login/account
// creation, legal declarations, custom screening questions, portal-only applications. They are
// HANDOFFS: a js_tasks row for the responsible staff member and status needs_staff. Nothing is sent,
// signed, paid or answered on the candidate's behalf.
const { detectHandoff } = require("../handoffDetector");

const SUPPORTED = new Set(["email"]);

/**
 * @param {{channel?: string}} application
 * @param {object} job js_jobs row (title, description_text, flags?)
 * @param {object} [prefs] candidate preferences (for "please state your salary..." questions)
 * @returns {'email'|string} 'email' or a handoff reason (captcha|payment|login|legal_declaration|custom_questions|unsupported_channel)
 */
function detectChannel(application, job, prefs = {}) {
  const ch = application && typeof application.channel === "string" && application.channel.trim() ? application.channel.trim().toLowerCase() : "email";
  if (!SUPPORTED.has(ch)) return "unsupported_channel";
  const h = detectHandoff(job || {}, prefs || {});
  return h ? h.reason : "email";
}

/**
 * Opens (or reuses) the staff task for a handoff. Idempotent per (application, reason) while open.
 * @returns {Promise<object>} the js_tasks row
 */
async function createHandoffTask(client, { applicationId, reason, detail, assignedTo }) {
  const existing = (await client.query("SELECT * FROM js_tasks WHERE application_id = $1 AND reason = $2 AND status = 'open' ORDER BY id LIMIT 1", [applicationId, reason])).rows[0];
  if (existing) return existing;
  return (await client.query("INSERT INTO js_tasks (application_id, reason, detail, assigned_to) VALUES ($1,$2,$3,$4) RETURNING *", [applicationId, reason, detail ? String(detail).slice(0, 1000) : null, assignedTo || null])).rows[0];
}

module.exports = { detectChannel, createHandoffTask, SUPPORTED };
