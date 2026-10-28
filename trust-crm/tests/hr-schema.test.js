const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createTestDb } = require("./helpers/db");
const { PERMISSIONS } = require("../middleware/role");

process.env.JWT_SECRET = process.env.JWT_SECRET || "hr-schema-test-secret";

const ROOT = path.join(__dirname, "..");
const SQL018 = () => fs.readFileSync(path.join(ROOT, "sql", "migrations", "018_hr.sql"), "utf8");

async function withDb(fn) {
  const { pool, cleanup } = await createTestDb();
  try {
    await fn(pool);
  } finally {
    await cleanup();
  }
}

// Non-destructive tests share one migrated schema (less schema churn while the whole suite runs in parallel); every
// test uses its own users, so they cannot interfere. Tests that drop constraints or disable triggers use withDb().
let sharedDb = null;
async function withShared(fn) {
  if (!sharedDb) sharedDb = await createTestDb();
  await fn(sharedDb.pool);
}
test.after(async () => {
  if (sharedDb) await sharedDb.cleanup();
});

let seq = 0;
const user = async (pool, role = "Agent", extra = {}) => {
  seq += 1;
  const r = await pool.query("INSERT INTO users (full_name,email,password,role,is_active) VALUES ('U',$1,'h',$2,$3) RETURNING id", [
    `hr${seq}-${process.pid}@test.invalid`,
    role,
    extra.active !== false,
  ]);
  return r.rows[0].id;
};
const att = (pool, uid, inn, out = null, extra = "") =>
  pool.query(`INSERT INTO hr_attendance (user_id, work_date, clock_in, clock_out) VALUES ($1, ($2::timestamptz AT TIME ZONE 'Africa/Tunis')::date, $2, $3) ${extra} RETURNING id`, [uid, inn, out]);
const leaveType = async (pool, code = "annual") =>
  (await pool.query("INSERT INTO hr_leave_types (code,name_ar,name_en,name_fr) VALUES ($1,'a','a','a') RETURNING id", [code + seq++])).rows[0].id;
const leave = (pool, uid, ltid, s, e, status = "pending") =>
  pool.query("INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, days, status) VALUES ($1,$2,$3,$4,1,$5) RETURNING id", [uid, ltid, s, e, status]);

const CHECK = /check constraint/i;
const OVERLAP = (e) => e.code === "23P01";

test("migration 018 is idempotent (re-run applies nothing, re-executing the SQL is safe)", () =>
  withShared(async (pool) => {
    const { runMigrations } = require("../scripts/migrate");
    assert.deepEqual(await runMigrations(pool), []);
    await pool.query(SQL018());
    await pool.query(SQL018());
    assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE name='018_hr.sql'")).rowCount, 1);
    for (const t of ["hr_employees", "hr_schedules", "hr_holidays", "hr_attendance", "hr_attendance_corrections", "hr_leave_types", "hr_leave_balances", "hr_leave_requests"]) {
      assert.ok((await pool.query("SELECT to_regclass($1) AS t", [t])).rows[0].t, `${t} exists`);
    }
    // re-running must not duplicate triggers
    const trg = await pool.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('hr_attendance'::regclass, 'hr_leave_requests'::regclass)");
    assert.deepEqual(trg.rows.map((r) => r.tgname).sort(), ["hr_attendance_no_overlap_trg", "hr_leave_no_overlap_trg"]);
  }));

test("hr_employees constraints: status, dates, self-manager, unique employee_no, schedule FK", () =>
  withShared(async (pool) => {
    const u1 = await user(pool);
    const u2 = await user(pool);
    const ins = (uid, cols, vals) => pool.query(`INSERT INTO hr_employees (user_id ${cols}) VALUES ($1 ${vals})`, [uid]);
    await ins(u1, ", employee_no, status", ", 'E1', 'active'");
    await assert.rejects(ins(u2, ", employee_no", ", 'E1'"), /duplicate key|unique/i);
    await ins(u2, ", employee_no", ", NULL");
    const u3 = await user(pool);
    await ins(u3, ", employee_no", ", NULL"); // NULL employee_no is not unique-constrained
    const u4 = await user(pool);
    await assert.rejects(ins(u4, ", status", ", 'fired'"), CHECK);
    await assert.rejects(ins(u4, ", hire_date, end_date", ", '2025-05-02', '2025-05-01'"), CHECK);
    await assert.rejects(ins(u4, ", manager_user_id", `, ${u4}`), CHECK);
    await assert.rejects(ins(u4, ", schedule_id", ", 999999"), /foreign key/i);
    await ins(u4, ", manager_user_id", `, ${u1}`);
    // deleting the manager's user keeps the employee (manager cleared)
    await pool.query("DELETE FROM users WHERE id=$1", [u1]);
    assert.equal((await pool.query("SELECT manager_user_id FROM hr_employees WHERE user_id=$1", [u4])).rows[0].manager_user_id, null);
  }));

