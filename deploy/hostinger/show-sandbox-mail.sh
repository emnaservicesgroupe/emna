#!/usr/bin/env bash
# Show the newest messages the SANDBOX mail adapter recorded (Task 20) - admin use only.
#
#   ./show-sandbox-mail.sh          newest 10
#   ./show-sandbox-mail.sh 30       newest 30 (max 200)
#
# In sandbox mode (MAIL_PROVIDER=sandbox) NOTHING is delivered: only recipients on MAIL_SANDBOX_ALLOWLIST are
# accepted and stored in js_sandbox_mail; mail to any other address is refused and NOT stored. To try the
# candidate sign-in yourself, add your own test address to MAIL_SANDBOX_ALLOWLIST in .env (e.g.
# MAIL_SANDBOX_ALLOWLIST=*@test.invalid,you@your-domain.com), run `docker compose up -d`, request a code in the
# portal, then read it here.
#
# WARNING: message bodies contain one-time sign-in codes and personal data. Do not paste this output anywhere.
# The query runs in a READ-ONLY transaction as the application role.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

N="${1:-10}"
[[ "$N" =~ ^[0-9]+$ ]] && [ "$N" -ge 1 ] && [ "$N" -le 200 ] || die "usage: ./show-sandbox-mail.sh [1-200]"
[ -f .env ] || die ".env not found (run ./setup.sh first)"
get_env() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true; }
DB_USER="$(get_env DB_USER)"
DB_NAME="$(get_env DB_NAME)"
[[ "$DB_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_USER in .env is missing or unusual"
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_NAME in .env is missing or unusual"

command -v docker > /dev/null 2>&1 || die "docker is not installed"
DOCKER=(docker)
docker info > /dev/null 2>&1 || DOCKER=(sudo docker)

printf 'WARNING: bodies contain sign-in codes and personal data - admin use only, do not share.\n\n' >&2
"${DOCKER[@]}" compose exec -T -e PGOPTIONS="-c default_transaction_read_only=on" db \
  psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -v n="$N" -P pager=off -x <<'SQL'
SELECT id, created_at, to_addr AS "to", subject, left(body, 2000) AS body
  FROM js_sandbox_mail
 WHERE headers->>'_direction' = 'outbound'
 ORDER BY id DESC
 LIMIT :n;
SQL
