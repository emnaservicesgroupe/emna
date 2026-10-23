#!/usr/bin/env bash
# Restore a backup made by backup.sh (Task 20). REPLACES the current database content and uploaded files.
#
#   ./restore.sh backups/vita-20261023-031700
#
# Steps: verify checksums -> ask for confirmation -> stop the app -> pg_restore --clean (one transaction)
# -> replace /data/storage -> start the app (it re-applies any newer migrations on start).
# Test your backups: restore one on a spare VPS (or a fresh install) from time to time.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

SRC="${1:-}"
[ -n "$SRC" ] || die "usage: ./restore.sh <backup folder> (e.g. backups/vita-20261023-031700)"
[ -d "$SRC" ] || die "$SRC is not a folder"
[ -s "$SRC/db.dump" ] || die "$SRC/db.dump is missing or empty"
[ -f "$SRC/storage.tar.gz" ] || die "$SRC/storage.tar.gz is missing"
[ -f .env ] || die ".env not found (run ./setup.sh first)"
if [ -f "$SRC/SHA256SUMS" ]; then
  ( cd "$SRC" && sha256sum --quiet -c SHA256SUMS ) || die "checksum mismatch: the backup is damaged"
fi

command -v docker > /dev/null 2>&1 || die "docker is not installed"
DOCKER=(docker)
docker info > /dev/null 2>&1 || DOCKER=(sudo docker)
compose() { "${DOCKER[@]}" compose "$@"; }

get_env() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true; }
DB_USER="$(get_env DB_USER)"
DB_NAME="$(get_env DB_NAME)"
[[ "$DB_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_USER in .env is missing or unusual"
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_NAME in .env is missing or unusual"

printf 'This REPLACES the current VITA database and uploaded files with the backup in:\n  %s\n' "$SRC"
[ -t 0 ] || die "run this in an interactive terminal (it asks for confirmation)"
read -r -p "Type RESTORE to continue: " answer
[ "$answer" = "RESTORE" ] || die "cancelled"

compose up -d db
compose stop app caddy
printf 'Restoring the database...\n'
compose exec -T db pg_restore -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner --single-transaction < "$SRC/db.dump"
printf 'Restoring uploaded files...\n'
# A one-off container with the app image and the storage volume (the app itself is stopped).
compose run --rm --no-deps -T --entrypoint sh app -c 'find /data/storage -mindepth 1 -delete && tar -C /data -xzf -' < "$SRC/storage.tar.gz"
compose up -d
printf 'Restore finished. Check: ./status.sh\n'
