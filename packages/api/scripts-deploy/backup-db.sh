#!/usr/bin/env bash
# WP6c — daily pg_dump + offsite rclone. Cron: `30 2 * * *` (02:30 nightly).
# Restore drill: `createdb sellright_restore && pg_restore -d sellright_restore
# /home/vendure/backups/sellright/sellright_<date>.dump`.
#
# Sources the same env file the systemd unit uses (DATABASE_URL_OWNER) so the
# pg_dump connection matches whatever the API uses. Set SELLRIGHT_RCLONE_REMOTE
# in the env file to enable offsite backups.
set -euo pipefail

ENV_FILE="${SELLRIGHT_ENV_FILE:-$HOME/.sellright/env}"
BACKUP_DIR="/home/vendure/backups/sellright"
TS=$(date +%F)
RETENTION_DAYS=14

if [ ! -f "$ENV_FILE" ]; then
    echo "[backup] FATAL: env file not found: $ENV_FILE" >&2
    exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

if [ -z "${DATABASE_URL_OWNER:-}" ]; then
    echo "[backup] FATAL: DATABASE_URL_OWNER not set in $ENV_FILE" >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/sellright_${TS}.dump"

# pg_dump understands postgres:// URLs natively — no need to parse host/port
# out of the URL. -Fc = custom format (compressed, parallel-safe on restore).
pg_dump "$DATABASE_URL_OWNER" -Fc -f "$OUT"

# Offsite — best-effort, don't fail the cron if rclone is briefly down.
if command -v rclone >/dev/null 2>&1 && [ -n "${SELLRIGHT_RCLONE_REMOTE:-}" ]; then
    rclone copy "$OUT" "${SELLRIGHT_RCLONE_REMOTE}/daily/" \
        --log-file "$BACKUP_DIR/rclone.log" || \
        echo "[backup] rclone offsite copy failed (see rclone.log); local copy is intact" >&2
fi

# Retention — keep 14 days of local copies, prune the rest.
find "$BACKUP_DIR" -name 'sellright_*.dump' -mtime +${RETENTION_DAYS} -delete

# Surface the result for the monitoring cron (which greps for this line).
echo "[backup] OK — $(du -h "$OUT" | cut -f1) at $TS"
