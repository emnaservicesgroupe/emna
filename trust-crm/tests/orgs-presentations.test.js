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
    assert.deepEqual(Object.keys(item).sort(), ["closed", "created_at", "employer_note", "id", "request_id", "request_title", "responded_at", "status", "summary"]);
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
    // a NEW consent does not revive the old presentation (it is bound to the consent it was made under)
    await consent(w, cand, emp.orgId);
    assert.equal((await w.http("GET", "/employer/presentations", emp.token)).body.presentations.length, 0);
    assert.equal((await w.http("GET", `/employer/presentations/${pid}`, emp.token)).status, 404);
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

test("presentation-preview: returns the exact summary POST stores, never writes, honours consent/scope/roles", async () => {
  await withWorld(async (w) => {
    const emp = await createEmployerUser(w.pool);
    const rid = await w.mkReq(emp.orgId);
    const cand = await w.mkCand();
    const bare = await w.mkCand(w.ids.agentA, { profile: false });
    const prev = (q, tok = "admin", id = rid) => w.http("GET", `/crm/employer-requests/${id}/presentation-preview?${q}`, w.T[tok]);
    const counts = async () => [(await w.q("SELECT 1 FROM employer_presentations")).rowCount, (await w.q("SELECT 1 FROM audit_logs")).rowCount, (await w.q("SELECT 1 FROM crm_timeline")).rowCount];

    // no consent yet: the preview still shows what WOULD be shared, flagged as not presentable
    const p0 = await prev(`candidate_id=${cand}&staff_note_for_employer=${encodeURIComponent("Strong welder")}`);
    assert.equal(p0.status, 200, p0.text);
    assert.equal(p0.body.consent_active, false);
    assert.equal(p0.body.presentable, false);
    assert.equal(p0.body.already_presented, false);
    assert.equal(p0.body.needs_summary, false);
    assert.deepEqual(Object.keys(p0.body.summary).sort(), KEYS);
    for (const s of SECRETS.concat(["SecretCorp", "MIG", "INTERNAL"])) assert.ok(!p0.text.includes(s), `preview leaks ${s}`);

    await consent(w, cand, emp.orgId);
    const before = await counts();
    const p1 = await prev(`candidate_id=${cand}&staff_note_for_employer=${encodeURIComponent("Strong welder")}`);
    assert.equal(p1.body.consent_active, true);
    assert.equal(p1.body.presentable, true);
    assert.deepEqual(p1.body.summary, p0.body.summary);
    assert.deepEqual(await counts(), before, "a preview never writes (no presentation, audit or timeline row)");

    // identical to what the POST stores
    const posted = await w.http("POST", `/crm/employer-requests/${rid}/presentations`, w.T.admin, { candidate_id: cand, staff_note_for_employer: "Strong welder" });
    assert.equal(posted.status, 201, posted.text);
    assert.deepEqual(posted.body.summary, p1.body.summary);
    assert.equal((await prev(`candidate_id=${cand}`)).body.already_presented, true);
    assert.equal((await prev(`candidate_id=${cand}`)).body.presentable, false);

    // no confirmed profile: needs_summary until staff supply fields (same validation and merge as POST)
    await consent(w, bare, emp.orgId);
    const n = await prev(`candidate_id=${bare}`);
    assert.equal(n.status, 200);
    assert.equal(n.body.needs_summary, true);
    assert.equal(n.body.summary, null);
    assert.equal(n.body.presentable, false);
    const f = await prev(`candidate_id=${bare}&profession=Plumber&years_experience=7&languages=${encodeURIComponent("Arabic, French")}&country_of_residence=Tunisia&availability=immediately&staff_note_for_employer=ok`);
    assert.equal(f.status, 200, f.text);
    assert.deepEqual(f.body.summary, { profession: "Plumber", years_experience: 7, languages: ["Arabic", "French"], country_of_residence: "Tunisia", availability: "immediately", staff_note_for_employer: "ok" });
    assert.equal(f.body.presentable, true);
    const posted2 = await w.http("POST", `/crm/employer-requests/${rid}/presentations`, w.T.admin, {
      candidate_id: bare, staff_note_for_employer: "ok",
      summary: { profession: "Plumber", years_experience: 7, languages: ["Arabic", "French"], country_of_residence: "Tunisia", availability: "immediately" },
    });
    assert.deepEqual(posted2.body.summary, f.body.summary);

    // validation: unknown/duplicate params, bad values, bad ids
    for (const q of [`candidate_id=${cand}&x=1`, `candidate_id=${cand}&candidate_id=${cand}`, `candidate_id=abc`, ``, `candidate_id=${bare}&years_experience=99999`, `candidate_id=${bare}&years_experience=-1`, `candidate_id=${bare}&profession=${"x".repeat(121)}`, `candidate_id=${bare}&languages=${encodeURIComponent(Array(11).fill("a").join(","))}`, `candidate_id=${cand}&staff_note_for_employer=${"x".repeat(1001)}`]) {
      assert.equal((await prev(q)).status, 400, q);
    }
    assert.equal((await prev(`candidate_id=999999`)).status, 404);
    assert.equal((await prev(`candidate_id=${cand}`, "admin", 999999)).status, 404);
    assert.equal((await prev(`candidate_id=${cand}`, "admin", "abc")).status, 400);

    // request status gate is reported, not thrown
    const sub = await w.mkReq(emp.orgId, "submitted");
    const s = await prev(`candidate_id=${cand}`, "admin", sub);
    assert.equal(s.status, 200);
    assert.equal(s.body.presentable, false);
    assert.equal(s.body.request_status, "submitted");

    // consent for a different employer does not count
    const other = await createEmployerUser(w.pool);
    const orid = await w.mkReq(other.orgId);
    assert.equal((await prev(`candidate_id=${cand}`, "admin", orid)).body.consent_active, false);

    // scope and roles
    const owned = await w.mkCand(w.ids.agentA);
    assert.equal((await prev(`candidate_id=${owned}`, "agentB")).status, 403, "agents lack orgs:write");
    assert.equal((await prev(`candidate_id=${owned}`, "mgr")).status, 404, "manager sees only assigned candidates");
    for (const k of ["rec", "agentA", "acct", "hr", "cand"]) assert.equal((await prev(`candidate_id=${owned}`, k)).status, 403, k);
    assert.equal((await w.http("GET", `/crm/employer-requests/${rid}/presentation-preview?candidate_id=${owned}`, emp.token)).status, 403);
    assert.equal((await w.http("GET", `/crm/employer-requests/${rid}/presentation-preview?candidate_id=${owned}`)).status, 401);
  });
});