test("hr_schedules: weekly shape, break minutes, grace and name constraints", () =>
  withShared(async (pool) => {
    const ins = (weekly, grace = 10, name = "S") =>
      pool.query("INSERT INTO hr_schedules (name, weekly, grace_minutes) VALUES ($1,$2::jsonb,$3) RETURNING id, timezone", [name, JSON.stringify(weekly), grace]);
    const ok = await ins({ mon: { start: "09:00", end: "17:30", break_minutes: 60 }, sat: null });
    assert.equal(ok.rows[0].timezone, "Africa/Tunis");
    await ins({});
    await assert.rejects(ins({ mon: { start: "09:00", end: "17:30", break_minutes: -5 } }), CHECK);
    await assert.rejects(ins({ mon: { start: "09:00", end: "17:30", break_minutes: 1.5 } }), CHECK);
    await assert.rejects(ins({ mon: { start: "09:00", end: "17:30", break_minutes: 2000 } }), CHECK);
    await assert.rejects(ins({ mon: { start: "9:00", end: "17:30", break_minutes: 0 } }), CHECK);
    await assert.rejects(ins({ mon: { start: "25:00", end: "26:30", break_minutes: 0 } }), CHECK);
    await assert.rejects(ins({ mon: { start: "17:00", end: "09:00", break_minutes: 0 } }), CHECK);
    await assert.rejects(ins({ funday: { start: "09:00", end: "17:00", break_minutes: 0 } }), CHECK);
    await assert.rejects(ins({ mon: "09:00" }), CHECK);
    await assert.rejects(pool.query("INSERT INTO hr_schedules (name, weekly) VALUES ('S','[]')"), CHECK);
    await assert.rejects(ins({}, -1), CHECK);
    await assert.rejects(ins({}, 10, ""), CHECK);
    await assert.rejects(ins({}, 10, "   "), CHECK);
    // an employee's schedule can be removed: the employee keeps the row, schedule_id cleared
    const u = await user(pool);
    await pool.query("INSERT INTO hr_employees (user_id, schedule_id) VALUES ($1,$2)", [u, ok.rows[0].id]);
    await pool.query("DELETE FROM hr_schedules WHERE id=$1", [ok.rows[0].id]);
    assert.equal((await pool.query("SELECT schedule_id FROM hr_employees WHERE user_id=$1", [u])).rows[0].schedule_id, null);
  }));

test("hr_holidays: one per day, name required", () =>
  withShared(async (pool) => {
    await pool.query("INSERT INTO hr_holidays (day, name) VALUES ('2026-01-01','New Year')");
    await assert.rejects(pool.query("INSERT INTO hr_holidays (day, name) VALUES ('2026-01-01','Again')"), /duplicate key|unique/i);
    await assert.rejects(pool.query("INSERT INTO hr_holidays (day, name) VALUES ('2026-01-02','')"), CHECK);
  }));

test("hr_leave_types: unique code, names required", () =>
  withShared(async (pool) => {
    const ins = (code, ar = "a", en = "a", fr = "a") => pool.query("INSERT INTO hr_leave_types (code,name_ar,name_en,name_fr) VALUES ($1,$2,$3,$4) RETURNING requires_approval, active", [code, ar, en, fr]);
    const r = await ins("annual");
    assert.equal(r.rows[0].requires_approval, true);
    assert.equal(r.rows[0].active, true);
    await assert.rejects(ins("annual"), /duplicate key|unique/i);
    await assert.rejects(ins("x", ""), CHECK);
    await assert.rejects(ins("", "a"), CHECK);
  }));

test("hr_leave_balances: unique (user, type, year), non-negative entitlement, sane year", () =>
  withShared(async (pool) => {
    const u = await user(pool);
    const lt = await leaveType(pool);
    const ins = (y, ent = 20, adj = 0) => pool.query("INSERT INTO hr_leave_balances (user_id, leave_type_id, year, entitled_days, adjusted_days) VALUES ($1,$2,$3,$4,$5)", [u, lt, y, ent, adj]);
    await ins(2026);
    await assert.rejects(ins(2026), (e) => e.code === "23505");
    await ins(2027, 20, -2.5); // adjustments may be negative
    await assert.rejects(ins(2028, -1), CHECK);
    await assert.rejects(ins(1850), CHECK);
    const lt2 = await leaveType(pool);
    await pool.query("INSERT INTO hr_leave_balances (user_id, leave_type_id, year, entitled_days) VALUES ($1,$2,2026,5)", [u, lt2]); // other type, same year
    // deleting a leave type that has balances is refused (history is not silently lost)
    await assert.rejects(pool.query("DELETE FROM hr_leave_types WHERE id=$1", [lt]), /foreign key/i);
  }));

