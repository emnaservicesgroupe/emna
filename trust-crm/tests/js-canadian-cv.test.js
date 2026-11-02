// Stage 8 task 2: Canadian-format CV generator (model builder, PDF / DOCX renderers, versions, approval + authorisation gates,
// scoping, application attachment rules, file integrity, audit, migration 026).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");
const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");
const { makePdf } = require("./helpers/docs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "js-canadian-cv-test-secret";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "js-ccv-"));
delete process.env.CLAMAV_HOST;
process.env.JS_UPLOADS_PER_HOUR = "1000";
process.env.ALLOW_UNSCANNED_ATTACHMENTS = "true"; // uploaded originals are never scanned in tests; generated CVs are recorded 'clean'

const gen = require("../modules/jobsearch/cvGenerator");
const storage = require("../modules/jobsearch/storage");
const applicationService = require("../modules/jobsearch/applicationService");

const SQL026 = fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "026_canadian_cv.sql"), "utf8");
const NOW = new Date("2026-10-31T12:00:00Z");

const PROFILE = {
  name: "Karim Benali",
  email: "karim.benali@example.com",
  phone: "+216 22 345 678",
  profession: "Electrical Technician",
  skills: ["Electrical installation", "PLC programming", "Industrial maintenance", "AutoCAD Electrical"],
  experience: [
    { title: "Electrician", employer: "Sfax Industries", start: "2015", end: "2019" },
    { title: "Senior Electrician", employer: "Gulf Build LLC", start: "2019", end: "Present" },
  ],
  education: ["Higher Diploma in Electrical Engineering, University of Sfax, 2014"],
  certificates: ["Electrical Safety Certificate"],
  languages: [{ lang: "Arabic", level: "Native" }, { lang: "French", level: "Fluent" }, { lang: "English", level: "B2" }],
};
// Facts that must never reach a CV even when the profile object carries them.
const FORBIDDEN = {
  date_of_birth: "1984-05-12", dob: "12/05/1984", age: 42, nationality: "Tunisian", marital_status: "Married", passport_number: "P1234567",
  passport: { number: "P1234567" }, photo: "karim-photo.jpg", salary: "USD 9999", salary_expectation: 9999, gender: "male", religion: "Muslim",
};
const FORBIDDEN_NEEDLES = ["1984", "Tunisian", "Married", "P1234567", "photo.jpg", "9999", "male", "Muslim", "Date of birth", "Nationality", "Marital", "Passport"];

// ---------------------------------------------------------------- helpers

async function pdfText(buf) {
  const { PDFParse } = require("pdf-parse");
  const p = new PDFParse({ data: new Uint8Array(buf) });
  try {
    return (await p.getText()).text;
  } finally {
    if (typeof p.destroy === "function") await p.destroy().catch(() => {});
  }
}

