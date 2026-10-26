// Stage 6, Task 2: messaging API (/chat): scope, conversations, messages, read state, moderation, rate limit.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "chat-api-test-secret";
process.env.CHAT_RATE_PER_MIN = "1000"; // the rate-limit test lowers it for its own duration
delete process.env.CHAT_CANDIDATE_CAN_START;

const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser, portalToken } = require("./helpers/orgs");
const scope = require("../modules/chat/scope");

// ------------------------------------------------------------------------------------------------ world
let worldPromise = null;
const world = () => (worldPromise ||= build());
test.after(async () => {
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
  const w = { pool, q, one, http, T: {}, id: {}, close: async () => {
    await new Promise((r) => server.close(r));
    await cleanup();
  } };
  const mkStaff = async (key, role, over = {}) => {
    n += 1;
    const id = (await one("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x',$3,$4) RETURNING id", [over.name || `${role} ${key}`, `${key}-${n}@chat.test.invalid`, role, over.active ?? true])).id;
    w.id[key] = id;
    w.T[key] = jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return id;
  };
  for (const [k, r] of [["sa", "SuperAdmin"], ["admin", "Admin"], ["mgr", "Manager"], ["rec", "Receptionist"], ["agent1", "Agent"], ["agent2", "Agent"], ["hr", "HR"], ["acct", "Accountant"]]) await mkStaff(k, r);
  w.mkStaff = mkStaff;
  w.mkCandidate = async (key, assignedTo) => {
    n += 1;
    const c = await one("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`Cand ${key}`, `CHAT-PP-${n}-${process.pid}`, assignedTo ?? null]);
    const uid = (await one("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x','Candidate',true) RETURNING id", [`Cand User ${key}`, `cand-${key}-${n}@chat.test.invalid`])).id;
    await q("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [uid, c.id]);
    return { id: c.id, userId: uid, token: portalToken(uid, "Candidate") };
  };
  w.openAs = async (token, subject_type, subject_id) => http("POST", "/chat/conversations", token, { subject_type, subject_id });
  w.send = (token, cid, body) => http("POST", `/chat/conversations/${cid}/messages`, token, { body });
  return w;
}

/** Shared fixture: candidates A (agent1) and B (agent2), employer orgs A (2 users) and B, agencies A and B; one open conversation each. */
let fixture = null;
async function fx() {
  if (fixture) return fixture;
  const w = await world();
  const f = { w };
  f.candA = await w.mkCandidate("A", w.id.agent1);
  f.candB = await w.mkCandidate("B", w.id.agent2);
  f.empA = await createEmployerUser(w.pool, { orgName: "Employer A" });
  f.empA2 = { userId: null, token: null };
  const second = (await w.one("INSERT INTO users (full_name,email,password,role,is_active) VALUES ('Employer A second','empa2@chat.test.invalid','x','Employer',true) RETURNING id")).id;
  await w.q("INSERT INTO crm_org_accounts (user_id, org_type, org_id) VALUES ($1,'employer',$2)", [second, f.empA.orgId]);
  f.empA2 = { userId: second, token: portalToken(second, "Employer") };
  f.empB = await createEmployerUser(w.pool, { orgName: "Employer B" });
  f.agyA = await createAgencyUser(w.pool, { orgName: "Agency A" });
  f.agyB = await createAgencyUser(w.pool, { orgName: "Agency B" });
  const open = async (type, id) => {
    const r = await w.openAs(w.T.mgr, type, id);
    assert.ok([200, 201].includes(r.status), r.text);
    return r.body.id;
  };
  f.cvA = await open("candidate", f.candA.id);
  f.cvB = await open("candidate", f.candB.id);
  f.evA = await open("employer_request", f.empA.orgId);
  f.evB = await open("employer_request", f.empB.orgId);
  f.avA = await open("agency", f.agyA.orgId);
  f.avB = await open("agency", f.agyB.orgId);
  // One staff message and one external message in each, with distinct sentinels.
  const sendOk = async (token, cid, body) => {
    const r = await w.send(token, cid, body);
    assert.equal(r.status, 201, r.text);
    return r.body;
  };
  for (const [cid, tok, tag] of [[f.cvA, f.candA.token, "CAND-A"], [f.cvB, f.candB.token, "CAND-B"], [f.evA, f.empA.token, "EMP-A"], [f.evB, f.empB.token, "EMP-B"], [f.avA, f.agyA.token, "AGY-A"], [f.avB, f.agyB.token, "AGY-B"]]) {
    await sendOk(w.T.mgr, cid, `STAFF-TO-${tag}`);
    await sendOk(tok, cid, `FROM-${tag}`);
  }
  fixture = f;
  return f;
}

const ids = (r) => r.body.rows.map((x) => x.id).sort((a, b) => a - b);
const NOT_FOUND = { error: "Not found" };

// ------------------------------------------------------------------------------------------------ scope module (pure)
test("scope: conversationVisibleSql validates the alias and denies unknown actors", () => {
  assert.throws(() => scope.conversationVisibleSql({ kind: "staff", userId: 1, role: "Admin", perms: { read: true } }, "c; DROP TABLE x"), /alias/i);
  for (const a of [null, {}, { kind: "ghost" }, { kind: "staff", userId: 1, role: "Admin", perms: { read: false } }, { kind: "candidate" }, { kind: "employer" }, { kind: "agency", orgId: "abc" }]) {
    const r = scope.conversationVisibleSql(a, "c", 3);
    assert.equal(r.clause, "FALSE", JSON.stringify(a));
    assert.deepEqual(r.params, []);
  }
  const r = scope.conversationVisibleSql({ kind: "candidate", candidateId: 7, userId: 9, role: "Candidate", perms: {} }, "cv", 2);
  assert.match(r.clause, /cv\.subject_type = 'candidate'/);
  assert.match(r.clause, /\$3/);
  assert.deepEqual(r.params, [7]);
});

// ------------------------------------------------------------------------------------------------ authentication and role gate
test("anonymous is 401 on every endpoint; HR and Accountant are 403; malformed tokens are refused", async () => {
  const f = await fx();
  const { w } = f;
  const calls = [
    ["GET", "/chat/conversations"], ["POST", "/chat/conversations"], ["GET", `/chat/conversations/${f.cvA}/messages`], ["POST", `/chat/conversations/${f.cvA}/messages`],
    ["POST", `/chat/conversations/${f.cvA}/read`], ["GET", "/chat/unread-count"], ["POST", `/chat/conversations/${f.cvA}/close`], ["POST", `/chat/conversations/${f.cvA}/reopen`],
    ["POST", "/chat/messages/1/hide"], ["POST", "/chat/messages/1/unhide"],
  ];
  for (const [m, u] of calls) {
    assert.equal((await w.http(m, u, null, m === "POST" ? {} : undefined)).status, 401, `anon ${m} ${u}`);
    assert.equal((await w.http(m, u, "not-a-token", m === "POST" ? {} : undefined)).status, 400, `bad token ${m} ${u}`);
    for (const k of ["hr", "acct"]) {
      const r = await w.http(m, u, w.T[k], m === "POST" ? { body: "x" } : undefined);
      assert.equal(r.status, 403, `${k} ${m} ${u}`);
    }
  }
});

test("deactivated accounts are refused at once (staff with a legacy token, candidate) and a suspended organisation is refused", async () => {
  const f = await fx();
  const { w } = f;
  const ag = await w.mkStaff("tmpagent", "Agent");
  const c = await w.mkCandidate("tmp", ag);
  const conv = (await w.openAs(w.T.mgr, "candidate", c.id)).body.id;
  assert.equal((await w.http("GET", "/chat/conversations", w.T.tmpagent)).status, 200);
  assert.equal((await w.send(c.token, conv, "hello")).status, 201);
  await w.q("UPDATE users SET is_active = false WHERE id = $1", [ag]);
  assert.equal((await w.http("GET", "/chat/conversations", w.T.tmpagent)).status, 401);
  assert.equal((await w.send(w.T.tmpagent, conv, "still here?")).status, 401);
  await w.q("UPDATE users SET is_active = false WHERE id = $1", [c.userId]);
  assert.equal((await w.http("GET", "/chat/conversations", c.token)).status, 401);
  assert.equal((await w.send(c.token, conv, "ghost")).status, 401);
  // suspended organisation
  await w.q("UPDATE crm_employers SET status = 'suspended' WHERE id = $1", [f.empB.orgId]);
  assert.equal((await w.http("GET", "/chat/conversations", f.empB.token)).status, 401);
  assert.equal((await w.send(f.empB.token, f.evB, "from suspended")).status, 401);
  await w.q("UPDATE crm_employers SET status = 'active' WHERE id = $1", [f.empB.orgId]);
  assert.equal((await w.http("GET", "/chat/conversations", f.empB.token)).status, 200);
  // none of the refused sends stored anything
  const stored = await w.one("SELECT count(*)::int AS n FROM chat_messages WHERE body IN ('still here?','ghost','from suspended')");
  assert.equal(stored.n, 0);
});

// ------------------------------------------------------------------------------------------------ opening conversations
test("open: idempotent per subject (201 then 200, one row), audited once; staff must be able to serve the subject", async () => {
  const f = await fx();
  const { w } = f;
  const c = await w.mkCandidate("open1", w.id.agent1);
  const first = await w.openAs(w.T.agent1, "candidate", c.id);
  assert.equal(first.status, 201, first.text);
  assert.equal(first.body.subject_type, "candidate");
  assert.equal(String(first.body.subject_id), String(c.id));
  assert.equal(first.body.status, "open");
  const again = await w.openAs(w.T.agent1, "candidate", String(c.id));
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  const mgr = await w.openAs(w.T.mgr, "candidate", c.id);
  assert.equal(mgr.status, 200);
  assert.equal(mgr.body.id, first.body.id);
  assert.equal((await w.one("SELECT count(*)::int AS n FROM chat_conversations WHERE subject_type='candidate' AND subject_id=$1", [c.id])).n, 1);
  const audit = await w.q("SELECT * FROM audit_logs WHERE action = 'chat.conversation.open' AND record_id = $1", [String(first.body.id)]);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].user_id, w.id.agent1);
  // concurrent opens converge on one row
  const c2 = await w.mkCandidate("open2", w.id.agent1);
  const par = await Promise.all(Array.from({ length: 8 }, () => w.openAs(w.T.mgr, "candidate", c2.id)));
  assert.deepEqual([...new Set(par.map((r) => r.body.id))].length, 1);
  assert.equal(par.filter((r) => r.status === 201).length, 1);
  assert.equal(par.filter((r) => r.status === 200).length, 7);
  // unassigned staff cannot serve the subject: the same 404 as for a candidate that does not exist
  const miss = await w.openAs(w.T.agent2, "candidate", c.id);
  const none = await w.openAs(w.T.agent2, "candidate", 2000000000);
  assert.equal(miss.status, 404);
  assert.deepEqual(miss.body, NOT_FOUND);
  assert.deepEqual(none.body, NOT_FOUND);
  assert.equal((await w.openAs(w.T.rec, "candidate", c.id)).status, 404);
  // Agent / Receptionist cannot open organisation conversations; Admin / Manager / SuperAdmin can
  assert.equal((await w.openAs(w.T.agent1, "agency", f.agyA.orgId)).status, 404);
  assert.equal((await w.openAs(w.T.rec, "employer_request", f.empA.orgId)).status, 404);
  for (const k of ["admin", "sa", "mgr"]) assert.ok([200, 201].includes((await w.openAs(w.T[k], "agency", f.agyA.orgId)).status), k);
  assert.equal((await w.openAs(w.T.mgr, "agency", 2000000000)).status, 404);
  assert.equal((await w.openAs(w.T.mgr, "employer_request", 2000000000)).status, 404);
});

test("open: validation (subject_type, subject_id, body shape) and no cold messaging by employers / agencies", async () => {
  const f = await fx();
  const { w } = f;
  for (const body of [{}, { subject_type: "staff", subject_id: 1 }, { subject_type: "nope", subject_id: 1 }, { subject_type: "candidate" }, { subject_type: "candidate", subject_id: "abc" },
    { subject_type: "candidate", subject_id: -1 }, { subject_type: "candidate", subject_id: 0 }, { subject_type: "candidate", subject_id: 1.5 }, { subject_type: "candidate", subject_id: "1e3" },
    { subject_type: ["candidate"], subject_id: 1 }, { subject_type: "candidate", subject_id: [1] }, { subject_type: "candidate", subject_id: { a: 1 } }]) {
    const r = await w.http("POST", "/chat/conversations", w.T.mgr, body);
    assert.equal(r.status, 400, JSON.stringify(body) + " -> " + r.text);
  }
  assert.equal((await w.http("POST", "/chat/conversations", w.T.mgr, [1, 2])).status, 400);
  // employers and agencies cannot start conversations at all (even their own, even when one already exists)
  assert.equal((await w.openAs(f.empA.token, "employer_request", f.empA.orgId)).status, 403);
  assert.equal((await w.openAs(f.agyA.token, "agency", f.agyA.orgId)).status, 403);
  assert.equal((await w.openAs(f.empA.token, "agency", f.agyA.orgId)).status, 403);
});

test("open: a candidate may open only their own conversation, switchable with CHAT_CANDIDATE_CAN_START", async () => {
  const f = await fx();
  const { w } = f;
  const a = await w.mkCandidate("start1", w.id.agent1);
  const b = await w.mkCandidate("start2", w.id.agent2);
  const mine = await w.openAs(a.token, "candidate", a.id);
  assert.equal(mine.status, 201, mine.text);
  assert.equal((await w.openAs(a.token, "candidate", a.id)).status, 200);
  const implicit = await w.http("POST", "/chat/conversations", a.token, { subject_type: "candidate" });
  assert.equal(implicit.status, 200);
  assert.equal(implicit.body.id, mine.body.id);
  // someone else's candidate id: same 404 as a missing one
  const foreign = await w.openAs(a.token, "candidate", b.id);
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, NOT_FOUND);
  assert.equal((await w.openAs(a.token, "agency", f.agyA.orgId)).status, 403);
  assert.equal((await w.openAs(a.token, "employer_request", f.empA.orgId)).status, 403);
  // switched off: even their own is refused, but a conversation staff opened keeps working
  process.env.CHAT_CANDIDATE_CAN_START = "false";
  try {
    assert.equal((await w.openAs(b.token, "candidate", b.id)).status, 403);
    assert.equal((await w.openAs(a.token, "candidate", a.id)).status, 403);
    const opened = await w.openAs(w.T.agent2, "candidate", b.id);
    assert.equal(opened.status, 201);
    assert.equal((await w.send(b.token, opened.body.id, "I can still reply")).status, 201);
  } finally {
    delete process.env.CHAT_CANDIDATE_CAN_START;
  }
  process.env.CHAT_CANDIDATE_CAN_START = "0";
  try {
    assert.equal((await w.openAs(a.token, "candidate", a.id)).status, 403);
  } finally {
    delete process.env.CHAT_CANDIDATE_CAN_START;
  }
  assert.equal((await w.openAs(a.token, "candidate", a.id)).status, 200);
});

