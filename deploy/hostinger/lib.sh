#!/usr/bin/env bash
# Shared helpers of the VITA kit scripts (both modes: Caddy and "behind an existing nginx").
# SOURCED by the other scripts (". ./lib.sh"), never run on its own. Works as root (hPanel web console) and
# as a normal user: sudo is only used when the Docker daemon is not reachable directly.
#
# vita_init decides, from ./.env:
#   PROJECT   the Docker Compose project name (COMPOSE_PROJECT_NAME, default "vita"). It is passed to every
#             docker compose call with -p, so a COMPOSE_PROJECT_NAME exported in your shell can never redirect
#             a script to another project.
#   MODE      "caddy" (default) or "nginx" (VITA_DEPLOY_MODE=nginx / COMPOSE_FILE with docker-compose.nginx.yml)
#   APP_PORT  loopback port of the app in nginx mode (VITA_APP_PORT, default 8083)
#   compose() docker compose with -p/-f/--profile for that mode
set -euo pipefail

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

# env_value KEY: last KEY=value line of ./.env (empty when absent)
env_value() { grep -E "^$1=" .env 2> /dev/null | tail -n 1 | cut -d= -f2- || true; }

vita_init() {
  # nothing from the caller's shell may change which project/files compose uses
  unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME COMPOSE_PATH_SEPARATOR COMPOSE_ENV_FILES COMPOSE_PROJECT_DIRECTORY
  PROJECT="$(env_value COMPOSE_PROJECT_NAME)"
  PROJECT="${PROJECT:-vita}"
  [[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "COMPOSE_PROJECT_NAME in .env ('$PROJECT') is not a valid project name"
  MODE="${VITA_MODE_FORCE:-}"
  if [ -z "$MODE" ]; then
    MODE=caddy
    if [ "$(env_value VITA_DEPLOY_MODE)" = "nginx" ]; then
      MODE=nginx
    else
      case "$(env_value COMPOSE_FILE)" in *docker-compose.nginx.yml*) MODE=nginx ;; esac
    fi
  fi
  APP_PORT="${VITA_PORT_FORCE:-$(env_value VITA_APP_PORT)}"
  APP_PORT="${APP_PORT:-8083}"
  [[ "$APP_PORT" =~ ^[0-9]+$ ]] || die "VITA_APP_PORT in .env ('$APP_PORT') is not a number"
  COMPOSE_ARGS=(-p "$PROJECT" -f docker-compose.yml)
  if [ "$MODE" = "nginx" ]; then
    COMPOSE_ARGS+=(-f docker-compose.nginx.yml)
  else
    COMPOSE_ARGS+=(--profile caddy)
  fi
  if ! declare -p DOCKER > /dev/null 2>&1; then
    command -v docker > /dev/null 2>&1 || die "docker is not installed (see SETUP-HOSTINGER.md)"
    DOCKER=(docker)
    docker info > /dev/null 2>&1 || DOCKER=(sudo docker)
  fi
}

compose() { "${DOCKER[@]}" compose "${COMPOSE_ARGS[@]}" "$@"; }

has_caddy() { [ "$MODE" = "caddy" ]; }

# 0 when something listens on TCP port $1 (any address)
port_in_use() {
  local p="$1"
  if command -v ss > /dev/null 2>&1; then
    if [ -n "$(ss -H -ltn "sport = :$p" 2> /dev/null)" ]; then return 0; else return 1; fi
  fi
  (exec 3<> "/dev/tcp/127.0.0.1/$p") 2> /dev/null
}

# first free port in 8083-8099 (empty when none)
next_free_port() {
  local p
  for p in $(seq 8083 8099); do
    if ! port_in_use "$p"; then printf '%s' "$p"; return 0; fi
  done
  return 0
}

# Safety guard for anything that can destroy data (restore.sh, wipe-data.sh): checks the project name and
# prints the project, containers and volumes the action would touch BEFORE it acts.
guard_project() {
  local file_proj resolved v
  file_proj="$(env_value COMPOSE_PROJECT_NAME)"
  [ -n "$file_proj" ] || die ".env has no COMPOSE_PROJECT_NAME (run ./setup.sh first); refusing to touch any volume"
  [ "$file_proj" = "$PROJECT" ] || die "project name mismatch; refusing"
  case "$PROJECT" in
    app|emnacrm*|emna-crm*|n8n*|gb-clamav*|*clamav*) die "project name '$PROJECT' belongs to something else on this server; refusing. VITA uses 'vita'." ;;
  esac
  resolved="$(compose config 2> /dev/null | sed -n 's/^name: //p' | head -n 1 || true)"
  [ "$resolved" = "$PROJECT" ] || die "docker compose resolves the project to '${resolved:-?}', not '$PROJECT'; refusing"
  printf 'Docker Compose project : %s   (folder %s)\n' "$PROJECT" "$(pwd -P)"
  printf 'Volumes of this project:\n'
  for v in db-data app-storage; do printf '  %s_%s\n' "$PROJECT" "$v"; done
  if has_caddy; then
    for v in caddy-data caddy-config; do printf '  %s_%s\n' "$PROJECT" "$v"; done
  fi
  printf 'Containers now         :\n'
  compose ps -a --format '  {{.Name}} ({{.State}})' 2> /dev/null || true
}
