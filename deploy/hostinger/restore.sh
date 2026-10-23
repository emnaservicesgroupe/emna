#!/usr/bin/env bash
# Restore a backup made by backup.sh (Task 20). REPLACES the current database content and uploaded files.
#
#   ./restore.sh backups/vita-20261023-031700            (asks to make a fresh backup first - default yes)
#   ./restore.sh --no-backup backups/vita-20261023-031700
#
# How (safe even when the current database has tables newer than the backup):
#   1. verify the checksums, ask you to type RESTORE, take a backup of the CURRENT state (unless --no-backup);
#   2. stop app + caddy; restore the dump into a NEW temporary database owned by the application role
#      (one transaction, stops at the first error) - the current database is untouched until this succeeds;
#   3. swap: current database -> vita_pre_restore_<time>, temporary -> the real name; drop the old one;
#   4. replace the uploaded files: the archive is validated before step 2, extracted into a temporary folder,
#      and only then swapped in (the current files are never deleted first);
#   5. ALWAYS (success or failure) start app + caddy again; the app re-applies newer migrations on start.
# Test your backups: restore one on a spare VPS (or a fresh install) from time to time.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

TAKE_BACKUP=ask
if [ "${1:-}" = "--no-backup" ]; then
  TAKE_BACKUP=no
  shift
fi
SRC="${1:-}"
[ -n "$SRC" ] || die "usage: ./restore.sh [--no-backup] <backup folder> (e.g. backups/vita-20261023-031700)"
[ -d "$SRC" ] || die "$SRC is not a folder"
[ -s "$SRC/db.dump" ] || die "$SRC/db.dump is missing or empty"
[ -f "$SRC/storage.tar.gz" ] || die "$SRC/storage.tar.gz is missing"
[ -f .env ] || die ".env not found (run ./setup.sh first)"
[ -f .env.db ] || die ".env.db not found (run ./setup.sh first)"
if [ -f "$SRC/SHA256SUMS" ]; then
  ( cd "$SRC" && sha256sum --quiet -c SHA256SUMS ) || die "checksum mismatch: the backup is damaged"
fi
# The uploads archive is checked BEFORE anything changes: it must be readable and contain only storage/...
LISTING="$(tar -tzf "$SRC/storage.tar.gz" 2> /dev/null)" || die "$SRC/storage.tar.gz is damaged (tar cannot read it); nothing was changed"
if printf '%s\n' "$LISTING" | grep -v -E '^storage(/|$)' | grep -q .; then
  die "$SRC/storage.tar.gz contains paths outside storage/; nothing was changed"
fi
if printf '%s\n' "$LISTING" | grep -q -E '(^|/)\.\.(/|$)'; then
  die "$SRC/storage.tar.gz contains '..' paths; nothing was changed"
fi
SRC_ABS="$(cd "$SRC" && pwd)"

command -v docker > /dev/null 2>&1 || die "docker is not installed"
DOCKER=(docker)
docker info > /dev/null 2>&1 || DOCKER=(sudo docker)
compose() { "${DOCKER[@]}" compose "$@"; }

get_env() { grep -E "^$2=" "$1" 2> /dev/null | tail -n 1 | cut -d= -f2- || true; }
DB_USER="$(get_env .env DB_USER)"
DB_NAME="$(get_env .env DB_NAME)"
PG_SUPER="$(get_env .env.db POSTGRES_USER)"
for v in "$DB_USER" "$DB_NAME" "$PG_SUPER"; do
  [[ "$v" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_USER / DB_NAME (.env) or POSTGRES_USER (.env.db) is missing or unusual"
done
STAMP="$(date -u +%Y%m%d%H%M%S)"
TMP_DB="${DB_NAME}_restore_tmp"
OLD_DB="${DB_NAME}_pre_restore_${STAMP}"

printf 'This REPLACES the current VITA database and uploaded files with the backup in:\n  %s\n' "$SRC_ABS"
[ -t 0 ] || die "run this in an interactive terminal (it asks for confirmation)"
IFS= read -r -p "Type RESTORE to continue: " answer
[ "$answer" = "RESTORE" ] || die "cancelled"
if [ "$TAKE_BACKUP" = "ask" ]; then
  IFS= read -r -p "First back up the CURRENT data (recommended)? [Y/n] " answer
  case "${answer:-y}" in
    n|N|no|NO) printf 'Skipping the safety backup.\n' ;;
    *) ./backup.sh ;;
  esac
