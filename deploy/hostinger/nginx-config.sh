#!/usr/bin/env bash
# Prints the nginx server block for VITA (nginx mode) and the exact commands to install it. It changes
# NOTHING on the server except writing two files next to this script (nginx-vita.generated*.conf). It never
# runs nginx, certbot or sudo: you review the text and run the commands yourself.
#
#   ./nginx-config.sh                                  uses SITE_ADDRESS and VITA_APP_PORT from .env
#   ./nginx-config.sh --domain example.com --port 8083 [--www|--no-www] [--out DIR]
# With --www the file also answers for www.DOMAIN and redirects it to the bare DOMAIN (default for a name of
# two labels such as example.com; a subdomain such as vita.example.com gets no www).
#
# The template is nginx-vita.conf.example (placeholders __DOMAIN__ and __PORT__).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. ./lib.sh

DOMAIN=""
PORT=""
WWW=""
OUT="."
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) [ $# -ge 2 ] || die "--domain needs a value"; DOMAIN="$2"; shift 2 ;;
    --port) [ $# -ge 2 ] || die "--port needs a value"; PORT="$2"; shift 2 ;;
    --www) WWW=1; shift ;;
    --no-www) WWW=0; shift ;;
    --out) [ $# -ge 2 ] || die "--out needs a folder"; OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[ -n "$DOMAIN" ] || DOMAIN="$(env_value SITE_ADDRESS)"
[ -n "$PORT" ] || PORT="$(env_value VITA_APP_PORT)"
[ -n "$WWW" ] || WWW="$(env_value VITA_WWW)"
PORT="${PORT:-8083}"
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$ ]] || die "'$DOMAIN' is not a valid domain name (use --domain vita.example.com)"
[[ "$PORT" =~ ^[0-9]{4,5}$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "'$PORT' is not a valid port (1024-65535)"
if [ -z "$WWW" ]; then
  # default: a bare name of two labels (example.com) also gets www
  if [[ "$DOMAIN" =~ ^[a-z0-9-]+\.[a-z0-9-]+$ ]]; then WWW=1; else WWW=0; fi
fi
[ -d "$OUT" ] || die "$OUT is not a folder"

TEMPLATE="nginx-vita.conf.example"
[ -f "$TEMPLATE" ] || die "$TEMPLATE not found next to this script"
FULL="$OUT/nginx-vita.generated.conf"
HTTP_ONLY="$OUT/nginx-vita.generated-http-only.conf"
# domain and port are validated above, so the substitution cannot inject anything
NAMES="$DOMAIN"
CERT_D="-d $DOMAIN"
NAME_RE="$DOMAIN"
if [ "$WWW" = "1" ]; then
  NAMES="$DOMAIN www.$DOMAIN"
  CERT_D="-d $DOMAIN -d www.$DOMAIN"
  NAME_RE="(www\\.)?$DOMAIN"
fi
# the www block is cut out when www is off
awk -v www="$WWW" '/^# BEGIN-WWW/ { skip = (www != "1"); next } /^# END-WWW/ { skip = 0; next } !skip { print }' "$TEMPLATE" \
  | sed -e "s/__NAMES__/$NAMES/g" -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" > "$FULL"
awk '/^# BEGIN-HTTP-ONLY/ { on = 1; next } /^# END-HTTP-ONLY/ { on = 0; next } on { print }' "$FULL" > "$HTTP_ONLY"
KIT="$(pwd -P)"
SUDO="sudo "
[ "$(id -u)" -eq 0 ] && SUDO=""

cat <<TXT

======================================================================================
 VITA behind your existing nginx   name: $NAMES   app on 127.0.0.1:$PORT
======================================================================================
Nothing below has been run. Review it, then run the commands yourself, in order.
Your existing sites are not touched: the new file only answers for: $NAMES

0. Pre-flight (read only). Nothing may print here - if a line appears, that name is already used:
     ${SUDO}nginx -T 2>/dev/null | grep -E 'server_name[^;]*[[:space:]]${NAME_RE}[;[:space:]]'
   The name must already point at this server (certbot fails until it does): getent hosts $NAMES

1. Install the HTTP part (so the certificate can be issued), check, reload:
     ${SUDO}mkdir -p /var/www/vita-acme
     ${SUDO}cp $KIT/nginx-vita.generated-http-only.conf /etc/nginx/sites-available/vita
     ${SUDO}ln -s /etc/nginx/sites-available/vita /etc/nginx/sites-enabled/vita
     ${SUDO}nginx -t
     ${SUDO}systemctl reload nginx
   (If "nginx -t" prints an error: do NOT reload. Roll back with: ${SUDO}rm /etc/nginx/sites-enabled/vita)

2. Certificate. First look at the plugins: ${SUDO}certbot plugins
   Form A (works everywhere; recommended) - the webroot form:
     ${SUDO}certbot certonly --webroot -w /var/www/vita-acme $CERT_D --deploy-hook "systemctl reload nginx"
   Form B (only if "nginx" is listed under Installed plugins): certbot edits the file itself, then skip step 3:
     ${SUDO}certbot --nginx $CERT_D

3. (Form A only) Install the full file with HTTPS, check, reload:
     ${SUDO}cp $KIT/nginx-vita.generated.conf /etc/nginx/sites-available/vita
     ${SUDO}nginx -t
     ${SUDO}systemctl reload nginx

4. Test:  curl -I https://$DOMAIN/healthz     then open https://$DOMAIN/vita/
   Then create the first administrator ON THE SERVER: ./create-admin.sh

ROLLBACK at any time (the other sites are unaffected):
     ${SUDO}rm /etc/nginx/sites-enabled/vita
     ${SUDO}nginx -t
     ${SUDO}systemctl reload nginx
   (the certificate and /etc/nginx/sites-available/vita can stay; VITA keeps running on 127.0.0.1:$PORT)

--------------------------------------------------------------------------------------
 The full server block (also saved as $FULL):
--------------------------------------------------------------------------------------
TXT
cat "$FULL"
printf -- '--------------------------------------------------------------------------------------\n'
