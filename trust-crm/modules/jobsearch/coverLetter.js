// Deterministic cover-letter template. Every factual token in the letter (name, profession, skills,
// dates, employers, education, certificates, languages) comes from the CONFIRMED profile; the job
// title and employer name come from the job. Nothing is inferred, summarised or invented.
//
// Sensitive-fact guard: the letter never states work authorization, permits, visas, eligibility,
// sponsorship, citizenship or references. Profile/job items that mention such things are dropped.
// When the candidate needs work-authorization support the letter may say exactly one thing about it:
// that they "would require employer support for work authorization" (or its translation).
const { sanitizeUntrusted } = require("./matching/sanitize");

const LANGS = ["en", "fr", "ar"];
const MAX_ITEM = 200;
const MAX_LIST = 15;

// Anything that could read as a claim about immigration status, eligibility or references.
const SENSITIVE_RE = new RegExp(
  [
    "\\bpermits?\\b", "\\bvisas?\\b", "\\beligib", "\\bauthori[sz]", "\\bcitizen", "\\bnationalit", "\\bpermanent\\s+resid",
    "\\bresiden(?:cy|t\\s+status)\\b", "\\bsponsor", "\\blmia\\b", "\\beimt\\b", "\\bimmigra", "\\breferences?\\b", "\\breferees?\\b",
    "\\bpermis\\b", "\\btitre\\s+de\\s+s[eé]jour", "\\bparrain", "\\bautoris", "\\b[eé]ligib", "\\br[eé]f[eé]rences?\\b",
    "\\bgreen\\s+card", "\\bwork\\s+right", "\\bright\\s+to\\s+work", "\\blegal(?:ly)?\\s+(?:to\\s+)?work",
    "تأشيرة", "تصريح", "إقامة", "كفالة", "كفيل", "مرجع", "جنسية",
  ].join("|"),
  "i"
);

const T = {
  en: {
    greetingEmployer: "Dear Hiring Team at {employer},",
    greeting: "Dear Hiring Team,",
    intro: "I am writing to apply for the {title} position.",
    introFallback: "I am writing to apply for the advertised position.",
    profession: "My profession is {profession}.",
    experienceIntro: "My work experience includes:",
    expTitleEmployer: "{title} at {employer}",
    expRange: "from {start} to {end}",
    expSince: "since {start}",
    expUntil: "until {end}",
    skills: "My skills include: {list}.",
    education: "Education: {list}.",
    certificates: "Certificates: {list}.",
    languages: "Languages: {list}.",
    support: "I would require employer support for work authorization.",
    closing: "Thank you for considering my application. I would welcome the opportunity to discuss it with you.",
    signoff: "Sincerely,",
  },
  fr: {
    greetingEmployer: "À l'attention de l'équipe de recrutement de {employer},",
    greeting: "Madame, Monsieur,",
    intro: "Je vous adresse ma candidature pour le poste de {title}.",
    introFallback: "Je vous adresse ma candidature pour le poste annoncé.",
    profession: "Ma profession : {profession}.",
    experienceIntro: "Mon expérience professionnelle comprend :",
    expTitleEmployer: "{title} chez {employer}",
    expRange: "de {start} à {end}",
    expSince: "depuis {start}",
    expUntil: "jusqu'en {end}",
    skills: "Mes compétences : {list}.",
    education: "Formation : {list}.",
    certificates: "Certificats : {list}.",
    languages: "Langues : {list}.",
    support: "J'aurais besoin du soutien de l'employeur pour l'autorisation de travail.",
    closing: "Je vous remercie de l'attention portée à ma candidature et reste à votre disposition pour en discuter.",
    signoff: "Veuillez agréer mes salutations distinguées,",
  },
  ar: {
    greetingEmployer: "إلى فريق التوظيف في {employer}،",
    greeting: "إلى فريق التوظيف،",
    intro: "أتقدم بطلب لشغل وظيفة {title}.",
    introFallback: "أتقدم بطلب لشغل الوظيفة المعلن عنها.",
    profession: "مهنتي: {profession}.",
    experienceIntro: "تشمل خبرتي المهنية:",
    expTitleEmployer: "{title} لدى {employer}",
    expRange: "من {start} إلى {end}",
    expSince: "منذ {start}",
    expUntil: "حتى {end}",
    skills: "مهاراتي: {list}.",
    education: "التعليم: {list}.",
    certificates: "الشهادات: {list}.",
    languages: "اللغات: {list}.",
    support: "سأحتاج إلى دعم صاحب العمل للحصول على تصريح العمل.",
    closing: "أشكركم على النظر في طلبي، ويسعدني مناقشته معكم.",
    signoff: "مع خالص التحية،",
  },
};

function fill(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] === undefined ? "" : vars[k]));
}

/** All fixed template text for `lang` (placeholders removed): the letter's only non-profile words. */
function staticText(lang) {
  const t = T[LANGS.includes(lang) ? lang : "en"];
  return Object.values(t).map((s) => s.replace(/\{\w+\}/g, " ")).join("\n");
}

/** Cleans one untrusted/profile string; null when empty or when it mentions a sensitive fact. */
function item(v, omitted, field) {
  if (typeof v !== "string") return null;
  const s = sanitizeUntrusted(v, 2000).replace(/\s+/g, " ").trim().slice(0, MAX_ITEM);
  if (!s) return null;
  if (SENSITIVE_RE.test(s)) {
    omitted.push(field);
    return null;
  }
  return s;
}