// ------------------------------------------------------------------------------------------------ isolation matrix
test("isolation: each external party lists and reads ONLY their own conversation; every foreign or missing id is the identical 404", async () => {
  const f = await fx();
  const { w } = f;
  const parties = [
    ["candA", f.candA.token, f.cvA, "CAND-A"], ["candB", f.candB.token, f.cvB, "CAND-B"], ["empA", f.empA.token, f.evA, "EMP-A"], ["empA2", f.empA2.token, f.evA, "EMP-A"],
    ["empB", f.empB.token, f.evB, "EMP-B"], ["agyA", f.agyA.token, f.avA, "AGY-A"], ["agyB", f.agyB.token, f.avB, "AGY-B"],
  ];
  const all = [f.cvA, f.cvB, f.evA, f.evB, f.avA, f.avB];
  const missing = await w.http("GET", "/chat/conversations/2000000000/messages", f.candA.token);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, NOT_FOUND);
  for (const [name, token, own, tag] of parties) {
    const list = await w.http("GET", "/chat/conversations", token);
    assert.equal(list.status, 200, name);
    assert.deepEqual(ids(list), [own], `${name} lists only its own thread`);
    assert.ok(!list.text.includes("Cand B") || name === "candB");
    const msgs = await w.http("GET", `/chat/conversations/${own}/messages`, token);
    assert.equal(msgs.status, 200);
    assert.deepEqual(msgs.body.rows.map((m) => m.body).sort(), [`FROM-${tag}`, `STAFF-TO-${tag}`].sort());
    for (const other of all.filter((x) => x !== own)) {
      for (const [m, u, b] of [["GET", `/chat/conversations/${other}/messages`], ["POST", `/chat/conversations/${other}/messages`, { body: "intrusion" }], ["POST", `/chat/conversations/${other}/read`, { message_id: 1 }]]) {
        const r = await w.http(m, u, token, b);
        assert.equal(r.status, 404, `${name} ${m} ${u} -> ${r.text}`);
        assert.deepEqual(r.body, missing.body, `${name} ${m} ${u}: identical body`);
        assert.equal(r.text, missing.text);
      }
      const hide = await w.http("POST", `/chat/messages/1/hide`, token, { reason: "x" });
      assert.equal(hide.status, 403);
    }
  }
  assert.equal((await w.one("SELECT count(*)::int AS n FROM chat_messages WHERE body = 'intrusion'")).n, 0);
  // the two users of employer A share one thread: B's message is visible to A2 and the reverse
  const s1 = await w.send(f.empA.token, f.evA, "colleague one");
  const s2 = await w.send(f.empA2.token, f.evA, "colleague two");
  assert.equal(s1.status, 201);
  assert.equal(s2.status, 201);
  const seen = await w.http("GET", `/chat/conversations/${f.evA}/messages?limit=2`, f.empA.token);
  assert.deepEqual(seen.body.rows.map((m) => [m.body, m.mine]), [["colleague two", false], ["colleague one", true]]);
  // employer B never sees them
  assert.ok(!(await w.http("GET", "/chat/conversations", f.empB.token)).text.includes("colleague"));
});

