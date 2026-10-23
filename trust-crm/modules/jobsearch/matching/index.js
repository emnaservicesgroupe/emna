// Rule-based, explainable matching. Pure functions: no database, no network, no code execution from
// job text. Job text is UNTRUSTED data read only through keyword/regex logic (never interpreted as
// instructions). A score is a review aid: it never establishes immigration eligibility, employer
// sponsorship, a work permit or a visa, and unknowns go to `uncertain` and score neutrally.
const { sanitizeUntrusted } = require("./sanitize");
const { detectEmployerSupport, detectOverseas, sentences, fold } = require("./employerSupport");
const { normalize } = require("../jobStore");

const WEIGHTS = { profession: 40, experience: 15, language: 15, location: 15, salary: 5, licensing: 5, overseasAuth: 5 };
const NOTICE = "A match score helps review opportunities. It does not establish immigration eligibility, employer sponsorship, a work permit or a visa.";

const STOP = new Set(["the", "and", "for", "with", "des", "les", "une", "pour", "dans", "sur", "de", "du", "la", "le", "et", "en", "of", "in", "to", "senior", "junior"]);
const stem = (w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);
const tokens = (s) => normalize(s).split(" ").filter((w) => w.length >= 3 && !STOP.has(w)).map(stem);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function containsPhrase(hayNorm, phrase) {
  const p = normalize(phrase);
  return p.length > 0 && ` ${hayNorm} `.includes(` ${p} `);
}

// ---- prompt-injection neutralisation: instruction-like sentences are dropped before any scoring ----
const INJECTION = /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,50}\b(?:previous|prior|above|earlier|all|any)\b[^.\n]{0,40}\b(?:instructions?|rules?|prompts?)\b|\bsystem\s+prompt\b|\bscore\s*(?:this|it|me|=|:|of|is|to)?\s*\d{2,3}\b|\b(?:give|assign|rate)\s+(?:this|me|it)\b[^.\n]{0,30}\b(?:100|perfect|maximum|top|highest)\b|\byou\s+are\s+now\b|\bas\s+an?\s+(?:ai|language\s+model)\b/i;

function neutralize(text) {
  const clean = sanitizeUntrusted(text);
  let removed = false;
  const kept = clean.split(/\n/).map((line) => {
    const parts = line.split(/(?<=[.!?;])\s+/);
    return parts.filter((p) => {
      if (INJECTION.test(fold(p))) {
        removed = true;
        return false;
      }
      return true;
    }).join(" ");
  });
  return { text: kept.join("\n").trim(), removed };
}

// ---- countries ----
const COUNTRY_ALIASES = { ca: "canada", can: "canada", us: "united states", usa: "united states", "u s": "united states", america: "united states", uk: "united kingdom", gb: "united kingdom", "great britain": "united kingdom", uae: "united arab emirates", "emirats arabes unis": "united arab emirates", ksa: "saudi arabia", tunisie: "tunisia", allemagne: "germany", france: "france", qa: "qatar" };
function country(v) {
  const n = normalize(v);
  return COUNTRY_ALIASES[n] || n;
}

// ---- languages ----
const LANG_ALIASES = {
  english: ["english", "anglais", "en", "eng"],
  french: ["french", "francais", "fr", "fra"],
  arabic: ["arabic", "arabe", "ar"],
  spanish: ["spanish", "espagnol", "es"],
  german: ["german", "allemand", "de", "deutsch"],
};
const canonLang = (v) => {
  const n = normalize(v);
  for (const [k, list] of Object.entries(LANG_ALIASES)) if (list.includes(n)) return k;
  return n;
};
const LANG_CUE = /\b(?:required|require|requis|requise|exige|exigee|must|fluent|fluency|bilingual|bilingue|essential|mandatory|obligatoire|proficien\w*|maitrise|courant|knowledge|connaissance)\b/i;
const LANG_OPTIONAL = /\b(?:asset|atout|nice\s+to\s+have|an?\s+plus|preferred|souhaite|souhaitee)\b/i;
const LOW_LEVEL = /\b(?:basic|beginner|elementary|a1|a2|debutant|notions?|scolaire)\b/i;

