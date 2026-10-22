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

// body-parser error types -> status. Anything else from the parser becomes 400.
const BODY_ERROR_STATUS = {
  "entity.parse.failed": 400,
  "entity.too.large": 413,
  "entity.verify.failed": 403,
  "encoding.unsupported": 415,
  "charset.unsupported": 415,
  "parameters.too.many": 413,
  "request.aborted": 400,
  "request.size.invalid": 400,
  "stream.encoding.set": 500,
  "stream.not.readable": 500,
};

/**
 * Handles body-parser failures for /jobsearch requests. Parser errors carry the raw
 * body (which may contain an OTP), so neither the error nor the body is logged.
 */
// eslint-disable-next-line no-unused-vars
function jobsearchBodyErrorHandler(err, _req, res, next) {
  if (!err || typeof err.type !== "string" || !(err.type in BODY_ERROR_STATUS)) return next(err);
  const status = BODY_ERROR_STATUS[err.type];
  const message = status === 413 ? "Request body too large" : status === 415 ? "Unsupported request encoding" : "Invalid request body";
  return res.status(status).json({ error: status >= 500 ? "Internal server error" : message });
}

module.exports = { asyncHandler, jobsearchErrorHandler, jobsearchBodyErrorHandler };
