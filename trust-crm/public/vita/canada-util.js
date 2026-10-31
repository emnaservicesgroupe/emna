/* Canada service layer helpers (stage 8, task 7): permission mirror, enums, label/key mapping, form <-> API payload
   conversion and plain-language wording for the billing gate. Pure data/logic only (no DOM, no network): loaded as a classic
   script in the browser (window.VITA_CANADA_UTIL) and required by tests/canada-ui.test.js. The server stays the authority on
   every rule mirrored here; nothing in this file grants anything. */
(function (root) {
  "use strict";

  var PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
  var WORK_AUTH = ["none", "study_permit", "work_permit_open", "work_permit_employer_specific", "pr", "citizen", "unknown"];
  var CV_LANGS = ["en", "fr"];
  var CV_FORMATS = ["pdf", "docx"];
  var REPORT_LANGS = ["en", "fr", "ar"];
  var REPORT_FORMATS = ["pdf", "xlsx"];
  var BANDS = ["strong", "good", "manual_review", "not_recommended"];
  var CLASSES = ["verified_active", "foreign_applicants_stated", "eligibility_unclear", "work_authorization_required", "prospective_no_vacancy", "closed_unsuitable"];
  var DECISIONS = ["pending", "accepted", "rejected"];
  var EMPLOYER_STATUSES = ["new", "verified", "contacted", "replied", "opted_out", "blocked"];
  var SUPPRESSION_KINDS = ["email", "domain"];
  var SUPPRESSION_SOURCES = ["manual", "reply_opt_out", "bounce"];
  var LEGAL_STATUSES = ["pending", "approved", "prohibited"];
  var CONTRACT_STATUSES = ["draft", "active", "ended", "cancelled"];
  var SERVICE_KINDS = ["standard", "candidate_fee"];
  var BILLING_REASONS = ["jurisdiction_unknown", "legal_review_required", "candidate_fee_prohibited", "service_contract_required"];
  var OUTREACH_CODES = ["recipient_suppressed", "employer_opted_out", "outreach_basis_not_permitted"];
  var PERIOD_PRESETS = ["daily", "weekly", "monthly", "custom"];
  var CV_STATUSES = ["draft", "approved", "authorised", "withdrawn"];
  var MIN_EVIDENCE = 8;
  var MAX_EVIDENCE = 500;
  var MAX_RANGE_DAYS = 366;
  var MAX_SOURCE_URLS = 20;

  // ---------------------------------------------------------------- permissions (mirror of middleware/role.js)
  // Only the permissions this feature needs. tests/canada-ui.test.js compares this table with the server for every staff role.
  var PERMS = {
    SuperAdmin: ["*"],
    Admin: ["candidates:read", "candidates:write", "users:write", "finance:read", "finance:write", "finance:void", "finance:refund", "jobsearch:read", "jobsearch:write", "jobsearch:approve", "jobsearch:admin"],
    Manager: ["candidates:read", "candidates:write", "finance:read", "jobsearch:read", "jobsearch:write", "jobsearch:approve"],
    Receptionist: ["candidates:read", "candidates:write", "jobsearch:read", "jobsearch:write"],
    Agent: ["candidates:read", "candidates:write", "jobsearch:read", "jobsearch:write"],
    Accountant: ["candidates:read", "finance:read", "finance:write", "finance:void", "finance:refund"],
    HR: ["candidates:read"],
  };
  function can(role, perm) {
    var list = Object.prototype.hasOwnProperty.call(PERMS, role) ? PERMS[role] : [];
    return list.indexOf("*") >= 0 || list.indexOf(perm) >= 0;
  }
  function canRead(role) { return can(role, "jobsearch:read"); }
  function canWrite(role) { return can(role, "jobsearch:write"); }
  function canApprove(role) { return can(role, "jobsearch:approve"); }
  function canAdmin(role) { return can(role, "jobsearch:admin"); }
  /** Canada profile fields: the server needs jobsearch:write AND candidates:write. */
  function canEditCanadaProfile(role) { return can(role, "jobsearch:write") && can(role, "candidates:write"); }
  function canGenerateCv(role) { return can(role, "jobsearch:write"); }
  function canApproveCv(role) { return can(role, "jobsearch:approve"); }
  function canDecideMatch(role) { return can(role, "jobsearch:approve"); }
  function canClassify(role) { return can(role, "jobsearch:write"); }
  function canEditEmployer(role) { return can(role, "jobsearch:admin"); }
  function canAddSuppression(role) { return can(role, "jobsearch:write"); }
  function canRemoveSuppression(role) { return can(role, "jobsearch:admin"); }
  function canSetMatchSetting(role) { return can(role, "jobsearch:admin"); }
  function canEditReportSettings(role) { return can(role, "jobsearch:admin"); }
  function canSeeBilling(role) { return can(role, "finance:read"); }
  function canWriteContracts(role) { return can(role, "finance:write"); }
  function canEndContracts(role) { return can(role, "finance:void"); }
  /** A legal review is recorded by an administrator only (users:write on the server). */
  function canRecordLegalReview(role) { return can(role, "users:write"); }
  function canSetServiceKind(role) { return can(role, "users:write"); }

  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function trimmed(v) { return str(v).trim(); }
  function inList(list, v) { return list.indexOf(v) >= 0; }

  // ---------------------------------------------------------------- display helpers (pure)
  var REF_RE = /^CAN-\d{4}-\d{4,}$/;
  /** The candidate reference exactly as stored, or "" when it is not a CAN-YYYY-NNNN reference (never a made-up value). */
  function referenceDisplay(ref) {
    var s = trimmed(ref);
    return REF_RE.test(s) ? s : "";
  }
  var FILE_RE = /^[A-Za-z0-9._-]{1,120}$/;
  /** A file name safe to show or save: only the canonical character set, otherwise the fallback. */
  function filenameDisplay(name, fallback) {
    var s = trimmed(name);
    return FILE_RE.test(s) ? s : fallback || "download";
  }
  /** "PDF" / "DOCX" / "XLSX" from the declared format, else from the extension of a safe file name. */
  function formatLabel(file) {
    var f = file && typeof file === "object" ? file : {};
    var fmt = trimmed(f.format).toLowerCase();
    if (!inList(CV_FORMATS.concat(REPORT_FORMATS), fmt)) {
      var m = /\.([a-z]{3,4})$/i.exec(filenameDisplay(f.name, ""));
      fmt = m ? m[1].toLowerCase() : "";
    }
    return inList(CV_FORMATS.concat(REPORT_FORMATS), fmt) ? fmt.toUpperCase() : "";
  }

  function bandKey(band) { return "canada.band." + (inList(BANDS, band) ? band : "unknown"); }
  function bandClass(band) {
    return band === "strong" ? "ok" : band === "good" ? "info" : band === "manual_review" ? "warn" : band === "not_recommended" ? "bad" : "neutral";
  }
  function classificationKey(c) { return "canada.class." + (inList(CLASSES, c) ? c : "unclassified"); }
  function classificationClass(c) {
    return c === "verified_active" ? "ok" : c === "foreign_applicants_stated" ? "info" : c === "eligibility_unclear" ? "warn" : c === "work_authorization_required" || c === "closed_unsuitable" ? "bad" : "neutral";
  }
  function decisionKey(d) { return "canada.decision." + (inList(DECISIONS, d) ? d : "pending"); }
  function decisionClass(d) { return d === "accepted" ? "ok" : d === "rejected" ? "bad" : "neutral"; }

  /**
   * Status chips of one Canadian CV version: [{key, cls}]. The API's "staff_approved" reads "approved"; a stale version (the profile
   * changed after it was generated) always gets the extra stale chip unless it is withdrawn.
   */
  function cvStatusChips(version) {
    var v = version || {};
    var s = v.status === "staff_approved" ? "approved" : inList(CV_STATUSES, v.status) ? v.status : "draft";
    var cls = s === "authorised" ? "ok" : s === "approved" ? "info" : s === "withdrawn" ? "bad" : "neutral";
    var chips = [{ key: "canada.cv.status." + s, cls: cls }];
    if (v.stale && s !== "withdrawn") chips.push({ key: "canada.cv.status.stale", cls: "warn" });
    return chips;
  }
  function canApproveVersion(version) {
    var v = version || {};
    return v.status === "draft" && !v.stale;
  }

  var SECTION_KEYS = ["summary", "experience", "skills", "education", "certifications", "languages"];
  /**
   * A missing[] flag of a CV version -> {key, vars}. "latin_spelling_needed:<path>" and "excluded_sensitive:<section>" carry a
   * detail, "dates:experience[2]" names the (1-based) entry; plain codes map to canada.missing.<code>. Unknown codes are shown
   * humanised, never as raw underscores or an empty chip.
   */
  function missingFlag(code) {
    var c = trimmed(code);
    if (!c) return { key: null, vars: { text: "—" } };
    var m = /^latin_spelling_needed:(.+)$/.exec(c);
    if (m) return { key: "canada.missing.latin_spelling_needed", vars: { path: m[1].slice(0, 60) } };
    m = /^excluded_sensitive:([a-z_]+)$/.exec(c);
    if (m) return { key: "canada.missing.excluded_sensitive", vars: { section: m[1], sectionKey: inList(SECTION_KEYS, m[1]) ? "canada.section." + m[1] : null } };
    m = /^dates:experience\[(\d{1,3})\]$/.exec(c);
    if (m) return { key: "canada.missing.dates", vars: { n: Number(m[1]) + 1 } };
    if (/^[a-z_]+(\.[a-z_]+)?$/.test(c) && inList(["professional_summary", "experience", "skills", "education", "certifications", "languages", "contact.location", "contact.email", "contact.phone"], c)) {
      return { key: "canada.missing." + c, vars: {} };
    }
    return { key: null, vars: { text: c.replace(/[_:]+/g, " ").slice(0, 80) } };
  }
  /** True when the version needs a Latin-script spelling before its PDF can be produced (shown prominently). */
  function needsLatinSpelling(missing) {
    return (Array.isArray(missing) ? missing : []).some(function (x) { return /^latin_spelling_needed:/.test(str(x)); });
  }

  /**
   * Billing status from GET /finance/billing-status -> {billable, items:[{code, key, vars}]}. The wording states which record is
   * missing; it is not legal advice.
   */
  function billingSummary(status) {
    var s = status || {};
    var reasons = Array.isArray(s.reasons) ? s.reasons : [];
    var items = reasons.map(function (code) {
      var known = inList(BILLING_REASONS, code);
      return { code: code, key: known ? "canada.billing.reason." + code : "canada.billing.reason.unknown", vars: { jurisdiction: s.jurisdiction || "—", code: str(code) } };
    });
    var billable = s.candidate_fee_billable === true && items.length === 0;
    return { billable: billable, items: items };
  }
  /** The 409 codes of the billing gate that the finance routes answer with (keys in err.code.*). */
  function isBillingCode(code) { return inList(BILLING_REASONS, code) || code === "candidate_fee_use_catalogue"; }

  // ---------------------------------------------------------------- dates
  function validDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
    if (!m) return false;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var dt = new Date(Date.UTC(y, mo - 1, d));
    return y >= 1900 && y <= 2200 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }
  function toUtcMs(s) { var p = s.split("-"); return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function addDays(s, n) {
    var d = new Date(toUtcMs(s) + n * 86400000);
    return d.getUTCFullYear() + "-" + ("0" + (d.getUTCMonth() + 1)).slice(-2) + "-" + ("0" + d.getUTCDate()).slice(-2);
  }
  function daysBetween(a, b) { return Math.round((toUtcMs(b) - toUtcMs(a)) / 86400000); }

  /** from/to inputs -> query pieces. Both empty is allowed (the server defaults to the last 30 days). */
  function rangeQuery(from, to) {
    var f = trimmed(from), t = trimmed(to);
    if (f && !validDate(f)) return { ok: false, error: "from" };
    if (t && !validDate(t)) return { ok: false, error: "to" };
    if (f && t) {
      if (f > t) return { ok: false, error: "order" };
      if (daysBetween(f, t) + 1 > MAX_RANGE_DAYS) return { ok: false, error: "long" };
    }
    var q = {};
    if (f) q.from = f;
    if (t) q.to = t;
    return { ok: true, query: q };
  }

  /** Company report presets: daily = today, weekly = the last 7 days, monthly = the last 30 days (today = YYYY-MM-DD in the viewer's zone). */
  function presetRange(kind, today) {
    if (!validDate(today)) return null;
    if (kind === "daily") return { from: today, to: today, period: "day" };
    if (kind === "weekly") return { from: addDays(today, -6), to: today, period: "week" };
    if (kind === "monthly") return { from: addDays(today, -29), to: today, period: "month" };
    return null;
  }

  /** Query string pieces for a report download (format, range and language). */
  function reportQuery(o) {
    var f = o || {};
    var format = inList(REPORT_FORMATS, f.format) ? f.format : "pdf";
    var r = rangeQuery(f.from, f.to);
    if (!r.ok) return r;
    var q = { format: format };
    if (r.query.from) q.from = r.query.from;
    if (r.query.to) q.to = r.query.to;
    if (f.lang !== undefined && f.lang !== "") {
      if (!inList(REPORT_LANGS, f.lang)) return { ok: false, error: "lang" };
      q.lang = f.lang;
    }
    return { ok: true, query: q };
  }
  /** The Arabic PDF/XLSX uses English labels for the data columns: the console says so next to the language choice. */
  function reportLangNoteKey(lang) { return lang === "ar" ? "canada.report.arNote" : null; }

  // ---------------------------------------------------------------- Canada profile (candidate extras)
  /**
   * Form values -> PATCH body containing only what changed against `base` (the GET extras). Candidates may change only city, whatsapp,
   * relocation_ready and desired_province (opts.candidate); staff may also change work authorization and the service start date.
   */
  function profilePatch(form, base, opts) {
    var f = form || {};
    var b = base || {};
    var candidateOnly = Boolean(opts && opts.candidate);
    var patch = {};
    var city = trimmed(f.city).replace(/\s+/g, " ");
    if (city.length > 120) return { ok: false, error: "city" };
    if ((city || null) !== (b.city || null)) patch.city = city || null;

    var wa = trimmed(f.whatsapp);
    var waNew = null;
    if (wa) {
      if (!/^\+?[0-9 ()-]{6,24}$/.test(wa)) return { ok: false, error: "whatsapp" };
      var digits = wa.replace(/\D/g, "");
      if (digits.length < 6 || digits.length > 15) return { ok: false, error: "whatsapp" };
      waNew = (wa.charAt(0) === "+" ? "+" : "") + digits;
    }
    if (waNew !== (b.whatsapp || null)) patch.whatsapp = waNew;

    var rel = trimmed(f.relocation_ready);
    var relNew = rel === "true" ? true : rel === "false" ? false : null;
    if (rel !== "" && rel !== "true" && rel !== "false") return { ok: false, error: "relocation_ready" };
    var relBase = b.relocation_ready === true || b.relocation_ready === false ? b.relocation_ready : null;
    if (relNew !== relBase) patch.relocation_ready = relNew;

    var prov = trimmed(f.desired_province).toUpperCase();
    if (prov && !inList(PROVINCES, prov)) return { ok: false, error: "desired_province" };
    if ((prov || null) !== (b.desired_province || null)) patch.desired_province = prov || null;

    if (!candidateOnly) {
      var wk = trimmed(f.work_authorization_status);
      if (wk && !inList(WORK_AUTH, wk)) return { ok: false, error: "work_authorization_status" };
      if ((wk || null) !== (b.work_authorization_status || null)) patch.work_authorization_status = wk || null;
      var sd = trimmed(f.service_start_date);
      if (sd && !validDate(sd)) return { ok: false, error: "service_start_date" };
      if ((sd || null) !== (b.service_start_date || null)) patch.service_start_date = sd || null;
    }
    if (!Object.keys(patch).length) return { ok: false, error: "nothing" };
    return { ok: true, patch: patch };
  }

  // ---------------------------------------------------------------- classification override
  function squash(s) { return str(s).replace(/\s+/g, " ").trim().toLowerCase(); }
  /** Same containment rule as the server: the quote must occur verbatim in the ad, ignoring case and white-space differences. */
  function evidenceOccursIn(evidence, text) {
    var e = squash(evidence);
    return e.length >= MIN_EVIDENCE && squash(text).indexOf(e) >= 0;
  }
  /** Live hint while typing the quote: "short" | "found" | "not_found" | "no_text" (no ad text to check against). */
  function evidenceHint(evidence, adText) {
    var e = squash(evidence);
    if (e.length < MIN_EVIDENCE) return "short";
    if (!squash(adText)) return "no_text";
    return evidenceOccursIn(evidence, adText) ? "found" : "not_found";
  }
  /** Override dialog -> API body. foreign_applicants_stated needs a quote; prospective / closed need a note; null clears. */
  function classificationPayload(f) {
    var o = f || {};
    var cls = o.classification === "" || o.classification === null || o.classification === undefined ? null : o.classification;
    if (cls !== null && !inList(CLASSES, cls)) return { ok: false, error: "classification" };
    var ev = trimmed(o.evidence);
    var note = trimmed(o.note);
    if (ev.length > MAX_EVIDENCE) return { ok: false, error: "evidence_long" };
    if (note.length > 500) return { ok: false, error: "note_long" };
    if (cls === "foreign_applicants_stated" && ev.length < MIN_EVIDENCE) return { ok: false, error: "evidence" };
    if ((cls === "prospective_no_vacancy" || cls === "closed_unsuitable") && !note) return { ok: false, error: "note" };
    var body = { classification: cls };
    if (cls !== null && ev) body.evidence = ev;
    if (note) body.note = note;
    return { ok: true, payload: body };
  }
  /** The evidence field is only relevant for foreign_applicants_stated (required) and optional for the other classes. */
  function evidenceRequired(cls) { return cls === "foreign_applicants_stated"; }
  function noteRequired(cls) { return cls === "prospective_no_vacancy" || cls === "closed_unsuitable"; }

  // ---------------------------------------------------------------- employers + suppression
  /** http(s) only: returns the canonical URL or "" for anything else (javascript:, data:, ftp:, credentials, junk). */
  function safeHttpUrl(raw) {
    var s = trimmed(raw);
    if (!s || s.length > 500 || /[\s\u0000-\u001f\u007f]/.test(s)) return "";
    try {
      var u = new URL(s);
      if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || !u.hostname) return "";
      return u.href;
    } catch (e) {
      return "";
    }
  }
  function safeUrls(list) {
    return (Array.isArray(list) ? list : []).map(safeHttpUrl).filter(Boolean);
  }
  /** One URL per line -> {ok, urls} (the first bad line is reported). */
  function parseUrlLines(text) {
    var lines = str(text).split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (lines.length > MAX_SOURCE_URLS) return { ok: false, error: "many" };
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var u = safeHttpUrl(lines[i]);
      if (!u) return { ok: false, error: "url", line: i + 1 };
      if (out.indexOf(u) < 0) out.push(u);
    }
    return { ok: true, urls: out };
  }
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  /** Employer detail form -> PATCH body with the changed profile fields only (administrator). */
  function employerPatch(form, base) {
    var f = form || {};
    var b = base || {};
    var patch = {};
    function text(key, max, multiline) {
      var v = multiline ? str(f[key]).replace(/\r\n?/g, "\n").trim() : trimmed(f[key]).replace(/\s+/g, " ");
      if (v.length > max) return false;
      if ((v || null) !== (b[key] || null)) patch[key] = v || null;
      return true;
    }
    var prov = trimmed(f.province).toUpperCase();
    if (prov && !inList(PROVINCES, prov)) return { ok: false, error: "province" };
    if ((prov || null) !== (b.province || null)) patch.province = prov || null;
    if (!text("city", 100, false)) return { ok: false, error: "city" };
    if (!text("industry", 100, false)) return { ok: false, error: "industry" };
    var phone = trimmed(f.phone);
    if (phone && (!/^[0-9+().\- ]{5,30}$/.test(phone) || (phone.match(/[0-9]/g) || []).length < 5)) return { ok: false, error: "phone" };
    if ((phone || null) !== (b.phone || null)) patch.phone = phone || null;
    if (!text("recruiterContactName", 120, false)) return { ok: false, error: "recruiterContactName" };
    if (!text("eligibilityNote", 1000, true)) return { ok: false, error: "eligibilityNote" };
    if (!text("notes", 4000, true)) return { ok: false, error: "notes" };
    var st = trimmed(f.status);
    if (st && !inList(EMPLOYER_STATUSES, st)) return { ok: false, error: "status" };
    if (st && st !== (b.status || "new")) patch.status = st;
    var urls = parseUrlLines(f.sourceUrls);
    if (!urls.ok) return { ok: false, error: urls.error === "many" ? "sourceUrlsMany" : "sourceUrls", line: urls.line };
    if (!sameList(urls.urls, Array.isArray(b.sourceUrls) ? b.sourceUrls : [])) patch.sourceUrls = urls.urls;
    if (!Object.keys(patch).length) return { ok: false, error: "nothing" };
    return { ok: true, patch: patch };
  }
  /** "Last contact" etc. for the contact-history panel: counts only, from the history response totals. */
  function historySummary(h) {
    var x = h || {};
    var t = x.totals || x; // the history endpoint nests the counts in totals; the preparation package carries them flat
    return {
      applications: Number(t.applications) || 0,
      sent: Number(t.sent) || 0,
      replies: Number(t.replies) || 0,
      lastContactAt: t.lastContactAt || null,
      others: Number(x.contactedByOtherCandidates) || 0,
    };
  }

  function suppressionPayload(f) {
    var o = f || {};
    var kind = trimmed(o.kind);
    if (!inList(SUPPRESSION_KINDS, kind)) return { ok: false, error: "kind" };
    var value = trimmed(o.value);
    if (!value || value.length > 300) return { ok: false, error: "value" };
    if (kind === "email" && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.replace(/^.*<([^>]+)>.*$/, "$1"))) return { ok: false, error: "email" };
    if (kind === "domain" && (value.indexOf("@") >= 0 || /\s/.test(value) || value.indexOf(".") < 0)) return { ok: false, error: "domain" };
    var reason = trimmed(o.reason);
    if (reason.length > 500) return { ok: false, error: "reason_long" };
    var body = { kind: kind, value: value };
    if (reason) body.reason = reason;
    return { ok: true, payload: body };
  }
  /** Removing a suppression needs a reason of 3 to 500 characters (the list is never shortened silently). */
  function suppressionRemovalReason(reason) {
    var r = trimmed(reason);
    if (r.length < 3) return { ok: false, error: "short" };
    if (r.length > 500) return { ok: false, error: "long" };
    return { ok: true, reason: r };
  }
  /** Query for GET /jobsearch/suppressions. */
  function suppressionQuery(f, page, pageSize) {
    var o = f || {};
    var parts = [];
    if (inList(SUPPRESSION_KINDS, o.kind)) parts.push("kind=" + encodeURIComponent(o.kind));
    if (inList(SUPPRESSION_SOURCES, o.source)) parts.push("source=" + encodeURIComponent(o.source));
    var q = trimmed(o.q).slice(0, 100);
    if (q) parts.push("q=" + encodeURIComponent(q));
    parts.push("page=" + Math.max(1, Math.floor(Number(page) || 1)), "pageSize=" + Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 25))));
    return "?" + parts.join("&");
  }

  // ---------------------------------------------------------------- legal review + contracts
  var JURISDICTION_RE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
  /** Recorded legal review dialog -> API body. `today` = YYYY-MM-DD (reviewed_at cannot be in the future). */
  function legalReviewPayload(f, today) {
    var o = f || {};
    var j = trimmed(o.jurisdiction).toUpperCase();
    if (!JURISDICTION_RE.test(j)) return { ok: false, error: "jurisdiction" };
    if (!inList(LEGAL_STATUSES, o.status)) return { ok: false, error: "status" };
    var name = trimmed(o.reviewer_name);
    if (!name || name.length > 200) return { ok: false, error: "reviewer_name" };
    var role = trimmed(o.reviewer_role);
    if (role.length > 200) return { ok: false, error: "reviewer_role" };
    var reviewed = trimmed(o.reviewed_at);
    if (!validDate(reviewed)) return { ok: false, error: "reviewed_at" };
    if (validDate(today) && reviewed > today) return { ok: false, error: "reviewed_future" };
    var until = trimmed(o.valid_until);
    if (until && !validDate(until)) return { ok: false, error: "valid_until" };
    if (until && until < reviewed) return { ok: false, error: "valid_order" };
    var note = trimmed(o.note);
    if (note.length > 2000) return { ok: false, error: "note" };
    var body = { jurisdiction: j, service_kind: "candidate_fee", status: o.status, reviewer_name: name, reviewed_at: reviewed };
    if (role) body.reviewer_role = role;
    if (until) body.valid_until = until;
    if (note) body.note = note;
    return { ok: true, payload: body };
  }
  /** Default jurisdiction for the dialog: the gate's own rule ("CA-" + desired province). */
  function defaultJurisdiction(province, billingJurisdiction) {
    if (billingJurisdiction) return billingJurisdiction;
    return inList(PROVINCES, province) ? "CA-" + province : "";
  }
  function contractActions(contract, role) {
    var c = contract || {};
    return {
      sign: c.status === "draft" && canWriteContracts(role),
      end: c.status === "active" && canEndContracts(role),
      cancel: (c.status === "draft" || c.status === "active") && canEndContracts(role),
    };
  }
  function contractCreatePayload(f) {
    var o = f || {};
    var cand = Number(o.candidate_id), svc = Number(o.service_id);
    if (!Number.isSafeInteger(cand) || cand < 1) return { ok: false, error: "candidate" };
    if (!Number.isSafeInteger(svc) || svc < 1) return { ok: false, error: "service" };
    var body = { candidate_id: cand, service_id: svc };
    var s = trimmed(o.start_date), e = trimmed(o.end_date);
    if (s && !validDate(s)) return { ok: false, error: "start_date" };
    if (e && !validDate(e)) return { ok: false, error: "end_date" };
    if (s && e && e < s) return { ok: false, error: "date_order" };
    if (s) body.start_date = s;
    if (e) body.end_date = e;
    var terms = trimmed(o.refund_terms);
    if (terms.length > 2000) return { ok: false, error: "refund_terms" };
    if (terms) body.refund_terms = terms;
    return { ok: true, payload: body };
  }
  function contractSignPayload(f) {
    var name = trimmed(f && f.signed_by_name);
    if (!name || name.length > 200) return { ok: false, error: "signed_by_name" };
    return { ok: true, payload: { signed_by_name: name } };
  }

  /** Report settings dialog (administrator): timezone name or null, schedule flag. */
  function reportSettingsPatch(f, base) {
    var o = f || {};
    var b = base || {};
    var patch = {};
    var tz = trimmed(o.timezone);
    if (tz.length > 80 || /[^A-Za-z0-9_+\-\/]/.test(tz)) return { ok: false, error: "timezone" };
    if (tz && tz !== b.report_timezone) patch.report_timezone = tz;
    if (typeof o.schedule === "boolean" && o.schedule !== Boolean(b.report_schedule_enabled)) patch.report_schedule_enabled = o.schedule;
    if (!Object.keys(patch).length) return { ok: false, error: "nothing" };
    return { ok: true, patch: patch };
  }

  /** Marks which of the outreach blockers (from the prepare response or the auto-approval reasons) are the stage-8 ones. */
  function outreachBlockers(list) {
    return (Array.isArray(list) ? list : []).map(function (b) {
      var code = typeof b === "string" ? b : b && b.code;
      return code && inList(OUTREACH_CODES, code) ? { code: code, detail: typeof b === "object" && b.detail ? String(b.detail) : "" } : null;
    }).filter(Boolean);
  }

  var api = {
    PROVINCES: PROVINCES, WORK_AUTH: WORK_AUTH, CV_LANGS: CV_LANGS, CV_FORMATS: CV_FORMATS, REPORT_LANGS: REPORT_LANGS, REPORT_FORMATS: REPORT_FORMATS,
    BANDS: BANDS, CLASSES: CLASSES, DECISIONS: DECISIONS, EMPLOYER_STATUSES: EMPLOYER_STATUSES, SUPPRESSION_KINDS: SUPPRESSION_KINDS, SUPPRESSION_SOURCES: SUPPRESSION_SOURCES,
    LEGAL_STATUSES: LEGAL_STATUSES, CONTRACT_STATUSES: CONTRACT_STATUSES, SERVICE_KINDS: SERVICE_KINDS, BILLING_REASONS: BILLING_REASONS, OUTREACH_CODES: OUTREACH_CODES,
    PERIOD_PRESETS: PERIOD_PRESETS, CV_STATUSES: CV_STATUSES, SECTION_KEYS: SECTION_KEYS, MIN_EVIDENCE: MIN_EVIDENCE, MAX_EVIDENCE: MAX_EVIDENCE,
    can: can, canRead: canRead, canWrite: canWrite, canApprove: canApprove, canAdmin: canAdmin, canEditCanadaProfile: canEditCanadaProfile, canGenerateCv: canGenerateCv,
    canApproveCv: canApproveCv, canDecideMatch: canDecideMatch, canClassify: canClassify, canEditEmployer: canEditEmployer, canAddSuppression: canAddSuppression,
    canRemoveSuppression: canRemoveSuppression, canSetMatchSetting: canSetMatchSetting, canEditReportSettings: canEditReportSettings, canSeeBilling: canSeeBilling,
    canWriteContracts: canWriteContracts, canEndContracts: canEndContracts, canRecordLegalReview: canRecordLegalReview, canSetServiceKind: canSetServiceKind,
    referenceDisplay: referenceDisplay, filenameDisplay: filenameDisplay, formatLabel: formatLabel,
    bandKey: bandKey, bandClass: bandClass, classificationKey: classificationKey, classificationClass: classificationClass, decisionKey: decisionKey, decisionClass: decisionClass,
    cvStatusChips: cvStatusChips, canApproveVersion: canApproveVersion, missingFlag: missingFlag, needsLatinSpelling: needsLatinSpelling,
    billingSummary: billingSummary, isBillingCode: isBillingCode,
    validDate: validDate, addDays: addDays, rangeQuery: rangeQuery, presetRange: presetRange, reportQuery: reportQuery, reportLangNoteKey: reportLangNoteKey,
    profilePatch: profilePatch, evidenceOccursIn: evidenceOccursIn, evidenceHint: evidenceHint, classificationPayload: classificationPayload,
    evidenceRequired: evidenceRequired, noteRequired: noteRequired,
    safeHttpUrl: safeHttpUrl, safeUrls: safeUrls, parseUrlLines: parseUrlLines, employerPatch: employerPatch, historySummary: historySummary,
    suppressionPayload: suppressionPayload, suppressionRemovalReason: suppressionRemovalReason, suppressionQuery: suppressionQuery,
    legalReviewPayload: legalReviewPayload, defaultJurisdiction: defaultJurisdiction, contractActions: contractActions, contractCreatePayload: contractCreatePayload,
    contractSignPayload: contractSignPayload, reportSettingsPatch: reportSettingsPatch, outreachBlockers: outreachBlockers,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VITA_CANADA_UTIL = api;
})(typeof window !== "undefined" ? window : this);
