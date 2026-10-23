// Deterministic CV text -> structured fields. No LLM, no network.
// The CV is UNTRUSTED data: this only copies strings that are present in the text.
// Instruction-like text has no special meaning; it can only end up as a plain string.

const MAX_TEXT = 200000;
const MAX_LINE = 500; // every regex below only ever sees a line this short (bounds worst-case cost)
const MAX_LINES = 2000;
const MAX_ITEM = 200;
const MAX_ITEMS = 50;

// C0/C1 controls (except \n and \t), DEL, zero-width, bidi override/isolate, BOM, line/paragraph separators.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/**
 * Normalizes untrusted text once, up front: strips control characters, collapses whitespace
 * runs, caps line length / line count / total size. All later regexes run on this output,
 * so none can be driven into quadratic behaviour by a huge whitespace-heavy line.
 */
function sanitizeText(text) {
  const raw = String(text == null ? "" : text).slice(0, MAX_TEXT * 3);
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_RE, "")
    .split("\n", MAX_LINES)
    .map((l) => l.replace(/\s+/g, " ").trim().slice(0, MAX_LINE).trimEnd());
  return lines.join("\n").slice(0, MAX_TEXT);
}

function clean(s) {
  return String(s).replace(CONTROL_RE, "").replace(/\s+/g, " ").trim().slice(0, MAX_ITEM);
}

/** Removes any of `chars` from both ends (no regex: linear). */
function trimChars(s, chars) {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

const HEADINGS = {
  summary: ["summary", "profile", "professional summary", "about me", "objective", "résumé", "profil"],
  experience: ["experience", "work experience", "professional experience", "employment history", "work history", "expérience", "expérience professionnelle", "experience professionnelle"],
  education: ["education", "education and training", "formation", "éducation", "academic background"],
  skills: ["skills", "key skills", "technical skills", "core skills", "compétences", "competences"],
  certificates: ["certificates", "certifications", "certificate", "licenses", "licences", "licenses and certifications", "certificats"],
  languages: ["languages", "language skills", "langues"],
  other: ["references", "interests", "hobbies", "projects", "personal details", "personal information", "additional information", "centres d'intérêt"],
};
const HEADING_LOOKUP = new Map();
for (const [section, names] of Object.entries(HEADINGS)) for (const n of names) HEADING_LOOKUP.set(n, section);

function headingOf(line) {
  const key = trimChars(line, ": \t").toLowerCase();
  return HEADING_LOOKUP.get(key) || null;
}

// Anchored, bounded token matcher: linear on any input (applied per whitespace-separated token).
const EMAIL_TOKEN_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,200}\.[A-Za-z]{2,24}$/;
const PHONE_RE = /(?:\+|00)?\d[\d\s().-]{6,24}\d/g; // bounded: at most ~27 chars per attempt
const HEADER_LINES = 40;

function findEmail(lines) {
  for (const line of lines) {
    for (const tok of line.split(/[\s|,;<>()[\]]+/)) {
      if (tok.length < 6 || tok.length > 260 || !tok.includes("@")) continue;
      const t = trimChars(tok.slice(tok.lastIndexOf(":") + 1), ".");
      if (EMAIL_TOKEN_RE.test(t)) return t;
    }
  }
  return null;
}
const YEAR_RANGE_ONLY_RE = /^(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|present|current)$/i;
const DATE = String.raw`(?:(?:0?[1-9]|1[0-2])[/.])?(?:19|20)\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(?:19|20)\d{2}`;
const DATE_RANGE_RE = new RegExp(String.raw`\(?\b(${DATE})\s*(?:-|–|—|to)\s*(${DATE}|present|current|now|ongoing|aujourd'hui|présent)\b\)?`, "i");

function stripBullet(line) {
  return line.replace(/^\s*(?:[-*•▪◦·●]|\d+[.)])\s+/, "").trim();
}
function isBullet(line) {
  return /^\s*(?:[-*•▪◦·●])\s+/.test(line);
}

function splitSections(lines) {
  const header = [];
  const sections = {};
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const h = headingOf(line);
    if (h) {
      current = h;
      if (!sections[h]) sections[h] = [];
      continue;
    }
    if (current === null) header.push(line);
    else sections[current].push(raw.trimEnd());
  }
  return { header, sections };
}

function findPhone(header) {
  for (const line of header) {
    const labelled = /(?:phone|tel|mobile|gsm|téléphone)\s*[:\-]?\s*/i.test(line);
    const candidates = line.match(PHONE_RE) || [];
    for (const c of candidates) {
      const digits = c.replace(/\D/g, "");
      if (digits.length < 8 || digits.length > 15 || !/\d{2}/.test(c)) continue;
      if (YEAR_RANGE_ONLY_RE.test(c.trim())) continue;
      if (!labelled && !/^(?:\+|00)/.test(c.trim()) && digits.length < 9) continue;
      return clean(c);
    }
  }
  return null;
}

