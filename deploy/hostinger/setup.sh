#!/usr/bin/env bash
# VITA first-time setup on an Ubuntu VPS (Task 20). Run as a normal user that can use sudo, from this folder:
#
#   ./setup.sh                              first run without a domain (uses <server-ip>.sslip.io)
#   ./setup.sh --domain vita.example.com    use your own domain (its DNS A record must point at this server)
#   ./setup.sh --configure-firewall         also allow your SSH port, 80 and 443 in ufw and enable it
#   ./setup.sh --behind-nginx [--port 8083] [--domain NAME] [--www|--no-www]
#                                           a web server (nginx) ALREADY uses ports 80/443: no Caddy; the app
#                                           listens only on 127.0.0.1:PORT; prints the nginx block + certbot
#                                           command for you to review and run (nothing is changed in nginx)
#   ./setup.sh --help
#
# Safe to run again: an existing .env / .env.db is never overwritten (only SITE_ADDRESS is updated when
# --domain is given or when it is still empty), secrets are generated once and never printed, and
# `docker compose up -d --build` is idempotent.
# Everything starts in SAFE SANDBOX MODE: no real e-mail, no live job sources.
# Works as root (hPanel web console) or as a user that can use Docker / sudo.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. ./lib.sh

# Temporary files from set_env are removed on every exit path.
cleanup_tmp() { rm -f .env.tmp.* .env.db.tmp.* 2> /dev/null || true; }
trap cleanup_tmp EXIT

DOMAIN=""
FIREWALL=0
ALLOW_NON_UBUNTU=0
ASSUME_YES=0
HEALTH_TIMEOUT=300
BEHIND_NGINX=0
PORT=""
WWW=""

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)
      [ $# -ge 2 ] || die "--domain needs a value, e.g. --domain vita.example.com"
      DOMAIN="$2"; shift 2 ;;
    --domain=*) DOMAIN="${1#--domain=}"; shift ;;
    --behind-nginx) BEHIND_NGINX=1; shift ;;
    --port)
      [ $# -ge 2 ] || die "--port needs a value, e.g. --port 8083"
      PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#--port=}"; shift ;;
    --www) WWW=1; shift ;;
    --no-www) WWW=0; shift ;;
    --configure-firewall) FIREWALL=1; shift ;;
    --allow-non-ubuntu) ALLOW_NON_UBUNTU=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# A host name we are willing to write into .env / the Caddyfile: lower-case letters, digits, dots, dashes.
valid_hostname() {
  local h="$1"
  [ "${#h}" -le 253 ] || return 1
  # labels of letters/digits/dashes; TLD letters only, or an IDN TLD in punycode (xn--...)
  [[ "$h" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$ ]]
}

valid_ipv4() {
  local ip="$1" part
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  IFS=. read -r -a parts <<< "$ip"
  for part in "${parts[@]}"; do
    [ "$part" -le 255 ] || return 1
  done
}

if [ -n "$PORT" ]; then
  [ "$BEHIND_NGINX" -eq 1 ] || die "--port only makes sense together with --behind-nginx"
  [[ "$PORT" =~ ^[0-9]{4,5}$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "--port must be a number between 1024 and 65535 (default 8083)"
fi
if [ -n "$WWW" ] && [ "$BEHIND_NGINX" -ne 1 ]; then
  die "--www / --no-www only make sense together with --behind-nginx"
fi
if [ "$BEHIND_NGINX" -eq 1 ] && [ "$FIREWALL" -eq 1 ]; then
  die "--configure-firewall opens ports 80/443 for Caddy; it is not used with --behind-nginx (your nginx and firewall already handle them)"
fi

if [ -n "$DOMAIN" ]; then
  DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
  valid_hostname "$DOMAIN" || die "'$DOMAIN' is not a valid domain name (example: vita.example.com)"
fi

# ------------------------------------------------------------------ 1. operating system
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_ID="$(. /etc/os-release && printf '%s' "${ID:-unknown}")"
  # shellcheck disable=SC1091
  OS_VERSION="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
else
  OS_ID="unknown"; OS_VERSION=""
fi
if [ "$OS_ID" != "ubuntu" ]; then
  [ "$ALLOW_NON_UBUNTU" -eq 1 ] || die "this kit is written for Ubuntu 22.04/24.04 (found: $OS_ID $OS_VERSION). Use --allow-non-ubuntu to try anyway."
  warn "not Ubuntu ($OS_ID $OS_VERSION): continuing because of --allow-non-ubuntu"
else
  case "$OS_VERSION" in
    22.04|24.04) ;;
    *) warn "Ubuntu $OS_VERSION is not 22.04 or 24.04; continuing" ;;
  esac
