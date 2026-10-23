#!/bin/sh
# Container entrypoint (Task 20): preflight + database init/migrations (idempotent), then the server.
# exec replaces this shell with node, so node receives SIGTERM directly (graceful shutdown in server.js).
set -eu
node /app/scripts/db-init.js
exec node /app/server.js
