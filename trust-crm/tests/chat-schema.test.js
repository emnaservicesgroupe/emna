const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createTestDb } = require("./helpers/db");
const { PERMISSIONS } = require("../middleware/role");

const ROOT = path.join(__dirname, "..");
const SQL021 = () => fs.readFileSync(path.join(ROOT, "sql", "migrations", "021_chat.sql"), "utf8");

// One migrated schema shared by the non-destructive tests; every test creates its own rows.
let sharedDb = null;
async function withShared(fn) {
  if (!sharedDb) sharedDb = await createTestDb();
  await fn(sharedDb.pool);
}
test.after(async () => {
  if (sharedDb) await sharedDb.cleanup();
});

let seq = 0;
const user = async (pool, role = "Agent") => {
  seq += 1;
  return (await pool.query("INSERT INTO users (full_name,email,password,role) VALUES ('U',$1,'h',$2) RETURNING id", [`chat${seq}-${process.pid}@test.invalid`, role])).rows[0].id;
};
const conv = async (pool, type = "candidate", subjectId = null) => {
  seq += 1;
  return (await pool.query("INSERT INTO chat_conversations (subject_type, subject_id) VALUES ($1,$2) RETURNING id", [type, type === "staff" ? null : subjectId ?? seq])).rows[0].id;
};
const msg = (pool, cid, uid, body = "hello", role = "Agent") =>
  pool.query("INSERT INTO chat_messages (conversation_id, sender_user_id, sender_role, body) VALUES ($1,$2,$3,$4) RETURNING id", [cid, uid, role, body]);

const CHECK = /check constraint/i;

test("migration 021 is idempotent (re-run applies nothing, re-executing the SQL is safe, no duplicate triggers)", () =>
  withShared(async (pool) => {
    const { runMigrations } = require("../scripts/migrate");
    assert.deepEqual(await runMigrations(pool), []);
    await pool.query(SQL021());
    await pool.query(SQL021());
    assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE name='021_chat.sql'")).rowCount, 1);
    for (const t of ["chat_conversations", "chat_participants", "chat_messages", "chat_prefs", "chat_nudges", "chat_channel_outbox"]) {
      assert.ok((await pool.query("SELECT to_regclass($1) AS t", [t])).rows[0].t, `${t} exists`);
    }
    const trg = await pool.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'chat_messages'::regclass");
    assert.deepEqual(trg.rows.map((r) => r.tgname).sort(), ["chat_messages_immutable_trg"]);
  }));

