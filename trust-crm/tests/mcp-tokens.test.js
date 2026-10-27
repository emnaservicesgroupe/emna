// Stage 7, Task 1: personal access tokens (migration 023, mcp:use, modules/mcp/tokens.js, /mcp-tokens, verifyToken refusal of PAT bearers).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "mcp-tokens-test-secret";
delete process.env.MCP_TOKEN_DEFAULT_DAYS;
delete process.env.MCP_ENABLED;

const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser, portalToken } = require("./helpers/orgs");
const { PERMISSIONS, checkPermission } = require("../middleware/role");
const { runMigrations } = require("../scripts/migrate");
const tokens = require("../modules/mcp/tokens");
const mcpAuth = require("../modules/mcp/auth");

const ROOT = path.join(__dirname, "..");
const SQL023 = () => fs.readFileSync(path.join(ROOT, "sql", "migrations", "023_mcp_tokens.sql"), "utf8");
const ROLES = ["SuperAdmin", "Admin", "Manager", "Receptionist", "Accountant", "HR", "Agent"];
const ALLOWED = new Set(["SuperAdmin", "Admin", "Manager"]);

let worldPromise = null;
const world = () => (worldPromise ||= build());
test.after(async () => {
  if (worldPromise) await (await worldPromise).close().catch(() => {});
});

