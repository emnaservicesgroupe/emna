#!/usr/bin/env bash
# Backup (Task 20): database dump (pg_dump custom format) + the uploaded-files volume, into a new
# timestamped folder. Keeps the newest RETENTION backups (default 14) and deletes older ones.
#
#   ./backup.sh                         -> ./backups/vita-YYYYmmdd-HHMMSS/{db.dump,storage.tar.gz,SHA256SUMS}
#   BACKUP_DIR=/srv/vita-backups RETENTION=30 ./backup.sh
#
# Backups contain personal data (CVs, passports numbers...): the folder is created with permissions 700.
# Copy them OFF the server regularly (another machine / storage) - a backup on the same disk does not
# survive the loss of the VPS. The .env file (secrets) is NOT included: keep a copy of it in a safe place.
#
# Daily at 03:17 (crontab -e):
#   17 3 * * * /home/USER/emna/deploy/hostinger/backup.sh >> /home/USER/vita-backup.log 2>&1
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. ./lib.sh
vita_init

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION="${RETENTION:-14}"
[[ "$RETENTION" =~ ^[0-9]+$ ]] && [ "$RETENTION" -ge 1 ] || die "RETENTION must be a number >= 1"
[ -f .env ] || die ".env not found (run ./setup.sh first)"


get_env() { grep -E "^$2=" "$1" 2> /dev/null | tail -n 1 | cut -d= -f2- || true; }
DB_NAME="$(get_env .env DB_NAME)"
# pg_dump runs as the Postgres superuser (from .env.db) inside the db container, over its local socket.
PG_SUPER="$(get_env .env.db POSTGRES_USER)"
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_NAME in .env is missing or unusual"
[[ "$PG_SUPER" =~ ^[A-Za-z0-9_]+$ ]] || die "POSTGRES_USER in .env.db is missing (run ./setup.sh)"

umask 077
if [ ! -d "$BACKUP_DIR" ]; then
  # only a folder this script creates is restricted to 700; an existing folder you chose keeps its permissions
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
fi
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/vita-$STAMP"
[ ! -e "$DEST" ] || DEST="$DEST-$$"
mkdir "$DEST"
# On any failure, remove the incomplete backup folder (a partial backup must never look like a good one).
DONE=0
on_exit() { if [ "$DONE" -ne 1 ] && [ -n "${DEST:-}" ] && [ -d "$DEST" ]; then rm -rf -- "$DEST"; printf 'Backup FAILED; removed the incomplete %s\n' "$DEST" >&2; fi; }
trap on_exit EXIT

printf 'Backing up project %s to %s\n' "$PROJECT" "$DEST"
# pg_dump runs inside the db container; the dump streams to this host (no password needed: local socket).
compose exec -T db pg_dump -U "$PG_SUPER" -d "$DB_NAME" -Fc --no-owner > "$DEST/db.dump.partial"
mv "$DEST/db.dump.partial" "$DEST/db.dump"
# Uploaded files: tar of /data/storage from the app container (read-only for this purpose).
compose exec -T app tar -C /data -czf - storage > "$DEST/storage.tar.gz.partial"
mv "$DEST/storage.tar.gz.partial" "$DEST/storage.tar.gz"
( cd "$DEST" && sha256sum db.dump storage.tar.gz > SHA256SUMS )
[ -s "$DEST/db.dump" ] || die "the database dump is empty"
DONE=1
printf 'Done: %s (%s)\n' "$DEST" "$(du -sh "$DEST" | cut -f1)"

# Retention: delete the oldest vita-* folders beyond RETENTION (names sort by time).
mapfile -t ALL < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'vita-[0-9]*' | sort)
if [ "${#ALL[@]}" -gt "$RETENTION" ]; then
  for old in "${ALL[@]:0:${#ALL[@]}-RETENTION}"; do
    printf 'Removing old backup %s\n' "$old"
    rm -rf -- "$old"
  done
fi