/** Reads one entry of a zip with node built-ins only (central directory, stored / deflate). */
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
function docxXml(buf) {
  return zipEntry(buf, "word/document.xml").toString("utf8");
}
function docxText(buf) {
  return docxXml(buf)
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

// small seeded PRNG so a failure is reproducible
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- pure: model builder

test("model: confirmed facts only, fixed-template summary, reverse-chronological experience, no forbidden fields", () => {
  const m = gen.buildCvModel({ ...PROFILE, ...FORBIDDEN }, { city: "Sfax", country: "Tunisia" }, { lang: "en", now: NOW });
  assert.equal(m.refusal, undefined);
  assert.equal(m.name, "Karim Benali");
  assert.deepEqual(m.contact, { city: "Sfax", country: "Tunisia", email: "karim.benali@example.com", phone: "+216 22 345 678" });
  const byId = Object.fromEntries(m.sections.map((s) => [s.id, s]));
  assert.deepEqual(m.sections.map((s) => s.id), ["summary", "experience", "skills", "education", "certifications", "languages"]);
  // 2015 (conservative: Dec 2015) .. 2026-10 = 10 whole years
  assert.equal(byId.summary.text, "Electrical Technician with 10 years of verified experience in Electrical installation, PLC programming, Industrial maintenance.");
  assert.deepEqual(byId.experience.items.map((e) => e.title), ["Senior Electrician", "Electrician"], "present first, then by end date descending");
  assert.deepEqual(byId.languages.items, [{ lang: "Arabic", level: "Native" }, { lang: "French", level: "Fluent" }, { lang: "English", level: "B2" }], "proficiency exactly as confirmed");
  assert.deepEqual(m.missing, []);
  const json = JSON.stringify(m);
  for (const n of FORBIDDEN_NEEDLES) assert.ok(!json.includes(n), `model contains ${n}`);
});

test("model: summary only from verified facts (profession AND years AND a skill), otherwise omitted and flagged", () => {
  const base = { ...PROFILE };
  const ids = (p) => gen.buildCvModel(p, {}, { now: NOW });
  assert.ok(ids(base).sections.some((s) => s.id === "summary"));
  for (const [label, p] of [
    ["no profession", { ...base, profession: null }],
    ["no skills", { ...base, skills: [] }],
    ["experience without dates", { ...base, experience: [{ title: "A", employer: "B", start: null, end: null }] }],
    ["one entry lacks its end", { ...base, experience: [...base.experience, { title: "C", employer: "D", start: "2010", end: null }] }],
    ["under one year", { ...base, experience: [{ title: "A", employer: "B", start: "2026-03", end: "2026-09" }] }],
    ["no experience", { ...base, experience: [] }],
  ]) {
    const m = ids(p);
    assert.ok(!m.sections.some((s) => s.id === "summary"), label);
    assert.ok(m.missing.includes("professional_summary"), label);
  }
  // overlapping / adjacent spans are not double counted; whole years only (floored)
  // year-only dates take the CONSERVATIVE bound (start = December of the start year, end = January of the end year): Dec 2015 .. Jan 2020
  assert.equal(gen.verifiedYears([{ start: "2015", end: "2019" }, { start: "2018", end: "2020" }], NOW), 4);
  assert.equal(gen.verifiedYears([{ start: "2018", end: "2019" }], NOW), 0, "a Jan start and Dec end of adjacent years verifies no full year");
  assert.equal(gen.verifiedYears([{ start: "2019", end: "2018" }], NOW), 0, "a negative span counts as 0");
  assert.equal(gen.verifiedYears([{ start: "2018", end: "2018" }], NOW), 0);
  assert.equal(gen.verifiedYears([{ start: "01/2018", end: "12/2018" }], NOW), 1, "month-precise dates keep their precision");
  assert.equal(gen.verifiedYears([{ start: "03/2020", end: "Jan 2022" }], NOW), 1);
  assert.equal(gen.verifiedYears([{ start: "2020", end: "garbage" }], NOW), null);
});

test("model: missing[] lists absent sections and undated items; dated entries sorted, undated kept as confirmed", () => {
  const m = gen.buildCvModel(
    { name: "A B", experience: [{ title: "Undated 1", employer: "X" }, { title: "Old", employer: "Y", start: "2001", end: "2003" }, { title: "Undated 2", employer: "Z", start: "2005", end: "soon" }, { title: "New", employer: "W", start: "2010", end: "2012" }] },
    {},
    { now: NOW }
  );
  const exp = m.sections.find((s) => s.id === "experience").items.map((e) => e.title);
  assert.deepEqual(exp, ["New", "Old", "Undated 1", "Undated 2"]);
  for (const k of ["dates:experience[0]", "dates:experience[2]", "professional_summary", "skills", "education", "certifications", "languages", "contact.location", "contact.email", "contact.phone"]) assert.ok(m.missing.includes(k), k);
  assert.ok(!m.missing.includes("dates:experience[1]") && !m.missing.includes("dates:experience[3]") && !m.missing.includes("experience"));
});

test("model: refusal without a name, or without both experience and education", () => {
  assert.deepEqual(gen.buildCvModel({ ...PROFILE, name: "  " }, {}, { now: NOW }).refusal, { code: "minimum_not_met", reasons: ["name"] });
  assert.deepEqual(gen.buildCvModel({ ...PROFILE, experience: [], education: [] }, {}, { now: NOW }).refusal, { code: "minimum_not_met", reasons: ["experience_or_education"] });
  assert.deepEqual(gen.buildCvModel({}, {}, { now: NOW }).refusal.reasons, ["name", "experience_or_education"]);
  assert.equal(gen.buildCvModel({ name: "N", education: ["BSc"] }, {}, { now: NOW }).refusal, undefined, "education alone is enough");
  assert.equal(gen.buildCvModel({ name: "N", experience: [{ title: "T" }] }, {}, { now: NOW }).refusal, undefined, "experience alone is enough");
  assert.ok(gen.buildCvModel({ name: "N", experience: [{ title: null, employer: null, start: "2020", end: "2021" }] }, {}, { now: NOW }).refusal, "an entry with no title or employer is not experience");
});

test("model: French mode translates headings and the summary template only, never the facts", () => {
  const en = gen.buildCvModel(PROFILE, { city: "Sfax" }, { lang: "en", now: NOW });
  const fr = gen.buildCvModel(PROFILE, { city: "Sfax" }, { lang: "fr", now: NOW });
  assert.deepEqual(fr.sections.map((s) => s.heading), ["Résumé professionnel", "Expérience professionnelle", "Compétences", "Formation", "Certifications et permis", "Langues"]);
  assert.deepEqual(fr.sections.map((s) => s.items), en.sections.map((s) => s.items), "facts identical");
  assert.equal(fr.name, en.name);
  assert.deepEqual(fr.contact, en.contact);
  assert.equal(fr.sections[0].text, "Electrical Technician avec 10 ans d'expérience vérifiée en Electrical installation, PLC programming, Industrial maintenance.");
  assert.equal(gen.buildCvModel(PROFILE, {}, { lang: "de", now: NOW }).lang, "en", "unknown language falls back to English headings");
});

test("model: sensitive-looking list items are dropped and reported, never emitted", () => {
  const m = gen.buildCvModel(
    { name: "N", skills: ["Welding", "Marital status: single"], education: ["Date of birth 1990-01-01", "BSc"], certificates: ["Passport P123"], languages: [{ lang: "Arabic", level: "Nationality: Tunisian" }], experience: [{ title: "Welder", employer: "ACME", start: "2020", end: "2021" }] },
    {},
    { now: NOW }
  );
  const json = JSON.stringify(m);
  for (const n of ["Marital", "1990", "Passport", "Nationality", "Tunisian"]) assert.ok(!json.includes(n), n);
  for (const k of ["excluded_sensitive:skills", "excluded_sensitive:education", "excluded_sensitive:certifications", "excluded_sensitive:languages"]) assert.ok(m.missing.includes(k), k);
});

test("review round 1: the sensitive-item filter covers French, English and Arabic; a job title such as 'Photo Editor' is kept", () => {
  const dropped = [
    "Né le 12/03/1990", "Née le 12/03/1990", "Marié, 2 enfants", "Mariée", "Age 34", "Age: 34", "Âge : 34", "34 years old", "Citoyen tunisien", "Citoyenne canadienne", "Tunisian citizen",
    "Date de naissance: 12/03/1990", "Date of birth: 1990-03-12", "DOB 12/03/1990", "Single", "Célibataire", "État civil : marié", "Marital status: single", "Nationalité : tunisienne", "Nationality: Tunisian",
    "Passeport n° P123456", "Passport P123456", "2 children", "Enfants : 2", "Gender: male", "Sexe : masculin", "Religion: Muslim", "Photo: attached", "Photograph attached", "Photo jointe", "Ressortissant tunisien",
    "تاريخ الميلاد 1990/03/12", "متزوج وله طفلان", "أعزب", "الجنسية: تونسية", "جواز السفر رقم 123", "أطفال: 2", "العمر 34", "الحالة الاجتماعية: متزوج",
  ];
  const kept = ["Photo Editor", "Photographer", "Single-phase wiring", "Stage coordination", "Management", "Marie Curie Institute training", "Waste management", "Divorce law", "5 ans d'expérience en soudure", "Child care certificate"];
  for (const item of dropped) {
    const m = gen.buildCvModel({ name: "N", skills: ["Welding", item], experience: [{ title: "Welder", employer: "ACME", start: "2015", end: "2020" }] }, {}, { now: NOW });
    assert.deepEqual(m.sections.find((x) => x.id === "skills").items, ["Welding"], `kept: ${item}`);
    assert.ok(m.missing.includes("excluded_sensitive:skills"), item);
  }
  for (const item of kept) {
    const m = gen.buildCvModel({ name: "N", skills: ["Welding", item] }, {}, { now: NOW });
    assert.deepEqual(m.sections.find((x) => x.id === "skills").items, ["Welding", item], `dropped: ${item}`);
  }
  // titles, employers, languages and the profession go through the same filter, and the summary only uses skills that passed
  const m = gen.buildCvModel(
    { name: "N", profession: "Marié", skills: ["Né le 12/03/1990", "Welding"], experience: [{ title: "Photo Editor", employer: "Citoyen Corp", start: "2010", end: "2020" }, { title: "Welder", employer: "ACME", start: "2010", end: "2020" }], languages: [{ lang: "Arabic", level: "متزوج" }] },
    {},
    { now: NOW }
  );
  assert.deepEqual(m.sections.find((x) => x.id === "experience").items.map((e) => e.title), ["Welder"]);
  assert.ok(!m.sections.some((x) => x.id === "summary"), "a profession that states a civil status is not used");
  const m2 = gen.buildCvModel({ name: "N", profession: "Welder", skills: ["Né le 12/03/1990", "Welding"], experience: [{ title: "Welder", employer: "ACME", start: "2010", end: "2020" }] }, {}, { now: NOW });
  assert.deepEqual(m2.sections.find((x) => x.id === "summary").facts.skills, ["Welding"]);
});

test("review round 1: verified years use the conservative bound for year-only dates and speak correct singular grammar", () => {
  const base = { name: "N", profession: "Welder", skills: ["Welding"] };
  const text = (exp, lang = "en") => (gen.buildCvModel({ ...base, experience: exp }, {}, { now: NOW, lang }).sections.find((x) => x.id === "summary") || {}).text;
  assert.equal(text([{ title: "A", employer: "B", start: "2018", end: "2019" }]), undefined, "Jan 2018 .. Dec 2019 is NOT two years: Dec 2018 .. Jan 2019 verifies none");
  assert.equal(text([{ title: "A", employer: "B", start: "2017", end: "2019" }]), "Welder with 1 year of verified experience in Welding.");
  assert.equal(text([{ title: "A", employer: "B", start: "2017", end: "2019" }], "fr"), "Welder avec 1 an d'expérience vérifiée en Welding.");
  assert.equal(text([{ title: "A", employer: "B", start: "2016", end: "2019" }]), "Welder with 2 years of verified experience in Welding.");
  assert.equal(text([{ title: "A", employer: "B", start: "2016", end: "2019" }], "fr"), "Welder avec 2 ans d'expérience vérifiée en Welding.");
  assert.equal(text([{ title: "A", employer: "B", start: "2019", end: "2018" }]), undefined, "a negative span counts as zero");
  assert.equal(text([{ title: "A", employer: "B", start: "2018", end: "2018" }]), undefined);
});

test("review round 1: control characters are stripped and text is NFC before rendering (PDF and DOCX)", async () => {
  const m = gen.buildCvModel(
    { name: "Jos\u0001e\u0008 Cafe\u0301", profession: "Electrician", skills: ["Wiring\u0000", "Cable\u0007s", "Re\u0301sume\u0301"], experience: [{ title: "Tech\u0001nician", employer: "Cafe\u0301 Inc", start: "2015", end: "2020" }], education: ["E\u0301cole\u009f"] },
    { city: "Montre\u0301al" },
    { now: NOW }
  );
  assert.equal(m.name, "Jose Café");
  const all = JSON.stringify(m);
  assert.ok(!/\\u00(0[0-8b-f]|1[0-9a-f]|7f|[89][0-9a-f])/i.test(all), "no control character survives");
  assert.deepEqual(m.sections.find((x) => x.id === "skills").items, ["Wiring", "Cables", "Résumé"], "NFC: composed letters");
  assert.deepEqual(m.missing.filter((k) => k.startsWith("latin_spelling_needed")), [], "decomposed accents are drawable once composed");
  assert.equal(m.contact.city, "Montréal");
  const pdf = await gen.renderPdf(m);
  assert.ok((await pdfText(pdf)).includes("Café"));
  const docx = await gen.renderDocx(m);
  const xml = docxXml(docx);
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml), "DOCX XML has no control character");
  assert.ok(docxText(docx).includes("Technician"));
  // tab and new line are kept
  assert.equal(gen.buildCvModel({ name: "N\tM", skills: ["a\nb"] }, {}, { now: NOW }).name, "N\tM");
});

