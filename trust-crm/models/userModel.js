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