let seq = 0;
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
    return { status: res.status, body: json, text };
  };
  const mk = async (role) => {
    seq += 1;
    const id = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'h',$3) RETURNING id", [`${role} ${seq}`, `mcp${seq}-${process.pid}@test.invalid`, role])).id;
    return { id, role, token: jwt.sign({ id, role, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
  };
  return { pool, q, one, http, mk, base, close: async () => { await new Promise((r) => server.close(r)); await cleanup(); } };
}

const create = (w, u, body = { name: "laptop" }) => w.http("POST", "/mcp-tokens", u.token, body);

// ------------------------------------------------------------------------------------------------ schema
test("migration 023 is idempotent, registered, and has the specified constraints and indexes", async () => {
  const w = await world();
  assert.deepEqual(await runMigrations(w.pool), []);
  await w.q(SQL023());
  await w.q(SQL023());
  assert.equal((await w.q("SELECT 1 FROM schema_migrations WHERE name='023_mcp_tokens.sql'")).rowCount, 1);
  const cols = (await w.q("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name='api_tokens'")).rows.map((r) => r.column_name);
  for (const c of ["id", "user_id", "name", "prefix", "token_hash", "scopes", "expires_at", "last_used_at", "last_used_ip_hash", "revoked_at", "revoked_by", "created_at"]) assert.ok(cols.includes(c), c);
  const defs = (await w.q("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename='api_tokens'")).rows.map((r) => r.indexdef);
  assert.ok(defs.some((d) => /\(user_id\)/.test(d) && !/UNIQUE/.test(d)), "index on user_id");
  assert.ok(defs.some((d) => /\(prefix\)/.test(d)), "index on prefix");
  assert.ok(defs.some((d) => /UNIQUE.*\(token_hash\)/.test(d)), "unique token_hash");
  const def = (await w.one("SELECT scopes FROM api_tokens LIMIT 1")) || null;
  assert.equal(def, null);
});

test("api_tokens CHECKs: name 1..80, prefix 8 chars, expires_at > created_at, unique hash, cascade from users", async () => {
  const w = await world();
  const u = await w.mk("Admin");
  const hash = () => crypto.randomBytes(32).toString("hex");
  const ins = (over = {}) => {
    const r = { name: "n", prefix: "abcdefgh", hash: hash(), exp: "now() + interval '1 day'", ...over };
    return w.q(`INSERT INTO api_tokens (user_id,name,prefix,token_hash,expires_at) VALUES ($1,$2,$3,$4,${r.exp}) RETURNING id, scopes`, [u.id, r.name, r.prefix, r.hash]);
  };
  const CHECK = /check constraint/i;
  assert.deepEqual((await ins()).rows[0].scopes, ["read"]);
  await assert.rejects(ins({ name: "" }), CHECK);
  await assert.rejects(ins({ name: "   " }), CHECK);
  await assert.rejects(ins({ name: "x".repeat(81) }), CHECK);
  await ins({ name: "x".repeat(80) });
  await assert.rejects(ins({ prefix: "abcdefg" }), CHECK);
  await assert.rejects(ins({ prefix: "abcdefghi" }), CHECK);
  await assert.rejects(ins({ exp: "now() - interval '1 second'" }), CHECK);
  await assert.rejects(ins({ hash: "nothex" }), CHECK);
  const h = hash();
  await ins({ hash: h });
  await assert.rejects(ins({ hash: h }), (e) => e.code === "23505");
  const n = (await w.one("SELECT count(*)::int AS n FROM api_tokens WHERE user_id=$1", [u.id])).n;
  assert.ok(n >= 3);
  await w.q("DELETE FROM users WHERE id=$1", [u.id]);
  assert.equal((await w.one("SELECT count(*)::int AS n FROM api_tokens WHERE user_id=$1", [u.id])).n, 0, "ON DELETE CASCADE");
});

// ------------------------------------------------------------------------------------------------ permission
test("mcp:use matrix: Admin, Manager, SuperAdmin (via *) only", () => {
  const run = (role) => {
    let status = 200;
    checkPermission("mcp:use")({ user: { role } }, { status: (s) => ({ json: () => (status = s) }) }, () => {});
    return status;
  };
  for (const r of ROLES) assert.equal(run(r), ALLOWED.has(r) ? 200 : 403, r);
  for (const r of ["Candidate", "Employer", "Agency"]) assert.equal(run(r), 403, r);
  assert.ok(PERMISSIONS.SuperAdmin.includes("*"));
  assert.ok(PERMISSIONS.Admin.includes("mcp:use") && PERMISSIONS.Manager.includes("mcp:use"));
});

test("SETUP.md mcp permission matrix equals PERMISSIONS (docs cannot drift)", () => {
  const doc = fs.readFileSync(path.join(ROOT, "..", "docs", "vita-job-search", "SETUP.md"), "utf8");
  const m = /<!-- mcp-permission-matrix:start -->([\s\S]*?)<!-- mcp-permission-matrix:end -->/.exec(doc);
  assert.ok(m, "SETUP.md has the mcp-permission-matrix block");
  const lines = m[1].trim().split("\n").filter((l) => l.startsWith("|"));
  const perms = lines[0].split("|").map((c) => c.trim()).filter(Boolean).slice(1);
  assert.deepEqual(perms, ["mcp:use"]);
  const all = [...new Set(Object.values(PERMISSIONS).flat().filter((p) => p.startsWith("mcp:")))];
  assert.deepEqual(all, ["mcp:use"], "every mcp:* grant in code is a documented column");
  const seen = new Set();
  for (const line of lines.slice(2)) {
    const [role, cell] = line.split("|").slice(1, -1).map((c) => c.trim());
    seen.add(role);
    assert.ok(PERMISSIONS[role], `documented role ${role} exists`);
    assert.ok(["✓", "—"].includes(cell));
    assert.equal(cell === "✓", PERMISSIONS[role].includes("*") || PERMISSIONS[role].includes("mcp:use"), role);
  }
  assert.deepEqual([...seen].sort(), Object.keys(PERMISSIONS).sort(), "every role is documented");
});

// ------------------------------------------------------------------------------------------------ create
test("secret format, entropy sanity, shown once, only the sha256 is stored", async () => {
  const w = await world();
  const u = await w.mk("Manager");
  const secrets = new Set();
  const mine = await w.mk("Admin");
  for (let i = 0; i < 4; i++) {
    const r = await create(w, mine, { name: `t${i}` });
    assert.equal(r.status, 201, r.text);
    assert.match(r.body.secret, /^vita_pat_[A-Za-z0-9_-]{43}$/);
    assert.equal(r.body.prefix.length, 8);
    assert.equal(r.body.secret.slice(9, 17), r.body.prefix);
    assert.equal(r.body.mcp_enabled, false);
    secrets.add(r.body.secret);
  }
  assert.equal(secrets.size, 4, "secrets are unique");
  const body = [...secrets][0].slice(9);
  assert.ok(new Set(body).size >= 20, "random part is not low-entropy");
  const r = await create(w, u, { name: "stored" });
  const row = await w.one("SELECT * FROM api_tokens WHERE id=$1", [r.body.id]);
  assert.equal(row.token_hash, crypto.createHash("sha256").update(r.body.secret).digest("hex"));
  assert.equal(row.user_id, u.id);
  assert.deepEqual(row.scopes, ["read"]);
  // the secret appears nowhere in the database: scan every text-ish column of both tables
  const hay = JSON.stringify((await w.q("SELECT * FROM api_tokens")).rows) + JSON.stringify((await w.q("SELECT * FROM audit_logs")).rows);
  for (const s of [r.body.secret, ...secrets]) {
    assert.ok(!hay.includes(s), "secret not stored");
    assert.ok(!hay.includes(s.slice(9)), "random part not stored");
  }
  assert.ok(!JSON.stringify((await w.q("SELECT * FROM audit_logs")).rows).includes(row.token_hash), "hash is not audited");
  // shown once: no list ever returns the secret, the hash or the ip hash
  for (const user of [u, mine, await w.mk("SuperAdmin")]) {
    const l = await w.http("GET", "/mcp-tokens", user.token);
    assert.equal(l.status, 200);
    assert.ok(!l.text.includes(r.body.secret) && !l.text.includes(row.token_hash) && !/secret|token_hash|ip_hash/.test(l.text));
  }
});

test("days: default 30, MCP_TOKEN_DEFAULT_DAYS honoured, bounds 1..90 else 400", async () => {
  const w = await world();
  const u = await w.mk("Admin");
  const days = async (body) => {
    const r = await create(w, u, body);
    if (r.status !== 201) return r;
    const row = await w.one("SELECT round(extract(epoch FROM (expires_at - created_at))/86400)::int AS d FROM api_tokens WHERE id=$1", [r.body.id]);
    await w.http("DELETE", `/mcp-tokens/${r.body.id}`, u.token);
    return row.d;
  };
  assert.equal(await days({ name: "a" }), 30);
  assert.equal(await days({ name: "a", days: 1 }), 1);
  assert.equal(await days({ name: "a", days: 90 }), 90);
  process.env.MCP_TOKEN_DEFAULT_DAYS = "7";
  assert.equal(await days({ name: "a" }), 7);
  process.env.MCP_TOKEN_DEFAULT_DAYS = "500";
  assert.equal(await days({ name: "a" }), 30, "an out-of-range env default falls back to 30");
  delete process.env.MCP_TOKEN_DEFAULT_DAYS;
  for (const bad of [0, 91, -1, 1.5, "7", true, [], {}]) {
    const r = await create(w, u, { name: "a", days: bad });
    assert.equal(r.status, 400, `days=${JSON.stringify(bad)} -> ${r.status}`);
  }
  for (const bad of [undefined, "", "   ", 5, null, "x".repeat(81), "bad\u0000name", "bidi‮name"]) {
    const r = await create(w, u, { name: bad });
    assert.equal(r.status, 400, `name=${JSON.stringify(bad)}`);
  }
  assert.equal((await w.http("POST", "/mcp-tokens", u.token, undefined, "[1]")).status, 400);
  assert.equal((await w.http("POST", "/mcp-tokens", u.token, undefined, "{bad")).status, 400);
  assert.equal((await create(w, u, { name: "  trimmed  " })).status, 201);
  assert.equal((await w.one("SELECT name FROM api_tokens WHERE user_id=$1 AND name='trimmed'", [u.id])).name, "trimmed");
});

test("at most 5 active tokens per user; revoked and expired ones do not count; other users unaffected; concurrent creates cannot exceed the cap", async () => {
  const w = await world();
  const u = await w.mk("Manager");
  const other = await w.mk("Manager");
  const made = [];
  for (let i = 0; i < 5; i++) {
    const r = await create(w, u, { name: `c${i}` });
    assert.equal(r.status, 201, r.text);
    made.push(r.body);
  }
  const sixth = await create(w, u, { name: "c6" });
  assert.equal(sixth.status, 409);
  assert.ok(!/vita_pat_/.test(sixth.text));
  assert.equal((await create(w, other)).status, 201, "the cap is per user");
  assert.equal((await w.http("DELETE", `/mcp-tokens/${made[0].id}`, u.token)).status, 200);
  assert.equal((await create(w, u, { name: "c7" })).status, 201, "a revoked token frees a slot");
  assert.equal((await create(w, u, { name: "c8" })).status, 409);
  await w.q("UPDATE api_tokens SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id=$1", [made[1].id]);
  assert.equal((await create(w, u, { name: "c9" })).status, 201, "an expired token frees a slot");
  const racer = await w.mk("Admin");
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) => create(w, racer, { name: `r${i}` })));
  assert.equal(results.filter((r) => r.status === 201).length, 5);
  assert.equal(results.filter((r) => r.status === 409).length, 4);
});

