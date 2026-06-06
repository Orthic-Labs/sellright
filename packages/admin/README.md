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

## Pages

- **Login** — admin email/password, optional TOTP, httpOnly cookie session
- **Dashboard** — KPIs (revenue, orders, AOV, to-fulfill, customers, low-stock) + recent orders
- **Orders** — list (status filter, search, paginate) · detail · mark shipped (tracking) · mark delivered · cancel
- **Products** — list · detail with inline edit of title/description/status and per-variant price / sale price / on-hand stock / active
- **Customers** — list (orders + lifetime spend) · detail (orders, addresses)
- **Settings** — store/tax, payment toggles, shipping methods, staff roles,
  Google sign-in client id, notifications, and 2FA

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

On Hetzner it's launched via `packages/api/scripts-deploy/start-admin.sh` (vite
dev on `:4300`, setsid+nohup). **Do not use `:4200` — that's the Stunning
Strangers production store.** `vite preview` has no proxy, so use `dev` for a
working API connection.

## Known gaps (deferred)

No product image upload/media manager, no fine-grained per-action permission
matrix, no production admin host yet, and no real gateway/payment operations.
The admin is currently served by Vite behind an SSH tunnel.