test("model property: every string is copied from the profile / extras or is a static label (random profiles, en + fr)", () => {
  const WORDS = ["Électricien", "Welder", "Plumber", "Acme Ltd", "O'Brien & Sons", "PLC", "Soudure", "Sfax", "Cert-IV", "B2", "Native", "Montréal", "C++", "Dipl. Ing.", "x"];
  const DATES = ["2001", "2005-06", "06/2010", "Mar 2012", "mars 2014", "2019", "Present", "present", "2023", "garbage", "", null];
  const MISSING_RE = /^(professional_summary|experience|skills|education|certifications|languages|contact\.(location|email|phone)|dates:experience\[\d+\]|excluded_sensitive:\w+|latin_spelling_needed:.+)$/;
  const r = rng(20261031);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const maybe = (p, f) => (r() < p ? f() : undefined);
  const word = () => pick(WORDS);
  for (let i = 0; i < 200; i++) {
    const lang = i % 2 ? "fr" : "en";
    const profile = {
      name: maybe(0.9, () => `${word()} ${word()}`),
      email: maybe(0.6, () => "a.b@example.com"),
      phone: maybe(0.6, () => "+1 416 555 0100"),
      profession: maybe(0.7, word),
      skills: maybe(0.8, () => Array.from({ length: Math.floor(r() * 5) }, word)),
      experience: maybe(0.8, () => Array.from({ length: Math.floor(r() * 4) }, () => ({ title: maybe(0.8, word) ?? null, employer: maybe(0.8, word) ?? null, start: pick(DATES), end: pick(DATES) }))),
      education: maybe(0.7, () => Array.from({ length: Math.floor(r() * 3) }, word)),
      certificates: maybe(0.5, () => Array.from({ length: Math.floor(r() * 3) }, word)),
      languages: maybe(0.7, () => Array.from({ length: Math.floor(r() * 3) }, () => ({ lang: word(), level: maybe(0.7, word) ?? null }))),
      ...(r() < 0.5 ? FORBIDDEN : {}),
    };
    const extras = { city: maybe(0.6, word), country: maybe(0.6, word) };
    const m = gen.buildCvModel(profile, extras, { lang, now: NOW });
    const allowed = new Set([...strings(profile), ...strings(extras)].map((s) => s.trim()));
    const headings = new Set(Object.values(gen.HEADINGS[lang]));
    const bad = [];
    const check = (s) => { if (typeof s === "string" && s !== "" && !allowed.has(s)) bad.push(s); };
    check(m.name);
    Object.values(m.contact).forEach(check);
    for (const sec of m.sections) {
      assert.ok(headings.has(sec.heading), `heading ${sec.heading}`);
      if (sec.id === "summary") {
        check(sec.facts.profession);
        sec.facts.skills.forEach(check);
        assert.equal(typeof sec.facts.years, "number");
        const one = sec.facts.years === 1;
        const want = lang === "en" ? `${sec.facts.profession} with ${sec.facts.years} ${one ? "year" : "years"} of verified experience in ${sec.facts.skills.join(", ")}.` : `${sec.facts.profession} avec ${sec.facts.years} ${one ? "an" : "ans"} d'expérience vérifiée en ${sec.facts.skills.join(", ")}.`;
        assert.equal(sec.text, want);
      } else {
        strings(sec.items).forEach(check);
      }
    }
    assert.deepEqual(bad, [], `iteration ${i}: strings not in the profile`);
    for (const k of m.missing) assert.match(k, MISSING_RE);
    const json = JSON.stringify(m);
    for (const n of FORBIDDEN_NEEDLES) assert.ok(!json.includes(n), `iteration ${i}: ${n}`);
    // a refusal exactly when the minimum is not met
    const hasName = Boolean(profile.name && profile.name.trim());
    const hasBody = m.sections.some((s) => s.id === "experience" || s.id === "education");
    assert.equal(Boolean(m.refusal), !(hasName && hasBody), `iteration ${i}: refusal`);
  }
});

