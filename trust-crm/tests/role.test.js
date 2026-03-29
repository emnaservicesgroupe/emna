const test = require("node:test");
const assert = require("node:assert/strict");
const { PERMISSIONS } = require("../middleware/role");

test("permissions map contains required production roles", () => {
  const expectedRoles = ["SuperAdmin", "Admin", "Manager", "Receptionist", "Accountant", "HR", "Agent"];
  for (const role of expectedRoles) {
    assert.ok(PERMISSIONS[role], `Missing permissions for role: ${role}`);
  }

  assert.ok(PERMISSIONS.SuperAdmin.includes("*"));
  assert.ok(PERMISSIONS.Admin.includes("users:write"));
  assert.ok(PERMISSIONS.Admin.includes("finance:read"));
  assert.ok(PERMISSIONS.Accountant.includes("finance:write"));
});
