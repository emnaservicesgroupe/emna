const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { makePdf } = require("./helpers/docs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-consent-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "js-consent-"));
delete process.env.CLAMAV_HOST;
process.env.JS_UPLOADS_PER_HOUR = "1000";

const consentService = require("../modules/jobsearch/consentService");

const SCOPE_ALL = { search: true, prepare: true, submit: true, countries: ["Qatar"] };
const PREFS = {
  countries: ["Qatar"],
  categories: ["Electrician"],
  availability: "2026-12-01",
  salary_expectation: 2500,
  salary_currency: "usd",
  residence_country: "Tunisia",
  needs_work_auth_support: true,
};

async function withApp(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { body, token, form } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const r = await fetch(base + p, { method, headers, body: payload });
    let json = null;
    try {
      json = await r.json();
    } catch {
      json = null;
    }
    return { status: r.status, body: json };
  };
  const mkUser = async (email, role) =>
    (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [email, email, role])).rows[0].id;
  const staffToken = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });
  try {
    const adminId = await mkUser("adm@x.io", "Admin");
    const adminToken = staffToken(adminId, "Admin");
    const agentA = await mkUser("a@test.invalid", "Agent");
    const agentB = await mkUser("b@test.invalid", "Agent");
    const managerA = await mkUser("m@test.invalid", "Manager");
    const tokens = { adminToken, agentAToken: staffToken(agentA, "Agent"), agentBToken: staffToken(agentB, "Agent"), managerToken: staffToken(managerA, "Manager") };
    let n = 0;
    const newCandidate = async (assignedTo) => {
      n += 1;
      const cid = (await pool.query("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`Cand ${n}`, `PP${n}`, assignedTo])).rows[0].id;
      const r = await call("POST", "/jobsearch/admin/candidate-accounts", { token: adminToken, body: { candidate_id: cid, email: `c${n}@test.invalid` } });
      assert.equal(r.status, 201);
      const tv = (await pool.query("SELECT token_version FROM users WHERE id=$1", [r.body.user_id])).rows[0].token_version;
      const token = jwt.sign({ id: r.body.user_id, role: "Candidate", tv }, process.env.JWT_SECRET, { expiresIn: "1h" });
      return { candidateId: cid, userId: r.body.user_id, token };
    };
    const confirmProfile = (c) => call("PUT", `/jobsearch/candidates/${c.candidateId}/profile/confirm`, { token: c.token, body: { preferences: PREFS } });
    const seedProfile = (cid) =>
      pool.query("INSERT INTO js_profiles (candidate_id, status) VALUES ($1,'confirmed') ON CONFLICT (candidate_id) DO UPDATE SET status='confirmed'", [cid]);
    const seedJob = async (k) =>
      (await pool.query("INSERT INTO js_jobs (title, dedupe_key) VALUES ($1,$2) RETURNING id", [`Job ${k}`, `dk-${n}-${k}`])).rows[0].id;
    const seedApp = async (cid, status, k) => {
      const jobId = await seedJob(k);
      const id = (await pool.query("INSERT INTO js_applications (candidate_id, job_id, status) VALUES ($1,$2,$3) RETURNING id", [cid, jobId, status])).rows[0].id;
      await pool.query("INSERT INTO js_queue (kind, payload) VALUES ('submit', $1::jsonb)", [JSON.stringify({ applicationId: id })]);
      return id;
    };
    await fn({ pool, call, mkUser, newCandidate, confirmProfile, seedProfile, seedApp, agentA, agentB, ...tokens });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
  }
}

const eligibility = async (t, c, token) => (await t.call("GET", `/jobsearch/candidates/${c.candidateId}/eligibility`, { token: token || c.token })).body;

test("eligibility requires confirmed profile AND search consent (CV upload alone is not enough)", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    const form = new FormData();
    form.append("file", new Blob([makePdf("Karim Benali\nElectrician\nkarim@example.com")], { type: "application/pdf" }), "cv.pdf");
    const up = await t.call("POST", `/jobsearch/candidates/${c.candidateId}/cv`, { token: c.token, form });
    assert.equal(up.status, 201);
    let e = await eligibility(t, c);
    assert.equal(e.eligible, false);
    assert.ok(e.reasons.includes("profile_not_confirmed") && e.reasons.includes("no_search_consent"));

    assert.equal((await t.confirmProfile(c)).status, 200);
    e = await eligibility(t, c);
    assert.equal(e.eligible, false, "confirmed profile alone");
    assert.deepEqual(e.reasons, ["no_search_consent"]);

    const c2 = await t.newCandidate(t.agentA);
    assert.equal((await t.call("POST", `/jobsearch/candidates/${c2.candidateId}/consent`, { token: c2.token, body: { scope: SCOPE_ALL, version: "v1" } })).status, 201);
    e = await eligibility(t, c2);
    assert.equal(e.eligible, false, "consent without confirmed profile");
    assert.deepEqual(e.reasons, ["profile_not_confirmed"]);

    assert.equal((await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent`, { token: c.token, body: { scope: SCOPE_ALL, version: "v1" } })).status, 201);
    e = await eligibility(t, c);
    assert.deepEqual(e, { eligible: true, reasons: [] });
  });
});

test("consent persists version, scope and timestamp; new grant supersedes and keeps history", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    const r = await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent`, { token: c.token, body: { scope: SCOPE_ALL, version: "2026-10" } });
    assert.equal(r.status, 201);
    const row = (await t.pool.query("SELECT * FROM js_consents WHERE candidate_id=$1", [c.candidateId])).rows[0];
    assert.equal(row.version, "2026-10");
    assert.equal(row.scope.search, true);
    assert.equal(row.scope.submit, true);
    assert.deepEqual(row.scope.countries, ["Qatar"]);
    assert.ok(row.granted_at instanceof Date);
    assert.equal(row.granted_by, c.userId);

    await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent`, { token: c.token, body: { scope: { search: true, prepare: false, submit: false, countries: [] }, version: "2026-11" } });
    const all = (await t.pool.query("SELECT * FROM js_consents WHERE candidate_id=$1 ORDER BY id", [c.candidateId])).rows;
    assert.equal(all.length, 2);
    assert.ok(all[0].withdrawn_at, "previous superseded");
    assert.equal(all[1].withdrawn_at, null);
    assert.equal(await consentService.activeConsent(c.candidateId, "submit"), null);
    assert.ok(await consentService.activeConsent(c.candidateId, "search"));
    const g = await t.call("GET", `/jobsearch/candidates/${c.candidateId}/consent`, { token: c.token });
    assert.equal(g.body.history.length, 2);
    assert.equal(g.body.active.version, "2026-11");

    for (const bad of [{ scope: SCOPE_ALL }, { scope: SCOPE_ALL, version: "  " }, { scope: { search: "yes" }, version: "v" }, { version: "v" }]) {
      assert.equal((await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent`, { token: c.token, body: bad })).status, 400);
    }
  });
});

