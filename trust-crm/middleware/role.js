const PERMISSIONS = {
  SuperAdmin: ["*"],
  Admin: [
    "candidates:read",
    "candidates:write",
    "visa:write",
    "documents:write",
    "finance:read",
    "finance:write",
    "finance:void",
    "finance:refund",
    "finance:export",
    "notifications:read",
    "users:write",
    "audit:read",
    "jobsearch:read",
    "jobsearch:write",
    "jobsearch:approve",
    "jobsearch:admin",
    "leads:read",
    "leads:write",
    "sitejobs:write",
    "orgs:read",
    "orgs:write",
    "hr:read",
    "hr:write",
    "hr:approve",
  ],
  Manager: ["candidates:read", "candidates:write", "visa:write", "documents:write", "notifications:read", "finance:read", "finance:export", "jobsearch:read", "jobsearch:write", "jobsearch:approve", "leads:read", "leads:write", "sitejobs:write", "orgs:read", "orgs:write", "hr:approve"],
  Receptionist: ["candidates:read", "candidates:write", "documents:write", "notifications:read", "jobsearch:read", "jobsearch:write", "leads:read", "leads:write", "sitejobs:write", "orgs:read"],
  Accountant: ["finance:read", "finance:write", "finance:void", "finance:refund", "finance:export", "notifications:read", "candidates:read"],
  HR: ["candidates:read", "users:read", "notifications:read", "hr:read", "hr:write", "hr:approve"],
  Agent: ["candidates:read", "candidates:write", "visa:write", "documents:write", "jobsearch:read", "jobsearch:write", "leads:read"],
  // Candidates are authorised by ownership checks (modules/jobsearch/scope.js), not permissions.
  Candidate: [],
  // Portal users (employer / agency organisations) hold NO staff permissions: they are authorised only by the
  // role-specific portal middleware, with the organisation taken from crm_org_accounts. Keep these empty.
  Employer: [],
  Agency: [],
};

exports.checkRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Access denied" });
    }

    return next();
  };
};

exports.checkPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userPermissions = PERMISSIONS[req.user.role] || [];
    if (userPermissions.includes("*") || userPermissions.includes(permission)) {
      return next();
    }

    return res.status(403).json({ error: `Permission denied: ${permission}` });
  };
};

exports.PERMISSIONS = PERMISSIONS;
