// Stage 8 task 1: candidate reference CAN-YYYY-NNNN (migration 025) and the Canada profile fields.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-candidate-ref-test-secret";

const SQL025 = fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "025_candidate_reference.sql"), "utf8");
const REF_RE = /^CAN-[0-9]{4}-[0-9]{4,}$/;

async function withWorld(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = (sql, p) => pool.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  const http = async (method, url, token, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, body: json, text };
  };
  const users = {};
  const tokens = {};
  const mkStaff = async (key, role) => {
    users[key] = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [key, `${key}@ref.test.invalid`, role])).id;
    tokens[key] = jwt.sign({ id: users[key], role, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  };
  let n = 0;
  const cand = async (assignedTo = null, { account = false, createdAt = null } = {}) => {
    n += 1;
    const c = (await one(
      `INSERT INTO candidates (full_name, passport_number, assigned_to, created_at) VALUES ($1,$2,$3, COALESCE($4::timestamp, CURRENT_TIMESTAMP)) RETURNING id, reference`,
      [`Cand ${n}`, `PP-REF-${n}`, assignedTo, createdAt]
    ));
    if (!account) return c;
    const uid = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x','Candidate') RETURNING id", [`Cand ${n}`, `cand${n}@ref.test.invalid`])).id;
    await q("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [uid, c.id]);
    return { ...c, userId: uid, token: jwt.sign({ id: uid, role: "Candidate", tv: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
  };
  try {
    await fn({ pool, q, one, http, users, tokens, mkStaff, cand });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

test("025: reference format, per-year sequence, padding growth, immutability, unique index", async () => {
  await withWorld(async (w) => {
    const a = await w.cand(null, { createdAt: "2026-03-01 10:00:00" });
    const b = await w.cand(null, { createdAt: "2026-07-01 10:00:00" });
    const c = await w.cand(null, { createdAt: "2025-12-31 23:59:59" });
    assert.deepEqual([a.reference, b.reference, c.reference], ["CAN-2026-0001", "CAN-2026-0002", "CAN-2025-0001"]);
    // padding grows beyond 4 digits
    await w.q("UPDATE candidate_ref_counters SET value = 9999 WHERE year = 2026");
    assert.equal((await w.cand(null, { createdAt: "2026-08-01" })).reference, "CAN-2026-10000");
    // an explicit reference is kept; the counter skips a number already taken by hand
    await w.q("INSERT INTO candidates (full_name, passport_number, reference, created_at) VALUES ('Manual','PP-M','CAN-2024-0002','2024-01-01')");
    assert.equal((await w.cand(null, { createdAt: "2024-02-01" })).reference, "CAN-2024-0001");
    assert.equal((await w.cand(null, { createdAt: "2024-03-01" })).reference, "CAN-2024-0003");
    // format CHECK, unique index, immutability
    await assert.rejects(w.q("UPDATE candidates SET reference = 'bogus' WHERE id = $1", [a.id]), /./);
    await assert.rejects(w.q("INSERT INTO candidates (full_name, passport_number, reference) VALUES ('d','PP-D',$1)", [a.reference]), /candidates_reference_uniq/);
    await assert.rejects(w.q("UPDATE candidates SET reference = 'CAN-2030-0001' WHERE id = $1", [a.id]), /immutable/);
    // assign_candidate_reference is idempotent
    assert.equal((await w.one("SELECT assign_candidate_reference($1) AS r", [a.id])).r, a.reference);
    assert.equal((await w.one("SELECT assign_candidate_reference(999999) AS r")).r, null);
    // a rolled-back insert gives its number back (no gap)
    const cl = await w.pool.connect();
    await cl.query("BEGIN");
    await cl.query("INSERT INTO candidates (full_name, passport_number, created_at) VALUES ('rb','PP-RB','2023-05-05')");
    await cl.query("ROLLBACK");
    cl.release();
    assert.equal((await w.cand(null, { createdAt: "2023-06-06" })).reference, "CAN-2023-0001");
  });
});

test("025: 30 parallel inserts across the year boundary give 30 distinct gapless references", async () => {
  await withWorld(async (w) => {
    const rows = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        w.q("INSERT INTO candidates (full_name, passport_number, created_at) VALUES ($1,$2,$3) RETURNING reference", [`P ${i}`, `PP-PAR-${i}`, i % 2 ? "2026-01-01 00:00:01" : "2025-12-31 23:59:59"])
      )
    );
    const refs = rows.map((r) => r.rows[0].reference);
    assert.equal(new Set(refs).size, 30);
    assert.ok(refs.every((r) => REF_RE.test(r)));
    for (const [year, expected] of [[2025, 15], [2026, 15]]) {
      const nums = refs.filter((r) => r.startsWith(`CAN-${year}-`)).map((r) => Number(r.slice(9))).sort((a, b) => a - b);
      assert.deepEqual(nums, Array.from({ length: expected }, (_, i) => i + 1), `year ${year} gapless`);
      assert.equal((await w.one("SELECT value FROM candidate_ref_counters WHERE year = $1", [year])).value, expected);
    }
  });
});

test("025: backfill of pre-existing candidates in id order, idempotent re-run, rows with a reference untouched", async () => {
  await withWorld(async (w) => {
    // simulate a database that held candidates before 025: no trigger, no references, no counters
    await w.q("ALTER TABLE candidates DISABLE TRIGGER candidates_assign_reference");
    const mk = async (name, createdAt, reference = null, deleted = false) =>
      (await w.one("INSERT INTO candidates (full_name, passport_number, created_at, reference, is_deleted) VALUES ($1,$2,$3,$4,$5) RETURNING id", [name, `PP-${name}`, createdAt, reference, deleted])).id;
    const ids = [
      await mk("L1", "2025-02-01"),
      await mk("L2", "2026-02-01"),
      await mk("L3", "2025-09-01"),
      await mk("L4", "2025-10-01", null, true),
      await mk("L5", "2026-04-01"),
    ];
    const keep = await mk("Keep", "2026-05-01", "CAN-2026-0777");
    await w.q("ALTER TABLE candidates ENABLE TRIGGER candidates_assign_reference");
    await w.q("TRUNCATE candidate_ref_counters");
    await w.q(SQL025); // the migration file itself: backfill + idempotent re-run on an already migrated schema
    const refs = (await w.q("SELECT id, reference FROM candidates ORDER BY id")).rows.map((r) => r.reference);
    assert.deepEqual(refs, ["CAN-2025-0001", "CAN-2026-0001", "CAN-2025-0002", "CAN-2025-0003", "CAN-2026-0002", "CAN-2026-0777"]);
    assert.deepEqual((await w.q("SELECT year, value FROM candidate_ref_counters ORDER BY year")).rows, [{ year: 2025, value: 3 }, { year: 2026, value: 2 }]);
    const snap = JSON.stringify((await w.q("SELECT id, reference FROM candidates ORDER BY id")).rows) + JSON.stringify((await w.q("SELECT * FROM candidate_ref_counters ORDER BY year")).rows);
    await w.q(SQL025);
    await w.q(SQL025);
    assert.equal(JSON.stringify((await w.q("SELECT id, reference FROM candidates ORDER BY id")).rows) + JSON.stringify((await w.q("SELECT * FROM candidate_ref_counters ORDER BY year")).rows), snap);
    assert.equal(ids.length + 1, refs.length);
    assert.equal((await w.cand()).reference.startsWith(`CAN-${new Date().getFullYear()}-`), true);
    assert.equal(keep > 0, true);
  });
});

test("every creation path assigns a reference: model/legacy POST /candidates/add, convertLead, direct insert", async () => {
  await withWorld(async (w) => {
    await w.mkStaff("admin", "Admin");
    const add = await w.http("POST", "/candidates/add", w.tokens.admin, { full_name: "Legacy Add", passport_number: "LEG-1", assigned_to: w.users.admin });
    assert.equal(add.status, 201, add.text);
    const row = await w.one("SELECT reference FROM candidates WHERE passport_number = 'LEG-1'");
    assert.match(row.reference, REF_RE);
    const lead = (await w.one("INSERT INTO crm_leads (kind,status,name,email,phone,assigned_to,dedupe_key) VALUES ('candidate','new','Lead One','lead1@ref.test.invalid','+21655500001',$1,'dk-ref-1') RETURNING id", [w.users.admin])).id;
    const conv = await w.http("POST", `/crm/leads/${lead}/convert`, w.tokens.admin, { passport_number: "CONV-1", createPortalLogin: false });
    assert.equal(conv.status, 201, conv.text);
    assert.match(conv.body.candidate.reference, REF_RE);
    assert.equal((await w.one("SELECT reference FROM candidates WHERE passport_number = 'CONV-1'")).reference, conv.body.candidate.reference);
    assert.match((await w.cand()).reference, REF_RE);
  });
});

test("extras: validation table (strict, unknown fields 400, normalisation)", async () => {
  await withWorld(async (w) => {
    await w.mkStaff("admin", "Admin");
    const c = await w.cand(w.users.admin);
    const url = `/jobsearch/candidates/${c.id}/extras`;
    const bad = [
      [{}, "empty"],
      [[], "array"],
      [{ nope: 1 }, "unknown field"],
      [{ reference: "CAN-2030-0001" }, "reference is not editable"],
      [{ phone: "+1 416 555 0100" }, "phone is edited through the legacy routes"],
      [{ city: 5 }, "city type"],
      [{ city: "x".repeat(121) }, "city too long"],
      [{ city: "Mon\u0000treal" }, "city control char"],
      [{ whatsapp: "abc" }, "whatsapp letters"],
      [{ whatsapp: "12345" }, "whatsapp too short"],
      [{ whatsapp: "+".concat("1".repeat(25)) }, "whatsapp too long"],
      [{ whatsapp: "+1234567890123456" }, "whatsapp > 15 digits"],
      [{ whatsapp: "1+2345678" }, "plus in the middle"],
      [{ whatsapp: 5551234567 }, "whatsapp number type"],
      [{ work_authorization_status: "tourist" }, "status enum"],
      [{ work_authorization_status: 1 }, "status type"],
      [{ relocation_ready: "yes" }, "relocation type"],
      [{ relocation_ready: 1 }, "relocation number"],
      [{ desired_province: "XX" }, "province unknown"],
      [{ desired_province: "Ontario" }, "province name"],
      [{ desired_province: 7 }, "province type"],
      [{ service_start_date: "2026-02-30" }, "impossible date"],
      [{ service_start_date: "2026-13-01" }, "month 13"],
      [{ service_start_date: "01/02/2026" }, "date format"],
      [{ service_start_date: "2026-2-3" }, "date padding"],
      [{ service_start_date: 20260203 }, "date type"],
      [{ city: "Toronto", extra: true }, "mixed valid and unknown"],
    ];
    for (const [body, why] of bad) {
      const r = await w.http("PATCH", url, w.tokens.admin, body);
      assert.equal(r.status, 400, `${why}: ${r.text}`);
    }
    assert.equal((await w.one("SELECT city, whatsapp, desired_province FROM candidates WHERE id=$1", [c.id])).city, null, "nothing written by rejected patches");
    assert.equal((await w.one("SELECT count(*)::int n FROM audit_logs WHERE action LIKE 'candidate.extras.%'")).n, 0);
    const ok = await w.http("PATCH", url, w.tokens.admin, {
      city: "  Montréal   QC ", whatsapp: "+1 (514) 555-0100", work_authorization_status: "work_permit_open", relocation_ready: true, desired_province: "qc", service_start_date: "2026-02-28",
    });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.city, "Montréal QC");
    assert.equal(ok.body.whatsapp, "+15145550100");
    assert.equal(ok.body.desired_province, "QC");
    assert.equal(ok.body.service_start_date, "2026-02-28");
    assert.equal(ok.body.relocation_ready, true);
    assert.equal(ok.body.reference, c.reference);
    const un = await w.http("PATCH", url, w.tokens.admin, { city: null, whatsapp: "", work_authorization_status: null, relocation_ready: null, desired_province: null, service_start_date: null });
    assert.equal(un.status, 200, un.text);
    assert.deepEqual([un.body.city, un.body.whatsapp, un.body.work_authorization_status, un.body.relocation_ready, un.body.desired_province, un.body.service_start_date], [null, null, null, null, null, null]);
    for (const s of ["none", "study_permit", "work_permit_open", "work_permit_employer_specific", "pr", "citizen", "unknown"]) {
      assert.equal((await w.http("PATCH", url, w.tokens.admin, { work_authorization_status: s })).status, 200, s);
    }
    for (const p of ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]) {
      assert.equal((await w.http("PATCH", url, w.tokens.admin, { desired_province: p })).status, 200, p);
    }
    // the database enforces the same sets
    await assert.rejects(w.q("UPDATE candidates SET work_authorization_status='x' WHERE id=$1", [c.id]), /candidates_work_authorization_status_check/);
    await assert.rejects(w.q("UPDATE candidates SET desired_province='ZZ' WHERE id=$1", [c.id]), /candidates_desired_province_check/);
  });
});

test("extras: staff scope matrix, GET includes reference, deleted/unknown 404", async () => {
  await withWorld(async (w) => {
    for (const [k, r] of [["admin", "Admin"], ["mgr", "Manager"], ["rec", "Receptionist"], ["agent", "Agent"], ["agent2", "Agent"], ["hr", "HR"], ["acct", "Accountant"]]) await w.mkStaff(k, r);
    const mine = {};
    for (const k of ["mgr", "rec", "agent"]) mine[k] = await w.cand(w.users[k]);
    const other = await w.cand(w.users.agent2);
    const unassigned = await w.cand(null);
    const deleted = await w.cand(w.users.agent);
    await w.q("UPDATE candidates SET is_deleted = true WHERE id = $1", [deleted.id]);
    const get = (tok, id) => w.http("GET", `/jobsearch/candidates/${id}/extras`, tok);
    const patch = (tok, id, body) => w.http("PATCH", `/jobsearch/candidates/${id}/extras`, tok, body);
    for (const c of [...Object.values(mine), other, unassigned]) {
      const r = await get(w.tokens.admin, c.id);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.reference, c.reference);
      assert.match(r.body.reference, REF_RE);
    }
    assert.equal((await get(w.tokens.admin, deleted.id)).status, 404);
    assert.equal((await get(w.tokens.admin, 999999)).status, 404);
    assert.equal((await get(w.tokens.admin, "abc")).status, 404);
    for (const k of ["mgr", "rec", "agent"]) {
      assert.equal((await get(w.tokens[k], mine[k].id)).status, 200, `${k} own`);
      assert.equal((await patch(w.tokens[k], mine[k].id, { city: "Ottawa" })).status, 200, `${k} own patch`);
      for (const [name, c] of [["other agent's", other], ["unassigned", unassigned]]) {
        assert.equal((await get(w.tokens[k], c.id)).status, 404, `${k} ${name}`);
        assert.equal((await patch(w.tokens[k], c.id, { city: "Hack" })).status, 404, `${k} patch ${name}`);
      }
    }
    assert.equal((await w.one("SELECT city FROM candidates WHERE id=$1", [other.id])).city, null);
    for (const k of ["hr", "acct"]) {
      assert.equal((await get(w.tokens[k], mine.agent.id)).status, 404, `${k} get`);
      assert.equal((await patch(w.tokens[k], mine.agent.id, { city: "Hack" })).status, 404, `${k} patch`);
    }
    assert.equal((await get(null, mine.agent.id)).status, 401);
    // Employer and Agency portal tokens never reach /jobsearch
    const emp = await createEmployerUser(w.pool);
    const agy = await createAgencyUser(w.pool);
    for (const tok of [emp.token, agy.token]) {
      for (const [m, u] of [["GET", `/jobsearch/candidates/${mine.agent.id}/extras`], ["PATCH", `/jobsearch/candidates/${mine.agent.id}/extras`], ["GET", "/jobsearch/me/extras"], ["PATCH", "/jobsearch/me/extras"]]) {
        const r = await w.http(m, u, tok, m === "PATCH" ? { city: "x" } : undefined);
        assert.ok([401, 403, 404].includes(r.status), `${m} ${u} -> ${r.status}`);
      }
    }
    // staff have no /me
    assert.equal((await w.http("GET", "/jobsearch/me/extras", w.tokens.admin)).status, 403);
    assert.equal((await w.http("PATCH", "/jobsearch/me/extras", w.tokens.admin, { city: "x" })).status, 403);
  });
});

test("extras: candidate reads own, edits only city/whatsapp/relocation_ready/desired_province; cannot touch another or the staff routes", async () => {
  await withWorld(async (w) => {
    await w.mkStaff("admin", "Admin");
    const a = await w.cand(w.users.admin, { account: true });
    const b = await w.cand(w.users.admin, { account: true });
    await w.http("PATCH", `/jobsearch/candidates/${a.id}/extras`, w.tokens.admin, { work_authorization_status: "study_permit", service_start_date: "2026-09-01" });
    const me = await w.http("GET", "/jobsearch/me/extras", a.token);
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.reference, a.reference);
    assert.equal(me.body.work_authorization_status, "study_permit");
    assert.equal(me.body.service_start_date, "2026-09-01");
    assert.deepEqual(me.body.editable_fields, ["city", "whatsapp", "relocation_ready"], "the province is staff-only: it decides the legal jurisdiction");
    assert.equal(me.text.includes(b.reference), false);
    const edit = await w.http("PATCH", "/jobsearch/me/extras", a.token, { city: "Calgary", whatsapp: "+1 403 555 0101", relocation_ready: false });
    assert.equal(edit.status, 200, edit.text);
    assert.deepEqual([edit.body.city, edit.body.whatsapp, edit.body.relocation_ready, edit.body.desired_province], ["Calgary", "+14035550101", false, null]);
    for (const body of [{ work_authorization_status: "citizen" }, { service_start_date: "2027-01-01" }, { city: "Ok", work_authorization_status: "pr" }, { desired_province: "AB" }, { desired_province: null }, { city: "Ok", desired_province: "ON" }]) {
      const r = await w.http("PATCH", "/jobsearch/me/extras", a.token, body);
      assert.equal(r.status, 403, JSON.stringify(body));
    }
    assert.equal((await w.http("PATCH", "/jobsearch/me/extras", a.token, { reference: "CAN-2099-0001" })).status, 400);
    assert.equal((await w.http("PATCH", "/jobsearch/me/extras", a.token, { city: "x".repeat(121) })).status, 400);
    const row = await w.one("SELECT city, work_authorization_status, to_char(service_start_date,'YYYY-MM-DD') d FROM candidates WHERE id=$1", [a.id]);
    assert.deepEqual([row.city, row.work_authorization_status, row.d], ["Calgary", "study_permit", "2026-09-01"], "restricted fields untouched, allowed ones saved");
    // another candidate's record is out of reach through every route
    for (const [m, body] of [["GET"], ["PATCH", { city: "x" }]]) {
      const r = await w.http(m, `/jobsearch/candidates/${b.id}/extras`, a.token, body);
      assert.ok(r.status === 403 || r.status === 404, `${m} foreign -> ${r.status}`);
      const own = await w.http(m, `/jobsearch/candidates/${a.id}/extras`, a.token, body);
      assert.equal(own.status, 403, "the staff route is staff-only even for the own record");
    }
    assert.equal((await w.one("SELECT city FROM candidates WHERE id=$1", [b.id])).city, null);
  });
});

