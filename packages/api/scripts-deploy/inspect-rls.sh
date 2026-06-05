#!/usr/bin/env bash
# Inspect Postgres roles + per-table RLS/owner state. Inherits the API's DB env.
set -euo pipefail
export PNPM_HOME="$HOME/.local/share/pnpm"; export PATH="$PNPM_HOME:$PATH"
APIPID="$(pgrep -f 'src/index.ts' | head -1)"
set -a; eval "$(tr '\0' '\n' < /proc/$APIPID/environ | grep -E '^DATABASE_URL=' | sed 's/^/export /')"; set +a

echo "=== roles ==="
psql "$DATABASE_URL" -P pager=off -c "select rolname, rolsuper as super, rolbypassrls as bypassrls, rolcanlogin as login from pg_roles where rolname not like 'pg_%' order by rolname;"

echo "=== current connection role ==="
psql "$DATABASE_URL" -tAc "select current_user, current_database();"

echo "=== per-table owner + rls + force ==="
psql "$DATABASE_URL" -P pager=off -c "
select c.relname as table,
       pg_get_userbyid(c.relowner) as owner,
       c.relrowsecurity as rls,
       c.relforcerowsecurity as force,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public' and c.relkind='r'
order by c.relname;"
