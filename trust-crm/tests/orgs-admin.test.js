// Task 2 (portals): staff management of employers/agencies, invite, suspend/reactivate.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "orgs-admin-test-secret";
delete process.env.MAIL_PROVIDER;
delete process.env.MAIL_SANDBOX_ALLOWLIST;

const otp = () => require("../modules/jobsearch/otp");
const mail = () => require("../modules/jobsearch/mail");

async function withWorld(fn) {
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  otp()._testing.reset();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = (sql, p) => pool.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  const http = async (method, url, token, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await otp()._testing.flush();
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text };
  };
  const roles = { super: "SuperAdmin", admin: "Admin", mgr: "Manager", recep: "Receptionist", agent: "Agent", acct: "Accountant", hr: "HR" };
  const ids = {};
  for (const [k, role] of Object.entries(roles)) {
    ids[k] = (await one("INSERT INTO users (full_name,email,password,role) VALUES ($1,$2,'x',$3) RETURNING id", [`${role} ${k}`, `${k}@orgs.test.invalid`, role])).id;
  }
  ids.cand = (await one("INSERT INTO users (full_name,email,password,role) VALUES ('C','cand@orgs.test.invalid','x','Candidate') RETURNING id")).id;
  roles.cand = "Candidate";
  const T = Object.fromEntries(Object.keys(roles).map((k) => [k, jwt.sign({ id: ids[k], role: roles[k], ...(k === "cand" ? { tv: 0 } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" })]));
  const latestCode = async (email) => {
    const rows = await mail().sandbox.listOutbound({ to: email });
    assert.ok(rows.length > 0, "expected an OTP mail");
    return /\b(\d{6})\b/.exec(rows[rows.length - 1].body)[1];
  };
  const login = async (email) => {
    otp()._testing.reset();
    await http("POST", "/jobsearch/auth/otp/request", null, { email });
    return http("POST", "/jobsearch/auth/otp/verify", null, { email, code: await latestCode(email) });
  };
  try {
    await fn({ pool, q, one, http, ids, T, login, latestCode });
  } finally {
    await otp()._testing.flush();
    await new Promise((r) => server.close(r));
    await cleanup();
  }
}

const PATHS = { employer: "/crm/employers", agency: "/crm/agencies" };
const ROLE = { employer: "Employer", agency: "Agency" };
const TABLE = { employer: "crm_employers", agency: "crm_agencies" };

test("role matrix: reads need orgs:read, writes orgs:write; everyone else denied", async () => {
  await withWorld(async (w) => {
    const canRead = ["super", "admin", "mgr", "recep"];
    const canWrite = ["super", "admin", "mgr"];
    const denied = ["agent", "acct", "hr", "cand"];
    for (const type of ["employer", "agency"]) {
      const p = PATHS[type];
      const org = (await w.http("POST", p, w.T.admin, { name: `Seed ${type}` })).body;
      for (const k of [...canRead, ...denied]) {
        const r = await w.http("GET", p, w.T[k]);
        assert.equal(r.status, canRead.includes(k) ? 200 : 403, `${type} GET ${k}`);
        const d = await w.http("GET", `${p}/${org.id}`, w.T[k]);
        assert.equal(d.status, canRead.includes(k) ? 200 : 403, `${type} GET id ${k}`);
      }
      for (const k of [...canRead, ...denied]) {
        const writes = [
          ["POST", p, { name: `X ${k}` }],
          ["PATCH", `${p}/${org.id}`, { notes: `n ${k}` }],
          ["POST", `${p}/${org.id}/invite`, { email: `inv-${type}-${k}@x.test.invalid`, full_name: "Inv" }],
          ["POST", `${p}/${org.id}/suspend`, undefined],
          ["POST", `${p}/${org.id}/reactivate`, undefined],
        ];
        for (const [m, url, b] of writes) {
          const r = await w.http(m, url, w.T[k], b);
          if (canWrite.includes(k)) assert.ok(r.status === 200 || r.status === 201, `${type} ${m} ${url} ${k} -> ${r.status} ${r.text}`);
          else assert.equal(r.status, 403, `${type} ${m} ${url} ${k}`);
        }
      }
      assert.equal((await w.http("GET", p)).status, 401);
      assert.equal((await w.http("DELETE", `${p}/${org.id}`, w.T.admin)).status, 404, "no delete route");
    }
  });
});

test("Employer and Agency tokens are denied on every org route", async () => {
  await withWorld(async (w) => {
    const emp = (await w.http("POST", "/crm/employers", w.T.admin, { name: "E" })).body;
    const inv = await w.http("POST", `/crm/employers/${emp.id}/invite`, w.T.admin, { email: "e1@test.invalid", full_name: "E One" });
    assert.equal(inv.status, 201);
    const tok = (await w.login("e1@test.invalid")).body.token;
    for (const url of ["/crm/employers", "/crm/agencies", `/crm/employers/${emp.id}`]) assert.equal((await w.http("GET", url, tok)).status, 403);
    assert.equal((await w.http("POST", "/crm/employers", tok, { name: "no" })).status, 403);
    assert.equal((await w.http("POST", `/crm/employers/${emp.id}/suspend`, tok)).status, 403);
  });
});

for (const type of ["employer", "agency"]) {
  const p = PATHS[type];
  const table = TABLE[type];

  test(`${type}: create/update validation, caps, email shape, status not settable`, async () => {
    await withWorld(async (w) => {
      const bad = async (body, msg) => {
        const r = await w.http("POST", p, w.T.admin, body);
        assert.equal(r.status, 400, `${msg}: ${r.text}`);
      };
      await bad({}, "name required");
      await bad({ name: "   " }, "blank name");
      await bad({ name: 5 }, "non-string name");
      await bad({ name: "x".repeat(201) }, "name cap");
      await bad({ name: "ok", email: "not-an-email" }, "email shape");
      await bad({ name: "ok", phone: "1".repeat(41) }, "phone cap");
      await bad({ name: "ok", notes: "n".repeat(4001) }, "notes cap");
      await bad({ name: "ok", country: "a\u0000b" }, "NUL");
      await bad({ name: "ok", status: "active" }, "status not settable");
      await bad({ name: "ok", bogus: 1 }, "unknown field");
      const before = Number((await w.one(`SELECT count(*) n FROM ${table}`)).n);
      assert.equal(before, 0, "nothing inserted by rejected creates");

      const c = await w.http("POST", p, w.T.mgr, { name: "  Acme  ", email: "Contact@ACME.test.invalid", phone: "+216 1", country: "TN", notes: "n" });
      assert.equal(c.status, 201, c.text);
      assert.equal(c.body.name, "Acme");
      assert.equal(c.body.email, "contact@acme.test.invalid");
      assert.equal(c.body.status, type === "employer" ? "new" : "active");
      if (type === "employer") {
        const s = await w.http("POST", p, w.T.mgr, { name: "S", sector: "Hotels" });
        assert.equal(s.body.sector, "Hotels");
      } else {
        assert.equal((await w.http("POST", p, w.T.mgr, { name: "S", sector: "x" })).status, 400);
        assert.equal((await w.one("SELECT created_by FROM crm_agencies WHERE id=$1", [c.body.id])).created_by, w.ids.mgr);
      }

      const id = c.body.id;
      assert.equal((await w.http("PATCH", `${p}/${id}`, w.T.mgr, {})).status, 400, "empty patch");
      assert.equal((await w.http("PATCH", `${p}/${id}`, w.T.mgr, { status: "suspended" })).status, 400);
      assert.equal((await w.http("PATCH", `${p}/${id}`, w.T.mgr, { name: "" })).status, 400);
      assert.equal((await w.http("PATCH", `${p}/${id}`, w.T.mgr, { email: "bad" })).status, 400);
      const u = await w.http("PATCH", `${p}/${id}`, w.T.mgr, { name: "Acme 2", notes: null, contact_name: " Sam " });
      assert.equal(u.status, 200, u.text);
      assert.equal(u.body.name, "Acme 2");
      assert.equal(u.body.notes, null);
      assert.equal(u.body.contact_name, "Sam");
      assert.equal((await w.http("PATCH", `${p}/999999`, w.T.mgr, { name: "z" })).status, 404);
      assert.equal((await w.http("PATCH", `${p}/abc`, w.T.mgr, { name: "z" })).status, 400);
      assert.equal((await w.http("GET", `${p}/999999`, w.T.mgr)).status, 404);
    });
  });

  test(`${type}: audit and timeline rows for every mutation, one transaction`, async () => {
    await withWorld(async (w) => {
      const id = (await w.http("POST", p, w.T.admin, { name: "Acme" })).body.id;
      await w.http("PATCH", `${p}/${id}`, w.T.admin, { phone: "123" });
      await w.http("POST", `${p}/${id}/invite`, w.T.admin, { email: `a-${type}@test.invalid`, full_name: "A" });
      await w.http("POST", `${p}/${id}/suspend`, w.T.admin);
      await w.http("POST", `${p}/${id}/reactivate`, w.T.admin);
      const tl = (await w.q("SELECT event, actor_id FROM crm_timeline WHERE entity=$1 AND entity_id=$2 ORDER BY id", [type, id])).rows;
      assert.deepEqual(tl.map((r) => r.event), ["created", "updated", "portal_user_invited", "suspended", "reactivated"]);
      assert.ok(tl.every((r) => r.actor_id === w.ids.admin));
      const audit = (await w.q("SELECT action, user_id FROM audit_logs WHERE action LIKE $1 ORDER BY id", [`crm.${type}.%`])).rows;
      assert.deepEqual(audit.map((r) => r.action), ["create", "update", "invite", "suspend", "reactivate"].map((a) => `crm.${type}.${a}`));
      assert.ok(audit.every((r) => r.user_id === w.ids.admin));
      const detail = (await w.http("GET", `${p}/${id}`, w.T.admin)).body;
      assert.equal(detail.timeline.length, 5);
      assert.equal(detail.portal_users.length, 1);
      // failed validation writes nothing
      const n = Number((await w.one("SELECT count(*) n FROM audit_logs")).n);
      await w.http("PATCH", `${p}/${id}`, w.T.admin, { email: "bad" });
      assert.equal(Number((await w.one("SELECT count(*) n FROM audit_logs")).n), n);
      // no password hash anywhere in any response
      assert.ok(!JSON.stringify(detail).includes("$2"));
    });
  });

  test(`${type}: list filters, q escaping, limit cap, offset`, async () => {
    await withWorld(async (w) => {
      const mk = (name, extra = {}) => w.http("POST", p, w.T.admin, { name, ...extra });
      const a = (await mk("Alpha Corp", { email: "a@x.test.invalid" })).body;
      await mk("100% Real", {});
      await mk("Under_score", {});
      await mk("Plain");
      await w.http("POST", `${p}/${a.id}/suspend`, w.T.admin);
      const l = async (qs) => w.http("GET", `${p}${qs}`, w.T.recep);
      assert.equal((await l("")).body.total, 4);
      assert.deepEqual((await l("?status=suspended")).body.rows.map((r) => r.name), ["Alpha Corp"]);
      assert.equal((await l("?status=bogus")).status, 400);
      assert.equal((await l("?q=alpha")).body.total, 1);
      assert.equal((await l("?q=a@x.test")).body.total, 1);
      assert.equal((await l("?q=%25")).body.total, 1, "% is literal");
      assert.equal((await l("?q=_")).body.total, 1, "_ is literal");
      assert.equal((await l("?q=" + "x".repeat(101))).status, 400);
      assert.equal((await l("?q=a&q=b")).status, 400);
      assert.equal((await l("?limit=2")).body.rows.length, 2);
      assert.equal((await l("?limit=2&offset=3")).body.rows.length, 1);
      assert.equal((await l("?limit=0")).status, 400);
      assert.equal((await l("?offset=-1")).status, 400);
      assert.equal((await l("?limit=100000")).status, 200);
      for (let i = 0; i < 3; i += 1) await mk(`Bulk ${i}`);
      assert.ok((await l("?limit=100000")).body.rows.length <= 100);
      const row = (await l("?q=alpha")).body.rows[0];
      assert.equal(row.portal_users, 0);
      assert.ok(!("password" in row));
    });
  });

  test(`${type}: invite happy path, sandbox OTP login, unusable password, several users per org`, async () => {
    await withWorld(async (w) => {
      const id = (await w.http("POST", p, w.T.admin, { name: "Acme" })).body.id;
      const r = await w.http("POST", `${p}/${id}/invite`, w.T.admin, { email: "  Person@Test.Invalid ", full_name: " Pat Person " });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.body.inviteSent, true);
      assert.equal(r.body.user.email, "person@test.invalid");
      assert.equal(r.body.user.role, ROLE[type]);
      assert.ok(!r.text.includes("$2") && !("password" in r.body.user));
      const u = await w.one("SELECT * FROM users WHERE id=$1", [r.body.user.id]);
      assert.equal(u.role, ROLE[type]);
      assert.equal(u.is_active, true);
      assert.equal(u.full_name, "Pat Person");
      assert.match(u.password, /^\$2[aby]\$/);
      const link = await w.one("SELECT * FROM crm_org_accounts WHERE user_id=$1", [u.id]);
      assert.equal(link.org_type, type);
      assert.equal(Number(link.org_id), Number(id));
      // the password hash is unusable: password login is impossible
      const pw = await w.http("POST", "/auth/login", null, { email: "person@test.invalid", password: "anything" });
      assert.notEqual(pw.status, 200);
      // login by code
      const v = await w.login("person@test.invalid");
      assert.equal(v.status, 200, v.text);
      assert.equal(v.body.role, ROLE[type]);
      // a second portal user on the same org is allowed
      const r2 = await w.http("POST", `${p}/${id}/invite`, w.T.admin, { email: "second@test.invalid", full_name: "Second" });
      assert.equal(r2.status, 201);
      // re-inviting an already-linked email: 409
      assert.equal((await w.http("POST", `${p}/${id}/invite`, w.T.admin, { email: "person@test.invalid", full_name: "Pat" })).status, 409);
      // validation / 404
      assert.equal((await w.http("POST", `${p}/${id}/invite`, w.T.admin, { email: "nope", full_name: "X" })).status, 400);
      assert.equal((await w.http("POST", `${p}/${id}/invite`, w.T.admin, { email: "ok@test.invalid" })).status, 400);
      assert.equal((await w.http("POST", `${p}/${id}/invite`, w.T.admin, { email: "ok@test.invalid", full_name: "x".repeat(201) })).status, 400);
      assert.equal((await w.http("POST", `${p}/999999/invite`, w.T.admin, { email: "ok@test.invalid", full_name: "X" })).status, 404);
    });
  });

  test(`${type}: invite 409s (staff, candidate, other role, other org, suspended org, inactive) leave no residue`, async () => {
    await withWorld(async (w) => {
      const id = (await w.http("POST", p, w.T.admin, { name: "Acme" })).body.id;
      const other = (await w.http("POST", p, w.T.admin, { name: "Other" })).body.id;
      const otherRole = type === "employer" ? "Agency" : "Employer";
      await w.q("INSERT INTO users (full_name,email,password,role) VALUES ('O','otherrole@test.invalid','x',$1)", [otherRole]);
      await w.q("INSERT INTO users (full_name,email,password,role,is_active) VALUES ('I','inactive@test.invalid','x',$1,false)", [ROLE[type]]);
      assert.equal((await w.http("POST", `${p}/${other}/invite`, w.T.admin, { email: "owned@test.invalid", full_name: "Owned" })).status, 201);
      const before = { users: (await w.one("SELECT count(*)::int n FROM users")).n, links: (await w.one("SELECT count(*)::int n FROM crm_org_accounts")).n, tl: (await w.one("SELECT count(*)::int n FROM crm_timeline")).n, audit: (await w.one("SELECT count(*)::int n FROM audit_logs")).n, otps: (await w.one("SELECT count(*)::int n FROM js_otps")).n };
      for (const email of ["admin@orgs.test.invalid", "ADMIN@orgs.test.invalid", "recep@orgs.test.invalid", "cand@orgs.test.invalid", "otherrole@test.invalid", "inactive@test.invalid", "owned@test.invalid"]) {
        const r = await w.http("POST", `${p}/${id}/invite`, w.T.admin, { email, full_name: "X" });
        assert.equal(r.status, 409, `${email}: ${r.text}`);
      }
      const after = { users: (await w.one("SELECT count(*)::int n FROM users")).n, links: (await w.one("SELECT count(*)::int n FROM crm_org_accounts")).n, tl: (await w.one("SELECT count(*)::int n FROM crm_timeline")).n, audit: (await w.one("SELECT count(*)::int n FROM audit_logs")).n, otps: (await w.one("SELECT count(*)::int n FROM js_otps")).n };
      assert.deepEqual(after, before);
      assert.equal((await w.one("SELECT role FROM users WHERE email='admin@orgs.test.invalid'")).role, "Admin", "staff user untouched");
      // an unlinked same-role user is adopted
      await w.q("INSERT INTO users (full_name,email,password,role) VALUES ('U','unlinked@test.invalid','x',$1)", [ROLE[type]]);
      assert.equal((await w.http("POST", `${p}/${id}/invite`, w.T.admin, { email: "unlinked@test.invalid", full_name: "U" })).status, 201);
      // suspended org cannot invite
      await w.http("POST", `${p}/${id}/suspend`, w.T.admin);
      assert.equal((await w.http("POST", `${p}/${id}/invite`, w.T.admin, { email: "late@test.invalid", full_name: "L" })).status, 409);
    });
  });

  test(`${type}: suspend kills an issued token at once, blocks login; reactivate restores login`, async () => {
    await withWorld(async (w) => {
      const id = (await w.http("POST", p, w.T.admin, { name: "Acme" })).body.id;
      const email = "who@test.invalid";
      await w.http("POST", `${p}/${id}/invite`, w.T.admin, { email, full_name: "Who" });
      const token = (await w.login(email)).body.token;
      assert.equal((await w.http("GET", "/jobsearch/auth/me", token)).status, 200);
      const uid = (await w.one("SELECT id, token_version FROM users WHERE email=$1", [email]));

      const s = await w.http("POST", `${p}/${id}/suspend`, w.T.mgr);
      assert.equal(s.status, 200, s.text);
      assert.equal(s.body.status, "suspended");
      const after = await w.one("SELECT is_active, token_version FROM users WHERE id=$1", [uid.id]);
      assert.equal(after.is_active, false);
      assert.ok(after.token_version > uid.token_version);
      assert.equal((await w.http("GET", "/jobsearch/auth/me", token)).status, 401, "old token dead immediately");
      otp()._testing.reset();
      const req = await w.http("POST", "/jobsearch/auth/otp/request", null, { email });
      assert.equal(req.status, 200);
      const mails = (await mail().sandbox.listOutbound({ to: email })).length;
      assert.equal(mails, 1, "no new code while suspended (only the invite code)");
      // suspending twice is a no-op (no extra audit row)
      const n = Number((await w.one("SELECT count(*) n FROM audit_logs WHERE action=$1", [`crm.${type}.suspend`])).n);
      assert.equal((await w.http("POST", `${p}/${id}/suspend`, w.T.mgr)).status, 200);
      assert.equal(Number((await w.one("SELECT count(*) n FROM audit_logs WHERE action=$1", [`crm.${type}.suspend`])).n), n);

      const r = await w.http("POST", `${p}/${id}/reactivate`, w.T.mgr);
      assert.equal(r.body.status, "active");
      assert.equal((await w.http("GET", "/jobsearch/auth/me", token)).status, 401, "old token stays dead after reactivation");
      await w.q("UPDATE js_otps SET created_at = created_at - interval '5 minutes' WHERE email = $1", [email]); // clear the DB resend cooldown
      const again = await w.login(email);
      assert.equal(again.status, 200, again.text);
      assert.equal((await w.http("GET", "/jobsearch/auth/me", again.body.token)).status, 200);
      assert.equal((await w.http("POST", `${p}/999999/suspend`, w.T.mgr)).status, 404);
    });
  });
}

test("suspending one org does not touch another org's users or an unrelated staff user", async () => {
  await withWorld(async (w) => {
    const a = (await w.http("POST", "/crm/employers", w.T.admin, { name: "A" })).body.id;
    const b = (await w.http("POST", "/crm/employers", w.T.admin, { name: "B" })).body.id;
    await w.http("POST", `/crm/employers/${a}/invite`, w.T.admin, { email: "a@test.invalid", full_name: "A" });
    await w.http("POST", `/crm/employers/${b}/invite`, w.T.admin, { email: "b@test.invalid", full_name: "B" });
    const tb = (await w.login("b@test.invalid")).body.token;
    await w.http("POST", `/crm/employers/${a}/suspend`, w.T.admin);
    assert.equal((await w.http("GET", "/jobsearch/auth/me", tb)).status, 200);
    assert.equal((await w.one("SELECT is_active FROM users WHERE email='b@test.invalid'")).is_active, true);
    assert.equal((await w.one("SELECT token_version FROM users WHERE id=$1", [w.ids.admin])).token_version, 0);
  });
});