test("extras: every update is one transaction with an audit row (old/new); failures leave nothing behind", async () => {
  await withWorld(async (w) => {
    await w.mkStaff("admin", "Admin");
    const a = await w.cand(w.users.admin, { account: true });
    const r1 = await w.http("PATCH", `/jobsearch/candidates/${a.id}/extras`, w.tokens.admin, { city: "Toronto", desired_province: "ON" });
    assert.equal(r1.status, 200);
    const r2 = await w.http("PATCH", "/jobsearch/me/extras", a.token, { city: "Ottawa" });
    assert.equal(r2.status, 200);
    const logs = (await w.q("SELECT user_id, action, table_name, record_id, old_data, new_data FROM audit_logs WHERE action LIKE 'candidate.extras.%' ORDER BY id")).rows;
    assert.equal(logs.length, 2);
    assert.deepEqual([logs[0].action, logs[0].user_id, logs[0].table_name, logs[0].record_id], ["candidate.extras.update", w.users.admin, "candidates", String(a.id)]);
    assert.deepEqual(logs[0].old_data, { city: null, desired_province: null });
    assert.deepEqual(logs[0].new_data, { city: "Toronto", desired_province: "ON" });
    assert.deepEqual([logs[1].action, logs[1].user_id], ["candidate.extras.update_self", a.userId]);
    assert.deepEqual([logs[1].old_data, logs[1].new_data], [{ city: "Toronto" }, { city: "Ottawa" }]);
    // audit failure rolls the update back (the whole thing is one transaction)
    await w.q("ALTER TABLE audit_logs RENAME TO audit_logs_x");
    const bad = await w.http("PATCH", `/jobsearch/candidates/${a.id}/extras`, w.tokens.admin, { city: "Halifax" });
    await w.q("ALTER TABLE audit_logs_x RENAME TO audit_logs");
    assert.ok(bad.status >= 500, `status ${bad.status}`);
    assert.equal((await w.one("SELECT city FROM candidates WHERE id=$1", [a.id])).city, "Ottawa");
  });
});

