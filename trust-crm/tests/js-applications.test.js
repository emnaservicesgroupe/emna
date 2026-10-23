const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { makePdf } = require("./helpers/docs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-applications-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "js-apps-"));
delete process.env.CLAMAV_HOST;
process.env.JS_UPLOADS_PER_HOUR = "1000";

const coverLetter = require("../modules/jobsearch/coverLetter");
const applicationService = require("../modules/jobsearch/applicationService");

const PROFILE = {
  name: "Karim Benali",
  email: "karim@example.com",
  phone: "+216 20 000 000",
  profession: "Electrician",
  skills: ["Industrial wiring", "PLC maintenance"],
  experience: [
    { title: "Maintenance Electrician", employer: "Sfax Power Co", start: "2016", end: "2023" },
    { title: "Apprentice Electrician", employer: "Gabes Industries", start: "2014", end: null },
  ],
  education: ["Diploma in Electrical Engineering"],
  certificates: ["Electrical Safety Certificate", "Open work permit holder"],
  languages: [{ lang: "English", level: "fluent" }, { lang: "French", level: "intermediate" }],
};
const JOB_TEXT = "We are hiring an Electrician for our plant. Required: welding and a forklift license. Visa sponsorship available. You will maintain equipment.";

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
    const adminId = await mkUser("adm@test.invalid", "Admin");
    const agentA = await mkUser("agent-a@test.invalid", "Agent");
    const agentB = await mkUser("agent-b@test.invalid", "Agent");
    const managerA = await mkUser("manager-a@test.invalid", "Manager");
    const managerB = await mkUser("manager-b@test.invalid", "Manager");
    const tok = {
      admin: staffToken(adminId, "Admin"),
      agentA: staffToken(agentA, "Agent"),
      agentB: staffToken(agentB, "Agent"),
      managerA: staffToken(managerA, "Manager"),
      managerB: staffToken(managerB, "Manager"),
    };
    const ids = { adminId, agentA, agentB, managerA, managerB };
    let n = 0;
    /** Candidate with account, confirmed profile, preferences, settings and (optionally) consent. */
    const newCandidate = async ({ assignedTo = agentA, mode = "prepare_for_approval", consent = { search: true, prepare: true, submit: true }, needsSupport = true, residence = "Tunisia", profile = PROFILE } = {}) => {
      n += 1;
      const cid = (await pool.query("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`Cand ${n}`, `PP-APP-${n}`, assignedTo])).rows[0].id;
      const r = await call("POST", "/jobsearch/admin/candidate-accounts", { token: tok.admin, body: { candidate_id: cid, email: `cand${n}@test.invalid` } });
      assert.equal(r.status, 201);
      const tv = (await pool.query("SELECT token_version FROM users WHERE id=$1", [r.body.user_id])).rows[0].token_version;
      const token = jwt.sign({ id: r.body.user_id, role: "Candidate", tv }, process.env.JWT_SECRET, { expiresIn: "1h" });
      await pool.query("INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1,$2::jsonb,'confirmed',now())", [cid, JSON.stringify(profile)]);
      await pool.query(
        "INSERT INTO js_preferences (candidate_id, countries, categories, availability, salary_min, salary_currency, residence_country, needs_work_auth_support) VALUES ($1,'{Canada,Qatar,Tunisia}','{Electrician}','now',1000,'USD',$2,$3)",
        [cid, residence, needsSupport]
      );
      await pool.query("INSERT INTO js_candidate_settings (candidate_id, mode) VALUES ($1,$2)", [cid, mode]);
      if (consent) {
        const g = await call("POST", `/jobsearch/candidates/${cid}/consent`, { token, body: { scope: { ...consent, countries: [] }, version: "v1" } });
        assert.equal(g.status, 201);
      }
      return { candidateId: cid, userId: r.body.user_id, token };
    };
    /** Employer + open job + match for the candidate. */
    const newJob = async (c, { country = "Canada", title = "Electrician", employer = "Northwind Energy", support = "unknown", overseas = null, source = "partner_feed", text = JOB_TEXT, conflict = false } = {}) => {
      n += 1;
      const eid = (await pool.query("INSERT INTO js_employers (name, normalized_name) VALUES ($1,$2) RETURNING id", [employer, employer.toLowerCase()])).rows[0].id;
      const jobId = (await pool.query(
        "INSERT INTO js_jobs (title, country, location, employer_id, source_primary, dedupe_key, description_text, url) VALUES ($1,$2,$3,$4,$5,$6,$7,'https://jobs.example/1') RETURNING id",
        [title, country, `City, ${country}`, eid, source, `dk-app-${n}`, text]
      )).rows[0].id;
      const matchId = (await pool.query(
        "INSERT INTO js_matches (candidate_id, job_id, score, employer_support, employer_support_evidence, overseas_accepted, overseas_applicants_evidence, employer_support_conflict) VALUES ($1,$2,80,$3,$4,$5,$6,$7) RETURNING id",
        [c.candidateId, jobId, support, support === "unknown" ? null : "Visa sponsorship available.", overseas, overseas === null ? null : "International applicants welcome.", conflict]
      )).rows[0].id;
      return { jobId, matchId, employerId: eid };
    };
    const uploadCv = async (c, text) => {
      const form = new FormData();
      form.append("file", new Blob([makePdf(text)], { type: "application/pdf" }), "cv.pdf");
      const up = await call("POST", `/jobsearch/candidates/${c.candidateId}/cv`, { token: c.token, form });
      assert.equal(up.status, 201, JSON.stringify(up.body));
      // Uploading re-opens profile confirmation; these tests use a fixed confirmed profile.
      await pool.query("UPDATE js_profiles SET status='confirmed' WHERE candidate_id=$1", [c.candidateId]);
      return up.body.cvFileId;
    };
    const approveCv = async (c, cvFileId, language = "en", token = c.token) =>
      call("POST", `/jobsearch/cv-files/${cvFileId}/approve`, { token, body: { language } });
    const create = (c, matchId, token = c.token) => call("POST", "/jobsearch/applications", { token, body: { matchId } });
    const prepare = (id, token, body = {}) => call("POST", `/jobsearch/applications/${id}/prepare`, { token, body });
    const approve = (id, token) => call("POST", `/jobsearch/applications/${id}/approve`, { token, body: { reason: "reviewed" } });
    /** Candidate + approved CV + job + application prepared to ready_for_review. */
    const readyApp = async (opts = {}) => {
      const c = opts.candidate || (await newCandidate(opts));
      const cv = await uploadCv(c, "Karim Benali\nElectrician");
      assert.equal((await approveCv(c, cv, "en")).status, 200);
      const j = await newJob(c, opts.job || {});
      const a = await create(c, j.matchId);
      assert.equal(a.status, 201, JSON.stringify(a.body));
      const p = await prepare(a.body.application.id, tok.agentA);
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.equal(p.body.application.status, "ready_for_review");
      return { c, cv, ...j, appId: a.body.application.id };
    };
    const seedDoc = async (cid, docType) =>
      (await pool.query("INSERT INTO documents (candidate_id, doc_type, file_path) VALUES ($1,$2,$3) RETURNING id", [cid, docType, `/crm/${docType}-${cid}.pdf`])).rows[0].id;
    await fn({ pool, call, tok, ids, newCandidate, newJob, uploadCv, approveCv, create, prepare, approve, readyApp, seedDoc });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
  }
}

const timeline = async (t, id) => (await t.pool.query("SELECT * FROM js_timeline WHERE application_id=$1 ORDER BY id", [id])).rows;
const status = async (t, id) => (await t.pool.query("SELECT status FROM js_applications WHERE id=$1", [id])).rows[0].status;

// ---------------------------------------------------------------- cover letter (pure)

function tokensOf(s) {
  return new Set((String(s).match(/[\p{L}\p{N}]+/gu) || []).map((w) => w.toLowerCase()));
}

test("cover letter: every capitalised word and number comes from the confirmed profile, the job or the fixed template", () => {
  const job = { title: "Industrial Electrician", employer: "Northwind Energy", description_text: JOB_TEXT };
  for (const lang of ["en", "fr"]) {
    for (const needs of [true, false]) {
      const letter = coverLetter.generate(PROFILE, job, lang, { needsWorkAuthSupport: needs });
      const allowed = new Set([...tokensOf(JSON.stringify(PROFILE)), ...tokensOf(job.title), ...tokensOf(job.employer), ...tokensOf(coverLetter.staticText(lang))]);
      const claims = letter.match(/\b\p{Lu}[\p{L}'’-]*|\p{N}+/gu) || [];
      assert.ok(claims.length > 5);
      for (const tokRaw of claims) {
        for (const part of tokRaw.split(/['’-]/).filter(Boolean)) assert.ok(allowed.has(part.toLowerCase()), `${lang}: "${part}" is not from the profile/job/template`);
      }
      // Every non-template word is a profile/job word: nothing from the job's requirements leaks in.
      for (const w of tokensOf(letter)) {
        assert.ok(allowed.has(w), `${lang}: word "${w}" has no provenance`);
      }
      for (const invented of ["welding", "forklift", "license", "sponsorship", "years"]) assert.ok(!tokensOf(letter).has(invented), `${lang}: ${invented}`);
      assert.ok(letter.includes("Karim Benali") && letter.includes("Sfax Power Co") && letter.includes("2016") && letter.includes("PLC maintenance"));
    }
  }
});

test("cover letter never claims a permit, visa or eligibility; support need is stated only as needing employer support", () => {
  const job = { title: "Electrician (visa sponsorship)", employer: "Northwind Energy" };
  const tricky = { ...PROFILE, skills: [...PROFILE.skills, "Eligible to work in Canada"], education: ["Diploma", "References available on request"] };
  for (const lang of ["en", "fr", "ar"]) {
    const withSupport = coverLetter.generateDetailed(tricky, job, lang, { needsWorkAuthSupport: true });
    const without = coverLetter.generateDetailed(tricky, job, lang, { needsWorkAuthSupport: false });
    for (const r of [withSupport, without]) {
      assert.ok(!/eligib|visa|permit|sponsor|citizen|reference|permis|parrain|éligib|r[ée]f[ée]rence/i.test(r.text.replace(/employer support for work authorization|soutien de l'employeur pour l'autorisation de travail/, "")), `${lang}: ${r.text}`);
      assert.ok(r.omitted.includes("certificates") && r.omitted.includes("skills") && r.omitted.includes("job.title"));
    }
    if (lang === "en") {
      assert.ok(withSupport.text.includes("I would require employer support for work authorization."));
      assert.ok(!/authori[sz]/i.test(without.text));
    }
    if (lang === "fr") assert.ok(withSupport.text.includes("soutien de l'employeur"));
  }
  assert.equal(coverLetter.generate(PROFILE, job, "de"), coverLetter.generate(PROFILE, job, "en"), "deterministic, unknown language -> en");
  assert.equal(coverLetter.detectLanguage({ title: "Électricien", description_text: "Nous recherchons un électricien pour le poste de maintenance et vous serez" }), "fr");
  assert.equal(coverLetter.detectLanguage({ title: "Electrician", description_text: JOB_TEXT }), "en");
});

// ---------------------------------------------------------------- creation

test("createFromMatch is idempotent (one row per candidate+job, also under concurrency) and snapshots the responsible staff", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    const j = await t.newJob(c);
    const [r1, r2] = await Promise.all([t.create(c, j.matchId), t.create(c, j.matchId, t.tok.agentA)]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 201]);
    assert.equal(r1.body.application.id, r2.body.application.id);
    const r3 = await t.create(c, j.matchId);
    assert.equal(r3.status, 200);
    assert.equal(r3.body.application.id, r1.body.application.id);
    const rows = (await t.pool.query("SELECT * FROM js_applications WHERE candidate_id=$1", [c.candidateId])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "matched");
    assert.equal(rows[0].responsible_user_id, t.ids.agentA);
    assert.equal(rows[0].mode_at_creation, "prepare_for_approval");
    const tl = await timeline(t, rows[0].id);
    assert.equal(tl.filter((e) => e.event === "created").length, 1);
    assert.ok((await t.pool.query("SELECT 1 FROM js_audit_events WHERE application_id=$1 AND action='application.create'", [rows[0].id])).rowCount === 1);
    assert.ok((await t.pool.query("SELECT 1 FROM js_events WHERE candidate_id=$1 AND kind='application.created'", [c.candidateId])).rowCount === 1);
  });
});

test("search_only mode and missing search consent refuse to create an application", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate({ mode: "search_only" });
    const j = await t.newJob(c);
    const r = await t.create(c, j.matchId);
    assert.equal(r.status, 409);
    const c2 = await t.newCandidate({ consent: null });
    const j2 = await t.newJob(c2);
    assert.equal((await t.create(c2, j2.matchId)).status, 409);
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_applications")).rows[0].n, 0);
    // Someone else's match: 404, never created.
    const c3 = await t.newCandidate({ assignedTo: t.ids.agentB });
    const j3 = await t.newJob(c3);
    assert.equal((await t.create(c, j3.matchId)).status, 404);
    assert.equal((await t.create(c3, j3.matchId, t.tok.agentA)).status, 404);
  });
});

