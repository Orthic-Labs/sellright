#!/usr/bin/env bash
# Prove the affiliate commission flow end-to-end with a freshly-restocked SKU.
set -euo pipefail
PW="${ADMIN_PASSWORD:?set ADMIN_PASSWORD env}"
get() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log($1)})"; }
SS=(-H 'x-store-slug: damned' -H 'content-type: application/json')
T="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/login "${SS[@]}" -d "{\"email\":\"adrdsouza@gmail.com\",\"password\":\"$PW\"}" | get 'j.token')"
AH=(-H "authorization: Bearer $T" -H 'x-store-slug: damned' -H 'content-type: application/json')

# Pick any variant, restock it to 50.
INV="$(curl -s 'http://127.0.0.1:3300/v1/admin/inventory?pageSize=1' "${AH[@]}")"
VID="$(echo "$INV" | get 'j.items[0].variantId')"
SKU="$(echo "$INV" | get 'j.items[0].sku')"
curl -s -X PATCH "http://127.0.0.1:3300/v1/admin/variants/$VID/stock" "${AH[@]}" -d '{"onHand":50}' >/dev/null
echo "restocked $SKU -> 50"

ACODE="AFFX$(date +%s | tail -c 4)"
AFF="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/affiliates "${AH[@]}" -d "{\"email\":\"$ACODE@test.local\",\"code\":\"$ACODE\",\"discountPct\":10}")"
AID="$(echo "$AFF" | get 'j.id')"
echo "affiliate $ACODE id=$AID"

SA='{"fullName":"B","streetLine1":"1 St","city":"T","province":"CA","postalCode":"90001","countryCode":"US"}'
OCODE="$(curl -s -X POST http://127.0.0.1:3300/v1/shop/checkout "${SS[@]}" -d "{\"items\":[{\"sku\":\"$SKU\",\"quantity\":1}],\"couponCode\":\"$ACODE\",\"email\":\"b@test.local\",\"shippingAddress\":$SA}" | get 'j.code+" disc="+j.discountTotal')"
echo "order=$OCODE"
ORD="$(echo "$OCODE" | cut -d' ' -f1)"
curl -s -X POST "http://127.0.0.1:3300/v1/shop/orders/$ORD/pay" "${SS[@]}" -d '{"method":"cod"}' | get '"pay state="+j.state'
curl -s "http://127.0.0.1:3300/v1/admin/affiliates/$AID" "${AH[@]}" | get '"affiliate: orders="+j.orders.length+" subtotals="+j.subtotals+" earned(10%)="+j.earned+" unsettled="+j.unsettled'
curl -s -X POST "http://127.0.0.1:3300/v1/admin/affiliates/$AID/settle" "${AH[@]}" -d '{"txRef":"payout-1"}' | get '"settle paid="+j.settled'
curl -s "http://127.0.0.1:3300/v1/admin/affiliates/$AID" "${AH[@]}" | get '"after settle: unsettled="+j.unsettled+" settled="+j.settled'
echo DONE
