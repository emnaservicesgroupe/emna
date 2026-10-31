// canada-e2e-README
// Stage 8, Task 8: the Canada service journey end to end. Real HTTP server (app.listen(0) + fetch), a REAL Postgres schema, real logins
// (SuperAdmin bootstrap -> /auth/login, staff via /auth/register, candidates by admin-created account + e-mail OTP from the sandbox
// mailbox), a real CV upload (generated PDF), the test_fixture job source, sandbox mail, an HMAC-signed inbound webhook and
// scheduler.tick(now) with the injected clock from tests/helpers/e2e.js. globalThis.fetch is fenced (no network).
//
//   C1 one journey: candidate reference -> CV upload + confirmed profile -> consent -> Canadian CV (PDF + DOCX, confirmed facts only)
//      -> Agent cannot approve / Manager approves / candidate authorises -> job found, classified (verbatim quote rule), match band,
//      Manager accepts (require_match_acceptance) -> application prepared with the exact authorised Canadian CV -> approve + queue +
//      sandbox send -> employer opt-out reply -> suppression, opted_out employer, staff task, guard refusals (queue + retry path)
//      -> employer history scoping -> company / candidate reports (PDF + XLSX, numbers = raw SQL) -> accounting gate
//      (legal review + signed contract, legacy invoice route, payments) -> portal tokens denied on the new staff routes.
//   C2 the all-routes authorization sweep still passes (child process).
//
// NOT covered here (by design): real job sources, real SMTP/IMAP, a browser UI (canada-ui.test.js covers the screens' wiring), ClamAV,
// scheduled report snapshots (js-report-export.test.js, injected clock), and any legal judgement - the platform only records reviews.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "canada-e2e-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "canada-e2e-"));
process.env.STORAGE_URL_SECRET = process.env.STORAGE_URL_SECRET || "canada-e2e-storage-secret";
process.env.MAIL_PROVIDER = "sandbox";
process.env.MAIL_SANDBOX_ALLOWLIST = "*@test.invalid,*@*.test.invalid";
process.env.MAIL_FROM = "applications@vita.test.invalid";
process.env.INBOUND_MAIL_SECRET = "canada-e2e-inbound-secret";
process.env.JOBSEARCH_EXPORT_RATE_PER_HOUR = "1000";
process.env.JOBSEARCH_REPORT_RATE_PER_HOUR = "1000";
process.env.JS_UPLOADS_PER_HOUR = "1000";
process.env.REPORT_TIMEZONE = "Africa/Tunis";
process.env.ALLOW_UNSCANNED_ATTACHMENTS = "true"; // the uploaded original is never scanned in tests (no ClamAV); generated CVs are recorded 'clean'
for (const k of ["CLAMAV_HOST", "MAIL_REAL_SEND", "INBOUND_AUTO_ACK_EVIDENCE", "APPLICATIONS_PER_TICK", "MATCH_AUTO_PREPARE_MIN", "MATCH_MIN_SCORE", "JOBBANK_CA_FEED_URL", "PARTNER_FEED_URLS", "JOBSEARCH_INBOX_REVIEWER_ID", "REPORT_SCHEDULE_ENABLED", "JOBSEARCH_REPORT_MAX_ROWS", "FIN_DEFAULT_JURISDICTION", "HR_TIMEZONE"]) delete process.env[k];

const E = require("./helpers/e2e");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");
const fixture = require("../modules/jobsearch/sources/testFixture");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const REF_RE = /^CAN-\d{4}-\d{4,}$/;

// ---------------------------------------------------------------- readers: zip / docx / xlsx / pdf (node built-ins + pdf-parse)
function zipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert.ok(eocd >= 0, "not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const entryName = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    if (entryName === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
const unxml = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const docxText = (buf) => unxml(zipEntry(buf, "word/document.xml").toString("utf8").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, ""));
async function pdfText(buf) {
  const { PDFParse } = require("pdf-parse");
  const p = new PDFParse({ data: new Uint8Array(buf) });
  try {
    return (await p.getText()).text;
  } finally {
    if (typeof p.destroy === "function") await p.destroy().catch(() => {});
  }
}
const colIndex = (letters) => [...letters].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
/** { sheetName: [[value]] } (shared strings resolved, numbers as numbers) */
function readXlsx(buf) {
  const wb = zipEntry(buf, "xl/workbook.xml").toString("utf8");
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unxml(m[1]));
  const sstXml = zipEntry(buf, "xl/sharedStrings.xml");
  const sst = sstXml ? [...sstXml.toString("utf8").matchAll(/<si>(.*?)<\/si>/gs)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((x) => x[1]).join(""))) : [];
  const out = {};
  names.forEach((name, i) => {
    const xml = zipEntry(buf, `xl/worksheets/sheet${i + 1}.xml`).toString("utf8");
    const rows = [];
    for (const rm of xml.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
      const row = [];
      for (const cm of rm[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
        const t = /t="(\w+)"/.exec(cm[2]);
        const v = /<v>(.*?)<\/v>/s.exec(cm[3] || "");
        if (v) row[colIndex(cm[1])] = t && t[1] === "s" ? sst[Number(v[1])] : Number(v[1]);
      }
      rows[Number(rm[1]) - 1] = row;
    }
    out[name] = Array.from(rows, (r) => r || []);
  });
  return out;
}

// ---------------------------------------------------------------- world
const worlds = [];
test.after(async () => {
  for (const w of worlds) await w.close().catch(() => {});
  assert.deepEqual(E.blockedNetwork, [], "no network call left the test process");
});

