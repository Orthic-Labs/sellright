# @sellright/admin — admin SPA

Operator console for SellRight. It builds to a static bundle that the `admin`
service in `deploy/compose.yaml` serves with nginx.

## Stack

- React 19 + Vite 8 + TypeScript 6
- Tailwind CSS 4 (CSS-first, `src/index.css`) with runtime-swappable theme tokens (`src/theme-tokens.css`, `src/theme.tsx`; see [ADMIN-THEME-SYSTEM.md](../../docs/ADMIN-THEME-SYSTEM.md))
- TanStack Query (data) + react-router-dom (routing)
- **Hand-rolled fetch client** (`src/api.ts`) — NOT the hono `hc` client. The
  session token lives in an httpOnly `sr_admin` cookie, mutations echo the
  non-httpOnly `sr_csrf` cookie in `x-csrf-token`, and only the active store slug
  (`sr_admin_store`) and the theme choice (`sr-theme`, `sr-mode`) are kept in
  `localStorage`.

## Toolchain isolation

Standalone - **excluded from the pnpm workspace** (`!packages/admin` in the
root `pnpm-workspace.yaml`), with its own `pnpm-workspace.yaml` and lockfile. Its
React deps cannot disturb the api/shared build. Install from the repo root with
`pnpm --dir packages/admin install --frozen-lockfile` (the command CI uses).

## Pages

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
- **Staff** - staff list, roles, invitations; per-action permission matrix; agent API tokens (`AgentAccess`)
- **CurrencyRates** — currency exchange rate management
- **Settings** - store profile, payment provider toggles, taxes, shipping methods, customer Google sign-in, 2FA, team & permissions, account
- **PaymentsSettings** - payment provider credentials and mode (`/settings/payments`)
- **EmailSettings** - transactional email settings (`/settings/email`)
- **Seo** - SEO site settings and IndexNow (`/settings/seo`)
- **Subscriptions** - recurring subscriptions list
- **TrackingGrid** - add tracking to open paid orders in a grid (`/orders/tracking-grid`)
- **Waitlist** - demand report for out-of-stock waitlist signups
- **Loyalty** - points and rewards program settings
- **Reviews** - product review moderation and review settings
- **Setup** - install claim screen (`/setup`), shown while the install is unclaimed
- **Onboarding** - first-run country and currency confirmation after the claim (`/onboarding`)
- **AcceptInvite** - staff invite acceptance (`/accept-invite`)

A multi-store switcher (top bar) sets the active store; all data is store-scoped
server-side via RLS.

## Dev / serve

Needs the SellRight API running on `:3300` by default (`SELLRIGHT_API_ORIGIN`
overrides it; the dev server proxies `/v1` and `/assets` to it).

```bash
pnpm install --frozen-lockfile
pnpm dev          # vite dev server on :4300 (proxy-enabled)
pnpm qa:browser   # vite dev server on :4300 with API mocks; open /?qa=1
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

## Known gaps

Gallery management (`ProductDetail` adds, removes and promotes gallery images via `product_asset`) and per-variant option assignment (`OptionsEditor` in `ProductDetail`, `PUT /variants/{variantId}/options`) are wired.

Remaining gaps:
- **Media library** — there is no standalone asset browser/picker; images are uploaded inline on the product page only.
- **Production admin host** - the Compose stack serves the built static bundle with nginx (`packages/admin/Dockerfile`); do not use the Vite dev server in production.
