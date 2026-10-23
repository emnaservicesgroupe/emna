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
      const r = await post(cand({ email: e, hp_url: "http://spam.example" }));
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
    const r = await post({ kind: "weird", name: 42, email: "nope", hp_url: "x", consent: false });
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
    assert.equal(rows[0].message, "first", "an existing message is kept; the resubmission adds nothing");
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
      assert.equal((await post(cand({ hp_url: "x" }))).status, 200);
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

// ---------------------------------------------------------------- review round 1

test("review 1.1: a same-email submission never touches a converted or rejected lead, and creates no duplicate", async () => {
  await withWorld(async ({ post, cand, pool }) => {
    for (const status of ["converted", "rejected"]) {
      const email = `${status}@x.test`;
      assert.equal((await post(cand({ email, phone: undefined, name: "Original", message: "orig" }))).status, 200);
      await pool.query("UPDATE crm_leads SET status=$2, consent_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' WHERE email=$1", [email, status]);
      const before = (await pool.query("SELECT * FROM crm_leads WHERE email=$1", [email])).rows[0];
      const r = await post(cand({ email, phone: "+216 99 999 999", name: "Attacker", country: "Evil", message: "owned", consent: true }));
      assert.equal(r.status, 200, status);
      assert.deepEqual(r.body, { ok: true });
      const rows = (await pool.query("SELECT * FROM crm_leads WHERE email=$1", [email])).rows;
      assert.equal(rows.length, 1, `${status}: no duplicate`);
      assert.deepEqual(rows[0], before, `${status}: row unchanged`);
    }
  });
});

test("review 1.1: an update never refreshes consent_at or name; contact fields are fill-if-null; message only when empty", async () => {
  await withWorld(async ({ post, cand, pool }) => {
    const email = "keep@x.test";
    assert.equal((await post(cand({ email, phone: undefined, name: "Real Name", message: undefined }))).status, 200);
    await pool.query("UPDATE crm_leads SET consent_at = now() - interval '3 hours', consent_text_version = 'old-v'");
    const before = (await pool.query("SELECT * FROM crm_leads")).rows[0];
    assert.equal((await post(cand({ email, phone: "+216 22 222 222", name: "Other Name", country: "Canada", message: "now filled" }))).status, 200);
    let row = (await pool.query("SELECT * FROM crm_leads")).rows[0];
    assert.equal(row.name, "Real Name");
    assert.deepEqual(row.consent_at, before.consent_at, "consent_at not refreshed");
    assert.equal(row.consent_text_version, "old-v");
    assert.equal(row.phone, "+216 22 222 222", "empty phone filled");
    assert.equal(row.country, "Canada", "empty country filled");
    assert.equal(row.message, "now filled", "empty message filled");
    assert.equal((await post(cand({ email, phone: "+216 33 333 333", country: "Germany", message: "replace?" }))).status, 200);
    row = (await pool.query("SELECT * FROM crm_leads")).rows[0];
    assert.equal(row.phone, "+216 22 222 222");
    assert.equal(row.country, "Canada");
    assert.equal(row.message, "now filled");
  });
});

test("review 1.3: pathological limit/offset never give a 500", async () => {
  await withWorld(async ({ http, one }) => {
    await one("INSERT INTO site_jobs (title, country, description, evidence_note, status, published_at) VALUES ('A','Canada','d','e','published',now()) RETURNING id");
    for (const q of ["offset=1e30", "offset=99999999999999999999", "offset=-5", "offset=abc", "offset=Infinity", "limit=1e30", "limit=abc", "limit=0.5", "offset=100001", "offset=%00"]) {
      const r = await http("GET", `/public/jobs?${q}`);
      assert.ok(r.status === 200 || r.status === 400, `${q} -> ${r.status}`);
    }
    assert.equal((await http("GET", "/public/jobs?offset=abc")).body.jobs.length, 1, "non-numeric offset falls back to the default");
    assert.equal((await http("GET", "/public/jobs?offset=100000")).status, 200);
    assert.equal((await http("GET", "/public/jobs?offset=1")).body.jobs.length, 0);
    assert.equal((await http("GET", "/public/jobs?limit=abc")).body.jobs.length, 1);
  });
  const { listPublishedJobs } = require("../modules/site/siteJobs");
  const seen = [];
  const fake = { query: async (_s, p) => (seen.push(p), { rows: [] }) };
  await listPublishedJobs(fake, { limit: "1e30", offset: "1e30" });
  await listPublishedJobs(fake, { limit: "7", offset: "99999999999999999999" });
  await listPublishedJobs(fake, { limit: "7", offset: "250000" });
  await listPublishedJobs(fake, { limit: "7", offset: "40" });
  assert.deepEqual(seen.map((p) => p.slice(-2)), [[20, 0], [7, 0], [7, 100000], [7, 40]]);
});

