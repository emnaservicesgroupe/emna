#!/usr/bin/env bash
# DELETES ALL DATA of THIS VITA install: containers, network and the volumes (database, uploaded files and,
# in Caddy mode, certificates). Use it only to wipe a demo or test install.
#
#   ./wipe-data.sh
#
# It only ever acts on the Docker Compose project written in this folder's .env (COMPOSE_PROJECT_NAME=vita),
# prints the project and volume names first and asks you to type the project name. Never run
# "docker compose down -v" by hand from any other folder: it would act on THAT folder's project.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. ./lib.sh

[ -f .env ] || die ".env not found: nothing to wipe here"
vita_init
[ -t 0 ] || die "run this in an interactive terminal (it asks for confirmation)"
guard_project
printf '\nThis DELETES ALL DATA listed above. It cannot be undone (take ./backup.sh first if in doubt).\n'
IFS= read -r -p "Type the project name ($PROJECT) to continue: " answer
[ "$answer" = "$PROJECT" ] || die "cancelled"
compose down -v
printf 'Done. Start again with: ./setup.sh%s\n' "$([ "$MODE" = nginx ] && printf ' --behind-nginx' || true)"
