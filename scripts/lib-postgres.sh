# Sourced by test-server.sh and test-sync.sh: `start_postgres <port>` starts a
# throwaway local Postgres with an empty database, sets PG_URL and stops and
# deletes it on exit. Needs the PostgreSQL server binaries (present in the
# cloud session containers).
start_postgres() {
  local port=$1
  pg_bin=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
  pg_dir=$(mktemp -d /var/tmp/notedown-pg.XXXXXX)
  [ "$(id -u)" != 0 ] || chown postgres "$pg_dir"
  as_pg "$pg_bin/initdb -D $pg_dir/data -A trust -U postgres" >/dev/null
  as_pg "$pg_bin/pg_ctl -D $pg_dir/data -l $pg_dir/log -w -o '-k $pg_dir -p $port -c listen_addresses=127.0.0.1' start" >/dev/null
  trap 'as_pg "$pg_bin/pg_ctl -D $pg_dir/data -m fast stop" >/dev/null; rm -rf "$pg_dir"' EXIT
  "$pg_bin/createdb" -h 127.0.0.1 -p "$port" -U postgres notedown_test
  PG_URL="postgresql://postgres@127.0.0.1:$port/notedown_test"
}

as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -c "$1"; else sh -c "$1"; fi; }
