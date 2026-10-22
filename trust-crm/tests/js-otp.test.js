const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-otp-test-secret";
delete process.env.MAIL_PROVIDER;
delete process.env.MAIL_SANDBOX_ALLOWLIST;

const otp = () => require("../modules/jobsearch/otp");
const mail = () => require("../modules/jobsearch/mail");

const GENERIC = { ok: true, message: "If an account exists for this email, a sign-in code has been sent." };

async function withApp(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  otp()._testing.reset();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, token } = {}) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, body: json, text };
  };
  try {
    const admin = (
      await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('Adm','adm@x.io','x','Admin') RETURNING id")
    ).rows[0].id;
    const agent = (
      await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('Ag','agent@test.invalid','x','Agent') RETURNING id")
    ).rows[0].id;
    // Legacy-style staff tokens (no `tv` claim), exactly as /auth/login issues them.
    const adminToken = jwt.sign({ id: admin, role: "Admin" }, process.env.JWT_SECRET, { expiresIn: "7d" });
    const agentToken = jwt.sign({ id: agent, role: "Agent" }, process.env.JWT_SECRET, { expiresIn: "7d" });
    let n = 0;
    const newCandidate = async (email) => {
      n += 1;
      const cid = (
        await pool.query("INSERT INTO candidates (full_name, passport_number) VALUES ($1,$2) RETURNING id", [`Cand ${n}`, `PP${n}`])
      ).rows[0].id;
      const r = await call("POST", "/jobsearch/admin/candidate-accounts", {
        token: adminToken,
        body: { candidate_id: cid, email },
      });
      assert.equal(r.status, 201, r.text);
      return { candidateId: cid, userId: r.body.user_id, email: email.trim().toLowerCase() };
    };
    await fn({ pool, call, adminToken, agentToken, admin, newCandidate });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
  }
}

async function latestCode(email) {
  const rows = await mail().sandbox.listOutbound({ to: email });
  assert.ok(rows.length > 0, "expected an OTP mail");
  const m = /\b(\d{6})\b/.exec(rows[rows.length - 1].body);
  assert.ok(m, "mail body should contain a 6-digit code");
  return m[1];
}

function wrongCode(code) {
  return String((Number(code) + 1) % 1000000).padStart(6, "0");
}

test("admin creates a Candidate account linked to an existing candidate", () =>
  withApp(async ({ pool, call, adminToken, agentToken, admin }) => {
    const cid = (await pool.query("INSERT INTO candidates (full_name, passport_number) VALUES ('Z','PZ') RETURNING id")).rows[0].id;
    const cid2 = (await pool.query("INSERT INTO candidates (full_name, passport_number, email) VALUES ('Y','PY','keep@test.invalid') RETURNING id")).rows[0].id;

    const noAuth = await call("POST", "/jobsearch/admin/candidate-accounts", { body: { candidate_id: cid, email: "z@test.invalid" } });
    assert.equal(noAuth.status, 401);
    const forbidden = await call("POST", "/jobsearch/admin/candidate-accounts", {
      token: agentToken,
      body: { candidate_id: cid, email: "z@test.invalid" },
    });
    assert.equal(forbidden.status, 403);

    const bad = await call("POST", "/jobsearch/admin/candidate-accounts", { token: adminToken, body: { candidate_id: cid, email: "nope" } });
    assert.equal(bad.status, 400);
    const missing = await call("POST", "/jobsearch/admin/candidate-accounts", {
      token: adminToken,
      body: { candidate_id: 999999, email: "z@test.invalid" },
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(Object.keys(missing.body), ["error"]);

    const ok = await call("POST", "/jobsearch/admin/candidate-accounts", {
      token: adminToken,
      body: { candidate_id: cid, email: "  Z.Person@Test.Invalid " },
    });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.email, "z.person@test.invalid");
    assert.equal(ok.body.candidate_id, cid);
    assert.equal(ok.body.password, undefined);

    const user = (await pool.query("SELECT * FROM users WHERE id=$1", [ok.body.user_id])).rows[0];
    assert.equal(user.role, "Candidate");
    assert.equal(user.email, "z.person@test.invalid");
    assert.equal(user.is_active, true);
    assert.match(user.password, /^\$2[aby]\$/);
    const link = (await pool.query("SELECT * FROM js_candidate_accounts WHERE user_id=$1", [user.id])).rows[0];
    assert.equal(link.candidate_id, cid);
    assert.equal((await pool.query("SELECT email FROM candidates WHERE id=$1", [cid])).rows[0].email, "z.person@test.invalid");

    const audit = (await pool.query("SELECT * FROM audit_logs WHERE table_name='js_candidate_accounts'")).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].user_id, admin);

    // duplicate link for the same candidate
    const dupCand = await call("POST", "/jobsearch/admin/candidate-accounts", {
      token: adminToken,
      body: { candidate_id: cid, email: "other@test.invalid" },
    });
    assert.equal(dupCand.status, 409);
    // duplicate email (case-insensitive) for a different candidate
    const dupEmail = await call("POST", "/jobsearch/admin/candidate-accounts", {
      token: adminToken,
      body: { candidate_id: cid2, email: "Z.PERSON@test.invalid" },
    });
    assert.equal(dupEmail.status, 409);
    // existing candidate email is not overwritten
    const ok2 = await call("POST", "/jobsearch/admin/candidate-accounts", {
      token: adminToken,
      body: { candidate_id: cid2, email: "login2@test.invalid" },
    });
    assert.equal(ok2.status, 201);
    assert.equal((await pool.query("SELECT email FROM candidates WHERE id=$1", [cid2])).rows[0].email, "keep@test.invalid");
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE role='Candidate'")).rows[0].n, 2);
  }));

