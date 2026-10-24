const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { createTestDb } = require("./helpers/db");
const { PERMISSIONS } = require("../middleware/role");

const ROOT = path.join(__dirname, "..");
const MIG = path.join(ROOT, "sql", "migrations");
const SQL016 = () => fs.readFileSync(path.join(MIG, "016_accounting.sql"), "utf8");
const SQL017 = () => fs.readFileSync(path.join(MIG, "017_accounting_fixes.sql"), "utf8");

async function withDb(fn) {
  const { pool, cleanup } = await createTestDb();
  try {
    await fn(pool);
  } finally {
    await cleanup();
  }
}

const cand = async (pool, n = "1") =>
  (await pool.query("INSERT INTO candidates (full_name, passport_number) VALUES ('C',$1) RETURNING id", ["P" + n + crypto.randomBytes(3).toString("hex")])).rows[0].id;
const inv = async (pool, cid, extra = "") =>
  (await pool.query(`INSERT INTO invoices (candidate_id,total_amount,remaining_amount) VALUES ($1,100,100) ${extra} RETURNING id`, [cid])).rows[0].id;
const pay = (pool, iid, cid, method = "cash", cols = "", vals = "") =>
  pool.query(`INSERT INTO payments (invoice_id,candidate_id,amount_paid,payment_method${cols}) VALUES ($1,$2,10,$3${vals}) RETURNING id`, [iid, cid, method]);

test("migration 016 is idempotent (re-run applies nothing, re-executing the SQL is safe)", () =>
  withDb(async (pool) => {
    const { runMigrations } = require("../scripts/migrate");
    assert.deepEqual(await runMigrations(pool), []);
    await pool.query(SQL016());
    await pool.query(SQL016());
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE name='016_accounting.sql'");
    assert.equal(r.rowCount, 1);
  }));

test("new tables exist and new columns on legacy tables are nullable (additive)", () =>
  withDb(async (pool) => {
    for (const t of ["fin_services", "invoice_items", "fin_refunds", "expense_categories", "fin_ledger", "fin_counters"]) {
      const r = await pool.query("SELECT to_regclass($1) AS t", [t]);
      assert.ok(r.rows[0].t, `${t} exists`);
    }
    const cols = {
      invoices: ["number", "issued_at", "voided_at", "void_reason", "subtotal", "tax_amount"],
      payments: ["receipt_number", "reference", "idempotency_key", "voided_at", "void_reason"],
      expenses: ["category_id", "payee", "voided_at", "void_reason"],
    };
    for (const [t, list] of Object.entries(cols)) {
      for (const c of list) {
        const r = await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name=$2", [t, c]);
        assert.equal(r.rows[0] && r.rows[0].is_nullable, "YES", `${t}.${c} exists and is nullable`);
      }
    }
  }));

test("invoice_items: quantity > 0, unit_price >= 0, line_total computed half-up in SQL", () =>
  withDb(async (pool) => {
    const iid = await inv(pool, await cand(pool));
    const ins = (q, p) => pool.query("INSERT INTO invoice_items (invoice_id,description,quantity,unit_price,position) VALUES ($1,'x',$2,$3,1) RETURNING line_total", [iid, q, p]);
    await assert.rejects(ins("-1", "5"), /check constraint/i);
    await assert.rejects(ins("0", "5"), /check constraint/i);
    await assert.rejects(ins("1", "-0.01"), /check constraint/i);
    assert.equal((await ins("0.50", "0.01")).rows[0].line_total, "0.01"); // 0.005 -> 0.01 half-up
    assert.equal((await ins("3", "0.10")).rows[0].line_total, "0.30");
    assert.equal((await ins("1.10", "0.10")).rows[0].line_total, "0.11");
    await assert.rejects(pool.query("INSERT INTO invoice_items (invoice_id,description,quantity,unit_price,position,line_total) VALUES ($1,'x',1,1,1,99)", [iid]), /generated|cannot insert/i);
    await assert.rejects(pool.query("INSERT INTO invoice_items (invoice_id,description,quantity,unit_price,position) VALUES ($1,'',1,1,1)", [iid]), /check constraint/i);
  }));

