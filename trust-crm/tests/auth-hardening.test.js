// Task 18 item 4: staff session revocation (tv in /auth/login tokens), token lifetime, password strength for
// /auth/bootstrap-super-admin and /auth/register, and /auth/register refusing the Candidate role.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "auth-hardening-test-secret";
delete process.env.JWT_EXPIRES_IN;

const STRONG = "Orchard-Lantern-42";

async function withServer(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, url, token, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  };
  try {
    await fn({ pool, http });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

const login = async (http, email, password = STRONG) => {
  const r = await http("POST", "/auth/login", null, { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
};

test("password policy: >= 12 chars, not a common password, not containing the e-mail local part", () => {
  const { checkPassword } = require("../utils/passwordPolicy");
  assert.equal(checkPassword(STRONG, "owner@test.invalid"), null);
  assert.equal(checkPassword("e2e-Passw0rd!", "owner@test.invalid"), null);
  assert.match(checkPassword("Short1!", "a@b.invalid"), /at least 12/);
  assert.match(checkPassword(12345678, "a@b.invalid"), /at least 12/);
  for (const common of ["password1234", "Password123!", "123456789012", "qwertyuiop12", "administrator", "letmein12345", "iloveyou1234", "welcome12345"]) {
    assert.match(checkPassword(common, "zz@b.invalid") || "", /too common/, common);
  }
  assert.match(checkPassword("Mohamed.Aloui-2026", "mohamed.aloui@x.invalid"), /e-mail/);
  assert.match(checkPassword("xx-MOHAMEDALOUI-xx", "mohamed.aloui+crm@x.invalid"), /e-mail/, "dots/plus tags and case do not hide the local part");
  assert.equal(checkPassword("Orchard-Lantern-42", "ab@x.invalid"), null, "very short local parts (< 3 chars) are not matched");
});

test("bootstrap-super-admin and register enforce the password policy with a clear error; register refuses role Candidate", async () => {
  await withServer(async ({ pool, http }) => {
    const weak = await http("POST", "/auth/bootstrap-super-admin", null, { full_name: "Owner", email: "owner@test.invalid", password: "owner-password" });
    assert.equal(weak.status, 400);
    assert.match(weak.body.error, /password/i);
    assert.equal((await pool.query("SELECT count(*)::int n FROM users")).rows[0].n, 0, "nothing created");
    const boot = await http("POST", "/auth/bootstrap-super-admin", null, { full_name: "Owner", email: "owner@test.invalid", password: STRONG });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const sup = await login(http, "owner@test.invalid");

    const short = await http("POST", "/auth/register", sup, { full_name: "M", email: "mgr@test.invalid", password: "Abc-12345", role: "Manager" });
    assert.equal(short.status, 400);
    assert.match(short.body.error, /at least 12/);
    const own = await http("POST", "/auth/register", sup, { full_name: "M", email: "jean.dupont@test.invalid", password: "JeanDupont-2026!", role: "Manager" });
    assert.equal(own.status, 400);
    assert.match(own.body.error, /e-mail/);
    const cand = await http("POST", "/auth/register", sup, { full_name: "C", email: "cand@test.invalid", password: STRONG, role: "Candidate" });
    assert.equal(cand.status, 400);
    assert.match(cand.body.error, /candidate-accounts/);
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE role='Candidate'")).rows[0].n, 0);
    // other roles unchanged
    for (const role of ["Admin", "Manager", "Receptionist", "Accountant", "HR", "Agent"]) {
      const r = await http("POST", "/auth/register", sup, { full_name: role, email: `${role.toLowerCase()}-x@test.invalid`, password: STRONG, role });
      assert.equal(r.status, 201, `${role} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.role, role);
    }
    assert.equal((await http("POST", "/auth/register", sup, { full_name: "Z", email: "z@test.invalid", password: STRONG, role: "Wizard" })).status, 400);
  });
});

test("staff tokens from /auth/login carry tv (12h default lifetime); suspending a staff user -> 401 on the next request; legacy tokens without tv still work until expiry", async () => {
  await withServer(async ({ pool, http }) => {
    assert.equal((await http("POST", "/auth/bootstrap-super-admin", null, { full_name: "Owner", email: "owner@test.invalid", password: STRONG })).status, 201);
    const sup = await login(http, "owner@test.invalid");
    const reg = await http("POST", "/auth/register", sup, { full_name: "Mona Manager", email: "mona@test.invalid", password: STRONG, role: "Manager" });
    assert.equal(reg.status, 201);
    const tok = await login(http, "mona@test.invalid");
    const claims = jwt.decode(tok);
    assert.equal(claims.tv, 0);
    assert.equal(claims.role, "Manager");
    assert.equal(claims.exp - claims.iat, 12 * 3600, "default staff token lifetime is 12h");
    assert.equal((await http("GET", "/jobsearch/auth/me", tok)).status, 200);
    assert.equal((await http("GET", "/candidates/all", tok)).status, 200);

    const legacy = jwt.sign({ id: reg.body.id, role: "Manager" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    assert.equal((await http("GET", "/candidates/all", legacy)).status, 200, "pre-deploy tokens (no tv) keep working until they expire");

    const s = await http("POST", `/jobsearch/admin/users/${reg.body.id}/suspend`, sup, {});
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal((await http("GET", "/candidates/all", tok)).status, 401, "suspended staff: versioned token refused on the next request");
    assert.equal((await http("GET", "/jobsearch/auth/me", tok)).status, 401);
    assert.equal((await http("POST", "/auth/login", null, { email: "mona@test.invalid", password: STRONG })).status, 400, "inactive users cannot log in");

    const back = await http("POST", `/jobsearch/admin/users/${reg.body.id}/reinstate`, sup, {});
    assert.equal(back.status, 200);
    assert.equal((await http("GET", "/candidates/all", tok)).status, 401, "a reinstated user's old tokens stay revoked (token_version bumped)");
    const fresh = await login(http, "mona@test.invalid");
    assert.equal(jwt.decode(fresh).tv, 2);
    assert.equal((await http("GET", "/candidates/all", fresh)).status, 200);

    // role change in the DB invalidates the token too
    await pool.query("UPDATE users SET role='Agent' WHERE id=$1", [reg.body.id]);
    assert.equal((await http("GET", "/candidates/all", fresh)).status, 401);
  });
});

test("JWT_EXPIRES_IN overrides the staff token lifetime (backward compatibility); invalid values fall back to 12h", async () => {
  await withServer(async ({ http }) => {
    assert.equal((await http("POST", "/auth/bootstrap-super-admin", null, { full_name: "Owner", email: "owner@test.invalid", password: STRONG })).status, 201);
    try {
      for (const [v, secs] of [["7d", 7 * 86400], ["3600", 3600], ["90m", 5400], ["nonsense", 12 * 3600], ["-5", 12 * 3600]]) {
        process.env.JWT_EXPIRES_IN = v;
        const c = jwt.decode(await login(http, "owner@test.invalid"));
        assert.equal(c.exp - c.iat, secs, `JWT_EXPIRES_IN=${v}`);
      }
    } finally {
      delete process.env.JWT_EXPIRES_IN;
    }
  });
});
