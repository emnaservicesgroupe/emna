// Parses authorized JSON / RSS job feeds into RawJob objects (untrusted data; sanitised on store).
const { FeedRejected } = require("./errors");
const { assertSafeFeedUrl, fetchFeedText } = require("./http");

const MAX_ITEMS = 2000;

function str(v) {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

function date(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const MAX_FIELD = 400; // the store applies the tighter per-field caps; this only bounds what a hostile feed can make us hold

/** Free-text pay: a string as given, or a schema.org baseSalary object rendered as "CAD 40000-50000 YEAR". */
function salaryOf(it) {
  const direct = str(it.salary) || str(it.salaryText) || str(it.compensation) || str(it.pay);
  if (direct) return direct.slice(0, MAX_FIELD);
  const b = it.baseSalary;
  if (b && typeof b === "object") {
    const v = b.value && typeof b.value === "object" ? b.value : b;
    const lo = str(v.minValue) || str(v.value);
    const hi = str(v.maxValue);
    if (lo || hi) return [str(b.currency), lo && hi && lo !== hi ? `${lo}-${hi}` : lo || hi, str(v.unitText)].filter(Boolean).join(" ").slice(0, MAX_FIELD);
  }
  return null;
}

/** 'YYYY-MM-DD' of a feed closing date (a calendar day, or an ISO timestamp), else null. */
function dayOf(v) {
  const s = str(v);
  if (!s) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? new Date(`${s.trim()}T00:00:00Z`) : new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) && day !== s.trim() ? null : day;
}

function fromJsonItem(it, defaults) {
  if (!it || typeof it !== "object") return null;
  const title = str(it.title) || str(it.jobTitle);
  const url = str(it.url) || str(it.link) || str(it.applyUrl);
  const sourceJobId = str(it.id) || str(it.sourceJobId) || str(it.jobId) || url;
  if (!title || !sourceJobId) return null;
  const loc = it.location && typeof it.location === "object" ? [it.location.city, it.location.region, it.location.country].filter(Boolean).join(", ") : str(it.location);
  return {
    sourceJobId: String(sourceJobId),
    url,
    title,
    employerName: str(it.employer) || str(it.employerName) || str(it.company) || (it.employer && str(it.employer.name)) || null,
    location: loc,
    country: str(it.country) || (it.location && typeof it.location === "object" ? str(it.location.country) : null) || defaults.country || null,
    publishedAt: date(it.publishedAt || it.published || it.datePosted || it.date),
    closingAt: date(it.closingAt || it.closing || it.validThrough || it.expires),
    description: str(it.description) || str(it.summary) || "",
    language: str(it.language) || defaults.language || null,
    salaryText: salaryOf(it),
    employmentType: (str(it.employmentType) || str(it.jobType) || str(it.employment_type) || "").slice(0, MAX_FIELD) || null,
    requiredExperienceText: (str(it.experienceRequirements) || str(it.requiredExperience) || str(it.experience) || "").slice(0, MAX_FIELD) || null,
    closingDate: dayOf(it.closingDate || it.closing_date || it.closingAt || it.closing || it.validThrough || it.expires),
  };
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return null;
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

function parseRss(text, defaults) {
  const items = text.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return items.slice(0, MAX_ITEMS).map((b) => {
    const link = tag(b, "link");
    return fromJsonItem({ id: tag(b, "guid") || link, title: tag(b, "title"), url: link, employer: tag(b, "author") || tag(b, "company"), location: tag(b, "location"), publishedAt: tag(b, "pubDate"), description: tag(b, "description"), salary: tag(b, "salary"), employmentType: tag(b, "employmentType") || tag(b, "jobType"), experience: tag(b, "experience"), closingDate: tag(b, "closingDate") }, defaults);
  }).filter(Boolean);
}

function parseFeed(text, defaults = {}) {
  const t = String(text).trim();
  if (t.startsWith("<")) return parseRss(t, defaults);
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    throw new FeedRejected("Feed is neither valid JSON nor RSS");
  }
  const list = Array.isArray(data) ? data : Array.isArray(data && data.jobs) ? data.jobs : Array.isArray(data && data.items) ? data.items : null;
  if (!list) throw new FeedRejected("Feed JSON has no jobs array");
  return list.slice(0, MAX_ITEMS).map((it) => fromJsonItem(it, defaults)).filter(Boolean);
}

/** Client-side filtering: the feeds are static documents, not search APIs. */
function filterJobs(jobs, query = {}) {
  const kws = (query.keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean);
  const country = query.country ? String(query.country).toLowerCase() : null;
  const since = query.since ? new Date(query.since).getTime() : null;
  return jobs.filter((j) => {
    if (country && j.country && String(j.country).toLowerCase() !== country) return false;
    if (since && j.publishedAt && new Date(j.publishedAt).getTime() < since) return false;
    if (kws.length) {
      const hay = `${j.title} ${j.description}`.toLowerCase();
      if (!kws.some((k) => hay.includes(k))) return false;
    }
    return true;
  });
}

async function loadFeeds(urls, ctx, defaults) {
  const all = [];
  for (const u of urls) all.push(...parseFeed(await fetchFeedText(u, ctx), defaults));
  return all;
}

/** Validates configured URLs without any network access. Returns null or an error text. */
function configProblem(urls) {
  for (const u of urls) {
    try {
      assertSafeFeedUrl(u);
    } catch (e) {
      return e.message;
    }
  }
  return null;
}

module.exports = { parseFeed, filterJobs, loadFeeds, configProblem };