test("external viewers see staff as 'staff' + display name only; no ids, e-mails or real roles of staff leak; staff see full details", async () => {
  const f = await fx();
  const { w } = f;
  const ext = await w.http("GET", `/chat/conversations/${f.cvA}/messages`, f.candA.token);
  const staffMsg = ext.body.rows.find((m) => m.body === "STAFF-TO-CAND-A");
  assert.equal(staffMsg.sender_role, "staff");
  assert.equal(staffMsg.sender_name, "Manager mgr");
  assert.equal(staffMsg.mine, false);
  assert.equal(staffMsg.sender_user_id, undefined);
  assert.ok(!ext.text.includes("@chat.test.invalid"));
  assert.ok(!ext.text.includes('"Manager"'));
  const own = ext.body.rows.find((m) => m.body === "FROM-CAND-A");
  assert.equal(own.mine, true);
  assert.equal(own.sender_role, "Candidate");
  assert.equal(own.sender_user_id, undefined);
  const staffView = await w.http("GET", `/chat/conversations/${f.cvA}/messages`, w.T.mgr);
  const sm = staffView.body.rows.find((m) => m.body === "STAFF-TO-CAND-A");
  assert.equal(sm.sender_role, "Manager");
  assert.equal(sm.sender_user_id, w.id.mgr);
  assert.equal(sm.mine, true);
  assert.equal(sm.sender_name, "Manager mgr");
  assert.equal(staffView.body.rows.find((m) => m.body === "FROM-CAND-A").sender_role, "Candidate");
  assert.ok(!staffView.text.includes("@chat.test.invalid"));
  // the list gives staff the subject name, externals not
  const l1 = await w.http("GET", "/chat/conversations", w.T.mgr);
  assert.ok(l1.body.rows.some((r) => r.subject_name === "Cand A"));
  assert.ok(l1.body.rows.some((r) => r.subject_name === "Employer A"));
  assert.equal((await w.http("GET", "/chat/conversations", f.candA.token)).body.rows[0].subject_name, undefined);
});

test("staff visibility: Admin/SuperAdmin/Manager see every non-staff conversation, Agent/Receptionist only assigned candidates", async () => {
  const f = await fx();
  const { w } = f;
  const all = [f.cvA, f.cvB, f.evA, f.evB, f.avA, f.avB];
  const has = async (key, want) => {
    const r = await w.http("GET", "/chat/conversations?limit=50", w.T[key]);
    assert.equal(r.status, 200, key);
    const got = ids(r).filter((i) => all.includes(i));
    assert.deepEqual(got, [...want].sort((a, b) => a - b), key);
  };
  for (const k of ["admin", "sa", "mgr"]) await has(k, all);
  await has("agent1", [f.cvA]);
  await has("agent2", [f.cvB]);
  await has("rec", []);
  // direct access follows the list: unassigned staff get the identical 404
  const miss = await w.http("GET", "/chat/conversations/2000000000/messages", w.T.agent1);
  for (const [key, cid] of [["agent1", f.cvB], ["agent1", f.evA], ["agent1", f.avA], ["agent2", f.cvA], ["rec", f.cvA]]) {
    for (const [m, u, b] of [["GET", `/chat/conversations/${cid}/messages`], ["POST", `/chat/conversations/${cid}/messages`, { body: "no" }], ["POST", `/chat/conversations/${cid}/read`, { message_id: 1 }]]) {
      const r = await w.http(m, u, w.T[key], b);
      assert.equal(r.status, 404, `${key} ${m} ${u}`);
      assert.equal(r.text, miss.text);
    }
  }
  assert.equal((await w.http("GET", `/chat/conversations/${f.cvA}/messages`, w.T.agent1)).status, 200);
  assert.equal((await w.send(w.T.agent1, f.cvA, "assigned agent speaking")).status, 201);
});

