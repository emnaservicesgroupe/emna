// Isolation matrix (Task 14): every new endpoint (dashboard, reports, health, export, SSE) and the
// existing scoped endpoints (applications list/get, matches, messages, interviews, submissions, signed
// file links) for candidate A, candidate C, staff X, staff Y, admin, unauthenticated, Accountant, HR.
// Real HTTP + Postgres; SSE over a real streaming fetch with an AbortController and a fast poller.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createTestDb, loadApp } = require("./helpers/db");
const { makePdf } = require("./helpers/docs");
const { seed, tokens } = require("./helpers/jsReportsSeed");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-isolation-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "js-isolation-"));
process.env.STORAGE_URL_SECRET = "isolation-storage-secret";
process.env.MAIL_PROVIDER = "sandbox";
process.env.JOBSEARCH_EXPORT_RATE_PER_HOUR = "1000";
process.env.JOBSEARCH_SSE_POLL_MS = "50";
process.env.JOBSEARCH_SSE_RECHECK_MS = "250";
process.env.JOBSEARCH_SSE_HEARTBEAT_MS = "400";
delete process.env.JOBSEARCH_EXPORT_MAX_ROWS;
delete process.env.CLAMAV_HOST;

const eventsHub = require("../modules/jobsearch/eventsHub");
const storage = require("../modules/jobsearch/storage");

let pool;
let cleanup;
let server;
let base;
let s;
let tk;
const ACTORS = ["candA", "candC", "X", "Y", "admin", "accountant", "hr", "unauth"];
let allowed; // actor -> candidate ids in scope

test.before(async () => {
  ({ pool, cleanup } = await createTestDb());
  const app = loadApp(pool);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  s = await seed(pool);
  tk = tokens(s, process.env.JWT_SECRET);
  const { A, B, C } = s.cand;
  allowed = { admin: [A, B, C], X: [A, B], Y: [C], candA: [A], candC: [C], accountant: [], hr: [], unauth: [] };
});
test.after(async () => {
  eventsHub.shutdown();
  await new Promise((r) => server.close(r));
  await cleanup();
});

