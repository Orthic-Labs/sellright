# @sellright/admin — admin SPA

Thin Shopify-style operator console for SellRight. **Built and deployed** (not a
placeholder).

## Stack

- React 18 + Vite 5 + TypeScript
- Tailwind (light theme, copper-free; `brand` green `#008060` accent)
- TanStack Query (data) + react-router-dom (routing)
- **Hand-rolled fetch client** (`src/api.ts`) — NOT the hono `hc` client. The
  session token lives in an httpOnly `sr_admin` cookie, mutations echo the
  non-httpOnly CSRF cookie in `x-csrf-token`, and only the active store slug is
  kept in `localStorage`.

## Toolchain isolation

Standalone — **excluded from the pnpm workspace** (`!packages/admin` in
`pnpm-workspace.yaml`), with its own lockfile, exactly like the storefront. Its
React deps cannot disturb the api/shared build. Install with
`pnpm install --ignore-workspace`.

## Pages (30)

- **Login** — admin email/password, optional TOTP, httpOnly cookie session
- **Dashboard** — KPIs (revenue, orders, AOV, to-fulfill, customers, low-stock) + recent orders
- **Orders** — list (status filter, search, paginate)
- **OrderDetail** — fulfillment, tracking, cancel, refunds
- **DraftOrder** — create manual orders
- **ImportTracking** — bulk tracking CSV import
- **AbandonedCarts** — abandoned cart list
- **Products** — list
- **ProductDetail** — inline edit title/description/status; per-variant price/sale price/on-hand/active; featured image upload; gallery add/remove/promote-to-featured (WP8c, b93dae6); per-variant option assignment (option groups + toggle per variant, b93dae6)
- **ProductCreate** — create new product + initial variant
- **Collections** — list
- **CollectionDetail** — smart/manual collection edit
- **Inventory** — stock levels across variants
- **Customers** — list (orders + lifetime spend)
- **CustomerDetail** — orders, addresses, tags
- **Discounts** — promotions CRUD
- **Affiliates** — affiliate list
- **AffiliateDetail** — affiliate detail + settlements
- **Marketing** — Listmonk newsletter integration
- **Blog** — blog post list/edit
- **Reports** — sales, top products, customer write, global search
- **Activity** — audit log
- **Returns** — return/RMA list and approval
- **GiftCards** — gift card list
- **Locations** — multi-location inventory
- **Webhooks** — webhook endpoint management
- **TaxZones** — tax zone configuration
- **Staff** — staff list, roles, invitations; per-action permission matrix
- **CurrencyRates** — currency exchange rate management
- **Settings** — store/tax, payment toggles, shipping methods, Google sign-in client id, notifications, 2FA

A multi-store switcher (top bar) sets the active store; all data is store-scoped
server-side via RLS.

## Dev / serve

Needs the SellRight API running on `:3300` (the dev server proxies `/v1` → API
and `/assets` → DD's image server).

```bash
pnpm install --ignore-workspace
pnpm dev          # vite dev server on :4300 (proxy-enabled)
pnpm build        # tsc + vite build -> dist/
```

Root-level helpers (run from repo root):

```bash
pnpm admin:typecheck   # pnpm --dir packages/admin typecheck
pnpm admin:build       # pnpm --dir packages/admin build
pnpm verify            # includes admin typecheck + build
```

For production, serve the built `dist/` directory behind the site proxy. Use
`pnpm dev` only for local/dev environments where the Vite proxy is needed.

## Known gaps (as of commit 43ebcbb)

The following are now wired (no longer gaps):
- **Gallery management** — `ProductDetail` adds/removes/promotes gallery images via `product_asset` (WP8c, commit b93dae6).
- **Per-variant option assignment** — `OptionsEditor` in `ProductDetail` toggles options per variant via `PUT /variants/{variantId}/options` (commit b93dae6).

Remaining gaps:
- **Media library** — there is no standalone asset browser/picker; images are uploaded inline on the product page only.
- **Production admin host** — deployment is environment-specific; keep the
  production path on built static assets, not the Vite dev server.
- **Real gateway/payment operations** — Stripe scaffolding exists in the API; no payment UI actions in the admin beyond toggling the provider.
- **Gateway-backed refund UI** — the return-approval flow writes a Settled ledger row but does not call the payment gateway (ra-002).
