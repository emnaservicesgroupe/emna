const jwt = require("jsonwebtoken");
const db = require("../db");
const { isPatBearer } = require("../modules/mcp/auth");

const VERSIONED_ROLES = new Set(["Candidate", "Employer", "Agency"]);
const ORG_ROLES = { Employer: ["employer", "crm_employers"], Agency: ["agency", "crm_agencies"] };

exports.verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  if (!token) {
    return res.status(401).json({ error: "Access denied" });
  }

  // A personal access token (MCP) is never a session: refuse it before any JWT parsing. Only /mcp accepts one.
  if (isPatBearer(authHeader)) {
    return res.status(401).json({ error: "Access denied" });
  }

  let verified;
  try {
    verified = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(400).json({ error: "Invalid token" });
  }

  // Legacy tokens (issued by /auth/login) carry no `tv` claim: unchanged behaviour.
  // Candidate / Employer / Agency tokens are only ever issued with `tv`, so one without it is refused.
  if (verified.tv === undefined) {
    if (VERSIONED_ROLES.has(verified.role)) {
      return res.status(401).json({ error: "Session expired" });
    }
    req.user = verified;
    return next();
  }

  // Versioned tokens: re-check the account on every request (session revocation).
  try {
    const result = await db.query("SELECT is_active, token_version, role FROM users WHERE id = $1", [verified.id]);
    const user = result.rows[0];
    if (!user || !user.is_active || user.token_version !== verified.tv || user.role !== verified.role) {
      return res.status(401).json({ error: "Session expired" });
    }
    // Portal users: the linked organisation must exist and not be suspended (takes effect on the next request).
    if (ORG_ROLES[verified.role]) {
      const [orgType, table] = ORG_ROLES[verified.role];
      const org = await db.query(
        `SELECT 1 FROM crm_org_accounts oa JOIN ${table} o ON o.id = oa.org_id
          WHERE oa.user_id = $1 AND oa.org_type = $2 AND o.status <> 'suspended'`,
        [verified.id, orgType]
      );
      if (org.rowCount === 0) return res.status(401).json({ error: "Session expired" });
    }
  } catch (err) {
    console.error("Session check failed:", err && (err.code || err.name));
    return res.status(500).json({ error: "Internal server error" });
  }

  req.user = verified;
  return next();
};

/**
 * Defense in depth for /jobsearch (candidate + staff job-search API): a valid Employer or Agency token never
 * reaches a /jobsearch handler, so no body validation, scope query or future route there can answer a portal
 * user with anything but 403. Only the caller's own session echo (GET /auth/me -> {id, role}) and the public OTP
 * sign-in routes (which ignore the token) pass. Tokens that do not verify fall through to the routes, which
 * answer them exactly as before (401/400).
 */
const PORTAL_JOBSEARCH_OK = new Set(["GET /auth/me", "POST /auth/otp/request", "POST /auth/otp/verify"]);
exports.rejectPortalTokens = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (!token || isPatBearer(header)) return next(); // a PAT is never parsed as a JWT; the route's verifyToken answers 401
  let verified;
  try {
    verified = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return next();
  }
  if (verified && ORG_ROLES[verified.role] && !PORTAL_JOBSEARCH_OK.has(`${req.method} ${req.path.replace(/\/+$/, "") || "/"}`)) {
    return res.status(403).json({ error: "Access denied" });
  }
  return next();
};

/**
 * Revokes every versioned (`tv`) token of a user by bumping users.token_version.
 * Returns the new version, or null when the user does not exist.
 */
exports.bumpTokenVersion = async (userId) => {
  const result = await db.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version", [userId]);
  return result.rows[0] ? result.rows[0].token_version : null;
};
