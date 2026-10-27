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
    "chat:read",
    "chat:write",
    "chat:moderate",
  ],
  Manager: ["candidates:read", "candidates:write", "visa:write", "documents:write", "notifications:read", "finance:read", "finance:export", "jobsearch:read", "jobsearch:write", "jobsearch:approve", "leads:read", "leads:write", "sitejobs:write", "orgs:read", "orgs:write", "hr:approve", "chat:read", "chat:write", "chat:moderate"],
  Receptionist: ["candidates:read", "candidates:write", "documents:write", "notifications:read", "jobsearch:read", "jobsearch:write", "leads:read", "leads:write", "sitejobs:write", "orgs:read", "chat:read", "chat:write"],
  Accountant: ["finance:read", "finance:write", "finance:void", "finance:refund", "finance:export", "notifications:read", "candidates:read"],
  // HR and Accountant hold no chat:* on purpose: they reach /chat but see (and write in) only the internal "staff" rooms they were
  // explicitly added to (rule in modules/chat/scope.js), never candidate / employer / agency conversations, and cannot moderate.
  HR: ["candidates:read", "users:read", "notifications:read", "hr:read", "hr:write", "hr:approve"],
  Agent: ["candidates:read", "candidates:write", "visa:write", "documents:write", "jobsearch:read", "jobsearch:write", "leads:read", "chat:read", "chat:write"],
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
