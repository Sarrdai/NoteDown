#!/usr/bin/env bash
# End-to-end test of real sync (PROJECT.md → "Server"): a throwaway Postgres,
# the server on 127.0.0.1:8765 and scripts/e2e-sync.js driving two to three
# browser "devices" against it. Needs what test-server.sh needs plus
# Playwright (preinstalled globally in the cloud container).
set -euo pipefail
cd "$(dirname "$0")/.."
venv="${VENV:-/var/tmp/notedown-venv}"
[ -x "$venv/bin/python" ] || python3 -m venv "$venv"
"$venv/bin/pip" install -q -r server/requirements-dev.txt

. scripts/lib-postgres.sh
start_postgres 54330
(cd server && DATABASE_URL="$PG_URL" SERVER_SECRET=e2e-secret CORS_ORIGINS=http://127.0.0.1:8766 \
  exec "$venv/bin/uvicorn" notedown_server.main:app --host 127.0.0.1 --port 8765 --log-level warning) &
server=$!
trap 'kill $server 2>/dev/null; as_pg "$pg_bin/pg_ctl -D $pg_dir/data -m fast stop" >/dev/null; rm -rf "$pg_dir"' EXIT
for _ in $(seq 50); do curl -sf http://127.0.0.1:8765/health >/dev/null && break; sleep 0.2; done

NODE_PATH="${NODE_PATH:-$(npm root -g)}" node scripts/e2e-sync.js "$@"
