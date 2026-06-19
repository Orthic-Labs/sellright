#!/usr/bin/env bash
# One-time: create the NON-owner application DB role `sellright_app` (research §1,
# AWS-canonical RLS pattern) and write a 0600 env file into packages/api/.env
# with both runtime and owner connection URLs.
# The API runs as sellright_app (fail-closed under FORCE RLS); migrations / seed /
# jobs run as the owner. Must be run while connected as the OWNER role.
#
# Usage: APP_DB_PASSWORD=<pw> bash create-app-role.sh
set -euo pipefail
APP_PW="${APP_DB_PASSWORD:?set APP_DB_PASSWORD env}"
export PNPM_HOME="$HOME/.local/share/pnpm"; export PATH="$PNPM_HOME:$PATH"

# Owner DATABASE_URL — inherited from the currently-running API (still owner now).
APIPID="$(pgrep -f 'src/index.ts' | head -1)"
set -a; eval "$(tr '\0' '\n' < /proc/$APIPID/environ | grep -E '^DATABASE_URL=' | sed 's/^/export /')"; set +a
OWNER_URL="$DATABASE_URL"

WHO="$(psql "$OWNER_URL" -tAc 'select current_user')"
if [ "$WHO" = "sellright_app" ]; then echo "FATAL: connected as sellright_app; need the owner role" >&2; exit 1; fi
echo "[create-app-role] connected as owner: $WHO"

# Create or update the role. Password is hex (no quoting hazard) so inline-safe.
# (psql does NOT substitute :vars inside a DO $$…$$ block, so do this from bash.)
ROLE_ATTRS="LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '$APP_PW'"
if [ "$(psql "$OWNER_URL" -tAc "select 1 from pg_roles where rolname='sellright_app'")" = "1" ]; then
  psql "$OWNER_URL" -v ON_ERROR_STOP=1 -c "ALTER ROLE sellright_app $ROLE_ATTRS"
else
  psql "$OWNER_URL" -v ON_ERROR_STOP=1 -c "CREATE ROLE sellright_app $ROLE_ATTRS"
fi

psql "$OWNER_URL" -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA public TO sellright_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sellright_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sellright_app;
-- registries are read-only to the app (writes happen via the owner: seed-admin/migrations)
REVOKE INSERT, UPDATE, DELETE ON "store", "admin_user", "admin_user_store" FROM sellright_app;
-- future owner-created tables auto-grant DML to the app role
ALTER DEFAULT PRIVILEGES FOR ROLE sellright IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sellright_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sellright IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO sellright_app;
SQL
echo "[create-app-role] role + grants applied"

# Grant CONNECT on the actual database (name parsed from the URL).
DBNAME="${OWNER_URL##*/}"; DBNAME="${DBNAME%%\?*}"
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -c "GRANT CONNECT ON DATABASE \"$DBNAME\" TO sellright_app;"

# Build the app URL by swapping creds; keep host:port/db from the owner URL.
HOSTDB="${OWNER_URL#*@}"            # 127.0.0.1:5433/sellright_dev
APP_URL="postgres://sellright_app:${APP_PW}@${HOSTDB}"

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$API_DIR/.env"
umask 177                 # set BEFORE mktemp so the temp file holding the DB
TMP_FILE="$(mktemp)"      # credentials is created 0600, never world-readable
{
cat <<EOF
# SellRight API env (0600). Database URLs updated by create-app-role.sh.
DATABASE_URL=${APP_URL}
DATABASE_URL_OWNER=${OWNER_URL}
DATABASE_URL_NONOWNER=${APP_URL}
PORT=3300
EOF
if [ -f "$ENV_FILE" ]; then
  grep -vE '^(DATABASE_URL|DATABASE_URL_OWNER|DATABASE_URL_NONOWNER|PORT)=' "$ENV_FILE" || true
fi
} > "$TMP_FILE"
mv "$TMP_FILE" "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "[create-app-role] wrote $ENV_FILE (0600)"

# Prove the app role works AND is fail-closed: connect as app, no store context.
echo "[create-app-role] app-role probe (no store context -> data tables must be empty/denied):"
psql "$APP_URL" -tAc "select 'whoami='||current_user;"
psql "$APP_URL" -tAc "select 'stores_visible='||count(*) from store;"            # registry -> visible
psql "$APP_URL" -tAc "select 'admin_acl_visible='||count(*) from admin_user_store;" # registry -> visible
psql "$APP_URL" -tAc "select 'orders_without_context='||count(*) from \"order\";"    # FORCE RLS -> 0
echo "[create-app-role] done"
