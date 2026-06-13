#!/usr/bin/env bash
# Create a new SellRight tenant database (idempotent), owned by the sellright role.
# A separate SellRight "instance" = its own database on the :5433 cluster; inside
# it, each brand/app is a store row. Run with the owner DATABASE_URL of any
# EXISTING db on the same cluster — we connect to the maintenance 'postgres' db to
# issue CREATE DATABASE (you can't create a db while connected to the one you make).
#
# Usage: create-tenant-db.sh "postgres://sellright:<pw>@127.0.0.1:5433/<existingdb>" <newdbname>
set -euo pipefail
SRC_URL="${1:?usage: create-tenant-db.sh <owner DATABASE_URL> <newdbname>}"
NEWDB="${2:?usage: create-tenant-db.sh <owner DATABASE_URL> <newdbname>}"
case "$NEWDB" in *[!a-zA-Z0-9_]*) echo "FATAL: db name must be alnum/underscore: $NEWDB" >&2; exit 1;; esac

MAINT="${SRC_URL%/*}/postgres"   # same host:port/creds, maintenance db
WHO="$(psql "$MAINT" -tAc 'select current_user')"
if [ "$WHO" = "sellright_app" ]; then echo "FATAL: connected as sellright_app; need the owner role" >&2; exit 1; fi

if [ "$(psql "$MAINT" -tAc "SELECT 1 FROM pg_database WHERE datname='$NEWDB'")" = "1" ]; then
  echo "[create-tenant-db] $NEWDB already exists — skipping create"
else
  psql "$MAINT" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$NEWDB\" OWNER sellright"
  echo "[create-tenant-db] created $NEWDB (owner sellright)"
fi
