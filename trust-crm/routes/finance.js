// Legacy finance routes (kept for compatibility; response shapes unchanged). Hardened for stage 4: inputs are validated
// (400 instead of a database 500), money is handled as decimal strings and compared in SQL NUMERIC, and each write runs in
// one transaction that also assigns the invoice/receipt number and writes the fin_ledger row and the audit row.
const express = require("express");
const db = require("../db");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");
const { logAudit } = require("../utils/audit");
const { parseMoney } = require("../modules/finance/money");
const common = require("../modules/finance/common");
const payments = require("../modules/finance/payments");

const router = express.Router();
const PG_INT_MAX = 2147483647;
const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

function fail(res, err) {
  if (err instanceof common.HttpError) return res.status(err.status).json({ error: err.message });
  return res.status(500).json({ error: err.message });
}

/** Legacy currency input: trimmed and upper-cased, then it must be exactly three letters. */
function normalizeCurrency(v) {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(s)) throw new common.HttpError(400, "currency must be a 3-letter code (e.g. TND)");
  return s;
}

router.get("/dashboard", verifyToken, checkPermission("finance:read"), async (_req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COALESCE((SELECT SUM(amount_paid) FROM payments WHERE is_deleted=false AND voided_at IS NULL), 0) AS total_in,
        COALESCE((SELECT SUM(amount) FROM expenses WHERE is_deleted=false), 0) AS total_out,
        COALESCE((SELECT SUM(total_amount) FROM invoices WHERE is_deleted=false AND voided_at IS NULL), 0) AS total_invoiced,
        COALESCE((SELECT SUM(remaining_amount) FROM invoices WHERE is_deleted=false AND voided_at IS NULL), 0) AS total_remaining
    `);
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/invoices", verifyToken, checkPermission("finance:write"), async (req, res) => {
  const { candidate_id, total_amount, currency = "TND", due_date = null, notes = null } = bodyOf(req);
  if (!candidate_id || !total_amount) return res.status(400).json({ error: "candidate_id and total_amount are required" });

  try {
    const candidateId = common.parseId(candidate_id);
    if (candidateId > PG_INT_MAX) throw new common.HttpError(404, "Candidate not found");
    const total = parseMoney(total_amount, { label: "total_amount", positive: true, maxIntDigits: 10 });
    const cur = normalizeCurrency(currency);
    const due = due_date === null ? null : common.parseDate(due_date, "due_date");
    const note = common.cleanText(notes, "notes", 2000);

    const row = await common.inTransaction(async (client) => {
      const cand = (await client.query("SELECT id FROM candidates WHERE id = $1 AND is_deleted = false FOR SHARE", [candidateId])).rows[0];
      if (!cand) throw new common.HttpError(404, "Candidate not found");
      const { number, ts } = await common.nextNumber(client, "VITA", "invoice");
      const inv = (
        await client.query(
          `INSERT INTO invoices (candidate_id, total_amount, remaining_amount, currency, due_date, status, notes, created_by, number, issued_at, subtotal, tax_amount)
           VALUES ($1, $2::numeric, $2::numeric, $3, $4, 'Pending', $5, $6, $7, $8, $2::numeric, 0)
           RETURNING *`,
          [candidateId, total, cur, due, note, req.user.id, number, ts]
        )
      ).rows[0];
      await client.query(
        "INSERT INTO fin_ledger (kind, ref_table, ref_id, candidate_id, currency, debit, credit, actor_id) VALUES ('invoice','invoices',$1,$2,$3,$4::numeric,0,$5)",
        [inv.id, candidateId, cur, total, req.user.id]
      );
      await logAudit({ client, userId: req.user.id, action: "CREATE", tableName: "invoices", recordId: inv.id, newData: inv });
      return inv;
    });
    return res.status(201).json(row);
  } catch (err) {
    return fail(res, err);
  }
});

router.post("/payments", verifyToken, checkPermission("finance:write"), async (req, res) => {
  const { invoice_id, amount_paid, payment_method = "cash", payment_date = null, notes = null } = bodyOf(req);
  if (!invoice_id || !amount_paid) return res.status(400).json({ error: "invoice_id and amount_paid are required" });

  try {
    const invoiceId = common.parseId(invoice_id);
    if (invoiceId > PG_INT_MAX) throw new common.HttpError(404, "Invoice not found");
    // Decimal string end to end: "amount_paid must be greater than zero" is parseMoney's own message for 0.
    const amount = parseMoney(amount_paid, { label: "amount_paid", positive: true, maxIntDigits: 10 });
    const method = payments.normalizeMethod(payment_method);
    const date = payment_date === null ? null : common.parseDate(payment_date, "payment_date");
    const note = common.cleanText(notes, "notes", 2000);

    const out = await common.inTransaction(async (client) => {
      const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 AND is_deleted = false FOR UPDATE", [invoiceId])).rows[0];
      if (!inv) throw new common.HttpError(404, "Invoice not found");
      await payments.assertPayable(client, inv, amount, { legacy: true });
      return payments.postPayment(client, req.user, inv, { amount, method, paymentDate: date, notes: note, reference: null, key: null });
    });
    return res.status(201).json({ payment: out.payment, invoice: out.invoice });
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
