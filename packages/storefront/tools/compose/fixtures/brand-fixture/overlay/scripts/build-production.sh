#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
pnpm --dir vendor/storefront-client run build
export NODE_OPTIONS="$(node ../scripts/node-heap-options.mjs --reserve-mb=4096 --max-mb=3072 --min-mb=1536)"
bash scripts/assert-no-vendure.sh
pnpm run lint
pnpm run clean
pnpm run build.client
node scripts/cleanup-static-sitemaps.js
node /opt/fixture-ops/cf-purge.mjs
