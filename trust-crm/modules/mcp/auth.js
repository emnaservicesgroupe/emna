// Bearer handling for personal access tokens (PAT). A PAT is NOT a JWT: it is accepted only by /mcp (stage 7, Task 3) through
// authenticateRequest(); everywhere else middleware/auth.js refuses anything that starts with PAT_PREFIX before any JWT parsing.
const PAT_PREFIX = "vita_pat_";

/** The raw credential of an Authorization header, exactly as middleware/auth.js reads it ("Bearer x" or a bare "x"). */
function rawCredential(header) {
  const h = typeof header === "string" ? header : "";
  return h.startsWith("Bearer ") ? h.slice(7) : h;
}

/** True when the header carries a PAT (case-sensitive prefix, optional leading spaces tolerated so it can never slip past as "not a PAT"). */
function isPatBearer(header) {
  return rawCredential(header).trimStart().startsWith(PAT_PREFIX);
}

/** The PAT secret of an Authorization header, or null when the header does not carry one. */
function patFromHeader(header) {
  const c = rawCredential(header).trim();
  return c.startsWith(PAT_PREFIX) ? c : null;
}

/** Authenticates a request's PAT: {user, token} or null (generic: the caller must not say why). */
async function authenticateRequest(req, opts = {}) {
  const secret = patFromHeader(req && req.headers && req.headers.authorization);
  if (!secret) return null;
  return require("./tokens").authenticate(secret, opts);
}

module.exports = { PAT_PREFIX, isPatBearer, patFromHeader, authenticateRequest };
