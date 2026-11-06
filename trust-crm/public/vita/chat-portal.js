/* Portal mount of the messaging panel (candidate, employer and agency portals): the simplified single-thread mode.
   The person sees only their own conversation with the VITA team (the server scopes every call); hidden messages show
   as "message removed". Start / stop follow the portal's sign-in / sign-out so nothing stays on the page after logout. */
(function () {
  "use strict";
  var C = window.VITA_CHAT;

  /**
   * mount({root, kind: "candidate" | "employer" | "agency", badge: element}) -> {start, stop, activate}
   * Only a candidate may offer "start a conversation" (the API refuses it for organisations and may be switched off).
   */
  function mount(o) {
    var update = o.badge ? C.badge(o.badge) : function () {};
    return C.createPanel({
      root: o.root,
      mode: "single",
      kind: o.kind,
      canStart: o.kind === "candidate",
      canWrite: true,
      canModerate: false,
      onUnread: update,
    });
  }

  window.VITA_CHAT_PORTAL = { mount: mount };
})();
