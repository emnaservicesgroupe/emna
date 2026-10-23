// Portal (Employer / Agency) authorisation. The organisation is resolved ONLY from crm_org_accounts for the
// authenticated user - never from the request. Reused by the employer and agency portals.
const { verifyToken } = require("../../middleware/auth");
const { HttpError } = require("../jobsearch/httpError");

const ROLES = {
  Employer: { type: "employer", table: "crm_employers" },
  Agency: { type: "agency", table: "crm_agencies" },
};

/**
 * Express middleware (array): verifyToken, exact role match, then the linked organisation must exist and be
 * active (else 403). Sets req.org = { type, id } (id is a string, as returned by pg for bigint).
 */
function requirePortalRole(role) {
  const cfg = ROLES[role];
  if (!cfg) throw new Error("requirePortalRole: unsupported role");
  const check = async (req, res, next) => {
    try {
      if (!req.user || req.user.role !== role) return res.status(403).json({ error: "Forbidden" });
      const r = await require("../../db").query(
        `SELECT o.id FROM crm_org_accounts oa JOIN ${cfg.table} o ON o.id = oa.org_id
          WHERE oa.user_id = $1 AND oa.org_type = $2 AND o.status <> 'suspended'`,
        [req.user.id, cfg.type]
      );
      if (r.rowCount === 0) return res.status(403).json({ error: "Forbidden" });
      req.org = { type: cfg.type, id: r.rows[0].id };
      return next();
    } catch (err) {
      return next(err instanceof HttpError ? err : err);
    }
  };
  return [verifyToken, check];
}

module.exports = { requirePortalRole };
