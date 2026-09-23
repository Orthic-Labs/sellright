#!/usr/bin/env bash
set -euo pipefail

customer_file="src/providers/shop/customer/customer.ts"
manifest_file="dist/q-manifest.json"

# The legacy provider was removed during the SellRight migration. If restored,
# it must still be checked; absence is expected, not an ignored grep failure.
if [[ -f "$customer_file" ]] && grep -Eq "from ['\"]graphql-tag['\"]|gql\`" "$customer_file"; then
  echo "FAIL: runtime graphql-tag usage found in $customer_file"
  exit 1
fi

if [[ -f "$manifest_file" ]] && grep -q "src/providers/shop/customer/customer.ts" "$manifest_file"; then
  echo "FAIL: customer.ts appears in q-manifest bundle origins (runtime dependency leak)"
  exit 1
fi

echo "PASS: no legacy customer parser or manifest dependency"