// ---------------------------------------------------------------- state machine

test("illegal transitions are 409 and every legal transition writes an insert-only timeline row", async () => {
  await withApp(async (t) => {
    const { appId, c } = await t.readyApp();
    await assert.rejects(() => applicationService.transition(appId, "sent", "system", { reason: "test" }), (e) => e.status === 409);
    await assert.rejects(() => applicationService.transition(appId, "confirmed_submitted", "system"), (e) => e.status === 409);
    assert.equal(await status(t, appId), "ready_for_review");
    const tl = await timeline(t, appId);
    const moves = tl.filter((e) => e.event === "status_changed").map((e) => `${e.detail.from}>${e.detail.to}`);
    assert.deepEqual(moves, ["matched>preparing", "preparing>ready_for_review"]);
    for (const e of tl) {
      assert.ok(e.actor, "actor recorded");
      assert.ok(e.detail && typeof e.detail.reason === "string" && e.detail.reason.length > 0, "reason recorded");
    }
    await assert.rejects(() => t.pool.query("UPDATE js_timeline SET event='x' WHERE application_id=$1", [appId]));
    // A direct jump the table does not allow (matched -> approved) is refused even with consent.
    const j = await t.newJob(c, { employer: "Other Co" });
    const a = await t.create(c, j.matchId);
    await assert.rejects(() => applicationService.transition(a.body.application.id, "approved", "system"), (e) => e.status === 409);
    await assert.rejects(() => applicationService.transition(a.body.application.id, "bogus", "system"), (e) => e.status === 400);
    assert.ok(applicationService.TRANSITIONS.queued.includes("sent") && !applicationService.TRANSITIONS.matched.includes("sent"));
  });
});

// ---------------------------------------------------------------- preparation + documents

