#!/usr/bin/env bash
# PM2 entrypoint for the Right Apps SellRight API instance (its own DB: rightapps).
# Sources ~/.sellright/rightapps.env (DATABASE_URL = sellright_app role on the
# rightapps DB, PORT, Stripe keys, etc.) then runs the COMPILED API as the
# non-owner app role (fail-closed under FORCE RLS).
#
# This runs the API from WHATEVER checkout the script lives in (resolved from
# its own path), so a dedicated prod checkout (~/sites/rightapps) stays decoupled
# from the dev tree (~/sites/sellright). Deploy from the prod checkout:
#   cd ~/sites/rightapps && git pull && pnpm -r build \
#     && (cd packages/admin && pnpm install --ignore-workspace && pnpm build) \
#     && pm2 restart rightapps-api
# (admin is excluded from the workspace, so it installs/builds independently.)
set -euo pipefail
ENV_FILE="$HOME/.sellright/rightapps.env"
[ -f "$ENV_FILE" ] || { echo "[start-rightapps] missing $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
# packages/api, relative to this script (scripts-deploy/..), not a hardcoded tree.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f dist/index.js ] || { echo "[start-rightapps] dist/index.js missing — run pnpm -r build first" >&2; exit 1; }
exec /usr/bin/node dist/index.js