function requiredLanguages(list) {
  const out = new Map();
  for (const s of list) {
    if (!LANG_CUE.test(s.folded) || LANG_OPTIONAL.test(s.folded)) continue;
    const bilingual = /\b(?:bilingual|bilingue)\b/i.test(s.folded);
    for (const [k, words] of Object.entries(LANG_ALIASES)) {
      const names = words.filter((w) => w.length > 3);
      if (names.some((w) => new RegExp(`\\b${w}\\b`, "i").test(s.folded)) && !out.has(k)) out.set(k, s.quote);
    }
    if (bilingual && !out.has("english")) out.set("english", s.quote);
    if (bilingual && /\b(?:french|francais)\b/i.test(s.folded) && !out.has("french")) out.set("french", s.quote);
  }
  return out;
}

// ---- experience ----
function requiredYears(folded) {
  const found = [];
  const re1 = /(\d{1,2})\s*\+?\s*(?:years?|yrs?|ans)\b(?:\s+(?:of|d'))?\s*(?:[a-z]+\s+){0,2}?(?:experience|exp\b)/gi;
  const re2 = /(?:minimum|at\s+least|min\.?|minimum\s+de|au\s+moins)\s+(?:of\s+)?(\d{1,2})\s*\+?\s*(?:years?|yrs?|ans)\b/gi;
  for (const re of [re1, re2]) {
    let m;
    while ((m = re.exec(folded))) found.push(Number(m[1]));
  }
  return found.length ? Math.max(...found) : null;
}

function candidateYears(experience, nowYear) {
  const spans = [];
  for (const e of arr(experience)) {
    if (!e || typeof e !== "object") continue;
    const sm = /(19|20)\d{2}/.exec(str(e.start));
    if (!sm) continue;
    const start = Number(sm[0]);
    const em = /(19|20)\d{2}/.exec(str(e.end));
    const end = em ? Number(em[0]) : /present|current|now|actuel|aujourd|^$/i.test(str(e.end)) ? nowYear : null;
    if (end !== null && end >= start) spans.push([start, end]);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else {
      total += ce - cs;
      [cs, ce] = [s, e];
    }
  }
  return total + (ce - cs);
}

// ---- licensing ----
const LICENCE_CUE = /\b(?:licen[cs]ed|licen[cs]es?|licen[cs]ure|certified|certification|red\s+seal|ordre\s+(?:professionnel|des)|professional\s+(?:designation|registration)|registered\s+with|registration\s+with|permis\s+de\s+pratique|accredited|accreditation|journeyman|inscrit\s+a\s+l'ordre)\b/i;
const LICENCE_GENERIC = new Set(["licensed", "license", "licence", "licenses", "licences", "licensure", "required", "valid", "must", "hold", "holds", "certified", "certification", "professional", "current", "active", "good", "standing", "registered", "registration", "with", "ordre", "permis", "pratique", "exige", "requis", "valide", "accredited", "accreditation", "canada", "canadian", "province", "provincial", "have", "possess", "ability", "your", "applicants", "candidates", "candidate"]);

// ---- salary ----
const CURRENCY_CODE = /\b(cad|usd|eur|gbp|aud|qar|aed|sar|tnd|chf)\b/i;
const PERIOD_AFTER = [
  ["year", /^\s{0,3}(?:per\s+(?:year|annum)|(?:a|an)\s+year|\/\s{0,2}(?:yr|year|an)\b|annually|yearly|p\.?\s?a\b|par\s+an\b|annuel\w*)/i],
  ["hour", /^\s{0,3}(?:per\s+hour|(?:a|an)\s+hour|\/\s{0,2}(?:hr|h|hour)\b|hourly|de\s+l'heure|horaire)/i],
  ["month", /^\s{0,3}(?:per\s+month|(?:a|an)\s+month|\/\s{0,2}(?:mo|month)\b|monthly|par\s+mois|mensuel\w*)/i],
];
const PERIOD_ANY = [["year", /\b(?:per\s+(?:year|annum)|annually|yearly|a\s+year|par\s+an)\b/i], ["hour", /\b(?:per\s+hour|hourly|an\s+hour|taux\s+horaire)\b|\/\s?(?:hr|hour)\b/i], ["month", /\b(?:per\s+month|monthly|a\s+month|par\s+mois)\b/i]];
function parseSalary(list) {
  for (const s of list) {
    if (!/\b(?:salary|salaire|pay|wage|compensation|remuneration|per\s+hour|hourly|annually|per\s+year|a\s+year|par\s+an|taux\s+horaire|per\s+month|monthly|par\s+mois)\b|\/\s*(?:hr|hour|year|yr|month|an|h)\b/i.test(s.folded)) continue;
    const text = s.folded.replace(/\d+\s*(?:hours?|hrs?|h)\s*(?:per|a|\/)\s*week/gi, " ").replace(/\d+\s*\+?\s*(?:years?|yrs?|ans)\b/gi, " ");
    const nums = [];
    const re = /(\$|€|£|\b(?:cad|usd|eur|gbp|aud|qar|aed|sar|tnd|chf)\b)?\s*(\d{1,3}(?:[, ]\d{3})+|\d+(?:\.\d+)?)\s*(k\b)?/gi;
    let m;
    while ((m = re.exec(text))) {
      let v = Number(m[2].replace(/[, ]/g, ""));
      if (m[3]) v *= 1000;
      const marker = m[1] || "";
      if (!marker && v < 1000) continue;
      if (v < 5) continue;
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
      const adj = PERIOD_AFTER.find(([, r]) => r.test(after));
      nums.push({ v, marker: marker.toLowerCase(), period: adj ? adj[0] : null });
    }
    if (!nums.length) continue;
    const top = nums.reduce((a, b) => (b.v > a.v ? b : a));
    let period = top.period;
    if (!period) {
      const found = PERIOD_ANY.filter(([, r]) => r.test(text)).map(([k]) => k);
      if (found.length === 1) period = found[0];
      else if (!found.length && top.v >= 20000) period = "year";
    }
    const code = (CURRENCY_CODE.exec(text) || [])[1];
    const annual = period ? top.v * (period === "hour" ? 2080 : period === "month" ? 12 : 1) : null;
    return { annual, period, figure: top.v, currency: code ? code.toUpperCase() : top.marker === "$" ? "$" : top.marker === "€" ? "EUR" : top.marker === "£" ? "GBP" : null, quote: s.quote };
  }
  return null;
}

function neutralPoints(max) {
  return max / 2;
}

/**
 * @param {object} profile confirmed profile (js_profiles.confirmed)
 * @param {object} prefs js_preferences row (countries, categories, salary_min, salary_currency, residence_country, needs_work_auth_support)
 * @param {object} job {title, location, country, description_text|description}
 * @param {{confirmation?: object|null, now?: Date}} [opts]
 */
function scoreMatch(profile, prefs, job, opts = {}) {
  profile = profile && typeof profile === "object" ? profile : {};
  prefs = prefs && typeof prefs === "object" ? prefs : {};
  job = job && typeof job === "object" ? job : {};
  const now = opts.now || new Date();
  const reasons = [];
  const missing = [];
  const uncertain = [];
  const breakdown = {};

  const titleN = neutralize(job.title);
  const descN = neutralize(job.description_text ?? job.description);
  const title = titleN.text.replace(/\s+/g, " ");
  const desc = descN.text;
  if (titleN.removed || descN.removed) uncertain.push("The ad contains instruction-like text, which was ignored");
  const list = sentences(desc);
  const jobNorm = normalize(`${title} ${desc}`);
  const titleNorm = normalize(title);

  // 1. profession / skills (40)
  {
    const max = WEIGHTS.profession;
    const terms = [str(profile.profession), ...arr(prefs.categories).map(str)].filter(Boolean);
    const expTitles = arr(profile.experience).map((e) => str(e && e.title)).filter(Boolean);
    const skills = arr(profile.skills).map(str).filter(Boolean);
    let titlePts;
    let best = 0;
    let bestTerm = "";
    if (!terms.length && !expTitles.length) {
      titlePts = neutralPoints(max * 0.6);
      uncertain.push("Profession is not in the confirmed profile");
    } else {
      const score = (term, w) => {
        const tk = [...new Set(tokens(term))];
        if (!tk.length) return 0;
        if (containsPhrase(titleNorm, term)) return w;
        const jt = new Set(tokens(title));
        const hit = tk.filter((t) => jt.has(t)).length / tk.length;
        if (hit > 0) return w * hit * 0.8;
        return containsPhrase(jobNorm, term) ? w * 0.5 : 0;
      };
      for (const t of terms) {
        const v = score(t, 1);
        if (v > best) { best = v; bestTerm = t; }
      }
      for (const t of expTitles) {
        const v = score(t, 0.7);
        if (v > best) { best = v; bestTerm = t; }
      }
      titlePts = max * 0.6 * best;
      if (best >= 0.5) reasons.push(`Job title matches your profession/experience ("${clip(bestTerm, 60)}")`);
    }
    let skillPts;
    let matched = [];
    if (!skills.length) {
      skillPts = neutralPoints(max * 0.4);
      uncertain.push("No confirmed skills to compare with the ad");
    } else if (!desc && !title) {
      skillPts = neutralPoints(max * 0.4);
      uncertain.push("The ad has no text to compare skills with");
    } else {
      matched = skills.filter((k) => containsPhrase(jobNorm, k));
      skillPts = max * 0.4 * Math.min(1, matched.length / Math.min(skills.length, 5));
      if (matched.length) reasons.push(`Skills found in the ad: ${matched.slice(0, 6).map((x) => clip(x, 40)).join(", ")}`);
    }
    if (best === 0 && skills.length && matched.length === 0 && (terms.length || expTitles.length)) missing.push("No overlap between your profession/skills and this job");
    breakdown.profession = titlePts + skillPts;
  }

  // 2. experience (15)
  {
    const max = WEIGHTS.experience;
    const req = requiredYears(fold(desc));
    const have = candidateYears(profile.experience, now.getUTCFullYear());
    if (req === null) {
      breakdown.experience = neutralPoints(max);
      uncertain.push("Experience requirement is not stated in the ad");
    } else if (have === null) {
      breakdown.experience = neutralPoints(max);
      uncertain.push(`The ad asks for ${req}+ years of experience; your profile has no dated experience to compare`);
    } else if (have >= req) {
      breakdown.experience = max;
      reasons.push(`Experience meets the stated ${req}+ years (profile shows about ${have})`);
    } else {
      breakdown.experience = max * (have / req) * 0.8;
      missing.push(`The ad asks for ${req}+ years of experience; your profile shows about ${have}`);
    }
  }

  // 3. language (15)
  {
    const max = WEIGHTS.language;
    const req = requiredLanguages(list);
    if (req.size === 0) {
      breakdown.language = neutralPoints(max);
      uncertain.push("Language requirement is not stated in the ad");
    } else {
      const held = new Map();
      for (const l of arr(profile.languages)) {
        const name = canonLang(typeof l === "string" ? l : l && l.lang);
        if (name) held.set(name, str(l && l.level));
      }
      let ok = 0;
      for (const [lang, quote] of req) {
        if (!held.has(lang)) missing.push(`Language: ${lang} is required ("${clip(quote, 120)}") but is not in your confirmed languages`);
        else if (held.get(lang) && LOW_LEVEL.test(fold(held.get(lang)))) missing.push(`Language: ${lang} is required but your confirmed level is basic`);
        else {
          ok += 1;
          reasons.push(`Language requirement met: ${lang}`);
        }
      }
      breakdown.language = max * (ok / req.size);
    }
  }

  // 4. location / destination (15)
  let jobCountry = country(job.country);
  {
    const max = WEIGHTS.location;
    const prefCountries = arr(prefs.countries).map(country).filter(Boolean);
    if (!jobCountry && job.location) {
      const locN = normalize(job.location);
      jobCountry = prefCountries.find((c) => containsPhrase(locN, c)) || "";
    }
    if (!prefCountries.length) {
      breakdown.location = neutralPoints(max);
      uncertain.push("No preferred destination in your preferences");
    } else if (!jobCountry) {
      breakdown.location = neutralPoints(max);
      uncertain.push("The ad does not state a country");
    } else if (prefCountries.includes(jobCountry)) {
      breakdown.location = max;
      reasons.push(`Job is in a preferred destination (${clip(str(job.country) || jobCountry, 60)})`);
    } else {
      breakdown.location = 0;
      missing.push("Job is outside your preferred destinations");
    }
  }

  // 5. salary (5). salary_min has no stored unit, so a comparison would rest on a guess: always neutral + uncertain.
  {
    const max = WEIGHTS.salary;
    const pay = parseSalary(list);
    breakdown.salary = neutralPoints(max);
    if (!pay) uncertain.push("Salary is not stated in the ad");
    else if (!pay.period) uncertain.push(`Pay is stated ("${clip(pay.quote, 100)}") but its period (hour/month/year) is unclear`);
    else uncertain.push(`Stated pay is about ${Math.round(pay.annual)} per year (${clip(pay.quote, 100)}); your expected minimum has no stored unit, so it was not compared`);
  }

  // 6. licensing (5)
  {
    const max = WEIGHTS.licensing;
    const req = list.find((s) => LICENCE_CUE.test(s.folded));
    if (!req) {
      breakdown.licensing = neutralPoints(max);
      uncertain.push("Licensing requirement is not stated in the ad");
    } else {
      const certs = arr(profile.certificates).map(str).filter(Boolean);
      const specific = new Set(tokens(req.folded).filter((t) => !LICENCE_GENERIC.has(t)));
      const match = certs.find((c) => tokens(c).some((t) => specific.has(t)));
      if (match) {
        breakdown.licensing = max;
        reasons.push(`Licence/certificate in your profile matches the ad ("${clip(match, 60)}")`);
      } else if (certs.length && specific.size === 0) {
        breakdown.licensing = neutralPoints(max);
        uncertain.push(`The ad requires a licence or certificate ("${clip(req.quote, 100)}"); it is unclear whether yours qualifies`);
      } else {
        breakdown.licensing = 0;
        missing.push(`Licence/certification required ("${clip(req.quote, 120)}") but not found in your confirmed certificates`);
      }
    }
  }

  // 7. overseas / work-authorisation text (5). Never an eligibility claim.
  // Label detection reads the sanitized text BEFORE any sentence dropping: the injection filter must never hide a negative.
  const rawDesc = sanitizeUntrusted(job.description_text ?? job.description);
  const overseas = detectOverseas(rawDesc);
  const employerSupport = detectEmployerSupport(rawDesc, { confirmation: opts.confirmation });
  if (employerSupport.conflict) uncertain.push("Staff confirmation recorded; the advertisement itself says sponsorship is not available \u2014 verify");
  {
    const max = WEIGHTS.overseasAuth;
    const residence = country(prefs.residence_country);
    const local = residence && jobCountry && residence === jobCountry;
    let o;
    if (local) o = 1;
    else if (overseas.accepted === true) {
      o = 1;
      reasons.push(`The ad mentions overseas candidates ("${clip(overseas.evidence, 120)}")`);
    } else if (overseas.accepted === false) {
      o = 0;
      missing.push(`The ad says applicants must already be in the country ("${clip(overseas.evidence, 120)}")`);
    } else {
      o = 0.5;
      uncertain.push("The ad does not say whether candidates from abroad are considered (a vacancy is not proof of overseas hiring)");
    }
    let a;
    if (prefs.needs_work_auth_support === false) a = 1;
    else if (prefs.needs_work_auth_support !== true) {
      a = 0.5;
      uncertain.push("It is unknown whether you need employer support for work authorization");
    } else if (employerSupport.conflict) {
      a = 0.5;
    } else if (employerSupport.label === "confirmed" || employerSupport.label === "stated_in_ad") {
      a = 1;
      reasons.push(`The ad mentions employer support for work authorization ("${clip(employerSupport.evidence, 120)}"); this is not verified`);
    } else if (employerSupport.label === "unavailable") {
      a = 0;
      missing.push(`The ad says work authorization must already be held ("${clip(employerSupport.evidence, 120)}")`);
    } else {
      a = 0.5;
      uncertain.push("Employer support for work authorization is not stated in the ad");
    }
    breakdown.overseasAuth = (max * (o + a)) / 2;
  }

  const total = Object.values(breakdown).reduce((x, y) => x + y, 0);
  const score = Math.max(0, Math.min(100, Math.round(total)));
  for (const k of Object.keys(breakdown)) breakdown[k] = Math.round(breakdown[k] * 10) / 10;
  return { score, reasons, missing, uncertain, overseas, employerSupport, breakdown };
}

module.exports = { scoreMatch, detectEmployerSupport, detectOverseas, sanitizeUntrusted, WEIGHTS, NOTICE, country, neutralize };
