// Period reports (finance:read). Every figure is computed in SQL on NUMERIC and returned as a decimal string, per
// currency: nothing is converted between currencies and no JavaScript arithmetic touches money.
//
// Row rules shared by all reports: invoices count when not deleted and not void, dated by their issue date
// (issued_at, legacy rows: created_at); payments count when not deleted and not voided, dated by payment_date;
// refunds are dated by their creation day (UTC); expenses count when not deleted and not voided, dated by spent_on.
const c = require("./common");

const { HttpError } = c;
const db = () => require("../../db");

const PG_INT_MAX = 2147483647;
/** Issue date of an invoice (UTC day; legacy rows without issued_at fall back to created_at). */
const INVOICE_DATE = "COALESCE(i.issued_at AT TIME ZONE 'UTC', i.created_at)::date";
const LIVE_INVOICE = "i.is_deleted = false AND i.voided_at IS NULL AND i.status <> 'Void'";
const MONEY = (expr) => `(${expr})::numeric(16,2)::text`;

/** Appends "<expr> >= $n::date" / "<= $m::date" for the bounds that are set. */
function rangeSql(expr, range, params) {
  const out = [];
  if (range.from) {
    params.push(range.from);
    out.push(`${expr} >= $${params.length}::date`);
  }
  if (range.to) {
    params.push(range.to);
    out.push(`${expr} <= $${params.length}::date`);
  }
  return out.length ? ` AND ${out.join(" AND ")}` : "";
}

// ------------------------------------------------------------------------------------------------ summary
async function summary(user, query = {}) {
  c.requirePerm(user, "finance:read");
  const range = c.parseRange(query);
  const params = [];
  const sql = `
    WITH d AS (
      SELECT i.currency, 'invoiced' AS k, i.total_amount AS amt FROM invoices i
       WHERE ${LIVE_INVOICE}${rangeSql(INVOICE_DATE, range, params)}
      UNION ALL
      SELECT i.currency, 'collected', p.amount_paid FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE p.is_deleted = false AND p.voided_at IS NULL${rangeSql("p.payment_date", range, params)}
      UNION ALL
      SELECT i.currency, 'refunded', f.amount FROM fin_refunds f JOIN payments p ON p.id = f.payment_id JOIN invoices i ON i.id = f.invoice_id
       WHERE p.is_deleted = false AND p.voided_at IS NULL${rangeSql("(f.created_at AT TIME ZONE 'UTC')::date", range, params)}
      UNION ALL
      SELECT e.currency, 'expenses', e.amount FROM expenses e
       WHERE e.is_deleted = false AND e.voided_at IS NULL${rangeSql("e.spent_on", range, params)}
    )
    SELECT currency,
           ${MONEY("COALESCE(SUM(amt) FILTER (WHERE k = 'invoiced'), 0)")} AS invoiced,
           ${MONEY("COALESCE(SUM(amt) FILTER (WHERE k = 'collected'), 0)")} AS collected,
           ${MONEY("COALESCE(SUM(amt) FILTER (WHERE k = 'refunded'), 0)")} AS refunded,
           ${MONEY("COALESCE(SUM(amt) FILTER (WHERE k = 'expenses'), 0)")} AS expenses,
           ${MONEY("COALESCE(SUM(amt) FILTER (WHERE k = 'collected'), 0) - COALESCE(SUM(amt) FILTER (WHERE k = 'refunded'), 0) - COALESCE(SUM(amt) FILTER (WHERE k = 'expenses'), 0)")} AS net
      FROM d GROUP BY currency ORDER BY currency`;
  const rows = (await db().query(sql, params)).rows;
  return { from: range.from, to: range.to, rows };
}

// ------------------------------------------------------------------------------------------------ receivables
const BUCKETS = ["current", "0-30", "31-60", "61-90", "90+", "no_due_date"];

/**
 * Open balances (invoices.remaining_amount of live, non-draft invoices) per currency with ageing by due_date against
 * `asOf` (default: today, UTC). "current" = not overdue (due on or after asOf); "0-30" = 1..30 days overdue; "31-60",
 * "61-90"; "90+" = more than 90 days overdue; "no_due_date" = open invoices without a due date.
 * Also one row per (candidate, currency), largest balance first, paged.
 */
