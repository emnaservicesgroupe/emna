// Employer-support and overseas-acceptance detection from ad text (EN/FR).
// Rules: a label other than 'unknown' needs a QUOTED phrase from the ad; explicit negatives win;
// 'confirmed' only comes from a staff/employer confirmation record, never from ad text.
const { sanitizeUntrusted } = require("./sanitize");

const MAX_QUOTE = 300;

// Length-preserving fold (accents removed, curly quotes straightened) so indexes map to the original.
function fold(text) {
  return String(text)
    .split("")
    .map((c) => {
      if (c === "’" || c === "‘") return "'";
      const d = c.normalize("NFD")[0];
      return d && d.length === 1 ? d : c;
    })
    .join("");
}

function sentences(text) {
  const original = String(text || "");
  const folded = fold(original);
  const out = [];
  const re = /[^.!?;\n•]+/g;
  let m;
  while ((m = re.exec(folded))) {
    const raw = original.slice(m.index, m.index + m[0].length);
    const quote = raw.replace(/\s+/g, " ").trim();
    if (quote) out.push({ folded: m[0], quote: quote.length > MAX_QUOTE ? `${quote.slice(0, MAX_QUOTE - 1)}…` : quote });
  }
  return out;
}

// ---- normalisation (linear): markdown/emphasis stripped, label/value lines joined, split into sentences ----
const VALUE_LINE = /^(?:no|n|non|none|nil|n\/a|na|false|not\s+(?:available|offered|provided|applicable|possible|accepted|considered)|unavailable|aucune?|pas\s+disponible|[\u2717\u2718\u00d7x\u2013\u2014-])\W*$/i;
const NEG_START = /^(?:not|no|n't|unavailable|unfortunately|sorry|non|aucune?|pas|cannot|can't)\b/i;
const JOIN_CAP = 500;
const CHUNK = 1500;