test("prepare: letter from confirmed profile, approved CV in the job language, originals untouched", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    const cv1 = await t.uploadCv(c, "Karim Benali\nElectrician\nEnglish CV");
    const cv2 = await t.uploadCv(c, "Karim Benali\nElectricien\nCV francais");
    const cv3 = await t.uploadCv(c, "Karim Benali\nElectrician\nNew draft, not approved");
    assert.equal((await t.approveCv(c, cv1, "en")).status, 200);
    assert.equal((await t.approveCv(c, cv2, "fr", t.tok.admin)).status, 200);
    assert.equal((await t.approveCv(c, cv3, "en", t.tok.agentB)).status, 404, "out-of-scope staff");
    assert.equal((await t.approveCv(c, cv3, "en", t.tok.agentA)).status, 403, "approving a CV needs jobsearch:approve or the candidate");
    const before = (await t.pool.query("SELECT id, storage_key, sha256, version FROM js_cv_files WHERE candidate_id=$1 ORDER BY id", [c.candidateId])).rows;
    const bytes = before.map((r) => fs.readFileSync(path.join(process.env.STORAGE_DIR, r.storage_key)));

    const j = await t.newJob(c);
    const a = await t.create(c, j.matchId);
    const p = await t.prepare(a.body.application.id, t.tok.agentA);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.application.status, "ready_for_review");
    assert.deepEqual(p.body.package.blocked, []);
    const cvs = p.body.package.included.filter((d) => d.kind === "cv");
    assert.equal(cvs.length, 1);
    assert.equal(cvs[0].cvFileId, cv1, "latest APPROVED CV in the job language (unapproved v3 excluded)");
    const docs = (await t.pool.query("SELECT * FROM js_application_documents WHERE application_id=$1 AND removed_at IS NULL", [a.body.application.id])).rows;
    assert.equal(docs.length, 1);
    assert.equal(docs[0].cv_file_id, cv1);
    assert.equal(docs[0].version, before[0].version);
    assert.equal(docs[0].sha256, before[0].sha256);
    const letter = (await t.pool.query("SELECT cover_letter_text, cover_letter_lang FROM js_applications WHERE id=$1", [a.body.application.id])).rows[0];
    assert.equal(letter.cover_letter_lang, "en");
    assert.ok(letter.cover_letter_text.includes("Karim Benali") && letter.cover_letter_text.includes("employer support for work authorization"));
    assert.ok(!/welding|forklift|visa|permit/i.test(letter.cover_letter_text));

    const after = (await t.pool.query("SELECT id, storage_key, sha256, version FROM js_cv_files WHERE candidate_id=$1 ORDER BY id", [c.candidateId])).rows;
    assert.deepEqual(after, before, "CV rows untouched");
    after.forEach((r, i) => {
      const buf = fs.readFileSync(path.join(process.env.STORAGE_DIR, r.storage_key));
      assert.ok(buf.equals(bytes[i]));
      assert.equal(crypto.createHash("sha256").update(buf).digest("hex"), r.sha256);
    });

    // French job -> French CV; explicitly requesting the unapproved version is blocked.
    const jf = await t.newJob(c, { employer: "Hydro Quebec", text: "Nous recherchons un électricien pour le poste de maintenance et vous serez formé." });
    const af = await t.create(c, jf.matchId);
    const pf = await t.prepare(af.body.application.id, t.tok.agentA, { documents: [{ cvFileId: cv3 }] });
    assert.equal(pf.status, 200);
    assert.equal(pf.body.application.status, "preparing", "blocked document keeps it out of review");
    assert.deepEqual(pf.body.package.blocked.map((b) => b.reason), ["cv_not_approved"]);
    const pf2 = await t.prepare(af.body.application.id, t.tok.agentA, { documents: [] });
    assert.equal(pf2.body.application.status, "ready_for_review");
    assert.equal(pf2.body.package.included[0].cvFileId, cv2);
    assert.ok(pf2.body.coverLetter.startsWith("À l'attention"));
  });
});

test("CV language fallback is flagged language_mismatch; no approved CV blocks preparation", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    const j = await t.newJob(c);
    const a = await t.create(c, j.matchId);
    const none = await t.prepare(a.body.application.id, t.tok.agentA);
    assert.equal(none.status, 200);
    assert.equal(none.body.application.status, "preparing");
    assert.deepEqual(none.body.package.blocked.map((b) => b.reason), ["no_approved_cv"]);
    const cv = await t.uploadCv(c, "Karim\nElectricien");
    await t.approveCv(c, cv, "fr");
    const p = await t.prepare(a.body.application.id, t.tok.agentA);
    assert.equal(p.body.application.status, "ready_for_review");
    assert.ok(p.body.package.notes.some((x) => /^language_mismatch/.test(x)));
  });
});

test("sensitive documents: blocked without a candidate authorization; included (and audited) with one; revocation pulls it back", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    const cv = await t.uploadCv(c, "Karim Benali\nElectrician");
    await t.approveCv(c, cv, "en");
    const passport = await t.seedDoc(c.candidateId, "Passport");
    const diploma = await t.seedDoc(c.candidateId, "Diploma");
    const j = await t.newJob(c);
    const id = (await t.create(c, j.matchId)).body.application.id;

    const p1 = await t.prepare(id, t.tok.agentA, { documents: [{ documentId: passport }, { documentId: diploma }] });
    assert.equal(p1.status, 200);
    assert.equal(p1.body.application.status, "preparing");
    assert.equal(p1.body.package.blocked.length, 1);
    assert.equal(p1.body.package.blocked[0].doc.documentId, passport);
    assert.equal(p1.body.package.blocked[0].reason, "sensitive_document_requires_candidate_authorization");
    assert.ok(p1.body.package.included.some((d) => d.documentId === diploma));

    // Staff cannot create the authorization on the candidate's behalf; other candidates get 404.
    const body = { documentId: passport, legitimateNeed: "Employer requires passport copy for travel booking" };
    assert.equal((await t.call("POST", `/jobsearch/applications/${id}/sharing-authorizations`, { token: t.tok.agentA, body })).status, 403);
    assert.equal((await t.call("POST", `/jobsearch/applications/${id}/sharing-authorizations`, { token: t.tok.admin, body })).status, 403);
    assert.equal((await t.call("POST", `/jobsearch/applications/${id}/sharing-authorizations`, { token: t.tok.agentB, body })).status, 404);
    const other = await t.newCandidate();
    assert.equal((await t.call("POST", `/jobsearch/applications/${id}/sharing-authorizations`, { token: other.token, body })).status, 404);
    assert.equal((await t.call("POST", `/jobsearch/applications/${id}/sharing-authorizations`, { token: c.token, body: { documentId: passport, legitimateNeed: "  " } })).status, 400);
    const otherDoc = await t.seedDoc(other.candidateId, "Passport");
    assert.equal((await t.call("POST", `/jobsearch/applications/${id}/sharing-authorizations`, { token: c.token, body: { documentId: otherDoc, legitimateNeed: "x" } })).status, 404);
    // A row "granted" by staff (not the candidate) never counts.
    await t.pool.query("INSERT INTO js_sharing_authorizations (candidate_id, document_id, application_id, legitimate_need, granted_by) VALUES ($1,$2,$3,'needed',$4)", [c.candidateId, passport, id, t.ids.agentA]);
    const p2 = await t.prepare(id, t.tok.agentA, { documents: [{ documentId: passport }] });
    assert.equal(p2.body.package.blocked[0].reason, "sensitive_document_requires_candidate_authorization");

    const g = await t.call("POST", `/jobsearch/applications/${id}/sharing-authorizations`, { token: c.token, body });
    assert.equal(g.status, 201, JSON.stringify(g.body));
    const p3 = await t.prepare(id, t.tok.agentA, { documents: [{ documentId: passport }] });
    assert.equal(p3.body.application.status, "ready_for_review");
    const inc = p3.body.package.included.find((d) => d.documentId === passport);
    assert.ok(inc && inc.sensitive === true && inc.sharingAuthorizationId === g.body.id);
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_audit_events WHERE application_id=$1 AND action='document.sensitive_included'", [id])).rows[0].n, 1);
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_audit_events WHERE application_id=$1 AND action='sharing.grant'", [id])).rows[0].n, 1);

    // Approval re-validates the stored package: an authorization revoked behind its back blocks approval.
    await t.pool.query("UPDATE js_sharing_authorizations SET revoked_at = now() WHERE id=$1", [g.body.id]);
    const blockedApproval = await t.approve(id, t.tok.admin);
    assert.equal(blockedApproval.status, 409);
    assert.match(blockedApproval.body.error, /sensitive_unauthorized/);
    await t.pool.query("UPDATE js_sharing_authorizations SET revoked_at = NULL WHERE id=$1", [g.body.id]);

    // Staff cannot revoke for the candidate either.
    assert.equal((await t.call("DELETE", `/jobsearch/applications/${id}/sharing-authorizations/${g.body.id}`, { token: t.tok.agentA })).status, 403);
    const rv = await t.call("DELETE", `/jobsearch/applications/${id}/sharing-authorizations/${g.body.id}`, { token: c.token });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    assert.equal(await status(t, id), "preparing", "needs re-review");
    const live = (await t.pool.query("SELECT document_id FROM js_application_documents WHERE application_id=$1 AND removed_at IS NULL", [id])).rows;
    assert.ok(!live.some((r) => r.document_id === passport), "revoked document pulled from the package");
    assert.ok((await timeline(t, id)).some((e) => e.event === "status_changed" && e.detail.to === "preparing" && e.detail.reason === "sharing_authorization_revoked"));
    assert.equal((await t.approve(id, t.tok.admin)).status, 409);
    const p4 = await t.prepare(id, t.tok.agentA, { documents: [{ documentId: passport }] });
    assert.equal(p4.body.package.blocked[0].reason, "sensitive_document_requires_candidate_authorization");
  });
});