// ------------------------------------------------------------------------------------------------ authenticate
test("authenticate: valid token returns the current user; every failure is the same null", async () => {
  const w = await world();
  const u = await w.mk("Admin");
  const t = await tokens.createToken({ id: u.id, role: "Admin" }, { name: "auth", days: 3 });
  const ok = await tokens.authenticate(t.secret);
  assert.equal(ok.user.id, u.id);
  assert.equal(ok.user.role, "Admin");
  assert.equal(ok.token.id, t.id);
  assert.equal(ok.token.prefix, t.prefix);
  assert.ok(!JSON.stringify(ok).includes(t.secret) && !/hash/.test(JSON.stringify(ok)));
  const malformed = ["", null, undefined, 42, {}, "vita_pat_", "vita_pat_short", `vita_pat_${"a".repeat(44)}`, `vita_pat_${"a".repeat(42)}!`, `VITA_PAT_${t.secret.slice(9)}`, t.secret + " ", " " + t.secret, t.secret.slice(9), `vita_pat_${crypto.randomBytes(32).toString("base64url")}`, jwt.sign({ id: u.id, role: "Admin" }, process.env.JWT_SECRET)];
  for (const m of malformed) assert.equal(await tokens.authenticate(m), null, String(m).slice(0, 20));
  // a JWT is not a PAT and a PAT is not a JWT
  assert.equal(mcpAuth.isPatBearer(`Bearer ${jwt.sign({ id: u.id, role: "Admin" }, process.env.JWT_SECRET)}`), false);
  assert.equal(mcpAuth.isPatBearer(`Bearer ${t.secret}`), true);
  assert.equal(mcpAuth.isPatBearer(t.secret), true);
  assert.equal(mcpAuth.isPatBearer(`Bearer   ${t.secret}`), true);
  assert.equal(mcpAuth.isPatBearer(undefined), false);
  assert.equal((await mcpAuth.authenticateRequest({ headers: { authorization: `Bearer ${t.secret}` } })).user.id, u.id);
  assert.equal(await mcpAuth.authenticateRequest({ headers: { authorization: `Bearer ${jwt.sign({ id: u.id, role: "Admin" }, process.env.JWT_SECRET)}` } }), null);
  assert.equal(await mcpAuth.authenticateRequest({ headers: {} }), null);
});

