#!/bin/sh
# Runs ONCE, when the database volume is first created (postgres image: /docker-entrypoint-initdb.d), as the
# Postgres superuser (POSTGRES_USER from .env.db). Creates the UNPRIVILEGED application role (DB_USER from .env)
# that owns the application database and its public schema - no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or
# BYPASSRLS - so the app cannot read server files, run programs (COPY ... PROGRAM) or touch other databases.
# The superuser is used only by this script and by backup.sh / restore.sh (local socket inside the container).
set -eu

: "${VITA_APP_USER:?VITA_APP_USER (DB_USER) is required}"
: "${VITA_APP_PASSWORD:?VITA_APP_PASSWORD (DB_PASSWORD) is required}"
[ "$VITA_APP_USER" != "$POSTGRES_USER" ] || { echo "DB_USER must not be the Postgres superuser" >&2; exit 1; }

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_user="$VITA_APP_USER" -v app_pw="$VITA_APP_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER DATABASE :"db" OWNER TO :"app_user";
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
ALTER SCHEMA public OWNER TO :"app_user";
-- btree_gist is a trusted extension (the owner could create it too); created here so migrations never need more.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
SQL
echo "db-init: created the unprivileged application role and handed it the database"
