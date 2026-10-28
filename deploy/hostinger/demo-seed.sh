#!/usr/bin/env bash
# OPTIONAL demo data (Task 20) - only on a FRESH install, BEFORE you create the real admin.
#
#   ./demo-seed.sh
#
# Runs trust-crm/scripts/dev-seed-ui.js inside the app container (NODE_ENV=development and
# VITA_SEED_ALLOW_REMOTE=1 because the database host is the "db" container). The seed's own guards still
# apply: it refuses NODE_ENV=production and REFUSES any database that already holds a real (non-DEMO) user.
# It creates DEMO users (demo.superadmin@test.invalid, demo.manager@..., demo.candidate@...) with ONE random
# password printed once, plus jobs/employers/messages labelled DEMO. No source is connected, no mail is sent.
#
# Because a DEMO SuperAdmin then exists, ./create-admin.sh (bootstrap) is disabled. Before real use, WIPE
# the demo data - this deletes the database and uploaded files of this install:
#
#   ./wipe-data.sh && ./setup.sh && ./create-admin.sh      (add --behind-nginx in nginx mode)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. ./lib.sh
vita_init


[ -n "$(compose ps -q app 2> /dev/null || true)" ] || die "the app is not running: ./setup.sh (or docker compose up -d)"

cat <<'TXT'
==================================================================
  DEMO DATA - NOT FOR REAL USE
  Only on a fresh install, before the real admin exists.
  Remove it later with: ./wipe-data.sh   (deletes ALL data of this install)
==================================================================
TXT
if [ -t 0 ]; then
  IFS= read -r -p "Type DEMO to load demo data: " answer
  [ "$answer" = "DEMO" ] || die "cancelled"
fi

# The password is generated inside the container and printed ONCE by the seed (not stored anywhere else).
compose exec -T \
  -e NODE_ENV=development \
  -e VITA_SEED_ALLOW_REMOTE=1 \
  app node scripts/dev-seed-ui.js
