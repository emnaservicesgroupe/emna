// Canadian-format CV: pure model builder + PDF / DOCX renderers. No database, no network.
//
// HARD RULES (see docs/superpowers/specs/2026-10-31-vita-canada-service-layer-design.md section 3):
//  * Every fact in the output is copied from the candidate's CONFIRMED profile (plus city / country the candidate confirmed).
//    Nothing is invented, inferred, rounded up or translated. The only generated sentence is the fixed professional-summary
//    template, and only when its three inputs (profession, verified years, at least one skill) all exist.
//  * Never emitted, whatever the profile object carries: photo, age / date of birth, marital status, nationality, passport or
//    identity data, salary. Only the whitelisted fields below are ever read, and list items that themselves state such a
//    fact are dropped (and reported in `missing`).
//  * French mode translates ONLY the static headings / labels / the summary template wording. Facts are never translated
//    (no machine translation of a candidate's data).
//  * What is absent is reported in `missing[]`, never papered over.
const crypto = require("crypto");

const LANGS = ["en", "fr"];
const FORMATS = ["pdf", "docx"];

const HEADINGS = {
  en: {
    summary: "Professional Summary",
    experience: "Professional Experience",
    skills: "Skills",
    education: "Education and Training",
    certifications: "Certifications and Licences",
    languages: "Languages",
  },
  fr: {
    summary: "Résumé professionnel",
    experience: "Expérience professionnelle",
    skills: "Compétences",
    education: "Formation",
    certifications: "Certifications et permis",
    languages: "Langues",
  },
};
const SUMMARY_TEMPLATE = {
  en: ({ profession, years, skills }) => `${profession} with ${years} years of verified experience in ${skills}.`,
  fr: ({ profession, years, skills }) => `${profession} avec ${years} ans d'expérience vérifiée en ${skills}.`,
};
const SUMMARY_SKILLS_MAX = 3;
/** Section order of the document. */
const SECTION_IDS = ["summary", "experience", "skills", "education", "certifications", "languages"];

// A list item that itself states one of the never-emitted facts is dropped.
const SENSITIVE_ITEM_RE = /\b(?:date of birth|birth ?date|d\.?o\.?b|place of birth|born (?:on|in)|marital status|nationality|nationalit[eé]|passport|passeport|national id|identity card|salary|salaire|photo)\b/i;

const MONTHS = [["jan", 1], ["janv", 1], ["feb", 2], ["fev", 2], ["mar", 3], ["apr", 4], ["avr", 4], ["may", 5], ["mai", 5], ["juin", 6], ["jun", 6], ["juil", 7], ["jul", 7], ["aug", 8], ["aou", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12]];
const PRESENT_RE = /^(?:present|current|now|ongoing|aujourd'hui|aujourd’hui|pr[eé]sent|en cours)$/i;

const str = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v : []);

/** Parses a confirmed date string. @returns {{y:number, m:number|null}|{present:true}|null} */
function parseDate(raw) {
  const s = str(raw);
  if (!s) return null;
  if (PRESENT_RE.test(s)) return { present: true };
  let m;
  if ((m = /^((?:19|20)\d{2})$/.exec(s))) return { y: Number(m[1]), m: null };
  if ((m = /^(0?[1-9]|1[0-2])[/.](\d{4})$/.exec(s))) return { y: Number(m[2]), m: Number(m[1]) };
  if ((m = /^((?:19|20)\d{2})[-/](0?[1-9]|1[0-2])(?:[-/]\d{1,2})?$/.exec(s))) return { y: Number(m[1]), m: Number(m[2]) };
  if ((m = /^([A-Za-zÀ-ÿ]{3,9})\.?\s+((?:19|20)\d{2})$/.exec(s))) {
    const w = m[1].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const hit = MONTHS.find(([p]) => w === p || (w.length > p.length && w.startsWith(p) && p.length >= 3));
    if (hit) return { y: Number(m[2]), m: hit[1] };
  }
  return null;
}

/** Month index (y*12 + m-1). `edge` picks the month when only the year is known: start -> January, end -> December. */
function monthIndex(d, edge, nowIdx) {
  if (d.present) return nowIdx;
  const mm = d.m || (edge === "start" ? 1 : 12);
  return Math.min(d.y * 12 + (mm - 1), nowIdx);
}

