# SellRight

Owned, from-scratch commerce backend replacing Vendure — sellable/open-source and self-hosted, dogfooded on Damned Designs + Rotten Hand. Part of the Right suite.

## Stack
TypeScript · Hono + zod-openapi (typed REST + OpenAPI) · Drizzle + Postgres · multi-tenant (`store` + RLS) · static catalog manifest read path · `PaymentProvider` interface (NMI/Sezzle/Stripe, tokenized; Stripe scaffolded) · Qwik storefront · React/Vite admin. (BullMQ/Redis and SSE are planned, not yet implemented.)

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
pnpm --filter @sellright/api dev   # http://localhost:3300/v1/openapi.json
pnpm typecheck
pnpm build
```

## Status
Active backend. Core API, 52-table multi-tenant schema/RLS, catalog import, checkout,
manual/COD payments, customer auth/account endpoints, transactional email (SMTP),
Stripe provider scaffolding, product/variant create + asset upload, and a 30-page
Shopify-style admin SPA are built. Remaining: storefront rewire (WP4b — Qwik
`providers/shop/*` still on Vendure GraphQL), production admin hosting, live Stripe
e2e (needs key), NMI/Sezzle providers, carrier fulfillment.

Current state: `docs/STATE-AND-ROADMAP-v1.md`.
Backend audit: `docs/fable/APP-AUDIT-2026-06-10.md` (WHY/decision record) · `.audit/audit-2026-06-13.json` (current findings at 43ebcbb).

Plans: `docs/ARCHITECTURE-PLAN-v1.md`, `docs/BUILD-PLAN-RH-v1.md`, `docs/DD-CUSTOMIZATION-SPEC-v1.md`.
