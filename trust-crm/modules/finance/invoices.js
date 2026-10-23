// Numbered invoices with line items. All money maths runs in SQL on NUMERIC; amounts are exchanged as decimal strings.
// Every mutation is ONE transaction: invoice rows + fin_ledger entry + audit_logs row (logAudit with the tx client).
// Numbers are VITA-YYYY-NNNNNN, drawn from fin_counters under a row lock (key 'invoice-YYYY', year from the DB clock, UTC).
const { logAudit } = require("../../utils/audit");
const { parseMoney, parseQuantity, formatMoney } = require("./money");
const c = require("./common");

const { HttpError } = c;
const db = () => require("../../db");

const STATUSES = ["Draft", "Pending", "Partial", "Paid", "Void", "Refunded"];
const MAX_ITEMS = 50;
const DESC_MAX = 300;
const NOTES_MAX = 2000;
const REASON_MAX = 500;
const MAX_COLUMN = "9999999999.99"; // numeric(12,2)

const INVOICE_COLS = `i.id, i.number, i.candidate_id, c.full_name AS candidate_name, i.currency, i.subtotal::text AS subtotal,
  i.tax_amount::text AS tax_amount, i.total_amount::text AS total_amount, i.remaining_amount::text AS remaining_amount, i.status,
  to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.notes, i.created_by, i.created_at, i.updated_at, i.issued_at, i.voided_at, i.void_reason`;

/** FIN_TAX_RATE_PERCENT: a plain decimal in (0, 100] applies; unset/0/garbage means no tax. Read at call time. */
function taxRatePercent() {
  const raw = String(process.env.FIN_TAX_RATE_PERCENT || "").trim();
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(raw)) return "0";
  const n = Number(raw);
  return n > 0 && n <= 100 ? raw : "0";
}

function validateCreate(input) {
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  for (const k of Object.keys(input)) if (!["candidate_id", "currency", "due_date", "notes", "items"].includes(k)) throw new HttpError(400, `Unknown field: ${k}`);
  const candidateId = c.parseId(input.candidate_id === undefined || input.candidate_id === null ? "" : typeof input.candidate_id === "number" ? String(input.candidate_id) : input.candidate_id);
  const currency = c.parseCurrency(input.currency);
  const dueDate = input.due_date === undefined || input.due_date === null ? null : c.parseDate(input.due_date, "due_date");
  const notes = c.cleanText(input.notes, "notes", NOTES_MAX);
  if (!Array.isArray(input.items) || input.items.length < 1) throw new HttpError(400, "items must be a non-empty array");
  if (input.items.length > MAX_ITEMS) throw new HttpError(400, `items must have at most ${MAX_ITEMS} entries`);
  const items = input.items.map((it, i) => {
    const at = `items[${i}]`;
    if (!c.isObj(it)) throw new HttpError(400, `${at} must be an object`);
    for (const k of Object.keys(it)) if (!["service_id", "description", "quantity", "unit_price"].includes(k)) throw new HttpError(400, `Unknown field: ${at}.${k}`);
    let serviceId = null;
    if (it.service_id !== undefined && it.service_id !== null) {
      serviceId = c.parseId(typeof it.service_id === "number" ? String(it.service_id) : it.service_id);
    }
    const description = c.cleanText(it.description, `${at}.description`, DESC_MAX);
    if (!description && serviceId === null) throw new HttpError(400, `${at}.description or ${at}.service_id is required`);
    if (it.quantity === undefined) throw new HttpError(400, `${at}.quantity is required`);
    return {
      serviceId,
      description,
      quantity: parseQuantity(it.quantity, { label: `${at}.quantity` }),
      unitPrice: it.unit_price === undefined || it.unit_price === null ? null : parseMoney(it.unit_price, { label: `${at}.unit_price`, maxIntDigits: 10 }),
      at,
    };
  });
  return { candidateId, currency, dueDate, notes, items };
}

