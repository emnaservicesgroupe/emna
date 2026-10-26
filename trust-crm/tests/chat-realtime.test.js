// Stage 6, Task 3: realtime events (SSE hub), e-mail nudges, preferences and honest channel status. Real Postgres, real HTTP, real SSE
// connections read with fetch; no event ever carries message text; cooldowns use an injected clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "chat-realtime-test-secret";
process.env.CHAT_RATE_PER_MIN = "100000";
delete process.env.CHAT_CANDIDATE_CAN_START;
delete process.env.CHAT_NUDGE_COOLDOWN_MIN;
delete process.env.SITE_BASE_URL;
delete process.env.WHATSAPP_PROVIDER;
delete process.env.MAIL_PROVIDER;
delete process.env.MAIL_SANDBOX_ALLOWLIST;

const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser, portalToken } = require("./helpers/orgs");
const hub = require("../modules/chat/hub");
const nudges = require("../modules/chat/nudges");
const whatsapp = require("../modules/chat/whatsapp");
const mail = require("../modules/jobsearch/mail");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(15);
  }
}

// ------------------------------------------------------------------------------------------------ world
let worldPromise = null;
const world = () => (worldPromise ||= build());
const streams = [];
test.afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await until(() => hub.stats().subscribers === 0, 5000, "streams to be released");
  nudges.setClock();
  delete process.env.CHAT_SSE_MAX_PER_USER;
  delete process.env.CHAT_SSE_HEARTBEAT_MS;
  delete process.env.SITE_BASE_URL;
  delete process.env.WHATSAPP_PROVIDER;
  delete process.env.MAIL_PROVIDER;
});
test.after(async () => {
  hub.shutdown();
  if (worldPromise) await (await worldPromise).close().catch(() => {});
});

let n = 0;
async function build() {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = (sql, p) => pool.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  const http = async (method, url, token, body, raw) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined && raw === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const w = { pool, q, one, http, base, T: {}, id: {}, server, close: async () => {
    await new Promise((r) => server.close(r));
    await cleanup();
  } };
  w.mkStaff = async (key, role) => {
    n += 1;
    const id = (await one("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x',$3,true) RETURNING id", [`${role} ${key}`, `${key}-${n}-${process.pid}@staff.test.invalid`, role])).id;
    w.id[key] = id;
    w.T[key] = jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return id;
  };
  for (const [k, r] of [["admin", "Admin"], ["mgr", "Manager"], ["agent1", "Agent"], ["agent2", "Agent"], ["hr", "HR"], ["acct", "Accountant"]]) await w.mkStaff(k, r);
  /** Candidate with an account user whose e-mail is on the sandbox allow-list (*@test.invalid). */
  w.mkCandidate = async (key, assignedTo) => {
    n += 1;
    const c = await one("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`Cand ${key}`, `RT-PP-${n}-${process.pid}`, assignedTo ?? null]);
    const email = `cand-${key}-${n}-${process.pid}@test.invalid`;
    const uid = (await one("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x','Candidate',true) RETURNING id", [`Cand User ${key}`, email])).id;
    await q("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [uid, c.id]);
    return { id: c.id, userId: uid, email, token: portalToken(uid, "Candidate") };
  };
  w.openAs = (token, type, id) => http("POST", "/chat/conversations", token, { subject_type: type, subject_id: id });
  w.send = (token, cid, body) => http("POST", `/chat/conversations/${cid}/messages`, token, { body });
  w.openConv = async (type, id) => {
    const r = await w.openAs(w.T.mgr, type, id);
    assert.ok([200, 201].includes(r.status), r.text);
    return r.body.id;
  };
  w.outbound = async (to) => mail.sandbox.listOutbound({ to });
  return w;
}

// ------------------------------------------------------------------------------------------------ SSE client
async function openSse(token, { lastEventId } = {}) {
  const w = await world();
  const ac = new AbortController();
  const res = await fetch(`${w.base}/chat/events`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(lastEventId !== undefined ? { "last-event-id": String(lastEventId) } : {}) },
    signal: ac.signal,
  });
  const s = { status: res.status, frames: [], comments: [], raw: "", ended: false, ac, body: null };
  streams.push(s);
  s.close = () => ac.abort();
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
            if (line.startsWith(":")) s.comments.push(line);
            else if (line.startsWith("id:")) f.id = line.slice(3).trim();
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
  s.find = (pred) => s.frames.find((f) => pred(f.data, f));
  s.waitFor = (pred, ms = 4000) => until(() => s.find(pred), ms, "an event on the stream");
  s.waitEnded = (ms = 4000) => until(() => s.ended, ms, "the stream to end");
  await until(() => s.raw.includes(": connected"), 4000, "connected comment");
  return s;
}
/** After every queued delivery finished, give the sockets a moment to flush. */
const settle = async () => {
  await hub.idle();
  await sleep(120);
};
const ofConv = (s, cid) => s.frames.filter((f) => f.data.conversation_id === cid);

