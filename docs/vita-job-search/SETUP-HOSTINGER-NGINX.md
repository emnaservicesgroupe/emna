# VITA on a server that already has nginx

البحث الآلي عن عمل / AI Job Search & Applications

Use this guide **instead of** [SETUP-HOSTINGER.md](SETUP-HOSTINGER.md) when your VPS **already runs a web
server (nginx) on ports 80 and 443** - for example because an older EMNA CRM is served from it. VITA's normal
install starts its own web server (Caddy) on those ports, which would collide with nginx. In this mode:

- VITA is just two containers (database + app). The app listens **only on `127.0.0.1:8083`** (the server
  itself, never the internet); the database listens on nothing.
- Your existing **nginx stays in charge** of ports 80/443 and the certificates. You add **one new file**
  that sends one host name to VITA. Every other site keeps working exactly as before.
- Everything of VITA is called `vita` (containers `vita-app-1`, `vita-db-1`, network `vita_backend`,
  volumes `vita_db-data` and `vita_app-storage`), so it cannot mix with your old CRM's containers.
- The scripts **print** the nginx block and the certbot command; **you** review and run them. Nothing
  touches nginx, certbot or the firewall by itself.

> **Honest status.** This mode was exercised in a development container (see
> [section 10](#10-what-was-and-was-not-tested)), **not** on your server. Follow the steps one at a time and
> stop at the first error message; nothing here is irreversible except the explicit wipe in section 9.

You are probably working as **root** in hPanel's *Web console*. That works: no `sudo` and no docker group
are needed (the commands below are written for root).

## 1. Before you start: read-only check

These commands only **look**; they change nothing. Run the block and keep the answers.

```bash
# What is running (VITA must not collide with any of this)
docker ps --format 'table {{.Names}}\t{{.Ports}}'
# Which loopback ports are taken (8083 should be free; the setup picks the next free one if not)
ss -ltnp | grep -E ':(80|443|808[0-9]|809[0-9]|5678)\b'
# Which host names nginx already serves (the new name must NOT be in this list)
nginx -T 2>/dev/null | grep server_name
# Tools
docker compose version
git --version
certbot --version
certbot plugins
# Free disk and memory (VITA needs roughly 2 GB RAM and a few GB disk)
df -h / && free -h
```

You should see your old CRM containers (`emnacrm-*`, `gb-clamav`, `n8n`) and nginx on 80/443. **Leave them
alone** (section 8).

## 2. Download VITA to /opt/vita

Your old CRM lives in `/opt/emna-crm-v2/app`; VITA gets its **own folder**, `/opt/vita`:

```bash
cd /opt
git clone -b claude/adoring-mendel-yrxr43 https://github.com/emnaservicesgroupe/emna.git vita
cd /opt/vita/deploy/hostinger
```

- Use branch `claude/adoring-mendel-yrxr43` until it is merged; afterwards clone without `-b …`.
- If the repository is private, GitHub asks for a user name and a **personal access token** (not your
  password).
- Always work from `/opt/vita/deploy/hostinger`. Never from the old CRM's folder.

## 3. DNS: point the domain at this server (hPanel)

The certificate can only be issued once the name points at this server (`187.77.108.1`). Your domain
`ehiservices.online` currently shows Hostinger's *parked domain* page, so its records can be changed.

1. hPanel -> **Domains** -> **ehiservices.online** -> **DNS / Nameservers** -> **DNS records**.
2. **Edit** the existing **A** record for **`@`** (the bare domain) and the one for **`www`**: set
   **Points to** `187.77.108.1`, TTL `300`. **Edit the existing records - do not add a second A record**,
   otherwise visitors are shared between the new and the old parking address (`2.57.91.91`).
3. Leave **every other record untouched**: MX, TXT, CNAME, DKIM and SPF records are your Hostinger e-mail
   and must stay exactly as they are.
4. If there is an **AAAA** record for `@` or `www` that does not point to this server, remove it (an IPv6
   address of the parking page would still be used by some visitors). If you are unsure, ask your developer to look at
   the list of records first.
5. Wait a few minutes, then check on the server (both lines must print `187.77.108.1`):

   ```bash
   getent hosts ehiservices.online
   getent hosts www.ehiservices.online
   ```

   **Do not continue to the certificate step until both do** - certbot fails otherwise.

**Prefer a subdomain, or want to test before DNS is changed?** Any name works the same way:
`vita.ehiservices.online` (add an **A** record named `vita` -> `187.77.108.1`) or the free test name
`vita.187-77-108-1.sslip.io`, which points at the server without any DNS change (like your existing
`test-crm.187-77-108-1.sslip.io`). Use it as the `--domain` in section 4 instead.

**What visitors will see:** the public website (the bare address, `https://ehiservices.online/`) is served
to the whole world - that is the intended result. Staff sign in at `/vita/admin.html`, candidates at
`/vita/`.

## 4. Install VITA (database + app)

```bash
cd /opt/vita/deploy/hostinger
./setup.sh --behind-nginx --domain ehiservices.online
```

Options: `--port 8084` (choose the loopback port yourself; default: the first free one from 8083),
`--no-www` (do not also answer for `www.`). Without `--domain` it uses `vita.<your-ip>.sslip.io`.

What it does, in order: checks for a container project called `vita` that came from another folder (it
refuses if one exists), checks that the port is free (it refuses and suggests the next free one if not),
checks that the name is not already a `server_name` in nginx and whether it already points at this server
(a warning only), creates `.env` and `.env.db` with generated secrets (never shown), builds and starts
**only** the database and the app, waits for `http://127.0.0.1:8083/healthz`, and finally **prints** the
nginx server block and the commands of section 5. It is safe to run again. The first build takes several
minutes.

VITA starts in **safe sandbox mode**: no real e-mail is sent and no live job source is connected.

## 5. Add VITA to nginx (you run these, one at a time)

`./setup.sh` printed the exact commands with your name filled in; `./nginx-config.sh` prints them again at
any time. In short:

1. **Check that the name is free** - this must print nothing:
   `nginx -T 2>/dev/null | grep -E 'server_name[^;]*[[:space:]](www\.)?ehiservices.online[;[:space:]]'`
2. **Install the HTTP part** (so the certificate can be issued), then check and reload:

   ```bash
   mkdir -p /var/www/vita-acme
   cp /opt/vita/deploy/hostinger/nginx-vita.generated-http-only.conf /etc/nginx/sites-available/vita
   ln -s /etc/nginx/sites-available/vita /etc/nginx/sites-enabled/vita
   nginx -t
   systemctl reload nginx
   ```

   If `nginx -t` prints an error, **do not reload**: remove the link (`rm /etc/nginx/sites-enabled/vita`)
   and tell your developer.
3. **Certificate.** Run `certbot plugins` first and pick the matching form:
   - nginx plugin listed -> `certbot --nginx -d ehiservices.online -d www.ehiservices.online` (certbot
     edits the file itself; skip the next step), or
   - the form that works everywhere:
     `certbot certonly --webroot -w /var/www/vita-acme -d ehiservices.online -d www.ehiservices.online --deploy-hook "systemctl reload nginx"`
4. **Install the full file** (HTTPS), check, reload (only after the webroot form):

   ```bash
   cp /opt/vita/deploy/hostinger/nginx-vita.generated.conf /etc/nginx/sites-available/vita
   nginx -t
   systemctl reload nginx
   ```
5. **Test:** `curl -I https://ehiservices.online/healthz`, then open `https://ehiservices.online/`.

What the nginx file does: answers **only** for your name (never `default_server`, so it cannot steal
requests from your other sites), redirects `www.` to the bare name, sends everything to
`127.0.0.1:8083`, answers **404** for the first-administrator address from the internet, allows uploads up
to 12 MB, and sends the three live-event addresses (`/chat/events`, `/jobsearch/events`, `/mcp`) through
without buffering. It adds **no** security headers of its own - the application sets its own, and a second
`Content-Security-Policy` would conflict. (HSTS is a commented line you can enable later.)

**Roll back** at any time; your other sites are unaffected and VITA keeps running on the loopback:

```bash
rm /etc/nginx/sites-enabled/vita
nginx -t
systemctl reload nginx
```

Certificates renew by themselves (certbot's own timer); the `--deploy-hook` reloads nginx afterwards.

## 6. Create the first administrator

On the server, in `/opt/vita/deploy/hostinger`:

```bash
./create-admin.sh
```

It asks for a name, an e-mail and a password (hidden, at least 12 characters) and works **once**. This is
the **only** way: the address that creates the first admin is blocked in nginx and refused by the
application for anything that arrives through a proxy. Then sign in at
`https://ehiservices.online/vita/admin.html`.

## 7. Everyday commands

```bash
cd /opt/vita/deploy/hostinger
./status.sh        # the two containers, app health, loopback check, disk, latest backup
./logs.sh app      # also ./logs.sh db  (there is no Caddy in this mode)
./backup.sh        # database + uploaded files -> backups/ (copy them off the server!)
./update.sh        # backup, git pull, rebuild, restart (database migrations run by themselves)
./restore.sh backups/vita-YYYYmmdd-HHMMSS    # asks you to type RESTORE; prints the project and volumes first
./nginx-config.sh  # prints the nginx block and commands again
```

Daily backup cron (as root): `17 3 * * * /opt/vita/deploy/hostinger/backup.sh >> /var/log/vita-backup.log 2>&1`

After editing `.env`: `cd /opt/vita/deploy/hostinger && docker compose up -d db app`. Connecting real
e-mail, job sources and so on works as in [SETUP-HOSTINGER.md](SETUP-HOSTINGER.md) sections 10-12.

## 8. What NOT to touch, and the old CRM side by side

- **Never** stop, restart, rebuild, rename or delete `emnacrm-prod-app-1`, `emnacrm-test-app-1`,
  `emnacrm-prod-db-1`, `emnacrm-test-db-1`, `gb-clamav` or `n8n`, nor their volumes or networks. VITA never
  needs them and these scripts never name them.
- **Never** run `docker compose down -v` (or `docker volume prune`, `docker system prune`) by hand. `-v`
  deletes volumes, and `docker compose` acts on whatever project the **current folder** belongs to. To wipe
  VITA's own demo data use `./wipe-data.sh` in `/opt/vita/deploy/hostinger` only: it shows the project and
  volume names and asks you to type `vita`.
- Do not edit the existing files in `/etc/nginx/sites-enabled/` (`crm`, `emna-crm-v2-*`, `trustcrm`,
  `website`, `n8n`, ...). VITA adds one **new** file named `vita`.
- The old CRM keeps its own address, its own containers and its own database. Both systems run side by side.
  VITA uses ports 80/443 only through your nginx and the loopback port 8083 (old CRM: 8081 and 8082, n8n:
  5678).
- **VITA has its own, empty database.** Moving data from the old EMNA CRM into VITA is a separate decision
  and is **not** covered here.
- The existing **ClamAV** container (`gb-clamav`) is **not used** by VITA yet. Pointing VITA's attachment
  scanning at it is a possible later step and out of scope here.

## 9. Troubleshooting

| Problem | What to do |
|---|---|
| `setup.sh`: "port 8083 ... already in use" | Nothing was changed. Use the port it suggests: `./setup.sh --behind-nginx --port 8084` |
| "containers of a compose project named 'vita' ... another folder" | A different `vita` project exists. Do not touch it; ask your developer |
| "this folder is already set up in Caddy mode" | This folder was installed in the normal mode; switching in place is not supported |
| `nginx -t` fails | Do not reload. `rm /etc/nginx/sites-enabled/vita` and send the error text to your developer |
| certbot: "unauthorized" / "no valid A records" | The DNS record does not point to `187.77.108.1` yet (section 3) - `getent hosts` must show it |
| Browser: the old CRM page appears instead of VITA | The name is not in a `server_name` of the new file, or the file is not in `sites-enabled`: `nginx -T \| grep -n vita` |
| `./status.sh`: loopback does not answer | `./logs.sh app` lists every wrong setting by name |
| 502 Bad Gateway | The app is down: `./status.sh`, `./logs.sh app` |
| Wipe a demo/test install | `./wipe-data.sh` (deletes **all** VITA data) |

## 10. What was and was not tested

Ran in a development container (Ubuntu, Docker 29, compose v5), **not** on your server:

- the real `setup.sh --behind-nginx` (image build, db+app only, `127.0.0.1:8083` only, no database port,
  `vita*` names), re-running it, the port-in-use refusal, the foreign-`vita`-project refusal;
- the two generated nginx files pass `nginx -t` in a real nginx 1.27; a throw-away nginx container (HTTP,
  test host name) in front of the app: `/healthz`, the public site, `/vita/admin.html`, the bootstrap address
  answers 404 in 5 spellings, `create-admin.sh`, `/chat/events` delivers its first events immediately
  (unbuffered);
- `backup.sh`, `restore.sh`, `status.sh`, `logs.sh`, `wipe-data.sh`, the project-name guard; the default
  Caddy mode still comes up.

**Not tested:** your real nginx and its existing sites, certbot and Let's Encrypt, DNS at Hostinger,
Ubuntu's `docker.io` packages (Docker 29.1.3 / compose 2.40.3 on your server), running as root in hPanel's
web console, `update.sh` with a real `git pull`, the `.env`-driven `COMPOSE_FILE` with your exact compose
version (the scripts pass the files explicitly with `-f`, so they do not depend on it).

If a step fails, send your developer the **step number, the command and the last ~30 lines of its output**
- never `.env`, `.env.db`, passwords or tokens.
