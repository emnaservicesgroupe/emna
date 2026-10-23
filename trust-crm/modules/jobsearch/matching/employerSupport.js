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

// ---- clause splitting: '?' and ':' stay inside a clause ("Work permit provided? No", "LMIA: no") ----
function clauses(text) {
  const original = String(text || "");
  const folded = fold(original);
  const out = [];
  const re = /[^.!;\n•,]+/g;
  let m;
  while ((m = re.exec(folded))) {
    const quote = original.slice(m.index, m.index + m[0].length).replace(/\s+/g, " ").trim();
    if (quote) out.push({ folded: m[0], quote: quote.length > MAX_QUOTE ? `${quote.slice(0, MAX_QUOTE - 1)}…` : quote });
  }
  return out;
}

// Negation cues (EN/FR). NEG -> the clause denies something; WEAK -> the clause is not a statement of availability.
const NEG_CUE = /\b(?:not|no|never|without|cannot|unable|unavailable|none|nor|non|sans|aucune?|pas|won't|can't|don't|doesn't|isn't|aren't|wasn't|weren't|didn't|wouldn't|couldn't|shouldn't)\b|n't\b|\bne\s+(?:\w+\s+){0,3}?pas\b|\bn'(?:\w+\s+){0,3}?pas\b/i;
const WEAK_CUE = /\b(?:refused|denied|rejected|expired|exempt|exempte|exempts|required|requis|requise|refuse|refusee|previous|former|past)\b/i;
const NO_FALSE_NEG = /\bno\s+(?:problem|problems|issue|issues|worries|worry)\b/gi;