test("indexes exist: messages by conversation+id desc, participants by user, unread and rate-limit lookups", () =>
  withShared(async (pool) => {
    const defs = (await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename LIKE 'chat\\_%'")).rows.map((r) => r.indexdef);
    const has = (re) => assert.ok(defs.some((d) => re.test(d)), `index matching ${re}`);
    has(/ON \S*chat_messages .*\(conversation_id, id DESC\)/);
    has(/ON \S*chat_participants .*\(user_id, conversation_id\)/);
    has(/ON \S*chat_messages .*\(conversation_id, id\).*hidden_at IS NULL/);
    has(/ON \S*chat_messages .*\(sender_user_id, created_at DESC\)/);
    has(/ON \S*chat_conversations .*\(last_message_at DESC/);
  }));

test("conversation constraints: subject_type, status, non-staff needs subject_id", () =>
  withShared(async (pool) => {
    await assert.rejects(pool.query("INSERT INTO chat_conversations (subject_type, subject_id) VALUES ('stranger', 1)"), CHECK);
    await assert.rejects(pool.query("INSERT INTO chat_conversations (subject_type, subject_id) VALUES (NULL, 1)"), /null value/i);
    await assert.rejects(pool.query("INSERT INTO chat_conversations (subject_type, subject_id, status) VALUES ('agency', 900001, 'archived')"), CHECK);
    await assert.rejects(pool.query("INSERT INTO chat_conversations (subject_type, subject_id) VALUES ('candidate', NULL)"), CHECK);
    for (const [i, t] of ["candidate", "employer_request", "agency"].entries()) {
      const r = await pool.query("INSERT INTO chat_conversations (subject_type, subject_id) VALUES ($1,$2) RETURNING status, created_at", [t, 910000 + i]);
      assert.equal(r.rows[0].status, "open");
      assert.ok(r.rows[0].created_at);
    }
  }));

test("unique subject: one conversation per (subject_type, subject_id) for non-staff types; staff rooms are free", () =>
  withShared(async (pool) => {
    const id = 920000 + seq++;
    await pool.query("INSERT INTO chat_conversations (subject_type, subject_id) VALUES ('candidate', $1)", [id]);
    await assert.rejects(pool.query("INSERT INTO chat_conversations (subject_type, subject_id) VALUES ('candidate', $1)", [id]), (e) => e.code === "23505");
    // same id under another type is another subject
    await pool.query("INSERT INTO chat_conversations (subject_type, subject_id) VALUES ('agency', $1)", [id]);
    await assert.rejects(pool.query("INSERT INTO chat_conversations (subject_type, subject_id) VALUES ('agency', $1)", [id]), (e) => e.code === "23505");
    // staff rooms: any number, with or without subject_id
    await pool.query("INSERT INTO chat_conversations (subject_type, title) VALUES ('staff', 'a')");
    await pool.query("INSERT INTO chat_conversations (subject_type, title) VALUES ('staff', 'a')");
    await pool.query("INSERT INTO chat_conversations (subject_type, subject_id) VALUES ('staff', $1), ('staff', $1)", [id]);
  }));

test("message body constraints: empty, 2001 chars, NUL rejected; 1 and 2000 chars accepted; unicode counted by characters", () =>
  withShared(async (pool) => {
    const u = await user(pool);
    const c = await conv(pool);
    await assert.rejects(msg(pool, c, u, ""), CHECK);
    await assert.rejects(msg(pool, c, u, "x".repeat(2001)), CHECK);
    await assert.rejects(msg(pool, c, u, "a\u0000b"), (e) => e.code === "22021" || /null|invalid byte|\\0/i.test(e.message));
    await assert.rejects(msg(pool, c, u, null), /null value/i);
    await msg(pool, c, u, "x");
    await msg(pool, c, u, "x".repeat(2000));
    await msg(pool, c, u, "ش".repeat(2000)); // 2000 Arabic letters = 4000 bytes, still 2000 characters
    await assert.rejects(msg(pool, c, u, "ش".repeat(2001)), CHECK);
    await assert.rejects(pool.query("INSERT INTO chat_messages (conversation_id, sender_user_id, sender_role, body) VALUES ($1,$2,NULL,'x')", [c, u]), /null value/i);
    await assert.rejects(msg(pool, 987654321, u, "orphan"), (e) => e.code === "23503");
  }));

test("message ids are monotonic per insert (bigserial) and the index serves (conversation_id, id desc)", () =>
  withShared(async (pool) => {
    const u = await user(pool);
    const c = await conv(pool);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(Number((await msg(pool, c, u, `m${i}`)).rows[0].id));
    assert.ok(ids[0] < ids[1] && ids[1] < ids[2]);
  }));

test("immutability: UPDATE of body and any other column fails, DELETE fails", () =>
  withShared(async (pool) => {
    const u = await user(pool);
    const u2 = await user(pool);
    const c = await conv(pool);
    const c2 = await conv(pool);
    const id = (await msg(pool, c, u, "original")).rows[0].id;
    const IMM = /immutable/i;
    await assert.rejects(pool.query("UPDATE chat_messages SET body='changed' WHERE id=$1", [id]), IMM);
    await assert.rejects(pool.query("UPDATE chat_messages SET sender_role='Admin' WHERE id=$1", [id]), IMM);
    await assert.rejects(pool.query("UPDATE chat_messages SET sender_user_id=$2 WHERE id=$1", [id, u2]), IMM);
    await assert.rejects(pool.query("UPDATE chat_messages SET conversation_id=$2 WHERE id=$1", [id, c2]), IMM);
    await assert.rejects(pool.query("UPDATE chat_messages SET created_at=created_at - interval '1 day' WHERE id=$1", [id]), IMM);
    await assert.rejects(pool.query("UPDATE chat_messages SET id=id+100000 WHERE id=$1", [id]), IMM);
    // a mixed update (hide columns + body) is refused as a whole
    await assert.rejects(pool.query("UPDATE chat_messages SET body='x', hidden_at=now(), hidden_reason='r' WHERE id=$1", [id]), IMM);
    await assert.rejects(pool.query("DELETE FROM chat_messages WHERE id=$1", [id]), IMM);
    await assert.rejects(pool.query("DELETE FROM chat_messages WHERE conversation_id=$1", [c]), IMM);
    const row = (await pool.query("SELECT body, sender_user_id, hidden_at FROM chat_messages WHERE id=$1", [id])).rows[0];
    assert.equal(row.body, "original");
    assert.equal(row.sender_user_id, u);
    assert.equal(row.hidden_at, null);
    // no-op updates of the immutable columns to the same value are fine
    await pool.query("UPDATE chat_messages SET body=body, sender_role=sender_role WHERE id=$1", [id]);
  }));

test("hide: with reason works, without reason (null, empty, blank) fails, unhide works, re-hide works", () =>
  withShared(async (pool) => {
    const admin = await user(pool, "Admin");
    const u = await user(pool);
    const c = await conv(pool);
    const id = (await msg(pool, c, u, "rude")).rows[0].id;
    await assert.rejects(pool.query("UPDATE chat_messages SET hidden_at=now(), hidden_by=$2 WHERE id=$1", [id, admin]), /reason/i);
    await assert.rejects(pool.query("UPDATE chat_messages SET hidden_at=now(), hidden_by=$2, hidden_reason='' WHERE id=$1", [id, admin]), /reason/i);
    await assert.rejects(pool.query("UPDATE chat_messages SET hidden_at=now(), hidden_by=$2, hidden_reason='   ' WHERE id=$1", [id, admin]), /reason/i);
    assert.equal((await pool.query("SELECT hidden_at FROM chat_messages WHERE id=$1", [id])).rows[0].hidden_at, null);

    await pool.query("UPDATE chat_messages SET hidden_at=now(), hidden_by=$2, hidden_reason='abusive' WHERE id=$1", [id, admin]);
    let r = (await pool.query("SELECT body, hidden_at, hidden_by, hidden_reason FROM chat_messages WHERE id=$1", [id])).rows[0];
    assert.ok(r.hidden_at);
    assert.equal(r.hidden_by, admin);
    assert.equal(r.hidden_reason, "abusive");
    assert.equal(r.body, "rude", "hiding never alters the body");

    // while hidden the reason cannot be blanked
    await assert.rejects(pool.query("UPDATE chat_messages SET hidden_reason='' WHERE id=$1", [id]), /reason/i);
    await pool.query("UPDATE chat_messages SET hidden_at=NULL, hidden_by=NULL, hidden_reason=NULL WHERE id=$1", [id]);
    r = (await pool.query("SELECT hidden_at, hidden_by, hidden_reason FROM chat_messages WHERE id=$1", [id])).rows[0];
    assert.deepEqual(r, { hidden_at: null, hidden_by: null, hidden_reason: null });
    await pool.query("UPDATE chat_messages SET hidden_at=now(), hidden_by=$2, hidden_reason='again' WHERE id=$1", [id, admin]);

    // inserting a pre-hidden message without a reason is refused too
    await assert.rejects(pool.query("INSERT INTO chat_messages (conversation_id, sender_user_id, sender_role, body, hidden_at) VALUES ($1,$2,'Agent','x',now())", [c, u]), /reason|check constraint/i);
  }));

test("hidden_reason is bounded", () =>
  withShared(async (pool) => {
    const u = await user(pool);
    const c = await conv(pool);
    const id = (await msg(pool, c, u, "x")).rows[0].id;
    await assert.rejects(pool.query("UPDATE chat_messages SET hidden_at=now(), hidden_reason=$2 WHERE id=$1", [id, "r".repeat(501)]), CHECK);
  }));

test("deleting a user is never blocked: messages keep their text with sender NULL, hide actor NULL, participants and prefs go", () =>
  withShared(async (pool) => {
    const sender = await user(pool);
    const mod = await user(pool, "Admin");
    const c = await conv(pool);
    const id = (await msg(pool, c, sender, "kept")).rows[0].id;
    await pool.query("UPDATE chat_messages SET hidden_at=now(), hidden_by=$2, hidden_reason='x' WHERE id=$1", [id, mod]);
    await pool.query("INSERT INTO chat_participants (conversation_id, user_id, added_by) VALUES ($1,$2,$3)", [c, sender, mod]);
    await pool.query("INSERT INTO chat_prefs (user_id) VALUES ($1)", [sender]);
    await pool.query("INSERT INTO chat_nudges (conversation_id, user_id) VALUES ($1,$2)", [c, sender]);
    const creator = await user(pool);
    const c2 = (await pool.query("INSERT INTO chat_conversations (subject_type, title, created_by) VALUES ('staff','room',$1) RETURNING id", [creator])).rows[0].id;

    await pool.query("DELETE FROM users WHERE id=$1", [sender]);
    await pool.query("DELETE FROM users WHERE id=$1", [mod]);
    await pool.query("DELETE FROM users WHERE id=$1", [creator]);
    const m = (await pool.query("SELECT body, sender_user_id, sender_role, hidden_by, hidden_reason FROM chat_messages WHERE id=$1", [id])).rows[0];
    assert.deepEqual(m, { body: "kept", sender_user_id: null, sender_role: "Agent", hidden_by: null, hidden_reason: "x" });
    assert.equal((await pool.query("SELECT count(*)::int n FROM chat_participants WHERE conversation_id=$1", [c])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM chat_prefs WHERE user_id=$1", [sender])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM chat_nudges WHERE user_id=$1", [sender])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT created_by FROM chat_conversations WHERE id=$1", [c2])).rows[0].created_by, null);
    // the sender id can only ever move to NULL, never to another user
    const other = await user(pool);
    const id2 = (await msg(pool, c, other, "mine")).rows[0].id;
    await assert.rejects(pool.query("UPDATE chat_messages SET sender_user_id=NULL, body='z' WHERE id=$1", [id2]), /immutable/i);
  }));

test("migration 022: sender_user_id can become NULL only through the foreign-key action, never by a direct UPDATE (also not inside a transaction or a DO block)", () =>
  withShared(async (pool) => {
    const sql022 = fs.readFileSync(path.join(ROOT, "sql", "migrations", "022_chat_hardening.sql"), "utf8");
    await pool.query(sql022); // idempotent
    assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE name='022_chat_hardening.sql'")).rowCount, 1);
    const trg = await pool.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'chat_messages'::regclass");
    assert.deepEqual(trg.rows.map((r) => r.tgname), ["chat_messages_immutable_trg"], "still exactly one trigger");
    const sender = await user(pool);
    const c = await conv(pool);
    const id = (await msg(pool, c, sender, "who wrote this")).rows[0].id;
    await assert.rejects(pool.query("UPDATE chat_messages SET sender_user_id = NULL WHERE id = $1", [id]), /immutable/i);
    await assert.rejects(pool.query("DO $$ BEGIN UPDATE chat_messages SET sender_user_id = NULL WHERE id = " + Number(id) + "; END $$"), /immutable/i);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(client.query("UPDATE chat_messages SET sender_user_id = NULL WHERE id = $1", [id]), /immutable/i);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.equal((await pool.query("SELECT sender_user_id FROM chat_messages WHERE id=$1", [id])).rows[0].sender_user_id, sender);
    // hiding still works, and deleting the user (FK SET NULL action) still works and keeps the message
    await pool.query("UPDATE chat_messages SET hidden_at=now(), hidden_by=$2, hidden_reason='r' WHERE id=$1", [id, sender]);
    await pool.query("DELETE FROM users WHERE id=$1", [sender]);
    const row = (await pool.query("SELECT body, sender_user_id, hidden_by FROM chat_messages WHERE id=$1", [id])).rows[0];
    assert.deepEqual(row, { body: "who wrote this", sender_user_id: null, hidden_by: null });
    // once NULL, it cannot be pointed at somebody else either
    const other = await user(pool);
    await assert.rejects(pool.query("UPDATE chat_messages SET sender_user_id = $2 WHERE id = $1", [id, other]), /immutable/i);
  }));

test("participants, prefs, nudges, outbox: keys, defaults and checks", () =>
  withShared(async (pool) => {
    const a = await user(pool);
    const b = await user(pool);
    const c = await conv(pool);
    await pool.query("INSERT INTO chat_participants (conversation_id, user_id, added_by) VALUES ($1,$2,$3)", [c, a, b]);
    await assert.rejects(pool.query("INSERT INTO chat_participants (conversation_id, user_id) VALUES ($1,$2)", [c, a]), (e) => e.code === "23505");
    const p = (await pool.query("SELECT muted, last_read_message_id, added_at FROM chat_participants WHERE conversation_id=$1 AND user_id=$2", [c, a])).rows[0];
    assert.equal(p.muted, false);
    assert.equal(p.last_read_message_id, null);
    assert.ok(p.added_at);
    await assert.rejects(pool.query("INSERT INTO chat_participants (conversation_id, user_id) VALUES ($1,987654321)", [c]), (e) => e.code === "23503");
    await assert.rejects(pool.query("INSERT INTO chat_participants (conversation_id, user_id) VALUES (987654321,$1)", [b]), (e) => e.code === "23503");

    await pool.query("INSERT INTO chat_prefs (user_id) VALUES ($1)", [a]);
    assert.equal((await pool.query("SELECT email_nudges FROM chat_prefs WHERE user_id=$1", [a])).rows[0].email_nudges, true);
    await pool.query("INSERT INTO chat_nudges (conversation_id, user_id) VALUES ($1,$2)", [c, a]);
    await assert.rejects(pool.query("INSERT INTO chat_nudges (conversation_id, user_id) VALUES ($1,$2)", [c, a]), (e) => e.code === "23505");

    const mid = (await msg(pool, c, a)).rows[0].id;
    const ob = async (channel, status) => pool.query("INSERT INTO chat_channel_outbox (message_id, channel, status) VALUES ($1,$2,$3) RETURNING id", [mid, channel, status]);
    for (const s of ["queued", "sent", "failed", "requires_setup"]) await ob("whatsapp", s);
    await ob("email", "queued");
    await assert.rejects(ob("sms", "queued"), CHECK);
    await assert.rejects(ob("whatsapp", "delivered"), CHECK);
    const d = (await pool.query("INSERT INTO chat_channel_outbox (message_id, channel) VALUES ($1,'whatsapp') RETURNING status, detail", [mid])).rows[0];
    assert.equal(d.status, "queued");
    assert.equal(d.detail, null);
    await assert.rejects(pool.query("INSERT INTO chat_channel_outbox (message_id, channel, detail) VALUES (987654321,'email','x')"), (e) => e.code === "23503");
  }));

test("unread math is index-friendly SQL: count of visible messages from others after last_read", () =>
  withShared(async (pool) => {
    const staff = await user(pool);
    const ext = await user(pool);
    const c = await conv(pool);
    await pool.query("INSERT INTO chat_participants (conversation_id, user_id) VALUES ($1,$2)", [c, staff]);
    const ids = [];
    for (const [u, t] of [[ext, "1"], [staff, "2"], [ext, "3"], [ext, "4"]]) ids.push((await msg(pool, c, u, t)).rows[0].id);
    await pool.query("UPDATE chat_messages SET hidden_at=now(), hidden_reason='x' WHERE id=$1", [ids[3]]);
    await pool.query("UPDATE chat_participants SET last_read_message_id=$3 WHERE conversation_id=$1 AND user_id=$2", [c, staff, ids[0]]);
    const unread = await pool.query(
      `SELECT count(m.id)::int n FROM chat_participants p
         JOIN chat_messages m ON m.conversation_id = p.conversation_id AND m.id > COALESCE(p.last_read_message_id, 0)
          AND m.sender_user_id IS DISTINCT FROM p.user_id AND m.hidden_at IS NULL
        WHERE p.conversation_id=$1 AND p.user_id=$2`,
      [c, staff]
    );
    assert.equal(unread.rows[0].n, 1);
  }));

// ------------------------------------------------------------------ permissions

test("chat:* permission matrix is exact", () => {
  const holders = (p) => Object.entries(PERMISSIONS).filter(([, v]) => v.includes(p)).map(([k]) => k).sort();
  assert.deepEqual(holders("chat:read"), ["Admin", "Agent", "Manager", "Receptionist"]);
  assert.deepEqual(holders("chat:write"), ["Admin", "Agent", "Manager", "Receptionist"]);
  assert.deepEqual(holders("chat:moderate"), ["Admin", "Manager"]);
  assert.deepEqual(PERMISSIONS.SuperAdmin, ["*"]);
  for (const r of ["Accountant", "HR", "Candidate", "Employer", "Agency"]) {
    assert.ok(!PERMISSIONS[r].some((p) => p.startsWith("chat:")), `${r} holds no chat:*`);
  }
  const all = [...new Set(Object.values(PERMISSIONS).flat().filter((p) => p.startsWith("chat:")))].sort();
  assert.deepEqual(all, ["chat:moderate", "chat:read", "chat:write"]);
});

test("checkPermission enforces chat:* per role", () => {
  const { checkPermission } = require("../middleware/role");
  const run = (role, perm) => {
    let out = "next";
    checkPermission(perm)({ user: { role } }, { status: (c) => ({ json: () => (out = c) }) }, () => (out = "next"));
    return out;
  };
  assert.equal(run("SuperAdmin", "chat:moderate"), "next");
  assert.equal(run("Manager", "chat:moderate"), "next");
  assert.equal(run("Admin", "chat:moderate"), "next");
  assert.equal(run("Agent", "chat:write"), "next");
  assert.equal(run("Receptionist", "chat:read"), "next");
  assert.equal(run("Agent", "chat:moderate"), 403);
  assert.equal(run("Receptionist", "chat:moderate"), 403);
  assert.equal(run("HR", "chat:read"), 403);
  assert.equal(run("Accountant", "chat:write"), 403);
  assert.equal(run("Candidate", "chat:read"), 403);
  assert.equal(run("Employer", "chat:write"), 403);
  assert.equal(run("Agency", "chat:read"), 403);
});

test("SETUP.md chat permission matrix equals PERMISSIONS (docs cannot drift)", () => {
  const doc = fs.readFileSync(path.join(ROOT, "..", "docs", "vita-job-search", "SETUP.md"), "utf8");
  const m = /<!-- chat-permission-matrix:start -->([\s\S]*?)<!-- chat-permission-matrix:end -->/.exec(doc);
  assert.ok(m, "SETUP.md has the chat-permission-matrix block");
  const lines = m[1].trim().split("\n").filter((l) => l.startsWith("|"));
  const header = lines[0].split("|").map((c) => c.trim()).filter(Boolean);
  const perms = header.slice(1).filter((h) => /^[a-z]+:[a-z]+$/.test(h));
  assert.deepEqual(perms, ["chat:read", "chat:write", "chat:moderate"]);
  const allChat = [...new Set(Object.values(PERMISSIONS).flat().filter((p) => p.startsWith("chat:")))].sort();
  assert.deepEqual(allChat, [...perms].sort(), "every chat:* grant in code is a documented column");
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