test("expired, revoked, deactivated owner and demoted owner are refused immediately", async () => {
  const w = await world();
  const mgr = await w.mk("Manager");
  const fresh = async (u) => (await tokens.createToken({ id: u.id, role: u.role }, { name: "x" })).secret;
  // expired
  let s = await fresh(mgr);
  assert.ok(await tokens.authenticate(s));
  await w.q("UPDATE api_tokens SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE token_hash=$1", [tokens.sha256hex(s)]);
  assert.equal(await tokens.authenticate(s), null, "expired");
  // revoked
  const u2 = await w.mk("Manager");
  const t2 = await tokens.createToken({ id: u2.id, role: "Manager" }, { name: "r" });
  assert.ok(await tokens.authenticate(t2.secret));
  await tokens.revokeToken({ id: u2.id, role: "Manager" }, t2.id);
  assert.equal(await tokens.authenticate(t2.secret), null, "revoked");
  // deactivated owner
  const u3 = await w.mk("Admin");
  s = await fresh(u3);
  assert.ok(await tokens.authenticate(s));
  await w.q("UPDATE users SET is_active=false WHERE id=$1", [u3.id]);
  assert.equal(await tokens.authenticate(s), null, "deactivated");
  await w.q("UPDATE users SET is_active=true WHERE id=$1", [u3.id]);
  assert.ok(await tokens.authenticate(s), "reactivated owner works again (token itself intact)");
  // demoted owner: role without mcp:use
  for (const role of ["Agent", "HR", "Accountant", "Receptionist"]) {
    await w.q("UPDATE users SET role=$2 WHERE id=$1", [u3.id, role]);
    assert.equal(await tokens.authenticate(s), null, `demoted to ${role}`);
  }
  await w.q("UPDATE users SET role='Manager' WHERE id=$1", [u3.id]);
  const back = await tokens.authenticate(s);
  assert.equal(back.user.role, "Manager", "the CURRENT role is loaded, not the one at creation");
  // deleted owner: token gone with the user
  await w.q("DELETE FROM users WHERE id=$1", [u3.id]);
  assert.equal(await tokens.authenticate(s), null);
});