const q = (sql, params) => pool.query(sql, params);
const num = async (sql, params) => Number((await q(sql, params)).rows[0].n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, actor, headers = {}) {
  const token = actor && actor !== "unauth" ? tk[actor] : null;
  const res = await fetch(`${base}${url}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body, text };
}

const appOf = (key, i = 0) => s.apps[key][i].id;
const candOfApp = async (id) => (await q("SELECT candidate_id FROM js_applications WHERE id = $1", [id])).rows[0].candidate_id;
const isStaffOrAdmin = (a) => ["X", "Y", "admin"].includes(a);

// ---------------------------------------------------------------- existing endpoints

test("matrix: GET /applications lists only in-scope candidates; Accountant/HR 403; unauthenticated 401", async () => {
  for (const actor of ACTORS) {
    const r = await get("/jobsearch/applications?pageSize=100", actor);
    if (actor === "unauth") assert.equal(r.status, 401);
    else if (actor === "accountant" || actor === "hr") assert.equal(r.status, 403, actor);
    else {
      assert.equal(r.status, 200, actor);
      const ids = new Set(r.body.applications.map((a) => a.candidateId));
      assert.deepEqual([...ids].sort(), [...allowed[actor]].sort(), actor);
      assert.equal(r.body.total, await num(`SELECT count(*) AS n FROM js_applications WHERE candidate_id = ANY($1::int[])`, [allowed[actor]]), actor);
    }
  }
});

test("matrix: GET /applications/:id, /candidates/:id/matches, /submissions?applicationId= -> 200 in scope, 404 otherwise (incl. guessed and deleted ids)", async () => {
  const targets = { A: appOf("A", 4), C: appOf("C", 1), D: appOf("D", 0) };
  for (const actor of ACTORS) {
    for (const [key, appId] of Object.entries(targets)) {
      const cid = s.cand[key];
      const inScope = allowed[actor].includes(cid);
      const want = actor === "unauth" ? 401 : inScope ? 200 : 404;
      assert.equal((await get(`/jobsearch/applications/${appId}`, actor)).status, want, `${actor} app ${key}`);
      const m = await get(`/jobsearch/candidates/${cid}/matches`, actor);
      if (actor === "unauth") assert.equal(m.status, 401);
      else if (inScope) assert.equal(m.status, 200, `${actor} matches ${key}`);
      else if (actor === "accountant" || actor === "hr") assert.ok([403, 404].includes(m.status), `${actor} matches ${key}: ${m.status}`);
      else assert.equal(m.status, 404, `${actor} matches ${key}`);
      const sub = await get(`/jobsearch/submissions?applicationId=${appId}`, actor);
      assert.equal(sub.status, want, `${actor} submissions ${key}`);
      if (sub.status === 200 && actor.startsWith("cand")) for (const x of sub.body.submissions) assert.equal(x.recipient, undefined, "candidate view redacted");
    }
    if (actor !== "unauth") assert.equal((await get("/jobsearch/applications/987654", actor)).status, 404, `${actor} guessed id`);
  }
});

test("matrix: GET /messages and /messages/:id - staff only their candidates' replies, candidates only released replies", async () => {
  const msgOf = async (key) => (await q("SELECT m.id, m.shared_with_candidate FROM js_messages m JOIN js_applications a ON a.id = m.application_id WHERE a.candidate_id = $1 ORDER BY m.id", [s.cand[key]])).rows;
  const msgsA = await msgOf("A");
  const msgsC = await msgOf("C");
  for (const actor of ACTORS) {
    const r = await get("/jobsearch/messages", actor);
    if (actor === "unauth") {
      assert.equal(r.status, 401);
      continue;
    }
    if (actor === "accountant" || actor === "hr") {
      assert.notEqual(r.status, 200, actor);
      continue;
    }
    assert.equal(r.status, 200, actor);
    for (const m of r.body.messages) {
      if (m.applicationId === null) {
        assert.ok(["admin", "X"].includes(actor), `${actor} sees the unmatched review queue`);
        continue;
      }
      assert.ok(allowed[actor].includes(await candOfApp(m.applicationId)), `${actor} sees message of app ${m.applicationId}`);
    }
    if (actor.startsWith("cand")) {
      const own = actor === "candA" ? msgsA : msgsC;
      assert.deepEqual(r.body.messages.map((m) => m.id).sort(), own.filter((m) => m.shared_with_candidate).map((m) => m.id).sort(), "released only");
      assert.ok(r.body.messages.every((m) => m.from === undefined && m.body === undefined));
    }
    for (const [key, list] of [["A", msgsA], ["C", msgsC]]) {
      const inScope = allowed[actor].includes(s.cand[key]);
      for (const m of list) {
        const one = await get(`/jobsearch/messages/${m.id}`, actor);
        const visible = inScope && (!actor.startsWith("cand") || m.shared_with_candidate);
        assert.equal(one.status, visible ? 200 : 404, `${actor} message ${m.id} of ${key}`);
      }
    }
  }
});

test("matrix: GET /interviews only in-scope appointments", async () => {
  for (const actor of ACTORS) {
    const r = await get("/jobsearch/interviews", actor);
    if (actor === "unauth") {
      assert.equal(r.status, 401);
      continue;
    }
    if (actor === "accountant" || actor === "hr") {
      assert.equal(r.status, 403, actor);
      continue;
    }
    assert.equal(r.status, 200);
    assert.ok(r.body.interviews.every((i) => allowed[actor].includes(i.candidateId)), actor);
    assert.equal(r.body.interviews.length, await num("SELECT count(*) AS n FROM js_appointments WHERE candidate_id = ANY($1::int[])", [allowed[actor]]), actor);
  }
});

test("matrix: signed file links are re-authorised per user (another scope's file -> 404 even with a valid signature)", async () => {
  const put = await storage.put(makePdf("Candidate C\nElectrician"), { candidateId: s.cand.C });
  await q("INSERT INTO js_cv_files (candidate_id, storage_key, sha256, version, language, approved, scan_status) VALUES ($1,$2,$3,1,'en',true,'clean')", [s.cand.C, put.key, put.sha256]);
  const userOf = { candA: s.users.candA, candC: s.users.candC, X: s.users.X, Y: s.users.Y, admin: s.users.admin, accountant: s.users.accountant, hr: s.users.hr };
  for (const actor of Object.keys(userOf)) {
    const url = storage.signUrl(put.key, userOf[actor]);
    const r = await fetch(`${base}${url}`, { headers: { authorization: `Bearer ${tk[actor]}` } });
    await r.arrayBuffer();
    assert.equal(r.status, allowed[actor].includes(s.cand.C) ? 200 : 404, actor);
  }
  // a link signed for Y but used by X
  const r = await fetch(`${base}${storage.signUrl(put.key, s.users.Y)}`, { headers: { authorization: `Bearer ${tk.X}` } });
  await r.arrayBuffer();
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------- new endpoints

test("matrix: dashboard / reports / health / export per actor", async () => {
  for (const actor of ACTORS) {
    const d = await get("/jobsearch/dashboard", actor);
    if (actor === "unauth") assert.equal(d.status, 401);
    else if (actor === "accountant" || actor === "hr") assert.equal(d.status, 403);
    else {
      assert.equal(d.status, 200, actor);
      assert.deepEqual(d.body.candidates.map((c) => c.candidateId).sort(), [...allowed[actor]].sort(), actor);
      assert.equal(d.body.totals.applications, await num("SELECT count(*) AS n FROM js_applications WHERE candidate_id = ANY($1::int[])", [allowed[actor]]), actor);
      for (const other of [s.cand.A, s.cand.C, s.cand.D]) {
        const one = await get(`/jobsearch/dashboard?candidateId=${other}`, actor);
        assert.equal(one.status, allowed[actor].includes(other) ? 200 : 404, `${actor} dashboard ${other}`);
      }
    }
    const rep = await get("/jobsearch/reports?from=2026-03-01&to=2026-03-31&groupBy=candidate", actor);
    assert.equal(rep.status, actor === "unauth" ? 401 : isStaffOrAdmin(actor) ? 200 : 403, `${actor} reports`);
    if (rep.status === 200) assert.ok(rep.body.rows.every((r) => allowed[actor].includes(Number(r.key))), `${actor} report rows`);
    const h = await get("/jobsearch/health", actor);
    assert.equal(h.status, actor === "unauth" ? 401 : ["X", "admin"].includes(actor) ? 200 : 403, `${actor} health`);
    for (const type of ["applications", "matches", "submissions", "messages", "tasks"]) {
      const e = await get(`/jobsearch/export.csv?type=${type}`, actor);
      if (actor === "unauth") assert.equal(e.status, 401);
      else if (actor === "accountant" || actor === "hr") assert.equal(e.status, 403);
      else if (actor.startsWith("cand") && !["applications", "matches"].includes(type)) assert.equal(e.status, 403, `${actor} ${type}`);
      else {
        assert.equal(e.status, 200, `${actor} ${type}`);
        const lines = e.text.trim().split("\r\n");
        const header = lines[0].split(",");
        const tables = { applications: "js_applications x", matches: "js_matches x", submissions: "js_submissions s JOIN js_applications x ON x.id = s.application_id", messages: "js_messages m JOIN js_applications x ON x.id = m.application_id", tasks: "js_tasks t JOIN js_applications x ON x.id = t.application_id" };
        const want = await num(`SELECT count(*) AS n FROM ${tables[type]} WHERE x.candidate_id = ANY($1::int[])`, [allowed[actor]]);
        assert.equal(lines.length - 1, want, `${actor} ${type} rows`);
        assert.ok(!header.includes("storage_key"));
        const ci = header.indexOf("candidate_id");
        if (ci >= 0) for (const l of lines.slice(1)) assert.ok(allowed[actor].includes(Number(l.split(",")[ci])), `${actor} ${type} row in scope`);
      }
    }
  }
});

// ---------------------------------------------------------------- SSE

async function sse(actor, { lastEventId, token } = {}) {
  const ac = new AbortController();
  const tok = token || (actor && actor !== "unauth" ? tk[actor] : null);
  const res = await fetch(`${base}/jobsearch/events`, {
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(lastEventId !== undefined ? { "last-event-id": String(lastEventId) } : {}) },
    signal: ac.signal,
  });
  const st = { status: res.status, events: [], comments: [], closed: false, close: () => ac.abort(), headers: res.headers };
  if (res.status !== 200) {
    st.body = await res.text();
    st.closed = true;
    return st;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  st.done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (data) st.events.push(JSON.parse(data));
          for (const l of block.split("\n")) if (l.startsWith(":")) st.comments.push(l);
        }
      }
    } catch {
      /* aborted */
    }
    st.closed = true;
  })();
  return st;
}

async function waitFor(pred, ms = 1800, label = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(20);
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("SSE: auth (401 without Bearer header, query-string tokens ignored), Accountant 403, bad Last-Event-ID 400, headers", async () => {
  assert.equal((await sse("unauth")).status, 401);
  const qs = await fetch(`${base}/jobsearch/events?token=${encodeURIComponent(tk.admin)}&access_token=${encodeURIComponent(tk.admin)}`);
  await qs.text();
  assert.equal(qs.status, 401, "a token in the query string is never accepted");
  assert.equal((await sse("accountant")).status, 403);
  assert.equal((await sse("hr")).status, 403);
  assert.equal((await sse("admin", { lastEventId: "abc" })).status, 400);
  const ok = await sse("admin");
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /^text\/event-stream/);
  assert.match(ok.headers.get("cache-control"), /no-store/);
  ok.close();
  await waitFor(() => eventsHub.stats().subscribers === 0, 1800, "cleanup on close");
});

test("SSE: Last-Event-ID replay obeys scope and audience; payloads are neutral (whitelisted fields only)", async () => {
  const evs = (await q("SELECT id, candidate_id, audience FROM js_events ORDER BY id")).rows.map((r) => ({ id: Number(r.id), cid: r.candidate_id, audience: r.audience }));
  const idsFor = (pred) => evs.filter(pred).map((e) => e.id);
  const expect = {
    candA: idsFor((e) => e.cid === s.cand.A && e.audience === "candidate"),
    candC: idsFor((e) => e.cid === s.cand.C && e.audience === "candidate"),
    X: idsFor((e) => e.cid === s.cand.A || e.cid === s.cand.B),
    Y: idsFor((e) => e.cid === s.cand.C),
    admin: evs.map((e) => e.id),
  };
  for (const [actor, ids] of Object.entries(expect)) {
    const st = await sse(actor, { lastEventId: 0 });
    assert.equal(st.status, 200, actor);
    await waitFor(() => st.events.length >= ids.length, 1800, `${actor} replay`);
    await sleep(120);
    assert.deepEqual(st.events.map((e) => e.id), ids, actor);
    for (const e of st.events) {
      assert.equal(e.secret, undefined);
      assert.ok(!JSON.stringify(e).includes("@"), `no addresses in ${JSON.stringify(e)}`);
      for (const k of Object.keys(e)) assert.ok(["id", "kind", "at", "applicationId", "status", "from", "to", "messageId", "taskId", "submissionId", "appointmentId"].includes(k), k);
    }
    if (actor === "candA") assert.ok(st.events.every((e) => !e.kind.startsWith("staff.")), "candidate never gets staff events");
    st.close();
  }
  // replay from a later id only returns newer events
  const last = expect.X[expect.X.length - 1];
  const st = await sse("X", { lastEventId: last });
  await sleep(200);
  assert.deepEqual(st.events, []);
  st.close();
  await waitFor(() => eventsHub.stats().subscribers === 0, 1800, "cleanup");
});

test("SSE live: X never receives C's events, candidate A never receives audience='staff'; heartbeats arrive", async () => {
  const x = await sse("X");
  const y = await sse("Y");
  const a = await sse("candA");
  await sleep(100);
  const ec1 = await eventsHub.publish(s.cand.C, "application.status_changed", { applicationId: appOf("C"), from: "sent", to: "interview", note: "secret note" }, "candidate");
  const es1 = await eventsHub.publish(s.cand.A, "staff.reply_received", { applicationId: appOf("A"), messageId: 9, from: "hr@x.example" }, "staff", { userId: s.users.X });
  const ea1 = await eventsHub.publish(s.cand.A, "application.status_changed", { applicationId: appOf("A"), from: "queued", to: "sent" }, "candidate");
  const sys = await eventsHub.publish(null, "module.paused", { paused: true }, "candidate");
  await waitFor(() => x.events.length >= 2 && y.events.length >= 1 && a.events.length >= 1, 1800, "live delivery");
  await sleep(200);
  assert.deepEqual(x.events.map((e) => e.id), [es1.id, ea1.id]);
  assert.deepEqual(y.events.map((e) => e.id), [ec1.id]);
  assert.deepEqual(a.events.map((e) => e.id), [ea1.id]);
  assert.deepEqual(a.events[0], { id: ea1.id, kind: "application.status_changed", at: a.events[0].at, applicationId: appOf("A"), from: "queued", to: "sent" });
  assert.equal(x.events[0].from, undefined, "staff event 'from' address dropped");
  assert.ok(![x, y, a].some((st) => st.events.some((e) => e.id === sys.id)), "unscoped system events: admin only");
  await waitFor(() => x.comments.some((c) => c.startsWith(": heartbeat")), 1800, "heartbeat");
  for (const st of [x, y, a]) st.close();
  await waitFor(() => eventsHub.stats().subscribers === 0 && !eventsHub.stats().polling, 1800, "cleanup + poller stopped");
});

test("SSE: reassigning C to X starts delivery after the next re-check; reassigning back stops it", async () => {
  const x = await sse("X");
  await sleep(100);
  const before = await eventsHub.publish(s.cand.C, "application.status_changed", { applicationId: appOf("C"), from: "a", to: "b" });
  await sleep(150);
  await q("UPDATE candidates SET assigned_to = $1 WHERE id = $2", [s.users.X, s.cand.C]);
  try {
    await sleep(450); // > recheck (250 ms) + poll
    const after = await eventsHub.publish(s.cand.C, "application.status_changed", { applicationId: appOf("C"), from: "b", to: "c" });
    await waitFor(() => x.events.some((e) => e.id === after.id), 1800, "delivery after reassignment");
    assert.ok(!x.events.some((e) => e.id === before.id), "nothing from before the reassignment");
  } finally {
    await q("UPDATE candidates SET assigned_to = $1 WHERE id = $2", [s.users.Y, s.cand.C]);
  }
  await sleep(450);
  const gone = await eventsHub.publish(s.cand.C, "application.status_changed", { applicationId: appOf("C"), from: "c", to: "d" });
  const mine = await eventsHub.publish(s.cand.A, "application.status_changed", { applicationId: appOf("A"), from: "c", to: "d" });
  await waitFor(() => x.events.some((e) => e.id === mine.id), 1800, "still receiving own");
  assert.ok(!x.events.some((e) => e.id === gone.id), "C's events stop after reassignment back");
  x.close();
  await waitFor(() => eventsHub.stats().subscribers === 0, 1800, "cleanup");
});

test("SSE: max 3 streams per user (4th -> 429); suspending the user closes the stream at the next re-check", async () => {
  const ys = [await sse("Y"), await sse("Y"), await sse("Y")];
  assert.ok(ys.every((st) => st.status === 200));
  const fourth = await sse("Y");
  assert.equal(fourth.status, 429);
  const x = await sse("X");
  assert.equal(x.status, 200, "the cap is per user");
  for (const st of ys) st.close();
  x.close();
  await waitFor(() => eventsHub.stats().subscribers === 0, 1800, "cleanup");

  // candidate A (versioned token) is suspended by an admin -> stream closes; staff Y deactivated -> closes too
  const a = await sse("candA");
  const y = await sse("Y");
  assert.equal(a.status, 200);
  const r = await fetch(`${base}/jobsearch/admin/users/${s.users.candA}/suspend`, { method: "POST", headers: { authorization: `Bearer ${tk.admin}` } });
  assert.equal(r.status, 200);
  await q("UPDATE users SET is_active = false WHERE id = $1", [s.users.Y]);
  try {
    await waitFor(() => a.closed && y.closed, 1800, "revoked streams closed");
    const after = await eventsHub.publish(s.cand.A, "application.status_changed", { applicationId: appOf("A"), from: "x", to: "y" });
    await sleep(150);
    assert.ok(!a.events.some((e) => e.id === after.id));
    // the old candidate token is refused on reconnect
    assert.equal((await sse("candA")).status, 401);
  } finally {
    await q("UPDATE users SET is_active = true WHERE id = $1", [s.users.Y]);
  }
  await waitFor(() => eventsHub.stats().subscribers === 0, 1800, "cleanup");
});

test("SSE: total cap and unknown/unsafe kinds are never delivered", async () => {
  process.env.JOBSEARCH_SSE_MAX_TOTAL = "1";
  try {
    const one = await sse("admin");
    assert.equal(one.status, 200);
    assert.equal((await sse("X")).status, 503);
    // a row with an unsafe kind written directly is skipped
    const bad = (await q("INSERT INTO js_events (candidate_id, kind, payload) VALUES (NULL, 'Bad Kind<script>', '{}'::jsonb) RETURNING id")).rows[0].id;
    const good = await eventsHub.publish(null, "module.unpaused", { paused: false });
    await waitFor(() => one.events.some((e) => e.id === good.id), 1800, "good event");
    assert.ok(!one.events.some((e) => e.id === Number(bad)));
    one.close();
  } finally {
    delete process.env.JOBSEARCH_SSE_MAX_TOTAL;
  }
  await waitFor(() => eventsHub.stats().subscribers === 0, 1800, "cleanup");
  await assert.rejects(() => eventsHub.publish(1, "bad kind", {}));
  await assert.rejects(() => eventsHub.publish(1, "x.y", {}, "everyone"));
});
