#!/usr/bin/env bash
# Update to the latest code (Task 20): backup first, then git pull (fast-forward only), rebuild, restart.
# The app container applies new database migrations itself when it starts (idempotent).
#
#   ./update.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v git > /dev/null 2>&1 || die "git is not installed"
command -v docker > /dev/null 2>&1 || die "docker is not installed"
DOCKER=(docker)
docker info > /dev/null 2>&1 || DOCKER=(sudo docker)
compose() { "${DOCKER[@]}" compose "$@"; }

printf '1/4 Backup before updating...\n'
./backup.sh

printf '2/4 Fetching the new code...\n'
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "the repository has local changes (git status); commit or discard them first"
fi
git pull --ff-only

printf '3/4 Rebuilding the app image...\n'
compose build app

printf '4/4 Restarting (migrations run on start)...\n'
compose up -d
./status.sh