fi

# ------------------------------------------------------------------ 2. tools
print_docker_install() {
  cat <<'TXT'
Docker Engine with the compose plugin is required. Install it from Docker's official apt repository
(https://docs.docker.com/engine/install/ubuntu/), then log out and back in:

  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"     # then log out and log in again

Then run ./setup.sh again.
TXT
}

command -v docker > /dev/null 2>&1 || { print_docker_install; exit 1; }
docker compose version > /dev/null 2>&1 || { say "The Docker compose plugin is missing."; print_docker_install; exit 1; }
command -v openssl > /dev/null 2>&1 || die "openssl is missing: sudo apt-get install -y openssl"
command -v curl > /dev/null 2>&1 || die "curl is missing: sudo apt-get install -y curl"

DOCKER=(docker)
if ! docker info > /dev/null 2>&1; then
  if sudo -n true 2> /dev/null || [ -t 0 ]; then
    say "Your user cannot talk to Docker yet; using sudo (tip: sudo usermod -aG docker \"\$USER\", then log in again)."
    sudo docker info > /dev/null 2>&1 || die "Docker is installed but not running: sudo systemctl enable --now docker"
    DOCKER=(sudo docker)
  else
    die "cannot reach the Docker daemon (is it running? sudo systemctl enable --now docker)"
  fi
fi
# compose() comes from lib.sh (vita_init, below): fixed project name, files and profile for the chosen mode.

[ -f docker-compose.yml ] || die "docker-compose.yml not found next to setup.sh"
[ -f .env.production.example ] || die ".env.production.example not found next to setup.sh"

# ------------------------------------------------------------------ 3. .env (secrets generated once, never printed)
# set_env FILE KEY VALUE: replace the KEY= line in FILE. The value reaches awk through the environment
# (ENVIRON), never as program text or a -v assignment, so no character in it is interpreted.
set_env() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp "${file}.tmp.XXXXXX")"
  chmod 600 "$tmp"
  SET_KEY="$key" SET_VALUE="$value" awk 'BEGIN { k = ENVIRON["SET_KEY"]; v = ENVIRON["SET_VALUE"]; done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$file" > "$tmp"
  mv "$tmp" "$file"
}
get_env() {
  local key="$1"
  grep -E "^${key}=" .env 2> /dev/null | tail -n 1 | cut -d= -f2- || true
}
# ensure_env KEY VALUE: add KEY=VALUE only when .env has no KEY= line at all; an existing value is never overwritten.
ensure_env() {
  local key="$1" value="$2"
  grep -qE "^${key}=" .env 2> /dev/null || set_env .env "$key" "$value"
}

detect_site_address() {
  local ip=""
  ip="$(curl -fsS --max-time 10 https://api.ipify.org 2> /dev/null || true)"
  if ! valid_ipv4 "$ip"; then
    warn "could not detect the public IPv4 address automatically (https://api.ipify.org)."
    if [ -t 0 ]; then
      IFS= read -r -p "Type this server's public IPv4 address (shown in hPanel > VPS > Overview): " ip
    fi
    valid_ipv4 "$ip" || die "no valid IPv4 address; run again with --domain your.domain or type the IP when asked"
  fi
  if [ "$BEHIND_NGINX" -eq 1 ]; then
    # nginx mode: a name of its own, so it cannot clash with another sslip.io name already served on this server
    printf 'vita.%s.sslip.io' "${ip//./-}"
  else
    printf '%s.sslip.io' "${ip//./-}"
  fi
}