// ---------------------------------------------------------------- approval

test("approval: Manager in scope approves; Candidate 403; out-of-scope staff 404; package rows marked approved", async () => {
  await withApp(async (t) => {
    const { appId, c } = await t.readyApp();
    assert.equal((await t.approve(appId, c.token)).status, 403);
    assert.equal((await t.approve(appId, t.tok.agentA)).status, 403, "Agent lacks jobsearch:approve");
    assert.equal((await t.approve(appId, t.tok.managerB)).status, 404);
    assert.equal(await status(t, appId), "ready_for_review");
    await t.pool.query("UPDATE candidates SET assigned_to=$2 WHERE id=$1", [c.candidateId, t.ids.managerA]);
    const r = await t.approve(appId, t.tok.managerA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.application.status, "approved");
    const docs = (await t.pool.query("SELECT approved_by, approved_at FROM js_application_documents WHERE application_id=$1 AND removed_at IS NULL", [appId])).rows;
    assert.ok(docs.length > 0 && docs.every((d) => d.approved_by === t.ids.managerA && d.approved_at));
    assert.equal((await t.approve(appId, t.tok.managerA)).status, 409, "already approved");
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_audit_events WHERE application_id=$1 AND action='application.approve'", [appId])).rows[0].n, 1);
    assert.ok((await t.pool.query("SELECT 1 FROM audit_logs WHERE action='jobsearch.application.approve' AND record_id=$1", [String(appId)])).rowCount === 1);
  });
});

test("approve without submit consent, or after consent is withdrawn, is 409 and nothing is queued", async () => {
  await withApp(async (t) => {
    const { appId } = await t.readyApp({ consent: { search: true, prepare: true, submit: false } });
    const r = await t.approve(appId, t.tok.admin);
    assert.equal(r.status, 409);
    assert.equal(await status(t, appId), "ready_for_review");
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_queue")).rows[0].n, 0);

    const b = await t.readyApp();
    const w = await t.call("POST", `/jobsearch/candidates/${b.c.candidateId}/consent/withdraw`, { token: b.c.token, body: { scopeKey: "submit" } });
    assert.equal(w.status, 200);
    assert.equal((await t.approve(b.appId, t.tok.admin)).status, 409);
    assert.notEqual(await status(t, b.appId), "approved");

    // Paused candidate: approval refused too.
    const p = await t.readyApp();
    await t.pool.query("UPDATE js_candidate_settings SET paused=true WHERE candidate_id=$1", [p.c.candidateId]);
    assert.equal((await t.approve(p.appId, t.tok.admin)).status, 409);
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_queue WHERE kind='submit'")).rows[0].n, 0);
  });
});

