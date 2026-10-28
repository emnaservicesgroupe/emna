/* Accounting > Services: the priced service catalogue invoices are built from. Create / edit need finance:write.
   Services are deactivated, never deleted (old invoice lines keep pointing at them). Prices are decimal strings. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var F = window.VITA_FIN;
  var FU = window.VITA_FIN_UTIL;
  var t = V.t, h = V.h, $ = V.$;

  var S = { filters: { q: "", active: "" }, rows: [], loaded: false };

  function canWrite() { return FU.canWrite(F.role()); }

  function build() {
    var f = S.filters;
    var q = h("input", { id: "fin-sf-q", type: "search", attrs: { maxlength: "100", autocomplete: "off" }, value: f.q });
    var active = F.select("fin-sf-active", [["", t("fin.svc.any")], ["true", t("fin.svc.activeOnly")], ["false", t("fin.svc.inactiveOnly")]], f.active);
    var form = h("form", { class: "filters", attrs: { novalidate: "" } },
      F.field("fin-sf-q", t("fin.svc.search"), q),
      F.field("fin-sf-active", t("fin.status"), active),
      h("div", { class: "field btn-row" },
        h("button", { type: "submit", class: "btn", text: t("filter.apply") }),
        h("button", { type: "reset", class: "btn secondary", text: t("filter.reset") }))
    );
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      S.filters = { q: q.value, active: active.value };
      load();
    });
    form.addEventListener("reset", function () {
      window.setTimeout(function () { S.filters = { q: "", active: "" }; build(); load(); }, 0);
    });
    var add = h("button", { type: "button", class: "btn small", id: "fin-svc-new", text: t("fin.svc.new") });
    add.addEventListener("click", function () { openForm(null, add); });
    var refresh = h("button", { type: "button", class: "btn secondary small", id: "fin-svc-refresh", text: t("common.refresh") });
    refresh.addEventListener("click", load);
    V.setContent($("#fin-sec-services"),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: t("fin.svc.title") }), h("span", { class: "spacer" }), canWrite() ? add : null, refresh),
        h("p", { class: "notice info small", text: t("fin.svc.hint") }),
        form),
      h("div", { class: "card" }, h("p", { class: "small muted", id: "fin-svc-summary", attrs: { "aria-live": "polite" } }), h("div", { id: "fin-svc-table" }))
    );
    if (S.loaded) render();
  }

  function load() {
    var table = $("#fin-svc-table");
    if (!S.loaded) V.setContent(table, V.loading());
    var parts = [];
    if (S.filters.active) parts.push("active=" + S.filters.active);
    var q = S.filters.q.trim().slice(0, 100);
    if (q) parts.push("q=" + encodeURIComponent(q));
    return V.api("GET", "/finance/services" + (parts.length ? "?" + parts.join("&") : ""))
      .then(function (d) {
        S.loaded = true;
        S.rows = d.rows || [];
        F.invalidateServices();
        render();
      })
      .catch(function (err) { V.setContent($("#fin-svc-table"), A.errorBox(err)); });
  }

  function render() {
    V.setContent($("#fin-svc-summary"), t("fin.svc.count", { n: V.fmtNumber(S.rows.length) }));
    var trs = S.rows.map(function (s) {
      var acts = h("div", { class: "btn-row" });
      if (canWrite()) {
        var edit = h("button", { type: "button", class: "btn secondary small", text: t("fin.svc.edit") });
        edit.addEventListener("click", function () { openForm(s, edit); });
        var toggle = h("button", { type: "button", class: "btn secondary small", text: s.active ? t("fin.svc.deactivate") : t("fin.svc.activate") });
        toggle.addEventListener("click", function () {
          V.busy(toggle, function () {
            return V.api("PATCH", "/finance/services/" + s.id, { body: { active: !s.active } }).then(function () {
              V.toast(s.active ? t("fin.svc.deactivated") : t("fin.svc.activated"), "ok");
              return load();
            });
          }).catch(function () {});
        });
        acts.appendChild(edit);
        acts.appendChild(toggle);
      }
      return h("tr", null,
        h("td", null, h("strong", { class: "ltr-island", text: s.code })),
        h("td", { text: s.name_ar || "—", attrs: { lang: "ar", dir: "rtl" } }),
        h("td", { text: s.name_en || "—" }),
        h("td", { text: s.name_fr || "—" }),
        h("td", { class: "num" }, F.money(s.default_price, s.currency)),
        h("td", null, h("span", { class: "badge " + (s.active ? "ok" : "neutral"), text: s.active ? t("fin.svc.active") : t("fin.svc.inactive") })),
        h("td", null, acts));
    });
    V.setContent($("#fin-svc-table"), A.table(
      [t("fin.svc.code"), t("fin.svc.nameAr"), t("fin.svc.nameEn"), t("fin.svc.nameFr"), { label: t("fin.svc.price"), num: true }, t("fin.status"), t("common.actions")],
      trs, { empty: t("fin.svc.none"), caption: t("fin.svc.title") }));
  }

  /** Create (svc === null) or edit dialog. The code cannot be changed after creation. */
  function openForm(svc, opener) {
    var creating = svc === null;
    var code = h("input", { id: "fin-sv-code", type: "text", attrs: { maxlength: "30", autocomplete: "off", dir: "ltr" }, value: creating ? "" : svc.code, disabled: !creating });
    var nameAr = h("input", { id: "fin-sv-ar", type: "text", attrs: { maxlength: String(FU.LIMITS.name), autocomplete: "off", dir: "rtl", lang: "ar" }, value: creating ? "" : svc.name_ar || "" });
    var nameEn = h("input", { id: "fin-sv-en", type: "text", attrs: { maxlength: String(FU.LIMITS.name), autocomplete: "off" }, value: creating ? "" : svc.name_en || "" });
    var nameFr = h("input", { id: "fin-sv-fr", type: "text", attrs: { maxlength: String(FU.LIMITS.name), autocomplete: "off" }, value: creating ? "" : svc.name_fr || "" });
    var price = h("input", { id: "fin-sv-price", type: "text", attrs: { inputmode: "decimal", autocomplete: "off", dir: "ltr", maxlength: "13" }, value: creating ? "0.00" : svc.default_price });
    var currency = F.select("fin-sv-currency", F.currencyItems(false), creating ? "TND" : svc.currency);
    var err = h("p", { class: "form-error", attrs: { role: "alert" } });
    var go = h("button", { type: "submit", class: "btn", text: creating ? t("fin.svc.create") : t("common.save") });
    var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
    var m = F.modal(creating ? t("fin.svc.newTitle") : t("fin.svc.editTitle", { code: svc.code }), [
      F.field("fin-sv-code", t("fin.svc.code"), code, t("fin.svc.codeHint")),
      F.field("fin-sv-ar", t("fin.svc.nameAr"), nameAr),
      F.field("fin-sv-en", t("fin.svc.nameEn"), nameEn),
      F.field("fin-sv-fr", t("fin.svc.nameFr"), nameFr, t("fin.svc.namesHint")),
      F.field("fin-sv-price", t("fin.svc.price"), price, t("fin.svc.priceHint")),
      F.field("fin-sv-currency", t("fin.currency"), currency),
      err,
      h("div", { class: "btn-row" }, go, cancel),
    ]);
    var state = { sending: false };
    var fields = { code: code, name: nameEn, name_ar: nameAr, name_en: nameEn, name_fr: nameFr, default_price: price, currency: currency };
    cancel.addEventListener("click", m.close);
    m.form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      F.unflag(m.form);
      var built = FU.servicePayload({ code: code.value, name_ar: nameAr.value, name_en: nameEn.value, name_fr: nameFr.value, default_price: price.value, currency: currency.value }, { creating: creating, base: svc });
      if (!built.ok) return F.flag(fields[built.field] || go, err, F.errText(built));
      F.submit(go, state, function () {
        var call = creating ? V.api("POST", "/finance/services", { body: built.payload }) : V.api("PATCH", "/finance/services/" + svc.id, { body: built.payload });
        return call.then(function () {
          m.close();
          V.toast(creating ? t("fin.svc.created") : t("fin.svc.saved"), "ok");
          return load();
        });
      }).catch(function (e2) { err.textContent = e2 && e2.status === 409 && creating ? t("fin.svc.duplicate") : V.errorMessage(e2); });
    });
    (creating ? code : nameEn).focus();
  }

  F.register("services", {
    init: function () {
      build();
      V.onLang(function () {
        var q = $("#fin-sf-q");
        if (q) S.filters = { q: q.value, active: $("#fin-sf-active").value };
        build();
      });
    },
    load: load,
  });
})();
