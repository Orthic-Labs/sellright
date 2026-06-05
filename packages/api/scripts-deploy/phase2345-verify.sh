#!/usr/bin/env bash
# Deploy + verify Phases 2-5: pull, migrate 0010, assert-rls, restart API,
# rebuild admin SPA, exercise the new endpoints, clean up test rows.
set -euo pipefail
EMAIL="${1:?email}"
PW="${ADMIN_PASSWORD:?set ADMIN_PASSWORD env}"
SKU="${2:-759382993416}"
export PNPM_HOME="$HOME/.local/share/pnpm"; export PATH="$PNPM_HOME:$PATH"

cd ~/sites/sellright
echo "[1] pull"; git pull --ff-only | tail -1; git rev-parse --short HEAD
if [ -f "$HOME/.sellright/env" ]; then source "$HOME/.sellright/env"
else APIPID="$(pgrep -f 'src/index.ts' | head -1)"; DATABASE_URL_OWNER="$(tr '\0' '\n' < /proc/$APIPID/environ | grep '^DATABASE_URL=' | cut -d= -f2-)"; DATABASE_URL_APP="$DATABASE_URL_OWNER"; fi
cd packages/api

echo "[2] migrate (OWNER) + assert-rls"
DATABASE_URL="$DATABASE_URL_OWNER" pnpm db:migrate 2>&1 | tail -2
DATABASE_URL="$DATABASE_URL_OWNER" pnpm db:assert-rls

echo "[3] restart API"
pkill -f 'src/index.ts' 2>/dev/null || true; sleep 2; fuser -k 3300/tcp 2>/dev/null || true; sleep 1
DATABASE_URL="$DATABASE_URL_APP" PORT=3300 nohup pnpm exec tsx src/index.ts > ~/sites/sellright/api.log 2>&1 & disown
sleep 5; curl -s http://127.0.0.1:3300/v1/health; echo

echo "[4] rebuild admin SPA"
cd ../admin && pnpm install --ignore-workspace >/dev/null 2>&1 && pnpm build >/dev/null 2>&1
bash ~/start-admin.sh >/dev/null 2>&1 || true; sleep 4
curl -s -o /dev/null -w "  spa=%{http_code}\n" http://127.0.0.1:4300/

get() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log($1)})"; }
SS=(-H 'x-store-slug: damned' -H 'content-type: application/json')
T="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/login "${SS[@]}" -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" | get 'j.token')"
AH=(-H "authorization: Bearer $T" -H 'x-store-slug: damned' -H 'content-type: application/json')

echo "[5] draft order (markPaid) -> refund partial"
DCODE="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/draft-orders "${AH[@]}" -d "{\"items\":[{\"sku\":\"$SKU\",\"quantity\":1}],\"email\":\"draft@test.local\",\"markPaid\":true}" | get 'j.code')"
echo "  draft order=$DCODE (paid)"
curl -s -X POST "http://127.0.0.1:3300/v1/admin/orders/$DCODE/refund" "${AH[@]}" -d '{"amount":500,"restock":true}' | get '"  refund: state="+j.state+" refunded="+j.refunded'

echo "[6] abandoned carts"
curl -s "http://127.0.0.1:3300/v1/admin/abandoned-carts" "${AH[@]}" | get '"  abandoned total="+j.total'

echo "[7] promotions create + list"
PCODE="VERIFY$(date +%s | tail -c 5)"
PID="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/promotions "${AH[@]}" -d "{\"code\":\"$PCODE\",\"type\":\"percentage\",\"value\":1000}" | get 'j.id')"
curl -s "http://127.0.0.1:3300/v1/admin/promotions" "${AH[@]}" | get '"  promotions="+j.items.length'

echo "[8] settings: store + payments toggle + shipping method"
curl -s "http://127.0.0.1:3300/v1/admin/settings/store" "${AH[@]}" | get '"  store: "+j.name+" tax="+j.taxRate+" payments="+JSON.stringify(j.payments)'
curl -s -X PATCH "http://127.0.0.1:3300/v1/admin/settings/payments" "${AH[@]}" -d '{"stripe":true}' | get '"  payments after toggle="+JSON.stringify(j.payments)'
SMID="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/shipping-methods "${AH[@]}" -d '{"code":"vtest","name":"Verify Standard","calculator":{"flat":700}}' | get 'j.id')"
curl -s "http://127.0.0.1:3300/v1/admin/shipping-methods" "${AH[@]}" | get '"  shipping methods="+j.items.length'

echo "[9] staff list + reports + search + activity + customer create"
curl -s "http://127.0.0.1:3300/v1/admin/staff" "${AH[@]}" | get '"  staff="+j.items.length'
curl -s "http://127.0.0.1:3300/v1/admin/reports/sales?days=30" "${AH[@]}" | get '"  sales 30d: rev="+j.totalRevenue+" orders="+j.totalOrders+" points="+j.series.length'
curl -s "http://127.0.0.1:3300/v1/admin/reports/top-products?days=90" "${AH[@]}" | get '"  top products="+j.items.length'
curl -s "http://127.0.0.1:3300/v1/admin/search?q=SR" "${AH[@]}" | get '"  search SR: orders="+j.orders.length+" products="+j.products.length+" customers="+j.customers.length'
curl -s "http://127.0.0.1:3300/v1/admin/activity?limit=5" "${AH[@]}" | get '"  activity events="+j.items.length'
NCID="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/customers "${AH[@]}" -d '{"email":"newcust@test.local","firstName":"New"}' | get 'j.id')"
curl -s -X PATCH "http://127.0.0.1:3300/v1/admin/customers/$NCID" "${AH[@]}" -d '{"tags":["vip","verify"]}' -o /dev/null -w "  customer create+tag=%{http_code}\n"
curl -s "http://127.0.0.1:3300/v1/admin/marketing/config" "${AH[@]}" | get '"  listmonk configured="+j.configured'

echo "[10] cleanup"
curl -s -X DELETE "http://127.0.0.1:3300/v1/admin/promotions/$PID" "${AH[@]}" -o /dev/null -w "  del_promo=%{http_code}\n"
curl -s -X DELETE "http://127.0.0.1:3300/v1/admin/shipping-methods/$SMID" "${AH[@]}" -o /dev/null -w "  del_shipping=%{http_code}\n"
curl -s -X PATCH "http://127.0.0.1:3300/v1/admin/settings/payments" "${AH[@]}" -d '{"stripe":false}' -o /dev/null -w "  revert_stripe=%{http_code}\n"
echo "DONE"
