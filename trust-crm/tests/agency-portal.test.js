const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "agency-portal-test-secret";

const LIST_KEYS = ["country", "created_at", "full_name", "id", "profession", "stage", "status_text"].sort();
const INTERNAL = ["ip_hash", "dedupe_key", "assigned_to", "notes", "duplicate_of", "duplicate_candidate_id", "passport", "agency_id", "consent"];
let n = 0;
const body = (o = {}) => {
  n += 1;
  return { full_name: `Cand ${n}`, email: `cand${n}-${process.pid}@test.invalid`, profession: "Welder", country: "Tunisia", consent_attested: true, ...o };
};

async function withApp(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body: b, token, raw } = {}) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(base + path, { method, headers, body: raw !== undefined ? raw : b === undefined ? undefined : JSON.stringify(b) });
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

const noInternal = (r) => {
  for (const k of INTERNAL) assert.ok(!r.text.includes(`"${k}"`), `response leaks ${k}`);
};

test("auth: only an Agency token passes /agency/*", () =>
  withApp(async ({ pool, call }) => {
    const ag = await createAgencyUser(pool);
    const emp = await createEmployerUser(pool);
    const staff = (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('S','s@t.invalid','x','SuperAdmin') RETURNING id")).rows[0].id;
    const cand = (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('C','c@t.invalid','x','Candidate') RETURNING id")).rows[0].id;
    const tok = (id, role, tv) => jwt.sign({ id, role, ...(tv === undefined ? {} : { tv }) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    for (const [method, path] of [["GET", "/agency/me"], ["GET", "/agency/candidates"], ["POST", "/agency/candidates"], ["GET", "/agency/candidates/1"]]) {
      const b = method === "POST" ? body() : undefined;
      assert.equal((await call(method, path, { body: b })).status, 401, `anon ${path}`);
      assert.equal((await call(method, path, { body: b, token: "garbage" })).status, 400);
      for (const t of [tok(staff, "SuperAdmin"), tok(cand, "Candidate", 0), emp.token]) {
        const r = await call(method, path, { body: b, token: t });
        assert.ok([401, 403].includes(r.status), `${method} ${path} -> ${r.status}`);
      }
    }
    assert.equal((await pool.query("SELECT count(*)::int n FROM crm_leads")).rows[0].n, 0);
    const me = await call("GET", "/agency/me", { token: ag.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.role, "Agency");
    noInternal(me);
  }));

test("suspended agency: token is dead on every route", () =>
  withApp(async ({ pool, call }) => {
    const ag = await createAgencyUser(pool);
    assert.equal((await call("POST", "/agency/candidates", { token: ag.token, body: body() })).status, 201);
    await pool.query("UPDATE crm_agencies SET status='suspended' WHERE id=$1", [ag.orgId]);
    for (const [m, p] of [["GET", "/agency/me"], ["GET", "/agency/candidates"], ["POST", "/agency/candidates"], ["GET", "/agency/candidates/1"]]) {
      const r = await call(m, p, { token: ag.token, body: m === "POST" ? body() : undefined });
      assert.ok([401, 403].includes(r.status), `${p} -> ${r.status}`);
    }
  }));

test("create: stores a staff-visible lead tied to the token's agency with consent recorded", () =>
  withApp(async ({ pool, call }) => {
    const ag = await createAgencyUser(pool);
    const other = await createAgencyUser(pool);
    const r = await call("POST", "/agency/candidates", { token: ag.token, body: { ...body({ phone: "+216 55 123 456", message: "hi" }), agency_id: other.orgId } });
    // client-supplied agency_id is an unknown field
    assert.equal(r.status, 400);
    const ok = await call("POST", "/agency/candidates", { token: ag.token, body: body({ email: "Mixed.Case@Test.INVALID", phone: "+216 55 123 456", message: "hi", passport_number: "ab-123 456" }) });
    assert.equal(ok.status, 201);
    assert.deepEqual(Object.keys(ok.body).sort(), ["id", "ok"]);
    assert.equal(ok.body.ok, true);
    const l = (await pool.query("SELECT * FROM crm_leads WHERE id=$1", [ok.body.id])).rows[0];
    assert.equal(l.kind, "candidate");
    assert.equal(l.source, "agency");
    assert.equal(l.status, "new");
    assert.equal(String(l.agency_id), String(ag.orgId));
    assert.equal(l.email, "mixed.case@test.invalid");
    assert.ok(l.consent_at);
    assert.equal(l.consent_text_version, "agency-v1");
    assert.equal(l.passport_norm, "AB123456");
    assert.ok(l.dedupe_key);
    assert.equal(l.duplicate_of, null);
    assert.equal(l.assigned_to, null);
    const tl = await pool.query("SELECT event FROM crm_timeline WHERE entity='agency' AND entity_id=$1", [ag.orgId]);
    assert.ok(tl.rowCount >= 1);
    const au = await pool.query("SELECT new_data::text t FROM audit_logs WHERE action='agency.candidate.create'");
    assert.equal(au.rowCount, 1);
    assert.ok(!au.rows[0].t.includes("AB123456"));
  }));

test("validation: consent, contact, lengths, types, unknown fields, strict ids", () =>
  withApp(async ({ pool, call }) => {
    const ag = await createAgencyUser(pool);
    const t = ag.token;
    const bad = async (b, msg) => {
      const r = await call("POST", "/agency/candidates", { token: t, body: b });
      assert.equal(r.status, 400, msg);
    };
    await bad({ ...body(), consent_attested: undefined }, "no consent");
    await bad({ ...body(), consent_attested: false }, "consent false");
    await bad({ ...body(), consent_attested: "true" }, "consent string");
    await bad({ ...body(), consent_attested: 1 }, "consent number");
    await bad({ full_name: "X", consent_attested: true }, "no contact");
    await bad({ ...body(), full_name: "" }, "empty name");
    await bad({ ...body(), full_name: "a".repeat(121) }, "long name");
    await bad({ ...body(), full_name: 5 }, "name type");
    await bad({ ...body(), email: "nope" }, "bad email");
    await bad({ ...body(), phone: "abc" }, "bad phone");
    await bad({ ...body(), phone: "12" }, "short phone");
    await bad({ ...body(), passport_number: "x".repeat(41) }, "long passport");
    await bad({ ...body(), passport_number: "--" }, "junk passport");
    await bad({ ...body(), message: "m".repeat(4001) }, "long message");
    await bad({ ...body(), status: "converted" }, "unknown field");
    await bad({ ...body(), full_name: "a\u0000b" }, "nul");
    await bad([], "array body");
    assert.equal((await call("POST", "/agency/candidates", { token: t, raw: "{bad" })).status, 400);
    assert.equal((await call("POST", "/agency/candidates", { token: t, raw: JSON.stringify({ ...body(), message: "x".repeat(20000) }) })).status, 413);
    assert.equal((await pool.query("SELECT count(*)::int n FROM crm_leads")).rows[0].n, 0);
    for (const id of ["0", "01", "abc", "1e3", "-1", "1.5", "99999999999999999", "%20", "c0", "cc1"]) {
      assert.equal((await call("GET", `/agency/candidates/${encodeURIComponent(id)}`, { token: t })).status, 400, id);
    }
    for (const q of ["limit=0", "limit=101", "limit=abc", "offset=-1", "limit=1&limit=2"]) {
      assert.equal((await call("GET", `/agency/candidates?${q}`, { token: t })).status, 400, q);
    }
  }));

test("daily cap per agency => 429 with Retry-After; other agencies unaffected", () =>
  withApp(async ({ pool, call }) => {
    process.env.AGENCY_CANDIDATES_PER_DAY = "3";
    try {
      const a = await createAgencyUser(pool);
      const b = await createAgencyUser(pool);
      for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/agency/candidates", { token: a.token, body: body() })).status, 201);
      const over = await call("POST", "/agency/candidates", { token: a.token, body: body() });
      assert.equal(over.status, 429);
      assert.equal((await call("POST", "/agency/candidates", { token: b.token, body: body() })).status, 201);
      assert.equal((await pool.query("SELECT count(*)::int n FROM crm_leads WHERE agency_id=$1", [a.orgId])).rows[0].n, 3);
    } finally {
      delete process.env.AGENCY_CANDIDATES_PER_DAY;
    }
  }));

test("isolation: agency A and B see only their own leads, by list and by id (foreign == missing)", () =>
  withApp(async ({ pool, call }) => {
    const a = await createAgencyUser(pool);
    const b = await createAgencyUser(pool);
    const la = (await call("POST", "/agency/candidates", { token: a.token, body: body({ full_name: "Alpha" }) })).body.id;
    const lb = (await call("POST", "/agency/candidates", { token: b.token, body: body({ full_name: "Beta" }) })).body.id;
    // a public / staff lead with no agency
    const pub = (await pool.query("INSERT INTO crm_leads (kind,name,email,source,dedupe_key) VALUES ('candidate','Pub','pub@t.invalid','website','k1') RETURNING id")).rows[0].id;
    const listA = await call("GET", "/agency/candidates", { token: a.token });
    assert.equal(listA.status, 200);
    assert.deepEqual(listA.body.candidates.map((c) => c.full_name), ["Alpha"]);
    assert.equal(listA.body.total, 1);
    assert.deepEqual(Object.keys(listA.body.candidates[0]).sort(), LIST_KEYS);
    noInternal(listA);
    assert.equal((await call("GET", `/agency/candidates/${la}`, { token: a.token })).status, 200);
    const foreign = await call("GET", `/agency/candidates/${lb}`, { token: a.token });
    const missing = await call("GET", "/agency/candidates/99999999", { token: a.token });
    const nonAgency = await call("GET", `/agency/candidates/${pub}`, { token: a.token });
    for (const r of [foreign, missing, nonAgency]) {
      assert.equal(r.status, 404);
      assert.equal(r.text, missing.text);
    }
    // a candidate-only record of B is not reachable through the c-prefixed id either
    const cB = (await pool.query("INSERT INTO candidates (full_name,passport_number,agency_id) VALUES ('CB','PB1',$1) RETURNING id", [b.orgId])).rows[0].id;
    const cr = await call("GET", `/agency/candidates/c${cB}`, { token: a.token });
    assert.equal(cr.status, 404);
    assert.equal(cr.text, missing.text);
    const own = await call("GET", `/agency/candidates/c${cB}`, { token: b.token });
    assert.equal(own.status, 200);
    assert.equal(own.body.full_name, "CB");
  }));

test("duplicate non-disclosure: identical status and shape; own list shows it normally; staff see a flag", () =>
  withApp(async ({ pool, call }) => {
    const a = await createAgencyUser(pool);
    const b = await createAgencyUser(pool);
    const first = await call("POST", "/agency/candidates", { token: b.token, body: body({ email: "dup@t.invalid", phone: "+216 99 000 111", passport_number: "P-9999" }) });
    assert.equal(first.status, 201);
    const cand = (await pool.query("INSERT INTO candidates (full_name,passport_number,email,phone) VALUES ('Existing','XY77001','exist@t.invalid','+33 1 23 45 67 89') RETURNING id")).rows[0].id;
    const fresh = await call("POST", "/agency/candidates", { token: a.token, body: body() });
    const cases = [
      body({ email: "DUP@t.invalid" }),
      body({ phone: "216-99-000-111" }),
      body({ passport_number: "p 9999" }),
      body({ email: "exist@T.invalid" }),
      body({ phone: "+33 1 23 45 67 89" }),
      body({ passport_number: "xy-77001" }),
    ];
    const ids = [];
    for (const c of cases) {
      const r = await call("POST", "/agency/candidates", { token: a.token, body: c });
      assert.equal(r.status, fresh.status);
      assert.deepEqual(Object.keys(r.body).sort(), Object.keys(fresh.body).sort());
      assert.equal(r.body.ok, true);
      assert.equal(typeof r.body.id, typeof fresh.body.id);
      noInternal(r);
      ids.push(r.body.id);
    }
    const flagged = (await pool.query("SELECT id, status, duplicate_of, duplicate_candidate_id, agency_id FROM crm_leads WHERE id = ANY($1::bigint[]) ORDER BY id", [ids])).rows;
    assert.equal(flagged.length, 6);
    for (const f of flagged) {
      assert.equal(f.status, "new");
      assert.equal(String(f.agency_id), String(a.orgId));
      assert.ok(f.duplicate_of !== null || f.duplicate_candidate_id !== null);
    }
    assert.equal(String(flagged[0].duplicate_of), String(first.body.id));
    assert.equal(flagged[3].duplicate_candidate_id, cand);
    const fl = (await pool.query("SELECT 1 FROM crm_timeline WHERE entity='lead' AND entity_id=$1 AND event='duplicate_flagged'", [ids[0]])).rowCount;
    assert.equal(fl, 1);
    // appears normally in A's own list, identical row shape to the fresh one
    const list = await call("GET", "/agency/candidates?limit=100", { token: a.token });
    assert.equal(list.body.total, 7);
    for (const row of list.body.candidates) {
      assert.deepEqual(Object.keys(row).sort(), LIST_KEYS);
      assert.equal(row.stage, "new");
      assert.equal(row.status_text, "Received");
    }
    noInternal(list);
    const one = await call("GET", `/agency/candidates/${ids[0]}`, { token: a.token });
    assert.equal(one.status, 200);
    assert.deepEqual(Object.keys(one.body).sort(), LIST_KEYS);
    // B never sees A's duplicate submissions
    assert.equal((await call("GET", "/agency/candidates", { token: b.token })).body.total, 1);
  }));

test("status text maps lead status; never exposes staff notes", () =>
  withApp(async ({ pool, call }) => {
    const a = await createAgencyUser(pool);
    const rows = {};
    for (const s of ["new", "contacted", "qualified", "rejected"]) {
      const id = (await call("POST", "/agency/candidates", { token: a.token, body: body() })).body.id;
      await pool.query("UPDATE crm_leads SET status=$2, message=message WHERE id=$1", [id, s]);
      await pool.query("INSERT INTO crm_timeline (entity,entity_id,event,detail) VALUES ('lead',$1,'note','{\"note\":\"SECRET-STAFF-NOTE\"}')", [id]);
      rows[s] = (await call("GET", `/agency/candidates/${id}`, { token: a.token })).body;
      assert.ok(!JSON.stringify(rows[s]).includes("SECRET"));
    }
    assert.equal(rows.new.status_text, "Received");
    assert.equal(rows.contacted.status_text, "In contact");
    assert.equal(rows.qualified.status_text, "Qualified");
    assert.equal(rows.rejected.status_text, "Not proceeding");
    assert.equal(rows.rejected.stage, "rejected");
    // spam leads are never listed
    const sp = (await pool.query("INSERT INTO crm_leads (kind,name,status,agency_id) VALUES ('candidate','S','spam',$1) RETURNING id", [a.orgId])).rows[0].id;
    assert.equal((await call("GET", `/agency/candidates/${sp}`, { token: a.token })).status, 404);
    assert.equal((await call("GET", "/agency/candidates?limit=100", { token: a.token })).body.total, 4);
  }));

test("paging: limit/offset and stable order", () =>
  withApp(async ({ pool, call }) => {
    const a = await createAgencyUser(pool);
    for (let i = 0; i < 5; i++) await call("POST", "/agency/candidates", { token: a.token, body: body({ full_name: `P${i}` }) });
    const p1 = await call("GET", "/agency/candidates?limit=2&offset=0", { token: a.token });
    const p2 = await call("GET", "/agency/candidates?limit=2&offset=2", { token: a.token });
    assert.equal(p1.body.candidates.length, 2);
    assert.equal(p1.body.total, 5);
    assert.deepEqual(p1.body.candidates.map((c) => c.full_name), ["P4", "P3"]);
    assert.deepEqual(p2.body.candidates.map((c) => c.full_name), ["P2", "P1"]);
  }));

test("convertLead copies agency_id; agency then sees the candidate stage after staff changes it", () =>
  withApp(async ({ pool, call }) => {
    const a = await createAgencyUser(pool);
    const b = await createAgencyUser(pool);
    const admin = (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('Adm','adm@t.invalid','x','Admin') RETURNING id")).rows[0].id;
    const adminTok = jwt.sign({ id: admin, role: "Admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const id = (await call("POST", "/agency/candidates", { token: a.token, body: body({ full_name: "Convertee" }) })).body.id;
    const conv = await call("POST", `/crm/leads/${id}/convert`, { token: adminTok, body: { passport_number: "ZZ1234567" } });
    assert.equal(conv.status, 201);
    const cid = conv.body.candidate.id;
    assert.equal(String((await pool.query("SELECT agency_id FROM candidates WHERE id=$1", [cid])).rows[0].agency_id), String(a.orgId));
    let one = await call("GET", `/agency/candidates/${id}`, { token: a.token });
    assert.equal(one.status, 200);
    assert.equal(one.body.stage, "lead");
    assert.equal(one.body.status_text, "Registered");
    assert.equal((await call("PATCH", `/crm/candidates/${cid}/stage`, { token: adminTok, body: { stage: "interview" } })).status, 200);
    one = await call("GET", `/agency/candidates/${id}`, { token: a.token });
    assert.equal(one.body.stage, "interview");
    assert.equal(one.body.status_text, "Interview");
    // converted lead + its candidate appear once, not twice
    const list = await call("GET", "/agency/candidates", { token: a.token });
    assert.equal(list.body.total, 1);
    assert.equal(list.body.candidates[0].stage, "interview");
    noInternal(list);
    assert.equal((await call("GET", "/agency/candidates", { token: b.token })).body.total, 0);
    // a staff-created candidate attributed to the agency (no lead) is listed with a c-prefixed id
    const c2 = (await pool.query("INSERT INTO candidates (full_name,passport_number,agency_id,crm_stage) VALUES ('Direct','D1',$1,'documents') RETURNING id", [a.orgId])).rows[0].id;
    const l2 = await call("GET", "/agency/candidates", { token: a.token });
    assert.equal(l2.body.total, 2);
    const direct = l2.body.candidates.find((c) => c.full_name === "Direct");
    assert.equal(direct.id, `c${c2}`);
    assert.equal(direct.status_text, "Documents");
    assert.deepEqual(Object.keys(direct).sort(), LIST_KEYS);
  }));

test("convertLead without an agency leaves agency_id null", () =>
  withApp(async ({ pool, call }) => {
    const admin = (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('Adm','adm@t.invalid','x','Admin') RETURNING id")).rows[0].id;
    const adminTok = jwt.sign({ id: admin, role: "Admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const id = (await pool.query("INSERT INTO crm_leads (kind,name,email,dedupe_key) VALUES ('candidate','Plain','p@t.invalid','kk') RETURNING id")).rows[0].id;
    const conv = await call("POST", `/crm/leads/${id}/convert`, { token: adminTok, body: { passport_number: "PL1234" } });
    assert.equal(conv.status, 201);
    assert.equal((await pool.query("SELECT agency_id FROM candidates WHERE id=$1", [conv.body.candidate.id])).rows[0].agency_id, null);
  }));
