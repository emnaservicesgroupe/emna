#!/usr/bin/env bash
# Quick status (Task 20): containers, app health, public HTTPS check, disk space, latest backup.
#
#   ./status.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

DOCKER=(docker)
docker info > /dev/null 2>&1 || DOCKER=(sudo docker)
compose() { "${DOCKER[@]}" compose "$@"; }

printf '== Containers\n'
compose ps

printf '\n== App health (inside the server)\n'
if compose exec -T app node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/healthz').then(async r=>{console.log(r.status, await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.log('unreachable', e.message);process.exit(1)})"; then
  :
else
  printf 'App is NOT healthy: ./logs.sh app\n'
fi

SITE="$(grep -E '^SITE_ADDRESS=' .env 2> /dev/null | tail -n 1 | cut -d= -f2- || true)"
if [ -n "$SITE" ]; then
  printf '\n== Public HTTPS (https://%s)\n' "$SITE"
  if curl -fsS --max-time 15 "https://$SITE/healthz" 2> /dev/null; then
    printf '\nOpen: https://%s/vita/\n' "$SITE"
  else
    printf 'not reachable over HTTPS yet: ./logs.sh caddy\n'
  fi
fi

printf '\n== Disk\n'
df -h / | tail -n 1
printf '\n== Latest backup\n'
latest="$(find "${BACKUP_DIR:-./backups}" -mindepth 1 -maxdepth 1 -type d -name 'vita-[0-9]*' 2> /dev/null | sort | tail -n 1 || true)"
printf '%s\n' "${latest:-none yet (./backup.sh)}"