test("staff records written consent only with recordedBy and evidenceNote; out-of-scope staff gets 404", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    const url = `/jobsearch/candidates/${c.candidateId}/consent`;
    assert.equal((await t.call("POST", url, { token: t.agentAToken, body: { scope: SCOPE_ALL, version: "v1" } })).status, 400);
    assert.equal((await t.call("POST", url, { token: t.agentAToken, body: { scope: SCOPE_ALL, version: "v1", recordedBy: "Agent A", evidenceNote: "  " } })).status, 400);
    assert.equal((await t.call("POST", url, { token: t.agentAToken, body: { scope: SCOPE_ALL, version: "v1", evidenceNote: "signed form" } })).status, 400);
    assert.equal((await t.pool.query("SELECT count(*) n FROM js_consents")).rows[0].n, "0");
    const ok = await t.call("POST", url, { token: t.agentAToken, body: { scope: SCOPE_ALL, version: "v1", recordedBy: "Agent A", evidenceNote: "Signed paper form #123" } });
    assert.equal(ok.status, 201);
    const row = (await t.pool.query("SELECT scope FROM js_consents")).rows[0];
    assert.equal(row.scope.evidence.evidence_note, "Signed paper form #123");
    assert.equal((await t.call("POST", url, { token: t.agentBToken, body: { scope: SCOPE_ALL, version: "v1", recordedBy: "B", evidenceNote: "x" } })).status, 404);
  });
});

