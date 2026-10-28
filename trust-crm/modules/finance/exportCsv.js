// CSV exports (finance:export): invoices, payments, expenses, optionally limited to ?from&to.
//
// Format: UTF-8 with a BOM (Excel reads Arabic correctly), EVERY cell quoted with embedded quotes doubled, CRLF line ends.
// Spreadsheet-injection guard: a cell whose first character is = + - @ TAB CR LF (or the full-width = + - @) gets a leading single quote so a
// spreadsheet shows it as text instead of running it as a formula. Amounts are plain decimal strings straight from NUMERIC.
// Row cap: FIN_EXPORT_MAX_ROWS (default and maximum 50000); when more rows match, the file is cut at the cap and the route
// answers with the header X-Row-Limit-Hit: true. Voided rows are exported (with voided_at / void_reason), not hidden.
const { logAudit } = require("../../utils/audit");
const c = require("./common");
const { INVOICE_DATE, rangeSql } = require("./reports");

const { HttpError } = c;
const db = () => require("../../db");

const HARD_MAX_ROWS = 50000;
const FORMULA_START = /^[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/; // also LF and the full-width lookalikes of = + - @
const TS = (expr) => `to_char(${expr}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

function maxRows() {
  const raw = String(process.env.FIN_EXPORT_MAX_ROWS || "").trim();
  if (/^\d{1,9}$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1) return Math.min(n, HARD_MAX_ROWS);
  }
  return HARD_MAX_ROWS;
}

function csvCell(value) {
  let s = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** BOM + header + rows, every cell quoted, each row ending in CRLF. */
function toCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(",")];
  for (const r of rows) lines.push(columns.map((k) => csvCell(r[k])).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

const MONEY = (expr) => `(${expr})::numeric(14,2)::text`;

const KINDS = {
  invoices: {
    table: "invoices",
    columns: ["number", "status", "candidate_id", "candidate_name", "currency", "subtotal", "tax_amount", "total_amount", "remaining_amount", "issued_at", "due_date", "voided_at", "void_reason", "created_by"],
    sql: (range, params) => `
      SELECT i.number, i.status, i.candidate_id, c.full_name AS candidate_name, i.currency, ${MONEY("i.subtotal")} AS subtotal, ${MONEY("i.tax_amount")} AS tax_amount,
             ${MONEY("i.total_amount")} AS total_amount, ${MONEY("i.remaining_amount")} AS remaining_amount,
             ${TS("COALESCE(i.issued_at AT TIME ZONE 'UTC', i.created_at)")} AS issued_at, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
             ${TS("i.voided_at AT TIME ZONE 'UTC'")} AS voided_at, i.void_reason, i.created_by
        FROM invoices i JOIN candidates c ON c.id = i.candidate_id
       WHERE i.is_deleted = false${rangeSql(INVOICE_DATE, range, params)} ORDER BY i.id`,
  },
  payments: {
    table: "payments",
    columns: ["receipt_number", "invoice_number", "candidate_id", "candidate_name", "currency", "amount_paid", "refunded", "payment_method", "payment_date", "reference", "notes", "voided_at", "void_reason", "created_by"],
    sql: (range, params) => `
      SELECT p.receipt_number, i.number AS invoice_number, p.candidate_id, c.full_name AS candidate_name, i.currency, ${MONEY("p.amount_paid")} AS amount_paid,
             ${MONEY("COALESCE((SELECT SUM(f.amount) FROM fin_refunds f WHERE f.payment_id = p.id), 0)")} AS refunded,
             p.payment_method, to_char(p.payment_date, 'YYYY-MM-DD') AS payment_date, p.reference, p.notes,
             ${TS("p.voided_at AT TIME ZONE 'UTC'")} AS voided_at, p.void_reason, p.created_by
        FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN candidates c ON c.id = p.candidate_id
       WHERE p.is_deleted = false${rangeSql("p.payment_date", range, params)} ORDER BY p.id`,
  },
  expenses: {
    table: "expenses",
    columns: ["id", "title", "category", "payee", "currency", "amount", "spent_on", "notes", "voided_at", "void_reason", "created_by"],
    sql: (range, params) => `
      SELECT e.id, e.title, k.name AS category, e.payee, e.currency, ${MONEY("e.amount")} AS amount, to_char(e.spent_on, 'YYYY-MM-DD') AS spent_on, e.notes,
             ${TS("e.voided_at AT TIME ZONE 'UTC'")} AS voided_at, e.void_reason, e.created_by
        FROM expenses e LEFT JOIN expense_categories k ON k.id = e.category_id
       WHERE e.is_deleted = false${rangeSql("e.spent_on", range, params)} ORDER BY e.id`,
  },
};

/**
 * @param {{id:number, role:string}} user
 * @param {"invoices"|"payments"|"expenses"} kind
 * @param {object} query ?from&to
 * @returns {{csv: string, filename: string, truncated: boolean, rows: number}}
 */
async function exportCsv(user, kind, query = {}) {
  c.requirePerm(user, "finance:export");
  const def = Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
  if (!def) throw new HttpError(404, "Unknown export");
  const range = c.parseRange(query);
  const cap = maxRows();
  const params = [];
  const sql = `${def.sql(range, params)} LIMIT ${cap + 1}`; // cap is a validated integer
  const all = (await db().query(sql, params)).rows;
  const truncated = all.length > cap;
  const rows = truncated ? all.slice(0, cap) : all;
  const span = range.from || range.to ? `-${range.from || "start"}_${range.to || "end"}` : "";
  await logAudit({ userId: user.id, action: "EXPORT", tableName: def.table, newData: { format: "csv", from: range.from, to: range.to, rows: rows.length, truncated } });
  return { csv: toCsv(def.columns, rows), filename: `${kind}${span}.csv`, truncated, rows: rows.length };
}

module.exports = { exportCsv, toCsv, csvCell, maxRows, HARD_MAX_ROWS };
