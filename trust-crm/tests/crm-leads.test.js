// Task 3: staff lead inbox API (/crm/leads) with role scoping.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "crm-leads-test-secret";

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
  const roles = { admin: "Admin", mgr: "Manager", rec: "Receptionist", agentA: "Agent", agentB: "Agent", acct: "Accountant", hr: "HR", cand: "Candidate" };
  const ids = {};
  for (const [k, role] of Object.entries(roles)) {
    ids[k] = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`${role} ${k}`, `${k}@crm.test.invalid`, role])).id;
  }
  const T = Object.fromEntries(Object.keys(roles).map((k) => [k, jwt.sign({ id: ids[k], role: roles[k], ...(k === "cand" ? { tv: 0 } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" })]));
  let n = 0;
  const lead = async (o = {}) => {
    n += 1;
    return (
      await one(
        `INSERT INTO crm_leads (kind,status,name,email,phone,company,assigned_to,dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [o.kind || "candidate", o.status || "new", o.name || `Lead ${n}`, o.email === undefined ? `l${n}@x.test` : o.email, o.phone || null, o.company || null, o.assignedTo || null, `dk-${n}`]
      )
    ).id;
  };
  try {
    await fn({ pool, q, one, http, ids, T, lead });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

test("role matrix on GET /crm/leads", async () => {
  await withWorld(async (w) => {
    await w.lead();
    for (const k of ["admin", "mgr", "rec", "agentA"]) {
      const r = await w.http("GET", "/crm/leads", w.T[k]);
      assert.equal(r.status, 200, k);
    }
    for (const k of ["acct", "hr", "cand"]) {
      const r = await w.http("GET", "/crm/leads", w.T[k]);
      assert.equal(r.status, 403, k);
    }
    assert.equal((await w.http("GET", "/crm/leads")).status, 401);
    assert.equal((await w.http("GET", `/crm/leads/1`, w.T.acct)).status, 403);
    assert.equal((await w.http("PATCH", `/crm/leads/1`, w.T.hr, { status: "contacted" })).status, 403);
    assert.equal((await w.http("POST", `/crm/leads/1/notes`, w.T.cand, { text: "x" })).status, 403);
  });
});

test("Agent sees only own leads; foreign lead is 404 for GET, PATCH and notes", async () => {
  await withWorld(async (w) => {
    const mine = await w.lead({ assignedTo: w.ids.agentA, name: "Mine" });
    const theirs = await w.lead({ assignedTo: w.ids.agentB, name: "Theirs" });
    const free = await w.lead({ name: "Unassigned" });
    const list = await w.http("GET", "/crm/leads", w.T.agentA);
    assert.deepEqual(list.body.rows.map((r) => r.id), [mine]);
    assert.equal(list.body.total, 1);
    // assignedTo filter cannot widen the scope
    const wide = await w.http("GET", `/crm/leads?assignedTo=${w.ids.agentB}`, w.T.agentA);
    assert.equal(wide.body.total, 0);
    assert.equal((await w.http("GET", `/crm/leads/${mine}`, w.T.agentA)).status, 200);
    for (const id of [theirs, free, 999999]) {
      assert.equal((await w.http("GET", `/crm/leads/${id}`, w.T.agentA)).status, 404, `get ${id}`);
      assert.equal((await w.http("PATCH", `/crm/leads/${id}`, w.T.agentA, { status: "contacted" })).status, 404, `patch ${id}`);
      assert.equal((await w.http("POST", `/crm/leads/${id}/notes`, w.T.agentA, { text: "hi" })).status, 404, `note ${id}`);
    }
    // identical body for missing and foreign (no enumeration signal)
    const a = await w.http("GET", `/crm/leads/${theirs}`, w.T.agentA);
    const b = await w.http("GET", `/crm/leads/999999`, w.T.agentA);
    assert.deepEqual(a.body, b.body);
    // leads:read only => writes against an own lead are 403
    assert.equal((await w.http("PATCH", `/crm/leads/${mine}`, w.T.agentA, { status: "contacted" })).status, 403);
    assert.equal((await w.http("POST", `/crm/leads/${mine}/notes`, w.T.agentA, { text: "hi" })).status, 403);
    assert.equal((await w.q("SELECT count(*)::int n FROM crm_timeline")).rows[0].n, 0);
    // Manager/Receptionist/Admin see all
    for (const k of ["admin", "mgr", "rec"]) assert.equal((await w.http("GET", "/crm/leads", w.T[k])).body.total, 3, k);
  });
});

test("list: spam hidden by default, filters, paging, q escaping, validation, no internal fields", async () => {
  await withWorld(async (w) => {
    await w.lead({ name: "Alice", email: "alice@x.test" });
    await w.lead({ name: "Bob 100%", kind: "employer", company: "Acme_Co" });
    await w.lead({ name: "Boba", kind: "employer", company: "AcmeXCo" });
    await w.lead({ name: "Spammer", status: "spam" });
    await w.q("UPDATE crm_leads SET ip_hash='secret' WHERE name='Alice'");
    const def = await w.http("GET", "/crm/leads", w.T.admin);
    assert.equal(def.body.total, 3);
    assert.ok(!def.body.rows.some((r) => r.status === "spam"));
    assert.ok(def.body.rows.every((r) => !("ip_hash" in r) && !("dedupe_key" in r)));
    const spam = await w.http("GET", "/crm/leads?status=spam", w.T.admin);
    assert.deepEqual(spam.body.rows.map((r) => r.name), ["Spammer"]);
    assert.equal((await w.http("GET", "/crm/leads?kind=employer", w.T.admin)).body.total, 2);
    assert.equal((await w.http("GET", "/crm/leads?q=alice", w.T.admin)).body.total, 1);
    assert.equal((await w.http("GET", "/crm/leads?q=" + encodeURIComponent("100%"), w.T.admin)).body.total, 1);
    assert.equal((await w.http("GET", "/crm/leads?q=" + encodeURIComponent("%"), w.T.admin)).body.total, 1); // literal %, not wildcard
    assert.equal((await w.http("GET", "/crm/leads?q=" + encodeURIComponent("Acme_Co"), w.T.admin)).body.total, 1); // _ is literal
    assert.equal((await w.http("GET", "/crm/leads?q=" + encodeURIComponent("'; DROP TABLE crm_leads;--"), w.T.admin)).body.total, 0);
    const page = await w.http("GET", "/crm/leads?limit=1&offset=1", w.T.admin);
    assert.equal(page.body.rows.length, 1);
    assert.equal(page.body.total, 3);
    assert.equal((await w.http("GET", "/crm/leads?limit=100000", w.T.admin)).status, 200);
    assert.equal((await w.http("GET", "/crm/leads?limit=abc", w.T.admin)).status, 400);
    assert.equal((await w.http("GET", "/crm/leads?status=bogus", w.T.admin)).status, 400);
    assert.equal((await w.http("GET", "/crm/leads?q=a&q=b", w.T.admin)).status, 400);
    assert.equal((await w.http("GET", "/crm/leads?assignedTo=x", w.T.admin)).status, 400);
  });
});

test("invalid id formats are 400 for every role on every route", async () => {
  await withWorld(async (w) => {
    for (const bad of ["abc", "1.5", "-1", "0", "1e3", "99999999999999999999"]) {
      for (const k of ["admin", "agentA"]) {
        assert.equal((await w.http("GET", `/crm/leads/${bad}`, w.T[k])).status, 400, `get ${bad} ${k}`);
        assert.equal((await w.http("PATCH", `/crm/leads/${bad}`, w.T[k], { status: "new" })).status, 400, `patch ${bad} ${k}`);
        assert.equal((await w.http("POST", `/crm/leads/${bad}/notes`, w.T[k], { text: "x" })).status, 400, `note ${bad} ${k}`);
      }
    }
  });
});

test("GET /crm/leads/:id includes the timeline; PATCH status writes timeline + audit", async () => {
  await withWorld(async (w) => {
    const id = await w.lead({ name: "Zed" });
    const p = await w.http("PATCH", `/crm/leads/${id}`, w.T.mgr, { status: "contacted" });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.status, "contacted");
    const same = await w.http("PATCH", `/crm/leads/${id}`, w.T.mgr, { status: "contacted" });
    assert.equal(same.status, 200);
    const tl = (await w.q("SELECT * FROM crm_timeline WHERE entity='lead' AND entity_id=$1", [id])).rows;
    assert.equal(tl.length, 1); // no-op change writes nothing
    assert.equal(tl[0].event, "status_changed");
    assert.deepEqual(tl[0].detail, { from: "new", to: "contacted" });
    assert.equal(tl[0].actor_id, w.ids.mgr);
    const au = (await w.q("SELECT * FROM audit_logs WHERE action='crm.lead.update' AND record_id=$1", [String(id)])).rows;
    assert.equal(au.length, 1);
    assert.equal(au[0].user_id, w.ids.mgr);
    assert.equal(au[0].new_data.status, "contacted");
    const g = await w.http("GET", `/crm/leads/${id}`, w.T.rec);
    assert.equal(g.status, 200);
    assert.equal(g.body.timeline.length, 1);
    assert.equal(g.body.timeline[0].event, "status_changed");
  });
});

test("status validation: converted/unknown refused, converted lead locked, empty patch refused", async () => {
  await withWorld(async (w) => {
    const id = await w.lead();
    for (const s of ["converted", "bogus", "", null, 5, ["new"]]) {
      assert.equal((await w.http("PATCH", `/crm/leads/${id}`, w.T.admin, { status: s })).status, 400, JSON.stringify(s));
    }
    assert.equal((await w.http("PATCH", `/crm/leads/${id}`, w.T.admin, {})).status, 400);
    assert.equal((await w.http("PATCH", `/crm/leads/${id}`, w.T.admin, undefined, "not json")).status, 400);
    for (const s of ["qualified", "rejected", "spam", "new"]) assert.equal((await w.http("PATCH", `/crm/leads/${id}`, w.T.admin, { status: s })).status, 200, s);
    const conv = await w.lead({ status: "converted" });
    assert.equal((await w.http("PATCH", `/crm/leads/${conv}`, w.T.admin, { status: "new" })).status, 409);
    assert.equal((await w.q("SELECT status FROM crm_leads WHERE id=$1", [conv])).rows[0].status, "converted");
    assert.equal((await w.q("SELECT count(*)::int n FROM crm_timeline WHERE entity_id=$1", [conv])).rows[0].n, 0);
  });
});

test("un-spamming into a live duplicate is a clean 409 and writes nothing", async () => {
  await withWorld(async (w) => {
    const live = await w.lead();
    const spam = await w.lead({ status: "spam" });
    await w.q("UPDATE crm_leads SET dedupe_key = (SELECT dedupe_key FROM crm_leads WHERE id=$1) WHERE id=$2", [live, spam]);
    const r = await w.http("PATCH", `/crm/leads/${spam}`, w.T.admin, { status: "new" });
    assert.equal(r.status, 409);
    assert.equal((await w.q("SELECT status FROM crm_leads WHERE id=$1", [spam])).rows[0].status, "spam");
    assert.equal((await w.q("SELECT count(*)::int n FROM crm_timeline")).rows[0].n, 0);
  });
});

test("assigned_to: Admin only, existing active staff user or null", async () => {
  await withWorld(async (w) => {
    const id = await w.lead();
    // Manager/Receptionist have no users:write
    assert.equal((await w.http("PATCH", `/crm/leads/${id}`, w.T.mgr, { assigned_to: w.ids.agentA })).status, 403);
    assert.equal((await w.http("PATCH", `/crm/leads/${id}`, w.T.rec, { assigned_to: w.ids.agentA, status: "contacted" })).status, 403);
    assert.equal((await w.q("SELECT status FROM crm_leads WHERE id=$1", [id])).rows[0].status, "new"); // nothing partially applied
    const ok = await w.http("PATCH", `/crm/leads/${id}`, w.T.admin, { assigned_to: w.ids.agentA });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.assigned_to, w.ids.agentA);
    assert.equal((await w.http("GET", `/crm/leads/${id}`, w.T.agentA)).status, 200); // now visible to the agent
    await w.q("UPDATE users SET is_active=false WHERE id=$1", [w.ids.agentB]);
    for (const bad of [999999, w.ids.cand, w.ids.agentB, "abc", 1.5, -2, true]) {
      assert.equal((await w.http("PATCH", `/crm/leads/${id}`, w.T.admin, { assigned_to: bad })).status, 400, JSON.stringify(bad));
    }
    const un = await w.http("PATCH", `/crm/leads/${id}`, w.T.admin, { assigned_to: null });
    assert.equal(un.status, 200);
    assert.equal(un.body.assigned_to, null);
    const tl = (await w.q("SELECT detail FROM crm_timeline WHERE event='assigned' ORDER BY id")).rows;
    assert.deepEqual(tl.map((r) => r.detail), [{ from: null, to: w.ids.agentA }, { from: w.ids.agentA, to: null }]);
    assert.equal((await w.q("SELECT count(*)::int n FROM audit_logs WHERE action='crm.lead.update'")).rows[0].n, 2);
  });
});

test("review 6: assigned_to must be an active user with one of the /crm/staff roles (Accountant/HR/Candidate: 400)", async () => {
  await withWorld(async (w) => {
    const id = await w.lead();
    const staff = (await w.http("GET", "/crm/staff", w.T.admin)).body.rows.map((r) => r.id);
    for (const k of ["acct", "hr", "cand"]) {
      assert.ok(!staff.includes(w.ids[k]), `${k} is not offered by /crm/staff`);
      const r = await w.http("PATCH", `/crm/leads/${id}`, w.T.admin, { assigned_to: w.ids[k] });
      assert.equal(r.status, 400, k);
    }
    assert.equal((await w.q("SELECT assigned_to FROM crm_leads WHERE id=$1", [id])).rows[0].assigned_to, null);
    for (const k of ["admin", "mgr", "rec", "agentA"]) {
      assert.ok(staff.includes(w.ids[k]), k);
      assert.equal((await w.http("PATCH", `/crm/leads/${id}`, w.T.admin, { assigned_to: w.ids[k] })).status, 200, k);
    }
    const { STAFF_ROLES } = require("../modules/crm/leadsAdmin");
    assert.deepEqual([...STAFF_ROLES].sort(), ["Admin", "Agent", "Manager", "Receptionist", "SuperAdmin"]);
  });
});

test("notes: stored with timeline + audit, 4000-char cap, validation, unicode/html kept as text", async () => {
  await withWorld(async (w) => {
    const id = await w.lead();
    const html = "<script>alert(1)</script> مرحبا";
    const r = await w.http("POST", `/crm/leads/${id}/notes`, w.T.rec, { text: `  ${html}  ` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = (await w.q("SELECT * FROM crm_timeline WHERE entity='lead' AND entity_id=$1 AND event='note'", [id])).rows;
    assert.equal(row.length, 1);
    assert.equal(row[0].detail.text, html);
    assert.equal(row[0].actor_id, w.ids.rec);
    const au = (await w.q("SELECT * FROM audit_logs WHERE action='crm.lead.note' AND record_id=$1", [String(id)])).rows;
    assert.equal(au.length, 1);
    assert.equal((await w.http("POST", `/crm/leads/${id}/notes`, w.T.admin, { text: "a".repeat(4000) })).status, 201);
    for (const t of ["a".repeat(4001), "", "   ", undefined, 5, null, { a: 1 }, "x\u0000y"]) {
      assert.equal((await w.http("POST", `/crm/leads/${id}/notes`, w.T.admin, { text: t })).status, 400, JSON.stringify(t)?.slice(0, 20));
    }
    assert.equal((await w.q("SELECT count(*)::int n FROM crm_timeline WHERE entity_id=$1", [id])).rows[0].n, 2);
    const g = await w.http("GET", `/crm/leads/${id}`, w.T.admin);
    assert.equal(g.body.timeline[0].detail.text, html);
    // insert-only
    await assert.rejects(w.q("UPDATE crm_timeline SET event='x'"));
    await assert.rejects(w.q("DELETE FROM crm_timeline"));
  });
});

test("timeline module: add/list contract", async () => {
  await withWorld(async (w) => {
    const timeline = require("../modules/crm/timeline");
    const id = await w.lead();
    const row = await timeline.add(w.pool, { entity: "lead", entityId: id, actorId: w.ids.admin, event: "custom", detail: { a: 1 } });
    assert.equal(row.event, "custom");
    const list = await timeline.list("lead", id, w.pool);
    assert.equal(list.length, 1);
    assert.equal(list[0].actor_name, "Admin admin");
    await assert.rejects(timeline.add(w.pool, { entity: "bogus", entityId: 1, event: "x" }));
  });
});
