/* CRM candidate section: pipeline stage selector + insert-only timeline, plus the shared timeline list.
   Used by the dashboard candidate card and by the lead detail after a conversion. All server text
   (notes, names, evidence) is rendered as text only. */
(function () {
  "use strict";
  var V = window.VITA;
  var A = window.VITA_ADMIN;
  var U = window.VITA_CRM_UTIL;
  var t = V.t, h = V.h;

  function translate(key, vars) { return V.t(key, vars); }

  /** Oldest-first list of timeline rows: label, actor, time and a plain-text description. */
  function timelineList(rows, emptyKey) {
    var list = Array.isArray(rows) ? rows : [];
    if (!list.length) return V.empty(t(emptyKey || "crm.notes.empty"));
    return h("ol", { class: "timeline" }, list.map(function (r) {
      var key = U.eventLabelKey(r.event);
      var label = key ? t(key) : String(r.event || "").replace(/_/g, " ");
      var text = U.describeEvent(r, translate);
      return h("li", null,
        h("div", { class: "when" }, V.fmtDateTime(r.created_at), r.actor_name ? " · " + r.actor_name : ""),
        h("strong", { text: label }),
        text ? h("p", { class: "note-text", text: text }) : null
      );
    }));
  }

  /**
   * Renders the stage selector and timeline of candidate `id` into `box`.
   * opts.stage: stage already known (e.g. from a conversion), used when the history has no stage change yet.
   */
  function candidateSection(box, id, opts) {
    var o = opts || {};
    var gen = (box._crmGen = (box._crmGen || 0) + 1);
    var heading = h("h3", { text: t("crm.cand.title") });
    V.setContent(box, heading, V.loading());
    return V.api("GET", "/crm/candidates/" + id + "/timeline")
      .then(function (rows) {
        if (gen !== box._crmGen) return;
        var stage = U.currentStage(rows, o.stage);
        var canWrite = U.can(A.role(), "candidates:write");
        var sel = h("select", { id: "crm-stage-" + id, disabled: !canWrite },
          U.STAGES.map(function (s) { return h("option", { value: s, selected: s === stage, text: t("crm.stage." + s) }); }));
        var save = h("button", { type: "button", class: "btn small", text: t("crm.cand.save"), disabled: !canWrite });
        save.addEventListener("click", function () {
          V.busy(save, function () {
            return V.api("PATCH", "/crm/candidates/" + id + "/stage", { body: { stage: sel.value } }).then(function () {
              V.toast(t("crm.cand.saved"), "ok");
              V.announce(t("crm.cand.saved"));
              return candidateSection(box, id, { stage: sel.value });
            });
          }).catch(function () {});
        });
        V.setContent(box,
          heading,
          h("div", { class: "field" },
            h("label", { for: "crm-stage-" + id, text: t("crm.cand.stage") }),
            h("div", { class: "btn-row" }, sel, save),
            canWrite ? null : h("span", { class: "hint", text: t("crm.cand.readOnly") })
          ),
          h("h4", { text: t("crm.cand.timeline") }),
          timelineList(rows, "crm.cand.noTimeline")
        );
      })
      .catch(function (err) {
        if (gen !== box._crmGen) return;
        // Staff other than admins only reach candidates assigned to them; the API answers 404 for the rest.
        V.setContent(box, heading, err && err.status === 404 ? h("p", { class: "notice info small", text: t("crm.cand.noAccess") }) : A.errorBox(err));
      });
  }

  // The dashboard's candidate card gets the CRM section (the existing candidate detail in the console).
  A.onCandidate(function (id) {
    var box = V.$("#dash-crm-candidate");
    if (!box) return;
    candidateSection(box, id, {}); // re-run by the dashboard itself on every refresh and language change
  });

  window.VITA_CRM = { timelineList: timelineList, candidateSection: candidateSection };
})();
