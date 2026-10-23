const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "orgs-otp-test-secret";
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
    await otp()._testing.flush();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, body: json, text };
  };
  let n = 0;
  // org + linked portal user
  const makeOrg = async (type, { orgStatus = "active", active = true, linked = true, email } = {}) => {
    n += 1;
    const role = type === "employer" ? "Employer" : "Agency";
    const em = email || `${type}${n}@test.invalid`;
    const table = type === "employer" ? "crm_employers" : "crm_agencies";
    const org = (await pool.query(`INSERT INTO ${table} (name, status) VALUES ($1,$2) RETURNING id`, [`Org ${n}`, orgStatus])).rows[0].id;
    const u = (
      await pool.query("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x',$3,$4) RETURNING id", [`P${n}`, em, role, active])
    ).rows[0].id;
    if (linked) await pool.query("INSERT INTO crm_org_accounts (user_id, org_type, org_id) VALUES ($1,$2,$3)", [u, type, org]);
    return { userId: u, orgId: org, email: em, role, table };
  };
  const latestCode = async (email) => {
    const rows = await mail().sandbox.listOutbound({ to: email });
    assert.ok(rows.length > 0, "expected an OTP mail");
    return /\b(\d{6})\b/.exec(rows[rows.length - 1].body)[1];
  };
  const outboundCount = async (email) => (await mail().sandbox.listOutbound({ to: email })).length;
  const login = async (email) => {
    otp()._testing.reset();
    await call("POST", "/jobsearch/auth/otp/request", { body: { email } });
    return call("POST", "/jobsearch/auth/otp/verify", { body: { email, code: await latestCode(email) } });
  };
  try {
    await fn({ pool, call, makeOrg, latestCode, outboundCount, login });
  } finally {
    await otp()._testing.flush();
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
  }
}