test("currency format and amount constraints reject bad values", () =>
  withDb(async (pool) => {
    const svc = (code, cur, price = "10") =>
      pool.query("INSERT INTO fin_services (code,name_en,default_price,currency) VALUES ($1,'n',$2,$3)", [code, price, cur]);
    await svc("A", "TND");
    await assert.rejects(svc("B", "tnd"), /check constraint/i);
    await assert.rejects(svc("C", "TNDX"), /check constraint/i);
    await assert.rejects(svc("D", "T1D"), /check constraint/i);
    await assert.rejects(svc("E", "EUR", "-1"), /check constraint/i);
    await assert.rejects(svc("A", "EUR"), /duplicate key|unique/i);
    const cid = await cand(pool);
    await assert.rejects(pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,currency) VALUES ($1,1,1,'euro')", [cid]), /check constraint/i);
    await assert.rejects(pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,status) VALUES ($1,1,1,'Bogus')", [cid]), /check constraint/i);
    await assert.rejects(pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,tax_amount) VALUES ($1,1,1,-1)", [cid]), /check constraint/i);
    await assert.rejects(pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,voided_at) VALUES ($1,1,1,now())", [cid]), /check constraint/i);
    for (const s of ["Draft", "Pending", "Partial", "Paid", "Void", "Refunded"]) {
      await pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,status,voided_at,void_reason) VALUES ($1,1,1,$2,now(),'r')", [cid, s]);
    }
    await assert.rejects(pool.query("INSERT INTO expenses (title,amount,currency) VALUES ('t',1,'xx')"), /check constraint/i);
  }));

test("payment_method CHECK allows the listed values (and legacy 'cash') and rejects others", () =>
  withDb(async (pool) => {
    const cid = await cand(pool);
    const iid = await inv(pool, cid);
    for (const m of ["cash", "bank_transfer", "card", "mobile", "cheque", "other"]) await pay(pool, iid, cid, m);
    await assert.rejects(pay(pool, iid, cid, "bitcoin"), /check constraint/i);
    await assert.rejects(pay(pool, iid, cid, "Cash"), /check constraint/i);
  }));

test("fin_refunds: amount > 0 and cannot exceed payment net (cumulative)", () =>
  withDb(async (pool) => {
    const cid = await cand(pool);
    const iid = await inv(pool, cid);
    const pid = (await pay(pool, iid, cid)).rows[0].id; // amount_paid 10
    const ref = (amt) => pool.query("INSERT INTO fin_refunds (payment_id,invoice_id,amount,reason) VALUES ($1,$2,$3,'why')", [pid, iid, amt]);
    await assert.rejects(ref("0"), /check constraint/i);
    await assert.rejects(ref("-1"), /check constraint/i);
    await assert.rejects(ref("10.01"), /exceeds|refund/i);
    await ref("4.00");
    await assert.rejects(ref("6.01"), /exceeds|refund/i);
    await ref("6.00");
    await assert.rejects(ref("0.01"), /exceeds|refund/i);
    const pid2 = (await pay(pool, iid, cid)).rows[0].id;
    await assert.rejects(pool.query("INSERT INTO fin_refunds (payment_id,invoice_id,amount,reason) VALUES ($1,$2,1,' ')", [pid2, iid]), /check constraint/i);
  }));

test("expense_categories name unique case-insensitively; expenses link to category", () =>
  withDb(async (pool) => {
    const c = await pool.query("INSERT INTO expense_categories (name) VALUES ('Rent') RETURNING id");
    await assert.rejects(pool.query("INSERT INTO expense_categories (name) VALUES ('rent')"), /duplicate key|unique/i);
    await pool.query("INSERT INTO expenses (title,amount,category_id,payee) VALUES ('t',5,$1,'Landlord')", [c.rows[0].id]);
  }));