test("reassigning a candidate moves staff visibility immediately (including a staff member who already read and wrote in the thread)", async () => {
  const f = await fx();
  const { w } = f;
  const c = await w.mkCandidate("move", w.id.agent1);
  const conv = (await w.openAs(w.T.agent1, "candidate", c.id)).body.id;
  assert.equal((await w.send(w.T.agent1, conv, "from agent1")).status, 201);
  const m = (await w.send(c.token, conv, "candidate reply")).body;
  assert.equal((await w.http("POST", `/chat/conversations/${conv}/read`, w.T.agent1, { message_id: m.id })).status, 200);
  assert.ok((await w.http("GET", "/chat/conversations", w.T.agent1)).body.rows.some((r) => r.id === conv));
  await w.q("UPDATE candidates SET assigned_to = $1 WHERE id = $2", [w.id.agent2, c.id]);
  assert.ok(!(await w.http("GET", "/chat/conversations", w.T.agent1)).body.rows.some((r) => r.id === conv));
  assert.equal((await w.http("GET", `/chat/conversations/${conv}/messages`, w.T.agent1)).status, 404);
  assert.equal((await w.send(w.T.agent1, conv, "still mine?")).status, 404);
  assert.equal((await w.http("POST", `/chat/conversations/${conv}/read`, w.T.agent1, { message_id: m.id })).status, 404);
  assert.ok((await w.http("GET", "/chat/conversations", w.T.agent2)).body.rows.some((r) => r.id === conv));
  assert.equal((await w.http("GET", `/chat/conversations/${conv}/messages`, w.T.agent2)).status, 200);
  assert.equal((await w.http("GET", "/chat/unread-count", w.T.agent1)).body.unread >= 0, true);
  // unassigned entirely
  await w.q("UPDATE candidates SET assigned_to = NULL WHERE id = $1", [c.id]);
  assert.equal((await w.http("GET", `/chat/conversations/${conv}/messages`, w.T.agent2)).status, 404);
  assert.equal((await w.http("GET", `/chat/conversations/${conv}/messages`, w.T.mgr)).status, 200);
  // a soft-deleted candidate: its portal account loses chat, Agents lose the thread, Managers keep the history
  await w.q("UPDATE candidates SET assigned_to = $1, is_deleted = true WHERE id = $2", [w.id.agent1, c.id]);
  assert.equal((await w.http("GET", "/chat/conversations", c.token)).status, 403);
  assert.equal((await w.http("GET", `/chat/conversations/${conv}/messages`, w.T.agent1)).status, 404);
  assert.equal((await w.http("GET", `/chat/conversations/${conv}/messages`, w.T.mgr)).status, 200);
});

test("explicit participants: staff rooms are participants-only (even for Admin); organisation threads open to an explicit Agent", async () => {
  const f = await fx();
  const { w } = f;
  const room = Number((await w.one("INSERT INTO chat_conversations (subject_type, title, created_by) VALUES ('staff','Ops room',$1) RETURNING id", [w.id.admin])).id);
  await w.q("INSERT INTO chat_participants (conversation_id, user_id, added_by) VALUES ($1,$2,$3)", [room, w.id.mgr, w.id.admin]);
  const seeMsg = (await w.send(w.T.mgr, room, "internal only")).body;
  assert.equal(seeMsg.sender_role, "Manager");
  assert.ok((await w.http("GET", "/chat/conversations", w.T.mgr)).body.rows.some((r) => r.id === room && r.title === "Ops room"));
  for (const k of ["admin", "sa", "agent1", "rec"]) {
    assert.ok(!(await w.http("GET", "/chat/conversations?limit=50", w.T[k])).body.rows.some((r) => r.id === room), k);
    assert.equal((await w.http("GET", `/chat/conversations/${room}/messages`, w.T[k])).status, 404, k);
  }
  for (const t of [f.candA.token, f.empA.token, f.agyA.token]) assert.equal((await w.http("GET", `/chat/conversations/${room}/messages`, t)).status, 404);
  // an explicit participant Agent can read an agency thread; a lazily created read marker does NOT grant access
  assert.equal((await w.http("GET", `/chat/conversations/${f.avA}/messages`, w.T.agent2)).status, 404);
  await w.q("INSERT INTO chat_participants (conversation_id, user_id, added_by) VALUES ($1,$2,$3)", [f.avA, w.id.agent2, w.id.admin]);
  assert.equal((await w.http("GET", `/chat/conversations/${f.avA}/messages`, w.T.agent2)).status, 200);
  await w.q("UPDATE chat_participants SET added_by = NULL WHERE conversation_id = $1 AND user_id = $2", [f.avA, w.id.agent2]);
  assert.equal((await w.http("GET", `/chat/conversations/${f.avA}/messages`, w.T.agent2)).status, 404);
  await w.q("DELETE FROM chat_participants WHERE conversation_id = $1 AND user_id = $2", [f.avA, w.id.agent2]);
  // an explicit grant on a CANDIDATE thread does not override assignment
  await w.q("INSERT INTO chat_participants (conversation_id, user_id, added_by) VALUES ($1,$2,$3)", [f.cvB, w.id.agent1, w.id.admin]);
  assert.equal((await w.http("GET", `/chat/conversations/${f.cvB}/messages`, w.T.agent1)).status, 404);
  await w.q("DELETE FROM chat_participants WHERE conversation_id = $1 AND user_id = $2", [f.cvB, w.id.agent1]);
});

// ------------------------------------------------------------------------------------------------ id validation
test("ids: malformed ids are 400 for every actor, out-of-int-range ids are the identical 404", async () => {
  const f = await fx();
  const { w } = f;
  const actors = [w.T.mgr, w.T.agent1, f.candA.token, f.empA.token];
  for (const t of actors) {
    for (const bad of ["abc", "1.5", "-1", "0", "1e3", "%20", "0x10", "1;DROP", "99999999999999999999"]) {
      for (const [m, u, b] of [["GET", `/chat/conversations/${bad}/messages`], ["POST", `/chat/conversations/${bad}/messages`, { body: "x" }], ["POST", `/chat/conversations/${bad}/read`, { message_id: 1 }], ["POST", `/chat/messages/${bad}/hide`, { reason: "x" }], ["POST", `/chat/conversations/${bad}/close`, {}]]) {
        const r = await w.http(m, u, t, b);
        if (u.includes("/hide") || u.includes("/close")) {
          assert.ok([400, 403].includes(r.status), `${m} ${u} -> ${r.status}`); // non-moderators are refused before the id is looked at
        } else assert.ok(r.status === 400 || (bad === "99999999999999999999" && r.status === 400), `${m} ${u} -> ${r.status} ${r.text}`);
      }
    }
    for (const big of ["2147483648", "9999999999999"]) {
      const r = await w.http("GET", `/chat/conversations/${big}/messages`, t);
      assert.equal(r.status, 404, big);
      assert.deepEqual(r.body, NOT_FOUND);
    }
  }
  const r = await w.http("POST", `/chat/conversations/${f.cvA}/read`, w.T.mgr, { message_id: "abc" });
  assert.equal(r.status, 400);
  assert.equal((await w.http("POST", `/chat/conversations/${f.cvA}/read`, w.T.mgr, {})).status, 400);
  assert.equal((await w.http("POST", `/chat/conversations/${f.cvA}/read`, w.T.mgr, { message_id: 9999999999 })).status, 400);
});

