'use strict';
// In-app notifications. dedupe_key makes repeated triggers idempotent per user.
async function notify(q, userId, type, payload = {}, dedupeKey = null) {
  if (!userId) return;
  await q.query(
    `INSERT INTO notifications (user_id, type, payload, dedupe_key) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [userId, type, JSON.stringify(payload), dedupeKey],
  );
}
async function list(ctx, actor, { limit = 50 } = {}) {
  return ctx.db.rows(
    `SELECT id, type, payload, read_at, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [actor.userId, Math.min(limit, 100)],
  );
}
async function markRead(ctx, actor, id) {
  await ctx.db.query(`UPDATE notifications SET read_at = now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL`, [id, actor.userId]);
}
async function unreadCount(ctx, actor) {
  const r = await ctx.db.one(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL`, [actor.userId]);
  return r.n;
}
module.exports = { notify, list, markRead, unreadCount };
