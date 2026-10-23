// orgs-e2e-README
// End-to-end journeys for the employer and agency portals (stage 3, Task 8). REAL HTTP server (app.listen(0) +
// fetch), REAL Postgres schema (fresh per file), real staff logins through /auth/login, portal users invited by
// staff and logged in by the REAL e-mail OTP flow (code read from the sandbox mailbox), and the shared helper
// tests/helpers/e2e.js (which also fences globalThis.fetch: no network). Limits come from injected env.
//
//   A  employer: staff creates + invites -> OTP login -> request -> in_review -> share consent -> preview ->
//      present -> employer sees ONLY the six summary keys (no name/email/phone/passport anywhere in the raw
//      text) -> responds interview -> staff sees it -> consent withdrawn -> employer list empty, detail/respond
//      404; employer B sees nothing of employer A.
//   B  agency: staff creates + invites -> OTP login -> registers a candidate and a duplicate of an existing
//      record (identical status/shape) -> staff sees both, duplicate flagged -> convert (agency_id propagates)
//      -> stage -> agency sees the stage label; agency B sees nothing of agency A.
//   C  suspension kills the token at once; reactivate + new OTP login works.
//   D  earlier journeys still work (converted candidate's /jobsearch profile) and the all-routes sweep passes.
//
// NOT covered (by design): a real mail provider, a real domain / HTTPS, a browser (see orgs-ui).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "orgs-e2e-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orgs-e2e-"));
process.env.STORAGE_URL_SECRET = "orgs-e2e-storage-secret";
process.env.MAIL_PROVIDER = "sandbox";
process.env.MAIL_SANDBOX_ALLOWLIST = "*@test.invalid,*@*.test.invalid";
process.env.MAIL_FROM = "applications@vita.test.invalid";
process.env.SITE_IP_SALT = "orgs-e2e-salt";
// Deterministic limits injected through env: high enough for the journeys, never defaults that depend on the host.
process.env.EMPLOYER_REQUESTS_PER_DAY = "50";
process.env.AGENCY_CANDIDATES_PER_DAY = "50";
for (const k of ["CLAMAV_HOST", "MAIL_REAL_SEND"]) delete process.env[k];

const E = require("./helpers/e2e");

const SUMMARY_KEYS = ["availability", "country_of_residence", "languages", "profession", "staff_note_for_employer", "years_experience"];
const ITEM_KEYS = ["created_at", "employer_note", "id", "request_id", "request_title", "responded_at", "status", "summary"];
const AGENCY_KEYS = ["country", "created_at", "full_name", "id", "profession", "stage", "status_text"];
// Strings from the seeded candidate that must never reach an employer.
const SECRETS = ["Karim Zouaoui", "karim.z@test.invalid", "+216 20 123 456", "TN-PASS-77123", "SENSITIVE-ID-889", "SecretCorp", "1988-03-04"];

let w;
test.before(async () => {
  w = await E.startWorld();
  await E.addStaff(w, "admin", "Admin");
  await E.addStaff(w, "mgr", "Manager");
  await E.addStaff(w, "rec", "Receptionist");
});
test.after(async () => {
  if (w) await w.close().catch(() => {});
  assert.deepEqual(E.blockedNetwork, [], "no network call left the test process");
});

/** The invite mails the first sign-in code (as for converted candidates): read it from the sandbox mailbox and verify it. */
async function loginWithInviteCode(email) {
  await require("../modules/jobsearch/otp")._testing.flush();
  const mails = (await w.q("SELECT * FROM js_sandbox_mail WHERE to_addr = $1 ORDER BY id", [email])).rows;
  assert.equal(mails.length, 1, "exactly one invite mail");
  assert.equal(mails[0].subject, E.OTP_SUBJECT);
  const m = /\b(\d{6})\b/.exec(mails[0].body);
  assert.ok(m, "the invite mail carries a 6-digit code");
  const bad = await w.http("POST", "/jobsearch/auth/otp/verify", null, { email, code: m[1] === "000000" ? "111111" : "000000" });
  assert.equal(bad.status, 401, "wrong code refused");
  const v = await w.http("POST", "/jobsearch/auth/otp/verify", null, { email, code: m[1] });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal((await w.http("POST", "/jobsearch/auth/otp/verify", null, { email, code: m[1] })).status, 401, "single use");
  return v.body.token;
}

