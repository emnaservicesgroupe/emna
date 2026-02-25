const bcrypt = require("bcrypt");
const db = require("../db");

exports.createUser = async (data) => {
  const hashedPassword = await bcrypt.hash(data.password, 10);

  const result = await db.query(
    `INSERT INTO users (full_name, email, password, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, full_name, email, role`,
    [data.full_name, data.email, hashedPassword, data.role]
  );

  return result.rows[0];
};

exports.findUserByEmail = async (email) => {
  const result = await db.query("SELECT * FROM users WHERE email=$1", [email]);
  return result.rows[0];
};
