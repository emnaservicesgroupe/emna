/* Employer / agency portals + staff tabs: pure helpers (no DOM, no network).
   Form values <-> API payloads with the same limits the server enforces, status rules, summary rows, query strings.
   Loaded as a classic script in the browser (window.VITA_ORGS_UTIL) and required by tests/orgs-ui.test.js, which also
   compares every mirrored constant with the server modules. The server stays the authority on every rule here. */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- constants (mirrors of modules/orgs/*)
  var REQUEST_STATUSES = ["submitted", "in_review", "accepted", "declined", "filled", "cancelled"];
  var REQUEST_TRANSITIONS = {
    submitted: ["in_review", "declined", "cancelled"],
    in_review: ["accepted", "declined", "cancelled"],
    accepted: ["filled", "declined", "cancelled"],
    declined: [],
    filled: [],
    cancelled: [],
  };
  var PRESENT_STATUSES = ["in_review", "accepted"];
  var PRESENTATION_STATUSES = ["presented", "interested", "interview", "not_suitable", "withdrawn"];
  var RESPONSES = ["interested", "interview", "not_suitable"];
  var SUMMARY_KEYS = ["profession", "years_experience", "languages", "country_of_residence", "availability", "staff_note_for_employer"];
  var REQUEST_FIELDS = ["title", "positions", "country", "city", "category", "description", "requirements", "salary_text", "start_date"];
  var REQUEST_LIMITS = { title: 160, country: 160, city: 160, category: 160, description: 8000, requirements: 4000, salary_text: 160 };
  var REQUEST_REQUIRED = ["title", "country", "description"];
  var AGENCY_CAPS = { full_name: 120, email: 254, phone: 32, country: 80, profession: 120, message: 4000, passport_number: 40 };
  var AGENCY_CODES = ["new", "contacted", "qualified", "rejected", "converted", "lead", "documents", "submitted", "interview", "visa", "travel", "closed"];
  var ORG_FIELDS = {
    employer: { name: 200, contact_name: 200, email: 320, phone: 40, country: 100, sector: 100, notes: 4000 },
    agency: { name: 200, contact_name: 200, email: 320, phone: 40, country: 100, notes: 4000 },
  };
  var ORG_STATUSES = { employer: ["new", "active", "suspended", "inactive"], agency: ["active", "suspended"] };
  var NOTE_MAX = 1000; // employer note, staff note for the employer, employer-visible note
  var STAFF_NOTE_MAX = 2000;
  var BASIS_MAX = 500;
  var OTP_COOLDOWN_SECONDS = 60;
  var YEARS_MAX = 70;
  var SUMMARY_CAPS = { profession: 120, country_of_residence: 100, availability: 100, language: 60, languages: 10 };

  // Every field code the validation messages can name (orgs.f.<code> labels).
  var FIELD_LABELS = [
    "title", "positions", "country", "city", "category", "description", "requirements", "salary_text", "start_date",
    "full_name", "email", "phone", "profession", "message", "passport_number", "consent_attested",
    "name", "contact_name", "sector", "notes", "basis", "note", "status", "employer_id", "candidate_id",
    "years_experience", "languages", "country_of_residence", "availability", "staff_note_for_employer",
  ];

  // ---------------------------------------------------------------- small helpers
  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function trimmed(v) { return str(v).trim(); }
  function bad(field, error) { return { ok: false, field: field, error: error }; }
  function has(list, v) { return list.indexOf(v) >= 0; }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  var ORG_EMAIL_RE = /^[^@\s]{1,128}@[^@\s]{1,253}$/;
  var AGENCY_EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
  var PHONE_RE = /^\+?[0-9 ().-]+$/;

  /** Lower-cased e-mail when it passes the organisation / invite rule, else null. */
  function orgEmail(v) {
    var e = trimmed(v).toLowerCase();
    return e.length <= 320 && ORG_EMAIL_RE.test(e) ? e : null;
  }

  function validDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && y >= 1900;
  }

  function sameValue(a, b) {
    var x = a === undefined || a === null || a === "" ? null : a;
    var y = b === undefined || b === null || b === "" ? null : b;
    return x === y;
  }
  /** Only the keys of `next` whose value differs from `base` (null, undefined and "" are the same). */
  function diff(base, next) {
    var out = {};
    Object.keys(next).forEach(function (k) {
      if (!sameValue(base ? base[k] : null, next[k])) out[k] = next[k];
    });
    return out;
  }

  /** Optional/required capped text. Returns {value} or an error object. */
  function textField(field, raw, max, required) {
    var s = trimmed(raw);
    if (s.indexOf("\u0000") >= 0) return bad(field, "invalid");
    if (s === "") return required ? bad(field, "required") : { value: null };
    if (s.length > max) return bad(field, "long");
    return { value: s };
  }

  function pageQuery(parts, page, size) {
    var n = Math.max(1, Math.min(100, Math.floor(Number(size) || 25)));
    var p = Math.max(1, Math.floor(Number(page) || 1));
    parts.push("limit=" + n, "offset=" + (p - 1) * n);
    return "?" + parts.join("&");
  }
  function qParam(parts, name, v, cap) {
    var s = trimmed(v);
    if (cap) s = s.slice(0, cap).trim();
    if (s) parts.push(name + "=" + encodeURIComponent(s));
  }

  // ---------------------------------------------------------------- employer requests
  function requestPayload(form) {
    var f = form || {};
    var out = {};
    for (var i = 0; i < REQUEST_FIELDS.length; i++) {
      var k = REQUEST_FIELDS[i];
      if (k === "positions") {
        var raw = typeof f.positions === "number" ? f.positions : trimmed(f.positions);
        var n = typeof raw === "number" ? raw : /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
        if (!isFinite(n) || n % 1 !== 0 || n < 1 || n > 1000) return bad("positions", "invalid");
        out.positions = n;
      } else if (k === "start_date") {
        var d = trimmed(f.start_date);
        if (d === "") out.start_date = null;
        else if (validDate(d)) out.start_date = d;
        else return bad("start_date", "invalid");
      } else {
        var r = textField(k, f[k], REQUEST_LIMITS[k], has(REQUEST_REQUIRED, k));
        if (r.ok === false) return r;
        out[k] = r.value;
      }
    }
    return { ok: true, payload: out };
  }
  /** API row -> form strings (null -> ""). */
  function requestValues(row) {
    var r = row || {};
    var v = {};
    REQUEST_FIELDS.forEach(function (k) { v[k] = r[k] === null || r[k] === undefined ? "" : String(r[k]); });
    return v;
  }
  function requestDiff(base, next) { return diff(base, next); }
  function requestEditable(status) { return status === "submitted"; }
  function requestCancellable(status) { return status === "submitted" || status === "in_review"; }
  function nextStatuses(status) { return hasOwn(REQUEST_TRANSITIONS, status) ? REQUEST_TRANSITIONS[status].slice() : []; }
  function canPresentStatus(status) { return has(PRESENT_STATUSES, status); }

  var REQ_CLASS = { submitted: "info", in_review: "warn", accepted: "ok", declined: "bad", filled: "gold", cancelled: "neutral" };
  var PRES_CLASS = { presented: "info", interested: "ok", interview: "gold", not_suitable: "bad", withdrawn: "neutral" };
  var ORG_CLASS = { new: "info", active: "ok", suspended: "bad", inactive: "neutral" };
  function requestStatusClass(s) { return hasOwn(REQ_CLASS, s) ? REQ_CLASS[s] : "neutral"; }
  function presentationStatusClass(s) { return hasOwn(PRES_CLASS, s) ? PRES_CLASS[s] : "neutral"; }
  function orgStatusClass(s) { return hasOwn(ORG_CLASS, s) ? ORG_CLASS[s] : "neutral"; }

  // ---------------------------------------------------------------- presented candidates (employer side)
  /** The six allowlisted rows, in order, as plain text (null = not provided). Anything else in `summary` is ignored. */
  function summaryRows(summary) {
    var s = summary && typeof summary === "object" && !Array.isArray(summary) ? summary : {};
    return SUMMARY_KEYS.map(function (k) {
      var v = hasOwn(s, k) ? s[k] : null;
      var text = null;
      if (k === "languages") {
        text = Array.isArray(v) ? v.filter(function (x) { return typeof x === "string" && x.trim() !== ""; }).join(", ") : "";
      } else if (k === "years_experience") {
        text = typeof v === "number" && isFinite(v) ? String(v) : "";
      } else {
        text = typeof v === "string" ? v.trim() : "";
      }
      return { key: k, value: text === "" ? null : text };
    });
  }

  function respondPayload(status, note) {
    if (!has(RESPONSES, status)) return bad("status", "invalid");
    var n = trimmed(note);
    if (n.length > NOTE_MAX) return bad("note", "long");
    var payload = { status: status };
    if (n) payload.note = n;
    return { ok: true, payload: payload };
  }

  // ---------------------------------------------------------------- agency
  function agencyPayload(form) {
    var f = form || {};
    var out = {};
    var name = textField("full_name", f.full_name, AGENCY_CAPS.full_name, true);
    if (name.ok === false) return name;
    out.full_name = name.value;

    var email = textField("email", f.email, AGENCY_CAPS.email, false);
    if (email.ok === false) return email;
    var phone = textField("phone", f.phone, AGENCY_CAPS.phone, false);
    if (phone.ok === false) return phone;
    if (email.value === null && phone.value === null) return bad("email", "contact");
    if (email.value !== null) {
      var e = email.value.toLowerCase();
      if (!AGENCY_EMAIL_RE.test(e)) return bad("email", "invalid");
      out.email = e;
    }
    if (phone.value !== null) {
      var digits = phone.value.replace(/\D/g, "");
      if (!PHONE_RE.test(phone.value) || digits.length < 7 || digits.length > 15) return bad("phone", "invalid");
      out.phone = phone.value;
    }
    var optional = ["country", "profession", "message", "passport_number"];
    for (var i = 0; i < optional.length; i++) {
      var k = optional[i];
      var r = textField(k, f[k], AGENCY_CAPS[k], false);
      if (r.ok === false) return r;
      if (k === "passport_number" && r.value !== null && r.value.toUpperCase().replace(/[^A-Z0-9]/g, "").length < 4) return bad("passport_number", "invalid");
      if (r.value !== null) out[k] = r.value;
    }
    if (f.consent_attested !== true) return bad("consent_attested", "required");
    out.consent_attested = true;
    return { ok: true, payload: out };
  }
  /** Label key for a candidate row's stage code, or null when the UI has no wording for it (use the server's status_text). */
  function agencyStageKey(item) {
    var s = item && item.stage;
    return typeof s === "string" && has(AGENCY_CODES, s) ? "agency.st." + s : null;
  }

  // ---------------------------------------------------------------- organisations (staff)
  function orgPayload(type, form) {
    var caps = hasOwn(ORG_FIELDS, type) ? ORG_FIELDS[type] : null;
    if (!caps) return bad("type", "invalid");
    var f = form || {};
    var out = {};
    var keys = Object.keys(caps);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var r = textField(k, f[k], caps[k], k === "name");
      if (r.ok === false) return r;
      if (k === "email" && r.value !== null) {
        var e = orgEmail(r.value);
        if (!e) return bad("email", "invalid");
        r.value = e;
      }
      out[k] = r.value;
    }
    return { ok: true, payload: out };
  }
  function orgValues(type, row) {
    var caps = hasOwn(ORG_FIELDS, type) ? ORG_FIELDS[type] : {};
    var r = row || {};
    var v = {};
    Object.keys(caps).forEach(function (k) { v[k] = r[k] === null || r[k] === undefined ? "" : String(r[k]); });
    return v;
  }
  function orgDiff(base, next) { return diff(base, next); }

  function invitePayload(form) {
    var f = form || {};
    var email = orgEmail(f.email);
    if (!email) return bad("email", "invalid");
    var name = textField("full_name", f.full_name, 200, true);
    if (name.ok === false) return name;
    return { ok: true, payload: { email: email, full_name: name.value } };
  }

  function consentPayload(employerId, basis) {
    var id = typeof employerId === "number" ? String(employerId) : trimmed(employerId);
    if (!/^[1-9]\d{0,14}$/.test(id)) return bad("employer_id", "invalid");
    var b = trimmed(basis);
    if (b === "") return bad("basis", "required");
    if (b.length > BASIS_MAX) return bad("basis", "long");
    return { ok: true, payload: { employer_id: Number(id), basis: b } };
  }
  /** The active (not withdrawn) consent row for this employer, or null. */
  function activeConsent(rows, employerId) {
    var list = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r && String(r.employer_id) === String(employerId) && !r.withdrawn_at) return r;
    }
    return null;
  }

  // ---------------------------------------------------------------- presenting a candidate (staff)
  /**
   * One set of form values -> the preview query string and the POST body, so what is previewed is what is presented.
   * form: note, profession, years_experience, languages ("a, b"), country_of_residence, availability. Blanks are omitted.
   */
  function presentationInput(candidateId, form) {
    var cid = typeof candidateId === "number" ? String(candidateId) : trimmed(candidateId);
    if (!/^[1-9]\d{0,14}$/.test(cid)) return bad("candidate_id", "invalid");
    var f = form || {};
    var query = ["candidate_id=" + cid];
    var body = { candidate_id: Number(cid) };
    var summary = {};

    var note = trimmed(f.note);
    if (note.length > NOTE_MAX) return bad("staff_note_for_employer", "long");
    if (note) {
      query.push("staff_note_for_employer=" + encodeURIComponent(note));
      body.staff_note_for_employer = note;
    }
    var prof = trimmed(f.profession);
    if (prof.length > SUMMARY_CAPS.profession) return bad("profession", "long");
    var yrsRaw = trimmed(f.years_experience);
    var yrs = null;
    if (yrsRaw !== "") {
      if (!/^\d{1,3}$/.test(yrsRaw) || Number(yrsRaw) > YEARS_MAX) return bad("years_experience", "invalid");
      yrs = Number(yrsRaw);
    }
    var langs = trimmed(f.languages).split(",").map(function (x) { return x.trim(); }).filter(function (x) { return x !== ""; });
    if (langs.length > SUMMARY_CAPS.languages) return bad("languages", "long");
    for (var i = 0; i < langs.length; i++) if (langs[i].length > SUMMARY_CAPS.language) return bad("languages", "long");
    var country = trimmed(f.country_of_residence);
    if (country.length > SUMMARY_CAPS.country_of_residence) return bad("country_of_residence", "long");
    var avail = trimmed(f.availability);
    if (avail.length > SUMMARY_CAPS.availability) return bad("availability", "long");

    if (prof) { query.push("profession=" + encodeURIComponent(prof)); summary.profession = prof; }
    if (yrs !== null) { query.push("years_experience=" + yrs); summary.years_experience = yrs; }
    if (langs.length) { query.push("languages=" + encodeURIComponent(langs.join(","))); summary.languages = langs; }
    if (country) { query.push("country_of_residence=" + encodeURIComponent(country)); summary.country_of_residence = country; }
    if (avail) { query.push("availability=" + encodeURIComponent(avail)); summary.availability = avail; }
    if (Object.keys(summary).length) body.summary = summary;
    return { ok: true, query: query.join("&"), body: body };
  }

  // ---------------------------------------------------------------- list queries
  function requestQuery(filters, page, size) {
    var f = filters || {};
    var parts = [];
    qParam(parts, "status", f.status);
    qParam(parts, "employer_id", f.employer_id);
    qParam(parts, "q", f.q, 100);
    return pageQuery(parts, page, size);
  }
  function orgQuery(filters, page, size) {
    var f = filters || {};
    var parts = [];
    qParam(parts, "status", f.status);
    qParam(parts, "q", f.q, 100);
    return pageQuery(parts, page, size);
  }

  var api = {
    REQUEST_STATUSES: REQUEST_STATUSES, REQUEST_TRANSITIONS: REQUEST_TRANSITIONS, PRESENT_STATUSES: PRESENT_STATUSES,
    PRESENTATION_STATUSES: PRESENTATION_STATUSES, RESPONSES: RESPONSES, SUMMARY_KEYS: SUMMARY_KEYS,
    REQUEST_FIELDS: REQUEST_FIELDS, REQUEST_LIMITS: REQUEST_LIMITS, REQUEST_REQUIRED: REQUEST_REQUIRED,
    AGENCY_CAPS: AGENCY_CAPS, AGENCY_CODES: AGENCY_CODES, ORG_FIELDS: ORG_FIELDS, ORG_STATUSES: ORG_STATUSES,
    NOTE_MAX: NOTE_MAX, STAFF_NOTE_MAX: STAFF_NOTE_MAX, BASIS_MAX: BASIS_MAX, OTP_COOLDOWN_SECONDS: OTP_COOLDOWN_SECONDS,
    FIELD_LABELS: FIELD_LABELS,
    requestPayload: requestPayload, requestValues: requestValues, requestDiff: requestDiff,
    requestEditable: requestEditable, requestCancellable: requestCancellable, nextStatuses: nextStatuses, canPresentStatus: canPresentStatus,
    requestStatusClass: requestStatusClass, presentationStatusClass: presentationStatusClass, orgStatusClass: orgStatusClass,
    summaryRows: summaryRows, respondPayload: respondPayload,
    agencyPayload: agencyPayload, agencyStageKey: agencyStageKey,
    orgPayload: orgPayload, orgValues: orgValues, orgDiff: orgDiff, invitePayload: invitePayload,
    consentPayload: consentPayload, activeConsent: activeConsent, presentationInput: presentationInput,
    requestQuery: requestQuery, orgQuery: orgQuery,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VITA_ORGS_UTIL = api;
})(typeof window !== "undefined" ? window : this);