// ---------- review round 1 ----------

const candidateModel = () => require("../models/candidateModel");
const setup = async (w, { status = "in_review" } = {}) => {
  const emp = await createEmployerUser(w.pool);
  const rid = await w.mkReq(emp.orgId, status);
  const cand = await w.mkCand();
  const c = await consent(w, cand, emp.orgId);
  const pr = await w.http("POST", `/crm/employer-requests/${rid}/presentations`, w.T.admin, { candidate_id: cand });
  assert.equal(pr.status, 201, pr.text);
  return { emp, rid, cand, consentId: c.body.id, pid: pr.body.id };
};

test("review 1: a soft-deleted candidate disappears from every employer read and respond; Admin can still withdraw consent and presentation", async () => {
  await withWorld(async (w) => {
    const { emp, cand, consentId, pid } = await setup(w);
    assert.equal((await w.http("GET", "/employer/presentations", emp.token)).body.presentations.length, 1);
    await candidateModel().softDeleteCandidate(cand);
    const list = await w.http("GET", "/employer/presentations", emp.token);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.presentations, []);
    assert.equal(list.body.total, 0);
    assert.equal((await w.http("GET", `/employer/presentations/${pid}`, emp.token)).status, 404);
    assert.equal((await w.http("POST", `/employer/presentations/${pid}/respond`, emp.token, { status: "interested" })).status, 404);
    assert.equal((await w.one("SELECT status FROM employer_presentations WHERE id=$1", [pid])).status, "presented");
    // staff withdraw paths are not blocked by the deletion
    const wp = await w.http("PATCH", `/crm/presentations/${pid}/withdraw`, w.T.admin);
    assert.equal(wp.status, 200, wp.text);
    assert.equal(wp.body.status, "withdrawn");
    const wc = await w.http("DELETE", `/crm/candidates/${cand}/share-consents/${consentId}`, w.T.admin);
    assert.equal(wc.status, 200, wc.text);
    assert.ok(wc.body.withdrawn_at);
  });
});

