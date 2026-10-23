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

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION="${RETENTION:-14}"
[[ "$RETENTION" =~ ^[0-9]+$ ]] && [ "$RETENTION" -ge 1 ] || die "RETENTION must be a number >= 1"
[ -f .env ] || die ".env not found (run ./setup.sh first)"

command -v docker > /dev/null 2>&1 || die "docker is not installed"
DOCKER=(docker)
docker info > /dev/null 2>&1 || DOCKER=(sudo docker)
compose() { "${DOCKER[@]}" compose "$@"; }

get_env() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true; }
DB_USER="$(get_env DB_USER)"
DB_NAME="$(get_env DB_NAME)"
[[ "$DB_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_USER in .env is missing or unusual"
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_NAME in .env is missing or unusual"

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/vita-$STAMP"
mkdir "$DEST"

printf 'Backing up to %s\n' "$DEST"
# pg_dump runs inside the db container; the dump streams to this host (no password needed: local socket).
compose exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc --no-owner > "$DEST/db.dump.partial"
mv "$DEST/db.dump.partial" "$DEST/db.dump"
# Uploaded files: tar of /data/storage from the app container (read-only for this purpose).
compose exec -T app tar -C /data -czf - storage > "$DEST/storage.tar.gz.partial"
mv "$DEST/storage.tar.gz.partial" "$DEST/storage.tar.gz"
( cd "$DEST" && sha256sum db.dump storage.tar.gz > SHA256SUMS )
[ -s "$DEST/db.dump" ] || die "the database dump is empty"
printf 'Done: %s (%s)\n' "$DEST" "$(du -sh "$DEST" | cut -f1)"

# Retention: delete the oldest vita-* folders beyond RETENTION (names sort by time).
mapfile -t ALL < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'vita-[0-9]*' | sort)
if [ "${#ALL[@]}" -gt "$RETENTION" ]; then
  for old in "${ALL[@]:0:${#ALL[@]}-RETENTION}"; do
    printf 'Removing old backup %s\n' "$old"
    rm -rf -- "$old"
  done
fi
