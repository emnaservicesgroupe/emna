/* Messaging panel (stage 6): conversation list with unread badges, thread with older-message pagination, composer with a
   2000-character counter, moderation controls, e-mail nudge preference. One component for the staff console ("staff" mode:
   list + thread) and the candidate / employer / agency portals ("single" mode: just their one thread).
   Security: every message, name and reason comes from other people and is UNTRUSTED. It is only ever rendered through the
   textContent helpers of vita.js (V.h), message bodies carry dir="auto" (Arabic and Latin text in one thread), nothing is
   written to browser storage, and the live stream is the shared reconnecting client V.connectEvents. The server decides on
   every call (scope, closed conversations, rate limit, moderation); the buttons only mirror what it will accept. */
(function () {
  "use strict";
  var V = window.VITA;
  var U = window.VITA_CHAT_UTIL;
  var t = V.t, h = V.h;

  var seq = 0;
  var LIST_LIMIT = 50;

  function createPanel(opts) {
    var o = opts || {};
    var staff = o.mode === "staff";
    var root = o.root;
    var uid = "chat" + (++seq);
    var P;
    var E = {};
    var statusEl = h("span", { class: "live-status", attrs: { role: "status" } });
    var statusFn = V.liveIndicator(statusEl); // registers one language listener for the panel's lifetime

    function fresh() {
      return {
        started: false, rows: [], listLoaded: false, hasMore: false, listError: null,
        openId: null, cur: null, messages: [], hasOlder: false, olderBefore: null, threadLoaded: false, threadState: "idle",
        send: U.sendInitial(), sendTok: 0, drafts: {}, marked: {}, marking: false, markAgain: false,
        events: null, live: "off", pending: { list: false, thread: false, reset: false }, listSeq: 0, threadSeq: 0, unread: 0, prefs: null, startFailed: false,
      };
    }
    P = fresh();

    // ---------------------------------------------------------------- small helpers
    // permission options may be booleans or functions (the staff role is only known after sign-in)
    function flag(v, dflt) { return typeof v === "function" ? Boolean(v()) : v === undefined ? dflt : Boolean(v); }
    function canWrite() { return flag(o.canWrite, true); }
    function canModerate() { return flag(o.canModerate, false); }
    function tz() { return V.userTz(); }
    function curRow() {
      if (P.openId === null) return null;
      var r = P.rows.filter(function (x) { return x.id === P.openId; })[0];
      return r || P.cur;
    }
    function isClosed() { var c = curRow(); return Boolean(c && c.status === "closed"); }
    function roleLabel(role) {
      var key = "chat.role." + role;
      return V.has(key) ? t(key) : t("chat.role.staff");
    }
    function threadVisible() {
      return Boolean(root && root.isConnected && root.offsetParent !== null && E.thread && E.thread.offsetParent !== null && P.openId !== null);
    }
    function nearBottom() { return !E.log || E.log.scrollHeight - E.log.scrollTop - E.log.clientHeight < 80; }
    function setNotice(text, kind) {
      if (!E.notice) return;
      V.clear(E.notice);
      E.notice.hidden = !text;
      E.notice.className = "notice small " + (kind || "info");
      if (text) E.notice.textContent = text;
    }

    // ---------------------------------------------------------------- skeleton
    function build() {
      var draft = E.input ? E.input.value : "";
      E = {};
      statusFn(P.live);
      E.notice = h("p", { class: "notice small info", hidden: true, attrs: { role: "status" } });

      var top = h("div", { class: "chat-top" }, statusEl);
      if (staff) {
        var refresh = h("button", { type: "button", class: "btn secondary small", text: t("common.refresh"), on: { click: function () { refreshAll(true); } } });
        top.appendChild(h("span", { class: "spacer" }));
        if (o.onNew && canWrite()) top.appendChild(h("button", { type: "button", class: "btn small", text: t("chat.open.button"), on: { click: function () { o.onNew(); } } }));
        top.appendChild(refresh);
      }

      E.list = h("ul", { class: "plain chat-conv-list", attrs: { "aria-label": t("chat.list.label") } });
      E.more = h("button", { type: "button", class: "btn secondary small", hidden: true, text: t("chat.list.more"), on: { click: loadMoreConversations } });
      E.listEmpty = h("div", null);
      E.listBox = h("aside", { class: "chat-list", hidden: !staff, attrs: { "aria-labelledby": uid + "-lh" } },
        h("h3", { id: uid + "-lh", text: t("chat.list.title") }), E.listEmpty, E.list, E.more);

      E.back = h("button", { type: "button", class: "btn secondary small chat-back", text: t("chat.back"), on: { click: closeThreadView } });
      E.title = h("h3", { class: "chat-title", id: uid + "-th", attrs: { tabindex: "-1" } });
      E.badges = h("span", { class: "chat-badges" });
      E.mod = h("span", { class: "btn-row chat-mod" });
      E.head = h("div", { class: "card-head chat-thread-head" }, E.back, E.title, E.badges, h("span", { class: "spacer" }), E.mod);
      E.banner = h("p", { class: "notice warn small chat-closed", hidden: true, attrs: { role: "status" }, text: t("chat.closedBanner") });
      E.older = h("button", { type: "button", class: "btn secondary small chat-older", hidden: true, text: t("chat.older"), on: { click: loadOlder } });
      E.logList = h("div", { class: "chat-days" });
      E.log = h("div", { class: "chat-log", attrs: { role: "log", "aria-live": "polite", "aria-relevant": "additions", tabindex: "0", "aria-label": t("chat.log.label") } }, E.older, E.logList);
      E.jump = h("button", { type: "button", class: "btn small chat-jump", hidden: true, text: t("chat.jump"), on: { click: function () { scrollEnd(); } } });
      E.threadMsg = h("div", { class: "chat-placeholder" });

      E.input = h("textarea", { id: uid + "-in", class: "chat-input", attrs: { rows: "3", autocomplete: "off", "aria-describedby": uid + "-count " + uid + "-note" } });
      E.input.value = draft;
      E.count = h("span", { id: uid + "-count", class: "chat-count small muted" });
      E.err = h("p", { class: "form-error chat-error", attrs: { role: "alert" } });
      E.sendBtn = h("button", { type: "submit", class: "btn chat-send", text: t("chat.send") });
      E.form = h("form", { class: "chat-composer", attrs: { novalidate: "" } },
        h("label", { class: "sr-only", for: uid + "-in", text: t("chat.compose.label") }),
        E.input,
        h("div", { class: "chat-composer-row" }, E.count, h("span", { class: "spacer" }), E.sendBtn),
        E.err);
      E.form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
      E.input.addEventListener("input", onInput);
      E.input.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submit(); }
      });
      E.log.addEventListener("scroll", function () { if (nearBottom()) E.jump.hidden = true; });

      E.thread = h("section", { class: "chat-thread card", attrs: { "aria-labelledby": uid + "-th" } }, E.head, E.banner, E.threadMsg, E.log, E.jump, E.form);

      E.prefs = h("div", { class: "chat-prefs" });
      var wrap = h("div", { class: "chat" + (staff ? " chat-split" : "") + (P.openId !== null ? " chat-show-thread" : "") },
        E.listBox, E.thread);
      E.wrap = wrap;
      V.setContent(root, top, E.notice, h("p", { id: uid + "-note", class: "notice info small chat-text-only", text: t("chat.textOnly") }), wrap, E.prefs);
      renderPrefs();
    }

    // ---------------------------------------------------------------- conversation list
    function renderList() {
      if (!staff) return;
      V.clear(E.list);
      V.clear(E.listEmpty);
      if (P.listError && !P.listLoaded) E.listEmpty.appendChild(h("p", { class: "notice bad small", attrs: { role: "alert" }, text: V.errorMessage(P.listError) }));
      else if (!P.listLoaded) E.listEmpty.appendChild(V.loading());
      else if (!P.rows.length) E.listEmpty.appendChild(V.empty(t("chat.list.empty")));
      P.rows.forEach(function (c) { E.list.appendChild(listItem(c)); });
      E.more.hidden = !P.hasMore;
    }
    function listItem(c) {
      var unread = U.badgeText(c.unread_count);
      var kind = V.has("chat.kind." + c.subject_type) ? t("chat.kind." + c.subject_type) : c.subject_type;
      var pk = U.previewKind(c);
      var preview = pk === "none" ? h("span", { class: "muted", text: t("chat.list.noMessages") })
        : pk === "removed" ? h("span", { class: "muted", text: t("chat.removed") })
        : h("span", { class: "chat-preview", attrs: { dir: "auto" }, text: c.last_message.preview });
      var btn = h("button", { type: "button", class: "chat-conv" + (c.id === P.openId ? " selected" : ""), attrs: { "aria-current": c.id === P.openId ? "true" : null, "data-conv": String(c.id) },
        on: { click: function () { openConversation(c.id, true); } } },
        h("span", { class: "chat-conv-top" },
          h("strong", { class: "chat-conv-name", attrs: { dir: "auto" }, text: U.conversationTitle(c) }),
          unread ? h("span", { class: "badge info chat-unread", text: unread, attrs: { "aria-label": t("chat.unreadN", { n: V.fmtNumber(c.unread_count) }) } }) : null),
        h("span", { class: "chat-conv-meta small muted" },
          h("span", { class: "badge neutral", text: kind }),
          c.status === "closed" ? h("span", { class: "badge warn", text: t("chat.status.closed") }) : null,
          c.last_message_at ? h("span", { text: V.fmtDateTime(c.last_message_at, tz()) }) : null),
        h("span", { class: "chat-conv-preview small" }, preview));
      return h("li", null, btn);
    }

    function applyRows(rows, append, announce) {
      P.rows = append ? P.rows.concat(rows) : rows;
      P.rows = U.sortConversations(P.rows);
      if (P.openId !== null) {
        var r = P.rows.filter(function (x) { return x.id === P.openId; })[0];
        if (r) P.cur = r;
      }
      reportUnread(announce);
    }
    function reportUnread(announce) {
      var total = U.totalUnread(P.rows);
      if (announce && total > P.unread && P.started && !threadVisible()) V.announce(t("chat.newMessage"));
      P.unread = total;
      if (o.onUnread) o.onUnread(total);
    }

    function loadConversations() {
      var mine = ++P.listSeq;
      var limit = Math.min(LIST_LIMIT, Math.max(25, P.rows.length));
      return V.api("GET", "/chat/conversations?limit=" + limit + "&offset=0")
        .then(function (data) {
          if (mine !== P.listSeq || !P.started) return;
          var again = P.listLoaded;
          P.listLoaded = true;
          P.listError = null;
          P.hasMore = Boolean(data && data.has_more);
          applyRows((data && data.rows) || [], false, again);
          setNotice("");
          renderList();
          if (!staff) singleModeSync();
          else if (P.openId !== null && !P.rows.some(function (x) { return x.id === P.openId; }) && !P.cur) closeThreadView();
          renderThreadHead();
          updateComposer();
        })
        .catch(function (err) {
          if (mine !== P.listSeq || !P.started) return;
          P.listError = err;
          if (P.listLoaded) setNotice(V.errorMessage(err), "warn");
          else if (!staff) renderSingleEmpty(err);
          renderList();
        });
    }
    function loadMoreConversations() {
      if (!P.hasMore) return;
      var offset = P.rows.length;
      V.busy(E.more, function () {
        return V.api("GET", "/chat/conversations?limit=" + LIST_LIMIT + "&offset=" + offset).then(function (data) {
          var have = {};
          P.rows.forEach(function (r) { have[r.id] = true; });
          P.hasMore = Boolean(data && data.has_more);
          applyRows(((data && data.rows) || []).filter(function (r) { return !have[r.id]; }), true);
          renderList();
        });
      }).catch(function () {});
    }

    // single mode: the one conversation of the signed-in person
    function singleModeSync() {
      if (P.rows.length) {
        var first = P.rows[0];
        if (P.openId !== first.id) openConversation(first.id, false);
        return;
      }
      renderSingleEmpty(null);
    }
    function renderSingleEmpty(err) {
      P.openId = null;
      P.cur = null;
      E.head.hidden = true;
      E.log.hidden = true;
      E.form.hidden = true;
      E.banner.hidden = true;
      var kids = [];
      if (err) kids.push(h("p", { class: "notice bad small", attrs: { role: "alert" }, text: V.errorMessage(err) }));
      else if (!P.listLoaded) kids.push(V.loading());
      else {
        kids.push(h("p", { class: "muted", text: t("chat.empty." + (o.kind || "candidate")) }));
        if (o.canStart && !P.startFailed) {
          kids.push(h("button", { type: "button", class: "btn", text: t("chat.start"), on: { click: function (e) { startOwn(e.currentTarget); } } }));
        } else if (o.canStart) kids.push(h("p", { class: "small muted", text: t("chat.start.disabled") }));
      }
      V.setContent(E.threadMsg, kids);
      E.threadMsg.hidden = false;
    }
    function startOwn(btn) {
      V.busy(btn, function () {
        return V.api("POST", "/chat/conversations", { body: { subject_type: "candidate" } }).then(function (conv) {
          return loadConversations().then(function () { if (conv && conv.id) openConversation(conv.id, true); });
        });
      }).catch(function (err) {
        if (err && err.status === 403) { P.startFailed = true; renderSingleEmpty(null); }
      });
    }

    // ---------------------------------------------------------------- thread
    function closeThreadView() {
      if (!staff && P.rows.length) return;
      P.openId = null;
      P.cur = null;
      P.messages = [];
      P.send = U.sendInitial();
      P.sendTok++;
      if (E.wrap) E.wrap.classList.remove("chat-show-thread");
      renderList();
      renderThreadHead();
      renderLog();
      updateComposer();
    }

    function openConversation(id, focus) {
      if (P.openId !== null && E.input) P.drafts[P.openId] = E.input.value;
      P.openId = id;
      P.cur = P.rows.filter(function (x) { return x.id === id; })[0] || P.cur;
      P.messages = [];
      P.hasOlder = false;
      P.olderBefore = null;
      P.threadLoaded = false;
      P.threadState = "loading";
      P.send = U.sendInitial();
      P.sendTok++;
      E.input.value = P.drafts[id] || "";
      if (E.wrap) E.wrap.classList.add("chat-show-thread");
      E.err.textContent = "";
      renderList();
      renderThreadHead();
      renderLog();
      updateComposer();
      if (focus && E.title) E.title.focus();
      return loadLatest(true);
    }

    function renderThreadHead() {
      var c = curRow();
      var has = c !== null && c !== undefined && P.openId !== null;
      E.head.hidden = !has;
      E.log.hidden = !has || P.threadState === "gone";
      E.form.hidden = !has || P.threadState === "gone";
      E.jump.hidden = true;
      V.clear(E.badges);
      V.clear(E.mod);
      if (!has) {
        E.banner.hidden = true;
        V.setContent(E.threadMsg, staff ? V.empty(t("chat.select")) : null);
        E.threadMsg.hidden = !staff;
        return;
      }
      if (P.threadState === "gone") {
        E.head.hidden = true;
        E.banner.hidden = true;
        V.setContent(E.threadMsg, h("p", { class: "notice bad small", attrs: { role: "alert" }, text: t("chat.unavailable") }));
        E.threadMsg.hidden = false;
        return;
      }
      E.threadMsg.hidden = true;
      V.clear(E.threadMsg);
      var title = staff ? U.conversationTitle(c) : t("chat.single.title");
      E.title.textContent = title;
      E.title.setAttribute("dir", "auto");
      if (staff) E.badges.appendChild(h("span", { class: "badge neutral", text: V.has("chat.kind." + c.subject_type) ? t("chat.kind." + c.subject_type) : c.subject_type }));
      E.badges.appendChild(h("span", { class: "badge " + (c.status === "closed" ? "warn" : "ok"), text: t("chat.status." + (c.status === "closed" ? "closed" : "open")) }));
      E.banner.hidden = c.status !== "closed";
      if (canModerate()) {
        var closed = c.status === "closed";
        E.mod.appendChild(h("button", { type: "button", class: "btn secondary small", text: closed ? t("chat.reopen") : t("chat.close"), on: { click: function (e) { toggleClosed(e.currentTarget, closed); } } }));
      }
    }

    function renderLog(mode) {
      var keepTop = E.log ? E.log.scrollTop : 0;
      var keepHeight = E.log ? E.log.scrollHeight : 0;
      var wasNear = nearBottom();
      V.clear(E.logList);
      E.older.hidden = !P.hasOlder;
      if (P.openId === null) return;
      if (P.threadState === "loading" && !P.messages.length) E.logList.appendChild(h("p", null, V.loading()));
      else if (P.threadState === "error" && !P.messages.length) E.logList.appendChild(h("p", { class: "notice bad small", attrs: { role: "alert" }, text: t("chat.loadError") }));
      else if (!P.messages.length && P.send.phase !== "sending") E.logList.appendChild(V.empty(t("chat.thread.empty")));
      var nowIso = new Date().toISOString();
      U.groupByDay(P.messages, tz()).forEach(function (g) {
        var kind = U.dayLabelKind(g.day, nowIso, tz());
        var label = kind ? t("chat.dayLabel." + kind) : U.formatDay(g.day, V.locale());
        E.logList.appendChild(h("section", { class: "chat-day", attrs: { "aria-label": label } },
          h("h4", { class: "chat-day-label" }, h("span", { text: label })),
          h("ol", { class: "plain chat-msgs" }, g.items.map(messageItem))));
      });
      if (P.send.phase === "sending") {
        E.logList.appendChild(h("ol", { class: "plain chat-msgs" },
          h("li", { class: "chat-msg mine pending" },
            h("div", { class: "chat-meta small muted", text: t("chat.sending") }),
            h("p", { class: "chat-body", attrs: { dir: "auto" }, text: P.send.text }))));
      }
      if (mode === "bottom" || (mode !== "keep" && mode !== "older" && wasNear) || P.send.phase === "sending") scrollEnd();
      else if (mode === "older") E.log.scrollTop = keepTop + (E.log.scrollHeight - keepHeight);
      else if (mode === "keep") E.log.scrollTop = keepTop;
    }
    function scrollEnd() {
      if (!E.log) return;
      E.log.scrollTop = E.log.scrollHeight;
      E.jump.hidden = true;
    }

    function messageItem(m) {
      var time = U.formatTime(m.created_at, tz(), V.locale());
      var timeEl = h("time", { class: "small muted", attrs: { datetime: String(m.created_at || "") }, text: time });
      if (m.hidden) return removedItem(m, timeEl);
      var who = m.mine ? t("chat.you") : (m.sender_name || roleLabel(m.sender_role));
      var meta = h("div", { class: "chat-meta small" },
        h("strong", { attrs: { dir: "auto" }, text: who }),
        !m.mine && m.sender_role ? h("span", { class: "muted", text: " · " + roleLabel(m.sender_role) }) : null,
        h("span", { class: "muted", text: " · " }), timeEl);
      var item = h("li", { class: "chat-msg " + (m.mine ? "mine" : "theirs"), attrs: { "data-msg": String(m.id) } },
        meta,
        h("p", { class: "chat-body", attrs: { dir: "auto" }, text: m.body }));
      if (canModerate()) {
        item.appendChild(h("div", { class: "chat-actions" },
          h("button", { type: "button", class: "linklike small", text: t("chat.hide"), on: { click: function (e) { moderate(e.currentTarget, m, true); } } })));
      }
      return item;
    }
    function removedItem(m, timeEl) {
      var item = h("li", { class: "chat-msg removed " + (m.mine ? "mine" : "theirs"), attrs: { "data-msg": String(m.id) } });
      item.appendChild(h("div", { class: "chat-meta small" }, h("span", { class: "muted", text: t("chat.removed") + " · " }), timeEl));
      if (staff && m.body !== undefined && m.body !== null) {
        // moderators still see who / why, and can read the original behind a disclosure
        item.appendChild(h("p", { class: "small muted", text: t("chat.hiddenBy", { reason: m.hidden_reason || "—" }) }));
        item.appendChild(h("details", null, h("summary", { class: "small", text: t("chat.showOriginal") }), h("p", { class: "chat-body", attrs: { dir: "auto" }, text: m.body })));
        if (canModerate()) {
          item.appendChild(h("div", { class: "chat-actions" },
            h("button", { type: "button", class: "linklike small", text: t("chat.unhide"), on: { click: function (e) { moderate(e.currentTarget, m, false); } } })));
        }
      }
      return item;
    }

    function loadLatest(reset) {
      var cid = P.openId;
      if (cid === null) return Promise.resolve();
      var mine = ++P.threadSeq;
      return V.api("GET", "/chat/conversations/" + cid + "/messages?limit=" + U.PAGE_SIZE)
        .then(function (resp) {
          if (cid !== P.openId || mine !== P.threadSeq) return;
          var rows = ((resp && resp.rows) || []).slice().reverse();
          var gap = !reset && resp && resp.has_more && P.messages.length && rows.length && U.toId(rows[0].id) > U.newestId(P.messages);
          var before = P.messages.length;
          var fullReset = reset || gap;
          P.messages = U.mergeMessages(fullReset ? [] : P.messages, rows);
          if (fullReset) {
            P.hasOlder = Boolean(resp && resp.has_more);
            P.olderBefore = resp ? resp.next_before : null;
          }
          P.threadLoaded = true;
          P.threadState = "ready";
          var grew = P.messages.length > before;
          var wasNear = nearBottom();
          renderThreadHead();
          renderLog(reset === true && before === 0 ? "bottom" : grew && !wasNear ? "keep" : undefined);
          if (grew && !wasNear && before > 0) E.jump.hidden = false;
          updateComposer();
          maybeMarkRead();
        })
        .catch(function (err) {
          if (cid !== P.openId || mine !== P.threadSeq) return;
          if (err && (err.status === 404 || err.status === 403)) P.threadState = "gone";
          else if (!P.threadLoaded) P.threadState = "error";
          else setNotice(V.errorMessage(err), "warn");
          renderThreadHead();
          renderLog();
          updateComposer();
        });
    }

    function loadOlder() {
      var cid = P.openId;
      if (cid === null || !P.hasOlder || P.olderBefore === null) return;
      V.busy(E.older, function () {
        return V.api("GET", "/chat/conversations/" + cid + "/messages?limit=" + U.PAGE_SIZE + "&before=" + P.olderBefore).then(function (resp) {
          if (cid !== P.openId) return;
          P.messages = U.mergeMessages(((resp && resp.rows) || []).slice().reverse(), P.messages);
          P.hasOlder = Boolean(resp && resp.has_more);
          P.olderBefore = resp ? resp.next_before : null;
          renderLog("older");
        });
      }).catch(function () {});
    }

    // ---------------------------------------------------------------- composer
    function onInput() {
      if (P.send.phase === "sending") return;
      P.send = U.sendStep(P.send, { type: "edit", text: E.input.value });
      updateComposer();
    }
    function updateComposer() {
      if (!E.input) return;
      var sending = P.send.phase === "sending";
      var closed = isClosed();
      var allowed = canWrite() && !closed && P.openId !== null && P.threadState !== "gone";
      var c = U.composeState(E.input.value);
      E.input.disabled = !allowed;
      E.input.readOnly = sending;
      E.sendBtn.disabled = !allowed || sending || !c.canSend;
      if (sending) E.sendBtn.setAttribute("aria-busy", "true");
      else E.sendBtn.removeAttribute("aria-busy");
      E.sendBtn.textContent = sending ? t("chat.sending") : t("chat.send");
      E.count.textContent = t("chat.count", { n: V.fmtNumber(c.length), max: V.fmtNumber(U.MAX_BODY) });
      E.count.className = "chat-count small " + (c.over ? "bad-text" : c.warn ? "warn-text" : "muted");
      var err = "";
      if (P.send.error) err = t("chat.err." + P.send.error.kind);
      else if (c.over) err = t("chat.err.too_long");
      else if (!canWrite()) err = t("chat.readOnly");
      E.err.textContent = err;
    }
    function submit() {
      if (P.openId === null || !canWrite() || isClosed()) return;
      var next = U.sendStep(P.send, { type: "submit", text: E.input.value });
      if (next === P.send) return; // a request is already in flight: the button is disabled and the draft frozen
      P.send = next;
      if (next.phase !== "sending") { updateComposer(); return; }
      var cid = P.openId;
      var tok = ++P.sendTok;
      updateComposer();
      renderLog();
      V.api("POST", "/chat/conversations/" + cid + "/messages", { body: { body: next.text } })
        .then(function (msg) {
          if (tok !== P.sendTok) return;
          P.send = U.sendStep(P.send, { type: "success" });
          E.input.value = "";
          delete P.drafts[cid];
          if (msg && msg.id) P.messages = U.mergeMessages(P.messages, [msg]);
          renderLog("bottom");
          updateComposer();
          E.input.focus();
          schedule({ list: true, thread: false, reset: false });
        })
        .catch(function (err) {
          if (tok !== P.sendTok) return;
          P.send = U.sendStep(P.send, { type: "failure", error: err });
          renderLog();
          updateComposer();
          var kind = P.send.error ? P.send.error.kind : "other";
          if (kind === "closed" || kind === "network") schedule({ list: true, thread: true, reset: false });
          else if (kind === "gone" || kind === "denied") { P.threadState = "gone"; renderThreadHead(); }
          if (E.input && !E.input.disabled) E.input.focus();
        });
    }

    // ---------------------------------------------------------------- read marker
    function maybeMarkRead() {
      if (!P.started || P.openId === null) return;
      var cid = P.openId;
      var focused = document.visibilityState !== "hidden" && (typeof document.hasFocus !== "function" || document.hasFocus());
      var id = U.markReadDecision({ visible: threadVisible(), focused: focused, messages: P.messages, markedId: P.marked[cid] || 0 });
      if (id === null) return;
      if (P.marking) { P.markAgain = true; return; }
      P.marking = true;
      V.api("POST", "/chat/conversations/" + cid + "/read", { body: { message_id: id } })
        .then(function (r) {
          P.marked[cid] = Math.max(P.marked[cid] || 0, id);
          var row = P.rows.filter(function (x) { return x.id === cid; })[0];
          if (row && r && typeof r.unread_count === "number") { row.unread_count = r.unread_count; renderList(); reportUnread(false); }
        })
        .catch(function () { /* the next event or focus retries */ })
        .then(function () {
          P.marking = false;
          if (P.markAgain) { P.markAgain = false; maybeMarkRead(); }
        });
    }

    // ---------------------------------------------------------------- moderation
    function reasonDialog(titleKey, required) {
      return new Promise(function (resolve) {
        var dlgId = uid + "-rd";
        var input = h("textarea", { id: dlgId + "-in", attrs: { rows: "3", autocomplete: "off" } });
        var err = h("p", { class: "form-error", attrs: { role: "alert" } });
        var ok = h("button", { type: "submit", class: "btn danger", text: t("chat.reason.submit") });
        var cancel = h("button", { type: "button", class: "btn secondary", text: t("common.cancel") });
        var form = h("form", { attrs: { novalidate: "" } },
          h("h3", { id: dlgId + "-t", text: t(titleKey) }),
          h("div", { class: "field" }, h("label", { for: dlgId + "-in", text: required ? t("chat.reason.label") : t("chat.reason.labelOptional") }), input,
            h("span", { class: "hint", text: t("chat.reason.hint", { max: V.fmtNumber(U.MAX_REASON) }) })),
          err, h("div", { class: "btn-row" }, ok, cancel));
        var dlg = h("dialog", { attrs: { "aria-labelledby": dlgId + "-t" } }, form);
        document.body.appendChild(dlg);
        var opener = document.activeElement;
        var done = function (v) {
          if (dlg.open) dlg.close();
          dlg.remove();
          if (opener && opener.focus && opener.isConnected) opener.focus();
          resolve(v);
        };
        form.addEventListener("submit", function (e) {
          e.preventDefault();
          var chk = U.reasonCheck(input.value, required);
          if (!chk.ok) { err.textContent = t("chat.reason.err." + chk.error); input.setAttribute("aria-invalid", "true"); input.focus(); return; }
          done({ reason: chk.value });
        });
        cancel.addEventListener("click", function () { done(null); });
        dlg.addEventListener("cancel", function (e) { e.preventDefault(); done(null); });
        if (typeof dlg.showModal === "function") dlg.showModal();
        else dlg.setAttribute("open", "");
        input.focus();
      });
    }
    function moderate(btn, m, hide) {
      reasonDialog(hide ? "chat.hide.title" : "chat.unhide.title", hide).then(function (res) {
        if (!res) return;
        return V.busy(btn, function () {
          return V.api("POST", "/chat/messages/" + m.id + (hide ? "/hide" : "/unhide"), { body: hide ? { reason: res.reason } : (res.reason ? { reason: res.reason } : {}) }).then(function (updated) {
            P.messages = U.mergeMessages(P.messages, [updated]);
            renderLog("keep");
            V.toast(t(hide ? "chat.hidden.done" : "chat.unhidden.done"), "ok");
            schedule({ list: true, thread: false, reset: false });
          });
        });
      }).catch(function () {});
    }
    function toggleClosed(btn, closed) {
      V.confirmDialog(t(closed ? "chat.reopen.confirm" : "chat.close.confirm"), closed ? t("chat.reopen") : t("chat.close"), !closed).then(function (yes) {
        if (!yes || P.openId === null) return;
        var cid = P.openId;
        return V.busy(btn, function () {
          return V.api("POST", "/chat/conversations/" + cid + (closed ? "/reopen" : "/close")).then(function () {
            V.toast(t(closed ? "chat.reopened.done" : "chat.closed.done"), "ok");
            return loadConversations();
          });
        });
      }).catch(function () {});
    }

    // ---------------------------------------------------------------- opening a conversation (staff)
    /** POST /chat/conversations {subject_type, subject_id}: idempotent; selects the conversation. Resolves true/false. */
    function openSubject(type, rawId) {
      var built = U.subjectOpenPayload(type, rawId);
      if (!built.ok) return Promise.reject(new Error(built.error));
      return V.api("POST", "/chat/conversations", { body: built.payload }).then(function (conv) {
        return loadConversations().then(function () {
          if (conv && conv.id) {
            P.cur = P.rows.filter(function (x) { return x.id === conv.id; })[0] || conv;
            return openConversation(conv.id, true).then(function () { return conv; });
          }
          return conv;
        });
      });
    }

    // ---------------------------------------------------------------- e-mail nudge preference
    function renderPrefs() {
      if (!E.prefs) return;
      V.clear(E.prefs);
      if (o.prefs === false) return;
      var box = h("input", { type: "checkbox", id: uid + "-pref", disabled: P.prefs === null });
      box.checked = P.prefs !== false;
      box.addEventListener("change", function () {
        var want = box.checked;
        box.disabled = true;
        V.api("PUT", "/chat/prefs", { body: { email_nudges: want } })
          .then(function (r) { P.prefs = Boolean(r && r.email_nudges); V.toast(t("chat.prefs.saved"), "ok"); })
          .catch(function (err) { box.checked = !want; V.toast(V.errorMessage(err), "bad"); })
          .then(function () { box.disabled = false; });
      });
      E.prefs.appendChild(h("div", { class: "check" }, box, h("label", { for: uid + "-pref" }, h("strong", { text: t("chat.prefs.label") }), h("span", { class: "hint", text: t("chat.prefs.hint") }))));
    }
    function loadPrefs() {
      if (o.prefs === false) return;
      V.api("GET", "/chat/prefs").then(function (r) { P.prefs = Boolean(r && r.email_nudges); renderPrefs(); }).catch(function () {});
    }

    // ---------------------------------------------------------------- refresh + realtime
    var flush = V.debounce(function () {
      var want = P.pending;
      P.pending = { list: false, thread: false, reset: false };
      if (!P.started) return;
      if (want.list) loadConversations();
      if (want.thread && P.openId !== null) loadLatest(want.reset);
    }, 300);
    function schedule(plan) {
      P.pending.list = P.pending.list || Boolean(plan.list);
      P.pending.thread = P.pending.thread || Boolean(plan.thread);
      P.pending.reset = P.pending.reset || Boolean(plan.reset);
      flush();
    }
    function refreshAll() {
      if (!P.started) return;
      loadConversations();
      if (P.openId !== null) loadLatest(false);
    }
    function onEvent(ev) {
      var plan = U.eventPlan(ev, { openId: P.openId });
      if (!plan.list) return;
      schedule({ list: true, thread: plan.thread, reset: plan.thread && ev.kind === "hidden" });
    }
    function onFocusish() { maybeMarkRead(); }

    function start() {
      if (P.started) return;
      P = fresh();
      P.started = true;
      build();
      renderList();
      if (!staff) renderSingleEmpty(null);
      else renderThreadHead();
      updateComposer();
      loadConversations();
      loadPrefs();
      P.events = V.connectEvents({
        path: "/chat/events",
        periodicMs: 30000,
        onEvent: onEvent,
        onStatus: function (s) { P.live = s; statusFn(s); if (o.onStatus) o.onStatus(s); },
        refetch: function () { refreshAll(); },
      });
      window.addEventListener("focus", onFocusish);
      document.addEventListener("visibilitychange", onFocusish);
    }
    function stop() {
      if (!P.started) return;
      P.started = false;
      if (P.events) P.events.stop();
      window.removeEventListener("focus", onFocusish);
      document.removeEventListener("visibilitychange", onFocusish);
      // nothing from the previous session may stay on the page or in memory
      var draftless = fresh();
      P = draftless;
      E = {};
      if (root) V.clear(root);
      if (o.onUnread) o.onUnread(0);
    }
    /** Called when the panel becomes visible (tab selected): loads if needed and marks the thread read. */
    function activate() {
      if (!P.started) return;
      refreshAll();
      maybeMarkRead();
    }

    V.onLang(function () {
      if (!P.started) return;
      build();
      renderList();
      if (!staff && !P.rows.length) renderSingleEmpty(null);
      renderThreadHead();
      renderLog("keep");
      updateComposer();
    });

    return { start: start, stop: stop, activate: activate, refresh: refreshAll, openSubject: openSubject, openConversation: function (id) { return openConversation(id, true); }, unread: function () { return P.unread; } };
  }

  /** Unread badge in a tab / stepper button: hidden at 0, "99+" above 99, with a screen-reader text. Returns update(n). */
  function badge(el) {
    var last = 0;
    function render() {
      var text = U.badgeText(last);
      el.hidden = !text;
      if (!text) { V.clear(el); return; }
      V.setContent(el, h("span", { attrs: { "aria-hidden": "true" }, text: text }), h("span", { class: "sr-only", text: t("chat.unreadN", { n: V.fmtNumber(last) }) }));
    }
    V.onLang(render);
    return function (n) { last = Number(n) || 0; render(); };
  }

  window.VITA_CHAT = { createPanel: createPanel, badge: badge };
})();
