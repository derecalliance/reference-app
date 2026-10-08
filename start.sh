#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 DeRec Alliance. All rights reserved.
#
# Run the DeRec reference app in Docker, from a fresh clone or over a running
# one. Safe to run again at any time: whatever this project already has running
# is stopped first, the published image is pulled (or, with --build, built from
# the checkout), and the node is started and waited on until it answers. Data is
# kept between runs unless --fresh is given.
#
#   ./start.sh                 SQLite, at http://localhost:<port>
#   ./start.sh --postgres      PostgreSQL instead
#   ./start.sh --lan           also reachable from phones and other machines
#   ./start.sh --fresh         erase all data first (both databases)
#   ./start.sh --port 8080     a fixed HTTP port instead of the first free one
#   ./start.sh --build         build the image from this checkout instead of pulling
#   ./start.sh --stop          stop it and exit
#
# Needs Docker with Compose v2.24 or newer. Nothing else: no Node, no Rust. If
# the published image cannot be pulled (offline, or not published yet), it is
# built from the checkout instead.

set -euo pipefail

cd "$(dirname "$0")"

PROJECT=derec
DB=sqlite
LAN=0
FRESH=0
STOP_ONLY=0
BUILD=0
HTTP_PORT="${DEREC_HOST_PORT:-}"
GRPC_PORT="${DEREC_HOST_GRPC_PORT:-}"
HEALTH_TIMEOUT_SECS=180

usage() {
  sed -n '5,22p' "$0" | sed 's/^# \{0,1\}//'
}

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --postgres) DB=postgres ;;
    --sqlite) DB=sqlite ;;
    --lan) LAN=1 ;;
    --fresh) FRESH=1 ;;
    --stop) STOP_ONLY=1 ;;
    --build) BUILD=1 ;;
    --port)
      [ $# -ge 2 ] || fail "--port needs a number"
      HTTP_PORT="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) fail "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# ── Prerequisites ────────────────────────────────────────────────────────────

command -v docker >/dev/null 2>&1 || fail "Docker is not installed: https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start Docker and try again."

# `docker compose` (the plugin) first; a standalone `docker-compose` only if it
# is v2, since v1 cannot read these files.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version 2>/dev/null | grep -qE 'v?[2-9]\.'; then
  COMPOSE=(docker-compose)
else
  fail "Docker Compose v2 is required (\`docker compose version\`)."
fi

# The repo-root files, so the project directory (and its optional `.env`) is
# the repo root, which is also what compose.build.yaml's paths resolve against.
if [ "$DB" = postgres ]; then
  COMPOSE_FILES=(-f compose.postgres.yaml)
else
  COMPOSE_FILES=(-f compose.yaml)
fi
BUILD_OVERRIDE=(-f compose.build.yaml)

compose() { "${COMPOSE[@]}" -p "$PROJECT" "${COMPOSE_FILES[@]}" "$@"; }

# ── Stop whatever is running ─────────────────────────────────────────────────

# Either database variant may be up; --remove-orphans takes the other one's
# services down with it.
if [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")" ]; then
  say "Stopping the running DeRec node"
fi
compose down --remove-orphans >/dev/null 2>&1 || true

if [ "$FRESH" = 1 ]; then
  say "Erasing stored data"
  docker volume rm "${PROJECT}_derec-data" "${PROJECT}_derec-pgdata" >/dev/null 2>&1 || true
fi

if [ "$STOP_ONLY" = 1 ]; then
  say "Stopped."
  exit 0
fi

# ── Ports ────────────────────────────────────────────────────────────────────

# Something accepting connections on 127.0.0.1:<port>? bash's /dev/tcp needs no
# extra tools and sees Docker's published ports and macOS's AirPlay listener
# on 5000 alike.
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

first_free_port() {
  local port=$1 last=$(($1 + 99))
  while [ "$port" -le "$last" ]; do
    if ! port_in_use "$port"; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
  done
  return 1
}

# The ports this project just released can take a moment to free up.
sleep 1

if [ -n "$HTTP_PORT" ]; then
  port_in_use "$HTTP_PORT" && fail "port $HTTP_PORT is already in use; pick another with --port"
else
  HTTP_PORT=$(first_free_port 5000) || fail "no free port between 5000 and 5099"
  [ "$HTTP_PORT" = 5000 ] || say "Port 5000 is taken; using $HTTP_PORT"
fi
if [ -n "$GRPC_PORT" ]; then
  port_in_use "$GRPC_PORT" && fail "gRPC port $GRPC_PORT is already in use"
else
  GRPC_PORT=$(first_free_port 50051) || fail "no free port between 50051 and 50150"
fi
export DEREC_HOST_PORT="$HTTP_PORT" DEREC_HOST_GRPC_PORT="$GRPC_PORT"

# ── LAN address ──────────────────────────────────────────────────────────────

lan_ip() {
  local ip="" iface
  if command -v ipconfig >/dev/null 2>&1; then # macOS
    iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
    [ -n "$iface" ] && ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
  fi
  if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then # Linux
    ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
  fi
  if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
    ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  fi
  echo "$ip"
}

if [ "$LAN" = 1 ]; then
  LAN_IP=$(lan_ip)
  [ -n "$LAN_IP" ] || fail "could not work out this machine's LAN address; set LAN_IP=<address> and run again"
  export LAN_IP
fi

# ── Build and start ──────────────────────────────────────────────────────────

if [ "$BUILD" = 0 ]; then
  say "Pulling the published image"
  if ! compose pull --quiet; then
    say "Could not pull the image (offline, or not published yet); building it from this checkout instead"
    BUILD=1
  fi
fi
if [ "$BUILD" = 1 ]; then
  COMPOSE_FILES+=("${BUILD_OVERRIDE[@]}")
  say "Building the image from this checkout ($DB) — the first build takes several minutes"
  compose up -d --build
else
  say "Starting the node ($DB)"
  compose up -d
fi

# ── Wait until it answers ────────────────────────────────────────────────────

URL="http://localhost:$HTTP_PORT"
printf '==> Waiting for %s ' "$URL"
deadline=$((SECONDS + HEALTH_TIMEOUT_SECS))
healthy() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$URL/health" >/dev/null 2>&1
  else
    # No curl: ask Docker for the image's own healthcheck verdict instead.
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q node)" 2>/dev/null)" = healthy ]
  fi
}
until healthy; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo
    compose logs --tail 40 node >&2 || true
    fail "the node did not become healthy within ${HEALTH_TIMEOUT_SECS}s (logs above)"
  fi
  printf '.'
  sleep 2
done
echo " up."

echo
echo "  DeRec reference app ($DB) is running."
echo
echo "  Open:   $URL"
if [ "${LAN_IP:-}" != "" ]; then
  echo "  LAN:    http://$LAN_IP:$HTTP_PORT   (phones and other machines on this network)"
fi
echo
echo "  Logs:   ${COMPOSE[*]} -p $PROJECT logs -f node"
echo "  Stop:   ./start.sh --stop"
echo "  Reset:  ./start.sh --fresh   (then \"Reset browser data\" in the app, in each browser you used)"
echo
