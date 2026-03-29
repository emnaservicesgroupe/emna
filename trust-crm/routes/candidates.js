const express = require("express");
const candidateModel = require("../models/candidateModel");
const db = require("../db");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");
const { logAudit } = require("../utils/audit");

const router = express.Router();

router.post("/add", verifyToken, checkPermission("candidates:write"), async (req, res) => {
  try {
    const payload = { ...req.body, created_by: req.user.id };
    const newCandidate = await candidateModel.createCandidate(payload);

    await logAudit({
      userId: req.user.id,
      action: "CREATE",
      tableName: "candidates",
      recordId: newCandidate.id,
      newData: newCandidate,
    });

    return res.status(201).json(newCandidate);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/all", verifyToken, checkPermission("candidates:read"), async (req, res) => {
  try {
    const list = await candidateModel.getAllCandidates(req.query.search || "");
    return res.json(list);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/:id", verifyToken, checkPermission("candidates:read"), async (req, res) => {
  try {
    const candidate = await candidateModel.getCandidateById(req.params.id);
    if (!candidate) return res.status(404).json({ error: "Candidate not found" });
    return res.json(candidate);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put("/:id", verifyToken, checkPermission("candidates:write"), async (req, res) => {
  try {
    const oldCandidate = await candidateModel.getCandidateById(req.params.id);
    if (!oldCandidate) return res.status(404).json({ error: "Candidate not found" });

    const updated = await candidateModel.updateCandidate(req.params.id, req.body);

    await logAudit({
      userId: req.user.id,
      action: "UPDATE",
      tableName: "candidates",
      recordId: req.params.id,
      oldData: oldCandidate,
      newData: updated,
    });

    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", verifyToken, checkPermission("candidates:write"), async (req, res) => {
  try {
    const oldCandidate = await candidateModel.getCandidateById(req.params.id);
    if (!oldCandidate) return res.status(404).json({ error: "Candidate not found" });

    const deleted = await candidateModel.softDeleteCandidate(req.params.id);

    await logAudit({
      userId: req.user.id,
      action: "SOFT_DELETE",
      tableName: "candidates",
      recordId: req.params.id,
      oldData: oldCandidate,
      newData: deleted,
    });

    return res.json({ ok: true, deleted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/:id/stage", verifyToken, checkPermission("visa:write"), async (req, res) => {
  const { stage, status = "Pending", notes = null } = req.body;
  if (!stage) return res.status(400).json({ error: "stage is required" });

  try {
    const existing = await db.query("SELECT * FROM visa_applications WHERE candidate_id=$1", [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: "Visa application not found" });

    const oldData = existing.rows[0];
    const result = await db.query(
      `UPDATE visa_applications
       SET stage=$1, status=$2, notes=$3, updated_by=$4, updated_at=NOW()
       WHERE candidate_id=$5
       RETURNING *`,
      [stage, status, notes, req.user.id, req.params.id]
    );

    await db.query(`UPDATE candidates SET visa_status=$1, updated_at=NOW() WHERE id=$2`, [stage, req.params.id]);

    await logAudit({
      userId: req.user.id,
      action: "UPDATE_STAGE",
      tableName: "visa_applications",
      recordId: result.rows[0].id,
      oldData,
      newData: result.rows[0],
    });

    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
