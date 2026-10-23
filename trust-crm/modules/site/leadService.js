// Creates (or refreshes) a CRM lead from the public website forms. All input is untrusted: it is
// validated, length-capped and stored verbatim as text (never interpreted). Only a salted ip hash is
// kept - never the raw IP or user agent.
const { HttpError } = require("../jobsearch/httpError");
const { hit, hashWithSalt, bucketIp, intEnv } = require("./rateLimit");

const KINDS = ["candidate", "employer", "contact"];
const LANGS = ["ar", "en", "fr"];
const CONSENT_TEXT_VERSION = process.env.SITE_CONSENT_VERSION || "2026-10-v1";
const CAPS = { name: 120, email: 254, phone: 32, country: 80, profession: 120, company: 160, message: 4000 };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const PHONE_RE = /^\+?[0-9 ().-]+$/;
const OPEN = ["new", "contacted", "qualified"];
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

function hasValue(v) {
  return v !== undefined && v !== null && v !== "" && v !== false;
}

function str(input, field, { required = false } = {}) {
  const v = input[field];
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be text`);
  if (v.includes("\u0000")) throw new HttpError(400, `${field} contains invalid characters`);
  const t = v.trim();
  if (!t) {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (t.length > CAPS[field]) throw new HttpError(400, `${field} must be at most ${CAPS[field]} characters`);
  return t;
}

function validate(input) {
  if (!KINDS.includes(input.kind)) throw new HttpError(400, "kind must be candidate, employer or contact");
  const name = str(input, "name", { required: true });
  let email = str(input, "email");
  if (email) {
    email = email.toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "email is not valid");
  }
  const phone = str(input, "phone");
  let phoneDigits = null;
  if (phone) {
    phoneDigits = phone.replace(/\D/g, "");
    if (!PHONE_RE.test(phone) || phoneDigits.length < 7 || phoneDigits.length > 15) throw new HttpError(400, "phone is not valid");
  }
  if (!email && !phone) throw new HttpError(400, "email or phone is required");
  if (input.kind !== "contact" && input.consent !== true) throw new HttpError(400, "consent is required");
  const lang = LANGS.includes(input.lang) ? input.lang : null;
  return {
    kind: input.kind,
    name,
    email,
    phone,
    phoneDigits,
    country: str(input, "country"),
    profession: str(input, "profession"),
    company: str(input, "company"),
    message: str(input, "message"),
    lang,
    consent: input.consent === true,
  };
}

function tooMany(retryAfter) {
  const e = new HttpError(429, "Too many submissions. Please try again later.");
  e.retryAfter = retryAfter;
  return e;
}

const ipHashOf = (ip) => hashWithSalt(bucketIp(ip));

/**
 * Counts one hit against the per-IP hourly limit (IPv6 by /64) and the global daily cap
 * (SITE_LEAD_GLOBAL_PER_DAY, default 2000; honeypot submissions count too). Throws HttpError(429) with .retryAfter.
 */
async function checkIpLimit(pool, ip) {
  const r = await hit(pool, `lead-ip:${ipHashOf(ip)}`, { windowMs: HOUR_MS, max: intEnv("SITE_LEAD_IP_PER_HOUR", 5) });
  if (!r.allowed) throw tooMany(r.retryAfter);
  const g = await hit(pool, "lead-global", { windowMs: DAY_MS, max: intEnv("SITE_LEAD_GLOBAL_PER_DAY", 2000) });
  if (!g.allowed) throw tooMany(g.retryAfter);
}

async function storeSpam(pool, input, ipHash) {
  let name = typeof input.name === "string" ? input.name.replace(/\u0000/g, "").trim().slice(0, CAPS.name) : "";
  if (!name) name = "(spam)";
  const kind = KINDS.includes(input.kind) ? input.kind : "contact";
  const lang = LANGS.includes(input.lang) ? input.lang : null;
  await pool.query(
    "INSERT INTO crm_leads (kind, status, name, lang, source, ip_hash) VALUES ($1,'spam',$2,$3,'website',$4)",
    [kind, name, lang, ipHash]
  );
}

const MATCH_SQL = `
  SELECT id, status FROM crm_leads
   WHERE kind = $1 AND status <> 'spam' AND created_at > now() - interval '24 hours'
     AND (($2::text IS NOT NULL AND lower(email) = $2)
       OR ($3::text IS NOT NULL AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = $3))
   ORDER BY created_at DESC LIMIT 1`;

// A resubmission may only fill gaps in an open lead: name and consent_at/version are never changed, contact
// fields are filled when empty, and a message is stored only when the lead has none yet.
const UPDATE_SQL = `
  UPDATE crm_leads SET
    country = coalesce(country, $2), profession = coalesce(profession, $3), company = coalesce(company, $4),
    message = CASE WHEN message IS NULL OR btrim(message) = '' THEN $5 ELSE message END,
    lang = coalesce(lang, $6), email = coalesce(email, $7), phone = coalesce(phone, $8),
    updated_at = now()
  WHERE id = $1 AND status IN ('new','contacted','qualified')`;

/**
 * @returns {Promise<{ok:true, spam:boolean}>}
 * @throws HttpError(400) validation, HttpError(429) with .retryAfter when the per-email limit is hit.
 */
async function createLead(pool, input, { ip } = {}) {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!body) throw new HttpError(400, "Invalid request body");
  const ipHash = ipHashOf(ip);

  if (typeof body.hp_url === "string" ? body.hp_url.trim() !== "" : hasValue(body.hp_url)) {
    await storeSpam(pool, body, ipHash);
    return { ok: true, spam: true };
  }

  const v = validate(body);
  const ident = v.email || v.phoneDigits;
  const lim = await hit(pool, `lead-id:${hashWithSalt(ident)}`, { windowMs: DAY_MS, max: intEnv("SITE_LEAD_EMAIL_PER_DAY", 3) });
  if (!lim.allowed) throw tooMany(lim.retryAfter);

  const key = `${v.kind}:${ident}:${new Date().toISOString().slice(0, 10)}`;
  const upd = (id) =>
    pool.query(UPDATE_SQL, [id, v.country, v.profession, v.company, v.message, v.lang, v.email, v.phone]);
  const find = async () => (await pool.query(MATCH_SQL, [v.kind, v.email, v.phoneDigits])).rows[0];

  const existing = await find();
  if (existing) {
    if (OPEN.includes(existing.status)) await upd(existing.id); // converted/rejected/...: acknowledged, never written
    return { ok: true, spam: false };
  }
  try {
    await pool.query(
      `INSERT INTO crm_leads (kind, status, name, email, phone, country, profession, company, message, lang,
                              consent_at, consent_text_version, source, ip_hash, dedupe_key)
       VALUES ($1,'new',$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10::boolean THEN now() END, CASE WHEN $10::boolean THEN $11 END,'website',$12,$13)`,
      [v.kind, v.name, v.email, v.phone, v.country, v.profession, v.company, v.message, v.lang, v.consent, CONSENT_TEXT_VERSION, ipHash, key]
    );
  } catch (err) {
    if (err && err.code === "23505") {
      const again = await find();
      if (again) {
        if (OPEN.includes(again.status)) await upd(again.id);
        return { ok: true, spam: false };
      }
    }
    throw err;
  }
  return { ok: true, spam: false };
}

module.exports = { createLead, checkIpLimit, CONSENT_TEXT_VERSION };