# ------------------------------------------------------------------ 3a. mode, project name, loopback port (nginx mode)
existing_mode=""
if [ -f .env ]; then
  existing_mode="caddy"
  if [ "$(get_env VITA_DEPLOY_MODE)" = "nginx" ]; then existing_mode="nginx"; fi
  case "$(get_env COMPOSE_FILE)" in *docker-compose.nginx.yml*) existing_mode="nginx" ;; esac
fi
if [ "$BEHIND_NGINX" -eq 1 ]; then
  [ "$existing_mode" != "caddy" ] || die "this folder is already set up in Caddy mode (.env). Switching modes in place is not supported: back up with ./backup.sh and ask your developer, or use a clean server."
  [ -f docker-compose.nginx.yml ] && [ -f nginx-vita.conf.example ] || die "docker-compose.nginx.yml / nginx-vita.conf.example not found next to setup.sh"
  [ -n "$PORT" ] || PORT="$(get_env VITA_APP_PORT)"
  export VITA_MODE_FORCE=nginx
  vita_init
  # 1. a compose project named "$PROJECT" that this kit did not create (another folder) must not be mixed with ours
  if [ "$PROJECT" != "vita" ]; then die "COMPOSE_PROJECT_NAME is '$PROJECT'; this kit always uses 'vita' (never 'app' or any name of another project)"; fi
  here_phys="$(pwd -P)"; here_log="$(pwd)"
  while IFS= read -r wd; do
    [ -n "$wd" ] || continue
    if [ "$wd" != "$here_phys" ] && [ "$wd" != "$here_log" ]; then
      die "Docker containers of a compose project named 'vita' already exist but were created from another folder ($wd), not from this kit ($here_phys). Refusing to touch them. Stop here and ask your developer."
    fi
  done < <("${DOCKER[@]}" ps -a --filter "label=com.docker.compose.project=vita" --format '{{.Label "com.docker.compose.project.working_dir"}}' 2> /dev/null | sort -u)
  # 2. the loopback port: free (or already ours from an earlier run of this setup)
  own_app="$(compose ps -q app 2> /dev/null || true)"
  own_port=""
  if [ -n "$own_app" ]; then
    own_port="$("${DOCKER[@]}" port "$own_app" 5000/tcp 2> /dev/null | sed -n 's/^127\.0\.0\.1://p' | head -n 1 || true)"
  fi
  if [ -z "$PORT" ]; then
    PORT="$(next_free_port)"
    [ -n "$PORT" ] || die "no free loopback port between 8083 and 8099; free one or choose with --port"
    say "Loopback port: $PORT (the first free port from 8083)"
  elif port_in_use "$PORT" && [ "$PORT" != "$own_port" ]; then
    suggestion="$(next_free_port)"
    die "port $PORT on this server is already in use by something else (see: ss -ltnp | grep :$PORT). Nothing was changed. Try: ./setup.sh --behind-nginx --port ${suggestion:-8090}"
  fi
  VITA_PORT_FORCE="$PORT"; export VITA_PORT_FORCE
  vita_init
  say "Mode: behind an existing nginx (project '$PROJECT'; app on 127.0.0.1:$PORT only; no Caddy)."
else
  [ "$existing_mode" != "nginx" ] || die "this install is in nginx mode (see .env): run ./setup.sh --behind-nginx"
  vita_init
fi

umask 077
if [ -f .env ]; then
  say "Keeping the existing .env (it is never overwritten; secrets unchanged)."
  chmod 600 .env
  if [ -n "$DOMAIN" ]; then
    set_env .env SITE_ADDRESS "$DOMAIN"
    say "SITE_ADDRESS set to $DOMAIN"
  elif [ -z "$(get_env SITE_ADDRESS)" ]; then
    # an earlier run could not detect the IP: try again (or ask) instead of stopping
    SITE="$(detect_site_address)"
    set_env .env SITE_ADDRESS "$SITE"
    say "SITE_ADDRESS was empty; set to $SITE"
  fi
  # An .env from an earlier version has no salt for the public-form rate limits: generate it once.
  if [ -z "$(get_env SITE_IP_SALT)" ]; then
    set_env .env SITE_IP_SALT "$(openssl rand -hex 32)"
    say "SITE_IP_SALT was empty or missing; generated (not shown)."
  fi
  # Caddy (or nginx) is one proxy hop: without TRUST_PROXY=1 every visitor shares the proxy's address and the per-IP limits break.
  ensure_env TRUST_PROXY 1
