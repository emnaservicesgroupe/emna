// Employer-support and overseas-acceptance detection from ad text (EN/FR).
// Rules: a label other than 'unknown' needs a QUOTED phrase from the ad; explicit negatives win;
// 'confirmed' only comes from a staff/employer confirmation record, never from ad text.
//
// Allowlist design (asymmetric safety). `stated_in_ad` needs an AFFIRMATIVE allowlisted phrase and
// no veto; bare mentions ("LMIA", "Visa sponsorship?") are `unknown`. A false stated_in_ad /
// accepted:true is far worse than a false unknown/null/unavailable, so every doubt resolves away
// from "yes". Vetoes are grouped by category: who holds it (candidate-held LMIA/permit), scope
// (other roles/locations/subsets), time (past/future/stopped), condition (right candidate, conditions
// apply), cost (fees/deductions/dollar amounts), third party (agency/partner/lawyer), negation,
// hedge, reported speech/corrections, duties context, unrelated "sponsor" senses, checklist boxes.
const { sanitizeUntrusted } = require("./sanitize");

const MAX_QUOTE = 300;
// Input is capped BEFORE NFKC (stored descriptions are <= 20k chars) and again after it: NFKC can
// expand one code point into 18 (U+FDFA), so the second cap bounds the work per call.
const PRE_CAP = 30000;
const POST_CAP = 40000;

// ---- canonical text (linear) ----
const INVISIBLE = /[\u00ad\u2060\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u180e\u061c]/g;
const EXOTIC_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u0009\u000b\u000c]/g;
const LINE_SEP = /[\r\u0085\u2028\u2029]/g;
const CONFUSABLE = { "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x", "\u0443": "y", "\u043a": "k", "\u043d": "h", "\u0442": "t", "\u043c": "m", "\u0456": "i", "\u0455": "s", "\u03bf": "o", "\u03bd": "v", "\u2018": "'", "\u2019": "'", "\u00b4": "'", "`": "'" };
const UNCHECKED = "\u2610"; // canonical "unchecked box" marker: never affirmative
const FOOTNOTE = "\u2020"; // canonical footnote marker ("Yes*"): the value is qualified elsewhere

function foldChar(c) {
  let l = c.toLowerCase();
  if (l.length !== 1) l = c;
  const d = l.normalize("NFD");
  if (d.length > 0 && d[0].length === 1) l = d[0];
  return CONFUSABLE[l] || l;
}
const foldAligned = (str) => {
  let out = "";
  for (let i = 0; i < str.length; i += 1) out += foldChar(str[i]);
  return out;
};

