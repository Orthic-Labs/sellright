# SellRight

Owned, from-scratch commerce backend for multi-brand operators. SellRight is a REST-first, Postgres-backed alternative to running separate Shopify/Vendure/WooCommerce-style backends per brand.

## Stack

TypeScript · Hono + zod-openapi · REST/OpenAPI · Drizzle + Postgres · multi-tenant `store` model + RLS · static catalog manifest read path · `PaymentProvider` interface · Qwik storefront consumer · React/Vite admin.

## Layout
```
packages/
  shared/      zod + integer-cents money primitives (money-core foundation)
  api/         Hono API, Drizzle schema, OpenAPI at /v1/openapi.json
  admin/       React admin SPA
  storefront/  Qwik SSR storefront
docs/          product docs
```

## Dev
```
pnpm install
pnpm --filter @sellright/api dev   # http://localhost:3300/v1/openapi.json
pnpm typecheck
pnpm build
```

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Features](docs/FEATURES.md)
- [Competitors](docs/COMPETITORS.md)
- [Market Placement](docs/MARKET-PLACEMENT.md)
- [Moat And Disruption](docs/MOAT-AND-DISRUPTION.md)
- [GTM](docs/GTM.md)
