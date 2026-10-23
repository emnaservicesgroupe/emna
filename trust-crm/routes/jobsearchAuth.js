// Job-search auth routes (mounted at /jobsearch):
//   POST /auth/otp/request          candidate asks for a sign-in code
//   POST /auth/otp/verify           candidate exchanges the code for a token
//   GET  /auth/me                   current session (any valid token)
//   POST /admin/candidate-accounts  admin creates a Candidate login for a candidate
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcrypt");
const { verifyToken } = require("../middleware/auth");
const { checkPermission } = require("../middleware/role");
const { logAudit } = require("../utils/audit");
const otp = require("../modules/jobsearch/otp");
const { HttpError } = require("../modules/jobsearch/httpError");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");

const router = express.Router();

const GENERIC_REQUEST_RESPONSE = {
  ok: true,
  message: "If an account exists for this email, a sign-in code has been sent.",
};

function body(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

router.post(
  "/auth/otp/request",
  asyncHandler(async (req, res) => {
    const { email } = body(req);
    if (typeof email !== "string" || !email.trim()) throw new HttpError(400, "email is required");
    const limit = otp.checkRequestLimit({ email, ip: req.ip });
    if (!limit.ok) {
      res.set("Retry-After", String(limit.retryAfter));
      throw new HttpError(429, "Too many requests. Please wait before requesting another code.");
    }
    await otp.requestOtp(email);
    return res.json(GENERIC_REQUEST_RESPONSE);
  })
);

router.post(
  "/auth/otp/verify",
  asyncHandler(async (req, res) => {
    const { email, code } = body(req);
    if (typeof email !== "string" || !email.trim() || code === undefined || code === null || code === "") {
      throw new HttpError(400, "email and code are required");
    }
    const limit = otp.checkVerifyLimit({ ip: req.ip });
    if (!limit.ok) {
      res.set("Retry-After", String(limit.retryAfter));
      throw new HttpError(429, "Too many attempts. Please try again later.");
    }
    const { token, role } = await otp.verifyOtp(email, code);
    // Candidate response stays exactly { token } (unchanged contract); portal roles also report their role.
    return res.json(role === "Candidate" ? { token } : { token, role });
  })
);

router.get(
  "/auth/me",
  verifyToken,
  asyncHandler(async (req, res) => {
    const out = { id: req.user.id, role: req.user.role };
    if (req.user.role === "Candidate") {
      const r = await require("../db").query("SELECT candidate_id FROM js_candidate_accounts WHERE user_id = $1", [req.user.id]);
      out.candidate_id = r.rows[0] ? r.rows[0].candidate_id : null;
    }
    return res.json(out);
  })
);

router.post(
  "/admin/candidate-accounts",
  verifyToken,
  checkPermission("jobsearch:admin"),
  asyncHandler(async (req, res) => {
    const { candidate_id: rawCandidateId, email: rawEmail, full_name: rawName } = body(req);
    const candidateId = typeof rawCandidateId === "string" && /^\d+$/.test(rawCandidateId) ? Number(rawCandidateId) : rawCandidateId;
    if (!Number.isSafeInteger(candidateId) || candidateId <= 0) throw new HttpError(400, "candidate_id must be a positive integer");
    const email = otp.normalizeEmail(rawEmail);
    if (!email) throw new HttpError(400, "A valid email is required");
    if (rawName !== undefined && (typeof rawName !== "string" || rawName.trim().length > 200)) {
      throw new HttpError(400, "full_name must be a string of at most 200 characters");
    }

    // Unusable password: bcrypt of 32 random bytes that are never stored or shown.
    const unusablePassword = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
    const db = require("../db");
    const client = await db.connect();
    let created;
    try {
      await client.query("BEGIN");
      const cand = await client.query("SELECT id, full_name FROM candidates WHERE id = $1 AND is_deleted = false FOR UPDATE", [candidateId]);
      if (cand.rowCount === 0) throw new HttpError(404, "Candidate not found");
      const linked = await client.query("SELECT 1 FROM js_candidate_accounts WHERE candidate_id = $1", [candidateId]);
      if (linked.rowCount > 0) throw new HttpError(409, "Candidate already has an account");
      const existing = await client.query("SELECT 1 FROM users WHERE lower(email) = $1", [email]);
      if (existing.rowCount > 0) throw new HttpError(409, "A user with this email already exists");

      const fullName = (rawName && rawName.trim()) || cand.rows[0].full_name;
      const user = await client.query(
        `INSERT INTO users (full_name, email, password, role, is_active)
         VALUES ($1, $2, $3, 'Candidate', true) RETURNING id`,
        [fullName, email, unusablePassword]
      );
      const link = await client.query(
        "INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1, $2) RETURNING id, user_id, candidate_id",
        [user.rows[0].id, candidateId]
      );
      await client.query("UPDATE candidates SET email = $1 WHERE id = $2 AND (email IS NULL OR btrim(email) = '')", [email, candidateId]);
      await client.query("COMMIT");
      created = { id: link.rows[0].id, user_id: link.rows[0].user_id, candidate_id: link.rows[0].candidate_id, email };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err && err.code === "23505") throw new HttpError(409, "Account already exists");
      throw err;
    } finally {
      client.release();
    }

    await logAudit({
      userId: req.user.id,
      action: "CREATE",
      tableName: "js_candidate_accounts",
      recordId: created.id,
      newData: { user_id: created.user_id, candidate_id: created.candidate_id, email: created.email, role: "Candidate" },
    });

    return res.status(201).json({ user_id: created.user_id, candidate_id: created.candidate_id, email: created.email });
  })
);

router.use(jobsearchErrorHandler);

module.exports = router;