test("two simultaneous approvals of the same application: exactly one succeeds", async () => {
  await withApp(async (t) => {
    const { appId } = await t.readyApp();
    const results = await Promise.all([t.approve(appId, t.tok.admin), t.approve(appId, t.tok.admin), t.approve(appId, t.tok.admin)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
    const moves = (await timeline(t, appId)).filter((e) => e.event === "status_changed" && e.detail.to === "approved");
    assert.equal(moves.length, 1);
  });
});

test("reject and cancel record reasons; cancel stops pending queue work", async () => {
  await withApp(async (t) => {
    const a = await t.readyApp();
    assert.equal((await t.call("POST", `/jobsearch/applications/${a.appId}/reject`, { token: t.tok.admin, body: {} })).status, 400, "reason required");
    assert.equal((await t.call("POST", `/jobsearch/applications/${a.appId}/reject`, { token: a.c.token, body: { reason: "x" } })).status, 403);
    const r = await t.call("POST", `/jobsearch/applications/${a.appId}/reject`, { token: t.tok.admin, body: { reason: "Letter needs a different CV" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.application.status, "cancelled");
    assert.ok((await timeline(t, a.appId)).some((e) => e.event === "review_rejected" && e.detail.reason === "Letter needs a different CV"));

    const b = await t.readyApp({ candidate: a.c, job: { employer: "Second Co" } });
    await t.pool.query("INSERT INTO js_queue (kind, payload) VALUES ('prepare', $1::jsonb)", [JSON.stringify({ applicationId: b.appId })]);
    assert.equal((await t.call("POST", `/jobsearch/applications/${b.appId}/cancel`, { token: a.c.token, body: {} })).status, 400);
    const cc = await t.call("POST", `/jobsearch/applications/${b.appId}/cancel`, { token: a.c.token, body: { reason: "I accepted another offer" } });
    assert.equal(cc.status, 200);
    assert.equal(cc.body.application.status, "cancelled");
    assert.equal((await t.pool.query("SELECT status FROM js_queue WHERE payload->>'applicationId'=$1", [String(b.appId)])).rows[0].status, "cancelled");
    assert.ok((await timeline(t, b.appId)).some((e) => e.detail.reason === "I accepted another offer"));
    assert.equal((await t.call("POST", `/jobsearch/applications/${b.appId}/cancel`, { token: a.c.token, body: { reason: "again" } })).status, 409);
  });
});

// ---------------------------------------------------------------- label-safety ruling

/** Admin-approved automatic mode with an explicit scope; approved_doc_versions = every CV version of the candidate. */
async function setAuto(t, cid, overrides = {}) {
  const cvs = (await t.pool.query("SELECT id, version FROM js_cv_files WHERE candidate_id=$1", [cid])).rows.map((r) => ({ cvFileId: r.id, version: r.version }));
  const s = { allowed_countries: ["Canada", "Tunisia"], allowed_professions: [], allowed_sources: [], cap_per_day: 10, cap_per_week: 50, salary_limit: null, approved_doc_versions: cvs, ...overrides };
  await t.pool.query(
    `UPDATE js_candidate_settings SET mode='automatic', admin_approved_by=$2, allowed_countries=$3, allowed_professions=$4, allowed_sources=$5,
       cap_per_day=$6, cap_per_week=$7, salary_limit=$8, approved_doc_versions=$9::jsonb WHERE candidate_id=$1`,
    [cid, t.ids.adminId, s.allowed_countries, s.allowed_professions, s.allowed_sources, s.cap_per_day, s.cap_per_week, s.salary_limit, JSON.stringify(s.approved_doc_versions)]
  );
  if (!(await t.pool.query("SELECT 1 FROM js_automation_rules WHERE candidate_id=$1", [cid])).rowCount) {
    await t.pool.query("INSERT INTO js_automation_rules (candidate_id, rule, approved_by, approved_at) VALUES ($1,'{}'::jsonb,$2,now())", [cid, t.ids.adminId]);
  }
}
const elig = (id) => applicationService.autoApproveEligibility(id);

test("autoApproveEligibility: only confirmed employer support (+ overseas acceptance) in admin-approved automatic mode", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate({ needsSupport: true, residence: "Tunisia" });
    await setAuto(t, c.candidateId);
    for (const support of ["stated_in_ad", "unknown", "unavailable"]) {
      const a = await t.readyApp({ candidate: c, job: { support, overseas: true, employer: `E-${support}` } });
      await setAuto(t, c.candidateId);
      const app = (await t.pool.query("SELECT * FROM js_applications WHERE id=$1", [a.appId])).rows[0];
      const e = await applicationService.autoApproveEligibility(app);
      assert.equal(e.allowed, false, support);
      assert.deepEqual(e.reasons.filter((r) => !r.startsWith("employer_support_unavailable")), ["employer_support_not_confirmed"], `${support}: ${e.reasons}`);
      const r = await applicationService.autoApprove(a.appId);
      assert.equal(r.approved, false);
      assert.equal(await status(t, a.appId), "ready_for_review", "stays for human approval");
    }
    const ok = await t.readyApp({ candidate: c, job: { support: "confirmed", overseas: true, employer: "E-confirmed" } });
    await setAuto(t, c.candidateId);
    assert.deepEqual(await elig(ok.appId), { allowed: true, reasons: [] });
    const noOverseas = await t.readyApp({ candidate: c, job: { support: "confirmed", overseas: null, employer: "E-nooverseas" } });
    await setAuto(t, c.candidateId);
    assert.deepEqual((await elig(noOverseas.appId)).reasons, ["overseas_acceptance_not_confirmed"]);
    const conflict = await t.readyApp({ candidate: c, job: { support: "confirmed", overseas: true, conflict: true, employer: "E-conflict" } });
    await setAuto(t, c.candidateId);
    assert.deepEqual((await elig(conflict.appId)).reasons, ["employer_support_conflict"]);
    // Same-country job for a candidate needing support: the support label does not gate it.
    const local = await t.readyApp({ candidate: c, job: { country: "Tunisia", support: "unknown", employer: "E-local" } });
    await setAuto(t, c.candidateId);
    assert.deepEqual(await elig(local.appId), { allowed: true, reasons: [] });

    // Not automatic / no admin-approved rule -> never.
    const m = await t.newCandidate({ needsSupport: false });
    const am = await t.readyApp({ candidate: m, job: { support: "confirmed", overseas: true } });
    assert.ok((await elig(am.appId)).reasons.includes("mode_not_automatic"));
    await t.pool.query("UPDATE js_candidate_settings SET mode='automatic' WHERE candidate_id=$1", [m.candidateId]);
    const e2 = await elig(am.appId);
    for (const r of ["automatic_mode_not_admin_approved", "no_admin_approved_rule", "country_scope_missing", "no_admin_approved_documents", "cap_not_set"]) assert.ok(e2.reasons.includes(r), r);
    // Human approval of an unconfirmed-support application is still possible (this IS the human approval).
    const human = await t.readyApp({ candidate: c, job: { support: "stated_in_ad", overseas: null, employer: "E-human" } });
    assert.equal((await t.approve(human.appId, t.tok.admin)).status, 200);
  });
});

test("autoApprove enforces the admin scope, caps and package; approves as system:auto exactly once", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate({ needsSupport: true, residence: "Tunisia" });
    const good = { support: "confirmed", overseas: true };
    const mk = async (job, overrides) => {
      const a = await t.readyApp({ candidate: c, job: { ...good, employer: `E-${Math.random()}`, ...job } });
      await setAuto(t, c.candidateId, overrides);
      return a.appId;
    };
    const reasonsOf = async (id) => (await applicationService.autoApprove(id)).reasons;
    assert.deepEqual(await reasonsOf(await mk({ country: "Qatar" })), ["country_not_allowed"]);
    assert.deepEqual(await reasonsOf(await mk({}, { allowed_professions: ["Plumber"] })), ["profession_not_allowed"]);
    assert.deepEqual(await reasonsOf(await mk({}, { allowed_sources: ["jobbank_ca"] })), ["source_not_allowed"]);
    assert.deepEqual(await reasonsOf(await mk({}, { salary_limit: 2000 })), ["salary_unverifiable"]);
    assert.deepEqual(await reasonsOf(await mk({ support: "stated_in_ad" })), ["employer_support_not_confirmed"]);
    assert.deepEqual(await reasonsOf(await mk({}, { approved_doc_versions: [{ cvFileId: 999999 }] })), ["document_version_not_admin_approved"]);
    const changed = await mk({});
    const cvId = (await t.pool.query("SELECT cv_file_id FROM js_application_documents WHERE application_id=$1 AND removed_at IS NULL", [changed])).rows[0].cv_file_id;
    await t.pool.query("UPDATE js_cv_files SET approved=false WHERE id=$1", [cvId]);
    assert.deepEqual(await reasonsOf(changed), ["package_invalid:cv_not_approved"]);
    // Consent countries narrower than the admin scope.
    await t.pool.query("UPDATE js_consents SET scope = scope || '{\"countries\":[\"Tunisia\"]}'::jsonb WHERE candidate_id=$1 AND withdrawn_at IS NULL", [c.candidateId]);
    assert.deepEqual(await reasonsOf(await mk({})), ["country_outside_consent"]);
    await t.pool.query("UPDATE js_consents SET scope = scope || '{\"countries\":[]}'::jsonb WHERE candidate_id=$1 AND withdrawn_at IS NULL", [c.candidateId]);

    // All rules satisfied; two concurrent autoApprove calls -> one approval.
    const id = await mk({}, { cap_per_day: 1 });
    const both = await Promise.all([applicationService.autoApprove(id), applicationService.autoApprove(id)]);
    assert.deepEqual(both.map((r) => r.approved).sort(), [false, true]);
    assert.equal(await status(t, id), "approved");
    const moves = (await timeline(t, id)).filter((e) => e.event === "status_changed" && e.detail.to === "approved");
    assert.equal(moves.length, 1);
    assert.equal(moves[0].actor, "system:auto");
    assert.equal(moves[0].detail.reason, "auto_approved_within_admin_rules");
    // Cap of 1/day is now used by that approval.
    assert.deepEqual(await reasonsOf(await mk({}, { cap_per_day: 1 })), ["cap_per_day_exceeded"]);
    assert.deepEqual(await reasonsOf(await mk({}, { cap_per_day: 10, cap_per_week: 1 })), ["cap_per_week_exceeded"]);
    assert.ok((await t.pool.query("SELECT 1 FROM js_audit_events WHERE application_id=$1 AND action='application.auto_approve'", [id])).rowCount === 1);

    // The raw transition cannot be used by a system actor to bypass autoApprove.
    const raw = await mk({}, { cap_per_day: 100, cap_per_week: 100 });
    await assert.rejects(() => applicationService.transition(raw, "approved", "system"), (e) => e.status === 403);
    await assert.rejects(() => applicationService.transition(raw, "approved", "system:auto"), (e) => e.status === 403);
    await assert.rejects(() => applicationService.transition(raw, "approved", { id: t.ids.agentA, role: "Agent" }), (e) => e.status === 403);
    assert.equal(await status(t, raw), "ready_for_review");
  });
});

