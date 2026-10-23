# VITA on a Hostinger VPS — step-by-step

البحث الآلي عن عمل / AI Job Search & Applications

This guide puts VITA (the EMNA CRM with the AI job-search module) on **your own Hostinger VPS** with
Docker. It is written for a non-technical owner: copy each command exactly, one block at a time.

**What you get at the end:** VITA at an `https://…/vita/` address with a real certificate, a database
and file storage on your server, daily backups, and everything in **safe sandbox mode** — no real e-mail
is sent and no live job source is connected until you decide to switch them on.

> **Honest status (read this).** This kit was built and tested inside a development container (Ubuntu
> 24.04, Docker 29, compose v5): the image builds, the three containers start and become healthy, the
> database is created and migrated, the first admin can be created and can sign in over HTTPS, the demo
> seed works on a fresh database and refuses a real one, backup → restore was verified, and the server
> stops cleanly. It has **NOT** been run on a real Hostinger VPS. A real Let's Encrypt certificate has
> **not** been issued (the test container cannot be reached from the internet; HTTPS was tested with
> Caddy's local certificate instead), and the sslip.io address has not been tried from the internet. The
> hPanel menu names below may differ slightly from what you see.

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
   the database password). The secrets are **never printed**. An existing `.env` is **never overwritten**.
3. Works out the web address: without a domain it asks https://api.ipify.org for the server's public IP
   and uses `<ip-with-dashes>.sslip.io`, e.g. `203-0-113-10.sslip.io`. If that fails it asks you to type
   the IP (shown in hPanel).
4. Builds and starts three containers: **db** (PostgreSQL 16), **app** (VITA), **caddy** (HTTPS).
   Only Caddy is reachable from the internet (ports 80 and 443). The app and the database are not.
5. Waits until the app is healthy, checks HTTPS, and prints your address and the next steps.

Options:

```bash
./setup.sh --domain vita.your-company.com   # use your domain right away (DNS must point here, see section 9)
./setup.sh --configure-firewall             # also allow only SSH/80/443 in ufw (section 12)
```

**About sslip.io:** it is a free, third-party DNS service run by volunteers: any name like
`203-0-113-10.sslip.io` simply points at `203.0.113.10`. It is convenient for a first test, but you
depend on it being online, and certificates for shared names like this can occasionally hit the
certificate authority's limits. For real use, switch to **your own domain** (section 9).

## 6. Create the first administrator

```bash
./create-admin.sh
```

It asks for your name, e-mail and a password (typed **hidden**, twice). Rules: at least 12 characters,
not a common password, must not contain the part of your e-mail before `@`. The password is sent
directly to the app inside the server; it never appears on screen, in a file or in the process list.

This works **once**: as soon as any account exists it answers "Bootstrap is disabled".

## 7. Open VITA and sign in

- Staff console: `https://<your-address>/vita/admin.html` (the address `setup.sh` printed)
- Candidate portal: `https://<your-address>/vita/portal.html`
- `https://<your-address>/` opens `/vita/` automatically.

The first visit can take up to a minute while the certificate is created.

**What you will see on a new install:**

- An **empty system**: no candidates, no jobs, no applications.
- **Sources** show `requires_setup`: no job feed is connected, nothing is fetched. Staff can add jobs by
  hand (Employers & rules → manual job).
- **Health** shows mail as **"Sandbox — no real mail is sent"**. Every e-mail (including candidate sign-in
  codes) is only stored in the database table `js_sandbox_mail`; nobody receives it.
- CV uploads work; without a malware scanner they are marked `scan_unavailable` (allowed as attachments
  only because nothing is really sent in sandbox mode).
- Daily/weekly sending caps are 0 by default, so even automatic mode sends nothing until an admin sets
  them.

Create staff and candidate accounts as described in [SETUP.md § 6](SETUP.md#6-staff-and-candidate-accounts).

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
rebuilds the app and restarts it. Database migrations run automatically when the app starts.

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

**Restore** (replaces the current data; asks you to type `RESTORE`):

```bash
./restore.sh backups/vita-20261023-031700
```

**Test a restore** at least once: on a second (temporary) VPS, do sections 3–5, copy a backup folder there,
run `./restore.sh …`, sign in and check a few candidates and files.

## 13. Firewall

Only three ports need to be open: **22** (SSH), **80** and **443** (HTTPS; 443/udp is optional).

- hPanel: the VPS **Firewall** section — allow TCP 22, 80, 443.
- On the server (optional): `./setup.sh --configure-firewall` allows OpenSSH, 80/tcp, 443/tcp, 443/udp
  and enables ufw. Make sure SSH is allowed before enabling any firewall.
- The database (5432) and the app (5000) are never published to the internet by this kit.

## 14. Security notes

- **Old secrets in git history.** An old `trust-crm/.env` with development values was committed to this
  repository in the past. `setup.sh` generates **new** secrets, so those old values are not used by this
  install — but if any of those old values (passwords, keys) were ever used for a real database, mailbox
  or account anywhere, **change them there**.
- **Never paste secrets** (`.env` contents, passwords, tokens, SMTP passwords) into chats, e-mails,
  tickets or screenshots — including AI assistants.
- **SSH keys:** prefer SSH keys over passwords (`ssh-keygen -t ed25519` on your computer, add the public
  key in hPanel or `~/.ssh/authorized_keys`); then you can disable password login.
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
| Candidates receive no sign-in code | Health → Mail says Sandbox | Expected in sandbox mode: codes are only in `js_sandbox_mail`. Connect real mail (section 10) |
| No jobs appear | Sources show `requires_setup` | Expected: connect a source (SOURCES_AND_PROVIDERS.md) or add jobs by hand |
| Disk full | `./status.sh` (Disk) | Delete old backups after copying them elsewhere; `docker image prune -f` |
| `update.sh` stops: "local changes" | `git status` | Undo the local edits (`git checkout -- <file>`) or ask your developer |

## 17. What was and was not tested

| Item | Status |
|---|---|
| Image build (node:22-slim, production dependencies, non-root) | Tested in the development container |
| `docker compose` stack: db + app + caddy healthy, migrations from an empty database | Tested in the development container |
| Only ports 80/443 published; app and database not reachable from outside | Tested (`docker compose ps`, static tests) |
| HTTPS through Caddy, `/` → `/vita/`, security headers | Tested with Caddy's **local** certificate (`SITE_ADDRESS=localhost`) |
| `setup.sh`, `create-admin.sh` (weak password refused, created once), `demo-seed.sh` (fresh DB / refused on real DB), `backup.sh`, `restore.sh`, graceful stop, preflight refusal | Run in the development container |
| Real Hostinger VPS, hPanel steps, real Let's Encrypt certificate, sslip.io from the internet, `--configure-firewall`, `update.sh` doing a real `git pull` | **Not tested** |
