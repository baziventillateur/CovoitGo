#!/usr/bin/env bash
# Teste la migration sur un Postgres local jetable (PostGIS requis).
# Usage : PGBIN=/usr/lib/postgresql/16/bin ./supabase/tests/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DATA="$(mktemp -d)"; PORT=54329
trap '"$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA"' EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -c listen_addresses=''" -w start >/dev/null
P=("$PGBIN/psql" -h "$DATA" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${P[@]}" -c "create database covoit_test"
"${P[@]}" -d covoit_test -f "$ROOT/supabase/tests/00_stub_supabase.sql"
"${P[@]}" -d covoit_test -f "$ROOT/supabase/migrations/0001_socle.sql"
"${P[@]}" -d covoit_test -f "$ROOT/supabase/tests/01_scenario.sql"