test("withdraw cancels queued+approved applications and queue items, writes rows, is idempotent", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    const other = await t.newCandidate(t.agentA);
    await t.seedProfile(c.candidateId);
    await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent`, { token: c.token, body: { scope: SCOPE_ALL, version: "v1" } });
    const q = await t.seedApp(c.candidateId, "queued", "q");
    const a = await t.seedApp(c.candidateId, "approved", "a");
    const r = await t.seedApp(c.candidateId, "ready_for_review", "r");
    const sent = await t.seedApp(c.candidateId, "sent", "s");
    const foreign = await t.seedApp(other.candidateId, "queued", "f");

    const w = await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent/withdraw`, { token: c.token, body: { scopeKey: "submit" } });
    assert.equal(w.status, 200);
    assert.equal(w.body.cancelledApplications, 3, "queued + approved + ready_for_review when submit withdrawn");
    const st = async (id) => (await t.pool.query("SELECT status FROM js_applications WHERE id=$1", [id])).rows[0].status;
    assert.equal(await st(q), "cancelled");
    assert.equal(await st(a), "cancelled");
    assert.equal(await st(r), "cancelled");
    assert.equal(await st(sent), "sent");
    assert.equal(await st(foreign), "queued");
    const pending = (await t.pool.query("SELECT payload->>'applicationId' id FROM js_queue WHERE status='pending'")).rows.map((x) => Number(x.id));
    assert.deepEqual(pending.sort(), [sent, foreign].sort());
    assert.equal((await t.pool.query("SELECT count(*) n FROM js_timeline WHERE event='cancelled'")).rows[0].n, "3");
    assert.equal((await t.pool.query("SELECT count(*) n FROM js_audit_events WHERE action='consent.withdraw'")).rows[0].n, "1");
    assert.equal((await t.pool.query("SELECT count(*) n FROM js_events WHERE kind='consent.withdrawn'")).rows[0].n, "1");
    assert.equal((await t.pool.query("SELECT count(*) n FROM audit_logs WHERE action='jobsearch.consent.withdraw'")).rows[0].n, "1");
    assert.equal(await consentService.activeConsent(c.candidateId, "submit"), null);
    assert.ok(await consentService.activeConsent(c.candidateId, "search"), "search consent unaffected");
    assert.equal((await eligibility(t, c)).eligible, true, "withdrawing submit does not stop search");

    const again = await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent/withdraw`, { token: c.token, body: { scopeKey: "submit" } });
    assert.equal(again.status, 200);
    assert.equal(again.body.cancelledApplications, 0);
    assert.equal((await t.pool.query("SELECT count(*) n FROM js_timeline WHERE event='cancelled'")).rows[0].n, "3");

    const s = await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent/withdraw`, { token: c.token, body: { scopeKey: "search" } });
    assert.equal(s.status, 200);
    const e = await eligibility(t, c);
    assert.equal(e.eligible, false);
    assert.ok(e.reasons.includes("no_search_consent") && e.reasons.includes("candidate_paused"));
    assert.equal((await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent/withdraw`, { token: c.token, body: { scopeKey: "bogus" } })).status, 400);
    assert.equal((await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent/withdraw`, { token: c.token, body: { scopeKey: "all" } })).status, 200);
  });
});

