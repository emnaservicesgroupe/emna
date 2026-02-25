const db = require("../db");

exports.createCandidate = async (data) => {
  if (!data.full_name || !data.passport_number) {
    throw new Error("full_name and passport_number are required");
  }

  const result = await db.query(
    `INSERT INTO candidates
      (
        full_name,
        nationality,
        date_of_birth,
        passport_number,
        passport_expiry,
        b3_expiry,
        embassy_date,
        visa_status,
        work_company,
        partner_company
      )
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      data.full_name,
      data.nationality || null,
      data.date_of_birth || null,
      data.passport_number,
      data.passport_expiry || null,
      data.b3_expiry || null,
      data.embassy_date || null,
      data.visa_status || "Pending",
      data.work_company || null,
      data.partner_company || null,
    ]
  );

  return result.rows[0];
};

exports.getAllCandidates = async () => {
  const result = await db.query("SELECT * FROM candidates ORDER BY id DESC");
  return result.rows;
};
