// Task 20: static checks of the Hostinger deployment kit (deploy/hostinger) and the production image files.
// Nothing here starts containers. `docker compose config` / shellcheck are used when installed, else skipped.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { checkEnv } = require("../utils/preflight");

const ROOT = path.join(__dirname, "..");
const KIT = path.join(ROOT, "..", "deploy", "hostinger");
const read = (p) => fs.readFileSync(p, "utf8");
const SCRIPTS = ["setup.sh", "create-admin.sh", "demo-seed.sh", "backup.sh", "restore.sh", "update.sh", "logs.sh", "status.sh", "show-sandbox-mail.sh", "lib.sh", "nginx-config.sh", "wipe-data.sh", "db-init/10-app-role.sh"];
const has = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
// a value that looks like a real secret: long hex / base64-ish token
const SECRETISH = /(?:^|[=:\s"'])([A-Fa-f0-9]{24,}|[A-Za-z0-9+/_-]{32,}={0,2})(?:$|[\s"'])/m;

function envTemplate() {
  const entries = {};
  for (const line of read(path.join(KIT, ".env.production.example")).split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) entries[m[1]] = m[2];
  }
  return entries;
}

test("kit: every file exists; scripts are executable", () => {
  for (const f of ["docker-compose.yml", "docker-compose.nginx.yml", "nginx-vita.conf.example", "Caddyfile", ".env.production.example", ".gitignore", ...SCRIPTS]) assert.ok(fs.existsSync(path.join(KIT, f)), f);
  for (const f of SCRIPTS) assert.ok(fs.statSync(path.join(KIT, f)).mode & 0o100, `${f} not executable`);
  assert.ok(fs.statSync(path.join(ROOT, "scripts", "docker-entrypoint.sh")).mode & 0o100);
});

test("kit scripts: bash -n clean, set -euo pipefail, no eval, no curl|sh, no secret echo; shellcheck clean when installed", (t) => {
  for (const f of SCRIPTS) {
    const p = path.join(KIT, f);
    const src = read(p);
    const r = spawnSync("bash", ["-n", p], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    if (f.endsWith(".sh") && f.startsWith("db-init/")) {
      assert.match(src, /^#!\/bin\/sh\n/, f);
      assert.match(src, /^set -eu$/m, f);
    } else {
      assert.match(src, /^#!\/usr\/bin\/env bash\n/, f);
      assert.match(src, /^set -euo pipefail$/m, f);
    }
    // interactive reads keep leading/trailing spaces and backslashes (IFS= read -r)
    for (const line of src.split("\n").filter((l) => /\bread -r\b/.test(l) && !/IFS=\. read -r -a/.test(l))) assert.match(line, /IFS= read -r/, `${f}: ${line.trim()}`);
    assert.doesNotMatch(src, /^\s*eval\b|[;&|]\s*eval\b/m, `${f}: eval`);
    assert.doesNotMatch(src, /curl[^\n|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/, `${f}: curl | sh`);
    // a secret may only be written into a pipe to the container (create-admin.sh), never to the terminal
    const printed = src.split("\n").filter((l) => /(?:echo|printf)[^\n]*\$\{?(?:JWT_SECRET|STORAGE_URL_SECRET|DB_PASSWORD|JOBSEARCH_REPLY_SECRET|PASSWORD|PASSWORD2)\b/.test(l) && !/\| compose exec -T app node -e/.test(l));
    assert.deepEqual(printed, [], `${f}: prints a secret`);
  }
  const entry = path.join(ROOT, "scripts", "docker-entrypoint.sh");
  assert.equal(spawnSync("sh", ["-n", entry]).status, 0);
  if (!has("shellcheck", ["--version"])) return t.skip("shellcheck not installed");
  const sc = spawnSync("shellcheck", ["-x", "-P", KIT, ...SCRIPTS.map((f) => path.join(KIT, f)), entry], { encoding: "utf8" });
  assert.equal(sc.status, 0, sc.stdout + sc.stderr);
});

test("setup.sh: secrets from openssl rand -hex 32, .env chmod 600 and never overwritten, sslip.io default, --domain, firewall only on request, official Docker install text", () => {
  const s = read(path.join(KIT, "setup.sh"));
  assert.match(s, /openssl rand -hex 32/);
  assert.match(s, /for key in JWT_SECRET STORAGE_URL_SECRET JOBSEARCH_REPLY_SECRET DB_PASSWORD SITE_IP_SALT; do/);
  // an .env from an earlier kit version gets the public-form salt generated once (never printed)
  assert.match(s, /if \[ -z "\$\(get_env SITE_IP_SALT\)" \]; then\s+set_env \.env SITE_IP_SALT "\$\(openssl rand -hex 32\)"/);
  // fix round: values reach awk through ENVIRON (no -v escape processing); temp files cleaned on exit
  assert.match(s, /ENVIRON\["SET_VALUE"\]/);
  assert.doesNotMatch(s, /awk -v/);
  assert.match(s, /trap cleanup_tmp EXIT/);
  // separate superuser file for the db container; never DB_USER=postgres
  assert.match(s, /printf 'POSTGRES_USER=postgres\\nPOSTGRES_PASSWORD=\\n' > \.env\.db/);
  assert.match(s, /set_env \.env\.db POSTGRES_PASSWORD "\$\(openssl rand -hex 32\)"/);
  assert.match(s, /DB_USER in .env is the Postgres superuser/);
  assert.match(s, /grep -E .\^POSTGRES_USER=. \.env\.db/, "superuser name read from .env.db, not hard-coded");
  // an empty SITE_ADDRESS in an existing .env is detected again instead of a dead end
  assert.match(s, /elif \[ -z "\$\(get_env SITE_ADDRESS\)" \]; then\s+# an earlier run could not detect the IP/);
  // firewall: the real sshd port, refusal when unknown
  assert.match(s, /sshd -T/);
  assert.match(s, /NOT enabling the firewall/);
  assert.match(s, /set POSTGRES_USER and POSTGRES_PASSWORD to the OLD DB_USER and DB_PASSWORD/, "old-install guidance");
  assert.match(s, /xn--\[a-z0-9-\]\{1,59\}/, "punycode TLDs accepted");
  assert.match(s, /chmod 600 \.env/);
  assert.match(s, /umask 077/);
  assert.match(s, /if \[ -f \.env \]; then\s+say "Keeping the existing \.env/);
  assert.match(s, /https:\/\/api\.ipify\.org/);
  assert.match(s, /\.sslip\.io/);
  assert.match(s, /--domain\)/);
  assert.match(s, /if \[ "\$FIREWALL" -eq 1 \]; then[\s\S]*sudo ufw allow "\$\{port\}\/tcp"[\s\S]*sudo ufw allow 443\/tcp/);
  assert.match(s, /download\.docker\.com\/linux\/ubuntu/);
  assert.match(s, /docker compose version|"\$\{DOCKER\[@\]\}" compose/);
  assert.match(s, /compose up -d --build/);
  assert.match(s, /\/healthz/);
  assert.match(s, /\/vita\//);
});

test("create-admin.sh: hidden password (read -s), sent on stdin to a node script in the container, never on a command line", () => {
  const s = read(path.join(KIT, "create-admin.sh"));
  assert.match(s, /IFS= read -r -s -p "Password \(hidden\): " PASSWORD/);
  assert.match(s, /printf '%s\\n%s\\n%s\\n' "\$FULL_NAME" "\$EMAIL" "\$PASSWORD" \| compose exec -T app node -e "\$NODE_SCRIPT"/);
  assert.match(s, /\/auth\/bootstrap-super-admin/);
  assert.match(s, /127\.0\.0\.1/);
  assert.doesNotMatch(s, /curl[^\n]*PASSWORD|--data[^@\n]*PASSWORD|-d "\$/);
  assert.match(s, /unset PASSWORD/);
});

test("demo-seed.sh: dev seed inside the container with NODE_ENV=development + VITA_SEED_ALLOW_REMOTE=1, explicit DEMO confirmation, documents down -v", () => {
  const s = read(path.join(KIT, "demo-seed.sh"));
  assert.match(s, /-e NODE_ENV=development/);
  assert.match(s, /-e VITA_SEED_ALLOW_REMOTE=1/);
  assert.match(s, /node scripts\/dev-seed-ui\.js/);
  assert.doesNotMatch(s, /VITA_SEED_FORCE/, "never forces past the real-install guard");
  assert.doesNotMatch(s, /docker compose down -v/, "the wipe goes through the guarded ./wipe-data.sh");
  assert.match(s, /\.\/wipe-data\.sh/);
  assert.match(s, /Type DEMO/);
});

test("backup/restore/update: pg_dump custom format + storage tar, retention, checksums, restore confirmation, backup before update", () => {
  const b = read(path.join(KIT, "backup.sh"));
  assert.match(b, /pg_dump -U "\$PG_SUPER" -d "\$DB_NAME" -Fc/);
  assert.match(b, /trap on_exit EXIT/, "partial backups removed on failure");
  assert.match(b, /if \[ ! -d "\$BACKUP_DIR" \]; then[\s\S]*chmod 700 "\$BACKUP_DIR"[\s\S]*fi/, "chmod only a folder it creates");
  assert.match(b, /tar -C \/data -czf - storage/);
  assert.match(b, /RETENTION="\$\{RETENTION:-14\}"/);
  assert.match(b, /sha256sum/);
  assert.match(b, /umask 077/);
  assert.match(b, /crontab -e/);
  const r = read(path.join(KIT, "restore.sh"));
  assert.match(r, /Type RESTORE to continue/);
  assert.match(r, /pg_restore -U "\$DB_USER" -d "\$TMP_DB" --no-owner --no-privileges --single-transaction --exit-on-error/);
  assert.match(r, /CREATE DATABASE \\"\$\{TMP_DB\}\\" OWNER \\"\$\{DB_USER\}\\"/);
  assert.match(r, /RENAME TO \\"\$\{OLD_DB\}\\"/);
  assert.match(r, /trap restart_stack EXIT/);
  assert.ok(r.indexOf("trap restart_stack EXIT") < r.indexOf('compose stop app "${EDGE[@]}"'), "the trap is set before the stack is stopped");
  assert.match(r, /\.\/backup\.sh/);
  // fix round 2: the uploads archive is validated before any change, extracted to a temp folder, then swapped
  assert.ok(r.indexOf("tar -tzf") > 0 && r.indexOf("tar -tzf") < r.indexOf('compose stop app "${EDGE[@]}"'), "archive checked before anything changes");
  assert.match(r, /contains paths outside storage\//);
  assert.match(r, /tar -C \.restore-new -xzf -/);
  assert.doesNotMatch(r, /find \/data\/storage -mindepth 1 -delete/, "never empties the storage first");
  assert.ok(r.indexOf("tar -C .restore-new -xzf -") < r.indexOf("-exec mv -t .restore-old"), "extract before moving the current files aside");
  assert.match(r, /sha256sum --quiet -c SHA256SUMS/);
  const u = read(path.join(KIT, "update.sh"));
  assert.ok(u.indexOf("./backup.sh") < u.indexOf("git pull --ff-only"), "backup first");
  assert.match(u, /compose pull db caddy/);
  assert.match(u, /compose build --pull app/);
  assert.match(u, /^main\(\) \{$/m);
  assert.match(u, /\nmain "\$@"; exit \$\?\n$/, "main and exit on the last line (self-modification safe)");
  assert.match(u, /git ls-remote --exit-code --heads/);
  assert.match(u, /git switch main/);
  const sm = read(path.join(KIT, "show-sandbox-mail.sh"));
  assert.match(sm, /default_transaction_read_only=on/);
  assert.match(sm, /FROM js_sandbox_mail/);
  assert.match(sm, /sign-in codes/);
});

test("docker-compose.yml: only Caddy publishes ports (80/443); app 5000 and db never published; no secrets; db network internal; app read-only + non-root image", (t) => {
  const yml = read(path.join(KIT, "docker-compose.yml"));
  // no "- 5000:5000" / "- 127.0.0.1:5000:5000" / "- 5432:5432" style port mapping anywhere
  assert.doesNotMatch(yml, /^\s*-\s*["']?(?:[\d.]+:)?\d*:?(?:5000|5432)(?::\d+)?["']?\s*$/m, "port 5000/5432 must not be published");
  assert.equal((yml.match(/^\s*ports:/gm) || []).length, 1, "only one service (caddy) has ports");
  assert.ok(!SECRETISH.test(yml.replace(/\$\{[^}]+\}/g, "")), "looks like a secret value");
  // fix round I6: the app role is unprivileged; the superuser is only in .env.db (db container)
  assert.doesNotMatch(yml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"), /POSTGRES_PASSWORD/, "the superuser password is not passed from .env");
  assert.match(yml, /env_file: \.env\.db/);
  assert.match(yml, /VITA_APP_USER: \$\{DB_USER:\?/);
  assert.match(yml, /- \.\/db-init:\/docker-entrypoint-initdb\.d:ro/);
  const init = read(path.join(KIT, "db-init", "10-app-role.sh"));
  assert.match(init, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(init, /ALTER DATABASE :"db" OWNER TO :"app_user"/);
  assert.match(init, /CREATE EXTENSION IF NOT EXISTS btree_gist/);
  assert.match(yml, /env_file: \.env/);
  assert.match(yml, /image: postgres:16/);
  assert.match(yml, /image: caddy:2/);
  assert.match(yml, /context: \.\.\/\.\.\/trust-crm/);
  assert.match(yml, /read_only: true/);
  assert.match(yml, /tmpfs:\s*\n\s*- \/tmp/);
  assert.match(yml, /condition: service_healthy/);
  assert.match(yml, /restart: unless-stopped/);
  assert.match(yml, /backend:\s*\n\s*internal: true/);
  assert.match(yml, /SITE_ADDRESS: \$\{SITE_ADDRESS:\?/);
  assert.match(yml, /SITE_ADDRESS: \$\{SITE_POSTAL_ADDRESS:-\}/, "the app never shows the Caddy host name as the postal address");
  if (!has("docker", ["compose", "version"])) return t.skip("docker compose CLI not installed");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vita-kit-"));
  try {
    const envFile = path.join(tmp, "env");
    fs.writeFileSync(envFile, "DB_USER=vita\nDB_NAME=vita\nDB_PASSWORD=test-only\nSITE_ADDRESS=203-0-113-10.sslip.io\n");
    const r = spawnSync("docker", ["compose", "--project-directory", KIT, "-f", path.join(KIT, "docker-compose.yml"), "--env-file", envFile, "--profile", "caddy", "config", "--format", "json", "--no-env-resolution"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME || tmp, DOCKER_CONFIG: path.join(tmp, "docker") },
    });
    if (r.status !== 0 && /env_file|\.env|env file/.test(r.stderr)) {
      // env_file .env must exist for `config`; create an empty stand-in in a copy of the kit
      const copy = path.join(tmp, "kit");
      fs.mkdirSync(copy);
      for (const f of ["docker-compose.yml", "Caddyfile"]) fs.copyFileSync(path.join(KIT, f), path.join(copy, f));
      fs.writeFileSync(path.join(copy, ".env"), "");
      fs.writeFileSync(path.join(copy, ".env.db"), "");
      const r2 = spawnSync("docker", ["compose", "--project-directory", copy, "-f", path.join(copy, "docker-compose.yml"), "--env-file", envFile, "--profile", "caddy", "config", "--format", "json", "--no-env-resolution"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp, DOCKER_CONFIG: path.join(tmp, "docker") } });
      assert.equal(r2.status, 0, r2.stderr);
      return checkConfig(JSON.parse(r2.stdout));
    }
    assert.equal(r.status, 0, r.stderr);
    checkConfig(JSON.parse(r.stdout));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function checkConfig(cfg) {
  assert.deepEqual(Object.keys(cfg.services).sort(), ["app", "caddy", "db"]);
  assert.equal(cfg.services.app.ports, undefined, "app publishes no port");
  assert.equal(cfg.services.db.ports, undefined, "db publishes no port");
  const published = cfg.services.caddy.ports.map((p) => `${p.published}/${p.protocol || "tcp"}`).sort();
  assert.deepEqual(published, ["443/tcp", "443/udp", "80/tcp"]);
  assert.equal(cfg.services.app.environment.NODE_ENV, "production");
  assert.equal(cfg.services.app.environment.DB_HOST, "db");
  assert.equal(cfg.services.app.read_only, true);
  assert.deepEqual(Object.keys(cfg.services.db.networks), ["backend"]);
  assert.equal(cfg.services.app.env_file && cfg.services.app.env_file.some((e) => /\.env\.db/.test(e.path || e)), false, "the app never reads .env.db");
  assert.equal(cfg.networks.backend.internal, true);
  assert.equal(cfg.services.app.depends_on.db.condition, "service_healthy");
  assert.ok(cfg.services.db.healthcheck && cfg.services.db.healthcheck.test);
}

test("Caddyfile: {$SITE_ADDRESS}, reverse_proxy app:5000 (flush for SSE, no compression of /jobsearch/events and /chat/events), security headers, HSTS without includeSubDomains, / reaches the app (public website)", () => {
  const raw = read(path.join(KIT, "Caddyfile"));
  const c = raw.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").replace(/\s#.*$/gm, "");
  assert.match(c, /^\{\$SITE_ADDRESS\} \{/m);
  assert.match(c, /reverse_proxy app:5000/);
  assert.match(c, /Strict-Transport-Security "max-age=31536000"/);
  assert.doesNotMatch(c, /includeSubDomains/i, "sslip.io names are shared - never includeSubDomains");
  for (const h of ["X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Permissions-Policy", "-Server"]) assert.ok(c.includes(h), h);
  assert.doesNotMatch(c, /redir @root/, "the bare address is the public website, no longer redirected to /vita/");
  // fix round C1: the bootstrap route is never reachable through Caddy (any case, repeated slashes)
  assert.match(c, /@bootstrap path_regexp bootstrap \(\?i\)\^\/\+auth\/\+bootstrap-super-admin/);
  assert.match(c, /respond @bootstrap `\{"error":"Not found"\}` 404/);
  assert.ok(c.indexOf("respond @bootstrap") < c.indexOf("reverse_proxy"), "listed before the proxy");
  assert.match(c, /@healthz path \/healthz\s*\n\s*respond @healthz `\{"ok":true\}` 200/, "public /healthz never queries the DB");
  assert.match(c, /request_body \{\s*max_size \{\$CADDY_MAX_BODY:12MB\}\s*\}/);
  assert.match(c, /read_header 10s/);
  assert.match(c, /read_body 120s/);
  assert.doesNotMatch(c, /\bwrite \d/, "no write timeout (SSE)");
  assert.match(c, /import \/tmp\/caddy-global\.d\/\*\.caddy/);
  // live events (SSE): flushed immediately and never compressed (verified through Caddy in the Task 20 sandbox run)
  assert.match(c, /reverse_proxy app:5000 \{\s*flush_interval -1\s*\}/);
  // messaging (stage 6) streams too: /chat/events must be excluded from compression as well (a compressed stream is buffered)
  assert.match(c, /@compress not path \/jobsearch\/events \/chat\/events \/mcp\s*\n\s*encode @compress zstd gzip/);
  // assistant access (stage 7): /mcp is excluded from compression/buffering too, and MCP stays off unless the owner enables it
  const mcpEnv = envTemplate();
  assert.ok(!("MCP_ENABLED" in mcpEnv) || mcpEnv.MCP_ENABLED === "false", "MCP is off by default in the production template");
});

test(".env.production.example: every variable preflight needs; safe sandbox defaults; no secret values; template + generated secrets passes the preflight", () => {
  const env = envTemplate();
  for (const k of ["NODE_ENV", "SITE_ADDRESS", "TRUST_PROXY", "JWT_SECRET", "STORAGE_URL_SECRET", "JOBSEARCH_REPLY_SECRET", "DB_HOST", "DB_PORT", "DB_USER", "DB_NAME", "DB_PASSWORD", "STORAGE_DIR", "MAIL_PROVIDER", "MAIL_REAL_SEND", "ALLOW_UNSCANNED_ATTACHMENTS", "INBOUND_AUTH_REQUIRED", "INBOUND_AUTO_ACK_EVIDENCE", "JOBSEARCH_SCHEDULER", "JOBSEARCH_WORKERS"]) {
    assert.ok(k in env, `missing ${k}`);
  }
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.MAIL_PROVIDER, "sandbox");
  assert.equal(env.MAIL_REAL_SEND, "false");
  assert.equal(env.ALLOW_UNSCANNED_ATTACHMENTS, "true");
  assert.equal(env.TRUST_PROXY, "1");
  assert.equal(env.INBOUND_AUTH_REQUIRED, "true");
  assert.equal(env.INBOUND_AUTO_ACK_EVIDENCE, "false");
  assert.equal(env.JOBSEARCH_SCHEDULER, "on");
  assert.equal(env.JOBSEARCH_WORKERS, "on");
  assert.equal(env.SITE_ADDRESS, "");
  assert.equal(env.SITE_IP_SALT, "", "SITE_IP_SALT is generated by setup.sh, never shipped");
  assert.ok(!("SITE_POSTAL_ADDRESS" in env) && /^# SITE_POSTAL_ADDRESS=/m.test(read(path.join(KIT, ".env.production.example"))), "postal address is optional");
  assert.equal(env.DB_USER, "vita_app", "the app role is not the superuser");
  for (const [k, v] of Object.entries(env)) {
    if (/SECRET|PASSWORD|PASS$|_KEY$|TOKEN/.test(k)) assert.equal(v, "", `${k} must be empty in the template`);
    assert.ok(!SECRETISH.test(`=${v}`), `${k} looks like a secret value`);
  }
  const text = read(path.join(KIT, ".env.production.example"));
  assert.match(text, /set it to false\s*\n?#?\s*before enabling real mail/i);
  // every documented variable is a real one (.env.example lists every variable the code reads)
  const known = read(path.join(ROOT, ".env.example")) + "\nSITE_ADDRESS SITE_POSTAL_ADDRESS ACME_EMAIL CADDY_MAX_BODY COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_FILE VITA_DEPLOY_MODE VITA_APP_PORT VITA_WWW";
  const all = [...text.matchAll(/^#?\s?([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1]);
  for (const k of all) assert.ok(known.includes(k), `${k} is not a known variable (.env.example)`);
  // what setup.sh produces passes the production preflight
  const rnd = () => require("crypto").randomBytes(32).toString("hex");
  const filled = { ...env, JWT_SECRET: rnd(), STORAGE_URL_SECRET: rnd(), JOBSEARCH_REPLY_SECRET: rnd(), DB_PASSWORD: rnd(), SITE_ADDRESS: "203-0-113-10.sslip.io" };
  for (const k of Object.keys(filled)) if (filled[k] === "") delete filled[k];
  const r = checkEnv(filled, { storageWritable: () => true });
  assert.deepEqual(r.problems, []);
  const unfilled = checkEnv(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")), { storageWritable: () => true });
  assert.ok(unfilled.problems.some((p) => /^JWT_SECRET is not set/.test(p)), "the raw template is refused until secrets are generated");
});

test("Dockerfile: node:22-slim, npm ci --omit=dev, runtime files only, non-root USER, healthcheck on /healthz, entrypoint migrates then starts", () => {
  const d = read(path.join(ROOT, "Dockerfile"));
  const froms = [...d.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.ok(froms.length >= 1 && froms.every((f) => f === "node:22-slim"), froms.join(","));
  assert.match(d, /npm ci --omit=dev/);
  assert.doesNotMatch(d, /^COPY \. /m, "no blanket COPY . .");
  assert.doesNotMatch(d, /^COPY[^\n]*\btests\b/m);
  assert.doesNotMatch(d, /^COPY[^\n]*\.env\b/m);
  const lastFrom = d.lastIndexOf("\nFROM ");
  const user = /^USER (\S+)$/m.exec(d.slice(lastFrom));
  assert.ok(user && user[1] !== "root" && user[1] !== "0", "final stage runs as a non-root user");
  assert.match(d, /^HEALTHCHECK [\s\S]*\/healthz/m);
  assert.match(d, /^ENTRYPOINT \["\/app\/scripts\/docker-entrypoint\.sh"\]/m);
  const entry = read(path.join(ROOT, "scripts", "docker-entrypoint.sh"));
  assert.ok(entry.indexOf("node /app/scripts/db-init.js") < entry.indexOf("exec node /app/server.js"));
  assert.match(entry, /^set -eu$/m);
  assert.doesNotMatch(d, /sandbox-ca|ccr|NODE_EXTRA_CA_CERTS/, "no sandbox/proxy CA in the real Dockerfile");
});

test(".dockerignore excludes .env, tests, node_modules, .storage, .git and docs; kit .gitignore keeps .env and backups out of git", () => {
  const lines = read(path.join(ROOT, ".dockerignore")).split("\n").map((l) => l.trim());
  for (const x of [".env", ".env.*", "tests", "node_modules", ".storage", ".git", "docs"]) assert.ok(lines.includes(x), x);
  const gi = read(path.join(KIT, ".gitignore")).split("\n").map((l) => l.trim());
  assert.ok(gi.includes(".env"));
  assert.ok(gi.includes(".env.db"));
  assert.ok(gi.includes(".env.tmp.*"));
  assert.ok(gi.includes("backups/"));
});

// ---------------------------------------------------------------- review round 1

function runEnsureEnv(initialEnv) {
  const s = read(path.join(KIT, "setup.sh"));
  const set = /\nset_env\(\) \{[\s\S]*?\n\}\n/.exec(s);
  const get = /\nget_env\(\) \{[\s\S]*?\n\}\n/.exec(s);
  const ens = /\nensure_env\(\) \{[\s\S]*?\n\}\n/.exec(s);
  assert.ok(set && get && ens, "set_env, get_env and ensure_env are defined in setup.sh");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vita-ensure-"));
  try {
    if (initialEnv !== null) fs.writeFileSync(path.join(dir, ".env"), initialEnv);
    else fs.writeFileSync(path.join(dir, ".env"), "");
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${set[0]}\n${get[0]}\n${ens[0]}\nensure_env TRUST_PROXY 1\nensure_env TRUST_PROXY 1`], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(path.join(dir, ".env"), "utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("review 7: setup.sh adds TRUST_PROXY=1 when missing (once) and never overwrites an existing value", () => {
  assert.equal(runEnsureEnv("A=1\nB=2\n"), "A=1\nB=2\nTRUST_PROXY=1\n");
  assert.equal(runEnsureEnv("A=1\nTRUST_PROXY=2\n"), "A=1\nTRUST_PROXY=2\n");
  assert.equal(runEnsureEnv("TRUST_PROXY=0\nA=1\n"), "TRUST_PROXY=0\nA=1\n");
  assert.equal(runEnsureEnv("TRUST_PROXY=\n"), "TRUST_PROXY=\n", "an existing line, even empty, is the owner's choice");
  assert.equal(runEnsureEnv("# TRUST_PROXY=1\nA=1\n"), "# TRUST_PROXY=1\nA=1\nTRUST_PROXY=1\n", "a comment is not a value");
});

test("review 7: setup.sh calls ensure_env TRUST_PROXY for a new and for an existing .env", () => {
  const s = read(path.join(KIT, "setup.sh"));
  const calls = s.match(/ensure_env TRUST_PROXY 1/g) || [];
  assert.ok(calls.length >= 2, "called in both the existing-.env and the new-.env branch");
  const existing = s.slice(s.indexOf("if [ -f .env ]; then"), s.indexOf("else\n  cp .env.production.example .env"));
  assert.match(existing, /ensure_env TRUST_PROXY 1/);
  const created = s.slice(s.indexOf("cp .env.production.example .env"), s.indexOf("# Postgres SUPERUSER"));
  assert.match(created, /ensure_env TRUST_PROXY 1/);
});

test("review 7: SITE_LEAD_GLOBAL_PER_DAY is documented in .env.production.example, trust-crm/.env.example and SETUP.md", () => {
  assert.match(read(path.join(KIT, ".env.production.example")), /^# SITE_LEAD_GLOBAL_PER_DAY=2000$/m);
  assert.match(read(path.join(ROOT, ".env.example")), /^# SITE_LEAD_GLOBAL_PER_DAY=2000$/m);
  assert.match(read(path.join(ROOT, "..", "docs", "vita-website-crm", "SETUP.md")), /`SITE_LEAD_GLOBAL_PER_DAY`/);
  const salt = read(path.join(ROOT, "..", "docs", "vita-website-crm", "SETUP.md"));
  assert.doesNotMatch(salt, /insecure built-in salt/, "the fixed development salt no longer exists");
});


// ---------------------------------------------------------------- mode "behind an existing nginx"

const strip = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("nginx mode compose: Caddy is a profile; the override publishes the app only on 127.0.0.1; the db never publishes; project name fixed", () => {
  const yml = read(path.join(KIT, "docker-compose.yml"));
  assert.match(yml, /caddy:\s*\n\s+image: caddy:2\s*\n(?:\s*#[^\n]*\n)*\s+profiles: \["caddy"\]/, "caddy is optional (profile)");
  assert.equal((yml.match(/^\s*profiles:/gm) || []).length, 1, "only caddy has a profile");
  const dbBlock = /\n  db:\n([\s\S]*?)\n  app:\n/.exec(yml)[1];
  assert.doesNotMatch(dbBlock, /^\s*ports:/m, "the database publishes no port");
  assert.match(yml, /^name: vita$/m);
  const ov = strip(read(path.join(KIT, "docker-compose.nginx.yml")));
  const ports = [...ov.matchAll(/^\s*-\s*"?([^"\n]+)"?\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(ports, ["127.0.0.1:${VITA_APP_PORT:-8083}:5000"], "loopback only, never 0.0.0.0");
  assert.doesNotMatch(ov, /0\.0\.0\.0|caddy|5432/);
  const ex = read(path.join(KIT, ".env.production.example"));
  assert.match(ex, /^# COMPOSE_PROJECT_NAME=vita$/m);
  const gi = read(path.join(KIT, ".gitignore"));
  assert.match(gi, /^nginx-vita\.generated\*$/m);
});

function renderConfig(args, mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vita-kit-cfg-"));
  const envFile = path.join(tmp, "env");
  fs.writeFileSync(envFile, "DB_USER=vita_app\nDB_NAME=vita\nDB_PASSWORD=test-only\nSITE_ADDRESS=vita.example.com\nVITA_APP_PORT=8091\n");
  const copy = path.join(tmp, "kit");
  fs.mkdirSync(copy);
  for (const f of ["docker-compose.yml", "docker-compose.nginx.yml", "Caddyfile"]) fs.copyFileSync(path.join(KIT, f), path.join(copy, f));
  fs.writeFileSync(path.join(copy, ".env"), "");
  fs.writeFileSync(path.join(copy, ".env.db"), "");
  const files = ["-f", path.join(copy, "docker-compose.yml"), ...(mode === "nginx" ? ["-f", path.join(copy, "docker-compose.nginx.yml")] : ["--profile", "caddy"])];
  const r = spawnSync("docker", ["compose", "-p", "vita", "--project-directory", copy, ...files, "--env-file", envFile, "config", "--format", "json", "--no-env-resolution", ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp, DOCKER_CONFIG: path.join(tmp, "docker") } });
  fs.rmSync(tmp, { recursive: true, force: true });
  return r;
}

test("docker compose config renders in both modes with a dummy .env (nginx: no caddy, loopback port; caddy: profile on)", (t) => {
  if (!has("docker", ["compose", "version"])) return t.skip("docker compose CLI not installed");
  const n = renderConfig([], "nginx");
  assert.equal(n.status, 0, n.stderr);
  const ncfg = JSON.parse(n.stdout);
  assert.deepEqual(Object.keys(ncfg.services).sort(), ["app", "db"], "no Caddy in nginx mode");
  assert.equal(ncfg.name, "vita");
  assert.equal(ncfg.services.db.ports, undefined);
  assert.equal(ncfg.services.app.ports.length, 1);
  const p = ncfg.services.app.ports[0];
  assert.equal(p.host_ip, "127.0.0.1");
  assert.equal(String(p.target), "5000");
  assert.ok(/^\$\{VITA_APP_PORT:-8083\}$|^(8091|8083)$/.test(String(p.published)), String(p.published));
  const c = renderConfig([], "caddy");
  assert.equal(c.status, 0, c.stderr);
  const ccfg = JSON.parse(c.stdout);
  assert.deepEqual(Object.keys(ccfg.services).sort(), ["app", "caddy", "db"]);
  assert.equal(ccfg.services.app.ports, undefined, "Caddy mode: the app publishes nothing");
  // without the profile (what a bare nginx-less `up` would see) Caddy is not part of the project
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vita-kit-np-"));
  try {
    const copy = path.join(tmp, "kit");
    fs.mkdirSync(copy);
    for (const f of ["docker-compose.yml", "Caddyfile"]) fs.copyFileSync(path.join(KIT, f), path.join(copy, f));
    fs.writeFileSync(path.join(copy, ".env"), "");
    fs.writeFileSync(path.join(copy, ".env.db"), "");
    fs.writeFileSync(path.join(tmp, "env"), "DB_USER=a\nDB_NAME=b\nDB_PASSWORD=c\nSITE_ADDRESS=x.example.com\n");
    const r = spawnSync("docker", ["compose", "--project-directory", copy, "-f", path.join(copy, "docker-compose.yml"), "--env-file", path.join(tmp, "env"), "config", "--format", "json", "--no-env-resolution"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp, DOCKER_CONFIG: path.join(tmp, "d") } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.keys(JSON.parse(r.stdout).services).sort(), ["app", "db"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("nginx-vita.conf.example: bootstrap 404, streaming blocks unbuffered, upload limit, forwarded headers, no CSP, no default_server, HSTS only commented", () => {
  const raw = read(path.join(KIT, "nginx-vita.conf.example"));
  const c = strip(raw);
  assert.match(c, /location = \/auth\/bootstrap-super-admin \{\s*return 404;\s*\}/);
  assert.match(c, /location \^~ \/auth\/bootstrap-super-admin\/ \{\s*return 404;\s*\}/);
  assert.match(c, /location ~\* \^\/\+auth\/\+bootstrap-super-admin \{\s*return 404;/);
  assert.match(c, /server_name __DOMAIN__;/);
  assert.match(c, /listen 80;/);
  assert.match(c, /listen 443 ssl;/);
  assert.match(c, /client_max_body_size 12m;/);
  assert.doesNotMatch(c, /default_server/);
  assert.doesNotMatch(c, /Content-Security-Policy/i, "never a second CSP");
  assert.doesNotMatch(c, /^\s*add_header\s+Strict-Transport-Security/m, "HSTS only as a comment");
  assert.match(raw, /^\s*# add_header Strict-Transport-Security/m);
  assert.match(raw, /default_server/, "the note about default_server is there");
  assert.doesNotMatch(c, /proxy_pass http:\/\/(?!127\.0\.0\.1:__PORT__)/, "only the loopback port");
  for (const loc of ["= /chat/events", "= /jobsearch/events", "= /mcp", "^~ /mcp/"]) {
    const m = new RegExp(`location ${loc.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&")} \\{([\\s\\S]*?)\\n    \\}`).exec(c);
    assert.ok(m, `location ${loc}`);
    for (const d of [/proxy_buffering off;/, /proxy_cache off;/, /gzip off;/, /proxy_http_version 1\.1;/, /proxy_set_header Connection "";/, /proxy_read_timeout 3600s;/, /chunked_transfer_encoding on;/, /proxy_pass http:\/\/127\.0\.0\.1:__PORT__;/]) assert.match(m[1], d, `${loc}: ${d}`);
  }
  const main = /location \/ \{([\s\S]*?)\n    \}/.exec(c.slice(c.lastIndexOf("listen 443 ssl;")))[1];
  for (const d of [/proxy_set_header Host \$host;/, /proxy_set_header X-Real-IP \$remote_addr;/, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/, /proxy_set_header X-Forwarded-Proto \$scheme;/]) assert.match(main, d);
  assert.match(raw, /sudo nginx -t/);
  assert.match(raw, /sudo rm \/etc\/nginx\/sites-enabled\/vita/);
  assert.match(c, /BEGIN-HTTP-ONLY|server \{/);
});

test("nginx-config.sh: substitutes domain and port, www redirect, writes the full and the HTTP-only file, prints certbot + rollback, rejects bad input", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "vita-nginxcfg-"));
  try {
    const run = (args) => spawnSync("bash", [path.join(KIT, "nginx-config.sh"), ...args], { encoding: "utf8" });
    const r = run(["--domain", "ehiservices.online", "--port", "8085", "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const full = read(path.join(out, "nginx-vita.generated.conf"));
    const http = read(path.join(out, "nginx-vita.generated-http-only.conf"));
    assert.doesNotMatch(full, /__[A-Z]+__/);
    assert.match(full, /server_name ehiservices\.online;/);
    assert.match(full, /server_name www\.ehiservices\.online;\n(?:.*\n)*?\s+return 301 https:\/\/ehiservices\.online\$request_uri;/, "www redirects to the bare name");
    assert.match(full, /server_name ehiservices\.online www\.ehiservices\.online;/);
    assert.match(full, /proxy_pass http:\/\/127\.0\.0\.1:8085;/);
    assert.match(full, /\/etc\/letsencrypt\/live\/ehiservices\.online\/fullchain\.pem/);
    assert.match(http, /listen 80;/);
    assert.doesNotMatch(http, /listen 443|ssl_certificate|proxy_pass/, "the first file needs no certificate");
    assert.match(r.stdout, /certbot certonly --webroot -w \/var\/www\/vita-acme -d ehiservices\.online -d www\.ehiservices\.online/);
    assert.match(r.stdout, /certbot --nginx -d ehiservices\.online -d www\.ehiservices\.online/);
    assert.match(r.stdout, /certbot plugins/);
    assert.match(r.stdout, /nginx -t/);
    assert.match(r.stdout, /ROLLBACK/);
    assert.match(r.stdout, /rm \/etc\/nginx\/sites-enabled\/vita/);
    assert.match(r.stdout, /nginx -T 2>\/dev\/null \| grep/);
    // a subdomain gets no www block by default
    const sub = run(["--domain", "vita.ehiservices.online", "--port", "8085", "--out", out]);
    assert.equal(sub.status, 0, sub.stderr);
    assert.doesNotMatch(read(path.join(out, "nginx-vita.generated.conf")), /server_name www\./);
    assert.match(sub.stdout, /certbot certonly --webroot -w \/var\/www\/vita-acme -d vita\.ehiservices\.online --deploy-hook/);
    assert.notEqual(run(["--domain", "bad domain;rm", "--port", "8085", "--out", out]).status, 0);
    assert.notEqual(run(["--domain", "vita.example.com", "--port", "80", "--out", out]).status, 0);
    assert.notEqual(run(["--domain", "vita.example.com", "--port", "8085; id", "--out", out]).status, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("setup.sh --behind-nginx: option checks, no Caddy/ufw, project guard, free-port logic, trust proxy 1, informational SITE_ADDRESS, no certbot/nginx commands run", () => {
  const s = read(path.join(KIT, "setup.sh"));
  const run = (args) => spawnSync("bash", [path.join(KIT, "setup.sh"), ...args], { encoding: "utf8" });
  assert.notEqual(run(["--port", "8083"]).status, 0, "--port alone is refused");
  assert.match(run(["--port", "8083"]).stderr, /--behind-nginx/);
  assert.match(run(["--behind-nginx", "--port", "80"]).stderr, /1024 and 65535/);
  assert.match(run(["--behind-nginx", "--port", "abc"]).stderr, /1024 and 65535/);
  assert.match(run(["--behind-nginx", "--configure-firewall"]).stderr, /not used with --behind-nginx/);
  assert.match(run(["--help"]).stdout, /--behind-nginx \[--port 8083\]/);
  assert.match(s, /compose up -d --build db app/);
  assert.match(s, /set_env \.env COMPOSE_FILE docker-compose\.yml:docker-compose\.nginx\.yml/);
  assert.match(s, /set_env \.env COMPOSE_PROFILES ""/);
  assert.match(s, /ensure_env COMPOSE_PROFILES caddy/);
  assert.match(s, /ensure_env COMPOSE_PROJECT_NAME vita/);
  assert.match(s, /label=com\.docker\.compose\.project=vita/);
  assert.match(s, /already exist but were created from another folder/);
  assert.match(s, /port \$PORT on this server is already in use/);
  assert.match(s, /next_free_port/);
  assert.match(s, /vita\.%s\.sslip\.io/);
  assert.match(s, /http:\/\/127\.0\.0\.1:\$PORT\/healthz/);
  assert.match(s, /\.\/nginx-config\.sh --domain "\$SITE" --port "\$PORT"/);
  assert.match(s, /getent ahostsv4/);
  assert.doesNotMatch(strip(s), /^\s*(?:sudo\s+)?(?:certbot|nginx|systemctl)\s+(?:-|certonly|reload|plugins|renew)/m, "setup.sh never runs certbot/nginx itself");
  assert.doesNotMatch(strip(read(path.join(KIT, "nginx-config.sh"))), /^\s*(?:sudo\s+)?(?:certbot|nginx|systemctl)\s+(?:-|certonly|reload|plugins|renew)/m);
  // one proxy hop (nginx): the value is accepted by the app's own validator and is a hop count of 1
  assert.match(s, /\[ "\$\(get_env TRUST_PROXY\)" != "1" \]/);
  const { trustProxySetting } = require("../utils/trustProxy");
  assert.equal(trustProxySetting("1"), 1);
  assert.equal(envTemplate().TRUST_PROXY, "1");
  const lib = read(path.join(KIT, "lib.sh"));
  assert.match(lib, /unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME/, "a project name exported in the shell cannot redirect the scripts");
  assert.match(lib, /COMPOSE_ARGS=\(-p "\$PROJECT" -f docker-compose\.yml\)/);
  assert.match(lib, /docker-compose\.nginx\.yml/);
});

test("helper scripts: every one uses lib.sh (project name from .env, no Caddy assumption); logs/status/update/restore are mode aware", () => {
  for (const f of ["update.sh", "backup.sh", "restore.sh", "status.sh", "logs.sh", "create-admin.sh", "demo-seed.sh", "show-sandbox-mail.sh", "wipe-data.sh", "nginx-config.sh", "setup.sh"]) {
    const src = read(path.join(KIT, f));
    assert.match(src, /^\s*\. \.\/lib\.sh$/m, `${f} sources lib.sh`);
    assert.doesNotMatch(strip(src), /"\$\{DOCKER\[@\]\}" compose (?!version)/, `${f}: raw compose call without -p`);
  }
  const logs = read(path.join(KIT, "logs.sh"));
  assert.match(logs, /caddy\) has_caddy \|\| die/);
  const st = read(path.join(KIT, "status.sh"));
  assert.match(st, /http:\/\/127\.0\.0\.1:%s\/healthz|http:\/\/127\.0\.0\.1:\$APP_PORT\/healthz/);
  assert.match(st, /expected=2/);
  const up = read(path.join(KIT, "update.sh"));
  assert.match(up, /compose up -d db app/);
  const rs = read(path.join(KIT, "restore.sh"));
  assert.match(rs, /^guard_project$/m);
  assert.ok(rs.indexOf("guard_project") < rs.indexOf("Type RESTORE to continue"), "names are printed before the confirmation");
  const wipe = read(path.join(KIT, "wipe-data.sh"));
  const wcode = strip(wipe);
  assert.ok(wcode.indexOf("guard_project") > 0 && wcode.indexOf("guard_project") < wcode.indexOf("compose down -v"));
  assert.match(wipe, /Type the project name/);
  const lib = read(path.join(KIT, "lib.sh"));
  assert.match(lib, /^guard_project\(\) \{/m);
  assert.match(lib, /app\|emnacrm\*/, "never the name of another project");
});

test("safety: no docker system prune / volume prune in the kit; `down -v` only behind the guard; docs warn", () => {
  const files = [...SCRIPTS, "docker-compose.yml", "docker-compose.nginx.yml", "nginx-vita.conf.example"];
  for (const f of files) {
    const src = strip(read(path.join(KIT, f)));
    assert.doesNotMatch(src, /docker\s+(?:system|volume|container|network|image)\s+prune/, `${f}: prune`);
    assert.doesNotMatch(src, /\bdocker\s+(?:rm|rmi|stop|kill|restart)\b/, `${f}: raw docker rm/stop`);
    if (f !== "lib.sh") assert.doesNotMatch(src, /emnacrm|gb-clamav|n8n/, `${f}: names another project's containers`);
    if (/down\s+-v|--volumes/.test(src)) assert.equal(f, "wipe-data.sh", `${f}: down -v outside the guarded script`);
  }
  const docs = [path.join(ROOT, "..", "docs", "vita-job-search", "SETUP-HOSTINGER.md"), path.join(ROOT, "..", "docs", "vita-job-search", "SETUP-HOSTINGER-NGINX.md")];
  for (const d of docs) {
    assert.ok(fs.existsSync(d), d);
    const lines = read(d).split("\n");
    lines.forEach((l, i) => {
      if (/down -v/.test(l)) assert.match(l + (lines[i - 1] || "") + (lines[i + 1] || ""), /never|Never|NEVER|deletes|wipe-data\.sh|DELETE/i, `${path.basename(d)}:${i + 1}: down -v without a warning`);
    });
  }
  const nginxDoc = read(docs[1]);
  assert.match(nginxDoc, /never\*{0,2} run `docker compose down -v`/i);
  assert.match(nginxDoc, /ehiservices\.online/);
  assert.match(nginxDoc, /\/opt\/vita/);
  assert.match(nginxDoc, /emnacrm-\*/);
  assert.match(read(docs[0]), /SETUP-HOSTINGER-NGINX\.md/);
});