test("happy path: request + verify returns a short-lived Candidate token with tv", () =>
  withApp(async ({ pool, call, newCandidate }) => {
    const c = await newCandidate("happy@test.invalid");
    const r = await call("POST", "/jobsearch/auth/otp/request", { body: { email: "Happy@Test.Invalid" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, GENERIC);
    const code = await latestCode(c.email);
    assert.match(code, /^\d{6}$/);

    const row = (await pool.query("SELECT * FROM js_otps WHERE email=$1", [c.email])).rows[0];
    assert.notEqual(row.code_hash, code);
    assert.ok(!row.code_hash.includes(code));
    const ttl = (new Date(row.expires_at) - new Date(row.created_at)) / 1000;
    assert.ok(ttl > 590 && ttl <= 600, `ttl ${ttl}`);

    const v = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code } });
    assert.equal(v.status, 200, v.text);
    assert.deepEqual(Object.keys(v.body), ["token"]);
    const claims = jwt.verify(v.body.token, process.env.JWT_SECRET);
    assert.equal(claims.id, c.userId);
    assert.equal(claims.role, "Candidate");
    assert.equal(claims.tv, 0);
    assert.ok(claims.exp - claims.iat <= 12 * 3600);

    const me = await call("GET", "/jobsearch/auth/me", { token: v.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.id, c.userId);
    assert.equal(me.body.role, "Candidate");
    assert.equal(me.body.candidate_id, c.candidateId);
  }));

test("wrong code is rejected and counted; correct code still works within the limit", () =>
  withApp(async ({ pool, call, newCandidate }) => {
    const c = await newCandidate("wrong@test.invalid");
    await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } });
    const code = await latestCode(c.email);
    const w = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code: wrongCode(code) } });
    assert.equal(w.status, 401);
    assert.equal(typeof w.body.error, "string");
    assert.equal((await pool.query("SELECT attempts FROM js_otps WHERE email=$1", [c.email])).rows[0].attempts, 1);
    const malformed = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code: "12ab" } });
    assert.ok([400, 401].includes(malformed.status));
    const ok = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code } });
    assert.equal(ok.status, 200);
  }));