test("fin_ledger: constraints; insert-only (UPDATE, DELETE, TRUNCATE blocked); user deletion unaffected", () =>
  withDb(async (pool) => {
    const u = await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('A','a@x.io','h','Accountant') RETURNING id");
    const ins = (kind, cur = "TND", debit = "5", credit = "0") =>
      pool.query("INSERT INTO fin_ledger (kind,ref_table,ref_id,currency,debit,credit,actor_id) VALUES ($1,'invoices',1,$2,$3,$4,$5) RETURNING id", [kind, cur, debit, credit, u.rows[0].id]);
    for (const k of ["invoice", "payment", "refund", "void", "expense"]) await ins(k);
    await assert.rejects(ins("bogus"), /check constraint/i);
    await assert.rejects(ins("invoice", "tnd"), /check constraint/i);
    await assert.rejects(ins("invoice", "TND", "-1"), /check constraint/i);
    await assert.rejects(ins("invoice", "TND", "0", "-1"), /check constraint/i);
    const id = (await ins("invoice")).rows[0].id;
    await assert.rejects(pool.query("UPDATE fin_ledger SET debit=1 WHERE id=$1", [id]), /insert-only/i);
    await assert.rejects(pool.query("UPDATE fin_ledger SET debit=debit"), /insert-only/i);
    await assert.rejects(pool.query("DELETE FROM fin_ledger WHERE id=$1", [id]), /insert-only/i);
    await assert.rejects(pool.query("TRUNCATE fin_ledger"), /insert-only/i);
    // deleting the actor must still work (no FK that would SET NULL = UPDATE the ledger row)
    await pool.query("DELETE FROM users WHERE id=$1", [u.rows[0].id]);
    assert.equal((await pool.query("SELECT count(*)::int n FROM fin_ledger")).rows[0].n, 6);
  }));

test("fin_counters: key unique, value non-negative", () =>
  withDb(async (pool) => {
    await pool.query("INSERT INTO fin_counters (key,value) VALUES ('invoice-2026',1)");
    await assert.rejects(pool.query("INSERT INTO fin_counters (key,value) VALUES ('invoice-2026',2)"), /duplicate key|unique/i);
    await assert.rejects(pool.query("INSERT INTO fin_counters (key,value) VALUES ('x',-1)"), /check constraint/i);
  }));

test("unique indexes: invoice number, receipt number, (invoice_id, idempotency_key); NULLs allowed repeatedly", () =>
  withDb(async (pool) => {
    const cid = await cand(pool);
    await inv(pool, cid);
    await inv(pool, cid);
    await pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,number) VALUES ($1,1,1,'VITA-2026-000001')", [cid]);
    await assert.rejects(pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,number) VALUES ($1,1,1,'VITA-2026-000001')", [cid]), /duplicate key|unique/i);
    const i1 = await inv(pool, cid);
    const i2 = await inv(pool, cid);
    await pay(pool, i1, cid);
    await pay(pool, i1, cid);
    await pay(pool, i1, cid, "cash", ",receipt_number,idempotency_key", ",'R-1','k1'");
    await assert.rejects(pay(pool, i1, cid, "cash", ",receipt_number", ",'R-1'"), /duplicate key|unique/i);
    await assert.rejects(pay(pool, i1, cid, "cash", ",idempotency_key", ",'k1'"), /duplicate key|unique/i);
    await pay(pool, i2, cid, "cash", ",idempotency_key", ",'k1'"); // same key on another invoice is fine
    await assert.rejects(pay(pool, i2, cid, "cash", ",voided_at", ",now()"), /check constraint/i);
  }));