fi

psql_on() {
  local db="$1"
  shift
  compose exec -T -e PGOPTIONS="-c client_min_messages=warning" db psql -v ON_ERROR_STOP=1 -U "$PG_SUPER" -d "$db" -qAt "$@"
}
psql_super() { psql_on postgres "$@"; }

# 5. whatever happens from here on, bring the app and the proxy back and drop a leftover temporary database
restart_stack() {
  local rc=$?
  psql_super -c "DROP DATABASE IF EXISTS \"${TMP_DB}\" WITH (FORCE)" > /dev/null 2>&1 || true
  printf 'Starting app and caddy again...\n'
  compose up -d app caddy > /dev/null 2>&1 || compose up -d app caddy || true
  if [ "$rc" -eq 0 ]; then
    printf 'Restore finished. Check: ./status.sh\n'
  else
    printf 'Restore FAILED (exit %s). The current data was kept if the failure happened before the swap; see the messages above.\n' "$rc" >&2
  fi
}

compose up -d db
for _ in $(seq 1 30); do
  compose exec -T db pg_isready -U "$PG_SUPER" > /dev/null 2>&1 && break
  sleep 2
done
trap restart_stack EXIT
compose stop app caddy

# 2. restore into a fresh database owned by the application role
printf 'Restoring the database into a temporary database...\n'
psql_super -c "DROP DATABASE IF EXISTS \"${TMP_DB}\" WITH (FORCE)"
psql_super -c "CREATE DATABASE \"${TMP_DB}\" OWNER \"${DB_USER}\""
psql_on "$TMP_DB" -c "REVOKE ALL ON DATABASE \"${TMP_DB}\" FROM PUBLIC; ALTER SCHEMA public OWNER TO \"${DB_USER}\""
compose exec -T db pg_restore -U "$DB_USER" -d "$TMP_DB" --no-owner --no-privileges --single-transaction --exit-on-error < "$SRC_ABS/db.dump"

# 3. swap the databases (nothing is connected: the app is stopped)
printf 'Switching to the restored database...\n'
psql_super -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('${DB_NAME}', '${TMP_DB}') AND pid <> pg_backend_pid()" > /dev/null
psql_super -c "ALTER DATABASE \"${DB_NAME}\" RENAME TO \"${OLD_DB}\""
if ! psql_super -c "ALTER DATABASE \"${TMP_DB}\" RENAME TO \"${DB_NAME}\""; then
  psql_super -c "ALTER DATABASE \"${OLD_DB}\" RENAME TO \"${DB_NAME}\"" || true
  die "could not switch to the restored database; the previous database was put back"
fi
psql_super -c "DROP DATABASE \"${OLD_DB}\" WITH (FORCE)"

# 4. uploaded files: a one-off container with the app image and the storage volume (the app is stopped).
# Extract into a temporary folder inside the volume first; only when that worked, move the current files
# aside, move the restored ones in, then delete the old ones. /data/storage is never emptied up front.
printf 'Restoring uploaded files...\n'
compose run --rm --no-deps -T --entrypoint sh app -c '
  set -eu
  cd /data/storage
  rm -rf .restore-new .restore-old
  mkdir .restore-new .restore-old
  if ! tar -C .restore-new -xzf - || [ ! -d .restore-new/storage ]; then
    rm -rf .restore-new .restore-old
    echo "the uploads archive could not be extracted; the current files were kept" >&2
    exit 3
  fi
  find . -mindepth 1 -maxdepth 1 ! -name .restore-new ! -name .restore-old -exec mv -t .restore-old {} +
  find .restore-new/storage -mindepth 1 -maxdepth 1 -exec mv -t . {} +
  rm -rf .restore-new .restore-old
' < "$SRC_ABS/storage.tar.gz"