test("expired code is rejected", () =>
  withApp(async ({ pool, call, newCandidate }) => {
    const c = await newCandidate("expired@test.invalid");
    await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } });
    const code = await latestCode(c.email);
    await pool.query("UPDATE js_otps SET expires_at = now() - interval '1 second' WHERE email=$1", [c.email]);
    const r = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code } });
    assert.equal(r.status, 401);
  }));

test("a code can be used only once (also under concurrent verifies)", () =>
  withApp(async ({ call, newCandidate }) => {
    const c = await newCandidate("reuse@test.invalid");
    await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } });
    const code = await latestCode(c.email);
    const results = await Promise.all([1, 2, 3].map(() => call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code } })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 401).length, 2);
    const again = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code } });
    assert.equal(again.status, 401);
  }));

test("after 5 failed attempts the code is dead (6th attempt locked even with the right code)", () =>
  withApp(async ({ pool, call, newCandidate }) => {
    const c = await newCandidate("locked@test.invalid");
    await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } });
    const code = await latestCode(c.email);
    for (let i = 0; i < 5; i += 1) {
      const r = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code: wrongCode(code) } });
      assert.equal(r.status, 401);
    }
    const sixth = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code } });
    assert.equal(sixth.status, 401);
    assert.equal((await pool.query("SELECT attempts FROM js_otps WHERE email=$1", [c.email])).rows[0].attempts, 5);
    assert.equal((await pool.query("SELECT used_at FROM js_otps WHERE email=$1", [c.email])).rows[0].used_at, null);
  }));

test("resend within 60 s is rejected; a later resend replaces the previous code", () =>
  withApp(async ({ pool, call, newCandidate }) => {
    const c = await newCandidate("resend@test.invalid");
    assert.equal((await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } })).status, 200);
    const first = await latestCode(c.email);
    const again = await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } });
    assert.equal(again.status, 429);
    assert.equal(typeof again.body.error, "string");
    assert.equal((await mail().sandbox.listOutbound({ to: c.email })).length, 1);

    // Memory limiter cleared (e.g. process restart): DB cooldown still holds, silently.
    otp()._testing.reset();
    const afterReset = await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } });
    assert.equal(afterReset.status, 200);
    assert.deepEqual(afterReset.body, GENERIC);
    assert.equal((await mail().sandbox.listOutbound({ to: c.email })).length, 1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM js_otps WHERE email=$1", [c.email])).rows[0].n, 1);

    // 61 s later: new code issued, old one no longer valid.
    otp()._testing.reset();
    await pool.query("UPDATE js_otps SET created_at = created_at - interval '61 seconds' WHERE email=$1", [c.email]);
    assert.equal((await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } })).status, 200);
    assert.equal((await mail().sandbox.listOutbound({ to: c.email })).length, 2);
    const second = await latestCode(c.email);
    if (second !== first) {
      const old = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code: first } });
      assert.equal(old.status, 401);
    }
    const ok = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code: second } });
    assert.equal(ok.status, 200);
  }));

test("unknown, inactive, suspended-link and non-Candidate emails get the identical response and no code", () =>
  withApp(async ({ pool, call, newCandidate }) => {
    const known = await newCandidate("known@test.invalid");
    const inactive = await newCandidate("inactive@test.invalid");
    await pool.query("UPDATE users SET is_active=false WHERE id=$1", [inactive.userId]);
    const unlinked = await newCandidate("unlinked@test.invalid");
    await pool.query("DELETE FROM js_candidate_accounts WHERE user_id=$1", [unlinked.userId]);

    const res = {};
    for (const email of ["known@test.invalid", "nobody@test.invalid", "inactive@test.invalid", "unlinked@test.invalid", "agent@test.invalid"]) {
      res[email] = await call("POST", "/jobsearch/auth/otp/request", { body: { email } });
    }
    for (const [email, r] of Object.entries(res)) {
      assert.equal(r.status, 200, email);
      assert.equal(r.text, res["known@test.invalid"].text, email);
    }
    assert.equal((await mail().sandbox.listOutbound({ to: known.email })).length, 1);
    for (const email of ["nobody@test.invalid", "inactive@test.invalid", "unlinked@test.invalid", "agent@test.invalid"]) {
      assert.equal((await mail().sandbox.listOutbound({ to: email })).length, 0, email);
      assert.equal((await pool.query("SELECT count(*)::int n FROM js_otps WHERE email=$1", [email])).rows[0].n, 0, email);
    }
    // verify failures look identical for unknown vs known-with-wrong-code
    const v1 = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: "nobody@test.invalid", code: "123456" } });
    const code = await latestCode(known.email);
    const v2 = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: known.email, code: wrongCode(code) } });
    assert.equal(v1.status, 401);
    assert.equal(v1.text, v2.text);

    // invalid input
    assert.equal((await call("POST", "/jobsearch/auth/otp/request", { body: {} })).status, 400);
    // requestOtp itself always resolves
    await otp().requestOtp(undefined);
    await otp().requestOtp("not-an-email");
    await otp().requestOtp("nobody2@test.invalid");
  }));