/** Binary-safe GET (the shared w.http parses JSON/text only). */
async function raw(w, url, token) {
  const res = await fetch(`${w.base}${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  if ((res.headers.get("content-type") || "").includes("json")) json = JSON.parse(buf.toString("utf8"));
  return { status: res.status, buf, json, headers: res.headers };
}
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// ---------------------------------------------------------------- the personal data that must never reach a Canadian CV
const SENT = { dob: "1984-05-12", dobAlt: "12/05/1984", nationality: "Tunisian", marital: "Married", passport: "P1234567" };
const CV_TEXT = [
  "Karim Benali",
  "Electrical Technician",
  "Email: karim.benali@example.com | Phone: +216 22 345 678",
  "Sfax, Tunisia",
  "",
  "SKILLS",
  "Electrical installation, PLC programming, Industrial maintenance, AutoCAD Electrical",
  "",
  "WORK EXPERIENCE",
  "Senior Electrician | Gulf Build LLC | 2019 - Present",
  "- Led a team of six on commercial building installations",
  "Electrician | Sfax Industries | 2015 - 2019",
  "- Maintained production-line motors and control panels",
  "",
  "EDUCATION",
  "Higher Diploma in Electrical Engineering, University of Sfax, 2014",
  "",
  "LANGUAGES",
  "Arabic (Native), French (Fluent), English (B2)",
  "",
  "PERSONAL DETAILS",
  `Date of birth: ${SENT.dobAlt} | Nationality: ${SENT.nationality} | Marital status: ${SENT.marital} | Passport: ${SENT.passport}`,
].join("\n");
const NEEDLES = [SENT.dob, SENT.dobAlt, "1984", SENT.nationality, SENT.marital, SENT.passport, "Date of birth", "Nationality", "Marital", "Passport", "Electrical Technician"];

const AD_PLAIN = "Commercial and industrial wiring, conduit bending and PLC troubleshooting at our Toronto sites. English required. International applicants are welcome to apply. Send your CV to jobs@maple.test.invalid.";

// =====================================================================================================
// C1
// =====================================================================================================
test("C1 Canada service journey: reference -> confirmed profile -> Canadian CV -> approve + authorise -> classify/accept -> send -> opt-out -> suppression -> reports -> billing gate", async () => {
  fixture._reset();
  const w = await E.startWorld();
  worlds.push(w);
  for (const [k, role] of [["admin", "Admin"], ["mgr", "Manager"], ["mgr2", "Manager"], ["agent", "Agent"], ["acct", "Accountant"]]) await E.addStaff(w, k, role);
  const emp = await createEmployerUser(w.pool);
  const agy = await createAgencyUser(w.pool);
  const clock = w.clock;
  const T = w.tokens;
  const U = w.users;

  // ---- 1. reference assigned at creation; visible to staff in scope and to the candidate; not to other staff
  const A = await E.createCandidate(w, "A", "mgr"); // Manager mgr owns A (a Manager may approve inside their own scope)
  const refA = (await w.one("SELECT reference FROM candidates WHERE id = $1", [A.id])).reference;
  assert.match(refA, REF_RE);
  assert.equal(refA.slice(4, 8), String(new Date().getUTCFullYear()), "the reference carries the creation year");
  assert.equal((await w.http("GET", `/jobsearch/candidates/${A.id}/extras`, T.mgr)).body.reference, refA);
  assert.equal((await w.http("GET", `/jobsearch/candidates/${A.id}/extras`, T.admin)).body.reference, refA);
  assert.equal((await w.http("GET", "/jobsearch/me/extras", A.token)).body.reference, refA, "the candidate sees the own reference");
  assert.equal((await w.http("GET", `/jobsearch/candidates/${A.id}/extras`, T.agent)).status, 404, "an unassigned agent does not see the candidate");
  // a Manager B (second manager) owns candidate B; and the agent owns candidate C (the 'agent sees only assigned' checks use C)
  const B = await E.createCandidate(w, "B", "mgr2");
  assert.notEqual((await w.one("SELECT reference FROM candidates WHERE id = $1", [B.id])).reference, refA);
  const C = await E.createCandidate(w, "C", "agent");
  const edit = await w.http("PATCH", `/jobsearch/me/extras`, A.token, { city: "Sfax", desired_province: "ON" });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  // personal facts that exist on the candidate row but are NOT in the confirmed profile
  await w.q("UPDATE candidates SET date_of_birth = $2, nationality = $3 WHERE id = $1", [A.id, SENT.dob, SENT.nationality]);

  // ---- 2. CV upload (real PDF) and profile; a Canadian CV is refused until the profile is CONFIRMED
  const pdf = E.makePdf(CV_TEXT);
  const up = await E.uploadCv(w, A, pdf, "cv.pdf");
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const cvFileId = up.body.cvFileId;
  const early = await w.http("POST", `/jobsearch/candidates/${A.id}/canadian-cv`, T.mgr, {});
  assert.equal(early.status, 409, "an extracted-but-unconfirmed profile never feeds a Canadian CV");
  const conf = await w.http("PUT", `/jobsearch/candidates/${A.id}/profile/confirm`, A.token, { edits: { profession: "Electrician" }, preferences: E.PREFS({ residence_country: "Tunisia", needs_work_auth_support: true }) });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  assert.equal(conf.body.status, "confirmed");
  // an unconfirmed place carrying the sensitive strings (extracted data, edited after confirmation): the CV must still not use it
  await w.q("UPDATE js_profiles SET extracted = extracted || $2::jsonb WHERE candidate_id = $1", [A.id, JSON.stringify({ date_of_birth: SENT.dob, nationality: SENT.nationality, marital_status: SENT.marital, passport_number: SENT.passport })]);
  assert.equal((await w.http("POST", `/jobsearch/cv-files/${cvFileId}/approve`, A.token, { language: "en" })).status, 200);

  // ---- 3. consent (candidate): search + prepare (+ submit, needed for the send step)
  const g = await w.http("POST", `/jobsearch/candidates/${A.id}/consent`, A.token, { scope: E.CONSENT(), version: "2026-10-v1" });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal((await w.http("GET", `/jobsearch/candidates/${A.id}/eligibility`, A.token)).body.eligible, true);
  assert.equal((await w.http("PUT", `/jobsearch/candidates/${A.id}/settings`, T.admin, { mode: "prepare_for_approval", cap_per_day: 5, cap_per_week: 20 })).status, 200);

  // ---- 4. staff generates the Canadian CV; PDF + DOCX named <reference>-CV-V1; only confirmed facts
  const gen = await w.http("POST", `/jobsearch/candidates/${A.id}/canadian-cv`, T.mgr, {});
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.equal(gen.body.version, 1);
  assert.deepEqual(gen.body.files.map((f) => f.name).sort(), [`${refA}-CV-V1.docx`, `${refA}-CV-V1.pdf`]);
  const dlPdf = await raw(w, `/jobsearch/candidates/${A.id}/canadian-cv/1/download?format=pdf`, T.mgr);
  const dlDocx = await raw(w, `/jobsearch/candidates/${A.id}/canadian-cv/1/download?format=docx`, T.mgr);
  assert.equal(dlPdf.status, 200);
  assert.equal(dlDocx.status, 200);
  assert.match(dlPdf.headers.get("content-disposition"), new RegExp(`filename="${refA}-CV-V1\\.pdf"`));
  const texts = { pdf: await pdfText(dlPdf.buf), docx: docxText(dlDocx.buf) };
  for (const [fmt, text] of Object.entries(texts)) {
    assert.ok(text.includes("Karim Benali"), `${fmt}: name`);
    assert.ok(text.includes("Electrician"), `${fmt}: the CONFIRMED (edited) profession`);
    assert.ok(text.includes("Gulf Build LLC") && text.includes("PLC programming"), `${fmt}: confirmed experience and skills`);
    for (const n of NEEDLES) assert.ok(!text.includes(n), `${fmt} must not contain "${n}"`);
  }
  assert.equal(sha(dlPdf.buf), (await w.one("SELECT sha256 FROM js_cv_files WHERE candidate_id = $1 AND kind = 'canadian' AND format = 'pdf'", [A.id])).sha256, "the download is the stored file");
  // not visible to the candidate until staff approve
  assert.deepEqual((await w.http("GET", "/jobsearch/me/canadian-cv", A.token)).body.versions || [], []);
  assert.equal((await w.http("POST", "/jobsearch/me/canadian-cv/1/authorise", A.token)).status, 409, "the candidate cannot authorise before staff approval");

  // ---- 5. an Agent cannot approve; the Manager approves; the candidate authorises
  const agentGen = await w.http("POST", `/jobsearch/candidates/${C.id}/canadian-cv`, T.agent, {});
  assert.equal(agentGen.status, 409, "candidate C has no confirmed profile: refused for the Agent too");
  await w.q("UPDATE candidates SET assigned_to = $2 WHERE id = $1", [A.id, U.agent]);
  assert.equal((await w.http("POST", `/jobsearch/candidates/${A.id}/canadian-cv/1/approve`, T.agent)).status, 403, "Agent: no approval right");
  await w.q("UPDATE candidates SET assigned_to = $2 WHERE id = $1", [A.id, U.mgr]);
  assert.equal((await w.http("POST", `/jobsearch/candidates/${A.id}/canadian-cv/1/approve`, A.token)).status, 403, "the candidate cannot staff-approve");
  assert.equal((await w.http("POST", `/jobsearch/candidates/${A.id}/canadian-cv/1/approve`, T.mgr2)).status, 404, "another manager: out of scope");
  const appr = await w.http("POST", `/jobsearch/candidates/${A.id}/canadian-cv/1/approve`, T.mgr);
  assert.equal(appr.status, 200, JSON.stringify(appr.body));
  assert.equal(appr.body.status, "staff_approved");
  assert.equal((await w.http("GET", "/jobsearch/me/canadian-cv", A.token)).status, 200);
  const au = await w.http("POST", "/jobsearch/me/canadian-cv/1/authorise", A.token);
  assert.equal(au.status, 200, JSON.stringify(au.body));
  assert.equal(au.body.status, "authorised");
  const own = await raw(w, "/jobsearch/me/canadian-cv/1/download?format=pdf", A.token);
  assert.equal(own.status, 200);
  assert.equal(sha(own.buf), sha(dlPdf.buf));
  assert.equal((await raw(w, "/jobsearch/me/canadian-cv/1/download?format=pdf", B.token)).status, 404, "another candidate never gets it");

  // ---- 6. candidate B is onboarded normally (an uploaded CV, no Canadian CV) - the same employer will be contacted twice
  const Bc = await (async () => {
    const pdfB = E.makePdf("Amine Trabelsi\nElectrician\nEmail: cand-b@test.invalid\n\nSKILLS\nIndustrial wiring, PLC programming\n\nWORK EXPERIENCE\nElectrician | Sfax Industries | 2014 - Present\n\nLANGUAGES\nEnglish (Fluent), French (Fluent)");
    const upB = await E.uploadCv(w, B, pdfB, "cv.pdf");
    assert.equal(upB.status, 201, JSON.stringify(upB.body));
    assert.equal((await w.http("PUT", `/jobsearch/candidates/${B.id}/profile/confirm`, B.token, { edits: { profession: "Electrician" }, preferences: E.PREFS() })).status, 200);
    assert.equal((await w.http("POST", `/jobsearch/cv-files/${upB.body.cvFileId}/approve`, B.token, { language: "en" })).status, 200);
    assert.equal((await w.http("POST", `/jobsearch/candidates/${B.id}/consent`, B.token, { scope: E.CONSENT(), version: "2026-10-v1" })).status, 201);
    assert.equal((await w.http("PUT", `/jobsearch/candidates/${B.id}/settings`, T.admin, { mode: "prepare_for_approval", cap_per_day: 5, cap_per_week: 20 })).status, 200);
    return { ...B, cvFileId: upB.body.cvFileId, cvSha: sha(pdfB) };
  })();

  // ---- 7. match acceptance is REQUIRED (admin-only setting); the feed finds a fixture job; staff classify it
  assert.equal((await w.http("PUT", "/jobsearch/match-settings", T.mgr, { require_match_acceptance: true })).status, 403, "only an Admin flips it");
  assert.equal((await w.http("PUT", "/jobsearch/match-settings", T.admin, { require_match_acceptance: true })).body.require_match_acceptance, true);
  const maple = await E.employer(w, "Maple Grid Services", { domain: "maple.test.invalid" });
  const job1 = E.feedJob(w, maple, { id: "fx-maple-1", text: AD_PLAIN, url: "https://careers.maple.test.invalid/jobs/electrician-1" });
  fixture._set({ jobs: [job1] });
  const s1 = await E.tick(w, clock.now());
  assert.deepEqual(s1.errors, [], JSON.stringify(s1));
  const J1 = await w.one("SELECT j.* FROM js_jobs j JOIN js_job_sightings s ON s.job_id = j.id WHERE s.source_job_id = 'fx-maple-1'");
  assert.equal(J1.employer_id, maple.id);
  assert.equal(J1.status, "open");
  assert.notEqual(J1.classification, "foreign_applicants_stated", "an ad is not classified from wording the staff have not confirmed");
  // classification: a quote that is NOT in the ad is refused; the verbatim quote is accepted; both are audited
  const clsUrl = `/jobsearch/jobs/${J1.id}/classification`;
  const bad = await w.http("POST", clsUrl, T.agent, { classification: "foreign_applicants_stated", evidence: "We sponsor visas for everyone" });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal((await w.http("POST", clsUrl, T.agent, { classification: "foreign_applicants_stated" })).status, 400, "no quote, no classification");
  assert.equal((await w.one("SELECT classification FROM js_jobs WHERE id = $1", [J1.id])).classification, J1.classification, "refused requests change nothing");
  const okc = await w.http("POST", clsUrl, T.mgr, { classification: "foreign_applicants_stated", evidence: "international applicants are welcome" });
  assert.equal(okc.status, 200, JSON.stringify(okc.body));
  assert.equal(okc.body.job.classification, "foreign_applicants_stated");
  assert.equal(okc.body.job.classificationEvidence, "international applicants are welcome");
  assert.equal(await w.count("SELECT count(*) AS n FROM js_audit_events WHERE action = 'job.classification' AND (detail->>'jobId')::int = $1", [J1.id]), 1);
  // match with a band; the candidate sees the band label but not the staff decision
  const mA = await w.one("SELECT * FROM js_matches WHERE candidate_id = $1 AND job_id = $2", [A.id, J1.id]);
  assert.ok(mA && mA.score > 0, "a match was stored for the fixture job");
  assert.ok(mA.band, "the match carries a band");
  assert.equal(mA.decision, "pending");
  const candMatches = await w.http("GET", `/jobsearch/candidates/${A.id}/matches`, A.token);
  const cm = candMatches.body.matches.find((m) => m.jobId === J1.id);
  assert.equal(cm.band, mA.band);
  assert.ok(cm.bandLabel);
  assert.equal(cm.decision, undefined, "the staff decision is not shown to the candidate");
  assert.equal(cm.job.classification, "foreign_applicants_stated");
  // with require_match_acceptance on, preparation is refused until a Manager accepts; an Agent cannot accept
  assert.equal(await w.count("SELECT count(*) AS n FROM js_applications WHERE candidate_id = $1 AND job_id = $2", [A.id, J1.id]), 0, "no application is created or prepared automatically while acceptance is required");
  const mkApp = async (tok, matchId) => {
    const r = await w.http("POST", "/jobsearch/applications", tok, { matchId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.application;
  };
  const appA1 = await mkApp(T.mgr, mA.id);
  assert.equal(appA1.status, "matched");
  const refusedPrep = await w.http("POST", `/jobsearch/applications/${appA1.id}/prepare`, T.mgr, {});
  assert.equal(refusedPrep.status, 409);
  assert.equal(refusedPrep.body.code, "match_not_accepted");
  await w.q("UPDATE candidates SET assigned_to = $2 WHERE id = $1", [A.id, U.agent]);
  assert.equal((await w.http("POST", `/jobsearch/matches/${mA.id}/accept`, T.agent, {})).status, 403, "an Agent cannot accept a match");
  await w.q("UPDATE candidates SET assigned_to = $2 WHERE id = $1", [A.id, U.mgr]);
  const acc = await w.http("POST", `/jobsearch/matches/${mA.id}/accept`, T.mgr, { note: "Good fit; Toronto" });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal(acc.body.decision, "accepted");

  // ---- 8. application prepared with the AUTHORISED Canadian CV (exact version in the package)
  const prep = await w.http("POST", `/jobsearch/applications/${appA1.id}/prepare`, T.mgr, {});
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  const cvDoc = prep.body.package.included.filter((d) => d.kind === "cv");
  assert.equal(cvDoc.length, 1, "one CV in the package");
  const canadianPdf = await w.one("SELECT * FROM js_cv_files WHERE candidate_id = $1 AND kind = 'canadian' AND format = 'pdf' AND version = 1", [A.id]);
  assert.equal(cvDoc[0].cvFileId, canadianPdf.id, "the Canadian CV, not the uploaded original");
  assert.notEqual(canadianPdf.id, cvFileId);
  const pkgRow = await w.one("SELECT d.* FROM js_application_documents d WHERE d.application_id = $1 AND d.removed_at IS NULL", [appA1.id]);
  assert.deepEqual([pkgRow.cv_file_id, pkgRow.version, pkgRow.sha256, pkgRow.source_ref], [canadianPdf.id, 1, sha(dlPdf.buf), `canadian_cv:${refA}-CV-V1.pdf`]);
  assert.equal(prep.body.application.status, "ready_for_review");
  assert.equal((await E.appMails(w)).length, 0, "ZERO mails before a human approves");

  // ---- 9. candidate B: same flow at the same employer (accepted by B's own Manager), sent first
  const mB = await w.one("SELECT * FROM js_matches WHERE candidate_id = $1 AND job_id = $2", [B.id, J1.id]);
  assert.ok(mB, "B matches the same vacancy");
  assert.equal((await w.http("POST", `/jobsearch/matches/${mB.id}/accept`, T.mgr, {})).status, 404, "Manager mgr cannot decide B's match");
  assert.equal((await w.http("POST", `/jobsearch/matches/${mB.id}/accept`, T.mgr2, {})).status, 200);
  const appB1 = await mkApp(T.mgr2, mB.id);
  const prepB = await w.http("POST", `/jobsearch/applications/${appB1.id}/prepare`, T.mgr2, {});
  assert.equal(prepB.status, 200, JSON.stringify(prepB.body));
  assert.equal(prepB.body.package.included.find((d) => d.kind === "cv").cvFileId, Bc.cvFileId, "B has no Canadian CV: the uploaded approved original");

  // ---- 10. approval + queued send via the sandbox mailbox, with evidence
  for (const [app, tok, who] of [[appB1, T.mgr2, "B"], [appA1, T.mgr, "A"]]) {
    assert.equal((await w.http("POST", `/jobsearch/applications/${app.id}/approve`, tok, { reason: `Reviewed package ${who}` })).status, 200, who);
    const qd = await w.http("POST", `/jobsearch/applications/${app.id}/queue`, tok);
    assert.equal(qd.status, 200, JSON.stringify(qd.body));
    assert.equal(qd.body.recipient, "jobs@maple.test.invalid");
  }
  const drained = await w.http("POST", "/jobsearch/queue/run", T.admin, { kinds: ["submit"] });
  assert.equal(drained.status, 200, JSON.stringify(drained.body));
  assert.equal(drained.body.processed, 2);
  const mails = await E.appMails(w);
  assert.equal(mails.length, 2, "exactly one mail per application");
  const subA = await w.one("SELECT * FROM js_submissions WHERE application_id = $1", [appA1.id]);
  const subB = await w.one("SELECT * FROM js_submissions WHERE application_id = $1", [appB1.id]);
  assert.equal(subA.status, "sent");
  assert.equal(subA.confirmed_at, null);
  const mailA = mails.find((m) => m.message_id === subA.provider_message_id);
  assert.ok(mailA, "the sandbox mail matches the stored provider id");
  assert.deepEqual(mailA.attachments.map((a) => a.sha256), [sha(dlPdf.buf)], "the exact authorised Canadian CV (V1 PDF) is the only attachment");
  // Known limit (CHECKLIST): the e-mail channel names the attachment CV-<Name>-v<version>.pdf, not the canonical <reference>-CV-V<n>.pdf
  // that staff and the candidate see; the bytes (hash above) and the version are the authorised ones.
  assert.match(mailA.attachments[0].filename, /^CV-[A-Za-z-]+-v1\.pdf$/);
  assert.deepEqual(subA.evidence.docs.map((d) => [d.kind, d.cvFileId, d.version, d.sha256]), [["cv", canadianPdf.id, 1, sha(dlPdf.buf)]]);
  assert.equal(subB.status, "sent");
  assert.deepEqual(mails.find((m) => m.message_id === subB.provider_message_id).attachments.map((a) => a.sha256), [Bc.cvSha]);

  // ---- 11. a second vacancy at the same employer: A and B both get approved applications; B's is queued, A's waits
  const job2 = E.feedJob(w, maple, { id: "fx-maple-2", title: "Industrial Electrician", location: "Ottawa, ON", text: AD_PLAIN.replace("wiring", "panel wiring"), url: "https://careers.maple.test.invalid/jobs/electrician-2" });
  fixture._set({ jobs: [job1, job2] });
  const s2 = await E.tick(w, clock.advance(7 * E.HOUR));
  assert.deepEqual(s2.errors, [], JSON.stringify(s2));
  const J2 = await w.one("SELECT j.* FROM js_jobs j JOIN js_job_sightings s ON s.job_id = j.id WHERE s.source_job_id = 'fx-maple-2'");
  const later = {};
  for (const [key, cand, tok] of [["A", A, T.mgr], ["B", B, T.mgr2]]) {
    const m = await w.one("SELECT * FROM js_matches WHERE candidate_id = $1 AND job_id = $2", [cand.id, J2.id]);
    assert.ok(m, `${key} matches the second vacancy`);
    assert.equal((await w.http("POST", `/jobsearch/matches/${m.id}/accept`, tok, {})).status, 200);
    const app = await mkApp(tok, m.id);
    const p = await w.http("POST", `/jobsearch/applications/${app.id}/prepare`, tok, {});
    assert.equal(p.status, 200, `${key}: ${JSON.stringify(p.body)}`);
    assert.equal((await w.http("POST", `/jobsearch/applications/${app.id}/approve`, tok, { reason: "Reviewed" })).status, 200);
    later[key] = app.id;
  }
  assert.equal((await w.http("POST", `/jobsearch/applications/${later.B}/queue`, T.mgr2)).status, 200, "B's second application sits in the queue");
  assert.equal((await E.appMails(w)).length, 2, "nothing sent yet for the second vacancy");

  // ---- 12. the employer replies with an opt-out (signed webhook, DKIM pass, In-Reply-To = stored Message-ID)
  const optOut = await E.pushInbound(w, {
    inReplyTo: subA.provider_message_id,
    references: [subA.evidence.messageIdPlanned],
    from: "Maple HR <hr@maple.test.invalid>",
    subject: "Re: Application: Electrician",
    text: "Thank you for applying. Please remove us from your mailing list and do not contact us again.",
    authResults: E.authPass("maple.test.invalid"),
  });
  assert.equal(optOut.status, 200, JSON.stringify(optOut.body));
  assert.equal(optOut.body.stored, true);
  const sup = (await w.q("SELECT * FROM js_suppressions WHERE kind = 'email'")).rows;
  assert.deepEqual(sup.map((s) => [s.value, s.source, s.employer_id]), [["hr@maple.test.invalid", "reply_opt_out", maple.id]]);
  assert.equal((await w.one("SELECT status FROM js_employers WHERE id = $1", [maple.id])).status, "opted_out");
  const optTasks = (await w.q("SELECT * FROM js_tasks WHERE application_id = $1 AND reason = 'opt_out_received'", [appA1.id])).rows;
  assert.equal(optTasks.length, 1);
  assert.equal(optTasks[0].status, "open");
  assert.equal(optTasks[0].assigned_to, U.mgr, "the task is opened for the responsible staff member");
  assert.equal((await w.one("SELECT status FROM js_submissions WHERE id = $1", [subA.id])).status, "sent", "an opt-out is never an acknowledgement");
  const supApi = await w.http("GET", "/jobsearch/suppressions", T.mgr);
  assert.equal(supApi.status, 200, JSON.stringify(supApi.body));
  assert.ok(JSON.stringify(supApi.body).includes("hr@maple.test.invalid"));
  const empApi = await w.http("GET", `/jobsearch/employers/${maple.id}`, T.mgr);
  assert.equal(empApi.status, 200, JSON.stringify(empApi.body));
  assert.equal(empApi.body.status || (empApi.body.employer && empApi.body.employer.status), "opted_out");

  // ---- 13. the guard refuses a later send: queueing (approved A application) and the retry path (B's already queued item)
  const refusedQueue = await w.http("POST", `/jobsearch/applications/${later.A}/queue`, T.mgr);
  assert.equal(refusedQueue.status, 409, JSON.stringify(refusedQueue.body));
  assert.ok(["recipient_suppressed", "employer_opted_out"].includes(refusedQueue.body.code), refusedQueue.body.code);
  const drain2 = await w.http("POST", "/jobsearch/queue/run", T.admin, { kinds: ["submit"] });
  assert.equal(drain2.status, 200);
  const retried = await w.one("SELECT * FROM js_submissions WHERE application_id = $1", [later.B]);
  assert.equal(retried.status, "failed", "the already-queued item was stopped at send time");
  assert.equal(await w.count("SELECT count(*) AS n FROM js_timeline WHERE application_id = $1 AND event = 'submission_blocked'", [later.B]), 1);
  assert.equal((await E.appMails(w)).length, 2, "no further mail left the system");
  assert.equal((await E.appMails(w, "jobs@maple.test.invalid")).length, 2);
  const re = await w.http("POST", `/jobsearch/applications/${later.B}/queue`, T.mgr2);
  assert.equal(re.status, 409, "a re-queue after the block is refused too");
  await E.tick(w, clock.advance(E.HOUR));
  assert.equal((await E.appMails(w)).length, 2, "a later tick sends nothing to the suppressed employer");

  // ---- 14. history scoping: an Agent sees only the rows of their own candidates; other candidates' contacts are bare numbers
  await w.q("UPDATE candidates SET assigned_to = $2 WHERE id = $1", [A.id, U.agent]);
  try {
    const histAgent = await w.http("GET", `/jobsearch/employers/${maple.id}/history`, T.agent);
    assert.equal(histAgent.status, 200, JSON.stringify(histAgent.body));
    const seen = histAgent.body.applications.map((x) => x.candidateId);
    assert.ok(seen.length > 0 && seen.every((id) => id === A.id), "the agent's rows are A's only");
    assert.equal(histAgent.body.contactedByOtherCandidates, 1, "B's contact is a number, not a row");
    assert.ok(!JSON.stringify(histAgent.body).includes(`"candidateId":${B.id}`) && !JSON.stringify(histAgent.body).includes("Candidate B"));
    assert.ok(histAgent.body.applications.some((x) => x.submissions.some((s) => s.status === "sent")), "A's sent application is listed");
  } finally {
    await w.q("UPDATE candidates SET assigned_to = $2 WHERE id = $1", [A.id, U.mgr]);
  }
  const histAdmin = await w.http("GET", `/jobsearch/employers/${maple.id}/history`, T.admin);
  assert.equal(histAdmin.body.contactedByOtherCandidates, 0, "an Admin sees every row, nothing hidden to count");
  assert.ok(histAdmin.body.applications.some((x) => x.candidateId === A.id) && histAdmin.body.applications.some((x) => x.candidateId === B.id));
  assert.equal((await w.http("GET", `/jobsearch/employers/${maple.id}/history`, T.agent)).status, 404, "an agent with no candidate at this employer: out of scope");
  assert.equal((await w.http("GET", `/jobsearch/candidates/${A.id}/canadian-cv`, T.agent)).status, 404, "staff outside the assignment never see the candidate's CVs");
  assert.equal((await w.http("GET", `/jobsearch/candidates/${A.id}/canadian-cv`, T.mgr2)).status, 404);

  // ---- 15. reports: company PDF/XLSX and the candidate Activity Report (staff + candidate); numbers = raw SQL
  const from = day(Date.now() - 2 * 86400000);
  const to = day(Date.now() + 2 * 86400000);
  const win = `>= ($1::date::timestamp AT TIME ZONE 'Africa/Tunis') AND {col} < (($2::date + 1)::timestamp AT TIME ZONE 'Africa/Tunis')`;
  const rawCount = async (sql, col) => w.count(sql.replace("{win}", win.replace(/\{col\}/g, col).replace(">=", `${col} >=`)), [from, to]);
  const sqlSubmitted = await rawCount("SELECT count(*) AS n FROM js_submissions s JOIN js_applications a ON a.id = s.application_id JOIN candidates c ON c.id = a.candidate_id WHERE c.is_deleted = false AND s.sent_at IS NOT NULL AND s.status IN ('sent','confirmed_submitted') AND {win}", "s.sent_at");
  const sqlMatched = await rawCount("SELECT count(*) AS n FROM js_matches m JOIN js_jobs j ON j.id = m.job_id JOIN candidates c ON c.id = m.candidate_id WHERE c.is_deleted = false AND {win}", "m.created_at");
  const sqlReplies = await rawCount("SELECT count(*) AS n FROM js_messages mg JOIN js_applications a ON a.id = mg.application_id JOIN candidates c ON c.id = a.candidate_id WHERE c.is_deleted = false AND mg.direction = 'in' AND mg.review_state IN ('matched','resolved') AND {win}", "COALESCE(mg.received_at, mg.created_at)");
  assert.equal(sqlSubmitted, 2);
  const cx = await raw(w, `/jobsearch/reports/export?format=xlsx&from=${from}&to=${to}`, T.admin);
  assert.equal(cx.status, 200);
  assert.equal(cx.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const wbC = readXlsx(cx.buf);
  const rep = wbC.Report;
  const total = rep[rep.length - 1];
  assert.equal(total[0], "Total");
  const hdr = rep[0];
  const colOf = (re) => hdr.findIndex((h) => typeof h === "string" && re.test(h));
  const cSubmitted = colOf(/submitted|sent/i);
  const cMatched = colOf(/match/i);
  const cReplies = colOf(/repl/i);
  assert.ok(cSubmitted > 1 && cMatched > 1 && cReplies > 1, JSON.stringify(hdr));
  assert.equal(total[cSubmitted], sqlSubmitted, "company XLSX 'sent' total = raw SQL");
  assert.equal(total[cMatched], sqlMatched, "company XLSX 'matched' total = raw SQL");
  assert.equal(total[cReplies], sqlReplies, "company XLSX 'replies' total = raw SQL");
  const cp = await raw(w, `/jobsearch/reports/export?format=pdf&from=${from}&to=${to}`, T.admin);
  assert.equal(cp.status, 200);
  assert.equal(cp.buf.subarray(0, 5).toString(), "%PDF-");
  assert.match(await pdfText(cp.buf), /Africa\/Tunis/);
  // candidate Activity Report: staff in scope, and the candidate (own only)
  const actX = await raw(w, `/jobsearch/candidates/${A.id}/activity-report?format=xlsx&from=${from}&to=${to}`, T.mgr);
  const actP = await raw(w, `/jobsearch/candidates/${A.id}/activity-report?format=pdf&from=${from}&to=${to}`, T.mgr);
  const meX = await raw(w, `/jobsearch/me/activity-report?format=xlsx&from=${from}&to=${to}`, A.token);
  const meP = await raw(w, `/jobsearch/me/activity-report?format=pdf&from=${from}&to=${to}`, A.token);
  for (const r of [actX, actP, meX, meP]) assert.equal(r.status, 200);
  assert.match(meP.headers.get("content-disposition"), new RegExp(`filename="${refA}-activity-${from}_${to}\\.pdf"`));
  const jobTitleA1 = "Electrician";
  for (const buf of [actX.buf, meX.buf]) {
    const wb = readXlsx(buf);
    const sentRows = wb["Applications sent"].slice(1).filter((r) => r.length);
    assert.equal(sentRows.length, 1, "only the SENT application is listed (A has one; the approved second one is not)");
    assert.equal(sentRows[0][1], jobTitleA1);
    const sumRow = wb.Summary.find((r) => /Applications sent \(verified\)/.test(String(r[0])));
    assert.equal(sumRow[1], await w.count("SELECT count(*) AS n FROM js_submissions s JOIN js_applications a ON a.id = s.application_id WHERE a.candidate_id = $1 AND s.status IN ('sent','confirmed_submitted')", [A.id]));
  }
  const pdfAct = await pdfText(meP.buf);
  assert.ok(pdfAct.includes(refA) && pdfAct.includes("Candidate A"));
  assert.ok(!pdfAct.includes("Candidate B") && !pdfAct.includes("jobs@maple.test.invalid") && !pdfAct.includes(refA.replace(/\d{4}$/, "9999")), "no other candidate, no recipient address");
  // own only: the other candidate's id is 404 for a candidate; staff outside scope too
  assert.equal((await raw(w, `/jobsearch/candidates/${B.id}/activity-report?format=pdf`, A.token)).status, 404);
  assert.equal((await raw(w, `/jobsearch/candidates/${A.id}/activity-report?format=pdf`, B.token)).status, 404);
  assert.equal((await raw(w, `/jobsearch/candidates/${A.id}/activity-report?format=pdf`, T.mgr2)).status, 404);
  assert.equal((await raw(w, `/jobsearch/candidates/${A.id}/activity-report?format=pdf`, T.acct)).status, 403);
  assert.equal((await raw(w, `/jobsearch/reports/export?format=pdf&from=${from}&to=${to}`, A.token)).status, 403, "a candidate cannot pull the company report");
  assert.ok(await w.count("SELECT count(*) AS n FROM js_report_snapshots WHERE generated_by IS NOT NULL") >= 6, "every generation left an immutable snapshot");

  // ---- 16. accounting gate for the candidate_fee service
  const prov = await w.http("PATCH", `/jobsearch/candidates/${A.id}/extras`, T.admin, { desired_province: "ON" });
  assert.equal(prov.status, 200, JSON.stringify(prov.body));
  const svcRes = await w.http("POST", "/finance/services", T.admin, { code: "CAN-FEE", name_en: "Canada service package", default_price: "250.00", currency: "TND", kind: "candidate_fee" });
  assert.equal(svcRes.status, 201, JSON.stringify(svcRes.body));
  const svc = svcRes.body;
  const inv = (cid = A.id, extra = {}) => w.http("POST", "/finance/invoices/v2", T.acct, { candidate_id: cid, currency: "TND", items: [{ service_id: svc.id, quantity: 1 }], ...extra });
  const none = await inv();
  assert.equal(none.status, 409, JSON.stringify(none.body));
  assert.ok(["legal_review_required", "service_contract_required"].includes(none.body.code), none.body.code);
  // a signed, active contract alone is not enough
  const ctr = await w.http("POST", "/finance/contracts", T.acct, { candidate_id: A.id, service_id: svc.id, refund_terms: "Refund terms for candidate A" });
  assert.equal(ctr.status, 201, JSON.stringify(ctr.body));
  assert.equal(ctr.body.status, "draft");
  const signed = await w.http("POST", `/finance/contracts/${ctr.body.id}/sign`, T.acct, { signed_by_name: "Candidate A" });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.status, "active");
  const noReview = await inv();
  assert.equal(noReview.status, 409);
  assert.equal(noReview.body.code, "legal_review_required", "the contract is active but no approved legal review is recorded");
  assert.equal(await w.count("SELECT count(*) AS n FROM invoices WHERE candidate_id = $1", [A.id]), 0, "nothing was created");
  // only an Administrator records the review; the platform records it, it does not judge it
  const review = (status, reviewedAt, extra = {}) => w.http("POST", "/finance/legal-reviews", T.admin, { jurisdiction: "CA-ON", status, reviewer_name: "Counsel of record", reviewer_role: "Lawyer", reviewed_at: reviewedAt, ...extra });
  for (const k of ["acct", "mgr", "agent"]) assert.equal((await w.http("POST", "/finance/legal-reviews", T[k], { jurisdiction: "CA-ON", status: "approved", reviewer_name: "X", reviewed_at: "2020-01-01" })).status, 403, k);
  assert.equal((await review("pending", "2020-01-01")).status, 201);
  assert.equal((await inv()).body.code, "legal_review_required", "a pending review does not unlock billing");
  assert.equal((await review("approved", "2020-01-02")).status, 201);
  // the legacy invoice route does not bypass an active fee contract
  const legacy = await w.http("POST", "/finance/invoices", T.acct, { candidate_id: A.id, total_amount: "100", currency: "TND" });
  assert.equal(legacy.status, 409);
  assert.equal(legacy.body.code, "candidate_fee_use_catalogue");
  const bill = await w.http("GET", `/finance/billing-status?candidate_id=${A.id}`, T.acct);
  assert.deepEqual([bill.body.candidate_fee_billable, bill.body.jurisdiction, bill.body.reasons], [true, "CA-ON", []]);
  const okInv = await inv();
  assert.equal(okInv.status, 201, JSON.stringify(okInv.body));
  const pay = (amount) => w.http("POST", "/finance/payments/v2", T.acct, { invoice_id: okInv.body.id, amount, method: "cash" });
  const firstPay = await pay("50.00");
  assert.equal(firstPay.status, 201, JSON.stringify(firstPay.body));
  // a prohibited review blocks again - new invoices, the legacy route and NEW payments (refunds / voids stay possible)
  assert.equal((await review("prohibited", "2020-01-03")).status, 201);
  const prohibited = await inv();
  assert.equal(prohibited.status, 409);
  assert.equal(prohibited.body.code, "candidate_fee_prohibited");
  const legacy2 = await w.http("POST", "/finance/invoices", T.acct, { candidate_id: A.id, total_amount: "100", currency: "TND" });
  assert.equal(legacy2.status, 409, "the legacy route stays closed (active fee contract and prohibited jurisdiction)");
  assert.equal(legacy2.body.code, "candidate_fee_use_catalogue");
  const blockedPay = await pay("10.00");
  assert.equal(blockedPay.status, 409);
  assert.equal(blockedPay.body.code, "candidate_fee_prohibited");
  assert.equal(await w.count("SELECT count(*) AS n FROM payments WHERE invoice_id = $1", [okInv.body.id]), 1, "no second payment row");
  const refund = await w.http("POST", `/finance/payments/${firstPay.body.payment.id}/refund`, T.acct, { amount: "50.00", reason: "refund after prohibition" });
  assert.equal(refund.status, 201, "refunds stay possible: " + JSON.stringify(refund.body));
  // the candidate sees own contracts only (no staff data); another candidate's contract stays invisible
  const ctrB = await w.http("POST", "/finance/contracts", T.acct, { candidate_id: B.id, service_id: svc.id, refund_terms: "SECRET-TERMS-OF-B" });
  assert.equal((await w.http("POST", `/finance/contracts/${ctrB.body.id}/sign`, T.acct, { signed_by_name: "Candidate B" })).status, 200);
  const mine = await w.http("GET", "/finance/me/contracts", A.token);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(mine.body.contracts.map((c) => String(c.id)), [String(ctr.body.id)]);
  assert.ok(!JSON.stringify(mine.body).includes("SECRET-TERMS-OF-B"));
  assert.equal((await w.http("GET", "/finance/contracts", A.token)).status, 403);
  assert.equal((await w.http("GET", "/finance/me/contracts", T.acct)).status, 403, "staff have no /me");

  // ---- 17. Employer / Agency / Candidate tokens are denied on the new staff routes (spot check per class)
  const staffRoutes = [
    ["POST", `/jobsearch/candidates/${A.id}/canadian-cv`, {}],
    ["GET", `/jobsearch/candidates/${A.id}/canadian-cv`],
    ["POST", `/jobsearch/candidates/${A.id}/canadian-cv/1/approve`],
    ["GET", `/jobsearch/reports/export?format=pdf`],
    ["GET", "/jobsearch/reports/snapshots"],
    ["PUT", "/jobsearch/reports/settings", { report_timezone: "UTC" }],
    ["GET", "/jobsearch/suppressions"],
    ["POST", "/jobsearch/suppressions", { kind: "email", value: "x@test.invalid" }],
    ["GET", `/jobsearch/employers/${maple.id}`],
    ["GET", `/jobsearch/employers/${maple.id}/history`],
    ["POST", `/jobsearch/jobs/${J1.id}/classification`, { classification: "eligibility_unclear" }],
    ["POST", `/jobsearch/matches/${mA.id}/accept`, {}],
    ["PUT", "/jobsearch/match-settings", { require_match_acceptance: false }],
    ["POST", "/finance/legal-reviews", { jurisdiction: "CA-ON", status: "approved", reviewer_name: "X", reviewed_at: "2020-01-01" }],
    ["GET", "/finance/legal-reviews"],
    ["POST", "/finance/contracts", { candidate_id: A.id, service_id: svc.id }],
    ["GET", `/finance/billing-status?candidate_id=${A.id}`],
  ];
  for (const [label, tok] of [["employer", emp.token], ["agency", agy.token], ["candidate", B.token]]) {
    for (const [m, u, b] of staffRoutes) {
      const r = await w.http(m, u, tok, b);
      assert.ok([401, 403, 404].includes(r.status), `${label} ${m} ${u} -> ${r.status}`);
    }
  }
  for (const [m, u, b] of staffRoutes) assert.equal((await w.http(m, u, null, b)).status, 401, `anonymous ${m} ${u}`);
  // nothing the denied calls attempted took effect
  assert.equal((await w.http("GET", "/jobsearch/match-settings", T.admin)).body.require_match_acceptance, true);
  assert.equal(await w.count("SELECT count(*) AS n FROM js_suppressions"), 1);
  assert.equal(await w.count("SELECT count(*) AS n FROM fin_legal_reviews"), 3);
});

// =====================================================================================================
// C2 (last: spawnSync blocks this process's event loop)
// =====================================================================================================
test("C2: the all-routes authorization sweep still passes with the stage 8 routes (child process)", () => {
  const r = spawnSync(process.execPath, ["--test", path.join(__dirname, "orgs-route-sweep.test.js")], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", NODE_TEST_CONTEXT: undefined }, timeout: 240000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-3000));
  assert.match(r.stdout, /# pass [1-9]/, "the sweep actually ran");
  assert.match(r.stdout, /# fail 0/);
});
