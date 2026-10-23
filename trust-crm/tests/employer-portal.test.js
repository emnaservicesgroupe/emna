const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser, portalToken } = require("./helpers/orgs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "employer-portal-test-secret";

const EXPOSED = ["id", "title", "positions", "country", "city", "category", "description", "requirements", "salary_text", "start_date", "status", "employer_visible_note", "created_at", "updated_at"].sort();
const VALID = { title: "Welders", positions: 3, country: "Germany", description: "Weld things" };

async function withApp(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, token, raw } = {}) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(base + path, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
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
    await fn({ pool, call });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
  }
}

test("auth: only an Employer token passes; staff, Candidate, Agency, anonymous and bad tokens are denied", () =>
  withApp(async ({ pool, call }) => {
    const e = await createEmployerUser(pool, { orgName: "Acme" });
    const ag = await createAgencyUser(pool);
    const staff = (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('S','s@t.invalid','x','SuperAdmin') RETURNING id")).rows[0].id;
    const cand = (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('C','c@t.invalid','x','Candidate') RETURNING id")).rows[0].id;
    const tok = (id, role, tv) => jwt.sign({ id, role, ...(tv === undefined ? {} : { tv }) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    for (const [path, method] of [["/employer/me", "GET"], ["/employer/requests", "GET"], ["/employer/requests", "POST"], ["/employer/requests/1", "GET"], ["/employer/requests/1", "PATCH"], ["/employer/requests/1/cancel", "POST"]]) {
      const body = method === "GET" ? undefined : VALID;
      assert.equal((await call(method, path, { body })).status, 401, `anon ${method} ${path}`);
      assert.equal((await call(method, path, { body, token: "garbage" })).status, 400);
      for (const t of [tok(staff, "SuperAdmin"), tok(cand, "Candidate", 0), ag.token, tok(e.userId, "Employer")]) {
        const r = await call(method, path, { body, token: t });
        assert.ok([401, 403].includes(r.status), `${method} ${path} -> ${r.status}`);
      }
    }
    assert.equal((await call("GET", "/employer/me", { token: e.token })).status, 200);
  }));

test("GET /employer/me exposes only role and org contact fields", () =>
  withApp(async ({ pool, call }) => {
    const e = await createEmployerUser(pool, { orgName: "Acme" });
    await pool.query("UPDATE crm_employers SET contact_name='Bob', email='b@acme.invalid', phone='123', country='DE', sector='x', notes='INTERNAL NOTE' WHERE id=$1", [e.orgId]);
    const r = await call("GET", "/employer/me", { token: e.token });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["org", "role"]);
    assert.equal(r.body.role, "Employer");
    assert.deepEqual(Object.keys(r.body.org).sort(), ["contact_name", "country", "email", "id", "name", "phone", "sector"]);
    assert.equal(r.body.org.name, "Acme");
    assert.ok(!r.text.includes("INTERNAL NOTE"));
  }));

test("create: forced submitted status, exposed key set, timeline + audit written, org from the link", () =>
  withApp(async ({ pool, call }) => {
    const a = await createEmployerUser(pool);
    const b = await createEmployerUser(pool);
    const r = await call("POST", "/employer/requests", { token: a.token, body: { ...VALID, city: "Berlin", category: "metal", requirements: "r", salary_text: "2000", start_date: "2027-01-31" } });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(Object.keys(r.body).sort(), EXPOSED);
    assert.equal(r.body.status, "submitted");
    assert.equal(r.body.start_date, "2027-01-31");
    const row = (await pool.query("SELECT * FROM employer_requests WHERE id=$1", [r.body.id])).rows[0];
    assert.equal(Number(row.employer_id), a.orgId);
    const tl = (await pool.query("SELECT * FROM crm_timeline WHERE entity='employer_request' AND entity_id=$1", [r.body.id])).rows;
    assert.equal(tl.length, 1);
    assert.equal(tl[0].actor_id, a.userId);
    const au = (await pool.query("SELECT * FROM audit_logs WHERE table_name='employer_requests' AND record_id=$1", [String(r.body.id)])).rows;
    assert.equal(au.length, 1);
    assert.equal(au[0].user_id, a.userId);
    // defaults
    const d = await call("POST", "/employer/requests", { token: a.token, body: VALID && { title: "T", country: "FR", description: "d" } });
    assert.equal(d.body.positions, 1);
    assert.equal(d.body.start_date, null);
    // input cannot choose the org / status / notes
    for (const extra of [{ employer_id: b.orgId }, { status: "accepted" }, { staff_note: "x" }, { site_job_id: 1 }, { id: 5 }, { bogus: 1 }]) {
      const x = await call("POST", "/employer/requests", { token: a.token, body: { ...VALID, ...extra } });
      assert.equal(x.status, 400, JSON.stringify(extra));
    }
    const q = await call("POST", "/employer/requests?employer_id=" + b.orgId, { token: a.token, body: VALID });
    assert.equal(q.status, 201);
    assert.equal(Number((await pool.query("SELECT employer_id FROM employer_requests WHERE id=$1", [q.body.id])).rows[0].employer_id), a.orgId);
    const lq = await call("GET", "/employer/requests?employer_id=" + b.orgId, { token: a.token });
    assert.equal(lq.status, 200);
    assert.ok(lq.body.requests.every((x) => x.id));
    assert.equal(lq.body.requests.length, 3);
    assert.equal((await call("GET", "/employer/requests", { token: b.token })).body.requests.length, 0);
  }));

test("field validation", () =>
  withApp(async ({ pool, call }) => {
    const a = await createEmployerUser(pool);
    const post = (body) => call("POST", "/employer/requests", { token: a.token, body });
    const bad = [
      { ...VALID, title: undefined },
      { ...VALID, title: "   " },
      { ...VALID, title: "x".repeat(161) },
      { ...VALID, title: 5 },
      { ...VALID, positions: 0 },
      { ...VALID, positions: 1001 },
      { ...VALID, positions: 1.5 },
      { ...VALID, positions: "3" },
      { ...VALID, positions: null },
      { ...VALID, country: undefined },
      { ...VALID, country: "" },
      { ...VALID, description: undefined },
      { ...VALID, description: "x".repeat(8001) },
      { ...VALID, requirements: "x".repeat(4001) },
      { ...VALID, city: "x".repeat(161) },
      { ...VALID, category: "x".repeat(161) },
      { ...VALID, salary_text: "x".repeat(161) },
      { ...VALID, start_date: "2027-02-30" },
      { ...VALID, start_date: "tomorrow" },
      { ...VALID, start_date: 20270101 },
      { ...VALID, title: "a\u0000b" },
      { ...VALID, city: { a: 1 } },
    ];
    for (const b of bad) assert.equal((await post(b)).status, 400, JSON.stringify(b).slice(0, 120));
    assert.equal((await post(["x"])).status, 400);
    assert.equal((await post("x")).status, 400);
    assert.equal((await call("POST", "/employer/requests", { token: a.token, raw: "{bad" })).status, 400);
    assert.equal((await post({ ...VALID, title: "x".repeat(160), description: "x".repeat(8000), requirements: "y".repeat(4000), positions: 1000 })).status, 201);
    assert.equal((await post({ ...VALID, start_date: null, city: null, requirements: null })).status, 201);
    assert.equal((await pool.query("SELECT count(*)::int n FROM employer_requests")).rows[0].n, 2);
  }));

test("oversized body => 413 without echoing it; HTML stored verbatim", () =>
  withApp(async ({ pool, call }) => {
    const a = await createEmployerUser(pool);
    const marker = "ZZMARKERZZ";
    const big = await call("POST", "/employer/requests", { token: a.token, body: { ...VALID, description: marker + "x".repeat(20000) } });
    assert.equal(big.status, 413);
    assert.ok(!big.text.includes(marker));
    const html = `<script>alert(1)</script> & "q" <b>`;
    const r = await call("POST", "/employer/requests", { token: a.token, body: { ...VALID, title: html, description: html } });
    assert.equal(r.status, 201);
    assert.equal(r.body.title, html);
    const g = await call("GET", `/employer/requests/${r.body.id}`, { token: a.token });
    assert.equal(g.body.description, html);
    assert.equal((await pool.query("SELECT title FROM employer_requests WHERE id=$1", [r.body.id])).rows[0].title, html);
  }));

test("isolation: employer A cannot read, patch or cancel B's request; response identical to a missing id", () =>
  withApp(async ({ pool, call }) => {
    const a = await createEmployerUser(pool);
    const b = await createEmployerUser(pool);
    const rb = await call("POST", "/employer/requests", { token: b.token, body: VALID });
    const id = rb.body.id;
    const missing = id + 1000;
    for (const [method, suffix, body] of [["GET", "", undefined], ["PATCH", "", { title: "hijack" }], ["POST", "/cancel", {}]]) {
      const foreign = await call(method, `/employer/requests/${id}${suffix}`, { token: a.token, body });
      const gone = await call(method, `/employer/requests/${missing}${suffix}`, { token: a.token, body });
      assert.equal(foreign.status, 404);
      assert.equal(foreign.status, gone.status);
      assert.equal(foreign.text, gone.text);
    }
    const row = (await pool.query("SELECT title, status FROM employer_requests WHERE id=$1", [id])).rows[0];
    assert.deepEqual(row, { title: VALID.title, status: "submitted" });
    assert.equal((await call("GET", "/employer/requests", { token: a.token })).body.requests.length, 0);
  }));

test("suspended organisation => denied immediately with an existing token; missing org link => denied", () =>
  withApp(async ({ pool, call }) => {
    const a = await createEmployerUser(pool);
    assert.equal((await call("GET", "/employer/me", { token: a.token })).status, 200);
    await pool.query("UPDATE crm_employers SET status='suspended' WHERE id=$1", [a.orgId]);
    for (const [m, p, b] of [["GET", "/employer/me"], ["GET", "/employer/requests"], ["POST", "/employer/requests", VALID]]) {
      const r = await call(m, p, { token: a.token, body: b });
      assert.ok([401, 403].includes(r.status), `${p} ${r.status}`);
    }
    await pool.query("UPDATE crm_employers SET status='active' WHERE id=$1", [a.orgId]);
    await pool.query("DELETE FROM crm_org_accounts WHERE user_id=$1", [a.userId]);
    assert.ok([401, 403].includes((await call("GET", "/employer/me", { token: a.token })).status));
  }));

test("staff_note and site_job_id never leak; employer_visible_note does", () =>
  withApp(async ({ pool, call }) => {
    const a = await createEmployerUser(pool);
    const r = await call("POST", "/employer/requests", { token: a.token, body: VALID });
    await pool.query("UPDATE employer_requests SET staff_note='SECRET-STAFF', employer_visible_note='hello employer', status='in_review' WHERE id=$1", [r.body.id]);
    const sj = (await pool.query("INSERT INTO site_jobs (title) VALUES ('SJ') RETURNING id")).rows[0].id;
    await pool.query("UPDATE employer_requests SET site_job_id=$2 WHERE id=$1", [r.body.id, sj]);
    for (const p of [`/employer/requests/${r.body.id}`, "/employer/requests"]) {
      const g = await call("GET", p, { token: a.token });
      assert.ok(!g.text.includes("SECRET-STAFF"));
      assert.ok(!/staff_note|site_job_id/.test(g.text));
      assert.ok(g.text.includes("hello employer"));
      const obj = g.body.requests ? g.body.requests[0] : g.body;
      assert.deepEqual(Object.keys(obj).sort(), EXPOSED);
    }
    const c = await call("POST", `/employer/requests/${r.body.id}/cancel`, { token: a.token, body: {} });
    assert.ok(!/staff_note|site_job_id|SECRET-STAFF/.test(c.text));
  }));

test("PATCH: allowed only while submitted (409 after in_review); unknown fields 400; partial update; timeline + audit", () =>
  withApp(async ({ pool, call }) => {
    const a = await createEmployerUser(pool);
    const r = await call("POST", "/employer/requests", { token: a.token, body: { ...VALID, city: "Berlin" } });
    const url = `/employer/requests/${r.body.id}`;
    for (const extra of [{ status: "accepted" }, { staff_note: "x" }, { employer_visible_note: "x" }, { employer_id: 1 }, { site_job_id: 1 }, { id: 3 }]) {
      assert.equal((await call("PATCH", url, { token: a.token, body: { title: "ok", ...extra } })).status, 400, JSON.stringify(extra));
    }
    assert.equal((await call("PATCH", url, { token: a.token, body: {} })).status, 400);
    assert.equal((await call("PATCH", url, { token: a.token, body: { title: "" } })).status, 400);
    assert.equal((await call("PATCH", url, { token: a.token, body: { positions: 0 } })).status, 400);
    assert.equal((await call("PATCH", url, { token: a.token, body: { country: null } })).status, 400);
    const p = await call("PATCH", url, { token: a.token, body: { title: "New title", city: null, positions: 7 } });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.body.title, "New title");
    assert.equal(p.body.city, null);
    assert.equal(p.body.positions, 7);
    assert.equal(p.body.description, VALID.description);
    assert.equal(p.body.status, "submitted");
    assert.equal((await pool.query("SELECT count(*)::int n FROM crm_timeline WHERE entity='employer_request' AND entity_id=$1", [r.body.id])).rows[0].n, 2);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE table_name='employer_requests' AND record_id=$1", [String(r.body.id)])).rows[0].n, 2);
    await pool.query("UPDATE employer_requests SET status='in_review' WHERE id=$1", [r.body.id]);
    const late = await call("PATCH", url, { token: a.token, body: { title: "late" } });
    assert.equal(late.status, 409);
    assert.equal((await pool.query("SELECT title FROM employer_requests WHERE id=$1", [r.body.id])).rows[0].title, "New title");
  }));

test("cancel: submitted and in_review only; idempotence refused; timeline + audit", () =>
  withApp(async ({ pool, call }) => {
    const a = await createEmployerUser(pool);
    const mk = async () => (await call("POST", "/employer/requests", { token: a.token, body: VALID })).body.id;
    const id1 = await mk();
    const c1 = await call("POST", `/employer/requests/${id1}/cancel`, { token: a.token, body: {} });
    assert.equal(c1.status, 200);
    assert.equal(c1.body.status, "cancelled");
    assert.equal((await call("POST", `/employer/requests/${id1}/cancel`, { token: a.token, body: {} })).status, 409);
    assert.equal((await call("PATCH", `/employer/requests/${id1}`, { token: a.token, body: { title: "x" } })).status, 409);
    const id2 = await mk();
    await pool.query("UPDATE employer_requests SET status='in_review' WHERE id=$1", [id2]);
    assert.equal((await call("POST", `/employer/requests/${id2}/cancel`, { token: a.token, body: {} })).status, 200);
    for (const st of ["accepted", "declined", "filled"]) {
      const id = await mk();
      await pool.query("UPDATE employer_requests SET status=$2 WHERE id=$1", [id, st]);
      assert.equal((await call("POST", `/employer/requests/${id}/cancel`, { token: a.token, body: {} })).status, 409, st);
      assert.equal((await pool.query("SELECT status FROM employer_requests WHERE id=$1", [id])).rows[0].status, st);
    }
    const ev = (await pool.query("SELECT event FROM crm_timeline WHERE entity='employer_request' AND entity_id=$1 ORDER BY id", [id1])).rows.map((r) => r.event);
    assert.deepEqual(ev, ["created", "cancelled"]);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE table_name='employer_requests' AND record_id=$1", [String(id1)])).rows[0].n, 2);
  }));

test("malformed ids => 400 on every id route", () =>
  withApp(async ({ pool, call }) => {
    const a = await createEmployerUser(pool);
    for (const id of ["abc", "0", "-1", "1.5", "1e3", "01x", "9".repeat(30), "%20", "1;2", "0x10"]) {
      for (const [m, s, b] of [["GET", "", undefined], ["PATCH", "", { title: "x" }], ["POST", "/cancel", {}]]) {
        const r = await call(m, `/employer/requests/${id}${s}`, { token: a.token, body: b });
        assert.equal(r.status, 400, `${m} ${id} -> ${r.status}`);
      }
    }
  }));

test("daily cap EMPLOYER_REQUESTS_PER_DAY (default 20) => 429, per employer", () =>
  withApp(async ({ pool, call }) => {
    const a = await createEmployerUser(pool);
    const b = await createEmployerUser(pool);
    process.env.EMPLOYER_REQUESTS_PER_DAY = "3";
    try {
      for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/employer/requests", { token: a.token, body: VALID })).status, 201);
      const over = await call("POST", "/employer/requests", { token: a.token, body: VALID });
      assert.equal(over.status, 429);
      assert.equal((await call("POST", "/employer/requests", { token: b.token, body: VALID })).status, 201);
      // cancelled requests still count (no cap evasion by cancel/recreate)
      const first = (await pool.query("SELECT id FROM employer_requests WHERE employer_id=$1 LIMIT 1", [a.orgId])).rows[0].id;
      await call("POST", `/employer/requests/${first}/cancel`, { token: a.token, body: {} });
      assert.equal((await call("POST", "/employer/requests", { token: a.token, body: VALID })).status, 429);
      // old rows fall out of the window
      await pool.query("UPDATE employer_requests SET created_at = now() - interval '25 hours' WHERE employer_id=$1", [a.orgId]);
      assert.equal((await call("POST", "/employer/requests", { token: a.token, body: VALID })).status, 201);
      delete process.env.EMPLOYER_REQUESTS_PER_DAY;
      const cap = require("../modules/orgs/employerRequests").dailyCap();
      assert.equal(cap, 20);
    } finally {
      delete process.env.EMPLOYER_REQUESTS_PER_DAY;
    }
  }));

test("list paging and bad paging params", () =>
  withApp(async ({ pool, call }) => {
    const a = await createEmployerUser(pool);
    for (let i = 0; i < 5; i++) await call("POST", "/employer/requests", { token: a.token, body: { ...VALID, title: `T${i}` } });
    const p1 = await call("GET", "/employer/requests?limit=2&offset=0", { token: a.token });
    const p2 = await call("GET", "/employer/requests?limit=2&offset=2", { token: a.token });
    assert.equal(p1.body.requests.length, 2);
    assert.equal(p2.body.requests.length, 2);
    assert.equal(p1.body.total, 5);
    assert.deepEqual(p1.body.requests.map((r) => r.title), ["T4", "T3"]);
    assert.deepEqual(p2.body.requests.map((r) => r.title), ["T2", "T1"]);
    for (const q of ["limit=0", "limit=101", "limit=x", "offset=-1", "offset=1.5", "limit=1&limit=2"]) {
      assert.equal((await call("GET", `/employer/requests?${q}`, { token: a.token })).status, 400, q);
    }
  }));

test("portalToken helper signs a versioned token", () => {
  const t = jwt.verify(portalToken(5, "Employer"), process.env.JWT_SECRET);
  assert.equal(t.tv, 0);
});
