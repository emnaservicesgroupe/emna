// Lead -> candidate conversion, candidate pipeline stage and timeline.
//
// convertLead runs in ONE transaction: candidate (+ visa application, as /candidates/add does), lead status
// 'converted' with candidate_id, optional portal login (users + js_candidate_accounts), timeline and audit rows.
// Any failure (duplicate passport, e-mail conflict, ...) rolls everything back. The invite code mail is requested
// only AFTER commit; a mail problem is reported (portal.inviteSent=false) but never undoes the conversion.
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { HttpError } = require("../jobsearch/httpError");
const { assertCandidateAccess } = require("../jobsearch/scope");
const otp = require("../jobsearch/otp");
const { logAudit } = require("../../utils/audit");
const timeline = require("./timeline");
const { loadScoped, inTransaction, hasPerm, parseId } = require("./leadsAdmin");

const db = () => require("../../db");
const STAGES = ["lead", "documents", "submitted", "interview", "visa", "travel", "closed"];
const CANDIDATE_COLUMNS = "id, full_name, nationality, passport_number, email, phone, assigned_to, crm_stage, visa_status, created_at";

function text(v, label, { max, required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `${label} is required`);
    return null;
  }
  if (typeof v !== "string") throw new HttpError(400, `${label} must be a string`);
  const t = v.trim();
  if (!t) {
    if (required) throw new HttpError(400, `${label} is required`);
    return null;
  }
  if (t.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  if (t.includes("\u0000")) throw new HttpError(400, `${label} contains invalid characters`);
  return t;
}

function requirePerms(user) {
  if (!hasPerm(user, "leads:write")) throw new HttpError(403, "Permission denied: leads:write");
  if (!hasPerm(user, "candidates:write")) throw new HttpError(403, "Permission denied: candidates:write");
}

async function convertLead(user, rawLeadId, input) {
  const leadId = parseId(rawLeadId);
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};

  // Unusable password: bcrypt of random bytes that are never stored or shown. Hashed before the transaction
  // so no row lock is held during the slow hash; unused when no user is created.
  const wantsPortal = body.createPortalLogin;
  if (wantsPortal !== undefined && typeof wantsPortal !== "boolean") throw new HttpError(400, "createPortalLogin must be a boolean");
  const unusable = wantsPortal ? await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12) : null;

  const out = await inTransaction(async (client) => {
    const lead = await loadScoped(client, user, leadId, { lock: true }); // foreign lead => 404 before any permission signal
    requirePerms(user);

    if (lead.status === "converted" && lead.candidate_id) {
      // Same checks as a first convert (permissions above, candidate scope here); only a minimal answer is returned.
      await assertCandidateAccess(user, lead.candidate_id);
      const existing = await client.query("SELECT id, full_name, crm_stage FROM candidates WHERE id = $1", [lead.candidate_id]);
      if (existing.rowCount === 0) throw new HttpError(404, "Not found");
      return { candidate: existing.rows[0], created: false };
    }
    if (lead.kind !== "candidate") throw new HttpError(400, "Only candidate leads can be converted");
    if (lead.status === "spam") throw new HttpError(409, "A spam lead cannot be converted");

    const passportRaw = text(body.passport_number, "passport_number", { max: 64, required: true });
    const passport = passportRaw.toUpperCase();
    const fullName = text(body.full_name, "full_name", { max: 200 }) || lead.name;
    const nationality = text(body.nationality, "nationality", { max: 100 });

    let email = null;
    if (wantsPortal) {
      email = otp.normalizeEmail(lead.email);
      if (!email) throw new HttpError(400, "A valid lead email is required for a portal login");
    }

    // Pre-check (the UNIQUE constraint remains the backstop, handled below).
    const dup = await client.query("SELECT 1 FROM candidates WHERE upper(btrim(passport_number)) = $1", [passport]);
    if (dup.rowCount > 0) throw new HttpError(409, "A candidate with this passport number already exists");

    let userId = null;
    if (wantsPortal) {
      const u = await client.query("SELECT id, role, is_active FROM users WHERE lower(email) = $1 FOR UPDATE", [email]);
      if (u.rowCount > 0) {
        const row = u.rows[0];
        if (row.role !== "Candidate") throw new HttpError(409, "A staff user with this email already exists");
        const linked = await client.query("SELECT 1 FROM js_candidate_accounts WHERE user_id = $1", [row.id]);
        if (linked.rowCount > 0) throw new HttpError(409, "This email already has a portal login for another candidate");
        if (!row.is_active) throw new HttpError(409, "A deactivated user with this email already exists");
        userId = row.id;
      }
    }

    const assignedTo = lead.assigned_to || user.id;
    let candidate;
    try {
      const ins = await client.query(
        `INSERT INTO candidates (full_name, nationality, passport_number, email, phone, assigned_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${CANDIDATE_COLUMNS}`,
        [fullName, nationality, passport, lead.email, lead.phone, assignedTo, user.id]
      );
      candidate = ins.rows[0];
      await client.query("INSERT INTO visa_applications (candidate_id, stage, status, updated_by) VALUES ($1,'Documents','Pending',$2)", [candidate.id, user.id]);

      let portal;
      if (wantsPortal) {
        if (userId === null) {
          const nu = await client.query(
            "INSERT INTO users (full_name, email, password, role, is_active) VALUES ($1,$2,$3,'Candidate',true) RETURNING id",
            [fullName, email, unusable]
          );
          userId = nu.rows[0].id;
        }
        await client.query("INSERT INTO js_candidate_accounts (user_id, candidate_id) VALUES ($1,$2)", [userId, candidate.id]);
        portal = { userId };
      }

      await client.query("UPDATE crm_leads SET status = 'converted', candidate_id = $2, updated_at = now() WHERE id = $1", [leadId, candidate.id]);
      await timeline.add(client, {
        entity: "lead",
        entityId: leadId,
        actorId: user.id,
        event: "converted",
        detail: { candidate_id: candidate.id, portal_login: Boolean(wantsPortal), from_status: lead.status },
      });
      await timeline.add(client, { entity: "candidate", entityId: candidate.id, actorId: user.id, event: "created_from_lead", detail: { lead_id: leadId } });
      await logAudit({
        client,
        userId: user.id,
        action: "crm.lead.convert",
        tableName: "crm_leads",
        recordId: String(leadId),
        oldData: { status: lead.status, candidate_id: null },
        newData: { status: "converted", candidate_id: candidate.id, portal_login: Boolean(wantsPortal) },
      });
      return { candidate, created: true, portal, inviteEmail: email };
    } catch (err) {
      if (err && err.code === "23505") {
        const c = String(err.constraint || "");
        if (c.includes("passport")) throw new HttpError(409, "A candidate with this passport number already exists");
        throw new HttpError(409, "Conversion conflicts with an existing record");
      }
      throw err;
    }
  });

  if (out.portal) {
    out.portal.inviteSent = await sendInvite(out.inviteEmail);
    delete out.inviteEmail;
  }
  return out;
}

