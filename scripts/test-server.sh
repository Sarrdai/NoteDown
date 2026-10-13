#!/usr/bin/env bash
# Runs the server tests (PROJECT.md → "Server"); extra arguments go to pytest.
# Without TEST_DATABASE_URL it starts a throwaway local Postgres, which needs
# the PostgreSQL server binaries (present in the cloud session containers).
set -euo pipefail
cd "$(dirname "$0")/../server"

venv="${VENV:-/var/tmp/notedown-venv}"
[ -x "$venv/bin/python" ] || python3 -m venv "$venv"
"$venv/bin/pip" install -q -r requirements-dev.txt

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  . ../scripts/lib-postgres.sh
  start_postgres 54329
  export TEST_DATABASE_URL="$PG_URL"
fi

"$venv/bin/python" -m pytest -q "$@"
