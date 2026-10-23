// Conservative detector for postings that need a human step before (or instead of) an email
// application: captcha, payment, legal declaration, login/account, online-only channel, custom
// questions. Biased toward FALSE POSITIVES: a wrongly flagged job only becomes a staff task, a missed
// one could make the system pay, sign or answer for a candidate. Job text is untrusted data; it is
// only pattern-matched, never interpreted.
//
// Matching runs on normalised text: NFKC, lower-case, curly -> straight apostrophes, accents
// stripped, apostrophes (FR elisions d'/l'/n'/j'/qu') and hyphens -> spaces, spaces collapsed, then
// split into sentences. Patterns below are written against that form (no accents, no apostrophes).

// Ads up to HEAD+TAIL chars are scanned whole. Longer ads: head + tail + every keyword window of the
// middle (payment / captcha / declaration cues), at most MAX_WINDOWS windows - linear time.
const HEAD = 20000;
const TAIL = 20000;
const WINDOW = 200;
const MAX_WINDOWS = 400;
const MIDDLE_CUE_RE = /pay|fee|frais|deposit|acompte|virement|transfer|western|moneygram|mandat|remit|regl|r\u00e8gl|purchase|buy|achet|achat|captcha|robot|human|humain|puzzle|sign|declar|d\u00e9clar|certif|attest|sworn|affidavit|honneur|online|en ligne|portal|portail|website|platform|plateforme|form|accept|apply|postul|candidat|log ?in|log ?on|account|compte|connect|regist|inscri|question|quiz|answer|r\u00e9pond|explain|expliqu|[$\u20ac\u00a3]/gi;

/** The parts of the raw ad that are scanned, joined by newlines (never splitting a window mid-sentence matters little: windows are generous). */
function scannedParts(raw) {
  const t = String(raw || "");
  if (t.length <= HEAD + TAIL) return t;
  const middle = t.slice(HEAD, t.length - TAIL);
  const parts = [t.slice(0, HEAD)];
  let lastEnd = -1;
  let n = 0;
  MIDDLE_CUE_RE.lastIndex = 0;
  for (const m of middle.matchAll(MIDDLE_CUE_RE)) {
    if (m.index < lastEnd) continue; // inside the previous window
    const start = Math.max(0, m.index - WINDOW);
    const end = Math.min(middle.length, m.index + WINDOW);
    parts.push(middle.slice(Math.max(start, lastEnd), end));
    lastEnd = end;
    if (++n >= MAX_WINDOWS) break;
  }
  parts.push(t.slice(t.length - TAIL));
  return parts.join("\n");
}