/** Staff creates the organisation and invites its portal user; the user logs in by the real OTP flow. */
async function onboardOrg(type, name, email) {
  const base = type === "employer" ? "/crm/employers" : "/crm/agencies";
  const org = await w.http("POST", base, w.tokens.admin, { name, contact_name: "Contact", email, country: "Germany" });
  assert.equal(org.status, 201, JSON.stringify(org.body));
  const inv = await w.http("POST", `${base}/${org.body.id}/invite`, w.tokens.admin, { email, full_name: `${name} User` });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.inviteSent, true, "invite code mail requested");
  const token = await loginWithInviteCode(email);
  return { id: org.body.id, userId: inv.body.user.id, email, token };
}

let seeded;
async function seedCandidate() {
  const add = await w.http("POST", "/candidates/add", w.tokens.admin, { full_name: "Karim Zouaoui", passport_number: "TN-PASS-77123", nationality: "Tunisian", email: "karim.z@test.invalid", phone: "+216 20 123 456", assigned_to: w.users.mgr });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const id = add.body.id;
  await w.q("UPDATE candidates SET email = $2, phone = $3 WHERE id = $1", [id, "karim.z@test.invalid", "+216 20 123 456"]);
  await w.q(`INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1,$2::jsonb,'confirmed',now())`, [
    id,
    JSON.stringify({
      name: "Karim Zouaoui", email: "karim.z@test.invalid", phone: "+216 20 123 456", passport: "TN-PASS-77123", dob: "1988-03-04", national_id: "SENSITIVE-ID-889",
      profession: "Electrician", skills: ["PLC"], education: [{ school: "SecretCorp Academy" }],
      languages: [{ lang: "Arabic", level: "native" }, { lang: "French", level: "B2" }],
      experience: [{ title: "Electrician", employer: "SecretCorp", start: "2014-01", end: "2022-01" }],
    }),
  ]);
  await w.q("INSERT INTO js_preferences (candidate_id, availability, residence_country) VALUES ($1,'immediately','Tunisia')", [id]);
  return id;
}