function looksLikeName(line) {
  if (findEmail([line]) || /\d|https?:|www\./i.test(line) || line.includes(":")) return false;
  const words = line.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  const caseless = (w) => w.toLowerCase() === w.toUpperCase(); // e.g. Arabic script
  return words.every((w) => /^[\p{L}][\p{L}'’.-]*$/u.test(w) && (/^\p{Lu}/u.test(w) || caseless(w[0]) || /^(?:de|del|di|van|von|ben|bin|el|al|ibn)$/i.test(w)));
}

function findName(header) {
  const first = header[0];
  return first && looksLikeName(first) ? clean(first) : null;
}

function findProfession(header, nameFound) {
  for (const line of header) {
    const m = /^(?:profession|title|position|job title|current position|poste)\s*:\s*(.+)$/i.exec(line);
    if (m) return clean(m[1]) || null;
  }
  if (!nameFound) return null; // unlabeled profession is only trusted as the line right under the name
  const line = header[1];
  if (!line) return null;
  if (findEmail([line]) || /\d|:|\||https?:|www\./i.test(line) || line.length > 80) return null;
  return clean(line) || null;
}

function listItems(sectionLines, { splitComma = true } = {}) {
  const out = [];
  for (const raw of sectionLines || []) {
    const line = stripBullet(raw);
    if (!line) continue;
    const parts = splitComma ? line.split(/\s*[,;|•]\s*/) : [line];
    for (const p of parts) {
      const v = clean(p);
      if (v && !out.includes(v)) out.push(v);
      if (out.length >= MAX_ITEMS) return out;
    }
  }
  return out;
}

function parseExperience(sectionLines) {
  const out = [];
  let prev = null;
  for (const raw of sectionLines || []) {
    const bullet = isBullet(raw);
    const line = stripBullet(raw);
    if (!line) continue;
    const m = !bullet ? DATE_RANGE_RE.exec(line) : null;
    if (!m) {
      if (!bullet) prev = line;
      continue;
    }
    const rest = trimChars(line.replace(m[0], " "), "|,;-–— ()");
    let parts;
    if (rest.includes("|")) parts = rest.split("|");
    else if (/\sat\s/i.test(rest)) parts = rest.split(/\sat\s/i);
    else if (/\s[-–—]\s/.test(rest)) parts = rest.split(/\s[-–—]\s/);
    else parts = rest.split(/\s*,\s*/);
    parts = parts.map((p) => clean(p)).filter(Boolean);
    let title = parts[0] || null;
    let employer = parts.length > 1 ? parts.slice(1).join(", ") : null;
    if (!title && prev) title = clean(prev);
    out.push({ title, employer, start: clean(m[1]), end: clean(m[2]) });
    prev = null;
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function parseLanguages(sectionLines) {
  const out = [];
  for (const raw of sectionLines || []) {
    const line = stripBullet(raw);
    for (const part of line.split(/\s*[,;|•]\s*/)) {
      const p = part.trim();
      if (!p) continue;
      let lang = p;
      let level = null;
      let m = /^(.+?)\s*[(\[]\s*([^)\]]+?)\s*[)\]]$/.exec(p);
      if (!m) m = /^(.+?)\s*[:\-–—]\s*(.+)$/.exec(p);
      if (m) {
        lang = m[1];
        level = clean(m[2]) || null;
      }
      lang = clean(lang);
      if (lang && !out.some((x) => x.lang.toLowerCase() === lang.toLowerCase())) out.push({ lang, level });
      if (out.length >= MAX_ITEMS) return out;
    }
  }
  return out;
}

function emptyExtraction() {
  return { name: null, email: null, phone: null, profession: null, skills: [], experience: [], education: [], certificates: [], languages: [], provenance: {} };
}

/** @returns {{name,email,phone,profession,skills,experience,education,certificates,languages,provenance}} */
function extract(text) {
  const lines = sanitizeText(text).split("\n");
  const { header, sections } = splitSections(lines);
  const result = emptyExtraction();

  result.name = findName(header);
  result.email = findEmail(header.slice(0, HEADER_LINES)) || findEmail(lines.slice(0, 15));
  result.phone = findPhone(header.slice(0, HEADER_LINES));
  result.profession = findProfession(header, result.name !== null);
  result.skills = listItems(sections.skills);
  result.experience = parseExperience(sections.experience);
  result.education = listItems(sections.education, { splitComma: false });
  result.certificates = listItems(sections.certificates, { splitComma: false });
  result.languages = parseLanguages(sections.languages);

  for (const [field, value] of Object.entries(result)) {
    if (field === "provenance") continue;
    const present = Array.isArray(value) ? value.length > 0 : value !== null;
    if (present) result.provenance[field] = "cv";
  }
  return result;
}

module.exports = { extract, sanitizeText, emptyExtraction, MAX_ITEM, MAX_ITEMS, MAX_TEXT };