test("file names: canonical pattern, FR suffix, injection-proof sanitiser", () => {
  assert.equal(gen.canonicalName("CAN-2026-0001", 2, "en", "pdf"), "CAN-2026-0001-CV-V2.pdf");
  assert.equal(gen.canonicalName("CAN-2026-0001", 2, "fr", "pdf"), "CAN-2026-0001-CV-V2-FR.pdf");
  assert.equal(gen.canonicalName("CAN-2026-10000", 1, "en", "docx"), "CAN-2026-10000-CV-V1.docx");
  for (const evil of ['CAN-2026-0001"\r\nSet-Cookie: x=1', "CAN-2026-0001/../../etc", "../CAN-2026-0001", "CAN-2026-0001\n", "can-2026-0001", "CAN-2026-1", "", null, undefined, 5, "CAN-2026-0001; filename=evil.exe"]) {
    assert.throws(() => gen.canonicalName(evil, 1, "en", "pdf"), /invalid candidate reference/, String(evil));
  }
  assert.throws(() => gen.canonicalName("CAN-2026-0001", 0, "en", "pdf"), /version/);
  assert.throws(() => gen.canonicalName("CAN-2026-0001", 1.5, "en", "pdf"), /version/);
  assert.throws(() => gen.canonicalName("CAN-2026-0001", 1, "ar", "pdf"), /language/);
  assert.throws(() => gen.canonicalName("CAN-2026-0001", 1, "en", "exe"), /format/);
  // the header value comes from safeDownloadName: anything not matching the pattern is replaced by a fixed fallback
  assert.equal(gen.safeDownloadName("CAN-2026-0001-CV-V3-FR.docx", { version: 3, format: "docx" }), "CAN-2026-0001-CV-V3-FR.docx");
  for (const evil of ['x"\r\nX-Evil: 1', "CAN-2026-0001-CV-V1.pdf\r\nX: y", "CAN-2026-0001-CV-V1.pdf\"; filename*=utf-8''evil", "../../a.pdf", "", null]) {
    const out = gen.safeDownloadName(evil, { version: 4, format: "pdf" });
    assert.equal(out, "cv-v4.pdf");
    assert.ok(!/[\r\n";\\/]/.test(out));
  }
  assert.equal(gen.safeDownloadName("evil", { version: "7; x", format: "../" }), "cv-v0.bin");
});

// ---------------------------------------------------------------- pure: renderers

test("PDF: A4, selectable text with the confirmed facts, no forbidden fields", async () => {
  const m = gen.buildCvModel({ ...PROFILE, ...FORBIDDEN }, { city: "Sfax", country: "Tunisia" }, { now: NOW });
  const pdf = await gen.renderPdf(m);
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.equal(storage.sniffMime(pdf), "application/pdf");
  assert.match(pdf.toString("latin1"), /\/MediaBox \[0 0 595\.28 841\.89\]/, "A4");
  const t = await pdfText(pdf);
  for (const s of ["Karim Benali", "Sfax, Tunisia", "karim.benali@example.com", "+216 22 345 678", "Professional Summary", "Professional Experience", "Senior Electrician", "Gulf Build LLC", "2019 – Present", "Sfax Industries", "2015 – 2019", "Skills", "Education and Training", "Higher Diploma in Electrical Engineering, University of Sfax, 2014", "Certifications and Licences", "Electrical Safety Certificate", "Languages", "Arabic (Native)", "French (Fluent)", "English (B2)", "Electrical Technician with 10 years of verified experience"]) {
    assert.ok(t.includes(s), `PDF text lacks "${s}"`);
  }
  assert.ok(t.indexOf("Senior Electrician") < t.indexOf("Sfax Industries"), "reverse chronological order");
  for (const n of FORBIDDEN_NEEDLES) assert.ok(!t.includes(n), `PDF text contains ${n}`);
  assert.ok(!/\/Subtype\s*\/Image/.test(pdf.toString("latin1")), "no image (no photo)");
  const fr = await pdfText(await gen.renderPdf(gen.buildCvModel(PROFILE, {}, { lang: "fr", now: NOW })));
  for (const s of ["Résumé professionnel", "Expérience professionnelle", "Compétences", "Formation", "Langues"]) assert.ok(fr.includes(s), s);
});

test("PDF: accents and typographic punctuation (WinAnsi) render; a very long name wraps instead of failing", async () => {
  const m = gen.buildCvModel({ name: "Élodie Núñez-Ærø “Jr.” ".repeat(6).trim(), experience: [{ title: "Technicien d’installation – niveau 2 • €", employer: "Société Générale", start: "2020", end: "2021" }] }, {}, { now: NOW });
  assert.deepEqual(m.missing.filter((k) => k.startsWith("latin_spelling_needed")), []);
  const t = await pdfText(await gen.renderPdf(m));
  assert.ok(t.includes("Élodie Núñez-Ærø"));
  assert.ok(t.includes("Société Générale"));
  const long = gen.buildCvModel({ name: "A".repeat(300), education: ["B".repeat(400)] }, {}, { now: NOW });
  const t2 = (await pdfText(await gen.renderPdf(long))).replace(/[\s-]/g, "");
  assert.ok(t2.includes("A".repeat(300)) && t2.includes("B".repeat(400)));
});

test("PDF: non-Latin text is flagged latin_spelling_needed and PDF generation is refused (no silent drop); DOCX handles it", async () => {
  const arabic = { name: "كريم بن علي", email: "k@example.com", experience: [{ title: "كهربائي", employer: "Gulf Build", start: "2019", end: "2020" }], skills: ["PLC"], education: [] };
  const m = gen.buildCvModel(arabic, { city: "صفاقس" }, { now: NOW });
  assert.equal(m.refusal, undefined);
  for (const k of ["name", "contact.city", "experience[0].title"]) assert.ok(m.missing.includes(`latin_spelling_needed:${k}`), k);
  await assert.rejects(gen.renderPdf(m), (e) => e.code === "LATIN_SPELLING_NEEDED" && e.fields.includes("name") && /Latin-script spelling/.test(e.message));
  const docx = await gen.renderDocx(m);
  const xml = docxXml(docx);
  assert.ok(xml.includes("كريم بن علي") && xml.includes("كهربائي") && xml.includes("صفاقس"));
  assert.ok(/<w:rtl\/>|<w:rtl /.test(xml) && /<w:bidi/.test(xml), "right-to-left runs and paragraphs");
  // one CJK / emoji character is enough
  assert.ok(gen.buildCvModel({ name: "Li 李", education: ["BSc"] }, {}, { now: NOW }).missing.includes("latin_spelling_needed:name"));
  assert.ok(!gen.buildCvModel({ name: "Zoë Åström", education: ["BSc"] }, {}, { now: NOW }).missing.some((k) => k.startsWith("latin_spelling_needed")));
});

test("DOCX: headings, bullet lists, confirmed facts only, no forbidden fields", async () => {
  const m = gen.buildCvModel({ ...PROFILE, ...FORBIDDEN }, { city: "Sfax", country: "Tunisia" }, { now: NOW });
  const docx = await gen.renderDocx(m);
  assert.equal(storage.sniffMime(docx), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const xml = docxXml(docx);
  assert.ok(/w:pStyle w:val="Heading1"/.test(xml) && /w:pStyle w:val="Title"/.test(xml), "real heading styles");
  assert.ok(/<w:numPr>/.test(xml), "bullet lists");
  assert.ok(!/<w:drawing|<pic:pic/.test(xml), "no image");
  const t = docxText(docx);
  for (const s of ["Karim Benali", "Sfax, Tunisia  |  karim.benali@example.com  |  +216 22 345 678", "Professional Summary", "Professional Experience", "Senior Electrician", "Gulf Build LLC  |  2019 – Present", "Skills", "PLC programming", "Education and Training", "Certifications and Licences", "Languages", "Arabic (Native)", "Electrical Technician with 10 years of verified experience"]) {
    assert.ok(t.includes(s), `DOCX text lacks "${s}"`);
  }
  assert.ok(t.indexOf("Senior Electrician") < t.indexOf("Electrician\nSfax Industries"));
  for (const n of FORBIDDEN_NEEDLES) assert.ok(!t.includes(n) && !docxXml(docx).includes(n), `DOCX contains ${n}`);
  for (const f of ["docProps/core.xml", "docProps/app.xml"]) {
    const meta = zipEntry(docx, f);
    if (meta) assert.ok(!meta.toString("utf8").includes("Karim"), `${f} must not carry the name`);
  }
  assert.ok(docxText(await gen.renderDocx(gen.buildCvModel(PROFILE, {}, { lang: "fr", now: NOW }))).includes("Expérience professionnelle"));
});

// ---------------------------------------------------------------- HTTP world

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
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString("utf8")); } catch { json = null; }
    return { status: r.status, body: json, buf, headers: r.headers, text: buf.toString("utf8") };
  };
  const mkUser = async (email, role) => (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [email, email, role])).rows[0].id;
  const sign = (id, role, tv = 0) => jwt.sign({ id, role, tv }, process.env.JWT_SECRET, { expiresIn: "1h" });
  try {
    const u = {};
    const tok = {};
    for (const [k, role] of [["admin", "Admin"], ["mgrA", "Manager"], ["mgrB", "Manager"], ["recA", "Receptionist"], ["recB", "Receptionist"], ["agentA", "Agent"], ["agentB", "Agent"], ["hr", "HR"], ["acct", "Accountant"]]) {
      u[k] = await mkUser(`${k}@ccv.test.invalid`, role);
      tok[k] = sign(u[k], role);
    }
    let n = 0;
    const newCandidate = async ({ assignedTo = u.agentA, profile = PROFILE, confirmed = true, consent = { search: true, prepare: true, submit: true }, city = "Sfax", residence = "Tunisia" } = {}) => {
      n += 1;
      const cid = (await pool.query("INSERT INTO candidates (full_name, passport_number, assigned_to, city) VALUES ($1,$2,$3,$4) RETURNING id", [`Cand ${n}`, `PP-CCV-${n}`, assignedTo, city])).rows[0].id;
      const r = await call("POST", "/jobsearch/admin/candidate-accounts", { token: tok.admin, body: { candidate_id: cid, email: `cand${n}@ccv.test.invalid` } });
      assert.equal(r.status, 201, r.text);
      const tv = (await pool.query("SELECT token_version FROM users WHERE id=$1", [r.body.user_id])).rows[0].token_version;
      const token = sign(r.body.user_id, "Candidate", tv);
      await pool.query("INSERT INTO js_profiles (candidate_id, confirmed, status, confirmed_at) VALUES ($1,$2::jsonb,$3,CASE WHEN $3='confirmed' THEN now() END)", [cid, JSON.stringify(profile), confirmed ? "confirmed" : "extracted"]);
      await pool.query("INSERT INTO js_preferences (candidate_id, countries, categories, availability, salary_min, salary_currency, residence_country, needs_work_auth_support) VALUES ($1,'{Canada}','{Electrician}','now',1000,'USD',$2,false)", [cid, residence]);
      await pool.query("INSERT INTO js_candidate_settings (candidate_id, mode) VALUES ($1,'prepare_for_approval')", [cid]);
      if (consent) assert.equal((await call("POST", `/jobsearch/candidates/${cid}/consent`, { token, body: { scope: { ...consent, countries: [] }, version: "v1" } })).status, 201);
      const reference = (await pool.query("SELECT reference FROM candidates WHERE id=$1", [cid])).rows[0].reference;
      return { id: cid, userId: r.body.user_id, token, reference };
    };
    const generate = (c, token = tok.admin, body = {}) => call("POST", `/jobsearch/candidates/${c.id}/canadian-cv`, { token, body });
    const list = (c, token = tok.admin) => call("GET", `/jobsearch/candidates/${c.id}/canadian-cv`, { token });
    const staffApprove = (c, v, token = tok.admin, lang) => call("POST", `/jobsearch/candidates/${c.id}/canadian-cv/${v}/approve${lang ? `?lang=${lang}` : ""}`, { token });
    const authorise = (c, v, lang) => call("POST", `/jobsearch/me/canadian-cv/${v}/authorise${lang ? `?lang=${lang}` : ""}`, { token: c.token });
    const withdraw = (c, v, lang) => call("POST", `/jobsearch/me/canadian-cv/${v}/withdraw-authorisation${lang ? `?lang=${lang}` : ""}`, { token: c.token });
    /** generate + staff approve + candidate authorise (version 1 unless more exist). */
    const readyCv = async (c, opts = {}) => {
      const g = await generate(c, tok.admin, opts);
      assert.equal(g.status, 201, g.text);
      const q = opts.lang === "fr" ? "fr" : undefined;
      assert.equal((await staffApprove(c, g.body.version, tok.admin, q)).status, 200);
      assert.equal((await authorise(c, g.body.version, q)).status, 200);
      return g.body;
    };
    const uploadCv = async (c, text = "Karim Benali\nElectrician") => {
      const form = new FormData();
      form.append("file", new Blob([makePdf(text)], { type: "application/pdf" }), "cv.pdf");
      const up = await call("POST", `/jobsearch/candidates/${c.id}/cv`, { token: c.token, form });
      assert.equal(up.status, 201, up.text);
      await pool.query("UPDATE js_profiles SET status='confirmed' WHERE candidate_id=$1", [c.id]);
      const ap = await call("POST", `/jobsearch/cv-files/${up.body.cvFileId}/approve`, { token: c.token, body: { language: "en" } });
      assert.equal(ap.status, 200, ap.text);
      return up.body.cvFileId;
    };
    const newJob = async (c, { employer, text = "We are hiring an Electrician for our plant. You will maintain equipment." } = {}) => {
      n += 1;
      const eid = (await pool.query("INSERT INTO js_employers (name, normalized_name) VALUES ($1,$2) RETURNING id", [employer || `Emp ${n}`, `emp ${n}`])).rows[0].id;
      const jobId = (await pool.query("INSERT INTO js_jobs (title, country, location, employer_id, source_primary, dedupe_key, description_text, url) VALUES ('Electrician','Canada','Toronto, Canada',$1,'partner_feed',$2,$3,'https://jobs.example/1') RETURNING id", [eid, `dk-ccv-${n}`, text])).rows[0].id;
      const matchId = (await pool.query("INSERT INTO js_matches (candidate_id, job_id, score, employer_support, overseas_accepted) VALUES ($1,$2,80,'unknown',NULL) RETURNING id", [c.id, jobId])).rows[0].id;
      return { jobId, matchId };
    };
    const preparedRaw = async (c, body = {}, jobOpts) => {
      const j = await newJob(c, jobOpts);
      const a = await call("POST", "/jobsearch/applications", { token: c.token, body: { matchId: j.matchId } });
      assert.equal(a.status, 201, a.text);
      const p = await call("POST", `/jobsearch/applications/${a.body.application.id}/prepare`, { token: tok.agentA, body });
      return { appId: a.body.application.id, res: p };
    };
    const prepared = async (c, body = {}, jobOpts) => {
      const x = await preparedRaw(c, body, jobOpts);
      assert.equal(x.res.status, 200, x.res.text);
      return { appId: x.appId, prep: x.res.body };
    };
    await fn({ pool, call, u, tok, sign, newCandidate, generate, list, staffApprove, authorise, withdraw, readyCv, uploadCv, newJob, prepared, preparedRaw });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
  }
}

