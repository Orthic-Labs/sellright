#!/usr/bin/env bash
# Start the admin dev server (proxy-enabled) on 4300, fully detached, and report.
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"
cd ~/sites/sellright/packages/admin

pkill -f 'vite --host 127.0.0.1 --port 4300' 2>/dev/null || true
sleep 1

# setsid + nohup so it survives the SSH channel closing.
setsid nohup pnpm exec vite --host 127.0.0.1 --port 4300 > ~/sites/sellright/admin.log 2>&1 < /dev/null &
sleep 7

echo "=== port ==="
ss -ltnp 2>/dev/null | grep ':4300' | head -1 || echo "NOT LISTENING"
echo "=== spa ==="
curl -s -o /dev/null -w 'http=%{http_code}\n' http://127.0.0.1:4300/
echo "=== log (tail) ==="
tail -8 ~/sites/sellright/admin.log
