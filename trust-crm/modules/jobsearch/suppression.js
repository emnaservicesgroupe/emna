// Do-not-contact list (stage 8 task 4): address normalisation, matching and the add / remove operations.
//
//   extractAddresses(input) -> string[]       every address in a header-like string, normalised, de-duplicated
//   normaliseAddress(input) -> {address, base, local, domain} | null    exactly ONE address, else null
//   domainChain('a.b.example') -> ['a.b.example', 'b.example']          the domain and its parents (never a bare TLD)
//   findSuppression(client, input) -> row | null   the first suppression covering ANY address in `input`
//   isSuppressed(client, input) -> boolean
//   addSuppression(client, {...}) / removeSuppression(client, {...})    audited; remove is administrator-only
//
// Matching rules (the pre-send guard relies on all of them):
//  - case-insensitive; display names, angle brackets, comments, groups and surrounding whitespace are ignored;
//  - plus-addressing: a suppression of a@b.com ALSO covers a+tag@b.com (the base address is always looked up);
//    a suppression of a+tag@b.com covers that exact tagged address only;
//  - a domain suppression covers the domain and every subdomain (sub.b.com matches b.com), never a sibling or a
//    look-alike suffix (b.com.evil.com, evil-b.com); a trailing dot is ignored; IDN domains are compared as punycode;
//  - a header with several addresses (group / list) is suppressed when ANY of them is;
//  - a value that holds no parseable address is not suppressed here (the guard refuses unparseable recipients itself).
// All scanning is linear (bounded character classes, no nested quantifiers); input is capped at 2000 characters.
const url = require("url");
const { HttpError } = require("./httpError");
const { isAdmin } = require("./scope");
const { auditJs } = require("../../utils/audit");

const KINDS = Object.freeze(["email", "domain"]);
const SOURCES = Object.freeze(["manual", "reply_opt_out", "bounce"]);
const MAX_INPUT = 2000;
const MAX_ADDRESSES = 50;
const MIN_REASON = 3;
const MAX_REASON = 500;
const DELIM = "\\s<>(),;:\"\\[\\]\\\\@";
// A token is delimited by whitespace / brackets / quotes / separators; '@' may appear exactly once inside it.
const TOKEN_RE = new RegExp(`(?<![^${DELIM}])[^${DELIM}]{1,64}@[^${DELIM}]{1,255}(?![^${DELIM}])`, "g");
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

// Public suffixes under which unrelated organisations register (a suppression of "co.uk" would silence every UK company). A small static
// list: it cannot know every registry (documented limit); the structural rule in isPublicSuffix() catches the usual second-level shapes.
const PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz", "govt.nz",
  "on.ca", "qc.ca", "bc.ca", "ab.ca", "mb.ca", "nb.ca", "nl.ca", "ns.ca", "nt.ca", "nu.ca", "pe.ca", "sk.ca", "yk.ca", "gc.ca", "gov.ca",
  "co.za", "org.za", "gov.za", "ac.za", "com.tn", "org.tn", "gov.tn", "net.tn", "edu.tn", "com.fr", "asso.fr", "gouv.fr", "co.in", "org.in", "gov.in", "ac.in", "com.br", "gov.br",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "com.cn", "org.cn", "gov.cn", "edu.cn", "co.kr", "or.kr", "com.sg", "com.hk", "com.mx", "com.ar", "com.co", "com.eg", "com.sa", "com.ng",
  "co.ke", "co.il", "co.id", "com.my", "com.ph", "com.pk", "com.tr", "com.ua", "com.ru", "com.pl", "com.dz", "com.ma", "co.ma", "gov.ma", "gov.dz",
]);
const GENERIC_SECOND_LEVEL = new Set(["com", "net", "org", "gov", "edu", "co", "ac"]);
/** True for a public suffix (co.uk, on.ca, com.tn ...): a static list plus the shapes <com|net|org|gov|edu|co|ac>.<tld> and <xx>.<xx> (two-letter code under a two-letter ccTLD). */
function isPublicSuffix(domain) {
  const d = String(domain || "").toLowerCase().replace(/\.+$/, "");
  if (PUBLIC_SUFFIXES.has(d)) return true;
  const labels = d.split(".");
  if (labels.length !== 2) return false;
  return GENERIC_SECOND_LEVEL.has(labels[0]) || (labels[0].length === 2 && labels[1].length === 2);
}

const db = () => require("../../db");
const guard = () => require("./guard");
const posInt = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);

