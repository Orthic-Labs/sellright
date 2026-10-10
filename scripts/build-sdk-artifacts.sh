#!/usr/bin/env bash
# Builds the SDK release artifacts (plan 2.3):
#   artifacts/sdk/sellright-api-<v>.tgz            engine (dist, drizzle, exports, BUILD-INFO.json)
#   artifacts/sdk/sellright-sample-plugin-<v>.tgz  reference plugin (peer-pins the exact engine)
#   artifacts/sdk/sellright-admin-bundle-<v>.tgz   admin dashboard bundle (dist + BUILD-INFO.json)
# Then the composed image (deploy/sdk/Dockerfile) consumes the two packages from artifacts/sdk.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/artifacts/sdk"
rm -rf "$OUT" && mkdir -p "$OUT"

pnpm --filter @sellright/api build
pnpm --filter @sellright/api pack --pack-destination "$OUT"
pnpm --filter @sellright/sample-plugin build
pnpm --filter @sellright/sample-plugin pack --pack-destination "$OUT"

pnpm --dir "$ROOT/packages/admin" build
node "$ROOT/packages/api/scripts/write-build-info.mjs" "$ROOT/packages/admin/dist/BUILD-INFO.json"
VERSION="$(node -p "require('$ROOT/packages/api/package.json').version")"
tar -czf "$OUT/sellright-admin-bundle-$VERSION.tgz" -C "$ROOT/packages/admin" dist
echo "artifacts:"; ls -1 "$OUT"
