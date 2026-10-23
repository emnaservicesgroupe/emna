// Public API (/public/config, /public/jobs, /public/leads): validation, consent, honeypot, dedupe,
// DB rate limits, field allowlists.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb, loadApp } = require("./helpers/db");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "site-public-test-secret";
process.env.SITE_IP_SALT = "test-salt";

async function withWorld(fn, envIn = {}) {
  const saved = {};
  const env = { SITE_LEAD_IP_PER_HOUR: "1000", SITE_LEAD_EMAIL_PER_DAY: "1000", ...envIn };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { pool, cleanup } = await createTestDb();
  const app = loadApp(pool);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  let ipn = 0;
  const http = async (method, url, body, headers = {}, raw) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined && raw === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const post = (body, headers) => http("POST", "/public/leads", body, headers);
  const cand = (over = {}) => ({ kind: "candidate", name: "Amine Ben Salah", email: `a${++ipn}@x.test`, phone: "+216 20 123 456", consent: true, lang: "fr", ...over });
  try {
    await fn({ pool, one, http, post, cand });
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("valid candidate lead stored with consent, hashed ip, no raw ip/user-agent", async () => {
  await withWorld(async ({ one, post, cand }) => {
    const r = await post(cand({ email: "Amine@Example.TEST", profession: "Welder", country: "Canada", message: "Hello" }), { "user-agent": "SecretAgent/9" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    const row = await one("SELECT * FROM crm_leads");
    assert.equal(row.kind, "candidate");
    assert.equal(row.status, "new");
    assert.equal(row.email, "amine@example.test");
    assert.ok(row.consent_at);
    assert.ok(row.consent_text_version);
    assert.equal(row.source, "website");
    assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
    const dump = JSON.stringify(row);
    assert.ok(!dump.includes("127.0.0.1") && !dump.includes("::1") && !dump.includes("SecretAgent"));
    const crypto = require("crypto");
    const hashes = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].map((ip) => crypto.createHash("sha256").update("test-salt" + ip).digest("hex"));
    assert.ok(hashes.includes(row.ip_hash));
  });
});

test("consent required for candidate and employer, not for contact", async () => {
  await withWorld(async ({ post, cand, pool }) => {
    for (const kind of ["candidate", "employer"]) {
      for (const consent of [undefined, false, "true", "yes", 1]) {
        const r = await post(cand({ kind, consent }));
        assert.equal(r.status, 400, `${kind} consent=${String(consent)}`);
      }
    }
    assert.equal((await pool.query("SELECT 1 FROM crm_leads")).rowCount, 0);
    const c = await post({ kind: "contact", name: "Sam", email: "sam@x.test", message: "Question" });
    assert.equal(c.status, 200);
  });
});

test("honeypot answers ok:true, stores status=spam, never collides with real leads", async () => {
  await withWorld(async ({ pool, post, cand }) => {
    const e = "bot@x.test";
    for (let i = 0; i < 2; i += 1) {
      const r = await post(cand({ email: e, website: "http://spam.example" }));
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true });
    }
    let rows = (await pool.query("SELECT status, dedupe_key FROM crm_leads")).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.status === "spam"));
    const real = await post(cand({ email: e }));
    assert.equal(real.status, 200);
    rows = (await pool.query("SELECT status FROM crm_leads WHERE status <> 'spam'")).rows;
    assert.equal(rows.length, 1);
  });
});

test("honeypot with junk fields still answers ok and stores spam", async () => {
  await withWorld(async ({ pool, post }) => {
    const r = await post({ kind: "weird", name: 42, email: "nope", website: "x", consent: false });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    const row = (await pool.query("SELECT status, kind FROM crm_leads")).rows[0];
    assert.equal(row.status, "spam");
  });
});

