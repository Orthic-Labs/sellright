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
**M0 — skeleton.** Bootable API serving `/v1/health` + `/v1/openapi.json`; shared money primitives; Drizzle `store` table proving the migration pipeline. See `docs/BUILD-PLAN-RH-v1.md` for M1→M9.

Plans: `docs/ARCHITECTURE-PLAN-v1.md`, `docs/BUILD-PLAN-RH-v1.md`, `docs/DD-CUSTOMIZATION-SPEC-v1.md`.
