// Task 20 fix round 1: C1 (bootstrap-super-admin loopback-only in production + atomic) and I5 (/auth/login
// rate limits, one generic error message, dummy bcrypt compare for unknown users).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "auth-bootstrap-login-test-secret";
// one proxy hop trusted, so X-Forwarded-For can stand in for many client addresses (fix round 2 race tests)
process.env.TRUST_PROXY = "1";

const STRONG = "Orchard-Lantern-42";
const auth = require("../routes/auth");

async function withServer(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json, headers: res.headers };
  };
  auth._internal.resetLoginLimits();
  try {
    await fn({ pool, http });
  } finally {
    auth._internal.resetLoginLimits();
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

function withNodeEnv(value, fn) {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.NODE_ENV = saved;
    });
}

const BODY = { full_name: "Owner", email: "owner@test.invalid", password: STRONG };

test("C1 bootstrapAllowed(): in production only a loopback socket WITHOUT forwarding headers; any caller outside production", () => {
  const { bootstrapAllowed } = auth._internal;
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(bootstrapAllowed(req(ip), "production"), true, ip);
  for (const ip of ["172.18.0.4", "10.0.0.2", "::ffff:172.18.0.4", "203.0.113.10", "127.0.0.2x", "", undefined]) assert.equal(bootstrapAllowed(req(ip), "production"), false, String(ip));
  for (const h of [{ "x-forwarded-for": "127.0.0.1" }, { forwarded: "for=127.0.0.1" }, { "x-real-ip": "127.0.0.1" }, { "x-forwarded-host": "vita.example" }]) {
    assert.equal(bootstrapAllowed(req("127.0.0.1", h), "production"), false, JSON.stringify(h));
  }
  assert.equal(bootstrapAllowed(req("203.0.113.10", { "x-forwarded-for": "1.2.3.4" }), "development"), true);
  assert.equal(bootstrapAllowed(req("203.0.113.10"), "test"), true);
});

test("C1 HTTP: in production a proxied request (X-Forwarded-For / Forwarded) gets 404 and creates nothing; a direct loopback call works", async () => {
  await withServer(async ({ pool, http }) => {
    await withNodeEnv("production", async () => {
      for (const h of [{ "x-forwarded-for": "203.0.113.9" }, { forwarded: "for=203.0.113.9;proto=https" }, { "x-real-ip": "203.0.113.9" }]) {
        const r = await http("POST", "/auth/bootstrap-super-admin", BODY, h);
        assert.equal(r.status, 404, JSON.stringify(h));
        assert.deepEqual(r.body, { error: "Not found" });
      }
      assert.equal((await pool.query("SELECT count(*)::int n FROM users")).rows[0].n, 0);
      const ok = await http("POST", "/auth/bootstrap-super-admin", BODY);
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.role, "SuperAdmin");
    });
  });
});

test("C1 atomic: ten concurrent bootstrap calls create exactly one SuperAdmin; the rest get 403", async () => {
  await withServer(async ({ pool, http }) => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => http("POST", "/auth/bootstrap-super-admin", { ...BODY, email: `owner${i}@test.invalid` })));
    const codes = results.map((r) => r.status).sort();
    assert.equal(codes.filter((c) => c === 201).length, 1, codes.join(","));
    assert.equal(codes.filter((c) => c === 403).length, 9, codes.join(","));
    assert.equal((await pool.query("SELECT count(*)::int n FROM users")).rows[0].n, 1);
  });
});

test("I5 /auth/login: one generic 'Invalid email or password' for unknown user, wrong password and inactive user; success unchanged", async () => {
  await withServer(async ({ pool, http }) => {
    assert.equal((await http("POST", "/auth/bootstrap-super-admin", BODY)).status, 201);
    const unknown = await http("POST", "/auth/login", { email: "nobody@test.invalid", password: STRONG });
    const wrong = await http("POST", "/auth/login", { email: "owner@test.invalid", password: "Wrong-Password-123" });
    await pool.query("INSERT INTO users (full_name, email, password, role, is_active) SELECT 'Off', 'off@test.invalid', password, 'Agent', false FROM users WHERE email = 'owner@test.invalid'");
    const inactive = await http("POST", "/auth/login", { email: "off@test.invalid", password: STRONG });
    for (const r of [unknown, wrong, inactive]) {
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: "Invalid email or password" });
    }
    const ok = await http("POST", "/auth/login", { email: " Owner@Test.Invalid ", password: STRONG });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    assert.equal(ok.body.role, "SuperAdmin");
    assert.equal((await http("POST", "/auth/login", { email: "owner@test.invalid" })).status, 400, "missing fields still 400");
  });
});

