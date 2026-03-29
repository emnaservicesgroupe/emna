const express = require("express");
const db = require("../db");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");
const { logAudit } = require("../utils/audit");
const { validatePaymentAmount } = require("../utils/finance");

const router = express.Router();

router.get("/dashboard", verifyToken, checkPermission("finance:read"), async (_req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COALESCE((SELECT SUM(amount_paid) FROM payments WHERE is_deleted=false), 0) AS total_in,
        COALESCE((SELECT SUM(amount) FROM expenses WHERE is_deleted=false), 0) AS total_out,
        COALESCE((SELECT SUM(total_amount) FROM invoices WHERE is_deleted=false), 0) AS total_invoiced,
        COALESCE((SELECT SUM(remaining_amount) FROM invoices WHERE is_deleted=false), 0) AS total_remaining
    `);
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/invoices", verifyToken, checkPermission("finance:write"), async (req, res) => {
  const { candidate_id, total_amount, currency = "TND", due_date = null, notes = null } = req.body;
  if (!candidate_id || !total_amount) return res.status(400).json({ error: "candidate_id and total_amount are required" });

  try {
    const result = await db.query(
      `INSERT INTO invoices (candidate_id, total_amount, remaining_amount, currency, due_date, status, notes, created_by)
       VALUES ($1, $2, $2, $3, $4, 'Pending', $5, $6)
       RETURNING *`,
      [candidate_id, total_amount, currency, due_date, notes, req.user.id]
    );

    await logAudit({ userId: req.user.id, action: "CREATE", tableName: "invoices", recordId: result.rows[0].id, newData: result.rows[0] });
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/payments", verifyToken, checkPermission("finance:write"), async (req, res) => {
  const { invoice_id, amount_paid, payment_method = "cash", payment_date = null, notes = null } = req.body;
  if (!invoice_id || !amount_paid) return res.status(400).json({ error: "invoice_id and amount_paid are required" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const invoiceResult = await client.query("SELECT * FROM invoices WHERE id=$1 AND is_deleted=false FOR UPDATE", [invoice_id]);
    if (!invoiceResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Invoice not found" });
    }

    const invoice = invoiceResult.rows[0];
    const paymentValidation = validatePaymentAmount({
      amountPaid: amount_paid,
      remainingAmount: invoice.remaining_amount,
    });

    if (!paymentValidation.ok) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: paymentValidation.error });
    }

    const remaining = paymentValidation.remaining;
    const status = paymentValidation.status;

    const paymentResult = await client.query(
      `INSERT INTO payments (invoice_id, candidate_id, amount_paid, payment_method, payment_date, notes, created_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6, $7)
       RETURNING *`,
      [invoice.id, invoice.candidate_id, amount_paid, payment_method, payment_date, notes, req.user.id]
    );

    const updatedInvoice = await client.query(
      `UPDATE invoices
       SET remaining_amount=$1, status=$2, updated_at=NOW()
       WHERE id=$3
       RETURNING *`,
      [remaining, status, invoice.id]
    );

    await client.query("COMMIT");

    await logAudit({ userId: req.user.id, action: "CREATE", tableName: "payments", recordId: paymentResult.rows[0].id, newData: paymentResult.rows[0] });
    await logAudit({ userId: req.user.id, action: "UPDATE", tableName: "invoices", recordId: invoice.id, oldData: invoice, newData: updatedInvoice.rows[0] });

    return res.status(201).json({ payment: paymentResult.rows[0], invoice: updatedInvoice.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
