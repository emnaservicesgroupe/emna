#!/usr/bin/env bash
# Works in both modes (Caddy / behind nginx). Update to the latest code (Task 20): backup first, then git pull (fast-forward only), pull the base images,
# rebuild the app on fresh base images and restart. The app container applies new database migrations itself
# when it starts (idempotent).
#
#   ./update.sh
#
# Everything is inside main(), called on the LAST line together with exit: bash has parsed the whole file
# before the first command runs and never reads further, so a `git pull` that changes this very file cannot
# make bash execute half-old, half-new lines.
set -euo pipefail

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")"
  # shellcheck source=lib.sh
  . ./lib.sh
  vita_init

  command -v git > /dev/null 2>&1 || die "git is not installed"
  # An .env from an earlier version of the kit has no project name / profile: add them (Caddy mode only).
  if has_caddy && [ -f .env ]; then
    grep -qE '^COMPOSE_PROJECT_NAME=' .env || printf 'COMPOSE_PROJECT_NAME=vita\n' >> .env
    grep -qE '^COMPOSE_PROFILES=' .env || printf 'COMPOSE_PROFILES=caddy\n' >> .env
  fi

  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    die "the repository has local changes (git status); commit or discard them first"
  fi
  local branch upstream
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" != "HEAD" ] || die "the checkout is not on a branch (detached HEAD): git switch main"
  if ! upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2> /dev/null)"; then
    die "branch '$branch' has no upstream. Choose the branch to follow, e.g.: git fetch origin && git switch main"
  fi
  local remote="${upstream%%/*}" rbranch="${upstream#*/}"
  if ! git ls-remote --exit-code --heads "$remote" "$rbranch" > /dev/null 2>&1; then
    cat >&2 <<TXT
ERROR: the branch '$rbranch' no longer exists on '$remote' (it was probably merged and deleted).
Switch to the main branch and try again:
  git fetch $remote
  git switch main            # or: git switch -c main --track $remote/main
  ./update.sh
TXT
    exit 1
  fi

  printf '1/5 Backup before updating...\n'
  ./backup.sh

  printf '2/5 Fetching the new code (%s)...\n' "$upstream"
  git pull --ff-only

  if has_caddy; then
    printf '3/5 Pulling the newest postgres:16 and caddy:2 images...\n'
    compose pull db caddy
  else
    printf '3/5 Pulling the newest postgres:16 image (nginx mode: no Caddy)...\n'
    compose pull db
  fi

  printf '4/5 Rebuilding the app image on a fresh node:22-slim...\n'
  compose build --pull app

  printf '5/5 Restarting (migrations run on start)...\n'
  if has_caddy; then
    compose up -d
  else
    compose up -d db app
  fi
  ./status.sh
}

main "$@"; exit $?