const rows = async (t, cid, where = "") => (await t.pool.query(`SELECT * FROM js_cv_files WHERE candidate_id=$1 AND kind='canadian' ${where} ORDER BY language, version, format`, [cid])).rows;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- HTTP: generation, versions, integrity

test("generate: PDF + DOCX stored as draft canadian rows named <reference>-CV-V<n>; hashes equal the stored bytes; audit + event rows", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    assert.match(c.reference, /^CAN-\d{4}-\d{4,}$/);
    const g = await t.generate(c, t.tok.agentA);
    assert.equal(g.status, 201, g.text);
    assert.equal(g.body.version, 1);
    assert.equal(g.body.lang, "en");
    assert.deepEqual(g.body.files.map((f) => f.name).sort(), [`${c.reference}-CV-V1.docx`, `${c.reference}-CV-V1.pdf`]);
    const rs = await rows(t, c.id);
    assert.equal(rs.length, 2);
    for (const r of rs) {
      assert.equal(r.kind, "canadian");
      assert.equal(r.approved, false);
      assert.equal(r.staff_approved_at, null);
      assert.equal(r.candidate_authorised_at, null);
      assert.equal(r.generated_by, t.u.agentA);
      assert.equal(r.language, "en");
      assert.equal(r.scan_status, "clean");
      assert.equal(r.canonical_name, `${c.reference}-CV-V1.${r.format}`);
      const bytes = await storage.get(r.storage_key);
      assert.equal(sha(bytes), r.sha256, "stored hash equals the stored bytes");
      assert.equal(r.source_profile_hash, gen.profileHash(PROFILE));
      assert.deepEqual(r.missing, []);
    }
    // the text in the stored files is the confirmed profile (city / country come from the candidate record and preferences)
    const pdf = await pdfText(await storage.get(rs.find((r) => r.format === "pdf").storage_key));
    assert.ok(pdf.includes("Sfax, Tunisia") && pdf.includes("Karim Benali"));
    // audit trail: one audit_logs + one js_audit_events row, no CV text inside
    const audit = (await t.pool.query("SELECT * FROM js_audit_events WHERE action='canadian_cv.generate' AND candidate_id=$1", [c.id])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor, `user:${t.u.agentA}`);
    assert.equal(audit[0].detail.version, 1);
    assert.ok(!JSON.stringify(audit[0].detail).includes("Karim"));
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM audit_logs WHERE action='jobsearch.canadian_cv.generate' AND user_id=$1", [t.u.agentA])).rows[0].n, 1);
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_events WHERE kind='canadian_cv.generated' AND candidate_id=$1", [c.id])).rows[0].n, 1);
    // the original upload numbering is independent of canadian versions
    const cvId = await t.uploadCv(c);
    assert.equal((await t.pool.query("SELECT version FROM js_cv_files WHERE id=$1", [cvId])).rows[0].version, 1);
    const prof = await t.call("GET", `/jobsearch/candidates/${c.id}/profile`, { token: t.tok.agentA });
    assert.deepEqual(prof.body.cv_files.map((f) => f.id), [cvId], "the originals list does not mix in generated CVs");
  });
});

test("generate again: a NEW version, nothing overwritten; French variant gets -FR and its own numbering; format subset", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    const cvId = await t.uploadCv(c);
    const origBefore = (await t.pool.query("SELECT * FROM js_cv_files WHERE id=$1", [cvId])).rows[0];
    const v1 = await t.generate(c);
    const v1Rows = await rows(t, c.id);
    const v2 = await t.generate(c);
    assert.equal(v2.body.version, 2);
    assert.deepEqual(v2.body.files.map((f) => f.name).sort(), [`${c.reference}-CV-V2.docx`, `${c.reference}-CV-V2.pdf`]);
    const after = await rows(t, c.id, "AND version=1");
    assert.deepEqual(after.map((r) => [r.id, r.storage_key, r.sha256, r.canonical_name]), v1Rows.map((r) => [r.id, r.storage_key, r.sha256, r.canonical_name]), "V1 untouched");
    const origAfter = (await t.pool.query("SELECT * FROM js_cv_files WHERE id=$1", [cvId])).rows[0];
    assert.deepEqual(origAfter, origBefore, "the uploaded original is untouched");
    for (const r of v1Rows) assert.ok(await storage.get(r.storage_key), "V1 bytes still stored");

    const fr1 = await t.generate(c, t.tok.admin, { lang: "fr" });
    assert.equal(fr1.body.version, 1);
    assert.deepEqual(fr1.body.files.map((f) => f.name).sort(), [`${c.reference}-CV-V1-FR.docx`, `${c.reference}-CV-V1-FR.pdf`]);
    const fr2 = await t.generate(c, t.tok.admin, { lang: "fr", formats: ["pdf"] });
    assert.equal(fr2.body.version, 2);
    assert.deepEqual(fr2.body.files.map((f) => f.name), [`${c.reference}-CV-V2-FR.pdf`]);
    const frPdf = await pdfText(await storage.get((await rows(t, c.id, "AND language='fr' AND version=1 AND format='pdf'"))[0].storage_key));
    assert.ok(frPdf.includes("Expérience professionnelle") && frPdf.includes("Senior Electrician"));
    const en3 = await t.generate(c);
    assert.equal(en3.body.version, 3, "English numbering is not affected by the French versions");
    // concurrent generation: distinct consecutive versions
    const par = await Promise.all([t.generate(c), t.generate(c), t.generate(c)]);
    assert.deepEqual(par.map((r) => r.status), [201, 201, 201]);
    assert.deepEqual(par.map((r) => r.body.version).sort(), [4, 5, 6]);
    assert.equal((await t.generate(c, t.tok.admin, { lang: "de" })).status, 400);
    assert.equal((await t.generate(c, t.tok.admin, { formats: ["pdf", "exe"] })).status, 400);
    assert.equal((await t.generate(c, t.tok.admin, { formats: [] })).status, 400);
  });
});

test("generate: unconfirmed profile 409; minimum not met 422; non-Latin name refuses the PDF only; missing flags are recorded", async () => {
  await withApp(async (t) => {
    const unconfirmed = await t.newCandidate({ confirmed: false });
    assert.equal((await t.generate(unconfirmed)).status, 409);
    const noName = await t.newCandidate({ profile: { ...PROFILE, name: null } });
    const r1 = await t.generate(noName);
    assert.equal(r1.status, 422);
    assert.match(r1.body.error, /name/);
    const bare = await t.newCandidate({ profile: { name: "Only Name", skills: ["PLC"] } });
    const r2 = await t.generate(bare);
    assert.equal(r2.status, 422);
    assert.match(r2.body.error, /experience or education/);
    assert.equal((await rows(t, noName.id)).length + (await rows(t, bare.id)).length + (await rows(t, unconfirmed.id)).length, 0, "nothing stored on refusal");

    const arabic = await t.newCandidate({ profile: { name: "كريم بن علي", education: ["BSc"], experience: [{ title: "Electrician", employer: "Acme", start: "2019", end: null }] } });
    const pdf = await t.generate(arabic);
    assert.equal(pdf.status, 422);
    assert.match(pdf.body.error, /Latin-script spelling/);
    assert.equal((await rows(t, arabic.id)).length, 0);
    const docx = await t.generate(arabic, t.tok.admin, { formats: ["docx"] });
    assert.equal(docx.status, 201, docx.text);
    assert.deepEqual(docx.body.files.map((f) => f.format), ["docx"]);
    assert.ok(docx.body.missing.includes("latin_spelling_needed:name"));
    assert.ok(docxText(await storage.get((await rows(t, arabic.id))[0].storage_key)).includes("كريم بن علي"));
    const listed = (await t.list(arabic)).body.versions[0];
    assert.ok(listed.missing.includes("latin_spelling_needed:name") && listed.missing.includes("professional_summary"));

    // missing flags are stored with the version and shown to staff
    const sparse = await t.newCandidate({ profile: { name: "Sparse P", experience: [{ title: "Welder", employer: "ACME" }] }, city: null, residence: "Tunisia" });
    const g = await t.generate(sparse);
    assert.equal(g.status, 201);
    for (const k of ["dates:experience[0]", "professional_summary", "skills", "education", "certifications", "languages", "contact.email", "contact.phone"]) assert.ok(g.body.missing.includes(k), k);
    assert.ok(!g.body.missing.includes("contact.location"), "country from the preferences counts as location");
  });
});