// ---- structure: lines -> joined label/value lines -> sentences ----
const VALUE_LINE = /^(?:no|n|non|none|nil|nope|nein|zero|0|false|n\/a|n\.a\.?|na|unavailable|aucune?|\u274c|\ud83d\udeab|\u2717|\u2718|\u00d7|x|-|\u2013|\u2014|not\b.{0,30}|non\b.{0,20}|unfortunately.{0,40}|sorry.{0,30}|a\s*:\s*no.{0,20})\W{0,4}$/i;
const NEG_START = /^(?:not|no|n't|unavailable|unfortunately|sorry|non|aucune?|pas|cannot|can't|nope)\b/i;
const REQ_HEAD = /^(?:requirements?|qualifications?|exigences?|conditions\s+requises|prerequis|must\s+have|you\s+must\s+have|what\s+you(?:'ll)?\s+need|ce\s+que\s+vous\s+devez|exige)\b(?:[^:\n]{0,30}:\s*|\s*$)/i;
const OFFER_HEAD = /^(?:benefits?|what\s+we\s+offer|we\s+offer|perks?|avantages?|nous\s+offrons|ce\s+que\s+nous\s+offrons|we\s+provide|compensation(?:\s+and\s+benefits)?|package)\b(?:[^:\n]{0,30}:\s*|\s*$)/i;
const NEGATED_HEAD = /\b(?:non|not|no|pas|excluded|exclus|n'|aucun\w*|without|sans|unavailable)\b/i;
const TAG_HEAD = /^(?:tags?|keywords?|seo|mots[- ]cles|etiquettes|hashtags?|search\s+terms|categories)\s*:\s*/i;
const OTHER_HEAD = /^(?:about|responsibilit\w*|dut(?:y|ies)|description|summary|job\s+summary|your\s+role|tasks?|how\s+to\s+apply|apply|taches|responsabilites)\b(?:[^:\n]{0,30}:\s*|\s*$)/i;
// A section header sharing a line with other text ("...Vancouver. Perks:", "About you: ... What we offer: ...") starts a new line.
const INLINE_HEAD = /(\S)[ \t]+(?=(?:perks?|benefits?|what\s+we\s+offer|ce\s+que\s+nous\s+offrons|avantages?|requirements?|qualifications?|exigences?|about\s+you|about\s+the\s+role|responsibilities|how\s+to\s+apply)\s*:)/gi;
// "We offer visa sponsorship: ..." / "Nous offrons un soutien à l'immigration : ...": a header line that already
// names the support is a statement, not just a section title, so its text is kept.
const HEAD_NAMES_SUPPORT = /\b(?:visas?|lmias?|eimts?|immigration|sponsor\w*|parrain\w*|permis|work\s+permits?)\b/;
const JOIN_CAP = 500;
const CHUNK = 1500;

let cacheKey = null;
let cacheVal = null;

/** @returns {{list: {f: string, q: string, req: boolean, offer: boolean}[], truncated: boolean}} */
function prepare(description) {
  const input = String(description === null || description === undefined ? "" : description);
  if (cacheKey === input) return cacheVal;
  let truncated = input.length > PRE_CAP;
  let t = truncated ? input.slice(0, PRE_CAP) : input;
  t = t.normalize("NFKC");
  if (t.length > POST_CAP) { t = t.slice(0, POST_CAP); truncated = true; }
  t = t.replace(LINE_SEP, "\n").replace(INVISIBLE, "").replace(EXOTIC_SPACE, " ");
  t = sanitizeUntrusted(t, POST_CAP);
  t = t.replace(/\[\s?\]|[\u2610\u25a1\u2b1c\u274f\u2751\u2612]/g, ` ${UNCHECKED} `).replace(/\[[xX\u2713\u2714]\]|[\u2611]/g, " ");
  t = t.replace(/~~[^~\n]{0,200}~~/g, " ").replace(/[\u0334-\u0338]+/g, ` ${FOOTNOTE} `); // combining strike/overlay: struck text
  t = t.replace(/(?<![*\w])\*(?=[^\s*])([^*\n]{1,80}?)(?<=[^\s*])\*(?![*\w])/g, "$1"); // *italic*
  t = t.replace(/([\w)])\*(?!\*)/g, `$1 ${FOOTNOTE}`); // "Yes*" footnote
  t = t.replace(/[*_`~#>]/g, " ").replace(/\|/g, " : ").replace(/\.{2,}|\u2026/g, " \u2026 ").replace(INLINE_HEAD, "$1\n");
  const lines = [];
  let mode = "none";
  let par = 0;
  let sec = 0;
  for (const raw of t.split("\n")) {
    let line = raw.replace(/^\s*(?:[-\u2022\u00b7\u2013\u2014]|\d{1,3}[.)])\s+/, "").replace(/[ \t]+/g, " ").trim();
    if (!line || /^[\s:\-\u2013\u2014]+$/.test(line)) { par += 1; continue; }
    const f0 = foldAligned(line);
    let m;
    if ((m = REQ_HEAD.exec(f0))) { mode = "req"; sec += 1; line = line.slice(m[0].length).trim(); }
    else if ((m = OFFER_HEAD.exec(f0))) { mode = NEGATED_HEAD.test(m[0]) ? "none" : "offer"; sec += 1; if (!HEAD_NAMES_SUPPORT.test(m[0])) line = line.slice(m[0].length).trim(); }
    else if ((m = OTHER_HEAD.exec(f0))) { mode = "none"; sec += 1; line = line.slice(m[0].length).trim(); }
    else if ((m = TAG_HEAD.exec(f0))) { mode = "tag"; sec += 1; line = line.slice(m[0].length).trim(); }
    else if (/:$/.test(line) && line.split(" ").length <= 5 && !/\?$/.test(line)) { mode = "none"; sec += 1; }
    if (!line) continue;
    lines.push({ line, mode, par, sec });
  }
  const joined = [];
  let joinNext = false;
  for (const { line, mode: md, par: pa, sec: se } of lines) {
    const last = joined.length - 1;
    const short = line.length <= 60;
    if (last >= 0 && joined[last].text.length < JOIN_CAP && ((short && VALUE_LINE.test(line)) || joinNext || (joined[last].text.length < 40 && joined[last].text.split(" ").length <= 4 && NEG_START.test(line) && line.length <= 60))) {
      joined[last].text += ` ${line}`;
    } else joined.push({ text: line, mode: md, par: pa, sec: se });
    joinNext = /[:?]$/.test(line);
  }
  const list = [];
  for (const { text, mode: md, par: pa, sec: se } of joined) {
    const f = foldAligned(text);
    let start = 0;
    const re = /(?<=[.!;])\s+/g;
    const cuts = [];
    let m;
    while ((m = re.exec(f))) cuts.push([start, m.index]), (start = m.index + m[0].length);
    cuts.push([start, f.length]);
    for (const [a, b] of cuts) {
      for (let i = a; i < b; i += CHUNK) {
        const fs = f.slice(i, Math.min(b, i + CHUNK));
        const q = text.slice(i, Math.min(b, i + CHUNK)).replace(/\s+/g, " ").trim().replace(/[.!;]+$/, "").trim();
        if (q.length > 0 && fs.trim()) list.push({ f: fs, q: q.length > MAX_QUOTE ? `${q.slice(0, MAX_QUOTE - 1)}\u2026` : q, req: md === "req", offer: md === "offer", tag: md === "tag", par: pa, sec: se });
      }
    }
  }
  cacheKey = input;
  cacheVal = { list, truncated };
  return cacheVal;
}

// ---- cue lists (all matched on accent-folded, lower-cased text) ----
const BENIGN = [
  /\bno\s+(?:(?:prior|previous|canadian|relevant|formal|work|specific|software|our|agency|placement|recruitment|recruiting|hidden|application|processing|upfront|up-front|extra)\s+)*(?:experience|degree|diploma|education|fees?|costs?|charges?|problems?|issues?|exceptions?|worr(?:y|ies)|training|resume|cv|weekends?|nights?|tips?|remote(?:\s+work)?|dull)\b(?:\s+(?:is\s+|are\s+)?(?:needed|required|necessary|charged))?/g,
  /\b(?:do|does|did)\s+not\s+require\s+(?:any\s+)?(?:(?:canadian|previous|prior|relevant|formal)\s+)*(?:experience|degree|diploma|education)\b/g,
  /\bdon'?t\s+(?:worry|just)\b/g,
  /\bnot\s+(?:only|just|merely)\b/g,
  /\bnot\s+an?\s+(?:remote|office|desk|part[- ]time|seasonal|entry|temporary)\b/g,
  /\bnever\s+a\s+dull\b/g,
  /\bnon[- ](?:profit|union\w*|smok\w*|remote|toxic|negotiable|stop|slip)\b/g,
  /\bwithout\s+(?:any\s+)?(?:experience|a\s+degree|fees|worry|stress)\b/g,
  /\bnot\s+required\s*:\s*(?:canadian\s+)?(?:experience|degree|diploma)/g,
  /\b(?:sans|aucuns?)\s+frais\b(?:\s+(?:pour\s+(?:vous|le\s+candidat|les\s+candidats)))?/g,
];
const benign = (f) => BENIGN.reduce((acc, re) => acc.replace(re, " "), f);

const NEG_CUE = /\b(?:not|no|never|without|cannot|unable|unavailable|none|nor|non|nope|nein|zero|neither|exclu\w*|declin\w*|sans|aucune?|pas|jamais|false|unlikely|rarely|rarement|reject\w*|forbidden|interdit\w*)\b|n't\b|\bne\s+(?:\w+\s+){0,3}?(?:pas|plus|jamais|aucune?|guere|nullement)\b|\bn'(?:\w+\s+){0,3}?(?:pas|aucune?|jamais|plus)\b|\bneed\s+not\b|\bout\s+of\s+(?:the\s+)?(?:question|scope)\b|\boff\s+the\s+(?:table|cards)\b|\bbeyond\b|\u274c|\ud83d\udeab|\u2717|\u2718|\u00d7|\u26d4|\u2715|\u2716|\u274e|\ud83d\udc4e|\ud83d\uded1|\u2298/;
const NEG_VALUE = /(?:^|[\s:\u2013\u2014\/(\[=>-])(?:\u274c|\ud83d\udeab|\u2717|\u2718|\u00d7|x|n|no|non|nope|nein|0|false|none|nil|n\/a|n\.a\.?|na|-)[\s).\]!]*$/;
// hedge / time / condition: the statement is not a present, unconditional offer
const HEDGE = /\b(?:tbd|tba|to\s+be\s+(?:discussed|confirmed|determined|decided)|a\s+(?:confirmer|discuter)|negotiable|negociable|ask\s+(?:hr|us|the|about)|ask\b[^.]{0,15}\babout|case[- ]by[- ]case|cas\s+par\s+cas|discretion|subject\s+to|sous\s+reserve|upon\s+(?:request|approval|successful|completion)|selon|depending|depend\w*|may|might|could|would|pourrait|pourraient|peut-etre|maybe|perhaps|if|once|when|lorsque|une\s+fois|quand|si|after\s+(?:probation|\d|the\s+first|your\s+first|first|completing|six|one\s+year|a\s+year|[a-z]+\s+months?)|apres|eligible\s+after|hoping|hope|hopes|planned|planning|expected|pending|awaited|await\w*|en\s+cours|applied\s+for|in\s+progress|future|next\s+(?:year|quarter|month|season|spring|summer|fall|winter)|later|eventually|possible|possibly|sometimes|limited|(?:was|were)\s+(?:approved|offered|issued|obtained|granted|available)|(?:19|20)\d\d|last\s+(?:year|month|week|season|spring|summer|fall|autumn|winter|quarter)|l'an\s+dernier|l'annee\s+derniere|renewal|renouvel\w*|underway|ended|has\s+ended|pris\s+fin|temporar\w*|previously|formerly|previous|past|former|refused|denied|withdrawn|discontinued|expired|exempt|exempte|probation|exceptional|exceptionnel\w*|not\s+guaranteed|upon|until|unless|on\s+condition|used\s+to|no\s+(?:more|longer)|anymore|any\s+longer|stopp\w*|paus\w*|on\s+hold|suspend\w*|ceas\w*|halt\w*|frozen|freeze|auparavant|autrefois|dans\s+le\s+passe|plus\s+maintenant|n'?est\s+plus|offrions|avions|soon|bientot|down\s+the\s+road|someday|one\s+day|in\s+time|wish\w*|would\s+(?:like|love)|aimerions|aimerait|souhait\w*|(?:aim|aims|aiming|intend|intends|intending|plan|plans)\s+to|our\s+(?:goal|aim|objective|hope|ambition)|objectif|ambition|can\s+include|peu\w*\s+inclure|potential(?:ly)?|potentiel\w*|possibilit\w*|path(?:way)?\s+(?:to|toward)|chance\s+(?:of|for|to)|explor\w*|consider\w*|discuss\w*|discussion|discuter|try\s+to|tenter|essayer|best\s+efforts?|generally|usually|often|typically|in\s+most\s+cases|generalement|normalement|souvent|habituellement|as\s+(?:needed|required|applicable)|where\s+(?:applicable|eligible|possible|appropriate|needed|required)|correction|erratum|kidding|mistake|in\s+error|see\s+(?:the\s+)?(?:notes?|below|above|faq|details|footnotes?|terms)|voir\s+(?:ci-dessous|les\s+notes?|conditions)|details\s+(?:below|to\s+follow)|where|whenever|working\s+on)\b|[\u2610\u2020]/;
const CONDITION = /\bthe\s+right\s+(?:candidate|person|applicant|individual|fit|hire|profile|people|talent)\b|\ble\s+bon\s+(?:candidat|profil)|\bla\s+bonne\s+(?:personne|candidate)|\b(?:exceptional|outstanding|top|strong|best|star|high[- ]performing|stellar|standout)\s+(?:candidates?|applicants?|performers?|talent|people|individuals?|hires?|profiles?)\b|\bconditions?\s+(?:apply|applies|applicables?|s'appliquent|may\s+apply)\b|\bsous\s+(?:certaines\s+)?conditions?\b|\bcertain\s+conditions\b|\bif\s+(?:eligible|applicable|required|needed|necessary)\b|\bopportunit\w*\s+(?:for|of|to|de|d')|\b(?:lmia|eimt|visa|sponsorship|parrainage)\s+(?:\w+\s+)?opportunit\w*|\bselect(?:ed)?\s+(?:roles?|positions?|postes?|jobs?|cases?|occupations?)\b|\b(?:certain|some|specific|eligible|qualifying|particular|designated)\s+(?:roles?|positions?|postes?|jobs?|cases?|occupations?|candidates?|applicants?)\b|\bcertains\s+(?:postes|cas|candidats)\b|\bin\s+(?:some|certain|limited|rare|special)\s+cases\b|\bper[- ](?:role|position|case|candidate|poste)\b|\b(?:role|case|position)[- ]by[- ](?:role|case|position)\b|\bon\s+an?\s+(?:[\w-]+\s+)?basis\b|\bau\s+(?:besoin|cas\s+par\s+cas)\b|\bsi\s+(?:necessaire|requis|besoin)\b|\ble\s+cas\s+echeant\b|\bto\s+(?:those|anyone|candidates?|applicants?|workers?|people|employees?|individuals?)\s+(?:who|that|willing|able|prepared)\b|\bwho\s+(?:commit|agree|sign|stay|remain|pass|complete|qualify|score|meet)\w*\b|\b(?:commit\w*|engag\w*)\s+(?:to|a|pour)\s+\d|\bceux\s+qui\b|\breserved?\s+(?:for|to)\b|\breserve\w*\s+aux?\b|\bcontingent\b|\bconditional\b|\bconditionnel\w*|\bhard[- ]to[- ]fill\b|\bscoring\b|\b(?:role|position|job|candidate|applicant|you|they|it)\s+(?:\w+\s+)?qualifies\b|\bqualify\b|\b(?:returning|existing|current|former|previous|past)\s+(?:workers?|staff|employees?|seasonal|hires?|candidates?)\b|\b(?:spouses?|family\s+members?|interns?|internships?|dependa?ents?|conjoints?|stagiaires?)\b|\bselon\s+(?:les\s+)?besoins?\b/;
const SCOPE = /\b(?:other\s+(?:positions?|roles?|jobs?|locations?|offices?|postings?)|another\s+(?:role|position|company|location|office|job)|different\s+(?:role|position|company|location|job)|sister\s+company|parent\s+company|elsewhere|separate(?:ly)?|(?:current|existing)\s+(?:employees|staff)|internal\s+(?:candidates?|transfers?|only|hires?)|(?:senior|managerial|executive)\s+(?:roles?|positions?|staff|hires?)|(?:\w+\s+)?office\s+only|(?:us|u\.s\.|uk|european|american|dublin|london|new\s+york)\s+(?:offices?|roles?|positions?|postings?|based)|not\s+for\s+this|this\s+(?:one|role|position|job|posting)\s+(?:is\s+|does\s+)?(?:not|n't)|does\s+not\s+qualify|doesn't\s+qualify|only\s+for\s+(?:certain|some|selected|specific)|certain\s+(?:roles|positions|candidates)|some\s+(?:roles|positions)|d'autres\s+postes|autres\s+postes|listed\s+(?:on|at|below|above|elsewhere)|on\s+our\s+(?:website|site|careers?\s+page)|careers?\s+page|see\s+(?:our\s+)?(?:website|site)|voir\s+(?:notre\s+)?site)\b/;
const ONLY = /\b(?:only|seulement|uniquement|exclusively|exclusivement|solely)\b/;
const DUTIES = /\b(?:responsible\s+for|you\s+will\s+(?:prepare|process|handle|coordinate|file|manage|review|draft|advise)|process(?:ing)?\s+(?:\w+\s+)?(?:lmia|eimt|visa|applications?|requests?|files?)|clients?|customers?|for\s+employers|consult(?:ant|ing|ants)|paralegal|immigration\s+(?:consultant|advis[eo]r|firm|lawyer|specialist|officer)|job\s+duties|duties|coordinate|clientele)\b/;
// reported speech / other company / quoted claims
const REPORTED = /["\u201c\u201d\u00ab\u00bb]|\b(?:says?|said|slogan|claim\w*|ignore|beware|watch\s+out|scam\w*|fraud\w*|fake|arnaque\w*|mefiez|avertissement|warning|alert|promis\w*|think|thinks|believe\w*|told|heard|rumou?r\w*|assumes?\s+(?:that\s+)?(?:we|you|the\s+company)|pensent|croient|forums?|websites?|reviews?|according\s+to|unlike|competitors?|other\s+(?:companies|employers|firms)|not\s+us|quot\w*|motto|tagline|advertis\w*|selon\s+(?:eux|lui|elle))\b/;
// third parties that sponsor / process instead of the employer, or information instead of support
const THIRD_PARTY = /\b(?:(?:provided|offered|handled|managed|arranged|administered|offerte?s?|fournie?s?|geree?s?|assuree?s?)\s+(?:by|par)\s+(?!(?:(?:the|a|an|our|une?|la|le|notre|this)\s+|l')?(?:employer|company|employeur|entreprise|us|nous|hr|famil\w*|household|hotel|farm|restaurant|ferme|compagnie|societe|university|college|hospital|clinic|school|universite|hopital|team|equipe|management|direction|owner|proprietaire)\b)(?:the\s+|a\s+|an\s+|our\s+|une?\s+|l'|la\s+|le\s+|notre\s+)?[\w'-]+|\bmunicipal\w*|\borganisme\b|\b(?:community|non-profit|nonprofit)\s+(?:organi[sz]ation|partner|agency)|\bngo\b|\baffiliat\w*|affilie\w*|(?:recruitment|staffing|recruiting|placement)\s+(?:firm|agency|partner|company)|by\s+(?:an?\s+|the\s+|our\s+|une?\s+)?(?:[\w'-]+\s+){0,2}(?:firm|agency|agence|partner|organisme|cabinet|intermediary)|external|externe|client\s+company|third[- ]party|tierce|tiers|partner\s+(?:agency|company|firm|organi[sz]ation|employer)|partenaire\w*|we\s+partner\s+with|separate\s+(?:company|firm|agency|entity|employer)|outside\s+(?:agency|firm|company)|through\s+(?:an?\s+|our\s+|the\s+|a\s+partner\s+)?(?:\w+\s+)?(?:agency|agencies|recruiter|consultant|firm|lawyer|intermediary)|par\s+(?:une\s+|l')?(?:agence|intermediaire|cabinet)|via\s+(?:an?\s+|une\s+)?(?:agen\w+|cabinet|intermediaire)|refer\s+you|referr\w*|recommend\s+(?:an?\s+)?(?:agency|lawyer|consultant)|lawyers?|avocats?|list\s+of|liste\s+d|resources|ressources|information\s+(?:on|about|sessions?)|webinars?|workshops?|seminars?|guide|tips\s+(?:from|by)|conseils\s+(?:d'un|de\s+notre|du))\b/;
const UNRELATED_AFF = /\b(?:events?|festivals?|sports?|charity|charities|marathon|concerts?|hockey|soccer|football|league|tournament|awareness|evenements?|caritatif|commandit\w*|sponsored\s+(?:content|post|job|listing|ad|by)|contenu\s+commandite|diversity\s+initiatives?|certifications?|conferences?)\b/;
// costs passed to the worker (checked in a +-2 sentence window), unless that sentence says the employer pays
const FEE = /\b(?:fees?|frais|deduct\w*|retenu\w*\s+sur|deduit\w*\s+(?:de|du|sur)|withh[eo]ld\w*|payable|reimburs\w*|rembours\w*|charged|recover\w*|recuper\w*|repay\w*|paid\s+by\s+(?:the\s+)?(?:worker|candidate|employee|applicant|you)|out\s+of\s+(?:your|pocket)|cost\s+to\s+(?:you|the\s+(?:worker|candidate)))\b/;
const EMPLOYER_SUBJ = "(?:we|we'll|we\\s+will|nous|employer|employeur|l'employeur|company|entreprise|(?:the|our|this|l'|notre|cette|le|la)\\s+(?:\\w+\\s+)?(?:company|employer|university|college|hospital|clinic|agency|organi[sz]ation|firm|institute|school|hotel|restaurant|farm|plant|facility|group|business|lab|laboratory|universite|hopital|clinique|agence|organisme|etablissement|entreprise|employeur|ferme|usine|societe|compagnie|team|hr\\s+team|family|famille|household|home|residence|menage|foyer))";
const EMPLOYER_PAYS = new RegExp(`\\b${EMPLOYER_SUBJ}\\b(?:\\s+(?:will|also|fully|can|shall|gladly|happily|do|does|then|always|entirely|completely|directly))*\\s+(?:cover|covers|covered|pay|pays|paid|absorb\\w*|assume\\w*|assum\\w*|prend\\w*\\s+en\\s+charge|prenons\\s+en\\s+charge|rembours\\w*|reimburs\\w*|handle\\w*|bear\\w*|pick\\w*\\s+up)\\b|\\b(?:at\\s+no\\s+(?:cost|charge)|free\\s+of\\s+charge|no\\s+cost\\s+to\\s+you|employer[- ](?:paid|covered|funded)|company[- ](?:paid|covered|funded)|(?:paid|covered|funded|reimbursed|borne)\\s+(?:in\\s+full\\s+)?by\\s+(?:the\\s+)?(?:employer|company|us|our\\s+company)|pris\\w*\\s+en\\s+charge\\s+par\\s+(?:l'employeur|l'entreprise|nous|la\\s+compagnie)|a\\s+la\\s+charge\\s+de\\s+l'employeur|aux\\s+frais\\s+de\\s+l'(?:employeur|entreprise)|assumera\\s+(?:tous\\s+)?les\\s+frais|we\\s+cover)\\b|\\b(?:covers?|covered|pays?|paid|absorbs?|assumes?|assumera|reimburses?|rembourse\\w*|prend\\w*\\s+en\\s+charge)\\s+(?:for\\s+)?(?:all\\s+|the\\s+|any\\s+|full\\s+|tous\\s+les\\s+|les\\s+|your\\s+|vos\\s+)?(?:[\\w'-]+\\s+){0,3}?(?:fees?|costs?|frais|charges?|expenses?|depenses)\\b`);
const AMOUNT = /(?:\$\s?\d[\d,.]*\s?k?|\b\d[\d,.]*\s?k?\s?(?:\$|cad\b|usd\b|dollars?\b|\u20ac|eur\b))/g;
const WAGE_AFTER = /^\s*(?:\/|per\b|an?\b|de\s+l'|par\b|hourly|annually|monthly|weekly)\s*(?:h\b|hr\b|hrs\b|hour|heure|month|mois|year|an\b|annee|yr|week|semaine|annum)?|^\s*(?:hourly|annually|monthly|weekly|per\s+(?:hour|year|month|week))/;
const WAGE_BEFORE = /(?:wage|salary|salaire|pay|paid|rate|taux|earn\w*|accommodation|housing|logement|rent|loyer|bonus|allowance|indemnite|remuneration|compensation|starting|from|up\s+to|jusqu'a|between|entre|\$\d[\d,.]*\s*(?:-|to|a))\W*\s*$/;
const SUPPORT_WORD = /\b(?:lmias?|eimts?|visas?|permits?|permis|sponsor\w*|parrain\w*|immigration)\b/;

/** A dollar amount next to LMIA/visa/permit/sponsorship that is not a wage or housing figure. */
function priceNextToSupport(f) {
  AMOUNT.lastIndex = 0;
  let m;
  let n = 0;
  while ((m = AMOUNT.exec(f)) && n < 50) {
    n += 1;
    const before = f.slice(Math.max(0, m.index - 30), m.index);
    const after = f.slice(m.index + m[0].length, m.index + m[0].length + 20);
    if (WAGE_AFTER.test(after) || WAGE_BEFORE.test(before)) continue;
    const around = f.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
    if (SUPPORT_WORD.test(around)) return true;
  }
  return false;
}

const CAND_RESP = [
  /\b(?:candidates?|employees?|applicants?|workers?|your|candidat\w*|travailleur\w*)'?s?\s+(?:own\s+)?(?:responsibility|expense|cost)\b/,
  /\bat\s+(?:your|their|the\s+(?:candidate|employee|applicant|worker)'?s?)\s+(?:own\s+)?(?:expense|cost)\b/,
  /\b(?:candidates?|employees?|applicants?|workers?|you|they|travailleurs?|candidats?)\s+(?:pays?|will\s+pay|must\s+pay|bears?|covers?|must\s+cover|will\s+cover|are\s+responsible|is\s+responsible|reimburse\w*|repay\w*|paie\w*|paye\w*|assume\w*|rembours\w*)\b/,
  /\bfor\s+a\s+fee\b|\bfor\s+sale\b|\bat\s+your\s+cost\b|\bfees?\s+(?:of|apply|applies)\b|\bfees?\s+(?:are\s+|will\s+be\s+)?(?:charged|deducted|payable|withheld|recovered)\b|\bcharges?\s+(?:apply|to\s+(?:the\s+)?(?:candidate|worker|employee|applicant|you))\b|\ba\s+vos\s+frais\b|\ba\s+(?:vos|ses|leurs)\s+propres\s+frais\b|\ba\s+la\s+charge\s+(?:du|de\s+la|des)\s+(?:candidat|employe|travailleur|salarie|participant)\w*|\bfrais\s+(?:a\s+la\s+charge|retenus|deduits|payables)\b|\bcandidate\s+pays\b/,
  /\b(?:requires?|requiring|required|need|needs|needed)\b(?:\s+\w+){0,3}?\s+(?:(?:an?|their|your|own|the)\s+)*(?:lmia|eimt|work\s+permit|visa|sponsorship)\b/,
  /\b(?:lmia|eimt|work\s+permit|visa|sponsorship)\s+(?:is\s+|are\s+)?(?:required|needed|requis|requise)\b/,
  /\b(?:lmias?|eimts?|work\s+permits?|visas?)\b[^.;]{0,30}\b(?:prerequisite|pre-requisite|prerequis|condition\s+prealable|must\s+be\s+(?:provided|supplied|submitted|attached)|a\s+fournir|a\s+joindre)\b/,
  /\b(?:lmias?|eimts?)\b[^.;,]{0,40}\b(?:required|requis\w*|exige\w*|mandatory|obligatoire|needed|necessary|necessaire)\b/,
  /\b(?:candidate|applicant|worker|employee)[- ](?:supplied|provided|obtained|sourced|arranged)\b|\b(?:supplied|provided|obtained|arranged)\s+by\s+(?:the\s+)?(?:candidate|applicant|worker|employee|you)\b|\bfourni\w*\s+par\s+(?:le|la)\s+(?:candidat|travailleu)\w*|\b(?:exige\w*|requis\w*)\s+(?:du|de\s+la|des)\s+(?:candidat|travailleu)\w*/,
  /\bcontre\s+paiement\b|\bmoyennant\b|\bagainst\s+payment\b|\bin\s+exchange\s+for\s+(?:a\s+)?(?:payment|fee)\b|\bpayment\s+(?:required|needed)\b|\bpaiement\s+(?:requis|exige)\b|\bdeposit\b|\bdepot\s+de\b/,
  /\bat\s+cost\b|\ba\s+prix\s+coutant\b|\bpaid\s+service\b|\bservice\s+payant\b|\bfor\s+a\s+(?:price|charge)\b/,
  /\b(?:candidates?|applicants?|you|they)\s+(?:must|need\s+to|have\s+to|will\s+need\s+to|should)\s+(?:\w+\s+){0,3}?(?:obtain|apply|get|bring|provide|hold|have|possess|secure|arrange)\b[^,]{0,40}\b(?:lmia|eimt|work\s+permit|visa|sponsorship)\b/,
  /\bapply\s+for\s+(?:an?\s+)?lmia\s+yourself\b/,
  /\b(?:your|their)\s+own\s+(?:lmia|eimt|work\s+permit|visa|permit)\b|\bown\s+(?:lmia|eimt|work\s+permit|visa)\b/,
  /\barrange\s+their\s+own\b/,
];

// ---- who holds it: an LMIA/EIMT the CANDIDATE must already hold is not employer support ----
const HOLD_ADJ = "(?:(?:an?|une?|the|la|le|l'|their|leur|own|propre|valid|valide|approved|approuvee?|positive|positif|existing|current|genuine|confirmed|employer[- ]specific|job[- ]offer|already|deja)\\s*)*";
// asset / preference wording (never an offer by the employer)
const ASSET = "\\b(?:assets?|atouts?|(?:a|un|une)\\s+(?:big\\s+|strong\\s+|huge\\s+|real\\s+|definite\\s+|gros\\s+|grand\\s+|vrai\\s+)?plus|(?:a|is\\s+a|would\\s+be\\s+a)\\s+bonus|bonus\\s+points?|advantage\\w*|avantageu\\w*|un\\s+avantage|preferred|preferable|preference|prefere\\w*|desirable|souhaitable|souhaite\\w*|nice\\s+to\\s+have|apprecie\\w*|considered\\s+an?\\s+(?:asset|plus))\\b";
const CH_SUBJ = "(?<!(?:provide|provides|give|gives|offer|offers|supply|supplies|help|helps|assist|assists|support|supports|sponsor|sponsors)\\s)(?:must|need\\s+to|needs\\s+to|required\\s+to|candidates?|applicants?|workers?|those|persons?|people|individuals?|anyone|you|vous|candidat(?:e)?s?|travailleu(?:r|se)s?|ceux|celles|personnes|doit|doivent|devez|hires?|employees?)";
const CH_VERB = "(?:have|has|hold|holds|possess|possesses|with|holding|having|bring|bringing|carrying|avec|detenant|ayant|avoir|posseder|possedant|possedent|detenir|detiennent|disposant|munis?\\s+d'(?:une\\s+)?)";
const CAND_HELD = [
  new RegExp(`\\b${CH_SUBJ}\\b(?:\\s+(?:[\\w']+)){0,3}?\\s+${CH_VERB}\\s+(?:(?:[\\w'-]+\\s+){0,5}?(?:and|et|or|ou|plus|as\\s+well\\s+as)\\s+)?${HOLD_ADJ}(?:lmias?|eimts?)\\b`),
  /\b(?:lmia|eimt)[- ](?:approved|positive|holding|approuvee?s?|positive?s?)\s+(?:candidates?|applicants?|workers?|holders?|persons?|people|individuals?|candidat(?:e)?s?|travailleu(?:r|se)s?|hires?)\b/,
  /\b(?:approved|positive|valid|existing)\s+(?:lmia|eimt)\s+(?:candidates?|applicants?|workers?|holders?|people|individuals?|hires?|job\s+offer\s+holders?)\b/,
  /\b(?:candidates?|applicants?|workers?|those|people|persons?|hires|travailleu\w*|candidat\w*|personnes)\s+(?:whose|dont\s+(?:l'|la\s+|le\s+)?)\s*(?:lmias?|eimts?)\b/,
  /\b(?:candidates?|applicants?|workers?|those|people|hires|travailleu\w*|candidat\w*|ceux|celles)\s+(?:who|that|qui)\s+(?:have\s+|has\s+|already\s+|ont\s+)?(?:obtained|got|secured|received|been\s+issued|obtenu|recu|deja\s+obtenu)\b[^.;]{0,30}\b(?:lmias?|eimts?)\b/,
  /\b(?:lmia|eimt)\s+holders?\b|\b(?:detenteur|detentrice|titulaire)s?\s+d'(?:une\s+)?(?:eimt|lmia)\b/,
  /\b(?:candidat(?:e)?s?|travailleu(?:r|se)s?)\s+(?:avec|ayant|detenant|possedant)\s+(?:une\s+)?(?:eimt|lmia)\b/,
  // gap B: the candidate's own LMIA listed as an asset / nice-to-have ("Positive LMIA in hand is an asset",
  // "Nice to have: positive LMIA", "Atouts : EIMT approuvée", "Approved LMIA (preferred)")
  new RegExp(`\\b(?:lmias?|eimts?)\\b[^.;!?,]{0,30}?${ASSET}`),
  new RegExp(`${ASSET}\\s*:?[^.;!?,]{0,40}?\\b(?:lmias?|eimts?)\\b`),
  // already held by the applicant ("Already possess a valid LMIA? Great", "Avoir déjà une EIMT approuvée")
  /\b(?:already|deja)\s+(?:\w+\s+){0,2}?(?:possess|possesses|have|has|hold|holds|own|got|obtained|detenez|detenir|avez|avoir|possedez|posseder|ont|une|un)\b[^.;!?]{0,30}?\b(?:lmias?|eimts?)\b/,
  /\b(?:having|avoir)\s+(?:an?\s+|une\s+|deja\s+une\s+)?(?:(?:approved|positive|valid|existing|approuvee?|positive|valide)\s+)?(?:lmias?|eimts?)\b/,
  // an LMIA attached to someone else ("LMIA approved; attached to a named worker", "tied to a specific worker")
  /\b(?:attached|tied|linked|assigned|bound|specific|rattachee?|liee?)\s+(?:to|a)\s+(?:a|an|one|the|un|une)?\s*(?:named|specific|particular|individual|existing|nominated|designated|precis|precise|specifique|nomme\w*)\s+(?:worker|employee|person|candidate|individual|foreign\s+worker|travailleu\w*|employe\w*|personne|candidat\w*)\b/,
  /\b(?:named|specific|particular|nominated)\s+(?:worker|employee|person|individual)\b[^.;]{0,30}\b(?:lmias?|eimts?)\b|\b(?:lmias?|eimts?)\b[^.;]{0,30}\b(?:nominative|nominatif|cannot\s+be\s+transferred|non[- ]transferable|not\s+transferable)\b/,
];
const STRICT_WORD = /\b(?:must|only|required|requis\w*|exige\w*|mandatory|obligatoire|doit|doivent|devez|seulement|uniquement|need\s+to|needs\s+to|necessary|necessaire)\b/;

// ---- whole-ad restrictions: work authorisation / status must already be held -> unavailable ----
const RESTRICT = [
  /\bmust\s+(?:already\s+)?(?:be|remain)\s+(?:legally\s+)?(?:eligible|entitled|authori[sz]ed|permitted|able|allowed)\s+to\s+work/,
  /\b(?:legally\s+)?(?:eligible|entitled|authori[sz]ed|permitted|allowed)\s+to\s+work\s+(?:\w+\s+){0,4}?in\s+(?:canada|the\s+country)/,
  /\b(?:legal\s+|legally\s+)?right\s+to\s+work\b/,
  /\bmust\s+(?:already\s+)?(?:have|hold|possess|have\s+obtained|own)\s+(?:an?\s+)?(?:valid\s+|current\s+|open\s+)?(?:canadian\s+)?(?:work\s+)?(?:permit|visa|authori[sz]ation)/,
  /\bcanadian\s+work\s+(?:authori[sz]ation|permit)\b/,
  /\b(?:work\s+(?:authori[sz]ation|permit|visa)|status)\s+(?:is\s+)?(?:required|mandatory|needed)/,
  /\b(?:valid|current)\s+(?:canadian\s+)?(?:work\s+)?(?:permit|visa|authori[sz]ation)\b[^.]{0,25}\b(?:required|needed|mandatory|at\s+start)/,
  /\b(?:permit|visa)\s+holders?\s+only\b|\bholders?\s+only\b/,
  /\bstatus\s+in\s+canada\b/,
  /\bproof\s+of\s+(?:work\s+)?(?:eligibility|authori[sz]ation|status)\b/,
  /\b(?:security|secret|reliability)\s+clearance\b/,
  /\bcanadian\s+citizenship\b/,
  /\bcitizenship\s+(?:is\s+)?(?:required|mandatory|needed)\b/,
  /\b(?:pr|permanent\s+residen\w*)\s+or\s+citizen/,
  /\bmust\s+(?:be|have)\s+(?:a\s+)?(?:canadian\s+)?citizen/,
  /\bcitizens?\s+(?:or|and|\/)\s+(?:permanent\s+)?residents?\b/,
  /\bcanadian\s+citizens?\b[^.]{0,40}\b(?:only|permanent\s+residents?)\b/,
  /\b(?:citizens?|permanent\s+residents?|pr|residents?)\s+only\b/,
  /\bonly\s+canadian\s+citizens?/,
  /\b(?:pr|rp|permanent\s+resident\w*|permanent\s+residen\w*)\b[^.]{0,30}\b(?:required|requis|exige\w*|mandatory|status|statut|card|holders?|needed)\b/,
  /\b(?:must|doit|doivent)\b[^.]{0,30}\b(?:pr\b|permanent\s+resident|citizen)/,
  /\bopen\s+to\s+(?:canadian\s+)?(?:pr\b|citizens?|permanent)/,
  /\bcitoyennete\s+canadienne\b/,
  /\bstatut\s+de\s+(?:rp|resident\w*\s+permanent|citoyen)/,
  /\bcitoyens?\s+canadiens?\b[^.]{0,60}\b(?:seulement|uniquement)\b/,
  /\breserve\s+aux\s+(?:citoyens?|residents?)/,
  /\b(?:residents?|residentes?)\s+(?:permanents?|canadiens?)\b[^.]{0,30}\b(?:seulement|uniquement)\b/,
  /\b(?:citoyens?|residents?)\b[^.]{0,40}\b(?:seulement|uniquement)\b/,
  /\bautorisation\s+de\s+travail\s+(?:valide\s+)?(?:est\s+)?(?:requise|exigee|obligatoire)/,
  /\b(?:doit|doivent|devez)\s+etre\s+(?:legalement\s+)?(?:autorises?|admissibles?|habilites?)\b[^.]{0,30}travailler/,
  /\bautorises?\s+a\s+travailler\s+(?:\w+\s+){0,4}?au\s+canada/,
  /\bpermis\s+de\s+travail\s+(?:\w+\s+){0,2}?(?:exige|requis|valide)/,
  /\bseuls?\s+les\s+detenteurs\b|\bavoir\s+deja\s+un\s+permis|\bdetenir\s+un\s+permis|\bexige\w*\s*:?\s*(?:un\s+)?permis/,
  /\bcote\s+de\s+securite\b|\bhabilitation\s+de\s+securite\b/,
];
const REQ_SECTION_RESTRICT = /\b(?:permit|visa|authori[sz]ation|status|citizen\w*|permanent|\bpr\b|\brp\b|clearance|autorisation|permis|resident\w*|lmia|eimt)\b/;
const NEGATIVE = [
  /\bno\s+(?:\w+\s+){0,3}?(?:sponsor\w*|visa|lmia|eimt|work\s+permit|immigration)/,
  /\b(?:aucune?|pas\s+de|sans)\s+(?:\w+\s+){0,2}?(?:parrainage|soutien|eimt|lmia|permis|visa)/,
  /\b(?:without|sans)\s+(?:an?\s+)?(?:lmia|eimt|visa|sponsor\w*)/,
];
// past/ended statements about sponsorship anywhere in the ad
const TIME_PAST = /\b(?:was|were|previous\w*|former\w*|past|expired|lapsed|ended|until|used\s+to|no\s+longer|anymore|discontinued|stopped|paused|suspended|on\s+hold|(?:19|20)\d\d|last\s+(?:year|month|season|intake)|auparavant|autrefois|expire\w*|n'est\s+plus)\b/;
// the ad itself says an earlier statement was wrong: nothing in it is trusted as an affirmative
const RETRACTION = /\b(?:update\s*:|updated\s*:|mise\s+a\s+jour\s*:|withdrawn|cancell?ed|revoked|annule\w*|revoque\w*|retiree?s?|correction|corrected|erratum|errata|just\s+kidding|in\s+error|was\s+an\s+error|by\s+mistake|retract\w*|(?:previous|earlier|old)\s+(?:ad|version|posting|listing)|(?:ignore|disregard)\s+(?:the|our)\s+(?:previous|earlier|above))\b/;

// ---- affirmative allowlist (each is a complete statement that the employer provides support) ----
const SUPPORT_NOUN = "(?:visas?|work\\s+permits?|lmias?|eimts?|immigration|sponsorship|permis\\s+de\\s+travail|soutien\\s+a\\s+l'immigration|parrainage|travailleurs?\\s+etrangers?)";
const AFF_VERB = "(?:s'occupe\\w*\\s+(?:de|du|des)|nous\\s+occupons\\s+(?:de|du|des)|se\\s+charge\\w*\\s+(?:de|du|des)|nous\\s+chargeons\\s+(?:de|du|des)|offer|offers|provide|provides|sponsor|sponsors|support|supports|assist|assists|help|helps|handle|handles|cover|covers|arrange|arranges|apply\\s+for|applies\\s+for|will\\s+apply\\s+for|take\\s+care\\s+of|takes\\s+care\\s+of|pay\\s+for|pays\\s+for|facilitate|facilitates|obtain|obtains|secure|secures|file|files|submit|submits|offrons|offre|offrira|fournissons|fournit|fournira|assurons|assure|parrainons|parraine|parrainera|fera|ferons|prenons\\s+en\\s+charge|prend\\s+en\\s+charge|prendra\\s+en\\s+charge|prendrons\\s+en\\s+charge|accompagnons|accompagne|accompagnera|soutenons|soutient|facilitons|facilite|deposerons|deposera)";
const AFFIRM = [
  new RegExp(`\\b${EMPLOYER_SUBJ}\\b(?:\\s+(?:will|can|are\\s+able\\s+to|is\\s+able\\s+to|do|does|also|gladly|happily|fully|directly|then|always|va|vont|peut|pouvons))*\\s*${AFF_VERB}\\b[^.;,]{0,40}?\\b${SUPPORT_NOUN}\\b`),
  new RegExp(`^\\W*${EMPLOYER_SUBJ}\\b[^.;]{0,80}?\\b(?:and|et)\\s+(?:also\\s+|will\\s+|aussi\\s+)?${AFF_VERB}\\b[^.;,]{0,40}?\\b${SUPPORT_NOUN}\\b`),
  // French first-person-plural verbs carry their own subject ("... et offrons le parrainage")
  new RegExp(`\\b(?:offrons|fournissons|assurons|parrainons|accompagnons|prenons\\s+en\\s+charge|prendrons\\s+en\\s+charge|soutenons|facilitons|deposerons)\\b[^.;]{0,60}?\\b(?:${SUPPORT_NOUN}|demarches\\s+d'immigration)\\b`),
  /\b(?:visa|work\s+permit|work\s+visa|immigration)\s+sponsorship\s+(?:is\s+|are\s+|will\s+be\s+|can\s+be\s+)?(?:available|offered|provided|included|supported)\b/,
  /\b(?:employer|company|employeur|entreprise)[- ](?:paid|funded|sponsored|covered|supported)\s+(?:lmia|eimt|work\s+permits?|visas?|immigration|sponsorship)\b|\b(?:lmia|eimt|work\s+permit|visa)s?\s+(?:entierement\s+)?(?:paye\w*|finance\w*)\s+par\s+l'employeur\b/,
  /\b(?:we|we'll|the\s+family|la\s+famille|the\s+household|the\s+employer|employer|our\s+family)\s+(?:will\s+|can\s+|va\s+)?(?:sponsor|parrainer|parrainera|parraine)\s+(?:you|vous|the\s+(?:successful\s+)?(?:caregiver|worker|candidate|applicant|hire|nanny)|la\s+(?:gardienne|aide)|le\s+(?:travailleur|candidat))\b[^.;]{0,60}\b(?:caregiver|pilot|program(?:me)?|stream|programme|projet\s+pilote|immigration|permit|permis|visa|lmia|eimt)\b/,
  /\b(?:comes?|come)\s+with\s+(?:full\s+|complete\s+)?(?:visa\s+sponsorship|lmia\s+support|immigration\s+(?:support|assistance)|work\s+permit\s+sponsorship|an?\s+(?:approved|positive)\s+lmia|sponsorship)\b/,
  /\b(?:lmia|eimt)\s+(?:a\s+ete|est|a\s+deja\s+ete)\s+(?:approuvee|obtenue|accordee|delivree)\b/,
  /\b(?:benefits?|perks?|avantages?|package)\s+(?:include|includes|including|comprennent|incluent|comprend|inclut)\b[^.;]{0,60}?\b(?:visa\s+sponsorship|work\s+permit\s+sponsorship|lmia\s+support|immigration\s+(?:support|assistance)|sponsorship|parrainage|soutien\s+a\s+l'immigration)\b/,
  /\bsponsorship\s+(?:is\s+|are\s+)?(?:available|offered|provided)\b/,
  /\b(?:lmia|eimt)(?:\s|-)+(?:is\s+|has\s+been\s+)?(?:positive\s+)?(?:approved|approuve\w*|obtenue?|in\s+place|obtained|available|supported|provided|issued|in\s+hand|granted)\b/,
  /\b(?:approved|positive|valid)\s+(?:lmia|eimt)\b/,
  /\b(?:lmia|eimt|immigration|visa|work\s+permit)\s+(?:support|assistance|help)\s+(?:is\s+|are\s+)?(?:provided|available|offered|included)\b/,
  /\bhelp\s+with\s+(?:immigration|visa|work\s+permit)\b[^.]{0,40}\b(?:is\s+|are\s+)?(?:included|provided|available|offered)\b/,
  /\b(?:work\s+)?(?:permit|visa)\s+(?:provided|sponsored|supported)\b/,
  /\bpermis\s+de\s+travail\s+(?:fourni|parraine|offert)\b/,
  /\bsoutien\s+a\s+l'immigration\s+(?:offert|disponible|fourni|assure)\b/,
  /\bparrainage\s+(?:disponible|offert|fourni)\b/,
  /\b(?:lmia|eimt)(?:\s|-)*(?:supported|approved)\b/,
  new RegExp(`\\b${EMPLOYER_SUBJ}\\s+(?:have|has|hold|holds|got|obtained)\\s+(?:an?\\s+|the\\s+)?(?:approved\\s+|positive\\s+)?(?:lmia|eimt)\\b`),
  // the employer pays the fees OF the support ("We pay all government fees for your work permit")
  new RegExp(`\\b${EMPLOYER_SUBJ}\\b(?:\\s+(?:will|also|fully|always|directly))*\\s+(?:pay|pays|cover|covers|absorb|absorbs|reimburse|reimburses)\\s+(?:all|the|any|full|every)?\\s*(?:[\\w'-]+\\s+){0,3}?(?:fees?|costs?|expenses?|charges?)\\s+(?:for|of|related\\s+to|associated\\s+with)\\s+(?:the\\s+|your\\s+|any\\s+|an?\\s+)?${SUPPORT_NOUN}\\b`),
  // the employer pays the support costs ("LMIA fees are covered by the employer", "... sont pris en charge par l'employeur")
  new RegExp(`\\b${SUPPORT_NOUN}\\b[^.;]{0,50}\\b(?:(?:are|is|will\\s+be)\\s+(?:fully\\s+|entirely\\s+)?(?:covered|paid)\\s+by\\s+(?:the\\s+)?(?:employer|company|us)|(?:sont|est|seront|sera)\\s+(?:entierement\\s+|integralement\\s+)?pris\\w*\\s+en\\s+charge\\s+par\\s+(?:l'employeur|l'entreprise|nous))\\b`),
];
const AFFIRM_VALUE = /\b(?:visa\s+sponsorship|lmia|eimt|work\s+permit(?:\s+sponsorship)?|immigration|sponsorship|parrainage)(?:\s+(?:support|assistance|help|sponsorship))?\s*[:=-]?\s*(?:yes|oui|y|true|included|available|offered|provided|\u2713|\u2714)\s*[).!]*$/;
const BARE_ITEM = /\b(?:help|assistance|aide|support|soutien)\s+(?:with|for|pour|avec)\s+(?:the\s+|your\s+|le\s+|votre\s+|la\s+)?(?:work\s+permits?|visas?|immigration|lmia|eimt|permis\s+de\s+travail)\b|\b(?:visa\s+sponsorship|work\s+permit\s+sponsorship|lmia(?:\s+approved)?|eimt|immigration\s+(?:support|assistance|sponsorship)|sponsorship|parrainage(?:\s+de\s+visa)?|soutien\s+a\s+l'immigration)\b/;
const STRONG_WORD = /\b(?:sponsor\w*|parrain\w*|visas?|lmias?|eimts?|immigration|parrainage|work\s+permits?|permis\s+de\s+travail)\b/;
const RELATED = /\b(?:visas?|permits?|immigration|lmias?|eimts?|work\s+authori[sz]ation|travail)\b/;
const UNRELATED = /\b(?:event|events|festival|festivals|team|teams|sports?|charity|charities|marathon|concert|evenements?|equipes?|caritatif)\b/;
const SEGMENT_SPLIT = /\s*(?:[,;\u2013\u2014]|\s-\s|\bbut\b|\band\b|\bet\b|\bmais\b)\s*/;

// "Label - not available" / "label, no": a dash or comma followed only by a negative value is a label/value pair, not a clause break.
const LABEL_VALUE_DASH = /\s*(?:[\u2013\u2014]|\s-\s)\s*(?=(?:not|no|non|n\/a|none|unavailable|nope|unfortunately)\b)/g;
const LABEL_VALUE_COMMA = /\s*,\s*(?=(?:not|no|never|cannot|without|pas|non|nope|excluded|n\/a|none|unavailable|unfortunately|sadly|jamais|\w+n't)(?:\b|(?=\W))(?:\W+\w+){0,3}\W*$)/;
function segmentsOf(f) {
  return f.replace(LABEL_VALUE_DASH, " : ").replace(LABEL_VALUE_COMMA, " : ").split(SEGMENT_SPLIT).filter((x) => x.trim());
}

// ---- scope: an offer qualified to a subset of roles/locations ----
const ROLE_NOUN = /^(?:roles?|positions?|postes?|jobs?|emplois?|openings?|vacanc(?:y|ies)|occupations?|professions?|metiers?|categories|streams?|programs?|contracts?|projects?|cadres)$/;
const PLACE_NOUN = /^(?:staff|personnel|locations?|sites?|offices?|bureaux?|bureau|branch(?:es)?|succursales?|hq|headquarters|departments?|divisions?|stores?|plants?|facilit(?:y|ies)|units?|filiales?|subsidiar(?:y|ies)|campus(?:es)?|regions?|provinces?|magasins?|usines?|teams?|equipes?|crews?)$/;
const DET = /^(?:this|that|these|the|our|all|each|every|both|a|an|un|une|ce|cet|cette|ces|le|la|les|l'|tous|toutes|nos|notre|\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|several|multiple|many|various|numerous|plusieurs|advertised|posted|open|available|vacant|de|du|des|d'|any)$/;
const SINGULAR_DET = /^(?:this|that|the|a|an|ce|cet|cette|le|la|l'|un|une)$/;
const FR_POSTMOD = /^(?:cadres|admissibles|specifiques|selectionnes|designes|vises|concernes|techniques|syndiques|saisonniers|qualifies|seulement|uniquement)$/;
const PREP_WORD = /^(?:for|pour|in|at|to|of|de|du|with|avec|au|aux|dans|from|by|par|on|sur|within|across|chez|and|et|or|ou)$/;
const SUBSET_PREP = /\b(?:for|pour|in|at|au|aux|dans|within|across|chez|to|covers?|concerns?|concerne\w*|visent|vise|includes?|inclut)\s+((?:[\w'-]+[ \t]*){1,5})/g;
/** "for our Vancouver HQ roles", "pour certains postes", "at our Montreal location": an offer scoped to a subset. */
function subsetScoped(f) {
  SUBSET_PREP.lastIndex = 0;
  let m;
  let n = 0;
  while ((m = SUBSET_PREP.exec(f)) && n < 40) {
    n += 1;
    SUBSET_PREP.lastIndex = m.index + 2;
    const all = m[1].trim().split(/\s+/);
    const stop = all.findIndex((w, k) => k > 0 && PREP_WORD.test(w));
    const words = stop > 0 ? all.slice(0, stop) : all;
    const idx = words.findIndex((w) => ROLE_NOUN.test(w) || PLACE_NOUN.test(w));
    if (idx < 0) continue;
    if (idx === words.length - 1 && stop === idx + 1 && all[stop + 1] && !DET.test(all[stop + 1].replace(/^l'/, "")) && /^(?:in|de|du|of|at|en|a|au|dans)$/.test(all[stop])) {
      const nn = words[idx];
      const numbered = words.slice(0, idx).some((w) => /^\d+$|^(?:one|two|three|four|five|six|seven|eight|nine|ten|several|multiple|plusieurs)$/.test(w));
      if (PLACE_NOUN.test(nn) || (/(?:s|x)$/.test(nn) && !numbered)) return true; // "our offices in Ontario", "roles in Vancouver"
    }
    const noun = words[idx];
    const mods = words.slice(0, idx);
    const modifiers = mods.filter((w) => !DET.test(w));
    if (idx + 1 < words.length && (FR_POSTMOD.test(words[idx + 1]) || ROLE_NOUN.test(words[idx + 1]))) return true; // "postes cadres"
    const after = idx + 1 < all.length ? all[idx + 1] : "";
    if (/(?:s|x)$/.test(words[idx]) && /^(?:[\w-]+(?:ed|ing)|listed|shown|below|above|mentioned|indiques|listes|mentionnes|ci-dessous)$/.test(after)) return true; // "positions listed on our site"
    if (!modifiers.length) continue; // "for this role", "for 6 positions", "at all locations"
    if (!PLACE_NOUN.test(noun) && mods.some((w) => /^\d+$/.test(w))) continue; // a count: "for 4 PSW positions"
    if (PLACE_NOUN.test(noun)) return true; // another office/branch/location/staff group
    const plural = /(?:s|x)$/.test(noun);
    if (!plural && mods.length && SINGULAR_DET.test(mods[0])) continue; // "for the line cook position"
    return true;
  }
  return false;
}
// cross-sentence: "LMIA approved for cooks. We are hiring a dishwasher."
const HIRING = /\b(?:this\s+(?:posting|role|position|job|ad|opening|vacancy|offer)\s+is\s+(?:for|an?|in|based)|we\s+are\s+(?:also\s+|now\s+|currently\s+)?(?:hiring|recruiting|looking\s+for|seeking)|(?:now\s+)?hiring\s*:|position\s*:|(?:current\s+|this\s+)?(?:opening|vacancy|role)\s*:|poste\s+a\s+pourvoir\s*:|poste\s*:|ce\s+poste\s+est|cette\s+offre\s+(?:est|concerne)|nous\s+(?:recrutons|embauchons|cherchons))\s+((?:[\w'-]+\s*){1,4})/;
const QUAL_FOR = /\b(?:for|pour|positions?\s*:|roles?\s*:|postes?\s*:)\s+((?:[\w'-]+[\s,]*){1,4})/;
const QUAL_STOP = /^(?:our|the|a|an|all|qualified|skilled|experienced|successful|selected|foreign|international|overseas|workers?|candidates?|applicants?|hires?|employees?|people|you|your|this|role|position|job|le|la|les|des|un|une|nos|notre|candidats?|travailleurs?|qualifies?|retenus?|ce|cette|poste|emploi|and|et|of|de|du|from|abroad|new|full|time|full-time|permanent|positions?|roles?|jobs?|postes?|ideal|right)$/;
const stemOf = (w) => w.replace(/(?:ers|er|es|s|ing)$/, "").slice(0, 5);
function otherRoleHiring(f, neighbours) {
  const q = QUAL_FOR.exec(f);
  if (!q) return false;
  const quals = q[1].split(/[\s,]+/).filter((w) => w && !QUAL_STOP.test(w) && !/^\d/.test(w)).map(stemOf).filter((w) => w.length >= 3);
  if (!quals.length) return false;
  for (const nb of neighbours) {
    const h = HIRING.exec(nb);
    if (!h) continue;
    const hired = h[1].split(/\s+/).filter((w) => w && !QUAL_STOP.test(w)).map(stemOf);
    if (!hired.some((w) => quals.includes(w))) return true;
  }
  return false;
}
const BARE_NEG_SENTENCE = /^\W*(?:not|no|nope|non|never|jamais|pas|sorry|desole\w*|unfortunately|malheureusement|just\s+kidding|kidding|not\s+really|not\s+anymore|no\s+longer|not\s+(?:here|now|yet|for\s+(?:this|now|us|you))|pas\s+(?:ici|maintenant|pour\s+(?:ce|nous)))\W*$/;

// "Bring your approved LMIA", "Joindre votre EIMT": the candidate's own LMIA (unless the employer is the one acting on it)
const POSSESSIVE_LMIA = /\b(?:your|their|his|her|votre|vos|leur|leurs|son|sa|ses)\s+(?:own\s+|propre\s+)?(?:(?:approved|positive|valid|existing|current|approuvee?|valide)\s+)?(?:lmias?|eimts?)\b/;

// ======================= proximity unit (round 5) =======================
// A claim's unit = its sentence + the previous sentence and the next 2 sentences of the same paragraph
// (+ every sentence of its section for list items). Qualifier cues in the unit veto the claim even when
// the qualifier sentence has no sponsorship keyword ("We offer visa sponsorship. Currently paused.").
const NB_NEGREF = /\b(?:does\s+not|doesn't|do\s+not|don't|did\s+not|will\s+not|won't|cannot|can't)\s+(?:apply|include|cover|qualify|extend|reflect|concern|relate|be\s+(?:offered|provided))\b|\bnot\s+(?:applicable|available|offered|included|eligible|covered|valid|the\s+case|part\s+of|for\s+(?:this|the|our|part|you|all|everyone|every)|in\s+this|one\s+of)\b|\b(?:is|are)n't\s+(?:applicable|available|offered|included|eligible|covered|valid|the\s+case|one)\b|\bn\/a\b|\bno\s+longer\b|\bkidding\b|\bsadly\b|\bunfortunately\b|\bfalse\b|\bne\s+s'applique\s+pas|\bne\s+concerne\s+pas|\bce\s+n'est\s+pas\s+le\s+cas|\bce\s+poste\s+n'est\s+pas|\bn'est\s+pas\s+(?:admissible|offert|disponible|inclus|couvert|concerne)|\bmalheureusement|\bexclu\w*|\b(?:except|excepting|sauf|hormis|excluding|other\s+than|with\s+the\s+exception\s+of)\b[^.;]{0,40}\b(?:this|the|our|part|full|seasonal|roles?|positions?|postings?|jobs?|staff|employees|hires|students|ce|cette|les|poste|for|pour)\b|\bnot\.?$/;
const NB_LIMIT = /\b(?:benefits?|perks?|offer|sponsorship|support|package|avantages?|parrainage)\b[^.;]{0,30}\b(?:is|are|apply|applies|was|were|s'appliquent|s'applique|sont|est)\s+(?:only\s+)?(?:for|to|limited|reserved|restricted|pour|aux?|reserve\w*|limite\w*)\b|\b(?:this|that|it)(?:'s|\s+is)\s+(?:only\s+)?(?:for|limited|reserved|restricted)\b|\bfirst\s+come\b|\b(?:limited|limitee?s?)\b|\b\d+\s+(?:spots|places)\b|\bvalid\s+(?:only\s+)?for\b|\bapplies\s+(?:only\s+)?(?:to|for)\b|\bapply\s+(?:only\s+)?to\b(?!\s+(?:us\b|this\s+(?:job|position|role|posting)|join|work\b|the\s+(?:job|position|role)))|\bapplied\s+(?:only\s+)?to\b|\b(?:this|that|it|these|those|which|the\s+(?:above\s+)?(?:benefits?|perks?|offer|sponsorship|support|lmia|program|package))\s+(?:benefit\s+|perk\s+|offer\s+)?(?:is|are|was|were)\s+(?:only\s+)?(?:for|limited\s+to|reserved\s+for|restricted\s+to|valid\s+for|intended\s+for)\b|\blimited\s+(?:to|offer|number|time|spots?|places?)\b|\bfirst\s+(?:\d+|two|three|four|five|ten|few)\s+(?:hires|applicants|candidates|workers|positions|employees|people|recruits)\b|\bwhile\s+(?:spots|places|funds|budget|supplies|quotas?|positions)\s+last|\breserv\w*\s+(?:aux?|for|to)\b|\blimite\w*\s+a(?:ux?)?\b|\b(?:roles?|positions?|staff|employees|hires|workers|postings?|jobs?|branch|office|division|plant|site|location|cooks|drivers)\s+only\b|\bonly\s+(?:for|to|at|in|applies|available)\b|\b(?:applies|apply|available|offered|valid)\b[^.;]{0,40}\bonly\b|\b(?:seulement|uniquement)\b/;
const TIME_GATE = /\bonwards?\b|\b(?:starting|beginning|commencing|effective|as\s+of)\s+(?:in\s+|from\s+|on\s+)?(?:(?:january|february|march|april|may|june|july|august|september|october|november|december|janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|spring|summer|fall|autumn|winter|printemps|ete|automne|hiver)\b|q[1-4]\b|next\b|the\s+(?:second|third|next)\b|\d)|\b(?:in|during|from)\s+(?:the\s+|your\s+)?(?:second|third|2nd|3rd)\s+(?:year|season|month|contract)\b|\byear\s+(?:two|three|2|3)\b|\b(?:after|upon|once|following)\s+(?:completing|completion|an?\s+|your\s+|the\s+)?(?:successful\s+|initial\s+|first\s+)*(?:first|initial|probation\w*|trial|contract|season|evaluation|review|year|assessment)\b|\bafter\s+(?:\d+|one|two|three|six|twelve)\s+(?:months?|years?|seasons?)\b|\bcompleted\s+(?:\d+|one|two|three|six|twelve)\s+(?:months?|years?|seasons?)\b|\b\d+\+?\s*(?:months?|years?)\s+(?:of\s+)?(?:service|tenure|employment|seniority)\b|\b(?:one|two|three|a|1|2|3)\s+years?\s+of\s+(?:service|tenure|employment)\b|\bseniority\b|\btenure\b|\ba\s+partir\s+d|\bdes\s+(?:le\s+|la\s+|l')?(?:(?:january|february|march|april|may|june|july|august|september|october|november|december|janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|spring|summer|fall|autumn|winter|printemps|ete|automne|hiver)\b|deuxieme|troisieme|prochain\w*|\d)|\bapres\s+(?:\d+|un|une|deux|trois|six)\s+(?:mois|ans?|annees?|saisons?)\b|\banciennete\b|\bnext\s+(?:intake|season|round|year|quarter|month|cohort)\b|\bfirst\s+season\b|\bstarts?\s+after\b|\bhiring\s+round\b/;
const NB_TIME = /\b(?:currently|temporarily|now)\s+(?:paused|suspended|on\s+hold|closed|frozen|unavailable|inactive|stopped)\b|\b(?:paused|suspended|on\s+(?:hold|pause)|frozen|discontinued|ended|expired|expires|lapsed|rejected|refused|denied|withdrawn|reapplying|re-applying|filled|cancell?ed|revoked|en\s+pause|suspendu\w*|expire\w*|refusee?s?|annulee?s?|comblee?s?|pourvue?s?)\b|\buntil\s+further\s+notice|\bjusqu'a\s+nouvel\s+ordre|\brefers?\s+to\b|\btemplate\b|\bboilerplate\b|\bplaceholder\b|\bdoes\s+not\s+reflect|\bne\s+reflete\s+pas|(?:19|20)\d\d\s+(?:hiring|intake|round|season)|\b(?:was|were)\s+(?:rejected|refused|denied|withdrawn|cancell?ed|for\s+(?:a|another|our|the))\b/;
const NB_COND = /\beligib\w*|\badmissib\w*|\bask\s+(?:us|about|hr|the)\b|\bterms\s+(?:and\s+conditions\s+)?apply\b|\bconditions?\s+(?:apply|applies|s'appliquent)\b|\bt&c\b|\bsous\s+conditions?\b|\b(?:as|so)\s+long\s+as\b|\bprovided\s+(?:that\s+)?(?:you|they|he|she|the\s+(?:candidate|worker|applicant|government))|\bassuming\b|\bin\s+(?:exchange|return)\s+for\b|\bon\s+the\s+understanding\b|\bpourvu\s+qu|\ba\s+condition\s+(?:que|qu'|de|d')|\bsous\s+reserve|\bsubject\s+to\b|\bcontingent\b|\bconditional\b|\bonly\s+if\b|\bif\s+(?:you|they|the\s+candidate)\s+(?:pass|meet|stay|sign|commit|complete|qualify|agree|remain|score)|\bunless\b|\bpermitting\b|\bto\s+the\s+extent\b|\bdiscretion\b|\bin\s+principle\b|\ben\s+principe\b|\bin\s+theory\b|\ben\s+theorie\b|\btheoretically\b|\bprobabl\w*|\blikely\b|\bmoyennant\b/;
const NB_COST_RAW = /\b(?:share|split|partag\w*)\s+(?:the\s+|les\s+)?(?:[\w'-]+\s+)?(?:costs?|fees?|expenses?|frais|couts?|depenses)\b|\b(?:you'll|you'd|they'll|vous)\s+(?:share|split|pay|cover|contribute|partagerez|paierez|payerez|contribuerez)\b|\bcontribution\b|\b(?:fees?|frais|costs?|couts?|cout|charges?|clawback|claw\s+back|bond|payable|cost-recovery|recover\w*|deduct\w*|deduit\w*|retenu\w*\s+sur|reimburs\w*|rembours\w*|repay\w*|repayment|half|moitie)\b|\b50\s*%|\b(?:costs?|fees?|frais|couts?|expenses?|depenses)\b[^.;]{0,30}\b(?:shared?|split|partag\w*)|\b(?:shared?|split|partag\w*)\s+(?:with|avec)\s+(?:the\s+|le\s+|la\s+)?(?:workers?|employees?|candidates?|you|travailleu\w*|employe\w*|candidat\w*)|\b(?:workers?|employees?|candidates?|applicants?|you|travailleu\w*|employe\w*)\s+(?:will\s+|must\s+|also\s+)?(?:covers?|pays?|contribut\w*|bears?|shares?|reimburs\w*|repays?|sign\w*\s+a\s+(?:\w+\s+){0,2}(?:cost|bond|repayment))\b|\bcontribut\w*\s+(?:\$|\d|to(?:ward)?s?\s+(?:the\s+)?(?:cost|fee|expense))|\b(?:administrative|admin|service|processing|recruitment|placement)\s+(?:fee|charge|cost)s?\b|\btaken\s+from\s+(?:your\s+)?(?:wages?|pay|salary|paycheques?|paychecks?)|\bfrom\s+your\s+(?:wages?|pay|salary|paycheques?|paychecks?)/;
const LIVING_COST = /\b(?:housing|accommodation|rent|room|board|meals?|parking|uniforms?|transport\w*|bus|shuttle|logement|loyer|repas|stationnement|hebergement|lodging|cafeteria)\b/;
const TAKE_CHARGE = /\b(?:pren\w*|pris\w*|prise|prendr\w*)\s+en\s+charge\b|\bfree\s+of\s+charge\b|\bat\s+no\s+(?:cost|charge)(?:\s+to\s+you)?\b|\bsans\s+frais(?:\s+pour\s+vous)?\b|\bcharge\s+nurse\b/g;
const nbCost = (x) => NB_COST_RAW.test(x.replace(TAKE_CHARGE, " ")) && !(EMPLOYER_PAYS.test(x) && !CAND_RESP.some((re) => re.test(x))) && !(LIVING_COST.test(x) && !SUPPORT_WORD.test(x));
// a claim scoped to a count / non-role group ("first three hires", "to our apprentices", "à nos cadres")
const COUNT_GROUP = /\b(?:for|to|a|aux?|pour)\s+(?:some|a\s+few|few|most|half|several|select|a\s+select|a\s+limited\s+number|a\s+small\s+number|one|a\s+handful|certain)\b|\b(?:some|a\s+few|most|half)\s+(?:of\s+)?(?:our\s+)?(?:hires|positions|roles|openings|workers|employees|candidates|staff|applicants)\b|\bthe\s+first\s+(?:\d+|two|three|four|five|ten|few)\b|\b\d+\s+(?:of|out\s+of)\s+(?:the\s+|our\s+)?\d+\b|\btop\s+\d+\s*%|\bone\s+(?:hire|worker|position|person|candidate)\s+per\b|\blimited\s+number\b|\bwait\s*-?\s*list\w*|\bliste\s+d'attente\b|\bselect\s+group\b|\bper\s+(?:intake|year|season|cohort)\b/;
const NONROLE_GROUP = /\b(?:to|for|a|aux?|pour)\s+(?:our\s+|nos\s+|notre\s+|the\s+|les\s+|des\s+|all\s+(?:of\s+)?our\s+)?(?:[\w'-]+\s+){0,2}?(?:apprentices?|interns?|trainees?|executives?|managers?|cadres|graduates?|alumni|diplomes|stagiaires|students?|etudiants|existing|current|senior|returning|long-term\s+employees|employes\s+(?:de|du|des)|employees\s+(?:of|at|in)|staff\s+(?:of|at|in)|divisions?|branch(?:es)?|plants?|usines?|succursales?|franchisees|members)\b|\bgraduates?\s+of\b|\bdiplome\w*\s+(?:de|du)\b/;
const GENERIC_PEOPLE = /^(?:hires|recruits|candidates|applicants|workers|employees|staff|people|individuals|travailleurs|travailleuses|employes|candidats|candidates|recrues|newcomers|members|team|talent|you|vous)$/;
const POSSESSIVE_GROUP = /\b(?:to|for|a|aux?|pour)\s+(?:all\s+(?:of\s+)?)?(?:our|nos|notre)\s+((?:[\w'-]+\s+){0,2}?)([\w'-]+(?:s|x))\b/;
function groupScoped(f) {
  if (COUNT_GROUP.test(f) || NONROLE_GROUP.test(f)) return true;
  const m = POSSESSIVE_GROUP.exec(f);
  if (!m) return false;
  const noun = m[2];
  if (GENERIC_PEOPLE.test(noun) || PLACE_NOUN.test(noun) || ROLE_NOUN.test(noun)) return false; // places/roles: subsetScoped decides
  if (/^(?:international|foreign|new|overseas|seasonal\s+)?$/.test(m[1].trim()) && /^(?:hires|workers|recruits)$/.test(noun)) return false;
  return true; // "to our nurses", "for our drivers", "to our seasonal pickers": an existing group
}
// a condition on candidate attributes ("for candidates with CLB 5", "aux candidats qui réussissent")
const ATTR_COND = /\b(?:candidates?|applicants?|workers?|those|hires|employees|people|individuals|anyone|candidat\w*|travailleu\w*|ceux|celles|personnes)\s+(?:with|who|holding|meeting|passing|having|scoring|achieving|completing|signing|willing|qui|avec|detenant|ayant|reussissant|possedant)\b/;
const ATTR_OK = /\b(?:successful|selected|chosen|retained|retenu\w*|selectionne\w*|qualified|qualifie\w*)\s+(?:candidates?|applicants?|candidat\w*)\s+(?:who|qui)\s+(?:is|are|will\s+be|est|sont|sera)\s+(?:hired|selected|chosen|retenu\w*|embauche\w*)/;
// the employer is an immigration/settlement service: support goes to ITS clients, not to the hire
const SERVICE_OBJECT = /\b(?:help|helps|helping|assist|assists|assisting|support|supports|supporting|serve|serves|serving|accompagn\w*|aid\w*|conseill\w*|represent\w*)\s+(?:canadian\s+|local\s+|our\s+|nos\s+|les\s+|des\s+|small\s+)?(?:employers?|businesses|clients?|companies|entreprises|employeurs|families|familles|organi[sz]ations|farms|newcomers|immigrants|nouveaux\s+arrivants|households|corporations?)\b|\b(?:corporate|business|employer)\s+clients\b|\bfor\s+(?:our\s+)?(?:corporate\s+)?clients\b/;
const SERVICE_FIRM = /\b(?:we\s+are|we're|notre\s+cabinet|our\s+(?:firm|practice|consultancy|agency))\b[^.;]{0,50}\b(?:immigration|consult\w*|law\s+firm|cabinet|rcic|settlement|staffing|recruitment\s+agency)\b|\b(?:immigration|settlement)\s+(?:consultancy|consultants?|law\s+firm|firm|agency|services?|organi[sz]ation|cabinet)\b/;
const GOVT = /\b(?:province|provincial|government|gouvernement|ircc|pnp|nominee|endorsement|ymca|settlement|settlement\.org|links?|liens?)\b/;
// "government (and legal) fees/costs" paid by the employer is a cost statement, not a government programme
const GOVT_FEES = /\b(?:government(?:al)?|gouvernementa\w*)\s+(?:(?:and|&|et)\s+(?:legal|processing|filing|application|immigration|juridiques?|legaux)\s+)?(?:fees?|costs?|charges?|expenses?|frais|couts?)\b|\b(?:legal|processing|filing|application|immigration)\s+(?:and|&)\s+government(?:al)?\s+(?:fees?|costs?|charges?|expenses?)\b|\bfrais\s+(?:gouvernementaux|du\s+gouvernement)\b/g;
const govtVeto = (f) => GOVT.test(EMPLOYER_PAYS.test(f) && !CAND_RESP.some((re) => re.test(f)) ? f.replace(GOVT_FEES, " ") : f);
const PREFER_LOCAL = /\b(?:canadian|local|citizens?|permanent\s+residents?|pr|canadiens?|locaux|residents?)\s+(?:applicants?|candidates?|workers?|candidats?|travailleurs?)?\s*(?:are\s+|will\s+be\s+|sont\s+)?(?:preferred|prioriti[sz]ed|given\s+(?:priority|preference)|privilegi\w*|prefere\w*|en\s+priorite)\b|\bpriority\s+(?:to|for|given\s+to)\s+(?:canadians?|citizens?|local|permanent)/;
const MARKETING = /\b(?:emplois?|postes|offres|jobs?)\s+(?:avec\s+|with\s+)?(?:eimt|lmia|parrainage)\b|\bmis\s+a\s+jour\b|\b(?:updated|listed|posted)\s+daily\b|\b(?:lmia|eimt|visa\s+sponsorship|sponsorship|work\s+permit)\s+(?:approved\s+)?jobs\b|\bjobs?\s+with\s+(?:visa\s+)?sponsorship\b|\bdreams?\b|\bstarts?\s+here\b|\btop\s+\d+\b/;
const BACKREF = /\b(?:above|ci-dessus|mentioned\s+(?:earlier|before|previously)|stated\s+(?:earlier|above)|aforementioned|precedemment|plus\s+haut|earlier\s+in\s+this)\b/;
const THIS_IS = /\b(?:this|the\s+current)\s+(?:posting|role|position|job|ad|opening|vacancy|offer|advertisement)\s+is\s+(?:for|in|at|located|based|an?|part|full|seasonal|our)\b|\bthis\s+is\s+an?\s+(?:[\w'-]+\s+){0,3}?(?:role|position|posting|job)\b|\bce\s+poste\s+est\b|\bcurrent\s+(?:posting|opening)\s+is\b/;

function candidateHeld(f) {
  if (CAND_HELD.some((re) => re.test(f))) return true;
  if (!POSSESSIVE_LMIA.test(f)) return false;
  const acting = AFFIRM[0].exec(f); // "we will handle your LMIA": the employer acts on it
  return !(acting && POSSESSIVE_LMIA.test(acting[0]));
}

// a sentence next to a claim that qualifies it. A sentence about a DIFFERENT named benefit ("Subject to
// approval, relocation costs are covered") without a back-reference to the claim does not.
const THIS_JOB = /\b(?:this|ce|cette)\s+(?:posting|role|position|job|poste|offre|vacancy|ad|advertisement)\b/;
const OTHER_BENEFIT = /\b(?:relocation|relocalisation|demenagement|housing|accommodation|logement|bonus\w*|vacation|vacances|training|formation|health|dental|vision|meals?|repas|uniforms?|tips|pourboires|overtime|parking|flights?|airfare|billet\s+d'avion|rrsp|pension|insurance|assurances?)\b/;
const CLAIM_REF = /\b(?:this|that|it|these|those|above|ci-dessus|ceci|cela|the\s+(?:offer|benefits?|perks?|program))\b/;
function unitQualifier(x) {
  const workerSide = /\b(?:workers?|employees?|you|candidates?|applicants?|travailleu\w*|employe\w*)\s+(?:will\s+|must\s+|also\s+)?(?:sign|pay|cover|contribut|repay|reimburs|bear|share)\w*|\b(?:agreement|contract|bond|clawback|entente|contrat)\b/.test(x);
  if (OTHER_BENEFIT.test(x) && !SUPPORT_WORD.test(x) && !CLAIM_REF.test(x) && !workerSide) return false;
  return NB_NEGREF.test(x) || NB_LIMIT.test(x) || NB_TIME.test(x) || TIME_GATE.test(x) || NB_COND.test(x) || nbCost(x) || BARE_NEG_SENTENCE.test(x);
}
const QUAL_OPENER = /^\W*(?:note|notes|nb|n\.?\s?b\.?|p\.?\s?s\.?|this|these|that|those|conditions?|terms|please\s+note|disclaimer|important|caveat|exceptions?|ceci|cela|ces|veuillez\s+noter|remarques?|a\s+noter|attention|avertissement)\b/;
function broadQualifier(x) {
  return unitQualifier(x) || ONLY.test(x) || SCOPE.test(x) || CONDITION.test(x) || HEDGE.test(x) || TIME_PAST.test(x) || NEG_CUE.test(x)
    || (!THIS_JOB.test(x) && (subsetScoped(x) || groupScoped(x))) || (ATTR_COND.test(x) && !ATTR_OK.test(x)) || CAND_RESP.some((re) => re.test(x)) || THIRD_PARTY.test(x);
}
function vetoReasons({ f, c, i, list, unitF, near, next, windowFee, qualified, unitIdx, unitFlag }) {
  const checks = [
    ["unit qualifier", () => unitIdx.some((j) => unitFlag(j))],
    ["role mismatch", () => qualified && unitF.some((x) => THIS_IS.test(x))],
    ["c.tag", () => c.tag],
    ["MARKETING.test(f)", () => MARKETING.test(f)],
    ["TIME_GATE.test(f)", () => TIME_GATE.test(f)],
    ["NB_COND.test(f)", () => NB_COND.test(f)],
    ["NB_TIME.test(f)", () => NB_TIME.test(f)],
    ["NB_LIMIT.test(f)", () => NB_LIMIT.test(f)],
    ["groupScoped(f)", () => !THIS_JOB.test(f) && groupScoped(f)],
    ["(ATTR_COND.test(f) && !ATTR_OK.test(f))", () => (ATTR_COND.test(f) && !ATTR_OK.test(f))],
    ["SERVICE_OBJECT.test(f)", () => SERVICE_OBJECT.test(f)],
    ["GOVT.test(f)", () => govtVeto(f)],
    ["nbCost(f)", () => nbCost(f)],
    ["HEDGE.test(f)", () => HEDGE.test(f)],
    ["CONDITION.test(f)", () => CONDITION.test(f)],
    ["SCOPE.test(near)", () => SCOPE.test(near)],
    ["ONLY.test(f)", () => ONLY.test(f)],
    ["subsetScoped(f)", () => !THIS_JOB.test(f) && subsetScoped(f)],
    ["DUTIES.test(f)", () => DUTIES.test(f)],
    ["NEG_CUE.test(f)", () => NEG_CUE.test(f)],
    ["CAND_RESP.some((re) => re.test(f))", () => CAND_RESP.some((re) => re.test(f))],
    ["REPORTED.test(f)", () => REPORTED.test(f)],
    ["THIRD_PARTY.test(f)", () => THIRD_PARTY.test(THIS_JOB.test(f) ? f.replace(/\bthrough\s+this\s+(?:posting|ad|advertisement)\b/g, " ") : f)],
    ["THIRD_PARTY.test(next)", () => THIRD_PARTY.test(next)],
    ["UNRELATED_AFF.test(f)", () => UNRELATED_AFF.test(f)],
    ["windowFee", () => windowFee],
    ["[list[i - 2], list[i - 1], c, list[i + 1", () => [list[i - 2], list[i - 1], c, list[i + 1], list[i + 2]].some((x) => x && priceNextToSupport(x.f))],
    ["BARE_NEG_SENTENCE.test(next)", () => BARE_NEG_SENTENCE.test(next)],
    ["otherRoleHiring(f, [list[i - 2], list[i ", () => otherRoleHiring(f, [list[i - 2], list[i - 1], list[i + 1], list[i + 2]].filter(Boolean).map((x) => x.f))],
  ];
  if (!debugHook) { const hit = checks.find(([, t]) => t()); return hit ? [hit[0]] : []; }
  return checks.filter(([, t]) => t()).map(([n]) => n);
}
// Module-private diagnostics hook (never exported; always null in production). Development probes can compile
// the module with a setter appended; nothing in the app or the test suite can switch it on.
let debugHook = null;

/** Ad-text classification: allowlist for stated_in_ad, restrictions/denials for unavailable. */
let adKey = null;
let adVal = null;
function detectFromAd(description) {
  const key = String(description === null || description === undefined ? "" : description);
  if (adKey === key && !debugHook) return adVal;
  adVal = detectFromAdUncached(description);
  adKey = key;
  return adVal;
}
function detectFromAdUncached(description) {
  const { list, truncated } = prepare(description);
  let soft = truncated || false; // whole-ad block on any affirmative label (never unavailable on its own)
  // 1. whole-ad restrictions + candidate-held LMIA
  for (const c of list) {
    if (RESTRICT.some((re) => re.test(c.f))) return { label: "unavailable", evidence: c.q };
    if (c.req && REQ_SECTION_RESTRICT.test(c.f) && !NEG_CUE.test(benign(c.f))) return { label: "unavailable", evidence: c.q };
    if (candidateHeld(c.f)) {
      if (STRICT_WORD.test(c.f) && !/\b(?:if|si|preferred|prefer\w*|welcome|bienvenu\w*|encourag\w*|may|can|peuvent|asset|atout)\b/.test(c.f)) return { label: "unavailable", evidence: c.q };
      soft = true;
    }
    if (RETRACTION.test(c.f)) soft = true;
    const bb = benign(c.f);
    if (BACKREF.test(bb) && (NB_NEGREF.test(bb) || NB_LIMIT.test(bb) || NB_TIME.test(bb) || TIME_GATE.test(bb) || NB_COND.test(bb) || nbCost(bb) || THIS_IS.test(bb))) soft = true;
    if (SERVICE_FIRM.test(bb) || PREFER_LOCAL.test(bb)) soft = true;
    // a qualifier on ANY sponsorship sentence (however far from the affirmative) limits the whole ad
    const bf = benign(c.f);
    if (STRONG_WORD.test(bf) && !(UNRELATED.test(bf) && !RELATED.test(bf)) && (CONDITION.test(bf) || TIME_PAST.test(bf) || SCOPE.test(bf) || ONLY.test(bf) || (!THIS_JOB.test(bf) && subsetScoped(bf)) || THIRD_PARTY.test(bf) || CAND_RESP.some((re) => re.test(bf))
      || (FEE.test(bf) && (!EMPLOYER_PAYS.test(bf) || CAND_RESP.some((re) => re.test(bf)))) || priceNextToSupport(bf))) soft = true;
  }
  let stated = null;
  const bcache = new Array(list.length);
  const B = (j) => (bcache[j] === undefined ? (bcache[j] = benign(list[j].f)) : bcache[j]);
  const ucache = new Array(list.length);
  const unitFlag = (j) => (ucache[j] === undefined ? (ucache[j] = unitQualifier(B(j))) : ucache[j]);
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    const f = B(i);
    const segs = segmentsOf(f);
    let sentenceHasSupportWord = false;
    // 2. denials: a sponsorship word and a negation/candidate-responsibility in the same segment
    for (const seg of segs) {
      if (UNRELATED.test(seg) && !RELATED.test(seg)) continue;
      if (NEGATIVE.some((re) => re.test(seg))) return { label: "unavailable", evidence: c.q };
      if (!STRONG_WORD.test(seg)) continue;
      sentenceHasSupportWord = true;
      if (NEG_CUE.test(seg) || NEG_VALUE.test(seg) || CAND_RESP.some((re) => re.test(seg))) return { label: "unavailable", evidence: c.q };
    }
    if (NEG_VALUE.test(f) && STRONG_WORD.test(f)) return { label: "unavailable", evidence: c.q };
    if (!sentenceHasSupportWord || stated || soft || c.req) continue;
    // affirmative first (cheap), then the vetoes
    const ans = f.slice(f.lastIndexOf("?") + 1); // a question is not a statement: only the text after the last "?" can affirm
    const ansSegs = segmentsOf(ans);
    const segHit = AFFIRM.some((re) => re.test(ans)) || ansSegs.some((seg) => AFFIRM.some((re) => re.test(seg)));
    const itemHit = c.offer && ansSegs.some((seg) => BARE_ITEM.test(seg));
    if (!(segHit || AFFIRM_VALUE.test(f) || itemHit)) continue;
    // 3. affirmative statement + vetoes by category
    const prev = list[i - 1] ? benign(list[i - 1].f) : "";
    const next = list[i + 1] ? benign(list[i + 1].f) : "";
    const near = `${prev} ${f} ${next}`;
    const windowFee = [list[i - 2], list[i - 1], c, list[i + 1], list[i + 2]].some((x) => {
      if (!x) return false;
      const xf = benign(x.f);
      return FEE.test(xf) && (!EMPLOYER_PAYS.test(xf) || CAND_RESP.some((re) => re.test(xf)));
    });
    // proximity unit: same paragraph, previous sentence + next 2 (+ the whole section for list items)
    const unitIdx = new Set();
    for (let j = Math.max(0, i - 1); j <= Math.min(list.length - 1, i + 2); j += 1) if (j !== i && list[j].par === c.par) unitIdx.add(j);
    if (c.offer) {
      for (let j = i + 1, n = 0; j < list.length && n < 30 && (list[j].sec === c.sec || list[j].par === c.par); j += 1, n += 1) unitIdx.add(j);
      for (let j = i - 1, n = 0; j >= 0 && n < 30 && list[j].sec === c.sec; j -= 1, n += 1) unitIdx.add(j);
    }
    // gap A: a qualifier may follow after ONE blank line ("We offer visa sponsorship.\n\nNote: Toronto only.").
    // The first two sentences of the next paragraph join the unit; when that paragraph opens with a short
    // qualifier word (Note, NB, P.S., This, Conditions, Ceci, Veuillez noter...) the broader sentence-level
    // vetoes (scope, only, condition, hedge, subset/group) apply to it as well.
    const nextPar = [];
    let nextParId = null;
    for (let j = i + 1, steps = 0; j < list.length && nextPar.length < 2 && steps < 60; j += 1, steps += 1) {
      if (list[j].par === c.par) continue;
      if (nextParId === null) nextParId = list[j].par; // the NEXT paragraph, however many blank lines precede it
      if (list[j].par !== nextParId || list[j].sec !== c.sec) break; // a new section header ends the unit
      nextPar.push(j);
    }
    for (const j of nextPar) unitIdx.add(j);
    const opener = nextPar.length > 0 && QUAL_OPENER.test(B(nextPar[0]));
    const blankLineQualifier = opener && nextPar.some((j) => broadQualifier(B(j)));
    const unitF = [...unitIdx].map((j) => B(j));
    const qualified = subsetScoped(f) || groupScoped(f) || /\b(?:for|to|aux?|pour)\s+(?:our\s+|nos\s+)?(?:[\w'-]+\s+){0,2}?(?:staff|employees|roles|positions|postes|cooks|drivers|nurses|apprentices|division|plant|branch)\b/.test(f) || /\bour\s+(?:[\w'-]+\s+){0,2}(?:plant|branch|office|division|location|site|store|farm|department|usine|succursale)\b/.test(f);
    const why = vetoReasons({ f, c, i, list, unitF, near, next, windowFee, qualified, unitIdx: [...unitIdx], unitFlag });
    if (blankLineQualifier) why.unshift("qualifier after a blank line");
    if (debugHook) debugHook(c.q, why);
    const veto = why.length > 0;
    if (veto) continue;
    stated = { label: "stated_in_ad", evidence: c.q };
  }
  if (soft) return { label: "unknown", evidence: null };
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

// ---- overseas acceptance: true only on an allowlisted positive with no exclusion/restriction/hedge anywhere ----
const PEOPLE = /\b(?:applicants?|candidates?|candidat(?:e)?s?|workers?|hires?|employees?|travailleurs?|recruits?|students?|talent)\b/;
const OVERSEAS_SUBJECT = /\b(?:abroad|overseas|outside\s+(?:of\s+)?(?:canada|the\s+country)|out\s+of\s+(?:canada|country)|international|foreign|etranger\w*|internationaux|internationales?|hors\s+(?:du\s+)?canada|global|worldwide)\b/;
const OVERSEAS_WORD = /\b(?:abroad|overseas|international|foreign|worldwide|global|anywhere|etranger\w*|internationaux|internationales?|outside\s+(?:of\s+)?canada|from\s+outside)\b/;
const PLACE_BOUND = [
  /\b(?:must|need\s+to|should|required\s+to|have\s+to|doit|doivent)\s+(?:\w+\s+){0,3}?(?:reside|live|living|residing|located|based|present|stay|remain|resider|habiter|vivre|se\s+trouver|etre\s+(?:situes?|presents?|installes?))\b[^.;]{0,30}?\b(?:in|within|at|au|en|a|dans)\b/,
  /\bmust\s+(?:\w+\s+){0,3}?be\s+(?:currently\s+|physically\s+)?(?:in|within|at|on)\s+(?:the\s+)?(?!an?\s|good|charge|position|compliance|able|willing|eligible|available|comfortable|familiar|proficient|fluent|flexible)\w+/,
  /\bon[- ]?site\b[^.]{0,20}\b(?:day\s+one|from\s+day|required|only)\b|\bmust\s+be\s+on[- ]?site\b/,
  /\bwithin\s+\d+\s*(?:km|miles?|kilometres?|kilometers?)\b/,
  /\balready\s+(?:in|living|residing|based|located|hold|holding|have|possess)\b/,
  /\b(?:currently|presently|already)\s+(?:living|residing|studying|in|based|located|working|resident)\b/,
  /\b(?:living|residing|resident|studying|based|located)\s+(?:already\s+)?(?:in|within)\b/,
  /\bresiding\b|\bresidant\b|\bdeja\s+(?:au|en|a|dans|installes?|residant)\b/,
  /\bholding\s+an?\s+(?:open\s+)?work\s+permit\b|\bholders?\s+of\s+an?\s+(?:open\s+)?work\s+permit\b/,
  /\b(?:local|domestic|internal)\s+(?:candidates?|applicants?|hires?|transfers?)\b|\bdomestic\s+hires?\b|\blocal(?:ly)?\s+(?:only|talent)\b|\b(?:hire|hiring|recruit\w*)\s+locally\b/,
  /\b(?:canadian\s+)?residents?\s+(?:of\s+\w+\s+)?(?:only|seulement|uniquement)\b|\bresidents?\s+canadiens?\b|\bresidents?\s+du\s+canada\b|\bcandidats?\s+locaux\b|\bbased\s+only\b|-based\s+only\b/,
  /\bmoves?\s+within\b|\bwithin\s+(?:the\s+)?(?:province|country|canada)\b|\bwe\s+do\s+not\s+fly\b|\bwe\s+don'?t\s+fly\b/,
  /\bresiden(?:ce|cy)\b[^.;]{0,40}\b(?:exige\w*|requise?|required|mandatory|obligatoire|needed)\b|\b(?:exige\w*|requise?|required|mandatory|obligatoire)\b[^.;]{0,20}\bresiden(?:ce|cy)\b/,
];
// "international" candidates who must already hold a Canadian permit/status are in Canada already.
const PERMIT_HELD = /\b(?:(?<!(?:help|helps|assist|assists|support|supports|aide|aidons)\s)with|who\s+(?:have|hold|possess|already\s+have)|having|holding|if\s+(?:they|you)\s+(?:have|hold)|must\s+(?:have|hold|possess)|holders?\s+of|avec|detenant|s'ils\s+detiennent|si\s+(?:vous|ils)\s+(?:detenez|detiennent|avez|ont)|ayant|possedant|munis?\s+d')\s+(?:\w+\s+){0,3}?(?:permits?|permis|pgwp|visas?|status|statut|authori[sz]ation)\b|\b(?:permits?|permis|pgwp|visa)\b(?:\s+[\w'-]+){0,3}?\s+(?:holders?|required|requis\w*|exige\w*|needed|mandatory|obligatoire)\b|\bpgwp\b|\biec\b|\bworking\s+holiday\b|\bpvt\b|\bjeunes\s+professionnels\b|\byouth\s+mobility\b|\binternational\s+experience\s+canada\b|\bpost[- ]graduation\s+work\s+permit\b|\b(?:on|off)[- ]campus\b|\bstudy\s+permit\b|\bpermis\s+d'etudes\b|\b(?:international|foreign)\s+students?\b|\betudiant\w*\s+(?:internationa\w*|etranger\w*)\b|\bstudents?\b|\betudiant\w*\b|\b(?:open|valid|current|existing)\s+(?:work\s+)?permits?\b|\bpermis\s+(?:de\s+travail\s+)?(?:ouvert|valide)\b/;
const COMPANY_SENTENCE = /^\W*(?:we\s+are|we're|our|the\s+(?:company|firm|employer)|about\s+us|nous\s+sommes|notre|l'entreprise|(?:[\w'-]+\s+){0,3}(?:is|est)\s+an?\s+(?:[\w'-]+\s+){0,3}(?:company|firm|carrier|employer|entreprise))\b/;
const BASED_NEAR = /\b[\w'-]+-based\b|\bbased\s+(?:in|out\s+of|at)\b|\bbase\w*\s+(?:a|au|en|dans)\b|\bin[- ]person\s+(?:only|interview)/;
const START_DAY = /\bstart(?:s|ing)?(?:\s+date)?\s*:?\s*(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|immediately|asap|lundi|mardi|mercredi|jeudi|vendredi|demain)\b|\bday\s+one\b/;
const IN_PERSON = /\bin[- ]person\b|\ben\s+personne\b|\bon[- ]site\s+interviews?\b|\bface[- ]to[- ]face\b|\bpresentiel\w*/;
const START_SOON = /\b(?:start|begin|report|commenc\w*|join)\b[^.;]{0,40}\b(?:within|in|sous|d'ici)\s+(?:\d+|one|two|three|a\s+few|a|une?|deux|trois)\s+(?:days?|weeks?|jours?|semaines?)\b|\b(?:immediate\s+start|start\s+immediately|asap|immediatement|des\s+que\s+possible)\b/;
// Conditions that make overseas acceptance uncertain (never true), without excluding anyone outright.
const OV_BLOCK = /\bonce\s+(?:they\s+)?(?:have\s+)?landed\b|\bafter\s+(?:obtaining|getting)\s+(?:pr|permanent)\b|\bafter\s+(?:\d+|six|one|two|a)\s+(?:months?|years?)\b/;
const PREFERENCE = /\b(?:prefer\w*|priority|preference|priorite|privilegi\w*)\b/;
const OVERSEAS_HEDGE = /\b(?:tbd|tba|to\s+be\s+(?:discussed|confirmed)|subject\s+to|sous\s+reserve|upon|depending|depend\w*|selon|may\s+be|might|could|would|pourrait|maybe|perhaps|if|only\s+if|unless|pending|eventually|later|future|limited|case[- ]by[- ]case|discretion|once|after|apres|probation|used\s+to|no\s+longer|anymore|hope|hopes|hoping|next\s+(?:year|quarter|month|season)|goal|goals|aim|aims|aiming|long[- ]term|plan|plans|planning|intend\w*|wish\w*|would\s+like|soon|someday|bientot|objectif|souhait\w*|aimerions|previously|formerly|past|was|were|consider\w*|possibl\w*|potential\w*|explor\w*|discuss\w*|correction|kidding)\b|[\u2610\u2020]/;
// overseas wording scoped to a different office/role ("for our UK office", "for other roles", "our Dubai branch")
const OV_OTHER = /\bother\s+(?:roles?|positions?|jobs?|offices?|locations?|countries|branches)\b|\bautres?\s+postes\b|\b(?:excluding|except|sauf)\b/;
const ovScoped = (f) => OV_OTHER.test(f) || subsetScoped(f);
const COUNTRY = "(?:philippines|mexico|mexique|india|inde|guatemala|jamaica|jamaique|vietnam|viet\s+nam|nigeria|ukraine|brazil|bresil|morocco|maroc|tunisia|tunisie|algeria|algerie|senegal|cameroon|cameroun|france|belgium|belgique|colombia|colombie|honduras|el\s+salvador|nepal|pakistan|bangladesh|sri\s+lanka|china|chine|korea|coree|japan|japon|ireland|irlande|united\s+kingdom|australia|australie|south\s+africa|kenya|ghana|ethiopia|egypt|egypte|lebanon|liban|haiti|peru|perou|ecuador|equateur|chile|chili|argentina|argentine|cuba|dominican\s+republic|trinidad|barbados|thailand|thailande|indonesia|indonesie|malaysia|europe|asia|africa|latin\s+america|amerique\s+latine|afrique|asie|the\s+caribbean|caraibes)";
const OV_YES = [
  /\b(?:recrutons|recrute|recrutent|embauchons)\s+(?:activement\s+|aussi\s+)?(?:a\s+l'international|a\s+l'etranger|des\s+travailleu\w*\s+(?:etrange\w*|internationa\w*))\b/,
  /\b(?:recruit|recruits|recruiting|hire|hires|hiring)\s+(?:actively\s+)?(?:internationally|from\s+(?:overseas|abroad))\b/,
  new RegExp(`\\b(?:actively\\s+)?(?:recruit|recruits|recruiting|hire|hires|hiring|recrutons|recrute|embauchons)\\s+(?:(?:[\\w'-]+\\s+){0,3}?)(?:from|en|au|aux|du|des|d')\\s*(?:the\\s+|les\\s+)?${COUNTRY}(?:\\s*(?:,|and|et|or|ou)\\s+(?:the\\s+)?${COUNTRY})*\\b`),
  /\b(?:open\s+to|welcomes?|we\s+welcome|we\s+accept|accepting|we\s+hire|hiring|considering|we\s+consider|encourag\w+)\b[^.;,]{0,30}?\b(?:international|overseas|foreign|global|worldwide|abroad|outside\s+(?:of\s+)?canada|etrangers?|internationaux)\b/,
  /\b(?:international|overseas|foreign|global|worldwide)\s+(?:applicants?|candidates?|students|hires?|workers?|talent)\s+(?:are\s+)?(?:welcome|encouraged|accepted|considered|invited)\b/,
  /\b(?:applicants?|candidates?)\s+(?:from\s+)?(?:abroad|overseas|outside\s+(?:of\s+)?canada)\b(?:\s+(?:are\s+)?(?:welcome|accepted|encouraged|invited|encouraged\s+to\s+apply)|\s+(?:may|can)\s+apply)\b/,
  /\bouvert\s+aux\s+candidat(?:e)?s?\s+(?:internationaux|internationales|etrangers|etrangeres|de\s+l'etranger)\b/,
  /\bcandidat(?:e)?s?\s+(?:internationaux|internationales|etrangers|etrangeres|de\s+l'etranger)\s+(?:sont\s+)?(?:bienvenu\w*|accepte\w*|encourage\w*)\b/,
];
// accepted:true needs a CLEAN positive: around the matched phrase only filler words; other clauses of
// the sentence carry no location/status/condition words; no such requirement anywhere in the ad.
const OV_FILLER = new Set(("we are is our us very warmly also too gladly happily all any to apply applications application may can be welcome welcomed encouraged invited considered accepted open " +
  "from around the world globe everywhere country countries every each season year years annually regularly of a an and de du des la le les l' tous toutes pays monde sont bienvenus bienvenues bienvenue bienvenu " +
  "encourages invites acceptes postuler nous accueillons accueille ouvert ouverte ouverts aux candidats candidates candidate applicants applicant workers worker hires hire hiring talent people " +
  "international internationaux internationales internationale overseas foreign abroad outside canada etranger etrangers etrangeres l'etranger worldwide global globally please strongly highly actively " +
  "consider considering accept accepting welcomes encourage invite recruit recruiting recrutons et en interested qualified experienced skilled").split(" "));
const OV_RISK = /\b(?:must|need|needs|required|requis\w*|exige\w*|mandatory|obligatoire|only|seulement|uniquement|already|deja|live|living|lives|reside\w*|resident\w*|residence|based|holders?|holding|students?|etudiant\w*|local\w*|locaux|citizen\w*|citoyen\w*|pr|sin|nas|in-person|person|interview\w*|condition\w*|if|si|unless|who|qui|whose|except|sauf|excluding|office|branch|team|equipe|permit|permis|status|statut|authori[sz]\w*|eligib\w*|admissib\w*|valid|valide|canadian|canadien\w*|province|gta|city|ville|area|region|provided\s+(?:that\s+)?(?:you|they|applicants?|candidates?)|through|via|partner\w*|partenaire\w*|agency|agence|newcomers?|landed|orientation|start\s+date|sin|nas|licen[cs]e\w*|registered|college|flights?|expense|own|bank|phone|address|adresse|interviews?|entrevues?|cannot|unfortunately|malheureusement)\b/;
const OV_REQ_ANYWHERE = /\b(?:permit|permis|visa|status|statut|sin|nas|licen[cs]e|bank\s+account|phone\s+number|address|adresse|compte\s+bancaire|registration|accreditation)\b[^.;]{0,40}\b(?:must|required|requis\w*|exige\w*|needed|mandatory|obligatoire|necessary|necessaire)\b|\b(?:must|required|requis\w*|exige\w*|mandatory|obligatoire|need\s+to|needs\s+to|have\s+to|doit|doivent|devez)\b[^.;]{0,40}\b(?:sin|social\s+insurance|nas|pr|permanent|residen\w*|citizen\w*|citoyen\w*|status|statut|permit|permis|authori[sz]\w*|autoris\w*|address|adresse|local|canadian|canadien\w*|in\s+canada|au\s+canada|province|in[- ]person|en\s+personne|on[- ]site|interview\w*)\b|\b(?:sin|social\s+insurance\s+number|nas|canadian\s+address|local\s+address|permanent\s+residen\w*|residen(?:ce|cy)|in[- ]person\s+interview|local\s+interview)\b[^.;]{0,30}\b(?:required|requis\w*|exige\w*|mandatory|obligatoire|needed|necessary)\b/;
function ovCleanYes(f) {
  for (const re of OV_YES) {
    const m = re.exec(f);
    if (!m) continue;
    const seg = segmentsOf(f).find((x) => re.test(x)) || f;
    const mm = re.exec(seg) || m;
    const rest = `${seg.slice(0, mm.index)} ${seg.slice(mm.index + mm[0].length)}`;
    const words = rest.split(/[^a-z'-]+/).filter(Boolean);
    if (!words.every((w) => OV_FILLER.has(w))) return false;
    const others = segmentsOf(f).filter((x) => x !== seg).join(" ");
    return !OV_RISK.test(others) && !OV_RISK.test(rest);
  }
  return false;
}
const RELOCATION_YES = /\b(?:relocation|relocalisation|demenagement)\s+(?:(?:assistance|support|package)\s+)?(?:is\s+|are\s+)?(?:provided|offered|available|included|fournie?|offerte?|prise\s+en\s+charge)\b|\b(?:provide|offer)s?\s+relocation\b/;
const WEAK_NO_OVERSEAS = /\b(?:previous|previously|formerly|expired|refused|denied)\b/;

/** accepted: true | false | null. Exclusions anywhere -> false; restrictions/hedges/place-bound text -> never true. */
function detectOverseas(description) {
  const { list, truncated } = prepare(description);
  let blocked = truncated ? "text truncated" : null;
  let restricted = false;
  for (const c of list) {
    if (RESTRICT.some((re) => re.test(c.f)) || (c.req && REQ_SECTION_RESTRICT.test(c.f)) || (candidateHeld(c.f) && STRICT_WORD.test(c.f))) restricted = true;
  }
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    const f = benign(c.f);
    const relocation = /\brelocat\w*|\bdemenag\w*/.test(f);
    const subj = OVERSEAS_SUBJECT.test(f) && PEOPLE.test(f);
    if (subj && !relocation && (NEG_CUE.test(f) || NEG_VALUE.test(f))) return { accepted: false, evidence: c.q };
    const hit = PLACE_BOUND.map((re) => re.exec(f)).find(Boolean);
    // "We are a Winnipeg-based carrier" / "our office is located in" describes the employer, not the candidate
    const employerPlace = hit && /\bbased\b|\blocated\b|\bsitue\w*/.test(hit[0]) && !/\b(?:candidates?|applicants?|you|workers?|employees?|hires?|candidat\w*|travailleu\w*)\b/.test(f) && !/\b(?:must|need|should|required|only|doit|doivent|seulement)\b/.test(f)
      || (hit && COMPANY_SENTENCE.test(f) && !PEOPLE.test(f) && !/\b(?:must|need|should|required|doit|doivent)\b/.test(f));
    if (hit && !employerPlace && !/\b(?:eligib|authori|entitled|permitted|able|allowed|legally)\w*/.test(hit[0])) return { accepted: false, evidence: c.q };
    // "international" applicants who must hold a permit / study here / be based here are already in Canada
    if (OVERSEAS_WORD.test(f) && PERMIT_HELD.test(f)) return { accepted: false, evidence: c.q };
    if (PREFERENCE.test(f) && /\b(?:canadian|local|resident|residents|canada)\b/.test(f)) blocked = "preference";
    if (OV_BLOCK.test(f) && (subj || OVERSEAS_WORD.test(f))) blocked = "condition";
    if (OV_REQ_ANYWHERE.test(f)) blocked = blocked || "location or status requirement";
  }
  if (restricted) blocked = blocked || "work-authorization restriction";
  // cross-axis: an ad that says employer support is unavailable is never read as open to overseas applicants
  if (detectFromAd(description).label === "unavailable") blocked = blocked || "employer support not available";
  const nearOf = (i) => `${list[i - 1] ? list[i - 1].f : ""} ${list[i].f} ${list[i + 1] ? list[i + 1].f : ""}`;
  for (let i = 0; i < list.length; i += 1) {
    const full = benign(list[i].f);
    if (NEG_CUE.test(full) || NEG_VALUE.test(full) || OVERSEAS_HEDGE.test(full) || WEAK_NO_OVERSEAS.test(full) || ovScoped(full) || REPORTED.test(full)) continue;
    const f = full.slice(full.lastIndexOf("?") + 1); // a question is not a statement
    const yes = ovCleanYes(f) || (RELOCATION_YES.test(f) && OVERSEAS_WORD.test(nearOf(i)) && !OV_RISK.test(f.replace(/\bprovided\b/g, " ")));
    if (!yes) continue;
    const next = list[i + 1] ? benign(list[i + 1].f) : "";
    if (PERMIT_HELD.test(next) && next.split(" ").length <= 8) return { accepted: false, evidence: list[i + 1].q };
    // proximity unit (same paragraph: previous sentence + next 2): any requirement/cost/negation keeps it from true
    const supportClaim = (x) => AFFIRM.some((re) => re.test(x)) && !/\b(?:must|required|need|needs|requis\w*|exige\w*|mandatory|own|your\s+own)\b/.test(x);
    const ovUnit = [list[i - 1], list[i + 1], list[i + 2]].filter((x) => x && x.par === list[i].par).map((x) => benign(x.f)).filter((x) => !supportClaim(x) && !(OTHER_BENEFIT.test(x) && !SUPPORT_WORD.test(x) && !CLAIM_REF.test(x) && !OV_RISK.test(x.replace(/\bcosts?\b/g, " "))));
    if (ovUnit.some((x) => OV_RISK.test(x) || NEG_CUE.test(x) || NB_NEGREF.test(x) || nbCost(x) || START_DAY.test(x) || TIME_GATE.test(x) || NB_COND.test(x))) { blocked = blocked || "requirement next to the overseas wording"; continue; }
    if (BASED_NEAR.test(f) || BASED_NEAR.test(next)) { blocked = blocked || "location requirement"; continue; }
    if (START_SOON.test(f) || START_SOON.test(next)) { blocked = blocked || "immediate on-site start"; continue; }
    if (IN_PERSON.test(f) || IN_PERSON.test(next) || ONLY.test(f) || ONLY.test(next)) { blocked = blocked || "in-person or restricted wording"; continue; }
    if (ovScoped(next) || BARE_NEG_SENTENCE.test(next) || OVERSEAS_HEDGE.test(next) && next.split(" ").length <= 6) { blocked = blocked || "scope"; continue; }
    if (blocked) return { accepted: null, evidence: null, blocked };
    return { accepted: true, evidence: list[i].q };
  }
  return { accepted: null, evidence: null, ...(blocked ? { blocked } : {}) };
}

/** Canonical sentences (for tests/diagnostics). */
const normalizeAd = (description) => prepare(description).list;
module.exports = { detectEmployerSupport, detectOverseas, normalizeAd, PRE_CAP, POST_CAP };