/** A syntactically sane ASCII (punycode) domain with at least two labels, or null. */
function cleanHost(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.normalize("NFKC").trim().toLowerCase().replace(/\.+$/, "");
  if (!s || s.length > 253) return null;
  if (/[^\x00-\x7f]/.test(s)) {
    s = url.domainToASCII(s);
    if (!s) return null;
  }
  s = s.replace(/\.+$/, "");
  const labels = s.split(".");
  if (s.length > 253 || labels.length < 2 || !labels.every((l) => LABEL_RE.test(l)) || !TLD_RE.test(labels[labels.length - 1])) return null;
  return s;
}

function parseToken(tok) {
  const stripped = tok.normalize("NFKC").trim().toLowerCase().replace(/^'+|'+$/g, "");
  const at = stripped.indexOf("@");
  if (at < 1 || at !== stripped.lastIndexOf("@")) return null;
  const local = stripped.slice(0, at);
  const domain = cleanHost(stripped.slice(at + 1));
  if (!domain || local.length > 64 || /[\x00-\x1f\x7f"\\\s]/.test(local)) return null;
  const plus = local.indexOf("+");
  const baseLocal = plus > 0 ? local.slice(0, plus) : local;
  return { address: `${local}@${domain}`, base: `${baseLocal}@${domain}`, local, domain };
}

/** @returns {{address: string, base: string, local: string, domain: string}[]} distinct, in order of appearance */
function parseAll(input) {
  if (typeof input !== "string" || !input) return [];
  const s = input.slice(0, MAX_INPUT).replace(/\([^()]{0,200}\)/g, " ");
  const out = [];
  for (const m of s.matchAll(TOKEN_RE)) {
    const p = parseToken(m[0]);
    if (p && !out.some((x) => x.address === p.address)) out.push(p);
    if (out.length >= MAX_ADDRESSES) break;
  }
  return out;
}

const extractAddresses = (input) => parseAll(input).map((p) => p.address);

function normaliseAddress(input) {
  const all = parseAll(input);
  return all.length === 1 ? all[0] : null;
}

function domainChain(domain) {
  const labels = String(domain || "").split(".").filter(Boolean);
  const out = [];
  for (let i = 0; i <= labels.length - 2; i += 1) out.push(labels.slice(i).join("."));
  return out;
}

/** The first suppression row covering any address found in `input`, or null. */
async function findSuppression(client, input) {
  const all = parseAll(input);
  if (!all.length) return null;
  const emails = [...new Set(all.flatMap((p) => [p.address, p.base]))];
  const domains = [...new Set(all.flatMap((p) => domainChain(p.domain)))];
  const r = await (client || db()).query(
    "SELECT * FROM js_suppressions WHERE (kind = 'email' AND value = ANY($1::text[])) OR (kind = 'domain' AND value = ANY($2::text[])) ORDER BY id LIMIT 1",
    [emails, domains]
  );
  return r.rows[0] || null;
}

async function isSuppressed(client, input) {
  return Boolean(await findSuppression(client, input));
}

// ---------------------------------------------------------------- add / remove

function cleanReason(v, { required = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, "reason is required");
    return null;
  }
  if (typeof v !== "string") throw new HttpError(400, "reason must be a string");
  const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (required && s.length < MIN_REASON) throw new HttpError(400, `reason must be at least ${MIN_REASON} characters`);
  if (s.length > MAX_REASON) throw new HttpError(400, `reason must be at most ${MAX_REASON} characters`);
  return s || null;
}

function cleanValue(kind, value) {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "value is required");
  if (kind === "email") {
    const all = parseAll(value);
    if (all.length !== 1) throw new HttpError(400, "value must be exactly one e-mail address");
    return all[0].address;
  }
  let s = value.normalize("NFKC").trim().toLowerCase();
  if (s.length > 300) throw new HttpError(400, "value is too long");
  if (s.includes("@")) throw new HttpError(400, "a domain suppression is a domain name, not an e-mail address (use kind email for one address)");
  if (/\s/.test(s)) throw new HttpError(400, "value must not contain spaces");
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      throw new HttpError(400, "value is not a valid domain name");
    }
  }
  s = s.split("/")[0].replace(/^www\./, "");
  if (s.includes(":") || s.includes("[")) throw new HttpError(400, "value must not contain a port or an IP address");
  const d = cleanHost(s);
  if (!d) throw new HttpError(400, "value is not a valid domain name with at least two labels (such as employer.com)");
  if (guard().isFreeMail(d)) throw new HttpError(400, "a free-mail provider cannot be suppressed as a domain (suppress the single address instead)");
  if (isPublicSuffix(d)) throw new HttpError(400, "a public suffix (such as co.uk or on.ca) cannot be suppressed as a domain; suppress the organisation's own domain or the single address");
  return d;
}