test("withdraw by another candidate or out-of-scope staff is 404", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    const other = await t.newCandidate(t.agentA);
    await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent`, { token: c.token, body: { scope: SCOPE_ALL, version: "v1" } });
    const url = `/jobsearch/candidates/${c.candidateId}/consent/withdraw`;
    assert.equal((await t.call("POST", url, { token: other.token, body: { scopeKey: "all" } })).status, 404);
    assert.equal((await t.call("POST", url, { token: t.agentBToken, body: { scopeKey: "all" } })).status, 404);
    assert.ok(await consentService.activeConsent(c.candidateId, "search"));
    assert.equal((await t.call("GET", `/jobsearch/candidates/${c.candidateId}/consent`, { token: other.token })).status, 404);
  });
});

test("settings: default mode, candidate cannot set automatic (403), role matrix, scope isolation", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    const url = `/jobsearch/candidates/${c.candidateId}/settings`;
    assert.equal((await t.call("GET", url, { token: c.token })).body.mode, "search_only");
    assert.equal((await t.call("PUT", url, { token: c.token, body: { mode: "automatic" } })).status, 403);
    assert.equal((await t.call("PUT", url, { token: c.token, body: { mode: "prepare_for_approval" } })).status, 403);
    assert.equal((await t.call("PUT", url, { token: c.token, body: { cap_per_day: 5 } })).status, 403);
    assert.equal((await t.pool.query("SELECT mode FROM js_candidate_settings WHERE candidate_id=$1", [c.candidateId])).rows[0]?.mode ?? "search_only", "search_only");

    const p = await t.call("PUT", url, { token: c.token, body: { paused: true } });
    assert.equal(p.status, 200);
    assert.equal(p.body.paused, true);
    assert.equal(p.body.mode, "search_only", "first row created with search_only");

    assert.equal((await t.call("PUT", url, { token: t.agentAToken, body: { mode: "prepare_for_approval" } })).status, 403, "agent lacks approve");
    const m = await t.call("PUT", url, { token: t.managerToken, body: { mode: "prepare_for_approval" } });
    assert.equal(m.status, 404, "manager not assigned to candidate");
    await t.pool.query("UPDATE candidates SET assigned_to=$1 WHERE id=$2", [t.managerToken ? (await t.pool.query("SELECT id FROM users WHERE role='Manager'")).rows[0].id : 0, c.candidateId]);
    assert.equal((await t.call("PUT", url, { token: t.managerToken, body: { mode: "prepare_for_approval" } })).body.mode, "prepare_for_approval");
    assert.equal((await t.call("PUT", url, { token: t.managerToken, body: { mode: "automatic" } })).status, 403);
    assert.equal((await t.call("PUT", url, { token: t.managerToken, body: { cap_per_day: 3 } })).status, 403);

    const adm = await t.call("PUT", url, {
      token: t.adminToken,
      body: { mode: "automatic", cap_per_day: 5, cap_per_week: 20, allowed_countries: ["Qatar"], allowed_professions: ["Electrician"], allowed_sources: ["fixture"], approved_doc_versions: [{ doc: "cv", version: 2 }], salary_limit: 1500 },
    });
    assert.equal(adm.status, 200);
    assert.equal(adm.body.mode, "automatic");
    assert.equal(adm.body.cap_per_day, 5);
    assert.deepEqual(adm.body.allowed_countries, ["Qatar"]);
    assert.equal(Number(adm.body.salary_limit), 1500);
    assert.ok(adm.body.admin_approved_by);
    assert.equal((await t.call("PUT", url, { token: t.adminToken, body: { mode: "weird" } })).status, 400);
    assert.equal((await t.call("PUT", url, { token: t.adminToken, body: { nope: 1 } })).status, 400);
    assert.ok((await t.pool.query("SELECT count(*) n FROM js_audit_events WHERE action='settings.update'")).rows[0].n >= "3");
  });
});

test("staff B cannot read or modify staff A's candidate settings (404)", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    const url = `/jobsearch/candidates/${c.candidateId}`;
    for (const [m, p, b] of [
      ["GET", "/settings"],
      ["PUT", "/settings", { paused: true }],
      ["PUT", "/preferences", PREFS],
      ["POST", "/pause", { paused: true }],
      ["GET", "/eligibility"],
      ["GET", "/consent"],
    ]) {
      assert.equal((await t.call(m, url + p, { token: t.agentBToken, body: b })).status, 404, `${m} ${p}`);
    }
    assert.equal((await t.pool.query("SELECT count(*) n FROM js_candidate_settings")).rows[0].n, "0");
  });
});

test("preferences: candidate edits own; pause endpoint toggles eligibility", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    await t.seedProfile(c.candidateId);
    await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent`, { token: c.token, body: { scope: SCOPE_ALL, version: "v1" } });
    const pr = await t.call("PUT", `/jobsearch/candidates/${c.candidateId}/preferences`, { token: c.token, body: PREFS });
    assert.equal(pr.status, 200);
    assert.deepEqual(pr.body.preferences.countries, ["Qatar"]);
    assert.equal((await t.call("PUT", `/jobsearch/candidates/${c.candidateId}/preferences`, { token: c.token, body: { countries: [] } })).status, 400);
    assert.equal((await eligibility(t, c)).eligible, true);
    assert.equal((await t.call("POST", `/jobsearch/candidates/${c.candidateId}/pause`, { token: c.token, body: { paused: true } })).status, 200);
    assert.deepEqual((await eligibility(t, c)).reasons, ["candidate_paused"]);
    assert.equal((await t.call("POST", `/jobsearch/candidates/${c.candidateId}/pause`, { token: t.agentAToken, body: { paused: false } })).status, 200);
    assert.equal((await eligibility(t, c)).eligible, true);
    assert.equal((await t.call("POST", `/jobsearch/candidates/${c.candidateId}/pause`, { token: c.token, body: { paused: "yes" } })).status, 400);
    assert.ok((await t.pool.query("SELECT count(*) n FROM js_audit_events WHERE action IN ('candidate.pause','candidate.unpause','preferences.update')")).rows[0].n >= "3");
  });
});

