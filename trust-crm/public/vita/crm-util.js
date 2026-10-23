/* CRM console helpers: permission mirror, enums, form <-> API payload conversion and timeline wording.
   Pure data/logic only (no DOM): loaded as a classic script in the browser (window.VITA_CRM_UTIL) and
   required by tests/crm-ui.test.js. The server stays the authority on every rule mirrored here. */
(function (root) {
  "use strict";

  var LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "rejected", "spam"];
  var LEAD_SETTABLE = ["new", "contacted", "qualified", "rejected", "spam"]; // 'converted' only through Convert
  var LEAD_KINDS = ["candidate", "employer", "contact"];
  var STAGES = ["lead", "documents", "submitted", "interview", "visa", "travel", "closed"];
  var SITE_STATUSES = ["draft", "published", "closed"];
  var APPLY_MODES = ["contact_staff", "register"];
  var EVENTS = ["note", "status_changed", "assigned", "converted", "created_from_lead", "stage_changed", "created", "updated", "published", "closed"];
  var NOTE_MAX = 4000;
  var SITE_MAX = { title: 160, description: 8000, requirements: 4000 };
  var SITE_TEXT_FIELDS = ["title", "employer_name", "country", "city", "category", "description", "requirements", "language_requirements", "employment_type", "salary_text", "evidence_note"];
  var PUBLISH_REQUIRED = ["title", "country", "description", "evidence_note"];

  // Mirror of the permissions that matter to this UI (middleware/role.js; tests compare the two).
  var PERMS = {
    SuperAdmin: ["*"],
    Admin: ["candidates:read", "candidates:write", "users:write", "leads:read", "leads:write", "sitejobs:write"],
    Manager: ["candidates:read", "candidates:write", "leads:read", "leads:write", "sitejobs:write"],
    Receptionist: ["candidates:read", "candidates:write", "leads:read", "leads:write", "sitejobs:write"],
    Agent: ["candidates:read", "candidates:write", "leads:read"],
  };
  function can(role, perm) {
    var list = Object.prototype.hasOwnProperty.call(PERMS, role) ? PERMS[role] : [];
    return list.indexOf("*") >= 0 || list.indexOf(perm) >= 0;
  }
  function canConvert(role) { return can(role, "leads:write") && can(role, "candidates:write"); }
  function canAssign(role) { return can(role, "users:write"); }
  function canSiteJobs(role) { return can(role, "sitejobs:write"); }

  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function trimmed(v) { return str(v).trim(); }

  // ---------------------------------------------------------------- apply_mode
  function validHttpsUrl(v) {
    if (v.length > 160 || /[\s\u0000-\u001f\u007f]/.test(v) || !/^https:\/\//i.test(v)) return false;
    try {
      var u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password && Boolean(u.hostname);
    } catch (e) {
      return false;
    }
  }
  function parseApplyMode(v) {
    var s = trimmed(v);
    if (s === "") return { mode: "contact_staff", url: "" };
    if (APPLY_MODES.indexOf(s) >= 0) return { mode: s, url: "" };
    return { mode: "external", url: s };
  }
  function buildApplyMode(o) {
    var mode = o && o.mode;
    if (APPLY_MODES.indexOf(mode) >= 0) return { ok: true, value: mode };
    if (mode === "external") {
      var url = trimmed(o.url);
      return validHttpsUrl(url) ? { ok: true, value: url } : { ok: false, error: "apply_url" };
    }
    return { ok: false, error: "apply_mode" };
  }

  // ---------------------------------------------------------------- dates
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  /** ISO instant -> value for <input type=datetime-local> in the viewer's zone ("" when empty/invalid). */
  function toLocalInput(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fromLocalInput(v) {
    var s = trimmed(v);
    if (!s) return { ok: true, value: null };
    var d = new Date(s);
    return isNaN(d.getTime()) ? { ok: false } : { ok: true, value: d.toISOString() };
  }

  // ---------------------------------------------------------------- site jobs
  /** Form values -> API body (all fields). {ok:false,error:<field|field_long>} when the console can already tell it is invalid. */
  function siteJobPayload(f) {
    var v = f || {};
    var out = {};
    for (var i = 0; i < SITE_TEXT_FIELDS.length; i++) {
      var k = SITE_TEXT_FIELDS[i];
      var t = trimmed(v[k]);
      if (k === "title" && !t) return { ok: false, error: "title" };
      var max = SITE_MAX[k] || 160;
      if (t.length > max) return { ok: false, error: k + "_long" };
      out[k] = t === "" ? null : t;
    }
    var am = trimmed(v.apply_mode);
    if (am === "") out.apply_mode = null;
    else {
      var built = buildApplyMode({ mode: am, url: v.apply_url });
      if (!built.ok) return { ok: false, error: built.error };
      out.apply_mode = built.value;
    }
    var c = fromLocalInput(v.closes_at);
    if (!c.ok) return { ok: false, error: "closes_at" };
    out.closes_at = c.value;
    return { ok: true, payload: out };
  }

  function sameInstant(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return (a === null || a === undefined) && (b === null || b === undefined);
    return new Date(a).getTime() === new Date(b).getTime();
  }
  /** Only the keys of `next` whose value differs from `base` (closes_at compared as an instant). */
  function diffPayload(base, next) {
    var out = {};
    Object.keys(next).forEach(function (k) {
      var a = base ? base[k] : null;
      var b = next[k];
      var same = k === "closes_at" ? sameInstant(a, b) : (a === undefined || a === null ? null : a) === (b === undefined || b === null ? null : b);
      if (!same) out[k] = b;
    });
    return out;
  }

  /** What stops this offer from being published (same rules as the server). */
  function publishBlockers(v) {
    var o = v || {};
    var missing = PUBLISH_REQUIRED.filter(function (k) { return trimmed(o[k]) === ""; });
    var past = false;
    if (o.closes_at) {
      var ts = new Date(o.closes_at).getTime();
      past = !isNaN(ts) && ts <= Date.now();
    }
    return { missing: missing, closesPast: past };
  }

  // ---------------------------------------------------------------- leads
  function leadQuery(filters, page, pageSize) {
    var f = filters || {};
    var size = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 25)));
    var p = Math.max(1, Math.floor(Number(page) || 1));
    var parts = [];
    ["status", "kind"].forEach(function (k) {
      var v = trimmed(f[k]);
      if (v) parts.push(k + "=" + encodeURIComponent(v));
    });
    var q = trimmed(f.q).slice(0, 100).trim();
    if (q) parts.push("q=" + encodeURIComponent(q));
    parts.push("limit=" + size, "offset=" + (p - 1) * size);
    return "?" + parts.join("&");
  }

  function leadCanConvert(lead) {
    return Boolean(lead) && lead.kind === "candidate" && lead.status !== "converted" && lead.status !== "spam";
  }

  /** Convert dialog values -> API body. A portal login needs the lead's e-mail, so the flag is dropped without one. */
  function convertPayload(v, lead) {
    var o = v || {};
    var passport = trimmed(o.passport_number);
    if (!passport) return { ok: false, error: "passport" };
    if (passport.length > 64) return { ok: false, error: "passport_long" };
    var out = { passport_number: passport };
    var name = trimmed(o.full_name);
    if (name) {
      if (name.length > 200) return { ok: false, error: "full_name_long" };
      out.full_name = name;
    }
    var nat = trimmed(o.nationality);
    if (nat) {
      if (nat.length > 100) return { ok: false, error: "nationality_long" };
      out.nationality = nat;
    }
    out.createPortalLogin = Boolean(o.portal) && Boolean(lead && trimmed(lead.email));
    return { ok: true, payload: out };
  }

  // ---------------------------------------------------------------- candidate stage + timeline wording
  /** The timeline is the only place the API exposes the stage, so the latest stage_changed wins. */
  function currentStage(rows, fallback) {
    var list = Array.isArray(rows) ? rows : [];
    for (var i = list.length - 1; i >= 0; i--) {
      var r = list[i];
      if (r && r.event === "stage_changed" && r.detail && STAGES.indexOf(r.detail.to) >= 0) return r.detail.to;
    }
    return STAGES.indexOf(fallback) >= 0 ? fallback : "lead";
  }

  function eventLabelKey(event) { return EVENTS.indexOf(event) >= 0 ? "crm.ev." + event : null; }

  /** Plain-text description of a timeline row's detail (callers render it with textContent). */
  function describeEvent(row, t) {
    var d = (row && row.detail) || {};
    var who = function (id) { return id === null || id === undefined ? t("crm.detail.unassigned") : "#" + id; };
    switch (row && row.event) {
      case "note": return str(d.text);
      case "status_changed": return t("crm.ev.statusChange", { from: t("crm.status." + d.from), to: t("crm.status." + d.to) });
      case "stage_changed": return t("crm.ev.statusChange", { from: t("crm.stage." + d.from), to: t("crm.stage." + d.to) });
      case "assigned": return t("crm.ev.assignChange", { from: who(d.from), to: who(d.to) });
      case "converted": return t(d.portal_login ? "crm.ev.convertedPortal" : "crm.ev.convertedPlain", { id: d.candidate_id });
      case "created_from_lead": return t("crm.ev.fromLead", { id: d.lead_id });
      case "updated": return Array.isArray(d.fields) ? d.fields.join(", ") : "";
      case "published": return str(d.evidence_note);
      default: return "";
    }
  }

  var api = {
    LEAD_STATUSES: LEAD_STATUSES, LEAD_SETTABLE: LEAD_SETTABLE, LEAD_KINDS: LEAD_KINDS, STAGES: STAGES, SITE_STATUSES: SITE_STATUSES,
    APPLY_MODES: APPLY_MODES, NOTE_MAX: NOTE_MAX, PUBLISH_REQUIRED: PUBLISH_REQUIRED,
    can: can, canConvert: canConvert, canAssign: canAssign, canSiteJobs: canSiteJobs,
    parseApplyMode: parseApplyMode, buildApplyMode: buildApplyMode, toLocalInput: toLocalInput, fromLocalInput: fromLocalInput,
    siteJobPayload: siteJobPayload, diffPayload: diffPayload, publishBlockers: publishBlockers,
    leadQuery: leadQuery, leadCanConvert: leadCanConvert, convertPayload: convertPayload,
    currentStage: currentStage, eventLabelKey: eventLabelKey, describeEvent: describeEvent,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VITA_CRM_UTIL = api;
})(typeof window !== "undefined" ? window : this);
