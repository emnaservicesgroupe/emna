// Expenses and expense categories. Amounts are decimal strings (NUMERIC(12,2) in SQL). Posted expenses are never edited
// or deleted: a void keeps the row (voided_at / void_reason) and posts a reversing ledger credit.
// Every mutation is ONE transaction: row + fin_ledger entry + audit_logs row (logAudit with the tx client).
const { logAudit } = require("../../utils/audit");
const { parseMoney } = require("./money");
const c = require("./common");

const { HttpError } = c;
const db = () => require("../../db");

const PG_INT_MAX = 2147483647;
const TITLE_MAX = 160;
const PAYEE_MAX = 160;
const NOTES_MAX = 500;
const REASON_MAX = 500;
const CATEGORY_MAX = 80;

const EXPENSE_FROM = `FROM expenses e LEFT JOIN expense_categories k ON k.id = e.category_id`;
const EXPENSE_COLS = `e.id, e.title, e.amount::text AS amount, e.currency, to_char(e.spent_on, 'YYYY-MM-DD') AS spent_on, e.category_id, k.name AS category_name,
  e.payee, e.notes, e.created_by, e.created_at, e.voided_at, e.void_reason`;

const expenseId = (raw) => {
  const id = c.parseId(raw);
  if (id > PG_INT_MAX) throw new HttpError(404, "Expense not found");
  return id;
};
const categoryId = (raw, label = "category_id") => {
  const id = c.parseId(typeof raw === "number" ? String(raw) : raw);
  if (id > PG_INT_MAX) throw new HttpError(400, `${label}: category not found`);
  return id;
};

async function loadExpense(client, id) {
  return (await client.query(`SELECT ${EXPENSE_COLS} ${EXPENSE_FROM} WHERE e.id = $1 AND e.is_deleted = false`, [id])).rows[0] || null;
}

function validateCreate(input) {
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  for (const k of Object.keys(input)) if (!["title", "amount", "currency", "spent_on", "category_id", "payee", "notes"].includes(k)) throw new HttpError(400, `Unknown field: ${k}`);
  if (input.amount === undefined || input.amount === null) throw new HttpError(400, "amount is required");
  if (input.spent_on === undefined || input.spent_on === null) throw new HttpError(400, "spent_on is required");
  return {
    title: c.requiredText(input.title, "title", TITLE_MAX),
    amount: parseMoney(input.amount, { label: "amount", positive: true, maxIntDigits: 10 }),
    currency: c.parseCurrency(input.currency),
    spentOn: c.parseDate(input.spent_on, "spent_on"),
    categoryId: input.category_id === undefined || input.category_id === null ? null : categoryId(input.category_id),
    payee: c.cleanText(input.payee, "payee", PAYEE_MAX),
    notes: c.cleanText(input.notes, "notes", NOTES_MAX),
  };
}

/** Records an expense (finance:write): row, ledger debit (kind 'expense', no candidate) and audit in one transaction. */
async function createExpense(user, input) {
  c.requirePerm(user, "finance:write");
  const v = validateCreate(input);
  return c.inTransaction(async (client) => {
    const d = (await client.query("SELECT $1::date > (now() AT TIME ZONE 'UTC')::date + 1 AS future", [v.spentOn])).rows[0];
    if (d.future) throw new HttpError(400, "spent_on cannot be in the future");
    if (v.categoryId !== null) {
      const cat = (await client.query("SELECT active FROM expense_categories WHERE id = $1 FOR SHARE", [v.categoryId])).rows[0];
      if (!cat) throw new HttpError(400, "category_id: category not found");
      if (!cat.active) throw new HttpError(409, "category_id: category is inactive");
    }
    const row = (
      await client.query(
        `INSERT INTO expenses (title, amount, currency, spent_on, category_id, payee, notes, created_by)
         VALUES ($1, $2::numeric, $3, $4::date, $5, $6, $7, $8) RETURNING id`,
        [v.title, v.amount, v.currency, v.spentOn, v.categoryId, v.payee, v.notes, user.id]
      )
    ).rows[0];
    await client.query(
      "INSERT INTO fin_ledger (kind, ref_table, ref_id, candidate_id, currency, debit, credit, actor_id) VALUES ('expense','expenses',$1,NULL,$2,$3::numeric,0,$4)",
      [row.id, v.currency, v.amount, user.id]
    );
    const full = await loadExpense(client, row.id);
    await logAudit({ client, userId: user.id, action: "CREATE", tableName: "expenses", recordId: row.id, newData: full });
    return full;
  });
}

