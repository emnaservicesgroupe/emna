// Stage 8 task 5: six-way vacancy classification with quoted evidence, match bands and match accept/reject.
// Pure derivation tables + real Postgres + HTTP. Nothing here treats an advertisement as proof of LMIA, sponsorship or eligibility.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-classification-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "js-class-"));
delete process.env.CLAMAV_HOST;
process.env.ALLOW_UNSCANNED_ATTACHMENTS = "true";
delete process.env.MATCH_MIN_SCORE;

const classification = require("../modules/jobsearch/classification");
const { deriveClassification, detectWorkAuthRequired, evidenceOccursIn, CLASSES } = classification;
const { scoreMatch, computeBand, BAND_LABELS } = require("../modules/jobsearch/matching");
const jobStore = require("../modules/jobsearch/jobStore");
const matchService = require("../modules/jobsearch/matchService");
const applicationService = require("../modules/jobsearch/applicationService");
const { parseFeed } = require("../modules/jobsearch/sources/feedCommon");

const NOW = new Date("2026-10-31T12:00:00Z");
const LONG = "We are hiring an Electrician for our commercial sites in Calgary. You will install and maintain wiring, conduit and panels. Full time, day shift.";
const open = (extra = {}) => ({ status: "open", closing_at: null, closing_date: null, description_text: LONG, ...extra });
const sig = (extra = {}) => ({ now: NOW, verifiedSource: true, employerSupport: { label: "unknown", evidence: null }, ...extra });
const derive = (job, signals) => deriveClassification(job, { ...sig(), ...signals });

// ---------------------------------------------------------------- pure: derivation table
test("derivation: closed / expired / closing passed => closed_unsuitable, and it outranks every other signal", () => {
  for (const job of [open({ status: "expired" }), open({ status: "closed" }), open({ closing_at: "2026-10-30T00:00:00Z" }), open({ closing_date: "2026-10-30" }), open({ closing_date: new Date("2026-10-30T00:00:00Z") })]) {
    const r = derive(job, { employerSupport: { label: "stated_in_ad", evidence: "Visa sponsorship available" } });
    assert.equal(r.classification, "closed_unsuitable", JSON.stringify(job));
  }
  // closing today is still open; a closing date in the future is open
  assert.equal(derive(open({ closing_date: "2026-10-31" })).classification, "verified_active");
  assert.equal(derive(open({ closing_at: "2026-11-30T00:00:00Z", closing_date: "2026-11-30" })).classification, "verified_active");
});

test("derivation: label 'unavailable' or required-authorization wording => work_authorization_required with the quoted phrase", () => {
  let r = derive(open(), { employerSupport: { label: "unavailable", evidence: "No visa sponsorship is available" } });
  assert.equal(r.classification, "work_authorization_required");
  assert.equal(r.evidence, "No visa sponsorship is available");
  const phrases = [
    "Candidates must be legally entitled to work in Canada.",
    "A valid work permit required.",
    "Valid work permit is required for this position.",
    "Only candidates already authorized to work in Canada will be considered.",
    "Autorisation de travail valide requise.",
    "Citoyens canadiens ou résidents permanents seulement.",
    "Canadian citizens and permanent residents only.",
    "Les candidats doivent être légalement autorisés à travailler au Canada.",
  ];
  for (const p of phrases) {
    r = derive(open({ description_text: `${LONG}\n${p}` }));
    assert.equal(r.classification, "work_authorization_required", p);
    assert.ok(r.evidence && r.evidence.length <= 500 && p.toLowerCase().includes(r.evidence.toLowerCase().replace(/[.…]+$/, "").slice(0, 25)), `${p} -> ${r.evidence}`);
  }
  // required authorization beats a stated-foreign label (the stricter reading)
  r = derive(open({ description_text: `${LONG}\nMust be legally entitled to work in Canada.` }), { employerSupport: { label: "stated_in_ad", evidence: "Visa sponsorship available" } });
  assert.equal(r.classification, "work_authorization_required");
});

test("derivation: wording that is NOT a requirement is not matched (negation, assistance, hedges)", () => {
  for (const p of [
    "No work permit required.",
    "We do not require a valid work permit.",
    "We will help you obtain a work permit.",
    "A valid work permit is an asset.",
    "We sponsor work permits for the right candidates.",
    "Work permit assistance is provided.",
    "Les citoyens canadiens ne sont pas seuls à postuler.",
  ]) {
    const r = derive(open({ description_text: `${LONG}\n${p}` }));
    assert.notEqual(r.classification, "work_authorization_required", p);
  }
  assert.equal(detectWorkAuthRequired(""), null);
  assert.equal(detectWorkAuthRequired(null), null);
});

test("detectWorkAuthRequired is bounded: hostile inputs finish quickly", () => {
  const started = Date.now();
  const inputs = [
    `must ${"be ".repeat(20000)} authorized`,
    `${"only candidates ".repeat(5000)}`,
    `${"valid ".repeat(30000)}work permit`,
    `${"a".repeat(200000)} must be legally entitled to work`,
    `${"must have ".repeat(8000)}`,
    `${"citizens and ".repeat(8000)}`,
  ];
  for (const t of inputs) detectWorkAuthRequired(t);
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
});

test("derivation: foreign_applicants_stated needs a quoted evidence string that is verifiable; never inferred without one", () => {
  const text = `${LONG}\nWe welcome international applicants and offer visa sponsorship.`;
  let r = derive(open({ description_text: text }), { employerSupport: { label: "stated_in_ad", evidence: "We welcome international applicants and offer visa sponsorship" } });
  assert.equal(r.classification, "foreign_applicants_stated");
  assert.equal(r.evidence, "We welcome international applicants and offer visa sponsorship");
  assert.ok(evidenceOccursIn(r.evidence, text));
  // no / blank / whitespace evidence: never foreign_applicants_stated
  for (const evidence of [null, undefined, "", "   ", "\n\t"]) {
    r = derive(open({ description_text: text }), { employerSupport: { label: "stated_in_ad", evidence } });
    assert.notEqual(r.classification, "foreign_applicants_stated", JSON.stringify(evidence));
  }
  // evidence that is not in the ad is not accepted either (a label cannot invent a quote)
  r = derive(open({ description_text: LONG }), { employerSupport: { label: "stated_in_ad", evidence: "We sponsor everybody" } });
  assert.notEqual(r.classification, "foreign_applicants_stated");
  // staff confirmation: needs its evidence too, and a conflict with the ad is only "unclear"
  r = derive(open(), { employerSupport: { label: "confirmed", evidence: "Employer confirmed by phone on 2026-10-01" } });
  assert.equal(r.classification, "foreign_applicants_stated");
  r = derive(open(), { employerSupport: { label: "confirmed", evidence: "" } });
  assert.notEqual(r.classification, "foreign_applicants_stated");
  r = derive(open(), { employerSupport: { label: "confirmed", evidence: "Employer confirmed", conflict: true } });
  assert.equal(r.classification, "eligibility_unclear");
  // a stored evidence is capped at 500 characters
  r = derive(open(), { employerSupport: { label: "confirmed", evidence: "x".repeat(900) } });
  assert.ok(r.evidence.length <= 500);
});

