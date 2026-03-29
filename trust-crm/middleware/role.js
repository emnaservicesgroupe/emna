const PERMISSIONS = {
  SuperAdmin: ["*"],
  Admin: [
    "candidates:read",
    "candidates:write",
    "visa:write",
    "documents:write",
    "finance:read",
    "finance:write",
    "notifications:read",
    "users:write",
    "audit:read",
  ],
  Manager: ["candidates:read", "candidates:write", "visa:write", "documents:write", "notifications:read", "finance:read"],
  Receptionist: ["candidates:read", "candidates:write", "documents:write", "notifications:read"],
  Accountant: ["finance:read", "finance:write", "notifications:read", "candidates:read"],
  HR: ["candidates:read", "users:read", "notifications:read"],
  Agent: ["candidates:read", "candidates:write", "visa:write", "documents:write"],
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
