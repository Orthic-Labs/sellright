#!/usr/bin/env bash
# PM2 entrypoint for the Right Apps SellRight API instance (its own DB: rightapps).
# Sources ~/.sellright/rightapps.env (DATABASE_URL = sellright_app role on the
# rightapps DB, PORT, Stripe keys, etc.) then runs the COMPILED API as the
# non-owner app role (fail-closed under FORCE RLS).
#
# Start once:
#   cd ~/sites/sellright && pnpm -r build
#   pm2 start packages/api/scripts-deploy/start-rightapps.sh \
#     --name rightapps-api --interpreter bash && pm2 save
# Redeploy:
#   cd ~/sites/sellright && git pull && pnpm -r build && pm2 restart rightapps-api
set -euo pipefail
ENV_FILE="$HOME/.sellright/rightapps.env"
[ -f "$ENV_FILE" ] || { echo "[start-rightapps] missing $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
cd "$HOME/sites/sellright/packages/api"
[ -f dist/index.js ] || { echo "[start-rightapps] dist/index.js missing — run pnpm -r build first" >&2; exit 1; }
exec /usr/bin/node dist/index.js