test("derivation: verified_active only for an open, real vacancy from a verified source; the rest is eligibility_unclear", () => {
  assert.equal(derive(open()).classification, "verified_active");
  assert.equal(derive(open(), { verifiedSource: false }).classification, "eligibility_unclear");
  assert.equal(derive(open({ description_text: "" })).classification, "eligibility_unclear");
  assert.equal(derive(open({ description_text: "Electrician needed." })).classification, "eligibility_unclear");
  assert.equal(derive(open({ description_text: null })).classification, "eligibility_unclear");
  for (const p of ["We are building a talent pool for future opportunities.", "No current openings, send your CV for future positions.", "Constantly hiring: join our pipeline of candidates.", "Aucun poste vacant actuellement, banque de candidats."]) {
    assert.equal(derive(open({ description_text: `${LONG}\n${p}` })).classification, "eligibility_unclear", p);
  }
  assert.equal(derive(open(), { verifiedSource: undefined }).classification, "eligibility_unclear");
  assert.equal(derive({}, {}).classification, "eligibility_unclear");
  assert.equal(derive(null, {}).classification, "eligibility_unclear");
});

test("derivation: prospective_no_vacancy is staff-only; every class is a known class", () => {
  const seen = new Set();
  for (const status of ["open", "expired", "closed"]) {
    for (const label of ["unknown", "stated_in_ad", "unavailable", "confirmed"]) {
      for (const verified of [true, false]) {
        for (const description_text of ["", LONG, `${LONG} future opportunities talent pool`, `${LONG} must be legally entitled to work in Canada`]) {
          const r = derive(open({ status, description_text }), { verifiedSource: verified, employerSupport: { label, evidence: "quote" } });
          seen.add(r.classification);
          assert.ok(CLASSES.includes(r.classification));
          assert.notEqual(r.classification, "prospective_no_vacancy");
        }
      }
    }
  }
  assert.ok(seen.has("closed_unsuitable") && seen.has("verified_active") && seen.has("eligibility_unclear") && seen.has("work_authorization_required"));
  assert.deepEqual([...CLASSES].sort(), ["closed_unsuitable", "eligibility_unclear", "foreign_applicants_stated", "prospective_no_vacancy", "verified_active", "work_authorization_required"]);
});

test("evidenceOccursIn: verbatim, case-insensitive, whitespace-normalised, never empty", () => {
  const ad = "Great team.\n  We   welcome INTERNATIONAL applicants  and offer visa sponsorship.\nApply now.";
  assert.equal(evidenceOccursIn("we welcome international applicants and offer visa sponsorship", ad), true);
  assert.equal(evidenceOccursIn("We welcome\ninternational   applicants", ad), true);
  assert.equal(evidenceOccursIn("We welcome all applicants", ad), false);
  assert.equal(evidenceOccursIn("", ad), false);
  assert.equal(evidenceOccursIn("   ", ad), false);
  assert.equal(evidenceOccursIn("visa", ad), false, "a fragment shorter than the minimum quote is not evidence");
  assert.equal(evidenceOccursIn("We welcome", null), false);
  assert.equal(evidenceOccursIn(42, ad), false);
});

// ---------------------------------------------------------------- pure: bands
test("bands: 85/70/50 boundaries (49/50/69/70/84/85)", () => {
  const cases = [[0, "not_recommended"], [49, "not_recommended"], [50, "manual_review"], [69, "manual_review"], [70, "good"], [84, "good"], [85, "strong"], [100, "strong"]];
  for (const [score, band] of cases) assert.equal(computeBand(score, []), band, String(score));
  assert.deepEqual(BAND_LABELS, { strong: "Strong", good: "Good", manual_review: "Manual review", not_recommended: "Not recommended" });
});

test("bands: a veto is a hard override and can only lower a band", () => {
  const NR = [{ code: "x", severity: "not_recommended" }];
  const MR = [{ code: "y", severity: "manual_review" }];
  for (const score of [100, 95, 85, 84, 70, 60, 50]) assert.equal(computeBand(score, NR), "not_recommended", `NR ${score}`);
  assert.equal(computeBand(100, MR), "manual_review");
  assert.equal(computeBand(85, MR), "manual_review");
  assert.equal(computeBand(72, MR), "manual_review");
  assert.equal(computeBand(55, MR), "manual_review");
  assert.equal(computeBand(49, MR), "not_recommended", "a manual-review veto never raises a low score");
  assert.equal(computeBand(30, [...MR, ...NR]), "not_recommended");
  for (let s = 0; s <= 100; s += 1) {
    for (const v of [[], MR, NR]) {
      const b = computeBand(s, v);
      if (v.length) assert.ok(b !== "strong" && b !== "good", `vetoed ${s} -> ${b}`);
    }
  }
  assert.equal(computeBand(Number.NaN, []), "not_recommended");
  assert.equal(computeBand(120, []), "strong");
});

const PROFILE = {
  profession: "Electrician",
  skills: ["wiring", "conduit", "panels"],
  experience: [{ title: "Electrician", employer: "X", start: "2010-01", end: null }],
  certificates: [],
  languages: [{ lang: "English", level: "fluent" }],
};
const PREFS = { countries: ["Canada"], categories: ["Electrician"], residence_country: "Canada", needs_work_auth_support: false };
const STRONG_JOB = { title: "Electrician", location: "Calgary, AB", country: "Canada", status: "open", description_text: "Electrician for wiring, conduit and panels. 5 years of experience. English required. Salary $85,000 per year." };

test("scoreMatch: band follows the score and vetoes override it", () => {
  const base = scoreMatch(PROFILE, PREFS, STRONG_JOB, { now: NOW });
  assert.ok(base.score >= 85, `baseline ${base.score}`);
  assert.equal(base.band, "strong");
  assert.deepEqual(base.vetoes, []);

  // outside the preferred destinations: essential veto, never strong/good
  const away = scoreMatch(PROFILE, { ...PREFS, countries: ["Qatar"] }, STRONG_JOB, { now: NOW });
  assert.equal(away.band, "not_recommended");
  assert.ok(away.vetoes.some((v) => v.code === "outside_destination" && v.severity === "not_recommended"));

  // candidate needs employer support, the ad says it is not available
  const noSupport = scoreMatch(PROFILE, { ...PREFS, residence_country: "Tunisia", needs_work_auth_support: true }, { ...STRONG_JOB, description_text: `${STRONG_JOB.description_text} No visa sponsorship is available.` }, { now: NOW });
  assert.equal(noSupport.band, "manual_review", "capped for a person to review (as before, such a match stays reviewable)");
  assert.ok(noSupport.vetoes.some((v) => v.code === "work_authorization_unavailable" && v.severity === "manual_review"));

  // a required language the candidate lacks: manual review at best
  const lang = scoreMatch({ ...PROFILE, languages: [{ lang: "Arabic", level: "native" }] }, PREFS, STRONG_JOB, { now: NOW });
  assert.ok(lang.vetoes.some((v) => v.code === "required_language_missing"));
  assert.ok(["manual_review", "not_recommended"].includes(lang.band), lang.band);

  // the job's own classification
  const closed = scoreMatch(PROFILE, PREFS, { ...STRONG_JOB, classification: "closed_unsuitable" }, { now: NOW });
  assert.equal(closed.band, "not_recommended");
  const expired = scoreMatch(PROFILE, PREFS, { ...STRONG_JOB, status: "expired" }, { now: NOW });
  assert.equal(expired.band, "not_recommended");
  // no key of the result claims eligibility
  assert.ok(!Object.keys(base).some((k) => /eligib|sponsor|visa|permit/i.test(k)));
});