function normalizeAdText(raw) {
  return String(raw || "")
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
const AMOUNT_RE = new RegExp(`(?:[$€£¥]\\s?\\d[\\d.,]{0,15})|(?:\\d[\\d.,]{0,15}\\s?(?:[$€£¥]|${CUR}\\b|k\\b))|(?:\\b${CUR}\\s?\\d)`, "g");
// Words that make an amount a cost to the candidate (not a wage).
const STRONG_COST_RE = /\b(?:send|sending|envoy\w*|regl\w*|fees?|frais|deposits?|acomptes?|processing|transfers?|transferer|virements?|western union|moneygram|money ?gram|money order|mandats?|wire|remit\w*|upfront|up front|advance|a l avance|avance|caution|purchase|purchases|buy|buys|acheter|achetez|achat)\b/g;
const GENERIC_COST_RE = /\b(?:payments?|paiements?|costs?|couts?|charges?|tarifs?|prix|price)\b/g;
const WAGE_CUE_RE = /\b(?:per (?:hour|hr|day|week|month|year|annum)|an hour|hourly|\/ ?(?:h|hr|hour|heure|mois|month|year|an)\b|par (?:heure|jour|semaine|mois|an)|de l heure|weekly|monthly|annual\w*|salary|salaire|wages?|remuneration|gross|net|brut|bonus|prime|overtime)\b/;
// Negation / "the employer pays" immediately before a hit (same sentence) cancels that hit.
const NEGATION_BEFORE_RE = /\b(?:no|not|never|without|zero|aucun\w*|jamais|pas de|pas d|sans|ni|free of|nothing|(?:won|don|doesn|didn|shouldn|wouldn|aren|isn|can|haven|hasn|mustn|needn) t)\b(?! later| only| just)[^]*$/;
const EMPLOYER_PAYS_BEFORE_RE = /\b(?:we|employer|the employer|the company|company|nous|l employeur|employeur|la societe|l entreprise)\s+(?:will\s+|also\s+|fully\s+|shall\s+|)(?:pay|pays|paid|cover|covers|covering|reimburse\w*|paie|paient|payons|prend|prennent|prenons|rembourse\w*|offre|offrons|offers?)\b[^]*$/;
const EMPLOYER_PAYS_AFTER_RE = /^\s*(?:\w+\s+)?(?:are |is |will be |)?(?:reimbursed|refunded by|rembourse\w*|covered|pris\w* en charge)\b|^[^]{0,40}?\b(?:(?:paid|covered|borne|provided|offered|reimbursed|refunded|repaid) by (?:the )?(?:employer|company|us|our company)|pris(?:es)? en charge|a la charge de l employeur|aux frais de l employeur|employer paid|company paid|offert\w*|gratuit\w*|free of charge|at no cost|no cost)\b/;

// "we pay for ...", "the employer will provide your ...": the employer is the subject of the hit.
const EMPLOYER_SUBJECT_END_RE = /\b(?:we|employer|the employer|the company|company|nous|l employeur|employeur|they)\s+(?:will\s+|also\s+|fully\s+|shall\s+|can\s+|)$/;

// "candidates pay no fee", "payez rien": the object right after the hit is negated.
const NEGATION_AFTER_RE = /^\s*(?:no|nothing|zero|nil|aucun\w*|rien|pas de|pas d)\b/;

function cancelled(sentence, start, end) {
  const before = sentence.slice(Math.max(0, start - 45), start);
  const after = sentence.slice(end, end + 45);
  return NEGATION_BEFORE_RE.test(before) || EMPLOYER_PAYS_BEFORE_RE.test(before) || EMPLOYER_SUBJECT_END_RE.test(before) || EMPLOYER_PAYS_AFTER_RE.test(after) || NEGATION_AFTER_RE.test(after);
}

// "candidates do not pay", "applicants should never pay", "vous n avez rien a payer", "you won t pay": the
// negation sits inside the subject..verb span itself.
const NEGATION_INSIDE_RE = /\b(?:not|never|no|nothing|neither|nor|won t|don t|doesn t|didn t|shouldn t|wouldn t|aren t|isn t|t need|rien|pas|jamais|aucun\w*|ni|ne)\b|n t\b/;
// purchasing from the employer / a stated price
const PAYER_SPAN_RE = /^(?:you|candidates?|applicants?|workers?|the candidate|the applicant|vous|le candidat|la candidate|les candidats|candidat\w*|postulant\w*)\s+((?:\w+\s+){0,4}?)\w+$/;

/** First non-cancelled match of `re` (global) in `s`, or null. */
function liveMatch(s, re) {
  re.lastIndex = 0;
  for (const m of s.matchAll(re)) {
    if (cancelled(s, m.index, m.index + m[0].length)) continue;
    const span = PAYER_SPAN_RE.exec(m[0]);
    if (span && NEGATION_INSIDE_RE.test(span[1])) continue;
    return m[0];
  }
  return null;
}

// ---------------------------------------------------------------- categories

const CAPTCHA_RE = /\b(?:re|h)?captcha\b|\bprove (?:that )?you(?: re| are) (?:a )?human\b|\bverify (?:that )?you(?: re| are) (?:a )?human\b|\bi(?: m| am) not a robot\b|\bje ne suis pas un robot\b|\bprouvez que vous etes (?:un )?humain\b|\bhuman verification\b|\bverification humaine\b|\bnot a robot\b|\bpas (?:un )?robot\b|\bprove (?:that )?you(?: re| are) human\b|\b(?:verify|prove|show|confirm|demonstrate) (?:that )?you(?: re| are) (?:a )?real (?:person|human)\b|\b(?:show|confirm|demonstrate) (?:that )?you(?: re| are) (?:a )?human\b|\b(?:solve|complete|pass) (?:a |the |this |our )?(?:short |quick |simple )?(?:puzzle|challenge|test)\b[^]{0,40}?\b(?:human|robot|bot|real person)\b|\bnot a bot\b|\banti ?(?:robot|bot|spam verification)\b|\bverification anti\b|\bbot (?:check|verification)\b/g;

const PAYMENT_PHRASES = [
  // candidate is the payer
  /\b(?:you|candidates?|applicants?|workers?|the candidate|the applicant|vous|le candidat|la candidate|les candidats|candidat\w*|postulant\w*)\s+(?:\w+\s+){0,4}?(?:pay|pays|paying|payer|payez|paie|paient|transfer|wire|send money|remit|virer|verser|versez|regler|reglez|deposit)\b/g,
  // imperative at sentence start ("Pay $200 ...", "Payer 200 € ...") - not "Pay: $20/h", "Pay range"
  /^(?:please\s+|merci de\s+|veuillez\s+)?(?:pay|payer|payez|reglez|regler|versez|verser|transfer|transferez|wire)\s+(?=[$€£\d]|a |an |the |your |le |la |les |des |un |une |votre |vos |fee|frais|deposit|acompte)/g,
  /\bpay(?:ing)?\s+(?:for|to)\s+(?:your|their|his|her|the|a|an|own|all|its)\b/g,
  /\bsend (?:us |me |him |her |them |)(?:[$€£]\s?\d|\d)[^]{0,30}?\b(?:for|to)\b/g,
  /\breglement (?:de |d |des |du )?[^]{0,30}?(?:exige\w*|requis\w*|obligatoire\w*|demande\w*|[$€£]|euros?|dinars?|dt\b|eur\b)/g,
  /\bpay(?:ment of|ing)?\s+(?:an?\s+|the\s+|any\s+|your\s+)?(?:(?!no\b|not\b|zero\b|nothing\b|any\b)\w+\s+)?(?:fee|fees|deposit|charge|sum|amount)\b/g,
  /\b(?:application|processing|registration|placement|recruitment|recruiting|agency|service|visa|training|file|handling|administrative|admin|medical|booking|reservation|enrolment|enrollment|consultancy|consulting|job|work permit|permit|ticket|insurance)\s+(?:fees?|costs?|charges?)\b/g,
  /\bfrais\s+(?:d |de |du |des )?(?:inscription|dossier|traitement|visa|placement|recrutement|service|candidature|reservation|formation|agence|gestion|medical|medicaux|examen|billet|assurance|permis|contrat)\w*/g,
  /\bpayer\s+(?:les|des|le|la|vos|votre)\s+(?:\w+\s+)?(?:frais|couts?|visa|billet|examen|formation|caution|acompte)\b/g,
  /\b(?:fees?|deposit|frais|acompte|caution)\s+(?:of\s+\S+\s+)?(?:is\s+|are\s+|sont\s+|est\s+)?(?:required|payable|due|apply|applies|charged|demande\w*|exige\w*|requis\w*|a payer|obligatoire\w*)\b/g,
  /\b(?:in advance|upfront|up front|a l avance|d avance)\b/g,
  /\bto secure your (?:place|placement|position|job|spot|seat|post|contract|visa|offer)\b|\bpour (?:reserver|securiser|garantir|bloquer) (?:votre|ta) (?:place|poste|contrat|visa|emploi)\b|\breservation de votre (?:poste|place)\b/g,
  /\bwestern union\b|\bmoney ?gram\b|\bmoney order\b|\bmandat (?:cash|postal|minute)\b/g,
  // buying something FROM the employer/agency ("purchase your own starter kit from us for $199")
  /\b(?:purchase|purchases|purchasing|buy|buys|buying|acheter|achetez|achete\w*|achat)\b[^]{0,60}?\b(?:from us|from the (?:company|employer|agency|recruiter)|from our (?:company|store|shop|agency|office)|aupres de (?:nous|l entreprise|l employeur|l agence|notre)|chez nous)\b/g,
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
        if (hi - lo <= 70 && !cancelled(s, lo, hi) && !cancelled(s, w.index, w.index + w[0].length)) return `${w[0]} ~ ${a[0]}`;
      }
    }
  }
  return null;
}

