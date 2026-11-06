#!/usr/bin/env bash
# Creates the FIRST SuperAdmin account (Task 20) through POST /auth/bootstrap-super-admin.
# Works only once: the server refuses as soon as any user exists.
#
#   ./create-admin.sh
#
# The password is typed hidden (read -s), is never echoed, never written to disk and never put on a command
# line (where `ps` could show it): name, e-mail and password go through standard input into a small node
# script inside the app container, which posts them to the app on 127.0.0.1 (not over the internet).
# This is the ONLY way to reach the bootstrap: Caddy / nginx answer 404 for it and, in production, the app refuses
# every caller that is not on its own loopback interface or that carries proxy headers.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. ./lib.sh
vita_init

[ -t 0 ] || die "run this in an interactive terminal (it asks for the password)"

[ -n "$(compose ps -q app 2> /dev/null || true)" ] || die "the app is not running: ./setup.sh (or docker compose up -d)"

printf 'Create the first VITA SuperAdmin account.\n'
printf 'Password rules: at least 12 characters, not a common password, must not contain the e-mail name.\n\n'

IFS= read -r -p "Full name: " FULL_NAME
IFS= read -r -p "E-mail: " EMAIL
[ -n "$FULL_NAME" ] || die "the full name is required"
[[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "'$EMAIL' does not look like an e-mail address"

IFS= read -r -s -p "Password (hidden): " PASSWORD
printf '\n'
IFS= read -r -s -p "Repeat the password: " PASSWORD2
printf '\n'
[ "$PASSWORD" = "$PASSWORD2" ] || { unset PASSWORD PASSWORD2; die "the passwords do not match"; }
unset PASSWORD2
[ "${#PASSWORD}" -ge 12 ] || { unset PASSWORD; die "the password must be at least 12 characters long"; }
case "$FULL_NAME$EMAIL$PASSWORD" in
  *$'\n'*|*$'\r'*) unset PASSWORD; die "line breaks are not allowed" ;;
esac

# Node reads three lines from stdin (name, e-mail, password) and posts them as JSON to the local app.
# Only the server's answer (status + message, never the password) is printed.
NODE_SCRIPT='
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", async () => {
  const [full_name, email, password] = buf.split("\n");
  try {
    const r = await fetch("http://127.0.0.1:" + (process.env.PORT || 5000) + "/auth/bootstrap-super-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name, email, password }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 201) {
      console.log("SuperAdmin created: " + body.email + " (id " + body.id + ")");
      process.exit(0);
    }
    console.error("Refused (" + r.status + "): " + (body.error || "unknown error"));
    process.exit(r.status === 403 ? 3 : 2);
  } catch (e) {
    console.error("Could not reach the app inside the container: " + (e && e.message));
    process.exit(4);
  }
});
'

set +e
printf '%s\n%s\n%s\n' "$FULL_NAME" "$EMAIL" "$PASSWORD" | compose exec -T app node -e "$NODE_SCRIPT"
rc=$?
set -e
unset PASSWORD

case "$rc" in
  0)
    SITE="$(grep -E '^SITE_ADDRESS=' .env 2> /dev/null | tail -n 1 | cut -d= -f2- || true)"
    printf '\nDone. Sign in at https://%s/vita/admin.html with this e-mail and password.\n' "${SITE:-<your-site>}"
    ;;
  3) die "an account already exists, so bootstrap is disabled. Sign in with the existing SuperAdmin (or, on a demo-only install, wipe it first: ./wipe-data.sh - this deletes ALL data)." ;;
  *) die "the account was not created (see the message above)" ;;
esac
