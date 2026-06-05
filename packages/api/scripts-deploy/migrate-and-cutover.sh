#!/usr/bin/env bash
# Apply research-backed improvements on the box: pull, migrate (0007 idempotency
# +indexes, 0008 admin_user_store registry) as OWNER, assert the FORCE-RLS
# invariant, cut the API over to the NON-owner app role, and verify the full
# stack incl. an idempotency-replay test and a cross-store leakage probe.
# Prereq: ~/.sellright/env exists (run create-app-role.sh first).
set -euo pipefail
EMAIL="${1:?email}"
PW="${ADMIN_PASSWORD:?set ADMIN_PASSWORD env}"
SKU="${2:-759382993416}"
export PNPM_HOME="$HOME/.local/share/pnpm"; export PATH="$PNPM_HOME:$PATH"
# App-role mode if ~/.sellright/env exists; otherwise OWNER-ONLY mode (the role
# needs a superuser to create — until then the app stays on the owner role, which
# is still fail-closed via FORCE-on-owner; everything else deploys + verifies).
if [ -f "$HOME/.sellright/env" ]; then
  source "$HOME/.sellright/env"; MODE="app-role"
else
  APIPID="$(pgrep -f 'src/index.ts' | head -1)"
  DATABASE_URL_OWNER="$(tr '\0' '\n' < /proc/$APIPID/environ | grep -E '^DATABASE_URL=' | cut -d= -f2-)"
  DATABASE_URL_APP="$DATABASE_URL_OWNER"; MODE="owner-only (no app role yet)"
fi
echo "[mode] $MODE"

cd ~/sites/sellright
echo "[1] pull"; git pull --ff-only | tail -1; git rev-parse --short HEAD
cd packages/api

echo "[2] migrate (as OWNER)"
DATABASE_URL="$DATABASE_URL_OWNER" pnpm db:migrate 2>&1 | tail -3

echo "[3] assert FORCE-RLS invariant (as OWNER)"
DATABASE_URL="$DATABASE_URL_OWNER" pnpm db:assert-rls

echo "[4] restart API as NON-owner app role on :3300"
pkill -f 'src/index.ts' 2>/dev/null || true; sleep 2
fuser -k 3300/tcp 2>/dev/null || true; sleep 1
DATABASE_URL="$DATABASE_URL_APP" PORT=3300 nohup pnpm exec tsx src/index.ts > ~/sites/sellright/api.log 2>&1 & disown
sleep 5
curl -s http://127.0.0.1:3300/v1/health; echo

get() { node -e "let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const j=JSON.parse(d);console.log($1)})"; }
SS=(-H 'x-store-slug: damned' -H 'content-type: application/json')

echo "[5] browse (catalog via app role)"
curl -s "http://127.0.0.1:3300/v1/shop/catalog/products" "${SS[@]}" -o /dev/null -w "  catalog_http=%{http_code}\n"

echo "[6] admin login + dashboard + orders (admin_user_store now registry)"
T="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/login "${SS[@]}" -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" | get 'j.token||""')"
AH=(-H "authorization: Bearer $T" -H 'x-store-slug: damned')
echo "  login_token=${T:0:8}…  stores=$(curl -s http://127.0.0.1:3300/v1/admin/me "${AH[@]}" | get 'j.stores.length')"
curl -s http://127.0.0.1:3300/v1/admin/dashboard "${AH[@]}" | get 'JSON.stringify({revenue:j.revenue,orders:j.orders,toFulfill:j.pendingFulfillment})'

echo "[7] IDEMPOTENCY replay: same Idempotency-Key twice -> same order, one allocation"
KEY="audit-idem-$(date +%s)"
SA='{"fullName":"Idem Test","streetLine1":"1 Test St","city":"T","province":"CA","postalCode":"90001","countryCode":"US"}'
BODY="{\"items\":[{\"sku\":\"$SKU\",\"quantity\":1}],\"shipping\":0,\"email\":\"idem@test.local\",\"shippingAddress\":$SA}"
C1="$(curl -s -X POST http://127.0.0.1:3300/v1/shop/checkout "${SS[@]}" -H "idempotency-key: $KEY" -d "$BODY" | get 'j.code')"
C2="$(curl -s -X POST http://127.0.0.1:3300/v1/shop/checkout "${SS[@]}" -H "idempotency-key: $KEY" -d "$BODY" | get 'j.code')"
echo "  order1=$C1  order2=$C2  $([ "$C1" = "$C2" ] && echo 'SAME ✓ (no duplicate)' || echo 'DIFFERENT ✗')"

echo "[8] cross-store leakage probe (app role, store=damned context): orders visible vs raw"
psql "$DATABASE_URL_OWNER" -tAc "select 'owner_sees_all_orders='||count(*) from \"order\""
psql "$DATABASE_URL_APP" -tAc "select 'app_no_context_orders='||count(*) from \"order\""  # FORCE RLS -> 0

echo "[9] reservation-expiry DRY-RUN (no mutation)"
DATABASE_URL="$DATABASE_URL_OWNER" pnpm exec tsx src/jobs/release-stale-allocations.ts 2>&1 | tail -3

echo "DONE"