async function loadFull(client, id, { lock = false } = {}) {
  const inv = (await client.query(`SELECT ${INVOICE_COLS} FROM invoices i JOIN candidates c ON c.id = i.candidate_id WHERE i.id = $1 AND i.is_deleted = false${lock ? " FOR UPDATE OF i" : ""}`, [id])).rows[0];
  return inv || null;
}

async function details(client, inv) {
  const items = (
    await client.query(
      `SELECT it.id, it.service_id, it.description, it.quantity::text AS quantity, it.unit_price::text AS unit_price, it.line_total::text AS line_total, it.position
         FROM invoice_items it WHERE it.invoice_id = $1 ORDER BY it.position, it.id`,
      [inv.id]
    )
  ).rows;
  const payments = (
    await client.query(
      `SELECT id, amount_paid::text AS amount_paid, payment_method, to_char(payment_date,'YYYY-MM-DD') AS payment_date, receipt_number, reference, notes,
              created_by, created_at, voided_at, void_reason
         FROM payments WHERE invoice_id = $1 AND is_deleted = false ORDER BY id`,
      [inv.id]
    )
  ).rows;
  const refunds = (
    await client.query("SELECT id, payment_id, amount::text AS amount, reason, created_by, created_at FROM fin_refunds WHERE invoice_id = $1 ORDER BY id", [inv.id])
  ).rows;
  const bal = (
    await client.query(
      `SELECT i.total_amount::text AS total,
              p.paid::numeric(14,2)::text AS paid, r.refunded::numeric(14,2)::text AS refunded, (p.paid - r.refunded)::numeric(14,2)::text AS net_paid, i.remaining_amount::text AS remaining
         FROM invoices i
         CROSS JOIN LATERAL (SELECT COALESCE(SUM(amount_paid),0) AS paid FROM payments WHERE invoice_id = i.id AND is_deleted = false AND voided_at IS NULL) p
         CROSS JOIN LATERAL (SELECT COALESCE(SUM(f.amount),0) AS refunded FROM fin_refunds f JOIN payments pp ON pp.id = f.payment_id
                              WHERE f.invoice_id = i.id AND pp.is_deleted = false AND pp.voided_at IS NULL) r
        WHERE i.id = $1`,
      [inv.id]
    )
  ).rows[0];
  return { ...inv, items, payments, refunds, balance: bal };
}

/**
 * Creates a Pending invoice with line items, number, ledger debit and audit row in one transaction.
 * @param {{id:number, role:string}} user
 * @param {object} input {candidate_id, currency, due_date?, notes?, items[1..50]}
 * @param {{now?: Date|string}} [opts] test hook: the DB clock stand-in used for issued_at and the number's year
 */