else
  cp .env.production.example .env
  chmod 600 .env
  for key in JWT_SECRET STORAGE_URL_SECRET JOBSEARCH_REPLY_SECRET DB_PASSWORD SITE_IP_SALT; do
    set_env .env "$key" "$(openssl rand -hex 32)"
  done
  ensure_env TRUST_PROXY 1
  if [ -n "$DOMAIN" ]; then
    SITE="$DOMAIN"
  else
    SITE="$(detect_site_address)"
  fi
  set_env .env SITE_ADDRESS "$SITE"
  say "Created .env (permissions 600) with newly generated secrets (not shown) and SITE_ADDRESS=$SITE"
fi

# Mode and project name live in .env, so every helper script and a plain `docker compose` in this folder agree.
ensure_env COMPOSE_PROJECT_NAME vita
if [ "$BEHIND_NGINX" -eq 1 ]; then
  # one proxy hop (nginx): the value the app's utils/trustProxy.js accepts as a hop count
  if [ "$(get_env TRUST_PROXY)" != "1" ]; then
    warn "TRUST_PROXY in .env is '$(get_env TRUST_PROXY)', not 1. Behind ONE nginx the correct value is 1 (an empty or wrong value makes every visitor share one address in the rate limits). Your value was kept."
  fi
  set_env .env VITA_DEPLOY_MODE nginx
  set_env .env COMPOSE_FILE docker-compose.yml:docker-compose.nginx.yml
  set_env .env COMPOSE_PROFILES ""
  set_env .env VITA_APP_PORT "$PORT"
  if [ -n "$WWW" ]; then set_env .env VITA_WWW "$WWW"; fi
  # in this mode SITE_ADDRESS is informational only (links); there is no certificate handled here
  if [ -n "$DOMAIN" ] || [ -z "$(get_env SITE_BASE_URL)" ]; then
    set_env .env SITE_BASE_URL "https://$(get_env SITE_ADDRESS)"
  fi
else
  ensure_env COMPOSE_PROFILES caddy
fi

# Postgres SUPERUSER credentials: a separate file that only the db container reads (never the app).
if [ -f .env.db ]; then
  chmod 600 .env.db
else
  if "${DOCKER[@]}" volume inspect "${PROJECT}_db-data" > /dev/null 2>&1; then
    warn "a database volume (${PROJECT}_db-data) already exists, probably from an earlier version of this kit. A new .env.db does NOT change its superuser."
    warn "  Demo/test install: wipe it (deletes ALL data): ./wipe-data.sh, then ./setup.sh again."
    warn "  Install with real data: edit .env.db and set POSTGRES_USER and POSTGRES_PASSWORD to the OLD DB_USER and DB_PASSWORD from .env (backup.sh/restore.sh use them); see SETUP-HOSTINGER.md section 16."
  fi
  printf 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=\n' > .env.db
  chmod 600 .env.db
  set_env .env.db POSTGRES_PASSWORD "$(openssl rand -hex 32)"
  say "Created .env.db (permissions 600) with a generated Postgres superuser password (not shown)."
fi
PG_SUPER_NAME="$(grep -E '^POSTGRES_USER=' .env.db | tail -n 1 | cut -d= -f2- || true)"
if [ "$(get_env DB_USER)" = "$PG_SUPER_NAME" ] || [ "$(get_env DB_USER)" = "postgres" ]; then
  warn "DB_USER in .env is the Postgres superuser: the app runs with full database privileges. New installs use the unprivileged vita_app role (see SETUP-HOSTINGER.md section 16)."
fi

SITE="$(get_env SITE_ADDRESS)"
[ -n "$SITE" ] || die "SITE_ADDRESS is empty in .env: run ./setup.sh --domain your.domain"
valid_hostname "$SITE" || die "SITE_ADDRESS in .env is not a valid host name"
# nginx mode: the names this install answers for (www.NAME too for a two-label name, unless --no-www)
SITE_NAMES=("$SITE")
if [ "$BEHIND_NGINX" -eq 1 ]; then
  www_eff="$WWW"
  [ -n "$www_eff" ] || www_eff="$(get_env VITA_WWW)"
  if [ -z "$www_eff" ]; then
    if [[ "$SITE" =~ ^[a-z0-9-]+\.[a-z0-9-]+$ ]]; then www_eff=1; else www_eff=0; fi
  fi
  if [ "$www_eff" = "1" ]; then SITE_NAMES+=("www.$SITE"); fi
  set_env .env VITA_WWW "$www_eff"