// ---------------------------------------------------------------- adapters (pure)
test("feed adapters parse salary, employment type, experience and closing date (bounded, optional)", () => {
  const json = JSON.stringify({ jobs: [
    { id: "a1", title: "Cook", employer: "Cafe", location: { city: "Laval", region: "QC", country: "Canada" }, description: "Cook needed", salary: "$18-$21 per hour", employmentType: "Full-time", experienceRequirements: "2 years", closingDate: "2026-12-15" },
    { id: "a2", title: "Baker", employer: "Cafe", description: "Baker", baseSalary: { currency: "CAD", value: { minValue: 40000, maxValue: 50000, unitText: "YEAR" } }, jobType: "Part-time", closingAt: "2026-12-20T10:00:00Z" },
    { id: "a3", title: "Plain", employer: "Cafe", description: "x" },
  ] });
  const [a, b, c] = parseFeed(json, { country: "Canada" });
  assert.equal(a.salaryText, "$18-$21 per hour");
  assert.equal(a.employmentType, "Full-time");
  assert.equal(a.requiredExperienceText, "2 years");
  assert.equal(a.closingDate, "2026-12-15");
  assert.match(b.salaryText, /CAD.*40000.*50000/);
  assert.equal(b.employmentType, "Part-time");
  assert.equal(b.closingDate, "2026-12-20", "derived from closingAt when the feed has no closing date");
  assert.equal(c.salaryText ?? null, null);
  assert.equal(c.closingDate ?? null, null);
  const rss = `<rss><channel><item><guid>r1</guid><title>Welder</title><link>https://jobs.example/r1</link><company>Steel</company><description>Weld</description><salary>$30/h</salary><employmentType>Contract</employmentType><closingDate>2026-11-30</closingDate><experience>3 years</experience></item></channel></rss>`;
  const [r] = parseFeed(rss, {});
  assert.equal(r.salaryText, "$30/h");
  assert.equal(r.employmentType, "Contract");
  assert.equal(r.closingDate, "2026-11-30");
  assert.equal(r.requiredExperienceText, "3 years");
  // a bad closing date is dropped, not stored
  const [bad] = parseFeed(JSON.stringify([{ id: "z", title: "T", closingDate: "tomorrow-ish" }]), {});
  assert.equal(bad.closingDate ?? null, null);
});

// ---------------------------------------------------------------- database + HTTP
let pool;
let cleanup;
let server;
let base;
const ids = {};
const tok = {};
let seq = 0;

const q = (sql, params) => pool.query(sql, params);
const sign = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function http(method, url, token, body) {
  const res = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

test.before(async () => {
  ({ pool, cleanup } = await createTestDb());
  const app = loadApp(pool);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (email, role) => (await q("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [email, email, role])).rows[0].id;
  ids.admin = await mk("cls-adm@test.invalid", "Admin");
  ids.agentA = await mk("cls-agent-a@test.invalid", "Agent");
  ids.agentB = await mk("cls-agent-b@test.invalid", "Agent");
  ids.managerA = await mk("cls-mgr-a@test.invalid", "Manager");
  ids.managerB = await mk("cls-mgr-b@test.invalid", "Manager");
  ids.employer = await mk("cls-emp@test.invalid", "Employer");
  ids.agency = await mk("cls-agy@test.invalid", "Agency");
  tok.admin = sign(ids.admin, "Admin");
  tok.agentA = sign(ids.agentA, "Agent");
  tok.agentB = sign(ids.agentB, "Agent");
  tok.managerA = sign(ids.managerA, "Manager");
  tok.managerB = sign(ids.managerB, "Manager");
  tok.employer = sign(ids.employer, "Employer");
  tok.agency = sign(ids.agency, "Agency");
  await require("../modules/jobsearch/searchRunner").ensureSources();
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await cleanup();
});

const sourceId = async (key) => (await q("SELECT id FROM js_sources WHERE key=$1", [key])).rows[0].id;
const jobRow = async (id) => (await q("SELECT *, to_char(closing_date,'YYYY-MM-DD') AS cd FROM js_jobs WHERE id=$1", [id])).rows[0];
const auditRows = async (action) => (await q("SELECT * FROM js_audit_events WHERE action=$1 ORDER BY id", [action])).rows;

/** A live (connected, non-manual) source returning the vacancy. */
async function liveJob(extra = {}) {
  seq += 1;
  const { job } = await jobStore.upsertJob({
    sourceJobId: `cls-${seq}`, title: extra.title || `Electrician ${seq}`, employerName: extra.employerName || `Acme ${seq} Inc`, location: "Calgary, AB", country: "Canada",
    description: extra.description === undefined ? LONG : extra.description, ...extra.raw,
  }, await sourceId(extra.source || "test_fixture"), { now: extra.now });
  return Object.assign(job, { sjid: `cls-${seq}`, ename: extra.employerName || `Acme ${seq} Inc` });
}
const resight = async (j, over = {}) => jobStore.upsertJob({ sourceJobId: j.sjid, title: j.title, employerName: j.ename, location: "Calgary, AB", country: "Canada", description: LONG, ...over }, await sourceId("test_fixture"));

test("migration 029: columns, checks, idempotent re-run", async () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "029_classification_bands.sql"), "utf8");
  await q(sql);
  await q(sql); // idempotent
  const cols = (await q("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('js_jobs','js_matches')")).rows.map((r) => `${r.table_name}.${r.column_name}`);
  for (const c of ["classification", "classification_evidence", "classified_by", "classified_at", "salary_text", "employment_type", "required_experience_text", "closing_date"]) assert.ok(cols.includes(`js_jobs.${c}`), c);
  for (const c of ["band", "decision", "decision_by", "decided_at", "decision_note"]) assert.ok(cols.includes(`js_matches.${c}`), c);
  const j = await liveJob();
  await assert.rejects(q("UPDATE js_jobs SET classification='nonsense' WHERE id=$1", [j.id]), /check/i);
  await assert.rejects(q("UPDATE js_jobs SET classification='foreign_applicants_stated', classification_evidence=NULL WHERE id=$1", [j.id]), /check/i);
  await assert.rejects(q("UPDATE js_jobs SET classification='foreign_applicants_stated', classification_evidence='   ' WHERE id=$1", [j.id]), /check/i);
  await assert.rejects(q("UPDATE js_jobs SET classification_evidence=$2 WHERE id=$1", [j.id, "x".repeat(501)]), /check/i);
  await q("UPDATE js_jobs SET classification='verified_active' WHERE id=$1", [j.id]);
  const def = (await q("SELECT column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='js_matches' AND column_name='decision'")).rows[0].column_default;
  assert.match(def, /pending/);
});