// ------------------------------------------------------------------------------------------------ sending
test("send: validation of the body (trim, 1..2000 characters, NUL, types, lone surrogates), text stored verbatim", async () => {
  const f = await fx();
  const { w } = f;
  const c = await w.mkCandidate("body", w.id.agent1);
  const conv = (await w.openAs(w.T.agent1, "candidate", c.id)).body.id;
  const bad = async (payload, label) => {
    const r = await w.http("POST", `/chat/conversations/${conv}/messages`, c.token, payload);
    assert.equal(r.status, 400, `${label}: ${r.text}`);
    assert.equal(typeof r.body.error, "string");
  };
  await bad({}, "missing");
  await bad({ body: "" }, "empty");
  await bad({ body: "   \n\t " }, "whitespace");
  await bad({ body: 123 }, "number");
  await bad({ body: null }, "null");
  await bad({ body: ["a"] }, "array");
  await bad({ body: { a: 1 } }, "object");
  await bad({ body: "x".repeat(2001) }, "2001 chars");
  await bad({ body: "a\u0000b" }, "NUL");
  await bad({ body: "\u0000" }, "only NUL");
  await bad({ body: "😀".repeat(2001) }, "2001 astral characters");
  await bad({ body: "ok\ud800" }, "lone high surrogate");
  await bad({ body: "\udc00ok" }, "lone low surrogate");
  assert.equal((await w.http("POST", `/chat/conversations/${conv}/messages`, c.token, [1])).status, 400);
  assert.equal((await w.http("POST", `/chat/conversations/${conv}/messages`, c.token, undefined)).status, 400);
  assert.equal((await w.http("POST", `/chat/conversations/${conv}/messages`, c.token, undefined, "{not json")).status, 400);
  assert.equal((await w.http("POST", `/chat/conversations/${conv}/messages`, c.token, { body: "x".repeat(20000) })).status, 413, "16 kb parser cap");
  assert.equal((await w.one("SELECT count(*)::int AS n FROM chat_messages WHERE conversation_id = $1", [conv])).n, 0, "nothing stored by rejected sends");

  const ok = async (text, expected = text) => {
    const r = await w.send(c.token, conv, text);
    assert.equal(r.status, 201, `${text.slice(0, 20)}: ${r.text}`);
    assert.equal(r.body.body, expected);
    const row = await w.one("SELECT body FROM chat_messages WHERE id = $1", [r.body.id]);
    assert.equal(row.body, expected, "stored verbatim");
    return r.body;
  };
  await ok("  padded \n", "padded");
  await ok("x".repeat(2000));
  await ok("😀".repeat(2000)); // 2000 characters = 8000 bytes: counted in characters, not bytes
  await ok("a");
  const bidi = "abc ‮evil.txt‬ ⁦x⁩ ​‌‍﻿ end العربية é́ \u{1F468}‍\u{1F469}‍\u{1F467}";
  await ok(bidi, bidi.trim());
  const html = `<img src=x onerror=alert(1)> <script>alert('x')</script> & "quoted" 'single' <a href="javascript:alert(1)">l</a> {{7*7}} \${7*7} ' OR 1=1; --`;
  const m = await ok(html);
  const listed = await w.http("GET", `/chat/conversations/${conv}/messages?limit=50`, w.T.agent1);
  assert.equal(listed.body.rows.find((x) => x.id === m.id).body, html, "HTML comes back as text, unchanged");
  assert.match(listed.headers.get("content-type"), /^application\/json/);
  assert.equal(listed.headers.get("cache-control"), "no-store");
});

test("send: closed conversations refuse sends (409) but stay readable; reopening restores sending; only moderators close/reopen", async () => {
  const f = await fx();
  const { w } = f;
  const c = await w.mkCandidate("closed", w.id.agent1);
  const conv = (await w.openAs(w.T.agent1, "candidate", c.id)).body.id;
  const first = (await w.send(c.token, conv, "before close")).body;
  for (const k of ["agent1", "rec"]) assert.equal((await w.http("POST", `/chat/conversations/${conv}/close`, w.T[k], {})).status, 403, k);
  assert.equal((await w.http("POST", `/chat/conversations/${conv}/close`, c.token, {})).status, 403);
  const closed = await w.http("POST", `/chat/conversations/${conv}/close`, w.T.mgr, {});
  assert.equal(closed.status, 200, closed.text);
  assert.equal(closed.body.status, "closed");
  assert.equal(closed.body.changed, true);
  assert.equal((await w.http("POST", `/chat/conversations/${conv}/close`, w.T.admin, {})).body.changed, false);
  for (const t of [c.token, w.T.agent1, w.T.mgr]) assert.equal((await w.send(t, conv, "after close")).status, 409);
  assert.equal((await w.one("SELECT count(*)::int AS n FROM chat_messages WHERE body = 'after close'")).n, 0);
  assert.equal((await w.http("GET", `/chat/conversations/${conv}/messages`, c.token)).status, 200);
  assert.equal((await w.http("POST", `/chat/conversations/${conv}/read`, c.token, { message_id: first.id })).status, 200);
  const listed = (await w.http("GET", "/chat/conversations", c.token)).body.rows[0];
  assert.equal(listed.status, "closed");
  // opening a closed subject returns the closed conversation, it does not reopen it
  const reopenViaOpen = await w.openAs(w.T.agent1, "candidate", c.id);
  assert.equal(reopenViaOpen.status, 200);
  assert.equal(reopenViaOpen.body.status, "closed");
  assert.equal((await w.http("POST", `/chat/conversations/${conv}/reopen`, w.T.agent1, {})).status, 403);
  const re = await w.http("POST", `/chat/conversations/${conv}/reopen`, w.T.mgr, {});
  assert.equal(re.status, 200);
  assert.equal(re.body.status, "open");
  assert.equal((await w.http("POST", `/chat/conversations/${conv}/reopen`, w.T.mgr, {})).body.changed, false);
  assert.equal((await w.send(c.token, conv, "after reopen")).status, 201);
  const audit = await w.q("SELECT action, user_id FROM audit_logs WHERE record_id = $1 AND action IN ('chat.conversation.close','chat.conversation.reopen') ORDER BY id", [String(conv)]);
  assert.deepEqual(audit.rows.map((r) => r.action), ["chat.conversation.close", "chat.conversation.reopen"], "only real state changes are audited");
  // a moderator outside scope gets the identical 404
  const staffRoom = (await w.one("INSERT INTO chat_conversations (subject_type, title) VALUES ('staff','private') RETURNING id")).id;
  const r404 = await w.http("POST", `/chat/conversations/${staffRoom}/close`, w.T.admin, {});
  assert.equal(r404.status, 404);
  assert.deepEqual(r404.body, NOT_FOUND);
});

test("send: audited with sender role, conversation and length but never the text; conversation pointers updated; response is the message", async () => {
  const f = await fx();
  const { w } = f;
  const c = await w.mkCandidate("audit", w.id.agent1);
  const conv = (await w.openAs(w.T.agent1, "candidate", c.id)).body.id;
  const r = await w.send(w.T.agent1, conv, "secret passport 12345");
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ["body", "conversation_id", "created_at", "hidden", "id", "mine", "sender_name", "sender_role", "sender_user_id"].sort());
  assert.equal(r.body.mine, true);
  const row = await w.one("SELECT * FROM audit_logs WHERE action = 'chat.message.send' AND record_id = $1", [String(r.body.id)]);
  assert.ok(row);
  assert.equal(row.user_id, w.id.agent1);
  assert.equal(row.table_name, "chat_messages");
  assert.equal(row.new_data.conversation_id, conv);
  assert.equal(row.new_data.sender_role, "Agent");
  assert.equal(row.new_data.length, 21);
  assert.ok(!JSON.stringify(row).includes("secret passport"));
  const cv = await w.one("SELECT last_message_id, last_message_at FROM chat_conversations WHERE id = $1", [conv]);
  assert.equal(String(cv.last_message_id), String(r.body.id));
  assert.ok(cv.last_message_at);
  const ext = await w.send(c.token, conv, "reply");
  assert.equal(ext.body.sender_role, "Candidate");
  assert.equal(ext.body.sender_user_id, undefined);
  assert.equal((await w.one("SELECT sender_role FROM chat_messages WHERE id = $1", [ext.body.id])).sender_role, "Candidate");
  assert.equal((await w.one("SELECT sender_role FROM chat_messages WHERE id = $1", [r.body.id])).sender_role, "Agent");
  // audit and message commit together: a failed send leaves neither
  const before = (await w.one("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'chat.message.send'")).n;
  await w.send(c.token, conv, "a\u0000b");
  assert.equal((await w.one("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'chat.message.send'")).n, before);
});