test("A: employer journey, summary-only sharing, consent withdrawal, isolation", async () => {
  seeded = await seedCandidate();
  const empA = await onboardOrg("employer", "Alpha Bau GmbH", "hr@alpha-bau.test.invalid");
  const empB = await onboardOrg("employer", "Beta Montage Ltd", "hr@beta-montage.test.invalid");

  const me = await w.http("GET", "/employer/me", empA.token);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.role, "Employer");
  assert.equal((await w.http("GET", "/crm/leads", empA.token)).status, 403, "portal token is not a staff token");

  const rq = await w.http("POST", "/employer/requests", empA.token, { title: "Electricians for Hamburg", positions: 2, country: "Germany", city: "Hamburg", description: "Industrial wiring" });
  assert.equal(rq.status, 201, JSON.stringify(rq.body));
  const rid = rq.body.id;
  assert.equal((await w.http("GET", `/employer/requests/${rid}`, empA.token)).body.status, "submitted");
  assert.equal((await w.http("GET", `/employer/requests/${rid}`, empB.token)).status, 404, "request of A invisible to B");
  assert.equal((await w.http("GET", "/employer/requests", empB.token)).body.total ?? (await w.http("GET", "/employer/requests", empB.token)).body.requests.length, 0);

  // Staff reviews: not presentable before in_review / consent.
  const nrq = (url) => `/crm/employer-requests/${rid}${url}`;
  assert.equal((await w.http("POST", nrq("/presentations"), w.tokens.mgr, { candidate_id: seeded })).status, 409, "request still 'submitted'");
  const mv = await w.http("PATCH", nrq(""), w.tokens.mgr, { status: "in_review", staff_note: "INTERNAL-NOTE-XYZ", employer_visible_note: "We are on it" });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  const noConsent = await w.http("POST", nrq("/presentations"), w.tokens.mgr, { candidate_id: seeded });
  assert.equal(noConsent.status, 409);
  assert.match(noConsent.body.error, /consent/i);

  const cons = await w.http("POST", `/crm/candidates/${seeded}/share-consents`, w.tokens.mgr, { employer_id: empA.id, basis: "signed form 2026-10-01" });
  assert.equal(cons.status, 201, JSON.stringify(cons.body));
  const prev = await w.http("GET", nrq(`/presentation-preview?candidate_id=${seeded}&staff_note_for_employer=Strong%20profile`), w.tokens.mgr);
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.presentable, true);
  assert.deepEqual(Object.keys(prev.body.summary).sort(), SUMMARY_KEYS);
  const pres = await w.http("POST", nrq("/presentations"), w.tokens.mgr, { candidate_id: seeded, staff_note_for_employer: "Strong profile" });
  assert.equal(pres.status, 201, JSON.stringify(pres.body));
  assert.deepEqual(pres.body.summary, prev.body.summary, "what staff previewed is what was shared");

  // Employer sees the six allowlisted keys and nothing else; no seeded identifier anywhere in the raw text.
  const list = await w.http("GET", "/employer/presentations", empA.token);
  assert.equal(list.status, 200);
  assert.equal(list.body.presentations.length, 1);
  const item = list.body.presentations[0];
  assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
  assert.deepEqual(Object.keys(item.summary).sort(), SUMMARY_KEYS);
  assert.equal(item.summary.profession, "Electrician");
  assert.equal(item.summary.staff_note_for_employer, "Strong profile");
  const detail = await w.http("GET", `/employer/presentations/${item.id}`, empA.token);
  assert.equal(detail.status, 200);
  assert.deepEqual(Object.keys(detail.body.summary).sort(), SUMMARY_KEYS);
  const rawText = JSON.stringify(await Promise.all([w.http("GET", "/employer/presentations", empA.token), w.http("GET", `/employer/presentations/${item.id}`, empA.token), w.http("GET", `/employer/requests/${rid}`, empA.token), w.http("GET", "/employer/requests", empA.token), w.http("GET", "/employer/me", empA.token)].map(async (p) => (await p).body)));
  for (const s of SECRETS.concat(["INTERNAL-NOTE-XYZ", '"candidate_id"'])) assert.ok(!rawText.includes(s), `employer response leaks ${s}`);
  assert.equal((await w.http("GET", `/employer/requests/${rid}`, empA.token)).body.employer_visible_note, "We are on it");

  // Employer B cannot see or answer anything of A.
  assert.equal((await w.http("GET", "/employer/presentations", empB.token)).body.presentations.length, 0);
  assert.equal((await w.http("GET", `/employer/presentations/${item.id}`, empB.token)).status, 404);
  assert.equal((await w.http("POST", `/employer/presentations/${item.id}/respond`, empB.token, { status: "interview" })).status, 404);

  // Respond; staff sees the response in /crm/presentations.
  const resp = await w.http("POST", `/employer/presentations/${item.id}/respond`, empA.token, { status: "interview", note: "Call next week" });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  assert.equal(resp.body.status, "interview");
  const staffList = await w.http("GET", `/crm/presentations?request_id=${rid}`, w.tokens.mgr);
  assert.equal(staffList.status, 200);
  const sp = staffList.body.rows.find((r) => String(r.id) === String(item.id));
  assert.ok(sp, "presentation visible to staff");
  assert.equal(sp.status, "interview");
  assert.equal(sp.employer_note, "Call next week");

  // Withdrawal of the share consent hides the candidate from the employer at once.
  const wd = await w.http("DELETE", `/crm/candidates/${seeded}/share-consents/${cons.body.id}`, w.tokens.mgr);
  assert.equal(wd.status, 200, JSON.stringify(wd.body));
  assert.equal((await w.http("GET", "/employer/presentations", empA.token)).body.presentations.length, 0);
  assert.equal((await w.http("GET", `/employer/presentations/${item.id}`, empA.token)).status, 404);
  assert.equal((await w.http("POST", `/employer/presentations/${item.id}/respond`, empA.token, { status: "interested" })).status, 404);

  w.empA = empA;
  w.empB = empB;
});