test("last_used_at is updated at most once per minute", async () => {
  const w = await world();
  const u = await w.mk("Admin");
  const t = await tokens.createToken({ id: u.id, role: "Admin" }, { name: "touch" });
  const get = () => w.one("SELECT last_used_at, last_used_ip_hash FROM api_tokens WHERE id=$1", [t.id]);
  assert.equal((await get()).last_used_at, null);
  await tokens.authenticate(t.secret, { ip: "203.0.113.9" });
  const first = (await get()).last_used_at;
  assert.ok(first);
  const hashed = (await get()).last_used_ip_hash;
  assert.match(hashed, /^[0-9a-f]{64}$/);
  assert.ok(!hashed.includes("203"), "ip is stored hashed");
  await tokens.authenticate(t.secret);
  await tokens.authenticate(t.secret);
  assert.equal((await get()).last_used_at.getTime(), first.getTime(), "no write inside the minute");
  await w.q("UPDATE api_tokens SET last_used_at = now() - interval '61 seconds' WHERE id=$1", [t.id]);
  await tokens.authenticate(t.secret);
  assert.ok((await get()).last_used_at.getTime() > first.getTime() - 61000 + 30000, "moves again after a minute");
});

test("authenticate compares hashes with crypto.timingSafeEqual on equal-length buffers (unit level)", async (t) => {
  const w = await world();
  const u = await w.mk("Admin");
  const tk = await tokens.createToken({ id: u.id, role: "Admin" }, { name: "ct" });
  const calls = [];
  const orig = crypto.timingSafeEqual;
  t.mock.method(crypto, "timingSafeEqual", (a, b) => {
    calls.push([a.length, b.length]);
    return orig(a, b);
  });
  assert.ok(await tokens.authenticate(tk.secret));
  assert.equal(calls.length, 1, "exactly one constant-time compare");
  assert.deepEqual(calls[0], [64, 64]);
  // direct helper: unequal lengths never reach timingSafeEqual (it would throw) and are false; equal hashes true, differing false
  const h = tokens.sha256hex("a");
  assert.equal(tokens.hashEquals(h, h), true);
  assert.equal(tokens.hashEquals(h, tokens.sha256hex("b")), false);
  assert.equal(tokens.hashEquals(h, h.slice(1)), false);
  assert.equal(tokens.hashEquals(h, undefined), false);
  // a forged secret never matches a stored hash, and no compare is made without a row
  calls.length = 0;
  assert.equal(await tokens.authenticate(`vita_pat_${crypto.randomBytes(32).toString("base64url")}`), null);
  assert.equal(calls.length, 0);
  assert.ok(/timingSafeEqual/.test(fs.readFileSync(path.join(ROOT, "modules", "mcp", "tokens.js"), "utf8")));
});