test("reference appears in the dashboard, the profile response and the staff CSV exports", async () => {
  await withWorld(async (w) => {
    await w.mkStaff("admin", "Admin");
    const a = await w.cand(w.users.admin, { account: true });
    const dash = await w.http("GET", "/jobsearch/dashboard", w.tokens.admin);
    assert.equal(dash.status, 200, dash.text);
    assert.equal(dash.body.candidates.find((x) => x.candidateId === a.id).reference, a.reference);
    const own = await w.http("GET", "/jobsearch/dashboard", a.token);
    assert.equal(own.status, 200);
    assert.equal(own.body.candidates.find((x) => x.candidateId === a.id).reference, a.reference);
    for (const type of ["applications", "matches", "submissions"]) {
      const csv = await w.http("GET", `/jobsearch/export.csv?type=${type}`, w.tokens.admin);
      assert.equal(csv.status, 200, type);
      assert.ok(csv.text.split(/\r\n/)[0].split(",").includes("candidate_reference"), `${type} header`);
    }
    const csvC = await w.http("GET", "/jobsearch/export.csv?type=applications", a.token);
    assert.equal(csvC.status, 200);
    assert.equal(csvC.text.split(/\r\n/)[0].includes("candidate_reference"), false, "candidate export keeps its own column set");
    // profile response
    await w.q("INSERT INTO js_profiles (candidate_id, status, extracted, confirmed, provenance) VALUES ($1,'confirmed','{}','{}','{}')", [a.id]);
    const prof = await w.http("GET", `/jobsearch/candidates/${a.id}/profile`, w.tokens.admin);
    assert.equal(prof.status, 200, prof.text);
    assert.equal(prof.body.reference, a.reference);
    assert.equal((await w.http("GET", `/jobsearch/candidates/${a.id}/profile`, a.token)).body.reference, a.reference);
  });
});