// ---------------------------------------------------------------- reads, scope, filters

test("list/get are scoped: staff B and other candidates see nothing (no counts), deleted candidates are invisible", async () => {
  await withApp(async (t) => {
    const a = await t.readyApp();
    const passport = await t.seedDoc(a.c.candidateId, "passport");
    await t.call("POST", `/jobsearch/applications/${a.appId}/sharing-authorizations`, { token: a.c.token, body: { documentId: passport, legitimateNeed: "travel" } });
    const listB = await t.call("GET", "/jobsearch/applications", { token: t.tok.agentB });
    assert.equal(listB.status, 200);
    assert.deepEqual(listB.body.applications, []);
    assert.equal(listB.body.total, 0);
    assert.equal((await t.call("GET", `/jobsearch/applications?candidateId=${a.c.candidateId}`, { token: t.tok.agentB })).body.total, 0);
    assert.equal((await t.call("GET", `/jobsearch/applications/${a.appId}`, { token: t.tok.agentB })).status, 404);
    assert.equal((await t.call("POST", `/jobsearch/applications/${a.appId}/prepare`, { token: t.tok.agentB, body: {} })).status, 404);
    assert.equal((await t.call("POST", `/jobsearch/applications/${a.appId}/cancel`, { token: t.tok.agentB, body: { reason: "x" } })).status, 404);
    const other = await t.newCandidate();
    assert.equal((await t.call("GET", "/jobsearch/applications", { token: other.token })).body.total, 0);
    assert.equal((await t.call("GET", `/jobsearch/applications/${a.appId}`, { token: other.token })).status, 404);
    const hr = await t.pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('hr','hr@test.invalid','x','HR') RETURNING id");
    const hrTok = jwt.sign({ id: hr.rows[0].id, role: "HR" }, process.env.JWT_SECRET);
    assert.equal((await t.call("GET", `/jobsearch/applications/${a.appId}`, { token: hrTok })).status, 404);
    assert.equal((await t.call("GET", "/jobsearch/applications", { token: hrTok })).status, 403);

    const own = await t.call("GET", `/jobsearch/applications/${a.appId}`, { token: a.c.token });
    assert.equal(own.status, 200);
    const d = own.body;
    assert.equal(d.application.status, "ready_for_review");
    assert.ok(d.timeline.length >= 3);
    assert.ok(d.documents.length >= 1 && d.documents.every((x) => !("storage_key" in x) && !("storageKey" in x)));
    const key = (await t.pool.query("SELECT storage_key FROM js_cv_files WHERE id=$1", [a.cv])).rows[0].storage_key;
    assert.ok(!JSON.stringify(d).includes(key), "never leaks storage keys");
    assert.equal(d.job.title, "Electrician");
    assert.equal(d.employer.name, "Northwind Energy");
    assert.equal(d.match.employerSupport.label, "unknown");
    assert.match(d.match.employerSupport.notice, /verify with the employer/i);
    assert.match(d.notice, /does not establish/);
    assert.ok(d.sharingAuthorizations.length === 1 && d.sharingAuthorizations[0].legitimateNeed === "travel");
    assert.equal(d.autoApproval, undefined, "staff-only field hidden from candidates");
    const staffView = await t.call("GET", `/jobsearch/applications/${a.appId}`, { token: t.tok.agentA });
    assert.equal(staffView.status, 200);
    assert.equal(staffView.body.autoApproval.allowed, false);
    assert.equal((await t.call("GET", "/jobsearch/applications", { token: t.tok.agentA })).body.total, 1);

    await t.pool.query("UPDATE candidates SET is_deleted=true WHERE id=$1", [a.c.candidateId]);
    assert.equal((await t.call("GET", "/jobsearch/applications", { token: t.tok.admin })).body.total, 0);
    assert.equal((await t.call("GET", `/jobsearch/applications/${a.appId}`, { token: t.tok.admin })).status, 404);
    assert.equal((await t.approve(a.appId, t.tok.admin)).status, 404);
  });
});

test("list filters return the correct subsets; bad filters are 400; pagination bounded", async () => {
  await withApp(async (t) => {
    const c1 = await t.newCandidate({ assignedTo: t.ids.agentA });
    const c2 = await t.newCandidate({ assignedTo: t.ids.agentB });
    const j1 = await t.newJob(c1, { country: "Canada", title: "Electrician", employer: "Alpha", source: "partner_feed" });
    const j2 = await t.newJob(c1, { country: "Qatar", title: "Plumber", employer: "Beta", source: "manual_import" });
    const j3 = await t.newJob(c2, { country: "Canada", title: "Welder", employer: "Gamma", source: "partner_feed" });
    const a1 = (await t.create(c1, j1.matchId)).body.application.id;
    const a2 = (await t.create(c1, j2.matchId)).body.application.id;
    const a3 = (await t.create(c2, j3.matchId)).body.application.id;
    await t.pool.query("UPDATE js_applications SET created_at = '2026-01-15' WHERE id=$1", [a1]);
    await t.pool.query("UPDATE js_applications SET status='cancelled' WHERE id=$1", [a2]);
    const q = async (qs, token = t.tok.admin) => {
      const r = await t.call("GET", `/jobsearch/applications${qs}`, { token });
      assert.equal(r.status, 200, `${qs}: ${JSON.stringify(r.body)}`);
      return r.body.applications.map((x) => x.id).sort((x, y) => x - y);
    };
    assert.deepEqual(await q(""), [a1, a2, a3]);
    assert.deepEqual(await q(`?candidateId=${c1.candidateId}`), [a1, a2]);
    assert.deepEqual(await q("?country=canada"), [a1, a3]);
    assert.deepEqual(await q("?profession=plumb"), [a2]);
    assert.deepEqual(await q(`?staffId=${t.ids.agentB}`), [a3]);
    assert.deepEqual(await q(`?employerId=${j2.employerId}`), [a2]);
    assert.deepEqual(await q("?sourceKey=partner_feed"), [a1, a3]);
    assert.deepEqual(await q("?status=cancelled"), [a2]);
    assert.deepEqual(await q("?from=2026-02-01"), [a2, a3]);
    assert.deepEqual(await q("?to=2026-02-01"), [a1]);
    assert.deepEqual(await q("?country=Canada", t.tok.agentA), [a1]);
    assert.deepEqual(await q("", c2.token), [a3]);
    const page = await t.call("GET", "/jobsearch/applications?pageSize=2&page=2", { token: t.tok.admin });
    assert.equal(page.body.total, 3);
    assert.equal(page.body.applications.length, 1);
    for (const bad of ["?status=bogus", "?candidateId=abc", "?from=yesterday", "?page=10001", "?pageSize=0", "?pageSize=101"]) {
      assert.equal((await t.call("GET", `/jobsearch/applications${bad}`, { token: t.tok.admin })).status, 400, bad);
    }
  });
});

// ---------------------------------------------------------------- fix round 1

