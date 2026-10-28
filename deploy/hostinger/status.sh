#!/usr/bin/env bash
# Quick status (Task 20): containers, app health, public check, disk space, latest backup. Both modes:
#   Caddy mode: three containers (db, app, caddy) and the public HTTPS check.
#   nginx mode: two containers (db, app) and http://127.0.0.1:PORT/healthz on the host loopback.
#
#   ./status.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. ./lib.sh
vita_init

printf '== Project %s (%s mode)\n' "$PROJECT" "$MODE"
compose ps
running="$(compose ps --status running -q 2> /dev/null | grep -c . || true)"
if has_caddy; then expected=3; else expected=2; fi
if [ "$running" -ge "$expected" ]; then
  printf 'Containers running: %s of %s expected\n' "$running" "$expected"
else
  printf 'Only %s of %s expected containers are running: ./logs.sh app\n' "$running" "$expected"
fi

printf '\n== App health (inside the server)\n'
if compose exec -T app node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/healthz').then(async r=>{console.log(r.status, await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.log('unreachable', e.message);process.exit(1)})"; then
  :
else
  printf 'App is NOT healthy: ./logs.sh app\n'
fi

SITE="$(env_value SITE_ADDRESS)"
if has_caddy; then
  if [ -n "$SITE" ]; then
    printf '\n== Public HTTPS (https://%s)\n' "$SITE"
    if curl -fsS --max-time 15 "https://$SITE/healthz" 2> /dev/null; then
      printf '\nOpen: https://%s/vita/\n' "$SITE"
    else
      printf 'not reachable over HTTPS yet: ./logs.sh caddy\n'
    fi
  fi
else
  printf '\n== Host loopback (http://127.0.0.1:%s/healthz - what nginx talks to)\n' "$APP_PORT"
  if curl -fsS --max-time 10 "http://127.0.0.1:$APP_PORT/healthz" 2> /dev/null; then
    printf '\n'
  else
    printf 'not answering on 127.0.0.1:%s: ./logs.sh app\n' "$APP_PORT"
  fi
  if [ -n "$SITE" ]; then
    printf '\n== Through your nginx (https://%s) - only after you installed the nginx block (./nginx-config.sh)\n' "$SITE"
    if curl -fsS --max-time 15 "https://$SITE/healthz" 2> /dev/null; then
      printf '\nOpen: https://%s/vita/\n' "$SITE"
    else
      printf 'not reachable through nginx yet (expected before the nginx steps)\n'
    fi
  fi
fi

printf '\n== Disk\n'
df -h / | tail -n 1
printf '\n== Latest backup\n'
latest="$(find "${BACKUP_DIR:-./backups}" -mindepth 1 -maxdepth 1 -type d -name 'vita-[0-9]*' 2> /dev/null | sort | tail -n 1 || true)"
printf '%s\n' "${latest:-none yet (./backup.sh)}"
