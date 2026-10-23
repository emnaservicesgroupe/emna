// Task 5: staff-published site job offers (/crm/site-jobs) and their public visibility (/public/jobs).
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "crm-sitejobs-test-secret";

async function withWorld(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = (sql, p) => pool.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  const http = async (method, url, token, body, raw) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  };
  const roles = { admin: "Admin", super: "SuperAdmin", mgr: "Manager", rec: "Receptionist", agent: "Agent", acct: "Accountant", hr: "HR", cand: "Candidate" };
  const ids = {};
  for (const [k, role] of Object.entries(roles)) {
    ids[k] = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`${role} ${k}`, `${k}@sj.test.invalid`, role])).id;
  }
  const T = Object.fromEntries(Object.keys(roles).map((k) => [k, jwt.sign({ id: ids[k], role: roles[k], ...(k === "cand" ? { tv: 0 } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" })]));
  const full = (o = {}) => ({
    title: "Welder",
    country: "Germany",
    description: "Weld things.",
    evidence_note: "Employer email 2026-10-01, ref 123",
    ...o,
  });
  try {
    await fn({ pool, q, one, http, ids, T, full });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

const future = () => new Date(Date.now() + 7 * 864e5).toISOString();
const past = () => new Date(Date.now() - 864e5).toISOString();

test("role matrix on /crm/site-jobs", async () => {
  await withWorld(async (w) => {
    for (const k of ["admin", "super", "mgr", "rec"]) {
      assert.equal((await w.http("GET", "/crm/site-jobs", w.T[k])).status, 200, k);
      const c = await w.http("POST", "/crm/site-jobs", w.T[k], w.full());
      assert.equal(c.status, 201, k);
    }
    const id = (await w.one("SELECT id FROM site_jobs LIMIT 1")).id;
    for (const k of ["agent", "acct", "hr", "cand"]) {
      assert.equal((await w.http("GET", "/crm/site-jobs", w.T[k])).status, 403, k);
      assert.equal((await w.http("GET", `/crm/site-jobs/${id}`, w.T[k])).status, 403, k);
      assert.equal((await w.http("POST", "/crm/site-jobs", w.T[k], w.full())).status, 403, k);
      assert.equal((await w.http("PATCH", `/crm/site-jobs/${id}`, w.T[k], { title: "x" })).status, 403, k);
      assert.equal((await w.http("POST", `/crm/site-jobs/${id}/publish`, w.T[k], {})).status, 403, k);
      assert.equal((await w.http("POST", `/crm/site-jobs/${id}/close`, w.T[k], {})).status, 403, k);
    }
    assert.equal((await w.http("GET", "/crm/site-jobs")).status, 401);
    assert.equal((await w.one("SELECT status FROM site_jobs WHERE id=$1", [id])).status, "draft");
  });
});

test("create draft: validation, caps, text verbatim, created_by, timeline + audit", async () => {
  await withWorld(async (w) => {
    const bad = [
      {},
      { title: "" },
      { title: "   " },
      { title: 5 },
      { title: "x".repeat(161) },
      w.full({ description: "x".repeat(8001) }),
      w.full({ requirements: "x".repeat(4001) }),
      w.full({ country: "x".repeat(161) }),
      w.full({ city: "x".repeat(161) }),
      w.full({ evidence_note: "x".repeat(1001) }),
      w.full({ title: "a\u0000b" }),
      w.full({ apply_mode: "carrier_pigeon" }),
      w.full({ apply_mode: "javascript:alert(1)" }),
      w.full({ apply_mode: "ftp://x.test/a" }),
      w.full({ closes_at: "not a date" }),
      w.full({ status: "published" }),
      w.full({ bogus: 1 }),
      w.full({ country: ["a"] }),
    ];
    for (const b of bad) {
      const r = await w.http("POST", "/crm/site-jobs", w.T.admin, b);
      assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80));
    }
    assert.equal((await w.http("POST", "/crm/site-jobs", w.T.admin, undefined, "{bad json")).status, 400);
    assert.equal((await w.one("SELECT count(*)::int n FROM site_jobs")).n, 0);

    const html = '<script>alert(1)</script><b>x</b> & "q"';
    const r = await w.http("POST", "/crm/site-jobs", w.T.rec, w.full({ description: html, apply_mode: "https://apply.example.test/x?a=1", requirements: "r", salary_text: "1000 EUR" }));
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "draft");
    assert.equal(r.body.published_at, null);
    assert.equal(r.body.description, html);
    assert.equal(r.body.created_by, w.ids.rec);
    const row = await w.one("SELECT * FROM site_jobs WHERE id=$1", [r.body.id]);
    assert.equal(row.description, html);
    const tl = await w.q("SELECT * FROM crm_timeline WHERE entity='site_job' AND entity_id=$1", [r.body.id]);
    assert.deepEqual(tl.rows.map((t) => t.event), ["created"]);
    assert.equal(tl.rows[0].actor_id, w.ids.rec);
    const au = await w.q("SELECT * FROM audit_logs WHERE action='crm.site_job.create' AND record_id=$1", [String(r.body.id)]);
    assert.equal(au.rowCount, 1);
    assert.equal(au.rows[0].user_id, w.ids.rec);
    // draft is not public
    const pub = await w.http("GET", "/public/jobs");
    assert.deepEqual(pub.body.jobs, []);
  });
});

test("publish refusals: missing evidence/title/country/description, past closes_at; nothing changes", async () => {
  await withWorld(async (w) => {
    const mk = async (o) => (await w.http("POST", "/crm/site-jobs", w.T.admin, w.full(o))).body.id;
    const cases = [
      await mk({ evidence_note: undefined }),
      await mk({ evidence_note: "   " }),
      await mk({ country: undefined }),
      await mk({ description: undefined }),
      await mk({ description: "  " }),
      await mk({ closes_at: past() }),
    ];
    for (const id of cases) {
      const r = await w.http("POST", `/crm/site-jobs/${id}/publish`, w.T.admin, {});
      assert.equal(r.status, 400, String(id));
      const row = await w.one("SELECT status, published_at FROM site_jobs WHERE id=$1", [id]);
      assert.equal(row.status, "draft");
      assert.equal(row.published_at, null);
      const au = await w.q("SELECT 1 FROM audit_logs WHERE action='crm.site_job.publish' AND record_id=$1", [String(id)]);
      assert.equal(au.rowCount, 0);
    }
    assert.deepEqual((await w.http("GET", "/public/jobs")).body.jobs, []);
  });
});

test("publish -> visible with allowlisted keys only; close -> gone immediately; republish 409", async () => {
  await withWorld(async (w) => {
    const c = await w.http("POST", "/crm/site-jobs", w.T.mgr, w.full({ employer_name: "ACME", city: "Berlin", category: "Construction", requirements: "R", language_requirements: "DE B1", employment_type: "full_time", salary_text: "2500 EUR", apply_mode: "contact_staff", closes_at: future() }));
    const id = c.body.id;
    const p = await w.http("POST", `/crm/site-jobs/${id}/publish`, w.T.rec, {});
    assert.equal(p.status, 200);
    assert.equal(p.body.status, "published");
    assert.ok(p.body.published_at);

    const list = await w.http("GET", "/public/jobs");
    assert.equal(list.body.jobs.length, 1);
    const keys = Object.keys(list.body.jobs[0]).sort();
    assert.deepEqual(keys, ["apply_mode", "category", "city", "closes_at", "country", "description", "employer_name", "employment_type", "id", "language_requirements", "published_at", "requirements", "salary_text", "title"]);
    assert.equal((await w.http("GET", `/public/jobs/${id}`)).status, 200);
    assert.ok(!JSON.stringify(list.body).includes("Employer email"));

    // publishing again: 409
    assert.equal((await w.http("POST", `/crm/site-jobs/${id}/publish`, w.T.admin, {})).status, 409);

    const cl = await w.http("POST", `/crm/site-jobs/${id}/close`, w.T.admin, {});
    assert.equal(cl.status, 200);
    assert.equal(cl.body.status, "closed");
    assert.deepEqual((await w.http("GET", "/public/jobs")).body.jobs, []);
    assert.equal((await w.http("GET", `/public/jobs/${id}`)).status, 404);

    assert.equal((await w.http("POST", `/crm/site-jobs/${id}/publish`, w.T.admin, {})).status, 409);
    assert.equal((await w.http("POST", `/crm/site-jobs/${id}/close`, w.T.admin, {})).status, 409);
    assert.equal((await w.http("PATCH", `/crm/site-jobs/${id}`, w.T.admin, { title: "again" })).status, 409);
    assert.equal((await w.one("SELECT status FROM site_jobs WHERE id=$1", [id])).status, "closed");

    // draft cannot be closed
    const d = (await w.http("POST", "/crm/site-jobs", w.T.admin, w.full())).body.id;
    assert.equal((await w.http("POST", `/crm/site-jobs/${d}/close`, w.T.admin, {})).status, 409);

    const tl = await w.q("SELECT event FROM crm_timeline WHERE entity='site_job' AND entity_id=$1 ORDER BY id", [id]);
    assert.deepEqual(tl.rows.map((t) => t.event), ["created", "published", "closed"]);
    for (const a of ["publish", "close"]) {
      const au = await w.q("SELECT * FROM audit_logs WHERE action=$1 AND record_id=$2", [`crm.site_job.${a}`, String(id)]);
      assert.equal(au.rowCount, 1, a);
    }
  });
});

test("edit published job: allowed + audited, still validated; draft edits; empty patch 400; status not patchable", async () => {
  await withWorld(async (w) => {
    const id = (await w.http("POST", "/crm/site-jobs", w.T.admin, w.full())).body.id;
    assert.equal((await w.http("PATCH", `/crm/site-jobs/${id}`, w.T.admin, {})).status, 400);
    assert.equal((await w.http("PATCH", `/crm/site-jobs/${id}`, w.T.admin, { status: "published" })).status, 400);
    assert.equal((await w.http("PATCH", `/crm/site-jobs/${id}`, w.T.admin, { published_at: future() })).status, 400);
    const e1 = await w.http("PATCH", `/crm/site-jobs/${id}`, w.T.rec, { city: "Hamburg" });
    assert.equal(e1.status, 200);
    assert.equal(e1.body.city, "Hamburg");
    // draft may be cleared of required fields; publish then refuses
    assert.equal((await w.http("PATCH", `/crm/site-jobs/${id}`, w.T.rec, { evidence_note: null })).status, 200);
    assert.equal((await w.http("POST", `/crm/site-jobs/${id}/publish`, w.T.admin, {})).status, 400);
    assert.equal((await w.http("PATCH", `/crm/site-jobs/${id}`, w.T.rec, { evidence_note: "doc ref 9" })).status, 200);
    assert.equal((await w.http("POST", `/crm/site-jobs/${id}/publish`, w.T.admin, {})).status, 200);

    const e2 = await w.http("PATCH", `/crm/site-jobs/${id}`, w.T.mgr, { salary_text: "3000 EUR" });
    assert.equal(e2.status, 200);
    assert.equal((await w.http("GET", `/public/jobs/${id}`)).body.salary_text, "3000 EUR");
    // published job must stay publishable
    for (const patch of [{ title: null }, { country: "" }, { description: " " }, { evidence_note: null }, { closes_at: past() }, { description: "x".repeat(8001) }]) {
      assert.equal((await w.http("PATCH", `/crm/site-jobs/${id}`, w.T.admin, patch)).status, 400, JSON.stringify(patch).slice(0, 50));
    }
    assert.equal((await w.one("SELECT title FROM site_jobs WHERE id=$1", [id])).title, "Welder");
    const au = await w.q("SELECT * FROM audit_logs WHERE action='crm.site_job.update' AND record_id=$1", [String(id)]);
    assert.ok(au.rowCount >= 4);
    const last = au.rows[au.rowCount - 1];
    assert.equal(last.user_id, w.ids.mgr);
    const ev = await w.q("SELECT event, detail FROM crm_timeline WHERE entity='site_job' AND entity_id=$1 AND event='updated' ORDER BY id DESC LIMIT 1", [id]);
    assert.deepEqual(ev.rows[0].detail.fields, ["salary_text"]);
  });
});

test("closes_at in the past makes a published job disappear without closing it", async () => {
  await withWorld(async (w) => {
    const id = (await w.http("POST", "/crm/site-jobs", w.T.admin, w.full({ closes_at: future() }))).body.id;
    assert.equal((await w.http("POST", `/crm/site-jobs/${id}/publish`, w.T.admin, {})).status, 200);
    await w.q("UPDATE site_jobs SET closes_at = now() - interval '1 minute' WHERE id=$1", [id]);
    assert.deepEqual((await w.http("GET", "/public/jobs")).body.jobs, []);
  });
});

test("list/get: filters, paging, staff fields visible, timeline on detail", async () => {
  await withWorld(async (w) => {
    const a = (await w.http("POST", "/crm/site-jobs", w.T.admin, w.full({ title: "A" }))).body.id;
    const b = (await w.http("POST", "/crm/site-jobs", w.T.admin, w.full({ title: "B" }))).body.id;
    await w.http("POST", `/crm/site-jobs/${b}/publish`, w.T.admin, {});
    const all = await w.http("GET", "/crm/site-jobs", w.T.rec);
    assert.equal(all.body.total, 2);
    assert.equal(all.body.rows.length, 2);
    assert.ok("evidence_note" in all.body.rows[0]);
    const pubOnly = await w.http("GET", "/crm/site-jobs?status=published", w.T.rec);
    assert.deepEqual(pubOnly.body.rows.map((r) => r.id), [b]);
    assert.equal((await w.http("GET", "/crm/site-jobs?status=bogus", w.T.rec)).status, 400);
    assert.equal((await w.http("GET", "/crm/site-jobs?status=draft&status=published", w.T.rec)).status, 400);
    assert.equal((await w.http("GET", "/crm/site-jobs?limit=1", w.T.rec)).body.rows.length, 1);
    assert.equal((await w.http("GET", "/crm/site-jobs?limit=0", w.T.rec)).status, 400);
    const one = await w.http("GET", `/crm/site-jobs/${a}`, w.T.rec);
    assert.equal(one.status, 200);
    assert.equal(one.body.title, "A");
    assert.deepEqual(one.body.timeline.map((t) => t.event), ["created"]);
    assert.equal((await w.http("GET", "/crm/site-jobs/999999", w.T.rec)).status, 404);
  });
});

test("invalid ids are 400, unknown ids 404, on every id route", async () => {
  await withWorld(async (w) => {
    for (const bad of ["abc", "0", "-1", "1.5", "1e3", "99999999999999999999"]) {
      assert.equal((await w.http("GET", `/crm/site-jobs/${bad}`, w.T.admin)).status, 400, bad);
      assert.equal((await w.http("PATCH", `/crm/site-jobs/${bad}`, w.T.admin, { title: "x" })).status, 400, bad);
      assert.equal((await w.http("POST", `/crm/site-jobs/${bad}/publish`, w.T.admin, {})).status, 400, bad);
      assert.equal((await w.http("POST", `/crm/site-jobs/${bad}/close`, w.T.admin, {})).status, 400, bad);
    }
    assert.equal((await w.http("PATCH", "/crm/site-jobs/123456", w.T.admin, { title: "x" })).status, 404);
    assert.equal((await w.http("POST", "/crm/site-jobs/123456/publish", w.T.admin, {})).status, 404);
    assert.equal((await w.http("POST", "/crm/site-jobs/123456/close", w.T.admin, {})).status, 404);
  });
});

test("apply_mode: keywords and http(s) URLs accepted", async () => {
  await withWorld(async (w) => {
    for (const m of ["contact_staff", "register", "http://a.test/x", "https://a.test/x", null]) {
      assert.equal((await w.http("POST", "/crm/site-jobs", w.T.admin, w.full({ apply_mode: m }))).status, 201, String(m));
    }
  });
});

test("evidence_note allows up to 1000 characters; other short text fields stay capped at 160", async () => {
  await withWorld(async (w) => {
    const ok = await w.http("POST", "/crm/site-jobs", w.T.admin, w.full({ evidence_note: "e".repeat(1000) }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.evidence_note.length, 1000);
    assert.equal((await w.http("POST", "/crm/site-jobs", w.T.admin, w.full({ evidence_note: "e".repeat(1001) }))).status, 400);
    assert.equal((await w.http("PATCH", `/crm/site-jobs/${ok.body.id}`, w.T.admin, { evidence_note: "e".repeat(1001) })).status, 400);
    assert.equal((await w.http("PATCH", `/crm/site-jobs/${ok.body.id}`, w.T.admin, { evidence_note: "f".repeat(161) })).status, 200);
    assert.equal((await w.http("POST", "/crm/site-jobs", w.T.admin, w.full({ city: "c".repeat(161) }))).status, 400);
    assert.equal((await w.http("POST", "/crm/site-jobs", w.T.admin, w.full({ salary_text: "s".repeat(161) }))).status, 400);
  });
});
