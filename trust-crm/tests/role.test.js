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

test("Task 19 SETUP §6 permission matrix equals PERMISSIONS (docs cannot drift from middleware/role.js)", () => {
  const fs = require("fs");
  const path = require("path");
  const doc = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "vita-job-search", "SETUP.md"), "utf8");
  const m = /<!-- permission-matrix:start -->([\s\S]*?)<!-- permission-matrix:end -->/.exec(doc);
  assert.ok(m, "SETUP.md has the permission-matrix block");
  const lines = m[1].trim().split("\n").filter((l) => l.startsWith("|"));
  const header = lines[0].split("|").map((c) => c.trim()).filter(Boolean);
  const perms = header.slice(1).filter((h) => /^[a-z]+:[a-z]+$/.test(h));
  assert.deepEqual(perms, ["jobsearch:read", "jobsearch:write", "jobsearch:approve", "jobsearch:admin", "users:write"]);
  const allJobsearch = [...new Set(Object.values(PERMISSIONS).flat().filter((p) => p.startsWith("jobsearch:")))].sort();
  assert.deepEqual(allJobsearch, perms.filter((p) => p.startsWith("jobsearch:")).sort(), "every jobsearch:* grant in the code is a documented column");
  const seen = new Set();
  for (const line of lines.slice(2)) {
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const role = cells[0];
    seen.add(role);
    assert.ok(PERMISSIONS[role], `documented role ${role} exists`);
    perms.forEach((p, i) => {
      const has = PERMISSIONS[role].includes("*") || PERMISSIONS[role].includes(p);
      assert.equal(cells[i + 1] === "✓", has, `${role} ${p}: doc says ${cells[i + 1]}, code says ${has}`);
      assert.ok(["✓", "—"].includes(cells[i + 1]), `${role} ${p}: cell must be ✓ or —`);
    });
  }
  assert.deepEqual([...seen].sort(), Object.keys(PERMISSIONS).sort(), "every role is documented");
});