fi
if [ "$BEHIND_NGINX" -eq 1 ] && command -v nginx > /dev/null 2>&1; then
  # read-only check: the name must not already be a server_name of an existing nginx site
  if nginx_all="$(nginx -T 2> /dev/null)" && [ -n "$nginx_all" ]; then
    clash=0
    for nm in "${SITE_NAMES[@]}"; do
      if printf '%s\n' "$nginx_all" | grep -E "^[[:space:]]*server_name[^;]*[[:space:]]${nm//./\\.}[;[:space:]]" > /dev/null; then clash=1; fi
    done
    if [ "$clash" -eq 1 ]; then
      if [ -e /etc/nginx/sites-enabled/vita ]; then
        say "nginx already has a VITA site ($SITE): keeping it."
      else
        die "the name $SITE is already a server_name of an existing nginx site. Choose another with: ./setup.sh --behind-nginx --domain NAME"
      fi
    fi
  else
    warn "could not read the nginx configuration (nginx -T needs root); check by hand that $SITE is not used: nginx -T | grep server_name"
  fi
fi

# nginx mode: do the names already point at this server? (certbot's HTTP-01 check fails until they do) - warn only
if [ "$BEHIND_NGINX" -eq 1 ]; then
  public_ip="$(curl -fsS --max-time 10 https://api.ipify.org 2> /dev/null || true)"
  valid_ipv4 "$public_ip" || public_ip=""
  for nm in "${SITE_NAMES[@]}"; do
    resolved_ip="$(getent ahostsv4 "$nm" 2> /dev/null | awk 'NR==1{print $1}' || true)"
    if [ -z "$resolved_ip" ]; then
      warn "$nm does not resolve yet. In hPanel (Domains > DNS) make its A record point at ${public_ip:-the public IP of this server}; certbot cannot issue the certificate before that. Check with: getent hosts $nm"
    elif [ -n "$public_ip" ] && [ "$resolved_ip" != "$public_ip" ]; then
      warn "$nm resolves to $resolved_ip, but the public address of this server is $public_ip. certbot will fail (or certify the wrong host) until the A record points here. Edit the existing A record rather than adding a second one; leave MX/TXT/CNAME records alone."
    else
      say "DNS: $nm resolves to ${resolved_ip}."
    fi
  done
fi

# ------------------------------------------------------------------ 4. firewall (only when asked)
# The port(s) sshd really listens on (a changed SSH port must stay open, or you lock yourself out).
ssh_ports() {
  local ports
  ports="$(sudo sshd -T 2> /dev/null | awk '$1 == "port" { print $2 }' | sort -u || true)"
  if [ -z "$ports" ]; then
    ports="$(sudo ss -tlnpH 2> /dev/null | awk '/sshd/ { n = split($4, a, ":"); print a[n] }' | sort -u || true)"
  fi
  printf '%s\n' "$ports" | grep -E '^[0-9]{1,5}$' || true
}

if [ "$BEHIND_NGINX" -eq 1 ]; then
  say "Firewall not changed (nginx mode: ports 80/443 are already handled by your nginx; the app listens on 127.0.0.1 only)."
elif [ "$FIREWALL" -eq 1 ]; then
  command -v ufw > /dev/null 2>&1 || die "ufw is not installed: sudo apt-get install -y ufw"
  mapfile -t SSH_PORTS < <(ssh_ports)
  if [ "${#SSH_PORTS[@]}" -eq 0 ]; then
    die "could not find the port sshd listens on: NOT enabling the firewall (you could be locked out). Allow your SSH port by hand: sudo ufw allow <port>/tcp"
  fi
  say "Configuring ufw: allow SSH (port ${SSH_PORTS[*]}), HTTP (80), HTTPS (443 tcp+udp), then enable."
  warn "make sure ${SSH_PORTS[*]} is the port you are connected on; keep this SSH session open and test a NEW login before closing it."
  for port in "${SSH_PORTS[@]}"; do
    sudo ufw allow "${port}/tcp"
  done
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw allow 443/udp
  sudo ufw --force enable
  sudo ufw status verbose