test("useful indexes exist", () =>
  withDb(async (pool) => {
    const r = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()");
    const names = r.rows.map((x) => x.indexname);
    for (const n of [
      "invoices_number_uq", "payments_receipt_number_uq", "payments_invoice_idem_uq", "invoices_candidate_idx", "payments_candidate_idx",
      "invoice_items_invoice_idx", "fin_refunds_payment_idx", "fin_refunds_invoice_idx", "fin_ledger_candidate_idx", "fin_ledger_ref_idx",
      "fin_ledger_entry_at_idx", "expenses_category_idx", "invoices_due_open_idx",
    ]) assert.ok(names.includes(n), `index ${n}`);
  }));

// ---- legacy data -------------------------------------------------------------------------------------------------

async function legacyDb() {
  const { runMigrations } = require("../scripts/migrate");
  const schema = `t_${process.pid}_${crypto.randomBytes(6).toString("hex")}`;
  const base = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/trustcrm_test";
  const admin = new Pool({ connectionString: base, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: base, options: `-c search_path=${schema},public` });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-015-"));
  for (const f of fs.readdirSync(MIG).filter((x) => x < "016")) fs.copyFileSync(path.join(MIG, f), path.join(dir, f));
  await pool.query(fs.readFileSync(path.join(ROOT, "sql", "schema.sql"), "utf8"));
  await runMigrations(pool, dir);
  return {
    pool,
    runAll: () => runMigrations(pool),
    cleanup: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const snapshot = async (pool) => ({
  invoices: (await pool.query("SELECT id,candidate_id,total_amount,remaining_amount,currency,due_date,status,notes,created_by,is_deleted,created_at,updated_at FROM invoices ORDER BY id")).rows,
  payments: (await pool.query("SELECT id,invoice_id,candidate_id,amount_paid,payment_method,payment_date,notes,created_by,is_deleted,created_at FROM payments ORDER BY id")).rows,
  expenses: (await pool.query("SELECT id,title,amount,currency,spent_on,notes,created_by,is_deleted,created_at FROM expenses ORDER BY id")).rows,
});

const constraintState = async (pool, name) =>
  (await pool.query("SELECT convalidated FROM pg_constraint WHERE conname=$1 AND conrelid = to_regclass('invoices')", [name])).rows;

test("DB with conforming legacy invoices/payments migrates cleanly, rows untouched, constraints validated", async () => {
  const db = await legacyDb();
  try {
    const { pool } = db;
    const c = await cand(pool);
    await pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,currency,status) VALUES ($1,100,60,'TND','Partial')", [c]);
    await pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,status) VALUES ($1,50,0,'Paid')", [c]);
    await pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,is_deleted) VALUES ($1,5,5,true)", [c]);
    const i = (await pool.query("SELECT id FROM invoices ORDER BY id LIMIT 1")).rows[0].id;
    await pay(pool, i, c, "cash");
    await pool.query("INSERT INTO expenses (title,amount) VALUES ('rent',12.50)");
    const before = await snapshot(pool);
    assert.deepEqual(await db.runAll(), ["016_accounting.sql", "017_accounting_fixes.sql", "018_hr.sql"]);
    assert.deepEqual(await snapshot(pool), before, "no legacy value changed (all of it already conformed, so 017 normalises nothing)");
    const nul = await pool.query("SELECT count(*)::int n FROM invoices WHERE number IS NOT NULL OR subtotal IS NOT NULL OR issued_at IS NOT NULL");
    assert.equal(nul.rows[0].n, 0, "new columns stay NULL on legacy rows");
    // 017 backfills the opening ledger rows: 2 live invoices (the deleted one gets none), 1 payment, 1 expense
    assert.deepEqual((await pool.query("SELECT kind, count(*)::int n FROM fin_ledger GROUP BY kind ORDER BY kind")).rows, [{ kind: "expense", n: 1 }, { kind: "invoice", n: 2 }, { kind: "payment", n: 1 }]);
    assert.deepEqual(await constraintState(pool, "invoices_status_check"), [{ convalidated: true }]);
    assert.deepEqual(await constraintState(pool, "invoices_currency_check"), [{ convalidated: true }]);
    assert.equal((await pool.query("SELECT convalidated FROM pg_constraint WHERE conname='payments_method_check' AND conrelid = to_regclass('payments')")).rows[0].convalidated, true);
    await pool.query(SQL016()); // re-run is safe with data present
    await pool.query(SQL017());
    assert.equal((await pool.query("SELECT count(*)::int n FROM fin_ledger")).rows[0].n, 4, "re-running adds nothing");
  } finally {
    await db.cleanup();
  }
});