test("module pause (admin only) makes everyone ineligible", async () => {
  await withApp(async (t) => {
    const c1 = await t.newCandidate(t.agentA);
    const c2 = await t.newCandidate(t.agentB);
    for (const c of [c1, c2]) {
      await t.seedProfile(c.candidateId);
      await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent`, { token: c.token, body: { scope: SCOPE_ALL, version: "v1" } });
      assert.equal((await eligibility(t, c)).eligible, true);
    }
    for (const tok of [c1.token, t.agentAToken, t.managerToken]) {
      assert.equal((await t.call("POST", "/jobsearch/module/pause", { token: tok, body: { paused: true } })).status, 403);
    }
    assert.equal((await t.call("POST", "/jobsearch/module/pause", { token: t.adminToken, body: { paused: true } })).status, 200);
    for (const c of [c1, c2]) assert.deepEqual((await eligibility(t, c)).reasons, ["module_paused"]);
    assert.equal((await t.pool.query("SELECT value FROM js_module_state WHERE key='module_paused'")).rows[0].value.paused, true);
    assert.equal((await t.call("POST", "/jobsearch/module/pause", { token: t.adminToken, body: { paused: false } })).status, 200);
    assert.equal((await eligibility(t, c1)).eligible, true);
    assert.equal((await t.pool.query("SELECT count(*) n FROM js_audit_events WHERE action IN ('module.pause','module.unpause')")).rows[0].n, "2");
  });
});

test("deactivated user is ineligible and queued work is cancelled", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    await t.seedProfile(c.candidateId);
    await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent`, { token: c.token, body: { scope: SCOPE_ALL, version: "v1" } });
    const q = await t.seedApp(c.candidateId, "queued", "q");
    const rr = await t.seedApp(c.candidateId, "ready_for_review", "r");
    assert.equal((await eligibility(t, c, t.adminToken)).eligible, true);
    await t.pool.query("UPDATE users SET is_active=false WHERE id=$1", [c.userId]);
    const e = await eligibility(t, c, t.adminToken);
    assert.equal(e.eligible, false);
    assert.deepEqual(e.reasons, ["account_inactive"]);
    assert.equal(await consentService.cancelForDeactivatedUser(c.userId), 2);
    for (const id of [q, rr]) assert.equal((await t.pool.query("SELECT status FROM js_applications WHERE id=$1", [id])).rows[0].status, "cancelled");
    assert.equal((await t.pool.query("SELECT count(*) n FROM js_queue WHERE status='pending'")).rows[0].n, "0");
    assert.equal(await consentService.cancelQueuedForCandidate(c.candidateId, "again"), 0);
  });
});

