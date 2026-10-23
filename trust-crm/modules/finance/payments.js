// Payments, receipts, voids and refunds. All money maths runs in SQL on NUMERIC; amounts are decimal strings.
// Every mutation is ONE transaction: invoice row lock -> rows -> fin_ledger entry -> audit_logs (logAudit with the tx client).
//
// Lock order is always invoice first, then payment (so payment/void/refund on one invoice serialise without deadlock).
// Ledger postings: payment = credit, void of a payment = debit (reversal), refund = debit.
//
// Refund rule (documented in docs/vita-accounting/CHECKLIST.md): a refund returns money to the candidate and does NOT
// reopen the debt unless `reopen: true` is passed. By default invoices.remaining_amount is unchanged; the invoice becomes
// 'Refunded' only when everything paid on it has been refunded, nothing is owed (remaining = 0) and reopen was not used.
// With reopen the remaining balance grows by the refund and the status follows it (Pending / Partial).
const { logAudit } = require("../../utils/audit");
const { parseMoney, formatMoney } = require("./money");
const c = require("./common");
const invoices = require("./invoices");

const { HttpError } = c;
const db = () => require("../../db");

const METHODS = ["cash", "bank_transfer", "card", "mobile", "cheque", "other"];
const REF_MAX = 120;
const NOTES_MAX = 500;
const KEY_MAX = 100;
const REASON_MAX = 500;
const PG_INT_MAX = 2147483647;

const PAYMENT_SELECT = `SELECT p.id, p.invoice_id, p.candidate_id, p.amount_paid::text AS amount_paid, p.payment_method,
       to_char(p.payment_date, 'YYYY-MM-DD') AS payment_date, p.receipt_number, p.reference, p.notes, p.created_by, p.created_at,
       p.voided_at, p.void_reason, r.refunded::text AS refunded, (p.amount_paid - r.refunded)::text AS net_amount,
       i.number AS invoice_number, i.currency, c.full_name AS candidate_name
  FROM payments p
  JOIN invoices i ON i.id = p.invoice_id
  JOIN candidates c ON c.id = p.candidate_id
  CROSS JOIN LATERAL (SELECT COALESCE(SUM(f.amount), 0)::numeric(14,2) AS refunded FROM fin_refunds f WHERE f.payment_id = p.id) r`;

const invoiceId = (raw) => {
  const id = c.parseId(raw);
  if (id > PG_INT_MAX) throw new HttpError(404, "Invoice not found");
  return id;
};
const paymentId = (raw) => {
  const id = c.parseId(raw);
  if (id > PG_INT_MAX) throw new HttpError(404, "Payment not found");
  return id;
};

function normalizeMethod(v, label = "payment_method") {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (!METHODS.includes(s)) throw new HttpError(400, `${label} must be one of ${METHODS.join(", ")}`);
  return s;
}

async function loadPayment(client, id) {
  return (await client.query(`${PAYMENT_SELECT} WHERE p.id = $1 AND p.is_deleted = false`, [id])).rows[0] || null;
}

async function invoiceView(client, id) {
  return invoices.details(client, await invoices.loadFull(client, id));
}

// ------------------------------------------------------------------------------------------------ create
function parseCreate(input) {
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  for (const k of Object.keys(input)) if (!["invoice_id", "amount", "method", "payment_date", "reference", "notes", "idempotency_key"].includes(k)) throw new HttpError(400, `Unknown field: ${k}`);
  const key = c.cleanText(input.idempotency_key, "idempotency_key", KEY_MAX);
  return {
    invoiceId: invoiceId(input.invoice_id),
    amount: parseMoney(input.amount, { label: "amount", positive: true, maxIntDigits: 10 }),
    method: normalizeMethodStrict(input.method),
    paymentDate: input.payment_date === undefined || input.payment_date === null ? null : c.parseDate(input.payment_date, "payment_date"),
    reference: c.cleanText(input.reference, "reference", REF_MAX),
    notes: c.cleanText(input.notes, "notes", NOTES_MAX),
    key,
  };
}

function normalizeMethodStrict(v) {
  if (typeof v !== "string" || !METHODS.includes(v)) throw new HttpError(400, `method must be one of ${METHODS.join(", ")}`);
  return v;
}