test("parallel sends: 20 concurrent sends -> unique increasing ids, no loss, consistent last pointer, correct unread counts", async () => {
  const f = await fx();
  const { w } = f;
  const c = await w.mkCandidate("par", w.id.agent1);
  const conv = (await w.openAs(w.T.agent1, "candidate", c.id)).body.id;
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => w.send(w.T.agent1, conv, `par-${i}`)));
  assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join());
  const got = results.map((r) => Number(r.body.id));
  assert.equal(new Set(got).size, 20, "ids are unique");
  const rows = (await w.q("SELECT id, body FROM chat_messages WHERE conversation_id = $1 ORDER BY id", [conv])).rows;
  assert.equal(rows.length, 20, "no loss");
  assert.deepEqual(new Set(rows.map((r) => r.body)), new Set(Array.from({ length: 20 }, (_, i) => `par-${i}`)));
  // ids follow commit order: a response never carries an id lower than one already committed before it started
  const cv = await w.one("SELECT last_message_id FROM chat_conversations WHERE id = $1", [conv]);
  assert.equal(String(cv.last_message_id), String(Math.max(...got)));
  const page = await w.http("GET", `/chat/conversations/${conv}/messages?limit=50`, c.token);
  assert.equal(page.body.rows.length, 20);
  const pageIds = page.body.rows.map((m) => m.id);
  assert.deepEqual(pageIds, [...pageIds].sort((a, b) => b - a), "newest first, strictly decreasing");
  assert.equal(new Set(pageIds).size, 20);
  // unread: the candidate has 20, the sender 0
  const cl = (await w.http("GET", "/chat/conversations", c.token)).body.rows.find((r) => r.id === conv);
  assert.equal(cl.unread_count, 20);
  const sl = (await w.http("GET", "/chat/conversations?limit=50", w.T.agent1)).body.rows.find((r) => r.id === conv);
  assert.equal(sl.unread_count, 0);
  assert.equal(cl.last_message.id, Math.max(...got));
  // mixed senders in parallel
  const mixed = await Promise.all([...Array.from({ length: 6 }, (_, i) => w.send(c.token, conv, `c-${i}`)), ...Array.from({ length: 6 }, (_, i) => w.send(w.T.mgr, conv, `m-${i}`)), ...Array.from({ length: 6 }, (_, i) => w.send(w.T.agent1, conv, `a-${i}`))]);
  assert.ok(mixed.every((r) => r.status === 201));
  assert.equal(new Set(mixed.map((r) => r.body.id)).size, 18);
  assert.equal((await w.one("SELECT count(*)::int AS n FROM chat_messages WHERE conversation_id = $1", [conv])).n, 38);
  assert.equal((await w.http("GET", "/chat/unread-count", c.token)).body.unread, 20 + 12);
});

test("rate limit: CHAT_RATE_PER_MIN counted per user across ALL conversations in SQL; 429 + Retry-After; other users unaffected", async () => {
  const f = await fx();
  const { w } = f;
  const a = await w.mkCandidate("rate1", w.id.agent1);
  const b = await w.mkCandidate("rate2", w.id.agent1);
  const ca = (await w.openAs(w.T.agent1, "candidate", a.id)).body.id;
  const cb = (await w.openAs(w.T.agent1, "candidate", b.id)).body.id;
  const limited = await w.mkStaff("ratey", "Agent");
  await w.q("UPDATE candidates SET assigned_to = $1 WHERE id IN ($2,$3)", [limited, a.id, b.id]);
  process.env.CHAT_RATE_PER_MIN = "3";
  try {
    assert.equal((await w.send(w.T.ratey, ca, "1")).status, 201);
    assert.equal((await w.send(w.T.ratey, cb, "2")).status, 201);
    assert.equal((await w.send(w.T.ratey, ca, "3")).status, 201);
    const over = await w.send(w.T.ratey, cb, "4"); // a different conversation does not reset the budget
    assert.equal(over.status, 429, over.text);
    const ra = Number(over.headers.get("retry-after"));
    assert.ok(Number.isInteger(ra) && ra >= 1 && ra <= 60, `Retry-After ${over.headers.get("retry-after")}`);
    assert.equal(typeof over.body.error, "string");
    assert.equal((await w.one("SELECT count(*)::int AS n FROM chat_messages WHERE sender_user_id = $1", [limited])).n, 3);
    // other senders have their own budget
    assert.equal((await w.send(a.token, ca, "candidate is fine")).status, 201);
    // parallel burst cannot overshoot the limit
    const burstUser = await w.mkStaff("ratez", "Manager");
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => w.send(w.T.ratez, i % 2 ? ca : cb, `b${i}`)));
    assert.equal(burst.filter((r) => r.status === 201).length, 3);
    assert.equal(burst.filter((r) => r.status === 429).length, 7);
    assert.equal((await w.one("SELECT count(*)::int AS n FROM chat_messages WHERE sender_user_id = $1", [burstUser])).n, 3);
    // reads, listing and marking read are not limited
    assert.equal((await w.http("GET", `/chat/conversations/${ca}/messages`, w.T.ratey)).status, 200);
  } finally {
    process.env.CHAT_RATE_PER_MIN = "1000";
  }
});

// ------------------------------------------------------------------------------------------------ listing, preview, pagination
test("messages: newest first, limit <= 50, before cursor pages without gaps or duplicates, bad paging params are 400", async () => {
  const f = await fx();
  const { w } = f;
  const c = await w.mkCandidate("page", w.id.agent1);
  const conv = (await w.openAs(w.T.agent1, "candidate", c.id)).body.id;
  const sent = [];
  for (let i = 0; i < 7; i++) sent.push((await w.send(i % 2 ? c.token : w.T.agent1, conv, `m${i}`)).body.id);
  const p1 = await w.http("GET", `/chat/conversations/${conv}/messages?limit=3`, c.token);
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.body.rows.map((m) => m.body), ["m6", "m5", "m4"]);
  assert.equal(p1.body.has_more, true);
  assert.equal(p1.body.next_before, sent[4]);
  const p2 = await w.http("GET", `/chat/conversations/${conv}/messages?limit=3&before=${p1.body.next_before}`, c.token);
  assert.deepEqual(p2.body.rows.map((m) => m.body), ["m3", "m2", "m1"]);
  const p3 = await w.http("GET", `/chat/conversations/${conv}/messages?limit=3&before=${p2.body.next_before}`, c.token);
  assert.deepEqual(p3.body.rows.map((m) => m.body), ["m0"]);
  assert.equal(p3.body.has_more, false);
  assert.equal(p3.body.next_before, null);
  // a message sent between pages does not disturb the cursor
  await w.send(w.T.agent1, conv, "late");
  const again = await w.http("GET", `/chat/conversations/${conv}/messages?limit=3&before=${p1.body.next_before}`, c.token);
  assert.deepEqual(again.body.rows.map((m) => m.body), ["m3", "m2", "m1"]);
  // default and maximum page size
  for (let i = 0; i < 55; i++) await w.q("INSERT INTO chat_messages (conversation_id, sender_user_id, sender_role, body) VALUES ($1,$2,'Agent',$3)", [conv, w.id.agent1, `bulk${i}`]);
  const big = await w.http("GET", `/chat/conversations/${conv}/messages?limit=500`, c.token);
  assert.equal(big.status, 200);
  assert.equal(big.body.rows.length, 50);
  assert.ok((await w.http("GET", `/chat/conversations/${conv}/messages`, c.token)).body.rows.length <= 50);
  assert.equal((await w.http("GET", `/chat/conversations/${conv}/messages?limit=1`, c.token)).body.rows.length, 1);
  for (const q of ["limit=abc", "limit=-1", "limit=0", "limit=1.5", "limit=1e2", "before=abc", "before=-3", "before=0", "limit=5&limit=6", "before=1&before=2", "before=99999999999"]) {
    assert.equal((await w.http("GET", `/chat/conversations/${conv}/messages?${q}`, c.token)).status, 400, q);
  }
  // before=1 just yields an empty page
  const empty = await w.http("GET", `/chat/conversations/${conv}/messages?before=1`, c.token);
  assert.deepEqual(empty.body.rows, []);
});

