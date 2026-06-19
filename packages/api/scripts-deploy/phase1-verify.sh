#!/usr/bin/env bash
# Phase 1 deploy + verify: pull, restart API, rebuild admin SPA, exercise the new
# catalog endpoints (product create, add variant, collection create+assign,
# inventory), then clean up the test rows.
set -euo pipefail
EMAIL="${1:?email}"
PW="${ADMIN_PASSWORD:?set ADMIN_PASSWORD env}"
export PNPM_HOME="$HOME/.local/share/pnpm"; export PATH="$PNPM_HOME:$PATH"

cd ~/sites/sellright
echo "[1] pull"; git pull --ff-only | tail -1; git rev-parse --short HEAD

# DB env (owner-only mode if no app role yet)
if [ -f "$PWD/packages/api/.env" ]; then source "$PWD/packages/api/.env"; APP_URL="${DATABASE_URL:-}"
else APIPID="$(pgrep -f 'src/index.ts' | head -1)"; APP_URL="$(tr '\0' '\n' < /proc/$APIPID/environ | grep '^DATABASE_URL=' | cut -d= -f2-)"; fi

echo "[2] restart API"
cd packages/api
pkill -f 'src/index.ts' 2>/dev/null || true; sleep 2; fuser -k 3300/tcp 2>/dev/null || true; sleep 1
DATABASE_URL="$APP_URL" PORT="${PORT:-3300}" nohup pnpm exec tsx src/index.ts > ~/sites/sellright/api.log 2>&1 & disown
sleep 5
curl -s http://127.0.0.1:3300/v1/health; echo

echo "[3] rebuild + restart admin SPA"
cd ../admin && pnpm install --ignore-workspace >/dev/null 2>&1 && pnpm build >/dev/null 2>&1
bash ~/start-admin.sh >/dev/null 2>&1 || true; sleep 4
curl -s -o /dev/null -w "  spa=%{http_code}\n" http://127.0.0.1:4300/

get() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log($1)})"; }
SS=(-H 'x-store-slug: damned' -H 'content-type: application/json')
T="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/login "${SS[@]}" -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" | get 'j.token')"
AH=(-H "authorization: Bearer $T" -H 'x-store-slug: damned' -H 'content-type: application/json')

echo "[4] create product"
PID="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/products "${AH[@]}" -d '{"name":"Phase1 Test Knife","status":"active"}' | get 'j.id')"
echo "  product=$PID"
echo "[5] add variant"
VID="$(curl -s -X POST "http://127.0.0.1:3300/v1/admin/products/$PID/variants" "${AH[@]}" -d '{"sku":"PH1-TEST-001","name":"Default","price":12900,"onHand":7}' | get 'j.id')"
echo "  variant=$VID"
echo "[6] product detail shows the variant"
curl -s "http://127.0.0.1:3300/v1/admin/products/$PID" "${AH[@]}" | get 'JSON.stringify({name:j.name,variants:j.variants.map(v=>({sku:v.sku,price:v.price,onHand:v.onHand,available:v.available}))})'

echo "[7] create collection + assign product"
CID="$(curl -s -X POST http://127.0.0.1:3300/v1/admin/collections "${AH[@]}" -d '{"name":"Phase1 Test Collection"}' | get 'j.id')"
curl -s -X POST "http://127.0.0.1:3300/v1/admin/collections/$CID/products" "${AH[@]}" -d "{\"productId\":\"$PID\"}" -o /dev/null -w "  assign_http=%{http_code}\n"
curl -s "http://127.0.0.1:3300/v1/admin/collections/$CID" "${AH[@]}" | get '"  collection has "+j.products.length+" product(s): "+(j.products[0]?.name||"-")'

echo "[8] inventory shows the new variant"
curl -s "http://127.0.0.1:3300/v1/admin/inventory?q=PH1-TEST" "${AH[@]}" | get '"  inventory match: "+(j.items[0]?(j.items[0].sku+" avail="+j.items[0].available):"none")'

echo "[9] cleanup test rows"
curl -s -X DELETE "http://127.0.0.1:3300/v1/admin/collections/$CID" "${AH[@]}" -o /dev/null -w "  del_collection=%{http_code}\n"
curl -s -X DELETE "http://127.0.0.1:3300/v1/admin/products/$PID" "${AH[@]}" -o /dev/null -w "  del_product=%{http_code}\n"
echo "DONE"
