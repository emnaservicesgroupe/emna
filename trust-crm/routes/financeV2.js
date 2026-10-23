// Accounting API (stage 4), mounted at /finance AFTER the legacy router (which keeps /dashboard, POST /invoices and
// POST /payments untouched). Router-level: valid session, never Candidate / Employer / Agency; then per-route permission.
//   GET   /services ?active&q                       finance:read
//   POST  /services {code,name_*,default_price,currency}   finance:write (201; 409 duplicate code)
//   PATCH /services/:id {name_*,default_price,currency,active}   finance:write (deactivate instead of delete)
//   POST  /invoices/v2 {candidate_id,currency,due_date?,notes?,items:[{service_id?|description,quantity,unit_price?}]}   finance:write (201)
//   GET   /invoices ?candidate_id&status&currency&from&to&q&overdue&limit&offset   finance:read -> {rows,total}
//   GET   /invoices/:id                              finance:read (items, payments, refunds, balance)
//   POST  /invoices/:id/void {reason}                finance:void (409 when live payments exist or already void)
//   GET   /invoices/:id/print ?lang=ar|en|fr         finance:read -> text/html under a strict CSP
const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const services = require("../modules/finance/services");
const invoices = require("../modules/finance/invoices");

const router = express.Router();
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
const PRINT_CSP = "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(verifyToken);
router.use((req, res, next) => {
  if (req.user && (req.user.role === "Candidate" || req.user.role === "Employer" || req.user.role === "Agency")) return res.status(403).json({ error: "Access denied" });
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

router.use(jobsearchErrorHandler);

module.exports = router;