test("conversation list: unread_count, last message preview, newest activity first, paging <= 50, bad paging is 400", async () => {
  const f = await fx();
  const { w } = f;
  const user = await w.mkStaff("lister", "Manager");
  const c1 = await w.mkCandidate("list1", w.id.agent1);
  const c2 = await w.mkCandidate("list2", w.id.agent1);
  const v1 = (await w.openAs(w.T.lister, "candidate", c1.id)).body.id;
  const v2 = (await w.openAs(w.T.lister, "candidate", c2.id)).body.id;
  await w.send(c1.token, v1, "x".repeat(300));
  await w.send(c2.token, v2, "second thread newest");
  const list = await w.http("GET", "/chat/conversations?limit=50", c1.token);
  const mine = list.body.rows[0];
  assert.equal(mine.id, v1);
  assert.equal(mine.unread_count, 0);
  assert.equal(mine.last_message.preview.length <= 140, true);
  const staffList = (await w.http("GET", "/chat/conversations?limit=50", w.T.lister)).body.rows;
  const i1 = staffList.findIndex((r) => r.id === v1);
  const i2 = staffList.findIndex((r) => r.id === v2);
  assert.ok(i2 < i1, "most recent activity first");
  assert.equal(staffList[i1].unread_count, 1);
  assert.equal(staffList[i1].last_message.preview, "x".repeat(140));
  assert.equal(staffList[i2].last_message.preview, "second thread newest");
  assert.equal(staffList[i2].last_message.sender_role, "Candidate");
  assert.equal(typeof staffList[i2].last_message.id, "number");
  // a conversation without messages has no last message and sorts after active ones
  const quiet = await w.mkCandidate("list3", w.id.agent1);
  const v3 = (await w.openAs(w.T.lister, "candidate", quiet.id)).body.id;
  const again = (await w.http("GET", "/chat/conversations?limit=50", w.T.lister)).body.rows;
  const q3 = again.find((r) => r.id === v3);
  assert.equal(q3.last_message, null);
  assert.equal(q3.unread_count, 0);
  assert.ok(again.findIndex((r) => r.id === v3) > again.findIndex((r) => r.id === v2));
  const p1 = await w.http("GET", "/chat/conversations?limit=2", w.T.mgr);
  const p2 = await w.http("GET", "/chat/conversations?limit=2&offset=2", w.T.mgr);
  assert.equal(p1.body.rows.length, 2);
  assert.equal(p1.body.has_more, true);
  assert.ok(p1.body.rows.every((a) => !p2.body.rows.some((b) => b.id === a.id)));
  assert.ok((await w.http("GET", "/chat/conversations?limit=900", w.T.mgr)).body.rows.length <= 50);
  for (const q of ["limit=abc", "limit=0", "limit=-1", "offset=-1", "offset=abc", "limit=1&limit=2"]) assert.equal((await w.http("GET", `/chat/conversations?${q}`, w.T.mgr)).status, 400, q);
});

// ------------------------------------------------------------------------------------------------ read state
test("read: monotonic last_read_message_id, message must belong to the conversation, unread math and /unread-count", async () => {
  const f = await fx();
  const { w } = f;
  const c = await w.mkCandidate("read", w.id.agent1);
  const other = await w.mkCandidate("read2", w.id.agent1);
  const conv = (await w.openAs(w.T.agent1, "candidate", c.id)).body.id;
  const conv2 = (await w.openAs(w.T.agent1, "candidate", other.id)).body.id;
  const m = [];
  for (let i = 0; i < 5; i++) m.push((await w.send(w.T.agent1, conv, `r${i}`)).body.id);
  const foreignMsg = (await w.send(w.T.agent1, conv2, "elsewhere")).body.id;
  const before = (await w.http("GET", "/chat/unread-count", c.token)).body;
  assert.equal(before.unread, 5);
  assert.equal(before.conversations, 1);
  const r1 = await w.http("POST", `/chat/conversations/${conv}/read`, c.token, { message_id: m[2] });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(String(r1.body.last_read_message_id), String(m[2]));
  assert.equal(r1.body.unread_count, 2);
  const back = await w.http("POST", `/chat/conversations/${conv}/read`, c.token, { message_id: m[0] });
  assert.equal(back.status, 200);
  assert.equal(String(back.body.last_read_message_id), String(m[2]), "never moves backwards");
  assert.equal(back.body.unread_count, 2);
  const miss = await w.http("POST", `/chat/conversations/${conv}/read`, c.token, { message_id: foreignMsg });
  assert.equal(miss.status, 404);
  assert.deepEqual(miss.body, NOT_FOUND);
  assert.equal((await w.http("POST", `/chat/conversations/${conv}/read`, c.token, { message_id: 2000000000 })).status, 404);
  assert.equal(String((await w.one("SELECT last_read_message_id FROM chat_participants WHERE conversation_id = $1 AND user_id = $2", [conv, c.userId])).last_read_message_id), String(m[2]));
  await w.http("POST", `/chat/conversations/${conv}/read`, c.token, { message_id: m[4] });
  assert.equal((await w.http("GET", "/chat/unread-count", c.token)).body.unread, 0);
  assert.equal((await w.http("GET", "/chat/conversations", c.token)).body.rows[0].unread_count, 0);
  // the candidate answers: own messages are never unread for the sender, new staff messages are
  await w.send(c.token, conv, "my reply");
  assert.equal((await w.http("GET", "/chat/unread-count", c.token)).body.unread, 0);
  await w.send(w.T.agent1, conv, "new one");
  assert.equal((await w.http("GET", "/chat/unread-count", c.token)).body.unread, 1);
  // a participant row exists lazily for the reader but grants nothing to anybody else
  assert.equal((await w.q("SELECT 1 FROM chat_participants WHERE conversation_id = $1 AND added_by IS NOT NULL", [conv])).rowCount, 0);
  // unread totals never include conversations the viewer cannot see
  assert.equal((await w.http("GET", "/chat/unread-count", other.token)).body.unread, 0 + 1);
  const total = await w.http("GET", "/chat/unread-count", f.empB.token);
  assert.ok(total.body.unread >= 1);
  assert.deepEqual(Object.keys(total.body).sort(), ["conversations", "unread"]);
});

