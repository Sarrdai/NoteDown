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
  bin=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
  dir=$(mktemp -d /var/tmp/notedown-pg.XXXXXX)
  port=54329
  as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -c "$1"; else sh -c "$1"; fi; }
  [ "$(id -u)" != 0 ] || chown postgres "$dir"
  as_pg "$bin/initdb -D $dir/data -A trust -U postgres" >/dev/null
  as_pg "$bin/pg_ctl -D $dir/data -l $dir/log -w -o '-k $dir -p $port -c listen_addresses=127.0.0.1' start" >/dev/null
  trap 'as_pg "$bin/pg_ctl -D $dir/data -m fast stop" >/dev/null; rm -rf "$dir"' EXIT
  "$bin/createdb" -h 127.0.0.1 -p "$port" -U postgres notedown_test
  export TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:$port/notedown_test"
fi

"$venv/bin/python" -m pytest -q "$@"
