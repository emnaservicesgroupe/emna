// Task 4: convert lead -> candidate (+ optional portal login), candidate stage and timeline.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "crm-convert-test-secret";
delete process.env.MAIL_PROVIDER;
delete process.env.MAIL_SANDBOX_ALLOWLIST;

const otp = () => require("../modules/jobsearch/otp");

async function withWorld(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  otp()._testing.reset();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = (sql, p) => pool.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  const count = async (table) => Number((await one(`SELECT count(*) AS n FROM ${table}`)).n);
  const http = async (method, url, token, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await otp()._testing.flush();
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  };
  const roles = { admin: "Admin", mgr: "Manager", agentA: "Agent", agentB: "Agent", acct: "Accountant", hr: "HR", cand: "Candidate" };
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
        `INSERT INTO crm_leads (kind,status,name,email,phone,assigned_to,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [o.kind || "candidate", o.status || "new", o.name || `Lead ${n}`, o.email === undefined ? `lead${n}@test.invalid` : o.email, o.phone === undefined ? `+2165550${n}` : o.phone, o.assignedTo || null, `dk-${n}`]
      )
    ).id;
  };
  const counts = async () => ({
    users: await count("users"),
    candidates: await count("candidates"),
    accounts: await count("js_candidate_accounts"),
    visa: await count("visa_applications"),
    timeline: await count("crm_timeline"),
    audit: await count("audit_logs"),
    otps: await count("js_otps"),
  });
  try {
    await fn({ pool, q, one, http, ids, T, lead, counts });
  } finally {
    await otp()._testing.flush();
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

test("happy path with portal login: candidate, account, lead, timeline, audit, OTP mail and login", async () => {
  await withWorld(async (w) => {
    const id = await w.lead({ name: "Amine Trabelsi", email: "Amine@Test.Invalid", phone: "+21655500001", assignedTo: w.ids.mgr });
    const r = await w.http("POST", `/crm/leads/${id}/convert`, w.T.admin, { passport_number: "TN1234567", nationality: "Tunisian", createPortalLogin: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.created, true);
    assert.equal(r.body.candidate.full_name, "Amine Trabelsi");
    assert.equal(r.body.candidate.passport_number, "TN1234567");
    assert.equal(r.body.candidate.assigned_to, w.ids.mgr, "lead's assignee wins");
    assert.equal(r.body.candidate.email, "Amine@Test.Invalid");
    assert.equal(r.body.candidate.phone, "+21655500001");
    assert.equal(r.body.portal.inviteSent, true);
    const cid = r.body.candidate.id;

    const l = await w.one("SELECT status, candidate_id FROM crm_leads WHERE id=$1", [id]);
    assert.equal(l.status, "converted");
    assert.equal(l.candidate_id, cid);
    const acc = await w.one("SELECT user_id FROM js_candidate_accounts WHERE candidate_id=$1", [cid]);
    assert.equal(acc.user_id, r.body.portal.userId);
    const u = await w.one("SELECT role, is_active, password, email FROM users WHERE id=$1", [acc.user_id]);
    assert.equal(u.role, "Candidate");
    assert.equal(u.is_active, true);
    assert.equal(u.email, "amine@test.invalid");
    assert.match(u.password, /^\$2[aby]\$/);
    assert.equal((await w.q("SELECT 1 FROM visa_applications WHERE candidate_id=$1", [cid])).rowCount, 1);
    assert.equal((await w.q("SELECT 1 FROM crm_timeline WHERE entity='lead' AND entity_id=$1 AND event='converted'", [id])).rowCount, 1);
    assert.equal((await w.q("SELECT 1 FROM crm_timeline WHERE entity='candidate' AND entity_id=$1", [cid])).rowCount >= 1, true);
    assert.equal((await w.q("SELECT 1 FROM audit_logs WHERE action='crm.lead.convert' AND record_id=$1", [String(id)])).rowCount, 1);

    // The invite mail is in the sandbox mailbox, and the code logs the new candidate in.
    const mails = (await w.q("SELECT * FROM js_sandbox_mail WHERE to_addr=$1 ORDER BY id", ["amine@test.invalid"])).rows;
    assert.equal(mails.length, 1);
    const code = /\b(\d{6})\b/.exec(mails[0].body)[1];
    const v = await w.http("POST", "/jobsearch/auth/otp/verify", null, { email: "amine@test.invalid", code });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    const me = await w.http("GET", "/jobsearch/auth/me", v.body.token);
    assert.equal(me.body.role, "Candidate");
    assert.equal(me.body.candidate_id, cid);

    // Isolation: the new candidate reads own profile but not someone else's.
    const other = (await w.one("INSERT INTO candidates (full_name, passport_number) VALUES ('Other','OTHER1') RETURNING id")).id;
    const own = await w.http("GET", `/jobsearch/candidates/${cid}/consent`, v.body.token);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal((await w.http("GET", `/jobsearch/candidates/${other}/consent`, v.body.token)).status, 404);
    assert.equal((await w.http("GET", `/jobsearch/candidates/${other}/profile`, v.body.token)).status, 404);
    // ... and cannot use the staff API at all.
    assert.equal((await w.http("GET", "/crm/leads", v.body.token)).status, 403);
  });
});

test("without portal login: no user, no account, no mail; assignee falls back to acting staff; full_name override", async () => {
  await withWorld(async (w) => {
    const id = await w.lead({ name: "Lead Name" });
    const before = await w.counts();
    const r = await w.http("POST", `/crm/leads/${id}/convert`, w.T.admin, { passport_number: "P-100", full_name: "Official Name", createPortalLogin: false });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.candidate.full_name, "Official Name");
    assert.equal(r.body.candidate.assigned_to, w.ids.admin);
    assert.equal(r.body.portal, undefined);
    const after = await w.counts();
    assert.equal(after.users, before.users);
    assert.equal(after.accounts, before.accounts);
    assert.equal(after.candidates, before.candidates + 1);
    assert.equal((await w.one("SELECT count(*) AS n FROM js_sandbox_mail")).n, "0");
  });
});

test("second convert is idempotent: same candidate, 200, no writes", async () => {
  await withWorld(async (w) => {
    const id = await w.lead();
    const first = await w.http("POST", `/crm/leads/${id}/convert`, w.T.admin, { passport_number: "P-200", createPortalLogin: true });
    assert.equal(first.status, 201);
    const before = await w.counts();
    const second = await w.http("POST", `/crm/leads/${id}/convert`, w.T.admin, { passport_number: "P-OTHER", createPortalLogin: true });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.created, false);
    assert.equal(second.body.candidate.id, first.body.candidate.id);
    assert.deepEqual(await w.counts(), before);
  });
});

test("duplicate passport: 409 and nothing written (no user, candidate, timeline, audit, lead change)", async () => {
  await withWorld(async (w) => {
    await w.one("INSERT INTO candidates (full_name, passport_number) VALUES ('Existing','DUP-1') RETURNING id");
    const id = await w.lead();
    const before = await w.counts();
    const r = await w.http("POST", `/crm/leads/${id}/convert`, w.T.admin, { passport_number: "DUP-1", createPortalLogin: true });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(await w.counts(), before);
    const l = await w.one("SELECT status, candidate_id FROM crm_leads WHERE id=$1", [id]);
    assert.equal(l.status, "new");
    assert.equal(l.candidate_id, null);
    assert.equal((await w.one("SELECT count(*) AS n FROM js_sandbox_mail")).n, "0");
    // A soft-deleted candidate still owns its passport number.
    await w.q("UPDATE candidates SET is_deleted=true WHERE passport_number='DUP-1'");
    assert.equal((await w.http("POST", `/crm/leads/${id}/convert`, w.T.admin, { passport_number: "DUP-1", createPortalLogin: false })).status, 409);
    assert.deepEqual(await w.counts(), before);
  });
});

test("validation: portal login needs an email; missing passport; kind and status rules", async () => {
  await withWorld(async (w) => {
    const noEmail = await w.lead({ email: null });
    const before = await w.counts();
    assert.equal((await w.http("POST", `/crm/leads/${noEmail}/convert`, w.T.admin, { passport_number: "P-300", createPortalLogin: true })).status, 400);
    assert.deepEqual(await w.counts(), before);
    assert.equal((await w.http("POST", `/crm/leads/${noEmail}/convert`, w.T.admin, { createPortalLogin: false })).status, 400, "passport required");
    assert.equal((await w.http("POST", `/crm/leads/${noEmail}/convert`, w.T.admin, { passport_number: "   ", createPortalLogin: false })).status, 400);
    assert.equal((await w.http("POST", `/crm/leads/${noEmail}/convert`, w.T.admin, { passport_number: "P-301", createPortalLogin: "yes" })).status, 400);
    assert.deepEqual(await w.counts(), before);
    // Without portal login an email-less lead converts fine.
    assert.equal((await w.http("POST", `/crm/leads/${noEmail}/convert`, w.T.admin, { passport_number: "P-302", createPortalLogin: false })).status, 201);

    const employer = await w.lead({ kind: "employer", company: "Acme" });
    const contact = await w.lead({ kind: "contact" });
    const spam = await w.lead({ status: "spam" });
    const b2 = await w.counts();
    assert.equal((await w.http("POST", `/crm/leads/${employer}/convert`, w.T.admin, { passport_number: "P-303", createPortalLogin: false })).status, 400);
    assert.equal((await w.http("POST", `/crm/leads/${contact}/convert`, w.T.admin, { passport_number: "P-304", createPortalLogin: false })).status, 400);
    assert.equal((await w.http("POST", `/crm/leads/${spam}/convert`, w.T.admin, { passport_number: "P-305", createPortalLogin: false })).status, 409);
    assert.equal((await w.http("POST", `/crm/leads/999999/convert`, w.T.admin, { passport_number: "P-306" })).status, 404);
    assert.equal((await w.http("POST", `/crm/leads/abc/convert`, w.T.admin, { passport_number: "P-307" })).status, 400);
    assert.deepEqual(await w.counts(), b2);
  });
});

test("portal login conflicts: existing staff email and email already linked to another candidate => 409, nothing written", async () => {
  await withWorld(async (w) => {
    const staffMail = await w.lead({ email: "agentA@crm.test.invalid" });
    const before = await w.counts();
    const r = await w.http("POST", `/crm/leads/${staffMail}/convert`, w.T.admin, { passport_number: "P-400", createPortalLogin: true });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(await w.counts(), before);

    // Convert one lead with a portal login, then another lead with the same email.
    const a = await w.lead({ email: "shared@test.invalid" });
    assert.equal((await w.http("POST", `/crm/leads/${a}/convert`, w.T.admin, { passport_number: "P-401", createPortalLogin: true })).status, 201);
    await w.q("UPDATE crm_leads SET email = NULL WHERE id = $1", [a]); // free the dedupe path; lead b reuses the address
    const b = await w.lead({ email: "shared@test.invalid" });
    const mid = await w.counts();
    const r2 = await w.http("POST", `/crm/leads/${b}/convert`, w.T.admin, { passport_number: "P-402", createPortalLogin: true });
    assert.equal(r2.status, 409, JSON.stringify(r2.body));
    assert.deepEqual(await w.counts(), mid);
    // Without portal login the same lead converts.
    assert.equal((await w.http("POST", `/crm/leads/${b}/convert`, w.T.admin, { passport_number: "P-402", createPortalLogin: false })).status, 201);
  });
});

test("mail failure does not roll back the conversion; inviteSent=false", async () => {
  await withWorld(async (w) => {
    // A sandbox allowlist that excludes the recipient makes the mail adapter refuse delivery.
    process.env.MAIL_SANDBOX_ALLOWLIST = "nobody@elsewhere.invalid";
    try {
      const id = await w.lead({ email: "blocked@test.invalid" });
      const r = await w.http("POST", `/crm/leads/${id}/convert`, w.T.admin, { passport_number: "P-500", createPortalLogin: true });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.created, true);
      assert.equal(r.body.portal.inviteSent, false);
      assert.equal((await w.one("SELECT status FROM crm_leads WHERE id=$1", [id])).status, "converted");
      assert.equal((await w.q("SELECT 1 FROM js_candidate_accounts WHERE user_id=$1", [r.body.portal.userId])).rowCount, 1);
    } finally {
      delete process.env.MAIL_SANDBOX_ALLOWLIST;
    }
  });
});

test("permissions: Agent only on own leads (foreign 404, own needs leads:write), Accountant/HR/Candidate denied", async () => {
  await withWorld(async (w) => {
    const own = await w.lead({ assignedTo: w.ids.agentA });
    const foreign = await w.lead({ assignedTo: w.ids.agentB });
    const before = await w.counts();
    assert.equal((await w.http("POST", `/crm/leads/${foreign}/convert`, w.T.agentA, { passport_number: "P-600" })).status, 404);
    assert.equal((await w.http("POST", `/crm/leads/${own}/convert`, w.T.agentA, { passport_number: "P-601", createPortalLogin: false })).status, 403, "Agents hold leads:read only");
    for (const k of ["acct", "hr", "cand"]) assert.equal((await w.http("POST", `/crm/leads/${own}/convert`, w.T[k], { passport_number: "P-602" })).status, 403, k);
    assert.equal((await w.http("POST", `/crm/leads/${own}/convert`, null, { passport_number: "P-602" })).status, 401);
    assert.deepEqual(await w.counts(), before);
    // Manager (leads:write + candidates:write) may convert any lead.
    assert.equal((await w.http("POST", `/crm/leads/${foreign}/convert`, w.T.mgr, { passport_number: "P-603", createPortalLogin: false })).status, 201);
  });
});

test("stage change writes timeline + audit; timeline lists newest data oldest first; invalid stage 400; scope", async () => {
  await withWorld(async (w) => {
    const id = await w.lead({ assignedTo: w.ids.agentA });
    const conv = await w.http("POST", `/crm/leads/${id}/convert`, w.T.admin, { passport_number: "P-700", createPortalLogin: false });
    const cid = conv.body.candidate.id;
    assert.equal(conv.body.candidate.crm_stage, "lead");

    const ok = await w.http("PATCH", `/crm/candidates/${cid}/stage`, w.T.agentA, { stage: "documents" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.crm_stage, "documents");
    assert.equal((await w.one("SELECT crm_stage FROM candidates WHERE id=$1", [cid])).crm_stage, "documents");
    assert.equal((await w.q("SELECT 1 FROM audit_logs WHERE action='crm.candidate.stage' AND record_id=$1", [String(cid)])).rowCount, 1);

    const tl = await w.http("GET", `/crm/candidates/${cid}/timeline`, w.T.agentA);
    assert.equal(tl.status, 200);
    const ev = tl.body.map((e) => e.event);
    assert.ok(ev.includes("stage_changed"));
    const sc = tl.body.find((e) => e.event === "stage_changed");
    assert.deepEqual(sc.detail, { from: "lead", to: "documents" });
    assert.equal(sc.entity, "candidate");

    const nTl = (await w.one("SELECT count(*) AS n FROM crm_timeline")).n;
    for (const bad of ["Documents", "nope", "", null, 5, undefined]) {
      assert.equal((await w.http("PATCH", `/crm/candidates/${cid}/stage`, w.T.admin, bad === undefined ? {} : { stage: bad })).status, 400, String(bad));
    }
    assert.equal((await w.one("SELECT count(*) AS n FROM crm_timeline")).n, nTl);
    // Same stage again is a no-op (no duplicate history).
    assert.equal((await w.http("PATCH", `/crm/candidates/${cid}/stage`, w.T.admin, { stage: "documents" })).status, 200);
    assert.equal((await w.one("SELECT count(*) AS n FROM crm_timeline")).n, nTl);

    // Scope: another Agent gets 404; a missing candidate 404; Accountant/HR/Candidate 403.
    assert.equal((await w.http("PATCH", `/crm/candidates/${cid}/stage`, w.T.agentB, { stage: "visa" })).status, 404);
    assert.equal((await w.http("GET", `/crm/candidates/${cid}/timeline`, w.T.agentB)).status, 404);
    assert.equal((await w.http("PATCH", `/crm/candidates/999999/stage`, w.T.admin, { stage: "visa" })).status, 404);
    for (const k of ["acct", "hr", "cand"]) {
      assert.equal((await w.http("PATCH", `/crm/candidates/${cid}/stage`, w.T[k], { stage: "visa" })).status, 403, k);
      assert.equal((await w.http("GET", `/crm/candidates/${cid}/timeline`, w.T[k])).status, 403, k);
    }
    assert.equal((await w.one("SELECT crm_stage FROM candidates WHERE id=$1", [cid])).crm_stage, "documents");
  });
});

test("a Candidate token is denied on every /crm route", async () => {
  await withWorld(async (w) => {
    const routes = [
      ["GET", "/crm/leads"],
      ["GET", "/crm/leads/1"],
      ["PATCH", "/crm/leads/1", { status: "contacted" }],
      ["POST", "/crm/leads/1/notes", { text: "x" }],
      ["POST", "/crm/leads/1/convert", { passport_number: "X" }],
      ["PATCH", "/crm/candidates/1/stage", { stage: "visa" }],
      ["GET", "/crm/candidates/1/timeline"],
    ];
    for (const [m, u, b] of routes) assert.equal((await w.http(m, u, w.T.cand, b)).status, 403, `${m} ${u}`);
  });
});
