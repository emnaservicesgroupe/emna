// Leave balances (hr_leave_balances): HR sets entitled and adjusted days per (user, leave type, year). Used days are never
// stored: used_days = APPROVED requests, pending_days = PENDING requests (a range crossing New Year is split between the two
// years, see leaveDays.yearShare); remaining_days = entitled + adjusted - used; available_days also subtracts pending. Days travel as
// normalised decimal strings, all arithmetic is NUMERIC in SQL.
const { logAudit } = require("../../utils/audit");
const c = require("./common");
const { yearShare } = require("./leaveDays");
const { balanceLock, yearFigures } = require("./leaveRequests");

const { HttpError } = c;
const db = () => require("../../db");

const SELECT = `
  SELECT b.id, b.user_id, b.leave_type_id, t.code AS leave_type_code, t.name_ar, t.name_en, t.name_fr, t.counts_against_balance, b.year,
         b.entitled_days::text AS entitled_days, b.adjusted_days::text AS adjusted_days,
         COALESCE(u.used, 0)::numeric(8,2)::text AS used_days,
         COALESCE(u.pending, 0)::numeric(8,2)::text AS pending_days,
         (b.entitled_days + b.adjusted_days - COALESCE(u.used, 0))::numeric(8,2)::text AS remaining_days,
         (b.entitled_days + b.adjusted_days - COALESCE(u.used, 0) - COALESCE(u.pending, 0))::numeric(8,2)::text AS available_days
    FROM hr_leave_balances b
    JOIN hr_leave_types t ON t.id = b.leave_type_id
    LEFT JOIN LATERAL (
      SELECT sum(${yearShare("r", "b.year")}) FILTER (WHERE r.status = 'approved') AS used,
             sum(${yearShare("r", "b.year")}) FILTER (WHERE r.status = 'pending') AS pending
        FROM hr_leave_requests r
       WHERE r.user_id = b.user_id AND r.leave_type_id = b.leave_type_id AND r.status IN ('approved', 'pending')
         AND r.start_date <= make_date(b.year, 12, 31) AND r.end_date >= make_date(b.year, 1, 1)
    ) u ON true`;

/** Balances of one user for one year, with derived used / remaining. `runner` is a pool or a client. */
async function balancesFor(runner, userId, year) {
  return (await runner.query(`${SELECT} WHERE b.user_id = $1 AND b.year = $2 ORDER BY t.code ASC`, [userId, year])).rows;
}

async function listBalances(user, query = {}) {
  c.requirePerm(user, "hr:read");
  const where = [];
  const params = [];
  const uid = c.oneValue(query.user_id, "user_id");
  if (uid !== undefined && uid !== "") {
    params.push(c.parseId(uid, { label: "user_id" }));
    where.push(`b.user_id = $${params.length}`);
  }
  const yr = c.oneValue(query.year, "year");
  if (yr !== undefined && yr !== "") {
    params.push(c.parseYear(yr));
    where.push(`b.year = $${params.length}`);
  }
  const { limit, offset } = c.pageParams(query);
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await db().query(`SELECT count(*)::int AS n FROM hr_leave_balances b ${filter}`, params)).rows[0].n;
  const rows = (await db().query(`${SELECT} ${filter} ORDER BY b.year DESC, b.user_id ASC, t.code ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset])).rows;
  return { rows, total };
}

/** PUT: upsert on (user_id, leave_type_id, year). Idempotent: the same body twice leaves one row with the same values. */
async function setBalance(user, input) {
  c.requirePerm(user, "hr:write");
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  c.onlyKeys(input, ["user_id", "leave_type_id", "year", "entitled_days", "adjusted_days"]);
  const userId = c.parseId(input.user_id, { label: "user_id" });
  if (userId === user.id) throw new HttpError(403, "someone else must change your own balance/manager/schedule");
  const typeId = c.parseId(input.leave_type_id, { label: "leave_type_id" });
  const year = c.parseYear(input.year);
  if (input.entitled_days === undefined) throw new HttpError(400, "entitled_days is required");
  const entitled = c.parseDays(input.entitled_days, { label: "entitled_days" });
  const adjusted = input.adjusted_days === undefined ? undefined : c.parseDays(input.adjusted_days, { label: "adjusted_days", allowNegative: true });
  return c.inTransaction(async (client) => {
    // Same lock as leave creation / approval: an approval can never pass its check against an entitlement this write is lowering.
    await balanceLock(client, userId, typeId);
    const { STAFF_ROLES } = require("../../middleware/staff");
    const u = (await client.query("SELECT role FROM users WHERE id = $1 FOR SHARE", [userId])).rows[0];
    if (!u || !STAFF_ROLES.has(u.role)) throw new HttpError(404, "Employee not found");
    const t = (await client.query("SELECT id, counts_against_balance FROM hr_leave_types WHERE id = $1 FOR SHARE", [typeId])).rows[0];
    if (!t) throw new HttpError(404, "Leave type not found");
    const cur = (await client.query("SELECT id, entitled_days::text AS entitled_days, adjusted_days::text AS adjusted_days FROM hr_leave_balances WHERE user_id = $1 AND leave_type_id = $2 AND year = $3 FOR UPDATE", [userId, typeId, year])).rows[0];
    // Lowering the entitlement below what is already approved + pending would overdraw the person: refused. (Keeping or raising
    // the granted days is always allowed, so an already-overdrawn legacy balance can still be repaired step by step.)
    if (t.counts_against_balance) {
      const oldGranted = cur ? Number(cur.entitled_days) + Number(cur.adjusted_days) : 0;
      const newGranted = Number(entitled) + Number(adjusted === undefined ? (cur ? cur.adjusted_days : "0") : adjusted);
      if (newGranted < oldGranted) {
        const fig = await yearFigures(client, userId, typeId, year);
        if (newGranted < Number(fig.approved) + Number(fig.pending)) {
          throw new HttpError(409, "The entitlement cannot be lowered below the leave already approved or pending for this year");
        }
      }
    }
    // ON CONFLICT covers two first-time writers racing on the same key: the loser updates instead of failing.
    const r = await client.query(
      `INSERT INTO hr_leave_balances (user_id, leave_type_id, year, entitled_days, adjusted_days)
       VALUES ($1,$2,$3,$4::numeric,COALESCE($5::numeric, 0))
       ON CONFLICT (user_id, leave_type_id, year) DO UPDATE
         SET entitled_days = EXCLUDED.entitled_days, adjusted_days = COALESCE($5::numeric, hr_leave_balances.adjusted_days)
       RETURNING id`,
      [userId, typeId, year, entitled, adjusted === undefined ? null : adjusted]
    );
    const row = (await client.query(`${SELECT} WHERE b.id = $1`, [r.rows[0].id])).rows[0];
    await logAudit({
      client, userId: user.id, action: cur ? "UPDATE" : "CREATE", tableName: "hr_leave_balances", recordId: row.id,
      oldData: cur || null, newData: { user_id: userId, leave_type_id: typeId, year, entitled_days: row.entitled_days, adjusted_days: row.adjusted_days },
    });
    return { ...row, created: !cur };
  });
}

module.exports = { listBalances, setBalance, balancesFor };