// shared fixture: candidate A (agent1) / B (agent2), employers A (2 users) / B, one conversation each
let fixture = null;
async function fx() {
  if (fixture) return fixture;
  const w = await world();
  const f = { w };
  f.candA = await w.mkCandidate("A", w.id.agent1);
  f.candB = await w.mkCandidate("B", w.id.agent2);
  f.empA = await createEmployerUser(w.pool, { orgName: "RT Employer A", email: `empa-${process.pid}@test.invalid` });
  f.empB = await createEmployerUser(w.pool, { orgName: "RT Employer B", email: `empb-${process.pid}@test.invalid` });
  f.agyA = await createAgencyUser(w.pool, { orgName: "RT Agency A", email: `agya-${process.pid}@test.invalid` });
  f.cvA = await w.openConv("candidate", f.candA.id);
  f.cvB = await w.openConv("candidate", f.candB.id);
  f.evA = await w.openConv("employer_request", f.empA.orgId);
  f.evB = await w.openConv("employer_request", f.empB.orgId);
  f.avA = await w.openConv("agency", f.agyA.orgId);
  fixture = f;
  return f;
}
const cleanMail = async (w) => {
  await nudges.idle();
  await w.q("DELETE FROM js_sandbox_mail");
  await w.q("DELETE FROM chat_nudges");
};

// ================================================================================================ routes: auth and roles
test("new routes: anonymous 401, malformed token 400, HR / Accountant 403, channels staff-only, prefs for every allowed actor", async () => {
  const f = await fx();
  const { w } = f;
  for (const [m, u] of [["GET", "/chat/events"], ["GET", "/chat/prefs"], ["PUT", "/chat/prefs"], ["GET", "/chat/channels"]]) {
    assert.equal((await w.http(m, u, null, m === "PUT" ? {} : undefined)).status, 401, `anon ${m} ${u}`);
    assert.equal((await w.http(m, u, "not-a-token", m === "PUT" ? {} : undefined)).status, 400, `bad token ${m} ${u}`);
    for (const k of ["hr", "acct"]) assert.equal((await w.http(m, u, w.T[k], m === "PUT" ? { email_nudges: true } : undefined)).status, 403, `${k} ${m} ${u}`);
  }
  const hrStream = await openSse(w.T.hr);
  assert.equal(hrStream.status, 403);
  assert.equal(hub.stats().subscribers, 0);
  // Prefs: every allowed role.
  for (const tok of [w.T.mgr, w.T.agent1, w.T.admin, f.candA.token, f.empA.token, f.agyA.token]) {
    const g = await w.http("GET", "/chat/prefs", tok);
    assert.equal(g.status, 200);
    assert.equal(typeof g.body.email_nudges, "boolean");
  }
  // Channels: staff only.
  for (const tok of [f.candA.token, f.empA.token, f.agyA.token]) assert.equal((await w.http("GET", "/chat/channels", tok)).status, 403);
  for (const k of ["admin", "mgr", "agent1"]) assert.equal((await w.http("GET", "/chat/channels", w.T[k])).status, 200);
  // Events: every allowed role opens a stream; a bad Last-Event-ID is a 400.
  for (const tok of [w.T.admin, w.T.mgr, w.T.agent1, f.candA.token, f.empA.token, f.agyA.token]) assert.equal((await openSse(tok)).status, 200);
  for (const bad of ["abc", "-1", "1.5", "9".repeat(30)]) assert.equal((await openSse(w.T.mgr, { lastEventId: bad })).status, 400, `Last-Event-ID ${bad}`);
});

