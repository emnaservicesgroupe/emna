/* Accounting tab (finance:read): shared pieces (section switcher, dialogs, candidate lookup, authenticated print) and the
   Invoices section: filterable list, detail with items / payments / refunds / balance, Record payment, Void invoice,
   Void payment, Refund and the Create invoice dialog.
   Money: every amount on screen is a decimal STRING exactly as the API returned it (fin-util.js formats it by string
   operations). The console never adds, multiplies or compares money; totals and balances come from the server.
   Server text (names, notes, references, reasons) is untrusted and rendered as text only. Buttons for actions a role
   cannot take are not shown (fin-util.js mirrors the permissions); the server decides on every call. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var FU = window.VITA_FIN_UTIL;
  var t = V.t, h = V.h, $ = V.$;

  var PAGE_SIZE = 25;
  var SECTIONS = ["invoices", "reports", "expenses", "services"];
  var MONEY_FIELDS = ["amount", "unit_price", "default_price"];
  var ERR = {
    candidate: "fin.err.candidate", currency: "fin.err.currency", due_date: "fin.err.dueDate", notes: "fin.err.tooLong", lines: "fin.err.lines",
    service: "fin.err.service", description: "fin.err.description", quantity: "fin.err.quantity", unit_price: "fin.err.unitPrice", amount: "fin.err.amount",
    method: "fin.err.method", payment_date: "fin.err.paymentDate", reference: "fin.err.tooLong", reason: "fin.err.reason", title: "fin.err.title",
    spent_on: "fin.err.spentOn", code: "fin.err.code", name: "fin.err.name", name_ar: "fin.err.tooLong", name_en: "fin.err.tooLong", name_fr: "fin.err.tooLong",
    default_price: "fin.err.defaultPrice", nothing: "fin.err.nothing", category: "fin.err.category", invoice: "fin.err.invoice", payee: "fin.err.tooLong",
  };
  var MONEY_ERR = { format: "fin.err.money.format", decimals: "fin.err.money.decimals", zero: "fin.err.money.zero", large: "fin.err.money.large", empty: "fin.err.money.empty" };

  function role() { return A.role(); }

  // ================================================================ shared helpers (window.VITA_FIN)
  var F = { sections: {}, current: "invoices", ready: false };
  window.VITA_FIN = F;

  F.role = role;
  F.PAGE_SIZE = PAGE_SIZE;

  /** Money as the API's decimal string with grouping and the currency code, in a left-to-right island. */
  F.money = function (value, currency) { return h("span", { class: "ltr-island", text: FU.formatMoney(value, currency) }); };
  F.date = function (value) { return value ? h("span", { class: "ltr-island", text: String(value).slice(0, 10) }) : "—"; };
  F.statusBadge = function (status) { return h("span", { class: "badge " + FU.statusClass(status), text: t("fin.status." + status) }); };
  F.field = function (id, label, control, hint) {
    return h("div", { class: "field" }, h("label", { for: id, text: label }), control, hint ? h("span", { class: "hint", text: hint }) : null);
  };
  F.select = function (id, items, current) {
    var sel = h("select", { id: id });
    A.fillSelect(sel, items, current);
    return sel;
  };
  F.currencyItems = function (withAny) {
    var items = FU.CURRENCIES.map(function (c) { return [c, c]; });
    return withAny ? [["", t("fin.anyCurrency")]].concat(items) : items;
  };
  F.methodItems = function () { return FU.METHODS.map(function (m) { return [m, t("fin.method." + m)]; }); };

  /** Localized text for a failed client-side check (result of a fin-util payload builder). */
  F.errText = function (res) {
    if (MONEY_FIELDS.indexOf(res.field) >= 0 && res.code && MONEY_ERR[res.code]) return t(MONEY_ERR[res.code]);
    if (res.field === "unit_price" && res.code === "currency") return t("fin.err.unitPriceCurrency");
    if (res.field === "lines" && res.code === "none") return t("fin.err.linesNone");
    if (res.field === "lines") return t("fin.err.lines");
    if (res.code === "long") return t("fin.err.tooLong");
    return t(ERR[res.field] || "fin.err.generic");
  };
  /** Marks `el` invalid, writes the message into `errEl` and focuses the field. */
  F.flag = function (el, errEl, message) {
    errEl.textContent = message;
    if (el) { el.setAttribute("aria-invalid", "true"); el.focus(); }
  };
  F.unflag = function (form) { V.$all("[aria-invalid]", form).forEach(function (x) { x.removeAttribute("aria-invalid"); }); };

  F.renderPager = function (box, page, pages, go) {
    V.clear(box);
    if (pages <= 1) return;
    var prev = h("button", { type: "button", class: "btn secondary small", text: t("common.prev"), disabled: page <= 1 });
    var next = h("button", { type: "button", class: "btn secondary small", text: t("common.next"), disabled: page >= pages });
    prev.addEventListener("click", function () { go(page - 1); });
    next.addEventListener("click", function () { go(page + 1); });
    box.appendChild(prev);
    box.appendChild(h("span", { class: "small", text: t("common.pageOf", { page: page, pages: pages }) }));
    box.appendChild(next);
  };

  var dlgSeq = 0;
  /**
   * Modal dialog around a <form>. `body` is an array of nodes (fields, error line, buttons). Returns {form, close}.
   * Escape and Cancel close it; focus returns to the element that opened it.
   */
  F.modal = function (title, body, o) {
    var id = "fin-dlg-" + (++dlgSeq);
    var form = h("form", { attrs: { novalidate: "" } }, h("h2", { id: id + "-t", text: title }), body);
    var dlg = h("dialog", { class: o && o.wide ? "wide" : null, attrs: { "aria-labelledby": id + "-t" } }, form);
    document.body.appendChild(dlg);
    var opener = document.activeElement;
    var close = function () {
      if (dlg.open) dlg.close();
      dlg.remove();
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
    };
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    return { form: form, close: close };
  };

  /**
   * Runs `fn` for a dialog submit button: ignores a second click while the first is in flight (no double submit),
   * and re-enables the button when it fails. The caller shows the error inline.
   */
  F.submit = function (button, state, fn) {
    if (state.sending) return Promise.resolve();
    state.sending = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    return Promise.resolve()
      .then(fn)
      .then(function (v) { return v; }, function (err) { state.sending = false; button.disabled = false; button.removeAttribute("aria-busy"); throw err; });
  };

  /** Reason + confirm dialog (void invoice, void payment, void expense). onSubmit(reason) returns a promise. */
  F.reasonDialog = function (o) {
    var reason = h("textarea", { id: "fin-reason", attrs: { rows: "3", maxlength: String(FU.LIMITS.reason) } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn danger", text: o.submitLabel });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var m = F.modal(o.title, [
      h("p", { class: "small", text: o.intro }),
      F.field("fin-reason", t("fin.reason"), reason, t("fin.reasonHint", { max: V.fmtNumber(FU.LIMITS.reason) })),
      err,
      h("div", { class: "btn-row" }, go, cancel),
    ]);
    var state = { sending: false };
    cancel.addEventListener("click", m.close);
    m.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      F.unflag(m.form);
      var built = FU.reasonPayload(reason.value);
      if (!built.ok) return F.flag(reason, err, F.errText(built));
      F.submit(go, state, function () { return o.onSubmit(built.payload.reason); })
        .then(function () { m.close(); })
        .catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
    reason.focus();
  };

  /** Fetches an HTML document with the bearer token and opens it in a new tab from a blob: URL (no token in any URL). */
  F.openDoc = function (path, name, button) {
    var run = function () {
      return V.download(path, name, { open: true, rewrite: function (html) { return FU.rewriteDoc(html, window.location.origin); } });
    };
    return button ? V.busy(button, run).catch(function () {}) : run();
  };

  // ---------------------------------------------------------------- catalogue cache (invoice dialog, services section)
  var catalogue = null;
  F.invalidateServices = function () { catalogue = null; };
  F.services = function () {
    if (catalogue) return Promise.resolve(catalogue);
    return V.api("GET", "/finance/services?active=true").then(function (d) { catalogue = (d && d.rows) || []; return catalogue; }).catch(function () { return []; });
  };

  // ---------------------------------------------------------------- candidate lookup (name search + numeric id)
  /**
   * Candidate picker: type 2+ letters of a name or passport number to search the candidates the role may read
   * (GET /candidates/all?search=), or type the numeric id. Returns {el, id(), set(id), input}.
   */
  F.candidatePicker = function (prefix, labelText) {
    var search = h("input", { id: prefix + "-search", type: "search", attrs: { maxlength: "100", autocomplete: "off" } });
    var pick = h("select", { id: prefix + "-pick" });
    var idInput = h("input", { id: prefix + "-id", type: "text", attrs: { inputmode: "numeric", maxlength: "10", autocomplete: "off", dir: "ltr" } });
    var state = h("p", { class: "small muted", attrs: { "aria-live": "polite" } });
    var seq = 0;
    var results = [];
    function fill() {
      A.fillSelect(pick, [["", results.length ? t("fin.cand.pick") : t("fin.cand.noMatches")]].concat(results.map(function (c) { return [String(c.id), c.name + " (#" + c.id + ")"]; })), "");
    }
    var lookup = V.debounce(function () {
      var q = search.value.trim();
      var mine = ++seq;
      if (q.length < 2) { results = []; fill(); V.setContent(state); return; }
      V.setContent(state, t("fin.cand.searching"));
      return V.api("GET", "/candidates/all?search=" + encodeURIComponent(q.slice(0, 100)))
        .then(function (rows) {
          if (mine !== seq) return;
          results = (Array.isArray(rows) ? rows : []).slice(0, 25).map(function (c) { return { id: c.id, name: String(c.full_name || "") }; });
          fill();
          V.setContent(state, results.length ? t("fin.cand.found", { n: results.length }) : t("fin.cand.noMatches"));
        })
        .catch(function (err) { if (mine === seq) V.setContent(state, V.errorMessage(err)); });
    }, 300);
    search.addEventListener("input", lookup);
    pick.addEventListener("change", function () {
      if (!pick.value) return;
      idInput.value = pick.value;
      var c = results.filter(function (x) { return String(x.id) === pick.value; })[0];
      V.setContent(state, c ? c.name + " (#" + c.id + ")" : "");
    });
    fill();
    var el = h("fieldset", null,
      h("legend", { text: labelText || t("fin.candidate") }),
      F.field(prefix + "-search", t("fin.cand.search"), search),
      F.field(prefix + "-pick", t("fin.cand.results"), pick),
      F.field(prefix + "-id", t("fin.cand.id"), idInput, t("fin.cand.idHint")),
      state
    );
    return {
      el: el,
      input: idInput,
      id: function () { return idInput.value.trim(); },
      set: function (id, name) { idInput.value = id === null || id === undefined ? "" : String(id); V.setContent(state, name ? name + " (#" + id + ")" : ""); },
    };
  };

  // ================================================================ section switcher + tab registration
  F.register = function (name, def) { F.sections[name] = def; };

  function showSection(name) {
    if (SECTIONS.indexOf(name) < 0) name = "invoices";
    F.current = name;
    SECTIONS.forEach(function (s) {
      var box = $("#fin-sec-" + s);
      if (box) box.hidden = s !== name;
      var btn = $("#fin-nav-" + s);
      if (btn) btn.setAttribute("aria-pressed", String(s === name));
    });
    var def = F.sections[name];
    if (def && def.load) def.load();
  }
  F.show = showSection;

  function initTab() {
    if (F.ready) return;
    F.ready = true;
    SECTIONS.forEach(function (s) {
      var btn = $("#fin-nav-" + s);
      if (btn) btn.addEventListener("click", function () { showSection(s); });
    });
    SECTIONS.forEach(function (s) { if (F.sections[s] && F.sections[s].init) F.sections[s].init(); });
  }
  function loadTab() { showSection(F.current); }
  A.registerTab("accounting", { init: initTab, load: loadTab, visible: function () { return FU.canRead(role()); } });

  // ================================================================ Invoices section
  var I = {
    filters: { status: "", currency: "", candidate_id: "", from: "", to: "", overdue: false, q: "" },
    page: 1, total: 0, rows: [], loaded: false, openId: null, inv: null, payments: [], notice: null,
    picker: null,
  };

  function buildFilters() {
    var f = I.filters;
    var status = F.select("fin-if-status", [["", t("fin.anyStatus")]].concat(FU.INVOICE_STATUSES.map(function (s) { return [s, t("fin.status." + s)]; })), f.status);
    var currency = F.select("fin-if-currency", F.currencyItems(true), f.currency);
    var from = h("input", { id: "fin-if-from", type: "date", value: f.from });
    var to = h("input", { id: "fin-if-to", type: "date", value: f.to });
    var q = h("input", { id: "fin-if-q", type: "search", attrs: { maxlength: "100", autocomplete: "off" }, value: f.q });
    var overdue = h("input", { id: "fin-if-overdue", type: "checkbox", checked: f.overdue });
    I.picker = F.candidatePicker("fin-if-cand", t("fin.filterCandidate"));
    I.picker.set(f.candidate_id);
    var apply = h("button", { type: "submit", class: "btn", text: t("filter.apply") });
    var reset = h("button", { type: "reset", class: "btn secondary", text: t("filter.reset") });
    var form = h("form", { class: "filters", attrs: { novalidate: "" } },
      F.field("fin-if-status", t("fin.status"), status),
      F.field("fin-if-currency", t("fin.currency"), currency),
      F.field("fin-if-from", t("fin.issuedFrom"), from),
      F.field("fin-if-to", t("fin.issuedTo"), to),
      F.field("fin-if-q", t("fin.invoices.search"), q),
      h("div", { class: "field" }, h("div", { class: "check" }, overdue, h("label", { for: "fin-if-overdue", text: t("fin.overdueOnly") }))),
      I.picker.el,
      h("div", { class: "field btn-row" }, apply, reset)
    );
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      I.filters = { status: status.value, currency: currency.value, candidate_id: I.picker.id(), from: from.value, to: to.value, overdue: overdue.checked, q: q.value };
      I.page = 1;
      loadList();
    });
    form.addEventListener("reset", function () {
      window.setTimeout(function () {
        I.filters = { status: "", currency: "", candidate_id: "", from: "", to: "", overdue: false, q: "" };
        I.page = 1;
        buildAll();
        loadList();
      }, 0);
    });
    return form;
  }

  function buildAll() {
    var box = $("#fin-sec-invoices");
    var canWrite = FU.canWrite(role());
    var add = h("button", { type: "button", class: "btn small", id: "fin-inv-new", text: t("fin.invoices.new") });
    add.addEventListener("click", function () { openCreate(add); });
    var refresh = h("button", { type: "button", class: "btn secondary small", id: "fin-inv-refresh", text: t("common.refresh") });
    refresh.addEventListener("click", function () { loadList(); });
    V.setContent(box,
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: t("fin.invoices.title") }), h("span", { class: "spacer" }), canWrite ? add : null, refresh),
        canWrite ? null : h("p", { class: "notice info small", id: "fin-readonly", text: t("fin.readOnly") }),
        buildFilters()
      ),
      h("div", { class: "card" },
        h("p", { class: "small muted", id: "fin-inv-summary", attrs: { "aria-live": "polite" } }),
        h("div", { id: "fin-inv-table" }),
        h("div", { class: "pager", id: "fin-inv-pager" })
      ),
      h("div", { class: "card", id: "fin-inv-card", hidden: !I.openId, attrs: { tabindex: "-1" } },
        h("div", { class: "card-head" }, h("h2", { id: "fin-inv-card-title", attrs: { tabindex: "-1" } }), h("span", { class: "spacer" }),
          (function () {
            var close = h("button", { type: "button", class: "btn secondary small", id: "fin-inv-close", text: t("common.close") });
            close.addEventListener("click", closeInvoice);
            return close;
          })()),
        h("div", { id: "fin-inv-body" })
      )
    );
    if (I.loaded) renderList();
    if (I.inv) renderInvoice();
  }

  function loadList() {
    var table = $("#fin-inv-table");
    if (!I.loaded) V.setContent(table, V.loading());
    return V.api("GET", "/finance/invoices" + FU.invoiceQuery(I.filters, I.page, PAGE_SIZE))
      .then(function (d) {
        I.loaded = true;
        I.rows = d.rows || [];
        I.total = d.total || 0;
        var pages = Math.max(1, Math.ceil(I.total / PAGE_SIZE));
        if (I.page > pages) { I.page = pages; return loadList(); }
        renderList();
      })
      .catch(function (err) { V.setContent($("#fin-inv-table"), A.errorBox(err)); V.setContent($("#fin-inv-summary")); V.clear($("#fin-inv-pager")); });
  }

  function renderList() {
    V.setContent($("#fin-inv-summary"), t("fin.invoices.count", { n: V.fmtNumber(I.total) }));
    var trs = I.rows.map(function (r) {
      var open = h("button", { type: "button", class: "btn secondary small", text: t("common.open") });
      open.addEventListener("click", function () { openInvoice(r.id, true); });
      return h("tr", { class: r.id === I.openId ? "selected" : null },
        h("td", null, h("strong", { text: r.number || "#" + r.id })),
        h("td", null, r.candidate_name, h("div", { class: "small muted", text: "#" + r.candidate_id })),
        h("td", null, F.date(r.issued_at)),
        h("td", null, F.date(r.due_date), r.overdue ? h("div", null, h("span", { class: "badge bad", text: t("fin.overdue") })) : null),
        h("td", { class: "num" }, F.money(r.total_amount, r.currency)),
        h("td", { class: "num" }, F.money(r.remaining_amount, r.currency)),
        h("td", null, F.statusBadge(r.status)),
        h("td", null, open)
      );
    });
    V.setContent($("#fin-inv-table"), A.table(
      [t("fin.number"), t("fin.candidate"), t("fin.issued"), t("fin.dueDate"), { label: t("fin.total"), num: true }, { label: t("fin.balance"), num: true }, t("fin.status"), t("common.actions")],
      trs, { empty: t("fin.invoices.none"), caption: t("fin.invoices.title") }));
    F.renderPager($("#fin-inv-pager"), I.page, Math.max(1, Math.ceil(I.total / PAGE_SIZE)), function (p) { I.page = p; loadList(); });
  }

  // ---------------------------------------------------------------- detail
  function closeInvoice() {
    I.openId = null;
    I.inv = null;
    I.notice = null;
    $("#fin-inv-card").hidden = true;
    renderList();
  }

  function openInvoice(id, focus) {
    if (I.openId !== id) I.notice = null;
    I.openId = id;
    $("#fin-inv-card").hidden = false;
    V.setContent($("#fin-inv-body"), V.loading());
    return Promise.all([
      V.api("GET", "/finance/invoices/" + id),
      V.api("GET", "/finance/payments?invoice_id=" + id + "&include_voided=true&limit=100"),
    ])
      .then(function (res) {
        if (I.openId !== id) return;
        I.inv = res[0];
        I.payments = ((res[1] && res[1].rows) || []).slice().reverse(); // the API lists newest first; an invoice reads oldest first
        renderInvoice();
        renderList();
        if (focus) { $("#fin-inv-card").scrollIntoView({ block: "start" }); $("#fin-inv-card-title").focus(); }
      })
      .catch(function (err) { V.setContent($("#fin-inv-body"), A.errorBox(err)); });
  }

  function refreshAfterChange(note) {
    I.notice = note || null;
    loadList();
    return openInvoice(I.openId, false);
  }

  function renderInvoice() {
    var inv = I.inv;
    if (!inv) return;
    var me = role();
    V.setContent($("#fin-inv-card-title"), t("fin.inv.heading", { number: inv.number || "#" + inv.id }));
    var parts = [];
    if (I.notice) parts.push(h("div", { class: "notice ok", attrs: { role: "status" } }, I.notice));
    if (inv.status === "Void") parts.push(h("p", { class: "notice bad", text: t("fin.inv.voidNotice", { reason: inv.void_reason || "—" }) }));
    if (!inv.number) parts.push(h("p", { class: "notice info small", text: t("fin.inv.legacy") }));

    var actions = h("div", { class: "btn-row" });
    var print = h("button", { type: "button", class: "btn secondary small", id: "fin-inv-print", text: t("fin.inv.print") });
    print.addEventListener("click", function () { F.openDoc("/finance/invoices/" + inv.id + "/print?lang=" + V.getLang(), "invoice.html", print); });
    actions.appendChild(print);
    if (FU.canWrite(me) && FU.canRecordPayment(inv)) {
      var pay = h("button", { type: "button", class: "btn small", id: "fin-inv-pay", text: t("fin.pay.button") });
      pay.addEventListener("click", function () { openPayment(inv, pay); });
      actions.appendChild(pay);
    }
    if (FU.canVoid(me) && FU.canVoidInvoice(inv)) {
      var voidBtn = h("button", { type: "button", class: "btn danger small", id: "fin-inv-void", text: t("fin.void.invoiceButton") });
      voidBtn.addEventListener("click", function () { openVoidInvoice(inv, voidBtn); });
      actions.appendChild(voidBtn);
    }
    parts.push(actions);

    var b = inv.balance || {};
    parts.push(A.kv([
      [t("fin.candidate"), inv.candidate_name + " (#" + inv.candidate_id + ")"],
      [t("fin.status"), F.statusBadge(inv.status)],
      [t("fin.issued"), F.date(inv.issued_at || inv.created_at)],
      [t("fin.dueDate"), inv.due_date ? F.date(inv.due_date) : null],
      [t("fin.notes"), inv.notes ? h("div", { class: "untrusted", text: inv.notes }) : null],
      [t("fin.currency"), inv.currency],
    ]));

    // items (amounts are the server's per-line totals)
    parts.push(h("h3", { text: t("fin.inv.items") }));
    var itemRows = (inv.items || []).map(function (it) {
      return h("tr", null,
        h("td", { text: it.description }),
        h("td", { class: "num" }, h("span", { class: "ltr-island", text: FU.formatMoney(it.quantity) })),
        h("td", { class: "num" }, F.money(it.unit_price, inv.currency)),
        h("td", { class: "num" }, F.money(it.line_total, inv.currency)));
    });
    parts.push(A.table([t("fin.description"), { label: t("fin.quantity"), num: true }, { label: t("fin.unitPrice"), num: true }, { label: t("fin.lineTotal"), num: true }], itemRows, { empty: t("fin.inv.noItems"), caption: t("fin.inv.items") }));

    // totals as calculated by the server
    var totals = [[t("fin.subtotal"), F.money(inv.subtotal, inv.currency)]];
    if (!FU.isZero(inv.tax_amount)) totals.push([t("fin.tax"), F.money(inv.tax_amount, inv.currency)]);
    totals.push(
      [t("fin.total"), F.money(inv.total_amount, inv.currency)],
      [t("fin.paid"), F.money(b.paid, inv.currency)],
      [t("fin.refunded"), F.money(b.refunded, inv.currency)],
      [t("fin.netPaid"), F.money(b.net_paid, inv.currency)],
      [t("fin.balance"), h("strong", null, F.money(inv.remaining_amount, inv.currency))]
    );
    parts.push(h("h3", { text: t("fin.inv.totals") }), A.kv(totals));

    // payments
    parts.push(h("h3", { text: t("fin.inv.payments") }));
    var payRows = I.payments.map(function (p) { return paymentRow(inv, p); });
    parts.push(A.table(
      [t("fin.receipt"), t("fin.date"), t("fin.method"), { label: t("fin.amount"), num: true }, { label: t("fin.refunded"), num: true }, { label: t("fin.netAmount"), num: true }, t("fin.reference"), t("fin.status"), t("common.actions")],
      payRows, { empty: t("fin.inv.noPayments"), caption: t("fin.inv.payments") }));

    // refunds
    parts.push(h("h3", { text: t("fin.inv.refunds") }));
    var receiptOf = {};
    I.payments.forEach(function (p) { receiptOf[String(p.id)] = p.receipt_number || "#" + p.id; });
    var refundRows = (inv.refunds || []).map(function (r) {
      return h("tr", null,
        h("td", null, V.fmtDateTime(r.created_at)),
        h("td", { text: receiptOf[String(r.payment_id)] || "#" + r.payment_id }),
        h("td", { class: "num" }, F.money(r.amount, inv.currency)),
        h("td", { text: r.reason }));
    });
    parts.push(A.table([t("fin.date"), t("fin.receipt"), { label: t("fin.amount"), num: true }, t("fin.reason")], refundRows, { empty: t("fin.inv.noRefunds"), caption: t("fin.inv.refunds") }));
    V.setContent($("#fin-inv-body"), parts);
  }

  function paymentRow(inv, p) {
    var me = role();
    var acts = h("div", { class: "btn-row" });
    var receipt = h("button", { type: "button", class: "btn secondary small", text: t("fin.pay.receipt") });
    receipt.addEventListener("click", function () { F.openDoc("/finance/payments/" + p.id + "/receipt?lang=" + V.getLang(), "receipt.html", receipt); });
    acts.appendChild(receipt);
    var net = FU.refundable(p);
    if (FU.canRefund(me) && !FU.isZero(net)) {
      var refund = h("button", { type: "button", class: "btn secondary small", text: t("fin.refund.button") });
      refund.addEventListener("click", function () { openRefund(inv, p, refund); });
      acts.appendChild(refund);
    }
    if (FU.canVoid(me) && FU.canVoidPayment(p) && inv.status !== "Void") {
      var vp = h("button", { type: "button", class: "btn danger small", text: t("fin.void.paymentButton") });
      vp.addEventListener("click", function () { openVoidPayment(inv, p, vp); });
      acts.appendChild(vp);
    }
    return h("tr", null,
      h("td", { text: p.receipt_number || "#" + p.id }),
      h("td", null, F.date(p.payment_date)),
      h("td", { text: t("fin.method." + p.payment_method) }),
      h("td", { class: "num" }, F.money(p.amount_paid, inv.currency)),
      h("td", { class: "num" }, F.money(p.refunded, inv.currency)),
      h("td", { class: "num" }, F.money(p.voided_at ? "0.00" : p.net_amount, inv.currency)),
      h("td", { text: p.reference || "—" }),
      h("td", null, p.voided_at ? h("span", { class: "badge bad", text: t("fin.pay.voided") }) : h("span", { class: "badge ok", text: t("fin.pay.valid") }),
        p.voided_at && p.void_reason ? h("div", { class: "small muted", text: p.void_reason }) : null),
      h("td", null, acts));
  }

  // ---------------------------------------------------------------- record payment
  function openPayment(inv, opener) {
    var key = FU.newIdempotencyKey(); // one key per dialog opening: a double click or a retry replays instead of posting twice
    var amount = h("input", { id: "fin-pay-amount", type: "text", attrs: { inputmode: "decimal", autocomplete: "off", dir: "ltr", maxlength: "13" } });
    var method = F.select("fin-pay-method", F.methodItems(), "cash");
    var date = h("input", { id: "fin-pay-date", type: "date" });
    var reference = h("input", { id: "fin-pay-reference", type: "text", attrs: { maxlength: String(FU.LIMITS.reference), autocomplete: "off" } });
    var notes = h("textarea", { id: "fin-pay-notes", attrs: { rows: "2", maxlength: String(FU.LIMITS.payNotes) } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: t("fin.pay.submit") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var m = F.modal(t("fin.pay.title", { number: inv.number || "#" + inv.id }), [
      h("p", { class: "small" }, t("fin.pay.remaining") + " ", F.money(inv.remaining_amount, inv.currency)),
      F.field("fin-pay-amount", t("fin.amount") + " (" + inv.currency + ")", amount, t("fin.pay.amountHint")),
      F.field("fin-pay-method", t("fin.method"), method),
      F.field("fin-pay-date", t("fin.pay.date"), date, t("fin.pay.dateHint")),
      F.field("fin-pay-reference", t("fin.reference"), reference),
      F.field("fin-pay-notes", t("fin.notes"), notes),
      h("p", { class: "small muted", text: t("fin.pay.recordOnly") }),
      err,
      h("div", { class: "btn-row" }, go, cancel),
    ]);
    var state = { sending: false };
    var fields = { amount: amount, method: method, payment_date: date, reference: reference, notes: notes };
    cancel.addEventListener("click", m.close);
    m.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      F.unflag(m.form);
      var built = FU.paymentPayload({ invoice_id: inv.id, amount: amount.value, method: method.value, payment_date: date.value, reference: reference.value, notes: notes.value }, key);
      if (!built.ok) return F.flag(fields[built.field], err, F.errText(built));
      F.submit(go, state, function () {
        return V.api("POST", "/finance/payments/v2", { body: built.payload }).then(function (out) {
          m.close();
          var number = out.payment && out.payment.receipt_number ? out.payment.receipt_number : "";
          var msg = out.replayed ? t("fin.pay.replayed", { number: number }) : t("fin.pay.done", { number: number });
          V.toast(msg, "ok");
          V.announce(msg);
          return refreshAfterChange(msg);
        });
      }).catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
    amount.focus();
  }

  // ---------------------------------------------------------------- void / refund
  function openVoidInvoice(inv, opener) {
    F.reasonDialog({
      title: t("fin.void.invoiceTitle", { number: inv.number || "#" + inv.id }),
      intro: t("fin.void.invoiceIntro"),
      submitLabel: t("fin.void.invoiceSubmit"),
      onSubmit: function (reason) {
        return V.api("POST", "/finance/invoices/" + inv.id + "/void", { body: { reason: reason } }).then(function () {
          V.toast(t("fin.void.invoiceDone"), "ok");
          return refreshAfterChange(t("fin.void.invoiceDone"));
        });
      },
    });
  }

  function openVoidPayment(inv, p, opener) {
    F.reasonDialog({
      title: t("fin.void.paymentTitle", { number: p.receipt_number || "#" + p.id }),
      intro: t("fin.void.paymentIntro"),
      submitLabel: t("fin.void.paymentSubmit"),
      onSubmit: function (reason) {
        return V.api("POST", "/finance/payments/" + p.id + "/void", { body: { reason: reason } }).then(function () {
          V.toast(t("fin.void.paymentDone"), "ok");
          return refreshAfterChange(t("fin.void.paymentDone"));
        });
      },
    });
  }

  function openRefund(inv, p, opener) {
    var amount = h("input", { id: "fin-rf-amount", type: "text", attrs: { inputmode: "decimal", autocomplete: "off", dir: "ltr", maxlength: "13" } });
    var reason = h("textarea", { id: "fin-rf-reason", attrs: { rows: "3", maxlength: String(FU.LIMITS.reason) } });
    var reopen = h("input", { id: "fin-rf-reopen", type: "checkbox" });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn danger", text: t("fin.refund.submit") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var m = F.modal(t("fin.refund.title", { number: p.receipt_number || "#" + p.id }), [
      h("p", { class: "small" }, t("fin.refund.refundable") + " ", F.money(FU.refundable(p), inv.currency)),
      F.field("fin-rf-amount", t("fin.amount") + " (" + inv.currency + ")", amount, t("fin.refund.amountHint")),
      F.field("fin-rf-reason", t("fin.reason"), reason, t("fin.reasonHint", { max: V.fmtNumber(FU.LIMITS.reason) })),
      h("div", { class: "field" }, h("div", { class: "check" }, reopen, h("label", { for: "fin-rf-reopen", text: t("fin.refund.reopen") })), h("span", { class: "hint", text: t("fin.refund.reopenHint") })),
      err,
      h("div", { class: "btn-row" }, go, cancel),
    ]);
    var state = { sending: false };
    var fields = { amount: amount, reason: reason };
    cancel.addEventListener("click", m.close);
    m.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      F.unflag(m.form);
      var built = FU.refundPayload({ amount: amount.value, reason: reason.value, reopen: reopen.checked });
      if (!built.ok) return F.flag(fields[built.field], err, F.errText(built));
      F.submit(go, state, function () {
        return V.api("POST", "/finance/payments/" + p.id + "/refund", { body: built.payload }).then(function () {
          m.close();
          V.toast(t("fin.refund.done"), "ok");
          V.announce(t("fin.refund.done"));
          return refreshAfterChange(t("fin.refund.done"));
        });
      }).catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
    amount.focus();
  }

  // ---------------------------------------------------------------- create invoice
  function openCreate(opener) {
    var picker = F.candidatePicker("fin-ci-cand", t("fin.candidate"));
    var currency = F.select("fin-ci-currency", F.currencyItems(false), "TND");
    var due = h("input", { id: "fin-ci-due", type: "date" });
    var notes = h("textarea", { id: "fin-ci-notes", attrs: { rows: "2", maxlength: String(FU.LIMITS.invoiceNotes) } });
    var linesBox = h("div", { class: "fin-lines" });
    var lines = [];
    var seq = 0;
    var svcList = [];
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: t("fin.ci.submit") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var addLine = h("button", { type: "button", class: "btn secondary small", id: "fin-ci-add", text: t("fin.ci.addLine") });

    function svcLabel(s) { return FU.serviceName(s, V.getLang()) + " — " + FU.formatMoney(s.default_price, s.currency); }
    function fillService(sel) {
      A.fillSelect(sel, [["", t("fin.ci.freeText")]].concat(svcList.map(function (s) { return [String(s.id), svcLabel(s)]; })), sel.value);
    }
    function priceHint(line) {
      var s = svcList.filter(function (x) { return String(x.id) === line.service.value; })[0];
      var text = "";
      if (s) text = s.currency === currency.value ? t("fin.ci.priceFromService", { price: FU.formatMoney(s.default_price, s.currency) }) : t("fin.ci.priceOtherCurrency", { currency: s.currency });
      V.setContent(line.hint, text);
    }
    function addRow() {
      seq += 1;
      var n = seq;
      var line = {
        n: n,
        service: h("select", { id: "fin-ci-" + n + "-service" }),
        description: h("input", { id: "fin-ci-" + n + "-description", type: "text", attrs: { maxlength: String(FU.LIMITS.description), autocomplete: "off" } }),
        quantity: h("input", { id: "fin-ci-" + n + "-quantity", type: "text", attrs: { inputmode: "decimal", autocomplete: "off", dir: "ltr", maxlength: "11" }, value: "1" }),
        price: h("input", { id: "fin-ci-" + n + "-price", type: "text", attrs: { inputmode: "decimal", autocomplete: "off", dir: "ltr", maxlength: "13" } }),
        hint: h("span", { class: "hint" }),
      };
      fillService(line.service);
      line.service.addEventListener("change", function () { priceHint(line); });
      var remove = h("button", { type: "button", class: "btn secondary small", text: t("common.remove") });
      line.el = h("div", { class: "fin-line" },
        F.field(line.service.id, t("fin.ci.service"), line.service),
        F.field(line.description.id, t("fin.description"), line.description, t("fin.ci.descriptionHint")),
        F.field(line.quantity.id, t("fin.quantity"), line.quantity),
        F.field(line.price.id, t("fin.unitPrice"), line.price),
        line.hint,
        h("div", { class: "field" }, remove)
      );
      remove.addEventListener("click", function () {
        if (lines.length <= 1) return;
        lines.splice(lines.indexOf(line), 1);
        line.el.remove();
        addLine.disabled = false;
      });
      lines.push(line);
      linesBox.appendChild(line.el);
      if (lines.length >= FU.LIMITS.items) addLine.disabled = true;
      return line;
    }
    addLine.addEventListener("click", function () { var l = addRow(); l.service.focus(); });
    currency.addEventListener("change", function () { lines.forEach(priceHint); });

    var m = F.modal(t("fin.ci.title"), [
      h("p", { class: "small muted", text: t("fin.ci.intro") }),
      picker.el,
      F.field("fin-ci-currency", t("fin.currency"), currency),
      F.field("fin-ci-due", t("fin.dueDate"), due, t("fin.ci.dueHint")),
      h("h3", { text: t("fin.ci.lines") }),
      linesBox,
      h("div", { class: "btn-row" }, addLine),
      F.field("fin-ci-notes", t("fin.notes"), notes),
      h("p", { class: "notice info small", text: t("fin.ci.serverTotals") }),
      err,
      h("div", { class: "btn-row" }, go, cancel),
    ], { wide: true });
    var state = { sending: false };
    cancel.addEventListener("click", m.close);
    addRow();
    F.services().then(function (list) { svcList = list; lines.forEach(function (l) { fillService(l.service); priceHint(l); }); });

    m.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      F.unflag(m.form);
      var built = FU.invoicePayload({
        candidate_id: picker.id(), currency: currency.value, due_date: due.value, notes: notes.value,
        lines: lines.map(function (l) { return { service_id: l.service.value, description: l.description.value, quantity: l.quantity.value, unit_price: l.price.value }; }),
      }, svcList);
      if (!built.ok) {
        var line = built.line !== undefined ? lines[built.line] : null;
        var target = { candidate: picker.input, currency: currency, due_date: due, notes: notes, lines: addLine }[built.field];
        if (line) target = { service: line.service, description: line.description, quantity: line.quantity, unit_price: line.price }[built.field];
        return F.flag(target, err, F.errText(built));
      }
      F.submit(go, state, function () {
        return V.api("POST", "/finance/invoices/v2", { body: built.payload }).then(function (inv) {
          m.close();
          var msg = t("fin.ci.done", { number: inv.number || "#" + inv.id });
          V.toast(msg, "ok");
          V.announce(msg);
          I.page = 1;
          loadList();
          return openInvoice(inv.id, true);
        });
      }).catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
    picker.input.focus();
  }

  // ---------------------------------------------------------------- wiring
  F.register("invoices", {
    init: function () {
      buildAll();
      V.onLang(function () {
        if (!F.ready) return;
        // keep what the person typed into the filters across a language switch
        var s = $("#fin-if-status");
        if (s) I.filters = { status: s.value, currency: $("#fin-if-currency").value, candidate_id: I.picker ? I.picker.id() : "", from: $("#fin-if-from").value, to: $("#fin-if-to").value, overdue: $("#fin-if-overdue").checked, q: $("#fin-if-q").value };
        buildAll();
      });
    },
    load: function () { return loadList(); },
  });
})();