async function listExpenses(user, query = {}) {
  c.requirePerm(user, "finance:read");
  const where = ["e.is_deleted = false"];
  const params = [];
  const add = (val) => (params.push(val), `$${params.length}`);
  const one = (k) => {
    const v = c.oneValue(query[k], k);
    return v === undefined || v === "" ? undefined : v;
  };
  const cat = one("category_id");
  if (cat !== undefined) where.push(`e.category_id = ${add(c.parseId(cat) > PG_INT_MAX ? 0 : c.parseId(cat))}`);
  const { from, to } = c.parseRange(query);
  if (from) where.push(`e.spent_on >= ${add(from)}::date`);
  if (to) where.push(`e.spent_on <= ${add(to)}::date`);
  const cur = one("currency");
  if (cur !== undefined) {
    if (!/^[A-Z]{3}$/.test(cur)) throw new HttpError(400, "currency must be a 3-letter upper-case code");
    where.push(`e.currency = ${add(cur)}`);
  }
  const incl = one("include_voided");
  if (incl !== undefined && !["true", "false", "1", "0"].includes(incl)) throw new HttpError(400, "include_voided must be true or false");
  if (!(incl === "true" || incl === "1")) where.push("e.voided_at IS NULL");
  const { limit, offset } = c.pageParams(query);
  const w = where.join(" AND ");
  const total = Number((await db().query(`SELECT count(*) AS n FROM expenses e WHERE ${w}`, params)).rows[0].n);
  const rows = (await db().query(`SELECT ${EXPENSE_COLS} ${EXPENSE_FROM} WHERE ${w} ORDER BY e.id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`, params)).rows;
  return { rows, total };
}

/** Voids an expense (finance:void): the row stays, a reversing ledger credit is posted. Only once. */
async function voidExpense(user, rawId, input) {
  c.requirePerm(user, "finance:void");
  const id = expenseId(rawId);
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  for (const k of Object.keys(input)) if (k !== "reason") throw new HttpError(400, `Unknown field: ${k}`);
  const reason = c.requiredText(input.reason, "reason", REASON_MAX);
  return c.inTransaction(async (client) => {
    const lock = (await client.query("SELECT id, voided_at, amount::text AS amount, currency FROM expenses WHERE id = $1 AND is_deleted = false FOR UPDATE", [id])).rows[0];
    if (!lock) throw new HttpError(404, "Expense not found");
    if (lock.voided_at) throw new HttpError(409, "Expense is already void");
    const before = await loadExpense(client, id);
    await client.query("UPDATE expenses SET voided_at = now(), void_reason = $2 WHERE id = $1", [id, reason]);
    await client.query(
      "INSERT INTO fin_ledger (kind, ref_table, ref_id, candidate_id, currency, debit, credit, actor_id) VALUES ('void','expenses',$1,NULL,$2,0,$3::numeric,$4)",
      [id, lock.currency, lock.amount, user.id]
    );
    const next = await loadExpense(client, id);
    await logAudit({ client, userId: user.id, action: "VOID", tableName: "expenses", recordId: id, oldData: before, newData: next });
    return next;
  });
}

// ------------------------------------------------------------------------------------------------ categories
const CAT_COLS = "id, name, active";
const catId = (raw) => {
  const id = c.parseId(raw);
  if (id > PG_INT_MAX) throw new HttpError(404, "Category not found");
  return id;
};

async function listCategories(user, query = {}) {
  c.requirePerm(user, "finance:read");
  const where = [];
  const params = [];
  const active = c.oneValue(query.active, "active");
  if (active !== undefined && active !== "") {
    if (active !== "true" && active !== "false") throw new HttpError(400, "active must be true or false");
    params.push(active === "true");
    where.push(`active = $${params.length}`);
  }
  const rows = (await db().query(`SELECT ${CAT_COLS} FROM expense_categories ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY active DESC, lower(name), id`, params)).rows;
  return { rows, total: rows.length };
}

async function createCategory(user, input) {
  c.requirePerm(user, "finance:write");
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  for (const k of Object.keys(input)) if (k !== "name") throw new HttpError(400, `Unknown field: ${k}`);
  const name = c.requiredText(input.name, "name", CATEGORY_MAX);
  try {
    return await c.inTransaction(async (client) => {
      const row = (await client.query(`INSERT INTO expense_categories (name) VALUES ($1) RETURNING ${CAT_COLS}`, [name])).rows[0];
      await logAudit({ client, userId: user.id, action: "CREATE", tableName: "expense_categories", recordId: row.id, newData: row });
      return row;
    });
  } catch (err) {
    if (err && err.code === "23505") throw new HttpError(409, "A category with this name already exists");
    throw err;
  }
}

async function updateCategory(user, rawId, input) {
  c.requirePerm(user, "finance:write");
  const id = catId(rawId);
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  for (const k of Object.keys(input)) if (!["name", "active"].includes(k)) throw new HttpError(400, `Unknown field: ${k}`);
  const sets = [];
  const params = [id];
  if (input.name !== undefined) {
    params.push(c.requiredText(input.name, "name", CATEGORY_MAX));
    sets.push(`name = $${params.length}`);
  }
  if (input.active !== undefined) {
    if (typeof input.active !== "boolean") throw new HttpError(400, "active must be true or false");
    params.push(input.active);
    sets.push(`active = $${params.length}`);
  }
  if (!sets.length) throw new HttpError(400, "No fields to update");
  try {
    return await c.inTransaction(async (client) => {
      const cur = (await client.query(`SELECT ${CAT_COLS} FROM expense_categories WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw new HttpError(404, "Category not found");
      const row = (await client.query(`UPDATE expense_categories SET ${sets.join(", ")} WHERE id = $1 RETURNING ${CAT_COLS}`, params)).rows[0];
      await logAudit({ client, userId: user.id, action: "UPDATE", tableName: "expense_categories", recordId: id, oldData: cur, newData: row });
      return row;
    });
  } catch (err) {
    if (err && err.code === "23505") throw new HttpError(409, "A category with this name already exists");
    throw err;
  }
}

module.exports = { createExpense, listExpenses, voidExpense, listCategories, createCategory, updateCategory };
