#!/usr/bin/env bash
# Start the SellRight API on :3300, fully detached (survives the SSH channel),
# and report. Uses ~/.sellright/env's DATABASE_URL_APP if present (non-owner app
# role), else the owner URL. Mirror of start-admin.sh's persistence pattern.
export PNPM_HOME="$HOME/.local/share/pnpm"; export PATH="$PNPM_HOME:$PATH"
cd ~/sites/sellright/packages/api

if [ -f "$HOME/.sellright/env" ]; then source "$HOME/.sellright/env"; DBURL="$DATABASE_URL_APP"; fi
DBURL="${DBURL:-postgres://sellright:srdev_pX7k2Qm9Lw@127.0.0.1:5433/sellright_dev}"

pkill -f 'src/index.ts' 2>/dev/null || true; sleep 2
fuser -k 3300/tcp 2>/dev/null || true; sleep 1

setsid nohup env DATABASE_URL="$DBURL" PORT=3300 pnpm exec tsx src/index.ts > ~/sites/sellright/api.log 2>&1 < /dev/null &
sleep 7

echo "=== port ==="
ss -ltnp 2>/dev/null | grep ':3300' | head -1 || echo "NOT LISTENING"
echo "=== health ==="
curl -s -o /dev/null -w 'http=%{http_code}\n' http://127.0.0.1:3300/v1/health
echo "=== log ==="
tail -4 ~/sites/sellright/api.log