test("review 1.4: honeypot field is hp_url; only a non-blank value is spam; no other field name is", async () => {
  await withWorld(async ({ pool, post, cand }) => {
    assert.equal((await post(cand({ hp_url: "   ", phone: undefined }))).status, 200);
    assert.equal((await post(cand({ hp_url: "", phone: undefined }))).status, 200);
    assert.equal((await pool.query("SELECT 1 FROM crm_leads WHERE status <> 'spam'")).rowCount, 2, "blank hp_url is a real lead");
    assert.equal((await post(cand({ website: "http://autofilled.example" }))).status, 200);
    assert.equal((await post(cand({ url: "x", homepage: "x", hp: "x" }))).status, 200);
    assert.equal((await pool.query("SELECT 1 FROM crm_leads WHERE status = 'spam'")).rowCount, 0, "legacy 'website' and other names are not honeypots");
    assert.equal((await post(cand({ hp_url: " http://bot " }))).status, 200);
    assert.equal((await pool.query("SELECT 1 FROM crm_leads WHERE status = 'spam'")).rowCount, 1);
  });
});

test("review 1.5: without SITE_IP_SALT a random per-process salt is used (never the old fixed string); one warning in production", () => {
  const modPath = require.resolve("../modules/site/rateLimit");
  const crypto = require("crypto");
  const savedSalt = process.env.SITE_IP_SALT;
  const savedEnv = process.env.NODE_ENV;
  const savedWarn = console.warn;
  const warnings = [];
  delete process.env.SITE_IP_SALT;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    delete require.cache[modPath];
    const a = require("../modules/site/rateLimit");
    const fixed = crypto.createHash("sha256").update("vita-dev-insecure-salt" + "1.2.3.4").digest("hex");
    assert.notEqual(a.hashWithSalt("1.2.3.4"), fixed);
    assert.equal(a.hashWithSalt("1.2.3.4"), a.hashWithSalt("1.2.3.4"), "stable inside one process");
    assert.equal(warnings.length, 0, "no warning outside production");
    delete require.cache[modPath];
    const b = require("../modules/site/rateLimit");
    assert.notEqual(b.hashWithSalt("1.2.3.4"), a.hashWithSalt("1.2.3.4"), "a new process (module load) gets a new salt");
    process.env.NODE_ENV = "production";
    b.hashWithSalt("x");
    b.hashWithSalt("y");
    assert.equal(warnings.filter((w) => /SITE_IP_SALT/.test(w)).length, 1, "exactly one warning");
  } finally {
    console.warn = savedWarn;
    process.env.NODE_ENV = savedEnv;
    if (savedSalt === undefined) delete process.env.SITE_IP_SALT;
    else process.env.SITE_IP_SALT = savedSalt;
    delete require.cache[modPath];
  }
});

