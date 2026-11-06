// chat-e2e-README
// End-to-end journey for messaging (stage 6, Task 5). REAL HTTP server (app.listen(0) + fetch), REAL Postgres schema (fresh per
// file), staff through the real /auth/login, candidates and employer / agency users through the REAL e-mail OTP flow (code read from the
// sandbox mailbox), real SSE streams over fetch, and tests/helpers/e2e.js (which also fences globalThis.fetch: no network).
// Deterministic: limits come from injected env, waits are on conditions (hub.idle / nudges.idle / polling), never fixed sleeps.
//
//   A  candidate: Receptionist (assigned) opens -> content-free e-mail nudge -> candidate reads over REST and SSE, replies; unread on both
//      sides; a second staff message inside the cooldown sends no second e-mail
//   B  an unassigned Agent gets the identical 404 until the candidate is reassigned; then visibility moves at once (old staff loses it)
//   C  employer: two users of one organisation share one thread with staff; another employer sees nothing; e-mail nudge per user
//   D  agency: the same
//   E  Manager moderation: hide -> stub without text for the candidate, SSE kind hidden, unread unaffected; unhide; roles that may not
//   F  close -> send 409 -> reopen -> send OK
//   G  HR / Accountant reach /chat but see only their staff rooms; Candidate / Employer / Agency tokens denied on the other route classes (spot check)
//   H  rate limit 429 (+ Retry-After), recovery after the window is not needed for other users
//   I  opt-out of nudges honoured; cooldown expiry sends again
//   J  honest channels: WhatsApp requires_setup, the outbox never says 'sent', e-mail is the sandbox
//   K  HTML / script / bidi / zero-width text stored verbatim, returned as JSON strings
//   L  20 parallel sends: unique ordered ids, correct counts, no e-mail storm
//   M  a deactivated user's token (and open stream) dies at once
//   P  staff rooms and explicit participants (HR in a room, an Agent in an employer thread) over REST, SSE and the audit trail
//   N  no message text in any SSE frame or e-mail body (sentinels), frames carry ids and kinds only
//   O  the all-routes authorization sweep file passes as a child process
//
// NOT covered (by design): a real server, a real mail provider (sandbox mailbox only), WhatsApp (adapter is requires_setup), several app
// processes (the hub is in-process), a browser (see chat-ui and the Playwright smoke).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "chat-e2e-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chat-e2e-"));
process.env.STORAGE_URL_SECRET = "chat-e2e-storage-secret";
process.env.MAIL_PROVIDER = "sandbox";
process.env.MAIL_SANDBOX_ALLOWLIST = "*@test.invalid,*@*.test.invalid";
process.env.MAIL_FROM = "applications@vita.test.invalid";
process.env.SITE_IP_SALT = "chat-e2e-salt";
// Deterministic chat settings injected through env (never host defaults).
process.env.CHAT_RATE_PER_MIN = "1000";
process.env.CHAT_NUDGE_COOLDOWN_MIN = "15";
process.env.CHAT_SSE_HEARTBEAT_MS = "60000";
process.env.CHAT_SSE_MAX_PER_USER = "5";
delete process.env.CHAT_CANDIDATE_CAN_START;
delete process.env.SITE_BASE_URL;
delete process.env.WHATSAPP_PROVIDER;
for (const k of ["CLAMAV_HOST", "MAIL_REAL_SEND"]) delete process.env[k];

const E = require("./helpers/e2e");
const hub = require("../modules/chat/hub");
const nudges = require("../modules/chat/nudges");
const whatsapp = require("../modules/chat/whatsapp");

const NUDGE_SUBJECT = nudges.buildMessage().subject;
const NOT_FOUND = { error: "Not found" };
const FRAME_KEYS = new Set(["id", "kind", "conversation_id", "message_id"]);