test("hr_attendance: clock_out must be after clock_in, source and note constraints", () =>
  withShared(async (pool) => {
    const u = await user(pool);
    await att(pool, u, "2026-03-02T08:00:00Z", "2026-03-02T16:00:00Z");
    await assert.rejects(att(pool, u, "2026-03-03T08:00:00Z", "2026-03-03T07:00:00Z"), CHECK);
    await assert.rejects(att(pool, u, "2026-03-03T08:00:00Z", "2026-03-03T08:00:00Z"), CHECK); // zero length
    await assert.rejects(pool.query("INSERT INTO hr_attendance (user_id, work_date, clock_in, source) VALUES ($1,'2026-03-04','2026-03-04T08:00:00Z','manual')", [u]), CHECK);
    const r = await pool.query("INSERT INTO hr_attendance (user_id, work_date, clock_in) VALUES ($1,'2026-03-05','2026-03-05T08:00:00Z') RETURNING source", [u]);
    assert.equal(r.rows[0].source, "clock");
  }));

test("partial unique index: at most one open attendance session per user", () =>
  withDb(async (pool) => {
    const a = await user(pool);
    const b = await user(pool);
    await att(pool, a, "2026-03-02T08:00:00Z");
    await assert.rejects(att(pool, a, "2026-03-02T09:00:00Z"), (e) => e.code === "23505" || OVERLAP(e));
    // exactly the unique index is what protects it when overlap protection is bypassed
    await pool.query("ALTER TABLE hr_attendance DISABLE TRIGGER hr_attendance_no_overlap_trg");
    const ex = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='hr_attendance'::regclass AND contype='x'");
    for (const c of ex.rows) await pool.query(`ALTER TABLE hr_attendance DROP CONSTRAINT "${c.conname}"`);
    await assert.rejects(att(pool, a, "2026-03-01T09:00:00Z"), (e) => e.code === "23505" && /hr_attendance_one_open_uq/.test(e.constraint || e.message));
    await att(pool, b, "2026-03-02T08:00:00Z"); // another user is independent
    // a closed session does not count as open
    await pool.query("UPDATE hr_attendance SET clock_out='2026-03-02T16:00:00Z' WHERE user_id=$1", [a]);
    await att(pool, a, "2026-03-03T08:00:00Z");
  }));

test("attendance overlap trigger: blocks overlaps (incl. open sessions), allows adjacent and other users, ignores self on update", () =>
  withShared(async (pool) => {
    const a = await user(pool);
    const b = await user(pool);
    await att(pool, a, "2026-03-02T08:00:00Z", "2026-03-02T12:00:00Z");
    // overlaps: partial, contained, containing, same
    await assert.rejects(att(pool, a, "2026-03-02T11:00:00Z", "2026-03-02T13:00:00Z"), OVERLAP);
    await assert.rejects(att(pool, a, "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z"), OVERLAP);
    await assert.rejects(att(pool, a, "2026-03-02T07:00:00Z", "2026-03-02T13:00:00Z"), OVERLAP);
    await assert.rejects(att(pool, a, "2026-03-02T08:00:00Z", "2026-03-02T12:00:00Z"), OVERLAP);
    // an open session starting inside, or before, an existing interval overlaps it (ends at infinity)
    await assert.rejects(att(pool, a, "2026-03-02T10:00:00Z"), OVERLAP);
    await assert.rejects(att(pool, a, "2026-03-02T07:00:00Z"), OVERLAP);
    // adjacent intervals (touching endpoints) are fine, both sides
    await att(pool, a, "2026-03-02T12:00:00Z", "2026-03-02T14:00:00Z");
    await att(pool, a, "2026-03-02T06:00:00Z", "2026-03-02T08:00:00Z");
    // a different user may overlap in time
    await att(pool, b, "2026-03-02T08:00:00Z", "2026-03-02T12:00:00Z");
    // open session after everything is fine; then nothing later may start (open extends to infinity)
    await att(pool, a, "2026-03-02T15:00:00Z");
    await assert.rejects(att(pool, a, "2026-03-09T08:00:00Z", "2026-03-09T09:00:00Z"), OVERLAP);
    // a correction-sourced row is held to the same rule
    const cid = (await pool.query("INSERT INTO hr_attendance_corrections (user_id, work_date, requested_in, requested_out, reason) VALUES ($1,'2026-03-02','2026-03-02T09:00:00Z','2026-03-02T10:00:00Z','forgot') RETURNING id", [a])).rows[0].id;
    await assert.rejects(
      pool.query("INSERT INTO hr_attendance (user_id, work_date, clock_in, clock_out, source, correction_id) VALUES ($1,'2026-03-02','2026-03-02T09:00:00Z','2026-03-02T10:00:00Z','correction',$2)", [a, cid]),
      OVERLAP
    );
    // updates: closing the open session is fine (does not collide with itself); extending into another interval is not
    const open = (await pool.query("SELECT id FROM hr_attendance WHERE user_id=$1 AND clock_out IS NULL", [a])).rows[0].id;
    await pool.query("UPDATE hr_attendance SET clock_out='2026-03-02T16:00:00Z' WHERE id=$1", [open]);
    await assert.rejects(pool.query("UPDATE hr_attendance SET clock_out='2026-03-02T11:00:00Z' WHERE id=$1", [open]), (e) => OVERLAP(e) || CHECK.test(e.message));
    const one = (await pool.query("SELECT id FROM hr_attendance WHERE user_id=$1 AND clock_in='2026-03-02T06:00:00Z'", [a])).rows[0].id;
    await assert.rejects(pool.query("UPDATE hr_attendance SET clock_out='2026-03-02T09:00:00Z' WHERE id=$1", [one]), OVERLAP);
    await pool.query("UPDATE hr_attendance SET note='fine' WHERE id=$1", [one]);
  }));

