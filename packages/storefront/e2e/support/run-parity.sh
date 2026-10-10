#!/usr/bin/env bash
# Runs the stock parity suite (and the harness smoke) with the API tap and the real publisher on, from the storefront
# package directory, and FAILS if any test was skipped: a skip is missing coverage, never a pass.
#
#   bash e2e/support/run-parity.sh [extra playwright args]
#
# Env passed through (all optional): E2E_RUN_DIR, E2E_API_DIR, E2E_SUPPORT_DIR, E2E_DB_NAME, STOCK_PARITY_BRAND.
# The harness creates and clears its own catalog dir and run dir; both default to fresh mktemp directories here.
# Build first (once per tree): VITE_SELLRIGHT_STORE_SLUG=e2e pnpm run e2e:build   (the slug matters only for the reader, A4).
set -euo pipefail
cd "$(dirname "$0")/../.."

RUN_DIR="${E2E_RUN_DIR:-$(mktemp -d)}"
CATALOG_DIR="${E2E_CATALOG_DIR:-$(mktemp -d)}"
LOG="$RUN_DIR/parity.log"
mkdir -p "$RUN_DIR"

set +e
E2E_API_TAP=1 E2E_RUN_DIR="$RUN_DIR" E2E_CATALOG_DIR="$CATALOG_DIR" \
  npx playwright test e2e/stock-parity.spec.ts e2e/harness-smoke.spec.ts "$@" 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
set -e

if grep -Eq '^[[:space:]]*[0-9]+ (skipped|did not run)' "$LOG"; then
  echo "run-parity: tests were SKIPPED — that is missing coverage, not a pass (see $LOG)" >&2
  exit 1
fi
exit "$status"
