// Error carrying an HTTP status; mapped to JSON { error } by ./errorHandler.
class HttpError extends Error {
  constructor(status, message) {
    super(message || "Error");
    this.name = "HttpError";
    this.status = status;
  }
}

module.exports = { HttpError };