async function createInvoice(user, input, opts = {}) {
  c.requirePerm(user, "finance:write");
  const v = validateCreate(input);
  let nowArg = null;
  if (opts.now !== undefined) {
    const d = new Date(opts.now);
    if (Number.isNaN(d.getTime())) throw new Error("createInvoice: invalid opts.now");
    nowArg = d.toISOString();
  }
  const rate = taxRatePercent();

  return c.inTransaction(async (client) => {
    const cand = (await client.query("SELECT id FROM candidates WHERE id = $1 AND is_deleted = false FOR SHARE", [v.candidateId])).rows[0];
    if (!cand) throw new HttpError(404, "Candidate not found");

    // Resolve services and unit prices.
    const ids = [...new Set(v.items.filter((i) => i.serviceId !== null).map((i) => i.serviceId))];
    const svc = new Map();
    if (ids.length) {
      for (const s of (await client.query("SELECT id, name_ar, name_en, name_fr, default_price::text AS default_price, currency, active FROM fin_services WHERE id = ANY($1::bigint[])", [ids])).rows) svc.set(String(s.id), s);
    }
    const lines = v.items.map((it) => {
      let description = it.description;
      let unitPrice = it.unitPrice;
      if (it.serviceId !== null) {
        const s = svc.get(String(it.serviceId));
        if (!s) throw new HttpError(400, `${it.at}.service_id: service not found`);
        if (!s.active) throw new HttpError(409, `${it.at}.service_id: service is inactive`);
        if (!description) description = (s.name_en || s.name_fr || s.name_ar || "").slice(0, DESC_MAX);
        if (unitPrice === null && s.currency === v.currency) unitPrice = s.default_price;
      }
      if (unitPrice === null) throw new HttpError(400, `${it.at}.unit_price is required${it.serviceId !== null ? " (service price is in another currency)" : ""}`);
      return { serviceId: it.serviceId, description, quantity: it.quantity, unitPrice };
    });

    // Totals in SQL. Rejects totals that cannot be stored (numeric(12,2)) with a 400 instead of a database error.
    const tot = (
      await client.query(
        `SELECT s::text AS subtotal, t::text AS tax, (s + t)::text AS total, (s + t) <= ${MAX_COLUMN}::numeric AS fits
           FROM (SELECT COALESCE(SUM(round(q * p, 2)), 0) AS s FROM unnest($1::numeric[], $2::numeric[]) AS x(q, p)) a
          CROSS JOIN LATERAL (SELECT CASE WHEN $3::numeric > 0 THEN round(a.s * $3::numeric / 100, 2) ELSE 0::numeric END AS t) b`,
        [lines.map((l) => l.quantity), lines.map((l) => l.unitPrice), rate]
      )
    ).rows[0];
    if (!tot.fits) throw new HttpError(400, "Invoice total is too large");
    const positive = (await client.query("SELECT $1::numeric > 0 AS ok", [tot.total])).rows[0].ok;
    if (!positive) throw new HttpError(400, "Invoice total must be greater than zero");

    // Number: the upsert takes the counter row lock until commit, so concurrent creates are serialised and gap-free.
    const clock = (await client.query("SELECT COALESCE($1::timestamptz, now()) AS ts, to_char(COALESCE($1::timestamptz, now()) AT TIME ZONE 'UTC', 'YYYY') AS y", [nowArg])).rows[0];
    const counter = (
      await client.query("INSERT INTO fin_counters (key, value) VALUES ($1, 1) ON CONFLICT (key) DO UPDATE SET value = fin_counters.value + 1 RETURNING value::text AS value", [`invoice-${clock.y}`])
    ).rows[0];
    const number = `VITA-${clock.y}-${counter.value.padStart(6, "0")}`;

    const inv = (
      await client.query(
        `INSERT INTO invoices (candidate_id, total_amount, remaining_amount, currency, due_date, status, notes, created_by, number, issued_at, subtotal, tax_amount)
         VALUES ($1, $2::numeric, $2::numeric, $3, $4, 'Pending', $5, $6, $7, $8, $9::numeric, $10::numeric) RETURNING id`,
        [v.candidateId, tot.total, v.currency, v.dueDate, v.notes, user.id, number, clock.ts, tot.subtotal, tot.tax]
      )
    ).rows[0];

    await client.query(
      `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, position)
       SELECT $1, s, d, q::numeric, p::numeric, ord FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS t(s, d, q, p, ord)`,
      [inv.id, lines.map((l) => l.serviceId), lines.map((l) => l.description), lines.map((l) => l.quantity), lines.map((l) => l.unitPrice)]
    );
    const check = (await client.query("SELECT COALESCE(SUM(line_total),0) = $2::numeric AS ok FROM invoice_items WHERE invoice_id = $1", [inv.id, tot.subtotal])).rows[0];
    if (!check.ok) throw new Error("invoice items do not add up to the subtotal"); // invariant; rolls back

    await client.query(
      "INSERT INTO fin_ledger (kind, ref_table, ref_id, candidate_id, currency, debit, credit, actor_id) VALUES ('invoice','invoices',$1,$2,$3,$4::numeric,0,$5)",
      [inv.id, v.candidateId, v.currency, tot.total, user.id]
    );
    const full = await details(client, await loadFull(client, inv.id));
    await logAudit({ client, userId: user.id, action: "CREATE", tableName: "invoices", recordId: inv.id, newData: { ...full, payments: undefined, refunds: undefined, balance: undefined } });
    return full;
  });
}