async function receivables(user, query = {}) {
  c.requirePerm(user, "finance:read");
  const asOfRaw = c.oneValue(query.asOf, "asOf");
  const asOf = asOfRaw === undefined || asOfRaw === "" ? null : c.parseDate(asOfRaw, "asOf");
  const { limit, offset } = c.pageParams(query);
  const open = "i.is_deleted = false AND i.voided_at IS NULL AND i.status NOT IN ('Void','Draft') AND i.remaining_amount > 0";
  const client = await db().connect();
  try {
    const day = (await client.query("SELECT to_char(COALESCE($1::date, (now() AT TIME ZONE 'UTC')::date), 'YYYY-MM-DD') AS d", [asOf])).rows[0].d;
    const bucket = (cond) => MONEY(`COALESCE(SUM(i.remaining_amount) FILTER (WHERE ${cond}), 0)`);
    const cur = (
      await client.query(
        `SELECT i.currency, ${MONEY("SUM(i.remaining_amount)")} AS total, count(*)::int AS count,
                ${bucket("i.due_date >= $1::date")} AS b_current,
                ${bucket("i.due_date < $1::date AND $1::date - i.due_date <= 30")} AS b_0_30,
                ${bucket("$1::date - i.due_date BETWEEN 31 AND 60")} AS b_31_60,
                ${bucket("$1::date - i.due_date BETWEEN 61 AND 90")} AS b_61_90,
                ${bucket("$1::date - i.due_date > 90")} AS b_90,
                ${bucket("i.due_date IS NULL")} AS b_none
           FROM invoices i WHERE ${open} GROUP BY i.currency ORDER BY i.currency`,
        [day]
      )
    ).rows;
    const currencies = cur.map((r) => ({
      currency: r.currency,
      total: r.total,
      count: r.count,
      buckets: { current: r.b_current, "0-30": r.b_0_30, "31-60": r.b_31_60, "61-90": r.b_61_90, "90+": r.b_90, no_due_date: r.b_none },
    }));
    const total = Number(
      (await client.query(`SELECT count(*) AS n FROM (SELECT 1 FROM invoices i WHERE ${open} GROUP BY i.candidate_id, i.currency) g`)).rows[0].n
    );
    const rows = (
      await client.query(
        `SELECT i.candidate_id, c.full_name AS candidate_name, i.currency, ${MONEY("SUM(i.remaining_amount)")} AS balance, count(*)::int AS invoices,
                to_char(MIN(i.due_date), 'YYYY-MM-DD') AS oldest_due_date
           FROM invoices i JOIN candidates c ON c.id = i.candidate_id WHERE ${open}
          GROUP BY i.candidate_id, c.full_name, i.currency
          ORDER BY SUM(i.remaining_amount) DESC, i.candidate_id, i.currency LIMIT $1 OFFSET $2`,
        [limit, offset]
      )
    ).rows;
    return { asOf: day, currencies, rows, total };
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------------------------------------ by service
/** Invoice line totals grouped by catalogue service (or by description for free-text lines), per currency. */
async function byService(user, query = {}) {
  c.requirePerm(user, "finance:read");
  const range = c.parseRange(query);
  const params = [];
  const rows = (
    await db().query(
      `SELECT currency, service_id, code, name_ar, name_en, name_fr, label, count(*)::int AS lines, ${MONEY("SUM(quantity)")} AS quantity, ${MONEY("SUM(line_total)")} AS total
         FROM (
           SELECT i.currency, it.service_id, s.code, s.name_ar, s.name_en, s.name_fr, it.quantity, it.line_total,
                  CASE WHEN it.service_id IS NULL THEN it.description ELSE COALESCE(s.name_en, s.name_fr, s.name_ar, s.code) END AS label
             FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id LEFT JOIN fin_services s ON s.id = it.service_id
            WHERE ${LIVE_INVOICE}${rangeSql(INVOICE_DATE, range, params)}
         ) x
        GROUP BY currency, service_id, code, name_ar, name_en, name_fr, label
        ORDER BY currency, SUM(line_total) DESC, label`,
      params
    )
  ).rows;
  return { from: range.from, to: range.to, rows };
}

// ------------------------------------------------------------------------------------------------ by staff
/** Invoices issued and payments recorded per staff user (created_by) and currency. */
async function byStaff(user, query = {}) {
  c.requirePerm(user, "finance:read");
  const range = c.parseRange(query);
  const params = [];
  const invRange = rangeSql(INVOICE_DATE, range, params);
  const payRange = rangeSql("p.payment_date", range, params);
  const rows = (
    await db().query(
      `WITH inv AS (
         SELECT COALESCE(i.created_by, 0) AS k, i.currency, count(*)::int AS n, SUM(i.total_amount) AS t FROM invoices i
          WHERE ${LIVE_INVOICE}${invRange} GROUP BY 1, 2),
       pay AS (
         SELECT COALESCE(p.created_by, 0) AS k, i.currency, count(*)::int AS n, SUM(p.amount_paid) AS t FROM payments p JOIN invoices i ON i.id = p.invoice_id
          WHERE p.is_deleted = false AND p.voided_at IS NULL${payRange} GROUP BY 1, 2)
       SELECT NULLIF(COALESCE(inv.k, pay.k), 0) AS user_id, u.full_name AS user_name, COALESCE(inv.currency, pay.currency) AS currency,
              COALESCE(inv.n, 0) AS invoices_count, ${MONEY("COALESCE(inv.t, 0)")} AS invoices_total,
              COALESCE(pay.n, 0) AS payments_count, ${MONEY("COALESCE(pay.t, 0)")} AS payments_total
         FROM inv FULL JOIN pay ON pay.k = inv.k AND pay.currency = inv.currency
         LEFT JOIN users u ON u.id = COALESCE(inv.k, pay.k)
        ORDER BY u.full_name NULLS LAST, 1, 3`,
      params
    )
  ).rows;
  return { from: range.from, to: range.to, rows };
}

// ------------------------------------------------------------------------------------------------ statement
/**
 * Chronological statement for one candidate: invoices (debit), payments (credit), refunds (debit), voided rows left out.
 * `balance` is the running ledger balance per currency (invoiced - paid + refunded); `balances[].open` is the sum of the
 * invoices' remaining amounts (a refund does not reopen the debt unless staff asked for it, see CHECKLIST.md).
 */
async function candidateStatement(user, rawId) {
  c.requirePerm(user, "finance:read");
  const id = c.parseId(rawId);
  if (id > PG_INT_MAX) throw new HttpError(404, "Candidate not found");
  const cand = (await db().query("SELECT id, full_name FROM candidates WHERE id = $1 AND is_deleted = false", [id])).rows[0];
  if (!cand) throw new HttpError(404, "Candidate not found");
  const entries = `
    SELECT ${INVOICE_DATE} AS d, 0 AS ord, i.id AS eid, 'invoice' AS kind, COALESCE(i.number, '#' || i.id) AS ref, i.id AS invoice_id,
           i.currency, i.total_amount AS debit, 0::numeric AS credit
      FROM invoices i WHERE i.candidate_id = $1 AND ${LIVE_INVOICE}
    UNION ALL
    SELECT p.payment_date, 1, p.id, 'payment', COALESCE(p.receipt_number, '#' || p.id), p.invoice_id, i.currency, 0::numeric, p.amount_paid
      FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.candidate_id = $1 AND p.is_deleted = false AND p.voided_at IS NULL
    UNION ALL
    SELECT (f.created_at AT TIME ZONE 'UTC')::date, 2, f.id, 'refund', COALESCE(p.receipt_number, '#' || p.id), f.invoice_id, i.currency, f.amount, 0::numeric
      FROM fin_refunds f JOIN payments p ON p.id = f.payment_id JOIN invoices i ON i.id = f.invoice_id
     WHERE p.candidate_id = $1 AND p.is_deleted = false AND p.voided_at IS NULL`;
  const client = await db().connect();
  try {
    const rows = (
      await client.query(
        `WITH e AS (${entries})
         SELECT to_char(d, 'YYYY-MM-DD') AS date, kind, ref, invoice_id, currency, ${MONEY("debit")} AS debit, ${MONEY("credit")} AS credit,
                ${MONEY("SUM(debit - credit) OVER (PARTITION BY currency ORDER BY d, ord, eid ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)")} AS balance
           FROM e ORDER BY d, ord, eid`,
        [id]
      )
    ).rows;
    const balances = (
      await client.query(
        `WITH e AS (${entries}),
              b AS (SELECT currency, SUM(debit - credit) AS bal FROM e GROUP BY currency),
              o AS (SELECT i.currency, SUM(i.remaining_amount) AS open FROM invoices i WHERE i.candidate_id = $1 AND ${LIVE_INVOICE} GROUP BY i.currency)
         SELECT COALESCE(b.currency, o.currency) AS currency, ${MONEY("COALESCE(b.bal, 0)")} AS balance, ${MONEY("COALESCE(o.open, 0)")} AS open
           FROM b FULL JOIN o ON o.currency = b.currency ORDER BY 1`,
        [id]
      )
    ).rows;
    return { candidate: { id: cand.id, full_name: cand.full_name }, entries: rows, balances };
  } finally {
    client.release();
  }
}

module.exports = { summary, receivables, byService, byStaff, candidateStatement, INVOICE_DATE, LIVE_INVOICE, rangeSql, BUCKETS };
