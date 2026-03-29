const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const candidateModel = require("../models/candidateModel");

test("updateCandidate merges missing fields with current row", async () => {
  const originalQuery = db.query;

  const current = {
    id: 1,
    full_name: "Old Name",
    nationality: "TN",
    date_of_birth: "1990-01-01",
    passport_number: "P123",
    passport_expiry: "2030-01-01",
    b3_expiry: null,
    embassy_date: null,
    visa_status: "Documents",
    work_company: "Old Co",
    partner_company: "Partner",
    assigned_to: 10,
  };

  let updateValues = null;

  db.query = async (sql, values) => {
    if (sql.startsWith("SELECT * FROM candidates WHERE id=$1")) {
      return { rows: [current] };
    }
    if (sql.startsWith("UPDATE candidates")) {
      updateValues = values;
      return { rows: [{ ...current, full_name: values[0], work_company: values[8] }] };
    }
    return { rows: [] };
  };

  try {
    await candidateModel.updateCandidate(1, { full_name: "New Name" });
    assert.equal(updateValues[0], "New Name");
    assert.equal(updateValues[8], "Old Co");
    assert.equal(updateValues[3], "P123");
  } finally {
    db.query = originalQuery;
  }
});