/**
 * Adds a suppression (idempotent per kind + value) and audits it. Runs on `client` (the caller's transaction).
 * @param {object} client
 * @param {{kind: 'email'|'domain', value: string, reason?: string, source?: string, employerId?: number, messageId?: number,
 *          createdBy?: number, actorLabel?: string, candidateId?: number, applicationId?: number}} a
 * @returns {Promise<{created: boolean, row: object}>}
 */
async function addSuppression(client, a = {}) {
  if (!KINDS.includes(a.kind)) throw new HttpError(400, "kind must be email or domain");
  const source = a.source === undefined ? "manual" : a.source;
  if (!SOURCES.includes(source)) throw new HttpError(400, "source must be manual, reply_opt_out or bounce");
  const value = cleanValue(a.kind, a.value);
  const reason = cleanReason(a.reason);
  const employerId = a.employerId === undefined || a.employerId === null ? null : posInt(a.employerId);
  if (a.employerId !== undefined && a.employerId !== null) {
    if (!employerId) throw new HttpError(400, "employerId must be a positive integer");
    if (!(await client.query("SELECT 1 FROM js_employers WHERE id = $1", [employerId])).rowCount) throw new HttpError(404, "Employer not found");
  }
  const createdBy = a.createdBy === undefined || a.createdBy === null ? null : posInt(a.createdBy);
  const ins = await client.query(
    `INSERT INTO js_suppressions (kind, value, reason, source, employer_id, message_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (kind, value) DO NOTHING RETURNING *`,
    [a.kind, value, reason, source, employerId, a.messageId || null, createdBy]
  );
  if (!ins.rows[0]) {
    const existing = (await client.query("SELECT * FROM js_suppressions WHERE kind = $1 AND value = $2", [a.kind, value])).rows[0];
    return { created: false, row: existing };
  }
  const row = ins.rows[0];
  await auditJs({
    userId: createdBy,
    actor: a.actorLabel,
    action: "suppression.add",
    entity: "js_suppressions",
    entityId: row.id,
    candidateId: a.candidateId || null,
    applicationId: a.applicationId || null,
    detail: { suppressionId: row.id, kind: row.kind, value: row.value, source, reason, employerId, messageId: a.messageId || null },
    client,
  });
  return { created: true, row };
}

/**
 * Removes a suppression. Administrator (Admin / SuperAdmin) only; a reason (3-500 characters) is required and audited.
 * When the removed row is the employer's last reply_opt_out suppression and the employer is still 'opted_out',
 * the employer is released to 'replied' (it did answer us); the audit row says so.
 * @returns {Promise<{removed: true, id: number, employerReleased: boolean}>}
 */
async function removeSuppression(client, { id, actor, reason } = {}) {
  if (!isAdmin(actor)) throw new HttpError(403, "Only an administrator can remove a suppression");
  const why = cleanReason(reason, { required: true });
  const sid = posInt(id);
  if (!sid) throw new HttpError(404, "Not found");
  const row = (await client.query("DELETE FROM js_suppressions WHERE id = $1 RETURNING *", [sid])).rows[0];
  if (!row) throw new HttpError(404, "Not found");
  let employerReleased = false;
  if (row.employer_id && row.source === "reply_opt_out") {
    const left = (await client.query("SELECT 1 FROM js_suppressions WHERE employer_id = $1 AND source = 'reply_opt_out' LIMIT 1", [row.employer_id])).rowCount;
    if (!left) {
      const upd = await client.query("UPDATE js_employers SET status = 'replied' WHERE id = $1 AND status = 'opted_out' RETURNING id", [row.employer_id]);
      employerReleased = upd.rowCount > 0;
    }
  }
  await auditJs({
    userId: actor.id,
    action: "suppression.remove",
    entity: "js_suppressions",
    entityId: sid,
    detail: { suppressionId: sid, kind: row.kind, value: row.value, source: row.source, originalReason: row.reason, reason: why, employerId: row.employer_id, employerReleased },
    client,
  });
  return { removed: true, id: sid, employerReleased };
}

module.exports = { isPublicSuffix, PUBLIC_SUFFIXES, KINDS, SOURCES, extractAddresses, normaliseAddress, domainChain, findSuppression, isSuppressed, addSuppression, removeSuppression, cleanReason };