else
  say "Firewall not changed (use --configure-firewall to allow only SSH/80/443 with ufw; Hostinger's hPanel firewall must allow 80/443 too)."
fi

# ------------------------------------------------------------------ 5. start
if [ "$ASSUME_YES" -ne 1 ] && [ -t 0 ]; then
  if [ "$BEHIND_NGINX" -eq 1 ]; then
    IFS= read -r -p "Build and start VITA (database + app on 127.0.0.1:$PORT, no Caddy) now? [Y/n] " answer
  else
    IFS= read -r -p "Build and start VITA at https://$SITE/vita/ now? [Y/n] " answer
  fi
  case "${answer:-y}" in
    y|Y|yes|YES) ;;
    *) say "Stopped. Start later with: docker compose up -d --build"; exit 0 ;;
  esac
fi
compose config --quiet
if [ "$BEHIND_NGINX" -eq 1 ]; then
  compose up -d --build db app
else
  compose up -d --build
fi

# ------------------------------------------------------------------ 6. wait for health
say "Waiting for the app to become healthy (up to ${HEALTH_TIMEOUT}s)..."
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
status=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  cid="$(compose ps -q app 2> /dev/null || true)"
  if [ -n "$cid" ]; then
    status="$("${DOCKER[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2> /dev/null || true)"
    [ "$status" = "healthy" ] && break
  fi
  sleep 5
done
if [ "$status" != "healthy" ]; then
  warn "the app is not healthy yet (status: ${status:-unknown}). Look at the logs: ./logs.sh app"
  exit 1
fi
say "App is healthy."

if [ "$BEHIND_NGINX" -eq 1 ]; then
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz" > /dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  [ "$ok" -eq 1 ] || { warn "http://127.0.0.1:$PORT/healthz does not answer from the host. Look at: ./logs.sh app"; exit 1; }
  say "App answers on http://127.0.0.1:$PORT/healthz (loopback only)."
  cat <<TXT

VITA is running in SAFE SANDBOX MODE (no real e-mail is sent, no live job sources) - but it is NOT
reachable from the internet yet: your nginx still has to be told about it. Nothing has been changed in
nginx, certbot or the firewall. The steps (review them, then run them yourself) follow:
TXT
  ./nginx-config.sh --domain "$SITE" --port "$PORT" "$([ "$(get_env VITA_WWW)" = 1 ] && printf %s --www || printf %s --no-www)"
  cat <<TXT

  After nginx works:  ./create-admin.sh    (creates the first SuperAdmin; works once, never over the internet)
  Status: ./status.sh    Logs: ./logs.sh app    Backups: ./backup.sh
  Printed again at any time with: ./nginx-config.sh

Guide: docs/vita-job-search/SETUP-HOSTINGER-NGINX.md
TXT
  exit 0
fi

if curl -fsS --max-time 20 "https://$SITE/healthz" > /dev/null 2>&1; then
  say "HTTPS works: https://$SITE/healthz"
else
  warn "https://$SITE is not answering yet. The first certificate can take a minute; check: ./logs.sh caddy"
  warn "Ports 80 and 443 must be open (hPanel > VPS > Firewall, and ufw if enabled)."
fi

cat <<TXT

VITA is running in SAFE SANDBOX MODE (no real e-mail is sent, no live job sources).

  Open:        https://$SITE/vita/
  Next step:   ./create-admin.sh        (creates the first SuperAdmin; works once)
  Status:      ./status.sh              Logs: ./logs.sh app
  Backups:     ./backup.sh              (set up the daily cron job described in SETUP-HOSTINGER.md)
  Sandbox mail: ./show-sandbox-mail.sh  (codes/messages for allow-listed test addresses only; real
                candidates need real mail, see SETUP-HOSTINGER.md section 10)

Guide: docs/vita-job-search/SETUP-HOSTINGER.md
TXT