/** Whole years covered by the union of the experience intervals; null unless EVERY entry has a verifiable start and end. */
function verifiedYears(entries, now) {
  if (!entries.length) return null;
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const spans = [];
  for (const e of entries) {
    const s = parseDate(e.start);
    const t = parseDate(e.end);
    if (!s || s.present || !t) return null;
    const a = monthIndex(s, "start", nowIdx);
    const b = monthIndex(t, "end", nowIdx);
    if (b < a) return null;
    spans.push([a, b + 1]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let [cs, ce] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else {
      total += ce - cs;
      [cs, ce] = [s, e];
    }
  }
  total += ce - cs;
  return Math.floor(total / 12);
}

// Characters the standard PDF font (Helvetica, WinAnsi / Windows-1252) can draw.
const WIN_ANSI_EXTRA = new Set([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);
function winAnsiOk(s) {
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(c)) continue;
    return false;
  }
  return true;
}

/** Field paths of the model whose text the standard PDF font cannot draw. */
function pdfUnrenderable(model) {
  const bad = [];
  const chk = (path, v) => {
    if (typeof v === "string" && v && !winAnsiOk(v)) bad.push(path);
  };
  chk("name", model.name);
  for (const [k, v] of Object.entries(model.contact || {})) chk(`contact.${k}`, v);
  for (const sec of model.sections || []) {
    if (sec.id === "summary") {
      chk("summary.profession", sec.facts.profession);
      sec.facts.skills.forEach((s, i) => chk(`summary.skills[${i}]`, s));
    } else if (sec.id === "experience") {
      sec.items.forEach((it, i) => ["title", "employer", "start", "end"].forEach((f) => chk(`experience[${i}].${f}`, it[f])));
    } else if (sec.id === "languages") {
      sec.items.forEach((it, i) => ["lang", "level"].forEach((f) => chk(`languages[${i}].${f}`, it[f])));
    } else {
      sec.items.forEach((it, i) => chk(`${sec.id}[${i}]`, it));
    }
  }
  return bad;
}

function cleanList(values, section, missing) {
  const out = [];
  let dropped = false;
  for (const v of list(values)) {
    const s = str(v);
    if (!s) continue;
    if (SENSITIVE_ITEM_RE.test(s)) {
      dropped = true;
      continue;
    }
    out.push(s);
  }
  if (dropped) missing.push(`excluded_sensitive:${section}`);
  return out;
}

/**
 * @param {object} profile  js_profiles.confirmed (name, email, phone, profession, skills[], experience[{title,employer,start,end}],
 *                          education[], certificates[], languages[{lang,level}]). Any other key is ignored.
 * @param {{city?:string|null, country?:string|null}} extras  values the candidate confirmed elsewhere (candidates.city, preferences.residence_country)
 * @param {{lang?:'en'|'fr', now?:Date}} opts
 * @returns {{lang:string, name:string, contact:object, sections:object[], missing:string[], refusal?:{code:string, reasons:string[]}}}
 */
