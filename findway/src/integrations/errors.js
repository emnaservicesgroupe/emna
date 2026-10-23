'use strict';
// Delivery errors are classified so the worker knows whether retrying can help.
class TransientError extends Error { constructor(m, detail) { super(m); this.transient = true; this.detail = detail; } }
class PermanentError extends Error { constructor(m, detail) { super(m); this.transient = false; this.detail = detail; } }
class AuthError extends PermanentError { constructor(m) { super(m); this.auth = true; } }
module.exports = { TransientError, PermanentError, AuthError };