// ------------------------------------------------------------------------------------------------ routes
test("roles matrix on /mcp-tokens: Admin, Manager, SuperAdmin allowed; other staff, Candidate, Employer, Agency and anonymous denied", async () => {
  const w = await world();
  for (const role of ROLES) {
    const u = await w.mk(role);
    const list = await w.http("GET", "/mcp-tokens", u.token);
    const post = await create(w, u, { name: `m-${role}` });
    const del = await w.http("DELETE", "/mcp-tokens/1", u.token);
    if (ALLOWED.has(role)) {
      assert.equal(list.status, 200, role);
      assert.equal(post.status, 201, role);
      assert.ok([200, 404].includes(del.status), `${role} DELETE ${del.status}`);
    } else {
      assert.deepEqual([list.status, post.status, del.status], [403, 403, 403], role);
      assert.deepEqual(Object.keys(post.body), ["error"]);
    }
  }
  const cand = await w.mk("Candidate");
  const emp = await createEmployerUser(w.pool);
  const agy = await createAgencyUser(w.pool);
  for (const [who, token] of [["candidate", cand.token], ["employer", emp.token], ["agency", agy.token], ["candidate-tv", portalToken(cand.id, "Candidate")]]) {
    for (const [m, url] of [["GET", "/mcp-tokens"], ["POST", "/mcp-tokens"], ["DELETE", "/mcp-tokens/1"]]) {
      const r = await w.http(m, url, token, m === "POST" ? { name: "x" } : undefined);
      assert.ok([401, 403].includes(r.status), `${who} ${m} ${url} -> ${r.status}`);
    }
  }
  for (const [m, url] of [["GET", "/mcp-tokens"], ["POST", "/mcp-tokens"], ["DELETE", "/mcp-tokens/1"]]) assert.equal((await w.http(m, url, null, m === "POST" ? { name: "x" } : undefined)).status, 401);
  assert.equal((await w.q("SELECT 1 FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE u.role IN ('Candidate','Employer','Agency','Agent','HR','Accountant','Receptionist')")).rowCount, 0, "no token for a role without mcp:use");
});

test("a deactivated or demoted staff session cannot manage tokens; a PAT cannot manage tokens either", async () => {
  const w = await world();
  const u = await w.mk("Manager");
  const made = await create(w, u, { name: "p" });
  assert.equal(made.status, 201);
  assert.equal((await w.http("GET", "/mcp-tokens", made.body.secret)).status, 401, "PAT as bearer on /mcp-tokens");
  assert.equal((await w.http("POST", "/mcp-tokens", made.body.secret, { name: "via pat" })).status, 401);
  assert.equal((await w.http("DELETE", `/mcp-tokens/${made.body.id}`, made.body.secret)).status, 401);
  assert.equal((await w.one("SELECT revoked_at FROM api_tokens WHERE id=$1", [made.body.id])).revoked_at, null);
  await w.q("UPDATE users SET is_active=false WHERE id=$1", [u.id]);
  assert.equal((await w.http("GET", "/mcp-tokens", u.token)).status, 401);
  await w.q("UPDATE users SET is_active=true, role='Agent' WHERE id=$1", [u.id]);
  assert.equal((await w.http("GET", "/mcp-tokens", u.token)).status, 401, "legacy token whose role changed");
});

test("feature flag: management works with MCP_ENABLED off and reports mcp_enabled either way", async () => {
  const w = await world();
  const u = await w.mk("Admin");
  const off = await create(w, u, { name: "flag" });
  assert.equal(off.status, 201);
  assert.equal(off.body.mcp_enabled, false);
  assert.equal((await w.http("GET", "/mcp-tokens", u.token)).body.mcp_enabled, false);
  process.env.MCP_ENABLED = "true";
  try {
    assert.equal((await w.http("GET", "/mcp-tokens", u.token)).body.mcp_enabled, true);
    assert.equal((await w.http("DELETE", `/mcp-tokens/${off.body.id}`, u.token)).body.mcp_enabled, true);
  } finally {
    delete process.env.MCP_ENABLED;
  }
});