// ================================================================================================ SSE scoping
test("events reach only users with access: employer A vs B, candidate A vs B, staff assigned vs unassigned; ids and kinds only, never text", async () => {
  const f = await fx();
  const { w } = f;
  const S = {
    empA: await openSse(f.empA.token), empB: await openSse(f.empB.token),
    candA: await openSse(f.candA.token), candB: await openSse(f.candB.token),
    agyA: await openSse(f.agyA.token),
    agent1: await openSse(w.T.agent1), agent2: await openSse(w.T.agent2), mgr: await openSse(w.T.mgr), admin: await openSse(w.T.admin),
  };
  const SENT = "SENTINEL-TEXT-ONLY-IN-BODY-7731";
  const r1 = await w.send(w.T.mgr, f.cvA, `${SENT} to candidate A`);
  assert.equal(r1.status, 201);
  const r2 = await w.send(w.T.mgr, f.evA, `${SENT} to employer A`);
  assert.equal(r2.status, 201);
  await settle();
  const ids = (s, cid) => ofConv(s, cid).map((fr) => fr.data.message_id);
  // candidate conversation A: candidate A, agent1 (assigned), mgr, admin - nobody else
  for (const k of ["candA", "agent1", "mgr", "admin"]) assert.deepEqual(ids(S[k], f.cvA), [r1.body.id], `${k} sees cvA`);
  for (const k of ["candB", "agent2", "empA", "empB", "agyA"]) assert.deepEqual(ofConv(S[k], f.cvA), [], `${k} must not see cvA`);
  // employer conversation A: employer A user, mgr, admin; not employer B, not agents without participation, not candidates
  for (const k of ["empA", "mgr", "admin"]) assert.deepEqual(ids(S[k], f.evA), [r2.body.id], `${k} sees evA`);
  for (const k of ["empB", "agyA", "candA", "candB", "agent1", "agent2"]) assert.deepEqual(ofConv(S[k], f.evA), [], `${k} must not see evA`);
  // shape: only ids and kind; the text (and the other party's data) is never in a frame
  for (const s of Object.values(S)) {
    assert.ok(!s.raw.includes(SENT), "no message text in any stream");
    for (const fr of s.frames) {
      assert.deepEqual(Object.keys(fr.data).sort(), ["conversation_id", "id", "kind", "message_id"]);
      assert.equal(fr.data.kind, "message");
      assert.equal(fr.data.id, fr.data.message_id);
      assert.equal(fr.id, String(fr.data.id));
    }
  }
  // external -> staff reaches the same audience
  const r3 = await w.send(f.candB.token, f.cvB, `${SENT} reply from B`);
  await settle();
  for (const k of ["candB", "agent2", "mgr", "admin"]) assert.ok(S[k].find((d) => d.message_id === r3.body.id), `${k} sees the reply`);
  for (const k of ["candA", "agent1", "empA", "empB", "agyA"]) assert.deepEqual(ofConv(S[k], f.cvB), [], `${k} must not see cvB`);
  assert.ok(!Object.values(S).some((s) => s.raw.includes(SENT)));
});

test("hidden / unhidden / closed / reopened / read events: kinds and ids only; read stays on the reader's own streams", async () => {
  const f = await fx();
  const { w } = f;
  const cand = await openSse(f.candA.token);
  const candTab2 = await openSse(f.candA.token);
  const agent1 = await openSse(w.T.agent1);
  const mgr = await openSse(w.T.mgr);
  const other = await openSse(f.candB.token);
  const SENT = "HIDE-ME-SECRET-TEXT-55";
  const m = await w.send(w.T.mgr, f.cvA, SENT);
  await cand.waitFor((d) => d.kind === "message" && d.message_id === m.body.id);
  const hide = await w.http("POST", `/chat/messages/${m.body.id}/hide`, w.T.mgr, { reason: "REASON-SECRET-77" });
  assert.equal(hide.status, 200);
  await cand.waitFor((d) => d.kind === "hidden" && d.message_id === m.body.id);
  await agent1.waitFor((d) => d.kind === "hidden" && d.message_id === m.body.id);
  const again = await w.http("POST", `/chat/messages/${m.body.id}/hide`, w.T.mgr, { reason: "again" }); // no change -> no second event
  assert.equal(again.body.changed, false);
  assert.equal((await w.http("POST", `/chat/messages/${m.body.id}/unhide`, w.T.mgr, {})).status, 200);
  assert.equal((await w.http("POST", `/chat/conversations/${f.cvA}/close`, w.T.mgr)).status, 200);
  assert.equal((await w.http("POST", `/chat/conversations/${f.cvA}/reopen`, w.T.mgr)).status, 200);
  for (const s of [cand, agent1, mgr]) {
    await s.waitFor((d) => d.kind === "closed" && d.conversation_id === f.cvA);
    await s.waitFor((d) => d.kind === "reopened" && d.conversation_id === f.cvA);
  }
  // read: the candidate's own streams (both tabs) get it; the staff side and other people never do
  assert.equal((await w.http("POST", `/chat/conversations/${f.cvA}/read`, f.candA.token, { message_id: m.body.id })).status, 200);
  await cand.waitFor((d) => d.kind === "read" && d.conversation_id === f.cvA);
  await candTab2.waitFor((d) => d.kind === "read" && d.conversation_id === f.cvA);
  await settle();
  for (const s of [agent1, mgr, other]) assert.equal(s.find((d) => d.kind === "read"), undefined, "read markers are not receipts for the other side");
  assert.deepEqual(ofConv(other, f.cvA), []);
  // exactly one hidden event per real change (hide + unhide), no id line on non-message events, no text or reason anywhere
  assert.equal(cand.frames.filter((fr) => fr.data.kind === "hidden").length, 2);
  for (const fr of cand.frames.filter((x) => x.data.kind !== "message")) {
    assert.equal(fr.id, null);
    assert.equal(fr.data.id, null);
  }
  for (const s of [cand, agent1, mgr, other]) {
    assert.ok(!s.raw.includes(SENT) && !s.raw.includes("REASON-SECRET-77"), "no text / reason in frames");
  }
});

