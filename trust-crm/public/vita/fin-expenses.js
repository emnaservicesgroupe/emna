/* Accounting > Expenses: list with filters, record an expense (finance:write), void one with a reason (finance:void),
   and the expense categories (add / deactivate, finance:write). Amounts are decimal strings; nothing is summed here. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var F = window.VITA_FIN;
  var FU = window.VITA_FIN_UTIL;
  var t = V.t, h = V.h, $ = V.$;

  var X = { filters: { category_id: "", currency: "", from: "", to: "", include_voided: false }, page: 1, total: 0, rows: [], loaded: false, categories: [], catLoaded: false };

  function role() { return F.role(); }

  function loadCategories() {
    return V.api("GET", "/finance/expense-categories")
      .then(function (d) { X.categories = (d && d.rows) || []; X.catLoaded = true; })
      .catch(function () { X.categories = []; });
  }

  function build() {
    var f = X.filters;
    var category = F.select("fin-xf-category", [["", t("fin.exp.anyCategory")]].concat(X.categories.map(function (c) { return [String(c.id), c.name + (c.active ? "" : " (" + t("fin.svc.inactive") + ")")]; })), f.category_id);
    var currency = F.select("fin-xf-currency", F.currencyItems(true), f.currency);
    var from = h("input", { id: "fin-xf-from", type: "date", value: f.from });
    var to = h("input", { id: "fin-xf-to", type: "date", value: f.to });
    var voided = h("input", { id: "fin-xf-voided", type: "checkbox", checked: f.include_voided });
    var form = h("form", { class: "filters", attrs: { novalidate: "" } },
      F.field("fin-xf-category", t("fin.exp.category"), category),
      F.field("fin-xf-currency", t("fin.currency"), currency),
      F.field("fin-xf-from", t("fin.from"), from),
      F.field("fin-xf-to", t("fin.to"), to),
      h("div", { class: "field" }, h("div", { class: "check" }, voided, h("label", { for: "fin-xf-voided", text: t("fin.exp.includeVoided") }))),
      h("div", { class: "field btn-row" },
        h("button", { type: "submit", class: "btn", text: t("filter.apply") }),
        h("button", { type: "reset", class: "btn secondary", text: t("filter.reset") }))
    );
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      X.filters = { category_id: category.value, currency: currency.value, from: from.value, to: to.value, include_voided: voided.checked };
      X.page = 1;
      loadList();
    });
    form.addEventListener("reset", function () {
      window.setTimeout(function () { X.filters = { category_id: "", currency: "", from: "", to: "", include_voided: false }; X.page = 1; build(); loadList(); }, 0);
    });
    var add = h("button", { type: "button", class: "btn small", id: "fin-exp-new", text: t("fin.exp.new") });
    add.addEventListener("click", function () { openCreate(add); });
    var refresh = h("button", { type: "button", class: "btn secondary small", id: "fin-exp-refresh", text: t("common.refresh") });
    refresh.addEventListener("click", function () { loadList(); });
    V.setContent($("#fin-sec-expenses"),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: t("fin.exp.title") }), h("span", { class: "spacer" }), FU.canWrite(role()) ? add : null, refresh),
        form),
      h("div", { class: "card" },
        h("p", { class: "small muted", id: "fin-exp-summary", attrs: { "aria-live": "polite" } }),
        h("div", { id: "fin-exp-table" }),
        h("div", { class: "pager", id: "fin-exp-pager" })),
      h("div", { class: "card", id: "fin-cat-card" })
    );
    if (X.loaded) renderList();
    renderCategories();
  }

  function loadList() {
    var table = $("#fin-exp-table");
    if (!X.loaded) V.setContent(table, V.loading());
    return Promise.all([V.api("GET", "/finance/expenses" + FU.expenseQuery(X.filters, X.page, F.PAGE_SIZE)), X.catLoaded ? null : loadCategories()])
      .then(function (res) {
        var d = res[0];
        X.loaded = true;
        X.rows = d.rows || [];
        X.total = d.total || 0;
        var pages = Math.max(1, Math.ceil(X.total / F.PAGE_SIZE));
        if (X.page > pages) { X.page = pages; return loadList(); }
        if (res[1] !== null) build(); else renderList();
      })
      .catch(function (err) { V.setContent($("#fin-exp-table"), A.errorBox(err)); V.setContent($("#fin-exp-summary")); V.clear($("#fin-exp-pager")); });
  }

  function renderList() {
    V.setContent($("#fin-exp-summary"), t("fin.exp.count", { n: V.fmtNumber(X.total) }));
    var canVoid = FU.canVoid(role());
    var trs = X.rows.map(function (r) {
      var acts = h("div", { class: "btn-row" });
      if (canVoid && !r.voided_at) {
        var vb = h("button", { type: "button", class: "btn danger small", text: t("fin.exp.void") });
        vb.addEventListener("click", function () { voidExpense(r); });
        acts.appendChild(vb);
      }
      return h("tr", null,
        h("td", null, F.date(r.spent_on)),
        h("td", null, h("strong", { text: r.title }), r.notes ? h("div", { class: "small muted", text: r.notes }) : null),
        h("td", { text: r.category_name || "—" }),
        h("td", { text: r.payee || "—" }),
        h("td", { class: "num" }, F.money(r.amount, r.currency)),
        h("td", null, r.voided_at ? h("span", { class: "badge bad", text: t("fin.pay.voided") }) : h("span", { class: "badge ok", text: t("fin.pay.valid") }),
          r.voided_at && r.void_reason ? h("div", { class: "small muted", text: r.void_reason }) : null),
        h("td", null, acts));
    });
    V.setContent($("#fin-exp-table"), A.table(
      [t("fin.date"), t("fin.exp.titleCol"), t("fin.exp.category"), t("fin.exp.payee"), { label: t("fin.amount"), num: true }, t("fin.status"), t("common.actions")],
      trs, { empty: t("fin.exp.none"), caption: t("fin.exp.title") }));
    F.renderPager($("#fin-exp-pager"), X.page, Math.max(1, Math.ceil(X.total / F.PAGE_SIZE)), function (p) { X.page = p; loadList(); });
  }

  function voidExpense(r) {
    F.reasonDialog({
      title: t("fin.exp.voidTitle", { title: r.title }),
      intro: t("fin.exp.voidIntro"),
      submitLabel: t("fin.exp.voidSubmit"),
      onSubmit: function (reason) {
        return V.api("POST", "/finance/expenses/" + r.id + "/void", { body: { reason: reason } }).then(function () {
          V.toast(t("fin.exp.voided"), "ok");
          return loadList();
        });
      },
    });
  }

  function openCreate(opener) {
    var title = h("input", { id: "fin-xe-title", type: "text", attrs: { maxlength: String(FU.LIMITS.title), autocomplete: "off" } });
    var amount = h("input", { id: "fin-xe-amount", type: "text", attrs: { inputmode: "decimal", autocomplete: "off", dir: "ltr", maxlength: "13" } });
    var currency = F.select("fin-xe-currency", F.currencyItems(false), "TND");
    var spent = h("input", { id: "fin-xe-spent", type: "date", value: FU.defaultRange().to });
    var category = F.select("fin-xe-category", [["", t("fin.exp.noCategory")]].concat(X.categories.filter(function (c) { return c.active; }).map(function (c) { return [String(c.id), c.name]; })), "");
    var payee = h("input", { id: "fin-xe-payee", type: "text", attrs: { maxlength: String(FU.LIMITS.payee), autocomplete: "off" } });
    var notes = h("textarea", { id: "fin-xe-notes", attrs: { rows: "2", maxlength: String(FU.LIMITS.expenseNotes) } });
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: t("fin.exp.create") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var m = F.modal(t("fin.exp.newTitle"), [
      F.field("fin-xe-title", t("fin.exp.titleCol"), title),
      F.field("fin-xe-amount", t("fin.amount"), amount, t("fin.pay.amountHint")),
      F.field("fin-xe-currency", t("fin.currency"), currency),
      F.field("fin-xe-spent", t("fin.exp.spentOn"), spent),
      F.field("fin-xe-category", t("fin.exp.category"), category),
      F.field("fin-xe-payee", t("fin.exp.payee"), payee),
      F.field("fin-xe-notes", t("fin.notes"), notes),
      err,
      h("div", { class: "btn-row" }, go, cancel),
    ]);
    var state = { sending: false };
    var fields = { title: title, amount: amount, currency: currency, spent_on: spent, category: category, payee: payee, notes: notes };
    cancel.addEventListener("click", m.close);
    m.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      F.unflag(m.form);
      var built = FU.expensePayload({ title: title.value, amount: amount.value, currency: currency.value, spent_on: spent.value, category_id: category.value, payee: payee.value, notes: notes.value });
      if (!built.ok) return F.flag(fields[built.field], err, F.errText(built));
      F.submit(go, state, function () {
        return V.api("POST", "/finance/expenses", { body: built.payload }).then(function () {
          m.close();
          V.toast(t("fin.exp.created"), "ok");
          X.page = 1;
          return loadList();
        });
      }).catch(function (e2) { err.textContent = V.errorMessage(e2); });
    });
    title.focus();
  }

  // ---------------------------------------------------------------- categories
  function renderCategories() {
    var box = $("#fin-cat-card");
    if (!box) return;
    var canWrite = FU.canWrite(role());
    var parts = [h("h3", { text: t("fin.cat.title") })];
    var rows = X.categories.map(function (c) {
      var acts = h("div", { class: "btn-row" });
      if (canWrite) {
        var toggle = h("button", { type: "button", class: "btn secondary small", text: c.active ? t("fin.svc.deactivate") : t("fin.svc.activate") });
        toggle.addEventListener("click", function () {
          V.busy(toggle, function () {
            return V.api("PATCH", "/finance/expense-categories/" + c.id, { body: { active: !c.active } }).then(function () { return loadCategories().then(build); });
          }).catch(function () {});
        });
        acts.appendChild(toggle);
      }
      return h("tr", null, h("td", { text: c.name }), h("td", null, h("span", { class: "badge " + (c.active ? "ok" : "neutral"), text: c.active ? t("fin.svc.active") : t("fin.svc.inactive") })), h("td", null, acts));
    });
    parts.push(A.table([t("fin.cat.name"), t("fin.status"), t("common.actions")], rows, { empty: t("fin.cat.none"), caption: t("fin.cat.title") }));
    if (canWrite) {
      var name = h("input", { id: "fin-cat-name", type: "text", attrs: { maxlength: String(FU.LIMITS.category), autocomplete: "off" } });
      var err = h("p", { class: "form-error", attrs: { role: "alert" } });
      var add = h("button", { type: "submit", class: "btn small", text: t("fin.cat.add") });
      var form = h("form", { attrs: { novalidate: "" } }, F.field("fin-cat-name", t("fin.cat.name"), name), err, h("div", { class: "btn-row" }, add));
      var state = { sending: false };
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        err.textContent = "";
        name.removeAttribute("aria-invalid");
        var built = FU.categoryPayload(name.value);
        if (!built.ok) return F.flag(name, err, t("fin.err.name"));
        F.submit(add, state, function () {
          return V.api("POST", "/finance/expense-categories", { body: built.payload }).then(function () {
            V.toast(t("fin.cat.created"), "ok");
            return loadCategories().then(build);
          });
        }).catch(function (e2) { state.sending = false; err.textContent = e2 && e2.status === 409 ? t("fin.cat.duplicate") : V.errorMessage(e2); });
      });
      parts.push(form);
    }
    V.setContent(box, parts);
  }

  F.register("expenses", {
    init: function () {
      build();
      V.onLang(function () {
        var c = $("#fin-xf-category");
        if (c) X.filters = { category_id: c.value, currency: $("#fin-xf-currency").value, from: $("#fin-xf-from").value, to: $("#fin-xf-to").value, include_voided: $("#fin-xf-voided").checked };
        build();
      });
    },
    load: function () { return X.catLoaded ? loadList() : loadCategories().then(function () { build(); return loadList(); }); },
  });
})();