test("B: agency journey, duplicate non-disclosure, convert carries agency_id, stage visible, isolation", async () => {
  const agA = await onboardOrg("agency", "Atlas Recruiting", "desk@atlas.test.invalid");
  const agB = await onboardOrg("agency", "Boussole Agency", "desk@boussole.test.invalid");
  const me = await w.http("GET", "/agency/me", agA.token);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.role, "Agency");
  assert.equal((await w.http("GET", "/employer/me", agA.token)).status, 403, "agency token is not an employer token");
  assert.equal((await w.http("GET", "/agency/me", w.empA.token)).status, 403, "employer token is not an agency token");

  const fresh = await w.http("POST", "/agency/candidates", agA.token, { full_name: "Nour Ayari", email: "nour@test.invalid", profession: "Welder", country: "Tunisia", consent_attested: true });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  // Duplicate of the existing candidate record (same e-mail): same status, same shape, no disclosure.
  const dup = await w.http("POST", "/agency/candidates", agA.token, { full_name: "Someone Else", email: "KARIM.Z@test.invalid", profession: "Welder", country: "Tunisia", consent_attested: true });
  assert.equal(dup.status, fresh.status);
  assert.deepEqual(Object.keys(dup.body).sort(), Object.keys(fresh.body).sort());
  assert.ok(!JSON.stringify(dup.body).toLowerCase().includes("duplicate"));

  // Staff sees both leads (source agency); the duplicate carries the flag.
  const leads = await w.http("GET", "/crm/leads?limit=100", w.tokens.rec);
  assert.equal(leads.status, 200);
  const lf = leads.body.rows.find((l) => String(l.id) === String(fresh.body.id));
  const ld = leads.body.rows.find((l) => String(l.id) === String(dup.body.id));
  assert.ok(lf && ld, "both agency leads visible to staff");
  assert.equal(lf.source, "agency");
  assert.equal(ld.source, "agency");
  const flags = (await w.q("SELECT id, duplicate_of, duplicate_candidate_id, agency_id FROM crm_leads WHERE id = ANY($1::bigint[]) ORDER BY id", [[fresh.body.id, dup.body.id]])).rows;
  assert.equal(flags[0].duplicate_of === null && flags[0].duplicate_candidate_id === null, true, "fresh lead is not flagged");
  assert.equal(String(flags[1].duplicate_candidate_id), String(seeded), "duplicate flagged against the existing candidate");
  assert.equal(String(flags[1].agency_id), String(agA.id));
  assert.equal(await w.count("SELECT count(*) AS n FROM crm_timeline WHERE entity='lead' AND entity_id=$1 AND event='duplicate_flagged'", [dup.body.id]), 1);

  // Convert: agency_id propagates; stage set by staff; agency sees the label.
  const conv = await w.http("POST", `/crm/leads/${fresh.body.id}/convert`, w.tokens.rec, { passport_number: "TN-AG-0001", nationality: "Tunisian", createPortalLogin: true });
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  const cid = conv.body.candidate.id;
  assert.equal(String((await w.one("SELECT agency_id FROM candidates WHERE id=$1", [cid])).agency_id), String(agA.id));
  let one = await w.http("GET", `/agency/candidates/${fresh.body.id}`, agA.token);
  assert.equal(one.status, 200);
  assert.equal(one.body.status_text, "Registered");
  assert.equal((await w.http("PATCH", `/crm/candidates/${cid}/stage`, w.tokens.rec, { stage: "interview" })).status, 200);
  one = await w.http("GET", `/agency/candidates/${fresh.body.id}`, agA.token);
  assert.deepEqual(Object.keys(one.body).sort(), AGENCY_KEYS);
  assert.equal(one.body.stage, "interview");
  assert.equal(one.body.status_text, "Interview");
  const listA = await w.http("GET", "/agency/candidates", agA.token);
  assert.equal(listA.body.total, 2);
  assert.ok(!JSON.stringify(listA.body).includes("TN-AG-0001"), "no passport to the agency");
  assert.ok(!JSON.stringify(listA.body).includes("karim.z@test.invalid"), "the existing record is not disclosed");

  // Agency B sees nothing of agency A.
  assert.equal((await w.http("GET", "/agency/candidates", agB.token)).body.total, 0);
  for (const id of [fresh.body.id, dup.body.id]) assert.equal((await w.http("GET", `/agency/candidates/${id}`, agB.token)).status, 404);
  assert.equal((await w.http("GET", `/agency/candidates/c${cid}`, agB.token)).status, 404);

  // Earlier journey still works: the converted candidate logs in by OTP and uses the job-search module.
  const candToken = await loginWithInviteCode("nour@test.invalid");
  const me2 = await w.http("GET", "/jobsearch/auth/me", candToken);
  assert.equal(me2.body.role, "Candidate");
  assert.equal(me2.body.candidate_id, cid);
  assert.equal((await w.http("GET", `/jobsearch/candidates/${cid}/profile`, candToken)).status, 404, "no CV yet");
  const up = await E.uploadCv(w, { id: cid }, E.makePdf("Nour Ayari\nWelder\nEmail: nour@test.invalid\n\nSKILLS\nMIG welding\n\nWORK EXPERIENCE\nWelder | Sfax Industries | 2014 - Present\n\nLANGUAGES\nFrench (Fluent)"), "cv.pdf", candToken);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal((await w.http("GET", `/jobsearch/candidates/${cid}/profile`, candToken)).status, 200);
  assert.equal((await w.http("GET", "/agency/me", candToken)).status, 403);
});

