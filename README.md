# SellRight

Owned, from-scratch commerce backend for multi-brand operators. SellRight is a REST-first, Postgres-backed alternative to running separate Shopify/Vendure/WooCommerce-style backends per brand.

> **Pre-1.0:** SellRight is under active launch hardening. The public repository is suitable for evaluation and development; production operators should track release notes and required migrations closely until the first stable release.

## Stack

TypeScript · Hono + zod-openapi · REST/OpenAPI · Drizzle + Postgres · multi-tenant `store` model + RLS · static catalog manifest read path · `PaymentProvider` interface · Qwik storefront consumer · React/Vite admin.

## Layout
```text
packages/
  shared/      zod + integer-cents money primitives (money-core foundation)
  api/         Hono API, Drizzle schema, OpenAPI at /v1/openapi.json
  admin/       React admin SPA
  storefront/  Qwik SSR storefront
docs/          product docs
```

## Dev
```bash
pnpm install
pnpm --filter @sellright/api dev   # http://localhost:3300/v1/openapi.json
pnpm typecheck
pnpm build
```

## Env placement

Keep env files with the package that uses them:

- `packages/api/.env`
- `packages/storefront/.env`
- `packages/admin/.env`

Examples live beside each package as `.env.example`. The old root-level `.env.example` is retired.

## License

SellRight is source-available under the **Business Source License 1.1**. Production use is free for organizations with no more than **25 Covered Persons**, as defined in [LICENSE](LICENSE). Organizations above that threshold require a commercial license. Each version converts to Apache-2.0 on its Change Date.

BSL 1.1 is source-available rather than an OSI Open Source license before the Change Date.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Email Delivery](docs/EMAIL.md)
- [Features](docs/FEATURES.md)
- [Competitors](docs/COMPETITORS.md)
- [Market Placement](docs/MARKET-PLACEMENT.md)
- [Moat And Disruption](docs/MOAT-AND-DISRUPTION.md)
- [GTM](docs/GTM.md)
