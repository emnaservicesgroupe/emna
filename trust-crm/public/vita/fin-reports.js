/* Accounting > Reports: per-currency summary, receivables ageing, by service, by staff, candidate statement and CSV
   export. Every number is computed by the API in SQL and shown as the decimal string it returned, per currency (no
   conversion, no client-side totals). CSV files are fetched with the bearer token and saved from a blob. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var F = window.VITA_FIN;
  var FU = window.VITA_FIN_UTIL;
  var t = V.t, h = V.h, $ = V.$;

  var R = { from: "", to: "", asOf: "", recvPage: 1, recvTotal: 0, data: {}, statementId: "", statement: null, exportMsg: null, picker: null };
  var RECV_PAGE = 25;

  function role() { return F.role(); }

  function card(id, title, extra) {
    return h("div", { class: "card", id: id }, h("div", { class: "card-head" }, h("h3", { text: title }), h("span", { class: "spacer" }), extra || null), h("div", { id: id + "-body" }));
  }
  function body(id) { return $("#" + id + "-body"); }
  function kindName(kind) { return t("fin.kind." + kind); }

  function build() {
    if (!R.from && !R.to) {
      var d = FU.defaultRange();
      R.from = d.from;
      R.to = d.to;
    }
    var from = h("input", { id: "fin-rf-from", type: "date", value: R.from });
    var to = h("input", { id: "fin-rf-to", type: "date", value: R.to });
    var run = h("button", { type: "submit", class: "btn", id: "fin-rep-run", text: t("fin.rep.run") });
    var form = h("form", { class: "filters", attrs: { novalidate: "" } }, F.field("fin-rf-from", t("fin.from"), from), F.field("fin-rf-to", t("fin.to"), to), h("div", { class: "field btn-row" }, run));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      R.from = from.value;
      R.to = to.value;
      loadRange();
    });

    var asOf = h("input", { id: "fin-rf-asof", type: "date", value: R.asOf });
    var asOfBtn = h("button", { type: "button", class: "btn secondary small", id: "fin-recv-run", text: t("fin.rep.run") });
    asOfBtn.addEventListener("click", function () { R.asOf = asOf.value; R.recvPage = 1; loadReceivables(); });
    var recvExtra = h("div", { class: "btn-row" }, h("label", { for: "fin-rf-asof", class: "small", text: t("fin.rep.asOf") }), asOf, asOfBtn);

    R.picker = F.candidatePicker("fin-st-cand", t("fin.candidate"));
    R.picker.set(R.statementId);
    var stBtn = h("button", { type: "button", class: "btn", id: "fin-st-run", text: t("fin.rep.statementRun") });
    var stErr = h("p", { class: "form-error", attrs: { role: "alert" } });
    stBtn.addEventListener("click", function () {
      stErr.textContent = "";
      var id = FU.parseId(R.picker.id());
      if (id === null) return F.flag(R.picker.input, stErr, t("fin.err.candidate"));
      R.picker.input.removeAttribute("aria-invalid");
      R.statementId = String(id);
      loadStatement();
    });

    var kids = [
      h("div", { class: "card" }, h("h2", { text: t("fin.reports.title") }), h("p", { class: "notice info small", text: t("fin.reports.hint") }), form),
      card("fin-rep-summary", t("fin.rep.summary")),
      card("fin-rep-recv", t("fin.rep.receivables"), recvExtra),
      card("fin-rep-service", t("fin.rep.byService")),
      card("fin-rep-staff", t("fin.rep.byStaff")),
      h("div", { class: "card", id: "fin-rep-statement" }, h("h3", { text: t("fin.rep.statement") }), R.picker.el, h("div", { class: "btn-row" }, stBtn), stErr, h("div", { id: "fin-rep-statement-body" })),
    ];
    if (FU.canExport(role())) kids.push(exportCard());
    V.setContent($("#fin-sec-reports"), kids);
    renderAll();
  }

  // ---------------------------------------------------------------- loading
  function rangeQs() { return FU.rangeQuery(R.from, R.to); }

  function loadRange() {
    ["fin-rep-summary", "fin-rep-service", "fin-rep-staff"].forEach(function (id) { V.setContent(body(id), V.loading()); });
    var qs = rangeQs();
    var calls = [
      ["summary", function () { return V.api("GET", "/finance/reports/summary" + qs); }],
      ["byService", function () { return V.api("GET", "/finance/reports/by-service" + qs); }],
      ["byStaff", function () { return V.api("GET", "/finance/reports/by-staff" + qs); }],
    ];
    return Promise.all(calls.map(function (c) {
      return c[1]().then(function (d) { R.data[c[0]] = d; }).catch(function (err) { R.data[c[0]] = { error: err }; });
    })).then(renderAll);
  }

  function loadReceivables() {
    V.setContent(body("fin-rep-recv"), V.loading());
    var parts = ["limit=" + RECV_PAGE, "offset=" + (R.recvPage - 1) * RECV_PAGE];
    if (R.asOf && FU.validDate(R.asOf)) parts.unshift("asOf=" + R.asOf);
    return V.api("GET", "/finance/reports/receivables?" + parts.join("&"))
      .then(function (d) { R.data.receivables = d; R.recvTotal = d.total || 0; renderReceivables(); })
      .catch(function (err) { R.data.receivables = { error: err }; renderReceivables(); });
  }

  function loadStatement() {
    var box = $("#fin-rep-statement-body");
    V.setContent(box, V.loading());
    return V.api("GET", "/finance/reports/candidate/" + R.statementId)
      .then(function (d) { R.statement = d; renderStatement(); })
      .catch(function (err) { R.statement = { error: err }; renderStatement(); });
  }

  function load() {
    if (!R.data.summary) loadRange();
    loadReceivables();
  }

  // ---------------------------------------------------------------- rendering
  function money(v, cur) { return h("td", { class: "num" }, F.money(v, cur)); }

  function renderAll() {
    renderSummary();
    renderReceivables();
    renderByService();
    renderByStaff();
    renderStatement();
  }

  function failed(id, d) {
    if (d && d.error) { V.setContent(body(id), A.errorBox(d.error)); return true; }
    return false;
  }

  function renderSummary() {
    var box = body("fin-rep-summary");
    if (!box) return;
    var d = R.data.summary;
    if (!d) return V.setContent(box, V.empty(t("fin.rep.notRun")));
    if (failed("fin-rep-summary", d)) return;
    var rows = d.rows.map(function (r) {
      return h("tr", null, h("td", null, h("strong", { text: r.currency })), money(r.invoiced, r.currency), money(r.collected, r.currency), money(r.refunded, r.currency), money(r.expenses, r.currency), money(r.net, r.currency));
    });
    V.setContent(box,
      h("p", { class: "small muted", text: t("fin.rep.period", { from: d.from || "—", to: d.to || "—" }) }),
      A.table([t("fin.currency"), { label: t("fin.rep.invoiced"), num: true }, { label: t("fin.rep.collected"), num: true }, { label: t("fin.refunded"), num: true }, { label: t("fin.rep.expenses"), num: true }, { label: t("fin.rep.net"), num: true }], rows, { empty: t("fin.rep.none"), caption: t("fin.rep.summary") }),
      h("p", { class: "small muted", text: t("fin.rep.perCurrency") }));
  }

  function renderReceivables() {
    var box = body("fin-rep-recv");
    if (!box) return;
    var d = R.data.receivables;
    if (!d) return V.setContent(box, V.empty(t("fin.rep.notRun")));
    if (failed("fin-rep-recv", d)) return;
    var head = [t("fin.currency"), { label: t("fin.rep.openTotal"), num: true }].concat(FU.BUCKETS.map(function (b) { return { label: t("fin.bucket." + b), num: true }; }));
    var rows = d.currencies.map(function (c) {
      return h("tr", null, h("td", null, h("strong", { text: c.currency }), h("div", { class: "small muted", text: t("fin.rep.invoiceCount", { n: c.count }) })), money(c.total, c.currency),
        FU.BUCKETS.map(function (b) { return money(c.buckets[b], c.currency); }));
    });
    var cand = d.rows.map(function (r) {
      var open = h("button", { type: "button", class: "btn secondary small", text: t("fin.rep.statementOpen") });
      open.addEventListener("click", function () {
        R.statementId = String(r.candidate_id);
        R.picker.set(r.candidate_id, r.candidate_name);
        loadStatement().then(function () { $("#fin-rep-statement").scrollIntoView({ block: "start" }); });
      });
      return h("tr", null, h("td", null, h("strong", { text: r.candidate_name }), h("div", { class: "small muted", text: "#" + r.candidate_id })), h("td", { text: r.currency }),
        money(r.balance, r.currency), h("td", { text: String(r.invoices) }), h("td", null, F.date(r.oldest_due_date)), h("td", null, open));
    });
    V.setContent(box,
      h("p", { class: "small muted", text: t("fin.rep.asOfDate", { date: d.asOf }) }),
      A.table(head, rows, { empty: t("fin.rep.noReceivables"), caption: t("fin.rep.receivables") }),
      h("h4", { text: t("fin.rep.byCandidate") }),
      A.table([t("fin.candidate"), t("fin.currency"), { label: t("fin.balance"), num: true }, t("fin.rep.invoices"), t("fin.rep.oldestDue"), t("common.actions")], cand, { empty: t("fin.rep.noReceivables"), caption: t("fin.rep.byCandidate") }),
      h("div", { class: "pager", id: "fin-recv-pager" }));
    F.renderPager($("#fin-recv-pager"), R.recvPage, Math.max(1, Math.ceil(R.recvTotal / RECV_PAGE)), function (p) { R.recvPage = p; loadReceivables(); });
  }

  function renderByService() {
    var box = body("fin-rep-service");
    if (!box) return;
    var d = R.data.byService;
    if (!d) return V.setContent(box, V.empty(t("fin.rep.notRun")));
    if (failed("fin-rep-service", d)) return;
    var rows = d.rows.map(function (r) {
      var label = r.service_id ? FU.serviceName(r, V.getLang()) : r.label;
      return h("tr", null, h("td", { text: r.currency }), h("td", null, h("strong", { text: label }), r.code ? h("div", { class: "small muted ltr-island", text: r.code }) : h("div", { class: "small muted", text: t("fin.rep.freeText") })),
        h("td", { text: String(r.lines) }), h("td", { class: "num" }, h("span", { class: "ltr-island", text: FU.formatMoney(r.quantity) })), money(r.total, r.currency));
    });
    V.setContent(box, A.table([t("fin.currency"), t("fin.rep.service"), t("fin.rep.lines"), { label: t("fin.quantity"), num: true }, { label: t("fin.total"), num: true }], rows, { empty: t("fin.rep.none"), caption: t("fin.rep.byService") }));
  }

  function renderByStaff() {
    var box = body("fin-rep-staff");
    if (!box) return;
    var d = R.data.byStaff;
    if (!d) return V.setContent(box, V.empty(t("fin.rep.notRun")));
    if (failed("fin-rep-staff", d)) return;
    var rows = d.rows.map(function (r) {
      return h("tr", null, h("td", { text: r.user_name || (r.user_id ? "#" + r.user_id : "—") }), h("td", { text: r.currency }),
        h("td", { text: String(r.invoices_count) }), money(r.invoices_total, r.currency), h("td", { text: String(r.payments_count) }), money(r.payments_total, r.currency));
    });
    V.setContent(box, A.table([t("fin.rep.staff"), t("fin.currency"), t("fin.rep.invoices"), { label: t("fin.rep.invoiced"), num: true }, t("fin.rep.payments"), { label: t("fin.rep.collected"), num: true }], rows, { empty: t("fin.rep.none"), caption: t("fin.rep.byStaff") }));
  }

  function renderStatement() {
    var box = $("#fin-rep-statement-body");
    if (!box) return;
    var d = R.statement;
    if (!d) return V.clear(box);
    if (d.error) return V.setContent(box, A.errorBox(d.error));
    var rows = d.entries.map(function (e) {
      return h("tr", null, h("td", null, F.date(e.date)), h("td", { text: kindName(e.kind) }), h("td", { text: e.ref }), h("td", { text: e.currency }),
        money(e.debit, e.currency), money(e.credit, e.currency), money(e.balance, e.currency));
    });
    var bal = d.balances.map(function (b) {
      return h("tr", null, h("td", { text: b.currency }), money(b.balance, b.currency), money(b.open, b.currency));
    });
    V.setContent(box,
      h("h4", { text: t("fin.rep.statementFor", { name: d.candidate.full_name, id: d.candidate.id }) }),
      A.table([t("fin.currency"), { label: t("fin.rep.ledgerBalance"), num: true }, { label: t("fin.rep.openInvoices"), num: true }], bal, { empty: t("fin.rep.none"), caption: t("fin.rep.statement") }),
      A.table([t("fin.date"), t("fin.rep.kind"), t("fin.rep.ref"), t("fin.currency"), { label: t("fin.rep.debit"), num: true }, { label: t("fin.rep.credit"), num: true }, { label: t("fin.rep.runningBalance"), num: true }], rows, { empty: t("fin.rep.none"), caption: t("fin.rep.statement") }),
      h("p", { class: "small muted", text: t("fin.rep.statementNote") }));
  }

  // ---------------------------------------------------------------- CSV export
  function exportCard() {
    var status = h("p", { class: "small", id: "fin-export-status", attrs: { "aria-live": "polite" } });
    if (R.exportMsg) status.textContent = R.exportMsg;
    var buttons = FU.EXPORT_KINDS.map(function (kind) {
      var b = h("button", { type: "button", class: "btn secondary", id: "fin-export-" + kind, text: t("fin.export." + kind) });
      b.addEventListener("click", function () {
        status.textContent = "";
        V.busy(b, function () {
          return V.download("/finance/export/" + kind + ".csv" + rangeQs(), kind + ".csv").then(function (r) {
            R.exportMsg = t(r.truncated ? "fin.export.cut" : "fin.export.done", { name: r.name, size: V.fmtNumber(r.size) });
            status.textContent = R.exportMsg;
            V.announce(R.exportMsg);
          });
        }).catch(function () {});
      });
      return b;
    });
    return h("div", { class: "card", id: "fin-export-card" }, h("h3", { text: t("fin.export.title") }), h("p", { class: "small muted", text: t("fin.export.hint") }), h("div", { class: "btn-row" }, buttons), status);
  }

  F.register("reports", {
    init: function () {
      build();
      V.onLang(function () {
        var f = $("#fin-rf-from");
        if (f) { R.from = f.value; R.to = $("#fin-rf-to").value; R.asOf = $("#fin-rf-asof").value; if (R.picker) R.statementId = R.picker.id(); }
        build();
      });
    },
    load: load,
  });
})();