test("review 1: reassigned-away candidate: Admin can still withdraw; the former owner (out of scope) cannot", async () => {
  await withWorld(async (w) => {
    const { cand, consentId, pid } = await setup(w);
    await w.q("UPDATE candidates SET assigned_to=$2 WHERE id=$1", [cand, w.ids.agentB]);
    assert.equal((await w.http("DELETE", `/crm/candidates/${cand}/share-consents/${consentId}`, w.T.agentA)).status, 404, "out of scope stays 404");
    assert.equal((await w.http("DELETE", `/crm/candidates/${cand}/share-consents/${consentId}`, w.T.admin)).status, 200);
    await candidateModel().softDeleteCandidate(cand);
    assert.equal((await w.http("PATCH", `/crm/presentations/${pid}/withdraw`, w.T.mgr)).status, 404, "manager only sees assigned, non-deleted candidates");
    assert.equal((await w.http("PATCH", `/crm/presentations/${pid}/withdraw`, w.T.admin)).status, 200);
  });
});

test("review 1: a presentation is bound to the consent it was made under; a NEW consent does not revive it, a new presentation is required", async () => {
  await withWorld(async (w) => {
    const { emp, rid, cand, consentId, pid } = await setup(w);
    assert.equal(String((await w.one("SELECT consent_id FROM employer_presentations WHERE id=$1", [pid])).consent_id), String(consentId));
    assert.equal((await w.http("DELETE", `/crm/candidates/${cand}/share-consents/${consentId}`, w.T.admin)).status, 200);
    const c2 = await consent(w, cand, emp.orgId);
    assert.equal(c2.status, 201);
    assert.deepEqual((await w.http("GET", "/employer/presentations", emp.token)).body.presentations, []);
    assert.equal((await w.http("GET", `/employer/presentations/${pid}`, emp.token)).status, 404);
    assert.equal((await w.http("POST", `/employer/presentations/${pid}/respond`, emp.token, { status: "interested" })).status, 404);
    // staff see the old presentation as no longer under an active consent
    const staff = await w.http("GET", `/crm/employer-requests/${rid}`, w.T.admin);
    assert.equal(staff.body.presentations[0].consent_active, false);
    // a new presentation (same request) is created under the new consent and is visible again
    const again = await w.http("POST", `/crm/employer-requests/${rid}/presentations`, w.T.admin, { candidate_id: cand });
    assert.equal(again.status, 201, again.text);
    assert.equal(again.body.status, "presented");
    assert.equal(again.body.employer_note, null);
    assert.equal(String((await w.one("SELECT consent_id FROM employer_presentations WHERE request_id=$1 AND candidate_id=$2", [rid, cand])).consent_id), String(c2.body.id));
    const list = await w.http("GET", "/employer/presentations", emp.token);
    assert.equal(list.body.presentations.length, 1);
    // while the consent it was made under is still active, presenting again is still a duplicate
    assert.equal((await w.http("POST", `/crm/employer-requests/${rid}/presentations`, w.T.admin, { candidate_id: cand })).status, 409);
  });
});

