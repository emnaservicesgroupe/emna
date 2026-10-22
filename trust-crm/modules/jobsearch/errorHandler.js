// Error middleware for /jobsearch routers only (mounted inside each router so the
// app-wide handler and existing routes are untouched).
const { HttpError } = require("./httpError");

/** Wraps an async route handler so rejections reach the error middleware. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// eslint-disable-next-line no-unused-vars
function jobsearchErrorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  // Log only the error name/message and code: never request bodies (they may hold OTPs).
  console.error("jobsearch error:", err && err.name, err && err.code, err && err.message);
  return res.status(500).json({ error: "Internal server error" });
}

module.exports = { asyncHandler, jobsearchErrorHandler };