test("I5 /auth/login: unknown users still pay a bcrypt compare (timing close to a wrong password)", async () => {
  await withServer(async ({ http }) => {
    assert.equal((await http("POST", "/auth/bootstrap-super-admin", BODY)).status, 201);
    await http("POST", "/auth/login", { email: "warmup@test.invalid", password: "x" }); // dummy hash computed once
    const time = async (email) => {
      const t0 = process.hrtime.bigint();
      await http("POST", "/auth/login", { email, password: "Wrong-Password-123" });
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const wrong = await time("owner@test.invalid");
    const unknown = await time("nobody2@test.invalid");
    assert.ok(unknown > wrong * 0.4, `unknown ${unknown.toFixed(1)}ms vs wrong ${wrong.toFixed(1)}ms`);
    assert.ok(unknown > 20, `unknown user answered in ${unknown.toFixed(1)}ms: no bcrypt compare?`);
  });
});

test("I5 /auth/login: 5 failures per e-mail in 15 min -> 429 with Retry-After (even with the right password); other e-mails unaffected", async () => {
  await withServer(async ({ http }) => {
    assert.equal((await http("POST", "/auth/bootstrap-super-admin", BODY)).status, 201);
    for (let i = 0; i < 5; i++) assert.equal((await http("POST", "/auth/login", { email: "owner@test.invalid", password: `Wrong-${i}-password` })).status, 400);
    const locked = await http("POST", "/auth/login", { email: "OWNER@test.invalid", password: STRONG });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) > 0);
    assert.match(locked.body.error, /Too many/);
    assert.equal((await http("POST", "/auth/login", { email: "other@test.invalid", password: "x" })).status, 400, "another e-mail is not locked");
  });
});

test("I5 /auth/login: 10 failed attempts per IP in 15 min -> 429 for every e-mail from that IP", async () => {
  await withServer(async ({ http }) => {
    for (let i = 0; i < 10; i++) assert.equal((await http("POST", "/auth/login", { email: `spray${i}@test.invalid`, password: "x" })).status, 400);
    const r = await http("POST", "/auth/login", { email: "fresh@test.invalid", password: "x" });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
  });
});

test("I5 limiter (pure): windows expire; success clears the e-mail failures; total-attempt cap per IP", () => {
  const { createLoginLimiter } = auth._internal;
  let now = 0;
  const lim = createLoginLimiter({ now: () => now, windowMs: 1000, ipFailures: 3, emailFailures: 2, ipAttempts: 5 });
  assert.equal(lim.check("1.1.1.1", "a").ok, true);
  lim.failure("1.1.1.1", "a");
  lim.failure("1.1.1.1", "a");
  assert.equal(lim.check("1.1.1.1", "a").ok, false);
  assert.equal(lim.check("2.2.2.2", "a").ok, false, "e-mail lock is independent of the IP");
  assert.equal(lim.check("1.1.1.1", "b").ok, true);
  now = 1001;
  assert.equal(lim.check("1.1.1.1", "a").ok, true, "window expired");
  lim.failure("9.9.9.9", "c");
  lim.success("9.9.9.9", "c");
  lim.failure("9.9.9.9", "c");
  assert.equal(lim.check("9.9.9.9", "c").ok, true, "success cleared earlier e-mail failures");
  const cap = createLoginLimiter({ now: () => now, windowMs: 1000, ipFailures: 100, emailFailures: 100, ipAttempts: 3 });
  for (let i = 0; i < 3; i++) {
    assert.equal(cap.check("3.3.3.3", `u${i}`).ok, true);
    cap.attempt("3.3.3.3");
  }
  const r = cap.check("3.3.3.3", "u9");
  assert.equal(r.ok, false);
  assert.ok(r.retryAfter >= 1);
});

// ---------------------------------------------------------------- fix round 2: simultaneous requests

const statuses = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});

test("I5 race: 20 SIMULTANEOUS wrong passwords for one e-mail -> at most 5 answer 400, the rest 429", async () => {
  await withServer(async ({ http }) => {
    assert.equal((await http("POST", "/auth/bootstrap-super-admin", BODY)).status, 201);
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => http("POST", "/auth/login", { email: "owner@test.invalid", password: `Wrong-${i}-password` })));
    const c = statuses(rs);
    assert.ok((c[400] || 0) <= 5, JSON.stringify(c));
    assert.equal((c[400] || 0) + (c[429] || 0), 20, JSON.stringify(c));
    assert.equal((await http("POST", "/auth/login", { email: "owner@test.invalid", password: STRONG })).status, 429, "locked even with the right password");
  });
});