test("attendance overlap: two concurrent transactions for one user cannot both insert overlapping intervals", () =>
  withShared(async (pool) => {
    const u = await user(pool);
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const q = (c) => c.query("INSERT INTO hr_attendance (user_id, work_date, clock_in, clock_out) VALUES ($1,'2026-03-02','2026-03-02T08:00:00Z','2026-03-02T12:00:00Z')", [u]);
      await c1.query("BEGIN");
      await c2.query("BEGIN");
      await q(c1);
      const second = q(c2).then(() => "ok", (e) => e);
      await new Promise((r) => setTimeout(r, 150)); // c2 is now waiting on the per-user lock
      await c1.query("COMMIT");
      const res = await second;
      assert.ok(res && res.code && (res.code === "23P01" || res.code === "23505"), "second insert refused");
      await c2.query("ROLLBACK");
    } finally {
      c1.release();
      c2.release();
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM hr_attendance WHERE user_id=$1", [u])).rows[0].n, 1);
  }));

test("attendance overlap protection is identical without btree_gist: trigger alone, constraint alone", () =>
  withDb(async (pool) => {
    const u = await user(pool);
    const excl = (await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='hr_attendance'::regclass AND contype='x'")).rows;
    // (a) trigger path only: drop the exclusion constraint (what a database without btree_gist looks like)
    for (const c of excl) await pool.query(`ALTER TABLE hr_attendance DROP CONSTRAINT "${c.conname}"`);
    await att(pool, u, "2026-04-01T08:00:00Z", "2026-04-01T12:00:00Z");
    await assert.rejects(att(pool, u, "2026-04-01T11:00:00Z", "2026-04-01T13:00:00Z"), (e) => OVERLAP(e) && /hr_attendance_no_overlap/.test(e.constraint || e.message));
    await att(pool, u, "2026-04-01T12:00:00Z", "2026-04-01T13:00:00Z");
    await pool.query("DELETE FROM hr_attendance WHERE user_id=$1", [u]);
    // (b) constraint path only (when the extension exists): disable the trigger, the exclusion constraint answers alike
    if (excl.length) {
      await pool.query(`ALTER TABLE hr_attendance ADD CONSTRAINT hr_attendance_no_overlap EXCLUDE USING gist (user_id WITH =, tstzrange(clock_in, COALESCE(clock_out, 'infinity'::timestamptz), '[)') WITH &&)`);
      await pool.query("ALTER TABLE hr_attendance DISABLE TRIGGER hr_attendance_no_overlap_trg");
      await att(pool, u, "2026-04-01T08:00:00Z", "2026-04-01T12:00:00Z");
      await assert.rejects(att(pool, u, "2026-04-01T11:00:00Z", "2026-04-01T13:00:00Z"), OVERLAP);
      await assert.rejects(att(pool, u, "2026-04-01T11:00:00Z"), OVERLAP);
      await att(pool, u, "2026-04-01T12:00:00Z", "2026-04-01T13:00:00Z");
    }
  }));

test("the migration installs the exclusion constraint when btree_gist is available (and the test db has it)", () =>
  withShared(async (pool) => {
    const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname='btree_gist'");
    const excl = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='hr_attendance'::regclass AND contype='x'");
    assert.equal(excl.rowCount > 0, ext.rowCount > 0, "constraint present iff extension present");
  }));

test("hr_leave_requests: status, date order, days, reason constraints, defaults", () =>
  withShared(async (pool) => {
    const u = await user(pool);
    const lt = await leaveType(pool);
    const r = await leave(pool, u, lt, "2026-05-04", "2026-05-04");
    const row = (await pool.query("SELECT status, half_day_start, half_day_end FROM hr_leave_requests WHERE id=$1", [r.rows[0].id])).rows[0];
    assert.deepEqual(row, { status: "pending", half_day_start: false, half_day_end: false });
    await assert.rejects(leave(pool, u, lt, "2026-06-10", "2026-06-09"), CHECK);
    await assert.rejects(leave(pool, u, lt, "2026-06-10", "2026-06-11", "done"), CHECK);
    await assert.rejects(pool.query("INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, days) VALUES ($1,$2,'2026-07-01','2026-07-01',-1)", [u, lt]), CHECK);
    await assert.rejects(pool.query("INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, days) VALUES ($1,$2,'2026-07-01','2026-07-01',100000)", [u, lt]), /numeric field overflow|check/i);
    await assert.rejects(pool.query("INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, days, status, decided_at) VALUES ($1,$2,'2026-07-01','2026-07-01',1,'pending',now())", [u, lt]), CHECK);
    await assert.rejects(leave(pool, u, 999999, "2026-08-01", "2026-08-01"), /foreign key/i);
  }));

test("leave overlap trigger: pending/approved of one user may not overlap; adjacent, rejected, cancelled and other users may", () =>
  withShared(async (pool) => {
    const a = await user(pool);
    const b = await user(pool);
    const lt = await leaveType(pool);
    await leave(pool, a, lt, "2026-05-04", "2026-05-08", "approved");
    for (const [s, e] of [["2026-05-08", "2026-05-12"], ["2026-05-01", "2026-05-04"], ["2026-05-05", "2026-05-06"], ["2026-05-01", "2026-05-31"], ["2026-05-04", "2026-05-08"]]) {
      await assert.rejects(leave(pool, a, lt, s, e, "pending"), (er) => OVERLAP(er) && /hr_leave_no_overlap/.test(er.constraint || er.message), `${s}..${e} overlaps`);
    }
    // adjacent days are fine
    await leave(pool, a, lt, "2026-05-09", "2026-05-10", "pending");
    await leave(pool, a, lt, "2026-05-01", "2026-05-03", "approved");
    // other user, other type: independent per user (any type overlaps for the same user)
    await leave(pool, b, lt, "2026-05-04", "2026-05-08", "approved");
    const lt2 = await leaveType(pool);
    await assert.rejects(leave(pool, a, lt2, "2026-05-05", "2026-05-05", "pending"), OVERLAP);
    // rejected / cancelled rows are not blocked and do not block
    await leave(pool, a, lt, "2026-05-05", "2026-05-06", "rejected");
    await leave(pool, a, lt, "2026-05-05", "2026-05-06", "cancelled");
    // status transitions: re-activating a cancelled request that now overlaps is refused; cancelling frees the range
    const cancelled = (await pool.query("SELECT id FROM hr_leave_requests WHERE user_id=$1 AND status='cancelled'", [a])).rows[0].id;
    await assert.rejects(pool.query("UPDATE hr_leave_requests SET status='pending' WHERE id=$1", [cancelled]), OVERLAP);
    const approved = (await pool.query("SELECT id FROM hr_leave_requests WHERE user_id=$1 AND start_date='2026-05-04'", [a])).rows[0].id;
    await pool.query("UPDATE hr_leave_requests SET reason='x' WHERE id=$1", [approved]); // does not collide with itself
    await pool.query("UPDATE hr_leave_requests SET status='cancelled', decided_at=now() WHERE id=$1", [approved]);
    await leave(pool, a, lt, "2026-05-04", "2026-05-08", "pending");
  }));

test("leave overlap protection is identical without btree_gist (trigger alone)", () =>
  withDb(async (pool) => {
    const u = await user(pool);
    const lt = await leaveType(pool);
    const excl = (await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='hr_leave_requests'::regclass AND contype='x'")).rows;
    for (const c of excl) await pool.query(`ALTER TABLE hr_leave_requests DROP CONSTRAINT "${c.conname}"`);
    await leave(pool, u, lt, "2026-09-01", "2026-09-03", "pending");
    await assert.rejects(leave(pool, u, lt, "2026-09-03", "2026-09-04", "approved"), OVERLAP);
    await leave(pool, u, lt, "2026-09-04", "2026-09-04", "approved");
    if (excl.length) {
      await pool.query("DROP TRIGGER hr_leave_no_overlap_trg ON hr_leave_requests");
      await pool.query(`ALTER TABLE hr_leave_requests ADD CONSTRAINT hr_leave_no_overlap EXCLUDE USING gist (user_id WITH =, daterange(start_date, end_date, '[]') WITH &&) WHERE (status IN ('pending','approved'))`);
      await assert.rejects(leave(pool, u, lt, "2026-09-01", "2026-09-01", "pending"), OVERLAP);
      await leave(pool, u, lt, "2026-09-05", "2026-09-05", "pending");
    }
  }));

test("hr_attendance_corrections: status, order, reason, pending has no decision time", () =>
  withShared(async (pool) => {
    const u = await user(pool);
    const ins = (cols, vals) => pool.query(`INSERT INTO hr_attendance_corrections (user_id, work_date, requested_in, reason ${cols}) VALUES ($1,'2026-03-02','2026-03-02T08:00:00Z','why' ${vals})`, [u]);
    await ins("", "");
    await ins(", requested_out", ", '2026-03-02T16:00:00Z'");
    await assert.rejects(ins(", requested_out", ", '2026-03-02T07:00:00Z'"), CHECK);
    await assert.rejects(ins(", status", ", 'maybe'"), CHECK);
    await assert.rejects(ins(", decided_at", ", now()"), CHECK);
    await assert.rejects(pool.query("INSERT INTO hr_attendance_corrections (user_id, work_date, requested_in, reason) VALUES ($1,'2026-03-02','2026-03-02T08:00:00Z','  ')", [u]), CHECK);
  }));

test("attendance created by a correction keeps working if the correction row goes away", () =>
  withShared(async (pool) => {
    const u = await user(pool);
    const cid = (await pool.query("INSERT INTO hr_attendance_corrections (user_id, work_date, requested_in, requested_out, reason) VALUES ($1,'2026-03-02','2026-03-02T08:00:00Z','2026-03-02T16:00:00Z','r') RETURNING id", [u])).rows[0].id;
    await pool.query("INSERT INTO hr_attendance (user_id, work_date, clock_in, clock_out, source, correction_id) VALUES ($1,'2026-03-02','2026-03-02T08:00:00Z','2026-03-02T16:00:00Z','correction',$2)", [u, cid]);
    await pool.query("DELETE FROM hr_attendance_corrections WHERE id=$1", [cid]);
    const r = await pool.query("SELECT correction_id FROM hr_attendance WHERE user_id=$1", [u]);
    assert.equal(r.rows[0].correction_id, null);
  }));

test("indexes exist for FK and filter columns", () =>
  withShared(async (pool) => {
    const idx = (await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename LIKE 'hr\\_%'")).rows.map((r) => r.indexname);
    for (const n of [
      "hr_attendance_one_open_uq",
      "hr_attendance_user_date_idx",
      "hr_attendance_work_date_idx",
      "hr_corrections_user_idx",
      "hr_corrections_status_idx",
      "hr_leave_requests_user_idx",
      "hr_leave_requests_status_idx",
      "hr_leave_requests_type_idx",
      "hr_leave_balances_type_idx",
      "hr_employees_manager_idx",
      "hr_employees_schedule_idx",
      "hr_employees_no_uq",
    ]) {
      assert.ok(idx.includes(n), `index ${n}`);
    }
  }));

test("deleting a user removes their HR rows (no orphaned personal data)", () =>
  withShared(async (pool) => {
    const u = await user(pool);
    const lt = await leaveType(pool);
    await pool.query("INSERT INTO hr_employees (user_id) VALUES ($1)", [u]);
    await att(pool, u, "2026-03-02T08:00:00Z", "2026-03-02T16:00:00Z");
    await leave(pool, u, lt, "2026-05-04", "2026-05-05");
    await pool.query("INSERT INTO hr_leave_balances (user_id, leave_type_id, year, entitled_days) VALUES ($1,$2,2026,10)", [u, lt]);
    await pool.query("DELETE FROM users WHERE id=$1", [u]);
    for (const t of ["hr_employees", "hr_attendance", "hr_leave_requests", "hr_leave_balances"]) {
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id=$1`, [u])).rows[0].n, 0, t);
    }
  }));

// ------------------------------------------------------------------ permissions

test("hr:* permission matrix is exact", () => {
  const holders = (p) => Object.entries(PERMISSIONS).filter(([, v]) => v.includes(p)).map(([k]) => k).sort();
  assert.deepEqual(holders("hr:read"), ["Admin", "HR"]);
  assert.deepEqual(holders("hr:write"), ["Admin", "HR"]);
  assert.deepEqual(holders("hr:approve"), ["Admin", "HR", "Manager"]);
  assert.deepEqual(PERMISSIONS.SuperAdmin, ["*"]);
  for (const r of ["Receptionist", "Accountant", "Agent", "Candidate", "Employer", "Agency"]) {
    assert.ok(!PERMISSIONS[r].some((p) => p.startsWith("hr:")), `${r} holds no hr:*`);
  }
  assert.ok(!PERMISSIONS.Manager.includes("hr:read") && !PERMISSIONS.Manager.includes("hr:write"));
  const all = [...new Set(Object.values(PERMISSIONS).flat().filter((p) => p.startsWith("hr:")))].sort();
  assert.deepEqual(all, ["hr:approve", "hr:read", "hr:write"]);
});

test("checkPermission enforces hr:* per role", () => {
  const { checkPermission } = require("../middleware/role");
  const run = (role, perm) => {
    let out = "next";
    checkPermission(perm)({ user: { role } }, { status: (c) => ({ json: () => (out = c) }) }, () => (out = "next"));
    return out;
  };
  assert.equal(run("HR", "hr:write"), "next");
  assert.equal(run("SuperAdmin", "hr:approve"), "next");
  assert.equal(run("Manager", "hr:approve"), "next");
  assert.equal(run("Manager", "hr:write"), 403);
  assert.equal(run("Agent", "hr:read"), 403);
  assert.equal(run("Candidate", "hr:approve"), 403);
});

test("SETUP.md hr permission matrix equals PERMISSIONS (docs cannot drift)", () => {
  const doc = fs.readFileSync(path.join(ROOT, "..", "docs", "vita-job-search", "SETUP.md"), "utf8");
  const m = /<!-- hr-permission-matrix:start -->([\s\S]*?)<!-- hr-permission-matrix:end -->/.exec(doc);
  assert.ok(m, "SETUP.md has the hr-permission-matrix block");
  const lines = m[1].trim().split("\n").filter((l) => l.startsWith("|"));
  const header = lines[0].split("|").map((c) => c.trim()).filter(Boolean);
  const perms = header.slice(1).filter((h) => /^[a-z]+:[a-z]+$/.test(h));
  assert.deepEqual(perms, ["hr:read", "hr:write", "hr:approve"]);
  const allHr = [...new Set(Object.values(PERMISSIONS).flat().filter((p) => p.startsWith("hr:")))].sort();
  assert.deepEqual(allHr, [...perms].sort(), "every hr:* grant in code is a documented column");
  const seen = new Set();
  for (const line of lines.slice(2)) {
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const role = cells[0];
    seen.add(role);
    assert.ok(PERMISSIONS[role], `documented role ${role} exists`);
    perms.forEach((p, i) => {
      const has = PERMISSIONS[role].includes("*") || PERMISSIONS[role].includes(p);
      assert.ok(["✓", "—"].includes(cells[i + 1]), `${role} ${p}: cell must be ✓ or —`);
      assert.equal(cells[i + 1] === "✓", has, `${role} ${p}: doc says ${cells[i + 1]}, code says ${has}`);
    });
  }
  assert.deepEqual([...seen].sort(), Object.keys(PERMISSIONS).sort(), "every role is documented");
});

// ------------------------------------------------------------------ requireStaff

test("requireStaff: active staff roles pass; Candidate/Employer/Agency 403; deactivated, role-changed, unknown and anonymous refused", async () => {
  const { pool, cleanup } = await createTestDb();
  try {
    require("../db").setPool(pool);
    const { requireStaff, STAFF_ROLES } = require("../middleware/staff");
    assert.deepEqual([...STAFF_ROLES].sort(), ["Accountant", "Admin", "Agent", "HR", "Manager", "Receptionist", "SuperAdmin"]);

    const call = (token) =>
      new Promise((resolve) => {
        const req = { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } };
        const res = {
          status(c) {
            this.code = c;
            return this;
          },
          json(b) {
            resolve({ code: this.code, body: b, user: req.user });
          },
        };
        requireStaff(req, res, () => resolve({ code: "next", user: req.user }));
      });
    const sign = (id, role, tv) => jwt.sign({ id, role, ...(tv === undefined ? {} : { tv }) }, process.env.JWT_SECRET, { expiresIn: "1h" });

    // every staff role, legacy token (no tv) and versioned token
    for (const role of ["SuperAdmin", "Admin", "Manager", "Receptionist", "Accountant", "HR", "Agent"]) {
      const id = await user(pool, role);
      const legacy = await call(sign(id, role));
      assert.equal(legacy.code, "next", `${role} legacy token`);
      assert.equal(legacy.user.id, id);
      const tv = (await pool.query("SELECT token_version FROM users WHERE id=$1", [id])).rows[0].token_version;
      assert.equal((await call(sign(id, role, tv))).code, "next", `${role} versioned token`);
    }

    // portal / candidate roles: 403 (org-linked portal users carry tv, as in the real login)
    const cand = await pool.query("INSERT INTO users (full_name,email,password,role,is_active) VALUES ('C',$1,'h','Candidate',true) RETURNING id, token_version", [`c-${process.pid}@test.invalid`]);
    assert.equal((await call(sign(cand.rows[0].id, "Candidate", cand.rows[0].token_version))).code, 403);
    const { createEmployerUser, createAgencyUser } = require("./helpers/orgs");
    const emp = await createEmployerUser(pool);
    const ag = await createAgencyUser(pool);
    assert.equal((await call(emp.token)).code, 403);
    assert.equal((await call(ag.token)).code, 403);
    // a portal/candidate token without tv never reaches the handler either (verifyToken refuses it)
    const noTv = await call(sign(cand.rows[0].id, "Candidate"));
    assert.ok([401, 403].includes(noTv.code));

    // anonymous / garbage
    assert.equal((await call(undefined)).code, 401);
    assert.equal((await call("not-a-token")).code, 400);

    // deactivated staff: a still-valid LEGACY token (no tv) must stop working immediately
    const dead = await user(pool, "Agent", { active: false });
    const r = await call(sign(dead, "Agent"));
    assert.equal(r.code, 401);
    const gone = await call(sign(987654321, "Agent"));
    assert.equal(gone.code, 401);
    // deactivated after issue
    const later = await user(pool, "Manager");
    assert.equal((await call(sign(later, "Manager"))).code, "next");
    await pool.query("UPDATE users SET is_active=false WHERE id=$1", [later]);
    assert.equal((await call(sign(later, "Manager"))).code, 401);
    assert.equal((await call(sign(later, "Manager", 0))).code, 401);

    // a token claiming a staff role the account no longer has (demoted to Candidate) is refused
    const demoted = await user(pool, "Admin");
    const stale = sign(demoted, "Admin");
    await pool.query("UPDATE users SET role='Candidate' WHERE id=$1", [demoted]);
    assert.ok([401, 403].includes((await call(stale)).code));
    // a revoked versioned token is refused
    const rev = await user(pool, "HR");
    const old = sign(rev, "HR", 0);
    assert.equal((await call(old)).code, "next");
    await pool.query("UPDATE users SET token_version = token_version + 1 WHERE id=$1", [rev]);
    assert.equal((await call(old)).code, 401);
  } finally {
    await cleanup();
  }
});

test("migration 020: idempotent, adds the stored year split, backfills rows exactly like the live computation, keeps parts consistent", () =>
  withShared(async (pool) => {
    const sql = fs.readFileSync(path.join(ROOT, "sql", "migrations", "020_hr_leave_year_split.sql"), "utf8");
    assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE name='020_hr_leave_year_split.sql'")).rowCount, 1);
    const cols = await pool.query("SELECT column_name, is_nullable, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='hr_leave_requests' AND column_name LIKE 'days_year_%' ORDER BY 1");
    assert.deepEqual(cols.rows.map((r) => [r.column_name, r.is_nullable, r.numeric_precision, r.numeric_scale]), [["days_year_end", "YES", 6, 2], ["days_year_start", "YES", 6, 2]]);
    const u = await user(pool);
    const lt = await leaveType(pool);
    // a legacy cross-year row (default Mon-Fri; 28 Dec 2026 is a Monday: 4 working days in 2026) and a same-year one, both without stored parts
    const cross = (await pool.query("INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, days) VALUES ($1,$2,'2026-12-28','2027-01-08',10) RETURNING id", [u, lt])).rows[0].id;
    const half = (await pool.query("INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, days, half_day_start, status) VALUES ($1,$2,'2027-12-27','2028-01-04',5.5,true,'approved') RETURNING id", [u, lt])).rows[0].id;
    const same = (await pool.query("INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, days) VALUES ($1,$2,'2026-06-01','2026-06-03',3) RETURNING id", [u, lt])).rows[0].id;
    await pool.query(sql);
    await pool.query(sql);
    const get = async (id) => (await pool.query("SELECT days_year_start::text AS s, days_year_end::text AS e FROM hr_leave_requests WHERE id=$1", [id])).rows[0];
    assert.deepEqual(await get(cross), { s: "4.00", e: "6.00" });
    assert.deepEqual(await get(half), { s: "4.50", e: "1.00" }, "27-31 Dec 2027 = 5 working days minus the half day");
    assert.deepEqual(await get(same), { s: "3.00", e: "0.00" });
    // one constraint: both or neither, never summing to something else
    await assert.rejects(pool.query("UPDATE hr_leave_requests SET days_year_start = 1, days_year_end = 1 WHERE id=$1", [cross]), CHECK);
    await assert.rejects(pool.query("UPDATE hr_leave_requests SET days_year_start = 10 WHERE id=$1", [cross]), CHECK);
    assert.equal((await pool.query("SELECT 1 FROM pg_constraint WHERE conname='hr_leave_year_split_check' AND conrelid=to_regclass('hr_leave_requests')")).rowCount, 1);
  }));
