#!/usr/bin/env bash
# Show recent logs and follow them (Ctrl+C to stop). Service: app (default), db, or caddy (Caddy mode only).
#
#   ./logs.sh            ./logs.sh caddy            LINES=500 ./logs.sh app
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# shellcheck source=lib.sh
. ./lib.sh
vita_init

SERVICE="${1:-app}"
case "$SERVICE" in
  app|db) ;;
  caddy) has_caddy || die "there is no Caddy in this install (nginx mode): look at the nginx logs instead, e.g. journalctl -u nginx or /var/log/nginx/error.log" ;;
  *) if has_caddy; then die "service must be app, db or caddy"; else die "service must be app or db"; fi ;;
esac
LINES="${LINES:-200}"
[[ "$LINES" =~ ^[0-9]+$ ]] || { printf 'ERROR: LINES must be a number\n' >&2; exit 1; }

compose logs --tail="$LINES" -f "$SERVICE"
