const db = require("../db");

exports.createCandidate = async (data) => {
  if (!data.full_name || !data.passport_number) {
    throw new Error("full_name and passport_number are required");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const candidateResult = await client.query(
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
          partner_company,
          assigned_to,
          created_by
        )
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *`,
      [
        data.full_name,
        data.nationality || null,
        data.date_of_birth || null,
        data.passport_number,
        data.passport_expiry || null,
        data.b3_expiry || null,
        data.embassy_date || null,
        data.visa_status || "Documents",
        data.work_company || null,
        data.partner_company || null,
        data.assigned_to || null,
        data.created_by || null,
      ]
    );

    const candidate = candidateResult.rows[0];

    const visaResult = await client.query(
      `INSERT INTO visa_applications (candidate_id, stage, status, updated_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [candidate.id, "Documents", "Pending", data.created_by || null]
    );

    await client.query("COMMIT");
    return { ...candidate, visa_application: visaResult.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

exports.getAllCandidates = async (search = "") => {
  const query = search
    ? `SELECT * FROM candidates
       WHERE is_deleted=false
         AND (full_name ILIKE $1 OR passport_number ILIKE $1)
       ORDER BY id DESC`
    : `SELECT * FROM candidates WHERE is_deleted=false ORDER BY id DESC`;
  const values = search ? [`%${search}%`] : [];
  const result = await db.query(query, values);
  return result.rows;
};

exports.getCandidateById = async (id) => {
  const result = await db.query("SELECT * FROM candidates WHERE id=$1 AND is_deleted=false", [id]);
  return result.rows[0] || null;
};

exports.updateCandidate = async (id, data) => {
  const currentResult = await db.query("SELECT * FROM candidates WHERE id=$1 AND is_deleted=false", [id]);
  if (!currentResult.rows.length) return null;

  const current = currentResult.rows[0];
  const merged = {
    full_name: data.full_name ?? current.full_name,
    nationality: data.nationality ?? current.nationality,
    date_of_birth: data.date_of_birth ?? current.date_of_birth,
    passport_number: data.passport_number ?? current.passport_number,
    passport_expiry: data.passport_expiry ?? current.passport_expiry,
    b3_expiry: data.b3_expiry ?? current.b3_expiry,
    embassy_date: data.embassy_date ?? current.embassy_date,
    visa_status: data.visa_status ?? current.visa_status,
    work_company: data.work_company ?? current.work_company,
    partner_company: data.partner_company ?? current.partner_company,
    assigned_to: data.assigned_to ?? current.assigned_to,
  };

  const result = await db.query(
    `UPDATE candidates
     SET full_name=$1,
         nationality=$2,
         date_of_birth=$3,
         passport_number=$4,
         passport_expiry=$5,
         b3_expiry=$6,
         embassy_date=$7,
         visa_status=$8,
         work_company=$9,
         partner_company=$10,
         assigned_to=$11,
         updated_at=NOW()
     WHERE id=$12 AND is_deleted=false
     RETURNING *`,
    [
      merged.full_name,
      merged.nationality,
      merged.date_of_birth,
      merged.passport_number,
      merged.passport_expiry,
      merged.b3_expiry,
      merged.embassy_date,
      merged.visa_status,
      merged.work_company,
      merged.partner_company,
      merged.assigned_to,
      id,
    ]
  );
  return result.rows[0] || null;
};

exports.softDeleteCandidate = async (id) => {
  const result = await db.query(
    `UPDATE candidates
     SET is_deleted=true, deleted_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND is_deleted=false
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
};