async function listInvoices(user, query = {}, opts = {}) {
  c.requirePerm(user, "finance:read");
  const where = ["i.is_deleted = false"];
  const params = [];
  const add = (val) => (params.push(val), `$${params.length}`);

  const candidateId = c.oneValue(query.candidate_id, "candidate_id");
  if (candidateId !== undefined && candidateId !== "") where.push(`i.candidate_id = ${add(c.parseId(candidateId))}`);
  const status = c.oneValue(query.status, "status");
  if (status !== undefined && status !== "") {
    if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}`);
    where.push(`i.status = ${add(status)}`);
  }
  const currency = c.oneValue(query.currency, "currency");
  if (currency !== undefined && currency !== "") {
    if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "currency must be a 3-letter upper-case code");
    where.push(`i.currency = ${add(currency)}`);
  }
  const from = c.oneValue(query.from, "from");
  if (from !== undefined && from !== "") where.push(`COALESCE(i.issued_at, i.created_at)::date >= ${add(c.parseDate(from, "from"))}::date`);
  const to = c.oneValue(query.to, "to");
  if (to !== undefined && to !== "") where.push(`COALESCE(i.issued_at, i.created_at)::date <= ${add(c.parseDate(to, "to"))}::date`);
  const q = c.oneValue(query.q, "q");
  if (q !== undefined && q.trim() !== "") {
    const p = add(`%${c.likeEscape(q.trim().slice(0, 100))}%`);
    where.push(`(i.number ILIKE ${p} OR c.full_name ILIKE ${p})`);
  }
  const todaySql = opts.today ? `DATE '${c.parseDate(opts.today, "today")}'` : "CURRENT_DATE"; // validated YYYY-MM-DD literal (test clock)
  const overdueExpr = `(i.due_date IS NOT NULL AND i.due_date < ${todaySql} AND i.remaining_amount > 0 AND i.status NOT IN ('Void','Paid'))`;
  const overdue = c.oneValue(query.overdue, "overdue");
  if (overdue !== undefined && overdue !== "") {
    if (!["true", "false", "1", "0"].includes(overdue)) throw new HttpError(400, "overdue must be true or false");
    where.push(overdue === "true" || overdue === "1" ? overdueExpr : `NOT ${overdueExpr}`);
  }
  const { limit, offset } = c.pageParams(query);
  const base = `FROM invoices i JOIN candidates c ON c.id = i.candidate_id WHERE ${where.join(" AND ")}`;
  const total = Number((await db().query(`SELECT count(*) AS n ${base}`, params)).rows[0].n);
  const rows = (
    await db().query(`SELECT ${INVOICE_COLS}, ${overdueExpr} AS overdue ${base} ORDER BY i.id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`, params)
  ).rows;
  return { rows, total };
}

async function getInvoice(user, rawId) {
  c.requirePerm(user, "finance:read");
  const id = c.parseId(rawId);
  const client = await db().connect();
  try {
    const inv = await loadFull(client, id);
    if (!inv) throw new HttpError(404, "Invoice not found");
    return await details(client, inv);
  } finally {
    client.release();
  }
}

async function voidInvoice(user, rawId, input) {
  c.requirePerm(user, "finance:void");
  const id = c.parseId(rawId);
  if (!c.isObj(input)) throw new HttpError(400, "A JSON object body is required");
  for (const k of Object.keys(input)) if (k !== "reason") throw new HttpError(400, `Unknown field: ${k}`);
  const reason = c.requiredText(input.reason, "reason", REASON_MAX);
  return c.inTransaction(async (client) => {
    const cur = await loadFull(client, id, { lock: true });
    if (!cur) throw new HttpError(404, "Invoice not found");
    if (cur.status === "Void") throw new HttpError(409, "Invoice is already void");
    const live = Number((await client.query("SELECT count(*) AS n FROM payments WHERE invoice_id = $1 AND is_deleted = false AND voided_at IS NULL", [id])).rows[0].n);
    if (live > 0) throw new HttpError(409, "Invoice has payments: void or refund the payments first");
    await client.query("UPDATE invoices SET status = 'Void', voided_at = now(), void_reason = $2, remaining_amount = 0, updated_at = now() WHERE id = $1", [id, reason]);
    await client.query(
      "INSERT INTO fin_ledger (kind, ref_table, ref_id, candidate_id, currency, debit, credit, actor_id) VALUES ('void','invoices',$1,$2,$3,0,$4::numeric,$5)",
      [id, cur.candidate_id, cur.currency, cur.total_amount, user.id]
    );
    const next = await loadFull(client, id);
    await logAudit({ client, userId: user.id, action: "VOID", tableName: "invoices", recordId: id, oldData: cur, newData: next });
    return details(client, next);
  });
}

// ---------------------------------------------------------------------------------------------------------------- print
const esc = (v) =>
  String(v === null || v === undefined ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const LABELS = {
  en: { invoice: "Invoice", number: "Number", status: "Status", issued: "Issued", due: "Due date", bill_to: "Billed to", description: "Description", qty: "Qty", unit: "Unit price", total_line: "Total", subtotal: "Subtotal", tax: "Tax", total: "Total", paid: "Paid", remaining: "Balance due", notes: "Notes", void: "VOID", void_reason: "Reason", tax_id: "Tax ID", legacy: "(no number)",
    statuses: { Draft: "Draft", Pending: "Pending", Partial: "Partially paid", Paid: "Paid", Void: "Void", Refunded: "Refunded" } },
  fr: { invoice: "Facture", number: "Numéro", status: "Statut", issued: "Émise le", due: "Échéance", bill_to: "Facturé à", description: "Désignation", qty: "Qté", unit: "Prix unitaire", total_line: "Total", subtotal: "Sous-total", tax: "Taxe", total: "Total", paid: "Payé", remaining: "Solde à payer", notes: "Notes", void: "ANNULÉE", void_reason: "Motif", tax_id: "N° fiscal", legacy: "(sans numéro)",
    statuses: { Draft: "Brouillon", Pending: "En attente", Partial: "Partiellement payée", Paid: "Payée", Void: "Annulée", Refunded: "Remboursée" } },
  ar: { invoice: "فاتورة", number: "الرقم", status: "الحالة", issued: "تاريخ الإصدار", due: "تاريخ الاستحقاق", bill_to: "الفاتورة إلى", description: "البيان", qty: "الكمية", unit: "سعر الوحدة", total_line: "المجموع", subtotal: "المجموع الفرعي", tax: "الضريبة", total: "الإجمالي", paid: "المدفوع", remaining: "الرصيد المستحق", notes: "ملاحظات", void: "ملغاة", void_reason: "السبب", tax_id: "المعرف الجبائي", legacy: "(بدون رقم)",
    statuses: { Draft: "مسودة", Pending: "قيد الانتظار", Partial: "مدفوعة جزئيا", Paid: "مدفوعة", Void: "ملغاة", Refunded: "مستردة" } },
};
const LANGS = Object.keys(LABELS);

/** Company header from env, shown only for the parts that are set. Values are escaped by the renderer. */
function companyHeader() {
  const g = (k) => String(process.env[k] || "").trim();
  return { name: g("FIN_COMPANY_NAME"), address: g("FIN_COMPANY_ADDRESS"), taxId: g("FIN_COMPANY_TAX_ID") };
}

/** Self-contained HTML (no scripts, no inline styles; styling from /vita/fin-print.css). Every dynamic value is escaped. */
function renderInvoiceHtml(inv, lang) {
  const L = LABELS[lang];
  const co = companyHeader();
  const isVoid = inv.status === "Void";
  const money = (v) => esc(formatMoney(v, inv.currency));
  const dt = (v) => esc(v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : "");
  const rows = inv.items
    .map((it) => `<tr><td>${esc(it.description)}</td><td class="num">${esc(it.quantity)}</td><td class="num">${money(it.unit_price)}</td><td class="num">${money(it.line_total)}</td></tr>`)
    .join("");
  const hasTax = /[1-9]/.test(String(inv.tax_amount || "0"));
  const totals = [
    hasTax ? `<tr><th>${esc(L.subtotal)}</th><td class="num">${money(inv.subtotal)}</td></tr><tr><th>${esc(L.tax)}</th><td class="num">${money(inv.tax_amount)}</td></tr>` : "",
    `<tr class="grand"><th>${esc(L.total)}</th><td class="num">${money(inv.total_amount)}</td></tr>`,
    `<tr><th>${esc(L.paid)}</th><td class="num">${money(inv.balance.net_paid)}</td></tr>`,
    `<tr><th>${esc(L.remaining)}</th><td class="num">${money(inv.remaining_amount)}</td></tr>`,
  ].join("");
  const header = [co.name && `<div class="co-name">${esc(co.name)}</div>`, co.address && `<div class="co-address">${esc(co.address)}</div>`, co.taxId && `<div class="co-tax">${esc(L.tax_id)}: ${esc(co.taxId)}</div>`].filter(Boolean).join("");
  const number = inv.number || L.legacy;
  return `<!doctype html>
<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(L.invoice)} ${esc(number)}</title>
<link rel="stylesheet" href="/vita/fin-print.css">
</head>
<body class="fin-doc">
<main class="fin-sheet">
${isVoid ? `<div class="watermark" aria-hidden="true">${esc(L.void)}</div>` : ""}
<header class="fin-head">${header ? `<div class="fin-company">${header}</div>` : ""}<h1>${esc(L.invoice)} ${esc(number)}</h1></header>
<section class="fin-meta">
<dl>
<dt>${esc(L.number)}</dt><dd>${esc(number)}</dd>
<dt>${esc(L.status)}</dt><dd>${esc(L.statuses[inv.status] || inv.status)}</dd>
<dt>${esc(L.issued)}</dt><dd>${dt(inv.issued_at || inv.created_at)}</dd>
${inv.due_date ? `<dt>${esc(L.due)}</dt><dd>${dt(inv.due_date)}</dd>` : ""}
<dt>${esc(L.bill_to)}</dt><dd>${esc(inv.candidate_name)}</dd>
</dl>
</section>
<table class="fin-items">
<thead><tr><th>${esc(L.description)}</th><th class="num">${esc(L.qty)}</th><th class="num">${esc(L.unit)}</th><th class="num">${esc(L.total_line)}</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<table class="fin-totals"><tbody>${totals}</tbody></table>
${inv.notes ? `<section class="fin-notes"><h2>${esc(L.notes)}</h2><p>${esc(inv.notes)}</p></section>` : ""}
${isVoid && inv.void_reason ? `<section class="fin-void"><strong>${esc(L.void)}</strong> - ${esc(L.void_reason)}: ${esc(inv.void_reason)}</section>` : ""}
</main>
</body>
</html>
`;
}

async function printInvoice(user, rawId, { lang = "en" } = {}) {
  if (typeof lang !== "string" || !LANGS.includes(lang)) throw new HttpError(400, `lang must be one of ${LANGS.join(", ")}`);
  const inv = await getInvoice(user, rawId); // finance:read + 404
  return renderInvoiceHtml(inv, lang);
}

module.exports = { createInvoice, listInvoices, getInvoice, voidInvoice, printInvoice, renderInvoiceHtml, taxRatePercent, STATUSES, LANGS, esc };