function normalizeAd(text) {
  const t = String(text || "").replace(/~~[^~\n]{0,200}~~/g, " ").replace(/[*_`~#>|]/g, " ");
  const lines = [];
  for (const raw of t.split("\n")) {
    const line = raw.replace(/^\s*(?:[-\u2022\u00b7\u2013\u2014]|\d{1,3}[.)])\s+/, "").replace(/[ \t\r]+/g, " ").trim();
    if (line) lines.push(line);
  }
  const joined = [];
  let joinNext = false;
  for (const line of lines) {
    const last = joined.length - 1;
    const words = line.length > 40 ? 99 : line.split(" ").length;
    if (last >= 0 && joined[last].length < JOIN_CAP && (VALUE_LINE.test(line) || joinNext || (joined[last].length < 40 && joined[last].split(" ").length <= 4 && NEG_START.test(line) && words <= 8))) {
      joined[last] += ` ${line}`;
    } else joined.push(line);
    joinNext = /[:?]$/.test(line);
  }
  const out = [];
  for (const line of joined) {
    const folded = fold(line);
    const re = /[^.!;\u2022]+/g;
    let m;
    while ((m = re.exec(folded))) {
      for (let i = 0; i < m[0].length; i += CHUNK) {
        const f = m[0].slice(i, i + CHUNK);
        const q = line.slice(m.index + i, m.index + i + f.length).replace(/\s+/g, " ").trim();
        if (q) out.push({ folded: f, quote: q.length > MAX_QUOTE ? `${q.slice(0, MAX_QUOTE - 1)}\u2026` : q });
      }
    }
  }
  return out;
}

// Benign "pure quantifier" negations stripped BEFORE negation checks ("no experience needed").
const BENIGN = [
  /\bno\s+(?:(?:prior|previous|canadian|relevant|formal|work|specific)\s+)*(?:experience|degree|diploma|education|fees?|costs?|charges?|problems?|issues?|exceptions?|worr(?:y|ies)|training|resume|cv)\b(?:\s+(?:is\s+)?(?:needed|required|necessary))?/gi,
  /\b(?:do|does|did)\s+not\s+require\s+(?:any\s+)?(?:(?:canadian|previous|prior|relevant|formal)\s+)*(?:experience|degree|diploma|education)\b/gi,
  /\bdon'?t\s+worry\b/gi,
  /\bwithout\s+(?:any\s+)?(?:experience|a\s+degree|fees)\b/gi,
];
const benign = (f) => BENIGN.reduce((acc, re) => acc.replace(re, " "), f);

// Negation cues (EN/FR) and "label: value" negative values.
const NEG_CUE = /\b(?:not|no|never|without|cannot|unable|unavailable|unfortunately|none|nor|non|sans|aucune?|pas|won't|can't|don't|doesn't|isn't|aren't|wasn't|weren't|didn't|wouldn't|couldn't|shouldn't|needn't)\b|n't\b|\bneed\s+not\b|\bne\s+(?:\w+\s+){0,3}?pas\b|\bn'(?:\w+\s+){0,3}?pas\b|\bn'(?:\w+\s+){0,3}?(?:aucune?|jamais)\b/i;
const NEG_VALUE = /(?:^|[\s:\u2013\u2014\/(-])(?:[\u2717\u2718\u00d7]|n\/a|n|x|no|non|none|nil)\s*[).]*\s*$/i;
const WEAK_CUE = /\b(?:refused|denied|refuse|refusee|exempt|exempte|exempts|expired|previous|previously|former|formerly|past)\b/i;
const HEDGE = /\b(?:pending|in\s+progress|en\s+cours|may|might|could|if|whether|in\s+the\s+future|was\s+approved|were\s+approved|possible|possibly|potential|potentially|eventually|depending|subject\s+to|sometimes|consider|considered|soon|bientot)\b/i;
const CANDIDATE_REQ = [
  /\b(?:requires?|requiring|required|need|needs|needed)\b(?:\s+\w+){0,3}?\s+(?:(?:an?|their|your|own|the)\s+)*(?:lmia|eimt|work\s+permit|visa|sponsorship)\b/i,
  /\b(?:lmia|eimt|work\s+permit|visa|sponsorship)\s+(?:is\s+|are\s+)?(?:required|needed|requis|requise)\b/i,
  /\b(?:candidates?|applicants?|you|they)\s+(?:must|need\s+to|have\s+to|will\s+need\s+to|should)\s+(?:\w+\s+){0,3}?(?:obtain|apply|get|bring|provide|hold|have|possess|secure)\b[^,]{0,40}\b(?:lmia|eimt|work\s+permit|visa|sponsorship)\b/i,
  /\bapply\s+for\s+(?:an?\s+)?lmia\s+yourself\b/i,
  /\b(?:your|their|own)\s+(?:own\s+)?(?:lmia|eimt|work\s+permit|visa)\b/i,
];

// ---- whole-ad work-authorisation / citizenship restrictions (anywhere in the ad -> unavailable) ----
const RESTRICT = [
  /\bmust\s+(?:already\s+)?(?:be|remain)\s+(?:legally\s+)?(?:eligible|entitled|authori[sz]ed|permitted|able|allowed)\s+to\s+work/i,
  /\b(?:legally\s+)?(?:eligible|entitled|authori[sz]ed|permitted|allowed)\s+to\s+work\s+(?:\w+\s+){0,4}?in\s+(?:canada|the\s+country)/i,
  /\b(?:legal\s+|legally\s+)?right\s+to\s+work\b/i,
  /\bmust\s+(?:already\s+)?(?:have|hold|possess|have\s+obtained)\s+(?:a\s+)?(?:valid\s+)?(?:canadian\s+)?work\s+(?:permit|authori[sz]ation)/i,
  /\bcanadian\s+work\s+(?:authori[sz]ation|permit)\b/i,
  /\bwork\s+(?:authori[sz]ation|permit)\s+(?:is\s+)?(?:required|mandatory)/i,
  /\bpermit\s+holders?\s+only\b/i,
  /\bcanadian\s+citizenship\b/i,
  /\bcitizenship\s+(?:is\s+)?(?:required|mandatory|needed)\b/i,
  /\b(?:pr|permanent\s+residen\w*)\s+or\s+citizenship\b/i,
  /\bmust\s+(?:be|have)\s+(?:a\s+)?(?:canadian\s+)?citizen/i,
  /\bcitizens?\s+(?:or|and|\/)\s+(?:permanent\s+)?residents?\b/i,
  /\bcanadian\s+citizens?\b[^.]{0,40}\b(?:only|permanent\s+residents?)\b/i,
  /\b(?:citizens?|permanent\s+residents?|pr)\s+only\b/i,
  /\bonly\s+canadian\s+citizens?/i,
  /\bcitoyennete\s+canadienne\b/i,
  /\bcitoyens?\s+canadiens?\b[^.]{0,60}\b(?:seulement|uniquement)\b/i,
  /\breserve\s+aux\s+(?:citoyens?|residents?)/i,
  /\b(?:residents?|residentes?)\s+(?:permanents?|canadiens?)\b[^.]{0,30}\b(?:seulement|uniquement)\b/i,
  /\b(?:citoyens?|residents?)\b[^.]{0,40}\b(?:seulement|uniquement)\b/i,
  /\bautorisation\s+de\s+travail\s+(?:valide\s+)?(?:est\s+)?(?:requise|exigee|obligatoire)/i,
  /\b(?:doit|doivent|devez)\s+etre\s+(?:legalement\s+)?(?:autorises?|admissibles?|habilites?)\b[^.]{0,30}travailler/i,
  /\bautorises?\s+a\s+travailler\s+(?:\w+\s+){0,4}?au\s+canada/i,
];
// Explicit "no sponsorship" statements that carry no positive phrase.
const NEGATIVE = [
  /\bno\s+(?:\w+\s+){0,3}?(?:sponsor\w*|visa|lmia|eimt|work\s+permit|immigration)/i,
  /\b(?:aucune?|pas\s+de|sans)\s+(?:\w+\s+){0,2}?(?:parrainage|soutien|eimt|lmia|permis|visa)/i,
  /\b(?:without|sans)\s+(?:an?\s+)?(?:lmia|eimt|visa|sponsor\w*)/i,
];

const POSITIVE = [
  { re: /\blmia\b/i },
  { re: /\beimt\b/i },
  { re: /\bvisa\s+sponsorship\b/i },
  { re: /\bwork\s+(?:permit|visa)\s+sponsorship\b/i },
  { re: /\bimmigration\s+(?:sponsorship|support|assistance)\b/i },
  { re: /\bwe\s+(?:do\s+)?sponsor\s+(?:your\s+|a\s+|the\s+)?(?:work\s+)?(?:permits?|visas?)\b/i },
  { re: /\bwe\s+(?:can\s+|will\s+)?sponsor\s+(?:foreign|international|overseas)\s+(?:workers?|candidates?|employees?|applicants?)\b/i },
  { re: /\b(?:work\s+)?(?:permit|visa)\s+(?:provided|sponsored|support(?:ed)?|assistance)\b/i },
  { re: /\bsponsorship\s+(?:is\s+|are\s+)?(?:available|provided|offered)\b/i, generic: true },
  { re: /\bsoutien\s+a\s+l'immigration\b/i },
  { re: /\bpermis\s+de\s+travail\s+(?:fourni|parraine|offert)/i },
  { re: /\bparrainage\s+(?:disponible|offert|fourni)/i },
  { re: /\bnous\s+parrainons\s+(?:les\s+|des\s+)?(?:permis|visas?|travailleurs)/i },
];
const STRONG_WORD = /\b(?:sponsor\w*|visa|visas|lmia|eimt|immigration|parrainage|work\s+permits?|permis\s+de\s+travail)\b/i;
const RELATED = /\b(?:visa|visas|permit|permits|immigration|lmia|eimt|work\s+authori[sz]ation|travail)\b/i;
const UNRELATED = /\b(?:event|events|festival|festivals|team|teams|sports?|charity|charities|marathon|concert|evenements?|equipes?|caritatif)\b/i;

/** Ad-text classification. Asymmetric safety: doubt resolves to unknown/unavailable, never to stated_in_ad. */
function detectFromAd(description) {
  const list = normalizeAd(sanitizeUntrusted(description));
  let stated = null;
  for (const c of list) {
    const raw = c.folded;
    if (RESTRICT.some((re) => re.test(raw))) return { label: "unavailable", evidence: c.quote };
  }
  for (const c of list) {
    const f = benign(c.folded);
    if (UNRELATED.test(f) && !RELATED.test(f)) continue;
    if (NEGATIVE.some((re) => re.test(f))) return { label: "unavailable", evidence: c.quote };
    const pos = POSITIVE.some((p) => p.re.test(f));
    const strong = STRONG_WORD.test(f);
    if (!pos && !strong) continue;
    if (NEG_CUE.test(f) || NEG_VALUE.test(f)) return { label: "unavailable", evidence: c.quote };
    if (CANDIDATE_REQ.some((re) => re.test(f))) return { label: "unavailable", evidence: c.quote };
    if (!pos) continue;
    if (WEAK_CUE.test(f) || HEDGE.test(f)) continue;
    if (!stated) stated = { label: "stated_in_ad", evidence: c.quote };
  }
  return stated || { label: "unknown", evidence: null };
}

/**
 * @param {string} description ad text
 * @param {{confirmation?: {evidence_text: string}|null}} [opts] a non-revoked js_employer_confirmations row, if any
 * @returns {{label: 'confirmed'|'stated_in_ad'|'unknown'|'unavailable', evidence: string|null, conflict?: true}}
 */
function detectEmployerSupport(description, opts = {}) {
  const ad = detectFromAd(description);
  const conf = opts && opts.confirmation;
  if (conf && typeof conf.evidence_text === "string" && conf.evidence_text.trim()) {
    const out = { label: "confirmed", evidence: sanitizeUntrusted(conf.evidence_text, 1000) };
    if (ad.label === "unavailable") out.conflict = true;
    return out;
  }
  return ad;
}

// ---- overseas acceptance: ANY exclusion anywhere wins over positive wording ----
const PEOPLE = /\b(?:applicants?|candidates?|candidat(?:e)?s?|workers?|hires?|employees?|travailleurs?|recruits?)\b/i;
const OVERSEAS_SUBJECT = /\b(?:abroad|overseas|outside\s+(?:of\s+)?(?:canada|the\s+country)|out\s+of\s+(?:canada|country)|international|foreign|etranger\w*|internationaux|hors\s+(?:du\s+)?canada)\b/i;
const OVERSEAS_NO = [
  /\b(?:must|need\s+to|should|required\s+to|have\s+to)\s+(?:\w+\s+){0,3}?(?:be|reside|live|living|residing|located|based|present|stay|remain)\s+(?:\w+\s+){0,3}?(?:in|within|at)\s+(?:the\s+)?(?:canada|country)\b/i,
  /\bonly\s+(?:\w+\s+){0,3}?(?:currently\s+|already\s+)?(?:living\s+|residing\s+|located\s+|based\s+)?(?:in|within)\s+canada\b/i,
  /\bcurrently\s+(?:be\s+)?(?:located\s+|living\s+|residing\s+|based\s+|present\s+)?(?:in|within)\s+(?:the\s+)?(?:canada|country)\b/i,
  /\bphysically\s+present\b/i,
  /\b(?:local|domestic)\s+(?:candidates?|applicants?|hires?)\s+only\b/i,
  /\bdomestic\s+hires?\b/i,
  /\b(?:canadian\s+)?residents?\s+(?:of\s+canada\s+)?(?:only|seulement|uniquement)\b/i,
  /\bresidents?\s+canadiens?\s+(?:seulement|uniquement)\b/i,
  /\bresidents?\s+du\s+canada\s+(?:seulement|uniquement)\b/i,
  /\bcandidats?\s+locaux\s+(?:seulement|uniquement)\b/i,
  /\bdoi(?:t|vent)\s+(?:\w+\s+){0,3}?(?:resider|habiter|vivre|se\s+trouver|etre\s+(?:situes?|presents?|installes?))\s+(?:\w+\s+){0,2}?(?:au|en|a)\b/i,
];
const WITHIN_CANADA = /\bwithin\s+canada\b/i;
const PREFERENCE = /\b(?:prefer\w*|priority|preference|priorite|privilegi\w*)\b/i;
const OVERSEAS_YES = [
  /\bopen\s+to\s+(?:international|overseas|foreign)\s+(?:applicants?|candidates?)\b/i,
  /\b(?:international|overseas|foreign)\s+(?:applicants?|candidates?)\s+(?:are\s+)?(?:welcome|encouraged|accepted|considered)\b/i,
  /\b(?:applicants?|candidates?)\s+(?:from\s+)?(?:abroad|overseas|outside\s+(?:of\s+)?canada)\b/i,
  /\bwe\s+welcome\s+(?:applications?\s+from\s+)?(?:international|overseas|foreign)\b/i,
  /\brelocation\s+(?:assistance\s+|support\s+|package\s+)?(?:is\s+|are\s+)?(?:provided|offered|available|included)\b/i,
  /\brelocation\s+(?:provided|offered)\b/i,
  /\bouvert\s+aux\s+candidat(?:e)?s?\s+(?:internationaux|etrangers|de\s+l'etranger)\b/i,
  /\b(?:relocalisation|demenagement)\s+(?:fournie?|offerte?|prise\s+en\s+charge)\b/i,
];

/** accepted: true | false | null. true only on explicit positive wording with no exclusion anywhere. */
function detectOverseas(description) {
  const list = normalizeAd(sanitizeUntrusted(description));
  let preference = false;
  for (const c of list) {
    const f = benign(c.folded);
    const relocation = /\brelocat\w*|\bdemenag\w*/i.test(f);
    if (OVERSEAS_NO.some((re) => re.test(f))) {
      const m = OVERSEAS_NO.map((re) => re.exec(f)).find(Boolean);
      // "must be eligible to work in Canada" is work authorisation, not a residence requirement.
      if (!/\b(?:eligib|authori|entitled|permitted|able|legally)\w*/i.test(m[0])) return { accepted: false, evidence: c.quote };
    }
    if (WITHIN_CANADA.test(f) && (PEOPLE.test(f) || relocation)) return { accepted: false, evidence: c.quote };
    if (OVERSEAS_SUBJECT.test(f) && PEOPLE.test(f) && !relocation && (NEG_CUE.test(f) || NEG_VALUE.test(f))) return { accepted: false, evidence: c.quote };
    if (PREFERENCE.test(f) && /\b(?:canadian|local|resident|residents|canada)\b/i.test(f)) preference = true;
  }
  if (preference) return { accepted: null, evidence: null };
  for (const c of list) {
    const f = benign(c.folded);
    if (NEG_CUE.test(f) || NEG_VALUE.test(f) || WEAK_CUE.test(f) || /\b(?:pending|might|could|if|unless)\b/i.test(f)) continue;
    if (OVERSEAS_YES.some((re) => re.test(f))) return { accepted: true, evidence: c.quote };
  }
  return { accepted: null, evidence: null };
}

const clauses = normalizeAd;
module.exports = { detectEmployerSupport, detectOverseas, sentences, clauses, normalizeAd, fold };