test("review 1: respond needs an in_review/accepted request; closed requests stay visible read-only with closed=true", async () => {
  await withWorld(async (w) => {
    const { emp, rid, pid } = await setup(w);
    const respond = (b = { status: "interested" }) => w.http("POST", `/employer/presentations/${pid}/respond`, emp.token, b);
    let item = (await w.http("GET", `/employer/presentations/${pid}`, emp.token)).body;
    assert.equal(item.closed, false);
    assert.equal((await w.http("PATCH", `/crm/employer-requests/${rid}`, w.T.admin, { status: "accepted" })).status, 200);
    assert.equal((await respond()).status, 200, "accepted request accepts responses");
    for (const st of ["declined", "filled", "cancelled", "submitted"]) {
      await w.q("UPDATE employer_requests SET status=$2 WHERE id=$1", [rid, st]);
      const det = await w.http("GET", `/employer/presentations/${pid}`, emp.token);
      assert.equal(det.status, 200, st);
      assert.equal(det.body.closed, st !== "submitted", st);
      const list = await w.http("GET", "/employer/presentations", emp.token);
      assert.equal(list.body.presentations.length, 1, st);
      assert.equal(list.body.presentations[0].closed, st !== "submitted", st);
      const r = await respond({ status: "not_suitable" });
      assert.equal(r.status, 409, st);
      assert.equal((await w.one("SELECT status FROM employer_presentations WHERE id=$1", [pid])).status, "interested", `${st}: unchanged`);
    }
    await w.q("UPDATE employer_requests SET status='in_review' WHERE id=$1", [rid]);
    assert.equal((await respond({ status: "interview" })).status, 200);
  });
});

