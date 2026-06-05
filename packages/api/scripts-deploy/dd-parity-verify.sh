#!/usr/bin/env bash
# Verify DD-parity features: order export, tracking import, pre-order filter,
# affiliate onboard->order->commission->settle.
set -euo pipefail
EMAIL="${1:?email}"
PW="${ADMIN_PASSWORD:?set ADMIN_PASSWORD env}"
export PNPM_HOME="$HOME/.local/share/pnpm"; export PATH="$PNPM_HOME:$PATH"

cd ~/sites/sellright
echo "[1] pull + restart API + rebuild admin"
git pull --ff-only | tail -1; git rev-parse --short HEAD
bash ~/start-api.sh >/dev/null 2>&1
cd packages/admin && pnpm install --ignore-workspace >/dev/null 2>&1 && pnpm build >/dev/null 2>&1
bash ~/start-admin.sh >/dev/null 2>&1 || true; sleep 3
curl -s -o /dev/null -w "  api=%{http_code} " http://127.0.0.1:3300/v1/health; curl -s -o /dev/null -w "spa=%{http_code}\n" http://127.0.0.1:4300/

get() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log($1)})"; }
SS=(-H 'x-store-slug: damned' -H 'content-type: application/json')
T="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/login "${SS[@]}" -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" | get 'j.token')"
AH=(-H "authorization: Bearer $T" -H 'x-store-slug: damned' -H 'content-type: application/json')

echo "[2] order export (CSV)"
curl -s "http://127.0.0.1:3300/v1/admin/export/orders?days=365" "${AH[@]}" | head -2 | sed 's/^/    /'

echo "[3] tracking import on a Paid order"
PAID="$(curl -s "http://127.0.0.1:3300/v1/admin/orders?state=Paid&pageSize=1" "${AH[@]}" | get 'j.items[0]?.code||""')"
echo "    paid order=$PAID"
curl -s -X POST http://127.0.0.1:3300/v1/admin/import-tracking "${AH[@]}" -d "{\"rows\":[{\"code\":\"$PAID\",\"tracking\":\"1Z999AA10123456784\"}]}" | get '"    import: updated="+j.updated+" errors="+j.errors.length'

echo "[4] pre-order filter"
curl -s "http://127.0.0.1:3300/v1/admin/orders?preOrder=1&pageSize=1" "${AH[@]}" | get '"    pre-order count="+j.total'

echo "[5] affiliate: onboard -> order with their coupon -> commission -> settle"
ACODE="AFF$(date +%s | tail -c 5)"
AFF="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/affiliates "${AH[@]}" -d "{\"email\":\"aff-$ACODE@test.local\",\"code\":\"$ACODE\",\"discountPct\":10}")"
AID="$(echo "$AFF" | get 'j.id')"; ATOK="$(echo "$AFF" | get 'j.accessToken')"
echo "    affiliate id=$AID code=$ACODE token=${ATOK:0:8}…"
# in-stock sku
SKU="$(curl -s "http://127.0.0.1:3300/v1/admin/inventory?pageSize=50" "${AH[@]}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const v=j.items.find(x=>x.available>1);console.log(v?v.sku:'')})")"
SA='{"fullName":"Aff Buyer","streetLine1":"1 St","city":"T","province":"CA","postalCode":"90001","countryCode":"US"}'
OCODE="$(curl -s -X POST http://127.0.0.1:3300/v1/shop/checkout "${SS[@]}" -d "{\"items\":[{\"sku\":\"$SKU\",\"quantity\":1}],\"couponCode\":\"$ACODE\",\"email\":\"affbuyer@test.local\",\"shippingAddress\":$SA}" | get 'j.code')"
curl -s -X POST "http://127.0.0.1:3300/v1/shop/orders/$OCODE/pay" "${SS[@]}" -d '{"method":"cod"}' >/dev/null
echo "    order $OCODE placed with coupon $ACODE + paid (cod)"
curl -s "http://127.0.0.1:3300/v1/admin/affiliates/$AID" "${AH[@]}" | get '"    affiliate detail: orders="+j.orders.length+" earned="+j.earned+" unsettled="+j.unsettled'
echo "    public dashboard (token):"
curl -s "http://127.0.0.1:3300/v1/shop/affiliate?t=$ATOK" "${SS[@]}" | get '"      "+JSON.stringify({code:j.code,earned:j.earned,orders:j.orders})'
curl -s -X POST "http://127.0.0.1:3300/v1/admin/affiliates/$AID/settle" "${AH[@]}" -d '{"txRef":"verify-payout"}' | get '"    settle: paid="+j.settled'
echo "DONE"
