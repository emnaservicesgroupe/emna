// Error carrying an HTTP status; mapped to JSON { error } by ./errorHandler.
class HttpError extends Error {
  constructor(status, message, code) {
    super(message || "Error");
    this.name = "HttpError";
    this.status = status;
    if (code) this.code = code; // optional stable machine-readable code
  }
}

module.exports = { HttpError };
