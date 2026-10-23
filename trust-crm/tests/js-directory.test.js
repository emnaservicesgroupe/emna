// Task 18 item 5: employer directory (GET/PUT /jobsearch/employers), automation rules
// (GET/POST/DELETE /jobsearch/automation-rules) and the confirmation list (GET /jobsearch/employer-confirmations).
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-directory-test-secret";

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
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  };
  const user = async (role, key) => (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`${role} ${key}`, `${key}@dir.test.invalid`, role])).id;
  const tok = (id, role, extra = {}) => jwt.sign({ id, role, ...extra }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const ids = { admin: await user("Admin", "adm"), mgrA: await user("Manager", "mgra"), mgrB: await user("Manager", "mgrb"), agentA: await user("Agent", "agta"), acct: await user("Accountant", "acct") };
  const T = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, tok(id, { admin: "Admin", mgrA: "Manager", mgrB: "Manager", agentA: "Agent", acct: "Accountant" }[k])]));
  let n = 0;
  const candidate = async (assignedTo) => {
    n += 1;
    return (await one("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`Cand ${n}`, `PP-DIR-${n}`, assignedTo])).id;
  };
  const employer = async (name, domain = null) => (await one("INSERT INTO js_employers (name, normalized_name, domain) VALUES ($1, lower($1), $2) RETURNING id", [name, domain])).id;
  const job = async (employerId) => {
    n += 1;
    return (await one("INSERT INTO js_jobs (title, country, employer_id, dedupe_key) VALUES ('Welder','Canada',$1,$2) RETURNING id", [employerId, `dk-dir-${n}`])).id;
  };
  const application = async (candidateId, jobId) => (await one("INSERT INTO js_applications (candidate_id, job_id, status) VALUES ($1,$2,'ready_for_review') RETURNING id", [candidateId, jobId])).id;
  try {
    await fn({ pool, q, one, http, ids, T, candidate, employer, job, application });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

test("GET /jobsearch/employers: admin sees all; staff see employers of their candidates' applications; candidates/accountants refused", async () => {
  await withWorld(async (w) => {
    const eA = await w.employer("Acme Welding", "acme.example");
    const eB = await w.employer("Borealis Steel");
    const eC = await w.employer("Cobalt Works");
    const cA = await w.candidate(w.ids.mgrA);
    const cB = await w.candidate(w.ids.mgrB);
    await w.application(cA, await w.job(eA));
    await w.application(cB, await w.job(eB));
    const del = await w.candidate(w.ids.mgrA);
    await w.application(del, await w.job(eC));
    await w.q("UPDATE candidates SET is_deleted=true WHERE id=$1", [del]);

    const all = await w.http("GET", "/jobsearch/employers", w.T.admin);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.deepEqual(all.body.employers.map((e) => e.name).sort(), ["Acme Welding", "Borealis Steel", "Cobalt Works"]);
    const a = await w.http("GET", "/jobsearch/employers", w.T.mgrA);
    assert.deepEqual(a.body.employers.map((e) => e.id), [eA], "manager A: only employers of A's (non-deleted) candidates' applications");
    assert.equal(a.body.employers[0].domain, "acme.example");
    assert.deepEqual((await w.http("GET", "/jobsearch/employers", w.T.mgrB)).body.employers.map((e) => e.id), [eB]);
    assert.deepEqual((await w.http("GET", "/jobsearch/employers?q=bore", w.T.admin)).body.employers.map((e) => e.id), [eB]);
    assert.deepEqual((await w.http("GET", "/jobsearch/employers?q=%25", w.T.admin)).body.employers, [], "LIKE wildcards are literal");
    assert.equal((await w.http("GET", "/jobsearch/employers", w.T.acct)).status, 403);
    const candUser = (await w.one("INSERT INTO users (full_name,email,password,role) VALUES ('C','c@dir.test.invalid','x','Candidate') RETURNING id")).id;
    assert.equal((await w.http("GET", "/jobsearch/employers", jwt.sign({ id: candUser, role: "Candidate", tv: 0 }, process.env.JWT_SECRET))).status, 403);
    assert.equal((await w.http("GET", "/jobsearch/employers")).status, 401);
  });
});

test("PUT /jobsearch/employers/:id: admin or in-scope Manager; domain normalised (URL/www/IDN->punycode), free-mail and junk refused; contact validated; rename keeps names unique; audited", async () => {
  await withWorld(async (w) => {
    const e = await w.employer("Acme Welding");
    const other = await w.employer("Borealis Steel");
    const cA = await w.candidate(w.ids.mgrA);
    await w.application(cA, await w.job(e));

    const put = (tok, body, id = e) => w.http("PUT", `/jobsearch/employers/${id}`, tok, body);
    const ok = await put(w.T.admin, { domain: "https://www.Acme.Example/careers", verifiedContactEmail: " HR@Acme.Example " });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.domain, "acme.example");
    assert.equal(ok.body.verifiedContactEmail, "hr@acme.example");
    const row = await w.one("SELECT domain, verified_contact_email FROM js_employers WHERE id=$1", [e]);
    assert.deepEqual([row.domain, row.verified_contact_email], ["acme.example", "hr@acme.example"]);

    const idn = await put(w.T.admin, { domain: "bücher-beispiel.de" });
    assert.equal(idn.status, 200, JSON.stringify(idn.body));
    assert.equal(idn.body.domain, "xn--bcher-beispiel-gsb.de");
    assert.equal(idn.body.domainUnicode, "bücher-beispiel.de");

    for (const bad of ["gmail.com", "mail.yahoo.co.uk", "outlook.fr", "hr@acme.example", "acme", "acme..example", "-acme.example", "acme.example:8080", "127.0.0.1", "acme .example", "a".repeat(300), 12, ["acme.example"], "xn--.com"]) {
      const r = await put(w.T.admin, { domain: bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    for (const bad of ["not-an-email", "a@b", "Jane <hr@acme.example>", "hr@acme.example, x@y.example", "hr@bücher.de"]) {
      assert.equal((await put(w.T.admin, { verifiedContactEmail: bad })).status, 400, bad);
    }
    assert.equal((await put(w.T.admin, { unknownField: 1 })).status, 400, "unknown fields refused");
    assert.equal((await put(w.T.admin, {})).status, 400, "nothing to change");

    // Manager: only employers in scope
    assert.equal((await put(w.T.mgrA, { domain: "acme-welding.example" })).status, 200);
    assert.equal((await put(w.T.mgrB, { domain: "evil.example" })).status, 404, "out-of-scope manager");
    assert.equal((await put(w.T.agentA, { domain: "evil.example" })).status, 403, "agents cannot edit the directory");
    assert.equal((await put(w.T.admin, { domain: "x.example" }, 999999)).status, 404);

    // clearing values
    const cleared = await put(w.T.admin, { domain: null, verifiedContactEmail: "" });
    assert.deepEqual([cleared.body.domain, cleared.body.verifiedContactEmail], [null, null]);

    // rename: normalized name must stay unique
    const dup = await put(w.T.admin, { name: "  BOREALIS   steel " });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.match(dup.body.error, new RegExp(`#${other}`));
    const ren = await put(w.T.admin, { name: "Acme Welding Ltd" });
    assert.equal(ren.status, 200);
    assert.equal((await w.one("SELECT normalized_name FROM js_employers WHERE id=$1", [e])).normalized_name, require("../modules/jobsearch/jobStore").normalizeEmployer("Acme Welding Ltd"));

    const audits = (await w.q("SELECT actor, detail FROM js_audit_events WHERE action='employer.update' ORDER BY id")).rows;
    assert.ok(audits.length >= 5);
    assert.equal(audits[0].actor, `user:${w.ids.admin}`);
    assert.deepEqual(audits[0].detail.after, { domain: "acme.example", verifiedContactEmail: "hr@acme.example" });
    assert.equal((await w.q("SELECT count(*)::int n FROM audit_logs WHERE table_name='js_employers'")).rows[0].n, audits.length);
  });
});

test("automation rules: admin only; auto_submit and ack_reply validated; candidate/employer scope; list shows scope + enabled; DELETE disables; autoApproveEligibility honours employer scope", async () => {
  await withWorld(async (w) => {
    const c = await w.candidate(w.ids.mgrA);
    const e = await w.employer("Acme Welding", "acme.example");
    const post = (tok, body) => w.http("POST", "/jobsearch/automation-rules", tok, body);
    assert.equal((await post(w.T.mgrA, { candidateId: c, type: "auto_submit", countries: ["Canada"] })).status, 403, "managers cannot create rules");
    assert.equal((await w.http("GET", "/jobsearch/automation-rules", w.T.mgrA)).status, 403);

    const bad = [
      {},
      { candidateId: c },
      { candidateId: c, type: "send_everything" },
      { candidateId: 999999, type: "auto_submit", countries: ["Canada"] },
      { candidateId: c, type: "auto_submit" }, // countries required for an automatic-send rule
      { candidateId: c, type: "auto_submit", countries: [] },
      { candidateId: c, type: "auto_submit", countries: "Canada" },
      { candidateId: c, type: "auto_submit", countries: ["Canada", 7] },
      { candidateId: c, type: "auto_submit", countries: ["x".repeat(101)] },
      { candidateId: c, type: "auto_submit", countries: Array.from({ length: 51 }, (_, i) => `C${i}`) },
      { candidateId: c, type: "auto_submit", countries: ["Canada"], sources: ["Bad Key!"] },
      { candidateId: c, type: "auto_submit", countries: ["Canada"], employerIds: [999999] },
      { candidateId: c, type: "auto_submit", countries: ["Canada"], extra: true },
      { candidateId: c, type: "ack_reply" }, // employer scope required
      { candidateId: c, type: "ack_reply", employerIds: [] },
      { candidateId: c, type: "ack_reply", employerIds: ["abc"] },
      { candidateId: c, type: "ack_reply", employerIds: [e], countries: ["Canada"] },
    ];
    for (const b of bad) {
      const r = await post(w.T.admin, b);
      assert.ok([400, 404].includes(r.status), `${JSON.stringify(b)} -> ${r.status}`);
    }
    assert.equal((await w.q("SELECT count(*)::int n FROM js_automation_rules")).rows[0].n, 0);

    const r1 = await post(w.T.admin, { candidateId: c, type: "auto_submit", countries: ["Canada"], professions: ["Welder"], sources: ["partner_feed"], employerIds: [e], note: "Approved with the candidate on 2026-10-23" });
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    const row = await w.one("SELECT * FROM js_automation_rules WHERE id=$1", [r1.body.id]);
    assert.deepEqual(row.rule, { type: "auto_submit", countries: ["Canada"], professions: ["Welder"], sources: ["partner_feed"], employerIds: [e] });
    assert.equal(row.approved_by, w.ids.admin);
    assert.ok(row.approved_at && row.active);
    const r2 = await post(w.T.admin, { candidateId: c, type: "ack_reply", employerIds: [e] });
    assert.equal(r2.status, 201);
    assert.deepEqual((await w.one("SELECT rule FROM js_automation_rules WHERE id=$1", [r2.body.id])).rule, { type: "ack_reply", enabled: true, employerIds: [e] });

    const list = await w.http("GET", `/jobsearch/automation-rules?candidateId=${c}`, w.T.admin);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.rules.map((r) => [r.id, r.type, r.enabled, r.candidateId]), [[r1.body.id, "auto_submit", true, c], [r2.body.id, "ack_reply", true, c]]);
    assert.deepEqual(list.body.rules[0].scope, { countries: ["Canada"], professions: ["Welder"], sources: ["partner_feed"], employerIds: [e] });
    assert.equal(list.body.rules[0].approvedBy, w.ids.admin);

    const d = await w.http("DELETE", `/jobsearch/automation-rules/${r2.body.id}`, w.T.admin);
    assert.equal(d.status, 200);
    assert.equal((await w.one("SELECT active FROM js_automation_rules WHERE id=$1", [r2.body.id])).active, false, "disabled, history kept");
    assert.equal((await w.http("DELETE", `/jobsearch/automation-rules/${r2.body.id}`, w.T.admin)).status, 404, "already disabled");
    assert.equal((await w.http("DELETE", `/jobsearch/automation-rules/${r1.body.id}`, w.T.mgrA)).status, 403);
    const after = await w.http("GET", "/jobsearch/automation-rules", w.T.admin);
    assert.equal(after.body.rules.find((r) => r.id === r2.body.id).enabled, false);
    const acts = (await w.q("SELECT action, candidate_id, detail FROM js_audit_events WHERE action LIKE 'automation_rule.%' ORDER BY id")).rows;
    assert.deepEqual(acts.map((a) => [a.action, a.candidate_id]), [["automation_rule.create", c], ["automation_rule.create", c], ["automation_rule.disable", c]]);
    assert.equal(acts[0].detail.note, "Approved with the candidate on 2026-10-23");

    // the employer scope of an auto_submit rule is enforced by auto-approval
    const svc = require("../modules/jobsearch/applicationService");
    const other = await w.employer("Other Co", "other.example");
    const appOther = await w.application(c, await w.job(other));
    const appAcme = await w.application(c, await w.job(e));
    const reasonsOf = async (id) => (await svc.autoApproveEligibility(await w.one("SELECT * FROM js_applications WHERE id=$1", [id]))).reasons;
    assert.ok((await reasonsOf(appOther)).includes("employer_not_allowed"));
    assert.ok(!(await reasonsOf(appAcme)).includes("employer_not_allowed"));
  });
});

test("GET /jobsearch/employer-confirmations: admin list (active + revoked) with scope; staff refused", async () => {
  await withWorld(async (w) => {
    const e = await w.employer("Acme Welding", "acme.example");
    const j = await w.job(e);
    const c = await w.candidate(w.ids.mgrA);
    const a = await w.application(c, j);
    const job = await w.http("POST", "/jobsearch/employer-confirmations", w.T.admin, { applicationId: a, evidenceNote: "Phoned HR (Jane) on 2026-10-23: LMIA will be filed for this job" });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    const wide = await w.http("POST", "/jobsearch/employer-confirmations", w.T.admin, { employerId: e, evidenceNote: "Signed partnership letter: sponsors every hire" });
    assert.equal(wide.status, 201);
    assert.equal((await w.http("DELETE", `/jobsearch/employer-confirmations/${wide.body.id}`, w.T.admin)).status, 200);
    const list = await w.http("GET", "/jobsearch/employer-confirmations", w.T.admin);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.confirmations.map((x) => [x.id, x.scope, x.employerName, x.revoked]), [[wide.body.id, "employer", "Acme Welding", true], [job.body.id, "job", "Acme Welding", false]]);
    assert.equal(list.body.confirmations[1].applicationId, a);
    assert.equal(list.body.confirmations[1].jobTitle, "Welder");
    assert.match(list.body.confirmations[1].evidence, /Phoned HR/);
    assert.deepEqual((await w.http("GET", "/jobsearch/employer-confirmations?active=true", w.T.admin)).body.confirmations.map((x) => x.id), [job.body.id]);
    assert.equal((await w.http("GET", "/jobsearch/employer-confirmations", w.T.mgrA)).status, 403);
  });
});