test("I5 race: simultaneous attempts from 20 different addresses still respect the per-e-mail limit; unknown e-mails behave the same", async () => {
  await withServer(async ({ http }) => {
    assert.equal((await http("POST", "/auth/bootstrap-super-admin", BODY)).status, 201);
    for (const email of ["owner@test.invalid", "nobody-race@test.invalid"]) {
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => http("POST", "/auth/login", { email, password: `Wrong-${i}-password` }, { "x-forwarded-for": `198.51.100.${i + 1}` })));
      const c = statuses(rs);
      assert.ok((c[400] || 0) <= 5, `${email} ${JSON.stringify(c)}`);
      assert.equal((c[429] || 0), 20 - (c[400] || 0), `${email} ${JSON.stringify(c)}`);
    }
  });
});

test("I5 race: a correct login after fewer than 5 failures works and clears the e-mail failures (and gives back its provisional IP failure)", async () => {
  await withServer(async ({ http }) => {
    assert.equal((await http("POST", "/auth/bootstrap-super-admin", BODY)).status, 201);
    const ip = { "x-forwarded-for": "203.0.113.77" };
    for (let i = 0; i < 4; i++) assert.equal((await http("POST", "/auth/login", { email: "owner@test.invalid", password: `Wrong-${i}-password` }, ip)).status, 400);
    const ok = await http("POST", "/auth/login", { email: "owner@test.invalid", password: STRONG }, ip);
    assert.equal(ok.status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await http("POST", "/auth/login", { email: "owner@test.invalid", password: `Again-${i}-password` }, ip)).status, 400, "the e-mail bucket was cleared");
    // IP: 8 failures recorded; the successful attempt's provisional failure was removed -> 2 more failures allowed
    assert.equal((await http("POST", "/auth/login", { email: "x1@test.invalid", password: "x" }, ip)).status, 400);
    assert.equal((await http("POST", "/auth/login", { email: "x2@test.invalid", password: "x" }, ip)).status, 400);
    assert.equal((await http("POST", "/auth/login", { email: "x3@test.invalid", password: "x" }, ip)).status, 429, "10 IP failures reached");
  });
});

test("I5 limiter (pure): reserve() is synchronous and counts in-flight attempts; release(success) removes exactly its own provisional IP failure", () => {
  const { createLoginLimiter } = auth._internal;
  let now = 0;
  const lim = createLoginLimiter({ now: () => now, windowMs: 1000, ipFailures: 3, emailFailures: 2, ipAttempts: 50 });
  const a = lim.reserve("1.1.1.1", "a");
  const b = lim.reserve("1.1.1.1", "a");
  assert.equal(a.ok && b.ok, true);
  assert.equal(lim.reserve("1.1.1.1", "a").ok, false, "two in flight already count as failures for 'a'");
  lim.release(a, true);
  assert.equal(lim.reserve("2.2.2.2", "a").ok, true, "success cleared the e-mail bucket");
  // IP bucket: b (failure kept) + the 2.2.2.2 one is another IP -> 1.1.1.1 has 1 failure left after a's removal
  const c = lim.reserve("1.1.1.1", "z");
  const d = lim.reserve("1.1.1.1", "y");
  assert.equal(c.ok && d.ok, true);
  assert.equal(lim.reserve("1.1.1.1", "w").ok, false, "b + c + d = 3 IP failures");
});

test("I5 limiter (pure): eviction drops expired entries first, then per-IP attempt buckets, never a victim's e-mail lockout first", () => {
  const { createLoginLimiter } = auth._internal;
  let now = 0;
  const lim = createLoginLimiter({ now: () => now, windowMs: 1000, ipFailures: 1000, emailFailures: 2, ipAttempts: 1000, maxKeys: 50 });
  lim.release(lim.reserve("9.9.9.9", "victim@x"), false);
  lim.release(lim.reserve("9.9.9.9", "victim@x"), false);
  assert.equal(lim.reserve("8.8.8.8", "victim@x").ok, false, "victim locked");
  // flood: many new addresses, each with its own attempt + failure buckets and a different e-mail
  for (let i = 0; i < 500; i++) lim.release(lim.reserve(`10.0.${Math.floor(i / 250)}.${i % 250}`, `flood${i}@x`), false);
  assert.ok(lim.size() <= 50 + 3, `size ${lim.size()}`);
  assert.equal(lim.reserve("7.7.7.7", "victim@x").ok, false, "the victim's e-mail lockout survived the flood");
  now = 1001;
  assert.equal(lim.reserve("7.7.7.7", "victim@x").ok, true, "expired normally");
});
