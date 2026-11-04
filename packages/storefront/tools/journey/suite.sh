#!/usr/bin/env bash
# The #425 customer-journey suite against the live stores (no orders placed; carts are created and left to expire).
#   bash suite.sh [pairs=8]          needs node + puppeteer-core (npm i puppeteer-core in this folder) and Chrome (env CHROME)
# 1. correctness (cached + edge Worker path): two customers at once, cart change racing Checkout   -> PASS/FAIL, exit code
# 2. interleaved A/B per store: liveA = never-cached render (?sr_ab=1), liveB = edge-cached page + Worker
#    shop landing (products visible, LCP) and the journey product page -> add to cart -> Checkout -> total
# The deploy-tab check (a tab open across a deploy) runs around a deploy: node deploy-tab.mjs <origin> <pdp> "<opt>", deploy,
# then create the GO_FILE (default ./deploy-tab.go).
set -uo pipefail
cd "$(dirname "$0")"
PAIRS=${1:-8}
export MSYS_NO_PATHCONV=1
DD=https://www.damneddesigns.com; DD_PDP=/products/monsuta-bead/; DD_OPT='Titanium- Stonewashed'
RH=https://rottenhand.com; RH_PDP=/shop/longsleeveshirt/; RH_OPT='Medium|Midnight black'
fail=0
echo "== correctness (Damned, cached + Worker)"; node correctness.mjs "$DD" "$DD_PDP" "$DD_OPT" liveB || fail=1
for s in "$DD|$DD_PDP|$DD_OPT" "$RH|$RH_PDP|$RH_OPT"; do
  IFS='|' read -r origin pdp opt1 opt2 <<< "$s"; opts=$opt1${opt2:+|$opt2}
  echo "== shop landing A/B $origin"; node shop-ab.mjs "$origin" liveA liveB "$PAIRS" | sed -n '/^pairs=/,$p'
  echo "== journey A/B $origin"; node journey-ab.mjs "$origin" "$pdp" "$opts" liveA liveB "$PAIRS" | sed -n '/^pairs=/,$p'
done
exit $fail
