// Safe fetching of admin-configured, authorized feed URLs (SSRF guard).
//   - https only; no credentials in the URL; no private/loopback/link-local/reserved addresses
//   - DNS results are checked; redirects are followed manually and re-validated (https only)
//   - response size cap and timeout; identifying User-Agent; 429/Retry-After surfaced
// Nothing here ever tries to get around authentication or CAPTCHAs: 401/403 simply fail.
const net = require("net");
const dns = require("dns").promises;
const { FeedRejected, RateLimited, FeedHttpError } = require("./errors");

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

function userAgent() {
  return process.env.JOBSEARCH_USER_AGENT || "VITA-JobSearch/1.0 (+job feed reader; contact the site administrator)";
}

function ipv4Private(ip) {
  const p = ip.split(".").map(Number);
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) ||
    (a === 198 && b === 51 && p[2] === 100) ||
    (a === 203 && b === 0 && p[2] === 113) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Expands an IPv6 literal to eight 16-bit groups, or null if malformed. */
function expandIpv6(ip) {
  let s = ip.toLowerCase().split("%")[0];
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[1].split(".").map(Number);
    if (o.some((x) => x > 255)) return null;
    s = s.slice(0, -dotted[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill("0"), ...tail].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? all : null;
}

function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Private(ip);
  if (kind === 6) {
    const g = expandIpv6(ip);
    if (!g) return true;
    const v4 = (hi, lo) => ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    if (g.slice(0, 6).every((x) => x === 0)) return true; // ::/96 (unspecified, loopback, IPv4-compatible)
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:a.b.c.d
    if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return true; // ::ffff:0:a.b.c.d (SIIT)
    if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
    if (g[0] === 0x2002) return true; // 6to4
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
  }
  return true; // unparseable: refuse
}

/** Synchronous checks on the URL itself (scheme, credentials, literal IP, localhost). */
function assertSafeFeedUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new FeedRejected("Feed URL is not a valid URL");
  }
  if (u.protocol !== "https:") throw new FeedRejected("Feed URL must use https");
  if (u.username || u.password) throw new FeedRejected("Feed URL must not contain credentials");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new FeedRejected("Feed host is not allowed");
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new FeedRejected("Feed host resolves to a private or reserved address");
  return u;
}

async function assertPublicHost(u, lookup) {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return;
  let addrs;
  try {
    addrs = await (lookup || ((h) => dns.lookup(h, { all: true })))(host);
  } catch {
    throw new FeedRejected("Feed host could not be resolved");
  }
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === "string" ? a : a.address));
  if (list.length === 0 || list.some((a) => isPrivateAddress(a))) throw new FeedRejected("Feed host resolves to a private or reserved address");
}

function parseRetryAfter(value, nowMs) {
  if (!value) return 60 * 1000;
  const secs = Number(value);
  let ms;
  if (Number.isFinite(secs)) ms = secs * 1000;
  else {
    const t = Date.parse(value);
    ms = Number.isNaN(t) ? 60 * 1000 : t - nowMs;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new FeedRejected("Feed response is too large");
  if (!res.body || typeof res.body.getReader !== "function") {
    const t = await res.text();
    if (Buffer.byteLength(t) > maxBytes) throw new FeedRejected("Feed response is too large");
    return t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FeedRejected("Feed response is too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * GET an authorized feed URL. ctx: { fetch, lookup, now(), maxBytes, timeoutMs }.
 * Returns the response text. Errors never include the URL (it may carry a token).
 */
function fetchFeedText(rawUrl, ctx = {}) {
  // ctx.cache (a Map) memoises the download for one run; failures are not cached.
  if (!ctx.cache) return fetchFeedTextUncached(rawUrl, ctx);
  if (!ctx.cache.has(rawUrl)) {
    const p = fetchFeedTextUncached(rawUrl, ctx);
    ctx.cache.set(rawUrl, p);
    p.catch(() => ctx.cache.delete(rawUrl));
  }
  return ctx.cache.get(rawUrl);
}

async function fetchFeedTextUncached(rawUrl, ctx) {
  const doFetch = ctx.fetch || globalThis.fetch;
  const maxBytes = ctx.maxBytes || DEFAULT_MAX_BYTES;
  const timeoutMs = ctx.timeoutMs || DEFAULT_TIMEOUT_MS;
  const nowMs = ctx.now ? ctx.now().getTime() : Date.now();
  let u = assertSafeFeedUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(u, ctx.lookup);
    let res;
    try {
      res = await doFetch(u.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": userAgent(), accept: "application/json, application/rss+xml, application/xml;q=0.9, */*;q=0.1" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof FeedRejected) throw err;
      throw new Error(`Feed request to ${u.hostname} failed: ${(err && (err.name === "TimeoutError" ? "timeout" : err.code || err.message)) || "error"}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      let next;
      try {
        next = new URL(res.headers.get("location"), u);
      } catch {
        throw new FeedRejected("Feed redirect target is invalid");
      }
      u = assertSafeFeedUrl(next.toString()); // refuses http:// and private targets
      continue;
    }
    if (res.status === 429) throw new RateLimited(parseRetryAfter(res.headers.get("retry-after"), nowMs));
    if (res.status < 200 || res.status >= 300) throw new FeedHttpError(res.status, `Feed ${u.hostname} responded HTTP ${res.status}`);
    return readCapped(res, maxBytes);
  }
  throw new FeedRejected("Too many redirects");
}

module.exports = { assertSafeFeedUrl, assertPublicHost, isPrivateAddress, fetchFeedText, userAgent, DEFAULT_MAX_BYTES };
