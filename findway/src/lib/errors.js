'use strict';
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status; this.code = code; this.details = details;
  }
}
const E = {
  badRequest: (code, msg, details) => new AppError(400, code, msg, details),
  unauthorized: (code = 'unauthenticated', msg = 'Authentication required') => new AppError(401, code, msg),
  forbidden: (code = 'permission_denied', msg = 'You do not have permission to do this', details) => new AppError(403, code, msg, details),
  notFound: (what = 'resource') => new AppError(404, 'not_found', `${what} not found`),
  conflict: (code, msg, details) => new AppError(409, code, msg, details),
  gone: (code, msg) => new AppError(410, code, msg),
  unprocessable: (code, msg, details) => new AppError(422, code, msg, details),
  tooMany: (code, msg, details) => new AppError(429, code, msg, details),
};
module.exports = { AppError, E };
