const db = require("../db");

exports.createCandidate = async (data) => {
  const result = await db.query(
    `INSERT INTO candidates
    (full_name, nationality, date_of_birth, passport_number, passport_expiry, b3_expiry, embassy_date, visa_status, work_company)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *`,
    [
      data.full_name,
      data.nationality,
      data.date_of_birth,
      data.passport_number,
      data.passport_expiry,
      data.b3_expiry,
      data.embassy_date,
      data.visa_status,
      data.work_company,
    ]
  );
  return result.rows[0];
};

exports.getAllCandidates = async () => {
  const result = await db.query("SELECT * FROM candidates ORDER BY id DESC");
  return result.rows;
};
