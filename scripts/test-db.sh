#!/usr/bin/env bash
# npm run test:db — the database test suite in one command, here and in CI.
# Starts Docker if needed (macOS), brings up a fresh Postgres + PgBouncer from
# docker-compose.test.yml, runs db/**/*.dbtest.ts against it, and tears the
# containers down again whatever the outcome. Extra arguments go to vitest.
set -euo pipefail
cd "$(dirname "$0")/.."

compose=(docker compose -f docker-compose.test.yml)

# Docker Desktop's per-user socket, which a shared /var/run/docker.sock (it
# can belong to another account on the same Mac) would otherwise shadow.
user_socket="$HOME/.docker/run/docker.sock"
use_user_socket() {
  if [[ -z "${DOCKER_HOST:-}" && -S "$user_socket" ]]; then export DOCKER_HOST="unix://$user_socket"; fi
}
use_user_socket

if ! docker info >/dev/null 2>&1; then
  if [[ "$(uname)" == "Darwin" ]]; then
    echo "Starting Docker..."
    open -a Docker
    for _ in $(seq 1 90); do
      use_user_socket
      docker info >/dev/null 2>&1 && break
      sleep 2
    done
  fi
  docker info >/dev/null 2>&1 || { echo "Docker is not running." >&2; exit 1; }
fi

cleanup() { "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Fresh every run: a leftover database could hide a test that depends on rows
# an earlier run left behind.
cleanup
"${compose[@]}" up --detach --wait --quiet-pull

# Tests go through PgBouncer; migrations and the marker go straight to
# Postgres (db/test/global-setup.ts).
export TEST_DATABASE_URL="postgres://tally:tally@127.0.0.1:56432/tally_test"
export TEST_DATABASE_DIRECT_URL="postgres://tally:tally@127.0.0.1:55432/tally_test"
npx vitest run --config vitest.db.config.ts "$@"
