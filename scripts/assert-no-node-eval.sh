#!/usr/bin/env bash
# Guard: no inline `node -e` / `--eval` / `-p` / `--print` in the storefront build chain.
#
# The build chain (everything `pnpm install` / `pnpm build` runs for packages/storefront and
# packages/storefront-client) must call checked-in scripts, never eval'd source: quoting differs per shell and
# platform, and an eval'd one-liner can't be tested or reviewed like a file. Scope: the two package.json files and
# both scripts/ directories. Out of scope (not part of the chain): .github/workflows, Dockerfile healthchecks,
# repo-root scripts/ and ops/cutover/**.
#
# Usage:
#   bash scripts/assert-no-node-eval.sh              scan the repo this script lives in
# Test hook: ASSERT_NO_NODE_EVAL_ROOT=<dir> scans <dir> (same relative layout) instead.
set -euo pipefail

ROOT="${ASSERT_NO_NODE_EVAL_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# `node`, then any number of option tokens (a few take a separate value), then an eval flag.
# Positional arguments (a script path) end the match, so `node build.mjs --print` is not a hit.
OPT_WITH_VALUE='(-r|--require|--import|--loader|--experimental-loader|--env-file|--conditions|-C)[[:space:]]+[^[:space:]]+'
OPT='-[^[:space:]]+'
EVAL_FLAG='(-e|-p|-pe|-ep|--eval|--print)'
PATTERN="(^|[^A-Za-z0-9_./-])node(js)?[[:space:]]+(($OPT_WITH_VALUE|$OPT)[[:space:]]+)*$EVAL_FLAG([^A-Za-z0-9_-]|\$)"

targets=(
  "packages/storefront/package.json"
  "packages/storefront-client/package.json"
  "packages/storefront/scripts"
  "packages/storefront-client/scripts"
)

FAIL=0
for t in "${targets[@]}"; do
  path="$ROOT/$t"
  if [ ! -e "$path" ]; then
    echo "assert-no-node-eval: missing scan target $t" >&2
    FAIL=1
    continue
  fi
  hits=$(grep -rnE --exclude-dir=node_modules "$PATTERN" "$path" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "assert-no-node-eval: inline node eval in $t:"
    echo "${hits//$ROOT\//}"
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "assert-no-node-eval: FAILED — replace the eval'd one-liner with a checked-in script (see packages/storefront/scripts/clean.mjs)"
  exit 1
fi
echo "assert-no-node-eval: OK"