test("list: versions, status and missing flags for staff; no storage keys; candidates see only staff-approved versions and no hashes", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    await t.generate(c);
    await t.generate(c);
    const l = await t.list(c, t.tok.agentA);
    assert.equal(l.status, 200);
    assert.deepEqual(l.body.versions.map((v) => [v.version, v.lang, v.status]), [[2, "en", "draft"], [1, "en", "draft"]]);
    assert.deepEqual(l.body.versions[0].files.map((f) => f.format).sort(), ["docx", "pdf"]);
    const keys = (await rows(t, c.id)).map((r) => r.storage_key);
    for (const k of keys) assert.ok(!l.text.includes(k), "storage key leaked");
    assert.ok(!/storage_key|"key"/.test(l.text) && !/[0-9]+-[a-f0-9]{64}\./.test(l.text));
    assert.ok(l.body.versions[0].files[0].sha256, "staff see integrity hashes");
    const own = await t.call("GET", "/jobsearch/me/canadian-cv", { token: c.token });
    assert.equal(own.status, 200);
    assert.deepEqual(own.body.versions, [], "drafts are invisible to the candidate");
    await t.staffApprove(c, 1);
    const own2 = await t.call("GET", "/jobsearch/me/canadian-cv", { token: c.token });
    assert.deepEqual(own2.body.versions.map((v) => [v.version, v.status]), [[1, "staff_approved"]]);
    assert.ok(!own2.text.includes("sha256") && !own2.text.includes("generated_by") && !own2.text.includes("staff_approved_by"));
    for (const k of keys) assert.ok(!own2.text.includes(k));
  });
});

test("stored files are immutable (identity and content columns), approval columns are not", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    await t.generate(c);
    const r = (await rows(t, c.id))[0];
    for (const [col, val] of [["storage_key", "9-" + "a".repeat(64) + ".pdf"], ["sha256", "b".repeat(64)], ["version", 9], ["language", "fr"], ["canonical_name", "CAN-2026-0001-CV-V9.pdf"], ["missing", '["x"]'], ["kind", "upload"], ["format", r.format === "docx" ? "pdf" : "docx"]]) {
      await assert.rejects(t.pool.query(`UPDATE js_cv_files SET ${col} = $2 WHERE id=$1`, [r.id, val]), /./, col);
    }
    await t.pool.query("UPDATE js_cv_files SET approved = true, staff_approved_by=$2, staff_approved_at=now() WHERE id=$1", [r.id, t.u.mgrA]);
    // authorising a row that staff have not approved is refused by the database as well
    const other = (await rows(t, c.id))[1];
    await assert.rejects(t.pool.query("UPDATE js_cv_files SET candidate_authorised_at = now() WHERE id=$1", [other.id]), /js_cv_files_authorised_after_approval/);
    // shape check: a canadian row needs a canonical name in the pattern
    await assert.rejects(
      t.pool.query("INSERT INTO js_cv_files (candidate_id, storage_key, sha256, version, language, kind, format, canonical_name, source_profile_hash) VALUES ($1,'k','h',7,'en','canadian','pdf','evil\"\r\n.pdf','x')", [c.id]),
      /js_cv_files_canadian_shape/
    );
    await assert.rejects(t.pool.query("INSERT INTO js_cv_files (candidate_id, storage_key, sha256, version, language, kind, format, canonical_name, source_profile_hash, approved) SELECT candidate_id, 'k2', 'h', version, language, kind, format, 'CAN-2026-0001-CV-V1.pdf', 'x', false FROM js_cv_files WHERE id=$1", [r.id]), /js_cv_files_canadian_version_uniq/);
  });
});

// ---------------------------------------------------------------- HTTP: approval gates

test("approval gates: Agent / Receptionist cannot staff-approve; Manager approves the PDF and DOCX together; candidate cannot authorise first; one-shot idempotent", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate({ assignedTo: t.u.mgrA });
    const g = await t.generate(c, t.tok.mgrA);
    assert.equal(g.status, 201);
    const pdfId = g.body.files.find((f) => f.format === "pdf").id;
    // before staff approval the candidate can neither authorise nor download
    assert.equal((await t.authorise(c, 1)).status, 409);
    assert.equal((await t.call("GET", "/jobsearch/me/canadian-cv/1/download?format=pdf", { token: c.token })).status, 404);
    // staff without jobsearch:approve are refused (403), also by file id
    const agentC = await t.newCandidate({ assignedTo: t.u.agentA });
    await t.generate(agentC, t.tok.agentA);
    const rec = await t.newCandidate({ assignedTo: t.u.recA });
    await t.generate(rec, t.tok.recA);
    assert.equal((await t.staffApprove(agentC, 1, t.tok.agentA)).status, 403);
    assert.equal((await t.staffApprove(rec, 1, t.tok.recA)).status, 403);
    const agentFile = (await rows(t, agentC.id))[0].id;
    assert.equal((await t.call("POST", `/jobsearch/cv-files/${agentFile}/staff-approve`, { token: t.tok.agentA })).status, 403);
    // a candidate cannot staff-approve, nor use the generic uploaded-CV approval for a generated file
    assert.equal((await t.call("POST", `/jobsearch/candidates/${c.id}/canadian-cv/1/approve`, { token: c.token })).status, 403);
    assert.equal((await t.call("POST", `/jobsearch/cv-files/${pdfId}/staff-approve`, { token: c.token })).status, 403);
    const generic = await t.call("POST", `/jobsearch/cv-files/${pdfId}/approve`, { token: c.token, body: { language: "en" } });
    assert.equal(generic.status, 409);
    assert.equal((await rows(t, c.id)).every((r) => !r.approved), true);
    // a manager outside scope: 404; unknown version / file: 404
    assert.equal((await t.staffApprove(c, 1, t.tok.mgrB)).status, 404);
    assert.equal((await t.staffApprove(c, 9, t.tok.mgrA)).status, 404);
    assert.equal((await t.call("POST", "/jobsearch/cv-files/999999/staff-approve", { token: t.tok.mgrA })).status, 404);
    assert.equal((await t.staffApprove(c, 1, t.tok.mgrA, "de")).status, 400);

    const ok = await t.staffApprove(c, 1, t.tok.mgrA);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.status, "staff_approved");
    assert.equal(ok.body.files.length, 2);
    const rs = await rows(t, c.id);
    assert.ok(rs.every((r) => r.approved && r.staff_approved_by === t.u.mgrA && r.staff_approved_at && !r.candidate_authorised_at), "both formats approved together");
    const again = await t.staffApprove(c, 1, t.tok.mgrA);
    assert.equal(again.body.changed, false);
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_audit_events WHERE action='canadian_cv.staff_approve' AND candidate_id=$1", [c.id])).rows[0].n, 1);

    const au = await t.authorise(c, 1);
    assert.equal(au.status, 200, au.text);
    assert.equal(au.body.status, "authorised");
    const a1 = (await rows(t, c.id))[0];
    assert.equal(a1.candidate_authorised_by, c.userId);
    assert.ok(a1.candidate_authorised_at);
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_audit_events WHERE action='canadian_cv.authorise' AND candidate_id=$1", [c.id])).rows[0].n, 1);
    // approve by file id for a second version
    const g2 = await t.generate(c, t.tok.mgrA);
    const f2 = g2.body.files[0].id;
    assert.equal((await t.call("POST", `/jobsearch/cv-files/${f2}/staff-approve`, { token: t.tok.admin })).status, 200);
    assert.ok((await rows(t, c.id, "AND version=2")).every((r) => r.staff_approved_at), "the whole version is approved via any of its files");
    // an Admin may approve any candidate; audit rows carry the actor
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_audit_events WHERE action='canadian_cv.staff_approve' AND actor=$1", [`user:${t.u.admin}`])).rows[0].n, 1);
  });
});

test("authorisation: another candidate gets 404, staff get 403 on the candidate routes; re-authorising after a profile change is refused", async () => {
  await withApp(async (t) => {
    const a = await t.newCandidate();
    const b = await t.newCandidate();
    await t.generate(a);
    await t.staffApprove(a, 1);
    assert.equal((await t.authorise(b, 1)).status, 404, "candidate B has no version 1");
    assert.equal((await t.withdraw(b, 1)).status, 404);
    assert.equal((await t.call("GET", "/jobsearch/me/canadian-cv/1/download?format=pdf", { token: b.token })).status, 404);
    assert.deepEqual((await t.call("GET", "/jobsearch/me/canadian-cv", { token: b.token })).body.versions, []);
    for (const tk of [t.tok.admin, t.tok.mgrA, t.tok.agentA]) {
      assert.equal((await t.call("POST", "/jobsearch/me/canadian-cv/1/authorise", { token: tk })).status, 403);
      assert.equal((await t.call("GET", "/jobsearch/me/canadian-cv", { token: tk })).status, 403);
    }
    assert.equal((await rows(t, a.id)).every((r) => !r.candidate_authorised_at), true);
    // the profile is re-confirmed with different content after approval: the old version cannot be authorised
    await t.pool.query("UPDATE js_profiles SET confirmed = jsonb_set(confirmed, '{skills}', '[\"Something new\"]') WHERE candidate_id=$1", [a.id]);
    const stale = await t.authorise(a, 1);
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /changed/);
    assert.equal((await t.list(a)).body.versions[0].stale, true);
    // staff cannot approve a stale version either
    const s2 = await t.newCandidate();
    await t.generate(s2);
    await t.pool.query("UPDATE js_profiles SET confirmed = jsonb_set(confirmed, '{skills}', '[]') WHERE candidate_id=$1", [s2.id]);
    assert.equal((await t.staffApprove(s2, 1)).status, 409);
  });
});