test("list: own tokens only for Manager; Admin and SuperAdmin see all with owner name; no secret material", async () => {
  const w = await world();
  const a = await w.mk("Manager");
  const b = await w.mk("Manager");
  const admin = await w.mk("Admin");
  const root = await w.mk("SuperAdmin");
  const ta = (await create(w, a, { name: "A-token" })).body;
  const tb = (await create(w, b, { name: "B-token" })).body;
  const la = (await w.http("GET", "/mcp-tokens", a.token)).body.rows;
  assert.ok(la.some((r) => r.id === ta.id));
  assert.ok(la.every((r) => r.user_id === a.id), "a Manager sees only own tokens");
  assert.ok(!la.some((r) => r.id === tb.id));
  for (const who of [admin, root]) {
    const rows = (await w.http("GET", "/mcp-tokens", who.token)).body.rows;
    const ra = rows.find((r) => r.id === ta.id);
    const rb = rows.find((r) => r.id === tb.id);
    assert.ok(ra && rb, "sees everyone's");
    assert.match(ra.owner_name, /^Manager \d+$/);
    assert.equal(ra.status, "active");
    assert.deepEqual(Object.keys(ra).sort(), ["created_at", "expires_at", "id", "last_used_at", "name", "owner_name", "prefix", "revoked_at", "revoked_by", "scopes", "status", "user_id"]);
  }
});

test("revoke: idempotent, audited once; own or admin only; a Manager cannot revoke another's token (404); bad ids 400", async () => {
  const w = await world();
  const a = await w.mk("Manager");
  const b = await w.mk("Manager");
  const admin = await w.mk("Admin");
  const t = (await create(w, a, { name: "rev" })).body;
  const audits = () => w.one("SELECT count(*)::int AS n FROM audit_logs WHERE action='mcp.token.revoke' AND record_id=$1", [t.id]).then((r) => r.n);
  const foreign = await w.http("DELETE", `/mcp-tokens/${t.id}`, b.token);
  assert.equal(foreign.status, 404);
  assert.equal((await w.http("DELETE", "/mcp-tokens/99999999", b.token)).text, foreign.text, "identical 404");
  assert.ok(await tokens.authenticate(t.secret), "still valid after the refused revoke");
  const r1 = await w.http("DELETE", `/mcp-tokens/${t.id}`, a.token);
  assert.equal(r1.status, 200);
  assert.deepEqual([r1.body.revoked, r1.body.already_revoked], [true, false]);
  assert.equal(await tokens.authenticate(t.secret), null);
  const r2 = await w.http("DELETE", `/mcp-tokens/${t.id}`, a.token);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.already_revoked, true);
  assert.equal(await audits(), 1, "audited once");
  const row = await w.one("SELECT revoked_by FROM api_tokens WHERE id=$1", [t.id]);
  assert.equal(row.revoked_by, a.id);
  // admin revokes someone else's
  const t2 = (await create(w, b, { name: "by-admin" })).body;
  const r3 = await w.http("DELETE", `/mcp-tokens/${t2.id}`, admin.token);
  assert.equal(r3.status, 200);
  assert.equal(await tokens.authenticate(t2.secret), null);
  assert.equal((await w.one("SELECT revoked_by FROM api_tokens WHERE id=$1", [t2.id])).revoked_by, admin.id);
  // the admin sees it as revoked
  assert.equal((await w.http("GET", "/mcp-tokens", admin.token)).body.rows.find((r) => r.id === t2.id).status, "revoked");
  for (const bad of ["abc", "0", "-1", "1.5", "01", "9".repeat(30), "1e3"]) assert.equal((await w.http("DELETE", `/mcp-tokens/${bad}`, a.token)).status, 400, bad);
});