test("DB with non-conforming legacy rows: 016 leaves them alone, 017 normalises what it can and validates what then conforms", async () => {
  const db = await legacyDb();
  try {
    const { pool } = db;
    const c = await cand(pool);
    await pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,currency,status) VALUES ($1,100,60,'TND','Unpaid')", [c]);
    await pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,currency,status) VALUES ($1,10,10,'tnd','Pending')", [c]);
    await pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,currency,status) VALUES ($1,20,20,' eur ','Pending')", [c]);
    await pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,currency,status) VALUES ($1,30,30,'TN','Pending')", [c]);
    const i = (await pool.query("SELECT id FROM invoices ORDER BY id LIMIT 1")).rows[0].id;
    await pay(pool, i, c, "Bank Transfer");
    await pay(pool, i, c, "  CHEQUE ");
    await pay(pool, i, c, "Western-Union");
    await pool.query("INSERT INTO expenses (title,amount,currency) VALUES ('e1',1,'tnd'), ('e2',2,'XX')");
    const before = await snapshot(pool);

    // 016 alone changes nothing and leaves the constraints NOT VALID (this is the state the review found)
    const dir016 = fs.mkdtempSync(path.join(os.tmpdir(), "mig-016-"));
    for (const f of fs.readdirSync(MIG).filter((x) => x <= "016_accounting.sql")) fs.copyFileSync(path.join(MIG, f), path.join(dir016, f));
    const { runMigrations } = require("../scripts/migrate");
    assert.deepEqual(await runMigrations(pool, dir016), ["016_accounting.sql"]);
    fs.rmSync(dir016, { recursive: true, force: true });
    assert.deepEqual(await snapshot(pool), before);
    assert.deepEqual(await constraintState(pool, "invoices_currency_check"), [{ convalidated: false }]);
    assert.equal((await pool.query("SELECT convalidated FROM pg_constraint WHERE conname='payments_method_check' AND conrelid = to_regclass('payments')")).rows[0].convalidated, false);

    assert.deepEqual(await db.runAll(), ["017_accounting_fixes.sql", "018_hr.sql"]);
    const after = await snapshot(pool);
    // the invoice with the legacy status 'Unpaid' cannot be updated (NOT VALID checks re-run on UPDATE): its currency was already fine
    assert.deepEqual(after.invoices.map((r) => r.currency), ["TND", "TND", "EUR", "TN"]);
    assert.deepEqual(after.invoices.map((r) => r.status), ["Unpaid", "Pending", "Pending", "Pending"], "status values are never rewritten");
    assert.deepEqual(after.payments.map((r) => r.payment_method), ["bank_transfer", "cheque", "other"]);
    assert.deepEqual(after.expenses.map((r) => r.currency), ["TND", "XX"], "an unfixable currency is left exactly as it was");
    for (const [a, b] of [[after.invoices, before.invoices], [after.payments, before.payments], [after.expenses, before.expenses]]) {
      assert.deepEqual(a.map((r) => [r.id, r.created_at]), b.map((r) => [r.id, r.created_at]), "ids and timestamps untouched");
    }
    assert.deepEqual(after.invoices.map((r) => r.updated_at), before.invoices.map((r) => r.updated_at), "updated_at untouched");
    // payment_method is now fully conforming -> validated; the currency constraints still have a 'TN' / 'XX' row
    assert.equal((await pool.query("SELECT convalidated FROM pg_constraint WHERE conname='payments_method_check' AND conrelid = to_regclass('payments')")).rows[0].convalidated, true);
    assert.deepEqual(await constraintState(pool, "invoices_currency_check"), [{ convalidated: false }]);
    assert.deepEqual(await constraintState(pool, "invoices_status_check"), [{ convalidated: false }]);
    assert.equal((await pool.query("SELECT convalidated FROM pg_constraint WHERE conname='expenses_currency_check' AND conrelid = to_regclass('expenses')")).rows[0].convalidated, false);
    await pool.query(SQL017()); // idempotent while still non-conforming
    await pool.query(SQL016());
    // new rows are still guarded
    await assert.rejects(pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,status) VALUES ($1,1,1,'Unpaid')", [c]), /check constraint/i);
    await assert.rejects(pay(pool, i, c, "Bank Transfer"), /check constraint/i);
    // once the owner corrects the rest, re-running validates the constraints
    await pool.query("UPDATE invoices SET status='Paid', remaining_amount=0 WHERE status='Unpaid'");
    await pool.query("UPDATE invoices SET currency='TND' WHERE currency='TN'");
    await pool.query("UPDATE expenses SET currency='EUR' WHERE currency='XX'");
    await pool.query(SQL017());
    assert.deepEqual(await constraintState(pool, "invoices_status_check"), [{ convalidated: true }]);
    assert.deepEqual(await constraintState(pool, "invoices_currency_check"), [{ convalidated: true }]);
    assert.equal((await pool.query("SELECT convalidated FROM pg_constraint WHERE conname='expenses_currency_check' AND conrelid = to_regclass('expenses')")).rows[0].convalidated, true);
  } finally {
    await db.cleanup();
  }
});