const LEGAL_RE = [
  // the APPLICANT signs (duty text such as "sign for deliveries", "sign off statements",
  // "signing contracts with clients", "sign-in sheet", "sign language" is excluded)
  /\b(?:you|applicants?|candidates?|the applicant|the candidate|all applicants|vous|le candidat|les candidats|candidat\w*|postulant\w*)\s+(?:\w+\s+){0,3}?(?:sign|signer|signez)\b(?!\s+(?:for|off|in|up|on|language|contracts? with|documents? on behalf|on behalf|(?:an?|the|your|their|his|her|un|une|le|leur|son|votre)\s+(?:(?:written|formal|standard|individual|permanent|fixed term)\s+)?(?:(?:employment|work|job|labou?r)\s+(?:agreement|contract)|offer letter|letter of offer|contract of employment|contrat de travail|contrat d embauche|lettre d offre)))/g,
  /\bplease sign\b|\bsign and (?:return|send|attach|submit|enclose)\b|\band sign (?:it|them|the|this|before|and)\b|\b(?:fill in|fill out|complete|remplissez|completez|remplir)\b[^]{0,40}?\b(?:and sign|et signe\w*)\b/g,
  /\b(?:declarations?|forms?|formulaires?|attestations?|statements?|consent)\b[^]{0,50}?\bsign it\b/g,
  /^(?:please\s+|kindly\s+)?sign (?:the |this |a |an |our |your )?(?:attached |enclosed |following |below |required )?(?:declarations?|forms?|oaths?|attestations?|affidavits?|consent|statements?|waivers?|undertakings?)\b|\bsign (?:the |this |a |an |our )(?:attached |enclosed |following |required )?(?:declarations?|oaths?|oath form|attestations?|affidavits?|consent forms?|declaration forms?|waivers?|undertakings?)\b/g,
  /\bsigned\s+(?:\w+\s+){0,2}?(?:declarations?|forms?|statements?|affidavits?|oaths?|attestations?|consent)\b[^]{0,30}?\b(?:required|attached|enclosed|submitted|returned|must|needed|obligatoire)\b/g,
  /\b(?:signez|signer|veuillez signer|merci de signer)\b[^]{0,30}?\b(?:declaration|attestation|formulaire d engagement|formulaire de consentement|formulaire|engagement|serment|consentement)\b/g,
  /\b(?:declarations?|attestations?|affidavits?|serments?)\s+(?:\w+\s+){0,3}?(?:signed|signee?s?|a signer|to be signed|must be signed)\b/g,
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
  /\b(?:vous |te |se )?connecter (?:a|sur) (?:votre|ton|un|notre|son|leur) (?:\w+ ){0,2}?(?:compte|espace|portail|profil|plateforme)\b|\b(?:espace|compte) (?:candidat|candidats|personnel|recrutement)\b/g,
];
const ONLINE_ONLY_RE = [
  /\bapply (?:via|through|on|at|using|from) (?:our|the) (?:\w+ ){0,2}?(?:portal|website|platform|site|page|system|ats|link|app|form)\b/g,
  /\bapply (?:only )?online\b|\bonline application\b|\bapplication form online\b|\bapply on line\b/g,
  /\bcomplete (?:the |our |an )?(?:online )?application form\b|\bfill (?:in|out) (?:the |our |an )?(?:online |attached )?(?:application )?form\b/g,
  /\b(?:postulez|postuler|candidatez|candidater) (?:uniquement |seulement )?(?:en ligne|via (?:notre|le) (?:site|portail|plateforme|formulaire))\b|\bcandidature en ligne\b/g,
  /\b(?:remplissez|remplir|completez|completer) (?:le |notre )?formulaire\b|\bformulaire (?:de candidature )?en ligne\b/g,
  /\b(?:email|e mail|emailed|mailed) applications? (?:are |will )?(?:not|no longer) (?:be )?accepted\b|\bno (?:email|e mail) applications\b|\bdo not (?:send|email|e mail|mail) (?:us )?(?:your )?(?:cvs?|resumes?|applications?|documents)\b|\bapplications? (?:are |will be )?(?:only |exclusively )?accepted (?:only |exclusively )?(?:online|via|through)\b/g,
  /\b(?:do not|don t|does not|will not|cannot|can not)\s+(?:\w+\s+)?accept\w*\s+(?:\w+\s+)?applications? (?:by|via|through|per) (?:e ?mail|courriel)\b|\bapplications? (?:sent |submitted )?(?:by|via) e ?mail (?:are |will )?(?:not|no longer) (?:be )?(?:accepted|considered|reviewed)\b|\b(?:email|e mail) applications? (?:are |will )?(?:not|no longer) (?:be )?(?:considered|reviewed)\b/g,
  /\b(?:through|via|on|using|from) (?:our|the) (?:\w+ ){0,2}?(?:website|site|portal|platform|form|page) only\b|\bexclusively (?:through|via|on) (?:our|the)\b|\b(?:uniquement|seulement|exclusivement) (?:via|par|sur|a travers|depuis) (?:notre |le |la |nos )?(?:\w+ )?(?:site|plateforme|portail|formulaire)\b/g,
  /\bn accept\w* pas (?:les |de )?candidatures? (?:par|via) (?:courriel|e mail|email|mail)\b/g,
  /\b(?:only|exclusively|solely)\s+accept\w*\s+(?:\w+\s+)?applications?\s+(?:through|via|on|using|from|at)\s+(?:our|the)\b|\baccept\w*\s+(?:\w+\s+)?applications?\s+(?:only|exclusively|solely)\s+(?:through|via|on|using|from|at)\b|\bapplications?\s+(?:are\s+|will be\s+)?accepted\s+(?:only|exclusively|solely)\s+(?:through|via|on|using|from|at)\b/g,
  /\b(?:acceptons|accepte|acceptent)\s+(?:uniquement|seulement|exclusivement)\s+(?:les\s+)?candidatures?\s+(?:via|par|sur|depuis|a travers)\b|\bcandidatures?\s+(?:acceptees?|recues?)\s+(?:uniquement|seulement|exclusivement)\s+(?:via|par|sur|depuis)\b/g,
  /\bcandidatures? (?:envoyees? )?par (?:courriel|e mail|email|mail|courrier electronique) ne (?:sont|seront) pas (?:acceptees?|traitees?|considerees?)\b|\bn envoyez pas (?:votre |vos )?(?:cv|candidature)/g,
];
const QUESTIONS_RE = [
  /\banswers? (?:to )?(?:the )?following\b|\binclude (?:your )?answers? to\b|\banswer (?:these|our|all|the|each|a few|some) (?:\w+ )?(?:questions?|queries)\b/g,
  /\bscreening questions?\b|\bquestionnaire\b|\bquiz\b|\bassessment questions?\b|\bknock ?out questions?\b/g,
  /\brepond(?:ez|re|ant) (?:aux?|a la|a ces|a nos) (?:\w+ )?(?:questions?|questionnaire)\b|\bquestions suivantes\b/g,
  /\b(?:respond|reply|answer)\w*\s+(?:to\s+)?(?:the\s+|these\s+|our\s+|all\s+)?questions? (?:below|listed|above|attached|that follow)\b|\bquestions ci (?:dessous|apres|jointes?)\b/g,
  /\bplease explain (?:why|how|what)\b|\bexpliquez (?:pourquoi|comment)\b|\bdescribe (?:a time|how you|why you)\b|\btell us (?:about a time|why|how)\b/g,
];
// "please state your X" / "veuillez indiquer vos X": custom answer unless the profile/preferences hold it.
const STATE_YOUR_RE = /\b(?:state|specify|indicate|mention|tell us|let us know|provide|include|confirm|advise|list|indiquer|indiquez|indique|preciser|precisez|mentionner|mentionnez|communiquer|communiquez|donner|donnez)\s+(?:us\s+|nous\s+)?(?:your|their|his or her|vos|votre|ton|tes|leurs?)\s+([a-z ]{3,60})/g;
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
    // Every requested item must be basic or held by the confirmed preferences ("expected salary and notice period").
    const items = subject.split(/\s+(?:and|et|or|ou|as well as|plus)\s+|,/).map((x) => x.trim()).filter(Boolean);
    const allKnown = items.every((it) => BASIC_SUBJECT_RE.test(it) || ANSWERABLE.some(([re, ok]) => re.test(it) && ok(ctx)));
    if (allKnown) continue;
    return m[0];
  }
  return null;
}