test("validation: kind, name, email/phone shape, contact needs email or phone", async () => {
  await withWorld(async ({ pool, post, cand }) => {
    const bad = [
      cand({ kind: "other" }),
      cand({ kind: undefined }),
      cand({ name: "" }),
      cand({ name: "   " }),
      cand({ name: 42 }),
      cand({ email: "not-an-email" }),
      cand({ email: "a@b" }),
      cand({ email: "a b@x.test" }),
      cand({ email: `${"a".repeat(250)}@x.test` }),
      cand({ phone: "abc" }),
      cand({ phone: "123" }),
      cand({ phone: "+".repeat(30) }),
      cand({ email: undefined, phone: undefined }),
      cand({ name: "x\u0000y" }),
      cand({ country: "c".repeat(81) }),
      cand({ profession: "p".repeat(121) }),
      cand({ company: "c".repeat(161) }),
    ];
    for (const b of bad) {
      const r = await post(b);
      assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80));
      assert.ok(r.body && typeof r.body.error === "string");
    }
    assert.equal((await pool.query("SELECT 1 FROM crm_leads")).rowCount, 0);
    assert.equal((await post([1, 2])).status, 400);
  });
});

test("length caps: name 120 and message 4000 enforced, a 10000-char message is rejected", async () => {
  await withWorld(async ({ post, cand, pool }) => {
    assert.equal((await post(cand({ name: "n".repeat(121) }))).status, 400);
    assert.equal((await post(cand({ message: "m".repeat(10000) }))).status, 400);
    assert.equal((await post(cand({ message: "m".repeat(4001) }))).status, 400);
    assert.equal((await post(cand({ name: "n".repeat(120), message: "m".repeat(4000) }))).status, 200);
    const row = (await pool.query("SELECT length(name) AS n, length(message) AS m FROM crm_leads")).rows[0];
    assert.equal(row.n, 120);
    assert.equal(row.m, 4000);
  });
});

test("oversized or malformed JSON bodies get a clean 4xx without echoing the body", async () => {
  await withWorld(async ({ http, post, cand }) => {
    const big = await http("POST", "/public/leads", undefined, {}, JSON.stringify({ message: "z".repeat(20000) }));
    assert.equal(big.status, 413);
    assert.ok(!big.text.includes("zzzz"));
    const bad = await http("POST", "/public/leads", undefined, {}, '{"name": "SECRETVALUE", ');
    assert.equal(bad.status, 400);
    assert.ok(!bad.text.includes("SECRETVALUE"));
    const logs = [];
    const orig = console.error;
    console.error = (...a) => logs.push(a.join(" "));
    try {
      await http("POST", "/public/leads", undefined, {}, '{"name": "SECRETVALUE", ');
    } finally {
      console.error = orig;
    }
    assert.ok(!logs.join("\n").includes("SECRETVALUE"));
    const ok = await post(cand());
    assert.equal(ok.status, 200);
  });
});

test("Unicode/RTL names and HTML text are stored verbatim", async () => {
  await withWorld(async ({ post, cand, pool }) => {
    const rtl = "محمد بن علي ‏";
    const html = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    assert.equal((await post(cand({ name: rtl, message: html, profession: "<b>Cook</b>" }))).status, 200);
    const row = (await pool.query("SELECT name, message, profession FROM crm_leads")).rows[0];
    assert.equal(row.name, rtl);
    assert.equal(row.message, html);
    assert.equal(row.profession, "<b>Cook</b>");
  });
});

