#!/usr/bin/env bash
# Apply the sellright_app (non-owner) grants to a TARGET database. Idempotent —
# safe to re-run (e.g. after new migrations add tables). Must be run while
# connected as the OWNER role (sellright). Companion to create-app-role.sh, which
# creates the role once + sets up the primary DB; this re-applies the grant block
# to any database (sellright_test, rightapps, a fresh tenant DB, ...).
#
# Usage: grant-app-role.sh "postgres://sellright:<pw>@127.0.0.1:5433/<dbname>"
#
# The ALTER DEFAULT PRIVILEGES lines are per-database, so every DB the app role
# serves needs this run once; the explicit GRANT ... ON ALL TABLES covers tables
# that already exist (including ones added by later migrations).
set -euo pipefail
OWNER_URL="${1:?usage: grant-app-role.sh <owner DATABASE_URL for the target db>}"
DBNAME="${OWNER_URL##*/}"; DBNAME="${DBNAME%%\?*}"

WHO="$(psql "$OWNER_URL" -tAc 'select current_user')"
if [ "$WHO" = "sellright_app" ]; then echo "FATAL: connected as sellright_app; need the owner role" >&2; exit 1; fi
echo "[grant-app-role] db=$DBNAME owner=$WHO"

psql "$OWNER_URL" -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA public TO sellright_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sellright_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sellright_app;
-- registries are read-only to the app (writes go through the owner: seed/migrations)
REVOKE INSERT, UPDATE, DELETE ON "store", "admin_user", "admin_user_store" FROM sellright_app;
-- future owner-created tables auto-grant DML to the app role
ALTER DEFAULT PRIVILEGES FOR ROLE sellright IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sellright_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sellright IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO sellright_app;
SQL

psql "$OWNER_URL" -v ON_ERROR_STOP=1 -c "GRANT CONNECT ON DATABASE \"$DBNAME\" TO sellright_app;"
echo "[grant-app-role] applied to $DBNAME"
