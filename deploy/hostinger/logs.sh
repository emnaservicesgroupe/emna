#!/usr/bin/env bash
# Show recent logs and follow them (Ctrl+C to stop). Service: app (default), db or caddy.
#
#   ./logs.sh            ./logs.sh caddy            LINES=500 ./logs.sh app
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

SERVICE="${1:-app}"
case "$SERVICE" in
  app|db|caddy) ;;
  *) printf 'ERROR: service must be app, db or caddy\n' >&2; exit 1 ;;
esac
LINES="${LINES:-200}"
[[ "$LINES" =~ ^[0-9]+$ ]] || { printf 'ERROR: LINES must be a number\n' >&2; exit 1; }

DOCKER=(docker)
docker info > /dev/null 2>&1 || DOCKER=(sudo docker)
"${DOCKER[@]}" compose logs --tail="$LINES" -f "$SERVICE"