test("migration 017 is registered, idempotent and a no-op on a fresh database", () =>
  withDb(async (pool) => {
    const { runMigrations } = require("../scripts/migrate");
    assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE name='017_accounting_fixes.sql'")).rowCount, 1);
    assert.deepEqual(await runMigrations(pool), []);
    await pool.query(SQL017());
    await pool.query(SQL017());
    assert.equal((await pool.query("SELECT count(*)::int n FROM fin_ledger")).rows[0].n, 0, "nothing to backfill on a fresh database");
  }));

test("017 ledger backfill: opening rows for pre-016 invoices, payments and expenses; per-invoice identity holds; re-running adds nothing", async () => {
  const db = await legacyDb();
  try {
    const { pool } = db;
    const c = await cand(pool);
    const u = (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('Old','old@x.io','h','Admin') RETURNING id")).rows[0].id;
    const stamp = "2025-06-01 10:00:00";
    const mkInv = async (total, remaining, extra = "", cur = "tnd") =>
      (await pool.query(`INSERT INTO invoices (candidate_id,total_amount,remaining_amount,currency,created_by,created_at,is_deleted${extra ? "," + extra.split("=")[0] : ""}) VALUES ($1,$2,$3,$4,$5,$6,false${extra ? "," + extra.split("=")[1] : ""}) RETURNING id`, [c, total, remaining, cur, u, stamp])).rows[0].id;
    const i1 = await mkInv(100, 70);
    const i2 = await mkInv(40, 40, "", "EUR");
    const bad = await mkInv(30, 30, "", "TN");
    const gone = (await pool.query("INSERT INTO invoices (candidate_id,total_amount,remaining_amount,is_deleted) VALUES ($1,9,9,true) RETURNING id", [c])).rows[0].id;
    const p1 = (await pool.query("INSERT INTO payments (invoice_id,candidate_id,amount_paid,payment_method,created_by,created_at) VALUES ($1,$2,10,'Cash',$3,$4) RETURNING id", [i1, c, u, stamp])).rows[0].id;
    const p2 = (await pool.query("INSERT INTO payments (invoice_id,candidate_id,amount_paid,payment_method,created_by,created_at) VALUES ($1,$2,20,'cash',$3,$4) RETURNING id", [i1, c, u, stamp])).rows[0].id;
    await pool.query("INSERT INTO payments (invoice_id,candidate_id,amount_paid,payment_method,is_deleted) VALUES ($1,$2,3,'cash',true)", [i2, c]);
    const e1 = (await pool.query("INSERT INTO expenses (title,amount,currency,created_by,created_at) VALUES ('rent',55.5,'tnd',$1,$2) RETURNING id", [u, stamp])).rows[0].id;
    await pool.query("INSERT INTO expenses (title,amount,is_deleted) VALUES ('gone',5,true)");
    assert.deepEqual(await db.runAll(), ["016_accounting.sql", "017_accounting_fixes.sql", "018_hr.sql"]);

    const rows = async () => (await pool.query("SELECT kind, ref_table, ref_id::int, candidate_id, currency, debit::text d, credit::text cr, actor_id, entry_at = $1::timestamp AS at_created FROM fin_ledger ORDER BY id", [stamp])).rows;
    const got = await rows();
    const key = (r) => `${r.kind}:${r.ref_table}:${r.ref_id}`;
    assert.deepEqual(
      got.map(key).sort(),
      [`invoice:invoices:${i1}`, `invoice:invoices:${i2}`, `payment:payments:${p1}`, `payment:payments:${p2}`, `expense:expenses:${e1}`].sort(),
      "deleted rows and the invoice with currency 'TN' get no ledger row"
    );
    const inv1 = got.find((r) => key(r) === `invoice:invoices:${i1}`);
    assert.deepEqual({ ...inv1 }, { kind: "invoice", ref_table: "invoices", ref_id: i1, candidate_id: String(c), currency: "TND", d: "100.00", cr: "0.00", actor_id: String(u), at_created: true });
    const pay1 = got.find((r) => key(r) === `payment:payments:${p1}`);
    assert.deepEqual({ ...pay1 }, { kind: "payment", ref_table: "payments", ref_id: p1, candidate_id: String(c), currency: "TND", d: "0.00", cr: "10.00", actor_id: String(u), at_created: true });
    const ex = got.find((r) => r.kind === "expense");
    assert.deepEqual({ ...ex }, { kind: "expense", ref_table: "expenses", ref_id: e1, candidate_id: null, currency: "TND", d: "55.50", cr: "0.00", actor_id: String(u), at_created: true });
    // the per-invoice identity: ledger balance = total - live paid = remaining_amount (no refunds on legacy rows)
    const bal = (
      await pool.query(
        `SELECT i.id, (COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0))::text AS ledger, i.remaining_amount::text AS remaining
           FROM invoices i LEFT JOIN fin_ledger l ON (l.ref_table='invoices' AND l.ref_id=i.id) OR (l.ref_table='payments' AND l.ref_id IN (SELECT id FROM payments WHERE invoice_id=i.id))
          WHERE i.id = ANY($1) GROUP BY i.id ORDER BY i.id`,
        [[i1, i2]]
      )
    ).rows;
    assert.deepEqual(bal.map((r) => [r.ledger, r.remaining]), [["70.00", "70.00"], ["40.00", "40.00"]]);
    // legacy numbers stay unnumbered
    assert.equal((await pool.query("SELECT count(*)::int n FROM invoices WHERE number IS NOT NULL")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM payments WHERE receipt_number IS NOT NULL")).rows[0].n, 0);

    // re-running adds nothing
    await pool.query(SQL017());
    await pool.query(SQL017());
    assert.deepEqual(await rows(), got);
    // once the odd currency is corrected, the next run picks that invoice up (and only that)
    await pool.query("UPDATE invoices SET currency='TND' WHERE id=$1", [bad]);
    await pool.query(SQL017());
    const again = await rows();
    assert.equal(again.length, got.length + 1);
    assert.equal(again[again.length - 1].ref_id, bad);
    await pool.query(SQL017());
    assert.equal((await rows()).length, got.length + 1);
  } finally {
    await db.cleanup();
  }
});
test("legacy finance route SQL (insert invoice, pay with FOR UPDATE, dashboard sums) still works after 016", () =>
  withDb(async (pool) => {
    const cid = await cand(pool);
    const r = await pool.query(
      `INSERT INTO invoices (candidate_id, total_amount, remaining_amount, currency, due_date, status, notes, created_by)
       VALUES ($1,100,100,'TND',NULL,'Pending',NULL,NULL) RETURNING *`,
      [cid]
    );
    await pool.query("SELECT * FROM invoices WHERE id=$1 AND is_deleted=false FOR UPDATE", [r.rows[0].id]);
    await pay(pool, r.rows[0].id, cid, "cash");
    const s = await pool.query("SELECT COALESCE(SUM(total_amount),0) t FROM invoices WHERE is_deleted=false");
    assert.equal(s.rows[0].t, "100.00");
  }));

// ---- permissions ---------------------------------------------------------------------------------------------------

test("finance permission matrix is exactly as specified", () => {
  const has = (role, p) => PERMISSIONS[role].includes("*") || PERMISSIONS[role].includes(p);
  const expected = {
    "finance:read": ["SuperAdmin", "Admin", "Manager", "Accountant"],
    "finance:write": ["SuperAdmin", "Admin", "Accountant"],
    "finance:void": ["SuperAdmin", "Admin", "Accountant"],
    "finance:refund": ["SuperAdmin", "Admin", "Accountant"],
    "finance:export": ["SuperAdmin", "Admin", "Accountant", "Manager"],
  };
  for (const [perm, roles] of Object.entries(expected)) {
    for (const role of Object.keys(PERMISSIONS)) {
      assert.equal(has(role, perm), roles.includes(role), `${role} ${perm}`);
    }
  }
  for (const role of ["Agent", "Receptionist", "HR", "Employer", "Agency", "Candidate"]) {
    assert.deepEqual(PERMISSIONS[role].filter((p) => p.startsWith("finance:")), [], `${role} has no finance permission`);
  }
});

test("SETUP.md finance permission matrix equals PERMISSIONS (docs cannot drift)", () => {
  const doc = fs.readFileSync(path.join(ROOT, "..", "docs", "vita-job-search", "SETUP.md"), "utf8");
  const m = /<!-- finance-permission-matrix:start -->([\s\S]*?)<!-- finance-permission-matrix:end -->/.exec(doc);
  assert.ok(m, "SETUP.md has the finance-permission-matrix block");
  const lines = m[1].trim().split("\n").filter((l) => l.startsWith("|"));
  const header = lines[0].split("|").map((c) => c.trim()).filter(Boolean);
  const perms = header.slice(1).filter((h) => /^[a-z]+:[a-z]+$/.test(h));
  assert.deepEqual(perms, ["finance:read", "finance:write", "finance:void", "finance:refund", "finance:export"]);
  const allFinance = [...new Set(Object.values(PERMISSIONS).flat().filter((p) => p.startsWith("finance:")))].sort();
  assert.deepEqual(allFinance, [...perms].sort(), "every finance:* grant in code is a documented column");
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

test("CHECKLIST and SETUP document the ledger backfill of migration 017 (no leftover 'no backfill' claim)", () => {
  const dir = path.join(ROOT, "..", "docs", "vita-accounting");
  const checklist = fs.readFileSync(path.join(dir, "CHECKLIST.md"), "utf8");
  const setup = fs.readFileSync(path.join(dir, "SETUP.md"), "utf8");
  assert.match(checklist, /Review round 1/);
  assert.match(checklist, /017_accounting_fixes/);
  assert.match(checklist, /backfill/i);
  assert.match(checklist, /unnumbered/i);
  assert.doesNotMatch(checklist, /fin_opening/, "the opening-balance note is replaced");
  assert.doesNotMatch(checklist, /not done on purpose/);
  assert.match(setup, /017/);
  assert.match(setup, /unnumbered/i);
  assert.doesNotMatch(setup, /fin_opening/);
});
