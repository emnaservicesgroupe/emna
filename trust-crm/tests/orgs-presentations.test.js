// Task 4 (portals): share consents, staff employer-request review, candidate presentations, employer-side reads/respond.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "orgs-presentations-test-secret";

const KEYS = ["profession", "years_experience", "languages", "country_of_residence", "availability", "staff_note_for_employer"].sort();
const SECRETS = ["P1234567", "leaky@secret.example", "+49 170 5551234", "1990-01-02", "Secret Name"];

async function withWorld(fn) {
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
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text };
  };
  const q = (sql, p) => pool.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  const roles = { admin: "Admin", mgr: "Manager", rec: "Receptionist", agentA: "Agent", agentB: "Agent", acct: "Accountant", hr: "HR" };
  const ids = {};
  for (const [k, role] of Object.entries(roles)) ids[k] = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`${role} ${k}`, `${k}@pres.test.invalid`, role])).id;
  ids.cand = (await one("INSERT INTO users (full_name,email,password,role) VALUES ('C','cand@pres.test.invalid','x','Candidate') RETURNING id")).id;
  const T = Object.fromEntries(Object.keys(ids).map((k) => [k, jwt.sign({ id: ids[k], role: k === "cand" ? "Candidate" : roles[k], ...(k === "cand" ? { tv: 0 } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" })]));
  let n = 0;
  const mkCand = async (assignedTo = ids.agentA, { profile = true } = {}) => {
    n += 1;
    const id = (await one("INSERT INTO candidates (full_name, passport_number, assigned_to, email, phone) VALUES ($1,$2,$3,$4,$5) RETURNING id", ["Secret Name", `P1234567-${n}`, assignedTo, "leaky@secret.example", "+49 170 5551234"])).id;
    if (profile) {
      await q(
        `INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1,$2::jsonb,'confirmed',now())`,
        [id, JSON.stringify({
          name: "Secret Name", email: "leaky@secret.example", phone: "+49 170 5551234", passport: "P1234567", dob: "1990-01-02",
          profession: "Welder", skills: ["MIG"], education: [{ x: 1 }],
          languages: [{ lang: "Arabic", level: "native" }, { lang: "German", level: "B1" }],
          experience: [{ title: "Welder", employer: "SecretCorp", start: "2015-01", end: "2020-01" }],
        })]
      );
      await q("INSERT INTO js_preferences (candidate_id, availability, residence_country) VALUES ($1,'immediately','Tunisia')", [id]);
    }
    return id;
  };
  const mkReq = async (employerId, status = "in_review") => (await one("INSERT INTO employer_requests (employer_id,title,country,description,status,staff_note) VALUES ($1,'Welders','Germany','Weld',$2,'INTERNAL') RETURNING id", [employerId, status])).id;
  try {
    await fn({ pool, q, one, http, ids, T, mkCand, mkReq });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

const consent = (w, cand, emp, tok = "admin") => w.http("POST", `/crm/candidates/${cand}/share-consents`, w.T[tok], { employer_id: emp, basis: "signed form 2026-10-01" });

test("share consent: record, duplicate 409, list, withdraw, re-record, validation, timeline + audit", async () => {
  await withWorld(async (w) => {
    const emp = await createEmployerUser(w.pool);
    const cand = await w.mkCand();
    const r = await consent(w, cand, emp.orgId);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.withdrawn_at, null);
    assert.equal((await consent(w, cand, emp.orgId)).status, 409);
    for (const bad of [{ employer_id: emp.orgId }, { employer_id: emp.orgId, basis: "" }, { employer_id: emp.orgId, basis: "x".repeat(501) }, { employer_id: emp.orgId, basis: 5 }, { basis: "b" }, { employer_id: emp.orgId, basis: "b", x: 1 }, { employer_id: "abc", basis: "b" }]) {
      assert.equal((await w.http("POST", `/crm/candidates/${cand}/share-consents`, w.T.admin, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await w.http("POST", `/crm/candidates/${cand}/share-consents`, w.T.admin, { employer_id: 999999, basis: "b" })).status, 404);
    const list = await w.http("GET", `/crm/candidates/${cand}/share-consents`, w.T.admin);
    assert.equal(list.body.rows.length, 1);
    const del = await w.http("DELETE", `/crm/candidates/${cand}/share-consents/${r.body.id}`, w.T.admin);
    assert.equal(del.status, 200);
    assert.ok(del.body.withdrawn_at);
    assert.equal((await w.http("DELETE", `/crm/candidates/${cand}/share-consents/${r.body.id}`, w.T.admin)).status, 409);
    assert.equal((await w.http("DELETE", `/crm/candidates/${cand}/share-consents/99999`, w.T.admin)).status, 404);
    assert.equal((await consent(w, cand, emp.orgId)).status, 201, "re-record after withdrawal");
    const tl = (await w.q("SELECT event FROM crm_timeline WHERE entity='share_consent' ORDER BY id")).rows.map((x) => x.event);
    assert.deepEqual(tl, ["recorded", "withdrawn", "recorded"]);
    const audit = (await w.q("SELECT action FROM audit_logs WHERE table_name='candidate_share_consents' ORDER BY id")).rows.map((x) => x.action);
    assert.deepEqual(audit, ["crm.share_consent.record", "crm.share_consent.withdraw", "crm.share_consent.record"]);
  });
});

test("share consent: candidate scope and roles", async () => {
  await withWorld(async (w) => {
    const emp = await createEmployerUser(w.pool);
    const cand = await w.mkCand(w.ids.agentA);
    assert.equal((await consent(w, cand, emp.orgId, "agentB")).status, 404, "other agent");
    assert.equal((await w.http("GET", `/crm/candidates/${cand}/share-consents`, w.T.agentB)).status, 404);
    assert.equal((await consent(w, cand, emp.orgId, "mgr")).status, 404, "manager only sees assigned");
    for (const k of ["acct", "hr", "cand"]) assert.equal((await consent(w, cand, emp.orgId, k)).status, 403, k);
    assert.equal((await w.http("GET", `/crm/candidates/${cand}/share-consents`, w.T.cand)).status, 403);
    assert.equal((await consent(w, cand, emp.orgId, "agentA")).status, 201, "owning agent");
    const agency = await createAgencyUser(w.pool);
    assert.equal((await w.http("GET", `/crm/candidates/${cand}/share-consents`, emp.token)).status, 403);
    assert.equal((await w.http("GET", `/crm/candidates/${cand}/share-consents`, agency.token)).status, 403);
    assert.equal((await w.http("GET", `/crm/candidates/${cand}/share-consents`)).status, 401);
  });
});

test("staff employer requests: list filters, detail with staff_note, status transitions, notes", async () => {
  await withWorld(async (w) => {
    const e1 = await createEmployerUser(w.pool, { orgName: "Alpha GmbH" });
    const e2 = await createEmployerUser(w.pool, { orgName: "Beta Ltd" });
    const r1 = await w.mkReq(e1.orgId, "submitted");
    await w.mkReq(e2.orgId, "in_review");
    const all = await w.http("GET", "/crm/employer-requests", w.T.rec);
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 2);
    assert.equal((await w.http("GET", `/crm/employer-requests?status=in_review`, w.T.rec)).body.total, 1);
    assert.equal((await w.http("GET", `/crm/employer-requests?employer_id=${e1.orgId}`, w.T.rec)).body.total, 1);
    assert.equal((await w.http("GET", `/crm/employer-requests?q=alpha`, w.T.rec)).body.total, 1);
    assert.equal((await w.http("GET", `/crm/employer-requests?status=bogus`, w.T.rec)).status, 400);
    const d = await w.http("GET", `/crm/employer-requests/${r1}`, w.T.rec);
    assert.equal(d.body.staff_note, "INTERNAL");
    assert.deepEqual(d.body.presentations, []);
    // transitions
    const p = (body, tok = "mgr") => w.http("PATCH", `/crm/employer-requests/${r1}`, w.T[tok], body);
    assert.equal((await p({ status: "accepted" })).status, 409, "submitted -> accepted invalid");
    assert.equal((await p({ status: "bogus" })).status, 400);
    assert.equal((await p({ status: "submitted" })).status, 400);
    assert.equal((await p({ foo: 1 })).status, 400);
    assert.equal((await p({})).status, 400);
    assert.equal((await p({ status: "in_review", staff_note: "call them", employer_visible_note: "We are on it" })).status, 200);
    assert.equal((await p({ status: "accepted" })).status, 200);
    assert.equal((await p({ status: "filled" })).status, 200);
    assert.equal((await p({ status: "in_review" })).status, 409, "terminal");
    assert.equal((await p({ employer_visible_note: "x".repeat(1001) })).status, 400);
    const row = await w.one("SELECT status, staff_note, employer_visible_note FROM employer_requests WHERE id=$1", [r1]);
    assert.deepEqual(row, { status: "filled", staff_note: "call them", employer_visible_note: "We are on it" });
    const tl = (await w.q("SELECT event, detail FROM crm_timeline WHERE entity='employer_request' AND entity_id=$1 ORDER BY id", [r1])).rows;
    assert.equal(tl.filter((x) => x.event === "status_changed").length, 3);
    assert.ok((await w.q("SELECT 1 FROM audit_logs WHERE action='crm.employer_request.update' AND record_id=$1", [String(r1)])).rowCount >= 3);
    // employer sees visible note, never staff note
    const emp = await w.http("GET", `/employer/requests/${r1}`, e1.token);
    assert.equal(emp.body.employer_visible_note, "We are on it");
    assert.ok(!emp.text.includes("call them"));
  });
});

test("create-site-job makes a draft, links it, never publishes, once only", async () => {
  await withWorld(async (w) => {
    const e = await createEmployerUser(w.pool, { orgName: "Gamma AG" });
    const rid = await w.mkReq(e.orgId, "in_review");
    const sub = await w.mkReq(e.orgId, "submitted");
    assert.equal((await w.http("POST", `/crm/employer-requests/${sub}/create-site-job`, w.T.admin)).status, 409);
    for (const k of ["rec", "agentA", "acct", "hr", "cand"]) assert.equal((await w.http("POST", `/crm/employer-requests/${rid}/create-site-job`, w.T[k])).status, 403, k);
    const r = await w.http("POST", `/crm/employer-requests/${rid}/create-site-job`, w.T.admin);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.site_job.status, "draft");
    assert.equal(r.body.site_job.published_at, null);
    assert.equal(r.body.site_job.employer_name, null);
    const row = await w.one("SELECT sj.status, er.site_job_id FROM employer_requests er JOIN site_jobs sj ON sj.id=er.site_job_id WHERE er.id=$1", [rid]);
    assert.equal(row.status, "draft");
    assert.equal((await w.http("POST", `/crm/employer-requests/${rid}/create-site-job`, w.T.admin)).status, 409);
    assert.equal((await w.q("SELECT 1 FROM site_jobs")).rowCount, 1);
    const pub = await w.http("GET", "/public/jobs");
    assert.ok(!(pub.text || "").includes("Welders"), "draft is not public");
    assert.ok((await w.q("SELECT 1 FROM crm_timeline WHERE entity='employer_request' AND event='site_job_created'")).rowCount === 1);
  });
});

test("present: exact allowlist snapshot from confirmed profile, no leakage, consent gate, duplicate, status gate", async () => {
  await withWorld(async (w) => {
    const emp = await createEmployerUser(w.pool);
    const rid = await w.mkReq(emp.orgId);
    const cand = await w.mkCand();
    const url = `/crm/employer-requests/${rid}/presentations`;
    const noConsent = await w.http("POST", url, w.T.admin, { candidate_id: cand });
    assert.equal(noConsent.status, 409);
    assert.match(noConsent.body.error, /consent/i);
    await consent(w, cand, emp.orgId);
    const ok = await w.http("POST", url, w.T.admin, { candidate_id: cand, staff_note_for_employer: "Strong welder" });
    assert.equal(ok.status, 201, ok.text);
    assert.deepEqual(Object.keys(ok.body.summary).sort(), KEYS);
    assert.equal(ok.body.summary.profession, "Welder");
    assert.equal(ok.body.summary.years_experience, 5);
    assert.deepEqual(ok.body.summary.languages, ["Arabic (native)", "German (B1)"]);
    assert.equal(ok.body.summary.country_of_residence, "Tunisia");
    assert.equal(ok.body.summary.availability, "immediately");
    assert.equal(ok.body.summary.staff_note_for_employer, "Strong welder");
    const stored = await w.one("SELECT summary FROM employer_presentations WHERE id=$1", [ok.body.id]);
    assert.deepEqual(Object.keys(stored.summary).sort(), KEYS);
    const storedText = JSON.stringify(stored.summary);
    for (const s of SECRETS.concat(["SecretCorp", "MIG"])) assert.ok(!storedText.includes(s), `snapshot leaks ${s}`);
    assert.equal((await w.http("POST", url, w.T.admin, { candidate_id: cand })).status, 409, "duplicate");
    // employer view
    const list = await w.http("GET", "/employer/presentations", emp.token);
    assert.equal(list.status, 200);
    assert.equal(list.body.presentations.length, 1);
    const item = list.body.presentations[0];
    assert.deepEqual(Object.keys(item).sort(), ["created_at", "employer_note", "id", "request_id", "request_title", "responded_at", "status", "summary"]);
    assert.deepEqual(Object.keys(item.summary).sort(), KEYS);
    for (const s of SECRETS.concat([`"candidate_id"`, "INTERNAL", "assigned_to"])) assert.ok(!list.text.includes(s), `employer list leaks ${s}`);
    const det = await w.http("GET", `/employer/presentations/${item.id}`, emp.token);
    assert.equal(det.status, 200);
    assert.deepEqual(Object.keys(det.body.summary).sort(), KEYS);
    for (const s of SECRETS) assert.ok(!det.text.includes(s));
    // tampered stored jsonb is re-filtered at read time
    await w.q("UPDATE employer_presentations SET summary = summary || '{\"email\":\"leaky@secret.example\",\"passport\":\"P1234567\"}'::jsonb WHERE id=$1", [item.id]);
    const tam = await w.http("GET", `/employer/presentations/${item.id}`, emp.token);
    assert.deepEqual(Object.keys(tam.body.summary).sort(), KEYS);
    assert.ok(!tam.text.includes("leaky@secret.example"));
    // status gate
    const sub = await w.mkReq(emp.orgId, "submitted");
    assert.equal((await w.http("POST", `/crm/employer-requests/${sub}/presentations`, w.T.admin, { candidate_id: cand })).status, 409);
    const dec = await w.mkReq(emp.orgId, "declined");
    assert.equal((await w.http("POST", `/crm/employer-requests/${dec}/presentations`, w.T.admin, { candidate_id: cand })).status, 409);
    // audit + timeline
    assert.equal((await w.q("SELECT 1 FROM crm_timeline WHERE entity='presentation' AND event='presented'")).rowCount, 1);
    assert.equal((await w.q("SELECT 1 FROM audit_logs WHERE action='crm.presentation.create'")).rowCount, 1);
  });
});

test("present: staff-supplied summary when no confirmed profile; unknown keys and bad types 400", async () => {
  await withWorld(async (w) => {
    const emp = await createEmployerUser(w.pool);
    const rid = await w.mkReq(emp.orgId, "accepted");
    const cand = await w.mkCand(w.ids.agentA, { profile: false });
    await consent(w, cand, emp.orgId);
    const url = `/crm/employer-requests/${rid}/presentations`;
    assert.equal((await w.http("POST", url, w.T.admin, { candidate_id: cand })).status, 400, "nothing to snapshot");
    const bads = [
      { x: 1 }, { email: "a@b.c" }, { profession: 5 }, { profession: "x".repeat(121) }, { years_experience: 1.5 }, { years_experience: -1 },
      { languages: "Arabic" }, { languages: [1] }, { languages: new Array(11).fill("a") }, { passport: "P1" }, "str",
    ];
    for (const summary of bads) assert.equal((await w.http("POST", url, w.T.admin, { candidate_id: cand, summary })).status, 400, JSON.stringify(summary));
    assert.equal((await w.http("POST", url, w.T.admin, { candidate_id: cand, extra: 1, summary: { profession: "Cook" } })).status, 400);
    const ok = await w.http("POST", url, w.T.admin, { candidate_id: cand, summary: { profession: "Cook", years_experience: 7, languages: ["French"], country_of_residence: "Tunisia", availability: "1 month" } });
    assert.equal(ok.status, 201, ok.text);
    assert.deepEqual(Object.keys(ok.body.summary).sort(), KEYS);
    assert.equal(ok.body.summary.profession, "Cook");
    assert.equal(ok.body.summary.staff_note_for_employer, null);
  });
});

test("staff scope and roles on presenting; presentations list/withdraw", async () => {
  await withWorld(async (w) => {
    const emp = await createEmployerUser(w.pool);
    const rid = await w.mkReq(emp.orgId);
    const mine = await w.mkCand(w.ids.mgr);
    const foreign = await w.mkCand(w.ids.agentA);
    await consent(w, mine, emp.orgId);
    await consent(w, foreign, emp.orgId);
    const url = `/crm/employer-requests/${rid}/presentations`;
    assert.equal((await w.http("POST", url, w.T.mgr, { candidate_id: foreign })).status, 404, "candidate of another staff");
    for (const k of ["agentA", "agentB", "acct", "hr", "cand", "rec"]) assert.equal((await w.http("POST", url, w.T[k], { candidate_id: mine })).status, 403, k);
    assert.equal((await w.http("POST", url, emp.token, { candidate_id: mine })).status, 403);
    assert.equal((await w.http("POST", url, w.T.mgr, { candidate_id: 999999 })).status, 404);
    const p1 = await w.http("POST", url, w.T.mgr, { candidate_id: mine });
    assert.equal(p1.status, 201);
    const p2 = await w.http("POST", url, w.T.admin, { candidate_id: foreign });
    assert.equal(p2.status, 201);
    // list scoping: manager sees only own candidate's presentation, admin sees both
    assert.equal((await w.http("GET", "/crm/presentations", w.T.mgr)).body.total, 1);
    assert.equal((await w.http("GET", "/crm/presentations", w.T.admin)).body.total, 2);
    assert.equal((await w.http("GET", "/crm/presentations?status=presented&request_id=" + rid, w.T.admin)).body.total, 2);
    assert.equal((await w.http("GET", "/crm/presentations?status=bogus", w.T.admin)).status, 400);
    assert.equal((await w.http("GET", `/crm/employer-requests/${rid}`, w.T.mgr)).body.presentations.length, 1);
    assert.equal((await w.http("GET", `/crm/employer-requests/${rid}`, w.T.admin)).body.presentations.length, 2);
    for (const k of ["agentA", "acct", "hr", "cand"]) assert.equal((await w.http("GET", "/crm/presentations", w.T[k])).status, 403, k);
    // withdraw
    assert.equal((await w.http("PATCH", `/crm/presentations/${p2.body.id}/withdraw`, w.T.mgr)).status, 404, "foreign scope");
    assert.equal((await w.http("PATCH", `/crm/presentations/${p1.body.id}/withdraw`, w.T.rec)).status, 403);
    const wd = await w.http("PATCH", `/crm/presentations/${p1.body.id}/withdraw`, w.T.mgr);
    assert.equal(wd.status, 200);
    assert.equal(wd.body.status, "withdrawn");
    assert.equal((await w.http("PATCH", `/crm/presentations/${p1.body.id}/withdraw`, w.T.mgr)).status, 409);
    const eList = await w.http("GET", "/employer/presentations", emp.token);
    assert.equal(eList.body.presentations.length, 1, "withdrawn hidden from employer");
    assert.equal((await w.http("POST", `/employer/presentations/${p1.body.id}/respond`, emp.token, { status: "interested" })).status, 404);
    assert.ok((await w.q("SELECT 1 FROM crm_timeline WHERE entity='presentation' AND event='withdrawn'")).rowCount === 1);
  });
});

test("employer respond transitions, validation, audit/timeline as employer actor", async () => {
  await withWorld(async (w) => {
    const emp = await createEmployerUser(w.pool);
    const rid = await w.mkReq(emp.orgId);
    const cand = await w.mkCand();
    await consent(w, cand, emp.orgId);
    const pid = (await w.http("POST", `/crm/employer-requests/${rid}/presentations`, w.T.admin, { candidate_id: cand })).body.id;
    const respond = (b, tok = emp.token) => w.http("POST", `/employer/presentations/${pid}/respond`, tok, b);
    for (const bad of [{}, { status: "presented" }, { status: "withdrawn" }, { status: "hired" }, { status: "interested", note: "x".repeat(1001) }, { status: "interested", note: 5 }, { status: "interested", extra: 1 }]) {
      assert.equal((await respond(bad)).status, 400, JSON.stringify(bad));
    }
    const a = await respond({ status: "interested", note: "Looks good" });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.body.status, "interested");
    assert.equal(a.body.employer_note, "Looks good");
    assert.ok(a.body.responded_at);
    assert.deepEqual(Object.keys(a.body.summary).sort(), KEYS);
    assert.equal((await respond({ status: "interview" })).body.status, "interview", "change of mind allowed");
    assert.equal((await respond({ status: "not_suitable", note: "no" })).body.status, "not_suitable");
    const tl = (await w.q("SELECT actor_id, event FROM crm_timeline WHERE entity='presentation' AND event='employer_responded'")).rows;
    assert.equal(tl.length, 3);
    assert.ok(tl.every((x) => x.actor_id === emp.userId));
    const au = (await w.q("SELECT user_id FROM audit_logs WHERE action='employer.presentation.respond'")).rows;
    assert.equal(au.length, 3);
    assert.ok(au.every((x) => x.user_id === emp.userId));
    // staff sees the response
    const det = await w.http("GET", `/crm/employer-requests/${rid}`, w.T.admin);
    assert.equal(det.body.presentations[0].status, "not_suitable");
    assert.equal(det.body.presentations[0].employer_note, "no");
  });
});

test("withdrawing the share consent hides existing presentations at once and blocks respond", async () => {
  await withWorld(async (w) => {
    const emp = await createEmployerUser(w.pool);
    const rid = await w.mkReq(emp.orgId);
    const cand = await w.mkCand();
    const c = await consent(w, cand, emp.orgId);
    const pid = (await w.http("POST", `/crm/employer-requests/${rid}/presentations`, w.T.admin, { candidate_id: cand })).body.id;
    assert.equal((await w.http("GET", "/employer/presentations", emp.token)).body.presentations.length, 1);
    assert.equal((await w.http("DELETE", `/crm/candidates/${cand}/share-consents/${c.body.id}`, w.T.admin)).status, 200);
    const list = await w.http("GET", "/employer/presentations", emp.token);
    assert.equal(list.body.presentations.length, 0);
    assert.equal(list.body.total, 0);
    const miss = await w.http("GET", `/employer/presentations/99999999`, emp.token);
    const hidden = await w.http("GET", `/employer/presentations/${pid}`, emp.token);
    assert.equal(hidden.status, 404);
    assert.equal(hidden.text, miss.text, "identical 404");
    assert.equal((await w.http("POST", `/employer/presentations/${pid}/respond`, emp.token, { status: "interested" })).status, 404);
    assert.equal((await w.one("SELECT status FROM employer_presentations WHERE id=$1", [pid])).status, "presented");
    // new presentation of same candidate needs a fresh consent
    const rid2 = await w.mkReq(emp.orgId);
    assert.equal((await w.http("POST", `/crm/employer-requests/${rid2}/presentations`, w.T.admin, { candidate_id: cand })).status, 409);
    // re-consent restores visibility
    await consent(w, cand, emp.orgId);
    assert.equal((await w.http("GET", "/employer/presentations", emp.token)).body.presentations.length, 1);
  });
});

test("consent is per employer: another employer's consent does not open a presentation", async () => {
  await withWorld(async (w) => {
    const e1 = await createEmployerUser(w.pool);
    const e2 = await createEmployerUser(w.pool);
    const rid2 = await w.mkReq(e2.orgId);
    const cand = await w.mkCand();
    await consent(w, cand, e1.orgId);
    assert.equal((await w.http("POST", `/crm/employer-requests/${rid2}/presentations`, w.T.admin, { candidate_id: cand })).status, 409);
  });
});

test("cross-employer isolation: foreign presentation is 404 for read and respond", async () => {
  await withWorld(async (w) => {
    const e1 = await createEmployerUser(w.pool);
    const e2 = await createEmployerUser(w.pool);
    const rid = await w.mkReq(e1.orgId);
    const cand = await w.mkCand();
    await consent(w, cand, e1.orgId);
    const pid = (await w.http("POST", `/crm/employer-requests/${rid}/presentations`, w.T.admin, { candidate_id: cand })).body.id;
    assert.equal((await w.http("GET", "/employer/presentations", e2.token)).body.presentations.length, 0);
    const foreign = await w.http("GET", `/employer/presentations/${pid}`, e2.token);
    const missing = await w.http("GET", `/employer/presentations/99999999`, e2.token);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.text, missing.text);
    assert.equal((await w.http("POST", `/employer/presentations/${pid}/respond`, e2.token, { status: "interested" })).status, 404);
    assert.equal((await w.http("GET", `/employer/presentations/abc`, e1.token)).status, 400);
    assert.equal((await w.one("SELECT status FROM employer_presentations WHERE id=$1", [pid])).status, "presented");
  });
});

test("role matrix: staff routes deny Agent/Accountant/HR/Candidate/Agency/Employer; employer routes deny everyone else", async () => {
  await withWorld(async (w) => {
    const emp = await createEmployerUser(w.pool);
    const agency = await createAgencyUser(w.pool);
    const rid = await w.mkReq(emp.orgId);
    const cand = await w.mkCand();
    const staffReads = ["/crm/employer-requests", `/crm/employer-requests/${rid}`, "/crm/presentations"];
    for (const url of staffReads) {
      for (const k of ["agentA", "acct", "hr", "cand"]) assert.equal((await w.http("GET", url, w.T[k])).status, 403, `${url} ${k}`);
      for (const t of [emp.token, agency.token]) assert.equal((await w.http("GET", url, t)).status, 403, `${url} portal`);
      assert.equal((await w.http("GET", url)).status, 401);
      assert.equal((await w.http("GET", url, w.T.rec)).status, 200, `${url} receptionist reads`);
    }
    for (const [m, url, b] of [
      ["PATCH", `/crm/employer-requests/${rid}`, { staff_note: "x" }],
      ["POST", `/crm/employer-requests/${rid}/create-site-job`, undefined],
      ["POST", `/crm/employer-requests/${rid}/presentations`, { candidate_id: cand }],
      ["PATCH", `/crm/presentations/1/withdraw`, undefined],
    ]) {
      for (const k of ["rec", "agentA", "acct", "hr", "cand"]) assert.equal((await w.http(m, url, w.T[k], b)).status, 403, `${m} ${url} ${k}`);
      for (const t of [emp.token, agency.token]) assert.equal((await w.http(m, url, t, b)).status, 403, `${m} ${url} portal`);
    }
    for (const [m, url, b] of [
      ["GET", "/employer/presentations"],
      ["GET", "/employer/presentations/1"],
      ["POST", "/employer/presentations/1/respond", { status: "interested" }],
    ]) {
      for (const k of ["admin", "mgr", "agentA", "acct", "hr", "cand"]) assert.equal((await w.http(m, url, w.T[k], b)).status, 403, `${m} ${url} ${k}`);
      assert.equal((await w.http(m, url, agency.token, b)).status, 403, `${m} ${url} agency`);
      assert.equal((await w.http(m, url, null, b)).status, 401);
    }
  });
});
