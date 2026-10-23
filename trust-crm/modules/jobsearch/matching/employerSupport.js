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

// ---- employer support ----
const NEGATIVE = [
  /\bmust\s+(?:already\s+)?(?:be\s+)?(?:legally\s+)?(?:eligible|authori[sz]ed|entitled|able|permitted)\s+to\s+work\s+in\s+(?:canada|the\s+country)/i,
  /\b(?:legally\s+)?(?:eligible|authori[sz]ed)\s+to\s+work\s+in\s+canada\s+(?:is\s+)?(?:required|mandatory)/i,
  /\bmust\s+(?:already\s+)?(?:have|hold|possess|have\s+obtained)\s+(?:a\s+)?(?:valid\s+)?(?:canadian\s+)?work\s+(?:permit|authori[sz]ation)/i,
  /\bwork\s+(?:authori[sz]ation|permit)\s+(?:is\s+)?required/i,
  /\bno\s+(?:visa\s+|work\s+permit\s+|immigration\s+)?sponsorship\b/i,
  /\bsponsorship\s+(?:is\s+|are\s+)?(?:not|un)\s*(?:available|provided|offered)/i,
  /\b(?:do|does|will)\s+not\s+(?:offer|provide|sponsor|support)\b[^.]{0,40}(?:sponsorship|visa|work\s+permit|lmia|immigration)/i,
  /\b(?:unable|cannot|can't|not\s+able)\s+to\s+sponsor\b/i,
  /\bno\s+lmia\b/i,
  /\blmia\s+(?:is\s+)?(?:not|un)\s*(?:available|provided|offered|approved)/i,
  /\bcanadian\s+citizens?\b[^.]{0,40}\b(?:only|permanent\s+residents?)\b/i,
  /\b(?:citizens?|permanent\s+residents?|pr)\s+only\b/i,
  /\bcitoyens?\s+canadiens?\b[^.]{0,60}\b(?:seulement|uniquement)\b/i,
  /\b(?:residents?|residentes?)\s+permanents?\b[^.]{0,30}\b(?:seulement|uniquement)\b/i,
  /\b(?:citoyens?|residents?)\b[^.]{0,40}\b(?:seulement|uniquement)\b/i,
  /\bautorisation\s+de\s+travail\s+(?:valide\s+)?(?:est\s+)?(?:requise|exigee|obligatoire)/i,
  /\b(?:doit|devez|doivent)\s+etre\s+(?:legalement\s+)?(?:autorise|admissible|habilite)[^.]{0,30}travailler\s+au\s+canada/i,
  /\b(?:aucun|pas\s+de|sans)\s+(?:parrainage|soutien\s+a\s+l'immigration|eimt|permis\s+de\s+travail)/i,
];

const POSITIVE = [
  { re: /\blmia\b/i, lmia: true },
  { re: /\beimt\b/i, lmia: true },
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

const UNRELATED = /\b(?:event|events|festival|festivals|team|teams|sports?|charity|charities|marathon|concert|evenements?|equipes?|caritatif)\b/i;
const NEG_BEFORE = /(?:\bno|\bnot|\bwithout|\bnon|\bnever|n't|\bsans|\bpas\s+de|\baucune?)[ ]+(?:\w+[ ]+)?$/i;
const NEG_AFTER = /^\W{0,3}(?:(?:is|are|est|sont)\s+)?(?:not|n't|non|pas|unavailable|exempt|required|requis|requise)\b/i;

function negated(sentence, idx, len, lmia) {
  const before = sentence.slice(Math.max(0, idx - 25), idx);
  const after = sentence.slice(idx + len, idx + len + 25);
  if (NEG_BEFORE.test(before)) return true;
  if (lmia && NEG_AFTER.test(after)) return true;
  if (!lmia && /^\W{0,3}(?:not|n't|unavailable)\b/i.test(after)) return true;
  return false;
}

/**
 * @param {string} description ad text
 * @param {{confirmation?: {evidence_text: string}|null}} [opts] a js_employer_confirmations row, if any
 * @returns {{label: 'confirmed'|'stated_in_ad'|'unknown'|'unavailable', evidence: string|null}}
 */
function detectEmployerSupport(description, opts = {}) {
  const conf = opts && opts.confirmation;
  if (conf && typeof conf.evidence_text === "string" && conf.evidence_text.trim()) {
    return { label: "confirmed", evidence: sanitizeUntrusted(conf.evidence_text, 1000) };
  }
  const list = sentences(sanitizeUntrusted(description));
  for (const s of list) {
    if (NEGATIVE.some((re) => re.test(s.folded))) return { label: "unavailable", evidence: s.quote };
  }
  for (const s of list) {
    for (const p of POSITIVE) {
      const m = p.re.exec(s.folded);
      if (!m) continue;
      if (negated(s.folded, m.index, m[0].length, p.lmia)) continue;
      if (p.generic && UNRELATED.test(s.folded) && !/\b(?:visa|permit|immigration|lmia|work|travail)\b/i.test(s.folded)) continue;
      return { label: "stated_in_ad", evidence: s.quote };
    }
  }
  return { label: "unknown", evidence: null };
}

// ---- overseas acceptance ----
const OVERSEAS_NO = [
  /\b(?:canadian\s+)?residents?\s+(?:of\s+canada\s+)?only\b/i,
  /\bmust\s+(?:currently\s+|already\s+)?(?:reside|live)\s+in\b/i,
  /\bmust\s+(?:currently\s+|already\s+)?be\s+(?:located|based|living|residing|present|resident)\s+(?:in|within)\b/i,
  /\bmust\s+be\s+currently\s+in\s+canada\b/i,
  /\b(?:local|domestic)\s+(?:candidates?|applicants?)\s+only\b/i,
  /\bno\s+(?:relocation|international\s+(?:applicants?|candidates?))\b/i,
  /\bnot\s+(?:open|accepting)\b[^.]{0,30}\b(?:international|overseas|foreign|abroad)\b/i,
  /\b(?:doit|devez)\s+(?:deja\s+)?(?:resider|habiter|vivre)\s+(?:au|en|a)\b/i,
  /\bresidents?\s+du\s+canada\s+(?:seulement|uniquement)\b/i,
  /\bcandidats?\s+locaux\s+(?:seulement|uniquement)\b/i,
];
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

/** accepted: true | false | null (null = ad says nothing explicit; a vacancy is not proof of overseas hiring). */
function detectOverseas(description) {
  const list = sentences(sanitizeUntrusted(description));
  for (const s of list) {
    if (OVERSEAS_NO.some((re) => re.test(s.folded))) return { accepted: false, evidence: s.quote };
  }
  for (const s of list) {
    for (const re of OVERSEAS_YES) {
      const m = re.exec(s.folded);
      if (m && !negated(s.folded, m.index, m[0].length, false)) return { accepted: true, evidence: s.quote };
    }
  }
  return { accepted: null, evidence: null };
}

module.exports = { detectEmployerSupport, detectOverseas, sentences, fold };