test("upsert stores the new job fields and derives the classification from real signals", async () => {
  const j = await liveJob({ raw: { salaryText: "$40-$45 per hour", employmentType: "Full-time", requiredExperienceText: "3 years", closingDate: "2099-01-31" } });
  const r = await jobRow(j.id);
  assert.equal(r.salary_text, "$40-$45 per hour");
  assert.equal(r.employment_type, "Full-time");
  assert.equal(r.required_experience_text, "3 years");
  assert.equal(r.cd, "2099-01-31");
  assert.equal(r.classification, "verified_active");
  assert.equal(r.classified_by, null);
  assert.ok(r.classified_at);

  // a later sighting refreshes the fields but never blanks them
  const again = await resight(j, { salaryText: "$42 per hour" });
  assert.equal(again.job.id, j.id);
  const r2 = await jobRow(j.id);
  assert.equal(r2.salary_text, "$42 per hour");
  assert.equal(r2.employment_type, "Full-time");

  // manual (staff-entered) vacancy is not a verified source
  const manual = await liveJob({ source: "manual_import" });
  assert.equal((await jobRow(manual.id)).classification, "eligibility_unclear");

  // closing date derived from closingAt when only that is given
  const withAt = await liveJob({ raw: { closingAt: new Date("2099-03-04T10:00:00Z") } });
  assert.equal((await jobRow(withAt.id)).cd, "2099-03-04");

  // closed on arrival
  const closed = await liveJob({ raw: { closingAt: new Date("2020-01-01T00:00:00Z") } });
  assert.equal((await jobRow(closed.id)).classification, "closed_unsuitable");

  // required work authorization stated in the ad
  const wa = await liveJob({ description: `${LONG} Candidates must be legally entitled to work in Canada.` });
  const war = await jobRow(wa.id);
  assert.equal(war.classification, "work_authorization_required");
  assert.match(war.classification_evidence, /legally entitled to work in Canada/i);

  // a stated-foreign label is stored with its quote, which occurs in the ad
  const fo = await liveJob({ description: `${LONG} We welcome international applicants and offer visa sponsorship.` });
  const fr = await jobRow(fo.id);
  assert.equal(fr.classification, "foreign_applicants_stated");
  assert.ok(evidenceOccursIn(fr.classification_evidence, fr.description_text), fr.classification_evidence);
});

test("recheck: a vacancy found gone becomes closed_unsuitable", async () => {
  const j = await liveJob();
  assert.equal((await jobRow(j.id)).classification, "verified_active");
  const registry = { getAdapter: () => ({ fetchDetail: async () => null }) };
  const out = await jobStore.recheckJobDetailed(j.id, { registry, now: NOW });
  assert.equal(out.status, "closed");
  assert.equal((await jobRow(j.id)).classification, "closed_unsuitable");
});

