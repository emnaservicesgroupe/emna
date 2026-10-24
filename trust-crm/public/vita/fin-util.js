/* Accounting console helpers: money formatting and input checks on DECIMAL STRINGS, payload builders, query builders and
   the finance permission mirror. Pure data/logic only (no DOM): loaded as a classic script in the browser
   (window.VITA_FIN_UTIL) and required by tests/fin-ui.test.js.

   Money rules (the server is the only place where money is added, multiplied or compared for real):
   - amounts are exchanged as strings ("1234.50"); nothing here converts them to numbers or floats;
   - formatting groups the digits with string operations; comparisons are digit-by-digit on normalised strings;
   - the console never computes totals, balances or refundable amounts: it shows what the API returned. */
(function (root) {
  "use strict";

  var CU = root.VITA_CRM_UTIL || (typeof require === "function" ? require("./crm-util.js") : null);

  var CURRENCIES = ["TND", "EUR", "CAD", "USD"]; // default FIN_CURRENCIES; the API refuses anything the owner did not enable
  var INVOICE_STATUSES = ["Draft", "Pending", "Partial", "Paid", "Void", "Refunded"];
  var METHODS = ["cash", "bank_transfer", "card", "mobile", "cheque", "other"];
  var STATEMENT_KINDS = ["invoice", "payment", "refund"];
  var BUCKETS = ["current", "0-30", "31-60", "61-90", "90+", "no_due_date"];
  var EXPORT_KINDS = ["invoices", "payments", "expenses"];
  var LIMITS = { items: 50, description: 300, invoiceNotes: 2000, reason: 500, reference: 120, payNotes: 500, title: 160, payee: 160, expenseNotes: 500, name: 160, category: 80, moneyDigits: 10, quantityDigits: 8 };
  var PG_INT_MAX = "2147483647";

  // ---------------------------------------------------------------- permissions (mirror of middleware/role.js)
  function can(role, perm) { return Boolean(CU) && CU.can(role, perm); }
  function canRead(role) { return can(role, "finance:read"); }
  function canWrite(role) { return can(role, "finance:write"); }
  function canVoid(role) { return can(role, "finance:void"); }
  function canRefund(role) { return can(role, "finance:refund"); }
  function canExport(role) { return can(role, "finance:export"); }

  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function trimmed(v) { return typeof v === "string" ? v.trim() : ""; }

  // ---------------------------------------------------------------- decimal strings
  var DEC = /^(-?)(\d+)(?:\.(\d+))?$/;
  function stripZeros(int) { return int.replace(/^0+(?=\d)/, ""); }

  /** "1234.5" -> "1,234.50" (string operations only). Anything that is not a plain decimal string -> "—". */
  function formatMoney(value, currency) {
    if (typeof value !== "string") return "—";
    var m = DEC.exec(value.trim());
    if (!m) return "—";
    var int = stripZeros(m[2]).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    var frac = (m[3] || "").slice(0, 2);
    while (frac.length < 2) frac += "0";
    var out = int + "." + frac;
    if (m[1] === "-" && /[1-9]/.test(int + frac)) out = "-" + out;
    return currency ? out + " " + currency : out;
  }

  function parseDecimalInput(raw, maxIntDigits, positive) {
    if (typeof raw !== "string") return { ok: false, error: "format" };
    var s = raw.trim();
    if (s === "") return { ok: false, error: "empty" };
    var m = /^(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) return { ok: false, error: "format" };
    var frac = m[2] || "";
    if (frac.length > 2) return { ok: false, error: "decimals" };
    var int = stripZeros(m[1]);
    if (int.length > maxIntDigits) return { ok: false, error: "large" };
    while (frac.length < 2) frac += "0";
    var value = int + "." + frac;
    if (positive && !/[1-9]/.test(value)) return { ok: false, error: "zero" };
    return { ok: true, value: value };
  }
  /** Money typed by a person: 12, 12.5, 12.50 are accepted (-> "12.00", "12.50"); 1e3, 12,5, -1, 1.234 are not. */
  function parseMoneyInput(raw, opts) { return parseDecimalInput(raw, LIMITS.moneyDigits, Boolean(opts && opts.positive)); }
  /** Quantity: > 0, at most 2 decimals, at most 8 integer digits (the API column is numeric(10,2)). */
  function parseQuantityInput(raw) { return parseDecimalInput(raw, LIMITS.quantityDigits, true); }

  /** Compares two decimal strings digit by digit: -1, 0, 1, or null when either is not a plain decimal. */
  function cmpDecimal(a, b) {
    var x = typeof a === "string" ? DEC.exec(a.trim()) : null;
    var y = typeof b === "string" ? DEC.exec(b.trim()) : null;
    if (!x || !y) return null;
    function norm(m) {
      var int = stripZeros(m[2]);
      var frac = m[3] || "";
      var zero = !/[1-9]/.test(int + frac);
      return { neg: m[1] === "-" && !zero, int: int, frac: frac };
    }
    var p = norm(x), q = norm(y);
    if (p.neg !== q.neg) return p.neg ? -1 : 1;
    var sign = p.neg ? -1 : 1;
    var n = Math.max(p.frac.length, q.frac.length);
    while (p.frac.length < n) p.frac += "0";
    while (q.frac.length < n) q.frac += "0";
    if (p.int.length !== q.int.length) return p.int.length > q.int.length ? sign : -sign;
    var a2 = p.int + p.frac, b2 = q.int + q.frac;
    if (a2 === b2) return 0;
    return a2 > b2 ? sign : -sign;
  }
  function isZero(v) { return typeof v === "string" && DEC.test(v.trim()) && !/[1-9]/.test(v); }

  /** Random, URL-safe key (<= 100 characters, the API limit). One per dialog opening, so a double click replays. */
  function newIdempotencyKey() {
    var hex = "";
    var c = root.crypto || (typeof globalThis !== "undefined" ? globalThis.crypto : null);
    if (c && typeof c.getRandomValues === "function") {
      var a = new Uint8Array(16);
      c.getRandomValues(a);
      for (var i = 0; i < a.length; i++) hex += (a[i] < 16 ? "0" : "") + a[i].toString(16);
    } else {
      for (var j = 0; j < 32; j++) hex += Math.floor(Math.random() * 16).toString(16); // very old browsers only
    }
    return "ui-" + hex;
  }

  // ---------------------------------------------------------------- small validators
  function validDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  /** Positive integer id typed or picked by a person; null when it is not one the API could know. */
  function parseId(raw) {
    var s = typeof raw === "number" ? String(raw) : trimmed(raw);
    if (!/^[1-9]\d{0,9}$/.test(s)) return null;
    if (s.length === 10 && s > PG_INT_MAX) return null;
    return Number(s);
  }
  function fail(field, code, line) {
    var out = { ok: false, error: field, field: field };
    if (code) out.code = code;
    if (line !== undefined) out.line = line;
    return out;
  }
  /** Optional text: trimmed; null when empty; {error:true} when longer than `max`. */
  function optText(v, max) {
    var t = trimmed(v);
    if (t.length > max) return { error: true };
    return { value: t === "" ? null : t };
  }
  function withDefined(obj, key, val) { if (val !== null && val !== undefined) obj[key] = val; }

  // ---------------------------------------------------------------- invoices
  /**
   * Create-invoice dialog values -> API body. `services` is the catalogue the dialog loaded (for default prices).
   * Failure: {ok:false, field, code?, line?} where `line` is the 0-based line the problem is on.
   * No totals are computed here: the API calculates them in SQL and the detail view shows its numbers.
   */
  function invoicePayload(form, services) {
    var f = form || {};
    var list = Array.isArray(services) ? services : [];
    var cid = parseId(f.candidate_id);
    if (cid === null) return fail("candidate");
    var currency = trimmed(f.currency);
    if (CURRENCIES.indexOf(currency) < 0) return fail("currency");
    var payload = { candidate_id: cid, currency: currency };
    var due = trimmed(f.due_date);
    if (due) {
      if (!validDate(due)) return fail("due_date");
      payload.due_date = due;
    }
    var notes = optText(f.notes, LIMITS.invoiceNotes);
    if (notes.error) return fail("notes");
    withDefined(payload, "notes", notes.value);
    var lines = Array.isArray(f.lines) ? f.lines : [];
    if (lines.length < 1 || lines.length > LIMITS.items) return fail("lines", lines.length ? "many" : "none");
    var items = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i] || {};
      var sid = trimmed(l.service_id);
      var svc = null;
      if (sid) {
        svc = list.filter(function (s) { return String(s.id) === sid; })[0] || null;
        if (!svc) return fail("service", null, i);
      }
      var desc = optText(l.description, LIMITS.description);
      if (desc.error) return fail("description", "long", i);
      if (!svc && desc.value === null) return fail("description", "empty", i);
      var qty = parseQuantityInput(l.quantity);
      if (!qty.ok) return fail("quantity", qty.error, i);
      var item = {};
      if (svc) item.service_id = Number(svc.id);
      withDefined(item, "description", desc.value);
      item.quantity = qty.value;
      var rawPrice = trimmed(l.unit_price);
      if (rawPrice === "") {
        if (!svc || svc.currency !== currency) return fail("unit_price", svc ? "currency" : "empty", i);
      } else {
        var price = parseMoneyInput(rawPrice);
        if (!price.ok) return fail("unit_price", price.error, i);
        item.unit_price = price.value;
      }
      items.push(item);
    }
    payload.items = items;
    return { ok: true, payload: payload };
  }

  function paymentPayload(form, key) {
    var f = form || {};
    var id = parseId(f.invoice_id);
    if (id === null) return fail("invoice");
    var amount = parseMoneyInput(f.amount, { positive: true });
    if (!amount.ok) return fail("amount", amount.error);
    var method = trimmed(f.method);
    if (METHODS.indexOf(method) < 0) return fail("method");
    var payload = { invoice_id: id, amount: amount.value, method: method };
    var date = trimmed(f.payment_date);
    if (date) {
      if (!validDate(date)) return fail("payment_date");
      payload.payment_date = date;
    }
    var ref = optText(f.reference, LIMITS.reference);
    if (ref.error) return fail("reference");
    withDefined(payload, "reference", ref.value);
    var notes = optText(f.notes, LIMITS.payNotes);
    if (notes.error) return fail("notes");
    withDefined(payload, "notes", notes.value);
    if (key) payload.idempotency_key = String(key);
    return { ok: true, payload: payload };
  }

  function reasonPayload(raw) {
    var r = optText(raw, LIMITS.reason);
    if (r.error) return fail("reason", "long");
    if (r.value === null) return fail("reason", "empty");
    return { ok: true, payload: { reason: r.value } };
  }

  function refundPayload(form) {
    var f = form || {};
    var amount = parseMoneyInput(f.amount, { positive: true });
    if (!amount.ok) return fail("amount", amount.error);
    var reason = reasonPayload(f.reason);
    if (!reason.ok) return reason;
    var payload = { amount: amount.value, reason: reason.payload.reason };
    if (f.reopen === true) payload.reopen = true;
    return { ok: true, payload: payload };
  }

  // ---------------------------------------------------------------- expenses and services
  function expensePayload(form) {
    var f = form || {};
    var title = optText(f.title, LIMITS.title);
    if (title.error) return fail("title", "long");
    if (title.value === null) return fail("title", "empty");
    var amount = parseMoneyInput(f.amount, { positive: true });
    if (!amount.ok) return fail("amount", amount.error);
    var currency = trimmed(f.currency);
    if (CURRENCIES.indexOf(currency) < 0) return fail("currency");
    var spent = trimmed(f.spent_on);
    if (!validDate(spent)) return fail("spent_on");
    var payload = { title: title.value, amount: amount.value, currency: currency, spent_on: spent };
    if (trimmed(f.category_id) !== "" || typeof f.category_id === "number") {
      var cat = parseId(f.category_id);
      if (cat === null) return fail("category");
      payload.category_id = cat;
    }
    var payee = optText(f.payee, LIMITS.payee);
    if (payee.error) return fail("payee");
    withDefined(payload, "payee", payee.value);
    var notes = optText(f.notes, LIMITS.expenseNotes);
    if (notes.error) return fail("notes");
    withDefined(payload, "notes", notes.value);
    return { ok: true, payload: payload };
  }

  var NAME_FIELDS = ["name_ar", "name_en", "name_fr"];
  /**
   * Service dialog -> API body. Creating: all given fields. Updating (opts.base = the stored row): only what changed
   * (a cleared name is sent as null); {field:"nothing"} when nothing changed.
   */
  function servicePayload(form, opts) {
    var f = form || {};
    var o = opts || {};
    var creating = o.creating !== false;
    var base = o.base || {};
    var payload = {};
    if (creating) {
      var code = trimmed(f.code).toUpperCase();
      if (!/^[A-Z0-9_-]{2,30}$/.test(code)) return fail("code");
      payload.code = code;
    }
    var names = {};
    for (var i = 0; i < NAME_FIELDS.length; i++) {
      var k = NAME_FIELDS[i];
      var n = optText(f[k], LIMITS.name);
      if (n.error) return fail(k, "long");
      names[k] = n.value;
    }
    if (NAME_FIELDS.every(function (k2) { return names[k2] === null; })) return fail("name");
    var price = parseMoneyInput(f.default_price);
    if (!price.ok) return fail("default_price", price.error);
    var currency = trimmed(f.currency);
    if (CURRENCIES.indexOf(currency) < 0) return fail("currency");
    if (creating) {
      NAME_FIELDS.forEach(function (k3) { withDefined(payload, k3, names[k3]); });
      payload.default_price = price.value;
      payload.currency = currency;
      return { ok: true, payload: payload };
    }
    NAME_FIELDS.forEach(function (k4) {
      var before = base[k4] === undefined || base[k4] === null || base[k4] === "" ? null : String(base[k4]);
      if (before !== names[k4]) payload[k4] = names[k4];
    });
    if (cmpDecimal(price.value, str(base.default_price)) !== 0) payload.default_price = price.value;
    if (currency !== base.currency) payload.currency = currency;
    if (!Object.keys(payload).length) return fail("nothing");
    return { ok: true, payload: payload };
  }

  function categoryPayload(raw) {
    var n = optText(raw, LIMITS.category);
    if (n.error) return fail("name", "long");
    if (n.value === null) return fail("name", "empty");
    return { ok: true, payload: { name: n.value } };
  }

  // ---------------------------------------------------------------- queries
  function clampPage(page, size) {
    var s = Math.max(1, Math.min(100, Math.floor(Number(size) || 25)));
    var p = Math.max(1, Math.floor(Number(page) || 1));
    return { limit: s, offset: (p - 1) * s };
  }
  function pushDate(parts, key, v) {
    var s = trimmed(v);
    if (s && validDate(s)) parts.push(key + "=" + s);
  }
  function invoiceQuery(filters, page, pageSize) {
    var f = filters || {};
    var parts = [];
    var status = trimmed(f.status);
    if (INVOICE_STATUSES.indexOf(status) >= 0) parts.push("status=" + status);
    var cur = trimmed(f.currency);
    if (/^[A-Z]{3}$/.test(cur)) parts.push("currency=" + cur);
    var cid = trimmed(f.candidate_id);
    if (/^\d{1,10}$/.test(cid)) parts.push("candidate_id=" + cid);
    pushDate(parts, "from", f.from);
    pushDate(parts, "to", f.to);
    if (f.overdue === true) parts.push("overdue=true");
    var q = trimmed(f.q).slice(0, 100).trim();
    if (q) parts.push("q=" + encodeURIComponent(q));
    var pg = clampPage(page, pageSize);
    parts.push("limit=" + pg.limit, "offset=" + pg.offset);
    return "?" + parts.join("&");
  }
  function expenseQuery(filters, page, pageSize) {
    var f = filters || {};
    var parts = [];
    var cat = trimmed(f.category_id);
    if (/^\d{1,10}$/.test(cat)) parts.push("category_id=" + cat);
    var cur = trimmed(f.currency);
    if (/^[A-Z]{3}$/.test(cur)) parts.push("currency=" + cur);
    pushDate(parts, "from", f.from);
    pushDate(parts, "to", f.to);
    if (f.include_voided === true) parts.push("include_voided=true");
    var pg = clampPage(page, pageSize);
    parts.push("limit=" + pg.limit, "offset=" + pg.offset);
    return "?" + parts.join("&");
  }
  function rangeQuery(from, to) {
    var parts = [];
    pushDate(parts, "from", from);
    pushDate(parts, "to", to);
    return parts.length ? "?" + parts.join("&") : "";
  }

  // ---------------------------------------------------------------- action rules (the server decides; these only hide buttons)
  function canRecordPayment(inv) {
    return Boolean(inv) && (inv.status === "Pending" || inv.status === "Partial") && typeof inv.remaining_amount === "string" && !isZero(inv.remaining_amount);
  }
  function canVoidInvoice(inv) { return Boolean(inv) && inv.status !== "Void"; }
  function canVoidPayment(p) { return Boolean(p) && !p.voided_at && (p.refunded === undefined || isZero(p.refunded)); }
  /** The refundable amount is the server's net amount of the payment (paid minus refunds); nothing is subtracted here. */
  function refundable(p) {
    if (!p || p.voided_at || typeof p.net_amount !== "string" || !DEC.test(p.net_amount)) return "0.00";
    return p.net_amount;
  }
  function statusClass(status) {
    return { Draft: "neutral", Pending: "info", Partial: "warn", Paid: "ok", Void: "bad", Refunded: "gold" }[status] || "neutral";
  }

  /** Catalogue name in the viewer's language, falling back to another language, then the code. */
  function serviceName(s, lang) {
    if (!s) return "";
    return str(s["name_" + lang]) || str(s.name_en) || str(s.name_fr) || str(s.name_ar) || str(s.code);
  }

  /**
   * A print page fetched with the bearer token is opened from a blob: URL, where its relative stylesheet link cannot
   * resolve. Point exactly that link at the site origin. The page text is left unchanged if the origin looks wrong.
   */
  function rewriteDoc(html, origin) {
    if (typeof html !== "string" || typeof origin !== "string" || !/^https?:\/\/[A-Za-z0-9.:\[\]-]+$/.test(origin)) return html;
    var needle = '<link rel="stylesheet" href="/vita/fin-print.css">';
    return html.split(needle).join('<link rel="stylesheet" href="' + origin + '/vita/fin-print.css">');
  }

  /** YYYY-MM-DD in the viewer's zone, and the first day of that month (default report range). */
  function ymd(d) {
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function defaultRange(now) {
    var d = now || new Date();
    return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: ymd(d) };
  }

  var api = {
    CURRENCIES: CURRENCIES, INVOICE_STATUSES: INVOICE_STATUSES, METHODS: METHODS, STATEMENT_KINDS: STATEMENT_KINDS, BUCKETS: BUCKETS, EXPORT_KINDS: EXPORT_KINDS, LIMITS: LIMITS,
    can: can, canRead: canRead, canWrite: canWrite, canVoid: canVoid, canRefund: canRefund, canExport: canExport,
    formatMoney: formatMoney, parseMoneyInput: parseMoneyInput, parseQuantityInput: parseQuantityInput, cmpDecimal: cmpDecimal, isZero: isZero,
    newIdempotencyKey: newIdempotencyKey, parseId: parseId, validDate: validDate,
    invoicePayload: invoicePayload, paymentPayload: paymentPayload, reasonPayload: reasonPayload, refundPayload: refundPayload,
    expensePayload: expensePayload, servicePayload: servicePayload, categoryPayload: categoryPayload,
    invoiceQuery: invoiceQuery, expenseQuery: expenseQuery, rangeQuery: rangeQuery,
    canRecordPayment: canRecordPayment, canVoidInvoice: canVoidInvoice, canVoidPayment: canVoidPayment, refundable: refundable,
    statusClass: statusClass, serviceName: serviceName, rewriteDoc: rewriteDoc, defaultRange: defaultRange,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VITA_FIN_UTIL = api;
})(typeof window !== "undefined" ? window : this);
