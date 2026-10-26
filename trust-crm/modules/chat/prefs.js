// GET / PUT /chat/prefs: the one preference, e-mail nudges (default on). Strict body: exactly {email_nudges: boolean}.
const db = require("../../db");
const { logAudit } = require("../../utils/audit");
const { HttpError } = require("../jobsearch/httpError");
const c = require("./common");

async function getPrefs(actor) {
  const r = await db.query("SELECT email_nudges FROM chat_prefs WHERE user_id = $1", [actor.userId]);
  return { email_nudges: r.rowCount ? r.rows[0].email_nudges : true };
}

async function setPrefs(actor, input) {
  const body = c.bodyObject(input);
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "email_nudges") throw new HttpError(400, "Only email_nudges can be set");
  if (typeof body.email_nudges !== "boolean") throw new HttpError(400, "email_nudges must be true or false");
  return c.inTransaction(async (client) => {
    const old = await client.query("SELECT email_nudges FROM chat_prefs WHERE user_id = $1 FOR UPDATE", [actor.userId]);
    await client.query(
      `INSERT INTO chat_prefs (user_id, email_nudges) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET email_nudges = EXCLUDED.email_nudges`,
      [actor.userId, body.email_nudges]
    );
    const before = old.rowCount ? old.rows[0].email_nudges : true;
    if (before !== body.email_nudges) {
      await logAudit({ client, userId: actor.userId, action: "chat.prefs.update", tableName: "chat_prefs", recordId: String(actor.userId), oldData: { email_nudges: before }, newData: { email_nudges: body.email_nudges } });
    }
    return { email_nudges: body.email_nudges };
  });
}

module.exports = { getPrefs, setPrefs };
