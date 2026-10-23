const bcrypt = require("bcrypt");
const db = require("../db");

exports.createUser = async (data) => {
  const hashedPassword = await bcrypt.hash(data.password, 12);

  const result = await db.query(
    `INSERT INTO users (full_name, email, password, role, is_active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id, full_name, email, role, is_active`,
    [data.full_name, data.email, hashedPassword, data.role]
  );

  return result.rows[0];
};

exports.findUserByEmail = async (email) => {
  const result = await db.query("SELECT * FROM users WHERE email=$1", [email]);
  return result.rows[0];
};

exports.countUsers = async () => {
  const result = await db.query("SELECT COUNT(*)::int AS count FROM users");
  return result.rows[0].count;
};

/**
 * Task 20 (C1): creates the first SuperAdmin atomically. Under a transaction-level advisory lock the users
 * table is checked and the row inserted, so concurrent bootstrap calls create at most one account.
 * @returns {Promise<object|null>} the user, or null when any user already exists
 */
exports.createFirstSuperAdmin = async ({ full_name, email, password }) => {
  const hashedPassword = await bcrypt.hash(password, 12);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('trustcrm_bootstrap_super_admin'))");
    const result = await client.query(
      `INSERT INTO users (full_name, email, password, role, is_active)
       SELECT $1, $2, $3, 'SuperAdmin', true
        WHERE NOT EXISTS (SELECT 1 FROM users)
       RETURNING id, full_name, email, role, is_active`,
      [full_name, email, hashedPassword]
    );
    await client.query("COMMIT");
    return result.rows[0] || null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
