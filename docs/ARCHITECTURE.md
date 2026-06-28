# SellRight Architecture

Last reviewed: 2026-06-13

SellRight is an owned, multi-tenant commerce backend. It is designed to replace one-backend-per-brand ecommerce stacks with one TypeScript service, one admin, one Postgres schema, and a documented REST contract.

## Core Shape

| Layer | Choice |
|---|---|
| API | Hono + `@hono/zod-openapi`; versioned REST under `/v1`; OpenAPI at `/v1/openapi.json` |
| Runtime | Node.js, TypeScript, pnpm workspace |
| Data | Postgres + Drizzle, integer cents for money |
| Tenancy | `store` root entity, store-scoped tables, Postgres RLS via `app.current_store` |
| Admin | React + Vite + Tailwind/shadcn-style components |
| Storefront | Qwik SSR consumer; static catalog manifest plus dynamic REST |
| Payments | `PaymentProvider` interface; Stripe provider scaffolded; NMI/Sezzle are planned for DD parity |
| Email | Nodemailer SMTP with optional per-app sender and storefront URL routing |
| Jobs | In-process scheduled jobs today; Redis/BullMQ is a later scaling option |

## Repository Layout

```text
packages/
  api/         Hono API, Drizzle schema, migrations, jobs, imports, OpenAPI
  admin/       React admin SPA
  shared/      shared money primitives and types
  storefront/  Qwik SSR storefront consumer
docs/          product documentation
```

## Request Model

Every store-scoped request resolves a store, then runs database work through `withStore(storeId, fn)`.

`withStore` opens a transaction and sets `app.current_store` with `SET LOCAL`. RLS policies use that session value to confine reads and writes to one store. Route code must not import the unscoped database client for store-scoped tenant queries; the unscoped export is named `unsafeUnscopedDb`. An ESLint `no-restricted-imports` rule in `packages/api/eslint.config.js` is written to block it from route files, but ESLint is not yet installed or wired into `pnpm verify`, so that rule is currently advisory rather than enforced. The legitimate unscoped callsites are: the admin identity/config routes (`admin-settings`, `admin-marketing`) for tables like `store`/`admin_user`/`admin_user_store`/`staff_invite`/`session` with explicit `storeId` filtering; and the Stripe webhook tenant-resolver (`payments/webhook-reconcile.ts`), which must look up the owning store from a PaymentIntent/subscription id *before* any store context exists (it returns only validated UUIDs, and subscription/invoice events that can't be resolved are retried, not silently scoped).

This gives SellRight two layers of tenant isolation:

1. Route-level store resolution.
2. Database-level RLS enforcement.

The verification gate includes `db:assert-rls` and `assert:shop-isolation` so new store-scoped tables and public shop routes cannot silently bypass the model.

## API Surface

SellRight is REST-first, not GraphQL-first.

Main route groups:

| Area | Examples |
|---|---|
| Health and contract | `/v1/health`, `/v1/openapi.json` |
| Catalog | products, collections, search, stock, static manifest generation |
| Cart and checkout | cart rows, server-priced checkout, shipping/tax/promo validation |
| Payments | payment intents, `/pay`, Stripe webhook receiver |
| Auth/account | register, login, Google auth, sessions, password reset, email verification, customer profile, addresses |
| Orders | customer orders, admin order operations, draft orders, refunds, returns |
| Admin | catalog, customers, staff, settings, reports, tax, locations, gift cards, webhooks, affiliates, blog, assets |
| App licensing | app license activation, update manifests, licensed downloads |

## Data Model

The schema is a full commerce schema rather than a thin catalog API. It includes:

- Store registry and admin-user-to-store membership.
- Catalog: products, variants, options, collections, assets, inventory, locations.
- Customers: identity, sessions, addresses, customer tokens.
- Orders: order snapshots, lines, payments, refunds, returns, fulfillments.
- Commerce rules: promotions, gift cards, shipping methods, tax zones, currency rates.
- Operator tools: blog posts, webhooks, affiliates, reports, staff invites, activity.
- Software sales: licenses, activations, app releases, download artifacts.

Most business tables are store-scoped. Shared registry tables that intentionally cross stores are documented and excluded from FORCE RLS only when needed.

## Money Path

The money path follows five rules:

1. Store money as integer cents.
2. Compute totals server-side.
3. Treat client prices, shipping, discounts, and tax as suggestions only.
4. Use idempotency keys around payment-sensitive operations.
5. Record state changes and side effects so retries do not double-charge, double-refund, or double-issue.

Current money modules cover totals, tax, discounts, gift cards, currency rates, order state, invoice generation, and stock reservation.

## Catalog Read Path

The preferred browse path is a static catalog manifest:

- `shop-catalog.json` for listing/search primitives.
- Per-product detail files for product pages.
- Dynamic REST remains available for account, checkout, live stock, and admin.

This keeps storefront browsing cheap and fast while preserving a transactional backend for money and account flows.

## Security Model

Built-in controls:

- Postgres RLS with FORCE assertions.
- Dedicated non-owner app role support.
- Admin and shop CSRF guards for cookie-backed mutation requests.
- Rate limiting for sensitive auth and checkout paths.
- Password reset and email verification token tables.
- TOTP replay guard.
- Webhook idempotency.
- Import TRUNCATE guard.
- No raw card handling in the intended payment architecture.

## Deployment Model

SellRight can run as one API process plus one static admin build. The current production-oriented deployment path uses:

- compiled API entrypoint from `packages/api/dist`;
- environment files outside git;
- PM2 or systemd-compatible scripts;
- nginx in front of API/admin;
- Postgres on the native service port for SellRight databases;
- backup scripts and restore drills as a launch gate.

Email is configured in `packages/api/.env`; see [Email Delivery](EMAIL.md) for
SMTP, Vendure Gmail aliases, and shared-store per-app sender routing.

## Verification Gate

After API changes, run:

```bash
pnpm verify
```
The gate builds all packages, type-checks, runs API tests, asserts FORCE RLS coverage, and checks shop-route isolation.
