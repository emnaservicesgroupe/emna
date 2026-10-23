// Service catalogue (fin_services): priced services staff pick when building an invoice. Rows are deactivated, never
// deleted (old invoice items keep their service_id). Prices are NUMERIC(12,2) handled as normalised decimal strings.
const { logAudit } = require("../../utils/audit");
const { parseMoney } = require("./money");
const c = require("./common");

const { HttpError } = c;
const db = () => require("../../db");
const CODE_RE = /^[A-Z0-9_-]{2,30}$/;
const NAME_MAX = 160;
const COLS = "id, code, name_ar, name_en, name_fr, default_price::text AS default_price, currency, active, created_by, created_at";
const NAME_FIELDS = ["name_ar", "name_en", "name_fr"];

function validateCode(v) {
  if (typeof v !== "string" || !CODE_RE.test(v)) throw new HttpError(400, "code must be 2-30 characters of A-Z, 0-9, _ or - (upper-case)");
  return v;
}

function validate(input, { creating }) {
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  const allowed = creating ? ["code", ...NAME_FIELDS, "default_price", "currency", "active"] : [...NAME_FIELDS, "default_price", "currency", "active"];
  for (const k of Object.keys(input)) {
    if (k === "code" && !creating) throw new HttpError(400, "code cannot be changed");
    if (!allowed.includes(k)) throw new HttpError(400, `Unknown field: ${k}`);
  }
  const out = {};
  if (creating) out.code = validateCode(input.code);
  for (const f of NAME_FIELDS) if (input[f] !== undefined) out[f] = c.cleanText(input[f], f, NAME_MAX);
  if (input.default_price !== undefined) out.default_price = parseMoney(input.default_price, { label: "default_price", maxIntDigits: 10 });
  else if (creating) out.default_price = "0.00";
  if (input.currency !== undefined) out.currency = c.parseCurrency(input.currency);
  else if (creating) out.currency = c.allowedCurrencies().includes("TND") ? "TND" : c.allowedCurrencies()[0];
  if (input.active !== undefined) {
    if (typeof input.active !== "boolean") throw new HttpError(400, "active must be true or false");
    out.active = input.active;
  }
  return out;
}

async function listServices(user, query = {}) {
  c.requirePerm(user, "finance:read");
  const where = [];
  const params = [];
  const active = c.oneValue(query.active, "active");
  if (active !== undefined && active !== "") {
    if (active !== "true" && active !== "false") throw new HttpError(400, "active must be true or false");
    params.push(active === "true");
    where.push(`active = $${params.length}`);
  }
  const q = c.oneValue(query.q, "q");
  if (q) {
    params.push(`%${c.likeEscape(q.slice(0, 100))}%`);
    where.push(`(code ILIKE $${params.length} OR name_ar ILIKE $${params.length} OR name_en ILIKE $${params.length} OR name_fr ILIKE $${params.length})`);
  }
  const rows = (await db().query(`SELECT ${COLS} FROM fin_services ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY active DESC, code ASC`, params)).rows;
  return { rows, total: rows.length };
}

async function createService(user, input) {
  c.requirePerm(user, "finance:write");
  const v = validate(input, { creating: true });
  if (!NAME_FIELDS.some((f) => v[f])) throw new HttpError(400, "At least one of name_ar, name_en, name_fr is required");
  try {
    return await c.inTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO fin_services (code, name_ar, name_en, name_fr, default_price, currency, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
        [v.code, v.name_ar || null, v.name_en || null, v.name_fr || null, v.default_price, v.currency, v.active === undefined ? true : v.active, user.id]
      );
      await logAudit({ client, userId: user.id, action: "CREATE", tableName: "fin_services", recordId: r.rows[0].id, newData: r.rows[0] });
      return r.rows[0];
    });
  } catch (err) {
    if (err && err.code === "23505") throw new HttpError(409, "A service with this code already exists");
    throw err;
  }
}

async function updateService(user, rawId, input) {
  c.requirePerm(user, "finance:write");
  const id = c.parseId(rawId);
  const v = validate(input, { creating: false });
  if (!Object.keys(v).length) throw new HttpError(400, "No fields to update");
  return c.inTransaction(async (client) => {
    const cur = (await client.query(`SELECT ${COLS} FROM fin_services WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!cur) throw new HttpError(404, "Service not found");
    const next = { ...cur, ...v };
    if (!NAME_FIELDS.some((f) => next[f])) throw new HttpError(400, "At least one of name_ar, name_en, name_fr is required");
    const sets = [];
    const params = [id];
    for (const [k, val] of Object.entries(v)) {
      params.push(val);
      sets.push(`${k} = $${params.length}${k === "default_price" ? "::numeric" : ""}`);
    }
    const r = await client.query(`UPDATE fin_services SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLS}`, params);
    await logAudit({ client, userId: user.id, action: "UPDATE", tableName: "fin_services", recordId: id, oldData: cur, newData: r.rows[0] });
    return r.rows[0];
  });
}

module.exports = { listServices, createService, updateService, validateCode };
