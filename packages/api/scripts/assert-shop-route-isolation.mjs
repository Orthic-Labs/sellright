// Gate (ra-003): shop-surface route files must NOT import the unscoped DB client.
//
// `unsafeUnscopedDb` bypasses FORCE RLS. That is acceptable ONLY for the
// admin-registry tables that are deliberately RLS-exempt (admin_user,
// admin_user_store, staff_invite, session) — which is why admin-settings.ts and
// admin-marketing.ts legitimately use it. But on any customer- or
// public-reachable route it is a cross-tenant RLS-bypass risk.
//
// The WP1.3 rename made the unsafe client conspicuous; this turns it into a
// verify gate so a regression can't ship. Wired into `pnpm verify`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROUTES = fileURLToPath(new URL('../src/routes/', import.meta.url));

// Every shop-surface / public route a customer or unauthenticated request reaches.
const SHOP_ROUTES = [
  'account.ts',
  'auth.ts',
  'cart.ts',
  'catalog.ts',
  'checkout.ts',
  'customer-tokens.ts',
  'orders.ts',
  'pay.ts',
  'shop-extra.ts',
  'apps.ts',
  'payment-webhooks.ts',
];

const offenders = [];
for (const f of SHOP_ROUTES) {
  let src;
  try {
    src = readFileSync(ROUTES + f, 'utf8');
  } catch {
    continue; // renamed/removed — skip rather than false-fail
  }
  if (/unsafeUnscopedDb/.test(src)) offenders.push(f);
}

if (offenders.length) {
  console.error(
    '[assert-shop-route-isolation] FAIL — shop-surface routes must not import unsafeUnscopedDb (RLS bypass):\n  ' +
      offenders.join('\n  ') +
      '\n  Use withStore(storeId, ...) instead. Admin-registry access belongs in admin-* routes only.',
  );
  process.exit(1);
}
console.log(`[assert-shop-route-isolation] OK — ${SHOP_ROUTES.length} shop routes free of the unscoped DB client`);
