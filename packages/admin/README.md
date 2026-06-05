# @sellright/admin — admin SPA

Thin Shopify-style operator console for SellRight. **Built and deployed** (not a
placeholder).

## Stack

- React 18 + Vite 5 + TypeScript
- Tailwind (light theme, copper-free; `brand` green `#008060` accent)
- TanStack Query (data) + react-router-dom (routing)
- **Hand-rolled fetch client** (`src/api.ts`) — NOT the hono `hc` client. Bearer
  token + active store slug are kept in `localStorage` and sent as
  `Authorization` / `x-store-slug` headers on every `/v1/admin/*` request.

## Toolchain isolation

Standalone — **excluded from the pnpm workspace** (`!packages/admin` in
`pnpm-workspace.yaml`), with its own lockfile, exactly like the storefront. Its
React deps cannot disturb the api/shared build. Install with
`pnpm install --ignore-workspace`.

## Pages

- **Login** — admin email/password → session token
- **Dashboard** — KPIs (revenue, orders, AOV, to-fulfill, customers, low-stock) + recent orders
- **Orders** — list (status filter, search, paginate) · detail · mark shipped (tracking) · mark delivered · cancel
- **Products** — list · detail with inline edit of title/description/status and per-variant price / sale price / on-hand stock / active
- **Customers** — list (orders + lifetime spend) · detail (orders, addresses)
- **Settings** — account + accessible stores

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

No product/variant **create** or image upload (edit-existing only); no
discounts/shipping/tax config UI, refunds UI, or staff-user management UI. RBAC
is minimal — `read_only` is blocked from mutations server-side, but a full
per-action permission matrix is still TODO. Production admin host (nginx-fronted)
not yet set up; currently dev server behind an SSH tunnel.
