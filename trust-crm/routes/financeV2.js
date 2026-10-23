// Accounting API (stage 4), mounted at /finance AFTER the legacy router (which keeps /dashboard, POST /invoices and
// POST /payments untouched). Router-level: valid session, never Employer / Agency; Candidate reaches ONLY /me and /me/*
// (and nobody else reaches those); then per-route permission.
//   GET   /services ?active&q                       finance:read
//   POST  /services {code,name_*,default_price,currency}   finance:write (201; 409 duplicate code)
//   PATCH /services/:id {name_*,default_price,currency,active}   finance:write (deactivate instead of delete)
//   POST  /invoices/v2 {candidate_id,currency,due_date?,notes?,items:[{service_id?|description,quantity,unit_price?}]}   finance:write (201)
//   GET   /invoices ?candidate_id&status&currency&from&to&q&overdue&limit&offset   finance:read -> {rows,total}
//   GET   /invoices/:id                              finance:read (items, payments, refunds, balance)
//   POST  /invoices/:id/void {reason}                finance:void (409 when live payments exist or already void)
//   GET   /invoices/:id/print ?lang=ar|en|fr         finance:read -> text/html under a strict CSP
//   GET   /payments ?invoice_id&candidate_id&method&from&to&include_voided&limit&offset   finance:read -> {rows,total}
//   POST  /payments/v2 {invoice_id,amount,method,payment_date?,reference?,notes?,idempotency_key?}   finance:write (201; 200 + replayed:true for a repeated key)
//   POST  /payments/:id/void {reason}                finance:void (409 when already void or refunded)
//   POST  /payments/:id/refund {amount,reason,reopen?}   finance:refund (400 above the refundable amount)
//   GET   /payments/:id/receipt ?lang=ar|en|fr       finance:read -> text/html under a strict CSP
//   GET   /expenses ?category_id&from&to&currency&include_voided&limit&offset   finance:read -> {rows,total}
//   POST  /expenses {title,amount,currency,spent_on,category_id?,payee?,notes?}   finance:write (201)
//   POST  /expenses/:id/void {reason}                finance:void (409 when already void)
//   GET   /expense-categories ?active                finance:read;   POST {name} finance:write (201; 409 duplicate);   PATCH /:id {name?,active?} finance:write
//   GET   /reports/summary ?from&to                  finance:read -> per-currency invoiced / collected / refunded / expenses / net
//   GET   /reports/receivables ?asOf&limit&offset    finance:read -> ageing buckets per currency + per-candidate balances
//   GET   /reports/by-service ?from&to               finance:read;   GET /reports/by-staff ?from&to   finance:read
//   GET   /reports/candidate/:id                     finance:read -> chronological statement with running balance per currency
//   GET   /export/{invoices,payments,expenses}.csv ?from&to   finance:export -> text/csv (X-Row-Limit-Hit when cut at the row cap)
//   GET   /me                                        role Candidate ONLY -> own invoices, payments and totals (no staff data)
//   GET   /me/invoices/:id/print ?lang=ar|en|fr      role Candidate ONLY, own invoice only (anything else: the same 404)
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const services = require("../modules/finance/services");
const invoices = require("../modules/finance/invoices");
const payments = require("../modules/finance/payments");
const expenses = require("../modules/finance/expenses");
const reports = require("../modules/finance/reports");
const exportCsv = require("../modules/finance/exportCsv");
const candidateView = require("../modules/finance/candidateView");

const router = express.Router();
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
const PRINT_CSP = "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(verifyToken);
// Candidate carve-out: ONLY /me and /me/* (Express matches paths case-insensitively, so the test is too). Employer and Agency
// are refused everywhere; staff roles are refused on /me*; a Candidate is refused on everything else.
const ME_PATH = /^\/me(\/|$)/i;
router.use((req, res, next) => {
  const role = req.user && req.user.role;
  const isMe = ME_PATH.test(req.path);
  if (role === "Employer" || role === "Agency") return res.status(403).json({ error: "Access denied" });
  if ((role === "Candidate") !== isMe) return res.status(403).json({ error: "Access denied" });
  return next();
});

router.get("/services", checkPermission("finance:read"), asyncHandler(async (req, res) => res.json(await services.listServices(req.user, req.query))));
router.post("/services", checkPermission("finance:write"), asyncHandler(async (req, res) => res.status(201).json(await services.createService(req.user, body(req)))));
router.patch("/services/:id", checkPermission("finance:write"), asyncHandler(async (req, res) => res.json(await services.updateService(req.user, req.params.id, body(req)))));