const FIRST_PERSON_RE = /(?:^|[^\p{L}])(?:i|i'm|im|i've|my|me|mine|je|j'ai|moi|mon|ma|mes|nous)(?=$|[^\p{L}])|أنا|لدي/iu;

/**
 * Job title / employer name are UNTRUSTED ad text: keep only the first clause (cut at sentence
 * punctuation, newlines and " - "/" | " separators), at most 80 chars, and refuse anything that reads
 * as a first-person claim, so a hostile title cannot put words in the candidate's mouth.
 */
function jobLabel(v, omitted, field) {
  if (typeof v !== "string") return null;
  const first = sanitizeUntrusted(v, 2000).split(/[.!?;\n\r\u2022]|\s[-\u2013\u2014|]\s|:\s/)[0];
  const cut = first.replace(/\s+/g, " ").trim().slice(0, 80).trim();
  if (!cut) return null;
  if (FIRST_PERSON_RE.test(cut) || /\p{N}/u.test(cut) && /\b(?:years?|ans|ann[eé]es?|yrs?)\b/i.test(cut)) {
    omitted.push(field);
    return null;
  }
  return item(cut, omitted, field);
}

function list(values, omitted, field) {
  const out = [];
  for (const v of Array.isArray(values) ? values : []) {
    const s = item(v, omitted, field);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

function sep(lang) {
  return lang === "ar" ? "، " : ", ";
}

/**
 * @param {object} profile    js_profiles.confirmed (ONLY the confirmed profile)
 * @param {object} job        {title, employer|employer_name}
 * @param {string} lang       en | fr | ar (anything else -> en)
 * @param {{needsWorkAuthSupport?: boolean}} [opts]
 * @returns {{text: string, lang: string, omitted: string[]}}
 */
function generateDetailed(profile, job, lang, opts = {}) {
  const L = LANGS.includes(lang) ? lang : "en";
  const t = T[L];
  const p = profile && typeof profile === "object" ? profile : {};
  const omitted = [];
  const lines = [];

  const employer = jobLabel(job && (job.employer_name ?? job.employer), omitted, "job.employer");
  const title = jobLabel(job && job.title, omitted, "job.title");
  lines.push(employer ? fill(t.greetingEmployer, { employer }) : t.greeting, "");
  lines.push(title ? fill(t.intro, { title }) : t.introFallback);

  const profession = item(p.profession, omitted, "profession");
  if (profession) lines.push(fill(t.profession, { profession }));

  const exp = [];
  for (const e of Array.isArray(p.experience) ? p.experience.slice(0, MAX_LIST) : []) {
    if (!e || typeof e !== "object") continue;
    const et = item(e.title, omitted, "experience.title");
    const ee = item(e.employer, omitted, "experience.employer");
    const start = item(e.start, omitted, "experience.start");
    const end = item(e.end, omitted, "experience.end");
    let head = et && ee ? fill(t.expTitleEmployer, { title: et, employer: ee }) : et || ee;
    if (!head) continue;
    const range = start && end ? fill(t.expRange, { start, end }) : start ? fill(t.expSince, { start }) : end ? fill(t.expUntil, { end }) : "";
    if (range) head += ` (${range})`;
    exp.push(`- ${head}`);
  }
  if (exp.length) lines.push("", t.experienceIntro, ...exp);

  const skills = list(p.skills, omitted, "skills");
  const education = list(p.education, omitted, "education");
  const certificates = list(p.certificates, omitted, "certificates");
  const languages = [];
  for (const l of Array.isArray(p.languages) ? p.languages.slice(0, MAX_LIST) : []) {
    const name = item(typeof l === "string" ? l : l && l.lang, omitted, "languages");
    if (!name) continue;
    const level = l && typeof l === "object" ? item(l.level, omitted, "languages.level") : null;
    languages.push(level ? `${name} (${level})` : name);
  }
  const facts = [];
  if (skills.length) facts.push(fill(t.skills, { list: skills.join(sep(L)) }));
  if (education.length) facts.push(fill(t.education, { list: education.join(sep(L)) }));
  if (certificates.length) facts.push(fill(t.certificates, { list: certificates.join(sep(L)) }));
  if (languages.length) facts.push(fill(t.languages, { list: languages.join(sep(L)) }));
  if (facts.length) lines.push("", ...facts);

  if (opts.needsWorkAuthSupport === true) lines.push("", t.support);
  lines.push("", t.closing, "", t.signoff);
  const name = item(p.name, omitted, "name");
  if (name) lines.push(name);

  const text = lines.join("\n");
  // Defense in depth: nothing but the one allowed support sentence may touch a sensitive topic.
  if (SENSITIVE_RE.test(text.split(t.support).join(" "))) throw new Error("cover letter sensitive-fact guard tripped");
  return { text, lang: L, omitted: [...new Set(omitted)] };
}

/** @returns {string} the letter text (see generateDetailed). */
function generate(profile, job, lang, opts) {
  return generateDetailed(profile, job, lang, opts).text;
}

const FR_MARKERS = /\b(?:le|la|les|des|du|et|pour|vous|nous|avec|une|sur|dans|poste|emploi|est)\b/g;
const EN_MARKERS = /\b(?:the|and|for|you|we|with|our|this|are|job|position|is|will)\b/g;

/** Best-effort language of a job ad: ar | fr | en (default en). */
function detectLanguage(job) {
  const text = `${(job && job.title) || ""} ${(job && job.description_text) || ""}`.slice(0, 20000);
  const arabic = (text.match(/[؀-ۿ]/g) || []).length;
  const latin = (text.match(/[A-Za-zÀ-ſ]/g) || []).length;
  if (arabic > 0 && arabic >= latin) return "ar";
  const low = text.toLowerCase();
  const fr = (low.match(FR_MARKERS) || []).length + (low.match(/[éèêàç]/g) || []).length / 3;
  const en = (low.match(EN_MARKERS) || []).length;
  return fr > en ? "fr" : "en";
}

module.exports = { generate, generateDetailed, staticText, detectLanguage, SENSITIVE_RE, LANGS };
