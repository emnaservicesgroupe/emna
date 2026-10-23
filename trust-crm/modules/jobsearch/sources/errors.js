// Error types shared by source adapters and the search runner.
class SourceNotConnected extends Error {
  constructor(message = "Source is not configured") {
    super(message);
    this.name = "SourceNotConnected";
    this.code = "SOURCE_NOT_CONNECTED";
  }
}

/** Feed URL / response refused by the safety rules (never retried). */
class FeedRejected extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedRejected";
    this.code = "FEED_REJECTED";
    this.retriable = false;
  }
}

/** HTTP 429 from the source; retryAfterMs is honoured by the runner. */
class RateLimited extends Error {
  constructor(retryAfterMs) {
    super("Source responded 429 (rate limited)");
    this.name = "RateLimited";
    this.code = "RATE_LIMITED";
    this.retryAfterMs = retryAfterMs;
  }
}

class FeedHttpError extends Error {
  constructor(status, message) {
    super(message || `Source responded HTTP ${status}`);
    this.name = "FeedHttpError";
    this.status = status;
    // 401/403 means the feed needs credentials we do not have: never bypassed, never retried.
    this.retriable = !(status === 401 || status === 403 || status === 404);
  }
}

module.exports = { SourceNotConnected, FeedRejected, RateLimited, FeedHttpError };