for (const type of ["employer", "agency"]) {
  const Role = type === "employer" ? "Employer" : "Agency";

  test(`${Role}: linked + active + org active logs in; response carries role, token has tv and an expiry`, () =>
    withApp(async ({ pool, call, makeOrg, login }) => {
      const o = await makeOrg(type);
      const r = await call("POST", "/jobsearch/auth/otp/request", { body: { email: o.email.toUpperCase() } });
      assert.deepEqual(r.body, GENERIC);
      const v = await login(o.email);
      assert.equal(v.status, 200, v.text);
      assert.equal(v.body.role, Role);
      const claims = jwt.verify(v.body.token, process.env.JWT_SECRET);
      assert.equal(claims.id, o.userId);
      assert.equal(claims.role, Role);
      assert.equal(claims.tv, 0);
      assert.ok(claims.exp > claims.iat && claims.exp - claims.iat <= 12 * 3600);
      const me = await call("GET", "/jobsearch/auth/me", { token: v.body.token });
      assert.equal(me.status, 200);
      assert.deepEqual(me.body, { id: o.userId, role: Role });
    }));

  test(`${Role}: not linked => no code, identical response, no mail`, () =>
    withApp(async ({ call, makeOrg, outboundCount }) => {
      const o = await makeOrg(type, { linked: false });
      const known = await call("POST", "/jobsearch/auth/otp/request", { body: { email: o.email } });
      const unknown = await call("POST", "/jobsearch/auth/otp/request", { body: { email: "nobody@test.invalid" } });
      assert.equal(known.status, unknown.status);
      assert.equal(known.text, unknown.text);
      assert.equal(await outboundCount(o.email), 0);
    }));

  test(`${Role}: inactive user => no code`, () =>
    withApp(async ({ pool, call, makeOrg, outboundCount }) => {
      const o = await makeOrg(type, { active: false });
      await call("POST", "/jobsearch/auth/otp/request", { body: { email: o.email } });
      assert.equal(await outboundCount(o.email), 0);
      assert.equal((await pool.query("SELECT count(*)::int n FROM js_otps WHERE email=$1", [o.email])).rows[0].n, 0);
    }));

  test(`${Role}: suspended organisation => no code and no login even with an older code`, () =>
    withApp(async ({ pool, call, makeOrg, outboundCount, latestCode }) => {
      const o = await makeOrg(type);
      await call("POST", "/jobsearch/auth/otp/request", { body: { email: o.email } });
      const code = await latestCode(o.email);
      await pool.query(`UPDATE ${o.table} SET status='suspended' WHERE id=$1`, [o.orgId]);
      const v = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: o.email, code } });
      assert.equal(v.status, 401);
      assert.equal(v.body.token, undefined);
      otp()._testing.reset();
      const before = await outboundCount(o.email);
      await call("POST", "/jobsearch/auth/otp/request", { body: { email: o.email } });
      assert.equal(await outboundCount(o.email), before);
    }));

  test(`${Role}: link row pointing to a missing organisation => no code`, () =>
    withApp(async ({ pool, call, makeOrg, outboundCount }) => {
      const o = await makeOrg(type);
      await pool.query("UPDATE crm_org_accounts SET org_id = 999999 WHERE user_id=$1", [o.userId]);
      await call("POST", "/jobsearch/auth/otp/request", { body: { email: o.email } });
      assert.equal(await outboundCount(o.email), 0);
    }));

  test(`${Role}: org link of the other type does not make the role eligible`, () =>
    withApp(async ({ pool, call, makeOrg, outboundCount }) => {
      const o = await makeOrg(type);
      await pool.query("UPDATE crm_org_accounts SET org_type = $2 WHERE user_id=$1", [o.userId, type === "employer" ? "agency" : "employer"]);
      await call("POST", "/jobsearch/auth/otp/request", { body: { email: o.email } });
      assert.equal(await outboundCount(o.email), 0);
    }));

  test(`${Role}: revoked token_version is rejected (session revocation)`, () =>
    withApp(async ({ pool, call, makeOrg, login }) => {
      const o = await makeOrg(type);
      const v = await login(o.email);
      assert.equal((await call("GET", "/jobsearch/auth/me", { token: v.body.token })).status, 200);
      await pool.query("UPDATE users SET token_version = token_version + 1 WHERE id=$1", [o.userId]);
      const after = await call("GET", "/jobsearch/auth/me", { token: v.body.token });
      assert.equal(after.status, 401);
    }));

  test(`${Role}: deactivated user, or suspended org, kills an existing token at once`, () =>
    withApp(async ({ pool, call, makeOrg, login }) => {
      const o = await makeOrg(type);
      const v = await login(o.email);
      await pool.query(`UPDATE ${o.table} SET status='suspended' WHERE id=$1`, [o.orgId]);
      assert.equal((await call("GET", "/jobsearch/auth/me", { token: v.body.token })).status, 401);
      await pool.query(`UPDATE ${o.table} SET status='active' WHERE id=$1`, [o.orgId]);
      assert.equal((await call("GET", "/jobsearch/auth/me", { token: v.body.token })).status, 200);
      await pool.query("UPDATE users SET is_active=false WHERE id=$1", [o.userId]);
      assert.equal((await call("GET", "/jobsearch/auth/me", { token: v.body.token })).status, 401);
    }));

  test(`${Role}: a token without tv is refused; a forged role for the same user id is refused`, () =>
    withApp(async ({ call, makeOrg }) => {
      const o = await makeOrg(type);
      const noTv = jwt.sign({ id: o.userId, role: Role }, process.env.JWT_SECRET, { expiresIn: "1h" });
      assert.equal((await call("GET", "/jobsearch/auth/me", { token: noTv })).status, 401);
      const wrongRole = jwt.sign({ id: o.userId, role: "Admin", tv: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
      assert.equal((await call("GET", "/jobsearch/auth/me", { token: wrongRole })).status, 401);
    }));

  test(`${Role}: token is denied by existing permission-protected routes`, () =>
    withApp(async ({ call, makeOrg, login }) => {
      const o = await makeOrg(type);
      const token = (await login(o.email)).body.token;
      for (const [method, path] of [
        ["GET", "/candidates"],
        ["GET", "/crm/leads"],
        ["GET", "/jobsearch/jobs"],
        ["GET", "/audit"],
        ["POST", "/jobsearch/admin/candidate-accounts"],
      ]) {
        const r = await call(method, path, { token, body: method === "POST" ? {} : undefined });
        assert.ok([401, 403, 404].includes(r.status), `${method} ${path} -> ${r.status}`);
      }
    }));
}

test("OTP mail for org users is single-use and wrong codes are counted like Candidate codes", () =>
  withApp(async ({ call, makeOrg, latestCode }) => {
    const o = await makeOrg("employer");
    await call("POST", "/jobsearch/auth/otp/request", { body: { email: o.email } });
    const code = await latestCode(o.email);
    const wrong = String((Number(code) + 1) % 1000000).padStart(6, "0");
    assert.equal((await call("POST", "/jobsearch/auth/otp/verify", { body: { email: o.email, code: wrong } })).status, 401);
    assert.equal((await call("POST", "/jobsearch/auth/otp/verify", { body: { email: o.email, code } })).status, 200);
    assert.equal((await call("POST", "/jobsearch/auth/otp/verify", { body: { email: o.email, code } })).status, 401);
  }));

test("Candidate login is unchanged: verify body is exactly {token}, role Candidate, tv claim", () =>
  withApp(async ({ pool, call, latestCode }) => {
    const cid = (await pool.query("INSERT INTO candidates (full_name, passport_number) VALUES ('Z','PZ') RETURNING id")).rows[0].id;
    const u = (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('Z','cand@test.invalid','x','Candidate') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [u, cid]);
    await call("POST", "/jobsearch/auth/otp/request", { body: { email: "cand@test.invalid" } });
    const v = await call("POST", "/jobsearch/auth/otp/verify", { body: { email: "cand@test.invalid", code: await latestCode("cand@test.invalid") } });
    assert.equal(v.status, 200);
    assert.deepEqual(Object.keys(v.body), ["token"]);
    const claims = jwt.verify(v.body.token, process.env.JWT_SECRET);
    assert.equal(claims.role, "Candidate");
    assert.equal(claims.tv, 0);
  }));

test("staff users (Admin/Agent) still cannot request OTP codes", () =>
  withApp(async ({ pool, call, outboundCount }) => {
    await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('A','adm@test.invalid','x','Admin')");
    await call("POST", "/jobsearch/auth/otp/request", { body: { email: "adm@test.invalid" } });
    assert.equal(await outboundCount("adm@test.invalid"), 0);
  }));