test("deactivated user cannot verify an already-issued code", () =>
  withApp(async ({ pool, call, newCandidate }) => {
    const c = await newCandidate("deact@test.invalid");
    await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } });
    const code = await latestCode(c.email);
    await pool.query("UPDATE users SET is_active=false WHERE id=$1", [c.userId]);
    const r = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code } });
    assert.equal(r.status, 401);
  }));

test("OTP mail rejected by the adapter is not treated as sent, response stays generic", () =>
  withApp(async ({ pool, call, newCandidate }) => {
    const c = await newCandidate("blocked@test.invalid");
    process.env.MAIL_SANDBOX_ALLOWLIST = "*@elsewhere.test.invalid";
    let r;
    try {
      r = await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } });
    } finally {
      delete process.env.MAIL_SANDBOX_ALLOWLIST;
    }
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, GENERIC);
    assert.equal((await mail().sandbox.listOutbound({ to: c.email })).length, 0);
    const live = await pool.query("SELECT count(*)::int n FROM js_otps WHERE email=$1 AND used_at IS NULL AND expires_at > now()", [c.email]);
    assert.equal(live.rows[0].n, 0, "undelivered code must not stay valid");
  }));

test("the OTP code never appears in console output or response bodies", () =>
  withApp(async ({ call, newCandidate }) => {
    const c = await newCandidate("logs@test.invalid");
    const captured = [];
    const methods = ["log", "info", "warn", "error", "debug", "trace"];
    const orig = {};
    for (const m of methods) {
      orig[m] = console[m];
      console[m] = (...args) => captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(a || {})))).join(" "));
    }
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk, ...rest) => {
      captured.push(String(chunk));
      return origOut(chunk, ...rest);
    };
    process.stderr.write = (chunk, ...rest) => {
      captured.push(String(chunk));
      return origErr(chunk, ...rest);
    };
    const bodies = [];
    let code;
    try {
      bodies.push((await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } })).text);
      code = await latestCode(c.email);
      bodies.push((await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code: wrongCode(code) } })).text);
      bodies.push((await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code } })).text);
      bodies.push((await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code } })).text);
      // a send failure path must not log the code either
      process.env.MAIL_SANDBOX_ALLOWLIST = "*@elsewhere.test.invalid";
      otp()._testing.reset();
      await otp().requestOtp(c.email);
    } finally {
      delete process.env.MAIL_SANDBOX_ALLOWLIST;
      for (const m of methods) console[m] = orig[m];
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    for (const line of captured) assert.ok(!line.includes(code), "code leaked into logs");
    for (const b of bodies) assert.ok(!b.includes(code), "code leaked into a response");
  }));

