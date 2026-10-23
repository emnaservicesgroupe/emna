# VITA on a Hostinger VPS — step-by-step

البحث الآلي عن عمل / AI Job Search & Applications

This guide puts VITA (the EMNA CRM with the AI job-search module) on **your own Hostinger VPS** with
Docker. It is written for a non-technical owner: copy each command exactly, one block at a time.

**What you get at the end:** VITA at an `https://…/vita/` address with a real certificate, a database
and file storage on your server, daily backups, and everything in **safe sandbox mode** — no real e-mail
is sent and no live job source is connected until you decide to switch them on.

> **Honest status (read this).** This kit has **NOT** been run on a real Hostinger VPS. It was exercised in
> a development container (Ubuntu 24.04, Docker 29, compose v5) with three important differences from your
> server - see [section 17](#17-what-was-and-was-not-tested) for the exact list:
> 1. that container intercepts outgoing TLS, so the production `Dockerfile`'s `npm ci` could **not** run as
>    written: the image was built from a **modified copy** that only adds the container's certificate
>    authority to the dependency stage (the final image stage is identical);
> 2. compose's own build step was **bypassed** (the stack used that pre-built image), so `docker compose up
>    --build` building the image itself was not exercised;
> 3. HTTPS was verified only with Caddy's **local** certificate, after setting `SITE_ADDRESS=localhost` **by
>    editing `.env` by hand** (`setup.sh` refuses `localhost`); no real Let's Encrypt certificate was
>    issued and no sslip.io address was opened from the internet.
>
> The hPanel menu names below may differ slightly from what you see. Section 18 is a checklist for your
> first real run: what to look for and what to report back if something fails.

**You never need to give anyone your hPanel password, your SSH password or the contents of your `.env`
file.** If someone (a person or an AI chat) asks for them, say no.

---

## 0. What you need

- A Hostinger **VPS** plan (not "web hosting" / "shared hosting": those cannot run Docker). At least
  **2 GB RAM** and **20 GB disk**; 4 GB RAM is more comfortable.
- About 30–45 minutes.
- Optional, for later: your own domain or subdomain (e.g. `vita.your-company.com`). The first install
  works **without** a domain.

## 1. Create the VPS in hPanel

1. Log in to hPanel → **VPS** → choose your plan / server → **Setup** (or **Manage** → **OS & Panel**
   → **Operating System** to reinstall).
2. **Location:** the data center closest to you and your candidates.
3. **Operating system:** **Ubuntu 24.04** (plain OS, no control panel). Ubuntu 22.04 also works.
   - If you pick an "Ubuntu with Docker" template instead, that is fine too: `setup.sh` will find Docker
     already installed and skip step 3.
4. **Root password:** choose a long unique password and keep it in a password manager. If hPanel offers
   **SSH key**, add yours (more secure; see section 14).
5. Wait until the VPS shows **Running**. Note the **IPv4 address** shown on the VPS overview page
   (example below: `203.0.113.10` — yours will differ).

## 2. Connect with SSH

From your computer:

- **Windows 10/11:** open **PowerShell**. **macOS / Linux:** open **Terminal**.
- (Or use the **Browser terminal** button in hPanel.)

```bash
ssh root@203.0.113.10
```

Type `yes` the first time, then the root password (nothing appears while you type — that is normal).

Create a normal user for daily work (replace `vita` with any name you like) and switch to it:

```bash
adduser vita
usermod -aG sudo vita
su - vita
```

From now on, connect with `ssh vita@203.0.113.10`.

## 3. Install Docker (official repository)

Skip this if `docker compose version` already prints a version. Otherwise copy this whole block:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Then **log out and back in** (`exit`, then `ssh vita@…` again) and check:

```bash
docker compose version
```

(These are the commands from Docker's own guide, https://docs.docker.com/engine/install/ubuntu/.)

## 4. Download VITA

```bash
cd ~
git clone -b claude/adoring-mendel-yrxr43 https://github.com/emnaservicesgroupe/emna.git
cd ~/emna/deploy/hostinger
```

- Use branch `claude/adoring-mendel-yrxr43` until it is merged; after the merge, clone without `-b …`
  (the default branch).
- If the repository is **private**, GitHub asks for a user name and a **personal access token** (not your
  GitHub password): create a read-only token on github.com → Settings → Developer settings. Do not paste
  the token anywhere else.

## 5. Run the setup

```bash
./setup.sh
```

What it does (safe to run again):

1. Checks Ubuntu, Docker, the compose plugin, `openssl` and `curl` (if Docker is missing it prints the
   commands of step 3 and stops — it never installs anything by itself).
2. Creates `deploy/hostinger/.env` from `.env.production.example`, **permissions 600**, with new random
   secrets made by `openssl rand -hex 32` (`JWT_SECRET`, `STORAGE_URL_SECRET`, `JOBSEARCH_REPLY_SECRET`,
   the password of the app's database role `vita_app`), and `deploy/hostinger/.env.db` (600) with a separate
   random password for the Postgres **superuser**, which only the database container reads. The secrets are
   **never printed**. An existing `.env` / `.env.db` is **never overwritten** (only an empty `SITE_ADDRESS` is
   filled in, or replaced when you pass `--domain`).
3. Works out the web address: without a domain it asks https://api.ipify.org for the server's public IP
   and uses `<ip-with-dashes>.sslip.io`, e.g. `203-0-113-10.sslip.io`. If that fails it asks you to type
   the IP (shown in hPanel).
4. Builds and starts three containers: **db** (PostgreSQL 16), **app** (VITA), **caddy** (HTTPS).
   Only Caddy is reachable from the internet (ports 80 and 443). The app and the database are not. On the
   first start the database creates the **unprivileged** role `vita_app` (no superuser, cannot create
   databases or roles, cannot run programs or read server files) that owns the VITA database; the app
   connects only as that role.
5. Waits until the app is healthy, checks HTTPS, and prints your address and the next steps.

Options:

```bash
./setup.sh --domain vita.your-company.com   # use your domain right away (DNS must point here, see section 9)
./setup.sh --configure-firewall             # also allow only your SSH port, 80 and 443 in ufw (section 13)
```

**About sslip.io:** it is a free, third-party DNS service: any name like `203-0-113-10.sslip.io` is
answered with `203.0.113.10`. It is convenient for a first test, but **its operator controls the DNS for
that name**: they could point it somewhere else or obtain certificates for it, and you depend on the
service being online (certificates for shared names like this can also hit the certificate authority's
limits). Use it only to try the system; for real candidates switch to **your own domain** (section 9).

## 6. Create the first administrator

Do this **right after** `setup.sh`, on the server:

```bash
./create-admin.sh
```

The account-creation endpoint is **not reachable from the internet**: Caddy answers 404 for it, and the app
itself (in production) only accepts it from inside the server without any proxy in between. That is why it
works only through this script, which runs inside the app container. Nobody who finds your address can
create an administrator before you do.

It asks for your name, e-mail and a password (typed **hidden**, twice). Rules: at least 12 characters,
not a common password, must not contain the part of your e-mail before `@`. The password is sent
directly to the app inside the server; it never appears on screen, in a file or in the process list.

This works **once**: as soon as any account exists it answers "Bootstrap is disabled" (even if two people
tried at the same moment, only one account would be created).

Staff sign-in: a wrong password and an unknown e-mail get the same message ("Invalid email or password").
Every attempt is counted the moment it arrives (also when many arrive at once): after 5 failed attempts
for one e-mail, or 10 from one address, within 15 minutes, sign-in is blocked ("Too many sign-in attempts")
for the rest of that window, even with the right password. The counters live **in the app's memory**: they
are per app process and are cleared when the app restarts (`docker compose restart app` also unlocks a
locked account).

## 7. Open VITA and sign in

- Staff console: `https://<your-address>/vita/admin.html` (the address `setup.sh` printed)
- Candidate portal: `https://<your-address>/vita/portal.html`
- `https://<your-address>/` is the public VITA website (Arabic, English, French) for browsers; it links to the portal and the staff console. The same address still answers the JSON status for API clients.

**Public website.** The public website is served at the domain root by the same app (no extra container). Everything about it is optional: the `SITE_*` variables in `.env` (phone, WhatsApp link, e-mail, postal address as `SITE_POSTAL_ADDRESS`, licence text, `SITE_BASE_URL`, `SITE_NAME`, lead limits, consent version) are hidden on the site until you set them, and `setup.sh` generates `SITE_IP_SALT` for you. In `.env`, `SITE_ADDRESS` stays the server host name for Caddy. See [../vita-website-crm/SETUP.md](../vita-website-crm/SETUP.md).

The first visit can take up to a minute while the certificate is created.

**What you will see on a new install:**

- An **empty system**: no candidates, no jobs, no applications.
- **Sources** show `requires_setup`: no job feed is connected, nothing is fetched. Staff can add jobs by
  hand (Employers & rules → manual job).
- **Health** shows mail as **"Sandbox — no real mail is sent"**. **Nobody receives any e-mail.** The
  sandbox accepts only addresses on `MAIL_SANDBOX_ALLOWLIST` (default: `*@test.invalid`) and stores those
  messages in the database table `js_sandbox_mail`; mail to **any other address is refused and not stored
  at all**.
- **Real candidates cannot sign in yet.** Candidates sign in with a code sent by e-mail; in sandbox mode a
  real address (gmail, hotmail, your company) never gets one and the code is not kept anywhere. Candidate
  sign-in needs **real mail** (`MAIL_PROVIDER=imap_smtp`, SMTP settings, `MAIL_FROM`, `MAIL_REAL_SEND=true`;
  section 10) - or, to try the flow yourself, an allow-listed **test** address (below).
- CV uploads work; without a malware scanner they are marked `scan_unavailable` (allowed as attachments
  only because nothing is really sent in sandbox mode).
- Daily/weekly sending caps are 0 by default, so even automatic mode sends nothing until an admin sets
  them.

Create staff and candidate accounts as described in [SETUP.md § 6](SETUP.md#6-staff-and-candidate-accounts).

**Try the candidate sign-in yourself (sandbox):**

1. In `.env`, add your own test address to the allow-list, e.g.
   `MAIL_SANDBOX_ALLOWLIST=*@test.invalid,you@your-company.com`, then `docker compose up -d`.
2. As admin, create a candidate account for that address (SETUP.md § 6).
3. In the candidate portal (`/vita/portal.html`) request a code for it. It is **not** delivered to your
   mailbox; read it on the server:

   ```bash
   ./show-sandbox-mail.sh        # newest 10 sandbox messages (to, subject, body)
   ```

   The output contains sign-in codes and personal data: admin use only, never paste it anywhere.
4. Remove your address from the allow-list again when you are done.

## 8. Optional: demo data (only on a fresh install)

If you want to click through VITA with sample data **before** creating your real admin:

```bash
./demo-seed.sh
```

It refuses to run if any real (non-DEMO) user exists. It prints one random demo password once
(SuperAdmin `demo.superadmin@test.invalid`, Manager `demo.manager@test.invalid`, two demo candidates).
Because a demo SuperAdmin then exists, `./create-admin.sh` is disabled. **Before real use, wipe
everything** (this deletes the whole database and all uploaded files of this install):

```bash
docker compose down -v
docker compose up -d
./create-admin.sh
```

## 9. Switch to your own domain (one setting)

1. At your domain's DNS provider (Hostinger: hPanel → **Domains** → your domain → **DNS / Nameservers**),
   add an **A record**: name `vita` (for `vita.your-company.com`) → value = your VPS IPv4. If an **AAAA**
   record exists for that name, it must point at this VPS too (or delete it).
2. Wait until it works: `getent hosts vita.your-company.com` on the VPS shows your IP (minutes to a few
   hours).
3. Change the one setting and restart:

   ```bash
   cd ~/emna/deploy/hostinger
   ./setup.sh --domain vita.your-company.com     # updates SITE_ADDRESS in .env only, keeps all secrets
   ```

   (Same thing by hand: edit `.env`, set `SITE_ADDRESS=vita.your-company.com`, then `docker compose up -d`.)
4. Caddy gets a certificate for the new name automatically. The old sslip.io address stops working.

**Certificate problems?** Check `./logs.sh caddy`. The usual causes: the DNS record does not point at
this server yet, ports 80/443 are closed in the hPanel firewall or ufw, or a wrong AAAA record.

## 10. Connecting real services later

Everything below stays off until you do it; follow the detailed pages:

- **Real e-mail** (SMTP, e.g. your Hostinger mailbox) and the **inbound reply bridge**:
  [SETUP.md § 10 Mail](SETUP.md#10-mail). In `.env`: `MAIL_PROVIDER=imap_smtp`, `MAIL_SMTP_*`,
  `MAIL_FROM` (a plain address of your domain), then `MAIL_REAL_SEND=true`.
  **Before** switching real mail on, set `ALLOW_UNSCANNED_ATTACHMENTS=false` or connect ClamAV — the app
  **refuses to start** with real mail + unscanned attachments + no ClamAV.
- **Job sources** (Job Bank feed, partner feeds): [SOURCES_AND_PROVIDERS.md](SOURCES_AND_PROVIDERS.md).
- **Malware scanning** (ClamAV): [SETUP.md § 8](SETUP.md#8-storage-private-files).

After every `.env` change: `docker compose up -d`. If a setting is wrong, the app does not start and
`./logs.sh app` lists **every** problem (setting names only, never values).

## 11. Updates

```bash
cd ~/emna/deploy/hostinger
./update.sh
```

It makes a backup first, then `git pull` (fast-forward only; it stops if files were changed locally),
pulls the newest `postgres:16` and `caddy:2` images, rebuilds the app on a fresh `node:22-slim`, and
restarts. Database migrations run automatically when the app starts. If the branch you cloned no longer
exists (for example after it was merged), it stops and prints the `git switch main` commands to use.

## 12. Backups and a restore test

```bash
./backup.sh                 # -> backups/vita-YYYYmmdd-HHMMSS/ (db.dump, storage.tar.gz, SHA256SUMS)
RETENTION=30 ./backup.sh    # keep the newest 30 (default 14)
```

Make it automatic every night at 03:17 (`crontab -e`, add one line; replace `vita` with your user):

```
17 3 * * * /home/vita/emna/deploy/hostinger/backup.sh >> /home/vita/vita-backup.log 2>&1
```

- Backups contain **personal data** (CVs, passport numbers). They are created with permissions 700.
- A backup on the same server does not survive the loss of the server: **copy them elsewhere** regularly
  (e.g. `scp -r vita@203.0.113.10:~/emna/deploy/hostinger/backups ./vita-backups` from your computer),
  and also consider Hostinger's VPS snapshots/backups in hPanel.
- Keep a copy of `deploy/hostinger/.env` in your password manager (it is not in the backup).

**Restore** (replaces the current data; asks you to type `RESTORE`, then offers a backup of the current
state first - say yes):

```bash
./restore.sh backups/vita-20261023-031700
```

Before changing anything it checks the backup's checksums and that the uploads archive can be read. It
then restores the database into a **temporary** database and only switches over when that fully
succeeded, and unpacks the uploaded files into a temporary folder before swapping them in - so a damaged
backup leaves your current data and files untouched. Whatever happens, it starts the app and Caddy again
at the end; the app then applies any newer database migrations itself.

**Test a restore** at least once: on a second (temporary) VPS, do sections 3–5, copy a backup folder there,
run `./restore.sh …`, sign in and check a few candidates and files.

## 13. Firewall

Only three ports need to be open: **22** (SSH), **80** and **443** (HTTPS; 443/udp is optional).

- hPanel: the VPS **Firewall** section — allow TCP 22, 80, 443.
- On the server (optional): `./setup.sh --configure-firewall` finds the port your SSH server really listens
  on, allows it plus 80/tcp, 443/tcp and 443/udp, and enables ufw. If it cannot find the SSH port it stops
  without enabling anything. **Keep your current SSH session open and test a new login before closing it.**
- The database (5432) and the app (5000) are never published to the internet by this kit.

## 14. Security notes

- **Old secrets in git history.** An old `trust-crm/.env` with development values was committed to this
  repository in the past. `setup.sh` generates **new** secrets, so those old values are not used by this
  install — but if any of those old values (passwords, keys) were ever used for a real database, mailbox
  or account anywhere, **change them there**.
- **Never paste secrets** (`.env` contents, passwords, tokens, SMTP passwords) into chats, e-mails,
  tickets or screenshots — including AI assistants.
- **SSH hardening** (recommended; do it carefully - a mistake can lock you out, in which case use hPanel's
  browser terminal / recovery console to undo it):
  1. On your computer: `ssh-keygen -t ed25519`, then `ssh-copy-id vita@203.0.113.10` (or add the public key
     in hPanel → VPS → SSH keys).
  2. **Test** that `ssh vita@203.0.113.10` logs in **without** asking for the server password.
  3. Only then, on the server: `sudo nano /etc/ssh/sshd_config.d/90-vita.conf` with the two lines
     `PermitRootLogin no` and `PasswordAuthentication no`, check with `sudo sshd -t`, then
     `sudo systemctl restart ssh`.
  4. **Keep the old session open** and open a new one to confirm you can still log in.
- **Database roles:** the app uses the unprivileged role `vita_app`. The Postgres **superuser** is named in
  `.env.db` (`POSTGRES_USER`, normally `postgres`) together with its password, which only the database
  container reads. `backup.sh` and `restore.sh` use that superuser **name** inside the database container,
  over its local socket, without a password.
- Keep Ubuntu updated: `sudo apt-get update && sudo apt-get upgrade -y` (monthly; reboot when asked).
- The app container runs as an unprivileged user with a read-only file system; only the storage volume
  is writable.
- Work through the security checklist in [SETUP.md § 14](SETUP.md#14-security-checklist-before-production)
  before real candidates use the system.

## 15. Everyday commands

```bash
cd ~/emna/deploy/hostinger
./status.sh            # containers, health, HTTPS check, disk, latest backup
./logs.sh app          # app logs (also: ./logs.sh caddy, ./logs.sh db); Ctrl+C to stop
docker compose restart app
docker compose down    # stop everything (data is kept)
docker compose up -d   # start again
```

`docker compose down -v` **deletes all data** (database, files, certificates). Only use it to wipe demo
data or a test install.

## 16. Troubleshooting

| Problem | Check | Fix |
|---|---|---|
| `setup.sh` says Docker is missing | `docker compose version` | Section 3, then log out and in again |
| `permission denied … docker.sock` | `groups` does not show `docker` | `sudo usermod -aG docker "$USER"`, log out and in |
| App keeps restarting | `./logs.sh app` | The log lists every wrong setting by name ("refusing to start …"): fix `.env`, `docker compose up -d` |
| `https://…` does not open / certificate error | `./logs.sh caddy` | Ports 80/443 open in hPanel firewall (and ufw)? DNS A record points at this server? Wait a few minutes after a DNS change |
| sslip.io address does not work | `getent hosts 203-0-113-10.sslip.io` | sslip.io may be down or rate-limited: use your own domain (section 9) |
| "Bootstrap is disabled" in `create-admin.sh` | an account already exists | Sign in with it; on a demo-only install wipe with `docker compose down -v` |
| Candidates receive no sign-in code | Health → Mail says Sandbox | Expected in sandbox mode: real addresses get nothing and nothing is stored. Connect real mail (section 10), or allow-list a test address and read its code with `./show-sandbox-mail.sh` (section 7) |
| "Too many sign-in attempts" | 5 wrong passwords for one e-mail (or 10 from one address) in 15 min | Wait 15 minutes, or `docker compose restart app` |
| No jobs appear | Sources show `requires_setup` | Expected: connect a source (SOURCES_AND_PROVIDERS.md) or add jobs by hand |
| Disk full | `./status.sh` (Disk) | Delete old backups after copying them elsewhere; `docker image prune -f` |
| `update.sh` stops: "local changes" | `git status` | Undo the local edits (`git checkout -- <file>`) or ask your developer |
| `update.sh` stops: branch "no longer exists" | the cloned branch was merged | Run the `git fetch` / `git switch main` lines it prints |
| App keeps restarting with "password authentication failed for user vita_app" or "role vita_app does not exist" | the very first start of the database failed or was interrupted, so the role was never created | **Only on a fresh install without data:** `docker compose down -v`, then `./setup.sh` again (the role is created when the database volume is first initialised) |
| `setup.sh` warns that a database volume already exists | the volume was created by an earlier version of this kit | Demo/test install: `docker compose down -v` (deletes all data) and run `./setup.sh` again. Install with real data: in `.env.db` set `POSTGRES_USER` and `POSTGRES_PASSWORD` to the old `DB_USER` / `DB_PASSWORD` from `.env` so backups and restores work, and ask your developer to move the app to an unprivileged role |
| `restore.sh` failed | its last messages | The current data is kept when the failure happened before "Switching to the restored database"; the app and Caddy are started again either way |

## 17. What was and was not tested

All of this ran in the development container described at the top, **not** on a Hostinger VPS.

| Item | Status |
|---|---|
| Image build | Built from a **modified copy** of the production `Dockerfile` (adds the test container's TLS certificate authority to the dependency stage only; final stage identical; checked that no CA/proxy setting ends up in the image). The unmodified `npm ci` step was **not** run (the container intercepts TLS). Result: non-root `node` user, no tests/`.env` in the image, native modules (bcrypt) and parsers load. |
| `docker compose` build step | **Bypassed**: the stack ran with a scratch override that uses the pre-built image (compose v5's builder needed extra privileges there). `docker compose up --build` / `build --pull` building the image itself: **not tested**. |
| Stack: db + app + caddy healthy, migrations on an empty database, app connected as unprivileged `vita_app` (`\du`: no attributes; `COPY … TO PROGRAM`, `CREATE DATABASE`, `pg_read_file` refused) | Tested |
| Only ports 80/443 published; app 5000 and database 5432 not reachable from outside | Tested |
| HTTPS, `/` → `/vita/` (this redirect was removed when the public website was added: `/` now reaches the app; **not re-run** on a stack), security headers, live events not buffered, 13 MB body refused (413; Caddy also allows 120 s to receive a request body, for slow uploads), optional ACME e-mail snippet (invalid value ignored) | Tested with Caddy's **local** certificate after setting `SITE_ADDRESS=localhost` **by hand in `.env`** (setup.sh refuses localhost) |
| Bootstrap protection: `POST /auth/bootstrap-super-admin` through Caddy (6 path variants) → 404; directly from another container → 404; nothing created; `create-admin.sh` from inside the app container → created once | Tested |
| `/auth/login` limits through Caddy: 5 failures → 429 with `Retry-After` | Tested |
| `setup.sh` (new install; re-run keeps `.env`/`.env.db`; empty `SITE_ADDRESS` re-detected), `demo-seed.sh` (fresh DB / refused on a real one), candidate sign-in with an allow-listed demo address + `show-sandbox-mail.sh`, non-allow-listed address stores nothing, `backup.sh`, `restore.sh` over a database with **newer** FK-linked tables (succeeded, stack back up), `restore.sh` with a **damaged** dump (failed, data kept, stack back up), graceful stop (exit 0), preflight refusal, `update.sh` refusal on a dirty checkout | Run in the development container |
| Real Hostinger VPS, hPanel steps, real Let's Encrypt certificate, sslip.io from the internet, `--configure-firewall`, `update.sh` doing a real `git pull` + image pulls, SSH hardening steps | **Not tested** |

## 18. First real run — checklist

Tick these on your server; if one fails, send your developer the **step number, the command, and the last
~30 lines of its output** (from `./logs.sh app` or `./logs.sh caddy`) - **never** the `.env` / `.env.db` files,
passwords, tokens or sign-in codes.

1. `docker compose version` prints a version (section 3).
2. `./setup.sh` ends with "App is healthy." and, within a few minutes, "HTTPS works".
   If HTTPS does not work: `./logs.sh caddy` (look for "certificate obtained" or an error), check ports
   80/443 in the hPanel firewall.
3. `https://<your-address>/vita/` opens with a padlock (no certificate warning).
4. `https://<your-address>/auth/bootstrap-super-admin` in a browser shows "Not found" (expected).
5. `./create-admin.sh` says "SuperAdmin created"; you can sign in at `/vita/admin.html`.
6. Health (admin console) shows mail "Sandbox — no real mail is sent" and sources "requires_setup".
7. `./status.sh`: three containers up, app `200 {"ok":true}`, HTTPS reachable.
8. `./backup.sh` creates a folder in `backups/`; add the cron line (section 12).
9. Optional: try the candidate sign-in with an allow-listed test address (section 7).
10. Optional, before real candidates: a restore test on a spare VPS (section 12) and your own domain
    (section 9).
