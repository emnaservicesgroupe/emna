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

// ======================================================================================
// Allowlist design. `stated_in_ad` needs an AFFIRMATIVE allowlisted phrase and no veto; bare
// mentions ("LMIA", "Visa sponsorship?") are `unknown`. A false stated_in_ad / accepted:true is
// far worse than a false unknown/null/unavailable, so every doubt resolves away from "yes".
// ======================================================================================
const MAX_AD = 500000;

// ---- canonical text (linear) ----
const INVISIBLE = /[\u00ad\u2060\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u180e\u061c]/g;
const EXOTIC_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u0009\u000b\u000c]/g;
const LINE_SEP = /[\r\u0085\u2028\u2029]/g;
const CONFUSABLE = { "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x", "\u0443": "y", "\u043a": "k", "\u043d": "h", "\u0442": "t", "\u043c": "m", "\u0456": "i", "\u0455": "s", "\u03bf": "o", "\u03bd": "v", "\u2018": "'", "\u2019": "'", "\u00b4": "'", "`": "'" };

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
const OFFER_HEAD = /^(?:benefits?|what\s+we\s+offer|we\s+offer|perks?|avantages?|nous\s+offrons|we\s+provide|compensation(?:\s+and\s+benefits)?|package)\b(?:[^:\n]{0,30}:\s*|\s*$)/i;
const OTHER_HEAD = /^(?:about|responsibilit\w*|dut(?:y|ies)|description|summary|job\s+summary|your\s+role|tasks?|how\s+to\s+apply|apply|taches|responsabilites)\b(?:[^:\n]{0,30}:\s*|\s*$)/i;
const JOIN_CAP = 500;
const CHUNK = 1500;