test("review 1: contact-like values are dropped from the frozen summary and reported; the staff note is rejected", async () => {
  await withWorld(async (w) => {
    const emp = await createEmployerUser(w.pool);
    const rid = await w.mkReq(emp.orgId);
    const cand = await w.mkCand(w.ids.agentA, { profile: false });
    await consent(w, cand, emp.orgId);
    const prev = (q) => w.http("GET", `/crm/employer-requests/${rid}/presentation-preview?candidate_id=${cand}&${q}`, w.T.admin);
    const base = "years_experience=7&country_of_residence=Tunisia&availability=immediately";
    const p = await prev(`${base}&profession=${encodeURIComponent("Welder, call +49 170 1234567")}&languages=${encodeURIComponent("Arabic, me@mail.example")}`);
    assert.equal(p.status, 200, p.text);
    assert.equal(p.body.summary.profession, null);
    assert.equal(p.body.summary.languages, null);
    assert.equal(p.body.summary.years_experience, 7);
    assert.deepEqual(p.body.redacted.sort(), ["languages", "profession"]);
    for (const bad of ["x@y.z", "see https://evil.example/x", "www.example.com", "ftp://h/x", "00 49-170 12 34"]) {
      const r = await prev(`years_experience=3&profession=Welder&country_of_residence=Tunisia&availability=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 200, bad);
      assert.equal(r.body.summary.availability, null, bad);
      assert.deepEqual(r.body.redacted, ["availability"], bad);
    }
    const clean = await prev(`${base}&profession=Welder&languages=Arabic`);
    assert.deepEqual(clean.body.redacted, []);
    assert.equal(clean.body.summary.profession, "Welder");
    // everything redacted => nothing left to present
    const none = await prev(`profession=${encodeURIComponent("a@b.co")}`);
    assert.equal(none.body.needs_summary, true);
    // POST freezes the redacted summary, the preview shows the same
    const posted = await w.http("POST", `/crm/employer-requests/${rid}/presentations`, w.T.admin, {
      candidate_id: cand,
      summary: { profession: "Welder, call +49 170 1234567", years_experience: 7, country_of_residence: "Tunisia", availability: "immediately" },
    });
    assert.equal(posted.status, 201, posted.text);
    assert.equal(posted.body.summary.profession, null);
    assert.deepEqual(posted.body.redacted, ["profession"]);
    const stored = JSON.stringify((await w.one("SELECT summary FROM employer_presentations WHERE id=$1", [posted.body.id])).summary);
    assert.ok(!stored.includes("1234567") && !stored.includes("+49"));
    // the staff note is validated with the same rules and rejected (not silently dropped)
    const rid2 = await w.mkReq(emp.orgId);
    const cand2 = await w.mkCand();
    await consent(w, cand2, emp.orgId);
    for (const note of ["Call me +49 170 1234567", "mail a@b.example", "visit www.x.test", "https://x.test", "ref 123 456 789"]) {
      const r = await w.http("POST", `/crm/employer-requests/${rid2}/presentations`, w.T.admin, { candidate_id: cand2, staff_note_for_employer: note });
      assert.equal(r.status, 400, note);
      assert.match(r.body.error, /contact/i);
      const pv = await w.http("GET", `/crm/employer-requests/${rid2}/presentation-preview?candidate_id=${cand2}&staff_note_for_employer=${encodeURIComponent(note)}`, w.T.admin);
      assert.equal(pv.status, 400, `preview: ${note}`);
    }
    assert.equal((await w.q("SELECT 1 FROM employer_presentations WHERE request_id=$1", [rid2])).rowCount, 0);
    const ok = await w.http("POST", `/crm/employer-requests/${rid2}/presentations`, w.T.admin, { candidate_id: cand2, staff_note_for_employer: "Strong welder, 5 years" });
    assert.equal(ok.status, 201, ok.text);
  });
});

test("review 1: create-site-job is one transaction: a failing link step leaves no orphan draft", async () => {
  await withWorld(async (w) => {
    const emp = await createEmployerUser(w.pool);
    const rid = await w.mkReq(emp.orgId, "in_review");
    await w.q(`CREATE FUNCTION fail_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.site_job_id IS NOT NULL THEN RAISE EXCEPTION 'injected link failure'; END IF; RETURN NEW; END $$`);
    await w.q("CREATE TRIGGER fail_link_trg BEFORE UPDATE ON employer_requests FOR EACH ROW EXECUTE FUNCTION fail_link()");
    const bad = await w.http("POST", `/crm/employer-requests/${rid}/create-site-job`, w.T.admin);
    assert.equal(bad.status, 500);
    assert.equal((await w.q("SELECT 1 FROM site_jobs")).rowCount, 0, "no orphan draft");
    assert.equal((await w.one("SELECT site_job_id FROM employer_requests WHERE id=$1", [rid])).site_job_id, null);
    assert.equal((await w.q("SELECT 1 FROM crm_timeline WHERE entity='site_job'")).rowCount, 0);
    assert.equal((await w.q("SELECT 1 FROM audit_logs WHERE action='crm.site_job.create'")).rowCount, 0);
    await w.q("DROP TRIGGER fail_link_trg ON employer_requests");
    const ok = await w.http("POST", `/crm/employer-requests/${rid}/create-site-job`, w.T.admin);
    assert.equal(ok.status, 201, ok.text);
    assert.equal((await w.q("SELECT 1 FROM site_jobs")).rowCount, 1);
    // concurrent calls still produce exactly one draft
    const rid2 = await w.mkReq(emp.orgId, "accepted");
    const res = await Promise.all([1, 2, 3, 4].map(() => w.http("POST", `/crm/employer-requests/${rid2}/create-site-job`, w.T.admin)));
    assert.equal(res.filter((r) => r.status === 201).length, 1, res.map((r) => r.status).join());
    assert.equal(res.filter((r) => r.status === 409).length, 3);
    assert.equal((await w.q("SELECT 1 FROM site_jobs")).rowCount, 2);
  });
});