// ================================================================================================ revocation mid-stream
test("access revoked mid-stream: reassignment stops delivery at once, suspended organisation / deactivated user / bumped token close the stream", async () => {
  const f = await fx();
  const { w } = f;
  const candR = await w.mkCandidate("R", w.id.agent1);
  const cvR = await w.openConv("candidate", candR.id);
  const a1 = await openSse(w.T.agent1);
  const a2 = await openSse(w.T.agent2);
  const cr = await openSse(candR.token);
  const m1 = await w.send(w.T.mgr, cvR, "first");
  await a1.waitFor((d) => d.message_id === m1.body.id);
  await cr.waitFor((d) => d.message_id === m1.body.id);
  await settle();
  assert.deepEqual(ofConv(a2, cvR), [], "unassigned agent: nothing");
  // reassign candidate R from agent1 to agent2: effective immediately, the (still open) stream of agent1 gets nothing further
  await w.q("UPDATE candidates SET assigned_to = $2 WHERE id = $1", [candR.id, w.id.agent2]);
  const m2 = await w.send(w.T.mgr, cvR, "second");
  await a2.waitFor((d) => d.message_id === m2.body.id);
  await cr.waitFor((d) => d.message_id === m2.body.id);
  const marker = await w.send(w.T.mgr, f.cvA, "marker for agent1");
  await a1.waitFor((d) => d.message_id === marker.body.id); // alive, and the marker (visible) arrived AFTER m2 was processed
  assert.ok(!a1.ended);
  assert.deepEqual(ofConv(a1, cvR).map((fr) => fr.data.message_id), [m1.body.id], "agent1 lost cvR after the reassignment");
  // replay after revocation: agent1 reconnecting with an old Last-Event-ID gets nothing from cvR
  const a1b = await openSse(w.T.agent1, { lastEventId: m1.body.id - 1 });
  await settle();
  assert.deepEqual(ofConv(a1b, cvR), []);
  // suspended organisation: the employer's stream closes when the next event is processed
  const empS = await createEmployerUser(w.pool, { orgName: "RT Suspend", email: `emps-${process.pid}@test.invalid` });
  const evS = await w.openConv("employer_request", empS.orgId);
  const es = await openSse(empS.token);
  await w.q("UPDATE crm_employers SET status = 'suspended' WHERE id = $1", [empS.orgId]);
  assert.equal((await w.send(w.T.mgr, evS, "to a suspended org")).status, 201);
  await es.waitEnded();
  assert.ok(!es.find(() => true), "nothing was written to the suspended organisation");
  // deactivated user
  const cd = await w.mkCandidate("D", w.id.agent1);
  const cvD = await w.openConv("candidate", cd.id);
  const sd = await openSse(cd.token);
  await w.q("UPDATE users SET is_active = false WHERE id = $1", [cd.userId]);
  await w.send(w.T.mgr, cvD, "to a deactivated user");
  await sd.waitEnded();
  assert.deepEqual(sd.frames, []);
  // logout / token bump: detected at the heartbeat even when no event arrives
  process.env.CHAT_SSE_HEARTBEAT_MS = "80";
  const ct = await w.mkCandidate("T", w.id.agent1);
  const st = await openSse(ct.token);
  await until(() => st.comments.some((c) => c.includes("heartbeat")), 3000, "a heartbeat");
  await w.q("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [ct.userId]);
  await st.waitEnded(3000);
});

// ================================================================================================ replay
test("Last-Event-ID replay is derived from chat_messages: only visible conversations, hidden as kind hidden, newest 200", async () => {
  const f = await fx();
  const { w } = f;
  const candP = await w.mkCandidate("P", w.id.agent1);
  const candQ = await w.mkCandidate("Q", w.id.agent2);
  const cvP = await w.openConv("candidate", candP.id);
  const cvQ = await w.openConv("candidate", candQ.id);
  const first = await openSse(candP.token);
  const base = await w.send(w.T.mgr, cvP, "seen already");
  await first.waitFor((d) => d.message_id === base.body.id);
  const lastSeen = Number(first.frames[first.frames.length - 1].id);
  first.close();
  await until(() => hub.stats().subscribers === streams.filter((s) => s !== first && !s.ended).length, 3000, "the closed stream to be released");
  // while disconnected: two visible messages (one later hidden), plus messages in conversations P must not see
  const v1 = await w.send(w.T.mgr, cvP, "missed 1 SECRET-REPLAY");
  const v2 = await w.send(candP.token, cvP, "missed 2 SECRET-REPLAY");
  const x1 = await w.send(w.T.mgr, cvQ, "other candidate SECRET-REPLAY");
  const x2 = await w.send(w.T.mgr, f.evA, "employer SECRET-REPLAY");
  assert.equal((await w.http("POST", `/chat/messages/${v1.body.id}/hide`, w.T.mgr, { reason: "r" })).status, 200);
  const re = await openSse(candP.token, { lastEventId: lastSeen });
  await settle();
  assert.deepEqual(re.frames.map((fr) => [fr.data.kind, fr.data.message_id]), [["hidden", v1.body.id], ["message", v2.body.id]]);
  assert.ok(!re.frames.some((fr) => [x1.body.id, x2.body.id].includes(fr.data.message_id)));
  assert.ok(!re.raw.includes("SECRET-REPLAY"));
  assert.equal(re.frames[0].id, null, "only message events carry an SSE id");
  assert.equal(re.frames[1].id, String(v2.body.id));
  // staff with the right scope replays the staff view of the same range; the unassigned agent gets nothing of P
  const stf = await openSse(w.T.agent1, { lastEventId: lastSeen });
  const stf2 = await openSse(w.T.agent2, { lastEventId: lastSeen });
  await settle();
  assert.ok(ofConv(stf, cvP).length >= 2 && ofConv(stf, cvQ).length === 0);
  assert.equal(ofConv(stf2, cvP).length, 0);
  assert.ok(ofConv(stf2, cvQ).length >= 1);
  // cap: 250 messages inserted straight into a conversation -> the newest 200, ascending
  const candCap = await w.mkCandidate("CAP", w.id.agent1);
  const cvCap = await w.openConv("candidate", candCap.id);
  await w.q(
    `INSERT INTO chat_messages (conversation_id, sender_user_id, sender_role, body) SELECT $1, $2, 'Manager', 'bulk ' || g FROM generate_series(1, 250) g`,
    [cvCap, w.id.mgr]
  );
  const capped = await openSse(candCap.token, { lastEventId: 0 });
  await settle();
  const got = capped.frames.map((fr) => fr.data.message_id);
  assert.equal(got.length, 200);
  assert.deepEqual(got, [...got].sort((a, b) => a - b));
  const max = Number((await w.one("SELECT max(id) AS m FROM chat_messages WHERE conversation_id = $1", [cvCap])).m);
  assert.equal(got[got.length - 1], max);
  // a live event sent right after connecting is not duplicated by the replay
  const live = await w.send(w.T.mgr, cvCap, "live");
  await capped.waitFor((d) => d.message_id === live.body.id);
  assert.equal(capped.frames.filter((fr) => fr.data.message_id === live.body.id).length, 1);
});

// ================================================================================================ caps, heartbeat, cleanup, shutdown
test("per-user connection cap answers 429, other users are unaffected, and slots return when streams close", async () => {
  const f = await fx();
  const { w } = f;
  process.env.CHAT_SSE_MAX_PER_USER = "2";
  const before = hub.stats().subscribers;
  const a = await openSse(f.empA.token);
  const b = await openSse(f.empA.token);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const c = await openSse(f.empA.token);
  assert.equal(c.status, 429);
  assert.deepEqual(JSON.parse(c.body), { error: "At most 2 event streams per user" });
  assert.equal((await openSse(f.empB.token)).status, 200, "another user is not affected");
  // parallel connects cannot overshoot
  const par = await Promise.all([1, 2, 3, 4, 5].map(() => openSse(w.T.agent2)));
  assert.equal(par.filter((s) => s.status === 200).length, 2);
  assert.equal(par.filter((s) => s.status === 429).length, 3);
  a.close();
  await until(() => a.ended);
  await until(async () => (await openSse(f.empA.token)).status === 200, 3000, "a free slot");
  assert.ok(hub.stats().subscribers >= before);
});

test("heartbeat comments keep the stream alive; disconnects clean up (subscriber count returns to zero); shutdown closes every stream", async () => {
  const f = await fx();
  process.env.CHAT_SSE_HEARTBEAT_MS = "60";
  for (const s of streams.splice(0)) s.close();
  await until(() => hub.stats().subscribers === 0, 4000, "all subscribers gone");
  const a = await openSse(f.candA.token);
  const b = await openSse(f.empA.token);
  assert.equal(hub.stats().subscribers, 2);
  await until(() => a.comments.filter((x) => x.includes("heartbeat")).length >= 2, 3000, "two heartbeats");
  assert.deepEqual(a.frames, [], "heartbeats are comments, not events");
  a.close();
  await until(() => hub.stats().subscribers === 1, 3000, "disconnect cleanup");
  hub.shutdown();
  await b.waitEnded();
  assert.equal(hub.stats().subscribers, 0);
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /modules\/chat\/hub"\)\.shutdown\(\)/, "server.js registers the hub with the graceful shutdown");
  // the hub is usable again after a shutdown
  const c = await openSse(f.candA.token);
  assert.equal(c.status, 200);
});

// ================================================================================================ nudges
test("nudge: exactly one content-free e-mail per cooldown under 10 parallel staff sends; the next window mails again", async () => {
  const f = await fx();
  const { w } = f;
  await cleanMail(w);
  let now = Date.now();
  nudges.setClock(() => new Date(now));
  const SENT = "NUDGE-LEAK-SENTINEL-9912";
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => w.send(i % 2 ? w.T.mgr : w.T.agent1, f.cvA, `${SENT} ${i}`)));
  assert.ok(rs.every((r) => r.status === 201));
  await nudges.idle();
  let mails = await w.outbound(f.candA.email);
  assert.equal(mails.length, 1, "one nudge for ten messages");
  const m = mails[0];
  assert.match(m.subject, /New message in VITA/);
  assert.match(m.subject, /رسالة جديدة في VITA/);
  assert.match(m.subject, /Nouveau message dans VITA/);
  assert.match(m.body, /You have a new message in VITA\./);
  assert.match(m.body, /لديك رسالة جديدة في VITA/);
  assert.match(m.body, /Vous avez un nouveau message dans VITA/);
  for (const part of [m.subject, m.body, JSON.stringify(m.headers)]) {
    assert.ok(!part.includes(SENT) && !/Cand A|Cand User/i.test(part), "no message text, no names");
    assert.ok(!/https?:\/\//.test(part), "no link without SITE_BASE_URL");
  }
  // inside the cooldown: nothing; just after it: one more
  now += 14 * 60 * 1000;
  await w.send(w.T.mgr, f.cvA, "inside the window");
  await nudges.idle();
  assert.equal((await w.outbound(f.candA.email)).length, 1);
  now += 2 * 60 * 1000;
  await w.send(w.T.mgr, f.cvA, "after the window");
  await nudges.idle();
  assert.equal((await w.outbound(f.candA.email)).length, 2);
  // another conversation has its own cooldown; the recipient of another candidate got nothing
  assert.equal((await w.outbound(f.candB.email)).length, 0);
  await w.send(w.T.mgr, f.cvB, "other conversation");
  await nudges.idle();
  assert.equal((await w.outbound(f.candB.email)).length, 1);
  assert.equal((await w.q("SELECT count(*)::int AS n FROM chat_nudges WHERE conversation_id = $1", [f.cvA])).rows[0].n, 1);
});

