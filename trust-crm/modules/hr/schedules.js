// Working schedules (hr_schedules). weekly = {"mon":{"start":"09:00","end":"17:30","break_minutes":60},"sat":null,...}; a missing or
// null day is a day off. The DB function hr_schedule_weekly_valid is the backstop; the service gives precise 400 messages.
const { logAudit } = require("../../utils/audit");
const c = require("./common");

const { HttpError } = c;
const db = () => require("../../db");
const COLS = "id, name, weekly, grace_minutes, timezone, created_at";
const GRACE_MAX = 120;
const BREAK_MAX = 720;

function minutes(hhmm) {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

function validateWeekly(w) {
  if (!c.isObj(w)) throw new HttpError(400, "weekly must be an object keyed by mon..sun");
  const out = {};
  for (const [day, v] of Object.entries(w)) {
    if (!c.DAYS.includes(day)) throw new HttpError(400, `weekly has an unknown day: ${day}`);
    if (v === null) {
      out[day] = null;
      continue;
    }
    if (!c.isObj(v)) throw new HttpError(400, `weekly.${day} must be an object or null`);
    c.onlyKeys(v, ["start", "end", "break_minutes"]);
    const start = c.parseHHMM(v.start, `weekly.${day}.start`);
    const end = c.parseHHMM(v.end, `weekly.${day}.end`);
    if (end <= start) throw new HttpError(400, `weekly.${day}.end must be after start`);
    const entry = { start, end };
    if (v.break_minutes !== undefined) {
      const b = v.break_minutes;
      if (!Number.isInteger(b) || b < 0 || b > BREAK_MAX) throw new HttpError(400, `weekly.${day}.break_minutes must be an integer 0..${BREAK_MAX}`);
      if (b >= minutes(end) - minutes(start)) throw new HttpError(400, `weekly.${day}.break_minutes must be shorter than the working day`);
      entry.break_minutes = b;
    }
    out[day] = entry;
  }
  return out;
}

function parseGrace(v) {
  if (!Number.isInteger(v) || v < 0 || v > GRACE_MAX) throw new HttpError(400, `grace_minutes must be an integer 0..${GRACE_MAX}`);
  return v;
}

async function validate(input, { creating }) {
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  c.onlyKeys(input, ["name", "weekly", "grace_minutes", "timezone"]);
  const out = {};
  if (input.name !== undefined || creating) out.name = c.requiredText(input.name, "name", 120);
  if (input.weekly !== undefined) out.weekly = validateWeekly(input.weekly);
  else if (creating) throw new HttpError(400, "weekly is required");
  if (input.grace_minutes !== undefined) out.grace_minutes = parseGrace(input.grace_minutes);
  if (input.timezone !== undefined) out.timezone = await c.validTimezone(db(), input.timezone);
  else if (creating) out.timezone = c.companyTimezone();
  return out;
}

async function listSchedules(user, query = {}) {
  c.requirePerm(user, "hr:read");
  const { limit, offset } = c.pageParams(query);
  const r = await db().query(`SELECT ${COLS}, count(*) OVER ()::int AS total FROM hr_schedules ORDER BY name ASC, id ASC LIMIT $1 OFFSET $2`, [limit, offset]);
  const total = r.rows.length ? r.rows[0].total : 0;
  return { rows: r.rows.map(({ total: _t, ...row }) => row), total };
}

async function createSchedule(user, input) {
  c.requirePerm(user, "hr:write");
  const v = await validate(input, { creating: true });
  return c.inTransaction(async (client) => {
    const r = await client.query(`INSERT INTO hr_schedules (name, weekly, grace_minutes, timezone) VALUES ($1,$2::jsonb,$3,$4) RETURNING ${COLS}`, [
      v.name, JSON.stringify(v.weekly), v.grace_minutes === undefined ? 10 : v.grace_minutes, v.timezone,
    ]);
    await logAudit({ client, userId: user.id, action: "CREATE", tableName: "hr_schedules", recordId: r.rows[0].id, newData: r.rows[0] });
    return r.rows[0];
  });
}

async function updateSchedule(user, rawId, input) {
  c.requirePerm(user, "hr:write");
  const id = c.parseId(rawId, { notFound: "Schedule not found" });
  const v = await validate(input, { creating: false });
  if (!Object.keys(v).length) throw new HttpError(400, "No fields to update");
  return c.inTransaction(async (client) => {
    const cur = (await client.query(`SELECT ${COLS} FROM hr_schedules WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!cur) throw new HttpError(404, "Schedule not found");
    const sets = [];
    const params = [id];
    for (const [k, val] of Object.entries(v)) {
      params.push(k === "weekly" ? JSON.stringify(val) : val);
      sets.push(`${k} = $${params.length}${k === "weekly" ? "::jsonb" : ""}`);
    }
    const r = await client.query(`UPDATE hr_schedules SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLS}`, params);
    await logAudit({ client, userId: user.id, action: "UPDATE", tableName: "hr_schedules", recordId: id, oldData: cur, newData: r.rows[0] });
    return r.rows[0];
  });
}

module.exports = { listSchedules, createSchedule, updateSchedule, validateWeekly };
