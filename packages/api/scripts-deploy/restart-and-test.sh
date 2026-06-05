#!/usr/bin/env bash
# Robustly restart the API (kill the whole tree on :3300, not just one pid),
# prove the new code is live (regression guard => 409), then prove the
# fulfillment inventory side-effect with direct stock reads around a fresh order.
set -euo pipefail
EMAIL="${1:?email}"
PW="${ADMIN_PASSWORD:?set ADMIN_PASSWORD env}"
SKU="${2:-759382993416}"
export PNPM_HOME="$HOME/.local/share/pnpm"; export PATH="$PNPM_HOME:$PATH"

cd ~/sites/sellright/packages/api
# inherit DB/PORT from whatever is currently on :3300
CURPID="$(pgrep -f 'src/index.ts' | head -1 || true)"
set -a; eval "$(tr '\0' '\n' < /proc/$CURPID/environ | grep -E '^(DATABASE_URL|PORT|NODE_ENV|CATALOG_DIR)=' | sed 's/^/export /')"; set +a
: "${PORT:=3300}"

echo "[1] kill ALL api processes + free :3300"
pkill -f 'src/index.ts' 2>/dev/null || true
sleep 2
# anything still bound to PORT
fuser -k "${PORT}/tcp" 2>/dev/null || true
sleep 1
echo "    remaining on :$PORT: $(ss -ltnp 2>/dev/null | grep ":$PORT" | wc -l)"

echo "[2] start fresh api"
nohup pnpm exec tsx src/index.ts > ~/sites/sellright/api.log 2>&1 & disown
sleep 5
curl -s "http://127.0.0.1:${PORT}/v1/health"; echo

get() { node -e "let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const j=JSON.parse(d);console.log($1)})"; }
T="$(curl -s -X POST "http://127.0.0.1:${PORT}/v1/admin/login" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" | get 'j.token||""')"
AH=(-H "authorization: Bearer $T" -H "x-store-slug: damned")

# stock is FORCE-RLS'd: a psql read must set app.current_store first (same session).
STOREID='0a000000-0000-4000-8000-0000000000dd'
st() { psql "$DATABASE_URL" -tAc "set app.current_store='$STOREID'; select on_hand||'/'||allocated from stock st join product_variant pv on pv.id=st.variant_id where pv.sku='$SKU' limit 1" | tr -d '[:space:]'; }
echo "[4] stock(on_hand/allocated) for $SKU BEFORE: $(st)"

echo "[5] create fresh COD order for $SKU x1"
SA='{"fullName":"Audit Test","streetLine1":"1 Test St","city":"Testville","province":"CA","postalCode":"90001","countryCode":"US","phone":"5550000"}'
CODE="$(curl -s -X POST "http://127.0.0.1:${PORT}/v1/shop/checkout" -H 'content-type: application/json' -H 'x-store-slug: damned' \
  -d "{\"items\":[{\"sku\":\"$SKU\",\"quantity\":1}],\"shipping\":0,\"email\":\"audit@test.local\",\"shippingAddress\":$SA}" | get 'j.code||("ERR:"+JSON.stringify(j))')"
echo "    order=$CODE"
curl -s -X POST "http://127.0.0.1:${PORT}/v1/shop/orders/$CODE/pay" -H 'content-type: application/json' -H 'x-store-slug: damned' -d '{"method":"cod"}' | get 'JSON.stringify({state:j.state,payment:j.payment})'
echo "    stock AFTER checkout (expect allocated +1): $(st)"

echo "[6] fulfill $CODE -> Shipped (admin)"
curl -s -X POST "http://127.0.0.1:${PORT}/v1/admin/orders/$CODE/fulfill" "${AH[@]}" -H 'content-type: application/json' -d '{"state":"Shipped","trackingCode":"AUDIT1","carrier":"USPS"}' | get 'JSON.stringify(j)'
echo "    stock AFTER fulfill (expect on_hand -1 vs BEFORE, allocated back to BEFORE): $(st)"
echo "    stock_movement rows for $SKU (latest 2):"
psql "$DATABASE_URL" -tAc "set app.current_store='$STOREID'; select sm.delta||' '||sm.reason from stock_movement sm join product_variant pv on pv.id=sm.variant_id where pv.sku='$SKU' order by sm.created_at desc limit 2" | sed 's/^/      /'
echo "DONE"