test("same email twice within 24h updates one row and bumps updated_at", async () => {
  await withWorld(async ({ post, cand, pool }) => {
    const email = "dup@x.test";
    assert.equal((await post(cand({ email, phone: undefined, message: "first" }))).status, 200);
    await pool.query("UPDATE crm_leads SET updated_at = now() - interval '1 hour'");
    const before = (await pool.query("SELECT id, updated_at FROM crm_leads")).rows[0];
    const r = await post(cand({ email: "DUP@x.test", phone: undefined, message: "second" }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    const rows = (await pool.query("SELECT * FROM crm_leads")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, before.id);
    assert.equal(rows[0].message, "second");
    assert.ok(rows[0].updated_at > before.updated_at);
  });
});

test("same normalized phone dedupes; different kind does not; older than 24h does not", async () => {
  await withWorld(async ({ post, cand, pool }) => {
    assert.equal((await post(cand({ email: undefined, phone: "+216 20 123 456" }))).status, 200);
    assert.equal((await post(cand({ email: undefined, phone: "+216-20-123-456" }))).status, 200);
    assert.equal((await pool.query("SELECT 1 FROM crm_leads")).rowCount, 1);
    assert.equal((await post(cand({ kind: "employer", email: undefined, phone: "+216 20 123 456" }))).status, 200);
    assert.equal((await pool.query("SELECT 1 FROM crm_leads")).rowCount, 2);
    await pool.query("UPDATE crm_leads SET created_at = now() - interval '30 hours', dedupe_key = 'old:' || id");
    assert.equal((await post(cand({ email: undefined, phone: "+216 20 123 456" }))).status, 200);
    assert.equal((await pool.query("SELECT 1 FROM crm_leads")).rowCount, 3);
  });
});

test("concurrent duplicate submissions still produce one row", async () => {
  await withWorld(async ({ post, cand, pool }) => {
    const body = cand({ email: "race@x.test", phone: undefined });
    const rs = await Promise.all(Array.from({ length: 3 }, () => post(body)));
    assert.ok(rs.every((r) => r.status === 200 || r.status === 429));
    assert.equal((await pool.query("SELECT 1 FROM crm_leads WHERE email='race@x.test'")).rowCount, 1);
  });
});

test("per-IP limit: 6th submit in the hour is 429 with Retry-After", async () => {
  await withWorld(async ({ post, cand }) => {
    for (let i = 0; i < 5; i += 1) assert.equal((await post(cand())).status, 200, `hit ${i + 1}`);
    const r = await post(cand());
    assert.equal(r.status, 429);
    const ra = Number(r.headers.get("retry-after"));
    assert.ok(ra >= 1 && ra <= 3600);
  }, { SITE_LEAD_IP_PER_HOUR: undefined });
});

test("per-IP limit is env tunable and counts honeypot hits", async () => {
  await withWorld(
    async ({ post, cand }) => {
      assert.equal((await post(cand({ website: "x" }))).status, 200);
      assert.equal((await post(cand())).status, 200);
      assert.equal((await post(cand())).status, 429);
    },
    { SITE_LEAD_IP_PER_HOUR: "2" }
  );
});

test("per-email limit: 4th submit for one email per day is 429 with Retry-After", async () => {
  await withWorld(async ({ post, cand }) => {
    for (let i = 0; i < 3; i += 1) assert.equal((await post(cand({ email: "same@x.test" }))).status, 200);
    const r = await post(cand({ email: "same@x.test" }));
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) >= 1);
    assert.equal((await post(cand({ email: "other@x.test" }))).status, 200);
  }, { SITE_LEAD_EMAIL_PER_DAY: undefined });
});

test("rate limit rows hold hashes only, never the raw ip or email", async () => {
  await withWorld(async ({ post, cand, pool }) => {
    await post(cand({ email: "private@x.test" }));
    const rows = (await pool.query("SELECT key FROM public_rate_limit")).rows;
    assert.ok(rows.length >= 2);
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes("private@x.test") && !dump.includes("127.0.0.1") && !dump.includes("::1"));
  });
});

test("rateLimit.hit enforces max per window", async () => {
  await withWorld(async ({ pool }) => {
    const { hit } = require("../modules/site/rateLimit");
    const o = { windowMs: 3600000, max: 2 };
    assert.equal((await hit(pool, "k1", o)).allowed, true);
    assert.equal((await hit(pool, "k1", o)).allowed, true);
    const third = await hit(pool, "k1", o);
    assert.equal(third.allowed, false);
    assert.ok(third.retryAfter >= 1);
    assert.equal((await hit(pool, "k2", o)).allowed, true);
  });
});