// ---------------------------------------------------------------- helpers
let w;
let sentinelSeq = 0;
const SENTINELS = []; // every message text sent by the suite: none may appear in an SSE frame or an e-mail
const streams = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${label}`);
    await sleep(15);
  }
}
/** A unique, recognisable message text (recorded as a sentinel). */
function text(tag) {
  sentinelSeq += 1;
  const t = `E2E-SENTINEL-${tag}-${sentinelSeq}-${process.pid}`;
  SENTINELS.push(t);
  return t;
}
/** After every queued hub delivery and e-mail nudge finished, let the sockets flush. */
async function settle() {
  await hub.idle();
  await nudges.idle();
  await sleep(100);
}

async function openSse(token, { lastEventId } = {}) {
  const ac = new AbortController();
  const res = await fetch(`${w.base}/chat/events`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(lastEventId !== undefined ? { "last-event-id": String(lastEventId) } : {}) },
    signal: ac.signal,
  });
  const s = { status: res.status, frames: [], raw: "", ended: false, body: null, close: () => ac.abort() };
  streams.push(s);
  if (res.status !== 200 || !(res.headers.get("content-type") || "").includes("text/event-stream")) {
    s.body = await res.text();
    s.ended = true;
    return s;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        s.raw += chunk;
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const f = { id: null, data: null };
          for (const line of block.split("\n")) {
            if (line.startsWith("id:")) f.id = line.slice(3).trim();
            else if (line.startsWith("data:")) f.data = JSON.parse(line.slice(5).trim());
          }
          if (f.data) s.frames.push(f);
        }
      }
    } catch {
      /* aborted */
    }
    s.ended = true;
  })();
  s.waitFor = (pred, label = "an event on the stream") => until(() => s.frames.find((f) => pred(f.data, f)), label);
  s.waitEnded = () => until(() => s.ended, "the stream to end");
  await until(() => s.raw.includes(": connected"), "the connected comment");
  return s;
}

const chat = (method, url, token, body) => w.http(method, `/chat${url}`, token, body);
const open = (token, subject_type, subject_id) => chat("POST", "/conversations", token, { subject_type, subject_id });
async function send(token, cid, body, status = 201) {
  const r = await chat("POST", `/conversations/${cid}/messages`, token, { body });
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
}
async function unread(token) {
  const r = await chat("GET", "/unread-count", token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.unread;
}
async function listUnread(token, cid) {
  const r = await chat("GET", "/conversations?limit=50", token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = r.body.rows.find((x) => x.id === cid);
  return row ? row.unread_count : null;
}
async function readAll(token, cid) {
  const r = await chat("GET", `/conversations/${cid}/messages?limit=1`, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.rows.length === 0) return;
  const rd = await chat("POST", `/conversations/${cid}/read`, token, { message_id: r.body.rows[0].id });
  assert.equal(rd.status, 200, JSON.stringify(rd.body));
  assert.equal(rd.body.unread_count, 0);
}
const nudgeMails = async (to) =>
  (await w.q("SELECT * FROM js_sandbox_mail WHERE to_addr = $1 AND subject = $2 ORDER BY id", [to, NUDGE_SUBJECT])).rows;
const ids = (r) => r.body.rows.map((x) => x.id);
const raw = (r) => JSON.stringify(r.body);

/** The invite mails the first sign-in code: read it from the sandbox mailbox and verify it (as orgs-e2e does). */
async function loginWithInviteCode(email) {
  await require("../modules/jobsearch/otp")._testing.flush();
  const mails = (await w.q("SELECT * FROM js_sandbox_mail WHERE to_addr = $1 AND subject = $2 ORDER BY id", [email, E.OTP_SUBJECT])).rows;
  assert.equal(mails.length, 1, "exactly one invite mail");
  const m = /\b(\d{6})\b/.exec(mails[0].body);
  assert.ok(m, "the invite mail carries a 6-digit code");
  const v = await w.http("POST", "/jobsearch/auth/otp/verify", null, { email, code: m[1] });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.body.token;
}
/** Staff creates the organisation; every address is invited as a portal user and logs in by the real OTP flow. */
async function onboardOrg(type, name, emails) {
  const base = type === "employer" ? "/crm/employers" : "/crm/agencies";
  const org = await w.http("POST", base, w.tokens.admin, { name, contact_name: "Contact", email: emails[0], country: "Germany" });
  assert.equal(org.status, 201, JSON.stringify(org.body));
  const users = [];
  for (const email of emails) {
    const inv = await w.http("POST", `${base}/${org.body.id}/invite`, w.tokens.admin, { email, full_name: `${name} User` });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    users.push({ id: inv.body.user.id, email, token: await loginWithInviteCode(email) });
  }
  return { id: org.body.id, users };
}

test.before(async () => {
  w = await E.startWorld();
  for (const [k, role] of [["admin", "Admin"], ["mgr", "Manager"], ["rec", "Receptionist"], ["agent1", "Agent"], ["agent2", "Agent"], ["hr", "HR"], ["acct", "Accountant"]]) await E.addStaff(w, k, role);
});
test.after(async () => {
  for (const s of streams) s.close();
  hub.shutdown();
  nudges.setClock();
  if (w) await w.close().catch(() => {});
  assert.deepEqual(E.blockedNetwork, [], "no network call left the test process");
});

// shared state of the journey
const S = {};

// ================================================================ A  candidate journey
test("A: staff opens, the candidate gets a content-free nudge, reads over REST and SSE, replies; unread moves on both sides; cooldown", async () => {
  S.cand = await E.createCandidate(w, "alpha", "rec");
  const c = S.cand;
  const o1 = await open(w.tokens.rec, "candidate", c.id);
  assert.equal(o1.status, 201, JSON.stringify(o1.body));
  const o2 = await open(w.tokens.rec, "candidate", c.id);
  assert.equal(o2.status, 200, "open is idempotent per subject");
  assert.equal(o2.body.id, o1.body.id);
  S.cv = o1.body.id;

  const candSse = await openSse(c.token);
  const recSse = await openSse(w.tokens.rec);
  S.candSse = candSse;

  const t1 = text("staff-1");
  const m1 = await send(w.tokens.rec, S.cv, t1);
  await settle();

  // exactly one e-mail, content free, to the candidate only
  const mails = await nudgeMails(c.email);
  assert.equal(mails.length, 1, "one nudge");
  const hay = `${mails[0].subject}\n${mails[0].body}\n${JSON.stringify(mails[0].headers)}`;
  for (const secret of [t1, "Receptionist", "Candidate alpha", "visa", "job offer"]) assert.ok(!hay.includes(secret), `the nudge leaks ${secret}`);
  assert.match(mails[0].body, /new message/i);
  assert.equal((await nudgeMails("rec-receptionist@test.invalid")).length, 0, "staff get no e-mail");

  // SSE: the candidate gets an event with ids only
  const ev = await candSse.waitFor((d) => d.kind === "message" && d.message_id === m1.id);
  assert.equal(ev.data.conversation_id, S.cv);
  assert.equal(ev.id, String(m1.id), "the SSE id is the message id (Last-Event-ID)");

  // REST read + unread
  assert.equal(await unread(c.token), 1);
  assert.equal(await listUnread(c.token, S.cv), 1);
  assert.equal(await unread(w.tokens.rec), 0, "own messages are never unread");
  const thread = await chat("GET", `/conversations/${S.cv}/messages`, c.token);
  assert.equal(thread.status, 200);
  assert.equal(thread.body.rows.length, 1);
  assert.equal(thread.body.rows[0].body, t1);
  assert.equal(thread.body.rows[0].sender_role, "staff");
  assert.equal(thread.body.rows[0].mine, false);
  assert.equal("sender_user_id" in thread.body.rows[0], false, "no foreign account ids for an external viewer");
  const rd = await chat("POST", `/conversations/${S.cv}/read`, c.token, { message_id: m1.id });
  assert.equal(rd.body.unread_count, 0);
  assert.equal(await unread(c.token), 0);

  // reply
  const t2 = text("cand-1");
  const m2 = await send(c.token, S.cv, t2);
  assert.equal(m2.mine, true);
  await settle();
  await recSse.waitFor((d) => d.kind === "message" && d.message_id === m2.id);
  assert.equal(await unread(w.tokens.rec), 1);
  assert.equal(await listUnread(w.tokens.rec, S.cv), 1);
  assert.equal(await unread(c.token), 0, "replying does not create unread for the sender");
  assert.equal((await nudgeMails("rec-receptionist@test.invalid")).length, 0, "a reply from outside never e-mails staff");

  // second staff message inside the cooldown: no second e-mail, but unread and SSE still work
  const m3 = await send(w.tokens.rec, S.cv, text("staff-2"));
  await settle();
  assert.equal((await nudgeMails(c.email)).length, 1, "no second nudge inside the cooldown");
  await candSse.waitFor((d) => d.kind === "message" && d.message_id === m3.id);
  assert.equal(await unread(c.token), 1);
  await readAll(w.tokens.rec, S.cv);
  assert.equal(await unread(w.tokens.rec), 0);
  S.lastStaffMsg = m3.id;
});

// ================================================================ B  assignment moves visibility
test("B: an unassigned Agent gets the identical 404; reassignment moves visibility at once and the old staff loses it", async () => {
  const c = S.cand;
  const missing = await chat("GET", "/conversations/2000000000/messages", w.tokens.agent1);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, NOT_FOUND);
  for (const [m, u, b] of [["GET", `/conversations/${S.cv}/messages`], ["POST", `/conversations/${S.cv}/messages`, { body: "x" }], ["POST", `/conversations/${S.cv}/read`, { message_id: S.lastStaffMsg }]]) {
    const r = await chat(m, u, w.tokens.agent1, b);
    assert.equal(r.status, 404, `${m} ${u}`);
    assert.deepEqual(r.body, NOT_FOUND, "identical to a nonexistent id");
  }
  assert.equal((await open(w.tokens.agent1, "candidate", c.id)).status, 404, "cannot open for a candidate that is not theirs");
  assert.equal((await chat("GET", "/conversations?limit=50", w.tokens.agent1)).body.rows.length, 0);
  assert.equal(await unread(w.tokens.agent1), 0);
  // Managers see everything
  assert.equal((await chat("GET", `/conversations/${S.cv}/messages`, w.tokens.mgr)).status, 200);

  const agentSse = await openSse(w.tokens.agent1);
  const recSse = await openSse(w.tokens.rec);

  // reassign to agent1 (Admin may): visibility moves immediately
  const put = await w.http("PUT", `/candidates/${c.id}`, w.tokens.admin, { assigned_to: w.users.agent1 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await chat("GET", `/conversations/${S.cv}/messages`, w.tokens.agent1)).status, 200, "new owner sees the thread");
  assert.ok(ids(await chat("GET", "/conversations?limit=50", w.tokens.agent1)).includes(S.cv));
  for (const [m, u, b] of [["GET", `/conversations/${S.cv}/messages`], ["POST", `/conversations/${S.cv}/messages`, { body: "x" }]]) {
    const r = await chat(m, u, w.tokens.rec, b);
    assert.equal(r.status, 404, `old staff ${m} ${u}`);
    assert.deepEqual(r.body, NOT_FOUND);
  }
  assert.equal((await chat("GET", "/conversations?limit=50", w.tokens.rec)).body.rows.length, 0);

  // events follow: the new owner's stream gets the candidate's next message, the old owner's stream never does
  const m = await send(c.token, S.cv, text("cand-after-reassign"));
  await settle();
  await agentSse.waitFor((d) => d.kind === "message" && d.message_id === m.id);
  assert.equal(recSse.frames.filter((f) => f.data.conversation_id === S.cv).length, 0, "the old owner's stream is not served");
  // the new owner can reply; the candidate sees the reply
  const reply = await send(w.tokens.agent1, S.cv, text("agent1-reply"));
  assert.equal((await chat("GET", `/conversations/${S.cv}/messages`, c.token)).body.rows[0].id, reply.id);
  await readAll(w.tokens.agent1, S.cv);
  await readAll(c.token, S.cv);
});

// ================================================================ C  employer
test("C: two users of one employer share one thread with staff; another employer sees nothing", async () => {
  const empA = await onboardOrg("employer", "Alpha Bau GmbH", ["hr1@alpha-bau.test.invalid", "hr2@alpha-bau.test.invalid"]);
  const empB = await onboardOrg("employer", "Beta Montage Ltd", ["hr@beta-montage.test.invalid"]);
  S.empA = empA;
  S.empB = empB;
  const [a1, a2] = empA.users;
  const b1 = empB.users[0];

  // employers cannot start; staff (Manager) opens for the organisation
  assert.equal((await open(a1.token, "employer_request", empA.id)).status, 403);
  const o = await open(w.tokens.mgr, "employer_request", empA.id);
  assert.equal(o.status, 201, JSON.stringify(o.body));
  S.ev = o.body.id;
  assert.equal((await open(w.tokens.rec, "employer_request", empA.id)).status, 404, "a Receptionist cannot serve an organisation");

  const a2Sse = await openSse(a2.token);
  const b1Sse = await openSse(b1.token);
  const t1 = text("mgr-to-emp");
  const m1 = await send(w.tokens.mgr, S.ev, t1);
  await settle();
  for (const u of [a1, a2]) {
    assert.equal((await nudgeMails(u.email)).length, 1, `${u.email} nudged once`);
    assert.equal((await nudgeMails(u.email))[0].body.includes(t1), false);
    assert.equal(await unread(u.token), 1);
  }
  assert.equal((await nudgeMails(b1.email)).length, 0);
  await a2Sse.waitFor((d) => d.kind === "message" && d.message_id === m1.id);
  assert.equal(b1Sse.frames.length, 0, "the other employer's stream hears nothing");

  // user 1 replies; user 2 sees it in the shared thread; staff sees both
  const m2 = await send(a1.token, S.ev, text("emp-user1"));
  const view2 = await chat("GET", `/conversations/${S.ev}/messages`, a2.token);
  assert.deepEqual(ids(view2), [m2.id, m1.id]);
  assert.equal(view2.body.rows[0].mine, false, "user 2 did not write it");
  assert.equal((await chat("GET", `/conversations/${S.ev}/messages`, a1.token)).body.rows[0].mine, true);
  const m3 = await send(a2.token, S.ev, text("emp-user2"));
  const staffView = await chat("GET", `/conversations/${S.ev}/messages`, w.tokens.mgr);
  assert.deepEqual(ids(staffView), [m3.id, m2.id, m1.id]);

  // employer B sees nothing of A
  assert.equal((await chat("GET", "/conversations?limit=50", b1.token)).body.rows.length, 0);
  assert.equal(await unread(b1.token), 0);
  for (const [m, u, b] of [["GET", `/conversations/${S.ev}/messages`], ["POST", `/conversations/${S.ev}/messages`, { body: "x" }], ["POST", `/conversations/${S.ev}/read`, { message_id: m1.id }]]) {
    const r = await chat(m, u, b1.token, b);
    assert.equal(r.status, 404, `${m} ${u}`);
    assert.deepEqual(r.body, NOT_FOUND);
  }
  // staff roles without a link to the organisation
  for (const k of ["rec", "agent1", "agent2"]) assert.equal((await chat("GET", `/conversations/${S.ev}/messages`, w.tokens[k])).status, 404, k);
  assert.equal((await chat("GET", `/conversations/${S.ev}/messages`, S.cand.token)).status, 404, "a candidate cannot read an employer thread");
});

// ================================================================ D  agency
test("D: an agency's users share one thread with staff; another agency sees nothing", async () => {
  const agA = await onboardOrg("agency", "Atlas Recruiting", ["desk@atlas.test.invalid", "desk2@atlas.test.invalid"]);
  const agB = await onboardOrg("agency", "Boussole Agency", ["desk@boussole.test.invalid"]);
  const [a1, a2] = agA.users;
  const b1 = agB.users[0];
  const o = await open(w.tokens.admin, "agency", agA.id);
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const cid = o.body.id;
  S.agy = cid;
  assert.equal((await open(a1.token, "agency", agA.id)).status, 403, "agencies cannot start");
  const m1 = await send(w.tokens.admin, cid, text("admin-to-agency"));
  await settle();
  for (const u of [a1, a2]) assert.equal((await nudgeMails(u.email)).length, 1);
  assert.equal((await nudgeMails(b1.email)).length, 0);
  const m2 = await send(a2.token, cid, text("agency-user2"));
  assert.deepEqual(ids(await chat("GET", `/conversations/${cid}/messages`, a1.token)), [m2.id, m1.id]);
  assert.equal(await unread(a1.token), 2, "user 1 has not read either message yet (own ones excluded only for the sender)");
  assert.equal((await chat("GET", "/conversations?limit=50", b1.token)).body.rows.length, 0);
  assert.deepEqual((await chat("GET", `/conversations/${cid}/messages`, b1.token)).body, NOT_FOUND);
  assert.deepEqual((await chat("GET", `/conversations/${cid}/messages`, S.empB.users[0].token)).body, NOT_FOUND, "an employer cannot read an agency thread");
  assert.deepEqual((await chat("GET", `/conversations/${S.ev}/messages`, a1.token)).body, NOT_FOUND, "an agency cannot read an employer thread");
});

// ================================================================ E  moderation
test("E: a hidden message is a stub without text for the candidate, SSE says hidden, unread unaffected; unhide restores it", async () => {
  const c = S.cand;
  const candSse = await openSse(c.token);
  const victim = await send(w.tokens.agent1, S.cv, text("to-be-hidden"));
  await settle();
  const hiddenText = (await w.one("SELECT body FROM chat_messages WHERE id = $1", [victim.id])).body;
  await readAll(c.token, S.cv);
  assert.equal(await unread(c.token), 0);

  // who may not moderate
  assert.equal((await chat("POST", `/messages/${victim.id}/hide`, w.tokens.agent1, { reason: "x" })).status, 403, "Agent");
  assert.equal((await chat("POST", `/messages/${victim.id}/hide`, w.tokens.rec, { reason: "x" })).status, 403, "Receptionist");
  assert.equal((await chat("POST", `/messages/${victim.id}/hide`, c.token, { reason: "x" })).status, 403, "Candidate");
  assert.equal((await chat("POST", `/messages/${victim.id}/hide`, S.empA.users[0].token, { reason: "x" })).status, 403, "Employer");
  assert.equal((await chat("POST", `/messages/${victim.id}/hide`, w.tokens.mgr, {})).status, 400, "a reason is required");

  const h = await chat("POST", `/messages/${victim.id}/hide`, w.tokens.mgr, { reason: "contact details shared" });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.hidden, true);
  assert.equal(h.body.hidden_reason, "contact details shared");
  await settle();

  // candidate: stub in the list, nothing of the text anywhere in the response, unread unchanged
  const list = await chat("GET", `/conversations/${S.cv}/messages`, c.token);
  const stub = list.body.rows.find((x) => x.id === victim.id);
  assert.deepEqual(Object.keys(stub).sort(), ["created_at", "hidden", "id"]);
  assert.equal(stub.hidden, true);
  assert.ok(!raw(list).includes(hiddenText), "the text is not in the response");
  assert.ok(!raw(list).includes("contact details shared"), "nor the moderation reason");
  const convs = await chat("GET", "/conversations?limit=50", c.token);
  assert.ok(!raw(convs).includes(hiddenText));
  assert.deepEqual(Object.keys(convs.body.rows.find((x) => x.id === S.cv).last_message).sort(), ["created_at", "hidden", "id"], "last message preview is a stub too");
  assert.equal(await unread(c.token), 0, "hiding a read message does not change unread");
  const ev = await candSse.waitFor((d) => d.kind === "hidden" && d.message_id === victim.id);
  assert.equal(ev.data.conversation_id, S.cv);
  assert.ok(!candSse.raw.includes(hiddenText));
  // staff still see text and reason
  const staff = (await chat("GET", `/conversations/${S.cv}/messages`, w.tokens.mgr)).body.rows.find((x) => x.id === victim.id);
  assert.equal(staff.body, hiddenText);
  assert.equal(staff.hidden_reason, "contact details shared");
  assert.equal(await w.count("SELECT count(*) AS n FROM audit_logs WHERE action = 'chat.message.hide' AND record_id = $1", [String(victim.id)]), 1);

  // a hidden message that was still unread is not counted
  const second = await send(w.tokens.agent1, S.cv, text("hidden-while-unread"));
  assert.equal(await unread(c.token), 1);
  assert.equal((await chat("POST", `/messages/${second.id}/hide`, w.tokens.mgr, { reason: "spam" })).status, 200);
  assert.equal(await unread(c.token), 0, "hidden messages are not unread");
  assert.equal((await chat("POST", `/messages/${second.id}/unhide`, w.tokens.mgr, {})).status, 200);
  assert.equal(await unread(c.token), 1, "unhide brings an unread message back");
  await readAll(c.token, S.cv);

  // unhide restores the text for the candidate (and says hidden over SSE: clients refetch)
  const before = candSse.frames.length;
  const u = await chat("POST", `/messages/${victim.id}/unhide`, w.tokens.mgr, {});
  assert.equal(u.status, 200, JSON.stringify(u.body));
  await settle();
  await until(() => candSse.frames.length > before, "the unhide event");
  assert.equal(candSse.frames.slice(before).some((f) => f.data.kind === "hidden" && f.data.message_id === victim.id), true, "unhide is announced as kind hidden (documented)");
  const back = (await chat("GET", `/conversations/${S.cv}/messages`, c.token)).body.rows.find((x) => x.id === victim.id);
  assert.equal(back.body, hiddenText);
  assert.equal(back.hidden, false);
  assert.equal(await unread(c.token), 0);
});

// ================================================================ F  close / reopen
test("F: close -> send 409 for everyone -> reopen -> send OK; only moderators may close", async () => {
  const c = S.cand;
  assert.equal((await chat("POST", `/conversations/${S.cv}/close`, w.tokens.agent1)).status, 403);
  assert.equal((await chat("POST", `/conversations/${S.cv}/close`, c.token)).status, 403);
  const stream = await openSse(c.token);
  const cl = await chat("POST", `/conversations/${S.cv}/close`, w.tokens.mgr);
  assert.equal(cl.status, 200, JSON.stringify(cl.body));
  assert.equal(cl.body.status, "closed");
  await settle();
  await stream.waitFor((d) => d.kind === "closed" && d.conversation_id === S.cv);
  const refused = await chat("POST", `/conversations/${S.cv}/messages`, c.token, { body: "still there?" });
  assert.equal(refused.status, 409);
  assert.equal((await chat("POST", `/conversations/${S.cv}/messages`, w.tokens.agent1, { body: "still there?" })).status, 409);
  assert.equal((await chat("GET", `/conversations/${S.cv}/messages`, c.token)).status, 200, "a closed thread can still be read");
  const n = await w.count("SELECT count(*) AS n FROM chat_messages WHERE conversation_id = $1", [S.cv]);
  const re = await chat("POST", `/conversations/${S.cv}/reopen`, w.tokens.mgr);
  assert.equal(re.body.status, "open");
  await settle();
  await stream.waitFor((d) => d.kind === "reopened" && d.conversation_id === S.cv);
  await send(c.token, S.cv, text("after-reopen"));
  assert.equal(await w.count("SELECT count(*) AS n FROM chat_messages WHERE conversation_id = $1", [S.cv]), n + 1, "the refused sends wrote nothing");
});

// ================================================================ G  role matrix
test("G: HR / Accountant reach /chat but only their staff rooms (empty list, identical 404 elsewhere, no open / moderate); portal tokens are denied on the other route classes", async () => {
  for (const k of ["hr", "acct"]) {
    const list = await chat("GET", "/conversations", w.tokens[k]);
    assert.equal(list.status, 200, `${k} list`);
    assert.deepEqual(list.body.rows, [], `${k} sees no candidate / employer / agency conversation`);
    assert.deepEqual((await chat("GET", "/unread-count", w.tokens[k])).body, { unread: 0, conversations: 0 });
    for (const [m, u, b] of [["GET", `/conversations/${S.cv}/messages`], ["POST", `/conversations/${S.cv}/messages`, { body: "x" }], ["POST", `/conversations/${S.cv}/read`, { message_id: 1 }]]) {
      const r = await chat(m, u, w.tokens[k], b);
      assert.equal(r.status, 404, `${k} ${m} /chat${u}`);
      assert.deepEqual(r.body, { error: "Not found" });
    }
    for (const [m, u, b] of [["POST", "/conversations", { subject_type: "candidate", subject_id: S.cand.id }], ["POST", `/conversations/${S.cv}/close`, {}]]) assert.equal((await chat(m, u, w.tokens[k], b)).status, 403, `${k} ${m} /chat${u}`);
    assert.equal((await chat("GET", "/prefs", w.tokens[k])).status, 200);
    assert.equal((await openSse(w.tokens[k])).status, 200, `${k} SSE opens (and sees only its rooms)`);
  }
  // an explicit staff room is the one thing HR sees: created by a manager, written in by HR, invisible to the Accountant
  const room = await chat("POST", "/conversations", w.tokens.mgr, { subject_type: "staff", title: "G room", participant_user_ids: [w.users.hr] });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  assert.equal((await chat("POST", `/conversations/${room.body.id}/messages`, w.tokens.hr, { body: "HR here" })).status, 201);
  assert.ok((await chat("GET", "/conversations", w.tokens.hr)).body.rows.some((r) => r.id === room.body.id));
  assert.equal((await chat("GET", `/conversations/${room.body.id}/messages`, w.tokens.acct)).status, 404);
  // anonymous
  for (const [m, u] of [["GET", "/conversations"], ["GET", "/events"], ["GET", "/unread-count"]]) assert.equal((await chat(m, u, null)).status, 401, `anonymous ${u}`);

  // Candidate / Employer / Agency stay out of every other route class (spot check; the sweep covers all routes)
  const actors = { Candidate: S.cand.token, Employer: S.empA.users[0].token, Agency: S.agy && (await onboardTokenForAgency()) };
  const gets = ["/crm/leads", "/crm/employers", "/crm/agencies", "/candidates/all", "/hr/employees", "/hr/staff", "/finance/invoices", "/jobsearch/scheduler/status", "/jobsearch/automation-rules"];
  const posts = [["/candidates/add", { full_name: "x", passport_number: "ZZ1" }], ["/crm/leads", { full_name: "x" }], ["/hr/clock-in", {}], ["/auth/register", { full_name: "x", email: "x@test.invalid", password: "x", role: "Admin" }]];
  const candBefore = await w.count("SELECT count(*) AS n FROM candidates");
  const usersBefore = await w.count("SELECT count(*) AS n FROM users");
  for (const [name, tok] of Object.entries(actors)) {
    for (const u of gets) assert.equal((await w.http("GET", u, tok)).status, 403, `${name} GET ${u}`);
    for (const [u, b] of posts) assert.equal((await w.http("POST", u, tok, b)).status, 403, `${name} POST ${u}`);
  }
  assert.equal((await w.http("GET", "/employer/me", S.cand.token)).status, 403);
  assert.equal((await w.http("GET", "/agency/me", S.empA.users[0].token)).status, 403);
  assert.equal(await w.count("SELECT count(*) AS n FROM candidates"), candBefore);
  assert.equal(await w.count("SELECT count(*) AS n FROM users"), usersBefore);
  // positive control: they do reach /chat
  for (const tok of Object.values(actors)) assert.equal((await chat("GET", "/unread-count", tok)).status, 200);
});
let agencyToken = null;
async function onboardTokenForAgency() {
  if (agencyToken) return agencyToken;
  const ag = await onboardOrg("agency", "Sweep Agency", ["sweep@agency.test.invalid"]);
  agencyToken = ag.users[0].token;
  return agencyToken;
}

// ================================================================ H  rate limit
test("H: above CHAT_RATE_PER_MIN the sender gets 429 with Retry-After; other users are unaffected", async () => {
  const cB = await E.createCandidate(w, "bravo", "agent2");
  const o = await open(w.tokens.agent2, "candidate", cB.id);
  assert.equal(o.status, 201);
  S.candB = cB;
  S.cvB = o.body.id;
  process.env.CHAT_RATE_PER_MIN = "3";
  try {
    for (let i = 0; i < 3; i++) await send(w.tokens.agent2, S.cvB, text(`rate-${i}`));
    const r = await chat("POST", `/conversations/${S.cvB}/messages`, w.tokens.agent2, { body: text("rate-over") });
    assert.equal(r.status, 429, JSON.stringify(r.body));
    const ra = Number(r.headers.get("retry-after"));
    assert.ok(Number.isInteger(ra) && ra >= 1 && ra <= 60, `Retry-After ${ra}`);
    assert.equal(await w.count("SELECT count(*) AS n FROM chat_messages WHERE conversation_id = $1", [S.cvB]), 3, "the refused message was not stored");
    // the limit follows the sender across conversations
    assert.equal((await chat("POST", `/conversations/${S.cv}/messages`, w.tokens.agent2, { body: "x" })).status, 404, "(not their conversation: still 404, not 429)");
    // another user is not limited by it
    await send(cB.token, S.cvB, text("rate-other-user"));
  } finally {
    process.env.CHAT_RATE_PER_MIN = "1000";
  }
  await send(w.tokens.agent2, S.cvB, text("rate-restored"));
});

// ================================================================ I  opt-out and cooldown expiry
test("I: a candidate can opt out of nudges and is honoured; after the cooldown nudges resume", async () => {
  const c = S.cand;
  const prefs = await chat("GET", "/prefs", c.token);
  assert.deepEqual(prefs.body, { email_nudges: true });
  assert.equal((await chat("PUT", "/prefs", c.token, { email_nudges: "no" })).status, 400);
  assert.deepEqual((await chat("PUT", "/prefs", c.token, { email_nudges: false })).body, { email_nudges: false });
  const mailsBefore = (await nudgeMails(c.email)).length;
  // 1 h later (injected clock): the cooldown is over, yet the opt-out wins
  const later = Date.now() + 3600 * 1000;
  nudges.setClock(() => new Date(later));
  try {
    await send(w.tokens.agent1, S.cv, text("opted-out"));
    await settle();
    assert.equal((await nudgeMails(c.email)).length, mailsBefore, "no e-mail while opted out");
    assert.deepEqual((await chat("PUT", "/prefs", c.token, { email_nudges: true })).body, { email_nudges: true });
    await send(w.tokens.agent1, S.cv, text("opted-back-in"));
    await settle();
    assert.equal((await nudgeMails(c.email)).length, mailsBefore + 1, "nudged again once back in and out of the cooldown");
    await send(w.tokens.agent1, S.cv, text("opted-back-in-2"));
    await settle();
    assert.equal((await nudgeMails(c.email)).length, mailsBefore + 1, "and the cooldown applies again");
  } finally {
    nudges.setClock();
  }
  // staff have the same preference record but are never e-mailed anyway
  assert.equal((await chat("GET", "/prefs", w.tokens.agent1)).status, 200);
});

// ================================================================ J  channels
test("J: WhatsApp reports requires_setup and nothing is ever recorded as sent; e-mail is the sandbox", async () => {
  const r = await chat("GET", "/channels", w.tokens.mgr);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.channels.map((x) => [x.channel, x]));
  assert.equal(by.in_app.status, "connected");
  assert.equal(by.whatsapp.status, "requires_setup");
  assert.match(by.whatsapp.detail, /provider account|templates/i);
  assert.equal(by.email.sends_real_mail, false, "the sandbox mailbox sends nothing");
  assert.equal(by.email.mode, "sandbox");
  for (const tok of [S.cand.token, S.empA.users[0].token]) assert.equal((await chat("GET", "/channels", tok)).status, 403);
  // an operator hook call records requires_setup, never sent; normal chat traffic never touches the outbox
  assert.equal(await w.count("SELECT count(*) AS n FROM chat_channel_outbox"), 0, "no message was routed to WhatsApp");
  const msg = await w.one("SELECT id FROM chat_messages ORDER BY id DESC LIMIT 1");
  const sent = await whatsapp.send({ messageId: Number(msg.id) });
  assert.equal(sent.accepted, false);
  assert.equal(sent.status, "requires_setup");
  const rows = (await w.q("SELECT channel, status, detail FROM chat_channel_outbox")).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows.map((x) => x.status), ["requires_setup"]);
  assert.equal(await w.count("SELECT count(*) AS n FROM chat_channel_outbox WHERE status = 'sent'"), 0);
  assert.ok(!JSON.stringify(rows).includes("E2E-SENTINEL"), "the outbox holds no message text");
  process.env.WHATSAPP_PROVIDER = "twilio";
  try {
    assert.equal(whatsapp.status().status, "requires_setup", "an unimplemented provider is still requires_setup");
  } finally {
    delete process.env.WHATSAPP_PROVIDER;
  }
});

// ================================================================ K  untrusted text
test("K: HTML, script, bidi and zero-width text is stored verbatim and returned as JSON strings", async () => {
  const c = S.cand;
  const nasty = [
    `<script>alert("x")</script><img src=x onerror=alert(1)>`,
    `<b>bold</b> &amp; &lt;i&gt; javascript:alert(1)`,
    `evil.exe\u200e isolate\u200f \u200bzero\u200dwidth\u2060 tail`,
    `ok مرحبا \u{1F600} <svg/onload=alert(1)>`,
    `"quote" 'single' \\ backslash </script> ]]> <!--`,
  ];
  for (const t of nasty) {
    const tagged = `${t} ${text("html")}`;
    const m = await send(w.tokens.agent1, S.cv, tagged);
    assert.equal(m.body, tagged);
    const db = (await w.one("SELECT body FROM chat_messages WHERE id = $1", [m.id])).body;
    assert.equal(db, tagged, "stored verbatim");
    const res = await chat("GET", `/conversations/${S.cv}/messages?limit=5`, c.token);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const row = res.body.rows.find((x) => x.id === m.id);
    assert.equal(typeof row.body, "string");
    assert.equal(row.body, tagged);
  }
  // NUL, bidi override / isolate controls and bodies with nothing visible are refused, not stored
  const n = await w.count("SELECT count(*) AS n FROM chat_messages");
  assert.equal((await chat("POST", `/conversations/${S.cv}/messages`, w.tokens.agent1, { body: "evil\u202eexe.txt" })).status, 400);
  assert.equal((await chat("POST", `/conversations/${S.cv}/messages`, w.tokens.agent1, { body: "\u200b\u200d" })).status, 400);
  assert.equal((await chat("POST", `/conversations/${S.cv}/messages`, w.tokens.agent1, { body: "a\u0000b" })).status, 400);
  assert.equal((await chat("POST", `/conversations/${S.cv}/messages`, w.tokens.agent1, { body: "x".repeat(2001) })).status, 400);
  assert.equal(await w.count("SELECT count(*) AS n FROM chat_messages"), n);
});

// ================================================================ L  concurrency
test("L: 20 parallel sends give unique ordered ids, correct counts and no e-mail storm", async () => {
  const c = S.cand;
  await settle();
  await readAll(c.token, S.cv);
  await readAll(w.tokens.agent1, S.cv);
  const total = await w.count("SELECT count(*) AS n FROM chat_messages WHERE conversation_id = $1", [S.cv]);
  const mailsBefore = (await nudgeMails(c.email)).length;
  // 1 h later so the cooldown could fire at most once for the whole burst
  const later = Date.now() + 2 * 3600 * 1000;
  nudges.setClock(() => new Date(later));
  let results;
  try {
    results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? send(w.tokens.agent1, S.cv, text(`par-staff-${i}`)) : send(c.token, S.cv, text(`par-cand-${i}`)))));
    await settle();
  } finally {
    nudges.setClock();
  }
  const got = results.map((m) => m.id);
  assert.equal(new Set(got).size, 20, "unique ids");
  assert.equal(await w.count("SELECT count(*) AS n FROM chat_messages WHERE conversation_id = $1", [S.cv]), total + 20, "no message lost");
  const rows = (await w.q("SELECT id, created_at, sender_role FROM chat_messages WHERE conversation_id = $1 ORDER BY id", [S.cv])).rows.slice(-20);
  for (let i = 1; i < rows.length; i++) assert.ok(new Date(rows[i].created_at) >= new Date(rows[i - 1].created_at), "ids follow commit order");
  const conv = await w.one("SELECT last_message_id FROM chat_conversations WHERE id = $1", [S.cv]);
  assert.equal(Number(conv.last_message_id), Math.max(...got), "the conversation pointer is the highest id");
  // thread read newest-first through the API is strictly descending with no gaps among our 20
  const page = await chat("GET", `/conversations/${S.cv}/messages?limit=50`, c.token);
  const mine = ids(page).filter((id) => got.includes(id));
  assert.deepEqual(mine, [...got].sort((a, b) => b - a));
  // unread: each side sees exactly the 10 messages of the other
  assert.equal(await listUnread(c.token, S.cv), 10);
  assert.equal(await listUnread(w.tokens.agent1, S.cv), 10);
  assert.equal(await unread(c.token), 10);
  const mailsAfter = (await nudgeMails(c.email)).length;
  assert.ok(mailsAfter - mailsBefore <= 1, `at most one nudge for the burst, got ${mailsAfter - mailsBefore}`);
  await readAll(c.token, S.cv);
  await readAll(w.tokens.agent1, S.cv);
  assert.equal(await unread(c.token), 0);
});

// ================================================================ M  deactivation
test("M: a deactivated user's token and open stream die at once", async () => {
  const cB = S.candB;
  assert.equal((await chat("GET", "/conversations", cB.token)).status, 200);
  const mailsBefore = (await nudgeMails(cB.email)).length;
  const stream = await openSse(cB.token);
  await w.q("UPDATE users SET is_active = false WHERE id = $1", [cB.userId]);
  for (const [m, u, b] of [["GET", "/conversations"], ["GET", "/unread-count"], ["GET", `/conversations/${S.cvB}/messages`], ["POST", `/conversations/${S.cvB}/messages`, { body: "hello" }], ["GET", "/prefs"]]) {
    assert.equal((await chat(m, u, cB.token, b)).status, 401, `${m} /chat${u}`);
  }
  assert.equal((await openSse(cB.token)).status, 401, "no new stream");
  assert.equal(await w.count("SELECT count(*) AS n FROM chat_messages WHERE sender_user_id = $1 AND body = 'hello'", [cB.userId]), 0);
  // the next event for that conversation ends the old stream without being written to it
  await send(w.tokens.agent2, S.cvB, text("to-deactivated"));
  await settle();
  await stream.waitEnded();
  assert.equal(stream.frames.filter((f) => f.data.kind === "message").length, 0, "nothing was delivered after the deactivation");
  assert.equal((await nudgeMails(cB.email)).length, mailsBefore, "no e-mail to a deactivated account");
  // the same for staff
  await w.q("UPDATE users SET is_active = false WHERE id = $1", [w.users.agent2]);
  assert.equal((await chat("GET", "/conversations", w.tokens.agent2)).status, 401);
  assert.equal((await openSse(w.tokens.agent2)).status, 401);
});

// ================================================================ P  staff rooms and explicit participants
test("P: a manager creates a staff room with HR, adds a Receptionist to an employer thread, removes both again - REST, SSE and the audit trail agree", async () => {
  const room = await chat("POST", "/conversations", w.tokens.mgr, { subject_type: "staff", title: "P: payroll questions", participant_user_ids: [w.users.hr, w.users.agent1] });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  const rid = room.body.id;
  const sse = { hr: await openSse(w.tokens.hr), agent1: await openSse(w.tokens.agent1), acct: await openSse(w.tokens.acct), admin: await openSse(w.tokens.admin) };
  const m1 = await send(w.tokens.hr, rid, text("room-hr"));
  const m2 = await send(w.tokens.agent1, rid, text("room-agent"));
  await settle();
  for (const k of ["hr", "agent1"]) {
    await sse[k].waitFor((d) => d.message_id === m1.id);
    await sse[k].waitFor((d) => d.message_id === m2.id);
  }
  assert.equal(await unread(w.tokens.hr), 1, "the Agent's message is unread for HR");
  for (const k of ["acct", "admin"]) assert.deepEqual(sse[k].frames.filter((f) => f.data.conversation_id === rid), [], `${k} gets nothing`);
  assert.equal((await chat("GET", `/conversations/${rid}/messages`, w.tokens.admin)).status, 404, "an Admin outside the room cannot read it");
  assert.equal(await w.count("SELECT count(*) AS n FROM js_sandbox_mail WHERE subject = $1 AND body ILIKE '%payroll%'", [NUDGE_SUBJECT]), 0);

  // a Receptionist joins the employer thread explicitly, reads and writes, and loses it again
  const cid = S.ev;
  assert.ok(cid, "the employer thread of journey C exists");
  {
    assert.equal((await chat("GET", `/conversations/${cid}/messages`, w.tokens.rec)).status, 404);
    assert.equal((await chat("POST", `/conversations/${cid}/participants`, w.tokens.mgr, { user_id: w.users.rec })).status, 201);
    assert.equal((await chat("GET", `/conversations/${cid}/messages`, w.tokens.rec)).status, 200);
    assert.equal((await chat("DELETE", `/conversations/${cid}/participants/${w.users.rec}`, w.tokens.mgr)).body.changed, true);
    assert.equal((await chat("GET", `/conversations/${cid}/messages`, w.tokens.rec)).status, 404);
  }
  assert.equal((await chat("DELETE", `/conversations/${rid}/participants/${w.users.hr}`, w.tokens.mgr)).body.changed, true);
  assert.equal((await chat("GET", `/conversations/${rid}/messages`, w.tokens.hr)).status, 404, "HR lost the room at once");
  const m3 = await send(w.tokens.agent1, rid, text("room-after-removal"));
  await settle();
  assert.ok(!sse.hr.frames.find((f) => f.data.message_id === m3.id), "and its open stream gets nothing further");
  const audit = (await w.q("SELECT action FROM audit_logs WHERE record_id LIKE $1 OR record_id = $2 ORDER BY id", [`${rid}:%`, String(rid)])).rows.map((r) => r.action);
  assert.ok(audit.includes("chat.conversation.open") && audit.includes("chat.participant.remove"), audit.join());
});

// ================================================================ N  no text on the wire except REST
test("N: no message text appears in any SSE frame or e-mail body; frames carry ids and kinds only", async () => {
  assert.ok(SENTINELS.length > 40, `sentinels recorded: ${SENTINELS.length}`);
  await settle();
  assert.ok(streams.some((s) => s.frames.length > 0));
  let frames = 0;
  for (const s of streams) {
    for (const t of SENTINELS) assert.ok(!s.raw.includes(t), `an SSE stream carried the text ${t}`);
    for (const f of s.frames) {
      frames += 1;
      assert.deepEqual(Object.keys(f.data).filter((k) => !FRAME_KEYS.has(k)), [], `unexpected key in a frame: ${JSON.stringify(f.data)}`);
      assert.ok(["message", "hidden", "closed", "reopened", "read"].includes(f.data.kind));
    }
    assert.ok(!/E2E-SENTINEL|<script|alert\(/.test(s.raw));
  }
  assert.ok(frames > 20, `frames inspected: ${frames}`);
  const mails = (await w.q("SELECT * FROM js_sandbox_mail ORDER BY id")).rows;
  const nudgesSent = mails.filter((m) => m.subject === NUDGE_SUBJECT);
  assert.ok(nudgesSent.length >= 6, `nudges inspected: ${nudgesSent.length}`);
  for (const m of mails) {
    const hay = `${m.subject}\n${m.body}\n${JSON.stringify(m.headers)}`;
    for (const t of SENTINELS) assert.ok(!hay.includes(t), `a mail carried the text ${t}`);
    assert.ok(!/<script|alert\(/.test(hay));
  }
  // nudges are the one fixed text for everybody
  assert.equal(new Set(nudgesSent.map((m) => m.body)).size, 1);
  // the audit log never holds message text either
  const audit = JSON.stringify((await w.q("SELECT old_data, new_data FROM audit_logs WHERE action LIKE 'chat.%'")).rows);
  for (const t of SENTINELS) assert.ok(!audit.includes(t), "audit log carried message text");
  assert.equal(await w.count("SELECT count(*) AS n FROM audit_logs WHERE action = 'chat.message.send'"), await w.count("SELECT count(*) AS n FROM chat_messages"), "every message is audited");
});

// ================================================================ O  sweep (last: spawnSync blocks this process's event loop)
test("O: the all-routes authorization sweep file still passes (child process)", () => {
  const r = spawnSync(process.execPath, ["--test", path.join(__dirname, "orgs-route-sweep.test.js")], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", NODE_TEST_CONTEXT: undefined }, timeout: 240000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-3000));
  assert.match(r.stdout, /# pass [1-9]/, "the sweep actually ran");
  assert.match(r.stdout, /# fail 0/);
});