router.post("/invoices/v2", checkPermission("finance:write"), asyncHandler(async (req, res) => res.status(201).json(await invoices.createInvoice(req.user, body(req)))));
router.get("/invoices", checkPermission("finance:read"), asyncHandler(async (req, res) => res.json(await invoices.listInvoices(req.user, req.query))));
router.get("/invoices/:id", checkPermission("finance:read"), asyncHandler(async (req, res) => res.json(await invoices.getInvoice(req.user, req.params.id))));
router.post("/invoices/:id/void", checkPermission("finance:void"), asyncHandler(async (req, res) => res.json(await invoices.voidInvoice(req.user, req.params.id, body(req)))));
router.get(
  "/invoices/:id/print",
  checkPermission("finance:read"),
  asyncHandler(async (req, res) => {
    const lang = typeof req.query.lang === "string" ? req.query.lang : req.query.lang === undefined ? "en" : null;
    const html = await invoices.printInvoice(req.user, req.params.id, { lang });
    res.set({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": PRINT_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    res.send(html);
  })
);

const sendHtml = (res, html) => {
  res.set({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": PRINT_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  res.send(html);
};

router.get("/payments", checkPermission("finance:read"), asyncHandler(async (req, res) => res.json(await payments.listPayments(req.user, req.query))));
router.post(
  "/payments/v2",
  checkPermission("finance:write"),
  asyncHandler(async (req, res) => {
    const out = await payments.createPayment(req.user, body(req));
    res.status(out.replayed ? 200 : 201).json(out);
  })
);
router.post("/payments/:id/void", checkPermission("finance:void"), asyncHandler(async (req, res) => res.json(await payments.voidPayment(req.user, req.params.id, body(req)))));
router.post("/payments/:id/refund", checkPermission("finance:refund"), asyncHandler(async (req, res) => res.status(201).json(await payments.refundPayment(req.user, req.params.id, body(req)))));
router.get(
  "/payments/:id/receipt",
  checkPermission("finance:read"),
  asyncHandler(async (req, res) => {
    const lang = typeof req.query.lang === "string" ? req.query.lang : req.query.lang === undefined ? "en" : null;
    sendHtml(res, await payments.receiptHtml(req.user, req.params.id, { lang }));
  })
);

router.get("/expenses", checkPermission("finance:read"), asyncHandler(async (req, res) => res.json(await expenses.listExpenses(req.user, req.query))));
router.post("/expenses", checkPermission("finance:write"), asyncHandler(async (req, res) => res.status(201).json(await expenses.createExpense(req.user, body(req)))));
router.post("/expenses/:id/void", checkPermission("finance:void"), asyncHandler(async (req, res) => res.json(await expenses.voidExpense(req.user, req.params.id, body(req)))));
router.get("/expense-categories", checkPermission("finance:read"), asyncHandler(async (req, res) => res.json(await expenses.listCategories(req.user, req.query))));
router.post("/expense-categories", checkPermission("finance:write"), asyncHandler(async (req, res) => res.status(201).json(await expenses.createCategory(req.user, body(req)))));
router.patch("/expense-categories/:id", checkPermission("finance:write"), asyncHandler(async (req, res) => res.json(await expenses.updateCategory(req.user, req.params.id, body(req)))));

router.get("/reports/summary", checkPermission("finance:read"), asyncHandler(async (req, res) => res.json(await reports.summary(req.user, req.query))));
router.get("/reports/receivables", checkPermission("finance:read"), asyncHandler(async (req, res) => res.json(await reports.receivables(req.user, req.query))));
router.get("/reports/by-service", checkPermission("finance:read"), asyncHandler(async (req, res) => res.json(await reports.byService(req.user, req.query))));
router.get("/reports/by-staff", checkPermission("finance:read"), asyncHandler(async (req, res) => res.json(await reports.byStaff(req.user, req.query))));
router.get("/reports/candidate/:id", checkPermission("finance:read"), asyncHandler(async (req, res) => res.json(await reports.candidateStatement(req.user, req.params.id))));

for (const kind of ["invoices", "payments", "expenses"]) {
  router.get(
    `/export/${kind}.csv`,
    checkPermission("finance:export"),
    asyncHandler(async (req, res) => {
      const out = await exportCsv.exportCsv(req.user, kind, req.query);
      res.set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${out.filename}"`,
        "X-Content-Type-Options": "nosniff",
      });
      if (out.truncated) res.set("X-Row-Limit-Hit", "true");
      res.send(Buffer.from(out.csv, "utf8"));
    })
  );
}

router.get("/me", asyncHandler(async (req, res) => res.json(await candidateView.me(req.user))));
router.get(
  "/me/invoices/:id/print",
  asyncHandler(async (req, res) => {
    const lang = typeof req.query.lang === "string" ? req.query.lang : req.query.lang === undefined ? "en" : null;
    sendHtml(res, await candidateView.printMyInvoice(req.user, req.params.id, { lang }));
  })
);

router.use(jobsearchErrorHandler);

module.exports = router;
