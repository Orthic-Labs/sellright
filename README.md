# SellRight

Owned, from-scratch commerce backend replacing Vendure — sellable/open-source and self-hosted, dogfooded on Damned Designs + Rotten Hand. Part of the Right suite.

## Stack
TypeScript · Hono + zod-openapi (typed REST + OpenAPI) · Drizzle + Postgres · multi-tenant (`store` + RLS) · BullMQ/Redis · SSE (cache-invalidation/order-status/stock) · static catalog manifest read path · `PaymentProvider` interface (NMI/Sezzle/Stripe, tokenized) · Qwik storefront · React/Shadcn admin.

## Layout
```
packages/
  shared/      zod + integer-cents money primitives (money-core foundation)
  api/         Hono API, Drizzle schema, OpenAPI at /v1/openapi.json
  admin/       React admin SPA            (scaffolded at M6)
  storefront/  Qwik SSR storefront        (migrated M2+)
docs/          architecture + build plan + DD customization spec
```

## Dev
```
pnpm install
pnpm --filter @sellright/api dev   # http://localhost:3100/v1/openapi.json
pnpm typecheck
pnpm build
```

## Status
Active backend MVP. Core API, multi-tenant schema/RLS, catalog import, checkout,
manual/COD payments, customer auth/account endpoints, and a Shopify-style admin
surface are implemented. Real gateway payments, storefront auth/account/search
rewire, production admin hosting, email flows, carrier fulfillment, and deeper
Shopify-parity features remain open.

Current state: `docs/STATE-AND-ROADMAP-v1.md`.
Backend audit: `docs/ECOMMERCE-BACKEND-AUDIT-2026-06-06.md`.

Plans: `docs/ARCHITECTURE-PLAN-v1.md`, `docs/BUILD-PLAN-RH-v1.md`, `docs/DD-CUSTOMIZATION-SPEC-v1.md`.