// "Apply online or by email at jobs@..." offers email: not an online-only posting.
const EMAIL_OFFERED_RE = /@|\b(?:by|via|per|or) e ?mail\b|\bpar (?:e ?mail|courriel|mail)\b|\bou (?:par )?(?:e ?mail|courriel)\b/;
const EMAIL_REFUSED_RE = /\b(?:not|no longer|never)\b[^]{0,40}?\b(?:accept\w*|consider\w*|review\w*)\b|\bno (?:e ?mail|email) applications\b|\bdo not (?:send|email|e mail|mail)\b|\bne (?:sont|seront) pas\b|\bn accept\w* pas\b|\bn envoyez pas\b/;

/** First match without negation/employer cancellation (online-only phrasings carry their own negation: "we do not accept ..."). */
function firstPlain(s, list) {
  for (const re of list) {
    re.lastIndex = 0;
    const m = re.exec(s);
    if (m) return m[0];
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
  const text = normalizeAdText(`${(job && job.title) || ""}\n${scannedParts(job && job.description_text)}`);
  const ss = sentences(text);
  const order = [
    ["captcha", (s) => (CAPTCHA_RE.lastIndex = 0, (s.match(CAPTCHA_RE) || [null])[0])],
    ["payment", detectPayment],
    ["legal_declaration", (s) => firstLive(s, LEGAL_RE)],
    ["login", (s) => firstLive(s, LOGIN_RE)],
    ["unsupported_channel", (s) => (EMAIL_OFFERED_RE.test(s) && !EMAIL_REFUSED_RE.test(s) ? null : firstPlain(s, ONLINE_ONLY_RE))],
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

module.exports = { detectHandoff, normalizeAdText, sentences, scannedParts };