function buildCvModel(profile, extras = {}, opts = {}) {
  const lang = LANGS.includes(opts.lang) ? opts.lang : "en";
  const now = opts.now instanceof Date ? opts.now : new Date();
  const p = profile && typeof profile === "object" ? profile : {};
  const x = extras && typeof extras === "object" ? extras : {};
  const H = HEADINGS[lang];
  const missing = [];

  const name = str(p.name);
  const contact = {};
  const city = str(x.city);
  const country = str(x.country);
  if (city) contact.city = city;
  if (country) contact.country = country;
  if (str(p.email)) contact.email = str(p.email);
  if (str(p.phone)) contact.phone = str(p.phone);
  if (!city && !country) missing.push("contact.location");
  if (!contact.email) missing.push("contact.email");
  if (!contact.phone) missing.push("contact.phone");

  // ---- experience: only entries with some content; reverse chronological when the dates allow it
  const entries = [];
  list(p.experience).forEach((e, i) => {
    if (!e || typeof e !== "object") return;
    const it = { title: str(e.title), employer: str(e.employer), start: str(e.start), end: str(e.end) };
    if (!it.title && !it.employer) return;
    if (SENSITIVE_ITEM_RE.test(`${it.title} ${it.employer}`)) {
      if (!missing.includes("excluded_sensitive:experience")) missing.push("excluded_sensitive:experience");
      return;
    }
    entries.push({ ...it, idx: i });
  });
  const keyed = entries.map((e, order) => {
    const t = parseDate(e.end);
    const s = parseDate(e.start);
    const endKey = t ? (t.present ? Infinity : t.y * 12 + (t.m || 12)) : null;
    const startKey = s && !s.present ? s.y * 12 + (s.m || 1) : null;
    if (!s || !t) missing.push(`dates:experience[${e.idx}]`);
    return { e, order, endKey, startKey };
  });
  const sortable = keyed.filter((k) => k.endKey !== null).sort((a, b) => (b.endKey - a.endKey) || ((b.startKey ?? -1) - (a.startKey ?? -1)) || a.order - b.order);
  const unsortable = keyed.filter((k) => k.endKey === null);
  const experience = [...sortable, ...unsortable].map(({ e }) => ({ title: e.title, employer: e.employer, start: e.start, end: e.end }));

  const skills = cleanList(p.skills, "skills", missing);
  const education = cleanList(p.education, "education", missing);
  const certifications = cleanList(p.certificates, "certifications", missing);
  const languages = [];
  for (const l of list(p.languages)) {
    if (!l || typeof l !== "object" || !str(l.lang)) continue;
    const it = { lang: str(l.lang), level: str(l.level) };
    if (SENSITIVE_ITEM_RE.test(`${it.lang} ${it.level}`)) {
      if (!missing.includes("excluded_sensitive:languages")) missing.push("excluded_sensitive:languages");
      continue;
    }
    languages.push(it);
  }

  // ---- fixed-template summary: only from verified facts
  const profession = SENSITIVE_ITEM_RE.test(str(p.profession)) ? "" : str(p.profession);
  const years = verifiedYears(entries, now);
  let summary = null;
  if (profession && years !== null && years >= 1 && skills.length >= 1) {
    const facts = { profession, years, skills: skills.slice(0, SUMMARY_SKILLS_MAX) };
    summary = { id: "summary", heading: H.summary, text: SUMMARY_TEMPLATE[lang]({ ...facts, skills: facts.skills.join(", ") }), facts };
  } else {
    missing.push("professional_summary");
  }

  const sections = [];
  if (summary) sections.push(summary);
  if (experience.length) sections.push({ id: "experience", heading: H.experience, items: experience });
  else missing.push("experience");
  if (skills.length) sections.push({ id: "skills", heading: H.skills, items: skills });
  else missing.push("skills");
  if (education.length) sections.push({ id: "education", heading: H.education, items: education });
  else missing.push("education");
  if (certifications.length) sections.push({ id: "certifications", heading: H.certifications, items: certifications });
  else missing.push("certifications");
  if (languages.length) sections.push({ id: "languages", heading: H.languages, items: languages });
  else missing.push("languages");

  const model = { lang, name, contact, sections, missing };
  const reasons = [];
  if (!name) reasons.push("name");
  if (!experience.length && !education.length) reasons.push("experience_or_education");
  if (reasons.length) model.refusal = { code: "minimum_not_met", reasons };
  for (const path of pdfUnrenderable(model)) missing.push(`latin_spelling_needed:${path}`);
  return model;
}

/** Stable SHA-256 of a JSON value (keys sorted) - identifies the confirmed profile a CV was built from. */
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const profileHash = (confirmed) => crypto.createHash("sha256").update(stableStringify(confirmed || {})).digest("hex");

// ---------------------------------------------------------------- file names

const REFERENCE_RE = /^CAN-[0-9]{4}-[0-9]{4,}$/;
const CANONICAL_NAME_RE = /^CAN-[0-9]{4}-[0-9]{4,}-CV-V[0-9]{1,4}(?:-FR)?\.(?:pdf|docx)$/;

/** `<reference>-CV-V<n>[-FR].<pdf|docx>`; throws for anything that is not a well-formed reference / version / language / format. */
function canonicalName(reference, version, lang, format) {
  if (typeof reference !== "string" || !REFERENCE_RE.test(reference)) throw new Error("invalid candidate reference");
  if (!Number.isSafeInteger(version) || version < 1 || version > 9999) throw new Error("invalid version");
  if (!LANGS.includes(lang)) throw new Error("invalid language");
  if (!FORMATS.includes(format)) throw new Error("invalid format");
  return `${reference}-CV-V${version}${lang === "fr" ? "-FR" : ""}.${format}`;
}

/** The name for a Content-Disposition header: the canonical name when it matches the pattern, else a fixed fallback built from validated parts. */
function safeDownloadName(name, { version, format } = {}) {
  if (typeof name === "string" && CANONICAL_NAME_RE.test(name)) return name;
  const v = Number.isSafeInteger(version) && version > 0 && version < 10000 ? version : 0;
  return `cv-v${v}.${FORMATS.includes(format) ? format : "bin"}`;
}

// ---------------------------------------------------------------- renderers

const contactLine = (c) => {
  const loc = [c.city, c.country].filter(Boolean).join(", ");
  return [loc, c.email, c.phone].filter(Boolean);
};
const dateRange = (e) => [e.start, e.end].filter(Boolean).join(" – ");

class LatinSpellingNeededError extends Error {
  constructor(fields) {
    super(`The PDF uses a standard font that cannot draw some characters (${fields.join(", ")}). Add a Latin-script spelling of these values in the confirmed profile, or generate the DOCX format only.`);
    this.name = "LatinSpellingNeededError";
    this.code = "LATIN_SPELLING_NEEDED";
    this.fields = fields;
  }
}

