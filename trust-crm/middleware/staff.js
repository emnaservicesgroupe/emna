const db = require("../db");
const { verifyToken } = require("./auth");

// Active staff roles = employees of the organisation. Candidate / Employer / Agency are portal roles, never staff.
const STAFF_ROLES = new Set(["SuperAdmin", "Admin", "Manager", "Receptionist", "Accountant", "HR", "Agent"]);

/**
 * Self-service gate (HR module): a verified token whose account is an ACTIVE staff user. No permission is needed.
 *  - verifyToken does the signature / token_version / portal-organisation checks (400/401);
 *  - a Candidate / Employer / Agency role (or anything else) is answered 403;
 *  - the account is re-read on every request, because legacy tokens carry no `tv` and verifyToken cannot see a
 *    deactivation or a role change for them: a deactivated or demoted account is answered 401 at once.
 */
exports.requireStaff = (req, res, next) => {
  verifyToken(req, res, async (err) => {
    if (err) return next(err);
    try {
      if (!req.user || !STAFF_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      const result = await db.query("SELECT is_active, role FROM users WHERE id = $1", [req.user.id]);
      const row = result.rows[0];
      if (!row || !row.is_active || row.role !== req.user.role) {
        return res.status(401).json({ error: "Session expired" });
      }
      return next();
    } catch (e) {
      console.error("Staff check failed:", e && (e.code || e.name));
      return res.status(500).json({ error: "Internal server error" });
    }
  });
};

exports.STAFF_ROLES = STAFF_ROLES;