const GRANT_NARROW = { search: true, prepare: false, submit: false, countries: [] };
const appStatus = async (t, id) => (await t.pool.query("SELECT status FROM js_applications WHERE id=$1", [id])).rows[0].status;
const pendingQueue = async (t) => Number((await t.pool.query("SELECT count(*) n FROM js_queue WHERE status='pending'")).rows[0].n);

test("re-granting a narrower consent cancels sendable work; later withdraw stays consistent", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    const url = `/jobsearch/candidates/${c.candidateId}/consent`;
    await t.call("POST", url, { token: c.token, body: { scope: SCOPE_ALL, version: "v1" } });
    const q = await t.seedApp(c.candidateId, "queued", "q");
    const a = await t.seedApp(c.candidateId, "approved", "a");
    assert.equal((await t.call("POST", url, { token: c.token, body: { scope: GRANT_NARROW, version: "v2" } })).status, 201);
    assert.equal(await appStatus(t, q), "cancelled");
    assert.equal(await appStatus(t, a), "cancelled");
    assert.equal(await pendingQueue(t), 0);
    assert.equal((await t.pool.query("SELECT count(*) n FROM js_audit_events WHERE action='consent.work_stopped'")).rows[0].n, "1");
    const w = await t.call("POST", `${url}/withdraw`, { token: c.token, body: { scopeKey: "submit" } });
    assert.equal(w.status, 200);
    assert.equal(w.body.cancelledApplications, 0);
    assert.equal(await appStatus(t, q), "cancelled");
    assert.equal((await t.pool.query("SELECT paused FROM js_candidate_settings WHERE candidate_id=$1", [c.candidateId])).rowCount, 0, "search kept, not paused");
  });
});

test("narrowing away search pauses; withdraw with no consent still cancels stray work", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    const url = `/jobsearch/candidates/${c.candidateId}/consent`;
    await t.call("POST", url, { token: c.token, body: { scope: SCOPE_ALL, version: "v1" } });
    await t.call("POST", url, { token: c.token, body: { scope: { search: false, prepare: true, submit: true, countries: [] }, version: "v2" } });
    assert.equal((await t.pool.query("SELECT paused FROM js_candidate_settings WHERE candidate_id=$1", [c.candidateId])).rows[0].paused, true);

    const d = await t.newCandidate(t.agentA);
    const stray = await t.seedApp(d.candidateId, "approved", "stray");
    await t.pool.query("INSERT INTO js_queue (kind,payload) VALUES ('followup',$1::jsonb)", [JSON.stringify({ candidateId: d.candidateId })]);
    const w = await t.call("POST", `/jobsearch/candidates/${d.candidateId}/consent/withdraw`, { token: d.token, body: { scopeKey: "submit" } });
    assert.equal(w.body.cancelledApplications, 1);
    assert.equal(await appStatus(t, stray), "cancelled");
    assert.equal((await t.pool.query("SELECT count(*) n FROM js_queue WHERE status='pending' AND kind IN ('submit','followup')")).rows[0].n, "0");
  });
});

