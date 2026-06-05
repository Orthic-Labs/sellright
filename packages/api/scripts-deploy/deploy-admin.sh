#!/usr/bin/env bash
# One-shot admin deploy on Hetzner: pull, migrate, seed admin, restart API,
# smoke the admin endpoints. Inherits the live API's DB/PORT env from its proc
# so no secrets are passed on the command line.
set -euo pipefail
ADMIN_EMAIL="${1:?email}"
ADMIN_PW="${2:?password}"

# pnpm is installed standalone (not on the non-interactive PATH); add it.
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"
command -v pnpm >/dev/null || { echo "FATAL: pnpm not found at $PNPM_HOME" >&2; exit 1; }

cd ~/sites/sellright

APIPID="$(pgrep -f 'src/index.ts' | head -1 || true)"
if [ -z "$APIPID" ]; then echo "FATAL: api process (src/index.ts) not found" >&2; exit 1; fi

# Inherit DATABASE_URL / PORT / NODE_ENV from the running API (no echo of secrets).
set -a
eval "$(tr '\0' '\n' < /proc/$APIPID/environ | grep -E '^(DATABASE_URL|PORT|NODE_ENV|CATALOG_DIR)=' | sed 's/^/export /')"
set +a
: "${PORT:=3300}"

echo "[1/6] repo before: $(git rev-parse --short HEAD)"
git pull --ff-only
echo "[1/6] repo after:  $(git rev-parse --short HEAD)"

cd packages/api

echo "[2/6] migrate"
pnpm db:migrate

echo "[3/6] seed admin ($ADMIN_EMAIL)"
pnpm exec tsx src/scripts/seed-admin.ts "$ADMIN_EMAIL" "$ADMIN_PW"

echo "[4/6] restart api (pid $APIPID -> new)"
kill "$APIPID" 2>/dev/null || true
sleep 1
nohup pnpm exec tsx src/index.ts > ~/sites/sellright/api.log 2>&1 &
disown
sleep 4

echo "[5/6] health"
curl -s "http://127.0.0.1:${PORT}/v1/health"; echo

echo "[6/6] admin login smoke"
TOKEN="$(curl -s -X POST "http://127.0.0.1:${PORT}/v1/admin/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).token||"")}catch{console.log("")}})')"
if [ -z "$TOKEN" ]; then echo "LOGIN FAILED"; exit 1; fi
echo "login OK (token ${TOKEN:0:8}…)"

STORE="$(curl -s "http://127.0.0.1:${PORT}/v1/admin/me" -H "authorization: Bearer $TOKEN" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.stores?.[0]?.slug||"")})')"
echo "default store: $STORE"

echo "--- dashboard ---"
curl -s "http://127.0.0.1:${PORT}/v1/admin/dashboard" -H "authorization: Bearer $TOKEN" -H "x-store-slug: $STORE" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(JSON.stringify({revenue:j.revenue,orders:j.orders,aov:j.aov,pendingFulfillment:j.pendingFulfillment,customers:j.customers,lowStock:j.lowStock,recent:j.recentOrders?.length}))})'

echo "--- orders (page 1) ---"
curl -s "http://127.0.0.1:${PORT}/v1/admin/orders?page=1&pageSize=3" -H "authorization: Bearer $TOKEN" -H "x-store-slug: $STORE" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log("total="+j.total, "first="+(j.items?.[0]?.code||"-"), (j.items?.[0]?.state||""))})'

echo "--- products (page 1) ---"
curl -s "http://127.0.0.1:${PORT}/v1/admin/products?page=1&pageSize=3" -H "authorization: Bearer $TOKEN" -H "x-store-slug: $STORE" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log("total="+j.total, "first="+(j.items?.[0]?.name||"-"))})'

echo "--- customers (page 1) ---"
curl -s "http://127.0.0.1:${PORT}/v1/admin/customers?page=1&pageSize=3" -H "authorization: Bearer $TOKEN" -H "x-store-slug: $STORE" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log("total="+j.total, "first="+(j.items?.[0]?.email||"-"))})'

echo "DONE"