test("audit rows exist for create and revoke and never contain the secret, the random part or the hash", async () => {
  const w = await world();
  const u = await w.mk("Admin");
  const t = (await create(w, u, { name: "audited", days: 5 })).body;
  await w.http("DELETE", `/mcp-tokens/${t.id}`, u.token);
  const rows = (await w.q("SELECT * FROM audit_logs WHERE record_id=$1 AND table_name='api_tokens' ORDER BY id", [t.id])).rows;
  assert.deepEqual(rows.map((r) => r.action), ["mcp.token.create", "mcp.token.revoke"]);
  assert.ok(rows.every((r) => r.user_id === u.id));
  assert.equal(rows[0].new_data.name, "audited");
  assert.equal(rows[0].new_data.prefix, t.prefix);
  const blob = JSON.stringify(rows);
  const hash = crypto.createHash("sha256").update(t.secret).digest("hex");
  assert.ok(!blob.includes(t.secret) && !blob.includes(t.secret.slice(9)) && !blob.includes(hash));
  const all = JSON.stringify((await w.q("SELECT * FROM audit_logs")).rows);
  assert.ok(!all.includes("vita_pat_"), "no PAT-looking string in any audit row");
});

test("a failed creation (cap) is atomic: no token row and no audit row", async () => {
  const w = await world();
  const u = await w.mk("Admin");
  for (let i = 0; i < 5; i++) await create(w, u, { name: `f${i}` });
  const before = (await w.one("SELECT (SELECT count(*) FROM api_tokens)::int AS t, (SELECT count(*) FROM audit_logs WHERE action='mcp.token.create')::int AS a")).t;
  const a0 = (await w.one("SELECT count(*)::int AS a FROM audit_logs WHERE action='mcp.token.create'")).a;
  assert.equal((await create(w, u, { name: "over" })).status, 409);
  const after = await w.one("SELECT (SELECT count(*) FROM api_tokens)::int AS t, (SELECT count(*) FROM audit_logs WHERE action='mcp.token.create')::int AS a");
  assert.equal(after.t, before);
  assert.equal(after.a, a0);
});

// ------------------------------------------------------------------------------------------------ verifyToken refuses PAT bearers
test("verifyToken answers 401 to a vita_pat_ bearer on ordinary routes and never parses it as a JWT", async () => {
  const w = await world();
  const u = await w.mk("Admin");
  const t = (await create(w, u, { name: "sample" })).body;
  const routes = [["GET", "/candidates/all"], ["GET", "/finance/dashboard"], ["GET", "/hr/me"], ["GET", "/chat/conversations"], ["GET", "/jobsearch/auth/me"], ["GET", "/audit-logs"], ["GET", "/notifications/latest"], ["GET", "/alerts/expiring"], ["GET", "/crm/leads"], ["GET", "/mcp-tokens"]];
  const jwtSpy = require("jsonwebtoken");
  const origVerify = jwtSpy.verify;
  let verified = 0;
  jwtSpy.verify = (...a) => {
    verified += 1;
    return origVerify.apply(jwtSpy, a);
  };
  try {
    for (const [m, url] of routes) {
      for (const header of [`Bearer ${t.secret}`, t.secret, `Bearer vita_pat_${"x".repeat(43)}`, "Bearer vita_pat_", "Bearer vita_pat_not.a.jwt"]) {
        const res = await fetch(w.base + url, { method: m, headers: { authorization: header } });
        const text = await res.text();
        assert.equal(res.status, 401, `${m} ${url} with ${header.slice(0, 18)} -> ${res.status}`);
        assert.deepEqual(Object.keys(JSON.parse(text)), ["error"]);
        assert.ok(!text.includes(t.secret));
      }
    }
    assert.equal(verified, 0, "jwt.verify was never called for a PAT bearer");
  } finally {
    jwtSpy.verify = origVerify;
  }
  // control: the owner's JWT works on the same routes
  assert.equal((await w.http("GET", "/candidates/all", u.token)).status, 200);
  assert.equal((await w.http("GET", "/hr/me", u.token)).status, 200);
  // a PAT never authenticates anywhere else, even though it IS a valid PAT
  assert.ok(await tokens.authenticate(t.secret));
  assert.equal(mcpAuth.PAT_PREFIX, "vita_pat_");
});