test("soft-deleted candidate is ineligible", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    await t.seedProfile(c.candidateId);
    await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent`, { token: c.token, body: { scope: SCOPE_ALL, version: "v1" } });
    await t.pool.query("UPDATE candidates SET is_deleted=true WHERE id=$1", [c.candidateId]);
    const e = await consentService.searchEligible(c.candidateId);
    assert.equal(e.eligible, false);
    assert.ok(e.reasons.includes("candidate_deleted"));
  });
});

test("Task 19 should-fix c: an admin cannot suspend their own account, nor the last active SuperAdmin (409, nothing changed)", async () => {
  await withApp(async (t) => {
    const adminId = jwt.decode(t.adminToken).id;
    const self = await t.call("POST", `/jobsearch/admin/users/${adminId}/suspend`, { token: t.adminToken });
    assert.equal(self.status, 409);
    assert.match(self.body.error, /own account/);
    const su1 = await t.mkUser("su1@test.invalid", "SuperAdmin");
    const su1Token = jwt.sign({ id: su1, role: "SuperAdmin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    assert.equal((await t.call("POST", `/jobsearch/admin/users/${su1}/suspend`, { token: su1Token })).status, 409, "SuperAdmin self-suspend");
    const last = await t.call("POST", `/jobsearch/admin/users/${su1}/suspend`, { token: t.adminToken });
    assert.equal(last.status, 409);
    assert.match(last.body.error, /last active SuperAdmin/);
    assert.equal((await t.pool.query("SELECT is_active, token_version FROM users WHERE id=$1", [su1])).rows[0].is_active, true);
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_audit_events WHERE action='account.suspend'")).rows[0].n, 0);
    // with a second active SuperAdmin, one of them may be suspended (by someone else)
    const su2 = await t.mkUser("su2@test.invalid", "SuperAdmin");
    assert.equal((await t.call("POST", `/jobsearch/admin/users/${su1}/suspend`, { token: t.adminToken })).status, 200);
    assert.equal((await t.call("POST", `/jobsearch/admin/users/${su2}/suspend`, { token: t.adminToken })).status, 409, "su2 is now the last one");
    // reinstating is never blocked; suspending another Admin still works
    assert.equal((await t.call("POST", `/jobsearch/admin/users/${su1}/reinstate`, { token: t.adminToken })).status, 200);
    const other = await t.mkUser("adm2@test.invalid", "Admin");
    assert.equal((await t.call("POST", `/jobsearch/admin/users/${other}/suspend`, { token: t.adminToken })).status, 200);
  });
});

test("admin suspend cancels work, revokes sessions, audits; reinstate resurrects nothing", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate(t.agentA);
    await t.seedProfile(c.candidateId);
    await t.call("POST", `/jobsearch/candidates/${c.candidateId}/consent`, { token: c.token, body: { scope: SCOPE_ALL, version: "v1" } });
    const q = await t.seedApp(c.candidateId, "queued", "q");
    assert.equal((await t.call("GET", `/jobsearch/candidates/${c.candidateId}/eligibility`, { token: c.token })).status, 200);
    const base = `/jobsearch/admin/users/${c.userId}`;
    assert.equal((await t.call("POST", base + "/suspend", { token: t.agentAToken })).status, 403);
    assert.equal((await t.call("POST", base + "/suspend", { token: c.token })).status, 403);
    assert.equal((await t.call("POST", "/jobsearch/admin/users/999999/suspend", { token: t.adminToken })).status, 404);
    const s = await t.call("POST", base + "/suspend", { token: t.adminToken });
    assert.equal(s.status, 200);
    assert.equal(s.body.cancelledApplications, 1);
    assert.equal((await t.call("GET", `/jobsearch/candidates/${c.candidateId}/eligibility`, { token: c.token })).status, 401, "old token revoked");
    assert.equal(await appStatus(t, q), "cancelled");
    assert.equal(await pendingQueue(t), 0);
    assert.ok(Number((await t.pool.query("SELECT count(*) n FROM js_audit_events WHERE action IN ('account.suspend','account.suspend_cancel')")).rows[0].n) >= 2);
    assert.equal((await t.pool.query("SELECT count(*) n FROM js_events WHERE kind='account.suspended'")).rows[0].n, "1");
    assert.equal((await t.pool.query("SELECT count(*) n FROM audit_logs WHERE action='jobsearch.account.suspend'")).rows[0].n, "1");
    assert.deepEqual((await eligibility(t, c, t.adminToken)).reasons, ["account_inactive"]);
    assert.equal((await t.call("POST", base + "/suspend", { token: t.adminToken })).status, 200, "idempotent");

    const r = await t.call("POST", base + "/reinstate", { token: t.adminToken });
    assert.equal(r.status, 200);
    assert.equal(await appStatus(t, q), "cancelled", "not resurrected");
    assert.ok(await consentService.activeConsent(c.candidateId, "submit"), "consent untouched");
    assert.equal((await eligibility(t, c, t.adminToken)).eligible, true);
    assert.equal((await t.call("POST", "/jobsearch/admin/users/999999/reinstate", { token: t.adminToken })).status, 404);
  });
});