test("nudge: link only with a valid SITE_BASE_URL; employer and agency users each get one; opt-out honoured; external -> staff sends no e-mail", async () => {
  const f = await fx();
  const { w } = f;
  await cleanMail(w);
  nudges.setClock(() => new Date());
  // second employer-A user, with an e-mail
  const email2 = `empa2-${process.pid}@test.invalid`;
  const u2 = (await w.one("INSERT INTO users (full_name,email,password,role,is_active) VALUES ('Employer A second',$1,'x','Employer',true) RETURNING id", [email2])).id;
  await w.q("INSERT INTO crm_org_accounts (user_id, org_type, org_id) VALUES ($1,'employer',$2)", [u2, f.empA.orgId]);
  const tok2 = portalToken(u2, "Employer");
  const empAEmail = (await w.one("SELECT email FROM users WHERE id = $1", [f.empA.userId])).email;
  process.env.SITE_BASE_URL = "javascript:alert(1)";
  await w.send(w.T.mgr, f.evA, "to the employer org");
  await nudges.idle();
  assert.equal((await w.outbound(empAEmail)).length, 1);
  assert.equal((await w.outbound(email2)).length, 1);
  assert.ok(!/javascript/.test((await w.outbound(empAEmail))[0].body), "a non-http(s) base URL is ignored");
  const empBEmail = (await w.one("SELECT email FROM users WHERE id = $1", [f.empB.userId])).email;
  assert.equal((await w.outbound(empBEmail)).length, 0, "the other organisation is not mailed");
  // opt-out for the second user: PUT validates strictly
  for (const bad of [{}, { email_nudges: "false" }, { email_nudges: 0 }, { email_nudges: false, extra: 1 }, { other: true }, [], null]) {
    assert.equal((await w.http("PUT", "/chat/prefs", tok2, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await w.http("PUT", "/chat/prefs", tok2, undefined, "not json")).status, 400);
  const put = await w.http("PUT", "/chat/prefs", tok2, { email_nudges: false });
  assert.deepEqual(put.body, { email_nudges: false });
  assert.deepEqual((await w.http("GET", "/chat/prefs", tok2)).body, { email_nudges: false });
  assert.deepEqual((await w.http("GET", "/chat/prefs", f.empA.token)).body, { email_nudges: true });
  assert.equal((await w.q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'chat.prefs.update' AND user_id = $1", [u2])).rows[0].n, 1);
  await w.q("DELETE FROM chat_nudges");
  process.env.SITE_BASE_URL = "https://vita.example.test/portal";
  await w.send(w.T.mgr, f.evA, "second round");
  await nudges.idle();
  const second = (await w.outbound(empAEmail)).pop();
  assert.ok(second.body.includes("https://vita.example.test/portal"), "link to the portal base URL");
  assert.equal((await w.outbound(email2)).length, 1, "opted-out user got nothing new");
  // agency users are nudged too
  const agyEmail = (await w.one("SELECT email FROM users WHERE id = $1", [f.agyA.userId])).email;
  await w.send(w.T.mgr, f.avA, "to the agency");
  await nudges.idle();
  assert.equal((await w.outbound(agyEmail)).length, 1);
  // external -> staff: no e-mail at all (to anyone)
  await cleanMail(w);
  for (const [tok, cid] of [[f.candA.token, f.cvA], [f.empA.token, f.evA], [tok2, f.evA], [f.agyA.token, f.avA]]) assert.equal((await w.send(tok, cid, "reply to staff")).status, 201);
  await nudges.idle();
  assert.equal((await w.q("SELECT count(*)::int AS n FROM js_sandbox_mail")).rows[0].n, 0);
  assert.equal((await w.q("SELECT count(*)::int AS n FROM chat_nudges")).rows[0].n, 0);
});

test("nudge: a mail failure or a refused recipient never fails the send, and gives the cooldown slot back", async () => {
  const f = await fx();
  const { w } = f;
  await cleanMail(w);
  nudges.setClock(() => new Date());
  const real = mail.sandbox.send;
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    mail.sandbox.send = async () => {
      throw Object.assign(new Error("smtp exploded with secret-host.internal"), { code: "ECONNREFUSED" });
    };
    const r = await w.send(w.T.mgr, f.cvA, "mail will fail");
    assert.equal(r.status, 201);
    assert.equal(r.body.body, "mail will fail");
    await nudges.idle();
    assert.equal((await w.q("SELECT count(*)::int AS n FROM chat_nudges WHERE conversation_id = $1", [f.cvA])).rows[0].n, 0, "slot released");
    assert.ok(errors.some((e) => e.includes("chat nudge failed") && e.includes("ECONNREFUSED")));
    assert.ok(!errors.some((e) => e.includes("secret-host")), "only the error code is logged");
    mail.sandbox.send = async () => ({ providerMessageId: null, accepted: false, reason: "refused" });
    assert.equal((await w.send(w.T.mgr, f.cvA, "mail refused")).status, 201);
    await nudges.idle();
    assert.equal((await w.q("SELECT count(*)::int AS n FROM chat_nudges WHERE conversation_id = $1", [f.cvA])).rows[0].n, 0);
  } finally {
    mail.sandbox.send = real;
    console.error = origErr;
  }
  assert.equal((await w.send(w.T.mgr, f.cvA, "mail works again")).status, 201);
  await nudges.idle();
  assert.equal((await w.outbound(f.candA.email)).length, 1, "the next message nudges normally");
  // a recipient outside the sandbox allow-list is refused by the adapter: still no failure
  const outside = await w.mkCandidate("OUT", w.id.agent1);
  await w.q("UPDATE users SET email = 'someone@not-allowed.example' WHERE id = $1", [outside.userId]);
  const cvO = await w.openConv("candidate", outside.id);
  assert.equal((await w.send(w.T.mgr, cvO, "x")).status, 201);
  await nudges.idle();
  assert.equal((await w.outbound("someone@not-allowed.example")).length, 0);
});

test("nudge: no e-mail for deactivated users, users without an address or a suspended organisation", async () => {
  const f = await fx();
  const { w } = f;
  await cleanMail(w);
  nudges.setClock(() => new Date());
  const a = await w.mkCandidate("NOMAIL", w.id.agent1);
  await w.q("UPDATE users SET email = '' WHERE id = $1", [a.userId]);
  const b = await w.mkCandidate("INACTIVE", w.id.agent1);
  await w.q("UPDATE users SET is_active = false WHERE id = $1", [b.userId]);
  for (const cand of [a, b]) {
    const cv = await w.openConv("candidate", cand.id);
    assert.equal((await w.send(w.T.mgr, cv, "hello")).status, 201);
  }
  const sus = await createEmployerUser(w.pool, { orgName: "RT NS", email: `ns-${process.pid}@test.invalid` });
  const evS = await w.openConv("employer_request", sus.orgId);
  await w.q("UPDATE crm_employers SET status = 'suspended' WHERE id = $1", [sus.orgId]);
  assert.equal((await w.send(w.T.mgr, evS, "hello")).status, 201);
  await nudges.idle();
  assert.equal((await w.q("SELECT count(*)::int AS n FROM js_sandbox_mail")).rows[0].n, 0);
  // the pure function agrees: external senders and unknown conversations produce nothing and never throw
  assert.deepEqual(await nudges.nudge({ conversationId: f.cvA, senderRole: "Candidate" }), { sent: 0, skipped: 0 });
  assert.deepEqual(await nudges.nudge({ conversationId: 2000000000, senderRole: "Manager" }), { sent: 0, skipped: 0 });
});

test("nudge cooldown setting: unset or malformed -> 15 minutes, 0 disables the cooldown, large values are capped", () => {
  const saved = process.env.CHAT_NUDGE_COOLDOWN_MIN;
  try {
    for (const [v, want] of [[undefined, 15], ["", 15], ["  ", 15], ["abc", 15], ["-5", 15], ["1.5", 15], ["0", 0], ["30", 30], ["99999", 7 * 24 * 60]]) {
      if (v === undefined) delete process.env.CHAT_NUDGE_COOLDOWN_MIN;
      else process.env.CHAT_NUDGE_COOLDOWN_MIN = v;
      assert.equal(nudges.cooldownMinutes(), want, String(v));
    }
  } finally {
    if (saved === undefined) delete process.env.CHAT_NUDGE_COOLDOWN_MIN;
    else process.env.CHAT_NUDGE_COOLDOWN_MIN = saved;
  }
});

// ================================================================================================ channels
test("channels are honest: in_app connected, e-mail follows the adapter, WhatsApp requires_setup and nothing is ever sent", async () => {
  const f = await fx();
  const { w } = f;
  const get = async () => (await w.http("GET", "/chat/channels", w.T.mgr)).body.channels;
  let ch = await get();
  const by = (k) => ch.find((c) => c.channel === k);
  assert.deepEqual(ch.map((c) => c.channel), ["in_app", "email", "whatsapp"]);
  assert.equal(by("in_app").status, "connected");
  assert.equal(by("email").status, "connected");
  assert.equal(by("email").mode, "sandbox");
  assert.equal(by("email").sends_real_mail, false, "the sandbox sends nothing");
  assert.match(by("email").detail, /sandbox/i);
  assert.equal(by("whatsapp").status, "requires_setup");
  assert.match(by("whatsapp").detail, /WhatsApp Business/);
  assert.match(by("whatsapp").detail, /approved message templates/);
  // a real-looking but unconfigured SMTP adapter: requires_setup, never connected
  process.env.MAIL_PROVIDER = "imap_smtp";
  ch = await get();
  assert.equal(by("email").status, "requires_setup");
  assert.equal(by("email").sends_real_mail, false);
  delete process.env.MAIL_PROVIDER;
  // WHATSAPP_PROVIDER does not make the unimplemented channel look connected
  process.env.WHATSAPP_PROVIDER = "twilio";
  ch = await get();
  assert.equal(by("whatsapp").status, "requires_setup");
  assert.match(by("whatsapp").detail, /not implemented/);
  delete process.env.WHATSAPP_PROVIDER;

  // sandbox adapter: records requires_setup, returns accepted:false, sends nothing, stores no text
  const sent = await w.send(w.T.mgr, f.cvA, "WHATSAPP-TEXT-SENTINEL");
  await nudges.idle();
  const mailBefore = (await w.q("SELECT count(*)::int AS n FROM js_sandbox_mail")).rows[0].n;
  assert.equal((await w.q("SELECT count(*)::int AS n FROM chat_channel_outbox")).rows[0].n, 0, "message sending is not wired to WhatsApp");
  const res = await whatsapp.send({ messageId: sent.body.id, to: "+21600000000", text: "WHATSAPP-TEXT-SENTINEL" });
  assert.equal(res.accepted, false);
  assert.equal(res.status, "requires_setup");
  const row = (await w.q("SELECT * FROM chat_channel_outbox WHERE id = $1", [res.outbox_id])).rows[0];
  assert.equal(row.status, "requires_setup");
  assert.equal(row.channel, "whatsapp");
  assert.equal(Number(row.message_id), sent.body.id);
  assert.ok(!JSON.stringify(row).includes("WHATSAPP-TEXT-SENTINEL") && !JSON.stringify(row).includes("+216"), "no text or number stored");
  process.env.WHATSAPP_PROVIDER = "twilio";
  assert.equal((await whatsapp.send({ messageId: sent.body.id })).accepted, false);
  assert.equal((await w.q("SELECT count(*)::int AS n FROM chat_channel_outbox WHERE status <> 'requires_setup' OR channel <> 'whatsapp'")).rows[0].n, 0);
  assert.equal((await w.q("SELECT count(*)::int AS n FROM js_sandbox_mail")).rows[0].n, mailBefore, "nothing sent");
  await assert.rejects(() => whatsapp.send({}), /messageId/);
  await assert.rejects(() => whatsapp.send({ messageId: 2000000000 }));
});