// ---------------------------------------------------------------- HTTP: scope matrix and downloads

test("scope matrix: Admin all; Manager / Receptionist / Agent assigned only; HR / Accountant / Employer / Agency denied; candidate own only", async () => {
  await withApp(async (t) => {
    const owners = { Manager: ["mgrA", "mgrB"], Receptionist: ["recA", "recB"], Agent: ["agentA", "agentB"] };
    const emp = await createEmployerUser(t.pool);
    const agy = await createAgencyUser(t.pool);
    for (const [role, [mine, other]] of Object.entries(owners)) {
      const c = await t.newCandidate({ assignedTo: t.u[mine] });
      const g = await t.generate(c, t.tok[mine]);
      assert.equal(g.status, 201, `${role} generates for an assigned candidate`);
      assert.equal((await t.list(c, t.tok[mine])).status, 200, role);
      assert.equal((await t.call("GET", `/jobsearch/candidates/${c.id}/canadian-cv/1/download?format=pdf`, { token: t.tok[mine] })).status, 200, role);
      // another user with the same role, not assigned
      assert.equal((await t.generate(c, t.tok[other])).status, 404, `${role} not assigned: generate`);
      assert.equal((await t.list(c, t.tok[other])).status, 404, `${role} not assigned: list`);
      assert.equal((await t.call("GET", `/jobsearch/candidates/${c.id}/canadian-cv/1/download?format=pdf`, { token: t.tok[other] })).status, 404, `${role} not assigned: download`);
      assert.equal((await t.staffApprove(c, 1, t.tok[other])).status, 404);
      assert.equal((await t.generate(c, t.tok.admin)).status, 201, "Admin sees everything");
      assert.equal((await t.list(c, t.tok.admin)).status, 200);
    }
    const c = await t.newCandidate({ assignedTo: t.u.hr });
    for (const tk of [t.tok.hr, t.tok.acct, emp.token, agy.token]) {
      assert.ok([401, 403, 404].includes((await t.generate(c, tk)).status));
      assert.ok([401, 403, 404].includes((await t.list(c, tk)).status));
      assert.ok([401, 403, 404].includes((await t.call("GET", `/jobsearch/candidates/${c.id}/canadian-cv/1/download?format=pdf`, { token: tk })).status));
      assert.ok([401, 403, 404].includes((await t.staffApprove(c, 1, tk)).status));
      assert.ok([401, 403, 404].includes((await t.call("GET", "/jobsearch/me/canadian-cv", { token: tk })).status));
    }
    assert.equal((await t.generate(c, null)).status, 401);
    assert.equal((await rows(t, c.id)).length, 0, "denied callers created nothing");
    // a candidate cannot generate or list through the staff routes, for itself or anyone else
    const other = await t.newCandidate();
    for (const target of [c, other]) {
      assert.equal((await t.generate(target, other.token)).status, 403);
      assert.equal((await t.list(target, other.token)).status, 403);
    }
    // soft-deleted candidate is invisible
    await t.pool.query("UPDATE candidates SET is_deleted=true WHERE id=$1", [other.id]);
    assert.equal((await t.generate(other, t.tok.admin)).status, 404);
  });
});

test("download: bytes equal the stored file, headers built from the canonical name only, no-store; integrity failure is refused; audited", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    await t.generate(c, t.tok.agentA);
    const rs = await rows(t, c.id);
    for (const r of rs) {
      const d = await t.call("GET", `/jobsearch/candidates/${c.id}/canadian-cv/1/download?format=${r.format}`, { token: t.tok.agentA });
      assert.equal(d.status, 200);
      assert.equal(sha(d.buf), r.sha256);
      assert.equal(d.headers.get("content-disposition"), `attachment; filename="${c.reference}-CV-V1.${r.format}"`);
      assert.equal(d.headers.get("cache-control"), "private, no-store");
      assert.equal(d.headers.get("x-content-type-options"), "nosniff");
      assert.equal(d.headers.get("content-type"), r.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    }
    for (const q of ["format=exe", "format=", "", "format=pdf&format=docx", "format=../x"]) assert.equal((await t.call("GET", `/jobsearch/candidates/${c.id}/canadian-cv/1/download?${q}`, { token: t.tok.agentA })).status, 400, q);
    assert.equal((await t.call("GET", `/jobsearch/candidates/${c.id}/canadian-cv/2/download?format=pdf`, { token: t.tok.agentA })).status, 404);
    assert.equal((await t.call("GET", `/jobsearch/candidates/${c.id}/canadian-cv/abc/download?format=pdf`, { token: t.tok.agentA })).status, 404);
    assert.equal((await t.call("GET", `/jobsearch/candidates/${c.id}/canadian-cv/1/download?format=pdf&lang=fr`, { token: t.tok.agentA })).status, 404);
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_audit_events WHERE action='canadian_cv.download' AND candidate_id=$1", [c.id])).rows[0].n, 2);

    // the candidate downloads only after staff approval, and only their own files
    await t.staffApprove(c, 1);
    const own = await t.call("GET", "/jobsearch/me/canadian-cv/1/download?format=docx", { token: c.token });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("content-disposition"), `attachment; filename="${c.reference}-CV-V1.docx"`);
    assert.ok(docxText(own.buf).includes("Karim Benali"));

    // tampered bytes in storage are detected
    const pdfRow = rs.find((r) => r.format === "pdf");
    fs.writeFileSync(path.join(process.env.STORAGE_DIR, pdfRow.storage_key), Buffer.concat([await storage.get(pdfRow.storage_key), Buffer.from("tamper")]));
    assert.equal((await t.call("GET", `/jobsearch/candidates/${c.id}/canadian-cv/1/download?format=pdf`, { token: t.tok.agentA })).status, 409);
    assert.equal((await t.call("GET", "/jobsearch/me/canadian-cv/1/download?format=pdf", { token: c.token })).status, 409);
  });
});

// ---------------------------------------------------------------- HTTP: applications

