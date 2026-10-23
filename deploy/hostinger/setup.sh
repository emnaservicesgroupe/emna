#!/usr/bin/env bash
# VITA first-time setup on an Ubuntu VPS (Task 20). Run as a normal user that can use sudo, from this folder:
#
#   ./setup.sh                              first run without a domain (uses <server-ip>.sslip.io)
#   ./setup.sh --domain vita.example.com    use your own domain (its DNS A record must point at this server)
#   ./setup.sh --configure-firewall         also allow SSH/80/443 in ufw and enable it
#   ./setup.sh --help
#
# Safe to run again: an existing .env is never overwritten (only SITE_ADDRESS is updated when --domain is
# given), secrets are generated once and never printed, and `docker compose up -d --build` is idempotent.
# Everything starts in SAFE SANDBOX MODE: no real e-mail, no live job sources.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

DOMAIN=""
FIREWALL=0
ALLOW_NON_UBUNTU=0
ASSUME_YES=0
HEALTH_TIMEOUT=300

usage() {
  sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
  [[ "$h" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]
}

valid_ipv4() {
  local ip="$1" part
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  IFS=. read -r -a parts <<< "$ip"
  for part in "${parts[@]}"; do
    [ "$part" -le 255 ] || return 1
  done
}

if [ -n "$DOMAIN" ]; then
  DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
  valid_hostname "$DOMAIN" || die "'$DOMAIN' is not a valid domain name (example: vita.example.com)"
fi

# ------------------------------------------------------------------ 1. operating system
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_ID="$(. /etc/os-release && printf '%s' "${ID:-unknown}")"
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
compose() { "${DOCKER[@]}" compose "$@"; }

[ -f docker-compose.yml ] || die "docker-compose.yml not found next to setup.sh"
[ -f .env.production.example ] || die ".env.production.example not found next to setup.sh"

# ------------------------------------------------------------------ 3. .env (secrets generated once, never printed)
# set_env KEY VALUE: replace the KEY= line in .env (VALUE is generated hex or a validated host name).
set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp .env.tmp.XXXXXX)"
  chmod 600 "$tmp"
  awk -v k="$key" -v v="$value" 'BEGIN { done = 0 }
    $0 ~ "^" k "=" { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' .env > "$tmp"
  mv "$tmp" .env
}
get_env() {
  local key="$1"
  grep -E "^${key}=" .env 2> /dev/null | tail -n 1 | cut -d= -f2- || true
}

detect_site_address() {
  local ip=""
  ip="$(curl -fsS --max-time 10 https://api.ipify.org 2> /dev/null || true)"
  if ! valid_ipv4 "$ip"; then
    warn "could not detect the public IPv4 address automatically (https://api.ipify.org)."
    if [ -t 0 ]; then
      read -r -p "Type this server's public IPv4 address (shown in hPanel > VPS > Overview): " ip
    fi
    valid_ipv4 "$ip" || die "no valid IPv4 address; run again with --domain your.domain or type the IP when asked"
  fi
  printf '%s.sslip.io' "${ip//./-}"
}

if [ -f .env ]; then
  say "Keeping the existing .env (it is never overwritten; secrets unchanged)."
  chmod 600 .env
  if [ -n "$DOMAIN" ]; then
    set_env SITE_ADDRESS "$DOMAIN"
    say "SITE_ADDRESS set to $DOMAIN"
  fi
else
  umask 077
  cp .env.production.example .env
  chmod 600 .env
  for key in JWT_SECRET STORAGE_URL_SECRET JOBSEARCH_REPLY_SECRET DB_PASSWORD; do
    set_env "$key" "$(openssl rand -hex 32)"
  done
  if [ -n "$DOMAIN" ]; then
    SITE="$DOMAIN"
  else
    SITE="$(detect_site_address)"
  fi
  set_env SITE_ADDRESS "$SITE"
  say "Created .env (permissions 600) with newly generated secrets (not shown) and SITE_ADDRESS=$SITE"
fi

SITE="$(get_env SITE_ADDRESS)"
[ -n "$SITE" ] || die "SITE_ADDRESS is empty in .env: run ./setup.sh --domain your.domain"
valid_hostname "$SITE" || die "SITE_ADDRESS in .env is not a valid host name"

# ------------------------------------------------------------------ 4. firewall (only when asked)
if [ "$FIREWALL" -eq 1 ]; then
  command -v ufw > /dev/null 2>&1 || die "ufw is not installed: sudo apt-get install -y ufw"
  say "Configuring ufw: allow SSH (22), HTTP (80), HTTPS (443 tcp+udp), then enable."
  sudo ufw allow OpenSSH
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw allow 443/udp
  sudo ufw --force enable
  sudo ufw status verbose
else
  say "Firewall not changed (use --configure-firewall to allow only 22/80/443 with ufw; Hostinger's hPanel firewall must allow 80/443 too)."
fi

# ------------------------------------------------------------------ 5. start
if [ "$ASSUME_YES" -ne 1 ] && [ -t 0 ]; then
  read -r -p "Build and start VITA at https://$SITE/vita/ now? [Y/n] " answer
  case "${answer:-y}" in
    y|Y|yes|YES) ;;
    *) say "Stopped. Start later with: docker compose up -d --build"; exit 0 ;;
  esac
fi
compose config --quiet
compose up -d --build

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

Guide: docs/vita-job-search/SETUP-HOSTINGER.md
TXT