/**
 * Rejects payments the invoice cannot take. `legacy` keeps the old POST /finance/payments semantics (a settled invoice
 * is an overpayment, 400); the v2 API answers 409 for settled invoices and 400 with the remaining balance for overpayment.
 */
async function assertPayable(client, inv, amount, { legacy = false } = {}) {
  if (inv.status === "Void" || inv.voided_at) throw new HttpError(409, "Invoice is void");
  const cmp = (await client.query("SELECT $1::numeric > $2::numeric AS over, $2::numeric = 0 AS settled, $2::numeric(14,2)::text AS remaining", [amount, inv.remaining_amount])).rows[0];
  if (!legacy) {
    if (inv.status === "Draft") throw new HttpError(409, "Invoice is a draft and cannot receive payments");
    if (inv.status === "Paid" || inv.status === "Refunded" || cmp.settled) throw new HttpError(409, `Invoice is already settled (${inv.status})`);
  }
  if (cmp.over) {
    throw new HttpError(400, legacy ? "amount_paid cannot exceed remaining invoice balance" : `amount exceeds the remaining balance (remaining: ${cmp.remaining})`);
  }
}

/**
 * Inserts the payment, lowers the invoice's remaining balance and derives its status in SQL, takes the next receipt
 * number, writes the ledger credit and the audit rows. The caller holds the invoice row lock (FOR UPDATE) and has
 * already run assertPayable.
 * @returns {{payment: object, invoice: object}} raw rows (RETURNING *)
 */