const documentPolicy = require("../modules/jobsearch/documentPolicy");
const SENSITIVE_NAMES = ["ID", "ID copy", "CNI", "NID", "Pasaporte", "Reisepass", "Pasaport", "Bulletin n°3", "B3", "good conduct certificate", "bonne conduite", "Fiche anthropométrique", "casier judiciaire", "extrait de casier", "criminal record", "certificat médical", "medical report", "vaccination", "visa", "permis de séjour", "residence permit", "birth certificate", "acte de naissance", "marriage certificate", "carte d'identité", "driver's licence", "", "Scan 2024", "Health and Safety certificate", "medical certificate",
  // round 2: prefix-safe leaks, spacing/confusable/invisible tricks, more ID/medical/civil/finance terms, fail-closed names
  "CV + pasport", "CV and pass port", "CV p\u0430ssport", "CV pass\u200Bport", "CV pass\u00ADport", "CV + CNIE", "CV + DNI", "CV + NIE", "CV + BI", "CV + iqama", "CV + tazkira", "CV + Aadhaar", "CV + carte consulaire",
  "CV + numéro sécu", "CV + NIR", "CV + carte vitale", "CV + mutuelle", "Diploma + Führerschein", "CV / Aufenthaltstitel", "CV + HIV test", "CV + pregnancy test", "CV + test de grossesse",
  "CV + handicap", "CV + disability", "Training certificate - drug test", "CV + relevé bancaire", "CV + fiche familiale", "Diploma + état civil", "CV + extrait d'acte", "Diploma + carte grise",
  "CV + licence", "certificate", "licence", "Licence en informatique", "سيرة الموظف"];
const SAFE_NAMES = ["CV", "Résumé", "CV_final.pdf", "CV (Arabic)", "cv english v2", "Curriculum Vitae FR", "Diplôme", "Degree", "Master", "Transcript", "Relevé de notes", "IELTS result", "Portfolio", "Trade licence", "Red Seal", "Training certificate", "Cover letter", "Lebenslauf", "السيرة الذاتية", "دبلوم"];

test("document types are sensitive by default: every listed name is blocked without authorization; CV/cover letter/diploma pass", async () => {
  for (const n of SENSITIVE_NAMES) assert.ok(documentPolicy.sensitiveType(n), `${JSON.stringify(n)} must be sensitive`);
  for (const n of [...SAFE_NAMES, "Lettre de motivation"]) assert.equal(documentPolicy.sensitiveType(n), null, n);
  assert.equal(documentPolicy.sensitiveType("CV + iqama"), "national_id");
  assert.equal(documentPolicy.sensitiveType("CV + HIV test"), "medical");
  assert.equal(documentPolicy.sensitiveType("CV + relevé bancaire"), "financial");
  assert.equal(documentPolicy.sensitiveType("Diploma + état civil"), "civil_status");
  assert.equal(documentPolicy.sensitiveType("CV p\u0430ssport"), "passport");
  assert.equal(documentPolicy.sensitiveType("Licence en informatique"), "unclassified");
  await withApp(async (t) => {
    const c = await t.newCandidate();
    const cv = await t.uploadCv(c, "Karim Benali\nElectrician");
    await t.approveCv(c, cv, "en");
    const j = await t.newJob(c);
    const id = (await t.create(c, j.matchId)).body.application.id;
    const docs = [];
    for (const n of SENSITIVE_NAMES) docs.push({ n, id: await t.seedDoc(c.candidateId, n) });
    for (let i = 0; i < docs.length; i += 15) {
      const batch = docs.slice(i, i + 15);
      const p = await t.prepare(id, t.tok.agentA, { documents: batch.map((d) => ({ documentId: d.id })) });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.equal(p.body.application.status, "preparing");
      for (const d of batch) {
        const b = p.body.package.blocked.find((x) => x.doc.documentId === d.id);
        assert.ok(b && b.reason === "sensitive_document_requires_candidate_authorization", JSON.stringify(d.n));
      }
      assert.equal(p.body.package.included.filter((x) => x.kind === "document").length, 0);
    }
    const safe = [];
    for (const n of ["CV", "Cover letter", "Diplôme", "CV_final.pdf", "Lebenslauf", "Trade licence"]) safe.push(await t.seedDoc(c.candidateId, n));
    const ok = await t.prepare(id, t.tok.agentA, { documents: safe.map((documentId) => ({ documentId })) });
    assert.equal(ok.body.application.status, "ready_for_review");
    assert.deepEqual(ok.body.package.included.filter((x) => x.kind === "document").map((x) => x.documentId).sort((a, b) => a - b), safe);
  });
});