test("missing SITE_IP_SALT does not crash", async () => {
  await withWorld(
    async ({ post, cand }) => {
      assert.equal((await post(cand())).status, 200);
    },
    { SITE_IP_SALT: undefined }
  );
});

const ALLOWED = ["id", "title", "employer_name", "country", "city", "category", "description", "requirements", "language_requirements", "employment_type", "salary_text", "apply_mode", "published_at", "closes_at"].sort();

test("/public/jobs returns only live published rows with exactly the allowlisted keys", async () => {
  await withWorld(async ({ http, pool, one }) => {
    const ins = (title, status, closes, extra = {}) =>
      one(
        `INSERT INTO site_jobs (title, employer_name, country, category, description, evidence_note, status, published_at, closes_at)
         VALUES ($1,'Acme',$2,$3,'<b>desc</b>','secret evidence',$4,CASE WHEN $4='published' THEN now() END,$5) RETURNING id`,
        [title, extra.country || "Canada", extra.category || "trade", status, closes]
      );
    const pub = await ins("Welder", "published", null);
    await ins("Draft job", "draft", null);
    await ins("Closed job", "closed", null);
    await ins("Expired", "published", new Date(Date.now() - 3600e3));
    await ins("Future close", "published", new Date(Date.now() + 3600e3), { country: "Germany", category: "care" });
    const list = await http("GET", "/public/jobs");
    assert.equal(list.status, 200);
    const titles = list.body.jobs.map((j) => j.title).sort();
    assert.deepEqual(titles, ["Future close", "Welder"]);
    for (const j of list.body.jobs) assert.deepEqual(Object.keys(j).sort(), ALLOWED);
    assert.ok(!list.text.includes("secret evidence"));
    assert.equal((await http("GET", "/public/jobs?country=germany")).body.jobs.length, 1);
    assert.equal((await http("GET", "/public/jobs?category=trade")).body.jobs.length, 1);
    assert.equal((await http("GET", "/public/jobs?limit=1&offset=1")).body.jobs.length, 1);
    assert.equal((await http("GET", "/public/jobs?limit=9999")).status, 200);
    const one1 = await http("GET", `/public/jobs/${pub.id}`);
    assert.equal(one1.status, 200);
    assert.deepEqual(Object.keys(one1.body).sort(), ALLOWED);
    assert.equal(one1.body.description, "<b>desc</b>");
    const draftId = (await pool.query("SELECT id FROM site_jobs WHERE status='draft'")).rows[0].id;
    assert.equal((await http("GET", `/public/jobs/${draftId}`)).status, 404);
    assert.equal((await http("GET", "/public/jobs/abc")).status, 404);
    assert.equal((await http("GET", "/public/jobs/999999")).status, 404);
  });
});

test("/public/config omits unset facts and defaults the name to VITA", async () => {
  await withWorld(
    async ({ http }) => {
      const r = await http("GET", "/public/config");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { name: "VITA" });
    },
    { SITE_NAME: undefined, SITE_PHONE: undefined, SITE_WHATSAPP: undefined, SITE_EMAIL: undefined, SITE_ADDRESS: undefined, SITE_LICENCE_TEXT: undefined }
  );
  await withWorld(
    async ({ http }) => {
      const r = await http("GET", "/public/config");
      assert.deepEqual(r.body, { name: "Vita Co", phone: "+1 555 0100", licence: "Lic. 123" });
    },
    { SITE_NAME: "Vita Co", SITE_PHONE: "+1 555 0100", SITE_LICENCE_TEXT: "Lic. 123", SITE_EMAIL: "  ", SITE_WHATSAPP: undefined, SITE_ADDRESS: undefined }
  );
});