test("C: suspension kills the token at once; reactivate + new OTP login works", async () => {
  const { empA } = w;
  assert.equal((await w.http("GET", "/employer/me", empA.token)).status, 200);
  const sus = await w.http("POST", `/crm/employers/${empA.id}/suspend`, w.tokens.admin);
  assert.equal(sus.status, 200, JSON.stringify(sus.body));
  assert.equal(sus.body.status, "suspended");
  for (const [m, p] of [["GET", "/employer/me"], ["GET", "/employer/requests"], ["GET", "/employer/presentations"]]) {
    assert.equal((await w.http(m, p, empA.token)).status, 401, `${p} with the old token`);
  }
  // Employer B is unaffected.
  assert.equal((await w.http("GET", "/employer/me", w.empB.token)).status, 200);
  const re = await w.http("POST", `/crm/employers/${empA.id}/reactivate`, w.tokens.admin);
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.equal((await w.http("GET", "/employer/me", empA.token)).status, 401, "the old token stays dead after reactivation");
  // The 60 s per-address resend cooldown (kept in the DB) has elapsed by the time the employer comes back.
  await w.q("UPDATE js_otps SET created_at = created_at - interval '5 minutes' WHERE email = $1", [empA.email]);
  const fresh = await E.otpLogin(w, empA.email);
  assert.equal((await w.http("GET", "/employer/me", fresh)).status, 200);
  assert.equal((await w.http("GET", "/employer/requests", fresh)).status, 200);
});

test("D: the all-routes authorization sweep file still passes", () => {
  const r = spawnSync(process.execPath, ["--test", path.join(__dirname, "orgs-route-sweep.test.js")], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", NODE_TEST_CONTEXT: undefined }, timeout: 240000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-3000));
  assert.match(r.stdout, /# pass [1-9]/, "the sweep actually ran");
  assert.match(r.stdout, /# fail 0/);
});
