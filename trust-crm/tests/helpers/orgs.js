const jwt = require("jsonwebtoken");

let seq = 0;

/** Signs a versioned (tv) portal token for a user, as the OTP login does. */
function portalToken(userId, role, tv = 0) {
  return jwt.sign({ id: userId, role, tv }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

async function createPortalUser(pool, type, { orgName, email, status = "active" } = {}) {
  seq += 1;
  const Role = type === "employer" ? "Employer" : "Agency";
  const table = type === "employer" ? "crm_employers" : "crm_agencies";
  const orgId = (await pool.query(`INSERT INTO ${table} (name, status) VALUES ($1,$2) RETURNING id`, [orgName || `Org ${seq}`, status])).rows[0].id;
  const userId = (
    await pool.query("INSERT INTO users (full_name,email,password,role,is_active) VALUES ($1,$2,'x',$3,true) RETURNING id", [
      `Portal ${seq}`,
      email || `${type}${seq}-${process.pid}@test.invalid`,
      Role,
    ])
  ).rows[0].id;
  await pool.query("INSERT INTO crm_org_accounts (user_id, org_type, org_id) VALUES ($1,$2,$3)", [userId, type, orgId]);
  return { orgId: Number(orgId), userId, token: portalToken(userId, Role) };
}

const createEmployerUser = (pool, opts) => createPortalUser(pool, "employer", opts);
const createAgencyUser = (pool, opts) => createPortalUser(pool, "agency", opts);

module.exports = { createEmployerUser, createAgencyUser, portalToken };