test("applications: with Canadian CVs only a staff-approved AND candidate-authorised version is attached (latest eligible, exact version recorded); otherwise the uploaded CV with a note", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    const orig = await t.uploadCv(c);
    const used = async (res) => {
      const inc = res.prep.package.included.filter((d) => d.kind === "cv");
      assert.equal(inc.length, 1);
      const row = (await t.pool.query("SELECT d.*, f.kind, f.format, f.canonical_name FROM js_application_documents d JOIN js_cv_files f ON f.id = d.cv_file_id WHERE d.application_id=$1 AND d.removed_at IS NULL", [res.appId])).rows;
      assert.equal(row.length, 1);
      assert.equal(row[0].cv_file_id, inc[0].cvFileId);
      return { ...row[0], notes: res.prep.package.notes };
    };
    // no canadian CV at all: unchanged behaviour
    const base = await used(await t.prepared(c));
    assert.equal(base.cv_file_id, orig);
    assert.equal(base.kind, "upload");
    assert.deepEqual(base.notes, []);

    await t.generate(c); // V1 draft
    // review round 1: once Canadian versions exist but none is eligible, preparation is BLOCKED - the uploaded original is no fallback
    const notEligible = async (label) => {
      const x = await t.preparedRaw(c);
      assert.equal(x.res.status, 409, `${label}: ${x.res.text}`);
      assert.equal(x.res.body.code, "canadian_cv_not_eligible", label);
      assert.equal((await t.pool.query("SELECT status FROM js_applications WHERE id=$1", [x.appId])).rows[0].status, "matched", `${label}: nothing prepared`);
      assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_application_documents WHERE application_id=$1", [x.appId])).rows[0].n, 0);
    };
    await notEligible("a draft is never attached");
    assert.equal((await t.staffApprove(c, 1)).status, 200);
    await notEligible("staff-approved but not authorised");
    // an explicitly requested uploaded original is refused as well
    const explicitOrig = await t.prepared(c, { documents: [{ cvFileId: orig }] });
    assert.ok(explicitOrig.prep.package.blocked.some((b) => b.reason === "canadian_cv_not_eligible"), JSON.stringify(explicitOrig.prep.package.blocked));
    assert.equal((await t.authorise(c, 1)).status, 200);
    let r = await used(await t.prepared(c));
    assert.equal(r.kind, "canadian");
    assert.equal(r.format, "pdf", "PDF preferred");
    assert.equal(r.version, 1);
    assert.equal(r.canonical_name, `${c.reference}-CV-V1.pdf`);
    assert.equal(r.source_ref, `canadian_cv:${c.reference}-CV-V1.pdf`);
    assert.equal(r.sha256, (await rows(t, c.id, "AND format='pdf' AND version=1"))[0].sha256);
    assert.deepEqual(r.notes.filter((n) => n.startsWith("canadian")), []);

    // explicit requests: the uploaded original is refused while an eligible Canadian CV exists; a draft is refused; an eligible one is accepted
    const g2 = await t.generate(c); // V2 draft
    const draftId = g2.body.files.find((f) => f.format === "pdf").id;
    const v1Docx = (await rows(t, c.id, "AND format='docx' AND version=1"))[0].id;
    for (const [docs, reason] of [[[{ cvFileId: orig }], "superseded_by_canadian_cv"], [[{ cvFileId: draftId }], "cv_not_approved"]]) {
      const x = await t.prepared(c, { documents: docs });
      assert.ok(x.prep.package.blocked.some((b) => b.reason === reason), JSON.stringify(x.prep.package.blocked));
      assert.equal(x.prep.application.status, "preparing");
    }
    const okExplicit = await t.prepared(c, { documents: [{ cvFileId: v1Docx }] });
    assert.equal(okExplicit.prep.package.blocked.length, 0);
    assert.equal(okExplicit.prep.application.status, "ready_for_review");
    // V2 unapproved: V1 (latest ELIGIBLE) is still the one attached
    r = await used(await t.prepared(c));
    assert.equal(r.version, 1);
    await t.staffApprove(c, 2);
    const unauth = await t.prepared(c, { documents: [{ cvFileId: draftId }] });
    assert.ok(unauth.prep.package.blocked.some((b) => b.reason === "canadian_cv_not_authorised"), JSON.stringify(unauth.prep.package.blocked));
    r = await used(await t.prepared(c));
    assert.equal(r.version, 1, "approved by staff but not authorised by the candidate");
    await t.authorise(c, 2);
    r = await used(await t.prepared(c));
    assert.equal(r.version, 2, "latest eligible version");
    assert.equal(r.canonical_name, `${c.reference}-CV-V2.pdf`);

    // French job -> the French version when it is eligible
    await t.readyCv(c, { lang: "fr" });
    r = await used(await t.prepared(c, { lang: "fr" }));
    assert.equal(r.canonical_name, `${c.reference}-CV-V1-FR.pdf`);
    r = await used(await t.prepared(c, { lang: "en" }));
    assert.equal(r.canonical_name, `${c.reference}-CV-V2.pdf`);

    // DOCX only version: attached when it is the only eligible format
    const d = await t.newCandidate();
    await t.uploadCv(d);
    await t.readyCv(d, { formats: ["docx"] });
    r = await used(await t.prepared(d));
    assert.equal(r.format, "docx");

    // the profile changes after authorisation: the generated CV no longer matches the confirmed facts -> not attached
    await t.pool.query("UPDATE js_profiles SET confirmed = jsonb_set(confirmed, '{profession}', '\"Plumber\"') WHERE candidate_id=$1", [d.id]);
    const stale = await t.preparedRaw(d);
    assert.equal(stale.res.status, 409, stale.res.text);
    assert.equal(stale.res.body.code, "canadian_cv_not_eligible");

    // a candidate with Canadian CVs but no eligible one and no uploaded CV: blocked as well
    const e = await t.newCandidate();
    await t.generate(e);
    const x = await t.preparedRaw(e);
    assert.equal(x.res.status, 409);
    assert.equal(x.res.body.code, "canadian_cv_not_eligible");
  });
});

test("withdrawing authorisation blocks use at once and cancels queued applications that use the version (others untouched)", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    await t.uploadCv(c);
    // prepared BEFORE any Canadian CV exists: uses the uploaded original; must survive the withdrawal
    const keep = await t.prepared(c);
    assert.equal((await t.call("POST", `/jobsearch/applications/${keep.appId}/approve`, { token: t.tok.admin, body: { reason: "ok" } })).status, 200);
    await t.readyCv(c);
    const mk = async () => {
      const x = await t.prepared(c);
      assert.equal(x.prep.package.included.find((d) => d.kind === "cv").version, 1);
      return x.appId;
    };
    const appr = await mk();
    const queued = await mk();
    const review = await mk();
    for (const id of [appr, queued]) assert.equal((await t.call("POST", `/jobsearch/applications/${id}/approve`, { token: t.tok.admin, body: { reason: "ok" } })).status, 200);
    await applicationService.transition(queued, "queued", "system:submitter", { [applicationService._internal.SYSTEM_GRANT]: true, reason: "test enqueue" });
    for (const id of [appr, queued, keep.appId]) await t.pool.query("INSERT INTO js_queue (kind, payload) VALUES ('submit', $1::jsonb)", [JSON.stringify({ applicationId: id })]);
    // another candidate with their own authorised CV is unaffected
    const o = await t.newCandidate();
    await t.uploadCv(o);
    await t.readyCv(o);
    const other = await t.prepared(o);
    await t.call("POST", `/jobsearch/applications/${other.appId}/approve`, { token: t.tok.admin, body: { reason: "ok" } });

    const w = await t.withdraw(c, 1);
    assert.equal(w.status, 200, w.text);
    assert.equal(w.body.status, "withdrawn");
    assert.equal(w.body.cancelledApplications, 2);
    const st = async (id) => (await t.pool.query("SELECT status FROM js_applications WHERE id=$1", [id])).rows[0].status;
    assert.equal(await st(appr), "cancelled");
    assert.equal(await st(queued), "cancelled");
    assert.equal(await st(keep.appId), "approved", "an application using the uploaded CV is untouched");
    assert.equal(await st(other.appId), "approved", "another candidate is untouched");
    assert.equal(await st(review), "ready_for_review", "not queued yet: it simply cannot be approved any more");
    const q = async (id) => (await t.pool.query("SELECT status FROM js_queue WHERE payload->>'applicationId'=$1", [String(id)])).rows[0].status;
    assert.equal(await q(appr), "cancelled");
    assert.equal(await q(queued), "cancelled");
    assert.equal(await q(keep.appId), "pending");
    const tl = (await t.pool.query("SELECT detail FROM js_timeline WHERE application_id=$1 AND event='cancelled'", [appr])).rows;
    assert.equal(tl.length, 1);
    assert.equal(tl[0].detail.reason, "canadian_cv_authorisation_withdrawn");
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM js_audit_events WHERE action='canadian_cv.withdraw_authorisation' AND candidate_id=$1", [c.id])).rows[0].n, 1);

    // use is blocked immediately: approval of the remaining package and any new package
    const blocked = await t.call("POST", `/jobsearch/applications/${review}/approve`, { token: t.tok.admin, body: { reason: "ok" } });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /canadian_cv_not_authorised/);
    const after = await t.preparedRaw(c);
    assert.equal(after.res.status, 409, "withdrawn: new preparation is blocked, the uploaded CV is not used instead");
    assert.equal(after.res.body.code, "canadian_cv_not_eligible");
    // idempotent withdrawal; the candidate may authorise the same version again
    assert.equal((await t.withdraw(c, 1)).body.changed, false);
    assert.equal((await t.list(c)).body.versions[0].status, "withdrawn");
    const re = await t.authorise(c, 1);
    assert.equal(re.status, 200);
    assert.equal(re.body.status, "authorised");
    assert.equal((await rows(t, c.id))[0].candidate_withdrawn_at, null);
    const again = await t.prepared(c);
    assert.equal(again.prep.package.included.find((d) => d.kind === "cv").version, 1);
    assert.equal((await t.pool.query("SELECT kind FROM js_cv_files WHERE id=$1", [again.prep.package.included.find((d) => d.kind === "cv").cvFileId])).rows[0].kind, "canadian");
  });
});

// ---------------------------------------------------------------- migration

test("026: idempotent re-run keeps rows; defaults keep existing uploads valid", async () => {
  await withApp(async (t) => {
    const c = await t.newCandidate();
    const cv = await t.uploadCv(c);
    await t.generate(c);
    const before = (await t.pool.query("SELECT * FROM js_cv_files ORDER BY id")).rows;
    await t.pool.query(SQL026);
    await t.pool.query(SQL026);
    assert.deepEqual((await t.pool.query("SELECT * FROM js_cv_files ORDER BY id")).rows, before);
    const up = (await t.pool.query("SELECT kind, format, canonical_name, missing FROM js_cv_files WHERE id=$1", [cv])).rows[0];
    assert.deepEqual(up, { kind: "upload", format: null, canonical_name: null, missing: [] });
    const cols = (await t.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='js_cv_files' AND table_schema=current_schema()")).rows.map((r) => r.column_name);
    for (const k of ["kind", "format", "canonical_name", "source_profile_hash", "generated_by", "generated_at", "staff_approved_by", "staff_approved_at", "candidate_authorised_by", "candidate_authorised_at", "missing"]) assert.ok(cols.includes(k), k);
    assert.equal(cols.filter((k) => k === "lang").length, 0, "language is reused, not duplicated");
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname='js_cv_files_canadian_immutable_trg' AND tgrelid = 'js_cv_files'::regclass")).rows[0].n, 1, "one trigger after re-runs");
  });
});