/** @returns {{f: string, q: string, req: boolean, offer: boolean}[]} sentences (folded text + original-case quote) */
function prepare(description) {
  let t = String(description === null || description === undefined ? "" : description);
  t = t.normalize("NFKC").replace(LINE_SEP, "\n").replace(INVISIBLE, "").replace(EXOTIC_SPACE, " ");
  t = sanitizeUntrusted(t, MAX_AD);
  t = t.replace(/~~[^~\n]{0,200}~~/g, " ").replace(/[*_`~#>]/g, " ").replace(/\|/g, " : ");
  const lines = [];
  let mode = "none";
  for (const raw of t.split("\n")) {
    let line = raw.replace(/^\s*(?:[-\u2022\u00b7\u2013\u2014]|\d{1,3}[.)])\s+/, "").replace(/[ \t]+/g, " ").trim();
    if (!line || /^[\s:\-\u2013\u2014]+$/.test(line)) continue;
    const f0 = foldAligned(line);
    let m;
    if ((m = REQ_HEAD.exec(f0))) { mode = "req"; line = line.slice(m[0].length).trim(); }
    else if ((m = OFFER_HEAD.exec(f0))) { mode = "offer"; line = line.slice(m[0].length).trim(); }
    else if ((m = OTHER_HEAD.exec(f0))) { mode = "none"; line = line.slice(m[0].length).trim(); }
    else if (/:$/.test(line) && line.split(" ").length <= 5 && !/\?$/.test(line)) mode = "none";
    if (!line) continue;
    lines.push({ line, mode });
  }
  const joined = [];
  let joinNext = false;
  for (const { line, mode: md } of lines) {
    const last = joined.length - 1;
    const short = line.length <= 60;
    if (last >= 0 && joined[last].text.length < JOIN_CAP && ((short && VALUE_LINE.test(line)) || joinNext || (joined[last].text.length < 40 && joined[last].text.split(" ").length <= 4 && NEG_START.test(line) && line.length <= 60))) {
      joined[last].text += ` ${line}`;
    } else joined.push({ text: line, mode: md });
    joinNext = /[:?]$/.test(line);
  }
  const out = [];
  for (const { text, mode: md } of joined) {
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
        if (q.length > 0 && fs.trim()) out.push({ f: fs, q: q.length > MAX_QUOTE ? `${q.slice(0, MAX_QUOTE - 1)}\u2026` : q, req: md === "req", offer: md === "offer" });
      }
    }
  }
  return out;
}

// ---- cue lists (all matched on accent-folded, lower-cased text) ----
const BENIGN = [
  /\bno\s+(?:(?:prior|previous|canadian|relevant|formal|work|specific|software|our)\s+)*(?:experience|degree|diploma|education|fees?|costs?|charges?|problems?|issues?|exceptions?|worr(?:y|ies)|training|resume|cv|weekends?|nights?|tips?|remote(?:\s+work)?|dull)\b(?:\s+(?:is\s+)?(?:needed|required|necessary))?/g,
  /\b(?:do|does|did)\s+not\s+require\s+(?:any\s+)?(?:(?:canadian|previous|prior|relevant|formal)\s+)*(?:experience|degree|diploma|education)\b/g,
  /\bdon'?t\s+(?:worry|just)\b/g,
  /\bnot\s+(?:only|just|merely)\b/g,
  /\bnot\s+an?\s+(?:remote|office|desk|part[- ]time|seasonal|entry|temporary)\b/g,
  /\bnever\s+a\s+dull\b/g,
  /\bnon[- ](?:profit|union\w*|smok\w*|remote|toxic|negotiable|stop|slip)\b/g,
  /\bwithout\s+(?:any\s+)?(?:experience|a\s+degree|fees|worry|stress)\b/g,
  /\bnot\s+required\s*:\s*(?:canadian\s+)?(?:experience|degree|diploma)/g,
];
const benign = (f) => BENIGN.reduce((acc, re) => acc.replace(re, " "), f);

const NEG_CUE = /\b(?:not|no|never|without|cannot|unable|unavailable|none|nor|non|nope|nein|zero|neither|exclu\w*|declin\w*|sans|aucune?|pas|jamais|false|unlikely|rarely|rarement|reject\w*|forbidden|interdit\w*)\b|n't\b|\bne\s+(?:\w+\s+){0,3}?pas\b|\bn'(?:\w+\s+){0,3}?(?:pas|aucune?|jamais|plus)\b|\bneed\s+not\b|\bout\s+of\s+(?:the\s+)?(?:question|scope)\b|\boff\s+the\s+table\b|\bbeyond\b|\u274c|\ud83d\udeab|\u2717|\u2718|\u00d7/;
const NEG_VALUE = /(?:^|[\s:\u2013\u2014\/(\[=>-])(?:\u274c|\ud83d\udeab|\u2717|\u2718|\u00d7|x|n|no|non|nope|nein|0|false|none|nil|n\/a|n\.a\.?|na|-)[\s).\]!]*$/;
const HEDGE = /\b(?:tbd|tba|to\s+be\s+(?:discussed|confirmed|determined|decided)|a\s+(?:confirmer|discuter)|negotiable|negociable|ask\s+(?:hr|us|the|about)|ask\b[^.]{0,15}\babout|case[- ]by[- ]case|cas\s+par\s+cas|discretion|subject\s+to|sous\s+reserve|upon\s+(?:request|approval|successful|completion)|selon|depending|depend|may|might|could|would|pourrait|pourraient|peut-etre|maybe|perhaps|if|once|when|lorsque|une\s+fois|quand|si|after\s+(?:probation|\d|the\s+first|your\s+first|first|completing|six|one\s+year|a\s+year|[a-z]+\s+months?)|apres|eligible\s+after|hoping|hope|planned|planning|expected|pending|awaited|await\w*|en\s+cours|applied\s+for|in\s+progress|future|next\s+year|later|eventually|possible|possibly|sometimes|limited|(?:was|were)\s+(?:approved|offered|issued|obtained|granted)|in\s+(?:19|20)\d\d|previously|formerly|previous|past|former|refused|denied|withdrawn|discontinued|expired|exempt|exempte|probation|exceptional|exceptionnel\w*|not\s+guaranteed|upon|until|unless|on\s+condition)\b/;
const SCOPE = /\b(?:other\s+(?:positions?|roles?|jobs?|locations?|offices?|postings?)|another\s+(?:role|position|company|location|office|job)|different\s+(?:role|position|company|location|job)|sister\s+company|parent\s+company|elsewhere|separate(?:ly)?|(?:current|existing)\s+(?:employees|staff)|internal\s+(?:candidates?|transfers?|only|hires?)|(?:senior|managerial|executive)\s+(?:roles?|positions?|staff|hires?)|(?:\w+\s+)?office\s+only|(?:us|u\.s\.|uk|european|american|dublin|london|new\s+york)\s+(?:offices?|roles?|positions?|postings?|based)|not\s+for\s+this|this\s+(?:one|role|position|job|posting)\s+(?:is\s+|does\s+)?(?:not|n't)|does\s+not\s+qualify|doesn't\s+qualify|only\s+for\s+(?:certain|some|selected|specific)|certain\s+(?:roles|positions|candidates)|some\s+(?:roles|positions))\b/;
const DUTIES = /\b(?:responsible\s+for|you\s+will\s+(?:prepare|process|handle|coordinate|file|manage|review|draft|advise)|process(?:ing)?\s+(?:\w+\s+)?(?:lmia|eimt|visa|applications?|requests?|files?)|clients?|customers?|for\s+employers|consult(?:ant|ing|ants)|paralegal|immigration\s+(?:consultant|advis[eo]r|firm|lawyer|specialist|officer)|job\s+duties|duties|coordinate|clientele)\b/;
const CAND_RESP = [
  /\b(?:candidates?|employees?|applicants?|your|candidat)'?s?\s+(?:own\s+)?(?:responsibility|expense|cost)\b/,
  /\bat\s+(?:your|the\s+(?:candidate|employee|applicant)'?s?)\s+(?:own\s+)?(?:expense|cost)\b/,
  /\b(?:candidate|employee|applicant|you)\s+(?:pays?|will\s+pay|must\s+pay|bear|bears)\b/,
  /\bfor\s+a\s+fee\b|\bfor\s+sale\b|\bat\s+your\s+cost\b|\bfees?\s+(?:of|apply|apply)\b|\bcharge[sd]?\b/,
  /\b(?:requires?|requiring|required|need|needs|needed)\b(?:\s+\w+){0,3}?\s+(?:(?:an?|their|your|own|the)\s+)*(?:lmia|eimt|work\s+permit|visa|sponsorship)\b/,
  /\b(?:lmia|eimt|work\s+permit|visa|sponsorship)\s+(?:is\s+|are\s+)?(?:required|needed|requis|requise)\b/,
  /\b(?:candidates?|applicants?|you|they)\s+(?:must|need\s+to|have\s+to|will\s+need\s+to|should)\s+(?:\w+\s+){0,3}?(?:obtain|apply|get|bring|provide|hold|have|possess|secure|arrange)\b[^,]{0,40}\b(?:lmia|eimt|work\s+permit|visa|sponsorship)\b/,
  /\bapply\s+for\s+(?:an?\s+)?lmia\s+yourself\b/,
  /\b(?:your|their)\s+own\s+(?:lmia|eimt|work\s+permit|visa|permit)\b|\bown\s+(?:lmia|eimt|work\s+permit|visa)\b/,
  /\barrange\s+their\s+own\b/,
];

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
const REQ_SECTION_RESTRICT = /\b(?:permit|visa|authori[sz]ation|status|citizen\w*|permanent|\bpr\b|\brp\b|clearance|autorisation|permis|resident\w*)\b/;
const NEGATIVE = [
  /\bno\s+(?:\w+\s+){0,3}?(?:sponsor\w*|visa|lmia|eimt|work\s+permit|immigration)/,
  /\b(?:aucune?|pas\s+de|sans)\s+(?:\w+\s+){0,2}?(?:parrainage|soutien|eimt|lmia|permis|visa)/,
  /\b(?:without|sans)\s+(?:an?\s+)?(?:lmia|eimt|visa|sponsor\w*)/,
];

// ---- affirmative allowlist (each is a complete statement that the employer provides support) ----
const SUPPORT_NOUN = "(?:visas?|work\\s+permits?|lmia|eimt|immigration|sponsorship|permis\\s+de\\s+travail|soutien\\s+a\\s+l'immigration|parrainage|travailleurs?\\s+etrangers?)";
const AFFIRM = [
  new RegExp(`\\b(?:we|we'll|company|our\\s+company|employer|the\\s+employer|nous|l'employeur|employeur|entreprise)\\b(?:\\s+(?:will|can|are\\s+able\\s+to|is\\s+able\\s+to|do|does|also|gladly|happily))*\\s*(?:offer|offers|provide|provides|sponsor|sponsors|support|supports|assist|assists|help|helps|handle|handles|cover|covers|arrange|arranges|apply\\s+for|applies\\s+for|will\\s+apply\\s+for|offrons|offre|fournissons|fournit|assurons|assure|parrainons|parraine|fera|ferons|prenons\\s+en\\s+charge|prend\\s+en\\s+charge)\\b[^.;,]{0,40}?\\b${SUPPORT_NOUN}\\b`),
  /\b(?:visa|work\s+permit|work\s+visa|immigration)\s+sponsorship\s+(?:is\s+|are\s+|will\s+be\s+|can\s+be\s+)?(?:available|offered|provided|included|supported)\b/,
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
  /\b(?:we|company|employer|the\s+employer)\s+(?:have|has|hold|holds|got|obtained)\s+(?:an?\s+|the\s+)?(?:approved\s+|positive\s+)?(?:lmia|eimt)\b/,
];
const AFFIRM_VALUE = /\b(?:visa\s+sponsorship|lmia|eimt|work\s+permit(?:\s+sponsorship)?|immigration\s+support|sponsorship|parrainage)\s*[:=-]?\s*(?:yes|oui|y|true|included|available|offered|provided|\u2713|\u2714)\s*[).!]*$/;
const BARE_ITEM = /\b(?:visa\s+sponsorship|work\s+permit\s+sponsorship|lmia(?:\s+approved)?|eimt|immigration\s+(?:support|assistance|sponsorship)|sponsorship|parrainage(?:\s+de\s+visa)?|soutien\s+a\s+l'immigration)\b/;
const STRONG_WORD = /\b(?:sponsor\w*|parrain\w*|visas?|lmia|eimt|immigration|parrainage|work\s+permits?|permis\s+de\s+travail)\b/;
const RELATED = /\b(?:visas?|permits?|immigration|lmia|eimt|work\s+authori[sz]ation|travail)\b/;
const UNRELATED = /\b(?:event|events|festival|festivals|team|teams|sports?|charity|charities|marathon|concert|evenements?|equipes?|caritatif)\b/;
const SEGMENT_SPLIT = /\s*(?:[,;\u2013\u2014]|\s-\s|\bbut\b|\band\b|\bet\b|\bmais\b)\s*/;

// "Label - not available" / "label, no": a dash or comma followed only by a negative value is a label/value pair, not a clause break.
const LABEL_VALUE_DASH = /\s*(?:[\u2013\u2014]|\s-\s)\s*(?=(?:not|no|non|n\/a|none|unavailable|nope|unfortunately)\b)/g;
const LABEL_VALUE_COMMA = /\s*,\s*(?=(?:not|no|never|cannot|without|pas|non|nope|excluded|n\/a|none|unavailable|unfortunately|sadly|jamais|\w+n't)(?:\b|(?=\W))(?:\W+\w+){0,3}\W*$)/;
function segmentsOf(f) {
  return f.replace(LABEL_VALUE_DASH, " : ").replace(LABEL_VALUE_COMMA, " : ").split(SEGMENT_SPLIT).filter((x) => x.trim());
}

/** Ad-text classification: allowlist for stated_in_ad, restrictions/denials for unavailable. */
function detectFromAd(description) {
  const list = prepare(description);
  // 1. whole-ad restrictions
  for (const c of list) {
    if (RESTRICT.some((re) => re.test(c.f))) return { label: "unavailable", evidence: c.q };
    if (c.req && REQ_SECTION_RESTRICT.test(c.f) && !NEG_CUE.test(benign(c.f))) return { label: "unavailable", evidence: c.q };
  }
  let stated = null;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    const f = benign(c.f);
    const segs = segmentsOf(f);
    let sentenceHasSupportWord = false;
    // 2. denials: a sponsorship word and a negation/candidate-responsibility in the same segment
    for (const seg of segs) {
      if (UNRELATED.test(seg) && !RELATED.test(seg)) continue;
      const strong = STRONG_WORD.test(seg);
      if (strong) sentenceHasSupportWord = true;
      if (NEGATIVE.some((re) => re.test(seg))) return { label: "unavailable", evidence: c.q };
      if (!strong) continue;
      if (NEGATIVE.some((re) => re.test(seg)) || NEG_CUE.test(seg) || NEG_VALUE.test(seg) || CAND_RESP.some((re) => re.test(seg))) return { label: "unavailable", evidence: c.q };
    }
    if (NEG_VALUE.test(f) && STRONG_WORD.test(f)) return { label: "unavailable", evidence: c.q };
    if (!sentenceHasSupportWord || stated) continue;
    // 3. affirmative statement + sentence-level vetoes
    const near = `${list[i - 1] ? list[i - 1].f : ""} ${f} ${list[i + 1] ? list[i + 1].f : ""}`;
    const veto = HEDGE.test(f) || SCOPE.test(near) || DUTIES.test(f) || CAND_RESP.some((re) => re.test(f)) || (c.req && true);
    if (veto) continue;
    const segHit = segs.some((seg) => AFFIRM.some((re) => re.test(seg)));
    const valueHit = AFFIRM_VALUE.test(f);
    const itemHit = c.offer && !NEG_CUE.test(f) && segs.some((seg) => BARE_ITEM.test(seg));
    if (segHit || valueHit || itemHit) stated = { label: "stated_in_ad", evidence: c.q };
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

// ---- overseas acceptance: true only on an allowlisted positive with no exclusion/restriction/hedge anywhere ----
const PEOPLE = /\b(?:applicants?|candidates?|candidat(?:e)?s?|workers?|hires?|employees?|travailleurs?|recruits?|students?)\b/;
const OVERSEAS_SUBJECT = /\b(?:abroad|overseas|outside\s+(?:of\s+)?(?:canada|the\s+country)|out\s+of\s+(?:canada|country)|international|foreign|etranger\w*|internationaux|hors\s+(?:du\s+)?canada)\b/;
const OVERSEAS_WORD = /\b(?:abroad|overseas|international|foreign|worldwide|global|anywhere|etranger\w*|internationaux|outside\s+(?:of\s+)?canada|from\s+outside)\b/;
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
  /\b(?:local|domestic|internal)\s+(?:candidates?|applicants?|hires?|transfers?)\b|\bdomestic\s+hires?\b|\blocal\s+(?:only|talent)\b/,
  /\b(?:canadian\s+)?residents?\s+(?:of\s+\w+\s+)?(?:only|seulement|uniquement)\b|\bresidents?\s+canadiens?\b|\bresidents?\s+du\s+canada\b|\bcandidats?\s+locaux\b|\bbased\s+only\b|-based\s+only\b/,
  /\bmoves?\s+within\b|\bwithin\s+(?:the\s+)?(?:province|country|canada)\b|\bwe\s+do\s+not\s+fly\b|\bwe\s+don'?t\s+fly\b/,
];
// Conditions that make overseas acceptance uncertain (never true), without excluding anyone outright.
const OV_BLOCK = /\bonce\s+(?:they\s+)?(?:have\s+)?landed\b|\bafter\s+(?:obtaining|getting)\s+(?:pr|permanent)\b|\bafter\s+(?:\d+|six|one|two|a)\s+(?:months?|years?)\b/;
const PREFERENCE = /\b(?:prefer\w*|priority|preference|priorite|privilegi\w*)\b/;
const OVERSEAS_HEDGE = /\b(?:tbd|tba|to\s+be\s+(?:discussed|confirmed)|subject\s+to|sous\s+reserve|upon|depending|selon|might|could|pourrait|maybe|perhaps|if|only\s+if|unless|pending|eventually|later|future|limited|case[- ]by[- ]case|discretion|may\s+be|once|after|apres|probation)\b/;
const OV_YES = [
  /\b(?:open\s+to|welcomes?|we\s+welcome|we\s+accept|accepting|we\s+hire|hiring|considering|we\s+consider|encourag\w+)\b[^.;,]{0,30}?\b(?:international|overseas|foreign|global|worldwide|abroad|outside\s+(?:of\s+)?canada|etrangers?|internationaux)\b/,
  /\b(?:international|overseas|foreign|global|worldwide)\s+(?:applicants?|candidates?|students|hires?|workers?)\s+(?:are\s+)?(?:welcome|encouraged|accepted|considered|invited)\b/,
  /\b(?:applicants?|candidates?)\s+(?:from\s+)?(?:abroad|overseas|outside\s+(?:of\s+)?canada)\b(?:\s+(?:are\s+)?(?:welcome|accepted|encouraged|invited|encouraged\s+to\s+apply)|\s+(?:may|can)\s+apply)\b/,
  /\bouvert\s+aux\s+candidat(?:e)?s?\s+(?:internationaux|etrangers|de\s+l'etranger)\b/,
  /\bcandidat(?:e)?s?\s+(?:internationaux|etrangers)\s+(?:bienvenus|acceptes|encourages)\b/,
];
const RELOCATION_YES = /\b(?:relocation|relocalisation|demenagement)\s+(?:(?:assistance|support|package)\s+)?(?:is\s+|are\s+)?(?:provided|offered|available|included|fournie?|offerte?|prise\s+en\s+charge)\b|\b(?:provide|offer)s?\s+relocation\b/;

/** accepted: true | false | null. Exclusions anywhere -> false; restrictions/hedges/place-bound text -> never true. */
function detectOverseas(description) {
  const list = prepare(description);
  let blocked = null;
  let restricted = false;
  for (const c of list) {
    if (RESTRICT.some((re) => re.test(c.f)) || (c.req && REQ_SECTION_RESTRICT.test(c.f))) restricted = true;
  }
  for (const c of list) {
    const f = benign(c.f);
    const relocation = /\brelocat\w*|\bdemenag\w*/.test(f);
    const subj = OVERSEAS_SUBJECT.test(f) && PEOPLE.test(f);
    if (subj && !relocation && (NEG_CUE.test(f) || NEG_VALUE.test(f))) return { accepted: false, evidence: c.q };
    const hit = PLACE_BOUND.map((re) => re.exec(f)).find(Boolean);
    if (hit && !/\b(?:eligib|authori|entitled|permitted|able|allowed|legally)\w*/.test(hit[0])) return { accepted: false, evidence: c.q };
    if (PREFERENCE.test(f) && /\b(?:canadian|local|resident|residents|canada)\b/.test(f)) blocked = "preference";
    if (OV_BLOCK.test(f) && (subj || OVERSEAS_WORD.test(f))) blocked = "condition";
  }
  if (restricted) blocked = blocked || "work-authorization restriction";
  const nearOf = (i) => `${list[i - 1] ? list[i - 1].f : ""} ${list[i].f} ${list[i + 1] ? list[i + 1].f : ""}`;
  for (let i = 0; i < list.length; i += 1) {
    const f = benign(list[i].f);
    if (NEG_CUE.test(f) || NEG_VALUE.test(f) || OVERSEAS_HEDGE.test(f) || WEAK_NO_OVERSEAS.test(f)) continue;
    const yes = OV_YES.some((re) => re.test(f)) || (RELOCATION_YES.test(f) && OVERSEAS_WORD.test(nearOf(i)));
    if (!yes) continue;
    if (blocked) return { accepted: null, evidence: null, blocked };
    return { accepted: true, evidence: list[i].q };
  }
  return { accepted: null, evidence: null, ...(blocked ? { blocked } : {}) };
}
const WEAK_NO_OVERSEAS = /\b(?:previous|previously|formerly|expired|refused|denied)\b/;

const clauses = prepare;
module.exports = { detectEmployerSupport, detectOverseas, sentences, clauses, normalizeAd: prepare, fold };