// ------------------------------------------------------------------------------------------------ moderation
test("hide / unhide: reason required, staff see body + reason, external parties get a stub; preview, unread and pagination never leak the text", async () => {
  const f = await fx();
  const { w } = f;
  const c = await w.mkCandidate("hide", w.id.agent1);
  const conv = (await w.openAs(w.T.agent1, "candidate", c.id)).body.id;
  const m1 = (await w.send(w.T.agent1, conv, "visible one")).body;
  const bad = (await w.send(w.T.agent1, conv, "SECRET-INSULT")).body;
  const m3 = (await w.send(w.T.agent1, conv, "visible three")).body;
  // permissions
  for (const k of ["agent1", "rec"]) assert.equal((await w.http("POST", `/chat/messages/${bad.id}/hide`, w.T[k], { reason: "x" })).status, 403, k);
  assert.equal((await w.http("POST", `/chat/messages/${bad.id}/hide`, c.token, { reason: "x" })).status, 403);
  // validation
  for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: 5 }, { reason: "a\u0000" }, { reason: "x".repeat(501) }, { reason: ["a"] }]) {
    assert.equal((await w.http("POST", `/chat/messages/${bad.id}/hide`, w.T.mgr, body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await w.one("SELECT hidden_at FROM chat_messages WHERE id = $1", [bad.id])).hidden_at, null);
  // unread BEFORE hiding includes it for the candidate
  assert.equal((await w.http("GET", "/chat/unread-count", c.token)).body.unread, 3);
  const hid = await w.http("POST", `/chat/messages/${bad.id}/hide`, w.T.mgr, { reason: "  abusive language  " });
  assert.equal(hid.status, 200, hid.text);
  assert.equal(hid.body.hidden, true);
  assert.equal(hid.body.hidden_reason, "abusive language");
  assert.equal(hid.body.body, "SECRET-INSULT", "moderators still see the text");
  assert.equal(hid.body.changed, true);
  const row = await w.one("SELECT hidden_at, hidden_by, hidden_reason FROM chat_messages WHERE id = $1", [bad.id]);
  assert.ok(row.hidden_at);
  assert.equal(row.hidden_by, w.id.mgr);
  // the external party: stub only, nowhere else
  const ext = await w.http("GET", `/chat/conversations/${conv}/messages`, c.token);
  const stub = ext.body.rows.find((x) => x.id === bad.id);
  assert.deepEqual(stub, { id: bad.id, created_at: stub.created_at, hidden: true });
  assert.ok(!ext.text.includes("SECRET-INSULT") && !ext.text.includes("abusive"));
  assert.equal(ext.body.rows.length, 3, "position kept so pagination stays gap-free");
  const paged = await w.http("GET", `/chat/conversations/${conv}/messages?limit=1&before=${m3.id}`, c.token);
  assert.deepEqual(paged.body.rows.map((x) => x.id), [bad.id]);
  assert.ok(!paged.text.includes("SECRET-INSULT"));
  assert.equal((await w.http("GET", "/chat/unread-count", c.token)).body.unread, 2, "hidden messages are not unread for the external party");
  // staff: full body and the reason
  const staff = await w.http("GET", `/chat/conversations/${conv}/messages`, w.T.agent1);
  const sm = staff.body.rows.find((x) => x.id === bad.id);
  assert.equal(sm.body, "SECRET-INSULT");
  assert.equal(sm.hidden, true);
  assert.equal(sm.hidden_reason, "abusive language");
  assert.ok(sm.hidden_at);
  assert.equal(sm.hidden_by, w.id.mgr);
  // preview: when the LAST message is hidden, externals get a stub and no text anywhere in the list
  const m4 = (await w.send(w.T.agent1, conv, "SECRET-LAST")).body;
  await w.http("POST", `/chat/messages/${m4.id}/hide`, w.T.admin, { reason: "pii" });
  const list = await w.http("GET", "/chat/conversations", c.token);
  assert.ok(!list.text.includes("SECRET-LAST"));
  assert.deepEqual(list.body.rows[0].last_message, { id: m4.id, created_at: list.body.rows[0].last_message.created_at, hidden: true });
  assert.equal(list.body.rows[0].unread_count, 2);
  const slist = (await w.http("GET", "/chat/conversations?limit=50", w.T.agent1)).body.rows.find((r) => r.id === conv);
  assert.equal(slist.last_message.preview, "SECRET-LAST");
  assert.equal(slist.last_message.hidden, true);
  // an external sender's own hidden message is also a stub to them
  const own = (await w.send(c.token, conv, "my own bad words")).body;
  await w.http("POST", `/chat/messages/${own.id}/hide`, w.T.mgr, { reason: "policy" });
  const back = await w.http("GET", `/chat/conversations/${conv}/messages`, c.token);
  assert.deepEqual(back.body.rows.find((x) => x.id === own.id), { id: own.id, created_at: back.body.rows.find((x) => x.id === own.id).created_at, hidden: true });
  // idempotent re-hide does not overwrite the first reason or hider
  const again = await w.http("POST", `/chat/messages/${bad.id}/hide`, w.T.admin, { reason: "different" });
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, false);
  assert.equal(again.body.hidden_reason, "abusive language");
  assert.equal((await w.one("SELECT hidden_by FROM chat_messages WHERE id = $1", [bad.id])).hidden_by, w.id.mgr);
  // audit
  const audit = await w.q("SELECT * FROM audit_logs WHERE action = 'chat.message.hide' AND record_id = $1", [String(bad.id)]);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].user_id, w.id.mgr);
  assert.equal(audit.rows[0].new_data.reason, "abusive language");
  // unhide restores everything
  assert.equal((await w.http("POST", `/chat/messages/${bad.id}/unhide`, w.T.agent1, { reason: "x" })).status, 403);
  const un = await w.http("POST", `/chat/messages/${bad.id}/unhide`, w.T.mgr, { reason: "reviewed, fine" });
  assert.equal(un.status, 200, un.text);
  assert.equal(un.body.hidden, false);
  assert.equal(un.body.changed, true);
  assert.equal(un.body.hidden_reason, undefined);
  const back2 = await w.http("GET", `/chat/conversations/${conv}/messages`, c.token);
  assert.equal(back2.body.rows.find((x) => x.id === bad.id).body, "SECRET-INSULT");
  assert.equal((await w.http("POST", `/chat/messages/${bad.id}/unhide`, w.T.mgr, { reason: "again" })).body.changed, false);
  const ua = await w.q("SELECT * FROM audit_logs WHERE action = 'chat.message.unhide' AND record_id = $1", [String(bad.id)]);
  assert.equal(ua.rowCount, 1);
  assert.equal(ua.rows[0].new_data.reason, "reviewed, fine");
  assert.equal(m1.hidden, false);
});

test("moderation scope: a moderator cannot reach messages of conversations outside their scope; missing and foreign message ids are the identical 404", async () => {
  const f = await fx();
  const { w } = f;
  const room = (await w.one("INSERT INTO chat_conversations (subject_type, title) VALUES ('staff','mod room') RETURNING id")).id;
  const rm = (await w.one("INSERT INTO chat_messages (conversation_id, sender_user_id, sender_role, body) VALUES ($1,$2,'Manager','room secret') RETURNING id", [room, w.id.mgr])).id;
  const miss = await w.http("POST", "/chat/messages/2000000000/hide", w.T.mgr, { reason: "x" });
  assert.equal(miss.status, 404);
  assert.deepEqual(miss.body, NOT_FOUND);
  const foreign = await w.http("POST", `/chat/messages/${rm}/hide`, w.T.admin, { reason: "x" });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.text, miss.text);
  assert.equal((await w.http("POST", `/chat/messages/${rm}/unhide`, w.T.sa, { reason: "x" })).status, 404);
  assert.equal((await w.one("SELECT hidden_at FROM chat_messages WHERE id = $1", [rm])).hidden_at, null);
});

// ------------------------------------------------------------------------------------------------ immutability
test("messages are immutable: no API edits or deletes exist, the database refuses direct ones, only the hide columns change", async () => {
  const f = await fx();
  const { w } = f;
  const mid = (await w.one("SELECT id FROM chat_messages ORDER BY id LIMIT 1")).id;
  const cid = f.cvA;
  for (const [m, u] of [["PUT", `/chat/messages/${mid}`], ["PATCH", `/chat/messages/${mid}`], ["DELETE", `/chat/messages/${mid}`], ["POST", `/chat/messages/${mid}`], ["PUT", `/chat/conversations/${cid}/messages/${mid}`], ["PATCH", `/chat/conversations/${cid}/messages/${mid}`],
    ["DELETE", `/chat/conversations/${cid}/messages/${mid}`], ["PATCH", `/chat/conversations/${cid}/messages`], ["DELETE", `/chat/conversations/${cid}`], ["PUT", `/chat/conversations/${cid}`], ["PATCH", `/chat/conversations/${cid}`]]) {
    for (const t of [w.T.sa, w.T.mgr, f.candA.token]) {
      const r = await w.http(m, u, t, { body: "edited" });
      assert.ok([404, 405].includes(r.status), `${m} ${u} -> ${r.status}`);
    }
  }
  assert.equal((await w.one("SELECT count(*)::int AS n FROM chat_messages WHERE body = 'edited'")).n, 0);
  await assert.rejects(w.q("UPDATE chat_messages SET body = 'x' WHERE id = $1", [mid]), /immutable/);
  await assert.rejects(w.q("DELETE FROM chat_messages WHERE id = $1", [mid]), /immutable/);
});