async function postPayment(client, user, inv, p) {
  const { number } = await c.nextNumber(client, "REC", "receipt");
  const payment = (
    await client.query(
      `INSERT INTO payments (invoice_id, candidate_id, amount_paid, payment_method, payment_date, notes, created_by, receipt_number, reference, idempotency_key)
       VALUES ($1, $2, $3::numeric, $4, COALESCE($5::date, CURRENT_DATE), $6, $7, $8, $9, $10) RETURNING *`,
      [inv.id, inv.candidate_id, p.amount, p.method, p.paymentDate || null, p.notes || null, user.id, number, p.reference || null, p.key || null]
    )
  ).rows[0];
  const invoice = (
    await client.query(
      `UPDATE invoices SET remaining_amount = remaining_amount - $2::numeric,
              status = CASE WHEN remaining_amount - $2::numeric = 0 THEN 'Paid' ELSE 'Partial' END, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [inv.id, p.amount]
    )
  ).rows[0];
  await client.query(
    "INSERT INTO fin_ledger (kind, ref_table, ref_id, candidate_id, currency, debit, credit, actor_id) VALUES ('payment','payments',$1,$2,$3,0,$4::numeric,$5)",
    [payment.id, inv.candidate_id, invoice.currency, p.amount, user.id]
  );
  await logAudit({ client, userId: user.id, action: "CREATE", tableName: "payments", recordId: payment.id, newData: payment });
  await logAudit({
    client,
    userId: user.id,
    action: "UPDATE",
    tableName: "invoices",
    recordId: inv.id,
    oldData: { remaining_amount: inv.remaining_amount, status: inv.status },
    newData: { remaining_amount: invoice.remaining_amount, status: invoice.status },
  });
  return { payment, invoice };
}

async function replayView(client, existing) {
  return { payment: await loadPayment(client, existing.id), invoice: await invoiceView(client, existing.invoice_id), replayed: true };
}

async function findIdempotent(client, v) {
  if (!v.key) return null;
  const ex = (
    await client.query(
      "SELECT id, invoice_id, payment_method, (amount_paid = $3::numeric) AS same_amount FROM payments WHERE invoice_id = $1 AND idempotency_key = $2 AND is_deleted = false",
      [v.invoiceId, v.key, v.amount]
    )
  ).rows[0];
  if (!ex) return null;
  if (!ex.same_amount || ex.payment_method !== v.method) throw new HttpError(409, "idempotency_key was already used with a different amount or method");
  return ex;
}

/**
 * Records a payment against an invoice (finance:write). Same idempotency_key on the same invoice returns the original
 * payment with replayed:true instead of posting again.
 * @returns {{payment: object, invoice: object, replayed: boolean}}
 */
async function createPayment(user, input) {
  c.requirePerm(user, "finance:write");
  const v = parseCreate(input);
  try {
    return await c.inTransaction(async (client) => {
      const inv = await invoices.loadFull(client, v.invoiceId, { lock: true });
      if (!inv) throw new HttpError(404, "Invoice not found");
      const ex = await findIdempotent(client, v);
      if (ex) return replayView(client, ex);
      if (v.paymentDate) {
        const d = (
          await client.query(
            `SELECT $1::date > (now() AT TIME ZONE 'UTC')::date + 1 AS future,
                    $1::date < ((COALESCE(i.issued_at AT TIME ZONE 'UTC', i.created_at))::date - interval '1 year') AS too_old
               FROM invoices i WHERE i.id = $2`,
            [v.paymentDate, inv.id]
          )
        ).rows[0];
        if (d.future) throw new HttpError(400, "payment_date cannot be in the future");
        if (d.too_old) throw new HttpError(400, "payment_date is more than a year before the invoice was issued");
      }
      await assertPayable(client, inv, v.amount);
      const res = await postPayment(client, user, inv, v);
      return { payment: await loadPayment(client, res.payment.id), invoice: await invoiceView(client, inv.id), replayed: false };
    });
  } catch (err) {
    // Two requests with the same key can only collide on the unique index if the invoice lock was bypassed; handle it anyway.
    if (err && err.code === "23505" && v.key && /idem/.test(String(err.constraint || ""))) {
      return c.inTransaction(async (client) => {
        const ex = await findIdempotent(client, v);
        if (!ex) throw err;
        return replayView(client, ex);
      });
    }
    throw err;
  }
}

// ------------------------------------------------------------------------------------------------ void
async function lockPaymentAndInvoice(client, id) {
  const pre = (await client.query("SELECT invoice_id FROM payments WHERE id = $1 AND is_deleted = false", [id])).rows[0];
  if (!pre) throw new HttpError(404, "Payment not found");
  const inv = await invoices.loadFull(client, pre.invoice_id, { lock: true });
  if (!inv) throw new HttpError(404, "Payment not found");
  const pay = (await client.query("SELECT * FROM payments WHERE id = $1 AND is_deleted = false FOR UPDATE", [id])).rows[0];
  if (!pay) throw new HttpError(404, "Payment not found");
  return { inv, pay };
}

function reasonOnly(input) {
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  for (const k of Object.keys(input)) if (k !== "reason") throw new HttpError(400, `Unknown field: ${k}`);
  return c.requiredText(input.reason, "reason", REASON_MAX);
}

/** Voids a payment (finance:void): restores the invoice balance/status, posts a reversing ledger debit. */
async function voidPayment(user, rawId, input) {
  c.requirePerm(user, "finance:void");
  const id = paymentId(rawId);
  const reason = reasonOnly(input);
  return c.inTransaction(async (client) => {
    const { inv, pay } = await lockPaymentAndInvoice(client, id);
    if (pay.voided_at) throw new HttpError(409, "Payment is already void");
    const refunds = Number((await client.query("SELECT count(*) AS n FROM fin_refunds WHERE payment_id = $1", [id])).rows[0].n);
    if (refunds > 0) throw new HttpError(409, "Payment has refunds and cannot be voided");
    if (inv.status === "Void") throw new HttpError(409, "Invoice is void");
    await client.query("UPDATE payments SET voided_at = now(), void_reason = $2 WHERE id = $1", [id, reason]);
    await client.query(
      `UPDATE invoices SET remaining_amount = remaining_amount + $2::numeric,
              status = CASE WHEN remaining_amount + $2::numeric >= total_amount THEN 'Pending' ELSE 'Partial' END, updated_at = now()
        WHERE id = $1`,
      [inv.id, pay.amount_paid]
    );
    await client.query(
      "INSERT INTO fin_ledger (kind, ref_table, ref_id, candidate_id, currency, debit, credit, actor_id) VALUES ('void','payments',$1,$2,$3,$4::numeric,0,$5)",
      [id, pay.candidate_id, inv.currency, pay.amount_paid, user.id]
    );
    const next = await loadPayment(client, id);
    const after = await invoices.loadFull(client, inv.id);
    await logAudit({ client, userId: user.id, action: "VOID", tableName: "payments", recordId: id, oldData: pay, newData: next });
    await logAudit({
      client,
      userId: user.id,
      action: "UPDATE",
      tableName: "invoices",
      recordId: inv.id,
      oldData: { remaining_amount: inv.remaining_amount, status: inv.status },
      newData: { remaining_amount: after.remaining_amount, status: after.status },
    });
    return { payment: next, invoice: await invoices.details(client, after) };
  });
}

// ------------------------------------------------------------------------------------------------ refund
/**
 * Refunds part or all of a payment (finance:refund). amount <= payment net of earlier refunds (also enforced by the
 * fin_refunds trigger). Without reopen the invoice balance is unchanged; see the header comment for the status rule.
 */
async function refundPayment(user, rawId, input) {
  c.requirePerm(user, "finance:refund");
  const id = paymentId(rawId);
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  for (const k of Object.keys(input)) if (!["amount", "reason", "reopen"].includes(k)) throw new HttpError(400, `Unknown field: ${k}`);
  const amount = parseMoney(input.amount, { label: "amount", positive: true, maxIntDigits: 10 });
  const reason = c.requiredText(input.reason, "reason", REASON_MAX);
  if (input.reopen !== undefined && typeof input.reopen !== "boolean") throw new HttpError(400, "reopen must be true or false");
  const reopen = input.reopen === true;

  return c.inTransaction(async (client) => {
    const { inv, pay } = await lockPaymentAndInvoice(client, id);
    if (pay.voided_at) throw new HttpError(409, "Payment is void and cannot be refunded");
    if (inv.status === "Void") throw new HttpError(409, "Invoice is void");
    const b = (
      await client.query(
        `SELECT $2::numeric > net AS over, net::numeric(14,2)::text AS refundable
           FROM (SELECT $1::numeric - COALESCE((SELECT SUM(amount) FROM fin_refunds WHERE payment_id = $3), 0) AS net) x`,
        [pay.amount_paid, amount, id]
      )
    ).rows[0];
    if (b.over) throw new HttpError(400, `refund exceeds the refundable amount (refundable: ${b.refundable})`);
    const refund = (
      await client.query(
        "INSERT INTO fin_refunds (payment_id, invoice_id, amount, reason, created_by) VALUES ($1, $2, $3::numeric, $4, $5) RETURNING id, payment_id, invoice_id, amount::text AS amount, reason, created_by, created_at",
        [id, inv.id, amount, reason, user.id]
      )
    ).rows[0];

    if (reopen) {
      const upd = await client.query(
        `UPDATE invoices SET remaining_amount = remaining_amount + $2::numeric,
                status = CASE WHEN remaining_amount + $2::numeric >= total_amount THEN 'Pending' WHEN remaining_amount + $2::numeric = 0 THEN 'Paid' ELSE 'Partial' END,
                updated_at = now()
          WHERE id = $1 AND remaining_amount + $2::numeric <= total_amount RETURNING id`,
        [inv.id, amount]
      );
      if (!upd.rows.length) throw new HttpError(409, "Reopening would exceed the invoice total");
    } else {
      await client.query(
        `UPDATE invoices SET updated_at = now(),
                status = CASE WHEN remaining_amount = 0
                               AND COALESCE((SELECT SUM(f.amount) FROM fin_refunds f JOIN payments pp ON pp.id = f.payment_id
                                              WHERE f.invoice_id = $1 AND pp.voided_at IS NULL AND pp.is_deleted = false), 0)
                                 = COALESCE((SELECT SUM(amount_paid) FROM payments WHERE invoice_id = $1 AND voided_at IS NULL AND is_deleted = false), 0)
                              THEN 'Refunded' ELSE status END
          WHERE id = $1`,
        [inv.id]
      );
    }
    await client.query(
      "INSERT INTO fin_ledger (kind, ref_table, ref_id, candidate_id, currency, debit, credit, actor_id) VALUES ('refund','fin_refunds',$1,$2,$3,$4::numeric,0,$5)",
      [refund.id, pay.candidate_id, inv.currency, amount, user.id]
    );
    const after = await invoices.loadFull(client, inv.id);
    await logAudit({ client, userId: user.id, action: "CREATE", tableName: "fin_refunds", recordId: refund.id, newData: { ...refund, reopen } });
    await logAudit({
      client,
      userId: user.id,
      action: "UPDATE",
      tableName: "invoices",
      recordId: inv.id,
      oldData: { remaining_amount: inv.remaining_amount, status: inv.status },
      newData: { remaining_amount: after.remaining_amount, status: after.status, reopen },
    });
    return { refund: { ...refund, reopen }, payment: await loadPayment(client, id), invoice: await invoices.details(client, after) };
  });
}

// ------------------------------------------------------------------------------------------------ list
async function listPayments(user, query = {}) {
  c.requirePerm(user, "finance:read");
  const where = ["p.is_deleted = false"];
  const params = [];
  const add = (val) => (params.push(val), `$${params.length}`);
  const one = (k) => {
    const v = c.oneValue(query[k], k);
    return v === undefined || v === "" ? undefined : v;
  };
  const inv = one("invoice_id");
  if (inv !== undefined) where.push(`p.invoice_id = ${add(invoiceId(inv))}`);
  const cand = one("candidate_id");
  if (cand !== undefined) where.push(`p.candidate_id = ${add(c.parseId(cand))}`);
  const method = one("method");
  if (method !== undefined) where.push(`p.payment_method = ${add(normalizeMethodStrict(method))}`);
  const from = one("from");
  if (from !== undefined) where.push(`p.payment_date >= ${add(c.parseDate(from, "from"))}::date`);
  const to = one("to");
  if (to !== undefined) where.push(`p.payment_date <= ${add(c.parseDate(to, "to"))}::date`);
  const incl = one("include_voided");
  if (incl !== undefined && !["true", "false", "1", "0"].includes(incl)) throw new HttpError(400, "include_voided must be true or false");
  if (!(incl === "true" || incl === "1")) where.push("p.voided_at IS NULL");
  const { limit, offset } = c.pageParams(query);
  const w = where.join(" AND ");
  const total = Number((await db().query(`SELECT count(*) AS n FROM payments p WHERE ${w}`, params)).rows[0].n);
  const rows = (await db().query(`${PAYMENT_SELECT} WHERE ${w} ORDER BY p.id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`, params)).rows;
  return { rows, total };
}

// ------------------------------------------------------------------------------------------------ receipt
const { esc } = invoices;

const RLABELS = {
  en: { receipt: "Receipt", number: "Receipt no.", date: "Payment date", invoice: "Invoice", received_from: "Received from", method: "Method", reference: "Reference", amount: "Amount received", notes: "Notes", inv_total: "Invoice total", balance: "Balance due on invoice", refunds: "Refunds", net: "Net amount kept", reason: "Reason", void: "VOID", void_reason: "Reason", tax_id: "Tax ID", legacy: "(no number)",
    methods: { cash: "Cash", bank_transfer: "Bank transfer", card: "Card", mobile: "Mobile payment", cheque: "Cheque", other: "Other" } },
  fr: { receipt: "Reçu", number: "N° de reçu", date: "Date de paiement", invoice: "Facture", received_from: "Reçu de", method: "Mode", reference: "Référence", amount: "Montant reçu", notes: "Notes", inv_total: "Total facture", balance: "Solde restant dû", refunds: "Remboursements", net: "Montant net conservé", reason: "Motif", void: "ANNULÉ", void_reason: "Motif", tax_id: "N° fiscal", legacy: "(sans numéro)",
    methods: { cash: "Espèces", bank_transfer: "Virement", card: "Carte", mobile: "Paiement mobile", cheque: "Chèque", other: "Autre" } },
  ar: { receipt: "إيصال", number: "رقم الإيصال", date: "تاريخ الدفع", invoice: "الفاتورة", received_from: "استلمنا من", method: "الطريقة", reference: "المرجع", amount: "المبلغ المستلم", notes: "ملاحظات", inv_total: "إجمالي الفاتورة", balance: "الرصيد المتبقي", refunds: "المبالغ المستردة", net: "الصافي المحتفظ به", reason: "السبب", void: "ملغى", void_reason: "السبب", tax_id: "المعرف الجبائي", legacy: "(بدون رقم)",
    methods: { cash: "نقدا", bank_transfer: "تحويل بنكي", card: "بطاقة", mobile: "دفع عبر الهاتف", cheque: "شيك", other: "أخرى" } },
};
const LANGS = Object.keys(RLABELS);

function renderReceiptHtml(p, refunds, lang) {
  const L = RLABELS[lang];
  const co = invoices.companyHeader();
  const isVoid = Boolean(p.voided_at);
  const money = (v) => esc(formatMoney(v, p.currency));
  const dt = (v) => esc(v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : "");
  const number = p.receipt_number || L.legacy;
  const header = [co.name && `<div class="co-name">${esc(co.name)}</div>`, co.address && `<div class="co-address">${esc(co.address)}</div>`, co.taxId && `<div class="co-tax">${esc(L.tax_id)}: ${esc(co.taxId)}</div>`].filter(Boolean).join("");
  const hasRefunds = refunds.length > 0;
  const refundRows = refunds.map((r) => `<tr><td>${dt(r.created_at)}</td><td>${esc(r.reason)}</td><td class="num">${money(r.amount)}</td></tr>`).join("");
  return `<!doctype html>
<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(L.receipt)} ${esc(number)}</title>
<link rel="stylesheet" href="/vita/fin-print.css">
</head>
<body class="fin-doc">
<main class="fin-sheet">
${isVoid ? `<div class="watermark" aria-hidden="true">${esc(L.void)}</div>` : ""}
<header class="fin-head">${header ? `<div class="fin-company">${header}</div>` : ""}<h1>${esc(L.receipt)} ${esc(number)}</h1></header>
<section class="fin-meta">
<dl>
<dt>${esc(L.number)}</dt><dd>${esc(number)}</dd>
<dt>${esc(L.date)}</dt><dd>${dt(p.payment_date)}</dd>
<dt>${esc(L.received_from)}</dt><dd>${esc(p.candidate_name)}</dd>
<dt>${esc(L.invoice)}</dt><dd>${esc(p.invoice_number || `#${p.invoice_id}`)}</dd>
<dt>${esc(L.method)}</dt><dd>${esc(L.methods[p.payment_method] || p.payment_method)}</dd>
${p.reference ? `<dt>${esc(L.reference)}</dt><dd>${esc(p.reference)}</dd>` : ""}
</dl>
</section>
<table class="fin-totals"><tbody>
<tr class="grand"><th>${esc(L.amount)}</th><td class="num">${money(p.amount_paid)}</td></tr>
${hasRefunds ? `<tr><th>${esc(L.refunds)}</th><td class="num">${money(p.refunded)}</td></tr><tr><th>${esc(L.net)}</th><td class="num">${money(p.net_amount)}</td></tr>` : ""}
<tr><th>${esc(L.inv_total)}</th><td class="num">${money(p.invoice_total)}</td></tr>
<tr><th>${esc(L.balance)}</th><td class="num">${money(p.invoice_remaining)}</td></tr>
</tbody></table>
${hasRefunds ? `<section class="fin-items-wrap"><h2>${esc(L.refunds)}</h2><table class="fin-items"><tbody>${refundRows}</tbody></table></section>` : ""}
${p.notes ? `<section class="fin-notes"><h2>${esc(L.notes)}</h2><p>${esc(p.notes)}</p></section>` : ""}
${isVoid ? `<section class="fin-void"><strong>${esc(L.void)}</strong> - ${esc(L.void_reason)}: ${esc(p.void_reason)}</section>` : ""}
</main>
</body>
</html>
`;
}

async function receiptHtml(user, rawId, { lang = "en" } = {}) {
  c.requirePerm(user, "finance:read");
  if (typeof lang !== "string" || !LANGS.includes(lang)) throw new HttpError(400, `lang must be one of ${LANGS.join(", ")}`);
  const id = paymentId(rawId);
  const client = await db().connect();
  try {
    const p = (
      await client.query(
        `SELECT s.*, i.total_amount::text AS invoice_total, i.remaining_amount::text AS invoice_remaining
           FROM (${PAYMENT_SELECT} WHERE p.id = $1 AND p.is_deleted = false) s JOIN invoices i ON i.id = s.invoice_id`,
        [id]
      )
    ).rows[0];
    if (!p) throw new HttpError(404, "Payment not found");
    const refunds = (await client.query("SELECT amount::text AS amount, reason, created_at FROM fin_refunds WHERE payment_id = $1 ORDER BY id", [id])).rows;
    return renderReceiptHtml(p, refunds, lang);
  } finally {
    client.release();
  }
}

module.exports = { createPayment, voidPayment, refundPayment, listPayments, receiptHtml, renderReceiptHtml, postPayment, assertPayable, normalizeMethod, METHODS, LANGS };
