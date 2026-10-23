const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const path = require("path");
const jwt = require("jsonwebtoken");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-sources-test-secret";
delete process.env.JOBBANK_CA_FEED_URL;
delete process.env.PARTNER_FEED_URLS;

const { createTestDb, loadApp } = require("./helpers/db");
const { withDb, fakeClock, fakeFetch, json, PUBLIC_LOOKUP } = require("./helpers/jsSources");
const registry = require("../modules/jobsearch/sources");
const fixture = require("../modules/jobsearch/sources/testFixture");
const { fetchFeedText, assertSafeFeedUrl } = require("../modules/jobsearch/sources/http");
const { SourceNotConnected, RateLimited, FeedRejected } = require("../modules/jobsearch/sources/errors");
const { runSearch } = require("../modules/jobsearch/searchRunner");

const J = (id, over = {}) => ({ sourceJobId: id, url: `https://jobs.example.com/${id}`, title: `Electrician ${id}`, employerName: "Acme", location: "Doha", country: "Qatar", publishedAt: "2026-10-05T00:00:00Z", closingAt: null, description: "Wire things", ...over });
const counts = async (pool) => ({
  jobs: (await pool.query("SELECT count(*)::int n FROM js_jobs")).rows[0].n,
  sightings: (await pool.query("SELECT count(*)::int n FROM js_job_sightings")).rows[0].n,
});
const lastRun = async (pool, key) => (await pool.query("SELECT r.* FROM js_runs r JOIN js_sources s ON s.id=r.source_id WHERE s.key=$1 ORDER BY r.id DESC LIMIT 1", [key])).rows[0];
function withEnv(vars, fn) {
  return async (...a) => {
    const old = {};
    for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
    try { return await fn(...a); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
  };
}

// ---------- adapters ----------
test("unconfigured jobbank_ca / partner_feed report requires_setup; search throws SourceNotConnected", async () => {
  for (const key of ["jobbank_ca", "partner_feed"]) {
    const a = registry.getAdapter(key);
    assert.equal(a.status().status, "requires_setup");
    await assert.rejects(() => a.search({ keywords: [] }, {}), SourceNotConnected);
    assert.ok(Array.isArray(a.describe().requires) && a.describe().requires.length === 1);
  }
  assert.equal(registry.getAdapter("manual_import").status().status, "manual");
});

test("runSearch on unconfigured sources inserts nothing and records requires_setup", async () => {
  await withDb(async (pool) => {
    const fetch = fakeFetch(() => { throw new Error("must not fetch"); });
    for (const key of ["jobbank_ca", "partner_feed"]) {
      const s = await runSearch({ sourceKey: key }, { fetch, lookup: PUBLIC_LOOKUP });
      assert.equal(s.status, "requires_setup");
      assert.equal(s.found, 0);
      const run = await lastRun(pool, key);
      assert.equal(run.errors[0].status, "requires_setup");
      assert.equal((await pool.query("SELECT status FROM js_sources WHERE key=$1", [key])).rows[0].status, "requires_setup");
    }
    assert.equal(fetch.calls.length, 0);
    assert.deepEqual(await counts(pool), { jobs: 0, sightings: 0 });
  });
});

test("sources are seeded idempotently and test_fixture exists only under NODE_ENV=test", async () => {
  await withDb(async (pool) => {
    const { ensureSources } = require("../modules/jobsearch/searchRunner");
    await ensureSources();
    await ensureSources();
    const rows = (await pool.query("SELECT key FROM js_sources ORDER BY key")).rows.map((r) => r.key);
    assert.deepEqual(rows, ["jobbank_ca", "manual_import", "partner_feed", "test_fixture"]);
  });
  const probe = (env) => spawnSync(process.execPath, ["-e", "const r=require('./modules/jobsearch/sources');console.log(JSON.stringify(r.keys()))"], { cwd: path.join(__dirname, ".."), env: { ...process.env, NODE_ENV: env }, encoding: "utf8" });
  const prod = probe("production");
  assert.equal(prod.status, 0, prod.stderr);
  assert.ok(!JSON.parse(prod.stdout).includes("test_fixture"));
  const dev = probe("development");
  assert.ok(!JSON.parse(dev.stdout).includes("test_fixture"));
  assert.ok(JSON.parse(probe("test").stdout).includes("test_fixture"));
});

// ---------- safe fetching ----------
test("feed URLs: http, loopback, private, link-local, credentials rejected", () => {
  for (const u of ["http://feeds.example.com/x", "https://127.0.0.1/x", "https://10.1.2.3/x", "https://169.254.169.254/latest", "https://192.168.0.5/x", "https://172.16.0.1/x", "https://[::1]/x", "https://[fd00::1]/x", "https://[::ffff:127.0.0.1]/x", "https://localhost/x", "https://user:pw@feeds.example.com/x", "https://2130706433/x", "ftp://x.example.com/", "nonsense"]) {
    assert.throws(() => assertSafeFeedUrl(u), FeedRejected, u);
  }
  assert.doesNotThrow(() => assertSafeFeedUrl("https://feeds.example.com/jobs.json"));
});

test("configured feed with an unsafe URL stays requires_setup and is never fetched", async () => {
  await withEnv({ JOBBANK_CA_FEED_URL: "http://feeds.example.com/x", PARTNER_FEED_URLS: "https://10.0.0.5/feed,https://ok.example.com/f" }, async () => {
    assert.equal(registry.getAdapter("jobbank_ca").status().status, "requires_setup");
    assert.equal(registry.getAdapter("partner_feed").status().status, "requires_setup");
    const fetch = fakeFetch(() => json([]));
    await assert.rejects(() => registry.getAdapter("jobbank_ca").search({}, { fetch, lookup: PUBLIC_LOOKUP }), SourceNotConnected);
    assert.equal(fetch.calls.length, 0);
  })();
});

test("hostname resolving to a private address is refused; redirects must stay https and public", async () => {
  const priv = async () => [{ address: "10.0.0.7", family: 4 }];
  await assert.rejects(() => fetchFeedText("https://evil.example.com/f", { fetch: fakeFetch(() => json([])), lookup: priv }), FeedRejected);
  const toHttp = fakeFetch(() => new Response(null, { status: 302, headers: { location: "http://feeds.example.com/x" } }));
  await assert.rejects(() => fetchFeedText("https://feeds.example.com/f", { fetch: toHttp, lookup: PUBLIC_LOOKUP }), FeedRejected);
  const toLoop = fakeFetch(() => new Response(null, { status: 301, headers: { location: "https://127.0.0.1/admin" } }));
  await assert.rejects(() => fetchFeedText("https://feeds.example.com/f", { fetch: toLoop, lookup: PUBLIC_LOOKUP }), FeedRejected);
  assert.equal(toLoop.calls.length, 1, "redirect target never requested");
  const ok = fakeFetch((url, _i, n) => (n === 1 ? new Response(null, { status: 302, headers: { location: "/final" } }) : json([{ id: 1 }])));
  assert.equal(await fetchFeedText("https://feeds.example.com/f", { fetch: ok, lookup: PUBLIC_LOOKUP }), '[{"id":1}]');
  assert.equal(ok.calls[1].url, "https://feeds.example.com/final");
});

test("oversize responses are rejected (declared and streamed); identifying User-Agent and timeout signal sent", async () => {
  const declared = fakeFetch(() => new Response("x", { status: 200, headers: { "content-length": "999999" } }));
  await assert.rejects(() => fetchFeedText("https://feeds.example.com/f", { fetch: declared, lookup: PUBLIC_LOOKUP, maxBytes: 1000 }), /too large/);
  const streamed = fakeFetch(() => new Response("y".repeat(5000), { status: 200 }));
  await assert.rejects(() => fetchFeedText("https://feeds.example.com/f", { fetch: streamed, lookup: PUBLIC_LOOKUP, maxBytes: 1000 }), /too large/);
  const ok = fakeFetch(() => json([]));
  await fetchFeedText("https://feeds.example.com/f", { fetch: ok, lookup: PUBLIC_LOOKUP });
  assert.match(ok.calls[0].init.headers["user-agent"], /VITA-JobSearch/);
  assert.ok(ok.calls[0].init.signal, "timeout signal");
  assert.equal(ok.calls[0].init.redirect, "manual");
});

test("HTTP 429 surfaces Retry-After; 401/403 are not bypassed", async () => {
  const f429 = fakeFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
  await assert.rejects(() => fetchFeedText("https://feeds.example.com/f", { fetch: f429, lookup: PUBLIC_LOOKUP }), (e) => e instanceof RateLimited && e.retryAfterMs === 30000);
  const f401 = fakeFetch(() => new Response("no", { status: 401 }));
  await assert.rejects(() => fetchFeedText("https://feeds.example.com/f", { fetch: f401, lookup: PUBLIC_LOOKUP }), (e) => e.status === 401 && e.retriable === false);
});

test("partner_feed configured: parses JSON and RSS from approved URLs and stores real fetched jobs", async () => {
  await withEnv({ PARTNER_FEED_URLS: "https://feeds.example.com/a.json, https://feeds.example.com/b.rss" }, async () => {
    await withDb(async (pool) => {
      const rss = `<rss><channel><item><title><![CDATA[Welder]]></title><link>https://feeds.example.com/w/1</link><guid>w1</guid><pubDate>Mon, 05 Oct 2026 00:00:00 GMT</pubDate><description>Weld</description></item></channel></rss>`;
      const fetch = fakeFetch((url) => (url.endsWith(".json") ? json({ jobs: [{ id: "a1", title: "Plumber", employer: "PipeCo", location: "Doha", country: "Qatar", url: "https://feeds.example.com/p/1" }] }) : new Response(rss, { status: 200 })));
      const clock = fakeClock();
      assert.equal(registry.getAdapter("partner_feed").status().status, "connected");
      const s = await runSearch({ sourceKey: "partner_feed" }, { fetch, lookup: PUBLIC_LOOKUP, now: clock.now, sleep: clock.sleep });
      assert.equal(s.status, "ok");
      assert.equal(s.created, 2);
      assert.deepEqual((await pool.query("SELECT title FROM js_jobs ORDER BY title")).rows.map((r) => r.title), ["Plumber", "Welder"]);
      assert.equal((await pool.query("SELECT source_primary FROM js_jobs LIMIT 1")).rows[0].source_primary, "partner_feed");
      // repeated run: no new rows
      clock.advance(120000);
      const again = await runSearch({ sourceKey: "partner_feed" }, { fetch, lookup: PUBLIC_LOOKUP, now: clock.now, sleep: clock.sleep });
      assert.equal(again.created, 0);
      assert.deepEqual(await counts(pool), { jobs: 2, sightings: 2 });
    });
  })();
});

// ---------- runner ----------
test("repeated runs create no new rows; the same vacancy across two sources stays one job", async () => {
  await withDb(async (pool) => {
    fixture._reset();
    fixture._set({ jobs: [J("1"), J("2")] });
    const clock = fakeClock();
    const deps = { now: clock.now, sleep: clock.sleep };
    const a = await runSearch({ sourceKey: "test_fixture" }, deps);
    assert.deepEqual([a.status, a.found, a.created], ["ok", 2, 2]);
    clock.advance(61000);
    const b = await runSearch({ sourceKey: "test_fixture" }, deps);
    assert.deepEqual([b.found, b.created], [2, 0]);
    assert.deepEqual(await counts(pool), { jobs: 2, sightings: 2 });
    fixture._reset();
  });
});

test("paused source is skipped; module pause does nothing", async () => {
  await withDb(async (pool) => {
    fixture._reset();
    fixture._set({ jobs: [J("1")] });
    const clock = fakeClock();
    const deps = { now: clock.now, sleep: clock.sleep };
    await runSearch({ sourceKey: "test_fixture" }, deps); // seeds sources
    clock.advance(61000);
    await pool.query("UPDATE js_sources SET paused = true WHERE key='test_fixture'");
    fixture._state.calls = 0;
    const s = await runSearch({ sourceKey: "test_fixture" }, deps);
    assert.equal(s.status, "paused");
    assert.equal(fixture._state.calls, 0);
    await pool.query("UPDATE js_sources SET paused = false WHERE key='test_fixture'");
    await pool.query("INSERT INTO js_module_state (key, value) VALUES ('module_paused', '{\"paused\":true}')");
    const runsBefore = (await pool.query("SELECT count(*)::int n FROM js_runs")).rows[0].n;
    const m = await runSearch({}, deps);
    assert.equal(m.status, "module_paused");
    assert.equal(fixture._state.calls, 0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM js_runs")).rows[0].n, runsBefore);
    fixture._reset();
  });
});

test("per-source rate limit is enforced and recovers after a minute", async () => {
  await withDb(async (pool) => {
    fixture._reset();
    fixture._set({ jobs: [J("1")] });
    const clock = fakeClock();
    const deps = { now: clock.now, sleep: clock.sleep };
    await runSearch({ sourceKey: "test_fixture" }, deps);
    await pool.query("UPDATE js_sources SET rate_limit_per_min = 2 WHERE key='test_fixture'");
    await runSearch({ sourceKey: "test_fixture" }, deps);
    fixture._state.calls = 0;
    const limited = await runSearch({ sourceKey: "test_fixture" }, deps);
    assert.equal(limited.status, "rate_limited");
    assert.equal(fixture._state.calls, 0);
    clock.advance(61000);
    assert.equal((await runSearch({ sourceKey: "test_fixture" }, deps)).status, "ok");
    fixture._reset();
  });
});

test("failing adapter is retried 3 times with exponential backoff, then marked failed with the error recorded", async () => {
  await withDb(async (pool) => {
    fixture._reset();
    fixture._set({ failWith: "upstream exploded" });
    const clock = fakeClock();
    const s = await runSearch({ sourceKey: "test_fixture" }, { now: clock.now, sleep: clock.sleep });
    assert.equal(fixture._state.calls, 3);
    assert.deepEqual(clock.sleeps, [1000, 2000]);
    assert.equal(s.status, "failed");
    const run = await lastRun(pool, "test_fixture");
    assert.equal(run.errors[0].status, "failed");
    assert.equal(run.errors[0].attempts, 3);
    assert.match(run.errors[0].message, /upstream exploded/);
    const src = (await pool.query("SELECT status, last_error FROM js_sources WHERE key='test_fixture'")).rows[0];
    assert.equal(src.status, "unavailable");
    assert.match(src.last_error, /upstream exploded/);
    assert.equal((await counts(pool)).jobs, 0);
    // recovery: next success clears the error and restores status
    fixture._set({ failWith: null, jobs: [J("1")] });
    clock.advance(61000);
    await runSearch({ sourceKey: "test_fixture" }, { now: clock.now, sleep: clock.sleep });
    const ok = (await pool.query("SELECT status, last_error FROM js_sources WHERE key='test_fixture'")).rows[0];
    assert.deepEqual(ok, { status: "connected", last_error: null });
    fixture._reset();
  });
});

test("a 429 backoff honours Retry-After; auth/safety refusals are not retried", async () => {
  await withDb(async () => {
    fixture._reset();
    fixture._set({ failWith: "429" });
    const clock = fakeClock();
    await runSearch({ sourceKey: "test_fixture" }, { now: clock.now, sleep: clock.sleep });
    assert.deepEqual(clock.sleeps, [2000, 2000]);
    fixture._reset();
  });
  await withEnv({ PARTNER_FEED_URLS: "https://feeds.example.com/a.json" }, async () => {
    await withDb(async () => {
      const f = fakeFetch(() => new Response("no", { status: 403 }));
      const clock = fakeClock();
      const s = await runSearch({ sourceKey: "partner_feed" }, { fetch: f, lookup: PUBLIC_LOOKUP, now: clock.now, sleep: clock.sleep });
      assert.equal(s.status, "failed");
      assert.equal(f.calls.length, 1);
    });
  })();
});

// ---------- candidate search + routes ----------
async function withApp(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { body, token } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let b = null;
    try { b = await r.json(); } catch { b = null; }
    return { status: r.status, body: b };
  };
  const mkUser = async (email, role) => (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [email, email, role])).rows[0].id;
  const tok = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });
  try {
    const admin = await mkUser("adm@x.io", "Admin");
    const agentA = await mkUser("a@x.io", "Agent");
    const agentB = await mkUser("b@x.io", "Agent");
    const accountant = await mkUser("acc@x.io", "Accountant");
    let n = 0;
    const eligibleCandidate = async (assignedTo, { eligible = true } = {}) => {
      n += 1;
      const cid = (await pool.query("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`C${n}`, `PP${n}`, assignedTo])).rows[0].id;
      if (eligible) {
        await pool.query("INSERT INTO js_profiles (candidate_id, status, confirmed) VALUES ($1,'confirmed',$2::jsonb)", [cid, JSON.stringify({ profession: "Electrician", skills: ["wiring"], languages: [{ lang: "en" }], phone: "+216555", email: "secret@x.io" })]);
        await pool.query("INSERT INTO js_preferences (candidate_id, countries, categories) VALUES ($1,'{Qatar}','{Cabling}')", [cid]);
        await pool.query("INSERT INTO js_consents (candidate_id, scope, version) VALUES ($1,$2::jsonb,'v1')", [cid, JSON.stringify({ search: true, prepare: false, submit: false, countries: [] })]);
      }
      return cid;
    };
    const candToken = async (cid) => {
      const r = await call("POST", "/jobsearch/admin/candidate-accounts", { token: tok(admin, "Admin"), body: { candidate_id: cid, email: `cand${cid}@x.io` } });
      const tv = (await pool.query("SELECT token_version FROM users WHERE id=$1", [r.body.user_id])).rows[0].token_version;
      return jwt.sign({ id: r.body.user_id, role: "Candidate", tv }, process.env.JWT_SECRET, { expiresIn: "1h" });
    };
    await fn({ pool, call, tok, admin, agentA, agentB, accountant, eligibleCandidate, candToken });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

test("candidate search uses the confirmed profile + preferences only, and only when eligible", async () => {
  await withApp(async (t) => {
    fixture._reset();
    fixture._set({ jobs: [J("1")] });
    const ok = await t.eligibleCandidate(t.agentA);
    const bad = await t.eligibleCandidate(t.agentA, { eligible: false });
    await assert.rejects(() => runSearch({ candidateId: bad, sourceKey: "test_fixture" }), (e) => e.status === 403 && /no_search_consent/.test(e.message));
    assert.equal(fixture._state.calls, 0, "no search for an ineligible candidate");
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_runs")).rows[0].n, 0);
    const clock = fakeClock();
    const s = await runSearch({ candidateId: ok, sourceKey: "test_fixture", manual: true }, { now: clock.now, sleep: clock.sleep });
    assert.equal(s.status, "ok");
    const q = fixture._state.searchCalls[0];
    assert.deepEqual(q.keywords, ["Electrician", "Cabling"]);
    assert.equal(q.country, "Qatar");
    assert.ok(!JSON.stringify(q).includes("secret@x.io") && !JSON.stringify(q).includes("216555"), "no personal data in the query");
    // withdrawn consent -> refused again
    await t.pool.query("UPDATE js_consents SET withdrawn_at = now() WHERE candidate_id=$1", [ok]);
    await assert.rejects(() => runSearch({ candidateId: ok, sourceKey: "test_fixture" }), (e) => e.status === 403);
    fixture._reset();
  });
});

test("POST /search/run: scope, permissions and eligibility", async () => {
  await withApp(async (t) => {
    fixture._reset();
    fixture._set({ jobs: [J("1")] });
    const cid = await t.eligibleCandidate(t.agentA);
    const unelig = await t.eligibleCandidate(t.agentA, { eligible: false });
    const A = t.tok(t.agentA, "Agent");
    const B = t.tok(t.agentB, "Agent");
    const ADM = t.tok(t.admin, "Admin");
    const run = (token, body) => t.call("POST", "/jobsearch/search/run", { token, body });
    assert.equal((await t.call("POST", "/jobsearch/search/run", { body: {} })).status, 401);
    assert.equal((await run(B, { candidateId: cid, sourceKey: "test_fixture" })).status, 404, "staff B cannot search for staff A's candidate");
    assert.equal(fixture._state.calls, 0);
    assert.equal((await run(t.tok(t.accountant, "Accountant"), { candidateId: cid })).status, 403);
    assert.equal((await run(await t.candToken(cid), { candidateId: cid })).status, 403, "candidate cannot trigger Search now");
    assert.equal((await run(A, {})).status, 403, "staff must name a candidate");
    assert.equal((await run(A, { candidateId: unelig, sourceKey: "test_fixture" })).status, 403);
    assert.equal((await run(A, { candidateId: 99999, sourceKey: "test_fixture" })).status, 404);
    assert.equal((await run(A, { candidateId: cid, sourceKey: "nope" })).status, 404);
    const ok = await run(A, { candidateId: cid, sourceKey: "test_fixture" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, "ok");
    assert.equal(ok.body.created, 1);
    assert.equal((await run(ADM, { candidateId: cid, sourceKey: "jobbank_ca" })).body.status, "requires_setup");
    assert.equal((await run(ADM, {})).status, 200, "admin may refresh all sources");
    fixture._reset();
  });
});

test("GET /sources reports status, describe() and last run; pause/resume need admin", async () => {
  await withApp(async (t) => {
    const A = t.tok(t.agentA, "Agent");
    const ADM = t.tok(t.admin, "Admin");
    const list = await t.call("GET", "/jobsearch/sources", { token: A });
    assert.equal(list.status, 200);
    const by = Object.fromEntries(list.body.map((s) => [s.key, s]));
    assert.equal(by.jobbank_ca.status, "requires_setup");
    assert.equal(by.partner_feed.status, "requires_setup");
    assert.equal(by.manual_import.status, "manual");
    assert.equal(by.test_fixture.status, "connected");
    assert.deepEqual(by.jobbank_ca.requires, ["JOBBANK_CA_FEED_URL"]);
    assert.equal(by.jobbank_ca.last_run, null);
    assert.equal((await t.call("GET", "/jobsearch/sources", { token: await t.candToken(await t.eligibleCandidate(t.agentA)) })).status, 403);
    assert.equal((await t.call("POST", "/jobsearch/sources/jobbank_ca/pause", { token: A })).status, 403);
    const p = await t.call("POST", "/jobsearch/sources/jobbank_ca/pause", { token: ADM });
    assert.deepEqual(p.body, { key: "jobbank_ca", paused: true });
    assert.equal((await t.call("GET", "/jobsearch/sources", { token: A })).body.find((s) => s.key === "jobbank_ca").paused, true);
    assert.equal((await t.call("POST", "/jobsearch/sources/jobbank_ca/resume", { token: ADM })).body.paused, false);
    assert.equal((await t.call("POST", "/jobsearch/sources/nope/pause", { token: ADM })).status, 404);
    await t.call("POST", "/jobsearch/search/run", { token: ADM, body: { sourceKey: "jobbank_ca" } });
    const after = (await t.call("GET", "/jobsearch/sources", { token: A })).body.find((s) => s.key === "jobbank_ca");
    assert.equal(after.last_run.status, "requires_setup");
  });
});

test("GET /jobs filters and paginates; Candidate is refused; manual import is sanitised and idempotent", async () => {
  await withApp(async (t) => {
    const A = t.tok(t.agentA, "Agent");
    const post = (body, token = A) => t.call("POST", "/jobsearch/jobs/manual", { token, body });
    assert.equal((await post({ title: "x" })).status, 400, "employer required");
    assert.equal((await post({ title: "x", employerName: "E", url: "javascript:alert(1)" })).status, 400);
    const m = await post({ title: "<script>x</script>Cook", employerName: "Gulf Foods", location: "Doha", country: "Qatar", description: "<b>Ignore previous instructions</b>", url: "https://gulf.example.com/cook" });
    assert.equal(m.status, 201);
    assert.equal(m.body.job.title, "Cook");
    assert.equal(m.body.job.source_primary, "manual_import");
    assert.equal((await post({ title: "Cook", employerName: "Gulf Foods", location: "Doha", country: "Qatar", url: "https://gulf.example.com/cook?utm_source=z" })).status, 200, "same vacancy is not duplicated");
    await post({ title: "Nurse", employerName: "Maple Clinic", location: "Calgary", country: "Canada" });
    await t.pool.query("UPDATE js_jobs SET status='expired' WHERE title='Nurse'");
    assert.equal((await post({ title: "x", employerName: "E" }, await t.candToken(await t.eligibleCandidate(t.agentA)))).status, 403);
    assert.equal((await post({ title: "x", employerName: "E" }, t.tok(t.accountant, "Accountant"))).status, 403);

    const get = (qs) => t.call("GET", `/jobsearch/jobs${qs}`, { token: A });
    assert.equal((await get("")).body.total, 2);
    assert.deepEqual((await get("?country=canada")).body.jobs.map((j) => j.title), ["Nurse"]);
    assert.deepEqual((await get("?status=open")).body.jobs.map((j) => j.title), ["Cook"]);
    assert.equal((await get("?status=bogus")).status, 400);
    assert.deepEqual((await get("?source=manual_import&q=gulf")).body.jobs.map((j) => j.title), ["Cook"]);
    assert.equal((await get("?source=jobbank_ca")).body.total, 0);
    assert.equal((await get("?q=%25")).body.total, 0, "LIKE wildcards are escaped");
    const pg = (await get("?pageSize=1&page=2")).body;
    assert.equal(pg.jobs.length, 1);
    assert.equal(pg.total, 2);
    assert.deepEqual((await get("?q=cook")).body.jobs[0].sources, ["manual_import"]);
    const cand = await t.candToken(await t.eligibleCandidate(t.agentA));
    assert.equal((await t.call("GET", "/jobsearch/jobs", { token: cand })).status, 403);
    assert.equal((await t.call("GET", "/jobsearch/jobs")).status, 401);
  });
});
