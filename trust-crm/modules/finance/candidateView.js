// Candidate self-view of the accounting data (GET /finance/me, GET /finance/me/invoices/:id/print). Role Candidate only;
// the candidate is the one linked to the caller's login (js_candidate_accounts), never taken from the request. Everything
// else (a foreign invoice, a draft, a deleted or missing one) answers the same 404.
//
// Exposed: number, status, currency, total, remaining, due date, issue date, line items (description, quantity, unit
// price, line total) and payments (receipt number, amount, method, date, voided flag). Never: staff notes, created_by,
// void reasons, payment references, refunds detail, ledger rows, staff or candidate-internal ids beyond the invoice id.
const c = require("./common");
const invoices = require("./invoices");

const { HttpError } = c;
const db = () => require("../../db");

const MAX_INVOICES = 200;
const notFound = () => new HttpError(404, "Not found");

function requireCandidate(user) {
  if (!user || user.role !== "Candidate" || !Number.isSafeInteger(user.id)) throw new HttpError(403, "Access denied");
}

async function ownCandidateId(client, userId) {
  const r = (
    await client.query(
      "SELECT a.candidate_id FROM js_candidate_accounts a JOIN candidates c ON c.id = a.candidate_id AND c.is_deleted = false WHERE a.user_id = $1",
      [userId]
    )
  ).rows[0];
  if (!r) throw notFound();
  return r.candidate_id;
}

async function me(user) {
  requireCandidate(user);
  const client = await db().connect();
  try {
    const cand = await ownCandidateId(client, user.id);
    const list = (
      await client.query(
        `SELECT i.id, i.number, i.status, i.currency, i.total_amount::text AS total, i.remaining_amount::text AS remaining,
                to_char(i.due_date, 'YYYY-MM-DD') AS due_date, to_char(COALESCE(i.issued_at AT TIME ZONE 'UTC', i.created_at), 'YYYY-MM-DD') AS issued_at
           FROM invoices i WHERE i.candidate_id = $1 AND i.is_deleted = false AND i.status <> 'Draft' ORDER BY i.id DESC LIMIT ${MAX_INVOICES}`,
        [cand]
      )
    ).rows;
    const ids = list.map((i) => i.id);
    const items = ids.length
      ? (
          await client.query(
            `SELECT invoice_id, description, quantity::text AS quantity, unit_price::text AS unit_price, line_total::text AS line_total
               FROM invoice_items WHERE invoice_id = ANY($1::int[]) ORDER BY invoice_id, position, id`,
            [ids]
          )
        ).rows
      : [];
    const pays = ids.length
      ? (
          await client.query(
            `SELECT invoice_id, receipt_number, amount_paid::text AS amount, payment_method AS method, to_char(payment_date, 'YYYY-MM-DD') AS payment_date,
                    (voided_at IS NOT NULL) AS voided
               FROM payments WHERE invoice_id = ANY($1::int[]) AND is_deleted = false ORDER BY id`,
            [ids]
          )
        ).rows
      : [];
    const group = (rows, id, pick) => rows.filter((r) => r.invoice_id === id).map(pick);
    const out = list.map((i) => ({
      ...i,
      items: group(items, i.id, (r) => ({ description: r.description, quantity: r.quantity, unit_price: r.unit_price, line_total: r.line_total })),
      payments: group(pays, i.id, (r) => ({ receipt_number: r.receipt_number, amount: r.amount, method: r.method, payment_date: r.payment_date, voided: r.voided })),
    }));
    const totals = (
      await client.query(
        `WITH v AS (SELECT * FROM invoices i WHERE i.candidate_id = $1 AND i.is_deleted = false AND i.voided_at IS NULL AND i.status NOT IN ('Void','Draft')),
              inv AS (SELECT currency, SUM(total_amount) AS invoiced, SUM(remaining_amount) AS remaining FROM v GROUP BY currency),
              pay AS (SELECT v.currency, SUM(p.amount_paid) AS paid FROM payments p JOIN v ON v.id = p.invoice_id WHERE p.is_deleted = false AND p.voided_at IS NULL GROUP BY v.currency),
              ref AS (SELECT v.currency, SUM(f.amount) AS refunded FROM fin_refunds f JOIN payments p ON p.id = f.payment_id JOIN v ON v.id = f.invoice_id
                       WHERE p.is_deleted = false AND p.voided_at IS NULL GROUP BY v.currency)
         SELECT inv.currency, inv.invoiced::numeric(16,2)::text AS invoiced, COALESCE(pay.paid, 0)::numeric(16,2)::text AS paid,
                COALESCE(ref.refunded, 0)::numeric(16,2)::text AS refunded, inv.remaining::numeric(16,2)::text AS remaining
           FROM inv LEFT JOIN pay ON pay.currency = inv.currency LEFT JOIN ref ON ref.currency = inv.currency ORDER BY inv.currency`,
        [cand]
      )
    ).rows;
    return { invoices: out, totals };
  } finally {
    client.release();
  }
}

/** The caller's own invoice as the staff print page, minus staff notes and void reason. */
async function printMyInvoice(user, rawId, { lang = "en" } = {}) {
  requireCandidate(user);
  if (typeof lang !== "string" || !invoices.LANGS.includes(lang)) throw new HttpError(400, `lang must be one of ${invoices.LANGS.join(", ")}`);
  const id = c.parseId(rawId, { notFound: notFound().message });
  const client = await db().connect();
  try {
    const cand = await ownCandidateId(client, user.id);
    const inv = await invoices.loadFull(client, id);
    if (!inv || String(inv.candidate_id) !== String(cand) || inv.status === "Draft") throw notFound();
    const full = await invoices.details(client, inv);
    return invoices.renderInvoiceHtml({ ...full, notes: null, void_reason: null, payments: [], refunds: [] }, lang);
  } finally {
    client.release();
  }
}

module.exports = { me, printMyInvoice };