test("staff classification endpoint: evidence rules, notes, permissions, audit, stickiness", async () => {
  const j = await liveJob({ description: `${LONG}\nWe   WELCOME international applicants.` });
  const url = `/jobsearch/jobs/${j.id}/classification`;

  // invalid inputs
  assert.equal((await http("POST", url, tok.managerA, { classification: "nonsense" })).status, 400);
  assert.equal((await http("POST", url, tok.managerA, {})).status, 400);
  assert.equal((await http("POST", url, tok.managerA, { classification: "foreign_applicants_stated" })).status, 400);
  assert.equal((await http("POST", url, tok.managerA, { classification: "foreign_applicants_stated", evidence: "   " })).status, 400);
  assert.equal((await http("POST", url, tok.managerA, { classification: "foreign_applicants_stated", evidence: "We sponsor visas for everyone" })).status, 400);
  assert.equal((await http("POST", url, tok.managerA, { classification: "foreign_applicants_stated", evidence: 42 })).status, 400);
  assert.equal((await http("POST", url, tok.managerA, { classification: "foreign_applicants_stated", evidence: "x".repeat(501) })).status, 400);
  assert.equal((await jobRow(j.id)).classification, "verified_active", "rejected requests change nothing");
  assert.equal((await auditRows("job.classification")).filter((a) => a.detail.jobId === j.id).length, 0);

  // note rules
  assert.equal((await http("POST", url, tok.managerA, { classification: "prospective_no_vacancy" })).status, 400);
  assert.equal((await http("POST", url, tok.managerA, { classification: "closed_unsuitable", note: "  " })).status, 400);
  assert.equal((await http("POST", url, tok.managerA, { classification: "closed_unsuitable", note: "n".repeat(501) })).status, 400);

  // permissions: candidate / employer / agency / anonymous denied
  for (const t of [tok.employer, tok.agency, null]) assert.ok([401, 403, 404].includes((await http("POST", url, t, { classification: "eligibility_unclear" })).status));
  const cand = await mkCandidate();
  assert.ok([403, 404].includes((await http("POST", url, cand.token, { classification: "eligibility_unclear" })).status));
  assert.equal((await http("POST", "/jobsearch/jobs/999999/classification", tok.managerA, { classification: "eligibility_unclear" })).status, 404);
  assert.equal((await http("POST", "/jobsearch/jobs/abc/classification", tok.managerA, { classification: "eligibility_unclear" })).status, 404);

  // verbatim (case-insensitive, whitespace-normalised) evidence is accepted and stored
  const ok = await http("POST", url, tok.managerA, { classification: "foreign_applicants_stated", evidence: "we welcome   international applicants" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.job.classification, "foreign_applicants_stated");
  assert.equal(ok.body.job.classificationEvidence, "we welcome international applicants");
  assert.match(ok.body.notice, /not proof|informational/i);
  let r = await jobRow(j.id);
  assert.equal(r.classified_by, ids.managerA);
  assert.ok(r.classified_at);
  const au = (await auditRows("job.classification")).filter((a) => a.detail.jobId === j.id);
  assert.equal(au.length, 1);
  assert.equal(au[0].detail.previous, "verified_active");
  assert.equal(au[0].detail.classification, "foreign_applicants_stated");
  assert.ok((await q("SELECT 1 FROM audit_logs WHERE action='jobsearch.job.classification' AND record_id=$1", [j.id])).rowCount >= 1);

  // sticky: an automatic recompute (new sighting, re-check, relabel) never overrides it
  await resight(j);
  await jobStore.recheckJobDetailed(j.id, { registry: { getAdapter: () => ({ fetchDetail: async () => null }) }, now: NOW });
  r = await jobRow(j.id);
  assert.equal(r.status, "closed");
  assert.equal(r.classification, "foreign_applicants_stated", "staff classification survives even a closed job");
  assert.equal(r.classified_by, ids.managerA);

  // the stricter note-only classes
  const j2 = await liveJob();
  const pn = await http("POST", `/jobsearch/jobs/${j2.id}/classification`, tok.managerA, { classification: "prospective_no_vacancy", note: "Talent pool page, no opening" });
  assert.equal(pn.status, 200);
  assert.equal((await jobRow(j2.id)).classification, "prospective_no_vacancy");
  assert.equal((await auditRows("job.classification")).filter((a) => a.detail.jobId === j2.id)[0].detail.note, "Talent pool page, no opening");

  // clearing returns control to the automatic derivation
  const cleared = await http("POST", `/jobsearch/jobs/${j2.id}/classification`, tok.admin, { classification: null });
  assert.equal(cleared.status, 200);
  r = await jobRow(j2.id);
  assert.equal(r.classified_by, null);
  assert.equal(r.classification, "verified_active");
  // automatic again: a re-check that finds the vacancy gone now closes the classification too
  await jobStore.recheckJobDetailed(j2.id, { registry: { getAdapter: () => ({ fetchDetail: async () => null }) }, now: NOW });
  r = await jobRow(j2.id);
  assert.equal(r.classification, "closed_unsuitable");
  assert.equal(r.classified_by, null);
});

test("job APIs show the new fields; manual import validates and stores them", async () => {
  const bad = [
    { salaryText: "s".repeat(201) }, { employmentType: "e".repeat(101) }, { requiredExperienceText: "r".repeat(301) },
    { closingDate: "2026-02-31" }, { closingDate: "soon" }, { salaryText: 5 }, { employmentType: {} }, { closingDate: 20261231 },
  ];
  for (const extra of bad) {
    const r = await http("POST", "/jobsearch/jobs/manual", tok.agentA, { title: "Welder", employerName: "Steel Co", ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  const ok = await http("POST", "/jobsearch/jobs/manual", tok.agentA, { title: "Welder", employerName: "Steel Co", description: LONG, salaryText: "$30/h", employmentType: "Full-time", requiredExperienceText: "2 years", closingDate: "2099-06-30" });
  assert.ok([200, 201].includes(ok.status), JSON.stringify(ok.body));
  assert.equal(ok.body.job.salaryText, "$30/h");
  assert.equal(ok.body.job.employmentType, "Full-time");
  assert.equal(ok.body.job.requiredExperienceText, "2 years");
  assert.equal(ok.body.job.closingDate, "2099-06-30");
  assert.equal(ok.body.job.classification, "eligibility_unclear", "staff-entered vacancies are not a verified source");
  const list = await http("GET", "/jobsearch/jobs?q=Welder", tok.agentA);
  const row = list.body.jobs.find((x) => x.id === ok.body.job.id);
  assert.equal(row.salary_text, "$30/h");
  assert.equal(row.employment_type, "Full-time");
  assert.equal(row.required_experience_text, "2 years");
  assert.equal(row.closing_date, "2099-06-30");
  assert.equal(row.classification, "eligibility_unclear");
  const one = await http("GET", `/jobsearch/jobs/${ok.body.job.id}`, tok.agentA);
  assert.equal(one.status, 200);
  assert.equal(one.body.job.classification, "eligibility_unclear");
  assert.equal((await http("GET", `/jobsearch/jobs/${ok.body.job.id}`, tok.employer)).status === 200, false);
  // re-import is an update, not a duplicate; fields survive a re-import that omits them
  const again = await http("POST", "/jobsearch/jobs/manual", tok.agentA, { title: "Welder", employerName: "Steel Co", description: LONG });
  assert.equal(again.status, 200);
  assert.equal(again.body.job.salaryText, "$30/h");
});

// ---------------------------------------------------------------- candidates, matches, decisions
async function mkCandidate({ assignedTo = ids.agentA, mode = "prepare_for_approval", wa } = {}) {
  seq += 1;
  const cid = (await q("INSERT INTO candidates (full_name, passport_number, assigned_to) VALUES ($1,$2,$3) RETURNING id", [`Cls Cand ${seq}`, `PP-CLS-${seq}`, assignedTo])).rows[0].id;
  if (wa !== undefined) await q("UPDATE candidates SET work_authorization_status=$2 WHERE id=$1", [cid, wa]);
  const r = await http("POST", "/jobsearch/admin/candidate-accounts", tok.admin, { candidate_id: cid, email: `cls-cand${seq}@test.invalid` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const tv = (await q("SELECT token_version FROM users WHERE id=$1", [r.body.user_id])).rows[0].token_version;
  const token = jwt.sign({ id: r.body.user_id, role: "Candidate", tv }, process.env.JWT_SECRET, { expiresIn: "1h" });
  await q("INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1,$2::jsonb,'confirmed',now())", [cid, JSON.stringify({ name: "Karim Benali", email: "karim@example.com", ...PROFILE })]);
  await q("INSERT INTO js_preferences (candidate_id, countries, categories, availability, salary_min, salary_currency, residence_country, needs_work_auth_support) VALUES ($1,'{Canada}','{Electrician}','now',1000,'USD','Tunisia',true)", [cid]);
  await q("INSERT INTO js_candidate_settings (candidate_id, mode) VALUES ($1,$2)", [cid, mode]);
  const g = await http("POST", `/jobsearch/candidates/${cid}/consent`, token, { scope: { search: true, prepare: true, submit: true, countries: [] }, version: "v1" });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  return { candidateId: cid, token, userId: r.body.user_id };
}
async function mkMatch(c, { score = 80, band = "good", classification = null, text = LONG, status = "open" } = {}) {
  seq += 1;
  const eid = (await q("INSERT INTO js_employers (name, normalized_name) VALUES ($1,$2) RETURNING id", [`Emp ${seq}`, `emp ${seq}`])).rows[0].id;
  const jobId = (await q(
    "INSERT INTO js_jobs (title, country, location, employer_id, source_primary, dedupe_key, description_text, url, status, classification, classification_evidence) VALUES ('Electrician','Canada','Calgary, Canada',$1,'partner_feed',$2,$3,'https://jobs.example/c',$4,$5,$6) RETURNING id",
    [eid, `dk-cls-${seq}`, text, status, classification, classification === "foreign_applicants_stated" ? "Visa sponsorship available" : null]
  )).rows[0].id;
  const matchId = (await q("INSERT INTO js_matches (candidate_id, job_id, score, band) VALUES ($1,$2,$3,$4) RETURNING id", [c.candidateId, jobId, score, band])).rows[0].id;
  return { jobId, matchId };
}

test("matchCandidate stores the band; the match API shows it (candidates: label only, never decisions or notes)", async () => {
  const c = await mkCandidate();
  await q("UPDATE js_preferences SET needs_work_auth_support=false, residence_country='Canada' WHERE candidate_id=$1", [c.candidateId]);
  const good = await liveJob({ title: "Electrician", description: STRONG_JOB.description_text });
  const stored = await matchService.matchCandidate(c.candidateId, { now: NOW });
  const m = stored.find((x) => x.job_id === good.id);
  assert.ok(m, "match stored");
  assert.ok(["strong", "good", "manual_review"].includes(m.band), m.band);
  assert.equal(m.band, computeBand(m.score, m.vetoes || []));
  const dbRow = (await q("SELECT band, decision FROM js_matches WHERE id=$1", [m.id])).rows[0];
  assert.equal(dbRow.band, m.band);
  assert.equal(dbRow.decision, "pending");
  // a staff note exists; the candidate must never see it
  await q("UPDATE js_matches SET decision='accepted', decision_by=$2, decided_at=now(), decision_note='internal: salary looks low' WHERE id=$1", [m.id, ids.managerA]);
  const cand = await http("GET", `/jobsearch/candidates/${c.candidateId}/matches`, c.token);
  assert.equal(cand.status, 200);
  const cm = cand.body.matches.find((x) => x.id === m.id);
  assert.equal(cm.band, m.band);
  assert.equal(cm.bandLabel, BAND_LABELS[m.band]);
  assert.ok(!("decision" in cm) && !("decisionNote" in cm) && !("decidedBy" in cm));
  assert.ok(!JSON.stringify(cand.body).includes("salary looks low"));
  assert.equal(cm.job.classification, "verified_active");
  const staff = await http("GET", `/jobsearch/candidates/${c.candidateId}/matches`, tok.agentA);
  const sm = staff.body.matches.find((x) => x.id === m.id);
  assert.equal(sm.decision, "accepted");
  assert.equal(sm.decisionNote, "internal: salary looks low");
  assert.equal(sm.band, m.band);
  // re-matching never resets a decision
  await matchService.matchCandidate(c.candidateId, { now: NOW });
  assert.equal((await q("SELECT decision FROM js_matches WHERE id=$1", [m.id])).rows[0].decision, "accepted");
});

test("relation to MATCH_MIN_SCORE: low scores are stored (threshold unchanged) but flagged not_recommended", async () => {
  const c = await mkCandidate();
  await q("UPDATE js_preferences SET categories='{Electrician}' WHERE candidate_id=$1", [c.candidateId]);
  const job = await liveJob({ title: "Electrician helper", description: "Helper role." + " Cleaning and carrying material on site every day, no tools involved at all." });
  const stored = await matchService.matchCandidate(c.candidateId, { now: NOW, minScore: 0 });
  const m = stored.find((x) => x.job_id === job.id);
  assert.ok(m);
  assert.equal(m.band, computeBand(m.score, m.vetoes || []));
  assert.equal(matchService.minScore(), 40, "the stored-match threshold is untouched");
});

test("accept / reject: permissions, scope, idempotency, re-decision and audit", async () => {
  const c = await mkCandidate({ assignedTo: ids.managerA });
  const { matchId } = await mkMatch(c);
  const acc = `/jobsearch/matches/${matchId}/accept`;
  const rej = `/jobsearch/matches/${matchId}/reject`;

  // denied: Agent (not assigned: 404, assigned: 403), candidate, employer, agency, anonymous, other manager (scope)
  assert.equal((await http("POST", acc, tok.agentA, {})).status, 404);
  assert.equal((await http("POST", acc, tok.managerB, {})).status, 404, "manager outside scope");
  for (const t of [tok.employer, tok.agency, null]) assert.ok([401, 403, 404].includes((await http("POST", acc, t, {})).status));
  assert.ok([403, 404].includes((await http("POST", acc, c.token, {})).status));
  assert.equal((await q("SELECT decision FROM js_matches WHERE id=$1", [matchId])).rows[0].decision, "pending");
  assert.equal((await http("POST", "/jobsearch/matches/abc/accept", tok.admin, {})).status, 404);
  assert.equal((await http("POST", "/jobsearch/matches/9999999/accept", tok.admin, {})).status, 404);

  // an Agent who IS assigned is still not an approver
  const ca = await mkCandidate({ assignedTo: ids.agentA });
  const ma = await mkMatch(ca);
  assert.equal((await http("POST", `/jobsearch/matches/${ma.matchId}/accept`, tok.agentA, {})).status, 403);
  assert.equal((await http("POST", `/jobsearch/matches/${ma.matchId}/reject`, tok.agentA, {})).status, 403);
  assert.equal((await q("SELECT decision FROM js_matches WHERE id=$1", [ma.matchId])).rows[0].decision, "pending");

  // validation
  assert.equal((await http("POST", acc, tok.managerA, { note: 5 })).status, 400);
  assert.equal((await http("POST", acc, tok.managerA, { note: "n".repeat(501) })).status, 400);

  // accept
  const r1 = await http("POST", acc, tok.managerA, { note: "Good fit, call the employer" });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.decision, "accepted");
  assert.equal(r1.body.changed, true);
  let row = (await q("SELECT * FROM js_matches WHERE id=$1", [matchId])).rows[0];
  assert.equal(row.decision, "accepted");
  assert.equal(row.decision_by, ids.managerA);
  assert.ok(row.decided_at);
  assert.equal(row.decision_note, "Good fit, call the employer");
  assert.equal((await auditRows("match.accept")).filter((a) => a.detail.matchId === matchId).length, 1);

  // idempotent: same decision again => no change, no extra audit row, note kept
  const r2 = await http("POST", acc, tok.managerA, {});
  assert.equal(r2.status, 200);
  assert.equal(r2.body.changed, false);
  assert.equal(r2.body.decision, "accepted");
  const r2b = await http("POST", acc, tok.admin, { note: "Good fit, call the employer" });
  assert.equal(r2b.body.changed, false);
  row = (await q("SELECT * FROM js_matches WHERE id=$1", [matchId])).rows[0];
  assert.equal(row.decision_by, ids.managerA, "a repeat does not steal the decision");
  assert.equal((await auditRows("match.accept")).filter((a) => a.detail.matchId === matchId).length, 1);
  assert.equal((await auditRows("match.decision_change")).filter((a) => a.detail.matchId === matchId).length, 0);

  // re-decision by an approver: audited change with the previous value
  const r3 = await http("POST", rej, tok.admin, { note: "Employer withdrew" });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.decision, "rejected");
  assert.equal(r3.body.changed, true);
  row = (await q("SELECT * FROM js_matches WHERE id=$1", [matchId])).rows[0];
  assert.equal(row.decision, "rejected");
  assert.equal(row.decision_by, ids.admin);
  assert.equal(row.decision_note, "Employer withdrew");
  const ch = (await auditRows("match.decision_change")).filter((a) => a.detail.matchId === matchId);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].detail.previous, "accepted");
  assert.equal(ch[0].detail.decision, "rejected");
  assert.ok((await q("SELECT 1 FROM audit_logs WHERE action LIKE 'jobsearch.match.%' AND record_id=$1", [matchId])).rowCount >= 2);
  // the same again is idempotent
  assert.equal((await http("POST", rej, tok.admin, {})).body.changed, false);
  // a different note on the same decision is an audited update, the decision keeps its value
  const r4 = await http("POST", rej, tok.managerA, { note: "Second thoughts" });
  assert.equal(r4.body.changed, true);
  assert.equal((await q("SELECT decision_note FROM js_matches WHERE id=$1", [matchId])).rows[0].decision_note, "Second thoughts");
});

test("concurrent accept and reject leave one consistent decision", async () => {
  const c = await mkCandidate({ assignedTo: ids.managerA });
  const { matchId } = await mkMatch(c);
  const out = await Promise.all([1, 2, 3, 4].map((i) => http("POST", `/jobsearch/matches/${matchId}/${i % 2 ? "accept" : "reject"}`, tok.managerA, {})));
  assert.ok(out.every((r) => r.status === 200), JSON.stringify(out.map((r) => r.status)));
  const row = (await q("SELECT decision FROM js_matches WHERE id=$1", [matchId])).rows[0];
  assert.ok(["accepted", "rejected"].includes(row.decision));
  const changes = (await auditRows("match.accept")).concat(await auditRows("match.reject"), await auditRows("match.decision_change")).filter((a) => a.detail.matchId === matchId);
  assert.ok(changes.length >= 1 && changes.length <= 4);
});

test("scheduler grant never proposes a not_recommended match; people still can", async () => {
  const c = await mkCandidate();
  const bad = await mkMatch(c, { score: 90, band: "not_recommended" });
  const good = await mkMatch(c, { score: 90, band: "good" });
  const { SCHEDULER_GRANT } = applicationService._internal;
  await assert.rejects(applicationService.createFromMatch({ matchId: bad.matchId, actor: "system:scheduler", [SCHEDULER_GRANT]: true }), (e) => e.status === 409 && e.code === "match_not_recommended");
  const okSys = await applicationService.createFromMatch({ matchId: good.matchId, actor: "system:scheduler", [SCHEDULER_GRANT]: true });
  assert.equal(okSys.created, true);
  const human = await http("POST", "/jobsearch/applications", tok.agentA, { matchId: bad.matchId });
  assert.equal(human.status, 201, "a person may still open an application on a flagged match");
});

// ---------------------------------------------------------------- application preparation
const prep = (appId, token = tok.agentA) => http("POST", `/jobsearch/applications/${appId}/prepare`, token, {});
async function appFor(c, matchOpts) {
  const m = await mkMatch(c, matchOpts);
  const r = await http("POST", "/jobsearch/applications", tok.admin, { matchId: m.matchId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { appId: r.body.application.id, ...m };
}

test("preparation blockers matrix: classification x work_authorization_status", async () => {
  // closed_unsuitable blocks for every candidate status
  for (const wa of ["citizen", "none", null]) {
    const c = await mkCandidate({ wa: wa === null ? undefined : wa });
    const a = await appFor(c, { classification: "closed_unsuitable" });
    const r = await prep(a.appId);
    assert.equal(r.status, 409, `closed ${wa}`);
    assert.equal(r.body.code, "job_closed_unsuitable");
  }
  // work_authorization_required: only permit / PR / citizen states pass
  const allowed = ["work_permit_open", "work_permit_employer_specific", "pr", "citizen"];
  const blocked = ["none", "study_permit", "unknown", undefined];
  for (const wa of [...allowed, ...blocked]) {
    const c = await mkCandidate({ wa });
    const a = await appFor(c, { classification: "work_authorization_required" });
    const r = await prep(a.appId);
    if (allowed.includes(wa)) {
      assert.equal(r.status, 200, `${wa}: ${JSON.stringify(r.body)}`);
      assert.ok(r.body.package.notes.includes(`job_requires_work_authorization:candidate_status_${wa}`), JSON.stringify(r.body.package.notes));
    } else {
      assert.equal(r.status, 409, String(wa));
      assert.equal(r.body.code, "work_authorization_required");
      assert.equal((await q("SELECT status FROM js_applications WHERE id=$1", [a.appId])).rows[0].status, "matched", "a refused preparation leaves the application untouched");
    }
  }
  // other classes (and no classification) never block on their own
  for (const cl of [null, "verified_active", "foreign_applicants_stated", "eligibility_unclear"]) {
    const c = await mkCandidate({ wa: "none" });
    const a = await appFor(c, { classification: cl, text: cl === "foreign_applicants_stated" ? `${LONG} Visa sponsorship available.` : LONG });
    const r = await prep(a.appId);
    assert.equal(r.status, 200, `${cl}: ${JSON.stringify(r.body)}`);
    assert.ok(!r.body.package.notes.some((n) => n.startsWith("job_requires_work_authorization")), String(cl));
  }
  // the text of an ad is never treated as LMIA proof in the notes
  const c = await mkCandidate();
  const a = await appFor(c, { classification: "foreign_applicants_stated", text: `${LONG} Visa sponsorship available.` });
  const r = await prep(a.appId);
  assert.ok(!JSON.stringify(r.body.package.notes).match(/lmia|sponsorship confirmed/i));
});

test("preparation refuses prospective_no_vacancy for every candidate status (outreach basis not approved)", async () => {
  for (const wa of ["citizen", "pr", "none", null]) {
    const c = await mkCandidate({ wa: wa === null ? undefined : wa });
    const a = await appFor(c, { classification: "prospective_no_vacancy" });
    const r = await prep(a.appId);
    assert.equal(r.status, 409, `prospective ${wa}`);
    assert.equal(r.body.code, "no_vacancy_outreach_not_permitted");
    assert.equal((await q("SELECT status FROM js_applications WHERE id=$1", [a.appId])).rows[0].status, "matched", "a refused preparation leaves the application untouched");
  }
});

test("require_match_acceptance: admin-only toggle, default off; on => preparation needs an accepted match", async () => {
  const get = await http("GET", "/jobsearch/match-settings", tok.agentA);
  assert.equal(get.status, 200);
  assert.equal(get.body.require_match_acceptance, false);
  assert.ok([401, 403, 404].includes((await http("GET", "/jobsearch/match-settings", tok.employer)).status));

  // default: a pending match prepares as before
  const c0 = await mkCandidate();
  const a0 = await appFor(c0, {});
  assert.equal((await prep(a0.appId)).status, 200);

  // non-admins cannot flip it, nor can bad input
  for (const t of [tok.agentA, tok.managerA, tok.employer, tok.agency]) assert.ok([401, 403, 404].includes((await http("PUT", "/jobsearch/match-settings", t, { require_match_acceptance: true })).status));
  assert.equal((await http("PUT", "/jobsearch/match-settings", tok.admin, { require_match_acceptance: "yes" })).status, 400);
  assert.equal((await http("PUT", "/jobsearch/match-settings", tok.admin, {})).status, 400);
  assert.equal((await http("GET", "/jobsearch/match-settings", tok.agentA)).body.require_match_acceptance, false);

  const on = await http("PUT", "/jobsearch/match-settings", tok.admin, { require_match_acceptance: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.require_match_acceptance, true);
  assert.equal((await auditRows("settings.match_acceptance")).length, 1);
  try {
    const c = await mkCandidate({ assignedTo: ids.managerA });
    const a = await appFor(c, {});
    let r = await prep(a.appId, tok.managerA);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "match_not_accepted");
    assert.equal((await http("POST", `/jobsearch/matches/${a.matchId}/reject`, tok.managerA, {})).status, 200);
    r = await prep(a.appId, tok.managerA);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "match_not_accepted");
    assert.equal((await http("POST", `/jobsearch/matches/${a.matchId}/accept`, tok.managerA, {})).status, 200);
    r = await prep(a.appId, tok.managerA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // the match disappearing does not bypass the rule
    const c2 = await mkCandidate({ assignedTo: ids.managerA });
    const a2 = await appFor(c2, {});
    await q("DELETE FROM js_matches WHERE id=$1", [a2.matchId]);
    r = await prep(a2.appId, tok.managerA);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "match_not_accepted");
  } finally {
    const off = await http("PUT", "/jobsearch/match-settings", tok.admin, { require_match_acceptance: false });
    assert.equal(off.body.require_match_acceptance, false);
  }
  const c3 = await mkCandidate();
  const a3 = await appFor(c3, {});
  assert.equal((await prep(a3.appId)).status, 200, "off again: back to the previous behaviour");
});

test("candidates see an accepted/rejected state only through an existing application, never the note or the approver", async () => {
  const c = await mkCandidate({ assignedTo: ids.managerA });
  const a = await appFor(c, {});
  await http("POST", `/jobsearch/matches/${a.matchId}/accept`, tok.managerA, { note: "staff only remark" });
  const view = await http("GET", `/jobsearch/applications/${a.appId}`, c.token);
  assert.equal(view.status, 200);
  assert.equal(view.body.match.decision, "accepted");
  assert.ok(view.body.match.band);
  assert.ok(!JSON.stringify(view.body).includes("staff only remark"));
  assert.ok(!("decisionBy" in view.body.match) && !("decisionNote" in view.body.match));
  const staff = await http("GET", `/jobsearch/applications/${a.appId}`, tok.managerA);
  assert.equal(staff.body.match.decisionNote, "staff only remark");
  assert.equal(staff.body.match.decisionBy, ids.managerA);
});

test("employer-confirmation relabels the job classification and a revoke restores it", async () => {
  const j = await liveJob();
  assert.equal((await jobRow(j.id)).classification, "verified_active");
  const c = await http("POST", "/jobsearch/employer-confirmations", tok.admin, { jobId: j.id, evidenceNote: "Employer HR confirmed in writing on 2026-10-30 that overseas applicants are considered" });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const r = await jobRow(j.id);
  assert.equal(r.classification, "foreign_applicants_stated");
  assert.match(r.classification_evidence, /overseas applicants are considered/);
  assert.equal(r.classified_by, null, "derived, not staff-set");
  assert.equal((await http("DELETE", `/jobsearch/employer-confirmations/${c.body.id}`, tok.admin)).status, 200);
  assert.equal((await jobRow(j.id)).classification, "verified_active");
});

test("scoreMatch: 'residents only' ads cap the band at manual_review (reviewable by a person), not not_recommended", () => {
  const r = scoreMatch(PROFILE, { ...PREFS, residence_country: "Tunisia", needs_work_auth_support: false }, { ...STRONG_JOB, description_text: `${STRONG_JOB.description_text} Canadian residents only.` }, { now: NOW });
  assert.ok(r.vetoes.some((v) => v.code === "applicants_must_be_local" && v.severity === "manual_review"));
  assert.ok(r.band !== "strong" && r.band !== "good", r.band);
});

// ---------------------------------------------------------------- review round 1

test("review round 1: ads that exclude foreign / non-resident applicants are work_authorization_required, never verified_active", () => {
  const phrases = [
    "We do not consider foreign applicants.",
    "Only candidates currently residing in Canada will be considered.",
    "Canadian residents only.",
    "Applicants must currently reside in Canada.",
  ];
  for (const p of phrases) {
    const r = derive(open({ description_text: `${LONG}\n${p}` }));
    assert.equal(r.classification, "work_authorization_required", p);
    assert.notEqual(r.classification, "verified_active");
    assert.ok(r.evidence, `${p} keeps a quoted evidence`);
  }
  // an ordinary open ad is still verified_active
  assert.equal(derive(open()).classification, "verified_active");
});

test("review round 1: staff classification needs jobsearch:approve for every class; foreign_applicants_stated evidence is a real quote", async () => {
  const j = await liveJob({ description: `${LONG}\nWe welcome international applicants from every country.` });
  const url = `/jobsearch/jobs/${j.id}/classification`;
  for (const body of [{ classification: "eligibility_unclear" }, { classification: "closed_unsuitable", note: "closed" }, { classification: null }]) {
    assert.equal((await http("POST", url, tok.agentA, body)).status, 403, JSON.stringify(body));
  }
  assert.equal((await jobRow(j.id)).classified_by, null, "an Agent changed nothing");
  await assert.rejects(classification.setStaffClassification({ jobId: j.id, user: { id: ids.agentA, role: "Receptionist" }, classification: "eligibility_unclear" }), /jobsearch:approve/);
  // too short / too few words, even though verbatim
  for (const ev of ["international", "welcome international", "We welcome international"]) {
    assert.equal((await http("POST", url, tok.managerA, { classification: "foreign_applicants_stated", evidence: ev })).status, 400, ev);
  }
  const ok = await http("POST", url, tok.managerA, { classification: "foreign_applicants_stated", evidence: "We welcome international applicants from every country" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("review round 1: (re)classifying a job re-scores its matches without touching decisions", async () => {
  const cand = await mkCandidate();
  const j = await liveJob();
  const m = (await q("INSERT INTO js_matches (candidate_id, job_id, score, band, decision, decision_by, decided_at) VALUES ($1,$2,5,'strong',$3,$4,now()) RETURNING *", [cand.candidateId, j.id, "accepted", ids.managerA])).rows[0];
  const r = await http("POST", `/jobsearch/jobs/${j.id}/classification`, tok.managerA, { classification: "closed_unsuitable", note: "closed by employer" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = (await q("SELECT * FROM js_matches WHERE id=$1", [m.id])).rows[0];
  assert.equal(after.decision, "accepted", "decision untouched");
  assert.equal(after.decision_by, ids.managerA);
  assert.notEqual(after.score, 5, "score refreshed");
  assert.notEqual(after.band, "strong", "band refreshed");
});
