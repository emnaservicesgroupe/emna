/* Messaging helpers: pure data / logic only (no DOM, no network), loaded as a classic script in the browser
   (window.VITA_CHAT_UTIL) and required by tests/chat-ui.test.js. The server stays the authority on every rule mirrored
   here (length, scope, rate limit, closed conversations, moderation). */
(function (root) {
  "use strict";

  var MAX_BODY = 2000;
  var WARN_AT = 1800;
  var MAX_REASON = 500;
  var MAX_ID = 2147483647;
  var PAGE_SIZE = 50;
  var SUBJECT_TYPES = ["candidate", "employer_request", "agency"];
  var ERROR_KINDS = ["empty", "too_long", "invalid", "network", "auth", "denied", "gone", "closed", "rate", "server", "other"];
  var EVENT_KINDS = ["message", "hidden", "closed", "reopened", "read"];
  var MAX_AUTO_PAGES = 5; // older pages loaded automatically so the read marker never covers messages the client has not shown
  // Mirrors modules/chat/common.js: a body with nothing visible (only format, space or control characters) is empty, and bidi override /
  // isolate controls are refused. ZWJ / ZWNJ / LRM / RLM stay allowed inside visible text (Arabic shaping, emoji sequences).
  var INVISIBLE_ONLY = /^[\p{Cf}\p{Cc}\p{Z}\s]*$/u;
  var BIDI_FORMATTING = /[\u202A-\u202E\u2066-\u2069]/;

  function toId(v) {
    var n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  // ---------------------------------------------------------------- unread badge
  /** "" for nothing unread (the badge is hidden), the number up to 99, "99+" above. */
  function badgeText(n) {
    var v = typeof n === "string" && n.trim() !== "" ? Number(n) : n;
    if (typeof v !== "number" || !isFinite(v) || v < 1) return "";
    v = Math.floor(v);
    return v > 99 ? "99+" : String(v);
  }
  function totalUnread(rows) {
    var sum = 0;
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      var n = r && Number(r.unread_count);
      if (isFinite(n) && n > 0) sum += Math.floor(n);
    });
    return sum;
  }

  // ---------------------------------------------------------------- composer
  function codePointLength(s) { return Array.from(String(s)).length; }
  /** What the composer shows and whether Send may be enabled. The count is the server's: trimmed, in code points. */
  function composeState(text) {
    if (typeof text !== "string") return { length: 0, remaining: MAX_BODY, empty: true, over: false, warn: false, invalid: false, canSend: false };
    var trimmed = text.trim();
    var length = codePointLength(trimmed);
    var invalid = trimmed.indexOf("\u0000") >= 0 || BIDI_FORMATTING.test(trimmed);
    var over = length > MAX_BODY;
    var empty = length === 0 || INVISIBLE_ONLY.test(trimmed);
    return { length: length, remaining: MAX_BODY - length, empty: empty, over: over, warn: length >= WARN_AT, invalid: invalid, canSend: !empty && !over && !invalid };
  }

  // ---------------------------------------------------------------- errors
  /** Maps a failed send (ApiError-like {status}) to one of ERROR_KINDS. A network failure may still have been delivered. */
  function classifyError(err) {
    var status = err && typeof err.status === "number" ? err.status : -1;
    if (status === 0) return { kind: "network", status: 0, unknown: true };
    var kind = "other";
    if (status === 400) kind = "invalid";
    else if (status === 401) kind = "auth";
    else if (status === 403) kind = "denied";
    else if (status === 404) kind = "gone";
    else if (status === 409) kind = "closed";
    else if (status === 429) kind = "rate";
    else if (status >= 500) kind = "server";
    return { kind: kind, status: status };
  }

  // ---------------------------------------------------------------- optimistic send state machine
  /**
   * idle --submit(valid)--> sending --success--> idle (draft cleared)
   *                                 --failure--> failed (draft kept) --submit--> sending | --edit--> idle
   * The server has no idempotency key, so the UI must never send twice: a submit (or an edit) while a request is in flight
   * returns the very same state object and the caller sends nothing.
   */
  function sendInitial() { return { phase: "idle", text: "", error: null }; }
  function sendStep(state, action) {
    var s = state || sendInitial();
    var a = action || {};
    if (a.type === "submit") {
      if (s.phase === "sending") return s;
      var text = typeof a.text === "string" ? a.text : "";
      var c = composeState(text);
      if (!c.canSend) return { phase: "idle", text: text, error: { kind: c.invalid ? "invalid" : c.over ? "too_long" : "empty" } };
      return { phase: "sending", text: text.trim(), error: null };
    }
    if (a.type === "success") return s.phase === "sending" ? sendInitial() : s;
    if (a.type === "failure") return s.phase === "sending" ? { phase: "failed", text: s.text, error: classifyError(a.error) } : s;
    if (a.type === "edit") return s.phase === "sending" ? s : { phase: "idle", text: typeof a.text === "string" ? a.text : "", error: null };
    return s;
  }

  // ---------------------------------------------------------------- days and times (the viewer's zone, via Intl)
  function validZone(tz) {
    if (typeof tz !== "string" || !tz) return false;
    try { new Intl.DateTimeFormat("en", { timeZone: tz }).format(new Date()); return true; } catch (e) { return false; }
  }
  /** "YYYY-MM-DD" of an instant in `tz` ("" for an unreadable instant; an unknown zone falls back to UTC). */
  function dayKey(iso, tz) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: validZone(tz) ? tz : "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    var get = function (type) { var p = parts.filter(function (x) { return x.type === type; })[0]; return p ? p.value : ""; };
    return get("year") + "-" + get("month") + "-" + get("day");
  }
  function time(iso) { var t = new Date(iso).getTime(); return isNaN(t) ? 0 : t; }
  /** Messages -> [{day, items}] oldest first (created_at, then id), grouped by the viewer's calendar day. Does not mutate the input. */
  function groupByDay(messages, tz) {
    var list = (Array.isArray(messages) ? messages : []).filter(Boolean).slice().sort(function (a, b) { return time(a.created_at) - time(b.created_at) || toId(a.id) - toId(b.id); });
    var out = [];
    list.forEach(function (m) {
      var day = dayKey(m.created_at, tz);
      var last = out[out.length - 1];
      if (last && last.day === day) last.items.push(m);
      else out.push({ day: day, items: [m] });
    });
    return out;
  }
  function dayLabelKind(day, nowIso, tz) {
    var today = dayKey(nowIso, tz);
    if (!today || !day) return null;
    if (day === today) return "today";
    var y = new Date(new Date(today + "T12:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
    return day === y ? "yesterday" : null;
  }
  function formatTime(iso, tz, locale) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat(locale || "en-GB", { timeZone: validZone(tz) ? tz : "UTC", hour: "2-digit", minute: "2-digit" }).format(d);
  }
  /** A day key as a readable date ("Monday 26 October"); the key is a calendar date, so UTC noon cannot shift it. */
  function formatDay(day, locale) {
    var d = new Date(day + "T12:00:00Z");
    if (isNaN(d.getTime())) return String(day);
    return new Intl.DateTimeFormat(locale || "en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(d);
  }

  // ---------------------------------------------------------------- message list
  /** Union by id, ascending; where an id exists twice the LATER copy wins (a refetch brings hidden / unhidden state). */
  function mergeMessages(existing, incoming) {
    var byId = Object.create(null);
    [existing, incoming].forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (m) {
        var id = m && toId(m.id);
        if (id) byId[id] = m;
      });
    });
    return Object.keys(byId).map(Number).sort(function (a, b) { return a - b; }).map(function (id) { return byId[id]; });
  }
  function newestId(messages) {
    var max = 0;
    (Array.isArray(messages) ? messages : []).forEach(function (m) { var id = m && toId(m.id); if (id > max) max = id; });
    return max;
  }

  // ---------------------------------------------------------------- realtime
  /** Which views one event refreshes. Events carry ids only: the client always refetches. */
  function eventPlan(ev, ctx) {
    var none = { list: false, thread: false, unread: false };
    if (!ev || typeof ev !== "object" || EVENT_KINDS.indexOf(ev.kind) < 0) return none;
    var conv = toId(ev.conversation_id);
    if (!conv) return none;
    var open = ctx && toId(ctx.openId);
    return { list: true, thread: ev.kind !== "read" && open === conv, unread: true };
  }
  /**
   * What to do about the read marker: {action: "mark", id} | {action: "load_older", id: null} | {action: "none", id: null}.
   * Marking moves the server's marker up to `id`, which also covers every OLDER message - so it is only allowed when the client has
   * loaded the oldest unread one: no older page exists (ctx.hasOlder false), or the loaded messages from the other side number at least
   * the server's unread count (ctx.unreadCount; the unread ones are always the newest of those). Otherwise older pages are paged in
   * first (ctx.pagesLoaded counts them; after MAX_AUTO_PAGES nothing is marked until the user loads more). Only when the thread is on
   * screen AND the window has focus, and only when a visible message from the other side is newer than the last marked id.
   */
  function markReadPlan(ctx) {
    var none = { action: "none", id: null };
    if (!ctx || !ctx.visible || !ctx.focused) return none;
    var marked = toId(ctx.markedId);
    var list = Array.isArray(ctx.messages) ? ctx.messages : [];
    var unread = list.some(function (m) { return m && !m.mine && !m.hidden && toId(m.id) > marked; });
    if (!unread) return none;
    var newest = newestId(list);
    if (!(newest > marked)) return none;
    var covered = !ctx.hasOlder;
    if (!covered) {
      var count = ctx.unreadCount;
      if (typeof count === "number" && isFinite(count) && count >= 0) {
        var loaded = list.filter(function (m) { return m && !m.mine && !m.hidden; }).length;
        covered = loaded >= count;
      }
    }
    if (covered) return { action: "mark", id: newest };
    var pages = typeof ctx.pagesLoaded === "number" && ctx.pagesLoaded > 0 ? ctx.pagesLoaded : 0;
    return pages < MAX_AUTO_PAGES ? { action: "load_older", id: null } : none;
  }
  /** The message id to mark as read, or null (see markReadPlan). */
  function markReadDecision(ctx) {
    var plan = markReadPlan(ctx);
    return plan.action === "mark" ? plan.id : null;
  }

  // ---------------------------------------------------------------- conversations
  function conversationTitle(conv) {
    if (!conv) return "";
    return conv.subject_name ? String(conv.subject_name) : conv.title ? String(conv.title) : "#" + conv.subject_id;
  }
  function previewKind(conv) {
    var m = conv && conv.last_message;
    if (!m) return "none";
    return m.hidden ? "removed" : "text";
  }
  function sortConversations(rows) {
    return (Array.isArray(rows) ? rows : []).filter(Boolean).slice().sort(function (a, b) {
      var ta = a.last_message_at ? time(a.last_message_at) : -1;
      var tb = b.last_message_at ? time(b.last_message_at) : -1;
      return tb - ta || toId(b.id) - toId(a.id);
    });
  }
  /** Open-conversation dialog -> POST /chat/conversations body (staff rooms cannot be opened from here). */
  function subjectOpenPayload(type, rawId) {
    if (SUBJECT_TYPES.indexOf(type) < 0) return { ok: false, error: "type" };
    var s = typeof rawId === "number" ? String(rawId) : typeof rawId === "string" ? rawId.trim() : "";
    var id = /^\d{1,10}$/.test(s) ? Number(s) : 0;
    if (!id || id > MAX_ID) return { ok: false, error: "id" };
    return { ok: true, payload: { subject_type: type, subject_id: id } };
  }
  /** New-staff-room dialog -> POST /chat/conversations body: a title of 1..120 characters (something visible, no bidi overrides) and 1..50 distinct staff user ids. */
  function staffRoomPayload(title, userIds) {
    var t = typeof title === "string" ? title.trim() : "";
    if (!t || INVISIBLE_ONLY.test(t) || BIDI_FORMATTING.test(t) || t.indexOf("\u0000") >= 0 || codePointLength(t) > 120) return { ok: false, error: "title" };
    var ids = [];
    var list = Array.isArray(userIds) ? userIds : [];
    for (var i = 0; i < list.length; i += 1) {
      var id = toId(list[i]);
      if (!id || id > MAX_ID) return { ok: false, error: "members" };
      if (ids.indexOf(id) < 0) ids.push(id);
    }
    if (ids.length < 1 || ids.length > 50) return { ok: false, error: "members" };
    return { ok: true, payload: { subject_type: "staff", title: t, participant_user_ids: ids } };
  }
  /** Add-participant dialog -> POST /chat/conversations/:id/participants body. */
  function participantPayload(rawId) {
    var id = toId(typeof rawId === "string" ? rawId.trim() : rawId);
    return id && id <= MAX_ID ? { ok: true, payload: { user_id: id } } : { ok: false, error: "none" };
  }
  /** Participants can be added to organisation conversations and staff rooms; a candidate thread follows the candidate's assignment. */
  function canAddParticipants(conv) {
    return Boolean(conv) && conv.subject_type !== "candidate" && typeof conv.subject_type === "string";
  }
  /** Moderation reason (hide: required; unhide: optional), 500 characters at most, no NUL. */
  function reasonCheck(value, required) {
    var s = typeof value === "string" ? value.trim() : "";
    if (s.indexOf("\u0000") >= 0) return { ok: false, error: "invalid" };
    if (!s) return required ? { ok: false, error: "required" } : { ok: true, value: null };
    if (codePointLength(s) > MAX_REASON) return { ok: false, error: "long" };
    return { ok: true, value: s };
  }
  /** Honest channel wording: only what the server reports as connected is shown as connected; WhatsApp never is in this build. */
  function channelState(c) {
    if (!c || typeof c !== "object") return "unknown";
    if (c.channel === "whatsapp") return "requires_setup";
    if (c.status === "requires_setup") return "requires_setup";
    if (c.status === "connected") return c.channel === "email" && !c.sends_real_mail ? "sandbox" : "connected";
    return "unknown";
  }

  var api = {
    MAX_BODY: MAX_BODY, MAX_REASON: MAX_REASON, PAGE_SIZE: PAGE_SIZE, SUBJECT_TYPES: SUBJECT_TYPES, ERROR_KINDS: ERROR_KINDS,
    toId: toId, badgeText: badgeText, totalUnread: totalUnread, codePointLength: codePointLength, composeState: composeState,
    classifyError: classifyError, sendInitial: sendInitial, sendStep: sendStep,
    dayKey: dayKey, groupByDay: groupByDay, dayLabelKind: dayLabelKind, formatTime: formatTime, formatDay: formatDay,
    mergeMessages: mergeMessages, newestId: newestId, eventPlan: eventPlan, markReadDecision: markReadDecision, markReadPlan: markReadPlan, MAX_AUTO_PAGES: MAX_AUTO_PAGES,
    conversationTitle: conversationTitle, previewKind: previewKind, sortConversations: sortConversations,
    subjectOpenPayload: subjectOpenPayload, staffRoomPayload: staffRoomPayload, participantPayload: participantPayload, canAddParticipants: canAddParticipants, reasonCheck: reasonCheck, channelState: channelState,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VITA_CHAT_UTIL = api;
})(typeof window !== "undefined" ? window : this);
