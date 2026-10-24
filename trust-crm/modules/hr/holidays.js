// Public holidays (hr_holidays): dates entered by the owner / HR, one row per day. HR may delete any (audited).
const { logAudit } = require("../../utils/audit");
const c = require("./common");

const { HttpError } = c;
const db = () => require("../../db");
const COLS = "id, day::text AS day, name, created_by, created_at";

async function listHolidays(user, query = {}) {
  c.requirePerm(user, "hr:read");
  const raw = c.oneValue(query.year, "year");
  let year;
  if (raw === undefined || raw === "") {
    year = (await db().query("SELECT extract(year FROM now() AT TIME ZONE $1)::int AS y", [c.companyTimezone()])).rows[0].y;
  } else {
    year = c.parseYear(raw);
  }
  const rows = (await db().query(`SELECT ${COLS} FROM hr_holidays WHERE day >= make_date($1,1,1) AND day <= make_date($1,12,31) ORDER BY day ASC`, [year])).rows;
  return { year, rows, total: rows.length };
}

async function createHoliday(user, input) {
  c.requirePerm(user, "hr:write");
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  c.onlyKeys(input, ["day", "name"]);
  const day = c.parseHrDate(input.day, "day");
  const name = c.requiredText(input.name, "name", 160);
  return c.inTransaction(
    async (client) => {
      const r = await client.query(`INSERT INTO hr_holidays (day, name, created_by) VALUES ($1::date,$2,$3) RETURNING ${COLS}`, [day, name, user.id]);
      await logAudit({ client, userId: user.id, action: "CREATE", tableName: "hr_holidays", recordId: r.rows[0].id, newData: r.rows[0] });
      return r.rows[0];
    },
    { unique: "A holiday already exists on this day" }
  );
}

async function deleteHoliday(user, rawId) {
  c.requirePerm(user, "hr:write");
  const id = c.parseId(rawId, { notFound: "Holiday not found" });
  return c.inTransaction(async (client) => {
    const r = await client.query(`DELETE FROM hr_holidays WHERE id = $1 RETURNING ${COLS}`, [id]);
    if (!r.rowCount) throw new HttpError(404, "Holiday not found");
    await logAudit({ client, userId: user.id, action: "DELETE", tableName: "hr_holidays", recordId: id, oldData: r.rows[0] });
    return { deleted: true, holiday: r.rows[0] };
  });
}

module.exports = { listHolidays, createHoliday, deleteHoliday };