test("review 1.7: IPv6 is bucketed by /64 and IPv4-mapped IPv6 as IPv4", () => {
  const { bucketIp } = require("../modules/site/rateLimit");
  assert.equal(bucketIp("203.0.113.9"), "203.0.113.9");
  assert.equal(bucketIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(bucketIp("::FFFF:cb00:7109"), "203.0.113.9", "hex form of a mapped address");
  const a = bucketIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
  assert.equal(a, bucketIp("2001:0DB8:0001:0002:1:2:3:4"));
  assert.equal(a, bucketIp("2001:db8:1:2::9"));
  assert.equal(a, bucketIp("2001:db8:1:2:1:2:3:4%eth0"));
  assert.notEqual(a, bucketIp("2001:db8:1:3:aaaa:bbbb:cccc:dddd"));
  assert.notEqual(a, bucketIp("203.0.113.9"));
  assert.equal(bucketIp("::1"), bucketIp("0:0:0:0:ffff:ffff:ffff:ffff"));
  assert.equal(bucketIp(undefined), "");
  assert.equal(bucketIp("not an ip"), "not an ip");
});

test("review 1.7: hashes for ip_hash and the ip limit use the /64 bucket", async () => {
  await withWorld(async ({ pool, post, cand }) => {
    const { createLead } = require("../modules/site/leadService");
    const { hashWithSalt } = require("../modules/site/rateLimit");
    await createLead(pool, cand({ email: "v6a@x.test" }), { ip: "2001:db8:1:2:aaaa::1" });
    await createLead(pool, cand({ email: "v6b@x.test" }), { ip: "2001:db8:1:2:bbbb::2" });
    const hashes = (await pool.query("SELECT DISTINCT ip_hash FROM crm_leads")).rows;
    assert.equal(hashes.length, 1, "same /64 -> same ip_hash");
    assert.ok(!JSON.stringify(hashes).includes(hashWithSalt("2001:db8:1:2:aaaa::1")));
    assert.ok(post);
  });
});

test("review 1.7: SITE_LEAD_GLOBAL_PER_DAY caps all submissions (honeypot too) with 429 + Retry-After", async () => {
  await withWorld(
    async ({ post, cand, pool }) => {
      assert.equal((await post(cand())).status, 200);
      assert.equal((await post(cand({ hp_url: "x" }))).status, 200);
      const r = await post(cand());
      assert.equal(r.status, 429);
      const ra = Number(r.headers.get("retry-after"));
      assert.ok(ra >= 1 && ra <= 86400);
      const h = await post(cand({ hp_url: "x" }));
      assert.equal(h.status, 429, "honeypot submissions are capped too");
      assert.equal((await pool.query("SELECT 1 FROM crm_leads")).rowCount, 2);
      const keys = (await pool.query("SELECT key FROM public_rate_limit")).rows.map((x) => x.key);
      assert.ok(keys.includes("lead-global"));
    },
    { SITE_LEAD_GLOBAL_PER_DAY: "2" }
  );
});

test("review 1.7: the default global cap is 2000 per day", async () => {
  await withWorld(async ({ pool, post, cand }) => {
    await pool.query("INSERT INTO public_rate_limit (key, window_start, count) VALUES ('lead-global', to_timestamp(floor(extract(epoch FROM now()) / 86400) * 86400), 1999)");
    assert.equal((await post(cand())).status, 200);
    assert.equal((await post(cand())).status, 429);
  }, { SITE_LEAD_GLOBAL_PER_DAY: undefined });
});

test("review 1.7: old public_rate_limit rows (older than 2 days) are deleted opportunistically, bounded", async () => {
  await withWorld(async ({ pool }) => {
    const rl = require("../modules/site/rateLimit");
    await pool.query("INSERT INTO public_rate_limit (key, window_start, count) SELECT 'old' || g, now() - interval '3 days', 1 FROM generate_series(1, 5) g");
    await pool.query("INSERT INTO public_rate_limit (key, window_start, count) VALUES ('recent', now() - interval '1 day', 1)");
    const orig = Math.random;
    Math.random = () => 0; // forces the 1% cleanup
    try {
      await rl.hit(pool, "trigger", { windowMs: 3600000, max: 5 });
    } finally {
      Math.random = orig;
    }
    const keys = (await pool.query("SELECT key FROM public_rate_limit ORDER BY key")).rows.map((r) => r.key);
    assert.deepEqual(keys, ["recent", "trigger"]);
    // not triggered when the dice say no
    await pool.query("INSERT INTO public_rate_limit (key, window_start, count) VALUES ('old-x', now() - interval '3 days', 1)");
    Math.random = () => 0.5;
    try {
      await rl.hit(pool, "trigger2", { windowMs: 3600000, max: 5 });
    } finally {
      Math.random = orig;
    }
    assert.equal((await pool.query("SELECT 1 FROM public_rate_limit WHERE key='old-x'")).rowCount, 1);
    // direct call is bounded
    await pool.query("INSERT INTO public_rate_limit (key, window_start, count) SELECT 'bulk' || g, now() - interval '5 days', 1 FROM generate_series(1, 30) g");
    const del = await rl.cleanupExpired(pool, { limit: 10 });
    assert.equal(del, 10);
  });
});