test("session revocation: deactivation or token_version bump rejects an old Candidate token", () =>
  withApp(async ({ pool, call, newCandidate, adminToken }) => {
    const c = await newCandidate("revoke@test.invalid");
    await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } });
    const token = (await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code: await latestCode(c.email) } })).body.token;
    assert.equal((await call("GET", "/jobsearch/auth/me", { token })).status, 200);

    await pool.query("UPDATE users SET is_active=false WHERE id=$1", [c.userId]);
    assert.equal((await call("GET", "/jobsearch/auth/me", { token })).status, 401);
    await pool.query("UPDATE users SET is_active=true WHERE id=$1", [c.userId]);
    assert.equal((await call("GET", "/jobsearch/auth/me", { token })).status, 200);

    const { bumpTokenVersion } = require("../middleware/auth");
    assert.equal(await bumpTokenVersion(c.userId), 1);
    assert.equal((await call("GET", "/jobsearch/auth/me", { token })).status, 401);

    // a fresh login after revocation carries the new version and works
    otp()._testing.reset();
    await pool.query("UPDATE js_otps SET created_at = created_at - interval '61 seconds' WHERE email=$1", [c.email]);
    await call("POST", "/jobsearch/auth/otp/request", { body: { email: c.email } });
    const v = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: c.email, code: await latestCode(c.email) } });
    assert.equal(jwt.decode(v.body.token).tv, 1);
    assert.equal((await call("GET", "/jobsearch/auth/me", { token: v.body.token })).status, 200);

    // a deleted user's token is rejected
    await pool.query("DELETE FROM users WHERE id=$1", [c.userId]);
    assert.equal((await call("GET", "/jobsearch/auth/me", { token: v.body.token })).status, 401);

    // legacy staff tokens (no tv) keep working; a Candidate token without tv is refused
    assert.equal((await call("GET", "/jobsearch/auth/me", { token: adminToken })).status, 200);
    const noTv = jwt.sign({ id: c.userId, role: "Candidate" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    assert.equal((await call("GET", "/jobsearch/auth/me", { token: noTv })).status, 401);
  }));

test("verifyToken: tokens without tv keep legacy behaviour (no DB lookup)", async () => {
  const { verifyToken } = require("../middleware/auth");
  const db = require("../db");
  const prev = db.setPool({
    query: () => {
      throw new Error("DB must not be touched for legacy tokens");
    },
  });
  try {
    const token = jwt.sign({ id: 42, role: "Admin" }, process.env.JWT_SECRET);
    const req = { headers: { authorization: `Bearer ${token}` } };
    let passed = false;
    await verifyToken(req, { status: () => ({ json: () => {} }) }, () => {
      passed = true;
    });
    assert.equal(passed, true);
    assert.equal(req.user.id, 42);
    let status;
    await verifyToken({ headers: { authorization: "Bearer garbage" } }, { status: (s) => ((status = s), { json: () => {} }) }, () => assert.fail());
    assert.equal(status, 400);
  } finally {
    db.setPool(prev);
  }
});

test("request rate limit per IP and per email", () =>
  withApp(async ({ call }) => {
    const limits = otp()._testing.limits;
    for (let i = 0; i < limits.ipRequests; i += 1) {
      const r = await call("POST", "/jobsearch/auth/otp/request", { body: { email: `ip${i}@test.invalid` } });
      assert.equal(r.status, 200, `request ${i}`);
    }
    const over = await call("POST", "/jobsearch/auth/otp/request", { body: { email: "ipmax@test.invalid" } });
    assert.equal(over.status, 429);

    // per-email window: advance a fake clock past the cooldown each time
    otp()._testing.reset();
    let now = Date.now();
    otp()._testing.setNow(() => now);
    try {
      for (let i = 0; i < limits.emailRequests; i += 1) {
        assert.equal(otp().checkRequestLimit({ email: "e@test.invalid", ip: `10.0.0.${i}` }).ok, true, `email request ${i}`);
        now += 61 * 1000;
      }
      assert.equal(otp().checkRequestLimit({ email: "E@test.invalid", ip: "10.0.1.1" }).ok, false);
      now += limits.windowMs;
      assert.equal(otp().checkRequestLimit({ email: "e@test.invalid", ip: "10.0.1.2" }).ok, true);
    } finally {
      otp()._testing.setNow(null);
      otp()._testing.reset();
    }
  }));
