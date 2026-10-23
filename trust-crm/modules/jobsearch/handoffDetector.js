// Conservative detector for postings that need a human step before (or instead of) an email
// application: captcha, payment, legal declaration, login/account, online-only channel, custom
// questions. Biased toward FALSE POSITIVES: a wrongly flagged job only becomes a staff task, a missed
// one could make the system pay, sign or answer for a candidate. Job text is untrusted data; it is
// only pattern-matched, never interpreted.
//
// Matching runs on normalised text: NFKC, lower-case, curly -> straight apostrophes, accents
// stripped, apostrophes (FR elisions d'/l'/n'/j'/qu') and hyphens -> spaces, spaces collapsed, then
// split into sentences. Patterns below are written against that form (no accents, no apostrophes).

const MAX_TEXT = 20000;

function normalizeAdText(raw) {
  return String(raw || "")
    .slice(0, MAX_TEXT)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘ʼ`´′]/g, "'")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[​-‏⁠﻿­]/g, "")
    .replace(/'/g, " ")
    .replace(/[-‐-―−]/g, " ")
    .replace(/[ \t  -  ]+/g, " ");
}

/** Sentences; a '.' only ends a sentence when followed by whitespace/end (keeps "$20.00", "hr@x.com"). */
function sentences(text) {
  return text
    .split(/[!?;\n\r]+|\.(?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- shared pieces

const CUR = "(?:usd|cad|eur|gbp|tnd|mad|dzd|aed|sar|qar|chf|dollars?|euros?|dinars?|dirhams?|livres?|pounds?|dt|dh)";
const AMOUNT_RE = new RegExp(`(?:[$€£¥]\\s?\\d[\\d.,]*)|(?:\\d[\\d.,]*\\s?(?:[$€£¥]|${CUR}\\b|k\\b))|(?:\\b${CUR}\\s?\\d)`, "g");
// Words that make an amount a cost to the candidate (not a wage).
const STRONG_COST_RE = /\b(?:fees?|frais|deposits?|acomptes?|processing|transfers?|transferer|virements?|western union|moneygram|money ?gram|money order|mandats?|wire|remit\w*|upfront|up front|advance|a l avance|avance|caution)\b/g;
const GENERIC_COST_RE = /\b(?:payments?|paiements?|costs?|couts?|charges?|tarifs?|prix|price)\b/g;
const WAGE_CUE_RE = /\b(?:per (?:hour|hr|day|week|month|year|annum)|an hour|hourly|\/ ?(?:h|hr|hour|heure|mois|month|year|an)\b|par (?:heure|jour|semaine|mois|an)|de l heure|weekly|monthly|annual\w*|salary|salaire|wages?|remuneration|gross|net|brut|bonus|prime|overtime)\b/;
// Negation / "the employer pays" immediately before a hit (same sentence) cancels that hit.
const NEGATION_BEFORE_RE = /\b(?:no|not|never|without|zero|aucun\w*|jamais|pas de|pas d|sans|ni|free of|nothing)\b(?! later| only| just)[^]*$/;
const EMPLOYER_PAYS_BEFORE_RE = /\b(?:we|employer|the employer|the company|company|nous|l employeur|employeur|la societe|l entreprise)\s+(?:will\s+|also\s+|fully\s+|shall\s+|)(?:pay|pays|paid|cover|covers|covering|reimburse\w*|paie|paient|payons|prend|prennent|prenons|rembourse\w*|offre|offrons|offers?)\b[^]*$/;
const EMPLOYER_PAYS_AFTER_RE = /^[^]{0,40}?\b(?:(?:paid|covered|borne|provided|offered|reimbursed|refunded|repaid) by (?:the )?(?:employer|company|us|our company)|pris(?:es)? en charge|a la charge de l employeur|aux frais de l employeur|employer paid|company paid|offert\w*|gratuit\w*|free of charge|at no cost|no cost)\b/;

// "we pay for ...", "the employer will provide your ...": the employer is the subject of the hit.
const EMPLOYER_SUBJECT_END_RE = /\b(?:we|employer|the employer|the company|company|nous|l employeur|employeur|they)\s+(?:will\s+|also\s+|fully\s+|shall\s+|can\s+|)$/;

function cancelled(sentence, start, end) {
  const before = sentence.slice(Math.max(0, start - 45), start);
  const after = sentence.slice(end, end + 45);
  return NEGATION_BEFORE_RE.test(before) || EMPLOYER_PAYS_BEFORE_RE.test(before) || EMPLOYER_SUBJECT_END_RE.test(before) || EMPLOYER_PAYS_AFTER_RE.test(after);
}

/** First non-cancelled match of `re` (global) in `s`, or null. */
function liveMatch(s, re) {
  re.lastIndex = 0;
  for (const m of s.matchAll(re)) {
    if (!cancelled(s, m.index, m.index + m[0].length)) return m[0];
  }
  return null;
}

// ---------------------------------------------------------------- categories

const CAPTCHA_RE = /\b(?:re|h)?captcha\b|\bprove (?:that )?you(?: re| are) (?:a )?human\b|\bverify (?:that )?you(?: re| are) (?:a )?human\b|\bi(?: m| am) not a robot\b|\bje ne suis pas un robot\b|\bprouvez que vous etes (?:un )?humain\b|\bhuman verification\b|\bverification humaine\b/g;

const PAYMENT_PHRASES = [
  // candidate is the payer
  /\b(?:you|candidates?|applicants?|workers?|the candidate|the applicant|vous|le candidat|la candidate|les candidats|candidat\w*|postulant\w*)\s+(?:\w+\s+){0,4}?(?:pay|pays|paying|payer|payez|paie|paient|transfer|wire|send money|remit|virer|verser|versez|regler|reglez|deposit)\b/g,
  // imperative at sentence start ("Pay $200 ...", "Payer 200 € ...") - not "Pay: $20/h", "Pay range"
  /^(?:please\s+|merci de\s+|veuillez\s+)?(?:pay|payer|payez|reglez|regler|versez|verser|transfer|transferez|wire)\s+(?=[$€£\d]|a |an |the |your |le |la |les |des |un |une |votre |vos |fee|frais|deposit|acompte|for |pour )/g,
  /\bpay(?:ing)?\s+(?:for|to)\b/g,
  /\bpay(?:ment of|ing)?\s+(?:an?\s+|the\s+|any\s+|your\s+)?(?:\w+\s+)?(?:fee|fees|deposit|charge|sum|amount)\b/g,
  /\b(?:application|processing|registration|placement|recruitment|recruiting|agency|service|visa|training|file|handling|administrative|admin|medical|booking|reservation|enrolment|enrollment|consultancy|consulting|job|work permit|permit|ticket|insurance)\s+(?:fees?|costs?|charges?)\b/g,
  /\bfrais\s+(?:d |de |du |des )?(?:inscription|dossier|traitement|visa|placement|recrutement|service|candidature|reservation|formation|agence|gestion|medical|medicaux|examen|billet|assurance|permis|contrat)\w*/g,
  /\bpayer\s+(?:les|des|le|la|vos|votre)\s+(?:\w+\s+)?(?:frais|couts?|visa|billet|examen|formation|caution|acompte)\b/g,
  /\b(?:fees?|deposit|frais|acompte|caution)\s+(?:of\s+\S+\s+)?(?:is\s+|are\s+|sont\s+|est\s+)?(?:required|payable|due|apply|applies|charged|demande\w*|exige\w*|requis\w*|a payer|obligatoire\w*)\b/g,
  /\b(?:in advance|upfront|up front|a l avance|d avance)\b/g,
  /\bto secure your (?:place|placement|position|job|spot|seat|post|contract|visa|offer)\b|\bpour (?:reserver|securiser|garantir|bloquer) (?:votre|ta) (?:place|poste|contrat|visa|emploi)\b|\breservation de votre (?:poste|place)\b/g,
  /\bwestern union\b|\bmoney ?gram\b|\bmoney order\b|\bmandat (?:cash|postal|minute)\b|\bgift cards?\b|\bcartes? cadeaux?\b|\bcrypto\w*\b|\bbitcoin\b/g,
];

function detectPayment(s) {
  for (const re of PAYMENT_PHRASES) {
    const m = liveMatch(s, re);
    if (m) {
      // "in advance"/"upfront" alone only count with a cost word or an amount in the sentence.
      if (/^(?:in advance|upfront|up front|a l avance|d avance)$/.test(m) && !/\b(?:pay\w*|payer|frais|fees?|costs?|deposit|acompte|\d)/.test(s)) continue;
      return m;
    }
  }
  // An amount within ~60 chars of a cost word (wage sentences excluded for generic cost words).
  const amounts = [...s.matchAll(AMOUNT_RE)];
  if (!amounts.length) return null;
  const wage = WAGE_CUE_RE.test(s);
  for (const [re, generic] of [[STRONG_COST_RE, false], [GENERIC_COST_RE, true]]) {
    if (generic && wage) continue;
    re.lastIndex = 0;
    for (const w of s.matchAll(re)) {
      for (const a of amounts) {
        const lo = Math.min(a.index, w.index);
        const hi = Math.max(a.index + a[0].length, w.index + w[0].length);
        if (hi - lo <= 70 && !cancelled(s, lo, hi)) return `${w[0]} ~ ${a[0]}`;
      }
    }
  }
  return null;
}

const LEGAL_RE = [
  /\bsign(?:ez|er|e|ed|ing|ature|atures)?\b[^]{0,45}?\b(?:declarations?|forms?|formulaires?|oaths?|serments?|attestations?|affidavits?|consent|consentement|statements?|undertaking|engagement|waiver|decharge)\b/g,
  /\b(?:declarations?|attestations?|formulaires?|forms?|statements?|engagement)\s+(?:\w+\s+){0,3}?(?:signed|signee?s?|a signer|to be signed|must be signed)\b/g,
  /\bi\s+(?:hereby\s+|the undersigned\s+)?(?:certify|declare|attest|swear|affirm|confirm under)\b|\bje\s+(?:soussigne\w*\s+)?(?:certifie|declare|atteste|jure)\b|\bj atteste\b|\bnous certifions\b/g,
  /\bsworn\b|\baffidavit\b|\bstatutory declaration\b|\bdeclare\s+under\s+(?:penalty|oath)\b|\bunder (?:penalty of perjury|oath)\b|\b(?:declaration|attestation)\s+sur\s+l\s+honneur\b|\bsur l\s+honneur\b|\bdeclaration (?:of|de) (?:honou?r|criminal|non condamnation|bonne conduite)\b|\bnotari[sz]ed\b|\bnotarie\w*\b/g,
];
const LOGIN_RE = [
  /\baccount (?:is )?(?:required|mandatory|needed to apply)\b|\bcompte (?:est )?(?:requis|obligatoire|necessaire)\b/g,
  /\bcreate (?:an |a |your |a free |an online )?(?:account|profile|login)\b|\b(?:creez|creer|ouvrez|ouvrir) (?:votre |un |ton )?(?:compte|profil)\b/g,
  /\binscrivez vous\b|\binscris toi\b|\bs inscrire (?:sur|a|au)\b|\binscription (?:sur|a) (?:notre|la) (?:plateforme|site|portail)\b/g,
  /\bregister (?:on|at|with|via|through|in) (?:our|the) (?:\w+ )?(?:portal|platform|site|website|system|app)\b|\bregister (?:an |your )?account\b/g,
  /\b(?:log ?in|log ?on|sign ?in|login) (?:to|into|on|at|via|through) (?:our |the |your )?(?:\w+ ){0,2}?(?:apply|portal|website|site|platform|account|system|careers|career|page|app)\b/g,
  /\b(?:connectez vous|identifiez vous|se connecter|connexion requise)\b/g,
];
const ONLINE_ONLY_RE = [
  /\bapply (?:via|through|on|at|using|from) (?:our|the) (?:\w+ ){0,2}?(?:portal|website|platform|site|page|system|ats|link|app|form)\b/g,
  /\bapply (?:only )?online\b|\bonline application\b|\bapplication form online\b|\bapply on line\b/g,
  /\bcomplete (?:the |our |an )?(?:online )?application form\b|\bfill (?:in|out) (?:the |our |an )?(?:online |attached )?(?:application )?form\b/g,
  /\b(?:postulez|postuler|candidatez|candidater) (?:uniquement |seulement )?(?:en ligne|via (?:notre|le) (?:site|portail|plateforme|formulaire))\b|\bcandidature en ligne\b/g,
  /\b(?:remplissez|remplir|completez|completer) (?:le |notre )?formulaire\b|\bformulaire (?:de candidature )?en ligne\b/g,
  /\b(?:email|e mail|emailed|mailed) applications? (?:are |will )?(?:not|no longer) (?:be )?accepted\b|\bno (?:email|e mail) applications\b|\bdo not (?:send|email|e mail|mail) (?:us )?(?:your )?(?:cvs?|resumes?|applications?|documents)\b|\bapplications? (?:are |will be )?(?:only |exclusively )?accepted (?:only |exclusively )?(?:online|via|through)\b/g,
  /\bcandidatures? (?:envoyees? )?par (?:courriel|e mail|email|mail|courrier electronique) ne (?:sont|seront) pas (?:acceptees?|traitees?|considerees?)\b|\bn envoyez pas (?:votre |vos )?(?:cv|candidature)/g,
];
const QUESTIONS_RE = [
  /\banswers? (?:to )?(?:the )?following\b|\binclude (?:your )?answers? to\b|\banswer (?:these|our|all|the|each|a few|some) (?:\w+ )?(?:questions?|queries)\b/g,
  /\bscreening questions?\b|\bquestionnaire\b|\bquiz\b|\bassessment questions?\b|\bknock ?out questions?\b/g,
  /\brepond(?:ez|re|ant) (?:aux?|a la|a ces|a nos) (?:\w+ )?(?:questions?|questionnaire)\b|\bquestions suivantes\b/g,
  /\bplease explain (?:why|how|what)\b|\bexpliquez (?:pourquoi|comment)\b|\bdescribe (?:a time|how you|why you)\b|\btell us (?:about a time|why|how)\b/g,
];
// "please state your X" / "veuillez indiquer vos X": custom answer unless the profile/preferences hold it.
const STATE_YOUR_RE = /\b(?:state|specify|indicate|mention|tell us|let us know|provide|include|confirm|advise|list|indiquer|indiquez|indique|preciser|precisez|mentionner|mentionnez|communiquer|communiquez|donner|donnez)\s+(?:us\s+|nous\s+)?(?:your|vos|votre|ton|tes)\s+([a-z ]{3,40})/g;
const BASIC_SUBJECT_RE = /^(?:cv|cvs|resume|curriculum|cover|lettre|motivation|application|candidature|contact|e ?mail|email address|adresse|phone|telephone|mobile|name|nom|full name|coordonnees|portfolio)\b/;
const ANSWERABLE = [
  [/\b(?:salary|salaire|pretentions?|remuneration|compensation|pay|wage|rate)\b/, (ctx) => ctx.salary_min !== null && ctx.salary_min !== undefined && ctx.salary_min !== ""],
  [/\b(?:availab\w*|disponibilit\w*|start date|date de debut|notice period|preavis)\b/, (ctx) => typeof ctx.availability === "string" && ctx.availability.trim() !== ""],
  [/\b(?:residen\w*|country|pays|location|lieu|city|ville|where you live)\b/, (ctx) => typeof ctx.residence_country === "string" && ctx.residence_country.trim() !== ""],
];

function detectQuestions(s, ctx) {
  for (const re of QUESTIONS_RE) {
    const m = liveMatch(s, re);
    if (m) return m;
  }
  STATE_YOUR_RE.lastIndex = 0;
  for (const m of s.matchAll(STATE_YOUR_RE)) {
    const subject = m[1].trim();
    if (BASIC_SUBJECT_RE.test(subject)) continue;
    if (EMPLOYER_SUBJECT_END_RE.test(s.slice(Math.max(0, m.index - 45), m.index))) continue; // "we will provide your uniform"
    const known = ANSWERABLE.find(([re]) => re.test(subject));
    if (known && known[1](ctx)) continue;
    return m[0];
  }
  return null;
}

function firstLive(s, list) {
  for (const re of list) {
    const m = liveMatch(s, re);
    if (m) return m;
  }
  return null;
}

const FLAG_KEYS = {
  requires_captcha: "captcha",
  requires_payment: "payment",
  requires_legal_declaration: "legal_declaration",
  requires_login: "login",
  requires_online_only: "unsupported_channel",
  requires_custom_questions: "custom_questions",
};

/**
 * @param {{description_text?: string, title?: string, flags?: object}} job
 * @param {{salary_min?: any, availability?: string, residence_country?: string}} [ctx] confirmed
 *   preferences: a "please state your salary/availability/country" request is not flagged when held
 * @returns {{reason: 'captcha'|'payment'|'legal_declaration'|'login'|'unsupported_channel'|'custom_questions', source: string}|null}
 */
function detectHandoff(job, ctx = {}) {
  const flags = job && job.flags && typeof job.flags === "object" ? job.flags : null;
  if (flags) {
    for (const [k, reason] of Object.entries(FLAG_KEYS)) if (flags[k] === true) return { reason, source: `flag:${k}` };
  }
  const text = normalizeAdText(`${(job && job.title) || ""}\n${(job && job.description_text) || ""}`);
  const ss = sentences(text);
  const order = [
    ["captcha", (s) => firstLive(s, [CAPTCHA_RE])],
    ["payment", detectPayment],
    ["legal_declaration", (s) => firstLive(s, LEGAL_RE)],
    ["login", (s) => firstLive(s, LOGIN_RE)],
    ["unsupported_channel", (s) => firstLive(s, ONLINE_ONLY_RE)],
    ["custom_questions", (s) => detectQuestions(s, ctx || {})],
  ];
  for (const [reason, fn] of order) {
    for (const s of ss) {
      const hit = fn(s);
      if (hit) return { reason, source: `text:"${String(hit).slice(0, 60)}"` };
    }
  }
  return null;
}

module.exports = { detectHandoff, normalizeAdText, sentences };