// ---- employer support ----
// Explicit negatives (also matched per clause).
const NEGATIVE = [
  /\bmust\s+(?:already\s+)?(?:be\s+)?(?:legally\s+)?(?:eligible|authori[sz]ed|entitled|able|permitted)\s+to\s+work\s+in\s+(?:canada|the\s+country)/i,
  /\b(?:legally\s+)?(?:eligible|authori[sz]ed)\s+to\s+work\s+in\s+canada\s+(?:is\s+)?(?:required|mandatory)/i,
  /\b(?:legal\s+)?right\s+to\s+work\s+in\s+(?:canada|the\s+country)/i,
  /\bmust\s+(?:already\s+)?(?:have|hold|possess|have\s+obtained)\s+(?:a\s+)?(?:valid\s+)?(?:canadian\s+)?work\s+(?:permit|authori[sz]ation)/i,
  /\bwork\s+(?:authori[sz]ation|permit)\s+(?:is\s+)?required/i,
  /\bmust\s+be\s+(?:a\s+)?canadian\s+(?:citizens?|residents?)/i,
  /\bcanadian\s+citizens?\b[^.]{0,40}\b(?:only|permanent\s+residents?)\b/i,
  /\b(?:citizens?|permanent\s+residents?|pr)\s+only\b/i,
  /\bonly\s+canadian\s+citizens?/i,
  /\bcitoyens?\s+canadiens?\b[^.]{0,60}\b(?:seulement|uniquement)\b/i,
  /\breserve\s+aux\s+(?:citoyens?|residents?)/i,
  /\b(?:residents?|residentes?)\s+permanents?\b[^.]{0,30}\b(?:seulement|uniquement)\b/i,
  /\b(?:citoyens?|residents?)\b[^.]{0,40}\b(?:seulement|uniquement)\b/i,
  /\bautorisation\s+de\s+travail\s+(?:valide\s+)?(?:est\s+)?(?:requise|exigee|obligatoire)/i,
  /\b(?:doit|devez|doivent)\s+etre\s+(?:legalement\s+)?(?:autorise|admissible|habilite)[^.]{0,30}travailler\s+au\s+canada/i,
  /\b(?:aucun|aucune|pas\s+de|sans)\s+(?:\w+\s+){0,2}?(?:parrainage|soutien|eimt|lmia|permis|visa)/i,
  /\bno\s+(?:\w+\s+){0,3}?(?:sponsor\w*|visa|lmia|eimt|work\s+permit|immigration)/i,
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

const SPONSOR_WORD = /\b(?:sponsor\w*|visa|visas|work\s+permits?|permits?|lmia|eimt|immigration|parrainage|permis\s+de\s+travail|soutien|support)\b/i;
const RELATED = /\b(?:visa|visas|permit|permits|immigration|lmia|eimt|work\s+authori[sz]ation|travail)\b/i;
const UNRELATED = /\b(?:event|events|festival|festivals|team|teams|sports?|charity|charities|marathon|concert|evenements?|equipes?|caritatif)\b/i;

/**
 * @param {string} description ad text
 * @param {{confirmation?: {evidence_text: string}|null}} [opts] a non-revoked js_employer_confirmations row, if any
 * @returns {{label: 'confirmed'|'stated_in_ad'|'unknown'|'unavailable', evidence: string|null, conflict?: true}}
 */
function detectFromAd(description) {
  const text = sanitizeUntrusted(description);
  let stated = null;
  for (const s of sentences(text)) {
    if (NEGATIVE.some((re) => re.test(s.folded))) return { label: "unavailable", evidence: s.quote };
  }
  for (const c of clauses(text)) {
    const f = c.folded.replace(NO_FALSE_NEG, " ");
    if (UNRELATED.test(f) && !RELATED.test(f)) continue;
    if (NEGATIVE.some((re) => re.test(f))) return { label: "unavailable", evidence: c.quote };
    const pos = POSITIVE.some((p) => p.re.test(f));
    const sponsorish = pos || SPONSOR_WORD.test(f);
    if (!sponsorish) continue;
    if (NEG_CUE.test(f)) {
      // "support"/"permit" alone are weak words: only treat as a denial when a real sponsorship term is present.
      if (pos || /\b(?:sponsor\w*|visa|visas|lmia|eimt|immigration|parrainage)\b/i.test(f)) return { label: "unavailable", evidence: c.quote };
      continue;
    }
    if (!pos) continue;
    if (WEAK_CUE.test(f)) continue;
    if (!stated) {
      const generic = POSITIVE.filter((p) => p.re.test(f)).every((p) => p.generic);
      if (generic && UNRELATED.test(f) && !RELATED.test(f)) continue;
      stated = { label: "stated_in_ad", evidence: c.quote };
    }
  }
  return stated || { label: "unknown", evidence: null };
}

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

// ---- overseas acceptance ----
const OVERSEAS_SUBJECT = /\b(?:abroad|overseas|outside\s+(?:of\s+)?(?:canada|the\s+country)|out\s+of\s+(?:canada|country)|international|foreign|etranger|hors\s+(?:du\s+)?canada)\b/i;
const OVERSEAS_NO = [
  /\b(?:canadian\s+)?residents?\s+(?:of\s+canada\s+)?only\b/i,
  /\bmust\s+(?:currently\s+|already\s+)?(?:reside|live)\s+in\b/i,
  /\bmust\s+(?:currently\s+|already\s+)?be\s+(?:located|based|living|residing|present|resident)\s+(?:in|within)\b/i,
  /\bcurrently\s+(?:be\s+)?(?:located\s+|living\s+|residing\s+|based\s+|present\s+)?in\s+(?:canada|the\s+country)\b/i,
  /\b(?:local|domestic)\s+(?:candidates?|applicants?)\s+only\b/i,
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

/** accepted: true | false | null (null = nothing explicit; a vacancy is not proof of overseas hiring; relocation not offered is not an exclusion). */
function detectOverseas(description) {
  const list = clauses(sanitizeUntrusted(description));
  for (const c of list) {
    const f = c.folded.replace(NO_FALSE_NEG, " ");
    if (OVERSEAS_NO.some((re) => re.test(f))) return { accepted: false, evidence: c.quote };
    if (OVERSEAS_SUBJECT.test(f) && !/\brelocat\w*|\bdemenag\w*/i.test(f) && (NEG_CUE.test(f) || /\b(?:need\s+not|ne\s+sont\s+pas)\b/i.test(f))) {
      return { accepted: false, evidence: c.quote };
    }
  }
  for (const c of list) {
    const f = c.folded.replace(NO_FALSE_NEG, " ");
    if (NEG_CUE.test(f) || WEAK_CUE.test(f)) continue;
    if (OVERSEAS_YES.some((re) => re.test(f))) return { accepted: true, evidence: c.quote };
  }
  return { accepted: null, evidence: null };
}

module.exports = { detectEmployerSupport, detectOverseas, sentences, clauses, fold };
