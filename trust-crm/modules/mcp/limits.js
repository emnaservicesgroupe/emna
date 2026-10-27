// In-process limits for the MCP endpoint (stage 7).
//
// DESIGN CHOICE: all counters live in memory (one Node process per deployment, see docker-compose.yml), not in the database.
// A database counter would add a write to every call and would itself become the thing an attacker hammers; the cost of the
// in-memory choice is that limits reset on restart and are per process (a second replica would allow up to N times the rate).
// All structures are bounded: a token key exists only for authenticated tokens, and the unauthenticated-failure maps are pruned and capped.

const WINDOW_MS = 60 * 1000;

/** Sliding-window limiter: at most `limit` hits per key in the last minute. The check-and-record is synchronous, so concurrent requests cannot race past it. */
function createRateLimiter(windowMs = WINDOW_MS) {
  const hits = new Map(); // key -> ascending timestamps
  return {
    hit(key, limit, now = Date.now()) {
      let arr = hits.get(key);
      if (!arr) {
        arr = [];
        hits.set(key, arr);
        if (hits.size > 2000) this.prune(now);
      }
      while (arr.length && arr[0] <= now - windowMs) arr.shift();
      if (arr.length >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000)) };
      arr.push(now);
      return { ok: true, retryAfterSec: 0 };
    },
    prune(now = Date.now()) {
      for (const [k, arr] of hits) if (!arr.length || arr[arr.length - 1] <= now - windowMs) hits.delete(k);
    },
    size: () => hits.size,
    reset: () => hits.clear(),
  };
}

/** Failed-authentication audit throttle: one row per IP hash per minute, and at most `globalPerMin` rows in total per minute. */
function createFailureThrottle({ windowMs = WINDOW_MS, globalPerMin = 60, maxKeys = 5000 } = {}) {
  const last = new Map();
  let bucketStart = 0;
  let bucketCount = 0;
  return {
    shouldRecord(ipHash, now = Date.now()) {
      const key = ipHash || "-";
      if (now - bucketStart >= windowMs) {
        bucketStart = now;
        bucketCount = 0;
      }
      if (bucketCount >= globalPerMin) return false;
      const prev = last.get(key);
      if (prev !== undefined && now - prev < windowMs) return false;
      if (last.size >= maxKeys) {
        for (const [k, t] of last) if (now - t >= windowMs) last.delete(k);
        if (last.size >= maxKeys) return false;
      }
      last.set(key, now);
      bucketCount += 1;
      return true;
    },
    reset() {
      last.clear();
      bucketStart = 0;
      bucketCount = 0;
    },
  };
}

function intEnv(name, def, min, max) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

module.exports = { createRateLimiter, createFailureThrottle, intEnv };
