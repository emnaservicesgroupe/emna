const jwt = require("jsonwebtoken");
const db = require("../db");

exports.verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  if (!token) {
    return res.status(401).json({ error: "Access denied" });
  }

  let verified;
  try {
    verified = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(400).json({ error: "Invalid token" });
  }

  // Legacy tokens (issued by /auth/login) carry no `tv` claim: unchanged behaviour.
  // Candidate tokens are only ever issued with `tv`, so one without it is refused.
  if (verified.tv === undefined) {
    if (verified.role === "Candidate") {
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
  } catch (err) {
    console.error("Session check failed:", err && (err.code || err.name));
    return res.status(500).json({ error: "Internal server error" });
  }

  req.user = verified;
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
