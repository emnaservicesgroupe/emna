const express = require("express");
const candidateModel = require("../models/candidateModel");
const db = require("../db");
const { verifyToken } = require("../middleware/auth");
const { checkPermission, PERMISSIONS } = require("../middleware/role");
const { logAudit } = require("../utils/audit");

const router = express.Router();

// Task 19 (I-2): candidates.assigned_to decides which staff member sees a candidate's job-search data, so
// only users holding users:write (Admin, SuperAdmin) may set or change it, and only they may delete.
const ASSIGN_PERMISSION = "users:write";
function canAssign(user) {
  const perms = (user && PERMISSIONS[user.role]) || [];
  return perms.includes("*") || perms.includes(ASSIGN_PERMISSION);
}
const ASSIGN_DENIED = "Changing assigned_to requires the users:write permission (Admin or SuperAdmin)";
const DELETE_DENIED = "Deleting a candidate requires the users:write permission (Admin or SuperAdmin); staff cannot delete candidates";
function sameUserId(a, b) {
  return String(a) === String(b);
}

// Task 20: assigned_to is a positive integer user id (number or digit string) or null; anything else is 400.
const ASSIGNEE_INVALID = "assigned_to must be a user id (positive integer) or null";
function parseAssignee(v) {
  if (v === null) return { ok: true, value: null };
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return { ok: true, value: v };
  if (typeof v === "string" && /^[1-9]\d{0,9}$/.test(v.trim()) && Number(v.trim()) <= 2147483647) return { ok: true, value: Number(v.trim()) };
  return { ok: false };
}

router.post("/add", verifyToken, checkPermission("candidates:write"), async (req, res) => {
  try {
    const payload = { ...req.body, created_by: req.user.id };
    // '' / null / absent = not supplied (unchanged); anything else must be a valid user id
    if (payload.assigned_to === "" || payload.assigned_to === undefined) payload.assigned_to = null;
    if (payload.assigned_to !== null) {
      const parsed = parseAssignee(payload.assigned_to);
      if (!parsed.ok) return res.status(400).json({ error: ASSIGNEE_INVALID });
      payload.assigned_to = parsed.value;
    }
    // Staff may not assign a new candidate to someone else: a supplied assigned_to is forced to themselves.
    if (!canAssign(req.user) && payload.assigned_to !== null) {
      payload.assigned_to = req.user.id;
    }
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
    if (err && err.code === "23503" && /assigned_to/.test(String(err.constraint || err.detail || ""))) return res.status(400).json({ error: ASSIGNEE_INVALID });
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
    const body = req.body && typeof req.body === "object" ? { ...req.body } : {};
    let clearAssignee = false;
    if (Object.prototype.hasOwnProperty.call(body, "assigned_to")) {
      const parsed = parseAssignee(body.assigned_to);
      if (!parsed.ok) return res.status(400).json({ error: ASSIGNEE_INVALID });
      body.assigned_to = parsed.value;
      // explicit null: an admin unassigns the candidate; for staff it keeps the current value (as before)
      clearAssignee = parsed.value === null && canAssign(req.user);
    }
    req.body = body;
    const oldCandidate = await candidateModel.getCandidateById(req.params.id);
    if (!oldCandidate) return res.status(404).json({ error: "Candidate not found" });
    // The model keeps the current value for null/undefined (??), so only a different non-null value is a change.
    const wanted = req.body ? req.body.assigned_to : undefined;
    if (wanted !== undefined && wanted !== null && !sameUserId(wanted, oldCandidate.assigned_to) && !canAssign(req.user)) {
      return res.status(403).json({ error: ASSIGN_DENIED });
    }

    // Task 20: the assigned_to check is repeated by the model under the row lock (a reassignment that
    // committed after the read above is never overwritten and never compared with a stale snapshot).
    const updated = await candidateModel.updateCandidate(req.params.id, req.body, { canAssign: canAssign(req.user), clearAssignee });
    if (!updated) return res.status(404).json({ error: "Candidate not found" });

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
    if (err && err.code === "ASSIGN_DENIED") return res.status(403).json({ error: ASSIGN_DENIED });
    if (err && err.code === "23503" && /assigned_to/.test(String(err.constraint || err.detail || ""))) return res.status(400).json({ error: ASSIGNEE_INVALID });
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", verifyToken, checkPermission("candidates:write"), async (req, res) => {
  if (!canAssign(req.user)) return res.status(403).json({ error: DELETE_DENIED });
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