/** A4, single column, standard Helvetica, selectable text only. */
async function renderPdf(model) {
  if (!model || model.refusal) throw new Error("cannot render a refused model");
  const bad = pdfUnrenderable(model);
  if (bad.length) throw new LatinSpellingNeededError(bad);
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ size: "A4", margins: { top: 50, bottom: 50, left: 50, right: 50 }, info: { Title: "Curriculum Vitae", Creator: "VITA", Producer: "VITA" } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const W = doc.page.width - 100;

  doc.font("Helvetica-Bold").fontSize(20).fillColor("#000000").text(model.name, { width: W });
  const cl = contactLine(model.contact);
  if (cl.length) doc.font("Helvetica").fontSize(10).moveDown(0.2).text(cl.join("  |  "), { width: W });

  for (const sec of model.sections) {
    doc.moveDown(0.9);
    doc.font("Helvetica-Bold").fontSize(12).text(sec.heading, { width: W });
    const y = doc.y + 1;
    doc.moveTo(50, y).lineTo(50 + W, y).lineWidth(0.5).strokeColor("#000000").stroke();
    doc.moveDown(0.4).font("Helvetica").fontSize(10);
    if (sec.id === "summary") {
      doc.text(sec.text, { width: W });
    } else if (sec.id === "experience") {
      sec.items.forEach((e, i) => {
        if (i) doc.moveDown(0.5);
        if (e.title) doc.font("Helvetica-Bold").text(e.title, { width: W });
        const sub = [e.employer, dateRange(e)].filter(Boolean).join("  |  ");
        if (sub) doc.font("Helvetica").text(sub, { width: W });
      });
    } else if (sec.id === "languages") {
      doc.list(sec.items.map((l) => (l.level ? `${l.lang} (${l.level})` : l.lang)), { bulletRadius: 1.5, textIndent: 12, width: W });
    } else {
      doc.list(sec.items, { bulletRadius: 1.5, textIndent: 12, width: W });
    }
  }
  doc.end();
  return done;
}

const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/** DOCX with real headings and bullet lists; Unicode (including right-to-left scripts) is fine. */
async function renderDocx(model) {
  if (!model || model.refusal) throw new Error("cannot render a refused model");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");
  // One paragraph = one text; right-to-left scripts switch the run and the paragraph to RTL.
  const tp = (text, run = {}, para = {}) =>
    new Paragraph({ children: [new TextRun({ text, font: "Calibri", rightToLeft: RTL_RE.test(text), ...run })], bidirectional: RTL_RE.test(text), ...para });
  const kids = [];
  kids.push(tp(model.name, { bold: true, size: 40 }, { heading: HeadingLevel.TITLE, spacing: { after: 80 } }));
  const cl = contactLine(model.contact);
  if (cl.length) kids.push(tp(cl.join("  |  "), { size: 20 }, { spacing: { after: 160 } }));
  const heading = (t) => tp(t, { bold: true, size: 24 }, { heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 80 }, border: { bottom: { style: "single", size: 4, space: 1, color: "000000" } } });
  const bullet = (t) => tp(t, { size: 20 }, { bullet: { level: 0 } });
  for (const sec of model.sections) {
    kids.push(heading(sec.heading));
    if (sec.id === "summary") kids.push(tp(sec.text, { size: 20 }));
    else if (sec.id === "experience") {
      sec.items.forEach((e) => {
        if (e.title) kids.push(tp(e.title, { bold: true, size: 20 }, { spacing: { before: 100 }, keepNext: true }));
        const sub = [e.employer, dateRange(e)].filter(Boolean).join("  |  ");
        if (sub) kids.push(tp(sub, { size: 20 }));
      });
    } else if (sec.id === "languages") sec.items.forEach((l) => kids.push(bullet(l.level ? `${l.lang} (${l.level})` : l.lang)));
    else sec.items.forEach((t) => kids.push(bullet(t)));
  }
  const document = new Document({
    creator: "VITA",
    title: "Curriculum Vitae",
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } }, children: kids }],
  });
  return Buffer.from(await Packer.toBuffer(document));
}

module.exports = {
  buildCvModel,
  renderPdf,
  renderDocx,
  pdfUnrenderable,
  winAnsiOk,
  stableStringify,
  LatinSpellingNeededError,
  profileHash,
  canonicalName,
  safeDownloadName,
  parseDate,
  verifiedYears,
  LANGS,
  FORMATS,
  HEADINGS,
  SECTION_IDS,
  REFERENCE_RE,
  CANONICAL_NAME_RE,
};