/** Requests the existing OTP mail after commit. Never throws; true only when a live code was issued (mail accepted). */
async function sendInvite(email) {
  try {
    await otp.requestOtp(email);
    await otp._testing.flush(); // wait for the background issuance so success can be reported honestly
    // issue() expires a code whose mail was not accepted, so a live unused code means the mail went out.
    const r = await db().query(
      "SELECT 1 FROM js_otps WHERE email = $1 AND used_at IS NULL AND expires_at > now() AND created_at > now() - interval '2 minutes' LIMIT 1",
      [email]
    );
    return r.rowCount > 0;
  } catch (err) {
    console.error("Portal invite failed:", (err && (err.code || err.name)) || "unknown");
    return false;
  }
}

async function setStage(user, rawId, stage) {
  if (typeof stage !== "string" || !STAGES.includes(stage)) throw new HttpError(400, `stage must be one of ${STAGES.join(", ")}`);
  await assertCandidateAccess(user, rawId);
  const id = Number(rawId);
  return inTransaction(async (client) => {
    const cur = await client.query("SELECT crm_stage FROM candidates WHERE id = $1 AND is_deleted = false FOR UPDATE", [id]);
    if (cur.rowCount === 0) throw new HttpError(404, "Not found");
    const from = cur.rows[0].crm_stage;
    if (from !== stage) {
      await client.query("UPDATE candidates SET crm_stage = $2, updated_at = now() WHERE id = $1", [id, stage]);
      await timeline.add(client, { entity: "candidate", entityId: id, actorId: user.id, event: "stage_changed", detail: { from, to: stage } });
      await logAudit({
        client,
        userId: user.id,
        action: "crm.candidate.stage",
        tableName: "candidates",
        recordId: String(id),
        oldData: { crm_stage: from },
        newData: { crm_stage: stage },
      });
    }
    return { id, crm_stage: stage };
  });
}

async function getCandidateTimeline(user, rawId) {
  await assertCandidateAccess(user, rawId);
  return timeline.list("candidate", Number(rawId), db());
}

module.exports = { convertLead, setStage, getCandidateTimeline, sendInvite, STAGES };
