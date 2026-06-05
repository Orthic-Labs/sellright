#!/usr/bin/env bash
# Verify coupon-at-checkout: pick an enabled % coupon, place a COD order with it,
# assert discount applied + promotion_usage recorded + used_count bumped.
set -euo pipefail
SKU="${1:-759382993416}"
STORE='0a000000-0000-4000-8000-0000000000dd'
export PNPM_HOME="$HOME/.local/share/pnpm"; export PATH="$PNPM_HOME:$PATH"
APIPID="$(pgrep -f 'src/index.ts' | head -1)"
OWNER="$(tr '\0' '\n' < /proc/$APIPID/environ | grep '^DATABASE_URL=' | cut -d= -f2-)"
SS=(-H 'x-store-slug: damned' -H 'content-type: application/json')
get() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log($1)})"; }
q() { psql "$OWNER" -tAc "set app.current_store='$STORE'; $1" | tail -1; }

# A percentage coupon with no minimum / no verified-customer condition (applies cleanly).
CODE="$(q "select code from promotion where enabled=true and code is not null and type='percentage' and (conditions is null or conditions::text='[]' or conditions::text not like '%verified%') order by value desc limit 1")"
echo "coupon=$CODE"
USED_BEFORE="$(q "select used_count from promotion where code='$CODE'")"
echo "used_count before=$USED_BEFORE"

SA='{"fullName":"Coupon Test","streetLine1":"1 Test St","city":"T","province":"CA","postalCode":"90001","countryCode":"US"}'
BODY="{\"items\":[{\"sku\":\"$SKU\",\"quantity\":1}],\"shipping\":0,\"couponCode\":\"$CODE\",\"email\":\"coupon@test.local\",\"shippingAddress\":$SA}"
RESP="$(curl -s -X POST http://127.0.0.1:3300/v1/shop/checkout "${SS[@]}" -d "$BODY")"
echo "checkout resp: $RESP"
CODE_ORDER="$(echo "$RESP" | get 'j.code')"
DISC="$(echo "$RESP" | get 'j.discountTotal')"
APPLIED="$(echo "$RESP" | get 'j.couponApplied')"
echo "order=$CODE_ORDER discountTotal=$DISC couponApplied=$APPLIED"

echo "--- DB checks ---"
q "select 'order.promotion_id set='||(promotion_id is not null)::text from \"order\" where code='$CODE_ORDER'"
q "select 'promotion_usage_rows='||count(*) from promotion_usage pu join \"order\" o on o.id=pu.order_id where o.code='$CODE_ORDER'"
USED_AFTER="$(q "select used_count from promotion where code='$CODE'")"
echo "used_count after=$USED_AFTER (expect $((USED_BEFORE+1)))"

# Normalized address check: snapshot should use canonical line1/country.
q "select 'addr_line1='||(shipping_address->>'line1')||' addr_country='||(shipping_address->>'country') from \"order\" where code='$CODE_ORDER'"
echo "DONE"
