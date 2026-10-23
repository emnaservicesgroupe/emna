const express = require("express");
const db = require("../db");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");
const { logAudit } = require("../utils/audit");
const { isStaff, assertCandidateAccess } = require("../modules/jobsearch/scope");

const router = express.Router();

// Task 19 (I-2): staff roles (Agent, Manager, Receptionist) may write documents only for candidates
// assigned to them (candidateScopeSql); Admin/SuperAdmin unchanged. Out of scope -> 404 (no existence leak).
async function inStaffScope(user, candidateId) {
  if (!isStaff(user)) return true;
  try {
    await assertCandidateAccess(user, typeof candidateId === "number" ? candidateId : String(candidateId));
    return true;
  } catch {
    return false;
  }
}

router.post("/", verifyToken, checkPermission("documents:write"), async (req, res) => {
  const { candidate_id, doc_type, file_path, expiry_date = null, status = "Uploaded", notes = null } = req.body;
  if (!candidate_id || !doc_type || !file_path) {
    return res.status(400).json({ error: "candidate_id, doc_type, and file_path are required" });
  }

  try {
    if (!(await inStaffScope(req.user, candidate_id))) return res.status(404).json({ error: "Candidate not found" });
    const result = await db.query(
      `INSERT INTO documents (candidate_id, doc_type, file_path, expiry_date, status, notes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [candidate_id, doc_type, file_path, expiry_date, status, notes, req.user.id]
    );

    await logAudit({ userId: req.user.id, action: "UPLOAD", tableName: "documents", recordId: result.rows[0].id, newData: result.rows[0] });
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put("/:id", verifyToken, checkPermission("documents:write"), async (req, res) => {
  const { status, notes, expiry_date, file_path } = req.body;
  try {
    const oldRow = await db.query("SELECT * FROM documents WHERE id=$1 AND is_deleted=false", [req.params.id]);
    if (!oldRow.rows.length) return res.status(404).json({ error: "Document not found" });
    if (!(await inStaffScope(req.user, oldRow.rows[0].candidate_id))) return res.status(404).json({ error: "Document not found" });

    const result = await db.query(
      `UPDATE documents
       SET status=COALESCE($1, status),
           notes=COALESCE($2, notes),
           expiry_date=COALESCE($3, expiry_date),
           file_path=COALESCE($4, file_path),
           updated_at=NOW()
       WHERE id=$5
       RETURNING *`,
      [status, notes, expiry_date, file_path, req.params.id]
    );

    await logAudit({ userId: req.user.id, action: "UPDATE", tableName: "documents", recordId: req.params.id, oldData: oldRow.rows[0], newData: result.rows[0] });

    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", verifyToken, checkPermission("documents:write"), async (req, res) => {
  try {
    const oldRow = await db.query("SELECT * FROM documents WHERE id=$1 AND is_deleted=false", [req.params.id]);
    if (!oldRow.rows.length) return res.status(404).json({ error: "Document not found" });
    if (!(await inStaffScope(req.user, oldRow.rows[0].candidate_id))) return res.status(404).json({ error: "Document not found" });

    const result = await db.query("UPDATE documents SET is_deleted=true, updated_at=NOW() WHERE id=$1 RETURNING *", [req.params.id]);

    await logAudit({ userId: req.user.id, action: "SOFT_DELETE", tableName: "documents", recordId: req.params.id, oldData: oldRow.rows[0], newData: result.rows[0] });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
