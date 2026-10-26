#!/usr/bin/env bash
# Tests the Supabase migration against a throwaway database on a local
# Postgres (16+), using a small stub of Supabase's auth and storage schemas.
#   PGURL=postgres://user@localhost/postgres scripts/test-db.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
admin="${PGURL:-postgres:///postgres}"
db="scoop_test_$$"

psql -q "$admin" -c "create database $db" >/dev/null
trap 'psql -q "$admin" -c "drop database if exists $db" >/dev/null' EXIT
url="${admin%/*}/$db"

psql -q -v ON_ERROR_STOP=1 "$url" -f "$root/supabase/tests/supabase_stub.sql"
for f in "$root"/supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 "$url" -f "$f"
done
psql -q -o /dev/null -v ON_ERROR_STOP=1 "$url" -f "$root/supabase/tests/social_test.sql"