test("approval re-validates the package: un-approved/infected CV, deleted or changed document, null CV hash restored lazily", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    const cv = await t.uploadCv(c, "Karim Benali\nElectrician");
    await t.approveCv(c, cv, "en");
    const mkReady = async (k) => {
      const j = await t.newJob(c, { employer: `Reval ${k}` });
      const id = (await t.create(c, j.matchId)).body.application.id;
      const diploma = await t.seedDoc(c.candidateId, "Diploma");
      const p = await t.prepare(id, t.tok.agentA, { documents: [{ documentId: diploma }] });
      assert.equal(p.body.application.status, "ready_for_review", JSON.stringify(p.body));
      return { id, diploma };
    };
    const expect409 = async (id, code) => {
      const r = await t.approve(id, t.tok.admin);
      assert.equal(r.status, 409, `${code}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, new RegExp(code));
      assert.equal(await status(t, id), "ready_for_review");
    };
    const a = await mkReady("a");
    await t.pool.query("UPDATE js_cv_files SET approved=false WHERE id=$1", [cv]);
    await expect409(a.id, "cv_not_approved");
    await t.pool.query("UPDATE js_cv_files SET approved=true WHERE id=$1", [cv]);

    await t.pool.query("UPDATE js_cv_files SET scan_status='infected' WHERE id=$1", [cv]);
    await expect409(a.id, "cv_infected");
    await t.pool.query("UPDATE js_cv_files SET scan_status='scan_unavailable' WHERE id=$1", [cv]);

    const b = await mkReady("b");
    await t.pool.query("UPDATE documents SET is_deleted=true WHERE id=$1", [b.diploma]);
    await expect409(b.id, "document_deleted");

    const d = await mkReady("d");
    const put = await t.call("PUT", `/documents/${d.diploma}`, { token: t.tok.agentA, body: { file_path: "/crm/diploma-v2.pdf" } });
    assert.equal(put.status, 200);
    await expect409(d.id, "document_changed");

    // A legacy CV row without a recorded hash gets it from storage at package time (not a permanent block).
    const sha = (await t.pool.query("SELECT sha256 FROM js_cv_files WHERE id=$1", [cv])).rows[0].sha256;
    await t.pool.query("UPDATE js_cv_files SET sha256=NULL WHERE id=$1", [cv]);
    const e = await mkReady("e");
    assert.equal((await t.pool.query("SELECT sha256 FROM js_cv_files WHERE id=$1", [cv])).rows[0].sha256, sha);
    assert.equal((await t.approve(e.id, t.tok.admin)).status, 200);
  });
});

test("mode switched to search_only after preparation: approve and queue are refused", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate({ assignedTo: t.ids.managerA });
    const cv = await t.uploadCv(c, "Karim Benali\nElectrician");
    await t.approveCv(c, cv, "en");
    const mk = async (k) => {
      const j = await t.newJob(c, { employer: `Mode ${k}` });
      const id = (await t.create(c, j.matchId)).body.application.id;
      assert.equal((await t.prepare(id, t.tok.managerA)).body.application.status, "ready_for_review");
      return id;
    };
    const a1 = await mk(1);
    const a2 = await mk(2);
    assert.equal((await t.approve(a2, t.tok.managerA)).status, 200);
    const s = await t.call("PUT", `/jobsearch/candidates/${c.candidateId}/settings`, { token: t.tok.managerA, body: { mode: "search_only" } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const r = await t.approve(a1, t.tok.managerA);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /mode_search_only/);
    const grant = { [applicationService._internal.SYSTEM_GRANT]: true, reason: "test" };
    await assert.rejects(() => applicationService.transition(a2, "queued", "system:submitter", grant), (e) => e.status === 409 && /mode_search_only/.test(e.message));
    await assert.rejects(() => applicationService.transition(a2, "queued", "system:submitter", { reason: "no grant" }), (e) => e.status === 403);
    assert.equal(await status(t, a2), "approved");
    assert.equal(await status(t, a1), "ready_for_review");
    await assert.rejects(() => t.prepare(a1, t.tok.managerA).then((x) => { if (x.status !== 200) throw Object.assign(new Error(), { status: x.status }); }), (e) => e.status === 409);
  });
});

test("revoking an authorization from approved or queued pulls the document and returns to preparing", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    const cv = await t.uploadCv(c, "Karim Benali\nElectrician");
    await t.approveCv(c, cv, "en");
    const mk = async (k) => {
      const j = await t.newJob(c, { employer: `Rev ${k}` });
      const id = (await t.create(c, j.matchId)).body.application.id;
      const passport = await t.seedDoc(c.candidateId, "Passport");
      const g = await t.call("POST", `/jobsearch/applications/${id}/sharing-authorizations`, { token: c.token, body: { documentId: passport, legitimateNeed: "Employer books flights" } });
      assert.equal(g.status, 201);
      assert.equal((await t.prepare(id, t.tok.agentA, { documents: [{ documentId: passport }] })).body.application.status, "ready_for_review");
      assert.equal((await t.approve(id, t.tok.admin)).status, 200);
      return { id, passport, authId: g.body.id };
    };
    const ap = await mk("approved");
    const q = await mk("queued");
    await applicationService.transition(q.id, "queued", "system:submitter", { [applicationService._internal.SYSTEM_GRANT]: true, reason: "test enqueue" });
    await t.pool.query("INSERT INTO js_queue (kind, payload) VALUES ('submit', $1::jsonb)", [JSON.stringify({ applicationId: q.id })]);
    for (const x of [ap, q]) {
      const r = await t.call("DELETE", `/jobsearch/applications/${x.id}/sharing-authorizations/${x.authId}`, { token: c.token });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await status(t, x.id), "preparing");
      const live = (await t.pool.query("SELECT 1 FROM js_application_documents WHERE application_id=$1 AND document_id=$2 AND removed_at IS NULL", [x.id, x.passport])).rowCount;
      assert.equal(live, 0);
    }
    assert.equal((await t.pool.query("SELECT status FROM js_queue WHERE payload->>'applicationId'=$1", [String(q.id)])).rows[0].status, "cancelled");
  });
});

test("cover letter: hostile job title cannot inject a claim; Arabic letter tokens have provenance", () => {
  for (const title of ["Welder. I have 10 years experience", "Welder\nI hold a work permit", "Welder - I have 10 years experience", "I am certified, hire me"]) {
    const r = coverLetter.generateDetailed(PROFILE, { title, employer: "Acme" }, "en", { needsWorkAuthSupport: false });
    assert.ok(!/10 years|I have|I hold|certified|hire me|permit/i.test(r.text), r.text);
  }
  assert.ok(coverLetter.generate(PROFILE, { title: "Welder. I have 10 years experience", employer: "Acme" }, "en").includes("apply for the Welder position."));
  const long = "W".repeat(200);
  assert.ok(!coverLetter.generate(PROFILE, { title: long, employer: "Acme" }, "en").includes("W".repeat(81)));

  const job = { title: "كهربائي صناعي", employer: "شركة الطاقة" };
  const letter = coverLetter.generate(PROFILE, job, "ar", { needsWorkAuthSupport: true });
  const allowed = new Set([...tokensOf(JSON.stringify(PROFILE)), ...tokensOf(job.title), ...tokensOf(job.employer), ...tokensOf(coverLetter.staticText("ar"))]);
  for (const w of tokensOf(letter)) assert.ok(allowed.has(w), `ar: "${w}" has no provenance`);
  assert.ok(letter.includes("كهربائي صناعي") && letter.includes("Karim Benali") && letter.includes("2016"));
});

test("CV bytes or recorded sha256 changed after packaging, and an authorization revoked by a direct DB update, are caught", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    const cv = await t.uploadCv(c, "Karim Benali\nElectrician");
    await t.approveCv(c, cv, "en");
    const row = (await t.pool.query("SELECT storage_key, sha256 FROM js_cv_files WHERE id=$1", [cv])).rows[0];
    const file = path.join(process.env.STORAGE_DIR, row.storage_key);
    const mk = async (k, documents = []) => {
      const j = await t.newJob(c, { employer: `Bytes ${k}` });
      const id = (await t.create(c, j.matchId)).body.application.id;
      assert.equal((await t.prepare(id, t.tok.agentA, { documents })).body.application.status, "ready_for_review");
      return id;
    };
    const original = fs.readFileSync(file);
    // Bytes swapped on disk after packaging (row unchanged) -> cv_bytes_changed, at approval and after it.
    const a = await mk("a");
    const b = await mk("b");
    assert.equal((await t.approve(b, t.tok.admin)).status, 200);
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from("tampered")]));
    const r = await t.approve(a, t.tok.admin);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /cv_bytes_changed/);
    const appB = (await t.pool.query("SELECT * FROM js_applications WHERE id=$1", [b])).rows[0];
    assert.deepEqual(await documentPolicy.revalidateStoredPackage(t.pool, appB), [{ code: "cv_bytes_changed", cvFileId: cv }]);
    fs.writeFileSync(file, original);
    // Recorded sha256 changed on the row -> cv_changed.
    await t.pool.query("UPDATE js_cv_files SET sha256=$2 WHERE id=$1", [cv, "0".repeat(64)]);
    assert.deepEqual(await documentPolicy.revalidateStoredPackage(t.pool, appB), [{ code: "cv_changed", cvFileId: cv }]);
    const r2 = await t.approve(a, t.tok.admin);
    assert.equal(r2.status, 409);
    assert.match(r2.body.error, /cv_changed/);
    await t.pool.query("UPDATE js_cv_files SET sha256=$2 WHERE id=$1", [cv, row.sha256]);

    // Authorization revoked directly in the DB (not via revokeSharing): approval refuses.
    const passport = await t.seedDoc(c.candidateId, "Passport");
    const j = await t.newJob(c, { employer: "Bytes auth" });
    const id = (await t.create(c, j.matchId)).body.application.id;
    const g = await t.call("POST", `/jobsearch/applications/${id}/sharing-authorizations`, { token: c.token, body: { documentId: passport, legitimateNeed: "Employer books flights" } });
    assert.equal(g.status, 201);
    assert.equal((await t.prepare(id, t.tok.agentA, { documents: [{ documentId: passport }] })).body.application.status, "ready_for_review");
    await t.pool.query("UPDATE js_sharing_authorizations SET revoked_at = now() WHERE id=$1", [g.body.id]);
    const r3 = await t.approve(id, t.tok.admin);
    assert.equal(r3.status, 409);
    assert.match(r3.body.error, /sensitive_unauthorized/);
    assert.equal(await status(t, id), "ready_for_review");
    assert.equal((await t.approve(a, t.tok.admin)).status, 200, "restored bytes + sha -> valid again");
  });
});
